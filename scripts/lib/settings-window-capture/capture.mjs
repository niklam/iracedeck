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

import { CDP_CONNECTION_CLOSED } from "./cdp.mjs";
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

/**
 * The version the window's header prints (`<span class="sw-version">v…</span>`
 * in `settings-window.ejs`), trimmed, or `null` when the page has no such
 * element. Read once before the first shot when the caller names the version
 * the build must carry (#1536).
 *
 * @internal Exported for testing
 */
export const HEADER_VERSION_EXPRESSION = `(() => {
  const element = document.querySelector('.sw-version');
  return element ? element.textContent.trim() : null;
})()`;

/**
 * Refuse a page whose header does not print `v<expectVersion>` (#1536).
 *
 * The stable release captures the committed screenshots right after it bumps
 * the version and rebuilds; a build that missed the bump (a stale turbo hit, a
 * plugin built before the fold) would put the previous version's header and
 * notes on the site. Checking the page itself, rather than the files that fed
 * it, is what proves the shot shows the release.
 *
 * @param {any} cdp
 * @param {string} sessionId
 * @param {string} expectVersion - The bare version, as `3.9.0`.
 * @throws When the header says anything else, is missing, or the page cannot answer.
 */
async function assertHeaderVersion(cdp, sessionId, expectVersion) {
  const expected = `v${expectVersion}`;
  const reply = await cdp.send(
    "Runtime.evaluate",
    { expression: HEADER_VERSION_EXPRESSION, returnByValue: true },
    sessionId,
  );
  const shown = reply?.result?.value;

  if (shown === expected) return;

  const thrown = reply?.exceptionDetails?.exception?.description ?? reply?.exceptionDetails?.text;
  let said;

  if (thrown) said = `the page threw ${thrown} when its header version was read`;
  else if (shown === null) said = `the page has no .sw-version element in its header`;
  else if (typeof shown === "string") said = `its header says ${JSON.stringify(shown)}`;
  else said = `the page answered ${JSON.stringify(shown)} for its header version`;

  throw new Error(
    `The settings page should show ${expected}, but ${said}. The plugin build does not carry the version ` +
      `being captured; rebuild the Stream Deck plugin and capture again. No screenshot was written.`,
  );
}

/**
 * How long `Browser.close` may take to answer before teardown stops waiting for
 * the reply (#1544). The reply is not what decides anything: whether the
 * browser's process has gone is, so a browser that never answers costs this
 * bound and then the wait below, never the life of the process.
 */
export const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

/**
 * How long the browser may take to exit once asked to close before what is
 * left of it is killed (#1544). Headless Edge took about 3 s on the machine
 * #1544 was measured on, flushing its profile first.
 */
export const BROWSER_EXIT_TIMEOUT_MS = 10_000;

/**
 * How long the browser's other processes (crash handler, utility, GPU) may
 * outlive the browser's own before they are killed: any of them can still
 * hold a file in the profile.
 */
export const PROFILE_RELEASE_TIMEOUT_MS = 5_000;

/** How long to wait for the processes killed to be gone. */
export const BROWSER_KILL_TIMEOUT_MS = 5_000;

/** How often the browser's own pid is checked while it is waited for: a signal-0 check costs nothing. */
export const BROWSER_EXIT_POLL_MS = 50;

/**
 * How often the processes naming the profile are listed while they are waited
 * for. One listing is a PowerShell process on Windows, about half a second.
 */
