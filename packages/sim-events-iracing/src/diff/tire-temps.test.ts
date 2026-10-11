/**
 * Unit tests for the last-stop tire temperature reading (issue #254).
 *
 * Pins:
 *   - the zone mapping on both sides of the car, in °C and unrounded
 *     (`buildLastStopTireTemps`)
 *   - no reading for missing / non-finite / all-zero values
 *   - a stop the driver drove into takes the reading, keeps following the
 *     values until the car leaves its box, then freezes
 *   - a second entry into the box without a run in between is not followed
 *   - a garage start leaves the previous reading in place
 *   - a tow or reset into the box, and leaving the car, are each read once,
 *     only after a run on the circuit and only when the values changed from
 *     the ones the car carried there
 *   - a tick with no trustworthy values neither becomes the reading nor erases
 *     the previous one
 *   - the same through the real pit-lane → stall-visit → tire-temps chain,
 *     beside the tire wear diff on one stall-visit answer
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
import { buildLastStopTireTemps, diffTireTemps } from "./tire-temps.js";
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

const onCircuit = (overrides: Partial<TelemetryData> = {}): TelemetryData => telemetry(overrides);
const onPitRoad = (overrides: Partial<TelemetryData> = {}): TelemetryData =>
  telemetry({ OnPitRoad: true, PlayerTrackSurface: TrkLoc.AproachingPits, ...overrides });
const inStall = (overrides: Partial<TelemetryData> = {}): TelemetryData =>
  telemetry({ OnPitRoad: true, PlayerCarInPitStall: true, PlayerTrackSurface: TrkLoc.InPitStall, ...overrides });
/** The tick the car leaves its box: out of the stall, still on pit road. */
const leavingStall = (overrides: Partial<TelemetryData> = {}): TelemetryData =>
  inStall({ PlayerCarInPitStall: false, ...overrides });

/** Out of the car, in the garage. */
const inGarage = (values: Temps12): TelemetryData =>
  telemetry({ IsOnTrack: false, PlayerTrackSurface: TrkLoc.NotInWorld, ...temps(values) });
/** In the car but out of the world: the tick a tow or reset takes it off the circuit. */
const outOfWorld = (values: Temps12): TelemetryData =>
  telemetry({ PlayerTrackSurface: TrkLoc.NotInWorld, ...temps(values) });

const PIT_ENTERED: PendingEvent = { event: "pitLane.entered", data: {} };
const PIT_EXITED: PendingEvent = { event: "pitLane.exited", data: {} };
const STALL_ENTERED: PendingEvent = { event: "pitStall.entered", data: {} };
const STALL_DEPARTED: PendingEvent = { event: "pitStall.departed", data: {} };

/** Run one tick of the stall-visit rule and the diff, as the translator orders them. */
function step(state: TranslatorState, t: TelemetryData, pending: PendingEvent[] = []): LastStopTireTemps | null {
  diffTireTemps(state, t, updateStallVisit(state, t, pending));

  return state.lastStopTireTemps;
}

const reading = (values: Temps12): LastStopTireTemps | null => buildLastStopTireTemps(telemetry(temps(values)));

