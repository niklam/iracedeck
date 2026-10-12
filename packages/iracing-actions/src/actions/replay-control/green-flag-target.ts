/**
 * What Replay Control's Jump to Green Flag aims at (issue #1354): which race
 * session a press targets, where in it the jump lands, and which car's lap 1
 * stands in for the green when it was not recorded. Pure functions over the
 * session YAML and one telemetry sample; the press path, its guards and the
 * replay commands are the action's.
 * Design: docs/superpowers/specs/2026-10-05-issue-1354-replay-jump-to-green-flag.md.
 */
import { calculateGridPositions, extractQualifyResults, type TelemetryData } from "@iracedeck/iracing-sdk";

/**
 * How far before the green the jump lands: five seconds at 60 frames per
 * second. A standing start is then at about the moment the gantry reaches
 * Set, a rolling start has the field bunched and coming to the line. A saved
 * `.rpy` lands a live-recorded frame about a second early (the store's
 * `REPLAY_FILE_FRAME_LAG`), which only lengthens the run-up. A constant, not a
 * setting: the run-up is the point of the jump, and Jump to Fastest Lap's one
 * second would show a start already under way.
 */
export const GREEN_APPROACH_FRAMES = 300;

/** The frame a jump to a green at `frame` lands on. */
export function greenApproachFrame(frame: number): number {
  return Math.max(0, frame - GREEN_APPROACH_FRAMES);
}

/** The race session a press targets. */
export interface GreenFlagTarget {
  sessionNum: number;
  /**
   * The replay's `SessionUniqueID` when the target is the cursor's own
   * session; null for the last race session reached from elsewhere, whose
   * unique id the cursor's telemetry does not carry — the record is then
   * looked up by `sessionNum`.
   */
  sessionUniqueId: number | null;
  /** Whether the cursor is inside the target, or the target is the last race session of the replay. */
  from: "cursor" | "last-race";
}

function readSessions(sessionInfo: unknown): Array<Record<string, unknown> | null | undefined> {
  const sessionInfoRoot = (sessionInfo as Record<string, unknown> | null | undefined)?.SessionInfo as
    Record<string, unknown> | undefined;
  const sessions = sessionInfoRoot?.Sessions;

  return Array.isArray(sessions) ? (sessions as Array<Record<string, unknown> | null | undefined>) : [];
}

/**
 * A session is a race when its `SessionType` is exactly `Race` — the reading
 * the translator's green recorder takes, so a session a press targets is one
 * the record can hold. Deliberately not the Race Engineer's "anything that is
 * not practice or qualifying": a `Warmup` session also goes green, and nobody
 * reviews that one.
 */
function isRace(session: Record<string, unknown> | null | undefined): boolean {
  return session?.SessionType === "Race";
}

/**
 * The race session a press targets, or null when the replay holds none — the
 * one case in which the key is unavailable.
 *
 * 1. The cursor's session when it is a race, so a press inside a heat goes to
 *    that heat's green.
 * 2. Otherwise the LAST race session the session YAML lists: the race of a
 *    single-race event whether the cursor sits in practice, qualifying or a
 *    warmup, and the feature of a heat event.
 *
 * A cursor with no settled session (`SessionNum` −1, the post-seek transient)
 * is "not in a race", so the target is still known and the key does not
 * flicker to unavailable across a seek; ignoring a press on that tick is the
 * action's guard. Sessions are matched by their `SessionNum` field, not by
 * array position.
 */
export function resolveGreenFlagTarget(sessionInfo: unknown, telemetry: TelemetryData | null): GreenFlagTarget | null {
  const sessions = readSessions(sessionInfo);
  const cursorSessionNum = telemetry?.SessionNum;

  if (typeof cursorSessionNum === "number" && cursorSessionNum >= 0) {
    const cursorSession = sessions.find((s) => s?.SessionNum === cursorSessionNum);

    if (isRace(cursorSession)) {
      return {
        sessionNum: cursorSessionNum,
        sessionUniqueId: typeof telemetry?.SessionUniqueID === "number" ? telemetry.SessionUniqueID : null,
        from: "cursor",
      };
    }
  }

  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i];
    const sessionNum = session?.SessionNum;

    if (isRace(session) && typeof sessionNum === "number" && sessionNum >= 0) {
      return { sessionNum, sessionUniqueId: null, from: "last-race" };
    }
  }

  return null;
}

/**
 * The pole sitter's `carIdx` from the qualifying grid, or null when iRacing
 * has published none. The grid exists for standing and rolling starts alike
 * and for race-only events (#974), which is what makes the pole car the
 * stand-in for an unrecorded green: it takes the line first, so its lap 1
 * starts a second or two after the green at most.
 */
export function resolvePoleCarIdx(sessionInfo: unknown): number | null {
  const ranks = calculateGridPositions(extractQualifyResults(sessionInfo) ?? []);
  const carIdx = ranks?.indexOf(1) ?? -1;

  return carIdx >= 0 ? carIdx : null;
}
