/**
 * Unit tests for the gap diff (issue #933).
 *
 * Pins:
 *   - Crossing-time live gaps to both class neighbors after warm-up
 *   - Cold start (no trace coverage) → gapSeconds null
 *   - Lapped neighbor → lapDelta counted, no time gap requirement
 *   - Non-race session clears the live snapshots
 *   - Pace-car exclusion in neighbor resolution
 *   - Neighbor identity change resets the side's trend state
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffGaps, GAP_DEFAULT_ALERT_THRESHOLD_S } from "./gaps.js";
import type { PendingEvent } from "./types.js";

const PLAYER = 0;
const AHEAD = 1;
const BEHIND = 2;

/**
 * Three-car single-class field. Progress in laps; SessionTime in seconds.
 * All cars run identical 90 s laps offset by fixed time gaps, so crossing-time
 * gaps are exact and assertable.
 */
function tick(sessionTime: number, progressByCar: number[], overrides: Partial<TelemetryData> = {}): TelemetryData {
  const n = progressByCar.length;

  return {
    SessionTime: sessionTime,
    OnPitRoad: false,
    IsOnTrack: true,
    LapCompleted: Math.floor(progressByCar[PLAYER]!),
    SessionState: 4, // racing (past pre-green)
    CarIdxLapCompleted: progressByCar.map((p) => Math.floor(p)),
    CarIdxLapDistPct: progressByCar.map((p) => p - Math.floor(p)),
    CarIdxClass: new Array(n).fill(10),
    CarIdxOnPitRoad: new Array(n).fill(false),
    CarIdxTrackSurface: new Array(n).fill(3), // TrkLoc.OnTrack
    ...overrides,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

/**
 * Drive the diff through a constant-speed run: every car advances in
 * lockstep, AHEAD leading the player by `aheadGapS` seconds and BEHIND
 * trailing by `behindGapS` (converted to progress via the 90 s lap time).
 */
function run(
  state: TranslatorState,
  emit: (e: PendingEvent) => void,
  opts: { fromLap: number; toLap: number; aheadGapS: number; behindGapS: number },
): void {
  const lapTime = 90;
  const step = 0.005; // laps per tick

  for (let i = 0; ; i++) {
    const p = opts.fromLap + i * step;

    if (p > opts.toLap) break;

    diffGaps(
      state,
      tick(p * lapTime, [p, p + opts.aheadGapS / lapTime, p - opts.behindGapS / lapTime]),
      true,
      PLAYER,
      null,
      [2, 1, 3],
      () => GAP_DEFAULT_ALERT_THRESHOLD_S,
      emit,
    );
  }
}

describe("diffGaps — live gaps", () => {
  it("computes crossing-time gaps to both class neighbors after warm-up", () => {
    const state = createInitialState();
    const { emit } = collect();

    run(state, emit, { fromLap: 1, toLap: 2.5, aheadGapS: 2.0, behindGapS: 3.5 });

    expect(state.gapLiveAhead?.carIdx).toBe(AHEAD);
    expect(state.gapLiveAhead?.gapSeconds).toBeCloseTo(2.0, 1);
    expect(state.gapLiveAhead?.lapDelta).toBe(0);
    expect(state.gapLiveBehind?.carIdx).toBe(BEHIND);
    expect(state.gapLiveBehind?.gapSeconds).toBeCloseTo(3.5, 1);
  });

  it("reports null gapSeconds before the traces cover the lookup point (cold start)", () => {
    const state = createInitialState();
    const { emit } = collect();

    // Single tick — no history at all.
    diffGaps(state, tick(90, [1.0, 1.02, 0.98]), true, PLAYER, null, [2, 1, 3], () => 1.0, emit);

    expect(state.gapLiveAhead?.gapSeconds).toBeNull();
  });

  it("reports lapDelta for a neighbor a full lap up", () => {
    const state = createInitialState();
    const { emit } = collect();

    run(state, emit, { fromLap: 1, toLap: 2.5, aheadGapS: 100, behindGapS: 2 }); // 100 s ≈ 1.1 laps

    expect(state.gapLiveAhead?.lapDelta).toBe(1);
  });

  it("clears live gaps outside race sessions", () => {
    const state = createInitialState();
    const { emit } = collect();

    run(state, emit, { fromLap: 1, toLap: 1.5, aheadGapS: 2, behindGapS: 2 });
    diffGaps(state, tick(200, [1.5, 1.52, 1.48]), false, PLAYER, null, [2, 1, 3], () => 1.0, emit);

    expect(state.gapLiveAhead).toBeNull();
    expect(state.gapLiveBehind).toBeNull();
  });

  it("excludes the pace car from neighbor resolution", () => {
    const state = createInitialState();
    const { emit } = collect();

    // paceCarIdx = AHEAD → the ahead slot must be empty (no other class car ahead).
    diffGaps(state, tick(90, [1.0, 1.02, 0.98]), true, PLAYER, AHEAD, [2, 1, 3], () => 1.0, emit);

    expect(state.gapAheadIdx).toBe(-1);
    expect(state.gapBehindIdx).toBe(BEHIND);
  });

  it("resets a side's trend state when the neighbor's identity changes", () => {
    const state = createInitialState();
    const { emit } = collect();

    run(state, emit, { fromLap: 1, toLap: 2.2, aheadGapS: 2, behindGapS: 2 });
    expect(state.gapCheckpointsAhead.length).toBeGreaterThan(0);

    // Swap the ahead neighbor: the order now ranks car 2 directly ahead.
    diffGaps(state, tick(200, [2.2, 2.25, 2.22]), true, PLAYER, null, [2, 3, 1], () => 1.0, emit);

    expect(state.gapAheadIdx).toBe(BEHIND);
    expect(state.gapCheckpointsAhead.length).toBeLessThanOrEqual(1);
  });
});