/** A stop the driver drove into and left again, holding `values` in the box. */
function driveThroughStop(state: TranslatorState, values: Temps12): void {
  step(state, onCircuit());
  step(state, onPitRoad(), [PIT_ENTERED]);
  step(state, inStall(temps(values)), [STALL_ENTERED]);
  step(state, leavingStall(temps(values)), [STALL_DEPARTED]);
  step(state, onCircuit(temps(values)), [PIT_EXITED]);
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

    expect(step(state, onCircuit(temps(STINT)))).toBeNull();
    expect(step(state, onPitRoad(temps(STINT)), [PIT_ENTERED])).toBeNull();
    expect(step(state, onPitRoad(temps(STINT)))).toBeNull();
  });

  it("takes the reading on the tick the car enters its box", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, onPitRoad(), [PIT_ENTERED]);

    expect(step(state, inStall(temps(STINT)), [STALL_ENTERED])).toEqual(reading(STINT));
  });

  it("keeps following the values on every tick in the box, the departure tick included", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, inStall(temps(PLACED)), [STALL_ENTERED]);

    expect(step(state, inStall(temps(STINT)))).toEqual(reading(STINT));
    expect(step(state, inStall(temps(HOTTER)))).toEqual(reading(HOTTER));
    expect(step(state, leavingStall(temps(STINT)), [STALL_DEPARTED])).toEqual(reading(STINT));
  });

  it("freezes once the car has left its box, whatever the values do afterwards", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);

    expect(step(state, onPitRoad(temps(HOTTER)))).toEqual(reading(STINT));
    expect(step(state, onCircuit(temps(HOTTER)), [PIT_EXITED])).toEqual(reading(STINT));
    expect(step(state, onCircuit(temps(PLACED)))).toEqual(reading(STINT));
  });

  it("is replaced by the next stop the driver drives into", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);
    driveThroughStop(state, HOTTER);

    expect(state.lastStopTireTemps).toEqual(reading(HOTTER));
  });

  it("is not taken on a drive-through with no stall visit", () => {
    const state = createInitialState();

    step(state, onCircuit(temps(STINT)));
    step(state, onPitRoad(temps(STINT)), [PIT_ENTERED]);

    expect(step(state, onCircuit(temps(STINT)), [PIT_EXITED])).toBeNull();
  });

  it("does not follow a second entry into the box before the car has been back on the circuit", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, inStall(temps(STINT)), [STALL_ENTERED]);
    // Out of the box onto pit road, then backed in again: the stall-visit rule
    // still calls it a drive-in, and the sim now holds the set the stop fitted.
    step(state, leavingStall(temps(STINT)), [STALL_DEPARTED]);
    step(state, onPitRoad(temps(PLACED)));

    expect(step(state, inStall(temps(PLACED)), [STALL_ENTERED])).toEqual(reading(STINT));
    expect(step(state, inStall(temps(HOTTER)))).toEqual(reading(STINT));
    expect(step(state, leavingStall(temps(HOTTER)), [STALL_DEPARTED])).toEqual(reading(STINT));
  });

  it("keeps the reading when the stall flag flickers off and on mid-visit", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, inStall(temps(STINT)), [STALL_ENTERED]);
    step(state, leavingStall(temps(STINT)), [STALL_DEPARTED]);

    expect(step(state, inStall(temps(STINT)), [STALL_ENTERED])).toEqual(reading(STINT));
  });

  it("follows a stop whose run carried no trustworthy values on the circuit", () => {
    const state = createInitialState();

    step(state, onCircuit(temps(ZEROS)));
    step(state, onPitRoad(temps(ZEROS)), [PIT_ENTERED]);

    expect(step(state, inStall(temps(STINT)), [STALL_ENTERED])).toEqual(reading(STINT));
  });

  it("stops following the values when the visit ends with no departure edge", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, inStall(temps(STINT)), [STALL_ENTERED]);

    // Out of the box and off pit road on one tick: no `pitStall.departed`.
    expect(step(state, onCircuit(temps(HOTTER)), [PIT_EXITED])).toEqual(reading(STINT));
    expect(step(state, onCircuit(temps(HOTTER)))).toEqual(reading(STINT));
  });
});

/** Sit in the box through a placed visit holding `values`, then leave it. */
function sitAndLeave(state: TranslatorState, values: Temps12): void {
  step(state, inStall(temps(values)));
  step(state, leavingStall(temps(values)), [STALL_DEPARTED]);
  step(state, onCircuit(temps(values)), [PIT_EXITED]);
}

describe("diffTireTemps — a stall visit that is not a stop", () => {
  it("takes no reading after a garage start in the stall", () => {
    const state = createInitialState();

    step(state, inGarage(PLACED));
    // "Drive": in the car, already on pit road and in the stall, all on one tick.
    expect(step(state, inStall(temps(PLACED)), [PIT_ENTERED, STALL_ENTERED])).toBeNull();
    sitAndLeave(state, PLACED);

    expect(state.lastStopTireTemps).toBeNull();
  });

  it("leaves the previous reading in place through a garage start", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);
    // Out of the car with the values the stop left: nothing was refreshed.
    step(state, inGarage(STINT));
    step(state, inStall(temps(PLACED)), [PIT_ENTERED, STALL_ENTERED]);
    sitAndLeave(state, PLACED);

    expect(state.lastStopTireTemps).toEqual(reading(STINT));
  });

  it("takes no reading when the car is first seen in its box (connecting mid-stop)", () => {
    const state = createInitialState();

    step(state, inStall(temps(STINT)));
    sitAndLeave(state, STINT);

    expect(state.lastStopTireTemps).toBeNull();
  });

  it("takes the reading again at the stop after a garage start", () => {
    const state = createInitialState();

    step(state, inGarage(PLACED));
    step(state, inStall(temps(PLACED)), [PIT_ENTERED, STALL_ENTERED]);
    sitAndLeave(state, PLACED);
    driveThroughStop(state, STINT);

    expect(state.lastStopTireTemps).toEqual(reading(STINT));
  });
});

