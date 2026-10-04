/**
 * PreToolUse rules for the Bash tool — the repo's mechanical "never do X"
 * rules, turned from prose into checks that run before the command does.
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
import path from "node:path";

import { MAIN_BRANCH, SPEC_DIR } from "./lib.mjs";

const TITLE_RE = /^(feat|fix|improve|perf|refactor|docs|ci|chore|test|build|style|revert)(\([^)]+\))?!?: .+ \(#\d+\)$/;

/**
 * What a spec must carry beyond its header block (#1193). Measured over all
 * 106 specs: since the #621 policy, "Out of scope" fell from 50 % to 17 % and
 * a Testing/Verification section from 88 % to 70 % — because no rule had ever
 * named either. The only surviving prescription was a pre-#621 template in
 * `.claude/agents/feature-planner.md` that has produced zero specs.
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

const QUOTED_ARG = String.raw`("([^"]+)"|'([^']+)'|(\S+))`;
const CD_RE = new RegExp(String.raw`^\s*(?:\w+=\S*\s+)*cd\s+${QUOTED_ARG}\s*$`, "d");
const GIT_C_RE = new RegExp(String.raw`\bgit\s+-C\s+${QUOTED_ARG}`, "d");

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
 */
export function gitCwd(command, cwd, re) {
  const text = trustedMask(command);
  const segs = ranges(text, CHAIN).filter(([a, b]) => command.slice(a, b).trim());
  const at = re ? segs.findIndex(([a, b]) => re.test(text.slice(a, b))) : -1;
  let base = cwd;
  for (const [a, b] of segs.slice(0, at >= 0 ? at : segs.length)) {
    const dir = argIn(command, text, a, b, CD_RE);
    if (dir && dir !== "-") base = path.resolve(base, dir);
  }
  const [a, b] = at >= 0 ? segs[at] : [0, command.length];
  const dir = argIn(command, text, a, b, GIT_C_RE);
  return dir ? path.resolve(base, dir) : base;
}

