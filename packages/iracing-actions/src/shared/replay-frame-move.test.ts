import { describe, expect, it } from "vitest";

import { frameBeside, JUMP_END_MARGIN_FRAMES, planFrameMove } from "./replay-frame-move.js";
import type { ReplayPosition } from "./replay-position-state.js";

/** A replay at rest on `frame` of a 10 000-frame recording, unless overridden. */
function at(frame: number, overrides: Partial<ReplayPosition> = {}): ReplayPosition {
  return { frame, time: frame / 60, endFrame: 10_000, seeking: false, ...overrides };
}

describe("planFrameMove", () => {
  it("steps one frame for a single detent on a replay at rest", () => {
    expect(planFrameMove(1, at(5000))).toEqual({ kind: "step", direction: 1 });
    expect(planFrameMove(-1, at(5000))).toEqual({ kind: "step", direction: -1 });
  });

  it("jumps to the absolute frame for several detents in one event", () => {
    expect(planFrameMove(2, at(5000))).toEqual({ kind: "jump", frame: 5002 });
    expect(planFrameMove(-4, at(5000))).toEqual({ kind: "jump", frame: 4996 });
    expect(planFrameMove(37, at(5000))).toEqual({ kind: "jump", frame: 5037 });
  });

  it("never steps while a move is under way: a single detent jumps from the pending target", () => {
    const heading = at(5010, { seeking: true });

    expect(planFrameMove(1, heading)).toEqual({ kind: "jump", frame: 5011 });
    expect(planFrameMove(-1, heading)).toEqual({ kind: "jump", frame: 5009 });
    expect(planFrameMove(3, heading)).toEqual({ kind: "jump", frame: 5013 });
  });

  it("sends nothing when the position is not known", () => {
    expect(planFrameMove(1, null).kind).toBe("none");
    expect(planFrameMove(-5, null).kind).toBe("none");
  });

  it("stops at the start of the recording", () => {
    expect(planFrameMove(-5, at(3))).toEqual({ kind: "jump", frame: 0 });
    expect(planFrameMove(-1, at(0)).kind).toBe("none");
    expect(planFrameMove(-4, at(0)).kind).toBe("none");
    expect(planFrameMove(1, at(0))).toEqual({ kind: "step", direction: 1 });
  });

  it("aims a jump no closer to the end of the recording than it can land", () => {
    expect(planFrameMove(2, at(9980))).toEqual({ kind: "jump", frame: 9982 });
    expect(planFrameMove(10, at(9982))).toEqual({ kind: "jump", frame: 9992 });
    expect(planFrameMove(40, at(9990))).toEqual({ kind: "jump", frame: 9992 });
    expect(planFrameMove(-10, at(9999))).toEqual({ kind: "jump", frame: 9989 });
  });

  it("goes on through the last frames one step at a time, up to the last frame but one", () => {
    expect(planFrameMove(1, at(9992))).toEqual({ kind: "step", direction: 1 });
    expect(planFrameMove(1, at(9998))).toEqual({ kind: "step", direction: 1 });
    expect(planFrameMove(1, at(9999)).kind).toBe("none");
    expect(planFrameMove(1, at(10_000)).kind).toBe("none");
    expect(planFrameMove(-1, at(10_000))).toEqual({ kind: "step", direction: -1 });
  });

  it("turns several detents in the last frames into one step, either way", () => {
    expect(planFrameMove(6, at(9992))).toEqual({ kind: "step", direction: 1 });
    expect(planFrameMove(4, at(9997))).toEqual({ kind: "step", direction: 1 });
    expect(planFrameMove(4, at(9999)).kind).toBe("none");
    expect(planFrameMove(-2, at(9999))).toEqual({ kind: "step", direction: -1 });
  });

  it("is bounded only by the start when the recording's end is not known", () => {
    expect(planFrameMove(500, at(9999, { endFrame: undefined }))).toEqual({ kind: "jump", frame: 10_499 });
    expect(planFrameMove(1, at(9999, { endFrame: undefined }))).toEqual({ kind: "step", direction: 1 });
  });

  it("asks again for a pending target, which is what puts a move that never read back right", () => {
    expect(planFrameMove(-3, at(0, { seeking: true }))).toEqual({ kind: "jump", frame: 0 });
    expect(planFrameMove(3, at(9992, { seeking: true }))).toEqual({ kind: "jump", frame: 9992 });
    expect(planFrameMove(30, at(9980, { seeking: true }))).toEqual({ kind: "jump", frame: 9992 });
  });

  it("sends nothing while a move into the last frames has not read back, and still jumps back out", () => {
    expect(planFrameMove(1, at(9995, { seeking: true })).kind).toBe("none");
    expect(planFrameMove(3, at(9993, { seeking: true })).kind).toBe("none");
    expect(planFrameMove(-1, at(9995, { seeking: true })).kind).toBe("none");
    expect(planFrameMove(-5, at(9995, { seeking: true }))).toEqual({ kind: "jump", frame: 9990 });
  });

  it("measures every jump from the position it was given, as an absolute frame", () => {
    for (const ticks of [1, -1, 2, -2, 3, -4, 12]) {
      for (const position of [at(5000), at(5000, { seeking: true })]) {
        const move = planFrameMove(ticks, position);

        expect(["step", "jump"]).toContain(move.kind);

        if (move.kind === "jump") expect(move.frame).toBe(5000 + ticks);
      }
    }
  });
});

describe("frameBeside (#1430)", () => {
  it("is one frame forward, where a frame that cannot be landed on resolves", () => {
    expect(frameBeside(5_000, 10_000)).toBe(5_001);
    expect(frameBeside(5_000, undefined)).toBe(5_001);
  });

  it("is one frame back inside the end-of-tape margin, where forward cannot move", () => {
    expect(frameBeside(10_000 - JUMP_END_MARGIN_FRAMES, 10_000)).toBe(10_000 - JUMP_END_MARGIN_FRAMES - 1);
    expect(frameBeside(9_999, 10_000)).toBe(9_998);
  });

  it("never goes below the first frame", () => {
    expect(frameBeside(0, 5)).toBe(0);
  });
});
