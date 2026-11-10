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
 */
import { GAP_TRACE_MAX_STEP, GAP_TRACE_MIN_STEP, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { type CarProgressState, createCarProgressState } from "../state.js";
import { stepCarProgress } from "./car-progress.js";

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
