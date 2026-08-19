import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSettingsWindowWarningReporter } from "./settings-window-warning-reporter.js";
import { SETTINGS_WINDOW_WARNING_ID } from "./settings-window-warning.js";

const { store, updateSpy } = vi.hoisted(() => {
  const store = { current: {} as Record<string, unknown> };
  const updateSpy = vi.fn((partial: Record<string, unknown>) => {
    store.current = { ...store.current, ...partial };
  });

  return { store, updateSpy };
});

vi.mock("./global-settings.js", () => ({
  getGlobalSettings: () => store.current,
  updateGlobalSettings: updateSpy,
}));

function warnings(): Array<{ id: string; level: string; message: string }> {
  const raw = store.current._warnings;

  return typeof raw === "string" ? JSON.parse(raw) : [];
}

function banner(): { id: string; level: string; message: string } | undefined {
  return warnings().find((w) => w.id === SETTINGS_WINDOW_WARNING_ID);
}

describe("createSettingsWindowWarningReporter", () => {
  beforeEach(() => {
    store.current = {};
    updateSpy.mockClear();
  });

  it("posts the error banner when the settings server fails to start", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => "C:/x/global-settings.json" });

    report({ stage: "server", ok: false, error: new Error("EADDRINUSE") });

    expect(banner()?.level).toBe("error");
    expect(banner()?.message).toContain("C:/x/global-settings.json");
  });

  it("replaces the server banner rather than stacking a second one when the later failure is the open", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    report({ stage: "server", ok: false, error: new Error("EADDRINUSE") });
    report({ stage: "server", ok: true });
    report({ stage: "open", ok: false, error: new Error("no browser") });

    expect(warnings().filter((w) => w.id === SETTINGS_WINDOW_WARNING_ID)).toHaveLength(1);
    expect(banner()?.level).toBe("warning");
  });

  it("clears the banner once the window opens", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    report({ stage: "open", ok: false, error: new Error("no browser") });
    report({ stage: "server", ok: true });
    report({ stage: "open", ok: true, launch: "browser-tab" });

    expect(banner()).toBeUndefined();
  });

  it("leaves other producers' banners alone", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    store.current._warnings = JSON.stringify([{ id: "elevation-mismatch", level: "warning", message: "other" }]);

    report({ stage: "server", ok: false, error: undefined });
    report({ stage: "server", ok: true });

    expect(warnings()).toEqual([{ id: "elevation-mismatch", level: "warning", message: "other" }]);
  });

  it("reads the store path at report time, so a path resolved after wiring still reaches the banner", () => {
    let path: string | undefined;
    const report = createSettingsWindowWarningReporter({ getStorePath: () => path });

    path = "C:/late/global-settings.json";
    report({ stage: "server", ok: false, error: undefined });

    expect(banner()?.message).toContain("C:/late/global-settings.json");
  });

  it("writes nothing when a success arrives with no banner posted", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    report({ stage: "server", ok: true });

    expect(updateSpy).not.toHaveBeenCalled();
  });
});
