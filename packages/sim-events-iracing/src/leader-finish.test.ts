/**
 * Unit tests for the leader's chequered-flag prediction (issue #1405): the
 * shared white-crossing index, the fuel estimate's near-tie tolerance, and
 * `predictLeaderChequered` on a running clock, an expired one, and every
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
  LAP_LINE_GUARD_PCT,
  type LeaderClockExpiry,
  leaderWhiteCrossingIndex,
  predictLeaderChequered,
  readLeaderGap,
  resolveLeaderFinish,
} from "./leader-finish.js";

/** The seconds half of `predictLeaderChequered`, `null` without a prediction. */
const predictedChequeredInS = (...args: Parameters<typeof predictLeaderChequered>): number | null =>
  predictLeaderChequered(...args)?.inS ?? null;

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

describe("predictLeaderChequered — clock running", () => {
  it("places the chequered one leader lap after the white, from the leader's mid-lap position", () => {
    // ε = 0.03 + 0.01 × 6 = 0.09; white k = ceil(6 + 0.25 + 0.09) = 7, so the
    // chequered is crossing 8, at (8 − 0.25) × 100 s.
    expect(predictedChequeredInS(race(600, 0.25), ORDER, 100, HELD)).toBeCloseTo(775, 9);
  });

  it("counts the crossing just before expiry as gone, with or without the tolerance", () => {
    // The leader crosses at 150 s, 2 s before the clock runs out: the white is
    // the crossing at 250 s, the chequered at 350 s.
    expect(predictedChequeredInS(race(152, 0.5), ORDER, 100, HELD)).toBeCloseTo(350, 9);
  });

  it("lets the tolerance tip a crossing due just after expiry to the next one", () => {
    // 2 s after expiry: exactly, the white at 150 s and the chequered at
    // 250 s; ε = 0.03 + 0.0148 tips it, since pace drift could bring that
    // crossing before the clock runs out.
    expect((leaderWhiteCrossingIndex(148, 100, 0.5, 0) + 1 - 0.5) * 100).toBe(250);
    expect(predictedChequeredInS(race(148, 0.5), ORDER, 100, HELD)).toBeCloseTo(350, 9);
  });

  it("does not tip a crossing comfortably after expiry", () => {
    // 10 s after expiry is more than ε (0.044 laps, 4.4 s): white at 150 s, chequered at 250 s.
    expect(predictedChequeredInS(race(140, 0.5), ORDER, 100, HELD)).toBeCloseTo(250, 9);
  });

  it("ignores the post-expiry marker while the clock is running", () => {
    expect(predictedChequeredInS(race(140, 0.5), ORDER, 100, HELD_CROSSED)).toBeCloseTo(250, 9);
  });
});

describe("predictLeaderChequered — clock expired", () => {
  it("allows two leader laps less the fraction until the leader has crossed since expiry", () => {
    expect(predictedChequeredInS(race(-10, 0.4), ORDER, 100, HELD)).toBeCloseTo(160, 9);
  });

  it("allows one leader lap less the fraction once the leader is on the white lap", () => {
    // 60 s since expiry, the leader 40 s into the lap: they crossed after it.
    expect(predictedChequeredInS(race(-60, 0.4), ORDER, 100, HELD_CROSSED)).toBeCloseTo(60, 9);
  });

  it("treats a clock at exactly zero as expired, where nobody can have crossed since", () => {
    expect(predictedChequeredInS(race(0, 0.4), ORDER, 100, HELD)).toBeCloseTo(160, 9);
    expect(predictedChequeredInS(race(0, 0.4), ORDER, 100, HELD_CROSSED)).toBeCloseTo(160, 9);
  });
});

