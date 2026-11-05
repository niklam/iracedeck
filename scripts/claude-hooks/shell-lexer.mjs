/**
 * The shell lexer every Bash and PowerShell rule reads a command through
 * (#1321, #1520, extracted in #1590): where a command is, what its words are,
 * and which directory it runs in.
 *
 * {@link maskInert} lexes a command as bash reads it and blanks its inert text
 * at the same length, and {@link view} trusts that mask only when the lexer is
 * sure of it and no string is handed to a shell, and rewrites each program
 * word to the plain name it runs (`gh.exe`, `"gh"`, `/usr/bin/gh` → `gh`,
 * #1606). On top of it, {@link cmd} anchors a regex to command position,
 * and {@link GIT_GLOBALS} carries a git command past its global options;
 * {@link matchesAt} and {@link chainCommands} find a command in the masked
 * text and read its arguments from the raw text at the same index;
 * {@link gitCwd}, {@link gitPlaceAt} and {@link resolveDir} follow the `cd`s
 * and `-C`s that move the directory it runs in; and {@link words}, {@link shellWords},
 * {@link commandWords} and {@link powershellAsBash} read its words as bash
 * and PowerShell read them. The rules in `rules-bash.mjs` and the
 * package-script interpreter in `script-runs.mjs` both read through it, and
 * it knows neither.
 *
 * Pure: a command string in, strings, indices and directories out. It takes
 * no context and reads no filesystem and no git; the only thing it consults
 * beyond its arguments is the running platform, as `resolveDir`'s
 * overridable default.
 */
