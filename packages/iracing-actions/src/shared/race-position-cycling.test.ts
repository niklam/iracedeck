import { describe, expect, it } from "vitest";

import {
  carNumberRawAtPosition,
  computeRacePositionTarget,
  resolveRaceOrder,
  wrapPosition,
} from "./race-position-cycling.js";

// Moved with the helpers from the Camera Controls dial surface (#1448), unchanged.
describe("wrapPosition", () => {
  it("wraps forward and backward within the field", () => {
    expect(wrapPosition(2, 1, 3)).toBe(3);
    expect(wrapPosition(3, 1, 3)).toBe(1); // wrap forward at the end
    expect(wrapPosition(1, -1, 3)).toBe(3); // wrap backward at the start
  });
});

describe("computeRacePositionTarget", () => {
  // carIdx→position: idx1=P3, idx2=P1, idx3=P2.
  const order = [0, 3, 1, 2];

  it("steps the focused car to the next / previous position", () => {
    expect(computeRacePositionTarget(3, order, "next")?.targetPosition).toBe(3);
    expect(computeRacePositionTarget(3, order, "previous")?.targetPosition).toBe(1);
  });

  it("wraps at the ends of the field", () => {
    expect(computeRacePositionTarget(2, order, "previous")?.targetPosition).toBe(3); // P1 prev → P3
    expect(computeRacePositionTarget(1, order, "next")?.targetPosition).toBe(1); // P3 next → P1
  });

  it("returns null with no order (or an out-of-range focused car)", () => {
    expect(computeRacePositionTarget(3, null, "next")).toBeNull();
    expect(computeRacePositionTarget(undefined, order, "next")).toBeNull();
    expect(computeRacePositionTarget(-1, order, "next")).toBeNull();
  });

  it("recovers into the running order when the focused car is unclassified (pace/safety car)", () => {
    // order[0] === 0 (unclassified — pace car / safety car / car not in the
    // order). A detent must still act: next → the leader (P1), previous →
    // last place (maxPosition). No currentPosition, so no position badge.
    expect(computeRacePositionTarget(0, order, "next")).toEqual({
      currentPosition: null,
      targetPosition: 1,
      maxPosition: 3,
    });
    expect(computeRacePositionTarget(0, order, "previous")).toEqual({
      currentPosition: null,
      targetPosition: 3,
      maxPosition: 3,
    });
  });

  it("steps past a position no car holds — a gap in the ranks — and nothing else", () => {
    // carIdx1=P4, carIdx2=P1, carIdx3=P2 (focused): nobody holds P3. Every
    // RANKED car is a target whatever its world presence (#1281); only the
    // empty rank is stepped over, wrapping as usual.
    const gapped = [0, 4, 1, 2];
    expect(computeRacePositionTarget(3, gapped, "next")).toEqual({
      currentPosition: 2,
      targetPosition: 4,
      maxPosition: 4,
    });
    expect(computeRacePositionTarget(1, gapped, "previous")).toEqual({
      currentPosition: 4,
      targetPosition: 2,
      maxPosition: 4,
    });
  });

  it("returns null when the focused car is the only ranked car", () => {
    expect(computeRacePositionTarget(3, [0, 0, 0, 1], "next")).toBeNull();
    expect(computeRacePositionTarget(3, [0, 0, 0, 1], "previous")).toBeNull();
  });

  it("recovery re-entry also steps past an empty rank", () => {
    // Focused pace car (unclassified); nobody holds P1, so next re-enters at
    // P2 rather than resolving a position with no car.
    expect(computeRacePositionTarget(0, [0, 3, 0, 2], "next")).toEqual({
      currentPosition: null,
      targetPosition: 2,
      maxPosition: 3,
    });
  });
});

describe("carNumberRawAtPosition", () => {
  const SESSION_INFO = {
    DriverInfo: {
      Drivers: [
        { CarIdx: 1, CarNumber: "3", CarNumberRaw: 3 },
        { CarIdx: 2, CarNumber: "042", CarNumberRaw: 3042 },
      ],
    },
  };

  it("is the raw number of the car the order ranks at the position, the camera API's identity", () => {
    expect(carNumberRawAtPosition([0, 2, 1], SESSION_INFO, 1)).toBe(3042);
    expect(carNumberRawAtPosition([0, 2, 1], SESSION_INFO, 2)).toBe(3);
  });

  it("is null for a position nobody holds, or a car with no number in the session info", () => {
    expect(carNumberRawAtPosition([0, 2, 1], SESSION_INFO, 3)).toBeNull();
    expect(carNumberRawAtPosition([1, 0, 0], SESSION_INFO, 1)).toBeNull();
  });
});

describe("resolveRaceOrder", () => {
  it("is the canonical order when it ranks anybody", () => {
    expect(resolveRaceOrder([0, 2, 1], [1, 2, 0])).toEqual([0, 2, 1]);
  });

  it("falls back to the official CarIdxPosition when the canonical order ranks nobody, or there is none (#968)", () => {
    expect(resolveRaceOrder([0, 0, 0], [1, 2, 0])).toEqual([1, 2, 0]);
    expect(resolveRaceOrder(null, [1, 2, 0])).toEqual([1, 2, 0]);
  });

  it("keeps an all-zero canonical order with no official one, and is null with neither", () => {
    expect(resolveRaceOrder([0, 0], undefined)).toEqual([0, 0]);
    expect(resolveRaceOrder(null, undefined)).toBeNull();
  });
});
