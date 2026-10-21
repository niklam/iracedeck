/**
 * Replay Control dial — the laps in a session, for the Lap value and the
 * Session caption, `12/25` (#801, the maintainer's second test round of
 * 2026-10-18). Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`
 * ("The display").
 *
 * The numerator and the denominator count the same thing, the laps driven,
 * the lap under way included, so the numerator never runs past the
 * denominator:
 *
 * - **The numerator** is the lap being driven, from the record. The recorder
 *   stores the lap a crossing starts (`completed + 1`), so the finish crossing
 *   of a 25-lap race is recorded as a lap-26 start and the cool-down lap would
 *   read `26/25`; the numerator is capped at the denominator.
 * - **The denominator** is the session's scheduled laps
 *   (`SessionInfo.Sessions[n].SessionLaps`) when it is a number. An unlimited
 *   session (practice, qualifying, a timed race) has none, so it is the
 *   larger of the laps the viewed car completed in it, from the session's
 *   results (`ResultsPositions[].LapsComplete`), and the highest lap the
 *   record holds for that car in it: on lap 13 with 12 complete that is 13,
 *   with a results row or without one. Once the results are official
 *   (`ResultsOfficial` 1: an earlier session, or a race into its cool-down)
 *   the session is over, and a lap start at or after the car's last
 *   completed lap — the finish crossing's — is not a lap of it: the
 *   denominator is the car's completed laps. With none of these there is no
 *   denominator.
 *
 * Pure: the caller reads the session info, the camera car and the record and
 * hands them in.
 */

/** A whole number above zero, read from a number or a string of digits; null for anything else (`unlimited`, absent, 0). */
function positiveCount(raw: unknown): number | null {
  const value = wholeCount(raw);

  return value !== null && value > 0 ? value : null;
}

/** A whole number of zero or more, read from a number or a string of digits; null for anything else (absent, −1). */
function wholeCount(raw: unknown): number | null {
  const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;

  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Session `sessionNum` of the session info's `SessionInfo.Sessions`, or null. */
function findSession(sessionInfo: unknown, sessionNum: number): Record<string, unknown> | null {
  const root = (sessionInfo as Record<string, unknown> | null | undefined)?.SessionInfo as
    Record<string, unknown> | undefined;
  const sessions = Array.isArray(root?.Sessions) ? (root.Sessions as Array<Record<string, unknown> | null>) : [];

  return sessions.find((session) => session?.SessionNum === sessionNum) ?? null;
}

/**
 * @internal Exported for testing
 *
 * The laps in session `sessionNum` for the car at `carIdx`: the session's
 * scheduled `SessionLaps` when it is a number. Otherwise, once the session's
 * results are official, that car's `LapsComplete` in them (null when it
 * completed none); before then the larger of that `LapsComplete` and
 * `recordedMaxLap`, the highest lap the record holds for the car in that
 * session, either when the other is missing; otherwise null, and the value
 * has no denominator. An official result with no row for the car falls back
 * to the record.
 */
export function sessionLapCount(
  sessionInfo: unknown,
  sessionNum: number,
  carIdx: number | undefined,
  recordedMaxLap: number | null,
): number | null {
  const session = findSession(sessionInfo, sessionNum);
  const scheduled = positiveCount(session?.SessionLaps);

  if (scheduled !== null) return scheduled;

  const results = Array.isArray(session?.ResultsPositions)
    ? (session.ResultsPositions as Array<Record<string, unknown> | null>)
    : [];
  const completed =
    typeof carIdx === "number" ? wholeCount(results.find((row) => row?.CarIdx === carIdx)?.LapsComplete) : null;
  const recorded = recordedMaxLap !== null && recordedMaxLap > 0 ? recordedMaxLap : null;

  // Over: no lap the record holds from the finish crossing on is a lap of it.
  if (completed !== null && wholeCount(session?.ResultsOfficial) === 1) return completed > 0 ? completed : null;

  const driven = completed !== null && completed > 0 ? completed : null;

  if (driven === null) return recorded;

  return recorded === null ? driven : Math.max(driven, recorded);
}

/**
 * @internal Exported for testing
 *
 * `12/25`: the lap on screen over the laps in the session, the lap capped at
 * the count so it never reads past it (a finisher's cool-down lap is the
 * recorder's lap 26 of 25). An unknown lap reads `--` (without the record the
 * lap on screen is not known), and with no count there is no denominator:
 * `12`, or `--`.
 */
export function formatLapOfLaps(lap: number | null, laps: number | null): string {
  if (lap === null) return laps === null ? "--" : `--/${laps}`;

  return laps === null ? String(lap) : `${Math.min(lap, laps)}/${laps}`;
}
