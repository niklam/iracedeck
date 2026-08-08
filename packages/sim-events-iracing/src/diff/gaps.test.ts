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

/** A gap spec: constant seconds, or [start, end] linearly interpolated over the segment. */
type GapSpec = number | [number, number];

function gapAt(spec: GapSpec, fraction: number): number {
  return typeof spec === "number" ? spec : spec[0] + (spec[1] - spec[0]) * fraction;
}

/**
 * Drive the diff through a run: every car advances in lockstep, AHEAD
 * leading the player by `aheadGapS` seconds and BEHIND trailing by
 * `behindGapS` (converted to progress via the 90 s lap time). Interpolated
 * gap specs shrink/grow smoothly so no car's progress ever jumps backwards
 * (which would reset its trace).
 */
function run(
  state: TranslatorState,
  emit: (e: PendingEvent) => void,
  opts: {
    fromLap: number;
    toLap: number;
    aheadGapS: GapSpec;
    behindGapS: GapSpec;
    thresholdS?: number;
    overrides?: Partial<TelemetryData>;
  },
): void {
  const lapTime = 90;
  const step = 0.005; // laps per tick
  const span = opts.toLap - opts.fromLap;

  for (let i = 0; ; i++) {
    const p = opts.fromLap + i * step;

    if (p > opts.toLap) break;

    const fraction = span > 0 ? (p - opts.fromLap) / span : 0;
    const aheadGap = gapAt(opts.aheadGapS, fraction);
    const behindGap = gapAt(opts.behindGapS, fraction);

    diffGaps(
      state,
      tick(p * lapTime, [p, p + aheadGap / lapTime, p - behindGap / lapTime], opts.overrides),
      true,
      PLAYER,
      null,
      [2, 1, 3],
      () => opts.thresholdS ?? GAP_DEFAULT_ALERT_THRESHOLD_S,
      emit,
    );
  }
}

function trendEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "gap.trendChanged");
}

function thresholdEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "gap.thresholdCrossed");
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

describe("diffGaps — trend flip events", () => {
  it("emits gap.trendChanged after two consecutive closing laps and not before, without re-emitting while the direction holds", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Laps 1–4 steady at 5.0 s, then closing 1 s/lap for three laps (5→2 over
    // laps 4–7). Directions: lap 5 = closing (prev steady, no emit), lap 6 =
    // closing sustained → EMIT, lap 7 = closing but already announced.
    run(state, emit, { fromLap: 1, toLap: 4, aheadGapS: 5, behindGapS: 3 });
    run(state, emit, { fromLap: 4, toLap: 7, aheadGapS: [5, 2], behindGapS: 3 });

    const flips = trendEvents(events);

    expect(flips).toHaveLength(1);
    expect(flips[0]!.data).toMatchObject({ side: "ahead", direction: "closing", carIdx: AHEAD });

    // Keep closing two more laps — still announced, no second emission.
    run(state, emit, { fromLap: 7, toLap: 9, aheadGapS: [2, 1.8], behindGapS: 3 });
    expect(trendEvents(events)).toHaveLength(1);

    // Two opening laps: lap +1 (prev closing, no emit), lap +2 sustained → EMIT.
    run(state, emit, { fromLap: 9, toLap: 11, aheadGapS: [1.8, 3.8], behindGapS: 3 });
    const after = trendEvents(events);

    expect(after).toHaveLength(2);
    expect(after[1]!.data).toMatchObject({ side: "ahead", direction: "opening" });
  });

  it("stays silent inside the callout deadband", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // ±0.1 s/lap oscillation is inside the 0.2 s callout deadband.
    run(state, emit, { fromLap: 1, toLap: 4, aheadGapS: 5, behindGapS: 3 });
    run(state, emit, { fromLap: 4, toLap: 5, aheadGapS: [5, 5.1], behindGapS: 3 });
    run(state, emit, { fromLap: 5, toLap: 6, aheadGapS: [5.1, 5.0], behindGapS: 3 });
    run(state, emit, { fromLap: 6, toLap: 7, aheadGapS: [5.0, 5.1], behindGapS: 3 });

    expect(trendEvents(events)).toHaveLength(0);
  });
});

describe("diffGaps — threshold events", () => {
  it("arms only after the gap exceeds threshold + hysteresis, fires once per episode, and re-fires only after re-arming", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Start inside the threshold — must NOT fire (never armed).
    run(state, emit, { fromLap: 1, toLap: 2, aheadGapS: 0.8, behindGapS: 5 });
    expect(thresholdEvents(events)).toHaveLength(0);

    // Open past 1.5 s (threshold 1.0 + hysteresis 0.5) → arms; close under 1.0 → one event.
    run(state, emit, { fromLap: 2, toLap: 3, aheadGapS: [0.8, 2.0], behindGapS: 5 });
    run(state, emit, { fromLap: 3, toLap: 4, aheadGapS: [2.0, 0.9], behindGapS: 5 });
    const first = thresholdEvents(events);

    expect(first).toHaveLength(1);
    expect(first[0]!.data).toMatchObject({ side: "ahead", thresholdSeconds: 1.0, carIdx: AHEAD });

    // Oscillate below the re-arm point — no second event.
    run(state, emit, { fromLap: 4, toLap: 5, aheadGapS: [0.9, 1.2], behindGapS: 5 });
    run(state, emit, { fromLap: 5, toLap: 6, aheadGapS: [1.2, 0.9], behindGapS: 5 });
    expect(thresholdEvents(events)).toHaveLength(1);

    // Open past 1.5 again, then close → second event.
    run(state, emit, { fromLap: 6, toLap: 7, aheadGapS: [0.9, 1.7], behindGapS: 5 });
    run(state, emit, { fromLap: 7, toLap: 8, aheadGapS: [1.7, 0.9], behindGapS: 5 });
    expect(thresholdEvents(events)).toHaveLength(2);
  });

  it("suppresses and disarms while the neighbor is on pit road", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Warm up and arm.
    run(state, emit, { fromLap: 1, toLap: 3, aheadGapS: 2.0, behindGapS: 5 });

    // Neighbor pits while the gap collapses under the threshold — no event.
    run(state, emit, {
      fromLap: 3,
      toLap: 4,
      aheadGapS: [2.0, 0.6],
      behindGapS: 5,
      overrides: { CarIdxOnPitRoad: [false, true, false] } as Partial<TelemetryData>,
    });

    expect(thresholdEvents(events)).toHaveLength(0);
    expect(state.gapThresholdArmedAhead).toBe(false);
  });
});
