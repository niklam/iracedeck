/**
 * iRacing SDK car-capability detection.
 *
 * iRacing only exposes a driver-control (`dc*`) telemetry field when the car actually
 * has that control, so the *presence* of a field — not its value — signals whether the
 * car has the feature. These pure helpers wrap that field-presence check so consumers
 * (actions, audio-scenarios, tests) can ask "does this car have X?" consistently.
 */
import type { TelemetryData } from "@iracedeck/iracing-native";

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
