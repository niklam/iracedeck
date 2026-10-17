/**
 * What a replay key draws for the busy indicator's answer (#1437): the bridge
 * from {@link ReplayBusyLook}, which the indicator decides, to the
 * `BusyMark` that `assembleIcon` and `busyMarkSvg` draw. Pure, so both key
 * actions (Replay Control, Replay Markers) draw the same step for the same
 * tick, and the same look is the same text.
 *
 * Spec: docs/superpowers/specs/2026-10-13-issue-1437-replay-key-busy-look.md.
 */
import { BUSY_MARK_FRAMES, type BusyMark } from "@iracedeck/deck-core";

import type { ReplayBusyLook } from "./replay-busy-indicator.js";

/**
 * The mark a key draws for `look`: none at rest, and the working ring at step
 * `tick % BUSY_MARK_FRAMES`, so the bright dot goes round once every eight
 * ticks.
 */
export function replayBusyKeyMark(look: ReplayBusyLook): BusyMark | undefined {
  switch (look.kind) {
    case "rest":
      return undefined;
    case "working":
      return { kind: "working", step: look.tick % BUSY_MARK_FRAMES };
    case "waiting":
      return { kind: "waiting" };
    case "not-done":
      return { kind: "not-done" };
  }
}

/**
 * A short text naming `mark`, for a key's redraw de-duplication: two equal
 * texts draw the same mark, and no mark is `"rest"`.
 */
export function replayBusyMarkKey(mark: BusyMark | undefined): string {
  if (mark === undefined) return "rest";

  return mark.kind === "working" ? `working:${mark.step}` : mark.kind;
}
