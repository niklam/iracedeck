import { describe, expect, it } from "vitest";

import { halvingProbeFrames } from "./lap-walk-probes.js";

describe("halvingProbeFrames (#1354)", () => {
  it("offers the midpoint a plain bisection would probe first", () => {
    const [first] = halvingProbeFrames(37_869, 204_563);

    expect(first).toBe(Math.floor((37_869 + 204_563) / 2));
  });

  it("goes on to the quarter points, then the eighths", () => {
    const frames = [...halvingProbeFrames(0, 800)].slice(0, 7);

    expect(frames).toEqual([400, 200, 600, 100, 300, 500, 700]);
  });

  it("offers every frame strictly between the bounds exactly once", () => {
    for (const [lo, hi] of [
      [0, 2],
      [10, 17],
      [100, 164],
      [5, 105],
    ]) {
      const frames = [...halvingProbeFrames(lo, hi)];
      const inside = Array.from({ length: hi - lo - 1 }, (_, i) => lo + 1 + i);

      expect([...frames].sort((a, b) => a - b)).toEqual(inside);
      expect(new Set(frames).size).toBe(frames.length);
    }
  });

  it("offers nothing when no frame lies between the bounds", () => {
    expect([...halvingProbeFrames(10, 11)]).toEqual([]);
    expect([...halvingProbeFrames(10, 10)]).toEqual([]);
    expect([...halvingProbeFrames(11, 10)]).toEqual([]);
  });
});
