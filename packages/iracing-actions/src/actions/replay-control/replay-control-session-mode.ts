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
 * replay's, so it shows the session the record says the jump lands in.
 */
import type { ReplayPosition } from "../../shared/replay-position-state.js";
import type { ReplayDialStepIo } from "./replay-control-dial-mode.js";
import { createRecordStepMode } from "./replay-control-step-mode.js";
import { RECORD_STEPS, type RecordListing } from "./replay-record-step.js";

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
});
