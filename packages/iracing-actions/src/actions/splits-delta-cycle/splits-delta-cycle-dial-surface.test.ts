import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTriggerDescription, DialSettings, GESTURE_ACTIONS } from "./splits-delta-cycle-dial-surface.js";
import { SplitsDeltaCycle } from "./splits-delta-cycle.js";

const { mockTapBinding, mockIsBindingMissing, mockDualPressThreshold, globalListeners } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockIsBindingMissing: vi.fn(() => false),
  mockDualPressThreshold: { value: 500 },
  globalListeners: [] as Array<() => void>,
}));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
    CommonSettings: {
      extend: (shape: never) => z.object(shape).passthrough(),
    },
    ConnectionStateAwareAction: class MockConnectionStateAwareAction {
      logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      sdkController = {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        getCurrentTelemetry: vi.fn(() => null),
        getSessionInfo: vi.fn(() => null),
      };
      setKeyImage = vi.fn().mockResolvedValue(undefined);
      setRegenerateCallback = vi.fn();
      updateKeyImage = vi.fn().mockResolvedValue(false);
      setActiveBinding = vi.fn();
      tapBinding = mockTapBinding;
      holdBinding = vi.fn().mockResolvedValue(undefined);
      releaseBinding = vi.fn().mockResolvedValue(undefined);
      isBindingMissing = mockIsBindingMissing;
      async onWillAppear() {}
      async onDidReceiveSettings() {}
      async onWillDisappear() {}
    },
    getDualPressThresholdMs: () => mockDualPressThreshold.value,
    onGlobalSettingsChange: vi.fn((listener: () => void) => {
      globalListeners.push(listener);

      return vi.fn();
    }),
    classifyDialRelease: (args: {
      pressStartMs: number;
      nowMs: number;
      rotatedWhilePressed: boolean;
      thresholdMs?: number;
    }) => {
      if (args.rotatedWhilePressed) return "push-turn";

      return args.nowMs - args.pressStartMs >= (args.thresholdMs ?? 500) ? "long" : "short";
    },
    applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
    escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
  };
});

function dialContext(id: string) {
  return {
    id,
    isKey: () => false,
    isDial: () => true,
    setImage: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
  };
}

type DialContext = ReturnType<typeof dialContext>;

function rotateEvent(action: DialContext, settings: Record<string, unknown>, ticks: number, pressed = false) {
  return { action, payload: { settings, ticks, pressed } };
}

function basicEvent(action: DialContext, settings: Record<string, unknown> = {}) {
  return { action, payload: { settings } };
}

function touchEvent(action: DialContext, settings: Record<string, unknown>, hold: boolean) {
  return { action, payload: { settings, hold } };
}

function dialSettings(dial: Record<string, unknown> = {}) {
  return { dial };
}

function lastFeedbackBox(ctx: DialContext): string {
  const call = ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string } | undefined;

  return decodeURIComponent(call?.box ?? "");
}

describe("splits-delta-cycle dial-surface pure helpers", () => {
  describe("GESTURE_ACTIONS", () => {
    it("offers every keypad mode beyond cycle plus none (#807 follow-up)", () => {
      expect(GESTURE_ACTIONS).toEqual([
        "toggle-ref-car",
        "custom-sector-start",
        "custom-sector-end",
        "active-reset-set",
        "active-reset-run",
        "none",
      ]);
    });
  });

  describe("buildTriggerDescription", () => {
    it("always cycles on rotate and defaults the press to Toggle Reference Car", () => {
      const desc = buildTriggerDescription(DialSettings.parse({}));

      expect(desc.rotate).toBe("Cycle splits / delta mode");
      expect(desc.push).toBe("Toggle Reference Car");
    });

    it("labels the gestures matching the keypad's wording", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ pressAction: "custom-sector-start", tapAction: "active-reset-run" }),
      );

      expect(desc.push).toBe("Custom Sector Start");
      expect(desc.touch).toBe("Reset to Start Point");
    });

    it("carries the long-press as a (hold: …) hint", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ pressAction: "toggle-ref-car", longPressAction: "toggle-ref-car" }),
      );

      expect(desc.push).toBe("Toggle Reference Car (hold: Toggle Reference Car)");
    });

    it("offers no push when both press slots are none", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ pressAction: "none", longPressAction: "none" }));

      expect(desc.push).toBeUndefined();
    });

    it("carries touch-strip gestures", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ tapAction: "toggle-ref-car", longTouchAction: "none" }),
      );

      expect(desc.touch).toBe("Toggle Reference Car");
      expect(desc.longTouch).toBeUndefined();
    });
  });

  describe("DialSettings defaults", () => {
    it("defaults press to toggle-ref-car and the rest to none", () => {
      const dial = DialSettings.parse({});

      expect(dial.pressAction).toBe("toggle-ref-car");
      expect(dial.longPressAction).toBe("none");
      expect(dial.tapAction).toBe("none");
      expect(dial.longTouchAction).toBe("none");
    });
  });
});

