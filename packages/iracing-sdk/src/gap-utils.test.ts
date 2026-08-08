/**
 * Unit tests for the pure gap primitives (issue #933).
 *
 * Pins:
 *   - appendProgressSample: min-step skipping, backwards-jump reset, span pruning
 *   - crossingTimeAt: linear interpolation, exact sample hits, no extrapolation
 *   - resolveClassNeighbors: class filtering, missing neighbors, pace-car
 *     exclusion, unclassified/missing-class guards
 *   - classifyGapTrend: sign/deadband classification, null/non-finite guard
 *   - lapDeltaBetween: same-lap zero, whole-lap flooring
 */
import { describe, expect, it } from "vitest";

import {
  appendProgressSample,
  classifyGapTrend,
  crossingTimeAt,
  GAP_TRACE_SPAN_LAPS,
  lapDeltaBetween,
  type ProgressTrace,
  recentProgressRate,
  resolveClassNeighbors,
} from "./gap-utils.js";

describe("appendProgressSample", () => {
  it("appends monotonically advancing samples and skips sub-step advances", () => {
    const trace: ProgressTrace = [];
    appendProgressSample(trace, 5.0, 100);
    appendProgressSample(trace, 5.001, 100.1); // < GAP_TRACE_MIN_STEP advance — skipped
    appendProgressSample(trace, 5.003, 100.3);

    expect(trace).toEqual([
      { progress: 5.0, time: 100 },
      { progress: 5.003, time: 100.3 },
    ]);
  });

  it("clears the trace on a backwards jump (tow/teleport/session reset)", () => {
    const trace: ProgressTrace = [];
    appendProgressSample(trace, 5.0, 100);
    appendProgressSample(trace, 4.2, 20); // progress went backwards by > MIN_STEP

    expect(trace).toEqual([{ progress: 4.2, time: 20 }]);
  });

  it("prunes samples older than GAP_TRACE_SPAN_LAPS behind the head", () => {
    const trace: ProgressTrace = [];

    for (let i = 0; i <= 150; i++) {
      const p = i / 100;
      appendProgressSample(trace, p, p * 90);
    }

    expect(trace[0]!.progress).toBeGreaterThanOrEqual(1.5 - GAP_TRACE_SPAN_LAPS - 0.011);
    expect(trace[trace.length - 1]!.progress).toBeCloseTo(1.5, 5);
  });
});

describe("crossingTimeAt", () => {
  const trace: ProgressTrace = [
    { progress: 2.0, time: 180.0 },
    { progress: 2.1, time: 189.0 },
    { progress: 2.2, time: 198.0 },
  ];

  it("interpolates linearly between bracketing samples", () => {
    // Halfway between 2.1 (189 s) and 2.2 (198 s) → 193.5 s
    expect(crossingTimeAt(trace, 2.15)).toBeCloseTo(193.5, 6);
  });

  it("returns the exact sample time at a sample point", () => {
    expect(crossingTimeAt(trace, 2.1)).toBeCloseTo(189.0, 6);
  });

  it("returns null outside the trace span (never extrapolates)", () => {
    expect(crossingTimeAt(trace, 1.99)).toBeNull();
    expect(crossingTimeAt(trace, 2.21)).toBeNull();
    expect(crossingTimeAt([], 2.0)).toBeNull();
  });
});

describe("resolveClassNeighbors", () => {
  // positions: carIdx → 1-based overall rank (0 = unclassified)
  // classes:   carIdx → class id
  // Field: idx0=P3 cls10 (player), idx1=P1 cls10, idx2=P2 cls20, idx3=P4 cls10, idx4=P5 cls20
  const positions = [3, 1, 2, 4, 5];
  const classes = [10, 10, 20, 10, 20];

  it("resolves class neighbors skipping other-class cars", () => {
    const n = resolveClassNeighbors(positions, classes, 0);

    expect(n.aheadIdx).toBe(1); // P1 is the class-10 car directly ahead in class standings
    expect(n.behindIdx).toBe(3); // P4 is class-10 directly behind
    expect(n.leaderIdx).toBe(1);
  });

  it("returns -1 for a missing neighbor (class leader / last in class)", () => {
    const n = resolveClassNeighbors(positions, classes, 1); // player is class leader

    expect(n.aheadIdx).toBe(-1);
    expect(n.leaderIdx).toBe(1); // the leader of your class is yourself when you lead
    expect(n.behindIdx).toBe(0);
  });

  it("excludes the pace car index explicitly", () => {
    // Pace car idx1 would otherwise be the class-10 car ahead
    const n = resolveClassNeighbors(positions, classes, 0, 1);

    expect(n.aheadIdx).toBe(-1);
    expect(n.leaderIdx).toBe(0); // best-ranked non-excluded class-10 car is the player
  });

  it("returns all -1 when the player is unclassified or class data is missing", () => {
    expect(resolveClassNeighbors([0, 1], [10, 10], 0)).toEqual({ aheadIdx: -1, behindIdx: -1, leaderIdx: -1 });
    expect(resolveClassNeighbors(positions, undefined, 0)).toEqual({ aheadIdx: -1, behindIdx: -1, leaderIdx: -1 });
  });
});

describe("recentProgressRate", () => {
  // 90 s/lap pace: 1/90 ≈ 0.0111 laps/s, sampled every 0.01 lap (0.9 s).
  const racing: ProgressTrace = [];

  for (let i = 0; i <= 20; i++) {
    racing.push({ progress: 5 + i * 0.01, time: 100 + i * 0.9 });
  }

  it("measures a racing car's pace over the trailing window", () => {
    const now = 100 + 20 * 0.9;
    const rate = recentProgressRate(racing, 5.2, now, 3);

    expect(rate).toBeCloseTo(1 / 90, 3);
  });

  it("decays toward zero for a stopped car (anchored on now, not the last sample)", () => {
    // Car stopped at progress 5.2 at t=118; 10 s later the window straddles
    // the stop, so the measured rate collapses.
    const rate = recentProgressRate(racing, 5.2, 118 + 10, 3);

    expect(rate).not.toBeNull();
    expect(rate!).toBeLessThan(0.002);
  });

  it("returns null without enough history", () => {
    expect(recentProgressRate([], 5, 100, 3)).toBeNull();
    expect(recentProgressRate([{ progress: 5, time: 99 }], 5.01, 100, 3)).toBeNull();
  });
});

describe("classifyGapTrend", () => {
  it("classifies by sign outside the deadband", () => {
    expect(classifyGapTrend(-0.5, 0.2)).toBe("closing");
    expect(classifyGapTrend(0.5, 0.2)).toBe("opening");
    expect(classifyGapTrend(0.1, 0.2)).toBe("steady");
    expect(classifyGapTrend(-0.2, 0.2)).toBe("steady"); // boundary is inclusive-steady
  });

  it("returns null for null/non-finite input", () => {
    expect(classifyGapTrend(null, 0.2)).toBeNull();
    expect(classifyGapTrend(Number.NaN, 0.2)).toBeNull();
  });
});

describe("lapDeltaBetween", () => {
  it("is 0 for same-lap cars and counts whole laps otherwise", () => {
    expect(lapDeltaBetween(5.8, 5.2)).toBe(0);
    expect(lapDeltaBetween(6.3, 5.2)).toBe(1);
    expect(lapDeltaBetween(7.1, 5.2)).toBe(1); // 1.9 laps ahead → floor = 1
    expect(lapDeltaBetween(8.2, 5.2)).toBe(3);
  });
});
