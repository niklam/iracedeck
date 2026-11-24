import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as lexer from "./shell-lexer.mjs";
import {
  cmd,
  gitCwd,
  maskInert,
  POWERSHELL,
  powershellAsBash,
  resolveDir,
  shellWords,
  trustedMask,
  view,
  words,
} from "./shell-lexer.mjs";

// Built through `path`, not written as Windows literals: CI runs on Linux, where
// `C:\repo\master` is a RELATIVE path and every resolve lands under the runner's cwd.
const REPO = path.resolve("/repo");
const MASTER = path.join(REPO, "master");
const tree = (...parts) => path.join(REPO, ...parts);

/**
 * Asserts the command `make(n)` is read in time linear in `n`: `read` (by
 * default `has` with `re`) is timed over a fresh view (the view memoises the
 * last command) at `n` and at `2n`, three runs each, interleaved, and the
 * fastest run at `2n` may take at most three times the fastest at `n`, plus
 * 25 ms. Self-relative, so it holds on a loaded machine and on CI's runners
 * as it does idle — an absolute bound did not (#1634 review) — while a
 * quadratic pass takes four times as long, which fails once the run at `n`
 * is past 25 ms (the sizes the callers pick put each pass's known quadratic
 * well past it), and an exponential one thousands of times.
 *
 * A failed comparison takes three more runs at each size, up to `ATTEMPTS`
 * rounds in all, and compares the fastest of every run so far. Load only ever
 * slows a run, so a busy machine can push one round past the bound (87 ms
 * against 84.9 ms in a full `pnpm test`, #1647); more runs can only lower
 * each fastest time, and the one at `n` is what sets the bound, so a slowed
 * round can never loosen it, while a super-linear read stays over it. Returns
 * the two timings.
 */
function readsLinearly(make, n, re, found, read = (c) => lexer.has(c, re)) {
  const time = (size) => {
    const command = make(size);
    lexer.view.last = undefined;
    maskInert.last = undefined;
    const started = performance.now();
    expect(read(command), command.slice(0, 40)).toBe(found);
    return performance.now() - started;
  };
  const runs = [[], []];
  const fastest = () => runs.map((r) => Math.min(...r));
  let rounds = 0;
  do {
    for (let k = 0; k < 3; k++) {
      runs[0].push(time(n));
      runs[1].push(time(2 * n));
    }
    rounds++;
  } while (rounds < ATTEMPTS && fastest()[1] > 3 * fastest()[0] + 25);
  const [t1, t2] = fastest();
  const label = `${make(1).slice(0, 40)}: ${t1.toFixed(1)} ms at ${n}, ${t2.toFixed(1)} ms at ${2 * n}, fastest of ${3 * rounds} runs each`;
  expect(t2, label).toBeLessThanOrEqual(3 * t1 + 25);
  return [t1, t2];
}

/** How many rounds of three runs per size `readsLinearly` takes before a comparison over its bound fails. */
const ATTEMPTS = 3;

/**
 * The timeout of an `it` made of `readsLinearly` cases. Each such `it` took 0.4
 * to 1.5 s in a full `pnpm test`, one round per case; a loaded run can take
 * every case to `ATTEMPTS` rounds, so up to three times that, past vitest's 5 s
 * default (#1647). About four times that worst case, so only a hang fails.
 */
const TIMING_TIMEOUT_MS = 20_000;

describe("helpers", () => {
  it("gitCwd honours -C", () => {
    expect(gitCwd("git -C ../ir-5 status", MASTER)).toBe(tree("ir-5"));
    expect(gitCwd("git status", MASTER)).toBe(MASTER);
  });
  it("gitCwd scopes -C to the segment the rule matched, not to a later chained git", () => {
    const add = cmd(/git\s+(?:-C\s+\S+\s+)?worktree\s+add\b/);
    expect(gitCwd("git worktree add ../ir-5 -b ir-5 && git -C ../ir-5 log -1", MASTER, add)).toBe(MASTER);
    expect(gitCwd("git fetch origin; git -C ../ir-5 worktree add ../ir-6", MASTER, add)).toBe(tree("ir-5"));
    const status = cmd(/git\s+(?:-C\s+\S+\s+)?status\b/);
    expect(gitCwd("git -C ../ir-5 status | cat", MASTER, status)).toBe(tree("ir-5"));
  });
  it("gitCwd walks the `cd`s chained ahead of the matched command", () => {
    const status = cmd(/git\s+(?:-C\s+\S+\s+)?status\b/);
    expect(gitCwd("cd ../ir-5 && git status", MASTER, status)).toBe(tree("ir-5"));
    expect(gitCwd(`cd "${tree("ir-5")}" && git status`, MASTER, status)).toBe(tree("ir-5"));
    expect(gitCwd("cd ../ir-5 && cd ../ir-6 && git status", MASTER, status)).toBe(tree("ir-6"));
    expect(gitCwd("cd ../ir-5 && git -C ../ir-6 status", MASTER, status)).toBe(tree("ir-6"));
    expect(gitCwd("git status && cd ../ir-5", MASTER, status)).toBe(MASTER); // a later cd moves nothing
    expect(gitCwd("cd - && git status", MASTER, status)).toBe(MASTER); // unknowable, stays put
  });

  it("words respects quotes", () => {
    expect(words(`a "b c" 'd e' f`)).toEqual(["a", "b c", "d e", "f"]);
  });

  // #1526 second read: a backslash the shell removes left a word the deck rule
  // compared unescaped, so `--re\start` passed for `--restart`.
  it.each([
    ["re\\start:x", ["restart:x"]],
    ["a\\ b c", ["a b", "c"]],
    ["a\\", ["a\\"]],
    [`"a\\b"`, ["a\\b"]],
    [`"a\\"b" c`, [`a"b`, "c"]],
    [`"\\$x\\\\"`, ["$x\\"]],
    ["'a\\b'", ["a\\b"]],
    [`--x="a\\"b c"`, [`--x=a"b c`]],
    [`'a'"b"\\c`, ["abc"]],
  ])("shellWords applies backslash escapes as bash does: %s", (line, out) => expect(shellWords(line)).toEqual(out));

  // #1526 second read: a PowerShell backtick escape of an ordinary character is
  // that character; it used to become two inert `_`, so ``re`start`` hid `restart`.
  it.each([
    ["pnpm re`start:x", "pnpm re\\start:x"],
    ["`-`-restart", "\\-\\-restart"],
    ["--`restart", "--__estart"], // `r is a carriage return
    ["a`-b", "a\\-b"],
    ["a`nb", "a__b"],
    ["--res`tart", "--res__art"],
    ['"a`"b"', '"a__b"'],
    ["a`;b", "a__b"],
    ["a` b", "a__b"],
    ["C:\\x", "C:/x"],
  ])("powershellAsBash keeps the length and reads a plain escape as its character: %s", (ps, out) => {
    expect(powershellAsBash(ps)).toBe(out);
    expect(powershellAsBash(ps)).toHaveLength(ps.length);
  });
});

// #1520: Git Bash spells a drive `/c/…` and hands native programs `C:/…`, while
// `path.resolve` reads `/c/…` as a folder `c` at the root of the current drive.
// That put `cd /c/…/master && pnpm build` in a `C:\c\…` no deck link points into.
describe("resolveDir: a Git Bash drive path names its drive", () => {
  const BASE = "C:\\repo\\master";
  const win = { platform: "win32" };
  it("maps /c/…, /C/…, a bare /d and /cygdrive/c/… on Windows", () => {
    expect(resolveDir(BASE, "/c/Users/x", win)).toBe("C:\\Users\\x");
    expect(resolveDir(BASE, "/C/Users/x/", win)).toBe("C:\\Users\\x");
    expect(resolveDir(BASE, "/d", win)).toBe("D:\\");
    expect(resolveDir(BASE, "/cygdrive/c/Users/x", win)).toBe("C:\\Users\\x");
    expect(resolveDir(BASE, "/cygdrive/d", win)).toBe("D:\\");
  });
  it("leaves every other spelling to path.resolve", () => {
    expect(resolveDir(BASE, "../ir-5", win)).toBe("C:\\repo\\ir-5");
    expect(resolveDir(BASE, "C:/Users/x", win)).toBe("C:\\Users\\x");
    expect(resolveDir(BASE, "D:\\x", win)).toBe("D:\\x");
    // Not a drive: a longer first segment, or a letter that does not end it.
    expect(resolveDir(BASE, "/cc/x", win)).toBe("C:\\cc\\x");
    expect(resolveDir(BASE, "/c-x/y", win)).toBe("C:\\c-x\\y");
    expect(resolveDir(BASE, "/cygdrive/cc", win)).toBe("C:\\cygdrive\\cc");
  });
  it("reads /c/… as PowerShell does there: a folder at the root of the drive", () =>
    expect(resolveDir(BASE, "/c/Users/x", { ...win, shell: POWERSHELL })).toBe("C:\\c\\Users\\x"));
  it("off Windows /c is a real directory", () => {
    expect(resolveDir("/repo/master", "/c/Users/x", { platform: "linux" })).toBe("/c/Users/x");
    expect(resolveDir("/repo/master", "../ir-5", { platform: "linux" })).toBe("/repo/ir-5");
  });
  // Positive control: the plain resolve every guard used to call lands elsewhere.
  it("is needed: path.win32.resolve misreads the same path", () =>
    expect(path.win32.resolve(BASE, "/c/Users/x")).toBe("C:\\c\\Users\\x"));
});

// The guards resolve with the real platform, so these run where Git Bash does.
// Off Windows the resolver's own tests above are the coverage.
describe.runIf(process.platform === "win32")("every guard reads a Git Bash drive path (#1520)", () => {
  /** `C:\repo\x` spelled as Git Bash spells it: `/c/repo/x`. */
  const gitBash = (p) => p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
  const IR5 = tree("ir-5");

  it("gitCwd follows a cd and a git -C spelled the Git Bash way", () => {
    const status = cmd(/git\s+(?:-C\s+\S+\s+)?status\b/);
    expect(gitCwd(`cd ${gitBash(IR5)} && git status`, MASTER, status)).toBe(IR5);
    expect(gitCwd(`git -C ${gitBash(IR5)} status`, MASTER, status)).toBe(IR5);
    expect(gitCwd(`cd /cygdrive/${gitBash(IR5).slice(1)} && git status`, MASTER, status)).toBe(IR5);
  });
});

describe("a mention is not a command (#1321)", () => {
  it("masks inert text without moving anything", () => {
    const command = `grep -n 'a | b' f && echo "x; $(date) y" # tail`;
    const { masked, flat, sure } = maskInert(command);
    expect(sure).toBe(true);
    expect(masked).toBe(`grep -n '_____' f && echo "___$(date)__" ______`);
    expect(flat).toBe(`grep -n _______ f && echo ______________ ______`);
  });

  it("masks a quoted-delimiter heredoc body whole, and keeps an unquoted one's substitutions", () => {
    expect(maskInert("cat <<'EOF'\nrun $(x)\nEOF\nls").masked).toBe("cat <<'EOF'\n_________EOF\nls");
    expect(maskInert("cat <<EOF\nrun $(x)\nEOF\nls").masked).toBe("cat <<EOF\n____$(x)_EOF\nls");
    expect(maskInert("cat <<-EOF\n\tbody\n\tEOF\nls").masked).toBe("cat <<-EOF\n______\tEOF\nls");
  });

  it("splits a chain where the shell splits it, not at a separator inside quotes", () => {
    const status = cmd(/git\s+status\b/);
    expect(gitCwd(`echo 'a; cd ../ir-9' && git status`, MASTER, status)).toBe(MASTER);
    expect(gitCwd(`echo 'a;b' && cd ../ir-5 && git status`, MASTER, status)).toBe(tree("ir-5"));
  });
});

describe("the mask fails closed (#1321 review)", () => {
  describe("the lexer is trusted only when it is sure", () => {
    it("reports an unterminated or impossible construct as unsure", () => {
      for (const command of [
        `echo 'open`,
        `echo "open`,
        `echo $(open`,
        "echo `open",
        "echo ${open",
        `echo $((1 + 2)`,
        `cat <<EOF\nno terminator`,
        `x=$(cat <<'EOF'\nbody\nEOF)\nls`,
        `cat <<EOF`,
        `cat << ;`,
        `case x in x) ls ;; esac`,
        `echo )`,
      ])
        expect(maskInert(command).sure, command).toBe(false);
    });

    it("lexes here-strings, arithmetic, ANSI-C quotes, odd delimiters and parameter words as bash does", () => {
      for (const command of [
        `grep -q OPEN <<< "$(gh pr view 7)"\nls`,
        `echo $((1<<4))\nls`,
        `(( x = 1 << 3 ))\nls`,
        `echo $'it\\'s'`,
        `cat <<E'OF'\nbody\nEOF\nls`,
        `cat <<"E"OF\nbody\nEOF\nls`,
        `cat <<@END\nbody\n@END\nls`,
        `cat <<END+\nbody\nEND+\nls`,
        "echo ${x:- #y}",
        `x="$(echo ")")"`,
        `git commit -m "$(cat <<'EOF'\nfix: x\n\n1) the 12" record\nEOF\n)"`,
        "echo `echo a # c` b",
      ])
        expect(maskInert(command).sure, command).toBe(true);
      expect(maskInert("echo ${x:- #y} && ls").masked).toBe("echo ${x:- #y} && ls");
      expect(maskInert("ls;# don't\nls").masked).toBe("ls;_______\nls");
      expect(maskInert("echo `echo a # c` b").masked).toBe("echo `echo a ___` b");
      expect(maskInert(`cat <<E'OF'\ngh pr merge\nEOF`).masked).toBe(`cat <<E'OF'\n____________EOF`);
    });

    it("reads the raw command when a string or stdin is handed to a shell", () => {
      for (const command of [
        `bash -c 'gh pr merge 7'`,
        `sh -c "x"`,
        `eval "x"`,
        `bash <<'EOF'\nx\nEOF`,
        `timeout 9 bash -c 'x'`,
        `ls | xargs sh -c 'x'`,
        `trap 'x' EXIT`,
      ]) {
        // Raw, up to the program words, which are read in any case (#1606):
        // the line a heredoc delimiter stands on is a line start to the raw text.
        expect(view(command).trusted, command).toBe(false);
        expect(trustedMask(command).toLowerCase(), command).toBe(command.toLowerCase());
      }
      expect(trustedMask(`python - <<'EOF'\nx\nEOF`)).toBe(`python - <<'EOF'\n__EOF`);
    });
  });
});

// #1606: every rule names a program in its bare spelling, so the lexer rewrites
// the word at command position to that spelling, at the same length.
describe("the program word is read as the program it runs (#1606)", () => {
  const pad = (raw, name) => name.padStart(raw.length);
  it.each([
    ["gh.exe", "gh"],
    ["GH.EXE", "gh"],
    ["Gh.Cmd", "gh"],
    ["/usr/bin/gh", "gh"],
    ["./gh", "gh"],
    [`"C:/Program Files/GitHub CLI/gh.exe"`, "gh"],
    [`"gh"`, "gh"],
    ["'gh'", "gh"],
    [`g"h"`, "gh"],
    ["g\\h", "gh"],
    ["$'gh'", "gh"],
    ["git.exe", "git"],
    ["/mingw64/bin/git", "git"],
    ["pnpm.cmd", "pnpm"],
    ["node_modules/.bin/turbo.ps1", "turbo"],
    ["$HOME/bin/gh", "gh"],
  ])("rewrites %s to %s, right-aligned in its own span", (raw, name) => {
    const command = `${raw} pr merge 7`;
    const { text, flat } = view(command);
    expect(text).toBe(`${pad(raw, name)} pr merge 7`);
    expect(flat).toBe(`${pad(raw, name)} pr merge 7`);
    expect(text).toHaveLength(command.length);
  });

  it("rewrites every program word of a chain, a subshell and a substitution, behind the leads cmd() knows", () => {
    expect(trustedMask("ls && gh.exe pr merge 7")).toBe("ls &&     gh pr merge 7");
    expect(trustedMask("(GIT.EXE status)")).toBe("(    git status)");
    expect(trustedMask(`x=$("gh" pr view 7)`)).toBe(`x=$(  gh pr view 7)`);
    expect(trustedMask("timeout 5 gh.exe pr merge 7")).toBe("timeout 5     gh pr merge 7");
    expect(trustedMask("FOO=1 /usr/bin/git push")).toBe("FOO=1          git push");
  });

  it("follows a wrapper spelled with a path to the word it runs", () => {
    expect(trustedMask("/usr/bin/env /usr/bin/gh pr merge 7")).toBe("         env          gh pr merge 7");
    expect(trustedMask(`"timeout" 5 gh.exe x`)).toBe(`  timeout 5     gh x`);
    expect(trustedMask("ENV GH x")).toBe("env gh x");
  });

  it("keeps the case of a bash builtin or keyword, which bash finds by its exact spelling", () => {
    expect(trustedMask("CD x && Cd y && cd z")).toBe("CD x && Cd y && cd z");
    expect(trustedMask("EXPORT X=1")).toBe("EXPORT X=1");
    expect(trustedMask("Git status")).toBe("git status");
  });

  it("leaves a mention, an argument and an assignment alone", () => {
    expect(trustedMask("grep gh.exe f")).toBe("grep gh.exe f");
    expect(trustedMask(`echo "gh.exe pr merge 5"`)).toBe(`echo "${"_".repeat(17)}"`);
    expect(trustedMask("GH=gh.exe ls")).toBe("GH=gh.exe ls");
    expect(trustedMask(`"GH=x" ls`)).toBe(`"____" ls`);
  });

  it("reads a quoted shell as a shell, so the mask is not trusted for the string it is handed", () => {
    for (const shell of [`"bash"`, "/usr/bin/bash", "BASH.EXE", "'sh'"])
      expect(view(`${shell} -c 'gh pr merge 7'`).trusted, shell).toBe(false);
    // The string's first word is a program word too since #1634, rewritten as
    // the shell word before it is; the quotes and every other character stay.
    expect(trustedMask(`"bash" -c 'gh.exe pr merge 7'`)).toBe(`  bash -c '    gh pr merge 7'`);
    expect(trustedMask(`"bash" -c 'echo gh.exe pr merge 7'`)).toBe(`  bash -c 'echo gh.exe pr merge 7'`);
  });

  it("finds where the program word starts from anywhere inside it", () => {
    const command = `cd x && "C:/Program Files/GitHub CLI/gh.exe" pr merge 7`;
    const at = trustedMask(command).indexOf("gh pr");
    expect(lexer.programStart(command, at)).toBe(command.indexOf(`"C:`));
    expect(lexer.programStart(command, 3)).toBe(3);
  });

  it("records the words bash reads at every depth", () => {
    const { words: ends } = maskInert(`a "b c"d $(e f)g \`h\` # i`);
    expect([...ends]).toEqual([
      [0, 1],
      [2, 8],
      [11, 12],
      [13, 14],
      [9, 16],
      [18, 19],
      [17, 20],
    ]);
  });

  it.each([
    [`& "C:\\x\\gh.exe" pr`, `  "C:/x/gh.exe" pr`],
    ["&gh pr", " gh pr"],
    ["a; & gh", "a;   gh"],
    ["a | &gh", "a |  gh"],
    ["a && & gh", "a &&   gh"],
    ["a || & gh", "a ||   gh"],
    ["{ & gh }", "{   gh }"],
    ["(& gh)", "(  gh)"],
    ["a\n& gh", "a\n  gh"],
    ["gh pr merge 7 &", "gh pr merge 7 &"],
    ["a & gh", "a & gh"],
  ])("powershellAsBash blanks the call operator that leads a statement: %s", (ps, out) =>
    expect(powershellAsBash(ps)).toBe(out),
  );

  it.each([
    ["$GH pr merge 5", "$GH"],
    ["${GH} pr", "${GH}"],
    ["$(which gh) pr", "$(which gh)"],
    ["`which gh` pr", "`which gh`"],
    [`"$GH" pr`, `"$GH"`],
    ["/usr/bin/$GH pr", "/usr/bin/$GH"],
    ["g? pr", "g?"],
    ["g* pr", "g*"],
    ["g[h] pr", "g[h]"],
    ["{g,}h pr", "{g,}h"],
    ["ls && $EDITOR f", "$EDITOR"],
  ])("lists a program word it cannot read: %s", (command, word) => {
    const found = lexer.unreadablePrograms?.(command);
    expect(found).toEqual([{ start: command.indexOf(word), end: command.indexOf(word) + word.length, word }]);
  });

  it("reads a program word whose expansion or glob is in an earlier path segment, and skips what is no program", () => {
    for (const command of [
      "$HOME/bin/gh pr",
      "$(git rev-parse --show-toplevel)/scripts/x.sh",
      "echo $GH",
      "X=$(gh pr view 7) ls",
      "$x = 5",
      "[ -f x ]",
      "[[ -f x ]]",
      "{ ls; }",
      `'$GH' pr`,
    ])
      expect(lexer.unreadablePrograms?.(command), command).toEqual([]);
  });

  it("powershellAsBash folds a program word's case, which PowerShell resolves in any case", () => {
    expect(powershellAsBash("CD x; GH.EXE pr; Git status")).toBe("cd x; gh.exe pr; git status");
    expect(powershellAsBash(`& "C:\\Tools\\GH.EXE" pr`)).toBe(`  "C:/Tools/gh.exe" pr`);
    expect(powershellAsBash("Write-Output GH")).toBe("write-output GH");
  });
});

