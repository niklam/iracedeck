/**
 * The typecheck guard's probe lock (#1394). Real files in a temp directory and
 * real processes for the holders, because the lock's whole job is judging what
 * is on disk and whether a pid is running — a mocked `fs` or `kill` would assert
 * the code's own assumptions back at itself. Poll and deadline values are small
 * so the waiting cases stay fast.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireProbeLock, isProcessAlive } from "./probe-lock.mjs";

let root;
let lockPath;
let logged;
let children;

const log = (message) => logged.push(message);
const fast = { pollMs: 10, deadlineMs: 2_000, log };

/** The pid of a process that has already exited: spawned, run to completion, gone. */
function deadPid() {
  const result = spawnSync(process.execPath, ["-e", ""]);
  expect(result.status).toBe(0);
  expect(isProcessAlive(result.pid)).toBe(false);
  return result.pid;
}

/** A child that keeps running until the test kills it (afterEach kills any left). */
function liveChild() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

function writeHolder(pid, startedAt = new Date().toISOString()) {
  writeFileSync(lockPath, JSON.stringify({ pid, startedAt }));
}

/** Everything in the lock's directory: a take-over must leave no `.stale` aside behind. */
function lockDirEntries() {
  return readdirSync(path.dirname(lockPath));
}

function holderPid() {
  return JSON.parse(readFileSync(lockPath, "utf-8")).pid;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "iracedeck-probe-lock-"));
  lockPath = path.join(root, "nested", "cache", "probe.lock");
  logged = [];
  children = [];
});

afterEach(() => {
  for (const child of children) child.kill();
  rmSync(root, { recursive: true, force: true });
});

describe("isProcessAlive", () => {
  it("is true for this process and a running child, false for one that has exited", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(liveChild().pid)).toBe(true);
    expect(isProcessAlive(deadPid())).toBe(false);
  });
});

