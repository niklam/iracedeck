/**
 * Unit tests for the shared stall-visit rule (issues #1108, #254).
 *
 * Pins:
 *   - a visit the car drove into answers `driveIn` from `pitStall.entered`
 *     through `pitStall.departed`, both included, and on no other tick
 *   - a garage start, a tow and a teleport into the stall are never a drive-in
 *   - a visit that ends with no departure edge stops answering `driveIn`
 *   - the departure tick releases the latch (why the rule runs once per tick)
 *   - the same answers through the real `diffPitLane` edges
 *
 *   - what counts as driving on the circuit (`isDrivingOnCircuit`)
 *
 * The tire-wear family's own tests (`tire-wear.test.ts`) run against this
 * module too: they hand `diffTireWear` the visit resolved here.
 */
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { TrackType } from "../track-type.js";
import { diffPitLane } from "./pit-lane.js";
import { isDrivingOnCircuit, type StallVisit, updateStallVisit } from "./stall-visit.js";
import type { PendingEvent } from "./types.js";

function telemetry(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsOnTrack: true,
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    PlayerTrackSurface: TrkLoc.OnTrack,
    ...overrides,
  } as TelemetryData;
}

const onCircuit = (overrides: Partial<TelemetryData> = {}): TelemetryData => telemetry(overrides);
const onPitRoad = (overrides: Partial<TelemetryData> = {}): TelemetryData =>
  telemetry({ OnPitRoad: true, PlayerTrackSurface: TrkLoc.AproachingPits, ...overrides });
const inStall = (overrides: Partial<TelemetryData> = {}): TelemetryData =>
  telemetry({ OnPitRoad: true, PlayerCarInPitStall: true, PlayerTrackSurface: TrkLoc.InPitStall, ...overrides });
/** The tick the car leaves its box: out of the stall, still on pit road. */
const leavingStall = (): TelemetryData => inStall({ PlayerCarInPitStall: false });
/** Out of the car, in the garage. */
const inGarage = (): TelemetryData => telemetry({ IsOnTrack: false, PlayerTrackSurface: TrkLoc.NotInWorld });

const PIT_ENTERED: PendingEvent = { event: "pitLane.entered", data: {} };
const STALL_ENTERED: PendingEvent = { event: "pitStall.entered", data: {} };
const STALL_DEPARTED: PendingEvent = { event: "pitStall.departed", data: {} };

const NOT_A_VISIT: StallVisit = { driveIn: false, departed: false };
const DRIVE_IN: StallVisit = { driveIn: true, departed: false };
const DRIVE_IN_DEPARTING: StallVisit = { driveIn: true, departed: true };
const PLACED_DEPARTING: StallVisit = { driveIn: false, departed: true };

const step = (state: TranslatorState, t: TelemetryData, pending: PendingEvent[] = []): StallVisit =>
  updateStallVisit(state, t, pending);

describe("isDrivingOnCircuit", () => {
  it("is true in the car, in the world, off pit road and out of the box", () => {
    expect(isDrivingOnCircuit(onCircuit())).toBe(true);
  });

  it("stays true off the racing surface and in the pit approach zone", () => {
    expect(isDrivingOnCircuit(onCircuit({ PlayerTrackSurface: TrkLoc.OffTrack }))).toBe(true);
    expect(isDrivingOnCircuit(onCircuit({ PlayerTrackSurface: TrkLoc.AproachingPits }))).toBe(true);
  });

  it("is false on pit road and in the box", () => {
    expect(isDrivingOnCircuit(onPitRoad())).toBe(false);
    expect(isDrivingOnCircuit(inStall())).toBe(false);
    expect(isDrivingOnCircuit(leavingStall())).toBe(false);
  });

  it("is false out of the car and out of the world", () => {
    expect(isDrivingOnCircuit(onCircuit({ IsOnTrack: false }))).toBe(false);
    expect(isDrivingOnCircuit(onCircuit({ PlayerTrackSurface: TrkLoc.NotInWorld }))).toBe(false);
  });

  it("is false when the fields are missing", () => {
    expect(isDrivingOnCircuit({} as TelemetryData)).toBe(false);
  });
});

