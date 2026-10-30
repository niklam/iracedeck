/**
 * `integration-build.mjs` against real temporary git repositories (#1520): a
 * bare `origin.git`, a clone `main` standing in for the master checkout, and
 * the `ir-integration` tree the script creates beside it — the same layout as
 * the real checkouts, so the sibling path and the shared refs are exercised
 * rather than assumed. Git runs for real; `pnpm` and the host-app script never
 * do: the build path is driven through an injected `exec` that answers them
 * with canned output, and every command is recorded so the suite can assert
 * that nothing was ever pushed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildIntegration,
  defaultExec,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  IntegrationRefusal,
  integrationTreePath,
  main,
  parseCliArgs,
  runBuild,
  tsDiagnostics,
} from "./integration-build.mjs";

let workspace;
let origin;
let repo;
let tree;
let calls;

/** Every test spawns git a few dozen times; on Windows that is seconds, not milliseconds. */
const GIT_TIMEOUT_MS = 30_000;

function git(args, cwd = repo) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);

  return r.stdout.trim();
}

function commitFile(file, text, message, cwd = repo) {
  writeFileSync(join(cwd, file), text);
  git(["add", file], cwd);
  git(["commit", "-q", "-m", message], cwd);

  return git(["rev-parse", "HEAD"], cwd);
}

/** A branch off master carrying one commit, left checked out nowhere. */
function branch(name, file, text) {
  git(["switch", "-q", "-c", name, "master"]);
  const sha = commitFile(file, text, `${name}: ${file}`);
  git(["switch", "-q", "master"]);

  return sha;
}

function silentLog() {
  return { log: vi.fn(), error: vi.fn() };
}

function output(log) {
  return [...log.log.mock.calls, ...log.error.mock.calls].map((args) => args.join(" ")).join("\n");
}

const ok = (out = "") => ({ ok: true, code: 0, out, err: "" });
const failed = (out = "", code = 1) => ({ ok: false, code, out, err: "" });

/**
 * Real git through `defaultExec`, canned answers for everything else, and a
 * record of every call. `answers` maps `"<cmd> <args…>"` to a result.
 */
function recordingExec(answers = {}) {
  return async (cmd, args, options) => {
    calls.push({ cmd, args, cwd: options?.cwd, stream: options?.stream ?? false });
    if (cmd === "git") return defaultExec(cmd, args, { ...options, stream: false });
    const key = [cmd, ...args].join(" ");

    return answers[key] ?? ok();
  };
}

const commandLines = () => calls.map(({ cmd, args }) => [cmd, ...args].join(" "));
const noLinks = () => [];

beforeEach(() => {
  calls = [];
  workspace = mkdtempSync(join(tmpdir(), "ird-integration-"));
  origin = join(workspace, "origin.git");
  repo = join(workspace, "master");
  tree = join(workspace, "ir-integration");
  git(["init", "-q", "--bare", "-b", "master", origin], workspace);
  git(["clone", "-q", origin, repo], workspace);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["symbolic-ref", "HEAD", "refs/heads/master"]);
  commitFile("shared.txt", "base\n", "base");
  git(["push", "-q", "-u", "origin", "master"]);
}, GIT_TIMEOUT_MS);

afterEach(() => {
  // The invariant every test shares: the script never pushes anything.
  expect(calls.filter(({ cmd, args }) => cmd === "git" && args.includes("push"))).toEqual([]);
  rmSync(workspace, { recursive: true, force: true });
});

describe("integrationTreePath", () => {
  it("is the ir-integration sibling of the main checkout", () => {
    expect(integrationTreePath(repo)).toBe(tree);
  });
});

