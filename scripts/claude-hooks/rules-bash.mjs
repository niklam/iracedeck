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
 */
import { Buffer } from "node:buffer";
import path from "node:path";

import { DEBUG_VALUE, ELGATO_MANIFEST, manifestDebug } from "../lib/debug-plugin.mjs";
import { FULL_SHA, rangeChain, readSummary } from "./coderabbit-summary.mjs";
import { INTEGRATION_BRANCH, INTEGRATION_TREE, MAIN_BRANCH, SPEC_DIR } from "./lib.mjs";
import { findControlByte } from "./rules-tools.mjs";

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

/**
 * Lexes a shell command the way bash reads it (#1321), returning three strings
 * of the command's own length — an index means the same character in each —
 * and a verdict on the lexing itself:
 *
 * - `masked`: the command with its INERT text replaced by `_`: single-quoted
 *   text (`$'…'` too), double-quoted text and unquoted heredoc bodies except
 *   the substitutions in them, quoted-delimiter heredoc bodies whole, and `#`
 *   comments. Substitutions — `$( … )`, backticks, `${ … }`, `$(( … ))` — run,
 *   so they stay live and are lexed by the same rules: a quote, a heredoc or a
 *   comment inside one is read as bash reads it. A line continuation becomes
 *   two spaces, since bash joins the lines.
 * - `flat`: `masked` with every construct at the top level blanked as well,
 *   substitutions and escapes included. A word of `flat` that equals its raw
 *   text is a plain literal word — the only kind `parseMerge` takes as a flag
 *   or a PR.
 * - `sure`: false once any construct runs off the end of the string (an open
 *   quote, substitution, `${`, backtick or heredoc whose terminator line never
 *   comes), a `)` closes nothing, or a heredoc has no delimiter. Bash refuses
 *   every one of those, so reaching that state means the lexer misread the
 *   command — and a misread mask can blank a command bash runs. Consumers fall
 *   back to the raw text then ({@link trustedMask}).
 *
 * One recursive lexer rather than a scanner per context: the three hand-copied
 * scanners it replaced had already drifted apart, and each gap blanked the rest
 * of a command (#1321 review).
 */
