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
import { fileURLToPath } from "node:url";

import { captureSettingsWindow } from "./lib/settings-window-capture/capture.mjs";
import { buildSeedSettings } from "./lib/settings-window-capture/seed.mjs";
import { connectCdp, waitForDebuggerUrl } from "./lib/settings-window-capture/cdp.mjs";

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
const scale = Number(process.argv.find((a) => a.startsWith("--scale="))?.split("=")[1] ?? 1);

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

const { findChromiumBrowserOnThisMachine, SETTINGS_WINDOW_SIZE, startSettingsWindowServer } =
  await import(`file://${deckCore.replace(/\\/g, "/")}`);

const browserPath = findChromiumBrowserOnThisMachine();

if (!browserPath) {
  console.error(
    "No Chromium-based browser (Edge or Chrome) was found on this machine, so the page cannot be rendered.\n" +
      "The Settings window itself has the same requirement — see docs/features/settings-window.md.",
  );
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

/** A throwaway profile, so the capture never touches a real browser profile. */
const profileDir = join(tmpdir(), `iracedeck-capture-${process.pid}`);

const written = await captureSettingsWindow(
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
      // Port 0 lets the OS pick, but Chromium then reports the real port only
      // via DevToolsActivePort in the profile dir; asking for a fixed high
      // port keeps the wiring simple and the harness is short-lived.
      const port = 9222;
      const child = spawn(
        browserPath,
        [
          "--headless=new",
          `--remote-debugging-port=${port}`,
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

      child.unref();

      return { port, kill: () => child.kill() };
    },
    debuggerUrl: (port) => waitForDebuggerUrl(port),
    connect: (url) => connectCdp(url),
    writeFile: (file, data) => writeFile(file, data),
    log: (message) => console.log(message),
  },
);

await rm(profileDir, { recursive: true, force: true }).catch(() => {});

console.log(`\nWrote ${written.length} screenshots to ${outDir}`);