describe("SplitsDeltaCycle dial surface", () => {
  let action: SplitsDeltaCycle;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockIsBindingMissing.mockReturnValue(false);
    globalListeners.length = 0;
    action = new SplitsDeltaCycle();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function appear(ctx: DialContext, settings: Record<string, unknown> = dialSettings()) {
    await action.onWillAppear(basicEvent(ctx, settings) as never);
  }

  describe("onDialRotate", () => {
    it("taps the Next binding on a clockwise turn", async () => {
      const ctx = dialContext("d1");
      await appear(ctx);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, dialSettings(), 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("splitsDeltaNext");
      expect(mockTapBinding).toHaveBeenCalledTimes(1);
    });

    it("taps the Previous binding on a counter-clockwise turn", async () => {
      const ctx = dialContext("d2");
      await appear(ctx);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, dialSettings(), -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("splitsDeltaPrevious");
    });

    it("scales the tap count with tick magnitude", async () => {
      const ctx = dialContext("d3");
      await appear(ctx);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, dialSettings(), 3) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(3);
      expect(mockTapBinding).toHaveBeenNthCalledWith(1, "splitsDeltaNext");
    });

    it("caps the tap count per event", async () => {
      const ctx = dialContext("d4");
      await appear(ctx);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, dialSettings(), 12) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(5);
    });

    it("does nothing on a zero-tick event", async () => {
      const ctx = dialContext("d5");
      await appear(ctx);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, dialSettings(), 0) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("press gestures", () => {
    it("toggles the reference car on a short press by default", async () => {
      const ctx = dialContext("p1");
      await appear(ctx);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, dialSettings()) as never);
      await action.onDialUp(basicEvent(ctx, dialSettings()) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("toggleUiDisplayRefCar");
    });

    it("does nothing on a long press when the long slot is None (default)", async () => {
      const ctx = dialContext("p2");
      await appear(ctx);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, dialSettings()) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, dialSettings()) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("dispatches the long slot when configured", async () => {
      const ctx = dialContext("p3");
      const settings = dialSettings({ longPressAction: "toggle-ref-car" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("toggleUiDisplayRefCar");
    });

    it("dispatches a Custom Sector Start press using the keypad's exact binding key (#807 follow-up)", async () => {
      const ctx = dialContext("p3b");
      const settings = dialSettings({ pressAction: "custom-sector-start" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("splitsDeltaCustomSectorStart");
    });

    it("dispatches an Active Reset Run long press using the keypad's exact binding key (#807 follow-up)", async () => {
      const ctx = dialContext("p3c");
      const settings = dialSettings({ longPressAction: "active-reset-run" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("splitsDeltaActiveResetRun");
    });

    it("fires no press gesture after a push+turn", async () => {
      const ctx = dialContext("p4");
      await appear(ctx);

      await action.onDialDown(basicEvent(ctx, dialSettings()) as never);
      await action.onDialRotate(rotateEvent(ctx, dialSettings(), 1, true) as never);
      mockTapBinding.mockClear();
      await action.onDialUp(basicEvent(ctx, dialSettings()) as never);

      expect(mockTapBinding).not.toHaveBeenCalledWith("toggleUiDisplayRefCar");
    });

    it("does nothing when the press slot is None", async () => {
      const ctx = dialContext("p5");
      const settings = dialSettings({ pressAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("touch gestures", () => {
    it("does nothing when the tap slot is None (default)", async () => {
      const ctx = dialContext("t1");
      await appear(ctx);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchEvent(ctx, dialSettings(), false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("dispatches a configured tap gesture", async () => {
      const ctx = dialContext("t2");
      const settings = dialSettings({ tapAction: "toggle-ref-car" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchEvent(ctx, settings, false) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("toggleUiDisplayRefCar");
    });

    it("dispatches a Set Active Reset Point long touch using the keypad's exact binding key (#807 follow-up)", async () => {
      const ctx = dialContext("t2b");
      const settings = dialSettings({ longTouchAction: "active-reset-set" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchEvent(ctx, settings, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("splitsDeltaActiveResetSet");
    });

    it("ignores touch taps when the touch strip is unavailable", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("t3");
      const settings = dialSettings({ tapAction: "toggle-ref-car" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchEvent(ctx, settings, false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes a label-only identity strip (no readback exists)", async () => {
      const ctx = dialContext("f1");
      await appear(ctx);

      const decoded = lastFeedbackBox(ctx);

      expect(decoded).toContain(">DELTA<");
      // Identity-only: exactly one text node (the label), no value number.
      expect((decoded.match(/<text/g) ?? []).length).toBe(1);
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const ctx = dialContext("f2");
      await appear(ctx, dialSettings({ colors: { borderColor: "#112233", backgroundColor: "#445566" } }));

      const decoded = lastFeedbackBox(ctx);

      expect(decoded).toContain('stroke="#112233"');
      expect(decoded).toContain('fill="#445566"');
    });

    it("dims the strip under the #612 warning when a rotation binding is missing", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f3");
      await appear(ctx);

      const decoded = lastFeedbackBox(ctx);

      expect(mockIsBindingMissing).toHaveBeenCalledWith(["splitsDeltaNext", "splitsDeltaPrevious"]);
      expect(decoded).toContain("binding-warning");
    });

    it("pushes the two-line name icon as the deck-app dial image", async () => {
      const ctx = dialContext("f4");
      await appear(ctx);

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">SPLITS<");
      expect(img).toContain(">DELTA<");
    });

    it("skips feedback when the touch strip is unavailable", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("f5");
      await appear(ctx);

      expect(ctx.setFeedback).not.toHaveBeenCalled();
      expect(ctx.setTriggerDescription).not.toHaveBeenCalled();
    });

    it("re-renders every context on a global-settings change", async () => {
      const ctx = dialContext("f6");
      await appear(ctx);
      ctx.setFeedback.mockClear();

      for (const listener of globalListeners) listener();

      expect(ctx.setFeedback).toHaveBeenCalled();
    });
  });

  describe("lifecycle", () => {
    it("clears the context on disappear so a later release fires nothing", async () => {
      const ctx = dialContext("l1");
      await appear(ctx);

      await action.onDialDown(basicEvent(ctx, dialSettings()) as never);
      await action.onWillDisappear(basicEvent(ctx, dialSettings()) as never);
      mockTapBinding.mockClear();
      await action.onDialUp(basicEvent(ctx, dialSettings()) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });
});
