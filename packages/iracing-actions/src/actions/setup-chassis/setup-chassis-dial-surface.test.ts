import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTriggerDescription, DialSettings, formatDialValue } from "./setup-chassis-dial-surface.js";
import { SetupChassis } from "./setup-chassis.js";

const {
  mockGetCurrentTelemetry,
  mockTapBinding,
  mockTapBindingSequence,
  mockIsBindingMissing,
  mockDualPressThreshold,
  globalListeners,
} = vi.hoisted(() => ({
  mockGetCurrentTelemetry: vi.fn<() => unknown>(() => null),
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockTapBindingSequence: vi.fn().mockResolvedValue(true),
  mockIsBindingMissing: vi.fn(() => false),
  mockDualPressThreshold: { value: 500 },
  globalListeners: [] as Array<() => void>,
}));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
    IconUpdateThrottle: class {
      schedule(_id: string, render: () => unknown): void {
        try {
          void Promise.resolve(render()).catch(() => {});
        } catch {
          // Swallow sync throws — matches the production render contract.
        }
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
      tapBindingSequence = mockTapBindingSequence;
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

describe("setup-chassis dial-surface pure helpers", () => {
  describe("formatDialValue", () => {
    it("formats readback settings as plain integers", () => {
      expect(formatDialValue("differential-preload", { dcDiffPreload: 3 } as never)).toBe("3");
      expect(formatDialValue("power-steering", { dcPowerSteering: 2 } as never)).toBe("2");
    });

    it("returns empty (identity-only) for the shocks", () => {
      expect(formatDialValue("lf-shock", { dcDiffPreload: 3 } as never)).toBe("");
      expect(formatDialValue("rr-shock", { dcDiffPreload: 3 } as never)).toBe("");
    });

    it("formats the pending pit-stop spring offset per the sim's display units (#953)", () => {
      expect(formatDialValue("lr-spring", { dpWeightJackerLeft: 2.54, DisplayUnits: 1 } as never)).toBe("3 mm");
      expect(formatDialValue("rr-spring", { dpWeightJackerRight: 3.175, DisplayUnits: 0 } as never)).toBe('0.125"');
    });

    it("shows the placeholder for a spring whose field the car does not expose (SRX one-sided case)", () => {
      expect(formatDialValue("lr-spring", { dpWeightJackerRight: 157, DisplayUnits: 1 } as never)).toBe("---");
    });

    it("shows the placeholder when a readback setting has no telemetry", () => {
      expect(formatDialValue("differential-preload", null)).toBe("---");
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the bound setting on rotate and offers no press gesture", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ setting: "differential-preload" }));

      expect(desc.rotate).toBe("Adjust Diff Preload");
      expect(desc.push).toBeUndefined();
    });

    it("names an identity-only setting", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ setting: "lf-shock" }));

      expect(desc.rotate).toBe("Adjust LF Shock");
    });

    it("names the pit-stop gesture on push (#953)", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ setting: "lr-spring", pressAction: "show-pit-stop-black-box" }),
      );

      expect(desc.push).toBe("Show Pit Stop Box");
    });

    it("names the spring-side toggle on push (#953)", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ setting: "lr-spring", pressAction: "toggle-spring-side" }),
      );

      expect(desc.push).toBe("Switch LR/RR");
    });
  });
});

