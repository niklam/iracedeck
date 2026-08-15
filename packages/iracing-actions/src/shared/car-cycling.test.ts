import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { computeTrackOrderTarget } from "./car-cycling.js";

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
  const size = 10;
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
