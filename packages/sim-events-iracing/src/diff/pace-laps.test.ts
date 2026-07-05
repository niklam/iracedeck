/**
 * Unit tests for the rolling-start "one pace lap to go" diff (issue #657).
 *
 * The cue fires at the start/finish crossing that COMPLETES the first full pace
 * lap of a rolling formation (≈1 lap accrued since entering ParadeLaps), while
 * the green is not yet held — NOT on the grid-release crossing (≈0 accrued) and
 * never on a standing start or after the race finishes.
 */
import { Flags, SessionState, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffPaceLaps, resolvePaceCarIdx } from "./pace-laps.js";
import type { PendingEvent } from "./types.js";

/** Rolling start (StandingStart not set). */
const ROLLING: Record<string, unknown> | null = null;
/** Standing start. */
const STANDING: Record<string, unknown> = { WeekendInfo: { WeekendOptions: { StandingStart: 1 } } };
/** Rolling start with a resolvable pace car at CarIdx 0 (issue #773). */
const ROLLING_PACE: Record<string, unknown> = {
  DriverInfo: { PaceCarIdx: 0, Drivers: [{ CarIdx: 0, CarIsPaceCar: 1 }, { CarIdx: 1 }] },
};

const FORMATION_FLAGS = Flags.OneLapToGreen; // iRacing holds this through the parade

function feed(
  state: TranslatorState,
  sessionInfo: Record<string, unknown> | null,
  sessionState: number,
  lapDistPct: number,
  sessionFlags: number = FORMATION_FLAGS,
  carIdxLapDistPct?: Array<number | undefined>,
  carIdxTrackSurface?: number[],
): PendingEvent[] {
  const events: PendingEvent[] = [];
  const telemetry = {
    SessionState: sessionState,
    LapDistPct: lapDistPct,
    SessionFlags: sessionFlags,
    ...(carIdxLapDistPct !== undefined ? { CarIdxLapDistPct: carIdxLapDistPct } : {}),
    ...(carIdxTrackSurface !== undefined ? { CarIdxTrackSurface: carIdxTrackSurface } : {}),
  } as unknown as TelemetryData;
  diffPaceLaps(state, telemetry, sessionInfo, (e) => events.push(e));

  return events;
}

/** Seed on a Warmup tick, then enter ParadeLaps at `entryDist` (arms the diff). */
function seedAndEnter(state: TranslatorState, sessionInfo: Record<string, unknown> | null, entryDist: number): void {
  feed(state, sessionInfo, SessionState.Warmup, 0.5);
  feed(state, sessionInfo, SessionState.ParadeLaps, entryDist);
}

const ONE_PACE_LAP = { event: "flag.one-pace-lap-to-go.raised", data: {} } as const;

