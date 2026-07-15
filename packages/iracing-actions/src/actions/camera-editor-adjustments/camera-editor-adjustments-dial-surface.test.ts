import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTriggerDescription,
  DialSettings,
  formatDialValue,
  GESTURE_ACTIONS,
  identityLabelScaleFor,
  renderRotaryArc,
} from "./camera-editor-adjustments-dial-surface.js";
import { CameraEditorAdjustments } from "./camera-editor-adjustments.js";

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
    // Unused by the dial surface, but the host action imports the keypad icon
    // helpers at module load — provide harmless stubs so the module resolves.
    assembleIcon: vi.fn(() => "data:image/svg+xml,keypad"),
    getGlobalBorderSettings: vi.fn(() => ({})),
    getGlobalColors: vi.fn(() => ({})),
    getGlobalGraphicSettings: vi.fn(() => ({})),
    getGlobalTitleSettings: vi.fn(() => ({})),
    resolveBorderSettings: vi.fn(() => ({})),
    resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
    resolveIconColors: vi.fn(() => ({})),
    resolveTitleSettings: vi.fn(() => ({ titleText: "" })),
  };
});

vi.mock("@iracedeck/icons/camera-editor-adjustments/latitude-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/latitude-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/longitude-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/longitude-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/altitude-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/altitude-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/yaw-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/yaw-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/pitch-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/pitch-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/fov-zoom-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/fov-zoom-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/key-step-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/key-step-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/vanish-x-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/vanish-x-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/vanish-y-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/vanish-y-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/blimp-radius-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/blimp-radius-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/blimp-velocity-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/blimp-velocity-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/mic-gain-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/mic-gain-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/auto-set-mic-gain-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/auto-set-mic-gain-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/f-number-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/f-number-decrease.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/focus-depth-increase.svg", () => ({ default: "<svg/>" }));
vi.mock("@iracedeck/icons/camera-editor-adjustments/focus-depth-decrease.svg", () => ({ default: "<svg/>" }));

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

describe("camera-editor-adjustments dial-surface pure helpers", () => {
  describe("formatDialValue", () => {
    it("is identity-only for every parameter (iRacing exposes no camera-tool telemetry)", () => {
      expect(formatDialValue("latitude", { anything: 3 } as never)).toBe("");
      expect(formatDialValue("focus-depth", null)).toBe("");
      expect(formatDialValue("mic-gain", { dcAnything: 9 } as never)).toBe("");
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the bound setting on rotate and offers no press gesture by default", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ setting: "latitude" }));

      expect(desc.rotate).toBe("Adjust Latitude");
      expect(desc.push).toBeUndefined();
    });

    it("names the Auto Mic Gain press gesture when configured, riding the long-press", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({
          setting: "yaw",
          pressAction: "auto-mic-gain",
          longPressAction: "auto-mic-gain",
        }),
      );

      expect(desc.rotate).toBe("Adjust Yaw");
      expect(desc.push).toBe("Auto Mic Gain (hold: Auto Mic Gain)");
      expect(desc.touch).toBeUndefined();
    });

    it("labels a camera-tool one-shot gesture on the trigger description (#804)", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ setting: "latitude", pressAction: "open-camera-tool", tapAction: "zoom-toggle" }),
      );

      expect(desc.push).toBe("Open Camera Tool");
      expect(desc.touch).toBe("Zoom Toggle");
    });
  });

  describe("GESTURE_ACTIONS", () => {
    it("offers Auto Mic Gain, every Camera Editor Controls one-shot, and None (#804)", () => {
      // Auto Set Mic Gain + 30 camera-tool one-shots + None = 32 options.
      expect(GESTURE_ACTIONS).toHaveLength(32);
      expect(GESTURE_ACTIONS).toContain("auto-mic-gain");
      expect(GESTURE_ACTIONS).toContain("none");

      // Spot-check the camera-tool one-shots reused verbatim from the sibling action.
      for (const id of ["open-camera-tool", "zoom-toggle", "load-car-camera"]) {
        expect(GESTURE_ACTIONS).toContain(id);
      }
    });
  });

  describe("identityLabelScaleFor", () => {
    it("keeps short names large and steps longer names down so they fit the frame", () => {
      expect(identityLabelScaleFor("Yaw")).toBe(0.18);
      expect(identityLabelScaleFor("Latitude")).toBe(0.18); // 8 chars
      expect(identityLabelScaleFor("Focus Depth")).toBe(0.16); // 11 chars
      expect(identityLabelScaleFor("Blimp Velocity")).toBe(0.14); // 14 chars (the longest)
    });

    it("never grows a longer name above a shorter one", () => {
      expect(identityLabelScaleFor("Blimp Velocity")).toBeLessThanOrEqual(identityLabelScaleFor("Yaw"));
    });
  });

  describe("renderRotaryArc", () => {
    it("draws a rounded, segmented arc in the given color with dimmed −/+ end glyphs", () => {
      const svg = renderRotaryArc("#3498db");

      expect(svg).toMatch(/<path[^>]*stroke="#3498db"/);
      expect(svg).toContain('stroke-linecap="round"');
      expect(svg).toContain('stroke-dasharray="3 10"');
      expect(svg).toMatch(/<text[^>]*fill-opacity="0.55"[^>]*>−<\/text>/);
      expect(svg).toMatch(/<text[^>]*fill-opacity="0.55"[^>]*>\+<\/text>/);
    });

    it("uses only resvg-safe features (no filters/masks/dominant-baseline)", () => {
      const svg = renderRotaryArc("#e74c3c");

      expect(svg).not.toContain("dominant-baseline");
      expect(svg).not.toContain("<filter");
      expect(svg).not.toContain("<mask");
    });
  });
});