// #1606: git takes global options between `git` and its verb, and every trap
// hand-rolled its own prefix, which knew `-C` at most.
describe("git's global options (#1606)", () => {
  const verb = (v) => cmd(new RegExp(String.raw`git${lexer.GIT_GLOBALS}${v}\b`));
  it.each([
    "git commit",
    "git -c user.name=x commit",
    "git -c 'user.name=a b' commit",
    "git --no-pager commit",
    "git -p -P --paginate --bare commit",
    "git --git-dir=.git commit",
    "git --git-dir .git commit",
    "git --work-tree=. commit",
    "git --work-tree . commit",
    `git -C "a b" commit`,
    "git -C 'a b' commit",
    "git -C a\\ b commit",
    "git -C a -C b commit",
    "git --namespace=x --config-env=a.b=C --super-prefix=p --attr-source=HEAD commit",
    "git --exec-path commit",
    "git --exec-path=/x commit",
    "git --list-cmds=main commit",
    "git --no-replace-objects --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs commit",
    "git --no-optional-locks --no-advice --no-lazy-fetch commit",
    "x && git -c a=b -C ../ir-5 --no-pager commit -m y",
  ])("matches the verb after them: %s", (command) => expect(verb("commit").test(trustedMask(command))).toBe(true));

  it.each([
    "git log commit",
    "git -C commit",
    "git -C -x commit",
    "git --list-cmds commit",
    "git --no-pagerx commit",
    `echo "git -c a=b commit"`,
  ])("does not take an argument or a mention for the verb: %s", (command) =>
    expect(verb("commit").test(trustedMask(command))).toBe(false),
  );

  it("gitCwd reads every -C in order, each against the one before, with a quoted value whole", () => {
    const status = cmd(new RegExp(String.raw`git${lexer.GIT_GLOBALS}status\b`));
    expect(gitCwd("git -C a -C b status", MASTER, status)).toBe(path.join(MASTER, "a", "b"));
    expect(gitCwd("git -C ../ir-5 -C packages status", MASTER, status)).toBe(tree("ir-5", "packages"));
    expect(gitCwd("git -c x=y -C ../ir-5 status", MASTER, status)).toBe(tree("ir-5"));
    expect(gitCwd(`git --no-pager -C "../ir 5" status`, MASTER, status)).toBe(tree("ir 5"));
    expect(gitCwd("git -C '../ir 5' status", MASTER, status)).toBe(tree("ir 5"));
    expect(gitCwd("git -C ../ir\\ 5 status", MASTER, status)).toBe(tree("ir 5"));
    expect(gitCwd(`"git" -C ../ir-5 status`, MASTER, status)).toBe(tree("ir-5"));
    expect(gitCwd("cd ../ir-5 && git -C ../ir-6 -C .. status", MASTER, status)).toBe(REPO);
  });

  it("gitPlace says when --git-dir, --work-tree or their variables move the repository", () => {
    const place = (c) => lexer.gitPlace?.(c, MASTER);
    expect(place("git status")).toEqual({ dir: MASTER, movesRepo: false, movesTree: false, movesIndex: false });
    expect(place("GIT_INDEX_FILE=x git status")).toMatchObject({ movesRepo: false, movesIndex: true });
    expect(place("git -c core.worktree=x status")).toMatchObject({ movesRepo: false, movesTree: true });
    expect(place("git --config-env=CORE.WORKTREE=X status")).toMatchObject({ movesTree: true });
    expect(place("GIT_COMMON_DIR=x git status")).toMatchObject({ movesRepo: true });
    expect(place("git --git-dir=x status")).toMatchObject({ movesRepo: true, movesTree: false });
    expect(place("git --git-dir x status")).toMatchObject({ movesRepo: true });
    expect(place("GIT_DIR=x git status")).toMatchObject({ movesRepo: true });
    expect(place("$env:GIT_DIR = 'x'; git status")).toMatchObject({ movesRepo: true });
    expect(place("git --work-tree=x status")).toMatchObject({ movesRepo: false, movesTree: true });
    expect(place("export GIT_WORK_TREE=x; git status")).toMatchObject({ movesTree: true });
    expect(place(`echo "GIT_DIR=x" && git status`)).toMatchObject({ movesRepo: false });
  });

  // The per-rule prefixes drifted apart once (only worktree remove knew `-c`);
  // every git regex is built on GIT_GLOBALS, and this keeps it that way.
  it("no hook module hand-rolls git's prefix before a verb", () => {
    const drift = /git\\s[+*]\(?(?:\?:)?(?:-[Cc]\b|[a-z])/;
    for (const shape of [
      String.raw`cmd(/git\s+(-C\s+\S+\s+)?push\b/)`,
      String.raw`cmd(/git\s+(?:-c\s+\S+\s+)?worktree\s+remove/)`,
      String.raw`cmd(/git\s+show\b/)`,
      String.raw`new RegExp(String.raw${"`"}\bgit\s+-C\s+x${"`"})`,
    ])
      expect(drift.test(shape), shape).toBe(true);
    expect(drift.test(String.raw`gitVerb(String.raw${"`"}push\b${"`"})`)).toBe(false);
    const dir = import.meta.dirname;
    const modules = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
    expect(modules).toContain("rules-bash.mjs");
    for (const f of modules)
      readFileSync(path.join(dir, f), "utf8")
        .split("\n")
        .forEach((line, k) => expect(drift.test(line), `${f}:${k + 1}: ${line.trim()}`).toBe(false));
  });

  it("reads a long run of options in linear time", () => {
    for (const n of [30, 4000])
      for (const unit of ["-c a=b ", "--no-pager ", "-C x "]) {
        const command = `git ${unit.repeat(n)}status`;
        const started = Date.now();
        expect(verb("commit").test(command)).toBe(false);
        expect(Date.now() - started, `${n} × "${unit}"`).toBeLessThan(200);
      }
  });
});

// #1606 review: the cases the xhigh /code-review found the rewrite still missed.
describe("the program-word rewrite's review round (#1606)", () => {
  it.each([
    ["$(git push x)/scripts/run.sh y", `$(git push x)${" ".repeat(9)}run.sh y`],
    [`"$(git push x)"/x.sh y`, ` $(git push x)  x.sh y`],
    ["`git push x`/gh pr", "`git push x` gh pr"],
    ["${X:-$(git push x)}/gh pr", "     $(git push x)  gh pr"],
    ["a$(b)c/$(d)e/gh pr", " $(b)  $(d)  gh pr"],
    ["$HOME/bin/gh pr", `${" ".repeat(10)}gh pr`],
  ])("keeps a command substitution in the directory part live: %s", (command, out) => {
    const { text, flat } = view(command);
    expect(text).toBe(out);
    expect(flat).toHaveLength(command.length);
  });

  it("reads the commands inside, and the program after, the substitution", () => {
    expect(trustedMask("$(GIT.EXE push x)/gh.exe pr")).toBe("$(    git push x)     gh pr");
    expect(trustedMask(`$(echo ")")/gh pr`)).toBe(`$(echo "_") gh pr`);
    expect(view("$(bash -c 'git push origin integration')/x").trusted).toBe(false);
  });

  it("finds the innermost program word for an index", () => {
    const command = "$(gh issue edit 5)/x.sh y";
    expect(lexer.programStart(command, 2)).toBe(2);
    expect(lexer.programStart(command, command.indexOf("x.sh"))).toBe(0);
    expect(lexer.programStart(command, 8)).toBe(8);
  });

  it("takes a word for an assignment only where bash does: an unquoted valid name before `=`", () => {
    expect(trustedMask("./x=y/gh pr")).toBe("      gh pr");
    expect(trustedMask(`"/c/a=b/gh.exe" pr`)).toBe(`${" ".repeat(13)}gh pr`);
    for (const command of ["FOO=1 ls", "a[1]=x ls", "X+=1 ls", "_x=1"])
      expect(trustedMask(command), command).toBe(command);
    expect(lexer.unreadablePrograms("$x = 5")).toEqual([]);
  });

  it("reads env's quoted assignments and options as env reads them, never as the program", () => {
    expect(trustedMask(`env 'GH_REPO=x/y' gh pr`)).toBe(`env GH_REPO=_____ gh pr`);
    expect(trustedMask(`env "a b=c" gh pr`)).toBe(`env a_b=___ gh pr`);
    expect(trustedMask(`env "-C" ../o gh pr`)).toBe(`env   -C ../o gh pr`);
    expect(trustedMask(`exec '-a' x GH.EXE pr`)).toBe(`exec   -a x     gh pr`);
    expect(trustedMask(`env "--chdir=../o" gh pr`)).toBe(`env   --chdir=../o gh pr`);
  });

  it("lists an expanding env argument, which env may take for an assignment", () => {
    expect(lexer.unreadablePrograms("env $R gh pr")).toEqual([{ start: 4, end: 6, word: "$R", env: true }]);
    expect(lexer.unreadablePrograms(`env "$R" gh pr`)).toEqual([{ start: 4, end: 8, word: `"$R"`, env: true }]);
    expect(lexer.unreadablePrograms("$R gh pr")).toEqual([{ start: 0, end: 2, word: "$R" }]);
  });

  it.each([
    "2>/dev/null gh pr",
    "</dev/null gh pr",
    "2> x gh pr",
    ">&2 gh pr",
    "2>&1 >log gh pr",
    "<<<x gh pr",
    "&>log gh pr",
  ])("cmd() steps over a redirection ahead of the program: %s", (command) =>
    expect(cmd(/gh\s+pr\b/).test(trustedMask(command))).toBe(true),
  );

  it("does not take a redirect's own & for a command boundary", () => {
    expect(cmd(/gh\s+pr\b/).test(trustedMask("echo x &>log gh pr"))).toBe(false);
    expect(cmd(/gh\s+pr\b/).test(trustedMask("echo x 2>&1 gh pr"))).toBe(false);
    expect(cmd(/gh\s+pr\b/).test(trustedMask("echo x & gh pr"))).toBe(true);
  });

  it("steps over a long run of redirections in linear time", () => {
    for (const n of [30, 4000])
      for (const unit of ["2>/dev/null ", "> x ", "2>&1 ", "<<<x "]) {
        const command = `${unit.repeat(n)}echo done`;
        const started = Date.now();
        expect(cmd(/gh\s+pr\b/).test(trustedMask(command))).toBe(false);
        expect(Date.now() - started, `${n} × "${unit}"`).toBeLessThan(200);
      }
  });

  it('decodes bash\'s locale string `$"…"` as a double-quoted one', () => {
    expect(trustedMask(`$"gh" pr`)).toBe(`   gh pr`);
    expect(trustedMask(`$"/usr/bin/GH" pr`)).toBe(`${" ".repeat(12)}gh pr`);
    expect(lexer.unreadablePrograms(`$"$GH" pr`)).toEqual([{ start: 0, end: 6, word: `$"$GH"` }]);
  });

  it.each([
    [". gh pr", "  gh pr"],
    [`a; . "C:\\x\\gh.exe" pr`, `a;   "C:/x/gh.exe" pr`],
    ["{ . gh }", "{   gh }"],
    [".\\gh.exe pr", "./gh.exe pr"],
    ["a.b . c", "a.b . c"],
  ])("powershellAsBash blanks the dot-source operator that leads a statement: %s", (ps, out) =>
    expect(powershellAsBash(ps)).toBe(out),
  );

  it("leaves bash's `.`, which is source, as it is", () => expect(trustedMask(". gh pr")).toBe(". gh pr"));
});

// #1606 second read: what the rewrite still got wrong after the review round.
describe("the program-word rewrite's second read (#1606)", () => {
  // Before #1606 an untrusted view was the raw text as it stands; a rewrite in
  // one must never hide a command that raw text exposed.
  const UNTRUSTED = [
    `sudo true; echo "step; make"; git push origin integration; echo "origin/integration"`,
    `bash -c "cd x && make"; gh pr merge 5 --squash; echo "a/b"`,
    `bash -c "cd ../ir-5 && make"; git -C ../ir-5 commit -m "docs/x"`,
    `sudo echo 'a | b'; /usr/bin/git push --tags; echo 'c/d'`,
    `eval "x"; echo "it's; fine" && gh pr create --title t; echo "a/b's"`,
    `sudo echo "a & b" | git commit -m "x/y"`,
    `sudo echo "(a)" ; gh pr merge 7 && echo ")"`,
    "bash -c 'a; b' && git push origin integration # x/'y",
    `sudo x "a;b"/gh pr merge 5; git.exe push --tags; echo "q/r"`,
    "sudo x `a; b`/c; gh pr merge 5 | echo 'd/e'",
    // #1646 review: a backslashed word rewritten.
    String.raw`bash -c "\gh.exe pr merge 5; \ls"; git push origin integration; echo "a/b"`,
    // #1646: words read inside a string at the level its shell reads it.
    `bash -c "X=\\"a; b\\" gh.exe pr merge 5"; git push origin integration; echo "a/b"`,
    String.raw`bash -c 'X='\''a b'\'' /usr/bin/gh pr merge 5' && git.exe push --tags; echo 'c/d'`,
    String.raw`bash -c $'ls\ngh.exe pr merge 5\x3bGIT push --tags'; echo "e/f"`,
    `printf '%s\\n' 'gh.exe pr merge 5' | sh; git push origin integration; echo 'g/h'`,
    `sudo -s env X="a b" gh.exe pr merge 5; echo "i/j"`,
  ];
  const SHAPES = [/git\s+push\b/, /gh\s+pr\s+merge\b/, /git\s+commit\b/, /gh\s+pr\s+create\b/].map((re) => cmd(re));
  // Since #1607 the raw text is read only over the element that feeds a shell;
  // elsewhere a boundary inside a quote is masked, as in a trusted view.
  it.each(UNTRUSTED)("keeps every command the raw text exposes: %s", (command) => {
    const { text, trusted, fed } = view(command);
    const { masked } = maskInert(command);
    expect(trusted).toBe(false);
    expect(text).toHaveLength(command.length);
    for (let i = 0; i < command.length; i++) {
      if (!"\n|;&()\x60\"'".includes(command[i])) continue;
      const raw = fed.some(([a, b]) => a <= i && i < b);
      expect(text[i], `${command[i]} at ${i}`).toBe(raw ? command[i] : masked[i]);
    }
    for (const re of SHAPES) if (re.test(command)) expect(re.test(text), String(re)).toBe(true);
  });

  it.each(UNTRUSTED.slice(-5, -3))("finds the merge inside the string, read as its shell reads it (#1646): %s", (c) => {
    expect(lexer.has(c, SHAPES[1])).toBe(true);
    expect(view(c).unsettled).toBe(false);
  });

  // #1659: an ANSI-C string, a printer piped into a shell and a sudo that runs
  // a shell are refused rather than read.
  it.each(UNTRUSTED.slice(-3))("refuses the form a string is handed in, never reads it (#1659): %s", (c) =>
    expect(lexer.refusedForms(c)).not.toEqual([]),
  );

  it("still rewrites a plain program word in an untrusted view", () => {
    expect(trustedMask(`"bash" -c 'x' && gh.exe pr merge 5`)).toBe(`  bash -c 'x' &&     gh pr merge 5`);
    expect(trustedMask(`sudo x; "C:/Program Files/Git/cmd/git.exe" push`)).toBe(`sudo x; ${" ".repeat(31)}git push`);
  });
});

// #1607: one `timeout` anywhere in a chain set the mask aside for the whole
// command, so a quoted `gh pr merge` in a sed or grep pattern elsewhere in it
// read as a merge. The mask is now set aside only over the list element that
// feeds a shell.
describe("the mask is set aside only where a shell is fed (#1607)", () => {
  /** The view of `command`: masked before `cut`, raw from it on, and the one fed span `[cut, end)`. */
  const splitAt = (command, cut, end = command.length) => {
    const { text, fed } = view(command);
    expect(text.slice(0, cut)).toBe(maskInert(command).masked.slice(0, cut));
    expect(text.slice(cut, end)).toBe(command.slice(cut, end));
    expect(fed).toEqual([[cut, end]]);
  };

  it("keeps a quoted sed pattern masked when an unrelated shell runs later in the chain", () => {
    // No `> g` here: a file written beside a shell sets the whole command aside (`feedsAcross`).
    const command = `sed -e 's#a#"gh pr merge 5"#' f; sh -c 'grep "gh pr merge 6" g'`;
    splitAt(command, command.indexOf(" sh -c"));
    expect(trustedMask(command)).not.toMatch(/merge 5/);
    expect(trustedMask(command)).toMatch(/merge 6/);
  });

  // They run their arguments as a program, whose word COMMAND_LEAD steps to in the masked text.
  it.each([
    `sed -e 's#a#"gh pr merge 5"#' f > g; timeout 5 grep 'gh pr merge 6' g`,
    `timeout 60 grep -rn "gh pr merge 1603 --squash" scripts`,
    `grep -rln "gh pr merge 1603" scripts | xargs wc -l`,
  ])("sets nothing aside for timeout or xargs: %s", (command) => {
    expect(view(command).fed).toEqual([]);
    expect(trustedMask(command)).not.toMatch(/merge/);
  });

  it("still reads the program after timeout and xargs, quoted or not, in the masked text", () => {
    const at = cmd(/gh\s+pr\s+merge\b/);
    for (const command of [
      "timeout 5 gh pr merge 7",
      "timeout 5 'gh' pr merge 7",
      `timeout -k 5 10 "gh.exe" pr merge 7`,
      "echo 7 | xargs -I{} gh pr merge {}",
    ])
      expect(at.test(trustedMask(command)), command).toBe(true);
    // A shell they run is fed as any other.
    expect(view("timeout 5 bash -c 'ls; gh pr merge 7'").fed).toEqual([[0, 37]]);
    expect(view("ls | xargs sh -c 'gh pr merge 7'").fed).toEqual([[0, 32]]);
  });

  // Each after an `ls;` the element must stop at: a group read wrongly either
  // ends the element inside it or carries it past that `;`.
  it.each([
    "echo 'gh pr merge 5' | bash",
    "printf '%s\\n' 'gh pr merge 5' |& sh",
    "echo 'gh pr merge 5' 2>&1 | xargs -I{} sh -c '{}'",
    "(echo 'ls; gh pr merge 5'; true) | bash",
    "{ echo 'ls; gh pr merge 5'; } | bash",
    "if true; then echo 'ls; gh pr merge 5'; echo if; fi | bash",
    "while read l; do echo 'ls; gh pr merge 5'; done < f | sh",
    "until false; do echo 'ls; gh pr merge 5'; done | sh",
    "for x in 1; do echo 'ls; gh pr merge 5'; done | sh",
  ])("reads a pipeline that feeds a shell raw from its first command, a group's included: %s", (element) => {
    const command = `ls; ${element}`;
    expect(view(command).fed).toEqual([[3, command.length]]);
    expect(view(command).text.slice(3)).toBe(command.slice(3));
  });

  // A function definition in a shell's element may hold that shell for a
  // later `… | f`, so it reads the whole command raw (#1607 second read).
  it.each(["function f { echo 'ls; gh pr merge 5'; } | bash", "f() { echo 'ls; gh pr merge 5'; } | bash"])(
    "reads the whole command raw for a function definition beside a shell: %s",
    (element) => expect(view(`ls; ${element}`).fed).toEqual([[0, element.length + 4]]),
  );

  it("ends the element at a separator outside every group, and only there", () => {
    splitAt("echo 'gh pr merge 5' && bash -c 'x'", "echo 'gh pr merge 5' &&".length);
    splitAt("echo 'gh pr merge 5' || bash -c 'x'", "echo 'gh pr merge 5' ||".length);
    splitAt("echo 'gh pr merge 5' & bash -c 'x'", "echo 'gh pr merge 5' &".length);
    splitAt("echo 'gh pr merge 5'\nbash -c 'x'", "echo 'gh pr merge 5'\n".length);
    // A separator a backslash escapes is find's argument, not the end of the element.
    const find = "find . -exec sh -c 'gh pr merge 5' \\; ; echo 'gh pr merge 6'";
    const { text, fed } = view(find);
    expect(fed).toEqual([[0, find.indexOf(" ; echo") + 1]]);
    expect(text).toMatch(/merge 5/);
    expect(text).not.toMatch(/merge 6/);
  });

  it("widens the element to the one holding an enclosing group, and no further", () => {
    const command = "x=$(echo a | sh); grep 'gh pr merge 5' f";
    const { text, fed } = view(command);
    expect(fed).toEqual([[0, command.indexOf(";")]]);
    expect(text.slice(command.indexOf(";"))).toBe(maskInert(command).masked.slice(command.indexOf(";")));
    // A separator inside the group ends nothing: the heredoc in the substitution is the eval's.
    const nested = `eval "$(cat <<'EOF'\nls; gh pr merge 5\nEOF\n)"; echo 'gh pr merge 6'`;
    expect(view(nested).fed).toEqual([[0, nested.indexOf("; echo")]]);
    expect(view(nested).text).not.toMatch(/merge 6/);
  });

  it("reads the body of a heredoc fed to a shell raw, and another command's heredoc masked", () => {
    const command = "bash <<'EOF'\ngh pr merge 5\nEOF\ncat <<'X'\ngh pr merge 6\nX";
    const { text } = view(command);
    expect(text).toMatch(/gh pr merge 5/);
    expect(text).not.toMatch(/merge 6/);
    expect(maskInert(command).heredocs).toEqual([
      { op: 5, start: 13, end: 27, resume: 31 },
      { op: 35, start: 41, end: 55, resume: 56 },
    ]);
  });

  it("keeps only the top-level command text in the lexer's top text", () => {
    const command = "a 'b;c' \"$(d; e)\" `f; g` ${h;} \\; (i; j) # k\ncat <<X\nl; m\nX\nn";
    expect(maskInert(command).top).toBe("a _____ _________ ______ _____ __ (____)    \ncat <<X\n_______n");
  });

  // The pipeline, the group or the substitution a shell sits in is the
  // element: a separator inside any of them, or a newline the list goes on
  // over, ends nothing (#1607 review).
  it.each([
    "echo 'ls; gh pr merge 5' | { cd x && bash; }",
    "echo 'ls; gh pr merge 5' | (cd x && bash)",
    "echo 'ls; gh pr merge 5' | if true; then bash; fi",
    "echo 'ls; gh pr merge 5' | while true; do bash; break; done",
    "[[ -n 'ls; gh pr merge 5' && -n x ]] | bash",
    "echo 'ls; gh pr merge 5' |\nbash",
    "echo 'ls; gh pr merge 5' |&\n\nbash",
    "echo 'ls; gh pr merge 5' | # run it\nbash",
    "cat <<'EOF' |\nls; gh pr merge 5\nEOF\nbash",
    "cat <<'EOF' |\nls; gh pr merge 5\nEOF\n\nbash",
    "echo \"`cat <<'EOF'\nls; gh pr merge 5\nEOF\n`\" | bash",
    "echo \"$(cat <<'EOF'\nls; gh pr merge 5\nEOF\n)\" | bash",
  ])("reads the whole top-level element a shell sits in raw: %s", (element) => {
    const command = `ls; ${element}`;
    expect(view(command).fed).toEqual([[3, command.length]]);
  });

  it("ends an element at a newline whose list does not go on, past the heredocs it read", () => {
    const command = "cat <<'X'\ngh pr merge 6\nX\nbash -c 'gh pr merge 5'";
    expect(view(command).fed).toEqual([[command.indexOf("bash"), command.length]]);
    expect(view(command).text).not.toMatch(/merge 6/);
    // `&&` is the separator; the newline after it only continues the list.
    const and = "echo 'gh pr merge 6' > /dev/null &&\nbash -c 'x'";
    expect(view(and).fed).toEqual([[and.indexOf("&&") + 2, and.length]]);
  });

  // A shell may run text another element stored: a variable, a file, a
  // function or an alias. The whole command is read raw then, as before #1607.
  it.each([
    `x='ls; gh pr merge 5'; eval "$x"`,
    "export X='ls; gh pr merge 5'; bash -c '$X'",
    "bash <<EOF\n$x\nEOF\necho 'gh pr merge 5'",
    "echo 'ls; gh pr merge 5' > f.sh; bash f.sh",
    "echo 'ls; gh pr merge 5' >> f.sh && sh f.sh",
    "echo 'ls; gh pr merge 5' | tee f.sh; source f.sh",
    "f() { echo 'ls; gh pr merge 5'; }; f | bash",
    "function f { echo 'ls; gh pr merge 5'; }; f | sh",
    "alias m='ls; gh pr merge 5'; eval m",
    "read -r x <<< 'ls; gh pr merge 5'; eval \"$x\"",
    "exec 3< <(echo 'ls; gh pr merge 5'); bash <&3",
    "set -a; X='ls; gh pr merge 5'; bash f.sh",
    "grep -n 'gh pr merge 5' notes.md; bash \"$SCRIPT\"",
    // #1607 second read: the shell's own element holds it for a later one to feed.
    'f() { bash; }; printf "cd x; gh pr merge 5" | f',
    'function f { sh; }; echo "cd x; gh pr merge 5" | f',
    'exec > >(bash); echo "cd x; gh pr merge 5"',
    'exec 3> >(bash); echo "cd x; gh pr merge 5" >&3',
    'coproc bash; echo "cd x; gh pr merge 5" >&"${COPROC[1]}"',
    // A sudo that runs a shell hands it its argument as shell text.
    'X="cd x; gh pr merge 5"; sudo -s "$X"',
    'X="cd x; gh pr merge 5"; sudo -i "$X"',
    'X="cd x; gh pr merge 5"; sudo -Eu me -s "$X"',
    'X="cd x; gh pr merge 5"; sudo --user me --login "$X"',
  ])("reads the whole command raw when a shell may run text another element stores: %s", (command) =>
    expect(view(command).fed).toEqual([[0, command.length]]),
  );

  // A newline is a command-position boundary, so a compound command that
  // opens on a later line, or after `time -p`, is still a group (#1607 second read).
  it.each([
    "git fetch\n{\n  cat <<'EOF'\ngh pr merge 5\nEOF\n} | bash",
    // (`$p` would expand in the shell's element and read the whole command raw: see feedsAcross.)
    'git fetch\nfor p in 5; do echo "cd x; gh pr merge 5"; done | bash',
    "git fetch\n{ echo a; printf '%s' \"cd x; gh pr merge 5\"; } | bash",
    "git fetch\ntime -p { echo a; printf '%s' \"cd x; gh pr merge 5\"; } | bash",
    "git fetch\nif true\nthen echo 'cd x; gh pr merge 5'\nfi | bash",
  ])("reads a group opened on a later line as one element: %s", (command) =>
    expect(view(command).fed).toEqual([[10, command.length]]),
  );

  it("keeps the mask where nothing is stored for a shell, or only a program runs", () => {
    for (const command of [
      "grep 'gh pr merge 5' f 2>/dev/null; bash -c 'x'",
      "grep 'gh pr merge 5' f 2>&1; bash -c 'x'",
      "grep 'gh pr merge 5' f > out.txt; sudo true",
      'X="a"; grep "gh pr merge 5" f; sudo -u me "$X"',
      // An assignment in the shell's own element holds nothing for a later one.
      "x=$(echo a | sh); grep 'a; gh pr merge 1603' f",
      // An unexported assignment reaches another shell only through an expansion.
      "x=1; grep 'a|gh pr merge 5' f; sh -c 'true'",
      "Q=/c/q; grep 'gh pr merge 5' $Q/f > $Q/g; xargs ls < $Q/g",
    ])
      // The mention stays masked: no span reaches over the grep.
      expect(trustedMask(command), command).not.toMatch(/gh pr merge/);
  });

  it("sets the mask aside over the whole command when the lexer is unsure", () => {
    const command = "echo 'gh pr merge 5'; timeout 5 x 'open";
    expect(maskInert(command).sure).toBe(false);
    expect(view(command).text).toBe(command);
    expect(view(command).fed).toEqual([[0, command.length]]);
    expect(lexer.trustedIn(command, 0, 4)).toBe(false);
  });

  it("says over which ranges the mask stands", () => {
    const command = "grep 'gh pr merge 5' f; sh -c true";
    const at = command.indexOf(" sh");
    expect(lexer.trustedIn(command, 0, at)).toBe(true);
    expect(lexer.trustedIn(command, at, command.length)).toBe(false);
    expect(lexer.trustedIn(command, 0, command.length)).toBe(false);
    expect(view(command).trusted).toBe(false);
    expect(lexer.trustedIn("grep 'gh pr merge 5' f", 0, 22)).toBe(true);
    expect(view("grep 'gh pr merge 5' f").trusted).toBe(true);
  });
});

// #1634: a trap word that is the FIRST word of a string a shell runs, or the
// program a wrapper runs, was at command position for no `cmd()` consumer —
// only the post-hook's merge trigger read those positions (#1607). Every
// consumer now does, through one notion of command position.
describe("the first word of a shell-fed string is at command position (#1634)", () => {
  const MERGE = cmd(/gh\s+pr\s+merge\s+(\d+)/);
  const VITEST = cmd(/(pnpm\s+exec\s+|npx\s+)vitest\b/);
  const FED = [
    ["bash -c 'gh pr merge 7 --squash'", "shell", "bash"],
    [`sh -c "gh pr merge 7"`, "shell", "sh"],
    ["sudo gh pr merge 7", "wrapper", "sudo"],
    ["sudo -u me gh pr merge 7", "wrapper", "sudo"],
    [`pwsh -Command "gh pr merge 7"`, "shell", "pwsh"],
    ["env A=1 bash -c 'gh pr merge 7'", "shell", "bash"],
    ["nice gh pr merge 7", "wrapper", "nice"],
    ["bash -c 'A=1 gh pr merge 7'", "shell", "bash"],
    ["bash -c 'gh.exe pr merge 7'", "shell", "bash"],
    ["bash -c 'sudo gh pr merge 7'", "wrapper", "sudo"],
    [`"bash" -c 'exec gh pr merge 7'`, "shell", "bash"],
  ];

  it.each(FED)("has() and matchAt() find the merge, with its groups, in %s", (command, how, via) => {
    expect(lexer.has(command, MERGE)).toBe(true);
    const m = lexer.matchAt(command, MERGE);
    expect(m[1]).toBe("7");
    expect(m).toMatchObject({ how, via });
    expect(command.slice(lexer.programStart(command, m.index))).toMatch(/^gh(?:\.exe)? pr merge 7/);
  });

  it.each([
    "bash -c 'pnpm exec vitest run'",
    "sudo pnpm exec vitest",
    `pwsh -c "pnpm exec vitest"`,
  ])("finds the vitest trap in %s", (command) => expect(lexer.has(command, VITEST)).toBe(true));

  it.each([
    `echo "bash -c gh pr merge 7"`,
    "grep 'gh pr merge 7' f",
    `rg -t sh "gh pr merge 1603"`,
    "echo 'gh pr merge 7' > f",
    "echo gh pr merge 7",
    "echo 'pnpm exec vitest' | tee f",
    "ls /bin/sh 'pnpm exec vitest'",
    "bash -c 'echo gh pr merge 7'",
    `bash -c 'echo "sudo gh pr merge 7"'`,
    "bash -c 'echo sudo pnpm exec vitest'",
    "sudo echo gh pr merge 7",
  ])("still finds no command in a mention: %s", (command) => {
    expect(lexer.has(command, MERGE)).toBe(false);
    expect(lexer.has(command, VITEST)).toBe(false);
    expect(lexer.matchAt(command, MERGE)).toBeNull();
  });

  it("says how a word is the program", () => {
    expect(lexer.programKind("gh pr merge 7", 0)).toEqual({ how: "command" });
    expect(lexer.programKind("sudo gh pr merge 7", 5)).toEqual({ how: "wrapper", via: "sudo" });
    expect(lexer.programKind("nice -n 5 gh pr merge 7", 10)).toEqual({ how: "wrapper", via: "nice" });
    expect(lexer.programKind("bash -c 'gh pr merge 7'", 9)).toEqual({ how: "shell", via: "bash" });
    // A shell reading its script from stdin is refused, never read (#1659).
    expect(lexer.programKind("echo 'gh pr merge 7' | bash", 6)).toBeUndefined();
    expect(lexer.programKind("bash <<< 'gh pr merge 7'", 10)).toBeUndefined();
    expect(lexer.programKind("echo gh pr merge 7", 5)).toBeUndefined();
    expect(lexer.programKind("bash -c 'echo gh pr merge 7'", 14)).toBeUndefined();
    expect(lexer.programAt("sudo gh pr merge 7", 5)).toBe(true);
    expect(lexer.programKind("bash -c 'gh pr merge 7'", 9).how).toBe("shell");
  });

  it("rewrites the first word of a fed string to the program it runs, as it does at command position", () => {
    expect(trustedMask("bash -c 'gh.exe pr merge 7'")).toBe("bash -c '    gh pr merge 7'");
    expect(trustedMask(`bash -c '"gh" pr merge 7'`)).toBe(`bash -c '  gh pr merge 7'`);
    expect(trustedMask("sudo GH.EXE pr merge 7")).toBe("sudo     gh pr merge 7");
    expect(trustedMask("bash -c 'echo gh.exe pr merge 7'")).toBe("bash -c 'echo gh.exe pr merge 7'");
    expect(lexer.unreadablePrograms("bash -c '$GH pr merge 7'")).toEqual([{ start: 9, end: 12, word: "$GH" }]);
    // A shell's string is never rewritten whole (`bash -c 'x'` keeps its
    // quotes, as the raw-view tests above have it); the word a sudo runs is.
    expect(trustedMask("bash -c 'x'")).toBe("bash -c 'x'");
    expect(trustedMask('sudo "gh" pr merge 7')).toBe("sudo   gh pr merge 7");
  });

  it("ends a command's arguments and groups at the close of the string it runs in", () => {
    const push = cmd(/git\s+push\b/);
    const args = (c) => [...lexer.chainCommands(c, MASTER, push)].map((x) => x.args);
    expect(args("bash -c 'git push origin x'")).toEqual([" origin x"]);
    expect(args("bash -c 'ls; git push'")).toEqual([""]);
    expect(args("sudo git push origin 'v1'")).toEqual([" origin 'v1'"]);
    expect(args(`bash -c "git push" && git push origin y`)).toEqual(["", " origin y"]);
    const add = cmd(/git\s+worktree\s+add\b(.*)$/);
    expect(lexer.matchAt("bash -c 'git worktree add ../ir-5 -b x'", add)[1]).toBe(" ../ir-5 -b x");
    expect(lexer.matchAt("git worktree add ../ir-5 -b x", add)[1]).toBe(" ../ir-5 -b x");
  });

  it("yields the matches in the order the command runs them", () => {
    const command = "bash -c 'gh pr merge 5'; gh pr merge 7";
    expect([...lexer.matchesAt(command, MERGE)].map((m) => m[1])).toEqual(["5", "7"]);
  });

  it(
    "reads a long fed string, a long lead and a long run of options in time linear in their length",
    { timeout: TIMING_TIMEOUT_MS },
    () => {
      readsLinearly((n) => `bash -c '${"gh pr merge 7 ".repeat(n)}'`, 2000, MERGE, true);
      readsLinearly((n) => `echo ${"-x gh pr merge 7 ".repeat(n)}`, 2000, MERGE, false);
      readsLinearly((n) => `sudo ${"-E ".repeat(n)}gh pr merge 7`, 2000, MERGE, true);
      readsLinearly((n) => `bash -c '${"A=1 ".repeat(n)}gh pr merge 7'`, 2000, MERGE, true);
      readsLinearly((n) => `echo '${"gh pr merge 7; ".repeat(n)}' | bash`, 2000, MERGE, true);
      readsLinearly((n) => `echo '${"x gh pr merge 7 ".repeat(n)}' | bash`, 2000, MERGE, false);
      // A lead token whose option value were free to be another option (the one
      // parse per token COMMAND_LEAD keeps) would backtrack here, where the lead
      // fails at the string's close or the text's end, in time that grows as the
      // Fibonacci numbers do: trivial at 20 options, a second at 40.
      readsLinearly((n) => `bash -c 'env ${"-u ".repeat(n)}-u'`, 20, MERGE, false);
      readsLinearly((n) => `env ${"-u ".repeat(n)}-u`, 20, MERGE, false);
    },
  );
});

// The #1634 /code-review round: a shell word's value options ended the walk
// to its string early, a match could run past its string's close, a wrapper's
// value option stood alone, a partial word after a wrapper counted, the inner
// shape was scanned once rather than tested where a program is, and a
// `$`-ending shape before a newline put `program` on the separator.
describe("the #1634 review round: options, cuts and program positions", () => {
  const MERGE = cmd(/gh\s+pr\s+merge\b/);
  const JQ = cmd(/jq(\s|$)/);
  const BODY = cmd(/gh\b[^|&;]*--body\s+@-/);
  const PIPED = cmd(/pnpm\s+test\b(?:[^|&;\n]|>&\d)*\|(?!\|)/);

  it.each([
    "bash -o pipefail -c 'gh pr merge 7 --squash'",
    "bash -O extglob -c 'gh pr merge 7'",
    "sh -eo pipefail -c 'gh pr merge 7'",
    "bash --rcfile x -c 'gh pr merge 7'",
    "bash +o posix -c 'gh pr merge 7'",
    `cmd //c "gh pr merge 7"`,
    `cmd //C "gh pr merge 7"`,
    `cmd /d /s /c "gh pr merge 7"`,
    "watch -n 5 'gh pr merge 7'",
    "watch --interval 5 'gh pr merge 7'",
    "su - me -c 'gh pr merge 7'",
    "su me -c 'gh pr merge 7'",
    "su -s /bin/sh -c 'gh pr merge 7'",
    `pwsh -ExecutionPolicy Bypass -Command "gh pr merge 7"`,
    `pwsh -wd ../x -NoProfile -c "gh pr merge 7"`,
    `powershell -ep Bypass -Command "gh pr merge 7"`,
    "fish --command 'gh pr merge 7'",
    "fish -d 3 -c 'gh pr merge 7'",
    "sudo -u me -- gh pr merge 7",
    "sudo --user=me gh pr merge 7",
    "sudo -Eu me gh pr merge 7",
    "nice -n 5 gh pr merge 7",
    "nice --adjustment=5 gh pr merge 7",
    "stdbuf -o L gh pr merge 7",
    "find . -exec gh pr merge 7 {} \\;",
    'sudo "gh" pr merge 7',
    "sudo nice gh pr merge 7",
    "bash -c 'sudo nice gh pr merge 7'",
  ])("reads the shell word's and the wrapper's value options and reaches the string: %s", (c) =>
    expect(lexer.has(c, MERGE)).toBe(true),
  );

  it.each([
    "bash -o 'gh pr merge 7'",
    "watch -n 'gh pr merge 7'",
    "su -s 'gh pr merge 7'",
    "sudo -u 'gh pr merge 7'",
    "sudo -u gh pr merge 7",
    "nice -n gh pr merge 7",
    `pwsh -ExecutionPolicy "gh pr merge 7"`,
    "pwsh -File 'gh pr merge 7'",
    "echo -exec gh pr merge 7",
  ])("takes a value option's value as its value, never as the program: %s", (c) =>
    expect(lexer.has(c, MERGE)).toBe(false),
  );

  it.each(["sudo ./build-jq x", "nice -n 5 foojq x", "sudo -u jq ls", "sudo apt-get install -y jq"])(
    "finds no jq where a word only ends in it or is a value: %s",
    (c) => expect(lexer.has(c, JQ)).toBe(false),
  );
  it.each(["sudo /usr/bin/jq .x f", `sudo "jq" .x f`, "sudo jq .x", "bash -c 'jq .x'", "nice -n 5 ./jq .x"])(
    "finds jq as the program a wrapper or a shell runs: %s",
    (c) => expect(lexer.has(c, JQ)).toBe(true),
  );

  it("tests the rule's shape where a program is, so a mention of the same shape consumes nothing", () => {
    expect(lexer.has("sudo env X=gh gh pr comment 5 --body @-", BODY)).toBe(true);
    expect(lexer.has("sudo gh pr comment 5 --body @-", BODY)).toBe(true);
    expect(lexer.has("echo gh --body @- && gh pr comment 5 --body @-", BODY)).toBe(true);
    expect([...lexer.matchesAt("sudo env X=gh gh pr comment 5 --body @-", BODY)]).toHaveLength(1);
  });

  it.each([
    ["X=gh gh pr comment 5 --body @-", 5],
    ["GH_REPO=a/gh gh pr comment 5 --body @-", 13],
    ["cd x && X=gh gh pr comment 5 --body @-", 13],
  ])("finds an anchored command once, at its program, past a lead the shape also fits: %s", (c, program) => {
    // The greedy shape fits from the `gh` inside the assignment too; that is
    // no program, and the known-program pass must not yield the command again.
    const found = [...lexer.matchesAt(c, BODY)];
    expect(found.map((m) => m.program)).toEqual([program]);
    expect(found[0].how).toBe("command");
  });

  it("confines a match to the string its program runs in", () => {
    expect(lexer.has("echo 'pnpm test' | bash", PIPED)).toBe(false);
    expect(lexer.has("bash -c 'pnpm test' | tail", PIPED)).toBe(false);
    expect(lexer.has("echo 'ls; pnpm test' | bash", PIPED)).toBe(false);
    expect(lexer.has("bash -c 'pnpm test | tee x'", PIPED)).toBe(true);
    expect(lexer.has("pnpm test | tail", PIPED)).toBe(true);
    const add = cmd(/git\s+worktree\s+add\b(.*)$/);
    expect(lexer.matchAt("bash -c 'ls; git worktree add ../ir-5 -b x' && echo", add)[1]).toBe(" ../ir-5 -b x");
  });

  it("keeps `program` on the program word for a $-ending shape before a newline", () => {
    const add = cmd(/git\s+worktree\s+add\b(.*)$/);
    const c = "cd ../ir-4 && git worktree add ../ir-5 -b x\ncd ../ir-6";
    const m = lexer.matchAt(c, add);
    expect(c.slice(m.program)).toMatch(/^git worktree add/);
    expect(m[1]).toBe(" ../ir-5 -b x");
    expect(gitCwd(c, MASTER, add)).toBe(tree("ir-4"));
    const chain = "a && gh pr merge 7\nb; gh pr merge 8 && (gh pr merge 9)";
    for (const f of lexer.matchesAt(chain, MERGE)) expect(chain.slice(f.program)).toMatch(/^gh pr merge/);
  });

  it("rewrites the word a wrapper runs, as it rewrites a shell's first word", () => {
    expect(trustedMask("nice gh.exe pr merge 7")).toBe("nice     gh pr merge 7");
    expect(trustedMask('sudo "gh" pr merge 7')).toBe("sudo   gh pr merge 7");
    expect(trustedMask("find . -exec GH.EXE pr merge {} \\;")).toBe("find . -exec     gh pr merge {} \\;");
    expect(lexer.programKind("find . -exec gh pr merge {} \\;", 13)).toEqual({ how: "wrapper", via: "find -exec" });
    expect(lexer.programKind("sudo nice gh pr merge 7", 10)).toEqual({ how: "wrapper", via: "nice" });
    // A program quoted whole among the words a shell joins is read whole too,
    // its own quotes with it, as `sudo "gh"`'s are; another word's stay (#1646).
    expect(trustedMask('cmd /c "gh" pr merge 7')).toBe("cmd /c   gh pr merge 7");
    expect(lexer.has('cmd /c "gh" pr merge 7', MERGE)).toBe(true);
    const joined = `cmd /c "gh.exe" pr merge 5 "x;y"; git.exe push --tags`;
    expect(trustedMask(joined)).toBe(`cmd /c ${" ".repeat(6)}gh pr merge 5 "x;y";     git push --tags`);
  });

  it("has no fedCommandStart export: programKind says how a word is the program", () =>
    expect(lexer.fedCommandStart).toBeUndefined());

  it("answers has() and reads every match in time linear in a long chain", { timeout: TIMING_TIMEOUT_MS }, () => {
    readsLinearly((n) => "gh pr merge 7; ".repeat(n), 4000, MERGE, true);
    // No timing case for a chain of rewritten program words (`gh.exe pr merge
    // 7; ` × n): the merge of their edits no longer scans every earlier one
    // (#1634), but at a size where the old scan crossed the bound the new code
    // kept only about 1.7× headroom under it, too close for CI's slower and
    // noisier runners, and the merge has no seam a count could reach.
    readsLinearly((n) => `sudo ${"-u me ".repeat(n)}gh pr merge 7`, 2000, MERGE, true);
    readsLinearly((n) => `echo ${"-x gh pr merge 7 ".repeat(n)}`, 2000, MERGE, false);
    // A pipeline of n stages into a shell: the stdin pass once asked every later stage for its reader, per stage.
    readsLinearly((n) => `${"echo x | ".repeat(n)}bash -c 'gh pr merge 7'`, 1000, MERGE, true);
    // Every match of the chain, each placed in its program word: a lookup per match, never a walk of them all.
    readsLinearly(
      (n) => "gh pr merge 7; ".repeat(n),
      4000,
      MERGE,
      true,
      (c) => [...lexer.matchesAt(c, MERGE)].length > 1,
    );
    // No timing case for a chain of quoted shell strings: building the view for
    // that shape is super-linear on master too (#1607's per-element fed spans),
    // and failed the bound on CI's runner; the read count below pins the lookup.
  });

  // The string around a word is found by a binary search over the sorted
  // quotes, never a scan of them all (CodeRabbit on PR #1637): counted, so no
  // clock decides it. A scan reads every quote for the last string, and for a
  // word outside every string; the search reads about log2(n).
  it("finds the string around a word in about log2(n) quote reads, not n", () => {
    const n = 256;
    const c = "bash -c 'gh pr merge 7'; ".repeat(n);
    const v = lexer.view(c);
    const quotes = v.quotes;
    expect(quotes).toHaveLength(n);
    let reads = 0;
    v.quotes = new Proxy(quotes, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      const lastGh = c.lastIndexOf("gh");
      reads = 0;
      expect(lexer.stringBounds(c, lastGh)).toEqual(quotes[n - 1]);
      expect(reads).toBeLessThanOrEqual(2 * Math.log2(n) + 4);
      // A word outside every string: the last separator.
      reads = 0;
      expect(lexer.stringBounds(c, c.lastIndexOf(";"))).toBeUndefined();
      expect(reads).toBeLessThanOrEqual(2 * Math.log2(n) + 4);
    } finally {
      v.quotes = quotes;
    }
  });
});

// The #1634 second read: a wrapped word recorded at its rewritten name, a
// shell word made a program only by a wrapper and written quoted, and the
// string switch written attached (`cmd /c"…"`, `su -c'…'`).
describe("the #1634 second read: rounds, late shell words and attached switches", () => {
  const MERGE = cmd(/gh\s+pr\s+merge\b/);
  const PUSH = cmd(/git\s+push\b/);

  it.each([
    'nice nice.exe bash -c "gh pr merge 7 --squash"',
    "nice nice.exe nice.exe gh pr merge 7 --squash",
    "nice nice.exe nice.exe gh.exe pr merge 7 --squash",
    'winpty bash.exe -c "nice.exe gh pr merge 7"',
    "sudo nice.exe stdbuf.exe -oL gh.exe pr merge 7",
  ])("keeps every level of a nested wrapper across the rounds: %s", (c) => {
    expect(lexer.has(c, MERGE)).toBe(true);
    expect(trustedMask(c)).toMatch(/\bgh pr merge 7/);
    expect(trustedMask(c)).not.toMatch(/\.exe/);
  });

  it.each([
    'nice "bash" -c "gh pr merge 7 --squash"',
    'winpty "pwsh" -c "gh pr merge 7 --squash"',
    `nice 'bash' -c 'gh pr merge 7'`,
    `find . -exec "sh" -c "gh pr merge 7" \\;`,
  ])("reads the string of a shell word that only a wrapper makes a program: %s", (c) => {
    expect(view(c).fed).not.toEqual([]);
    expect(lexer.has(c, MERGE)).toBe(true);
  });
  it("reads the string of a quoted shell path a wrapper runs", () => {
    const c = `nice "C:/Program Files/Git/bin/bash.exe" -c "git push --tags"`;
    expect(view(c).fed).not.toEqual([]);
    expect(lexer.has(c, PUSH)).toBe(true);
  });

  it.each([
    "cmd /cgh pr merge 7 --squash",
    `cmd /c"gh pr merge 7 --squash"`,
    `cmd //C"gh pr merge 7"`,
    `su -c'gh pr merge 7 --squash' me`,
    `su me -c"gh pr merge 7"`,
    `su -c"gh pr merge 7" me`,
    `fish -c'gh pr merge 7'`,
    `pwsh -c"gh pr merge 7"`,
    `powershell -Command"gh pr merge 7"`,
  ])("reads the string switch with its string attached: %s", (c) => expect(lexer.has(c, MERGE)).toBe(true));
  it("keeps bash's clustered flags as flags, not an attached string", () => {
    expect(lexer.has("bash -cx 'gh pr merge 7'", MERGE)).toBe(true);
    expect(lexer.has("bash -cls", MERGE)).toBe(false);
  });
});

// The #1634 CodeRabbit CLI round: a string attached to its switch says so, so
// a consumer that reads a wrapper's spaced string itself can leave the lexer's
// reading of the attached one alone.
describe("the #1634 CodeRabbit round: an attached string's kind", () => {
  it("marks the first word of a string attached to its switch", () => {
    expect(lexer.programKind("fish -c'gh pr merge 7'", 8)).toEqual({ how: "shell", via: "fish", attached: true });
    expect(lexer.programKind(`pwsh -c"gh pr merge 7"`, 8)).toEqual({ how: "shell", via: "pwsh", attached: true });
    expect(lexer.programKind("cmd /cgh pr merge 7", 6)).toEqual({ how: "shell", via: "cmd", attached: true });
    expect(lexer.programKind("fish -c 'gh pr merge 7'", 9)).toEqual({ how: "shell", via: "fish" });
    expect([...lexer.chainCommands("fish -c'pnpm restart:x'", MASTER, cmd(/pnpm\b/))].map((c) => c.attached)).toEqual([
      true,
    ]);
  });
});

// #1634, CodeRabbit CLI round 4: `stdinShellIn` knew a lone `-o`/`+o` only,
// so a script read on stdin past `-O extglob` or a clustered `-eo pipefail`
// was no script. It reads the shell's options from `OPTION_SPECS` now, as
// `commandOf` does.
describe("a shell reading its script on stdin is read from the shell's own option spec (#1634)", () => {
  const MERGE = cmd(/gh\s+pr\s+merge\b/);
  it.each([
    "echo 'gh pr merge 7' | bash -O extglob",
    "echo 'gh pr merge 7' | bash -eo pipefail",
    "echo 'gh pr merge 7' | bash +o posix",
    "echo 'gh pr merge 7' | bash --rcfile x",
    "echo 'gh pr merge 7' | bash -s -o x",
    "echo 'gh pr merge 7' | sh -eu",
    "echo 'gh pr merge 7' | bash -s a b",
  ])("finds the shell reading its script there, and refuses it (#1659): %s", (c) =>
    expect(lexer.refusedForms(c)).toEqual([{ form: "a printer piped into a shell", shape: expect.any(String) }]),
  );
  it.each([
    "echo 'gh pr merge 7' | bash -O extglob x.sh",
    "echo 'gh pr merge 7' | bash --rcfile x y.sh",
    "echo 'gh pr merge 7' | bash -eo pipefail -c true",
    "echo 'gh pr merge 7' | bash -O extglob </dev/null",
  ])("finds no script on stdin where a file, a string or another input is given: %s", (c) => {
    expect(lexer.has(c, MERGE)).toBe(false);
    expect(lexer.refusedForms(c)).toEqual([]);
  });
  it("exports the option reader the deck-host reader shares", () => {
    const words = ["-eo", "pipefail", "-c", "'gh pr merge 7'", "a"];
    let i = 0;
    const r = lexer.readCommand(lexer.shellSpec("bash"), () => words[i++]);
    expect(r).toMatchObject({ string: 3, offset: 0, attached: false, switch: 2 });
    let j = 0;
    expect(lexer.readCommand(lexer.shellSpec("fish"), () => ["-d", "3", "-c'x'"][j++])).toMatchObject({
      string: 2,
      offset: 2,
      attached: true,
    });
    let k = 0;
    expect(lexer.readCommand(lexer.shellSpec("bash"), () => ["-s", "-o", "x", "a"][k++])).toMatchObject({
      program: undefined,
      string: undefined,
      stdin: "pipe",
    });
    expect(lexer.commandWordsRaw(`bash -c 'a b' "c d" e`, 4)).toEqual(["-c", "'a b'", '"c d"', "e"]);
  });
});

// #1634, CodeRabbit CLI round 5: a shell wrapper's string is one word to the
// shell that hands it on, operators and all; `commandWords` ended it at the first.
describe("wordText decodes one word whole (#1634)", () => {
  it.each([
    ["'cd ../x && pnpm dev:voices'", "cd ../x && pnpm dev:voices"],
    ['"cd ../x; pnpm dev:voices | tee log"', "cd ../x; pnpm dev:voices | tee log"],
    ["$'cd ../x\\npnpm dev:voices'", "cd ../x\npnpm dev:voices"],
    ["-c'cd x && pnpm y'", "-ccd x && pnpm y"],
    ['re\\ start:"stream deck"', "re start:stream deck"],
    ['"a \\"b\\" \\$c \\\\ d"', 'a "b" $c \\ d'],
    ["'it'\\''s'", "it's"],
    ["'unclosed && pnpm", "unclosed && pnpm"],
    ["plain", "plain"],
    ["", ""],
  ])("%j → %j", (word, text) => {
    expect(lexer.wordText(word)).toBe(text);
  });

  it("agrees with commandWords on a word that holds no operator, and keeps one it holds", () => {
    for (const w of ["'a b'", "x\\ y", '"q"r', "$'t\\tu'"]) expect(lexer.wordText(w)).toBe(lexer.commandWords(w, 0)[0]);
    expect(lexer.commandWords("'a && b'", 0)).toEqual(["a && b"]);
    expect(lexer.commandWords("a && b", 0)).toEqual(["a"]);
    expect(lexer.wordText("a && b")).toBe("a && b");
  });
});

describe("commandWordsRaw stops at a limit (#1634)", () => {
  it("reads to the end of the text by default and no further than the limit given", () => {
    const c = "bash -c 'pnpm run y' 'z' w";
    expect(lexer.commandWordsRaw(c, 0)).toEqual(["bash", "-c", "'pnpm run y'", "'z'", "w"]);
    // The words of the `pnpm` inside the string end at the string's close.
    expect(lexer.commandWordsRaw(c, 13, lexer.stringEnd(c, 12))).toEqual(["run", "y"]);
    expect(lexer.commandWordsRaw(c, 13)).toEqual(["run", "y' 'z"]);
  });
});

// #1646: inside a shell-fed string the raw text was read one level deep, so a
// lead assignment whose quoted value holds a blank (`X="a b" gh …`) or a `;`
// ended early, and the program after it was never recorded. The text a shell
// runs is now read as that shell reads it.
describe("a lead's quoted value inside a shell-fed string (#1646)", () => {
  const MERGE = cmd(/gh\s+pr\s+merge\b/);
  const PUSH = cmd(/git\s+push\b/);
  /** The kind of the program word `gh` or `git` at its last occurrence, as {@link lexer.programKind} reads it. */
  const kindAt = (c, word) => lexer.programKind(c, c.lastIndexOf(`${word} `));

  it.each([
    ["bash -c 'X=\"a b\" gh pr merge 7'", { how: "shell", via: "bash" }],
    ["bash -c 'env X=\"a b\" gh pr merge 7'", { how: "shell", via: "bash" }],
    [`bash -c "env X='a b' gh pr merge 7"`, { how: "shell", via: "bash" }],
    ["bash -c 'nice env GH_PAGER=\"less -R\" gh pr merge 7 --squash'", { how: "wrapper", via: "nice" }],
    ["bash -c 'nice env X=\"a;b\" gh pr merge 7'", { how: "wrapper", via: "nice" }],
  ])("records the program after the quoted value: %s", (c, kind) => {
    expect(lexer.has(c, MERGE)).toBe(true);
    expect(kindAt(c, "gh")).toEqual(kind);
  });

  it("records a tag push after a quoted value under a wrapper, and after a wrapper's quoted option value", () => {
    const c = "bash -c 'nice env X=\"a b\" git push origin v1.2.3'";
    expect(lexer.has(c, PUSH)).toBe(true);
    expect(kindAt(c, "git")).toEqual({ how: "wrapper", via: "nice" });
    expect(lexer.has("bash -c 'env -C \"a b\" git push origin v1.2.3'", PUSH)).toBe(true);
  });

  // An ANSI-C string a shell is handed is refused rather than decoded (#1659);
  // in a program word, an escape it cannot read whole stays live (#1606).
  it("reads an ANSI-C escape in a word as live, as a program name reads it", () =>
    expect(lexer.decodeWord(String.raw`$'\x41'`).some((x) => x.live)).toBe(true));

  // The raw text of a string a shell runs is not always the text it reads: an
  // outer double-quoted string carries escaped quotes, a `'\''` splice joins
  // pieces. It is read as the shell reads it (an ANSI-C string, a string
  // inside a string, a printer, a here-string, eval and sudo -s are refused
  // instead, #1659).
  it.each([
    `bash -c "X=\\"a b\\" gh pr merge 7"`,
    String.raw`bash -c 'X='\''a b'\'' gh pr merge 7'`,
    "bash -c X=1' gh pr merge 7'",
    `bash -c "ls; X=\\"a b\\" gh pr merge 7"`,
    `bash -c "nice env X=\\"a;b\\" gh pr merge 7"`,
    "bash -c '2>\"a b\" gh pr merge 7'",
    "bash -c 'X=${Y:-a b} gh pr merge 7'",
    "bash -c 'X=$(echo a b)c gh pr merge 7'",
    "watch 'X=\"a b\" gh pr merge 7'",
    "trap 'X=\"a b\" gh pr merge 7' EXIT",
    String.raw`find . -exec sh -c 'X="a b" gh pr merge 7' \;`,
    "bash -c 'cd x && X=\"a b\" gh pr merge 7'",
    "bash -c 'if true; then X=\"a b\" gh pr merge 7; fi'",
    "bash -c 'X=\"a b\" 2>/dev/null gh pr merge 7'",
    "bash -c 'X=ab 2>/dev/null gh pr merge 7'",
    "bash -c 'exec -a \"my name\" gh pr merge 7'",
  ])("reads the string as the shell it is handed to reads it: %s", (c) => {
    expect(lexer.has(c, MERGE)).toBe(true);
    expect(view(c).unclosedLead).toBe(false);
  });

  // The same misreading outside any shell string: a `${…}` or `$(…)` value with a blank in it.
  it.each(["X=${Y:-a b} gh pr merge 7", "X=$(echo a b)c gh pr merge 7"])(
    "reads a value whose expansion holds a blank at command position: %s",
    (c) => expect(lexer.has(c, MERGE)).toBe(true),
  );

  it.each([
    "bash -c 'X=\"a b gh pr merge 7'",
    `bash -c "X=\\"a b gh pr merge 7"`,
    "bash -c '\"gh pr merge 7'",
  ])("reports a lead whose quote never closes, which the hook cannot read: %s", (c) =>
    expect(view(c).unclosedLead).toBe(true),
  );

  it.each([
    "bash -c 'X=ab gh pr merge 7'",
    String.raw`bash -c 'echo "it'\''s"; gh pr merge 7'`,
    `bash -c 'echo "unclosed'`,
    "gh pr merge 7",
    `X="a b" gh pr merge 7`,
  ])("reports nothing unread where every lead closes its quotes: %s", (c) => expect(view(c).unclosedLead).toBe(false));

  it.each([
    "bash -c 'X=ab gh pr merge 7'",
    "bash -c 'env X=ab gh pr merge 7'",
    "bash -c 'nice env X=ab gh pr merge 7'",
    `X="a b" gh pr merge 7`,
    `nice env X="a b" gh pr merge 7`,
  ])("still reads the lead with no quoted value, and one outside a string: %s", (c) =>
    expect(lexer.has(c, MERGE)).toBe(true),
  );

  it.each([
    "bash -c 'echo \"gh pr merge 7\"'",
    "bash -c 'X=\"a b\" echo gh pr merge 7'",
    "bash -c 'X=\"gh pr merge 7\" true'",
    `bash -c "X='gh pr merge 7' true"`,
    `bash -c "X=\\"gh pr merge 7\\" true"`,
    // echo joins its words: the shell reads `X=a b gh …`, which runs `b`.
    'echo X="a b" gh pr merge 7 | bash',
    // `-c` takes one word: `gh` is the shell's `$0`, never run.
    "bash -c 'X=1' gh pr merge 7",
    // An ANSI-C blank is a blank to the shell that reads the string: it runs `b`.
    String.raw`bash -c $'X=a\x20b gh pr merge 7'`,
  ])("finds no merge where it is a value or an argument: %s", (c) => {
    expect(lexer.has(c, MERGE)).toBe(false);
    expect(lexer.matchAt(c, MERGE)).toBeNull();
  });

  it("records each command a string runs after a separator, as the shell reads the string", () => {
    const c = `bash -c "ls; X=\\"a b\\" gh pr merge 7"`;
    expect(kindAt(c, "gh")).toEqual({ how: "command" });
    expect(lexer.matchAt(c, MERGE)).not.toBeNull();
  });

  it(
    "reads a long run of quoted values, wrappers and strings in time linear in their length",
    { timeout: TIMING_TIMEOUT_MS },
    () => {
      readsLinearly((n) => `bash -c '${'X="a b" '.repeat(n)}gh pr merge 7'`, 2000, MERGE, true);
      readsLinearly((n) => `bash -c "${'X=\\"a b\\" '.repeat(n)}gh pr merge 7"`, 2000, MERGE, true);
      readsLinearly((n) => `bash -c 'nice env ${'X="a;b" '.repeat(n)}gh pr merge 7'`, 2000, MERGE, true);
      readsLinearly((n) => `${"bash -c 'X=\"a b\" true'; ".repeat(n)}echo`, 500, MERGE, false);
      // An unclosed quote in a lead: the value's pieces are each one parse, so
      // a failed token backtracks once per piece, never exponentially.
      readsLinearly((n) => `bash -c 'X=${'"a"'.repeat(n)}"b gh pr merge 7'`, 2000, MERGE, false);
    },
  );

  // A program word a fed string's shell expands is one the hook cannot read,
  // as at top level: listed, so `checkBash` judges it as gh and as git. A
  // substitution or backtick is no word the raw text holds whole, so it was
  // skipped; an escaped `$` in a double-quoted string started no word, and is
  // named by its raw spelling, from its backslash.
  it.each([
    ['bash -c "$(echo gh) pr merge 7"', "$(echo gh)"],
    ['bash -c "`echo gh` pr merge 7"', "`echo gh`"],
    ["bash -c '$(echo gh) pr merge 7'", "$(echo gh)"],
    ["bash -c '`echo gh` pr merge 7'", "`echo gh`"],
    [`bash -c 'X="a b" $(echo gh) pr merge 7'`, "$(echo gh)"],
    [String.raw`bash -c "\$GH pr merge 7"`, String.raw`\$GH`],
  ])("lists a program word the string's shell expands as unreadable: %s", (c, word) =>
    expect(lexer.unreadablePrograms(c).map((u) => u.word)).toContain(word),
  );

  it.each(["bash -c 'echo \"$(date)\"'", "bash -c 'X=$(echo a b) true'", 'bash -c "echo $(date)"'])(
    "lists no argument or assignment that expands as a program: %s",
    (c) => expect(lexer.unreadablePrograms(c)).toEqual([]),
  );

  // A program word starting with a backslash: its rewrite drops the backslash,
  // and the next round read the word from its name and found the raw backslash
  // ahead of it, so the recorded starts alternated and never settled.
  it.each([
    String.raw`bash -c '\cp -f a b'`,
    String.raw`bash -c "\ls -la"`,
    String.raw`bash -c 'X=1 \ls'`,
    String.raw`bash -c $'\\x67h pr merge 7'`,
    String.raw`bash -c '\gh pr merge 7'`,
    String.raw`bash -c "nice \gh pr merge 7"`,
  ])("settles a program word that starts with a backslash: %s", (c) => expect(view(c).unsettled).toBe(false));

  // Read as its shell reads it, and refused for the escape in its name (#1659).
  it("reads the program after a backslash as its shell does, and refuses the escape", () => {
    const c = String.raw`bash -c '\gh pr merge 7'`;
    expect(lexer.has(c, MERGE)).toBe(true);
    expect(lexer.refusedForms(c).map((r) => r.form)).toEqual(["a program word that is not its plain name"]);
  });

  // A program spelled so the raw text cannot show the name its shell runs.
  it.each([
    [String.raw`bash -c "\"gh\" pr merge 7"`, String.raw`\"gh\"`, "gh"],
    [String.raw`pwsh -Command "& \"C:\Program Files\GitHub CLI\gh.exe\" pr merge 7"`, null, "gh"],
    [String.raw`bash -c "\"git\" push origin v1.2.3"`, String.raw`\"git\"`, "git"],
  ])("lists a program escaped within its string with the name its shell runs: %s", (c, word, name) => {
    const { respelled, spliced } = lexer.respelledPrograms(c);
    expect(spliced).toEqual([]);
    expect(respelled.map((w) => w.name)).toEqual([name]);
    if (word) expect(respelled[0].word).toBe(word);
  });

  it.each([
    `bash -c 'g'"h"' pr merge 7'`,
    `bash -c 'X="a b" g'"h"' pr merge 7'`,
    `bash -c 'echo hi; g'"h"' pr merge 7'`,
    `bash -c 'echo hi; /usr/'"bin"'/gh pr merge 7'`,
  ])("lists a program spliced from quoted pieces, its string read whole (#1659): %s", (c) => {
    expect(lexer.refusedForms(c)).toEqual([]);
    expect(lexer.respelledPrograms(c).spliced).toHaveLength(1);
  });

  it.each([
    "bash -c 'gh pr merge 7'",
    `bash -c "X='a b' gh pr merge 7"`,
    String.raw`bash -c 'X='\''a b'\'' gh pr merge 7'`,
  ])("lists nothing respelled where the raw text spells the program: %s", (c) =>
    expect(lexer.respelledPrograms(c)).toEqual({ respelled: [], spliced: [] }),
  );

  it("sets no unclosed lead for cmd.exe, which has no single quotes", () => {
    expect(view(`cmd /c "it's.bat"`).unclosedLead).toBe(false);
    expect(view(`bash -c "it's"`).unclosedLead).toBe(true);
  });

  // Second read on 9b4dfb0de: a lead value nesting a quote in a substitution
  // or expansion inside `"…"`, or a substitution three deep, ended early in
  // the lead regex. The lead is now stepped with the one word reader, at top
  // level too, so the program after it is a known program position.
  it.each([
    `bash -c 'X="$(echo "a b")" gh pr merge 7'`,
    `bash -c 'X="\${Y:-"a b"}" gh pr merge 7'`,
    "bash -c 'X=a$(a $(b $(c)))b gh pr merge 7'",
    'bash -c \'X="`echo "a b"`" gh pr merge 7\'',
    'X=$(a $(b $(c)))"" gh pr merge 7',
    `X="\${Y:-"a b"}" gh pr merge 7`,
    "nice env X=a$(a $(b $(c)))b gh pr merge 7",
  ])("finds the program after a lead value that nests: %s", (c) => {
    expect(lexer.has(c, MERGE)).toBe(true);
    expect(view(c).unclosedLead).toBe(false);
  });

  it("finds a push after such a value, in a string and at top level", () => {
    expect(lexer.has(`bash -c 'X="$(echo "a b")" git push origin v1.2.3'`, PUSH)).toBe(true);
    expect(lexer.has('X=$(a $(b $(c)))"" git push origin v1.2.3', PUSH)).toBe(true);
  });

  it.each([`bash -c 'X="$(echo "a b")" echo gh pr merge 7'`, "X=$(a $(b $(c)))b echo gh pr merge 7"])(
    "finds no merge where the word after the value is an argument: %s",
    (c) => expect(lexer.has(c, MERGE)).toBe(false),
  );

  // A `#` comment and a heredoc body hold no command: a quote in them closes
  // nothing. The strings hold real newlines, since an ANSI-C `$'…'` string is
  // refused rather than read (#1659).
  it.each([
    `bash -c "ls #'\ngh pr merge 7"`,
    `bash -c "cat <<E\nx it's\nE\ngh pr merge 7"`,
    `bash -c "cat <<'E'\nx it's\nE\ngh pr merge 7"`,
    `bash -c "cat <<-E\n\tx it's\n\tE\ngh pr merge 7"`,
  ])("reads the command after a comment or a heredoc body: %s", (c) => {
    expect(lexer.has(c, MERGE)).toBe(true);
    expect(view(c).unclosedLead).toBe(false);
  });

  it.each([
    `bash -c "cat <<E\n'x\nE\necho hi"`,
    `bash -c "#it's\nls"`,
    String.raw`bash -c 'echo a#b'`,
  ])("reads no command, and no unclosed quote, in a comment or a heredoc body: %s", (c) => {
    expect(lexer.has(c, MERGE)).toBe(false);
    expect(view(c).unclosedLead).toBe(false);
  });

  it("reports a heredoc operator with no delimiter, which the shell refuses", () =>
    expect(view(`bash -c "cat <<\ngh pr merge 7"`).unclosedLead).toBe(true));

  it("reads a shift in an arithmetic command as no heredoc", () =>
    expect(lexer.has(`bash -c "(( x = 1 << 3 ))\ngh pr merge 7"`, MERGE)).toBe(true));

  // An escaped `$` opens no ANSI-C string: `\$'x\'` is `$` and a plain `'x\'`.
  it("reads an escaped `$` before a quote as no ANSI-C opener", () => {
    const c = String.raw`echo -e \$'x\' 'y\ngh pr merge 7' | bash`;
    expect(view(c).quotes.map(([a, b]) => c.slice(a, b + 1))).toEqual([
      String.raw`'x\'`,
      String.raw`'y\ngh pr merge 7'`,
    ]);
    expect(lexer.ansiOpen(c, c.indexOf("'"))).toBe(false);
    expect(lexer.ansiOpen("$'x'", 1)).toBe(true);
    expect(lexer.ansiOpen(String.raw`\\$'x'`, 3)).toBe(true);
  });

  // Round 3 (#1646): a rule's shape is also tested in the decoded text of each
  // string a shell runs, so a command its shell joins is found. Since #1659
  // only cmd.exe, PowerShell, `watch` and `parallel` join words; `eval`, a
  // printer and an ANSI-C string are refused rather than read.
  it.each([`cmd /c "gh pr" merge 7`, `pwsh -Command gh "pr merge" 7`])(
    "finds a merge its shell reads only once it joins the words: %s",
    (c) => {
      expect(lexer.has(c, MERGE)).toBe(true);
      const m = lexer.matchAt(c, MERGE);
      expect(m.decoded).toMatch(/^gh pr merge 7/);
      expect(lexer.takeDecodedHits(c).size).toBeGreaterThan(0);
    },
  );

  it("finds a push the same way, with the push as its shell reads it", () => {
    const c = `cmd /c "git push" origin v1.2.3`;
    expect(lexer.matchAt(c, PUSH).decoded).toBe("git push origin v1.2.3");
  });

  it.each([`cmd /c "echo gh pr" merge 7`, `pwsh -Command echo "gh pr merge 7"`])(
    "finds no merge where the decoded text only mentions it: %s",
    (c) => expect(lexer.has(c, MERGE)).toBe(false),
  );

  it("records no decoded hit where the string reads as it is written", () => {
    const c = "bash -c 'gh pr merge 7'";
    lexer.takeDecodedHits(c);
    expect(lexer.has(c, MERGE)).toBe(true);
    expect(lexer.matchAt(c, MERGE).decoded).toBeUndefined();
    expect(lexer.takeDecodedHits(c).size).toBe(0);
    // An outer expansion is read as written at top level too: no hit for it.
    const d = `bash -c "pnpm test $FILE"`;
    lexer.has(d, cmd(/pnpm\s+test\b/));
    expect(lexer.takeDecodedHits(d).size).toBe(0);
  });

  it("drops a decoded hit a consumer excuses", () => {
    const c = `cmd /c "gh pr" merge 7`;
    lexer.takeDecodedHits(c);
    const m = lexer.matchAt(c, MERGE);
    lexer.excuseDecodedHit(c, MERGE, m.occurrence);
    expect(lexer.takeDecodedHits(c).size).toBe(0);
  });

  it.each([
    "bash -c 'constructor -x y'",
    "constructor -x y",
    "bash -c 'toString -u v gh pr merge 7'",
    "__proto__ -x y gh pr merge 7",
    "bash -c 'hasOwnProperty -x y'",
    "valueOf --unset x y",
  ])("reads a command word named like an Object.prototype member as a plain word: %s", (c) => {
    lexer.view.last = undefined;
    expect(() => view(c)).not.toThrow();
    expect(lexer.has(c, MERGE)).toBe(false);
  });

  it(
    "reads the whole words of a long cmd.exe join in time linear in their count",
    { timeout: TIMING_TIMEOUT_MS },
    () => {
      readsLinearly((n) => `cmd /c ${'"echo ready" '.repeat(n)}`, 1500, MERGE, false);
    },
  );

  // Round 6 (#1646, the CodeRabbit CLI finding at 3212c3d97).
  describe("the directory a string's `cd`s leave", () => {
    const bash = (text) => ({ text, shell: lexer.BASH });
    it("follows each cd and pushd at the start of a segment, as the typed command's are", () => {
      expect(lexer.dirAfter([bash("cd ../ir-5; ")], MASTER)).toBe(tree("ir-5"));
      expect(lexer.dirAfter([bash("true && pushd ../ir-5 && cd sub && ")], MASTER)).toBe(tree("ir-5", "sub"));
      expect(lexer.dirAfter([bash("cd ../ir-5; "), bash("cd ../ir-6; ")], MASTER)).toBe(tree("ir-6"));
      expect(lexer.dirAfter([bash("echo cd x; (cd ../ir-5); ")], MASTER)).toBe(MASTER);
      expect(lexer.dirAfter([{ text: "Set-Location ../ir-5; ", shell: POWERSHELL }], MASTER)).toBe(tree("ir-5"));
    });

    it.each(['cd "$X"; ', "cd -; ", "cd; ", "pushd; ", "popd; ", "cd ~/x; ", "cd -P ../ir-5; ", "cd `pwd`; "])(
      "cannot know where `%s` leaves it",
      (text) => expect(lexer.dirAfter([bash(text)], MASTER)).toBeUndefined(),
    );

    const where = (c) => [...lexer.chainCommands(c, MASTER, cmd(/pnpm\b/))].map(({ base, lost }) => ({ base, lost }));
    it("moves a command a string runs by the cds ahead of it there, once", () => {
      expect(where(`bash -c 'cd ../ir-5; pnpm test'`)).toEqual([{ base: tree("ir-5"), lost: undefined }]);
      // A cd the chain ranges read inside the string moves it once, not twice.
      expect(where("su -c 'true; cd sub && pnpm x'")).toEqual([{ base: path.join(MASTER, "sub"), lost: undefined }]);
      expect(where("cd ../ir-5 && bash -c 'cd sub; pnpm x'")).toEqual([{ base: tree("ir-5", "sub"), lost: undefined }]);
      expect(where(`bash -c 'cd ../ir-5; pnpm test; cd ../ir-6; pnpm x'`).map((x) => x.base)).toEqual([
        tree("ir-5"),
        tree("ir-6"),
      ]);
    });

    it("marks a command lost where a cd ahead of it in its string cannot be known", () =>
      expect(where(`bash -c 'cd "$X"; pnpm test'`)).toEqual([{ base: MASTER, lost: true }]));
  });

  it("decodes every ANSI-C escape of a word a wrapper is handed", () => {
    expect(lexer.wordText(String.raw`$'cd\x20../x;\040pnpm\ttest'`)).toBe("cd ../x; pnpm\ttest");
    expect(lexer.wordText(String.raw`$'it\'s'`)).toBe("it's");
  });

  describe("a cd in a pipeline or a compound command", () => {
    const bash = (text) => ({ text, shell: lexer.BASH });
    it.each(["cd ../ir-5 | cat; ", "cd ../ir-5 |& cat; ", "echo cd x; (cd ../ir-5); "])(
      "moves nothing after `%s`",
      (text) => expect(lexer.dirAfter([bash(text)], MASTER)).toBe(MASTER),
    );
    it("moves after an or-list's cd", () =>
      expect(lexer.dirAfter([bash("cd ../ir-5 || exit; ")], MASTER)).toBe(tree("ir-5")));
    it.each(["{ cd ../ir-5; ", "if true; then cd ../ir-5; fi; ", "(cd ../ir-5; ", "! cd ../ir-5; "])(
      "cannot know where `%s` leaves it",
      (text) => expect(lexer.dirAfter([bash(text)], MASTER)).toBeUndefined(),
    );
    it("moves no command the typed chain runs after a cd in a pipeline", () => {
      const bases = (c) => [...lexer.chainCommands(c, MASTER, cmd(/pnpm\b/))].map((x) => x.base);
      expect(bases("cd ../ir-5 | cat; pnpm x")).toEqual([MASTER]);
      expect(bases("cd ../ir-5; pnpm x")).toEqual([tree("ir-5")]);
      expect(lexer.cwdAt("cd ../ir-5 | cat; pnpm x", MASTER, 18)).toBe(MASTER);
    });

    // Whether bash runs a final stage in itself (`lastpipe`, no job control)
    // the hook cannot see: a profile or BASH_ENV may set it, and a `shopt` in
    // the command may come after the pipeline (CodeRabbit on PR #1788, the
    // CodeRabbit CLI at ef788cc00).
    it("leaves a pipeline's final-stage cd unknown, lastpipe or not, and follows no other stage's", () => {
      expect(lexer.dirAfter([bash("true | cd ../ir-5; ")], MASTER)).toBeUndefined();
      expect(lexer.dirAfter([bash("shopt -s lastpipe; true | cd ../ir-5; ")], MASTER)).toBeUndefined();
      expect(lexer.dirAfter([bash("shopt -s lastpipe; cd ../ir-5 | cat; ")], MASTER)).toBe(MASTER);
      const where = (c) => [...lexer.chainCommands(c, MASTER, cmd(/pnpm\b/))].map(({ base, lost }) => ({ base, lost }));
      expect(where("true | cd ../ir-5; pnpm x")).toEqual([{ base: tree("ir-5"), lost: true }]);
      expect(where("bash -c 'true | cd ../ir-5; pnpm x'")).toEqual([{ base: MASTER, lost: true }]);
      expect(where("shopt -s lastpipe; true | cd ../ir-5; pnpm x")).toEqual([{ base: tree("ir-5"), lost: true }]);
      expect(where("true | cd ../ir-5; shopt -s lastpipe; pnpm x")).toEqual([{ base: tree("ir-5"), lost: true }]);
      expect(where("true | cd ../ir-5 | cat; pnpm x")).toEqual([{ base: MASTER, lost: undefined }]);
      expect(lexer.cwdAt("true | cd ../ir-5; pnpm x", MASTER, 19)).toBeUndefined();
      expect(lexer.cwdAt("shopt -s lastpipe; true | cd ../ir-5; pnpm x", MASTER, 38)).toBeUndefined();
    });
  });

  // The PR #1788 review (CodeRabbit at 7e8cd2e37).
  describe("a cd that may not run, or runs in a child shell", () => {
    const bash = (text) => ({ text, shell: lexer.BASH });
    const where = (c) => [...lexer.chainCommands(c, MASTER, cmd(/pnpm\b/))].map(({ base, lost }) => ({ base, lost }));

    it("leaves the directory unknown after a cd a short-circuit may skip", () => {
      expect(lexer.dirAfter([bash("false && cd ../ir-5; ")], MASTER)).toBeUndefined();
      expect(lexer.dirAfter([bash("true || cd ../ir-5; ")], MASTER)).toBeUndefined();
      expect(where("false && cd ../ir-5; pnpm x")).toEqual([{ base: tree("ir-5"), lost: true }]);
      expect(lexer.cwdAt("false && cd ../ir-5; pnpm x", MASTER, 21)).toBeUndefined();
    });

    it("follows a conditional cd into what can only run after it", () => {
      expect(lexer.dirAfter([bash("true && cd ../ir-5 && ")], MASTER)).toBe(tree("ir-5"));
      expect(where("true && cd ../ir-5 && pnpm x")).toEqual([{ base: tree("ir-5"), lost: undefined }]);
      expect(where("cd ../ir-5 && pnpm x")).toEqual([{ base: tree("ir-5"), lost: undefined }]);
      expect(where("cd ../ir-5 || exit; pnpm x")).toEqual([{ base: tree("ir-5"), lost: undefined }]);
    });

    // The PR #1788 re-review (CodeRabbit at 578854b81): `||` runs what follows after the cd failed.
    it("reads a cd by the outcome that reaches the command", () => {
      expect(lexer.dirAfter([bash("cd ../ir-5 || ")], MASTER)).toBe(MASTER);
      expect(lexer.dirAfter([bash("cd ../ir-5 && ")], MASTER)).toBe(tree("ir-5"));
      expect(lexer.dirAfter([bash("cd ../ir-5 && true || ")], MASTER)).toBeUndefined();
      expect(lexer.dirAfter([bash("cd ../ir-5 || true && ")], MASTER)).toBeUndefined();
      expect(lexer.dirAfter([bash("cd ../ir-5 || exit; ")], MASTER)).toBe(tree("ir-5"));
      expect(where("cd ../ir-5 || pnpm x")).toEqual([{ base: MASTER, lost: undefined }]);
      expect(where("cd ../ir-5 && true || pnpm x")[0].lost).toBe(true);
      expect(lexer.cwdAt("cd ../ir-5 || pnpm x", MASTER, 14)).toBe(MASTER);
    });

    it("moves the typed command by no cd a child shell's string runs", () => {
      expect(where("bash -c 'true; cd ../ir-5; true'; pnpm x")).toEqual([{ base: MASTER, lost: undefined }]);
      expect(where("cd ../ir-6 && bash -c 'true; cd ../ir-5; true'; pnpm x")).toEqual([
        { base: tree("ir-6"), lost: undefined },
      ]);
      expect(lexer.cwdAt("bash -c 'true; cd ../ir-5; true'; pnpm x", MASTER, 34)).toBe(MASTER);
      // The child's own command still runs where its cd moved it.
      expect(where("bash -c 'true; cd ../ir-5; pnpm x'")).toEqual([{ base: tree("ir-5"), lost: undefined }]);
    });

    it.each([
      [String.raw`bash -c 'echo a\ #b; gh pr merge 7'`, true],
      [String.raw`bash -c 'echo a\;#b; gh pr merge 7'`, true],
      [String.raw`bash -c 'echo a #b gh pr merge 7'`, false],
    ])("starts a comment only at a word's start, past an escaped blank or separator: %s", (c, merges) =>
      expect(lexer.has(c, MERGE)).toBe(merges),
    );
  });
});

// #1659, the lexer's stopping rule: every form below was read by a reader of
// its own (a printer's output, eval's joined words, a here-string, an ANSI-C
// or spliced string, a string inside a string, sudo -s's escaped join). Those
// readers are deleted; each form is found and refused, whatever it holds.
describe("the stopping rule: a form the lexer does not read is found, and refused (#1659)", () => {
  const PRINTER = "a printer piped into a shell";
  const STDIN = "a shell reading its script from stdin";
  const HERE_STRING = "a shell reading its script from a here-string";
  const HEREDOC = "a shell reading its script from a heredoc";
  const EVAL = "eval";
  const SUDO = "a sudo that runs a shell";
  const ANSI = "an ANSI-C string";
  const LOCALE = "a locale string";
  const NESTED = "a string inside a string";
  const SUBSTITUTION = "a substitution at command position in a string";
  const PROGRAM = "a program word that is not its plain name";

  it.each([
    [`echo 'gh pr merge 7' | bash`, PRINTER],
    [String.raw`printf '%s\n' 'gh pr merge 7' | sh`, PRINTER],
    [`echo 'pnpm exec vitest run' | bash`, PRINTER],
    [`echo 'X="a b" gh pr merge 7' | bash`, PRINTER],
    [`echo 'X="a gh pr merge 7' | bash`, PRINTER],
    [`echo '"gh" pr merge 7' | bash`, PRINTER],
    [String.raw`printf 'X="a b" gh pr merge 7\n' | sh`, PRINTER],
    [String.raw`echo -e 'x\ngh pr merge 7' | bash`, PRINTER],
    [String.raw`echo -ne 'x\ngh pr merge 7' | bash`, PRINTER],
    [String.raw`echo "-e" 'first\ngh pr merge 7' | bash`, PRINTER],
    [String.raw`echo -e'' 'first\ngh pr merge 7' | bash`, PRINTER],
    [String.raw`echo 'x\ngh pr merge 7' | bash`, PRINTER],
    [String.raw`echo 'echo first;' 2>/dev/null 'gh pr merge 7' | bash`, PRINTER],
    [String.raw`printf 'x\012gh pr merge 7' | sh`, PRINTER],
    [String.raw`printf '%b' 'x\ngh pr merge 7' | bash`, PRINTER],
    [String.raw`printf '%s\ngh pr merge 7\n' x | bash`, PRINTER],
    [String.raw`printf '%d\ngh pr merge 7\n' "$N" | bash`, PRINTER],
    [String.raw`printf '%*s\n' 5 x | bash`, PRINTER],
    [String.raw`printf '%999999999s\ngh pr merge 7' x | bash`, PRINTER],
    [`printf '%s\\n' 'echo 😀; gh pr merge 7' | bash`, PRINTER],
    [String.raw`printf '%d\n' >"$(gh pr merge 7)" 5 | bash`, PRINTER],
    [String.raw`printf '%s -c "gh pr merge 7"\n' bash | bash`, PRINTER],
    [String.raw`printf 'git push origin %s\n' main v1.2.3 | bash`, PRINTER],
    [String.raw`printf 'cd %s; pnpm %s\n' ../ir-5 test | bash`, PRINTER],
    [String.raw`printf 'echo a\\ #b; gh pr %s 7\n' merge | bash`, PRINTER],
    [`echo 'gh pr merge 7' | sudo -u me bash`, SUDO],
    [`cat steps.txt | bash`, STDIN],
    [`git show HEAD:run.sh | sh -s -- x`, STDIN],
    [`echo 'gh pr merge 7' | { cd x && bash; }`, STDIN],
    [`echo x | ( cat; ) | bash -O extglob`, STDIN],
    [`cat x | pwsh -NoProfile`, STDIN],
    [`'gh pr merge 7' | powershell -Command -`, STDIN],
    [`bash <<< 'gh pr merge 7'`, HERE_STRING],
    [`bash <<< "X=\\"a b\\" gh pr merge 7"`, HERE_STRING],
    [`sh -s <<< 'ls'`, HERE_STRING],
    [`bash <<'EOF'\ngh pr merge 7\nEOF`, HEREDOC],
    [`bash -s <<-EOF\n\tls\n\tEOF`, HEREDOC],
    [`eval "gh pr merge 7"`, EVAL],
    [`eval gh pr merge 7`, EVAL],
    [`eval 'npx vitest'`, EVAL],
    [`eval "X=\\"a b\\"" gh pr merge 7`, EVAL],
    [String.raw`eval "\$GH pr merge 7"`, EVAL],
    [`eval "gh pr" merge 7`, EVAL],
    [`eval 'true; cd ../ir-5'; pnpm x`, EVAL],
    [`bash -c 'eval "$CMD"'`, EVAL],
    [`sudo -s X="a b" gh pr merge 7`, SUDO],
    [`sudo -s echo X=1 gh pr merge 7`, SUDO],
    [`sudo -s env X=1 gh pr merge 7`, SUDO],
    [`sudo --login ls`, SUDO],
    [`sudo -Ei ls`, SUDO],
    [`sudo bash -c 'ls'`, SUDO],
    [`sudo -u me sh x.sh`, SUDO],
    [`bash -c 'sudo -s ls'`, SUDO],
    [String.raw`bash -c $'ls\ngh pr merge 7'`, ANSI],
    [String.raw`bash -c $'X=\'a b\' gh pr merge 7'`, ANSI],
    [String.raw`bash -c $'gh\x20pr merge 7'`, ANSI],
    [String.raw`bash -c $'g\x68 pr merge 7'`, ANSI],
    [String.raw`bash -c $'cat <<E\nx it\'s\nE\ngh pr merge 7'`, ANSI],
    [String.raw`bash -c $'cd\x20../ir-5; pnpm test'`, ANSI],
    [String.raw`pwsh -Command $'gh\x20pr merge 7'`, ANSI],
    [`bash -c $"gh pr merge 7"`, LOCALE],
    // A program word that ends in a path separator names no program (#1787 item 3's shape).
    [`pwsh -Command "& /"C:/tools/gh.exe/" pr merge 7"`, PROGRAM],
    [`bash -c 'ls; ./tools/ pr merge 7'`, PROGRAM],
    [`bash -c "sh -c 'X=\\"a b\\" gh pr merge 7'"`, NESTED],
    [`bash -c "sh -c 'nice env X=\\"a;b\\" gh pr merge 7'"`, NESTED],
    [`winpty bash.exe -c "cmd.exe /c gh pr merge 7"`, NESTED],
    [`bash -c 'cat x | bash'`, NESTED],
    [`bash -c 'xargs sh -c "ls"'`, NESTED],
    [`bash -c 'trap "ls" EXIT; ls'`, NESTED],
    [`pwsh -Command "powershell -Command ls"`, NESTED],
    [`bash -c "$(echo gh) pr merge 7"`, SUBSTITUTION],
    [`bash -c '$(echo gh) pr merge 7'`, SUBSTITUTION],
    ["bash -c '`echo gh` pr merge 7'", SUBSTITUTION],
    [`bash -c 'ls; $(echo gh) pr merge 7'`, SUBSTITUTION],
    [String.raw`bash -c '\gh pr merge 7'`, PROGRAM],
    [String.raw`bash -c 'g\h pr merge 7'`, PROGRAM],
    [`bash -c '$GH pr merge 7'`, PROGRAM],
    [String.raw`bash -c "\$GH pr merge 7"`, PROGRAM],
    [`bash -c "$GH pr merge 7"`, PROGRAM],
    [`bash -c 'X="a b" "$GH" pr merge 7'`, PROGRAM],
    [`bash -c 'nice $GH pr merge 7'`, PROGRAM],
    [`pwsh -Command "& $gh pr merge 7"`, PROGRAM],
  ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));

  it("refuses PowerShell's eval from the PowerShell tool and in a PowerShell string, where it is one", () => {
    expect(lexer.refusedForms(`iex "ls"`, lexer.POWERSHELL)[0]?.form).toBe(EVAL);
    expect(lexer.refusedForms(`Invoke-Expression 'ls'`, lexer.POWERSHELL)[0]?.form).toBe(EVAL);
    expect(lexer.refusedForms(`iex -S mix`)).toEqual([]);
    expect(lexer.refusedForms(`pwsh -Command "iex 'ls'"`)[0]?.form).toBe(EVAL);
  });

  it.each([
    `bash -c 'gh pr merge 7'`,
    `timeout 1500 sh -c 'pnpm install && pnpm build'`,
    // A splice of quoted pieces and outer expansions at the level the string is
    // handed over is read, re-opened under the stopping rule's clause (#1659).
    `timeout 600 bash -c 'until test -s '"$OUT"'/done.txt; do sleep 30; done'`,
    `bash -c 'X='\\''a b'\\'' gh pr merge 7'`,
    `bash -c X=1' gh pr merge 7'`,
    `cmd /c dir "a"'b'`,
    `powershell -NoProfile -Command '$p = Get-Process -Name ''node''; $p.Count'`,
    `bash -o pipefail -c "pnpm test | tail -5"`,
    `bash -c "X=\\"a b\\" gh pr merge 7"`,
    `bash -c '"gh" pr merge 7'`,
    `bash -c "\\"gh\\" pr merge 7"`,
    `bash -c '/usr/bin/gh pr merge 7'`,
    `bash -c '"$HOME/bin/tool" x'`,
    `bash -c 'echo $(gh pr merge 7)'`,
    `bash -c 'case "$s" in MERGED*) echo m;; "OPEN "*) echo o;; esac'`,
    `bash -c 'ls *.txt'`,
    `bash scripts/run.sh`,
    `bash "$SCRIPT"`,
    `bash < script.sh`,
    `bash -c "cat <<EOF\nx\nEOF"`,
    `cat x | grep y | sh -c 'wc -l'`,
    `powershell -NoProfile -Command "Get-ChildItem"`,
    `powershell -NoProfile -Command '$p = Get-Process; $p | ?{$_.Id -gt 1}; [Math]::Min(1, 2)'`,
    String.raw`powershell -Command "& \"C:\Program Files\GitHub CLI\gh.exe\" pr view 7"`,
    `pwsh -File x.ps1`,
    `cmd /c "dir"`,
    `cmd /c dir /b`,
    String.raw`cmd /c "C:\tools\x.bat" -y`,
    `su -c 'ls' me`,
    `watch -n 5 'ls -la'`,
    `trap 'rm -f x' EXIT`,
    String.raw`find . -name x -exec rm {} \;`,
    String.raw`find . -exec sh -c 'ls "$1"' _ {} \;`,
    `xargs sh -c 'ls'`,
    `sudo apt-get update`,
    `sudo -u me gh pr view 7`,
    `nice bash -c 'ls'`,
    `$PY script.py`,
    `"$FF" -i x`,
    `source "$HOME/.nvm/nvm.sh"`,
    `echo 'gh pr merge 7' > notes.txt`,
    `grep -q x <<< "$(gh pr view 7)"`,
  ])("reads and refuses nothing in a form agents type: %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));

  it("tells a heredoc a shell reads from a file or descriptor it reads", () => {
    const read = (words) => {
      let i = 0;
      return lexer.readCommand(lexer.shellSpec("bash"), () => words[i++]).stdin;
    };
    expect(read(["<<EOF"])).toBe("heredoc");
    expect(read(["<<-", "EOF"])).toBe("heredoc");
    expect(read(["<", "f"])).toBe("other");
    expect(read(["<<<", "'x'"])).toBe("hereString");
    expect(read(["<<<"])).toBe("hereString");
    expect(read([])).toBe("pipe");
  });

  // Review findings on #1659: a shell reading its script from stdin by a path
  // or a descriptor, or from a process substitution, passed every rule.
  describe("a shell reading its script from a stream it names", () => {
    const PROCESS = "a shell reading its script from a process substitution";
    const DESCRIPTOR = "a shell reading its script from a descriptor";

    it.each([
      [`echo 'gh pr merge 7 --squash' | bash /dev/stdin`, PRINTER],
      [`echo 'gh pr merge 7 --squash' | bash /proc/self/fd/0`, PRINTER],
      [`echo 'gh pr merge 7 --squash' | bash /dev/fd/0`, PRINTER],
      [`echo 'gh pr merge 7 --squash' | sh "/dev/stdin"`, PRINTER],
      [`echo 'gh pr merge 7 --squash' | bash //dev/./stdin`, PRINTER],
      [`echo 'gh pr merge 7 --squash' | bash < /dev/stdin`, PRINTER],
      [`echo 'gh pr merge 7 --squash' | bash 0</dev/stdin`, PRINTER],
      [`echo 'gh pr merge 7 --squash' | bash -O extglob /proc/$$/fd/0`, PRINTER],
      [`cat steps.txt | bash /dev/stdin`, STDIN],
      [`bash /dev/stdin`, STDIN],
      [`bash /dev/stdin <<< 'gh pr merge 7'`, HERE_STRING],
      [`bash /dev/fd/3`, DESCRIPTOR],
      [`bash /proc/self/fd/9 3<x`, DESCRIPTOR],
      [`bash <(echo gh pr merge 7 --squash)`, PROCESS],
      [`sh <(echo gh pr merge 7 --squash)`, PROCESS],
      [`bash -O extglob <(echo gh pr merge 7)`, PROCESS],
      [`bash < <(echo gh pr merge 7 --squash)`, PROCESS],
      [`bash 0< <(echo gh pr merge 7 --squash)`, PROCESS],
      [`exec 3<<<'gh pr merge 7'; bash <&3`, DESCRIPTOR],
      [`bash <&3 3<<<'gh pr merge 7'`, DESCRIPTOR],
      [`bash 0<&3`, DESCRIPTOR],
      [`bash <& 3`, DESCRIPTOR],
      [`bash <&"$FD"`, DESCRIPTOR],
      [`bash -c 'bash <(echo ls)'`, PROCESS],
      [`bash -c 'sh /dev/fd/3'`, DESCRIPTOR],
      // PowerShell reads its command from stdin for a bare `-` (pwsh's `-File -`,
      // powershell.exe's `-Command -`), whatever comes before it.
      [`'gh pr merge 7 --squash' | pwsh -`, STDIN],
      [`'gh pr merge 7 --squash' | pwsh -NoProfile -`, STDIN],
      [`'gh pr merge 7 --squash' | powershell -`, STDIN],
      [`echo 'gh pr merge 7 --squash' | pwsh -`, PRINTER],
      [`pwsh -`, STDIN],
      [`pwsh -File -`, STDIN],
      [`powershell -NoProfile -f -`, STDIN],
      [`powershell -Command -`, STDIN],
      [`bash -c 'pwsh -'`, NESTED],
    ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));

    it.each([
      `bash x.sh`,
      `bash scripts/x.sh arg`,
      `sh -e .husky/pre-commit`,
      `bash < file.sh`,
      `bash /dev/null`,
      `bash ./dev/stdin`,
      `cat file | sh -c 'wc -l'`,
      `diff <(ls a) <(ls b)`,
      `bash -c 'diff <(ls a) <(ls b)'`,
      `bash x.sh <(ls)`,
      `bash <&0`,
      `bash <&-`,
      `pwsh -File x.ps1`,
      `pwsh -NoProfile -File scripts/x.ps1 -`,
    ])("reads and refuses nothing where the script is a file or a string: %s", (c) =>
      expect(lexer.refusedForms(c)).toEqual([]),
    );

    it("reads a shell's string past a value an option takes from a substitution", () => {
      const MERGE = cmd(/gh\s+pr\s+merge\b/);
      expect(lexer.has(`bash --rcfile $(x) -c 'gh pr merge 7 --squash'`, MERGE)).toBe(true);
      expect(lexer.has(`bash -o \`x\` -c 'gh pr merge 7 --squash'`, MERGE)).toBe(true);
      expect(lexer.has(`bash --rcfile x$(y)z -c 'gh pr merge 7 --squash'`, MERGE)).toBe(true);
    });

    it("tells the stream a shell's stdin is redirected from", () => {
      const read = (words) => {
        let i = 0;
        return lexer.readCommand(lexer.shellSpec("bash"), () => words[i++]).stdin;
      };
      expect(read(["<&3"])).toBe("descriptor");
      expect(read(["0<&", "3"])).toBe("descriptor");
      expect(read(["<&0"])).toBe("pipe");
      expect(read(["<&-"])).toBe("other");
      expect(read(["<", "/dev/stdin"])).toBe("pipe");
      expect(read(["<<<", "x", "<", "/dev/fd/0"])).toBe("hereString");
      expect(read(["<", "/dev/fd/4"])).toBe("descriptor");
      expect(read(["<", "<(echo x)"])).toBe("substitution");
      expect(read(["<", "x.sh"])).toBe("other");
    });

    it("tells the stream a shell's script file names", () => {
      const read = (name, words) => {
        let i = 0;
        return lexer.readCommand(lexer.shellSpec(name), () => words[i++]).script;
      };
      expect(read("bash", ["<(echo x)"])).toBe("substitution");
      expect(read("bash", ["/dev/stdin"])).toBe("stdin");
      expect(read("bash", ["'/proc/self/fd/0'"])).toBe("stdin");
      expect(read("bash", ["/dev/fd/5"])).toBe("descriptor");
      expect(read("bash", ["x.sh"])).toBeUndefined();
      expect(read("pwsh", ["-NoProfile", "-"])).toBe("stdin");
      expect(read("pwsh", ["-File", "-"])).toBe("stdin");
      expect(read("pwsh", ["-File", "x.ps1"])).toBeUndefined();
      expect(read("powershell", ["-Command", "-"])).toBe("stdin");
    });
  });

  // Review findings on #1659: a script sourced from a stream, or a startup
  // file a shell reads from one, passed every rule.
  describe("a script sourced from a stream, and a startup file read from one", () => {
    const PROCESS = "a shell reading its script from a process substitution";
    const DESCRIPTOR = "a shell reading its script from a descriptor";
    const STARTUP = "a shell startup file read from stdin, a descriptor or a process substitution";

    it.each([
      [`source <(echo gh pr merge 7 --squash)`, PROCESS],
      [`. <(echo gh pr merge 7 --squash)`, PROCESS],
      [`true && . <(echo gh pr merge 7 --squash)`, PROCESS],
      [`source /dev/stdin <<< 'gh pr merge 7 --squash'`, HERE_STRING],
      [`. /dev/stdin <<< 'gh pr merge 7 --squash'`, HERE_STRING],
      [`. "/dev/stdin" <<< 'gh pr merge 7 --squash'`, HERE_STRING],
      [`echo 'gh pr merge 7 --squash' | source /dev/stdin`, PRINTER],
      [`echo 'gh pr merge 7 --squash' | . /dev/stdin`, STDIN],
      [`. /dev/fd/3 3<x`, DESCRIPTOR],
      [`bash -c 'source <(echo ls)'`, PROCESS],
      [`bash -c '. <(echo ls)'`, PROCESS],
      [`bash -c '. /dev/fd/3'`, DESCRIPTOR],
      [`bash --init-file <(echo gh pr merge 7 --squash)`, STARTUP],
      [`bash --rcfile <(echo gh pr merge 7 --squash) -i`, STARTUP],
      [`bash --rcfile=<(echo gh pr merge 7 --squash) -i`, STARTUP],
      [`bash --rcfile /dev/stdin -i <<< 'gh pr merge 7'`, STARTUP],
      [`BASH_ENV=<(echo gh pr merge 7 --squash) bash -c true`, STARTUP],
      [`ENV=<(echo gh pr merge 7 --squash) sh -i`, STARTUP],
      [`env BASH_ENV=/dev/stdin bash -c true <<< 'gh pr merge 7'`, STARTUP],
      [`export BASH_ENV=<(echo gh pr merge 7); bash -c true`, STARTUP],
      [`BASH_ENV=<(echo gh pr merge 7) node x.js`, STARTUP],
      [`bash -c 'BASH_ENV=<(echo ls) node x.js'`, STARTUP],
    ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));

    it.each([
      `source x.sh`,
      `. ./env.sh`,
      `. "$HOME/.profile"`,
      `source "$HOME/.nvm/nvm.sh" && nvm use`,
      `bash -c '. ./env.sh && pnpm build'`,
      `BASH_ENV=x.sh bash -c true`,
      `bash --rcfile x.rc -i`,
      `echo ENV=prod`,
      `grep ENV= .env`,
      `git commit -m "BASH_ENV=<(x) bash -c true"`,
      `git add . && git commit -m x`,
      `diff <(ls a) <(ls b)`,
    ])("reads and refuses nothing where the script or startup file is a file: %s", (c) =>
      expect(lexer.refusedForms(c)).toEqual([]),
    );
  });

  // Review finding on #1659: PowerShell's base64 command is the decoder form
  // the stopping rule refuses, and passed from both tools.
  describe("an encoded command", () => {
    const ENCODED = "an encoded command";
    const B64 = Buffer.from("gh pr merge 7 --squash", "utf16le").toString("base64");
    const fromPowerShell = (c) => lexer.refusedForms(lexer.powershellAsBash(c), lexer.POWERSHELL);

    it.each([
      `pwsh -EncodedCommand ${B64}`,
      `powershell -e ${B64}`,
      `powershell.exe -e ${B64}`,
      `pwsh -ec ${B64}`,
      `pwsh -enc ${B64}`,
      `pwsh -EncodedC ${B64}`,
      `pwsh -NoProfile -ExecutionPolicy Bypass -e ${B64}`,
      `pwsh /enc ${B64}`,
      `pwsh -e:${B64}`,
      `"C:/Program Files/PowerShell/7/pwsh.exe" -ec ${B64}`,
    ])("refuses %s, from either tool", (c) => {
      expect(lexer.refusedForms(c)[0]?.form).toBe(ENCODED);
      expect(fromPowerShell(c)[0]?.form).toBe(ENCODED);
    });

    it.each([`bash -c 'pwsh -ec ${B64}'`, `pwsh -Command "powershell -e ${B64}"`])("refuses %s in a string", (c) =>
      expect(lexer.refusedForms(c)[0]?.form).toBe(ENCODED),
    );

    it.each([
      `pwsh -File x.ps1`,
      `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/x.ps1 -e y`,
      `pwsh -c "Get-Date"`,
      `powershell -NoProfile -Command "Get-ChildItem -e x"`,
    ])("reads and refuses nothing in %s, from either tool", (c) => {
      expect(lexer.refusedForms(c)).toEqual([]);
      expect(fromPowerShell(c)).toEqual([]);
    });
  });

  // Review finding on #1659: xargs substitutes its input into a shell's
  // string before that shell parses it, and parallel with no command runs its
  // input as commands.
  describe("a shell string xargs or parallel fills in", () => {
    const FILLED = "a shell string xargs, parallel or find fills in from its input";
    const PARALLEL = "parallel running its input as commands";

    it.each([
      [`echo 'gh pr merge 7 --squash' | xargs -I{} bash -c '{}'`, FILLED],
      [String.raw`echo 'gh pr merge 7 --squash' | xargs -d '\n' -I% sh -c '%'`, FILLED],
      [String.raw`printf '%s\0' 'gh pr merge 7 --squash' | xargs -0 -I{} bash -c {}`, FILLED],
      [`ls | xargs -I{} bash -c 'echo {}'`, FILLED],
      [`ls | xargs -I {} sh -c 'cat "{}"'`, FILLED],
      [`ls | xargs -i sh -c 'cat {}'`, FILLED],
      [`ls | xargs -i@ sh -c 'cat @'`, FILLED],
      [`ls | xargs --replace sh -c 'cat {}'`, FILLED],
      [`ls | xargs --replace=@ sh -c 'cat @'`, FILLED],
      [`ls | xargs -0I{} sh -c 'cat {}'`, FILLED],
      [`ls | xargs -n 1 -P 4 -I{} sh -c 'cat {}'`, FILLED],
      [`timeout 60 xargs -I{} sh -c '{}' < list.txt`, FILLED],
      [`ls | /usr/bin/xargs -I{} zsh -c 'cat {}'`, FILLED],
      [`echo '"gh pr merge 7 --squash"' | xargs bash -c`, FILLED],
      [`ls | xargs -n1 sh -c`, FILLED],
      [`echo '; gh pr merge 7' | xargs pwsh -Command Write-Output`, FILLED],
      [`ls | xargs -I{} cmd /c "type {}"`, FILLED],
      [`echo 'gh pr merge 7 --squash' | parallel`, PARALLEL],
      [`parallel -j 4 < commands.txt`, PARALLEL],
      [`parallel ::: 'gh pr merge 7 --squash'`, PARALLEL],
      [`parallel -j2 :::: commands.txt`, PARALLEL],
      [`parallel {} ::: 'gh pr merge 7 --squash'`, PARALLEL],
      [`parallel -I @ @ ::: 'gh pr merge 7 --squash'`, PARALLEL],
    ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));

    it.each([
      // The safe spellings: the name is an argument the string reads as `$1`.
      `ls | xargs -I{} sh -c 'cat "$1"' _ {}`,
      String.raw`find . -name '*.md' -exec sh -c 'cat "$1"' _ {} \;`,
      `ls | xargs -I{} sed -n {}p f`,
      `ls | xargs grep -l x`,
      `ls | xargs -n1 bash -c 'echo "$0"'`,
      `ls | xargs -I{} sh -c 'echo none'`,
      `xargs sh -c 'ls'`,
      `parallel gzip ::: a b`,
      `parallel echo {} ::: a b`,
      `echo xargs; bash -c 'echo {}'`,
    ])("reads and refuses nothing in %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));

    it("advises the safe spellings for a string xargs fills in", () => {
      const [r] = lexer.refusedForms(`ls | xargs -I{} sh -c 'cat {}'`);
      expect(r.advice).toContain(`xargs -I{} sh -c 'cat "$1"' _ {}`);
      expect(r.advice).toContain(String.raw`find … -exec sh -c '…' _ {} \;`);
    });

    // #1659 second read: find substitutes `{}` anywhere in an `-exec`
    // argument, a shell's string included, so a file name can be a command.
    it.each([
      String.raw`find . -name '*.md' -exec bash -c 'echo {}' \;`,
      String.raw`find . -exec sh -c 'cat "{}"' \;`,
      String.raw`find . -execdir sh -c '{}' \;`,
      `find . -type f -exec bash -c {} +`,
      String.raw`find . -exec pwsh -Command Get-Item {} \;`,
      String.raw`find . -name x -exec /bin/sh -c 'echo {}; ls' \;`,
    ])("refuses %s", (c) => {
      const [r] = lexer.refusedForms(c);
      expect(r?.form).toBe(FILLED);
      expect(r.advice).toContain(String.raw`find … -exec sh -c '…' _ {} \;`);
    });
    it.each([
      String.raw`find . -exec rm {} \;`,
      `find . -name '*.ts' -exec grep -l x {} +`,
      String.raw`find . -exec sh -c 'ls "$1"' _ {} \;`,
      String.raw`find . -exec bash -c 'echo none' \;`,
    ])("reads and refuses nothing in %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));
  });
});

// #1659 second read: a stdin shell whose stdin an enclosing compound command's
// redirection, or an earlier `exec`, sets.
describe("the stopping rule: a stdin shell fed from around it (#1659 second read)", () => {
  const HERE_STRING = "a shell reading its script from a here-string";
  const HEREDOC = "a shell reading its script from a heredoc";
  const PROCESS = "a shell reading its script from a process substitution";
  const DESCRIPTOR = "a shell reading its script from a descriptor";
  it.each([
    [`{ bash; } <<< 'gh pr merge 7 --squash'`, HERE_STRING],
    [`( bash ) <<< 'gh pr merge 7 --squash'`, HERE_STRING],
    [`(bash) <<< 'gh pr merge 7 --squash'`, HERE_STRING],
    [`while :; do bash; break; done <<< 'gh pr merge 7 --squash'`, HERE_STRING],
    [`if true; then sh; fi <<'EOF'\ngh pr merge 7\nEOF`, HEREDOC],
    [`{ bash; } < <(echo gh pr merge 7)`, PROCESS],
    [`{ bash; } 0<&3`, DESCRIPTOR],
    [`exec < <(echo 'gh pr merge 7 --squash'); bash`, PROCESS],
    [`exec 0<<<'gh pr merge 7'; bash`, HERE_STRING],
    [`exec <&3; sh`, DESCRIPTOR],
  ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));
  it.each([
    `{ bash x.sh; } <<< 'input'`,
    `{ cat; } <<< 'x'`,
    `{ bash; } < file.sh`,
    `exec < file.sh; bash`,
    `exec 3<<<'x'; cat <&3`,
    `exec > log.txt; bash x.sh`,
    `while read -r f; do bash -c 'echo "$f"'; done < list.txt`,
    `( cd x && bash scripts/run.sh ) <<< 'y'`,
  ])("reads and refuses nothing in %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));
});

// #1659 second read: a startup file or script a shell is handed through an
// expansion, or a `BASH_ENV` / `ENV` assignment in quotes, hid the stream.
describe("the stopping rule: a stream named through an expansion or a quoted assignment (#1659 second read)", () => {
  const STDIN = "a shell reading its script from stdin";
  const PRINTER = "a printer piped into a shell";
  const HERE_STRING = "a shell reading its script from a here-string";
  const HEREDOC = "a shell reading its script from a heredoc";
  const STARTUP = "a shell startup file read from stdin, a descriptor or a process substitution";
  it.each([
    [`export "BASH_ENV=/dev/stdin"; bash -c : <<< 'gh pr merge 7'`, STARTUP],
    [`export 'ENV=/dev/fd/3'; sh -i`, STARTUP],
    [`export "BASH_ENV"=/dev/stdin; bash -c :`, STARTUP],
    [`F=/dev/stdin; BASH_ENV=$F bash -c :`, STARTUP],
    [`BASH_ENV="$F" bash -c true`, STARTUP],
    ["env ENV=`echo /dev/stdin` sh -i", STARTUP],
    [`F=/dev/stdin; bash "$F" <<< 'gh pr merge 7'`, HERE_STRING],
    [`bash $F <<'EOF'\ngh pr merge 7\nEOF`, HEREDOC],
    [`echo 'gh pr merge 7' | bash "$F"`, PRINTER],
    [`bash "$F" < in.txt`, STDIN],
    [`source "$F" <<< 'gh pr merge 7'`, HERE_STRING],
    [`bash --rcfile "$F" -i <<< 'gh pr merge 7'`, HERE_STRING],
    [`bash -c 'source "$0"' /dev/stdin <<< 'gh pr merge 7'`, HERE_STRING],
    [`bash -c '. "$1"' _ /dev/stdin <<< 'gh pr merge 7'`, HERE_STRING],
  ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));
  it.each([
    `bash "$SCRIPT"`,
    `bash "$SCRIPT" arg`,
    `source "$HOME/.nvm/nvm.sh"`,
    `bash x.sh <<< 'input'`,
    `BASH_ENV=x.sh bash -c true`,
    `export BASH_ENV=~/.bashrc`,
    `bash -c 'source "$0"' x.sh`,
    `bash -c 'echo "$0"' /dev/stdin <<< 'x'`,
    `git commit -m "BASH_ENV=$F" -- x.md`,
  ])("reads and refuses nothing in %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));
});

// #1659 second read: a shell word glued to a redirection fed nothing.
describe("the stopping rule: a shell word glued to its redirection (#1659 second read)", () => {
  const MERGE = cmd(/gh\s+pr\s+merge\b/);
  it.each([
    [`bash<<<'gh pr merge 7 --squash'`, "a shell reading its script from a here-string"],
    [`bash<<EOF\ngh pr merge 7\nEOF`, "a shell reading its script from a heredoc"],
    [`sh<<-EOF\n\tgh pr merge 7\n\tEOF`, "a shell reading its script from a heredoc"],
    [`bash< <(echo gh pr merge 7)`, "a shell reading its script from a process substitution"],
    [`bash<&3`, "a shell reading its script from a descriptor"],
    [`echo 'gh pr merge 7' | bash>/dev/null`, "a printer piped into a shell"],
  ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));
  it.each([
    `bash</dev/null -c 'gh pr merge 7 --squash'`,
    `bash>out.log -c 'gh pr merge 7 --squash'`,
    `bash 2>/dev/null -c 'gh pr merge 7 --squash'`,
  ])("reads the string of %s as one a shell runs", (c) => {
    expect(lexer.refusedForms(c)).toEqual([]);
    expect(lexer.has(c, MERGE)).toBe(true);
    expect(lexer.view(c).programs.some((p) => p[4]?.how === "shell" && p[4]?.via === "bash")).toBe(true);
  });
  it.each([`bash</dev/null x.sh`, `bash>log x.sh`])("reads and refuses nothing in %s", (c) =>
    expect(lexer.refusedForms(c)).toEqual([]),
  );
});

// #1659 second read: fish's `-C` / `--init-command` runs a string too.
describe("fish's init command is a string it runs (#1659 second read)", () => {
  const MERGE = cmd(/gh\s+pr\s+merge\b/);
  it.each([
    `fish -C 'gh pr merge 7 --squash'`,
    `fish --init-command 'gh pr merge 7 --squash'`,
    `fish --init-command='gh pr merge 7 --squash' -c true`,
    `fish -C'gh pr merge 7 --squash'`,
    `fish -i -C 'gh pr merge 7 --squash'`,
    `fish -C true -c 'gh pr merge 7 --squash'`,
    `fish -c true -C 'gh pr merge 7 --squash'`,
  ])("reads the merge in %s", (c) => {
    expect(lexer.has(c, MERGE)).toBe(true);
    expect(lexer.refusedForms(c)).toEqual([]);
  });
  it("refuses fish's init command as a string inside a string", () =>
    expect(lexer.refusedForms(`bash -c "fish -C 'ls'"`)[0]?.form).toBe("a string inside a string"));
  it("reads an init command next to a script file", () => {
    expect(lexer.has(`fish -C 'gh pr merge 7' x.fish`, MERGE)).toBe(true);
    expect(lexer.has(`fish -d 3 x.fish`, MERGE)).toBe(false);
  });
});

// CodeRabbit CLI on #1659: an interactive bash with a `-c` string still runs
// its `--rcfile` first, and one that expands may be the stdin it is given.
describe("the stopping rule: an expanding startup file beside a string (#1659 CodeRabbit)", () => {
  it.each([
    [`bash --rcfile "$F" -i -c 'true' <<< 'gh pr merge 7 --squash'`, "a shell reading its script from a here-string"],
    [`bash --init-file $F -i -c : < <(echo gh pr merge 7)`, "a shell reading its script from a process substitution"],
    [`bash --rcfile "$F" -i -c : < in.txt`, "a shell reading its script from stdin"],
    [`echo 'gh pr merge 7' | bash --rcfile "$F" -i -c :`, "a printer piped into a shell"],
  ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));
  it.each([`bash -c 'true' <<< data`, `bash --rcfile x.rc -i -c : <<< data`, `bash --rcfile "$F" -i -c :`])(
    "reads and refuses nothing in %s",
    (c) => expect(lexer.refusedForms(c)).toEqual([]),
  );
});

// CodeRabbit CLI on #1659: only an assignment sets a startup file, so a
// `BASH_ENV=` that is a search pattern or a printed word is no stream.
describe("the stopping rule: a startup-file assignment only where one is made (#1659 CodeRabbit)", () => {
  const STARTUP = "a shell startup file read from stdin, a descriptor or a process substitution";
  it.each([
    `export BASH_ENV=/dev/stdin; bash -c :`,
    `env BASH_ENV=/dev/stdin bash -c :`,
    `env -u X BASH_ENV=$F bash -c :`,
    `BASH_ENV=$F bash -c :`,
    `X=1 BASH_ENV=$F bash -c :`,
    `2>/dev/null BASH_ENV=$F bash -c :`,
    `declare -x BASH_ENV=$F`,
    `local ENV=$F`,
    `readonly BASH_ENV=/dev/fd/3`,
    `typeset BASH_ENV=$X`,
    `export A=1 "BASH_ENV=/dev/stdin"; bash -c :`,
    `if true; then BASH_ENV=$F bash -c :; fi`,
    `bash -c 'BASH_ENV=<(echo ls) node x.js'`,
  ])("refuses %s", (c) => expect(lexer.refusedForms(c)[0]?.form).toBe(STARTUP));
  it.each([
    `grep -F BASH_ENV=/dev/stdin config.txt`,
    `echo ENV=$F`,
    `printf '%s\n' BASH_ENV=$X`,
    `rg -n "x" BASH_ENV=<(ls)`,
    `cat .env | grep ENV=$F`,
  ])("reads and refuses nothing in %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));
});

// CodeRabbit CLI on #1659: a pipe that feeds another command in the element
// is no pipe into the shell; only one into it, or into a compound command
// that holds it, is.
describe("the stopping rule: the pipe that feeds a stdin shell (#1659 CodeRabbit)", () => {
  const STDIN = "a shell reading its script from stdin";
  const PRINTER = "a printer piped into a shell";
  it.each([
    `{ printf x | wc -c; bash; } </dev/null`,
    `printf x | wc -c; bash`,
    `git log | head -3 && bash`,
    `a || bash`,
    `( printf x | wc -c ); bash`,
  ])("reads and refuses nothing in %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));
  it.each([
    [`{ printf x | wc -c; bash; } <<< 'gh pr merge 7'`, "a shell reading its script from a here-string"],
    [`echo 'gh pr merge 7' | { cd x && bash; }`, STDIN],
    [`echo 'gh pr merge 7' | (cd x && bash)`, STDIN],
    [`echo 'gh pr merge 7' | while true; do bash; break; done`, STDIN],
    [`echo 'gh pr merge 7' | if true; then bash; fi`, STDIN],
    [`echo 'gh pr merge 7' |\nbash`, STDIN],
    [`echo 'gh pr merge 7' | # run it\nbash`, STDIN],
    [`echo 'gh pr merge 7' |& bash`, PRINTER],
    [`cat <<'EOF' |\nls; gh pr merge 5 --squash\nEOF\nbash`, STDIN],
    [`echo x | { printf y | wc -c; bash; }`, STDIN],
    [`echo 'gh pr merge 7' | { case x in x) bash;; esac; }`, PRINTER],
    [`cat x | { case x in x) bash;; esac; }`, STDIN],
  ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));
});

// CodeRabbit CLI on #1659: a later `exec` that surely runs, in the same
// shell, resets the stdin an earlier one set.
describe("the stopping rule: an exec chain's last stdin (#1659 CodeRabbit)", () => {
  const HERE_STRING = "a shell reading its script from a here-string";
  it.each([
    `exec <<< ':'; exec </dev/null; bash`,
    `exec <<< ':'; exec 0< /dev/null; bash`,
    `exec 0<<<x\nexec 0</dev/null\nbash`,
  ])("reads and refuses nothing in %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));
  it.each([
    `exec <<< ':' || exec </dev/null; bash`,
    `exec <<< ':'; ( exec </dev/null ); bash`,
    `exec <<< ':'; { exec </dev/null; }; bash`,
    `exec <<< ':'; if true; then exec </dev/null; fi; bash`,
    `exec </dev/null; exec <<< ':'; bash`,
    `exec <<< ':'; true | exec </dev/null; bash`,
  ])("refuses %s", (c) => expect(lexer.refusedForms(c)[0]?.form).toBe(HERE_STRING));
});

// CodeRabbit CLI round 2 on #1659: a word that names an inherited property
// (`constructor`, `toString`, `__proto__`) is no closing word of a group.
describe("the stopping rule: a lookup table answers only its own keys (#1659 CodeRabbit)", () => {
  it.each([`{ constructor; bash; } < file.sh`, `{ toString; __proto__; hasOwnProperty; bash; } < file.sh`])(
    "reads and refuses nothing in %s",
    (c) => expect(lexer.refusedForms(c)).toEqual([]),
  );
  it("still refuses such a group fed a here-string", () =>
    expect(lexer.refusedForms(`{ constructor; bash; } <<< 'gh pr merge 7'`)[0]?.form).toBe(
      "a shell reading its script from a here-string",
    ));
});

// CodeRabbit CLI round 2 on #1659: fish's `-C` string is handed the same
// stdin as its `-c` one, so a script word that expands in it is judged
// against that stdin.
describe("the stopping rule: fish's init command and its stdin (#1659 CodeRabbit)", () => {
  it.each([`fish -C 'source "$HOME/x.fish"' -c true`, `fish -C '. $F' -c true`])(
    "reads and refuses nothing in %s",
    (c) => expect(lexer.refusedForms(c)).toEqual([]),
  );
  it.each([
    [`fish -C 'source "$F"' -c true <<< 'gh pr merge 7'`, "a shell reading its script from a here-string"],
    [`fish -C 'source "$F"' -c true < in.txt`, "a shell reading its script from stdin"],
  ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));
});

// CodeRabbit CLI round 2 on #1659: an `xargs` that is an option's operand
// runs nothing; one that runs the shell is found through the wrappers after it.
describe("the stopping rule: the xargs that runs a shell (#1659 CodeRabbit)", () => {
  const FILLED = "a shell string xargs, parallel or find fills in from its input";
  it.each([`env -u xargs pwsh -Command 'Get-Date'`, `env -u xargs sh -c 'echo {}'`, `timeout -s xargs 5 cmd /c dir`])(
    "reads and refuses nothing in %s",
    (c) => expect(lexer.refusedForms(c)).toEqual([]),
  );
  it.each([
    `ls | xargs -I{} nice sh -c 'cat {}'`,
    `ls | timeout 5 xargs -I{} stdbuf -oL sh -c 'cat {}'`,
    `ls | xargs -I{} nice -n 5 stdbuf -oL bash -c 'cat {}'`,
    `ls | env A=1 xargs -I{} sh -c 'cat {}'`,
    `ls | /usr/bin/xargs -I{} zsh -c 'cat {}'`,
  ])("refuses %s", (c) => expect(lexer.refusedForms(c)[0]?.form).toBe(FILLED));
});

// PR #1798 review: an exec after `&&` may not run, and one sent to the
// background runs in another shell: neither resets the stdin an earlier exec set.
describe("the stopping rule: an exec reset that surely runs in this shell (#1659 PR review)", () => {
  const HERE_STRING = "a shell reading its script from a here-string";
  it.each([
    `exec <<<'gh pr merge 5 --squash'; false && exec </dev/null; bash`,
    `exec <<<'gh pr merge 5 --squash' && exec </dev/null && bash`,
    `exec <<<'gh pr merge 5 --squash'; exec </dev/null & bash`,
    `exec <<<'gh pr merge 5 --squash'; exec </dev/null | cat; bash`,
  ])("refuses %s", (c) => expect(lexer.refusedForms(c)[0]?.form).toBe(HERE_STRING));
  it.each([
    `exec <<< x; exec </dev/null; bash`,
    `exec <<< x\nexec </dev/null\nbash`,
    `exec <<< x; ls; exec <'/dev/null'; bash`,
  ])("reads and refuses nothing in %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));
});

// PR #1798 review: two input redirections glued together are two, and the
// last one wins.
describe("the stopping rule: glued redirections, the last one winning (#1659 PR review)", () => {
  const HERE_STRING = "a shell reading its script from a here-string";
  it.each([`bash <<<':'</dev/null`, `bash <<<"a<b"</dev/null`, `bash 0<<<':'0</dev/null`])(
    "reads and refuses nothing in %s",
    (c) => expect(lexer.refusedForms(c)).toEqual([]),
  );
  it.each([
    [`bash </dev/null<<<'gh pr merge 7'`, HERE_STRING],
    [`bash <<<'a<b'`, HERE_STRING],
    [`bash </dev/null< <(echo gh pr merge 7)`, "a shell reading its script from a process substitution"],
    [`bash <in.txt<&3`, "a shell reading its script from a descriptor"],
  ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));
  it("keeps a string after glued redirections in its place", () => {
    const words = ["<<<':'</dev/null", "-c", "'gh pr merge 7'"];
    let i = 0;
    expect(lexer.readCommand(lexer.shellSpec("bash"), () => words[i++])).toMatchObject({ string: 2, stdin: "other" });
  });
});

// PR #1798 review: a group's own input redirection, not the pipe into it,
// gives the commands inside it their stdin.
describe("the stopping rule: a piped group with its own stdin (#1659 PR review)", () => {
  const STDIN = "a shell reading its script from stdin";
  it.each([
    `printf ':' | { bash; } </dev/null`,
    `printf ':' | ( bash ) </dev/null`,
    `cat x | while :; do bash; break; done < in.txt`,
    `echo x | { { bash; } </dev/null; }`,
  ])("reads and refuses nothing in %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));
  it.each([
    [`printf ':' | { bash; }`, "a printer piped into a shell"],
    [`cat x | { { bash; } ; }`, STDIN],
    [`cat x | { bash; } 2>/dev/null`, STDIN],
    [`printf ':' | { bash; } <<< 'gh pr merge 7'`, "a shell reading its script from a here-string"],
    [`printf x | { cat </dev/null | bash; } </dev/null`, STDIN],
  ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));
});

// PR #1798 review: once another element widens the raw view, a shell word
// inside a quoted argument is a mention, not a program word.
describe("the stopping rule: a shell word inside a quoted argument (#1659 PR review)", () => {
  it.each([
    String.raw`printf '%s\n' 'example; eval echo hello; end' > notes.txt; bash -c true`,
    String.raw`printf '%s\n' 'a; sudo -s x; b' > notes.txt; bash -c true`,
    `echo "x; eval y" > f; bash -c true`,
  ])("reads and refuses nothing in %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));
  it.each([
    [`eval x; bash -c true`, "eval"],
    [`"eval" x > f; bash -c true`, "eval"],
    [`"bash" -c "eval x"`, "eval"],
    [`echo x > f; sudo -s ls`, "a sudo that runs a shell"],
  ])("refuses %s (%s)", (c, form) => expect(lexer.refusedForms(c)[0]?.form).toBe(form));
});

// PR #1798 review: the startup-assignment scan found each candidate's command
// start by a search over every start, quadratic in a long chain of them.
describe("the stopping rule: startup assignments in time linear in their number (#1659 PR review)", () => {
  const MERGE = cmd(/gh\s+pr\s+merge\b/);
  it("reads a long chain of ENV assignments in time linear in its length", { timeout: TIMING_TIMEOUT_MS }, () =>
    readsLinearly(
      (n) => `${"ENV=x;".repeat(n)}bash -c true`,
      20000,
      MERGE,
      false,
      (c) => (lexer.refusedForms(c).length > 0 ? "refused" : false),
    ),
  );
});

// A judge's ruling on PR #1798: only an `exec` at a command's start sets the
// stdin of what follows; one that is an argument (`echo exec …`) sets nothing,
// neither an earlier stream nor a reset of one.
describe("the stopping rule: an exec only at a command's start (#1659 PR review)", () => {
  const HERE_STRING = "a shell reading its script from a here-string";
  it.each([
    `exec 0<<<'gh pr merge 1 --admin'; echo exec </dev/null; bash`,
    `exec 0<<<'git push origin v9.9.9'; : exec <x; bash`,
    `exec 0<<<'gh pr merge 1'; bash`,
    `if true; then exec 0<<<'gh pr merge 1'; fi; bash`,
  ])("refuses %s", (c) => expect(lexer.refusedForms(c)[0]?.form).toBe(HERE_STRING));
  it.each([
    String.raw`printf '%s\n' exec <<< ':'; bash`,
    `echo exec <<< x; bash`,
    `exec; bash`,
    `exec >log; bash`,
    `exec 3</dev/null; bash`,
    `exec <<< ':'; exec </dev/null; bash`,
  ])("reads and refuses nothing in %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));
});

// CodeRabbit CLI on f62995d39: in bash's default mode a failed `exec <file`
// prints an error and keeps the earlier stdin, so only `/dev/null`, whose
// open cannot fail, clears a stream an earlier exec set.
describe("the stopping rule: an exec reset only to /dev/null (#1659 PR review)", () => {
  const HERE_STRING = "a shell reading its script from a here-string";
  it.each([
    `exec <<< x; exec </nonexistent; bash`,
    `exec <<< x; exec <file.sh; bash`,
    `exec <<< x; exec <"$F"; bash`,
    `exec <<< x; exec < in.txt; bash`,
    `exec <<< x; exec </dev/null/x; bash`,
  ])("refuses %s", (c) => expect(lexer.refusedForms(c)[0]?.form).toBe(HERE_STRING));
  it.each([
    `exec <<< x; exec </dev/null; bash`,
    `exec <<< x; exec <"/dev/null"; bash`,
    `exec <<< x; exec 0<'/dev/null'; bash`,
  ])("reads and refuses nothing in %s", (c) => expect(lexer.refusedForms(c)).toEqual([]));
});
