import { carInWorld, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { computeCarNumberTarget } from "./car-cycling.js";

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
  });
});
