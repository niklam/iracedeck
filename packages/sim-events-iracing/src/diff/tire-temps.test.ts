/**
 * Unit tests for the last-stop tire temperature reading (issue #254).
 *
 * Pins:
 *   - the zone mapping on both sides of the car, in °C and unrounded
 *     (`buildLastStopTireTemps`)
 *   - no reading for missing / non-finite / all-zero values
 *   - a reading is taken once, with the car standing in its box (a stop, a tow
 *     or a reset alike) or the driver out of the car, only after a run on the
 *     circuit and only when the values changed from the ones the car carried
 *     there
 *   - taking it ends the run: a second entry into the box, an in-box reset and
 *     a garage "Drive" placement are never one
 *   - a car that clips its box with nothing refreshed takes none, and the run
 *     goes on
 *   - a tick with no trustworthy values neither becomes the reading nor erases
 *     the previous one
 *   - the same through the real pit-lane diff, beside the tire wear diff
 *
 * The reading's lifetime across replay visits, session changes, a disconnect
 * and a saved replay is the translator's, and is pinned in `translator.test.ts`.
 */
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type LastStopTireTemps, type TranslatorState } from "../state.js";
import { TrackType } from "../track-type.js";
import { diffPitLane } from "./pit-lane.js";
import { diffPitReadback } from "./pit-readback.js";
import { updateStallVisit } from "./stall-visit.js";
import { buildLastStopTireTemps, diffTireTemps, readTireTempsLeavingCar } from "./tire-temps.js";
import { diffTireWear } from "./tire-wear.js";
import type { PendingEvent } from "./types.js";

/** Twelve values in the sim's order: LF L/M/R, RF L/M/R, LR L/M/R, RR L/M/R. */
type Temps12 = [number, number, number, number, number, number, number, number, number, number, number, number];

const TEMP_FIELDS = [
  "LFtempCL",
  "LFtempCM",
  "LFtempCR",
  "RFtempCL",
  "RFtempCM",
  "RFtempCR",
  "LRtempCL",
  "LRtempCM",
  "LRtempCR",
  "RRtempCL",
  "RRtempCM",
  "RRtempCR",
] as const;

function temps(values: Temps12): Partial<TelemetryData> {
  return Object.fromEntries(TEMP_FIELDS.map((field, i) => [field, values[i]])) as Partial<TelemetryData>;
}

/** What iRacing places a car with: every zone near 40 °C. */
const PLACED: Temps12 = [39.9, 39.9, 39.9, 39.9, 39.9, 39.9, 39.9, 39.9, 39.9, 39.9, 39.9, 39.9];
/** A stint's worth of heat, every zone distinct. */
const STINT: Temps12 = [71, 78, 84, 86, 79, 72, 68, 74, 77, 79, 75, 69];
/** A later, hotter stint. */
const HOTTER: Temps12 = [91, 98, 104, 106, 99, 92, 88, 94, 97, 99, 95, 89];
const ZEROS: Temps12 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

function telemetry(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsOnTrack: true,
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    PlayerTrackSurface: TrkLoc.OnTrack,
    ...temps(PLACED),
    ...overrides,
  } as TelemetryData;
}

const onCircuit = (values: Temps12): TelemetryData => telemetry(temps(values));
const onPitRoad = (values: Temps12): TelemetryData =>
  telemetry({ OnPitRoad: true, PlayerTrackSurface: TrkLoc.AproachingPits, ...temps(values) });
const inStall = (values: Temps12): TelemetryData =>
  telemetry({ OnPitRoad: true, PlayerCarInPitStall: true, PlayerTrackSurface: TrkLoc.InPitStall, ...temps(values) });
/** The tick the car leaves its box: out of the stall, still on pit road. */
const leavingStall = (values: Temps12): TelemetryData =>
  telemetry({ OnPitRoad: true, PlayerTrackSurface: TrkLoc.InPitStall, ...temps(values) });
/** Out of the car, in the garage. */
const inGarage = (values: Temps12): TelemetryData =>
  telemetry({ IsOnTrack: false, PlayerTrackSurface: TrkLoc.NotInWorld, ...temps(values) });
