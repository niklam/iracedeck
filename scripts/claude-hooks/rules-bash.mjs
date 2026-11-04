/**
 * PreToolUse rules for the Bash and PowerShell tools — the repo's mechanical
 * "never do X" rules, turned from prose into checks that run before the
 * command does. A rule marked `bashOnly` describes bash syntax and is skipped
 * for a PowerShell command ({@link checkBash}).
 *
 * Each rule is `(command, ctx) → verdict`: a string DENIES with that reason,
 * `{ ask: reason }` forces the permission prompt, anything falsy passes. The
 * context is lazy so a rule that needs `git` or `gh` only pays for it when
 * its regex matched; tests hand in a fake context.
 *
 * The rules are heuristics over a shell command string. They aim to catch the
 * shapes that have actually gone wrong here (each names its origin), not to
 * parse bash.
 *
 * Every rule reads the command through the shell lexer in `shell-lexer.mjs`,
 * and the deck-host rule judges what a command runs through the
 * package-script interpreter in `script-runs.mjs` (#1590); the rule-specific
 * parsers stay here.
 */
import path from "node:path";

import { DEBUG_VALUE, ELGATO_MANIFEST, manifestDebug } from "../lib/debug-plugin.mjs";
import { FULL_SHA, rangeChain, readSummary } from "./coderabbit-summary.mjs";
import { INTEGRATION_BRANCH, INTEGRATION_TREE, MAIN_BRANCH, SPEC_DIR } from "./lib.mjs";
import { assignedGhRepo, HOME_REPO, isHomeRepo, mergeRepo, repoOfUrl } from "./rules-post.mjs";
import { findControlByte } from "./rules-tools.mjs";
import { deckFindings } from "./script-runs.mjs";
import {
  BASH,
  CHAIN_AND_BACKGROUND,
  chainCommands,
  cmd,
  COMMAND_LEAD,
  commandEnd,
  GIT_C_RE,
  gitCwd,
  has,
  maskInert,
  matchAt,
  matchesAt,
  optionDir,
  POWERSHELL,
  powershellAsBash,
  ranges,
  resolveDir,
  trustedMask,
  view,
  words,
} from "./shell-lexer.mjs";

const TITLE_RE = /^(feat|fix|improve|perf|refactor|docs|ci|chore|test|build|style|revert)(\([^)]+\))?!?: .+ \(#\d+\)$/;

/**
 * What a spec must carry beyond its header block (#1193). Measured over all
 * 106 specs: since the #621 policy, "Out of scope" fell from 50 % to 17 % and
 * a Testing/Verification section from 88 % to 70 % — because no rule had ever
 * named either. The only surviving prescription was a pre-#621 template in a
 * planning agent's definition (retired in #1520) that had produced zero specs.
 *
 * The spellings are the ones ALREADY in the corpus, deliberately: the house
 * style has never been uniform, and forcing one would rewrite 45 compliant
 * specs' habits for nothing. Matched against headings at any level plus the
 * bold pseudo-headings the specs use, never against body prose — a passing
 * mention of a test is not a test plan.
 */
const SPEC_SECTIONS = [
  {
    what: "an Out of scope section",
    re: /out of scope|non-goals?|not in scope|deliberately does not|does not (?:do|cover|include|ship)/i,
  },
  { what: "a Testing or Verification section", re: /\b(tests?|testing|verification|verify)\b/i },
];

/** The `> **Issue:** … **Supersedes:** … **Superseded by:** …` block. */
const SPEC_HEADER = /^>\s*\*\*Issue:\*\*.*\*\*Supersedes:\*\*.*\*\*Superseded by:\*\*/m;

/** A fenced code block: its opening run of backticks or tildes, up to the same run closing it. */
const FENCED_BLOCK = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;

/**
 * Headings at any level, plus the lines the specs make headings of by bolding
 * the WHOLE line (`**Manual verification**`, optionally with a trailing colon).
 * Code fences are dropped first, since a `# verify the build` comment in a
 * bash block is not a heading. A paragraph that merely OPENS in bold is body
 * prose, and does not count: the one post-policy spec that passed on such a
 * line (`**Tests assert structure, not pixels.**`, inside #1145's Decisions)
 * has no test section, and is already in HEAD, so it is never re-checked.
 */
function specHeadings(text) {
  const body = text.replace(FENCED_BLOCK, "");
  return [
    ...[...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]),
    ...[...body.matchAll(/^\*\*([^*\n]+?)\*\*[:.]?\s*$/gm)].map((m) => m[1]),
  ].map((h) => h.trim());
}

/** What a committed spec is missing, in the order a reader would fix it. */
export function missingSpecParts(text) {
  const missing = [];
  if (!SPEC_HEADER.test(text)) missing.push("the header block (Issue · Supersedes · Superseded by)");
  const heads = specHeadings(text);
  for (const s of SPEC_SECTIONS) if (!heads.some((h) => s.re.test(h))) missing.push(s.what);
  return missing;
}

/** A spec is named for its issue; the date and the topic around it are free. */
const specExistsFor = (files, issue) => files.some((f) => new RegExp(`-issue-${issue}-`).test(f));

// ---------------------------------------------------------------------------

/** The git shapes whose rules read a `-C`; exported so the post-hook scopes the same way. */
export const GIT_PUSH = cmd(/git\s+(-C\s+\S+\s+)?push\b/);
export const GIT_COMMIT = cmd(/git\s+(-C\s+\S+\s+)?commit\b/);
export const GIT_WORKTREE_ADD = cmd(/git\s+(?:-C\s+\S+\s+)?worktree\s+add\b(.*)$/);
export const GIT_WORKTREE_REMOVE = cmd(/git\s+(?:-c\s+\S+\s+)?(?:-C\s+\S+\s+)?worktree\s+remove\b(.*)$/);

/**
 * Issue number of an `ir-<n>` worktree path, read off its LAST segment — the
 * directory the add creates — or `undefined`. The pre-hook's worktree rule
 * (naming and spec gate) and the post-hook's board move all read it here, so
 * they agree on the name: an `ir-` segment higher up (`…/ir-1325/repo/ir-1321`)
 * is not what the add made, and `ir-0` or `ir-0042` names no issue (#1358).
 */
export function issueFromWorktreePath(p) {
  const m = String(p).match(/(?:^|[\\/])ir-([1-9]\d*)$/);
  return m ? Number(m[1]) : undefined;
}

/**
 * The target of the `git worktree add` at command position, read from the raw
 * text: `null` when there is no such command, `undefined` when it names no
 * target. Shared by the pre-hook rule and the post-hook's board move, so the
 * card that moves is always the tree the rule judged (#1321 review).
 */
export function worktreeAddTarget(command) {
  const m = matchAt(command, GIT_WORKTREE_ADD);
  if (!m) return null;
  const args = words(m[1]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-b" || args[i] === "-B" || args[i] === "--reason") i++;
    else if (!args[i].startsWith("-")) return args[i];
  }
  return undefined;
}

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
const GH_PR_MERGE = /\bgh\s+pr\s+merge\b/;

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
 * `{ raw, flat, trusted }` slice for {@link parseMerge}.
 */
