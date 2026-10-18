/**
 * What a replay key or dial box draws for the busy indicator's answer (#1437):
 * the bridge from {@link ReplayBusyLook}, which the indicator decides, to the
 * `BusyMark` that `assembleIcon` and `busyMarkSvg` draw on a key, and to the
 * caption mark `shared/dial-caption-mark.ts` draws on a dial box. Pure, so both
 * actions (Replay Control, Replay Markers) draw the same step for the same
 * tick, and the same look is the same text.
 *
 * The dial half lives here rather than beside the drawing because the
 * `shared/dial-*` modules import deck-core and zod only: the mapping reads the
 * indicator's type, and the drawing must not.
 *
 * Spec: docs/superpowers/specs/2026-10-13-issue-1437-replay-key-busy-look.md.
 */
import { BUSY_MARK_FRAMES, type BusyMark } from "@iracedeck/deck-core";

import type { DialCaptionMark } from "./dial-caption-mark.js";
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

/**
 * The dial box's mark for the replay busy indicator's answer (#1437), or
 * undefined at rest. The mark has three positions, not the key ring's eight,
 * and steps on every second tick: position `Math.floor(tick / 2) % 3`, so
 * the box pushes four frames a second while it spins.
 */
export function replayBusyDialMark(look: ReplayBusyLook): DialCaptionMark | undefined {
  switch (look.kind) {
    case "rest":
      return undefined;
    case "working":
      return { kind: "working", position: (Math.floor(look.tick / 2) % 3) as 0 | 1 | 2 };
    case "waiting":
    case "not-done":
      return { kind: look.kind };
  }
}
