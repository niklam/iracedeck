/**
 * Settings window screenshot capture (issue #1010).
 *
 * Orchestration only. Every side-effecting collaborator — the settings server,
 * the browser process, the CDP connection, the filesystem, the clock — arrives
 * as an injected dependency, the same delegate-injection shape deck-core uses
 * for its keyboard and window services. That is what lets this be tested with
 * fakes instead of requiring a browser in CI.
 *
 * The page is served by the REAL `startSettingsWindowServer` against the built
 * `ui/` folder, so what gets captured is what ships — not a static shell whose
 * controls never populated.
 */
import { join } from "node:path";

import { SETTINGS_WINDOW_TABS } from "./tabs.mjs";

/** Pause after switching tabs, so layout and any lazy content settle. */
export const TAB_SETTLE_MS = 400;

/** Pause after the page's load event, before the first capture. */
export const PAGE_SETTLE_MS = 1500;

/**
 * How long to wait for the page's own load event before settling anyway.
 *
 * `Page.navigate` resolves when navigation STARTS, not when the page is ready,
 * so without this the first capture races the page's scripts, its settings
 * round-trip and its 200-odd binding rows — and a page that has not rendered
 * yet is indistinguishable from a page missing the nav button we are about to
 * click, which is a badly misleading way to fail.
 */
export const PAGE_LOAD_TIMEOUT_MS = 15_000;

/**
 * An in-memory {@link SettingsWindowHost} over a plain object.
 *
 * The page writes whole-page snapshots as sdpi-components always does, so each
 * write is merged over the current settings rather than replacing them, and
 * subscribers are notified — the window's own controls depend on that echo to
 * render what they just saved. The seed handed in is copied, so the caller's
 * fixture is never written through.
 *
 * @param {Record<string, unknown>} initial - Seed settings (copied, not mutated).
 * @returns {{read: () => Record<string, unknown>, write: (partial: Record<string, unknown>) => void, subscribe: (listener: (settings: Record<string, unknown>) => void) => () => void}}
 */
