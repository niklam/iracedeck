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
 *   else the landing of a search of the plugin's still on its way, which a
 *   press waits for (#1660, {@link awaitReplayWalkStart}), otherwise the
 *   cursor: the controller's debounced cursor read, which keeps the last
 *   frame a replay tick showed through the exit grace (#1324) and the seek
 *   hold (#1429). With none of them, a press has no cursor to step from.
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
 * The walk itself is pure. The start reads the gate's pending target and its
 * search record; its async companion keeps the one queue of presses waiting
 * for a search to land, which `_resetReplayEngine` clears.
 */
import type { ReplayState, TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { MARKER_NEXT_MIN_AHEAD_FRAMES, MARKER_PREVIOUS_MIN_BEHIND_FRAMES } from "@iracedeck/replay-store";

import {
  closeReplayGateWait,
  openReplayGateWait,
  readReplayPosition,
  replaySearchOnItsWay,
  type ReplaySearchOnItsWay,
  waitForReplaySearchLanding,
} from "./replay-command-gate.js";
import { engineLogger } from "./replay-engine-env.js";
import { SEARCH_QUEUE_MAX } from "./replay-search-queue.js";
import { REPLAY_JUMP_MAX_WAIT_MS } from "./replay-timing.js";

/** The two ways a walk goes: forward (Next, a clockwise turn) or back (Previous, counter-clockwise). */
export type ReplayWalkDirection = "next" | "previous";

/**
 * The frame a walk is measured from: the replay's one pending target
 * (`replay-position-state.ts`, #1430) while it stands, else
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
 * Where a press steps from, once nothing is left to wait for: the pending
 * target, the cursor, or why there is neither.
 */
export type SettledReplayWalkStart =
  | { readonly frame: number; readonly from: "target" | "cursor" }
  | { readonly frame: null; readonly reason: "not in a replay" | "no cursor" };

/**
 * Where a press steps from, or why it has nowhere to step from yet: `search
 * on its way` while a search of the gate's is still on its way, whose landing
 * is the start but is not known until it lands ({@link awaitReplayWalkStart}
 * waits for it).
 */
export type ReplayWalkStart = SettledReplayWalkStart | { readonly frame: null; readonly reason: "search on its way" };

/**
 * The id of the last search a waiting start waited out without it landing
 * (`found-nothing`, `not-landed`, `gave-up`), or null: that search no longer
 * counts as one a start waits for, so a press after it reads the cursor
 * rather than waiting for a landing the gate has already given up on.
 */
let waitedOutSearchId: number | null = null;

/** The search of the gate's a start waits for: on its way, and not one a start has already waited out. */
function searchToWaitFor(): ReplaySearchOnItsWay | null {
  const search = replaySearchOnItsWay();

  return search === null || search.id === waitedOutSearchId ? null : search;
}

/**
 * Where a press steps from, in order (#1660):
 *
 * 1. **The pending target** while one stands. It wins even where the
 *    debounced state has given the replay up — a seek longer than the exit
 *    grace reads like a replay that was left in a live session — since the
 *    plugin's own jump is still headed there, as the gate holds too.
 * 2. **`search on its way`** while a search of the gate's may still be on its
 *    way (`replaySearchOnItsWay`: a lap, session or incident search or a go
 *    to start, never a go to end): its landing is where the replay is headed,
 *    but iRacing's search has no target the plugin can read, so the start is
 *    not known until it lands. A press waits for it through
 *    {@link awaitReplayWalkStart}; a view reads the cursor meanwhile.
 * 3. **`not in a replay`** outside one.
 * 4. **The cursor**, the state's {@link ReplayState.cursorFrame}: the frame a
 *    replay tick shows, or the frame the state holds through the exit grace
 *    and the seek hold (#1429). With none (the flag reads false past both: a
 *    mid-seek tick whose frame reads 0 in a saved replay, where a walk would
 *    send the list's first entry) it is `no cursor`, and what a press does
 *    then is the caller's: Replay Control's record step sends the key's
 *    search, which the gate holds while a seek shows.
 *
 * Synchronous and sends nothing; it reads the gate's target and search
 * records as they stand.
 */
export function resolveReplayWalkStart(
  state: Pick<ReplayState, "inReplay" | "cursorFrame">,
  telemetry: TelemetryData | null,
): ReplayWalkStart {
  const headed = readReplayPosition(telemetry);

  if (headed?.seeking === true) return { frame: headed.frame, from: "target" };

  if (searchToWaitFor() !== null) return { frame: null, reason: "search on its way" };

  return cursorStart(state);
}

/** Steps 3 and 4 of {@link resolveReplayWalkStart}: outside a replay, else the cursor or none. */
function cursorStart(state: Pick<ReplayState, "inReplay" | "cursorFrame">): SettledReplayWalkStart {
  if (!state.inReplay) return { frame: null, reason: "not in a replay" };

  if (state.cursorFrame === null) return { frame: null, reason: "no cursor" };

  return { frame: state.cursorFrame, from: "cursor" };
}

/** Whether a start has nothing left to wait for. */
function isSettled(start: ReplayWalkStart): start is SettledReplayWalkStart {
  return start.frame !== null || start.reason !== "search on its way";
}

/**
 * How many searches one waiting start waits through before it stops waiting
 * and reads the cursor: one full run of the paced search
 * ({@link SEARCH_QUEUE_MAX} searches) and one key's search behind it. Each
 * wait is bounded on its own; this bounds a chain of them that a dial kept
 * turning could otherwise make endless.
 */
const MAX_SEARCH_WAITS = SEARCH_QUEUE_MAX + 1;

/** A press waiting for its start, in press order. */
interface WaitingStart {
  readonly readState: () => Pick<ReplayState, "inReplay" | "cursorFrame">;
  readonly readTelemetry: () => TelemetryData | null;
  readonly act: (start: SettledReplayWalkStart) => unknown;
  /** Its waiting fact in the gate's state seam (`openReplayGateWait`). */
  readonly gateWait: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

/** The starts waiting, first pressed first: the one queue that orders them (#1660). */
let waitingStarts: WaitingStart[] = [];
/** Whether {@link drainWaitingStarts} is running. */
let draining = false;
/** Bumped by the reset, so a drain from before it stops at its next turn. */
let drainGeneration = 0;

function log(): ILogger {
  return engineLogger("ReplayWalk");
}

/**
 * Where a press steps from once any search of the gate's on its way has
 * ended (#1660), handed to `act`, whose result the promise carries. The
 * async companion of {@link resolveReplayWalkStart}; `act` never sees
 * `search on its way`.
 *
 * - **Nothing to wait for**, and no earlier press waiting: `act` runs at
 *   once, inside this call, with the start {@link resolveReplayWalkStart}
 *   reads.
 * - **A search on its way**, or an earlier press still waiting: the press
 *   joins the one queue of waiting starts. The head waits for the search's
 *   landing through the gate's own verdict (`waitForReplaySearchLanding`),
 *   as long as the gate's slot holds a press behind it: while nothing shows
 *   it on its way (a paused replay) until the time it could be running is
 *   over, so a long search across hours of tape is waited through rather
 *   than cancelled by the press's jump; once it is seen on its way, up to
 *   the landing or {@link REPLAY_JUMP_MAX_WAIT_MS}.
 *   Whatever the outcome (landed, found nothing, not landed, gave up,
 *   superseded) the start is read again from the top with fresh reads
 *   (`readState`, `readTelemetry`): a landing gives the cursor there, a
 *   search replaced by a jump gives that jump's target, a departure `not in
 *   a replay`, and a search that did not land the cursor, since it no longer
 *   counts. A new search on its way is waited for in turn, up to
 *   {@link MAX_SEARCH_WAITS}.
 * - **Press order.** Waiting starts resolve in the order they were pressed,
 *   each read at its own turn, and each `act` runs to its first `await`
 *   before the next start is read. So `act` must do what the step decides
 *   synchronously — record a jump's target (`beginReplayJump`), press a
 *   search through the gate — before it yields: the next press then reads
 *   that target and steps on from it, so two quick presses during one
 *   search step twice from its landing, never twice to the same entry.
 *   The queue does not wait for the promise `act` returns.
 * - **Busy mark.** While it waits the press shows as `waiting` for
 *   `options.origin` in the gate's state seam (`openReplayGateWait`), which
 *   is not the slot and sends nothing; `act` runs in the same gate change
 *   that ends it, as `sent-on-landing` (or `replay-left` when the start is
 *   `not in a replay`), so what it sends takes over the still mark without a
 *   not-done. Replay Control's key and dial and Replay Markers' key and dial
 *   each pass their context id; with no origin nothing shows.
 *
 * A throw from `act` rejects this press's promise and the queue goes on.
 */
export function awaitReplayWalkStart<T>(
  readState: () => Pick<ReplayState, "inReplay" | "cursorFrame">,
  readTelemetry: () => TelemetryData | null,
  act: (start: SettledReplayWalkStart) => T,
  options: { readonly origin?: string } = {},
): Promise<Awaited<T>> {
  if (waitingStarts.length === 0) {
    const start = resolveReplayWalkStart(readState(), readTelemetry());

    if (isSettled(start)) {
      try {
        return Promise.resolve(act(start));
      } catch (err) {
        return Promise.reject(err);
      }
    }
  }

  return new Promise<Awaited<T>>((resolve, reject) => {
    waitingStarts.push({
      readState,
      readTelemetry,
      act,
      gateWait: openReplayGateWait(options.origin),
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    log().debug(`Replay step start: waiting for a search to land (${waitingStarts.length} waiting)`);

    if (!draining) void drainWaitingStarts();
  });
}

/**
 * Waits for `search` to land or end, by the gate's verdict. An unseen search
 * (a paused replay shows none on its way) is waited for until the time it
 * could still be running is over, as the gate's slot holds a press behind
 * it: a shorter patience ends a long search's wait `not-landed` while it
 * still runs, and the press's jump would then cancel it. A seen one is
 * waited for up to its landing or {@link REPLAY_JUMP_MAX_WAIT_MS}, never less
 * than the could-run time.
 */
async function waitForSearch(search: ReplaySearchOnItsWay): Promise<string> {
  try {
    const landing = await waitForReplaySearchLanding({
      patienceMs: search.couldRunMs,
      hardBoundMs: Math.max(REPLAY_JUMP_MAX_WAIT_MS, search.couldRunMs),
    });

    return landing.outcome;
  } catch (err) {
    return `failed: ${String(err)}`;
  }
}

/**
 * Resolves the waiting starts in press order: the head is read; while a
 * search is on its way the head waits for it; once its start is settled it
 * leaves the queue, its waiting fact ends and its `act` runs in that one
 * gate change, and the next is read.
 */
async function drainWaitingStarts(): Promise<void> {
  const generation = drainGeneration;
  let waits = 0;

  draining = true;

  try {
    while (generation === drainGeneration) {
      const head = waitingStarts[0];

      if (head === undefined) return;

      const start = resolveReplayWalkStart(head.readState(), head.readTelemetry());

      if (!isSettled(start)) {
        const search = searchToWaitFor();

        if (search !== null) {
          waits++;

          if (waits > MAX_SEARCH_WAITS) {
            log().debug(`Replay step start: still searching after ${MAX_SEARCH_WAITS} searches; reading the cursor`);
          } else {
            const outcome = await waitForSearch(search);

            if (generation !== drainGeneration) return;

            log().debug(`Replay step start: the search on its way ended (${outcome})`);
          }

          // Landed or not, it is no longer one to wait for: the start is read again from the top.
          waitedOutSearchId = search.id;
          continue;
        }
      }

      waitingStarts.shift();
      waits = 0;

      const settled = isSettled(start) ? start : cursorStart(head.readState());
      const reason = settled.frame === null && settled.reason === "not in a replay" ? "replay-left" : "sent-on-landing";

      try {
        head.resolve(closeReplayGateWait(head.gateWait, reason, () => head.act(settled)));
      } catch (err) {
        head.reject(err);
      }
    }
  } finally {
    if (generation === drainGeneration) draining = false;
  }
}

/** @internal For tests, through `_resetReplayEngine`: no start waiting, none waited out. */
export function _resetReplayRecordWalk(): void {
  drainGeneration++;
  waitingStarts = [];
  draining = false;
  waitedOutSearchId = null;
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
