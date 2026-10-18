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
 * first race lap crossing would otherwise show its last qualifying lap. Where
 * the session record places the cursor in an instance of that session, only
 * that instance's laps count: a restarted offline event numbers its sessions
 * from 0 again, and the first instance's laps are not the second's. The laps
 * in the session are `replay-lap-count.ts`'s.
 */
import type { LapStartListEntry, ReplaySessionStart } from "@iracedeck/replay-store";

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
  return recordedSessionStartAt(frame, listing)?.sessionNum ?? null;
}

/** The recorded session start {@link recordedSessionAt} reads, its instance included. */
function recordedSessionStartAt(frame: number, listing: RecordListing): ReplaySessionStart | null {
  if (!listing.hit || listing.list !== "session") return null;

  let found: ReplaySessionStart | null = null;

  for (const start of listing.entries) {
    if (start.frame > frame) break;

    found = start;
  }

  return found;
}

/** The session on screen, and its instance (`SessionUniqueID`) when the session record can say. */
interface SessionOnScreen {
  readonly sessionNum: number;
  readonly sessionUniqueId: number | null;
}

/**
 * The recorded lap start of the camera car that is on screen at `frame`, from
 * its lap list already read: the last whose landing — the frame a lap step
 * jumps to, a second before the line — is at or before it, and only when it
 * is in `sessionNum` and, when known, its instance `sessionUniqueId`. See
 * {@link recordedLapAt}.
 */
function recordedLapStartAt(
  frame: number,
  listing: RecordListing,
  sessionNum: number | null,
  sessionUniqueId: number | null,
): LapStartListEntry | null {
  if (!listing.hit || listing.list !== "lap" || sessionNum === null) return null;

  let found: LapStartListEntry | null = null;

  for (const start of listing.entries) {
    if (listing.landing(start.frame) > frame) break;

    found = start;
  }

  if (found === null || found.sessionNum !== sessionNum) return null;

  return sessionUniqueId === null || found.sessionUniqueId === sessionUniqueId ? found : null;
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
 * not the car's lap in a later one it has not yet crossed the line in. With
 * `sessionUniqueId`, it must be that instance's lap too. Null when the list
 * could not be read (no store, no car on camera, no car number), holds no lap
 * by then, the lap found is another session's or instance's, or the session
 * on screen is not known.
 */
export function recordedLapAt(
  frame: number,
  listing: RecordListing,
  sessionNum: number | null,
  sessionUniqueId: number | null = null,
): number | null {
  return recordedLapStartAt(frame, listing, sessionNum, sessionUniqueId)?.lap ?? null;
}

/**
 * @internal Exported for testing
 *
 * The highest lap the record holds for the camera car in instance
 * `sessionUniqueId` of session `sessionNum`, from its lap list already read:
 * a restarted offline event numbers its sessions from 0 again, so the session
 * number alone would count an earlier instance's laps. Null when the instance
 * is not known (nothing is counted then), the list could not be read, or it
 * holds none.
 */
export function recordedMaxLap(
  listing: RecordListing,
  sessionNum: number,
  sessionUniqueId: number | null,
): number | null {
  if (sessionUniqueId === null || !listing.hit || listing.list !== "lap") return null;

  let max: number | null = null;

  for (const start of listing.entries) {
    if (start.sessionNum !== sessionNum || start.sessionUniqueId !== sessionUniqueId) continue;

    if (max === null || start.lap > max) max = start.lap;
  }

  return max;
}

/**
 * The session on screen: on a reading that is the replay's, its
 * `ReplaySessionNum`; while a jump is under way, the session the record puts
 * the pending landing in. Its instance is that of the recorded session start
 * at the cursor, when that start is of the same session, and otherwise
 * unknown. Null when neither can say which session.
 */
function sessionOnScreen(
  io: ReplayDialStepIo,
  position: ReplayPosition,
  sessionListing: RecordListing,
): SessionOnScreen | null {
  const start = recordedSessionStartAt(position.frame, sessionListing);

  if (position.seeking) {
    return start === null ? null : { sessionNum: start.sessionNum, sessionUniqueId: start.sessionUniqueId };
  }

  const sessionNum = io.telemetry()?.ReplaySessionNum;

  if (typeof sessionNum !== "number" || sessionNum < 0) return null;

  return { sessionNum, sessionUniqueId: start?.sessionNum === sessionNum ? start.sessionUniqueId : null };
}

/**
 * @internal Exported for testing
 *
 * The viewed car's lap over the laps in the session on screen, `12/25`, from
 * the camera car's lap list already read (`lapListing`) and the session list
 * (`sessionListing`, read here when the caller has none to hand). An unknown
 * lap reads `--` and an unknown count drops the denominator
 * (`formatLapOfLaps`). Null on a tick read mid-seek (no position): the box
 * keeps what it showed.
 */
export function lapOfLapsReadout(
  io: ReplayDialStepIo,
  position: ReplayPosition | null,
  lapListing: RecordListing,
  sessionListing: RecordListing | null = null,
): string | null {
  if (position === null) return null;

  const session = sessionOnScreen(io, position, sessionListing ?? listRecord("session", io.recordSource()));

  if (session === null) return formatLapOfLaps(null, null);

  const { sessionNum, sessionUniqueId } = session;
  const start = recordedLapStartAt(position.frame, lapListing, sessionNum, sessionUniqueId);
  const laps = sessionLapCount(
    io.sessionInfo(),
    sessionNum,
    io.telemetry()?.CamCarIdx,
    recordedMaxLap(lapListing, sessionNum, sessionUniqueId),
  );

  return formatLapOfLaps(start?.lap ?? null, laps);
}