describe("diffTireTemps — a tow or reset into the box", () => {
  it("takes the reading on the first tick in the box, from the values the sim refreshed as the car left the world", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);

    // The refresh lands on the out-of-world tick; the car is not in its box yet.
    expect(step(state, outOfWorld(HOTTER))).toEqual(reading(STINT));
    expect(step(state, inStall(temps(HOTTER)), [PIT_ENTERED, STALL_ENTERED])).toEqual(reading(HOTTER));
  });

  it("takes it with no reading before it", () => {
    const state = createInitialState();

    step(state, onCircuit(temps(STINT)));
    step(state, outOfWorld(HOTTER));

    expect(step(state, inStall(temps(HOTTER)), [PIT_ENTERED, STALL_ENTERED])).toEqual(reading(HOTTER));
  });

  it("reads it once: the values of later ticks in the box are not followed", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);
    step(state, outOfWorld(HOTTER));
    step(state, inStall(temps(HOTTER)), [PIT_ENTERED, STALL_ENTERED]);

    expect(step(state, inStall(temps(PLACED)))).toEqual(reading(HOTTER));
    sitAndLeave(state, PLACED);
    expect(state.lastStopTireTemps).toEqual(reading(HOTTER));
  });

  it("takes it when the car goes straight from the circuit into its box, with no out-of-world tick", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);

    expect(step(state, inStall(temps(HOTTER)), [PIT_ENTERED, STALL_ENTERED])).toEqual(reading(HOTTER));
  });

  it("takes it when PlayerCarInPitStall lags the surface by a tick", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);

    expect(step(state, inStall({ PlayerCarInPitStall: false, ...temps(HOTTER) }), [PIT_ENTERED])).toEqual(
      reading(STINT),
    );
    expect(step(state, inStall(temps(HOTTER)), [STALL_ENTERED])).toEqual(reading(HOTTER));
  });

  it("takes none when the values are the ones the car carried on the circuit", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);
    // The latest tick on the circuit is what the box is measured against.
    step(state, onCircuit(temps(PLACED)));
    step(state, onCircuit(temps(HOTTER)));
    step(state, outOfWorld(HOTTER));
    step(state, inStall(temps(HOTTER)), [PIT_ENTERED, STALL_ENTERED]);
    sitAndLeave(state, HOTTER);

    expect(state.lastStopTireTemps).toEqual(reading(STINT));
  });

  it("takes none on a second reset without a run on the circuit in between", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);
    step(state, outOfWorld(HOTTER));
    step(state, inStall(temps(HOTTER)), [PIT_ENTERED, STALL_ENTERED]);
    // Out of the box and down pit road, never onto the circuit, then reset again.
    step(state, leavingStall(temps(HOTTER)), [STALL_DEPARTED]);
    step(state, onPitRoad(temps(HOTTER)));
    step(state, outOfWorld(PLACED));
    step(state, inStall(temps(PLACED)), [STALL_ENTERED]);

    expect(state.lastStopTireTemps).toEqual(reading(HOTTER));
  });

  it("takes none when the values on the circuit could not be trusted: nothing proves a refresh", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);
    step(state, onCircuit(temps(ZEROS)));
    step(state, outOfWorld(HOTTER));
    step(state, inStall(temps(HOTTER)), [PIT_ENTERED, STALL_ENTERED]);

    expect(state.lastStopTireTemps).toEqual(reading(STINT));
  });

  it("waits out a tick whose values cannot be trusted", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);
    step(state, outOfWorld(ZEROS));

    expect(step(state, inStall(temps(ZEROS)), [PIT_ENTERED, STALL_ENTERED])).toEqual(reading(STINT));
    expect(step(state, inStall(temps(HOTTER)))).toEqual(reading(HOTTER));
  });

  it("is replaced by the next stop the driver drives into", () => {
    const state = createInitialState();

    step(state, onCircuit(temps(PLACED)));
    step(state, outOfWorld(STINT));
    step(state, inStall(temps(STINT)), [PIT_ENTERED, STALL_ENTERED]);
    sitAndLeave(state, STINT);
    driveThroughStop(state, HOTTER);

    expect(state.lastStopTireTemps).toEqual(reading(HOTTER));
  });
});

