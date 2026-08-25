import { describe, expect, it } from "vitest";

import { resolveVoicePacksPath } from "./voice-packs-path.js";

describe("resolveVoicePacksPath", () => {
  it("uses LOCALAPPDATA", () => {
    expect(resolveVoicePacksPath({ env: { LOCALAPPDATA: "C:\\Users\\n\\AppData\\Local" } })).toBe(
      "C:\\Users\\n\\AppData\\Local\\iRaceDeck\\Race Engineer\\Voices",
    );
  });

  it("honours the IRACEDECK_VOICE_PACKS_PATH override", () => {
    expect(resolveVoicePacksPath({ env: { LOCALAPPDATA: "C:\\x", IRACEDECK_VOICE_PACKS_PATH: "D:\\packs" } })).toBe(
      "D:\\packs",
    );
  });

  it("treats a blank LOCALAPPDATA as unset and still returns an absolute path", () => {
    const resolved = resolveVoicePacksPath({ env: { LOCALAPPDATA: "   ", USERPROFILE: "C:\\Users\\n" } });

    expect(resolved).toBe("C:\\Users\\n\\AppData\\Local\\iRaceDeck\\Race Engineer\\Voices");
  });

  it("treats a blank override as unset", () => {
    const resolved = resolveVoicePacksPath({ env: { LOCALAPPDATA: "C:\\x", IRACEDECK_VOICE_PACKS_PATH: "  " } });

    expect(resolved).toBe("C:\\x\\iRaceDeck\\Race Engineer\\Voices");
  });

  it("has no ecosystem segment — packs are shared across plugins", () => {
    const resolved = resolveVoicePacksPath({ env: { LOCALAPPDATA: "C:\\x" } });

    expect(resolved).not.toMatch(/Stream Deck|Mirabox|Ulanzi/);
  });
});
