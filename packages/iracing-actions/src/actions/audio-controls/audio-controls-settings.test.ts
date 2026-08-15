import { describe, expect, it, vi } from "vitest";

import {
  AUDIO_CONTROLS_GLOBAL_KEYS,
  DIAL_CATEGORIES,
  isInternalAudioCategory,
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

  it("keeps the rest of the instance when a dial field holds an unknown value", () => {
    // A dial configured on a newer build (or a hand-edited profile) must not
    // reset the whole instance — only the offending field falls back.
    const s = parseAudioControlsSettings({
      category: "master",
      action: "volume-down",
      dial: { category: "bogus", pressAction: "push-to-talk" },
    });
    expect(s.dial.category).toBe("voice-chat");
    expect(s.dial.pressAction).toBe("push-to-talk");
    expect(s.category).toBe("master");
    expect(s.action).toBe("volume-down");
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

    it("gives every dial category either a full up/down pair or nothing (internal)", () => {
      for (const category of DIAL_CATEGORIES) {
        expect(rotationBindingKeys(category), category).toHaveLength(isInternalAudioCategory(category) ? 0 : 2);
      }
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
  });

  describe("isInternalAudioCategory", () => {
    it("is true only for the plugin-audio categories, on either surface", () => {
      expect(isInternalAudioCategory("race-engineer")).toBe(true);
      expect(isInternalAudioCategory("radar")).toBe(true);
      expect(isInternalAudioCategory("voice-chat")).toBe(false);
      expect(isInternalAudioCategory("master")).toBe(false);
      expect(isInternalAudioCategory("spotter")).toBe(false);
      expect(isInternalAudioCategory("push-to-talk")).toBe(false);
    });
  });
});
