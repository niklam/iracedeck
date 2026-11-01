/**
 * `pnpm stop:stream-deck` / `start:stream-deck` (#1557), dispatched through
 * `scripts/host-app.mjs` like the other hosts' scripts. Until #1557 they were a
 * `taskkill ... || exit 0` and a `start /B` of one hardcoded path, so a refused
 * kill (an elevated Stream Deck) read as success and the build or relink that
 * followed ran under the old plugin, and a missing executable said nothing.
 *
 * The rule is #1523's: each script does its job or exits 1 with a message
 * naming what went wrong. The pieces are #1523's and #1040's — `findRunning`
 * and `STREAM_DECK` from `build-restart.mjs`, `stopHost`'s taskkill
 * classification and `launchApp` from `host-control.mjs` — in their shape:
 * injected `spawnSync` / `spawn` / `exists` / `env` / `log`, an exit code
 * returned, never `process.exit`.
 */
import { findRunning, STREAM_DECK } from "./build-restart.mjs";
import { launchApp, stopHost } from "./host-control.mjs";

/** The host name `scripts/host-app.mjs` takes for Stream Deck. */
export const STREAM_DECK_HOST_ID = "stream-deck";

/** How long `stopStreamDeck` waits for a killed Stream Deck to be gone: attempts × interval. */
export const EXIT_WAIT_ATTEMPTS = 20;
export const EXIT_WAIT_INTERVAL_MS = 500;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pids = (processes) => processes.map(({ pid }) => pid).join(", ");

/**
 * Force-stops Stream Deck, then waits until no StreamDeck.exe is left.
 *
 * The wait is why this is more than `stopHost`. `taskkill /F` returns once
 * the kill is issued, not once the process is gone, so a `start` straight
 * after it can find the old instance still exiting, and Stream Deck, which
 * runs one instance, can then defer to it and leave nothing running. It also
 * catches a kill that ended one of several processes and not another.
 *
 * @returns {Promise<number>} 0 when Stream Deck is not running (it was stopped
 *   or never ran), 1 when the kill was refused, it did not exit in time, or
 *   whether it exited could not be told.
 */
export async function stopStreamDeck({ spawnSync, platform = process.platform, sleep = sleepFor, log = console }) {
  const { label, image } = STREAM_DECK;

  if (platform !== "win32") {
    log.log(`${label} host control is Windows-only — nothing to stop.`);

    return 0;
  }

  const killed = spawnSyncRecorder(spawnSync);
  if (stopHost({ label }, { appPath: image, spawnSync: killed.spawnSync, log }) !== 0) return 1;

  // "was not running": nothing to wait for.
  if (killed.status !== 0) return 0;

  for (let attempt = 1; ; attempt++) {
    const found = findRunning(image, { spawnSync });

    if (found.state === "not-running") return 0;

    if (found.state === "unknown") {
      log.error(`Error: ${image} was killed, but whether it has exited could not be told: ${found.reason}`);
      log.error(`  Check that ${label} is gone before building or relinking.`);

      return 1;
    }

    if (attempt === EXIT_WAIT_ATTEMPTS) {
      // "At least": each attempt's process listing takes time on top of the sleeps.
      const seconds = ((EXIT_WAIT_ATTEMPTS - 1) * EXIT_WAIT_INTERVAL_MS) / 1000;
      log.error(
        `Error: ${image} is still running at least ${seconds} s after the kill (pid ${pids(found.processes)}).`,
      );
      log.error(
        `  ${label} will not load a new build until it restarts, and a relink can fail on files it holds open.`,
      );

      return 1;
    }

    await sleep(EXIT_WAIT_INTERVAL_MS);
  }
}

/**
 * Starts Stream Deck from its install path, unless it is already running.
 *
 * A running Stream Deck is not started again: it is the one instance there can
 * be, and saying "Started" would claim a fresh load of the plugin that never
 * happened. When whether it runs cannot be told, it is started anyway — a
 * launch over a running instance only brings that one forward.
 *
 * @returns {Promise<number>} 0 when Stream Deck was started or already runs,
 *   1 when its executable is missing or could not be started.
 */
export async function startStreamDeck({
  spawn,
  spawnSync,
  exists,
  env = process.env,
  platform = process.platform,
  log = console,
}) {
  const { label, image } = STREAM_DECK;

  if (platform !== "win32") {
    log.log(`${label} host control is Windows-only — nothing to start.`);

    return 0;
  }

  const appPath = STREAM_DECK.defaultAppPath(env);

  if (!appPath || !exists(appPath)) {
    log.error(
      `Error: ${appPath ? `${label} is not installed at ${appPath}` : `%ProgramFiles% is not set, so ${label}'s install path is unknown`}.`,
    );
    log.error(`  Start ${label} yourself.`);

    return 1;
  }

  const found = findRunning(image, { spawnSync });

  if (found.state === "running") {
    log.log(`${label} is already running (pid ${pids(found.processes)}) — not started again.`);
    log.log(`  It loaded its plugins when it started: stop it first (\`pnpm stop:stream-deck\`) to load a new build.`);

    return 0;
  }

  if (found.state === "unknown") {
    log.log(`Could not tell whether ${label} is running (${found.reason}); starting it.`);
    log.log(`  If it was running, this only brings it forward: it loads no new plugins until it is stopped.`);
  }

  return launchApp(appPath, { spawn, log });
}

/**
 * Wraps `spawnSync` to keep the last result's exit status, so the caller can
 * tell `stopHost`'s two successes apart: killed (0) and not running (128).
 */
function spawnSyncRecorder(spawnSync) {
  const recorder = {
    status: undefined,
    spawnSync: (...args) => {
      const result = spawnSync(...args);
      recorder.status = result.status;

      return result;
    },
  };

  return recorder;
}
