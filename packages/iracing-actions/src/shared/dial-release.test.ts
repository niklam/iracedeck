import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyDialReleaseForHost, dialGestureShape, touchGestureShape } from "./dial-release.js";

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

describe("dialGestureShape (#269)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a release at the threshold, short and long both set, when both gestures act", () => {
    expect(dialGestureShape({ pressGesture: "toggle", longPressGesture: "reset", thresholdMs: 650 })).toEqual({
      kind: "release",
      thresholdMs: 650,
      short: true,
      long: true,
    });
  });

  it("clears short for a press gesture set to none", () => {
    expect(dialGestureShape({ pressGesture: "none", longPressGesture: "reset", thresholdMs: 500 })).toEqual({
      kind: "release",
      thresholdMs: 500,
      short: false,
      long: true,
    });
  });

  it("clears long for a long-press gesture set to none", () => {
    expect(dialGestureShape({ pressGesture: "toggle", longPressGesture: "none", thresholdMs: 500 })).toEqual({
      kind: "release",
      thresholdMs: 500,
      short: true,
      long: false,
    });
  });

  it("reads a gesture a surface resolved to null as firing nothing", () => {
    expect(dialGestureShape({ pressGesture: null, longPressGesture: null, thresholdMs: 500 })).toEqual({
      kind: "release",
      thresholdMs: 500,
      short: false,
      long: false,
    });
  });

  it("with the extended gestures off, is never long and arms at an infinite threshold", () => {
    vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);

    expect(dialGestureShape({ pressGesture: "toggle", longPressGesture: "reset", thresholdMs: 500 })).toEqual({
      kind: "release",
      thresholdMs: Number.POSITIVE_INFINITY,
      short: true,
      long: false,
    });
  });

  it("with the extended gestures off, still clears short for a press gesture set to none", () => {
    vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);

    expect(dialGestureShape({ pressGesture: "none", longPressGesture: "reset", thresholdMs: 500 })).toMatchObject({
      short: false,
      long: false,
    });
  });
});

describe("touchGestureShape (#269)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a tap for a tap whose gesture acts", () => {
    expect(touchGestureShape({ tapGesture: "toggle", longTouchGesture: "none", hold: false })).toEqual({ kind: "tap" });
  });

  it("is a completed long press for a long touch whose gesture acts", () => {
    expect(touchGestureShape({ tapGesture: "none", longTouchGesture: "reset", hold: true })).toEqual({ kind: "long" });
  });

  it("is none for a tap set to none, even when the long touch acts", () => {
    expect(touchGestureShape({ tapGesture: "none", longTouchGesture: "reset", hold: false })).toEqual({ kind: "none" });
  });

  it("is none for a long touch set to none, even when the tap acts", () => {
    expect(touchGestureShape({ tapGesture: "toggle", longTouchGesture: "none", hold: true })).toEqual({ kind: "none" });
  });

  it("is none for a slot a surface resolved to null", () => {
    expect(touchGestureShape({ tapGesture: null, longTouchGesture: null, hold: false })).toEqual({ kind: "none" });
  });

  it("is none with the extended gestures off, where no touch fires", () => {
    vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);

    expect(touchGestureShape({ tapGesture: "toggle", longTouchGesture: "reset", hold: false })).toEqual({
      kind: "none",
    });
  });
});
