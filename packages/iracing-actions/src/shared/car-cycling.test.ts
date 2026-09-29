import { describe, expect, it } from "vitest";

import { computeCarNumberTarget } from "./car-cycling.js";

/**
 * The walk covers every listed car (issue #1281). The helper takes no
 * world-presence input at all, so neither a departed car (#885's filter, which
 * rested on the false premise that iRacing ignores a camera switch to one) nor
 * a whole formation lap of cars at `CarIdxLapCompleted = -1` (#968, the
 * lap-count term that once killed cycling for a lap) can be skipped by it.
 * The per-surface tests drive the same walk through real telemetry shapes: the
 * post-race snapshot, where every car reads not-in-world, and the formation
 * lap.
 */
describe("computeCarNumberTarget walks every listed car (#1281)", () => {
  /** A field by ascending car number, carIdx deliberately sparse as in a real session. */
  const cars = [
    { carIdx: 1, carNumber: "1", carNumberRaw: 1 },
    { carIdx: 11, carNumber: "11", carNumberRaw: 11 },
    { carIdx: 14, carNumber: "14", carNumberRaw: 14 },
    { carIdx: 17, carNumber: "17", carNumberRaw: 17 },
  ];

  /** Every car number the walk visits from `start`, stepping `direction` once per listed car. */
  function walk(start: number, direction: "next" | "previous"): string[] {
    const visited: string[] = [];
    let focused = start;

    for (let step = 0; step < cars.length; step++) {
      const target = computeCarNumberTarget(focused, cars, direction);

      if (!target) break;

      visited.push(target.carNumber);
      focused = cars.find((c) => c.carNumberRaw === target.carNumberRaw)?.carIdx ?? -1;
    }

    return visited;
  }

  it("reaches every car, wrapping, in both directions", () => {
    expect(walk(14, "next")).toEqual(["17", "1", "11", "14"]);
    expect(walk(14, "previous")).toEqual(["11", "1", "17", "14"]);
  });

  it("returns null when the focused car is the only one listed — never re-targets it", () => {
    expect(computeCarNumberTarget(14, [cars[2]], "next")).toBeNull();
    expect(computeCarNumberTarget(14, [cars[2]], "previous")).toBeNull();
  });

  it("targets a lone listed car when the focus is elsewhere (the pace car)", () => {
    expect(computeCarNumberTarget(0, [cars[2]], "next")?.carNumber).toBe("14");
    expect(computeCarNumberTarget(0, [cars[2]], "previous")?.carNumber).toBe("14");
  });
});