describe("predictLeaderChequered — a marker the clock does not bear out", () => {
  it("does not trust a marker a lead change set before anyone's white (the second-read scenario)", () => {
    // B passed A after expiry: `leader-white.ts` absorbs the change and sets
    // the marker, but B is half a lap round only 30 s after expiry — they
    // crossed the line before it. Trusting the marker would read (1 − 0.5) ×
    // 100 = 50 s, a lap short.
    expect(predictedChequeredInS(race(-30, 0.5), ORDER, 100, HELD_CROSSED)).toBeCloseTo(150, 9);
  });

  it("reads a crossing near the expiry as not crossed, the cautious lap more", () => {
    // 30 s since expiry; the allowance is 0.03 × 100 = 3 s.
    expect(predictedChequeredInS(race(-30, 0.3), ORDER, 100, HELD_CROSSED)).toBeCloseTo(170, 9); // f·L = 30
    expect(predictedChequeredInS(race(-30, 0.28), ORDER, 100, HELD_CROSSED)).toBeCloseTo(172, 9); // within 3 s
    expect(predictedChequeredInS(race(-30, 0.26), ORDER, 100, HELD_CROSSED)).toBeCloseTo(74, 9); // 4 s clear
  });

  it("never reads a crossing without the marker, however far round the clock allows", () => {
    expect(predictedChequeredInS(race(-90, 0.1), ORDER, 100, HELD)).toBeCloseTo(190, 9);
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

  it("confirms about a second of ticks at iRacing's 60 Hz, not the tick or two of a blip", () => {
    expect(CLOCK_EXPIRY_CONFIRM_TICKS).toBe(60);
    expect(isClockExpiryConfirmed(2)).toBe(false);
    expect(isClockExpiryConfirmed(59)).toBe(false);
    expect(isClockExpiryConfirmed(60)).toBe(true);
  });

  it("counts consecutive expired readings and starts again on any other", () => {
    let ticks = 0;

    ticks = countClockExpiredTicks(race(-1, 0.5), ticks);
    expect(ticks).toBe(1);
    expect(isClockExpiryConfirmed(ticks)).toBe(false);

    ticks = countClockExpiredTicks(race(-2, 0.5), ticks);
    expect(ticks).toBe(2);
    expect(isClockExpiryConfirmed(ticks)).toBe(false);

    for (let i = 3; i <= CLOCK_EXPIRY_CONFIRM_TICKS; i++) ticks = countClockExpiredTicks(race(-i, 0.5), ticks);

    expect(ticks).toBe(CLOCK_EXPIRY_CONFIRM_TICKS);
    expect(isClockExpiryConfirmed(ticks)).toBe(true);

    ticks = countClockExpiredTicks(race(30, 0.5), ticks);
    expect(ticks).toBe(0);
    expect(isClockExpiryConfirmed(ticks)).toBe(false);
  });
});

describe("predictLeaderChequered — an expired reading not yet confirmed", () => {
  const BLIP: LeaderClockExpiry = { confirmed: false, leaderCrossed: false };

  it("answers null for a reading at or below zero that has not held long enough", () => {
    expect(predictedChequeredInS(race(-0.1, 0.4), ORDER, 100, BLIP)).toBeNull();
    expect(predictedChequeredInS(race(0, 0.4), ORDER, 100, BLIP)).toBeNull();
    // A marker without a confirmed expiry changes nothing.
    expect(predictedChequeredInS(race(-0.1, 0.4), ORDER, 100, { ...BLIP, leaderCrossed: true })).toBeNull();
  });

  it("does not need the confirmation while the clock is running", () => {
    expect(predictedChequeredInS(race(140, 0.5), ORDER, 100, BLIP)).toBeCloseTo(250, 9);
  });
});

describe("predictLeaderChequered — cannot predict", () => {
  it("answers null for an unknown or unlimited clock", () => {
    expect(predictedChequeredInS(race(IRSDK_UNLIMITED_TIME, 0.5), ORDER, 100, HELD)).toBeNull();
    expect(predictedChequeredInS(race(Number.NaN, 0.5), ORDER, 100, HELD)).toBeNull();
    expect(predictedChequeredInS(race(0, 0.5, { SessionTimeRemain: undefined }), ORDER, 100, HELD)).toBeNull();
  });

  it("answers null when no car holds position 1", () => {
    expect(predictedChequeredInS(race(600, 0.5), [2, 0, 3], 100, HELD)).toBeNull();
    expect(predictedChequeredInS(race(-10, 0.5), [], 100, HELD_CROSSED)).toBeNull();
  });

  it("answers null without a usable leader lap time", () => {
    for (const lapTime of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(predictedChequeredInS(race(600, 0.5), ORDER, lapTime, HELD)).toBeNull();
      expect(predictedChequeredInS(race(-10, 0.5), ORDER, lapTime, HELD_CROSSED)).toBeNull();
    }
  });

  it("answers null for a leader lap fraction that is not a position on the lap, never taking it as the line", () => {
    for (const pct of [-1, 1, 1.2, Number.NaN]) {
      expect(predictedChequeredInS(race(600, pct), ORDER, 100, HELD)).toBeNull();
      expect(predictedChequeredInS(race(-10, pct), ORDER, 100, HELD)).toBeNull();
    }

    expect(predictedChequeredInS(race(600, 0.5, { CarIdxLapDistPct: undefined }), ORDER, 100, HELD)).toBeNull();
  });

  it("answers null while the leader is in the pit stall or approaching the pits", () => {
    for (const surface of [TrkLoc.InPitStall, TrkLoc.AproachingPits]) {
      const inPits = race(600, 0.5, { CarIdxTrackSurface: [TrkLoc.OnTrack, surface, TrkLoc.OnTrack] });

      expect(predictedChequeredInS(inPits, ORDER, 100, HELD)).toBeNull();
      expect(predictedChequeredInS({ ...inPits, SessionTimeRemain: -10 }, ORDER, 100, HELD_CROSSED)).toBeNull();
    }
  });

  it("does not read CarIdxOnPitRoad, which the track surface stands in for", () => {
    const flagged = race(140, 0.5, { CarIdxOnPitRoad: [false, true, false] });

    expect(predictedChequeredInS(flagged, ORDER, 100, HELD)).toBeCloseTo(250, 9);
  });

  it("predicts for a leader off the racing surface but not in the pits", () => {
    const offTrack = race(140, 0.5, { CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OffTrack, TrkLoc.OnTrack] });

    expect(predictedChequeredInS(offTrack, ORDER, 100, HELD)).toBeCloseTo(250, 9);
  });
});

describe("predictLeaderChequered — crossings and seconds from one count", () => {
  it("counts the white's crossing and one more on a running clock", () => {
    // White k = ceil(6 + 0.25 + 0.09) = 7: the chequered is crossing 8.
    expect(predictLeaderChequered(race(600, 0.25), ORDER, 100, HELD)).toEqual({ inS: 775, crossings: 8 });
  });

  it("counts two crossings on an expired clock, one once the leader has crossed since", () => {
    expect(predictLeaderChequered(race(-10, 0.4), ORDER, 100, HELD)?.crossings).toBe(2);
    expect(predictLeaderChequered(race(-60, 0.4), ORDER, 100, HELD_CROSSED)?.crossings).toBe(1);
  });

  it("puts the chequered (crossings − f) leader laps away", () => {
    for (const [clock, pct] of [
      [600, 0.25],
      [148, 0.5],
      [-30, 0.5],
      [-60, 0.4],
    ] as const) {
      const chequered = predictLeaderChequered(race(clock, pct), ORDER, 100, HELD_CROSSED)!;

      expect(chequered.inS).toBeCloseTo((chequered.crossings - pct) * 100, 9);
    }
  });
});

describe("readLeaderGap", () => {
  // The player is car 0, the leader car 1.
  const counted = (lapsCompleted: number[], pcts: number[]): TelemetryData =>
    race(100, pcts[1]!, { CarIdxLapCompleted: lapsCompleted, CarIdxLapDistPct: pcts });

  it("reads the leader's lead in laps of distance, and both lap counts", () => {
    const gap = readLeaderGap(counted([7, 8, 6], [0.55, 0.2, 0.1]), ORDER, 0);

    expect(gap?.leaderLapsCompleted).toBe(8);
    expect(gap?.playerLapsCompleted).toBe(7);
    expect(gap?.distanceLaps).toBeCloseTo(0.65, 9);
  });

  it("reads no gap when the player is the leader", () => {
    expect(readLeaderGap(counted([8, 8, 6], [0.55, 0.5, 0.1]), [1, 2, 3], 0)?.distanceLaps).toBe(0);
  });

  it("reads nothing it cannot trust", () => {
    const valid = counted([8, 8, 6], [0.55, 0.57, 0.1]);

    expect(readLeaderGap(valid, ORDER, 0)).not.toBeNull();
    // No player, or no leader.
    expect(readLeaderGap(valid, ORDER, -1)).toBeNull();
    expect(readLeaderGap(valid, ORDER, 9)).toBeNull();
    expect(readLeaderGap(valid, [2, 0, 3], 0)).toBeNull();
    // Missing or not-yet-started lap counts, and a player not in the world.
    expect(readLeaderGap({ ...valid, CarIdxLapCompleted: undefined }, ORDER, 0)).toBeNull();
    expect(readLeaderGap(counted([-1, 8, 6], [0.55, 0.57, 0.1]), ORDER, 0)).toBeNull();
    expect(readLeaderGap(counted([-1, 8, 6], [-1, 0.57, 0.1]), ORDER, 0)).toBeNull();
    expect(readLeaderGap(counted([8, 8, 6], [Number.NaN, 0.57, 0.1]), ORDER, 0)).toBeNull();
  });

  it("does not trust a car within the line guard, where the lap count and fraction can disagree around a crossing", () => {
    expect(LAP_LINE_GUARD_PCT).toBe(0.03);
    expect(readLeaderGap(counted([8, 8, 6], [0.55, 0.02, 0.1]), ORDER, 0)).toBeNull();
    expect(readLeaderGap(counted([8, 8, 6], [0.55, 0.98, 0.1]), ORDER, 0)).toBeNull();
    expect(readLeaderGap(counted([8, 8, 6], [0.01, 0.57, 0.1]), ORDER, 0)).toBeNull();
    expect(readLeaderGap(counted([8, 8, 6], [0.975, 0.57, 0.1]), ORDER, 0)).toBeNull();
    // Just outside it, both read.
    expect(readLeaderGap(counted([8, 8, 6], [0.04, 0.96, 0.1]), ORDER, 0)).not.toBeNull();
  });
});

describe("resolveLeaderFinish", () => {
  it("bundles the lap time, the prediction in both units and the gap", () => {
    const telemetry = race(-30, 0.57, { CarIdxLapCompleted: [8, 8, 6], CarIdxLapDistPct: [0.55, 0.57, 0.1] });
    const finish = resolveLeaderFinish(telemetry, ORDER, 0, 100, HELD);

    expect(finish.lapTimeS).toBe(100);
    expect(finish.chequeredInS).toBeCloseTo(143, 9);
    expect(finish.crossingsToChequered).toBe(2);
    expect(finish.leaderGap?.distanceLaps).toBeCloseTo(0.02, 9);
  });

  it("has no crossings exactly when it has no seconds", () => {
    const telemetry = race(-30, 0.57, { CarIdxLapCompleted: [8, 8, 6], CarIdxLapDistPct: [0.55, 0.57, 0.1] });
    const finish = resolveLeaderFinish(telemetry, ORDER, 0, null, HELD);

    expect(finish.chequeredInS).toBeNull();
    expect(finish.crossingsToChequered).toBeNull();
    expect(finish.leaderGap).not.toBeNull();
  });
});