export function mergeSegments(command) {
  const lead = new RegExp(String.raw`^[\s($]*${COMMAND_LEAD}gh\s+pr\s+merge\b`);
  const { text, flat, trusted } = view(command);
  return ranges(text, CHAIN_AND_BACKGROUND)
    .filter(([a, b]) => lead.test(text.slice(a, b)))
    .map(([a, b]) => ({ raw: command.slice(a, b), flat: flat.slice(a, b), trusted }));
}

/**
 * The first `gh pr merge` outside inert text, at command position or not,
 * parsed ({@link parseMerge}); `undefined` when there is none. The post-hook's
 * trigger: a merge run through a wrapper the anchor does not know still gets
 * its board move and CI run list.
 */
export function firstMerge(command) {
  const { text, flat, trusted } = view(command);
  const m = /\bgh\s+pr\s+merge\b/.exec(text);
  if (!m) return undefined;
  const rest = text.slice(m.index).search(CHAIN_AND_BACKGROUND);
  const end = rest < 0 ? text.length : m.index + rest;
  return parseMerge({ raw: command.slice(m.index, end), flat: flat.slice(m.index, end), trusted });
}

/**
 * Every `gh pr merge` in the RAW text — the backstop for a separator the split
 * does not know, and for a merge the mask hid. It counts raw text so that it
 * shares no blind spot with the mask it backs up (#1321 review), and it is
 * reached only once a merge at command position has matched, so a command that
 * merely mentions one never pays for it.
 */
const mergeMentions = (command) => (command.match(/\bgh\s+pr\s+merge\b/g) ?? []).length;

/**
 * The words of one command segment, `{ word, shape }` each: with a trusted mask
 * the `flat` text's words, each with its raw text, so a quoted value is one word
 * however many separators or flags it carries; without one the raw segment split
 * by `words` in `shell-lexer.mjs`, every word its own shape. Shared by {@link parseMerge} and
 * {@link parseIssueEdit}.
 */
function segmentTokens({ raw, flat, trusted }) {
  return trusted
    ? [...flat.matchAll(/\S+/g)].map((m) => ({ word: raw.slice(m.index, m.index + m[0].length), shape: m[0] }))
    : words(raw).map((w) => ({ word: w, shape: w }));
}

/** Whether a {@link segmentTokens} word is a plain literal: its raw text is its flat shape. */
const literal = (t) => t !== undefined && t.word === t.shape;

/**
 * A word's value when the hook can know it: a plain literal, or one in quotes
 * that expand nothing; `null` for anything else, a missing word included. The
 * mask leaves a bare `$REPO` as it is, so a `$` is refused here.
 */
function plainValue(t) {
  if (t === undefined || /[$`]/.test(t.word)) return null;
  if (literal(t)) return t.word;
  const quoted = /^'([^']*)'$/.exec(t.word) ?? /^"([^"$`\\]*)"$/.exec(t.word);
  return quoted ? quoted[1] : null;
}

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
    if (/^-R[^=]/.test(t.shape)) {
      // gh's short flag with its value attached: `-Rowner/repo`.
      repo = plainValue({ word: t.word.slice(2), shape: t.shape.slice(2) });
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

/** `gh issue edit` flags that take a value, so a value is never read as an issue or a flag. */
const ISSUE_EDIT_VALUE_FLAGS = new Set([
  "--add-assignee",
  "--remove-assignee",
  "--add-label",
  "--remove-label",
  "--add-project",
  "--remove-project",
  "--body",
  "-b",
  "--body-file",
  "-F",
  "--milestone",
  "-m",
  "--title",
  "-t",
  "--repo",
  "-R",
]);

/** An issue argument as gh takes one, `5`, `#5` or an issue URL: the number as a string, or the URL; else `null`. */
function issueArg(value) {
  if (value == null) return null;
  const n = /^#?([1-9]\d*)$/.exec(value);
  if (n) return n[1];
  const url = /^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/[1-9]\d*)\/?$/i.exec(value);
  return url ? url[1] : null;
}

/**
 * One `gh issue edit` segment's own arguments (#1574), read as
 * {@link parseMerge} reads a merge's: `issues` (each a number as a string or
 * an issue URL, in order — gh takes several), `milestone` (the last
 * `--milestone` / `-m` value: `undefined` without one, `null` when it is not
 * readable, `""` when empty), `removesMilestone`, and `repo` (the last
 * `--repo` / `-R`, as in {@link parseMerge}). `readable` is false when an
 * issue argument is not a plain number or issue URL — a `$N`, a substitution
 * — so the caller can say it could not tell which issues the edit touched.
 * A word after `--` is an issue whatever it looks like; one starting with an
 * unquoted `#` opens a comment, as in bash and PowerShell.
 */
export function parseIssueEdit({ raw, flat, trusted }) {
  const tokens = segmentTokens({ raw, flat, trusted });
  const at = tokens.findIndex((t, k) => t.shape === "edit" && tokens[k - 1]?.shape === "issue");
  const issues = [];
  let milestone;
  let removesMilestone = false;
  let repo;
  let readable = at >= 0;
  let options = true;
  for (let k = at + 1; at >= 0 && k < tokens.length; k++) {
    const t = tokens[k];
    if (t.word.startsWith("#")) break;
    // A redirection, bash's `&>` and PowerShell's `*>` included; a bare operator takes the next word as its target.
    if (/^(?:\d*|[&*])[<>]/.test(t.shape)) {
      if (/^(?:\d*|[&*])(?:[<>]{1,3}-?|[<>]&)$/.test(t.shape)) k++;
      continue;
    }
    if (!options || !t.shape.startsWith("-")) {
      const issue = issueArg(plainValue(t));
      if (issue) issues.push(issue);
      else readable = false;
      continue;
    }
    if (t.shape === "--") {
      options = false;
      continue;
    }
    if (t.shape === "--remove-milestone") {
      removesMilestone = true;
      continue;
    }
    // A short flag with its value attached: `-m3.8.0`, `-m=3.8.0`, `-Rowner/repo`.
    const short = /^-([mR])=?(?=.)/.exec(t.shape);
    const eq = t.shape.indexOf("=");
    const name = short ? `-${short[1]}` : eq > 0 ? t.shape.slice(0, eq) : t.shape;
    if (!ISSUE_EDIT_VALUE_FLAGS.has(name)) continue;
    const cut = short ? short[0].length : eq + 1;
    const value = short || eq > 0 ? { word: t.word.slice(cut), shape: t.shape.slice(cut) } : tokens[++k];
    if (name === "--milestone" || name === "-m") milestone = plainValue(value);
    else if (name === "--repo" || name === "-R") repo = plainValue(value);
  }
  return { issues, milestone, removesMilestone, repo, readable };
}

/** Where a `gh issue edit` is, anywhere in the trusted-masked text: the post-hook's trigger, unanchored as its others are. */
export const GH_ISSUE_EDIT = /\bgh\s+issue\s+edit\b/;

