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
 *   - Trend callouts read the lap-over-lap gap, not the within-lap rate
 *     (issue #1285), against a synthetic two-car track
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import {
  diffGaps,
  GAP_DEFAULT_ALERT_THRESHOLD_S,
  GAP_DEFAULT_MIN_CHANGE_S,
  sanitizeGapAlertThresholdSeconds,
  sanitizeGapMinChangeSeconds,
} from "./gaps.js";
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
    /** Superimpose a lap-periodic ±amplitude oscillation on the behind gap (sector profiles). */
    behindOscillateS?: number;
    overrides?: Partial<TelemetryData>;
    trackLengthMeters?: number | null;
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
    const behindGap = gapAt(opts.behindGapS, fraction) + (opts.behindOscillateS ?? 0) * Math.sin(2 * Math.PI * p);

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
      opts.trackLengthMeters ?? null,
    );
  }
}

function trendEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "gap.trendChanged");
}

function openingEvents(events: PendingEvent[]): PendingEvent[] {
  return trendEvents(events).filter((e) => (e.data as { direction: string }).direction === "opening");
}

function closingEvents(events: PendingEvent[]): PendingEvent[] {
  return trendEvents(events).filter((e) => (e.data as { direction: string }).direction === "closing");
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

  /**
   * The player stops on track at p=2.5 while the other cars keep lapping at
   * race pace (90 s laps). Returns the behind gap sampled every 100 ticks
   * and whether the behind side ever read in the ETA regime.
   */
  function runStoppedPlayer(trackLengthMeters: number | null): {
    state: TranslatorState;
    readings: number[];
    etaSeen: boolean;
  } {
    const state = createInitialState();
    const { emit } = collect();
    const lapTime = 90;

    // Normal running to warm everything up: behind car 6 s back.
    run(state, emit, { fromLap: 1, toLap: 2.5, aheadGapS: 3, behindGapS: 6, trackLengthMeters });

    const playerStop = 2.5;
    const stopTime = playerStop * lapTime;
    const readings: number[] = [];
    let etaSeen = false;

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
        null,
        () => GAP_DEFAULT_MIN_CHANGE_S,
        trackLengthMeters,
      );

      etaSeen ||= state.gapEtaReadingBehind;

      if (i % 100 === 0 && state.gapLiveBehind?.gapSeconds !== null && state.gapLiveBehind !== null) {
        readings.push(state.gapLiveBehind.gapSeconds);
      }
    }

    return { state, readings, etaSeen };
  }

  it("counts the behind gap down while the player sits stopped on track (issue #933 follow-up: gap froze while cars closed)", () => {
    // A 4 km track: the stopped player's 3 s average drops under the 8 m/s
    // crawl bar within a few seconds (issue #1285).
    const { state, readings, etaSeen } = runStoppedPlayer(4000);

    // The behind gap must COUNT DOWN as the pursuer closes (ETA regime), not
    // freeze at its crossing-time value.
    expect(etaSeen).toBe(true);
    expect(readings.length).toBeGreaterThanOrEqual(3);
    expect(readings[readings.length - 1]!).toBeLessThan(readings[0]! - 1);
    expect(state.gapLiveBehind?.trend).toBe("closing");

    // The ahead side keeps a sane growing/large reading (the car ahead IS
    // pulling away from a stopped player) — never a countdown.
    expect(state.gapLiveAhead?.gapSeconds === null || state.gapLiveAhead!.gapSeconds! > 3).toBe(true);
  });

  it("never enters the ETA regime without a track length — the stopped player's gap stays crossing-time (issue #1285)", () => {
    // Unknown track length: the crawl bar cannot be evaluated, so the regime
    // stays off and the reading is the frozen crossing-time gap (the
    // pre-#933-follow-up behaviour) rather than a guess.
    const { readings, etaSeen } = runStoppedPlayer(null);

    expect(etaSeen).toBe(false);
    expect(readings.length).toBeGreaterThanOrEqual(1);
    expect(readings[0]!).toBeCloseTo(6, 0);
  });

  it("ignores a NaN telemetry sample instead of poisoning the car's trace (issue #933 review)", () => {
    const state = createInitialState();
    const { emit } = collect();
    const lapTime = 90;

    run(state, emit, { fromLap: 1, toLap: 2, aheadGapS: 2, behindGapS: 3 });

    // One frame where the ahead car's lap percentage reads NaN. A range-only
    // guard lets it through, and a NaN in a trace is permanent: every
    // comparison against it is false, so it is never pruned or deduped and
    // every later crossing lookup runs on non-monotonic data.
    const p = 2.005;
    const base = tick(p * lapTime, [p, p + 2 / lapTime, p - 3 / lapTime]);
    const pct = base.CarIdxLapDistPct as number[];

    diffGaps(
      state,
      { ...base, CarIdxLapDistPct: [pct[0]!, Number.NaN, pct[2]!] } as unknown as TelemetryData,
      true,
      PLAYER,
      null,
      [2, 1, 3],
      () => GAP_DEFAULT_ALERT_THRESHOLD_S,
      emit,
    );

    run(state, emit, { fromLap: 2.01, toLap: 3, aheadGapS: 2, behindGapS: 3 });

    expect(state.gapTraces[AHEAD]!.every((s) => Number.isFinite(s.progress))).toBe(true);
    expect(state.gapLiveAhead?.gapSeconds).toBeCloseTo(2.0, 1);
  });

  it("clears the trend chain AND the callout episodes when the player tows backwards (issue #933 review)", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const lapTime = 90;

    // A steady catch builds a rate on the ahead side, and the gap sits well
    // above threshold + hysteresis, so the threshold episode is armed.
    run(state, emit, { fromLap: 1, toLap: 3, aheadGapS: [8, 6], behindGapS: 20 });
    expect(state.gapRateSamplesAhead).toBeGreaterThan(5);
    expect(state.gapLapRateWindowAhead.length).toBeGreaterThan(0);
    expect(state.gapThresholdArmedAhead).toBe(true);

    // Tow to an earlier point on the track. Without a reset the checkpoint
    // anchor sits AHEAD of the player, so the chain is neither sampled nor
    // reset for up to a lap and the pre-tow rate keeps coloring the rows.
    diffGaps(
      state,
      tick(3 * lapTime + 30, [2.5, 3 + 6 / lapTime, 3 - 20 / lapTime]),
      true,
      PLAYER,
      null,
      [2, 1, 3],
      () => GAP_DEFAULT_ALERT_THRESHOLD_S,
      emit,
    );

    expect(state.gapRateEmaAhead).toBeNull();
    expect(state.gapRateSamplesAhead).toBe(0);
    expect(state.gapLiveAhead?.trend).toBeNull();

    // ...and the lap history (issue #1285): a same-spot comparison across the
    // tow would compare two different stories. It restarts from the post-tow
    // reading alone.
    expect(state.gapLapHistoryAhead.map((h) => h.progress)).toEqual([2.5]);
    expect(state.gapLapRateWindowAhead).toHaveLength(0);

    // The whole episode is void, not just the rate chain: a threshold armed
    // before the tow must not survive it, or the first stable gap afterwards
    // fires a crossing belonging to a race that no longer exists.
    expect(state.gapThresholdArmedAhead).toBe(false);
    expect(state.gapMaxSinceAnnounceAhead).toBeNull();
    expect(state.gapMinSinceAnnounceAhead).toBeNull();

    // Running below the threshold afterwards stays silent — it has to re-arm.
    run(state, emit, { fromLap: 2.55, toLap: 3.6, aheadGapS: 0.8, behindGapS: 20 });
    expect(thresholdEvents(events)).toHaveLength(0);

    // Re-arm above threshold + hysteresis, then close back under it → one call.
    run(state, emit, { fromLap: 3.6, toLap: 4.3, aheadGapS: [0.8, 2.0], behindGapS: 20 });
    run(state, emit, { fromLap: 4.3, toLap: 5.2, aheadGapS: [2.0, 0.8], behindGapS: 20 });
    expect(thresholdEvents(events)).toHaveLength(1);
  });

  it("ignores every non-finite SessionTime instead of stamping it into every trace (issue #933 review)", () => {
    const state = createInitialState();
    const { emit } = collect();
    const lapTime = 90;

    run(state, emit, { fromLap: 1, toLap: 2, aheadGapS: 2, behindGapS: 3 });

    // `typeof x === "number"` holds for all three, so a bare numeric check
    // would accept them and stamp one into every car's trace at once.
    const p = 2.005;
    const base = tick(p * lapTime, [p, p + 2 / lapTime, p - 3 / lapTime]);

    for (const sessionTime of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      diffGaps(
        state,
        { ...base, SessionTime: sessionTime } as unknown as TelemetryData,
        true,
        PLAYER,
        null,
        [2, 1, 3],
        () => GAP_DEFAULT_ALERT_THRESHOLD_S,
        emit,
      );

      for (const trace of state.gapTraces) {
        if (trace) expect(trace.every((s) => Number.isFinite(s.time))).toBe(true);
      }
    }

    run(state, emit, { fromLap: 2.01, toLap: 3, aheadGapS: 2, behindGapS: 3 });
    expect(state.gapLiveAhead?.gapSeconds).toBeCloseTo(2.0, 1);
  });

  it("tracks the announcement extremes before the trend chain warms up (issue #933 review)", () => {
    const state = createInitialState();
    const { emit } = collect();

    // Long enough for the gaps to resolve and the stability streak to pass,
    // far short of the 5 checkpoints (0.1 lap) the trend EMA needs. The
    // threshold gate compares against these extremes, so folding them only
    // on the EMA-warm path would leave that gate reading a bare seed.
    run(state, emit, { fromLap: 1, toLap: 1.09, aheadGapS: 2, behindGapS: 2 });

    expect(state.gapRateSamplesAhead).toBeLessThan(5);
    expect(state.gapMaxSinceAnnounceAhead).toBeCloseTo(2.0, 1);
    expect(state.gapMinSinceAnnounceAhead).toBeCloseTo(2.0, 1);
  });

  it("resets a side's trend state when the neighbor's identity changes", () => {
    const state = createInitialState();
    const { emit } = collect();

    run(state, emit, { fromLap: 1, toLap: 2.2, aheadGapS: 2, behindGapS: 2 });
    expect(state.gapRateSamplesAhead).toBeGreaterThan(0);
    expect(state.gapLapRateWindowAhead.length).toBeGreaterThan(0);

    // Swap the ahead neighbor: the order now ranks car 2 directly ahead.
    diffGaps(state, tick(200, [2.2, 2.25, 2.22]), true, PLAYER, null, [2, 3, 1], () => 1.0, emit);

    expect(state.gapAheadIdx).toBe(BEHIND);
    expect(state.gapRateEmaAhead).toBeNull();
    expect(state.gapRateSamplesAhead).toBe(0);
    expect(state.gapLapHistoryAhead).toHaveLength(0);
    expect(state.gapLapRateWindowAhead).toHaveLength(0);
  });

  it("clears the lap history when a due checkpoint cannot be sampled, so the next lap is silent (issue #1285)", () => {
    const state = createInitialState();
    const { emit } = collect();

    run(state, emit, { fromLap: 1, toLap: 2.5, aheadGapS: 3, behindGapS: 30 });
    expect(state.gapLapRateWindowAhead.length).toBeGreaterThan(0);

    // The car ahead dips into pit road for a checkpoint or two.
    run(state, emit, {
      fromLap: 2.5,
      toLap: 2.55,
      aheadGapS: 3,
      behindGapS: 30,
      overrides: { CarIdxOnPitRoad: [false, true, false] } as Partial<TelemetryData>,
    });
    expect(state.gapLapHistoryAhead).toHaveLength(0);
    expect(state.gapLapRateWindowAhead).toHaveLength(0);

    // Back on track: no lap rate until a lap of same-spot history exists...
    run(state, emit, { fromLap: 2.56, toLap: 3.5, aheadGapS: 3, behindGapS: 30 });
    expect(state.gapLapRateWindowAhead).toHaveLength(0);

    // ...then it comes back.
    run(state, emit, { fromLap: 3.5, toLap: 3.8, aheadGapS: 3, behindGapS: 30 });
    expect(state.gapLapRateWindowAhead.length).toBeGreaterThan(0);
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

  it("announces a breakaway once per episode, mid-lap, with no crossing needed", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // A lap of 1.5 s battle builds the same-spot history (issue #1285)...
    run(state, emit, { fromLap: 1, toLap: 2, aheadGapS: 8, behindGapS: 1.5 });
    expect(trendEvents(events)).toHaveLength(0);

    // ...then pulling away at ~3 s/lap — the call must come mid-lap, without
    // any start/finish sampling.
    run(state, emit, { fromLap: 2, toLap: 2.7, aheadGapS: 8, behindGapS: [1.5, 3.6] });

    const calls = openingEvents(events);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toMatchObject({ side: "behind", direction: "opening", carIdx: BEHIND });

    // Keep opening past battle range — still one announcement.
    run(state, emit, { fromLap: 2.7, toLap: 4, aheadGapS: 8, behindGapS: [3.6, 12] });
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

    // A lap of history at 2.5 s, then a breakaway announced once the pull
    // has genuinely traveled +1.5 s from its trough (gap ≈ 4.0)...
    const scenario = (s: TranslatorState, e: (ev: PendingEvent) => void, minChangeS?: number): void => {
      run(s, e, { fromLap: 1, toLap: 2, aheadGapS: 30, behindGapS: 2.5, minChangeS });
      run(s, e, { fromLap: 2, toLap: 3, aheadGapS: 30, behindGapS: [2.5, 4.4], minChangeS });
    };

    scenario(state, emit);
    expect(trendEvents(events)).toHaveLength(1);

    // ...then the gap comes back ~1.2 s over a lap and a half — a genuine
    // lap-scale reversal with a contact projection well inside the horizon,
    // but not 1.5 s down from the peak since the call. A "closing in" right
    // after "dropping them" contradicts the story (the ping-pong from track
    // testing). Nothing new may be announced.
    const reversal = (s: TranslatorState, e: (ev: PendingEvent) => void, minChangeS?: number): void => {
      run(s, e, { fromLap: 3, toLap: 4, aheadGapS: 30, behindGapS: [4.4, 3.4], minChangeS });
      run(s, e, { fromLap: 4, toLap: 4.5, aheadGapS: 30, behindGapS: [3.4, 3.2], minChangeS });
    };

    reversal(state, emit);
    expect(trendEvents(events)).toHaveLength(1);

    // With the gate disabled (0), the same run announces the reversal —
    // proving the gate is what holds it back.
    const state2 = createInitialState();
    const { events: events2, emit: emit2 } = collect();

    scenario(state2, emit2, 0);
    reversal(state2, emit2, 0);

    expect(trendEvents(events2).length).toBeGreaterThan(1);
    expect(closingEvents(events2).length).toBeGreaterThanOrEqual(1);
  });

  it("assumes grid spacing on the opening lap: no 'right with us' off the start, and a lap-1 breakaway waits for a lap of history", () => {
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
    // assumed spacing, but a trend call reads the lap-over-lap gap and there
    // is no lap before this one (issue #1285) — silent.
    run(state, emit, { fromLap: 0.75, toLap: 1.0, aheadGapS: 30, behindGapS: [0.8, 3.0] });
    expect(trendEvents(events)).toHaveLength(0);

    // The pull continues into lap 2: with a lap of same-spot history the
    // breakaway announces, once.
    run(state, emit, { fromLap: 1.0, toLap: 2.0, aheadGapS: 30, behindGapS: [3.0, 4.0] });

    const calls = openingEvents(events);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toMatchObject({ side: "behind", direction: "opening", carIdx: BEHIND });
  });

  it("ignores a one-or-two-frame telemetry glitch (issue #933 follow-up: 2.4 s read as 0.9 s fired 'right with us')", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const lapTime = 90;

    // Steady 2.4 s gap behind — the threshold episode is armed (2.4 > 1.5).
    run(state, emit, { fromLap: 1, toLap: 3, aheadGapS: 30, behindGapS: 2.4 });
    expect(state.gapThresholdArmedBehind).toBe(true);

    // Two glitched frames: the behind car's telemetry briefly reads 1.5 s
    // closer (gap 0.9 — under the threshold), then corrects back.
    const p = 3.005;

    for (const glitchGap of [0.9, 0.9, 2.4, 2.4]) {
      diffGaps(
        state,
        tick(p * lapTime, [p, p + 30 / lapTime, p - glitchGap / lapTime]),
        true,
        PLAYER,
        null,
        [2, 1, 3],
        () => GAP_DEFAULT_ALERT_THRESHOLD_S,
        emit,
        null,
        () => GAP_DEFAULT_MIN_CHANGE_S,
      );
    }

    expect(thresholdEvents(events)).toHaveLength(0);
    expect(trendEvents(events)).toHaveLength(0);

    // A genuine sustained catch still fires once the reading has been stable.
    run(state, emit, { fromLap: 3.01, toLap: 3.5, aheadGapS: 30, behindGapS: [2.4, 0.8] });
    expect(thresholdEvents(events)).toHaveLength(1);
  });

  it("never says 'closing in' from sector-profile oscillation while the gap genuinely opens (issue #933 follow-up: false 'catching us' at 4.3 s)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // The gap to the car behind opens steadily ~1 s/lap, but the
    // crossing-time reading oscillates ±0.35 s with the pair's sector
    // profiles — every downswing's short-window slope reads "closing hard"
    // with a tiny contact projection. A closing call would contradict the
    // story (the gap sits above everything since the last announcement), so
    // only "pulling away" may ever fire.
    run(state, emit, { fromLap: 1, toLap: 3, aheadGapS: 30, behindGapS: [2.0, 4.0], behindOscillateS: 0.35 });
    run(state, emit, { fromLap: 3, toLap: 5, aheadGapS: 30, behindGapS: [4.0, 5.6], behindOscillateS: 0.35 });

    expect(closingEvents(events)).toHaveLength(0);

    const opens = openingEvents(events);

    expect(opens.length).toBeGreaterThanOrEqual(1);
    expect(opens[0]!.data).toMatchObject({ side: "behind", direction: "opening" });
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

// ── Synthetic two-car track (issue #1285) ─────────────────────────────────
//
// A 4 km lap with two long straights, each ending in a hairpin. Each car's
// speed at a point on the lap is the tightest of its top speed and the
// braking/acceleration envelopes around each hairpin apex, and its position
// at a given time is read off the cumulative time-to-distance table of that
// profile. The profiles are periodic in lap distance, so the gap at the same
// spot one lap later differs by EXACTLY the lap-time difference — while
// within the lap it swings by over a second, because the car ahead is faster
// down both straights and brakes harder, to a slower apex, into both
// hairpins. That is the shape of the issue's Red Bull Ring race.

const TRACK_M = 4000;
const HAIRPIN_APEX_M = [1500, 3500];
/** 20 Hz ticks — iRacing's 60 Hz would triple the runtime for no extra coverage. */
const TRACK_TICK_S = 0.05;

type SpeedProfile = { topMps: number; apexMps: number; brakeMps2: number; accelMps2: number };

const PLAYER_PROFILE: SpeedProfile = { topMps: 78, apexMps: 24, brakeMps2: 10, accelMps2: 6 };
/** Faster down the straights, harder braking into a slower apex. */
const LEADER_PROFILE: SpeedProfile = { topMps: 86, apexMps: 16, brakeMps2: 15, accelMps2: 6 };

function speedAt(profile: SpeedProfile, s: number): number {
  let v = profile.topMps;

  for (const apex of HAIRPIN_APEX_M) {
    for (const shift of [-TRACK_M, 0, TRACK_M]) {
      const d = s - (apex + shift);
      const envelope =
        d <= 0
          ? Math.sqrt(profile.apexMps ** 2 + 2 * profile.brakeMps2 * -d)
          : Math.sqrt(profile.apexMps ** 2 + 2 * profile.accelMps2 * d);

      v = Math.min(v, envelope);
    }
  }

  return v;
}

/** Cumulative seconds to reach each whole meter of the lap. */
function timeTable(profile: SpeedProfile): number[] {
  const cum = [0];

  for (let m = 0; m < TRACK_M; m++) cum.push(cum[m]! + 1 / speedAt(profile, m + 0.5));

  return cum;
}

const PLAYER_TABLE = timeTable(PLAYER_PROFILE);
const LEADER_TABLE = timeTable(LEADER_PROFILE);
const PLAYER_LAP_S = PLAYER_TABLE[TRACK_M]!;

/** Laps of progress after `t` seconds of driving the table's profile, `scale` × as fast. */
function progressAfter(table: number[], t: number, scale = 1): number {
  const lapS = table[TRACK_M]!;
  const tau = t * scale;
  const lap = Math.floor(tau / lapS);
  const rem = tau - lap * lapS;
  let lo = 0;
  let hi = TRACK_M;

  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;

    if (table[mid]! <= rem) lo = mid;
    else hi = mid - 1;
  }

  const meters = lo < TRACK_M ? lo + (rem - table[lo]!) / (table[lo + 1]! - table[lo]!) : TRACK_M;

  return lap + meters / TRACK_M;
}

