/**
 * The base every dial surface extends (#1589).
 *
 * A dial surface keeps per-context state for the dials of one action. Two
 * cross-cutting rules govern that state, and both live here once instead of
 * in every surface:
 *
 * - **The context lifecycle and the late-input gate (#1329).** Lifecycle
 *   events (`willAppear`, `didReceiveSettings`) create a context through
 *   {@link DialSurfaceBase.ensureContext}; input events (`rotate`, `down`,
 *   `touchTap`) only ever act on one that exists, through
 *   {@link DialSurfaceBase.inputContext}; `willDisappear` removes it through
 *   {@link DialSurfaceBase.forgetContext}. The map is private to this class, so
 *   those two members are its only writers by construction.
 * - **The press shapes (#269).** A surface that classifies its presses at
 *   release extends {@link ReleaseDialSurfaceBase}, says which gestures one
 *   context would fire, and inherits `pressShape` / `touchShape`.
 *
 * What a surface draws, times or dispatches stays in the surface: the creation
 * literal and its hold preview, the refresh rule (rule 10 of
 * `.claude/rules/encoders-and-touchscreen.md`), its `willDisappear` teardown
 * order and every input member. Sim-neutral, like the other `dial-*` modules
 * (`dial-sim-agnostic.test.ts`).
 */
import { getDualPressThresholdMs, type IDeckActionContext, type PressShape } from "@iracedeck/deck-core";

import { type DialInputEvent, hasDialInputContext } from "./dial-context.js";
import { dialGestureShape, type ResolvedDialGesture, touchGestureShape } from "./dial-release.js";

/** What the base reads from a surface's host: the logger the gate's one drop line goes to. */
export interface DialSurfaceHost {
  readonly logger: { debug(message: string): void };
}

/**
 * The four gesture slots a surface fires, resolved for one context: what its
 * release fires short and long, and what its touch fires as a tap and as a long
 * touch. `"none"` or `null` fires nothing.
 */
export interface DialGestures {
  press: ResolvedDialGesture;
  longPress: ResolvedDialGesture;
  tap: ResolvedDialGesture;
  longTouch: ResolvedDialGesture;
}

/** The common case: the four `*Action` slots of a dial settings object, unresolved. */
export function gestureSlots(dial: {
  pressAction: string;
  longPressAction: string;
  tapAction: string;
  longTouchAction: string;
}): DialGestures {
  return {
    press: dial.pressAction,
    longPress: dial.longPressAction,
    tap: dial.tapAction,
    longTouch: dial.longTouchAction,
  };
}

/**
 * The context lifecycle every dial surface shares. `Ctx` is the surface's own
 * per-context state and `S` the settings its lifecycle and input members take
 * (the `dial` sub-object for most surfaces, the whole settings for some).
 */
export abstract class DialSurfaceBase<Ctx extends { action: IDeckActionContext }, S> {
  /**
   * Per-context state, keyed by action id. Private: only `ensureContext` and
   * `forgetContext` write it, and the gate in `inputContext` reads it directly,
   * so the gate and the writes see one map whatever a subclass declares.
   */
  private readonly contextMap = new Map<string, Ctx>();

  /**
   * The read-only view every surface reads (`get`, `has`, `values`, `size`). It
   * is the live map itself, so a test's `surface["contextsState"]` reads current
   * state; a `set`, `delete` or `clear` through it is a type error. The release
   * press shapes read the map through it, so a surface must not override it;
   * the coverage guard (`actions/dial-surface-base-coverage.test.ts`) refuses
   * one that does.
   */
  protected get contextsState(): ReadonlyMap<string, Ctx> {
    return this.contextMap;
  }

  /** The surface's host; the base reads only its logger, at call time. */
  protected abstract readonly host: DialSurfaceHost;

  /**
   * A new context for a lifecycle event, built whole (hold preview included)
   * but not stored: {@link ensureContext} stores it. Nothing it builds may read
   * the map for its own id while building; closures that read it later, at call
   * time, are fine.
   */
  protected abstract createContext(action: IDeckActionContext, settings: S): Ctx;

