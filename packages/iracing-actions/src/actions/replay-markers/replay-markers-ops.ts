/**
 * What a Replay Markers press does, shared by the keypad (#1162) and the dial
 * (#1230): reading the replay context, Add, Delete, and where a Next /
 * Previous jump lands. Both surfaces call these functions rather than each
 * deriving its own, which is what keeps a turn of the dial and a key press
 * landing on the same marker, and the dial's side marks agreeing with the
 * keypad's greyed keys. Logging stays with the callers.
 */
import {
  MARKER_DEDUPE_FRAMES,
  MARKER_DELETE_WINDOW_FRAMES,
  MARKER_PREVIOUS_MIN_BEHIND_FRAMES,
  type ReplayMarker,
  type ReplaySessionStore,
  type SubSessionScoped,
} from "@iracedeck/deck-core";
import { getCommands } from "@iracedeck/deck-iracing";
import { ReplayPosMode, resolveReplayFrame, type TelemetryData } from "@iracedeck/iracing-sdk";

import {
  cancelReplayCursorOwner,
  clearReplayLanding,
  clearReplaySighting,
  lastReplaySighting,
  pendingReplayLanding,
  recordReplayLanding,
  recordReplaySighting,
  type ReplayLanding,
} from "../../shared/replay-cursor.js";

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
 * How long (ms) after a marker jump the next one is measured from the marker
 * jumped to rather than from the live frame. `ReplayFrameNum` reaches the
 * target only on a later tick, so a second jump arriving first would compute
 * from the old frame and send the same marker again — a fast spin would stick.
 */
export const DIAL_LANDING_HOLD_MS = 1_000;

/**
 * @internal Exported for testing
 *
 * How long (ms) `IsReplayPlaying` must read false before the surfaces take the
 * replay as left for the car. For roughly 300 ms after every `setPlayPosition`
 * iRacing reports it false (measured 2026-10-04), so without the grace a turn
 * right after a jump is refused as "from the car", the dial flashes its
 * from-the-car caption and the keypad's Next / Previous grey for a moment.
 */
export const REPLAY_EXIT_GRACE_MS = 1_000;

/** The replay counts as landed once `ReplayFrameNum` is this close (1 s) to the frame jumped to. */
const LANDED_WITHIN_FRAMES = 60;

/** The two ways a jump goes: forward (Next, a clockwise turn) or back (Previous, counter-clockwise). */
export type MarkerDirection = "next" | "previous";

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
 * {@link MARKER_DELETE_WINDOW_FRAMES}, measured to the marker's frame or to
 * the frame its Add was pressed at (`pressFrame`), whichever is closer. The
 * second distance is what lets Delete from the car reach a marker set with a
 * long Seconds back — the car sits at the live edge, the marker well behind
 * it. Markers without a numeric `pressFrame` (older files) use the frame
 * alone. On a tie the earlier marker goes.
 */
