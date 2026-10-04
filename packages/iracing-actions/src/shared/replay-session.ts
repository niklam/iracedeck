/**
 * Whether the loaded session is a saved replay (a `.rpy` opened from the
 * replay browser) rather than a live session: `WeekendInfo.SimMode` reads
 * `"replay"` there (#604). The difference matters to a replay command such as
 * `goToEnd`, which in a live session leaves the replay for the car and in a
 * saved replay only seeks to the end of the file (#1230).
 *
 * False when the session info or the field is missing — the live reading.
 */
export function isReplayOnlySession(sessionInfo: unknown): boolean {
  const weekend = (sessionInfo as Record<string, unknown> | null | undefined)?.WeekendInfo as
    Record<string, unknown> | undefined;

  return weekend?.SimMode === "replay";
}
