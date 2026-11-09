import { beforeEach, describe, expect, it } from "vitest";

import {
  CORNER_LEAD_MAX_PCT,
  CORNER_TELEPORT_THRESHOLD,
  leadPointPct,
  type LeadPointSweep,
  resetLeadPointSweep,
  sweepLeadPoint,
} from "./lead-point-sweep.js";

/** A sweep with no pass under way. */
function freshSweep(): LeadPointSweep {
  return { leadPrevPct: null, spoken: new Set(), spokenBeforeBackingOver: null };
}

/**
 * Step the lead point forward from its previous point to `to` in ticks of
 * 1/64 lap (under the teleport threshold), wrapping at the line, and return
 * the start indices announced on the way.
 */
function driveForward(sweep: LeadPointSweep, to: number, starts: readonly number[]): number[] {
  const step = 1 / 64;
  const from = sweep.leadPrevPct!;
  const ticks = Math.ceil(((to - from + 1) % 1) / step);
  const announced: number[] = [];
  let point = from;

  for (let k = 1; k <= ticks; k++) {
    point = k === ticks ? to : (point + step) % 1;

    const idx = sweepLeadPoint(sweep, point, starts);

    if (idx !== -1) announced.push(idx);
  }

  return announced;
}

describe("leadPointPct", () => {
  it("adds the distance covered in the lead time, as a lap fraction", () => {
    // 50 m/s × 1 s on a 5000 m track = 0.01 of a lap.
    expect(leadPointPct(0.3, 50, 1, 5000)).toBeCloseTo(0.31, 12);
    // Twice the speed or twice the lead, twice the offset.
    expect(leadPointPct(0.3, 100, 1, 5000)).toBeCloseTo(0.32, 12);
    expect(leadPointPct(0.3, 50, 2, 5000)).toBeCloseTo(0.32, 12);
  });

  it("caps the offset at CORNER_LEAD_MAX_PCT", () => {
    // 100 m/s × 5 s on a 1000 m track = 0.5 of a lap raw, capped to 0.2.
    expect(CORNER_LEAD_MAX_PCT).toBe(0.2);
    expect(leadPointPct(0.1, 100, 5, 1000)).toBeCloseTo(0.3, 12);
  });

  it("folds a lead point past the line back into [0, 1)", () => {
    expect(leadPointPct(0.995, 50, 1, 5000)).toBeCloseTo(0.005, 12);
  });

  it.each([0, -10, Number.NaN, undefined])("gives no lead at a speed of %s", (speed) => {
    expect(leadPointPct(0.3, speed, 1, 5000)).toBe(0.3);
  });

  it("gives no lead with a lead time of 0", () => {
    expect(leadPointPct(0.3, 50, 0, 5000)).toBe(0.3);
  });
});

