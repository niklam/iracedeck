import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { captureSettingsWindow, createSeedSettingsHost } from "./capture.mjs";

const SIZE = { width: 1172, height: 788 };

/** A CDP double that records commands and answers the two we depend on. */
function createFakeCdp({ missingPane, emitLoadEvent = false, noEvents = false } = {}) {
  const sent = [];
  const listeners = [];
  let listenersAtLoadEvent = 0;

  return {
    sent,
    listeners,
    /** How many listeners were subscribed when the load event was dispatched. */
    get listenersAtLoadEvent() {
      return listenersAtLoadEvent;
    },
    close: vi.fn(),
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

      if (method === "Runtime.evaluate") {
        const found = missingPane ? !params.expression.includes(`"${missingPane}"`) : true;

        return { result: { value: found } };
      }

      if (method === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") };

      return {};
    }),
  };
}

function createDeps(overrides = {}) {
  const cdp = overrides.cdp ?? createFakeCdp();
  const close = vi.fn(async () => {});
  const kill = vi.fn();
  const writeFile = vi.fn(async () => {});

  return {
    cdp,
    close,
    kill,
    writeFile,
    deps: {
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

    const written = await captureSettingsWindow(OPTIONS, deps);

    expect(written).toEqual([join("/out", "general.png"), join("/out", "simhub.png")]);
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

    const clicks = cdp.sent.filter((c) => c.method === "Runtime.evaluate").map((c) => c.params.expression);
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
    const { deps, cdp, kill, close } = createDeps({ cdp: createFakeCdp({ missingPane: "general" }) });

    await expect(captureSettingsWindow(OPTIONS, deps)).rejects.toThrow();

    expect(cdp.close).toHaveBeenCalled();
    expect(kill).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
