/**
 * The shell lexer every Bash and PowerShell rule reads a command through
 * (#1321, #1520, extracted in #1590): where a command is, what its words are,
 * and which directory it runs in.
 *
 * {@link maskInert} lexes a command as bash reads it and blanks its inert text
 * at the same length, and {@link view} sets that mask aside over the whole
 * command when the lexer is not sure of it and over each top-level list
 * element that hands a string or stdin to a shell (#1607, {@link trustedIn}), and rewrites
 * each program word to the plain name it runs (`gh.exe`, `"gh"`, `/usr/bin/gh` → `gh`,
 * #1606), the first word of each string a shell runs among them (#1634,
 * {@link fedStarts}). On top of it, {@link cmd} anchors a regex to command
 * position, and {@link GIT_GLOBALS} carries a git command past its global
 * options; {@link matchesAt}, {@link has} and {@link chainCommands} find a
 * command in the masked text — at command position, or as the first word a
 * fed shell or a wrapper runs ({@link programKind}) — and read its arguments
 * from the raw text at the same index;
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
 * Three more come with them (#1607). `top`: `masked` with everything that is
 * not command text of the top level blanked as well — inside a substitution,
 * a backtick, a `${ … }`, a `$(( … ))`, a paren group (its own parens kept),
 * a quote, an escape, a heredoc body and its terminator line — and comments
 * and line continuations as blanks, so {@link structure} reads the top-level
 * list elements off it without guessing where any of those are. `words`,
 * where each word bash reads ends, keyed by where it starts, at every depth
 * ({@link normalisePrograms}). And `heredocs`, every heredoc as `{ op, start,
 * end, resume }` — `op` the index of its `<<`, `[start, end)` its body up to
 * the terminator line, or to the end of the text when none comes, and
 * `resume` where the line after the terminator starts — so the body of one
 * fed to a shell can be read raw ({@link fedSpans}).
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
  // The command text of the top level only (#1607, {@link structure}): what is
  // inside a substitution, a paren group, a quote, an escape or a heredoc
  // body is `_`, and a comment or a line continuation is blank.
  const topText = s.split("");
  const pending = [];
  // Every heredoc, `{ op, start, end, resume }`: `op` the index of its `<<`,
  // `[start, end)` its body and `resume` where the line after its terminator
  // starts, at every depth (#1607, {@link fedSpans}).
  const heredocs = [];
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
    if (delim) pending.push({ delim, quoted, strip, op: i - 2 });
    else sure = false;
    return k;
  };

  // The queued heredoc bodies, from `at` (the line after their operators); returns where commands resume.
  const bodies = (at, limit, top) => {
    for (const { delim, quoted, strip, op } of pending.splice(0)) {
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
      heredocs.push({ op, start: at, end, resume });
      if (quoted) blank(out, at, end);
      else expanding(at, end, false);
      if (top) blank(flat, at, end);
      // The body and its terminator line are no command text of the top level.
      if (top) blank(topText, at, resume);
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
        if (!close) flat[i] = flat[i + 1] = topText[i] = topText[i + 1] = " ";
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
        // A comment is no token: a newline after `| # x` still continues the pipeline.
        if (!close) for (let k = i; k < end; k++) topText[k] = " ";
        i = end;
      } else if (atWord && ch === "(" && s[i + 1] === "(") i = arithmetic(i + 2, limit);
      else if ((sub = substitution(i, limit, false)) >= 0) i = sub;
      else if (ch === "\\") i += 2;
      else if (ch === "'") i = single(i + 1, limit, false);
      else if (ch === "$" && s[i + 1] === "'") i = single(i + 2, limit, true);
      else if (ch === '"') i = expanding(i + 1, limit, true);
      else {
        // Live text: a word, a paren, a here-string, a heredoc operator, a newline.
        const d0 = depth;
        let read = false;
        if (ch === "<" && s[i + 1] === "<") i = s[i + 2] === "<" ? i + 3 : heredoc(i + 2, limit);
        else if (ch === "\n" && pending.length) {
          read = true;
          i = bodies(i + 1, limit, !close);
        } else {
          if (ch === "(") depth++;
          else if (ch === ")" && depth > 0) depth--;
          else if (ch === ")" && close === ")") return i + 1;
          else if (ch === ")") sure = false; // closes nothing: bash would refuse the command
          i++;
        }
        // The top-level text keeps a paren group's own parens and blanks what
        // is inside it; `bodies` has blanked the heredoc bodies a newline read.
        if (!close && d0 > 0) {
          if (read) topText[from] = "_";
          else if (!(ch === ")" && depth === 0)) blank(topText, from, i);
        }
        atWord = " \t\n;&|()".includes(ch);
        continue;
      }
      if (!close && !(atWord && ch === "#")) blank(topText, from, i);
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
  maskInert.lastOut = {
    masked: out.join(""),
    flat: flat.join(""),
    top: topText.join(""),
    sure,
    words: wordEnds,
    heredocs,
  };
  return maskInert.lastOut;
}

/**
 * A word, at a word boundary in live text, that hands a STRING or stdin to a
 * shell — `bash -c '…'`, `eval "…"`, `bash <<'EOF'`, `xargs sh -c`, `trap '…'`,
 * `sudo -s`, `watch '…'`. The text those carry is executed, not inert, so
 * masking it would hide the very commands the rules exist for (#1321 review).
 * Each one sets the mask aside over the top-level list element that holds it
 * ({@link fedSpans}, #1607). `timeout` and `xargs` are not on it since #1607:
 * they run their arguments as a program, never as shell text, and the program
 * word after them is read in the masked text through {@link COMMAND_LEAD} —
 * while one of them anywhere in a chain once set the mask aside for all of it,
 * so a quoted `gh pr merge` in a grep pattern beside it read as a merge.
 */
const SHELL_NAMES = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "eval",
  "parallel",
  "watch",
  "su",
  "sudo",
  "source",
  "trap",
  "pwsh",
  "powershell",
  "cmd",
]);
const SHELL_WORDS = String.raw`(?:${[...SHELL_NAMES].join("|")})(?:\.exe)?`;
const SHELL_FED = new RegExp(String.raw`(?<=^|[\s;&|(\x60/])${SHELL_WORDS}(?=[\s;&|)\x60]|$)`, "gm");

/** sudo's short options that take a value in the next word or attached (`-u me`, `-ume`). */
const SUDO_VALUE_SHORT = "ughCDprtUT";
/** sudo's long options that take a value in the next word when none is attached with `=`. */
const SUDO_VALUE_LONG = new Set([
  "--user",
  "--group",
  "--chdir",
  "--chroot",
  "--host",
  "--prompt",
  "--role",
  "--type",
  "--other-user",
  "--close-from",
  "--command-timeout",
]);

/** One {@link COMMAND_LEAD} token (built from `leadToken`, which is hoisted), stepped over one at a time ({@link fedStarts}). */
const LEAD_TOKEN = new RegExp(leadToken("(?:"), "y");
/** The quote that opens a string a shell is handed, `$'…'` included ({@link fedStarts}). */
const STRING_OPEN = /\$?['"]/y;

/**
 * What a {@link SHELL_WORDS} word or a wrapper does with the words after it
 * ({@link commandOf}, #1634 review): `value`, its short options that take a
 * value — in the next word, or attached when not last in a cluster (`-u me`,
 * `-Eu me`, `-ume`); `long`, its long options that take one (`--user me`,
 * `--user=me`); `string`, the short option after which the first word that is
 * no option is the string it runs (`-c`, in a cluster too: `-lc`, `-eo
 * pipefail -c`), and `longString` its long forms (`--command`, `--command=…`);
 * `plus`, whether `+o` is an option as well. `read` replaces all of that for a
 * syntax of its own: PowerShell's parameters and cmd's switches. An option not
 * listed takes no value, and `--` ends the options. A value option always
 * takes its value, so `sudo -u gh pr merge 7` runs `pr` as the user `gh`, and
 * `bash -o pipefail -c '…'` reaches its string.
 */
const SH_OPTIONS = { value: "oO", long: ["--rcfile", "--init-file"], string: "c", plus: true };
const NO_OPTIONS = { value: "", long: [] };
/** PowerShell's parameters that take a value, with the shortest prefix pwsh takes for each. */
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
  ["workingdirectory", 2],
  ["wd", 2],
];
/** Whether `p` spells PowerShell's parameter `full`: at least its first `min` letters. */
const spells = (p, full, min) => p.length >= min && full.startsWith(p);
/**
 * PowerShell's parameters, as `pwsh` and `powershell.exe` read them: any
 * unambiguous prefix, with `-`, `--` or `/`, a value attached with `:` or in
 * the next word. `-Command` (`-c`, `-CommandWithArgs`) makes the first word
 * after it the string; `-File` runs a file and `-EncodedCommand` a base64
 * string, neither of which the lexer can read, so nothing after them counts.
 */
