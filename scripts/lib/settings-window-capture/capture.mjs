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

/**
 * Pause after switching tabs, so layout settles. Images are not covered by it:
 * they get the wait below, which ends when they have loaded instead of when a
 * fixed time is up, and then takes this pause once more on a tab that has
 * images, so they are painted before the screenshot.
 */
export const TAB_SETTLE_MS = 400;

/**
 * How long to wait for the images in the tab just opened before giving up on
 * that tab's screenshot (#1303).
 *
 * The Support iRaceDeck tab draws its button from another site, lazily, so the
 * request only starts when the tab is shown and takes as long as that site
 * takes. Every other tab's images are local and already loaded, and they pay
 * one round trip to find that out.
 */
export const PANE_IMAGES_TIMEOUT_MS = 10_000;

/** How often the images are checked while that wait runs. */
export const PANE_IMAGES_POLL_MS = 100;

/**
 * Where the `<img>`s of the visible pane stand: `"none"` when it has no
 * image, `"loading"` while any has not finished, then `"broken"` when one
 * finished without a picture, else `"loaded"`. The VISIBLE pane, whatever its
 * id, so the check follows the page's own tab switch. `complete`
 * is false for a lazy image whose fetch has not started, which is the state
 * right after the click, and TRUE for one whose fetch failed — only its zero
 * `naturalWidth` tells that one from a loaded image, and an offline capture
 * would otherwise pass as a good one.
 *
 * @internal Exported for testing
 */
export const PANE_IMAGES_STATE_EXPRESSION = `(() => {
  const images = Array.from(document.querySelectorAll('.sw-pane:not([hidden]) img'));
  if (images.length === 0) return "none";
  if (!images.every((img) => img.complete)) return "loading";
  return images.some((img) => img.naturalWidth === 0) ? "broken" : "loaded";
})()`;

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
 * Wait until the visible pane's images have finished loading, or the bound is
 * reached.
 *
 * Polls the page through the injected `delay`, so a test runs it without real
 * timers, and counts the time it has asked for rather than reading a clock for
 * the same reason. A pane with no image costs one evaluate and no delay. One
 * whose images have loaded gets one more settle before the answer goes back,
 * whether they were waited for or were found loaded at the first check: the
 * check sees an image finish, not the frame that paints it, an image can
 * finish a moment before the first check as easily as after it, and the
 * caller's next step is the screenshot.
 *
 * @param {any} cdp
 * @param {string} sessionId
 * @param {(ms: number) => Promise<void>} delay
 * @param {import("./tabs.mjs").SettingsWindowTab} tab - Named in the error.
 * @returns {Promise<"loaded" | "broken" | "timeout">} `"broken"` when an image
 *   finished without a picture, `"timeout"` when the bound was reached with
 *   one still loading.
 * @throws When the page answers with anything but one of its four states: an
 *   exception, or no value at all.
 */
async function waitForPaneImages(cdp, sessionId, delay, tab) {
  for (let waited = 0; ; waited += PANE_IMAGES_POLL_MS) {
    const reply = await cdp.send(
      "Runtime.evaluate",
      { expression: PANE_IMAGES_STATE_EXPRESSION, returnByValue: true },
      sessionId,
    );
    const state = reply?.result?.value;

    if (state === "broken") return "broken";

    if (state === "none") return "loaded";

    if (state === "loaded") {
      await delay(TAB_SETTLE_MS);

      return "loaded";
    }

    if (state !== "loading") {
      // Not "still loading": a page that threw, crashed or lost its execution
      // context will answer the same way every time, and polling it would
      // spend the whole bound and then blame an image.
      const thrown = reply?.exceptionDetails?.exception?.description ?? reply?.exceptionDetails?.text;

      throw new Error(
        `The settings page could not say whether the images on the ${tab.label} tab have loaded: ` +
          (thrown ? `it threw ${thrown}` : `it answered ${JSON.stringify(state)}`) +
          `. Nothing was captured for ${tab.file}.`,
      );
    }

    if (waited >= PANE_IMAGES_TIMEOUT_MS) return "timeout";

    await delay(PANE_IMAGES_POLL_MS);
  }
}

/**
 * A tab whose screenshot was not taken, because an image on it never arrived.
 *
 * @typedef {object} SkippedCapture
 * @property {string} file - The file that was NOT written; whatever was there is as it was.
 * @property {string} label - The tab's label.
 * @property {string} reason - What the image did, as a clause: "an image failed to load".
 */

/**
 * Capture one PNG per Settings window tab.
 *
 * A tab with an image that did not load is skipped, not captured without it:
 * its file is left as it was and the tab comes back in `skipped`, so the caller
 * can fail the run. Every other tab is still captured.
 *
 * @param {object} options
 * @param {string} options.assetsDir - The plugin's built `ui/` folder.
 * @param {string} options.pageFile - Page filename inside `assetsDir`.
 * @param {string} options.outDir - Where the PNGs are written.
 * @param {Record<string, unknown>} options.settings - Seed settings.
 * @param {Record<string, unknown>} [options.updates] - Update-check answer served at /updates/status.
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
 * @returns {Promise<{written: string[], skipped: SkippedCapture[]}>} The files
 *   written and the tabs skipped, each in tab order.
 */
export async function captureSettingsWindow(options, deps) {
  const {
    assetsDir,
    pageFile,
    outDir,
    settings,
    updates,
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
    // The What's New tab asks the plugin whether a newer version exists (#1016).
    // Answer for the fixture rather than reaching the real website mid-capture.
    updates: updates ? { get: async () => updates } : undefined,
    // External links and plugin commands are inert in a capture: nothing
    // should open a browser or touch a real deck.
    openUrl: async () => {},
    onSendToPlugin: () => {},
  });

  log(`Settings server listening; page at ${server.url.replace(/t=[^&]+/, "t=…")}`);

  /** @type {{port: number, kill: () => void} | undefined} */
  let browser;
  let cdp;
  /** @type {string[]} */
  const written = [];
  /** @type {SkippedCapture[]} */
  const skipped = [];

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

      const images = await waitForPaneImages(cdp, sessionId, delay, tab);
      const file = join(outDir, tab.file);

      // Not captured in either case. A shot with a hole where an image belongs
      // is never one to commit, and writing it would replace the good one that
      // is committed, in a command that is run routinely. The run goes on to
      // the other tabs: one site being unreachable is no reason to lose them.
      if (images !== "loaded") {
        const reason =
          images === "timeout"
            ? `an image had not loaded after ${PANE_IMAGES_TIMEOUT_MS} ms`
            : "an image failed to load";

        skipped.push({ file, label: tab.label, reason });
        log(`Warning: ${reason} on the ${tab.label} tab; ${tab.file} was not captured and is left untouched.`);

        continue;
      }

      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      await writeFile(file, Buffer.from(shot.data, "base64"));
      written.push(file);
      log(`Captured ${tab.label} → ${tab.file}`);
    }
  } finally {
    // Isolated, not sequential: a throw from any one of these would otherwise
    // skip the rest, leaving a headless Chromium running and the settings
    // server holding its port for the life of the process.
    for (const [what, step] of [
      ["close the debugger connection", () => cdp?.close()],
      ["stop the browser", () => browser?.kill()],
      ["stop the settings server", () => server.close()],
    ]) {
      try {
        await step();
      } catch (error) {
        log(`Warning: could not ${what}: ${String(error)}`);
      }
    }
  }

  return { written, skipped };
}
