import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTriggerDescription, DialSettings, formatDialValue } from "./setup-traction-dial-surface.js";
import { SetupTraction } from "./setup-traction.js";

const { mockGetCurrentTelemetry, mockTapBinding, mockIsBindingMissing, mockDualPressThreshold, globalListeners } =
  vi.hoisted(() => ({
    mockGetCurrentTelemetry: vi.fn<() => unknown>(() => null),
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
    DualPressTracker: class {
      recordKeyDown = vi.fn();
      computeOutcome = vi.fn(() => undefined);
      clear = vi.fn();
    },
    getDualPressDirections: vi.fn(() => "tap-increases"),
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

function touchTapEvent(action: DialContext, settings: Record<string, unknown>, hold: boolean) {
  return { action, payload: { settings, tapPos: [0, 0] as [number, number], hold } };
}

/** Dial settings under the `dial` root (#795). */
function dialSettings(dial: Record<string, unknown>) {
  return { dial };
}

describe("setup-traction dial-surface pure helpers", () => {
  describe("formatDialValue", () => {
    it("formats TC slot values as plain integers", () => {
      expect(formatDialValue("tc-slot-1", { dcTractionControl: 3 } as never)).toBe("3");
      expect(formatDialValue("tc-slot-2", { dcTractionControl2: 5 } as never)).toBe("5");
    });

    it("shows the placeholder when telemetry is unavailable", () => {
      expect(formatDialValue("tc-slot-1", null)).toBe("---");
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the bound setting on rotate and rides the long-press on push", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({
          setting: "tc-slot-1",
          pressAction: "toggle-tc",
          longPressAction: "toggle-tc",
          tapAction: "none",
          longTouchAction: "none",
        }),
      );

      expect(desc.rotate).toBe("Adjust TC 1");
      expect(desc.push).toBe("Toggle TC (hold: Toggle TC)");
      expect(desc.touch).toBeUndefined();
      expect(desc.longTouch).toBeUndefined();
    });

    it("maps the touch slots and omits none slots", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({
          setting: "tc-slot-2",
          pressAction: "none",
          longPressAction: "none",
          tapAction: "toggle-tc",
          longTouchAction: "toggle-tc",
        }),
      );

      expect(desc.rotate).toBe("Adjust TC 2");
      expect(desc.push).toBeUndefined();
      expect(desc.touch).toBe("Toggle TC");
      expect(desc.longTouch).toBe("Toggle TC");
    });
  });
});

