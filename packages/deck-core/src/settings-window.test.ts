import { silentLogger } from "@iracedeck/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSettingsWindowController, SETTINGS_WINDOW_HTML } from "./settings-window.js";

const PAGE = "<!doctype html><title>t</title>";

function setup() {
  const openUrl = vi.fn(async (_url: string) => {});
  const spawnApp = vi.fn();
  const controller = createSettingsWindowController({
    renderPage: () => PAGE,
    findBrowser: () => "C:/edge/msedge.exe",
    spawnApp,
    openUrl,
    logger: silentLogger,
  });

  return { controller, openUrl, spawnApp };
}

let teardown: (() => Promise<void>) | undefined;

afterEach(async () => {
  await teardown?.();
  teardown = undefined;
});

describe("createSettingsWindowController", () => {
  it("starts a server and launches the window on open()", async () => {
    const { controller, spawnApp } = setup();
    teardown = () => controller.close();

    const result = await controller.open();

    expect(result).toBe("app-window");
    expect(spawnApp).toHaveBeenCalledTimes(1);

    const url = spawnApp.mock.calls[0]?.[1] as string;
    const res = await fetch(url);
    expect(res.status).toBe(200);
  });

  it("reuses the running server on a second open() instead of binding another port", async () => {
    const { controller, spawnApp } = setup();
    teardown = () => controller.close();

    await controller.open();
    await controller.open();

    const first = new URL(spawnApp.mock.calls[0]?.[1] as string);
    const second = new URL(spawnApp.mock.calls[1]?.[1] as string);
    expect(second.port).toBe(first.port);
    expect(spawnApp).toHaveBeenCalledTimes(2);
  });

  it("shares one server between two open() calls that overlap the start (no second port, nothing leaked)", async () => {
    const { controller, spawnApp } = setup();
    teardown = () => controller.close();

    await Promise.all([controller.open(), controller.open()]);

    const first = new URL(spawnApp.mock.calls[0]?.[1] as string);
    const second = new URL(spawnApp.mock.calls[1]?.[1] as string);
    expect(second.port).toBe(first.port);
    expect(second.searchParams.get("t")).toBe(first.searchParams.get("t"));
  });

  it("falls back to the host's openUrl when the browser process fails to start asynchronously", async () => {
    const openUrl = vi.fn(async (_url: string) => {});
    const controller = createSettingsWindowController({
      renderPage: () => PAGE,
      findBrowser: () => "C:/blocked/msedge.exe",
      // The real spawner rejects on the child's `error` event (ENOENT/EACCES);
      // that must reach the tab fallback instead of escaping as an uncaught error.
      spawnApp: () => Promise.reject(new Error("spawn EACCES")),
      openUrl,
      logger: silentLogger,
    });
    teardown = () => controller.close();

    expect(await controller.open()).toBe("browser-tab");
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("releases the port on close() and is safe to close twice", async () => {
    const { controller, spawnApp } = setup();

    await controller.open();
    const url = spawnApp.mock.calls[0]?.[1] as string;

    await controller.close();
    await controller.close();

    await expect(fetch(url)).rejects.toThrow();
  });
});

describe("createSettingsWindowController — settings host wiring", () => {
  it("starts the WebSocket fake host bound to the injected settingsHost", async () => {
    const { WebSocket } = await import("ws");
    const openUrl = vi.fn(async (_url: string) => {});
    const controller = createSettingsWindowController({
      renderPage: () => PAGE,
      findBrowser: () => undefined,
      spawnApp: vi.fn(),
      openUrl,
      settingsHost: { read: () => ({ debugLogging: true }), write: vi.fn(), subscribe: () => () => {} },
      logger: silentLogger,
    });
    teardown = () => controller.close();

    await controller.open();
    const url = new URL(openUrl.mock.calls[0]?.[0] as string);
    const ws = new WebSocket(`ws://${url.host}/ws?t=${url.searchParams.get("t")}`);
    await new Promise((r) => ws.once("open", r));

    ws.send(JSON.stringify({ event: "getGlobalSettings" }));
    const reply = await new Promise<Record<string, unknown>>((r) =>
      ws.once("message", (raw) => r(JSON.parse(String(raw)) as Record<string, unknown>)),
    );

    expect(reply).toEqual({ event: "didReceiveGlobalSettings", payload: { settings: { debugLogging: true } } });
    ws.close();
  });
});

describe("createSettingsWindowController — assets dir", () => {
  it("serves the compiled page from assetsDir/pageFile instead of an inline page", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ird-sw-ctrl-"));
    writeFileSync(join(dir, SETTINGS_WINDOW_HTML), "<!doctype html><title>compiled</title>", "utf-8");

    const openUrl = vi.fn(async (_url: string) => {});
    const controller = createSettingsWindowController({
      assetsDir: dir,
      pageFile: SETTINGS_WINDOW_HTML,
      findBrowser: () => undefined,
      spawnApp: vi.fn(),
      openUrl,
      logger: silentLogger,
    });
    teardown = () => controller.close();

    await controller.open();
    const url = openUrl.mock.calls[0]?.[0] as string;

    expect(await (await fetch(url)).text()).toBe("<!doctype html><title>compiled</title>");
  });
});

describe("createSettingsWindowController — plugin-bound extras", () => {
  it("passes the persisted window bounds to the spawner so a resized window reopens where it was", async () => {
    const spawnApp = vi.fn();
    const controller = createSettingsWindowController({
      renderPage: () => PAGE,
      findBrowser: () => "C:/edge/msedge.exe",
      spawnApp,
      openUrl: vi.fn(async (_url: string) => {}),
      getWindowBounds: () => ({ width: 1300, height: 900, x: 40, y: 60 }),
      logger: silentLogger,
    });
    teardown = () => controller.close();

    await controller.open();

    expect(spawnApp).toHaveBeenCalledWith("C:/edge/msedge.exe", expect.any(String), {
      width: 1300,
      height: 900,
      x: 40,
      y: 60,
    });
  });

  it("forwards page sendToPlugin frames and serves the SimHub proxy through the server", async () => {
    const { WebSocket } = await import("ws");
    const onSendToPlugin = vi.fn();
    const openUrl = vi.fn(async (_url: string) => {});
    const controller = createSettingsWindowController({
      renderPage: () => PAGE,
      findBrowser: () => undefined,
      spawnApp: vi.fn(),
      openUrl,
      settingsHost: { read: () => ({}), write: vi.fn(), subscribe: () => () => {} },
      onSendToPlugin,
      simHub: { isReachable: () => true, getRoles: async () => ["A"] },
      logger: silentLogger,
    });
    teardown = () => controller.close();

    await controller.open();
    const url = new URL(openUrl.mock.calls[0]?.[0] as string);
    const cookie = (await fetch(url)).headers.get("set-cookie")?.split(";")[0] ?? "";
    const ws = new WebSocket(`ws://${url.host}/ws?t=${url.searchParams.get("t")}`);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ event: "sendToPlugin", payload: { event: "windowBounds", width: 1, height: 2 } }));
    await vi.waitFor(() => expect(onSendToPlugin).toHaveBeenCalledWith({ event: "windowBounds", width: 1, height: 2 }));
    expect(await (await fetch(`${url.origin}/simhub/roles`, { headers: { cookie } })).json()).toEqual({
      reachable: true,
      roles: ["A"],
    });
    ws.close();
  });
});