describe("buildIntegration — merging", { timeout: GIT_TIMEOUT_MS }, () => {
  it("creates the tree on branch integration and merges every branch in order with its full sha", async () => {
    const a = branch("feature/1-a", "a.txt", "a\n");
    const b = branch("feature/2-b", "b.txt", "b\n");

    const result = await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-a", "feature/2-b"],
      build: false,
      exec: recordingExec(),
      log: silentLog(),
    });

    expect(result.tree).toBe(tree);
    expect(result.conflict).toBeUndefined();
    expect(result.merged).toEqual([
      { branch: "feature/1-a", sha: a },
      { branch: "feature/2-b", sha: b },
    ]);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(git(["symbolic-ref", "--short", "HEAD"], tree)).toBe("integration");
    expect(existsSync(join(tree, "a.txt")) && existsSync(join(tree, "b.txt"))).toBe(true);
    // --no-ff: two merge commits, the later one's second parent is b's head.
    expect(git(["rev-parse", "HEAD^2"], tree)).toBe(b);
    expect(git(["rev-parse", "HEAD^1^2"], tree)).toBe(a);
    expect(git(["rev-parse", "HEAD^1^1"], tree)).toBe(git(["rev-parse", "origin/master"]));
    expect(git(["status", "--porcelain"], tree)).toBe("");
    // The new branch tracks nothing, so a bare push from the tree has no upstream to go to.
    expect(spawnSync("git", ["rev-parse", "--abbrev-ref", "integration@{upstream}"], { cwd: tree }).status).not.toBe(0);
  });

  it("names the merged branch and its sha in each merge commit", async () => {
    const a = branch("feature/1-a", "a.txt", "a\n");

    await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-a"],
      build: false,
      exec: recordingExec(),
      log: silentLog(),
    });

    expect(git(["log", "-1", "--format=%s"], tree)).toBe(`Merge branch 'feature/1-a' at ${a} into integration`);
  });

  it("starts every run from a fresh origin/master, dropping the previous run's merges", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const b = branch("feature/2-b", "b.txt", "b\n");
    await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-a"],
      build: false,
      exec: recordingExec(),
      log: silentLog(),
    });

    // master moves on the remote between runs, through another clone.
    const other = join(workspace, "other");
    git(["clone", "-q", origin, other], workspace);
    git(["config", "user.name", "Test"], other);
    git(["config", "user.email", "test@example.invalid"], other);
    const upstream = commitFile("later.txt", "later\n", "later on master", other);
    git(["push", "-q", "origin", "master"], other);

    const result = await buildIntegration({
      repoRoot: repo,
      branches: ["feature/2-b"],
      build: false,
      exec: recordingExec(),
      log: silentLog(),
    });

    expect(result.merged).toEqual([{ branch: "feature/2-b", sha: b }]);
    expect(existsSync(join(tree, "a.txt"))).toBe(false);
    expect(existsSync(join(tree, "b.txt"))).toBe(true);
    expect(git(["rev-parse", "HEAD^1"], tree)).toBe(upstream);
    expect(commandLines()).toContain("git fetch origin");
  });

  it("works from inside a worktree, resolving the main checkout first", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const issueTree = join(workspace, "ir-7");
    git(["worktree", "add", "-q", "-b", "fix/7-x", issueTree, "master"]);

    const result = await buildIntegration({
      repoRoot: issueTree,
      branches: ["feature/1-a"],
      build: false,
      exec: recordingExec(),
      log: silentLog(),
    });

    expect(result.tree).toBe(tree);
  });

  it("re-attaches an existing integration branch when the tree itself was removed", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-a"],
      build: false,
      exec: recordingExec(),
      log: silentLog(),
    });
    git(["worktree", "remove", tree]);

    const result = await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-a"],
      build: false,
      exec: recordingExec(),
      log: silentLog(),
    });

    expect(result.merged).toHaveLength(1);
    expect(git(["symbolic-ref", "--short", "HEAD"], tree)).toBe("integration");
  });

  it("accepts a remote-tracking branch name", async () => {
    const c = branch("feature/3-c", "c.txt", "c\n");
    git(["push", "-q", "origin", "feature/3-c"]);

    const result = await buildIntegration({
      repoRoot: repo,
      branches: ["origin/feature/3-c"],
      build: false,
      exec: recordingExec(),
      log: silentLog(),
    });

    expect(result.merged).toEqual([{ branch: "origin/feature/3-c", sha: c }]);
  });
});

