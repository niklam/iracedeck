/**
 * Removing the capture's throwaway browser profile (#1544).
 *
 * The capture shuts its browser down before this runs, so the profile is
 * normally free and one `rm` takes milliseconds. The retries cover the moment
 * Windows can still hold a file after a process exits — and they are ours,
 * counted and short, because Node's own `maxRetries` backs off further on each
 * try against a file something holds, which is how a browser left running kept
 * the capture from exiting for minutes.
 */
import { rm } from "node:fs/promises";

/** How many times removal is tried before the profile is left behind. */
export const PROFILE_REMOVE_ATTEMPTS = 5;

/** The pause between two tries. */
export const PROFILE_REMOVE_RETRY_MS = 300;

/**
 * Remove a directory tree, trying a bounded number of times.
 *
 * Every `rm` runs without `maxRetries`, so each try fails at once rather than
 * retrying on timers of its own, and the whole is bounded by
 * {@link PROFILE_REMOVE_ATTEMPTS} × {@link PROFILE_REMOVE_RETRY_MS} of
 * pauses. Never throws: a folder that cannot be removed is for the caller to
 * name, not a reason to fail a capture that has already been written.
 *
 * The default pause is a ref'd timer, deliberately: by the time this runs the
 * settings server and the debugger socket are closed, so an unref'd one would
 * leave nothing holding the event loop, and Node would end the script in the
 * middle of the wait (exit 13, an unsettled top-level await).
 *
 * @param {string} dir
 * @param {object} [deps]
 * @param {(dir: string, options: object) => Promise<void>} [deps.rmImpl] - `fs.promises.rm`, injected for tests.
 * @param {(ms: number) => Promise<void>} [deps.delay] - Injected sleep.
 * @returns {Promise<{removed: true} | {removed: false, error: unknown}>}
 */
export async function removeProfileDir(dir, deps = {}) {
  const { rmImpl = rm, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = deps;
  let lastError;

  for (let attempt = 1; attempt <= PROFILE_REMOVE_ATTEMPTS; attempt += 1) {
    try {
      await rmImpl(dir, { recursive: true, force: true });

      return { removed: true };
    } catch (error) {
      lastError = error;
    }

    if (attempt < PROFILE_REMOVE_ATTEMPTS) await delay(PROFILE_REMOVE_RETRY_MS);
  }

  return { removed: false, error: lastError };
}
