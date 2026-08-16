import { describe, expect, it, vi } from "vitest";

import { launchSettingsWindow } from "./settings-window-launcher.js";

const URL = "http://127.0.0.1:61708/?t=abc";

describe("launchSettingsWindow", () => {
  it("opens the URL as a chromeless --app window when a Chromium browser is found", async () => {
    const spawnApp = vi.fn();
    const openUrl = vi.fn(async () => {});

    const result = await launchSettingsWindow({
      url: URL,
      findBrowser: () => "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      spawnApp,
      openUrl,
    });

    expect(spawnApp).toHaveBeenCalledWith("C:/Program Files/Microsoft/Edge/Application/msedge.exe", URL, undefined);
    expect(openUrl).not.toHaveBeenCalled();
    expect(result).toBe("app-window");
  });

  it("falls back to the host's openUrl when no Chromium browser is found", async () => {
    const spawnApp = vi.fn();
    const openUrl = vi.fn(async () => {});

    const result = await launchSettingsWindow({
      url: URL,
      findBrowser: () => undefined,
      spawnApp,
      openUrl,
    });

    expect(spawnApp).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith(URL);
    expect(result).toBe("browser-tab");
  });

  it("falls back to the host's openUrl when spawning the browser throws", async () => {
    const spawnApp = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const openUrl = vi.fn(async () => {});

    const result = await launchSettingsWindow({
      url: URL,
      findBrowser: () => "C:/gone/msedge.exe",
      spawnApp,
      openUrl,
    });

    expect(openUrl).toHaveBeenCalledWith(URL);
    expect(result).toBe("browser-tab");
  });
});
