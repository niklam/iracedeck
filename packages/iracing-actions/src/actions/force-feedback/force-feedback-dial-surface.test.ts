import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTriggerDescription, DialSettings, formatDialValue } from "./force-feedback-dial-surface.js";
import { ForceFeedback } from "./force-feedback.js";

const { mockGetCurrentTelemetry, mockTapBinding, mockIsBindingMissing, mockDualPressThreshold, globalListeners } =
  vi.hoisted(() => ({
    mockGetCurrentTelemetry: vi.fn<() => unknown>(() => null),
    mockTapBinding: vi.fn().mockResolvedValue(undefined),
    mockIsBindingMissing: vi.fn(() => false),
    // Mutable "Long-press threshold" global setting value (ms) for tests.
    mockDualPressThreshold: { value: 500 },
    // Captured onGlobalSettingsChange listeners (one per constructed action).
    globalListeners: [] as Array<() => void>,
  }));

vi.mock("@iracedeck/deck-core", async () => {
  // REAL zod semantics for the extended settings schema (defaults, the `dial`
  // prefault, enum validation) — only the CommonSettings base fields are absent.
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
        getCurrentTelemetry: mockGetCurrentTelemetry,
        getSessionInfo: vi.fn(() => null),
      };
      setKeyImage = vi.fn().mockResolvedValue(undefined);
      setRegenerateCallback = vi.fn();
      updateKeyImage = vi.fn().mockResolvedValue(false);
      setActiveBinding = vi.fn();
      tapBinding = mockTapBinding;
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
    // #612 binding-missing overlay — appends a recognizable marker for assertions.
    applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
    escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
  };
});

/** Fake dial (encoder) action context. */
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

function touchTapEvent(action: DialContext, settings: Record<string, unknown>, hold: boolean) {
  return { action, payload: { settings, tapPos: [0, 0] as [number, number], hold } };
}

/** Dial settings under the `dial` root (#802). */
function dialSettings(dial: Record<string, unknown>) {
  return { dial };
}

describe("force-feedback dial-surface pure helpers", () => {
  describe("formatDialValue", () => {
    it("formats the live max force as one-decimal Nm", () => {
      expect(formatDialValue("ffb-force", { SteeringWheelMaxForceNm: 12.34 } as never)).toBe("12.3 Nm");
      expect(formatDialValue("ffb-force", { SteeringWheelMaxForceNm: 8 } as never)).toBe("8.0 Nm");
    });

    it("shows the placeholder when ffb-force has no telemetry", () => {
      expect(formatDialValue("ffb-force", null)).toBe("---");
      expect(formatDialValue("ffb-force", {} as never)).toBe("---");
    });

    it("returns empty (identity-only) for the LFE settings, which have no readback", () => {
      expect(formatDialValue("wheel-lfe", { SteeringWheelMaxForceNm: 12 } as never)).toBe("");
      expect(formatDialValue("bass-shaker-lfe", null)).toBe("");
      expect(formatDialValue("wheel-lfe-intensity", null)).toBe("");
      expect(formatDialValue("haptic-lfe-intensity", null)).toBe("");
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the bound setting on rotate and offers no press gesture by default", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ setting: "ffb-force" }));

      expect(desc.rotate).toBe("Adjust FFB Force");
      expect(desc.push).toBeUndefined();
    });

    it("rides the Auto FFB press and long-press gestures", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ setting: "wheel-lfe", pressAction: "auto-ffb", longPressAction: "auto-ffb" }),
      );

      expect(desc.rotate).toBe("Adjust Wheel LFE");
      expect(desc.push).toBe("Auto FFB (hold: Auto FFB)");
    });

    it("maps the touch slots and omits none slots", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ setting: "ffb-force", tapAction: "auto-ffb", longTouchAction: "none" }),
      );

      expect(desc.touch).toBe("Auto FFB");
      expect(desc.longTouch).toBeUndefined();
    });
  });
});