export function maskInert(command) {
  if (command === maskInert.last) return maskInert.lastOut;
  const s = command;
  const n = s.length;
  const out = s.split("");
  const flat = s.split("");
  const pending = [];
  let sure = true;
  const blank = (arr, a, b) => {
    for (let k = a; k < Math.min(b, n); k++) arr[k] = "_";
  };
  // The substitution opening at `k`, lexed; returns where it ends, or -1 when none opens there.
  const substitution = (k, limit, inDouble) => {
    if (s[k] === "`") return commands(k + 1, limit, "`");
    if (s[k] !== "$") return -1;
    if (s[k + 1] === "(") return s[k + 2] === "(" ? arithmetic(k + 3, limit) : commands(k + 2, limit, ")");
    if (s[k + 1] === "{") return parameter(k + 2, limit, inDouble);
    return -1;
  };

  // Single-quoted text from `i`, or ANSI-C `$'…'` text, where `\'` does not close it.
  const single = (i, limit, ansi) => {
    for (let k = i; k < limit; k++) {
      if (ansi && s[k] === "\\") k++;
      else if (s[k] === "'") {
        blank(out, i, k);
        return k + 1;
      }
    }
    blank(out, i, limit);
    sure = false;
    return limit;
  };

  // Double-quoted text (`quoted`), or an unquoted heredoc body up to `limit`: data except its substitutions.
  const expanding = (i, limit, quoted) => {
    let k = i;
    while (k < limit) {
      if (quoted && s[k] === '"') return k + 1;
      const sub = substitution(k, limit, true);
      if (sub >= 0) k = sub;
      else if (s[k] === "\\") {
        blank(out, k, Math.min(k + 2, limit));
        k += 2;
      } else out[k++] = "_";
    }
    if (quoted) sure = false;
    return limit;
  };

  // `$(( … ))` or `(( … ))` from `i`: live, with no heredoc or comment inside — `1<<4` is a shift, `16#ff` a base.
  const arithmetic = (i, limit) => {
    let depth = 0;
    let k = i;
    while (k < limit) {
      const sub = substitution(k, limit, false);
      if (sub >= 0) k = sub;
      else if (s[k] === "\\") k += 2;
      else if (s[k] === "'") k = single(k + 1, limit, false);
      else if (s[k] === '"') k = expanding(k + 1, limit, true);
      else if (s[k] !== ")") {
        if (s[k] === "(") depth++;
        k++;
      } else if (depth > 0) {
        depth--;
        k++;
      } else if (s[k + 1] === ")") return k + 2;
      else {
        sure = false;
        return k + 1;
      }
    }
    sure = false;
    return limit;
  };

  // `${ … }` from `i`: live to its `}`, with no comment inside — `${x:- #y}` is one word.
  const parameter = (i, limit, inDouble) => {
    let k = i;
    while (k < limit) {
      if (s[k] === "}") return k + 1;
      const sub = substitution(k, limit, inDouble);
      if (sub >= 0) k = sub;
      else if (s[k] === "\\") k += 2;
      else if (s[k] === "'" && !inDouble) k = single(k + 1, limit, false);
      else if (s[k] === '"') k = expanding(k + 1, limit, true);
      else k++;
    }
    sure = false;
    return limit;
  };

  // A heredoc operator's delimiter word from `i` (just past `<<`); queues the body, which starts on the next line.
  const heredoc = (i, limit) => {
    let k = i;
    const strip = s[k] === "-";
    if (strip) k++;
    while (s[k] === " " || s[k] === "\t") k++;
    let delim = "";
    let quoted = false;
    while (k < limit && !/[\s;|&<>()`]/.test(s[k])) {
      if (s[k] === "'" || s[k] === '"') {
        const end = s.indexOf(s[k], k + 1);
        if (end < 0 || end >= limit) {
          sure = false;
          return limit;
        }
        delim += s.slice(k + 1, end);
        quoted = true;
        k = end + 1;
      } else if (s[k] === "\\") {
        delim += s[k + 1] ?? "";
        quoted = true;
        k += 2;
      } else delim += s[k++];
    }
    if (delim) pending.push({ delim, quoted, strip });
    else sure = false;
    return k;
  };

  // The queued heredoc bodies, from `at` (the line after their operators); returns where commands resume.
  const bodies = (at, limit, top) => {
    for (const { delim, quoted, strip } of pending.splice(0)) {
      let p = at;
      let found = -1;
      let resume = limit;
      while (p < limit) {
        let eol = s.indexOf("\n", p);
        if (eol < 0 || eol > limit) eol = limit;
        const line = s.slice(p, eol).replace(/\r$/, "");
        if ((strip ? line.replace(/^\t+/, "") : line) === delim) {
          found = p;
          resume = Math.min(eol + 1, limit);
          break;
        }
        p = eol + 1;
      }
      const end = found < 0 ? limit : found;
      if (quoted) blank(out, at, end);
      else expanding(at, end, false);
      if (top) blank(flat, at, end);
      if (found < 0) {
        sure = false;
        return limit;
      }
      at = resume;
    }
    return at;
  };

  // Text bash runs as commands: the top level (`close` null), a `$( … )` (")") or a backtick substitution ("`").
  const commands = (i, limit, close) => {
    let depth = 0;
    // Whether `i` starts a word, so a `#` there opens a comment and a `((` an
    // arithmetic command: after a blank or one of `;&|()`. Kept as state, not
    // read off the previous character, because in `a\ #b` that blank is escaped
    // and `#b` goes on with the word.
    let atWord = true;
    while (i < limit) {
      const ch = s[i];
      const from = i;
      if (close === "`" && ch === "`") return i + 1;
      if (ch === "\\" && s[i + 1] === "\n") {
        // A line continuation: bash removes it, joining the lines; the word, if any, goes on.
        out[i] = out[i + 1] = " ";
        if (!close) flat[i] = flat[i + 1] = " ";
        i += 2;
        continue;
      }
      let sub = -1;
      // A `case` list's pattern `)` reads here as a closer — of a substitution
      // it ends early, and inside `"$(…)"` the rest is then blanked as data with
      // the lex still "sure" (#1328 review). The lexer does not model case lists,
      // so meeting one at any depth means the mask cannot be trusted.
      if (atWord && /^case(?![\w-])/.test(s.slice(i, i + 5))) sure = false;
      if (atWord && ch === "#") {
        // To the end of the line — or of a backtick substitution, whose text bash cuts out first.
        let end = s.indexOf("\n", i);
        if (end < 0 || end > limit) end = limit;
        const tick = close === "`" ? s.indexOf("`", i) : -1;
        if (tick >= 0 && tick < end) end = tick;
        blank(out, i, end);
        i = end;
      } else if (atWord && ch === "(" && s[i + 1] === "(") i = arithmetic(i + 2, limit);
      else if ((sub = substitution(i, limit, false)) >= 0) i = sub;
      else if (ch === "\\") i += 2;
      else if (ch === "'") i = single(i + 1, limit, false);
      else if (ch === "$" && s[i + 1] === "'") i = single(i + 2, limit, true);
      else if (ch === '"') i = expanding(i + 1, limit, true);
      else {
        // Live text: a word, a paren, a here-string, a heredoc operator, a newline.
        if (ch === "<" && s[i + 1] === "<") i = s[i + 2] === "<" ? i + 3 : heredoc(i + 2, limit);
        else if (ch === "\n" && pending.length) i = bodies(i + 1, limit, !close);
        else {
          if (ch === "(") depth++;
          else if (ch === ")" && depth > 0) depth--;
          else if (ch === ")" && close === ")") return i + 1;
          else if (ch === ")") sure = false; // closes nothing: bash would refuse the command
          i++;
        }
        atWord = " \t\n;&|()".includes(ch);
        continue;
      }
      atWord = false;
      if (!close) blank(flat, from, i);
    }
    if (close) sure = false;
    return limit;
  };

  commands(0, n, null);
  if (pending.length) sure = false;
  maskInert.last = command;
  maskInert.lastOut = { masked: out.join(""), flat: flat.join(""), sure };
  return maskInert.lastOut;
}

/**
 * A word, at a word boundary in live text, that hands a STRING or stdin to a
 * shell — `bash -c '…'`, `eval "…"`, `bash <<'EOF'`, `xargs sh -c`, `trap '…'`,
 * `timeout 900 bash -c` — or runs its argument (`timeout`, `sudo`, `watch`).
 * The text those carry is executed, not inert, so masking it would hide the
 * very commands the rules exist for (#1321 review).
 */
const SHELL_FED =
  /(?:^|[\s;&|(`/])(?:bash|sh|zsh|dash|ksh|fish|eval|xargs|parallel|watch|su|sudo|source|timeout|trap|pwsh|powershell|cmd)(?:\.exe)?(?=[\s;&|)`]|$)/m;

/**
 * The text the rules read: `{ text, flat, trusted }`. The mask is trusted only
 * when the lexer is sure of it AND nothing in the live text feeds a string to a
 * shell; otherwise `text` and `flat` are the raw command — the pre-#1321
 * behaviour, which over-matches. The pre-hook is a safety gate, so a doubt
 * costs a false deny on a mention, never a missed command.
 */
function view(command) {
  if (command !== view.last) {
    const { masked, flat, sure } = maskInert(command);
    const trusted = sure && !SHELL_FED.test(masked);
    view.last = command;
    view.out = trusted ? { text: masked, flat, trusted } : { text: command, flat: command, trusted };
  }
  return view.out;
}

/** The command with its inert text masked where the mask is trusted, else the raw command ({@link view}). */
export const trustedMask = (command) => view(command).text;

/** `[start, end)` ranges of `text` between the separators `sep` finds in it. */
function ranges(text, sep) {
  const global = new RegExp(sep.source, sep.flags.includes("g") ? sep.flags : sep.flags + "g");
  const out = [];
  let start = 0;
  for (const m of text.matchAll(global)) {
    out.push([start, m.index]);
    start = m.index + m[0].length;
  }
  out.push([start, text.length]);
  return out;
}

/** The separators a chain is split at for `cd`/`-C` tracking; the merge and tag rules also split at a lone `&`. */
const CHAIN = /\n|&&|\|\||;|\|/;
const CHAIN_AND_BACKGROUND = /&&|\|\||[;|&\n]/;
/** What ends one command's arguments inside a chain segment ({@link chainCommands}): a paren, a backtick, or a `&` that is no redirect's. */
const COMMAND_END = /[()\x60]|(?<![<>])&(?!>)/;

/**
 * Every match of `re` in the trusted-masked text, with its capture groups read
 * from the RAW command at the same indices: the mask decides WHERE a command
 * is, the raw text says what its arguments are (a quoted path stays readable).
 * Each result is the array of raw groups, with `index` set.
 */
export function* matchesAt(command, re) {
  const flags = new Set([...re.flags, "g", "d"]);
  const global = new RegExp(re.source, [...flags].join(""));
  for (const m of trustedMask(command).matchAll(global)) {
    const raw = m.indices.map((r) => (r ? command.slice(r[0], r[1]) : undefined));
    raw.index = m.index;
    yield raw;
  }
}

/** The first of {@link matchesAt}, or `null`. */
export function matchAt(command, re) {
  for (const m of matchesAt(command, re)) return m;
  return null;
}

/**
 * The shell a command comes from (#1520): `ctx.shell`, bash when unset. The
 * PowerShell tool's commands are judged by every rule that is not bash syntax
 * ({@link checkBash}), and two things read differently there — the commands
 * that move the directory ({@link cdRe}) and a `/c/…` path ({@link resolveDir}).
 */
export const BASH = "bash";
export const POWERSHELL = "powershell";

const QUOTED_ARG = String.raw`("([^"]+)"|'([^']+)'|(\S+))`;
const CD_RE = new RegExp(String.raw`^\s*(?:\w+=\S*\s+)*cd\s+${QUOTED_ARG}\s*$`, "d");
/** PowerShell's `Set-Location` and its aliases, any case, with an optional `-Path` / `-LiteralPath`. */
const PS_CD_RE = new RegExp(
  String.raw`^\s*(?:cd|chdir|sl|set-location)(?:\s+-(?:path|literalpath))?\s+${QUOTED_ARG}\s*$`,
  "di",
);
const cdRe = (shell) => (shell === POWERSHELL ? PS_CD_RE : CD_RE);
/** `cd -` / `cd +` go back or forward in a history the hook cannot see: the directory stays put. */
const HISTORY_DIR = new Set(["-", "+"]);
const GIT_C_RE = new RegExp(String.raw`\bgit\s+-C\s+${QUOTED_ARG}`, "d");

/** Git Bash's spelling of a drive, `/c/…` or `/cygdrive/c/…`, for `C:\…`. */
const GIT_BASH_DRIVE = /^(?:\/cygdrive)?\/([a-zA-Z])(?=\/|$)/;

/**
 * `dir` resolved against `base`, as the shell the command came from reads it
 * (#1520). Every directory a rule resolves goes through here: a `cd`, a
 * `git -C`, a `pnpm -C`, a worktree path, a pathspec.
 *
 * On Windows, Git Bash spells a drive `/c/…` and hands native programs `C:/…`,
 * while `path.resolve` reads `/c/…` as a folder `c` at the root of the current
 * drive: `cd /c/…/master && pnpm build` was judged in a `C:\c\…` no deck link
 * points into, and passed. PowerShell reads `/c/…` exactly as `path.resolve`
 * does, and off Windows `/c` is a real directory, so only Git Bash on Windows
 * maps it. `platform` is injectable for tests and picks the path flavour too.
 */
export function resolveDir(base, dir, { shell = BASH, platform = process.platform } = {}) {
  const flavour = platform === "win32" ? path.win32 : path.posix;
  const drive = platform === "win32" && shell !== POWERSHELL && GIT_BASH_DRIVE.exec(dir);
  return flavour.resolve(base, drive ? `${drive[1].toUpperCase()}:${dir.slice(drive[0].length) || "/"}` : dir);
}

/** The argument `re` (a {@link QUOTED_ARG} regex) finds in `text[a, b)`, read from the raw `command`. */
function argIn(command, text, a, b, re) {
  const m = re.exec(text.slice(a, b));
  const at = m?.indices[2] ?? m?.indices[3] ?? m?.indices[4];
  return at && command.slice(a + at[0], a + at[1]);
}

/**
 * The working directory of the git command a rule matched: the session cwd,
 * moved by every `cd <dir>` chained AHEAD of that command, then by the
 * command's own `git -C <dir>`. Pass the rule's own `cmd(...)` regex as `re`
 * so the `-C` is read off the segment it matched and never off a later
 * command in the chain — `git worktree add ../ir-5 … && git -C ../ir-5 log`
 * used to resolve the new tree against itself, fail the repo-root lookup
 * there, and deny the add as "inside the repo". The `cd` walk is what lets a
 * session whose cwd is `master` be judged on the tree it pushes from:
 * `cd ../ir-1143 && git push` used to ask with "branch master".
 *
 * The chain is split, and each `cd` and `-C` found, in the trusted-masked text,
 * and the directory then read from the raw text at that spot — so a
 * `git -C ../master` quoted in a commit message moves nothing (#1321 review).
 * `shell` picks the `cd` spellings and the path reading ({@link resolveDir}).
 */
export function gitCwd(command, cwd, re, shell = BASH) {
  const text = trustedMask(command);
  const segs = ranges(text, CHAIN).filter(([a, b]) => command.slice(a, b).trim());
  const at = re ? segs.findIndex(([a, b]) => re.test(text.slice(a, b))) : -1;
  let base = cwd;
  for (const [a, b] of segs.slice(0, at >= 0 ? at : segs.length)) {
    const dir = argIn(command, text, a, b, cdRe(shell));
    if (dir && !HISTORY_DIR.has(dir)) base = resolveDir(base, dir, { shell });
  }
  const [a, b] = at >= 0 ? segs[at] : [0, command.length];
  const dir = argIn(command, text, a, b, GIT_C_RE);
  return dir ? resolveDir(base, dir, { shell }) : base;
}

/**
 * Every command `re` (a {@link cmd} regex) finds at command position, in chain
 * order, each with `base` — the session cwd moved by the `cd`s chained ahead of
 * it, as in {@link gitCwd} — and, read raw, `head` (the matched text) and
 * `args` (what follows it, up to the end of its command: a chain separator, a
 * lone `&`, a paren or a backtick in the masked text — a redirect's `&`, as in
 * `2>&1` or `&>log`, ends nothing). `at` is where `args` begins in `command`,
 * and `cut` the character that ended them before the chain separator, if one
 * did: a `(` or a backtick there means a substitution the shell computes, so
 * the command has words `args` does not hold. Where {@link gitCwd} judges the
 * first match, this judges each one, so a harmless first command cannot shield
 * a later one. The command's own `-C` is the caller's to read, since git and
 * pnpm spell it differently ({@link optionDir}).
 */
export function* chainCommands(command, cwd, re, shell = BASH) {
  const text = trustedMask(command);
  const global = new RegExp(re.source, [...new Set([...re.flags, "g"])].join(""));
  let base = cwd;
  for (const [a, b] of ranges(text, CHAIN)) {
    for (const m of text.slice(a, b).matchAll(global)) {
      const from = a + m.index + m[0].length;
      const stop = text.slice(from, b).search(COMMAND_END);
      const to = stop >= 0 ? from + stop : b;
      yield {
        base,
        head: command.slice(a + m.index, from),
        args: command.slice(from, to),
        at: from,
        cut: stop >= 0 ? text[to] : undefined,
      };
    }
    const dir = argIn(command, text, a, b, cdRe(shell));
    if (dir && !HISTORY_DIR.has(dir)) base = resolveDir(base, dir, { shell });
  }
}

/** `base` moved by the directory option `re` (a {@link QUOTED_ARG} regex) finds in `text`, read off its quotes. */
function optionDir(text, re, base, shell) {
  const m = re.exec(text);
  const dir = m && (m[2] ?? m[3] ?? m[4]);
  return dir ? resolveDir(base, dir, { shell }) : base;
}

/** Splits a command into rough words, respecting simple quotes. A value glued to its quote (`--x="a b"`) needs {@link shellWords}. */
export function words(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** An anchored rule ({@link cmd}) tests the trusted-masked text; an unanchored one, which must fire on any occurrence, the raw text. */
const has = (command, re) => re.test(re.anchored ? trustedMask(command) : command);

/**
 * What may stand between a command boundary and the command itself and still
 * leave it in command position: `VAR=value` assignments, the shell keywords
 * that open a command list (`if …; then gh pr merge …` would otherwise pass
 * every trap unchecked, #1307 review), and the wrappers that run the next
 * word as a command, with their own options — the ones that take a value
 * (`env -u NAME`, `env -C DIR`, `env -S STRING`, `exec -a NAME`,
 * `timeout -k 5`, `xargs -I {}`) with it, and `timeout`'s duration.
 * A value never starts with `-`, so every token has exactly one parse: were a
 * `-u` free to take the next `-u` as its value, a long run of them on a
 * command that does not match backtracks exponentially, and regex time is not
 * bounded by the hook's spawn deadline.
 *
 * A heuristic, not a shell parser: the hooks catch mistakes, not deliberate
 * obfuscation. A string handed to a shell (`bash -c`, `eval`) is not lexed —
 * the rules read the raw command then ({@link view}).
 */
const COMMAND_LEAD = String.raw`(?:(?:if|then|do|else|elif|while|until|!|\{)\s+|(?:time|command|exec|env|nohup)(?:\s+(?:-[uCSa]|--unset|--chdir|--split-string)\s+[^\s-]\S*|\s+-\S+)*\s+|timeout(?:\s+(?:-[ks]|--kill-after|--signal)\s+[^\s-]\S*|\s+-\S+)*\s+\d[\d.]*[smhd]?\s+|xargs(?:\s+-[IdEeLnPs]\s+[^\s-]\S*|\s+-\S+)*\s+|\w+=\S*\s+)*`;

/**
 * Anchors a command regex to COMMAND POSITION: the start of the string or of
 * a line (after any indent), or right after `|`, `;`, `&`, `(`, `)` or a
 * backtick, with any leading {@link COMMAND_LEAD}. Without this, a grep, an
 * echo or a docs edit that merely MENTIONS a trapped shape
 * (`grep 'pnpm exec vitest'`) would be denied.
 */
export function cmd(re) {
  const flags = new Set([...re.flags, "m"]);
  const anchored = new RegExp(
    String.raw`(?:^[ \t]*|[|;&()\x60]\s*)${COMMAND_LEAD}(?:${re.source})`,
    [...flags].join(""),
  );
  // Read by `has`: an anchored regex is tested on the trusted-masked text.
  anchored.anchored = true;
  return anchored;
}

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
 * split by {@link words}, as before #1321.
 */
export function parseMerge({ raw, flat, trusted }) {
  const tokens = trusted
    ? [...flat.matchAll(/\S+/g)].map((m) => ({ word: raw.slice(m.index, m.index + m[0].length), shape: m[0] }))
    : words(raw).map((w) => ({ word: w, shape: w }));
  const literal = (t) => t !== undefined && t.word === t.shape;
  const at = tokens.findIndex((t, k) => t.shape === "merge" && tokens[k - 1]?.shape === "pr");
  const flags = new Set();
  let ref;
  let pin;
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
    const eq = t.shape.indexOf("=");
    const name = eq > 0 ? t.shape.slice(0, eq) : t.shape;
    if (!MERGE_VALUE_FLAGS.has(name)) flags.add(name);
    else {
      const value = eq > 0 ? { word: t.word.slice(eq + 1), shape: t.shape.slice(eq + 1) } : tokens[++k];
      if (name === "--match-head-commit") pin = literal(value) ? value.word : undefined;
    }
  }
  return { ref, flags, pin, readable };
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
      const pr = ctx.prView(ref, ctx.cwd);
      if (!pr)
        return `Could not read the PR${ref ? ` "${ref}"` : " for this branch"} with gh; refusing to merge blind.`;
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

/**
 * The deck-host ask (#1520, narrowed to restarts and relinks by #1526). A
 * restart, a relink, a stop or a start is reached through a runner — pnpm,
 * npm, npx, a bare turbo, `node` on a root script or `node --run`, the
 * `rollup` whose watch hooks run a command, and a shell handed a command
 * string (`bash -c`, `cmd /c`, `pwsh -Command`, `eval`) — each found at
 * command position and read by its own `read(tokens, base, shell)` into the
 * runs it makes: `{ label, script, dir }`, a script or turbo task and the
 * directory it runs in. `DECK_ALWAYS` are the scripts that restart, relink,
 * stop, start or watch-and-restart whatever tree they run in;
 * `DECK_IF_LINKED` is `dev:voices`, which relinks only the hosts already
 * linked to its tree, so it matters only where a host's link points. A build,
 * an install or a clean is on neither list: a host keeps the plugin it loaded
 * until it restarts. The Stream Deck CLI the `restart:` / `link:` scripts wrap
 * is caught too, and so is a `taskkill`, `start` or `Start-Process` /
 * `Stop-Process` naming a host app. A runner's name may carry the `.cmd` /
 * `.exe` / `.ps1` PowerShell resolves it to.
 *
 * The names are only the floor. A run marked `expand` — a pnpm or npm script,
 * `node --run`, a turbo task — is also judged by the command line it runs,
 * read from the package.json of every package it may run in with the
 * arguments it forwards appended ({@link deckFindings}, {@link
 * runManifests}), so a script nobody has listed yet is judged by what it
 * reaches; a run carrying `lines` — a rollup watch hook, a shell's command
 * string — is judged by those command lines, each read as the shell that runs
 * it reads it (`as`, {@link lineAs}).
 */
const BIN = String.raw`(?:\.(?:cmd|exe|ps1))?(?=\s|$)`;
const PNPM = cmd(new RegExp(`pnpm${BIN}`));
const NPM = cmd(new RegExp(`npm${BIN}`));
const NPX = cmd(new RegExp(`npx${BIN}`));
const TURBO = cmd(new RegExp(String.raw`(?:\S*[\\/])?turbo${BIN}`));
const NODE = cmd(new RegExp(`node${BIN}`));
const ROLLUP = cmd(new RegExp(String.raw`(?:\S*[\\/])?rollup${BIN}`));
/**
 * The shells, and the commands, that run a string they are handed: bash and
 * its kin, cmd.exe, Windows PowerShell and pwsh, any case and with a path or
 * `.exe`; bash's `eval` and PowerShell's `Invoke-Expression` / `iex`.
 */
const SH_NAME = String.raw`(?:\S*[\\/])?(?:ba|z|da|k|fi)?sh(?:\.exe)?`;
const CMD_NAME = String.raw`(?:\S*[\\/])?cmd(?:\.exe)?`;
const PS_NAME = String.raw`(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?`;
const EVAL_NAME = String.raw`eval|invoke-expression|iex`;
const WRAPPER = cmd(new RegExp(String.raw`(?:${SH_NAME}|${CMD_NAME}|${PS_NAME}|${EVAL_NAME})(?=\s|$)`, "i"));
const isSh = (t) => new RegExp(`^${SH_NAME}$`, "i").test(t);
const isCmdExe = (t) => new RegExp(`^${CMD_NAME}$`, "i").test(t);
const isPowerShell = (t) => new RegExp(`^${PS_NAME}$`, "i").test(t);
const isEval = (t) => new RegExp(`^(?:${EVAL_NAME})$`, "i").test(t);
const isWrapper = (t) => isSh(t) || isCmdExe(t) || isPowerShell(t) || isEval(t);
const DECK_ALWAYS =
  /^(?:build:with-restart|build:stream-deck|(?:re|un)?link:.+|restart:.+|watch:.+|start:.+|stop:.+|switch-test-env(?::.+)?)$/;
const DECK_IF_LINKED = /^dev:voices$/;
const STREAMDECK_VERBS = /^(?:restart|stop|link|unlink)$/;
const STREAMDECK_CLI = cmd(
  new RegExp(String.raw`(?:\S*[\\/])?streamdeck(?:\.(?:cmd|exe|ps1))?\s+(?:restart|stop|link|unlink)\b`),
);
/** What stops or starts a process; it asks when its arguments name a host app ({@link HOST_APP}). */
const HOST_CONTROL = cmd(new RegExp(String.raw`(?:taskkill|start|start-process|saps|stop-process|spps)${BIN}`, "i"));
/** The deck host apps (`scripts/lib/deck-hosts.mjs`, and Elgato's own). */
const HOST_APP = /\b(?:StreamDeck|StreamDock|UlanziDeck|Ulanzi ?Studio|VSD ?Craft)(?:\.exe)?\b/i;
/** How deep a script's expansion follows the scripts it runs; past it the name is all that is judged. */
const MAX_SCRIPT_DEPTH = 8;

/** pnpm options whose value is the next word; `-C` / `--dir` move the directory and `--filter` picks packages, read on their own. */
const PNPM_VALUE = new Set(["--reporter", "--loglevel", "--workspace-concurrency"]);
const PNPM_FILTER = new Set(["--filter", "-F", "--filter-prod"]);
/** pnpm's own commands, which never run a package.json script of that name. */
const PNPM_BUILTIN =
  /^(?:install|i|add|remove|rm|uninstall|un|update|up|upgrade|link|ln|unlink|import|rebuild|rb|prune|fetch|dedupe|patch|outdated|list|ls|why|audit|licenses|store|root|bin|config|setup|env|init|publish|pack|deploy|create|self-update|server|doctor|approve-builds|ignored-builds)$/;
/** pnpm's `recursive` command and its aliases, which run what follows in every workspace package. */
const PNPM_RECURSIVE = /^(?:recursive|multi|m)$/;

const binName = (tool) => new RegExp(String.raw`^(?:\S*[\\/])?${tool}(?:@\S*)?(?:\.(?:cmd|exe|ps1))?$`);
/** Whether a word names the turbo binary: `turbo`, `turbo@2.5.0`, `node_modules/.bin/turbo.cmd`. */
const isTurbo = (t) => binName("turbo").test(t);
const isStreamdeck = (t) => binName("streamdeck").test(t) || /^@elgato\/cli(?:@\S*)?$/.test(t);
const isRollup = (t) => binName("rollup").test(t);
const isNode = (t) => binName("node").test(t);
/** The package runners themselves, which an `exec` / `dlx` / `npx` may run in turn. */
const isPnpm = (t) => binName("pnpm").test(t);
const isNpm = (t) => binName("npm").test(t);
const isNpx = (t) => binName("npx").test(t);
/**
 * The binaries a `pnpm <bin>`, `pnpm exec` / `dlx`, `npx` or `npm exec` may
 * run that this rule reads; a bare `pnpm <bin>` with no script of that name
 * runs the binary, as `pnpm exec` does.
 */
const isBinTool = (t) => isTurbo(t) || isStreamdeck(t) || isRollup(t) || isNode(t) || isWrapper(t);

/** The arguments a runner hands its script: what follows the script's name, less the `--` that separates them. */
function forwarded(tokens) {
  const at = tokens.indexOf("--");
  return at < 0 ? tokens : [...tokens.slice(0, at), ...tokens.slice(at + 1)];
}

/**
 * The scripts or tasks a pnpm invocation runs — past its global options, an
 * optional `recursive` and an optional `run` — in `base` moved by `-C` /
 * `--dir` (attached or not). A `pnpm turbo …`, `pnpm exec turbo …` or
 * `pnpm dlx turbo …` runs turbo's tasks there ({@link turboRuns}), and the
 * Stream Deck CLI, `rollup`, `node` or a shell likewise. `[]` when it runs
 * nothing (`pnpm --version`). A script is expanded unless it is one of pnpm's
 * own commands, read from the packages its selectors pick ({@link pnpmPicks}),
 * and what follows its name is appended to its command line, as pnpm does.
 *
 * pnpm reads its options anywhere ahead of the command, a cluster of short
 * ones (`-rc`) among them, and its `recursive` word after a `-r` too (#1526
 * second read: `pnpm -r recursive watch` read `recursive` as the script). A
 * `-c` / `--shell-mode` there puts `exec` in shell mode, as it does after
 * `exec` ({@link binRuns}), and so does a script name pnpm finds no script
 * for, which it runs as `exec` would: such a run is also judged as the command
 * line its words make.
 */
function pnpmRuns(tokens, base, shell) {
  let dir = base;
  let runSeen = false;
  let recursive = false;
  let recursiveWord = false;
  let workspaceRoot = false;
  let shellMode = false;
  const filters = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const attached = t.match(/^(?:--dir=|-C)(.+)$/);
    const filter = t.match(/^(?:--filter=|--filter-prod=|-F)(.+)$/);
    if (attached) dir = resolveDir(base, attached[1], { shell });
    else if (t === "-C" || t === "--dir") dir = tokens[i + 1] ? resolveDir(base, tokens[++i], { shell }) : dir;
    else if (filter) filters.push(filter[1]);
    else if (PNPM_FILTER.has(t)) {
      if (tokens[i + 1]) filters.push(tokens[++i]);
    } else if (PNPM_VALUE.has(t)) i++;
    else if (t === "-r" || t === "--recursive") recursive = true;
    else if (t === "-w" || t === "--workspace-root") workspaceRoot = true;
    else if (t === "-c" || t === "--shell-mode") shellMode = true;
    else if (/^-[a-z]{2,}$/.test(t)) {
      recursive ||= t.includes("r");
      workspaceRoot ||= t.includes("w");
      shellMode ||= t.includes("c");
    } else if (t.startsWith("-")) continue;
    else if (PNPM_RECURSIVE.test(t) && !runSeen && !recursiveWord) recursive = recursiveWord = true;
    else if ((t === "run" || t === "run-script") && !runSeen) runSeen = true;
    else if (isBinTool(t) && !runSeen) return binRuns(tokens.slice(i), dir, shell, shellMode);
    else if ((t === "exec" || t === "dlx") && !runSeen) return binRuns(tokens.slice(i + 1), dir, shell, shellMode);
    else {
      const run = {
        label: `pnpm ${t}`,
        script: t,
        dir,
        expand: runSeen || !PNPM_BUILTIN.test(t),
        picks: pnpmPicks({ filters, recursive, workspaceRoot }, dir, shell),
        args: forwarded(tokens.slice(i + 1)),
        selector: SCRIPT_SELECTOR.test(t),
      };
      const fallback = shellMode && !runSeen && !PNPM_BUILTIN.test(t);
      return fallback ? [run, ...binRuns(tokens.slice(i), dir, shell, true)] : [run];
    }
  }
  return [];
}

/**
 * Which packages a pnpm script is read from (#1526 review), as picks for
 * {@link runManifests}; `undefined` for the nearest package.json, which is
 * pnpm's own choice when nothing selects. A `--filter` pnpm resolves by name
 * or by path is resolved the same way; one the hook cannot resolve — a
 * dependency (`foo...`, `...foo`, `^`) or changed-since (`[ref]`) query, a
 * glob path, anything else — picks every package, and so does `-r` or a
 * filter list that only excludes (`!foo`), whose exclusions are not
 * subtracted. Over-reach, never a miss: until #1526's review such a run was
 * judged by its name alone, and the Stream Deck plugin's `watch` restarted
 * the host unprompted through `pnpm -r watch`. `-w` reads the root's script.
 * A filter's path is read from `dir`, which a `-C` anywhere sets.
 */
function pnpmPicks({ filters, recursive, workspaceRoot }, dir, shell) {
  const picks = [];
  if (workspaceRoot) picks.push({ root: true });
  const included = filters.filter((f) => !f.startsWith("!"));
  for (const f of included) picks.push(pnpmFilter(f, dir, shell));
  if ((recursive && !filters.length) || (filters.length && !included.length)) picks.push({ every: true });
  return picks.length ? picks : undefined;
}

/**
 * One pnpm `--filter` as a pick: `{ path }` for a location (`.`, `./…`,
 * `../…`, `{…}`), which pnpm reads as every package at or under it; `{ name }`
 * for a name pattern, `*` its one wildcard; `{ every }` for anything the hook
 * cannot resolve.
 */
function pnpmFilter(f, dir, shell) {
  if (/\.\.\.|\^|\[/.test(f)) return { every: true };
  const braced = f.match(/^\{([^{}]+)\}$/);
  const location = braced ? braced[1] : /^\.\.?(?:[\\/]|$)/.test(f) ? f : undefined;
  if (location !== undefined)
    return /[*?{}]/.test(location) ? { every: true } : { path: resolveDir(dir, location, { shell }) };
  return /^(?:@[\w.*-]+\/)?[\w.*-]+$/.test(f) ? { name: f } : { every: true };
}

/** npm options whose value is the next word; `--prefix` / `-C` move the directory and `-w` / `--workspace` picks packages, read on their own. */
const NPM_VALUE = new Set(["--loglevel", "--cache", "--userconfig", "--registry"]);
/** `npm exec`, `npx`, `pnpm exec` and `pnpm dlx` options whose value is the next word. */
const BIN_VALUE = new Set(["-p", "--package", "-w", "--workspace"]);

/**
 * What an npm invocation runs: a script (`npm run <s>`, `run-script`) or a
 * binary through `npm exec`; an install builds nothing a host has loaded
 * (#1526). The directory is `base` moved by `--prefix` / `-C`, which npm
 * reads anywhere before `--`. A script is expanded, with every word after its
 * name appended — npm hands the script only those after `--`, so this
 * over-reaches rather than misses — and read from the workspaces a `-w` /
 * `--workspace` names, by name or by path, or from every package for
 * `--workspaces` / `-ws` (#1526 review), the root's included, since
 * `include-workspace-root` may be set where the hook does not read it.
 *
 * `--call` / `-c` is a config flag like the rest, read anywhere before `--`,
 * and takes a value — the next word or `--call=…` (#1526 second read: `npm
 * --call "pnpm restart:stream-deck" exec` read the line as the verb). An
 * `exec` it comes ahead of runs that line in a shell; one after `exec` is the
 * exec's own option, read there ({@link binRuns}).
 */
function npmRuns(tokens, base, shell) {
  const end = tokens.indexOf("--") < 0 ? tokens.length : tokens.indexOf("--");
  let dir = base;
  const picks = [];
  let withRoot = false;
  const positional = [];
  const calls = [];
  for (let i = 0; i < end; i++) {
    const t = tokens[i];
    const attached = t.match(/^--prefix=(.+)$/);
    const workspace = t.match(/^--workspace=(.+)$/);
    const callValue = t.match(/^--call=([\s\S]*)$/);
    if (callValue) calls.push({ at: i, line: callValue[1] });
    else if (t === "--call" || t === "-c") {
      if (i + 1 < end) calls.push({ at: i, line: tokens[++i] });
    } else if (attached) dir = resolveDir(base, attached[1], { shell });
    else if (t === "--prefix" || t === "-C") dir = tokens[i + 1] ? resolveDir(base, tokens[++i], { shell }) : dir;
    else if (workspace) picks.push({ workspace: workspace[1], shell });
    else if (t === "-w" || t === "--workspace") {
      if (tokens[i + 1]) picks.push({ workspace: tokens[++i], shell });
    } else if (NPM_VALUE.has(t)) i++;
    else if (/^(?:--workspaces(?:=(?!false$).*)?|-ws)$/.test(t)) picks.push({ every: true });
    else if (t === "--include-workspace-root") withRoot = true;
    else if (!t.startsWith("-")) positional.push(i);
  }
  if (withRoot && picks.length) picks.push({ root: true });
  if (!positional.length) return [];
  const verb = tokens[positional[0]];
  if (/^(?:run|run-script|rum|urn)$/.test(verb)) {
    const script = tokens[positional[1]];
    const args = forwarded(tokens.slice(positional[1] + 1));
    const run = {
      label: `npm run ${script}`,
      script,
      dir,
      expand: true,
      picks: picks.length ? picks : undefined,
      args,
    };
    return script ? [run] : [];
  }
  if (!/^(?:exec|x)$/.test(verb)) return [];
  const ahead = calls.filter((c) => c.at < positional[0]);
  return [
    ...ahead.flatMap((c) => shellModeLine("npm --call", [c.line], dir)),
    ...binRuns(tokens.slice(positional[0] + 1), dir, shell),
  ];
}

/**
 * The binary an `exec` / `dlx` / `npx` runs, past its own options and a `--`:
 * turbo's tasks when it is turbo, the Stream Deck CLI's verb, rollup's watch
 * hooks, what `node` runs ({@link nodeRuns}, #1526 review), a shell's command
 * string ({@link wrapperRuns}), what a nested `pnpm`, `npm` or `npx` runs, read
 * by its own reader (#1526 PR review), nothing otherwise — a command is judged by the
 * tool that runs it, and a `tsc` or `prettier` restarts nothing. `-c` /
 * `--call` (npm, npx) and `--shell-mode` (pnpm, whose `-c` is the same), alone
 * or in a cluster of short options, run a command line in a shell instead of a
 * binary: npm takes it as the next word, pnpm as every word after the flag, so
 * the line is all of them, which over-reaches for npm rather than misses for
 * pnpm. `shellMode` is that flag met earlier — pnpm's ahead of `exec`
 * ({@link pnpmRuns}) — and makes the line of every word here. Either way the
 * line starts past a `--` and the exec options ahead of the command
 * ({@link shellModeLine}), which pnpm does not hand the shell.
 */
function binRuns(tokens, dir, shell, shellMode = false) {
  if (shellMode) return shellModeLine("exec --shell-mode", tokens, dir);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const call = t.match(/^(?:-c|--call|--shell-mode)(?:=([\s\S]*))?$/);
    if (call) return shellModeLine(`exec ${t.replace(/=[\s\S]*$/, "")}`, [call[1] ?? "", ...tokens.slice(i + 1)], dir);
    if (/^-[a-z]{2,}$/.test(t) && t.includes("c")) return shellModeLine(`exec ${t}`, tokens.slice(i + 1), dir);
    if (BIN_VALUE.has(t)) i++;
    else if (t === "--" || t.startsWith("-")) continue;
    else if (isTurbo(t)) return turboRuns(tokens.slice(i + 1), dir, shell);
    else if (isStreamdeck(t)) return streamdeckRuns(tokens.slice(i + 1), dir);
    else if (isRollup(t)) return rollupRuns(tokens.slice(i + 1), dir);
    else if (isNode(t)) return nodeRuns(tokens.slice(i + 1), dir, shell);
    else if (isWrapper(t)) return wrapperRuns(tokens.slice(i), dir, shell);
    else if (isPnpm(t)) return pnpmRuns(tokens.slice(i + 1), dir, shell);
    else if (isNpm(t)) return npmRuns(tokens.slice(i + 1), dir, shell);
    else if (isNpx(t)) return binRuns(tokens.slice(i + 1), dir, shell);
    else return [];
  }
  return [];
}

/** The exec options whose value is the next word, skipped with it ahead of a shell-mode line ({@link shellModeLine}). */
const SHELL_MODE_VALUE = new Set([...BIN_VALUE, ...PNPM_VALUE, ...PNPM_FILTER, "--resume-from"]);

/**
 * The command line a shell-mode exec runs: its words joined, past a leading
 * `--`. When options lead — pnpm's `exec --parallel -c …`, which pnpm reads as
 * its own — the line past them, values and a `--` included, is judged too:
 * both are, so a word mistaken for an option over-reaches rather than hides
 * the command (#1526 second read).
 */
function shellModeLine(label, words, dir) {
  const all = words.filter((w) => w !== "");
  const rest = all[0] === "--" ? all.slice(1) : all;
  let at = 0;
  while (at < rest.length && /^-\S*$/.test(rest[at])) at += SHELL_MODE_VALUE.has(rest[at]) ? 2 : 1;
  const lines = [...new Set([rest, rest.slice(at)].map((w) => w.join(" ")))].filter((l) => l.trim());
  return lines.length ? [{ label, dir, lines }] : [];
}

/** The Stream Deck CLI's `restart`, `stop`, `link` and `unlink`, reached through a runner rather than at command position. */
function streamdeckRuns(tokens, dir) {
  const verb = tokens.find((t) => !t.startsWith("-"));
  return verb && STREAMDECK_VERBS.test(verb)
    ? [{ label: `streamdeck ${verb}`, script: verb, dir, always: true, why: "restarts or relinks a deck host" }]
    : [];
}

/**
 * rollup's watch hooks (#1526), each a command line rollup runs at that point
 * of a watch — the Stream Deck plugin's `watch` restarts the host on every
 * rebuild through `--watch.onEnd="streamdeck restart …"`. The value is
 * attached with `=` or the next word, and is judged as a command run in `dir`.
 * Matched in any case and with rollup's kebab spelling too, so a spelling
 * rollup may accept is read rather than missed.
 */
const ROLLUP_HOOK = /^(--watch\.on-?(?:start|bundle-?start|bundle-?end|end|error))(?:=([\s\S]*))?$/i;

function rollupRuns(tokens, dir) {
  const runs = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i].match(ROLLUP_HOOK);
    if (!m) continue;
    const line = m[2] ?? tokens[++i];
    if (line) runs.push({ label: `rollup ${m[1]}`, dir, lines: [line] });
  }
  return runs;
}

/** turbo options whose value is the next word; `--cwd` moves the directory and is read on its own. */
const TURBO_VALUE = new Set([
  "--filter",
  "-F",
  "--concurrency",
  "--cache-dir",
  "--log-order",
  "--output-logs",
  "--env-mode",
  "--ui",
  "--cache",
  "--log-prefix",
  "--graph",
  "--summarize",
  "--profile",
]);

/**
 * The tasks a turbo invocation runs — `turbo run <tasks>`, `turbo watch <tasks>`
 * or the `turbo <tasks>` shorthand — in `dir` moved by `--cwd`. A subcommand
 * that is no task (`prune`, `ls`, `login`) is read as one and matches no rule.
 * Each task is expanded into every workspace package's script of that name,
 * with what follows a `--` appended, as turbo hands it to every task: a
 * `--filter` is not read, so the expansion over-reaches rather than misses.
 */
function turboRuns(tokens, dir, shell) {
  let at = dir;
  const positional = [];
  let args = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") {
      args = tokens.slice(i + 1);
      break;
    }
    const attached = t.match(/^--cwd=(.+)$/);
    if (attached) at = resolveDir(dir, attached[1], { shell });
    else if (t === "--cwd") at = tokens[i + 1] ? resolveDir(dir, tokens[++i], { shell }) : at;
    else if (TURBO_VALUE.has(t)) i++;
    else if (!t.startsWith("-")) positional.push(t);
  }
  const tasks = /^(?:run|watch)$/.test(positional[0] ?? "") ? positional.slice(1) : positional;
  return tasks.map((task) => ({ label: `turbo run ${task}`, script: task, dir: at, expand: true, turbo: true, args }));
}

