import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spawnSyncShim } from "../lib/spawn-shim.mjs";
import { readIndexFile, replayRebase, run, SPEC_DIR, specFilenames } from "./lib.mjs";

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

// #1307: the merge gate's pure-rebase check, in real repositories. Each case
// builds M0, a reviewed branch off it, a moved base M1, and a head on M1.
describe("replayRebase", () => {
  const ID = ["-c", "user.email=t@t", "-c", "user.name=t"];
  const gitIn = (dir, ...args) =>
    execFileSync("git", [...ID, ...args], { cwd: dir, stdio: "pipe" })
      .toString()
      .trim();
  const lines = (edits = {}, n = 10) =>
    Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
  const commit = (files, msg = "c") => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    git("add", "-A");
    git("commit", "-qm", msg);
    return gitIn(root, "rev-parse", "HEAD");
  };
  const replay = (reviewed, head, base) => replayRebase({ reviewed, head, base, dir: root });
  /** M0 → reviewed (line 2 of a.txt, a new c.txt); M0 → M1 (line 9 of a.txt). */
  const arrange = () => {
    const m0 = commit({ "a.txt": lines() }, "m0");
    git("checkout", "-q", "-b", "feature");
    const reviewed = commit({ "a.txt": lines({ 2: "feature" }), "c.txt": "new\n" }, "reviewed");
    git("checkout", "-q", "master");
    const m1 = commit({ "a.txt": lines({ 9: "master moved" }) }, "m1");
    return { m0, reviewed, m1 };
  };
  const rebaseOnto = (base, ...picks) => {
    git("checkout", "-q", "-B", "rebased", base);
    for (const p of picks) git("cherry-pick", "--allow-empty", p);
    return gitIn(root, "rev-parse", "HEAD");
  };

  it("passes a clean rebase onto a moved base", () => {
    const { reviewed, m1 } = arrange();
    expect(replay(reviewed, rebaseOnto(m1, reviewed), m1)).toEqual({
      ok: true,
      differing: [],
      conflicted: [],
      lineMismatch: [],
    });
  });

  it("refuses a head that moves the reviewed line elsewhere — what the withdrawn line test accepted", () => {
    const { reviewed, m1 } = arrange();
    git("checkout", "-q", "-B", "moved", m1);
    const head = commit({ "a.txt": lines({ 7: "feature", 9: "master moved" }), "c.txt": "new\n" });
    expect(replay(reviewed, head, m1)).toMatchObject({ ok: true, differing: ["a.txt"], conflicted: [] });
  });

  it("refuses a changed byte that a textconv driver would hide — trees compare by id", () => {
    commit({ ".gitattributes": "*.pdf diff=same\n", "a.txt": lines() }, "m0");
    git("config", "diff.same.textconv", "echo same");
    git("checkout", "-q", "-b", "feature");
    const reviewed = commit({ "doc.pdf": "bytes A\n" });
    git("checkout", "-q", "master");
    const m1 = commit({ "a.txt": lines({ 9: "x" }) });
    git("checkout", "-q", "-B", "other", m1);
    const head = commit({ "doc.pdf": "bytes B\n" });
    expect(replay(reviewed, head, m1)).toMatchObject({ ok: true, differing: ["doc.pdf"] });
  });

  /** M0 → reviewed inserts X after line 5; M0 → M1 inserts Y there: the rebase conflicts in a.txt. */
  const arrangeConflict = () => {
    commit({ "a.txt": lines() }, "m0");
    git("checkout", "-q", "-b", "feature");
    const reviewed = commit({ "a.txt": lines({ 5: "line 5\nX" }) }, "reviewed");
    git("checkout", "-q", "master");
    const m1 = commit({ "a.txt": lines({ 5: "line 5\nY" }) }, "m1");
    git("checkout", "-q", "-B", "resolved", m1);
    return { reviewed, m1 };
  };

  it("reports a conflicted file whose resolution keeps the reviewed lines, for the gate to ask about", () => {
    const { reviewed, m1 } = arrangeConflict();
    const head = commit({ "a.txt": lines({ 5: "line 5\nY\nX" }) }, "resolved");
    expect(replay(reviewed, head, m1)).toEqual({
      ok: true,
      differing: ["a.txt"],
      conflicted: ["a.txt"],
      lineMismatch: [],
    });
  });

  it("marks a conflicted file whose resolution changed the reviewed lines", () => {
    const { reviewed, m1 } = arrangeConflict();
    const head = commit({ "a.txt": lines({ 5: "line 5\nY\nX2" }) }, "resolved");
    expect(replay(reviewed, head, m1)).toMatchObject({ conflicted: ["a.txt"], lineMismatch: ["a.txt"] });
  });

  it("refuses a follow-up commit on top of the reviewed one before any replay", () => {
    const { reviewed, m1 } = arrange();
    git("checkout", "-q", "feature");
    const head = commit({ "c.txt": "changed\n" }, "follow-up");
    expect(replay(reviewed, head, m1)).toMatchObject({ ok: true, followUp: 1 });
  });

  it("passes the base merged into the branch — an 'Update branch' merge is a rebase by other means", () => {
    const { reviewed, m1 } = arrange();
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-edit", m1);
    expect(replay(reviewed, gitIn(root, "rev-parse", "HEAD"), m1)).toMatchObject({ ok: true, differing: [] });
  });

  it("passes a clean rebase of a multi-commit branch, compared against its tip", () => {
    const { reviewed, m1 } = arrange();
    git("checkout", "-q", "feature");
    const tip = commit({ "d.txt": "second\n" }, "second");
    expect(replay(tip, rebaseOnto(m1, reviewed, tip), m1)).toMatchObject({ ok: true, differing: [] });
  });

  it("is not fooled by a replace ref in the checkout", () => {
    const { reviewed, m1 } = arrange();
    const cleanHead = rebaseOnto(m1, reviewed);
    git("checkout", "-q", "-B", "moved", m1);
    const badHead = commit({ "a.txt": lines({ 7: "feature", 9: "master moved" }), "c.txt": "new\n" });
    git("replace", badHead, cleanHead);
    expect(replay(reviewed, badHead, m1)).toMatchObject({ differing: ["a.txt"] });
  });

  it("fetches a reviewed commit that only origin has", () => {
    const { m1 } = arrange();
    const remote = mkdtempSync(join(tmpdir(), "ird-hooks-origin-"));
    const other = mkdtempSync(join(tmpdir(), "ird-hooks-other-"));
    try {
      gitIn(remote, "init", "-q", "--bare");
      git("remote", "add", "origin", remote);
      git("push", "-q", "origin", "master");
      gitIn(other, "clone", "-q", remote, ".");
      gitIn(other, "checkout", "-q", "-b", "pushed", `${m1}~1`);
      writeFileSync(join(other, "e.txt"), "from elsewhere\n");
      gitIn(other, "add", "-A");
      gitIn(other, "commit", "-qm", "reviewed elsewhere");
      gitIn(other, "push", "-q", "origin", "pushed");
      const reviewed = gitIn(other, "rev-parse", "HEAD");
      expect(() => gitIn(root, "cat-file", "-e", `${reviewed}^{commit}`)).toThrow();
      git("checkout", "-q", "-B", "rebased", m1);
      const head = commit({ "e.txt": "from elsewhere\n" }, "rebased");
      expect(replay(reviewed, head, m1)).toMatchObject({ ok: true, differing: [] });
      expect(() => git("rev-parse", "-q", "--verify", "FETCH_HEAD")).toThrow();
    } finally {
      rmSync(remote, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("fails, never passes, for a commit git cannot find or fetch, a non-sha, or a spent deadline", () => {
    const { reviewed, m1 } = arrange();
    expect(replay("f".repeat(40), reviewed, m1)).toMatchObject({ ok: false });
    expect(replay("HEAD", reviewed, m1)).toMatchObject({ ok: false });
    expect(replayRebase({ reviewed, head: reviewed, base: m1, dir: root, deadlineAt: Date.now() - 1 })).toMatchObject({
      ok: false,
    });
  });
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
