/**
 * The merge gate (#1307, #1386, #1393, #1634, #1648), split out of
 * `rules-bash.mjs` in #1659: the verdict on a `gh pr merge`, the gate's own
 * reading of the merge command, and the CodeRabbit, Dependabot and status-check
 * judgements it rests on. Pure, like the rules: every git and gh read reaches
 * it through the context (`merge-gate-reads.mjs` and `lib.mjs` supply them in
 * `pre-bash.mjs`), so its tests hand in a fake one. `rules-bash.mjs` keeps the
 * rule's entry, in its place in the rule order, and delegates to
 * {@link mergeGateVerdict}; `post-bash.mjs` reads its trigger, {@link firstMerge}.
 */
import { FULL_SHA, rangeChain, readSummary } from "./coderabbit-summary.mjs";
import { frontmatterChanged, hasConfigFrontmatter, isNoReviewPath, NO_REVIEW_PATHS } from "./no-review-paths.mjs";
import { assignedGhRepo, HOME_REPO, isHomeRepo, mergeRepo, repoOfUrl } from "./rules-post.mjs";
import {
  cdsAhead,
  CHAIN_AND_BACKGROUND,
  cmd,
  COMMAND_LEAD,
  has,
  literal,
  matchesAt,
  plainValue,
  programStart,
  ranges,
  segmentTokens,
  stringEnd,
  trustedIn,
  trustedMask,
  view,
} from "./shell-lexer.mjs";

/** CodeRabbit's login as `gh` reports it — exact, so a look-alike account cannot stand in for it. */
const CODERABBIT = /^coderabbitai(\[bot\])?$/i;

/**
 * The CodeRabbit reviews that say what it SAW. GitHub files a thread reply as
 * a COMMENTED review with an empty body, at whatever commit the PR head was
 * when the reply landed — counting one would mark an unreviewed commit as
 * reviewed (#1307 review, PR #1300's reply review 5395629514).
 */
export const coderabbitReviews = (reviews) =>
  (reviews ?? []).filter(
    (r) => CODERABBIT.test(r.author?.login ?? "") && !(r.state === "COMMENTED" && !(r.body ?? "").trim()),
  );

/** A `gh pr merge` in the masked text: where the gate reads the repository and directory from. */
export const GH_PR_MERGE = /\bgh\s+pr\s+merge\b/;
/**
 * What runs a command beside the merge rather than before or after it: a pipe
 * (`|`, `|&`, not `||`), or a lone `&` that backgrounds one (not `&&`, nor a
 * redirect's `>&`, `<&` or `&>`).
 */
const CONCURRENT = /(?<!\|)\|(?!\|)|(?<![<>&|])&(?![>&])/;
/** The wrappers a merge's own prefix may carry, without options of their own. */
const MERGE_PREFIX_WORDS = new Set(["!", "command", "env", "exec", "nohup", "time"]);

/**
 * Whether a merge's own prefix — the text between its segment's start and
 * `gh` — is one the gate can read whole (#1393): the wrappers above, `timeout`
 * with a plain duration, and assignments of anything but gh's and git's own
 * variables, `GH_REPO` aside, which the gate reads. An option to a wrapper
 * (`env -C<dir>`, `env -i`, `env -u GH_REPO`) or a `GIT_DIR` can move what gh
 * resolves the merge to, so anything else is refused. Names are compared in
 * any case: Windows hands gh its environment case-blind. A redirection
 * (`2>/dev/null`, `</dev/null`, #1606 review) moves nothing gh reads, so it is
 * read too, unless its target runs a command (`>(…)`, a backtick).
 */
function plainMergePrefix(prefix) {
  const words = prefix
    .replace(/^[\s($]*/, "")
    .split(/\s+/)
    .filter(Boolean);
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (MERGE_PREFIX_WORDS.has(w)) continue;
    if (w === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/.test(words[k + 1] ?? "")) {
      k++;
      continue;
    }
    const name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(w)?.[1];
    if (name && (name === "GH_REPO" || !/^(?:GH|GIT)_/i.test(name))) continue;
    const redirect = REDIRECT_WORD.exec(w);
    if (redirect) {
      const target = redirect[1] || words[++k];
      if (target !== undefined && !/[()\x60]/.test(target)) continue;
    }
    return false;
  }
  return true;
}

/** A redirection word: an optional fd and one operator, the target attached in group 1 or in the next word. */
const REDIRECT_WORD = /^\d*(?:<<<|[<>]&|&>>?|>>|>\||<>|<|>)(.*)$/;

/** `gh pr merge` flags that take a value, so the value is never read as the PR or as a flag. */
const MERGE_VALUE_FLAGS = new Set([
  "--match-head-commit",
  "--body",
  "-b",
  "--body-file",
  "-F",
  "--subject",
  "-t",
  "--author-email",
  "-A",
  "--repo",
  "-R",
]);