/** In the car but out of the world: the tick a tow or reset takes it off the circuit. */
const outOfWorld = (values: Temps12): TelemetryData =>
  telemetry({ PlayerTrackSurface: TrkLoc.NotInWorld, ...temps(values) });

/** Run one tick of the diff and answer the reading it leaves. */
function step(state: TranslatorState, t: TelemetryData): LastStopTireTemps | null {
  diffTireTemps(state, t);

  return state.lastStopTireTemps;
}

const reading = (values: Temps12): LastStopTireTemps | null => buildLastStopTireTemps(telemetry(temps(values)));

/**
 * A run on the circuit carrying `carried`, then a stop the driver drove into
 * whose arrival refreshes the values to `refreshed` — on pit road, before the
 * stall flag, as the sim does — and back out onto the circuit.
 */
function runAndStop(state: TranslatorState, carried: Temps12, refreshed: Temps12): void {
  step(state, onCircuit(carried));
  step(state, onPitRoad(carried));
  step(state, onPitRoad(refreshed));
  step(state, inStall(refreshed));
  step(state, leavingStall(refreshed));
  step(state, onCircuit(refreshed));
}

describe("buildLastStopTireTemps", () => {
  it("maps L/M/R to outside/middle/inside on the left-side tires and inside/middle/outside on the right", () => {
    expect(buildLastStopTireTemps(telemetry(temps([91, 92, 93, 81, 82, 83, 71, 72, 73, 61, 62, 63])))).toEqual({
      corners: {
        lf: { outside: 91, middle: 92, inside: 93 },
        rf: { inside: 81, middle: 82, outside: 83 },
        lr: { outside: 71, middle: 72, inside: 73 },
        rr: { inside: 61, middle: 62, outside: 63 },
      },
    });
  });

  it("reports each zone in °C, unrounded", () => {
    const built = buildLastStopTireTemps(
      telemetry(temps([83.38091373443604, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80])),
    );

    expect(built?.corners.lf.outside).toBe(83.38091373443604);
  });

  it("reads temperatures at and below freezing", () => {
    const built = buildLastStopTireTemps(telemetry(temps([-3.5, 0, 2, 1, 0, -2, -1, 0, 1, 2, 0, -4])));

    expect(built?.corners.lf).toEqual({ outside: -3.5, middle: 0, inside: 2 });
    expect(built?.corners.rr).toEqual({ inside: 2, middle: 0, outside: -4 });
  });

  it("returns null when any value is missing", () => {
    for (const field of TEMP_FIELDS) {
      const t = telemetry(temps(STINT));

      delete (t as unknown as Record<string, unknown>)[field];

      expect(buildLastStopTireTemps(t), field).toBeNull();
    }
  });

  it("returns null when any value is not a finite number", () => {
    for (const bad of [NaN, Infinity, -Infinity, "80" as unknown as number, null as unknown as number]) {
      expect(buildLastStopTireTemps(telemetry({ ...temps(STINT), RRtempCM: bad })), String(bad)).toBeNull();
    }
  });

  it("returns null when all twelve values are zero (no temperature model)", () => {
    expect(buildLastStopTireTemps(telemetry(temps(ZEROS)))).toBeNull();
  });

  it("still reads when only some values are zero", () => {
    const built = buildLastStopTireTemps(telemetry(temps([0, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5])));

    expect(built?.corners.lf).toEqual({ outside: 0, middle: 5, inside: 5 });
  });
});