/**
 * The root scripts a pnpm script wraps, run through `node` (#1520): the ones
 * that restart, relink, stop or start a host always ask, as their pnpm scripts
 * do. `integration-build` asks only with `--restart` ahead of any `--` (#1526):
 * without it the build leaves every host running the plugin it loaded, and
 * with it the hosts linked to its tree are stopped and started; it is a strict
 * `parseArgs` boolean, so `--restart` is the one spelling — and so a word
 * ahead of the `--` that the shell computes (`$R`, `$(…)`, a backtick,
 * cmd.exe's `%R%`) may be it, and asks too (#1526 review). So does one the
 * shell rewrites (#1526 second read): a word that is `--restart` once its
 * escapes are gone ({@link unescaped}: a `\` left inside double quotes, which
 * a PowerShell backtick escape arrives as, or cmd.exe's `^`), a bash brace
 * expansion or glob, and a PowerShell splat (`@a`, `@(…)`). None of these
 * characters can be in a branch name (`git check-ref-format`), so a branch
 * that merely holds the word `restart` still passes. `dev-voices`
 * rebuilds and relinks the hosts already linked to its own tree, so it asks
 * where linked, and both the cwd and the script's own tree are judged.
 * `node --run <script>` runs a package.json script, judged as `pnpm <script>` is.
 */
