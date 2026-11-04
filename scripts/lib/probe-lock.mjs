/**
 * A per-checkout lock around the typecheck guard's probe (#1394).
 *
 * `scripts/typecheck-script-coverage.test.mjs` proves the website's typecheck by
 * effect: a clean `astro check`, then one with a file that cannot compile planted
 * beside the website's tests. Two runs of the guard in one checkout (watch mode
 * beside a one-off `pnpm test`, or two sessions in one worktree) would break each
 * other both ways: the second run's CLEAN check typechecks the whole directory, so
 * the first run's live probe turns it red, and each run deletes the probe the
 * other is still measuring. A per-run filename would fix neither — the clean run
 * sees any probe, whatever it is called, and an orphan from a killed run could no
 * longer be told from a live one. So the guard holds this lock across BOTH runs:
 * while it is held, any probe on disk has no live owner and is safe to delete.
 *
 * The lock is a file holding `{ pid, startedAt }`. It is created atomically WITH
 * its content: written to a temp file beside it, then hard-linked into place,
 * which fails if the lock exists. So a lock never exists empty — except on a
 * filesystem without hard links, where creation falls back to an exclusive
 * create followed by a write. A lock that is already there is judged by its
 * content:
 *
 * - this process's own pid (a run in this process that was abandoned without
 *   releasing, which watch mode can leave behind) — stale: take it over with a
 *   warning;
 * - a `startedAt` older than `maxHoldMs` — stale whatever the pid says, since no
 *   run holds it that long. This is the cure for pid reuse: Windows hands a dead
 *   worker's pid to an unrelated process quickly, and liveness alone would never
 *   let that lock go. It works only if a waiter outlasts it, so a finite
 *   `maxHoldMs` with a shorter `deadlineMs` is refused at call time. A
 *   `startedAt` that does not parse is an unknown age, and liveness decides;
 * - a dead holder — stale: take it over with a warning;
 * - a live holder — wait, polling, until it is gone or the deadline passes, then
 *   throw naming the holder;
 * - empty or unreadable content — corrupt if it is older than `staleEmptyMs`, so
 *   taken over with a warning; if fresh, waited on, since under the fallback
 *   create it may be a writer between its create and its write.
 *
 * A take-over is a rename, never a delete of the shared path: the lock is moved
 * aside to a name only this process uses, and only then compared with what was
 * judged stale. Two waiters judging the same stale lock therefore cannot both
 * act on it — the second rename finds nothing, or moves the first waiter's fresh
 * lock, sees it differs and links it back. The moved file is deleted only once
 * it is known to be the stale one or to be back in place; on any other failure
 * it is renamed back if the path is free, and otherwise left on disk.
 *
 * Errors Windows raises transiently on a file another process has open (an AV
 * scanner: EBUSY, EPERM, EACCES) make a step "busy": the run waits and tries
 * again, within its deadline, rather than failing.
 *
 * Known limits, stated: putting a moved fresh lock back is exclusive, so if a
 * third run created a lock in the instant between the move and the link-back, the
 * moved one is left aside and two runs hold the lock at once — a three-way race
 * inside a single rename. And a `startedAt` that does not parse leaves pid reuse
 * to the deadline, which then fails naming the lock to delete.
 */
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Whether a process with this pid exists. `kill(pid, 0)` sends nothing and only
 * checks; `EPERM` means the process exists but belongs to someone else, which is
 * still a live holder.
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Errors Windows raises transiently on a file another process (an AV scanner) has open. */
const TRANSIENT = new Set(["EBUSY", "EPERM", "EACCES"]);

/** `linkSync` failures meaning this filesystem cannot hard-link at all. */
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EXDEV", "ENOSYS"]);

/** A step that hit a transient error: wait, then try again. */
const BUSY = Symbol("busy");

const uniqueBeside = (lockPath, ownPid, suffix) => `${lockPath}.${ownPid}.${randomBytes(6).toString("hex")}.${suffix}`;

/** Delete a file of our own, ignoring failure: a leftover with a unique name is inert. */
function removeQuietly(fs, path) {
  try {
    fs.rmSync(path, { force: true });
  } catch {
    // An AV scanner holding it; nothing reads these names.
  }
}

/** The lock's content, `null` when it is gone, or `BUSY` on a transient error. */
function readLock(fs, lockPath) {
  try {
    return { raw: fs.readFileSync(lockPath, "utf-8"), mtimeMs: fs.statSync(lockPath).mtimeMs };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (TRANSIENT.has(error.code)) return BUSY;
    throw error;
  }
}

