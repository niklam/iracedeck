import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTriggerDescription,
  formatDialValue,
  renderBrakeDialBoxSvg,
  SETUP_BRAKES_DIAL_UUID,
  SetupBrakesDial,
} from "./setup-brakes-dial.js";

const { mockGetCurrentTelemetry, mockTapBinding, mockIsBindingMissing, mockDualPressThreshold } = vi.hoisted(() => ({
  mockGetCurrentTelemetry: vi.fn<() => unknown>(() => null),
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockIsBindingMissing: vi.fn(() => false),
  // Mutable "Long-press threshold" global setting value (ms) for tests.
  mockDualPressThreshold: { value: 500 },
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: () => {
      const defaults = {
        setting: "brake-bias",
        pressAction: "toggle-abs",
        longPressAction: "none",
        tapAction: "none",
        longTouchAction: "none",
      };

      return {
        parse: (data: Record<string, unknown>) => ({ ...defaults, ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...defaults, ...data } }),
      };
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
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
  // setup-brakes.ts (imported for SETUP_BRAKES_GLOBAL_KEYS) only calls CommonSettings.extend
  // at module load; its other deck-core imports are referenced inside the never-instantiated
  // class, so a placeholder for DualPressTracker is all that's needed.
  DualPressTracker: class {},
  applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
  classifyDialRelease: (args: {
    pressStartMs: number;
    nowMs: number;
    rotatedWhilePressed: boolean;
    thresholdMs?: number;
  }) => {
    if (args.rotatedWhilePressed) return "push-turn";

    return args.nowMs - args.pressStartMs >= (args.thresholdMs ?? 500) ? "long" : "short";
  },
  getDualPressThresholdMs: () => mockDualPressThreshold.value,
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

/** Fake key (keypad) action context. */
function keyContext(id: string) {
  return {
    id,
    isKey: () => true,
    isDial: () => false,
    setImage: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
  };
}

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

type AnyContext = ReturnType<typeof dialContext> | ReturnType<typeof keyContext>;

function rotateEvent(action: AnyContext, settings: Record<string, unknown>, ticks: number, pressed = false) {
  return { action, payload: { settings, ticks, pressed } };
}

function basicEvent(action: AnyContext, settings: Record<string, unknown> = {}) {
  return { action, payload: { settings } };
}

function touchTapEvent(action: AnyContext, settings: Record<string, unknown>, hold: boolean) {
  return { action, payload: { settings, tapPos: [0, 0] as [number, number], hold } };
}

describe("setup-brakes-dial pure helpers", () => {
  describe("renderBrakeDialBoxSvg", () => {
    it("draws the abbreviation, value, accent border, and dark background", () => {
      const svg = renderBrakeDialBoxSvg({ width: 144, height: 144, color: "#e74c3c", abbr: "BB", value: "62.2" });

      expect(svg).toContain("#0d0d0d"); // dark background
      expect(svg).toContain('stroke="#e74c3c"'); // accent border
      expect(svg).toContain('fill="#e74c3c"'); // accent label + value
      expect(svg).toContain(">BB<");
      expect(svg).toContain(">62.2<");
    });

    it("shrinks the value font so a longer value fits inside a smaller one", () => {
      const long = /font-size="(\d+)"[^>]*>100\.0</.exec(
        renderBrakeDialBoxSvg({ width: 144, height: 144, color: "#e74c3c", abbr: "BB", value: "100.0" }),
      );
      const short = /font-size="(\d+)"[^>]*>3</.exec(
        renderBrakeDialBoxSvg({ width: 144, height: 144, color: "#f39c12", abbr: "ABS", value: "3" }),
      );

      expect(long).not.toBeNull();
      expect(short).not.toBeNull();
      expect(Number(long![1])).toBeLessThan(Number(short![1]));
    });

    it("draws the #612 warning overlay only when bindingMissing is set", () => {
      const without = renderBrakeDialBoxSvg({ width: 144, height: 144, color: "#f39c12", abbr: "ABS", value: "3" });
      const withWarn = renderBrakeDialBoxSvg({
        width: 144,
        height: 144,
        color: "#f39c12",
        abbr: "ABS",
        value: "3",
        bindingMissing: true,
      });

      expect(without).not.toContain("binding-warning");
      expect(withWarn).toContain("binding-warning");
    });
  });

  describe("formatDialValue", () => {
    it("drops the % from percentage settings", () => {
      expect(formatDialValue("brake-bias", { dcBrakeBias: 54 } as never)).toBe("54.0");
      expect(formatDialValue("brake-bias-fine", { dcBrakeBiasFine: 0.5 } as never)).toBe("0.5");
    });

    it("keeps integer settings as plain integers", () => {
      expect(formatDialValue("abs-adjust", { dcABS: 3 } as never)).toBe("3");
      expect(formatDialValue("engine-braking", { dcEngineBraking: 8 } as never)).toBe("8");
    });

    it("shows the placeholder when telemetry is unavailable", () => {
      expect(formatDialValue("brake-bias", null)).toBe("---");
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the bound setting on rotate and rides the long-press on push", () => {
      const desc = buildTriggerDescription({
        setting: "brake-bias",
        pressAction: "toggle-abs",
        longPressAction: "toggle-abs",
        tapAction: "none",
        longTouchAction: "none",
      } as never);

      expect(desc.rotate).toBe("Adjust Brake Bias");
      expect(desc.push).toBe("Toggle ABS (hold: Toggle ABS)");
      expect(desc.touch).toBeUndefined();
      expect(desc.longTouch).toBeUndefined();
    });

    it("maps the touch slots and omits none slots", () => {
      const desc = buildTriggerDescription({
        setting: "abs-adjust",
        pressAction: "none",
        longPressAction: "none",
        tapAction: "toggle-abs",
        longTouchAction: "toggle-abs",
      } as never);

      expect(desc.rotate).toBe("Adjust ABS");
      expect(desc.push).toBeUndefined();
      expect(desc.touch).toBe("Toggle ABS");
      expect(desc.longTouch).toBe("Toggle ABS");
    });
  });

  it("exposes the action UUID", () => {
    expect(SETUP_BRAKES_DIAL_UUID).toBe("com.iracedeck.sd.core.setup-brakes-dial");
  });
});

describe("SetupBrakesDial action", () => {
  let action: SetupBrakesDial;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockIsBindingMissing.mockReturnValue(false);
    mockGetCurrentTelemetry.mockReturnValue({ dcBrakeBias: 54, dcABS: 3 });
    action = new SetupBrakesDial();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function appear(ctx: AnyContext, settings: Record<string, unknown> = {}) {
    await action.onWillAppear(basicEvent(ctx, settings) as never);
  }

  describe("onDialRotate", () => {
    it("taps the increase binding on a clockwise turn", async () => {
      const ctx = dialContext("d1");
      await appear(ctx, { setting: "brake-bias" });
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, { setting: "brake-bias" }, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasIncrease");
    });

    it("taps the decrease binding on a counter-clockwise turn", async () => {
      const ctx = dialContext("d2");
      await appear(ctx, { setting: "brake-bias" });
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, { setting: "brake-bias" }, -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasDecrease");
    });

    it("resolves the binding per selected setting", async () => {
      const ctx = dialContext("d3");
      await appear(ctx, { setting: "abs-adjust" });
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, { setting: "abs-adjust" }, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesAbsAdjustIncrease");
    });

    it("dispatches one tap per rotate event regardless of tick magnitude", async () => {
      const ctx = dialContext("d4");
      await appear(ctx, { setting: "brake-bias" });
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, { setting: "brake-bias" }, 3) as never);

      // One tap per event by sign (matches the sibling Setup Brakes / black-box dials);
      // relative key bindings apply immediately in iRacing, so there is nothing to coalesce.
      expect(mockTapBinding).toHaveBeenCalledTimes(1);
      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasIncrease");
    });
  });

  describe("press gestures", () => {
    it("fires the press action on a short press (toggle ABS by default)", async () => {
      const ctx = dialContext("p1");
      await appear(ctx, { setting: "brake-bias", pressAction: "toggle-abs" });
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, { setting: "brake-bias", pressAction: "toggle-abs" }) as never);
      await action.onDialUp(basicEvent(ctx, { setting: "brake-bias", pressAction: "toggle-abs" }) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesAbsToggle");
    });

    it("fires the long-press action when held past the threshold", async () => {
      const ctx = dialContext("p2");
      const settings = { setting: "brake-bias", pressAction: "none", longPressAction: "toggle-abs" };
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesAbsToggle");
    });

    it("fires no gesture on a push+turn (rotated while pressed)", async () => {
      const ctx = dialContext("p3");
      const settings = { setting: "brake-bias", pressAction: "toggle-abs" };
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      // Rotate while pressed: still adjusts brake bias, but guards the release.
      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never);

      // The rotation still adjusts the bound setting even while the button is held.
      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasIncrease");
      mockTapBinding.mockClear();

      await action.onDialUp(basicEvent(ctx, settings) as never);

      // The press gesture (toggle ABS) must NOT fire after a push+turn.
      expect(mockTapBinding).not.toHaveBeenCalledWith("setupBrakesAbsToggle");
    });

    it("does nothing when the press action is none", async () => {
      const ctx = dialContext("p4");
      const settings = { setting: "brake-bias", pressAction: "none" };
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("fires the press action from a plain keypad button", async () => {
      const ctx = keyContext("k1");
      const settings = { setting: "brake-bias", pressAction: "toggle-abs" };
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onKeyDown(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesAbsToggle");
    });
  });

  describe("onTouchTap", () => {
    it("fires the tap action on a short touch", async () => {
      const ctx = dialContext("t1");
      const settings = { setting: "brake-bias", tapAction: "toggle-abs", longTouchAction: "none" };
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesAbsToggle");
    });

    it("fires the long-touch action on a long touch", async () => {
      const ctx = dialContext("t2");
      const settings = { setting: "brake-bias", tapAction: "none", longTouchAction: "toggle-abs" };
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesAbsToggle");
    });

    it("does nothing when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("t3");
      const settings = { setting: "brake-bias", tapAction: "toggle-abs" };
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes the dash box as a single touch-strip pixmap on a dial", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, { setting: "brake-bias" });

      expect(ctx.setFeedback).toHaveBeenCalled();
      const feedback = ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string };

      expect(feedback.box).toContain("data:image/svg+xml");
      const decoded = decodeURIComponent(feedback.box);

      expect(decoded).toContain(">BB<");
      expect(decoded).toContain(">54.0<"); // value with the % dropped
    });

    it("pushes the encoder trigger description on a dial", async () => {
      const ctx = dialContext("f2");
      await appear(ctx, { setting: "brake-bias" });

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
    });

    it("does not push feedback on a keypad button", async () => {
      const ctx = keyContext("f3");
      await appear(ctx, { setting: "brake-bias" });

      expect(ctx.setFeedback).not.toHaveBeenCalled();
    });

    it("throttles feedback to the change-render window so the setFeedback cap holds", async () => {
      const ctx = dialContext("f4");
      mockGetCurrentTelemetry.mockReturnValue({ dcBrakeBias: 54 });
      await appear(ctx, { setting: "brake-bias" });

      const onTick = (
        action as unknown as { sdkController: { subscribe: ReturnType<typeof vi.fn> } }
      ).sdkController.subscribe.mock.calls.at(-1)?.[1] as (telemetry: unknown) => void;
      ctx.setFeedback.mockClear();

      // Within the 100 ms window: the value changes but the feedback push is throttled.
      vi.advanceTimersByTime(50);
      mockGetCurrentTelemetry.mockReturnValue({ dcBrakeBias: 55 });
      onTick({ dcBrakeBias: 55 });

      expect(ctx.setFeedback).not.toHaveBeenCalled();

      // Past the window: the next change flushes one feedback push.
      vi.advanceTimersByTime(100);
      mockGetCurrentTelemetry.mockReturnValue({ dcBrakeBias: 56 });
      onTick({ dcBrakeBias: 56 });

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);
      // The flushed push carries the latest value (56.0), not the throttled-over one.
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">56.0<");
    });

    it("re-renders the box and trigger description when the setting changes", async () => {
      const ctx = dialContext("f5");
      mockGetCurrentTelemetry.mockReturnValue({ dcBrakeBias: 54, dcABS: 3 });
      await appear(ctx, { setting: "brake-bias" });
      ctx.setFeedback.mockClear();
      ctx.setTriggerDescription.mockClear();

      await action.onDidReceiveSettings(basicEvent(ctx, { setting: "abs-adjust" }) as never);

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">ABS<");
      expect(decoded).toContain(">3<");
    });
  });

  describe("active binding", () => {
    it("declares both rotation bindings on appear and re-declares them on a setting change", async () => {
      const ctx = dialContext("ab1");
      await appear(ctx, { setting: "brake-bias" });

      const setActiveBinding = (action as unknown as { setActiveBinding: ReturnType<typeof vi.fn> }).setActiveBinding;

      expect(setActiveBinding).toHaveBeenCalledWith(["setupBrakesBrakeBiasIncrease", "setupBrakesBrakeBiasDecrease"]);

      setActiveBinding.mockClear();
      await action.onDidReceiveSettings(basicEvent(ctx, { setting: "abs-adjust" }) as never);

      expect(setActiveBinding).toHaveBeenCalledWith(["setupBrakesAbsAdjustIncrease", "setupBrakesAbsAdjustDecrease"]);
    });
  });

  describe("subscription lifecycle", () => {
    it("subscribes on appear and unsubscribes on disappear", async () => {
      const ctx = dialContext("s1");
      await appear(ctx, { setting: "brake-bias" });

      const sdk = (
        action as unknown as {
          sdkController: { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
        }
      ).sdkController;

      expect(sdk.subscribe).toHaveBeenCalled();

      await action.onWillDisappear(basicEvent(ctx, { setting: "brake-bias" }) as never);

      expect(sdk.unsubscribe).toHaveBeenCalledWith("s1");
    });
  });
});
