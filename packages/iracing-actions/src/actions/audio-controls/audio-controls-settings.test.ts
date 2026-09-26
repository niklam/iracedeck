import { describe, expect, it, vi } from "vitest";

import {
  AUDIO_CONTROLS_GLOBAL_KEYS,
  DIAL_CATEGORIES,
  DIAL_MUTE_BINDINGS,
  DIAL_MUTE_DRIVER_BINDINGS,
  DIAL_PRESS_ACTIONS,
  DIAL_SKIP_CALL_BINDINGS,
  dialMuteBindingMap,
  dialMuteDriverBindingMap,
  dialSkipCallBindingMap,
  isInternalAudioCategory,
  parseAudioControlsSettings,
  pressBindingKeys,
  resolveRotationBinding,
  rotationBindingKeys,
  VOICE_CHAT_MUTE_DRIVER_KEY,
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

  it("falls back to full defaults when the object itself can't be parsed", () => {
    // The per-field .catch guards the action's own enums; a non-object (or a
    // malformed CommonSettings field) still fails the parse outright, and the
    // action must keep working on defaults rather than throw.
    const s = parseAudioControlsSettings("not an object");
    expect(s.category).toBe("push-to-talk");
    expect(s.action).toBe("volume-up");
    expect(s.dial).toEqual({ category: "voice-chat", pressAction: "none" });
  });

  it("keeps persisted dial fields and defaults the rest", () => {
    const s = parseAudioControlsSettings({ dial: { category: "radar" } });
    expect(s.dial.category).toBe("radar");
    expect(s.dial.pressAction).toBe("none");
  });

  it("keeps the rest of the instance when a keypad field holds an unknown value", () => {
    // The two surfaces share one settings blob: an unrecognized keypad value
    // (e.g. a profile written by a newer build) must not wipe the dial half.
    const s = parseAudioControlsSettings({
      category: "not-a-category",
      dial: { category: "spotter", pressAction: "skip-call" },
    });
    expect(s.category).toBe("push-to-talk");
    expect(s.dial.category).toBe("spotter");
    expect(s.dial.pressAction).toBe("skip-call");
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
    const s = parseAudioControlsSettings({ dial: { category: "spotter", pressAction: "skip-call" } });
    expect(s.dial).toEqual({ category: "spotter", pressAction: "skip-call" });
  });

  it("keeps the keypad global-key map intact", () => {
    expect(AUDIO_CONTROLS_GLOBAL_KEYS["push-to-talk"]).toBe("audioControlsPushToTalk");
    expect(AUDIO_CONTROLS_GLOBAL_KEYS["voice-chat-mute"]).toBe("audioVoiceChatMute");
    expect(AUDIO_CONTROLS_GLOBAL_KEYS["master-volume-down"]).toBe("audioMasterVolumeDown");
  });

  describe("Mute a Driver (#863)", () => {
    it("parses mute-driver on the keypad action axis", () => {
      const s = parseAudioControlsSettings({ category: "voice-chat", action: "mute-driver" });
      expect(s.category).toBe("voice-chat");
      expect(s.action).toBe("mute-driver");
    });

    it("parses mute-driver on the dial press axis", () => {
      expect(DIAL_PRESS_ACTIONS).toContain("mute-driver");
      const s = parseAudioControlsSettings({ dial: { category: "voice-chat", pressAction: "mute-driver" } });
      expect(s.dial).toEqual({ category: "voice-chat", pressAction: "mute-driver" });
    });

    it("keeps per-field .catch degradation around the new value on both axes", () => {
      // An unknown keypad action degrades only that field; the dial press
      // holding the new value survives — and vice versa.
      const keypadBad = parseAudioControlsSettings({
        category: "voice-chat",
        action: "not-an-action",
        dial: { category: "voice-chat", pressAction: "mute-driver" },
      });
      expect(keypadBad.action).toBe("volume-up");
      expect(keypadBad.dial.pressAction).toBe("mute-driver");

      const dialBad = parseAudioControlsSettings({
        category: "voice-chat",
        action: "mute-driver",
        dial: { category: "voice-chat", pressAction: "not-a-press" },
      });
      expect(dialBad.action).toBe("mute-driver");
      expect(dialBad.dial.pressAction).toBe("none");
    });

    it("maps the keypad voice-chat-mute-driver key to the new binding", () => {
      expect(VOICE_CHAT_MUTE_DRIVER_KEY).toBe("audioVoiceChatMuteDriver");
      expect(AUDIO_CONTROLS_GLOBAL_KEYS["voice-chat-mute-driver"]).toBe("audioVoiceChatMuteDriver");
      // No other category has a per-driver mute.
      expect(AUDIO_CONTROLS_GLOBAL_KEYS["master-mute-driver"]).toBeUndefined();
    });

    it("keeps the driver-mute table symmetric with the mute table's shape and offers it for voice chat only", () => {
      expect(DIAL_MUTE_DRIVER_BINDINGS).toEqual({ "voice-chat": "audioVoiceChatMuteDriver" });
      expect(dialMuteDriverBindingMap()).toEqual({ "voice-chat": "audioVoiceChatMuteDriver" });
      expect(dialMuteDriverBindingMap().spotter).toBeUndefined();
    });
  });

  describe("Skip Spotter Call (#1015)", () => {
    it("parses skip-call on the dial press axis", () => {
      expect(DIAL_PRESS_ACTIONS).toContain("skip-call");
      const s = parseAudioControlsSettings({ dial: { category: "spotter", pressAction: "skip-call" } });
      expect(s.dial).toEqual({ category: "spotter", pressAction: "skip-call" });
    });

    it("offers skip-call for spotter only, bound to iRacing's Spotter Silence", () => {
      expect(DIAL_SKIP_CALL_BINDINGS).toEqual({ spotter: "spotterSilence" });
      expect(dialSkipCallBindingMap()).toEqual({ spotter: "spotterSilence" });
    });

    it("no longer offers Mute / Unmute for spotter — the silence binding is not a mute", () => {
      expect(DIAL_MUTE_BINDINGS.spotter).toBeUndefined();
      expect(dialMuteBindingMap()).toEqual({ "voice-chat": "audioVoiceChatMute" });
    });
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

    it("requires the spotter silence key for spotter Skip Spotter Call and nothing elsewhere (#1015)", () => {
      expect(pressBindingKeys({ category: "spotter", pressAction: "skip-call" })).toEqual(["spotterSilence"]);
      // Fail-soft: a category with no skip-call binding (a stale value).
      expect(pressBindingKeys({ category: "voice-chat", pressAction: "skip-call" })).toEqual([]);
      expect(pressBindingKeys({ category: "master", pressAction: "skip-call" })).toEqual([]);
      expect(pressBindingKeys({ category: "race-engineer", pressAction: "skip-call" })).toEqual([]);
      expect(pressBindingKeys({ category: "radar", pressAction: "skip-call" })).toEqual([]);
    });

    it("no longer resolves a binding for spotter Mute / Unmute (#1015)", () => {
      expect(pressBindingKeys({ category: "spotter", pressAction: "mute-unmute" })).toEqual([]);
    });

    it("requires nothing for none", () => {
      expect(pressBindingKeys({ category: "voice-chat", pressAction: "none" })).toEqual([]);
    });

    it("requires the driver-mute key for voice-chat Mute a Driver and nothing elsewhere (#863)", () => {
      expect(pressBindingKeys({ category: "voice-chat", pressAction: "mute-driver" })).toEqual([
        "audioVoiceChatMuteDriver",
      ]);
      // Fail-soft: a category with no driver mute (a stale persisted value)
      // needs no binding rather than throwing into the strip render.
      expect(pressBindingKeys({ category: "master", pressAction: "mute-driver" })).toEqual([]);
      expect(pressBindingKeys({ category: "spotter", pressAction: "mute-driver" })).toEqual([]);
      expect(pressBindingKeys({ category: "race-engineer", pressAction: "mute-driver" })).toEqual([]);
      expect(pressBindingKeys({ category: "radar", pressAction: "mute-driver" })).toEqual([]);
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
