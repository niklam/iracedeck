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
 * {@link fedStarts}), one level deep. A form that hands text to a shell the
 * lexer does not read — a printer or any command piped into a shell, a
 * here-string or heredoc a shell runs, `eval`, a `sudo` that runs a shell, a
 * string that is not one plain level, a string inside a string, a program
 * word in a string that is not its plain name — is listed by {@link
 * refusedForms}, and `checkBash` refuses it before any rule (#1659, the
 * stopping rule). On top of it, {@link cmd} anchors a regex to command
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
/**
 * A command substitution as a {@link COMMAND_LEAD} token's value holds one,
 * one level of nesting deep: the lead sits in every {@link cmd} rule, so its
 * size is paid on every command each rule reads (#1646). The regex is only
 * the anchors' fast path: a value it cannot read (a deeper substitution, a
 * quote nested in one inside `"…"`) ends its token, and the program after it
 * is still found, since every program position comes from {@link leadStep},
 * which reads values with the one word reader ({@link pieceEnd}), and every
 * rule tests its shape there ({@link matchesAt}).
 */
const LEAD_ATOM = String.raw`[^()'"\\]|\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*"`;
const LEAD_SUBSTITUTION = String.raw`\$\((?:${LEAD_ATOM}|\((?:${LEAD_ATOM})*\))*\)|\x60[^\x60]*\x60`;

/**
 * One piece of a word as the {@link COMMAND_LEAD} regex reads it, for a
 * token's value (#1646; {@link leadStep} reads every value whole, with {@link
 * pieceEnd}): a double-quoted run with its escapes, a single-quoted run, an
 * ANSI-C `$'…'` run, a command substitution, a `${…}` expansion, any other
 * `$`, an escape, or one plain character. A blank never is one, nor an
 * operator that ends the word (`;`, `&`, `|`, a paren, a backtick), so a
 * quoted value keeps its blanks and `;` (`X="a b;c" gh …`) and an expansion
 * its own words (`X=${Y:-a b} gh …`), where `=\S*` once ended the value at the
 * first blank. Each piece starts on a character no other piece starts on, so
 * a run of them has one parse, and the plain run is tried first: almost every
 * character of a value is plain, and every cmd() rule runs this at each
 * command position. With `angles` a `<` or `>` is plain, as in an
 * assignment's value (`X=a>b`); a redirection's target and an option's value
 * stop at one.
 */
const piece = (angles) =>
  String.raw`(?:[^\s"'\\$\x60;&|()${angles ? "" : "<>"}]|"(?:[^"\\]|\\[\s\S])*"|'[^']*'|${ANSI_C}|${LEAD_SUBSTITUTION}|\$\{[^}]*\}|\$(?![('{])|\\[\s\S])`;
const WORD_PIECE = piece(false);
const ANGLED_PIECE = piece(true);

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
const SH_OPTIONS = { value: "oO", long: ["--rcfile", "--init-file"], string: "c", positional: "s", plus: true };
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
    const glued = attached === undefined ? {} : { attached: w.length - attached.length };
    if (p === "e" || p === "ec" || spells(p, "encodedcommand", 2)) return { stop: true, encoded: true, ...glued };
    if (spells(p, "file", 1)) return { stop: true, file: true };
    // `-WorkingDirectory` (`-wd`) moves where the string runs: a value option the deck-host ask resolves.
    const dir = p === "wd" || spells(p, "workingdirectory", 2);
    return {
      value: attached === undefined && (dir || PS_VALUE_PARAMS.some(([full, min]) => spells(p, full, min))),
      dir,
      ...glued,
    };
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
 * The option spec of the shell word or wrapper `name` ({@link OPTION_SPECS}),
 * by its plain name — a path and a Windows extension stripped, any case — or
 * {@link NO_OPTIONS} for a word that takes none (`eval`, `trap`, `winpty`).
 * What `wrapperRuns` in `script-runs.mjs` reads a shell's words with (#1634).
 */
export const shellSpec = (name) =>
  OPTION_SPECS.get(
    String(name)
      .toLowerCase()
      .replace(/^.*[\\/]/, "")
      .replace(/\.exe$/, ""),
  ) ?? NO_OPTIONS;

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
    let positional = false;
    for (let k = 1; k < w.length; k++) {
      // getopt takes the rest of the word as the option's argument (`su -c'…'`,
      // `fish -c'…'`); bash reads `-cx` as the flags `c` and `x`.
      if (spec.string && w[k] === spec.string && spec.attachedString && k < w.length - 1)
        return { string: true, attached: k + 1 };
      if (spec.string && w[k] === spec.string) string = true;
      else if (spec.positional && w[k] === spec.positional) positional = true;
      else if (spec.value.includes(w[k])) return { string, positional, value: k === w.length - 1 };
    }
    return { string, positional };
  }
  return w.startsWith("-") ? {} : null;
}

/**
 * One word of a command from where it is tried, sticky, past blanks: quotes and
 * escapes kept whole, ending at an operator character ({@link commandOf}) — a
 * redirect's own `&` (`<&3`, `2>&1`, `&>log`) is part of its word, not a
 * background job's.
 */
const COMMAND_WORD = /[ \t]*((?:"(?:[^"\\]|\\[\s\S])*"|'[^']*'|\\[\s\S]|[<>]&|&>|[^\s"'\\;&|()\x60])+)/y;
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
/**
 * The words a shell word or a wrapper runs, read as it reads them ({@link
 * readCommand}): `next` hands over one word at a time, quotes and escapes
 * kept, and nothing more is read than the walk needs. `program`, `string`,
 * `switch` and `dirs` are indices into the words handed over, `offset` the
 * character of the string word where an attached string starts (`cmd /c"…"`,
 * `su -c'…'`), `attached` whether it is one, `stop` the word after which
 * nothing can be read (pwsh's `-File`, `-EncodedCommand`), and `stdin` where
 * a shell with no string and no file would read its script: `"pipe"`, the
 * here-string word as `{ index, offset }`, `"heredoc"`, or `"other"` for a
 * file or descriptor — the last input redirection wins, an output redirection
 * changes nothing. A value option takes its value, a redirection its target, `--` ends
 * the options, a positional switch (bash's `-s`) makes the later plain words
 * arguments rather than a script file, and past the program the words are
 * still read for a string option, {@link SCANNED_WORDS} at most, so an option
 * the spec does not know costs at worst a false program, never a missed string.
 *
 * The one reader of a shell's options (#1634, CodeRabbit CLI round 4): the
 * lexer's {@link commandOf} and the deck-host ask's
 * `wrapperRuns` in `script-runs.mjs` all walk through it, so they cannot
 * disagree on which word is the string.
 */
export function readCommand(spec, next) {
  const out = {
    program: undefined,
    string: undefined,
    offset: 0,
    attached: false,
    switch: undefined,
    stdin: "pipe",
    dirs: [],
    stop: undefined,
  };
  const scansOn = Boolean(spec.string || spec.longString || spec.read);
  let options = true;
  let stringNext = false;
  let stringSwitch;
  let positional = false;
  let scanned = 0;
  let k = -1;
  const take = () => {
    const w = next();
    if (w !== undefined) k++;
    return w;
  };
  for (let w = take(); w !== undefined; w = take()) {
    const input = INPUT_REDIRECT.exec(w);
    if (input || REDIRECTION.test(w)) {
      const bare = input ? input[0].length === w.length : BARE_REDIRECTION.test(w);
      let target = { index: k, offset: input ? input[0].length : 0 };
      if (bare) {
        if (take() === undefined) break;
        target = { index: k, offset: 0 };
      }
      if (input) out.stdin = input[1] === "<<<" ? target : input[1].startsWith("<<") ? "heredoc" : "other";
      continue;
    }
    const o = options ? readOption(spec, w) : null;
    if (o?.stop) {
      out.stop = { index: k, ...o };
      break;
    }
    if (o?.end) {
      options = false;
      continue;
    }
    if (o) {
      if (o.positional) positional = true;
      if (o.dir)
        out.dirs.push(o.attached === undefined ? { index: k + 1, offset: 0 } : { index: k, offset: o.attached });
      if (o.string && o.attached !== undefined) {
        Object.assign(out, { string: k, offset: o.attached, attached: true, switch: k });
        break;
      }
      if (o.string) {
        stringNext = true;
        stringSwitch = k;
      }
      if (o.value && take() === undefined) break;
      continue;
    }
    if (stringNext) {
      Object.assign(out, { string: k, switch: stringSwitch });
      break;
    }
    if (!positional && out.program === undefined) out.program = k;
    if (!scansOn || ++scanned > SCANNED_WORDS) break;
  }
  return out;
}

/**
 * {@link readCommand} over the text of a command whose program word ends at
 * `from`, its words read up to `limit` ({@link COMMAND_WORD}): the same
 * result with text positions in place of word indices, and `stop` as a
 * boolean. Reading stops at a `;`, `&`, `|`, paren, backtick or newline, as
 * the command does.
 */
function commandOf(spec, text, from, limit) {
  COMMAND_WORD.lastIndex = from;
  const ats = [];
  const next = () => {
    const m = COMMAND_WORD.exec(text);
    if (!m || COMMAND_WORD.lastIndex > limit) return undefined;
    ats.push(COMMAND_WORD.lastIndex - m[1].length);
    return m[1];
  };
  const r = readCommand(spec, next);
  const at = (i, offset = 0) => (i === undefined ? undefined : ats[i] + offset);
  return {
    program: at(r.program),
    string: at(r.string, r.offset),
    attached: r.attached,
    stdin: typeof r.stdin === "object" ? at(r.stdin.index, r.stdin.offset) : r.stdin,
    stop: r.stop !== undefined,
    file: Boolean(r.stop?.file),
  };
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

/**
 * The shells that read their script from stdin when handed no string and no
 * script file ({@link fedStarts}): bash and its kin, fish, PowerShell (also
 * with `-Command -`) and cmd.exe. Such a shell fed a pipe, a here-string or a
 * heredoc is refused, never read (#1659).
 */
const STDIN_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd"]);

/**
 * Whether the `'` at `i` of `s` opens an ANSI-C `$'…'` string: a `$` before
 * it that no backslash escapes, as an even run of them before it leaves it
 * plain (#1646).
 */
export function ansiOpen(s, i) {
  if (s[i] !== "'" || s[i - 1] !== "$") return false;
  let slashes = 0;
  for (let k = i - 2; k >= 0 && s[k] === "\\"; k--) slashes++;
  return slashes % 2 === 0;
}

/**
 * The raw text of a fed span `[a, b)` read crudely, quotes kept whole
 * ({@link fedStarts}): `quotes`, each quoted string as `[open, close]`
 * (the indices of its quotes; an ANSI-C `$'…'` string's open is its `'`,
 * and a `\'` in it closes nothing), `pipelines`, each a list of its stages as
 * `[start, end)`, split at an unquoted `|` or `|&` and ended by `;`, `&&`,
 * `||`, a lone `&` or a newline, and `pipes`, the index of each such `|`.
 */
function pipelinesOf(command, a, b) {
  const quotes = [];
  const pipelines = [];
  const pipes = [];
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
      // `\` escapes in a double-quoted string and in an ANSI-C `$'…'` one, whose
      // `$` is no escaped one (`\$'x\'` is a `$` and a plain `'x\'`, #1646).
      const escapes = c === '"' || ansiOpen(command, i);
      let k = i + 1;
      while (k < b && command[k] !== c) k += escapes && command[k] === "\\" ? 2 : 1;
      quotes.push([i, k]);
      i = k;
    } else if ((c === "|" || c === "&") && command[i + 1] === c) {
      cut(i, i + 2, true);
      i++;
    } else if (c === "|") {
      pipes.push(i);
      cut(i, command[i + 1] === "&" ? i + 2 : i + 1, false);
    } else if (c === ";" || c === "\n" || (c === "&" && !/[<>|]/.test(command[i - 1] ?? "") && command[i + 1] !== ">"))
      cut(i, i + 1, true);
  }
  cut(b, b, true);
  return { quotes, pipelines, pipes };
}

