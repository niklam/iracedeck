import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTriggerDescription, DialSettings, renderBlackBoxStrip } from "./black-box-selector-dial-surface.js";
import { BlackBoxSelector } from "./black-box-selector.js";

const { mockTapBinding, mockIsBindingMissing, mockDualPressThreshold, mockRotatedClassifier, globalListeners } =
  vi.hoisted(() => ({
    mockTapBinding: vi.fn().mockResolvedValue(undefined),
    mockIsBindingMissing: vi.fn(() => false),
    mockDualPressThreshold: { value: 500 },
    mockRotatedClassifier: { pushTurn: true },
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
      sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn(() => null) };
      setKeyImage = vi.fn().mockResolvedValue(undefined);
      setRegenerateCallback = vi.fn();
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
      if (args.rotatedWhilePressed && mockRotatedClassifier.pushTurn) return "push-turn";

      return args.nowMs - args.pressStartMs >= (args.thresholdMs ?? 500) ? "long" : "short";
    },
    applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
    escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
    // Keypad render path (unused on the dial paths these tests drive).
    assembleIcon: vi.fn(() => "data:image/svg+xml,keypad"),
    getGlobalBorderSettings: vi.fn(() => ({})),
    getGlobalColors: vi.fn(() => ({})),
    getGlobalGraphicSettings: vi.fn(() => ({})),
    getGlobalTitleSettings: vi.fn(() => ({})),
    resolveBorderSettings: vi.fn(() => ({})),
    resolveGraphicSettings: vi.fn(() => ({})),
    resolveIconColors: vi.fn(() => ({})),
    resolveTitleSettings: vi.fn(() => ({ titleText: "" })),
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

function eventFor(action: DialContext, settings: Record<string, unknown> = {}) {
  return { action, payload: { settings } };
}

function touchEvent(action: DialContext, settings: Record<string, unknown>, hold = false) {
  return { action, payload: { settings, hold } };
}

function withDial(dial: Record<string, unknown>) {
  return { dial };
}

describe("black-box-selector dial-surface pure helpers", () => {
  describe("DialSettings defaults", () => {
    it("defaults pressBox to lap-timing and every gesture slot to none", () => {
      const parsed = DialSettings.parse({});

      expect(parsed.pressBox).toBe("lap-timing");
      expect(parsed.pressAction).toBe("none");
      expect(parsed.longPressAction).toBe("none");
      expect(parsed.tapAction).toBe("none");
      expect(parsed.longTouchAction).toBe("none");
    });

    it("fills defaults for a partially-specified dial (prefault)", () => {
      const parsed = DialSettings.parse({ pressBox: "fuel" });

      expect(parsed.pressBox).toBe("fuel");
      expect(parsed.pressAction).toBe("none");
    });
  });

  describe("buildTriggerDescription", () => {
    it("always labels the rotation as cycling black boxes", () => {
      const desc = buildTriggerDescription(DialSettings.parse({}));

      expect(desc.rotate).toBe("Cycle black boxes");
      expect(desc.push).toBeUndefined();
    });

    it("labels the press when Open Selected Box is configured", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ pressAction: "open-selected-box" }));

      expect(desc.push).toBe("Open selected box");
    });

    it("combines press and long-press labels", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ pressAction: "open-selected-box", longPressAction: "open-selected-box" }),
      );

      expect(desc.push).toBe("Open selected box (hold: Open selected box)");
    });
  });

  describe("renderBlackBoxStrip", () => {
    const colors = { border: "#d4a017", label: "#d4a017", value: "#d4a017", background: "#0d0d0d" };

    it("draws the BB badge and BLACK BOX wordmark (identity only)", () => {
      const svg = renderBlackBoxStrip({ colors, bindingMissing: false });

      expect(svg).toContain(">BB<");
      expect(svg).toContain(">BLACK BOX<");
      expect(svg).not.toContain("binding-warning");
    });

    it("applies the resolved colors", () => {
      const svg = renderBlackBoxStrip({
        colors: { border: "#112233", label: "#445566", value: "#445566", background: "#778899" },
        bindingMissing: false,
      });

      expect(svg).toContain('stroke="#112233"');
      expect(svg).toContain('fill="#778899"');
      expect(svg).toContain('fill="#445566"');
    });

    it("dims under the #612 warning when the rotation binding is missing", () => {
      const svg = renderBlackBoxStrip({ colors, bindingMissing: true });

      expect(svg).toContain("binding-warning");
    });
  });
});