/**
 * The segments of a chained command that are a `gh pr merge`, split at `&&`,
 * `||`, `;`, `|`, `&` and newline in the trusted-masked text: each a
 * `{ raw, flat, trusted }` slice for {@link parseMerge}, `trusted` when the
 * mask stands over that slice (`trustedIn` in `shell-lexer.mjs`, #1607).
 */
export function mergeSegments(command) {
  const lead = new RegExp(String.raw`^[\s($]*${COMMAND_LEAD}gh\s+pr\s+merge\b`);
  const { text, flat } = view(command);
  return ranges(text, CHAIN_AND_BACKGROUND)
    .filter(([a, b]) => lead.test(text.slice(a, b)))
    .map(([a, b]) => ({ raw: command.slice(a, b), flat: flat.slice(a, b), trusted: trustedIn(command, a, b) }));
}

/** A `gh pr merge` at command position, or carried there by a shell or a wrapper ({@link firstMerge}, the merge gate). */
const MERGE_AT = cmd(/gh\s+pr\s+merge\b/);

/**
 * The first `gh pr merge` the command runs, parsed ({@link parseMerge}) and
 * with `index`, where its program word starts; `undefined` when there is
 * none. The post-hook's trigger, which reads the one notion of command
 * position every pre-hook guard reads (`matchesAt` in `shell-lexer.mjs`,
 * #1607, #1634): a `gh pr merge` counts only where `gh` is the program, in
 * masked and raw text alike — after a command boundary and a {@link
 * COMMAND_LEAD} (`timeout 5 gh …`, `GH_REPO=x gh …`, `bash -c 'ls; gh …'`),
 * as the program a `sudo`, `nice`, `stdbuf` or `winpty` runs or after `find
 * -exec`, or as the first word a fed shell runs (`bash -c 'gh pr merge 5'`,
 * `echo 'gh pr merge 5' | bash`). A mention as an argument is none: `echo gh
 * pr merge 1603`, a `git log -- gh pr merge 1603`, or a grep for it beside a
 * `bash $SCRIPT`, which used to move #1603's card.
 */
export function firstMerge(command) {
  const { text, flat } = view(command);
  for (const m of matchesAt(command, MERGE_AT)) {
    // From the start of the program word, so its raw text is read whole (#1606).
    const start = programStart(command, m.program);
    const rest = text.slice(start).search(CHAIN_AND_BACKGROUND);
    let end = rest < 0 ? text.length : start + rest;
    // A merge inside a string a shell runs ends at that string's close (#1634).
    const close = stringEnd(command, start);
    if (close !== undefined && close < end) end = close;
    // Through the mask only where it stands over the merge's own text (#1607).
    const merge = parseMerge({
      raw: command.slice(start, end),
      flat: flat.slice(start, end),
      trusted: trustedIn(command, start, end),
    });
    return { ...merge, index: start };
  }
  return undefined;
}

/**
 * The deny for a `gh pr merge` that is not its own command (#1634): the first
 * word of a string a shell runs (`bash -c 'gh pr merge 7'`, `pwsh -Command
 * "…"`), or the program a wrapper runs (`sudo gh pr merge 7`, `nice gh …`),
 * or a later command of such a string (`bash -c 'ls; gh pr merge 7'`, #1646);
 * `eval`, a printer piped into a shell and a here-string are refused before
 * the gate (#1659). Until #1634 no trap saw either,
 * so such a merge passed the gate unread; the gate reads the PR before the command runs and
 * cannot follow what a shell or a wrapper does to the repository, the
 * checkout or the environment in between, so it refuses rather than judge
 * the merge as if typed directly. `m` is the `matchesAt` result.
 */
const carriedMerge = (m) =>
  m.how === "command"
    ? `This \`gh pr merge\` is not its own command: it is a command of a string \`${m.shell}\` runs, and the gate cannot read what that shell does around it — where it runs, what reaches it, what else it runs. Type the merge directly, as its own command: \`gh pr merge <pr> --squash\` (#1634, #1646).`
    : m.how === "shell"
      ? `This \`gh pr merge\` is not its own command: it is the first word of a string \`${m.via}\` runs, and the gate cannot read what that shell does around it — where it runs, what reaches it, what else it runs. Type the merge directly, as its own command: \`gh pr merge <pr> --squash\` (#1634).`
      : `This \`gh pr merge\` is not its own command: it runs under \`${m.via}\`, which can change what gh resolves the PR and the repository to after the gate has read them. Type the merge directly, as its own command, with nothing ahead of it but a plain \`cd <dir> &&\` (#1634).`;

/**
 * Every `gh pr merge` in the RAW text — the backstop for a separator the split
 * does not know, and for a merge the mask hid. It counts raw text so that it
 * shares no blind spot with the mask it backs up (#1321 review), and it is
 * reached only once a merge at command position has matched, so a command that
 * merely mentions one never pays for it. The raw count takes the spellings of
 * the program a bare regex can see (`gh.exe`, `"gh"`, `GH`), and the larger of
 * it and the count in the rewritten text wins (#1606): a quoted path to gh is
 * seen only by the second, a merge inside a string handed to nothing only by
 * the first. Only the program's case is folded: `pr merge` is gh's own
 * subcommand, in lower case, so `GH PR MERGE` in a body is no merge (#1606
 * review).
 */
