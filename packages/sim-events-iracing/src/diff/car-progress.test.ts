/**
 * Unit tests for the car-progress step (issue #1572).
 *
 * Pins:
 *   - the gate: each of its conditions returns null and leaves the traces
 *     alone, and the same tick with that one condition met is read
 *   - a valid tick reports every car's progress, and null for a reading that
 *     is negative, not finite or missing, which leaves that car's trace alone
 *   - `traceReset` is true exactly on a sample that reset the car's trace
 *   - the traces grow as `appendProgressSample` dictates, and the tick hands
 *     the slice's own array on
 *   - `previousSessionTime` names the tick read directly before, and is null
 *     whenever a tick in between was refused or threw
 *   - the start/finish correction: a lap counter and a lap fraction that
 *     disagree for a tick at the line read as continuous motion, in either
 *     direction, while every other whole-lap or backwards step stays the
 *     discontinuity it is
 *   - the correction reads only against a confirmed last progress, so a first
 *     reading taken on a disagreeing tick is replaced by the next true one and
 *     never carried on (the player's own first crossing at the race start)
 */
import { GAP_TRACE_MAX_STEP, GAP_TRACE_MIN_STEP, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { type CarProgressState, createCarProgressState } from "../state.js";
import {
  CAR_PROGRESS_LINE_GUARD_PCT,
  CAR_PROGRESS_LINE_MAX_SPAN_S,
  CAR_PROGRESS_LINE_MAX_TICK_STEP,
  confirmedLastProgress,
  readCarProgress,
  stepCarProgress,
} from "./car-progress.js";

const PLAYER = 0;
const ORDER: readonly number[] = [1, 2, 3];

/** A racing tick: three cars at the given progress (laps), the player first. */
function tick(sessionTime: number, progressByCar: number[], overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    SessionTime: sessionTime,
    LapCompleted: Math.floor(progressByCar[PLAYER]!),
    SessionState: SessionState.Racing,
    CarIdxLapCompleted: progressByCar.map((p) => Math.floor(p)),
    CarIdxLapDistPct: progressByCar.map((p) => p - Math.floor(p)),
    ...overrides,
  } as unknown as TelemetryData;
}

/** A progress as the step reads it off {@link tick}: the lap count plus the lap fraction, not the literal. */
const at = (progress: number): number => Math.floor(progress) + (progress - Math.floor(progress));

/** What the gate reads besides the telemetry. */
type GateArgs = { isRaceSession: boolean; playerCarIdx: number; frozenPositions: readonly number[] | null };

const OPEN: GateArgs = { isRaceSession: true, playerCarIdx: PLAYER, frozenPositions: ORDER };

function step(slice: CarProgressState, telemetry: TelemetryData, args: Partial<GateArgs> = {}) {
  const { isRaceSession, playerCarIdx, frozenPositions } = { ...OPEN, ...args };

  return stepCarProgress(slice, telemetry, isRaceSession, playerCarIdx, frozenPositions);
}

describe("stepCarProgress — the gate", () => {
  const base = (): TelemetryData => tick(100, [2.5, 2.6, 2.4]);
  const without = (key: keyof TelemetryData): TelemetryData => {
    const telemetry = { ...base() } as Record<string, unknown>;

    delete telemetry[key];

    return telemetry as unknown as TelemetryData;
  };

  /** Each condition of the gate as the one thing wrong with an otherwise readable tick. */
  const closed: [string, () => TelemetryData, Partial<GateArgs>][] = [
    ["the session is not a race", base, { isRaceSession: false }],
    ["`CarIdxLapCompleted` is missing", () => without("CarIdxLapCompleted"), {}],
    ["`CarIdxLapDistPct` is missing", () => without("CarIdxLapDistPct"), {}],
    ["`SessionTime` is missing", () => without("SessionTime"), {}],
    ["`SessionTime` is NaN", () => ({ ...base(), SessionTime: Number.NaN }), {}],
    ["`SessionTime` is infinite", () => ({ ...base(), SessionTime: Number.POSITIVE_INFINITY }), {}],
    ["there is no player car index", base, { playerCarIdx: -1 }],
    ["there is no canonical order", base, { frozenPositions: null }],
    ["the green has not flown (parade laps)", () => ({ ...base(), SessionState: SessionState.ParadeLaps }), {}],
    ["the player is not racing (`LapCompleted` below 0)", () => ({ ...base(), LapCompleted: -1 }), {}],
  ];

  it.each(closed)(
    "returns null and records nothing when %s; the same tick with it met is read",
    (_name, make, args) => {
      const slice = createCarProgressState();

      expect(step(slice, make(), args)).toBeNull();
      expect(slice.traces).toEqual([]);

      // The passing twin: the tick with nothing wrong.
      const read = step(slice, base());

      expect(read).not.toBeNull();
      expect(read!.progress).toEqual([at(2.5), at(2.6), at(2.4)]);
      expect(slice.traces.map((trace) => trace?.length)).toEqual([1, 1, 1]);
    },
  );

  it("reads a tick whose `LapCompleted` is missing or zero: only a negative count is 'not racing'", () => {
    expect(step(createCarProgressState(), without("LapCompleted"))).not.toBeNull();
    expect(step(createCarProgressState(), { ...base(), LapCompleted: 0 })).not.toBeNull();
  });

  it("keeps the traces it has when the gate closes", () => {
    const slice = createCarProgressState();

    step(slice, tick(100, [2.5, 2.6, 2.4]));
    step(slice, tick(101, [2.51, 2.61, 2.41]));

    const before = structuredClone(slice.traces);

    expect(step(slice, tick(102, [2.52, 2.62, 2.42]), { isRaceSession: false })).toBeNull();
    expect(slice.traces).toEqual(before);
  });
});

