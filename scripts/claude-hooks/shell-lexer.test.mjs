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
 * well past it), and an exponential one thousands of times. Returns the two
 * timings.
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
  for (let k = 0; k < 3; k++) {
    runs[0].push(time(n));
    runs[1].push(time(2 * n));
  }
  const [t1, t2] = runs.map((r) => Math.min(...r));
  const label = `${make(1).slice(0, 40)}: ${t1.toFixed(1)} ms at ${n}, ${t2.toFixed(1)} ms at ${2 * n}`;
  expect(t2, label).toBeLessThanOrEqual(3 * t1 + 25);
  return [t1, t2];
}

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
    [`eval "gh pr merge 7"`, "shell", "eval"],
    ["eval gh pr merge 7", "shell", "eval"],
    ["echo 'gh pr merge 7' | bash", "shell", "bash"],
    ["printf '%s\\n' 'gh pr merge 7' | sh", "shell", "sh"],
    ["bash <<< 'gh pr merge 7'", "shell", "bash"],
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
    "eval 'npx vitest'",
    "echo 'pnpm exec vitest run' | bash",
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
    expect(lexer.programKind("echo 'gh pr merge 7' | bash", 6)).toEqual({
      how: "shell",
      via: "bash",
      stdin: true,
      piped: true,
    });
    expect(lexer.programKind("bash <<< 'gh pr merge 7'", 10)).toEqual({ how: "shell", via: "bash", stdin: true });
    expect(lexer.programKind("echo gh pr merge 7", 5)).toBeUndefined();
    expect(lexer.programKind("bash -c 'echo gh pr merge 7'", 14)).toBeUndefined();
    expect(lexer.programAt("sudo gh pr merge 7", 5)).toBe(true);
    expect(lexer.programKind("bash -c 'gh pr merge 7'", 9).how).toBe("shell");
  });

  it("rewrites the first word of a fed string to the program it runs, as it does at command position", () => {
    expect(trustedMask("bash -c 'gh.exe pr merge 7'")).toBe("bash -c '    gh pr merge 7'");
    expect(trustedMask(`echo '"gh" pr merge 7' | bash`)).toBe(`echo '  gh pr merge 7' | bash`);
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
    expect(args(`eval "git push" && git push origin y`)).toEqual(["", " origin y"]);
    const add = cmd(/git\s+worktree\s+add\b(.*)$/);
    expect(lexer.matchAt("bash -c 'git worktree add ../ir-5 -b x'", add)[1]).toBe(" ../ir-5 -b x");
    expect(lexer.matchAt("git worktree add ../ir-5 -b x", add)[1]).toBe(" ../ir-5 -b x");
  });

  it("yields the matches in the order the command runs them", () => {
    const command = "bash -c 'gh pr merge 5'; gh pr merge 7";
    expect([...lexer.matchesAt(command, MERGE)].map((m) => m[1])).toEqual(["5", "7"]);
  });

  it("reads a long fed string, a long lead and a long run of options in time linear in their length", () => {
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
  });
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
    // The gap that stays: a program quoted whole in a string a shell joins from its words.
    expect(trustedMask('eval "gh" pr merge 7')).toBe('eval "gh" pr merge 7');
    expect(lexer.has('eval "gh" pr merge 7', MERGE)).toBe(false);
  });

  it("has no fedCommandStart export: programKind says how a word is the program", () =>
    expect(lexer.fedCommandStart).toBeUndefined());

  it("answers has() and reads every match in time linear in a long chain", () => {
    readsLinearly((n) => "gh pr merge 7; ".repeat(n), 4000, MERGE, true);
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
  });
});
