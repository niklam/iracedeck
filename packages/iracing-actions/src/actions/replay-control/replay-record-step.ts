/**
 * Next / Previous Lap and Next / Previous Session from the record (#1426):
 * which list a press steps through, the frame each entry lands on, and where
 * the step goes. Design:
 * `docs/superpowers/specs/2026-10-12-issue-1426-replay-record-steps.md`
 * ("Stepping through a recorded list").
 *
 * - **Lap**: every recorded lap start of the car the camera is on
 *   (`CamCarIdx`, verified by `carNumberRaw` like every lap lookup), across
 *   every session of the file, each landing a second before the line (the
 *   approach Jump to Fastest Lap already uses).
 * - **Session**: every recorded session start, each landing
 *   {@link SESSION_START_LANDING_FRAMES} after it, so the cursor reads the new
 *   session and a second press does not find the same start again.
 *
 * The step itself is the shared walk (`shared/replay-record-walk.ts`), told
 * where each list's record has gaps ({@link LAP_SPANS}, {@link sessionSpans})
 * so a step never crosses laps or a session the plugin did not record. Every
 * way the record cannot answer is a miss with a reason, and the caller then
 * sends iRacing's own search, as the key did before. Pure: the caller reads
 * the store, the camera car and the car number and hands them in.
 */
import type {
  LapStartListEntry,
  LapStartListing,
  ReplaySessionStart,
  ReplaySessionStore,
  SessionStartListing,
  SubSessionScoped,
} from "@iracedeck/replay-store";

import type { ReplaySearchKind } from "../../shared/replay-command-gate.js";
import {
  type RecordedEntry,
  type RecordedSpanRule,
  type ReplayWalkDirection,
  walkRecordedEntries,
} from "../../shared/replay-record-walk.js";

/**
 * Frames after a recorded session start a Next / Previous Session step lands
 * at (2 s). A start recorded live sits about 59 frames before the same moment
 * in replay numbering (#1162's `REPLAY_FILE_FRAME_LAG`), so the raw frame
 * would land in the last second of the session before, where the cursor still
 * reads the old session.
 */
export const SESSION_START_LANDING_FRAMES = 120;

/** iRacing's "no driver" camera index (`CamCarIdx`): mid-transition, or the pace car. */
export const NO_CAR_IDX = 255;

/** The four modes that step through the record. */
export type RecordStepMode = "next-lap" | "prev-lap" | "next-session" | "prev-session";

/** What a record step mode steps through, which way, and the search it sends on a miss. */
export interface RecordStepSpec {
  readonly list: "lap" | "session";
  readonly direction: ReplayWalkDirection;
  readonly search: ReplaySearchKind;
  /** What opens the mode's log lines. */
  readonly label: string;
}

export const RECORD_STEPS: Readonly<Record<RecordStepMode, RecordStepSpec>> = {
  "next-lap": { list: "lap", direction: "next", search: "nextLap", label: "Next lap" },
  "prev-lap": { list: "lap", direction: "previous", search: "prevLap", label: "Previous lap" },
  "next-session": { list: "session", direction: "next", search: "nextSession", label: "Next session" },
  "prev-session": { list: "session", direction: "previous", search: "prevSession", label: "Previous session" },
};

/** Whether `mode` steps through the record. */
export function isRecordStepMode(mode: string): mode is RecordStepMode {
  return mode in RECORD_STEPS;
}

/** What a record step reads besides the anchor. */
export interface RecordStepSource {
  /** The replay store, or null when none was initialized. */
  readonly store: ReplaySessionStore | null;
  /** The SubSessionID scope; undefined lets the store take its active session. */
  readonly scope: SubSessionScoped | undefined;
  /** `CamCarIdx` at the press. */
  readonly camCarIdx: number | undefined;
  /** The car's raw number from the session info, or null. */
  carNumberRaw(carIdx: number): number | null;
  /** Frames before a lap start a lap step lands at: Replay Control's `LAP_START_APPROACH_FRAMES`. */
  readonly lapApproachFrames: number;
  /**
   * The event's last session number: the highest `SessionNum` the session
   * info's `SessionInfo.Sessions` lists, or null with no session info or none
   * listed. A session step reads it for a restarted offline event
   * ({@link sessionSpans}).
   */
  readonly lastSessionNum: number | null;
}

/** Where a step lands, or why the record cannot answer. */
export type RecordStepResult =
  | { readonly hit: true; readonly frame: number; readonly steps: number; readonly what: string }
  | { readonly hit: false; readonly reason: string };

/**
 * Two recorded lap starts follow each other in the record when the second is
 * the next lap of the same session instance. A stint in the garage leaves
 * laps out, and the record has no lap past the last one recorded, so the last
 * span is not open: a step that would go there, or cross a session boundary,
 * is iRacing's search's.
 */
export const LAP_SPANS: RecordedSpanRule<LapStartListEntry> = {
  adjacent: (a, b) => a.sessionNum === b.sessionNum && a.sessionUniqueId === b.sessionUniqueId && b.lap === a.lap + 1,
  lastSpanOpen: false,
};