describe("diffTireTemps — leaving the car after a run", () => {
  it("takes the reading on the tick the driver is out of the car, when the sim refreshed the values", () => {
    const state = createInitialState();

    step(state, onCircuit(temps(PLACED)));

    expect(step(state, inGarage(STINT))).toEqual(reading(STINT));
  });

  it("replaces the last stop's reading", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);

    expect(step(state, inGarage(HOTTER))).toEqual(reading(HOTTER));
  });

  it("takes none when the values are the ones the car carried on the circuit", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);
    step(state, onCircuit(temps(HOTTER)));

    expect(step(state, inGarage(HOTTER))).toEqual(reading(STINT));
  });

  it("reads it once: whatever the garage holds afterwards is not a reading", () => {
    const state = createInitialState();

    step(state, onCircuit(temps(PLACED)));
    step(state, inGarage(STINT));

    expect(step(state, inGarage(HOTTER))).toEqual(reading(STINT));
    expect(step(state, inGarage(PLACED))).toEqual(reading(STINT));
  });

  it("is never replaced by the Drive placement that follows", () => {
    const state = createInitialState();

    step(state, onCircuit(temps(PLACED)));
    step(state, inGarage(STINT));
    step(state, inStall(temps(PLACED)), [PIT_ENTERED, STALL_ENTERED]);
    sitAndLeave(state, PLACED);

    expect(state.lastStopTireTemps).toEqual(reading(STINT));
  });

  it("ends the run even when nothing was refreshed, so the Drive placement that follows takes none", () => {
    const state = createInitialState();

    driveThroughStop(state, STINT);
    step(state, inGarage(STINT));
    // The garage fitted a fresh set: different values, but no run behind them.
    step(state, inStall(temps(PLACED)), [PIT_ENTERED, STALL_ENTERED]);
    step(state, inStall(temps(PLACED)));

    expect(state.lastStopTireTemps).toEqual(reading(STINT));
  });

  it("takes none without a run on the circuit", () => {
    const state = createInitialState();

    step(state, inGarage(PLACED));
    step(state, inStall(temps(PLACED)), [PIT_ENTERED, STALL_ENTERED]);
    step(state, leavingStall(temps(PLACED)), [STALL_DEPARTED]);
    step(state, onPitRoad(temps(PLACED)));

    expect(step(state, inGarage(STINT))).toBeNull();
  });

  it("takes none in the box after a stop the driver drove into, whatever set the stop fitted", () => {
    const state = createInitialState();

    step(state, onCircuit(temps(PLACED)));
    step(state, onPitRoad(temps(PLACED)), [PIT_ENTERED]);
    step(state, inStall(temps(STINT)), [STALL_ENTERED]);

    // The stop was the reading of that run; the fresh set is not one.
    expect(step(state, inGarage(PLACED))).toEqual(reading(STINT));
  });

  it("takes none from a tick whose values cannot be trusted, and the run is over", () => {
    const state = createInitialState();

    step(state, onCircuit(temps(PLACED)));

    expect(step(state, inGarage(ZEROS))).toBeNull();
    expect(step(state, inGarage(STINT))).toBeNull();
  });
});

