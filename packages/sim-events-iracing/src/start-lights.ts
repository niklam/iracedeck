/**
 * Start-light session-YAML helpers (issue #480).
 *
 * Pure functions reading from the SDK's session YAML, mirroring the shape of
 * `track-type.ts`. They classify the two pre-start signals the start-light diff
 * needs that aren't in the per-tick telemetry:
 *
 *   - {@link resolveStandingStart} — whether the race is a standing start
 *     (the gantry red→green procedure with a real `SessionTimeRemain`
 *     countdown). Rolling starts hold `StartReady` through the parade with no
 *     `SessionTimeRemain`, so the countdown and the standing-only `start-ready`
 *     callout are gated on this.
 *   - {@link resolveIsAiRace} — whether any opponent is an AI driver. AI races
 *     compress the pre-start procedure, so the numeric countdown is suppressed
 *     entirely as a belt-and-suspenders guard (the window-gate already handles
 *     short procedures; this makes "never 5 s+ in an AI race" explicit).
 *
 * Both are defensive against missing / malformed YAML and return `false`.
 */

/**
 * Whether the session is a standing start (`WeekendInfo.WeekendOptions.
 * StandingStart === 1`). Missing / malformed YAML → `false` (rolling).
 *
 * @internal Exported for testing.
 */
export function resolveStandingStart(sessionInfo: Record<string, unknown> | null): boolean {
  if (!sessionInfo) return false;

  const weekendInfo = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;
  const weekendOptions = weekendInfo?.WeekendOptions as Record<string, unknown> | undefined;

  return weekendOptions?.StandingStart === 1;
}

/**
 * Whether any driver in the session is an AI (`DriverInfo.Drivers[i].CarIsAI
 * === 1`). Missing / malformed YAML → `false`.
 *
 * @internal Exported for testing.
 */
export function resolveIsAiRace(sessionInfo: Record<string, unknown> | null): boolean {
  if (!sessionInfo) return false;

  const driverInfo = sessionInfo.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as Array<Record<string, unknown>> | undefined;

  if (!Array.isArray(drivers)) return false;

  return drivers.some((driver) => driver?.CarIsAI === 1);
}