describe("diffPaceLaps", () => {
  it("fires once at the first-pace-lap completion crossing on a rolling start", () => {
    const state = createInitialState();
    seedAndEnter(state, ROLLING, 0.3);

    feed(state, ROLLING, SessionState.ParadeLaps, 0.8); // accrued 0.5
    feed(state, ROLLING, SessionState.ParadeLaps, 0.99); // accrued ~0.69
    const events = feed(state, ROLLING, SessionState.ParadeLaps, 0.02); // S/F wrap, accrued >= 0.5

    expect(events).toEqual([ONE_PACE_LAP]);
    expect(state.onePaceLapToGoFired).toBe(true);
  });

  it("does NOT fire on the grid-release crossing (accrued ~0), but does at the completion", () => {
    const state = createInitialState();
    seedAndEnter(state, ROLLING, 0.98); // entered just before S/F

    // Grid-release crossing almost immediately — too little accrued.
    const release = feed(state, ROLLING, SessionState.ParadeLaps, 0.02);
    expect(release).toEqual([]);

    // Drive a full pace lap, then the completion crossing fires.
    feed(state, ROLLING, SessionState.ParadeLaps, 0.5); // accrued ~0.52
    feed(state, ROLLING, SessionState.ParadeLaps, 0.99); // accrued ~1.01
    const completion = feed(state, ROLLING, SessionState.ParadeLaps, 0.03);

    expect(completion).toEqual([ONE_PACE_LAP]);
  });

  it("latches — a second crossing does not re-fire", () => {
    const state = createInitialState();
    seedAndEnter(state, ROLLING, 0.3);
    feed(state, ROLLING, SessionState.ParadeLaps, 0.99);
    feed(state, ROLLING, SessionState.ParadeLaps, 0.02); // first completion fires

    feed(state, ROLLING, SessionState.ParadeLaps, 0.99);
    const again = feed(state, ROLLING, SessionState.ParadeLaps, 0.02);

    expect(again).toEqual([]);
  });

  it("never fires on a standing start", () => {
    const state = createInitialState();
    seedAndEnter(state, STANDING, 0.3);
    feed(state, STANDING, SessionState.ParadeLaps, 0.99);
    const events = feed(state, STANDING, SessionState.ParadeLaps, 0.02);

    expect(events).toEqual([]);
  });

  it("stays silent on a 1-lap formation (green held at the only crossing)", () => {
    const state = createInitialState();
    seedAndEnter(state, ROLLING, 0.3);
    feed(state, ROLLING, SessionState.ParadeLaps, 0.99, FORMATION_FLAGS | Flags.GreenHeld);
    // The single lap's S/F crossing coincides with the green being held.
    const events = feed(state, ROLLING, SessionState.ParadeLaps, 0.02, FORMATION_FLAGS | Flags.GreenHeld);

    expect(events).toEqual([]);
  });

  it("suppresses when StartGo or Green is set at the crossing", () => {
    for (const flag of [Flags.StartGo, Flags.Green]) {
      const state = createInitialState();
      seedAndEnter(state, ROLLING, 0.3);
      feed(state, ROLLING, SessionState.ParadeLaps, 0.99);
      const events = feed(state, ROLLING, SessionState.ParadeLaps, 0.02, FORMATION_FLAGS | flag);

      expect(events).toEqual([]);
    }
  });

  it("suppresses when OneLapToGreen is not set (formation not in progress)", () => {
    const state = createInitialState();
    seedAndEnter(state, ROLLING, 0.3);
    feed(state, ROLLING, SessionState.ParadeLaps, 0.99, 0);
    const events = feed(state, ROLLING, SessionState.ParadeLaps, 0.02, 0);

    expect(events).toEqual([]);
  });

  it("does not arm when connecting mid-parade (first tick already ParadeLaps)", () => {
    const state = createInitialState();
    // First-ever tick is ParadeLaps — seeds without arming.
    feed(state, ROLLING, SessionState.ParadeLaps, 0.3);
    feed(state, ROLLING, SessionState.ParadeLaps, 0.99);
    const events = feed(state, ROLLING, SessionState.ParadeLaps, 0.02);

    expect(events).toEqual([]);
    expect(state.paceLapArmed).toBe(false);
  });

  it("does not fire on the first tick even mid-formation", () => {
    const state = createInitialState();
    const events = feed(state, ROLLING, SessionState.ParadeLaps, 0.02);

    expect(events).toEqual([]);
    expect(state.paceLapInitialized).toBe(true);
  });

  it("resets the latch and arming when leaving ParadeLaps (next formation re-arms)", () => {
    const state = createInitialState();
    seedAndEnter(state, ROLLING, 0.3);
    feed(state, ROLLING, SessionState.ParadeLaps, 0.99);
    feed(state, ROLLING, SessionState.ParadeLaps, 0.02); // fires

    feed(state, ROLLING, SessionState.Racing, 0.1); // race underway → reset
    expect(state.paceLapArmed).toBe(false);
    expect(state.onePaceLapToGoFired).toBe(false);

    // A later formation (e.g. a new session) arms and fires again.
    seedAndEnter(state, ROLLING, 0.3);
    feed(state, ROLLING, SessionState.ParadeLaps, 0.99);
    const events = feed(state, ROLLING, SessionState.ParadeLaps, 0.02);
    expect(events).toEqual([ONE_PACE_LAP]);
  });

  it("does not fire on the grid-release crossing after a backward LapDistPct jitter", () => {
    const state = createInitialState();
    seedAndEnter(state, ROLLING, 0.98); // entered just before S/F
    // Packed-grid concertina nudges the longitudinal position backward — must
    // count as zero forward, NOT ~a full lap each (the mod-1 fold trap).
    feed(state, ROLLING, SessionState.ParadeLaps, 0.97);
    feed(state, ROLLING, SessionState.ParadeLaps, 0.96);
    // Grid-release crossing — still ~0 lap driven, so it must stay suppressed.
    const release = feed(state, ROLLING, SessionState.ParadeLaps, 0.02);

    expect(release).toEqual([]);
    expect(state.onePaceLapToGoFired).toBe(false);
  });

  it("skips a NaN LapDistPct tick without poisoning accrual or firing", () => {
    const state = createInitialState();
    seedAndEnter(state, ROLLING, 0.98);
    // NaN passes `typeof === "number"`; it must be skipped, not folded into accrual.
    const nanTick = feed(state, ROLLING, SessionState.ParadeLaps, Number.NaN);
    expect(nanTick).toEqual([]);
    expect(Number.isFinite(state.paceLapAccrued)).toBe(true);

    // Grid release stays suppressed — accrual was not poisoned into firing.
    const release = feed(state, ROLLING, SessionState.ParadeLaps, 0.02);
    expect(release).toEqual([]);
  });

  it("arms on the next valid tick when the ParadeLaps entry tick has an invalid distance", () => {
    const state = createInitialState();
    feed(state, ROLLING, SessionState.Warmup, 0.5); // seed (not in parade)
    // Entry into ParadeLaps but LapDistPct not settled yet (the `-1` sentinel).
    feed(state, ROLLING, SessionState.ParadeLaps, -1);
    // The first VALID tick must still be treated as the entry edge and arm.
    feed(state, ROLLING, SessionState.ParadeLaps, 0.3);
    expect(state.paceLapArmed).toBe(true);

    feed(state, ROLLING, SessionState.ParadeLaps, 0.99);
    const events = feed(state, ROLLING, SessionState.ParadeLaps, 0.02);
    expect(events).toEqual([ONE_PACE_LAP]);
  });
});

