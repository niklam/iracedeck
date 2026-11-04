/**
 * The capture's view of the browser's process (#1544): is it still running,
 * and kill it with everything it started.
 *
 * Kept apart from the orchestration in `capture.mjs`, which receives these as
 * injected collaborators so its teardown is tested with fakes; the OS calls are
 * injected here in turn, so this is tested without starting a process.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** How long `taskkill` may run before it is given up on. */
export const KILL_TREE_TIMEOUT_MS = 10_000;

/**
 * Whether a process is still running.
 *
 * Signal 0 checks for the process without signalling it. `ESRCH` means there
 * is no such process; `EPERM` means there is one we may not signal, which is
 * still a running process, as is any other answer — a wrong "gone" would end
 * the wait for a browser that still holds its profile.
 *
 * @param {number} pid
 * @param {object} [deps]
 * @param {(pid: number, signal: number | string) => unknown} [deps.kill] - `process.kill`, injected for tests.
 * @returns {boolean}
 */
export function isProcessAlive(pid, deps = {}) {
  const { kill = (target, signal) => process.kill(target, signal) } = deps;

  try {
    kill(pid, 0);

    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error)?.code !== "ESRCH";
  }
}

/**
 * Kill a process and every process it started.
 *
 * On Windows `taskkill /T /F` takes the tree: a headless browser runs a
 * renderer, GPU and utility processes of its own, and killing only the
 * browser can leave them holding its profile. Elsewhere the browser's
 * children exit with it, so `SIGKILL` to the browser is enough — it is only
 * reached after the browser ignored `Browser.close`, so it is not asked twice.
 *
 * @param {number} pid - The browser's own process, never a launcher's.
 * @param {object} [deps]
 * @param {NodeJS.Platform} [deps.platform]
 * @param {(file: string, args: string[], options: object) => Promise<unknown>} [deps.execFileImpl] - Promisified `execFile`, injected for tests.
 * @param {(pid: number, signal: number | string) => unknown} [deps.kill] - `process.kill`, injected for tests.
 * @returns {Promise<void>} Rejects when the kill could not be sent; whether
 *   the process has gone is for the caller to check.
 */
export async function killProcessTree(pid, deps = {}) {
  const {
    platform = process.platform,
    execFileImpl = promisify(execFile),
    kill = (target, signal) => process.kill(target, signal),
  } = deps;

  if (platform === "win32") {
    await execFileImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: KILL_TREE_TIMEOUT_MS,
    });

    return;
  }

  kill(pid, "SIGKILL");
}
