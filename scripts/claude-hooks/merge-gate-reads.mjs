/**
 * The merge gate's git and gh reads (#1307, #1386, #1648), split out of
 * `lib.mjs` in #1659: the pure-rebase replay and the PR's changed files, read
 * with git at the repository root with replace refs and grafts ignored, and
 * the base branch's required checks, base moves and comments, read with gh.
 * The impure edge of `merge-gate.mjs`, which reaches them only through the
 * context `pre-bash.mjs` builds, so the gate's own tests stay pure. Built on
 * `lib.mjs`'s runners, which also clamp every spawn to the hook's deadline.
 */
import os from "node:os";
import path from "node:path";

import { changedFiles, parseChangeSignature } from "./change-signature.mjs";
import { FULL_SHA, isSummaryComment, MAX_COMMENTS, MAX_EDITS } from "./coderabbit-summary.mjs";
import { ghGraphql, ghJson, git, hookDeadlineSpent } from "./lib.mjs";
import { hasConfigFrontmatter, isNoReviewPath } from "./no-review-paths.mjs";

/**
 * Replays the reviewed commit's change onto the head's base and compares the
 * result with the head (#1307): the merge gate's test for "the newest push is
 * a pure rebase of what CodeRabbit reviewed". `reviewed`, `head` and `base`
 * are full shas — `base` the PR's own `baseRefOid`, never a local ref name,
 * which can be stale (failing OPEN) or shadowed by a branch or tag.
 *
 * Returns `{ ok: false, reason }`, `{ ok: true, followUp }` for a follow-up
 * push (non-merge commits after the reviewed one that the base does not
 * have), or `{ ok: true, differing, conflicted, lineMismatch }`: the paths
 * where the replayed tree differs from the head's tree, EVERY path the replay
 * reported as conflicted (a conflict can leave a marker-free blob that matches
 * the head, and still be a resolution nobody reviewed), and those conflicted
 * paths whose added and removed lines differ from the reviewed change's.
 *
 * What it rests on, each a hole a review reproduced:
 * - Trees compare by object id, so diff config, textconv and encoding play no
 *   part; the conflicted-file line check reads plumbing, byte-exact.
 * - The replay runs with `-X no-renames`, like every diff here: a rename is a
 *   delete plus an add, so a base change to the rename source is compared
 *   rather than carried silently into the target.
 * - Criss-cross history (more than one merge-base) is refused: `merge-base`
 *   picks one where GitHub's squash merges against a virtual base.
 * - `GIT_NO_REPLACE_OBJECTS` and an empty graft file, so local repository
 *   state cannot change what a sha means; `--ignore-submodules=none`, so a
 *   `.gitmodules` `ignore` cannot hide a gitlink.
 * - Every call runs at the repository's top level with literal top-level
 *   pathspecs, whatever directory the session is in.
 *
 * Missing commits are fetched from `origin` by sha in one call, without
 * automatic maintenance. The fetch and the replay write objects to the
 * shared store, never a ref or `FETCH_HEAD`.
 */
