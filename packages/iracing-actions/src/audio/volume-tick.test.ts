import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetVolumeTicks,
  playVolumeTick,
  playVolumeTicks,
  tickIRacingVolumeStep,
  VOLUME_TICK_CLIPS,
  VOLUME_TICK_FLOOR,
  VOLUME_TICK_MAX_QUEUED,
  VOLUME_TICK_SPACING_MS,
  volumeTickLevel,
} from "./volume-tick.js";

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

/** The [clip, level] of every play so far. */
function plays(): Array<[string, number]> {
  return hoisted.playOnChannelAtLevel.mock.calls.map(([, path, level]) => [path, level]);
}

describe("volume-tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    hoisted.isConnected.mockReturnValue(true);
    hoisted.setGlobalSettings({});
    _resetVolumeTicks();
  });

  afterEach(() => {
    _resetVolumeTicks();
    vi.useRealTimers();
  });

  describe("clips", () => {
    it("plays the up clip going up and the down clip going down, on the Feedback channel", () => {
      playVolumeTick("up", 60);
      vi.advanceTimersByTime(VOLUME_TICK_SPACING_MS);
      playVolumeTick("down", 60);

      expect(hoisted.playOnChannelAtLevel.mock.calls).toEqual([
        [FEEDBACK, "sfx/IRD-volume-up.wav", 0.6],
        [FEEDBACK, "sfx/IRD-volume-down.wav", 0.6],
      ]);
      expect(VOLUME_TICK_CLIPS).toEqual({ up: "sfx/IRD-volume-up.wav", down: "sfx/IRD-volume-down.wav" });
    });
  });

  describe("level", () => {
    it("passes the given level above the floor, as 0–1", () => {
      expect(volumeTickLevel(55)).toBe(55);
      expect(volumeTickLevel(100)).toBe(100);

      playVolumeTick("up", 55);
      expect(plays()).toEqual([["sfx/IRD-volume-up.wav", 0.55]]);
    });

    it("plays at the floor below it, 0 included", () => {
      expect(VOLUME_TICK_FLOOR).toBe(20);
      expect(volumeTickLevel(VOLUME_TICK_FLOOR)).toBe(VOLUME_TICK_FLOOR);
      expect(volumeTickLevel(10)).toBe(VOLUME_TICK_FLOOR);
      expect(volumeTickLevel(0)).toBe(VOLUME_TICK_FLOOR);

      playVolumeTick("down", 0);
      expect(plays()).toEqual([["sfx/IRD-volume-down.wav", 0.2]]);
    });

    it("clamps above 100 and floors a non-finite level", () => {
      expect(volumeTickLevel(140)).toBe(100);
      expect(volumeTickLevel(Number.NaN)).toBe(VOLUME_TICK_FLOOR);
    });
  });

  describe("scheduling", () => {
    it("plays the first tick at once and each later one at the spacing", () => {
      playVolumeTicks("up", 3, 50);

      expect(plays()).toHaveLength(1);

      vi.advanceTimersByTime(VOLUME_TICK_SPACING_MS - 1);
      expect(plays()).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(plays()).toHaveLength(2);

      vi.advanceTimersByTime(VOLUME_TICK_SPACING_MS);
      expect(plays()).toHaveLength(3);

      vi.advanceTimersByTime(VOLUME_TICK_SPACING_MS * 5);
      expect(plays()).toHaveLength(3);
    });

    it("spaces the next tick from when the play returned, so a slow device start does not cut the first tick", () => {
      // The first play opens an idle-stopped device synchronously and takes 100 ms.
      hoisted.playOnChannelAtLevel.mockImplementationOnce(() => {
        vi.advanceTimersByTime(100);

        return true;
      });

      playVolumeTicks("up", 2, 50);
      expect(plays()).toHaveLength(1);

      vi.advanceTimersByTime(VOLUME_TICK_SPACING_MS - 1);
      expect(plays()).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(plays()).toHaveLength(2);
    });

    it("plays a tick at once when the last one started at least the spacing ago", () => {
      playVolumeTick("up", 50);
      vi.advanceTimersByTime(VOLUME_TICK_SPACING_MS);
      playVolumeTick("up", 50);

      expect(plays()).toHaveLength(2);
    });

    it("holds a tick that comes too soon after the last one until its slot", () => {
      playVolumeTick("up", 50);
      vi.advanceTimersByTime(30);
      playVolumeTick("down", 50);

      expect(plays()).toHaveLength(1);

      vi.advanceTimersByTime(VOLUME_TICK_SPACING_MS - 30);
      expect(plays()).toEqual([
        ["sfx/IRD-volume-up.wav", 0.5],
        ["sfx/IRD-volume-down.wav", 0.5],
      ]);
    });

    it("drops the oldest waiting ticks beyond the cap", () => {
      // One plays at once; ten more wait, of which only the last five survive.
      for (let i = 0; i < 11; i++) playVolumeTick("up", 30 + i * 5);

      vi.advanceTimersByTime(VOLUME_TICK_SPACING_MS * 20);

      expect(VOLUME_TICK_MAX_QUEUED).toBe(5);
      expect(plays().map(([, level]) => level)).toEqual([0.3, 0.6, 0.65, 0.7, 0.75, 0.8]);
    });

    it("keeps order across a reversal, so the reversal is heard", () => {
      playVolumeTicks("up", 3, 50);
      playVolumeTicks("down", 2, 40);

      vi.advanceTimersByTime(VOLUME_TICK_SPACING_MS * 10);

      expect(plays().map(([clip]) => clip)).toEqual([
        "sfx/IRD-volume-up.wav",
        "sfx/IRD-volume-up.wav",
        "sfx/IRD-volume-up.wav",
        "sfx/IRD-volume-down.wav",
        "sfx/IRD-volume-down.wav",
      ]);
    });

    it("hears a reversal after a long spin, because the oldest are dropped", () => {
      playVolumeTicks("up", 20, 50);
      playVolumeTick("down", 45);

      vi.advanceTimersByTime(VOLUME_TICK_SPACING_MS * 30);

      expect(plays().at(-1)).toEqual(["sfx/IRD-volume-down.wav", 0.45]);
      expect(plays()).toHaveLength(1 + VOLUME_TICK_MAX_QUEUED);
    });

    it("ticks nothing for a count of zero or less", () => {
      playVolumeTicks("up", 0, 50);
      playVolumeTicks("down", -2, 50);
      vi.advanceTimersByTime(VOLUME_TICK_SPACING_MS * 5);

      expect(plays()).toEqual([]);
    });

    it("never throws when the audio service is not initialized", () => {
      hoisted.getAudio.mockImplementationOnce(() => {
        throw new Error("Audio service not initialized");
      });

      expect(() => playVolumeTick("up", 50)).not.toThrow();
    });
  });

  describe("tickIRacingVolumeStep", () => {
    it("ticks at the Radar Volume level while the sim is connected", () => {
      hoisted.setGlobalSettings({ radarVolume: 65 });

      tickIRacingVolumeStep("up");

      expect(plays()).toEqual([["sfx/IRD-volume-up.wav", 0.65]]);
    });

    it("floors a low Radar Volume, so Radar Volume 0 still ticks", () => {
      hoisted.setGlobalSettings({ radarVolume: 0 });

      tickIRacingVolumeStep("down");

      expect(plays()).toEqual([["sfx/IRD-volume-down.wav", 0.2]]);
    });

    it("ticks nothing while the sim is not connected", () => {
      hoisted.isConnected.mockReturnValue(false);

      tickIRacingVolumeStep("up");
      vi.advanceTimersByTime(VOLUME_TICK_SPACING_MS * 5);

      expect(hoisted.playOnChannelAtLevel).not.toHaveBeenCalled();
    });
  });
});
