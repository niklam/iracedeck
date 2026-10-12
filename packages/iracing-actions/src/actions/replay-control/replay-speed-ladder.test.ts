import { describe, expect, it } from "vitest";

import type { ReplaySpeed } from "./replay-control-dial-mode.js";
import { parseSpeedStops, SPEED_STOP_TOKENS } from "./replay-control-dial-settings.js";
import { formatSpeedDisplay } from "./replay-speed-format.js";
import { buildLadder, canStep, isSameSpeed, speedValue, stopFromToken, walkLadder } from "./replay-speed-ladder.js";

/** A ladder as the text the dial shows, so a failure reads as speeds. */
function shown(ladder: readonly ReplaySpeed[]): string[] {
  return ladder.map((stop) => formatSpeedDisplay(stop.speed, stop.slowMotion));
}

function speed(value: number, slowMotion = false): ReplaySpeed {
  return { speed: value, slowMotion };
}

const PAUSED = speed(0);

/** The ladder a fresh dial walks: −8x … −¼x, 0x, ¼x … 8x. */
const DEFAULT_LADDER = buildLadder(parseSpeedStops(undefined));

describe("speedValue", () => {
  it.each<[string, ReplaySpeed, number]>([
    ["paused", speed(0), 0],
    ["8x", speed(8), 8],
    ["-2x", speed(-2), -2],
    ["1/4x", speed(4, true), 0.25],
    ["-1/4x", speed(-4, true), -0.25],
    ["paused with the slow-motion flag left on", speed(0, true), 0],
  ])("should read %s as one signed number", (_name, s, expected) => {
    expect(speedValue(s)).toBe(expected);
  });

  it("should order every speed iRacing plays the way the ladder runs", () => {
    const forward = SPEED_STOP_TOKENS.map((token) => speedValue(stopFromToken(token)));

    expect(forward).toEqual([...forward].sort((a, b) => a - b));
    expect(new Set(forward).size).toBe(31);
  });
});

describe("isSameSpeed", () => {
  it("should tell 1/16x from the 1/17x iRacing itself can sit at", () => {
    expect(isSameSpeed(speed(16, true), speed(17, true))).toBe(false);
    expect(isSameSpeed(speed(16, true), speed(16, true))).toBe(true);
  });

  it("should compare by speed, not by shape", () => {
    expect(isSameSpeed(speed(0, true), speed(0, false))).toBe(true);
    expect(isSameSpeed(speed(2, true), speed(2, false))).toBe(false);
    expect(isSameSpeed(speed(4), speed(-4))).toBe(false);
  });
});

describe("stopFromToken", () => {
  it("should read a token in the keypad's own speed format", () => {
    expect(stopFromToken("s4")).toEqual({ speed: 4, slowMotion: true });
    expect(stopFromToken("s16")).toEqual({ speed: 16, slowMotion: true });
    expect(stopFromToken("1")).toEqual({ speed: 1, slowMotion: false });
    expect(stopFromToken("16")).toEqual({ speed: 16, slowMotion: false });
  });
});

describe("buildLadder", () => {
  it("should build the default ladder, mirrored around 0x in signed order", () => {
    expect(shown(DEFAULT_LADDER)).toEqual([
      "-8x",
      "-4x",
      "-2x",
      "-1x",
      "-1/2x",
      "-1/4x",
      "PAUSED",
      "1/4x",
      "1/2x",
      "1x",
      "2x",
      "4x",
      "8x",
    ]);
  });

  it("should write a reverse slow-motion stop in the shape setPlaySpeed takes", () => {
    expect(DEFAULT_LADDER[5]).toEqual({ speed: -4, slowMotion: true });
    expect(DEFAULT_LADDER[6]).toEqual({ speed: 0, slowMotion: false });
    expect(DEFAULT_LADDER[12]).toEqual({ speed: 8, slowMotion: false });
  });

  it("should ascend strictly by speed value", () => {
    const values = buildLadder(
      parseSpeedStops(Object.fromEntries(SPEED_STOP_TOKENS.map((token) => [token, true]))),
    ).map(speedValue);

    expect(values).toHaveLength(63);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(63);
  });

  it("should read a token absent from the stored map as its default", () => {
    expect(shown(buildLadder(parseSpeedStops({ "16": true, "8": false, s4: false })))).toEqual([
      "-16x",
      "-4x",
      "-2x",
      "-1x",
      "-1/2x",
      "PAUSED",
      "1/2x",
      "1x",
      "2x",
      "4x",
      "16x",
    ]);
  });

  it("should ignore unknown tokens", () => {
    expect(shown(buildLadder(parseSpeedStops({ "32": true, s1: true, fast: true })))).toEqual(shown(DEFAULT_LADDER));
  });

  it("should build the default ladder when nothing is ticked", () => {
    const none = Object.fromEntries(SPEED_STOP_TOKENS.map((token) => [token, false]));

    expect(shown(buildLadder(parseSpeedStops(none)))).toEqual(shown(DEFAULT_LADDER));
  });

  it("should keep 0x on a ladder of one magnitude", () => {
    const only1x = Object.fromEntries(SPEED_STOP_TOKENS.map((token) => [token, token === "1"]));

    expect(shown(buildLadder(parseSpeedStops(only1x)))).toEqual(["-1x", "PAUSED", "1x"]);
  });
});