export function replayRebase({ reviewed, head, base, dir }) {
  const shas = [reviewed, head, base];
  if (!shas.every((s) => typeof s === "string" && FULL_SHA.test(s)))
    return { ok: false, reason: "a reviewed, head or base sha is missing" };
  const fail = (reason) => ({ ok: false, reason: hookDeadlineSpent() ? "the hook ran out of time" : reason });
  const g = pinnedGit(dir);
  if (!g) return fail("git could not find the repository");
  if (!fetchMissingCommits(g, shas)) return fail("git could not fetch every commit it needs from origin");
  const mergeBase = (s) => soleMergeBase(g, s, base);
  const mbReviewed = mergeBase(reviewed);
  const mbHead = mergeBase(head);
  if (!mbReviewed.sha || !mbHead.sha) return fail(mbReviewed.error ?? mbHead.error);
  // A follow-up push, not a rebase: commits after the reviewed one that the
  // base does not carry. `^base` keeps an "Update branch" merge of the base —
  // a rebase by other means — out of the count; the replay covers it.
  const ancestor = g(["merge-base", "--is-ancestor", reviewed, head]);
  if (ancestor.code !== 0 && ancestor.code !== 1)
    return fail("git could not tell whether the reviewed commit is in the head's history");
  if (ancestor.code === 0) {
    const count = g(["rev-list", "--no-merges", "--count", `${reviewed}..${head}`, `^${base}`]);
    if (!count.ok) return fail("git could not count the commits after the reviewed one");
    const followUp = Number(count.out.trim());
    if (followUp > 0) return { ok: true, followUp };
  }
  const merged = g([
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    "-z",
    "-X",
    "no-renames",
    `--merge-base=${mbReviewed.sha}`,
    mbHead.sha,
    reviewed,
  ]);
  if (merged.code !== 0 && merged.code !== 1) return fail("git merge-tree could not replay the reviewed change");
  // `-z`: the tree id, then each conflicted path, NUL-separated and unquoted.
  const [tree, ...conflictedList] = merged.out.split("\0").filter(Boolean);
  const conflicted = merged.code === 1 ? [...new Set(conflictedList)].sort() : [];
  const diff = g(
    ["diff-tree", "-r", "--no-renames", "--ignore-submodules=none", "--name-only", "-z", tree, `${head}^{tree}`],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (!diff.ok) return fail("git could not compare the replayed tree with the head's");
  const differing = diff.out.split("\0").filter(Boolean).sort();
  if (conflicted.length === 0) return { ok: true, differing, conflicted, lineMismatch: [] };
  if (conflicted.length > MAX_CONFLICTED_LINE_CHECKS)
    return fail(`the rebase conflicted in ${conflicted.length} files, more than the line check reads`);
  // One path per diff, so no header ever has to be matched back to a path.
  const signature = (from, to, file) => {
    const r = g(
      [
        "diff-tree",
        "-p",
        "--no-renames",
        "--ignore-submodules=none",
        "--full-index",
        "--unified=0",
        from,
        to,
        "--",
        `:(top,literal)${file}`,
      ],
      { maxBuffer: 64 * 1024 * 1024, encoding: "latin1" },
    );
    return r.ok ? parseChangeSignature(r.out) : null;
  };
  const lineMismatch = [];
  for (const file of conflicted) {
    const before = signature(mbReviewed.sha, reviewed, file);
    const after = before && signature(mbHead.sha, head, file);
    if (!before || !after) return fail("git could not read the conflicted files' changes");
    // An empty signature is a side that does not touch the path; never read that as a match.
    if (before.size === 0 || after.size === 0 || changedFiles(before, after).length) lineMismatch.push(file);
  }
  return { ok: true, differing, conflicted, lineMismatch };
}

/** Conflicted files the replay line-checks; past this the gate refuses rather than spend the hook's deadline. */
export const MAX_CONFLICTED_LINE_CHECKS = 20;

/**
 * A `git` runner at the top level of `dir`'s repository with replace refs and
 * grafts ignored, so local repository state cannot change what a sha means,
 * or `undefined` when git finds no repository there. The merge gate's git
 * reads (`replayRebase`, `prChangedFiles`) all go through one.
 */
function pinnedGit(dir) {
  const env = { GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: os.devNull };
  const root = git(["rev-parse", "--show-toplevel"], dir, { env });
  if (!root.ok) return undefined;
  const top = path.resolve(root.out.trim());
  return (args, opts = {}) => git(args, top, { timeoutMs: 15_000, ...opts, env });
}

/**
 * Whether every one of `shas` (full commit ids) is in the store once those
 * missing are fetched from `origin` by sha, in one call, without tags,
 * `FETCH_HEAD` or automatic maintenance: it writes objects, never a ref.
 */
function fetchMissingCommits(g, shas) {
  const present = (s) => g(["cat-file", "-e", `${s}^{commit}`]).ok;
  const missing = [...new Set(shas.filter((s) => !present(s)))];
  if (missing.length === 0) return true;
  g(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "origin", ...missing], {
    timeoutMs: 20_000,
  });
  return missing.every(present);
}

/**
 * `{ sha }`, the one merge-base of `a` and `base`, or `{ error }`: git could
 * not find one, or found several (criss-cross history), where `git merge-base`
 * would pick one and GitHub merges against a virtual base.
 */
function soleMergeBase(g, a, base) {
  const r = g(["merge-base", "--all", a, base]);
  if (!r.ok) return { error: "git could not find a merge-base with the PR's base" };
  const all = r.out.split("\n").filter(Boolean);
  return all.length === 1 ? { sha: all[0] } : { error: "the history is criss-crossed (more than one merge-base)" };
}

