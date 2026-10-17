/**
 * The one walk through a recorded list of replay frames (#1426): Replay
 * Markers' rule (#1162, #1230), moved here so Replay Markers and Replay
 * Control's Next / Previous Lap and Next / Previous Session step through
 * their lists the same way. Design:
 * `docs/superpowers/specs/2026-10-12-issue-1426-replay-record-steps.md`
 * ("Stepping through a recorded list").
 *
 * A list is frame-ordered **landing frames**: the frame a jump to that entry
 * sends. Markers are their own frames; a lap start lands a second before the
 * line, a session start two seconds after it, which the caller works out
 * before it walks.
 *
 * - **The anchor** is where the replay is headed while a jump of the plugin's
 *   is under way (the one pending target, `replay-position-state.ts`, #1430),
 *   otherwise the cursor: the controller's debounced frame, which keeps the
 *   last frame a replay tick showed through the exit grace (#1324). With
 *   neither, a press has no cursor to step from.
 * - **Next** is the first landing more than {@link MARKER_NEXT_MIN_AHEAD_FRAMES}
 *   (1 s) past the anchor. **Previous** is the entry the anchor is in when the
 *   anchor is more than {@link MARKER_PREVIOUS_MIN_BEHIND_FRAMES} (2 s) past
 *   it, and the one before otherwise: a media player's previous-track. These
 *   are the marker windows, unchanged.
 * - **`steps`** entries are moved, at least one. The walk stops at the end of
 *   the list rather than wrapping and reports how many steps it took; zero
 *   steps is a miss.
 *
 * Pure apart from the anchor, which reads the gate's pending target.
 */
import { REPLAY_EXIT_GRACE_MS, type ReplayState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { MARKER_NEXT_MIN_AHEAD_FRAMES, MARKER_PREVIOUS_MIN_BEHIND_FRAMES } from "@iracedeck/replay-store";

import { readReplayPosition } from "./replay-command-gate.js";

/** The two ways a walk goes: forward (Next, a clockwise turn) or back (Previous, counter-clockwise). */
export type ReplayWalkDirection = "next" | "previous";

/** Where a walk ended: the landing frame, and how many entries it moved (at least 1). */
export interface ReplayWalkStep {
  readonly frame: number;
  readonly steps: number;
}

/**
 * The frame a walk is measured from: the replay's one pending target
 * (`shared/replay-position-state.ts`, #1430) while it stands, else
 * `liveFrame`. A jump records its frame as the target at the press, before
 * the pause it sends a moving replay, so a second press or a detent in that
 * window steps on from it rather than sending the same entry again; and the
 * target stands until its frame reads back, or, while the jump that sent it
 * still holds the cursor, for as long as its seek takes. Any surface's jump is
 * the target, a dial's frame move included: the replay is headed there.
 * `telemetry` is the reading the target is settled against.
 */
export function resolveReplayWalkAnchor(liveFrame: number, telemetry: TelemetryData | null): number {
  const headed = readReplayPosition(telemetry);

  return headed?.seeking === true ? headed.frame : liveFrame;
}

/**
 * The anchor of a press read from the controller's debounced replay state, or
 * null when there is no cursor to step from: no pending target, and a tick
 * still reading mid-seek (`IsReplayPlaying` false, frame 0) once the exit
 * grace has run out. A walk from that frame would send the list's first
 * entry, and a search sent into a seek ends it where it stands, so such a
 * press sends nothing. Within the grace the state holds the last frame a
 * replay tick showed, which is the cursor.
 */
export function resolveReplayWalkCursor(
  state: Pick<ReplayState, "frame" | "tickReplayPlaying" | "replaySeenAt">,
  telemetry: TelemetryData | null,
  nowMs: number,
): number | null {
  const headed = readReplayPosition(telemetry);

  if (headed?.seeking === true) return headed.frame;

  if (state.frame === null) return null;

  const held = state.replaySeenAt !== null && nowMs - state.replaySeenAt < REPLAY_EXIT_GRACE_MS;

  if (!state.tickReplayPlaying && !held) return null;

  return state.frame;
}

/**
 * The index of the entry whose moment is playing at `frame` — at it, or up to
 * {@link MARKER_PREVIOUS_MIN_BEHIND_FRAMES} (2 s) past it, the window Previous
 * treats as "still playing" — or -1. `frames` is ordered.
 */
export function recordedIndexAt(frames: readonly number[], frame: number): number {
  for (let i = frames.length - 1; i >= 0; i--) {
    const entry = frames[i];

    if (entry === undefined || entry > frame) continue;

    return frame - entry <= MARKER_PREVIOUS_MIN_BEHIND_FRAMES ? i : -1;
  }

  return -1;
}

/**
 * The index `steps - 1` entries on from `start` in `direction`, stopping at
 * the end of the list, with the number of entries actually moved counted from
 * `start` itself (so at least 1). `steps` below 1 counts as 1.
 */
export function walkRecordedIndex(
  length: number,
  start: number,
  direction: ReplayWalkDirection,
  steps: number,
): { index: number; steps: number } {
  const further = Math.max(0, Math.floor(steps) - 1);
  const sign = direction === "next" ? 1 : -1;
  const index = Math.min(length - 1, Math.max(0, start + sign * further));

  return { index, steps: 1 + Math.abs(index - start) };
}

/** The index of the first entry a step from `anchor` lands on, or -1 when there is none that way. */
function firstStepIndex(frames: readonly number[], anchor: number, direction: ReplayWalkDirection): number {
  if (direction === "next") return frames.findIndex((frame) => frame - anchor > MARKER_NEXT_MIN_AHEAD_FRAMES);

  let at = -1;

  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];

    if (frame !== undefined && frame <= anchor) {
      at = i;
      break;
    }
  }

  if (at === -1) return -1;

  const onEntry = anchor - (frames[at] ?? anchor) <= MARKER_PREVIOUS_MIN_BEHIND_FRAMES;

  return onEntry ? at - 1 : at;
}

/**
 * Steps `steps` entries through the frame-ordered landing frames `frames`
 * from `anchor`, or null on a miss: nothing that way, or zero steps. The
 * first step follows the marker windows (see the module header); each further
 * step is the next entry, stopping at the end of the list, and `steps` in the
 * result says how many were taken.
 */
export function stepRecordedFrames(
  frames: readonly number[],
  anchor: number,
  direction: ReplayWalkDirection,
  steps: number,
): ReplayWalkStep | null {
  if (!(Math.floor(steps) >= 1)) return null;

  const first = firstStepIndex(frames, anchor, direction);

  if (first < 0) return null;

  const walked = walkRecordedIndex(frames.length, first, direction, steps);
  const frame = frames[walked.index];

  return frame === undefined ? null : { frame, steps: walked.steps };
}