import path from "node:path";

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
  // Where each word bash reads ends, keyed by where it starts: at every depth,
  // a substitution's own words included (#1606, {@link view}).
  const wordEnds = new Map();
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
    // Where the word being read began, or -1 between words.
    let word = -1;
    const endWord = (at) => {
      if (word >= 0) wordEnds.set(word, at);
      word = -1;
    };
    while (i < limit) {
      const ch = s[i];
      const from = i;
      if (close === "`" && ch === "`") {
        endWord(i);
        return i + 1;
      }
      if (ch === "\\" && s[i + 1] === "\n") {
        // A line continuation: bash removes it, joining the lines; the word, if any, goes on.
        out[i] = out[i + 1] = " ";
        if (!close) flat[i] = flat[i + 1] = " ";
        i += 2;
        continue;
      }
      // A blank or an operator character ends a word; anything else starts or
      // continues one, except a `#` where a word could start, which opens a comment.
      if (/[\s;&|()<>]/.test(ch)) endWord(from);
      else if (word < 0 && !(atWord && ch === "#")) word = from;
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
    endWord(limit);
    if (close) sure = false;
    return limit;
  };

  commands(0, n, null);
  if (pending.length) sure = false;
  maskInert.last = command;
  maskInert.lastOut = { masked: out.join(""), flat: flat.join(""), sure, words: wordEnds };
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
 * The text the rules read: `{ text, flat, trusted, programs, unreadable }`.
 * The mask is trusted only when the lexer is sure of it AND nothing in the
 * live text feeds a string to a shell; otherwise `text` and `flat` are the raw
 * command — the pre-#1321 behaviour, which over-matches. The pre-hook is a
 * safety gate, so a doubt costs a false deny on a mention, never a missed
 * command.
 *
 * Either way each PROGRAM WORD — the word at command position, {@link
 * normalisePrograms} — is rewritten to its plain name at the same length
 * (#1606), so `gh.exe`, `/usr/bin/gh`, `"gh"`, `g"h"` and `GH.EXE` all read as
 * the `gh` every rule names, and the index of every other character is
 * unchanged. That runs before the shell-feed test, so a quoted `"bash" -c`
 * stops trusting the mask as a bare `bash -c` does. `programs` lists the
 * `[start, end)` spans it rewrote or found plain ({@link programStart}), and
 * `unreadable` the program words it could not read ({@link unreadablePrograms}).
 */
export function view(command) {
  if (command !== view.last) {
    const { masked, flat, sure, words: wordEnds } = maskInert(command);
    const lexed = normalisePrograms(command, masked, flat, wordEnds, false);
    const trusted = sure && !SHELL_FED.test(lexed.text);
    const out = trusted ? lexed : normalisePrograms(command, command, command, wordEnds, true);
    view.last = command;
    view.out = {
      text: out.text,
      flat: trusted ? out.flat : out.text,
      trusted,
      programs: out.programs,
      unreadable: out.unreadable,
    };
  }
  return view.out;
}

/**
 * Where a program word may start in `text`: after each place the anchor of
 * {@link cmd} allows (the start, a newline, `|`, `;`, `&`, `(`, `)` or a
 * backtick), any blanks and any {@link COMMAND_LEAD}, read greedily so the
 * word it stops at is the one a {@link cmd} rule would test. Each place is
 * read on its own: an assignment lead such as `x=$(` runs past the `(` a
 * substitution's own command follows. Each is `{ start, lead }`, the lead
 * being the text stepped over.
 */
function* programPositions(text) {
  const lead = new RegExp(String.raw`\s*${COMMAND_LEAD}`, "y");
  for (let p = 0; p <= text.length; p++) {
    if (p > 0 && !"\n|;&()\x60".includes(text[p - 1])) continue;
    // A redirect's own `&` (`2>&1`, `&>log`) ends no command.
    if (text[p - 1] === "&" && (text[p] === ">" || /[<>]/.test(text[p - 2] ?? ""))) continue;
    lead.lastIndex = p;
    const m = lead.exec(text);
    if (m) yield { start: p + m[0].length, lead: m[0] };
  }
}

/** The wrappers of {@link COMMAND_LEAD} that run the next word as a command. */
const LEAD_WRAPPER = /(?<!\S)(time|command|exec|env|nohup|timeout|xargs)(?=\s)/g;
/** Whether the word after `lead` is one of env's own arguments or its program: env is the last wrapper the lead steps over. */
const afterEnv = (lead) => [...lead.matchAll(LEAD_WRAPPER)].at(-1)?.[1] === "env";
/** An option word that can be written back where it stands without changing how the text splits ({@link normalisePrograms}). */
const OPTION_WORD = /^-[^\s;&|()<>"'`$\\]*$/;

/**
 * The bash builtins and reserved words. Bash finds them by their exact
 * spelling, so `CD` is not `cd` there, while Windows finds an external program
 * in any case: a name on this list keeps its case in bash, every other one is
 * folded to lower case (#1606). PowerShell folds all of them
 * ({@link powershellAsBash}).
 */
const BASH_CASED = new Set(
  (
    "alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs disown echo " +
    "enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd " +
    "printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type " +
    "typeset ulimit umask unalias unset wait if then else elif fi case esac for select while until do done in " +
    "function time coproc . : [ [[ ]] { } !"
  ).split(" "),
);

/** What a program name is made of: anything else (a space, a quote, an operator) would change how the rewritten text splits. */
const PROGRAM_NAME = /^[\w.+@%:,~^!{}[\]-]+$/;

/**
 * Where the expansion opening at `k` in `w` ends — `$( … )`, `$(( … ))`,
 * `${ … }`, `$name`, a backtick — roughly as bash finds it. Only used on a
 * word the caller has already marked as expanding, so a misjudged end costs
 * where the rest of that word is read from, never whether it expands.
 */
function expansionEnd(w, k) {
  if (w[k] === "\x60") return tickEnd(w, k);
  const open = w[k + 1];
  if (open === "(" || open === "{") return closeAt(w, k + 2, open);
  const name = /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(w.slice(k + 1));
  return k + 1 + (name ? name[0].length : 0);
}

/** Just past the backtick that closes the one opening at `k` in `w`, an escaped one skipped. */
function tickEnd(w, k) {
  for (let j = k + 1; j < w.length; j++)
    if (w[j] === "\\") j++;
    else if (w[j] === "\x60") return j + 1;
  return w.length;
}

/**
 * Just past the `)` or `}` that closes the `open` whose body starts at `i` in
 * `w`, nested ones counted and quoted text, escapes and backticks skipped:
 * roughly the lexer's reading, for a word read on its own.
 */
function closeAt(w, i, open) {
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let j = i; j < w.length; j++) {
    const c = w[j];
    if (c === "\\") j++;
    else if (c === "'") {
      const e = w.indexOf("'", j + 1);
      j = e < 0 ? w.length : e;
    } else if (c === '"') {
      for (j++; j < w.length && w[j] !== '"'; j++) if (w[j] === "\\") j++;
    } else if (c === "\x60") j = tickEnd(w, j) - 1;
    else if (c === open) depth++;
    else if (c === close && depth-- === 0) return j + 1;
  }
  return w.length;
}

/**
 * The outermost command substitutions in a word, `$( … )` and backticks, as
 * `[from, to)` offsets: wherever they sit, inside double quotes, a `${ … }` or
 * a `$(( … ))` included, but not inside single quotes (#1606 review). Their
 * text runs, so the rewrite of a program word keeps it ({@link
 * normalisePrograms}).
 */
function commandSubs(w) {
  const subs = [];
  let quoted = false;
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (c === "\\") i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === "'") {
      const e = w.indexOf("'", i + 1);
      i = e < 0 ? w.length : e;
    } else if (c === "$" && w[i + 1] === "(" && w[i + 2] !== "(") {
      const end = closeAt(w, i + 2, "(");
      subs.push([i, end]);
      i = end - 1;
    } else if (c === "\x60") {
      const end = tickEnd(w, i);
      subs.push([i, end]);
      i = end - 1;
    }
  }
  return subs;
}

