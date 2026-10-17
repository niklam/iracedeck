/**
 * Replay Control dial — Lap (#801): the viewed car's next / previous lap per
 * detent, by #1426's record step, else by iRacing's own lap search. A rotation
 * mode of the dial surface (`replay-control-dial-mode.ts`); what a turn does is
 * the shared record-step mode (`replay-control-step-mode.ts`). Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`.
 *
 * The box shows the lap on screen from the record, not from `CarIdxLap`: in a
 * replay watched inside a live session the per-car arrays read the live
 * field, and four snapshots scrubbed back to the camera car racing all read
 * −1 there. Without a recorded lap for the car at the cursor it shows the
 * replay time, and so it does when the car's last recorded lap by then is
 * another session's: the record spans every session of the file, so a race
 * watched before the car's first race lap crossing would otherwise show its
 * last qualifying lap.
 */
import type { ReplayPosition } from "../../shared/replay-position-state.js";
import type { ReplayDialStepIo } from "./replay-control-dial-mode.js";
import { recordedSessionAt } from "./replay-control-session-mode.js";
import { createRecordStepMode, formatReplayClock } from "./replay-control-step-mode.js";
import { listRecord, RECORD_STEPS, type RecordListing } from "./replay-record-step.js";

/** The replay-cursor owner every Lap turn's jump and search goes out under. */
const CURSOR_OWNER = "dial-lap";

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
  if (!listing.hit || listing.list !== "lap" || sessionNum === null) return null;

  let found: { lap: number; sessionNum: number } | null = null;

  for (const start of listing.entries) {
    if (listing.landing(start.frame) > frame) break;

    found = start;
  }

  return found !== null && found.sessionNum === sessionNum ? found.lap : null;
}

/**
 * The session on screen, judged as the Session view judges it: on a reading
 * that is the replay's, its `ReplaySessionNum`; while a jump is under way, the
 * session the record puts the pending landing in. Null when neither can say.
 */
function sessionOnScreen(io: ReplayDialStepIo, position: ReplayPosition): number | null {
  if (position.seeking) return recordedSessionAt(position.frame, listRecord("session", io.recordSource()));

  const sessionNum = io.telemetry()?.ReplaySessionNum;

  return typeof sessionNum === "number" && sessionNum >= 0 ? sessionNum : null;
}

/** The Lap value: `L12` from the record, else the replay time; null mid-seek. */
function lapValue(io: ReplayDialStepIo, position: ReplayPosition | null, listing: RecordListing): string | null {
  if (position === null) return null;

  const lap = recordedLapAt(position.frame, listing, sessionOnScreen(io, position));

  return lap === null ? formatReplayClock(position.time) : `L${lap}`;
}

/** The Lap mode. Clockwise is the next lap, counter-clockwise the previous one. */
export const lapMode = createRecordStepMode({
  label: "LAP",
  rotateDescription: "Next / previous lap",
  target: "lap",
  owner: CURSOR_OWNER,
  logLabel: "Dial lap",
  steps: { next: RECORD_STEPS["next-lap"], previous: RECORD_STEPS["prev-lap"] },
  value: lapValue,
});
