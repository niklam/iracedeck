/**
 * The one walk through a recorded list of replay frames (#1426): Replay
 * Markers' rule (#1162, #1230), moved here so Replay Markers and Replay
 * Control's Next / Previous Lap and Next / Previous Session step through
 * their lists the same way. Design:
 * `docs/superpowers/specs/2026-10-12-issue-1426-replay-record-steps.md`
 * ("Stepping through a recorded list").
 *
 * A list is frame-ordered **recorded frames**: a marker, a lap start, a
 * session start, as recorded. The walk decides direction on those, and the
 * caller adds its landing offset to the entry it returns — a lap start lands a
 * second before the line, a session start two seconds after it, a marker on
 * itself. Walking the landings instead would put a cursor between a session's
 * start and its landing (after Jump to Beginning, or iRacing's own search)
 * before that session's landing, and Next would land in the same session.
 *
 * - **The anchor** is where the replay is headed while a jump of the plugin's
 *   is under way (the one pending target, `replay-position-state.ts`, #1430),
 *   otherwise the cursor: the controller's debounced frame, which keeps the
 *   last frame a replay tick showed through the exit grace (#1324). With
 *   neither, a press has no cursor to step from.
 * - **Next** is the first entry more than {@link MARKER_NEXT_MIN_AHEAD_FRAMES}
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

/** Where a walk ended: the entry's frame, and how many entries it moved (at least 1). */
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

/** Where a press steps from, or why it has nowhere to step from. */
export type ReplayWalkStart =
  | { readonly frame: number; readonly from: "target" | "cursor" }
  | { readonly frame: null; readonly reason: "not in a replay" | "no cursor" };

/**
 * Where a press steps from, read from the controller's debounced replay
 * state: the pending target while one stands, else the cursor. A standing
 * target wins even where the debounced state has given the replay up — a
 * seek longer than the exit grace reads like a replay that was left in a live
 * session — since the plugin's own jump is still headed there, as the gate
 * holds too. Otherwise there is no step outside a replay, and none with no
 * cursor: a tick still reading mid-seek (`IsReplayPlaying` false, frame 0)
 * once the exit grace has run out, where a walk would send the list's first
 * entry and a search would end the seek where it stands. Within the grace the
 * state holds the last frame a replay tick showed, which is the cursor.
 */
export function resolveReplayWalkStart(
  state: Pick<ReplayState, "inReplay" | "frame" | "tickReplayPlaying" | "replaySeenAt">,
  telemetry: TelemetryData | null,
  nowMs: number,
): ReplayWalkStart {
  const headed = readReplayPosition(telemetry);

  if (headed?.seeking === true) return { frame: headed.frame, from: "target" };

  if (!state.inReplay) return { frame: null, reason: "not in a replay" };

  const held = state.replaySeenAt !== null && nowMs - state.replaySeenAt < REPLAY_EXIT_GRACE_MS;

  if (state.frame === null || (!state.tickReplayPlaying && !held)) return { frame: null, reason: "no cursor" };

  return { frame: state.frame, from: "cursor" };
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

/** The index of the last entry at or before `anchor`, or -1. `frames` is ordered. */
function containingIndex(frames: readonly number[], anchor: number): number {
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];

    if (frame !== undefined && frame <= anchor) return i;
  }

  return -1;
}

/** The index of the first entry a step from `anchor` lands on, or -1 when there is none that way. */
function firstStepIndex(frames: readonly number[], anchor: number, direction: ReplayWalkDirection): number {
  if (direction === "next") return frames.findIndex((frame) => frame - anchor > MARKER_NEXT_MIN_AHEAD_FRAMES);

  const at = containingIndex(frames, anchor);

  if (at === -1) return -1;

  const onEntry = anchor - (frames[at] ?? anchor) <= MARKER_PREVIOUS_MIN_BEHIND_FRAMES;

  return onEntry ? at - 1 : at;
}

/** An entry of a recorded list: whatever it is, it sits at a frame. */
export interface RecordedEntry {
  readonly frame: number;
}

/** Why a walk moved nowhere. */
export type RecordedWalkMissReason = "nothing that way";

/** Where a walk ended — the entry, its index and how many entries it moved (at least 1) — or why it did not move. */
export type RecordedWalkResult<T extends RecordedEntry> =
  | { readonly hit: true; readonly entry: T; readonly index: number; readonly steps: number }
  | { readonly hit: false; readonly reason: RecordedWalkMissReason };

/**
 * Steps `steps` entries through the frame-ordered `entries` from `anchor`.
 * The comparison is on the entries' own frames, the moments recorded; a
 * caller whose jump lands off the entry (a lap's lead-in, a session's
 * landing) adds that offset to the entry the walk returns, and never walks the
 * landings, so a cursor between a start and its landing still counts as in
 * that entry. The first step follows the marker windows (see the module
 * header); each further step is the next entry, stopping at the end of the
 * list, and `steps` in the result says how many were taken. A miss is
 * `nothing that way`, zero steps included.
 */
export function walkRecordedEntries<T extends RecordedEntry>(
  entries: readonly T[],
  anchor: number,
  direction: ReplayWalkDirection,
  steps: number,
): RecordedWalkResult<T> {
  if (!(Math.floor(steps) >= 1)) return { hit: false, reason: "nothing that way" };

  const frames = entries.map((entry) => entry.frame);
  const first = firstStepIndex(frames, anchor, direction);

  if (first < 0) return { hit: false, reason: "nothing that way" };

  const walked = walkRecordedIndex(entries.length, first, direction, steps);
  const entry = entries[walked.index];

  return entry === undefined
    ? { hit: false, reason: "nothing that way" }
    : { hit: true, entry, index: walked.index, steps: walked.steps };
}

/**
 * Steps `steps` entries through the frame-ordered frames `frames` from
 * `anchor`, or null on a miss: {@link walkRecordedEntries} over bare frames.
 */
export function stepRecordedFrames(
  frames: readonly number[],
  anchor: number,
  direction: ReplayWalkDirection,
  steps: number,
): ReplayWalkStep | null {
  const walked = walkRecordedEntries(
    frames.map((frame) => ({ frame })),
    anchor,
    direction,
    steps,
  );

  return walked.hit ? { frame: walked.entry.frame, steps: walked.steps } : null;
}
