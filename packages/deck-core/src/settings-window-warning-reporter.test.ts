import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSettingsWindowWarningReporter } from "./settings-window-warning-reporter.js";
import { SETTINGS_WINDOW_OPEN_WARNING_ID, SETTINGS_WINDOW_SERVER_WARNING_ID } from "./settings-window-warning.js";

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

/** Every settings-window record currently posted, whichever id it carries. */
function banners(): Array<{ id: string; level: string; message: string }> {
  const ids: string[] = [SETTINGS_WINDOW_SERVER_WARNING_ID, SETTINGS_WINDOW_OPEN_WARNING_ID];

  return warnings().filter((w) => ids.includes(w.id));
}

describe("createSettingsWindowWarningReporter", () => {
  beforeEach(() => {
    store.current = {};
    updateSpy.mockClear();
  });

  it("posts both banners when the settings service fails to start", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => "C:/x/global-settings.json" });

    report({ stage: "server", ok: false, error: new Error("EADDRINUSE") });

    expect(
      banners()
        .map((w) => w.id)
        .sort(),
    ).toEqual([SETTINGS_WINDOW_OPEN_WARNING_ID, SETTINGS_WINDOW_SERVER_WARNING_ID].sort());
    expect(banners().find((w) => w.id === SETTINGS_WINDOW_SERVER_WARNING_ID)?.message).toContain(
      "C:/x/global-settings.json",
    );
  });

  it("clears both when the service comes up, so nothing stale greets the user", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    report({ stage: "server", ok: false, error: new Error("EADDRINUSE") });
    report({ stage: "server", ok: true });

    expect(banners()).toHaveLength(0);
  });

  it("drops a stale open-failure banner the previous run persisted, once the service starts", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    // `_warnings` is persisted, so last run's failed press is still in the file.
    report({ stage: "open", ok: false, error: new Error("no browser") });
    report({ stage: "server", ok: true });

    expect(banners()).toHaveLength(0);
  });

  it("leaves the page-wide error alone when a single press fails", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    report({ stage: "server", ok: false, error: new Error("EADDRINUSE") });
    report({ stage: "open", ok: false, error: new Error("EADDRINUSE") });

    // An open report speaks only for its own record: the service is still down,
    // and clearing that error would take the accurate explanation off the page.
    expect(banners().some((w) => w.id === SETTINGS_WINDOW_SERVER_WARNING_ID)).toBe(true);
  });

  it("clears only the button banner when a window finally opens", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    report({ stage: "server", ok: true });
    report({ stage: "open", ok: false, error: new Error("no browser") });
    report({ stage: "open", ok: true, launch: "browser-tab" });

    expect(banners()).toHaveLength(0);
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

    expect(banners().find((w) => w.id === SETTINGS_WINDOW_SERVER_WARNING_ID)?.message).toContain(
      "C:/late/global-settings.json",
    );
  });

  it("writes nothing when a success arrives with no banner posted", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    report({ stage: "server", ok: true });

    expect(updateSpy).not.toHaveBeenCalled();
  });
});
