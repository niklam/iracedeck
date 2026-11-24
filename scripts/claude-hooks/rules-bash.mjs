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
import { INTEGRATION_BRANCH, INTEGRATION_TREE, MAIN_BRANCH, SPEC_DIR } from "./lib.mjs";
import { mergeGateVerdict } from "./merge-gate.mjs";
import { findControlByte } from "./rules-tools.mjs";
import { deckFindings } from "./script-runs.mjs";
import {
  BASH,
  CHAIN_AND_BACKGROUND,
  chainCommands,
  cmd,
  commandEnd,
  excuseDecodedHit,
  GIT_GLOBALS,
  gitPlace,
  gitPlaceAt,
  has,
  maskInert,
  matchAt,
  matchesAt,
  plainValue,
  POWERSHELL,
  powershellAsBash,
  programStart,
  ranges,
  readsCurlyTwice,
  refusedForms,
  resolveDir,
  respelledPrograms,
  segmentTokens,
  straightQuotes,
  stringBounds,
  stringEnd,
  takeDecodedHits,
  trustedIn,
  trustedMask,
  unclosedLead,
  unreadablePrograms,
  unsettled,
  view,
  words,
} from "./shell-lexer.mjs";
import { missingSpecParts, specExistsFor } from "./spec-sections.mjs";