const NODE_ALWAYS = /^(?:build-with-restart|(?:un)?link-(?:mirabox|ulanzi))$/;
/**
 * A word holding an expansion the hook cannot evaluate, {@link UNREAD} among
 * them: a variable, a substitution, cmd.exe's `%R%`, a brace expansion
 * (`--{restart,}`, `{a..b}`) or a glob (`*`, `?`, `[`).
 */
const COMPUTED = /[$\x60*?[]|%[^%\s]+%|\{[^{}]*(?:,|\.\.)[^{}]*\}/;
/** A PowerShell splat, `@name` or an array `@(…)`, which hands the command words the hook cannot see. */
const PS_SPLAT = /^@[\w(]/;
/**
 * A word with the escapes a shell may leave in it removed: a `\` — bash keeps
 * one before an ordinary character inside double quotes, where a PowerShell
 * backtick escape arrives as one ({@link powershellAsBash}) — and cmd.exe's
 * `^`, which a package.json script line runs under. Neither is in a branch
 * name or a script name, so stripping them over-reaches and never misses.
 */
const unescaped = (w) => w.replace(/[\\^]/g, "");

function nodeRuns(tokens, base, shell) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const attached = t.match(/^--run=(.+)$/);
    const script = attached ? attached[1] : t === "--run" ? tokens[i + 1] : undefined;
    if (script) {
      const args = forwarded(tokens.slice(attached ? i + 1 : i + 2));
      return [{ label: `node --run ${script}`, script, dir: base, expand: true, args }];
    }
    if (t === "--run" || !t.startsWith("-")) break;
  }
  const at = tokens.findIndex((t) => !t.startsWith("-"));
  const file = tokens[at];
  const m = file?.match(/^(?:(.*)[\\/])?([\w-]+)\.mjs$/);
  if (!m) return [];
  const label = `node ${file}`;
  const args = tokens.slice(at + 1);
  if (NODE_ALWAYS.test(m[2])) return [{ label, script: m[2], dir: base, always: true }];
  if (m[2] === "integration-build") {
    const end = args.indexOf("--");
    const own = end < 0 ? args : args.slice(0, end);
    const computed = own.find((t) => COMPUTED.test(t) || (shell === POWERSHELL && PS_SPLAT.test(t)));
    if (own.some((t) => unescaped(t) === "--restart"))
      return [
        {
          label: `${label} --restart`,
          script: m[2],
          dir: base,
          always: true,
          why: "stops and starts the deck hosts linked to its tree",
        },
      ];
    return computed
      ? [
          {
            label: `${label} ${computed}`,
            script: m[2],
            dir: base,
            always: true,
            why: "may stop and start the deck hosts linked to its tree: its flags could not be read",
          },
        ]
      : [];
  }
  if (m[2] === "host-app") {
    const action = args.find((t) => !t.startsWith("-"));
    return /^(?:start|stop)$/.test(action ?? "")
      ? [{ label: `${label} ${action}`, script: m[2], dir: base, always: true, why: "stops or starts a deck host app" }]
      : [];
  }
  if (m[2] !== "dev-voices") return [];
  return [
    { label, script: "dev:voices", dir: base },
    { label, script: "dev:voices", dir: resolveDir(base, m[1] ?? ".", { shell }) },
  ];
}