describe("diffTireTemps — a stop the driver drove into", () => {
  it("has no reading before the first stop, on the circuit or on pit road", () => {
    const state = createInitialState();

    expect(step(state, onCircuit(PLACED))).toBeNull();
    expect(step(state, onPitRoad(PLACED))).toBeNull();
    expect(step(state, onPitRoad(STINT))).toBeNull();
  });

  it("takes the reading on the tick the car stands in its box, from the refresh that came before it", () => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));
    step(state, onPitRoad(PLACED));
    // The arrival refresh: on pit road, ahead of the stall flag.
    expect(step(state, onPitRoad(STINT))).toBeNull();

    expect(step(state, inStall(STINT))).toEqual(reading(STINT));
  });

  it("takes a refresh that lands after the car is already in its box, on the tick it lands", () => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));
    step(state, onPitRoad(PLACED));

    expect(step(state, inStall(PLACED))).toBeNull();
    expect(step(state, inStall(PLACED))).toBeNull();
    expect(step(state, inStall(STINT))).toEqual(reading(STINT));
  });

  it("reads it once: whatever the box holds afterwards is not followed", () => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));
    step(state, onPitRoad(STINT));
    step(state, inStall(STINT));

    expect(step(state, inStall(HOTTER))).toEqual(reading(STINT));
    expect(step(state, leavingStall(HOTTER))).toEqual(reading(STINT));
    expect(step(state, onPitRoad(HOTTER))).toEqual(reading(STINT));
    expect(step(state, onCircuit(HOTTER))).toEqual(reading(STINT));
  });

  it("is replaced by the next stop after another run", () => {
    const state = createInitialState();

    runAndStop(state, PLACED, STINT);
    runAndStop(state, STINT, HOTTER);

    expect(state.lastStopTireTemps).toEqual(reading(HOTTER));
  });

  it("is not taken on a drive-through with no stall visit", () => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));
    step(state, onPitRoad(STINT));

    expect(step(state, onCircuit(STINT))).toBeNull();
  });

  it("takes none from a car that clips its box with nothing refreshed, and reads the real stop after it", () => {
    const state = createInitialState();

    runAndStop(state, PLACED, STINT);
    step(state, onCircuit(STINT));
    step(state, onPitRoad(STINT));
    // Through the box with the values the car carried on the circuit.
    expect(step(state, inStall(STINT))).toEqual(reading(STINT));
    step(state, leavingStall(STINT));
    // Reversed back in: now the sim refreshes.
    step(state, onPitRoad(HOTTER));

    expect(step(state, inStall(HOTTER))).toEqual(reading(HOTTER));
  });

  it("does not read a second entry into the box before the car has been back on the circuit", () => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));
    step(state, onPitRoad(STINT));
    step(state, inStall(STINT));
    // Out of the box onto pit road, then backed in again, the sim now holding
    // the set the stop fitted.
    step(state, leavingStall(STINT));
    step(state, onPitRoad(PLACED));

    expect(step(state, inStall(PLACED))).toEqual(reading(STINT));
    expect(step(state, inStall(HOTTER))).toEqual(reading(STINT));
  });

  it("does not read a reset pressed while standing in the box", () => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));
    step(state, onPitRoad(STINT));
    step(state, inStall(STINT));
    // The reset refreshes the values with the set the stop fitted — whether or
    // not the out-of-world tick between is ever seen.
    expect(step(state, inStall(PLACED))).toEqual(reading(STINT));
    step(state, outOfWorld(HOTTER));

    expect(step(state, inStall(HOTTER))).toEqual(reading(STINT));
  });
});

describe("diffTireTemps — a placement that ends no run", () => {
  it("takes no reading after a garage start in the stall", () => {
    const state = createInitialState();

    step(state, inGarage(PLACED));
    // "Drive": in the car, already on pit road and in the stall, all on one tick.
    expect(step(state, inStall(STINT))).toBeNull();
    step(state, leavingStall(STINT));

    expect(step(state, onCircuit(STINT))).toBeNull();
  });

  it("takes no reading when the car is first seen in its box (connecting mid-stop)", () => {
    const state = createInitialState();

    expect(step(state, inStall(STINT))).toBeNull();
    expect(step(state, inStall(HOTTER))).toBeNull();
  });

  it("takes the reading at the stop after a garage start", () => {
    const state = createInitialState();

    step(state, inGarage(PLACED));
    step(state, inStall(PLACED));
    step(state, leavingStall(PLACED));
    runAndStop(state, PLACED, STINT);

    expect(state.lastStopTireTemps).toEqual(reading(STINT));
  });
});

