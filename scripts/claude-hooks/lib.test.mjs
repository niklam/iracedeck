import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spawnSyncShim } from "../lib/spawn-shim.mjs";
import { readIndexFile, run, SPEC_DIR, specFilenames } from "./lib.mjs";

// `run()` routes between the two spawns. `spawnSync` stays real — the fixture
// repos below reach git through `run()` — except where the `run` tests stub it.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("../lib/spawn-shim.mjs", () => ({ spawnSyncShim: vi.fn() }));

const { spawnSync: realSpawnSync } = await vi.importActual("node:child_process");

let root;
const git = (...args) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, stdio: "pipe" });
const writeSpec = (name, text = "# spec\n") => {
  mkdirSync(join(root, SPEC_DIR), { recursive: true });
  writeFileSync(join(root, SPEC_DIR, name), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ird-hooks-lib-"));
  git("init", "-q", "-b", "master");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// #1193 review: the worktree gate asks "is there a spec for #n on master?",
// and the local working tree answers a different question in both directions.
describe("specFilenames", () => {
  it("lists what origin/master carries, not what the working tree holds", () => {
    writeSpec("2026-01-01-issue-7-on-master.md");
    git("add", "-A");
    git("commit", "-qm", "spec");
    git("update-ref", "refs/remotes/origin/master", "HEAD");
    // A spec pushed to master that this checkout has not pulled is modelled by
    // deleting the file locally; one written here and never committed, by adding one.
    unlinkSync(join(root, SPEC_DIR, "2026-01-01-issue-7-on-master.md"));
    writeSpec("2026-01-02-issue-8-uncommitted.md");
    expect(specFilenames(root)).toEqual(["2026-01-01-issue-7-on-master.md"]);
  });

  it("falls back to the working tree when there is no origin/master to ask", () => {
    writeSpec("2026-01-02-issue-8-local.md");
    expect(specFilenames(root)).toEqual(["2026-01-02-issue-8-local.md"]);
  });

  it("is empty — the side that asks — when neither can answer", () => {
    expect(specFilenames(root)).toEqual([]);
  });
});

// #1193 review (CodeRabbit): a plain commit takes the STAGED bytes.
describe("readIndexFile", () => {
  const rel = `${SPEC_DIR}2026-01-01-issue-7-a.md`;
  it("returns what is staged, not the edit made after staging", () => {
    writeSpec("2026-01-01-issue-7-a.md", "staged\n");
    git("add", "-A");
    writeSpec("2026-01-01-issue-7-a.md", "edited\n");
    expect(readIndexFile(root, rel)).toBe("staged\n");
  });

  it("is undefined — the side that passes — for a path the index does not hold", () => {
    writeSpec("2026-01-01-issue-7-a.md");
    expect(readIndexFile(root, rel)).toBeUndefined();
  });
});

// #1149: `.exe` binaries spawn directly, anything else is a `.cmd` shim and goes
// through the shared helper (no args array beside `shell: true`).
describe("run", () => {
  const done = { status: 0, stdout: "out", stderr: "" };

  beforeEach(() => {
    vi.mocked(spawnSync).mockReset().mockReturnValue(done);
    vi.mocked(spawnSyncShim).mockReset().mockReturnValue(done);
  });

  afterEach(() => {
    vi.mocked(spawnSync).mockReset().mockImplementation(realSpawnSync);
  });

  it.each(["git", "gh", "node"])("spawns %s directly", (cmd) => {
    expect(run(cmd, ["--version"])).toEqual({ ok: true, out: "out", err: "", code: 0 });
    expect(spawnSync).toHaveBeenCalledWith(cmd, ["--version"], expect.objectContaining({ encoding: "utf8" }));
    expect(spawnSyncShim).not.toHaveBeenCalled();
  });

  it("sends a shim through the shared helper", () => {
    expect(run("pnpm", ["generate:action-comms"]).ok).toBe(true);
    expect(spawnSyncShim).toHaveBeenCalledWith("pnpm", ["generate:action-comms"], expect.any(Object));
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("spawns another .exe directly with shim: false", () => {
    run("powershell", ["-NoProfile"], { shim: false });
    expect(spawnSync).toHaveBeenCalledWith("powershell", ["-NoProfile"], expect.any(Object));
    expect(spawnSyncShim).not.toHaveBeenCalled();
  });

  it("returns a failed run, not a throw, for an argument the helper refuses", () => {
    vi.mocked(spawnSyncShim).mockImplementation(() => {
      throw new TypeError("Cannot pass through cmd.exe intact.");
    });
    expect(run("pnpm", ["50%"])).toEqual({
      ok: false,
      out: "",
      err: "Cannot pass through cmd.exe intact.",
      code: null,
    });
  });
});