type TrackEvent = { event: PendingEvent; playerProgress: number };

/**
 * Drive the diff over the synthetic track: the player from `fromLap` for
 * `laps` laps, the car ahead `startGapS` seconds up the road with a lap time
 * `leaderLapDeltaS` longer than the player's (negative = quicker), and a car
 * 30 s behind on the player's profile to keep the behind side quiet.
 */
function runTrack(opts: {
  laps: number;
  startGapS: number;
  leaderLapDeltaS: number;
  fromLap?: number;
  trackLengthMeters?: number | null;
  onTick?: (state: TranslatorState) => void;
}): { state: TranslatorState; events: TrackEvent[]; aheadGaps: number[] } {
  const state = createInitialState();
  const events: TrackEvent[] = [];
  const aheadGaps: number[] = [];
  const fromLap = opts.fromLap ?? 1;
  const leaderScale = LEADER_TABLE[TRACK_M]! / (PLAYER_LAP_S + opts.leaderLapDeltaS);
  const trackLength = opts.trackLengthMeters === undefined ? TRACK_M : opts.trackLengthMeters;
  const ticks = Math.floor((opts.laps * PLAYER_LAP_S) / TRACK_TICK_S);

  for (let i = 0; i <= ticks; i++) {
    const t = i * TRACK_TICK_S;
    const player = fromLap + progressAfter(PLAYER_TABLE, t);
    const leader = fromLap + progressAfter(LEADER_TABLE, t + opts.startGapS, leaderScale);
    const behind = fromLap + progressAfter(PLAYER_TABLE, t - 30);

    diffGaps(
      state,
      tick(100 + t, [player, leader, behind]),
      true,
      PLAYER,
      null,
      [2, 1, 3],
      () => GAP_DEFAULT_ALERT_THRESHOLD_S,
      (event) => events.push({ event, playerProgress: player }),
      null,
      () => GAP_DEFAULT_MIN_CHANGE_S,
      trackLength,
    );

    const aheadGap = state.gapLiveAhead?.gapSeconds;

    if (typeof aheadGap === "number") aheadGaps.push(aheadGap);

    opts.onTick?.(state);
  }

  return { state, events, aheadGaps };
}