describe("buildIntegration — a conflict", { timeout: GIT_TIMEOUT_MS }, () => {
  it("aborts the conflicting merge, reports it against what was merged before, and leaves nothing half-merged", async () => {
    const x = branch("feature/1-x", "shared.txt", "x\n");
    branch("feature/2-y", "shared.txt", "y\n");
    branch("feature/3-z", "z.txt", "z\n");

    const result = await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-x", "feature/2-y", "feature/3-z"],
      build: true,
      exec: recordingExec(),
      links: noLinks,
      log: silentLog(),
    });

    expect(result.merged).toEqual([{ branch: "feature/1-x", sha: x }]);
    expect(result.conflict).toEqual({
      branch: "feature/2-y",
      files: ["shared.txt"],
      mergedBefore: ["feature/1-x"],
    });
    expect(commandLines()).toContain("git merge --abort");
    expect(git(["status", "--porcelain"], tree)).toBe("");
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { cwd: tree }).status).not.toBe(0);
    expect(git(["rev-parse", "HEAD^2"], tree)).toBe(x);
    // It stops: the branch after the conflict is not merged, and nothing builds.
    expect(existsSync(join(tree, "z.txt"))).toBe(false);
    expect(result.build).toBeUndefined();
    expect(calls.some(({ cmd }) => cmd === "pnpm")).toBe(false);
  });

  it("reports a conflict with origin/master alone as an empty mergedBefore", async () => {
    branch("feature/1-x", "shared.txt", "x\n");
    commitFile("shared.txt", "moved on\n", "master edits shared");
    git(["push", "-q", "origin", "master"]);

    const result = await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-x"],
      build: false,
      exec: recordingExec(),
      log: silentLog(),
    });

    expect(result.conflict).toEqual({ branch: "feature/1-x", files: ["shared.txt"], mergedBefore: [] });
    expect(git(["status", "--porcelain"], tree)).toBe("");
  });
});

describe("buildIntegration — refusals", { timeout: GIT_TIMEOUT_MS }, () => {
  async function seedTree() {
    branch("feature/1-a", "a.txt", "a\n");
    await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-a"],
      build: false,
      exec: recordingExec(),
      log: silentLog(),
    });
    calls = [];
  }

  const attempt = () =>
    buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-a"],
      build: false,
      exec: recordingExec(),
      log: silentLog(),
    });

  /** A refused run must not have fetched, reset or merged anything. */
  function expectUntouched() {
    expect(commandLines().filter((line) => /^git (fetch|reset|merge|worktree add)/.test(line))).toEqual([]);
  }

  it("refuses a tree with an untracked file", async () => {
    await seedTree();
    writeFileSync(join(tree, "stray.txt"), "left behind\n");

    await expect(attempt()).rejects.toThrow(IntegrationRefusal);
    await expect(attempt()).rejects.toThrow(/uncommitted changes/);
    expectUntouched();
    expect(existsSync(join(tree, "stray.txt"))).toBe(true);
  });

  it("refuses a tree with a modified tracked file", async () => {
    await seedTree();
    writeFileSync(join(tree, "shared.txt"), "edited in place\n");

    await expect(attempt()).rejects.toThrow(/uncommitted changes/);
    expectUntouched();
  });

  it("refuses a tree on another branch", async () => {
    await seedTree();
    git(["switch", "-q", "-c", "elsewhere"], tree);

    await expect(attempt()).rejects.toThrow(/on branch elsewhere, not integration/);
    expectUntouched();
  });

  it("refuses a tree with a detached HEAD", async () => {
    await seedTree();
    git(["switch", "-q", "--detach"], tree);

    await expect(attempt()).rejects.toThrow(/detached/);
    expectUntouched();
  });

  it("refuses a directory at the tree's path that is not a worktree of this repository", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    mkdirSync(tree);

    await expect(attempt()).rejects.toThrow(/not a worktree of/);
    expectUntouched();
  });

  it("refuses an unknown branch before touching the tree", async () => {
    await seedTree();

    await expect(
      buildIntegration({
        repoRoot: repo,
        branches: ["feature/9-nope"],
        build: false,
        exec: recordingExec(),
        log: silentLog(),
      }),
    ).rejects.toThrow(/feature\/9-nope/);
    expect(commandLines().filter((line) => /^git (reset|merge|worktree add)/.test(line))).toEqual([]);
  });

  it.each([
    [[], /at least one branch/],
    [["feature/1-a", "feature/1-a"], /more than once/],
    [["integration"], /integration branch itself/],
    [["--force"], /cannot start with "-"/],
  ])("refuses the branch list %j", async (branches, message) => {
    await expect(
      buildIntegration({ repoRoot: repo, branches, build: false, exec: recordingExec(), log: silentLog() }),
    ).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it("refuses a directory that is not inside a git repository", async () => {
    const outside = join(workspace, "plain");
    mkdirSync(outside);

    await expect(
      buildIntegration({ repoRoot: outside, branches: ["x"], build: false, exec: recordingExec(), log: silentLog() }),
    ).rejects.toThrow(IntegrationRefusal);
  });
});