/** A `$` that opens an expansion, as bash reads one: a substitution, a `${`, a name or a special parameter. */
const EXPANDS = /[({A-Za-z_0-9@*#?$!-]/;
/** The ANSI-C escapes of a `$'…'` word that stand for one plain character; any other escape is read as unknown. */
const ANSI_PLAIN = { "\\": "\\", "'": "'", '"': '"', "?": "?" };

/**
 * A word decoded as bash reads it, one `{ c, live }` per character it yields:
 * quotes removed and `\` escapes applied, with `live` set on a character that
 * stands for an expansion (`$…`, a backtick, one `$` per expansion), a glob
 * (`*`, `?`, a `[` that a later `]` closes) or a brace expansion (a `{` and
 * `}` around an unquoted `,` or `..`). An ANSI-C escape other than a quote or
 * a backslash is read as live too: the word it spells is not plain. `at` is
 * the offset in `w` of the character each one comes from.
 */
export function decodeWord(w) {
  const out = [];
  const lit = (c, at) => {
    if (c) out.push({ c, live: false, at });
  };
  const live = (c, at) => out.push({ c, live: true, at });
  // Unquoted `[`, `]`, `{`, `,`, `.` and `}`, as indices into `out`, for globs and braces.
  const bare = [];
  let i = 0;
  while (i < w.length) {
    const ch = w[i];
    if (ch === "\\") {
      if (w[i + 1] !== "\n") lit(w[i + 1], i + 1);
      i += 2;
    } else if (ch === "'") {
      const e = w.indexOf("'", i + 1);
      const end = e < 0 ? w.length : e;
      for (let k = i + 1; k < end; k++) lit(w[k], k);
      i = end + 1;
    } else if (ch === "$" && w[i + 1] === "'") {
      let k = i + 2;
      for (; k < w.length && w[k] !== "'"; k++)
        if (w[k] !== "\\") lit(w[k], k);
        else if (ANSI_PLAIN[w[++k]] !== undefined) lit(ANSI_PLAIN[w[k]], k);
        else live("\\", k);
      i = k + 1;
    } else if (ch === "$" && w[i + 1] === '"') {
      // A locale string, `$"…"`: double-quoted text bash may translate (#1606 review).
      i++;
    } else if (ch === '"') {
      let k = i + 1;
      while (k < w.length && w[k] !== '"') {
        if (w[k] === "\\" && '"\\$`\n'.includes(w[k + 1] ?? "x")) {
          if (w[k + 1] !== "\n") lit(w[k + 1], k + 1);
          k += 2;
        } else if ((w[k] === "$" && EXPANDS.test(w[k + 1] ?? "")) || w[k] === "\x60") {
          live("$", k);
          k = expansionEnd(w, k);
        } else lit(w[k], k++);
      }
      i = k + 1;
    } else if ((ch === "$" && EXPANDS.test(w[i + 1] ?? "")) || ch === "\x60") {
      live("$", i);
      i = expansionEnd(w, i);
    } else if (ch === "*" || ch === "?") {
      live(ch, i++);
    } else {
      if ("[]{},.".includes(ch)) bare.push(out.length);
      lit(ch, i++);
    }
  }
  const at = (c) => bare.filter((k) => out[k].c === c);
  // A `[` is a glob only when a `]` closes it.
  for (const k of at("[")) if (at("]").some((j) => j > k)) out[k].live = true;
  // A brace expansion: `{…,…}` or `{a..b}`, its braces unquoted.
  for (const k of at("{")) {
    const close = at("}").find((j) => j > k);
    if (close === undefined) continue;
    const dots = at(".").filter((j) => j > k && j < close);
    if (at(",").some((j) => j > k && j < close) || dots.some((j) => dots.includes(j + 1)))
      out[k].live = out[close].live = true;
  }
  return out;
}

/**
 * The program a word at command position runs, read off its last path
 * segment: `{ name, cut }`, folded as {@link BASH_CASED} says and without a
 * Windows executable extension, `cut` the offset in the word where that
 * segment's raw text starts; `{ unreadable: true }` when that segment holds
 * an expansion or a glob, so the program is decided at run time; or `null`
 * for a word that names no program the text could carry.
 */
function programName(chars) {
  let sep = -1;
  chars.forEach((x, k) => {
    if (!x.live && (x.c === "/" || x.c === "\\")) sep = k;
  });
  const last = chars.slice(sep + 1);
  if (last.some((x) => x.live)) return { unreadable: true };
  const name = last
    .map((x) => x.c)
    .join("")
    .replace(/\.(?:exe|cmd|bat|com|ps1)$/i, "");
  if (!PROGRAM_NAME.test(name)) return null;
  const lower = name.toLowerCase();
  return { name: BASH_CASED.has(lower) ? name : lower, cut: sep < 0 ? 0 : chars[sep].at + 1 };
}

/**
 * A word bash takes for an assignment, not a command: an unquoted valid name
 * (an array index allowed) before `=` or `+=` (#1606 review). `./x=y/gh` and a
 * quoted `"/c/a=b/gh.exe"` are programs.
 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/**
 * Whether a word read in the raw text of an untrusted view may be rewritten
 * (#1606 second read): it holds no character a raw-text rule reads as a
 * command boundary (a newline, `;`, `&`, `|`, a paren or a backtick) and every
 * quote it opens it closes itself. A word found from a position inside a
 * quoted string fails one or the other — it opens a quote at the string's end,
 * or runs on over the commands to the next one — and is left as it stands, as
 * an untrusted view was before #1606; so a rewrite there only ever turns a
 * self-contained word into the name it runs, and every boundary and every
 * command the raw text shows stays where it was.
 */
function selfContained(word) {
  if (/[\n;&|()\x60]/.test(word)) return false;
  let quote = null;
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === "\\") i++;
    else if (c === quote) quote = null;
    else if (!quote && (c === "'" || c === '"')) quote = c;
  }
  return quote === null;
}

/** A word starting at `at` in raw text, found without the lexer: quotes, escapes and simple substitutions kept whole. */
const CRUDE_WORD =
  /(?:"(?:[^"\\]|\\[\s\S])*"|'[^']*'|\\[\s\S]|\$\((?:[^()]|\([^()]*\))*\)|\$\{[^}]*\}|\x60[^\x60]*\x60|[^\s;&|()<>"'\\\x60])+/y;

