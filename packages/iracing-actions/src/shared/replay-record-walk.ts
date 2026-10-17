/**
 * The one walk through a recorded list of replay frames (#1426): Replay
 * Markers' rule (#1162, #1230), moved here so Replay Markers and Replay
 * Control's Next / Previous Lap and Next / Previous Session step through
 * their lists the same way. Design:
 * `docs/superpowers/specs/2026-10-12-issue-1426-replay-record-steps.md`
 * ("Stepping through a recorded list").
 *
 * A list is frame-ordered **recorded frames**: a marker, a lap start, a
 * session start, as recorded. The walk finds the entry the anchor is in, and
 * Next's entry, on those, and the caller adds its landing offset to the entry
 * it returns — a lap start lands a second before the line, a session start
 * two seconds after it, a marker on itself. Walking the landings instead would
 * put a cursor between a session's start and its landing (after Jump to
 * Beginning, or iRacing's own search) before that session's landing, and Next
 * would land in the same session. Previous's window is the one thing measured
 * from the landing (see below).
 *
 * - **The anchor** is where the replay is headed while a jump of the plugin's
 *   is under way (the one pending target, `replay-position-state.ts`, #1430),
 *   otherwise the cursor: the controller's debounced frame, which keeps the
 *   last frame a replay tick showed through the exit grace (#1324). With
 *   neither, a press has no cursor to step from.
 * - **Next** is the first entry more than {@link MARKER_NEXT_MIN_AHEAD_FRAMES}
 *   (1 s) past the anchor. **Previous** is the entry the anchor is in when the
 *   anchor is more than {@link MARKER_PREVIOUS_MIN_BEHIND_FRAMES} (2 s) past
 *   that entry's **landing**, and the one before otherwise: a media player's
 *   previous-track. These are the marker windows, unchanged; a marker lands on
 *   itself, so for Replay Markers the landing is the entry. Measured from the
 *   raw start instead, a session's landing (start + 120) on a replay the jump
 *   left playing is past the window within a frame, and every Previous Session
 *   press after the first went back to the same session's start.
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
 * entry. Within the grace the state holds the last frame a replay tick
 * showed, which is the cursor. What a press does with `no cursor` is the
 * caller's: Replay Control's record step sends the key's search, which the
 * gate holds while a seek shows.
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

/**
 * The index of the first entry a step from `anchor` lands on, or -1 when there
 * is none that way. Next compares recorded frames; Previous finds the entry
 * the anchor is in on recorded frames and measures its window from that
 * entry's landing, `landingAt(index)`.
 */
function firstStepIndex(
  frames: readonly number[],
  anchor: number,
  direction: ReplayWalkDirection,
  landingAt: (index: number) => number,
): number {
  if (direction === "next") return frames.findIndex((frame) => frame - anchor > MARKER_NEXT_MIN_AHEAD_FRAMES);

  const at = containingIndex(frames, anchor);

  if (at === -1) return -1;

  const onEntry = anchor - landingAt(at) <= MARKER_PREVIOUS_MIN_BEHIND_FRAMES;

  return onEntry ? at - 1 : at;
}

/** An entry of a recorded list: whatever it is, it sits at a frame. */
export interface RecordedEntry {
  readonly frame: number;
}

/**
 * Why a walk moved nowhere. `nothing that way` is the end of the list (or no
 * step asked for); the other two come only from a walk with a
 * {@link RecordedSpanRule}: `outside the record` when the anchor lies in no
 * recorded span, `gap in the record` when the first step would cross one.
 */
export type RecordedWalkMissReason = "nothing that way" | "outside the record" | "gap in the record";

/** Where a walk ended — the entry, its index and how many entries it moved (at least 1) — or why it did not move. */
export type RecordedWalkResult<T extends RecordedEntry> =
  | { readonly hit: true; readonly entry: T; readonly index: number; readonly steps: number }
  | { readonly hit: false; readonly reason: RecordedWalkMissReason };

