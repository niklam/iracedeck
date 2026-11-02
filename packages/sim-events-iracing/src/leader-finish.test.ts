/**
 * Unit tests for the leader's chequered-flag prediction (issue #1405): the
 * shared white-crossing index, the fuel estimate's near-tie tolerance, and
 * `predictLeaderChequeredS` on a running clock, an expired one, and every
 * case it cannot answer.
 */
import { IRSDK_UNLIMITED_TIME, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import {
  CLOCK_EXPIRY_CONFIRM_TICKS,
  countClockExpiredTicks,
  FUEL_FINISH_PACE_DRIFT,
  FUEL_FINISH_TOLERANCE_LAPS,
  fuelFinishToleranceLaps,
  isClockExpiredReading,
  isClockExpiryConfirmed,
  type LeaderClockExpiry,
  leaderWhiteCrossingIndex,
  predictLeaderChequeredS,
} from "./leader-finish.js";

// Car 1 leads; car 0 is second, car 2 third.
const ORDER = [2, 1, 3];
// An expired clock held long enough to be confirmed, before and after the
// leader's post-expiry crossing. A running clock reads neither.
const HELD: LeaderClockExpiry = { confirmed: true, leaderCrossed: false };
const HELD_CROSSED: LeaderClockExpiry = { confirmed: true, leaderCrossed: true };

/** A timed race with `timeRemainS` on the clock and the leader (car 1) at `leaderPct`, on track. */
function race(timeRemainS: number, leaderPct: number, overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    SessionTimeRemain: timeRemainS,
    CarIdxLapDistPct: [0.9, leaderPct, 0.1],
    CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
    CarIdxOnPitRoad: [false, false, false],
    ...overrides,
  } as TelemetryData;
}

describe("leaderWhiteCrossingIndex", () => {
  it("is the leader's first crossing at or after expiry", () => {
    // Crossings at 50, 150, 250 s (half a 100 s lap to the line).
    expect(leaderWhiteCrossingIndex(148, 100, 0.5, 0)).toBe(2); // 150 s is after expiry
    expect(leaderWhiteCrossingIndex(150, 100, 0.5, 0)).toBe(2); // a crossing AT expiry is the white
    expect(leaderWhiteCrossingIndex(152, 100, 0.5, 0)).toBe(3); // 150 s came before it
  });

  it("moves a near-tie to the later crossing by the tolerance", () => {
    expect(leaderWhiteCrossingIndex(148, 100, 0.5, 0.03)).toBe(3);
    expect(leaderWhiteCrossingIndex(140, 100, 0.5, 0.03)).toBe(2);
  });
});

describe("fuelFinishToleranceLaps", () => {
  it("is the fixed part plus a share of the laps until expiry", () => {
    expect(fuelFinishToleranceLaps(0, 100)).toBe(FUEL_FINISH_TOLERANCE_LAPS);
    expect(fuelFinishToleranceLaps(600, 100)).toBeCloseTo(FUEL_FINISH_TOLERANCE_LAPS + 6 * FUEL_FINISH_PACE_DRIFT, 12);
    expect(FUEL_FINISH_TOLERANCE_LAPS).toBe(0.03);
    expect(FUEL_FINISH_PACE_DRIFT).toBe(0.01);
  });
});

describe("predictLeaderChequeredS — clock running", () => {
  it("places the chequered one leader lap after the white, from the leader's mid-lap position", () => {
    // ε = 0.03 + 0.01 × 6 = 0.09; white k = ceil(6 + 0.25 + 0.09) = 7, so the
    // chequered is crossing 8, at (8 − 0.25) × 100 s.
    expect(predictLeaderChequeredS(race(600, 0.25), ORDER, 100, HELD)).toBeCloseTo(775, 9);
  });

  it("counts the crossing just before expiry as gone, with or without the tolerance", () => {
    // The leader crosses at 150 s, 2 s before the clock runs out: the white is
    // the crossing at 250 s, the chequered at 350 s.
    expect(predictLeaderChequeredS(race(152, 0.5), ORDER, 100, HELD)).toBeCloseTo(350, 9);
  });

  it("lets the tolerance tip a crossing due just after expiry to the next one", () => {
    // 2 s after expiry: exactly, the white at 150 s and the chequered at
    // 250 s; ε = 0.03 + 0.0148 tips it, since pace drift could bring that
    // crossing before the clock runs out.
    expect((leaderWhiteCrossingIndex(148, 100, 0.5, 0) + 1 - 0.5) * 100).toBe(250);
    expect(predictLeaderChequeredS(race(148, 0.5), ORDER, 100, HELD)).toBeCloseTo(350, 9);
  });

  it("does not tip a crossing comfortably after expiry", () => {
    // 10 s after expiry is more than ε (0.044 laps, 4.4 s): white at 150 s, chequered at 250 s.
    expect(predictLeaderChequeredS(race(140, 0.5), ORDER, 100, HELD)).toBeCloseTo(250, 9);
  });

  it("ignores the post-expiry marker while the clock is running", () => {
    expect(predictLeaderChequeredS(race(140, 0.5), ORDER, 100, HELD_CROSSED)).toBeCloseTo(250, 9);
  });
});

describe("predictLeaderChequeredS — clock expired", () => {
  it("allows two leader laps less the fraction until the leader has crossed since expiry", () => {
    expect(predictLeaderChequeredS(race(-10, 0.4), ORDER, 100, HELD)).toBeCloseTo(160, 9);
  });

  it("allows one leader lap less the fraction once the leader is on the white lap", () => {
    expect(predictLeaderChequeredS(race(-60, 0.4), ORDER, 100, HELD_CROSSED)).toBeCloseTo(60, 9);
  });

  it("treats a clock at exactly zero as expired", () => {
    expect(predictLeaderChequeredS(race(0, 0.4), ORDER, 100, HELD)).toBeCloseTo(160, 9);
    expect(predictLeaderChequeredS(race(0, 0.4), ORDER, 100, HELD_CROSSED)).toBeCloseTo(60, 9);
  });
});

