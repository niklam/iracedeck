import { describe, expect, it } from "vitest";

import { calculateGridPositions, extractQualifyResults, type QualifyResult } from "./grid-utils.js";

describe("extractQualifyResults", () => {
  it("reads the top-level QualifyResultsInfo.Results array", () => {
    const results = extractQualifyResults({ QualifyResultsInfo: { Results: [{ CarIdx: 3, Position: 0 }] } });

    expect(results).toEqual([{ CarIdx: 3, Position: 0 }]);
  });

  it("returns undefined when the key is missing or not an array", () => {
    expect(extractQualifyResults(null)).toBeUndefined();
    expect(extractQualifyResults(undefined)).toBeUndefined();
    expect(extractQualifyResults({})).toBeUndefined();
    expect(extractQualifyResults({ QualifyResultsInfo: {} })).toBeUndefined();
    expect(extractQualifyResults({ QualifyResultsInfo: { Results: "nope" } })).toBeUndefined();
  });
});

describe("calculateGridPositions", () => {
  it("converts the 0-indexed grid Position to a 1-based rank per carIdx", () => {
    // Real shape from local/telemetry-snapshot-20260815-203305-955.json (trimmed):
    // pole is carIdx 0 at Position 0, then carIdx 13, then carIdx 15.
    const order = calculateGridPositions([
      { CarIdx: 0, Position: 0 },
      { CarIdx: 13, Position: 1 },
      { CarIdx: 15, Position: 2 },
    ]);

    expect(order?.[0]).toBe(1);
    expect(order?.[13]).toBe(2);
    expect(order?.[15]).toBe(3);
  });

  it("leaves cars with no grid entry unranked (0)", () => {
    const order = calculateGridPositions([
      { CarIdx: 0, Position: 0 },
      { CarIdx: 2, Position: 1 },
    ]);

    expect(order).toEqual([1, 0, 2]);
  });

  it("returns null when no entry is usable", () => {
    expect(calculateGridPositions([])).toBeNull();
    expect(calculateGridPositions([{ CarIdx: -1, Position: 0 }])).toBeNull();
  });

  it("skips malformed entries without throwing", () => {
    const order = calculateGridPositions([
      { CarIdx: 0, Position: 0 },
      { CarIdx: 1, Position: -1 }, // iRacing's no-result sentinel
      { CarIdx: -1, Position: 2 },
      { Position: 3 },
      { CarIdx: 2 },
      null, // empty YAML list item
      { CarIdx: 2.5, Position: 4 }, // fractional CarIdx must not size the array
      { CarIdx: 1e9, Position: 5 }, // absurd CarIdx must not allocate a giant array
      { CarIdx: 3, Position: Number.NaN },
      { CarIdx: 4, Position: 1.5 },
    ] as unknown as QualifyResult[]);

    expect(order).toEqual([1]);
  });

  it("rejects an absurd Position so no consumer walks a billion ranks", () => {
    // `Position` becomes the RANK, and consumers iterate rank 1..max (the camera
    // dial's computeRacePositionTarget) — an unbounded value would hang them, so
    // it is bounded exactly like CarIdx is.
    const order = calculateGridPositions([
      { CarIdx: 0, Position: 0 },
      { CarIdx: 1, Position: 1e9 },
      { CarIdx: 2, Position: 256 },
    ]);

    expect(order).toEqual([1]);
    expect(Math.max(...(order ?? []))).toBe(1);
  });

  it("keeps ranks unique when two cars claim the same grid slot", () => {
    // Duplicate ranks would break position-relative selection (race-positions.md),
    // so the first valid claimant keeps the slot and the later one is dropped.
    const order = calculateGridPositions([
      { CarIdx: 0, Position: 0 },
      { CarIdx: 1, Position: 0 },
      { CarIdx: 2, Position: 1 },
    ]);

    expect(order).toEqual([1, 0, 2]);
  });

  it("keeps one rank per car when a car appears twice", () => {
    const order = calculateGridPositions([
      { CarIdx: 0, Position: 0 },
      { CarIdx: 0, Position: 1 },
    ]);

    expect(order).toEqual([1]);
  });
});
