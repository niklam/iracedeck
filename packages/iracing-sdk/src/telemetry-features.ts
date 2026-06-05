/**
 * iRacing SDK car-capability detection.
 *
 * iRacing only exposes a driver-control (`dc*`) telemetry field when the car actually
 * has that control, so the *presence* of a field — not its value — signals whether the
 * car has the feature. These pure helpers wrap that field-presence check so consumers
 * (actions, audio-scenarios, tests) can ask "does this car have X?" consistently.
 */
import { SessionState, type TelemetryData } from "@iracedeck/iracing-native";

/**
 * Check whether the current car has a pit speed limiter.
 *
 * iRacing only exposes `dcPitSpeedLimiterToggle` on cars equipped with a limiter, so
 * the field's presence is the capability signal (its boolean value is the on/off state).
 *
 * @param t - The latest telemetry snapshot, or null when no telemetry is available
 * @returns true if the car has a pit limiter, false otherwise (including for null)
 *
 * @example
 * if (!hasPitLimiter(getLatestTelemetry())) {
 *     // skip pit-limiter callouts / grey out the limiter button
 * }
 */
export function hasPitLimiter(t: TelemetryData | null): boolean {
  return t?.dcPitSpeedLimiterToggle !== undefined;
}

/**
 * Check whether the current car has a tear-off visor (typically open-cockpit cars).
 *
 * iRacing only exposes `dcTearOffVisor` on cars with a visor. Visor and wipers are
 * mutually exclusive per car, so {@link hasVisor} and {@link hasWipers} are complementary.
 *
 * @param t - The latest telemetry snapshot, or null when no telemetry is available
 * @returns true if the car has a tear-off visor, false otherwise (including for null)
 */
export function hasVisor(t: TelemetryData | null): boolean {
  return t?.dcTearOffVisor !== undefined;
}

/**
 * Check whether the current car has windshield wipers (typically closed-cockpit cars).
 *
 * iRacing exposes either `dcToggleWindshieldWipers` (on/off) or `dcTriggerWindshieldWipers`
 * (momentary) on cars with wipers; presence of either signals the capability. Wipers and
 * a tear-off visor are mutually exclusive per car, so {@link hasWipers} and {@link hasVisor}
 * are complementary.
 *
 * @param t - The latest telemetry snapshot, or null when no telemetry is available
 * @returns true if the car has windshield wipers, false otherwise (including for null)
 */
export function hasWipers(t: TelemetryData | null): boolean {
  return t?.dcToggleWindshieldWipers !== undefined || t?.dcTriggerWindshieldWipers !== undefined;
}

/**
 * Whether the session is in a PRE-GREEN phase — the grid / warmup / formation
 * (parade) lap before the green flag, plus `Invalid` (telemetry settling /
 * unknown). During these phases neither iRacing's live-standings position
 * fields (`PlayerCarPosition` / `CarIdxPosition`) nor the lap-distance-derived
 * running order are meaningful: on a rolling-start formation lap the whole
 * field reads `0` until cars cross the start/finish line. Callers use this to
 * suppress position-change callouts and to show the qualifying grid slot
 * instead of a churning/zero live position (issue #647).
 *
 * Defined as the EXPLICIT set of pre-racing states, NOT `!== Racing`:
 *   - a missing `SessionState` yields `false` (back-compat — callers/tests that
 *     don't supply it keep their prior behavior), and
 *   - the post-racing states (`Checkered` / `CoolDown`) are not pre-green, so
 *     legitimate late-race passes are never suppressed.
 *
 * NOTE: this is distinct from the translator's fresh-connect race-start gate,
 * which deliberately treats `Invalid` as "telemetry still settling, keep
 * waiting" rather than pre-green (issue #604) — that gate is a separate 3-state
 * predicate and intentionally does not use this helper.
 *
 * @param t - The latest telemetry snapshot, or null when unavailable
 * @returns true during Invalid / GetInCar / Warmup / ParadeLaps; false otherwise
 */
export function isPreGreen(t: TelemetryData | null | undefined): boolean {
  const state = t?.SessionState;

  return (
    state === SessionState.Invalid ||
    state === SessionState.GetInCar ||
    state === SessionState.Warmup ||
    state === SessionState.ParadeLaps
  );
}