describe("buildIntegration — the build", { timeout: GIT_TIMEOUT_MS }, () => {
  it("installs and builds in the tree after the merges unless told not to", async () => {
    branch("feature/1-a", "a.txt", "a\n");

    await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-a"],
      build: true,
      exec: recordingExec(),
      links: noLinks,
      log: silentLog(),
    });

    const pnpm = calls.filter(({ cmd }) => cmd === "pnpm");
    expect(pnpm.map(({ args }) => args.join(" "))).toEqual(["install", "build"]);
    expect(pnpm.every(({ cwd, stream }) => cwd === tree && stream)).toBe(true);
    const lines = commandLines();
    expect(lines.indexOf("pnpm install")).toBeGreaterThan(lines.findLastIndex((line) => line.startsWith("git merge")));
  });

  it("runs no pnpm or host command with build: false", async () => {
    branch("feature/1-a", "a.txt", "a\n");

    const result = await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-a"],
      build: false,
      exec: recordingExec(),
      links: () => {
        throw new Error("links must not be read without a build");
      },
      log: silentLog(),
    });

    expect(result.build).toBeUndefined();
    expect(calls.every(({ cmd }) => cmd === "git")).toBe(true);
  });
});

describe("runBuild", () => {
  const TREE = join("C:", "deck", "ir-integration");
  const linkedTo =
    (...hosts) =>
    () =>
      hosts.map((host) => ({ host, link: `link-${host}`, target: join(TREE, "packages", "plugin", "x.sdPlugin") }));

  function fakeExec(answers = {}) {
    return async (cmd, args, options) => {
      calls.push({ cmd, args, cwd: options?.cwd, stream: options?.stream ?? false });

      return answers[[cmd, ...args].join(" ")] ?? ok();
    };
  }

  it("restarts the Stream Deck plugin after a good build when Stream Deck links to the tree", async () => {
    const result = await runBuild({ tree: TREE, exec: fakeExec(), links: linkedTo("Stream Deck"), log: silentLog() });

    expect(result).toEqual({ ok: true, tsErrors: [], linkedHosts: ["Stream Deck"], restartYourself: [] });
    expect(commandLines()).toEqual(["pnpm install", "pnpm build", "pnpm restart:stream-deck"]);
  });

  it("stops Mirabox and Ulanzi before the install and starts them after the build", async () => {
    const result = await runBuild({
      tree: TREE,
      exec: fakeExec(),
      links: linkedTo("Mirabox", "Ulanzi"),
      log: silentLog(),
    });

    expect(result.ok).toBe(true);
    expect(commandLines()).toEqual([
      "node scripts/host-app.mjs stop mirabox",
      "node scripts/host-app.mjs stop ulanzi",
      "pnpm install",
      "pnpm build",
      "node scripts/host-app.mjs start mirabox",
      "node scripts/host-app.mjs start ulanzi",
    ]);
  });

  it("restarts nothing and says so when no host links to the tree", async () => {
    const log = silentLog();
    const links = () => [
      { host: "Stream Deck", link: "l", target: join("C:", "deck", "master", "packages", "x") },
      { host: "Mirabox", link: "l", target: undefined },
      { host: "Ulanzi", link: "l", target: "(a real directory, not a link)" },
    ];

    const result = await runBuild({ tree: TREE, exec: fakeExec(), links, log });

    expect(result.linkedHosts).toEqual([]);
    expect(commandLines()).toEqual(["pnpm install", "pnpm build"]);
    expect(output(log)).toMatch(/No deck host links to/);
  });

  it("fails on a TypeScript diagnostic even when the build exits 0, and restarts no plugin", async () => {
    const exec = fakeExec({
      "pnpm build": ok(
        "rollup v4\nsrc/plugin.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
      ),
    });

    const result = await runBuild({ tree: TREE, exec, links: linkedTo("Stream Deck"), log: silentLog() });

    expect(result.ok).toBe(false);
    expect(result.tsErrors).toEqual([
      "src/plugin.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    ]);
    expect(commandLines()).not.toContain("pnpm restart:stream-deck");
  });

  it("fails on a non-zero build and still starts the hosts it stopped", async () => {
    const exec = fakeExec({ "pnpm build": failed("boom") });

    const result = await runBuild({ tree: TREE, exec, links: linkedTo("Stream Deck", "Mirabox"), log: silentLog() });

    expect(result.ok).toBe(false);
    expect(result.failure).toMatch(/pnpm build/);
    expect(commandLines()).toEqual([
      "node scripts/host-app.mjs stop mirabox",
      "pnpm install",
      "pnpm build",
      "node scripts/host-app.mjs start mirabox",
    ]);
  });

  it("does not build when the install fails", async () => {
    const result = await runBuild({
      tree: TREE,
      exec: fakeExec({ "pnpm install": failed() }),
      links: noLinks,
      log: silentLog(),
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toMatch(/pnpm install/);
    expect(commandLines()).toEqual(["pnpm install"]);
  });

  it("does not build under a host it could not stop, and restarts the ones it did", async () => {
    const exec = fakeExec({ "node scripts/host-app.mjs stop ulanzi": failed("Access is denied") });

    const result = await runBuild({ tree: TREE, exec, links: linkedTo("Mirabox", "Ulanzi"), log: silentLog() });

    expect(result.ok).toBe(false);
    expect(result.failure).toMatch(/could not stop Ulanzi/);
    expect(result.restartYourself).toEqual(["Ulanzi"]);
    expect(commandLines()).toEqual([
      "node scripts/host-app.mjs stop mirabox",
      "node scripts/host-app.mjs stop ulanzi",
      "node scripts/host-app.mjs start mirabox",
    ]);
  });

  it("names every host whose restart failed for Niklas to restart himself", async () => {
    const exec = fakeExec({
      "pnpm restart:stream-deck": failed(),
      "node scripts/host-app.mjs start mirabox": failed(),
    });

    const result = await runBuild({ tree: TREE, exec, links: linkedTo("Stream Deck", "Mirabox"), log: silentLog() });

    expect(result.ok).toBe(true);
    expect(result.restartYourself).toEqual(["Stream Deck", "Mirabox"]);
  });
});

describe("tsDiagnostics", () => {
  it("returns every line carrying a TS diagnostic code", () => {
    expect(tsDiagnostics("ok\n(!) TS2345: bad\r\nfine\nx.ts: error TS7006: y")).toEqual([
      "(!) TS2345: bad",
      "x.ts: error TS7006: y",
    ]);
  });

  it("ignores text that only mentions TS without a code", () => {
    expect(tsDiagnostics("Building TS sources\nTSX: none\n")).toEqual([]);
  });
});

describe("parseCliArgs", () => {
  it("reads --no-build and the branches in order", () => {
    expect(parseCliArgs(["--no-build", "feature/2-b", "feature/1-a"])).toEqual({
      build: false,
      branches: ["feature/2-b", "feature/1-a"],
    });
  });

  it("builds by default", () => {
    expect(parseCliArgs(["feature/1-a"])).toEqual({ build: true, branches: ["feature/1-a"] });
  });

  it.each([[[]], [["--bogus", "feature/1-a"]], [["--no-build"]]])("rejects %j", (argv) => {
    expect(() => parseCliArgs(argv)).toThrow();
  });
});

describe("main", { timeout: GIT_TIMEOUT_MS }, () => {
  it("exits 0 and prints each merged branch with its full sha", async () => {
    const a = branch("feature/1-a", "a.txt", "a\n");
    const log = silentLog();

    const code = await main(["--no-build", "feature/1-a"], { cwd: repo, exec: recordingExec(), log });

    expect(code).toBe(EXIT_OK);
    expect(output(log)).toContain(`feature/1-a  ${a}`);
  });

  it("exits 1 on a conflict and names the branch and the files", async () => {
    branch("feature/1-x", "shared.txt", "x\n");
    branch("feature/2-y", "shared.txt", "y\n");
    const log = silentLog();

    const code = await main(["--no-build", "feature/1-x", "feature/2-y"], { cwd: repo, exec: recordingExec(), log });

    expect(code).toBe(EXIT_FAILED);
    expect(output(log)).toMatch(/feature\/2-y conflicts with feature\/1-x/);
    expect(output(log)).toContain("shared.txt");
  });

  it("exits 1 on a refusal", async () => {
    const log = silentLog();

    const code = await main(["--no-build", "feature/9-nope"], { cwd: repo, exec: recordingExec(), log });

    expect(code).toBe(EXIT_FAILED);
    expect(output(log)).toMatch(/feature\/9-nope/);
  });

  it("exits 2 with the usage on bad arguments", async () => {
    const log = silentLog();

    const code = await main([], { cwd: repo, exec: recordingExec(), log });

    expect(code).toBe(EXIT_USAGE);
    expect(output(log)).toMatch(/usage:/);
    expect(calls).toEqual([]);
  });

  it("exits 1 when the build fails", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const log = silentLog();

    const code = await main(["feature/1-a"], {
      cwd: repo,
      exec: recordingExec({ "pnpm build": failed("nope") }),
      links: noLinks,
      log,
    });

    expect(code).toBe(EXIT_FAILED);
    expect(output(log)).toMatch(/build failed/i);
  });
});
