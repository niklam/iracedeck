import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTriggerDescription, DialSettings, formatDialValue } from "./setup-aero-dial-surface.js";
import { SetupAero } from "./setup-aero.js";

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

function dialSettings(dial: Record<string, unknown>) {
  return { dial };
}

function touchTapEvent(action: DialContext, settings: Record<string, unknown>, hold: boolean) {
  return { action, payload: { settings, tapPos: [0, 0] as [number, number], hold } };
}

describe("setup-aero dial-surface pure helpers", () => {
  describe("formatDialValue", () => {
    it("formats readback wings as plain integers", () => {
      expect(formatDialValue("front-wing", { dcFrontWing: 3 } as never)).toBe("3");
      expect(formatDialValue("rear-wing", { dcRearWing: 5 } as never)).toBe("5");
    });

    it("returns empty (identity-only) for qualifying-tape", () => {
      expect(formatDialValue("qualifying-tape", { dcFrontWing: 3 } as never)).toBe("");
    });

    it("shows the placeholder when a readback wing has no telemetry", () => {
      expect(formatDialValue("front-wing", null)).toBe("---");
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the bound setting on rotate and the RF-brake gesture on push", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ setting: "front-wing", pressAction: "toggle-rf-brake" }),
      );

      expect(desc.rotate).toBe("Adjust Front Wing");
      expect(desc.push).toBe("Toggle RF Brake");
    });

    it("names the qualifying-tape setting and defaults to no gesture", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ setting: "qualifying-tape" }));

      expect(desc.rotate).toBe("Adjust Qualifying Tape");
      expect(desc.push).toBeUndefined();
    });
  });
});

describe("SetupAero dial surface", () => {
  let action: SetupAero;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockIsBindingMissing.mockReturnValue(false);
    mockGetCurrentTelemetry.mockReturnValue({ dcFrontWing: 3, dcRearWing: 5 });
    globalListeners.length = 0;
    action = new SetupAero();
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
      const settings = dialSettings({ setting: "front-wing" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroFrontWingIncrease");
    });

    it("adjusts an identity-only setting (qualifying tape) too", async () => {
      const ctx = dialContext("d3");
      const settings = dialSettings({ setting: "qualifying-tape" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroQualifyingTapeDecrease");
    });
  });

  describe("press gestures", () => {
    it("fires Toggle RF Brake on a short press when configured", async () => {
      const ctx = dialContext("p1");
      const settings = dialSettings({ setting: "front-wing", pressAction: "toggle-rf-brake" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroRfBrakeAttached");
    });

    it("fires the long-press action when held past the threshold", async () => {
      const ctx = dialContext("p2");
      const settings = dialSettings({ setting: "front-wing", pressAction: "none", longPressAction: "toggle-rf-brake" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroRfBrakeAttached");
    });

    it("does nothing on a short press by default (none)", async () => {
      const ctx = dialContext("p4");
      const settings = dialSettings({ setting: "front-wing" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("onTouchTap", () => {
    it("fires the tap action on a short touch when configured", async () => {
      const ctx = dialContext("t1");
      const settings = dialSettings({ setting: "front-wing", tapAction: "toggle-rf-brake", longTouchAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroRfBrakeAttached");
    });

    it("fires the long-touch action on a held touch", async () => {
      const ctx = dialContext("t2");
      const settings = dialSettings({ setting: "front-wing", tapAction: "none", longTouchAction: "toggle-rf-brake" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroRfBrakeAttached");
    });

    it("does nothing when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("t3");
      const settings = dialSettings({ setting: "front-wing", tapAction: "toggle-rf-brake" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes the dash box with the live value on a readback setting", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, dialSettings({ setting: "front-wing" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">FRONT<");
      expect(decoded).toContain(">3<");
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const ctx = dialContext("a811");
      await appear(
        ctx,
        dialSettings({
          setting: "front-wing",
          colors: { borderColor: "#112233", backgroundColor: "#445566" },
        }),
      );

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain('stroke="#112233"'); // border override
      expect(decoded).toContain('fill="#445566"'); // background override, filling inside the border
    });

    it("pushes a label-only strip for qualifying-tape (identity-only)", async () => {
      const ctx = dialContext("fb");
      await appear(ctx, dialSettings({ setting: "qualifying-tape" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">TAPE<");
      expect((decoded.match(/<text/g) ?? []).length).toBe(1);
    });

    it("pushes the two-line name icon as the deck-app dial image (#799)", async () => {
      const ctx = dialContext("f7");
      await appear(ctx, dialSettings({ setting: "front-wing" }));

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">SETUP<");
      expect(img).toContain(">AERO<");
    });

    it("dims the strip under the #612 warning when a rotation binding is missing", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f6");
      await appear(ctx, dialSettings({ setting: "front-wing" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(mockIsBindingMissing).toHaveBeenCalledWith(["setupAeroFrontWingIncrease", "setupAeroFrontWingDecrease"]);
      expect(decoded).toContain("binding-warning");
    });
  });

  describe("legacy flat-setting migration (#799)", () => {
    it("seeds dial.setting from a pre-merge encoder placement's flat setting", async () => {
      const ctx = dialContext("m1");
      const legacy = { setting: "rear-wing", direction: "decrease" };
      await appear(ctx, legacy);

      expect(ctx.setSettings).toHaveBeenCalledWith({ ...legacy, dial: { setting: "rear-wing" } });
    });

    it("does not seed for View modes or the rf-brake toggle", async () => {
      const ctx2 = dialContext("m3");
      await appear(ctx2, { setting: "view-front-wing" });

      expect(ctx2.setSettings).not.toHaveBeenCalled();

      const ctx3 = dialContext("m4");
      await appear(ctx3, { setting: "rf-brake-attached" });

      expect(ctx3.setSettings).not.toHaveBeenCalled();
    });
  });

  describe("subscription lifecycle", () => {
    it("subscribes on appear and unsubscribes on disappear", async () => {
      const ctx = dialContext("s1");
      await appear(ctx, dialSettings({ setting: "front-wing" }));

      const sdk = (
        action as unknown as {
          sdkController: { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
        }
      ).sdkController;

      expect(sdk.subscribe).toHaveBeenCalled();

      await action.onWillDisappear(basicEvent(ctx, dialSettings({ setting: "front-wing" })) as never);

      expect(sdk.unsubscribe).toHaveBeenCalledWith("s1");
    });
  });
});