describe("diffTireTemps — a tow or reset into the box", () => {
  it("takes the reading on the first tick in the box, from the values the sim refreshed as the car left the world", () => {
    const state = createInitialState();

    runAndStop(state, PLACED, STINT);

    // The refresh lands on the out-of-world tick; the car is not in its box yet.
    expect(step(state, outOfWorld(HOTTER))).toEqual(reading(STINT));
    expect(step(state, inStall(HOTTER))).toEqual(reading(HOTTER));
  });

  it("takes it with no reading before it", () => {
    const state = createInitialState();

    step(state, onCircuit(STINT));
    step(state, outOfWorld(HOTTER));

    expect(step(state, inStall(HOTTER))).toEqual(reading(HOTTER));
  });

  it("reads it once: the values of later ticks in the box are not followed", () => {
    const state = createInitialState();

    step(state, onCircuit(STINT));
    step(state, outOfWorld(HOTTER));
    step(state, inStall(HOTTER));

    expect(step(state, inStall(PLACED))).toEqual(reading(HOTTER));
    step(state, leavingStall(PLACED));
    expect(step(state, onCircuit(PLACED))).toEqual(reading(HOTTER));
  });

  it("takes it when the car goes straight from the circuit into its box, with no out-of-world tick", () => {
    const state = createInitialState();

    step(state, onCircuit(STINT));

    expect(step(state, inStall(HOTTER))).toEqual(reading(HOTTER));
  });

  it("takes it when PlayerCarInPitStall lags the surface by a tick", () => {
    const state = createInitialState();

    step(state, onCircuit(STINT));

    expect(step(state, leavingStall(HOTTER))).toBeNull();
    expect(step(state, inStall(HOTTER))).toEqual(reading(HOTTER));
  });

  it("takes none when the values are the ones the car carried on the circuit", () => {
    const state = createInitialState();

    runAndStop(state, PLACED, STINT);
    // The latest tick on the circuit is what the box is measured against.
    step(state, onCircuit(PLACED));
    step(state, onCircuit(HOTTER));
    step(state, outOfWorld(HOTTER));
    step(state, inStall(HOTTER));

    expect(state.lastStopTireTemps).toEqual(reading(STINT));
  });

  it("takes none on a second reset without a run on the circuit in between", () => {
    const state = createInitialState();

    step(state, onCircuit(STINT));
    step(state, outOfWorld(HOTTER));
    step(state, inStall(HOTTER));
    // Out of the box and down pit road, never onto the circuit, then reset again.
    step(state, leavingStall(HOTTER));
    step(state, onPitRoad(HOTTER));
    step(state, outOfWorld(PLACED));

    expect(step(state, inStall(PLACED))).toEqual(reading(HOTTER));
  });

  it("takes none when the values on the circuit could not be trusted: nothing proves a refresh", () => {
    const state = createInitialState();

    step(state, onCircuit(ZEROS));
    step(state, outOfWorld(HOTTER));

    expect(step(state, inStall(HOTTER))).toBeNull();
  });

  it("waits out a tick whose values cannot be trusted", () => {
    const state = createInitialState();

    step(state, onCircuit(STINT));
    step(state, outOfWorld(ZEROS));

    expect(step(state, inStall(ZEROS))).toBeNull();
    expect(step(state, inStall(HOTTER))).toEqual(reading(HOTTER));
  });
});

