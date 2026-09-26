import { describe, expect, it } from "vitest";

import { DIAL_CANVAS_KEY, SD_PLUS_STRIP_CANVAS, STREAM_DOCK_KNOB_CANVAS } from "./dial-canvas.js";

describe("dial canvas profiles (#1013)", () => {
  it("describes the Stream Deck+ strip slot at 200×100", () => {
    expect(SD_PLUS_STRIP_CANVAS).toEqual({ id: "sd-plus-strip", width: 200, height: 100 });
  });

  it("describes the Stream Dock knob screen at 176×112", () => {
    expect(STREAM_DOCK_KNOB_CANVAS).toEqual({ id: "stream-dock-knob", width: 176, height: 112 });
  });

  it("is the `box` key every Elgato dial layout already uses", () => {
    expect(DIAL_CANVAS_KEY).toBe("box");
  });

  it("is frozen, so a renderer cannot mutate the hardware description", () => {
    expect(Object.isFrozen(SD_PLUS_STRIP_CANVAS)).toBe(true);
    expect(Object.isFrozen(STREAM_DOCK_KNOB_CANVAS)).toBe(true);
  });
});
