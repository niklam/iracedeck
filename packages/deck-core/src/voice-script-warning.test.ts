import { describe, expect, it } from "vitest";

import { evaluateVoiceScriptWarning, VOICE_SCRIPT_WARNING_ID } from "./voice-script-warning.js";

describe("evaluateVoiceScriptWarning", () => {
  it("returns a warning naming the voice when the active voice has no callout script", () => {
    const result = evaluateVoiceScriptWarning({ activeVoice: "laconic", scriptedVoices: new Set(["default"]) });

    expect(result).not.toBeNull();
    expect(result?.id).toBe(VOICE_SCRIPT_WARNING_ID);
    expect(result?.level).toBe("warning");
    // Every callout "that comes from the script", not "stays silent": in
    // 3.2.0 the unscripted families still speak, and the wording must hold
    // after #1065 scripts them too.
    expect(result?.message).toBe(
      'The Race Engineer voice "laconic" has no callout script, so every callout that comes from the script ' +
        "is skipped in it. Reinstall the voice pack, or pick another voice under Race Engineer Voice.",
    );
    expect(result?.message).not.toMatch(/silent/);
  });

  it("returns null when the active voice has a script", () => {
    expect(evaluateVoiceScriptWarning({ activeVoice: "default", scriptedVoices: new Set(["default"]) })).toBeNull();
  });

  it("returns null when there is no active voice — nothing to name, nothing to warn about", () => {
    expect(evaluateVoiceScriptWarning({ activeVoice: null, scriptedVoices: new Set() })).toBeNull();
  });

  it("treats an empty voice id as no active voice rather than naming a blank one", () => {
    expect(evaluateVoiceScriptWarning({ activeVoice: "", scriptedVoices: new Set() })).toBeNull();
  });

  describe("names the voice as a user knows it, never as a composite id (#1144)", () => {
    it("uses the pack's label for the voice when one is known", () => {
      const result = evaluateVoiceScriptWarning({
        activeVoice: "luca::matt",
        scriptedVoices: new Set(),
        labels: { "luca::matt": "Luca's Pack: Matt" },
      });

      expect(result?.message).toContain('voice "Luca\'s Pack: Matt"');
      expect(result?.message).not.toContain("::");
    });

    it("falls back to the voice half of an unlabelled composite id", () => {
      const result = evaluateVoiceScriptWarning({ activeVoice: "luca::matt", scriptedVoices: new Set(), labels: {} });

      expect(result?.message).toContain('voice "matt"');
      expect(result?.message).not.toContain("::");
    });

    it("names a bare id as it is, with or without a label map", () => {
      expect(evaluateVoiceScriptWarning({ activeVoice: "laconic", scriptedVoices: new Set() })?.message).toContain(
        'voice "laconic"',
      );
      expect(
        evaluateVoiceScriptWarning({ activeVoice: "laconic", scriptedVoices: new Set(), labels: {} })?.message,
      ).toContain('voice "laconic"');
    });

    it("still decides on the id — a label changes the wording, not whether to warn", () => {
      expect(
        evaluateVoiceScriptWarning({
          activeVoice: "luca::matt",
          scriptedVoices: new Set(["luca::matt"]),
          labels: { "luca::matt": "Matt" },
        }),
      ).toBeNull();
    });
  });

  it("does not start the message with an emoji — the banner draws its own level icon", () => {
    const result = evaluateVoiceScriptWarning({ activeVoice: "x", scriptedVoices: new Set() });

    expect(result?.message).toMatch(/^[A-Za-z]/);
  });
});
