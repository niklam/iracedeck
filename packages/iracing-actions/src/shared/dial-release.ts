import { classifyDialRelease, type DialReleaseKind } from "@iracedeck/deck-core";

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