describe("stepCarProgress — a read tick", () => {
  it("reports the session time and every car's progress, and records each in its trace", () => {
    const slice = createCarProgressState();
    const read = step(slice, tick(100, [2.5, 3.25, 1.75]));

    expect(read).toEqual({
      sessionTime: 100,
      previousSessionTime: null,
      progress: [2.5, 3.25, 1.75],
      traceReset: [false, false, false],
      traces: [[{ progress: 2.5, time: 100 }], [{ progress: 3.25, time: 100 }], [{ progress: 1.75, time: 100 }]],
    });
  });

  it("hands on the slice's own traces, as they stand after the tick's samples", () => {
    const slice = createCarProgressState();
    const read = step(slice, tick(100, [2.5, 2.6, 2.4]));

    expect(read!.traces).toBe(slice.traces);
  });

  it.each([
    ["a negative lap count (a car out of the world)", { CarIdxLapCompleted: [2, -1, 2] }],
    ["a negative lap distance", { CarIdxLapDistPct: [0.51, -1, 0.41] }],
    ["a NaN lap count", { CarIdxLapCompleted: [2, Number.NaN, 2] }],
    ["a NaN lap distance", { CarIdxLapDistPct: [0.51, Number.NaN, 0.41] }],
    ["an infinite lap distance", { CarIdxLapDistPct: [0.51, Number.POSITIVE_INFINITY, 0.41] }],
    ["a hole in the lap distances", { CarIdxLapDistPct: [0.51, undefined, 0.41] as unknown as number[] }],
  ])("reports null for %s and leaves that car's trace alone", (_name, overrides) => {
    const slice = createCarProgressState();

    step(slice, tick(100, [2.5, 2.6, 2.4]));

    const read = step(slice, tick(101, [2.51, 2.61, 2.41], overrides as Partial<TelemetryData>));

    expect(read!.progress).toEqual([expect.closeTo(2.51, 10), null, expect.closeTo(2.41, 10)]);
    expect(read!.traceReset).toEqual([false, false, false]);
    expect(slice.traces[1]).toEqual([{ progress: at(2.6), time: 100 }]);
    expect(slice.traces[0]).toHaveLength(2);
    expect(slice.traces[2]).toHaveLength(2);
  });

  it("starts no trace for a car that has never had a valid reading", () => {
    const slice = createCarProgressState();
    const read = step(slice, tick(100, [2.5, 2.6, 2.4], { CarIdxLapCompleted: [2, -1, 2] }));

    expect(read!.progress).toEqual([at(2.5), null, at(2.4)]);
    expect(slice.traces[1]).toBeUndefined();
  });

  it("reads as many cars as the shorter of the two arrays holds", () => {
    const slice = createCarProgressState();
    const read = step(slice, tick(100, [2.5, 2.6, 2.4], { CarIdxLapDistPct: [0.5, 0.6] }));

    expect(read!.progress).toEqual([at(2.5), at(2.6)]);
    expect(read!.traceReset).toEqual([false, false]);
    expect(slice.traces).toHaveLength(2);
  });
});