describe("diffTireTemps — values that cannot be trusted", () => {
  /** A drive-in stop whose box ticks carry `box`. */
  function stopWith(state: TranslatorState, box: Partial<TelemetryData>): void {
    step(state, onCircuit());
    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, inStall(box), [STALL_ENTERED]);
    step(state, inStall(box));
    step(state, leavingStall(box), [STALL_DEPARTED]);
  }

  /** Each with one way the box ticks' values can be unusable. */
  const UNTRUSTWORTHY: Array<[string, Partial<TelemetryData>]> = [
    ["a missing value", { ...temps(HOTTER), LRtempCM: undefined }],
    ["a non-finite value", { ...temps(HOTTER), RFtempCL: NaN }],
    ["all twelve values at zero", temps(ZEROS)],
  ];

  it.each(UNTRUSTWORTHY)("takes no reading from %s", (_name, box) => {
    const state = createInitialState();

    stopWith(state, box);

    expect(state.lastStopTireTemps).toBeNull();
  });

  it.each(UNTRUSTWORTHY)("does not erase the previous reading on %s", (_name, box) => {
    const state = createInitialState();

    driveThroughStop(state, STINT);
    stopWith(state, box);

    expect(state.lastStopTireTemps).toEqual(reading(STINT));
  });

  it("keeps the last trustworthy tick of a visit whose values drop out part-way", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, inStall(temps(STINT)), [STALL_ENTERED]);

    expect(step(state, inStall(temps(ZEROS)))).toEqual(reading(STINT));
    expect(step(state, leavingStall({ ...temps(HOTTER), LFtempCL: Infinity }), [STALL_DEPARTED])).toEqual(
      reading(STINT),
    );
  });
});

/**
 * Run telemetry through the diffs the translator runs for a stop, in its
 * order, with the stall visit resolved once and handed to both tire families.
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

    const stallVisit = updateStallVisit(state, tick, pending);

    diffTireWear(state, tick, emit, pending, stallVisit);
    diffTireTemps(state, tick, stallVisit);

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

  it("takes the reading in the box, freezes it at departure, and the stop still reports its wear", () => {
    const { readings, events } = runChain([
      onCircuit({ ...WEAR, ...temps(PLACED) }),
      onCircuit({ ...WEAR, ...temps(PLACED), PlayerTrackSurface: TrkLoc.AproachingPits }),
      onPitRoad({ ...WEAR, ...temps(PLACED) }),
      // The arrival refresh lands before `PlayerCarInPitStall`, as wear's does.
      onPitRoad({ ...WEAR, ...temps(STINT), PlayerTrackSurface: TrkLoc.InPitStall }),
      inStall({ ...WEAR, ...temps(STINT) }),
      inStall({ ...WEAR, ...temps(STINT) }),
      leavingStall({ ...WEAR, ...temps(STINT) }),
      onPitRoad({ ...WEAR, ...temps(STINT) }),
      onCircuit({ ...WEAR, ...temps(STINT), PlayerTrackSurface: TrkLoc.AproachingPits }),
      onCircuit({ ...WEAR, ...temps(STINT) }),
    ]);

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
    // One stall-visit answer served both families: the wear report still rides
    // the exit readback of the same stop.
    expect(events.filter((e) => e.event === "tireWear.reported")).toHaveLength(1);
  });

  it("reads a reset into the box off the real pit-lane edges, and reports no wear for it", () => {
    const { readings, events } = runChain([
      onCircuit({ ...WEAR, ...temps(PLACED) }),
      onCircuit({ ...WEAR, ...temps(PLACED) }),
      // Reset: out of the world for one tick, the values already refreshed.
      outOfWorld(STINT),
      inStall(temps(STINT)),
      inStall(temps(STINT)),
      leavingStall(temps(STINT)),
      onPitRoad(temps(STINT)),
      onCircuit(temps(STINT)),
    ]);

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
      telemetry({ IsOnTrack: false, PlayerTrackSurface: TrkLoc.NotInWorld }),
      // "Drive": placed in the box with the tires iRacing gave the car.
      inStall(),
      inStall(),
      leavingStall(),
      onPitRoad(),
      onCircuit(),
      // A stint later, the first real stop.
      onPitRoad(),
      inStall(temps(STINT)),
      leavingStall(temps(STINT)),
      onCircuit(temps(STINT)),
    ]);

    expect(readings.slice(0, 7)).toEqual([null, null, null, null, null, null, null]);
    expect(readings.slice(7)).toEqual([reading(STINT), reading(STINT), reading(STINT)]);
  });
});
