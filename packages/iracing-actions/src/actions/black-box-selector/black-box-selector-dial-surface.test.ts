import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeLateInput } from "../../shared/dial-late-input.test-support.js";
import { actionPressShapes, describePressShapes } from "../../shared/press-shape.test-support.js";
import {
  buildTriggerDescription,
  DialSettings,
  renderBlackBoxKnob,
  renderBlackBoxStrip,
  rotationWordmark,
} from "./black-box-selector-dial-surface.js";
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
      if (args.rotatedWhilePressed && mockRotatedClassifier.pushTurn) return "push-turn";

      return args.nowMs - args.pressStartMs >= (args.thresholdMs ?? 500) ? "long" : "short";
    },
    applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
    escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
    // Keypad render path (unused on the dial paths these tests drive).
    assembleIcon: vi.fn(() => "data:image/svg+xml,keypad"),
    getGlobalBorderSettings: vi.fn(() => ({})),
    getGlobalGraphicSettings: vi.fn(() => ({})),
    getGlobalTitleSettings: vi.fn(() => ({})),
    resolveBorderSettings: vi.fn(() => ({})),
    resolveGraphicSettings: vi.fn(() => ({})),
    resolveIconColors: vi.fn(() => ({})),
    resolveTitleSettings: vi.fn(() => ({ titleText: "" })),
  };
});

