import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  cmd,
  gitCwd,
  maskInert,
  POWERSHELL,
  powershellAsBash,
  resolveDir,
  shellWords,
  trustedMask,
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
      ])
        expect(trustedMask(command), command).toBe(command);
      expect(trustedMask(`python - <<'EOF'\nx\nEOF`)).toBe(`python - <<'EOF'\n__EOF`);
    });
  });
});
