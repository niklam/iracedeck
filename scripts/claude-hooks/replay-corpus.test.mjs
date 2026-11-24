import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  Census,
  censusOf,
  CommandSet,
  CONTEXT_FIELDS,
  cut,
  differenceSummary,
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

  it("count a throw as a verdict, by the first line of its message", () => {
    expect(
      verdictOf(
        () => {
          throw new Error("boom\n    at somewhere");
        },
        "x",
        {},
      ),
    ).toBe("THROW: boom");
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
    expect(plain).toEqual(["#7 Bash", "  probe: real", "  base: PASS", `  head: DENY: ${"y".repeat(294)}...`]);
    expect(plain.join("\n")).not.toContain("gh pr merge");
    expect(formatDifference(d, { showCommands: true })[1]).toBe("  command: gh pr merge 5");
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

describe("side effects while judging", () => {
  it("make a spawn or a file write throw until restored, through ESM bindings too", () => {
    const spawnSync = childProcess.spawnSync;
    const writeFileSync = fs.writeFileSync;
    const restore = forbidSideEffects();
    try {
      expect(() => childProcess.spawnSync("git", ["--version"])).toThrow(/spawnSync was called while judging/);
      expect(() => childProcess.execFileSync("git")).toThrow(/while judging/);
      expect(() => fs.writeFileSync(path.join(os.tmpdir(), "replay-corpus-never-written.txt"), "x")).toThrow(
        /writeFileSync was called while judging/,
      );
      expect(() => fs.readFileSync(path.join(import.meta.dirname, "pre-bash.mjs"), "utf8")).not.toThrow();
    } finally {
      restore();
    }
    expect(childProcess.spawnSync).toBe(spawnSync);
    expect(fs.writeFileSync).toBe(writeFileSync);
  });

  // #1659 review: the promise API, the async writers, the copy and link
  // writers, and an open for writing escaped the list.
  const never = path.join(os.tmpdir(), "replay-corpus-never-written.txt");
  // A writer that got through would leave its file: removed, so it fails once.
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 0));
    for (const p of [never, `${never}.2`]) fs.rmSync(p, { recursive: true, force: true });
  });
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
    ["fs.writeFile", () => fs.writeFile(never, "x", () => {})],
    ["fs.appendFile", () => fs.appendFile(never, "x", () => {})],
    ["fs.cp", () => fs.cp(never, `${never}.2`, () => {})],
    ["fs.cpSync", () => fs.cpSync(never, `${never}.2`)],
    ["fs.symlinkSync", () => fs.symlinkSync(never, `${never}.2`)],
    ["fs.writeSync", () => fs.writeSync(1, "x")],
    ["fs.openSync for writing", () => fs.openSync(never, "w")],
    ["fs.openSync for appending", () => fs.openSync(never, "a")],
    ["fs.openSync for reading and writing", () => fs.openSync(never, "r+")],
    ["fs.openSync with a numeric write flag", () => fs.openSync(never, fs.constants.O_WRONLY)],
    ["fs.openSync with a numeric create flag", () => fs.openSync(never, fs.constants.O_RDONLY | fs.constants.O_CREAT)],
  ])("make %s throw while judging", (_, write) => {
    const restore = forbidSideEffects();
    try {
      expect(write).toThrow(/was called while judging|for writing while judging/);
    } finally {
      restore();
    }
    expect(fs.existsSync(never)).toBe(false);
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

  it("exits 2 on a usage error, naming the problem", async () => {
    const out = [];
    expect(await main(["--nope"], (l) => out.push(l))).toBe(2);
    expect(out.join("\n")).toMatch(/Usage:/);
    expect(await main(["--transcripts", path.join(os.tmpdir(), "no-such-replay-corpus-dir")], () => {})).toBe(2);
  });
});
