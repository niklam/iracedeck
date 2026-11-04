/**
 * Recapture the Settings window screenshots used by the website (issue #1010).
 *
 *   pnpm build            # the harness reads the plugin's built ui/ folder
 *   pnpm capture:settings
 *
 * Writes one PNG per tab into `packages/website/src/assets/settings-window/`.
 * Run it whenever the window's layout or controls change — a stale screenshot
 * is worse than none. `scripts/lib/settings-window-capture/tabs.test.mjs`
 * fails when a tab is added or renamed, which is the automated nudge; the
 * images themselves cannot be diffed reliably across machines (fonts, GPU), so
 * refreshing them stays a deliberate act.
 *
 * Captures run against the Stream Deck plugin build specifically: the Profiles
 * tab only exists where the `profiles` platform flag is on.
 *
 * The Support iRaceDeck tab draws an image from another site. When that image
 * does not load (offline, or the site is slow), the tab is skipped, its PNG is
 * left as it was, and the run says so and exits 1.
 *
 * The run ends by itself (#1544): the capture shuts the browser down over the
 * DevTools Protocol and waits for its process, the profile is removed with a
 * bounded retry of our own, and a tripwire armed after the last line fails the
 * run loudly, naming what holds it, if anything still keeps the process alive.
 *
 * This file is the composition root — it resolves the real server, browser and
 * filesystem and hands them to `captureSettingsWindow`, which contains the
 * logic and no I/O of its own.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { captureSettingsWindow } from "./lib/settings-window-capture/capture.mjs";
import { connectCdp, waitForDebuggerUrl, waitForDevToolsPort } from "./lib/settings-window-capture/cdp.mjs";
import { armExitTripwire } from "./lib/settings-window-capture/exit-tripwire.mjs";
import { isProcessAlive, killProcessTree } from "./lib/settings-window-capture/process-tree.mjs";
import { removeProfileDir } from "./lib/settings-window-capture/profile-dir.mjs";
import { buildSeedSettings, buildSeedUpdateStatus } from "./lib/settings-window-capture/seed.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const settingsWindow = join(repoRoot, "packages", "settings-window", "dist", "index.js");
const assetsDir = join(repoRoot, "packages", "iracing-plugin-stream-deck", "com.iracedeck.sd.core.sdPlugin", "ui");
const outDir = join(repoRoot, "packages", "website", "src", "assets", "settings-window");

/** The version the built page reports — the fixture's "you're on X". */
const pluginVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).version;

/** Actual size (1) or HiDPI (2). Override with `--scale=2`. */
const scaleArg = process.argv.find((a) => a.startsWith("--scale="))?.split("=")[1];
const scale = scaleArg === undefined ? 1 : Number(scaleArg);

if (!Number.isFinite(scale) || scale <= 0) {
  // Chromium takes deviceScaleFactor verbatim; NaN from a typo would fail deep
  // inside the CDP call rather than here, where the mistake actually is.
  console.error(`--scale must be a positive number; got "${scaleArg}".`);
  process.exit(1);
}

if (!existsSync(join(assetsDir, "settings-window.html"))) {
  console.error(
    `The Stream Deck plugin has not been built — ${join(assetsDir, "settings-window.html")} is missing.\n` +
      `Run "pnpm build" first; the harness captures the page as it actually ships.`,
  );
  process.exit(1);
}

if (!existsSync(settingsWindow)) {
  console.error(
    `@iracedeck/settings-window has not been built — ${settingsWindow} is missing. Run "pnpm build" first.`,
  );
  process.exit(1);
}

const { findChromiumBrowserOnThisMachine, SETTINGS_WINDOW_SIZE, startSettingsWindowServer } = await import(
  pathToFileURL(settingsWindow).href
);

const browserPath = findChromiumBrowserOnThisMachine();

if (!browserPath) {
  console.error(
    "No Chromium-based browser (Edge or Chrome) was found on this machine, so the page cannot be rendered.\n" +
      "The Settings window itself has the same requirement — see docs/getting-started/settings.md.",
  );
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

/** A throwaway profile, so the capture never touches a real browser profile. */
const profileDir = join(tmpdir(), `iracedeck-capture-${process.pid}`);

let written;
let skipped;

try {
  ({ written, skipped } = await captureSettingsWindow(
    {
      assetsDir,
      pageFile: "settings-window.html",
      outDir,
      settings: buildSeedSettings(),
      updates: buildSeedUpdateStatus(pluginVersion),
      size: SETTINGS_WINDOW_SIZE,
      deviceScaleFactor: scale,
    },
    {
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
        // reaches the launcher alone and is the last resort the capture uses
        // only when the browser cannot tell it its own pid; the capture shuts
        // the real browser down over CDP and waits for that pid instead. The
        // unref keeps a launcher that IS the browser from holding the run.
        child.unref();

        return { port, kill: () => child.kill() };
      },
      debuggerUrl: (port) => waitForDebuggerUrl(port),
      connect: (url) => connectCdp(url),
      writeFile: (file, data) => writeFile(file, data),
      processAlive: (pid) => isProcessAlive(pid),
      killTree: (pid) => killProcessTree(pid),
      log: (message) => console.log(message),
    },
  ));
} finally {
  // In a finally so a failed run does not leave ~100 MB of browser profile in
  // %TEMP%. The browser has been shut down and waited for by now, so this
  // normally takes one try; the few retries are bounded and our own, because
  // Node's maxRetries backs off for minutes on a file a live browser holds.
  const removal = await removeProfileDir(profileDir);

  if (!removal.removed) {
    console.warn(
      `Warning: could not remove the capture's browser profile ${profileDir}: ${String(removal.error)}. ` +
        `Delete the folder by hand once no browser holds it.`,
    );
  }
}

console.log(`\nWrote ${written.length} screenshots to ${outDir}`);

// A tab whose image did not load was not captured, so its committed screenshot
// is still the last good one. Said last and with a failing exit code, because
// the warning mid-run scrolls past and a run that ends "Wrote N screenshots"
// reads as a refresh of all of them. The code is set, not exited with, so the
// lines above are flushed first.
for (const { file, label, reason } of skipped) {
  console.error(`Skipped ${file} (the ${label} tab): ${reason}. The existing file was left unchanged.`);
}

if (skipped.length > 0) process.exitCode = 1;

// Last, after every line: a healthy run has exited before this can fire.
armExitTripwire();