const PS_OPTIONS = {
  read(w) {
    // A value attached with `:`, or a quoted string glued to `-c` / `-Command`
    // (`pwsh -c"gh …"`): what pwsh makes of the latter is not certain, so it is
    // read as the string, erring to deny (#1634 second read).
    const m = /^(?:--?|\/)([A-Za-z?]+)(?::([\s\S]*)|(['"][\s\S]*))?$/.exec(w);
    if (!m) return null;
    const p = m[1].toLowerCase();
    const attached = m[2] ?? m[3];
    if (p === "c" || p === "cwa" || spells(p, "commandwithargs", 3))
      return attached === undefined ? { string: true } : { string: true, attached: w.length - attached.length };
    if (p === "e" || p === "ec" || spells(p, "encodedcommand", 2) || spells(p, "file", 1)) return { stop: true };
    return { value: attached === undefined && PS_VALUE_PARAMS.some(([full, min]) => spells(p, full, min)) };
  },
};
/**
 * cmd.exe's switches, `/x` or `/x:value`, and Git Bash's `//c` (which keeps
 * `/c` from becoming a path): `/c` and `/k` run what follows, glued to the
 * switch too (`cmd /c"gh …"`, `cmd /cgh …`), as `wrapperRuns` in
 * `script-runs.mjs` reads them.
 */
const CMD_OPTIONS = {
  read(w) {
    const m = /^\/\/?([A-Za-z?])(?::[\s\S]*|([\s\S]+))?$/.exec(w);
    if (!m) return null;
    if (!/^[ck]$/i.test(m[1])) return {};
    return m[2] === undefined ? { string: true } : { string: true, attached: w.length - m[2].length };
  },
};
const OPTION_SPECS = new Map([
  ...["bash", "sh", "zsh", "dash", "ksh"].map((name) => [name, SH_OPTIONS]),
  [
    "fish",
    {
      value: "CdDo",
      long: ["--init-command", "--debug", "--debug-output", "--debug-stack-frames", "--profile", "--profile-startup"],
      string: "c",
      longString: ["--command"],
      attachedString: true,
    },
  ],
  // `su [options] [-] [user [argument…]]`: the user is the first word that is no option, the string follows `-c`.
  [
    "su",
    {
      value: "sgG",
      long: ["--shell", "--group", "--supp-group"],
      string: "c",
      longString: ["--command", "--session-command"],
      attachedString: true,
    },
  ],
  ["sudo", { value: SUDO_VALUE_SHORT, long: [...SUDO_VALUE_LONG] }],
  ["watch", { value: "n", long: ["--interval"] }],
  [
    "parallel",
    {
      value: "adEIjLnNPsS",
      long: [
        "--arg-file",
        "--delimiter",
        "--eof",
        "--jobs",
        "--max-lines",
        "--max-args",
        "--max-procs",
        "--max-chars",
        "--sshlogin",
        "--sshloginfile",
        "--slf",
        "--colsep",
        "--delay",
        "--timeout",
        "--retries",
        "--results",
        "--joblog",
        "--env",
        "--wd",
        "--workdir",
        "--tmpdir",
        "--load",
        "--memfree",
        "--basefile",
        "--bf",
        "--halt",
        "--tagstring",
        "--rpl",
        "--return",
        "--transferfile",
        "--tf",
        "--block",
        "--block-size",
        "--header",
        "--recstart",
        "--recend",
        "--sshdelay",
        "--compress-program",
        "--decompress-program",
        "--termseq",
        "--limit",
        "--filter",
        "--semaphorename",
        "--id",
        "--semaphoretimeout",
        "--st",
        "--seqreplace",
        "--trim",
      ],
    },
  ],
  ["nice", { value: "n", long: ["--adjustment"] }],
  ["stdbuf", { value: "ioe", long: ["--input", "--output", "--error"] }],
  ["pwsh", PS_OPTIONS],
  ["powershell", PS_OPTIONS],
  ["cmd", CMD_OPTIONS],
]);
/**
 * The wrappers whose own argument is the program they run and that are not
 * {@link SHELL_WORDS} words ({@link fedStarts}'s wrapper pass): `nice`,
 * `stdbuf` and `winpty` (Git Bash's console wrapper, with no valued option).
 * `sudo` is a shell word, read with them.
 */
const WRAPPER_NAMES = new Set(["nice", "stdbuf", "winpty"]);
/** `find`'s `-exec` / `-execdir`: the word after either is the program it runs ({@link fedStarts}). */
const FIND_EXEC = /^-exec(?:dir)?$/;
/**
 * How many words past its program a shell word is read for a later string
 * option ({@link commandOf}): `bash file -c '…'` runs the file, but a value
 * option this table lacks would otherwise hide the string for good, and the
 * pre-hook errs to deny. Bounded, since every shell word of an element reads
 * from its own place, and unbounded that would be quadratic.
 */
const SCANNED_WORDS = 64;

/**
 * What `w` is as an option of a command with `spec` ({@link commandOf}):
 * `null` for a word that is none; `{ end }` for `--`; `{ stop }` for one after
 * which nothing can be read; `{ value }` when it takes the next word; `{
 * string, attached }` when the string it runs follows (attached at that offset
 * of `w`, or as the first later word that is no option); `{}` for a plain
 * switch. A short cluster is read letter by letter: a value letter not last
 * takes the rest of the word (`-ume`), last it takes the next word (`-Eu me`).
 */
function readOption(spec, w) {
  if (spec.read) return spec.read(w);
  if (w === "--") return { end: true };
  if (/^--[^\s=]/.test(w)) {
    const eq = w.indexOf("=");
    const name = eq < 0 ? w : w.slice(0, eq);
    if (spec.longString?.includes(name)) return eq < 0 ? { string: true } : { string: true, attached: eq + 1 };
    return { value: eq < 0 && spec.long.includes(name) };
  }
  if (/^-[A-Za-z]/.test(w) || (spec.plus && /^\+[A-Za-z]/.test(w))) {
    let string = false;
    for (let k = 1; k < w.length; k++) {
      // getopt takes the rest of the word as the option's argument (`su -c'…'`,
      // `fish -c'…'`); bash reads `-cx` as the flags `c` and `x`.
      if (spec.string && w[k] === spec.string && spec.attachedString && k < w.length - 1)
        return { string: true, attached: k + 1 };
      if (spec.string && w[k] === spec.string) string = true;
      else if (spec.value.includes(w[k])) return { string, value: k === w.length - 1 };
    }
    return { string };
  }
  return w.startsWith("-") ? {} : null;
}

/** One word of a command from where it is tried, sticky, past blanks: quotes and escapes kept whole, ending at an operator character ({@link commandOf}). */
const COMMAND_WORD = /[ \t]*((?:"(?:[^"\\]|\\[\s\S])*"|'[^']*'|\\[\s\S]|[^\s"'\\;&|()\x60])+)/y;
/** A redirection word ({@link commandOf}); {@link BARE_REDIRECTION} is one whose target is the next word. */
const REDIRECTION = /^\d*(?:[<>]|&>)/;
const BARE_REDIRECTION = /^\d*(?:[<>]{1,3}-?|[<>]&|&>>?|>\|)$/;

/**
 * What the command whose program word ends at `from` in `text` runs, read
 * forward over its own words up to `limit` as `spec` says ({@link
 * OPTION_SPECS}): `program`, where its first word that is no option starts —
 * the program a wrapper runs, a shell's script file, su's user — and
 * `string`, where the string its string option names starts (`bash -c '…'`,
 * `pwsh -Command "…"`, `cmd //c "…"`, `su - me -c '…'`). A value option takes
 * its value, a redirection its target, `--` ends the options; past the
 * program the words are still read for a string option, {@link
 * SCANNED_WORDS} at most, so an option the spec does not know costs at worst
 * a false program, never a missed string. Reading stops at a `;`, `&`, `|`,
 * paren, backtick or newline, as the command does.
 */
function commandOf(spec, text, from, limit) {
  COMMAND_WORD.lastIndex = from;
  const next = () => {
    const m = COMMAND_WORD.exec(text);
    return m && COMMAND_WORD.lastIndex <= limit ? { w: m[1], at: COMMAND_WORD.lastIndex - m[1].length } : undefined;
  };
  const scansOn = Boolean(spec.string || spec.longString || spec.read);
  let options = true;
  let stringNext = false;
  let scanned = 0;
  let program;
  let string;
  let attached = false;
  for (let word = next(); word; word = next()) {
    if (REDIRECTION.test(word.w)) {
      if (BARE_REDIRECTION.test(word.w) && !next()) break;
      continue;
    }
    const o = options ? readOption(spec, word.w) : null;
    if (o?.stop) break;
    if (o?.end) {
      options = false;
      continue;
    }
    if (o) {
      if (o.string && o.attached !== undefined) {
        string = word.at + o.attached;
        attached = true;
        break;
      }
      if (o.string) stringNext = true;
      if (o.value && !next()) break;
      continue;
    }
    if (stringNext) {
      string = word.at;
      break;
    }
    if (program === undefined) program = word.at;
    if (!scansOn || ++scanned > SCANNED_WORDS) break;
  }
  // `attached`: the string is glued to its switch (`cmd /c"…"`, `su -c'…'`), a
  // form a reader of the spaced one (`bash -c '…'`) does not see.
  return { program, string, attached };
}

/**
 * Whether the sudo whose word ends at `from` in `text` runs a shell (#1607):
 * among its options, before its command, a `-s` or `-i` (in a cluster too,
 * `-Es`), `--shell` or `--login`. That shell runs its argument as shell text
 * (`sudo -s "$X"`, as `$SHELL -c`), so it is an interpreter for {@link
 * feedsAcross}; any other sudo runs its arguments as a program.
 */
function sudoRunsShell(text, from) {
  const word = /\s+([^\s;&|()<>]+)/y;
  word.lastIndex = from;
  for (let m; (m = word.exec(text));) {
    const w = m[1];
    if (w === "--shell" || w === "--login") return true;
    if (w === "--" || !w.startsWith("-")) return false;
    if (w.startsWith("--")) {
      if (SUDO_VALUE_LONG.has(w)) word.exec(text);
      continue;
    }
    for (let k = 1; k < w.length; k++) {
      if (w[k] === "s" || w[k] === "i") return true;
      if (SUDO_VALUE_SHORT.includes(w[k])) {
        // The value is the rest of the word, or the next word when none is attached.
        if (k === w.length - 1) word.exec(text);
        break;
      }
    }
  }
  return false;
}

/** The shells that read their script from stdin when handed no `-c` and no script file ({@link stdinShellIn}). */
const STDIN_SHELL = /(?<=^|[\s;&|(\x60/])(?:bash|sh|zsh|dash|ksh)(?=\s|$)/g;
/** An `echo` or `printf` at the start of a pipeline stage, past a {@link COMMAND_LEAD}: its name is group 1. */
const ECHO_AT = new RegExp(String.raw`^\s*(?:${leadToken("(?:")})*(echo|printf)(?=\s)`, "d");

/**
 * The raw text of a fed span `[a, b)` read crudely, quotes kept whole
 * ({@link fedStarts}): `quotes`, each quoted string as `[open, close]`
 * (the indices of its quotes), and `pipelines`, each a list of its stages as
 * `[start, end)`, split at an unquoted `|` or `|&` and ended by `;`, `&&`,
 * `||`, a lone `&` or a newline.
 */
function pipelinesOf(command, a, b) {
  const quotes = [];
  const pipelines = [];
  let stages = [];
  let start = a;
  const cut = (at, next, ends) => {
    stages.push([start, at]);
    if (ends) {
      pipelines.push(stages);
      stages = [];
    }
    start = next;
  };
  for (let i = a; i < b; i++) {
    const c = command[i];
    if (c === "\\") i++;
    else if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < b && command[k] !== c) k += c === '"' && command[k] === "\\" ? 2 : 1;
      quotes.push([i, k]);
      i = k;
    } else if ((c === "|" || c === "&") && command[i + 1] === c) {
      cut(i, i + 2, true);
      i++;
    } else if (c === "|") cut(i, command[i + 1] === "&" ? i + 2 : i + 1, false);
    else if (c === ";" || c === "\n" || (c === "&" && !/[<>|]/.test(command[i - 1] ?? "") && command[i + 1] !== ">"))
      cut(i, i + 1, true);
  }
  cut(b, b, true);
  return { quotes, pipelines };
}

/** The words of `text[a, b)` as `{ w, at }`, quotes and escapes kept whole ({@link stdinShellIn}, {@link printedArgs}). */
function wordsIn(text, a, b) {
  return [...text.slice(a, b).matchAll(/(?:"(?:[^"\\]|\\[\s\S])*"|'[^']*'|\\[\s\S]|[^\s"'\\])+/g)].map((m) => ({
    w: m[0],
    at: a + m.index,
  }));
}

