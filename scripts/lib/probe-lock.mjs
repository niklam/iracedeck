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
 * - a live holder that is not this process — wait, polling, until it is gone or
 *   the deadline passes, then throw naming the holder;
 * - a dead holder, or this process's own pid (a run in this process that was
 *   abandoned without releasing, which watch mode can leave behind) — stale: take
 *   it over with a warning;
 * - empty or unreadable content — a writer between its create and its write if
 *   the file is fresh, so wait; a crashed writer if it is older than
 *   `staleEmptyMs`, so take it over with a warning.
 *
 * Known limits, stated: a dead holder whose pid the OS has since reused reads as
 * live, so a run waits out its deadline and then fails naming the lock to delete;
 * and the take-over re-reads the content just before deleting it, which narrows
 * but does not close the window in which two waiters judging the same stale lock
 * at once could both act on it.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
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
 * Acquire the lock at `lockPath`, waiting for a live holder up to `deadlineMs`.
 * Resolves to `release()`, which removes the lock only while it still names this
 * process, so a release after a take-over never deletes the new holder's lock.
 *
 * @param {string} lockPath
 * @param {{
 *   isAlive?: (pid: number) => boolean,
 *   now?: () => number,
 *   pollMs?: number,
 *   deadlineMs?: number,
 *   staleEmptyMs?: number,
 *   log?: (message: string) => void,
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
    log = (message) => console.warn(message),
  } = options;
  const ownPid = process.pid;
  const deadline = now() + deadlineMs;

  mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    if (tryCreate(lockPath, JSON.stringify({ pid: ownPid, startedAt: new Date(now()).toISOString() }))) {
      return () => release(lockPath, ownPid);
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
    } else if (!isAlive(holder.pid)) {
      staleBecause = `its holder, pid ${holder.pid}, is no longer running`;
    }

    if (staleBecause !== undefined) {
      // Re-read just before deleting: a lock that changed since it was judged
      // belongs to someone who got there first, and is judged again.
      const again = readLock(lockPath);
      if (again !== null && again.raw === seen.raw) {
        rmSync(lockPath, { force: true });
        log(`[probe-lock] took over a stale lock at ${lockPath}: ${staleBecause}.`);
      }
      continue;
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

function release(lockPath, ownPid) {
  const seen = readLock(lockPath);
  if (seen === null) return;
  if (parseHolder(seen.raw)?.pid === ownPid) rmSync(lockPath, { force: true });
}
