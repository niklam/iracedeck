import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  Census,
  censusOf,
  commandCensus,
  CommandSet,
  comparePair,
  CONTEXT_FIELDS,
  cut,
  differenceSummary,
  exitStatus,
  extractCommands,
  fixedContext,
  forbidSideEffects,
  formatDifference,
  formatVerdict,
  isProbe,
  kindName,
  main,
  NO_WORKSPACE,
  opensForWriting,
  parseCli,
  probeReasons,
  readCommands,
  readWorkspace,
  transcriptFiles,
  USAGE,
  verdictKind,
  verdictOf,
} from "./replay-corpus.mjs";
import { checkBash } from "./rules-bash.mjs";
import { BASH, POWERSHELL } from "./shell-lexer.mjs";

// Every input here is written by hand: the tool reads private transcripts,
// and no fixture may be built from one (#1659).
const toolUse = (name, input) => ({ type: "tool_use", id: "toolu_x", name, input });
const line = (...content) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });

describe("reading a transcript line", () => {
  it("takes each Bash and PowerShell command of a message's tool uses", () => {
    const text = line(
      { type: "text", text: "Running the tests." },
      toolUse("Bash", { command: "pnpm test", description: "Run tests" }),
      toolUse("Read", { file_path: "/a/b.ts" }),
      toolUse("PowerShell", { command: "Get-ChildItem" }),
    );
    expect(extractCommands(text)).toEqual([
      { tool: "Bash", command: "pnpm test" },
      { tool: "PowerShell", command: "Get-ChildItem" },
    ]);
  });

  it("skips a command that is not a string, and a line with no tool use", () => {
    expect(extractCommands(line(toolUse("Bash", { command: 5 }), toolUse("Bash", {})))).toEqual([]);
    expect(extractCommands(JSON.stringify({ type: "user", message: { content: "hello" } }))).toEqual([]);
    expect(extractCommands(JSON.stringify({ type: "summary", note: "tool_use" }))).toEqual([]);
    expect(extractCommands("")).toEqual([]);
  });

  it("reports a tool-use line that is not JSON as null, so it can be counted", () => {
    expect(extractCommands('{"type":"tool_use", cut off')).toBeNull();
    expect(extractCommands("not json at all")).toEqual([]);
  });

  it("keeps a command's text exactly, newlines and quotes included", () => {
    const command = "cd /x && \\\n  echo \"a 'b'\"\tdone";
    expect(extractCommands(line(toolUse("Bash", { command })))).toEqual([{ tool: "Bash", command }]);
  });
});

describe("deduping commands", () => {
  it("keeps the first of each (tool, command) pair, in order", () => {
    const set = new CommandSet();
    expect(set.add({ tool: "Bash", command: "ls" })).toBe(true);
    expect(set.add({ tool: "Bash", command: "pwd" })).toBe(true);
    expect(set.add({ tool: "Bash", command: "ls" })).toBe(false);
    expect(set.add({ tool: "PowerShell", command: "ls" })).toBe(true);
    expect(set.size).toBe(3);
    expect(set.list()).toEqual([
      { tool: "Bash", command: "ls" },
      { tool: "Bash", command: "pwd" },
      { tool: "PowerShell", command: "ls" },
    ]);
  });

  it("does not merge a pair whose parts only join alike", () => {
    const set = new CommandSet();
    set.add({ tool: "Bash", command: "x" });
    expect(set.add({ tool: "Bas", command: "hx" })).toBe(true);
  });
});

describe("walking and streaming a transcript folder", () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-test-"));
    fs.mkdirSync(path.join(dir, "proj-alpha", "session", "subagents"), { recursive: true });
    fs.mkdirSync(path.join(dir, "proj-beta"));
    fs.writeFileSync(
      path.join(dir, "proj-alpha", "one.jsonl"),
      [line(toolUse("Bash", { command: "ls" })), "{broken tool_use", line(toolUse("Bash", { command: "pwd" }))].join(
        "\r\n",
      ),
    );
    fs.writeFileSync(
      path.join(dir, "proj-alpha", "session", "subagents", "agent-1.jsonl"),
      `${line(toolUse("Bash", { command: "ls" }), toolUse("PowerShell", { command: "ls" }))}\n`,
    );
    fs.writeFileSync(path.join(dir, "proj-beta", "two.jsonl"), `${line(toolUse("Bash", { command: "jq . x" }))}\n`);
    fs.writeFileSync(path.join(dir, "proj-alpha", "notes.txt"), line(toolUse("Bash", { command: "ignored" })));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("finds every .jsonl recursively, sorted, filtered by its path under the folder", () => {
    const rel = (files) => files.map((f) => path.relative(dir, f).split(path.sep).join("/"));
    expect(rel(transcriptFiles(dir))).toEqual([
      "proj-alpha/one.jsonl",
      "proj-alpha/session/subagents/agent-1.jsonl",
      "proj-beta/two.jsonl",
    ]);
    expect(rel(transcriptFiles(dir, "alpha"))).toEqual([
      "proj-alpha/one.jsonl",
      "proj-alpha/session/subagents/agent-1.jsonl",
    ]);
    expect(transcriptFiles(dir, "gamma")).toEqual([]);
  });

  it("streams the commands, deduped, and counts the lines that do not parse", async () => {
    const { commands, unparsed } = await readCommands(transcriptFiles(dir));
    expect(commands.list()).toEqual([
      { tool: "Bash", command: "ls" },
      { tool: "Bash", command: "pwd" },
      { tool: "PowerShell", command: "ls" },
      { tool: "Bash", command: "jq . x" },
    ]);
    expect(unparsed).toBe(1);
  });

  // PR #1798 review: readline splits a line on U+2028 and U+2029 too, which
  // JSON writes literally, so a command holding one broke its record in two.
  it("splits records on LF or CRLF only, never on a line or paragraph separator", async () => {
    const file = path.join(dir, "separators.jsonl");
    const odd = "echo a b c";
    fs.writeFileSync(
      file,
      `${line(toolUse("Bash", { command: odd }))}\r\n${line(toolUse("Bash", { command: "pwd -L" }))}\n`,
    );
    try {
      const { commands, unparsed } = await readCommands([file]);
      expect(commands.list()).toEqual([
        { tool: "Bash", command: odd },
        { tool: "Bash", command: "pwd -L" },
      ]);
      expect(unparsed).toBe(0);
    } finally {
      fs.rmSync(file);
    }
  });

  it("runs the census alone over the folder and prints its counts", async () => {
    const out = [];
    expect(await main(["--transcripts", dir, "--census-only"], (l) => out.push(l))).toBe(0);
    expect(out).toContain("transcripts read: 3");
    expect(out).toContain("tool-use lines not JSON: 1");
    expect(out).toContain("distinct commands: 4 (real 4, probe 0)");
    expect(out.some((l) => l.startsWith("commands judged"))).toBe(false);
    const row = out.find((l) => l.startsWith("program command "));
    expect(row?.trim().split(/\s+/).slice(2)).toEqual(["4", "4", "0", "0"]);
  });
});

