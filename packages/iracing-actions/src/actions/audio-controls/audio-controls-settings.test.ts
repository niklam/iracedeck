import { describe, expect, it, vi } from "vitest";

import {
  AUDIO_CONTROLS_GLOBAL_KEYS,
  parseAudioControlsSettings,
  pressBindingKeys,
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

    it("requires nothing for none", () => {
      expect(pressBindingKeys({ category: "voice-chat", pressAction: "none" })).toEqual([]);
    });
  });
});
