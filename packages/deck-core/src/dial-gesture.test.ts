import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyDialRelease,
  createHoldPreview,
  DIAL_LONG_PRESS_THRESHOLD_MS,
  resolvePairedAction,
} from "./dial-gesture.js";

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

describe("createHoldPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(overrides: { onThreshold?: () => boolean; thresholdMs?: () => number } = {}) {
    const onThreshold = vi.fn<() => boolean>(overrides.onThreshold ?? (() => true));
    const onCancel = vi.fn<() => void>();
    const preview = createHoldPreview({ onThreshold, onCancel, thresholdMs: overrides.thresholdMs });

    return { preview, onThreshold, onCancel };
  }

  it("draws the preview once the hold reaches the threshold, and not before", () => {
    const { preview, onThreshold } = setup();

    preview.down();
    vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS - 1);
    expect(onThreshold).not.toHaveBeenCalled();
    expect(preview.showing).toBe(false);

    vi.advanceTimersByTime(1);
    expect(onThreshold).toHaveBeenCalledTimes(1);
    expect(preview.showing).toBe(true);
  });

  it("draws nothing and reverts nothing when the release beats the threshold", () => {
    const { preview, onThreshold, onCancel } = setup();

    preview.down();
    vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS - 1);
    preview.up();
    vi.advanceTimersByTime(10_000);

    expect(onThreshold).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("reverts on release once the preview is showing", () => {
    const { preview, onCancel } = setup();

    preview.down();
    vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS);
    preview.up();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(preview.showing).toBe(false);
  });

  it("reverts when a rotation while held cancels the press (push+turn)", () => {
    const { preview, onCancel } = setup();

    preview.down();
    vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS);
    preview.rotated();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(preview.showing).toBe(false);
  });

  it("disarms a push+turn that rotates before the threshold, so nothing is ever drawn", () => {
    const { preview, onThreshold, onCancel } = setup();

    preview.down();
    preview.rotated();
    vi.advanceTimersByTime(10_000);

    expect(onThreshold).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("does not revert twice when a release follows a push+turn cancel", () => {
    const { preview, onCancel } = setup();

    preview.down();
    vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS);
    preview.rotated();
    preview.up();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the surface has no outcome to show", () => {
    const { preview, onThreshold, onCancel } = setup({ onThreshold: () => false });

    preview.down();
    vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS);
    expect(onThreshold).toHaveBeenCalledTimes(1);
    expect(preview.showing).toBe(false);

    preview.up();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("clears a pending timer on dispose, and never reverts through it", () => {
    const { preview, onThreshold, onCancel } = setup();

    preview.down();
    preview.dispose();
    vi.advanceTimersByTime(10_000);

    expect(onThreshold).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("drops a showing preview on dispose without pushing a frame at a gone context", () => {
    const { preview, onCancel } = setup();

    preview.down();
    vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS);
    preview.dispose();

    expect(onCancel).not.toHaveBeenCalled();
    expect(preview.showing).toBe(false);

    // A later release must not resurrect the reverted-away preview.
    preview.up();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("reads the threshold once per press, so a change mid-hold is ignored", () => {
    let threshold = 800;
    const { preview, onThreshold } = setup({ thresholdMs: () => threshold });

    preview.down();
    threshold = 200;
    vi.advanceTimersByTime(200);
    expect(onThreshold).not.toHaveBeenCalled();

    vi.advanceTimersByTime(600);
    expect(onThreshold).toHaveBeenCalledTimes(1);
  });

  it("re-arms from scratch when a press starts without its release", () => {
    const { preview, onThreshold, onCancel } = setup();

    preview.down();
    vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS);
    expect(preview.showing).toBe(true);

    preview.down();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(preview.showing).toBe(false);

    vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS);
    expect(onThreshold).toHaveBeenCalledTimes(2);
  });
});

describe("createHoldPreview — a failed draw must not take the plugin down", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("contains a throwing onThreshold instead of letting it escape the timer", () => {
    const onCancel = vi.fn<() => void>();
    const preview = createHoldPreview({
      onThreshold: () => {
        throw new Error("telemetry read failed mid-hold");
      },
      onCancel,
    });

    preview.down();
    // An uncaught throw from a timer callback ends the plugin process, so the
    // advance itself is the assertion.
    expect(() => vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS)).not.toThrow();
    expect(preview.showing).toBe(false);
  });

  it("treats a failed draw as nothing shown, so the release reverts nothing", () => {
    const onCancel = vi.fn<() => void>();
    const preview = createHoldPreview({
      onThreshold: () => {
        throw new Error("nope");
      },
      onCancel,
    });

    preview.down();
    vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS);
    preview.up();

    expect(onCancel).not.toHaveBeenCalled();
  });

  it("recovers on the next press", () => {
    let fail = true;
    const onThreshold = vi.fn<() => boolean>(() => {
      if (fail) throw new Error("first hold fails");

      return true;
    });
    const preview = createHoldPreview({ onThreshold, onCancel: vi.fn() });

    preview.down();
    vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS);
    preview.up();

    fail = false;
    preview.down();
    vi.advanceTimersByTime(DIAL_LONG_PRESS_THRESHOLD_MS);

    expect(preview.showing).toBe(true);
  });
});