/** A redirection that gives a command its stdin: `<`, `<<`, `<<<`, `<&`, `<>`, with an optional fd 0. Group 1 is the operator. */
const INPUT_REDIRECT = /^0?(<<<|<<-?|<&|<>|<)(?!\()/;

/**
 * Where the piece of a bash word that starts at `i` in `t` ends ({@link
 * readLevel}): past a quoted run (`"…"` with its escapes and its `$( … )`,
 * `${ … }` and backtick substitutions, quotes inside them included, `'…'`,
 * `$'…'`), an escape, a `$( … )`, `${ … }` or backtick substitution, or one
 * plain character; `-1` when a quote it opens never closes. The one reader
 * of where a word's piece ends: {@link wordEnd}, {@link leadStep} and {@link
 * level} all walk with it (#1646).
 */
function pieceEnd(t, i) {
  const c = t[i];
  if (c === "\\") return Math.min(i + 2, t.length);
  if (c === "'") {
    const e = t.indexOf("'", i + 1);
    return e < 0 ? -1 : e + 1;
  }
  if (c === "$" && t[i + 1] === "'") {
    for (let k = i + 2; k < t.length; k++)
      if (t[k] === "\\") k++;
      else if (t[k] === "'") return k + 1;
    return -1;
  }
  if (c === '"') {
    for (let k = i + 1; k < t.length; k++)
      if (t[k] === "\\") k++;
      else if (t[k] === '"') return k + 1;
      else if (t[k] === "$" && (t[k + 1] === "(" || t[k + 1] === "{")) k = closeAt(t, k + 2, t[k + 1]) - 1;
      else if (t[k] === "\x60") k = tickEnd(t, k) - 1;
    return -1;
  }
  if (c === "$" && (t[i + 1] === "(" || t[i + 1] === "{")) return closeAt(t, i + 2, t[i + 1]);
  if (c === "\x60") return tickEnd(t, i);
  return i + 1;
}

/** Whether the character at `i` of `t` ends a command: a newline, `;`, `|`, a paren, or a `&` that is no redirect's (`2>&1`, `&>`). */
function endsCommand(t, i) {
  const c = t[i];
  return "\n;|()".includes(c) || (c === "&" && !/[<>]/.test(t[i - 1] ?? "") && t[i + 1] !== ">");
}

/**
 * Where the word at `d` of `t` ends ({@link fedStarts}): at a blank, a
 * command's end or — unless `angles` is set, as in an assignment's value — a
 * redirection's `<` or `>`, outside its quotes and substitutions; `-1` when
 * it opens a quote it never closes, which the shell reading it cannot run and
 * the hook cannot read past.
 */
function wordEnd(t, d, angles = false) {
  let i = d;
  while (i < t.length && !/\s/.test(t[i]) && (angles || !/[<>]/.test(t[i])) && !endsCommand(t, i)) {
    const e = pieceEnd(t, i);
    if (e < 0) return -1;
    i = e;
  }
  return i;
}

/** Past the blanks (newlines too, as `\s` reads them) from `i` of `t`. */
function blanksFrom(t, i) {
  while (i < t.length && /\s/.test(t[i])) i++;
  return i;
}

/**
 * Where a wrapper option's value that starts at `i` of `t` ends ({@link
 * leadStep}): its quoted runs and escapes whole, any other character but a
 * blank, `;`, `&`, `|`, `<` or `>` plain; `-1` for none, or one whose quote
 * never closes.
 */
function optionValueEnd(t, i) {
  let k = i;
  while (k < t.length && !/[\s;&|<>]/.test(t[k])) {
    if (t[k] === "\\") k += 2;
    else if (t[k] === '"' || t[k] === "'") {
      const e = pieceEnd(t, k);
      if (e < 0) return -1;
      k = e;
    } else k++;
  }
  return k > i ? Math.min(k, t.length) : -1;
}

/** The lead's keywords, the wrappers whose options the lead steps over, and the options of each that take a value ({@link leadStep}). */
const LEAD_KEYWORDS = new Set(["if", "then", "do", "else", "elif", "while", "until", "!", "{"]);
// A Map, as it is keyed by a command word: an object would answer `constructor` (#1646).
const WRAPPER_VALUES = ["-u", "-C", "-S", "-a", "--unset", "--chdir", "--split-string"];
const LEAD_VALUE_OPTIONS = new Map([
  ...["time", "command", "exec", "env", "nohup"].map((w) => [w, WRAPPER_VALUES]),
  ["timeout", ["-k", "-s", "--kill-after", "--signal"]],
  ["xargs", ["-I", "-d", "-E", "-e", "-L", "-n", "-P", "-s"]],
]);
/** A redirection operator ahead of the program, with its fd ({@link leadStep}). */
const LEAD_REDIRECT = /^\d*(?:<<<|[<>]&|&>>?|>>|>\||<>|<|>)/;

/**
 * One token of a command's lead at `i` of `t`, read as {@link COMMAND_LEAD}
 * describes it but with the one word reader ({@link pieceEnd}), so a value
 * ends where bash ends it whatever it nests (#1646): a keyword (`if`, `then`,
 * `!` …); a wrapper (`time`, `command`, `exec`, `env`, `nohup`, `timeout`
 * with its duration, `xargs`) with its own options, a value option taking
 * the next word unless it starts with `-`; an assignment (`X="$(echo "a
 * b")"`, `X=${Y:-"a b"}`, `X=a$(a $(b $(c)))b`); or a redirection with its
 * target. Each must be followed by a blank. `{ end, wrapper }`: past the
 * blanks after it, and the wrapper it is, if one (`"keyword"` for a
 * keyword); `undefined` where no token starts.
 */
function leadStep(t, i) {
  const redirect = LEAD_REDIRECT.exec(t.slice(i, i + 8));
  if (redirect) {
    const from = blanksFrom(t, i + redirect[0].length);
    const e = wordEnd(t, from);
    return e > from && /\s/.test(t[e] ?? "") ? { end: blanksFrom(t, e) } : undefined;
  }
  const assignment = /^[A-Za-z_]\w*(?:\[[^\]\s]*\])?\+?=/.exec(t.slice(i, i + 256));
  if (assignment) {
    const e = wordEnd(t, i + assignment[0].length, true);
    return e >= 0 && /\s/.test(t[e] ?? "") ? { end: blanksFrom(t, e) } : undefined;
  }
  const e = wordEnd(t, i);
  if (e <= i || !/\s/.test(t[e] ?? "")) return undefined;
  const word = t.slice(i, e);
  if (LEAD_KEYWORDS.has(word)) return { end: blanksFrom(t, e), wrapper: "keyword" };
  const values = LEAD_VALUE_OPTIONS.get(word);
  if (!values) return undefined;
  let k = blanksFrom(t, e);
  while (t[k] === "-") {
    const o = k;
    while (k < t.length && !/\s/.test(t[k])) k++;
    if (!/\s/.test(t[k] ?? "")) return undefined;
    const next = blanksFrom(t, k);
    if (values.includes(t.slice(o, k)) && t[next] !== "-") {
      const v = optionValueEnd(t, next);
      if (v >= 0 && /\s/.test(t[v] ?? "")) {
        k = blanksFrom(t, v);
        continue;
      }
    }
    k = next;
  }
  if (word === "timeout") {
    const duration = /^\d[\d.]*[smhd]?(?=\s)/.exec(t.slice(k, k + 32));
    if (!duration) return undefined;
    k = blanksFrom(t, k + duration[0].length);
  }
  return { end: k, wrapper: word };
}

/**
 * Past the lead of the command at `i` of `t`, token by token ({@link
 * leadStep}): `{ end, env }`, `end` where its program word starts and `env`
 * whether env is the last wrapper the lead steps over, a keyword ending one
 * (#1606 second read: so an option's value spelled as a wrapper, `env -u
 * time …`, is the value it is).
 */
function leadEnd(t, i) {
  let k = blanksFrom(t, i);
  let wrapper;
  for (let s; (s = leadStep(t, k)); k = s.end) if (s.wrapper) wrapper = s.wrapper === "keyword" ? undefined : s.wrapper;
  return { end: k, env: wrapper === "env" };
}

/** The `echo` or `printf` the pipeline stage starting at `s` of `t` runs, past its lead: `{ name, start, end }`, or `undefined`. */
function echoAt(t, s) {
  const { end } = leadEnd(t, s);
  const m = /^(echo|printf)(?=\s)/.exec(t.slice(end, end + 7));
  return m && { name: m[1], start: end, end: end + m[1].length };
}

/**
 * A text some shell reads, as {@link fedStarts} walks it (#1646): `text`;
 * `at` and `end`, for each of its characters where in the view's text what it
 * is read from starts and ends (an escape's backslash, past its last
 * character), both `null` for the view's text itself, whose shell is the one
 * the command is typed to; `live`, set on a character that stands for an
 * expansion an outer shell makes (its result is not known); `ends`, for each
 * index where the command holding it ends — at a newline, `;`, `|`, a paren or
 * a `&` that is no redirect's, outside its words' quotes and substitutions, so
 * `X="a;b"` ends nothing; and `commands`, where each command starts. A `#`
 * that starts a word comments out the rest of its line, and a heredoc's body
 * (`<<E` or `<<-E`, its delimiter quoted or not, an arithmetic `((…<<…))`
 * aside) runs from the line after its operator to its delimiter's line, or to
 * the end: neither holds a command, so a quote in them closes nothing.
 * `unread` is set for a heredoc operator with no delimiter, which the shell
 * refuses. A quote that never closes runs to the end.
 */
function level(text, at = null, end = null, live = null) {
  const ends = new Int32Array(text.length + 1);
  const commands = [0];
  let start = 0;
  let heredocs = [];
  let unread = false;
  // Whether `i` starts a word: at the start, or after an unescaped blank or
  // operator. An escaped one is part of its word, so `a\ #b` holds no
  // comment (CodeRabbit on PR #1788).
  let wordStart = true;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const atWord = wordStart;
    wordStart = false;
    if (c === "#" && atWord) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    } else if (c === "<" && text[i + 1] === "<" && text[i + 2] !== "<" && text[i - 1] !== "<") {
      if (text.slice(Math.max(0, start - 2), start) === "((") {
        i += 2;
        continue;
      }
      let k = i + 2;
      const strip = text[k] === "-";
      if (strip) k++;
      while (text[k] === " " || text[k] === "\t") k++;
      const e = wordEnd(text, k);
      if (e <= k) {
        unread = true;
        i = e < 0 ? text.length : k;
        continue;
      }
      heredocs.push({
        delimiter: decodeWord(text.slice(k, e))
          .map((x) => x.c)
          .join(""),
        strip,
      });
      i = e;
    } else if (endsCommand(text, i)) {
      ends.fill(i, start, i + 1);
      i++;
      // The bodies of the heredocs this line opened, in order, each to its delimiter's line.
      if (c === "\n")
        for (const { delimiter, strip } of heredocs)
          while (i < text.length) {
            const nl = text.indexOf("\n", i);
            const line = text.slice(i, nl < 0 ? text.length : nl);
            i = nl < 0 ? text.length : nl + 1;
            if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
          }
      if (c === "\n") heredocs = [];
      commands.push((start = i));
      wordStart = true;
    } else {
      const e = pieceEnd(text, i);
      // A plain blank or redirection character, read alone, ends a word.
      wordStart = e === i + 1 && /[\s<>&]/.test(c);
      i = e < 0 ? text.length : e;
    }
  }
  ends.fill(text.length, start);
  return { text, at, end, live, ends, commands, unread };
}

/** Where in the view's text the character at `i` of the {@link level} `L` is read from: its start, and its end. */
const viewAt = (L, i) => (L.at ? L.at[i] : i);
const viewEnd = (L, i) => (L.end ? L.end[i] : i + 1);

/**
 * A {@link level} built from characters, each `{ c, at, end, live }` with
 * `at` and `end` view indices ({@link readLevel}, {@link unescaped}).
 */
function levelOf(chars, extra = {}) {
  const at = new Int32Array(chars.length);
  const end = new Int32Array(chars.length);
  const live = new Uint8Array(chars.length);
  chars.forEach((x, k) => {
    at[k] = x.at;
    end[k] = x.end;
    live[k] = x.live ? 1 : 0;
  });
  return { ...level(chars.map((x) => x.c).join(""), at, end, live), ...extra };
}

/**
 * The text the shell a word of `parent` (a {@link level}: the view's own
 * text, since a string inside a string is refused, #1659) is handed reads
 * (#1646): the word at `d` decoded as the parent's shell reads it ({@link
 * decodeWord}) — or, where `join` is set, every word from `d` to the end of
 * its command, each decoded and joined by one blank, as `pwsh -Command`,
 * `cmd /c`, `watch` and `parallel` join theirs — each character placed where
 * in the view's text it is read from. With `join` `"escaped"` each word is
 * joined as `watch -x` keeps it, a backslash before every character but a
 * letter, a digit, `_`, `-`, `$` and `=`, so it stays one word. So the raw
 * text's quoting is undone once: `bash -c "X=\"a b\" gh …"` reads `X="a b"
 * gh …`, and a splice `'a '"$V"' b'` reads as bash joins it. A string whose
 * form is not one plain level (an ANSI-C or locale string) is refused before
 * it gets here ({@link stringForm}).
 * `from` and `to` are the view indices its words
 * span; `parts`, where a joined level has more than one, each word joined as
 * `{ first, last, from, to }`: its span in the level and in the view.
 */