describe("diffTireTemps — leaving the car after a run", () => {
  it("takes the reading on the tick the driver is out of the car, when the sim refreshed the values", () => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));

    expect(step(state, inGarage(STINT))).toEqual(reading(STINT));
  });

  it("replaces the last stop's reading", () => {
    const state = createInitialState();

    runAndStop(state, PLACED, STINT);

    expect(step(state, inGarage(HOTTER))).toEqual(reading(HOTTER));
  });

  it("takes none when the values are the ones the car carried on the circuit", () => {
    const state = createInitialState();

    runAndStop(state, PLACED, STINT);
    step(state, onCircuit(HOTTER));

    expect(step(state, inGarage(HOTTER))).toEqual(reading(STINT));
  });

  it("reads it once: whatever the garage holds afterwards is not a reading", () => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));
    step(state, inGarage(STINT));

    expect(step(state, inGarage(HOTTER))).toEqual(reading(STINT));
    expect(step(state, inGarage(PLACED))).toEqual(reading(STINT));
  });

  it("is never replaced by the Drive placement that follows", () => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));
    step(state, inGarage(STINT));
    step(state, inStall(PLACED));
    step(state, leavingStall(PLACED));

    expect(step(state, onCircuit(PLACED))).toEqual(reading(STINT));
  });

  it("ends the run even when nothing was refreshed, so the Drive placement that follows takes none", () => {
    const state = createInitialState();

    runAndStop(state, PLACED, STINT);
    step(state, inGarage(STINT));
    // The garage fitted a fresh set: different values, but no run behind them.
    step(state, inStall(PLACED));

    expect(step(state, inStall(PLACED))).toEqual(reading(STINT));
  });

  it("takes none without a run on the circuit", () => {
    const state = createInitialState();

    step(state, inGarage(PLACED));
    step(state, inStall(PLACED));
    step(state, leavingStall(PLACED));
    step(state, onPitRoad(PLACED));

    expect(step(state, inGarage(STINT))).toBeNull();
  });

  it("takes none in the box after a stop, whatever set the stop fitted", () => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));
    step(state, onPitRoad(STINT));
    step(state, inStall(STINT));

    // The stop was the reading of that run; the fresh set is not one.
    expect(step(state, inGarage(PLACED))).toEqual(reading(STINT));
  });

  it("takes none from a tick whose values cannot be trusted, and the run is over", () => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));

    expect(step(state, inGarage(ZEROS))).toBeNull();
    expect(step(state, inGarage(STINT))).toBeNull();
  });

  it("reads the same through the translator's pre-guard entry point", () => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));
    readTireTempsLeavingCar(state, inGarage(STINT));
    expect(state.lastStopTireTemps).toEqual(reading(STINT));

    // The run is over: a second call with other values takes nothing.
    readTireTempsLeavingCar(state, inGarage(HOTTER));
    expect(state.lastStopTireTemps).toEqual(reading(STINT));
    expect(state.tireTempsOnCircuit).toBeNull();
  });
});

describe("diffTireTemps — values that cannot be trusted", () => {
  /** Each with one way a tick's values can be unusable. */
  const UNTRUSTWORTHY: Array<[string, Partial<TelemetryData>]> = [
    ["a missing value", { ...temps(HOTTER), LRtempCM: undefined }],
    ["a non-finite value", { ...temps(HOTTER), RFtempCL: NaN }],
    ["all twelve values at zero", temps(ZEROS)],
  ];

  const box = (overrides: Partial<TelemetryData>): TelemetryData =>
    telemetry({ OnPitRoad: true, PlayerCarInPitStall: true, PlayerTrackSurface: TrkLoc.InPitStall, ...overrides });

  it.each(UNTRUSTWORTHY)("takes no reading from %s in the box", (_name, bad) => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));
    step(state, box(bad));
    step(state, box(bad));

    expect(state.lastStopTireTemps).toBeNull();
  });

  it.each(UNTRUSTWORTHY)("does not erase the previous reading on %s", (_name, bad) => {
    const state = createInitialState();

    runAndStop(state, PLACED, STINT);
    step(state, box(bad));

    expect(state.lastStopTireTemps).toEqual(reading(STINT));
  });

  it.each(UNTRUSTWORTHY)("takes the first trustworthy tick of the visit after %s", (_name, bad) => {
    const state = createInitialState();

    step(state, onCircuit(PLACED));
    step(state, box(bad));

    expect(step(state, inStall(STINT))).toEqual(reading(STINT));
  });

  it.each(UNTRUSTWORTHY)("has nothing to measure a stop against after a run that carried %s", (_name, bad) => {
    const state = createInitialState();

    step(state, telemetry(bad));

    expect(step(state, inStall(STINT))).toBeNull();
  });
});

