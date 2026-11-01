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
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildIntegration,
  defaultExec,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  IntegrationRefusal,
  integrationTreePath,
  isLockedFileError,
  main,
  parseCliArgs,
  parseMergeTree,
  restartCommands,
  runBuild,
  supportsWriteTree,
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
/** A failed command whose stderr, not its stdout, carries the message. */
const failedWithErr = (err, code = 1) => ({ ok: false, code, out: "", err });

/** The message Windows gives npm when a running host holds a native module the install must replace. */
const LOCKED = "npm error EBUSY: resource busy or locked, rename 'bin/node_modules/@resvg/resvg-js/x.node'";

/**
 * Real git through `defaultExec`, canned answers for everything else, and a
 * record of every call. `answers` maps `"<cmd> <args…>"` to a result, git
 * included; `rewrite(args, result)` may replace what a real git call returned.
 */
function recordingExec(answers = {}, { rewrite } = {}) {
  return async (cmd, args, options) => {
    calls.push({ cmd, args, cwd: options?.cwd, stream: options?.stream ?? false });
    const key = [cmd, ...args].join(" ");
    if (key in answers) return answers[key];
    if (cmd !== "git") return ok();
    const result = await defaultExec(cmd, args, { ...options, stream: false });

    return rewrite ? rewrite(args, result) : result;
  };
}

const commandLines = () => calls.map(({ cmd, args }) => [cmd, ...args].join(" "));
const noLinks = () => [];

/** Every recorded command that stops, starts or restarts a deck host. */
const hostCommands = () =>
  commandLines().filter((line) => /(?:stop|start|restart):stream-deck|host-app\.mjs|streamdeck|taskkill/.test(line));

/** Every ref in the repository with the commit it names. */
const refs = () => git(["for-each-ref", "--format=%(refname) %(objectname)"]);

/** The git commands that would change the integration tree or what its branch names. */
const treeWrites = () =>
  calls.filter(
    ({ cmd, args }) => cmd === "git" && ["reset", "merge", "worktree", "checkout", "switch"].includes(args[0]),
  );

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
  it("finds a conflict on the third branch before the reset, and leaves the tree exactly as it was", async () => {
    // The previous build, which a deck host may be running from.
    branch("feature/0-p", "p.txt", "p\n");
    await buildIntegration({
      repoRoot: repo,
      branches: ["feature/0-p"],
      build: false,
      exec: recordingExec(),
      log: silentLog(),
    });
    const headBefore = git(["rev-parse", "HEAD"], tree);
    const filesBefore = git(["ls-files"], tree);
    calls = [];

    branch("feature/1-a", "a.txt", "a\n");
    branch("feature/2-b", "b.txt", "b\n");
    branch("feature/3-c", "a.txt", "c\n");
    const refsBefore = refs();
    const log = silentLog();

    const result = await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-a", "feature/2-b", "feature/3-c"],
      build: true,
      exec: recordingExec(),
      links: () => {
        throw new Error("links must not be read when nothing is built");
      },
      log,
    });

    expect(result.conflict).toEqual({
      branch: "feature/3-c",
      files: ["a.txt"],
      mergedBefore: ["feature/1-a", "feature/2-b"],
    });
    expect(result.merged).toEqual([]);
    expect(result.treeChanged).toBe(false);
    expect(result.build).toBeUndefined();
    // The tree: the same HEAD, the same files, nothing left over.
    expect(git(["rev-parse", "HEAD"], tree)).toBe(headBefore);
    expect(git(["symbolic-ref", "--short", "HEAD"], tree)).toBe("integration");
    expect(git(["ls-files"], tree)).toBe(filesBefore);
    expect(git(["status", "--porcelain", "--ignored"], tree)).toBe("");
    expect(existsSync(join(tree, "p.txt"))).toBe(true);
    expect(existsSync(join(tree, "a.txt")) || existsSync(join(tree, "b.txt"))).toBe(false);
    // No command that writes the tree ran, and the dry run's commits got no ref.
    expect(treeWrites()).toEqual([]);
    expect(calls.filter(({ cwd }) => cwd === tree).map(({ args }) => args[0])).toEqual([
      "rev-parse",
      "symbolic-ref",
      "status",
    ]);
    expect(refs()).toBe(refsBefore);
    expect(calls.some(({ cmd }) => cmd === "pnpm" || cmd === "node")).toBe(false);
    // The positive control: the dry run did walk the whole chain up to the conflict.
    expect(calls.filter(({ args }) => args[0] === "merge-tree")).toHaveLength(3);
    expect(calls.filter(({ args }) => args[0] === "commit-tree")).toHaveLength(2);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("reports a conflict with origin/master alone as an empty mergedBefore, without creating a missing tree", async () => {
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
    expect(result.treeChanged).toBe(false);
    expect(existsSync(tree)).toBe(false);
    expect(treeWrites()).toEqual([]);
  });

  it("refuses when merge-tree fails for a reason other than a conflict, before the reset", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const exec = recordingExec(
      {},
      { rewrite: (args, result) => (args[0] === "merge-tree" ? failed("", 128) : result) },
    );

    await expect(
      buildIntegration({ repoRoot: repo, branches: ["feature/1-a"], build: false, exec, log: silentLog() }),
    ).rejects.toThrow(IntegrationRefusal);
    expect(treeWrites()).toEqual([]);
  });

  it("falls back to aborting a real merge that conflicts after a clean dry run, leaving nothing half-merged", async () => {
    const x = branch("feature/1-x", "shared.txt", "x\n");
    branch("feature/2-y", "shared.txt", "y\n");
    branch("feature/3-z", "z.txt", "z\n");
    // A dry run that misses the conflict: merge-tree reports its tree as clean.
    const exec = recordingExec(
      {},
      {
        rewrite: (args, result) =>
          args[0] === "merge-tree" && result.code === 1 ? ok(`${result.out.split("\n")[0]}\n`) : result,
      },
    );

    const result = await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-x", "feature/2-y", "feature/3-z"],
      build: true,
      exec,
      links: noLinks,
      log: silentLog(),
    });

    expect(result.merged).toEqual([{ branch: "feature/1-x", sha: x }]);
    expect(result.treeChanged).toBe(true);
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
});