function readLevel(parent, d, join) {
  const stop = join ? parent.ends[d] : parent.text.length;
  // The view's own text is read from the command itself, each word a fed
  // reading rewrote laid over it whole (`rewrites`): a word a raw-text anchor
  // misread and rewrote (`\ngh` inside `$'…'`, read raw as one word) never
  // takes an escape away from the string's shell (#1646).
  const source = parent.source ?? parent.text;
  const chars = [];
  const parts = [];
  let i = d;
  let last = d;
  while (i < stop) {
    const from = i;
    const e = wordEnd(source, i);
    i = e < 0 ? stop : Math.min(e, stop);
    if (i === from) break;
    if (chars.length) chars.push({ c: " ", at: viewAt(parent, last), end: viewAt(parent, last), live: false });
    const first = chars.length;
    let laid = -1;
    for (const x of decodeWord(source.slice(from, i))) {
      const live = x.live || parent.live?.[from + x.at] === 1;
      const rewrite = parent.rewrites?.get(from + x.at);
      if (rewrite) {
        // The first character of a rewritten word brings its view text whole.
        if (laid < rewrite[0]) {
          for (let k = rewrite[0]; k < rewrite[1]; k++)
            chars.push({ c: parent.text[k], at: k, end: k + 1, live: false });
          laid = rewrite[0];
        }
        continue;
      }
      for (let k = 0; k < x.c.length; k++) {
        const c = join === "escaped" && !/[\w$=-]/.test(x.c[k]) ? `\\${x.c[k]}` : x.c[k];
        for (let q = 0; q < c.length; q++)
          chars.push({ c: c[q], at: viewAt(parent, from + x.from), end: viewEnd(parent, from + x.end - 1), live });
      }
    }
    parts.push({ first, last: chars.length, from: viewAt(parent, from), to: viewEnd(parent, i - 1) });
    last = i;
    if (!join) break;
    while (i < stop && (parent.text[i] === " " || parent.text[i] === "\t")) i++;
  }
  const to = last > d ? viewEnd(parent, last - 1) : viewAt(parent, d);
  return levelOf(chars, { from: viewAt(parent, d), to, parts: parts.length > 1 ? parts : null });
}