/** `{ pid, startedAt }` when the content is a well-formed lock, otherwise `null`. */
function parseHolder(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    }
  } catch {
    // Unparseable: the caller decides between "being written" and "corrupt".
  }
  return null;
}

/**
 * Create the lock with its content in one step: `"created"`, `"exists"`, or
 * `BUSY`. The content goes into a temp file first and is hard-linked into place,
 * so no reader can ever see the lock without it.
 */
function tryCreate(fs, lockPath, content, ownPid) {
  const temp = uniqueBeside(lockPath, ownPid, "tmp");
  try {
    fs.writeFileSync(temp, content, { flag: "wx" });
  } catch (error) {
    removeQuietly(fs, temp);
    if (TRANSIENT.has(error.code)) return BUSY;
    throw error;
  }
  try {
    fs.linkSync(temp, lockPath);
    return "created";
  } catch (error) {
    if (error.code === "EEXIST") return "exists";
    // A filesystem without hard links (or one that answers EPERM for them, as
    // FAT does on Windows): fall back to an exclusive create and a write, which
    // leaves a moment in which the lock exists empty — the reason a fresh empty
    // lock is still waited on rather than taken over.
    if (LINK_UNSUPPORTED.has(error.code)) return tryCreateInPlace(fs, lockPath, content);
    if (TRANSIENT.has(error.code)) return BUSY;
    throw error;
  } finally {
    removeQuietly(fs, temp);
  }
}

function tryCreateInPlace(fs, lockPath, content) {
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") return "exists";
    if (TRANSIENT.has(error.code)) return BUSY;
    throw error;
  }
  try {
    fs.writeSync(fd, content);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  return "created";
}

/**
 * Take over a lock judged stale with content `judgedRaw`, atomically: move it
 * aside, then check that what moved is what was judged. Returns `"taken"` when
 * the stale lock is gone, `"lost"` when someone else got there first (nothing
 * was there to move, or what moved was a fresh lock, now put back), and `BUSY`
 * when a step hit a transient error and the lock should be judged again later.
 *
 * The moved file is deleted only when it is the stale one or is back in place:
 * it may be another run's live lock, and deleting that would let two runs probe
 * at once.
 */
function takeOver(fs, lockPath, judgedRaw, ownPid) {
  const aside = uniqueBeside(lockPath, ownPid, "stale");
  try {
    fs.renameSync(lockPath, aside);
  } catch (error) {
    if (error.code === "ENOENT") return "lost";
    if (TRANSIENT.has(error.code)) return BUSY;
    throw error;
  }

  // Anything going wrong from here: put the moved file back if the path is
  // free, never delete it. Restored or transient, judge again after a wait.
  const recover = (error) => {
    let restored = false;
    if (!fs.existsSync(lockPath)) {
      try {
        fs.renameSync(aside, lockPath);
        restored = true;
      } catch {
        // Best effort: the aside stays on disk, which is the safe failure.
      }
    }
    if (restored || TRANSIENT.has(error.code)) return BUSY;
    throw error;
  };

  let movedRaw;
  try {
    movedRaw = fs.readFileSync(aside, "utf-8");
  } catch (error) {
    return recover(error);
  }
  if (movedRaw === judgedRaw) {
    removeQuietly(fs, aside);
    return "taken";
  }

  // A fresh lock replaced the stale one between the judgement and the move.
  // Put it back — exclusively, because if the path is taken again someone holds
  // the lock now, and theirs must not be overwritten.
  try {
    fs.linkSync(aside, lockPath);
  } catch (error) {
    if (error.code !== "EEXIST") return recover(error);
  }
  removeQuietly(fs, aside);
  return "lost";
}

/**
 * Acquire the lock at `lockPath`, waiting for a live holder up to `deadlineMs`.
 * Resolves to `release()`, which removes the lock only while it still names this
 * process, so a release after a take-over never deletes the new holder's lock.
 *
 * Throws a `TypeError` at once, before touching the disk, when a finite
 * `maxHoldMs` exceeds `deadlineMs`: such a waiter would give up on a reused pid
 * before it could ever judge that lock stale.
 *
 * `_beforeTakeOver` and `_fs` are test seams: the first runs between judging a
 * lock stale and moving it aside, which is where a competing waiter would act;
 * the second overrides individual `node:fs` functions to inject failures.
 *
 * @param {string} lockPath
 * @param {{
 *   isAlive?: (pid: number) => boolean,
 *   now?: () => number,
 *   pollMs?: number,
 *   deadlineMs?: number,
 *   staleEmptyMs?: number,
 *   maxHoldMs?: number,
 *   log?: (message: string) => void,
 *   _beforeTakeOver?: () => void,
 *   _fs?: Partial<typeof import("node:fs")>,
 * }} [options]
 * @returns {Promise<() => void>}
 */
