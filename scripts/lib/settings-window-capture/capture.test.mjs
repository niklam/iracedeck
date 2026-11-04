import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_CLOSE_TIMEOUT_MS,
  BROWSER_EXIT_POLL_MS,
  BROWSER_EXIT_TIMEOUT_MS,
  BROWSER_KILL_TIMEOUT_MS,
  captureSettingsWindow,
  createSeedSettingsHost,
  PAGE_LOAD_TIMEOUT_MS,
  PAGE_SETTLE_MS,
  PANE_IMAGES_POLL_MS,
  PANE_IMAGES_STATE_EXPRESSION,
  PANE_IMAGES_TIMEOUT_MS,
  TAB_SETTLE_MS,
} from "./capture.mjs";

const SIZE = { width: 1172, height: 788 };

/**
 * A CDP double that records commands and answers the ones we depend on.
 *
 * By default a pane has no image, as every tab but one. `imagesLoadAfter` gives
 * it one, and is how many times the "where do this pane's images stand?" check
 * answers "loading" before it settles: 0 for an image that had loaded by the
 * first check, Infinity for one that never arrives.
 * `imagesBroken` makes it settle on "broken" — an image whose fetch failed —
 * on every tab, or on the one pane it names.
 * `imagesReply` replaces the whole reply to that check, for a page that cannot
 * answer it at all.
 *
 * `processInfo` is what `SystemInfo.getProcessInfo` lists (the browser is pid
 * 4242 by default; an Error makes the command fail), and `browserClose` how
 * `Browser.close` answers: `"ok"`, `"throw"` or `"hang"`. `close` is recorded
 * among the commands, so the order of the two can be seen.
 */