/**
 * A shell or command handed a string to run (#1526 review), `tokens[0]` its
 * name: the string is a command line, judged as the shell that runs it reads
 * it ({@link lineAs}), as a rollup watch hook's is. Only these commands' own
 * command arguments are read — never a quoted string merely because it is
 * quoted, so `git commit -m "… pnpm restart:stream-deck …"` stays a mention.
 *
 * - bash, sh and their kin ({@link shRuns}): the word after the options when
 *   one of them is `-c`.
 * - cmd.exe: every word after `/c` or `/k` (`//c` from Git Bash, which would
 *   turn `/c` into a path), read as cmd.exe reads it.
 * - Windows PowerShell and pwsh ({@link powershellRuns}).
 * - `eval`: its words joined, read as bash; `Invoke-Expression` / `iex`:
 *   likewise past a `-Command`, read as PowerShell.
 */
function wrapperRuns(tokens, dir, shell) {
  const [name, ...words] = tokens;
  if (isPowerShell(name)) return powershellRuns(name, words, dir, shell);
  if (isSh(name)) return shRuns(name, words, dir);
  if (isCmdExe(name)) {
    const at = words.findIndex((w) => /^\/\/?[ck]/i.test(w));
    const m = at >= 0 ? words[at].match(/^\/\/?([ck])([\s\S]*)$/i) : null;
    return m ? lineRun(`${name} /${m[1].toLowerCase()}`, dir, [m[2], ...words.slice(at + 1)]) : [];
  }
  if (/^eval$/i.test(name)) return lineRun(name, dir, words, BASH);
  return lineRun(name, dir, /^-c/i.test(words[0] ?? "") ? words.slice(1) : words, POWERSHELL);
}