function aheadTrendCalls(events: TrackEvent[], direction: "opening" | "closing"): TrackEvent[] {
  return events.filter((e) => {
    const data = e.event.data as { side?: string; direction?: string };

    return e.event.event === "gap.trendChanged" && data.side === "ahead" && data.direction === direction;
  });
}

describe("diffGaps — lap-scale trend calls (issue #1285)", () => {
  it("the fixture reproduces the issue's shape: a within-lap swing over a second on a flat lap-over-lap gap", () => {
    // Guards the fixture itself: if the profiles ever stop producing a real
    // sector swing, the regression tests below prove nothing.
    const { aheadGaps } = runTrack({ laps: 3, startGapS: 3.8, leaderLapDeltaS: 0 });
    const lastLap = aheadGaps.slice(-Math.floor(PLAYER_LAP_S / TRACK_TICK_S));

    expect(Math.max(...lastLap) - Math.min(...lastLap)).toBeGreaterThan(1);
    expect(Math.min(...lastLap)).toBeGreaterThan(3.5);
    expect(Math.max(...lastLap)).toBeLessThan(5.5);
  });

  it.each([
    { label: "flat", startGapS: 3.8, leaderLapDeltaS: 0 },
    { label: "shrinking 0.15 s/lap", startGapS: 4.2, leaderLapDeltaS: 0.15 },
  ])(
    "never says the car ahead is pulling away while the lap-over-lap gap is $label (the issue's regression)",
    ({ startGapS, leaderLapDeltaS }) => {
      // The car ahead is faster down both straights and brakes harder into
      // both hairpins; its lap time equals or is slower than the player's.
      // Eight laps 3–5 s back: the within-lap rate reads "opening hard" on
      // every straight, the lap-over-lap gap never grows.
      const { events } = runTrack({ laps: 8, startGapS, leaderLapDeltaS });

      expect(aheadTrendCalls(events, "opening")).toHaveLength(0);
      expect(aheadTrendCalls(events, "closing")).toHaveLength(0);
    },
  );

  it("never engages the ETA regime for a leader braking into a hairpin, with a track length (issue #1285)", () => {
    // The leader's 3 s average through the hairpin drops below half the
    // chaser's (the old relative test alone engaged here) but stays well
    // above the 8 m/s crawl bar, so the crossing-time gap stands.
    let etaTicks = 0;
    const { aheadGaps } = runTrack({
      laps: 3,
      startGapS: 3.8,
      leaderLapDeltaS: 0,
      onTick: (s) => {
        if (s.gapEtaReadingAhead) etaTicks++;
      },
    });

    expect(etaTicks).toBe(0);
    // No reading ever drops below the crossing-time profile's floor.
    expect(Math.min(...aheadGaps)).toBeGreaterThan(3.7);
  });

  it("announces a genuine 0.7 s/lap breakaway exactly once, on the lap scale", () => {
    const { events } = runTrack({ laps: 8, startGapS: 2, leaderLapDeltaS: -0.7 });
    const calls = aheadTrendCalls(events, "opening");

    expect(calls).toHaveLength(1);
    // Needs a lap of same-spot history first.
    expect(calls[0]!.playerProgress).toBeGreaterThanOrEqual(2);

    const data = calls[0]!.event.data as { ratePerLap: number; gapSeconds: number; carIdx: number };

    expect(data.ratePerLap).toBeCloseTo(0.7, 1);
    expect(data.carIdx).toBe(AHEAD);
    expect(aheadTrendCalls(events, "closing")).toHaveLength(0);
  });

  it("makes no trend call on lap 1 — a breakaway from the start waits for a lap of history", () => {
    // Same breakaway from the green (player on lap 1, LapCompleted 0).
    const { events } = runTrack({ fromLap: 0, laps: 4, startGapS: 2, leaderLapDeltaS: -0.7 });
    const calls = aheadTrendCalls(events, "opening");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.playerProgress).toBeGreaterThanOrEqual(1);
  });

  it("re-arms a breakaway only once the lap rate falls below the re-arm bar, then announces a later one", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // A lap of 2 s battle, then a 1.6 s/lap breakaway → one call.
    run(state, emit, { fromLap: 1, toLap: 2, aheadGapS: 2, behindGapS: 30 });
    run(state, emit, { fromLap: 2, toLap: 3, aheadGapS: [2, 3.6], behindGapS: 30 });
    expect(openingEvents(events)).toHaveLength(1);
    expect(state.gapBreakawayAnnouncedAhead).toBe(true);

    // Still opening, but slowly (0.35 s/lap) and under the 5 s re-arm gap:
    // below the announce bar yet above the re-arm bar, so the episode stays
    // latched — the old within-lap re-arm would have let it re-announce.
    run(state, emit, { fromLap: 3, toLap: 5, aheadGapS: [3.6, 4.3], behindGapS: 30 });
    expect(state.gapBreakawayAnnouncedAhead).toBe(true);

    // The gap stops growing: the lap rate falls under 0.25 → re-armed.
    run(state, emit, { fromLap: 5, toLap: 6.5, aheadGapS: 4.3, behindGapS: 30 });
    expect(state.gapBreakawayAnnouncedAhead).toBe(false);
    expect(openingEvents(events)).toHaveLength(1);

    // A later genuine breakaway announces again.
    run(state, emit, { fromLap: 6.5, toLap: 8.5, aheadGapS: [4.3, 7.5], behindGapS: 30 });
    expect(openingEvents(events)).toHaveLength(2);
  });

  it("announces a car behind closing at 0.6 s/lap from 6 s on the lap scale", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    run(state, emit, { fromLap: 1, toLap: 7, aheadGapS: 30, behindGapS: [6, 2.4] });

    const calls = closingEvents(events);

    expect(calls.length).toBeGreaterThanOrEqual(1);

    const first = calls[0]!.data as { side: string; ratePerLap: number; lapsToContact: number; gapSeconds: number };

    expect(first.side).toBe("behind");
    expect(first.ratePerLap).toBeCloseTo(-0.6, 1);
    expect(first.lapsToContact).toBeLessThanOrEqual(8);
    expect(first.gapSeconds).toBeLessThanOrEqual(4.5 + 0.05);
  });

  it("does not announce a within-lap closing burst on a lap-over-lap flat gap", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // 3 s ± 1 s with the pair's sector profiles: every downswing's
    // within-lap slope reads "closing" at several seconds a lap with a
    // sub-lap contact projection, and the swing clears the 1.5 s movement
    // gate. Lap over lap, nothing changes.
    run(state, emit, { fromLap: 1, toLap: 6, aheadGapS: 30, behindGapS: 3, behindOscillateS: 1 });

    expect(trendEvents(events)).toHaveLength(0);
  });

  it("keeps an ETA reading out of the extremes: a stopped-then-restarted leader cannot open a consistency-gate pass", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const lapTime = 90;
    const trackLengthMeters = 4000;

    run(state, emit, { fromLap: 1, toLap: 2.5, aheadGapS: 8, behindGapS: 30, trackLengthMeters });
    expect(state.gapMinSinceAnnounceAhead).toBeCloseTo(8, 1);

    // The car ahead stops on track for 5 s, then drives on at race pace.
    const startP = 2.5;
    const startT = startP * lapTime;
    const stopAt = startP + 8 / lapTime;
    const stopS = 5;
    let etaSeen = false;
    let lowestEta = Number.POSITIVE_INFINITY;
    let minAfterStint: number | null = null;

    for (let i = 1; i <= 400; i++) {
      const dt = i * 0.045;
      const player = startP + dt / lapTime;
      const leader = stopAt + Math.max(0, dt - stopS) / lapTime;

      diffGaps(
        state,
        tick(startT + dt, [player, leader, player - 30 / lapTime]),
        true,
        PLAYER,
        null,
        [2, 1, 3],
        () => GAP_DEFAULT_ALERT_THRESHOLD_S,
        emit,
        null,
        () => GAP_DEFAULT_MIN_CHANGE_S,
        trackLengthMeters,
      );

      if (state.gapEtaReadingAhead) {
        etaSeen = true;
        lowestEta = Math.min(lowestEta, state.gapLiveAhead!.gapSeconds!);
      } else if (etaSeen && minAfterStint === null) {
        minAfterStint = state.gapMinSinceAnnounceAhead;
      }
    }

    // The regime engaged and its readings counted well down from 8 s...
    expect(etaSeen).toBe(true);
    expect(lowestEta).toBeLessThan(5);
    // ...but none of them became the trough: the frozen crossing-time
    // reading that follows the stint is not 1.5 s "above the trough".
    expect(minAfterStint).not.toBeNull();
    expect(minAfterStint!).toBeGreaterThan(7.5);
    expect(openingEvents(events)).toHaveLength(0);
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

  it("honours a disabled movement gate on the opening lap — 0 means off (issue #933 review)", () => {
    // Lap 1, and the neighbor only travels 0.7 s from its peak: the default
    // 1.5 s gate calls that the field sorting itself out and stays silent...
    const gated = createInitialState();
    const gatedEvents = collect();

    run(gated, gatedEvents.emit, { fromLap: 0.05, toLap: 0.5, aheadGapS: [0.7, 1.6], behindGapS: 30 });
    run(gated, gatedEvents.emit, { fromLap: 0.5, toLap: 0.9, aheadGapS: [1.6, 0.9], behindGapS: 30 });
    expect(thresholdEvents(gatedEvents.events)).toHaveLength(0);

    // ...but a user who set the movement slider to 0 asked for every
    // crossing, so the same run must announce.
    const open = createInitialState();
    const openEvents = collect();

    run(open, openEvents.emit, { fromLap: 0.05, toLap: 0.5, aheadGapS: [0.7, 1.6], behindGapS: 30, minChangeS: 0 });
    run(open, openEvents.emit, { fromLap: 0.5, toLap: 0.9, aheadGapS: [1.6, 0.9], behindGapS: 30, minChangeS: 0 });

    const fired = thresholdEvents(openEvents.events);

    expect(fired).toHaveLength(1);
    expect(fired[0]!.data).toMatchObject({ side: "ahead", carIdx: AHEAD });
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

describe("gap setting sanitizers (issue #933 review)", () => {
  it("clamps the alert threshold to the slider range and falls back on junk", () => {
    expect(sanitizeGapAlertThresholdSeconds(2.5)).toBe(2.5);
    expect(sanitizeGapAlertThresholdSeconds("1.8")).toBe(1.8);
    expect(sanitizeGapAlertThresholdSeconds(0.1)).toBe(0.5);
    expect(sanitizeGapAlertThresholdSeconds(99)).toBe(3);
    expect(sanitizeGapAlertThresholdSeconds("junk")).toBe(GAP_DEFAULT_ALERT_THRESHOLD_S);
    expect(sanitizeGapAlertThresholdSeconds(undefined)).toBe(GAP_DEFAULT_ALERT_THRESHOLD_S);
  });

  it("treats a cleared field as missing, never as zero", () => {
    // `Number("")` and `Number(null)` are a finite 0, which would clamp to the
    // minimum instead of falling back to the default.
    expect(sanitizeGapAlertThresholdSeconds("")).toBe(GAP_DEFAULT_ALERT_THRESHOLD_S);
    expect(sanitizeGapAlertThresholdSeconds(null)).toBe(GAP_DEFAULT_ALERT_THRESHOLD_S);
    // For the movement gate a stray 0 is worse than a clamp — it is the value
    // that turns the consistency gate off.
    expect(sanitizeGapMinChangeSeconds("")).toBe(GAP_DEFAULT_MIN_CHANGE_S);
    expect(sanitizeGapMinChangeSeconds(null)).toBe(GAP_DEFAULT_MIN_CHANGE_S);
    // An explicit 0 still means "off".
    expect(sanitizeGapMinChangeSeconds(0)).toBe(0);
  });

  it("clamps the movement gate, keeping 0 (the user's 'off') intact", () => {
    expect(sanitizeGapMinChangeSeconds(0)).toBe(0);
    expect(sanitizeGapMinChangeSeconds(3.2)).toBe(3.2);
    expect(sanitizeGapMinChangeSeconds(-5)).toBe(0);
    expect(sanitizeGapMinChangeSeconds(50)).toBe(10);
    expect(sanitizeGapMinChangeSeconds("junk")).toBe(GAP_DEFAULT_MIN_CHANGE_S);
  });
});
