/**
 * Unit tests for the replay-progress step (issue #1682).
 *
 * Pins:
 *   - a crossing whose lap counter and lap fraction disagree for a tick reads
 *     as continuous motion forwards and backwards, the counter leading or
 *     lagging
 *   - a pause on the disagreeing frame neither lengthens the run nor confirms
 *     the frame
 *   - a seek past the span, either way, and a non-finite `SessionTime` reset:
 *     nothing is corrected or confirmed across them
 *   - a first reading inside the band is confirmed by the run of three
 *   - a step that throws leaves no previous tick behind it
 *   - a fraction a hair below zero is the line; `-1` is no reading and drops
 *     the car's memory
 *   - missing arrays give no readings and drop every car's memory
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createReplayProgressState, type ReplayProgressState } from "../state.js";
import { runUnitsDirectly, type UnitRunner } from "../tick-steps.js";
import { CAR_PROGRESS_LINE_MAX_SPAN_S } from "./car-progress.js";
import { REPLAY_CAR_PROGRESS_POLICY, stepReplayProgress } from "./replay-progress.js";

const TICK_S = 1 / 60;
const REWIND_S = -0.2;

/** A replay tick: per car its `[lapCompleted, lapDistPct]`. */
function tick(sessionTime: number, cars: readonly (readonly [number, number])[]): TelemetryData {
  return {
    SessionTime: sessionTime,
    CarIdxLapCompleted: cars.map(([lc]) => lc),
    CarIdxLapDistPct: cars.map(([, dp]) => dp),
  } as TelemetryData;
}

/**
 * Steps one car through `readings` (`[lapCompleted, lapDistPct]`), one tick
 * apart by `dt` unless the reading names its own `SessionTime`, and returns the
 * car's progress after each.
 */
function drive(
  slice: ReplayProgressState,
  readings: readonly (readonly [number, number] | readonly [number, number, number])[],
  start = 100,
  dt = TICK_S,
): (number | null)[] {
  let time = start;

  return readings.map((reading, k) => {
    time = reading.length === 3 ? reading[2] : k === 0 ? start : time + dt;

    return stepReplayProgress(slice, tick(time, [[reading[0], reading[1]]]))![0]!;
  });
}

/** Four readings that confirm a car clear of the band, then three approaching the line. */
const APPROACH: readonly (readonly [number, number])[] = [
  [6, 0.9],
  [6, 0.9002],
  [6, 0.9997],
  [6, 0.9998],
  [6, 0.9999],
];

describe("stepReplayProgress — the policy", () => {
  it("is both directions, confirmed by a run, with a fraction a hair below zero read as the line", () => {
    expect(REPLAY_CAR_PROGRESS_POLICY.span).toBe("both");
    expect(REPLAY_CAR_PROGRESS_POLICY.confirmByRun).toBe(true);
    expect(REPLAY_CAR_PROGRESS_POLICY.readLapFraction(-0.00004)).toBe(-0.00004);
    expect(REPLAY_CAR_PROGRESS_POLICY.readLapFraction(-1)).toBeNull();
  });
});

describe("stepReplayProgress — crossings forwards", () => {
  it("reads the counter stepping a tick before the fraction wraps as continuous", () => {
    const slice = createReplayProgressState();
    const progress = drive(slice, [...APPROACH, [7, 1.0], [7, 0.0001]]);

    expect(progress.at(-2)).toBeCloseTo(7.0, 10);
    expect(progress.at(-1)).toBeCloseTo(7.0001, 10);
  });

  it("reads the counter stepping a tick after the fraction wraps as continuous", () => {
    const slice = createReplayProgressState();
    const progress = drive(slice, [...APPROACH, [6, 0.0001], [7, 0.0002]]);

    expect(progress.at(-2)).toBeCloseTo(7.0001, 10);
    expect(progress.at(-1)).toBeCloseTo(7.0002, 10);
  });
});

