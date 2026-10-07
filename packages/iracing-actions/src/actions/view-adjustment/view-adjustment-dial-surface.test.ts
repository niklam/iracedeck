import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTriggerDescription,
  DialSettings,
  formatDialValue,
  GESTURE_ACTIONS,
  ROTATION_SETTINGS,
} from "./view-adjustment-dial-surface.js";
import { ViewAdjustment } from "./view-adjustment.js";

const {
  mockGetCurrentTelemetry,
  mockTapBinding,
  mockIsBindingMissing,
  mockDualPressThreshold,
  globalListeners,
  mockBringPointerToSim,
} = vi.hoisted(() => ({
  mockGetCurrentTelemetry: vi.fn<() => unknown>(() => null),
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockIsBindingMissing: vi.fn(() => false),
  mockDualPressThreshold: { value: 500 },
  globalListeners: [] as Array<() => void>,
  mockBringPointerToSim: vi.fn(),
}));

vi.mock("../../shared/mouse-to-sim.js", () => ({
  bringPointerToSim: mockBringPointerToSim,
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

vi.mock("@iracedeck/settings", () => ({
  onGlobalSettingsChange: vi.fn((listener: () => void) => {
    globalListeners.push(listener);

    return vi.fn();
  }),
}));

const STRIP = { id: "sd-plus-strip", width: 200, height: 100 } as const;
const KNOB = { id: "stream-dock-knob", width: 176, height: 112 } as const;

function dialContext(id: string, canvas: typeof STRIP | typeof KNOB | null = STRIP) {
  return {
    id,
    isKey: () => false,
    isDial: () => true,
    dialCanvas: () => canvas,
    setDialCanvas: vi.fn().mockResolvedValue(undefined),
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

/** Dial settings under the `dial` root (#806). */
function dialSettings(dial: Record<string, unknown>) {
  return { dial };
}

describe("view-adjustment dial-surface pure helpers", () => {
  describe("formatDialValue", () => {
    it("returns empty (identity-only) for every setting — iRacing exposes no view telemetry", () => {
      expect(formatDialValue("fov")).toBe("");
      expect(formatDialValue("horizon")).toBe("");
      expect(formatDialValue("driver-height")).toBe("");
      expect(formatDialValue("ui-size")).toBe("");
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the bound setting on rotate and the Recenter VR press by default", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ setting: "fov" }));

      expect(desc.rotate).toBe("Adjust FOV");
      expect(desc.push).toBe("Recenter VR");
      expect(desc.touch).toBeUndefined();
      expect(desc.longTouch).toBeUndefined();
    });

    it("rides the long-press on push and maps the touch slots", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({
          setting: "driver-height",
          pressAction: "recenter-vr",
          longPressAction: "recenter-vr",
          tapAction: "recenter-vr",
          longTouchAction: "recenter-vr",
        }),
      );

      expect(desc.rotate).toBe("Adjust Driver Height");
      expect(desc.push).toBe("Recenter VR (hold: Recenter VR)");
      expect(desc.touch).toBe("Recenter VR");
      expect(desc.longTouch).toBe("Recenter VR");
    });

    it("names the Mouse to Sim gesture", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ setting: "fov", pressAction: "mouse-to-sim", tapAction: "mouse-to-sim" }),
      );

      expect(desc.push).toBe("Mouse to Sim");
      expect(desc.touch).toBe("Mouse to Sim");
    });

    it("offers no push when both press slots are none", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ setting: "ui-size", pressAction: "none", longPressAction: "none" }),
      );

      expect(desc.rotate).toBe("Adjust UI Size");
      expect(desc.push).toBeUndefined();
    });
  });

  describe("GESTURE_ACTIONS", () => {
    it("offers Recenter VR, Mouse to Sim, and None", () => {
      expect([...GESTURE_ACTIONS]).toEqual(["recenter-vr", "mouse-to-sim", "none"]);
    });

    it("does not offer Mouse to Sim as a rotation setting", () => {
      expect(ROTATION_SETTINGS as readonly string[]).not.toContain("mouse-to-sim");
    });
  });

  describe("DialSettings defaults", () => {
    it("defaults setting to fov and the press to Recenter VR, other slots to none", () => {
      const dial = DialSettings.parse({});

      expect(dial.setting).toBe("fov");
      expect(dial.pressAction).toBe("recenter-vr");
      expect(dial.longPressAction).toBe("none");
      expect(dial.tapAction).toBe("none");
      expect(dial.longTouchAction).toBe("none");
    });
  });
});