function createFakeCdp({
  missingPane,
  emitLoadEvent = false,
  noEvents = false,
  imagesLoadAfter,
  imagesBroken = false,
  imagesReply,
  processInfo = [
    { type: "browser", id: BROWSER_PID, cpuTime: 0 },
    { type: "renderer", id: 5150, cpuTime: 0 },
  ],
  browserClose = "ok",
} = {}) {
  const sent = [];
  const listeners = [];
  let listenersAtLoadEvent = 0;
  let imageChecksThisTab = 0;
  let lastClick = "";

  return {
    sent,
    listeners,
    /** How many listeners were subscribed when the load event was dispatched. */
    get listenersAtLoadEvent() {
      return listenersAtLoadEvent;
    },
    close: vi.fn(() => {
      sent.push({ method: "close", params: {} });
    }),
    // `noEvents` models a connection that delivers no protocol events at all;
    // the capture must fall back to its timeout rather than hang.
    onEvent: noEvents
      ? undefined
      : vi.fn((listener) => {
          listeners.push(listener);

          return () => {
            const index = listeners.indexOf(listener);

            if (index >= 0) listeners.splice(index, 1);
          };
        }),
    send: vi.fn(async (method, params) => {
      sent.push({ method, params });

      if (method === "SystemInfo.getProcessInfo") {
        if (processInfo instanceof Error) throw processInfo;

        return { processInfo };
      }

      if (method === "Browser.close") {
        if (browserClose === "throw") throw new Error("The Chromium debugger connection closed unexpectedly");

        if (browserClose === "hang") return new Promise(() => {});

        return {};
      }

      if (method === "Target.createTarget") return { targetId: "T1" };

      if (method === "Target.attachToTarget") return { sessionId: "S1" };

      if (method === "Page.navigate" && emitLoadEvent) {
        // A loopback page can fire its load event before the navigate reply is
        // even processed — the ordering the listener has to survive.
        listenersAtLoadEvent = listeners.length;

        for (const listener of [...listeners]) {
          listener({ method: "Page.loadEventFired", sessionId: "S1", params: {} });
        }
      }

      if (method === "Runtime.evaluate" && params.expression === PANE_IMAGES_STATE_EXPRESSION) {
        imageChecksThisTab += 1;

        if (imagesReply) return imagesReply;

        const broken = imagesBroken === true || (imagesBroken && lastClick.includes(`"${imagesBroken}"`));

        if (broken) return { result: { value: imageChecksThisTab <= (imagesLoadAfter ?? 0) ? "loading" : "broken" } };

        if (imagesLoadAfter === undefined) return { result: { value: "none" } };

        return { result: { value: imageChecksThisTab <= imagesLoadAfter ? "loading" : "loaded" } };
      }

      if (method === "Runtime.evaluate") {
        // A click on a nav button: the next image check belongs to a new tab.
        imageChecksThisTab = 0;
        lastClick = params.expression;

        const found = missingPane ? !params.expression.includes(`"${missingPane}"`) : true;

        return { result: { value: found } };
      }

      if (method === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") };

      return {};
    }),
  };
}

/** The browser's own pid in the fake's process list — never the launcher's. */
const BROWSER_PID = 4242;

/**
 * Deps over a fake CDP. The browser's process is gone at the first check
 * unless `processAlive` is overridden; `kill` is the launcher's.
 */
function createDeps(overrides = {}) {
  const cdp = overrides.cdp ?? createFakeCdp();
  const close = vi.fn(async () => {});
  const kill = vi.fn();
  const writeFile = vi.fn(async () => {});
  const processAlive = vi.fn(() => false);
  const killTree = vi.fn(async () => {});

  return {
    cdp,
    close,
    kill,
    writeFile,
    processAlive,
    killTree,
    deps: {
      processAlive,
      killTree,
      startServer: vi.fn(async () => ({ url: "http://127.0.0.1:1234/?t=secret", close })),
      launchBrowser: vi.fn(async () => ({ port: 9222, kill })),
      debuggerUrl: vi.fn(async () => "ws://127.0.0.1:9222/devtools/browser/x"),
      connect: vi.fn(async () => cdp),
      writeFile,
      delay: async () => {},
      ...overrides.deps,
    },
  };
}

const TABS = [
  { pane: "general", label: "General", file: "general.png", elgatoOnly: false },
  { pane: "simhub", label: "SimHub", file: "simhub.png", elgatoOnly: false },
];

const OPTIONS = {
  assetsDir: "/ui",
  pageFile: "settings-window.html",
  outDir: "/out",
  settings: { a: 1 },
  size: SIZE,
  tabs: TABS,
};

describe("createSeedSettingsHost", () => {
  it("merges writes and notifies subscribers, as the page's echo depends on", () => {
    const host = createSeedSettingsHost({ a: 1 });
    const seen = [];
    host.subscribe((settings) => seen.push(settings));

    host.write({ b: 2 });

    expect(host.read()).toEqual({ a: 1, b: 2 });
    expect(seen).toEqual([{ a: 1, b: 2 }]);
  });

  it("stops notifying after unsubscribe", () => {
    const host = createSeedSettingsHost({});
    const listener = vi.fn();
    host.subscribe(listener)();

    host.write({ a: 1 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not mutate the seed object it was given", () => {
    const seed = { a: 1 };
    createSeedSettingsHost(seed).write({ a: 2 });

    expect(seed).toEqual({ a: 1 });
  });
});

describe("captureSettingsWindow", () => {
  it("writes one screenshot per tab, in order", async () => {
    const { deps, writeFile } = createDeps();

    const { written, skipped } = await captureSettingsWindow(OPTIONS, deps);

    expect(written).toEqual([join("/out", "general.png"), join("/out", "simhub.png")]);
    expect(skipped).toEqual([]);
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile.mock.calls[0][1].toString()).toBe("png");
  });

  it("waits for the page's load event before the first capture", async () => {
    const cdp = createFakeCdp({ emitLoadEvent: true });
    const { deps } = createDeps({ cdp });

    await captureSettingsWindow(OPTIONS, deps);

    // Subscribed BEFORE navigating: a loopback page can fire load before the
    // navigate reply, and a listener attached afterwards would miss it and
    // stall on the fallback timeout every run.
    expect(cdp.listenersAtLoadEvent).toBe(1);
    // …and unsubscribed once it arrived, so nothing is left on the connection.
    expect(cdp.listeners).toHaveLength(0);
  });

  it("still captures when no load event is ever delivered", async () => {
    const { deps, writeFile } = createDeps({ cdp: createFakeCdp({ noEvents: true }) });

    await captureSettingsWindow(OPTIONS, deps);

    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it("closes the server when the browser cannot be launched", async () => {
    const { deps, close } = createDeps();
    deps.launchBrowser = vi.fn(async () => {
      throw new Error("ENOENT");
    });

    await expect(captureSettingsWindow(OPTIONS, deps)).rejects.toThrow(/ENOENT/);
    expect(close).toHaveBeenCalled();
  });

  it("clicks each tab's own nav button rather than un-hiding the pane", async () => {
    const { deps, cdp } = createDeps();

    await captureSettingsWindow(OPTIONS, deps);

    const clicks = cdp.sent
      .filter((c) => c.method === "Runtime.evaluate" && c.params.expression !== PANE_IMAGES_STATE_EXPRESSION)
      .map((c) => c.params.expression);
    expect(clicks).toHaveLength(2);
    expect(clicks[0]).toContain('.sw-nav-item[data-pane="general"]');
    expect(clicks[0]).toContain("button.click()");
  });

  it("emulates the real window size before navigating, so nothing is captured mid-reflow", async () => {
    const { deps, cdp } = createDeps();

    await captureSettingsWindow({ ...OPTIONS, deviceScaleFactor: 2 }, deps);

    const metrics = cdp.sent.findIndex((c) => c.method === "Emulation.setDeviceMetricsOverride");
    const navigate = cdp.sent.findIndex((c) => c.method === "Page.navigate");
    expect(metrics).toBeGreaterThanOrEqual(0);
    expect(metrics).toBeLessThan(navigate);
    expect(cdp.sent[metrics].params).toMatchObject({ width: 1172, height: 788, deviceScaleFactor: 2 });
  });

  it("serves the page with SimHub stubbed and external openers inert", async () => {
    const { deps } = createDeps();

    await captureSettingsWindow(OPTIONS, deps);

    const options = deps.startServer.mock.calls[0][0];
    expect(options.assetsDir).toBe("/ui");
    expect(options.pageFile).toBe("settings-window.html");
    expect(options.simHub.isReachable()).toBe(false);
    await expect(options.simHub.getRoles()).resolves.toEqual([]);
    await expect(options.openUrl("https://example.com")).resolves.toBeUndefined();
  });

  it("fails loudly when a documented tab is missing from the page", async () => {
    const { deps } = createDeps({ cdp: createFakeCdp({ missingPane: "simhub" }) });

    await expect(captureSettingsWindow(OPTIONS, deps)).rejects.toThrow(/no nav button for "simhub"/);
  });

  it("still closes the browser and server when a capture fails", async () => {
    const { deps, cdp, processAlive, close } = createDeps({ cdp: createFakeCdp({ missingPane: "general" }) });

    await expect(captureSettingsWindow(OPTIONS, deps)).rejects.toThrow();

    expect(cdp.sent.map((c) => c.method)).toContain("Browser.close");
    expect(cdp.close).toHaveBeenCalled();
    expect(processAlive).toHaveBeenCalledWith(BROWSER_PID);
    expect(close).toHaveBeenCalled();
  });
});

// The Support iRaceDeck tab's button is an image from another site, fetched
// lazily when the tab is shown (#1303). A fixed pause cannot know when it has
// arrived, so the capture asks the page, and gives up after a bound.
describe("captureSettingsWindow: waiting for a tab's images", () => {
  /** Deps whose `delay` records what it was asked for and returns at once. */
  function createTimedDeps(cdpOptions) {
    const delays = [];
    const log = vi.fn();
    const made = createDeps({
      cdp: createFakeCdp(cdpOptions),
      deps: {
        delay: async (ms) => {
          delays.push(ms);
        },
        log,
      },
    });

    return {
      ...made,
      log,
      /** How many times the capture paused between two image checks. */
      polls: () => delays.filter((ms) => ms === PANE_IMAGES_POLL_MS).length,
      /** How many times it paused for layout or paint to settle on a tab. */
      settles: () => delays.filter((ms) => ms === TAB_SETTLE_MS).length,
      warnings: () => log.mock.calls.map(([message]) => message).filter((message) => message.startsWith("Warning")),
    };
  }

  /** What the page session was asked to do per tab, in order. */
  function steps(cdp) {
    return cdp.sent
      .filter((c) => c.method === "Runtime.evaluate" || c.method === "Page.captureScreenshot")
      .map((c) =>
        c.method === "Page.captureScreenshot"
          ? "screenshot"
          : c.params.expression === PANE_IMAGES_STATE_EXPRESSION
            ? "images?"
            : "click",
      );
  }

  it("polls at an interval no other pause uses, so the counts below count only polls", () => {
    expect([
      TAB_SETTLE_MS,
      PAGE_SETTLE_MS,
      PAGE_LOAD_TIMEOUT_MS,
      BROWSER_EXIT_POLL_MS,
      BROWSER_CLOSE_TIMEOUT_MS,
    ]).not.toContain(PANE_IMAGES_POLL_MS);
    expect(PANE_IMAGES_TIMEOUT_MS % PANE_IMAGES_POLL_MS).toBe(0);
  });

  it("asks about the visible pane's images, whichever tab that is", () => {
    expect(PANE_IMAGES_STATE_EXPRESSION).toContain(".sw-pane:not([hidden]) img");
    expect(PANE_IMAGES_STATE_EXPRESSION).toContain("img.complete");
    // `complete` alone is true for an image whose fetch failed.
    expect(PANE_IMAGES_STATE_EXPRESSION).toContain("img.naturalWidth === 0");
  });

  it("costs one check and no wait on a tab that has no image", async () => {
    const { deps, cdp, polls, settles, warnings, writeFile } = createTimedDeps();

    await captureSettingsWindow(OPTIONS, deps);

    expect(steps(cdp)).toEqual(["click", "images?", "screenshot", "click", "images?", "screenshot"]);
    expect(polls()).toBe(0);
    // The one after each click, and no second one: there is nothing to paint.
    expect(settles()).toBe(TABS.length);
    expect(warnings()).toEqual([]);
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it("settles once more for an image that had loaded by the first check, which may have finished a moment before it", async () => {
    const { deps, cdp, polls, settles, warnings } = createTimedDeps({ imagesLoadAfter: 0 });

    await captureSettingsWindow({ ...OPTIONS, tabs: [TABS[0]] }, deps);

    expect(steps(cdp)).toEqual(["click", "images?", "screenshot"]);
    expect(polls()).toBe(0);
    // After the click, and again after the check that found the image loaded.
    expect(settles()).toBe(2);
    expect(warnings()).toEqual([]);
  });

  it("waits for an image that is still loading, then captures", async () => {
    const { deps, cdp, polls, warnings, writeFile } = createTimedDeps({ imagesLoadAfter: 3 });

    await captureSettingsWindow({ ...OPTIONS, tabs: [TABS[0]] }, deps);

    // Three checks that say no, each followed by a pause, and the screenshot
    // only after the one that says yes.
    expect(steps(cdp)).toEqual(["click", "images?", "images?", "images?", "images?", "screenshot"]);
    expect(polls()).toBe(3);
    expect(warnings()).toEqual([]);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("settles once more after an image it had to wait for, so the shot is not taken on the tick it finished", async () => {
    const delays = [];
    const { deps, cdp } = createDeps({ cdp: createFakeCdp({ imagesLoadAfter: 1 }) });
    deps.delay = async (ms) => {
      // Recorded among the commands, to see the pause land before the screenshot.
      cdp.sent.push({ method: "delay", params: { ms } });
      delays.push(ms);
    };

    await captureSettingsWindow({ ...OPTIONS, tabs: [TABS[0]] }, deps);

    // From the click to the screenshot; teardown's own pause and commands follow it.
    const afterClick = cdp.sent
      .slice(
        cdp.sent.findIndex((c) => c.method === "Runtime.evaluate"),
        cdp.sent.findIndex((c) => c.method === "Page.captureScreenshot") + 1,
      )
      .map((c) =>
        c.method === "delay"
          ? `delay ${c.params.ms}`
          : c.method === "Page.captureScreenshot"
            ? "screenshot"
            : "evaluate",
      );

    expect(afterClick).toEqual([
      "evaluate",
      `delay ${TAB_SETTLE_MS}`,
      "evaluate",
      `delay ${PANE_IMAGES_POLL_MS}`,
      "evaluate",
      `delay ${TAB_SETTLE_MS}`,
      "screenshot",
    ]);
    expect(delays.filter((ms) => ms === TAB_SETTLE_MS)).toHaveLength(2);
  });

  it("gives up at the bound, names the tab, and leaves its screenshot alone", async () => {
    const { deps, cdp, polls, warnings, writeFile } = createTimedDeps({ imagesLoadAfter: Infinity });

    const { written, skipped } = await captureSettingsWindow(OPTIONS, deps);

    // Exactly the bound's worth of pauses per tab, never an endless loop.
    expect(polls()).toBe((PANE_IMAGES_TIMEOUT_MS / PANE_IMAGES_POLL_MS) * TABS.length);
    expect(warnings()).toHaveLength(2);
    expect(warnings()[0]).toMatch(/an image had not loaded after \d+ ms on the General tab/);
    expect(warnings()[0]).toMatch(/general\.png was not captured and is left untouched/);
    expect(warnings()[1]).toMatch(/on the SimHub tab/);
    // Neither taken nor written: the committed file is whatever it was.
    expect(steps(cdp)).not.toContain("screenshot");
    expect(writeFile).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(skipped).toEqual([
      {
        file: join("/out", "general.png"),
        label: "General",
        reason: `an image had not loaded after ${PANE_IMAGES_TIMEOUT_MS} ms`,
      },
      {
        file: join("/out", "simhub.png"),
        label: "SimHub",
        reason: `an image had not loaded after ${PANE_IMAGES_TIMEOUT_MS} ms`,
      },
    ]);
  });

  it("skips a tab whose image failed outright, without waiting, and names it", async () => {
    // Offline, the Support tab's button finishes at once with no picture. That
    // is not "still loading", so no pause is owed, but the shot is not one to
    // commit: it must not replace the one that is.
    const { deps, cdp, polls, warnings, writeFile } = createTimedDeps({ imagesBroken: true });

    const { written, skipped } = await captureSettingsWindow({ ...OPTIONS, tabs: [TABS[0]] }, deps);

    expect(steps(cdp)).toEqual(["click", "images?"]);
    expect(polls()).toBe(0);
    expect(warnings()).toEqual([
      "Warning: an image failed to load on the General tab; general.png was not captured and is left untouched.",
    ]);
    expect(writeFile).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(skipped).toEqual([
      { file: join("/out", "general.png"), label: "General", reason: "an image failed to load" },
    ]);
  });

  it("still captures the tabs after one that was skipped", async () => {
    // One site being unreachable costs that tab's shot, not the run.
    const { deps, writeFile } = createDeps({ cdp: createFakeCdp({ imagesBroken: "general" }) });

    const { written, skipped } = await captureSettingsWindow(OPTIONS, deps);

    expect(skipped.map(({ label }) => label)).toEqual(["General"]);
    expect(written).toEqual([join("/out", "simhub.png")]);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][0]).toBe(join("/out", "simhub.png"));
  });

  describe("a check the page cannot answer", () => {
    it.each([
      [
        "an exception",
        {
          result: { type: "object", subtype: "error" },
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "Error: Execution context was destroyed." },
          },
        },
        /could not say whether the images on the General tab have loaded: it threw Error: Execution context was destroyed\./,
      ],
      [
        "an exception with only its text",
        { result: {}, exceptionDetails: { text: "Uncaught SyntaxError" } },
        /on the General tab have loaded: it threw Uncaught SyntaxError/,
      ],
      ["no value", { result: { type: "undefined" } }, /on the General tab have loaded: it answered undefined/],
      ["no result at all", {}, /on the General tab have loaded: it answered undefined/],
      ["a state it does not have", { result: { value: "ready" } }, /it answered "ready"/],
    ])("is an error naming the tab, not an image still loading: %s", async (_what, imagesReply, message) => {
      const { deps, cdp, polls, writeFile, close } = createTimedDeps({ imagesReply });

      await expect(captureSettingsWindow(OPTIONS, deps)).rejects.toThrow(message);

      // One check, no polling out the bound, nothing written, and cleaned up.
      expect(steps(cdp)).toEqual(["click", "images?"]);
      expect(polls()).toBe(0);
      expect(writeFile).not.toHaveBeenCalled();
      expect(cdp.close).toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
    });
  });
});

// The process spawn() starts can be only a launcher: Edge's hands off to the
// real headless browser and exits, so killing it stopped nothing, the browser
// kept its profile locked, and the profile's removal never finished (#1544).
// Teardown asks the browser itself to close and waits for its own process.
describe("captureSettingsWindow: shutting the browser down", () => {
  /**
   * Deps whose `delay` records what it was asked for and returns at once —
   * bar the wait for Browser.close's reply, which yields to the next macrotask
   * first, as a 5 s timer would lose to an answer that is already on its way.
   */
  function createTeardownDeps({ cdp: cdpOptions, ...overrides } = {}) {
    const delays = [];
    const log = vi.fn();
    const made = createDeps({
      cdp: createFakeCdp(cdpOptions),
      deps: {
        delay: async (ms) => {
          delays.push(ms);

          if (ms === BROWSER_CLOSE_TIMEOUT_MS) await new Promise((resolve) => setImmediate(resolve));
        },
        log,
      },
    });

    Object.assign(made.deps, overrides);

    return {
      ...made,
      log,
      /** How many times teardown paused between two checks of the browser's process. */
      exitPolls: () => delays.filter((ms) => ms === BROWSER_EXIT_POLL_MS).length,
      warnings: () => log.mock.calls.map(([message]) => message).filter((message) => message.startsWith("Warning")),
    };
  }

  it("polls at an interval no capture pause uses, and gives the kill a bound of its own", () => {
    expect([TAB_SETTLE_MS, PAGE_SETTLE_MS, PAGE_LOAD_TIMEOUT_MS, PANE_IMAGES_POLL_MS]).not.toContain(
      BROWSER_EXIT_POLL_MS,
    );
    expect(BROWSER_EXIT_TIMEOUT_MS % BROWSER_EXIT_POLL_MS).toBe(0);
    expect(BROWSER_KILL_TIMEOUT_MS % BROWSER_EXIT_POLL_MS).toBe(0);
  });

  it("learns the browser's own process as soon as it is connected", async () => {
    const { deps, cdp } = createTeardownDeps();

    await captureSettingsWindow(OPTIONS, deps);

    const methods = cdp.sent.map((c) => c.method);
    expect(methods[0]).toBe("SystemInfo.getProcessInfo");
    expect(methods.indexOf("SystemInfo.getProcessInfo")).toBeLessThan(methods.indexOf("Target.createTarget"));
  });

  it("sends Browser.close before closing the socket, and nothing after it", async () => {
    const { deps, cdp } = createTeardownDeps();

    await captureSettingsWindow(OPTIONS, deps);

    expect(cdp.sent.map((c) => c.method).slice(-2)).toEqual(["Browser.close", "close"]);
    expect(cdp.close).toHaveBeenCalledTimes(1);
  });

  it("waits for the browser's own process to exit before stopping the server", async () => {
    const order = [];
    let checks = 0;
    const processAlive = vi.fn((pid) => {
      order.push(`alive? ${pid}`);
      checks += 1;

      return checks <= 3;
    });
    const { deps, close, killTree, kill, exitPolls, warnings } = createTeardownDeps({ processAlive });
    close.mockImplementation(async () => {
      order.push("server.close");
    });

    await captureSettingsWindow(OPTIONS, deps);

    // The browser's pid from getProcessInfo, never the launcher's.
    expect(processAlive.mock.calls.every(([pid]) => pid === BROWSER_PID)).toBe(true);
    expect(order).toEqual([...Array(4).fill(`alive? ${BROWSER_PID}`), "server.close"]);
    expect(exitPolls()).toBe(3);
    expect(killTree).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(warnings()).toEqual([]);
  });

  it("kills the real browser's tree when it outlives the bound, and says so", async () => {
    let killed = false;
    const processAlive = vi.fn(() => !killed);
    const killTree = vi.fn(async () => {
      killed = true;
    });
    const { deps, kill, close, exitPolls, warnings } = createTeardownDeps({ processAlive, killTree });

    await captureSettingsWindow(OPTIONS, deps);

    // Exactly the bound's worth of waiting, then the kill, aimed at the browser.
    expect(exitPolls()).toBe(BROWSER_EXIT_TIMEOUT_MS / BROWSER_EXIT_POLL_MS);
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(killTree).toHaveBeenCalledWith(BROWSER_PID);
    expect(kill).not.toHaveBeenCalled();
    expect(warnings()).toEqual([
      `Warning: the browser (pid ${BROWSER_PID}) did not close cleanly (it had not exited ` +
        `${BROWSER_EXIT_TIMEOUT_MS} ms after Browser.close), so its process tree was killed.`,
    ]);
    expect(close).toHaveBeenCalled();
  });

  it("names a browser that survives even the kill, and still stops the server", async () => {
    const processAlive = vi.fn(() => true);
    const killTree = vi.fn(async () => {
      throw new Error("Access is denied.");
    });
    const { deps, close, exitPolls, warnings } = createTeardownDeps({ processAlive, killTree });

    await captureSettingsWindow(OPTIONS, deps);

    // Both waits run to their bounds and no further.
    expect(exitPolls()).toBe((BROWSER_EXIT_TIMEOUT_MS + BROWSER_KILL_TIMEOUT_MS) / BROWSER_EXIT_POLL_MS);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(new RegExp(`the browser \\(pid ${BROWSER_PID}\\) is still running`));
    expect(warnings()[0]).toMatch(/killing it failed: Error: Access is denied\./);
    expect(close).toHaveBeenCalled();
  });

  it("still closes the socket and the server when Browser.close throws on a dead socket", async () => {
    const { deps, cdp, close, processAlive, warnings } = createTeardownDeps({ cdp: { browserClose: "throw" } });

    await captureSettingsWindow(OPTIONS, deps);

    expect(cdp.close).toHaveBeenCalled();
    expect(processAlive).toHaveBeenCalledWith(BROWSER_PID);
    // The browser went anyway, so a failed request to close is no news.
    expect(warnings()).toEqual([]);
    expect(close).toHaveBeenCalled();
  });

  it("reports why Browser.close failed when the browser then has to be killed", async () => {
    let killed = false;
    const { deps, warnings } = createTeardownDeps({
      cdp: { browserClose: "throw" },
      processAlive: () => !killed,
      killTree: async () => {
        killed = true;
      },
    });

    await captureSettingsWindow(OPTIONS, deps);

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(/did not close cleanly \(Browser\.close failed: Error: The Chromium debugger/);
  });

  it("does not wait on a Browser.close that never answers", async () => {
    const { deps, cdp, close, processAlive } = createTeardownDeps({ cdp: { browserClose: "hang" } });

    await captureSettingsWindow(OPTIONS, deps);

    expect(cdp.close).toHaveBeenCalled();
    expect(processAlive).toHaveBeenCalledWith(BROWSER_PID);
    expect(close).toHaveBeenCalled();
  });

  it("still stops the server when closing the socket throws too", async () => {
    const cdp = createFakeCdp({ browserClose: "throw" });
    cdp.close.mockImplementation(() => {
      throw new Error("socket already gone");
    });
    const log = vi.fn();
    const { deps, close } = createDeps({ cdp, deps: { log } });

    await captureSettingsWindow(OPTIONS, deps);

    expect(log).toHaveBeenCalledWith("Warning: could not close the debugger connection: Error: socket already gone");
    expect(close).toHaveBeenCalled();
  });

  // Without the browser's pid there is nothing to wait on: the capture is still
  // taken, Browser.close still sent, and the launcher's own kill (right for a
  // browser that is its own launcher, a no-op for one that has exited) is all
  // that is left. The run says the exit was not confirmed.
  it.each([
    ["the command fails", new Error("SystemInfo.getProcessInfo was not found"), /SystemInfo\.getProcessInfo failed/],
    ["it lists no browser", [{ type: "renderer", id: 5150 }], /listed no browser process/],
  ])("degrades to the launcher's kill when %s", async (_what, processInfo, reason) => {
    const { deps, cdp, kill, close, processAlive, killTree, writeFile, warnings } = createTeardownDeps({
      cdp: { processInfo },
    });

    await captureSettingsWindow(OPTIONS, deps);

    expect(writeFile).toHaveBeenCalledTimes(TABS.length);
    expect(cdp.sent.map((c) => c.method).slice(-2)).toEqual(["Browser.close", "close"]);
    expect(kill).toHaveBeenCalled();
    expect(processAlive).not.toHaveBeenCalled();
    expect(killTree).not.toHaveBeenCalled();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(reason);
    expect(warnings()[0]).toMatch(/its exit was not confirmed/);
    expect(close).toHaveBeenCalled();
  });

  it("falls back to the launcher's kill when the debugger never connected", async () => {
    const { deps, kill, close, warnings } = createTeardownDeps({
      connect: vi.fn(async () => {
        throw new Error("Could not connect to the Chromium debugger");
      }),
    });

    await expect(captureSettingsWindow(OPTIONS, deps)).rejects.toThrow(/Could not connect/);

    expect(kill).toHaveBeenCalled();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(/the debugger connection was never made/);
    expect(warnings()[0]).toMatch(/there was no debugger connection to send Browser\.close on/);
    expect(close).toHaveBeenCalled();
  });

  it("has nothing to stop, and says nothing, when the browser never launched", async () => {
    const { deps, close, warnings } = createTeardownDeps({
      launchBrowser: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    });

    await expect(captureSettingsWindow(OPTIONS, deps)).rejects.toThrow(/ENOENT/);

    expect(warnings()).toEqual([]);
    expect(close).toHaveBeenCalled();
  });
});
