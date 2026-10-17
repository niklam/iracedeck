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
 * The step itself is the shared walk (`shared/replay-record-walk.ts`). Every
 * way the record cannot answer is a miss with a reason, and the caller then
 * sends iRacing's own search, as the key did before. Pure: the caller reads
 * the store, the camera car and the car number and hands them in.
 */
import type {
  LapStartListing,
  ReplaySessionStore,
  SessionStartListing,
  SubSessionScoped,
} from "@iracedeck/replay-store";

import type { ReplaySearchKind } from "../../shared/replay-command-gate.js";
import { type ReplayWalkDirection, stepRecordedFrames } from "../../shared/replay-record-walk.js";

/**
 * Frames after a recorded session start a Next / Previous Session step lands
 * at (2 s). A start recorded live sits about 59 frames before the same moment
 * in replay numbering (#1162's `REPLAY_FILE_FRAME_LAG`), so the raw frame
 * would land in the last second of the session before, where the cursor still
 * reads the old session.
 */
export const SESSION_START_LANDING_FRAMES = 120;

/** iRacing's "no driver" camera index: mid-transition, or the pace car. */
const NO_CAR_IDX = 255;

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
}

/** Where a step lands, or why the record cannot answer. */
export type RecordStepResult =
  | { readonly hit: true; readonly frame: number; readonly steps: number; readonly what: string }
  | { readonly hit: false; readonly reason: string };

/** A store listing's frames, or why it has none. */
type Landings = { hit: true; landings: number[]; what: string } | { hit: false; reason: string };

function lapLandings(source: RecordStepSource, store: ReplaySessionStore): Landings {
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
    landings: listing.frames.map((frame) => Math.max(0, frame - source.lapApproachFrames)),
    what: `${listing.frames.length} lap starts of carIdx ${carIdx}`,
  };
}

function sessionLandings(source: RecordStepSource, store: ReplaySessionStore): Landings {
  const listing: SessionStartListing = store.sessions.list(source.scope);

  if (!listing.hit) return { hit: false, reason: listing.reason };

  return {
    hit: true,
    landings: listing.starts.map((start) => start.frame + SESSION_START_LANDING_FRAMES),
    what: `${listing.starts.length} session starts`,
  };
}

/**
 * Where one step of `step`'s list from `anchor` lands, or the miss: no store,
 * any of the store's reasons (`no file`, `no car`, `car mismatch`,
 * `newer format`), no car on camera for a lap step, or `nothing that way`.
 */
export function findRecordStep(step: RecordStepSpec, anchor: number, source: RecordStepSource): RecordStepResult {
  if (source.store === null) return { hit: false, reason: "no store" };

  const found = step.list === "lap" ? lapLandings(source, source.store) : sessionLandings(source, source.store);

  if (!found.hit) return found;

  const walked = stepRecordedFrames(found.landings, anchor, step.direction, 1);

  if (walked === null) return { hit: false, reason: "nothing that way" };

  return { hit: true, frame: walked.frame, steps: walked.steps, what: found.what };
}