describe("stepCarProgress — traceReset and the traces", () => {
  /** Car 1 driven from 2.6 by `stepLaps` on the second tick; the player and car 2 advance normally. */
  function second(stepLaps: number) {
    const slice = createCarProgressState();

    step(slice, tick(100, [2.5, 2.6, 2.4]));

    const read = step(slice, tick(101, [2.51, 2.6 + stepLaps, 2.41]));

    return { slice, read: read! };
  }

  it("is false for an appended sample, which grows the trace", () => {
    const { slice, read } = second(0.01);

    expect(read.traceReset).toEqual([false, false, false]);
    expect(slice.traces[1]).toEqual([
      { progress: at(2.6), time: 100 },
      { progress: at(2.6 + 0.01), time: 101 },
    ]);
  });

  it("is false for a skipped sample (under the minimum step), which leaves the trace as it was", () => {
    const { slice, read } = second(GAP_TRACE_MIN_STEP / 2);

    expect(read.progress[1]).toBeCloseTo(2.6 + GAP_TRACE_MIN_STEP / 2, 10);
    expect(read.traceReset).toEqual([false, false, false]);
    expect(slice.traces[1]).toEqual([{ progress: at(2.6), time: 100 }]);
  });

  it("is true for a backwards step, which restarts the trace on this reading", () => {
    const { slice, read } = second(-0.3);

    expect(read.traceReset).toEqual([false, true, false]);
    expect(slice.traces[1]).toEqual([{ progress: at(2.6 - 0.3), time: 101 }]);
    // The other cars' traces are untouched by it.
    expect(slice.traces[0]).toHaveLength(2);
    expect(slice.traces[2]).toHaveLength(2);
  });

  it("is true for a forward step past GAP_TRACE_MAX_STEP, which restarts the trace on this reading", () => {
    const { slice, read } = second(GAP_TRACE_MAX_STEP + 0.01);

    expect(read.traceReset).toEqual([false, true, false]);
    expect(slice.traces[1]).toEqual([{ progress: at(2.6 + (GAP_TRACE_MAX_STEP + 0.01)), time: 101 }]);
  });

  it("is false for a forward step just inside GAP_TRACE_MAX_STEP", () => {
    const { slice, read } = second(GAP_TRACE_MAX_STEP - 0.001);

    expect(read.traceReset).toEqual([false, false, false]);
    expect(slice.traces[1]).toHaveLength(2);
  });

  it("is false again on the tick after a reset", () => {
    const { slice, read } = second(-0.3);

    expect(read.traceReset[1]).toBe(true);

    const next = step(slice, tick(102, [2.52, 2.31, 2.42]));

    expect(next!.traceReset).toEqual([false, false, false]);
    expect(slice.traces[1]).toHaveLength(2);
  });

  it("is false for a car's first reading after ticks without one", () => {
    const slice = createCarProgressState();

    step(slice, tick(100, [2.5, 2.6, 2.4], { CarIdxLapCompleted: [2, -1, 2] }));

    const read = step(slice, tick(101, [2.51, 2.61, 2.41]));

    expect(read!.traceReset).toEqual([false, false, false]);
    expect(slice.traces[1]).toEqual([{ progress: at(2.61), time: 101 }]);
  });
});

describe("stepCarProgress — previousSessionTime", () => {
  it("is null on the first tick", () => {
    expect(step(createCarProgressState(), tick(100, [2.5, 2.6, 2.4]))!.previousSessionTime).toBeNull();
  });

  it("is the first tick's session time on the second of two consecutive read ticks", () => {
    const slice = createCarProgressState();
    const first = step(slice, tick(100, [2.5, 2.6, 2.4]));
    const second = step(slice, tick(100.25, [2.51, 2.61, 2.41]));
    const third = step(slice, tick(100.5, [2.52, 2.62, 2.42]));

    expect(second!.previousSessionTime).toBe(first!.sessionTime);
    expect(third!.previousSessionTime).toBe(second!.sessionTime);
  });

  it("is null on the tick after one the gate refused, and links again from there", () => {
    const slice = createCarProgressState();

    step(slice, tick(100, [2.5, 2.6, 2.4]));
    expect(step(slice, tick(101, [2.51, 2.61, 2.41]), { isRaceSession: false })).toBeNull();
    expect(slice.lastReadSessionTime).toBeNull();

    const back = step(slice, tick(102, [2.52, 2.62, 2.42]));

    expect(back!.previousSessionTime).toBeNull();
    expect(step(slice, tick(103, [2.53, 2.63, 2.43]))!.previousSessionTime).toBe(102);
  });

  it("is null on the tick after one the step threw on part-way through its cars", () => {
    const slice = createCarProgressState();

    step(slice, tick(100, [2.5, 2.6, 2.4]));

    // A reading that throws for the second car: the first car is already read.
    const broken = tick(101, [2.51, 2.61, 2.41]);

    Object.defineProperty(broken.CarIdxLapDistPct as number[], 1, {
      get: () => {
        throw new Error("reading broke");
      },
    });

    expect(() => step(slice, broken)).toThrow("reading broke");
    expect(slice.traces[0]).toHaveLength(2);
    expect(slice.lastReadSessionTime).toBeNull();

    const next = step(slice, tick(102, [2.52, 2.62, 2.42]));

    expect(next!.previousSessionTime).toBeNull();
    expect(next!.sessionTime).toBe(102);
  });
});

