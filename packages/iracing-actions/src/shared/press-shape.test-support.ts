/**
 * The press-shape cases every dial surface shares (#269), run from each
 * surface's own test file so they use that file's mocks and its action.
 *
 * Each surface declares a dial press as `release`, from the press and
 * long-press gestures its release fires and the threshold it classifies with,
 * and a touch as `tap`, `long` or `none`, from the slot its `touchTap` fires.
 * These cases pin that for one surface: the gestures set to `none`, the
 * extended gestures compiled out, a context that does not exist, and whether
 * the shape follows the event's settings or the context's stored ones, which
 * is the one way the surfaces differ.
 */
import type { PressShape } from "@iracedeck/deck-core";
import { afterEach, describe, expect, it, vi } from "vitest";

export interface PressShapeContext {
  id: string;
  isDial(): boolean;
  isKey(): boolean;
}

export interface PressShapeSuite<C extends PressShapeContext> {
  /** A fresh dial context with this id. */
  dialContext(id: string): C;
  /** Make the surface hold a context for `ctx` with these dial settings. */
  appear(ctx: NoInfer<C>, dial: Record<string, unknown>): Promise<void>;
  /** The shape of a dial-down on `ctx` whose event carries these dial settings. */
  dialShape(ctx: NoInfer<C>, dial: Record<string, unknown>): PressShape;
  /** The shape of a touch on `ctx` whose event carries these dial settings. */
  touchShape(ctx: NoInfer<C>, dial: Record<string, unknown>, hold: boolean): PressShape;
  /**
   * A press gesture value that fires something, or `null` for a surface whose
   * gesture slots offer only None (Setup Engine, Setup Hybrid): every press and
   * touch of it is silent.
   */
  gesture: string | null;
  /** A touch gesture value that fires something; `gesture` when omitted. */
  touchGesture?: string;
  /** Dial settings every case starts from (a mode the surface needs, say). */
  baseDial?: Record<string, unknown>;
  /**
   * Sets the threshold `getDualPressThresholdMs()` returns in this file's mock;
   * omitted where that mock returns a fixed 500.
   */
  setThresholdMs?(ms: number): void;
  /**
   * Whether the surface's release and touch read the settings it stored at
   * `willAppear` / `didReceiveSettings` rather than the input event's (Fuel
   * Service and Setup Chassis do).
   */
  readsStoredSettings: boolean;
  /** The shape of a key-down on a key context carrying these (whole) settings; omitted for a surface-only suite. */
  keyShape?(ctx: NoInfer<C>, settings: Record<string, unknown>): PressShape;
  /** The key cases to pin; one plain key, a tap, when omitted. */
  keyCases?: { name: string; settings: Record<string, unknown>; shape: PressShape }[];
}

/** The dial-down and touch shapes of an action, through its own `pressShape`. */
export function actionPressShapes(
  action: () => { pressShape(ev: never): PressShape },
  settings: (dial: Record<string, unknown>) => Record<string, unknown> = (dial) => ({ dial }),
): Pick<PressShapeSuite<PressShapeContext>, "dialShape" | "touchShape" | "keyShape"> {
  return {
    keyShape: (ctx, whole) => action().pressShape({ action: ctx, payload: { settings: whole } } as never),
    dialShape: (ctx, dial) => action().pressShape({ action: ctx, payload: { settings: settings(dial) } } as never),
    touchShape: (ctx, dial, hold) =>
      action().pressShape({ action: ctx, payload: { settings: settings(dial), tapPos: [0, 0], hold } } as never),
  };
}

