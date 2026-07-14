import { describe, expect, it } from "vitest";

import { calculateIRatingChanges, calculateSof, estimateIRatingChanges } from "./irating-utils.js";

/**
 * Reference vectors from Turbo87/irating-rs (src/snapshots/irating__tests__it_works.snap):
 * [finishRank, startIRating, started, expectedChange]. Driver 14 is the one non-starter.
 * The reference computes in f32; we compute in f64, so changes are compared with ±0.05 tolerance.
 */
const REFERENCE_FIELD: [number, number, boolean, number][] = [
  [1, 7526, true, 17.63672],
  [2, 5982, true, 25.833923],
  [3, 5463, true, 25.432884],
  [4, 4279, true, 37.92791],
  [5, 4137, true, 33.394478],
  [6, 4044, true, 27.948332],
  [7, 3891, true, 23.814116],
  [8, 3612, true, 22.626814],
  [9, 3147, true, 26.485985],
  [10, 2823, true, 27.702335],
  [11, 2715, true, 23.36419],
  [12, 2603, true, 19.21653],
  [13, 2512, true, 14.53251],
  [14, 2352, false, 10.437519],
  [15, 2227, true, 8.5288105],
  [16, 2195, true, 2.2037997],
  [17, 2166, true, -4.2093577],
  [18, 2089, true, -9.06982],
  [19, 1773, true, -5.7882223],
  [20, 1772, true, -13.086736],
  [21, 1752, true, -19.722021],
  [22, 1748, true, -26.915356],
  [23, 1705, true, -32.73568],
  [24, 1662, true, -38.54108],
  [25, 1622, true, -44.439545],
  [26, 1537, true, -48.679874],
  [27, 1464, true, -53.308353],
  [28, 1203, true, -50.590836],
];

describe("calculateIRatingChanges", () => {
  it("matches the reference implementation's 28-driver vectors", () => {
    const changes = calculateIRatingChanges(
      REFERENCE_FIELD.map(([finishRank, startIRating, started]) => ({ finishRank, startIRating, started })),
    );

    expect(changes).toHaveLength(REFERENCE_FIELD.length);

    for (const [i, [, , , expected]] of REFERENCE_FIELD.entries()) {
      expect(Math.abs(changes[i] - expected)).toBeLessThan(0.05);
    }
  });

  it("returns an empty array for an empty field", () => {
    expect(calculateIRatingChanges([])).toEqual([]);
  });

  it("gains for the winner and loses for the loser in an equal-rating pair", () => {
    const changes = calculateIRatingChanges([
      { finishRank: 1, startIRating: 2000, started: true },
      { finishRank: 2, startIRating: 2000, started: true },
    ]);

    expect(changes[0]).toBeGreaterThan(0);
    expect(changes[1]).toBeLessThan(0);
  });
});

function makeFieldDriver(carIdx: number, irating: number, overrides: Record<string, number> = {}) {
  return { CarIdx: carIdx, IRating: irating, CarIsPaceCar: 0, IsSpectator: 0, ...overrides };
}

