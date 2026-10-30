import type { IDeckActionContext, PressShape } from "@iracedeck/deck-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyDialReleaseForHost, dialPressShape, pressShapeByEvent, touchPressShape } from "./dial-release.js";

describe("classifyDialReleaseForHost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("extended gestures on (Stream Deck+)", () => {
    it("classifies a quick release as short", () => {
      expect(
        classifyDialReleaseForHost({ pressStartMs: 1000, nowMs: 1100, rotatedWhilePressed: false, thresholdMs: 500 }),
      ).toBe("short");
    });

    it("classifies a release past the threshold as long", () => {
      expect(
        classifyDialReleaseForHost({ pressStartMs: 1000, nowMs: 1500, rotatedWhilePressed: false, thresholdMs: 500 }),
      ).toBe("long");
    });

    it("classifies a release after a pressed rotation as push-turn", () => {
      expect(
        classifyDialReleaseForHost({ pressStartMs: 1000, nowMs: 3000, rotatedWhilePressed: true, thresholdMs: 500 }),
      ).toBe("push-turn");
    });
  });

  describe("extended gestures off (Mirabox / Ulanzi)", () => {
    it("classifies a quick release as short", () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);

      expect(
        classifyDialReleaseForHost({ pressStartMs: 1000, nowMs: 1100, rotatedWhilePressed: false, thresholdMs: 500 }),
      ).toBe("short");
    });

    it("never classifies a release as long, however long the hold", () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);

      expect(
        classifyDialReleaseForHost({ pressStartMs: 1000, nowMs: 9000, rotatedWhilePressed: false, thresholdMs: 500 }),
      ).toBe("short");
    });

    it("still classifies a release after a pressed rotation as push-turn, so it fires nothing", () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);

      expect(
        classifyDialReleaseForHost({ pressStartMs: 1000, nowMs: 1100, rotatedWhilePressed: true, thresholdMs: 500 }),
      ).toBe("push-turn");
    });
  });
});

describe("dialPressShape (#269)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a release at the threshold, short and long both set, when both gestures act", () => {
    expect(dialPressShape({ pressGesture: "toggle", longPressGesture: "reset", thresholdMs: 650 })).toEqual({
      kind: "release",
      thresholdMs: 650,
      short: true,
      long: true,
    });
  });

  it("clears short for a press gesture set to none", () => {
    expect(dialPressShape({ pressGesture: "none", longPressGesture: "reset", thresholdMs: 500 })).toEqual({
      kind: "release",
      thresholdMs: 500,
      short: false,
      long: true,
    });
  });

  it("clears long for a long-press gesture set to none", () => {
    expect(dialPressShape({ pressGesture: "toggle", longPressGesture: "none", thresholdMs: 500 })).toEqual({
      kind: "release",
      thresholdMs: 500,
      short: true,
      long: false,
    });
  });

  it("reads a gesture a surface resolved to null as firing nothing", () => {
    expect(dialPressShape({ pressGesture: null, longPressGesture: null, thresholdMs: 500 })).toEqual({
      kind: "release",
      thresholdMs: 500,
      short: false,
      long: false,
    });
  });

  it("with the extended gestures off, is never long and arms at an infinite threshold", () => {
    vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);

    expect(dialPressShape({ pressGesture: "toggle", longPressGesture: "reset", thresholdMs: 500 })).toEqual({
      kind: "release",
      thresholdMs: Number.POSITIVE_INFINITY,
      short: true,
      long: false,
    });
  });

  it("with the extended gestures off, still clears short for a press gesture set to none", () => {
    vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);

    expect(dialPressShape({ pressGesture: "none", longPressGesture: "reset", thresholdMs: 500 })).toMatchObject({
      short: false,
      long: false,
    });
  });
});

describe("touchPressShape (#269)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a tap for a tap whose gesture acts", () => {
    expect(touchPressShape({ tapGesture: "toggle", longTouchGesture: "none", hold: false })).toEqual({ kind: "tap" });
  });

  it("is a completed long press for a long touch whose gesture acts", () => {
    expect(touchPressShape({ tapGesture: "none", longTouchGesture: "reset", hold: true })).toEqual({ kind: "long" });
  });

  it("is none for a tap set to none, even when the long touch acts", () => {
    expect(touchPressShape({ tapGesture: "none", longTouchGesture: "reset", hold: false })).toEqual({ kind: "none" });
  });

  it("is none for a long touch set to none, even when the tap acts", () => {
    expect(touchPressShape({ tapGesture: "toggle", longTouchGesture: "none", hold: true })).toEqual({ kind: "none" });
  });

  it("is none for a slot a surface resolved to null", () => {
    expect(touchPressShape({ tapGesture: null, longTouchGesture: null, hold: false })).toEqual({ kind: "none" });
  });

  it("is none with the extended gestures off, where no touch fires", () => {
    vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);

    expect(touchPressShape({ tapGesture: "toggle", longTouchGesture: "reset", hold: false })).toEqual({ kind: "none" });
  });
});

describe("pressShapeByEvent (#269)", () => {
  const shapes = {
    key: (): PressShape => ({ kind: "tap" }),
    dial: (): PressShape => ({ kind: "release", thresholdMs: 500, short: true, long: false }),
    touch: (hold: boolean): PressShape => (hold ? { kind: "long" } : { kind: "none" }),
  };
  const context = (dial: boolean) =>
    ({ id: "ctx", isDial: () => dial, isKey: () => !dial }) as unknown as IDeckActionContext;

  it("routes a key context's down to the key shape", () => {
    expect(pressShapeByEvent({ action: context(false), payload: { settings: {} } }, shapes)).toEqual({ kind: "tap" });
  });

  it("routes a dial context's down to the dial shape", () => {
    expect(pressShapeByEvent({ action: context(true), payload: { settings: {} } }, shapes)).toMatchObject({
      kind: "release",
    });
  });

  it("routes a touch to the touch shape with its hold flag", () => {
    expect(
      pressShapeByEvent({ action: context(true), payload: { settings: {}, tapPos: [0, 0], hold: true } }, shapes),
    ).toEqual({ kind: "long" });
    expect(
      pressShapeByEvent({ action: context(true), payload: { settings: {}, tapPos: [0, 0], hold: false } }, shapes),
    ).toEqual({ kind: "none" });
  });
});
