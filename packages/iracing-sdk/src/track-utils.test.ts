import { describe, expect, it } from "vitest";

import { findNearestCarOnTrack } from "./track-utils.js";

function makeTelemetry(refCarIdx: number, cars: Array<{ idx: number; laps: number; dist: number }>) {
  const maxIdx = Math.max(...cars.map((c) => c.idx), refCarIdx, 0);
  const lapCompleted = new Array(maxIdx + 1).fill(-1);
  const lapDistPct = new Array(maxIdx + 1).fill(-1);

  for (const car of cars) {
    lapCompleted[car.idx] = car.laps;
    lapDistPct[car.idx] = car.dist;
  }

  return {
    CarIdxLapCompleted: lapCompleted,
    CarIdxLapDistPct: lapDistPct,
  };
}

describe("findNearestCarOnTrack", () => {
  it("should find the physically closest car ahead", () => {
    const telemetry = makeTelemetry(2, [
      { idx: 1, laps: 5, dist: 0.8 },
      { idx: 2, laps: 5, dist: 0.5 },
      { idx: 3, laps: 5, dist: 0.2 },
    ]);

    expect(findNearestCarOnTrack(telemetry, 2, "ahead")).toBe(1);
  });

  it("should find the physically closest car behind", () => {
    const telemetry = makeTelemetry(2, [
      { idx: 1, laps: 5, dist: 0.8 },
      { idx: 2, laps: 5, dist: 0.5 },
      { idx: 3, laps: 5, dist: 0.2 },
    ]);

    expect(findNearestCarOnTrack(telemetry, 2, "behind")).toBe(3);
  });

  it("should wrap around at start/finish when looking ahead", () => {
    const telemetry = makeTelemetry(1, [
      { idx: 1, laps: 5, dist: 0.95 },
      { idx: 2, laps: 5, dist: 0.5 },
      { idx: 3, laps: 5, dist: 0.05 },
    ]);

    expect(findNearestCarOnTrack(telemetry, 1, "ahead")).toBe(3);
  });

  it("should wrap around at start/finish when looking behind", () => {
    const telemetry = makeTelemetry(3, [
      { idx: 1, laps: 5, dist: 0.95 },
      { idx: 2, laps: 5, dist: 0.5 },
      { idx: 3, laps: 5, dist: 0.05 },
    ]);

    expect(findNearestCarOnTrack(telemetry, 3, "behind")).toBe(1);
  });

  it("should use physical proximity regardless of lap count", () => {
    const telemetry = makeTelemetry(2, [
      { idx: 1, laps: 6, dist: 0.2 },
      { idx: 2, laps: 5, dist: 0.9 },
      { idx: 3, laps: 5, dist: 0.1 },
    ]);

    expect(findNearestCarOnTrack(telemetry, 2, "ahead")).toBe(3);
    expect(findNearestCarOnTrack(telemetry, 2, "behind")).toBe(1);
  });

  it("should skip inactive cars", () => {
    const telemetry = makeTelemetry(3, [
      { idx: 1, laps: 5, dist: 0.8 },
      { idx: 2, laps: -1, dist: 0.5 },
      { idx: 3, laps: 5, dist: 0.2 },
    ]);

    expect(findNearestCarOnTrack(telemetry, 3, "ahead")).toBe(1);
  });

  it("should apply skipIdx filter", () => {
    const telemetry = makeTelemetry(3, [
      { idx: 1, laps: 5, dist: 0.8 },
      { idx: 2, laps: 5, dist: 0.3 },
      { idx: 3, laps: 5, dist: 0.2 },
    ]);

    // Skip idx 2, so ahead should be idx 1 instead
    expect(findNearestCarOnTrack(telemetry, 3, "ahead", { skipIdx: (idx) => idx === 2 })).toBe(1);
  });

  it("should include cars flagged as on pit road", () => {
    const telemetry = makeTelemetry(3, [
      { idx: 1, laps: 5, dist: 0.8 },
      { idx: 2, laps: 5, dist: 0.3 },
      { idx: 3, laps: 5, dist: 0.2 },
    ]);

    (telemetry as Record<string, unknown>).CarIdxOnPitRoad = [false, false, true, false];
    expect(findNearestCarOnTrack(telemetry, 3, "ahead")).toBe(2);
  });

  it("should return null when telemetry is null", () => {
    expect(findNearestCarOnTrack(null, 0, "ahead")).toBeNull();
  });

  it("should return null when referenceCarIdx is negative", () => {
    const telemetry = makeTelemetry(0, [{ idx: 0, laps: 5, dist: 0.5 }]);

    expect(findNearestCarOnTrack(telemetry, -1, "ahead")).toBeNull();
  });

  it("should return null when no candidates exist", () => {
    const telemetry = makeTelemetry(1, [{ idx: 1, laps: 5, dist: 0.5 }]);

    expect(findNearestCarOnTrack(telemetry, 1, "ahead")).toBeNull();
    expect(findNearestCarOnTrack(telemetry, 1, "behind")).toBeNull();
  });

  it("should return the only candidate for both directions", () => {
    const telemetry = makeTelemetry(1, [
      { idx: 1, laps: 5, dist: 0.5 },
      { idx: 2, laps: 5, dist: 0.8 },
    ]);

    expect(findNearestCarOnTrack(telemetry, 1, "ahead")).toBe(2);
    expect(findNearestCarOnTrack(telemetry, 1, "behind")).toBe(2);
  });

  it("should navigate from inactive reference car using its track position", () => {
    const telemetry = makeTelemetry(5, [
      { idx: 1, laps: 5, dist: 0.8 },
      { idx: 2, laps: 5, dist: 0.5 },
      { idx: 5, laps: -1, dist: 0.6 },
    ]);

    expect(findNearestCarOnTrack(telemetry, 5, "ahead")).toBe(1);
    expect(findNearestCarOnTrack(telemetry, 5, "behind")).toBe(2);
  });

  it("should fall back to car closest to S/F when reference has no position", () => {
    const telemetry = makeTelemetry(5, [
      { idx: 1, laps: 5, dist: 0.1 },
      { idx: 2, laps: 5, dist: 0.5 },
      { idx: 3, laps: 5, dist: 0.95 },
    ]);

    expect(findNearestCarOnTrack(telemetry, 5, "ahead")).toBe(3);
    expect(findNearestCarOnTrack(telemetry, 5, "behind")).toBe(3);
  });

  it("should fall back when reference car has no lap data", () => {
    const telemetry = makeTelemetry(99, [
      { idx: 1, laps: 5, dist: 0.8 },
      { idx: 2, laps: 5, dist: 0.5 },
    ]);

    expect(findNearestCarOnTrack(telemetry, 99, "ahead")).toBe(1);
    expect(findNearestCarOnTrack(telemetry, 99, "behind")).toBe(1);
  });

  // Real telemetry data from telemetry-snapshot-20260328-211129.json
  const snapshot211129 = [
    { idx: 2, laps: 11, dist: 0.38954538106918335 },
    { idx: 3, laps: 12, dist: 0.5192081332206726 },
    { idx: 5, laps: 9, dist: 0.48601317405700684 },
    { idx: 6, laps: 12, dist: 0.43214255571365356 },
    { idx: 8, laps: 12, dist: 0.14112484455108643 },
    { idx: 9, laps: 12, dist: 0.5137969255447388 },
    { idx: 11, laps: 12, dist: 0.44958096742630005 },
    { idx: 12, laps: 12, dist: 0.2255899459123611 },
    { idx: 13, laps: 12, dist: 0.2612520456314087 },
    { idx: 14, laps: 12, dist: 0.36889901757240295 },
    { idx: 15, laps: 12, dist: 0.265424907207489 },
    { idx: 16, laps: 4, dist: 0.04441389814019203 },
    { idx: 17, laps: 12, dist: 0.26450181007385254 },
    { idx: 18, laps: 12, dist: 0.45216333866119385 },
    { idx: 19, laps: 12, dist: 0.3390771448612213 },
    { idx: 20, laps: 12, dist: 0.39654332399368286 },
    { idx: 22, laps: 12, dist: 0.25014644861221313 },
    { idx: 23, laps: 5, dist: 0.05720538645982742 },
    { idx: 24, laps: 12, dist: 0.5042067170143127 },
  ];

  it("should match real telemetry — camera on #15 Niklas", () => {
    const telemetry = makeTelemetry(15, snapshot211129);

    expect(findNearestCarOnTrack(telemetry, 15, "ahead")).toBe(19);
    expect(findNearestCarOnTrack(telemetry, 15, "behind")).toBe(17);
  });

  it("should match real telemetry — camera on #16 near start/finish", () => {
    const telemetry = makeTelemetry(16, snapshot211129);

    expect(findNearestCarOnTrack(telemetry, 16, "ahead")).toBe(23);
    expect(findNearestCarOnTrack(telemetry, 16, "behind")).toBe(3);
  });

  it("should match real telemetry — disconnected #10 falls back to closest to S/F", () => {
    const telemetry = makeTelemetry(10, [
      { idx: 3, laps: 2, dist: 0.9950405955314636 },
      { idx: 11, laps: 1, dist: 0.08401884138584137 },
      { idx: 12, laps: 0, dist: 0.9472545981407166 },
      { idx: 14, laps: 2, dist: 0.15486976504325867 },
      { idx: 16, laps: 1, dist: 0.08401890844106674 },
    ]);

    expect(findNearestCarOnTrack(telemetry, 10, "ahead")).toBe(3);
    expect(findNearestCarOnTrack(telemetry, 10, "behind")).toBe(3);
  });
});
