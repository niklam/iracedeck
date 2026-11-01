/**
 * The shared pit-lap rule (issues #465, #1163): one latch definition the fuel
 * tracker and the lap diff both drive, so an out lap and an in lap mean the
 * same thing on `lap.completed` and in the fuel history.
 */
import { describe, expect, it } from "vitest";

import { closePitLap, createPitLapLatch, observePitLap, openPitLap, type PitLapLatch } from "./pit-lap.js";

/** Drive a latch through a sequence of per-tick `OnPitRoad` readings. */
function observe(latch: PitLapLatch, ...onPitRoad: boolean[]): PitLapLatch {
  for (const reading of onPitRoad) observePitLap(latch, reading);

  return latch;
}

describe("pit-lap latch", () => {
  it("starts as a lap opened off pit road", () => {
    expect(createPitLapLatch()).toEqual({ isOutLap: false, leftPitRoad: true, enteredPits: false });
    expect(closePitLap(createPitLapLatch())).toEqual({ isOutLap: false, isInLap: false });
  });

  it("a lap opened on pit road is an out lap, and not an in lap while the car drives out", () => {
    const latch = createPitLapLatch();
    openPitLap(latch, true);

    expect(closePitLap(observe(latch, true, true, true))).toEqual({ isOutLap: true, isInLap: false });
  });

  it("a lap opened on pit road that leaves and comes back is an out lap and an in lap", () => {
    const latch = createPitLapLatch();
    openPitLap(latch, true);

    expect(closePitLap(observe(latch, true, false, false, true))).toEqual({ isOutLap: true, isInLap: true });
  });

  it("a lap opened off pit road that enters pit road is an in lap, not an out lap", () => {
    const latch = createPitLapLatch();
    openPitLap(latch, false);

    expect(closePitLap(observe(latch, false, false, true, true))).toEqual({ isOutLap: false, isInLap: true });
  });

  it("a lap run wholly off pit road is neither (the positive control of the two above)", () => {
    const latch = createPitLapLatch();
    openPitLap(latch, false);

    expect(closePitLap(observe(latch, false, false, false))).toEqual({ isOutLap: false, isInLap: false });
  });

  it("opening the next lap clears the closed lap's facts and takes the opening tick's reading", () => {
    const latch = createPitLapLatch();
    openPitLap(latch, false);
    observe(latch, false, true);

    expect(closePitLap(latch)).toEqual({ isOutLap: false, isInLap: true });

    // The crossing tick on pit road closes an in lap and opens an out lap.
    openPitLap(latch, true);

    expect(closePitLap(latch)).toEqual({ isOutLap: true, isInLap: false });
    expect(latch.leftPitRoad).toBe(false);
  });

  it("an in lap entered once stays an in lap however the car moves afterwards", () => {
    const latch = createPitLapLatch();
    openPitLap(latch, false);

    expect(closePitLap(observe(latch, true, false, false))).toEqual({ isOutLap: false, isInLap: true });
  });
});