/** A milestone flag anywhere in a word list's raw text — not `--remove-milestone` — for an edit the hook cannot read whole. */
const MILESTONE_FLAG = /(?:^|[\s"'(=])(?:--milestone\b|-m)/;

/**
 * Every `gh issue edit` outside inert text, in chain order (`chainCommands` in `shell-lexer.mjs`),
 * parsed ({@link parseIssueEdit}), each with `base` (the directory it ran in)
 * and `start` (where it begins in `command`, so the caller can read the
 * `GH_REPO` that reaches it).
 *
 * The edit runs to its own end (`commandEnd` in `shell-lexer.mjs`), and that text is lexed on
 * its own (#1574 second read): a substitution among its arguments
 * (`--body "$(cat <<'EOF' … EOF)"`, `$(gh issue list …)`) is then one word, so
 * the flags after it are still read, and an edit inside one
 * (`out=$(gh issue edit 5 -m x)`), which the whole command's flat text blanks,
 * is at the top level of its own. Where the mask is not trusted the raw words
 * are read, as everywhere else. `namesMilestone` says whether a milestone flag
 * appears anywhere in the edit's raw text, for one the hook could not read
 * whole: the caller then says to move its cards by hand rather than nothing.
 */
export function* issueEdits(command, cwd, shell = BASH) {
  const { text, trusted } = view(command);
  for (const { base, head, at } of chainCommands(command, cwd, GH_ISSUE_EDIT, shell)) {
    const start = at - head.length;
    // Live backticks ahead of it: an odd count means it runs inside a backtick substitution.
    const inTick = (text.slice(0, start).match(/\x60/g)?.length ?? 0) % 2 === 1;
    const raw = command.slice(start, commandEnd(text, at, inTick));
    const own = maskInert(raw);
    const lexed = trusted && own.sure;
    const edit = parseIssueEdit({ raw, flat: lexed ? own.flat : raw, trusted: lexed });
    yield { ...edit, namesMilestone: MILESTONE_FLAG.test(raw), base, start };
  }
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
 * The replay (`replayRebase` in `lib.mjs`): the reviewed change re-applied
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
  const summary = readSummary(ctx.prComments?.(pr.number, ctx.cwd), head);
  const moved = ctx.baseChangedSince?.(pr.number, newest.submittedAt, ctx.cwd);
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
 * Whether a `gh api` call's own arguments write to a Projects v2 item over
 * REST (#1574): a path with `projectsV2/…/items`, and a method that is not
 * GET — an explicit `-X` / `--method`, or else a field or `--input`, with
 * which gh sends a POST. A read of the same path is no write.
 */
function restItemWrite(args) {
  if (!/projectsV2\/\S*items\b/i.test(args)) return false;
  const method = /(?:^|\s)(?:-X\s*|--method(?:=|\s+))["']?([A-Za-z]+)/.exec(args);
  if (method) return method[1].toUpperCase() !== "GET";
  return /(?:^|\s)(?:-[fF]|--(?:raw-)?field\b|--input\b)/.test(args);
}

export const rules = [
  {
    name: "code-review is a Skill, never --fix",
    test: (c) =>
      has(c, /code-review[^\n|;&]*--fix\b/) &&
      "Never run /code-review with --fix: findings are candidates, not verdicts, and one bare run wrote eight files into master. Report only; apply verified findings by hand (.claude/rules/code-review.md).",
  },
  {
    // Only a tag push asks. The plain push and `gh pr create` asks were dropped
    // on 2026-09-08: the hook sees the command, never the conversation, so it
    // prompted just as loudly when the maintainer had asked for the push. The
    // manual-test gate on pushes and PRs is a prose rule (issue-workflow.md).
    // Judged per command of the chain, so a `--dry-run` on another push, in a
    // string or in a comment does not wave a real tag push through (#1321
    // review). The tag itself is read from the raw text: `"v1.2.3"` is a tag too.
    name: "git push: a tag cuts a release",
    test: (c) => {
      const text = trustedMask(c);
      const tagPush = ranges(text, CHAIN_AND_BACKGROUND).some(
        ([a, b]) =>
          GIT_PUSH.test(text.slice(a, b)) &&
          !/--dry-run\b/.test(text.slice(a, b)) &&
          /\bpush(?:\s[^|&;]*)?\s["']?(--tags\b|v\d+\.\d+)/.test(c.slice(a, b)),
      );
      return tagPush && { ask: "Pushing a tag cuts a release. The maintainer confirms." };
    },
  },
  {
    // #1520: `integration` is origin/master plus the branches under manual
    // test, reset and re-merged by every combined build — a local branch
    // nobody else should ever see. Each push of a chain is judged in the tree
    // it runs in, so `cd ../ir-integration && git push` is caught.
    name: "git push: the integration branch is never pushed",
    test: (c, ctx) => {
      for (const { base, head, args } of chainCommands(c, ctx.cwd, GIT_PUSH, ctx.shell)) {
        const dir = optionDir(head, GIT_C_RE, base, ctx.shell);
        const fromIntegration = () =>
          ctx.branch(dir) === INTEGRATION_BRANCH || path.basename(ctx.toplevel?.(dir) ?? dir) === INTEGRATION_TREE;
        if (pushReachesIntegration(words(args), fromIntegration))
          return `The \`${INTEGRATION_BRANCH}\` branch is local and never pushed: it is origin/${MAIN_BRANCH} plus the branches under manual test, rebuilt by scripts/integration-build.mjs (#1520). Push each issue branch from its own ../ir-<issue> tree.`;
      }
      return null;
    },
  },
  {
    name: "gh --body @- does not read stdin",
    test: (c) =>
      has(c, cmd(/gh\b[^|&;]*--body\s+@-/)) &&
      "`--body @-` does not read stdin with gh; use `--body-file -` (and re-read the posted body).",
  },
  {
    name: "gh pr create: the title must be a complete conventional subject with the issue number",
    test: (c) => {
      const create = matchAt(c, cmd(/gh\s+pr\s+create\b/));
      if (!create) return null;
      // The flag is found in the masked text, after the create, so a `-t` inside
      // a body is not it; its quoted value is then read from the raw text.
      const flag = /\s(?:--title|-t)\s+/g;
      flag.lastIndex = create.index;
      const f = flag.exec(trustedMask(c));
      const value = /"([^"]*)"|'([^']*)'|(\S+)/y;
      value.lastIndex = f ? f.index + f[0].length : 0;
      const title = f && value.exec(c);
      const t = title?.[1] ?? title?.[2] ?? title?.[3];
      if (t !== undefined && !TITLE_RE.test(t))
        return `PR title "${t}" must be \`<type>(<scope>): <description> (#<issue>)\` — it becomes the squash commit and drives the release notes (.claude/rules/build-and-commit.md).`;
      return null;
    },
  },
  {
    name: "gh pr merge: approval and checks are verified at the current head",
    test: (c, ctx) => {
      if (!has(c, cmd(/gh\s+pr\s+merge\b/))) return null;
      // One merge per command, judged on its own words: the rule used to read
      // the first merge of a chain and honour `--admin` anywhere in the string.
      const segments = mergeSegments(c);
      if (segments.length !== 1 || mergeMentions(c) !== 1)
        return segments.length > 1 || mergeMentions(c) > 1
          ? "One `gh pr merge` per command: each merge is checked on its own, so run them one at a time."
          : "Could not isolate the `gh pr merge` in this command; run it on its own.";
      const merge = parseMerge(segments[0]);
      if (!merge.readable)
        return "Could not read this `gh pr merge`'s own arguments (a quoted or substituted PR, or a merge inside a substitution or heredoc); run it on its own with the PR number or URL as a plain word.";
      const ref = merge.ref;
      // The gate judges a PR of HOME_REPO only, and the PR it reads must be the
      // one gh will merge (#1393). The repository is taken in gh's order — a PR
      // URL, then `--repo` / `-R`, then a `GH_REPO` that reaches the merge — and
      // anything else, or a value the hook cannot read, is refused before gh is
      // asked: reading this repository's PR of the same number is how a merge in
      // another repository passed on checks nobody ran there.
      const masked = trustedMask(c);
      const at = GH_PR_MERGE.exec(masked)?.index ?? c.length;
      const named = mergeRepo(merge, assignedGhRepo(c.slice(0, at), masked.slice(0, at)));
      if (named === null)
        return `Could not read the repository this \`gh pr merge\` names (a \`--repo\` / \`-R\` or \`GH_REPO\` that is not a plain value); the merge gate judges ${HOME_REPO} PRs only, so name it as a plain word or leave it out.`;
      if (named && !isHomeRepo(named))
        return `This \`gh pr merge\` targets ${named}, not ${HOME_REPO}. The merge gate can judge only ${HOME_REPO} PRs, and agents here merge nothing else (#1393).`;
      // Read where the merge runs (a chained `cd` moves it) with the repository
      // it names, so a branch's PR is the branch the merge sees.
      const dir = gitCwd(c, ctx.cwd, GH_PR_MERGE, ctx.shell);
      const pr = ctx.prView(ref, dir, named && !repoOfUrl(ref) ? named : undefined);
      if (!pr)
        return `Could not read the PR${ref ? ` "${ref}"` : " for this branch"} with gh; refusing to merge blind.`;
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
      if (isBackMerge && squash)
        problems.push("a release-branch back-merge is a regular merge (--merge), never a squash");
      if (!isBackMerge && !squash) problems.push("feature/fix PRs are squash-merged (--squash)");
      if (!isBackMerge && regular) problems.push("feature/fix PRs are squash-merged, not --merge/--rebase");
      const admin = flag("--admin");
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
      if (["BLOCKED", "DIRTY"].includes(pr.mergeStateStatus))
        problems.push(`mergeStateStatus is ${pr.mergeStateStatus}`);
      if (problems.length === 0) return rebaseCheck ? unreviewedHeadVerdict(merge, pr, bot, ctx, isBackMerge) : null;
      if (rebaseCheck)
        problems.push(
          "the head has no CodeRabbit review of its own (the summary and pure-rebase checks run once the rest is green)",
        );
      return `Not merging PR #${pr.number} at ${pr.headRefOid.slice(0, 9)}: ${problems.join("; ")}.`;
    },
  },
  {
    name: "git commit: specs go to master only, with their sections and no control bytes; a dirty lockfile rides with its package.json",
    test: (c, ctx) => {
      if (!has(c, GIT_COMMIT)) return null;
      const dir = gitCwd(c, ctx.cwd, GIT_COMMIT, ctx.shell);
      const branch = ctx.branch(dir);
      const { files: committed, fromIndex } = commitSelection(c, ctx, dir);
      if (branch && branch !== MAIN_BRANCH) {
        const specs = committed.filter((f) => f.startsWith(SPEC_DIR));
        if (specs.length)
          return `A spec commits to ${MAIN_BRANCH} as its own docs(specs) commit, never on a feature branch (${specs.join(", ")} on ${branch}). See .claude/rules/specs-and-plans.md.`;
      }
      // The commit is where a spec's bytes are knowable and its author is still
      // holding it. Two things pass on purpose (#1193): a spec ALREADY in HEAD,
      // because the requirement is forward-only like #621's naming convention
      // and `specs-and-plans.md` protects editing a spec freely before it ships
      // — 30 of the 64 post-policy specs were amended, and none of those edits
      // is the moment to demand a section the spec was never asked for; and
      // text the hook cannot read, because a spec is never blocked over bytes
      // the hook failed to find. The bytes are read from where the commit will
      // take them — the index or the working copy, per `commitSelection`.
      //
      // The control-byte check is the exception to forward-only: it covers an
      // amendment too. A push that changes only specs starts no CI run (#1466),
      // so `scripts/no-control-bytes.test.mjs` no longer sees a spec until the
      // next code push, and the commit is the last place it is caught in time.
      for (const f of committed.filter((x) => x.startsWith(SPEC_DIR))) {
        const text = ctx.committedText?.(dir, f, fromIndex.has(f) ? "index" : "worktree");
        if (text === undefined) continue;
        const problems = [];
        const found = findControlByte(text);
        if (found)
          problems.push(
            `${f} has a raw control byte 0x${found.code} on line ${found.line}. Write it as an escape (\\x${found.code}) — a spec-only push runs no CI, so nothing after this commit would catch it (#1466, #1103).`,
          );
        const missing = ctx.tracked?.(dir, f) ? [] : missingSpecParts(text);
        if (missing.length)
          problems.push(
            `${f} is missing ${missing.join(" and ")}. A spec carries the header block, an Out of scope section and a Testing/Verification section. See .claude/rules/specs-and-plans.md.`,
          );
        if (problems.length) return problems.join(" ");
      }
      if (
        committed.some((f) => /(^|\/)package\.json$/.test(f)) &&
        !committed.includes("pnpm-lock.yaml") &&
        ctx.modified(dir).includes("pnpm-lock.yaml")
      )
        return "pnpm-lock.yaml is modified but not in this commit while a package.json is. Stage the lockfile too — local builds pass via hoisting, CI's --frozen-lockfile fails every job at once.";
      return null;
    },
  },
  {
    // `pnpm debug:plugin on` writes an inspector flag into the Elgato manifest
    // on the developer's machine, and on the maintainer's master it stays there
    // (#1338). The commit is where it must stop: the bytes are read from where
    // THIS commit takes them ({@link manifestSources}), so a manifest that is
    // dirty with the key but left out of the commit passes, and one staged
    // clean and edited since is judged on its staged copy. Bytes the hook
    // cannot read pass, as for the spec rule; `pack:plugin` and CI are the
    // backstops.
    name: "git commit: the Elgato manifest never carries a Debug key",
    test: (c, ctx) => {
      if (!has(c, GIT_COMMIT)) return null;
      const dir = gitCwd(c, ctx.cwd, GIT_COMMIT, ctx.shell);
      for (const commit of matchesAt(c, GIT_COMMIT)) {
        for (const from of manifestSources(c, commit, ctx, dir)) {
          const text = ctx.committedText?.(dir, ELGATO_MANIFEST, from);
          if (text === undefined) continue;
          const state = manifestDebug(text);
          // Text that does not parse is judged by a plain search — erring to deny.
          const present = state.ok ? state.present : /"Debug"\s*:/.test(text);
          if (!present) continue;
          const value = state.ok ? JSON.stringify(state.value) : "(unparsed)";
          const fix =
            state.ok && state.value === DEBUG_VALUE
              ? "Run `pnpm debug:plugin off` (then `git add` the manifest again if it is staged)"
              : "This value was not set by `pnpm debug:plugin`; remove the line by hand";
          return `${ELGATO_MANIFEST} would be committed with "Debug": ${value} in its Nodejs block (from the ${from === "index" ? "staged" : "working"} copy) — a local inspector switch that must never be committed. ${fix}, or leave the manifest out of this commit (\`git commit --only -- <paths>\`).`;
        }
      }
      return null;
    },
  },
  {
    name: "git worktree add: a sibling of the repo, from a fresh origin/master",
    test: (c, ctx) => {
      const target = worktreeAddTarget(c);
      if (!target) return null;
      const dir = gitCwd(c, ctx.cwd, GIT_WORKTREE_ADD, ctx.shell);
      const resolved = resolveDir(dir, target, { shell: ctx.shell });
      // A true sibling, not merely "outside master": the main root is the
      // checkout the git-common-dir belongs to, so a tree nested inside
      // another ir-* worktree is outside it and would otherwise pass (#1358).
      // "Same directory" is `isInside` both ways, so the comparison keeps its
      // case rule: folded on Windows only.
      const parent = path.dirname(ctx.mainRoot(dir));
      const sibling = ctx.isInside(path.dirname(resolved), parent) && ctx.isInside(parent, path.dirname(resolved));
      if (ctx.isInside(resolved, ctx.mainRoot(dir)) || !sibling)
        return `Worktrees are siblings of the repo (${path.join(parent, "ir-<issue>")}), never inside it or another tree: ${resolved}.`;
      // The integration tree (#1520) is the one name that is not an issue's,
      // matched exactly: a near miss like `ir-integrations` is refused.
      const integration = path.basename(resolved) === INTEGRATION_TREE;
      if (!integration && issueFromWorktreePath(resolved) === undefined)
        return `Issue worktrees are named ../ir-<issue>, or ../${INTEGRATION_TREE} for the integration tree (got ${path.basename(resolved)}).`;
      const fresh = ctx.originFresh(dir);
      if (fresh && !fresh.fresh)
        return `origin/${MAIN_BRANCH} is stale (local ${fresh.local}, remote ${fresh.remote}); run \`git fetch origin\` first or the branch starts behind and surfaces as a PR conflict.`;
      if (integration) return null;
      // The one moment where the issue number is known and implementation has
      // not started (#1193): 47 of the 56 enhancement issues filed since the
      // #621 policy have a spec, and nothing was checking the other nine.
      // An ASK, never a deny — the exemptions (a bug, a docs fix, a dependency
      // bump, a hygiene sweep) are judgement no regex makes. Labels that are
      // readable and carry no `enhancement` ARE those exemptions, so the ask
      // stays silent for them; labels that cannot be read (no `gh`, offline)
      // ask, and the prompt names the exemption so it costs one keypress.
      const issue = issueFromWorktreePath(resolved);
      if (!specExistsFor(ctx.specFiles?.(dir) ?? [], issue)) {
        const labels = (ctx.issueLabels?.(issue, dir)?.labels ?? []).map((l) => l?.name ?? l);
        if (!labels.length || labels.includes("enhancement"))
          return {
            ask: `No spec on ${MAIN_BRANCH} for #${issue} (${SPEC_DIR}*-issue-${issue}-*.md). A feature or enhancement gets its spec BEFORE its worktree; a bug, docs fix, dependency bump or hygiene sweep is exempt — confirm to proceed. See .claude/rules/specs-and-plans.md.`,
          };
      }
      return null;
    },
  },
  {
    name: "git worktree remove: not while a deck host is linked into it",
    test: (c, ctx) => {
      const m = matchAt(c, GIT_WORKTREE_REMOVE);
      if (!m) return null;
      const target = words(m[1]).find((w) => !w.startsWith("-"));
      if (!target) return null;
      const resolved = resolveDir(gitCwd(c, ctx.cwd, GIT_WORKTREE_REMOVE, ctx.shell), target, { shell: ctx.shell });
      const held = ctx.linkTargets().filter((l) => l.target && ctx.isInside(l.target, resolved));
      if (held.length)
        return `${held.map((l) => l.host).join(" and ")} plugin link points into ${resolved}. Do not relink it yourself, not even to master — leave the link and the worktree as they are and tell Niklas.`;
      return null;
    },
  },
  {
    // #1520: Niklas may be racing on the plugin a deck host runs, and a
    // restart, a stop, a start or a relink of that host breaks the session.
    // An ASK, not a deny: Niklas saying go and confirming the prompt is the
    // intended path. Building or installing needs no go, even in a tree a
    // host's link points into (#1526): the host keeps the plugin it loaded
    // until it restarts. What restarts or relinks always asks; `dev:voices`,
    // which relinks the hosts already linked to its tree, asks only there —
    // judged per command of the chain in the tree it runs in, and a script
    // by what it runs.
    name: "nothing restarts or relinks a deck host without Niklas's go",
    test: (c, ctx) => {
      const found = deckFindings(c, ctx.cwd, ctx, ctx.shell);
      if (!found.length) return null;
      return {
        ask: `${[...new Set(found)].join("; ")}. No deck host restarts, stops, starts or relinks without Niklas's go (#1520, #1526): confirm only once he has said go. Builds and installs need none.`,
      };
    },
  },
  {
    name: "gh issue create: no milestone or assignee at filing",
    test: (c) =>
      has(c, cmd(/gh\s+issue\s+create\b/)) &&
      has(c, /\s(--milestone|--assignee|-a)\b/) &&
      "An issue gets its milestone and assignee when implementation STARTS, never at filing (.claude/rules/issue-workflow.md).",
  },
  {
    name: "never rewrite the board's Status options",
    test: (c) =>
      has(c, /updateProjectV2Field/) &&
      "`updateProjectV2Field` replaces the option list and regenerates its ids, which clears every card's lane. Add a lane in the UI instead.",
  },
  {
    // #1574: the rules said a raw lane edit is refused, and nothing refused it.
    // The helpers spawn gh themselves, never through the Bash tool, so this
    // reaches only a command the model writes. A `gh project item-edit` counts
    // at command position, so a grep or a commit message that names one is no
    // edit. A GraphQL mutation counts wherever the command carries its name
    // once a `gh api` runs at command position anywhere in it (second read):
    // the query can reach gh through a `$( … )`, a variable, a here-string or
    // `--input -`, none of which are the api call's own arguments. A REST write
    // to a Projects v2 item (`…/projectsV2/…/items…` with a method other than
    // GET, or with fields, which make gh POST) counts by its own arguments.
    name: "board lanes and positions move only through the helpers",
    test: (c, ctx) => {
      const deny =
        "A card's lane or position moves only through the helpers in scripts/claude-hooks/lib.mjs, which never touch a Done card and refuse a backwards move — that one is Niklas's, in the board UI: from the repo root, `node -e \"import('./scripts/claude-hooks/lib.mjs').then(m=>console.log(m.setBoardStatus(<n>,'<lane>',process.cwd())))\"`, or `m.moveBoardItemAfter(<n>,<after or null>,process.cwd())` for its place in the lane.";
      if (has(c, cmd(/gh\s+project\s+item-edit\b/))) return deny;
      const apis = [...chainCommands(c, ctx.cwd, cmd(/gh\s+api\b/), ctx.shell)];
      if (!apis.length) return null;
      if (/\b(?:updateProjectV2Item(?:FieldValue|Position)|clearProjectV2ItemFieldValue)\b/.test(c)) return deny;
      return apis.some(({ args }) => restItemWrite(args)) ? deny : null;
    },
  },
  {
    name: "pnpm build --force does nothing",
    test: (c) =>
      has(c, cmd(/pnpm\s+(run\s+)?build\s+--force\b/)) &&
      "`pnpm build --force` forwards no argv (scripts/build.mjs); use `pnpm build:force`.",
  },
  {
    // `pipefail` counts only in live text ahead of the pipe — a `set -o pipefail`
    // earlier in the chain, not the word in a string or a comment (#1321 review).
    // `>&\d` is the only way past a `>&`, so `2>&1` has one parse: the old
    // `[^|&;\n]|\d?>&\d` had two for each, and backtracked exponentially on a
    // long run of them with no pipe at the end.
    name: "a piped pnpm build/test needs pipefail",
    bashOnly: true,
    test: (c) => {
      const m = matchAt(c, cmd(/pnpm\s+(run\s+)?(build|test|typecheck|lint|format)\b(?:[^|&;\n]|>&\d)*\|(?!\|)/));
      return (
        m &&
        !/pipefail/.test(trustedMask(c).slice(0, m.index)) &&
        "Piping `pnpm build/test/...` hides its exit code (you get tail's). Prefix `set -o pipefail;` or check the log before claiming green."
      );
    },
  },
  {
    name: "run vitest through the root script",
    // `pnpm --filter <pkg> test` is NOT refused: since #1021 every package with
    // tests runs them through `scripts/test-package.mjs`, which keeps the root
    // config and its native loader. A package without a `test` script is the
    // next rule's case.
    test: (c) =>
      has(c, cmd(/(pnpm\s+exec\s+|npx\s+)vitest\b/)) &&
      "Run tests as `pnpm test <path>` (or `pnpm --filter <pkg> test`): `pnpm exec vitest` and `npx vitest` drop the native config loader (.claude/rules/testing.md).",
  },
  {
    name: "pnpm --filter on a script the package does not have",
    test: (c, ctx) => {
      // Every filtered command in a chain, not just the first: since #1021 a
      // `pnpm --filter <pkg> test` passes, so it must not shield a later one.
      // Located in the trusted mask, read raw (#1321), so a mention is no command.
      for (const m of matchesAt(c, cmd(/pnpm\s+--filter\s+(@iracedeck\/[\w-]+)\s+(?:run\s+)?([\w:-]+)/))) {
        if (/^(add|remove|install|exec|dlx|update|why|list|ls)$/.test(m[2])) continue;
        const pkg = ctx.packages()[m[1]];
        if (!pkg) return `No workspace package named ${m[1]}.`;
        if (!pkg.scripts.includes(m[2]))
          return `${m[1]} has no "${m[2]}" script — pnpm --filter exits 0 and does nothing (scripts: ${pkg.scripts.join(", ") || "none"}).`;
      }
      return null;
    },
  },
  {
    name: "gh run list --commit needs the full sha",
    test: (c) => {
      const m = matchAt(c, cmd(/gh\s+run\s+list\b[^|&;]*--commit[= ]([0-9a-f]+)\b/));
      return (
        m &&
        m[1].length < 40 &&
        `\`gh run list --commit\` needs the FULL 40-char sha; a short one returns zero rows silently.`
      );
    },
  },
  {
    name: "jq is not installed",
    bashOnly: true,
    test: (c) =>
      has(c, cmd(/jq(\s|$)/)) &&
      "jq is not installed here and a jq pipeline fails silently (empty fields, exit 0). Parse `gh --json` with node or python (UTF-8).",
  },
  {
    name: "heredocs collapse doubled backslashes",
    bashOnly: true,
    test: (c) =>
      has(c, /<<-?\s*['"]?\w+/) &&
      has(c, /[A-Za-z]:\\\\/) &&
      "A doubled backslash collapses to one inside a heredoc, corrupting that Windows path. Write the file with the Write tool instead.",
  },
  {
    name: "IRACEDECK_MOCK=0 still mocks",
    bashOnly: true,
    test: (c) =>
      has(c, cmd(/IRACEDECK_MOCK=0\b/)) &&
      "`IRACEDECK_MOCK=0` still forces the mock (any non-empty value does). Use `IRACEDECK_REAL_NATIVE=1`.",
  },
  {
    // The arguments are read raw, since MSYS mangles a quoted path just the
    // same; the fix counts only in live text up to the `git show` it covers.
    name: "git show <ref/with/slash>:<dot-path> is mangled by MSYS",
    bashOnly: true,
    test: (c) =>
      [...matchesAt(c, cmd(/git\s+show\b([^|&;\n]*)/))].some(
        (m) =>
          /(?:^|\s)\S*\/\S*:\./.test(m[1]) && !/MSYS_NO_PATHCONV/.test(trustedMask(c).slice(0, m.index + m[0].length)),
      ) &&
      "Git Bash mangles `git show <ref-with-slash>:<.dot-path>`. Prefix `MSYS_NO_PATHCONV=1`, or use `git -C <tree> show HEAD:…`.",
  },
  {
    name: "git diff master..HEAD is the wrong question",
    test: (c) =>
      has(c, cmd(/git\s+(-C\s+\S+\s+)?diff\b[^|&;]*\s(origin\/)?master\.\.[^.\s]/)) &&
      "`git diff master..X` diffs the two tips and returns master's own commits inverted. Use `origin/master...HEAD` (three dots, from the merge base).",
  },
];

// ---------------------------------------------------------------------------

/** The words of one command in a chain: everything up to the next `&&`, `||`, `;` or `|`. */
function chainWords(text) {
  const out = [];
  for (const w of words(text)) {
    if (/^(&&|\|\||;|\|)$/.test(w)) break;
    const bare = w.replace(/;$/, "");
    if (bare) out.push(bare);
    if (bare !== w) break;
  }
  return out;
}

const asPath = (p) => p.replace(/\\/g, "/");

/**
 * What `git commit` would include, and where each file's bytes come from.
 *
 * `files`: an explicit `--only` pathspec, else what is staged plus what a
 * `git add` EARLIER IN THE SAME COMMAND stages — the hook runs before any of
 * the chain does, so those paths are not staged yet when it looks (`-a` folds
 * in the modified files too).
 *
 * `fromIndex`: the files a plain commit takes from the index AS IT STANDS NOW —
 * staged before this command and not re-added by it (#1193 review). Every other
 * file is committed from the working copy: a pathspec commit and `-a` take it
 * directly, and a chained `git add` puts it in the index first. A rule that
 * reads a file's bytes must read them from where they will be committed, or a
 * staged spec is judged on an edit made after it was staged.
 */
function commitSelection(command, ctx, dir) {
  // Tokenised, not a line regex: a quoted commit message spans lines, and the
  // `--` that follows it sits on the message's last line.
  const afterCommit = chainWords(command.slice(command.search(/\bcommit\b/)));
  const dash = afterCommit.indexOf("--");
  if (dash >= 0) return { files: afterCommit.slice(dash + 1).map(asPath), fromIndex: new Set() };
  const added = [...command.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?add\s+(.+)$/gm)].flatMap((m) =>
    addedFiles(chainWords(m[1]), ctx, dir),
  );
  const before = ctx.staged(dir);
  if (has(command, /\bcommit\b[^|&;]*\s(-a|--all|-am|-a[a-zA-Z]+)\b/))
    return { files: [...new Set([...before, ...added, ...ctx.modified(dir)])], fromIndex: new Set() };
  const reAdded = new Set(added);
  return { files: [...new Set([...before, ...added])], fromIndex: new Set(before.filter((f) => !reAdded.has(f))) };
}

/**
 * The files one `git add <args>` stages. An operand names a file OR a
 * directory, so each is matched against the files that differ from the index —
 * modified and untracked — as itself or as a prefix (#1193 review: a new spec
 * staged by `git add -A`, `git add .` or `git add docs/superpowers/specs/` used
 * to reach no rule at all). `.`, and `-A`/`--all`/`-u` with no operand, select
 * every candidate; `-u`/`--update` leaves untracked files out. An operand that
 * matches nothing is kept as written — a file already staged, a glob, a path
 * outside this model — which is exactly what the rules saw before.
 */
function addedFiles(args, ctx, dir) {
  const flags = args.filter((w) => w.startsWith("-"));
  const operands = args.filter((w) => !w.startsWith("-")).map(asPath);
  const updateOnly = flags.some((f) => /^(-u|--update)$/.test(f));
  const candidates = [...ctx.modified(dir), ...(updateOnly ? [] : (ctx.untracked?.(dir) ?? []))];
  if (!operands.length) return flags.some((f) => /^(-A|--all|-u|--update)$/.test(f)) ? candidates : [];
  return operands.flatMap((o) => {
    const p = o.replace(/^\.\//, "").replace(/\/+$/, "");
    if (p === "." || p === "") return candidates;
    const hits = candidates.filter((f) => f === p || f.startsWith(`${p}/`));
    return hits.length ? hits : [o];
  });
}

/**
 * The words of one command, from `from` (just past its verb) to the end of that
 * command, as `{ value, known }`. Found in the `flat` text, where every quote,
 * substitution, heredoc body and comment is blanked — so a multi-line
 * `-m "$(cat <<'EOF' … EOF)"` is ONE word and the `-- <paths>` after it are
 * still read — and each word's value taken from the raw text: a plain word
 * as written, a quoted one unquoted, one with a `$` or backtick outside single
 * quotes as `known: false` (its value is decided at run time), and heredoc bodies and comments
 * dropped as data. When the mask is not trusted the raw command is tokenised
 * instead, respecting simple quotes, as the older rules do.
 */
function argTokens(command, from) {
  const { text, flat, trusted } = view(command);
  if (!trusted) return chainWords(command.slice(from)).map((value) => ({ value, known: true }));
  // `2>&1` and `&>` are redirections, not a background `&`.
  const sep = /&&|\|\||[;|\n]|(?<![<>])&(?!>)/g;
  sep.lastIndex = from;
  const end = sep.exec(flat)?.index ?? command.length;
  const out = [];
  for (const m of flat.slice(from, end).matchAll(/\S+/g)) {
    const a = from + m.index;
    const raw = command.slice(a, a + m[0].length);
    const masked = text.slice(a, a + m[0].length);
    // A `$` or backtick outside single quotes expands at run time: `"$P"`, `$(…)`, `${x}`.
    const expands = /[$`]/.test(raw.replace(/'[^']*'/g, ""));
    if (m[0] !== raw && /^_+$/.test(masked)) continue;
    if (expands) out.push({ value: raw, known: false });
    else if (m[0] === raw) out.push({ value: raw, known: true });
    else out.push({ value: raw.replace(/\\(.)/g, "$1").replace(/["']/g, ""), known: true });
  }
  return out;
}

/** `git commit` options whose value is the NEXT word when not attached; `-S` and `-u` only ever take one attached. */
const COMMIT_VALUE_SHORT = "mFCct";
const COMMIT_ATTACHED_SHORT = "Su";
const COMMIT_VALUE_LONG = new Set([
  "--message",
  "--file",
  "--reuse-message",
  "--reedit-message",
  "--fixup",
  "--squash",
  "--author",
  "--date",
  "--template",
  "--cleanup",
  "--trailer",
  "--pathspec-from-file",
]);

/** A redirection operator standing alone, whose target is the next word. */
const BARE_REDIRECT = /^\d*(?:<<-?|<<<|<>|<&|>&|>>|>\||&>>?|<|>)$/;

/** `git push` options whose value is the next word when not attached with `=`. */
const PUSH_VALUE = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);

/**
 * Whether a `git push` with these words would push the integration branch
 * (#1520): a refspec naming it on either side (`+`, `refs/heads/` allowed),
 * `--all` / `--mirror` / `--branches` (every local branch, and refs are shared
 * by all worktrees), or a push of the current branch — no refspec, or `HEAD` /
 * `@` — when `fromIntegration()` says that branch is it. `--dry-run` pushes
 * nothing. The first positional word is the remote.
 */
function pushReachesIntegration(tokens, fromIntegration) {
  const positional = [];
  let every = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (BARE_REDIRECT.test(t) || PUSH_VALUE.has(t)) i++;
    else if (/^\d*(?:[<>]|&>)/.test(t)) continue;
    else if (t === "--dry-run" || t === "-n") return false;
    else if (/^--(?:all|mirror|branches)$/.test(t)) every = true;
    else if (!t.startsWith("-")) positional.push(t);
  }
  if (every) return true;
  const refspecs = positional.slice(1);
  if (!refspecs.length) return fromIntegration();
  // `refs/heads/x`, `heads/x` and `x` are one branch to git. A glob pushes
  // every branch it matches, and a revision suffix (`~0`, `^0`, `@{0}`,
  // `^{commit}`) still names the branch's commit.
  const name = (r) =>
    r
      .replace(/^\+/, "")
      .replace(/^refs\//, "")
      .replace(/^heads\//, "");
  const names = (n, branch) =>
    n.includes("*")
      ? new RegExp(`^${n.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(branch)
      : new RegExp(`^${branch}(?:[~^@].*)?$`).test(n);
  return refspecs.some((r) => {
    const colon = r.indexOf(":");
    const src = name(colon >= 0 ? r.slice(0, colon) : r);
    const dst = colon >= 0 ? name(r.slice(colon + 1)) : undefined;
    if (names(src, INTEGRATION_BRANCH) || (dst !== undefined && names(dst, INTEGRATION_BRANCH))) return true;
    return /^(?:HEAD|@)(?:[~^@].*)?$/.test(src) && fromIntegration();
  });
}

/**
 * A git command's words split into options and pathspec operands: `long` and
 * `short` hold the option names seen (a short cluster's letters one by one),
 * an option's value is skipped, redirections and their targets are skipped,
 * and every word after `--` is an operand. `unknown` is set when a word that is
 * not an option's value carries a substitution — it could be anything.
 */
function gitArgs(tokens, valueShort = "", attachedShort = "", valueLong = new Set()) {
  const res = { long: new Set(), short: new Set(), operands: [], unknown: false };
  for (let i = 0; i < tokens.length; i++) {
    const { value: w, known } = tokens[i];
    // An option is still read by its name; only its attached value is unknown.
    if (!known && !w.startsWith("-")) {
      res.unknown = true;
      continue;
    }
    if (/^(?:\d*[<>]|&>)/.test(w)) {
      if (BARE_REDIRECT.test(w)) i++;
    } else if (w === "--") {
      res.operands.push(...tokens.slice(i + 1));
      break;
    } else if (w.startsWith("--")) {
      const name = w.split("=")[0];
      res.long.add(name);
      if (!w.includes("=") && valueLong.has(name)) i++;
    } else if (/^-[^-]/.test(w)) {
      for (let k = 1; k < w.length; k++) {
        res.short.add(w[k]);
        if (attachedShort.includes(w[k])) break;
        if (valueShort.includes(w[k])) {
          if (k === w.length - 1) i++;
          break;
        }
      }
    } else res.operands.push(tokens[i]);
  }
  if (res.operands.some((t) => !t.known)) res.unknown = true;
  return res;
}

/**
 * Whether a pathspec operand, relative to the command's cwd `dir`, selects
 * the repo-relative `target`: as itself, as a directory above it, or as the
 * whole tree. A glob or a `:(magic)` pathspec is taken to select it — the hook
 * does not evaluate those, and erring that way only costs a deny when the
 * target would really carry something to deny.
 */
function pathspecCovers(token, target, ctx, dir) {
  if (!token.known) return true;
  const op = token.value;
  if (/[*?[]/.test(op) || op.startsWith(":")) return true;
  const top = ctx.toplevel?.(dir);
  const rel = asPath(top ? path.relative(top, resolveDir(dir, op, { shell: ctx.shell })) : op)
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (rel === "" || rel === ".") return true;
  if (rel.startsWith("../")) return false;
  return target === rel || target.startsWith(`${rel}/`);
}

const GIT_ADD = cmd(/git\s+(?:-C\s+\S+\s+)?add\b/);

/**
 * Where the `git commit` matched as `commit` takes the Elgato manifest's bytes
 * from: `[]` when it does not commit the manifest at all, `["index"]` for the
 * staged copy, `["worktree"]` for the working copy, both when it cannot tell.
 *
 * - A pathspec (`git commit [--only] [--] <paths>`) commits those paths from
 *   the WORKING copy; a staged manifest outside it is left out, unless
 *   `-i`/`--include` adds the staged files too.
 * - `-a`/`--all` commits every tracked file from the working copy.
 * - A `git add` chained ahead of the commit that selects the manifest stages
 *   the working copy before the commit runs (the hook runs before both).
 * - Otherwise a plain commit takes the INDEX, and only when the manifest is
 *   staged — so a manifest dirty with the key but not staged passes.
 * - A substitution standing where an option or a path could be, and
 *   `--pathspec-from-file`, leave the selection unknown: both copies are read.
 */
function manifestSources(command, commit, ctx, dir) {
  // GIT_COMMIT and GIT_ADD both end on their verb, so a match ends where the verb does.
  const args = gitArgs(
    argTokens(command, commit.index + commit[0].length),
    COMMIT_VALUE_SHORT,
    COMMIT_ATTACHED_SHORT,
    COMMIT_VALUE_LONG,
  );
  if (args.unknown || args.long.has("--pathspec-from-file")) return ["index", "worktree"];
  const covers = (t) => pathspecCovers(t, ELGATO_MANIFEST, ctx, dir);
  if (args.operands.length) {
    if (args.operands.some(covers)) return ["worktree"];
    if (!(args.short.has("i") || args.long.has("--include"))) return [];
  } else if (args.short.has("a") || args.long.has("--all")) return ["worktree"];
  const added = [...matchesAt(command, GIT_ADD)]
    .filter((m) => m.index < commit.index)
    .some((m) => {
      const a = gitArgs(argTokens(command, m.index + m[0].length));
      if (a.unknown || a.long.has("--pathspec-from-file")) return true;
      if (a.operands.length) return a.operands.some(covers);
      return (
        ["A", "u", "p", "i", "e"].some((f) => a.short.has(f)) ||
        ["--all", "--update", "--patch", "--interactive", "--edit"].some((f) => a.long.has(f))
      );
    });
  if (added) return ["worktree"];
  return ctx.staged(dir).includes(ELGATO_MANIFEST) ? ["index"] : [];
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

/**
 * Runs the rules. The first DENY wins at once; the first ask is held until
 * every rule has had its turn, so a deny anywhere beats an ask anywhere,
 * whatever order the two rules sit in. One chained command can match both — a
 * spec-less `git worktree add … && <a denied shape>` used to surface only the
 * ask, and confirming it ran the command the deny exists to stop (#1193
 * review; the tag-push ask had the same gap). Order still picks which of two
 * denies, or which of two asks, is the one reported.
 *
 * A PowerShell command (`ctx.shell`, #1520) is read through
 * `powershellAsBash` in `shell-lexer.mjs` and skips the `bashOnly` rules — the traps that
 * describe bash syntax, which in PowerShell would only misfire.
 */
export function checkBash(command, ctx) {
  const powershell = ctx.shell === POWERSHELL;
  const text = powershell ? powershellAsBash(command) : command;
  const asks = [];
  for (const rule of rules) {
    if (powershell && rule.bashOnly) continue;
    const v = rule.test(text, ctx);
    if (!v) continue;
    if (typeof v === "string") return v;
    asks.push(v.ask);
  }
  // Every ask in one prompt: a chain the maintainer approves runs whole, so a
  // later ask hidden behind an earlier one would run unseen (#1307 review).
  return asks.length ? { ask: asks.join("\n\n") } : null;
}
