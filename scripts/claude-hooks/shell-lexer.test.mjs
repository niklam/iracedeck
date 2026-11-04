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
    expect(trustedMask(`"bash" -c 'gh.exe pr merge 7'`)).toBe(`  bash -c 'gh.exe pr merge 7'`);
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
    expect(place("git status")).toEqual({ dir: MASTER, movesRepo: false, movesTree: false });
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
});