describe("readCarProgress — the start/finish correction", () => {
  it("is the plain sum with no last progress, and within half a lap of it", () => {
    expect(readCarProgress(undefined, 7, 0.99995)).toBe(7.99995);
    expect(readCarProgress(6.4, 6, 0.41)).toBe(6.41);
    // An ordinary crossing: both arrays moved on the same tick.
    expect(readCarProgress(6.9999, 7, 0.0001)).toBe(7.0001);
  });

  it("reads through a counter that steps a tick before the fraction wraps (6.9999 → 8.0 → 7.0001)", () => {
    const desync = readCarProgress(6.9999, 7, 0.99995);

    expect(desync).toBeCloseTo(6.99995, 10);
    expect(readCarProgress(desync, 7, 0.0001)).toBe(7.0001);
  });

  it("reads through a fraction that wraps a tick before the counter steps (6.9999 → 6.0001 → 7.0002)", () => {
    const desync = readCarProgress(6.9999, 6, 0.0001);

    expect(desync).toBeCloseTo(7.0001, 10);
    expect(readCarProgress(desync, 7, 0.0002)).toBe(7.0002);
  });

  it("leaves a backwards tow far from the line as it reads", () => {
    expect(readCarProgress(6.9, 6, 0.2)).toBe(6.2);
    expect(readCarProgress(6.6, 5, 0.3)).toBe(5.3);
  });

  it("leaves a whole-lap step outside the guard band as it reads, in either direction", () => {
    expect(readCarProgress(6.5, 7, 0.5)).toBe(7.5);
    expect(readCarProgress(6.5, 5, 0.5)).toBe(5.5);
    // Just outside the band on each side of the line.
    expect(readCarProgress(6.07, 7, 0.07)).toBe(7.07);
    expect(readCarProgress(6.93, 5, 0.93)).toBe(5.93);
  });

  it("corrects a whole-lap step at the edge of the guard band", () => {
    expect(readCarProgress(6.05, 7, CAR_PROGRESS_LINE_GUARD_PCT)).toBeCloseTo(6.05, 10);
    expect(readCarProgress(6.95, 5, 1 - CAR_PROGRESS_LINE_GUARD_PCT)).toBeCloseTo(6.95, 10);
  });

  it("leaves a one-tick hop across the line as it reads: a tick's travel bounds the correction, not a sample's", () => {
    // The counter did not move and the fraction jumped the line: 0.04 lap in
    // a tick, which the trace's own 0.05 bound between samples would pass.
    expect(readCarProgress(5.98, 5, 0.02)).toBe(5.02);
    expect(readCarProgress(6.02, 6, 0.98)).toBe(6.98);
    // The same with the counter a lap the other way.
    expect(readCarProgress(5.98, 6, 0.98 + 0.015)).toBe(6 + (0.98 + 0.015));
  });

  it("corrects up to a tick's travel and no further", () => {
    expect(CAR_PROGRESS_LINE_MAX_TICK_STEP).toBe(0.01);
    // 0.009 lap on from 6.995: corrected. 0.011 lap on: not.
    expect(readCarProgress(6.995, 6, 0.004)).toBeCloseTo(7.004, 10);
    expect(readCarProgress(6.995, 6, 0.006)).toBe(6.006);
  });

  it("leaves a step near the line as it reads when the car could not have driven there", () => {
    // Towed from 80% of the lap to a stall just past the line, a lap down.
    expect(readCarProgress(6.8, 5, 0.01)).toBe(5.01);
    // A counter rewound by several laps at the line: the nearest lap is still more than a sample's step away.
    expect(readCarProgress(6.9, 2, 0.99)).toBe(2.99);
  });
});

/** A tick from each car's raw `[CarIdxLapCompleted, CarIdxLapDistPct]`, the player first. */
function raw(sessionTime: number, cars: [number, number][], overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    SessionTime: sessionTime,
    LapCompleted: cars[PLAYER]![0],
    SessionState: SessionState.Racing,
    CarIdxLapCompleted: cars.map(([laps]) => laps),
    CarIdxLapDistPct: cars.map(([, pct]) => pct),
    ...overrides,
  } as unknown as TelemetryData;
}

