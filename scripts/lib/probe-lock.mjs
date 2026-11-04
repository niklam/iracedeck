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
 * The lock is a file created with `wx` (exclusive create, atomic on every
 * filesystem this repo runs on) holding `{ pid, startedAt }`. A lock that is
 * already there is judged by its content:
 *
 * - this process's own pid (a run in this process that was abandoned without
 *   releasing, which watch mode can leave behind) — stale: take it over with a
 *   warning;
 * - a `startedAt` older than `maxHoldMs` — stale whatever the pid says, since no
 *   run holds it that long. This is what answers pid reuse: Windows hands a dead
 *   worker's pid to an unrelated process quickly, and liveness alone would then
 *   make every later run wait out its deadline and fail. A `startedAt` that does
 *   not parse is an unknown age, and liveness decides;
 * - a dead holder — stale: take it over with a warning;
 * - a live holder — wait, polling, until it is gone or the deadline passes, then
 *   throw naming the holder;
 * - empty or unreadable content — a writer between its create and its write if
 *   the file is fresh, so wait; a crashed writer if it is older than
 *   `staleEmptyMs`, so take it over with a warning.
 *
 * A take-over is a rename, never a delete of the shared path: the lock is moved
 * aside to a name only this process uses, and only then compared with what was
 * judged stale. Two waiters judging the same stale lock therefore cannot both
 * act on it — the second rename finds nothing, or moves the first waiter's fresh
 * lock, sees it differs and links it back.
 *
 * Known limits, stated: putting a moved fresh lock back is exclusive, so if a
 * third run created a lock in the instant between the move and the link-back, the
 * moved one is dropped and two runs hold the lock at once — a three-way race
 * inside a single rename. And a `startedAt` that does not parse leaves pid reuse
 * to the deadline, which then fails naming the lock to delete.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
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

/** The lock's content, or `null` when it is gone (ENOENT). */
function readLock(lockPath) {
  try {
    return { raw: readFileSync(lockPath, "utf-8"), mtimeMs: statSync(lockPath).mtimeMs };
  } catch (error) {
    if (error.code === "ENOENT") return null;
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
    // Unparseable: the caller decides between "being written" and "crashed".
  }
  return null;
}

/** Create the lock, or return `false` when it already exists. */
function tryCreate(lockPath, content) {
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, content);
  } catch (error) {
    closeSync(fd);
    rmSync(lockPath, { force: true });
    throw error;
  }
  closeSync(fd);
  return true;
}

/**
 * Take over a lock judged stale with content `judgedRaw`, atomically: move it
 * aside, then check that what moved is what was judged. Returns `"taken"` when
 * the stale lock is gone, `"lost"` when someone else got there first (nothing
 * was there to move, or what moved was a fresh lock, now put back), and `"busy"`
 * when the rename hit a transient Windows error and should be tried again later.
 */
function takeOver(lockPath, judgedRaw, ownPid) {
  const aside = `${lockPath}.${ownPid}.${randomBytes(6).toString("hex")}.stale`;
  try {
    renameSync(lockPath, aside);
  } catch (error) {
    if (error.code === "ENOENT") return "lost";
    if (TRANSIENT.has(error.code)) return "busy";
    throw error;
  }
  try {
    if (readFileSync(aside, "utf-8") === judgedRaw) return "taken";
    // A fresh lock replaced the stale one between the judgement and the move.
    // Put it back — exclusively, because if the path is taken again someone holds
    // the lock now, and theirs must not be overwritten.
    try {
      linkSync(aside, lockPath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return "lost";
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Acquire the lock at `lockPath`, waiting for a live holder up to `deadlineMs`.
 * Resolves to `release()`, which removes the lock only while it still names this
 * process, so a release after a take-over never deletes the new holder's lock.
 *
 * `_beforeTakeOver` is a test seam: it runs between judging a lock stale and
 * moving it aside, which is where a competing waiter would act.
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
 * }} [options]
 * @returns {Promise<() => void>}
 */
export async function acquireProbeLock(lockPath, options = {}) {
  const {
    isAlive = isProcessAlive,
    now = Date.now,
    pollMs = 500,
    deadlineMs = 300_000,
    staleEmptyMs = 5_000,
    maxHoldMs = Number.POSITIVE_INFINITY,
    log = (message) => console.warn(message),
    _beforeTakeOver,
  } = options;
  const ownPid = process.pid;
  const deadline = now() + deadlineMs;

  mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    if (tryCreate(lockPath, JSON.stringify({ pid: ownPid, startedAt: new Date(now()).toISOString() }))) {
      return () => release(lockPath, ownPid, log);
    }

    const seen = readLock(lockPath);
    if (seen === null) continue; // released between our create and our read: try again

    const holder = parseHolder(seen.raw);
    let staleBecause;
    if (holder === null) {
      const ageMs = now() - seen.mtimeMs;
      if (ageMs >= staleEmptyMs) {
        staleBecause = `its content is unreadable and ${Math.round(ageMs / 1000)}s old, so its writer crashed`;
      }
    } else if (holder.pid === ownPid) {
      staleBecause = `it names this process (pid ${ownPid}), so an earlier run here never released it`;
    } else {
      // NaN for a missing or malformed `startedAt`: an unknown age, never "old".
      const heldMs = now() - Date.parse(holder.startedAt);
      if (heldMs > maxHoldMs) {
        staleBecause =
          `pid ${holder.pid} has held it for ${Math.round(heldMs / 1000)}s, longer than any run can, ` +
          `so that pid now belongs to some other process`;
      } else if (!isAlive(holder.pid)) {
        staleBecause = `its holder, pid ${holder.pid}, is no longer running`;
      }
    }

    if (staleBecause !== undefined) {
      _beforeTakeOver?.();
      const outcome = takeOver(lockPath, seen.raw, ownPid);
      if (outcome === "taken") {
        log(`[probe-lock] took over a stale lock at ${lockPath}: ${staleBecause}.`);
        continue;
      }
      if (outcome === "lost") continue; // judge whatever is there now
      // "busy": fall through and wait like any other held lock.
    }

    if (now() >= deadline) {
      const who =
        holder === null
          ? "a writer that never finished writing it"
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

/**
 * Never throws: it runs in the guard's `finally`, where a throw would replace the
 * assertion that actually failed. A lock left behind by a failed release names
 * this process, so the next run takes it over as stale.
 */
function release(lockPath, ownPid, log) {
  try {
    const seen = readLock(lockPath);
    if (seen === null) return;
    if (parseHolder(seen.raw)?.pid === ownPid) rmSync(lockPath, { force: true });
  } catch (error) {
    log(
      `[probe-lock] could not release the lock at ${lockPath} (${error.code ?? error.message}); ` +
        `the next run takes it over.`,
    );
  }
}
