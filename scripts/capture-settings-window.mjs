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
 * This file is the composition root — it resolves the real server, browser and
 * filesystem and hands them to `captureSettingsWindow`, which contains the
 * logic and no I/O of its own.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { captureSettingsWindow } from "./lib/settings-window-capture/capture.mjs";
import { buildSeedSettings } from "./lib/settings-window-capture/seed.mjs";
import { connectCdp, waitForDebuggerUrl, waitForDevToolsPort } from "./lib/settings-window-capture/cdp.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const deckCore = join(repoRoot, "packages", "deck-core", "dist", "index.js");
const assetsDir = join(
  repoRoot,
  "packages",
  "iracing-plugin-stream-deck",
  "com.iracedeck.sd.core.sdPlugin",
  "ui",
);
const outDir = join(repoRoot, "packages", "website", "src", "assets", "settings-window");

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

if (!existsSync(deckCore)) {
  console.error(`@iracedeck/deck-core has not been built — ${deckCore} is missing. Run "pnpm build" first.`);
  process.exit(1);
}

const { findChromiumBrowserOnThisMachine, SETTINGS_WINDOW_SIZE, startSettingsWindowServer } = await import(
  pathToFileURL(deckCore).href
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

try {
  written = await captureSettingsWindow(
    {
      assetsDir,
      pageFile: "settings-window.html",
      outDir,
      settings: buildSeedSettings(),
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
        // shape as deck-core's own spawnAppWindow.
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", (error) => reject(new Error(`Could not launch ${browserPath}: ${error.message}`)));
        });

        const port = await waitForDevToolsPort(profileDir);

        child.unref();

        return { port, kill: () => child.kill() };
      },
      debuggerUrl: (port) => waitForDebuggerUrl(port),
      connect: (url) => connectCdp(url),
      writeFile: (file, data) => writeFile(file, data),
      log: (message) => console.log(message),
    },
  );
} finally {
  // In a finally so a failed run does not leave ~100 MB of browser profile in
  // %TEMP%, and with retries because Windows often still holds Chromium's
  // files for a moment after kill().
  await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

console.log(`\nWrote ${written.length} screenshots to ${outDir}`);