describe("stepReplayProgress — crossings backwards (a rewind)", () => {
  /** Confirmed clear of the band, then rewinding toward the line from just past it. */
  const LEAVING: readonly (readonly [number, number])[] = [
    [7, 0.1],
    [7, 0.0998],
    [7, 0.0003],
    [7, 0.0002],
  ];

  it("corrects a counter that has not yet stepped back as the fraction wraps", () => {
    const slice = createReplayProgressState();
    const progress = drive(slice, [...LEAVING, [7, 0.9999], [6, 0.9998]], 100, REWIND_S);

    expect(progress.at(-2)).toBeCloseTo(6.9999, 10);
    expect(progress.at(-1)).toBeCloseTo(6.9998, 10);
  });

  it("corrects a counter that steps back a tick before the fraction wraps", () => {
    const slice = createReplayProgressState();
    const progress = drive(slice, [...LEAVING, [6, 0.0001], [6, 0.9999]], 100, REWIND_S);

    expect(progress.at(-2)).toBeCloseTo(7.0001, 10);
    expect(progress.at(-1)).toBeCloseTo(6.9999, 10);
  });

  it("corrects nothing under the live forward span, which a rewind tick lies outside", () => {
    const slice = createReplayProgressState();
    const forwardOnly = { ...REPLAY_CAR_PROGRESS_POLICY, span: "forward" as const };
    let time = 100;
    let last: number | null = null;

    for (const [lc, dp] of [...LEAVING, [7, 0.9999] as const]) {
      last = stepReplayProgress(slice, tick(time, [[lc, dp]]), runUnitsDirectly, forwardOnly)![0]!;
      time += REWIND_S;
    }

    expect(last).toBeCloseTo(7.9999, 10);
  });
});

describe("stepReplayProgress — confirmation", () => {
  it("confirms a first reading inside the band by the third continuing reading at a distinct SessionTime", () => {
    const slice = createReplayProgressState();

    drive(slice, [
      [6, 0.996],
      [6, 0.997],
      [6, 0.998],
    ]);
    expect(slice.lastProgressConfirmed[0]).toBe(false);
    expect(slice.continuingRun[0]).toBe(2);

    const progress = drive(
      slice,
      [
        [6, 0.9985, 100 + 3 * TICK_S],
        [7, 0.999, 100 + 4 * TICK_S],
      ],
      100 + 3 * TICK_S,
    );

    expect(slice.continuingRun[0]).toBe(4);
    // Confirmed at 6.9985, so the disagreeing 7.999 is corrected to 6.999.
    expect(progress[1]).toBeCloseTo(6.999, 10);
  });

  it("does not confirm a disagreeing frame the replay pauses on: a repeated SessionTime adds nothing to the run", () => {
    const slice = createReplayProgressState();

    // A first reading inside the band, then the counter steps early: unconfirmed, not corrected.
    drive(slice, [
      [6, 0.9997],
      [6, 0.9998],
    ]);

    const t = 100 + 2 * TICK_S;
    const paused = drive(
      slice,
      [
        [7, 0.9999, t],
        [7, 0.9999, t],
        [7, 0.9999, t],
        [7, 0.9999, t],
        [7, 0.9999, t],
      ],
      t,
    );

    expect(paused.every((p) => Math.abs(p! - 7.9999) < 1e-9)).toBe(true);
    expect(slice.continuingRun[0]).toBe(0);
    expect(slice.lastProgressConfirmed[0]).toBe(false);

    // Play resumes: the true reading is taken as it stands, not "corrected" onto the wrong lap.
    const [resumed] = drive(slice, [[7, 0.0001, t + TICK_S]], t + TICK_S);

    expect(resumed).toBeCloseTo(7.0001, 10);
  });

  it("does not confirm a disagreeing frame whose arrays stand still while SessionTime runs on (an in-session replay paused at its live edge)", () => {
    const slice = createReplayProgressState();

    drive(slice, [
      [6, 0.9997],
      [6, 0.9998],
    ]);

    // The clock advances every tick, but the frame (and so the reading) repeats.
    const t = 100 + 2 * TICK_S;
    const paused = drive(
      slice,
      [
        [7, 0.9999],
        [7, 0.9999],
        [7, 0.9999],
        [7, 0.9999],
        [7, 0.9999],
      ],
      t,
    );

    expect(paused.every((p) => Math.abs(p! - 7.9999) < 1e-9)).toBe(true);
    expect(slice.continuingRun[0]).toBe(0);
    expect(slice.lastProgressConfirmed[0]).toBe(false);

    const [resumed] = drive(slice, [[7, 0.0001, t + 5 * TICK_S]], t + 5 * TICK_S);

    expect(resumed).toBeCloseTo(7.0001, 10);
  });

  it("does not confirm two disagreeing frames stepped back and forth: a reversal restarts the run", () => {
    const slice = createReplayProgressState();
    // Two consecutive frames that both read a lap high, stepped A, B, A, B.
    const A: readonly [number, number, number] = [7, 0.9998, 100];
    const B: readonly [number, number, number] = [7, 0.9999, 100 + TICK_S];

    drive(slice, [A, B, A, B], 100);

    expect(Math.abs(slice.continuingRun[0]!)).toBeLessThan(3);
    expect(slice.lastProgressConfirmed[0]).toBe(false);

    // The next true frame is taken as it stands, not "corrected" onto the wrong lap.
    const [next] = drive(slice, [[7, 0.0001, 100 + 2 * TICK_S]], 100 + 2 * TICK_S);

    expect(next).toBeCloseTo(7.0001, 10);
  });

  it("confirms a run that rewinds steadily, its run counted backwards", () => {
    const slice = createReplayProgressState();

    drive(
      slice,
      [
        [7, 0.004],
        [7, 0.003],
        [7, 0.002],
        [7, 0.001],
      ],
      100,
      REWIND_S,
    );

    expect(slice.continuingRun[0]).toBe(-3);
    expect(slice.lastProgressConfirmed[0]).toBe(true);
  });

  it("keeps a confirmed car corrected while the replay pauses on its disagreeing frame", () => {
    const slice = createReplayProgressState();

    drive(slice, APPROACH);

    const t = 100 + APPROACH.length * TICK_S;
    const paused = drive(
      slice,
      [
        [7, 1.0, t],
        [7, 1.0, t],
        [7, 1.0, t],
      ],
      t,
    );

    for (const p of paused) expect(p).toBeCloseTo(7.0, 10);
  });
});