vi.mock("@iracedeck/settings", () => ({
  onGlobalSettingsChange: vi.fn((listener: () => void) => {
    globalListeners.push(listener);

    return vi.fn();
  }),
  getGlobalColors: vi.fn(() => ({})),
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

    it("accepts Toggle Box Size in every gesture slot (#1238)", () => {
      const parsed = DialSettings.parse({
        pressAction: "toggle-size",
        longPressAction: "toggle-size",
        tapAction: "toggle-size",
        longTouchAction: "toggle-size",
      });

      expect(parsed.pressAction).toBe("toggle-size");
      expect(parsed.longPressAction).toBe("toggle-size");
      expect(parsed.tapAction).toBe("toggle-size");
      expect(parsed.longTouchAction).toBe("toggle-size");
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

    it("labels Toggle Box Size on every gesture it is set on (#1238)", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({
          pressAction: "open-selected-box",
          longPressAction: "toggle-size",
          tapAction: "toggle-size",
          longTouchAction: "toggle-size",
        }),
      );

      expect(desc.rotate).toBe("Cycle black boxes");
      expect(desc.push).toBe("Open selected box (hold: Toggle box size)");
      expect(desc.touch).toBe("Toggle box size");
      expect(desc.longTouch).toBe("Toggle box size");
    });

    it("labels a push set to Toggle Box Size alone (#1238)", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ pressAction: "toggle-size" }));

      expect(desc.push).toBe("Toggle box size");
    });
  });

  describe("dial.rotation (#1585)", () => {
    it("parses a dial stored before the choice existed as cycling boxes", () => {
      expect(DialSettings.parse({}).rotation).toBe("boxes");
      expect(DialSettings.parse({ pressBox: "fuel", pressAction: "open-selected-box" }).rotation).toBe("boxes");
    });

    it.each(["boxes", "select-control", "adjust-control"] as const)("accepts rotation %s", (rotation) => {
      expect(DialSettings.parse({ rotation }).rotation).toBe(rotation);
    });

    it("rejects a rotation it does not know", () => {
      expect(DialSettings.safeParse({ rotation: "cycle" }).success).toBe(false);
    });

    it.each(["toggle-control", "next-control", "previous-control"] as const)(
      "accepts %s in every gesture slot",
      (gesture) => {
        const parsed = DialSettings.parse({
          pressAction: gesture,
          longPressAction: gesture,
          tapAction: gesture,
          longTouchAction: gesture,
        });

        expect([parsed.pressAction, parsed.longPressAction, parsed.tapAction, parsed.longTouchAction]).toEqual([
          gesture,
          gesture,
          gesture,
          gesture,
        ]);
      },
    );

    it.each([
      ["boxes", "Cycle black boxes"],
      ["select-control", "Select control"],
      ["adjust-control", "Adjust control"],
    ] as const)("labels a %s turn %s", (rotation, label) => {
      expect(buildTriggerDescription(DialSettings.parse({ rotation })).rotate).toBe(label);
    });

    it("labels the three selected-control gestures", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({
          rotation: "adjust-control",
          pressAction: "next-control",
          longPressAction: "previous-control",
          tapAction: "toggle-control",
          longTouchAction: "next-control",
        }),
      );

      expect(desc).toEqual({
        rotate: "Adjust control",
        push: "Select next control (hold: Select previous control)",
        touch: "Toggle selected control",
        longTouch: "Select next control",
      });
    });

    it.each([
      ["boxes", "BLACK BOX"],
      ["select-control", "SELECT"],
      ["adjust-control", "ADJUST"],
    ] as const)("names a %s turn %s on the dial screen", (rotation, wordmark) => {
      expect(rotationWordmark(rotation)).toBe(wordmark);
    });
  });

  describe("renderBlackBoxStrip", () => {
    const colors = { border: "#d4a017", label: "#d4a017", value: "#d4a017", background: "#0d0d0d" };

    it.each(["SELECT", "ADJUST"])("draws the %s wordmark centred under the badge (#1585)", (wordmark) => {
      const svg = renderBlackBoxStrip({ colors, bindingMissing: false, wordmark });

      expect(svg).toContain(">BB<");
      expect(svg).toContain(`<text x="100" y="78" text-anchor="middle"`);
      expect(svg).toContain(`>${wordmark}<`);
      expect(svg).not.toContain(">BLACK BOX<");
    });

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

  describe("renderBlackBoxKnob (#1013)", () => {
    const colors = { border: "#d4a017", label: "#d4a017", value: "#d4a017", background: "#0d0d0d" };

    it.each(["SELECT", "ADJUST"])("draws the %s wordmark centred under the badge (#1585)", (wordmark) => {
      const svg = renderBlackBoxKnob({ colors, bindingMissing: false, wordmark });

      expect(svg).toContain(">BB<");
      expect(svg).toContain(`<text x="88" y="90" text-anchor="middle"`);
      expect(svg).toContain(`>${wordmark}<`);
      expect(svg).not.toContain(">BLACK BOX<");
    });

    it("draws the same identity on the 176x112 knob screen", () => {
      const svg = renderBlackBoxKnob({ colors, bindingMissing: false });

      expect(svg).toContain('viewBox="0 0 176 112"');
      expect(svg).toContain(">BB<");
      expect(svg).toContain(">BLACK BOX<");
      expect(svg).not.toContain("binding-warning");
    });

    it("uses the knob box's panel frame (inset 5, stroke 6, radius 13)", () => {
      const svg = renderBlackBoxKnob({ colors, bindingMissing: false });

      expect(svg).toContain('<rect x="5" y="5" width="166" height="102" rx="13"');
      expect(svg).toContain('stroke-width="6"');
    });

    it("applies the resolved colors", () => {
      const svg = renderBlackBoxKnob({
        colors: { border: "#112233", label: "#445566", value: "#445566", background: "#778899" },
        bindingMissing: false,
      });

      expect(svg).toContain('stroke="#112233"');
      expect(svg).toContain('fill="#778899"');
      expect(svg).toContain('fill="#445566"');
    });

    it("dims under the #612 warning when the rotation binding is missing", () => {
      const svg = renderBlackBoxKnob({ colors, bindingMissing: true });

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

  describePressShapes({
    dialContext: (id) => dialContext(id),
    appear: (ctx, dial) => appear(ctx, withDial(dial)),
    ...actionPressShapes(() => action, withDial),
    gesture: "open-selected-box",
    setThresholdMs: (ms) => {
      mockDualPressThreshold.value = ms;
    },
    readsStoredSettings: false,
    keyCases: [
      { name: "a Direct key taps once on key down", settings: { mode: "direct" }, shape: { kind: "tap" } },
      {
        name: "Increment Selected Control repeats while held (#1585)",
        settings: { mode: "selected-control", control: "increment" },
        shape: { kind: "hold", thresholdMs: 500 },
      },
      {
        name: "Decrement Selected Control repeats while held (#1585)",
        settings: { mode: "selected-control", control: "decrement" },
        shape: { kind: "hold", thresholdMs: 500 },
      },
      {
        name: "Toggle Selected Control taps once (#1585)",
        settings: { mode: "selected-control", control: "toggle" },
        shape: { kind: "tap" },
      },
    ],
  });

  const lateInputSettings = withDial({
    pressBox: "fuel",
    pressAction: "open-selected-box",
    longPressAction: "open-selected-box",
    tapAction: "open-selected-box",
    longTouchAction: "open-selected-box",
  });

  describeLateInput({
    appear: async (id) => {
      const ctx = dialContext(id);
      await appear(ctx, lateInputSettings);

      return ctx;
    },
    disappear: (ctx) => action.onWillDisappear(eventFor(ctx, lateInputSettings) as never),
    rotate: (ctx) => action.onDialRotate(rotateEvent(ctx, lateInputSettings, 1) as never),
    down: (ctx) => action.onDialDown(eventFor(ctx, lateInputSettings) as never),
    up: (ctx) => action.onDialUp(eventFor(ctx, lateInputSettings) as never),
    touchTap: (ctx, hold) => action.onTouchTap(touchEvent(ctx, lateInputSettings, hold) as never),
    contexts: () => action["dialSurface"]["contextsState"],
    sent: (ctx) => ({
      tapBinding: mockTapBinding,
      setDialCanvas: ctx.setDialCanvas,
      setFeedback: ctx.setFeedback,
      setImage: ctx.setImage,
      setTriggerDescription: ctx.setTriggerDescription,
      setSettings: ctx.setSettings,
    }),
  });

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

  describe("Toggle Box Size gesture (#1238)", () => {
    const settings = withDial({
      pressBox: "fuel",
      pressAction: "toggle-size",
      longPressAction: "toggle-size",
      tapAction: "toggle-size",
      longTouchAction: "toggle-size",
    });

    async function appeared(id: string): Promise<DialContext> {
      const ctx = dialContext(id);
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      return ctx;
    }

    it("taps Toggle Black Box Size once on a short press", async () => {
      const ctx = await appeared("s1");

      await action.onDialDown(eventFor(ctx, settings) as never);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(mockTapBinding.mock.calls).toEqual([["blackBoxToggleSize"]]);
    });

    it("taps Toggle Black Box Size once on a long press", async () => {
      const ctx = await appeared("s2");

      await action.onDialDown(eventFor(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(mockTapBinding.mock.calls).toEqual([["blackBoxToggleSize"]]);
    });

    it("taps Toggle Black Box Size once on a tap of the display", async () => {
      const ctx = await appeared("s3");

      await action.onTouchTap(touchEvent(ctx, settings, false) as never);

      expect(mockTapBinding.mock.calls).toEqual([["blackBoxToggleSize"]]);
    });

    it("taps Toggle Black Box Size once on a long touch", async () => {
      const ctx = await appeared("s4");

      await action.onTouchTap(touchEvent(ctx, settings, true) as never);

      expect(mockTapBinding.mock.calls).toEqual([["blackBoxToggleSize"]]);
    });

    it("leaves rotation on the Cycle bindings", async () => {
      const ctx = await appeared("s5");

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding.mock.calls).toEqual([["blackBoxCycleNext"], ["blackBoxCyclePrevious"]]);
    });

    it("keeps the strip's #612 warning on the Cycle pair, not the size binding", async () => {
      await appeared("s6");

      expect(mockIsBindingMissing).toHaveBeenCalledWith(["blackBoxCycleNext", "blackBoxCyclePrevious"]);
      expect(mockIsBindingMissing).not.toHaveBeenCalledWith(expect.arrayContaining(["blackBoxToggleSize"]));
    });
  });

  describe("rotation choice (#1585)", () => {
    it.each([
      ["boxes", "blackBoxCycleNext", "blackBoxCyclePrevious"],
      ["select-control", "blackBoxSelectNextControl", "blackBoxSelectPreviousControl"],
      ["adjust-control", "blackBoxIncrementControl", "blackBoxDecrementControl"],
    ] as const)("a %s turn taps %s clockwise and %s counter-clockwise", async (rotation, cw, ccw) => {
      const ctx = dialContext(`r-${rotation}`);
      const settings = withDial({ rotation });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 2) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding.mock.calls).toEqual([[cw], [cw], [ccw]]);
    });

    it.each(["select-control", "adjust-control"] as const)(
      "caps a fast %s spin at 5 taps per event",
      async (rotation) => {
        const ctx = dialContext(`rc-${rotation}`);
        const settings = withDial({ rotation });
        await appear(ctx, settings);
        mockTapBinding.mockClear();

        await action.onDialRotate(rotateEvent(ctx, settings, -9) as never);

        expect(mockTapBinding).toHaveBeenCalledTimes(5);
      },
    );

    it("follows a rotation changed in the event's settings", async () => {
      const ctx = dialContext("r-change");
      await appear(ctx, withDial({}));
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, withDial({ rotation: "adjust-control" }), 1) as never);

      expect(mockTapBinding.mock.calls).toEqual([["blackBoxIncrementControl"]]);
    });

    it("degrades an unknown stored rotation to the dial defaults, so the dial still cycles boxes", async () => {
      const ctx = dialContext("r-garbage");
      const settings = withDial({ rotation: "sideways" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding.mock.calls).toEqual([["blackBoxCycleNext"]]);
    });

    it("pushes the rotation's label as the trigger description", async () => {
      const ctx = dialContext("r-desc");
      await appear(ctx, withDial({ rotation: "select-control", pressAction: "toggle-control" }));

      expect(ctx.setTriggerDescription).toHaveBeenLastCalledWith({
        rotate: "Select control",
        push: "Toggle selected control",
      });
    });
  });

  describe("selected-control gestures (#1585)", () => {
    const GESTURES = [
      ["toggle-control", "blackBoxToggleControl"],
      ["next-control", "blackBoxSelectNextControl"],
      ["previous-control", "blackBoxSelectPreviousControl"],
    ] as const;

    function allSlots(gesture: string) {
      return withDial({
        rotation: "adjust-control",
        pressAction: gesture,
        longPressAction: gesture,
        tapAction: gesture,
        longTouchAction: gesture,
      });
    }

    it.each(GESTURES)("%s taps %s once on a short press", async (gesture, key) => {
      const ctx = dialContext(`gp-${gesture}`);
      const settings = allSlots(gesture);
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(eventFor(ctx, settings) as never);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(mockTapBinding.mock.calls).toEqual([[key]]);
    });

    it.each(GESTURES)("%s taps %s once on a long press", async (gesture, key) => {
      const ctx = dialContext(`gl-${gesture}`);
      const settings = allSlots(gesture);
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(eventFor(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(mockTapBinding.mock.calls).toEqual([[key]]);
    });

    it.each(GESTURES)("%s taps %s once on a tap and on a long touch", async (gesture, key) => {
      const ctx = dialContext(`gt-${gesture}`);
      const settings = allSlots(gesture);
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchEvent(ctx, settings, false) as never);
      await action.onTouchTap(touchEvent(ctx, settings, true) as never);

      expect(mockTapBinding.mock.calls).toEqual([[key], [key]]);
    });

    it("walks and adjusts the open box from one dial: Adjust Control with Press on Next Control", async () => {
      const ctx = dialContext("g-walk");
      const settings = withDial({ rotation: "adjust-control", pressAction: "next-control" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);
      await action.onDialDown(eventFor(ctx, settings) as never);
      await action.onDialUp(eventFor(ctx, settings) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding.mock.calls).toEqual([
        ["blackBoxIncrementControl"],
        ["blackBoxSelectNextControl"],
        ["blackBoxDecrementControl"],
      ]);
    });
  });

  describe("strip and #612 dim follow the rotation (#1585)", () => {
    it.each([
      ["boxes", "BLACK BOX", ["blackBoxCycleNext", "blackBoxCyclePrevious"]],
      ["select-control", "SELECT", ["blackBoxSelectNextControl", "blackBoxSelectPreviousControl"]],
      ["adjust-control", "ADJUST", ["blackBoxIncrementControl", "blackBoxDecrementControl"]],
    ] as const)("a %s dial shows %s and warns on its own pair", async (rotation, wordmark, pair) => {
      mockIsBindingMissing.mockImplementation(((keys: string[]) => keys[0] === pair[0]) as never);
      const ctx = dialContext(`w-${rotation}`);
      await appear(ctx, withDial({ rotation }));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(mockIsBindingMissing).toHaveBeenCalledWith([...pair]);
      expect(decoded).toContain(`>${wordmark}<`);
      expect(decoded).toContain("binding-warning");
    });

    it("does not warn an Adjust Control dial for unset Cycle bindings", async () => {
      mockIsBindingMissing.mockImplementation(((keys: string[]) => keys.includes("blackBoxCycleNext")) as never);
      const ctx = dialContext("w-adjust-cycle-unset");
      await appear(ctx, withDial({ rotation: "adjust-control" }));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).not.toContain("binding-warning");
    });

    it("draws the rotation's wordmark on the knob screen too", async () => {
      const ctx = dialContext("w-knob", KNOB);
      await appear(ctx, withDial({ rotation: "select-control" }));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).toContain('viewBox="0 0 176 112"');
      expect(decoded).toContain(">SELECT<");
    });

    it("re-renders on a settings change that switches the rotation", async () => {
      const ctx = dialContext("w-switch");
      await appear(ctx, withDial({}));

      await action.onDidReceiveSettings(eventFor(ctx, withDial({ rotation: "adjust-control" })) as never);

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).toContain(">ADJUST<");
    });

    it("refreshes each dial against its own rotation's pair on a global-settings change", async () => {
      const boxes = dialContext("w-refresh-boxes");
      const adjust = dialContext("w-refresh-adjust");
      await appear(boxes, withDial({ rotation: "boxes" }));
      await appear(adjust, withDial({ rotation: "adjust-control" }));
      const boxesPushes = boxes.setDialCanvas.mock.calls.length;
      const adjustPushes = adjust.setDialCanvas.mock.calls.length;

      // Unbind only the Adjust pair: the Adjust dial dims, the Boxes dial is left alone.
      mockIsBindingMissing.mockImplementation(((keys: string[]) => keys.includes("blackBoxIncrementControl")) as never);

      for (const listener of globalListeners) listener();

      await vi.runAllTimersAsync();

      expect(boxes.setDialCanvas.mock.calls.length).toBe(boxesPushes);
      expect(adjust.setDialCanvas.mock.calls.length).toBe(adjustPushes + 1);
      expect(decodeURIComponent(adjust.setDialCanvas.mock.calls.at(-1)?.[0] as string)).toContain("binding-warning");
    });
  });

  describe("feedback rendering", () => {
    it("pushes the identity strip on appear", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, withDial({}));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).toContain(">BB<");
      expect(decoded).toContain(">BLACK BOX<");
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const ctx = dialContext("f2");
      await appear(ctx, withDial({ colors: { borderColor: "#112233", backgroundColor: "#445566" } }));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).toContain('stroke="#112233"');
      expect(decoded).toContain('fill="#445566"');
    });

    it("dims the strip when the Cycle bindings are missing (#612)", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f3");
      await appear(ctx, withDial({}));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(mockIsBindingMissing).toHaveBeenCalledWith(["blackBoxCycleNext", "blackBoxCyclePrevious"]);
      expect(decoded).toContain("binding-warning");
    });

    it("pushes the strip drawing through setDialCanvas on the Stream Deck+ profile (#1013)", async () => {
      const ctx = dialContext("f5", STRIP);
      await appear(ctx, withDial({}));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).toContain('viewBox="0 0 200 100"');
      expect(decoded).toContain(">BLACK BOX<");
      expect(ctx.setFeedback).not.toHaveBeenCalled();
    });

    it("draws a knob version of the identity strip on the Stream Dock profile (#1013)", async () => {
      const ctx = dialContext("k1", KNOB);
      await appear(ctx, withDial({}));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls[0][0] as string);

      expect(decoded).toContain('viewBox="0 0 176 112"');
      expect(decoded).toContain(">BB<");
      expect(decoded).toContain(">BLACK BOX<");
      expect(ctx.setImage).not.toHaveBeenCalled();
    });

    it("pushes nothing at all when the context has no dial canvas", async () => {
      const ctx = dialContext("f6", null);
      await appear(ctx, withDial({}));

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
      expect(ctx.setFeedback).not.toHaveBeenCalled();
      expect(ctx.setImage).not.toHaveBeenCalled();
    });

    it("pushes the two-line BLACK BOX name icon as the deck-app dial image", async () => {
      const ctx = dialContext("f4");
      await appear(ctx, withDial({}));

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">BLACK<");
      expect(img).toContain(">BOX<");
    });
  });

  describe("extended gestures off (Mirabox / Ulanzi)", () => {
    it("still renders the knob, but pushes no trigger description", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const ctx = dialContext("g1", KNOB);
      await appear(ctx, withDial({ pressAction: "open-selected-box" }));

      expect(ctx.setDialCanvas).toHaveBeenCalled();
      expect(ctx.setTriggerDescription).not.toHaveBeenCalled();
      expect(ctx.setFeedback).not.toHaveBeenCalled();
    });

    it("runs no touch-tap gesture", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const ctx = dialContext("g2", KNOB);
      const settings = withDial({ tapAction: "open-selected-box", pressBox: "fuel" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onTouchTap(touchEvent(ctx, settings, false) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("classifies every release as a short press, however long the hold", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const ctx = dialContext("g3", KNOB);
      const settings = withDial({ pressAction: "open-selected-box", longPressAction: "none", pressBox: "fuel" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(eventFor(ctx, settings) as never);
      vi.advanceTimersByTime(2000);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("blackBoxFuel");
    });

    it("never fires a long-press action a knob cannot reach", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const ctx = dialContext("g4", KNOB);
      const settings = withDial({ pressAction: "none", longPressAction: "open-selected-box", pressBox: "fuel" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(eventFor(ctx, settings) as never);
      vi.advanceTimersByTime(2000);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("fires nothing on a release after a rotation while pressed", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const ctx = dialContext("g5", KNOB);
      const settings = withDial({ pressAction: "open-selected-box", pressBox: "fuel" });
      await appear(ctx, settings);

      await action.onDialDown(eventFor(ctx, settings) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never);
      mockTapBinding.mockClear();
      await action.onDialUp(eventFor(ctx, settings) as never);

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