describe("SetupChassis dial surface", () => {
  let action: SetupChassis;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockIsBindingMissing.mockReturnValue(false);
    mockGetCurrentTelemetry.mockReturnValue({ dcDiffPreload: 3, dcPowerSteering: 2 });
    globalListeners.length = 0;
    action = new SetupChassis();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function appear(ctx: DialContext, settings: Record<string, unknown> = {}) {
    await action.onWillAppear(basicEvent(ctx, settings) as never);
  }

  describe("Switch LR/RR Spring gesture (#953)", () => {
    it("accepts the gesture in the dial schema", () => {
      expect(DialSettings.parse({ pressAction: "toggle-spring-side" }).pressAction).toBe("toggle-spring-side");
      expect(DialSettings.parse({ longPressAction: "toggle-spring-side" }).longPressAction).toBe("toggle-spring-side");
    });

    it("flips the dial from LR to RR spring on a short press, preserving the keypad settings", async () => {
      const ctx = dialContext("d1");
      const settings = {
        setting: "differential-preload",
        dial: { setting: "lr-spring", pressAction: "toggle-spring-side" },
      };
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(ctx.setSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          setting: "differential-preload",
          dial: expect.objectContaining({ setting: "rr-spring", pressAction: "toggle-spring-side" }),
        }),
      );
    });

    it("re-renders the strip for the new side after the flip", async () => {
      const ctx = dialContext("d1");
      const settings = { dial: { setting: "lr-spring", pressAction: "toggle-spring-side" } };
      await appear(ctx, settings);
      ctx.setFeedback.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      const feedback = (ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box;
      const svg = decodeURIComponent(feedback);
      const litRight = /<polygon data-side="right"[^>]*>/.exec(svg)?.[0];
      expect(litRight).toBeDefined();
      expect(litRight).not.toContain("opacity");
      expect(svg).toContain("RR SPR");
    });

    it("toggles back on the next press without a settings echo", async () => {
      const ctx = dialContext("d1");
      const settings = { dial: { setting: "lr-spring", pressAction: "toggle-spring-side" } };
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);
      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      const lastWrite = ctx.setSettings.mock.calls.at(-1)?.[0] as { dial: { setting: string } };
      expect(lastWrite.dial.setting).toBe("lr-spring");
    });

    it("jumps to the LR spring when a non-spring setting is selected", async () => {
      const ctx = dialContext("d1");
      const settings = { dial: { setting: "differential-preload", tapAction: "toggle-spring-side" } };
      await appear(ctx, settings);

      await action.onTouchTap({ action: ctx, payload: { settings, hold: false } } as never);

      const lastWrite = ctx.setSettings.mock.calls.at(-1)?.[0] as { dial: { setting: string } };
      expect(lastWrite.dial.setting).toBe("lr-spring");
    });
  });

  describe("spring side-arrow markers (#953)", () => {
    it("renders both side triangles for a spring setting, lighting the edited side", async () => {
      const ctx = dialContext("d1");
      await appear(ctx, dialSettings({ setting: "lr-spring" }));

      const feedback = (ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box;
      const svg = decodeURIComponent(feedback);

      expect(svg).toContain('data-side="left"');
      expect(svg).toContain('data-side="right"');
    });

    it("renders no side markers for non-spring settings", async () => {
      const ctx = dialContext("d1");
      await appear(ctx, dialSettings({ setting: "differential-preload" }));

      const feedback = (ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box;

      expect(decodeURIComponent(feedback)).not.toContain("data-side");
    });
  });

  describe("Show Pit Stop Black Box gesture (#953)", () => {
    it("accepts the gesture in the dial schema", () => {
      expect(DialSettings.parse({ pressAction: "show-pit-stop-black-box" }).pressAction).toBe(
        "show-pit-stop-black-box",
      );
    });

    it("shows the Pit Stop black box on a short press via the atomic prime+target sequence", async () => {
      const ctx = dialContext("d1");
      const settings = dialSettings({ setting: "lr-spring", pressAction: "show-pit-stop-black-box" });
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBindingSequence).toHaveBeenCalledWith(["blackBoxLapTiming", "blackBoxPitStop"], 0);
    });

    it("shows the box on a touch tap", async () => {
      const ctx = dialContext("d1");
      const settings = dialSettings({ setting: "lr-spring", tapAction: "show-pit-stop-black-box" });
      await appear(ctx, settings);

      await action.onTouchTap({ action: ctx, payload: { settings, hold: false } } as never);

      expect(mockTapBindingSequence).toHaveBeenCalledWith(["blackBoxLapTiming", "blackBoxPitStop"], 0);
    });
  });

  describe("onDialRotate", () => {
    it("taps the increase binding on a clockwise turn", async () => {
      const ctx = dialContext("d1");
      const settings = dialSettings({ setting: "differential-preload" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisDifferentialPreloadIncrease");
    });

    it("adjusts an identity-only setting (a shock) too", async () => {
      const ctx = dialContext("d3");
      const settings = dialSettings({ setting: "lf-shock" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisLfShockDecrease");
    });
  });

  describe("press gestures (none configured)", () => {
    it("does nothing on a short press", async () => {
      const ctx = dialContext("p1");
      const settings = dialSettings({ setting: "differential-preload" });
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
      await appear(ctx, dialSettings({ setting: "differential-preload" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">PRELD<");
      expect(decoded).toContain(">3<");
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const ctx = dialContext("a811");
      await appear(
        ctx,
        dialSettings({
          setting: "differential-preload",
          colors: { borderColor: "#112233", backgroundColor: "#445566" },
        }),
      );

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain('stroke="#112233"');
      expect(decoded).toContain('fill="#445566"');
    });

    it("pushes a label-only strip for a shock (identity-only)", async () => {
      const ctx = dialContext("fb");
      await appear(ctx, dialSettings({ setting: "rf-shock" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">RF<");
      expect((decoded.match(/<text/g) ?? []).length).toBe(1);
    });

    it("pushes the two-line name icon as the deck-app dial image (#800)", async () => {
      const ctx = dialContext("f7");
      await appear(ctx, dialSettings({ setting: "differential-preload" }));

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">SETUP<");
      expect(img).toContain(">CHASSIS<");
    });

    it("dims the strip under the #612 warning when a rotation binding is missing", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f6");
      await appear(ctx, dialSettings({ setting: "differential-preload" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(mockIsBindingMissing).toHaveBeenCalledWith([
        "setupChassisDifferentialPreloadIncrease",
        "setupChassisDifferentialPreloadDecrease",
      ]);
      expect(decoded).toContain("binding-warning");
    });
  });

  describe("legacy flat-setting migration (#800)", () => {
    it("seeds dial.setting from a pre-merge encoder placement's flat setting", async () => {
      const ctx = dialContext("m1");
      const legacy = { setting: "rr-shock", direction: "decrease" };
      await appear(ctx, legacy);

      expect(ctx.setSettings).toHaveBeenCalledWith({ ...legacy, dial: { setting: "rr-shock" } });
    });

    it("does not seed for View modes", async () => {
      const ctx2 = dialContext("m3");
      await appear(ctx2, { setting: "view-diff-preload" });

      expect(ctx2.setSettings).not.toHaveBeenCalled();
    });
  });

  describe("subscription lifecycle", () => {
    it("subscribes on appear and unsubscribes on disappear", async () => {
      const ctx = dialContext("s1");
      await appear(ctx, dialSettings({ setting: "differential-preload" }));

      const sdk = (
        action as unknown as {
          sdkController: { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
        }
      ).sdkController;

      expect(sdk.subscribe).toHaveBeenCalled();

      await action.onWillDisappear(basicEvent(ctx, dialSettings({ setting: "differential-preload" })) as never);

      expect(sdk.unsubscribe).toHaveBeenCalledWith("s1");
    });
  });
});