describe("stepReplayProgress — resets", () => {
  for (const [label, jump] of [
    ["forwards", CAR_PROGRESS_LINE_MAX_SPAN_S + 0.01],
    ["backwards", -(CAR_PROGRESS_LINE_MAX_SPAN_S + 0.01)],
  ] as const) {
    it(`a seek ${label} past the span corrects and confirms nothing`, () => {
      const slice = createReplayProgressState();

      drive(slice, APPROACH);

      const t = 100 + (APPROACH.length - 1) * TICK_S + jump;
      const [after] = drive(slice, [[7, 1.0, t]], t);

      expect(after).toBe(8);
      expect(slice.lastProgressConfirmed[0]).toBe(false);
      expect(slice.continuingRun[0]).toBe(0);
    });
  }

  it("a seek of exactly the span still corrects, either way", () => {
    for (const jump of [CAR_PROGRESS_LINE_MAX_SPAN_S, -CAR_PROGRESS_LINE_MAX_SPAN_S]) {
      const slice = createReplayProgressState();

      drive(slice, APPROACH, 100);

      const t = 100 + (APPROACH.length - 1) * TICK_S + jump;
      const [after] = drive(slice, [[7, 1.0, t]], t);

      expect(after).toBeCloseTo(7.0, 10);
    }
  });

  it("a non-finite SessionTime reads every car as it stands, and leaves no previous tick", () => {
    const slice = createReplayProgressState();

    drive(slice, APPROACH);

    const odd = stepReplayProgress(slice, tick(Number.NaN, [[7, 1.0]]));

    expect(odd).toEqual([8]);
    expect(slice.lastReadSessionTime).toBeNull();
    expect(slice.lastProgressConfirmed[0]).toBe(false);

    const [next] = drive(slice, [[7, 1.0, 101]], 101);

    expect(next).toBe(8);
  });

  it("a step that throws mid-loop leaves no previous tick: the next one corrects nothing", () => {
    const slice = createReplayProgressState();

    drive(slice, APPROACH);
    expect(slice.lastReadSessionTime).not.toBeNull();

    const broken = tick(100 + APPROACH.length * TICK_S, [
      [6, 0.9999],
      [6, 0.5],
    ]);
    Object.defineProperty(broken.CarIdxLapCompleted as number[], 1, {
      get() {
        throw new Error("odd telemetry");
      },
    });

    expect(() => stepReplayProgress(slice, broken)).toThrow("odd telemetry");
    expect(slice.lastReadSessionTime).toBeNull();

    const [next] = drive(slice, [[7, 1.0, 100 + (APPROACH.length + 1) * TICK_S]], 100);

    expect(next).toBe(8);
  });

  it("runs each car as a unit: a car whose unit throws has no reading and no memory, the others keep theirs", () => {
    /** A runner like the translator's `steps.runUnit`: it catches a unit's throw and reports it failed. */
    const catching: UnitRunner = (emit, unit) => {
      try {
        unit(emit);

        return true;
      } catch {
        return false;
      }
    };
    const slice = createReplayProgressState();
    const cars = (k: number): [number, number][] => [
      [6, 0.9995 + k * 0.0001],
      [5, 0.5 + k * 0.001],
    ];

    APPROACH.forEach((_, k) => stepReplayProgress(slice, tick(100 + k * TICK_S, cars(k)), catching));
    expect(slice.lastProgressConfirmed[0]).toBe(true);

    // Car 1's entry throws on the disagreeing tick of car 0.
    const t = 100 + APPROACH.length * TICK_S;
    const broken = tick(t, [
      [7, 0.9999],
      [5, 0.51],
    ]);

    Object.defineProperty(broken.CarIdxLapDistPct as number[], 1, {
      get() {
        throw new Error("odd telemetry");
      },
    });

    const readings = stepReplayProgress(slice, broken, catching)!;

    // Car 0 is still corrected; car 1 has no reading and no memory.
    expect(readings[0]).toBeCloseTo(6.9999, 10);
    expect(readings[1]).toBeNull();
    expect(slice.lastProgress[1]).toBeUndefined();
    expect(slice.lastProgressConfirmed[1]).toBe(false);
    expect(slice.lastReadSessionTime).toBe(t);

    // Next tick car 1 is a first reading again; car 0 carries on corrected.
    const next = stepReplayProgress(
      slice,
      tick(t + TICK_S, [
        [7, 0.0001],
        [5, 0.511],
      ]),
      catching,
    )!;

    expect(next[0]).toBeCloseTo(7.0001, 10);
    expect(next[1]).toBeCloseTo(5.511, 10);
    expect(slice.continuingRun[1]).toBe(0);
  });

  it("missing arrays give no readings and drop every car's memory", () => {
    const slice = createReplayProgressState();

    drive(slice, APPROACH);

    expect(stepReplayProgress(slice, { SessionTime: 101 } as TelemetryData)).toBeNull();
    expect(slice.lastProgress).toEqual([]);
    expect(slice.lastProgressConfirmed).toEqual([]);
    expect(slice.continuingRun).toEqual([]);
    expect(slice.lastReadSessionTime).toBeNull();
  });
});

