/**
 * iRacing SDK utility functions
 */

/**
 * Check if a bitfield value has a specific flag set.
 * Works with EngineWarnings, SessionFlags, PitSvFlags, CameraState, PaceFlags, etc.
 *
 * @param value - The bitfield value from telemetry (e.g., telemetry.EngineWarnings)
 * @param flag - The flag to check (e.g., EngineWarnings.WaterTempWarning)
 * @returns true if the flag is set, false otherwise
 *
 * @example
 * // Check if water temperature warning is active
 * if (hasFlag(telemetry.EngineWarnings, EngineWarnings.WaterTempWarning)) {
 *     console.log('Water temp warning!');
 * }
 *
 * @example
 * // Check if yellow flag is out
 * if (hasFlag(telemetry.SessionFlags, Flags.Yellow)) {
 *     console.log('Yellow flag!');
 * }
 *
 * @example
 * // Check if tire change is requested in pit service
 * if (hasFlag(telemetry.PitSvFlags, PitSvFlags.LFTireChange)) {
 *     console.log('LF tire change requested');
 * }
 */
export function hasFlag(value: number | undefined, flag: number): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  return (value & flag) !== 0;
}

/**
 * Check if ANY of the specified flags are set in a bitfield value.
 *
 * @param value - The bitfield value from telemetry
 * @param flags - Array of flags where at least one must be set
 * @returns true if ANY flag is set, false otherwise
 *
 * @example
 * // Check if any temperature warning is active
 * if (hasAnyFlag(telemetry.EngineWarnings, [
 *     EngineWarnings.WaterTempWarning,
 *     EngineWarnings.OilTempWarning
 * ])) {
 *     console.log('Temperature warning!');
 * }
 */
export function hasAnyFlag(value: number | undefined, flags: readonly number[]): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  for (const flag of flags) {
    if ((value & flag) !== 0) {
      return true;
    }
  }

  return false;
}

/**
 * Add a flag to a bitfield value.
 * Returns a new value with the flag set.
 *
 * @param value - The current bitfield value (defaults to 0 if undefined)
 * @param flag - The flag to add
 * @returns New value with the flag set
 *
 * @example
 * // Add UIHidden flag to camera state
 * const newState = addFlag(currentState, CameraState.UIHidden);
 *
 * @example
 * // Build a new flag set from scratch
 * let flags = 0;
 * flags = addFlag(flags, CameraState.UIHidden);
 * flags = addFlag(flags, CameraState.UseAutoShotSelection);
 */
export function addFlag(value: number | undefined, flag: number): number {
  return (value ?? 0) | flag;
}

/**
 * Remove a flag from a bitfield value.
 * Returns a new value with the flag cleared.
 *
 * @param value - The current bitfield value (defaults to 0 if undefined)
 * @param flag - The flag to remove
 * @returns New value with the flag cleared
 *
 * @example
 * // Remove UIHidden flag from camera state
 * const newState = removeFlag(currentState, CameraState.UIHidden);
 */
export function removeFlag(value: number | undefined, flag: number): number {
  return (value ?? 0) & ~flag;
}
