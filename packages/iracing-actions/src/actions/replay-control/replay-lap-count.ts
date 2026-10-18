/**
 * Replay Control dial — the laps in a session, for the Lap value and the
 * Session caption, `12/25` (#801, the maintainer's second test round of
 * 2026-10-18). Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`
 * ("The display").
 *
 * The denominator is the session's scheduled laps
 * (`SessionInfo.Sessions[n].SessionLaps`) when it is a number. An unlimited
 * session (practice, qualifying, a timed race) has none, so it is the laps the
 * viewed car completed in it, from the session's results
 * (`ResultsPositions[].LapsComplete`) once it has some, else the highest lap
 * the record holds for that car in it, else nothing. Pure: the caller reads
 * the session info, the camera car and the record and hands them in.
 */

/** A whole number above zero, read from a number or a string of digits; null for anything else (`unlimited`, absent, 0). */
function positiveCount(raw: unknown): number | null {
  const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;

  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
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
 * scheduled `SessionLaps` when it is a number; otherwise that car's
 * `LapsComplete` in the session's `ResultsPositions` when above zero;
 * otherwise `recordedMaxLap`, the highest lap the record holds for the car in
 * that session; otherwise null, and the value has no denominator.
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
    typeof carIdx === "number" ? positiveCount(results.find((row) => row?.CarIdx === carIdx)?.LapsComplete) : null;

  if (completed !== null) return completed;

  return recordedMaxLap !== null && recordedMaxLap > 0 ? recordedMaxLap : null;
}

/**
 * @internal Exported for testing
 *
 * `12/25`: the lap on screen over the laps in the session. An unknown lap
 * reads `--` (without the record the lap on screen is not known), and with no
 * count there is no denominator: `12`, or `--`.
 */
export function formatLapOfLaps(lap: number | null, laps: number | null): string {
  const current = lap === null ? "--" : String(lap);

  return laps === null ? current : `${current}/${laps}`;
}
