import { hasFlag, PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";

/**
 * Shared pit fuel-fill / autofuel telemetry readers.
 *
 * These derive pit-service state directly from live iRacing telemetry — never a
 * sticky local flag — and are consumed by both of Fuel Service's surfaces
 * (keypad and dial), so they live here rather than being copied per consumer.
 */

/**
 * Whether the iRacing pit fuel-fill checkbox is currently ON, derived from the
 * live `PitSvFlags` bitfield. This is the single source of truth for "fueling
 * on/off".
 */
export function isFuelFillOn(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.PitSvFlags === undefined) return false;

  return hasFlag(telemetry.PitSvFlags, PitSvFlags.FuelFill);
}

/**
 * Whether autofuel is active for the next pit stop (`dpFuelAutoFillActive`).
 * The Fuel Service dial surface reads this live to decide which mode it is in
 * (manual vs autofuel).
 */
export function isAutofuelActive(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.dpFuelAutoFillActive === undefined) return false;

  return telemetry.dpFuelAutoFillActive !== 0;
}

/**
 * Whether the autofuel system is available for this car/series
 * (`dpFuelAutoFillEnabled`). When disabled, autofuel UI should show N/A.
 * Defaults to true when the field is absent (older telemetry) so a missing
 * field never spuriously reports autofuel as unavailable.
 */
export function isAutofuelEnabled(telemetry: TelemetryData | null): boolean {
  if (!telemetry || telemetry.dpFuelAutoFillEnabled === undefined) return true;

  return telemetry.dpFuelAutoFillEnabled !== 0;
}