describe("CameraEditorAdjustments dial surface", () => {
  let action: CameraEditorAdjustments;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockIsBindingMissing.mockReturnValue(false);
    mockGetCurrentTelemetry.mockReturnValue(null);
    globalListeners.length = 0;
    action = new CameraEditorAdjustments();
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
      const settings = dialSettings({ setting: "latitude" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("camEditLatitudeIncrease");
    });

    it("taps the decrease binding on a counter-clockwise turn", async () => {
      const ctx = dialContext("d2");
      const settings = dialSettings({ setting: "yaw" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("camEditYawDecrease");
    });

    it("resolves the binding per selected setting", async () => {
      const ctx = dialContext("d3");
      const settings = dialSettings({ setting: "focus-depth" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("camEditFocusDepthIncrease");
    });

    it("scales the number of taps by the coalesced tick magnitude", async () => {
      const ctx = dialContext("d4");
      const settings = dialSettings({ setting: "latitude" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 3) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(3);
      expect(mockTapBinding).toHaveBeenCalledWith("camEditLatitudeIncrease");
    });

    it("caps the taps per event so one fast flick can't burst unbounded", async () => {
      const ctx = dialContext("d5");
      const settings = dialSettings({ setting: "latitude" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 12) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(5);
    });

    it("ignores a zero-tick rotate event", async () => {
      const ctx = dialContext("d6");
      const settings = dialSettings({ setting: "latitude" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 0) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("press gestures", () => {
    it("fires Auto Mic Gain on a short press when configured", async () => {
      const ctx = dialContext("p1");
      const settings = dialSettings({ setting: "latitude", pressAction: "auto-mic-gain" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("camEditAutoSetMicGain");
    });

    it("fires a Camera Editor Controls one-shot on a short press when configured (#804)", async () => {
      const ctx = dialContext("p1c");
      const settings = dialSettings({ setting: "latitude", pressAction: "open-camera-tool" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("camCtrlOpenCameraTool");
    });

    it("fires a Camera Editor Controls one-shot on the long-press when configured (#804)", async () => {
      const ctx = dialContext("p3c");
      const settings = dialSettings({ setting: "latitude", longPressAction: "zoom-toggle" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("camCtrlZoomToggle");
    });

    it("does nothing on a short press by default (none)", async () => {
      const ctx = dialContext("p2");
      const settings = dialSettings({ setting: "latitude" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("fires the long-press action when held past the threshold", async () => {
      const ctx = dialContext("p3");
      const settings = dialSettings({ setting: "latitude", longPressAction: "auto-mic-gain" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("camEditAutoSetMicGain");
    });

    it("fires no gesture on a push+turn (rotated while pressed)", async () => {
      const ctx = dialContext("p4");
      const settings = dialSettings({ setting: "latitude", pressAction: "auto-mic-gain" });
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("camEditLatitudeIncrease");
      mockTapBinding.mockClear();

      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalledWith("camEditAutoSetMicGain");
    });
  });

  describe("onTouchTap", () => {
    it("fires the tap action on a short touch when configured", async () => {
      const ctx = dialContext("t1");
      const settings = dialSettings({ setting: "latitude", tapAction: "auto-mic-gain", longTouchAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("camEditAutoSetMicGain");
    });

    it("fires the long-touch action on a held touch", async () => {
      const ctx = dialContext("t2");
      const settings = dialSettings({ setting: "latitude", longTouchAction: "auto-mic-gain" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("camEditAutoSetMicGain");
    });

    it("fires a Camera Editor Controls one-shot on a tap when configured (#804)", async () => {
      const ctx = dialContext("t1c");
      const settings = dialSettings({ setting: "latitude", tapAction: "load-car-camera", longTouchAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("camCtrlLoadCarCamera");
    });

    it("does nothing when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("t3");
      const settings = dialSettings({ setting: "latitude", tapAction: "auto-mic-gain" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes the full mixed-case parameter name with the rotary arc (identity-only — no live value)", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, dialSettings({ setting: "latitude" }));

      expect(ctx.setFeedback).toHaveBeenCalled();
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      // Full name, not the old "LAT" abbreviation.
      expect(decoded).toContain(">Latitude<");
      // The rotary affordance: an arc path plus the −/+ end glyphs.
      expect(decoded).toContain("<path");
      expect(decoded).toContain(">−<");
      expect(decoded).toContain(">+<");
      // Identity-only: the name label + the two end glyphs, and no numeric value.
      expect((decoded.match(/<text/g) ?? []).length).toBe(3);
    });

    it("draws the rotary arc in the setting's accent color and scales long names down", async () => {
      const ctx = dialContext("f-arc");
      // latitude accent = #3498db.
      await appear(ctx, dialSettings({ setting: "latitude" }));
      const lat = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(lat).toMatch(/<path[^>]*stroke="#3498db"/);
      const latFont = Number(/<text[^>]*font-size="(\d+)"[^>]*>Latitude</.exec(lat)?.[1]);

      ctx.setFeedback.mockClear();
      await action.onDidReceiveSettings(basicEvent(ctx, dialSettings({ setting: "blimp-velocity" })) as never);
      const vel = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);
      const velFont = Number(/<text[^>]*font-size="(\d+)"[^>]*>Blimp Velocity</.exec(vel)?.[1]);

      expect(vel).toContain(">Blimp Velocity<");
      // "Blimp Velocity" (14) is scaled smaller than "Latitude" (8).
      expect(velFont).toBeLessThan(latFont);
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const ctx = dialContext("a811");
      await appear(
        ctx,
        dialSettings({
          setting: "latitude",
          colors: { borderColor: "#112233", backgroundColor: "#445566" },
        }),
      );

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain('stroke="#112233"');
      expect(decoded).toContain('fill="#445566"');
    });

    it("pushes the two-line name icon as the deck-app dial image (#804)", async () => {
      const ctx = dialContext("f7");
      await appear(ctx, dialSettings({ setting: "latitude" }));

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">CAM EDIT<");
      expect(img).toContain(">ADJUST<");
    });

    it("dims the strip under the #612 warning when a rotation binding is missing", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f6");
      await appear(ctx, dialSettings({ setting: "latitude" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(mockIsBindingMissing).toHaveBeenCalledWith(["camEditLatitudeIncrease", "camEditLatitudeDecrease"]);
      expect(decoded).toContain("binding-warning");
    });

    it("re-renders the box when the setting changes", async () => {
      const ctx = dialContext("f5");
      await appear(ctx, dialSettings({ setting: "latitude" }));
      ctx.setFeedback.mockClear();

      await action.onDidReceiveSettings(basicEvent(ctx, dialSettings({ setting: "pitch" })) as never);

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">Pitch<");
    });
  });

  describe("legacy flat-setting migration (#804)", () => {
    it("seeds dial.setting from a pre-merge encoder placement's flat adjustment and persists it", async () => {
      const ctx = dialContext("m1");
      const legacy = { adjustment: "focus-depth", direction: "decrease" };
      await appear(ctx, legacy);

      expect(ctx.setSettings).toHaveBeenCalledWith({ ...legacy, dial: { setting: "focus-depth" } });
    });

    it("does not seed for the non-rotation Auto Set Mic Gain adjustment", async () => {
      const ctx = dialContext("m2");
      await appear(ctx, { adjustment: "auto-set-mic-gain" });

      expect(ctx.setSettings).not.toHaveBeenCalled();
    });
  });

  describe("subscription lifecycle", () => {
    it("subscribes on appear and unsubscribes on disappear", async () => {
      const ctx = dialContext("s1");
      await appear(ctx, dialSettings({ setting: "latitude" }));

      const sdk = (
        action as unknown as {
          sdkController: { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
        }
      ).sdkController;

      expect(sdk.subscribe).toHaveBeenCalled();

      await action.onWillDisappear(basicEvent(ctx, dialSettings({ setting: "latitude" })) as never);

      expect(sdk.unsubscribe).toHaveBeenCalledWith("s1");
    });
  });
});
