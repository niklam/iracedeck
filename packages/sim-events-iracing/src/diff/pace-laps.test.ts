/**
 * Unit tests for the rolling-start "one pace lap to go" diff (issue #657).
 *
 * The cue fires at the start/finish crossing that COMPLETES the first full pace
 * lap of a rolling formation (≈1 lap accrued since entering ParadeLaps), while
 * the green is not yet held — NOT on the grid-release crossing (≈0 accrued) and
 * never on a standing start or after the race finishes.
 */
import { Flags, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffPaceLaps } from "./pace-laps.js";
import type { PendingEvent } from "./types.js";

/** Rolling start (StandingStart not set). */
const ROLLING: Record<string, unknown> | null = null;
/** Standing start. */
const STANDING: Record<string, unknown> = { WeekendInfo: { WeekendOptions: { StandingStart: 1 } } };

const FORMATION_FLAGS = Flags.OneLapToGreen; // iRacing holds this through the parade

function feed(
  state: TranslatorState,
  sessionInfo: Record<string, unknown> | null,
  sessionState: number,
  lapDistPct: number,
  sessionFlags: number = FORMATION_FLAGS,
): PendingEvent[] {
  const events: PendingEvent[] = [];
  const telemetry = { SessionState: sessionState, LapDistPct: lapDistPct, SessionFlags: sessionFlags } as TelemetryData;
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
