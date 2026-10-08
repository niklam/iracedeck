import { SETTINGS_WINDOW_OPEN_WARNING_ID, SETTINGS_WINDOW_SERVER_WARNING_ID } from "@iracedeck/app-constants";
import { silentLogger } from "@iracedeck/logger";
import {
  _resetGlobalSettings,
  createMemorySettingsStore,
  getGlobalSettings,
  initGlobalSettings,
  onGlobalSettingsChange,
  type SettingsHost,
  setWarning,
} from "@iracedeck/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSettingsWindowWarningReporter } from "./settings-window-warning-reporter.js";

// The reporter runs over the REAL settings cache (#1365): the warning store it
// writes through lives in `@iracedeck/settings` and reads that package's own
// cache, which a mock of the package barrel cannot reach.

/** A deck host that never answers: the memory store is the only source. */
const host: SettingsHost = {
  onDidReceiveGlobalSettings: () => {},
  getGlobalSettings: () => {},
  setGlobalSettings: () => {},
};

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Counts global-settings writes since the last reset from the cache's own
 * change fan-out: every `updateGlobalSettings` notifies the listeners exactly
 * once, run-scoped `_warnings` included, which never reach the file.
 */
const listener = vi.fn();

function warnings(): Array<{ id: string; level: string; message: string }> {
  const raw = (getGlobalSettings() as Record<string, unknown>)._warnings;

  return typeof raw === "string" ? JSON.parse(raw) : [];
}

/** Every settings-window record currently posted, whichever id it carries. */
function banners(): Array<{ id: string; level: string; message: string }> {
  const ids: string[] = [SETTINGS_WINDOW_SERVER_WARNING_ID, SETTINGS_WINDOW_OPEN_WARNING_ID];

  return warnings().filter((w) => ids.includes(w.id));
}

describe("createSettingsWindowWarningReporter", () => {
  beforeEach(async () => {
    _resetGlobalSettings();
    initGlobalSettings(host, silentLogger, createMemorySettingsStore({}));
    await tick();
    listener.mockClear();
    onGlobalSettingsChange(listener);
  });

  afterEach(() => {
    _resetGlobalSettings();
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

  it("drops an open-failure banner from an earlier press, once the service starts", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    // A press that failed earlier in THIS run: warnings never carry over from a
    // previous one (`_warnings` is run-scoped, #1014).
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

    setWarning("elevation-mismatch", "warning", "other");

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

  it("posts both banners in a SINGLE global-settings write", () => {
    // Each write is a store persist plus a synchronous fan-out to every
    // onGlobalSettingsChange listener, and this runs at the moment the plugin
    // has just failed to start a service.
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    report({ stage: "server", ok: false, error: new Error("EADDRINUSE") });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the same failure is reported again", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    report({ stage: "server", ok: false, error: new Error("EADDRINUSE") });
    listener.mockClear();
    report({ stage: "server", ok: false, error: new Error("EADDRINUSE") });

    expect(listener).not.toHaveBeenCalled();
  });

  it("writes nothing when a success arrives with no banner posted", () => {
    const report = createSettingsWindowWarningReporter({ getStorePath: () => undefined });

    report({ stage: "server", ok: true });

    expect(listener).not.toHaveBeenCalled();
  });
});
