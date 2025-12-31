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
 * Check if multiple flags are ALL set in a bitfield value.
 *
 * @param value - The bitfield value from telemetry
 * @param flags - Array of flags that must all be set
 * @returns true if ALL flags are set, false otherwise
 *
 * @example
 * // Check if both yellow and caution flags are active
 * if (hasAllFlags(telemetry.SessionFlags, [Flags.Yellow, Flags.Caution])) {
 *     console.log('Full course yellow!');
 * }
 */
export function hasAllFlags(value: number | undefined, flags: number[]): boolean {
	if (value === undefined || value === null) {
		return false;
	}
	for (const flag of flags) {
		if ((value & flag) === 0) {
			return false;
		}
	}
	return true;
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
export function hasAnyFlag(value: number | undefined, flags: number[]): boolean {
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
 * Get all active flags from a bitfield value.
 * Returns an array of flag values that are set.
 *
 * @param value - The bitfield value from telemetry
 * @param flagEnum - The enum object containing all possible flags
 * @returns Array of flag values that are set
 *
 * @example
 * // Get all active engine warnings
 * const activeWarnings = getActiveFlags(telemetry.EngineWarnings, EngineWarnings);
 * // Returns e.g. [1, 4] for WaterTempWarning and OilPressureWarning
 */
export function getActiveFlags<T extends Record<string, number>>(
	value: number | undefined,
	flagEnum: T
): number[] {
	if (value === undefined || value === null) {
		return [];
	}

	const activeFlags: number[] = [];
	for (const key of Object.keys(flagEnum)) {
		const flagValue = flagEnum[key];
		// Skip non-numeric values (TypeScript enum reverse mappings)
		if (typeof flagValue === 'number' && (value & flagValue) !== 0) {
			activeFlags.push(flagValue);
		}
	}
	return activeFlags;
}

/**
 * Get the names of all active flags from a bitfield value.
 * Returns an array of flag names that are set.
 *
 * @param value - The bitfield value from telemetry
 * @param flagEnum - The enum object containing all possible flags
 * @returns Array of flag names that are set
 *
 * @example
 * // Get names of all active engine warnings
 * const warningNames = getActiveFlagNames(telemetry.EngineWarnings, EngineWarnings);
 * // Returns e.g. ['WaterTempWarning', 'OilPressureWarning']
 */
export function getActiveFlagNames<T extends Record<string, number | string>>(
	value: number | undefined,
	flagEnum: T
): string[] {
	if (value === undefined || value === null) {
		return [];
	}

	const activeNames: string[] = [];
	for (const key of Object.keys(flagEnum)) {
		const flagValue = flagEnum[key];
		// Only process numeric values (skip TypeScript enum reverse mappings)
		if (typeof flagValue === 'number' && (value & flagValue) !== 0) {
			activeNames.push(key);
		}
	}
	return activeNames;
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
 * Add multiple flags to a bitfield value.
 * Returns a new value with all flags set.
 *
 * @param value - The current bitfield value (defaults to 0 if undefined)
 * @param flags - Array of flags to add
 * @returns New value with all flags set
 *
 * @example
 * // Add multiple camera state flags at once
 * const newState = addFlags(currentState, [
 *     CameraState.UIHidden,
 *     CameraState.UseAutoShotSelection
 * ]);
 */
export function addFlags(value: number | undefined, flags: number[]): number {
	let result = value ?? 0;
	for (const flag of flags) {
		result |= flag;
	}
	return result;
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

/**
 * Remove multiple flags from a bitfield value.
 * Returns a new value with all specified flags cleared.
 *
 * @param value - The current bitfield value (defaults to 0 if undefined)
 * @param flags - Array of flags to remove
 * @returns New value with all specified flags cleared
 *
 * @example
 * // Remove multiple camera state flags at once
 * const newState = removeFlags(currentState, [
 *     CameraState.UIHidden,
 *     CameraState.CamToolActive
 * ]);
 */
export function removeFlags(value: number | undefined, flags: number[]): number {
	let result = value ?? 0;
	for (const flag of flags) {
		result &= ~flag;
	}
	return result;
}

/**
 * Toggle a flag in a bitfield value.
 * If the flag is set, it will be cleared. If cleared, it will be set.
 *
 * @param value - The current bitfield value (defaults to 0 if undefined)
 * @param flag - The flag to toggle
 * @returns New value with the flag toggled
 *
 * @example
 * // Toggle UIHidden flag
 * const newState = toggleFlag(currentState, CameraState.UIHidden);
 */
export function toggleFlag(value: number | undefined, flag: number): number {
	return (value ?? 0) ^ flag;
}

/**
 * Set a flag to a specific state (on or off).
 *
 * @param value - The current bitfield value (defaults to 0 if undefined)
 * @param flag - The flag to set
 * @param enabled - Whether the flag should be enabled (true) or disabled (false)
 * @returns New value with the flag in the specified state
 *
 * @example
 * // Set UIHidden based on a boolean
 * const newState = setFlag(currentState, CameraState.UIHidden, shouldHideUI);
 */
export function setFlag(value: number | undefined, flag: number, enabled: boolean): number {
	if (enabled) {
		return addFlag(value, flag);
	} else {
		return removeFlag(value, flag);
	}
}
