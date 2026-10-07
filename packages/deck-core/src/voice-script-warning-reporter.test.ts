import { silentLogger } from "@iracedeck/logger";
import {
  _resetGlobalSettings,
  clearWarning,
  createMemorySettingsStore,
  getGlobalSettings,
  initGlobalSettings,
  onGlobalSettingsChange,
  type SettingsHost,
  setWarning,
} from "@iracedeck/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVoiceScriptWarningReporter } from "./voice-script-warning-reporter.js";
import { VOICE_SCRIPT_WARNING_ID } from "./voice-script-warning.js";

/** A deck host that never answers: the memory store is the only source. */
const host: SettingsHost = {
  onDidReceiveGlobalSettings: () => {},
  getGlobalSettings: () => {},
  setGlobalSettings: () => {},
};

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Global-settings writes since the last reset, counted from the cache's own
 * change fan-out: every `updateGlobalSettings` notifies the listeners exactly
 * once, run-scoped `_warnings` included, which never reach the file.
 */
let writes = 0;

function warnings(): Array<{ id: string; level: string; message: string }> {
  const raw = (getGlobalSettings() as Record<string, unknown>)._warnings;

  return typeof raw === "string" ? JSON.parse(raw) : [];
}

describe("createVoiceScriptWarningReporter", () => {
  it("posts the banner through `set` when the active voice has no script", () => {
    const set = vi.fn();
    const clear = vi.fn();
    const report = createVoiceScriptWarningReporter({ set, clear });

    report({ activeVoice: "laconic", scriptedVoices: new Set(["default"]) });

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(VOICE_SCRIPT_WARNING_ID, "warning", expect.stringContaining('"Laconic"'));
    expect(clear).not.toHaveBeenCalled();
  });

  it("clears the banner through `clear` when the active voice has a script", () => {
    const set = vi.fn();
    const clear = vi.fn();
    const report = createVoiceScriptWarningReporter({ set, clear });

    report({ activeVoice: "default", scriptedVoices: new Set(["default"]) });

    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(VOICE_SCRIPT_WARNING_ID);
    expect(set).not.toHaveBeenCalled();
  });

  it("passes the label map through, so the banner names the voice as the dropdown does (#1144)", () => {
    const set = vi.fn();
    const clear = vi.fn();
    const report = createVoiceScriptWarningReporter({ set, clear });

    report({ activeVoice: "luca::matt", scriptedVoices: new Set(), labels: { "luca::matt": "Luca: Matt" } });

    expect(set).toHaveBeenCalledWith(VOICE_SCRIPT_WARNING_ID, "warning", expect.stringContaining('"Luca: Matt"'));
    expect(set).toHaveBeenCalledWith(VOICE_SCRIPT_WARNING_ID, "warning", expect.not.stringContaining("::"));
  });

  it("clears rather than posts when there is no active voice at all", () => {
    const set = vi.fn();
    const clear = vi.fn();
    const report = createVoiceScriptWarningReporter({ set, clear });

    report({ activeVoice: null, scriptedVoices: new Set() });

    expect(clear).toHaveBeenCalledWith(VOICE_SCRIPT_WARNING_ID);
    expect(set).not.toHaveBeenCalled();
  });

  // The real store functions dedupe, so the reporter can be called on every
  // rescan and every voice change without churning global settings.
  //
  // They run over the REAL settings cache (#1365): the warning store lives in
  // `@iracedeck/settings` and reads that package's own cache, which a mock of
  // the package barrel cannot reach.
  describe("with the real warning store", () => {
    beforeEach(async () => {
      _resetGlobalSettings();
      initGlobalSettings(host, silentLogger, createMemorySettingsStore({}));
      await tick();
      writes = 0;
      onGlobalSettingsChange(() => {
        writes += 1;
      });
    });

    afterEach(() => {
      _resetGlobalSettings();
    });

    it("is idempotent: reporting the same missing script twice writes once", () => {
      const report = createVoiceScriptWarningReporter({ set: setWarning, clear: clearWarning });

      report({ activeVoice: "laconic", scriptedVoices: new Set() });
      report({ activeVoice: "laconic", scriptedVoices: new Set() });

      expect(writes).toBe(1);
      expect(warnings().map((w) => w.id)).toEqual([VOICE_SCRIPT_WARNING_ID]);
    });

    it("retires the banner once the voice gains a script, and writes nothing when there was none to retire", () => {
      const report = createVoiceScriptWarningReporter({ set: setWarning, clear: clearWarning });

      report({ activeVoice: "laconic", scriptedVoices: new Set() });
      report({ activeVoice: "laconic", scriptedVoices: new Set(["laconic"]) });

      expect(warnings()).toHaveLength(0);
      expect(writes).toBe(2);

      writes = 0;
      report({ activeVoice: "laconic", scriptedVoices: new Set(["laconic"]) });

      expect(writes).toBe(0);
    });

    it("replaces the record when the user switches to another unscripted voice", () => {
      const report = createVoiceScriptWarningReporter({ set: setWarning, clear: clearWarning });

      report({ activeVoice: "laconic", scriptedVoices: new Set() });
      report({ activeVoice: "gruff", scriptedVoices: new Set() });

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]?.message).toContain('"Gruff"');
    });

    it("leaves other producers' banners alone", () => {
      const report = createVoiceScriptWarningReporter({ set: setWarning, clear: clearWarning });
      setWarning("elevation-mismatch", "warning", "other");

      report({ activeVoice: "laconic", scriptedVoices: new Set() });
      report({ activeVoice: "laconic", scriptedVoices: new Set(["laconic"]) });

      expect(warnings()).toEqual([{ id: "elevation-mismatch", level: "warning", message: "other" }]);
    });
  });
});