describe("telling a probe from a real command", () => {
  it.each([
    ["gh pr merge 999999 --squash", "a PR number of 99999 or more"],
    ["gh pr view 99999 --json state", "a PR number of 99999 or more"],
    ["gh api repos/o/r/pulls/123456", "a PR number of 99999 or more"],
    ["PATH=/tmp/stubcheck:$PATH gh pr merge 5", "a stubcheck stub"],
    ["env 'BASH_FUNC_gh%%=() { :; }' bash -c x", "an exported bash function"],
    ["cd ../ir-integration && pnpm build", "the integration tree"],
    ["pnpm dev:voices", "the dev:voices script"],
    [String.raw`bash -c $'\x67h pr merge 5'`, "a \\x escape"],
    ["node scripts/claude-hooks/pre-bash.mjs < payload.json", "a hook module named"],
    ["pnpm test scripts/claude-hooks/shell-lexer.test.mjs", "a hook module named"],
    ["cd zz-probe && ls", "a probe placeholder"],
  ])("%s is a probe", (command, reason) => {
    expect(isProbe(command)).toBe(true);
    expect(probeReasons(command)).toContain(reason);
  });

  it.each([
    "gh pr merge 1796 --squash",
    "gh pr view 99998",
    "gh pr checks 1792 --watch",
    "git log --oneline -20",
    "pnpm test packages/settings",
    "echo 1234567890 && sleep 5",
    "gh api repos/o/r/pulls/1796/comments",
    "integration test",
  ])("%s is real", (command) => {
    expect(probeReasons(command)).toEqual([]);
    expect(isProbe(command)).toBe(false);
  });
});