/**
 * Every path a PR changes and who made its commits, read with git (#1648):
 * `{ ok: true, files, commits, blobs }` or `{ ok: false, reason }`. `files`
 * are the repo-relative paths that differ between the merge-base of `head`
 * and `base` and `head` — the PR's own diff, as GitHub shows it; `commits`
 * holds each commit's `{ author, committer }` on that range, each
 * `Name <email>`, merges included, one entry per commit; `blobs` maps every
 * file on the prose list whose frontmatter is configuration (a skill's or an
 * agent's, `hasConfigFrontmatter`) to its `{ base, head }` text, read as
 * latin1 so a comparison is byte for byte, `null` on the side an added or
 * deleted file lacks. `head` and `base` are the PR's `headRefOid` and
 * `baseRefOid`, full shas. The merge gate lets an `--admin` merge through
 * unasked only when every path is Claude-facing prose (`no-review-paths.mjs`)
 * or every commit is Dependabot's, so every uncertain read is a failure,
 * never a shorter list:
 *
 * - `--no-renames`, so a rename lists both sides, and a script moved into
 *   `.claude/rules/` shows the deleted script; `-r` and
 *   `--ignore-submodules=none`, so neither a directory nor a gitlink hides a
 *   path; `-z`, so a path comes back as it is, never quoted.
 * - Plumbing (`diff-tree`, `rev-list`), which no diff, mailmap or signature
 *   configuration changes; `%an` / `%ae` and `%cn` / `%ce` are the raw author
 *   and committer lines. Replace refs and grafts ignored, at the repository's
 *   top level (`pinnedGit`).
 * - A commit the checkout lacks is fetched from `origin` by sha, as
 *   `replayRebase` does; criss-cross history, a failed diff, commit list or
 *   blob read, and an empty list all fail.
 */
export function prChangedFiles({ head, base, dir }) {
  if (![head, base].every((s) => typeof s === "string" && FULL_SHA.test(s)))
    return { ok: false, reason: "the PR's head or base sha is missing" };
  const fail = (reason) => ({ ok: false, reason: hookDeadlineSpent() ? "the hook ran out of time" : reason });
  const g = pinnedGit(dir);
  if (!g) return fail("git could not find the repository");
  if (!fetchMissingCommits(g, [head, base])) return fail("git could not fetch the PR's head and base from origin");
  const mb = soleMergeBase(g, head, base);
  if (!mb.sha) return fail(mb.error);
  const diff = g(["diff-tree", "-r", "--no-renames", "--ignore-submodules=none", "--name-status", "-z", mb.sha, head], {
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!diff.ok) return fail("git could not list the files the PR changes");
  // `-z --name-status`: a status letter, then its path, each NUL-terminated.
  const fields = diff.out.split("\0");
  const status = new Map();
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i + 1]) status.set(fields[i + 1], fields[i]);
  const files = [...status.keys()].sort();
  if (files.length === 0) return fail("git lists no file the PR changes");
  // A name or an email never holds a NUL or a line break, so neither split can cut one.
  const log = g(["rev-list", "--no-commit-header", "--format=%an%x00%ae%x00%cn%x00%ce", `${mb.sha}..${head}`], {
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!log.ok) return fail("git could not list the PR's commits");
  const commits = log.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [an, ae, cn, ce] = line.split("\0");
      return { author: `${an} <${ae ?? ""}>`, committer: `${cn ?? ""} <${ce ?? ""}>` };
    });
  if (commits.length === 0) return fail("git lists no commit on the PR");
  // Both sides of every prose file whose frontmatter is configuration, byte for
  // byte; `null` for the side an added or deleted file lacks.
  const blobs = {};
  for (const file of files.filter((f) => isNoReviewPath(f) && hasConfigFrontmatter(f))) {
    const side = (sha, absent) => {
      if (absent) return null;
      const r = g(["cat-file", "blob", `${sha}:${file}`], { maxBuffer: 16 * 1024 * 1024, encoding: "latin1" });
      return r.ok ? r.out : undefined;
    };
    const s = status.get(file);
    const pair = { base: side(mb.sha, s === "A"), head: side(head, s === "D") };
    if (pair.base === undefined || pair.head === undefined) return fail(`git could not read ${file} on both sides`);
    blobs[file] = pair;
  }
  return { ok: true, files, commits, blobs };
}

/**
 * The status checks a branch's rules require (#1648), read from the rules
 * API (`repos/<repo>/rules/branches/<branch>`, every ruleset that applies,
 * whatever its source): `{ ok: true, contexts }`, the required contexts
 * by name, or `{ ok: false, reason }`. `repo` is the `owner/name` the merge
 * gate confirmed; `opts` go to {@link run} (the gate passes it as `GH_REPO`
 * too, as for its other reads). A rule set it cannot read whole is a failure;
 * one requiring no check is `contexts: []`, which the gate accepts only for
 * a PR that is not BLOCKED (`adminVerdict` in `rules-bash.mjs`).
 */
