/**
 * Per-device car-selection intent (issue #790).
 *
 * The Car Selector grid (the Race Admin `select-car` mode) is a generic
 * "pick a car" surface: what a press MEANS is decided by the key that took the
 * user there. An entry key (e.g. Camera Controls' focus-select-car mode) sets
 * an intent for its device before switching to the selector profile; the
 * select-car keys read it at press time (and at render time, for the
 * focused-car highlight). No intent = the legacy race-admin behavior.
 *
 * Deliberately IN-MEMORY, not a `_`-prefixed global setting: every action runs
 * in the same plugin process, a restart can never resurrect a stale intent,
 * and nothing transient lands in persisted settings. Keyed by deviceId so
 * multi-deck setups stay independent; hosts that report no device id group
 * under "" (the same normalization as the selector's context tracking).
 *
 * Cleared by every Switch Profile press on the device (leaving the grid, or
 * entering it via plain navigation), and by host-profile-marker reports of a
 * non-selector profile becoming visible.
 */

/** What selecting a car should do. Extensible record — future consumers add actions. */
export interface SelectIntent {
  action: "focus-camera";
}

const intents = new Map<string, SelectIntent>();

function normalize(deviceId: string | undefined): string {
  return deviceId ?? "";
}

/** Set the device's pending selection intent (overwrites any previous one). */
export function setSelectIntent(deviceId: string | undefined, intent: SelectIntent): void {
  intents.set(normalize(deviceId), intent);
}

/** The device's pending selection intent, or `undefined` when none is set. */
export function getSelectIntent(deviceId: string | undefined): SelectIntent | undefined {
  return intents.get(normalize(deviceId));
}

/** Drop the device's pending selection intent. No-op when none is set. */
export function clearSelectIntent(deviceId: string | undefined): void {
  intents.delete(normalize(deviceId));
}

/** @internal Reset for tests. */
export function _resetSelectIntents(): void {
  intents.clear();
}