/**
 * Run telemetry through the diffs the translator runs for a stop, in its
 * order: the pit-lane and readback diffs, the stall visit the wear report
 * asks, the wear report and the tire temperatures.
 */
function runChain(ticks: ReadonlyArray<TelemetryData>): {
  readings: Array<LastStopTireTemps | null>;
  events: PendingEvent[];
} {
  const state = createInitialState();
  const readings: Array<LastStopTireTemps | null> = [];
  const events: PendingEvent[] = [];

  ticks.forEach((tick, i) => {
    const now = i * 10_000;
    const pending: PendingEvent[] = [];
    const emit = (e: PendingEvent): void => {
      pending.push(e);
    };

    diffPitLane(state, tick, TrackType.RoadCourse, now, emit);
    diffPitReadback(state, tick, now, emit, pending);
    diffTireWear(state, tick, emit, pending, updateStallVisit(state, tick, pending));
    diffTireTemps(state, tick);

    readings.push(state.lastStopTireTemps);
    events.push(...pending);
  });

  return { readings, events };
}

describe("diffTireTemps — through the real pit-lane diff, beside the tire wear diff", () => {
  const WEAR: Partial<TelemetryData> = {
    LFwearL: 0.95,
    LFwearM: 0.93,
    LFwearR: 0.9,
    RFwearL: 0.91,
    RFwearM: 0.94,
    RFwearR: 0.96,
    LRwearL: 0.97,
    LRwearM: 0.96,
    LRwearR: 0.98,
    RRwearL: 0.985,
    RRwearM: 0.975,
    RRwearR: 0.99,
  };
  const withWear = (tick: TelemetryData): TelemetryData => ({ ...tick, ...WEAR });

  it("takes the reading in the box, holds it through departure, and the stop still reports its wear", () => {
    const { readings, events } = runChain(
      [
        onCircuit(PLACED),
        telemetry({ PlayerTrackSurface: TrkLoc.AproachingPits }),
        onPitRoad(PLACED),
        // The arrival refresh lands before `PlayerCarInPitStall`, as wear's does.
        leavingStall(STINT),
        inStall(STINT),
        inStall(STINT),
        leavingStall(STINT),
        onPitRoad(STINT),
        telemetry({ PlayerTrackSurface: TrkLoc.AproachingPits, ...temps(STINT) }),
        onCircuit(STINT),
      ].map(withWear),
    );

    expect(readings).toEqual([
      null,
      null,
      null,
      null,
      reading(STINT),
      reading(STINT),
      reading(STINT),
      reading(STINT),
      reading(STINT),
      reading(STINT),
    ]);
    expect(events.filter((e) => e.event === "tireWear.reported")).toHaveLength(1);
  });

  it("reads a reset into the box, and reports no wear for it", () => {
    const { readings, events } = runChain(
      [
        onCircuit(PLACED),
        onCircuit(PLACED),
        // Reset: out of the world for one tick, the values already refreshed.
        outOfWorld(STINT),
        inStall(STINT),
        inStall(STINT),
        leavingStall(STINT),
        onPitRoad(STINT),
        onCircuit(STINT),
      ].map(withWear),
    );

    expect(readings).toEqual([
      null,
      null,
      null,
      reading(STINT),
      reading(STINT),
      reading(STINT),
      reading(STINT),
      reading(STINT),
    ]);
    expect(events.filter((e) => e.event === "tireWear.reported")).toHaveLength(0);
  });

  it("a garage start takes none, and the first stop after it does", () => {
    const { readings } = runChain([
      inGarage(PLACED),
      // "Drive": placed in the box with the tires iRacing gave the car.
      inStall(PLACED),
      inStall(PLACED),
      leavingStall(PLACED),
      onPitRoad(PLACED),
      onCircuit(PLACED),
      // A stint later, the first real stop.
      onPitRoad(STINT),
      inStall(STINT),
      leavingStall(STINT),
      onCircuit(STINT),
    ]);

    expect(readings.slice(0, 7)).toEqual([null, null, null, null, null, null, null]);
    expect(readings.slice(7)).toEqual([reading(STINT), reading(STINT), reading(STINT)]);
  });
});
