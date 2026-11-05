import type { IDeckActionContext } from "@iracedeck/deck-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DialInputEvent } from "./dial-context.js";
import { type DialGestures, type DialSurfaceHost, gestureSlots, ReleaseDialSurfaceBase } from "./dial-surface-base.js";

const { threshold } = vi.hoisted(() => ({ threshold: { value: 500 } }));

vi.mock("@iracedeck/deck-core", () => ({
  getDualPressThresholdMs: () => threshold.value,
}));

interface TestSettings {
  pressAction: string;
  longPressAction: string;
  tapAction: string;
  longTouchAction: string;
}

interface TestContext {
  action: IDeckActionContext;
  settings: TestSettings;
  serial: number;
}

const ACTS: TestSettings = {
  pressAction: "go",
  longPressAction: "go",
  tapAction: "go",
  longTouchAction: "go",
};

/** A minimal surface whose hooks are spies, with test-only doors onto the protected members. */
class TestSurface extends ReleaseDialSurfaceBase<TestContext, TestSettings> {
  private created = 0;

  readonly create = vi.fn<(action: IDeckActionContext, settings: TestSettings) => TestContext>((action, settings) => ({
    action,
    settings,
    serial: ++this.created,
  }));

  readonly refresh = vi.fn<(ctx: TestContext, action: IDeckActionContext, settings: TestSettings) => void>(
    (ctx, action, settings) => {
      ctx.action = action;
      ctx.settings = settings;
    },
  );

  readonly gestures = vi.fn<(ctx: TestContext, settings: TestSettings) => DialGestures>((_ctx, settings) =>
    gestureSlots(settings),
  );

  constructor(protected override readonly host: DialSurfaceHost) {
    super();
  }

  protected override createContext(action: IDeckActionContext, settings: TestSettings): TestContext {
    return this.create(action, settings);
  }

  protected override refreshContext(ctx: TestContext, action: IDeckActionContext, settings: TestSettings): void {
    this.refresh(ctx, action, settings);
  }

  protected override dialGestures(ctx: TestContext, settings: TestSettings): DialGestures {
    return this.gestures(ctx, settings);
  }

  lifecycle(action: IDeckActionContext, settings: TestSettings): TestContext {
    return this.ensureContext(action, settings);
  }

  input(action: IDeckActionContext, settings: TestSettings, event: DialInputEvent): TestContext | undefined {
    return this.inputContext(action, settings, event);
  }

  forget(actionId: string): void {
    this.forgetContext(actionId);
  }

  view(): ReadonlyMap<string, TestContext> {
    return this.contextsState;
  }
}

function actionOf(id: string): IDeckActionContext {
  return { id } as IDeckActionContext;
}

