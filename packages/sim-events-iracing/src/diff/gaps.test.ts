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
import { diffGaps, GAP_DEFAULT_ALERT_THRESHOLD_S, GAP_DEFAULT_MIN_CHANGE_S } from "./gaps.js";
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
    lapsRemaining?: number | null;
    minChangeS?: number;
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
      opts.lapsRemaining ?? null,
      () => opts.minChangeS ?? GAP_DEFAULT_MIN_CHANGE_S,
    );
  }
}

function trendEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "gap.trendChanged");
}

function openingEvents(events: PendingEvent[]): PendingEvent[] {
  return trendEvents(events).filter((e) => (e.data as { direction: string }).direction === "opening");
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

  it("shows a closing display trend within a fraction of a lap of a catch starting (issue #933 follow-up)", () => {
    const state = createInitialState();
    const { emit } = collect();

    // One steady lap establishes the rate chain (trend reads "steady", which
    // is a positive classification, not missing data)...
    run(state, emit, { fromLap: 1, toLap: 2, aheadGapS: 8, behindGapS: 5 });
    expect(state.gapLiveAhead?.trend).toBe("steady");

    // ...then a 1 s/lap catch shows "closing" after only ~0.4 lap — no
    // full-lap warmup (the smoothed-rate model, not same-spot-one-lap-ago).
    run(state, emit, { fromLap: 2, toLap: 2.4, aheadGapS: [8, 7.6], behindGapS: 5 });
    expect(state.gapLiveAhead?.trend).toBe("closing");

    // The behind side is independent and still steady.
    expect(state.gapLiveBehind?.trend).toBe("steady");
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

  it("counts the behind gap down while the player sits stopped on track (issue #933 follow-up: gap froze while cars closed)", () => {
    const state = createInitialState();
    const { emit } = collect();
    const lapTime = 90;

    // Normal running to warm everything up: behind car 6 s back.
    run(state, emit, { fromLap: 1, toLap: 2.5, aheadGapS: 3, behindGapS: 6 });

    // Player stops at p=2.5; the other cars keep lapping at race pace.
    const playerStop = 2.5;
    const stopTime = playerStop * lapTime;
    const readings: number[] = [];

    for (let i = 1; i <= 800; i++) {
      const t = stopTime + i * 0.045; // 45 ms ticks, 36 s total
      const advance = (i * 0.045) / lapTime;
      diffGaps(
        state,
        tick(t, [playerStop, playerStop + 3 / lapTime + advance, playerStop - 6 / lapTime + advance]),
        true,
        PLAYER,
        null,
        [2, 1, 3],
        () => GAP_DEFAULT_ALERT_THRESHOLD_S,
        emit,
      );

      if (i % 100 === 0 && state.gapLiveBehind?.gapSeconds !== null && state.gapLiveBehind !== null) {
        readings.push(state.gapLiveBehind.gapSeconds);
      }
    }

    // The behind gap must COUNT DOWN as the pursuer closes (ETA regime), not
    // freeze at its crossing-time value.
    expect(readings.length).toBeGreaterThanOrEqual(3);
    expect(readings[readings.length - 1]!).toBeLessThan(readings[0]! - 1);
    expect(state.gapLiveBehind?.trend).toBe("closing");

    // The ahead side keeps a sane growing/large reading (the car ahead IS
    // pulling away from a stopped player) — never a countdown.
    expect(state.gapLiveAhead?.gapSeconds === null || state.gapLiveAhead!.gapSeconds! > 3).toBe(true);
  });

  it("resets a side's trend state when the neighbor's identity changes", () => {
    const state = createInitialState();
    const { emit } = collect();

    run(state, emit, { fromLap: 1, toLap: 2.2, aheadGapS: 2, behindGapS: 2 });
    expect(state.gapRateSamplesAhead).toBeGreaterThan(0);

    // Swap the ahead neighbor: the order now ranks car 2 directly ahead.
    diffGaps(state, tick(200, [2.2, 2.25, 2.22]), true, PLAYER, null, [2, 3, 1], () => 1.0, emit);

    expect(state.gapAheadIdx).toBe(BEHIND);
    expect(state.gapRateEmaAhead).toBeNull();
    expect(state.gapRateSamplesAhead).toBe(0);
  });
});

describe("diffGaps — relevance events (issue #933 follow-up)", () => {
  it("announces a closing threat when the contact projection enters the horizon, escalating as it halves", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Catching the car ahead at 1 s/lap from 12 s out. Projection enters the
    // 8-lap horizon when the gap reaches ~8 s, and halves to ≤4 laps at ~4 s.
    run(state, emit, { fromLap: 1, toLap: 10, aheadGapS: [12, 3], behindGapS: 30 });

    const calls = trendEvents(events);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.data).toMatchObject({ side: "ahead", direction: "closing", carIdx: AHEAD });

    const first = calls[0]!.data as { gapSeconds: number; lapsToContact?: number };

    expect(first.lapsToContact).toBeDefined();
    expect(first.lapsToContact!).toBeGreaterThan(6.5);
    expect(first.lapsToContact!).toBeLessThanOrEqual(8.2);

    const second = calls[1]!.data as { lapsToContact?: number };

    expect(second.lapsToContact!).toBeLessThanOrEqual(first.lapsToContact! * 0.55);
  });

  it("stays silent about a catch that completes after the race ends", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Same 1 s/lap catch, but only 3 laps remain: the projection never gets
    // inside min(horizon, lapsRemaining) = 3 laps.
    run(state, emit, { fromLap: 1, toLap: 9, aheadGapS: [12, 4], behindGapS: 30, lapsRemaining: 3 });

    expect(trendEvents(events)).toHaveLength(0);
  });

  it("stays silent about a fast catch on a huge gap (projection outside the horizon)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // 2 s/lap eaten from a 30 s gap — contact in ~15 laps. Irrelevant.
    run(state, emit, { fromLap: 1, toLap: 4, aheadGapS: [30, 24], behindGapS: 30 });

    expect(trendEvents(events)).toHaveLength(0);
  });

  it("announces a breakaway once per episode, mid-lap, with no crossing needed (the lap-1 pull-away case)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Pulling away from a 1.5 s battle at ~3 s/lap on the FIRST lap — the
    // call must come mid-lap, without any start/finish sampling.
    run(state, emit, { fromLap: 1, toLap: 1.7, aheadGapS: 8, behindGapS: [1.5, 3.6] });

    const calls = openingEvents(events);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toMatchObject({ side: "behind", direction: "opening", carIdx: BEHIND });

    // Keep opening past battle range — still one announcement.
    run(state, emit, { fromLap: 1.7, toLap: 4, aheadGapS: 8, behindGapS: [3.6, 12] });
    expect(openingEvents(events)).toHaveLength(1);

    // They claw back into battle range (which itself fires closing-threat
    // calls — filtered out here), then get dropped again far enough to clear
    // the minimum-movement gate → second breakaway.
    run(state, emit, { fromLap: 4, toLap: 7, aheadGapS: 8, behindGapS: [12, 4] });
    run(state, emit, { fromLap: 7, toLap: 9, aheadGapS: 8, behindGapS: [4, 8] });

    const after = openingEvents(events);

    expect(after).toHaveLength(2);
    expect(after[1]!.data).toMatchObject({ side: "behind", direction: "opening" });
  });

  it("never announces pulling away on an already-broken gap", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Opening 2 s/lap on a 30 s gap — nothing changes, stay quiet.
    run(state, emit, { fromLap: 1, toLap: 4, aheadGapS: 8, behindGapS: [30, 36] });

    expect(trendEvents(events)).toHaveLength(0);
  });

  it("gates ping-ponging announcements until the gap has moved by the minimum change (issue #933 follow-up)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Breakaway announced shortly after the pull starts (gap ≈ 2.7 s)...
    run(state, emit, { fromLap: 1, toLap: 2, aheadGapS: 8, behindGapS: [2.5, 4.0] });
    expect(trendEvents(events)).toHaveLength(1);

    // ...then the gap hovers around 3.7–4.0 — within the 1.5 s movement gate
    // of the announcement — with hard short-term rates in both directions
    // (the exact "dropping them" → "closing in" → "dropping them" ping-pong
    // from track testing). Nothing new may be announced.
    run(state, emit, { fromLap: 2, toLap: 2.1, aheadGapS: 8, behindGapS: [4.0, 3.7] });
    run(state, emit, { fromLap: 2.1, toLap: 2.2, aheadGapS: 8, behindGapS: [3.7, 4.0] });
    run(state, emit, { fromLap: 2.2, toLap: 2.3, aheadGapS: 8, behindGapS: [4.0, 3.7] });

    expect(trendEvents(events)).toHaveLength(1);

    // With the gate disabled (0), the same hover chatters — proving the gate
    // is what holds it back.
    const state2 = createInitialState();
    const { events: events2, emit: emit2 } = collect();

    run(state2, emit2, { fromLap: 1, toLap: 2, aheadGapS: 8, behindGapS: [2.5, 4.0], minChangeS: 0 });
    run(state2, emit2, { fromLap: 2, toLap: 2.1, aheadGapS: 8, behindGapS: [4.0, 3.7], minChangeS: 0 });

    expect(trendEvents(events2).length).toBeGreaterThan(1);
  });

  it("assumes grid spacing on the opening lap: no 'right with us' off the start, but a genuine lap-1 breakaway still announces", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Lap 1 (LapCompleted = 0): the car behind starts at grid spacing, drops
    // back past the threshold re-arm point, then closes right back under the
    // 1.0 s threshold — the field sorting itself out. Without the grid
    // assumption this fires "the car behind is right with us" (threshold) and
    // closing/opening trend calls; with it, everything stays gated because
    // nothing moved 1.5 s from the assumed 0.7 s spacing.
    run(state, emit, { fromLap: 0.05, toLap: 0.45, aheadGapS: 30, behindGapS: [0.7, 1.7] });
    run(state, emit, { fromLap: 0.45, toLap: 0.75, aheadGapS: 30, behindGapS: [1.7, 0.8] });

    expect(trendEvents(events)).toHaveLength(0);
    expect(thresholdEvents(events)).toHaveLength(0);

    // Still on lap 1: a genuine pull to 3 s clears the movement gate from the
    // assumed spacing → the breakaway announces before the line.
    run(state, emit, { fromLap: 0.75, toLap: 1.0, aheadGapS: 30, behindGapS: [0.8, 3.0] });

    const calls = openingEvents(events);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toMatchObject({ side: "behind", direction: "opening", carIdx: BEHIND });
  });

  it("treats sub-bar rates as noise", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // ±0.1 s/lap wobble is below both the closing (0.2) and breakaway (0.5) bars.
    run(state, emit, { fromLap: 1, toLap: 4, aheadGapS: 5, behindGapS: 3 });
    run(state, emit, { fromLap: 4, toLap: 5, aheadGapS: [5, 5.1], behindGapS: [3, 3.1] });
    run(state, emit, { fromLap: 5, toLap: 6, aheadGapS: [5.1, 5.0], behindGapS: [3.1, 3.0] });

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
