/**
 * The replay measures the gate and the paced search share (#1450).
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { followsPlayback, playbackTolerance, rateOf, readReplay } from "./replay-reading.js";

/** A replay tick at `frame`, paused unless the overrides say otherwise. */
function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsReplayPlaying: true,
    ReplayFrameNum: 50_000,
    ReplayFrameNumEnd: 1_000,
    ReplayPlaySpeed: 0,
    ReplayPlaySlowMotion: false,
    ...overrides,
  } as TelemetryData;
}

describe("replay-reading (#1450)", () => {
  describe("readReplay", () => {
    it("reads the frame, the frames left, the speed and its rate from a replay tick", () => {
      expect(readReplay(tick({ ReplayPlaySpeed: 1 }))).toEqual({
        frame: 50_000,
        left: 1_000,
        rate: 0.06,
        speed: { speed: 1, slowMotion: false },
      });
    });

    it("reads a slow-motion speed as its divisor, and its rate from it", () => {
      // Raw 1 in slow motion is 1/2x.
      const reading = readReplay(tick({ ReplayPlaySpeed: 1, ReplayPlaySlowMotion: true }));

      expect(reading?.speed).toEqual({ speed: 2, slowMotion: true });
      expect(reading?.rate).toBeCloseTo(0.03, 10);
    });

    it("is null with no telemetry, outside a replay, or with no finite frame", () => {
      expect(readReplay(null)).toBeNull();
      expect(readReplay(tick({ IsReplayPlaying: false }))).toBeNull();
      expect(readReplay(tick({ ReplayFrameNum: undefined }))).toBeNull();
      expect(readReplay(tick({ ReplayFrameNum: Number.NaN }))).toBeNull();
    });

    it("leaves the frames left undefined when the tick does not say, or says less than none", () => {
      expect(readReplay(tick({ ReplayFrameNumEnd: undefined }))?.left).toBeUndefined();
      expect(readReplay(tick({ ReplayFrameNumEnd: -1 }))?.left).toBeUndefined();
      expect(readReplay(tick({ ReplayFrameNumEnd: 0 }))?.left).toBe(0);
    });

    it("reads an unknown speed as null, with a rate of 0", () => {
      const reading = readReplay(tick({ ReplayPlaySpeed: undefined }));

      expect(reading?.speed).toBeNull();
      expect(reading?.rate).toBe(0);
    });
  });

  describe("rateOf", () => {
    it.each([
      ["paused", { speed: 0, slowMotion: false }, 0],
      ["paused in slow motion", { speed: 0, slowMotion: true }, 0],
      ["1x", { speed: 1, slowMotion: false }, 0.06],
      ["reverse at 1x", { speed: -1, slowMotion: false }, -0.06],
      ["4x", { speed: 4, slowMotion: false }, 0.24],
      ["1/4x", { speed: 4, slowMotion: true }, 0.015],
      ["1/4x in reverse", { speed: -4, slowMotion: true }, -0.015],
    ] as const)("is the frames a millisecond %s plays", (_name, speed, rate) => {
      expect(rateOf(speed)).toBeCloseTo(rate, 10);
    });

    it("is 0 for an unknown speed", () => {
      expect(rateOf(null)).toBe(0);
    });
  });

  describe("playbackTolerance", () => {
    it("is 3 frames on a paused replay, whatever the time", () => {
      expect(playbackTolerance(0, 0)).toBe(3);
      expect(playbackTolerance(0, 10_000)).toBe(3);
    });

    it("grows with the rate and a quarter of the frames played, either direction alike", () => {
      // 3 + 0.06 × 20 + 0.25 × 0.06 × 50
      expect(playbackTolerance(0.06, 50)).toBeCloseTo(4.95, 10);
      expect(playbackTolerance(-0.06, 50)).toBeCloseTo(4.95, 10);
      expect(playbackTolerance(0.06, -50)).toBeCloseTo(4.95, 10);
    });
  });

  describe("followsPlayback", () => {
    it("holds within the tolerance of where playback puts the frame, and not past it", () => {
      // 1x for 50 ms: 3 frames on, within 4.95.
      expect(followsPlayback(1_000, 0.06, 50, 1_003)).toBe(true);
      expect(followsPlayback(1_000, 0.06, 50, 1_007)).toBe(true);
      expect(followsPlayback(1_000, 0.06, 50, 1_008)).toBe(false);
      expect(followsPlayback(1_000, 0.06, 50, 998)).toBe(false);
    });

    it("on a paused replay holds within 3 frames of where it was", () => {
      expect(followsPlayback(1_000, 0, 50, 1_003)).toBe(true);
      expect(followsPlayback(1_000, 0, 50, 1_004)).toBe(false);
    });
  });
});
