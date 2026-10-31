/**
 * Unit tests for the track-order gaps outside a race (issue #1515).
 *
 * Pins, against a synthetic track with cars at scripted constant speeds (so
 * every crossing time is exact):
 *   - The session gate: practice, warmup, testing and open qualifying in;
 *     a race, a heat race, an empty type and the lone sessions out
 *   - The neighbours: the cars physically ahead and behind by lap distance,
 *     skipping the pace car, spectators, pit road and absent cars, keeping
 *     an OffTrack car, across the line, past 64 cars
 *   - The measurement: the race's crossing time on per-car odometer traces,
 *     whatever `CarIdxLapCompleted` says, cleared by an absence or a pit
 *     visit, the ETA reading behind a crawling car, nothing off the road
 *   - The display trend: the race's chain, reset on a neighbour change
 */
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffTrackGaps, isTrackGapSession } from "./track-gaps.js";

const PLAYER = 0;
/** A 90 s lap: 1/90 lap per second, ~44 m/s on a 4 km track. */
const V = 1 / 90;
const TRACK_M = 4000;
/** Tick spacing (s). Coarser than the sim's 60 Hz, fine for linear motion. */
const DT = 0.25;

/** A car at time `t`: its unwrapped position (laps) and surface, or null while it is not in the world. */
type CarFn = (t: number) => { pos: number; surface?: number } | null;

/** A car at constant speed `rate` (laps/s), at `pos0` laps when t = 0. */
function steady(pos0: number, rate = V): CarFn {
  return (t) => ({ pos: pos0 + rate * t });
}

function wrap(pos: number): number {
  return ((pos % 1) + 1) % 1;
}

type RunOptions = {
  sessionType?: string;
  sessionInfo?: Record<string, unknown> | null;
  /** Extra telemetry for every tick of the run. */
  extra?: (t: number) => Partial<TelemetryData>;
  trackLengthMeters?: number | null;
};

/** One tick's telemetry for a field of `cars` (index = carIdx), every `CarIdxLapCompleted` at -1. */
function telemetryAt(t: number, cars: CarFn[], extra: Partial<TelemetryData> = {}): TelemetryData {
  const pct: number[] = [];
  const surface: number[] = [];
  const laps: number[] = [];

  cars.forEach((car, idx) => {
    const at = car(t);

    pct[idx] = at === null ? -1 : wrap(at.pos);
    surface[idx] = at === null ? TrkLoc.NotInWorld : (at.surface ?? TrkLoc.OnTrack);
    laps[idx] = -1;
  });

  return {
    SessionTime: t,
    IsOnTrack: true,
    PlayerTrackSurface: surface[PLAYER],
    CarIdxLapDistPct: pct,
    CarIdxTrackSurface: surface,
    CarIdxLapCompleted: laps,
    ...extra,
  } as TelemetryData;
}

/** Drive the diff from `t0` to `t1` inclusive, one tick every {@link DT}. */
function run(state: TranslatorState, cars: CarFn[], t0: number, t1: number, opts: RunOptions = {}): void {
  const steps = Math.round((t1 - t0) / DT);

  for (let k = 0; k <= steps; k++) {
    const t = t0 + k * DT;

    diffTrackGaps(
      state,
      telemetryAt(t, cars, opts.extra?.(t)),
      opts.sessionType ?? "Practice",
      opts.sessionInfo ?? { DriverInfo: { Drivers: [] } },
      PLAYER,
      opts.trackLengthMeters === undefined ? TRACK_M : opts.trackLengthMeters,
    );
  }
}

function ahead(state: TranslatorState) {
  return state.trackGaps.ahead.live;
}

function behind(state: TranslatorState) {
  return state.trackGaps.behind.live;
}

describe("isTrackGapSession (issue #1515, Decision 1)", () => {
  it.each(["Practice", "Warmup", "Offline Testing", "Open Qualify"])("lets %s in", (type) => {
    expect(isTrackGapSession(type)).toBe(true);
  });

  it.each(["Race", "Heat Race", "", "Lone Qualify", "Lone Practice", "Something New"])("keeps %j out", (type) => {
    expect(isTrackGapSession(type)).toBe(false);
  });
});