/** The run of a command line made of `words` joined, read as `as` reads it; none for an empty line. */
function lineRun(label, dir, words, as) {
  const line = words.filter((w) => w !== "").join(" ");
  return line.trim() ? [{ label, dir, lines: [line], as }] : [];
}

/**
 * bash, sh, zsh, dash, ksh or fish handed a string: `-c`, alone or in a
 * cluster (`-lc`, `-ec`), makes the first word after the options the line,
 * read as bash; `-o` / `+o` / `-O` / `+O`, `--rcfile` and `--init-file` take a
 * value, and fish's `--command` carries the line itself. A shell run on a file
 * or on its stdin runs nothing the hook can read.
 */
function shRuns(name, words, dir) {
  let command = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const long = w.match(/^--command(?:=([\s\S]*))?$/);
    if (long) return lineRun(`${name} --command`, dir, [long[1] ?? words[i + 1] ?? ""], BASH);
    if (w === "--") return command ? lineRun(`${name} -c`, dir, [words[i + 1] ?? ""], BASH) : [];
    if (/^[-+][oO]$/.test(w) || w === "--rcfile" || w === "--init-file") i++;
    else if (/^-[A-Za-z]+$/.test(w)) command ||= w.includes("c");
    else if (!/^[-+]/.test(w)) return command ? lineRun(`${name} -c`, dir, [w], BASH) : [];
  }
  return [];
}