export const PROFILE_PROCESSES_POLL_MS = 1_000;

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
 * Ask the browser which process is its own (#1544).
 *
 * The process the composition root spawned is not necessarily the browser:
 * Edge's `msedge.exe` is a launcher that hands off to the real headless browser
 * and exits, leaving that browser orphaned, so the launcher's pid and handle
 * stop nothing. `SystemInfo.getProcessInfo` reports every process the browser
 * runs, and the one typed `"browser"` is the one whose exit ends the tree.
 *
 * @param {any} cdp
 * @returns {Promise<{pid: number} | {pid: undefined, reason: string}>} The pid,
 *   or why it could not be learned — never a throw, since a capture can still
 *   be taken without it; only teardown's proof that the browser exited is lost.
 */
async function identifyBrowserProcess(cdp) {
  try {
    const reply = await cdp.send("SystemInfo.getProcessInfo");
    const entry = Array.isArray(reply?.processInfo)
      ? reply.processInfo.find((info) => info?.type === "browser")
      : undefined;

    if (Number.isInteger(entry?.id) && entry.id > 0) return { pid: entry.id };

    return { pid: undefined, reason: "SystemInfo.getProcessInfo listed no browser process" };
  } catch (error) {
    return { pid: undefined, reason: `SystemInfo.getProcessInfo failed: ${String(error)}` };
  }
}

/**
 * Wait until `pid` has exited, or the bound is reached, checking through the
 * injected `delay` and counting the time asked for rather than reading a clock,
 * as {@link waitForPaneImages} does.
 *
 * @param {number} pid
 * @param {number} timeoutMs
 * @param {(pid: number) => boolean} processAlive
 * @param {(ms: number) => Promise<void>} delay
 * @returns {Promise<boolean>} Whether the process has gone.
 */
async function waitForProcessExit(pid, timeoutMs, processAlive, delay) {
  for (let waited = 0; ; waited += BROWSER_EXIT_POLL_MS) {
    if (!processAlive(pid)) return true;

    if (waited >= timeoutMs) return false;

    await delay(BROWSER_EXIT_POLL_MS);
  }
}

/**
 * The processes of this run's browser, as its lister last saw them.
 *
 * @typedef {{state: "listed", pids: number[]} | {state: "unknown", reason: string}} ProfileProcesses
 */

/**
 * List the processes naming the profile, turning a lister that throws into
 * "could not tell" — a broken lister must never read as "none left".
 *
 * @param {() => Promise<ProfileProcesses>} listProfileProcesses
 * @returns {Promise<ProfileProcesses>}
 */
async function listSafely(listProfileProcesses) {
  try {
    const listing = await listProfileProcesses();

    if (listing?.state === "listed" && Array.isArray(listing.pids)) return listing;

    if (listing?.state === "unknown") return listing;

    return { state: "unknown", reason: `the process lister answered ${JSON.stringify(listing)}` };
  } catch (error) {
    return { state: "unknown", reason: `the process lister failed: ${String(error)}` };
  }
}

/**
 * List the processes naming the profile until none is left, the lister cannot
 * tell, or the bound is reached, counting the time asked for as
 * {@link waitForProcessExit} does. A bound of 0 lists once.
 *
 * @param {number} timeoutMs
 * @param {() => Promise<ProfileProcesses>} listProfileProcesses
 * @param {(ms: number) => Promise<void>} delay
 * @returns {Promise<ProfileProcesses>} The last listing.
 */
async function waitForProfileRelease(timeoutMs, listProfileProcesses, delay) {
  for (let waited = 0; ; waited += PROFILE_PROCESSES_POLL_MS) {
    const listing = await listSafely(listProfileProcesses);

    if (listing.state !== "listed" || listing.pids.length === 0 || waited >= timeoutMs) return listing;

    await delay(PROFILE_PROCESSES_POLL_MS);
  }
}

/**
 * Send `Browser.close`, bounded, then close the socket whatever it did.
 *
 * The answer is a reason the close may not have worked, or `undefined`.
 * Chromium drops the debugger socket while it handles `Browser.close`, and the
 * command then rejects with {@link CDP_CONNECTION_CLOSED}: that is the browser
 * closing, so it is no problem. A rejection with any other cause is.
 *
 * @param {any} cdp
 * @param {(ms: number) => Promise<void>} delay
 * @param {(message: string) => void} log
 * @returns {Promise<string | undefined>}
 */
async function requestBrowserClose(cdp, delay, log) {
  // Through a `then`, so even a send that throws synchronously becomes a
  // rejection here and cannot skip closing the socket below.
  const reply = Promise.resolve()
    .then(() => cdp.send("Browser.close"))
    .then(
      () => undefined,
      (error) => (error?.code === CDP_CONNECTION_CLOSED ? undefined : `Browser.close failed: ${String(error)}`),
    );
  const timeout = delay(BROWSER_CLOSE_TIMEOUT_MS).then(
    () => `Browser.close had no reply after ${BROWSER_CLOSE_TIMEOUT_MS} ms`,
  );
  const problem = await Promise.race([reply, timeout]);

  try {
    cdp.close();
  } catch (error) {
    log(`Warning: could not close the debugger connection: ${String(error)}`);
  }

  return problem;
}

/**
 * Shut the browser down and prove every process of it has gone (#1544).
 *
 * 1. `Browser.close` over the protocol, because it reaches the browser
 *    whatever process the launcher handed off to and lets it flush and release
 *    its profile; bounded, then the socket is closed.
 * 2. When CDP told us the browser's own pid, it is waited for with a signal-0
 *    check, which costs nothing.
 * 3. The processes naming the profile are listed until none is left. That is
 *    the browser's identity — every process of its tree names this run's
 *    profile, and nothing else does — and it covers what the pid cannot: the
 *    crash handler, utility and GPU processes that can outlive the browser and
 *    hold profile files, and a capture that failed before the pid was learned,
 *    when the launcher's kill (a no-op on Edge's) is all there would be.
 * 4. At the bound, ONLY the pids that listing has just named are killed, each
 *    with its tree, and the listing is waited on again. A bare pid is never
 *    killed: once the browser has gone, Windows can hand its pid to an
 *    unrelated process.
 *
 * The wait in step 3 is as long as there is reason to wait: a short grace for
 * the other processes after the browser's own exited, the full bound when the
 * browser was asked to close but its pid is unknown, and none — one listing —
 * when it was never asked or its pid outlived the bound.
 *
 * A lister that cannot tell degrades to the browser's pid alone, with a
 * Warning that the leftover check could not run; a pid still alive then is
 * named, not killed. Every step that fails is a Warning, and nothing here
 * throws.
 *
 * @param {object} state
 * @param {any} state.cdp - Undefined when the connection was never made.
 * @param {{kill?: () => void} | undefined} state.browser
 * @param {{pid: number | undefined, reason?: string}} state.browserProcess
 * @param {object} deps
 * @param {(pid: number) => boolean} deps.processAlive
 * @param {(pid: number) => Promise<"stopped" | "not-running">} deps.killTree
 * @param {() => Promise<ProfileProcesses>} deps.listProfileProcesses
 * @param {(ms: number) => Promise<void>} deps.delay
 * @param {(message: string) => void} deps.log
 */
async function shutDownBrowser(
  { cdp, browser, browserProcess },
  { processAlive, killTree, listProfileProcesses, delay, log },
) {
  // Nothing was ever started, so there is nothing to look for.
  if (!browser) return;

  const closeProblem = cdp
    ? await requestBrowserClose(cdp, delay, log)
    : "there was no debugger connection to send Browser.close on";
  const { pid } = browserProcess;
  const browserExited =
    pid === undefined ? undefined : await waitForProcessExit(pid, BROWSER_EXIT_TIMEOUT_MS, processAlive, delay);

  let releaseTimeoutMs = 0;

  if (browserExited === true) releaseTimeoutMs = PROFILE_RELEASE_TIMEOUT_MS;
  else if (browserExited === undefined && cdp) releaseTimeoutMs = BROWSER_EXIT_TIMEOUT_MS;

  const leftover = await waitForProfileRelease(releaseTimeoutMs, listProfileProcesses, delay);

  if (leftover.state === "unknown") {
    reportWithoutLister({ browser, browserProcess, browserExited, closeProblem, reason: leftover.reason }, log);

    return;
  }

  if (leftover.pids.length === 0) return;

  let why = closeProblem;

  if (why === undefined) {
    why =
      browserExited === true
        ? `its processes were still running ${releaseTimeoutMs} ms after it exited`
        : `it was still running ${BROWSER_EXIT_TIMEOUT_MS} ms after Browser.close`;
  }

  /** @type {number[]} */
  const killed = [];
  /** @type {{pid: number, error: string}[]} */
  const threw = [];

  for (const listed of leftover.pids) {
    try {
      if ((await killTree(listed)) === "stopped") killed.push(listed);
    } catch (error) {
      threw.push({ pid: listed, error: String(error) });
    }
  }

  const after = await waitForProfileRelease(BROWSER_KILL_TIMEOUT_MS, listProfileProcesses, delay);
  // A kill that threw may still have stopped its process: taskkill `/T`
  // reports a failure for the whole tree when one member refuses — Edge runs
  // a process whose command line cannot even be read — while the browser it
  // was aimed at is gone. The listing after it decides which happened.
  const goneAfter = (pid) => after.state === "listed" && !after.pids.includes(pid);

  for (const { pid } of threw) if (goneAfter(pid)) killed.push(pid);

  const refused = threw.filter(({ pid }) => !goneAfter(pid)).map(({ pid, error }) => `pid ${pid}: ${error}`);
  const partly = threw.filter(({ pid }) => goneAfter(pid)).map(({ pid, error }) => `pid ${pid}: ${error}`);
  const killedClause =
    killed.length > 0
      ? `; killed ${killed.length} process(es) naming its profile (pid ${killed.join(", ")})` +
        (partly.length > 0 ? ` (the kill reported, though they are gone: ${partly.join("; ")})` : "")
      : "";
  const refusedClause = refused.length > 0 ? `; could not kill ${refused.join("; ")}` : "";

  if (after.state === "listed" && after.pids.length === 0) {
    // Every process listed may have gone by itself between the listing and
    // its kill (taskkill's "not found"): then nothing was killed, and the run
    // claims nothing.
    if (killed.length > 0 || refused.length > 0) {
      log(`Warning: the browser did not close cleanly (${why})${killedClause}${refusedClause}.`);
    }

    return;
  }

  const still =
    after.state === "listed"
      ? `${after.pids.length} process(es) naming its profile are still running (pid ${after.pids.join(", ")})`
      : `whether any process naming its profile is still running could not be checked (${after.reason})`;

  log(
    `Warning: the browser did not close cleanly (${why})${killedClause}${refusedClause}, and ${still}. Stop them by hand.`,
  );
}

/**
 * The degraded end of {@link shutDownBrowser}: the processes naming the
 * profile could not be listed, so only the browser's own pid speaks for it.
 * Nothing is killed on a bare pid; one still alive is named for the user. The
 * launcher's own `kill` is still tried when the pid is unknown — it stops a
 * browser that is its own launcher (Chrome) and is a no-op on one that has
 * exited (Edge's), through Node's handle rather than a pid.
 *
 * @param {object} state
 * @param {{kill?: () => void}} state.browser
 * @param {{pid: number | undefined, reason?: string}} state.browserProcess
 * @param {boolean | undefined} state.browserExited
 * @param {string | undefined} state.closeProblem
 * @param {string} state.reason - Why the lister could not tell.
 * @param {(message: string) => void} log
 */
function reportWithoutLister({ browser, browserProcess, browserExited, closeProblem, reason }, log) {
  const { pid } = browserProcess;
  const skipped = `the check for leftover browser processes could not run (${reason})`;
  const closeClause = closeProblem ? `; ${closeProblem}` : "";

  if (browserExited === true) {
    log(`Warning: ${skipped}; the browser (pid ${pid}) exited, but processes of it may still hold its profile.`);

    return;
  }

  if (browserExited === false) {
    log(
      `Warning: ${skipped}, and the browser (pid ${pid}) was still running ${BROWSER_EXIT_TIMEOUT_MS} ms after ` +
        `Browser.close${closeClause}. It was not killed on its pid alone; stop it by hand.`,
    );

    return;
  }

  try {
    browser.kill?.();
  } catch (error) {
    log(`Warning: could not stop the launched browser process: ${String(error)}`);
  }

  log(
    `Warning: ${skipped}, and the browser's own process could not be identified (${browserProcess.reason}), so ` +
      `its exit was not confirmed${closeClause}. A headless browser may still be running.`,
  );
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
 * @param {string} [options.expectVersion] - The bare version (`3.9.0`) the
 *   page's header must print as `v3.9.0`. Checked once the page has loaded and
 *   before the first shot; any other header, or none, throws with nothing
 *   written. Unset, the header is not read.
 * @param {object} deps - Injected collaborators.
 * @param {(opts: object) => Promise<{url: string, close: () => Promise<void>}>} deps.startServer
 * @param {() => Promise<{port: number, kill?: () => void}>} deps.launchBrowser - Starts
 *   the browser and reports its debugging port. `kill` stops the process it
 *   spawned, which may be only a launcher that has already handed off and
 *   exited (Edge's is), so teardown uses it only when neither the browser's
 *   own pid nor the processes naming its profile could be learned.
 * @param {(port: number) => Promise<string>} deps.debuggerUrl
 * @param {(url: string) => Promise<any>} deps.connect
 * @param {(file: string, data: Buffer) => Promise<void>} deps.writeFile
 * @param {(pid: number) => boolean} deps.processAlive - Whether a process
 *   still runs; teardown polls the browser's own pid with it after
 *   `Browser.close`.
 * @param {(pid: number) => Promise<"stopped" | "not-running">} deps.killTree - Kill
 *   a process and its children, saying whether this call stopped it or it had
 *   already gone; teardown calls it only on a pid `listProfileProcesses` has
 *   just named.
 * @param {() => Promise<ProfileProcesses>} deps.listProfileProcesses - Every
 *   process whose command line names this run's browser profile, which is how
 *   teardown recognises the browser's processes; `unknown`, never a throw,
 *   when it cannot tell.
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
    expectVersion,
  } = options;

  // Before anything starts, so a caller's mistake costs no browser: an empty or
  // non-string version could only ever be refused by the page, which would
  // read as a stale build.
  if (expectVersion !== undefined && (typeof expectVersion !== "string" || expectVersion === "")) {
    throw new TypeError(`expectVersion must be a non-empty version string; got ${JSON.stringify(expectVersion)}.`);
  }

  const {
    startServer,
    launchBrowser,
    debuggerUrl,
    connect,
    writeFile,
    processAlive,
    killTree,
    listProfileProcesses,
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

  /** @type {{port: number, kill?: () => void} | undefined} */
  let browser;
  let cdp;
  /** @type {{pid: number | undefined, reason?: string}} */
  let browserProcess = { pid: undefined, reason: "the debugger connection was never made" };
  /** @type {string[]} */
  const written = [];
  /** @type {SkippedCapture[]} */
  const skipped = [];

  try {
    // Inside the try: the server already holds a port, so a browser that fails
    // to launch must still reach `server.close()` in the finally.
    browser = await launchBrowser();
    cdp = await connect(await debuggerUrl(browser.port));
    // Learned now, while the browser is certainly answering, so teardown can
    // prove the browser has gone however the capture itself ends.
    browserProcess = await identifyBrowserProcess(cdp);

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

    // Inside the try, so a refusal still shuts the browser down and stops the
    // server in the finally, like any other failure.
    if (expectVersion !== undefined) await assertHeaderVersion(cdp, sessionId, expectVersion);

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
    // Isolated, not sequential: a throw from either would otherwise skip the
    // other, leaving a headless browser running or the settings server holding
    // its port for the life of the process. The browser goes first: while its
    // exit is waited for, the still-listening server is what keeps the event
    // loop alive under the unref'd delays.
    for (const [what, step] of [
      [
        "shut the browser down",
        () =>
          shutDownBrowser(
            { cdp, browser, browserProcess },
            { processAlive, killTree, listProfileProcesses, delay, log },
          ),
      ],
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
