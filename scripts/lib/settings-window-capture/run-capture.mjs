/**
 * The Settings window capture's composition root (#1010, #1536).
 *
 * Resolves the real settings server, browser and filesystem and hands them to
 * `captureSettingsWindow`, which contains the logic and no I/O of its own. Two
 * callers share it, and the folder each passes is the whole difference between
 * them:
 *
 * - `pnpm capture:settings` (`scripts/capture-settings-window.mjs`) captures
 *   into {@link localCaptureDir}, gitignored, for looking at a change.
 * - The stable release's `after:bump` hook captures into
 *   {@link committedCaptureDir} with `expectVersion` set, and writes the
 *   manifest beside the shots itself. This runner never writes one.
 *
 * Only the release passes the committed folder: that is the guard that keeps
 * branches from committing screenshots, which a version check could not be
 * (`docs/superpowers/specs/2026-11-09-issue-1536-whats-new-screenshot-conflicts.md`).
 *
 * A missing build or browser throws a {@link CapturePreconditionError} whose
 * message says what to do; every other failure is the capture's own error.
 * Either way the throwaway browser profile has been removed, or a warning
 * names it, before the error leaves.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { captureSettingsWindow } from "./capture.mjs";
import { connectCdp, waitForDebuggerUrl, waitForDevToolsPort } from "./cdp.mjs";
import { isProcessAlive, killProcessTree, listProcessesNamingDir } from "./process-tree.mjs";
import { removeProfileDir } from "./profile-dir.mjs";
import { buildSeedSettings, buildSeedUpdateStatus } from "./seed.mjs";

/** The repository root this script sits in. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Where `pnpm capture:settings` writes: under `local/`, which the root
 * `.gitignore`'s `local/*` keeps out of every commit.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function localCaptureDir(repoRoot) {
  return join(repoRoot, "local", "settings-window-capture");
}

/**
 * The committed screenshots the website renders. Only the stable release's
 * capture writes here (#1536).
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function committedCaptureDir(repoRoot) {
  return join(repoRoot, "packages", "website", "src", "assets", "settings-window");
}

/**
 * A capture that cannot start: the plugin or the settings window is not built,
 * or no browser was found. Its message is meant for the person running it.
 */
export class CapturePreconditionError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "CapturePreconditionError";
  }
}

/** The Stream Deck plugin's built `ui/` folder: the Profiles tab exists only where its platform flag is on. */
function pluginAssetsDir(repoRoot) {
  return join(repoRoot, "packages", "iracing-plugin-stream-deck", "com.iracedeck.sd.core.sdPlugin", "ui");
}

/** `@iracedeck/settings-window`'s built entry, which serves the page as it ships. */
function settingsWindowEntry(repoRoot) {
  return join(repoRoot, "packages", "settings-window", "dist", "index.js");
}

/**
 * The real collaborators `captureSettingsWindow` takes, over one browser and
 * one throwaway profile.
 *
 * @param {object} context
 * @param {string} context.browserPath
 * @param {string} context.profileDir
 * @param {(options: object) => Promise<{url: string, close: () => Promise<void>}>} context.startSettingsWindowServer
 * @param {(message: string) => void} context.log
 */
function realCaptureDeps({ browserPath, profileDir, startSettingsWindowServer, log }) {
  return {
    startServer: (options) => startSettingsWindowServer(options),
    launchBrowser: async () => {
      const child = spawn(
        browserPath,
        [
          "--headless=new",
          // Let the OS pick the port. A FIXED port silently attaches the
          // harness to whatever else already listens there — a leftover
          // capture browser, or a Chrome the developer runs with
          // --remote-debugging-port for their own work — and the capture
          // would drive that browser's session instead of its own. Chromium
          // reports the port it got in <profileDir>/DevToolsActivePort.
          "--remote-debugging-port=0",
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--hide-scrollbars",
          // Deterministic rendering across machines.
          "--force-color-profile=srgb",
          "--font-render-hinting=none",
        ],
        { stdio: "ignore" },
      );

      // spawn() reports ENOENT/EACCES asynchronously as an 'error' event, NOT
      // a synchronous throw; with no listener that is an uncaught exception
      // that ends the run with a raw stack instead of the message below. Same
      // shape as settings-window's own spawnAppWindow.
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", (error) => reject(new Error(`Could not launch ${browserPath}: ${error.message}`)));
      });

      const port = await waitForDevToolsPort(profileDir);

      // The process spawned may be only a launcher: Edge's hands off to the
      // real headless browser and exits, leaving it orphaned. So this kill
      // reaches the launcher alone and is the capture's last resort; it
      // shuts the real browser down over CDP and recognises its processes by
      // this run's profile folder instead. The unref keeps a launcher that
      // IS the browser from holding the run.
      child.unref();

      return { port, kill: () => child.kill() };
    },
    debuggerUrl: (port) => waitForDebuggerUrl(port),
    connect: (url) => connectCdp(url),
    writeFile: (file, data) => writeFile(file, data),
    processAlive: (pid) => isProcessAlive(pid),
    killTree: (pid) => killProcessTree(pid),
    // The profile folder is this run's alone, and every process of its
    // browser names it: the browser's identity, where a pid is not one.
    listProfileProcesses: () => listProcessesNamingDir(profileDir),
    log,
  };
}