describe("DialSurfaceBase (#1589)", () => {
  let logger: { debug: ReturnType<typeof vi.fn<(message: string) => void>> };
  let surface: TestSurface;

  beforeEach(() => {
    threshold.value = 500;
    logger = { debug: vi.fn<(message: string) => void>() };
    surface = new TestSurface({ logger });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("ensureContext", () => {
    it("creates a context once, stores it, and refreshes it on every later call", () => {
      const first = actionOf("a");
      const created = surface.lifecycle(first, ACTS);

      expect(surface.create).toHaveBeenCalledTimes(1);
      expect(surface.create).toHaveBeenCalledWith(first, ACTS);
      expect(surface.refresh).not.toHaveBeenCalled();
      expect(surface.view().get("a")).toBe(created);

      const second = actionOf("a");
      const later = { ...ACTS, pressAction: "none" };
      const refreshed = surface.lifecycle(second, later);
      surface.lifecycle(second, later);

      expect(refreshed).toBe(created);
      expect(surface.create).toHaveBeenCalledTimes(1);
      expect(surface.refresh).toHaveBeenCalledTimes(2);
      expect(surface.refresh).toHaveBeenCalledWith(created, second, later);
      expect(created.action).toBe(second);
      expect(created.settings).toBe(later);
    });

    it("keeps one context per action id", () => {
      surface.lifecycle(actionOf("a"), ACTS);
      surface.lifecycle(actionOf("b"), ACTS);

      expect(surface.create).toHaveBeenCalledTimes(2);
      expect([...surface.view().keys()]).toEqual(["a", "b"]);
    });
  });

  describe("inputContext (#1329)", () => {
    it.each<DialInputEvent>(["rotate", "down", "touchTap"])(
      "drops a %s for an unknown id: undefined, neither hook called, nothing stored, the one drop line",
      (event) => {
        expect(surface.input(actionOf("ghost"), ACTS, event)).toBeUndefined();

        expect(surface.create).not.toHaveBeenCalled();
        expect(surface.refresh).not.toHaveBeenCalled();
        expect(surface.view().size).toBe(0);
        expect(logger.debug).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith(`Dial ${event} dropped: no context for ghost (it has disappeared)`);
      },
    );

    it("logs exactly the family's wording for a dropped rotate", () => {
      surface.input(actionOf("ghost"), ACTS, "rotate");

      expect(logger.debug.mock.calls).toEqual([["Dial rotate dropped: no context for ghost (it has disappeared)"]]);
    });

    it("refreshes and returns the existing context for a known id", () => {
      const created = surface.lifecycle(actionOf("a"), ACTS);
      const next = actionOf("a");
      const later = { ...ACTS, tapAction: "none" };

      expect(surface.input(next, later, "rotate")).toBe(created);
      expect(surface.create).toHaveBeenCalledTimes(1);
      expect(surface.refresh).toHaveBeenCalledTimes(1);
      expect(surface.refresh).toHaveBeenCalledWith(created, next, later);
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it.each<DialInputEvent>(["rotate", "down", "touchTap"])(
      "drops a %s after forgetContext and re-creates nothing",
      (event) => {
        surface.lifecycle(actionOf("a"), ACTS);
        surface.forget("a");
        surface.create.mockClear();
        surface.refresh.mockClear();

        expect(surface.input(actionOf("a"), ACTS, event)).toBeUndefined();

        expect(surface.view().has("a")).toBe(false);
        expect(surface.create).not.toHaveBeenCalled();
        expect(surface.refresh).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(`Dial ${event} dropped: no context for a (it has disappeared)`);
      },
    );
  });

  describe("forgetContext", () => {
    it("removes only that context; a later lifecycle event creates a fresh one", () => {
      const first = surface.lifecycle(actionOf("a"), ACTS);
      surface.lifecycle(actionOf("b"), ACTS);

      surface.forget("a");

      expect(surface.view().has("a")).toBe(false);
      expect(surface.view().has("b")).toBe(true);

      const again = surface.lifecycle(actionOf("a"), ACTS);

      expect(again).not.toBe(first);
      expect(surface.create).toHaveBeenCalledTimes(3);
    });

    it("is a no-op for an id it does not hold", () => {
      surface.lifecycle(actionOf("a"), ACTS);

      surface.forget("ghost");

      expect(surface.view().size).toBe(1);
    });
  });

  describe("contextsState", () => {
    it("is the live map: what ensureContext adds shows, what forgetContext removes is gone", () => {
      const view = surface.view();

      expect(view.size).toBe(0);

      const ctx = surface.lifecycle(actionOf("a"), ACTS);

      expect(view.get("a")).toBe(ctx);
      expect(surface.view()).toBe(view);

      surface.forget("a");

      expect(view.has("a")).toBe(false);
    });

    it("is the same object a test's bracket read reaches", () => {
      surface.lifecycle(actionOf("a"), ACTS);

      expect(surface["contextsState"]).toBe(surface.view());
      expect(surface["contextsState"].has("a")).toBe(true);
    });
  });

  describe("pressShape (#269)", () => {
    it("is none with no context, and never asks for the gestures", () => {
      expect(surface.pressShape(actionOf("ghost"), ACTS)).toEqual({ kind: "none" });
      expect(surface.gestures).not.toHaveBeenCalled();
    });

    it("passes the stored context and the event's settings to dialGestures", () => {
      const ctx = surface.lifecycle(actionOf("a"), ACTS);
      const event = { ...ACTS, longPressAction: "none" };

      surface.pressShape(actionOf("a"), event);

      expect(surface.gestures).toHaveBeenCalledTimes(1);
      expect(surface.gestures).toHaveBeenCalledWith(ctx, event);
    });

    it("is a release at the dual-press threshold, short and long, when both gestures act", () => {
      threshold.value = 650;
      surface.lifecycle(actionOf("a"), ACTS);

      expect(surface.pressShape(actionOf("a"), ACTS)).toEqual({
        kind: "release",
        thresholdMs: 650,
        short: true,
        long: true,
      });
    });

    it("follows the gestures dialGestures resolves, not the settings directly", () => {
      surface.lifecycle(actionOf("a"), ACTS);
      surface.gestures.mockReturnValueOnce({ press: null, longPress: "go", tap: null, longTouch: null });

      expect(surface.pressShape(actionOf("a"), ACTS)).toEqual({
        kind: "release",
        thresholdMs: 500,
        short: false,
        long: true,
      });
    });

    it("clears short and long for gestures set to none", () => {
      surface.lifecycle(actionOf("a"), ACTS);

      expect(surface.pressShape(actionOf("a"), { ...ACTS, pressAction: "none", longPressAction: "none" })).toEqual({
        kind: "release",
        thresholdMs: 500,
        short: false,
        long: false,
      });
    });

    it("is never long, at an infinite threshold, with the extended gestures off", () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      surface.lifecycle(actionOf("a"), ACTS);

      expect(surface.pressShape(actionOf("a"), ACTS)).toEqual({
        kind: "release",
        thresholdMs: Number.POSITIVE_INFINITY,
        short: true,
        long: false,
      });
    });

    it("is none again once the context is forgotten", () => {
      surface.lifecycle(actionOf("a"), ACTS);
      surface.forget("a");

      expect(surface.pressShape(actionOf("a"), ACTS)).toEqual({ kind: "none" });
      expect(surface.gestures).not.toHaveBeenCalled();
    });
  });

  describe("touchShape (#269)", () => {
    it.each([false, true])("is none with no context (hold %s), and never asks for the gestures", (hold) => {
      expect(surface.touchShape(actionOf("ghost"), ACTS, hold)).toEqual({ kind: "none" });
      expect(surface.gestures).not.toHaveBeenCalled();
    });

    it("passes the stored context and the event's settings to dialGestures", () => {
      const ctx = surface.lifecycle(actionOf("a"), ACTS);
      const event = { ...ACTS, tapAction: "none" };

      surface.touchShape(actionOf("a"), event, false);

      expect(surface.gestures).toHaveBeenCalledWith(ctx, event);
    });

    it("is a tap for a tap whose gesture acts, and long for such a long touch", () => {
      surface.lifecycle(actionOf("a"), ACTS);

      expect(surface.touchShape(actionOf("a"), ACTS, false)).toEqual({ kind: "tap" });
      expect(surface.touchShape(actionOf("a"), ACTS, true)).toEqual({ kind: "long" });
    });

    it("is none for the slot set to none", () => {
      surface.lifecycle(actionOf("a"), ACTS);

      expect(surface.touchShape(actionOf("a"), { ...ACTS, tapAction: "none" }, false)).toEqual({ kind: "none" });
      expect(surface.touchShape(actionOf("a"), { ...ACTS, longTouchAction: "none" }, true)).toEqual({ kind: "none" });
    });

    it("is none for a slot dialGestures resolves to null", () => {
      surface.lifecycle(actionOf("a"), ACTS);
      surface.gestures.mockReturnValueOnce({ press: "go", longPress: "go", tap: null, longTouch: "go" });

      expect(surface.touchShape(actionOf("a"), ACTS, false)).toEqual({ kind: "none" });
    });

    it.each([false, true])("is none with the extended gestures off (hold %s)", (hold) => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);
      surface.lifecycle(actionOf("a"), ACTS);

      expect(surface.touchShape(actionOf("a"), ACTS, hold)).toEqual({ kind: "none" });
    });
  });
});

describe("gestureSlots", () => {
  it("maps the four *Action slots onto the four gestures", () => {
    expect(gestureSlots({ pressAction: "p", longPressAction: "lp", tapAction: "t", longTouchAction: "lt" })).toEqual({
      press: "p",
      longPress: "lp",
      tap: "t",
      longTouch: "lt",
    });
  });
});
