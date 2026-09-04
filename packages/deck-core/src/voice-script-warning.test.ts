import { describe, expect, it } from "vitest";

import { evaluateVoiceScriptWarning, VOICE_SCRIPT_WARNING_ID } from "./voice-script-warning.js";

describe("evaluateVoiceScriptWarning", () => {
  it("returns a warning naming the voice when the active voice has no callout script", () => {
    const result = evaluateVoiceScriptWarning({ activeVoice: "laconic", scriptedVoices: new Set(["default"]) });

    expect(result).not.toBeNull();
    expect(result?.id).toBe(VOICE_SCRIPT_WARNING_ID);
    expect(result?.level).toBe("warning");
    expect(result?.message).toBe(
      'The Race Engineer voice "laconic" has no callout script, so it will stay silent. ' +
        "Reinstall the voice pack, or pick another voice under Race Engineer Voice.",
    );
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

  it("does not start the message with an emoji — the banner draws its own level icon", () => {
    const result = evaluateVoiceScriptWarning({ activeVoice: "x", scriptedVoices: new Set() });

    expect(result?.message).toMatch(/^[A-Za-z]/);
  });
});