/** Whether `p` spells PowerShell's parameter `full` — at least its first `min` letters, as `pwsh` accepts an unambiguous prefix. */
const spells = (p, full, min) => p.length >= min && full.startsWith(p);
/** PowerShell's command-line parameters that take a value, besides the ones read on their own. */
const PS_VALUE_PARAMS = [
  ["executionpolicy", 2],
  ["ep", 2],
  ["windowstyle", 1],
  ["inputformat", 3],
  ["if", 2],
  ["outputformat", 1],
  ["of", 2],
  ["configurationname", 6],
  ["configurationfile", 6],
  ["custompipename", 2],
  ["settingsfile", 2],
  ["psconsolefile", 2],
  ["version", 1],
  ["encodedarguments", 8],
  ["ea", 2],
];

/**
 * Windows PowerShell or pwsh handed a string, read as PowerShell: every word
 * after `-Command` (`-c`, any unambiguous prefix, `-CommandWithArgs`, with `-`,
 * `--` or `/`) is the line, and so is the decoded base64 UTF-16 of
 * `-EncodedCommand` (`-e`, `-ec`); `-File` runs a file the hook cannot read.
 * With none of them the first word that is no option starts the line —
 * powershell.exe's default, which over-reaches for pwsh's. When one of them
 * follows such a word, that word may be the value of an option this reader
 * does not know, so both lines are judged. `-WorkingDirectory` (`-wd`) ahead
 * of them moves where the line runs.
 */
function powershellRuns(name, words, dir, shell) {
  const param = (w) => {
    const m = w.match(/^(?:--?|\/)([A-Za-z]+)(?::([\s\S]*))?$/);
    return m && { p: m[1].toLowerCase(), value: m[2] };
  };
  const kind = (p) =>
    p === "c" || p === "cwa" || spells(p, "commandwithargs", 3)
      ? "command"
      : p === "e" || p === "ec" || spells(p, "encodedcommand", 2)
        ? "encoded"
        : spells(p, "file", 1)
          ? "file"
          : p === "wd" || spells(p, "workingdirectory", 2)
            ? "dir"
            : PS_VALUE_PARAMS.some(([full, min]) => spells(p, full, min))
              ? "value"
              : "switch";
  const explicit = words.some((w) => /^(?:command|encoded|file)$/.test(kind(param(w)?.p ?? "")));
  const runs = [];
  let at = dir;
  for (let i = 0; i < words.length; i++) {
    const opt = param(words[i]);
    if (!opt) {
      if (!runs.length) runs.push(...lineRun(name, at, words.slice(i), POWERSHELL));
      if (explicit) continue;
      return runs;
    }
    const k = kind(opt.p);
    const value = opt.value ?? words[i + 1];
    if (k === "command")
      return [...runs, ...lineRun(`${name} -Command`, at, [opt.value ?? "", ...words.slice(i + 1)], POWERSHELL)];
    if (k === "encoded") {
      if (!/^[A-Za-z0-9+/]+=*$/.test(value ?? "")) return runs;
      const line = Buffer.from(value, "base64").toString("utf16le");
      return [...runs, ...lineRun(`${name} -EncodedCommand`, at, [line], POWERSHELL)];
    }
    if (k === "file") return runs;
    if (k === "dir" && value) at = resolveDir(dir, value, { shell });
    if ((k === "dir" || k === "value") && opt.value === undefined) i++;
  }
  return runs;
}

/**
 * The words of the command whose arguments start at `from` in `text`, read as
 * bash reads them up to the end of that command — an unquoted newline, `;`,
 * `|`, `)`, backtick, or a `&` that is no redirect's: quotes removed, `\`
 * escapes applied and `$'…'` decoded. A shell wrapper's command string is one
 * of these words, which {@link chainCommands}' `args` cannot give whole: the
 * mask is not trusted where a shell is fed a string ({@link view}), so the
 * chain is split in the raw text, inside the string too.
 */
function commandWords(text, from) {
  const out = [];
  let word;
  const add = (s) => (word = (word ?? "") + s);
  const ANSI = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      if (text[i + 1] !== "\n") add(text[i + 1] ?? "");
      i++;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      add(text.slice(i + 1, end < 0 ? text.length : end));
      i = end < 0 ? text.length : end;
    } else if (ch === "$" && text[i + 1] === "'") {
      let k = i + 2;
      let s = "";
      for (; k < text.length && text[k] !== "'"; k++)
        s += text[k] === "\\" ? (ANSI[text[++k]] ?? text[k] ?? "") : text[k];
      add(s);
      i = k;
    } else if (ch === '"') {
      let k = i + 1;
      let s = "";
      for (; k < text.length && text[k] !== '"'; k++)
        if (text[k] === "\\" && '"\\$`\n'.includes(text[k + 1] ?? "x")) s += text[++k] === "\n" ? "" : text[k];
        else s += text[k];
      add(s);
      i = k;
    } else if (/[\n;|)\x60]/.test(ch) || (ch === "&" && !/[<>]/.test(text[i - 1] ?? "") && text[i + 1] !== ">")) break;
    else if (ch === " " || ch === "\t") {
      if (word !== undefined) out.push(word);
      word = undefined;
    } else add(ch);
  }
  if (word !== undefined) out.push(word);
  return out;
}

/**
 * Where the deck rule's words come from: `shellWords(args)` for a runner, or
 * — `whole` — {@link commandWords} from where its arguments start, preceded by
 * the command's own name, for a shell wrapper whose string must stay one word.
 */
const RUNNERS = [
  { re: PNPM, read: pnpmRuns },
  { re: NPM, read: npmRuns },
  { re: NPX, read: binRuns },
  { re: TURBO, read: turboRuns },
  { re: NODE, read: nodeRuns },
  { re: ROLLUP, read: rollupRuns },
  { re: WRAPPER, read: wrapperRuns, whole: true },
];

/**
 * The word that stands for the words a substitution cut off ({@link
 * chainCommands}' `cut`): the hook cannot read them, and a reader that must see
 * every argument — integration-build's `--restart` — finds this one instead.
 */
const UNREAD = "$(…)";

/**
 * A command's words as the shell joins them: quoted and bare pieces with no
 * space between are one word, `--watch.onEnd="streamdeck restart x"` among
 * them, which {@link words} would split at the quote. A lone unmatched quote
 * stays a character of its word. A backslash escapes as bash reads it (#1526
 * second read): outside quotes it escapes the next character, a space
 * included, so `pnpm re\start:stream-deck` runs `restart:stream-deck`; inside
 * double quotes only before `$`, a backtick, `"`, `\` or a newline; inside
 * single quotes never. A script line's `\` is already `/` ({@link lineAs}),
 * and a PowerShell backtick escape of an ordinary character arrives as one
 * ({@link powershellAsBash}).
 *
 * @internal Exported for testing
 */
export function shellWords(command) {
  return [...command.matchAll(/(?:"(?:[^"\\]|\\[\s\S])*"|'[^']*'|\\[\s\S]?|[^\s"'\\]+|["'])+/g)].map((m) =>
    m[0].replace(
      /"((?:[^"\\]|\\[\s\S])*)"|'([^']*)'|\\([\s\S]?)/g,
      (_, d, s, e) =>
        d?.replace(/\\([$\x60"\\\n])/g, (_m, c) => (c === "\n" ? "" : c)) ?? s ?? (e === "\n" ? "" : e || "\\"),
    ),
  );
}

/**
 * Every reason the commands of `c`, run from `cwd`, need Niklas's go (#1520,
 * #1526): the deck-host rule's whole judgement, recursive so a script — or a
 * rollup watch hook, or a shell's command string — is judged by what it runs.
 * `trail` holds the `<package dir>\0<script>` keys being expanded, which is
 * both the depth ({@link MAX_SCRIPT_DEPTH}) and the cycle guard. A script the
 * hook cannot read — no `ctx.scriptsAt`, no package.json, no such script — is
 * judged by its name alone; a selector it cannot resolve reads every package
 * instead ({@link runManifests}).
 */