describe("diffTrackGaps — the session gate", () => {
  const field = [steady(0.5), steady(0.55), steady(0.42)];

  it.each(["Practice", "Warmup", "Offline Testing", "Open Qualify"])("produces gaps in %s", (sessionType) => {
    const state = createInitialState();

    run(state, field, 0, 20, { sessionType });

    expect(ahead(state)).toMatchObject({ carIdx: 1, gapSeconds: expect.closeTo(4.5, 6), lapDelta: 0 });
    expect(behind(state)?.gapSeconds).toBeCloseTo(7.2, 6);
  });

  it.each(["Race", "Heat Race", "", "Lone Qualify", "Lone Practice"])("produces nothing in %j", (sessionType) => {
    const state = createInitialState();

    run(state, field, 0, 20, { sessionType });

    expect(ahead(state)).toBeNull();
    expect(behind(state)).toBeNull();
    expect(state.trackGaps.traces).toEqual([]);
  });

  it("drops the whole store when the session leaves the gate", () => {
    const state = createInitialState();

    run(state, field, 0, 20);
    expect(state.trackGaps.traces.length).toBe(3);

    run(state, field, 20.25, 21, { sessionType: "Race" });

    expect(state.trackGaps.traces).toEqual([]);
    expect(state.trackGaps.odometers).toEqual([]);
    expect(ahead(state)).toBeNull();
    expect(state.trackGaps.ahead.carIdx).toBe(-1);
  });
});

describe("diffTrackGaps — the neighbours (Decision 2)", () => {
  /** Car 1 just ahead (the one under test), car 2 further ahead, car 3 behind. */
  function fieldWith(car1: CarFn): CarFn[] {
    return [steady(0.5), car1, steady(0.6), steady(0.4)];
  }

  it("skips the pace car", () => {
    const state = createInitialState();

    run(state, fieldWith(steady(0.52)), 0, 1, { sessionInfo: { DriverInfo: { PaceCarIdx: 1, Drivers: [] } } });

    expect(ahead(state)?.carIdx).toBe(2);
    expect(state.trackGaps.traces[1]).toBeUndefined();
  });

  it("skips a spectator", () => {
    const state = createInitialState();

    run(state, fieldWith(steady(0.52)), 0, 1, {
      sessionInfo: { DriverInfo: { Drivers: [{ CarIdx: 1, IsSpectator: 1 }] } },
    });

    expect(ahead(state)?.carIdx).toBe(2);
  });

  it.each([
    ["InPitStall", TrkLoc.InPitStall],
    ["AproachingPits", TrkLoc.AproachingPits],
    ["NotInWorld", TrkLoc.NotInWorld],
  ])("skips a car whose surface is %s", (_name, surface) => {
    const state = createInitialState();

    run(
      state,
      fieldWith((t) => ({ pos: 0.52 + V * t, surface })),
      0,
      1,
    );

    expect(ahead(state)?.carIdx).toBe(2);
    expect(state.trackGaps.traces[1]).toBeUndefined();
  });

  it("judges pit road by the surface, never by CarIdxOnPitRoad", () => {
    const state = createInitialState();

    run(state, fieldWith(steady(0.52)), 0, 1, {
      extra: () => ({ CarIdxOnPitRoad: [false, true, false, false] }) as Partial<TelemetryData>,
    });

    expect(ahead(state)?.carIdx).toBe(1);
  });

  it("keeps an OffTrack car — a car spun off ahead is traffic", () => {
    const state = createInitialState();

    run(
      state,
      fieldWith((t) => ({ pos: 0.52 + V * t, surface: TrkLoc.OffTrack })),
      0,
      1,
    );

    expect(ahead(state)?.carIdx).toBe(1);
  });

  it("finds the car ahead across the start/finish line", () => {
    const state = createInitialState();

    run(state, [steady(0.98, 0), steady(0.02, 0), steady(0.5, 0)], 0, 0);

    expect(ahead(state)?.carIdx).toBe(1);
    expect(behind(state)?.carIdx).toBe(2);
  });

  it("walks a field longer than 64 entries to its end", () => {
    const cars: CarFn[] = Array.from({ length: 70 }, () => () => null);

    cars[PLAYER] = steady(0.5);
    cars[68] = steady(0.55);

    const state = createInitialState();

    run(state, cars, 0, 20);

    expect(ahead(state)).toMatchObject({ carIdx: 68, gapSeconds: expect.closeTo(4.5, 6), lapDelta: 0 });
    expect(behind(state)?.carIdx).toBe(68);
  });

  it("shows one other car on both sides, a lap minus the gap behind", () => {
    const state = createInitialState();

    run(state, [steady(0.5), steady(0.75)], 0, 80);

    expect(ahead(state)).toMatchObject({ carIdx: 1, gapSeconds: expect.closeTo(22.5, 6) });
    expect(behind(state)).toMatchObject({ carIdx: 1, gapSeconds: expect.closeTo(67.5, 6) });
  });

  it("leaves both sides null with no other car on the road", () => {
    const state = createInitialState();

    run(state, [steady(0.5), (t) => ({ pos: 0.6 + V * t, surface: TrkLoc.InPitStall })], 0, 10);

    expect(ahead(state)).toBeNull();
    expect(behind(state)).toBeNull();
  });
});