describe("sweepLeadPoint", () => {
  // Binary fractions, so every interval edge below is exact.
  const STARTS = [0.25, 0.5, 0.75];
  let sweep: LeadPointSweep;

  beforeEach(() => {
    sweep = freshSweep();
  });

  it("seeds silently on the first point, even one past a start", () => {
    expect(sweepLeadPoint(sweep, 0.5, STARTS)).toBe(-1);
    expect(sweep.leadPrevPct).toBe(0.5);
    expect(sweep.spoken.size).toBe(0);
  });

  it("returns a start inside the forward interval swept this tick, once per lap", () => {
    sweepLeadPoint(sweep, 0.234375, STARTS);

    expect(sweepLeadPoint(sweep, 0.265625, STARTS)).toBe(0);
    expect(sweep.spoken).toEqual(new Set([0]));
    // The next tick's interval no longer holds it.
    expect(sweepLeadPoint(sweep, 0.28125, STARTS)).toBe(-1);
  });

  it("returns nothing when the interval holds no start", () => {
    sweepLeadPoint(sweep, 0.3, STARTS);

    expect(sweepLeadPoint(sweep, 0.32, STARTS)).toBe(-1);
  });

  it("fires a start exactly at the lead point, and not one exactly at the previous point", () => {
    sweepLeadPoint(sweep, 0.46875, STARTS);

    expect(sweepLeadPoint(sweep, 0.5, STARTS)).toBe(1);
    // 0.5 is now the previous point: the interval (0.5, 0.53125] excludes it.
    sweep.spoken.clear();

    expect(sweepLeadPoint(sweep, 0.53125, STARTS)).toBe(-1);
  });

  it("consumes every start in the interval and returns only the nearest to the lead point", () => {
    const dense = [0.25, 0.2578125, 0.265625];

    sweepLeadPoint(sweep, 0.234375, dense);

    expect(sweepLeadPoint(sweep, 0.2734375, dense)).toBe(2);
    expect(sweep.spoken).toEqual(new Set([0, 1, 2]));
  });

  it("skips a start already spoken this lap", () => {
    sweepLeadPoint(sweep, 0.234375, STARTS);
    sweep.spoken.add(0);

    expect(sweepLeadPoint(sweep, 0.265625, STARTS)).toBe(-1);
  });

  it("clears the spoken set when the lead point wraps the line, so the next lap announces again", () => {
    sweepLeadPoint(sweep, 0.234375, STARTS);
    sweepLeadPoint(sweep, 0.265625, STARTS);
    sweep.spoken.add(1).add(2);

    // Across the line: 0.984375 → 0.015625.
    sweep.leadPrevPct = 0.984375;

    expect(sweepLeadPoint(sweep, 0.015625, STARTS)).toBe(-1);
    expect(sweep.spoken.size).toBe(0);

    sweepLeadPoint(sweep, 0.234375, STARTS);

    expect(sweepLeadPoint(sweep, 0.265625, STARTS)).toBe(0);
  });

  it("returns a start just past the line inside a wrapping interval", () => {
    const starts = [0, 0.5];

    sweepLeadPoint(sweep, 0.984375, starts);

    expect(sweepLeadPoint(sweep, 0.015625, starts)).toBe(0);
  });

  it("never fires while reversing", () => {
    sweepLeadPoint(sweep, 0.265625, STARTS);

    expect(sweepLeadPoint(sweep, 0.234375, STARTS)).toBe(-1);
    // Back over the same start, forward again from below it, is still a crossing.
    expect(sweepLeadPoint(sweep, 0.2421875, STARTS)).toBe(-1);
    expect(sweepLeadPoint(sweep, 0.2578125, STARTS)).toBe(0);
  });

  it("re-anchors silently on a jump over the teleport threshold, and clears the spoken set", () => {
    sweepLeadPoint(sweep, 0.234375, STARTS);
    sweepLeadPoint(sweep, 0.265625, STARTS);

    // A forward jump over the threshold, across the 0.5 start: silent.
    const jumped = 0.265625 + CORNER_TELEPORT_THRESHOLD + 0.25;

    expect(sweepLeadPoint(sweep, jumped, STARTS)).toBe(-1);
    expect(sweep.leadPrevPct).toBe(jumped);
    expect(sweep.spoken.size).toBe(0);
  });

  it("treats a jump just under the threshold as motion, not a teleport", () => {
    sweepLeadPoint(sweep, 0.46875, STARTS);

    // 0.46875 + 0.046875 (3/64, under 0.05) crosses 0.5.
    expect(sweepLeadPoint(sweep, 0.515625, STARTS)).toBe(1);
  });

  it("returns nothing for an empty start list", () => {
    sweepLeadPoint(sweep, 0.234375, []);

    expect(sweepLeadPoint(sweep, 0.265625, [])).toBe(-1);
  });
});

