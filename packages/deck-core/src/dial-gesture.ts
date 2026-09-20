/**
 * Shared dial-gesture convention for Stream Deck+ encoder actions.
 *
 * Three reusable pieces, identical across every dial action so they are defined
 * once here rather than re-implemented per action:
 *
 *  - {@link DirectionalPair} / {@link resolvePairedAction} — the "Push + Turn"
 *    value (one operation, two directions) and its per-tick dispatch.
 *  - {@link classifyDialRelease} — the release-time press classifier that
 *    decides, at `dialUp`, whether a press was a short push, a long press, or a
 *    push+turn. It is a duration comparison at release, NOT a `setTimeout` that
 *    fires mid-hold, so long-press never races push+turn.
 *  - {@link createHoldPreview} — the display-only hold preview (issue #1120):
 *    the one timer in this module, which draws and never dispatches.
 */

/**
 * Default hold duration (ms) at/above which a dial-button release counts as a
 * long press rather than a short press.
 */
export const DIAL_LONG_PRESS_THRESHOLD_MS = 500;

/**
 * A "Push + Turn" binding: one operation, two directions. `cw` fires on a
 * clockwise (positive-tick) pressed rotation, `ccw` on counter-clockwise.
 *
 * The two directions always belong to the SAME operation (more/less, finer
 * +/−), so encoding them as a single pair makes an incoherent split-direction
 * binding (e.g. CW = "fill to max", CCW = "toggle autofuel") unrepresentable.
 * This is a shared dial convention: every dial action exposes one
 * `pushTurnAction` setting whose value is such a pair; only the set of valid
 * pairs is per-action.
 */
export interface DirectionalPair<T> {
  cw: T;
  ccw: T;
}

/**
 * Picks the directional action for a pressed rotation from the sign of `ticks`:
 * `cw` for a positive sign, `ccw` for a negative one, and `null` for no movement
 * (or when no pair is configured). Dispatch the result once per rotate event.
 */
export function resolvePairedAction<T>(pair: DirectionalPair<T> | null | undefined, ticks: number): T | null {
  if (!pair) return null;

  if (ticks > 0) return pair.cw;

  if (ticks < 0) return pair.ccw;

  return null;
}

/** Outcome of classifying a dial-button release. */
export type DialReleaseKind = "short" | "long" | "push-turn";

/**
 * Classifies a dial-button release with full information (the issue #696 state
 * machine), so a short press and a long press never race a push+turn:
 *
 *  - if the dial was rotated while pressed → it was a push+turn → `"push-turn"`
 *    (fire nothing on release);
 *  - else a hold lasting at least `thresholdMs` → `"long"`;
 *  - else → `"short"`.
 *
 * This is a duration comparison evaluated once at release, not a timer that
 * fires mid-hold — there is no `setTimeout` to cancel and nothing fires on
 * `dialDown`.
 */
export function classifyDialRelease(args: {
  pressStartMs: number;
  nowMs: number;
  rotatedWhilePressed: boolean;
  thresholdMs?: number;
}): DialReleaseKind {
  const { pressStartMs, nowMs, rotatedWhilePressed, thresholdMs = DIAL_LONG_PRESS_THRESHOLD_MS } = args;

  if (rotatedWhilePressed) return "push-turn";

  return nowMs - pressStartMs >= thresholdMs ? "long" : "short";
}

/**
 * A per-context hold preview (issue #1120). One instance per dial context,
 * driven from the surface's own `down` / `up` / `rotate` / `willDisappear`.
 */
export interface HoldPreview {
  /**
   * Arms the preview for a new press, reading the threshold once — the hold is
   * previewed at the same instant a release would classify as `"long"`, and a
   * threshold changed mid-hold is ignored by both.
   */
  down(): void;
  /** Release: disarms, and reverts the strip if the preview was showing. */
  up(): void;
  /** A rotation while held (push+turn): disarms and reverts, same as a release. */
  rotated(): void;
  /**
   * Tears the preview down without reverting — for `willDisappear` (the context
   * is gone, so a frame pushed at it is wasted) and for a settings change, whose
   * own re-render is the revert.
   */
  dispose(): void;
  /** Whether the preview is on the strip right now. @internal Exported for testing */
  readonly showing: boolean;
}

/**
 * Creates the display-only hold preview: the strip shows what releasing now
 * would do, the moment the hold passes the long-press threshold.
 *
 * This is the ONE timer in the dial-gesture module, and it draws — it never
 * dispatches. {@link classifyDialRelease} at `dialUp` stays the only place a
 * press becomes an action, so every property the #681 rebuild bought survives:
 * push+turn still pre-empts both press kinds, a host that reports `dialUp`
 * instantly still degrades a hold to a short press, and no platform needs a
 * branch. The rule in `encoders-and-touchscreen.md` forbids a timer that decides
 * execution; a timer that only draws is what it was never forbidding.
 *
 * `onThreshold` returns whether it actually drew anything — a surface whose
 * long-press gesture is `none` has no outcome to show and returns `false`, which
 * is what stops the release pushing a pointless revert frame.
 */
export function createHoldPreview(args: {
  /** Draws the preview. Returns `true` when a preview frame was pushed. */
  onThreshold: () => boolean;
  /** Redraws the surface's normal strip after a preview that was showing. */
  onCancel: () => void;
  /** The long-press threshold, read once per press. Defaults to {@link DIAL_LONG_PRESS_THRESHOLD_MS}. */
  thresholdMs?: () => number;
}): HoldPreview {
  const { onThreshold, onCancel, thresholdMs } = args;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let showing = false;

  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const revert = (): void => {
    disarm();

    if (!showing) return;

    showing = false;
    onCancel();
  };

  return {
    down(): void {
      // A `down` without its `up` (a dropped release) must not leave the old
      // timer armed or the old preview believed to be on the strip.
      revert();

      const delay = thresholdMs ? thresholdMs() : DIAL_LONG_PRESS_THRESHOLD_MS;

      timer = setTimeout(
        () => {
          timer = null;
          showing = onThreshold();
        },
        Math.max(0, delay),
      );
    },
    up: revert,
    rotated: revert,
    dispose(): void {
      disarm();
      showing = false;
    },
    get showing(): boolean {
      return showing;
    },
  };
}