describe("stepReplayProgress — readings", () => {
  it("reads a fraction a hair below zero as the line: the plain sum, continuing the car's run", () => {
    const slice = createReplayProgressState();
    const progress = drive(slice, [...APPROACH, [7, 0.0], [7, -0.00004], [7, 0.0001]]);

    expect(progress.at(-2)).toBeCloseTo(6.99996, 10);
    expect(progress.at(-1)).toBeCloseTo(7.0001, 10);
    expect(slice.lastProgressConfirmed[0]).toBe(true);
  });

  it("reads -1 (not in the world) as no reading and drops the car's memory", () => {
    const slice = createReplayProgressState();

    drive(slice, APPROACH);

    const readings = stepReplayProgress(slice, tick(101, [[-1, -1]]));

    expect(readings).toEqual([null]);
    expect(slice.lastProgress[0]).toBeUndefined();
    expect(slice.lastProgressConfirmed[0]).toBe(false);
    expect(slice.continuingRun[0]).toBe(0);
  });

  it("sizes the readings to the shorter array and forgets cars past it", () => {
    const slice = createReplayProgressState();

    stepReplayProgress(
      slice,
      tick(100, [
        [3, 0.5],
        [4, 0.5],
        [5, 0.5],
      ]),
    );

    const narrower = {
      SessionTime: 100 + TICK_S,
      CarIdxLapCompleted: [3, 4, 5],
      CarIdxLapDistPct: [0.501, 0.501],
    } as TelemetryData;

    expect(stepReplayProgress(slice, narrower)).toEqual([3.501, 4.501]);
    expect(slice.lastProgress).toHaveLength(2);
    expect(slice.lastProgressConfirmed).toHaveLength(2);
    expect(slice.continuingRun).toHaveLength(2);
  });

  it("reads every car independently", () => {
    const slice = createReplayProgressState();
    let last: (number | null)[] | null = null;

    APPROACH.forEach(([lc, dp], k) => {
      last = stepReplayProgress(
        slice,
        tick(100 + k * TICK_S, [
          [lc, dp],
          [5, 0.5 + k * 0.001],
        ]),
      );
    });

    last = stepReplayProgress(
      slice,
      tick(100 + APPROACH.length * TICK_S, [
        [7, 1.0],
        [5, 0.6],
      ]),
    );

    expect(last![0]).toBeCloseTo(7.0, 10);
    // Car 1 jumped 0.095 lap in a tick: no line disagreement, read as it stands.
    expect(last![1]).toBeCloseTo(5.6, 10);
  });
});
