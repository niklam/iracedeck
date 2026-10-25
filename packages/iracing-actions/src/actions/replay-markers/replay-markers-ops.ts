/**
 * What a Replay Markers press does, shared by the keypad (#1162) and the dial
 * (#1230): reading the replay context, Add, Delete, where a Next / Previous
 * jump lands, and the jump itself. Both surfaces call these functions rather
 * than each deriving its own, which is what keeps a turn of the dial and a key
 * press landing on the same marker, and the dial's side marks agreeing with
 * the keypad's greyed keys.
 *
 * A jump is the shared replay jump sequence (`replay-engine`'s `replay-jump-playback.ts`,
 * #1276): it pauses a moving replay, seeks, waits for the landing and then
 * leaves the replay the way the Replay jump playback setting says. So it
 * outlives the press that started it, and {@link jumpToMarkerFrame} returns a
 * promise of how it ended.
 *
 * Logging stays with the callers: nothing here keeps a logger. The surface
 * that was pressed hands its own to {@link followMarkerJump}, which writes how
 * the jump ended in the wording every replay jump shares.
 */
import { REPLAY_EXIT_GRACE_MS, type ReplayState, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import {
  beginReplayJump,
  describeReplayJump,
  recordedIndexAt,
  type ReplayJumpOutcome,
  type ReplayWalkDirection,
  resolveReplayWalkAnchor,
  runReplayJump,
  walkRecordedEntries,
  walkRecordedIndex,
} from "@iracedeck/replay-engine";
import {
  MARKER_DEDUPE_FRAMES,
  type ReplayMarker,
  type ReplaySessionStore,
  type SubSessionScoped,
} from "@iracedeck/replay-store";

/** Replay frames per second — the recording's fixed rate. */
const FRAMES_PER_SECOND = 60;

/**
 * @internal Exported for testing
 *
 * How long the Added / Deleted confirmation stays on the key or the dial.
 */
export const CONFIRMATION_FLASH_MS = 1_000;

/**
 * @internal Exported for testing
 *
 * How long (ms) `IsReplayPlaying` must read false before the replay counts as
 * left for the car: the SDK's constant (#1324), re-exported for the surfaces'
 * tests. The rule itself is `SDKController.getReplayState()`'s.
 */
export { REPLAY_EXIT_GRACE_MS };

/** The two ways a jump goes: forward (Next, a clockwise turn) or back (Previous, counter-clockwise). */
export type MarkerDirection = ReplayWalkDirection;

/**
 * @internal Exported for testing
 *
 * The marker an Add press names: `secondsBack` before the current frame,
 * clamped at the recording's start. `pressFrame` keeps the frame the key was
 * pressed at, so Delete from the same spot reaches a marker set far back.
 * Session number and time are descriptive only (a person reading the file),
 * taken from the replay's own session while a replay plays and from the live
 * session otherwise. `inReplay` is the context's debounced flag, so a press in
 * the post-seek blip still names the replay's session.
 */
export function buildMarker(
  telemetry: TelemetryData,
  currentFrame: number,
  secondsBack: number,
  inReplay: boolean,
): ReplayMarker {
  const sessionNum = (inReplay ? telemetry.ReplaySessionNum : telemetry.SessionNum) ?? 0;
  const sessionTime = (inReplay ? telemetry.ReplaySessionTime : telemetry.SessionTime) ?? 0;

  return {
    frame: Math.max(0, currentFrame - secondsBack * FRAMES_PER_SECOND),
    pressFrame: currentFrame,
    sessionNum,
    sessionTimeMs: Math.max(0, Math.round((sessionTime - secondsBack) * 1000)),
  };
}

/**
 * @internal Exported for testing
 *
 * The marker a Delete press at `current` removes: the nearest one within
 * `windowSeconds` (the key's or the dial's Delete Window, #1454; required, so
 * no caller keeps the store's 10 s by omission), measured to the marker's
 * frame or to the frame its Add was pressed at (`pressFrame`), whichever is
 * closer. The second distance is what lets Delete from the car reach a marker
 * set with a long Seconds back — the car sits at the live edge, the marker
 * well behind it. Markers without a numeric `pressFrame` (older files) use
 * the frame alone. On a tie the earlier marker goes.
 */
export function pickMarkerToDelete(
  markers: readonly ReplayMarker[],
  current: number,
  windowSeconds: number,
): ReplayMarker | null {
  const windowFrames = windowSeconds * FRAMES_PER_SECOND;
  let best: ReplayMarker | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const marker of markers) {
    const toFrame = Math.abs(current - marker.frame);
    const toPress =
      typeof marker.pressFrame === "number" && Number.isFinite(marker.pressFrame)
        ? Math.abs(current - marker.pressFrame)
        : Number.POSITIVE_INFINITY;
    const distance = Math.min(toFrame, toPress);

    if (distance <= windowFrames && distance < bestDistance) {
      best = marker;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * @internal Exported for testing
 *
 * `WeekendInfo.SubSessionID` as a finite number, else undefined — the store
 * then takes the call for its active session.
 */
export function readSubSessionId(sessionInfo: unknown): number | undefined {
  const weekend = (sessionInfo as Record<string, unknown> | null | undefined)?.WeekendInfo as
    Record<string, unknown> | undefined;
  const raw = weekend?.SubSessionID;
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;

  return Number.isFinite(value) ? value : undefined;
}

/** Everything a press reads before it acts: telemetry and its frame, the store, and the SubSessionID scope. */
export interface ReplayContext {
  ok: true;
  telemetry: TelemetryData;
  /**
   * Whether a replay is on screen, debounced (the controller's replay state):
   * true from the first replay tick, false only once `IsReplayPlaying` has read
   * false for {@link REPLAY_EXIT_GRACE_MS}, and always true in a saved replay.
   * Every "in a replay" decision reads this, never `telemetry.IsReplayPlaying`,
   * which drops for ~300 ms after each seek.
   */
  inReplay: boolean;
  /**
   * The frame on screen: `ReplayFrameNum` in a replay (through the grace, the
   * last one a replay read showed) and `ReplayFrameNumEnd` live. Never
   * `ReplayFrameNumEnd` in a replay, where it is the frames left, not a position.
   */
  frame: number;
  store: ReplaySessionStore;
  scope: SubSessionScoped | undefined;
}

/** Why there is no replay context; `reason` names what was missing. */
export interface ReplayContextMissing {
  ok: false;
  reason: string;
}

export type ReplayContextResult = ReplayContext | ReplayContextMissing;

/** Where the context is read from: the action's SDK controller, and the store's two accessors. */
export interface ReplayContextSource {
  getConnectionStatus(): boolean;
  getCurrentTelemetry(): TelemetryData | null;
  getSessionInfo(): unknown;
  /**
   * Whether a replay is on screen and the frame it shows, debounced, as of
   * `nowMs`: `SDKController.getReplayState()` (#1324), the one instance every
   * replay consumer reads.
   */
  getReplayState(nowMs: number): Pick<ReplayState, "inReplay" | "frame">;
  isStoreInitialized(): boolean;
  getStore(): ReplaySessionStore;
}

/**
 * Reads the replay context fresh: connected, a store, telemetry, whether a
 * replay is on screen and the frame it shows (the controller's debounced
 * replay state, so a press in the post-seek blip still reads the replay and
 * its held frame), and the scope. `nowMs` is injectable for tests; the state
 * is evaluated at it, so a press between ticks sees the grace expire.
 */
export function readReplayContext(source: ReplayContextSource, nowMs: number = Date.now()): ReplayContextResult {
  if (!source.getConnectionStatus()) return { ok: false, reason: "Not connected to iRacing" };

  if (!source.isStoreInitialized()) return { ok: false, reason: "Replay session store not initialized" };

  const telemetry = source.getCurrentTelemetry();
  const state = source.getReplayState(nowMs);

  if (!telemetry || state.frame === null) return { ok: false, reason: "No replay frame in telemetry" };

  const subSessionId = readSubSessionId(source.getSessionInfo());

  return {
    ok: true,
    telemetry,
    inReplay: state.inReplay,
    frame: state.frame,
    store: source.getStore(),
    scope: subSessionId === undefined ? undefined : { subSessionId },
  };
}

/**
 * The marker a Next / Previous jump from `fromFrame` lands on, or null when it
 * would send nothing. The one predicate behind the keypad's greyed Next /
 * Previous keys, the dial's first step and the dial's side marks:
 *
 * - out of a replay (the context's debounced `inReplay`) it is always null — iRacing honours replay commands only
 *   out of the car (irsdk_defines.h: "camera and replay commands only work
 *   when you are out of your car"), so from the car a jump would be sent,
 *   ignored, and logged as done;
 * - otherwise the shared walk's first step over the store's markers
 *   (`walkRecordedEntries`, `replay-engine`'s `replay-record-walk.ts`, #1426): Next is
 *   the first marker more than 1 s ahead, Previous the media-player rule, its
 *   2 s window measured from the anchor marker. The windows live in that one
 *   walk for every surface — Replay Markers and Replay Control's lap and
 *   session steps — and a marker lands on itself, so no offset is added and
 *   no span rule applies.
 *
 * `fromFrame` defaults to the context's live frame; a jump passes
 * {@link resolveMarkerJumpAnchor} — the replay's pending target while the
 * replay has not reached it yet.
 */
export function resolveJumpTarget(
  direction: MarkerDirection,
  context: ReplayContext,
  fromFrame: number = context.frame,
): ReplayMarker | null {
  if (!context.inReplay) return null;

  const walked = walkRecordedEntries(context.store.markers.list(context.scope), fromFrame, direction, 1);

  return walked.hit ? walked.entry : null;
}

/**
 * The marker `steps` markers on from `first` in `direction`, stopping at the
 * end of the list rather than wrapping — a wrap would jump from the last lap to
 * the first without the driver seeing why. `steps` of 1 (or less) is `first`
 * itself. A `first` missing from the list (it cannot be, but the list is a
 * copy read separately) is returned as is. The walk is the shared one
 * (`replay-engine`'s `replay-record-walk.ts`, #1426).
 */
export function walkMarkers(
  markers: readonly ReplayMarker[],
  first: ReplayMarker,
  direction: MarkerDirection,
  steps: number,
): ReplayMarker {
  const start = markers.findIndex((m) => m.frame === first.frame);

  if (start === -1 || steps <= 1) return first;

  return markers[walkRecordedIndex(markers.length, start, direction, steps).index] ?? first;
}

/**
 * @internal Exported for testing
 *
 * The index of the marker whose moment is playing at `frame` — at it, or up to
 * two seconds past it, the window Previous treats as "still playing" — or -1.
 * `markers` is ordered by frame. The shared walk's rule
 * (`recordedIndexAt`, #1426).
 */
export function markerIndexAt(markers: readonly ReplayMarker[], frame: number): number {
  return recordedIndexAt(
    markers.map((m) => m.frame),
    frame,
  );
}

/**
 * The frame every Replay Markers surface measures a jump from — the keypad's
 * Next / Previous and every dial alike: the shared walk's anchor
 * (`resolveReplayWalkAnchor`, moved to the shared `replay-record-walk.ts` in
 * #1426, in `replay-engine` since #1467), the replay's one pending target while it stands, else `liveFrame`.
 */
export const resolveMarkerJumpAnchor = resolveReplayWalkAnchor;

/**
 * Whether the store holds an active record that a call with `context.scope`
 * reaches — what `markers.add` needs to store anything.
 */
function hasActiveRecordFor(context: ReplayContext): boolean {
  const active = context.store.getActiveSession();

  if (active === null) return false;

  return context.scope?.subSessionId === undefined || context.scope.subSessionId === active.subSessionId;
}

/**
 * The marker an Add press would store, or null when the store would refuse it:
 * no active record for the context's scope, or a duplicate (another marker
 * within {@link MARKER_DEDUPE_FRAMES}). Read-only: the dial's hold preview asks
 * this before the release, and the release then calls {@link addMarkerAt}.
 */
export function previewAddMarker(context: ReplayContext, secondsBack: number): ReplayMarker | null {
  if (!hasActiveRecordFor(context)) return null;

  const marker = buildMarker(context.telemetry, context.frame, secondsBack, context.inReplay);
  const duplicate = context.store.markers
    .list(context.scope)
    .some((m) => Math.abs(m.frame - marker.frame) <= MARKER_DEDUPE_FRAMES);

  return duplicate ? null : marker;
}

/** Adds the marker `secondsBack` before the context's frame; `added` is false for a duplicate. */
export function addMarkerAt(context: ReplayContext, secondsBack: number): { marker: ReplayMarker; added: boolean } {
  const marker = buildMarker(context.telemetry, context.frame, secondsBack, context.inReplay);

  return { marker, added: context.store.markers.add(marker, context.scope) };
}

/**
 * The marker a Delete press at the context's frame would remove within
 * `windowSeconds`, or null. Read-only: the keypad's greyed Delete key, the
 * Add / Delete key's look and the dial's hold preview all ask this, the same
 * pick the press makes (#1454).
 */
export function previewDeleteMarker(context: ReplayContext, windowSeconds: number): ReplayMarker | null {
  return pickMarkerToDelete(context.store.markers.list(context.scope), context.frame, windowSeconds);
}

/** Deletes the marker {@link previewDeleteMarker} names; null when there is none in reach. */
export function deleteMarkerAt(context: ReplayContext, windowSeconds: number): ReplayMarker | null {
  const target = previewDeleteMarker(context, windowSeconds);

  // Deleting at the chosen marker's own frame removes exactly that one: it is
  // at distance 0, and Add keeps any other more than 1 s away.
  return target ? context.store.markers.deleteNearest(target.frame, context.scope) : null;
}

/**
 * Jumps the replay to `frame` with the shared jump sequence and resolves with
 * how it ended. The replay finishes the way the Replay jump playback setting
 * says: `readTelemetry` is read at the press for the speed to restore, then
 * polled while the sequence waits for the pause and for the landing. Call it
 * only when a jump is meant to be sent, and read the anchor
 * ({@link resolveMarkerJumpAnchor}) first: the jump replaces the target.
 *
 * Everything up to the sequence's first wait happens within the call:
 *
 * 1. The replay cursor is claimed in `owner`'s name (#1203). That stops an
 *    in-flight Jump to Fastest Lap walk, or an earlier marker jump — whose
 *    captured speed this one inherits — rather than racing it.
 * 2. `frame` is recorded as the replay's pending target, which the next jump
 *    of any surface measures from (#1230, #1430). At the press, not at the
 *    seek: a moving replay is paused first, so its seek goes out a poll or
 *    more later, and a dial detent arriving in between must already step on
 *    from here.
 * 3. A replay that is paused, and was before the press, gets its seek at once.
 *
 * `origin` is the press's origin token (the replay command gate's state seam):
 * the key's context id, or the dial's own.
 */
export async function jumpToMarkerFrame(
  owner: string,
  frame: number,
  readTelemetry: () => TelemetryData | null,
  nowMs: number = Date.now(),
  origin?: string,
): Promise<ReplayJumpOutcome> {
  const jump = beginReplayJump(owner, readTelemetry(), undefined, nowMs, { frame, origin });

  try {
    return await runReplayJump(jump, { frame, readTelemetry });
  } finally {
    jump.end();
  }
}

/**
 * Logs how a marker jump ended once it has, through the surface's own logger:
 * a warning when something went wrong, and the details at debug either way,
 * each led by `what` (the surface's name for the jump). Nothing waits on a
 * jump, so a rejection is caught here and logged as an error.
 */
export function followMarkerJump(
  logger: Pick<ILogger, "debug" | "warn" | "error">,
  what: string,
  frame: number,
  jump: Promise<ReplayJumpOutcome>,
): void {
  void jump.then(
    (outcome) => {
      const report = describeReplayJump(outcome, frame);

      if (report.warn !== null) logger.warn(`${what}: ${report.warn}`);

      logger.debug(`${what}: ${report.detail}`);
    },
    (err: unknown) => logger.error(`${what}: jump failed: ${String(err)}`),
  );
}
