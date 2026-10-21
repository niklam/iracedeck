/**
 * What a move of the replay by frames sends (#1317, moved here for #1430): one
 * frame step, one absolute jump, or nothing. Frame Jog's own rule, now every
 * sender's: a Frame Forward or Frame Backward key, its long-press repeat and a
 * dial detent are one code path through the replay command gate
 * (`replay-command-gate.ts`), with one end-of-tape margin.
 *
 * It follows from how iRacing treats the two commands that can move a replay
 * by frames, measured on 2026-10-12 and recorded in `replay-position-state.ts`:
 * a frame step is immediate but only one counts per sim update, and it wrecks
 * a position jump still under way; an absolute jump may follow another at any
 * pace and the newest wins, but from the second one on the replay takes some
 * 400 ms to show it. So a single step on a replay at rest is a frame step, and
 * everything else — several frames at once, or any move while the last one
 * has not read back — is one absolute jump to the frame the move is heading
 * for. A jump relative to the current frame is never sent: iRacing resolves
 * one from the start of the recording while an earlier jump is settling, which
 * is what threw the replay to 0:00.00 on a fast Frame Jog turn.
 */
import type { ReplayPosition } from "./replay-position-state.js";

/**
 * @internal Exported for testing
 *
 * How many frames short of the recording's end a position jump is aimed at
 * most. Measured on 2026-10-12 against a saved replay: a jump to any of the
 * last four frames, or past the end, lands five frames short of it, so its
 * target never reads back; frame steps go on to the last frame but one. Five
 * is that measurement and the rest is slack. It is not relied on: aimed too
 * far on another recording, a jump is one more target that does not read
 * back and is given up, and the frames past the margin are still reached one
 * step at a time.
 */
export const JUMP_END_MARGIN_FRAMES = 8;

/** What one move sends: one frame step, one absolute jump, or nothing. */
export type FrameMove =
  { kind: "step"; direction: 1 | -1 } | { kind: "jump"; frame: number } | { kind: "none"; reason: string };

/**
 * Decides what a move of `ticks` frames (positive is forward) sends from
 * where the replay stands or is headed. Nothing when that is not known, and
 * nothing when the replay is at rest on the end of the recording the move
 * points at. A frame step only for a single frame with nothing under way;
 * otherwise an absolute jump, measured from the pending target while one
 * stands — also when that is the frame it already asks for, since a target
 * that has not read back is put right by asking again.
 *
 * The last frames of the recording are the exception, because a jump cannot
 * land there ({@link JUMP_END_MARGIN_FRAMES}) and a step can: a jump is aimed
 * no further than the margin, a move of several frames past it is one frame
 * step, and while a move into that stretch has not read back nothing is sent,
 * since a step has to wait and a jump would pull the replay back.
 */
export function planFrameMove(ticks: number, position: ReplayPosition | null): FrameMove {
  if (position === null) return { kind: "none", reason: "the replay's position is not known" };

  const { frame, endFrame, seeking } = position;
  const direction = ticks > 0 ? 1 : -1;
  // A step reaches the last frame but one; a jump stops short of the margin.
  const lastStep = endFrame === undefined ? Infinity : endFrame - 1;
  const lastJump = endFrame === undefined ? Infinity : endFrame - JUMP_END_MARGIN_FRAMES;
  const target = ticks > 0 ? Math.min(frame + ticks, Math.max(frame, lastStep)) : Math.max(frame + ticks, 0);

  if (seeking) {
    if (target <= lastJump || frame <= lastJump) return { kind: "jump", frame: Math.min(target, lastJump) };

    return { kind: "none", reason: "a move into the last frames of the recording has not read back" };
  }

  if (target === frame) return { kind: "none", reason: `at the ${ticks > 0 ? "end" : "start"} of the recording` };

  if (Math.abs(ticks) === 1) return { kind: "step", direction };

  if (target <= lastJump) return { kind: "jump", frame: target };

  // Several frames towards frames only a step reaches: as far as a jump goes, then one frame per move.
  if (ticks > 0 && frame < lastJump) return { kind: "jump", frame: lastJump };

  return { kind: "step", direction };
}

/**
 * The frame beside `frame` a takeover jumps to (#1430): one forward, where a
 * frame that cannot be landed on resolves (a session boundary rests on the
 * next session's first frame), and one back only inside the end-of-tape
 * margin, where forward cannot move.
 */
export function frameBeside(frame: number, endFrame: number | undefined): number {
  if (endFrame !== undefined && frame + 1 > endFrame - JUMP_END_MARGIN_FRAMES) return Math.max(0, frame - 1);

  return frame + 1;
}
