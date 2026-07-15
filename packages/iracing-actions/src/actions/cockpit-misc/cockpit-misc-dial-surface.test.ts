import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTriggerDescription,
  DialSettings,
  formatDialValue,
  rotationKey,
  seedDialFromLegacySetting,
} from "./cockpit-misc-dial-surface.js";
import { CockpitMisc } from "./cockpit-misc.js";

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

/** Dial settings under the `dial` root (#805). */
function dialSettings(dial: Record<string, unknown>) {
  return { dial };
}

describe("cockpit-misc dial-surface pure helpers", () => {
  describe("formatDialValue", () => {
    it("shows the live page number from telemetry", () => {
      expect(formatDialValue("dash-page-1", { dcDashPage: 2 } as never)).toBe("2");
      expect(formatDialValue("dash-page-2", { dcDashPage2: 4 } as never)).toBe("4");
    });

    it("shows the placeholder when the car exposes no dash pages (field absent)", () => {
      expect(formatDialValue("dash-page-1", {} as never)).toBe("---");
      expect(formatDialValue("dash-page-2", { dcDashPage: 1 } as never)).toBe("---");
    });

    it("shows the placeholder when telemetry is unavailable", () => {
      expect(formatDialValue("dash-page-1", null)).toBe("---");
    });
  });

  describe("rotationKey", () => {
    it("resolves the shared increase/decrease binding for a dial setting", () => {
      expect(rotationKey("dash-page-1", "increase")).toBe("cockpitMiscDashPage1Increase");
      expect(rotationKey("dash-page-2", "decrease")).toBe("cockpitMiscDashPage2Decrease");
    });
  });

  describe("DialSettings defaults", () => {
    it("fully defaults an absent dial through the prefault schema", () => {
      expect(DialSettings.parse({})).toEqual({
        setting: "dash-page-1",
        pressAction: "none",
        longPressAction: "none",
        tapAction: "none",
        longTouchAction: "none",
        colors: { borderColor: "", labelColor: "", valueColor: "", backgroundColor: "" },
      });
    });
  });

  describe("seedDialFromLegacySetting (#805 migration)", () => {
    it("seeds dial.setting from a valid flat dash-page control when no dial object is persisted", () => {
      expect(seedDialFromLegacySetting({ control: "dash-page-2", direction: "decrease" })).toEqual({
        control: "dash-page-2",
        direction: "decrease",
        dial: { setting: "dash-page-2" },
      });
    });

    it("returns null when a dial object already exists", () => {
      expect(seedDialFromLegacySetting({ control: "dash-page-1", dial: {} })).toBeNull();
    });

    it("returns null for non-rotation controls (ffb-max-force is excluded; toggle-wipers has no rotation)", () => {
      expect(seedDialFromLegacySetting({ control: "ffb-max-force" })).toBeNull();
      expect(seedDialFromLegacySetting({ control: "toggle-wipers" })).toBeNull();
    });

    it("returns null for fresh or non-object settings", () => {
      expect(seedDialFromLegacySetting({})).toBeNull();
      expect(seedDialFromLegacySetting(undefined)).toBeNull();
      expect(seedDialFromLegacySetting(null)).toBeNull();
      expect(seedDialFromLegacySetting([1])).toBeNull();
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the bound dash page on rotate and rides the long-press on push", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({
          setting: "dash-page-1",
          pressAction: "toggle-wipers",
          longPressAction: "in-lap-mode",
        }),
      );

      expect(desc.rotate).toBe("Cycle Dash Page 1");
      expect(desc.push).toBe("Toggle Wipers (hold: In-Lap Mode)");
      expect(desc.touch).toBeUndefined();
      expect(desc.longTouch).toBeUndefined();
    });

    it("maps the touch slots and omits none slots", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({
          setting: "dash-page-2",
          pressAction: "none",
          longPressAction: "none",
          tapAction: "toggle-wipers",
          longTouchAction: "in-lap-mode",
        }),
      );

      expect(desc.rotate).toBe("Cycle Dash Page 2");
      expect(desc.push).toBeUndefined();
      expect(desc.touch).toBe("Toggle Wipers");
      expect(desc.longTouch).toBe("In-Lap Mode");
    });
  });
});

