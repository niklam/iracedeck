/**
 * The typecheck guard's probe lock (#1394). Real files in a temp directory and
 * real processes for the holders, because the lock's whole job is judging what
 * is on disk and whether a pid is running — a mocked `fs` or `kill` would assert
 * the code's own assumptions back at itself. Poll and deadline values are small
 * so the waiting cases stay fast.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

function writeHolder(pid) {
  writeFileSync(lockPath, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
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

  it("takes over a lock whose holder has exited, and says so", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    const dead = deadPid();
    writeHolder(dead);

    const release = await acquireProbeLock(lockPath, fast);
    expect(holderPid()).toBe(process.pid);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`pid ${dead}`);
    expect(logged[0]).toContain(lockPath);
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

  it("waits on a fresh empty lock, which is a writer between its create and its write", async () => {
    await acquireProbeLock(lockPath, fast).then((release) => release());
    writeFileSync(lockPath, "");

    await expect(acquireProbeLock(lockPath, { ...fast, deadlineMs: 100, staleEmptyMs: 60_000 })).rejects.toThrow(
      /never finished writing it/,
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
