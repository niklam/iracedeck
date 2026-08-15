import { describe, expect, it, vi } from "vitest";

import {
  AUDIO_CONTROLS_GLOBAL_KEYS,
  isInternalDialCategory,
  parseAudioControlsSettings,
  pressBindingKeys,
  resolveRotationBinding,
  rotationBindingKeys,
} from "./audio-controls-settings.js";

// Real zod semantics for the extended schema (defaults + the `dial` prefault).
vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
    CommonSettings: { extend: (shape: never) => z.object(shape).passthrough() },
  };
});

describe("audio-controls settings", () => {
  it("parses empty settings to full defaults including the dial prefault", () => {
    const s = parseAudioControlsSettings({});
    expect(s.category).toBe("push-to-talk");
    expect(s.action).toBe("volume-up");
    expect(s.dial).toEqual({ category: "voice-chat", pressAction: "none" });
  });

  it("parses a missing dial key the same as an empty dial object", () => {
    expect(parseAudioControlsSettings({ category: "master" }).dial).toEqual(
      parseAudioControlsSettings({ category: "master", dial: {} }).dial,
    );
  });

  it("keeps persisted dial fields and defaults the rest", () => {
    const s = parseAudioControlsSettings({ dial: { category: "radar" } });
    expect(s.dial.category).toBe("radar");
    expect(s.dial.pressAction).toBe("none");
  });

  it("falls back to full defaults when the parse fails", () => {
    const s = parseAudioControlsSettings({ dial: { category: "bogus" } });
    expect(s.dial.category).toBe("voice-chat");
  });

  it("accepts the spotter dial category (#809)", () => {
    const s = parseAudioControlsSettings({ dial: { category: "spotter", pressAction: "mute-unmute" } });
    expect(s.dial).toEqual({ category: "spotter", pressAction: "mute-unmute" });
  });

  it("keeps the keypad global-key map intact", () => {
    expect(AUDIO_CONTROLS_GLOBAL_KEYS["push-to-talk"]).toBe("audioControlsPushToTalk");
    expect(AUDIO_CONTROLS_GLOBAL_KEYS["voice-chat-mute"]).toBe("audioVoiceChatMute");
    expect(AUDIO_CONTROLS_GLOBAL_KEYS["master-volume-down"]).toBe("audioMasterVolumeDown");
  });

  describe("rotationBindingKeys", () => {
    it("requires both volume keys for the keybind categories", () => {
      expect(rotationBindingKeys("voice-chat")).toEqual(["audioVoiceChatVolumeUp", "audioVoiceChatVolumeDown"]);
      expect(rotationBindingKeys("master")).toEqual(["audioMasterVolumeUp", "audioMasterVolumeDown"]);
    });

    it("requires the spotter louder + quieter keys for the spotter category (#809)", () => {
      expect(rotationBindingKeys("spotter")).toEqual(["spotterLouder", "spotterQuieter"]);
    });

    it("requires no keys for the internal categories", () => {
      expect(rotationBindingKeys("race-engineer")).toEqual([]);
      expect(rotationBindingKeys("radar")).toEqual([]);
    });
  });

  describe("pressBindingKeys", () => {
    it("requires the PTT key for push-to-talk", () => {
      expect(pressBindingKeys({ category: "master", pressAction: "push-to-talk" })).toEqual([
        "audioControlsPushToTalk",
      ]);
    });

    it("requires the voice-chat mute key only for voice-chat mute", () => {
      expect(pressBindingKeys({ category: "voice-chat", pressAction: "mute-unmute" })).toEqual(["audioVoiceChatMute"]);
      expect(pressBindingKeys({ category: "race-engineer", pressAction: "mute-unmute" })).toEqual([]);
      expect(pressBindingKeys({ category: "radar", pressAction: "mute-unmute" })).toEqual([]);
      expect(pressBindingKeys({ category: "master", pressAction: "mute-unmute" })).toEqual([]);
    });

    it("requires the spotter silence key for spotter mute (#809)", () => {
      expect(pressBindingKeys({ category: "spotter", pressAction: "mute-unmute" })).toEqual(["spotterSilence"]);
    });

    it("requires nothing for none", () => {
      expect(pressBindingKeys({ category: "voice-chat", pressAction: "none" })).toEqual([]);
    });
  });

  describe("resolveRotationBinding", () => {
    it("picks the up key for clockwise and the down key for counter-clockwise ticks", () => {
      expect(resolveRotationBinding("voice-chat", 1)).toBe("audioVoiceChatVolumeUp");
      expect(resolveRotationBinding("voice-chat", -2)).toBe("audioVoiceChatVolumeDown");
      expect(resolveRotationBinding("master", 3)).toBe("audioMasterVolumeUp");
      expect(resolveRotationBinding("master", -1)).toBe("audioMasterVolumeDown");
    });

    it("maps the spotter category to louder / quieter (#809)", () => {
      expect(resolveRotationBinding("spotter", 2)).toBe("spotterLouder");
      expect(resolveRotationBinding("spotter", -1)).toBe("spotterQuieter");
    });

    it("has no binding for the internal categories", () => {
      expect(resolveRotationBinding("race-engineer", 1)).toBeUndefined();
      expect(resolveRotationBinding("radar", -1)).toBeUndefined();
    });
  });

  describe("isInternalDialCategory", () => {
    it("is true only for the plugin-audio categories", () => {
      expect(isInternalDialCategory("race-engineer")).toBe(true);
      expect(isInternalDialCategory("radar")).toBe(true);
      expect(isInternalDialCategory("voice-chat")).toBe(false);
      expect(isInternalDialCategory("master")).toBe(false);
      expect(isInternalDialCategory("spotter")).toBe(false);
    });
  });
});
