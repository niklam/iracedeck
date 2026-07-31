import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTriggerDescription, DialSettings, formatDialValue } from "./setup-fuel-dial-surface.js";
import { SetupFuel } from "./setup-fuel.js";

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
    IconUpdateThrottle: class {
      schedule(_id: string, render: () => unknown): void {
        void render();
      }
      clear(): void {}
      clearAll(): void {}
    },
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

function dialSettings(dial: Record<string, unknown>) {
  return { dial };
}

describe("setup-fuel dial-surface pure helpers", () => {
  describe("formatDialValue", () => {
    it("formats fuel values as plain integers", () => {
      expect(formatDialValue("fuel-mixture", { dcFuelMixture: 3 } as never)).toBe("3");
      expect(formatDialValue("fuel-cut-position", { dcFuelCutPosition: 5 } as never)).toBe("5");
    });

    it("shows the placeholder when telemetry is unavailable", () => {
      expect(formatDialValue("fuel-mixture", null)).toBe("---");
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the bound setting on rotate and rides the long-press on push", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({
          setting: "fuel-mixture",
          pressAction: "toggle-fcy",
          longPressAction: "toggle-fcy",
          tapAction: "none",
          longTouchAction: "none",
        }),
      );

      expect(desc.rotate).toBe("Adjust Fuel Mixture");
      expect(desc.push).toBe("Toggle FCY (hold: Toggle FCY)");
      expect(desc.touch).toBeUndefined();
      expect(desc.longTouch).toBeUndefined();
    });

    it("defaults to no press gesture and names the fuel-cut setting", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ setting: "fuel-cut-position" }));

      expect(desc.rotate).toBe("Adjust Fuel Cut");
      expect(desc.push).toBeUndefined();
    });
  });
});