export function createSeedSettingsHost(initial) {
  let settings = { ...initial };
  /** @type {((settings: Record<string, unknown>) => void)[]} */
  const listeners = [];

  return {
    read: () => settings,
    write(partial) {
      settings = { ...settings, ...partial };

      for (const listener of listeners) listener(settings);
    },
    subscribe(listener) {
      listeners.push(listener);

      return () => {
        const index = listeners.indexOf(listener);

        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
}

/**
 * Start listening for the page session's load event.
 *
 * Called BEFORE `Page.navigate`, because a page served from loopback can fire
 * its load event before the navigate command's own reply comes back — subscribe
 * afterwards and the event is simply missed, which would stall the capture for
 * the whole fallback timeout every run.
 *
 * A CDP double without `onEvent` yields a promise that never settles; the
 * caller always races it against a timeout, so that degrades to "settle for the
 * timeout" rather than hanging.
 *
 * @param {any} cdp
 * @param {string} sessionId
 * @returns {{fired: Promise<void>, stop: () => void}}
 */
function watchForPageLoad(cdp, sessionId) {
  if (typeof cdp?.onEvent !== "function") return { fired: new Promise(() => {}), stop: () => {} };

  /** @type {() => void} */
  let resolveFired;
  const fired = new Promise((resolve) => {
    resolveFired = resolve;
  });
  const unsubscribe = cdp.onEvent((message) => {
    if (message?.method === "Page.loadEventFired" && message.sessionId === sessionId) resolveFired();
  });

  return { fired, stop: () => unsubscribe?.() };
}

/**
 * Capture one PNG per Settings window tab.
 *
 * @param {object} options
 * @param {string} options.assetsDir - The plugin's built `ui/` folder.
 * @param {string} options.pageFile - Page filename inside `assetsDir`.
 * @param {string} options.outDir - Where the PNGs are written.
 * @param {Record<string, unknown>} options.settings - Seed settings.
 * @param {{width: number, height: number}} options.size - Window size to emulate.
 * @param {number} [options.deviceScaleFactor] - 1 for actual size, 2 for HiDPI.
 * @param {readonly import("./tabs.mjs").SettingsWindowTab[]} [options.tabs]
 * @param {object} deps - Injected collaborators.
 * @param {(opts: object) => Promise<{url: string, close: () => Promise<void>}>} deps.startServer
 * @param {() => Promise<{port: number, kill: () => void}>} deps.launchBrowser
 * @param {(port: number) => Promise<string>} deps.debuggerUrl
 * @param {(url: string) => Promise<any>} deps.connect
 * @param {(file: string, data: Buffer) => Promise<void>} deps.writeFile
 * @param {(ms: number) => Promise<void>} [deps.delay]
 * @param {(message: string) => void} [deps.log]
 * @returns {Promise<string[]>} The files written, in tab order.
 */
export async function captureSettingsWindow(options, deps) {
  const {
    assetsDir,
    pageFile,
    outDir,
    settings,
    size,
    deviceScaleFactor = 1,
    tabs = SETTINGS_WINDOW_TABS,
  } = options;
  const {
    startServer,
    launchBrowser,
    debuggerUrl,
    connect,
    writeFile,
    // unref'd: the settings server and the CDP socket keep the loop alive for
    // the whole capture, so nothing can exit early — but a fallback timer left
    // pending by a race that resolved early can never hold the process open
    // after the last screenshot is written.
    delay = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms).unref?.();
      }),
    log = () => {},
  } = deps;

  const host = createSeedSettingsHost(settings);
  const server = await startServer({
    assetsDir,
    pageFile,
    settingsHost: host,
    // The window's SimHub tab shows a live reachability line. Answer for the
    // fixture rather than probing a SimHub that may or may not be running on
    // whoever's machine is capturing.
    simHub: { isReachable: () => false, getRoles: async () => [] },
    // External links and plugin commands are inert in a capture: nothing
    // should open a browser or touch a real deck.
    openUrl: async () => {},
    onSendToPlugin: () => {},
  });

  log(`Settings server listening; page at ${server.url.replace(/t=[^&]+/, "t=…")}`);

  /** @type {{port: number, kill: () => void} | undefined} */
  let browser;
  let cdp;
  const written = [];

  try {
    // Inside the try: the server already holds a port, so a browser that fails
    // to launch must still reach `server.close()` in the finally.
    browser = await launchBrowser();
    cdp = await connect(await debuggerUrl(browser.port));

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: size.width, height: size.height, deviceScaleFactor, mobile: false },
      sessionId,
    );

    // Navigate only once the page session is configured, so the first paint
    // already has the right viewport and no capture shows a reflow.
    const load = watchForPageLoad(cdp, sessionId);

    await cdp.send("Page.navigate", { url: server.url }, sessionId);

    try {
      await Promise.race([load.fired, delay(PAGE_LOAD_TIMEOUT_MS)]);
    } finally {
      load.stop();
    }

    await delay(PAGE_SETTLE_MS);

    for (const tab of tabs) {
      // Click the nav button exactly as a user would, rather than un-hiding
      // the pane directly: that keeps the capture honest about the page's own
      // tab-switching behaviour, including the active-item highlight.
      const { result } = await cdp.send(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const button = document.querySelector('.sw-nav-item[data-pane="${tab.pane}"]');
            if (!button) return false;
            button.click();
            return true;
          })()`,
          returnByValue: true,
        },
        sessionId,
      );

      if (result?.value !== true) {
        throw new Error(
          `The settings page has no nav button for "${tab.pane}". ` +
            (tab.elgatoOnly
              ? `That tab only exists where the "profiles" platform flag is on, so capture against the ` +
                `Stream Deck plugin's ui/ folder — a Mirabox or Ulanzi build is missing it. `
              : "") +
            `Otherwise rebuild the plugin, or update SETTINGS_WINDOW_TABS if the tab was renamed.`,
        );
      }

      await delay(TAB_SETTLE_MS);

      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      const file = join(outDir, tab.file);
      await writeFile(file, Buffer.from(shot.data, "base64"));
      written.push(file);
      log(`Captured ${tab.label} → ${tab.file}`);
    }
  } finally {
    cdp?.close();
    browser?.kill();
    await server.close();
  }

  return written;
}
