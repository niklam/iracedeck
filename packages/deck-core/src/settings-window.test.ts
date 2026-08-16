import { silentLogger } from "@iracedeck/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSettingsWindowController } from "./settings-window.js";

const PAGE = "<!doctype html><title>t</title>";

function setup() {
  const openUrl = vi.fn(async () => {});
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

  it("releases the port on close() and is safe to close twice", async () => {
    const { controller, spawnApp } = setup();

    await controller.open();
    const url = spawnApp.mock.calls[0]?.[1] as string;

    await controller.close();
    await controller.close();

    await expect(fetch(url)).rejects.toThrow();
  });
});
