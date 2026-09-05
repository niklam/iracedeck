import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearWarning, setWarning } from "./pi-warnings.js";
import { createVoiceScriptWarningReporter } from "./voice-script-warning-reporter.js";
import { VOICE_SCRIPT_WARNING_ID } from "./voice-script-warning.js";

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

describe("createVoiceScriptWarningReporter", () => {
  beforeEach(() => {
    store.current = {};
    updateSpy.mockClear();
  });

  it("posts the banner through `set` when the active voice has no script", () => {
    const set = vi.fn();
    const clear = vi.fn();
    const report = createVoiceScriptWarningReporter({ set, clear });

    report({ activeVoice: "laconic", scriptedVoices: new Set(["default"]) });

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(VOICE_SCRIPT_WARNING_ID, "warning", expect.stringContaining('"laconic"'));
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
  describe("with the real warning store", () => {
    it("is idempotent: reporting the same missing script twice writes once", () => {
      const report = createVoiceScriptWarningReporter({ set: setWarning, clear: clearWarning });

      report({ activeVoice: "laconic", scriptedVoices: new Set() });
      report({ activeVoice: "laconic", scriptedVoices: new Set() });

      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(warnings().map((w) => w.id)).toEqual([VOICE_SCRIPT_WARNING_ID]);
    });

    it("retires the banner once the voice gains a script, and writes nothing when there was none to retire", () => {
      const report = createVoiceScriptWarningReporter({ set: setWarning, clear: clearWarning });

      report({ activeVoice: "laconic", scriptedVoices: new Set() });
      report({ activeVoice: "laconic", scriptedVoices: new Set(["laconic"]) });

      expect(warnings()).toHaveLength(0);
      expect(updateSpy).toHaveBeenCalledTimes(2);

      updateSpy.mockClear();
      report({ activeVoice: "laconic", scriptedVoices: new Set(["laconic"]) });

      expect(updateSpy).not.toHaveBeenCalled();
    });

    it("replaces the record when the user switches to another unscripted voice", () => {
      const report = createVoiceScriptWarningReporter({ set: setWarning, clear: clearWarning });

      report({ activeVoice: "laconic", scriptedVoices: new Set() });
      report({ activeVoice: "gruff", scriptedVoices: new Set() });

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]?.message).toContain('"gruff"');
    });

    it("leaves other producers' banners alone", () => {
      const report = createVoiceScriptWarningReporter({ set: setWarning, clear: clearWarning });
      store.current._warnings = JSON.stringify([{ id: "elevation-mismatch", level: "warning", message: "other" }]);

      report({ activeVoice: "laconic", scriptedVoices: new Set() });
      report({ activeVoice: "laconic", scriptedVoices: new Set(["laconic"]) });

      expect(warnings()).toEqual([{ id: "elevation-mismatch", level: "warning", message: "other" }]);
    });
  });
});
