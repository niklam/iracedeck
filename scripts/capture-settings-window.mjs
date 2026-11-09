/**
 * Capture the Settings window screenshots to look at a change (#1010, #1536).
 *
 *   pnpm build            # the harness reads the plugin's built ui/ folder
 *   pnpm capture:settings # or --scale=2 for HiDPI
 *
 * Writes one PNG per tab under `local/settings-window-capture/`, which is
 * gitignored: this is for looking at a change only, never for committing. The
 * committed set in `packages/website/src/assets/settings-window/` is captured
 * by the stable release, into its version-bump commit, so no branch ever
 * carries a screenshot another branch conflicts with (#1536). Nothing here
 * writes that folder or its `capture.json`.
 *
 * Captures run against the Stream Deck plugin build specifically: the Profiles
 * tab only exists where the `profiles` platform flag is on.
 *
 * The Support iRaceDeck tab draws an image from another site. When that image
 * does not load (offline, or the site is slow), the tab is skipped, its PNG is
 * left as it was, and the run says so and exits 1.
 *
 * The run ends by itself (#1544): the capture shuts the browser down over the
 * DevTools Protocol and waits until no process names its profile, killing
 * only those that outlive the bound; the profile is removed with a
 * bounded retry of our own, and a tripwire armed after the last line fails the
 * run loudly, naming what holds it, if anything still keeps the process alive.
 *
 * The real server, browser and filesystem are resolved by `runCapture`
 * (`lib/settings-window-capture/run-capture.mjs`), which the release's capture
 * shares; this file only reads the arguments, picks the folder and reports.
 */
import url from "node:url";

import { armExitTripwire } from "./lib/settings-window-capture/exit-tripwire.mjs";
import {
  CapturePreconditionError,
  localCaptureDir,
  runCapture as realRunCapture,
  REPO_ROOT,
} from "./lib/settings-window-capture/run-capture.mjs";

/**
 * The capture, with its runner injectable so the arguments, the folder and
 * the report are tested without a build or a browser. Returns the exit code.
 *
 * @param {readonly string[]} argv - Everything after the script path.
 * @param {object} [deps]
 * @param {typeof realRunCapture} [deps.runCapture]
 * @param {(line: string) => void} [deps.log]
 * @param {(line: string) => void} [deps.warn]
 * @param {(line: string) => void} [deps.error]
 * @param {string} [deps.repoRoot]
 * @returns {Promise<number>}
 */
export async function main(
  argv,
  {
    runCapture = realRunCapture,
    log = console.log,
    warn = console.warn,
    error = console.error,
    repoRoot = REPO_ROOT,
  } = {},
) {
  /** Actual size (1) or HiDPI (2). Override with `--scale=2`. */
  const scaleArg = argv.find((a) => a.startsWith("--scale="))?.split("=")[1];
  const scale = scaleArg === undefined ? 1 : Number(scaleArg);

  if (!Number.isFinite(scale) || scale <= 0) {
    // Chromium takes deviceScaleFactor verbatim; NaN from a typo would fail deep
    // inside the CDP call rather than here, where the mistake actually is.
    error(`--scale must be a positive number; got "${scaleArg}".`);

    return 1;
  }

  // Never the committed folder: the stable release alone writes that (#1536).
  const outDir = localCaptureDir(repoRoot);

  let written;
  let skipped;

  try {
    ({ written, skipped } = await runCapture({ outDir, scale, log, warn }));
  } catch (thrown) {
    // A missing build or browser is a sentence for the user; anything else
    // keeps its stack.
    error(thrown instanceof CapturePreconditionError ? thrown.message : String(thrown?.stack ?? thrown));

    return 1;
  }

  log(`\nWrote ${written.length} screenshots to ${outDir}`);

  // A tab whose image did not load was not captured, so its file is still the
  // last good one, if any. Said last and with a failing exit code, because the
  // warning mid-run scrolls past and a run that ends "Wrote N screenshots"
  // reads as a refresh of all of them.
  for (const { file, label, reason } of skipped) {
    error(`Skipped ${file} (the ${label} tab): ${reason}. The existing file was left unchanged.`);
  }

  return skipped.length > 0 ? 1 : 0;
}

// Direct-exec guard: only run when this file was executed as the entry script,
// so importing `main` (the tests do) captures nothing.
const invokedPath = process.argv[1];
if (
  invokedPath &&
  (import.meta.url === url.pathToFileURL(invokedPath).href || invokedPath === url.fileURLToPath(import.meta.url))
) {
  // The code is set, not exited with, so every line above is flushed first.
  process.exitCode = await main(process.argv.slice(2));

  // Last, after every line: a healthy run has exited before this can fire.
  armExitTripwire();
}