describe("the fixed context", () => {
  const ctx = fixedContext({ cwd: "C:/repo/ir-1", shell: BASH });

  it("answers every field pre-bash.mjs sets, and nothing else", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "pre-bash.mjs"), "utf8");
    const block = /\n {2}const ctx = \{\n([\s\S]*?)\n {2}\};/.exec(source)?.[1];
    expect(block).toBeDefined();
    const keys = [...block.matchAll(/^ {4}(\w+)(?=[,:])/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(20);
    expect([...CONTEXT_FIELDS].sort()).toEqual([...keys].sort());
    expect(Object.keys(ctx).sort()).toEqual([...CONTEXT_FIELDS].sort());
  });

  it("gives the same harmless answer every time", () => {
    expect(ctx.cwd).toBe("C:/repo/ir-1");
    expect(ctx.shell).toBe(BASH);
    expect(fixedContext({ cwd: "C:/repo/ir-1", shell: POWERSHELL }).shell).toBe(POWERSHELL);
    expect(ctx.branch("C:/anywhere")).toBe("master");
    for (const f of ["staged", "modified", "untracked", "specFiles", "linkTargets", "workspaceDirs"])
      expect(ctx[f]("C:/repo/ir-1"), f).toEqual([]);
    expect(ctx.staged("x")).not.toBe(ctx.staged("x"));
    expect(ctx.mainRoot("C:/elsewhere")).toBe("C:/repo/ir-1");
    expect(ctx.toplevel("C:/elsewhere")).toBe("C:/repo/ir-1");
    expect(ctx.originFresh("C:/repo/ir-1")).toBeUndefined();
    expect(ctx.tracked("C:/repo/ir-1", "a.md")).toBe(false);
    expect(ctx.packages()).toEqual({});
    for (const f of ["committedText", "issueLabels", "scriptsAt", "prView", "baseChangedSince", "prComments"])
      expect(ctx[f]("a", "b", "c"), f).toBeUndefined();
    for (const f of ["replayRebase", "prChangedFiles", "requiredChecks"])
      expect(ctx[f]({ head: "a", base: "b", dir: "c" }), f).toMatchObject({ ok: false });
    expect(ctx.isInside("C:/repo/ir-1/a", "C:/repo/ir-1")).toBe(true);
    expect(ctx.isInside("C:/repo/ir-10", "C:/repo/ir-1")).toBe(false);
  });

  it("throws on a field it does not define, read or tested with in", () => {
    expect(() => ctx.newReader).toThrow(/ctx\.newReader.*does not define/);
    expect(() => "newReader" in ctx).toThrow(/ctx\.newReader/);
    expect("prView" in ctx).toBe(true);
    expect(ctx[Symbol.iterator]).toBeUndefined();
  });

  it("cannot be written to", () => {
    expect(() => {
      ctx.cwd = "/other";
    }).toThrow(/read-only/);
    expect(() => {
      delete ctx.prView;
    }).toThrow(/read-only/);
    expect(() => Object.defineProperty(ctx, "extra", { value: 1 })).toThrow(/read-only/);
    expect(ctx.cwd).toBe("C:/repo/ir-1");
  });

  it("answers the workspace reads from a snapshot, as pre-bash.mjs reads the disk", () => {
    const root = path.resolve("/ws");
    const workspace = {
      root,
      manifests: [
        { dir: root, name: "root", scripts: { build: "turbo build" } },
        { dir: path.join(root, "packages", "a"), name: "@x/a", scripts: { test: "vitest" } },
        { dir: path.join(root, "packages", "b"), broken: true },
      ],
    };
    const w = fixedContext({ cwd: root, shell: BASH, workspace });
    expect(w.scriptsAt(path.join(root, "packages", "a", "src", "deep"))).toEqual({
      dir: path.join(root, "packages", "a"),
      name: "@x/a",
      scripts: { test: "vitest" },
    });
    expect(w.scriptsAt(path.join(root, "packages", "b", "src"))).toBeUndefined();
    expect(w.scriptsAt(path.join(root, "docs"))?.name).toBe("root");
    expect(w.scriptsAt(path.resolve("/elsewhere"))).toBeUndefined();
    expect(w.scriptsAt(root).scripts).not.toBe(w.scriptsAt(root).scripts);
    expect(w.packages()).toEqual({
      root: { dir: root, scripts: ["build"] },
      "@x/a": { dir: path.join(root, "packages", "a"), scripts: ["test"] },
    });
    expect(w.workspaceDirs(`${root}${path.sep}`)).toEqual([
      path.join(root, "packages", "a"),
      path.join(root, "packages", "b"),
    ]);
    expect(w.workspaceDirs(path.resolve("/other"))).toEqual([]);
  });

  it("reads the snapshot from a checkout's manifests, once", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-ws-"));
    try {
      fs.mkdirSync(path.join(root, "packages", "a"), { recursive: true });
      fs.mkdirSync(path.join(root, "packages", "b"));
      fs.mkdirSync(path.join(root, "packages", "none"));
      fs.writeFileSync(path.join(root, "package.json"), '{"name":"root","scripts":{"build":"x"}}');
      fs.writeFileSync(path.join(root, "packages", "a", "package.json"), '{"name":"@x/a"}');
      fs.writeFileSync(path.join(root, "packages", "b", "package.json"), "{ not json");
      expect(readWorkspace(root)).toEqual({
        root,
        manifests: [
          { dir: root, name: "root", scripts: { build: "x" } },
          { dir: path.join(root, "packages", "a"), name: "@x/a", scripts: {} },
          { dir: path.join(root, "packages", "b"), broken: true },
        ],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(NO_WORKSPACE.manifests).toEqual([]);
  });

  // CodeRabbit CLI on #1659: a manifest that exists but cannot be read was
  // skipped as absent, so both sides stopped at a false "no such package".
  it("skips only a missing manifest, and throws on one it cannot read, naming it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-ws-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), '{"name":"root"}');
      // A directory where the manifest should be: a read failure that is no ENOENT.
      fs.mkdirSync(path.join(root, "packages", "odd", "package.json"), { recursive: true });
      expect(() => readWorkspace(root)).toThrow(path.join(root, "packages", "odd", "package.json"));
      fs.rmSync(path.join(root, "packages", "odd"), { recursive: true });
      fs.mkdirSync(path.join(root, "packages", "none"), { recursive: true });
      expect(readWorkspace(root).manifests).toEqual([{ dir: root, name: "root", scripts: {} }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // CodeRabbit CLI round 2 on #1659: `packages/` is listed directly; a file in
  // it is no package, and only a missing folder means none.
  it("lists packages/ itself: a file in it is skipped, and any failure but ENOENT throws", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-ws-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), '{"name":"root"}');
      expect(readWorkspace(root).manifests).toHaveLength(1);
      // `packages` a file: listing it fails with ENOTDIR, which is no "no packages".
      fs.writeFileSync(path.join(root, "packages"), "");
      expect(() => readWorkspace(root)).toThrow(path.join(root, "packages"));
      fs.rmSync(path.join(root, "packages"));
      fs.mkdirSync(path.join(root, "packages", "a"), { recursive: true });
      fs.writeFileSync(path.join(root, "packages", "README.md"), "# x");
      fs.writeFileSync(path.join(root, "packages", "a", "package.json"), '{"name":"@x/a"}');
      expect(readWorkspace(root).manifests.map((m) => m.name)).toEqual(["root", "@x/a"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("satisfies this checkout's checkBash across the rules that read it", () => {
    const repo = path.resolve(import.meta.dirname, "..", "..");
    const workspace = readWorkspace(repo);
    const real = (shell) => fixedContext({ cwd: repo, shell, workspace });
    // With the snapshot a real package passes the lookup; without one every --filter stops there.
    expect(verdictOf(checkBash, "pnpm --filter @iracedeck/settings test", real(BASH))).toBe("PASS");
    expect(
      verdictOf(checkBash, "pnpm --filter @iracedeck/settings test", fixedContext({ cwd: repo, shell: BASH })),
    ).toMatch(/^DENY: No workspace package named/);
    const commands = [
      "ls -la",
      "jq .a package.json",
      "git push origin v1.0.0",
      "git -C ../ir-1 commit -m 'x' -- a.ts",
      "git worktree add ../ir-1 -b fix/1-x",
      "git worktree remove ../ir-1",
      "gh pr merge 5 --squash",
      "gh pr create --title 'feat(x): y (#1)' --body b",
      "gh issue create --title t --milestone 3.10.0",
      "pnpm relink:stream-deck",
      "pnpm --filter @iracedeck/x test",
      "$GH pr merge 5",
      "bash -c 'gh pr merge 5 --squash'",
    ];
    for (const command of commands) {
      const v = verdictOf(checkBash, command, real(BASH));
      expect(v, command).not.toMatch(/^THROW/);
    }
    expect(verdictOf(checkBash, "ls -la", real(BASH))).toBe("PASS");
    expect(verdictOf(checkBash, "jq .a package.json", real(BASH))).toMatch(/^DENY: /);
    expect(verdictOf(checkBash, "Get-ChildItem | Select-Object -First 3", real(POWERSHELL))).toBe("PASS");
    // The remote unreachable, not stale: a sibling worktree add asks only for its missing spec.
    expect(verdictOf(checkBash, "git worktree add ../ir-1 -b fix/1-x", real(BASH))).toMatch(/^ASK: No spec on master/);
  });
});

describe("verdicts", () => {
  it("are one comparable string each", () => {
    expect(formatVerdict(null)).toBe("PASS");
    expect(formatVerdict(undefined)).toBe("PASS");
    expect(formatVerdict("No jq here.")).toBe("DENY: No jq here.");
    expect(formatVerdict({ ask: "Sure?" })).toBe("ASK: Sure?");
    expect(formatVerdict({ ask: "Sure?", asks: ["Sure?"] })).toBe('OTHER: {"ask":"Sure?","asks":["Sure?"]}');
    expect(formatVerdict(false)).toBe("OTHER: false");
    expect(formatVerdict("")).toBe("DENY: ");
  });

  // PR #1798 review at 0dced8c2f: two throws alike on their first line only
  // differ, so the verdict keeps the whole message.
  it("count a throw as a verdict, by its whole message", () => {
    const throwing = (message) => () => {
      throw new Error(message);
    };
    expect(verdictOf(throwing("boom\n    at somewhere"), "x", {})).toBe("THROW: boom\n    at somewhere");
    const base = verdictOf(throwing("bad view\nat 3"), "x", {});
    const head = verdictOf(throwing("bad view\nat 9"), "x", {});
    expect(comparePair(base, head)).toBe("different");
    expect(comparePair(base, verdictOf(throwing("bad view\nat 3"), "x", {}))).toBe("threw");
    // Escaped only when printed.
    const d = { index: 1, tool: "Bash", command: "ls", base, head };
    expect(formatDifference(d, { showCommands: true }).slice(-2)).toEqual([
      "  base: THROW: bad view\\nat 3",
      "  head: THROW: bad view\\nat 9",
    ]);
    expect(formatDifference(d).slice(-3)).toEqual(["  base: THROW", "  head: THROW", "  (same kind, different text)"]);
    expect(
      verdictOf(
        () => {
          throw "bare";
        },
        "x",
        {},
      ),
    ).toBe("THROW: bare");
    expect(verdictOf((c) => (c === "x" ? null : "no"), "x", {})).toBe("PASS");
  });

  it("print a difference cut, on one line each, with the command only when asked", () => {
    expect(cut("a\nb\r\nc", 100)).toBe("a\\nb\\nc");
    expect(cut("x".repeat(400), 300)).toBe(`${"x".repeat(300)}...`);
    const d = { index: 7, tool: "Bash", command: "gh pr merge 5", base: "PASS", head: `DENY: ${"y".repeat(400)}` };
    const plain = formatDifference(d);
    expect(plain).toEqual(["#7 Bash", "  probe: real", "  base: PASS", "  head: DENY"]);
    expect(plain.join("\n")).not.toContain("gh pr merge");
    const shown = formatDifference(d, { showCommands: true });
    expect(shown[1]).toBe("  command: gh pr merge 5");
    // PR #1798 review: shown, a verdict is printed whole, as the option says.
    expect(shown.at(-1)).toBe(`  head: DENY: ${"y".repeat(400)}`);
    expect(formatDifference({ ...d, head: "DENY: a\nb" }, { showCommands: true }).at(-1)).toBe("  head: DENY: a\\nb");
  });

  // PR #1798 review: a pair where both sides threw is no identical verdict.
  it("tell a pair that agrees, one where both sides threw alike, and one that differs", () => {
    expect(comparePair("PASS", "PASS")).toBe("identical");
    expect(comparePair("DENY: x", "DENY: x")).toBe("identical");
    expect(comparePair("THROW: boom", "THROW: boom")).toBe("threw");
    expect(comparePair("THROW: boom", "THROW: bang")).toBe("different");
    expect(comparePair("THROW: boom", "PASS")).toBe("different");
    expect(exitStatus({ differences: 0, threw: 0 })).toBe(0);
    expect(exitStatus({ differences: 0, threw: 2 })).toBe(5);
    expect(exitStatus({ differences: 1, threw: 2 })).toBe(1);
    expect(USAGE).toMatch(/\b5\b.*threw/);
  });

  // CodeRabbit CLI on #1659: a deny's text can quote a command's raw
  // arguments (a refused PR title), so by default only its kind is printed.
  it("print only each verdict's kind unless the commands are shown", () => {
    const d = {
      index: 2,
      tool: "Bash",
      command: "x",
      base: "DENY: Title 'secret plan' is not <type>(<scope>): …",
      head: "DENY: This command hands text to a shell in a form the hook does not read (eval): `eval …`. Type …",
    };
    const forms = new Set(["eval"]);
    expect(formatDifference(d, { forms }).slice(2)).toEqual(["  base: DENY", "  head: DENY (stopping rule: eval)"]);
    expect(formatDifference({ ...d, head: "DENY: other 'secret'" }).slice(2)).toEqual([
      "  base: DENY",
      "  head: DENY",
      "  (same kind, different text)",
    ]);
    expect(formatDifference(d).join("\n")).not.toContain("secret");
    expect(formatDifference({ ...d, base: "ASK: Sure? 'secret'", head: "THROW: boom 'secret'" }).slice(2)).toEqual([
      "  base: ASK",
      "  head: THROW",
    ]);
    expect(verdictKind("PASS")).toBe("PASS");
    expect(verdictKind("OTHER: {}")).toBe("OTHER");
  });

  // CodeRabbit CLI round 2 on #1659: only the stopping rule's own message, and
  // only a form it knows, earns a label; an ordinary deny quoting the phrase is
  // plain DENY.
  it("label a deny only by the stopping rule's prefix and a form it knows", async () => {
    const forms = new Set(["eval"]);
    const stopping = (form) =>
      `DENY: This command hands text to a shell in a form the hook does not read (${form}): \`x\`. Type …`;
    expect(verdictKind(stopping("eval"), forms)).toBe("DENY (stopping rule: eval)");
    expect(verdictKind(stopping("secret plan"), forms)).toBe("DENY");
    expect(verdictKind(stopping("eval"))).toBe("DENY");
    expect(verdictKind("DENY: Title 'a form the hook does not read (eval)' is not <type>(<scope>)", forms)).toBe(
      "DENY",
    );
    // The lexer's own set, which main hands over, labels the deny checkBash writes.
    const { REFUSED_FORMS } = await import("./shell-lexer.mjs");
    expect(
      verdictKind(verdictOf(checkBash, `eval ls`, fixedContext({ cwd: "C:/r", shell: BASH })), REFUSED_FORMS),
    ).toBe("DENY (stopping rule: eval)");
  });

  // #1659 review: the acceptance gate (no real command changes verdict) is
  // applied by reading which pattern made each difference a probe.
  it("name the probe patterns a difference matched, or say it is real", () => {
    const d = { index: 3, tool: "PowerShell", base: "PASS", head: "DENY: x" };
    expect(formatDifference({ ...d, command: "ls" })[1]).toBe("  probe: real");
    expect(formatDifference({ ...d, command: "gh pr merge 99999 # shell-lexer" })[1]).toBe(
      "  probe: a PR number of 99999 or more; a hook module named",
    );
    expect(formatDifference({ ...d, command: "x" }, { showCommands: true }).slice(1, 3)).toEqual([
      "  command: x",
      "  probe: real",
    ]);
  });

  it("count the differences, real apart from probes", () => {
    const d = (command) => ({ index: 1, tool: "Bash", command, base: "PASS", head: "DENY: x" });
    expect(differenceSummary([])).toBe("differing verdicts: 0 (real 0, probe 0)");
    expect(differenceSummary([d("ls"), d("ls -la"), d("echo zz-probe")])).toBe(
      "differing verdicts: 3 (real 2, probe 1)",
    );
  });
});

describe("the census", () => {
  it("names a program position's kind", () => {
    expect(kindName(undefined)).toBe("command");
    expect(kindName({ how: "command" })).toBe("command");
    expect(kindName({ how: "shell", via: "bash" })).toBe("shell:bash");
    expect(kindName({ how: "wrapper", via: "find -exec" })).toBe("wrapper:find -exec");
  });

  // CodeRabbit CLI on #1659: the `refused` flag read the view alone, so a
  // PowerShell eval the hook refuses for the PowerShell tool was not counted.
  it("flags a refused form as the hook refuses it, with the command's shell", async () => {
    const lexer = await import("./shell-lexer.mjs");
    const flags = (tool, c) => commandCensus(lexer, tool, c).flags;
    expect(flags("PowerShell", `iex "Get-Location"`)).toContain("refused");
    expect(flags("PowerShell", `Invoke-Expression 'ls'`)).toContain("refused");
    expect(flags("PowerShell", `Get-Location`)).not.toContain("refused");
    expect(flags("Bash", `iex -S mix`)).not.toContain("refused");
    expect(flags("Bash", `eval ls`)).toContain("refused");
    expect([...commandCensus(lexer, "Bash", "gh pr view 7").positions]).toEqual([["command", 1]]);
  });

  // PR #1798 review at 0dced8c2f: a head from before the stopping rule has no
  // `refusedForms`, and its census still counts the positions; one whose
  // export throws still reports that.
  it("counts a lexer without refusedForms, and lets one that throws throw", async () => {
    const lexer = await import("./shell-lexer.mjs");
    const { refusedForms, ...older } = lexer;
    expect(refusedForms).toBeTypeOf("function");
    const census = commandCensus(older, "Bash", "gh pr view 7; eval ls");
    expect([...census.positions]).toEqual([["command", 2]]);
    expect(census.flags).not.toContain("refused");
    const broken = {
      ...lexer,
      refusedForms: () => {
        throw new Error("no forms");
      },
    };
    expect(() => commandCensus(broken, "Bash", "gh pr view 7")).toThrow("no forms");
  });

  it("counts positions by kind and the flags a view raises", () => {
    const view = {
      sure: false,
      programs: [
        [0, 4, 0, [], undefined],
        [8, 10, 8, [], { how: "shell", via: "bash" }],
        [20, 22, 20, [], undefined],
      ],
      unreadable: [{ start: 0 }],
      respelled: [],
      spliced: [],
      unsettled: false,
      unclosedLead: true,
      refused: [{ form: "eval", shape: "eval …" }],
    };
    const one = censusOf(view);
    expect([...one.positions]).toEqual([
      ["command", 2],
      ["shell:bash", 1],
    ]);
    expect(one.flags).toEqual(["unreadable", "unclosedLead", "refused", "!sure"]);

    const census = new Census();
    census.add(one, false);
    census.add(one, true);
    census.add(censusOf({ sure: true, programs: [[0, 2, 0, [], undefined]] }), false);
    census.add(null, true);
    expect(census.totals).toEqual({ real: 2, probe: 2, threw: 1 });
    expect(census.rows.get("program command")).toEqual({
      realCommands: 2,
      realPositions: 3,
      probeCommands: 1,
      probePositions: 2,
    });
    expect(census.rows.get("flag !sure")).toMatchObject({ realCommands: 1, probeCommands: 1 });
    expect(census.rows.get("view threw")).toMatchObject({ realCommands: 0, probeCommands: 1 });
    const table = census.format();
    expect(table[0].split(/\s{2,}/)).toEqual(["row", "real cmds", "real pos", "probe cmds", "probe pos"]);
    expect(table.slice(1).map((l) => l.split(/\s{2,}/)[0])).toEqual([
      "flag !sure",
      "flag refused",
      "flag unclosedLead",
      "flag unreadable",
      "program command",
      "program shell:bash",
      "view threw",
    ]);
  });
});

/** How long a case waits for a write that got through, well under Vitest's 5 s test timeout. */
const SETTLE_BOUND_MS = 2000;

/**
 * Waits up to `bound` ms for `pending`, the writes a case let through, with
 * the case `c` held from before the wait, so an afterEach run mid-wait by a
 * test timeout leaves its folder and descriptor alone ({@link leaveCase}).
 * Settled in time, the case goes back to its own cleanup, or is cleaned here
 * when that afterEach already ran; still pending, `clean` runs once it
 * settles (PR #1798 review at 0dced8c2f).
 */
async function settleOrDefer(c, pending, bound, clean) {
  c.unsettled = true;
  const late = Symbol("late");
  let timer;
  const outcome = await Promise.race([pending, new Promise((r) => (timer = setTimeout(() => r(late), bound)))]);
  clearTimeout(timer);
  if (outcome === late) pending.then(clean);
  else if (c.left) clean();
  else c.unsettled = false;
}

/** A case's afterEach: removes its folder, unless a write it let through is pending, whose wait then cleans up. */
function leaveCase(c) {
  if (c.unsettled) c.left = true;
  else fs.rmSync(c.owned, { recursive: true, force: true });
}

describe("side effects while judging", () => {
  it("make a spawn or a file write throw until restored, through ESM bindings too", () => {
    const spawnSync = childProcess.spawnSync;
    const writeFileSync = fs.writeFileSync;
    // A folder the test owns, removed whatever happens (CodeRabbit CLI round 2 on #1659).
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-write-"));
    const never = path.join(owned, "never-written.txt");
    try {
      const restore = forbidSideEffects();
      try {
        expect(() => childProcess.spawnSync("git", ["--version"])).toThrow(/spawnSync was called while judging/);
        expect(() => childProcess.execFileSync("git")).toThrow(/while judging/);
        expect(() => fs.writeFileSync(never, "x")).toThrow(/writeFileSync was called while judging/);
        expect(() => fs.readFileSync(path.join(import.meta.dirname, "pre-bash.mjs"), "utf8")).not.toThrow();
      } finally {
        restore();
      }
      expect(fs.existsSync(never)).toBe(false);
    } finally {
      fs.rmSync(owned, { recursive: true, force: true });
    }
    expect(childProcess.spawnSync).toBe(spawnSync);
    expect(fs.writeFileSync).toBe(writeFileSync);
  });

  // #1659 review: the promise API, the async writers, the copy and link
  // writers, and an open for writing escaped the list.
  // Every fixture lives in a folder the test owns, and only that folder is
  // cleaned (CodeRabbit CLI on #1659). A writer that got through would leave
  // its file there, or write to the fixture the descriptor writers are given.
  // Each case gets a folder of its own, so a write that escaped one case can
  // never touch the next case's fixture; a case whose escaped write has not
  // settled leaves its folder in place rather than delete under it (PR #1798
  // review), held by the case object `kase` ({@link settleOrDefer}).
  let owned;
  let never;
  let fixture;
  let kase;
  beforeEach(() => {
    owned = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-writers-"));
    never = path.join(owned, "never-written.txt");
    fixture = path.join(owned, "fixture.txt");
    kase = { owned, unsettled: false, left: false };
  });
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 0));
    leaveCase(kase);
  });
  const x = () => Buffer.from("x");
  it.each([
    ["fs.promises.writeFile", () => fs.promises.writeFile(never, "x")],
    ["fs.promises.appendFile", () => fs.promises.appendFile(never, "x")],
    ["fs.promises.mkdir", () => fs.promises.mkdir(never)],
    ["fs.promises.rm", () => fs.promises.rm(never)],
    ["fs.promises.rmdir", () => fs.promises.rmdir(never)],
    ["fs.promises.unlink", () => fs.promises.unlink(never)],
    ["fs.promises.rename", () => fs.promises.rename(never, `${never}.2`)],
    ["fs.promises.copyFile", () => fs.promises.copyFile(never, `${never}.2`)],
    ["fs.promises.cp", () => fs.promises.cp(never, `${never}.2`)],
    ["fs.promises.symlink", () => fs.promises.symlink(never, `${never}.2`)],
    ["fs/promises writeFile through its ESM binding", () => fsp.writeFile(never, "x")],
    ["fs.writeFile", (_, done) => fs.writeFile(never, "x", done)],
    ["fs.appendFile", (_, done) => fs.appendFile(never, "x", done)],
    ["fs.cp", (_, done) => fs.cp(never, `${never}.2`, done)],
    ["fs.cpSync", () => fs.cpSync(never, `${never}.2`)],
    ["fs.symlinkSync", () => fs.symlinkSync(never, `${never}.2`)],
    ["fs.writeSync", (fd) => fs.writeSync(fd, "x")],
    ["fs.writevSync", (fd) => fs.writevSync(fd, [x()])],
    ["fs.writev", (fd, done) => fs.writev(fd, [x()], done)],
    ["fs.openSync for writing", () => fs.openSync(never, "w")],
    ["fs.openSync for appending", () => fs.openSync(never, "a")],
    ["fs.openSync for reading and writing", () => fs.openSync(never, "r+")],
    ["fs.openSync with a numeric write flag", () => fs.openSync(never, fs.constants.O_WRONLY)],
    ["fs.openSync with a numeric create flag", () => fs.openSync(never, fs.constants.O_RDONLY | fs.constants.O_CREAT)],
    // PR #1798 review: a temp folder is a write too.
    ["fs.mkdtempSync", () => fs.mkdtempSync(path.join(owned, "made-"))],
    ["fs.mkdtemp", (_, done) => fs.mkdtemp(path.join(owned, "made-"), done)],
    ["fs.promises.mkdtemp", () => fs.promises.mkdtemp(path.join(owned, "made-"))],
    // PR #1798 review at 0dced8c2f: a write stream returned and failed later,
    // and a file's mode, owner and times are writes too.
    ["fs.createWriteStream", () => fs.createWriteStream(never)],
    ["fs.createWriteStream on a descriptor", (fd) => fs.createWriteStream(null, { fd, autoClose: false })],
    ["fs.chmodSync", () => fs.chmodSync(fixture, 0o666)],
    ["fs.promises.chmod", () => fs.promises.chmod(fixture, 0o666)],
    ["fs.utimesSync", () => fs.utimesSync(fixture, 1, 1)],
    ["fs.promises.utimes", () => fs.promises.utimes(fixture, 1, 1)],
    ["fs.futimes", (fd, done) => fs.futimes(fd, 1, 1, done)],
    ["fs.ftruncateSync", (fd) => fs.ftruncateSync(fd, 0)],
    ["fs.ftruncate", (fd, done) => fs.ftruncate(fd, 0, done)],
    ["fs.promises.truncate", () => fs.promises.truncate(fixture)],
  ])("make %s throw while judging", async (_, write) => {
    const c = kase;
    fs.writeFileSync(fixture, "");
    const fd = fs.openSync(fixture, "r+");
    try {
      // A writer that returns rather than throws has its promise or callback
      // settled before the test fails or cleans up, so nothing it does escapes
      // the test (PR #1798 review).
      let threw;
      let returned;
      let done;
      const called = new Promise((r) => (done = r));
      const restore = forbidSideEffects();
      try {
        returned = write(fd, () => done());
      } catch (e) {
        threw = e;
      } finally {
        restore();
      }
      if (!threw) {
        const settled = Promise.resolve(returned).then(
          () => {},
          () => {},
        );
        const callback = write.length > 1 ? called : Promise.resolve();
        // Still pending past the bound: this case's descriptor and folder stay
        // until the write settles, so the OS cannot hand that descriptor to a
        // later case while the write is queued on it (PR #1798 review).
        const dir = c.owned;
        await settleOrDefer(c, Promise.all([settled, callback]), SETTLE_BOUND_MS, () => {
          fs.closeSync(fd);
          fs.rmSync(dir, { recursive: true, force: true });
        });
      }
      expect(threw?.message).toMatch(/was called while judging|for writing while judging/);
      expect(fs.existsSync(never)).toBe(false);
      expect(fs.readFileSync(fixture, "utf8")).toBe("");
      expect(fs.readdirSync(c.owned)).toEqual(["fixture.txt"]);
    } finally {
      if (!c.unsettled) fs.closeSync(fd);
    }
  });

  // PR #1798 review at 0dced8c2f: the wait was as long as Vitest's own test
  // timeout, which could end the case first and run its afterEach while the
  // write was pending.
  describe("a write that got through", () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    let dir;
    let fd;
    let cleaned;
    let c;
    const clean = () => {
      cleaned++;
      fs.closeSync(fd);
      fs.rmSync(dir, { recursive: true, force: true });
    };
    const open = () => {
      try {
        fs.fstatSync(fd);
        return true;
      } catch {
        return false;
      }
    };
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-settle-"));
      fd = fs.openSync(path.join(dir, "fixture.txt"), "w");
      cleaned = 0;
      c = { owned: dir, unsettled: false, left: false };
    });
    afterEach(() => {
      if (!cleaned) fs.closeSync(fd);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("is held well under the test timeout", () => {
      expect(SETTLE_BOUND_MS).toBeLessThanOrEqual(2000);
    });

    it("released in time goes back to the case's own cleanup", async () => {
      await settleOrDefer(c, Promise.resolve(), 1000, clean);
      expect(c.unsettled).toBe(false);
      expect(cleaned).toBe(0);
      leaveCase(c);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("pending past the bound keeps its folder and descriptor through the afterEach, then cleans up once settled", async () => {
      let release;
      const pending = new Promise((r) => (release = r));
      await settleOrDefer(c, pending, 10, clean);
      expect(c.unsettled).toBe(true);
      leaveCase(c);
      expect(fs.existsSync(dir)).toBe(true);
      expect(open()).toBe(true);
      expect(cleaned).toBe(0);
      release();
      await pending;
      await tick();
      expect(cleaned).toBe(1);
      expect(fs.existsSync(dir)).toBe(false);
      expect(open()).toBe(false);
    });

    it("held before the wait, so an afterEach a timeout runs mid-wait leaves it, and the wait cleans up", async () => {
      let release;
      const pending = new Promise((r) => (release = r));
      const waiting = settleOrDefer(c, pending, 1000, clean);
      leaveCase(c);
      expect(fs.existsSync(dir)).toBe(true);
      expect(open()).toBe(true);
      release();
      await waiting;
      expect(cleaned).toBe(1);
      expect(fs.existsSync(dir)).toBe(false);
    });
  });

  it("let a temp folder be made again once restored", async () => {
    forbidSideEffects()();
    const made = [fs.mkdtempSync(path.join(owned, "a-")), await fs.promises.mkdtemp(path.join(owned, "b-"))];
    made.push(await new Promise((r, j) => fs.mkdtemp(path.join(owned, "c-"), (e, d) => (e ? j(e) : r(d)))));
    for (const d of made) expect(fs.statSync(d).isDirectory()).toBe(true);
  });

  it("tell an open's flags that write from those that read", () => {
    const c = fs.constants;
    for (const f of ["w", "wx", "w+", "a", "ax", "a+", "as+", "r+", "rs+", c.O_WRONLY, c.O_RDWR, c.O_CREAT, c.O_APPEND])
      expect(opensForWriting(f, c), String(f)).toBe(true);
    for (const f of [undefined, null, "r", "rs", c.O_RDONLY, () => {}])
      expect(opensForWriting(f, c), String(f)).toBe(false);
  });

  it("leave a read alone, an open for reading among them, and restore every writer", () => {
    const originals = {
      writeFile: fs.promises.writeFile,
      cpSync: fs.cpSync,
      openSync: fs.openSync,
      fspWriteFile: fsp.writeFile,
    };
    const here = path.join(import.meta.dirname, "pre-bash.mjs");
    const restore = forbidSideEffects();
    try {
      const fd = fs.openSync(here, "r");
      fs.closeSync(fd);
      const fd2 = fs.openSync(here);
      fs.closeSync(fd2);
      expect(fs.readFileSync(here, "utf8")).toContain("checkBash");
    } finally {
      restore();
    }
    expect(fs.promises.writeFile).toBe(originals.writeFile);
    expect(fs.cpSync).toBe(originals.cpSync);
    expect(fs.openSync).toBe(originals.openSync);
    expect(fsp.writeFile).toBe(originals.fspWriteFile);
  });
});

describe("the command line", () => {
  it("reads its options, with the defaults", () => {
    expect(parseCli(["--transcripts", "d"])).toEqual({
      transcripts: "d",
      match: undefined,
      base: "origin/master",
      headDir: undefined,
      censusOnly: false,
      showCommands: false,
    });
    expect(
      parseCli([
        "--transcripts",
        "d",
        "--match",
        "iRaceDeck",
        "--base",
        "HEAD",
        "--head-dir",
        "h",
        "--census-only",
        "--show-commands",
      ]),
    ).toEqual({
      transcripts: "d",
      match: "iRaceDeck",
      base: "HEAD",
      headDir: "h",
      censusOnly: true,
      showCommands: true,
    });
  });

  it("refuses a missing folder, an unknown option and a stray argument", () => {
    expect(parseCli([]).error).toMatch(/--transcripts/);
    expect(parseCli(["--transcripts", "d", "--bogus"]).error).toBeDefined();
    expect(parseCli(["--transcripts", "d", "extra"]).error).toBeDefined();
    expect(parseCli(["--help"])).toEqual({ help: true });
  });

  it("exits 3 on a manifest it cannot read, naming it", async () => {
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-main-"));
    try {
      const transcripts = path.join(owned, "t");
      fs.mkdirSync(transcripts);
      const root = path.join(owned, "checkout");
      fs.mkdirSync(path.join(root, "packages", "odd", "package.json"), { recursive: true });
      const out = [];
      expect(await main(["--transcripts", transcripts, "--census-only"], (l) => out.push(l), { root })).toBe(3);
      expect(out.join("\n")).toContain(path.join(root, "packages", "odd", "package.json"));
    } finally {
      fs.rmSync(owned, { recursive: true, force: true });
    }
  });

  // CodeRabbit CLI on #1659: an unlistable subfolder threw out of main.
  it("exits 3 when a transcript folder cannot be listed, naming it", async () => {
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-main-"));
    const locked = path.join(owned, "t", "locked");
    fs.mkdirSync(locked, { recursive: true });
    const cjs = createRequire(import.meta.url)("node:fs");
    const readdirSync = cjs.readdirSync;
    cjs.readdirSync = function (p, ...rest) {
      if (path.resolve(String(p)) === locked)
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${locked}'`), { code: "EACCES" });
      return readdirSync.call(this, p, ...rest);
    };
    syncBuiltinESMExports();
    try {
      const out = [];
      const status = await main(["--transcripts", path.join(owned, "t"), "--census-only"], (l) => out.push(l), {
        root: owned,
      });
      expect(status).toBe(3);
      expect(out.join("\n")).toContain(locked);
    } finally {
      cjs.readdirSync = readdirSync;
      syncBuiltinESMExports();
      fs.rmSync(owned, { recursive: true, force: true });
    }
  });

  // CodeRabbit CLI on #1659: the base copy is removed whatever stops the run once it exists.
  // CodeRabbit CLI round 2 on #1659: the test proves it reached the
  // workspace failure, and tracks the very copy the run made.
  it("removes the base copy when the workspace cannot be read", async () => {
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-main-"));
    try {
      fs.mkdirSync(path.join(owned, "t"));
      const manifest = path.join(owned, "checkout", "packages", "odd", "package.json");
      fs.mkdirSync(manifest, { recursive: true });
      const out = [];
      const copies = [];
      const status = await main(["--transcripts", path.join(owned, "t"), "--base", "HEAD"], (l) => out.push(l), {
        root: path.join(owned, "checkout"),
        onBaseCopy: (dir) => copies.push({ dir, there: fs.existsSync(path.join(dir, "scripts")) }),
      });
      expect(status, out.join("\n")).toBe(3);
      expect(out.join("\n")).toMatch(/could not read the workspace/);
      expect(out.join("\n")).toContain(manifest);
      expect(copies).toHaveLength(1);
      expect(copies[0].there).toBe(true);
      expect(fs.existsSync(copies[0].dir)).toBe(false);
    } finally {
      fs.rmSync(owned, { recursive: true, force: true });
    }
  }, 60_000);

  // PR #1798 review: a whole comparison run, a fake head side beside the real
  // base, one command matching and one differing.
  it("compares a corpus end to end, counting what matches and what differs", async () => {
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-main-"));
    try {
      const hooks = path.join(owned, "head", "scripts", "claude-hooks");
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(
        path.join(hooks, "rules-bash.mjs"),
        'export const checkBash = (c) => (c === "ls -la" ? "fake deny" : null);\n',
      );
      fs.writeFileSync(
        path.join(hooks, "shell-lexer.mjs"),
        [
          'export const BASH = "bash";',
          'export const POWERSHELL = "powershell";',
          "export const view = () => ({ programs: [], sure: true });",
          "export const powershellAsBash = (c) => c;",
          "export const refusedForms = () => [];",
          "",
        ].join("\n"),
      );
      fs.mkdirSync(path.join(owned, "t"));
      fs.writeFileSync(
        path.join(owned, "t", "a.jsonl"),
        `${line(toolUse("Bash", { command: "ls" }), toolUse("Bash", { command: "ls -la" }))}\n`,
      );
      const out = [];
      const status = await main(
        ["--transcripts", path.join(owned, "t"), "--base", "HEAD", "--head-dir", path.join(owned, "head")],
        (l) => out.push(l),
        { root: owned },
      );
      const text = out.join("\n");
      expect(status, text).toBe(1);
      expect(text).toContain("commands judged: 2");
      expect(text).toContain("identical verdicts: 1");
      expect(text).toContain("both sides threw alike: 0");
      expect(text).toContain("differing verdicts: 1 (real 1, probe 0)");
      expect(text).toMatch(/#2 Bash\n {2}probe: real\n {2}base: PASS\n {2}head: DENY\n/);
    } finally {
      fs.rmSync(owned, { recursive: true, force: true });
    }
  }, 60_000);

  // CLI check of be3d79a4b: the head checkout's rules ran with the tool
  // checkout's cwd and manifests; both sides now get the head's, unless
  // the caller names a root.
  it("judges with the head checkout's context by default, and the caller's root when given", async () => {
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-main-"));
    try {
      const head = path.join(owned, "head");
      const hooks = path.join(head, "scripts", "claude-hooks");
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, "rules-bash.mjs"), "export const checkBash = () => null;\n");
      fs.writeFileSync(
        path.join(hooks, "shell-lexer.mjs"),
        [
          'export const BASH = "bash";',
          'export const POWERSHELL = "powershell";',
          "export const view = () => ({ programs: [], sure: true });",
          "export const powershellAsBash = (c) => c;",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(head, "package.json"), '{ "name": "head-only" }\n');
      fs.mkdirSync(path.join(owned, "t"));
      fs.writeFileSync(path.join(owned, "t", "a.jsonl"), `${line(toolUse("Bash", { command: "ls" }))}\n`);
      const args = ["--transcripts", path.join(owned, "t"), "--census-only", "--head-dir", head];
      const out = [];
      expect(await main(args, (l) => out.push(l))).toBe(0);
      expect(out).toContain(`context: cwd ${head}, 1 package manifests`);
      const other = path.join(owned, "other");
      fs.mkdirSync(other);
      const given = [];
      expect(await main(args, (l) => given.push(l), { root: other })).toBe(0);
      expect(given).toContain(`context: cwd ${other}, 0 package manifests`);
    } finally {
      fs.rmSync(owned, { recursive: true, force: true });
    }
  }, 60_000);

  // CLI check of be3d79a4b: a comparison that skipped a record it could not
  // parse compared part of the corpus, so it does not exit 0; a census still
  // prints its partial counts and exits 0.
  it("exits 3 when a comparison skipped an unparsed tool-use record", async () => {
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-main-"));
    try {
      fs.mkdirSync(path.join(owned, "t"));
      fs.writeFileSync(
        path.join(owned, "t", "a.jsonl"),
        `${line(toolUse("Bash", { command: "ls" }))}\n{broken tool_use\n`,
      );
      const args = ["--transcripts", path.join(owned, "t")];
      const out = [];
      const status = await main([...args, "--base", "HEAD"], (l) => out.push(l), { root: owned });
      expect(status, out.join("\n")).toBe(3);
      expect(out).toContain("tool-use lines not JSON: 1");
      expect(out.join("\n")).toMatch(/1 tool-use line did not parse/);
      expect(await main([...args, "--census-only"], () => {}, { root: owned })).toBe(0);
      expect(exitStatus({ differences: 1, threw: 0, unparsed: 1 })).toBe(1);
      expect(exitStatus({ differences: 0, threw: 1, unparsed: 1 })).toBe(3);
      expect(USAGE).toMatch(/\b3\b.*did not parse/);
    } finally {
      fs.rmSync(owned, { recursive: true, force: true });
    }
  }, 60_000);

  // CodeRabbit CLI round 2 on #1659: a comparison that judged nothing (a
  // mistyped --match) proves nothing, so it says so and exits 4.
  it("exits 4 when a comparison judges no command, and 0 for an empty census", async () => {
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), "replay-corpus-main-"));
    try {
      fs.mkdirSync(path.join(owned, "t"));
      fs.writeFileSync(path.join(owned, "t", "a.jsonl"), `${line(toolUse("Bash", { command: "ls" }))}\n`);
      const out = [];
      const args = ["--transcripts", path.join(owned, "t"), "--match", "no-such-folder"];
      expect(await main([...args, "--base", "HEAD"], (l) => out.push(l), { root: owned })).toBe(4);
      expect(out.join("\n")).toMatch(/no commands judged/);
      expect(await main([...args, "--census-only"], () => {}, { root: owned })).toBe(0);
      expect(USAGE).toMatch(/\b4\b.*no command/);
    } finally {
      fs.rmSync(owned, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits 2 on a usage error, naming the problem", async () => {
    const out = [];
    expect(await main(["--nope"], (l) => out.push(l))).toBe(2);
    expect(out.join("\n")).toMatch(/Usage:/);
    expect(await main(["--transcripts", path.join(os.tmpdir(), "no-such-replay-corpus-dir")], () => {})).toBe(2);
  });
});