describe("acquireProbeLock", () => {
  it("creates the lock, and its parent directories, naming this process", async () => {
    const release = await acquireProbeLock(lockPath, fast);

    const content = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(content.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(content.startedAt))).toBe(false);
    expect(logged).toEqual([]);

    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases only a lock that still names this process", async () => {
    const release = await acquireProbeLock(lockPath, fast);
    // Someone took it over in the meantime: their lock must survive our release.
    writeHolder(4242);

    release();
    expect(existsSync(lockPath)).toBe(true);
    expect(holderPid()).toBe(4242);
  });

  it("tolerates a release after the lock is already gone", async () => {
    const release = await acquireProbeLock(lockPath, fast);
    rmSync(lockPath);
    expect(() => release()).not.toThrow();
  });

  it("logs rather than throws when the lock cannot be read on release", async () => {
    const release = await acquireProbeLock(lockPath, fast);
    // A directory where the lock was: reading it fails with something other than
    // ENOENT, as an AV scanner's EBUSY would on Windows.
    rmSync(lockPath);
    mkdirSync(lockPath);

    expect(() => release()).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/could not release the lock at .*the next run takes it over/);
  });

  it("takes over a lock whose holder has exited, and says so", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    const dead = deadPid();
    writeHolder(dead);

    const release = await acquireProbeLock(lockPath, fast);
    expect(holderPid()).toBe(process.pid);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`pid ${dead}`);
    expect(logged[0]).toContain(lockPath);
    expect(lockDirEntries()).toEqual(["probe.lock"]);
    release();
  });

  it("takes over a lock held longer than any run can, even when its pid is alive (pid reuse)", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeHolder(4242, new Date(Date.now() - 10 * 60_000).toISOString());

    const release = await acquireProbeLock(lockPath, { ...fast, isAlive: () => true, maxHoldMs: 1_000 });
    expect(holderPid()).toBe(process.pid);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/pid 4242 has held it for 600s, longer than any run can/);
    expect(lockDirEntries()).toEqual(["probe.lock"]);
    release();
  });

  it("waits on a live holder within maxHoldMs rather than taking its lock over", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeHolder(4242);
    setTimeout(() => rmSync(lockPath, { force: true }), 100);

    const release = await acquireProbeLock(lockPath, {
      ...fast,
      isAlive: () => true,
      maxHoldMs: 60_000,
      deadlineMs: 60_000,
    });
    expect(holderPid()).toBe(process.pid);
    expect(logged).toEqual([]);
    release();
  });

  it("leaves a holder whose startedAt is unreadable to liveness, however small maxHoldMs is", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeHolder(4242, "not a date");

    await expect(
      acquireProbeLock(lockPath, { ...fast, deadlineMs: 50, isAlive: () => true, maxHoldMs: 1 }),
    ).rejects.toThrow(/pid 4242/);
    expect(holderPid()).toBe(4242);
    expect(logged).toEqual([]);
  });

  it("refuses at call time a deadline shorter than maxHoldMs, which could never outlast a reused pid", () => {
    expect(() => acquireProbeLock(lockPath, { ...fast, deadlineMs: 1_000, maxHoldMs: 2_000 })).toThrow(TypeError);
    expect(() => acquireProbeLock(lockPath, { ...fast, deadlineMs: 1_000, maxHoldMs: 2_000 })).toThrow(
      /deadlineMs \(1000\) is shorter than maxHoldMs \(2000\)/,
    );
    // Refused before touching the disk.
    expect(existsSync(path.dirname(lockPath))).toBe(false);
  });

  it("puts back a fresh lock that replaced the stale one between the judgement and the take-over", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeHolder(deadPid());
    const rival = liveChild();
    let raced = false;
    // A competing waiter took the stale lock over and created its own first.
    const _beforeTakeOver = () => {
      if (raced) return;
      raced = true;
      rmSync(lockPath);
      writeHolder(rival.pid);
    };

    await expect(acquireProbeLock(lockPath, { ...fast, deadlineMs: 100, _beforeTakeOver })).rejects.toThrow(
      new RegExp(`pid ${rival.pid}`),
    );
    expect(raced).toBe(true);
    expect(holderPid()).toBe(rival.pid);
    expect(lockDirEntries()).toEqual(["probe.lock"]);
    expect(logged).toEqual([]);
  });

  it("judges again, and takes nothing over, when the stale lock vanished before the take-over", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeHolder(deadPid());
    let raced = false;
    const _beforeTakeOver = () => {
      if (raced) return;
      raced = true;
      rmSync(lockPath);
    };

    const release = await acquireProbeLock(lockPath, { ...fast, _beforeTakeOver });
    expect(raced).toBe(true);
    expect(holderPid()).toBe(process.pid);
    expect(lockDirEntries()).toEqual(["probe.lock"]);
    expect(logged).toEqual([]);
    release();
  });

  it("takes over a lock naming this process, which an abandoned run here left behind", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeHolder(process.pid);

    const release = await acquireProbeLock(lockPath, fast);
    expect(holderPid()).toBe(process.pid);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("names this process");
    release();
  });

  it("waits for a live holder and acquires once its lock is gone, without a warning", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    const holder = liveChild();
    writeHolder(holder.pid);
    const started = Date.now();
    setTimeout(() => rmSync(lockPath, { force: true }), 150);

    const release = await acquireProbeLock(lockPath, fast);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(holderPid()).toBe(process.pid);
    expect(logged).toEqual([]);
    release();
  });

  it("gives up at the deadline, naming the holder's pid and the lock", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeHolder(4242);

    await expect(acquireProbeLock(lockPath, { ...fast, deadlineMs: 50, isAlive: () => true })).rejects.toThrow(
      /pid 4242[\s\S]*delete the lock file/,
    );
    await expect(acquireProbeLock(lockPath, { ...fast, deadlineMs: 50, isAlive: () => true })).rejects.toThrow(
      lockPath,
    );
    // Waiting never takes a live holder's lock away.
    expect(holderPid()).toBe(4242);
    expect(logged).toEqual([]);
  });

  // Creation links a fully written file into place, so this lock is never seen
  // empty — except under the fallback create on a filesystem without hard links,
  // which writes after it creates. Hence a fresh empty lock is still waited on.
  it("waits on a fresh empty lock, which the fallback create leaves between its create and its write", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeFileSync(lockPath, "");

    await expect(acquireProbeLock(lockPath, { ...fast, deadlineMs: 100, staleEmptyMs: 60_000 })).rejects.toThrow(
      /not yet old enough to call corrupt/,
    );
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe("");

    setTimeout(() => rmSync(lockPath, { force: true }), 100);
    const release = await acquireProbeLock(lockPath, { ...fast, staleEmptyMs: 60_000 });
    expect(holderPid()).toBe(process.pid);
    expect(logged).toEqual([]);
    release();
  });

  it.each([
    ["empty", ""],
    ["not JSON", "{not json"],
    ["JSON without a pid", JSON.stringify({ startedAt: "x" })],
  ])("takes over an old lock whose content is %s, and says so", async (_label, content) => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeFileSync(lockPath, content);
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, oneMinuteAgo, oneMinuteAgo);

    const release = await acquireProbeLock(lockPath, { ...fast, staleEmptyMs: 5_000 });
    expect(holderPid()).toBe(process.pid);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("unreadable");
    release();
  });
});

/** An error shaped like the one `node:fs` throws, with a `code`. */
const fsError = (code) => Object.assign(new Error(`${code}: injected`), { code });

/** Fail the first `times` calls whose first argument matches, then behave normally. */
function failing(real, matches, code, times = 1) {
  let left = times;
  return (target, ...rest) => {
    if (left > 0 && matches(String(target))) {
      left -= 1;
      throw fsError(code);
    }
    return real(target, ...rest);
  };
}

