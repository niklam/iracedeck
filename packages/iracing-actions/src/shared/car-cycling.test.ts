import { carInWorld, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { computeCarNumberTarget, computeTrackOrderTarget } from "./car-cycling.js";

/**
 * A field of competitors by carIdx → lap distance (0..1). The physical track
 * order around the lap is the ASCENDING LapDistPct order (wrapping at
 * start/finish), regardless of lap count or race position.
 */
const CARS = [
  { carIdx: 1, carNumber: "3", carNumberRaw: 3 },
  { carIdx: 3, carNumber: "42", carNumberRaw: 42 },
  { carIdx: 5, carNumber: "99", carNumberRaw: 99 },
  { carIdx: 7, carNumber: "12", carNumberRaw: 12 },
];

/** Telemetry with per-car lap distances; every listed car is on track unless overridden. */
function telemetryWith(lapDistPct: Record<number, number>, trackSurface: Record<number, number> = {}): TelemetryData {
  // Sized to the highest carIdx in play (min 10) — real fields are sparse and
  // can reach well past a dozen slots.
  const size = Math.max(10, ...Object.keys(lapDistPct).map((k) => Number(k) + 1));
  const dp = Array.from({ length: size }, (_, i) => lapDistPct[i] ?? -1);
  const ts = Array.from(
    { length: size },
    (_, i) => trackSurface[i] ?? (lapDistPct[i] !== undefined ? TrkLoc.OnTrack : TrkLoc.NotInWorld),
  );

  return { CarIdxLapDistPct: dp, CarIdxTrackSurface: ts } as unknown as TelemetryData;
}

describe("computeTrackOrderTarget", () => {
  // Track order (ascending lap distance): #12 (0.10) → #42 (0.30) → #3 (0.55) → #99 (0.80) → wraps to #12.
  const telemetry = telemetryWith({ 7: 0.1, 3: 0.3, 1: 0.55, 5: 0.8 });

  it("returns the physically nearest competitor ahead of the focused car", () => {
    // Focused #42 at 0.30 → ahead is #3 at 0.55 (NOT #99, which is further along).
    expect(computeTrackOrderTarget(telemetry, 3, CARS, "ahead")).toEqual({
      carIdx: 1,
      carNumberRaw: 3,
      carNumber: "3",
    });
  });

  it("returns the physically nearest competitor behind the focused car", () => {
    // Focused #42 at 0.30 → behind is #12 at 0.10.
    expect(computeTrackOrderTarget(telemetry, 3, CARS, "behind")).toEqual({
      carIdx: 7,
      carNumberRaw: 12,
      carNumber: "12",
    });
  });

  it("wraps across start/finish: the car ahead of the last car on the lap is the first car on the lap", () => {
    // Focused #99 at 0.80 → ahead wraps to #12 at 0.10.
    expect(computeTrackOrderTarget(telemetry, 5, CARS, "ahead")?.carNumber).toBe("12");
    // Focused #12 at 0.10 → behind wraps to #99 at 0.80.
    expect(computeTrackOrderTarget(telemetry, 7, CARS, "behind")?.carNumber).toBe("99");
  });

  it("orders by physical track position, never by lap count or race position", () => {
    // A lapped car (#12) sitting just ahead on the road is still "the car ahead".
    const withLaps = { ...telemetry, CarIdxLapCompleted: [0, 5, 0, 5, 0, 5, 0, 2, 0, 0] } as unknown as TelemetryData;

    expect(computeTrackOrderTarget(withLaps, 5, CARS, "ahead")?.carNumber).toBe("12");
  });

  it("skips cars that are not in the competitor list even when physically closer (pace car / spectators)", () => {
    // carIdx 8 (the pace car — not in CARS) sits at 0.35, between #42 and #3.
    const withPaceCar = telemetryWith({ 7: 0.1, 3: 0.3, 8: 0.35, 1: 0.55, 5: 0.8 });

    expect(computeTrackOrderTarget(withPaceCar, 3, CARS, "ahead")?.carNumber).toBe("3");
  });

  it("skips competitors that are no longer in the sim world (towed / exited)", () => {
    // #3 (carIdx 1) has left the world: LapDistPct still reads a stale value but the
    // surface says NotInWorld — the walk must land on #99 instead.
    const towed = telemetryWith({ 7: 0.1, 3: 0.3, 1: 0.55, 5: 0.8 }, { 1: TrkLoc.NotInWorld });

    expect(computeTrackOrderTarget(towed, 3, CARS, "ahead")?.carNumber).toBe("99");
  });

  it("never re-targets the focused car when it is the only competitor on track", () => {
    const alone = telemetryWith({ 3: 0.3 });

    expect(computeTrackOrderTarget(alone, 3, CARS, "ahead")).toBeNull();
    expect(computeTrackOrderTarget(alone, 3, CARS, "behind")).toBeNull();
  });

  it("returns null without telemetry, without a focused car, or without competitors", () => {
    expect(computeTrackOrderTarget(null, 3, CARS, "ahead")).toBeNull();
    expect(computeTrackOrderTarget(telemetry, undefined, CARS, "ahead")).toBeNull();
    expect(computeTrackOrderTarget(telemetry, -1, CARS, "ahead")).toBeNull();
    expect(computeTrackOrderTarget(telemetry, 3, [], "ahead")).toBeNull();
  });

  it("re-enters the field at the car nearest start/finish when the focused car has no track position", () => {
    // The focused car (carIdx 9) is not in the world — the shared helper's
    // documented fallback picks the car closest to the start/finish line for
    // BOTH directions, so preview and execution agree on the same re-entry car.
    const nearest = computeTrackOrderTarget(telemetry, 9, CARS, "ahead");

    expect(nearest?.carNumber).toBe("12"); // #12 at 0.10 is closest to S/F
    expect(computeTrackOrderTarget(telemetry, 9, CARS, "behind")).toEqual(nearest);
  });
});

/**
 * Regression: car cycling must work while no car has completed a lap (issue
 * #968).
 *
 * `CarIdxLapCompleted` counts COMPLETED laps, so it reads `-1` for every active
 * car until the first start/finish crossing — the finding behind issue #307
 * (commit `02e977af`), which removed the same lap-count filter from
 * `findNearestCarOnTrack`. The presence predicate these walks take must
 * therefore judge presence by lap DISTANCE and track SURFACE only; a lap-count
 * condition silently marks the entire formation lap as "no cars present" and
 * every cycle dispatches nothing. The predicate's own unit tests live beside it
 * in `iracing-sdk`'s `track-utils.test.ts`.
 *
 * The fixture is the real capture behind the #307 regression test (snapshot
 * `20260417-081043`): four cars on track during the formation lap, all at
 * `laps = -1`.
 */
describe("car cycling on the formation lap (#968)", () => {
  /** The four on-track cars of snapshot `20260417-081043`, mid formation lap. */
  const PACE_LAP_CARS = [
    { idx: 1, dist: 0.8173747 },
    { idx: 11, dist: 0.8009607 },
    { idx: 14, dist: 0.8019581 },
    { idx: 17, dist: 0.8063871 },
  ] as const;

  /** Formation-lap telemetry: valid distances, on track, but nobody has completed a lap. */
  const paceLap = telemetryWith(Object.fromEntries(PACE_LAP_CARS.map((c) => [c.idx, c.dist]))) as unknown as Record<
    string,
    number[]
  >;
  // The whole point of the fixture: every car is on track with zero laps completed.
  paceLap.CarIdxLapCompleted = new Array<number>(paceLap.CarIdxLapDistPct.length).fill(-1);
  const telemetry = paceLap as unknown as TelemetryData;

  /** The competitor list the camera cycles walk, ordered by ascending car number. */
  const cars = [
    { carIdx: 1, carNumber: "1", carNumberRaw: 1 },
    { carIdx: 11, carNumber: "11", carNumberRaw: 11 },
    { carIdx: 14, carNumber: "14", carNumberRaw: 14 },
    { carIdx: 17, carNumber: "17", carNumberRaw: 17 },
  ];

  it("steps car-number cycling to the neighbouring car (was dead: no car judged present)", () => {
    const isPresent = carInWorld(telemetry);

    // Focused #14; ascending car-number order is 1 → 11 → 14 → 17.
    expect(computeCarNumberTarget(14, cars, "next", isPresent)?.carNumber).toBe("17");
    expect(computeCarNumberTarget(14, cars, "previous", isPresent)?.carNumber).toBe("11");
  });

  it("steps track-order cycling too — it already worked, and must keep working", () => {
    // On the road: #11 (0.8010) → #14 (0.8020) → #17 (0.8064) → #1 (0.8174).
    expect(computeTrackOrderTarget(telemetry, 14, cars, "ahead")?.carNumber).toBe("17");
    expect(computeTrackOrderTarget(telemetry, 14, cars, "behind")?.carNumber).toBe("11");
  });

  it("still skips a car that left the world, even mid formation lap (#885)", () => {
    const towed = telemetryWith(Object.fromEntries(PACE_LAP_CARS.map((c) => [c.idx, c.dist])), {
      17: TrkLoc.NotInWorld,
    });
    // Same formation-lap marker as the fixture above — the skip must survive it,
    // not be waved through because the lap-count array happens to be absent.
    (towed as unknown as Record<string, number[]>).CarIdxLapCompleted = new Array<number>(
      (towed as unknown as Record<string, number[]>).CarIdxLapDistPct.length,
    ).fill(-1);

    expect(computeCarNumberTarget(14, cars, "next", carInWorld(towed))?.carNumber).toBe("1");
    expect(computeTrackOrderTarget(towed, 14, cars, "ahead")?.carNumber).toBe("1");
  });
});
