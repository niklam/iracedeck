/**
 * iRacing SDK car-capability detection.
 *
 * iRacing only exposes a driver-control (`dc*`) telemetry field when the car actually
 * has that control, so the *presence* of a field — not its value — signals whether the
 * car has the feature. These pure helpers wrap that field-presence check so consumers
 * (actions, audio-scenarios, tests) can ask "does this car have X?" consistently.
 */
import { Flags, SessionState, type TelemetryData } from "@iracedeck/iracing-native";

import { hasFlag } from "./utils.js";

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

/**
 * Whether the driver is genuinely live in their own car on track — i.e. driving,
 * not watching a replay, spectating, or sitting in the session menu / on the
 * grid out of the car (where iRacing reports `IsReplayPlaying: true` and/or
 * `IsOnTrack: false`). Mirrors the translator's `driver.firstOnTrack` gate.
 *
 * Race-engineer callouts that only make sense to a driver in the car (start
 * lights, the race-formation flags) gate on this so they stay silent while the
 * user is out of the car at the grid / in a replay.
 *
 * @param t - The latest telemetry snapshot, or null when unavailable
 * @returns true only when `IsOnTrack` is true and `IsReplayPlaying` is not true
 */
export function isLiveOnTrack(t: TelemetryData | null | undefined): boolean {
  return t?.IsOnTrack === true && t?.IsReplayPlaying !== true;
}

/**
 * Whether the session is in a POST-RACE phase — the checkered flag is out or the
 * field is in cool-down. The mirror image of {@link isPreGreen}: both are
 * defined as EXPLICIT state sets (not a `=== Racing` negation) so a missing
 * `SessionState` yields `false` (back-compat for callers/tests that don't supply
 * it), and only the genuinely-finished states match.
 *
 * Race-progression / formation callouts (the rolling-start "one pace lap to go",
 * "green's coming", crossed flags, ten/five-to-go) gate on `!isPostRace` so they
 * stay silent once the race is over — iRacing re-asserts some of the grid bits
 * (e.g. `OneLapToGreen`) during cool-down / next-session grid formation, which
 * otherwise re-fired "one pace lap to go" after the checkered (issue #657).
 *
 * @param t - The latest telemetry snapshot, or null when unavailable
 * @returns true during Checkered / CoolDown; false otherwise
 */
export function isPostRace(t: TelemetryData | null | undefined): boolean {
  const state = t?.SessionState;

  return state === SessionState.Checkered || state === SessionState.CoolDown;
}

/**
 * Whether a driver-penalty flag — `Black` or `Disqualify` — is currently shown
 * to the player. This is THE definition of "the furled warning escalated into
 * an actual penalty" (issue #846): iRacing raises the real black flag by
 * clearing `Furled` and setting `Black` in the same transition, so the
 * translator's same-tick cleared-suppression and the audio layer's speak-time
 * gate must agree on what counts as a penalty — both call this predicate so
 * the two layers cannot silently diverge.
 *
 * Missing telemetry or a missing `SessionFlags` yields `false` (not escalated)
 * — don't punish missing data; a consumer that needs a different unknown-state
 * answer should check for null before calling.
 *
 * @param t - The latest telemetry snapshot, or null when unavailable
 * @returns true when the Black or Disqualify session-flag bit is set
 */
export function isPenaltyFlagActive(t: TelemetryData | null | undefined): boolean {
  return hasFlag(t?.SessionFlags, Flags.Black) || hasFlag(t?.SessionFlags, Flags.Disqualify);
}