/**
 * The program words of `command`, found in `text` (its masked or raw form,
 * same length) and rewritten there and in `flat` (#1606). A program word is
 * the word at command position ({@link programPositions}); it is decoded as bash
 * reads it, cut to its last `/` or `\` segment, stripped of `.exe`, `.cmd`,
 * `.bat`, `.com` and `.ps1`, folded to lower case ({@link BASH_CASED}), and
 * written back RIGHT-aligned in its last segment, padded with spaces on the
 * left: the anchor's `\s*` and {@link COMMAND_LEAD}'s `\s+` take the pad, so a
 * {@link cmd} match starts where it did, its head covers the whole raw word,
 * and the arguments keep their indices. Left-aligned, a regex that ends at the
 * name — `pnpm${BIN}` — would read its arguments from `.cmd run …`. The
 * directory part before that segment is blanked too, except its command
 * substitutions ({@link commandSubs}), which run and stay as they are:
 * `$(git push …)/scripts/run.sh` keeps its push in sight, and a substitution
 * that feeds a string to a shell still makes the mask untrusted (#1606 review).
 *
 * It repeats until nothing changes, so a wrapper spelled with a path
 * (`/usr/bin/env /usr/bin/gh …`) puts the next word at command position too.
 * A word bash takes for an assignment ({@link ASSIGNMENT}), and a `$word`
 * followed by `=` (a PowerShell one), is never a program; nor is a word
 * starting with `-`, an option the lead could not step over because it is
 * quoted, which is written back as the option it is, its case kept. After
 * env, any `NAME=VALUE`, quoted or not, is an assignment env makes, written
 * back as `NAME=___`, and an argument that expands is listed in `unreadable`
 * with `env` set, since it may be either (#1606 review). `words` are the lexer's word spans, the
 * only words taken where `crude` is false; in the raw text of an untrusted
 * view, a position the lexer did not see start a word is read by
 * {@link CRUDE_WORD}. A program word whose last segment expands or globs is
 * left as it is and listed in `unreadable` as `{ start, end, word }`.
 */
function normalisePrograms(command, text, flat, words, crude) {
  let t = text;
  let f = flat;
  // `[start, end, cut, keep]` each: the word, where its last segment starts,
  // and the command substitutions of its directory part, kept live.
  const programs = [];
  const unreadable = [];
  const seen = new Set();
  // Inside a program word read already, and not inside a substitution it kept:
  // the rewritten text is blank or the name there, so the lead may stop in it.
  const covered = (p) =>
    programs.some(([a, b, , keep]) => a < p && p < b && !keep.some(([k0, k1]) => k0 < p && p < k1));
  for (let changed = true, passes = 0; changed && passes < 32; passes++) {
    changed = false;
    for (const { start, lead } of programPositions(t)) {
      if (seen.has(start) || covered(start)) continue;
      let end = words.get(start);
      if (end === undefined && crude && (start === 0 || /[\s|;&()\x60]/.test(command[start - 1]))) {
        CRUDE_WORD.lastIndex = start;
        const w = CRUDE_WORD.exec(command);
        if (w) end = start + w[0].length;
      }
      if (end === undefined || end <= start) continue;
      seen.add(start);
      const word = command.slice(start, end);
      // The raw text of an untrusted view is what the rules read as it stands,
      // separators inside strings included: a word there is rewritten only when
      // it is whole on its own, so no rewrite hides a command (#1606 second read).
      if (crude && !selfContained(word)) continue;
      const chars = decodeWord(word);
      const live = chars.some((x) => x.live);
      const decoded = chars.map((x) => x.c).join("");
      const env = afterEnv(lead);
      const write = (by) => {
        t = t.slice(0, start) + by + t.slice(end);
        f = f.slice(0, start) + by + f.slice(end);
        changed = true;
      };
      // An option the lead could not step over because it is quoted
      // (`env "-C" dir`): never the program, and written back as the option it
      // is, its case kept, so the next pass steps over it (#1606 review).
      if (!live && decoded.startsWith("-")) {
        if (OPTION_WORD.test(decoded)) {
          if (t.slice(start, end) !== decoded.padStart(end - start)) write(decoded.padStart(end - start));
        } else if (env) unreadable.push({ start, end, word, env });
        continue;
      }
      if (env) {
        // env takes every NAME=VALUE ahead of its program, quoted or not: the
        // name written back plain, so the lead steps over it, every rule that
        // reads a GH_* or GIT_* sees it, and a reader of its value finds none
        // it can read.
        const eq = chars.findIndex((x) => !x.live && x.c === "=");
        if (eq > 0 && !chars.slice(0, eq).some((x) => x.live)) {
          const name = chars.slice(0, eq).map((x) => (/\w/.test(x.c) ? x.c : "_"));
          const by = `${name.join("")}=`.padEnd(end - start, "_");
          if (t.slice(start, end) !== by) write(by);
          continue;
        }
        // One that expands may be an assignment or the program: judged as
        // both by `checkBash`.
        if (live) unreadable.push({ start, end, word, env });
      }
      if (ASSIGNMENT.test(word) || (word.startsWith("$") && /^\s*[-+*/]?=(?!=)/.test(command.slice(end)))) continue;
      const read = programName(chars);
      if (read?.unreadable && !env) unreadable.push({ start, end, word });
      if (!read?.name) continue;
      const cut = start + read.cut;
      if (read.name.length > end - cut) continue;
      const keep = commandSubs(word)
        .filter(([, r1]) => r1 <= read.cut)
        .map(([r0, r1]) => [start + r0, start + r1]);
      programs.push([start, end, cut, keep]);
      // The directory part blank but for its command substitutions, which run
      // and are read where they stand (#1606 review); the name right-aligned
      // in the last segment, so `$( … )/gh` reads `$( … )  gh`, at command
      // position after the `)` as after any other.
      const rewrite = (s) => {
        let out = "";
        for (let i = start; i < cut; i++) out += keep.some(([k0, k1]) => k0 <= i && i < k1) ? s[i] : " ";
        return s.slice(0, start) + out + read.name.padStart(end - cut) + s.slice(end);
      };
      const next = rewrite(t);
      if (next === t) continue;
      t = next;
      f = rewrite(f);
      changed = true;
    }
  }
  return { text: t, flat: f, programs, unreadable };
}