describe("updateStallVisit — a visit the car drove into", () => {
  it("answers driveIn from pitStall.entered through pitStall.departed, and on no other tick", () => {
    const state = createInitialState();

    expect(step(state, onCircuit())).toEqual(NOT_A_VISIT);
    expect(step(state, onPitRoad(), [PIT_ENTERED])).toEqual(NOT_A_VISIT);
    expect(step(state, onPitRoad())).toEqual(NOT_A_VISIT);
    expect(step(state, inStall(), [STALL_ENTERED])).toEqual(DRIVE_IN);
    expect(step(state, inStall())).toEqual(DRIVE_IN);
    expect(step(state, inStall())).toEqual(DRIVE_IN);
    expect(step(state, leavingStall(), [STALL_DEPARTED])).toEqual(DRIVE_IN_DEPARTING);
    expect(step(state, onPitRoad())).toEqual(NOT_A_VISIT);
    expect(step(state, onCircuit(), [{ event: "pitLane.exited", data: {} }])).toEqual(NOT_A_VISIT);
  });

  it("carries the on-circuit flag down pit road untouched", () => {
    const state = createInitialState();

    step(state, onCircuit());
    expect(state.stallVisitDroveOnCircuit).toBe(true);

    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, onPitRoad());
    expect(state.stallVisitDroveOnCircuit).toBe(true);
    expect(state.stallVisitDriveIn).toBe(false);
  });

  it("is still a drive-in after running wide off the circuit before the lane", () => {
    const state = createInitialState();

    step(state, onCircuit({ PlayerTrackSurface: TrkLoc.OffTrack }));
    step(state, onPitRoad(), [PIT_ENTERED]);

    expect(step(state, inStall(), [STALL_ENTERED])).toEqual(DRIVE_IN);
  });

  it("releases the latch on the departure tick — a second call on it would answer not a drive-in", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, inStall(), [STALL_ENTERED]);

    expect(step(state, leavingStall(), [STALL_DEPARTED])).toEqual(DRIVE_IN_DEPARTING);
    expect(state.stallVisitDriveIn).toBe(false);
    expect(step(state, leavingStall(), [STALL_DEPARTED])).toEqual(PLACED_DEPARTING);
  });

  it("is a drive-in again when the stall flag flickers off and on mid-visit", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, inStall(), [STALL_ENTERED]);
    expect(step(state, leavingStall(), [STALL_DEPARTED])).toEqual(DRIVE_IN_DEPARTING);

    // Still on pit road, so the on-circuit flag is the one it arrived with.
    expect(step(state, inStall(), [STALL_ENTERED])).toEqual(DRIVE_IN);
  });
});

describe("updateStallVisit — a visit the car was placed into", () => {
  it("is not a drive-in after a garage start in the stall", () => {
    const state = createInitialState();

    expect(step(state, inGarage())).toEqual(NOT_A_VISIT);
    // "Drive": in the car, already on pit road and in the stall, all on one tick.
    expect(step(state, inStall(), [PIT_ENTERED, STALL_ENTERED])).toEqual(NOT_A_VISIT);
    expect(step(state, inStall())).toEqual(NOT_A_VISIT);
    expect(step(state, leavingStall(), [STALL_DEPARTED])).toEqual(PLACED_DEPARTING);
  });

  it("is not a drive-in after a garage start even when the driver had been on the circuit before the garage", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, telemetry({ IsOnTrack: false }));

    expect(step(state, inStall(), [PIT_ENTERED, STALL_ENTERED])).toEqual(NOT_A_VISIT);
    expect(step(state, leavingStall(), [STALL_DEPARTED])).toEqual(PLACED_DEPARTING);
  });

  it("is not a drive-in after a tow into the stall (NotInWorld on the way)", () => {
    const state = createInitialState();

    step(state, onCircuit());
    // Towed: the car leaves the world, then appears in its box.
    step(state, telemetry({ PlayerTrackSurface: TrkLoc.NotInWorld }));

    expect(step(state, inStall(), [PIT_ENTERED, STALL_ENTERED])).toEqual(NOT_A_VISIT);
    expect(step(state, inStall())).toEqual(NOT_A_VISIT);
    expect(step(state, leavingStall(), [STALL_DEPARTED])).toEqual(PLACED_DEPARTING);
  });

  it("is not a drive-in when a reset puts the car straight from the circuit into its box", () => {
    const state = createInitialState();

    step(state, onCircuit());

    // No NotInWorld tick in between: the car arrives on pit road already in the box.
    expect(step(state, inStall(), [PIT_ENTERED, STALL_ENTERED])).toEqual(NOT_A_VISIT);
    expect(step(state, leavingStall(), [STALL_DEPARTED])).toEqual(PLACED_DEPARTING);
  });

  it("is not a drive-in when that teleport's PlayerCarInPitStall lags the surface by a tick", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, inStall({ PlayerCarInPitStall: false }), [PIT_ENTERED]);

    expect(step(state, inStall(), [STALL_ENTERED])).toEqual(NOT_A_VISIT);
  });

  it("is not a drive-in when the car is first seen on pit road", () => {
    const state = createInitialState();

    step(state, onPitRoad());

    expect(step(state, inStall(), [STALL_ENTERED])).toEqual(NOT_A_VISIT);
    expect(step(state, leavingStall(), [STALL_DEPARTED])).toEqual(PLACED_DEPARTING);
  });

  it("the stop after a garage start is a drive-in again", () => {
    const state = createInitialState();

    step(state, inGarage());
    step(state, inStall(), [PIT_ENTERED, STALL_ENTERED]);
    step(state, leavingStall(), [STALL_DEPARTED]);
    step(state, onCircuit(), [{ event: "pitLane.exited", data: {} }]);
    step(state, onPitRoad(), [PIT_ENTERED]);

    expect(step(state, inStall(), [STALL_ENTERED])).toEqual(DRIVE_IN);
  });

  it("a placement straight after a drive-in stop is not a drive-in", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, onPitRoad(), [PIT_ENTERED]);
    step(state, inStall(), [STALL_ENTERED]);
    step(state, leavingStall(), [STALL_DEPARTED]);
    step(state, onCircuit(), [{ event: "pitLane.exited", data: {} }]);
    // Towed back to the box.
    step(state, telemetry({ PlayerTrackSurface: TrkLoc.NotInWorld }));

    expect(step(state, inStall(), [PIT_ENTERED, STALL_ENTERED])).toEqual(NOT_A_VISIT);
  });
});