/**
 * Capture every Settings window tab into `outDir`, against the built Stream
 * Deck plugin.
 *
 * @param {object} options
 * @param {string} options.outDir - Created when missing. The caller picks it:
 *   {@link localCaptureDir} or, for the stable release only, {@link committedCaptureDir}.
 * @param {string} [options.expectVersion] - The bare version the page's header
 *   must print as `v<version>`; any other header throws before the first shot.
 * @param {number} [options.scale] - 1 for actual size (the default), 2 for HiDPI.
 * @param {(message: string) => void} [options.log]
 * @param {(message: string) => void} [options.warn] - Where a profile that could not be removed is reported.
 * @param {string} [options.repoRoot] - Defaults to this checkout's root.
 * @param {object} [deps] - The real I/O, injectable so the checks around the
 *   capture are tested without a build or a browser.
 * @param {(file: string) => boolean} [deps.fileExists]
 * @param {(entry: string) => Promise<any>} [deps.loadSettingsWindow] - Imports the built settings-window entry.
 * @param {typeof captureSettingsWindow} [deps.capture]
 * @param {(dir: string) => Promise<unknown>} [deps.makeDir]
 * @param {(dir: string) => Promise<{removed: boolean, error?: unknown}>} [deps.removeProfile]
 * @param {string} [deps.profileDir] - The throwaway browser profile; one per process by default.
 * @returns {Promise<{written: string[], skipped: import("./capture.mjs").SkippedCapture[]}>}
 * @throws {CapturePreconditionError} When the plugin or the settings window is not built, or no browser is found.
 */
export async function runCapture(
  { outDir, expectVersion, scale = 1, log = console.log, warn = console.warn, repoRoot = REPO_ROOT },
  {
    fileExists = existsSync,
    loadSettingsWindow = (entry) => import(pathToFileURL(entry).href),
    capture = captureSettingsWindow,
    makeDir = (dir) => mkdir(dir, { recursive: true }),
    removeProfile = removeProfileDir,
    profileDir = join(tmpdir(), `iracedeck-capture-${process.pid}`),
  } = {},
) {
  if (typeof outDir !== "string" || outDir === "") {
    throw new TypeError(`outDir must be a folder path; got ${JSON.stringify(outDir)}.`);
  }

  // Chromium takes deviceScaleFactor verbatim; NaN would fail deep inside the
  // CDP call rather than here, where the mistake is.
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new TypeError(`scale must be a positive number; got ${JSON.stringify(scale)}.`);
  }

  const assetsDir = pluginAssetsDir(repoRoot);
  const settingsWindow = settingsWindowEntry(repoRoot);

  if (!fileExists(join(assetsDir, "settings-window.html"))) {
    throw new CapturePreconditionError(
      `The Stream Deck plugin has not been built — ${join(assetsDir, "settings-window.html")} is missing.\n` +
        `Run "pnpm build" first; the harness captures the page as it actually ships.`,
    );
  }

  if (!fileExists(settingsWindow)) {
    throw new CapturePreconditionError(
      `@iracedeck/settings-window has not been built — ${settingsWindow} is missing. Run "pnpm build" first.`,
    );
  }

  const { findChromiumBrowserOnThisMachine, SETTINGS_WINDOW_SIZE, startSettingsWindowServer } =
    await loadSettingsWindow(settingsWindow);

  const browserPath = findChromiumBrowserOnThisMachine();

  if (!browserPath) {
    throw new CapturePreconditionError(
      "No Chromium-based browser (Edge or Chrome) was found on this machine, so the page cannot be rendered.\n" +
        "The Settings window itself has the same requirement — see docs/getting-started/settings.md.",
    );
  }

  await makeDir(outDir);

  /** The version the built page reports — the fixture's "you're on X". */
  const pluginVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).version;

  try {
    return await capture(
      {
        assetsDir,
        pageFile: "settings-window.html",
        outDir,
        settings: buildSeedSettings(),
        updates: buildSeedUpdateStatus(pluginVersion),
        size: SETTINGS_WINDOW_SIZE,
        deviceScaleFactor: scale,
        expectVersion,
      },
      realCaptureDeps({ browserPath, profileDir, startSettingsWindowServer, log }),
    );
  } finally {
    // In a finally so a failed run does not leave ~100 MB of browser profile in
    // %TEMP%. The browser has been shut down and waited for by now, so this
    // normally takes one try; the few retries are bounded and our own, because
    // Node's maxRetries backs off for minutes on a file a live browser holds.
    const removal = await removeProfile(profileDir);

    if (!removal.removed) {
      warn(
        `Warning: could not remove the capture's browser profile ${profileDir}: ${String(removal.error)}. ` +
          `Delete the folder by hand once no browser holds it.`,
      );
    }
  }
}