describe("stepCarProgress — a counter and a fraction that disagree at the line", () => {
  /**
   * Clean ticks that leave car 1 at `6 + first` (t = 100) then `6 + second`
   * (t = 100.1), its last progress confirmed, so the next tick's reading is
   * corrected against it. Two earlier ticks (t = 99.8, 99.9) read the car
   * clear of the line guard band first: a run that began inside the band
   * would never confirm.
   */
  function confirmed(first: number, second: number): CarProgressState {
    const slice = createCarProgressState();
    const clear = Math.min(first - 0.005, 0.949);

    step(
      slice,
      raw(99.8, [
        [6, 0.498],
        [6, clear - 0.005],
      ]),
    );
    step(
      slice,
      raw(99.9, [
        [6, 0.499],
        [6, clear],
      ]),
    );
    expect(confirmedLastProgress(slice, 1)).toBe(6 + clear);

    step(
      slice,
      raw(100, [
        [6, 0.5],
        [6, first],
      ]),
    );
    step(
      slice,
      raw(100.1, [
        [6, 0.501],
        [6, second],
      ]),
    );

    expect(confirmedLastProgress(slice, 1)).toBe(6 + second);

    return slice;
  }

  it("takes a reading as it stands after a long gap since the last read, so a whole lap is not hidden", () => {
    // Confirmed at 6.975 / 6.98 by t = 100.1; 90 s later the car is near the
    // line again a lap on, at 7.985. Against the stale progress the
    // correction would read 6.985, a 0.005 step inside the per-tick bound,
    // hiding the lap: only the time bound catches it.
    const slice = confirmed(0.975, 0.98);
    const later = step(
      slice,
      raw(190.1, [
        [6, 0.6],
        [7, 0.985],
      ]),
    );

    expect(later!.progress[1]).toBeCloseTo(7.985, 10);
    expect(later!.traceReset[1]).toBe(true);
  });

  it("still corrects the same reading on the very next tick (the positive control)", () => {
    const slice = confirmed(0.975, 0.98);
    const next = step(
      slice,
      raw(100.1 + CAR_PROGRESS_LINE_MAX_SPAN_S, [
        [6, 0.502],
        [7, 0.985],
      ]),
    );

    expect(next!.progress[1]).toBeCloseTo(6.985, 10);
    expect(next!.traceReset[1]).toBe(false);
  });

  it.each([
    ["the counter leads the fraction", [7, 0.9999] as [number, number], 6.9999],
    ["the fraction leads the counter", [6, 0.0001] as [number, number], 7.0001],
  ])("reads continuous motion when %s for a tick, and resets no trace", (_name, desync, expected) => {
    const slice = confirmed(0.9939, 0.9989);
    const at = step(slice, raw(100.2, [[6, 0.502], desync]));

    expect(at!.progress[1]).toBeCloseTo(expected, 10);
    expect(at!.traceReset).toEqual([false, false]);

    const after = step(
      slice,
      raw(100.3, [
        [6, 0.503],
        [7, 0.0021],
      ]),
    );

    expect(after!.progress[1]).toBe(7.0021);
    expect(after!.traceReset).toEqual([false, false]);
    // One unbroken trace through the crossing, ascending.
    expect(slice.traces[1]!.map((sample) => sample.time)).toEqual([99.8, 99.9, 100, 100.1, 100.3]);
    expect(slice.traces[1]!.map((sample) => sample.progress)).toEqual([6.944, 6.949, 6.9939, 6.9989, 7.0021]);
  });

  it("records the corrected reading in the trace when it is a sample's step on", () => {
    const slice = confirmed(0.989, 0.994);
    // The counter has moved, the fraction has not wrapped: 7.998 as it reads.
    const at = step(
      slice,
      raw(100.2, [
        [6, 0.502],
        [7, 0.998],
      ]),
    );

    expect(at!.progress[1]).toBeCloseTo(6.998, 10);
    expect(at!.traceReset[1]).toBe(false);
    expect(slice.traces[1]!.slice(2)).toEqual([
      { progress: 6.989, time: 100 },
      { progress: 6.994, time: 100.1 },
      { progress: expect.closeTo(6.998, 10), time: 100.2 },
    ]);
  });

  it("still resets the trace on a backwards tow far from the line", () => {
    const slice = confirmed(0.895, 0.9);
    const towed = step(
      slice,
      raw(100.2, [
        [6, 0.502],
        [6, 0.2],
      ]),
    );

    expect(towed!.progress[1]).toBe(6.2);
    expect(towed!.traceReset).toEqual([false, true]);
    expect(slice.traces[1]).toEqual([{ progress: 6.2, time: 100.2 }]);
  });

  it.each([
    ["forwards", [7, 0.5] as [number, number], 7.5],
    ["backwards", [5, 0.5] as [number, number], 5.5],
  ])("still resets the trace on a whole-lap step %s outside the guard band", (_name, stepped, expected) => {
    const slice = confirmed(0.494, 0.499);
    const read = step(slice, raw(100.2, [[6, 0.502], stepped]));

    expect(read!.progress[1]).toBe(expected);
    expect(read!.traceReset).toEqual([false, true]);
  });

  it("corrects nothing across a tick the car had no valid reading on", () => {
    const slice = confirmed(0.9979, 0.9999);

    step(
      slice,
      raw(100.2, [
        [6, 0.502],
        [-1, -1],
      ]),
    );
    expect(slice.lastProgress[1]).toBeUndefined();
    expect(slice.lastProgressConfirmed[1]).toBe(false);
    expect(confirmedLastProgress(slice, 1)).toBeUndefined();

    // With the last progress gone, the reading the correction would have taken to 6.99995 is read as it stands.
    const read = step(
      slice,
      raw(100.3, [
        [6, 0.503],
        [7, 0.99995],
      ]),
    );

    expect(read!.progress[1]).toBe(7.99995);
    expect(read!.traceReset[1]).toBe(true);
  });

  it("corrects nothing across a tick the gate refused, and drops every car's last progress there", () => {
    const slice = confirmed(0.9979, 0.9999);

    expect(slice.lastProgress).toEqual([6.501, 6.9999]);
    expect(slice.lastProgressConfirmed).toEqual([true, true]);

    expect(
      step(
        slice,
        raw(100.2, [
          [6, 0.502],
          [6, 0.99995],
        ]),
        { isRaceSession: false },
      ),
    ).toBeNull();
    expect(slice.lastProgress).toEqual([]);
    expect(slice.lastProgressConfirmed).toEqual([]);

    const read = step(
      slice,
      raw(100.3, [
        [6, 0.503],
        [7, 0.99995],
      ]),
    );

    expect(read!.progress[1]).toBe(7.99995);
    expect(read!.traceReset[1]).toBe(true);
  });

  it("drops the last progress of a car the arrays no longer reach", () => {
    const slice = confirmed(0.9979, 0.9999);

    step(slice, raw(100.2, [[6, 0.502]]));

    expect(slice.lastProgress).toEqual([6.502]);
    expect(slice.lastProgressConfirmed).toEqual([true]);
    expect(confirmedLastProgress(slice, 1)).toBeUndefined();
  });

  it("still resets the trace on a one-tick hop across the line with the counter unchanged", () => {
    const slice = confirmed(0.975, 0.98);
    const hopped = step(
      slice,
      raw(100.2, [
        [6, 0.502],
        [6, 0.02],
      ]),
    );

    // Not 7.02: the car did not drive 0.04 lap in a tick.
    expect(hopped!.progress[1]).toBe(6.02);
    expect(hopped!.traceReset).toEqual([false, true]);
    expect(slice.traces[1]).toEqual([{ progress: 6.02, time: 100.2 }]);
    expect(confirmedLastProgress(slice, 1)).toBeUndefined();
  });

  it("keeps each car's last progress as the corrected reading, still confirmed", () => {
    const slice = confirmed(0.9979, 0.9999);

    step(
      slice,
      raw(100.2, [
        [6, 0.502],
        [7, 0.99995],
      ]),
    );

    expect(slice.lastProgress[0]).toBe(6.502);
    expect(slice.lastProgress[1]).toBeCloseTo(6.99995, 10);
    expect(confirmedLastProgress(slice, 1)).toBeCloseTo(6.99995, 10);
  });
});