const TITLE_RE = /^(feat|fix|improve|perf|refactor|docs|ci|chore|test|build|style|revert)(\([^)]+\))?!?: .+ \(#\d+\)$/;

// ---------------------------------------------------------------------------

/**
 * A git command with verb `verb` (a regex source) at command position, read
 * through every global option git takes ahead of it (`GIT_GLOBALS` in
 * `shell-lexer.mjs`, #1606). Every git trap is built here, so none hand-rolls
 * its own prefix again.
 */
const gitVerb = (verb) => cmd(new RegExp(`git${GIT_GLOBALS}${verb}`));

/**
 * The deny for a git command whose repository, work tree or index is named
 * apart from the directory it runs in (`--git-dir`, `--work-tree`,
 * `core.worktree`, `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`; `gitPlaceAt` in `shell-lexer.mjs`), from a rule that reads
 * that repository's branch, index or files (#1606): the hook asks git in the
 * directory, so it would judge another repository than the one the command
 * acts on.
 */
const movedRepo = (verb) =>
  `This \`git ${verb}\` names its repository, work tree or index apart from its directory (--git-dir, --work-tree, core.worktree, GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE or GIT_INDEX_FILE), or through a \`-C\` that expands, so the hook cannot tell which branch, index and files it acts on. Run it as \`git -C <dir> ${verb} …\` with the directory written out, in the tree itself instead (#1606).`;

/**
 * The refusal of a git command whose directory a `cd` ahead of it leaves
 * unknown (#1646, CodeRabbit on PR #1788): its branch, index and files are
 * those of a checkout the hook cannot name.
 */
const lostDir = (verb) =>
  `A \`cd\` ahead of this \`git ${verb}\` may not run, runs in a pipeline's last stage, expands or runs under \`eval\`, so the hook cannot tell which checkout it acts on. Write the directory out: a plain \`cd <dir> &&\` ahead of it, or \`git -C <dir> ${verb} …\` (#1646).`;

/** The git shapes whose rules read a `-C`; exported so the post-hook scopes the same way. */
export const GIT_PUSH = gitVerb(String.raw`push\b`);
export const GIT_COMMIT = gitVerb(String.raw`commit\b`);
export const GIT_WORKTREE_ADD = gitVerb(String.raw`worktree\s+add\b(.*)$`);
export const GIT_WORKTREE_REMOVE = gitVerb(String.raw`worktree\s+remove\b(.*)$`);

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

/** The deny of the piped-pnpm rule. */
const PIPED_PNPM =
  "Piping `pnpm build/test/...` hides its exit code (you get tail's). Prefix `set -o pipefail;` or check the log before claiming green.";
/** `s` with its quoted text and its comments blanked: what its shell runs as code ({@link pipedPnpm}). */
function liveText(s) {
  return maskInert(s).masked.replace(/(^|[\s;&|()])#[^\n]*/g, "$1");
}

/** The pnpm commands whose exit code a pipe hides ({@link pipedPnpm}). */
const PIPED_PNPM_RE = cmd(/pnpm\s+(?:run\s+)?(?:build|test|typecheck|lint|format)\b/);

/**
 * Whether the pnpm `m` matched ({@link PIPED_PNPM_RE}) has its exit code
 * hidden by a pipe no `pipefail` covers, in `c` and its trusted text `text`,
 * `piped` saying whether a text starts with such a pipe. The pipe that hides
 * it is the one after the pnpm in its own command, or, inside a string a shell
 * runs, the one after the string's close that pipes that shell on. A pnpm its
 * shell reads differently from the text here (`decoded`, #1646) is judged on
 * what it reads: the separator that ends it there, and a `pipefail` the
 * shell that owns the pipe sets — in its own text ahead of it, live, or as
 * its own option (`before`; an ancestor's excuses nothing, CodeRabbit on PR
 * #1788).
 */
function pipedPnpm(c, text, m, piped) {
  const end = m.index + m[0].length;
  const string = stringBounds(c, m.program);
  const decoded = m.decoded !== undefined;
  if (!string)
    return !/pipefail/.test(text.slice(0, m.index)) && (decoded ? /^\|(?!\|)/.test(m.sep) : piped(text.slice(end)));
  const [open, close] = string;
  // Where the command that runs the shell starts: after the last operator ahead of the string.
  const from = text.slice(0, open).search(/[^\n;&|()\x60]*$/);
  // The shell's own `-o pipefail`, alone or ending a cluster (`-eo pipefail`);
  // a `+o pipefail` turns it off, so it excuses nothing (#1634).
  const option = (s) => /(?<!\S)-[A-Za-z]*o\s+pipefail\b/.test(s);
  let inner;
  if (decoded) {
    // The owning level's own text, and the word handing it its string: in the
    // level holding it, or in the typed text for the outermost string.
    const lines = m.before ?? [];
    const parent = lines.at(-2)?.text;
    const handing = parent === undefined ? text.slice(from, open) : parent.slice(parent.search(/[^\n;&|()\x60]*$/));
    inner = /\bpipefail\b/.test(liveText(lines.at(-1)?.text ?? "")) || option(handing);
  } else inner = /pipefail/.test(text.slice(open, m.index)) || option(text.slice(from, open));
  if (!inner && (decoded ? /^\|(?!\|)/.test(m.sep) : piped(text.slice(end, close)))) return true;
  if (/pipefail/.test(text.slice(0, from))) return false;
  const after = /^(?:>&\d|&>|[^;&\n])*/.exec(text.slice(close + 1))[0];
  const pipes = (after.match(/(?<!\|)\|(?!\|)/g) ?? []).length;
  return pipes > 0;
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
 * is at the top level of its own. Where the mask does not stand over the edit
 * (`trustedIn`, #1607) the raw words are read, as everywhere else. `namesMilestone` says whether a milestone flag
 * appears anywhere in the edit's raw text, for one the hook could not read
 * whole: the caller then says to move its cards by hand rather than nothing.
 */
export function* issueEdits(command, cwd, shell = BASH) {
  const { text } = view(command);
  for (const { base, head, at } of chainCommands(command, cwd, GH_ISSUE_EDIT, shell)) {
    const start = at - head.length;
    // Live backticks ahead of it: an odd count means it runs inside a backtick substitution.
    const inTick = (text.slice(0, start).match(/\x60/g)?.length ?? 0) % 2 === 1;
    const end = commandEnd(text, at, inTick);
    const raw = command.slice(start, end);
    const own = maskInert(raw);
    const lexed = trustedIn(command, start, end) && own.sure;
    const edit = parseIssueEdit({ raw, flat: lexed ? own.flat : raw, trusted: lexed });
    yield { ...edit, namesMilestone: MILESTONE_FLAG.test(raw), base, start };
  }
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
    occurrence: true,
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
    // Each push is found as every guard finds its command (`matchesAt`, #1634:
    // `sudo git push --tags` and `bash <<< 'git push --tags'` included), then
    // judged on its own text alone: from its program word to its string's close
    // or its chain segment's end, less a comment — so a `--dry-run` that is
    // bash's `$0` after the string, or sits in a comment, excuses nothing, and a
    // tag there is none (#1634 second read).
    name: "git push: a tag cuts a release",
    test: (c) => {
      const text = trustedMask(c);
      const segments = ranges(text, CHAIN_AND_BACKGROUND);
      // Every push is judged, so each one read as its shell reads it is excused
      // only once judged, never left behind an earlier tag (CodeRabbit CLI on #1646).
      const pushes = [...matchesAt(c, GIT_PUSH)].map((m) => {
        // The segment holding the program word: an anchored match's `index` is its boundary.
        const [, b] = segments.find(([s, e]) => s <= m.program && m.program < e);
        // From the raw word's start, not its rewritten name's: `"git" push` begins at the quote (CodeRabbit on #1634).
        // A push its shell reads differently from the text here is judged as it reads it (#1646).
        const own = m.decoded ?? c.slice(programStart(c, m.program), Math.min(b, stringEnd(c, m.program) ?? b));
        // Its inert text blanked, a comment included, which the raw text of a fed span keeps.
        // The comment starts at the `#` the lexer's top-level text blanks to a space: a quoted
        // `#` is `_` there (`git -c 'user.name=CI #1' push …`), never a comment (CodeRabbit CLI on #1634).
        const { masked: code, top } = maskInert(own);
        let comment = -1;
        for (let i = 0; i < own.length && comment < 0; i++) if (own[i] === "#" && top[i] === " ") comment = i;
        const live = comment < 0 ? own : own.slice(0, comment);
        const tag = !/--dry-run\b/.test(code) && /\bpush(?:\s[^|&;]*)?\s["']?(--tags\b|v\d+\.\d+)/.test(live);
        if (m.decoded !== undefined) excuseDecodedHit(c, GIT_PUSH, m.occurrence);
        return tag;
      });
      return pushes.some(Boolean) && { ask: "Pushing a tag cuts a release. The maintainer confirms." };
    },
  },
  {
    // #1520: `integration` is origin/master plus the branches under manual
    // test, reset and re-merged by every combined build — a local branch
    // nobody else should ever see. Each push of a chain is judged in the tree
    // it runs in, so `cd ../ir-integration && git push` is caught.
    name: "git push: the integration branch is never pushed",
    test: (c, ctx) => {
      for (const { base, start, args, occurrence, decoded, lost } of chainCommands(c, ctx.cwd, GIT_PUSH, ctx.shell)) {
        // Every `-C`, in order (#1606). The push reads the current branch only
        // when no refspec names one, and only then does a `--git-dir` or
        // `GIT_DIR`, which hides whose branch that is, refuse it.
        const { dir, movesRepo } = gitPlaceAt(c, start, base, ctx.shell);
        // A push its shell reads differently from the text here is judged on
        // what it reads (#1646): its refspecs past the verb the rule's own
        // shape matched there, git's global options and their values skipped
        // as `GIT_GLOBALS` reads them (`git -c 'x.push=integration' push
        // origin main` names no `integration`), and, apart from that, a `-C`,
        // `--git-dir` or `--work-tree` among those options as moving the
        // repository. A shape it cannot place is judged as moving it.
        let read = args;
        // A `cd` ahead of it in its string that cannot be known leaves its tree unknown too (#1646).
        let moved = movesRepo || Boolean(lost);
        if (decoded !== undefined) {
          const verb = new RegExp(GIT_PUSH.inner.source, "y").exec(decoded);
          read = verb ? decoded.slice(verb[0].length) : "";
          moved ||= !verb || /(?:^|\s)(?:-C|--git-dir|--work-tree)(?=[\s=]|$)/.test(verb[0]);
        }
        let unknown = false;
        const fromIntegration = () =>
          moved
            ? (unknown = true)
            : ctx.branch(dir) === INTEGRATION_BRANCH || path.basename(ctx.toplevel?.(dir) ?? dir) === INTEGRATION_TREE;
        if (pushReachesIntegration(words(read), fromIntegration))
          return unknown
            ? movedRepo("push")
            : `The \`${INTEGRATION_BRANCH}\` branch is local and never pushed: it is origin/${MAIN_BRANCH} plus the branches under manual test, rebuilt by scripts/integration-build.mjs (#1520). Push each issue branch from its own ../ir-<issue> tree.`;
        // Judged as its shell reads it: its decoded hit is excused only now.
        if (decoded !== undefined) excuseDecodedHit(c, GIT_PUSH, occurrence);
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
    test: (c, ctx) => mergeGateVerdict(c, ctx),
  },
  {
    name: "git commit: specs go to master only, with their sections and no control bytes; a dirty lockfile rides with its package.json",
    test: (c, ctx) => {
      if (!has(c, GIT_COMMIT)) return null;
      // Every commit at command position, each in the tree its own `cd`s and
      // `-C` land in, so a harmless first commit cannot shield a later one (#1594).
      for (const commit of chainCommands(c, ctx.cwd, GIT_COMMIT, ctx.shell)) {
        // Every `-C`, in order; a repository or work tree named apart from the
        // directory leaves the branch, the index and the files unknown (#1606).
        // A `cd` ahead of it the hook cannot follow leaves the checkout unknown: refused before any read (#1646).
        if (commit.lost) return lostDir("commit");
        const { dir, movesRepo, movesTree, movesIndex } = gitPlaceAt(c, commit.start, commit.base, ctx.shell);
        if (movesRepo || movesTree || movesIndex) return movedRepo("commit");
        // A `git add` ahead of it that stages into a moved repository, tree or
        // index stages what the hook cannot read (#1606 second read).
        if (addsAhead(c, commit, ctx).some((a) => a.moved)) return movedRepo("add");
        const branch = ctx.branch(dir);
        const selection = commitSelection(c, commit, ctx, dir);
        const committed = [...selection.keys()];
        const specs = committed.filter((f) => f.startsWith(SPEC_DIR));
        if (branch && branch !== MAIN_BRANCH && specs.length)
          return `A spec commits to ${MAIN_BRANCH} as its own docs(specs) commit, never on a feature branch (${specs.join(", ")} on ${branch}). See .claude/rules/specs-and-plans.md.`;
        // The commit is where a spec's bytes are knowable and its author is still
        // holding it. Two things pass on purpose (#1193): a spec ALREADY in HEAD,
        // because the requirement is forward-only like #621's naming convention
        // and `specs-and-plans.md` protects editing a spec freely before it ships
        // — 30 of the 64 post-policy specs were amended, and none of those edits
        // is the moment to demand a section the spec was never asked for; and
        // text the hook cannot read, because a spec is never blocked over bytes
        // the hook failed to find. The bytes are read from where the commit will
        // take them — the index, the working copy, or both when the selection
        // cannot be read, per `commitSelection`.
        //
        // The control-byte check is the exception to forward-only: it covers an
        // amendment too. A push that changes only specs starts no CI run (#1466),
        // so `scripts/no-control-bytes.test.mjs` no longer sees a spec until the
        // next code push, and the commit is the last place it is caught in time.
        for (const f of specs)
          for (const from of selection.get(f)) {
            const text = ctx.committedText?.(dir, f, from);
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
                `${f} is missing ${missing.join(" and ")}. A spec carries the header block, an Out of scope section and a Testing/Verification section — each a heading below the title that IS the section's name (\`## Testing\`, \`## 5. Out of scope\`), not a title or heading that mentions it. See .claude/rules/specs-and-plans.md.`,
              );
            if (problems.length) return problems.join(" ");
          }
        if (
          committed.some((f) => /(^|\/)package\.json$/.test(f)) &&
          !committed.includes("pnpm-lock.yaml") &&
          ctx.modified(dir).includes("pnpm-lock.yaml")
        )
          return "pnpm-lock.yaml is modified but not in this commit while a package.json is. Stage the lockfile too — local builds pass via hoisting, CI's --frozen-lockfile fails every job at once.";
      }
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
      // Each commit in the tree its own `cd`s and `-C` land in, as for the spec rule (#1594 review).
      for (const commit of chainCommands(c, ctx.cwd, GIT_COMMIT, ctx.shell)) {
        // A `cd` ahead of it the hook cannot follow leaves the checkout unknown: refused before any read (#1646).
        if (commit.lost) return lostDir("commit");
        const { dir, movesRepo, movesTree, movesIndex } = gitPlaceAt(c, commit.start, commit.base, ctx.shell);
        if (movesRepo || movesTree || movesIndex) return movedRepo("commit");
        // A `git add` ahead of it that stages into a moved repository, tree or
        // index stages what the hook cannot read (#1606 second read).
        if (addsAhead(c, commit, ctx).some((a) => a.moved)) return movedRepo("add");
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
      // The repository the tree joins decides where it belongs (#1606).
      const { dir, movesRepo } = gitPlace(c, ctx.cwd, GIT_WORKTREE_ADD, ctx.shell);
      if (movesRepo) return movedRepo("worktree add");
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
      const place = gitPlace(c, ctx.cwd, GIT_WORKTREE_REMOVE, ctx.shell);
      const resolved = resolveDir(place.dir, target, { shell: ctx.shell });
      const links = ctx.linkTargets().filter((l) => l.target);
      // A `cd` ahead of it the hook cannot follow leaves a relative target unknown (#1646).
      if (place.lost && !path.isAbsolute(target) && links.length)
        return `A \`cd\` ahead of this \`git worktree remove\` may or may not run, or runs in a pipeline's last stage, so the hook cannot tell which tree \`${target}\` names while a deck host is linked. Run the remove on its own, with a plain \`cd <dir> &&\` ahead of it at most.`;
      const held = links.filter((l) => ctx.isInside(l.target, resolved));
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
    // until it restarts. #1737 took restarts, stops and starts out of the
    // ask: the hook never sees the conversation, so a prompt after Niklas had
    // said "restart Stream Deck" only asked him twice. That rule is now prose
    // the agent keeps. What links, unlinks or relinks a host still asks, and
    // so does a restart run over and over — by a rollup watch hook, `turbo
    // watch`, `watch` or a `while` / `until` loop (#1737 review), since his go
    // for one restart is no go for a host restarted under him until someone
    // stops it; `dev:voices`, which relinks the
    // hosts already linked to its tree, asks only there — judged per command
    // of the chain in the tree it runs in, and a script by what it runs
    // (`deckFindings` in `script-runs.mjs`, whose findings carry their kind).
    // The prompt names a chain's restarts beside what asks, since confirming
    // it runs the whole chain.
    name: "nothing relinks a deck host without Niklas's go",
    test: (c, ctx) => {
      const found = deckFindings(c, ctx.cwd, ctx, ctx.shell);
      // One that relinks only in a linked tree, run where a `cd` ahead of it
      // leaves the tree unknown, is refused, as a lost command is elsewhere (#1646).
      const lost = found.find((f) => f.kind === "lost");
      if (lost)
        return `${lost.text}: it relinks the hosts linked to that tree, and the hook cannot tell which tree it is (a \`cd\` that may not run, sits in a pipeline's last stage, expands, or runs under \`eval\`). Run the \`cd\` as a plain \`cd <dir> &&\` ahead of it.`;
      if (found.every((f) => f.kind === "restart")) return null;
      return {
        ask: `${[...new Set(found.map((f) => f.text))].join("; ")}. No deck host is relinked, linked or unlinked, nor restarted over and over by a watch or a loop, without Niklas's go (#1520, #1737): confirm only once he has said go. A restart, stop or start asks no prompt: it waits for his go in the conversation. Builds and installs need none.`,
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
    occurrence: true,
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
    // long run of them with no pipe at the end. The pipe that hides the exit is
    // the one after the pnpm in its own command — inside the string a shell runs
    // it from, `bash -c 'pnpm test | tee x'` — or, for a pnpm inside such a
    // string, the one after the string's close, which pipes the shell on (`sh -c
    // 'pnpm test' | tail`) (#1634 review). A script a shell reads on stdin is
    // refused before any rule (#1659).
    // A pipefail excuses only the shell that has it (#1634 second read): a pipe
    // inside the string is the inner shell's, excused by a `set -o pipefail`
    // inside that string ahead of the pnpm or by the shell's own `-o pipefail`
    // option, never by one in the outer text, which a child bash does not
    // inherit; a pipe after the string is the outer shell's, excused only by a
    // pipefail in the outer text ahead of the shell's command.
    name: "a piped pnpm build/test needs pipefail",
    bashOnly: true,
    test: (c) => {
      const text = trustedMask(c);
      // A redirect's `>&1` or `&>` ahead of the plain characters, so a greedy
      // run with nothing after it takes the whole redirect rather than stopping
      // at its `&`.
      const piped = (s) => /^(?:>&\d|&>|[^|&;\n])*\|(?!\|)/.test(s);
      for (const m of matchesAt(c, PIPED_PNPM_RE)) {
        if (pipedPnpm(c, text, m, piped)) return PIPED_PNPM;
        // A pnpm its shell reads differently from the text here was judged on
        // what that shell reads: its decoded hit is excused (#1646).
        if (m.decoded !== undefined) excuseDecodedHit(c, PIPED_PNPM_RE, m.occurrence);
      }
      return null;
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
    occurrence: true,
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
      [...matchesAt(c, gitVerb(String.raw`show\b([^|&;\n]*)`))].some(
        (m) =>
          /(?:^|\s)\S*\/\S*:\./.test(m[1]) && !/MSYS_NO_PATHCONV/.test(trustedMask(c).slice(0, m.index + m[0].length)),
      ) &&
      "Git Bash mangles `git show <ref-with-slash>:<.dot-path>`. Prefix `MSYS_NO_PATHCONV=1`, or use `git -C <tree> show HEAD:…`.",
  },
  {
    name: "git diff master..HEAD is the wrong question",
    test: (c) =>
      has(c, gitVerb(String.raw`diff\b[^|&;]*\s(origin\/)?master\.\.[^.\s]`)) &&
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
 * What the `git commit` matched as `commit` (a {@link chainCommands} result,
 * judged in `dir`) would record, and where each file's bytes come from: a Map
 * from each repo-relative file to the copies a rule must read — `["index"]`,
 * `["worktree"]`, or both when the hook cannot tell which.
 *
 * The commit's words are read at the commit itself, located in the trusted mask
 * and taken raw at that index ({@link argTokens}, {@link gitArgs}), as
 * {@link manifestSources} does. The selection used to be read off the raw
 * command: the first mention of `commit` anywhere — an echo, a quoted string,
 * the message — picked the arguments, and a quoted `-a` or `git add` counted,
 * so `echo "commit -- notes.md" && git commit -m x` committed a staged spec on
 * a feature branch unjudged (#1594).
 *
 * - Operands, with or without `--` (git takes `git commit <path>` as a pathspec
 *   too), commit those paths from the WORKING copy; a directory operand selects
 *   every staged, modified or untracked file under it ({@link pathspecFiles}).
 *   `-i`/`--include` adds what a plain commit takes, from where it takes it.
 * - `-a`/`--all`, read as a parsed flag (`-am`, `-qa`, `-a -m`), commits what is
 *   staged, added and modified, from the working copy.
 * - Otherwise what is staged plus what a `git add` chained AHEAD of this commit
 *   stages — the hook runs before any of the chain does, so those paths are not
 *   staged yet when it looks. A file staged before the command and not re-added
 *   by it is committed from the index AS IT STANDS NOW (#1193 review), every
 *   other from the working copy, which the chained add puts in the index first.
 *   An add after the commit, or one only quoted or echoed, stages nothing for it.
 * - A substitution where an option or a path could be, or
 *   `--pathspec-from-file`, on the commit or on an add ahead of it, leaves the
 *   selection unreadable: every staged, added, modified and untracked file is
 *   taken, each from both copies, so a spec is denied when either copy fails.
 *
 * A rule that reads a file's bytes must read them from where they will be
 * committed, or a staged spec is judged on an edit made after it was staged.
 */
function commitSelection(command, commit, ctx, dir) {
  const args = commitArgs(command, commit);
  const adds = addsAhead(command, commit, ctx);
  const unreadable = (a) => a.unknown || a.long.has("--pathspec-from-file");
  const staged = ctx.staged(dir);
  const added = adds.filter((a) => !unreadable(a.args)).flatMap((a) => addedFiles(a.args, ctx, a.dir));
  const selection = new Map();
  const take = (files, from) => {
    for (const f of files) selection.set(f, from);
  };
  if (unreadable(args) || adds.some((a) => unreadable(a.args))) {
    take([...staged, ...added, ...ctx.modified(dir), ...(ctx.untracked?.(dir) ?? [])], ["index", "worktree"]);
    return selection;
  }
  const plain = () => {
    const fromIndex = new Set(staged.filter((f) => !added.includes(f)));
    for (const f of new Set([...staged, ...added])) selection.set(f, fromIndex.has(f) ? ["index"] : ["worktree"]);
  };
  if (args.operands.length) {
    if (args.short.has("i") || args.long.has("--include")) plain();
    const candidates = [...new Set([...staged, ...ctx.modified(dir), ...(ctx.untracked?.(dir) ?? [])])];
    take(
      args.operands.flatMap((t) => pathspecFiles(t, candidates, ctx, dir)),
      ["worktree"],
    );
  } else if (args.short.has("a") || args.long.has("--all"))
    take([...staged, ...added, ...ctx.modified(dir)], ["worktree"]);
  else plain();
  return selection;
}

/** The words of the `git commit` matched as `commit` (a {@link chainCommands} result), parsed by {@link gitArgs}. */
const commitArgs = (command, commit) => gitArgs(argTokens(command, commit.at), COMMIT_OPTIONS);

/**
 * Every `git add` at command position chained AHEAD of the `git commit` matched
 * as `commit`, as `{ args, dir, moved }`: its words parsed by {@link gitArgs}, the
 * directory it runs in — the session cwd moved by the `cd`s ahead of it and its
 * own `-C`, as for the commit. An operand is resolved in the add's own directory
 * (#1594 review: `cd docs && git add superpowers/specs/x.md && cd .. && git commit`
 * read it against the commit's, and missed the spec). `staged`, `modified` and
 * `untracked` are repo-root-relative, so an add in the same repository yields
 * paths the commit's lists compare with; one in another repository can only
 * over-match, which errs to deny. An add after the commit, or one only quoted
 * or echoed, is none. `moved` is set when the add names its repository, work
 * tree or index apart from its directory (`gitPlaceAt` in `shell-lexer.mjs`):
 * it then stages what the hook cannot read, and the commit rules refuse it
 * (#1606 second read). Shared by {@link commitSelection}, {@link
 * manifestSources} and the commit rules.
 */
function addsAhead(command, commit, ctx) {
  return [...chainCommands(command, ctx.cwd, GIT_ADD, ctx.shell)]
    .filter((add) => add.at < commit.at)
    .map((add) => {
      const place = gitPlaceAt(command, add.start, add.base, ctx.shell, add.at);
      return {
        args: gitArgs(argTokens(command, add.at), ADD_OPTIONS),
        dir: place.dir,
        moved: place.movesRepo || place.movesTree || place.movesIndex || Boolean(add.lost),
      };
    });
}

/**
 * The files one `git add` (its words parsed by {@link gitArgs}) stages. An
 * operand names a file OR a directory, so each is matched against the files
 * that differ from the index — modified and untracked — as itself or as a
 * prefix (#1193 review: a new spec staged by `git add -A`, `git add .` or
 * `git add docs/superpowers/specs/` used to reach no rule at all), through
 * {@link pathspecFiles}. `-A`/`--all`/`-u` with no operand select every
 * candidate; `-u`/`--update` leaves untracked files out. The caller handles an
 * add whose words cannot be read.
 */
function addedFiles(args, ctx, dir) {
  const flag = (short, long) => short.some((f) => args.short.has(f)) || long.some((f) => args.long.has(f));
  const updateOnly = flag(["u"], ["--update"]);
  const candidates = [...ctx.modified(dir), ...(updateOnly ? [] : (ctx.untracked?.(dir) ?? []))];
  if (!args.operands.length) return flag(["A", "u"], ["--all", "--update"]) ? candidates : [];
  return args.operands.flatMap((t) => pathspecFiles(t, candidates, ctx, dir));
}

/**
 * The files among `candidates` (repo-relative) that a pathspec operand selects:
 * itself, or every candidate under it as a directory. `.` or the repo root, a
 * glob, a `:(magic)` pathspec and a substitution select every candidate — the
 * hook evaluates none of those, and erring that way costs a deny only when a
 * candidate carries something to deny. An operand that matches nothing is kept
 * as its path — a file already staged, a path outside this model — so a rule
 * still sees the name.
 */
function pathspecFiles(token, candidates, ctx, dir) {
  const rel = pathspecPath(token, ctx, dir);
  if (rel === undefined || rel === "" || rel === ".") return candidates;
  const hits = candidates.filter((f) => f === rel || f.startsWith(`${rel}/`));
  return hits.length ? hits : [rel];
}

/**
 * A pathspec operand as a repo-relative path, read relative to the command's
 * cwd `dir`; `undefined` for one the hook does not evaluate — a glob, a
 * `:(magic)` pathspec or a substitution.
 */
function pathspecPath(token, ctx, dir) {
  if (!token.known) return undefined;
  const op = token.value;
  if (/[*?[]/.test(op) || op.startsWith(":")) return undefined;
  const top = ctx.toplevel?.(dir);
  return asPath(top ? path.relative(top, resolveDir(dir, op, { shell: ctx.shell })) : op)
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * The words of one command, from `from` (just past its verb) to the end of that
 * command, as `{ value, known }`. The command ends where `commandEnd` in
 * `shell-lexer.mjs` says, in the trusted-masked text: at a chain separator, or
 * at the `)` or backtick that closes the subshell or substitution it runs in —
 * a `(git commit -m x -- <path>)` used to read `<path>)` as its operand
 * (#1594 review) — while a substitution among its own arguments, parens and all,
 * stays inside it. That text is then lexed on its own, as `issueEdits` does, and
 * the words found in its `flat` text, where every quote, substitution, heredoc
 * body and comment is blanked — so a multi-line `-m "$(cat <<'EOF' … EOF)"` is
 * ONE word and the `-- <paths>` after it are still read, and a command inside a
 * substitution, which the whole command's flat text blanks, is read too. Each
 * word's value is taken from the raw text: a plain word as written, a quoted one
 * unquoted, one with a `$` or backtick outside single quotes as `known: false`
 * (its value is decided at run time), and heredoc bodies and comments dropped as
 * data. When the command's own text does not lex (a heredoc whose body follows
 * it), the whole command's lexing is used for it — unless that blanks the
 * command's own spaces, as it does inside a substitution, where the words cannot
 * be read and one `known: false` token stands for them, so the selection is
 * unreadable (#1594 second read). A backtick counts as opening a substitution
 * only when no odd run of backslashes escapes it. When the mask does not stand
 * over the command (`trustedIn`, #1607) the raw command is tokenised instead,
 * respecting simple quotes, as the older rules do.
 */
function argTokens(command, from) {
  const { text, flat } = view(command);
  // Live backticks ahead of it: an odd count means it runs inside a backtick
  // substitution. The mask keeps an escaped `\`` live, so one preceded by an
  // odd run of live backslashes is a character, not a substitution (#1594 second read).
  const ticks = [...text.slice(0, from).matchAll(/\x60/g)].filter(
    (m) => text.slice(0, m.index).match(/\\*$/)[0].length % 2 === 0,
  );
  const end = commandEnd(text, from, ticks.length % 2 === 1);
  if (!trustedIn(command, from, end)) return chainWords(command.slice(from)).map((value) => ({ value, known: true }));
  const own = maskInert(command.slice(from, end));
  if (!own.sure) {
    // The whole command's flat text blanks a substitution, spaces and all, so
    // inside one it gives a single blank word for the whole command: its words
    // cannot be read, and an unreadable word makes the selection unreadable.
    for (let i = from; i < end; i++) if (flat[i] === "_" && /\s/.test(text[i])) return [{ value: "", known: false }];
  }
  const [ownFlat, ownText] = own.sure ? [own.flat, own.masked] : [flat.slice(from, end), text.slice(from, end)];
  const out = [];
  for (const m of ownFlat.matchAll(/\S+/g)) {
    const a = from + m.index;
    const raw = command.slice(a, a + m[0].length);
    const masked = ownText.slice(m.index, m.index + m[0].length);
    // A `$` or backtick outside single quotes expands at run time: `"$P"`, `$(…)`, `${x}`.
    const expands = /[$`]/.test(raw.replace(/'[^']*'/g, ""));
    if (m[0] !== raw && /^_+$/.test(masked)) continue;
    if (expands) out.push({ value: raw, known: false });
    else if (m[0] === raw) out.push({ value: raw, known: true });
    else out.push({ value: raw.replace(/\\(.)/g, "$1").replace(/["']/g, ""), known: true });
  }
  return out;
}

/**
 * How {@link gitArgs} reads one git command's options: `valueShort` and
 * `valueLong` take the NEXT word as their value when it is not attached,
 * `attachedShort` only ever takes one attached, and `long` is every long option
 * the command has (from `git <cmd> -h`, git 2.56), against which an abbreviated
 * one is resolved as git resolves it (#1594 second read).
 */
const COMMIT_VALUE_LONG = [
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
  "--unified",
  "--inter-hunk-context",
];
const COMMIT_OPTIONS = {
  valueShort: "mFCctU",
  attachedShort: "Su",
  valueLong: new Set(COMMIT_VALUE_LONG),
  long: new Set([
    ...COMMIT_VALUE_LONG,
    "--quiet",
    "--verbose",
    "--reset-author",
    "--signoff",
    "--edit",
    "--status",
    "--gpg-sign",
    "--all",
    "--include",
    "--interactive",
    "--patch",
    "--only",
    "--no-verify",
    "--verify",
    "--dry-run",
    "--short",
    "--branch",
    "--ahead-behind",
    "--porcelain",
    "--long",
    "--null",
    "--amend",
    "--no-post-rewrite",
    "--post-rewrite",
    "--untracked-files",
    "--pathspec-file-nul",
    "--allow-empty",
    "--allow-empty-message",
  ]),
};
const ADD_VALUE_LONG = ["--unified", "--inter-hunk-context", "--chmod", "--pathspec-from-file"];
const ADD_OPTIONS = {
  valueShort: "U",
  attachedShort: "",
  valueLong: new Set(ADD_VALUE_LONG),
  long: new Set([
    ...ADD_VALUE_LONG,
    "--dry-run",
    "--verbose",
    "--interactive",
    "--patch",
    "--auto-advance",
    "--edit",
    "--force",
    "--update",
    "--renormalize",
    "--resolved",
    "--intent-to-add",
    "--all",
    "--ignore-removal",
    "--refresh",
    "--ignore-errors",
    "--ignore-missing",
    "--sparse",
    "--pathspec-file-nul",
  ]),
};

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
 * A git command's words (from {@link argTokens}) split into options and
 * pathspec operands, read with the command's `options` ({@link COMMIT_OPTIONS},
 * {@link ADD_OPTIONS}): `long` and `short` hold the option names seen (a short
 * cluster's letters one by one, a long one as git resolves an abbreviation,
 * {@link longName}), an option's value is skipped, and every word after `--` is
 * an operand. A redirection and its target are the shell's, before `--` or
 * after it, whatever the target expands to: `2>$null` or `>"$f"` read as an
 * operand made every selection unreadable (#1594 second read). `unknown` is set
 * when a word that is not an option's value carries a substitution — it could
 * be anything — and for a long option git would refuse as unknown or ambiguous,
 * since one the hook does not model might take the next word as its value.
 */
function gitArgs(tokens, { valueShort = "", attachedShort = "", valueLong = new Set(), long } = {}) {
  const res = { long: new Set(), short: new Set(), operands: [], unknown: false };
  let dashed = false;
  for (let i = 0; i < tokens.length; i++) {
    const { value: w, known } = tokens[i];
    if (/^(?:\d*[<>]|&>)/.test(w)) {
      if (BARE_REDIRECT.test(w)) i++;
    } else if (dashed) res.operands.push(tokens[i]);
    // An option is still read by its name; only its attached value is unknown.
    else if (!known && !w.startsWith("-")) res.unknown = true;
    else if (w === "--") dashed = true;
    else if (w.startsWith("--")) {
      const name = longName(w.split("=")[0], long);
      if (name === undefined) res.unknown = true;
      else {
        res.long.add(name);
        if (!w.includes("=") && valueLong.has(name)) i++;
      }
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
 * A long option as git resolves it among `known` (#1594 second read): itself,
 * the one option it is a prefix of — git takes any unique abbreviation, so
 * `--mess "add thing"` is `--message` and its value, not a pathspec — or the
 * `--no-` negation of either. `undefined` when git would refuse it as unknown
 * or ambiguous. Without `known` every name stands as written.
 */
function longName(name, known) {
  if (!known || known.has(name)) return name;
  const hits = [...known].filter((k) => k.startsWith(name));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0 && name.startsWith("--no-")) {
    const positive = longName(`--${name.slice(5)}`, known);
    return positive && `--no-${positive.slice(2)}`;
  }
  return undefined;
}

/**
 * Whether a pathspec operand, relative to the command's cwd `dir`, selects
 * the repo-relative `target`: as itself, as a directory above it, or as the
 * whole tree. A glob or a `:(magic)` pathspec is taken to select it — the hook
 * does not evaluate those, and erring that way only costs a deny when the
 * target would really carry something to deny.
 */
function pathspecCovers(token, target, ctx, dir) {
  const rel = pathspecPath(token, ctx, dir);
  if (rel === undefined || rel === "" || rel === ".") return true;
  if (rel.startsWith("../")) return false;
  return target === rel || target.startsWith(`${rel}/`);
}

const GIT_ADD = gitVerb(String.raw`add\b`);

/**
 * Where the `git commit` matched as `commit` (a {@link chainCommands} result,
 * judged in `dir`) takes the Elgato manifest's bytes from: `[]` when it does
 * not commit the manifest at all, `["index"]` for the staged copy,
 * `["worktree"]` for the working copy, both when it cannot tell.
 *
 * - A pathspec (`git commit [--only] [--] <paths>`) commits those paths from
 *   the WORKING copy; a staged manifest outside it is left out, unless
 *   `-i`/`--include` adds the staged files too.
 * - `-a`/`--all` commits every tracked file from the working copy.
 * - A `git add` chained ahead of the commit that selects the manifest, read in
 *   its own directory ({@link addsAhead}), stages the working copy before the
 *   commit runs (the hook runs before both).
 * - Otherwise a plain commit takes the INDEX, and only when the manifest is
 *   staged — so a manifest dirty with the key but not staged passes.
 * - A substitution standing where an option or a path could be, and
 *   `--pathspec-from-file`, on the commit or on an add ahead of it, leave the
 *   selection unknown: both copies are read.
 */
function manifestSources(command, commit, ctx, dir) {
  const args = commitArgs(command, commit);
  if (args.unknown || args.long.has("--pathspec-from-file")) return ["index", "worktree"];
  const covers = (d) => (t) => pathspecCovers(t, ELGATO_MANIFEST, ctx, d);
  if (args.operands.length) {
    if (args.operands.some(covers(dir))) return ["worktree"];
    if (!(args.short.has("i") || args.long.has("--include"))) return [];
  } else if (args.short.has("a") || args.long.has("--all")) return ["worktree"];
  const adds = addsAhead(command, commit, ctx);
  // An add whose selection is only decided at run time may or may not stage the
  // manifest, so the commit may take either copy: a manifest staged with the key
  // and cleaned since, then `git add "$F" && git commit`, records the staged one.
  if (adds.some(({ args: a }) => a.unknown || a.long.has("--pathspec-from-file"))) return ["index", "worktree"];
  const added = adds.some(({ args: a, dir: addDir }) => {
    if (a.operands.length) return a.operands.some(covers(addDir));
    return (
      ["A", "u", "p", "i", "e"].some((f) => a.short.has(f)) ||
      ["--all", "--update", "--patch", "--interactive", "--edit"].some((f) => a.long.has(f))
    );
  });
  if (added) return ["worktree"];
  return ctx.staged(dir).includes(ELGATO_MANIFEST) ? ["index"] : [];
}

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
 *
 * A program word the lexer cannot read — its last path segment expands or
 * globs: `$GH`, `$(which gh)`, `g?` (`unreadablePrograms` in
 * `shell-lexer.mjs`) — could be gh or git, so the command is judged again
 * with that word replaced by each of them (#1606). Anything a rule would say
 * about either, an ask included, refuses it, naming the word: the hook cannot
 * tell what the shell will run, and a deny costs one re-spelling. A word no
 * rule would say anything about as either (`$EDITOR notes.md`) passes.
 *
 * An argument of env that expands (`env $R gh pr merge 5`) may be the program
 * or a NAME=VALUE env makes (#1606 review), so it is judged as each program
 * and as `GH_REPO=<word>` and `GIT_DIR=<word>`, the two assignments a rule
 * reads: the merge gate then cannot read the repository, and a commit cannot
 * tell which one it records into.
 *
 * Any such word may also be a wrapper (`W=command`, `W=env`) that runs the
 * words after it as the command (#1606 second read), so it is judged once more
 * blanked out, at the same length, which puts the next word at command
 * position.
 *
 * A program word a string handed to a shell spells so the text cannot show
 * the name it runs (#1646, `respelledPrograms` in `shell-lexer.mjs`): one
 * spliced from quoted pieces is refused, naming it; one whose quotes the
 * string's own quoting escapes (`bash -c "\"gh\" pr merge 7"`, pwsh's `&
 * \"C:\…\gh.exe\"`) is judged with the name its shell runs in its place, and
 * that verdict stands.
 *
 * First of all, a command that hands text to a shell in a form the hook does
 * not read — a printer or any command piped into a shell, a here-string,
 * heredoc, process substitution or descriptor a shell reads its script from
 * (stdin named by a path or PowerShell's `-` included; `source` and `.`
 * too) or a startup file from (`--rcfile`, `BASH_ENV`, `ENV`), PowerShell's
 * `-EncodedCommand`, `eval`, a `sudo` that runs a shell, a string that is
 * not one plain level, a string inside a string, a program word in a string
 * that is not its plain name, a shell string xargs, parallel or find fills in from
 * its input, parallel running its input as commands (`refusedForms` in
 * `shell-lexer.mjs`, #1659) —
 * is refused outright, before any rule's verdict and never as an ask: the
 * lexer's stopping rule reads only the forms agents type here.
 */
export function checkBash(command, ctx) {
  const powershell = ctx.shell === POWERSHELL;
  const read = (c) => checkText(powershell ? powershellAsBash(c) : c, ctx, powershell, 0);
  // PowerShell takes a curly quote as a plain one, except in a braced
  // variable name, a block comment, a here-string or after `--%`, where it is
  // a plain character. A command holding one, typed to PowerShell or running
  // pwsh as a program, is judged both ways and the stricter verdict stands, as
  // a respelled program word is (a judge on 15ce351a1): a deny first, else
  // every ask either reading raises, in one prompt, as `judge` joins its rules'
  // (CodeRabbit on 164de4f80). A Bash command that only mentions pwsh, in a
  // comment or an argument, is read one way.
  if (!readsCurlyTwice(command, powershell)) return read(command);
  const verdicts = [read(command), read(straightQuotes(command))];
  const deny = verdicts.find((v) => typeof v === "string");
  if (deny) return deny;
  const raised = verdicts.filter((v) => v);
  if (raised.length < 2) return raised[0] ?? null;
  const all = [...new Set(raised.flatMap((v) => v.asks ?? [v.ask]))];
  return all.length === 1 ? raised[0] : { ask: all.join("\n\n"), asks: all };
}

/**
 * The deny of a form the lexer refuses rather than reads ({@link checkBash},
 * #1659), with the safe spelling the lexer names for it, if any (`advice`).
 */
const stoppingRefusal = ({ form, shape, advice }) =>
  `This command hands text to a shell in a form the hook does not read (${form}): \`${shape}\`. ${advice ?? "Type the commands directly, or write them to a script file and run it."}`;

/**
 * The first deny of the rules marked `occurrence` — those that fire on any
 * occurrence of a text in the raw command, wherever it sits — over `text`
 * ({@link checkText}), or `null`.
 */
function occurrences(text, ctx, powershell) {
  for (const rule of rules) {
    if (!rule.occurrence || (powershell && rule.bashOnly)) continue;
    const v = rule.test(text, ctx);
    if (typeof v === "string") return v;
  }
  return null;
}

/** {@link checkBash} over the command read as bash (`text`); `depth` counts the re-judges with a respelled name in place. */
function checkText(text, ctx, powershell, depth) {
  // A form the lexer refuses rather than reads, wherever it sits: before any
  // rule, so no ask or pass of theirs can stand in for it (#1659).
  const [refused] = refusedForms(text, powershell ? POWERSHELL : BASH);
  if (refused) return stoppingRefusal(refused);
  const { respelled, spliced } = respelledPrograms(text);
  if (spliced.length)
    return `The program \`${spliced[0].word}\` in a string this command hands to a shell is spliced from quoted pieces, so the hook cannot read which program it runs. Spell the program as one plain word.`;
  if (respelled.length) {
    if (depth > 0)
      return `A program in a string this command hands to a shell is quoted or escaped so the hook cannot read it in place (\`${respelled[0].word}\`). Spell the program as a plain word.`;
    // The rules that fire on any occurrence of a text read this command's own
    // first: a re-judge reads a rebuilt text (CodeRabbit on PR #1788).
    const occurrence = occurrences(text, ctx, powershell);
    if (occurrence) return occurrence;
    // Each word replaced by the name its shell runs, from the last, so the
    // earlier ones keep their indices; and once more by the name its raw text
    // spells, where that differs, the stricter verdict standing.
    const named = (key) => {
      let out = text;
      for (const w of [...respelled].sort((x, y) => y.start - x.start))
        out = out.slice(0, w.start) + w[key] + out.slice(w.end);
      return out;
    };
    // A substitution that gives back the command unchanged reads nothing new.
    const verdicts = [named("name"), named("rawName")]
      .filter((c, k, all) => all.indexOf(c) === k && c !== text)
      .map((c) => checkText(c, ctx, powershell, depth + 1));
    if (verdicts.length) return verdicts.find((v) => typeof v === "string") ?? verdicts.find((v) => v) ?? null;
  }
  // Shells or wrappers nested past the lexer's depth leave the program at the
  // bottom unread by every rule, and a re-judge hits the same depth, so the
  // command is refused whole rather than passed (#1634, an independent judge
  // on PR #1637: `nice` nested nine times let a merge through).
  if (unsettled(text))
    return "This command nests shells or wrappers (`bash -c`, `sudo`, `nice`, `env` …) deeper than the hook can read, so it cannot see what runs at the bottom. Run the inner command directly, or with fewer wrappers around it.";
  // A lead in a string a shell runs that opens a quote it never closes, or a
  // heredoc with no delimiter: which word runs after it cannot be read, so the
  // command is refused whole rather than passed on a guess (#1646).
  if (unclosedLead(text))
    return "A command this one hands to a shell (`bash -c`, `pwsh -Command` …) starts with a quote that never closes, or has a heredoc with no delimiter, so the hook cannot read which program it runs. Close the quote, or run the inner command directly.";
  const verdict = judge(text, ctx, powershell);
  if (typeof verdict === "string") return verdict;
  // An ask the command carries anyway, from another command of the chain, is
  // not the word's doing: a re-judge repeats it, and only what the
  // substitution adds may turn into a deny (#1606, CodeRabbit CLI).
  const own = new Set(verdict?.asks ?? []);
  const masked = trustedMask(text);
  for (const { start, end, word, env } of unreadablePrograms(text)) {
    // Where the word's own command ends.
    const stop = masked.slice(end).search(/[;&|\n()\x60]/);
    const ownEnd = stop < 0 ? masked.length : end + stop;
    // An unquoted expansion may split into a wrapper and its assignments
    // (`W='env GH_REPO=o/r'`), so it gets the assignment stand-ins too
    // (CodeRabbit on PR #1628), after the wrapper one. An assignment reaches
    // only its own command, so that stand-in is judged without the commands
    // chained after it, whose own rules would read it as theirs.
    const splits = SPLITS.test(word.replace(/'[^']*'|"(?:[^"\\]|\\[\s\S])*"/g, ""));
    const assigns = env || splits ? [`GH_REPO=${word}`, `GIT_DIR=${word}`] : [];
    const blank = " ".repeat(end - start);
    const as = env ? ["gh", "git", ...assigns, blank] : ["gh", "git", blank, ...assigns];
    for (const program of as) {
      const tail = program.includes("=") ? text.slice(end, ownEnd) : text.slice(end);
      const v = judge(text.slice(0, start) + program + tail, ctx, powershell);
      if (!v) continue;
      const added = typeof v === "string" ? [v] : v.asks.filter((a) => !own.has(a));
      if (!added.length) continue;
      const reason = added.join(" ");
      if (!program.trim())
        return `Could not read the program \`${word}\`; judged as a wrapper that runs what follows it: ${reason} Spell the program as a plain word.`;
      return program.includes("=")
        ? `Could not read \`${word}\`, which ${env ? "env may take for" : "may expand to"} an assignment; judged as \`${program}\`: ${reason} Spell it as a plain word.`
        : `Could not read the program \`${word}\`; judged as ${program}: ${reason} Spell the program as a plain word.`;
    }
    // An unquoted expansion splits into several words at run time, which no
    // one-word stand-in above models: `$(echo gh pr) merge 5`, or
    // `$(echo gh -R x/y) pr merge 5`, whose `gh` stand-in reads this
    // repository's PR and passes (#1606, CodeRabbit CLI). Such a word refuses
    // when it names gh or git, or when the word after it is a subcommand a
    // guard reads, so the word supplies the program (`$CMD pr merge 5`). A
    // program after it (`$W gh pr view 5`) was judged by the wrapper stand-in.
    const next = masked.slice(end, ownEnd).trimStart().split(/\s+/, 1)[0];
    if (splits && (GUARDED_PROGRAM.test(word) || GUARDED_VERB.test(next)))
      return `Could not read the program \`${word}\`, which may expand to several words, among them a command a guard reads; spell the program and its subcommand as plain words.`;
  }
  return verdict && { ask: verdict.ask };
}

/** An unquoted expansion that word splitting or brace expansion can turn into several words ({@link checkBash}). */
const SPLITS = /[$\x60]|\{[^}]*,/;
/** gh or git named inside a program word that splits ({@link checkBash}). */
const GUARDED_PROGRAM = /\b(?:gh|git)\b/i;
/** A gh or git subcommand a guard reads, as the word after a program word that splits ({@link checkBash}). */
const GUARDED_VERB = /^(?:pr|merge|create|push|commit|worktree|api|project|issue|add)$/;

/** The rules' verdict on `text`, already read as bash ({@link checkBash}). */
/** The refusal of a command a rule reads mis-sliced ({@link judge}, #1646). */
const DECODED_REFUSAL =
  "A command this one hands to a shell is spelled so that shell reads its words differently from how they are written here (an escape it decodes, words cmd.exe, PowerShell or `watch` join), and the hook cannot read its arguments as that shell does. Spell the command as plain words.";

function judge(text, ctx, powershell) {
  const asks = [];
  for (const rule of rules) {
    if (powershell && rule.bashOnly) continue;
    takeDecodedHits(text);
    const v = rule.test(text, ctx);
    // A rule that found its command in what a shell reads from a string, but
    // reads its arguments from raw text that differs (a quote the string's
    // quoting escapes, words cmd.exe or PowerShell join; eval, printers and
    // ANSI-C strings are refused before this, #1659), never passes on them (#1646; reading
    // them as that shell does is #1783). A rule that read that command as
    // its shell does excused its match (`excuseDecodedHit`). Nor does it ask
    // on them: an ask the rule raised over another command of the chain says
    // nothing of the one it read mis-sliced, which the prompt would run
    // unnamed (CodeRabbit CLI on #1646). A deny stands as it is.
    if (typeof v === "string") return v;
    if (takeDecodedHits(text).size) return DECODED_REFUSAL;
    if (!v) continue;
    asks.push(v.ask);
  }
  // Every ask in one prompt: a chain the maintainer approves runs whole, so a
  // later ask hidden behind an earlier one would run unseen (#1307 review).
  return asks.length ? { ask: asks.join("\n\n"), asks } : null;
}