describe("walkLadder", () => {
  it.each<[string, ReplaySpeed, number, ReplaySpeed]>([
    ["1x clockwise", speed(1), 1, speed(2)],
    ["1x counter-clockwise", speed(1), -1, speed(2, true)],
    ["-8x clockwise is slower in reverse", speed(-8), 1, speed(-4)],
    ["-1x counter-clockwise is faster in reverse", speed(-1), -1, speed(-2)],
    ["1/4x clockwise", speed(4, true), 1, speed(2, true)],
    ["-1/2x clockwise", speed(-2, true), 1, speed(-4, true)],
  ])("should move one stop per detent: %s", (_name, live, ticks, expected) => {
    expect(walkLadder(DEFAULT_LADDER, live, ticks)).toEqual(expected);
  });

  it("should treat 0x as a stop in both directions", () => {
    expect(walkLadder(DEFAULT_LADDER, PAUSED, 1)).toEqual(speed(4, true));
    expect(walkLadder(DEFAULT_LADDER, PAUSED, -1)).toEqual(speed(-4, true));
    expect(walkLadder(DEFAULT_LADDER, speed(4, true), -1)).toEqual(PAUSED);
    expect(walkLadder(DEFAULT_LADDER, speed(-4, true), 1)).toEqual(PAUSED);
  });

  it("should walk through 0x on a multi-stop turn", () => {
    expect(walkLadder(DEFAULT_LADDER, speed(2, true), -3)).toEqual(speed(-4, true));
    expect(walkLadder(DEFAULT_LADDER, speed(-1), 5)).toEqual(speed(2, true));
  });

  it("should walk |ticks| stops with no per-event cap", () => {
    expect(walkLadder(DEFAULT_LADDER, speed(-8), 3)).toEqual(speed(-1));
    expect(walkLadder(DEFAULT_LADDER, speed(-8), 9)).toEqual(speed(1));
    expect(walkLadder(DEFAULT_LADDER, speed(8), -12)).toEqual(speed(-8));
  });

  it("should clamp a spin longer than the ladder at the end, without wrapping", () => {
    expect(walkLadder(DEFAULT_LADDER, speed(1), 40)).toEqual(speed(8));
    expect(walkLadder(DEFAULT_LADDER, speed(1), -40)).toEqual(speed(-8));
    expect(walkLadder(DEFAULT_LADDER, speed(-8), 100)).toEqual(speed(8));
  });

  it("should send nothing at either end", () => {
    expect(walkLadder(DEFAULT_LADDER, speed(8), 1)).toBeNull();
    expect(walkLadder(DEFAULT_LADDER, speed(8), 7)).toBeNull();
    expect(walkLadder(DEFAULT_LADDER, speed(-8), -1)).toBeNull();
    expect(walkLadder(DEFAULT_LADDER, speed(-8), -7)).toBeNull();
  });

  it("should send nothing for a zero-tick turn", () => {
    expect(walkLadder(DEFAULT_LADDER, speed(1), 0)).toBeNull();
  });

  it.each<[string, ReplaySpeed, number, ReplaySpeed]>([
    ["3x clockwise", speed(3), 1, speed(4)],
    ["3x counter-clockwise", speed(3), -1, speed(2)],
    ["-3x clockwise", speed(-3), 1, speed(-2)],
    ["-3x counter-clockwise", speed(-3), -1, speed(-4)],
    ["1/3x clockwise", speed(3, true), 1, speed(2, true)],
    ["1/3x counter-clockwise", speed(3, true), -1, speed(4, true)],
    ["1/17x counter-clockwise", speed(17, true), -1, PAUSED],
    ["1/17x clockwise", speed(17, true), 1, speed(4, true)],
  ])("should go to the nearest stop strictly beyond an off-ladder speed: %s", (_name, live, ticks, expected) => {
    expect(walkLadder(DEFAULT_LADDER, live, ticks)).toEqual(expected);
  });

  it("should walk on from that first stop for the rest of the turn", () => {
    expect(walkLadder(DEFAULT_LADDER, speed(3), 2)).toEqual(speed(8));
    expect(walkLadder(DEFAULT_LADDER, speed(3), -3)).toEqual(speed(2, true));
    expect(walkLadder(DEFAULT_LADDER, speed(3), 9)).toEqual(speed(8));
  });

  it("should come back onto the ladder from beyond its end, and send nothing further out", () => {
    expect(walkLadder(DEFAULT_LADDER, speed(16), -1)).toEqual(speed(8));
    expect(walkLadder(DEFAULT_LADDER, speed(16), -2)).toEqual(speed(4));
    expect(walkLadder(DEFAULT_LADDER, speed(16), 1)).toBeNull();
    expect(walkLadder(DEFAULT_LADDER, speed(-16), 1)).toEqual(speed(-8));
    expect(walkLadder(DEFAULT_LADDER, speed(-16), -3)).toBeNull();
  });
});

describe("canStep", () => {
  it("should say yes both ways in the middle of the ladder", () => {
    expect(canStep(DEFAULT_LADDER, PAUSED, 1)).toBe(true);
    expect(canStep(DEFAULT_LADDER, PAUSED, -1)).toBe(true);
  });

  it("should say no outwards at a ladder end", () => {
    expect(canStep(DEFAULT_LADDER, speed(8), 1)).toBe(false);
    expect(canStep(DEFAULT_LADDER, speed(8), -1)).toBe(true);
    expect(canStep(DEFAULT_LADDER, speed(-8), -1)).toBe(false);
    expect(canStep(DEFAULT_LADDER, speed(-8), 1)).toBe(true);
  });

  it("should agree with the walk for every speed iRacing plays", () => {
    const speeds = [PAUSED, ...SPEED_STOP_TOKENS.map(stopFromToken)].flatMap((s) => [
      s,
      { speed: -s.speed, slowMotion: s.slowMotion },
    ]);

    for (const live of speeds) {
      expect(canStep(DEFAULT_LADDER, live, 1)).toBe(walkLadder(DEFAULT_LADDER, live, 1) !== null);
      expect(canStep(DEFAULT_LADDER, live, -1)).toBe(walkLadder(DEFAULT_LADDER, live, -1) !== null);
    }
  });
});