function deckFindings(c, cwd, ctx, shell, trail = []) {
  const found = [];
  const links = ctx.linkTargets().filter((l) => l.target);
  for (const m of matchesAt(c, STREAMDECK_CLI)) found.push(`\`${m[0].trim()}\` restarts or relinks a deck host`);
  for (const { head, args } of chainCommands(c, cwd, HOST_CONTROL, shell)) {
    const app = args.match(HOST_APP);
    if (app) found.push(`\`${head.replace(/^[\s|;&()`]+/, "").trim()} … ${app[0]}\` stops or starts a deck host app`);
  }
  for (const { re, read, whole } of RUNNERS)
    for (const { base, head, args, at, cut } of chainCommands(c, cwd, re, shell)) {
      const tokens = whole ? [head.match(/[^\s|;&()\x60]+$/)?.[0] ?? "", ...commandWords(c, at)] : shellWords(args);
      // A substitution cut the arguments short: it and what follows it are
      // unread. Glued to a word (`$(`, `--x=\``), it ends that word.
      if (!whole && (cut === "(" || cut === "\x60"))
        if (tokens.length && !/\s$/.test(args)) tokens.push(tokens.pop().replace(/\$$/, "") + UNREAD);
        else tokens.push(UNREAD);
      for (const run of read(tokens, base, shell).flatMap((r) => selectedRuns(r, ctx, found))) {
        // A name is judged with its leftover escapes gone ({@link unescaped}):
        // `pnpm "re\`start:stream-deck"` in PowerShell runs the script.
        const name = unescaped(run.script ?? "");
        if (run.always || DECK_ALWAYS.test(name)) {
          found.push(`\`${run.label}\` ${run.why ?? "restarts or relinks a deck host"}`);
          continue;
        }
        if (DECK_IF_LINKED.test(name)) {
          const root = ctx.toplevel?.(run.dir) ?? run.dir;
          const held = links.filter((l) => ctx.isInside(l.target, root));
          if (held.length) {
            found.push(
              `${held.map((l) => l.host).join(" and ")} plugin link points into ${root}: \`${run.label}\` there relinks the running plugin`,
            );
            continue;
          }
        }
        if (trail.length >= MAX_SCRIPT_DEPTH) continue;
        // A hook's or a shell's command line is no script: it has no key a
        // cycle could repeat, so its empty one only counts towards the depth.
        const lines = run.lines?.map((line) => ({ dir: run.dir, line, key: "", as: run.as })) ?? [];
        if (run.expand) lines.push(...scriptLines(run, ctx));
        for (const { dir, line, key, as } of lines) {
          if (key && trail.includes(key)) continue;
          const [text, lineShell] = lineAs(line, as);
          for (const f of deckFindings(text, dir, ctx, lineShell, [...trail, key]))
            found.push(`\`${run.label}\` → ${f}`);
        }
      }
    }
  return found;
}

/** A pnpm script selector, `/<regex>/`: pnpm runs every script whose name the pattern matches. */
const SCRIPT_SELECTOR = /^\/(.+)\/$/;

/**
 * The runs a pnpm script selector stands for (#1526 PR review): `pnpm run
 * "/^restart:/"` runs `restart:stream-deck`, which the hook would otherwise
 * look up as a script literally named `/^restart:/`. Each script the pattern
 * matches in the run's manifests ({@link runManifests}) becomes a run of its
 * own, judged by name and by what it runs. A pattern the hook cannot read — not
 * a valid regex, or no manifest to match it against — is a finding in itself,
 * pushed onto `found`, since it may select a restart. Any other run is itself.
 */
function selectedRuns(run, ctx, found) {
  if (!run.selector) return [run];
  let re;
  try {
    re = new RegExp(run.script.match(SCRIPT_SELECTOR)[1]);
  } catch {
    re = null;
  }
  const manifests = re && ctx.scriptsAt ? runManifests(run, ctx).filter(Boolean) : [];
  if (!manifests.length) {
    found.push(`\`${run.label}\` runs every script its pattern matches, which could not be read`);
    return [];
  }
  const names = [...new Set(manifests.flatMap((m) => Object.keys(m.scripts ?? {})))].filter((n) => re.test(n));
  return names.map((name) => ({ ...run, script: name, label: `pnpm ${name} (${run.script})`, selector: false }));
}

/**
 * A command line a run hands on, as the hook lexes it, with the shell it is
 * judged as. A package.json script, a rollup hook and a `cmd /c` string (`as`
 * unset) run under cmd.exe on Windows, where `\` is a path separator and no
 * escape: read as `/` so the bash lexer keeps it. A bash string is lexed as it
 * stands, and a PowerShell one through {@link powershellAsBash}.
 */
function lineAs(line, as) {
  if (as === POWERSHELL) return [powershellAsBash(line), POWERSHELL];
  return [as === BASH ? line : line.replace(/\\/g, "/"), BASH];
}

/**
 * A forwarded word as the appended command line spells it: bare when it is
 * plain, otherwise single-quoted with each `'` written `'"'"'` — closed,
 * double-quoted, reopened — so the line lexes as the shell reads it and
 * {@link shellWords} gives the word back whole (#1526 review: a word holding
 * both quote kinds was wrapped in bare double quotes, and its own quotes
 * unbalanced the line). A backslash escape would not survive: a script line's
 * `\` is read as `/` ({@link lineAs}).
 *
 * @internal Exported for testing
 */
export const shellQuote = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'"'"'`)}'`);

/**
 * The command lines an expandable run executes, each with the package
 * directory it runs in ({@link runManifests}). The words the runner forwards
 * are appended to each line, as the runner does.
 */
function scriptLines(run, ctx) {
  if (!ctx.scriptsAt) return [];
  const tail = run.args?.length ? ` ${run.args.map(shellQuote).join(" ")}` : "";
  return runManifests(run, ctx)
    .filter((m) => m && typeof m.scripts?.[run.script] === "string")
    .map((m) => ({ dir: m.dir, line: m.scripts[run.script] + tail, key: `${m.dir}\0${run.script}` }));
}

/**
 * The package.json manifests a run's script may be read from: a turbo task's
 * in every workspace package of the tree, any other script's in the nearest
 * package.json above its directory — unless the runner's selectors pick
 * packages (`run.picks`, {@link pnpmPicks}, {@link npmRuns}), each a pick out
 * of the tree's root and its packages:
 *
 * - `every`: all of them, the root's included — the over-reach for a selector
 *   the hook cannot resolve (#1526 review).
 * - `root`: the root's.
 * - `path`: each package at or under that directory, as pnpm reads a location.
 * - `name`: each package whose name matches the pattern, `*` its wildcard;
 *   when none does and the pattern has no scope, each whose name does under
 *   any scope — pnpm reads `--filter core` as `@scope/core` when no package is
 *   named `core` and exactly one is so named, which this widens to all.
 * - `workspace`: npm's `-w`, a package name, or a path from the run's
 *   directory or the root naming a package or a folder holding packages; a
 *   glob reads every package.
 */
function runManifests(run, ctx) {
  if (!run.turbo && !run.picks) return [ctx.scriptsAt(run.dir)];
  const root = ctx.toplevel?.(run.dir) ?? run.dir;
  const packages = (ctx.workspaceDirs?.(root) ?? []).map((d) => ctx.scriptsAt(d)).filter(Boolean);
  if (run.turbo) return packages;
  const rootManifest = ctx.scriptsAt(root);
  const all = rootManifest ? [rootManifest, ...packages] : packages;
  const under = (dir) => all.filter((m) => ctx.isInside(m.dir, dir));
  const named = (pattern) => all.filter((m) => m.name && globName(pattern).test(m.name));
  const pick = (p) => {
    if (p.every) return all;
    if (p.root) return rootManifest ? [rootManifest] : [];
    if (p.path) return under(p.path);
    if (p.name) {
      const exact = named(p.name);
      return exact.length || p.name.startsWith("@") ? exact : named(`@*/${p.name}`);
    }
    if (/[*?[\]{}]/.test(p.workspace)) return all;
    const from = (base) => under(resolveDir(base, p.workspace, { shell: p.shell }));
    return [...all.filter((m) => m.name === p.workspace), ...from(run.dir), ...from(root)];
  };
  const chosen = new Map();
  for (const p of run.picks) for (const m of pick(p)) chosen.set(m.dir, m);
  return [...chosen.values()];
}

/** A pnpm name pattern as a regex: `*` matches any run of characters, every other character itself. */
const globName = (pattern) =>
  new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`))}$`);

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
 * A PowerShell command rewritten, at the same length, so the bash lexer reads
 * its words and boundaries as PowerShell does (#1520). PowerShell's escape is
 * the backtick, not the backslash: a backtick at a line's end continues it and
 * `` `" `` or `` `; `` is a literal character, while `\` is an ordinary one —
 * so `"C:\x\"` ends at that quote, where bash reads `\"` as escaped and would
 * mask the commands after it. A continuation becomes whitespace, and a `\` a
 * `/`, which Windows paths read the same. A backtick before an ordinary
 * character — a letter or digit that is no PowerShell escape (`` `n ``, `` `t ``,
 * `` `0 ``, `` `u{…} `` and the rest), or one of `-:./=+,@%_` — stands for that
 * character, so it becomes bash's escape of it, `\` and the character: the
 * same word, with no boundary it could move, and ``re`start`` reaches the deck
 * rule as the `restart` PowerShell runs (#1526 second read; {@link shellWords}).
 * Any other backtick pair — a quote, a separator, a space — becomes two inert `_`.
 */
export function powershellAsBash(command) {
  return command.replace(/`\r?\n|`[\s\S]?|\\/g, (m) => {
    if (m === "\\") return "/";
    if (m.endsWith("\n")) return " ".repeat(m.length);
    return PS_PLAIN_ESCAPE.test(m) ? `\\${m[1]}` : "_".repeat(m.length);
  });
}

/** A PowerShell backtick escape that stands for the character it escapes ({@link powershellAsBash}). */
const PS_PLAIN_ESCAPE = /^`(?![0abefnrtvu])[A-Za-z0-9\-:./=+,@%_]$/;

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
 * {@link powershellAsBash} and skips the `bashOnly` rules — the traps that
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