export function acquireProbeLock(lockPath, options = {}) {
  const { deadlineMs = 300_000, maxHoldMs = Number.POSITIVE_INFINITY } = options;
  if (Number.isFinite(maxHoldMs) && deadlineMs < maxHoldMs) {
    throw new TypeError(
      `acquireProbeLock: deadlineMs (${deadlineMs}) is shorter than maxHoldMs (${maxHoldMs}), so a waiter ` +
        `would give up on a holder before it could judge that holder stale. Wait at least maxHoldMs.`,
    );
  }
  return acquire(lockPath, { ...options, deadlineMs, maxHoldMs });
}

async function acquire(lockPath, options) {
  const {
    isAlive = isProcessAlive,
    now = Date.now,
    pollMs = 500,
    deadlineMs,
    staleEmptyMs = 5_000,
    maxHoldMs,
    log = (message) => console.warn(message),
    _beforeTakeOver,
    _fs,
  } = options;
  const fs = { ...nodeFs, ..._fs };
  const ownPid = process.pid;
  const deadline = now() + deadlineMs;

  fs.mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    const content = JSON.stringify({ pid: ownPid, startedAt: new Date(now()).toISOString() });
    const created = tryCreate(fs, lockPath, content, ownPid);
    if (created === "created") return () => release(fs, lockPath, ownPid, log);

    let holder = null;
    let busy = created === BUSY;
    if (!busy) {
      const seen = readLock(fs, lockPath);
      if (seen === null) continue; // released between our create and our read: try again
      if (seen === BUSY) {
        busy = true;
      } else {
        holder = parseHolder(seen.raw);
        const staleBecause = judgeStale(seen, holder, { ownPid, now, staleEmptyMs, maxHoldMs, isAlive });
        if (staleBecause !== undefined) {
          _beforeTakeOver?.();
          const outcome = takeOver(fs, lockPath, seen.raw, ownPid);
          if (outcome === "taken") {
            log(`[probe-lock] took over a stale lock at ${lockPath}: ${staleBecause}.`);
            continue;
          }
          if (outcome === "lost") continue; // judge whatever is there now
          busy = true;
        }
      }
    }

    if (now() >= deadline) {
      const who = busy
        ? "a lock this run could not read or replace (the file stayed busy)"
        : holder === null
          ? "an empty or unreadable lock not yet old enough to call corrupt"
          : `pid ${holder.pid}${holder.startedAt ? ` (since ${holder.startedAt})` : ""}`;
      throw new Error(
        `Timed out after ${Math.round(deadlineMs / 1000)}s waiting for the lock at ${lockPath}, held by ${who}. ` +
          `Another run of the typecheck guard in this checkout is still probing. If no such run exists, ` +
          `delete the lock file and run again.`,
      );
    }
    await sleep(pollMs);
  }
}

/** Why the lock `seen` is stale, or `undefined` when it must be waited on. */
function judgeStale(seen, holder, { ownPid, now, staleEmptyMs, maxHoldMs, isAlive }) {
  if (holder === null) {
    const ageMs = now() - seen.mtimeMs;
    return ageMs >= staleEmptyMs
      ? `its content is unreadable and ${Math.round(ageMs / 1000)}s old, so it is corrupt`
      : undefined;
  }
  if (holder.pid === ownPid) {
    return `it names this process (pid ${ownPid}), so an earlier run here never released it`;
  }
  // NaN for a missing or malformed `startedAt`: an unknown age, never "old".
  const heldMs = now() - Date.parse(holder.startedAt);
  if (heldMs > maxHoldMs) {
    return (
      `pid ${holder.pid} has held it for ${Math.round(heldMs / 1000)}s, longer than any run can, ` +
      `so that pid now belongs to some other process`
    );
  }
  return isAlive(holder.pid) ? undefined : `its holder, pid ${holder.pid}, is no longer running`;
}

/**
 * Never throws: it runs in the guard's `finally`, where a throw would replace the
 * assertion that actually failed. A lock left behind by a failed release names
 * this process, so the next run takes it over as stale.
 */
function release(fs, lockPath, ownPid, log) {
  try {
    const seen = readLock(fs, lockPath);
    if (seen === null) return;
    if (seen === BUSY) throw Object.assign(new Error("the lock file is busy"), { code: "EBUSY" });
    if (parseHolder(seen.raw)?.pid === ownPid) fs.rmSync(lockPath, { force: true });
  } catch (error) {
    log(
      `[probe-lock] could not release the lock at ${lockPath} (${error.code ?? error.message}); ` +
        `the next run takes it over.`,
    );
  }
}
