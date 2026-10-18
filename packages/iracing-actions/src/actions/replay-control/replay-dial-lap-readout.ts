/**
 * Replay Control dial — the viewed car's lap over the laps in the session,
 * `12/25` (#801): Lap's value and Session's caption, read the same way for
 * both, so it lives apart from either mode. Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`
 * ("The display").
 *
 * The lap on screen comes from the record, not from `CarIdxLap`: in a replay
 * watched inside a live session the per-car arrays read the live field, and
 * four snapshots scrubbed back to the camera car racing all read −1 there.
 * Without a recorded lap for the car at the cursor it is unknown (`--`), and
 * so it is when the car's last recorded lap by then is another session's: the
 * record spans every session of the file, so a race watched before the car's
 * first race lap crossing would otherwise show its last qualifying lap. The
 * laps in the session are `replay-lap-count.ts`'s.
 */
import type { LapStartListEntry } from "@iracedeck/replay-store";

import type { ReplayPosition } from "../../shared/replay-position-state.js";
import type { ReplayDialStepIo } from "./replay-control-dial-mode.js";
import { formatLapOfLaps, sessionLapCount } from "./replay-lap-count.js";
import { listRecord, type RecordListing } from "./replay-record-step.js";

/**
 * @internal Exported for testing
 *
 * The session the record says `frame` is in, from the session list already
 * read (`listRecord("session", source)`): the last recorded session start at
 * or before it. Null when the list could not be read or holds no start by
 * then.
 */
export function recordedSessionAt(frame: number, listing: RecordListing): number | null {
  if (!listing.hit || listing.list !== "session") return null;

  let sessionNum: number | null = null;

  for (const start of listing.entries) {
    if (start.frame > frame) break;

    sessionNum = start.sessionNum;
  }

  return sessionNum;
}

/**
 * The recorded lap start of the camera car that is on screen at `frame`, from
 * its lap list already read: the last whose landing — the frame a lap step
 * jumps to, a second before the line — is at or before it, and only when it
 * is in `sessionNum`. See {@link recordedLapAt}.
 */
function recordedLapStartAt(
  frame: number,
  listing: RecordListing,
  sessionNum: number | null,
): LapStartListEntry | null {
  if (!listing.hit || listing.list !== "lap" || sessionNum === null) return null;

  let found: LapStartListEntry | null = null;

  for (const start of listing.entries) {
    if (listing.landing(start.frame) > frame) break;

    found = start;
  }

  return found !== null && found.sessionNum === sessionNum ? found : null;
}

/**
 * @internal Exported for testing
 *
 * The recorded lap of the camera car that is on screen at `frame`, from its
 * lap list already read (`listRecord("lap", source)`): the last recorded lap
 * start whose landing — the frame a lap step jumps to, a second before the
 * line — is at or before it, so a turn that lands on a lap reads that lap at
 * once rather than the one it is a second from finishing. That lap counts
 * only when it is in `sessionNum`, the session on screen at `frame`: the list
 * spans every session of the file, and the last lap of an earlier session is
 * not the car's lap in a later one it has not yet crossed the line in. Null
 * when the list could not be read (no store, no car on camera, no car
 * number), holds no lap by then, the lap found is another session's, or the
 * session on screen is not known.
 */
export function recordedLapAt(frame: number, listing: RecordListing, sessionNum: number | null): number | null {
  return recordedLapStartAt(frame, listing, sessionNum)?.lap ?? null;
}

/**
 * @internal Exported for testing
 *
 * The highest lap the record holds for the camera car in session
 * `sessionNum`, from its lap list already read; with `sessionUniqueId`, only
 * that instance of the session (a restarted offline event numbers its
 * sessions from 0 again). Null when the list could not be read or holds none.
 */
export function recordedMaxLap(
  listing: RecordListing,
  sessionNum: number,
  sessionUniqueId: number | undefined,
): number | null {
  if (!listing.hit || listing.list !== "lap") return null;

  let max: number | null = null;

  for (const start of listing.entries) {
    if (start.sessionNum !== sessionNum) continue;

    if (sessionUniqueId !== undefined && start.sessionUniqueId !== sessionUniqueId) continue;

    if (max === null || start.lap > max) max = start.lap;
  }

  return max;
}

/**
 * The session on screen: on a reading that is the replay's, its
 * `ReplaySessionNum`; while a jump is under way, the session the record puts
 * the pending landing in (from `sessionListing`, read here when not handed
 * one). Null when neither can say.
 */
function sessionOnScreen(
  io: ReplayDialStepIo,
  position: ReplayPosition,
  sessionListing: RecordListing | null,
): number | null {
  if (position.seeking) {
    return recordedSessionAt(position.frame, sessionListing ?? listRecord("session", io.recordSource()));
  }

  const sessionNum = io.telemetry()?.ReplaySessionNum;

  return typeof sessionNum === "number" && sessionNum >= 0 ? sessionNum : null;
}

/**
 * @internal Exported for testing
 *
 * The viewed car's lap over the laps in the session on screen, `12/25`, from
 * the camera car's lap list already read (`lapListing`) and, where the caller
 * has it, the session list. An unknown lap reads `--` and an unknown count
 * drops the denominator (`formatLapOfLaps`). Null on a tick read mid-seek
 * (no position): the box keeps what it showed.
 */
export function lapOfLapsReadout(
  io: ReplayDialStepIo,
  position: ReplayPosition | null,
  lapListing: RecordListing,
  sessionListing: RecordListing | null = null,
): string | null {
  if (position === null) return null;

  const sessionNum = sessionOnScreen(io, position, sessionListing);

  if (sessionNum === null) return formatLapOfLaps(null, null);

  const start = recordedLapStartAt(position.frame, lapListing, sessionNum);
  const laps = sessionLapCount(
    io.sessionInfo(),
    sessionNum,
    io.telemetry()?.CamCarIdx,
    recordedMaxLap(lapListing, sessionNum, start?.sessionUniqueId),
  );

  return formatLapOfLaps(start?.lap ?? null, laps);
}
