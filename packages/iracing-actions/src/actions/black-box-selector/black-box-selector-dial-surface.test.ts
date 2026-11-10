import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveDialBoxColors } from "../../shared/dial-box.js";
import { describeLateInput } from "../../shared/dial-late-input.test-support.js";
import { actionPressShapes, describePressShapes } from "../../shared/press-shape.test-support.js";
import {
  buildTriggerDescription,
  DialSettings,
  firingGestures,
  GESTURE_ACTIONS,
  pendingRotationPreview,
  renderAdjustControlKnob,
  renderAdjustControlPendingStrip,
  renderAdjustControlStrip,
  renderBlackBoxKnob,
  renderBlackBoxStrip,
  renderSelectControlKnob,
  renderSelectControlPendingStrip,
  renderSelectControlStrip,
  resolveGestures,
  ROTATION_GESTURE_DEFAULTS,
  ROTATIONS,
  SWITCHED_ROTATION,
} from "./black-box-selector-dial-surface.js";
import { BlackBoxSelector, BlackBoxSelectorSettings } from "./black-box-selector.js";

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
  // The REAL hold preview: its timer behaviour is under test, and a stub would only assert the stub.
  const dialGesture = await import("@iracedeck/deck-core/testing");

  return {
    createHoldPreview: dialGesture.createHoldPreview,
    NOOP_HOLD_PREVIEW: dialGesture.NOOP_HOLD_PREVIEW,
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

type Point = [number, number];

/** Each `<polygon>`'s vertices, in document order. */
function polygons(svg: string): Point[][] {
  return [...svg.matchAll(/<polygon points="([^"]+)"/g)].map(([, points]) =>
    points.split(" ").map((pair) => pair.split(",").map(Number) as Point),
  );
}

/**
 * The way each arrow triangle points, in document order: the apex is the vertex
 * off the line its other two share, so an arrow reads by its geometry rather
 * than by its coordinates.
 */
function arrowDirections(svg: string): string[] {
  return polygons(svg).map((triangle) => {
    for (let i = 0; i < 3; i++) {
      const apex = triangle[i];
      const [a, b] = triangle.filter((_, j) => j !== i);

      if (a[1] === b[1]) return apex[1] < a[1] ? "up" : "down";

      if (a[0] === b[0]) return apex[0] < a[0] ? "left" : "right";
    }

    throw new Error(`not an axis-aligned arrow: ${JSON.stringify(triangle)}`);
  });
}

/** A triangle's centroid. */
function centroid(triangle: Point[]): Point {
  return [
    (triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3,
    (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3,
  ];
}

/** The element names an SVG uses, its root included. */
function elementNames(svg: string): Set<string> {
  return new Set([...svg.matchAll(/<([a-zA-Z][\w-]*)/g)].map(([, name]) => name));
}

/** The shared pending bar's geometry and colour in a drawing, one entry per bar (#1120). */
function pendingBars(svg: string): Array<{ x: number; y: number; width: number; height: number; fill: string }> {
  return [
    ...svg.matchAll(
      /<rect data-pending-bar="true" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="[\d.]+" fill="([^"]+)"\/>/g,
    ),
  ].map(([, x, y, width, height, fill]) => ({
    x: Number(x),
    y: Number(y),
    width: Number(width),
    height: Number(height),
    fill,
  }));
}

/** The lowest and highest y any arrow reaches, its 2px stroke included. */
function arrowsYExtent(svg: string): [number, number] {
  const ys = polygons(svg).flatMap((triangle) => triangle.map(([, y]) => y));

  return [Math.min(...ys) - 1, Math.max(...ys) + 1];
}