const mergeMentions = (command) =>
  Math.max(
    (command.match(/\b[Gg][Hh](?:\.[Ee][Xx][Ee])?\b["']?\s+pr\s+merge\b/g) ?? []).length,
    (view(command).text.match(/\bgh\s+pr\s+merge\b/g) ?? []).length,
  );

/**
 * One `gh pr merge` segment's own arguments: the PR ref, the boolean flags and
 * the `--match-head-commit` value (the last one, as gh's flag parser takes
 * it), and whether they were `readable`. Read from the segment's words, so a
 * flag inside `--body "…"`, after a `#`, behind a redirection or in another
 * command of the chain is not taken for the merge's own.
 *
 * With a trusted mask the words are the `flat` text's: a quoted value is one
 * word however many newlines, `;` or `--admin` it carries, and only a word
 * whose raw text equals its flat shape — a plain literal — is taken as a flag,
 * the PR or the pin. A quoted or substituted PR is unreadable, and the gate
 * refuses it rather than judging the current branch's PR in its place; a
 * quoted pin reads as no pin, and a quoted flag as no flag, both of which
 * refuse or check more, never less. Without a trusted mask the raw segment is
 * split by `words` in `shell-lexer.mjs`, as before #1321.
 *
 * `repo` is the `--repo` / `-R` value (the last one), for the post-hook's
 * board moves (#1527): a literal or a quote that expands nothing, `null` when
 * the flag is there but its value is not readable, `undefined` without it.
 */
export function parseMerge({ raw, flat, trusted }) {
  const tokens = segmentTokens({ raw, flat, trusted });
  const at = tokens.findIndex((t, k) => t.shape === "merge" && tokens[k - 1]?.shape === "pr");
  const flags = new Set();
  let ref;
  let pin;
  let repo;
  let positional = false;
  let readable = at >= 0;
  for (let k = at + 1; readable && k < tokens.length; k++) {
    const t = tokens[k];
    if (t.word.startsWith("#")) break;
    if (/^\d*[<>]/.test(t.shape)) {
      // A redirection; a bare operator takes the next word as its target.
      if (/^\d*(?:[<>]{1,3}-?|[<>]&)$/.test(t.shape)) k++;
      continue;
    }
    if (!t.shape.startsWith("-")) {
      if (!positional) {
        positional = true;
        if (literal(t)) ref = t.word;
        else readable = false;
      }
      continue;
    }
    if (/^-[^-]./.test(t.shape)) {
      // gh's short flags as pflag reads them (#1393): combined (`-ds`,
      // `-dR owner/repo`), with the value of the first one that takes one
      // attached (`-Rowner/repo`, `-R=owner/repo`) or in the next word.
      for (let j = 1; j < t.shape.length; j++) {
        const name = `-${t.shape[j]}`;
        if (!MERGE_VALUE_FLAGS.has(name)) {
          flags.add(name);
          continue;
        }
        const rest = t.shape.length - (j + 1);
        const from = rest > 1 && t.shape[j + 1] === "=" ? j + 2 : j + 1;
        const value = rest > 0 ? { word: t.word.slice(from), shape: t.shape.slice(from) } : tokens[++k];
        if (name === "-R") repo = plainValue(value);
        break;
      }
      continue;
    }
    const eq = t.shape.indexOf("=");
    const name = eq > 0 ? t.shape.slice(0, eq) : t.shape;
    if (!MERGE_VALUE_FLAGS.has(name)) flags.add(name);
    else {
      const value = eq > 0 ? { word: t.word.slice(eq + 1), shape: t.shape.slice(eq + 1) } : tokens[++k];
      if (name === "--match-head-commit") pin = literal(value) ? value.word : undefined;
      else if (name === "--repo" || name === "-R") repo = plainValue(value);
    }
  }
  return { ref, flags, pin, repo, readable };
}

const names = (paths, mark = () => "") =>
  paths
    .slice(0, 5)
    .map((p) => p + mark(p))
    .join(", ") + (paths.length > 5 ? `, and ${paths.length - 5} more` : "");

/**
 * The verdict for a head that has no CodeRabbit review object of its own:
 * `null` when CodeRabbit's summary comment says the head was reviewed clean
 * (#1386) or the head is a pure rebase of the commit CodeRabbit last saw
 * (#1307), an ask when the rebase conflicted and only a human can judge the
 * resolution, and a deny otherwise. Called only once every cheap check has
 * passed. A clean incremental review files no review object at the new head,
 * and CodeRabbit does not review a rebase at all, so without this every such
 * PR stalled behind an `@coderabbitai review` or an `--admin`.
 *
 * Refused before anything is read: a release back-merge (its commits land one
 * by one) and a merge not pinned to this exact head with `--match-head-commit`
 * — both verdicts are about one sha, read from state that keeps moving. Then
 * a base retargeted or force-pushed since the newest review object's
 * `submittedAt`, on every path, the summary's included: either makes commits
 * that were base-side at review time look like part of the reviewed change.
 *
 * Then the summary (`readSummary` in `coderabbit-summary.mjs`). Its recent
 * review of `from..S` counts only once `from` is traced back to the newest
 * review object's commit R ({@link traceSummary}). When S is the head, the
 * head is reviewed. When S is older and the comment was written after the
 * newest review object, S is what CodeRabbit last saw and the replay starts
 * from it; otherwise R is the start, as before.
 *
 * The replay (`replayRebase` in `merge-gate-reads.mjs`): the reviewed change re-applied
 * onto the head's base must give the head's exact tree. Every file the
 * replay reports as conflicted gets a line check, and a line match still only
 * earns the ask — it cannot see where a line sits. A follow-up push is refused
 * from inside it. Every uncertain path refuses. Specs:
 * `docs/superpowers/specs/2026-10-03-issue-1307-merge-gate-pure-rebase.md` and
 * `docs/superpowers/specs/2026-10-10-issue-1386-changelog-fragments-merge-gate.md`.
 */
function unreviewedHeadVerdict(merge, pr, bot, ctx, isBackMerge) {
  const head = pr.headRefOid;
  // `gh` lists reviews oldest first; `submittedAt` decides when both carry it.
  const newest = bot.reduce((a, b) => ((b.submittedAt ?? "") >= (a.submittedAt ?? "") ? b : a));
  const lastObject = newest.commit?.oid ?? "";
  const notAtHead = `Not merging PR #${pr.number}: no CodeRabbit review at head ${head.slice(0, 9)}`;
  const reviewAgain = "ask `@coderabbitai review`";
  if (isBackMerge)
    return `${notAtHead} — the newest one is at a previous head ${lastObject.slice(0, 9) || "(no commit)"}, and a release back-merge lands its commits one by one, so a rewritten tip needs a fresh review — ${reviewAgain}.`;
  // GitHub takes only a full sha here, so a prefix would be a merge that can never go through.
  if (!FULL_SHA.test(merge.pin ?? "") || merge.pin !== head)
    return `${notAtHead} — the newest one is at a previous head ${lastObject.slice(0, 9) || "(no commit)"}. The summary and rebase checks decide about this exact head, so pin it: add \`--match-head-commit ${head}\`.`;
  // Asked of the repository the PR's URL proved, never whatever the cwd's
  // checkout or an inherited GH_REPO resolves `{owner}/{repo}` to: another
  // repository's PR of the same number has its own timeline (#1393 review).
  const repo = repoOfUrl(pr.url);
  const summary = readSummary(ctx.prComments?.(pr.number, ctx.cwd, repo), head);
  const moved = ctx.baseChangedSince?.(pr.number, newest.submittedAt, ctx.cwd, repo);
  if (moved !== false) {
    const atNewest = `${notAtHead} — the newest one is at a previous head ${lastObject.slice(0, 9) || "(no commit)"}`;
    return moved
      ? `${atNewest}, and the PR's base branch was retargeted or force-pushed after that review — ${reviewAgain}.`
      : `${atNewest}, and gh could not read whether the base branch moved since that review.`;
  }
  const replay = (reviewed, target) =>
    ctx.replayRebase?.({ reviewed, head: target, base: pr.baseRefOid, dir: ctx.cwd });
  // The summary names an older commit: it is the replay's start only when the
  // comment was written after the newest review object, so it is the newer word.
  const editedAt = Date.parse(summary.editedAt ?? "");
  const objectAt = Date.parse(newest.submittedAt ?? "");
  const newer = Number.isFinite(editedAt) && Number.isFinite(objectAt) && editedAt > objectAt;
  const traced = summary.ok && (summary.atHead || newer) ? traceSummary(summary, lastObject, replay) : undefined;
  if (traced?.ok && summary.atHead) return null;
  const fromSummary = !!traced?.ok;
  const reviewed = fromSummary ? summary.reviewed : lastObject;
  let why;
  if (!summary.ok) why = `; its summary comment does not count, because ${summary.reason}`;
  else if (traced && !traced.ok) why = `; its summary comment does not count, because ${traced.reason}`;
  else if (fromSummary) why = " (read from its summary comment)";
  else if (Number.isFinite(editedAt) && Number.isFinite(objectAt) && editedAt < objectAt)
    why = `; its summary comment's recent review ends at ${summary.reviewed.slice(0, 9)} and was written before that review`;
  else
    why = `; its summary comment's recent review ends at ${summary.reviewed.slice(0, 9)}, but the gate could not establish that the summary is newer than that review (${
      !summary.editedAt
        ? "the comment carries no edit time"
        : !Number.isFinite(editedAt)
          ? "the comment's edit time is unreadable"
          : !newest.submittedAt
            ? "the review carries no time"
            : !Number.isFinite(objectAt)
              ? "the review's time is unreadable"
              : "both carry the same time"
    })`;
  const stale = `${notAtHead} — the newest one is at a previous head ${reviewed.slice(0, 9) || "(no commit)"}${why}`;
  const v = replay(reviewed, head);
  if (!v?.ok) return `${stale}, and ${v?.reason ?? "the rebase check could not run"}.`;
  if (v.followUp)
    return `${stale}, and the head adds ${v.followUp} commit(s) after it, which is a follow-up push, not a rebase — wait for CodeRabbit's review of them.`;
  const conflicted = new Set(v.conflicted);
  const refused = [...new Set([...v.differing.filter((p) => !conflicted.has(p)), ...v.lineMismatch])].sort();
  if (refused.length)
    return `${stale}, and the head is not a pure rebase of it (changed: ${names(refused, (p) => (conflicted.has(p) ? " (conflicted)" : ""))}) — ${reviewAgain}.`;
  if (conflicted.size)
    return {
      ask: `PR #${pr.number}'s head ${head.slice(0, 9)} is a rebase of the CodeRabbit-reviewed ${reviewed.slice(0, 9)}, but the rebase conflicted in ${names([...conflicted])}. Their added and removed lines match the reviewed change; a line match cannot see where a line sits, so the maintainer confirms the resolution.`,
    };
  return null;
}

/**
 * Whether gh's `author` of a PR is Dependabot: `gh pr view --json author`
 * reports a GitHub App as `is_bot: true` with the login `app/<slug>`, and a
 * user login cannot hold a `/`.
 */
const isDependabot = (author) => author?.is_bot === true && author?.login === "app/dependabot";

/** Dependabot's commit author line, as GitHub writes it on every commit it makes. */
export const DEPENDABOT_COMMIT_AUTHOR = "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>";

/** The committer line GitHub writes on Dependabot's commits; a local amend or rebase replaces it. */
export const GITHUB_COMMITTER = "GitHub <noreply@github.com>";

/**
 * Whether an `--admin` merge is one the bypass is for (#1648): `{ ok: true }`,
 * or `{ ok: false, why, offList }` with the reason, and whether files off the
 * list are part of it. It is when Dependabot opened the PR and made every
 * commit on it — Dependabot's author line and GitHub's committer line, so an
 * edit amended or rebased into Dependabot's own commit, which keeps the
 * author, is caught too — or when every file the PR changes is Claude-facing
 * prose (`NO_REVIEW_PATHS`) and no skill's or agent's frontmatter, which is
 * configuration, changed between the merge-base and the head (an added or
 * deleted skill or agent file counts as changed). All of it is read with git
 * at the head (`prChangedFiles` in `merge-gate-reads.mjs`), never from the `no-coderabbit`
 * label, which only decides whether CodeRabbit spends a review. A Dependabot
 * PR carrying anyone else's commit is judged on its files like any PR. A read
 * that fails is a no, never a pass, and a release back-merge is never one:
 * the bypass keeps `--squash`.
 */
function adminQualifies(pr, ctx, isBackMerge) {
  if (isBackMerge) return { ok: false, why: "a release back-merge never is" };
  const read = ctx.prChangedFiles?.({ head: pr.headRefOid, base: pr.baseRefOid, dir: ctx.cwd });
  if (!read?.ok)
    return {
      ok: false,
      why: `the gate could not read the files it changes: ${read?.reason ?? "the read did not run"}`,
    };
  const byDependabot = isDependabot(pr.author);
  const commits = Array.isArray(read.commits) ? read.commits : [];
  if (
    byDependabot &&
    commits.length &&
    commits.every((c) => c?.author === DEPENDABOT_COMMIT_AUTHOR && c?.committer === GITHUB_COMMITTER)
  )
    return { ok: true };
  const off = read.files.filter((f) => !isNoReviewPath(f));
  // A missing pair reads as a change: `frontmatterChanged` takes an absent side as one.
  const config = read.files.filter(
    (f) =>
      isNoReviewPath(f) && hasConfigFrontmatter(f) && frontmatterChanged(read.blobs?.[f]?.base, read.blobs?.[f]?.head),
  );
  if (off.length === 0 && config.length === 0) return { ok: true };
  const why = [];
  if (off.length) why.push(`it changes ${names(off)}, off the prose list`);
  if (config.length)
    why.push(
      `the frontmatter of ${names(config)} changed, or the file is new or deleted, and a skill's or agent's frontmatter is configuration`,
    );
  const foreign = byDependabot ? " (Dependabot opened it, but not every commit on it is Dependabot's own)" : "";
  return { ok: false, why: why.join("; ") + foreign, offList: true };
}

/**
 * The verdict for a merge under `--admin` (#1648), called once every check
 * the gate makes of any `--admin` merge has passed: `null`, an ask, or a deny.
 * `--admin` skips the review checks, so it would merge a head CodeRabbit never
 * reviewed (an approval survives a push here); every such merge is therefore
 * judged for whether it qualifies (`adminQualifies`), whatever GitHub's
 * `mergeStateStatus` says — an unapproved PR reads `UNKNOWN` while GitHub
 * computes it.
 *
 * - **Changes requested:** refused first, qualifying or not and whatever the
 *   merge state, since no prompt stands in for answering a review.
 * - **Not qualifying:** refused while it is BLOCKED (an unapproved PR off the
 *   list has no business merging), otherwise an ask, so it runs only on
 *   Niklas's word. Either way what disqualified it is named.
 * - **Qualifying:** the merge must be pinned with the full
 *   `--match-head-commit <head>`, the head the files were read at, so a push
 *   between the read and the merge cannot slip a file in; and every status
 *   check the base branch's rules require must be in the rollup and green
 *   (`requiredStatusChecks` in `merge-gate-reads.mjs`), since BLOCKED, which the bypass
 *   sets aside for the missing approval, also stands for a required check
 *   that never reported. A rule set the gate cannot read refuses; one that
 *   requires no check (a `release/*` base today) passes, unless the PR is
 *   BLOCKED, where an empty set contradicts the block.
 *
 * Spec: `docs/superpowers/specs/2026-11-07-issue-1648-no-coderabbit-admin-merge.md`.
 */
function adminVerdict(merge, pr, ctx, isBackMerge) {
  const head = pr.headRefOid;
  const at = `PR #${pr.number} at ${head.slice(0, 9)}`;
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    return `Not merging ${at}: a review asked for changes (CHANGES_REQUESTED), which \`--admin\` never passes.`;
  const list = `${NO_REVIEW_PATHS.join(", ")}; .claude/rules/code-review.md, "PRs that skip CodeRabbit"`;
  const q = adminQualifies(pr, ctx, isBackMerge);
  if (!q.ok) {
    if (pr.mergeStateStatus === "BLOCKED")
      return `Not merging ${at}: it is BLOCKED for want of an approval (REVIEW_REQUIRED), and \`--admin\` passes that only for a PR whose every file is Claude-facing prose (${list}) or one Dependabot wrote whole — ${q.why}${
        q.offList
          ? ", so it needs CodeRabbit's review and an approval: take any `no-coderabbit` label off and ask `@coderabbitai review`"
          : ""
      }.`;
    return {
      ask: `${at} merges under \`--admin\`, which skips CodeRabbit's review at the head, and it is not a PR the bypass is for (${list}) — ${q.why}. An \`--admin\` merge off the prose list runs only on Niklas's word: the maintainer confirms.`,
    };
  }
  // GitHub takes only a full sha here, so a prefix would be a merge that can never go through.
  if (!FULL_SHA.test(merge.pin ?? "") || merge.pin !== head)
    return `Not merging ${at}: it may merge under \`--admin\` only at the head the gate read, so pin it: add \`--match-head-commit ${head}\`.`;
  const base = pr.baseRefName ?? "the base branch";
  const required = ctx.requiredChecks?.(repoOfUrl(pr.url), pr.baseRefName, ctx.cwd);
  if (!required?.ok || !Array.isArray(required.contexts))
    return `Not merging ${at}: the gate could not read the status checks ${base} requires (${required?.reason ?? "the read did not run"}), and \`--admin\` must not skip one.`;
  if (required.contexts.length === 0 && pr.mergeStateStatus === "BLOCKED")
    return `Not merging ${at}: it is BLOCKED, yet the rules of ${base} require no status check, so the gate cannot tell what blocks it beyond the missing approval.`;
  const rollup = pr.statusCheckRollup ?? [];
  const missing = required.contexts.filter((c) => !rollup.some((x) => checkName(x) === c && classifyCheck(x) === "ok"));
  if (missing.length)
    return `Not merging ${at}: ${base} requires ${names(missing)}, not reported green at the head, and \`--admin\` must not skip a required check.`;
  return null;
}

/**
 * Whether an accepted summary's recent review of `from..S` reaches back to
 * `anchor`, the newest review object's commit: `{ ok: true }`, or `{ ok:
 * false, reason }`. A recent review covers only the commits after `from`, so
 * `from` must itself have been reviewed: it is `anchor`, or an earlier
 * version of the comment reviewed up to it, walked back the same way
 * (`rangeChain`), or — for any start that walk visited — it is a clean pure
 * rebase of `anchor` by the #1307 replay. Only a clean replay counts: one that
 * conflicted, which earns an ask on the replay path, is a refusal here, since
 * the rest of the chain would then stand on a resolution nobody confirmed.
 */
function traceSummary(summary, anchor, replay) {
  const chain = rangeChain(summary, anchor);
  if (chain.reached) return { ok: true };
  // Oldest first: the start nearest the review object is the likeliest rebase of it.
  for (const start of [...chain.starts].reverse()) {
    const v = FULL_SHA.test(anchor) ? replay(anchor, start) : undefined;
    if (v?.ok && !v.followUp && !v.differing?.length && !v.conflicted?.length && !v.lineMismatch?.length)
      return { ok: true };
  }
  const back =
    chain.starts.length > 1
      ? ` (traced back through ${chain.starts.length - 1} earlier review(s) to ${chain.starts.at(-1).slice(0, 9)})`
      : "";
  return {
    ok: false,
    reason: `its recent review of ${summary.reviewed.slice(0, 9)} starts at ${summary.from.slice(0, 9)}${back}, which the gate cannot trace back to the reviewed ${anchor.slice(0, 9) || "(no commit)"}: it is not that commit, no earlier version of the comment reviewed up to it, and it is not a clean rebase of it`,
  };
}

/**
 * The verdict of the rule `gh pr merge: approval and checks are verified at
 * the current head` in `rules-bash.mjs` on the command `c`: a deny string,
 * `{ ask }`, or `null`. Every git and gh read goes through `ctx`.
 */
export function mergeGateVerdict(c, ctx) {
  // `--repo` / `-R` is a flag of `gh pr` itself, so cobra also takes it
  // ahead of `merge`, and even ahead of `pr`, where the shape below never
  // matches (#1393).
  if (has(c, cmd(/gh\s+pr\s+-[^;&|\n]*?\bmerge\b/)) || has(c, cmd(/gh\s+-[^;&|\n]*?\bpr\b[^;&|\n]*?\bmerge\b/)))
    return "Write a merge as `gh pr merge <pr> …`, with every flag after `merge`: a flag between `gh` and `merge` hides the merge from this gate (#1393).";
  if (!has(c, MERGE_AT)) return null;
  // One merge per command, judged on its own words: the rule used to read
  // the first merge of a chain and honour `--admin` anywhere in the string.
  const segments = mergeSegments(c);
  if (segments.length !== 1 || mergeMentions(c) !== 1) {
    if (segments.length > 1 || mergeMentions(c) > 1)
      return "One `gh pr merge` per command: each merge is checked on its own, so run them one at a time.";
    // No segment starts with the merge: it is the first word of a string a
    // shell runs, or the program a wrapper runs (#1634), named as such.
    const carried = [...matchesAt(c, MERGE_AT)].find((m) => m.how !== "command" || m.shell);
    if (carried) return carriedMerge(carried);
    return "Could not isolate the `gh pr merge` in this command; run it on its own.";
  }
  const merge = parseMerge(segments[0]);
  if (!merge.readable)
    return "Could not read this `gh pr merge`'s own arguments (a quoted or substituted PR, or a merge inside a substitution or heredoc); run it on its own with the PR number or URL as a plain word.";
  const ref = merge.ref;
  // The gate judges a PR of HOME_REPO only, and the PR it reads must be the
  // one gh will merge (#1393): reading this repository's PR of the same
  // number is how a merge in another repository passed on checks nobody ran
  // there. The gate reads before the command runs, so nothing may come ahead
  // of the merge that could change what gh resolves it to — an export, a
  // branch switch, a `pushd` — but a plain `cd <dir>`, which it follows, and
  // nothing may run beside it (a pipe, a background `&`).
  const ahead = cdsAhead(c, GH_PR_MERGE, ctx.cwd, ctx.shell);
  const masked = trustedMask(c);
  // Where the program word starts, not where its rewritten name does (#1606).
  const at = programStart(c, GH_PR_MERGE.exec(masked)?.index ?? c.length);
  if (!ahead || CONCURRENT.test(masked))
    return "Run `gh pr merge` as its own command, with nothing ahead of it but a plain `cd <dir> &&` and no pipe or background `&` in the command: anything else could change which repository or PR gh merges after this gate has read it (#1393).";
  // Read in the rewritten text, where a wrapper spelled with a path is its
  // plain name and a quoted assignment one word.
  if (!plainMergePrefix(masked.slice(ahead.start, at)))
    return "This `gh pr merge` carries a prefix the gate cannot read whole — a wrapper's option, or a GH_* or GIT_* variable other than GH_REPO — which can move what gh merges; name the repository with `-R` on the merge, or leave it out (#1393).";
  // The repository in gh's order — a PR URL, then `--repo` / `-R`, then a
  // `GH_REPO` — refused before gh is asked when it is not HOME_REPO or
  // cannot be read.
  const named = mergeRepo(merge, assignedGhRepo(c.slice(0, at), masked.slice(0, at)));
  if (named === null)
    return `Could not read the repository this \`gh pr merge\` names (a \`--repo\` / \`-R\` or \`GH_REPO\` that is not a plain value); the merge gate judges ${HOME_REPO} PRs only, so name it as a plain word or leave it out.`;
  if (named && !isHomeRepo(named))
    return `This \`gh pr merge\` targets ${named}, not ${HOME_REPO}. The merge gate can judge only ${HOME_REPO} PRs, and agents here merge nothing else (#1393).`;
  // Read where the merge runs (the chained `cd`s move it) with the repository
  // it names, so a branch's PR is the branch the merge sees.
  const pr = ctx.prView(ref, ahead.dir, named && !repoOfUrl(ref) ? named : undefined);
  if (!pr) return `Could not read the PR${ref ? ` "${ref}"` : " for this branch"} with gh; refusing to merge blind.`;
  // Whatever gh resolved the repository from — a checkout the chain moved
  // into, an inherited GH_REPO — the URL it returns says which PR it read.
  const prRepo = repoOfUrl(pr.url);
  if (!isHomeRepo(prRepo))
    return `PR ${pr.url ?? `#${pr.number}`} is in ${prRepo ?? "an unknown repository"}, not ${HOME_REPO} (a checkout of another repository, or an inherited GH_REPO). The merge gate can judge only ${HOME_REPO} PRs, and agents here merge nothing else (#1393).`;
  if (pr.state !== "OPEN") return `PR #${pr.number} is ${pr.state}, not OPEN.`;
  const problems = [];
  const isBackMerge = /^release\//.test(pr.headRefName ?? "");
  const flag = (...f) => f.some((x) => merge.flags.has(x));
  const squash = flag("--squash", "-s");
  const regular = flag("--merge", "-m", "--rebase", "-r");
  if (isBackMerge && squash) problems.push("a release-branch back-merge is a regular merge (--merge), never a squash");
  if (!isBackMerge && !squash) problems.push("feature/fix PRs are squash-merged (--squash)");
  if (!isBackMerge && regular) problems.push("feature/fix PRs are squash-merged, not --merge/--rebase");
  const admin = flag("--admin");
  // #1648: `--admin` skips the review checks; whether the PR is one the
  // bypass is for is judged last (`adminVerdict`), since it costs git and
  // gh work. The one block it may then pass is the missing approval itself.
  const unapproved =
    admin && !isBackMerge && pr.mergeStateStatus === "BLOCKED" && pr.reviewDecision === "REVIEW_REQUIRED";
  const bot = coderabbitReviews(pr.reviews);
  // Set when the head has no review object of its own but an older one exists:
  // the summary (#1386) and pure-rebase (#1307) checks, run last because they
  // are the ones that cost a gh read and git work.
  let rebaseCheck = false;
  if (!admin) {
    if (pr.reviewDecision !== "APPROVED")
      problems.push(`reviewDecision is ${pr.reviewDecision ?? "unset"}, not APPROVED`);
    if (bot.length === 0) problems.push(`no CodeRabbit review at head ${pr.headRefOid.slice(0, 9)}`);
    else {
      if (!bot.some((r) => r.state === "APPROVED")) problems.push("CodeRabbit has never approved this PR");
      rebaseCheck = !bot.some((r) => r.commit?.oid === pr.headRefOid);
    }
  }
  const rollup = pr.statusCheckRollup ?? [];
  const pending = rollup.filter((x) => classifyCheck(x) === "pending").map(checkName);
  const bad = rollup.filter((x) => classifyCheck(x) !== "pending" && classifyCheck(x) !== "ok").map(checkName);
  if (rollup.length === 0) problems.push("no checks reported at all");
  if (pending.length) problems.push(`checks still pending: ${pending.join(", ")}`);
  if (bad.length) problems.push(`checks not green: ${bad.join(", ")}`);
  if (pr.mergeStateStatus === "DIRTY" || (pr.mergeStateStatus === "BLOCKED" && !unapproved))
    problems.push(
      `mergeStateStatus is ${pr.mergeStateStatus}${
        admin && pr.mergeStateStatus === "BLOCKED" && pr.reviewDecision === "CHANGES_REQUESTED"
          ? " (CHANGES_REQUESTED: a review asked for changes, which `--admin` never passes)"
          : ""
      }`,
    );
  if (problems.length === 0) {
    if (admin) return adminVerdict(merge, pr, ctx, isBackMerge);
    return rebaseCheck ? unreviewedHeadVerdict(merge, pr, bot, ctx, isBackMerge) : null;
  }
  if (unapproved)
    problems.push(
      "mergeStateStatus is BLOCKED (REVIEW_REQUIRED; whether `--admin` may merge it unapproved — only Claude-facing prose or a PR Dependabot wrote whole — is read once the rest is green)",
    );
  if (rebaseCheck)
    problems.push(
      "the head has no CodeRabbit review of its own (the summary and pure-rebase checks run once the rest is green)",
    );
  return `Not merging PR #${pr.number} at ${pr.headRefOid.slice(0, 9)}: ${problems.join("; ")}.`;
}

/**
 * Classifies one `statusCheckRollup` entry. The array MIXES two node types:
 * GitHub Actions jobs are `CheckRun` (status/conclusion) while CodeRabbit is a
 * `StatusContext` (state) whose absent fields are omitted, not null — so the
 * test is on `__typename`, and an unknown type fails closed.
 */
export function classifyCheck(c) {
  switch (c.__typename) {
    case "CheckRun":
      return c.status !== "COMPLETED"
        ? "pending"
        : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion)
          ? "ok"
          : "bad";
    case "StatusContext":
      return ["PENDING", "EXPECTED"].includes(c.state) ? "pending" : c.state === "SUCCESS" ? "ok" : "bad";
    default:
      return "unknown";
  }
}

const checkName = (c) => c.name ?? c.context ?? c.__typename ?? "?";
