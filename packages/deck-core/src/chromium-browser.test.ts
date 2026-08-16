import { describe, expect, it, vi } from "vitest";

import { appWindowArgs, findChromiumBrowser, SETTINGS_WINDOW_SIZE } from "./chromium-browser.js";

describe("appWindowArgs", () => {
  it("opens the URL in app mode with an explicit, sensible window size", () => {
    const args = appWindowArgs("http://127.0.0.1:1/?t=x");

    expect(args).toContain("--app=http://127.0.0.1:1/?t=x");
    expect(args).toContain(`--window-size=${SETTINGS_WINDOW_SIZE.width},${SETTINGS_WINDOW_SIZE.height}`);
  });

  it("uses a size that fits a 1366×768 laptop display with room for the OS chrome", () => {
    expect(SETTINGS_WINDOW_SIZE.width).toBeLessThanOrEqual(1280);
    expect(SETTINGS_WINDOW_SIZE.height).toBeLessThanOrEqual(720);
  });
});

describe("findChromiumBrowser", () => {
  it("prefers the App Paths registry entry when the registry answers", () => {
    const exists = vi.fn(() => true);
    const queryAppPath = vi.fn((exe: string) =>
      exe === "msedge.exe" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : undefined,
    );

    const found = findChromiumBrowser({ exists, queryAppPath, env: {} });

    expect(found).toBe("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
  });

  it("falls back to well-known install paths when the registry has nothing", () => {
    const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
    const exists = vi.fn((p: string) => p === chrome);

    const found = findChromiumBrowser({ exists, queryAppPath: () => undefined, env: {} });

    expect(found).toBe(chrome);
  });

  it("returns undefined when neither the registry nor the filesystem has a browser", () => {
    const found = findChromiumBrowser({ exists: () => false, queryAppPath: () => undefined, env: {} });

    expect(found).toBeUndefined();
  });

  it("ignores a registry answer that points at a file which no longer exists", () => {
    const stale = "C:/gone/msedge.exe";
    const found = findChromiumBrowser({
      exists: (p) => p !== stale,
      queryAppPath: (exe) => (exe === "msedge.exe" ? stale : undefined),
      env: {},
    });

    // Falls through to a well-known path only if that exists — here nothing else does.
    expect(found).not.toBe(stale);
  });
});