/** The index in `L` (a {@link level}) of its first character written at view index `p` or later. */
function levelIndex(L, p) {
  if (!L.at) return p;
  let lo = 0;
  let hi = L.at.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (L.at[mid] < p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The shells that join every word after their string switch or options into
 * the line they run ({@link readLevel}). `eval` and `sudo -s`, which joined
 * theirs too, are refused rather than read (#1659).
 */
const JOINING_SHELLS = new Set(["watch", "parallel", "pwsh", "powershell", "cmd"]);

/**
 * The word at `d` of the {@link level} `L` as {@link normalisePrograms} reads
 * it in the view (#1646): `end`, where its raw text ends; `chars`, it decoded
 * as `L`'s shell reads it ({@link decodeWord}), an expansion an outer shell
 * makes still live; `contiguous`, whether its raw text is its own and nothing
 * else — no quote of another piece between its characters, as in the splice
 * `'g'"h"`; and `text`, its text in the level. A word that is a whole word of
 * a joined level (`pwsh -Command "gh" pr merge 7`) spans that word's raw text, quotes
 * and all, so the rewrite reads it whole as at command position.
 */
function levelWord(L, d, e) {
  // The joined word starting at `d`, from an index built once per level, so a
  // level of n joined words costs n lookups, not n² (#1646).
  const starting = L.parts && (L.partAt ??= new Map(L.parts.map((x) => [x.first, x]))).get(d);
  const part = starting?.last === e ? starting : undefined;
  const text = L.text.slice(d, e);
  const chars = decodeWord(text).map((x) => ({ ...x, live: x.live || L.live?.[d + x.at] === 1 }));
  let contiguous = true;
  for (let k = d + 1; k < e; k++) if (L.at[k] !== L.at[k - 1] && L.at[k] !== L.end[k - 1]) contiguous = false;
  const start = part ? part.from : L.at[d];
  const end = part ? part.to : L.end[e - 1];
  return { start, end, chars, contiguous, text };
}

/**
 * The forms that hand text to a shell which the hook refuses rather than reads
 * (#1659, the stopping rule in `docs/superpowers/specs/2026-11-24-issue-1659-*.md`):
 * agents here type none of them, so modelling a second shell, a printer or a
 * decoder for each would be readers nobody needs. {@link fedStarts} finds
 * them, {@link refusedForms} lists them, and `checkBash` refuses the command
 * before any rule judges it.
 */
const REFUSED = Object.freeze({
  printer: "a printer piped into a shell",
  stdin: "a shell reading its script from stdin",
  hereString: "a shell reading its script from a here-string",
  heredoc: "a shell reading its script from a heredoc",
  eval: "eval",
  sudo: "a sudo that runs a shell",
  ansi: "an ANSI-C string",
  locale: "a locale string",
  nested: "a string inside a string",
  substitution: "a substitution at command position in a string",
  program: "a program word that is not its plain name",
});

/** The shells that read a program word with `\` as plain text, a path separator ({@link wordForm}). */
const LITERAL_BACKSLASH = new Set(["pwsh", "powershell", "cmd"]);
/** PowerShell's names, and its `eval` ({@link fedStarts}, {@link refusedForms}). */
const POWERSHELLS = new Set(["pwsh", "powershell"]);
const PS_EVAL = new Set(["iex", "invoke-expression"]);
/** The shell words whose first word that is no option is a file to run or a user, never a string ({@link fedStarts}). */
const FILE_RUNNERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "su", "source"]);

/** A word of a command cut for a refusal's shape. */
const clip = (w) => (w.length > 40 ? `${w.slice(0, 40)}…` : w);

/**
 * Why the string a shell is handed at `d` of the raw `t` is not one plain
 * level (#1659), or `undefined` when it is: an ANSI-C `$'…'` or a locale
 * `$"…"` piece in it. Read word by word up to `stop` where the shell joins
 * its words (`join`), else the one word. A word spliced from quoted pieces and
 * outer expansions (`'…'"$VAR"'…'`) is one plain level, read with bash's quote
 * removal ({@link readLevel}): agents type it, so the stopping rule's
 * re-opening clause reads it (#1659). A splice inside a program word of the
 * string is refused where that word is read ({@link fedStarts}).
 */
function stringForm(t, d, stop, join) {
  for (let i = d; i < stop;) {
    const end = wordEnd(t, i);
    const e = end < 0 ? stop : Math.min(end, stop);
    if (e <= i) break;
    for (let k = i; k < e;) {
      if (t[k] === "$" && t[k + 1] === "'") return REFUSED.ansi;
      if (t[k] === "$" && t[k + 1] === '"') return REFUSED.locale;
      const n = pieceEnd(t, k);
      k = n < 0 ? e : n;
    }
    if (!join) break;
    i = e;
    while (i < stop && (t[i] === " " || t[i] === "\t")) i++;
  }
  return undefined;
}

/**
 * A program word `raw` of a string the shell `via` was handed, decoded as
 * that shell reads it ({@link decodeWord}): a `\` PowerShell or cmd.exe reads
 * is plain text there, a path separator, so it is escaped before bash's
 * reading; `outer(k)` says the character at `k` of `raw` stands for an
 * expansion the typed command's shell made, whose text is not known.
 */
function levelChars(raw, via, outer) {
  const text = LITERAL_BACKSLASH.has(via) ? raw.replace(/\\/g, "\\\\") : raw;
  // Each offset of `text` back to the one of `raw` it is written from.
  const back = [];
  for (let i = 0, k = 0; i < raw.length; i++) {
    back[k++] = i;
    if (text.length > raw.length && raw[i] === "\\") back[k++] = i;
  }
  back.push(raw.length);
  return decodeWord(text).map((x) => ({
    ...x,
    at: back[x.at],
    from: back[x.from],
    end: back[x.end] ?? raw.length,
    live: x.live || outer(back[x.at]),
  }));
}

/**
 * Why the program word `raw`, as the shell `via` reads it in a string it was
 * handed, is not its plain name after quote removal (#1659), or `undefined`
 * when it is: a command substitution anywhere in it (`subst(x)` says whether
 * the expansion `x` is one), or, in its name — its last path segment, as a
 * program word at the typed level is read — another expansion, a quote that
 * splices it from pieces, or an escape. Quotes around the whole word, or
 * around its path, are plain; an expansion in its directory part is not in
 * its name. A glob or a brace expansion is no such form: it is judged by the
 * stand-ins every program word that globs gets (`unreadablePrograms`), as at
 * the typed level.
 */
function wordForm(chars, raw, subst) {
  if (chars.some((x) => x.live && x.c === "$" && subst(x))) return REFUSED.substitution;
  let sep = -1;
  chars.forEach((x, k) => {
    if (!x.live && (x.c === "/" || x.c === "\\")) sep = k;
  });
  const name = chars.slice(sep + 1);
  if (!name.length) return undefined;
  if (name.some((x) => x.live && x.c === "$")) return REFUSED.program;
  return /['"\\]/.test(raw.slice(name[0].from, name.at(-1).end)) ? REFUSED.program : undefined;
}

/**
 * Whether the shell word `name`, its words read as {@link commandOf} gives
 * `r`, runs text it is handed rather than a file (#1659): a string switch's
 * string; the words `watch`, `parallel` and `trap` run, and the command
 * PowerShell runs without `-Command`; or, for a shell that reads its script
 * from stdin ({@link STDIN_SHELLS}), no string and no file, so its stdin.
 */
function feedsText(name, r) {
  if (name === "eval" || r.string !== undefined) return true;
  if (["watch", "parallel", "trap", "pwsh", "powershell"].includes(name) && r.program !== undefined) return true;
  if (POWERSHELLS.has(name) && r.stop) return !r.file;
  return STDIN_SHELLS.has(name) && r.program === undefined && !r.stop && r.stdin !== "other";
}

/**
 * Whether the `sudo` whose word ends at `from` of `t` runs a shell (#1659):
 * `-s`, `-i`, `--shell` or `--login` ({@link sudoRunsShell}), or a program
 * word that is a {@link SHELL_NAMES} word (`sudo bash …`).
 */
function sudoShell(t, from, limit) {
  if (sudoRunsShell(t, from)) return true;
  const { program } = commandOf(OPTION_SPECS.get("sudo"), t, from, limit);
  if (program === undefined) return false;
  const e = wordEnd(t, program);
  return SHELL_NAMES.has(programName(decodeWord(t.slice(program, e < 0 ? limit : e)))?.name);
}

/**
 * Where the words a shell word or a wrapper runs start (#1607, #1634): a map
 * from each such index to how that word is the program (`{ how, via }`), plus
 * `words`, each such word read in a string as {@link levelWord} gives it,
 * `quotes`, every quoted string of the fed spans as `[open, close]` ({@link
 * pipelinesOf}), `quoteKinds`, the kind of each string a shell runs by its
 * opening quote, `unclosed`, set when the lead of a command a shell other
 * than cmd.exe is handed stops at a word that opens a quote it never closes
 * (#1646): the hook cannot read past it, so {@link view} reports it and
 * `checkBash` refuses the command; cmd.exe has no `'` quoting, so `cmd /c
 * "it's.bat"` is none — and `refused`, each form found that the hook refuses
 * rather than reads, as `{ form, shape }` ({@link REFUSED}, #1659). Each
 * position is at command position as a {@link cmd} anchor is after a
 * boundary: {@link view} hands them to {@link normalisePrograms}, so the word
 * is a program word — rewritten to the name it runs (`bash -c 'gh.exe …'`,
 * `nice gh.exe …`), listed in {@link view}'s `programs` with its kind, and
 * read by every rule as a word typed directly is. Two things put a word
 * there, each read forward from a word that is already a program (`byName`),
 * so a shell word or wrapper that is an argument (`rg -t sh "gh …"`, `ls
 * /bin/sh "…"`, CodeRabbit on PR #1632) feeds nothing:
 *
 * - A {@link SHELL_WORDS} word at the typed level, past its options with
 *   their values ({@link commandOf}, {@link OPTION_SPECS}): the word after
 *   them — whole, quoted or not, for a `sudo` that runs a program (`sudo gh
 *   …`, `sudo -u me gh …`, `sudo "gh" …`; `how` is `"wrapper"`); for a shell,
 *   the first word of each command of the string it runs (`trap 'gh …' EXIT`,
 *   `bash -c 'gh …'`, `bash -o pipefail -c '…'`, `pwsh -ExecutionPolicy
 *   Bypass -Command "…"`, `cmd //c "…"`, `su - me -c '…'`; `how` is
 *   `"shell"` for the first, `"command"` for one after a separator). `via`
 *   is the shell word.
 * - The word a `nice`, `stdbuf` or `winpty` that is a program runs, past its
 *   options with their values, and the word after each `-exec` / `-execdir`
 *   of a `find` that is a program ({@link WRAPPER_NAMES}, {@link FIND_EXEC};
 *   `how` is `"wrapper"`, `via` the wrapper or `"find -exec"`), at the typed
 *   level or in a string.
 *
 * Each string a shell runs is read one level deep, in the text that shell
 * reads ({@link readLevel}, #1646): its quoting undone, past a {@link
 * COMMAND_LEAD} token by token (`bash -c 'GH_REPO=x gh …'`, `bash -c 'X="a
 * b" gh …'`, `bash -c "X=\"a b\" gh …"`) to where its command ends there, so
 * a quoted `;` ends nothing (`nice env X="a;b" gh …`); a wrapper inside a
 * string is read in the string's level. A position is the view index where
 * the raw text of a word's first character starts — its escape's backslash
 * for `\"gh\"` inside `"…"` — and, once that word is rewritten, where the
 * rewritten word starts, so every round records the same one. The same
 * string piped to anything else, or written to a file, is a mention.
 *
 * What the hook does not read is refused, never modelled (#1659): a printer
 * or any other command piped into a shell, a shell fed a here-string or a
 * heredoc, `eval`, a `sudo` that runs a shell, a string that is not one plain
 * level ({@link stringForm}), a shell inside a string that runs text it is
 * handed ({@link feedsText}), and a program word in a string that is not its
 * plain name ({@link wordForm}). Positions are recorded, never searched for,
 * so the pass is linear in the text (one option step per word, one lead step
 * per token, one decoding per string), whatever a rule later asks about.
 */
function fedStarts(command, text, fed, programs) {
  const byName = programsByName(text, programs);
  const starts = new Map();
  const words = new Map();
  // Each position read in a string's level, as `[view index, level, index there, kind]` ({@link found}).
  const decoded = [];
  const quotes = [];
  const quoteKinds = new Map();
  let unclosed = false;
  const refused = [];
  const refuse = (form, shape) => {
    if (!refused.some((r) => r.form === form && r.shape === shape)) refused.push({ form, shape });
  };
  // Nothing fed and no wrapper: nothing to read, and no text to walk (#1646).
  const named = (p) => {
    PROGRAM_WORD.lastIndex = p;
    const name = PROGRAM_WORD.exec(text)?.[0];
    return WRAPPER_NAMES.has(name) || name === "find";
  };
  if (!fed.length && ![...byName.keys()].some(named))
    return { starts, words, decoded, quotes, quoteKinds, unclosed, refused };
  const wordStarts = wordStartsOf(programs, text.length);
  // Each view index inside a word a fed reading rewrote, to that word's span:
  // a string the view hands over is read from the command, with these laid
  // over it ({@link readLevel}).
  const rewrites = new Map();
  for (const [s, e, , , kind] of programs)
    if (kind && text.slice(s, e) !== command.slice(s, e)) for (let k = s; k < e; k++) rewrites.set(k, [s, e]);
  // The view's text as the typed command's shell reads it, and each string a
  // shell is handed as that shell reads it, with the one holding each view
  // index (`owner`).
  const base = { ...level(text), source: command, rewrites };
  const levels = [];
  const owner = new Int32Array(text.length).fill(-1);
  const levelAt = (p) => (owner[p] >= 0 ? levels[owner[p]] : base);
  // The program word `[d, e)` of a string's level `L`: refused when it is not
  // its plain name, when it is `eval` (PowerShell's too, in its string) or a
  // sudo that runs a shell, and when it is a shell that runs text it is
  // handed — a string inside a string (#1659). A file a shell runs (`bash
  // x.sh`) is no string, so nothing in its level is judged so.
  const inLevel = (L, d, e) => {
    if (L.file) return;
    // A `case` pattern (`MERGED*)`, `"a b"*)`) ends at its `)`: no program.
    if (L.text[e] === ")" && !/\(\s*$/.test(L.text.slice(0, d))) return;
    const ps = POWERSHELLS.has(L.via);
    // PowerShell ends a command's name at a brace or a paren (`?{…}`).
    const raw = ps ? L.text.slice(d, e).replace(/[{(][\s\S]*$/, "") : L.text.slice(d, e);
    if (!raw || ASSIGNMENT.test(raw)) return;
    const outer = (k) => L.live?.[d + k] === 1;
    // PowerShell starts a statement with an expression as readily as with a
    // command (`$p = …`, `'text'`, `[Math]::Min(…)`, `(…).Id`): such a word
    // runs no program, unless the call operator `&` runs it. One the typed
    // command's shell expands is not known, so it is judged as a name.
    if (ps && !outer(0) && /^[$'"[(@{\d-]/.test(raw) && !/(?:^|[^&])&\s*$/.test(L.text.slice(0, d))) return;
    const shape = () => `${L.via} … ${clip(command.slice(L.at[d], L.end[d + raw.length - 1]))} …`;
    // A word whose characters come from several quoted pieces of the raw text
    // (`bash -c 'g'"h"' pr merge 7'`): no raw text spells its name in place.
    for (let k = d + 1; k < d + raw.length; k++)
      if (L.at[k] !== L.at[k - 1] && L.at[k] !== L.end[k - 1]) return refuse(REFUSED.program, shape());
    const chars = levelChars(raw, L.via, outer);
    const subst = (x) => /^(?:\$\(|\x60)/.test(outer(x.at) ? command.slice(L.at[d + x.at]) : raw.slice(x.at));
    const form = wordForm(chars, raw, subst);
    if (form) return refuse(form, shape());
    const name = programName(chars)?.name;
    if (name === "eval" || (ps && PS_EVAL.has(name))) return refuse(REFUSED.eval, `${name} …`);
    if (name === "sudo") {
      if (sudoShell(L.text, e, L.text.length)) refuse(REFUSED.sudo, `${L.via} … sudo …`);
      return;
    }
    if (SHELL_NAMES.has(name) && feedsText(name, commandOf(shellSpec(name), L.text, e, L.text.length)))
      refuse(REFUSED.nested, `${L.via} … ${name} …`);
  };
  // `d` of the level `L`, and the position after each lead token from it, up
  // to the end of its command there. Each is recorded at its raw word's
  // start, which a rewritten word's pad hides from the position (`nice
  // nice.exe gh`: the second nice is read at its name, four characters into
  // its word), so the position is the same in every round and {@link
  // normalisePrograms} finds the word there (#1634 second read). A word read
  // in a string's level is read as that level's shell reads it (`words`,
  // {@link levelWord}), not as the raw text would; the program word there is
  // judged by {@link inLevel}.
  const leads = (L, d, kind) => {
    const end = L.ends[d];
    for (;;) {
      // A comment is no command, nor a quote in it unclosed.
      if (d >= end || (L.text[d] === "#" && (d === 0 || /[\s;&|()]/.test(L.text[d - 1])))) return;
      const e = wordEnd(L.text, d);
      const word = L.at && e > d ? levelWord(L, d, e) : undefined;
      const p = word ? word.start : viewAt(L, d);
      // A word read inside a rewritten program word stands for that word only
      // when what lies before it there is the rewrite's pad.
      const ws = wordStarts[p];
      const at = ws >= 0 && /^ *$/.test(text.slice(ws, p)) ? ws : p;
      if (!starts.has(at)) starts.set(at, kind);
      if (word && at === p && !words.has(p)) words.set(p, word);
      if (L.at && d < L.text.length) decoded.push([L.at[d], L, d, kind]);
      const step = leadStep(L.text, d);
      if (!step || step.end > end) {
        if (L.at && L.via !== "cmd" && e < 0) unclosed = true;
        if (L.at && e > d) inLevel(L, d, e);
        return;
      }
      d = step.end;
    }
  };
  // The leads a string's commands take, run once every string's level is
  // built: a wrapper's own are recorded first, as they always were.
  const jobs = [];
  const closes = new Map();
  // The level `N` a shell reads, handed over from the level `L` with `kind`
  // by the word at `d` there (`up`, `upAt`: {@link levelLead}).
  const readAs = (N, kind, L, d) => {
    if (!N.text) return;
    N.via = kind.via;
    N.up = L;
    N.upAt = d;
    if (N.unread && N.via !== "cmd") unclosed = true;
    if (L === base) for (let k = N.from; k < N.to; k++) if (closes.has(k)) quoteKinds.set(k, kind);
    N.id = levels.length;
    levels.push(N);
    owner.fill(levels.length - 1, N.from, N.to);
    N.commands.forEach((s, k) => {
      let e = s;
      while (N.text[e] === " " || N.text[e] === "\t") e++;
      jobs.push([N, e, k ? COMMAND : kind]);
    });
  };
  // The string the word at `d` of the typed text starts (`join`: with the
  // words after it), read as the shell it is handed to reads it, and each of
  // its commands' leads, the first with `kind`; refused instead when it is
  // not one plain level. A file a shell runs (`file`) is read as before, as
  // the one word it is, and judged no string. The form is read in the view's
  // text, whose positions `d` is in: over a fed span that is the raw text
  // with its program words rewritten, each to a plain name.
  const stringAt = (d, kind, join, file) => {
    if (!file) {
      const form = stringForm(text, d, join ? base.ends[d] : text.length, join);
      if (form) return refuse(form, `${kind.via} … ${clip(text.slice(d, Math.max(d, wordEnd(text, d))))}`);
    }
    const N = readLevel(base, d, join);
    if (file) N.file = true;
    readAs(N, kind, base, d);
  };
  // Every string a shell is handed, in the order of the word that hands it
  // over, so the level holding a word is built before the word is read.
  const sources = [];
  for (const [a, b] of fed) {
    const own = pipelinesOf(command, a, b);
    quotes.push(...own.quotes);
    for (const [open, close] of own.quotes) closes.set(open, close);
    // What feeds the shell word at `p` its stdin through a pipe in the span: a
    // printer in the stage before it (`echo '…' | bash`), or any other command.
    const pipedInto = (p, via) => {
      if (!own.pipes.some((x) => x < p)) return;
      for (const stages of own.pipelines) {
        const k = stages.findIndex(([s, e]) => s <= p && p < e);
        if (k < 1) continue;
        const [s, e] = stages[k - 1];
        const echo = echoAt(text, s);
        if (echo && echo.end <= e && byName.has(echo.start)) return refuse(REFUSED.printer, `${echo.name} … | ${via}`);
      }
      refuse(REFUSED.stdin, `… | ${via}`);
    };
    // The shell words among the program words of the span ({@link SHELL_NAMES}:
    // a rewritten program word spells its plain name), inside a string too.
    for (const p of byName.keys()) {
      if (p < a || p >= b) continue;
      PROGRAM_WORD.lastIndex = p;
      const via = PROGRAM_WORD.exec(text)?.[0];
      if (!SHELL_NAMES.has(via)) continue;
      sources.push([
        p,
        () => {
          const L = levelAt(p);
          const d = levelIndex(L, p + via.length);
          const limit = L === base ? b : L.text.length;
          if (via === "sudo") {
            // A sudo that runs a shell is refused; one that runs a program is a
            // wrapper, its word the program whole, quoted or not.
            if (sudoShell(L.text, d, limit)) return refuse(REFUSED.sudo, "sudo …");
            const { program } = commandOf(OPTION_SPECS.get(via), L.text, d, limit);
            if (program !== undefined) jobs.push([L, program, { how: "wrapper", via }]);
            return;
          }
          // A shell word inside a string is judged with that string's program
          // words ({@link inLevel}), never read: a string is read one level deep.
          if (L !== base) return;
          if (via === "eval") return refuse(REFUSED.eval, "eval …");
          const r = commandOf(OPTION_SPECS.get(via) ?? NO_OPTIONS, text, d, b);
          // A shell that reads its script from stdin: a here-string, a heredoc
          // or a pipe, all refused (PowerShell's `-Command -` too).
          if (STDIN_SHELLS.has(via) && r.string === undefined && r.program === undefined && !r.stop) {
            if (typeof r.stdin === "number") return refuse(REFUSED.hereString, `${via} <<< …`);
            if (r.stdin === "heredoc") return refuse(REFUSED.heredoc, `${via} <<…`);
            if (r.stdin === "pipe") pipedInto(p, via);
            return;
          }
          if (POWERSHELLS.has(via) && r.string !== undefined && /^-(?=\s|$)/.test(text.slice(r.string, r.string + 2)))
            return refuse(REFUSED.stdin, `${via} -Command -`);
          const kind = { how: "shell", via };
          // `watch -x` (`--exec`) runs its words as they are, no shell joining
          // them: each is kept one word (#1646).
          const exec =
            via === "watch" &&
            r.program !== undefined &&
            /(?:^|\s)(?:--exec|-[A-Za-z]*x[A-Za-z]*)(?=\s)/.test(text.slice(d, r.program));
          const join = exec ? "escaped" : JOINING_SHELLS.has(via) ? "plain" : undefined;
          if (r.program !== undefined) stringAt(r.program, kind, join, FILE_RUNNERS.has(via));
          if (r.string !== undefined) stringAt(r.string, r.attached ? { ...kind, attached: true } : kind, join);
        },
      ]);
    }
  }
  for (const [, run] of sources.sort((x, y) => x[0] - y[0])) run();
  // The wrappers and the `find`s among the program words: what each runs, read
  // in the level that holds it.
  for (const p of byName.keys()) {
    PROGRAM_WORD.lastIndex = p;
    const name = PROGRAM_WORD.exec(text)?.[0];
    if (!WRAPPER_NAMES.has(name) && name !== "find") continue;
    const L = levelAt(p);
    const d = levelIndex(L, p + name.length);
    if (WRAPPER_NAMES.has(name)) {
      const { program } = commandOf(OPTION_SPECS.get(name) ?? NO_OPTIONS, L.text, d, L.text.length);
      if (program !== undefined) leads(L, program, { how: "wrapper", via: name });
    } else {
      COMMAND_WORD.lastIndex = d;
      for (let exec = false, m; (m = COMMAND_WORD.exec(L.text)); exec = FIND_EXEC.test(m[1]))
        if (exec) leads(L, COMMAND_WORD.lastIndex - m[1].length, { how: "wrapper", via: "find -exec" });
    }
  }
  for (const [L, d, kind] of jobs) leads(L, d, kind);
  return { starts, words, decoded, quotes, quoteKinds, unclosed, refused };
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
 * how: "shell", via }` for the first word of a string a shell runs; `{
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
 *
 * `quotes` is sorted by its opening quote and its strings never overlap (each
 * fed span is read left to right past every close, and the spans are sorted
 * and disjoint), so the one string that can hold the word is the last one
 * opening before it, found by a binary search: a lookup per match costs a log,
 * not a scan, and `matchesAt` over a chain of n quoted shell strings stays
 * linear (CodeRabbit on PR #1637).
 */
function stringAround(v, index) {
  const start = wordStartOf(v, index);
  const { quotes } = v;
  let lo = 0;
  let hi = quotes.length;
  // The first quote opening at or after `start`; the candidate is the one before it.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (quotes[mid][0] < start) lo = mid + 1;
    else hi = mid;
  }
  const quote = quotes[lo - 1];
  return quote && index <= quote[1] ? quote : undefined;
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
 * unreadable, refused, … }`. The mask is set aside — `text` and `flat` are the raw
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
 * `unsettled` says the rounds below did not settle, and `unclosedLead` that
 * the lead of a command a shell is handed opens a quote it never closes
 * ({@link fedStarts}, #1646): `checkBash` refuses either whole. `refused`
 * lists every form any round found that the hook refuses rather than reads
 * ({@link refusedForms}, #1659).
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
    const build = (starts, fedWords) => {
      const lexed = normalisePrograms(command, masked, flat, wordEnds, () => false, starts, fedWords);
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
      return { fed, out: normalisePrograms(command, restore(masked), restore(flat), wordEnds, raw, starts, fedWords) };
    };
    // The first word of each string a shell runs, and the word a wrapper runs,
    // are program words too (#1634, {@link fedStarts}). Each round can reveal
    // one more level of nesting (`sudo nice sh -c "…"`: the shell is a program
    // only once `nice` is), so it repeats until the positions stop changing —
    // each time from the masked text, since a rewritten word's pad hides its
    // start from the next pass — to a depth no command typed by hand reaches.
    // A command still unsettled past that depth is reported as `unsettled`,
    // and `checkBash` refuses it whole: a re-judge would hit the same depth
    // and read nothing, so `nice` nested nine times once let a merge through
    // (an independent judge on PR #1637).
    let starts = new Map();
    let built = build(starts, new Map());
    let found = fedStarts(command, built.out.text, built.fed, built.out.programs);
    let settled = false;
    const same = (a, b) => a.size === b.size && [...a.keys()].every((k) => b.has(k));
    // Each fed word as the round that first read it read it: a later round reads
    // a rewritten word from inside its pad, so the first reading stands (#1646).
    let fedWords = new Map();
    // Every form any round refuses (#1659): a later round reads a string's
    // program word as the rewrite left it, plain, and a nested shell may be
    // read only once a wrapper's round has made it a program, so no one round
    // sees them all.
    const refused = new Map();
    const keep = (f) => f.refused.forEach((r) => refused.set(`${r.form}: ${r.shape}`, r));
    keep(found);
    for (let round = 0; round < 8 && !(settled = same(found.starts, starts)); round++) {
      starts = found.starts;
      fedWords = new Map([...found.words, ...fedWords]);
      built = build(starts, fedWords);
      found = fedStarts(command, built.out.text, built.fed, built.out.programs);
      keep(found);
    }
    const { fed, out } = built;
    const byName = programsByName(out.text, out.programs);
    view.last = command;
    view.out = {
      text: out.text,
      flat: out.flat,
      trusted: fed.length === 0,
      sure,
      fed,
      programs: out.programs,
      unreadable: out.unreadable,
      respelled: out.respelled,
      spliced: out.spliced,
      unsettled: !settled,
      unclosedLead: found.unclosed,
      refused: [...refused.values()],
      byName,
      wordStarts: wordStartsOf(out.programs, command.length),
      starts,
      // The recorded positions whose word is no program word, once per view: every
      // rule reads them per chain segment ({@link knownPrograms}).
      loneStarts: [...starts].filter(([p]) => !byName.has(p)),
      // The positions read in a string's level, by view index ({@link found}).
      decoded: found.decoded.sort((x, y) => x[0] - y[0]),
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
 * backtick), past any blanks and the command's lead, read token by token
 * with the one word reader ({@link leadEnd}, #1646), so the word it stops at
 * is the program even where {@link COMMAND_LEAD}'s regex, which every {@link
 * cmd} anchor holds, stops short (`X=a$(a $(b $(c)))b gh …`): every rule
 * tests its shape there too ({@link matchesAt}). Each place is read on its
 * own: an assignment lead such as `x=$(` runs past the `(` a substitution's
 * own command follows. Each is `{ start, env }`, `env` whether env is the
 * last wrapper of the lead, so the word after is one of env's arguments or
 * its program.
 */
function* programPositions(text) {
  for (let p = 0; p <= text.length; p++) {
    if (p > 0 && !"\n|;&()\x60".includes(text[p - 1])) continue;
    // A redirect's own `&` (`2>&1`, `&>log`) ends no command.
    if (text[p - 1] === "&" && (text[p] === ">" || /[<>]/.test(text[p - 2] ?? ""))) continue;
    const { end, env } = leadEnd(text, p);
    yield { start: end, env };
  }
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
/** The one-letter ANSI-C escapes of a `$'…'` word, as bash decodes them ({@link ansiEscape}). */
const ANSI_LETTERS = {
  ...ANSI_PLAIN,
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/**
 * The ANSI-C escape of a `$'…'` word whose letter is at `j` of `w`, as bash
 * decodes it: `[text, next]`, `next` the index after it. A letter, an octal
 * `\NNN`, a hex `\xHH`, a `\uHHHH` or `\UHHHHHHHH` and a control `\cX`; any
 * other is kept as written, backslash and all.
 */
function ansiEscape(w, j) {
  const c = w[j];
  if (c === undefined) return ["\\", j];
  if (ANSI_LETTERS[c] !== undefined) return [ANSI_LETTERS[c], j + 1];
  const digits = (re, from) => re.exec(w.slice(from, from + 8))?.[0];
  const octal = digits(/^[0-7]{1,3}/, j);
  if (octal) return [String.fromCharCode(parseInt(octal, 8) & 0xff), j + octal.length];
  const hex = { x: /^[0-9A-Fa-f]{1,2}/, u: /^[0-9A-Fa-f]{1,4}/, U: /^[0-9A-Fa-f]{1,8}/ }[c];
  const h = hex && digits(hex, j + 1);
  if (h) return [String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)), j + 1 + h.length];
  if (c === "c" && w[j + 1] !== undefined)
    return [String.fromCharCode(w[j + 1].toUpperCase().charCodeAt(0) ^ 0x40), j + 2];
  return [`\\${c}`, j + 1];
}

/**
 * A word decoded as bash reads it, one `{ c, live }` per character it yields:
 * quotes removed and `\` escapes applied, with `live` set on a character that
 * stands for an expansion (`$…`, a backtick, one `$` per expansion), a glob
 * (`*`, `?`, a `[` that a later `]` closes) or a brace expansion (a `{` and
 * `}` around an unquoted `,` or `..`). An ANSI-C escape other than a quote or
 * a backslash is read as live too: the word it spells is not plain (a string
 * a shell is handed in that form is refused, #1659). `at` is the offset in `w`
 * of the character each one comes from, `from` where what it is decoded from
 * starts (an escape's backslash) and `end` the offset just past it: the
 * escape or the expansion whole.
 */
export function decodeWord(w) {
  const out = [];
  const lit = (c, at, end = at + 1, from = at) => {
    if (c) out.push({ c, live: false, at, end, from });
  };
  const live = (c, at, end = at + 1, from = at) => out.push({ c, live: true, at, end, from });
  // Unquoted `[`, `]`, `{`, `,`, `.` and `}`, as indices into `out`, for globs and braces.
  const bare = [];
  let i = 0;
  while (i < w.length) {
    const ch = w[i];
    if (ch === "\\") {
      if (w[i + 1] !== "\n") lit(w[i + 1], i + 1, i + 2, i);
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
        else if (ANSI_PLAIN[w[++k]] !== undefined) lit(ANSI_PLAIN[w[k]], k, k + 1, k - 1);
        else live("\\", k, k + 1, k - 1);
      i = k + 1;
    } else if (ch === "$" && w[i + 1] === '"') {
      // A locale string, `$"…"`: double-quoted text bash may translate (#1606 review).
      i++;
    } else if (ch === '"') {
      let k = i + 1;
      while (k < w.length && w[k] !== '"') {
        if (w[k] === "\\" && '"\\$`\n'.includes(w[k + 1] ?? "x")) {
          if (w[k + 1] !== "\n") lit(w[k + 1], k + 1, k + 2, k);
          k += 2;
        } else if ((w[k] === "$" && EXPANDS.test(w[k + 1] ?? "")) || w[k] === "\x60") {
          const e = expansionEnd(w, k);
          live("$", k, e);
          k = e;
        } else lit(w[k], k++);
      }
      i = k + 1;
    } else if ((ch === "$" && EXPANDS.test(w[i + 1] ?? "")) || ch === "\x60") {
      const e = expansionEnd(w, i);
      live("$", i, e);
      i = e;
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

/**
 * Whether the raw text `word` of a word a fed string holds can be rewritten
 * in place (#1646): it is whole on its own ({@link selfContained}) and reads
 * as its shell reads it (`chars`, {@link levelWord}), character for
 * character and expansion for expansion — `"gh"` inside `'…'` can, `\"gh\"`
 * inside `"…"` (`"gh"` read raw, `gh` by its shell) cannot.
 */
function rewritable(word, chars) {
  if (!selfContained(word)) return false;
  const own = decodeWord(word);
  return own.length === chars.length && own.every((x, k) => x.c === chars[k].c && x.live === chars[k].live);
}

/**
 * A fed word the rewrite cannot stand in for ({@link rewritable}), read as
 * its shell reads it and listed in `out` (#1646), none of them rewritten: an
 * assignment or an option is none. One whose program expands or globs is
 * `unreadable`, judged as gh and as git as at command position (`bash -c
 * "$(echo gh) pr merge 7"`, `eval "\$GH pr merge 7"`). One whose raw text is
 * its own and nothing else is `respelled` with the name its shell runs
 * (`"\"gh\" pr merge 7"`, pwsh's `& \"C:\…\gh.exe\"`), so `checkBash` judges
 * the command with that name in its place. One spliced from quoted pieces
 * (`'g'"h"`) has no raw text of its own a name could stand in, so it is
 * `spliced`, and `checkBash` refuses it.
 */
function respelledIn(fedWord, word, start, end, out) {
  const decoded = fedWord.chars.map((x) => x.c).join("");
  if (ASSIGNMENT.test(fedWord.text) || (decoded.startsWith("-") && !fedWord.chars[0].live)) return;
  const read = programName(fedWord.chars);
  if (!read) return;
  if (!fedWord.contiguous) out.spliced.push({ start, end, word });
  else if (read.unreadable) out.unreadable.push({ start, end, word });
  else {
    // The name the raw text spells too, where it spells one: the two readings
    // differ only on an escape, and the hook errs to the one a guard reads
    // (`"C:\\tools\\gh.exe"` is `gh` read raw, `C:toolsgh.exe` to its shell).
    const own = selfContained(word) ? programName(decodeWord(word)) : null;
    out.respelled.push({ start, end, word, name: read.name, rawName: own?.name ?? read.name });
  }
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
function normalisePrograms(command, text, flat, words, raw, extra = new Map(), fedWords = new Map()) {
  let t = text;
  let f = flat;
  // `[start, end, cut, keep, kind]` each: the word, where its last segment
  // starts, the command substitutions of its directory part, kept live, and
  // how it is the program when `extra` put it there (#1634, {@link fedStarts}).
  const programs = [];
  const unreadable = [];
  // Program words a fed string spells so the rewrite cannot stand in for them
  // (#1646, {@link respelledIn}).
  const respelled = [];
  const spliced = [];
  const seen = new Set();
  // Inside a program word read already, and not inside a substitution it kept:
  // the rewritten text is blank or the name there, so the lead may stop in it.
  // Kept as a span array, so a chain of n commands asks n times, not n² (#1634 review).
  const inside = new Uint8Array(command.length);
  const covered = (p) => inside[p] === 1;
  // Where a fed string's own shell starts a word (#1646): a word the raw text
  // reads across one of them is a misreading of that string (`))\ngh` inside
  // `$'…'` read raw as the one word `\ngh`), and the shell's words stand.
  const fedStart = new Uint8Array(command.length + 1);
  for (const s of fedWords.keys()) fedStart[s] = 1;
  const spansFedStart = (a, b) => {
    for (let k = a + 1; k < b; k++) if (fedStart[k]) return true;
    return false;
  };
  for (let changed = true, passes = 0; changed && passes < 32; passes++) {
    // Every rewrite of the pass, `[start, end, text, flat]`, applied in one
    // splice at its end: a string rebuilt per word made a chain of n words n²
    // (#1634 review). Words never overlap (`seen`, `covered`), so the order of
    // application is free, and a comparison reads the text as it stood.
    const edits = [];
    // The first word of each fed string after the anchored positions, so a
    // whole quoted word (`sudo "gh" …`) is read before the word inside its quotes.
    const positions = [...programPositions(t), ...[...extra].map(([start, kind]) => ({ start, env: false, kind }))];
    for (const { start, env, kind } of positions) {
      if (seen.has(start) || covered(start)) continue;
      // Where the mask is set aside, a word a fed string holds is read as its
      // own shell reads it (#1646, {@link fedStarts}, {@link levelWord}): it
      // ends where that shell ends it, not where the raw text would.
      const fedWord = raw(start) ? fedWords.get(start) : undefined;
      let end = fedWord?.end ?? words.get(start);
      if (end === undefined && raw(start) && (kind || start === 0 || /[\s|;&()\x60]/.test(command[start - 1]))) {
        CRUDE_WORD.lastIndex = start;
        const w = CRUDE_WORD.exec(command);
        if (w) end = start + w[0].length;
      }
      if (end === undefined || end <= start) continue;
      if (!fedWord && raw(start) && spansFedStart(start, end)) continue;
      seen.add(start);
      const word = command.slice(start, end);
      // A fed word whose raw text the rewrite cannot stand in for — not whole on
      // its own, or not spelling what its shell reads (`$(echo gh)`, `\"gh\"`
      // in `"…"`, the splice `'g'"h"`) — is never rewritten, and is judged by
      // what its shell reads ({@link respelledIn}).
      if (fedWord && !rewritable(word, fedWord.chars)) {
        respelledIn(fedWord, word, start, end, { unreadable, respelled, spliced });
        continue;
      }
      // Where the mask is set aside the rules read the raw text as it stands,
      // separators inside strings included: a word there is rewritten only when
      // it is whole on its own, so no rewrite hides a command (#1606 second read).
      if (raw(start) && !selfContained(word)) continue;
      const chars = decodeWord(word);
      const live = chars.some((x) => x.live);
      const decoded = chars.map((x) => x.c).join("");
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
      // The merged edits are sorted and disjoint, so the only one that can
      // hold the next is the last: a check of that one, not a scan of them
      // all, which made a chain of n `gh.exe` commands n² (CodeRabbit CLI on #1634).
      const merged = [];
      for (const e of edits.sort((x, y) => x[0] - y[0])) {
        const last = merged.at(-1);
        const outer = last && last[0] <= e[0] && e[1] <= last[1] ? last : undefined;
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
  return { text: t, flat: f, programs, unreadable, respelled, spliced };
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

/**
 * The program words a fed string spells so no rewrite can stand in for them
 * in the text (#1646, {@link respelledIn}): `respelled`, each `{ start, end,
 * word, name }` with the name its shell runs, and `spliced`, each `{ start,
 * end, word }`, joined from quoted pieces.
 */
export const respelledPrograms = (command) => {
  const { respelled, spliced } = view(command);
  return { respelled, spliced };
};

/**
 * Whether {@link view} stopped reading `command` at its depth cap with nested
 * shells or wrappers still unread (#1634): such a command is refused whole by
 * `checkBash`, since no rule can see the program at the bottom of it.
 */
export const unsettled = (command) => view(command).unsettled;

/**
 * Whether a command a shell is handed in `command` has a lead that opens a
 * quote it never closes, or a heredoc operator with no delimiter (#1646,
 * {@link fedStarts}, {@link level}): the hook cannot read which word runs
 * after it, so `checkBash` refuses the command whole, as it refuses an
 * {@link unsettled} one.
 */
export const unclosedLead = (command) => view(command).unclosedLead;

/**
 * The forms in `command` that hand text to a shell in a way the hook refuses
 * rather than reads (#1659, {@link REFUSED}), each `{ form, shape }`, in the
 * order {@link fedStarts} found them: `checkBash` refuses a command with any,
 * before any rule judges it. A command typed to PowerShell (`shell`) refuses
 * its `eval` too, `Invoke-Expression` or `iex`, wherever it is a program word.
 */
export function refusedForms(command, shell = BASH) {
  const v = view(command);
  const out = [...v.refused];
  if (shell === POWERSHELL)
    for (const p of v.byName.keys()) {
      PROGRAM_WORD.lastIndex = p;
      const name = PROGRAM_WORD.exec(v.text)?.[0];
      if (PS_EVAL.has(name)) out.unshift({ form: REFUSED.eval, shape: `${name} …` });
    }
  return out;
}

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
 * carried one, `via` (`"bash"`, `"sudo"`, …), so a rule can say which shape
 * it refused. A match that is both is one match. A match whose program sits
 * inside a string a shell is handed reads no further than the string's close
 * ({@link found}): `bash -c 'git worktree add ../ir-5'` names `../ir-5`, not
 * `../ir-5'`, and `bash -c 'pnpm test' | tail` holds no piped `pnpm test`
 * inside the string. A match whose command its shell reads differently from
 * the text here (a quote removed, cmd.exe's or PowerShell's join, #1646)
 * carries `decoded`, that command as
 * its shell reads it, and `sep`, the separator that ends it there (`|`
 * for a pipe): its raw groups are mis-sliced, and `checkBash` lets no such
 * command pass ({@link takeDecodedHits}). A match read in a string's level
 * carries `before`, what that string's shells run ahead of it ({@link
 * levelLead}), and `shell`, the word of the shell that reads that string.
 */
export function* matchesAt(command, re) {
  const all = [...found(command, re, 0, trustedMask(command).length)].sort((x, y) => x.program - y.program);
  for (const f of all) yield rawMatch(command, f);
}

/** The flags of `re` with `extra` added, each once. */
const withFlags = (re, extra) => [...new Set([...re.flags, ...extra])].join("");

/** Each regex {@link compiled} built from a source regex, by its flags. */
const COMPILED = new WeakMap();

/**
 * A regex with the source of `source` and the flags of `re` plus `extra`,
 * built once per pair: a {@link cmd} rule's source holds the whole {@link
 * COMMAND_LEAD}, and {@link found} asked for a fresh one on every call (#1646).
 * Shared safely: a sticky one is always read at a `lastIndex` set just before,
 * and `matchAll` clones the global one.
 */
function compiled(source, re, extra) {
  let byFlags = COMPILED.get(source);
  if (!byFlags) COMPILED.set(source, (byFlags = new Map()));
  const flags = withFlags(re, extra);
  let out = byFlags.get(flags);
  if (!out) byFlags.set(flags, (out = new RegExp(source.source, flags)));
  return out;
}

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
 * 5 --body @-`). Last, the shape tested sticky in the decoded text of each
 * string a shell runs, at each position read there ({@link fedStarts}), where
 * that text differs from the view's over the match (`cmd /c "gh pr" merge 7`,
 * `bash -c "gh \"pr\" merge 7"`): the match mapped back to the view through the level's `at` and `end`, and
 * recorded as a decoded hit ({@link takeDecodedHits}), since a rule reading
 * its arguments from the raw text at those indices reads them mis-sliced
 * (#1646; level-aware argument reading is #1783). Lazy, so {@link has} stops
 * at the first.
 */
function* found(command, re, a, b) {
  const text = trustedMask(command);
  const slice = text.slice(a, b);
  const v = view(command);
  const closeIn = (p) => {
    const close = stringAround(v, a + p)?.[1];
    return close === undefined ? undefined : close - a;
  };
  // Every occurrence a match was yielded for ({@link occurrenceOf}), so the decoded pass adds none twice.
  const yielded = new Set();
  // Each view index the passes reading the view's text matched at, to the
  // command they took it for there ({@link levelCommand}'s text).
  const readAt = new Map();
  const record = (m, kind, program) => {
    const f = {
      at: a + m.index,
      end: a + m.index + m[0].length,
      indices: m.indices.map((r) => r && [a + r[0], a + r[1]]),
      kind,
      program: a + program,
    };
    // A command its shell reads differently from the view: what it reads, and a decoded hit.
    const read = levelCommand(v, f.program) ?? levelCommand(v, wordStartOf(v, f.program));
    f.occurrence = read ? occurrenceOf(f.program, read.L, read.d) : String(f.program);
    yielded.add(f.occurrence);
    readAt.set(read ? read.L.at[read.d] : f.program, read?.text);
    if (read?.divergent) {
      f.decoded = read.text;
      f.sep = read.sep;
      decodedHit(command, re, f.occurrence);
    }
    if (read) {
      f.before = levelLead(read.L, read.d);
      f.shell = read.L.via;
    }
    return f;
  };
  const taken = new Set();
  const anchored = compiled(re, re, "yd");
  for (let m of slice.matchAll(compiled(re, re, "gd"))) {
    const program = innerStart(slice, m, re, (p) => v.byName.has(a + p) || v.starts.has(a + p));
    const close = closeIn(program);
    if (close !== undefined && m.index + m[0].length > close && !(m = matchWithin(anchored, slice, m.index, close)))
      continue;
    taken.add(program);
    yield record(m, COMMAND, program);
  }
  if (!re.inner) return;
  const inner = compiled(re.inner, re, "yd");
  for (const [p, kind] of knownPrograms(v)) {
    if (p < a || p >= b || taken.has(p - a)) continue;
    const m = matchWithin(inner, slice, p - a, closeIn(p - a));
    if (m) yield record(m, kind, p - a);
  }
  // The positions read in a level, from the first at `a` or later.
  const { decoded } = v;
  let lo = 0;
  let hi = decoded.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (decoded[mid][0] < a) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo; k < decoded.length && decoded[k][0] < b; k++) {
    const [p, L, d, kind] = decoded[k];
    // Each occurrence apart, keyed by its level and its index there (#1646).
    const occurrence = occurrenceOf(p, L, d);
    if (yielded.has(occurrence)) continue;
    inner.lastIndex = d;
    const m = inner.exec(L.text);
    if (!m || m.index !== d || !m[0]) continue;
    const viewOf = (s, e) => [L.at[s] ?? L.to, e > s ? L.end[e - 1] : (L.at[s] ?? L.to)];
    const [at, end] = viewOf(d, d + m[0].length);
    // Where the view reads the same text, the passes above read it as it is;
    // where they matched at this index already, they read one occurrence, and
    // another is judged here unless it is the same command.
    const own = L.text.slice(d, L.ends[d]);
    if (end > b) continue;
    if (readAt.has(p) ? readAt.get(p) === own : text.slice(at, end) === asWritten(text, L, d, d + m[0].length))
      continue;
    yielded.add(occurrence);
    decodedHit(command, re, occurrence);
    const indices = m.indices.map((r) => r && viewOf(r[0], r[1]));
    yield {
      at,
      end,
      indices,
      kind,
      program: p,
      occurrence,
      decoded: L.text.slice(d, L.ends[d]),
      sep: L.text.slice(L.ends[d], L.ends[d] + 2),
      before: levelLead(L, d),
      shell: L.via,
    };
  }
}

/**
 * The command at the view index `p` as the shell of the level it was read in
 * reads it (#1646, {@link found}): `{ text, divergent, sep, L, d }`, its text
 * from its program word to its end there, whether the view's text over the
 * same span differs, the separator that ends it, and the level and index it
 * starts at; `undefined` where no level position starts at `p`. Read once per
 * position and view.
 */
function levelCommand(v, p) {
  if (v.levelCommands?.has(p)) return v.levelCommands.get(p);
  const { decoded } = v;
  let lo = 0;
  let hi = decoded.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (decoded[mid][0] < p) lo = mid + 1;
    else hi = mid;
  }
  let out;
  if (decoded[lo]?.[0] === p) {
    const [, L, d] = decoded[lo];
    const e = Math.max(L.ends[d], d + 1);
    const text = L.text.slice(d, e);
    out = {
      text,
      divergent: v.text.slice(L.at[d], L.end[e - 1]) !== asWritten(v.text, L, d, e),
      sep: L.text.slice(L.ends[d], L.ends[d] + 2),
      L,
      d,
    };
  }
  (v.levelCommands ??= new Map()).set(p, out);
  return out;
}

/**
 * What the shells reading the {@link level} `L` run ahead of its index `d`
 * (#1646, CodeRabbit CLI): its own text before `d`, after that of each level
 * holding it before the word that handed it over, outermost first, each as
 * `{ text, shell }` with the shell that reads it. The typed command's own
 * text is not among them: `root`, a property of the list, is the view index
 * of the word there that hands the outermost string over, for {@link
 * chainCommands} to start from where the typed command's own `cd`s leave it.
 * {@link dirAfter} reads the `cd`s here, so a command a string runs is judged
 * where that string moved to.
 */
function levelLead(L, d) {
  const lines = [];
  let k = d;
  for (let X = L; X.up; k = X.upAt, X = X.up)
    lines.unshift({ text: X.text.slice(0, k), shell: /^(?:pwsh|powershell)$/i.test(X.via ?? "") ? POWERSHELL : BASH });
  lines.root = k;
  return lines;
}

/**
 * The text `[d, e)` of the {@link level} `L`, each expansion an outer shell
 * makes written as the view has it (`$ARGS`, not the `$` standing for it):
 * the raw text holds an expansion as a rule always reads it, so only an
 * escape, a quote or a join that the shell undoes makes the two differ.
 */
function asWritten(viewText, L, d, e) {
  let out = "";
  for (let k = d; k < e; k++)
    if (L.live?.[k] === 1) {
      out += viewText.slice(L.at[k], L.end[k]);
      while (k + 1 < e && L.live[k + 1] === 1 && L.at[k + 1] === L.at[k]) k++;
    } else out += L.text[k];
  return out;
}

/** The decoded hits of each command read lately, by its text ({@link found}); kept small, as a hook process reads a few. */
const DECODED_HITS = new Map();

function decodedHit(command, re, occurrence) {
  if (DECODED_HITS.size > 64) DECODED_HITS.clear();
  if (!DECODED_HITS.has(command)) DECODED_HITS.set(command, new Set());
  DECODED_HITS.get(command).add(`${re.source}@${occurrence}`);
}

/**
 * Which occurrence of a command a match is ({@link found}): the view index
 * `p` of its program word, and for one read in a string's {@link level} that
 * level and the index there (#1646). A match's `occurrence`; the key of its
 * decoded hit.
 */
function occurrenceOf(p, L, d) {
  return L.id === undefined ? String(p) : `${p}@${L.id}:${d}`;
}

/**
 * Drops the decoded hit of `re` at the match `occurrence` in `command` ({@link found}):
 * for a consumer that judged that command as its shell reads it — from the
 * match's `decoded`, or through a reader of the whole string, as the deck-host
 * ask's `wrapperRuns` reads a wrapper's string (#1646).
 */
export function excuseDecodedHit(command, re, occurrence) {
  DECODED_HITS.get(command)?.delete(`${re.source}@${occurrence}`);
}

/**
 * The matches {@link found} has made, since the last call, which clears
 * them, of a command its shell reads differently from the text of
 * `command`, each as `<shape>@<program>` (#1646): a rule reading its
 * arguments from that raw text reads them mis-sliced, so `checkBash` never
 * lets a rule pass on one it did not excuse ({@link excuseDecodedHit}).
 */
export function takeDecodedHits(command) {
  const hits = DECODED_HITS.get(command) ?? new Set();
  DECODED_HITS.delete(command);
  return hits;
}

/**
 * The program positions of a view ({@link programKind}): every program word
 * by where its name starts, with how it is the program, then every position
 * {@link fedStarts} recorded whose word is no program word.
 */
function* knownPrograms({ byName, loneStarts }) {
  yield* byName;
  yield* loneStarts;
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
 * newline is found too (#1634 review). A position `known` names as a
 * program's (where {@link view} read one) is preferred over an earlier one the
 * shape also fits: a greedy shape fits from the `gh` of an `X=gh` lead too
 * (`X=gh gh pr comment 5 --body @-`), and that position is no program, so the
 * known-program pass would yield the same command a second time (CodeRabbit
 * CLI on #1634). Never a separator: were the shape not found, the match's
 * first character that is none.
 */
function innerStart(text, m, re, known = () => false) {
  if (!re.inner) return m.index;
  const end = m.index + m[0].length;
  const sticky = compiled(re.inner, re, "y");
  const fits = (p) => {
    sticky.lastIndex = p;
    const r = sticky.exec(text);
    return !!r && p + r[0].length === end;
  };
  for (let p = m.index; p < end; p++) if (known(p) && fits(p)) return p;
  for (let p = m.index; p < end; p++) if (fits(p)) return p;
  return m.index + /^[\s|;()\x60&]*/.exec(m[0])[0].length;
}

/** A {@link matchesAt} result: the groups read from the raw command, with the match's facts. */
function rawMatch(command, { at, indices, kind, program, occurrence, decoded, sep, before, shell }) {
  const raw = indices.map((r) => r && command.slice(r[0], r[1]));
  raw.index = at;
  raw.program = program;
  raw.occurrence = occurrence;
  if (decoded !== undefined) raw.decoded = decoded;
  if (sep !== undefined) raw.sep = sep;
  if (before !== undefined) raw.before = before;
  if (shell !== undefined) raw.shell = shell;
  raw.how = kind.how;
  if (kind.via) raw.via = kind.via;
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

/** A command that moves the directory, at the start of a chain segment: its name is group 1 ({@link dirAfter}). */
const DIR_CHANGE = /^\s*(?:\w+=\S*\s+)*(cd|pushd|popd|chdir|sl|set-location|push-location|pop-location)(?=\s|$)/i;
/**
 * Such a command behind a paren, a brace, a `!` or a keyword that opens a
 * compound command: whether, and for how long, it moves what follows is the
 * compound's to say ({@link dirAfter}).
 */
const NESTED_DIR_CHANGE =
  /^\s*(?:(?:[({!]|then|else|elif|do|if|while|until|time)\s*)+(?:\w+=\S*\s+)*(?:cd|pushd|popd|chdir|sl|set-location|push-location|pop-location)(?=\s|$)/i;

/**
 * What each `cd` among the chain segments of `text` does to the directory of
 * the shell reading `text` (#1646, CodeRabbit on PR #1788): `{ ranges, seps,
 * steps }`, `seps[k]` the separator after segment `k` (`;`, `&&`, `||`, `|`,
 * a newline) and `steps[k]` `null` for a segment that moves nothing, or `{
 * kind, to }`:
 *
 * - `"move"`: it runs, and moves the shell to `to`.
 * - `"cond"`: it runs only as the command before it fared (after `&&` or
 *   `||`), so it moves only a command reached from it through `&&` alone.
 * - `"final"`: the final stage of a pipeline, which bash runs in the shell
 *   itself only under `lastpipe` without job control, neither of which the
 *   hook can see (a profile or `BASH_ENV` may set them; a `shopt` in the
 *   command may come after the pipeline), so the directory is unknown after it.
 * - `"lost"`: one whose directory cannot be known — it expands (`cd "$X"`),
 *   steps through history (`cd -`), has no directory or has options, is a
 *   `popd`, sits inside a compound command whose extent the segment does not
 *   show (`{ cd x; …`, `then cd x`) — `strict` only, else read as the hook
 *   always read the typed command's own (`cd -` moves nothing, an expansion
 *   is a name).
 *
 * A `cd` in a pipeline stage before the last runs in a subshell under any
 * option, one in parentheses closed in its own segment (`(cd x)`) moves
 * nothing, and one inside a string a child shell runs (`bash -c 'cd x; …'`,
 * `… | bash`) moves only that child: none is a step.
 */
function cdSteps(text, shell, strict) {
  const v = view(text);
  const masked = v.text;
  const rs = ranges(masked, CHAIN);
  const seps = rs.map(([, b], k) => (k + 1 < rs.length ? masked.slice(b, rs[k + 1][0]) : undefined));
  const steps = rs.map(([a, b], k) => {
    const segment = masked.slice(a, b);
    const name = DIR_CHANGE.exec(segment)?.[1]?.toLowerCase();
    if (!name) {
      if (!strict || !NESTED_DIR_CHANGE.test(segment)) return null;
      // A subshell closed in its own segment moves nothing; any other compound is unknown.
      const opens = (segment.match(/\(/g) ?? []).length;
      if (/^\s*\(/.test(segment) && opens > 0 && opens === (segment.match(/\)/g) ?? []).length) return null;
      return { kind: "lost" };
    }
    if (shell !== POWERSHELL && !/^(?:cd|pushd|popd)$/.test(name)) return null;
    if (!strict && !/^(?:cd|chdir|sl|set-location)$/.test(name)) return null;
    // Inside a string a shell is handed: a child's own (a string `eval` runs in
    // this shell is refused, never read, #1659).
    if (stringAround(v, a + segment.search(/\S/))) return null;
    if (seps[k] === "|") return null;
    const to = /^(?:pushd|push-location)$/.test(name)
      ? argIn(text, masked, a, b, PUSHD_RE)
      : /^pop/.test(name)
        ? undefined
        : argIn(text, masked, a, b, cdRe(shell));
    if (strict ? !to || HISTORY_DIR.has(to) || /[$\x60~*?[]/.test(to) : !to) return strict ? { kind: "lost" } : null;
    if (!strict && HISTORY_DIR.has(to)) return null;
    const before = k > 0 ? seps[k - 1] : undefined;
    const kind = before === "|" ? "final" : before === "&&" || before === "||" ? "cond" : "move";
    return { kind, to };
  });
  return { ranges: rs, seps, steps };
}

/**
 * The directory a shell starting in `base` is in at segment `upTo` of `text`
 * ({@link cdSteps}, every segment before it), or `undefined` where it cannot
 * be known: a `"lost"` or `"final"` step, or a
 * `"cond"` one not followed by `&&` alone up to `upTo` — so `false && cd x;
 * pnpm …` is unknown, and `cd x && pnpm …` and `true && cd x && pnpm …` run
 * in `x`. A `"move"` is read by the outcome that reaches `upTo` within its
 * and-or list ({@link cdOutcome}): its directory after success, the one before
 * it after failure (`cd x || pnpm …` runs where it was), unknown where either
 * can (`cd x && a || pnpm …`); past the list's end it is taken to have run, as
 * a typed `cd x; …` always was. `loose` follows every step that names a
 * directory and skips the rest, never `undefined`: the fallback a lost
 * command keeps.
 */
function dirThrough({ seps, steps }, upTo, base, shell, loose = false) {
  let dir = base;
  for (let k = 0; k < upTo; k++) {
    const step = steps[k];
    if (!step || (loose && step.kind === "lost")) continue;
    if (loose) {
      dir = resolveDir(dir, step.to, { shell });
      continue;
    }
    if (step.kind === "lost" || step.kind === "final") return undefined;
    if (step.kind === "cond" && !seps.slice(k, upTo).every((s) => s === "&&")) return undefined;
    if (step.kind === "move") {
      const outcome = cdOutcome(seps, k, upTo);
      if (outcome === "both") return undefined;
      if (outcome === "failure") continue;
    }
    dir = resolveDir(dir, step.to, { shell });
  }
  return dir;
}

/**
 * Which outcome of the command at segment `k` lets segment `upTo` run, along
 * the separators `seps` between them (#1646, CodeRabbit on PR #1788):
 * `"success"`, `"failure"`, `"both"`, or `"after"` where a separator other
 * than `&&` or `||` ends its and-or list first, so `upTo` runs whatever it did.
 * Each outcome is followed through the list as bash runs it: `&&` runs the
 * next command after a success, `||` after a failure, and a command that runs
 * may itself succeed or fail.
 */
function cdOutcome(seps, k, upTo) {
  const reach = (ok) => {
    let can = new Set([ok]);
    let runs = true;
    for (let i = k; i < upTo; i++) {
      const sep = seps[i];
      const on = sep === "&&";
      runs = can.has(on);
      // A command that runs may end either way; one skipped leaves the status as it was.
      const next = new Set(runs ? [true, false] : []);
      if (can.has(!on)) next.add(!on);
      can = next;
    }
    return runs;
  };
  if (seps.slice(k, upTo).some((s) => s !== "&&" && s !== "||")) return "after";
  const success = reach(true);
  const failure = reach(false);
  return success && failure ? "both" : failure ? "failure" : "success";
}

/** `pushd <dir>` and PowerShell's `Push-Location`, as {@link CD_RE} reads a `cd`. */
const PUSHD_RE = new RegExp(
  String.raw`^\s*(?:\w+=\S*\s+)*(?:pushd|push-location)(?:\s+-(?:path|literalpath))?\s+${QUOTED_ARG}\s*$`,
  "di",
);

/**
 * Where the lines `lines` ({@link levelLead}: `{ text, shell }`, the text a
 * string's shell runs ahead of a command) leave a shell that starts in `base`
 * (#1646, CodeRabbit CLI): each line's `cd`, `pushd` or `Set-Location` steps
 * read strictly ({@link cdSteps}), through the line's end, where the next
 * line's string or the command itself is handed over ({@link dirThrough}).
 * `undefined` where the directory cannot be known, so the caller judges the
 * command lost rather than in the wrong tree.
 */
export function dirAfter(lines, base) {
  let dir = base;
  for (const { text, shell } of lines) {
    if (!/(?:cd|pushd|popd|chdir|sl|location)\b/i.test(text)) continue;
    const steps = cdSteps(text, shell, true);
    // Through the last segment, which holds the word handing the next string over, or the command.
    dir = dirThrough(steps, steps.ranges.length - 1, dir, shell);
    if (dir === undefined) return undefined;
  }
  return dir;
}

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
 * first git command of the whole command is read. Where a `cd` ahead of it
 * leaves its directory unknown ({@link cwdAt}), `lost` is set, and so are
 * `movesRepo` and `movesTree`, as for anything that hides which repository it
 * acts on; `dir` is then the fallback with every `cd` that names a directory
 * followed (#1646).
 */
export function gitPlace(command, cwd, re, shell = BASH) {
  const text = trustedMask(command);
  const segs = ranges(text, CHAIN).filter(([a, b]) => command.slice(a, b).trim());
  // The first command the rule finds ({@link matchesAt}: at command position,
  // or the first word a shell or a wrapper runs, #1634), and its segment.
  const m = re ? matchAt(command, re) : null;
  const at = m ? segs.findIndex(([a, b]) => a <= m.program && m.program < b) : -1;
  const index = at >= 0 ? segs[at][0] : command.length;
  const base = cwdAt(command, cwd, index, shell);
  const [a, b] = at >= 0 ? segs[at] : [0, command.length];
  if (base !== undefined) return gitPlaceAt(command, m ? m.program : a, base, shell, b);
  const fallback = typedDirAt(command, cwd, shell, true)(index);
  return {
    ...gitPlaceAt(command, m ? m.program : a, fallback, shell, b),
    movesRepo: true,
    movesTree: true,
    lost: true,
  };
}

/**
 * The session cwd moved by every `cd <dir>` in the chain segments that end
 * before `index` ({@link gitCwd}'s walk, split and read as it is): where the
 * command starting at `index` runs, or `undefined` where a `cd` ahead of it
 * leaves that unknown ({@link typedDirAt}). The post-hook reads a merge's PR
 * back there, at the merge `firstMerge` found rather than the first mention
 * (#1607).
 */
export function cwdAt(command, cwd, index, shell = BASH) {
  return typedDirAt(command, cwd, shell)(index);
}

/**
 * For the typed command, a function from a view index to the directory its
 * shell is in there — every `cd` that runs in that shell, in the segments
 * ending before it, followed ({@link cdSteps}, read as the typed command's
 * always were; {@link dirThrough}) — or `undefined` where one leaves it
 * unknown (#1646, CodeRabbit on PR #1788). A `cd` inside a string a child
 * shell runs moves only that child, so `bash -c 'true; cd ../x; true'; pnpm
 * …` runs `pnpm` where it started.
 */
function typedDirAt(command, cwd, shell, loose = false) {
  const steps = cdSteps(command, shell, false);
  return (index) => {
    let upTo = 0;
    while (upTo < steps.ranges.length && steps.ranges[upTo][1] <= index) upTo++;
    return dirThrough(steps, upTo, cwd, shell, loose);
  };
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
 * with `how` and `via` saying so, and a command inside a string a
 * shell is handed ends at that string's close ({@link stringEnd}): the `args`
 * of `bash -c 'git push origin x'` are ` origin x`, not ` origin x'`.
 */
export function* chainCommands(command, cwd, re, shell = BASH) {
  const text = trustedMask(command);
  const v = view(command);
  // The directory the typed command's own `cd`s leave at a view index, and
  // that one with every conditional or final-stage `cd` followed and an
  // unknowable one skipped, which a command whose directory is lost keeps as
  // its `base` for the rules that read no `lost`.
  const dirAt = typedDirAt(command, cwd, shell);
  const looseAt = typedDirAt(command, cwd, shell, true);
  for (const [a, b] of ranges(text, CHAIN)) {
    for (const f of [...found(command, re, a, b)].sort((x, y) => x.program - y.program)) {
      // A command a string runs runs where the `cd`s ahead of it in that
      // string moved (#1646, CodeRabbit CLI): `bash -c 'cd ../ir-x; pnpm
      // dev:voices'`. They start from
      // where the typed command's own leave the word handing the string over,
      // never from a `cd` the chain ranges read inside that string.
      const root = f.before?.length ? f.before.root : a;
      const outer = dirAt(root);
      const lead = outer !== undefined && f.before?.length ? dirAfter(f.before, outer) : outer;
      const base = looseAt(root);
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
        base: lead ?? base,
        start,
        head: command.slice(start, from),
        args: command.slice(from, to),
        at: from,
        cut,
        how: f.kind.how,
        program: f.program,
        occurrence: f.occurrence,
        ...(lead === undefined ? { lost: true } : {}),
        ...(f.decoded !== undefined ? { decoded: f.decoded } : {}),
        ...(f.kind.via ? { via: f.kind.via } : {}),
        ...(f.kind.attached ? { attached: true } : {}),
      };
    }
  }
}

/** Splits a command into rough words, respecting simple quotes. A value glued to its quote (`--x="a b"`) needs {@link shellWords}. */
export function words(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/**
 * The words of one command segment, `{ word, shape }` each: with a trusted mask
 * the `flat` text's words, each with its raw text, so a quoted value is one word
 * however many separators or flags it carries; without one the raw segment split
 * by `words` in `shell-lexer.mjs`, every word its own shape. Shared by {@link parseMerge} and
 * {@link parseIssueEdit}.
 */
export function segmentTokens({ raw, flat, trusted }) {
  return trusted
    ? [...flat.matchAll(/\S+/g)].map((m) => ({ word: raw.slice(m.index, m.index + m[0].length), shape: m[0] }))
    : words(raw).map((w) => ({ word: w, shape: w }));
}

/** Whether a {@link segmentTokens} word is a plain literal: its raw text is its flat shape. */
export const literal = (t) => t !== undefined && t.word === t.shape;

/**
 * A word's value when the hook can know it: a plain literal, or one in quotes
 * that expand nothing; `null` for anything else, a missing word included. The
 * mask leaves a bare `$REPO` as it is, so a `$` is refused here.
 */
export function plainValue(t) {
  if (t === undefined || /[$`]/.test(t.word)) return null;
  if (literal(t)) return t.word;
  const quoted = /^'([^']*)'$/.exec(t.word) ?? /^"([^"$`\\]*)"$/.exec(t.word);
  return quoted ? quoted[1] : null;
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
 * assignment or a redirection, as a regex fragment; `open` opens the group
 * around each wrapper's name. {@link leadStep} reads the same tokens with the
 * one word reader, which every program position comes from (#1646).
 */
function leadToken(open) {
  // A wrapper option's value: quoted runs and escapes read whole, any other
  // character but a blank, a quote, `;`, `&`, `|`, `<` or `>` plain — so the
  // value pattern, repeated for three wrappers, stays short (#1646).
  const value = String.raw`(?!-)(?:[^\s"'\\;&|<>]|"(?:[^"\\]|\\[\s\S])*"|'[^']*'|\\[\s\S])+`;
  return String.raw`(?:(?:if|then|do|else|elif|while|until|!|\{)\s+|${open}time|command|exec|env|nohup)(?:\s+(?:-[uCSa]|--unset|--chdir|--split-string)\s+${value}|\s+-\S+)*\s+|${open}timeout)(?:\s+(?:-[ks]|--kill-after|--signal)\s+${value}|\s+-\S+)*\s+\d[\d.]*[smhd]?\s+|${open}xargs)(?:\s+-[IdEeLnPs]\s+${value}|\s+-\S+)*\s+|[A-Za-z_]\w*(?:\[[^\]\s]*\])?\+?=${ANGLED_PIECE}*\s+|\d*(?:<<<|[<>]&|&>>?|>>|>\||<>|<|>)\s*${WORD_PIECE}+\s+)`;
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
 * operator character, so each redirection has one parse too. A target and
 * an assignment's value are read in {@link WORD_PIECE}s, as bash reads a
 * word, and an option's value with its quotes and escapes whole, so a quoted
 * blank or `;` stays inside it (#1646).
 * A value never starts with `-`, so every token has exactly one parse: were a
 * `-u` free to take the next `-u` as its value, a long run of them on a
 * command that does not match backtracks exponentially, and regex time is not
 * bounded by the hook's spawn deadline.
 *
 * A heuristic, not a shell parser: the hooks catch mistakes, not deliberate
 * obfuscation. A string handed to a shell (`bash -c`, `eval`) is not lexed —
 * the rules read the raw text of the list element that hands it over then
 * ({@link view}, #1607), and its commands, past a lead of these tokens, are
 * read in the text that shell reads ({@link fedStarts}, #1634, #1646).
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
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    const piece = quotedPiece(text, i);
    if (piece) {
      add(piece[0]);
      i = piece[1] - 1;
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
 * The quoted or escaped piece of a bash word that starts at `i` in `text` — a
 * `\` escape, `'…'`, `$'…'` or `"…"` — as `[decoded, indexAfter]`, read to the
 * end of `text` when its closing quote is missing; `undefined` when no piece
 * starts at `i`. {@link commandWords} and {@link wordText} share it, so a
 * word reads the same whether it is split out of a command or decoded whole.
 */
function quotedPiece(text, i) {
  const ch = text[i];
  if (ch === "\\") return [text[i + 1] === "\n" ? "" : (text[i + 1] ?? ""), Math.min(i + 2, text.length)];
  if (ch === "'") {
    const end = text.indexOf("'", i + 1);
    return end < 0 ? [text.slice(i + 1), text.length] : [text.slice(i + 1, end), end + 1];
  }
  if (ch === "$" && text[i + 1] === "'") {
    let k = i + 2;
    let s = "";
    // Every ANSI-C escape decoded as bash decodes it (`\x20`, `\047`, `\cA`),
    // so a `$'cd\x20../x; …'` a wrapper runs is read as the line it is (#1646).
    while (k < text.length && text[k] !== "'")
      if (text[k] === "\\") {
        const [c, next] = ansiEscape(text, k + 1);
        s += c;
        k = next;
      } else s += text[k++];
    return [s, Math.min(k + 1, text.length)];
  }
  if (ch === '"') {
    let k = i + 1;
    let s = "";
    for (; k < text.length && text[k] !== '"'; k++)
      if (text[k] === "\\" && '"\\$`\n'.includes(text[k + 1] ?? "x")) s += text[++k] === "\n" ? "" : text[k];
      else s += text[k];
    return [s, Math.min(k + 1, text.length)];
  }
  return undefined;
}

/**
 * One word of a command ({@link commandWordsRaw}), decoded whole as bash reads
 * it: quotes removed, `\` escapes applied, `$'…'` decoded — and nothing else
 * read, so a `;`, `&&`, `|` or newline the quotes held is data of the word,
 * as it is to the shell that word is handed to. {@link commandWords} splits
 * where this does not (#1634, CodeRabbit CLI round 5): decoding a shell
 * wrapper's string with it ended the string at its first operator, and judged
 * `sh -c 'cd ../x && pnpm dev:voices'` as `cd ../x` alone.
 */
export function wordText(word) {
  let out = "";
  for (let i = 0; i < word.length;) {
    const piece = quotedPiece(word, i);
    if (piece) {
      out += piece[0];
      i = piece[1];
    } else out += word[i++];
  }
  return out;
}

/**
 * The words of the command whose arguments start at `from` in `text`, as
 * {@link readCommand} wants them: quotes and escapes kept, each word whole
 * ({@link COMMAND_WORD}), up to an unquoted `;`, `&`, `|`, paren, backtick or
 * newline, or to `limit` — the close of the string the command is itself
 * inside, so the words of a command found in one never run past it. The
 * deck-host ask reads every runner's words with this and decodes each whole
 * ({@link wordText}), its quoted strings included: {@link chainCommands}'
 * `args` end where the lexer's chain does, which inside a string a shell is
 * fed is the string's own first `&&` (#1607), while the string is one word to
 * the runner that hands it on. `wrapperRuns` decodes a word only once the
 * walk has chosen it, so an attached `-c"…"` is still seen as one, where
 * {@link commandWords} would have handed over `-c…` with its quotes gone
 * (#1634, CodeRabbit CLI round 4).
 */
export function commandWordsRaw(text, from, limit = text.length) {
  const out = [];
  const within = text.slice(0, limit);
  COMMAND_WORD.lastIndex = from;
  for (let m; (m = COMMAND_WORD.exec(within));) out.push(m[1]);
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