describe("the expired-clock confirmation", () => {
  it("reads a finite clock at or below zero as expired, and nothing else", () => {
    expect(isClockExpiredReading(race(0, 0.5))).toBe(true);
    expect(isClockExpiredReading(race(-0.1, 0.5))).toBe(true);
    expect(isClockExpiredReading(race(0.1, 0.5))).toBe(false);
    expect(isClockExpiredReading(race(Number.NaN, 0.5))).toBe(false);
    expect(isClockExpiredReading(race(Number.NEGATIVE_INFINITY, 0.5))).toBe(false);
    expect(isClockExpiredReading(race(0, 0.5, { SessionTimeRemain: undefined }))).toBe(false);
  });

  it("counts consecutive expired readings and starts again on any other", () => {
    let ticks = 0;

    ticks = countClockExpiredTicks(race(-1, 0.5), ticks);
    expect(ticks).toBe(1);
    expect(isClockExpiryConfirmed(ticks)).toBe(false);

    ticks = countClockExpiredTicks(race(-2, 0.5), ticks);
    expect(ticks).toBe(CLOCK_EXPIRY_CONFIRM_TICKS);
    expect(isClockExpiryConfirmed(ticks)).toBe(true);

    ticks = countClockExpiredTicks(race(30, 0.5), ticks);
    expect(ticks).toBe(0);
    expect(isClockExpiryConfirmed(ticks)).toBe(false);
  });
});

describe("predictLeaderChequeredS — an expired reading not yet confirmed", () => {
  const BLIP: LeaderClockExpiry = { confirmed: false, leaderCrossed: false };

  it("answers null for a reading at or below zero that has not held for two ticks", () => {
    expect(predictLeaderChequeredS(race(-0.1, 0.4), ORDER, 100, BLIP)).toBeNull();
    expect(predictLeaderChequeredS(race(0, 0.4), ORDER, 100, BLIP)).toBeNull();
    // A marker without a confirmed expiry changes nothing.
    expect(predictLeaderChequeredS(race(-0.1, 0.4), ORDER, 100, { ...BLIP, leaderCrossed: true })).toBeNull();
  });

  it("does not need the confirmation while the clock is running", () => {
    expect(predictLeaderChequeredS(race(140, 0.5), ORDER, 100, BLIP)).toBeCloseTo(250, 9);
  });
});

describe("predictLeaderChequeredS — cannot predict", () => {
  it("answers null for an unknown or unlimited clock", () => {
    expect(predictLeaderChequeredS(race(IRSDK_UNLIMITED_TIME, 0.5), ORDER, 100, HELD)).toBeNull();
    expect(predictLeaderChequeredS(race(Number.NaN, 0.5), ORDER, 100, HELD)).toBeNull();
    expect(predictLeaderChequeredS(race(0, 0.5, { SessionTimeRemain: undefined }), ORDER, 100, HELD)).toBeNull();
  });

  it("answers null when no car holds position 1", () => {
    expect(predictLeaderChequeredS(race(600, 0.5), [2, 0, 3], 100, HELD)).toBeNull();
    expect(predictLeaderChequeredS(race(-10, 0.5), [], 100, HELD_CROSSED)).toBeNull();
  });

  it("answers null without a usable leader lap time", () => {
    for (const lapTime of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(predictLeaderChequeredS(race(600, 0.5), ORDER, lapTime, HELD)).toBeNull();
      expect(predictLeaderChequeredS(race(-10, 0.5), ORDER, lapTime, HELD_CROSSED)).toBeNull();
    }
  });

  it("answers null for a leader lap fraction that is not a position on the lap, never taking it as the line", () => {
    for (const pct of [-1, 1, 1.2, Number.NaN]) {
      expect(predictLeaderChequeredS(race(600, pct), ORDER, 100, HELD)).toBeNull();
      expect(predictLeaderChequeredS(race(-10, pct), ORDER, 100, HELD)).toBeNull();
    }

    expect(predictLeaderChequeredS(race(600, 0.5, { CarIdxLapDistPct: undefined }), ORDER, 100, HELD)).toBeNull();
  });

  it("answers null while the leader is in the pit stall or approaching the pits", () => {
    for (const surface of [TrkLoc.InPitStall, TrkLoc.AproachingPits]) {
      const inPits = race(600, 0.5, { CarIdxTrackSurface: [TrkLoc.OnTrack, surface, TrkLoc.OnTrack] });

      expect(predictLeaderChequeredS(inPits, ORDER, 100, HELD)).toBeNull();
      expect(predictLeaderChequeredS({ ...inPits, SessionTimeRemain: -10 }, ORDER, 100, HELD_CROSSED)).toBeNull();
    }
  });

  it("does not read CarIdxOnPitRoad, which the track surface stands in for", () => {
    const flagged = race(140, 0.5, { CarIdxOnPitRoad: [false, true, false] });

    expect(predictLeaderChequeredS(flagged, ORDER, 100, HELD)).toBeCloseTo(250, 9);
  });

  it("predicts for a leader off the racing surface but not in the pits", () => {
    const offTrack = race(140, 0.5, { CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OffTrack, TrkLoc.OnTrack] });

    expect(predictLeaderChequeredS(offTrack, ORDER, 100, HELD)).toBeCloseTo(250, 9);
  });
});
