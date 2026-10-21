/**
 * Replay Control dial — Session (#801): the next / previous session per
 * detent, by #1426's record step, else by iRacing's own session search. A
 * rotation mode of the dial surface (`replay-control-dial-mode.ts`); what a
 * turn does is the shared record-step mode (`replay-control-step-mode.ts`).
 * Design: `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`.
 *
 * The box shows the cursor's session by its type from the session info,
 * `SessionInfo.Sessions[ReplaySessionNum].SessionType` upper-cased (`RACE`),
 * which the box fits. While a jump is under way the reading is not the
 * replay's, so it shows the session the record says the jump lands in. The
 * caption is the viewed car's lap over the laps in that session, `12/25`, as
 * Lap's value (`replay-dial-lap-readout.ts`), which the paced search's count
 * takes while it works for sessions (the maintainer's second test round,
 * 2026-10-18).
 */
import { listRecord, RECORD_STEPS, type RecordListing, type ReplayPosition } from "@iracedeck/replay-engine";

import type { ReplayDialStepIo } from "./replay-control-dial-mode.js";
import { createRecordStepMode } from "./replay-control-step-mode.js";
import { lapOfLapsReadout, recordedSessionAt } from "./replay-dial-lap-readout.js";

/** The replay-cursor owner every Session turn's jump and search goes out under. */
const CURSOR_OWNER = "dial-session";

/**
 * @internal Exported for testing
 *
 * The name of session `sessionNum`: its `SessionType` from the session info,
 * upper-cased, or `S2` when the session info does not list it by that
 * `SessionNum` or gives it no type.
 */
export function sessionName(sessionInfo: unknown, sessionNum: number): string {
  const root = (sessionInfo as Record<string, unknown> | null | undefined)?.SessionInfo as
    Record<string, unknown> | undefined;
  const sessions = Array.isArray(root?.Sessions) ? (root.Sessions as Array<Record<string, unknown> | null>) : [];
  const type = sessions.find((session) => session?.SessionNum === sessionNum)?.SessionType;

  return typeof type === "string" && type.trim() !== "" ? type.trim().toUpperCase() : `S${sessionNum}`;
}

/**
 * The Session value. On a reading that is the replay's, its `ReplaySessionNum`;
 * while a jump is under way, the session the record puts its landing in; null
 * when neither can say, and the box keeps what it showed.
 */
function sessionValue(io: ReplayDialStepIo, position: ReplayPosition | null, listing: RecordListing): string | null {
  if (position === null) return null;

  if (position.seeking) {
    const landing = recordedSessionAt(position.frame, listing);

    return landing === null ? null : sessionName(io.sessionInfo(), landing);
  }

  const sessionNum = io.telemetry()?.ReplaySessionNum;

  return typeof sessionNum === "number" && sessionNum >= 0 ? sessionName(io.sessionInfo(), sessionNum) : "";
}

/** The Session mode. Clockwise is the next session, counter-clockwise the previous one. */
export const sessionMode = createRecordStepMode({
  label: "SESSION",
  rotateDescription: "Next / previous session",
  target: "session",
  owner: CURSOR_OWNER,
  logLabel: "Dial session",
  steps: { next: RECORD_STEPS["next-session"], previous: RECORD_STEPS["prev-session"] },
  value: sessionValue,
  // The camera car's lap list, read only for the caption: the mode's own list is the sessions.
  caption: (io, position, listing) => lapOfLapsReadout(io, position, listRecord("lap", io.recordSource()), listing),
});
