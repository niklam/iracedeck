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
 * The highest `SessionNum` the session YAML lists, or null when it lists none.
 * In an event that is not an offline one no session follows that one: a real
 * event runs each of its sessions once (only an offline event restarted from
 * the sim's own menu repeats a `SessionNum`).
 */
export function lastListedSessionNum(sessionInfo: unknown): number | null {
  let last: number | null = null;

  for (const session of readSessions(sessionInfo)) {
    const sessionNum = session?.SessionNum;

    if (typeof sessionNum === "number" && sessionNum >= 0 && (last === null || sessionNum > last)) last = sessionNum;
  }

  return last;
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

/** Whether `session` lists results and `carIdx` is not among them: a car that did not take part. */
function isAbsentFromResults(session: Record<string, unknown> | null | undefined, carIdx: number): boolean {
  const results = session?.ResultsPositions;

  if (!Array.isArray(results) || results.length === 0) return false;

  return !results.some((entry) => (entry as Record<string, unknown> | null)?.CarIdx === carIdx);
}

/** The car whose lap 1 stands in for an unrecorded green, and why that car. */
export interface GreenFallbackCar {
  carIdx: number;
  from: "pole" | "viewed";
}

/**
 * The car whose lap 1 stands in for an unrecorded green in the target
 * session: the pole sitter, unless the target session's results show that car
 * took no part in it (a heat the qualifying pole sitter is not in, a car that
 * never started) — a search for a lap it never drove would run to the end of
 * the session and stop there. Then, as with no qualifying grid at all, the car
 * the camera is on. Null when neither is a car: `CarIdx` 255 is iRacing's
 * "no driver" placeholder, the camera in transition or on the pace car.
 *
 * A session that lists no results yet cannot say who took part, and the pole
 * sitter is kept.
 */
export function resolveGreenFallbackCar(
  sessionInfo: unknown,
  targetSessionNum: number,
  viewedCarIdx: number,
): GreenFallbackCar | null {
  const poleCarIdx = resolvePoleCarIdx(sessionInfo);
  const targetSession = readSessions(sessionInfo).find((s) => s?.SessionNum === targetSessionNum);

  if (poleCarIdx !== null && !isAbsentFromResults(targetSession, poleCarIdx)) {
    return { carIdx: poleCarIdx, from: "pole" };
  }

  if (viewedCarIdx >= 0 && viewedCarIdx !== 255) return { carIdx: viewedCarIdx, from: "viewed" };

  return null;
}

/**
 * Whether the key shows the unavailable look: the session YAML lists sessions
 * and none of them is a race, so a press has nothing to aim at. With no
 * session list at all (not connected, the YAML not parsed yet) the key keeps
 * its plain look — the press does nothing then either, but so does every
 * other key, and a key that is grey whenever the sim is closed would read as
 * broken.
 */
export function isGreenFlagUnavailable(sessionInfo: unknown): boolean {
  const sessions = readSessions(sessionInfo);

  return sessions.length > 0 && !sessions.some(isRace);
}

/**
 * How near the end of the lap before lap 1 a replay search must have left the
 * pole car for its landing to stand in for that car's lap-1 start, when the
 * search itself could not verify the landing. Much looser than the search's
 * own bound for what it writes into the lap record: here the frame is only
 * the anchor of a five-second run-up, and iRacing's lap search does not put
 * the start of a lap on the line. Next Lap can land a few frames before it
 * (measured at 0.9978 on an 85-second lap, #1432), and for lap 1 of a rolling
 * start the search lands over a second before it: measured once, on
 * 2026-10-13 (Motegi, official race, saved replay), at 0.9799, 68 frames
 * before the green and about 100 before the pole car took the line, which
 * makes the run-up 6.1 seconds. The last tenth of the lap takes that in; the
 * first bound, one percent, gave up on it. That lead-in looks like a time,
 * while this bound is a fraction of a lap, so on a lap short enough for the
 * lead-in to be more than a tenth of it the search would still give up and
 * put the replay back; that is not measured. An unverified landing is never
 * recorded, so every such press searches again.
 */
export const GREEN_FALLBACK_MIN_LAP_DIST = 0.9;

/**
 * Whether a replay search's landing can anchor the fallback jump. A landing
 * the search verified always can. One it did not can when the landed sample
 * still shows the car on the lap before lap 1, in the target session, near
 * its end (`priorLapDist`, null when the sample shows anything else).
 */
export function acceptsGreenFallbackLanding(landing: { converged: boolean; priorLapDist: number | null }): boolean {
  if (landing.converged) return true;

  return landing.priorLapDist !== null && landing.priorLapDist >= GREEN_FALLBACK_MIN_LAP_DIST;
}