describe("sweepLeadPoint when the lead point backs over the line", () => {
  // Under hard braking the speed-scaled lead shrinks faster than the car
  // advances, so the lead point can slide back over the line it has just
  // crossed. A start just past the line (a first corner, or sector 1 at 0)
  // and one mid-lap, as binary fractions so every interval edge is exact.
  const PAST_LINE = 0.0078125;
  const STARTS = [PAST_LINE, 0.5];
  let sweep: LeadPointSweep;

  beforeEach(() => {
    sweep = freshSweep();
  });

  /** Cross the line forward, announcing the start just past it. */
  function crossTheLine(starts: readonly number[] = STARTS): void {
    sweepLeadPoint(sweep, 0.9921875, starts);

    expect(sweepLeadPoint(sweep, 0.01171875, starts)).toBe(0);
  }

  it("does not announce the lap's first start again when the lead point re-crosses a line it slid back over", () => {
    crossTheLine();

    // Braking: back over the line, 0.01171875 → 0.99609375.
    expect(sweepLeadPoint(sweep, 0.99609375, STARTS)).toBe(-1);
    expect(sweep.spokenBeforeBackingOver).toEqual(new Set([0]));

    // Forward over the line and past the start again: the same lap.
    expect(sweepLeadPoint(sweep, 0.015625, STARTS)).toBe(-1);
    expect(sweep.spoken).toEqual(new Set([0]));
    expect(sweep.spokenBeforeBackingOver).toBeNull();

    // And again: back over, forward over.
    expect(sweepLeadPoint(sweep, 0.998046875, STARTS)).toBe(-1);
    expect(sweepLeadPoint(sweep, 0.01953125, STARTS)).toBe(-1);
  });

  it("announces the start again on the genuine next lap, forward all the way round", () => {
    crossTheLine();
    sweepLeadPoint(sweep, 0.99609375, STARTS);
    sweepLeadPoint(sweep, 0.015625, STARTS);

    // Round the lap: the mid-lap start, then the line and the start past it.
    expect(driveForward(sweep, 0.984375, STARTS)).toEqual([1]);
    expect(driveForward(sweep, 0.015625, STARTS)).toEqual([0]);
  });

  it("leaves the next wrap clearing as before after backward moves that do not cross the line", () => {
    crossTheLine();

    expect(driveForward(sweep, 0.5625, STARTS)).toEqual([1]);
    // Braking mid-lap, and again just short of the line.
    expect(sweepLeadPoint(sweep, 0.546875, STARTS)).toBe(-1);
    expect(driveForward(sweep, 0.984375, STARTS)).toEqual([]);
    expect(sweepLeadPoint(sweep, 0.9765625, STARTS)).toBe(-1);
    expect(sweep.spokenBeforeBackingOver).toBeNull();

    // The next lap's line announces its first start again.
    expect(driveForward(sweep, 0.015625, STARTS)).toEqual([0]);
  });

  it("announces a start behind the line crossed while backed over, and again at the end of the lap", () => {
    const BEHIND_LINE = 0.98828125;
    const starts = [PAST_LINE, BEHIND_LINE];

    crossTheLine(starts);
    // Back over the line and behind that start…
    sweepLeadPoint(sweep, 0.99609375, starts);
    sweepLeadPoint(sweep, 0.984375, starts);

    // …then forward across it (a forward crossing, as re-crossing a start
    // after reversing over it always was) and across the line, where the
    // lap's first start stays silent.
    expect(sweepLeadPoint(sweep, 0.9921875, starts)).toBe(1);
    expect(sweepLeadPoint(sweep, 0.015625, starts)).toBe(-1);

    // What was consumed behind the line belongs to the lap's end, where it is
    // announced again; then the next lap's line.
    expect(driveForward(sweep, 0.9921875, starts)).toEqual([1]);
    expect(driveForward(sweep, 0.015625, starts)).toEqual([0]);
  });

  it.each([
    ["a backward jump over the threshold drops what it kept: the next wrap is a new lap", 0.9375, [0]],
    ["a reverse within the threshold keeps it: the next wrap is the same lap", 0.953125, []],
  ])("after backing over the line, %s", (_label, back, announcedAtLine) => {
    crossTheLine();
    sweepLeadPoint(sweep, 0.99609375, STARTS);

    expect(sweepLeadPoint(sweep, back, STARTS)).toBe(-1);
    expect(driveForward(sweep, 0.015625, STARTS)).toEqual(announcedAtLine);
  });

  it("drops what it kept on a teleport re-anchor, so the fresh pass announces the line's start", () => {
    crossTheLine();
    sweepLeadPoint(sweep, 0.99609375, STARTS);

    // A tow forward to 0.25: over the threshold, a fresh pass.
    expect(sweepLeadPoint(sweep, 0.25, STARTS)).toBe(-1);
    expect(sweep.spokenBeforeBackingOver).toBeNull();

    expect(driveForward(sweep, 0.984375, STARTS)).toEqual([1]);
    expect(driveForward(sweep, 0.015625, STARTS)).toEqual([0]);
  });

  it("keeps nothing for a backward jump over the threshold across the line, which stays a new lap at the next wrap", () => {
    crossTheLine();
    driveForward(sweep, 0.03125, STARTS);

    // 0.03125 → 0.96875: backward 0.0625, over the threshold.
    expect(sweepLeadPoint(sweep, 0.96875, STARTS)).toBe(-1);
    expect(sweep.spokenBeforeBackingOver).toBeNull();

    expect(driveForward(sweep, 0.015625, STARTS)).toEqual([0]);
  });
});

describe("resetLeadPointSweep", () => {
  it("clears the previous point, the spoken set and what a back-over kept, so the next point seeds silently", () => {
    const sweep: LeadPointSweep = {
      leadPrevPct: 0.234375,
      spoken: new Set([2]),
      spokenBeforeBackingOver: new Set([2]),
    };

    resetLeadPointSweep(sweep);

    expect(sweep).toEqual(freshSweep());
    expect(sweepLeadPoint(sweep, 0.265625, [0.25])).toBe(-1);
  });
});
