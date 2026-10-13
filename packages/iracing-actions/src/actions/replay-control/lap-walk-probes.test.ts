import { describe, expect, it } from "vitest";

import { halvingProbeFrames } from "./lap-walk-probes.js";

/** The distance the cursor travels to visit `frames` in order, starting from `from`. */
function travel(from: number, frames: number[]): number {
  let at = from;
  let total = 0;

  for (const frame of frames) {
    total += Math.abs(frame - at);
    at = frame;
  }

  return total;
}

/** The first `count` frames of the order, without walking the rest of a long interval. */
function firstProbes(lo: number, hi: number, count: number): number[] {
  const frames: number[] = [];

  for (const frame of halvingProbeFrames(lo, hi)) {
    if (frames.length === count) break;

    frames.push(frame);
  }

  return frames;
}

describe("halvingProbeFrames (#1354)", () => {
  it("offers the midpoint a plain bisection would probe first", () => {
    const [first] = halvingProbeFrames(37_869, 204_563);

    expect(first).toBe(Math.floor((37_869 + 204_563) / 2));
  });

  it("leads toward the start, then walks each round of halving from its nearer end", () => {
    const frames = firstProbes(0, 800, 31);

    expect(frames).toEqual([
      // The midpoint, then the first quarter, eighth, sixteenth and thirty-second.
      400,
      200,
      100,
      50,
      25,
      // What is left of the quarter points...
      600,
      // ...of the eighths, from the end nearer 600...
      700,
      500,
      300,
      // ...of the sixteenths, from the end nearer 300...
      150,
      250,
      350,
      450,
      550,
      650,
      750,
      // ...and of the thirty-seconds, from the end nearer 750.
      775,
      725,
      675,
      625,
      575,
      525,
      475,
      425,
      375,
      325,
      275,
      225,
      175,
      125,
      75,
    ]);
  });

  it.each([
    ["a six-hour race", 1_296_000],
    ["a 24-hour race", 5_184_000],
  ])("finds a car that left in the first twenty-fourth of %s within one length of travel", (_name, hi) => {
    // A pole sitter who retired a quarter of an hour into six hours, an hour into 24.
    const onTrack = (frame: number): boolean => frame < hi / 24;
    const frames = firstProbes(0, hi, 31);
    const found = frames.findIndex(onTrack);

    expect(found).toBe(4);
    expect(travel(0, frames.slice(0, found + 1))).toBeLessThan(hi);
  });

  it("finds a car that only joined for the last sixth of a six-hour session in under two lengths", () => {
    const hi = 1_296_000;
    const frames = firstProbes(0, hi, 31);
    const found = frames.findIndex((frame) => frame > (hi * 5) / 6);

    expect(found).toBe(6);
    expect(travel(0, frames.slice(0, found + 1))).toBeLessThan(2 * hi);
  });

  it("covers five rounds of halving in under four and a quarter lengths of the interval", () => {
    const hi = 1_296_000;
    const frames = firstProbes(0, hi, 31);

    // Left to right in every round it is six lengths.
    expect(travel(0, frames)).toBeLessThan(4.25 * hi);
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