describe("updateStallVisit — a visit that ends with no departure edge", () => {
  it("stops answering driveIn once the car is out of its box", () => {
    const state = createInitialState();

    step(state, onCircuit());
    step(state, onPitRoad(), [PIT_ENTERED]);
    expect(step(state, inStall(), [STALL_ENTERED])).toEqual(DRIVE_IN);

    // Out of the box and off pit road on one tick: `diffPitLane` emits
    // `pitLane.exited` and no `pitStall.departed`.
    expect(step(state, onCircuit(), [{ event: "pitLane.exited", data: {} }])).toEqual(NOT_A_VISIT);
    expect(step(state, onCircuit())).toEqual(NOT_A_VISIT);
  });
});

/** Run telemetry through `diffPitLane` and the stall-visit rule, as the translator orders them. */
function runChain(ticks: ReadonlyArray<TelemetryData>): StallVisit[] {
  const state = createInitialState();

  return ticks.map((tick, i) => {
    const pending: PendingEvent[] = [];

    diffPitLane(state, tick, TrackType.RoadCourse, i * 1000, (e) => pending.push(e));

    return updateStallVisit(state, tick, pending);
  });
}

describe("updateStallVisit — through the real pit-lane diff", () => {
  it("a stop the driver drove into is a drive-in from the box to the tick it leaves", () => {
    expect(
      runChain([
        onCircuit(),
        onCircuit({ PlayerTrackSurface: TrkLoc.AproachingPits }),
        onPitRoad(),
        inStall(),
        inStall(),
        leavingStall(),
        onPitRoad(),
        onCircuit(),
      ]),
    ).toEqual([
      NOT_A_VISIT,
      NOT_A_VISIT,
      NOT_A_VISIT,
      DRIVE_IN,
      DRIVE_IN,
      DRIVE_IN_DEPARTING,
      NOT_A_VISIT,
      NOT_A_VISIT,
    ]);
  });

  it("a garage start is never a drive-in, and the stop after it is", () => {
    expect(
      runChain([
        inGarage(),
        // "Drive": placed in the box.
        inStall(),
        inStall(),
        leavingStall(),
        onPitRoad(),
        onCircuit(),
        // A lap later, the first real stop.
        onPitRoad(),
        inStall(),
        leavingStall(),
      ]),
    ).toEqual([
      NOT_A_VISIT,
      NOT_A_VISIT,
      NOT_A_VISIT,
      PLACED_DEPARTING,
      NOT_A_VISIT,
      NOT_A_VISIT,
      NOT_A_VISIT,
      DRIVE_IN,
      DRIVE_IN_DEPARTING,
    ]);
  });

  it("a car the translator first sees in its box is not on a drive-in visit", () => {
    // The pit-lane diff seeds silently on its first tick, so no stall edge fires.
    expect(runChain([inStall(), inStall(), leavingStall()])).toEqual([NOT_A_VISIT, NOT_A_VISIT, PLACED_DEPARTING]);
  });
});
