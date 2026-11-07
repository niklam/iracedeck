/**
 * Unit tests for the leader's chequered-flag prediction (issue #1405): the
 * shared white-crossing index, the fuel estimate's near-tie tolerance, and
 * `predictLeaderChequered` on a running clock, an expired one, and every
 * case it cannot answer; and the lap-count test and count the fuel estimate
 * shares with the gap horizon (issue #1380).
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
  lapCountCrossings,
  type LeaderClockExpiry,
  type LeaderGap,
  leaderWhiteCrossingIndex,
  predictLeaderChequered,
  readLapFraction,
  readLeaderGap,
  readLeaderGapAt,
  resolveLeaderFinish,
  staysWithinLapAtChequered,
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

describe("readLapFraction", () => {
  const pcts = (values: number[]): TelemetryData => ({ CarIdxLapDistPct: values }) as TelemetryData;

  it("reads a position on the lap, the line included", () => {
    expect(readLapFraction(pcts([0, 0.5, 0.999]), 0)).toBe(0);
    expect(readLapFraction(pcts([0, 0.5, 0.999]), 1)).toBe(0.5);
    expect(readLapFraction(pcts([0, 0.5, 0.999]), 2)).toBe(0.999);
  });

  it("reads nothing that is not one", () => {
    // Off world, a full lap or more, not a number.
    for (const value of [-1, 1, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readLapFraction(pcts([value]), 0)).toBeNull();
    }

    // No such car, no array.
    expect(readLapFraction(pcts([0.5]), 1)).toBeNull();
    expect(readLapFraction(pcts([0.5]), -1)).toBeNull();
    expect(readLapFraction(pcts([0.5]), 0.5)).toBeNull();
    expect(readLapFraction({} as TelemetryData, 0)).toBeNull();
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

  it("reads the same gap from the leader's index as from the order", () => {
    const telemetry = counted([7, 8, 6], [0.55, 0.2, 0.1]);

    expect(readLeaderGapAt(telemetry, 1, 0)).toEqual(readLeaderGap(telemetry, ORDER, 0));
    expect(readLeaderGapAt(telemetry, -1, 0)).toBeNull();
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

describe("staysWithinLapAtChequered (issue #1380)", () => {
  const gapOf = (distanceLaps: number): LeaderGap => ({ leaderLapsCompleted: 8, playerLapsCompleted: 7, distanceLaps });

  it("keeps a player on the leader's pace within a lap whatever the time left", () => {
    expect(staysWithinLapAtChequered(gapOf(0.65), 3600, 100, 100)).toBe(true);
    expect(staysWithinLapAtChequered(gapOf(-0.5), 3600, 100, 100)).toBe(true);
  });

  it("refuses a gap of a lap or more now, either side", () => {
    expect(staysWithinLapAtChequered(gapOf(1), 0, 100, 100)).toBe(false);
    expect(staysWithinLapAtChequered(gapOf(-1), 0, 100, 100)).toBe(false);
    expect(staysWithinLapAtChequered(gapOf(1.2), 0, 100, 90)).toBe(false);
  });

  it("projects a slower player's gap to the flag: lapped before it is not within a lap", () => {
    // 0.65 laps down, 1 % slower: 1000 s at the flag adds 1000 · (1/100 − 1/101) ≈ 0.099 laps.
    expect(staysWithinLapAtChequered(gapOf(0.65), 1000, 100, 101)).toBe(true);
    // 5000 s adds ≈ 0.495 laps: lapped before the flag.
    expect(staysWithinLapAtChequered(gapOf(0.65), 5000, 100, 101)).toBe(false);
  });

  it("keeps a faster player, whose projected gap shrinks", () => {
    expect(staysWithinLapAtChequered(gapOf(0.9), 5000, 100, 95)).toBe(true);
  });
});

describe("lapCountCrossings (issue #1380)", () => {
  it("is the leader's crossings on the same lap", () => {
    expect(lapCountCrossings({ leaderLapsCompleted: 8, playerLapsCompleted: 8, distanceLaps: 0.2 }, 3)).toBe(3);
  });

  it("adds a lap for a player a lap down on the counter but within a lap on distance", () => {
    expect(lapCountCrossings({ leaderLapsCompleted: 8, playerLapsCompleted: 7, distanceLaps: 0.65 }, 3)).toBe(4);
  });

  it("takes one off for a player across the line just ahead of the leader", () => {
    expect(lapCountCrossings({ leaderLapsCompleted: 8, playerLapsCompleted: 9, distanceLaps: -0.1 }, 3)).toBe(2);
  });
});

describe("resolveLeaderFinish", () => {
  it("bundles the lap time, the prediction in both units and the gap", () => {
    const telemetry = race(-30, 0.57, { CarIdxLapCompleted: [8, 8, 6], CarIdxLapDistPct: [0.55, 0.57, 0.1] });
    const finish = resolveLeaderFinish(telemetry, ORDER, 0, 100, HELD, 100);

    expect(finish.lapTimeS).toBe(100);
    expect(finish.chequeredInS).toBeCloseTo(143, 9);
    expect(finish.crossingsToChequered).toBe(2);
    expect(finish.lapCountChequered).toEqual({ inS: finish.chequeredInS, crossings: 2, lapTimeS: 100 });
    expect(finish.leaderGap?.distanceLaps).toBeCloseTo(0.02, 9);
  });

  it("runs the lap-count prediction at the leader's lap capped at the player's average", () => {
    const telemetry = race(600, 0.6, { CarIdxLapCompleted: [30, 30, 6], CarIdxLapDistPct: [0.5, 0.6, 0.1] });
    // A 160 s caution lap: the raw prediction keeps it, the lap-count one
    // runs at the player's 100 s.
    const slow = resolveLeaderFinish(telemetry, ORDER, 0, 160, HELD, 100);

    expect(slow.chequeredInS).toBeCloseTo((6 - 0.6) * 160, 9);
    expect(slow.crossingsToChequered).toBe(6);
    expect(slow.lapCountChequered?.lapTimeS).toBe(100);
    expect(slow.lapCountChequered?.crossings).toBe(8);
    expect(slow.lapCountChequered?.inS).toBeCloseTo((8 - 0.6) * 100, 9);

    // A leader faster than the player keeps their own lap.
    const fast = resolveLeaderFinish(telemetry, ORDER, 0, 95, HELD, 100);

    expect(fast.lapCountChequered?.lapTimeS).toBe(95);
    expect(fast.lapCountChequered?.crossings).toBe(fast.crossingsToChequered);
  });

  it("checks a post-expiry crossing at the raw pace, not the capped one", () => {
    // 70 s past expiry, the marker set (a lead change can set it), the leader
    // at 0.6 with a 160 s raw lap and the player's average at 100 s. At the
    // raw pace the leader crossed 96 s ago, before expiry, so the marker is
    // not borne out: two crossings. At the capped pace 60 s would look like a
    // crossing since expiry and read one — the race a lap short.
    const telemetry = race(-70, 0.6, { CarIdxLapCompleted: [30, 30, 6], CarIdxLapDistPct: [0.5, 0.6, 0.1] });
    const finish = resolveLeaderFinish(telemetry, ORDER, 0, 160, HELD_CROSSED, 100);

    expect(finish.crossingsToChequered).toBe(2);
    expect(finish.lapCountChequered?.crossings).toBe(2);
    expect(finish.lapCountChequered?.inS).toBeCloseTo((2 - 0.6) * 100, 9);
  });

  it("has no lap-count prediction without the player's average", () => {
    const telemetry = race(600, 0.6, { CarIdxLapCompleted: [30, 30, 6], CarIdxLapDistPct: [0.5, 0.6, 0.1] });

    for (const playerLapS of [null, 0, Number.NaN]) {
      const finish = resolveLeaderFinish(telemetry, ORDER, 0, 100, HELD, playerLapS);

      expect(finish.chequeredInS).not.toBeNull();
      expect(finish.lapCountChequered).toBeNull();
    }
  });

  it("has no crossings exactly when it has no seconds", () => {
    const telemetry = race(-30, 0.57, { CarIdxLapCompleted: [8, 8, 6], CarIdxLapDistPct: [0.55, 0.57, 0.1] });
    const finish = resolveLeaderFinish(telemetry, ORDER, 0, null, HELD, 100);

    expect(finish.chequeredInS).toBeNull();
    expect(finish.crossingsToChequered).toBeNull();
    expect(finish.lapCountChequered).toBeNull();
    expect(finish.leaderGap).not.toBeNull();
  });
});