/** Splits a command into rough words, respecting simple quotes. */
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
 * The verdict for a head that has no CodeRabbit review of its own (#1307):
 * `null` when it is a pure rebase of the commit the NEWEST review saw, an ask
 * when the rebase conflicted and only a human can judge the resolution, and a
 * deny otherwise. Called only once every cheap check has passed. CodeRabbit
 * does not review a rebase, so without this every PR rebased onto a moved
 * base stalled behind an `@coderabbitai review`.
 *
 * The test is a replay (`replayRebase` in `lib.mjs`): the reviewed change
 * re-applied onto the head's base must give the head's exact tree. Every file
 * the replay reports as conflicted gets a line check, and a line match still
 * only earns the ask — it cannot see where a line sits. Refused before any
 * replay: a release back-merge (its commits land one by one), a merge not
 * pinned to this exact head with `--match-head-commit`, and a base retargeted
 * or force-pushed since the review. A follow-up push is refused from inside
 * the replay. Every uncertain path refuses. Spec:
 * `docs/superpowers/specs/2026-10-03-issue-1307-merge-gate-pure-rebase.md`.
 */
function rebaseVerdict(merge, pr, bot, ctx, isBackMerge) {
  const head = pr.headRefOid;
  // `gh` lists reviews oldest first; `submittedAt` decides when both carry it.
  const newest = bot.reduce((a, b) => ((b.submittedAt ?? "") >= (a.submittedAt ?? "") ? b : a));
  const reviewed = newest.commit?.oid ?? "";
  const stale = `Not merging PR #${pr.number}: no CodeRabbit review at head ${head.slice(0, 9)} — the newest one is at a previous head ${reviewed.slice(0, 9) || "(no commit)"}`;
  const reviewAgain = "ask `@coderabbitai review`";
  if (isBackMerge)
    return `${stale}, and a release back-merge lands its commits one by one, so a rewritten tip needs a fresh review — ${reviewAgain}.`;
  // GitHub takes only a full sha here, so a prefix would be a merge that can never go through.
  if (!/^[0-9a-f]{40}$/i.test(merge.pin ?? "") || merge.pin.toLowerCase() !== head.toLowerCase())
    return `${stale}. The rebase check decides about this exact head, so pin it: add \`--match-head-commit ${head}\`.`;
  const moved = ctx.baseChangedSince?.(pr.number, newest.submittedAt, ctx.cwd);
  if (moved !== false)
    return moved
      ? `${stale}, and the PR's base branch was retargeted or force-pushed after that review — ${reviewAgain}.`
      : `${stale}, and gh could not read whether the base branch moved since that review.`;
  const v = ctx.replayRebase?.({ reviewed, head, base: pr.baseRefOid, dir: ctx.cwd });
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
      // Set when the head has no review of its own but an older one exists: the
      // pure-rebase check (#1307), run last because it is the one that costs git work.
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
      if (problems.length === 0) return rebaseCheck ? rebaseVerdict(merge, pr, bot, ctx, isBackMerge) : null;
      if (rebaseCheck)
        problems.push(
          "the head has no CodeRabbit review of its own (the pure-rebase check runs once the rest is green)",
        );
      return `Not merging PR #${pr.number} at ${pr.headRefOid.slice(0, 9)}: ${problems.join("; ")}.`;
    },
  },
  {
    name: "git commit: specs go to master only; a dirty lockfile rides with its package.json",
    test: (c, ctx) => {
      if (!has(c, GIT_COMMIT)) return null;
      const dir = gitCwd(c, ctx.cwd, GIT_COMMIT);
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
      for (const f of committed.filter((x) => x.startsWith(SPEC_DIR))) {
        if (ctx.tracked?.(dir, f)) continue;
        const text = ctx.specText?.(dir, f, fromIndex.has(f) ? "index" : "worktree");
        if (text === undefined) continue;
        const missing = missingSpecParts(text);
        if (missing.length)
          return `${f} is missing ${missing.join(" and ")}. A spec carries the header block, an Out of scope section and a Testing/Verification section. See .claude/rules/specs-and-plans.md.`;
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
    name: "git worktree add: a sibling of the repo, from a fresh origin/master",
    test: (c, ctx) => {
      const target = worktreeAddTarget(c);
      if (!target) return null;
      const dir = gitCwd(c, ctx.cwd, GIT_WORKTREE_ADD);
      const resolved = path.resolve(dir, target);
      if (ctx.isInside(resolved, ctx.mainRoot(dir)))
        return `Worktrees are siblings of the repo (${path.join(path.dirname(ctx.mainRoot(dir)), "ir-<issue>")}), never inside it: ${resolved}.`;
      if (!/(^|[\\/])ir-\d+$/.test(resolved))
        return `Issue worktrees are named ../ir-<issue> (got ${path.basename(resolved)}).`;
      const fresh = ctx.originFresh(dir);
      if (fresh && !fresh.fresh)
        return `origin/${MAIN_BRANCH} is stale (local ${fresh.local}, remote ${fresh.remote}); run \`git fetch origin\` first or the branch starts behind and surfaces as a PR conflict.`;
      // The one moment where the issue number is known and implementation has
      // not started (#1193): 47 of the 56 enhancement issues filed since the
      // #621 policy have a spec, and nothing was checking the other nine.
      // An ASK, never a deny — the exemptions (a bug, a docs fix, a dependency
      // bump, a hygiene sweep) are judgement no regex makes. Labels that are
      // readable and carry no `enhancement` ARE those exemptions, so the ask
      // stays silent for them; labels that cannot be read (no `gh`, offline)
      // ask, and the prompt names the exemption so it costs one keypress.
      const issue = resolved.match(/ir-(\d+)$/)?.[1];
      if (issue && !specExistsFor(ctx.specFiles?.(dir) ?? [], issue)) {
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
      const resolved = path.resolve(gitCwd(c, ctx.cwd, GIT_WORKTREE_REMOVE), target);
      const held = ctx.linkTargets().filter((l) => l.target && ctx.isInside(l.target, resolved));
      if (held.length)
        return `${held.map((l) => l.host).join(" and ")} plugin link points into ${resolved}. Do not relink it yourself, not even to master — leave the link and the worktree as they are and tell Niklas.`;
      return null;
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
    test: (c) =>
      has(c, cmd(/jq(\s|$)/)) &&
      "jq is not installed here and a jq pipeline fails silently (empty fields, exit 0). Parse `gh --json` with node or python (UTF-8).",
  },
  {
    name: "heredocs collapse doubled backslashes",
    test: (c) =>
      has(c, /<<-?\s*['"]?\w+/) &&
      has(c, /[A-Za-z]:\\\\/) &&
      "A doubled backslash collapses to one inside a heredoc, corrupting that Windows path. Write the file with the Write tool instead.",
  },
  {
    name: "IRACEDECK_MOCK=0 still mocks",
    test: (c) =>
      has(c, cmd(/IRACEDECK_MOCK=0\b/)) &&
      "`IRACEDECK_MOCK=0` still forces the mock (any non-empty value does). Use `IRACEDECK_REAL_NATIVE=1`.",
  },
  {
    // The arguments are read raw, since MSYS mangles a quoted path just the
    // same; the fix counts only in live text up to the `git show` it covers.
    name: "git show <ref/with/slash>:<dot-path> is mangled by MSYS",
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
 */
export function checkBash(command, ctx) {
  const asks = [];
  for (const rule of rules) {
    const v = rule.test(command, ctx);
    if (!v) continue;
    if (typeof v === "string") return v;
    asks.push(v.ask);
  }
  // Every ask in one prompt: a chain the maintainer approves runs whole, so a
  // later ask hidden behind an earlier one would run unseen (#1307 review).
  return asks.length ? { ask: asks.join("\n\n") } : null;
}
