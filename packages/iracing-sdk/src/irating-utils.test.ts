import { describe, expect, it } from "vitest";

import { calculateIRatingChanges, calculateSof } from "./irating-utils.js";

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
