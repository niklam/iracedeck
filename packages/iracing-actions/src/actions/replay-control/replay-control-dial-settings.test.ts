import { describe, expect, it } from "vitest";

import {
  parseSpeedStops,
  REPLAY_DIAL_MODES,
  ReplayControlDialSettings,
  SPEED_STOP_TOKENS,
} from "./replay-control-dial-settings.js";

/** The tokens a parsed map has ticked, in grid order. */
function ticked(stops: Record<string, boolean>): string[] {
  return SPEED_STOP_TOKENS.filter((token) => stops[token]);
}

const DEFAULT_TICKED = ["s4", "s2", "1", "2", "4", "8"];

describe("parseSpeedStops", () => {
  it("should offer all 31 magnitudes, slowest first", () => {
    expect(SPEED_STOP_TOKENS).toHaveLength(31);
    expect(SPEED_STOP_TOKENS[0]).toBe("s16");
    expect(SPEED_STOP_TOKENS[14]).toBe("s2");
    expect(SPEED_STOP_TOKENS[15]).toBe("1");
    expect(SPEED_STOP_TOKENS[30]).toBe("16");
  });

  it("should read a missing map as the default set", () => {
    expect(ticked(parseSpeedStops(undefined))).toEqual(DEFAULT_TICKED);
    expect(Object.keys(parseSpeedStops(undefined))).toHaveLength(31);
  });

  it("should read a token absent from the map as its default", () => {
    expect(ticked(parseSpeedStops({ "16": true }))).toEqual([...DEFAULT_TICKED, "16"]);
    expect(ticked(parseSpeedStops({ "8": false }))).toEqual(["s4", "s2", "1", "2", "4"]);
  });

  it("should ignore unknown tokens and non-boolean values", () => {
    expect(ticked(parseSpeedStops({ "32": true, s1: true, "0": true, "3": "true", "8": 0 }))).toEqual(DEFAULT_TICKED);
  });

  it("should read a map that ticks nothing as the default set", () => {
    const none = Object.fromEntries(SPEED_STOP_TOKENS.map((token) => [token, false]));

    expect(ticked(parseSpeedStops(none))).toEqual(DEFAULT_TICKED);
  });

  it.each<[unknown]>([["s4"], [["1", "2"]], [7], [null], [true]])(
    "should read the non-map %j as the default set",
    (raw) => {
      expect(ticked(parseSpeedStops(raw))).toEqual(DEFAULT_TICKED);
    },
  );
});

describe("ReplayControlDialSettings", () => {
  it("should parse a missing dial to the full defaults", () => {
    const dial = ReplayControlDialSettings.parse(undefined);

    expect(dial.mode).toBe("speed");
    expect(dial.pressAction).toBe("play-pause");
    expect(dial.longPressAction).toBe("set-1x-play");
    expect(dial.tapAction).toBe("none");
    expect(dial.longTouchAction).toBe("none");
    expect(ticked(dial.speedStops)).toEqual(DEFAULT_TICKED);
    expect(dial.colors).toEqual({ borderColor: "", labelColor: "", valueColor: "", backgroundColor: "" });
  });

  it("should keep the other fields when one holds a value it does not know", () => {
    const dial = ReplayControlDialSettings.parse({
      mode: "a-newer-mode",
      pressAction: "a-newer-gesture",
      longPressAction: "reverse",
      tapAction: "jump-to-live",
      speedStops: { "16": true },
    });

    expect(dial.mode).toBe("speed");
    expect(dial.pressAction).toBe("play-pause");
    expect(dial.longPressAction).toBe("reverse");
    expect(dial.tapAction).toBe("jump-to-live");
    expect(dial.speedStops["16"]).toBe(true);
  });

  it("should offer Speed Control and Frame Jog, in that order", () => {
    expect(REPLAY_DIAL_MODES).toEqual(["speed", "frame-jog"]);
  });

  it.each(REPLAY_DIAL_MODES)("should keep a stored %s mode", (mode) => {
    expect(ReplayControlDialSettings.parse({ mode }).mode).toBe(mode);
  });

  it("should keep the gesture slots and the speed ladder when the mode is Frame Jog", () => {
    const dial = ReplayControlDialSettings.parse({
      mode: "frame-jog",
      pressAction: "reverse",
      speedStops: { "16": true },
    });

    expect(dial.mode).toBe("frame-jog");
    expect(dial.pressAction).toBe("reverse");
    expect(dial.speedStops["16"]).toBe(true);
  });
});
