import { describe, expect, it } from "vitest";

import { calculateRacePositions, classPositionFromOrder } from "./position-utils.js";
import type { TelemetryData } from "./types.js";

function makeTelemetry(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    CarIdxLapCompleted: [4, 5, 3],
    CarIdxLapDistPct: [0.5, 0.7, 0.3],
    ...overrides,
  } as TelemetryData;
}

describe("calculateRacePositions", () => {
  it("should rank cars by lapsCompleted + lapDistPct descending", () => {
    const result = calculateRacePositions(makeTelemetry());
    expect(result[0]).toBe(2);
    expect(result[1]).toBe(1);
    expect(result[2]).toBe(3);
  });

  it("should use lapDistPct as tiebreaker within same lap", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [5, 5, 5],
      CarIdxLapDistPct: [0.3, 0.9, 0.6],
    });
    const result = calculateRacePositions(telemetry);
    expect(result[0]).toBe(3);
    expect(result[1]).toBe(1);
    expect(result[2]).toBe(2);
  });

  it("should use lower carIdx as tiebreaker for identical scores", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [5, 5],
      CarIdxLapDistPct: [0.5, 0.5],
    });
    const result = calculateRacePositions(telemetry);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(2);
  });

  it("should assign 0 to inactive cars with lapCompleted < 0", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [4, -1, 3],
      CarIdxLapDistPct: [0.5, 0.7, 0.3],
    });
    const result = calculateRacePositions(telemetry);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(2);
  });

  it("should assign 0 to inactive cars with lapDistPct < 0", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [4, 5, 3],
      CarIdxLapDistPct: [0.5, -1, 0.3],
    });
    const result = calculateRacePositions(telemetry);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(2);
  });

  it("should handle grid scenario (all lap 0)", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [0, 0, 0],
      CarIdxLapDistPct: [0.8, 0.9, 0.7],
    });
    const result = calculateRacePositions(telemetry);
    expect(result[0]).toBe(2);
    expect(result[1]).toBe(1);
    expect(result[2]).toBe(3);
  });

  it("should return empty array for null telemetry", () => {
    expect(calculateRacePositions(null)).toEqual([]);
  });

  it("should return empty array when CarIdxLapCompleted is missing", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: undefined,
      CarIdxLapDistPct: [0.5],
    });
    expect(calculateRacePositions(telemetry)).toEqual([]);
  });

  it("should return empty array when CarIdxLapDistPct is missing", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [4],
      CarIdxLapDistPct: undefined,
    });
    expect(calculateRacePositions(telemetry)).toEqual([]);
  });

  it("should handle mixed active and inactive cars", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [-1, 5, 3, -1, 4],
      CarIdxLapDistPct: [0.5, 0.7, 0.3, -1, 0.6],
    });
    const result = calculateRacePositions(telemetry);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(1);
    expect(result[2]).toBe(3);
    expect(result[3]).toBe(0);
    expect(result[4]).toBe(2);
  });

  it("should handle lapDistPct slightly above 1.0", () => {
    const telemetry = makeTelemetry({
      CarIdxLapCompleted: [10, 10],
      CarIdxLapDistPct: [1.02, 0.98],
    });
    const result = calculateRacePositions(telemetry);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(2);
  });
});

describe("classPositionFromOrder", () => {
  it("should equal the overall position in a single-class field", () => {
    // positions = overall ranks; everyone in class 10.
    const positions = [2, 1, 3];
    const carIdxClass = [10, 10, 10];

    expect(classPositionFromOrder(positions, carIdxClass, 0)).toBe(2);
    expect(classPositionFromOrder(positions, carIdxClass, 1)).toBe(1);
    expect(classPositionFromOrder(positions, carIdxClass, 2)).toBe(3);
  });

  it("should count only same-class cars ranked ahead in a multi-class field", () => {
    // Overall order: car0 (cls10), car1 (cls20), car2 (cls10), car3 (cls20).
    const positions = [1, 2, 3, 4];
    const carIdxClass = [10, 20, 10, 20];

    // car2 is overall P3 but only car0 (class 10) is ahead in class → class P2.
    expect(classPositionFromOrder(positions, carIdxClass, 2)).toBe(2);
    // car0 leads class 10 → class P1.
    expect(classPositionFromOrder(positions, carIdxClass, 0)).toBe(1);
    // car3 is overall P4 but only car1 (class 20) is ahead in class → class P2.
    expect(classPositionFromOrder(positions, carIdxClass, 3)).toBe(2);
  });

  it("should ignore other-class cars ahead overall (class leader despite cars in front)", () => {
    // Two class-20 cars lead overall; the lone class-10 car is overall P3 but class P1.
    const positions = [1, 2, 3];
    const carIdxClass = [20, 20, 10];

    expect(classPositionFromOrder(positions, carIdxClass, 2)).toBe(1);
  });

  it("should ignore cars omitted from the order (rank 0)", () => {
    // car1 is omitted (rank 0, e.g. never seen / not in world).
    const positions = [1, 0, 2];
    const carIdxClass = [10, 10, 10];

    expect(classPositionFromOrder(positions, carIdxClass, 2)).toBe(2);
  });

  it("should return 0 when the player is omitted from the order", () => {
    const positions = [1, 0, 2];
    const carIdxClass = [10, 10, 10];

    expect(classPositionFromOrder(positions, carIdxClass, 1)).toBe(0);
  });

  it("should return 0 when CarIdxClass is unavailable", () => {
    expect(classPositionFromOrder([2, 1, 3], undefined, 0)).toBe(0);
  });

  it("should return 0 for a negative or out-of-range carIdx", () => {
    const positions = [1, 2];
    const carIdxClass = [10, 10];

    expect(classPositionFromOrder(positions, carIdxClass, -1)).toBe(0);
    expect(classPositionFromOrder(positions, carIdxClass, 5)).toBe(0);
  });

  it("should return 0 when the player's class id is missing", () => {
    const positions = [1, 2];
    const carIdxClass = [10]; // no class for carIdx 1

    expect(classPositionFromOrder(positions, carIdxClass, 1)).toBe(0);
  });
});
