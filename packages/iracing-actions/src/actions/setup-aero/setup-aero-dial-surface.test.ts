import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTriggerDescription,
  DialSettings,
  formatDialValue,
  renderAeroDialBoxSvg,
} from "./setup-aero-dial-surface.js";
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

describe("setup-aero dial-surface pure helpers", () => {
  describe("renderAeroDialBoxSvg", () => {
    it("draws the abbreviation, value, and accent border", () => {
      const svg = renderAeroDialBoxSvg({ width: 144, height: 144, color: "#3498db", abbr: "FRONT", value: "3" });

      expect(svg).toContain('stroke="#3498db"');
      expect(svg).toContain(">FRONT<");
      expect(svg).toContain(">3<");
    });

    it("renders label-only for an identity-only setting (qualifying tape)", () => {
      const svg = renderAeroDialBoxSvg({ width: 200, height: 100, color: "#9b59b6", abbr: "TAPE", value: "" });

      expect(svg).toContain(">TAPE<");
      expect((svg.match(/<text/g) ?? []).length).toBe(1);
    });

    it("draws the #612 warning overlay only when bindingMissing is set", () => {
      const withWarn = renderAeroDialBoxSvg({
        width: 200,
        height: 100,
        color: "#3498db",
        abbr: "FRONT",
        value: "3",
        bindingMissing: true,
      });

      expect(withWarn).toContain("binding-warning");
    });
  });

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

  describe("feedback rendering", () => {
    it("pushes the dash box with the live value on a readback setting", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, dialSettings({ setting: "front-wing" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">FRONT<");
      expect(decoded).toContain(">3<");
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