describe("diffTrackGaps — the measurement (Decision 3)", () => {
  it("reads the crossing times of a constant-speed field across the line, whatever CarIdxLapCompleted says", () => {
    const state = createInitialState();
    // Everyone near the line: the player crosses at t = 4.5, the car ahead
    // already has, the car behind crosses at t = 11.7. Every lap count reads -1.
    const field = [steady(0.95), steady(1.0), steady(0.87)];

    run(state, field, 0, 3);
    // Cold start: the car ahead's trace does not reach back 4.5 s yet.
    expect(ahead(state)?.gapSeconds).toBeNull();

    // The player has crossed the line; the car ahead now reads, the car behind
    // not yet: the player's own trace does not reach back 7.2 s.
    run(state, field, 3.25, 6);
    expect(ahead(state)).toMatchObject({ carIdx: 1, gapSeconds: expect.closeTo(4.5, 6), lapDelta: 0 });
    expect(behind(state)).toMatchObject({ carIdx: 2, gapSeconds: null });

    let from = 6.25;

    for (const until of [12, 30, 95]) {
      run(state, field, from, until);
      from = until + DT;
      expect(ahead(state)).toMatchObject({ carIdx: 1, gapSeconds: expect.closeTo(4.5, 6), lapDelta: 0 });
      expect(behind(state)).toMatchObject({ carIdx: 2, gapSeconds: expect.closeTo(7.2, 6), lapDelta: 0 });
    }

    // Equal pace: the display trend has warmed up and reads steady.
    expect(ahead(state)?.trend).toBe("steady");
    expect(behind(state)?.trend).toBe("steady");
  });

  it("gives the same gaps whatever the lap counts are", () => {
    const field = [steady(0.95), steady(1.0), steady(0.87)];
    const minusOne = createInitialState();
    const counted = createInitialState();

    run(minusOne, field, 0, 30);
    run(counted, field, 0, 30, {
      extra: (t) => ({ CarIdxLapCompleted: [Math.floor(0.95 + V * t) + 4, 12, 0] }) as Partial<TelemetryData>,
    });

    expect(ahead(counted)).toEqual(ahead(minusOne));
    expect(behind(counted)).toEqual(behind(minusOne));
  });

  it("clears a car's trace when it leaves the world and reads – after it returns until its trace covers the lookup", () => {
    const state = createInitialState();
    const car1: CarFn = (t) => (t > 20 && t < 25 ? null : { pos: 0.55 + V * t });

    run(state, [steady(0.5), car1], 0, 20);
    expect(ahead(state)?.gapSeconds).toBeCloseTo(4.5, 6);

    run(state, [steady(0.5), car1], 20.25, 24.75);
    expect(ahead(state)).toBeNull();
    expect(state.trackGaps.traces[1]).toBeUndefined();
    expect(state.trackGaps.odometers[1]).toBeUndefined();

    run(state, [steady(0.5), car1], 25, 29);
    expect(ahead(state)).toEqual({ carIdx: 1, gapSeconds: null, lapDelta: 0, trend: null });

    run(state, [steady(0.5), car1], 29.25, 31);
    expect(ahead(state)?.gapSeconds).toBeCloseTo(4.5, 6);
  });

  it("clears a car's trace on pit road, so it is measured afresh when it rejoins", () => {
    const state = createInitialState();
    const car1: CarFn = (t) => ({ pos: 0.55 + V * t, surface: t > 20 && t < 25 ? TrkLoc.AproachingPits : undefined });

    run(state, [steady(0.5), car1], 0, 24.75);
    expect(ahead(state)).toBeNull();
    expect(state.trackGaps.traces[1]).toBeUndefined();

    run(state, [steady(0.5), car1], 25, 27);
    expect(ahead(state)?.gapSeconds).toBeNull();

    run(state, [steady(0.5), car1], 27.25, 31);
    expect(ahead(state)?.gapSeconds).toBeCloseTo(4.5, 6);
  });

  it.each([
    ["in the pit stall", { PlayerTrackSurface: TrkLoc.InPitStall }, TrkLoc.InPitStall],
    ["approaching the pits", { PlayerTrackSurface: TrkLoc.AproachingPits }, TrkLoc.AproachingPits],
    ["out of the car", { IsOnTrack: false }, undefined],
  ])("has no track gaps with the player %s", (_name, extra, playerSurface) => {
    const state = createInitialState();
    const player: CarFn = (t) => ({ pos: 0.5 + V * t, surface: t > 20 ? playerSurface : undefined });

    run(state, [player, steady(0.55), steady(0.42)], 0, 20);
    expect(ahead(state)?.gapSeconds).toBeCloseTo(4.5, 6);

    run(state, [player, steady(0.55), steady(0.42)], 20.25, 22, {
      extra: () => extra as Partial<TelemetryData>,
    });

    expect(ahead(state)).toBeNull();
    expect(behind(state)).toBeNull();
    expect(state.trackGaps.traces[PLAYER]).toBeUndefined();
  });

  it("uses PlayerTrackSurface for the player when there is no per-car surface array", () => {
    const state = createInitialState();

    run(state, [steady(0.5), steady(0.55)], 0, 1, {
      extra: () => ({ CarIdxTrackSurface: undefined, PlayerTrackSurface: TrkLoc.InPitStall }) as Partial<TelemetryData>,
    });

    expect(ahead(state)).toBeNull();
  });

  it("switches to the ETA reading behind a crawling car ahead, and counts down", () => {
    const state = createInitialState();
    const slow = 5 / TRACK_M;
    // Car 1 runs at the player's pace 0.05 lap ahead, then crawls at 5 m/s from t = 20.
    const car1: CarFn = (t) => ({ pos: t <= 20 ? 0.55 + V * t : 0.55 + V * 20 + slow * (t - 20) });
    const separation = (t: number): number => car1(t)!.pos - (0.5 + V * t);

    run(state, [steady(0.5), car1], 0, 20);
    expect(ahead(state)?.gapSeconds).toBeCloseTo(4.5, 6);

    run(state, [steady(0.5), car1], 20.25, 23.5);
    const first = ahead(state)!;

    expect(first.trend).toBe("closing");
    expect(first.gapSeconds).toBeCloseTo(separation(23.5) / V, 6);

    run(state, [steady(0.5), car1], 23.75, 24);
    const later = ahead(state)!;

    expect(later.gapSeconds).toBeCloseTo(separation(24) / V, 6);
    expect(later.gapSeconds!).toBeLessThan(first.gapSeconds!);
    expect(later.trend).toBe("closing");
  });

  it("keeps the crossing time behind a crawling car when the track length is unknown", () => {
    const state = createInitialState();
    const slow = 5 / TRACK_M;
    const car1: CarFn = (t) => ({ pos: t <= 20 ? 0.55 + V * t : 0.55 + V * 20 + slow * (t - 20) });

    run(state, [steady(0.5), car1], 0, 23.5, { trackLengthMeters: null });

    // The crossing time: car 1 passed the player's spot before it slowed,
    // so the reading stays frozen at 4.5 s rather than risk a false ETA.
    expect(ahead(state)?.gapSeconds).toBeCloseTo(4.5, 6);
    expect(ahead(state)?.trend).not.toBe("closing");
  });
});

