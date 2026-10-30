import { beforeEach, describe, expect, it, vi } from "vitest";

import { playPressSound, PRESS_SOUND_CLIPS } from "./press-sounds.js";
import { VOLUME_TICK_FLOOR } from "./volume-tick.js";

const hoisted = vi.hoisted(() => {
  const playOnChannelAtLevel = vi.fn((_channel: number, _path: string, _level: number) => true);
  const getAudio = vi.fn(() => ({ playOnChannelAtLevel }));
  const isConnected = vi.fn(() => true);
  let globalSettings: Record<string, unknown> = {};

  return {
    playOnChannelAtLevel,
    getAudio,
    isConnected,
    getGlobalSettings: vi.fn(() => globalSettings),
    setGlobalSettings: (next: Record<string, unknown>) => {
      globalSettings = next;
    },
  };
});

vi.mock("@iracedeck/audio-service", () => ({
  AudioChannel: { Ambient: 0, SFX: 1, Voice: 2, Radar: 3, Feedback: 4 },
  getAudio: hoisted.getAudio,
}));

vi.mock("@iracedeck/deck-core", () => ({
  getSimConnection: () => ({ isConnected: hoisted.isConnected }),
}));

vi.mock("@iracedeck/settings", () => ({
  getGlobalSettings: hoisted.getGlobalSettings,
}));

const FEEDBACK = 4;

describe("press sounds player (#269)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.isConnected.mockReturnValue(true);
    hoisted.setGlobalSettings({ radarVolume: 60 });
  });

  describe("clips", () => {
    it("names the click and the bleep as WAVs at the sfx root", () => {
      expect(PRESS_SOUND_CLIPS).toEqual({ tap: "sfx/IRD-press-tap.wav", long: "sfx/IRD-press-long.wav" });
    });

    it("plays the click for a tap and the bleep for a long press, on the Feedback channel", () => {
      playPressSound("tap");
      playPressSound("long");

      expect(hoisted.playOnChannelAtLevel.mock.calls).toEqual([
        [FEEDBACK, "sfx/IRD-press-tap.wav", 0.6],
        [FEEDBACK, "sfx/IRD-press-long.wav", 0.6],
      ]);
    });
  });

  describe("level", () => {
    it("follows Radar Volume above the floor, read at each play", () => {
      hoisted.setGlobalSettings({ radarVolume: 85 });
      playPressSound("tap");

      hoisted.setGlobalSettings({ radarVolume: 35 });
      playPressSound("tap");

      expect(hoisted.playOnChannelAtLevel.mock.calls.map(([, , level]) => level)).toEqual([0.85, 0.35]);
    });

    it("plays at the tick's floor at Radar Volume 0, and below the floor", () => {
      expect(VOLUME_TICK_FLOOR).toBe(20);

      hoisted.setGlobalSettings({ radarVolume: 0 });
      playPressSound("tap");

      hoisted.setGlobalSettings({ radarVolume: 10 });
      playPressSound("long");

      expect(hoisted.playOnChannelAtLevel.mock.calls).toEqual([
        [FEEDBACK, "sfx/IRD-press-tap.wav", 0.2],
        [FEEDBACK, "sfx/IRD-press-long.wav", 0.2],
      ]);
    });

    it("plays at full volume while Radar Volume is not loaded yet", () => {
      hoisted.setGlobalSettings({});
      playPressSound("tap");

      expect(hoisted.playOnChannelAtLevel).toHaveBeenCalledWith(FEEDBACK, "sfx/IRD-press-tap.wav", 1);
    });
  });

  describe("gates", () => {
    it("plays while the sim is disconnected: the wrapper owns that gate, not the player", () => {
      hoisted.isConnected.mockReturnValue(false);

      playPressSound("tap");

      expect(hoisted.playOnChannelAtLevel).toHaveBeenCalledTimes(1);
      expect(hoisted.isConnected).not.toHaveBeenCalled();
    });

    it("reads no press sound mode", () => {
      hoisted.setGlobalSettings({ radarVolume: 60, pressSound: "none" });

      playPressSound("long");

      expect(hoisted.playOnChannelAtLevel).toHaveBeenCalledWith(FEEDBACK, "sfx/IRD-press-long.wav", 0.6);
    });
  });

  describe("faults", () => {
    it("swallows an audio service that is not initialized yet", () => {
      hoisted.getAudio.mockImplementationOnce(() => {
        throw new Error("Audio service not initialized");
      });

      expect(() => playPressSound("tap")).not.toThrow();
    });

    it("swallows a throwing play", () => {
      hoisted.playOnChannelAtLevel.mockImplementationOnce(() => {
        throw new Error("device gone");
      });

      expect(() => playPressSound("long")).not.toThrow();
    });
  });
});