describe("SetupFuel dial surface", () => {
  let action: SetupFuel;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockIsBindingMissing.mockReturnValue(false);
    mockGetCurrentTelemetry.mockReturnValue({ dcFuelMixture: 3, dcFuelCutPosition: 5 });
    globalListeners.length = 0;
    action = new SetupFuel();
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
      const settings = dialSettings({ setting: "fuel-mixture" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelMixtureIncrease");
    });

    it("taps the decrease binding on a counter-clockwise turn", async () => {
      const ctx = dialContext("d2");
      const settings = dialSettings({ setting: "fuel-mixture" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelMixtureDecrease");
    });

    it("resolves the binding per selected setting", async () => {
      const ctx = dialContext("d3");
      const settings = dialSettings({ setting: "fuel-cut-position" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelCutPositionIncrease");
    });

    it("dispatches one tap per rotate event regardless of tick magnitude", async () => {
      const ctx = dialContext("d4");
      const settings = dialSettings({ setting: "fuel-mixture" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 3) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(1);
      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelMixtureIncrease");
    });
  });

  describe("press gestures", () => {
    it("fires Toggle FCY on a short press when configured", async () => {
      const ctx = dialContext("p1");
      const settings = dialSettings({ setting: "fuel-mixture", pressAction: "toggle-fcy" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFcyModeToggle");
    });

    it("does nothing on a short press by default (none)", async () => {
      const ctx = dialContext("p4");
      const settings = dialSettings({ setting: "fuel-mixture" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("fires the long-press action when held past the threshold", async () => {
      const ctx = dialContext("p5");
      const settings = dialSettings({ setting: "fuel-mixture", longPressAction: "toggle-fcy" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFcyModeToggle");
    });

    it("fires no gesture on a push+turn (rotated while pressed)", async () => {
      const ctx = dialContext("p3");
      const settings = dialSettings({ setting: "fuel-mixture", pressAction: "toggle-fcy" });
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelMixtureIncrease");
      mockTapBinding.mockClear();

      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalledWith("setupFuelFcyModeToggle");
    });
  });

  describe("onTouchTap", () => {
    it("fires the tap action on a short touch when configured", async () => {
      const ctx = dialContext("t1");
      const settings = dialSettings({ setting: "fuel-mixture", tapAction: "toggle-fcy", longTouchAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFcyModeToggle");
    });

    it("fires the long-touch action on a held touch", async () => {
      const ctx = dialContext("t4");
      const settings = dialSettings({ setting: "fuel-mixture", longTouchAction: "toggle-fcy" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFcyModeToggle");
    });

    it("does nothing when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("t3");
      const settings = dialSettings({ setting: "fuel-mixture", tapAction: "toggle-fcy" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes the dash box as a single touch-strip pixmap on a dial", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, dialSettings({ setting: "fuel-mixture" }));

      expect(ctx.setFeedback).toHaveBeenCalled();
      const feedback = ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string };

      expect(feedback.box).toContain("data:image/svg+xml");
      const decoded = decodeURIComponent(feedback.box);

      expect(decoded).toContain(">MIX<");
      expect(decoded).toContain(">3<");
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const ctx = dialContext("a811");
      await appear(
        ctx,
        dialSettings({
          setting: "fuel-mixture",
          colors: { borderColor: "#112233", backgroundColor: "#445566" },
        }),
      );

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain('stroke="#112233"');
      expect(decoded).toContain('fill="#445566"');
    });

    it("pushes the two-line name icon as the deck-app dial image (#797)", async () => {
      const ctx = dialContext("f7");
      await appear(ctx, dialSettings({ setting: "fuel-mixture" }));

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">SETUP<");
      expect(img).toContain(">FUEL<");
    });

    it("dims the strip under the #612 warning when a rotation binding is missing", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f6");
      await appear(ctx, dialSettings({ setting: "fuel-mixture" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(mockIsBindingMissing).toHaveBeenCalledWith([
        "setupFuelFuelMixtureIncrease",
        "setupFuelFuelMixtureDecrease",
      ]);
      expect(decoded).toContain("binding-warning");
    });

    it("re-renders the box when the setting changes", async () => {
      const ctx = dialContext("f5");
      mockGetCurrentTelemetry.mockReturnValue({ dcFuelMixture: 3, dcFuelCutPosition: 5 });
      await appear(ctx, dialSettings({ setting: "fuel-mixture" }));
      ctx.setFeedback.mockClear();

      await action.onDidReceiveSettings(basicEvent(ctx, dialSettings({ setting: "fuel-cut-position" })) as never);

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">CUT<");
      expect(decoded).toContain(">5<");
    });
  });

  describe("legacy flat-setting migration (#797)", () => {
    it("seeds dial.setting from a pre-merge encoder placement's flat setting and persists it", async () => {
      const ctx = dialContext("m1");
      const legacy = { setting: "fuel-cut-position", direction: "decrease" };
      await appear(ctx, legacy);

      expect(ctx.setSettings).toHaveBeenCalledWith({ ...legacy, dial: { setting: "fuel-cut-position" } });
    });

    it("does not seed for View modes or non-rotation settings", async () => {
      const ctx2 = dialContext("m3");
      await appear(ctx2, { setting: "view-fuel-mixture" });

      expect(ctx2.setSettings).not.toHaveBeenCalled();

      const ctx3 = dialContext("m4");
      await appear(ctx3, { setting: "fcy-mode-toggle" });

      expect(ctx3.setSettings).not.toHaveBeenCalled();
    });
  });

  describe("subscription lifecycle", () => {
    it("subscribes on appear and unsubscribes on disappear", async () => {
      const ctx = dialContext("s1");
      await appear(ctx, dialSettings({ setting: "fuel-mixture" }));

      const sdk = (
        action as unknown as {
          sdkController: { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
        }
      ).sdkController;

      expect(sdk.subscribe).toHaveBeenCalled();

      await action.onWillDisappear(basicEvent(ctx, dialSettings({ setting: "fuel-mixture" })) as never);

      expect(sdk.unsubscribe).toHaveBeenCalledWith("s1");
    });
  });
});