/** A redirection that gives a command its stdin: `<`, `<<`, `<<<`, `<&`, `<>`, with an optional fd 0. Group 1 is the operator. */
const INPUT_REDIRECT = /^0?(<<<|<<-?|<&|<>|<)(?!\()/;
/** A redirection of an output descriptor (`>`, `>>`, `>|`, `&>`, `2>&1`, `1<&-` aside), which leaves stdin as it is. */
const OUTPUT_REDIRECT = /^(?:\d*(?:>>?|>\||>&)|&>>?|[1-9]\d*<[&>]?)/;

/**
 * Where the shell the pipeline stage `[s, e)` of `text` runs reads its script
 * (#1607, CodeRabbit on PR #1632), as `{ input, via }`: `input` is `"pipe"`
 * when a {@link STDIN_SHELL} word that is the program ({@link programKindIn},
 * so `sudo bash` too) reads it from the pipeline, or the index of the word a
 * here-string hands it when that is its last input redirection; `via` the
 * shell word. `undefined` when it reads no stdin script. Its own words are
 * options only — a `-c` (`-xc` included) or a script-file word means no stdin
 * script, the value of `-o` is skipped, and everything after a `-s` is its
 * positional parameters — and the last input redirection among them is its
 * stdin, as bash takes it: a file, a heredoc or a descriptor (`</dev/null`,
 * `0<f`, `<&3`) replaces the pipe. An output redirection changes nothing.
 */
function stdinShellIn(text, byName, [s, e]) {
  for (const m of text.slice(s, e).matchAll(STDIN_SHELL)) {
    if (!byName.has(s + m.index)) continue;
    const words = wordsIn(text, s + m.index + m[0].length, e);
    let input = "pipe";
    let positional = false;
    for (let k = 0; k < words.length; k++) {
      const { w } = words[k];
      const redirect = INPUT_REDIRECT.exec(w);
      if (redirect) {
        // The target is attached, or the next word.
        const bare = redirect[0].length === w.length;
        const target = bare ? words[++k] : { at: words[k].at + redirect[0].length };
        input = redirect[1] === "<<<" && target ? target.at : "other";
      } else if (OUTPUT_REDIRECT.test(w)) {
        // A bare operator takes the next word as its target.
        if (/^\d*(?:>>?|>\||&>>?|>&|<&|<>|<)$/.test(w)) k++;
      } else if (positional || w.startsWith("--")) continue;
      else if (w === "-o" || w === "+o") k++;
      else if (/^[-+][A-Za-z]*c/.test(w)) return undefined;
      else if (/^-[A-Za-z]*s/.test(w)) positional = true;
      else if (!/^[-+]/.test(w)) return undefined;
    }
    return input === "other" ? undefined : { input, via: m[0] };
  }
  return undefined;
}

/** A `printf` format's literal text that leaves the next argument at the start of a command: blanks, `\n` and `;`. */
const COMMAND_GAP = /^(?:[ \t]|\\[nt]|;)*$/;

/**
 * Whether the `k`th argument (from 0) of a `printf` whose format word is
 * `format` starts a command in what it prints (#1607, CodeRabbit on PR
 * #1632): the format must be made of `%s` / `%b` conversions with nothing but
 * blanks, `\n` and `;` around them, and the literal text before the
 * conversion the argument fills — across the format's end when printf
 * reuses it — must hold a `\n` or `;`, or be the start of the output. Any
 * other literal text (`'echo %s\n'`, `'x%s'`) puts every argument inside a
 * command.
 */
function printfArgStartsCommand(format, k) {
  const body = /^(['"])([\s\S]*)\1$/.exec(format)?.[2] ?? format;
  const literals = body.split(/%[sb]/);
  const conversions = literals.length - 1;
  if (conversions === 0 || !literals.every((l) => COMMAND_GAP.test(l))) return false;
  const j = k % conversions;
  if (j > 0) return /\\n|;/.test(literals[j]);
  return k === 0 || /\\n|;/.test(literals[conversions] + literals[0]);
}

/**
 * The words an `echo` or `printf` (named `name`, its word ending at `from` in
 * `text`) prints, up to `e`, as `{ w, at }`: its options and redirections
 * skipped, each argument one word with its quotes. `undefined` for a `printf
 * -v`, which prints nothing.
 */
function printedArgs(text, from, e, name) {
  const args = [];
  const words = wordsIn(text, from, e);
  for (let k = 0; k < words.length; k++) {
    const { w } = words[k];
    if (/^\d*[<>&]/.test(w)) {
      if (/^\d*(?:[<>]{1,3}-?|[<>]&|&>>?|>\|)$/.test(w)) k++;
    } else if (name === "printf" && w === "-v") return undefined;
    else if (args.length === 0 && (w === "--" || (name === "echo" ? /^-[neE]+$/ : /^-/).test(w))) continue;
    else args.push(words[k]);
  }
  return args;
}

/**
 * Where the words a shell word or a wrapper runs start (#1607, #1634): a map
 * from each such index to how that word is the program (`{ how, via, stdin,
 * piped }`), plus `quotes`, every quoted string of the fed spans as `[open,
 * close]` ({@link pipelinesOf}), and `quoteKinds`, the kind of each string a
 * shell runs by its opening quote. Each position is at command position as a
 * {@link cmd} anchor is after a boundary: {@link view} hands them to {@link
 * normalisePrograms}, so the word is a program word — rewritten to the name it
 * runs (`bash -c 'gh.exe …'`, `nice gh.exe …`), listed in {@link view}'s
 * `programs` with its kind, and read by every rule as a word typed directly
 * is. Four things put a word there, each read forward from a word that is
 * already a program (`byName`), so a shell word or wrapper that is an argument
 * (`rg -t sh "gh …"`, `ls /bin/sh "…"`, CodeRabbit on PR #1632) feeds nothing:
 *
 * - A {@link SHELL_WORDS} word, past its options with their values ({@link
 *   commandOf}, {@link OPTION_SPECS}): the word after them — whole, quoted or
 *   not, for a `sudo` that runs a program (`sudo gh …`, `sudo -u me gh …`,
 *   `sudo "gh" …`; `how` is `"wrapper"`, {@link sudoRunsShell}); read inside
 *   its quotes for a shell, whose word is the string it runs (`eval "gh …"`,
 *   `trap 'gh …' EXIT`, `bash -c 'gh …'`, `bash -o pipefail -c '…'`, `pwsh
 *   -ExecutionPolicy Bypass -Command "…"`, `cmd //c "…"`, `su - me -c '…'`;
 *   `how` is `"shell"`) — past a {@link COMMAND_LEAD} inside the string, token
 *   by token (`bash -c 'GH_REPO=x gh …'`, `bash -c 'exec gh …'`), never past
 *   the string's close, and never the quoted string whole (`bash -c 'x'` keeps
 *   its quotes in the text, as every raw view has since #1606: a program
 *   quoted whole in a string a shell joins from its words, `eval "gh" pr
 *   merge`, is the one shape not read). `via` is the shell word.
 * - The word a `nice`, `stdbuf` or `winpty` that is a program runs, past its
 *   options with their values, and the word after each `-exec` / `-execdir`
 *   of a `find` that is a program ({@link WRAPPER_NAMES}, {@link FIND_EXEC};
 *   `how` is `"wrapper"`, `via` the wrapper or `"find -exec"`).
 * - The first word, past blanks and a {@link COMMAND_LEAD}, of a word that
 *   starts a command in what an `echo` or `printf` prints — `echo`'s first
 *   argument (it joins the rest with blanks), and `printf`'s format, or an
 *   argument its format puts at the start of a line or after a `;` ({@link
 *   printfArgStartsCommand}: `printf '%s\n' 'gh …'`, not `printf 'echo %s\n'
 *   'gh …'`) — piped on in the same element to a shell that reads its script
 *   from the pipeline ({@link stdinShellIn}: `| bash`, `| sh -s`, `| sudo
 *   bash -x`, not `| bash </dev/null`). `stdin` and `piped` are set; `via` is
 *   the shell word.
 * - The first word of a here-string that is such a shell's last input
 *   redirection (`bash <<< 'gh …'`; `stdin` set, `piped` not).
 *
 * A later word after a `;` or a newline in the string is at command position
 * in the raw text already ({@link cmd}); the same string piped to anything
 * else, or written to a file, is a mention. Positions are recorded, never
 * searched for, so the pass is linear in the text (one option step per word,
 * one lead step per token), whatever a rule later asks about.
 */
function fedStarts(command, text, fed, programs) {
  const byName = programsByName(text, programs);
  const wordStarts = wordStartsOf(programs, text.length);
  const starts = new Map();
  const quotes = [];
  const quoteKinds = new Map();
  // `p`, and the position after each lead token from it, up to `limit`. Each
  // is recorded at its raw word's start, which a rewritten word's pad hides
  // from `p` (`nice nice.exe gh`: the second nice is read at its name, four
  // characters into its word), so the position is the same in every round
  // and {@link normalisePrograms} finds the word there (#1634 second read).
  const leads = (p, kind, limit) => {
    for (;;) {
      if (p >= limit) return;
      const at = wordStarts[p] >= 0 ? wordStarts[p] : p;
      if (!starts.has(at)) starts.set(at, kind);
      LEAD_TOKEN.lastIndex = p;
      const m = LEAD_TOKEN.exec(text);
      if (!m?.[0] || p + m[0].length > limit) return;
      p += m[0].length;
    }
  };
  // Where the command holding `p` ends: its next operator character or newline.
  const commandEnd = (p) => {
    const stop = text.slice(p).search(/[\n;&|()\x60]/);
    return stop < 0 ? text.length : p + stop;
  };
  // The wrappers and the `find`s among the program words: what each runs.
  for (const p of byName.keys()) {
    PROGRAM_WORD.lastIndex = p;
    const name = PROGRAM_WORD.exec(text)?.[0];
    if (WRAPPER_NAMES.has(name)) {
      const { program } = commandOf(OPTION_SPECS.get(name) ?? NO_OPTIONS, text, p + name.length, text.length);
      if (program !== undefined) leads(program, { how: "wrapper", via: name }, commandEnd(program));
    } else if (name === "find") {
      COMMAND_WORD.lastIndex = p + name.length;
      for (let exec = false, m; (m = COMMAND_WORD.exec(text)); exec = FIND_EXEC.test(m[1])) {
        const at = COMMAND_WORD.lastIndex - m[1].length;
        if (exec) leads(at, { how: "wrapper", via: "find -exec" }, commandEnd(at));
      }
    }
  }
  for (const [a, b] of fed) {
    const own = pipelinesOf(command, a, b);
    quotes.push(...own.quotes);
    const closeOf = (open) => own.quotes.find(([o]) => o === open)?.[1];
    // The word at `p` when no quote opens it (`eval gh …`, `cmd /c pnpm …`);
    // else the first word of the string inside, past blanks and a lead, up to
    // the string's close.
    const stringAt = (p, kind, limit) => {
      STRING_OPEN.lastIndex = p;
      const q = STRING_OPEN.exec(text);
      if (!q) return leads(p, kind, limit);
      const open = p + q[0].length - 1;
      const close = closeOf(open) ?? limit;
      quoteKinds.set(open, kind);
      leads(open + 1 + /^\s*/.exec(text.slice(open + 1, close))[0].length, kind, close);
    };
    // The shell words among the program words of the span ({@link SHELL_NAMES}:
    // a rewritten program word spells its plain name), inside a string too.
    for (const p of byName.keys()) {
      if (p < a || p >= b) continue;
      PROGRAM_WORD.lastIndex = p;
      const via = PROGRAM_WORD.exec(text)?.[0];
      if (!SHELL_NAMES.has(via)) continue;
      const kind =
        via === "sudo" && !sudoRunsShell(text, p + via.length) ? { how: "wrapper", via } : { how: "shell", via };
      const { program, string, attached } = commandOf(OPTION_SPECS.get(via) ?? NO_OPTIONS, text, p + via.length, b);
      // A wrapper's word is the program whole, quoted or not; a shell's is the string it runs.
      if (program !== undefined) (kind.how === "wrapper" ? leads : stringAt)(program, kind, b);
      if (string !== undefined) stringAt(string, attached ? { ...kind, attached: true } : kind, b);
    }
    for (const stages of own.pipelines) {
      // Each stage's reader of a stdin script, read once, and the first one past each stage that reads the pipe.
      const readers = stages.map((stage) => stdinShellIn(text, byName, stage));
      const piped = readers.map(() => undefined);
      for (let k = stages.length - 2; k >= 0; k--)
        piped[k] = readers[k + 1]?.input === "pipe" ? readers[k + 1] : piped[k + 1];
      stages.forEach(([s, e], k) => {
        const here = readers[k];
        if (typeof here?.input === "number") stringAt(here.input, { how: "shell", via: here.via, stdin: true }, e);
        const echo = ECHO_AT.exec(text.slice(s, e));
        if (!echo || !byName.has(s + echo.indices[1][0])) return;
        const reader = piped[k];
        if (!reader) return;
        const args = printedArgs(text, s + echo.indices[1][1], e, echo[1]);
        args?.forEach(({ at }, j) => {
          const starts = echo[1] === "echo" ? j === 0 : j === 0 || printfArgStartsCommand(args[0].w, j - 1);
          if (starts) stringAt(at, { how: "shell", via: reader.via, stdin: true, piped: true }, e);
        });
      });
    }
  }
  return { starts, quotes, quoteKinds };
}

/** A program word's name from where it starts ({@link fedStarts}): the rewritten text has it plain, right-aligned in its word. */
const PROGRAM_WORD = /[^\s;&|()\x60'"]+/y;

/** How a word at command position is the program: after a boundary and a {@link COMMAND_LEAD}. */
const COMMAND = Object.freeze({ how: "command" });

/**
 * {@link view}'s program words keyed by where each one's rewritten name
 * starts, to how it is the program: the kind {@link fedStarts} gave it, or
 * {@link COMMAND}. A rule that finds a program by an unanchored regex lands on
 * the name, which is right-aligned in its word's span ({@link normalisePrograms}).
 */
function programsByName(text, programs) {
  const byName = new Map();
  for (const [, b, cut, , kind] of programs) byName.set(b - text.slice(cut, b).trim().length, kind ?? COMMAND);
  return byName;
}

/**
 * How the word whose name starts at `at` in {@link view}'s text is the program
 * its command runs, or `undefined` for a word that is none (CodeRabbit on PR
 * #1632, #1634): `{ how: "command" }` for a program word the rewrite read at
 * command position ({@link normalisePrograms}, so past a {@link COMMAND_LEAD}
 * — `env A=1 bash`, `timeout 5 sh`, `xargs gh`, assignments, keywords); `{
 * how: "shell", via, stdin, piped }` for the first word a fed shell runs; `{
 * how: "wrapper", via }` for the word a `sudo`, `nice`, `stdbuf` or `winpty`
 * runs or the word after `find -exec` ({@link fedStarts}). A word anywhere else
 * is an argument (`rg -t sh`, `ls /bin/sh`, `echo gh pr merge 5`, `sudo
 * ./build-jq`, the user of `sudo -u gh`). A position {@link fedStarts}
 * recorded counts even where its word is no program word — an assignment, as
 * `bash -c 'IRACEDECK_MOCK=0 pnpm test'` starts with — as a {@link cmd} anchor
 * takes a zero lead. A lookup, never a search: every position was read forward
 * from a program word when the view was built.
 */
export function programKind(command, at) {
  const { byName, starts } = view(command);
  return byName.get(at) ?? starts.get(at);
}

/** Whether the word whose name starts at `at` in {@link view}'s text is the program its command runs ({@link programKind}). */
export const programAt = (command, at) => programKind(command, at) !== undefined;

/**
 * The quoted string of a fed span that holds `index` from outside the program
 * word `index` is in, as `[open, close]` ({@link view}'s `quotes`), or
 * `undefined`. A program word's own quotes (`"gh" pr merge`, `"bash" -c`) are
 * its spelling, not a string around it: the quote must open before the word
 * starts ({@link wordStartOf}).
 */
function stringAround(v, index) {
  const start = wordStartOf(v, index);
  return v.quotes.find(([open, close]) => open < start && index <= close);
}

/**
 * The index of the quote that closes the string holding `index`, when that
 * string is one a fed span's raw text shows ({@link stringAround});
 * `undefined` outside one. A command found inside a string a shell is handed
 * ends at that string's close: its match, its groups and its arguments read no
 * further ({@link matchesAt}, {@link chainCommands}).
 */
export const stringEnd = (command, index) => stringAround(view(command), index)?.[1];

/** The `[open, close]` quotes of the string holding `index` ({@link stringAround}), or `undefined` outside one. */
export const stringBounds = (command, index) => stringAround(view(command), index);

/**
 * How the string holding `index` reaches a shell ({@link fedStarts}'s kind for
 * its opening quote: `via`, `stdin`, `piped`), or `undefined` for text outside
 * one, or in a string no shell runs. A rule that reads what follows a command
 * inside a string asks this for what follows the string: the pipe after `sh -c
 * '…'` hides the shell's exit, the one after `echo '…'` feeds `bash`.
 */
export function stringKind(command, index) {
  const v = view(command);
  const quote = stringAround(v, index);
  return quote && v.quoteKinds.get(quote[0]);
}

/** The reserved words that open a compound command, and those that close one ({@link structure}). */
const GROUP_OPEN = new Set(["if", "while", "until", "for", "select", "case", "{", "[["]);
const GROUP_CLOSE = new Set(["fi", "done", "esac", "}"]);
/** The reserved words after which the next word is at command position again. */
const COMMAND_PREFIX = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{", "time"]);

/**
 * The boundaries of the top-level list elements of a command, as `{ at, end }`
 * ranges in order (#1607), read off `top`, the lexer's top-level text
 * ({@link maskInert}), where everything inside a substitution, a backtick, a
 * `${ … }`, a `$(( … ))`, a paren group, a quote, an escape or a heredoc body
 * is already `_` — the lexer knows exactly where those are, so a separator
 * inside one is never a boundary, and an escaped `\;` is none either.
 *
 * A boundary is a newline, `;`, `&&`, `||` or a lone `&` (not a redirect's
 * `>&`, `<&` or `&>`, nor the `&` of `|&`), outside every compound command:
 * `if` … `fi`, `while` / `until` / `for` / `select` … `done`, `case` …
 * `esac`, `{` … `}` and `[[` … `]]`, each counted where it stands at command
 * position, at the top level only. A pipe is none. A newline is none either
 * where the list goes on over it: after `|`, `|&`, `&&` or `||`, past blanks,
 * blank lines and a comment, and past the heredoc bodies that line read. A
 * newline that ends an element reaches over the heredoc bodies and
 * terminator lines that follow it, so the next element starts after them. An
 * opener without its closer holds every boundary after it, which only widens
 * an element; a closer with no opener counts for nothing, and `]]` closes only
 * a `[[` that is open. Reserved words are read at the top level only, where
 * bash finds them in valid input; a group opened some other way (`coproc
 * NAME { … }`) is not modelled.
 */
function structure(top, heredocs) {
  const seps = [];
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    if (c === "\n") {
      // The last token before it, past blanks, comments and heredoc bodies.
      let q = i - 1;
      for (let h; q >= 0; q--) {
        if ((h = heredocs.find((x) => x.start <= q && q < x.resume))) q = h.start;
        else if (!/\s/.test(top[q])) break;
      }
      if (top[q] === "|" || (top[q] === "&" && /[&|]/.test(top[q - 1] ?? ""))) continue;
      let end = i + 1;
      for (let h; (h = heredocs.find((x) => x.start === end && x.resume > end));) end = h.resume;
      seps.push({ at: i, end, kind: "sep" });
      i = end - 1;
    } else if (c === ";") seps.push({ at: i, end: i + 1, kind: "sep" });
    else if ((c === "&" || c === "|") && top[i + 1] === c) {
      seps.push({ at: i, end: i + 2, kind: "sep" });
      i++;
    } else if (c === "&" && !/[<>|]/.test(top[i - 1] ?? "") && top[i + 1] !== ">")
      seps.push({ at: i, end: i + 1, kind: "sep" });
  }
  const words = [...top.matchAll(/[^\s;&|()<>]+/g)];
  const memo = new Map();
  // Whether only blanks stand between the `a`th word and the next one.
  const adjacent = (a) => /^[ \t]*$/.test(top.slice(words[a].index + words[a][0].length, words[a + 1].index));
  // Whether the `k`th word stands at command position: at the start of a line
  // (a newline is a boundary, #1607 second read), after the start, a
  // separator, a pipe, a paren or a heredoc's terminator line, or after a
  // reserved word that does — `time` past its own options (`time -p {`).
  const commandPosition = (k) => {
    if (memo.has(k)) return memo.get(k);
    let q = words[k].index - 1;
    while (q >= 0 && (top[q] === " " || top[q] === "\t")) q--;
    let yes = false;
    if (q < 0 || "\n;|()".includes(top[q]) || heredocs.some((h) => h.resume === q + 1)) yes = true;
    else if (top[q] === "&") yes = !/[<>]/.test(top[q - 1] ?? "");
    else if (k > 0 && adjacent(k - 1)) {
      let p = k - 1;
      while (p > 0 && words[p][0].startsWith("-") && adjacent(p - 1)) p--;
      const prev = words[p][0];
      if (COMMAND_PREFIX.has(prev) && (p === k - 1 || prev === "time")) yes = commandPosition(p);
      // `function name {`: the brace opens the body.
      else if (words[k][0] === "{" && k > 1 && words[k - 2][0] === "function") yes = commandPosition(k - 2);
    }
    memo.set(k, yes);
    return yes;
  };
  const events = [...seps];
  words.forEach((m, k) => {
    // `]]` closes a `[[` wherever it stands; the others count at command position.
    if (m[0] === "]]") events.push({ at: m.index, end: m.index + 2, kind: "close]]" });
    else if (GROUP_OPEN.has(m[0]) && commandPosition(k))
      events.push({ at: m.index, end: m.index + m[0].length, kind: m[0] === "[[" ? "open[[" : "open" });
    else if (GROUP_CLOSE.has(m[0]) && commandPosition(k))
      events.push({ at: m.index, end: m.index + m[0].length, kind: "close" });
  });
  events.sort((x, y) => x.at - y.at);
  const boundaries = [];
  let depth = 0;
  let tests = 0;
  for (const e of events) {
    if (e.kind === "sep") {
      if (depth === 0) boundaries.push(e);
    } else if (e.kind === "open[[") {
      tests++;
      depth++;
    } else if (e.kind === "close]]") {
      if (tests > 0) {
        tests--;
        depth--;
      }
    } else if (e.kind === "open") depth++;
    else if (depth > 0) depth--;
  }
  return boundaries;
}

/**
 * The `[start, end)` spans of a command where a shell is fed (#1607): for
 * each {@link SHELL_FED} word in `text` (the masked, program-normalised
 * command), the top-level list element that holds it ({@link structure}) —
 * so a pipeline, a subshell, a group or a compound command a shell is part of
 * (`echo '…' | bash`, `… | { cd x && bash; }`, `while …; done | sh`) is one
 * element, and a word inside a substitution (`x=$(a; … | sh)`) sets aside the
 * whole top-level element that holds the substitution, and no more — plus the
 * body of every heredoc whose `<<` is in that element (`bash <<'EOF'`). A
 * word inside a heredoc body is read where its heredoc's `<<` is. Overlapping
 * and touching spans are merged.
 */
function fedSpans(command, text, top, heredocs) {
  const boundaries = structure(top, heredocs);
  const spans = [];
  // The elements whose word interprets shell text, not just runs a program.
  const interpreted = [];
  for (const m of text.matchAll(SHELL_FED)) {
    let anchor = m.index;
    for (let h; (h = heredocs.find((x) => x.start <= anchor && anchor < x.end));) anchor = h.op;
    let start = 0;
    let end = text.length;
    for (const b of boundaries) {
      if (b.end <= anchor) start = b.end;
      else if (b.at >= anchor) {
        end = b.at;
        break;
      }
    }
    const element = [[start, end], ...heredocs.filter((h) => h.op >= start && h.op < end).map((h) => [h.start, h.end])];
    spans.push(...element);
    if (!SUDO.test(m[0]) || sudoRunsShell(text, m.index + m[0].length)) interpreted.push(...element);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return feedsAcross(command, text, merged, interpreted) ? [[0, text.length]] : merged;
}

/** The {@link SHELL_FED} word that runs its arguments as a program, unless it runs a shell ({@link sudoRunsShell}). */
const SUDO = /^sudo(?:\.exe)?$/;

/**
 * What makes a shell's own element read text from a later one (#1607 second
 * read), in the masked text of that element: a function definition (`f() {
 * bash; }`, `function f { sh; }`, fed by a later `… | f`), an `exec` with a
 * redirection (`exec > >(bash)`, `exec 3> >(bash)`, fed by every later
 * output) and a `coproc` (fed through its descriptors).
 */
const HOLDS = new RegExp(
  [
    String.raw`(?:^|[\s;&|(\x60])(?:function|coproc)(?=[\s;&|)\x60]|$)`,
    String.raw`[\w.-]\s*\(\s*\)`,
    String.raw`(?:^|[\s;&|(\x60])exec\s[^;&|\n]*[<>]`,
  ].join("|"),
  "m",
);

/** A parameter expansion: `$name`, `${…}`, `$1`, `$@` and the other special parameters. */
const PARAMETER = /\$[A-Za-z_{0-9@*#?!$-]/;

/**
 * What stores text for a shell in another element to read, in the masked
 * text of the elements the mask stands over ({@link feedsAcross}): a builtin
 * that exports a variable or sets an alias (`export`, `declare`, `typeset`,
 * `alias`, `set -a`), a function definition, `exec` (a descriptor a later
 * command reads, `exec 3< <(…)`), `tee`, and a redirection that writes a file
 * other than `/dev/null` (not a descriptor's copy, `2>&1`). A plain
 * assignment is none: a shell in another element sees an unexported variable
 * only through an expansion, which {@link PARAMETER} catches in that element.
 */
const STORES = new RegExp(
  [
    String.raw`(?:^|[\s;&|(\x60])(?:export|declare|typeset|alias|function|exec|tee)(?=[\s;&|)\x60]|$)`,
    String.raw`(?:^|[\s;&|(\x60])set\s+(?:-[A-Za-z]*a|-o\s+allexport)\b`,
    String.raw`[\w.-]\s*\(\s*\)`,
    String.raw`(?:&>>?|>>?|>\|)(?!&)\s*(?!/dev/null(?![^\s;&|()<>]))[^\s;&|()<>]`,
  ].join("|"),
  "m",
);

/**
 * Whether a shell interpreter fed in `command` may be handed text from an
 * element the mask stands over (#1607): its own element expands a variable
 * ({@link PARAMETER}, raw, since `bash -c '$X'` expands in the inner shell),
 * or another element stores text ({@link STORES}) — `x='…'; eval "$x"`,
 * `echo '…' > f; bash f`, `f() { echo '…'; }; f | bash` — or its own element
 * holds the shell for a later one to feed ({@link HOLDS}): `f() { bash; };
 * echo '…' | f`, `exec > >(bash); echo '…'`, `coproc bash; echo '…' >&…`. The
 * whole command is then set aside, as before #1607, rather than mask a string
 * a shell will run. Only an interpreter counts: a `sudo` without `-s` or `-i`
 * runs its arguments as a program, whose word the rules read where it stands
 * ({@link sudoRunsShell}). A writer that names no redirection (`cp`, `sed -i`,
 * `curl -o`) is not followed; the hooks catch mistakes, not deliberate
 * obfuscation.
 */
function feedsAcross(command, text, fed, interpreted) {
  if (!interpreted.length) return false;
  if (interpreted.some(([a, b]) => PARAMETER.test(command.slice(a, b)))) return true;
  if (interpreted.some(([a, b]) => HOLDS.test(text.slice(a, b)))) return true;
  let outside = "";
  let at = 0;
  for (const [a, b] of fed) {
    outside += text.slice(at, a) + " ".repeat(b - a);
    at = b;
  }
  return STORES.test(outside + text.slice(at));
}

/**
 * The text the rules read: `{ text, flat, trusted, sure, fed, programs,
 * unreadable }`. The mask is set aside — `text` and `flat` are the raw
 * command there, the pre-#1321 behaviour, which over-matches — over the whole
 * command when the lexer is not sure of it, and otherwise over each span
 * where live text feeds a string or stdin to a shell (`fed`, {@link
 * fedSpans}, #1607): the top-level list element holding the word that feeds
 * it, with its pipes, groups, substitutions and heredoc bodies — or the whole
 * command, when that shell may run text another element stores ({@link
 * feedsAcross}). Everywhere else the mask stands, so a quoted `gh pr merge` in
 * a `sed` or `grep` pattern is not read as a merge because a shell runs
 * elsewhere in the chain. `trusted` says the
 * whole command is masked, {@link trustedIn} says it of a range. The pre-hook
 * is a safety gate, so a doubt costs a false deny on a mention, never a
 * missed command.
 *
 * Either way each PROGRAM WORD — the word at command position, {@link
 * normalisePrograms} — is rewritten to its plain name at the same length
 * (#1606), so `gh.exe`, `/usr/bin/gh`, `"gh"`, `g"h"` and `GH.EXE` all read as
 * the `gh` every rule names, and the index of every other character is
 * unchanged. That runs before the shell-feed test, so a quoted `"bash" -c`
 * feeds a shell as a bare `bash -c` does. `programs` lists the
 * `[start, end)` spans it rewrote or found plain ({@link programStart}), and
 * `unreadable` the program words it could not read ({@link unreadablePrograms}).
 */
export function view(command) {
  if (command !== view.last) {
    const { masked, flat, top, sure, words: wordEnds, heredocs } = maskInert(command);
    // The view for a set of fed-start positions ({@link fedStarts}): the masked
    // text with its program words rewritten, the spans where a shell is fed read
    // off THAT text — so a shell word that only a wrapper makes a program, and is
    // written quoted (`nice "bash" -c "…"`), feeds its string once the round
    // that read `nice` has rewritten it (#1634 second read) — and the text with
    // those spans raw, rewritten again; a word the lexer did not see start is
    // read raw only inside a span.
    const build = (starts) => {
      const lexed = normalisePrograms(command, masked, flat, wordEnds, () => false, starts);
      const fed = sure ? fedSpans(command, lexed.text, top, heredocs) : [[0, command.length]];
      if (!fed.length) return { fed, out: lexed };
      const restore = (s) => {
        let at = 0;
        let r = "";
        for (const [a, b] of fed) {
          r += s.slice(at, a) + command.slice(a, b);
          at = b;
        }
        return r + s.slice(at);
      };
      const raw = (p) => fed.some(([a, b]) => a <= p && p < b);
      return { fed, out: normalisePrograms(command, restore(masked), restore(flat), wordEnds, raw, starts) };
    };
    // The first word of each string a shell runs, and the word a wrapper runs,
    // are program words too (#1634, {@link fedStarts}). Each round can reveal
    // one more level of nesting (`sudo nice sh -c "…"`: the shell is a program
    // only once `nice` is), so it repeats until the positions stop changing —
    // each time from the masked text, since a rewritten word's pad hides its
    // start from the next pass — to a depth no command typed by hand reaches.
    // Past that depth the words still unread are listed as programs the hook
    // cannot read, which `checkBash` judges as each guarded one: a doubt denies.
    let starts = new Map();
    let built = build(starts);
    let found = fedStarts(command, built.out.text, built.fed, built.out.programs);
    let settled = false;
    const same = (a, b) => a.size === b.size && [...a.keys()].every((k) => b.has(k));
    for (let round = 0; round < 8 && !(settled = same(found.starts, starts)); round++) {
      starts = found.starts;
      built = build(starts);
      found = fedStarts(command, built.out.text, built.fed, built.out.programs);
    }
    const { fed, out } = built;
    const byName = programsByName(out.text, out.programs);
    const unreadable = [...out.unreadable];
    if (!settled)
      for (const p of found.starts.keys()) {
        CRUDE_WORD.lastIndex = p;
        const w = CRUDE_WORD.exec(command);
        if (w && !byName.has(p) && !out.programs.some(([a]) => a === p))
          unreadable.push({ start: p, end: p + w[0].length, word: w[0] });
      }
    view.last = command;
    view.out = {
      text: out.text,
      flat: out.flat,
      trusted: fed.length === 0,
      sure,
      fed,
      programs: out.programs,
      unreadable,
      byName,
      wordStarts: wordStartsOf(out.programs, command.length),
      starts,
      quotes: found.quotes,
      quoteKinds: found.quoteKinds,
    };
  }
  return view.out;
}

/**
 * Whether the mask stands over `[a, b)` of `command` ({@link view}): the lexer
 * is sure of it and no fed span overlaps the range (#1607). A consumer that
 * reads one command's words reads them through the mask only then, and raw
 * otherwise, as the whole command was read before #1607.
 */
export function trustedIn(command, a, b) {
  const { sure, fed } = view(command);
  return sure && !fed.some(([s, e]) => s < b && a < e);
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

/**
 * Whether the word after `lead` (a {@link COMMAND_LEAD} match) is one of env's
 * own arguments or its program: env is the last wrapper the lead steps over.
 * The lead is read token by token as {@link COMMAND_LEAD} reads it, so an
 * option's value spelled as a wrapper (`env -u time …`) is the value it is,
 * never a wrapper (#1606 second read); assignments and redirections keep the
 * wrapper before them, a keyword ends it.
 */
function afterEnv(lead) {
  const step = new RegExp(String.raw`\s*${leadToken("(")}`, "y");
  let wrapper;
  for (let m; step.lastIndex < lead.length && (m = step.exec(lead));) {
    if (m[1] ?? m[2] ?? m[3]) wrapper = m[1] ?? m[2] ?? m[3];
    else if (/^\s*(?:if|then|do|else|elif|while|until|!|\{)\s/.test(m[0])) wrapper = undefined;
    if (!m[0]) break;
  }
  return wrapper === "env";
}
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
 * Whether a word read in the raw text of a view — where the mask is set aside,
 * over the whole command or a fed span ({@link view}) — may be rewritten
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
 * that feeds a string to a shell still sets the mask aside (#1606 review).
 *
 * It repeats until nothing changes, so a wrapper spelled with a path
 * (`/usr/bin/env /usr/bin/gh …`) puts the next word at command position too.
 * A word bash takes for an assignment ({@link ASSIGNMENT}), and a `$word`
 * followed by `=` (a PowerShell one), is never a program; nor is a word
 * starting with `-`, an option the lead could not step over because it is
 * quoted, which is written back as the option it is, its case kept. After
 * env, any `NAME=VALUE`, quoted or not, is an assignment env makes, written
 * back as `NAME=___`, and an argument that expands is listed in `unreadable`
 * with `env` set, since it may be either (#1606 review). `words` are the
 * lexer's word spans, the only words taken where `raw(position)` is false; in
 * the raw text of a span the mask is set aside over ({@link view}: the whole
 * command, or a fed span, #1607), a position the lexer did not see start a
 * word is read by {@link CRUDE_WORD}, and only a {@link selfContained} word is
 * rewritten. A program word whose last segment expands or globs is
 * left as it is and listed in `unreadable` as `{ start, end, word }`.
 */
function normalisePrograms(command, text, flat, words, raw, extra = new Map()) {
  let t = text;
  let f = flat;
  // `[start, end, cut, keep, kind]` each: the word, where its last segment
  // starts, the command substitutions of its directory part, kept live, and
  // how it is the program when `extra` put it there (#1634, {@link fedStarts}).
  const programs = [];
  const unreadable = [];
  const seen = new Set();
  // Inside a program word read already, and not inside a substitution it kept:
  // the rewritten text is blank or the name there, so the lead may stop in it.
  // Kept as a span array, so a chain of n commands asks n times, not n² (#1634 review).
  const inside = new Uint8Array(command.length);
  const covered = (p) => inside[p] === 1;
  for (let changed = true, passes = 0; changed && passes < 32; passes++) {
    // Every rewrite of the pass, `[start, end, text, flat]`, applied in one
    // splice at its end: a string rebuilt per word made a chain of n words n²
    // (#1634 review). Words never overlap (`seen`, `covered`), so the order of
    // application is free, and a comparison reads the text as it stood.
    const edits = [];
    // The first word of each fed string after the anchored positions, so a
    // whole quoted word (`sudo "gh" …`) is read before the word inside its quotes.
    const positions = [...programPositions(t), ...[...extra].map(([start, kind]) => ({ start, lead: "", kind }))];
    for (const { start, lead, kind } of positions) {
      if (seen.has(start) || covered(start)) continue;
      let end = words.get(start);
      if (end === undefined && raw(start) && (kind || start === 0 || /[\s|;&()\x60]/.test(command[start - 1]))) {
        CRUDE_WORD.lastIndex = start;
        const w = CRUDE_WORD.exec(command);
        if (w) end = start + w[0].length;
      }
      if (end === undefined || end <= start) continue;
      seen.add(start);
      const word = command.slice(start, end);
      // Where the mask is set aside the rules read the raw text as it stands,
      // separators inside strings included: a word there is rewritten only when
      // it is whole on its own, so no rewrite hides a command (#1606 second read).
      if (raw(start) && !selfContained(word)) continue;
      const chars = decodeWord(word);
      const live = chars.some((x) => x.live);
      const decoded = chars.map((x) => x.c).join("");
      const env = afterEnv(lead);
      const write = (by, inFlat = by) => edits.push([start, end, by, inFlat]);
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
      programs.push([start, end, cut, keep, kind]);
      for (let p = start + 1; p < end; p++) if (!keep.some(([k0, k1]) => k0 < p && p < k1)) inside[p] = 1;
      // The directory part blank but for its command substitutions, which run
      // and are read where they stand (#1606 review); the name right-aligned
      // in the last segment, so `$( … )/gh` reads `$( … )  gh`, at command
      // position after the `)` as after any other.
      const rewrite = (s) => {
        let out = "";
        for (let i = start; i < cut; i++) out += keep.some(([k0, k1]) => k0 <= i && i < k1) ? s[i] : " ";
        return out + read.name.padStart(end - cut);
      };
      const by = rewrite(t);
      if (by !== t.slice(start, end)) write(by, rewrite(f));
    }
    changed = edits.length > 0;
    if (changed) {
      // A word inside a command substitution that is another word's directory
      // part (`$(GIT.EXE push x)/gh.exe`) nests in that word's edit, whose
      // replacement keeps the substitution's characters where they stand: the
      // inner edit is written into the outer's replacement at its offset.
      const merged = [];
      for (const e of edits.sort((x, y) => x[0] - y[0])) {
        const outer = merged.findLast((m) => m[0] <= e[0] && e[1] <= m[1]);
        if (!outer) merged.push(e);
        else
          for (const k of [2, 3])
            outer[k] = outer[k].slice(0, e[0] - outer[0]) + e[k] + outer[k].slice(e[1] - outer[0]);
      }
      const splice = (s, k) => {
        let out = "";
        let at = 0;
        for (const e of merged) {
          out += s.slice(at, e[0]) + e[k];
          at = e[1];
        }
        return out + s.slice(at);
      };
      t = splice(t, 2);
      f = splice(f, 3);
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
  return wordStartOf(view(command), index);
}

/** {@link programStart} over a view: a lookup in its `wordStarts`, so a chain of n commands costs n reads, not n². */
function wordStartOf(v, index) {
  const start = v.wordStarts[index];
  return start === undefined || start < 0 ? index : start;
}

/**
 * For each index of a command, where the innermost program word holding it
 * starts, or -1 ({@link wordStartOf}): the words in order of their start, each
 * written over its span, so a nested one (a substitution's own command) wins,
 * and a command substitution a word's directory part keeps left out, since a
 * command inside it is its own.
 */
function wordStartsOf(programs, length) {
  const starts = new Int32Array(length).fill(-1);
  for (const [a, b, , keep] of [...programs].sort((x, y) => x[0] - y[0]))
    for (let i = a; i < b; i++) if (!keep.some(([k0, k1]) => k0 <= i && i < k1)) starts[i] = a;
  return starts;
}

/** The program words at command position that expand or glob, `{ start, end, word }` each ({@link view}). */
export const unreadablePrograms = (command) => view(command).unreadable;

/** The command with its inert text masked where the mask stands, and raw where it is set aside ({@link view}). */
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
 * Each result is the array of raw groups, with `index` set, in the order the
 * command runs them.
 *
 * For a {@link cmd} regex the matches are the anchored ones — a command after
 * a boundary and a {@link COMMAND_LEAD}, `index` at the boundary — and, since
 * #1634, the rule's own shape (`re.inner`) wherever a program word is one some
 * other way ({@link programKind}): the first word a fed shell or a `sudo`
 * runs, the word a wrapper runs, `index` at the word. Each carries `program`
 * (where the program word's name starts, never a separator), `how` and, for a
 * carried one, `via` (`"bash"`, `"sudo"`, …), `stdin` and `piped`, so a rule
 * can say which shape it refused. A match that is both is one match. A match
 * whose program sits inside a string a shell is handed reads no further than
 * the string's close ({@link found}): `bash -c 'git worktree add ../ir-5'`
 * names `../ir-5`, not `../ir-5'`, and `echo 'pnpm test' | bash` holds no
 * piped `pnpm test`.
 */
export function* matchesAt(command, re) {
  const all = [...found(command, re, 0, trustedMask(command).length)].sort((x, y) => x.program - y.program);
  for (const f of all) yield rawMatch(command, f);
}

/** The flags of `re` with `extra` added, each once. */
const withFlags = (re, extra) => [...new Set([...re.flags, ...extra])].join("");

/**
 * Every command `re` finds in `text[a, b)` of {@link view}'s text, unsorted,
 * as `{ at, end, indices, kind, program }` with indices into the whole text
 * (#1634 review). First the anchored matches, as the anchored regex finds
 * them over the slice (so `^` and `$` hold at its ends, as the per-segment
 * callers have always had it), each confined to the string its program sits
 * in ({@link matchWithin}); then, for a {@link cmd} regex, the rule's own
 * shape tested sticky at every known program position in the slice ({@link
 * knownPrograms}) the anchored matches did not take, confined the same way.
 * Tested where a program is, never scanned for: a scan's leftmost match at a
 * mention consumed the real occurrence after it (`sudo env X=gh gh pr comment
 * 5 --body @-`). Lazy, so {@link has} stops at the first.
 */
function* found(command, re, a, b) {
  const text = trustedMask(command);
  const slice = text.slice(a, b);
  const v = view(command);
  const closeIn = (p) => {
    const close = stringAround(v, a + p)?.[1];
    return close === undefined ? undefined : close - a;
  };
  const record = (m, kind, program) => ({
    at: a + m.index,
    end: a + m.index + m[0].length,
    indices: m.indices.map((r) => r && [a + r[0], a + r[1]]),
    kind,
    program: a + program,
  });
  const taken = new Set();
  const anchored = new RegExp(re.source, withFlags(re, "yd"));
  for (let m of slice.matchAll(new RegExp(re.source, withFlags(re, "gd")))) {
    const program = innerStart(slice, m, re);
    const close = closeIn(program);
    if (close !== undefined && m.index + m[0].length > close && !(m = matchWithin(anchored, slice, m.index, close)))
      continue;
    taken.add(program);
    yield record(m, COMMAND, program);
  }
  if (!re.inner) return;
  const inner = new RegExp(re.inner.source, withFlags(re, "yd"));
  for (const [p, kind] of knownPrograms(v)) {
    if (p < a || p >= b || taken.has(p - a)) continue;
    const m = matchWithin(inner, slice, p - a, closeIn(p - a));
    if (m) yield record(m, kind, p - a);
  }
}

/**
 * The program positions of a view ({@link programKind}): every program word
 * by where its name starts, with how it is the program, then every position
 * {@link fedStarts} recorded whose word is no program word.
 */
function* knownPrograms({ byName, starts }) {
  yield* byName;
  for (const entry of starts) if (!byName.has(entry[0])) yield entry;
}

/**
 * The match of the sticky `re` at `p` in `text`, confined to the string
 * holding `p` when `close` names its closing quote (#1634 review): a command
 * inside a string a shell runs reads no further than that close, so the pipe
 * after `echo 'pnpm test' | bash` is not the string's, and the `(.*)$` of a
 * worktree add inside `bash -c '…' && echo` ends at the quote. `null` when
 * nothing matches at `p`.
 */
function matchWithin(re, text, p, close) {
  re.lastIndex = p;
  const m = re.exec(text);
  if (!m || close === undefined || m.index + m[0].length <= close) return m;
  re.lastIndex = p;
  return re.exec(text.slice(0, close));
}

/**
 * Where the rule's own shape starts inside an anchored {@link cmd} match: past
 * the boundary and the lead it took, found with the flags the match was made
 * with — the `m` of {@link cmd} included, so a `$`-ending shape before a
 * newline is found too (#1634 review). Never a separator: were the shape not
 * found, the match's first character that is none.
 */
function innerStart(text, m, re) {
  if (!re.inner) return m.index;
  const end = m.index + m[0].length;
  const sticky = new RegExp(re.inner.source, withFlags(re, "y"));
  for (let p = m.index; p < end; p++) {
    sticky.lastIndex = p;
    const r = sticky.exec(text);
    if (r && p + r[0].length === end) return p;
  }
  return m.index + /^[\s|;()\x60&]*/.exec(m[0])[0].length;
}

/** A {@link matchesAt} result: the groups read from the raw command, with the match's facts. */
function rawMatch(command, { at, indices, kind, program }) {
  const raw = indices.map((r) => r && command.slice(r[0], r[1]));
  raw.index = at;
  raw.program = program;
  raw.how = kind.how;
  if (kind.via) raw.via = kind.via;
  if (kind.stdin) raw.stdin = true;
  if (kind.piped) raw.piped = true;
  if (kind.attached) raw.attached = true;
  return raw;
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
  // The first command the rule finds ({@link matchesAt}: at command position,
  // or the first word a shell or a wrapper runs, #1634), and its segment.
  const m = re ? matchAt(command, re) : null;
  const at = m ? segs.findIndex(([a, b]) => a <= m.program && m.program < b) : -1;
  const base = cwdAt(command, cwd, at >= 0 ? segs[at][0] : command.length, shell);
  const [a, b] = at >= 0 ? segs[at] : [0, command.length];
  return gitPlaceAt(command, m ? m.program : a, base, shell, b);
}

/**
 * The session cwd moved by every `cd <dir>` in the chain segments that end
 * before `index` ({@link gitCwd}'s walk, split and read as it is): where the
 * command starting at `index` runs. The post-hook reads a merge's PR back
 * there, at the merge `firstMerge` found rather than the first mention (#1607).
 */
export function cwdAt(command, cwd, index, shell = BASH) {
  const text = trustedMask(command);
  let base = cwd;
  for (const [a, b] of ranges(text, CHAIN)) {
    if (b > index) break;
    const dir = argIn(command, text, a, b, cdRe(shell));
    if (dir && !HISTORY_DIR.has(dir)) base = resolveDir(base, dir, { shell });
  }
  return base;
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
/** The variables git reads for where it acts: its repository, work tree or index, or config that may set `core.worktree`. */
const GIT_ENV_NAME = String.raw`GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|CONFIG_PARAMETERS|CONFIG_KEY_\d+)`;
/**
 * One of {@link GIT_ENV_NAME} assigned or exported, with `=` or `+=`, in bash
 * or as PowerShell's `$env:NAME` or `${env:NAME}`; the environment is
 * case-blind on Windows. The value starts where the match ends.
 */
const GIT_ENV = new RegExp(String.raw`(?<!\w)${GIT_ENV_NAME}\}?\s*\+?=\s*`, "gi");
/** PowerShell's commands that write an `Env:` item or call .NET's `SetEnvironmentVariable` (#1606 second read). */
const PS_ENV_WRITE = /(?<![\w-])(?:set-item|si|new-item|ni|setenvironmentvariable)(?![\w-])/gi;
/** What each variable moves ({@link envMoves}); a `GIT_CONFIG_KEY_<n>` moves the tree when it names `core.worktree`. */
const GIT_ENV_MOVES = {
  DIR: "repo",
  COMMON_DIR: "repo",
  WORK_TREE: "tree",
  INDEX_FILE: "index",
  CONFIG_PARAMETERS: "tree",
};

/**
 * What the environment set in the live text before `upTo` moves for a git
 * command after it: a set of `repo`, `tree` and `index` (#1606). Read are a
 * bash assignment or export, PowerShell's `$env:` and `${env:}`, `Set-Item`,
 * `New-Item` (and `si`, `ni`) on an `Env:` item and `SetEnvironmentVariable`.
 * Config given through the environment counts when it may set
 * `core.worktree`: any `GIT_CONFIG_PARAMETERS`, and a `GIT_CONFIG_KEY_<n>`
 * whose value names it or cannot be read; through a PowerShell write, whose
 * value is not read, any config key counts. On doubt it moves: a commit then
 * refuses, which costs a re-spelling.
 */
/** An ANSI-C `$'…'` run, where `\'` does not close it (CodeRabbit on PR #1628). */
const ANSI_C = String.raw`\$'(?:[^'\\]|\\[\s\S])*'`;
/** A quoted run inside a command substitution, where a `(` or `)` is text, not structure. */
const SUBST_QUOTED = String.raw`${ANSI_C}|'[^']*'|"(?:[^"\\]|\\[\s\S])*"`;
/**
 * One character of a substitution's body, an escape or a quoted run: each
 * starts differently, so it has one parse. The escape comes first, so `\$'`
 * is a literal dollar and not an ANSI-C opener (CodeRabbit on PR #1628).
 */
const SUBST_ATOM = String.raw`\\[\s\S]|[^()'"$\\]|\$(?!')|${SUBST_QUOTED}`;
/**
 * A command substitution, `$( … )` (two levels of nesting) or a backtick one,
 * taken whole: its words are one word of the command that holds it. A quoted
 * `)` inside it is text (CodeRabbit on PR #1628: the raw view of
 * `$(bash -c 'a ) b')` once ended there). A character class never matches its
 * `$(` or backtick, so each has one parse.
 */
const SUBSTITUTION = String.raw`\$\((?:${SUBST_ATOM}|\((?:${SUBST_ATOM}|\((?:${SUBST_ATOM})*\))*\))*\)|\x60[^\x60]*\x60`;

/** One shell word at the start of `s`, quotes, escapes and substitutions kept, for {@link decodeWord}. */
const LEADING_WORD = new RegExp(
  String.raw`^(?:"(?:[^"\\]|\\[\s\S])*"|${ANSI_C}|'[^']*'|\\[\s\S]|${SUBSTITUTION}|\$(?![('])|[^\s;&|()<>"'\\$\x60])*`,
);

/**
 * Whether a config key, written as raw shell text at the start of `raw`,
 * may be `core.worktree` (#1606, CodeRabbit on PR #1628). It is decoded as
 * bash reads it, so `c'ore.worktree'` and `core\.worktree` are that key, and
 * one that expands may be. `stop` cuts the key at a plain `=` (`-c k=v`).
 */
function mayNameWorktree(raw, stop = false) {
  const chars = decodeWord(LEADING_WORD.exec(raw)[0]);
  const eq = stop ? chars.findIndex((x) => !x.live && x.c === "=") : -1;
  const key = eq < 0 ? chars : chars.slice(0, eq);
  if (key.some((x) => x.live)) return true;
  return /^core\.worktree$/i.test(key.map((x) => x.c).join(""));
}

function envMoves(command, text, upTo) {
  const moves = new Set();
  const add = (name, value) => {
    const key = name.toUpperCase();
    if (!key.startsWith("CONFIG_KEY_")) moves.add(GIT_ENV_MOVES[key]);
    else if (value === undefined || mayNameWorktree(value)) moves.add("tree");
  };
  const before = text.slice(0, upTo);
  for (const m of before.matchAll(GIT_ENV)) add(m[1], command.slice(m.index + m[0].length, upTo));
  for (const m of before.matchAll(PS_ENV_WRITE)) {
    const stop = before.slice(m.index).search(/[;|&\n]/);
    const args = command.slice(m.index, stop < 0 ? upTo : m.index + stop);
    for (const a of args.matchAll(new RegExp(String.raw`(?<!\w)${GIT_ENV_NAME}(?!\w)`, "gi"))) add(a[1]);
  }
  return moves;
}

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
  const env = envMoves(command, text, word.index);
  return {
    dir,
    movesRepo: options.gitDir !== undefined || options.dirUnknown || env.has("repo"),
    movesTree: options.workTree !== undefined || options.config.includes("core.worktree") || env.has("tree"),
    movesIndex: env.has("index"),
  };
}

/**
 * The global options of the git command whose program word ends at `from`
 * (`GIT_GLOBALS`, #1606), read in the rewritten text and their values from
 * the raw text at the same indices, unquoted: `{ dirs, gitDir, workTree,
 * config }`, every `-C` in order, the last `--git-dir` and `--work-tree`, and
 * the keys `-c` and `--config-env` set, lower-cased. A value that expands is
 * kept as written, quotes stripped, as the hook has always read one.
 * `dirUnknown` is set when a `-C` expands (`"$TARGET"`, `~/x`): it names a
 * directory the hook cannot resolve, where its git reads fail open, so the
 * repository counts as unknown (CodeRabbit on PR #1628).
 */
export function gitGlobals(command, from) {
  const text = trustedMask(command);
  const option = new RegExp(String.raw`\s+${GIT_OPTION}`, "yd");
  const out = { dirs: [], gitDir: undefined, workTree: undefined, config: [], dirUnknown: false };
  option.lastIndex = from;
  for (let m; (m = option.exec(text));) {
    const name = m[1] ?? m[3];
    const at = m.indices[2] ?? m.indices[4];
    if (!name || !at) continue;
    const raw = command.slice(at[0], at[1]);
    const chars = decodeWord(raw);
    const value = chars.some((x) => x.live) ? raw.replace(/["']/g, "") : chars.map((x) => x.c).join("");
    if (name === "-C") {
      out.dirs.push(value);
      if (chars.some((x) => x.live) || value.startsWith("~")) out.dirUnknown = true;
    } else if (name === "--git-dir") out.gitDir = value;
    else if (name === "--work-tree") out.workTree = value;
    // A key that expands may be core.worktree: on doubt it moves (CodeRabbit on PR #1628).
    else if (name === "-c" || name === "--config-env")
      out.config.push(mayNameWorktree(raw, true) ? "core.worktree" : value.split("=")[0].toLowerCase());
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
 *
 * As {@link matchesAt} does, a {@link cmd} regex also finds the command where
 * its program word is the first word a fed shell or a wrapper runs (#1634),
 * with `how`, `via` and `stdin` saying so, and a command inside a string a
 * shell is handed ends at that string's close ({@link stringEnd}): the `args`
 * of `bash -c 'git push origin x'` are ` origin x`, not ` origin x'`.
 */
export function* chainCommands(command, cwd, re, shell = BASH) {
  const text = trustedMask(command);
  const v = view(command);
  let base = cwd;
  for (const [a, b] of ranges(text, CHAIN)) {
    for (const f of [...found(command, re, a, b)].sort((x, y) => x.program - y.program)) {
      const start = programStart(command, f.at);
      const from = f.end;
      const stop = text.slice(from, b).search(COMMAND_END);
      let to = stop >= 0 ? from + stop : b;
      let cut = stop >= 0 ? text[to] : undefined;
      const close = stringAround(v, from)?.[1];
      if (close !== undefined && close < to) {
        to = close;
        cut = undefined;
      }
      yield {
        base,
        start,
        head: command.slice(start, from),
        args: command.slice(from, to),
        at: from,
        cut,
        how: f.kind.how,
        ...(f.kind.via ? { via: f.kind.via } : {}),
        ...(f.kind.stdin ? { stdin: true } : {}),
        ...(f.kind.piped ? { piped: true } : {}),
        ...(f.kind.attached ? { attached: true } : {}),
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

/**
 * An anchored rule ({@link cmd}) finds its command as {@link matchesAt} does —
 * at command position, or as the first word a fed shell or a wrapper runs
 * (#1634) — and stops at the first, with no sort and no groups read; an
 * unanchored one, which must fire on any occurrence, tests the raw text.
 */
export function has(command, re) {
  if (!re.anchored) return re.test(command);
  for (const f of found(command, re, 0, trustedMask(command).length)) return Boolean(f);
  return false;
}

/**
 * One token of {@link COMMAND_LEAD}: a keyword, a wrapper with its options, an
 * assignment or a redirection. `open` opens the group around each wrapper's
 * name: `(?:` for the lead itself, `(` where {@link afterEnv} reads which
 * wrapper a token is — group 1 for `time`, `command`, `exec`, `env` or
 * `nohup`, 2 for `timeout`, 3 for `xargs`.
 */
function leadToken(open) {
  return String.raw`(?:(?:if|then|do|else|elif|while|until|!|\{)\s+|${open}time|command|exec|env|nohup)(?:\s+(?:-[uCSa]|--unset|--chdir|--split-string)\s+[^\s-]\S*|\s+-\S+)*\s+|${open}timeout)(?:\s+(?:-[ks]|--kill-after|--signal)\s+[^\s-]\S*|\s+-\S+)*\s+\d[\d.]*[smhd]?\s+|${open}xargs)(?:\s+-[IdEeLnPs]\s+[^\s-]\S*|\s+-\S+)*\s+|[A-Za-z_]\w*(?:\[[^\]\s]*\])?\+?=\S*\s+|\d*(?:<<<|[<>]&|&>>?|>>|>\||<>|<|>)\s*[^\s;&|()<>]+\s+)`;
}

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
 * the rules read the raw text of the list element that hands it over then
 * ({@link view}, #1607), and its first word, past a lead of these tokens, is a
 * program word ({@link fedStarts}, #1634).
 */
export const COMMAND_LEAD = String.raw`(?:${leadToken("(?:")})*`;

/**
 * One character run of a git option's value: a quoted run (`"___"` in the
 * masked text), an escape or a command substitution stays whole, so
 * `git -c x=$(echo a b) commit` is still a commit (#1606, CodeRabbit on PR #1628).
 */
const GIT_VALUE_PART = String.raw`(?:"[^"]*"|${ANSI_C}|'[^']*'|\\[\s\S]|${SUBSTITUTION}|\$(?![('])|[^\s\\"'$\x60])`;
/** A git option's value in the next word, which never starts with `-` (the {@link COMMAND_LEAD} rule: one parse per token). */
const GIT_VALUE = String.raw`(?:"[^"]*"|${ANSI_C}|'[^']*'|\\[\s\S]|${SUBSTITUTION}|\$(?![('])|[^\s\\"'$\x60-])${GIT_VALUE_PART}*`;
/** git's global options that take a value in the next word. */
const GIT_VALUE_OPTIONS = String.raw`-C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix|--attr-source`;
/** git's global options that take a value after `=`. */
const GIT_EQ_OPTIONS = String.raw`--git-dir|--work-tree|--namespace|--config-env|--super-prefix|--attr-source|--exec-path|--list-cmds`;
/** git's global options that take no value. */
const GIT_FLAGS = String.raw`--no-pager|-p|--paginate|-P|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-advice|--no-lazy-fetch|--exec-path`;
/**
 * One global option. With `open` set to `(` its name is in group 1 or 3 and
 * its value in group 2 or 4 ({@link gitGlobals}); with `(?:` it captures
 * nothing ({@link GIT_GLOBALS}). Built both ways rather than rewritten,
 * since the value's own pattern holds escaped parentheses and classes.
 */
const gitOption = (open) =>
  String.raw`(?:${open}${GIT_VALUE_OPTIONS})\s+${open}${GIT_VALUE})|${open}${GIT_EQ_OPTIONS})=${open}${GIT_VALUE_PART}*)|(?:${GIT_FLAGS})(?=\s))`;
const GIT_OPTION = gitOption("(");

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
export const GIT_GLOBALS = String.raw`(?:\s+${gitOption("(?:")})*\s+`;

/** A `&` that ends a command, as a separator or a background: not a redirect's own, as in `2>&1`, `<&0` or `&>log`. */
const BOUNDARY_AMP = String.raw`(?<![<>])&(?!>)`;

/**
 * Anchors a command regex to COMMAND POSITION: the start of the string or of
 * a line (after any indent), or right after `|`, `;`, `&`, `(`, `)` or a
 * backtick, with any leading {@link COMMAND_LEAD}. Without this, a grep, an
 * echo or a docs edit that merely MENTIONS a trapped shape
 * (`grep 'pnpm exec vitest'`) would be denied. The anchor adds no capture
 * group, so the rule's own groups keep their numbers. The rule's own shape is
 * kept as `inner`: {@link matchesAt}, {@link has} and {@link chainCommands}
 * also find it where its program word is the first word a fed shell or a
 * wrapper runs (#1634), which no anchor reaches.
 */
export function cmd(re) {
  const flags = new Set([...re.flags, "m"]);
  const anchored = new RegExp(
    String.raw`(?:^[ \t]*|(?:[|;()\x60]|${BOUNDARY_AMP})\s*)${COMMAND_LEAD}(?:${re.source})`,
    [...flags].join(""),
  );
  // Read by `has`: an anchored regex is tested on the trusted-masked text.
  anchored.anchored = true;
  anchored.inner = re;
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
 * mask is set aside over the element where a shell is fed a string ({@link
 * view}, #1607), so that element is split in the raw text, inside the string
 * too.
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