export function requiredStatusChecks(repo, branch, dir, opts) {
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    return { ok: false, reason: "the PR's repository is unreadable" };
  if (typeof branch !== "string" || branch === "") return { ok: false, reason: "the PR's base branch is unknown" };
  const at = branch.split("/").map(encodeURIComponent).join("/");
  const rules = ghJson(["api", `repos/${repo}/rules/branches/${at}?per_page=100`], dir, opts);
  if (!Array.isArray(rules)) return { ok: false, reason: `gh could not read the rules of ${branch}` };
  if (rules.length >= 100) return { ok: false, reason: `${branch} has more rules than one page holds` };
  const contexts = [
    ...new Set(
      rules
        .filter((r) => r?.type === "required_status_checks")
        .flatMap((r) => r.parameters?.required_status_checks ?? [])
        .map((c) => c?.context)
        .filter((c) => typeof c === "string" && c !== ""),
    ),
  ].sort();
  return { ok: true, contexts };
}

/**
 * Whether the PR's base moved under it after `sinceIso` (#1307): a retarget
 * (`BaseRefChangedEvent`) or a force-push of the base branch
 * (`BaseRefForcePushedEvent`) in its timeline. Either makes commits that were
 * base-side at review time look like part of the reviewed change.
 * `undefined` when gh cannot answer, which the merge gate treats as yes.
 * `opts` go to {@link run}: the gate passes the PR's repository as `GH_REPO`,
 * so `{owner}` / `{repo}` are never another checkout's (#1393).
 */
export function baseChangedSince(number, sinceIso, dir, opts) {
  const query =
    "query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT,BASE_REF_FORCE_PUSHED_EVENT],last:50){nodes{... on BaseRefChangedEvent{createdAt} ... on BaseRefForcePushedEvent{createdAt}}}}}}";
  const nodes = ghGraphql(query, { n: number }, dir, opts)?.repository?.pullRequest?.timelineItems?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  return nodes.some((x) => typeof x?.createdAt === "string" && x.createdAt > (sinceIso ?? ""));
}

/**
 * The PR's comments as the merge gate's summary rule reads them (#1386): the
 * `comments` connection with its `totalCount` and `pageInfo`, and per
 * comment its id, author and editor (login and type), whether it is
 * minimized, when its body was written, and the body. One page of
 * {@link MAX_COMMENTS}; `readSummary` refuses a PR with more rather than read
 * it partially. When exactly one comment is a summary, a second read attaches
 * its edit history as `userContentEdits` — every edit's editor, time,
 * deletion and the whole body it left, one page of {@link MAX_EDITS} — which
 * `readSummary` needs to prove every edit was CodeRabbit's and to walk the
 * earlier versions. It is read for that one comment only, since a hundred
 * comments' histories with bodies could be very large. `undefined` when gh
 * cannot answer, which the gate treats as no summary; a failed history read
 * leaves the history off, which `readSummary` refuses. The buffer is raised
 * because a hundred bodies can pass spawnSync's 1 MiB default, and a cut-off
 * read must fail rather than parse. `opts` go to {@link run}, as for
 * {@link baseChangedSince}.
 */
export function prComments(number, dir, opts) {
  const big = { ...opts, maxBuffer: 64 * 1024 * 1024 };
  const query = `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){comments(first:${MAX_COMMENTS}){totalCount pageInfo{hasNextPage} nodes{id author{login __typename} editor{login __typename} isMinimized createdAt lastEditedAt body}}}}}`;
  const comments = ghGraphql(query, { n: number }, dir, big)?.repository?.pullRequest?.comments;
  if (!comments) return undefined;
  const summaries = Array.isArray(comments.nodes) ? comments.nodes.filter(isSummaryComment) : [];
  if (summaries.length !== 1 || typeof summaries[0].id !== "string") return comments;
  const history = `query($id:ID!){node(id:$id){... on IssueComment{userContentEdits(last:${MAX_EDITS}){totalCount nodes{editedAt editor{login __typename} deletedAt diff}}}}}`;
  const edits = ghGraphql(history, { id: summaries[0].id }, dir, big)?.node?.userContentEdits;
  if (edits) summaries[0].userContentEdits = edits;
  return comments;
}