/**
 * Two recorded session starts follow each other when the second is the next
 * session number, or when the first is the event's last session
 * (`lastSessionNum`) and the second is session 0 of another instance: a
 * restarted offline event starts again at practice, but only once its last
 * session has run. Session 0 of another instance after any earlier session
 * is a gap (sessions between were not recorded: [Q1, (R2), P0'] does not step
 * from Q1 to P0'), and with no last session known (no session info, or none
 * listed) a restart pair is a gap too, so the step falls back to the search.
 * A session after the last recorded start is rare, and the race is usually
 * the last, so the last span is open.
 */
export function sessionSpans(lastSessionNum: number | null): RecordedSpanRule<ReplaySessionStart> {
  return {
    adjacent: (a, b) =>
      b.sessionNum === a.sessionNum + 1 ||
      (lastSessionNum !== null &&
        a.sessionNum === lastSessionNum &&
        b.sessionNum === 0 &&
        b.sessionUniqueId !== a.sessionUniqueId),
    lastSpanOpen: true,
  };
}

/**
 * A store listing's recorded entries, raw, with the rule for its gaps and the
 * offset a jump to one of them lands at, or why it has none.
 */
type Listed<T extends RecordedEntry> =
  | {
      hit: true;
      entries: readonly T[];
      rule: RecordedSpanRule<T>;
      landing: (frame: number) => number;
      what: string;
    }
  | { hit: false; reason: string };

function lapStarts(source: RecordStepSource, store: ReplaySessionStore): Listed<LapStartListEntry> {
  const carIdx = source.camCarIdx;

  if (typeof carIdx !== "number" || !Number.isInteger(carIdx) || carIdx < 0 || carIdx === NO_CAR_IDX) {
    return { hit: false, reason: `no car on camera (CamCarIdx ${String(carIdx)})` };
  }

  const carNumberRaw = source.carNumberRaw(carIdx);

  if (carNumberRaw === null) return { hit: false, reason: `no car number for carIdx ${carIdx}` };

  const listing: LapStartListing = store.laps.listLapStarts({ carIdx, carNumberRaw, ...source.scope });

  if (!listing.hit) return { hit: false, reason: listing.reason };

  return {
    hit: true,
    entries: listing.starts,
    rule: LAP_SPANS,
    landing: (frame) => Math.max(0, frame - source.lapApproachFrames),
    what: `${listing.starts.length} lap starts of carIdx ${carIdx}`,
  };
}

function sessionStarts(source: RecordStepSource, store: ReplaySessionStore): Listed<ReplaySessionStart> {
  const listing: SessionStartListing = store.sessions.list(source.scope);

  if (!listing.hit) return { hit: false, reason: listing.reason };

  return {
    hit: true,
    entries: listing.starts,
    rule: sessionSpans(source.lastSessionNum),
    landing: (frame) => frame + SESSION_START_LANDING_FRAMES,
    what: `${listing.starts.length} session starts`,
  };
}

function stepThrough<T extends RecordedEntry>(
  listed: Listed<T>,
  anchor: number,
  direction: ReplayWalkDirection,
  steps: number,
): RecordStepResult {
  if (!listed.hit) return listed;

  const walked = walkRecordedEntries(listed.entries, anchor, direction, steps, listed.rule, (entry) =>
    listed.landing(entry.frame),
  );

  if (!walked.hit) return { hit: false, reason: walked.reason };

  return { hit: true, frame: listed.landing(walked.entry.frame), steps: walked.steps, what: listed.what };
}

/**
 * Where one step of `step`'s list from `anchor` lands, or the miss: no store,
 * any of the store's reasons (`no file`, `no car`, `car mismatch`,
 * `newer format`), no car on camera for a lap step, or one of the walk's:
 * `outside the record` (the anchor lies in no recorded span), `gap in the
 * record` (the step would cross laps or a session the record does not hold)
 * or `nothing that way`.
 *
 * The walk compares the anchor with the recorded starts themselves and the
 * landing offset is added to the start it picks, never the other way round: a
 * cursor between a session's start and its landing (after Jump to Beginning,
 * or iRacing's own search) is in that session, and Next goes on to the next
 * one rather than to its own landing two seconds on. Previous's window alone
 * is measured from the landing of the entry the anchor is in: a replay that
 * resumed playing after Previous Session landed at start + 120 is past the
 * raw start's window within a frame, and the next press would go back to the
 * same session; from the landing it goes to the session before, and only a
 * cursor more than two seconds past the landing goes back to its own start.
 * Laps likewise: a cursor at a lap's landing, or up to a second past its
 * line, goes to the lap before.
 *
 * `steps` entries are walked (default one, a key's press): the Replay Control
 * dial's turn of `ticks` detents walks `|ticks|` (#801), and the result's
 * `steps` says how many the record held, never across a gap in it.
 */
export function findRecordStep(
  step: RecordStepSpec,
  anchor: number,
  source: RecordStepSource,
  steps = 1,
): RecordStepResult {
  if (source.store === null) return { hit: false, reason: "no store" };

  return step.list === "lap"
    ? stepThrough(lapStarts(source, source.store), anchor, step.direction, steps)
    : stepThrough(sessionStarts(source, source.store), anchor, step.direction, steps);
}