describe("diffPaceLaps — pace car crossing source (issue #773)", () => {
  it("fires at the PACE CAR's completion crossing, before the player reaches the line", () => {
    const state = createInitialState();
    feed(state, ROLLING_PACE, SessionState.Warmup, 0.5, FORMATION_FLAGS, [0.98, 0.94]);
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.94, FORMATION_FLAGS, [0.98, 0.94]); // entry — tracks car 0
    expect(state.paceLapSourceCarIdx).toBe(0);

    // The pace car wraps its release crossing at ~0 accrued — suppressed.
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.96, FORMATION_FLAGS, [0.02, 0.96]);
    // Both drive a pace lap; the pace car reaches S/F first.
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.5, FORMATION_FLAGS, [0.6, 0.5]);
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.9, FORMATION_FLAGS, [0.99, 0.9]);

    // Pace car crosses S/F (player still at 0.95) — the cue fires HERE.
    const paceCross = feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.95, FORMATION_FLAGS, [0.03, 0.95]);
    expect(paceCross).toEqual([ONE_PACE_LAP]);

    // The player's own later crossing adds nothing.
    const playerCross = feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.02, FORMATION_FLAGS, [0.08, 0.02]);
    expect(playerCross).toEqual([]);
  });

  it("resolves the pace car from the Drivers scan when PaceCarIdx is absent", () => {
    const sessionInfo: Record<string, unknown> = {
      DriverInfo: { Drivers: [{ CarIdx: 3 }, { CarIdx: 7, CarIsPaceCar: 1 }] },
    };
    const state = createInitialState();
    const perCar: Array<number | undefined> = [];
    perCar[7] = 0.9;
    feed(state, sessionInfo, SessionState.Warmup, 0.5, FORMATION_FLAGS, perCar);
    feed(state, sessionInfo, SessionState.ParadeLaps, 0.3, FORMATION_FLAGS, perCar);

    expect(state.paceLapSourceCarIdx).toBe(7);
  });

  it("tracks the player when no pace car resolves (PaceCarIdx -1, no flagged driver)", () => {
    const sessionInfo: Record<string, unknown> = { DriverInfo: { PaceCarIdx: -1, Drivers: [{ CarIdx: 0 }] } };
    const state = createInitialState();
    feed(state, sessionInfo, SessionState.Warmup, 0.5);
    feed(state, sessionInfo, SessionState.ParadeLaps, 0.3);
    expect(state.paceLapSourceCarIdx).toBeNull();

    feed(state, sessionInfo, SessionState.ParadeLaps, 0.99);
    const events = feed(state, sessionInfo, SessionState.ParadeLaps, 0.02);
    expect(events).toEqual([ONE_PACE_LAP]);
  });

  it("tracks the player when the pace car resolves but reports no valid distance at entry", () => {
    const state = createInitialState();
    feed(state, ROLLING_PACE, SessionState.Warmup, 0.5, FORMATION_FLAGS, [-1, 0.3]);
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.3, FORMATION_FLAGS, [-1, 0.3]);

    expect(state.paceLapSourceCarIdx).toBeNull();
    expect(state.paceLapArmed).toBe(true);
  });

  it("switches to the player mid-parade when the pace car's telemetry goes invalid — no phantom wrap", () => {
    const state = createInitialState();
    feed(state, ROLLING_PACE, SessionState.Warmup, 0.5, FORMATION_FLAGS, [0.3, 0.1]);
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.1, FORMATION_FLAGS, [0.3, 0.1]); // entry — pace car
    expect(state.paceLapSourceCarIdx).toBe(0);
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.3, FORMATION_FLAGS, [0.9, 0.3]); // accrued 0.6

    // Pace car telemetry drops out. The naive 0.9 → 0.35 source jump would
    // read as an S/F wrap with enough accrued to fire — the switch must
    // re-anchor on the player without folding a delta instead.
    const switchTick = feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.35, FORMATION_FLAGS, [-1, 0.35]);
    expect(switchTick).toEqual([]);
    expect(state.paceLapSourceCarIdx).toBeNull();
    expect(state.onePaceLapToGoFired).toBe(false);

    // The player finishes the pace lap — accrued carries over, the cue fires.
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.99, FORMATION_FLAGS, [-1, 0.99]);
    const events = feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.02, FORMATION_FLAGS, [-1, 0.02]);
    expect(events).toEqual([ONE_PACE_LAP]);
  });

  it("re-acquires the pace car after a transient telemetry blip", () => {
    const state = createInitialState();
    feed(state, ROLLING_PACE, SessionState.Warmup, 0.5, FORMATION_FLAGS, [0.3, 0.1]);
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.1, FORMATION_FLAGS, [0.3, 0.1]); // entry — pace car
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.3, FORMATION_FLAGS, [0.9, 0.3]); // accrued 0.6

    // One-tick blip — downgrade to the player (re-anchored).
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.35, FORMATION_FLAGS, [-1, 0.35]);
    expect(state.paceLapSourceCarIdx).toBeNull();

    // Pace car data returns — the source flips straight back (re-anchored),
    // so the cue still keys on the pace car's crossing, not the player's.
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.4, FORMATION_FLAGS, [0.93, 0.4]);
    expect(state.paceLapSourceCarIdx).toBe(0);

    const events = feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.45, FORMATION_FLAGS, [0.02, 0.45]);
    expect(events).toEqual([ONE_PACE_LAP]);
  });

  it("ignores the pace car once it peels into pit lane — no false fire on a 1-lap formation", () => {
    const state = createInitialState();
    const onTrack = [TrkLoc.OnTrack, TrkLoc.OnTrack];
    const paceInPits = [TrkLoc.AproachingPits, TrkLoc.OnTrack];
    feed(state, ROLLING_PACE, SessionState.Warmup, 0.5, FORMATION_FLAGS, [0.3, 0.1], onTrack);
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.1, FORMATION_FLAGS, [0.3, 0.1], onTrack); // entry
    feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.5, FORMATION_FLAGS, [0.9, 0.5], onTrack); // accrued 0.6

    // The pace car dives into pit lane at the end of the single pace lap —
    // the source flips to the player (re-anchored) and the pace car's
    // pit-lane pass of the timing line no longer counts as a crossing.
    const peel = feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.55, FORMATION_FLAGS, [0.95, 0.55], paceInPits);
    expect(peel).toEqual([]);
    expect(state.paceLapSourceCarIdx).toBeNull();

    const pitPass = feed(state, ROLLING_PACE, SessionState.ParadeLaps, 0.6, FORMATION_FLAGS, [0.02, 0.6], paceInPits);
    expect(pitPass).toEqual([]);
    expect(state.onePaceLapToGoFired).toBe(false);
  });

  it("resolvePaceCarIdx prefers PaceCarIdx, falls back to the scan, and returns null otherwise", () => {
    expect(resolvePaceCarIdx({ DriverInfo: { PaceCarIdx: 2 } })).toBe(2);
    expect(resolvePaceCarIdx({ DriverInfo: { PaceCarIdx: -1, Drivers: [{ CarIdx: 5, CarIsPaceCar: 1 }] } })).toBe(5);
    expect(resolvePaceCarIdx({ DriverInfo: { PaceCarIdx: -1, Drivers: [{ CarIdx: 5 }] } })).toBeNull();
    expect(resolvePaceCarIdx(null)).toBeNull();
    expect(resolvePaceCarIdx({})).toBeNull();
  });
});