describe("buildIntegration — the git version", { timeout: GIT_TIMEOUT_MS }, () => {
  it.each([["git version 2.37.1\n"], ["not git\n"]])("refuses %j before fetching anything", async (answer) => {
    branch("feature/1-a", "a.txt", "a\n");

    await expect(
      buildIntegration({
        repoRoot: repo,
        branches: ["feature/1-a"],
        build: false,
        exec: recordingExec({ "git --version": ok(answer) }),
        log: silentLog(),
      }),
    ).rejects.toThrow(/git 2\.38 or later is needed for merge-tree --write-tree/);
    expect(commandLines().filter((line) => /^git (fetch|reset|merge|worktree)/.test(line))).toEqual([]);
  });
});

describe("supportsWriteTree", () => {
  it.each([
    ["git version 2.38.0", true],
    ["git version 2.56.0.windows.3\n", true],
    ["git version 2.39.3 (Apple Git-146)", true],
    ["git version 3.0.0", true],
    ["git version 2.37.9", false],
    ["git version 1.99.0", false],
    ["", false],
    [undefined, false],
  ])("%j → %s", (text, expected) => {
    expect(supportsWriteTree(text)).toBe(expected);
  });
});

describe("parseMergeTree", () => {
  const OID = "942e3668bf8ba75801ffaa93801d222b3b5991a0";

  it("reads a clean merge as its tree and no files", () => {
    expect(parseMergeTree(`${OID}\n`)).toEqual({ tree: OID, files: [], messages: "" });
  });

  it("reads the conflicted names up to the blank line, and the messages after it", () => {
    expect(parseMergeTree(`${OID}\nother.txt\nshared.txt\n\nAuto-merging other.txt\nCONFLICT (content): x\n`)).toEqual({
      tree: OID,
      files: ["other.txt", "shared.txt"],
      messages: "Auto-merging other.txt\nCONFLICT (content): x",
    });
  });

  it("is undefined for git's own error text, which also exits 1", () => {
    expect(parseMergeTree("")).toBeUndefined();
    expect(parseMergeTree("merge-tree: nope - not something we can merge\n")).toBeUndefined();
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

  const attemptWith = (branches) =>
    buildIntegration({ repoRoot: repo, branches, build: false, exec: recordingExec(), log: silentLog() });

  it.each([
    ["heads/integration", /Refusing to merge the integration branch itself \(heads\/integration\)/],
    ["refs/heads/integration^{commit}", /on no ref but integration's/],
    ["integration~0", /on no ref but integration's/],
    ["integration^0", /on no ref but integration's/],
  ])("refuses %s, another spelling of the integration branch, before fetching anything", async (name, message) => {
    await seedTree();
    const headBefore = git(["rev-parse", "HEAD"], tree);

    await expect(attemptWith(["feature/1-a", name])).rejects.toThrow(message);
    expectUntouched();
    expect(git(["rev-parse", "HEAD"], tree)).toBe(headBefore);
  });

  it("refuses the current integration head by its sha", async () => {
    await seedTree();
    const head = git(["rev-parse", "HEAD"], tree);

    await expect(attemptWith([head])).rejects.toThrow(/on no ref but integration's/);
    expectUntouched();
  });

  it("refuses an earlier integration head that no ref holds any more", async () => {
    await seedTree();
    const earlier = git(["rev-parse", "HEAD"], tree);
    branch("feature/2-b", "b.txt", "b\n");
    await attemptWith(["feature/2-b"]);
    calls = [];

    await expect(attemptWith([earlier])).rejects.toThrow(/on no ref but integration's/);
    expectUntouched();
  });

  it("accepts a branch whose head the integration branch also holds", async () => {
    // The positive control: feature/1-a is merged into integration and still has its own ref.
    await seedTree();
    const a = git(["rev-parse", "feature/1-a"]);

    const result = await attemptWith(["feature/1-a"]);

    expect(result.merged).toEqual([{ branch: "feature/1-a", sha: a }]);
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

  it("builds under a linked host without touching it, and names it as needing a restart", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const links = () => [{ host: "Stream Deck", link: "l", target: join(tree, "packages", "x.sdPlugin") }];

    const result = await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-a"],
      exec: recordingExec(),
      links,
      log: silentLog(),
    });

    expect(result.build).toMatchObject({ ok: true, linkedHosts: ["Stream Deck"], needsRestart: ["Stream Deck"] });
    expect(calls.filter(({ cmd }) => cmd !== "git").map(({ cmd, args }) => [cmd, ...args].join(" "))).toEqual([
      "pnpm install",
      "pnpm build",
    ]);
    expect(hostCommands()).toEqual([]);
  });

  it("stops and starts the linked host around the build with restart: true", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const links = () => [{ host: "Stream Deck", link: "l", target: join(tree, "packages", "x.sdPlugin") }];

    const result = await buildIntegration({
      repoRoot: repo,
      branches: ["feature/1-a"],
      restart: true,
      exec: recordingExec(),
      links,
      log: silentLog(),
    });

    expect(result.build).toMatchObject({ ok: true, needsRestart: [], restartYourself: [], stoppedHosts: [] });
    expect(calls.filter(({ cmd }) => cmd !== "git").map(({ cmd, args }) => [cmd, ...args].join(" "))).toEqual([
      "node scripts/host-app.mjs stop stream-deck",
      "pnpm install",
      "pnpm build",
      "node scripts/host-app.mjs start stream-deck",
    ]);
  });

  it("refuses restart: true with build: false before running anything", async () => {
    branch("feature/1-a", "a.txt", "a\n");

    await expect(
      buildIntegration({
        repoRoot: repo,
        branches: ["feature/1-a"],
        build: false,
        restart: true,
        exec: recordingExec(),
        links: () => {
          throw new Error("links must not be read on a refused run");
        },
        log: silentLog(),
      }),
    ).rejects.toThrow(/--restart cannot be combined with --no-build/);
    expect(calls).toEqual([]);
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

  describe("by default", () => {
    const elsewhere = () => [
      { host: "Stream Deck", link: "l", target: join("C:", "deck", "master", "packages", "x") },
      { host: "Mirabox", link: "l", target: undefined },
      { host: "Ulanzi", link: "l", target: "(a real directory, not a link)" },
    ];

    it("builds under every linked host without running a host command, and names them for a restart", async () => {
      const log = silentLog();

      const result = await runBuild({
        tree: TREE,
        exec: fakeExec(),
        links: linkedTo("Stream Deck", "Mirabox", "Ulanzi"),
        log,
      });

      expect(result).toEqual({
        ok: true,
        tsErrors: [],
        linkedHosts: ["Stream Deck", "Mirabox", "Ulanzi"],
        needsRestart: ["Stream Deck", "Mirabox", "Ulanzi"],
        restartYourself: [],
        stoppedHosts: [],
      });
      expect(commandLines()).toEqual(["pnpm install", "pnpm build"]);
      expect(hostCommands()).toEqual([]);
      expect(output(log)).toMatch(/Building without touching them/);
    });

    it("builds and names no host when the links point elsewhere", async () => {
      const log = silentLog();

      const result = await runBuild({ tree: TREE, exec: fakeExec(), links: elsewhere, log });

      expect(result).toMatchObject({ ok: true, linkedHosts: [], needsRestart: [] });
      expect(commandLines()).toEqual(["pnpm install", "pnpm build"]);
      expect(output(log)).toMatch(/No deck host links to/);
    });

    it("fails on a TypeScript diagnostic even when the build exits 0, and names no host for a restart", async () => {
      const exec = fakeExec({
        "pnpm build": ok("src/plugin.ts(3,7): error TS2322: Type 'string' is not assignable.\n"),
      });

      const result = await runBuild({ tree: TREE, exec, links: linkedTo("Stream Deck", "Mirabox"), log: silentLog() });

      expect(result.ok).toBe(false);
      expect(result.failure).toMatch(/1 TypeScript diagnostic/);
      expect(result.tsErrors).toEqual(["src/plugin.ts(3,7): error TS2322: Type 'string' is not assignable."]);
      expect(result.needsRestart).toEqual([]);
      expect(result.stoppedHosts).toEqual([]);
      expect(commandLines()).toEqual(["pnpm install", "pnpm build"]);
    });

    it("does not build when the install fails, and touches no host", async () => {
      const result = await runBuild({
        tree: TREE,
        exec: fakeExec({ "pnpm install": failed() }),
        links: linkedTo("Ulanzi"),
        log: silentLog(),
      });

      expect(result).toMatchObject({ ok: false, failure: "pnpm install failed", needsRestart: [], stoppedHosts: [] });
      expect(commandLines()).toEqual(["pnpm install"]);
    });

    it("sets lockedFile when a failed build printed a locked-file error, and for no ordinary failure", async () => {
      const locked = await runBuild({
        tree: TREE,
        exec: fakeExec({ "pnpm build": failedWithErr(LOCKED) }),
        links: linkedTo("Stream Deck"),
        log: silentLog(),
      });
      expect(locked).toMatchObject({ ok: false, failure: "pnpm build exited 1", lockedFile: true, needsRestart: [] });

      const ordinary = await runBuild({
        tree: TREE,
        exec: fakeExec({ "pnpm build": failed("nope") }),
        links: linkedTo("Stream Deck"),
        log: silentLog(),
      });
      expect(ordinary.ok).toBe(false);
      expect(ordinary).not.toHaveProperty("lockedFile");

      const passed = await runBuild({ tree: TREE, exec: fakeExec(), links: linkedTo("Stream Deck"), log: silentLog() });
      expect(passed).not.toHaveProperty("lockedFile");
    });

    it("sets lockedFile when the install, not the build, printed the locked-file error, and then builds nothing", async () => {
      const result = await runBuild({
        tree: TREE,
        exec: fakeExec({ "pnpm install": failedWithErr("EPERM: operation not permitted, unlink 'x.node'") }),
        links: linkedTo("Mirabox"),
        log: silentLog(),
      });

      expect(result).toMatchObject({ ok: false, failure: "pnpm install failed", lockedFile: true });
      expect(commandLines()).toEqual(["pnpm install"]);
    });

    it("reads the locked-file error from stdout as well as stderr", async () => {
      const result = await runBuild({
        tree: TREE,
        exec: fakeExec({ "pnpm build": failed(LOCKED) }),
        links: linkedTo("Ulanzi"),
        log: silentLog(),
      });

      expect(result.lockedFile).toBe(true);
    });

    it("does not set lockedFile when a build that exited 0 failed on a TypeScript diagnostic and also printed EBUSY", async () => {
      const exec = fakeExec({
        "pnpm build": ok(`${LOCKED}\nsrc/plugin.ts(3,7): error TS2322: Type 'string' is not assignable.\n`),
      });

      const result = await runBuild({ tree: TREE, exec, links: linkedTo("Stream Deck"), log: silentLog() });

      expect(result.failure).toMatch(/TypeScript diagnostic/);
      expect(result).not.toHaveProperty("lockedFile");
    });

    it("names a linked host this script has no command for and runs no command for it", async () => {
      const result = await runBuild({
        tree: TREE,
        exec: fakeExec(),
        links: linkedTo("Stream Deck", "Acme Deck"),
        log: silentLog(),
      });

      expect(result).toMatchObject({ ok: true, linkedHosts: ["Stream Deck", "Acme Deck"] });
      expect(result.needsRestart).toEqual(["Stream Deck", "Acme Deck"]);
      expect(commandLines()).toEqual(["pnpm install", "pnpm build"]);
      expect(commandLines().join("\n")).not.toContain("undefined");
    });

    it("never reaches a host command even when every host command would fail", async () => {
      // The positive control for hostCommands(): under --restart these answers fail the run.
      const answers = {
        "node scripts/host-app.mjs stop stream-deck": failed(),
        "node scripts/host-app.mjs stop mirabox": failed(),
      };

      const result = await runBuild({
        tree: TREE,
        exec: fakeExec(answers),
        links: linkedTo("Stream Deck", "Mirabox"),
        log: silentLog(),
      });
      expect(result.ok).toBe(true);
      expect(hostCommands()).toEqual([]);

      calls = [];
      const restarted = await runBuild({
        tree: TREE,
        restart: true,
        exec: fakeExec(answers),
        links: linkedTo("Stream Deck", "Mirabox"),
        log: silentLog(),
      });
      expect(restarted.ok).toBe(false);
      expect(hostCommands()).not.toEqual([]);
    });
  });

  describe("with --restart", () => {
    it("stops Stream Deck before the install and starts it after a good build when it links to the tree", async () => {
      const result = await runBuild({
        tree: TREE,
        restart: true,
        exec: fakeExec(),
        links: linkedTo("Stream Deck"),
        log: silentLog(),
      });

      expect(result).toEqual({
        ok: true,
        tsErrors: [],
        linkedHosts: ["Stream Deck"],
        needsRestart: [],
        restartYourself: [],
        stoppedHosts: [],
      });
      expect(commandLines()).toEqual([
        "node scripts/host-app.mjs stop stream-deck",
        "pnpm install",
        "pnpm build",
        "node scripts/host-app.mjs start stream-deck",
      ]);
      // Its start prints its own result like the other hosts', so it is streamed like theirs; the app it
      // launches is detached with no stdio, so the stream ends with the command (`defaultExec` below).
      expect(calls.filter(({ args }) => args[0] === "scripts/host-app.mjs").every(({ stream }) => stream)).toBe(true);
    });

    it("does not build when Stream Deck cannot be stopped, and starts the hosts it did stop", async () => {
      const exec = fakeExec({ "node scripts/host-app.mjs stop stream-deck": failed() });

      const result = await runBuild({
        tree: TREE,
        restart: true,
        exec,
        links: linkedTo("Mirabox", "Stream Deck"),
        log: silentLog(),
      });

      expect(result.ok).toBe(false);
      expect(result.failure).toMatch(/could not stop Stream Deck/);
      expect(result.restartYourself).toEqual(["Stream Deck"]);
      expect(result.stoppedHosts).toEqual([]);
      expect(commandLines()).toEqual([
        "node scripts/host-app.mjs stop mirabox",
        "node scripts/host-app.mjs stop stream-deck",
        "node scripts/host-app.mjs start mirabox",
      ]);
    });

    it("stops Mirabox and Ulanzi before the install and starts them after the build", async () => {
      const result = await runBuild({
        tree: TREE,
        restart: true,
        exec: fakeExec(),
        links: linkedTo("Mirabox", "Ulanzi"),
        log: silentLog(),
      });

      expect(result.ok).toBe(true);
      expect(result.stoppedHosts).toEqual([]);
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

      const result = await runBuild({ tree: TREE, restart: true, exec: fakeExec(), links, log });

      expect(result.linkedHosts).toEqual([]);
      expect(commandLines()).toEqual(["pnpm install", "pnpm build"]);
      expect(output(log)).toMatch(/No deck host links to/);
    });

    it("fails on a TypeScript diagnostic even when the build exits 0, and restarts no host", async () => {
      const exec = fakeExec({
        "pnpm build": ok(
          "rollup v4\nsrc/plugin.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
        ),
      });

      const result = await runBuild({
        tree: TREE,
        restart: true,
        exec,
        links: linkedTo("Stream Deck", "Mirabox"),
        log: silentLog(),
      });

      expect(result.ok).toBe(false);
      expect(result.tsErrors).toEqual([
        "src/plugin.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      ]);
      expect(result.stoppedHosts).toEqual(["Stream Deck", "Mirabox"]);
      expect(commandLines()).toEqual([
        "node scripts/host-app.mjs stop stream-deck",
        "node scripts/host-app.mjs stop mirabox",
        "pnpm install",
        "pnpm build",
      ]);
    });

    it("fails on a non-zero build and leaves the hosts it stopped stopped, restarting nothing", async () => {
      const exec = fakeExec({ "pnpm build": failed("boom") });

      const result = await runBuild({
        tree: TREE,
        restart: true,
        exec,
        links: linkedTo("Stream Deck", "Mirabox", "Ulanzi"),
        log: silentLog(),
      });

      expect(result.ok).toBe(false);
      expect(result.failure).toMatch(/pnpm build/);
      expect(result.stoppedHosts).toEqual(["Stream Deck", "Mirabox", "Ulanzi"]);
      expect(result.restartYourself).toEqual([]);
      expect(commandLines()).toEqual([
        "node scripts/host-app.mjs stop stream-deck",
        "node scripts/host-app.mjs stop mirabox",
        "node scripts/host-app.mjs stop ulanzi",
        "pnpm install",
        "pnpm build",
      ]);
    });

    it("does not build when the install fails, and leaves the hosts it stopped stopped", async () => {
      const result = await runBuild({
        tree: TREE,
        restart: true,
        exec: fakeExec({ "pnpm install": failed() }),
        links: linkedTo("Mirabox"),
        log: silentLog(),
      });

      expect(result.ok).toBe(false);
      expect(result.failure).toMatch(/pnpm install/);
      expect(result.stoppedHosts).toEqual(["Mirabox"]);
      expect(commandLines()).toEqual(["node scripts/host-app.mjs stop mirabox", "pnpm install"]);
    });

    it("reports no stopped host when the install fails with none linked", async () => {
      const result = await runBuild({
        tree: TREE,
        restart: true,
        exec: fakeExec({ "pnpm install": failed() }),
        links: noLinks,
        log: silentLog(),
      });

      expect(result.ok).toBe(false);
      expect(result.stoppedHosts).toEqual([]);
      expect(commandLines()).toEqual(["pnpm install"]);
    });

    it("does not build under a host it could not stop, and restarts the ones it did", async () => {
      const exec = fakeExec({ "node scripts/host-app.mjs stop ulanzi": failed("Access is denied") });

      const result = await runBuild({
        tree: TREE,
        restart: true,
        exec,
        links: linkedTo("Mirabox", "Ulanzi"),
        log: silentLog(),
      });

      expect(result.ok).toBe(false);
      expect(result.failure).toMatch(/could not stop Ulanzi/);
      expect(result.restartYourself).toEqual(["Ulanzi"]);
      // Nothing was installed or built, so the plugin Mirabox loads is intact.
      expect(result.stoppedHosts).toEqual([]);
      expect(commandLines()).toEqual([
        "node scripts/host-app.mjs stop mirabox",
        "node scripts/host-app.mjs stop ulanzi",
        "node scripts/host-app.mjs start mirabox",
      ]);
    });

    it("names every host whose restart failed for Niklas to restart himself", async () => {
      const exec = fakeExec({
        "node scripts/host-app.mjs start stream-deck": failed(),
        "node scripts/host-app.mjs start mirabox": failed(),
      });

      const result = await runBuild({
        tree: TREE,
        restart: true,
        exec,
        links: linkedTo("Stream Deck", "Mirabox"),
        log: silentLog(),
      });

      expect(result.ok).toBe(true);
      expect(result.restartYourself).toEqual(["Stream Deck", "Mirabox"]);
      expect(result.stoppedHosts).toEqual([]);
      // Starting the app loads the new plugin; the streamdeck CLI's plugin restart is not needed.
      expect(commandLines()).not.toContain("pnpm restart:stream-deck");
    });

    it("leaves a linked host it has no command for running, and names it as needing a restart after a good build", async () => {
      const log = silentLog();

      const result = await runBuild({
        tree: TREE,
        restart: true,
        exec: fakeExec(),
        links: linkedTo("Stream Deck", "Acme Deck"),
        log,
      });

      expect(result).toEqual({
        ok: true,
        tsErrors: [],
        linkedHosts: ["Stream Deck", "Acme Deck"],
        needsRestart: ["Acme Deck"],
        restartYourself: [],
        stoppedHosts: [],
      });
      expect(commandLines()).toEqual([
        "node scripts/host-app.mjs stop stream-deck",
        "pnpm install",
        "pnpm build",
        "node scripts/host-app.mjs start stream-deck",
      ]);
      expect(commandLines().join("\n")).not.toContain("undefined");
      expect(output(log)).toMatch(
        /Stopping Stream Deck around the build \(--restart\)\. This script has no stop command for Acme Deck/,
      );
    });

    it("names no host as needing a restart when the build fails, and carries lockedFile for a host it left running", async () => {
      const result = await runBuild({
        tree: TREE,
        restart: true,
        exec: fakeExec({ "pnpm build": failedWithErr(LOCKED) }),
        links: linkedTo("Stream Deck", "Acme Deck"),
        log: silentLog(),
      });

      expect(result.ok).toBe(false);
      expect(result.needsRestart).toEqual([]);
      expect(result.stoppedHosts).toEqual(["Stream Deck"]);
      // Acme Deck, which this script cannot stop, may be what holds the file.
      expect(result.lockedFile).toBe(true);
      // Positive control: an ordinary failure carries none.
      const ordinary = await runBuild({
        tree: TREE,
        restart: true,
        exec: fakeExec({ "pnpm build": failedWithErr("boom") }),
        links: linkedTo("Stream Deck", "Acme Deck"),
        log: silentLog(),
      });
      expect(ordinary).not.toHaveProperty("lockedFile");
    });
  });
});

describe("defaultExec — a host start that leaves its app running", { timeout: GIT_TIMEOUT_MS }, () => {
  // `host-app.mjs start` leaves the app running behind it. The streamed run that starts it reads
  // the command's output to the end, so the app must not hold that output open: `launchApp` gives
  // it no stdio. Both run `launchApp` itself on a node that lingers: the first with its spawn
  // options untouched, the control with only `stdio` swapped for the output it inherits.
  const LINGER_MS = 4000;
  const HOST_CONTROL = pathToFileURL(join(import.meta.dirname, "lib", "host-control.mjs")).href;
  const lingering = `["-e", "setTimeout(() => {}, ${LINGER_MS})"]`;
  const startsAnApp = (stdio) => [
    "--input-type=module",
    "-e",
    [
      `import { spawn } from "node:child_process";`,
      `const { launchApp } = await import(${JSON.stringify(HOST_CONTROL)});`,
      // launchApp spawns the app with no arguments; this keeps its options and only adds the linger.
      `const linger = (app, _args, options) => spawn(app, ${lingering}, { ...options${stdio ? `, stdio: "${stdio}"` : ""} });`,
      `process.exitCode = await launchApp(process.execPath, { spawn: linger, log: console });`,
    ].join("\n"),
  ];

  it("returns once host-app's start exits, without waiting on the app it launched", async () => {
    const started = Date.now();

    const result = await defaultExec("node", startsAnApp(), { stream: true });

    expect(result).toMatchObject({ ok: true, code: 0 });
    expect(result.out).toContain("Started node");
    expect(Date.now() - started).toBeLessThan(LINGER_MS - 1000);
  });

  it("is what the wait is about: an app handed the command's output keeps a streamed run waiting", async () => {
    // The positive control for the test above: the same launch with the output inherited.
    const started = Date.now();

    await defaultExec("node", startsAnApp("inherit"), { stream: true });

    expect(Date.now() - started).toBeGreaterThanOrEqual(LINGER_MS - 1000);
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
      restart: false,
      branches: ["feature/2-b", "feature/1-a"],
    });
  });

  it("builds without a restart by default", () => {
    expect(parseCliArgs(["feature/1-a"])).toEqual({ build: true, restart: false, branches: ["feature/1-a"] });
  });

  it("reads --restart anywhere on the line", () => {
    const expected = { build: true, restart: true, branches: ["feature/1-a", "feature/2-b"] };
    expect(parseCliArgs(["--restart", "feature/1-a", "feature/2-b"])).toEqual(expected);
    expect(parseCliArgs(["feature/1-a", "feature/2-b", "--restart"])).toEqual(expected);
  });

  it.each([[[]], [["--bogus", "feature/1-a"]], [["--no-build"]], [["--restart"]], [["--restart=yes", "feature/1-a"]]])(
    "rejects %j",
    (argv) => {
      expect(() => parseCliArgs(argv)).toThrow();
    },
  );

  it.each([[["--restart", "--no-build", "feature/1-a"]], [["--no-build", "feature/1-a", "--restart"]]])(
    "rejects %j: there is no build to restart onto",
    (argv) => {
      expect(() => parseCliArgs(argv)).toThrow(/--restart cannot be combined with --no-build/);
    },
  );
});

describe("restartCommands", () => {
  it("names each host's stop and start commands, in that order", () => {
    expect(restartCommands("Stream Deck")).toBe(
      "node scripts/host-app.mjs stop stream-deck then node scripts/host-app.mjs start stream-deck",
    );
    expect(restartCommands("Mirabox")).toBe(
      "node scripts/host-app.mjs stop mirabox then node scripts/host-app.mjs start mirabox",
    );
    expect(restartCommands("Ulanzi")).toBe(
      "node scripts/host-app.mjs stop ulanzi then node scripts/host-app.mjs start ulanzi",
    );
  });

  it("has no command for a host it does not control, rather than a line carrying undefined", () => {
    expect(restartCommands("Acme Deck")).toBeNull();
    expect(restartCommands("mirabox")).toBeNull();
    expect(restartCommands("")).toBeNull();
    expect(restartCommands(undefined)).toBeNull();
    // A name on Object.prototype is no host either.
    expect(restartCommands("constructor")).toBeNull();
  });
});

describe("isLockedFileError", () => {
  it.each([
    ["Node's code", "EBUSY: resource busy or locked, rename 'a.node' -> 'b.node'"],
    ["npm's code line", "npm error code EBUSY"],
    ["EPERM", "EPERM: operation not permitted, unlink 'C:\\x\\a.node'"],
    ["the Windows text alone", "The process cannot access the file: resource busy or locked"],
    ["the permission text alone", "Error: Operation not permitted"],
  ])("recognises %s", (_name, text) => {
    expect(isLockedFileError(text)).toBe(true);
  });

  it.each([
    ["nothing", ""],
    ["a TypeScript diagnostic", "src/a.ts(3,7): error TS2322: Type 'string' is not assignable."],
    ["a missing file", "ENOENT: no such file or directory, open 'x.node'"],
    ["a word that only contains the code", "REBUSYING the workers"],
  ])("does not recognise %s", (_name, text) => {
    expect(isLockedFileError(text)).toBe(false);
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
    expect(output(log)).toMatch(/left as it was, with nothing reset, merged or built/);
    expect(output(log)).not.toMatch(/ is origin\/master/);
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

  it("exits 2 on --restart with --no-build, running nothing", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const log = silentLog();

    const code = await main(["--restart", "--no-build", "feature/1-a"], { cwd: repo, exec: recordingExec(), log });

    expect(code).toBe(EXIT_USAGE);
    expect(output(log)).toMatch(/--restart cannot be combined with --no-build/);
    expect(output(log)).toContain("[--no-build | --restart]");
    expect(calls).toEqual([]);
  });

  it("by default builds under a linked host without touching it, and names it for Niklas to restart", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const log = silentLog();
    const links = () =>
      ["Stream Deck", "Mirabox"].map((host) => ({ host, link: "l", target: join(tree, "packages", "x.sdPlugin") }));

    const code = await main(["feature/1-a"], { cwd: repo, exec: recordingExec(), links, log });

    expect(code).toBe(EXIT_OK);
    expect(hostCommands()).toEqual([]);
    expect(output(log)).toMatch(/Built\./);
    expect(output(log)).toContain(
      `Stream Deck links to ${tree}: restart it to load this build. That is Niklas's go; once he gives it, run node scripts/host-app.mjs stop stream-deck then node scripts/host-app.mjs start stream-deck in ${tree}, or this script again with --restart.`,
    );
    expect(output(log)).toContain(`Mirabox links to ${tree}: restart it to load this build.`);
    expect(output(log)).not.toMatch(/is stopped/);
  });

  it("by default, on a failed build, says the linked hosts keep their old plugin and must not be restarted yet", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const log = silentLog();
    const links = () => [{ host: "Stream Deck", link: "l", target: join(tree, "packages", "x.sdPlugin") }];

    const code = await main(["feature/1-a"], {
      cwd: repo,
      exec: recordingExec({ "pnpm build": failed("nope") }),
      links,
      log,
    });

    expect(code).toBe(EXIT_FAILED);
    expect(hostCommands()).toEqual([]);
    expect(output(log)).toMatch(
      /Stream Deck links to .* keeps running the plugin it loaded: do not restart it until a build passes/,
    );
    expect(output(log)).not.toMatch(/restart it to load this build|is stopped/);
    // An ordinary failure keeps today's advice, with nothing about a lock or a --restart run.
    expect(output(log)).not.toMatch(/locked or busy|Run this script again with --restart/);
  });

  it("by default, on a build that printed a locked-file error, says a --restart run is the way through", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const log = silentLog();
    const links = () =>
      ["Stream Deck", "Acme Deck"].map((host) => ({ host, link: "l", target: join(tree, "packages", "x.sdPlugin") }));

    const code = await main(["feature/1-a"], {
      cwd: repo,
      exec: recordingExec({ "pnpm build": failedWithErr(LOCKED) }),
      links,
      log,
    });

    expect(code).toBe(EXIT_FAILED);
    expect(hostCommands()).toEqual([]);
    expect(output(log)).toContain(
      `Stream Deck links to ${tree} and keeps running the plugin it loaded, and the failure names a locked or busy file (EBUSY / EPERM) that it most likely holds open: no build can pass until it lets go, so a restart is the way through. Run this script again with --restart, which stops it around the build and starts it after. That is Niklas's go.`,
    );
    // --restart cannot stop a host this script has no command for, so that one is told to be stopped by hand.
    expect(output(log)).toContain(
      `Acme Deck links to ${tree} and keeps running the plugin it loaded, and the failure names a locked or busy file (EBUSY / EPERM) that it most likely holds open: no build can pass until it lets go. This script has no command for it, so stop it yourself before the next run. That is Niklas's go.`,
    );
    // "Do not restart it until a build passes" would deadlock: no build passes while the host holds the file.
    expect(output(log)).not.toMatch(/do not restart it until a build passes/);
    expect(output(log)).not.toMatch(/undefined/);
  });

  it("by default, on a locked-file error with no host linked, gives no restart advice", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const log = silentLog();

    const code = await main(["feature/1-a"], {
      cwd: repo,
      exec: recordingExec({ "pnpm install": failedWithErr(LOCKED) }),
      links: noLinks,
      log,
    });

    expect(code).toBe(EXIT_FAILED);
    expect(output(log)).toMatch(/The build failed: pnpm install failed\./);
    expect(output(log)).not.toMatch(/locked or busy|--restart|keeps running/);
  });

  it("by default names a linked host it has no command for without a command line", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const log = silentLog();
    const links = () =>
      ["Stream Deck", "Acme Deck"].map((host) => ({ host, link: "l", target: join(tree, "packages", "x.sdPlugin") }));

    const code = await main(["feature/1-a"], { cwd: repo, exec: recordingExec(), links, log });

    expect(code).toBe(EXIT_OK);
    expect(hostCommands()).toEqual([]);
    expect(output(log)).toContain(
      `Acme Deck links to ${tree}: restart it yourself to load this build (this script has no command for it); that is Niklas's go.`,
    );
    expect(output(log)).toContain(`Stream Deck links to ${tree}: restart it to load this build.`);
    expect(output(log)).toContain(
      "run node scripts/host-app.mjs stop stream-deck then node scripts/host-app.mjs start stream-deck",
    );
    expect(output(log)).not.toMatch(/undefined/);
  });

  it("with --restart, names a linked host it has no command for after a good build, and starts the one it stopped", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const log = silentLog();
    const links = () =>
      ["Mirabox", "Acme Deck"].map((host) => ({ host, link: "l", target: join(tree, "packages", "x.sdPlugin") }));

    const code = await main(["--restart", "feature/1-a"], { cwd: repo, exec: recordingExec(), links, log });

    expect(code).toBe(EXIT_OK);
    expect(commandLines()).toContain("node scripts/host-app.mjs stop mirabox");
    expect(commandLines()).toContain("node scripts/host-app.mjs start mirabox");
    expect(output(log)).toContain(
      `Acme Deck links to ${tree}: restart it yourself to load this build (this script has no command for it); that is Niklas's go.`,
    );
    expect(output(log)).not.toMatch(/Mirabox links to .*restart it|undefined/);
  });

  it("with --restart, on a locked-file failure, tells a linked host it did not stop to be stopped by hand", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const log = silentLog();
    const links = () =>
      ["Mirabox", "Acme Deck"].map((host) => ({ host, link: "l", target: join(tree, "packages", "x.sdPlugin") }));

    const code = await main(["--restart", "feature/1-a"], {
      cwd: repo,
      exec: recordingExec({ "pnpm build": failedWithErr(LOCKED) }),
      links,
      log,
    });

    expect(code).toBe(EXIT_FAILED);
    expect(output(log)).toMatch(/Mirabox is stopped because the build failed/);
    // Acme Deck kept running and may hold the file: "do not restart it" would deadlock.
    expect(output(log)).toContain(
      `Acme Deck links to ${tree} and keeps running the plugin it loaded, and the failure names a locked or busy file (EBUSY / EPERM) that it most likely holds open: no build can pass until it lets go. This script has no command for it, so stop it yourself before the next run. That is Niklas's go.`,
    );
    expect(output(log)).not.toMatch(/do not restart it until a build passes/);
    expect(output(log)).not.toMatch(/Mirabox links to/);
    // Mirabox, which this run stopped, gets no --restart advice: it already had one.
    expect(output(log)).not.toMatch(/Run this script again with --restart/);
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
    expect(output(log)).not.toMatch(/is stopped|previous build/);
  });

  it("with --restart, on a failed build, says every host it stopped, Stream Deck included, stays stopped", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const log = silentLog();
    const links = () =>
      ["Stream Deck", "Mirabox"].map((host) => ({ host, link: "l", target: join(tree, "packages", "x.sdPlugin") }));

    const code = await main(["--restart", "feature/1-a"], {
      cwd: repo,
      exec: recordingExec({ "pnpm build": failed("nope") }),
      links,
      log,
    });

    expect(code).toBe(EXIT_FAILED);
    expect(output(log)).toMatch(/Mirabox is stopped because the build failed, and needs starting once it is fixed/);
    expect(output(log)).toContain("node scripts/host-app.mjs start mirabox");
    expect(output(log)).toMatch(/Stream Deck is stopped because the build failed, and needs starting once it is fixed/);
    expect(output(log)).toContain("node scripts/host-app.mjs start stream-deck");
    expect(output(log)).not.toMatch(/previous build/);
    expect(commandLines()).toContain("node scripts/host-app.mjs stop stream-deck");
    expect(commandLines().filter((line) => /\bstart\b|restart/.test(line))).toEqual([]);
  });

  it("with --restart, on a good build, starts the hosts it stopped again and names none as stopped or to restart", async () => {
    branch("feature/1-a", "a.txt", "a\n");
    const log = silentLog();
    const links = () => [{ host: "Mirabox", link: "l", target: join(tree, "packages", "x.sdPlugin") }];

    const code = await main(["--restart", "feature/1-a"], { cwd: repo, exec: recordingExec(), links, log });

    expect(code).toBe(EXIT_OK);
    expect(commandLines()).toContain("node scripts/host-app.mjs start mirabox");
    expect(output(log)).not.toMatch(/is stopped|restart it to load this build/);
    expect(output(log)).toMatch(/Built\./);
  });
});