describe("stepCarProgress — a last progress is corrected against only once it is confirmed", () => {
  it("confirms a reading when it continues the one before it, not on the first", () => {
    const slice = createCarProgressState();

    step(
      slice,
      raw(100, [
        [6, 0.5],
        [6, 0.4],
      ]),
    );
    expect(slice.lastProgress).toEqual([6.5, 6.4]);
    expect(slice.lastProgressConfirmed).toEqual([false, false]);
    expect(confirmedLastProgress(slice, 0)).toBeUndefined();

    step(
      slice,
      raw(100.1, [
        [6, 0.501],
        [6, 0.401],
      ]),
    );
    expect(slice.lastProgressConfirmed).toEqual([true, true]);
    expect(confirmedLastProgress(slice, 0)).toBe(6.501);
    expect(confirmedLastProgress(slice, 1)).toBe(6.401);
  });

  it("does not confirm a run of readings that began inside the line guard band until one is clear of it", () => {
    const slice = createCarProgressState();

    step(
      slice,
      raw(100, [
        [6, 0.5],
        [6, 0.02],
      ]),
    );
    step(
      slice,
      raw(100.1, [
        [6, 0.501],
        [6, 0.03],
      ]),
    );
    // Two readings that agree, both inside the band: they could both be a lap off.
    expect(slice.lastProgress[1]).toBe(6.03);
    expect(confirmedLastProgress(slice, 1)).toBeUndefined();

    step(
      slice,
      raw(100.2, [
        [6, 0.502],
        [6, 0.045],
      ]),
    );
    expect(confirmedLastProgress(slice, 1)).toBeUndefined();

    step(
      slice,
      raw(100.3, [
        [6, 0.503],
        [6, 0.06],
      ]),
    );
    expect(confirmedLastProgress(slice, 1)).toBe(6 + 0.06);
  });

  it("keeps a confirmed progress confirmed through the guard band", () => {
    const slice = createCarProgressState();

    step(
      slice,
      raw(100, [
        [6, 0.5],
        [6, 0.93],
      ]),
    );
    step(
      slice,
      raw(100.1, [
        [6, 0.501],
        [6, 0.94],
      ]),
    );
    expect(confirmedLastProgress(slice, 1)).toBe(6 + 0.94);

    step(
      slice,
      raw(100.2, [
        [6, 0.502],
        [6, 0.96],
      ]),
    );
    step(
      slice,
      raw(100.3, [
        [6, 0.503],
        [6, 0.99],
      ]),
    );
    expect(confirmedLastProgress(slice, 1)).toBe(6 + 0.99);
  });

  it("does not carry on a first reading when the counter leads the fraction for two ticks", () => {
    const slice = createCarProgressState();

    // Car 1 is first read while its counter has stepped and its fraction has
    // not wrapped, and is still so on the next tick: truly at 6.9998 and
    // 6.9999, it reads 7.9998 and 7.9999. The two agree with each other.
    step(
      slice,
      raw(100, [
        [6, 0.5],
        [7, 0.9998],
      ]),
    );

    const second = step(
      slice,
      raw(100.1, [
        [6, 0.501],
        [7, 0.9999],
      ]),
    );

    expect(second!.progress[1]).toBe(7.9999);
    expect(confirmedLastProgress(slice, 1)).toBeUndefined();

    // The fraction wraps: the true reading, taken as it stands and not a lap high.
    const next = step(
      slice,
      raw(100.2, [
        [6, 0.502],
        [7, 0.0001],
      ]),
    );

    expect(next!.progress[1]).toBe(7.0001);
    expect(next!.traceReset).toEqual([false, true]);

    const readings: (number | null | undefined)[] = [];
    const resets: (boolean | undefined)[] = [];

    for (let k = 1; k <= 30; k++) {
      const read = step(
        slice,
        raw(100.2 + k * 0.1, [
          [6, 0.502 + k * 0.001],
          [7, 0.0001 + k * 0.004],
        ]),
      );

      readings.push(read!.progress[1]);
      resets.push(read!.traceReset[1]);
    }

    expect(readings).toEqual(Array.from({ length: 30 }, (_, i) => 7 + (0.0001 + (i + 1) * 0.004)));
    expect(resets).toEqual(new Array(30).fill(false));
    // Clear of the band by now, and confirmed at the true lap.
    expect(confirmedLastProgress(slice, 1)).toBe(7 + (0.0001 + 30 * 0.004));
  });

  it("has no confirmed progress for a car it has never read", () => {
    const slice = createCarProgressState();

    expect(confirmedLastProgress(slice, 3)).toBeUndefined();
    expect(confirmedLastProgress(slice, -1)).toBeUndefined();
  });

  it("unconfirms a reading that did not continue the one before it, until the next one does", () => {
    const slice = createCarProgressState();

    step(
      slice,
      raw(100, [
        [6, 0.5],
        [6, 0.895],
      ]),
    );
    step(
      slice,
      raw(100.1, [
        [6, 0.501],
        [6, 0.9],
      ]),
    );
    expect(confirmedLastProgress(slice, 1)).toBe(6.9);

    // Towed back most of a lap: a new start, not a continuation.
    step(
      slice,
      raw(100.2, [
        [6, 0.502],
        [6, 0.2],
      ]),
    );
    expect(slice.lastProgress[1]).toBe(6.2);
    expect(confirmedLastProgress(slice, 1)).toBeUndefined();

    step(
      slice,
      raw(100.3, [
        [6, 0.503],
        [6, 0.201],
      ]),
    );
    expect(confirmedLastProgress(slice, 1)).toBe(6.201);
  });

  it("does not carry on a first reading taken while the counter led the fraction", () => {
    const slice = createCarProgressState();
    // Car 1 is first read on the very tick its counter has stepped and its
    // fraction has not wrapped: truly at 6.9999, it reads 7.9999.
    const seed = step(
      slice,
      raw(100, [
        [6, 0.5],
        [7, 0.9999],
      ]),
    );

    expect(seed!.progress[1]).toBe(7.9999);

    // The next reading is true, and is taken as it stands: one reset, because
    // the seed was a lap off, and no lap added to this or any later reading.
    const next = step(
      slice,
      raw(100.1, [
        [6, 0.501],
        [7, 0.0001],
      ]),
    );

    expect(next!.progress[1]).toBe(7.0001);
    expect(next!.traceReset).toEqual([false, true]);

    const readings: (number | null | undefined)[] = [];
    const resets: (boolean | undefined)[] = [];

    for (let k = 1; k <= 30; k++) {
      const read = step(
        slice,
        raw(100.1 + k * 0.1, [
          [6, 0.501 + k * 0.001],
          [7, 0.0001 + k * 0.004],
        ]),
      );

      readings.push(read!.progress[1]);
      resets.push(read!.traceReset[1]);
    }

    expect(readings).toEqual(Array.from({ length: 30 }, (_, i) => 7 + (0.0001 + (i + 1) * 0.004)));
    expect(resets).toEqual(new Array(30).fill(false));
    expect(slice.traces[1]![0]).toEqual({ progress: 7.0001, time: 100.1 });
  });

  it("does not carry on a first reading taken while the fraction led the counter", () => {
    const slice = createCarProgressState();
    // First read on the tick its fraction has wrapped and its counter has not
    // stepped: truly at 7.0001, it reads 6.0001.
    const seed = step(
      slice,
      raw(100, [
        [6, 0.5],
        [6, 0.0001],
      ]),
    );

    expect(seed!.progress[1]).toBe(6.0001);

    const next = step(
      slice,
      raw(100.1, [
        [6, 0.501],
        [7, 0.0002],
      ]),
    );

    expect(next!.progress[1]).toBe(7.0002);
    expect(next!.traceReset).toEqual([false, true]);

    const readings: (number | null | undefined)[] = [];
    const resets: (boolean | undefined)[] = [];

    for (let k = 1; k <= 30; k++) {
      const read = step(
        slice,
        raw(100.1 + k * 0.1, [
          [6, 0.501 + k * 0.001],
          [7, 0.0002 + k * 0.004],
        ]),
      );

      readings.push(read!.progress[1]);
      resets.push(read!.traceReset[1]);
    }

    expect(readings).toEqual(Array.from({ length: 30 }, (_, i) => 7 + (0.0002 + (i + 1) * 0.004)));
    expect(resets).toEqual(new Array(30).fill(false));
  });

  it("corrects a later disagreeing tick once two readings have confirmed each other", () => {
    const slice = createCarProgressState();

    // A wrong seed, then the true reading that replaces it, then one that confirms it.
    step(
      slice,
      raw(100, [
        [6, 0.5],
        [7, 0.9999],
      ]),
    );
    step(
      slice,
      raw(100.1, [
        [6, 0.501],
        [7, 0.0001],
      ]),
    );
    expect(confirmedLastProgress(slice, 1)).toBeUndefined();
    step(
      slice,
      raw(100.2, [
        [6, 0.502],
        [7, 0.0021],
      ]),
    );
    // Continuing, but still inside the guard band, where agreement confirms nothing.
    expect(confirmedLastProgress(slice, 1)).toBeUndefined();

    // Round the lap to the line again, confirmed once clear of the band.
    let time = 100.2;
    let pct = 0.0021;

    while (pct + 0.04 < 0.9999) {
      pct += 0.04;
      time += 0.1;
      step(
        slice,
        raw(time, [
          [6, 0.5],
          [7, pct],
        ]),
      );
    }

    step(
      slice,
      raw(time + 0.1, [
        [6, 0.5],
        [7, 0.9999],
      ]),
    );

    const desync = step(
      slice,
      raw(time + 0.2, [
        [6, 0.5],
        [8, 0.99995],
      ]),
    );

    expect(desync!.progress[1]).toBeCloseTo(7.99995, 10);
    expect(desync!.traceReset[1]).toBe(false);
  });

  it("reads the player's first crossing at the race start, where the gate opens on the counter's own step", () => {
    const slice = createCarProgressState();

    // On the grid behind the line: the player has completed no lap, so the gate is shut.
    expect(
      step(
        slice,
        raw(99.9, [
          [-1, 0.9998],
          [-1, 0.99],
        ]),
      ),
    ).toBeNull();

    // The player's counter steps to 0 a tick before its fraction wraps: the
    // gate opens on exactly this tick, and the reading is a lap high.
    const opened = step(
      slice,
      raw(100, [
        [0, 0.9999],
        [-1, 0.992],
      ]),
    );

    expect(opened!.progress).toEqual([0.9999, null]);
    expect(confirmedLastProgress(slice, PLAYER)).toBeUndefined();

    // The fraction wraps: the player is just past the line on lap one, not a lap further on.
    const wrapped = step(
      slice,
      raw(100.1, [
        [0, 0.0001],
        [-1, 0.994],
      ]),
    );

    expect(wrapped!.progress[PLAYER]).toBe(0.0001);
    expect(wrapped!.traceReset[PLAYER]).toBe(true);

    const readings: (number | null | undefined)[] = [];
    const resets: (boolean | undefined)[] = [];

    for (let k = 1; k <= 20; k++) {
      const read = step(
        slice,
        raw(100.1 + k * 0.1, [
          [0, 0.0001 + k * 0.004],
          [-1, 0.994],
        ]),
      );

      readings.push(read!.progress[PLAYER]);
      resets.push(read!.traceReset[PLAYER]);
    }

    expect(readings).toEqual(Array.from({ length: 20 }, (_, i) => 0.0001 + (i + 1) * 0.004));
    expect(resets).toEqual(new Array(20).fill(false));
    // The trace starts at the true reading and runs unbroken from it.
    expect(slice.traces[PLAYER]![0]).toEqual({ progress: 0.0001, time: 100.1 });
    expect(slice.traces[PLAYER]).toHaveLength(21);
  });
});