describe("ViewAdjustment dial surface", () => {
  let action: ViewAdjustment;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockIsBindingMissing.mockReturnValue(false);
    mockGetCurrentTelemetry.mockReturnValue(null);
    globalListeners.length = 0;
    action = new ViewAdjustment();
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
      const settings = dialSettings({ setting: "fov" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustFovIncrease");
    });

    it("taps the decrease binding on a counter-clockwise turn", async () => {
      const ctx = dialContext("d2");
      const settings = dialSettings({ setting: "fov" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustFovDecrease");
    });

    it("resolves the up/down binding names per selected setting", async () => {
      const ctx = dialContext("d3");
      const settings = dialSettings({ setting: "horizon" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustHorizonUp");
    });

    it("resolves the driver-height binding names", async () => {
      const ctx = dialContext("d3b");
      const settings = dialSettings({ setting: "driver-height" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustDriverHeightDown");
    });

    it("scales taps by tick magnitude on a fast clockwise spin", async () => {
      const ctx = dialContext("d4");
      const settings = dialSettings({ setting: "ui-size" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 3) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(3);
      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustUiSizeIncrease");
    });

    it("scales taps by tick magnitude on a fast counter-clockwise spin", async () => {
      const ctx = dialContext("d5");
      const settings = dialSettings({ setting: "fov" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -2) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(2);
      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustFovDecrease");
    });

    it("caps taps per rotate event at MAX_TAPS_PER_EVENT", async () => {
      const ctx = dialContext("d6");
      const settings = dialSettings({ setting: "fov" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 12) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(5);
      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustFovIncrease");
    });

    it("does nothing on a zero-tick rotate event", async () => {
      const ctx = dialContext("d7");
      const settings = dialSettings({ setting: "fov" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 0) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("press gestures", () => {
    it("recenters VR on a short press (the default press action)", async () => {
      const ctx = dialContext("p1");
      const settings = dialSettings({ setting: "fov", pressAction: "recenter-vr" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustRecenterVr");
    });

    it("brings the mouse to the sim when the press gesture is mouse-to-sim", async () => {
      const ctx = dialContext("p-mouse");
      const settings = dialSettings({ setting: "fov", pressAction: "mouse-to-sim" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();
      mockBringPointerToSim.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockBringPointerToSim).toHaveBeenCalledTimes(1);
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("fires the long-press action when held past the threshold", async () => {
      const ctx = dialContext("p2");
      const settings = dialSettings({ setting: "fov", pressAction: "none", longPressAction: "recenter-vr" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustRecenterVr");
    });

    it("fires no gesture on a push+turn (rotated while pressed)", async () => {
      const ctx = dialContext("p3");
      const settings = dialSettings({ setting: "fov", pressAction: "recenter-vr" });
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustFovIncrease");
      mockTapBinding.mockClear();

      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalledWith("viewAdjustRecenterVr");
    });

    it("does nothing when the press action is none", async () => {
      const ctx = dialContext("p4");
      const settings = dialSettings({ setting: "fov", pressAction: "none" });
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
      const settings = dialSettings({ setting: "fov", tapAction: "recenter-vr", longTouchAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustRecenterVr");
    });

    it("fires the long-touch action on a long touch", async () => {
      const ctx = dialContext("t2");
      const settings = dialSettings({ setting: "fov", tapAction: "none", longTouchAction: "recenter-vr" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustRecenterVr");
    });

    it("does nothing when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const ctx = dialContext("t3");
      const settings = dialSettings({ setting: "fov", tapAction: "recenter-vr" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes a label-only dash box (identity-only — no value)", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, dialSettings({ setting: "fov" }));

      expect(ctx.setDialCanvas).toHaveBeenCalled();
      const uri = ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string;

      expect(uri).toContain("data:image/svg+xml");
      const decoded = decodeURIComponent(uri);

      expect(decoded).toContain(">FOV<");
      // Identity-only: exactly one text node (the label), no value number.
      expect((decoded.match(/<text/g) ?? []).length).toBe(1);
    });

    it("labels each setting on its strip", async () => {
      const ctx = dialContext("f1b");
      await appear(ctx, dialSettings({ setting: "driver-height" }));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).toContain(">HEIGHT<");
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const ctx = dialContext("a811");
      await appear(
        ctx,
        dialSettings({
          setting: "fov",
          colors: { borderColor: "#112233", backgroundColor: "#445566" },
        }),
      );

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).toContain('stroke="#112233"');
      expect(decoded).toContain('fill="#445566"');
    });

    it("pushes the encoder trigger description on a dial", async () => {
      const ctx = dialContext("f2");
      await appear(ctx, dialSettings({ setting: "fov" }));

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
    });

    it("pushes the two-line name icon as the deck-app dial image (#806)", async () => {
      const ctx = dialContext("f7");
      await appear(ctx, dialSettings({ setting: "fov" }));

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">VIEW<");
      expect(img).toContain(">ADJUST<");
    });

    it("dims the strip under the #612 warning when a rotation binding is missing", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f6");
      await appear(ctx, dialSettings({ setting: "fov" }));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(mockIsBindingMissing).toHaveBeenCalledWith(["viewAdjustFovIncrease", "viewAdjustFovDecrease"]);
      expect(decoded).toContain("binding-warning");
    });

    it("re-renders the box and trigger description when the setting changes", async () => {
      const ctx = dialContext("f5");
      await appear(ctx, dialSettings({ setting: "fov" }));
      ctx.setDialCanvas.mockClear();
      ctx.setTriggerDescription.mockClear();

      await action.onDidReceiveSettings(basicEvent(ctx, dialSettings({ setting: "ui-size" })) as never);

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).toContain(">UI SIZE<");
    });

    it("pushes the strip box through setDialCanvas on the Stream Deck+ profile (#1013)", async () => {
      const ctx = dialContext("c1", STRIP);
      await appear(ctx, dialSettings({ setting: "fov" }));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).toContain('viewBox="0 0 200 100"');
      expect(decoded).toContain(">FOV<");
      expect(ctx.setFeedback).not.toHaveBeenCalled();
    });

    it("pushes the knob box on the Stream Dock profile and never a name card there", async () => {
      const ctx = dialContext("c2", KNOB);
      await appear(ctx, dialSettings({ setting: "fov" }));

      expect(ctx.setImage).not.toHaveBeenCalled();
      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls[0][0] as string);

      expect(decoded).toContain('viewBox="0 0 176 112"');
      expect(decoded).toContain(">FOV<");
      // Identity-only on the knob too: the label is the only text.
      expect((decoded.match(/<text/g) ?? []).length).toBe(1);
    });

    it("pushes nothing at all when the context has no dial canvas", async () => {
      const ctx = dialContext("c3", null);
      await appear(ctx, dialSettings({ setting: "fov" }));

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
      expect(ctx.setFeedback).not.toHaveBeenCalled();
      expect(ctx.setImage).not.toHaveBeenCalled();
    });
  });

  describe("extended gestures off (Mirabox / Ulanzi)", () => {
    it("still renders the knob, but pushes no trigger description and ignores touch", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const ctx = dialContext("x1", KNOB);
      const settings = dialSettings({ setting: "fov", tapAction: "recenter-vr" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      expect(ctx.setDialCanvas).toHaveBeenCalled();
      expect(ctx.setTriggerDescription).not.toHaveBeenCalled();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("classifies every release as a short press, however long the hold", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const ctx = dialContext("x2", KNOB);
      const settings = dialSettings({ setting: "fov", pressAction: "recenter-vr", longPressAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(2000);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustRecenterVr");
    });

    it("never fires a long-press action a knob cannot reach", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const ctx = dialContext("x3", KNOB);
      const settings = dialSettings({ setting: "fov", pressAction: "none", longPressAction: "recenter-vr" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(2000);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("legacy flat-setting migration (#806)", () => {
    it("seeds dial.setting from a pre-merge encoder placement's flat adjustment and persists it", async () => {
      const ctx = dialContext("m1");
      const legacy = { adjustment: "horizon", direction: "decrease" };
      await appear(ctx, legacy);

      expect(ctx.setSettings).toHaveBeenCalledWith({ ...legacy, dial: { setting: "horizon" } });
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, { ...legacy, dial: { setting: "horizon" } }, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustHorizonUp");
    });

    it("does not seed for recenter-vr (a press gesture, not a rotation value)", async () => {
      const ctx = dialContext("m2");
      await appear(ctx, { adjustment: "recenter-vr" });

      expect(ctx.setSettings).not.toHaveBeenCalled();
    });

    it("does not seed when a dial object is already persisted or settings are empty", async () => {
      const ctx1 = dialContext("m3");
      await appear(ctx1, { adjustment: "fov", dial: { setting: "ui-size" } });

      expect(ctx1.setSettings).not.toHaveBeenCalled();

      const ctx2 = dialContext("m4");
      await appear(ctx2, {});

      expect(ctx2.setSettings).not.toHaveBeenCalled();
    });
  });

  describe("global-settings refresh", () => {
    it("re-renders the strip when global settings change so the #612 warning tracks live bindings", async () => {
      const ctx = dialContext("g1");
      await appear(ctx, dialSettings({ setting: "fov" }));

      expect(globalListeners.length).toBeGreaterThan(0);
      ctx.setDialCanvas.mockClear();

      mockIsBindingMissing.mockReturnValue(true);

      for (const listener of globalListeners) listener();

      expect(ctx.setDialCanvas).toHaveBeenCalled();
      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).toContain("binding-warning");
    });
  });

  describe("active binding", () => {
    it("does not declare active bindings for dial instances (would bleed onto keypad buttons)", async () => {
      const ctx = dialContext("ab1");
      await appear(ctx, dialSettings({ setting: "fov" }));

      const setActiveBinding = (action as unknown as { setActiveBinding: ReturnType<typeof vi.fn> }).setActiveBinding;

      expect(setActiveBinding).not.toHaveBeenCalled();

      await action.onDidReceiveSettings(basicEvent(ctx, dialSettings({ setting: "horizon" })) as never);

      expect(setActiveBinding).not.toHaveBeenCalled();
    });
  });

  describe("subscription lifecycle", () => {
    it("subscribes on appear and unsubscribes on disappear", async () => {
      const ctx = dialContext("s1");
      await appear(ctx, dialSettings({ setting: "fov" }));

      const sdk = (
        action as unknown as {
          sdkController: { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
        }
      ).sdkController;

      expect(sdk.subscribe).toHaveBeenCalled();

      await action.onWillDisappear(basicEvent(ctx, dialSettings({ setting: "fov" })) as never);

      expect(sdk.unsubscribe).toHaveBeenCalledWith("s1");
    });
  });
});