export function pickMarkerToDelete(markers: readonly ReplayMarker[], current: number): ReplayMarker | null {
  let best: ReplayMarker | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const marker of markers) {
    const toFrame = Math.abs(current - marker.frame);
    const toPress =
      typeof marker.pressFrame === "number" && Number.isFinite(marker.pressFrame)
        ? Math.abs(current - marker.pressFrame)
        : Number.POSITIVE_INFINITY;
    const distance = Math.min(toFrame, toPress);

    if (distance <= MARKER_DELETE_WINDOW_FRAMES && distance < bestDistance) {
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
   * Whether a replay is on screen, debounced: true from the first replay read,
   * false only once `IsReplayPlaying` has read false for
   * {@link REPLAY_EXIT_GRACE_MS}. Every "in a replay" decision reads this,
   * never `telemetry.IsReplayPlaying`, which drops for ~300 ms after each seek.
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
  isStoreInitialized(): boolean;
  getStore(): ReplaySessionStore;
}

/**
 * Reads the replay context fresh: connected, a store, telemetry with a frame,
 * whether a replay is on screen (debounced, see {@link resolveReplayState}),
 * and the scope. `nowMs` is injectable for tests.
 */
export function readReplayContext(source: ReplayContextSource, nowMs: number = Date.now()): ReplayContextResult {
  if (!source.getConnectionStatus()) return { ok: false, reason: "Not connected to iRacing" };

  if (!source.isStoreInitialized()) return { ok: false, reason: "Replay session store not initialized" };

  const telemetry = source.getCurrentTelemetry();
  const state = telemetry ? resolveReplayState(telemetry, nowMs) : null;

  if (!telemetry || state === null) return { ok: false, reason: "No replay frame in telemetry" };

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
 * Whether a replay is on screen and the frame it shows, debounced across every
 * Replay Markers surface through the one process-wide sighting
 * (`shared/replay-cursor.ts`). Entering a replay is immediate. Leaving it
 * counts only once `IsReplayPlaying` has read false for
 * {@link REPLAY_EXIT_GRACE_MS} since the last replay read; until then the last
 * replay frame seen is held. Null when the telemetry carries no usable frame.
 */
function resolveReplayState(telemetry: TelemetryData, nowMs: number): { inReplay: boolean; frame: number } | null {
  if (telemetry.IsReplayPlaying === true) {
    const frame = resolveReplayFrame(telemetry);

    if (frame === null) return null;

    recordReplaySighting(frame, nowMs);

    return { inReplay: true, frame };
  }

  const sighting = lastReplaySighting();

  if (sighting !== null && nowMs - sighting.seenAt < REPLAY_EXIT_GRACE_MS) {
    return { inReplay: true, frame: sighting.frame };
  }

  clearReplaySighting();
  const frame = resolveReplayFrame(telemetry);

  return frame === null ? null : { inReplay: false, frame };
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
 * - otherwise the store's own `next` (the first marker more than 1 s ahead) or
 *   `previous` (the media-player rule, its 2 s window measured from the anchor
 *   marker).
 *
 * `fromFrame` defaults to the context's live frame; a jump passes
 * {@link resolveMarkerJumpAnchor} — the shared pending landing while the replay
 * has not reached it yet.
 */
export function resolveJumpTarget(
  direction: MarkerDirection,
  context: ReplayContext,
  fromFrame: number = context.frame,
): ReplayMarker | null {
  if (!context.inReplay) return null;

  return direction === "next"
    ? context.store.markers.next(fromFrame, context.scope)
    : context.store.markers.previous(fromFrame, context.scope);
}

/**
 * The marker `steps` markers on from `first` in `direction`, stopping at the
 * end of the list rather than wrapping — a wrap would jump from the last lap to
 * the first without the driver seeing why. `steps` of 1 (or less) is `first`
 * itself. A `first` missing from the list (it cannot be, but the list is a
 * copy read separately) is returned as is.
 */
export function walkMarkers(
  markers: readonly ReplayMarker[],
  first: ReplayMarker,
  direction: MarkerDirection,
  steps: number,
): ReplayMarker {
  const start = markers.findIndex((m) => m.frame === first.frame);

  if (start === -1 || steps <= 1) return first;

  const delta = (direction === "next" ? 1 : -1) * (Math.floor(steps) - 1);
  const index = Math.min(markers.length - 1, Math.max(0, start + delta));

  return markers[index] ?? first;
}

/**
 * @internal Exported for testing
 *
 * The index of the marker whose moment is playing at `frame` — at it, or up to
 * {@link MARKER_PREVIOUS_MIN_BEHIND_FRAMES} (2 s) past it, the window Previous
 * treats as "still playing" — or -1. `markers` is ordered by frame.
 */
export function markerIndexAt(markers: readonly ReplayMarker[], frame: number): number {
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i];

    if (marker === undefined || marker.frame > frame) continue;

    return frame - marker.frame <= MARKER_PREVIOUS_MIN_BEHIND_FRAMES ? i : -1;
  }

  return -1;
}

/**
 * @internal Exported for testing
 *
 * The frame the next jump is measured from: the marker last jumped to while the
 * jump is pending — sent less than {@link DIAL_LANDING_HOLD_MS} ago and the live
 * frame not yet within a second of it — else the live frame.
 */
export function resolveAnchorFrame(landing: ReplayLanding | null, liveFrame: number, nowMs: number): number {
  if (landing === null || isLandingSettled(landing, liveFrame, nowMs)) return liveFrame;

  return landing.frame;
}

function isLandingSettled(landing: ReplayLanding, liveFrame: number, nowMs: number): boolean {
  return nowMs - landing.sentAt >= DIAL_LANDING_HOLD_MS || Math.abs(liveFrame - landing.frame) <= LANDED_WITHIN_FRAMES;
}

/**
 * The frame every Replay Markers surface measures a jump from — the keypad's
 * Next / Previous and every dial alike: the one shared pending landing
 * (`shared/replay-cursor.ts`) while it is pending, else `liveFrame`. A landing
 * that has settled is dropped here, so a replay that later drifts back near an
 * old target does not revive it.
 */
export function resolveMarkerJumpAnchor(liveFrame: number, nowMs: number = Date.now()): number {
  const landing = pendingReplayLanding();

  if (landing !== null && isLandingSettled(landing, liveFrame, nowMs)) clearReplayLanding();

  return resolveAnchorFrame(landing, liveFrame, nowMs);
}

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

/** The marker a Delete press at the context's frame would remove, or null. Read-only. */
export function previewDeleteMarker(context: ReplayContext): ReplayMarker | null {
  return pickMarkerToDelete(context.store.markers.list(context.scope), context.frame);
}

/** Deletes the marker {@link previewDeleteMarker} names; null when there is none in reach. */
export function deleteMarkerAt(context: ReplayContext): ReplayMarker | null {
  const target = previewDeleteMarker(context);

  // Deleting at the chosen marker's own frame removes exactly that one: it is
  // at distance 0, and Add keeps any other more than 1 s away.
  return target ? context.store.markers.deleteNearest(target.frame, context.scope) : null;
}

/**
 * Jumps the replay to `frame` with one `setPlayPosition(Begin, frame)`. First
 * cancels any claim on the replay cursor (#1203) in `owner`'s name, so a jump
 * stops an in-flight Jump to Fastest Lap walk rather than being overridden by
 * its next probe. A jump that was sent records `frame` as the shared landing
 * the next jump, from any Replay Markers surface, measures from (#1230). One
 * that was not sent moved nothing, so the landing before it stands. Call it
 * only when a jump is meant to be sent.
 */
export function jumpToMarkerFrame(owner: string, frame: number, nowMs: number = Date.now()): boolean {
  const before = pendingReplayLanding();

  // Clears the landing too: the cursor is taken, and this send decides where it goes.
  cancelReplayCursorOwner(owner);

  const sent = getCommands().replay.setPlayPosition(ReplayPosMode.Begin, frame);

  if (sent) {
    recordReplayLanding(frame, nowMs);
  } else if (before !== null) {
    recordReplayLanding(before.frame, before.sentAt);
  }

  return sent;
}