export function describePressShapes<C extends PressShapeContext>(suite: PressShapeSuite<C>): void {
  if (suite.gesture === null) {
    describeSilentPressShapes(suite);

    return;
  }

  const g = suite.gesture;
  const t = suite.touchGesture ?? suite.gesture;
  const dial = (overrides: Record<string, unknown>) => ({ ...suite.baseDial, ...overrides });

  async function shown(
    id: string,
    overrides: Record<string, unknown>,
  ): Promise<{ ctx: C; d: Record<string, unknown> }> {
    const ctx = suite.dialContext(id);
    const d = dial(overrides);
    await suite.appear(ctx, d);

    return { ctx, d };
  }

  describe("press shape (#269)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    describe("dial press", () => {
      it("is a release at the dual-press threshold, short and long, when both gestures act", async () => {
        const thresholdMs = withThreshold(suite);
        const { ctx, d } = await shown("ps-both", { pressAction: g, longPressAction: g });

        expect(suite.dialShape(ctx, d)).toEqual({ kind: "release", thresholdMs, short: true, long: true });
      });

      it("clears short when the press gesture is none", async () => {
        const { ctx, d } = await shown("ps-press-none", { pressAction: "none", longPressAction: g });

        expect(suite.dialShape(ctx, d)).toMatchObject({ kind: "release", short: false, long: true });
      });

      it("clears long when the long-press gesture is none", async () => {
        const { ctx, d } = await shown("ps-long-none", { pressAction: g, longPressAction: "none" });

        expect(suite.dialShape(ctx, d)).toMatchObject({ kind: "release", short: true, long: false });
      });

      it("is never long, at an infinite threshold, with the extended gestures off", async () => {
        vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
        const { ctx, d } = await shown("ps-knob", { pressAction: g, longPressAction: g });

        expect(suite.dialShape(ctx, d)).toEqual({
          kind: "release",
          thresholdMs: Number.POSITIVE_INFINITY,
          short: true,
          long: false,
        });
      });

      it("is none for a dial the surface holds no context for", () => {
        const ctx = suite.dialContext("ps-unknown");

        expect(suite.dialShape(ctx, dial({ pressAction: g, longPressAction: g }))).toEqual({ kind: "none" });
      });

      it(`follows the ${suite.readsStoredSettings ? "stored" : "event's"} settings, as the release does`, async () => {
        const { ctx } = await shown("ps-source", { pressAction: g, longPressAction: "none" });

        expect(suite.dialShape(ctx, dial({ pressAction: "none", longPressAction: "none" }))).toMatchObject({
          short: suite.readsStoredSettings,
        });
      });
    });

    describe("touch", () => {
      it("is a tap for a tap whose gesture acts", async () => {
        const { ctx, d } = await shown("ps-tap", { tapAction: t, longTouchAction: "none" });

        expect(suite.touchShape(ctx, d, false)).toEqual({ kind: "tap" });
      });

      it("is a completed long press for a long touch whose gesture acts", async () => {
        const { ctx, d } = await shown("ps-long-touch", { tapAction: "none", longTouchAction: t });

        expect(suite.touchShape(ctx, d, true)).toEqual({ kind: "long" });
      });

      it("is none for a tap set to none", async () => {
        const { ctx, d } = await shown("ps-tap-none", { tapAction: "none", longTouchAction: t });

        expect(suite.touchShape(ctx, d, false)).toEqual({ kind: "none" });
      });

      it("is none for a long touch set to none", async () => {
        const { ctx, d } = await shown("ps-long-touch-none", { tapAction: t, longTouchAction: "none" });

        expect(suite.touchShape(ctx, d, true)).toEqual({ kind: "none" });
      });

      it("is none with the extended gestures off, where no touch fires", async () => {
        vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
        const { ctx, d } = await shown("ps-touch-knob", { tapAction: t, longTouchAction: t });

        expect(suite.touchShape(ctx, d, false)).toEqual({ kind: "none" });
      });

      it("is none for a dial the surface holds no context for", () => {
        const ctx = suite.dialContext("ps-touch-unknown");

        expect(suite.touchShape(ctx, dial({ tapAction: t }), false)).toEqual({ kind: "none" });
      });
    });

    if (suite.keyShape) {
      const keyShape = suite.keyShape;
      const cases = suite.keyCases ?? [{ name: "a key acts on key down", settings: {}, shape: { kind: "tap" } }];

      describe("key press", () => {
        it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
          const ctx = { ...suite.dialContext("ps-key"), isDial: () => false, isKey: () => true };

          expect(keyShape(ctx, c.settings)).toEqual(c.shape);
        });
      });
    }
  });
}