describe("CockpitMisc dial surface", () => {
  let action: CockpitMisc;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockIsBindingMissing.mockReturnValue(false);
    mockGetCurrentTelemetry.mockReturnValue({ dcDashPage: 2, dcDashPage2: 4 });
    globalListeners.length = 0;
    action = new CockpitMisc();
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
      const settings = dialSettings({ setting: "dash-page-1" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscDashPage1Increase");
    });

    it("taps the decrease binding on a counter-clockwise turn", async () => {
      const ctx = dialContext("d2");
      const settings = dialSettings({ setting: "dash-page-1" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscDashPage1Decrease");
    });

    it("resolves the binding per selected dash page", async () => {
      const ctx = dialContext("d3");
      const settings = dialSettings({ setting: "dash-page-2" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscDashPage2Increase");
    });

    it("scales taps by tick magnitude on a fast clockwise spin", async () => {
      const ctx = dialContext("d4");
      const settings = dialSettings({ setting: "dash-page-1" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 3) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(3);
      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscDashPage1Increase");
    });

    it("scales taps by tick magnitude on a fast counter-clockwise spin", async () => {
      const ctx = dialContext("d5");
      const settings = dialSettings({ setting: "dash-page-1" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -2) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(2);
      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscDashPage1Decrease");
    });

    it("caps taps at MAX_TAPS_PER_EVENT on a very fast spin", async () => {
      const ctx = dialContext("d6");
      const settings = dialSettings({ setting: "dash-page-1" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 12) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(5);
      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscDashPage1Increase");
    });

    it("dispatches no tap for a zero-tick rotate event", async () => {
      const ctx = dialContext("d7");
      const settings = dialSettings({ setting: "dash-page-1" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 0) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("press gestures", () => {
    it("fires the press action on a short press (toggle wipers)", async () => {
      const ctx = dialContext("p1");
      const settings = dialSettings({ setting: "dash-page-1", pressAction: "toggle-wipers" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscToggleWipers");
    });

    it("fires the long-press action when held past the threshold (in-lap mode)", async () => {
      const ctx = dialContext("p2");
      const settings = dialSettings({ setting: "dash-page-1", pressAction: "none", longPressAction: "in-lap-mode" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscInLapMode");
    });

    it("fires no gesture on a push+turn (rotated while pressed)", async () => {
      const ctx = dialContext("p3");
      const settings = dialSettings({ setting: "dash-page-1", pressAction: "toggle-wipers" });
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      // Rotate while pressed: still cycles the page, but guards the release.
      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscDashPage1Increase");
      mockTapBinding.mockClear();

      await action.onDialUp(basicEvent(ctx, settings) as never);

      // The press gesture (toggle wipers) must NOT fire after a push+turn.
      expect(mockTapBinding).not.toHaveBeenCalledWith("cockpitMiscToggleWipers");
    });

    it("does nothing when the press action is none", async () => {
      const ctx = dialContext("p4");
      const settings = dialSettings({ setting: "dash-page-1", pressAction: "none" });
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
      const settings = dialSettings({ setting: "dash-page-1", tapAction: "toggle-wipers", longTouchAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscToggleWipers");
    });

    it("fires the long-touch action on a long touch", async () => {
      const ctx = dialContext("t2");
      const settings = dialSettings({ setting: "dash-page-1", tapAction: "none", longTouchAction: "in-lap-mode" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, true) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscInLapMode");
    });

    it("does nothing when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("t3");
      const settings = dialSettings({ setting: "dash-page-1", tapAction: "toggle-wipers" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchTapEvent(ctx, settings, false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes the dash box as a single touch-strip pixmap on a dial", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, dialSettings({ setting: "dash-page-1" }));

      expect(ctx.setFeedback).toHaveBeenCalled();
      const feedback = ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string };

      expect(feedback.box).toContain("data:image/svg+xml");
      const decoded = decodeURIComponent(feedback.box);

      expect(decoded).toContain(">DASH 1<");
      expect(decoded).toContain(">2<"); // live page number from dcDashPage
    });

    it("shows --- on the strip when the car exposes no dash pages", async () => {
      mockGetCurrentTelemetry.mockReturnValue({});
      const ctx = dialContext("f0");
      await appear(ctx, dialSettings({ setting: "dash-page-1" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">DASH 1<");
      expect(decoded).toContain(">---<");
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const ctx = dialContext("a1");
      await appear(
        ctx,
        dialSettings({
          setting: "dash-page-1",
          colors: { borderColor: "#112233", backgroundColor: "#445566" },
        }),
      );

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain('stroke="#112233"'); // border override
      expect(decoded).toContain('fill="#445566"'); // background override, filling inside the border
    });

    it("pushes the encoder trigger description on a dial", async () => {
      const ctx = dialContext("f2");
      await appear(ctx, dialSettings({ setting: "dash-page-1" }));

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
    });

    it("pushes the two-line name icon as the deck-app dial image (#805)", async () => {
      const ctx = dialContext("f7");
      await appear(ctx, dialSettings({ setting: "dash-page-1" }));

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">COCKPIT<");
      expect(img).toContain(">MISC<");
    });

    it("throttles feedback to the change-render window so the setFeedback cap holds", async () => {
      const ctx = dialContext("f4");
      mockGetCurrentTelemetry.mockReturnValue({ dcDashPage: 2 });
      await appear(ctx, dialSettings({ setting: "dash-page-1" }));

      const onTick = (
        action as unknown as { sdkController: { subscribe: ReturnType<typeof vi.fn> } }
      ).sdkController.subscribe.mock.calls.at(-1)?.[1] as (telemetry: unknown) => void;
      ctx.setFeedback.mockClear();

      // Within the 100 ms window: the value changes but the feedback push is throttled.
      vi.advanceTimersByTime(50);
      mockGetCurrentTelemetry.mockReturnValue({ dcDashPage: 3 });
      onTick({ dcDashPage: 3 });

      expect(ctx.setFeedback).not.toHaveBeenCalled();

      // Past the window: the next change flushes one feedback push.
      vi.advanceTimersByTime(100);
      mockGetCurrentTelemetry.mockReturnValue({ dcDashPage: 4 });
      onTick({ dcDashPage: 4 });

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);
      // The flushed push carries the latest value (4), not the throttled-over one.
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">4<");
    });

    it("dims the strip under the #612 warning when a rotation binding is missing", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f6");
      await appear(ctx, dialSettings({ setting: "dash-page-1" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(mockIsBindingMissing).toHaveBeenCalledWith([
        "cockpitMiscDashPage1Increase",
        "cockpitMiscDashPage1Decrease",
      ]);
      expect(decoded).toContain("binding-warning");
    });

    it("re-renders the box and trigger description when the setting changes", async () => {
      const ctx = dialContext("f5");
      mockGetCurrentTelemetry.mockReturnValue({ dcDashPage: 2, dcDashPage2: 4 });
      await appear(ctx, dialSettings({ setting: "dash-page-1" }));
      ctx.setFeedback.mockClear();
      ctx.setTriggerDescription.mockClear();

      await action.onDidReceiveSettings(basicEvent(ctx, dialSettings({ setting: "dash-page-2" })) as never);

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">DASH 2<");
      expect(decoded).toContain(">4<");
    });
  });

  describe("legacy flat-control migration (#805)", () => {
    it("seeds dial.setting from a pre-surface encoder placement's flat control and persists it", async () => {
      const ctx = dialContext("m1");
      // Pre-#805 encoder placement: flat keypad settings, no dial root.
      const legacy = { control: "dash-page-2", direction: "decrease" };
      await appear(ctx, legacy);

      expect(ctx.setSettings).toHaveBeenCalledWith({ ...legacy, dial: { setting: "dash-page-2" } });
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, { ...legacy, dial: { setting: "dash-page-2" } }, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscDashPage2Increase");
    });

    it("does not seed when a dial object exists or the flat control is not a dash page", async () => {
      const ctx1 = dialContext("m2");
      await appear(ctx1, { control: "dash-page-1", dial: { setting: "dash-page-2" } });

      expect(ctx1.setSettings).not.toHaveBeenCalled();

      const ctx2 = dialContext("m3");
      await appear(ctx2, { control: "ffb-max-force" });

      expect(ctx2.setSettings).not.toHaveBeenCalled();

      const ctx3 = dialContext("m4");
      await appear(ctx3, {});

      expect(ctx3.setSettings).not.toHaveBeenCalled();
    });
  });

  describe("global-settings refresh", () => {
    it("re-renders the strip when global settings change so the #612 warning tracks live bindings", async () => {
      const ctx = dialContext("g1");
      await appear(ctx, dialSettings({ setting: "dash-page-1" }));

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
      await appear(ctx, dialSettings({ setting: "dash-page-1" }));

      const setActiveBinding = (action as unknown as { setActiveBinding: ReturnType<typeof vi.fn> }).setActiveBinding;

      expect(setActiveBinding).not.toHaveBeenCalled();

      await action.onDidReceiveSettings(basicEvent(ctx, dialSettings({ setting: "dash-page-2" })) as never);

      expect(setActiveBinding).not.toHaveBeenCalled();
    });
  });

  describe("subscription lifecycle", () => {
    it("subscribes on appear and unsubscribes on disappear", async () => {
      const ctx = dialContext("s1");
      await appear(ctx, dialSettings({ setting: "dash-page-1" }));

      const sdk = (
        action as unknown as {
          sdkController: { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
        }
      ).sdkController;

      expect(sdk.subscribe).toHaveBeenCalled();

      await action.onWillDisappear(basicEvent(ctx, dialSettings({ setting: "dash-page-1" })) as never);

      expect(sdk.unsubscribe).toHaveBeenCalledWith("s1");
    });
  });
});