describe("diffTrackGaps — the display trend (Decision 5)", () => {
  /** The player 3 % faster than car 1, 0.05 lap ahead: the gap ahead closes by ~2.8 s a lap. */
  const field = [steady(0.5), steady(0.55, V * 0.97)];

  it("goes live within the race's sample count and reads closing", () => {
    const state = createInitialState();

    run(state, field, 0, 5);
    expect(ahead(state)?.gapSeconds).not.toBeNull();
    expect(ahead(state)?.trend).toBeNull();

    // A checkpoint every 0.02 lap (1.8 s): five rate samples after the anchor.
    run(state, field, 5.25, 12);
    expect(state.trackGaps.ahead.trend.samples).toBeLessThan(5);
    expect(ahead(state)?.trend).toBeNull();

    run(state, field, 12.25, 17);
    expect(state.trackGaps.ahead.trend.samples).toBeGreaterThanOrEqual(5);
    expect(ahead(state)?.trend).toBe("closing");
    expect(state.trackGaps.ahead.trend.ema).toBeLessThan(-0.15);
  });

  it("resets the side's chain when a different car becomes the neighbour", () => {
    const state = createInitialState();
    // Car 2 joins the road between the player and car 1 at t = 20.
    const car2: CarFn = (t) => (t < 20 ? null : { pos: 0.52 + V * t });

    run(state, [...field, car2], 0, 19.75);
    expect(ahead(state)?.trend).toBe("closing");

    run(state, [...field, car2], 20, 20);
    expect(ahead(state)).toEqual({ carIdx: 2, gapSeconds: null, lapDelta: 0, trend: null });
    expect(state.trackGaps.ahead.trend).toEqual({ lastCheckpoint: null, ema: null, samples: 0 });
  });
});