  /**
   * What a lifecycle or input event refreshes on an EXISTING context. A surface
   * that persists its settings plugin-side keeps its stored settings
   * authoritative and refreshes the action only (rule 10); the rest refresh
   * the action and the settings. Abstract with no default, so each surface
   * writes its rule down.
   */
  protected abstract refreshContext(ctx: Ctx, action: IDeckActionContext, settings: S): void;

  /**
   * Look up or create the per-context state — for the LIFECYCLE events
   * (`willAppear`, `didReceiveSettings`) only. Input events go through
   * {@link inputContext}, which never creates a context (#1329).
   */
  protected ensureContext(action: IDeckActionContext, settings: S): Ctx {
    const existing = this.contextMap.get(action.id);

    if (existing) {
      this.refreshContext(existing, action, settings);

      return existing;
    }

    const ctx = this.createContext(action, settings);
    this.contextMap.set(action.id, ctx);

    return ctx;
  }

  /**
   * The context an INPUT event (rotate, down, touchTap) acts on: the existing
   * one, refreshed exactly as {@link ensureContext} refreshes it, or `undefined`
   * — never a new one (#1329). A late event the host delivers after
   * `willDisappear` is dropped here, before it can re-create the entry or act
   * on a context that is gone; the drop is logged at debug by
   * `hasDialInputContext`, in the one wording the whole family uses.
   */
  protected inputContext(action: IDeckActionContext, settings: S, event: DialInputEvent): Ctx | undefined {
    return hasDialInputContext(this.contextMap, action.id, event, this.host.logger)
      ? this.ensureContext(action, settings)
      : undefined;
  }

  /**
   * The one place a context leaves the map. Each surface's `willDisappear`
   * calls it at the point it removes the context, after or before its own
   * teardown as that surface's order requires.
   */
  protected forgetContext(actionId: string): void {
    this.contextMap.delete(actionId);
  }
}

/**
 * A dial surface whose presses are decided at release (#269): every surface
 * but Audio Controls, whose presses fire at `dialDown` and whose action
 * declares their shape itself. It says which gestures one context fires and
 * inherits the press shapes its action's `dialPressShape` / `touchPressShape`
 * return.
 */
export abstract class ReleaseDialSurfaceBase<Ctx extends { action: IDeckActionContext }, S> extends DialSurfaceBase<
  Ctx,
  S
> {
  /**
   * The gestures this context's release and touch would fire, given the input
   * event's settings. A surface whose stored settings are authoritative reads
   * them from `ctx` instead; one that resolves its slots (Replay Control) does
   * so here. Called only for a context that exists.
   */
  protected abstract dialGestures(ctx: Ctx, settings: S): DialGestures;

  /**
   * The press shape of a dial press (#269): released, with the gestures the
   * release fires and the threshold it classifies with, or `none` when no
   * context would take the press. `down` and `touchTap` refresh the context
   * from the event's settings, so those are the ones the release and the touch
   * read, unless the surface keeps its stored settings authoritative.
   */
  pressShape(action: IDeckActionContext, settings: S): PressShape {
    const ctx = this.contextsState.get(action.id);

    if (!ctx) return { kind: "none" };

    const gestures = this.dialGestures(ctx, settings);

    return dialGestureShape({
      pressGesture: gestures.press,
      longPressGesture: gestures.longPress,
      thresholdMs: getDualPressThresholdMs(),
    });
  }

  /** The press shape of a touch (#269): the slot `touchTap` fires for it, or `none` when no context would take it. */
  touchShape(action: IDeckActionContext, settings: S, hold: boolean): PressShape {
    const ctx = this.contextsState.get(action.id);

    if (!ctx) return { kind: "none" };

    const gestures = this.dialGestures(ctx, settings);

    return touchGestureShape({ tapGesture: gestures.tap, longTouchGesture: gestures.longTouch, hold });
  }
}