describe("SetupTraction dial surface", () => {
  let action: SetupTraction;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockIsBindingMissing.mockReturnValue(false);
    mockGetCurrentTelemetry.mockReturnValue({ dcTractionControl: 3, dcTractionControl2: 5 });
    globalListeners.length = 0;
    action = new SetupTraction();
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
      const settings = dialSettings({ setting: "tc-slot-1" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot1Increase");
    });

    it("taps the decrease binding on a counter-clockwise turn", async () => {
      const ctx = dialContext("d2");
      const settings = dialSettings({ setting: "tc-slot-1" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot1Decrease");
    });

    it("resolves the binding per selected setting", async () => {
      const ctx = dialContext("d3");
      const settings = dialSettings({ setting: "tc-slot-2" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot2Increase");
    });

    it("dispatches one tap per rotate event regardless of tick magnitude", async () => {
      const ctx = dialContext("d4");
      const settings = dialSettings({ setting: "tc-slot-1" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 3) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(1);
      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot1Increase");
    });
  });

  describe("press gestures", () => {
    it("fires the press action on a short press (toggle TC by default)", async () => {
      const ctx = dialContext("p1");
      const settings = dialSettings({ setting: "tc-slot-1", pressAction: "toggle-tc" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcToggle");
    });

    it("fires the long-press action when held past the threshold", async () => {
      const ctx = dialContext("p2");
      const settings = dialSettings({ setting: "tc-slot-1", pressAction: "none", longPressAction: "toggle-tc" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcToggle");
    });

    it("fires no gesture on a push+turn (rotated while pressed)", async () => {
      const ctx = dialContext("p3");
      const settings = dialSettings({ setting: "tc-slot-1", pressAction: "toggle-tc" });
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot1Increase");
      mockTapBinding.mockClear();

      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalledWith("setupTractionTcToggle");
    });

    it("does nothing when the press action is none", async () => {
      const ctx = dialContext("p4");
      const settings = dialSettings({ setting: "tc-slot-1", pressAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("onTouchTap", () => {
    it("fires the tap action on a short touch", async () => {
      const ctx = dialContext("t1");
      const settings = dialSettings({ setting: "tc-slot-1", tapAction: "toggle-tc", longTouchAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcToggle");
    });

    it("fires the long-touch action on a long touch", async () => {
      const ctx = dialContext("t2");
      const settings = dialSettings({ setting: "tc-slot-1", tapAction: "none", longTouchAction: "toggle-tc" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcToggle");
    });

    it("does nothing when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("t3");
      const settings = dialSettings({ setting: "tc-slot-1", tapAction: "toggle-tc" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes the dash box as a single touch-strip pixmap on a dial", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, dialSettings({ setting: "tc-slot-1" }));

      expect(ctx.setFeedback).toHaveBeenCalled();
      const feedback = ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string };

      expect(feedback.box).toContain("data:image/svg+xml");
      const decoded = decodeURIComponent(feedback.box);

      expect(decoded).toContain(">TC1<");
      expect(decoded).toContain(">3<");
    });

    it("applies dash-box color overrides and border glow from dial settings (#811)", async () => {
      const ctx = dialContext("a811");
      await appear(
        ctx,
        dialSettings({
          setting: "tc-slot-1",
          colors: { borderColor: "#112233", backgroundColor: "#445566" },
          glow: true,
          glowWidth: 14,
        }),
      );

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain('stroke="#112233"');
      expect(decoded).toContain('fill="#445566"');
      expect(decoded).toContain("feGaussianBlur");
    });

    it("pushes the encoder trigger description on a dial", async () => {
      const ctx = dialContext("f2");
      await appear(ctx, dialSettings({ setting: "tc-slot-1" }));

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
    });

    it("pushes the two-line name icon as the deck-app dial image (#795)", async () => {
      const ctx = dialContext("f7");
      await appear(ctx, dialSettings({ setting: "tc-slot-1" }));

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">SETUP<");
      expect(img).toContain(">TRACTION<");
    });

    it("throttles feedback to the change-render window so the setFeedback cap holds", async () => {
      const ctx = dialContext("f4");
      mockGetCurrentTelemetry.mockReturnValue({ dcTractionControl: 3 });
      await appear(ctx, dialSettings({ setting: "tc-slot-1" }));

      const onTick = (
        action as unknown as { sdkController: { subscribe: ReturnType<typeof vi.fn> } }
      ).sdkController.subscribe.mock.calls.at(-1)?.[1] as (telemetry: unknown) => void;
      ctx.setFeedback.mockClear();

      vi.advanceTimersByTime(50);
      mockGetCurrentTelemetry.mockReturnValue({ dcTractionControl: 4 });
      onTick({ dcTractionControl: 4 });

      expect(ctx.setFeedback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      mockGetCurrentTelemetry.mockReturnValue({ dcTractionControl: 5 });
      onTick({ dcTractionControl: 5 });

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">5<");
    });

    it("dims the strip under the #612 warning when a rotation binding is missing", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f6");
      await appear(ctx, dialSettings({ setting: "tc-slot-1" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(mockIsBindingMissing).toHaveBeenCalledWith([
        "setupTractionTcSlot1Increase",
        "setupTractionTcSlot1Decrease",
      ]);
      expect(decoded).toContain("binding-warning");
    });

    it("re-renders the box and trigger description when the setting changes", async () => {
      const ctx = dialContext("f5");
      mockGetCurrentTelemetry.mockReturnValue({ dcTractionControl: 3, dcTractionControl2: 5 });
      await appear(ctx, dialSettings({ setting: "tc-slot-1" }));
      ctx.setFeedback.mockClear();
      ctx.setTriggerDescription.mockClear();

      await action.onDidReceiveSettings(basicEvent(ctx, dialSettings({ setting: "tc-slot-2" })) as never);

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">TC2<");
      expect(decoded).toContain(">5<");
    });
  });

  describe("legacy flat-setting migration (#795)", () => {
    it("seeds dial.setting from a pre-merge encoder placement's flat setting and persists it", async () => {
      const ctx = dialContext("m1");
      const legacy = { setting: "tc-slot-2", direction: "decrease" };
      await appear(ctx, legacy);

      expect(ctx.setSettings).toHaveBeenCalledWith({ ...legacy, dial: { setting: "tc-slot-2" } });
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, { ...legacy, dial: { setting: "tc-slot-2" } }, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot2Increase");
    });

    it("does not seed when a dial object is already persisted or the flat setting is not a rotation value", async () => {
      const ctx1 = dialContext("m2");
      await appear(ctx1, { setting: "tc-slot-2", dial: { setting: "tc-slot-1" } });

      expect(ctx1.setSettings).not.toHaveBeenCalled();

      const ctx2 = dialContext("m3");
      await appear(ctx2, { setting: "view-tc-slot-1" });

      expect(ctx2.setSettings).not.toHaveBeenCalled();

      const ctx3 = dialContext("m4");
      await appear(ctx3, {});

      expect(ctx3.setSettings).not.toHaveBeenCalled();
    });
  });

  describe("global-settings refresh", () => {
    it("re-renders the strip when global settings change so the #612 warning tracks live bindings", async () => {
      const ctx = dialContext("g1");
      await appear(ctx, dialSettings({ setting: "tc-slot-1" }));

      expect(globalListeners.length).toBeGreaterThan(0);
      ctx.setFeedback.mockClear();

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
      await appear(ctx, dialSettings({ setting: "tc-slot-1" }));

      const setActiveBinding = (action as unknown as { setActiveBinding: ReturnType<typeof vi.fn> }).setActiveBinding;

      expect(setActiveBinding).not.toHaveBeenCalled();

      await action.onDidReceiveSettings(basicEvent(ctx, dialSettings({ setting: "tc-slot-2" })) as never);

      expect(setActiveBinding).not.toHaveBeenCalled();
    });
  });

  describe("subscription lifecycle", () => {
    it("subscribes on appear and unsubscribes on disappear", async () => {
      const ctx = dialContext("s1");
      await appear(ctx, dialSettings({ setting: "tc-slot-1" }));

      const sdk = (
        action as unknown as {
          sdkController: { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
        }
      ).sdkController;

      expect(sdk.subscribe).toHaveBeenCalled();

      await action.onWillDisappear(basicEvent(ctx, dialSettings({ setting: "tc-slot-1" })) as never);

      expect(sdk.unsubscribe).toHaveBeenCalledWith("s1");
    });
  });
});
