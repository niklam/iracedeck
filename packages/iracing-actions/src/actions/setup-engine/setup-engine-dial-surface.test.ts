import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTriggerDescription,
  DialSettings,
  formatDialValue,
  renderEngineDialBoxSvg,
} from "./setup-engine-dial-surface.js";
import { SetupEngine } from "./setup-engine.js";

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

function dialSettings(dial: Record<string, unknown>) {
  return { dial };
}

describe("setup-engine dial-surface pure helpers", () => {
  describe("renderEngineDialBoxSvg", () => {
    it("draws the abbreviation, value, accent border, and dark background", () => {
      const svg = renderEngineDialBoxSvg({ width: 144, height: 144, color: "#e74c3c", abbr: "POWER", value: "3" });

      expect(svg).toContain("#0d0d0d");
      expect(svg).toContain('stroke="#e74c3c"');
      expect(svg).toContain(">POWER<");
      expect(svg).toContain(">3<");
    });

    it("renders label-only (no value node) for an identity-only setting (boost)", () => {
      const svg = renderEngineDialBoxSvg({ width: 200, height: 100, color: "#f39c12", abbr: "BOOST", value: "" });

      expect(svg).toContain(">BOOST<");
      expect((svg.match(/<text/g) ?? []).length).toBe(1);
    });

    it("draws the #612 warning overlay only when bindingMissing is set", () => {
      const withWarn = renderEngineDialBoxSvg({
        width: 200,
        height: 100,
        color: "#e74c3c",
        abbr: "POWER",
        value: "3",
        bindingMissing: true,
      });

      expect(withWarn).toContain("binding-warning");
    });
  });

  describe("formatDialValue", () => {
    it("formats readback settings as plain integers", () => {
      expect(formatDialValue("engine-power", { dcEnginePower: 3 } as never)).toBe("3");
      expect(formatDialValue("launch-rpm", { dcLaunchRPM: 12000 } as never)).toBe("12000");
    });

    it("returns empty (identity-only) for boost-level, which has no telemetry", () => {
      expect(formatDialValue("boost-level", { dcEnginePower: 3 } as never)).toBe("");
    });

    it("shows the placeholder when a readback setting has no telemetry", () => {
      expect(formatDialValue("engine-power", null)).toBe("---");
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the bound setting on rotate and offers no press gesture", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ setting: "engine-power" }));

      expect(desc.rotate).toBe("Adjust Engine Power");
      expect(desc.push).toBeUndefined();
    });

    it("names the boost-level setting", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ setting: "boost-level" }));

      expect(desc.rotate).toBe("Adjust Boost Level");
    });
  });
});

describe("SetupEngine dial surface", () => {
  let action: SetupEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockIsBindingMissing.mockReturnValue(false);
    mockGetCurrentTelemetry.mockReturnValue({ dcEnginePower: 3, dcThrottleShape: 5 });
    globalListeners.length = 0;
    action = new SetupEngine();
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
      const settings = dialSettings({ setting: "engine-power" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupEngineEnginePowerIncrease");
    });

    it("adjusts an identity-only setting (boost) too", async () => {
      const ctx = dialContext("d3");
      const settings = dialSettings({ setting: "boost-level" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupEngineBoostLevelDecrease");
    });

    it("dispatches one tap per rotate event regardless of tick magnitude", async () => {
      const ctx = dialContext("d4");
      const settings = dialSettings({ setting: "engine-power" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 3) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(1);
    });
  });

  describe("press gestures (none configured)", () => {
    it("does nothing on a short press", async () => {
      const ctx = dialContext("p1");
      const settings = dialSettings({ setting: "engine-power" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes the dash box with the live value on a readback setting", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, dialSettings({ setting: "engine-power" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">POWER<");
      expect(decoded).toContain(">3<");
    });

    it("pushes a label-only strip for boost-level (identity-only)", async () => {
      const ctx = dialContext("fb");
      await appear(ctx, dialSettings({ setting: "boost-level" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">BOOST<");
      // Identity-only: exactly one text node (the label), no value number.
      expect((decoded.match(/<text/g) ?? []).length).toBe(1);
    });

    it("pushes the two-line name icon as the deck-app dial image (#798)", async () => {
      const ctx = dialContext("f7");
      await appear(ctx, dialSettings({ setting: "engine-power" }));

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">SETUP<");
      expect(img).toContain(">ENGINE<");
    });

    it("dims the strip under the #612 warning when a rotation binding is missing", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f6");
      await appear(ctx, dialSettings({ setting: "engine-power" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(mockIsBindingMissing).toHaveBeenCalledWith([
        "setupEngineEnginePowerIncrease",
        "setupEngineEnginePowerDecrease",
      ]);
      expect(decoded).toContain("binding-warning");
    });
  });

  describe("legacy flat-setting migration (#798)", () => {
    it("seeds dial.setting from a pre-merge encoder placement's flat setting", async () => {
      const ctx = dialContext("m1");
      const legacy = { setting: "throttle-shaping", direction: "decrease" };
      await appear(ctx, legacy);

      expect(ctx.setSettings).toHaveBeenCalledWith({ ...legacy, dial: { setting: "throttle-shaping" } });
    });

    it("does not seed for View modes", async () => {
      const ctx2 = dialContext("m3");
      await appear(ctx2, { setting: "view-engine-power" });

      expect(ctx2.setSettings).not.toHaveBeenCalled();
    });
  });

  describe("subscription lifecycle", () => {
    it("subscribes on appear and unsubscribes on disappear", async () => {
      const ctx = dialContext("s1");
      await appear(ctx, dialSettings({ setting: "engine-power" }));

      const sdk = (
        action as unknown as {
          sdkController: { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
        }
      ).sdkController;

      expect(sdk.subscribe).toHaveBeenCalled();

      await action.onWillDisappear(basicEvent(ctx, dialSettings({ setting: "engine-power" })) as never);

      expect(sdk.unsubscribe).toHaveBeenCalledWith("s1");
    });
  });
});