describe("black-box-selector dial-surface pure helpers", () => {
  describe("DialSettings defaults", () => {
    it("defaults pressBox to lap-timing and the touch slots to none, and leaves Press and Long Press unset (#1585)", () => {
      const parsed = DialSettings.parse({});

      expect(parsed.pressBox).toBe("lap-timing");
      expect(parsed.tapAction).toBe("none");
      expect(parsed.longTouchAction).toBe("none");
      // No default is banked into these two: the rotation decides at read time.
      expect("pressAction" in parsed).toBe(false);
      expect("longPressAction" in parsed).toBe(false);
    });

    it("fills defaults for a partially-specified dial (prefault)", () => {
      const parsed = DialSettings.parse({ pressBox: "fuel" });

      expect(parsed.pressBox).toBe("fuel");
      expect(parsed.tapAction).toBe("none");
      expect(parsed.pressAction).toBeUndefined();
    });

    it("keeps a stored none in Press and Long Press, apart from an unset slot (#1585)", () => {
      const parsed = DialSettings.parse({ rotation: "select-control", pressAction: "none", longPressAction: "none" });

      expect(parsed.pressAction).toBe("none");
      expect(parsed.longPressAction).toBe("none");
    });

    it("leaves both slots unset through the action's whole settings, with no dial stored at all (#1585)", () => {
      const { dial } = BlackBoxSelectorSettings.parse({});

      expect(dial.rotation).toBe("boxes");
      expect("pressAction" in dial).toBe(false);
      expect("longPressAction" in dial).toBe(false);
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

  describe("renderBlackBoxKnob (#1013)", () => {
    const colors = { border: "#d4a017", label: "#d4a017", value: "#d4a017", background: "#0d0d0d" };

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

  describe("Select Control and Adjust Control arrow screens (#1585)", () => {
    const colors = { border: "#112233", label: "#445566", value: "#445566", background: "#778899" };
    const STRIP_FRAME = '<rect x="7" y="7" width="186" height="86" rx="10"';
    const KNOB_FRAME = '<rect x="5" y="5" width="166" height="102" rx="13"';

    const SCREENS = [
      ["renderSelectControlStrip", renderSelectControlStrip, "0 0 200 100", STRIP_FRAME, ["up", "down"]],
      ["renderAdjustControlStrip", renderAdjustControlStrip, "0 0 200 100", STRIP_FRAME, ["left", "right"]],
      ["renderSelectControlKnob", renderSelectControlKnob, "0 0 176 112", KNOB_FRAME, ["up", "down"]],
      ["renderAdjustControlKnob", renderAdjustControlKnob, "0 0 176 112", KNOB_FRAME, ["left", "right"]],
    ] as const;

    it.each(SCREENS)("%s draws its two arrows and no badge or word", (_name, render, _viewBox, _frame, directions) => {
      const svg = render({ colors, bindingMissing: false });

      expect(arrowDirections(svg)).toEqual(directions);
      expect(svg).not.toContain("<text");
      expect(svg).not.toContain(">BB<");
      expect(svg).not.toContain("binding-warning");
    });

    it.each(SCREENS)("%s sits in its screen's panel frame", (_name, render, viewBox, frame) => {
      const svg = render({ colors, bindingMissing: false });

      expect(svg).toContain(`viewBox="${viewBox}"`);
      expect(svg).toContain(`${frame} fill="#778899" stroke="#112233"`);
    });

    it.each(SCREENS)(
      "%s draws its arrows like the d-pad key icons: filled, 2px round-joined, in the label colour",
      (_name, render) => {
        const svg = render({ colors, bindingMissing: false });
        const arrows = [...svg.matchAll(/<polygon [^>]*\/>/g)].map(([el]) => el);

        expect(arrows).toHaveLength(2);

        for (const el of arrows) {
          expect(el).toContain('fill="#445566" stroke="#445566" stroke-width="2" stroke-linejoin="round"');
          expect(el).not.toContain("opacity");
        }
      },
    );

    it.each(SCREENS)("%s puts the muted centre dot midway between the arrows", (_name, render) => {
      const svg = render({ colors, bindingMissing: false });
      const dot = /<circle cx="([\d.]+)" cy="([\d.]+)" r="[\d.]+" ([^>]*)\/>/.exec(svg);
      const [first, second] = polygons(svg).map(centroid);

      expect(dot?.[3]).toBe('fill="#445566" stroke="#445566" stroke-width="2" opacity="0.35"');
      expect(Number(dot?.[1])).toBeCloseTo((first[0] + second[0]) / 2);
      expect(Number(dot?.[2])).toBeCloseTo((first[1] + second[1]) / 2);
    });

    it.each(SCREENS)("%s draws only shapes the deck renderers support", (_name, render) => {
      const svg = render({ colors, bindingMissing: false });

      expect([...elementNames(svg)].sort()).toEqual(["circle", "polygon", "rect", "svg"]);
    });

    it.each(SCREENS)(
      "%s dims its arrows under the #612 warning, leaving the frame",
      (_name, render, _viewBox, frame) => {
        const svg = render({ colors, bindingMissing: true });

        // The test double appends the marker to the content it wraps, so the frame comes before the arrows and it after.
        expect(svg).toContain("<binding-warning/></svg>");
        expect(svg.indexOf(frame)).toBeLessThan(svg.indexOf("<polygon"));
      },
    );
  });

  describe("pendingRotationPreview (#1120, #1585)", () => {
    it.each([
      ["select-control", "adjust-control"],
      ["adjust-control", "select-control"],
    ] as const)("previews the switch from %s to %s for an unset Long Press, which defaults to it", (from, to) => {
      expect(pendingRotationPreview(DialSettings.parse({ rotation: from }))).toBe(to);
    });

    it.each(["select-control", "adjust-control"] as const)(
      "previews the switch table's target for an explicit Switch Select / Adjust on a %s dial",
      (rotation) => {
        const dial = DialSettings.parse({ rotation, longPressAction: "switch-rotation" });

        // The very table the switch reads, so the promise is what the release does.
        expect(pendingRotationPreview(dial)).toBe(SWITCHED_ROTATION[rotation]);
      },
    );

    it.each([undefined, "switch-rotation"])(
      "previews nothing on a dial that cycles boxes (Long Press %s), where the switch is a no-op",
      (longPressAction) => {
        expect(pendingRotationPreview(DialSettings.parse({ rotation: "boxes", longPressAction }))).toBeNull();
        expect(pendingRotationPreview(DialSettings.parse({ longPressAction }))).toBeNull();
      },
    );

    it.each(GESTURE_ACTIONS.filter((gesture) => gesture !== "switch-rotation"))(
      "previews nothing when the Long Press is %s",
      (longPressAction) => {
        for (const rotation of ROTATIONS) {
          expect(pendingRotationPreview(DialSettings.parse({ rotation, longPressAction }))).toBeNull();
        }
      },
    );
  });

  describe("hold-preview strips (#1120, #1585)", () => {
    const colors = { border: "#112233", label: "#445566", value: "#778800", background: "#778899" };
    const STRIP_FRAME = '<rect x="7" y="7" width="186" height="86" rx="10"';
    // The panel's inner edge: the 9px border is centred on the 7px inset.
    const PANEL_TOP = 7 + 9 / 2;
    const PANEL_BOTTOM = 100 - PANEL_TOP;

    const PREVIEWS = [
      // Held on an Adjust dial: the switch goes to Select, so its up and down arrows.
      ["renderSelectControlPendingStrip", renderSelectControlPendingStrip, renderSelectControlStrip, ["up", "down"]],
      // Held on a Select dial: the switch goes to Adjust, so its left and right arrows.
      ["renderAdjustControlPendingStrip", renderAdjustControlPendingStrip, renderAdjustControlStrip, ["left", "right"]],
    ] as const;

    it.each(PREVIEWS)("%s draws the target's arrows over one pending bar", (_name, render, _normal, directions) => {
      const svg = render({ colors, bindingMissing: false });

      expect(arrowDirections(svg)).toEqual(directions);
      expect(pendingBars(svg)).toHaveLength(1);
      expect(svg).not.toContain("<text");
      expect(svg).not.toContain("binding-warning");
    });

    it.each(PREVIEWS)("%s sits in the strip's panel frame", (_name, render) => {
      const svg = render({ colors, bindingMissing: false });

      expect(svg).toContain('viewBox="0 0 200 100"');
      expect(svg).toContain(`${STRIP_FRAME} fill="#778899" stroke="#112233"`);
    });

    it.each(PREVIEWS)("%s centres the bar under the arrows in their colour, inside the panel", (_name, render) => {
      const svg = render({ colors, bindingMissing: false });
      const [bar] = pendingBars(svg);
      const [top, bottom] = arrowsYExtent(svg);

      expect(bar.fill).toBe("#445566");
      expect(bar.x + bar.width / 2).toBe(100);
      expect(bar.y).toBeGreaterThan(bottom);
      expect(bar.y + bar.height).toBeLessThanOrEqual(PANEL_BOTTOM);
      expect(top).toBeGreaterThanOrEqual(PANEL_TOP);
    });

    it.each(PREVIEWS)("%s nudges the arrows up from the normal strip's", (_name, render, normal) => {
      const [previewTop, previewBottom] = arrowsYExtent(render({ colors, bindingMissing: false }));
      const [normalTop, normalBottom] = arrowsYExtent(normal({ colors, bindingMissing: false }));

      expect((previewTop + previewBottom) / 2).toBeLessThan((normalTop + normalBottom) / 2);
    });

    it.each(PREVIEWS)("%s keeps the arrow style and the muted centre dot midway", (_name, render) => {
      const svg = render({ colors, bindingMissing: false });
      const arrows = [...svg.matchAll(/<polygon [^>]*\/>/g)].map(([el]) => el);
      const dot = /<circle cx="([\d.]+)" cy="([\d.]+)" r="[\d.]+" ([^>]*)\/>/.exec(svg);
      const [first, second] = polygons(svg).map(centroid);

      expect(arrows).toHaveLength(2);

      for (const el of arrows) {
        expect(el).toContain('fill="#445566" stroke="#445566" stroke-width="2" stroke-linejoin="round"');
      }

      expect(dot?.[3]).toBe('fill="#445566" stroke="#445566" stroke-width="2" opacity="0.35"');
      expect(Number(dot?.[1])).toBeCloseTo((first[0] + second[0]) / 2);
      expect(Number(dot?.[2])).toBeCloseTo((first[1] + second[1]) / 2);
    });

    it.each(PREVIEWS)("%s draws only shapes the deck renderers support", (_name, render) => {
      expect([...elementNames(render({ colors, bindingMissing: false }))].sort()).toEqual([
        "circle",
        "polygon",
        "rect",
        "svg",
      ]);
    });

    it.each(PREVIEWS)("%s dims the arrows and the bar under the #612 warning, leaving the frame", (_name, render) => {
      const svg = render({ colors, bindingMissing: true });

      // The test double appends the marker to the content it wraps: frame, then arrows and bar, then it.
      expect(svg).toContain("<binding-warning/></svg>");
      expect(svg.indexOf(STRIP_FRAME)).toBeLessThan(svg.indexOf("<polygon"));
      expect(svg.indexOf("data-pending-bar")).toBeLessThan(svg.indexOf("<binding-warning/>"));
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
    // The surface persists settings plugin-side, so its release and touch read
    // the settings its context stored, not the input event's (rule 10, #1585).
    readsStoredSettings: true,
    // No key declares a shape, so every key is the wrapper's tap, the repeating
    // Increment / Decrement included: a repeat's steps are their own feedback (#269).
    keyCases: [
      { name: "a Direct key: no keyPressShape, so the wrapper's tap", settings: { mode: "direct" }, shape: undefined },
      {
        name: "Increment Selected Control, which repeats: the wrapper's tap (#1585)",
        settings: { mode: "selected-control", control: "increment" },
        shape: undefined,
      },
      {
        name: "Decrement Selected Control, which repeats: the wrapper's tap (#1585)",
        settings: { mode: "selected-control", control: "decrement" },
        shape: undefined,
      },
      {
        name: "Toggle Selected Control: the wrapper's tap (#1585)",
        settings: { mode: "selected-control", control: "toggle" },
        shape: undefined,
      },
    ],
  });

  // Every slot acts, and Switch Select / Adjust is on the release and the long
  // touch, so a late event is also held to writing no settings (#1585).
  const lateInputSettings = withDial({
    rotation: "select-control",
    pressBox: "fuel",
    pressAction: "switch-rotation",
    longPressAction: "switch-rotation",
    tapAction: "open-selected-box",
    longTouchAction: "switch-rotation",
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

    it("turns the rotation its context stored, not one an input event's settings carry (rule 10)", async () => {
      const ctx = dialContext("r-change");
      await appear(ctx, withDial({}));
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, withDial({ rotation: "adjust-control" }), 1) as never);

      expect(mockTapBinding.mock.calls).toEqual([["blackBoxCycleNext"]]);
    });

    it("follows a rotation delivered through didReceiveSettings", async () => {
      const ctx = dialContext("r-delivered");
      await appear(ctx, withDial({}));
      await action.onDidReceiveSettings(eventFor(ctx, withDial({ rotation: "adjust-control" })) as never);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, withDial({}), 1) as never);

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
      await appear(
        ctx,
        withDial({ rotation: "select-control", pressAction: "toggle-control", longPressAction: "none" }),
      );

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

    it.each(GESTURES)("logs %s at info as the event alone, and names the gesture only at debug", async (gesture) => {
      const ctx = dialContext(`glog-${gesture}`);
      const settings = allSlots(gesture);
      await appear(ctx, settings);
      const info = action["logger"].info as ReturnType<typeof vi.fn>;
      const debug = action["logger"].debug as ReturnType<typeof vi.fn>;
      info.mockClear();
      debug.mockClear();

      await action.onDialDown(eventFor(ctx, settings) as never);
      await action.onDialUp(eventFor(ctx, settings) as never);

      // logging.md: an info line says what happened, with no values; the value goes to debug.
      expect(info.mock.calls).toEqual([["Black box dial pressed"], ["Black box dial sent a selected-control press"]]);
      expect(debug).toHaveBeenCalledWith(`Selected-control press: ${gesture}`);
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

  describe("Switch Select / Adjust (#1585)", () => {
    const PAIRS = {
      "select-control": ["blackBoxSelectNextControl", "blackBoxSelectPreviousControl"],
      "adjust-control": ["blackBoxIncrementControl", "blackBoxDecrementControl"],
    } as const;
    const ARROWS = { "select-control": ["up", "down"], "adjust-control": ["left", "right"] } as const;
    const LABELS = { "select-control": "Select control", "adjust-control": "Adjust control" } as const;

    type Switchable = keyof typeof PAIRS;

    /** The whole stored settings of a dial: a keypad half the write must carry over untouched, and the dial half. */
    function stored(dial: Record<string, unknown>) {
      return { mode: "next", blackBox: "fuel", flagsOverlay: true, dial };
    }

    function lastCanvas(ctx: DialContext): string {
      return decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);
    }

    async function press(ctx: DialContext, settings: Record<string, unknown>, holdMs = 0) {
      await action.onDialDown(eventFor(ctx, settings) as never);
      vi.advanceTimersByTime(holdMs);
      await action.onDialUp(eventFor(ctx, settings) as never);
    }

    it("swaps Select Control and Adjust Control, and leaves a boxes dial alone", () => {
      expect(SWITCHED_ROTATION).toEqual({ "select-control": "adjust-control", "adjust-control": "select-control" });
    });

    it.each([
      ["select-control", "adjust-control"],
      ["adjust-control", "select-control"],
    ] as const)("a press on a %s dial switches it to %s and persists that", async (from, to) => {
      const ctx = dialContext(`sw-${from}`);
      const settings = stored({ rotation: from, pressAction: "switch-rotation" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();
      ctx.setDialCanvas.mockClear();
      ctx.setTriggerDescription.mockClear();

      await press(ctx, settings);

      // The RAW settings with only the rotation changed: the keypad half is
      // carried over, and no schema default is banked into a key nobody set.
      expect(ctx.setSettings.mock.calls).toEqual([
        [
          {
            mode: "next",
            blackBox: "fuel",
            flagsOverlay: true,
            dial: { rotation: to, pressAction: "switch-rotation" },
          },
        ],
      ]);
      // The switch itself sends nothing to the sim.
      expect(mockTapBinding).not.toHaveBeenCalled();
      // The strip and the trigger description show the new rotation at once.
      expect(arrowDirections(lastCanvas(ctx))).toEqual(ARROWS[to]);
      expect(ctx.setTriggerDescription).toHaveBeenLastCalledWith(expect.objectContaining({ rotate: LABELS[to] }));
    });

    it.each([
      ["select-control", "adjust-control"],
      ["adjust-control", "select-control"],
    ] as const)("logs a switch from %s at info as the event alone, and both Modes only at debug", async (from, to) => {
      const ctx = dialContext(`sw-log-${from}`);
      const settings = stored({ rotation: from, pressAction: "switch-rotation" });
      await appear(ctx, settings);
      const info = action["logger"].info as ReturnType<typeof vi.fn>;
      const debug = action["logger"].debug as ReturnType<typeof vi.fn>;
      info.mockClear();
      debug.mockClear();

      await press(ctx, settings);

      // logging.md: an info line says what happened, with no values; the rotations go to debug.
      expect(info.mock.calls).toEqual([["Black box dial pressed"], ["Black box dial switched rotation"]]);
      expect(debug).toHaveBeenCalledWith(`Switch Select / Adjust: ${from} → ${to}`);
    });

    it("turns the new pair after a switch, though the events still carry the old rotation", async () => {
      const ctx = dialContext("sw-stale");
      const settings = stored({ rotation: "select-control", pressAction: "switch-rotation" });
      await appear(ctx, settings);
      await press(ctx, settings);
      mockTapBinding.mockClear();

      // The host has not echoed the write: this payload is the pre-switch one.
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding.mock.calls).toEqual([[PAIRS["adjust-control"][0]], [PAIRS["adjust-control"][1]]]);
    });

    it("moves the #612 dim to the new rotation's pair", async () => {
      const ctx = dialContext("sw-warn");
      const settings = stored({ rotation: "select-control", pressAction: "switch-rotation" });
      await appear(ctx, settings);
      mockIsBindingMissing.mockImplementation(((keys: string[]) => keys.includes("blackBoxIncrementControl")) as never);

      expect(lastCanvas(ctx)).not.toContain("binding-warning");

      await press(ctx, settings);

      expect(lastCanvas(ctx)).toContain("binding-warning");
    });

    it("flips back on a quick double press: the second lands while the first write is in flight", async () => {
      const ctx = dialContext("sw-double");
      const settings = stored({ rotation: "select-control", pressAction: "switch-rotation" });
      await appear(ctx, settings);

      // The first write stays pending until released.
      let release: () => void = () => {};
      ctx.setSettings.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));

      await action.onDialDown(eventFor(ctx, settings) as never);
      const first = action.onDialUp(eventFor(ctx, settings) as never);
      // Let the first press reach its write, which now hangs.
      await vi.waitFor(() => expect(ctx.setSettings).toHaveBeenCalledTimes(1));

      // The second press arrives with the same, pre-switch payload.
      await press(ctx, settings);
      release();
      await first;

      const written = ctx.setSettings.mock.calls.map(([s]) => (s as { dial: { rotation: string } }).dial.rotation);

      expect(written).toEqual(["adjust-control", "select-control"]);
      expect(arrowDirections(lastCanvas(ctx))).toEqual(ARROWS["select-control"]);
      expect(ctx.setTriggerDescription).toHaveBeenLastCalledWith(
        expect.objectContaining({ rotate: LABELS["select-control"] }),
      );

      mockTapBinding.mockClear();
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding.mock.calls).toEqual([[PAIRS["select-control"][0]]]);
    });

    it.each([
      ["a long press", "longPressAction"],
      ["a tap of the display", "tapAction"],
      ["a long touch", "longTouchAction"],
    ] as const)("switches from %s too", async (_name, slot) => {
      const ctx = dialContext(`sw-${slot}`);
      const settings = stored({ rotation: "adjust-control", pressAction: "none", [slot]: "switch-rotation" });
      await appear(ctx, settings);

      if (slot === "longPressAction") await press(ctx, settings, 600);
      else await action.onTouchTap(touchEvent(ctx, settings, slot === "longTouchAction") as never);

      expect(ctx.setSettings).toHaveBeenCalledTimes(1);
      expect(ctx.setSettings.mock.calls[0][0]).toMatchObject({ dial: { rotation: "select-control" } });
      expect(arrowDirections(lastCanvas(ctx))).toEqual(ARROWS["select-control"]);
    });

    it("does nothing on a dial that cycles boxes, and says so at debug", async () => {
      const ctx = dialContext("sw-boxes");
      const settings = stored({
        rotation: "boxes",
        pressAction: "switch-rotation",
        longPressAction: "switch-rotation",
        tapAction: "switch-rotation",
        longTouchAction: "switch-rotation",
      });
      await appear(ctx, settings);
      mockTapBinding.mockClear();
      ctx.setDialCanvas.mockClear();
      ctx.setTriggerDescription.mockClear();
      const debug = action["logger"].debug as ReturnType<typeof vi.fn>;
      debug.mockClear();

      await press(ctx, settings);
      await press(ctx, settings, 600);
      await action.onTouchTap(touchEvent(ctx, settings, false) as never);
      await action.onTouchTap(touchEvent(ctx, settings, true) as never);

      expect(ctx.setSettings).not.toHaveBeenCalled();
      expect(mockTapBinding).not.toHaveBeenCalled();
      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
      expect(ctx.setTriggerDescription).not.toHaveBeenCalled();
      expect(debug.mock.calls.filter(([line]) => /Switch Select \/ Adjust ignored/.test(String(line)))).toHaveLength(4);

      // And the dial still cycles boxes.
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding.mock.calls).toEqual([["blackBoxCycleNext"]]);
    });

    it("hints and sounds nothing for it on a dial that cycles boxes", async () => {
      const ctx = dialContext("sw-boxes-silent");
      const settings = stored({
        rotation: "boxes",
        pressAction: "switch-rotation",
        longPressAction: "switch-rotation",
        tapAction: "switch-rotation",
        longTouchAction: "switch-rotation",
      });
      await appear(ctx, settings);

      expect(ctx.setTriggerDescription).toHaveBeenLastCalledWith({ rotate: "Cycle black boxes" });
      expect(action.dialPressShape(eventFor(ctx, settings) as never)).toMatchObject({ short: false, long: false });
      expect(action.touchPressShape(touchEvent(ctx, settings, false) as never)).toEqual({ kind: "none" });
      expect(action.touchPressShape(touchEvent(ctx, settings, true) as never)).toEqual({ kind: "none" });
    });

    it("clicks and bleeps for it on a Select dial, where it acts", async () => {
      const ctx = dialContext("sw-select-sounds");
      const settings = stored({
        rotation: "select-control",
        pressAction: "switch-rotation",
        longPressAction: "switch-rotation",
        tapAction: "switch-rotation",
      });
      await appear(ctx, settings);

      expect(action.dialPressShape(eventFor(ctx, settings) as never)).toMatchObject({ short: true, long: true });
      expect(action.touchPressShape(touchEvent(ctx, settings, false) as never)).toEqual({ kind: "tap" });
    });

    it("switches in memory but writes nothing, with a warning, when the release carries no settings", async () => {
      const ctx = dialContext("sw-empty");
      const settings = stored({ rotation: "select-control", pressAction: "switch-rotation" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(eventFor(ctx, settings) as never);
      await action.onDialUp(eventFor(ctx, {}) as never);

      expect(ctx.setSettings).not.toHaveBeenCalled();
      expect(action["logger"].warn).toHaveBeenCalledWith(expect.stringContaining("rotation switch not persisted"));
      expect(arrowDirections(lastCanvas(ctx))).toEqual(ARROWS["adjust-control"]);
    });

    it("keeps a rotation the Property Inspector sets after a switch", async () => {
      const ctx = dialContext("sw-pi");
      const settings = stored({ rotation: "select-control", pressAction: "switch-rotation" });
      await appear(ctx, settings);
      await press(ctx, settings);

      await action.onDidReceiveSettings(
        eventFor(ctx, stored({ rotation: "boxes", pressAction: "switch-rotation" })) as never,
      );
      mockTapBinding.mockClear();
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding.mock.calls).toEqual([["blackBoxCycleNext"]]);
      expect(lastCanvas(ctx)).toContain(">BLACK BOX<");
    });

    it("switches from a knob press where the extended gestures are off, with no trigger description", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const ctx = dialContext("sw-knob", KNOB);
      const settings = stored({ rotation: "adjust-control", pressAction: "switch-rotation" });
      await appear(ctx, settings);

      // A knob press of any length is a short press.
      await press(ctx, settings, 2000);

      expect(ctx.setSettings.mock.calls).toEqual([
        [expect.objectContaining({ dial: { rotation: "select-control", pressAction: "switch-rotation" } })],
      ]);
      expect(arrowDirections(lastCanvas(ctx))).toEqual(ARROWS["select-control"]);
      expect(lastCanvas(ctx)).toContain('viewBox="0 0 176 112"');
      expect(ctx.setTriggerDescription).not.toHaveBeenCalled();
    });

    it("is offered in every gesture slot's schema", () => {
      const parsed = DialSettings.parse({
        pressAction: "switch-rotation",
        longPressAction: "switch-rotation",
        tapAction: "switch-rotation",
        longTouchAction: "switch-rotation",
      });

      expect(resolveGestures(parsed)).toEqual({
        press: "switch-rotation",
        longPress: "switch-rotation",
        tap: "switch-rotation",
        longTouch: "switch-rotation",
      });
      expect(GESTURE_ACTIONS.at(-1)).toBe("none");
    });

    it.each(["select-control", "adjust-control"] as Switchable[])("labels it on a %s dial", (rotation) => {
      const desc = buildTriggerDescription(
        DialSettings.parse({
          rotation,
          pressAction: "switch-rotation",
          longPressAction: "none",
          tapAction: "switch-rotation",
          longTouchAction: "switch-rotation",
        }),
      );

      expect(desc).toEqual({
        rotate: LABELS[rotation],
        push: "Switch Select / Adjust",
        touch: "Switch Select / Adjust",
        longTouch: "Switch Select / Adjust",
      });
    });
  });

  describe("hold preview of Switch Select / Adjust (#1120, #1585)", () => {
    const ARGS = { colors: resolveDialBoxColors(undefined, "#d4a017"), bindingMissing: false };

    /** The whole stored settings of a dial, with a keypad half the switch's write carries over. */
    function stored(dial: Record<string, unknown>) {
      return { mode: "next", blackBox: "fuel", dial };
    }

    function lastCanvas(ctx: DialContext): string {
      return decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);
    }

    /** The exact data URI the surface pushes for a drawing. */
    function frame(svg: string): string {
      return `data:image/svg+xml,${svg}`;
    }

    async function hold(ctx: DialContext, settings: Record<string, unknown>, ms: number) {
      await action.onDialDown(eventFor(ctx, settings) as never);
      vi.advanceTimersByTime(ms);
    }

    async function appearHeld(id: string, dial: Record<string, unknown>, canvas: typeof STRIP | typeof KNOB = STRIP) {
      const ctx = dialContext(id, canvas);
      const settings = stored(dial);
      await appear(ctx, settings);
      ctx.setDialCanvas.mockClear();

      return { ctx, settings };
    }

    it.each([
      ["select-control", renderAdjustControlPendingStrip, ["left", "right"]],
      ["adjust-control", renderSelectControlPendingStrip, ["up", "down"]],
    ] as const)(
      "on a %s dial with Long Press unset, shows the other Mode's arrows over the bar at the threshold, not before",
      async (rotation, preview, directions) => {
        const { ctx, settings } = await appearHeld(`hp-${rotation}`, { rotation });

        await hold(ctx, settings, 499);

        expect(ctx.setDialCanvas).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);

        expect(ctx.setDialCanvas).toHaveBeenCalledTimes(1);
        expect(lastCanvas(ctx)).toBe(frame(preview(ARGS)));
        expect(arrowDirections(lastCanvas(ctx))).toEqual(directions);
        expect(lastCanvas(ctx)).toContain("data-pending-bar");
        // A preview fires nothing: the release decides.
        expect(ctx.setSettings).not.toHaveBeenCalled();
        expect(mockTapBinding).not.toHaveBeenCalled();
      },
    );

    it("previews an explicitly stored Switch Select / Adjust too", async () => {
      const { ctx, settings } = await appearHeld("hp-explicit", {
        rotation: "adjust-control",
        longPressAction: "switch-rotation",
      });

      await hold(ctx, settings, 500);

      expect(lastCanvas(ctx)).toBe(frame(renderSelectControlPendingStrip(ARGS)));
    });

    it("follows the configured long-press threshold rather than a constant", async () => {
      mockDualPressThreshold.value = 900;
      const { ctx, settings } = await appearHeld("hp-threshold", { rotation: "select-control" });

      await hold(ctx, settings, 899);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);

      expect(lastCanvas(ctx)).toBe(frame(renderAdjustControlPendingStrip(ARGS)));
    });

    it("commits the switch the preview promised on a long release, ending on the new Mode's normal strip", async () => {
      const { ctx, settings } = await appearHeld("hp-commit", { rotation: "select-control" });

      await hold(ctx, settings, 500);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(ctx.setSettings.mock.calls).toEqual([
        [{ mode: "next", blackBox: "fuel", dial: { rotation: "adjust-control" } }],
      ]);
      expect(lastCanvas(ctx)).toBe(frame(renderAdjustControlStrip(ARGS)));
      expect(ctx.setTriggerDescription).toHaveBeenLastCalledWith(expect.objectContaining({ rotate: "Adjust control" }));
    });

    it("pushes neither a preview nor a revert for a short release, and the disarmed timer never fires", async () => {
      const { ctx, settings } = await appearHeld("hp-short", { rotation: "select-control", pressAction: "none" });

      await hold(ctx, settings, 200);
      await action.onDialUp(eventFor(ctx, settings) as never);
      vi.advanceTimersByTime(1000);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
      expect(ctx.setSettings).not.toHaveBeenCalled();
    });

    it("a short press after an earlier preview toggles the control and shows the current Mode", async () => {
      const { ctx, settings } = await appearHeld("hp-short-after", { rotation: "adjust-control" });

      // A hold reverted by a push+turn, then an ordinary short press.
      await hold(ctx, settings, 500);
      await action.onDialRotate(rotateEvent(ctx, settings, 0, true) as never);
      await action.onDialUp(eventFor(ctx, settings) as never);
      mockTapBinding.mockClear();
      ctx.setDialCanvas.mockClear();

      await hold(ctx, settings, 100);
      await action.onDialUp(eventFor(ctx, settings) as never);
      vi.advanceTimersByTime(1000);

      expect(mockTapBinding.mock.calls).toEqual([["blackBoxToggleControl"]]);
      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
      expect(ctx.setSettings).not.toHaveBeenCalled();
    });

    it.each([
      ["a turn", 1],
      ["a zero-tick turn", 0],
    ] as const)(
      "reverts at once on push+turn mid-hold (%s), and the release switches nothing",
      async (_name, ticks) => {
        const { ctx, settings } = await appearHeld(`hp-push-turn-${ticks}`, { rotation: "select-control" });

        await hold(ctx, settings, 500);

        expect(lastCanvas(ctx)).toContain("data-pending-bar");

        ctx.setDialCanvas.mockClear();
        await action.onDialRotate(rotateEvent(ctx, settings, ticks, true) as never);

        expect(ctx.setDialCanvas).toHaveBeenCalledTimes(1);
        expect(lastCanvas(ctx)).toBe(frame(renderSelectControlStrip(ARGS)));

        // A push+turn fires nothing on release and needs no second revert.
        ctx.setDialCanvas.mockClear();
        await action.onDialUp(eventFor(ctx, settings) as never);

        expect(ctx.setDialCanvas).not.toHaveBeenCalled();
        expect(ctx.setSettings).not.toHaveBeenCalled();
      },
    );

    it("reverts a showing preview on a release that fires nothing, before the early returns", async () => {
      const { ctx, settings } = await appearHeld("hp-stray", { rotation: "select-control" });

      await hold(ctx, settings, 500);
      // The press start is gone (a stray second release reads it as 0) — the
      // revert must not sit behind that return.
      const state = action["dialSurface"]["contextsState"].get("hp-stray");

      expect(state).toBeDefined();

      if (state) state.pressStart = 0;

      ctx.setDialCanvas.mockClear();
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(ctx.setDialCanvas).toHaveBeenCalledTimes(1);
      expect(lastCanvas(ctx)).toBe(frame(renderSelectControlStrip(ARGS)));
      expect(ctx.setSettings).not.toHaveBeenCalled();
    });

    it("warns on the preview frame about the previewed Mode's pair (#612)", async () => {
      // Only the Adjust pair is unbound: the Select strip is clean, its preview of Adjust is not.
      mockIsBindingMissing.mockImplementation(((keys: string[]) => keys.includes("blackBoxIncrementControl")) as never);
      const ctx = dialContext("hp-warn");
      const settings = stored({ rotation: "select-control" });
      await appear(ctx, settings);

      expect(lastCanvas(ctx)).not.toContain("binding-warning");

      await hold(ctx, settings, 500);

      expect(lastCanvas(ctx)).toBe(frame(renderAdjustControlPendingStrip({ ...ARGS, bindingMissing: true })));
    });

    it("keeps the preview through a global-settings echo that changes nothing", async () => {
      const { ctx, settings } = await appearHeld("hp-echo-global", { rotation: "select-control" });

      await hold(ctx, settings, 500);
      ctx.setDialCanvas.mockClear();

      for (const listener of globalListeners) listener();

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it("redraws the preview, not the normal strip, when a global-settings change moves the #612 warning mid-hold", async () => {
      const { ctx, settings } = await appearHeld("hp-refresh", { rotation: "select-control" });

      await hold(ctx, settings, 500);
      mockIsBindingMissing.mockImplementation(((keys: string[]) => keys.includes("blackBoxDecrementControl")) as never);

      for (const listener of globalListeners) listener();

      expect(lastCanvas(ctx)).toBe(frame(renderAdjustControlPendingStrip({ ...ARGS, bindingMissing: true })));

      // And the release still commits what was promised.
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(lastCanvas(ctx)).toBe(frame(renderAdjustControlStrip({ ...ARGS, bindingMissing: true })));
    });

    it("pushes nothing on a global-settings echo after the revert", async () => {
      const { ctx, settings } = await appearHeld("hp-echo-after", { rotation: "select-control" });

      await hold(ctx, settings, 500);
      await action.onDialRotate(rotateEvent(ctx, settings, 0, true) as never);
      ctx.setDialCanvas.mockClear();

      for (const listener of globalListeners) listener();

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it("keeps the preview through a settings echo mid-hold, and the release still commits", async () => {
      const { ctx, settings } = await appearHeld("hp-echo-settings", { rotation: "select-control" });

      await hold(ctx, settings, 500);
      await action.onDidReceiveSettings(eventFor(ctx, settings) as never);

      expect(lastCanvas(ctx)).toBe(frame(renderAdjustControlPendingStrip(ARGS)));

      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(ctx.setSettings.mock.calls[0][0]).toMatchObject({ dial: { rotation: "adjust-control" } });
      expect(lastCanvas(ctx)).toBe(frame(renderAdjustControlStrip(ARGS)));
    });

    it("still previews at the threshold after a settings echo early in the hold", async () => {
      const { ctx, settings } = await appearHeld("hp-echo-early", { rotation: "adjust-control" });

      await hold(ctx, settings, 200);
      await action.onDidReceiveSettings(eventFor(ctx, settings) as never);
      vi.advanceTimersByTime(300);

      expect(lastCanvas(ctx)).toBe(frame(renderSelectControlPendingStrip(ARGS)));
    });

    it("drops the preview when a settings change mid-hold makes the Long Press something else", async () => {
      const { ctx, settings } = await appearHeld("hp-settings-change", { rotation: "select-control" });

      await hold(ctx, settings, 500);
      const changed = stored({ rotation: "select-control", longPressAction: "none" });
      await action.onDidReceiveSettings(eventFor(ctx, changed) as never);

      expect(lastCanvas(ctx)).toBe(frame(renderSelectControlStrip(ARGS)));

      // The strip already shows the dial's own Mode: the release pushes no second revert and switches nothing.
      ctx.setDialCanvas.mockClear();
      await action.onDialUp(eventFor(ctx, changed) as never);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
      expect(ctx.setSettings).not.toHaveBeenCalled();
    });

    it("re-aims the preview when a settings change mid-hold switches the rotation", async () => {
      const { ctx, settings } = await appearHeld("hp-settings-rotation", { rotation: "select-control" });

      await hold(ctx, settings, 500);
      await action.onDidReceiveSettings(eventFor(ctx, stored({ rotation: "adjust-control" })) as never);

      // The release would now switch Adjust to Select, so that is the promise.
      expect(lastCanvas(ctx)).toBe(frame(renderSelectControlPendingStrip(ARGS)));
    });

    it("tears a showing preview down on disappear without pushing a revert frame", async () => {
      const { ctx, settings } = await appearHeld("hp-dispose", { rotation: "select-control" });

      await hold(ctx, settings, 500);
      ctx.setDialCanvas.mockClear();
      await action.onWillDisappear(eventFor(ctx, settings) as never);
      await action.onDialUp(eventFor(ctx, settings) as never);
      vi.advanceTimersByTime(1000);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
      expect(ctx.setSettings).not.toHaveBeenCalled();
    });

    it("disarms a pending preview timer on disappear", async () => {
      const { ctx, settings } = await appearHeld("hp-dispose-armed", { rotation: "select-control" });
      const timersBefore = vi.getTimerCount();

      await hold(ctx, settings, 200);

      expect(vi.getTimerCount()).toBe(timersBefore + 1);

      await action.onWillDisappear(eventFor(ctx, settings) as never);

      expect(vi.getTimerCount()).toBe(timersBefore);

      vi.advanceTimersByTime(1000);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it("previews nothing on a dial that cycles boxes, even with Switch Select / Adjust stored", async () => {
      const { ctx, settings } = await appearHeld("hp-boxes", {
        rotation: "boxes",
        longPressAction: "switch-rotation",
      });

      await hold(ctx, settings, 600);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
    });

    it.each(["none", "toggle-control", "open-selected-box"] as const)(
      "previews nothing when the Long Press is %s",
      async (longPressAction) => {
        const { ctx, settings } = await appearHeld(`hp-other-${longPressAction}`, {
          rotation: "select-control",
          longPressAction,
        });

        await hold(ctx, settings, 600);

        expect(ctx.setDialCanvas).not.toHaveBeenCalled();

        await action.onDialUp(eventFor(ctx, settings) as never);

        expect(ctx.setSettings).not.toHaveBeenCalled();
      },
    );

    it("previews nothing on a knob screen, though the long release still switches", async () => {
      const { ctx, settings } = await appearHeld("hp-knob", { rotation: "select-control" }, KNOB);

      await hold(ctx, settings, 600);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();

      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(lastCanvas(ctx)).toBe(frame(renderAdjustControlKnob(ARGS)));
    });

    it("with the extended gestures compiled out, arms no timer and pushes no preview frame", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const { ctx, settings } = await appearHeld("hp-flag-off", {
        rotation: "select-control",
        pressAction: "none",
        longPressAction: "switch-rotation",
      });
      const timersBefore = vi.getTimerCount();

      await action.onDialDown(eventFor(ctx, settings) as never);

      expect(vi.getTimerCount()).toBe(timersBefore);

      vi.advanceTimersByTime(2000);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(ctx.setDialCanvas).not.toHaveBeenCalled();
      // Every release is short there, and the Press is None.
      expect(ctx.setSettings).not.toHaveBeenCalled();
    });
  });

  describe("Press and Long Press defaults follow the rotation (#1585)", () => {
    // What is stored in a slot: nothing, the user's own None, or a gesture.
    const STORED = [undefined, "none", "next-control"] as const;
    // What is stored as the rotation: nothing (every dial from before the choice), or each choice.
    const STORED_ROTATIONS = [undefined, ...ROTATIONS] as const;
    const MATRIX = STORED_ROTATIONS.flatMap((rotation) => STORED.map((value) => [rotation, value] as const));

    function dialWith(rotation: string | undefined, slots: Record<string, string | undefined>) {
      const dial: Record<string, unknown> = {};

      if (rotation !== undefined) dial.rotation = rotation;

      for (const [slot, value] of Object.entries(slots)) {
        if (value !== undefined) dial[slot] = value;
      }

      return dial;
    }

    /** What the spec says an unset slot does, written out rather than read from the table under test. */
    function expectedDefault(rotation: string | undefined, slot: "press" | "longPress"): string {
      if (rotation !== "select-control" && rotation !== "adjust-control") return "none";

      return slot === "press" ? "toggle-control" : "switch-rotation";
    }

    it("defaults a Select or Adjust dial to Toggle Selected Control and Switch Select / Adjust, and a boxes dial to none", () => {
      expect(ROTATION_GESTURE_DEFAULTS).toEqual({
        boxes: { pressAction: "none", longPressAction: "none" },
        "select-control": { pressAction: "toggle-control", longPressAction: "switch-rotation" },
        "adjust-control": { pressAction: "toggle-control", longPressAction: "switch-rotation" },
      });
    });

    it.each(MATRIX)("Press with rotation %s and %s stored", (rotation, value) => {
      const resolved = resolveGestures(DialSettings.parse(dialWith(rotation, { pressAction: value })));

      expect(resolved.press).toBe(value ?? expectedDefault(rotation, "press"));
    });

    it.each(MATRIX)("Long Press with rotation %s and %s stored", (rotation, value) => {
      const resolved = resolveGestures(DialSettings.parse(dialWith(rotation, { longPressAction: value })));

      expect(resolved.longPress).toBe(value ?? expectedDefault(rotation, "longPress"));
    });

    it.each(STORED_ROTATIONS)("Tap Display and Long Touch stay none with rotation %s", (rotation) => {
      const resolved = resolveGestures(DialSettings.parse(dialWith(rotation, {})));

      expect(resolved.tap).toBe("none");
      expect(resolved.longTouch).toBe("none");
    });

    it("announces a default exactly as it resolves it, wherever the default acts", () => {
      for (const rotation of ["select-control", "adjust-control"] as const) {
        const dial = DialSettings.parse({ rotation });

        expect(firingGestures(dial), rotation).toEqual(resolveGestures(dial));
      }
    });

    it.each(["select-control", "adjust-control"] as const)(
      "an untouched %s dial toggles the selected control on a press and switches on a long press",
      async (rotation) => {
        const ctx = dialContext(`gd-${rotation}`);
        const settings = withDial({ rotation });
        await appear(ctx, settings);
        mockTapBinding.mockClear();

        await action.onDialDown(eventFor(ctx, settings) as never);
        await action.onDialUp(eventFor(ctx, settings) as never);

        expect(mockTapBinding.mock.calls).toEqual([["blackBoxToggleControl"]]);
        expect(ctx.setSettings).not.toHaveBeenCalled();

        await action.onDialDown(eventFor(ctx, settings) as never);
        vi.advanceTimersByTime(600);
        await action.onDialUp(eventFor(ctx, settings) as never);

        // The switch is written over the raw settings: the slots stay unset.
        expect(ctx.setSettings.mock.calls).toEqual([[{ dial: { rotation: SWITCHED_ROTATION[rotation] } }]]);
        expect(mockTapBinding).toHaveBeenCalledTimes(1);
      },
    );

    it("keeps its defaults across its own switch: the next press still toggles, the next long press switches back", async () => {
      const ctx = dialContext("gd-round-trip");
      const settings = withDial({ rotation: "select-control" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      for (let i = 0; i < 2; i++) {
        await action.onDialDown(eventFor(ctx, settings) as never);
        vi.advanceTimersByTime(600);
        await action.onDialUp(eventFor(ctx, settings) as never);
      }

      await action.onDialDown(eventFor(ctx, settings) as never);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(ctx.setSettings.mock.calls.map(([s]) => (s as { dial: { rotation: string } }).dial.rotation)).toEqual([
        "adjust-control",
        "select-control",
      ]);
      expect(mockTapBinding.mock.calls).toEqual([["blackBoxToggleControl"]]);
    });

    it.each(["select-control", "adjust-control"] as const)(
      "a stored none wins on a %s dial: neither release fires",
      async (rotation) => {
        const ctx = dialContext(`gd-none-${rotation}`);
        const settings = withDial({ rotation, pressAction: "none", longPressAction: "none" });
        await appear(ctx, settings);
        mockTapBinding.mockClear();

        await action.onDialDown(eventFor(ctx, settings) as never);
        await action.onDialUp(eventFor(ctx, settings) as never);
        await action.onDialDown(eventFor(ctx, settings) as never);
        vi.advanceTimersByTime(600);
        await action.onDialUp(eventFor(ctx, settings) as never);

        expect(mockTapBinding).not.toHaveBeenCalled();
        expect(ctx.setSettings).not.toHaveBeenCalled();
        expect(action.dialPressShape(eventFor(ctx, settings) as never)).toMatchObject({ short: false, long: false });
        expect(ctx.setTriggerDescription).toHaveBeenLastCalledWith({
          rotate: rotation === "select-control" ? "Select control" : "Adjust control",
        });
      },
    );

    it.each([
      ["no settings at all", {}],
      ["an empty dial", withDial({})],
      ["a dial from before the choice", withDial({ pressBox: "fuel", colors: { borderColor: "#112233" } })],
      ["a boxes dial", withDial({ rotation: "boxes" })],
    ] as const)(
      "an existing instance with %s is unchanged: nothing fires and the press is silent",
      async (_name, s) => {
        const settings = s as Record<string, unknown>;
        const ctx = dialContext("gd-existing");
        await appear(ctx, settings);
        mockTapBinding.mockClear();

        expect(action.dialPressShape(eventFor(ctx, settings) as never)).toEqual({
          kind: "release",
          thresholdMs: 500,
          short: false,
          long: false,
        });
        expect(action.touchPressShape(touchEvent(ctx, settings, false) as never)).toEqual({ kind: "none" });
        expect(action.touchPressShape(touchEvent(ctx, settings, true) as never)).toEqual({ kind: "none" });
        expect(ctx.setTriggerDescription).toHaveBeenLastCalledWith({ rotate: "Cycle black boxes" });

        await action.onDialDown(eventFor(ctx, settings) as never);
        await action.onDialUp(eventFor(ctx, settings) as never);
        await action.onDialDown(eventFor(ctx, settings) as never);
        vi.advanceTimersByTime(600);
        await action.onDialUp(eventFor(ctx, settings) as never);
        await action.onTouchTap(touchEvent(ctx, settings, false) as never);
        await action.onTouchTap(touchEvent(ctx, settings, true) as never);

        expect(mockTapBinding).not.toHaveBeenCalled();
        expect(ctx.setSettings).not.toHaveBeenCalled();
      },
    );

    it.each(["select-control", "adjust-control"] as const)(
      "an untouched %s dial clicks on a press and bleeps on a long press, and hints both",
      async (rotation) => {
        const ctx = dialContext(`gd-shape-${rotation}`);
        const settings = withDial({ rotation });
        await appear(ctx, settings);

        expect(action.dialPressShape(eventFor(ctx, settings) as never)).toEqual({
          kind: "release",
          thresholdMs: 500,
          short: true,
          long: true,
        });
        // The touch slots have no default: a tap of the display stays silent.
        expect(action.touchPressShape(touchEvent(ctx, settings, false) as never)).toEqual({ kind: "none" });
        expect(action.touchPressShape(touchEvent(ctx, settings, true) as never)).toEqual({ kind: "none" });
        expect(ctx.setTriggerDescription).toHaveBeenLastCalledWith({
          rotate: rotation === "select-control" ? "Select control" : "Adjust control",
          push: "Toggle selected control (hold: Switch Select / Adjust)",
        });
      },
    );

    it("a stored gesture wins over the default in the shape and the hint too", async () => {
      const ctx = dialContext("gd-stored");
      const settings = withDial({ rotation: "adjust-control", pressAction: "next-control", longPressAction: "none" });
      await appear(ctx, settings);

      expect(action.dialPressShape(eventFor(ctx, settings) as never)).toMatchObject({ short: true, long: false });
      expect(ctx.setTriggerDescription).toHaveBeenLastCalledWith({
        rotate: "Adjust control",
        push: "Select next control",
      });
    });

    it("on a knob an untouched Adjust dial toggles on every press and never switches", async () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      const ctx = dialContext("gd-knob", KNOB);
      const settings = withDial({ rotation: "adjust-control" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(eventFor(ctx, settings) as never);
      vi.advanceTimersByTime(2000);
      await action.onDialUp(eventFor(ctx, settings) as never);

      expect(mockTapBinding.mock.calls).toEqual([["blackBoxToggleControl"]]);
      expect(ctx.setSettings).not.toHaveBeenCalled();
      expect(action.dialPressShape(eventFor(ctx, settings) as never)).toEqual({
        kind: "release",
        thresholdMs: Number.POSITIVE_INFINITY,
        short: true,
        long: false,
      });
    });
  });

  describe("strip and #612 dim follow the rotation (#1585)", () => {
    const SCREENS = {
      boxes: { strip: renderBlackBoxStrip, knob: renderBlackBoxKnob },
      "select-control": { strip: renderSelectControlStrip, knob: renderSelectControlKnob },
      "adjust-control": { strip: renderAdjustControlStrip, knob: renderAdjustControlKnob },
    } as const;

    it.each([
      ["boxes", "strip", STRIP],
      ["boxes", "knob", KNOB],
      ["select-control", "strip", STRIP],
      ["select-control", "knob", KNOB],
      ["adjust-control", "strip", STRIP],
      ["adjust-control", "knob", KNOB],
    ] as const)(
      "a %s dial on the %s screen pushes that rotation's drawing for that screen",
      async (rotation, screen, canvas) => {
        const ctx = dialContext(`s-${rotation}-${screen}`, canvas);
        await appear(ctx, withDial({ rotation }));

        const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);
        const expected = SCREENS[rotation][screen]({
          colors: resolveDialBoxColors(undefined, "#d4a017"),
          bindingMissing: false,
        });

        expect(decoded).toBe(`data:image/svg+xml,${expected}`);
        expect(decoded).toContain(`viewBox="0 0 ${canvas.width} ${canvas.height}"`);
      },
    );

    it.each([
      ["boxes", ["blackBoxCycleNext", "blackBoxCyclePrevious"]],
      ["select-control", ["blackBoxSelectNextControl", "blackBoxSelectPreviousControl"]],
      ["adjust-control", ["blackBoxIncrementControl", "blackBoxDecrementControl"]],
    ] as const)("a %s dial warns on its own pair", async (rotation, pair) => {
      mockIsBindingMissing.mockImplementation(((keys: string[]) => keys[0] === pair[0]) as never);
      const ctx = dialContext(`w-${rotation}`);
      await appear(ctx, withDial({ rotation }));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(mockIsBindingMissing).toHaveBeenCalledWith([...pair]);
      expect(decoded).toContain("binding-warning");
    });

    it("shows Cycle Black Boxes as the BB badge and BLACK BOX, with no arrows", async () => {
      const ctx = dialContext("w-boxes-look");
      await appear(ctx, withDial({ rotation: "boxes" }));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).toContain(">BB<");
      expect(decoded).toContain(">BLACK BOX<");
      expect(arrowDirections(decoded)).toEqual([]);
    });

    it.each([
      ["select-control", "strip", STRIP, ["up", "down"]],
      ["select-control", "knob", KNOB, ["up", "down"]],
      ["adjust-control", "strip", STRIP, ["left", "right"]],
      ["adjust-control", "knob", KNOB, ["left", "right"]],
    ] as const)(
      "shows a %s dial on the %s screen as its arrows, with no badge or word",
      async (rotation, screen, canvas, directions) => {
        const ctx = dialContext(`w-${rotation}-${screen}-look`, canvas);
        await appear(ctx, withDial({ rotation }));

        const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

        expect(arrowDirections(decoded)).toEqual(directions);
        expect(decoded).not.toContain("<text");
      },
    );

    it("does not warn an Adjust Control dial for unset Cycle bindings", async () => {
      mockIsBindingMissing.mockImplementation(((keys: string[]) => keys.includes("blackBoxCycleNext")) as never);
      const ctx = dialContext("w-adjust-cycle-unset");
      await appear(ctx, withDial({ rotation: "adjust-control" }));

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(decoded).not.toContain("binding-warning");
    });

    it("re-renders on a settings change that switches the rotation", async () => {
      const ctx = dialContext("w-switch");
      await appear(ctx, withDial({}));

      await action.onDidReceiveSettings(eventFor(ctx, withDial({ rotation: "adjust-control" })) as never);

      const decoded = decodeURIComponent(ctx.setDialCanvas.mock.calls.at(-1)?.[0] as string);

      expect(arrowDirections(decoded)).toEqual(["left", "right"]);
      expect(decoded).not.toContain(">BLACK BOX<");
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