/** The cases for a surface whose gesture slots offer only None. */
function describeSilentPressShapes<C extends PressShapeContext>(suite: PressShapeSuite<C>): void {
  const none = { pressAction: "none", longPressAction: "none", tapAction: "none", longTouchAction: "none" };
  const dial = { ...suite.baseDial, ...none };

  describe("press shape (#269), every gesture None", () => {
    it("is a release that neither clicks nor bleeps", async () => {
      const thresholdMs = withThreshold(suite);
      const ctx = suite.dialContext("ps-silent");
      await suite.appear(ctx, dial);

      expect(suite.dialShape(ctx, dial)).toEqual({ kind: "release", thresholdMs, short: false, long: false });
    });

    it("is none for a tap and a long touch", async () => {
      const ctx = suite.dialContext("ps-silent-touch");
      await suite.appear(ctx, dial);

      expect(suite.touchShape(ctx, dial, false)).toEqual({ kind: "none" });
      expect(suite.touchShape(ctx, dial, true)).toEqual({ kind: "none" });
    });

    it("is none for a dial the surface holds no context for", () => {
      expect(suite.dialShape(suite.dialContext("ps-silent-unknown"), dial)).toEqual({ kind: "none" });
    });

    if (suite.keyShape) {
      const keyShape = suite.keyShape;

      it.each((suite.keyCases ?? []).map((c) => [c.name, c] as const))("key: %s", (_name, c) => {
        const ctx = { ...suite.dialContext("ps-key"), isDial: () => false, isKey: () => true };

        expect(keyShape(ctx, c.settings)).toEqual(c.shape);
      });
    }
  });
}

/** Set a threshold no default produces, where the file's mock allows it, and return the one in force. */
function withThreshold<C extends PressShapeContext>(suite: PressShapeSuite<C>): number {
  if (!suite.setThresholdMs) return 500;

  suite.setThresholdMs(650);

  return 650;
}

interface RoutedAction {
  pressShape(ev: never): PressShape;
}

/**
 * For an action whose surface is tested on its own: its `pressShape` hands a
 * dial-down and a touch to the surface with the event's dial settings, and
 * answers a key itself with `keyShape`.
 */
export function describePressShapeRouting(
  makeAction: () => RoutedAction,
  options: { dial?: Record<string, unknown>; keyShape?: PressShape } = {},
): void {
  const dial = options.dial ?? {};
  const context = (dialContext: boolean) => ({ id: "route", isDial: () => dialContext, isKey: () => !dialContext });

  describe("press shape routing (#269)", () => {
    function spied() {
      const action = makeAction();
      const surface = (action as unknown as { dialSurface: Record<"pressShape" | "touchShape", () => PressShape> })
        .dialSurface;
      const press = vi.spyOn(surface, "pressShape").mockReturnValue({ kind: "long" });
      const touch = vi.spyOn(surface, "touchShape").mockReturnValue({ kind: "tap" });

      return { action, press, touch };
    }

    it("hands a dial-down to the dial surface with the event's dial settings", () => {
      const { action, press } = spied();
      const ctx = context(true);

      expect(action.pressShape({ action: ctx, payload: { settings: { dial } } } as never)).toEqual({ kind: "long" });
      expect(press).toHaveBeenCalledWith(ctx, expect.objectContaining(dial));
    });

    it("hands a touch to the dial surface with its hold flag", () => {
      const { action, touch } = spied();
      const ctx = context(true);

      expect(
        action.pressShape({ action: ctx, payload: { settings: { dial }, tapPos: [0, 0], hold: true } } as never),
      ).toEqual({ kind: "tap" });
      expect(touch).toHaveBeenCalledWith(ctx, expect.objectContaining(dial), true);
    });

    it("answers a key-down itself, without the dial surface", () => {
      const { action, press, touch } = spied();

      expect(action.pressShape({ action: context(false), payload: { settings: {} } } as never)).toEqual(
        options.keyShape ?? { kind: "tap" },
      );
      expect(press).not.toHaveBeenCalled();
      expect(touch).not.toHaveBeenCalled();
    });
  });
}
