/**
 * Shared plumbing for the Claude Code hooks wired in `.claude/settings.json`.
 *
 * Every hook is a small Node entry point (`pre-bash.mjs`, `post-edit.mjs`, …)
 * that reads the hook payload from stdin, decides, and prints the JSON the
 * harness expects. The decisions themselves live in pure `rules-*.mjs`
 * modules so they can be tested without a shell, a git checkout, or `gh`;
 * this file is the impure edge: process I/O, `git`, `gh`, the filesystem.
 *
 * Why Node and not bash + jq: `jq` is not installed on the maintainer's
 * machine and a jq pipeline fails SILENTLY there (empty fields, exit 0) —
 * see the memory note that produced this rule. Node is always present.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { spawnSyncShim } from "../lib/spawn-shim.mjs";
import { changedFiles, parseChangeSignature } from "./change-signature.mjs";
import { FULL_SHA, isSummaryComment, MAX_COMMENTS, MAX_EDITS } from "./coderabbit-summary.mjs";

// The deck-host link readers moved to `scripts/lib/plugin-links.mjs` in #1143,
// where `pnpm dev:voices` also needs them. Re-exported so every hook caller and
// test that imports them from here keeps working.
export { linkLocations, linkTargets, REAL_DIRECTORY } from "../lib/plugin-links.mjs";

export const SPEC_DIR = "docs/superpowers/specs/";
export const MAIN_BRANCH = "master";
export const BOARD = { number: 1, owner: "niklam", statusField: "Status" };

// ---------------------------------------------------------------------------
// Hook I/O

/** Reads the whole hook payload from stdin. Returns `{}` on malformed input. */
export async function readInput() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** PreToolUse: refuse the call. The reason is shown to the model. */
export function deny(reason) {
  emit({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
}

/** PreToolUse: force the permission prompt even for an allow-listed command. */
export function ask(reason) {
  emit({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
  });
}

/** PostToolUse: inject text into the model's context after the tool ran. */
export function postContext(text) {
  emit({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });
}

/** Applies a rule verdict: a string denies, `{ ask }` prompts, nothing passes. */
export function applyVerdict(verdict) {
  if (!verdict) return;
  if (typeof verdict === "string") deny(verdict);
  else if (verdict.ask) ask(verdict.ask);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Processes

/**
 * Runs a command synchronously and returns `{ ok, out, err, code }`.
 * `.exe` binaries (git, gh, node) are spawned directly, which keeps arguments
 * intact. Anything else is taken for a `.cmd` shim (pnpm, tsx, streamdeck) and
 * goes through `spawnSyncShim` (#1149), which gives it the shell Windows needs
 * without the args array Node deprecates beside one; `shim: false` spawns an
 * `.exe` outside that list (powershell) directly too. An argument the shim
 * refuses comes back as a failed run, never a throw. `maxBuffer` raises
 * `spawnSync`'s 1 MiB output cap for a caller that reads a whole diff (output
 * past the cap is a failed run, `ENOBUFS`); `encoding: "latin1"` reads bytes
 * one-to-one, for a caller that compares them; `env` adds variables.
 *
 * Every run is also clamped to the hook-wide deadline ({@link setHookDeadline}):
 * a PreToolUse hook that outlives its timeout does not block the tool call,
 * so a hook must answer — with a refusal if need be — before then. A run asked
 * for after the deadline fails without spawning.
 */
export function run(cmd, args, { cwd, timeoutMs = 60_000, shim, maxBuffer, encoding = "utf8", env } = {}) {
  const spawn = (shim ?? !/^(git|gh|node)$/.test(cmd)) ? spawnSyncShim : spawnSync;
  const budget = hookDeadline - Date.now();
  if (budget < 1_000) return { ok: false, out: "", err: "the hook's deadline is spent", code: null };
  let res;
  try {
    res = spawn(cmd, args, {
      cwd,
      encoding,
      timeout: Math.min(timeoutMs, budget),
      ...(maxBuffer ? { maxBuffer } : {}),
      windowsHide: true,
      // No prompt of any kind may hold a hook: `GIT_TERMINAL_PROMPT` stops git's
      // own, an empty `GIT_ASKPASS` an inherited askpass program, and
      // `GCM_INTERACTIVE` Git Credential Manager's sign-in window.
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GCM_INTERACTIVE: "never",
        ...env,
      },
    });
  } catch (error) {
    return { ok: false, out: "", err: String(error.message), code: null };
  }
  return {
    ok: res.status === 0 && !res.error,
    out: (res.stdout ?? "").toString(),
    err: (res.stderr ?? "").toString() + (res.error ? String(res.error.message) : ""),
    code: res.status,
  };
}

let hookDeadline = Infinity;

/**
 * Set the moment (epoch ms) after which no spawn starts and every running one
 * is cut short. `pre-bash.mjs` sets it a little inside the hook's 60 s timeout
 * (#1307), so the slowest path still ends in a verdict the harness reads.
 */
export function setHookDeadline(at) {
  hookDeadline = at;
}

/** Whether the hook-wide deadline has passed — used to name the cause of a failure. */
export const hookDeadlineSpent = () => hookDeadline - Date.now() < 1_000;

export const git = (args, cwd, opts) => run("git", args, { cwd, ...opts });
export const gh = (args, cwd, opts) => run("gh", args, { cwd, timeoutMs: 45_000, ...opts });

/** `gh … --format json` / `gh api …` parsed, or `undefined` on any failure. `opts` go to {@link run}. */
export function ghJson(args, cwd, opts) {
  const r = gh(args, cwd, opts);
  if (!r.ok) return undefined;
  try {
    return JSON.parse(r.out);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Git topology

/** Toplevel of the worktree containing `dir`, or `undefined` outside a repo. */
export function toplevel(dir) {
  const r = git(["rev-parse", "--show-toplevel"], dir);
  return r.ok ? path.resolve(r.out.trim()) : undefined;
}

/**
 * Every spec filename `origin/master` carries, or — when git cannot answer
 * (no such ref, no git) — every one in `root`'s working tree. Callers treat
 * `[]` as "no spec found", which is the side that ASKS rather than the side
 * that denies.
 *
 * The ref comes first because it is what a worktree is cut from, and what the
 * freshness check has just confirmed current. The working tree answers a
 * different question in both directions (#1193 review): a spec a cloud session
 * pushed to master is absent from a local checkout nobody has pulled, and a
 * spec written in the checkout but never committed has not reached master.
 */
export function specFilenames(root) {
  // `-r` so the listing does not hinge on SPEC_DIR's trailing slash: without
  // it, the same path spelled without one names only the directory entry.
  const r = git(["ls-tree", "-r", "--name-only", `origin/${MAIN_BRANCH}`, "--", SPEC_DIR], root);
  if (r.ok)
    return r.out
      .split(/\r?\n/)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.posix.basename(f));
  try {
    return readdirSync(path.join(root, SPEC_DIR)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/**
 * A repo-relative file's text, or `undefined` when it cannot be read — a file
 * staged by a `git add` that has since moved, a rename, a pathspec the hook
 * mis-parsed. Every caller fails OPEN on `undefined`: a spec must never be
 * blocked because the hook could not find the bytes it wanted to check.
 */
export function readRepoFile(root, rel) {
  try {
    return readFileSync(path.join(root, rel), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * A repo-relative file's STAGED text — the bytes a plain `git commit` takes —
 * or `undefined` when the index holds no such path. Callers fail open on
 * `undefined`, exactly as for `readRepoFile`.
 */
export function readIndexFile(dir, rel) {
  const r = git(["show", `:${rel}`], dir);
  return r.ok ? r.out : undefined;
}

/** The main repository checkout (the one whose `.git` is a directory). */
export function mainRepoRoot(dir) {
  const r = git(["rev-parse", "--git-common-dir"], dir);
  if (!r.ok) return undefined;
  return path.resolve(dir, r.out.trim(), "..");
}

export function currentBranch(dir) {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  return r.ok ? r.out.trim() : undefined;
}

/** `[{ path, head, branch }]` for every worktree of the repo containing `dir`. */
export function listWorktrees(dir) {
  const r = git(["worktree", "list", "--porcelain"], dir);
  if (!r.ok) return [];
  const out = [];
  let cur = null;
  for (const line of r.out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) cur = { path: path.resolve(line.slice(9)), head: "", branch: "(detached)" };
    else if (line.startsWith("HEAD ") && cur) cur.head = line.slice(5, 14);
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "" && cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Number of lines in `git status --porcelain`, or -1 when unreadable. */
export function dirtyCount(dir) {
  const r = git(["status", "--porcelain"], dir);
  return r.ok ? r.out.split(/\r?\n/).filter(Boolean).length : -1;
}

/** True when the local `origin/master` ref matches the remote's `master`. `undefined` when offline. */
export function originMasterFresh(dir) {
  const local = git(["rev-parse", `origin/${MAIN_BRANCH}`], dir);
  const remote = git(["ls-remote", "--heads", "origin", MAIN_BRANCH], dir, { timeoutMs: 8_000 });
  if (!local.ok || !remote.ok) return undefined;
  const remoteSha = remote.out.trim().split(/\s+/)[0];
  if (!remoteSha) return undefined;
  return { fresh: remoteSha === local.out.trim(), local: local.out.trim().slice(0, 9), remote: remoteSha.slice(0, 9) };
}

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
  const env = { GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: os.devNull };
  const root = git(["rev-parse", "--show-toplevel"], dir, { env });
  if (!root.ok) return fail("git could not find the repository");
  const top = path.resolve(root.out.trim());
  const g = (args, opts = {}) => git(args, top, { timeoutMs: 15_000, ...opts, env });
  const present = (s) => g(["cat-file", "-e", `${s}^{commit}`]).ok;
  const missing = shas.filter((s) => !present(s));
  if (missing.length) {
    g(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "origin",
        ...new Set(missing),
      ],
      {
        timeoutMs: 20_000,
      },
    );
    if (!missing.every(present)) return fail("git could not fetch every commit it needs from origin");
  }
  const mergeBase = (s) => {
    const r = g(["merge-base", "--all", s, base]);
    if (!r.ok) return { error: "git could not find a merge-base with the PR's base" };
    const all = r.out.split("\n").filter(Boolean);
    return all.length === 1 ? { sha: all[0] } : { error: "the history is criss-crossed (more than one merge-base)" };
  };
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
 * Whether the PR's base moved under it after `sinceIso` (#1307): a retarget
 * (`BaseRefChangedEvent`) or a force-push of the base branch
 * (`BaseRefForcePushedEvent`) in its timeline. Either makes commits that were
 * base-side at review time look like part of the reviewed change.
 * `undefined` when gh cannot answer, which the merge gate treats as yes.
 */
export function baseChangedSince(number, sinceIso, dir) {
  const query =
    "query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT,BASE_REF_FORCE_PUSHED_EVENT],last:50){nodes{... on BaseRefChangedEvent{createdAt} ... on BaseRefForcePushedEvent{createdAt}}}}}}";
  const nodes = ghGraphql(query, { n: number }, dir)?.repository?.pullRequest?.timelineItems?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  return nodes.some((x) => typeof x?.createdAt === "string" && x.createdAt > (sinceIso ?? ""));
}

/**
 * The arguments of one `gh api graphql` call: the query, then `owner` and
 * `repo` as gh's `{owner}` / `{repo}` placeholders for the repository of
 * `dir`, then `variables`. A number goes as `-F`, typed; any other value as
 * `-f`, a raw string, so a value that starts with `@` is never read as a file.
 * A query that has no use for `owner` and `repo` must not declare them:
 * GitHub ignores a variable passed but not declared, and refuses one declared
 * but not used (measured 2026-10-10).
 * @internal Exported for testing
 */
export function graphqlArgs(query, variables = {}) {
  const fields = Object.entries(variables).flatMap(([k, v]) =>
    typeof v === "number" ? ["-F", `${k}=${v}`] : ["-f", `${k}=${v}`],
  );
  return ["api", "graphql", "-f", `query=${query}`, "-F", "owner={owner}", "-F", "repo={repo}", ...fields];
}

/**
 * One `gh api graphql` call ({@link graphqlArgs}), unwrapped to its `data`.
 * `undefined` when gh fails or the answer carries `errors`, since a partial
 * answer must not be read as a whole one. `opts` go to {@link run}.
 */
export function ghGraphql(query, variables, dir, opts) {
  const r = ghJson(graphqlArgs(query, variables), dir, opts);
  if (!r || r.errors) return undefined;
  return r.data ?? undefined;
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
 * read must fail rather than parse.
 */
export function prComments(number, dir) {
  const big = { maxBuffer: 64 * 1024 * 1024 };
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

/** Is `candidate` inside `parent` (both absolute)? Case-insensitive on Windows. */
export function isInside(candidate, parent) {
  const norm = (p) => {
    let s = path.resolve(p).replace(/[\\/]+$/, "");
    if (process.platform === "win32") s = s.toLowerCase();
    return s;
  };
  const c = norm(candidate);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep);
}

// ---------------------------------------------------------------------------
// Workspace packages

/** `{ name → { dir, scripts } }` for every package under packages/ plus the root. */
export function workspacePackages(root) {
  const out = {};
  const add = (dir) => {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg.name) out[pkg.name] = { dir, scripts: Object.keys(pkg.scripts ?? {}) };
    } catch {
      /* not a package */
    }
  };
  add(root);
  const pkgs = path.join(root, "packages");
  if (existsSync(pkgs)) for (const d of readdirSync(pkgs)) add(path.join(pkgs, d));
  return out;
}

// ---------------------------------------------------------------------------
// Roadmap board (GitHub Projects v2)

/** The board's node id plus its Status field and option ids, read fresh — never hardcoded (the ids regenerate if the option list is ever rewritten). */
export function boardStatusField(cwd) {
  const project = ghJson(["project", "view", String(BOARD.number), "--owner", BOARD.owner, "--format", "json"], cwd);
  const fields = ghJson(
    ["project", "field-list", String(BOARD.number), "--owner", BOARD.owner, "--format", "json"],
    cwd,
  );
  const status = fields?.fields?.find((f) => f.name === BOARD.statusField);
  if (!project?.id || !status?.id) return undefined;
  const options = Object.fromEntries((status.options ?? []).map((o) => [o.name, o.id]));
  return { projectId: project.id, fieldId: status.id, options };
}

/** The board item for an issue: `{ itemId, status }`, or `undefined` when the issue is not on the board. */
export function boardItemForIssue(issueNumber, cwd) {
  const query =
    'query($n:Int!){repository(owner:"' +
    BOARD.owner +
    '",name:"iracedeck"){issue(number:$n){projectItems(first:10){nodes{id project{number} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}';
  const data = ghJson(["api", "graphql", "-f", `query=${query}`, "-F", `n=${issueNumber}`], cwd);
  const node = data?.data?.repository?.issue?.projectItems?.nodes?.find((n) => n.project?.number === BOARD.number);
  if (!node) return undefined;
  return { itemId: node.id, status: node.fieldValueByName?.name ?? "(none)" };
}

/** Lanes a card may be moved FROM for each automated move — never backwards (a Done card stays Done). */
export const BOARD_MOVES = {
  Backlog: ["(none)"],
  "In progress": ["(none)", "Backlog", "Planned", "Next"],
  Testing: ["(none)", "Backlog", "Planned", "Next", "In progress"],
};

/** Set `IRACEDECK_HOOKS_DRY_RUN=1` to have every board mutation report instead of run (tests, pipe-checks). */
export const dryRun = () => !!process.env.IRACEDECK_HOOKS_DRY_RUN;

/**
 * Moves one board item into a lane, only from the lanes `BOARD_MOVES` allows.
 * Returns a human-readable line either way.
 */
export function setBoardStatus(issueNumber, lane, cwd) {
  const allowedFrom = BOARD_MOVES[lane];
  if (!allowedFrom)
    return `board: "${lane}" is not a lane the hooks move cards into (${Object.keys(BOARD_MOVES).join(", ")})`;
  const item = boardItemForIssue(issueNumber, cwd);
  if (!item) return `board: #${issueNumber} is not on the Roadmap board`;
  if (item.status === lane) return `board: #${issueNumber} already in ${lane}`;
  if (!allowedFrom.includes(item.status))
    return `board: #${issueNumber} is in ${item.status}; not moving it to ${lane} (only from ${allowedFrom.join("/")})`;
  if (dryRun()) return `board (dry run): would move #${issueNumber} ${item.status} → ${lane}`;
  const field = boardStatusField(cwd);
  if (!field)
    return `board: could not read the Status field (missing \`project\` token scope? \`gh auth refresh -s project,read:project\`)`;
  const optionId = field.options[lane];
  if (!optionId) return `board: no lane named "${lane}" (have: ${Object.keys(field.options).join(", ")})`;
  const r = gh(
    [
      "project",
      "item-edit",
      "--project-id",
      field.projectId,
      "--id",
      item.itemId,
      "--field-id",
      field.fieldId,
      "--single-select-option-id",
      optionId,
    ],
    cwd,
  );
  return r.ok
    ? `board: #${issueNumber} moved ${item.status} → ${lane}`
    : `board: moving #${issueNumber} to ${lane} failed: ${r.err.trim()}`;
}

/** Adds an issue URL to the board and returns its item id, or `undefined`. */
export function addToBoard(issueUrl, cwd) {
  if (dryRun()) return "dry-run-item";
  const r = ghJson(
    ["project", "item-add", String(BOARD.number), "--owner", BOARD.owner, "--url", issueUrl, "--format", "json"],
    cwd,
  );
  return r?.id;
}