/**
 * Which consecutive entries of a list follow each other in the record, for a
 * list whose record can have gaps (#1426): laps are recorded only while the
 * driver is in the car, so a stint in the garage leaves laps out, and a
 * session the plugin never saw has no start. An entry's **span** runs from it
 * to the next entry when the two are {@link adjacent}; the last entry's span
 * runs on only when {@link lastSpanOpen} says so.
 */
export interface RecordedSpanRule<T extends RecordedEntry> {
  /** Whether `b`, the entry after `a` in the list, is the next one in the record. */
  adjacent(a: T, b: T): boolean;
  /** Whether the last entry's span is open-ended: nothing after it can be missing from the record. */
  readonly lastSpanOpen: boolean;
}

/**
 * Steps `steps` entries through the frame-ordered `entries` from `anchor`.
 * The entry the anchor is in, and Next's entry, are found on the entries' own
 * frames, the moments recorded; a caller whose jump lands off the entry (a
 * lap's lead-in, a session's landing) adds that offset to the entry the walk
 * returns, and never walks the landings, so a cursor between a start and its
 * landing still counts as in that entry. Previous's window is measured from
 * `landing(entry)` of the entry the anchor is in, so a press after a jump's
 * own landing, on a replay left playing, goes back past that entry rather
 * than to it again; `landing` defaults to the entry's frame (Replay Markers).
 * The first step follows the marker windows (see the module header); each
 * further step is the next entry, stopping at the end of the list, and
 * `steps` in the result says how many were taken. A miss is `nothing that
 * way`, zero steps included.
 *
 * With a `rule`, the walk steps only through the record and never across a
 * gap in it, so the caller can fall back to the sim's own search there:
 *
 * - the anchor must lie in a recorded span — the last entry at or before it
 *   exists, and is adjacent to the entry after it, or is the last entry of a
 *   list whose last span is open — else `outside the record`;
 * - every pair of entries a step crosses must be adjacent: a first step that
 *   would cross a gap is `gap in the record`, and a further step stops before
 *   one, reporting the steps taken.
 *
 * Without a rule (Replay Markers) every pair counts as adjacent and the anchor
 * needs no span: the walk is the marker rule as it always was.
 */
export function walkRecordedEntries<T extends RecordedEntry>(
  entries: readonly T[],
  anchor: number,
  direction: ReplayWalkDirection,
  steps: number,
  rule?: RecordedSpanRule<T>,
  landing: (entry: T) => number = (entry) => entry.frame,
): RecordedWalkResult<T> {
  const wanted = Math.floor(steps);

  if (!(wanted >= 1)) return { hit: false, reason: "nothing that way" };

  /** Whether entries `i` and `i + 1` follow each other in the record. */
  const joined = (i: number): boolean => {
    const a = entries[i];
    const b = entries[i + 1];

    return a !== undefined && b !== undefined && (rule === undefined || rule.adjacent(a, b));
  };
  const frames = entries.map((entry) => entry.frame);
  const containing = containingIndex(frames, anchor);

  if (rule !== undefined) {
    const inSpan = containing >= 0 && (containing === entries.length - 1 ? rule.lastSpanOpen : joined(containing));

    if (!inSpan) return { hit: false, reason: "outside the record" };
  }

  const first = firstStepIndex(frames, anchor, direction, (i) => {
    const entry = entries[i];

    return entry === undefined ? anchor : landing(entry);
  });

  if (first < 0) return { hit: false, reason: "nothing that way" };

  // The pairs between the entry the anchor is in and the first step's entry:
  // Next crosses every one up to it, Previous the one before the anchor's
  // entry when it goes back past it. Without a rule an anchor before the list
  // is in no entry, and its first Next crosses nothing.
  for (let i = Math.max(0, Math.min(containing, first)); i < Math.max(containing, first); i++) {
    if (!joined(i)) return { hit: false, reason: "gap in the record" };
  }

  const sign = direction === "next" ? 1 : -1;
  let index = first;
  let taken = 1;

  while (taken < wanted) {
    const further = index + sign;

    if (further < 0 || further >= entries.length || !joined(Math.min(index, further))) break;

    index = further;
    taken++;
  }

  const entry = entries[index];

  return entry === undefined ? { hit: false, reason: "nothing that way" } : { hit: true, entry, index, steps: taken };
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
