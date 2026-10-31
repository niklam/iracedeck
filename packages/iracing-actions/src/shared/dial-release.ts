import { classifyDialRelease, type DialReleaseKind, type PressShape } from "@iracedeck/deck-core";

/**
 * Classifies a dial release for the host this build targets (#1013).
 *
 * Where the extended gestures are compiled in (Stream Deck+), this is deck-core's
 * `classifyDialRelease`: push+turn, then long versus short by the threshold.
 *
 * Where they are compiled out (Mirabox, Ulanzi) there is no long press — a
 * Mirabox knob press never reports its release, so the adapter completes it at
 * its dialDown and no release ever measures a hold — and so every release is a
 * short press. The one exception is a release
 * after the knob was turned while pressed: that is still classified as
 * push+turn, so the surface fires nothing for it rather than a press the driver
 * did not make. The Mirabox host sends no dialRotate while pressed, so on that
 * host the exception is a guard rather than a gesture.
 *
 * Every dial surface calls this one helper rather than repeating the flag test,
 * so a host's release rule is decided in exactly one place.
 */
export function classifyDialReleaseForHost(args: {
  pressStartMs: number;
  nowMs: number;
  rotatedWhilePressed: boolean;
  thresholdMs?: number;
}): DialReleaseKind {
  if (__FEATURE_DIAL_EXTENDED_GESTURES__) return classifyDialRelease(args);

  return args.rotatedWhilePressed ? "push-turn" : "short";
}

/**
 * A gesture slot as a surface resolves it for one outcome: the slot's value,
 * where `"none"` (or `null`, for a surface that resolves a slot to nothing,
 * as Replay Control's `resolveDialGesture` does) fires nothing.
 */
export type ResolvedDialGesture = string | null;

function gestureActs(gesture: ResolvedDialGesture): boolean {
  return gesture !== null && gesture !== "none";
}

/**
 * The press shape of a dial press (#269), which an action's `dialPressShape`
 * returns through its dial surface: decided at release, the tap sound on a
 * short release when the press gesture does something and the long sound at
 * the threshold when the long-press gesture does. Every dial surface that
 * classifies at release passes the gestures it would fire at its `up` and the
 * threshold it hands {@link classifyDialReleaseForHost}.
 *
 * Keyed on the same flag as {@link classifyDialReleaseForHost}: where the
 * extended gestures are compiled out (Mirabox, Ulanzi) no release is long, so
 * `long` is false and the threshold is `Infinity`, which arms no timer — the
 * press sounds can never call a Mirabox knob release long, whatever the timing.
 */
export function dialGestureShape(args: {
  pressGesture: ResolvedDialGesture;
  longPressGesture: ResolvedDialGesture;
  thresholdMs: number;
}): PressShape {
  const short = gestureActs(args.pressGesture);

  if (!__FEATURE_DIAL_EXTENDED_GESTURES__) {
    return { kind: "release", thresholdMs: Number.POSITIVE_INFINITY, short, long: false };
  }

  return { kind: "release", thresholdMs: args.thresholdMs, short, long: gestureActs(args.longPressGesture) };
}

/**
 * The press shape of a touch on a dial's strip (#269), which an action's
 * `touchPressShape` returns through its dial surface. A touch arrives
 * complete, its `hold` saying whether it was a long touch: `tap` for a tap
 * whose gesture does something, `long` for such a long touch, `none` when the
 * slot fires nothing — and `none` wherever the extended gestures are compiled
 * out, since every surface's `touchTap` returns at once there.
 */
export function touchGestureShape(args: {
  tapGesture: ResolvedDialGesture;
  longTouchGesture: ResolvedDialGesture;
  hold: boolean;
}): PressShape {
  if (!__FEATURE_DIAL_EXTENDED_GESTURES__) return { kind: "none" };

  if (!gestureActs(args.hold ? args.longTouchGesture : args.tapGesture)) return { kind: "none" };

  return args.hold ? { kind: "long" } : { kind: "tap" };
}