/** A competing waiter that swaps in a live rival's lock once, between judgement and take-over. */
function swapInRival(rivalPid) {
  let raced = false;
  return () => {
    if (raced) return;
    raced = true;
    rmSync(lockPath);
    writeHolder(rivalPid);
  };
}

describe("acquireProbeLock on a filesystem that misbehaves", () => {
  it("never shows the lock without its content: it is linked into place already written", async () => {
    const seenAtCreate = [];
    const linkSync = (from, to) => {
      fs.linkSync(from, to);
      if (to === lockPath) seenAtCreate.push(readFileSync(lockPath, "utf-8"));
    };

    const release = await acquireProbeLock(lockPath, { ...fast, _fs: { linkSync } });
    expect(seenAtCreate).toHaveLength(1);
    expect(JSON.parse(seenAtCreate[0]).pid).toBe(process.pid);
    expect(lockDirEntries()).toEqual(["probe.lock"]);
    release();
  });

  it("falls back to an exclusive create where hard links are not supported", async () => {
    const linkSync = (from, to) => {
      if (String(from).endsWith(".tmp")) throw fsError("EPERM");
      return fs.linkSync(from, to);
    };

    const release = await acquireProbeLock(lockPath, { ...fast, _fs: { linkSync } });
    expect(holderPid()).toBe(process.pid);
    expect(lockDirEntries()).toEqual(["probe.lock"]);
    release();
    expect(lockDirEntries()).toEqual([]);
  });

  it("waits and retries when writing the new lock is transiently busy", async () => {
    const writeFileSync = failing(fs.writeFileSync, (p) => p.endsWith(".tmp"), "EBUSY");

    const release = await acquireProbeLock(lockPath, { ...fast, _fs: { writeFileSync } });
    expect(holderPid()).toBe(process.pid);
    expect(lockDirEntries()).toEqual(["probe.lock"]);
    expect(logged).toEqual([]);
    release();
  });

  it("waits and retries when reading the existing lock is transiently busy", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeHolder(deadPid());
    const readFileSync = failing(fs.readFileSync, (p) => p === lockPath, "EBUSY");

    const release = await acquireProbeLock(lockPath, { ...fast, _fs: { readFileSync } });
    expect(holderPid()).toBe(process.pid);
    expect(logged).toHaveLength(1);
    expect(lockDirEntries()).toEqual(["probe.lock"]);
    release();
  });

  it("names a lock that stayed busy when the deadline passes", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeHolder(4242);
    const readFileSync = failing(fs.readFileSync, (p) => p === lockPath, "EBUSY", Number.POSITIVE_INFINITY);

    await expect(acquireProbeLock(lockPath, { ...fast, deadlineMs: 50, _fs: { readFileSync } })).rejects.toThrow(
      /stayed busy/,
    );
    expect(holderPid()).toBe(4242);
  });

  it("puts a stale lock back, not away, when reading it after the move fails, then takes it over", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeHolder(deadPid());
    const readFileSync = failing(fs.readFileSync, (p) => p.endsWith(".stale"), "EBUSY");

    const release = await acquireProbeLock(lockPath, { ...fast, _fs: { readFileSync } });
    expect(holderPid()).toBe(process.pid);
    expect(logged).toHaveLength(1);
    expect(lockDirEntries()).toEqual(["probe.lock"]);
    release();
  });

  it("never deletes a live lock it moved by mistake when linking it back fails", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeHolder(deadPid());
    const rival = liveChild();
    // The link-back always fails transiently: the rename back is what restores it.
    const linkSync = (from, to) => {
      if (String(from).endsWith(".stale")) throw fsError("EBUSY");
      return fs.linkSync(from, to);
    };

    await expect(
      acquireProbeLock(lockPath, {
        ...fast,
        deadlineMs: 100,
        _beforeTakeOver: swapInRival(rival.pid),
        _fs: { linkSync },
      }),
    ).rejects.toThrow(new RegExp(`pid ${rival.pid}`));
    expect(holderPid()).toBe(rival.pid);
    expect(lockDirEntries()).toEqual(["probe.lock"]);
    expect(logged).toEqual([]);
  });

  it("leaves a moved lock on disk, and fails, when it can neither link nor rename it back", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeHolder(deadPid());
    const rival = liveChild();
    // A third run creates a lock, then the link-back fails for good.
    const linkSync = (from, to) => {
      if (String(from).endsWith(".stale")) {
        writeHolder(4243);
        throw fsError("ENOTSUP");
      }
      return fs.linkSync(from, to);
    };

    await expect(
      acquireProbeLock(lockPath, { ...fast, _beforeTakeOver: swapInRival(rival.pid), _fs: { linkSync } }),
    ).rejects.toThrow(/ENOTSUP/);
    expect(holderPid()).toBe(4243);
    const asides = lockDirEntries().filter((name) => name.endsWith(".stale"));
    expect(asides).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(path.dirname(lockPath), asides[0]), "utf-8")).pid).toBe(rival.pid);
  });
});