describe("ForceFeedback dial surface", () => {
  let action: ForceFeedback;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockIsBindingMissing.mockReturnValue(false);
    mockGetCurrentTelemetry.mockReturnValue({ SteeringWheelMaxForceNm: 12.34 });
    globalListeners.length = 0;
    action = new ForceFeedback();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function appear(ctx: DialContext, settings: Record<string, unknown> = {}) {
    await action.onWillAppear(basicEvent(ctx, settings) as never);
  }

  describe("onDialRotate", () => {
    it("taps the increase binding on a clockwise turn", async () => {
      const ctx = dialContext("d1");
      const settings = dialSettings({ setting: "ffb-force" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceIncrease");
    });

    it("taps the decrease binding on a counter-clockwise turn", async () => {
      const ctx = dialContext("d2");
      const settings = dialSettings({ setting: "ffb-force" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceDecrease");
    });

    it("adjusts an identity-only LFE setting too", async () => {
      const ctx = dialContext("d3");
      const settings = dialSettings({ setting: "wheel-lfe" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("forceFeedbackWheelLfeLouder");
    });

    it("scales taps by tick magnitude, capped at 5 per event", async () => {
      const ctx = dialContext("d4");
      const settings = dialSettings({ setting: "ffb-force" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 3) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(3);

      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 7) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(5);
    });
  });

  describe("press gestures", () => {
    it("does nothing on a short press by default (None)", async () => {
      const ctx = dialContext("p0");
      const settings = dialSettings({ setting: "ffb-force" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("runs Auto FFB on a short press when configured", async () => {
      const ctx = dialContext("p1");
      const settings = dialSettings({ setting: "ffb-force", pressAction: "auto-ffb" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("forceFeedbackAutoCompute");
    });

    it("runs the long-press gesture when held past the threshold", async () => {
      const ctx = dialContext("p2");
      const settings = dialSettings({ setting: "ffb-force", pressAction: "none", longPressAction: "auto-ffb" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("forceFeedbackAutoCompute");
    });

    it("fires no gesture on a push+turn (rotated while pressed)", async () => {
      const ctx = dialContext("p3");
      const settings = dialSettings({ setting: "ffb-force", pressAction: "auto-ffb" });
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      // Rotate while pressed: still adjusts FFB force, but guards the release.
      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceIncrease");
      mockTapBinding.mockClear();

      await action.onDialUp(basicEvent(ctx, settings) as never);

      // The press gesture (Auto FFB) must NOT fire after a push+turn.
      expect(mockTapBinding).not.toHaveBeenCalledWith("forceFeedbackAutoCompute");
    });
  });

  describe("onTouchTap", () => {
    it("runs the tap action on a short touch", async () => {
      const ctx = dialContext("t1");
      const settings = dialSettings({ setting: "ffb-force", tapAction: "auto-ffb", longTouchAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("forceFeedbackAutoCompute");
    });

    it("does nothing when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("t3");
      const settings = dialSettings({ setting: "ffb-force", tapAction: "auto-ffb" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes the dash box with the live Nm value on ffb-force", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, dialSettings({ setting: "ffb-force" }));

      expect(ctx.setFeedback).toHaveBeenCalled();
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">FFB<");
      expect(decoded).toContain(">12.3 Nm<");
    });

    it("pushes a label-only strip for an identity-only LFE setting", async () => {
      const ctx = dialContext("f2");
      await appear(ctx, dialSettings({ setting: "wheel-lfe" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">WHEEL<");
      // Identity-only: exactly one text node (the label), no value number.
      expect((decoded.match(/<text/g) ?? []).length).toBe(1);
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const ctx = dialContext("a1");
      await appear(
        ctx,
        dialSettings({
          setting: "ffb-force",
          colors: { borderColor: "#112233", backgroundColor: "#445566" },
        }),
      );

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain('stroke="#112233"'); // border override
      expect(decoded).toContain('fill="#445566"'); // background override, filling inside the border
    });

    it("pushes the two-line name icon as the deck-app dial image (#802)", async () => {
      const ctx = dialContext("f7");
      await appear(ctx, dialSettings({ setting: "ffb-force" }));

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">FORCE<");
      expect(img).toContain(">FEEDBACK<");
    });

    it("throttles feedback to the change-render window so the setFeedback cap holds", async () => {
      const ctx = dialContext("f4");
      mockGetCurrentTelemetry.mockReturnValue({ SteeringWheelMaxForceNm: 12 });
      await appear(ctx, dialSettings({ setting: "ffb-force" }));

      const onTick = (
        action as unknown as { sdkController: { subscribe: ReturnType<typeof vi.fn> } }
      ).sdkController.subscribe.mock.calls.at(-1)?.[1] as (telemetry: unknown) => void;
      ctx.setFeedback.mockClear();

      // Within the 100 ms window: the value changes but the feedback push is throttled.
      vi.advanceTimersByTime(50);
      mockGetCurrentTelemetry.mockReturnValue({ SteeringWheelMaxForceNm: 13 });
      onTick({ SteeringWheelMaxForceNm: 13 });

      expect(ctx.setFeedback).not.toHaveBeenCalled();

      // Past the window: the next change flushes one feedback push.
      vi.advanceTimersByTime(100);
      mockGetCurrentTelemetry.mockReturnValue({ SteeringWheelMaxForceNm: 14 });
      onTick({ SteeringWheelMaxForceNm: 14 });

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">14.0 Nm<");
    });

    it("dims the strip under the #612 warning when a rotation binding is missing", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f6");
      await appear(ctx, dialSettings({ setting: "ffb-force" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(mockIsBindingMissing).toHaveBeenCalledWith(["cockpitMiscFfbForceIncrease", "cockpitMiscFfbForceDecrease"]);
      expect(decoded).toContain("binding-warning");
    });

    it("re-renders the box and trigger description when the setting changes", async () => {
      const ctx = dialContext("f5");
      await appear(ctx, dialSettings({ setting: "ffb-force" }));
      ctx.setFeedback.mockClear();
      ctx.setTriggerDescription.mockClear();

      await action.onDidReceiveSettings(basicEvent(ctx, dialSettings({ setting: "wheel-lfe" })) as never);

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">WHEEL<");
    });
  });

  describe("legacy flat-setting migration (#802)", () => {
    it("seeds dial.setting from a pre-merge encoder placement's flat mode and persists it", async () => {
      const ctx = dialContext("m1");
      // Pre-#802 encoder placement: flat keypad settings (`mode`), no dial root.
      const legacy = { mode: "wheel-lfe", direction: "decrease" };
      await appear(ctx, legacy);

      expect(ctx.setSettings).toHaveBeenCalledWith({ ...legacy, dial: { setting: "wheel-lfe" } });
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, { ...legacy, dial: { setting: "wheel-lfe" } }, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("forceFeedbackWheelLfeLouder");
    });

    it("does not seed for auto-compute (not a rotation value) or when a dial object exists", async () => {
      const ctx1 = dialContext("m2");
      await appear(ctx1, { mode: "auto-compute-ffb-force" });

      expect(ctx1.setSettings).not.toHaveBeenCalled();

      const ctx2 = dialContext("m3");
      await appear(ctx2, { mode: "wheel-lfe", dial: { setting: "ffb-force" } });

      expect(ctx2.setSettings).not.toHaveBeenCalled();

      const ctx3 = dialContext("m4");
      await appear(ctx3, {});

      expect(ctx3.setSettings).not.toHaveBeenCalled();
    });
  });

  describe("global-settings refresh", () => {
    it("re-renders the strip when global settings change so the #612 warning tracks live bindings", async () => {
      const ctx = dialContext("g1");
      await appear(ctx, dialSettings({ setting: "ffb-force" }));

      expect(globalListeners.length).toBeGreaterThan(0);
      ctx.setFeedback.mockClear();

      // The binding was configured while iRacing is offline (no telemetry ticks).
      mockIsBindingMissing.mockReturnValue(true);

      for (const listener of globalListeners) listener();

      expect(ctx.setFeedback).toHaveBeenCalled();
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain("binding-warning");
    });
  });

  describe("active binding", () => {
    it("does not declare active bindings for dial instances (would bleed onto keypad buttons)", async () => {
      const ctx = dialContext("ab1");
      await appear(ctx, dialSettings({ setting: "ffb-force" }));

      const setActiveBinding = (action as unknown as { setActiveBinding: ReturnType<typeof vi.fn> }).setActiveBinding;

      expect(setActiveBinding).not.toHaveBeenCalled();
    });
  });

  describe("subscription lifecycle", () => {
    it("subscribes on appear and unsubscribes on disappear", async () => {
      const ctx = dialContext("s1");
      await appear(ctx, dialSettings({ setting: "ffb-force" }));

      const sdk = (
        action as unknown as {
          sdkController: { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
        }
      ).sdkController;

      expect(sdk.subscribe).toHaveBeenCalled();

      await action.onWillDisappear(basicEvent(ctx, dialSettings({ setting: "ffb-force" })) as never);

      expect(sdk.unsubscribe).toHaveBeenCalledWith("s1");
    });
  });
});
