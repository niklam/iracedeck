/**
 * release-it's `after:bump` hook (#1536):
 *
 *   node scripts/release-capture.mjs <version>
 *
 * On a stable version it builds the Stream Deck plugin, captures every Settings
 * window tab into `packages/website/src/assets/settings-window/`, writes
 * `capture.json` beside them and stages the folder for release-it's
 * version-bump commit; on a pre-release it does nothing but say so. With
 * `RELEASE_IT_DRY_RUN=1` it prints what it would do and writes nothing. The
 * decisions live in `lib/release-capture.mjs`; this file reads the argument,
 * sets the exit code and arms the exit tripwire, since the capture's browser
 * can hold the event loop open after the work is done (#1544). The tripwire
 * fires whatever the hook returned, so its report ends with the same restore
 * commands a failure names: by then the folder may already be staged.
 */
import url from "node:url";

import { exitTripwireHint, releaseCapture } from "./lib/release-capture.mjs";
import { armExitTripwire } from "./lib/settings-window-capture/exit-tripwire.mjs";

export const USAGE = "Usage: node scripts/release-capture.mjs <version>";

/**
 * Read the version and run the capture. Returns the exit code.
 *
 * @param {readonly string[]} argv - Everything after the script path.
 * @param {object} [deps]
 * @param {(version: string) => Promise<number>} [deps.run]
 * @param {(line: string) => void} [deps.error]
 * @returns {Promise<number>}
 */
export async function main(argv, { run = (version) => releaseCapture(version), error = console.error } = {}) {
  const [version] = argv;

  if (version === undefined || version === "") {
    error(USAGE);

    return 1;
  }

  return run(version);
}

/**
 * Arm the exit tripwire with the release's restore hint, so a run held open
 * after it staged the folder still names the way back to HEAD.
 *
 * @param {object} [deps]
 * @param {typeof armExitTripwire} [deps.arm]
 * @param {NodeJS.ProcessEnv} [deps.env] - Read for `RELEASE_IT_DRY_RUN`.
 * @returns {ReturnType<typeof armExitTripwire>}
 */
export function armReleaseTripwire({ arm = armExitTripwire, env = process.env } = {}) {
  return arm({ hint: exitTripwireHint(env) });
}

// Direct-exec guard: only run when this file was executed as the entry script,
// so importing `main` (the tests do) builds and captures nothing.
const invokedPath = process.argv[1];
if (
  invokedPath &&
  (import.meta.url === url.pathToFileURL(invokedPath).href || invokedPath === url.fileURLToPath(import.meta.url))
) {
  // The code is set, not exited with, so every line above is flushed first.
  process.exitCode = await main(process.argv.slice(2));

  // Last, after every line: a healthy run has exited before this can fire.
  armReleaseTripwire();
}