/**
 * Where the program word holding `index` starts, when `index` falls inside
 * one ({@link view}); `index` itself otherwise. A rule that finds `gh` with an
 * unanchored regex lands on the rewritten name, which is right-aligned in its
 * span, so the raw text ahead of it would end inside the raw word. The
 * innermost such word counts, and a command substitution a word's directory
 * part keeps is not part of that word: a command inside it is its own.
 */
export function programStart(command, index) {
  let at = index;
  let best = -1;
  for (const [a, b, , keep] of view(command).programs)
    if (a <= index && index < b && a > best && !keep.some(([k0, k1]) => k0 <= index && index < k1)) {
      best = a;
      at = a;
    }
  return at;
}

/** The program words at command position that expand or glob, `{ start, end, word }` each ({@link view}). */
export const unreadablePrograms = (command) => view(command).unreadable;

/** The command with its inert text masked where the mask is trusted, else the raw command ({@link view}). */
export const trustedMask = (command) => view(command).text;

/** `[start, end)` ranges of `text` between the separators `sep` finds in it. */
export function ranges(text, sep) {
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

/**
 * The separators a chain is split at for `cd`/`-C` tracking; the merge and tag
 * rules also split at a lone `&`, never at a redirect's own (`>&2`, `&>log`),
 * which a redirection ahead of the program may carry (#1606 review).
 */
const CHAIN = /\n|&&|\|\||;|\|/;
export const CHAIN_AND_BACKGROUND = /&&|\|\||[;|\n]|(?<![<>])&(?!>)/;
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
 * (`checkBash` in `rules-bash.mjs`), and two things read differently there — the commands
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
 * command's own `-C`s ({@link gitPlace}). Pass the rule's own `cmd(...)`
 * regex as `re` so the `-C` is read off the segment it matched and never off
 * a later command in the chain — `git worktree add ../ir-5 … && git -C ../ir-5
 * log` used to resolve the new tree against itself, fail the repo-root lookup
 * there, and deny the add as "inside the repo". The `cd` walk is what lets a
 * session whose cwd is `master` be judged on the tree it pushes from:
 * `cd ../ir-1143 && git push` used to ask with "branch master".
 *
 * The chain is split, and each `cd` and `-C` found, in the trusted-masked text,
 * and the directory then read from the raw text at that spot — so a
 * `git -C ../master` quoted in a commit message moves nothing (#1321 review).
 * `shell` picks the `cd` spellings and the path reading ({@link resolveDir}).
 */
export const gitCwd = (command, cwd, re, shell = BASH) => gitPlace(command, cwd, re, shell).dir;

/**
 * Where the git command a rule matched runs, as {@link gitCwd} finds it, and
 * whether its global options or its environment move what it acts on
 * ({@link gitPlaceAt}): `{ dir, movesRepo, movesTree }`. Without `re`, the
 * first git command of the whole command is read.
 */
export function gitPlace(command, cwd, re, shell = BASH) {
  const text = trustedMask(command);
  const segs = ranges(text, CHAIN).filter(([a, b]) => command.slice(a, b).trim());
  const at = re ? segs.findIndex(([a, b]) => re.test(text.slice(a, b))) : -1;
  let base = cwd;
  for (const [a, b] of segs.slice(0, at >= 0 ? at : segs.length)) {
    const dir = argIn(command, text, a, b, cdRe(shell));
    if (dir && !HISTORY_DIR.has(dir)) base = resolveDir(base, dir, { shell });
  }
  const [a, b] = at >= 0 ? segs[at] : [0, command.length];
  const from = at >= 0 ? a + Math.max(0, text.slice(a, b).search(re)) : a;
  return gitPlaceAt(command, from, base, shell, b);
}

/** The program word `git` in the rewritten text, wherever a word starts: {@link gitWord}'s fallback. */
const GIT_WORD = /(?<![^\s|;&()\x60])git(?=\s)/g;

/**
 * The git program word of the command whose text starts at `start`, as a
 * match of its rewritten name (`index`, `[0]`), or `null` (#1606 second
 * read): the first program word the lexer found there whose name is `git`, at
 * the command's own depth — never a lead's option value spelled `git`
 * (`exec -a git git -C …`), which is no program word, nor a `git` inside a
 * substitution among its words. Only where the lexer found none is the first
 * `git` word searched for.
 */
function gitWord(command, text, start, end) {
  let from = start;
  while (from < end && /[\s|;&()\x60]/.test(text[from])) from++;
  const spans = view(command)
    .programs.filter(([a, b, cut]) => a >= from && a < end && text.slice(cut, b).trim() === "git")
    .sort((x, y) => x[0] - y[0]);
  for (const [a, b] of spans) {
    const between = text.slice(from, a);
    const open = (between.match(/\(/g)?.length ?? 0) - (between.match(/\)/g)?.length ?? 0);
    if (open <= 0 && (between.match(/\x60/g)?.length ?? 0) % 2 === 0) return Object.assign(["git"], { index: b - 3 });
  }
  GIT_WORD.lastIndex = from;
  const found = GIT_WORD.exec(text);
  return found && found.index < end ? found : null;
}
/**
 * `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE` assigned or
 * exported, in bash or as PowerShell's `$env:`; the environment is case-blind
 * on Windows.
 */
const GIT_ENV = /(?<!\w)GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE)\s*=/gi;

/**
 * Where the git command whose text starts at `start` runs (#1606), as
 * `{ dir, movesRepo, movesTree, movesIndex }`: `base` (the directory its `cd`s
 * left it in, a {@link chainCommands} `base`) moved by every `-C` among its
 * global options in order, each against the one before, as git applies them
 * ({@link gitGlobals}). `movesRepo` is set when a `--git-dir`, `GIT_DIR` or
 * `GIT_COMMON_DIR` names its repository, `movesTree` when a `--work-tree`, a
 * `GIT_WORK_TREE` or a `core.worktree` set by `-c` or `--config-env` (its key
 * in any case, as git reads it) names its work tree, and `movesIndex` when a
 * `GIT_INDEX_FILE` names its index (#1606 review): the hook asks git in the
 * directory, so a rule that reads that repository's branch, index or files
 * cannot know what the command acts on. A variable anywhere in the live text
 * ahead of the command counts, as a prefix, an `export` or an assignment to a
 * variable the environment may already carry. `end` bounds where the git word
 * is looked for.
 */
export function gitPlaceAt(command, start, base, shell = BASH, end = command.length) {
  const text = trustedMask(command);
  const word = gitWord(command, text, start, end);
  if (!word) return { dir: base, movesRepo: false, movesTree: false, movesIndex: false };
  const options = gitGlobals(command, word.index + word[0].length);
  let dir = base;
  for (const d of options.dirs) dir = resolveDir(dir, d, { shell });
  const env = new Set([...text.slice(0, word.index).matchAll(GIT_ENV)].map((m) => m[1].toUpperCase()));
  return {
    dir,
    movesRepo: options.gitDir !== undefined || env.has("DIR") || env.has("COMMON_DIR"),
    movesTree: options.workTree !== undefined || options.config.includes("core.worktree") || env.has("WORK_TREE"),
    movesIndex: env.has("INDEX_FILE"),
  };
}

/**
 * The global options of the git command whose program word ends at `from`
 * (`GIT_GLOBALS`, #1606), read in the rewritten text and their values from
 * the raw text at the same indices, unquoted: `{ dirs, gitDir, workTree,
 * config }`, every `-C` in order, the last `--git-dir` and `--work-tree`, and
 * the keys `-c` and `--config-env` set, lower-cased. A value that expands is
 * kept as written, quotes stripped, as the hook has always read one.
 */
export function gitGlobals(command, from) {
  const text = trustedMask(command);
  const option = new RegExp(String.raw`\s+${GIT_OPTION}`, "yd");
  const out = { dirs: [], gitDir: undefined, workTree: undefined, config: [] };
  option.lastIndex = from;
  for (let m; (m = option.exec(text));) {
    const name = m[1] ?? m[3];
    const at = m.indices[2] ?? m.indices[4];
    if (!name || !at) continue;
    const raw = command.slice(at[0], at[1]);
    const chars = decodeWord(raw);
    const value = chars.some((x) => x.live) ? raw.replace(/["']/g, "") : chars.map((x) => x.c).join("");
    if (name === "-C") out.dirs.push(value);
    else if (name === "--git-dir") out.gitDir = value;
    else if (name === "--work-tree") out.workTree = value;
    else if (name === "-c" || name === "--config-env") out.config.push(value.split("=")[0].toLowerCase());
  }
  return out;
}

/**
 * `{ start, dir }` for the command `re` finds first, when every segment ahead
 * of it, split as {@link gitCwd} splits, is a `cd <dir>` it follows (`cd -`
 * and `cd +` are not): `start` is where the command's segment begins, `dir` the
 * session cwd moved by those `cd`s alone — never by a `git -C`, which a
 * command such as gh does not take. `undefined` when anything else comes first
 * or nothing matches. The merge gate's fail-closed check (#1393): any other
 * command ahead of a merge could change what gh resolves it to — the
 * repository, the checkout, the branch — after the gate has read it.
 */
export function cdsAhead(command, re, cwd, shell = BASH) {
  const text = trustedMask(command);
  const segs = ranges(text, CHAIN).filter(([a, b]) => text.slice(a, b).trim());
  const at = segs.findIndex(([a, b]) => re.test(text.slice(a, b)));
  if (at < 0) return undefined;
  let dir = cwd;
  for (const [a, b] of segs.slice(0, at)) {
    const to = argIn(command, text, a, b, cdRe(shell));
    if (!to || HISTORY_DIR.has(to)) return undefined;
    dir = resolveDir(dir, to, { shell });
  }
  return { start: segs[at][0], dir };
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
 * pnpm spell it differently ({@link gitPlaceAt}). `start` is where `head`
 * begins: a match of an unanchored `re` that starts on a rewritten program
 * name is moved back to the start of that word ({@link programStart}), so
 * `head` holds the raw word whole.
 */
export function* chainCommands(command, cwd, re, shell = BASH) {
  const text = trustedMask(command);
  const global = new RegExp(re.source, [...new Set([...re.flags, "g"])].join(""));
  let base = cwd;
  for (const [a, b] of ranges(text, CHAIN)) {
    for (const m of text.slice(a, b).matchAll(global)) {
      const start = programStart(command, a + m.index);
      const from = a + m.index + m[0].length;
      const stop = text.slice(from, b).search(COMMAND_END);
      const to = stop >= 0 ? from + stop : b;
      yield {
        base,
        start,
        head: command.slice(start, from),
        args: command.slice(from, to),
        at: from,
        cut: stop >= 0 ? text[to] : undefined,
      };
    }
    const dir = argIn(command, text, a, b, cdRe(shell));
    if (dir && !HISTORY_DIR.has(dir)) base = resolveDir(base, dir, { shell });
  }
}

/** Splits a command into rough words, respecting simple quotes. A value glued to its quote (`--x="a b"`) needs {@link shellWords}. */
export function words(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** An anchored rule ({@link cmd}) tests the trusted-masked text; an unanchored one, which must fire on any occurrence, the raw text. */
export const has = (command, re) => re.test(re.anchored ? trustedMask(command) : command);

/**
 * What may stand between a command boundary and the command itself and still
 * leave it in command position: `VAR=value` assignments, the shell keywords
 * that open a command list (`if …; then gh pr merge …` would otherwise pass
 * every trap unchecked, #1307 review), and the wrappers that run the next
 * word as a command, with their own options — the ones that take a value
 * (`env -u NAME`, `env -C DIR`, `env -S STRING`, `exec -a NAME`,
 * `timeout -k 5`, `xargs -I {}`) with it, and `timeout`'s duration, and the
 * redirections bash takes ahead of the command name (`2>/dev/null gh …`, #1606
 * review): an optional fd, one operator (`<`, `>`, `>>`, `>|`, `<>`, `&>`,
 * `&>>`, `>&`, `<&`, `<<<`) and its target, attached or not; a target holds no
 * operator character, so each redirection has one parse too.
 * A value never starts with `-`, so every token has exactly one parse: were a
 * `-u` free to take the next `-u` as its value, a long run of them on a
 * command that does not match backtracks exponentially, and regex time is not
 * bounded by the hook's spawn deadline.
 *
 * A heuristic, not a shell parser: the hooks catch mistakes, not deliberate
 * obfuscation. A string handed to a shell (`bash -c`, `eval`) is not lexed —
 * the rules read the raw command then ({@link view}).
 */
export const COMMAND_LEAD = String.raw`(?:(?:if|then|do|else|elif|while|until|!|\{)\s+|(?:time|command|exec|env|nohup)(?:\s+(?:-[uCSa]|--unset|--chdir|--split-string)\s+[^\s-]\S*|\s+-\S+)*\s+|timeout(?:\s+(?:-[ks]|--kill-after|--signal)\s+[^\s-]\S*|\s+-\S+)*\s+\d[\d.]*[smhd]?\s+|xargs(?:\s+-[IdEeLnPs]\s+[^\s-]\S*|\s+-\S+)*\s+|[A-Za-z_]\w*(?:\[[^\]\s]*\])?\+?=\S*\s+|\d*(?:<<<|[<>]&|&>>?|>>|>\||<>|<|>)\s*[^\s;&|()<>]+\s+)*`;

/** One character run of a git option's value: a quoted run (`"___"` in the masked text) or an escape stays whole. */
const GIT_VALUE_PART = String.raw`(?:"[^"]*"|'[^']*'|\\[\s\S]|[^\s\\"'])`;
/** A git option's value in the next word, which never starts with `-` (the {@link COMMAND_LEAD} rule: one parse per token). */
const GIT_VALUE = String.raw`(?:"[^"]*"|'[^']*'|\\[\s\S]|[^\s\\"'-])${GIT_VALUE_PART}*`;
/** git's global options that take a value in the next word. */
const GIT_VALUE_OPTIONS = String.raw`-C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix|--attr-source`;
/** git's global options that take a value after `=`. */
const GIT_EQ_OPTIONS = String.raw`--git-dir|--work-tree|--namespace|--config-env|--super-prefix|--attr-source|--exec-path|--list-cmds`;
/** git's global options that take no value. */
const GIT_FLAGS = String.raw`--no-pager|-p|--paginate|-P|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-advice|--no-lazy-fetch|--exec-path`;
/** One global option, its name in group 1 or 3 and its value in group 2 or 4 ({@link gitGlobals}). */
const GIT_OPTION = String.raw`(?:(${GIT_VALUE_OPTIONS})\s+(${GIT_VALUE})|(${GIT_EQ_OPTIONS})=(${GIT_VALUE_PART}*)|(?:${GIT_FLAGS})(?=\s))`;

/**
 * Every global option git takes between `git` and its verb (#1606), as a
 * regex fragment: `git${GIT_GLOBALS}commit\b` is a commit whatever options
 * come first — `-C <dir>` (any number of them), `-c <key=value>`,
 * `--git-dir`, `--work-tree`, `--namespace`, `--config-env`, `--super-prefix`
 * and `--attr-source` with a value in the next word or after `=`,
 * `--exec-path[=…]`, `--list-cmds=…`, and the options that take none
 * (`--no-pager`, `-p`, `--paginate`, `-P`, `--bare`, the pathspec switches,
 * `--no-replace-objects`, `--no-optional-locks`, `--no-advice`,
 * `--no-lazy-fetch`). Each git rule hand-rolled `git` and at most a `-C`
 * until #1606, so `git -c user.name=x commit` passed the spec-commit deny;
 * `scripts/claude-hooks/shell-lexer.test.mjs` fails on a hook module that
 * does that again.
 *
 * It matches the masked text, where a quoted value is one run (`-C "___"`),
 * and an unmasked one too, quote by quote. A value never starts with `-`, so
 * every token has one parse and a long run of options cannot backtrack
 * exponentially. It holds no capture group, so a rule's own groups keep their
 * numbers. Its values are read raw by {@link gitGlobals}.
 */
export const GIT_GLOBALS = String.raw`(?:\s+${GIT_OPTION.replace(/\((?!\?)/g, "(?:")})*\s+`;

/**
 * Anchors a command regex to COMMAND POSITION: the start of the string or of
 * a line (after any indent), or right after `|`, `;`, `&`, `(`, `)` or a
 * backtick, with any leading {@link COMMAND_LEAD}. Without this, a grep, an
 * echo or a docs edit that merely MENTIONS a trapped shape
 * (`grep 'pnpm exec vitest'`) would be denied.
 */
/** A `&` that ends a command, as a separator or a background: not a redirect's own, as in `2>&1`, `<&0` or `&>log`. */
const BOUNDARY_AMP = String.raw`(?<![<>])&(?!>)`;

export function cmd(re) {
  const flags = new Set([...re.flags, "m"]);
  const anchored = new RegExp(
    String.raw`(?:^[ \t]*|(?:[|;()\x60]|${BOUNDARY_AMP})\s*)${COMMAND_LEAD}(?:${re.source})`,
    [...flags].join(""),
  );
  // Read by `has`: an anchored regex is tested on the trusted-masked text.
  anchored.anchored = true;
  return anchored;
}

/**
 * Where the command whose arguments start at `from` in `text` (the
 * trusted-masked command) ends: at a newline, `;`, `|` or a lone `&` (not a
 * redirect's, as in `2>&1` or `&>`), or at the `)` or backtick that closes the
 * substitution or subshell it runs in (`inTick`: it runs inside a backtick
 * one) — each outside the substitutions its own arguments open, so a `$( … )`
 * or backtick argument, a heredoc inside one included, is part of the command
 * rather than its end. Inert text is masked, so a paren in a quote counts nowhere.
 */
export function commandEnd(text, from, inTick) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return i;
      depth--;
    } else if (depth > 0) continue;
    else if (ch === "\x60") {
      const close = inTick ? -1 : text.indexOf("\x60", i + 1);
      if (close < 0) return i;
      i = close;
    } else if (/[\n;|]/.test(ch) || (ch === "&" && !/[<>]/.test(text[i - 1] ?? "") && text[i + 1] !== ">")) return i;
  }
  return text.length;
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
export function commandWords(text, from) {
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
 * A command's words as the shell joins them: quoted and bare pieces with no
 * space between are one word, `--watch.onEnd="streamdeck restart x"` among
 * them, which {@link words} would split at the quote. A lone unmatched quote
 * stays a character of its word. A backslash escapes as bash reads it (#1526
 * second read): outside quotes it escapes the next character, a space
 * included, so `pnpm re\start:stream-deck` runs `restart:stream-deck`; inside
 * double quotes only before `$`, a backtick, `"`, `\` or a newline; inside
 * single quotes never. A script line's `\` is already `/` (`lineAs` in `script-runs.mjs`),
 * and a PowerShell backtick escape of an ordinary character arrives as one
 * ({@link powershellAsBash}).
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
 *
 * Two more rewrites read the program word as PowerShell does (#1606). A `&`
 * that leads a statement — at the start, or after `;`, `|`, `{`, `(`, a
 * newline, `&&` or `||` — is the call operator, which runs the quoted or
 * path program after it (`& "C:\…\gh.exe" pr merge 7`): it becomes a blank,
 * where bash would read a background job and the merge gate would refuse it.
 * Its dot-source operator, a statement-leading `.` with a blank after it
 * (`. gh pr merge 5`), runs the program after it too, and is blanked the same
 * way (#1606 review); in bash a `.` is `source`, and is left alone there.
 * And PowerShell resolves a command in any case, a cmdlet's alias included,
 * so each program word's last path segment is folded to lower case here,
 * where {@link view} keeps the case of a name bash finds by its spelling.
 */
export function powershellAsBash(command) {
  const bashed = command
    .replace(/`\r?\n|`[\s\S]?|\\/g, (m) => {
      if (m === "\\") return "/";
      if (m.endsWith("\n")) return " ".repeat(m.length);
      return PS_PLAIN_ESCAPE.test(m) ? `\\${m[1]}` : "_".repeat(m.length);
    })
    .replace(PS_CALL, "$1$2 ")
    .replace(PS_DOT, "$1$2 ");
  let folded = bashed;
  for (const [, b, cut] of view(bashed).programs) {
    const lower = bashed.slice(cut, b).toLowerCase();
    if (lower.length === b - cut) folded = folded.slice(0, cut) + lower + folded.slice(b);
  }
  return folded;
}

/** A PowerShell backtick escape that stands for the character it escapes ({@link powershellAsBash}). */
const PS_PLAIN_ESCAPE = /^`(?![0abefnrtvu])[A-Za-z0-9\-:./=+,@%_]$/;

/** PowerShell's call operator where it leads a statement ({@link powershellAsBash}): not `&&`, and not a redirect's `&`. */
const PS_CALL = /(^|[;|{(\n]|&&|\|\|)([ \t]*)&(?![&>])/g;

/** PowerShell's dot-source operator where it leads a statement ({@link powershellAsBash}): a `.` with a blank after it. */
const PS_DOT = /(^|[;|{(\n]|&&|\|\|)([ \t]*)\.(?=[ \t])/g;