describe("BlackBoxSelector dial surface", () => {
  let action: BlackBoxSelector;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockRotatedClassifier.pushTurn = true;
    mockIsBindingMissing.mockReturnValue(false);
    globalListeners.length = 0;
    action = new BlackBoxSelector();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function appear(ctx: DialContext, settings: Record<string, unknown> = {}) {
    await action.onWillAppear(eventFor(ctx, settings) as never);
  }

  describe("onDialRotate", () => {
    it("taps Cycle Next on a clockwise turn", async () => {
      const ctx = dialContext("d1");
      await appear(ctx, withDial({}));
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, withDial({}), 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("blackBoxCycleNext");
      expect(mockTapBinding).toHaveBeenCalledTimes(1);
    });

    it("taps Cycle Previous on a counter-clockwise turn", async () => {
      const ctx = dialContext("d2");
      await appear(ctx, withDial({}));
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, withDial({}), -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("blackBoxCyclePrevious");
    });

    it("scales taps by tick magnitude, capped at 5 per event", async () => {
      const ctx = dialContext("d3");
      await appear(ctx, withDial({}));
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, withDial({}), 8) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(5);
    });

    it("ignores a zero-tick event", async () => {
      const ctx = dialContext("d4");
      await appear(ctx, withDial({}));
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, withDial({}), 0) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("press gestures", () => {
    it("opens the selected box on a short press (Open Selected Box)", async () => {
      const ctx = dialContext("p1");
      const settings = withDial({ pressAction: "open-selected-box", pressBox: "fuel" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(eventFor(ctx, settings) as never);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("blackBoxFuel");
    });

    it("does nothing on a short press when the slot is None", async () => {
      const ctx = dialContext("p2");
      const settings = withDial({ pressAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(eventFor(ctx, settings) as never);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("fires the long-press gesture after the threshold", async () => {
      const ctx = dialContext("p3");
      const settings = withDial({ longPressAction: "open-selected-box", pressBox: "standings" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(eventFor(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("blackBoxStandings");
    });

    it("fires no press gesture after a push + turn", async () => {
      const ctx = dialContext("p4");
      const settings = withDial({ pressAction: "open-selected-box", pressBox: "fuel" });
      await appear(ctx, settings);

      await action.onDialDown(eventFor(ctx, settings) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never);
      mockTapBinding.mockClear();
      await action.onDialUp(eventFor(ctx, settings) as never);

      // The rotation already tapped Cycle Next; the release must add no box tap.
      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("touch gestures", () => {
    it("opens the selected box on a tap when configured", async () => {
      const ctx = dialContext("t1");
      const settings = withDial({ tapAction: "open-selected-box", pressBox: "tires" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchEvent(ctx, settings, false) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("blackBoxTires");
    });

    it("does nothing on a long touch set to None", async () => {
      const ctx = dialContext("t2");
      const settings = withDial({ longTouchAction: "none" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchEvent(ctx, settings, true) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes the identity strip on appear", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, withDial({}));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">BB<");
      expect(decoded).toContain(">BLACK BOX<");
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const ctx = dialContext("f2");
      await appear(ctx, withDial({ colors: { borderColor: "#112233", backgroundColor: "#445566" } }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain('stroke="#112233"');
      expect(decoded).toContain('fill="#445566"');
    });

    it("dims the strip when the Cycle bindings are missing (#612)", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f3");
      await appear(ctx, withDial({}));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(mockIsBindingMissing).toHaveBeenCalledWith(["blackBoxCycleNext", "blackBoxCyclePrevious"]);
      expect(decoded).toContain("binding-warning");
    });

    it("pushes the two-line BLACK BOX name icon as the deck-app dial image", async () => {
      const ctx = dialContext("f4");
      await appear(ctx, withDial({}));

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">BLACK<");
      expect(img).toContain(">BOX<");
    });
  });

  describe("__FEATURE_DIAL_FEEDBACK__ = false", () => {
    it("pushes no touch-strip feedback", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("g1");
      await appear(ctx, withDial({}));

      expect(ctx.setFeedback).not.toHaveBeenCalled();
    });

    it("runs no touch-tap gesture", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("g2");
      const settings = withDial({ tapAction: "open-selected-box", pressBox: "fuel" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchEvent(ctx, settings, false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("lifecycle", () => {
    it("drops the context on disappear so a later release does nothing", async () => {
      const ctx = dialContext("l1");
      const settings = withDial({ pressAction: "open-selected-box", pressBox: "fuel" });
      await appear(ctx, settings);

      await action.onDialDown(eventFor(ctx, settings) as never);
      await action.onWillDisappear(eventFor(ctx, settings) as never);
      mockTapBinding.mockClear();
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });
});
