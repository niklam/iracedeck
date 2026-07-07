import { describe, expect, it } from "vitest";

import { classifyDialRelease, DIAL_LONG_PRESS_THRESHOLD_MS, resolvePairedAction } from "./dial-gesture.js";

describe("resolvePairedAction", () => {
  const pair = { cw: "increase", ccw: "decrease" };

  it("returns cw for a positive tick sign", () => {
    expect(resolvePairedAction(pair, 3)).toBe("increase");
  });

  it("returns ccw for a negative tick sign", () => {
    expect(resolvePairedAction(pair, -2)).toBe("decrease");
  });

  it("returns null for zero ticks", () => {
    expect(resolvePairedAction(pair, 0)).toBeNull();
  });

  it("returns null when no pair is configured", () => {
    expect(resolvePairedAction(null, 1)).toBeNull();
    expect(resolvePairedAction(undefined, -1)).toBeNull();
  });
});

describe("classifyDialRelease", () => {
  it("classifies a rotated-while-pressed release as push-turn (fires nothing)", () => {
    expect(classifyDialRelease({ pressStartMs: 0, nowMs: 9999, rotatedWhilePressed: true })).toBe("push-turn");
  });

  it("classifies a hold at/above the threshold as long", () => {
    expect(
      classifyDialRelease({ pressStartMs: 0, nowMs: DIAL_LONG_PRESS_THRESHOLD_MS, rotatedWhilePressed: false }),
    ).toBe("long");
  });

  it("classifies a quick release below the threshold as short", () => {
    expect(
      classifyDialRelease({ pressStartMs: 0, nowMs: DIAL_LONG_PRESS_THRESHOLD_MS - 1, rotatedWhilePressed: false }),
    ).toBe("short");
  });

  it("honors a custom threshold", () => {
    expect(classifyDialRelease({ pressStartMs: 0, nowMs: 200, rotatedWhilePressed: false, thresholdMs: 100 })).toBe(
      "long",
    );
  });

  it("push-turn takes precedence even past the long threshold", () => {
    expect(classifyDialRelease({ pressStartMs: 0, nowMs: 100_000, rotatedWhilePressed: true })).toBe("push-turn");
  });
});
