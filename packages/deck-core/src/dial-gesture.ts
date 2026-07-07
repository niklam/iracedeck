/**
 * Shared dial-gesture convention for Stream Deck+ encoder actions.
 *
 * Two reusable pieces, identical across every dial action so they are defined
 * once here rather than re-implemented per action:
 *
 *  - {@link DirectionalPair} / {@link resolvePairedAction} — the "Push + Turn"
 *    value (one operation, two directions) and its per-tick dispatch.
 *  - {@link classifyDialRelease} — the release-time press classifier that
 *    decides, at `dialUp`, whether a press was a short push, a long press, or a
 *    push+turn. It is a duration comparison at release, NOT a `setTimeout` that
 *    fires mid-hold, so long-press never races push+turn.
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