describe("estimateIRatingChanges", () => {
  it("maps class-field changes back by carIdx (single class)", () => {
    // carIdx 0 leads, carIdx 2 second, carIdx 1 third.
    const drivers = [makeFieldDriver(0, 3000), makeFieldDriver(1, 2000), makeFieldDriver(2, 2500)];
    const order = [1, 3, 2];

    const result = estimateIRatingChanges({ drivers, order });

    const expected = calculateIRatingChanges([
      { finishRank: 1, startIRating: 3000, started: true },
      { finishRank: 2, startIRating: 2500, started: true },
      { finishRank: 3, startIRating: 2000, started: true },
    ]);

    expect(result.changes[0]).toBeCloseTo(expected[0], 10);
    expect(result.changes[2]).toBeCloseTo(expected[1], 10);
    expect(result.changes[1]).toBeCloseTo(expected[2], 10);

    const sof = calculateSof([3000, 2500, 2000]);

    expect(result.sofs[0]).toBeCloseTo(sof, 10);
    expect(result.sofs[1]).toBeCloseTo(sof, 10);
  });

  it("groups by class and uses class-relative ranks", () => {
    // Class 100: carIdx 0 (overall 1) and carIdx 2 (overall 3) → class ranks 1, 2.
    // Class 200: carIdx 1 (overall 2) and carIdx 3 (overall 4) → class ranks 1, 2.
    const drivers = [
      makeFieldDriver(0, 3000),
      makeFieldDriver(1, 2100),
      makeFieldDriver(2, 2900),
      makeFieldDriver(3, 2000),
    ];
    const order = [1, 2, 3, 4];
    const carIdxClass = [100, 200, 100, 200];

    const result = estimateIRatingChanges({ drivers, order, carIdxClass });

    const class100 = calculateIRatingChanges([
      { finishRank: 1, startIRating: 3000, started: true },
      { finishRank: 2, startIRating: 2900, started: true },
    ]);
    const class200 = calculateIRatingChanges([
      { finishRank: 1, startIRating: 2100, started: true },
      { finishRank: 2, startIRating: 2000, started: true },
    ]);

    expect(result.changes[0]).toBeCloseTo(class100[0], 10);
    expect(result.changes[2]).toBeCloseTo(class100[1], 10);
    expect(result.changes[1]).toBeCloseTo(class200[0], 10);
    expect(result.changes[3]).toBeCloseTo(class200[1], 10);

    expect(result.sofs[0]).toBeCloseTo(calculateSof([3000, 2900]), 10);
    expect(result.sofs[1]).toBeCloseTo(calculateSof([2100, 2000]), 10);
  });

  it("excludes pace car, spectators, invalid iRatings, and unclassified cars", () => {
    const drivers = [
      makeFieldDriver(0, 3000),
      makeFieldDriver(1, 2500),
      makeFieldDriver(2, 2400, { CarIsPaceCar: 1 }),
      makeFieldDriver(3, 2300, { IsSpectator: 1 }),
      makeFieldDriver(4, 0), // invalid iRating
      makeFieldDriver(5, 2200), // rank 0 — not classified
    ];
    const order = [1, 2, 3, 4, 5, 0];

    const result = estimateIRatingChanges({ drivers, order });

    expect(result.changes[2]).toBeNull();
    expect(result.changes[3]).toBeNull();
    expect(result.changes[4]).toBeNull();
    expect(result.changes[5]).toBeNull();
    expect(result.sofs[2]).toBeNull();

    // The remaining 2-car field still computes.
    expect(result.changes[0]).not.toBeNull();
    expect(result.changes[1]).not.toBeNull();
  });

  it("returns null for class fields with fewer than 2 cars", () => {
    const drivers = [makeFieldDriver(0, 3000), makeFieldDriver(1, 2000)];
    const order = [1, 2];
    const carIdxClass = [100, 200]; // each alone in its class

    const result = estimateIRatingChanges({ drivers, order, carIdxClass });

    expect(result.changes[0]).toBeNull();
    expect(result.changes[1]).toBeNull();
    expect(result.sofs[0]).toBeNull();
  });

  it("returns all-null shells for an empty order", () => {
    const result = estimateIRatingChanges({ drivers: [makeFieldDriver(0, 3000)], order: [] });

    expect(result.changes.every((c) => c === null)).toBe(true);
  });

  it("memoizes: equal inputs return the same object, changed order recomputes", () => {
    const drivers = [makeFieldDriver(0, 3000), makeFieldDriver(1, 2000)];

    const a = estimateIRatingChanges({ drivers, order: [1, 2] });
    const b = estimateIRatingChanges({ drivers: drivers.map((d) => ({ ...d })), order: [1, 2] });
    const c = estimateIRatingChanges({ drivers, order: [2, 1] });

    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});

describe("calculateSof", () => {
  it("equals the rating for a uniform field", () => {
    expect(calculateSof([2000, 2000, 2000])).toBeCloseTo(2000, 6);
  });

  it("sits between min and max, below the arithmetic mean (log-mean weights lower ratings)", () => {
    const sof = calculateSof([1000, 2000]);

    expect(sof).toBeGreaterThan(1000);
    expect(sof).toBeLessThan(1500);
  });

  it("increases when a driver is replaced by a stronger one", () => {
    expect(calculateSof([1000, 3000])).toBeGreaterThan(calculateSof([1000, 2000]));
  });

  it("returns 0 for an empty field", () => {
    expect(calculateSof([])).toBe(0);
  });
});
