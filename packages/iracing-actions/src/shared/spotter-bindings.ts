/**
 * iRacing AI Spotter key bindings shared across actions (issues #259, #809).
 *
 * The spotter has no SDK surface — every control is a keyboard/SimHub binding
 * stored in global settings. Two actions dispatch them: AI Spotter Controls
 * (every control, on a keypad button) and the Audio Controls dial (louder /
 * quieter on rotation, silence on press — the spotter volume dial lives on
 * the one audio dial rather than growing a second dial surface). This module
 * is the single source of truth for the binding keys so neither action
 * duplicates the literals nor imports the other.
 */

/** Every AI Spotter control, in the order the AI Spotter Controls PI lists them. */
export const SPOTTER_CONTROLS = [
  "damage-report",
  "weather-report",
  "toggle-report-laps",
  "announce-leader",
  "louder",
  "quieter",
  "silence",
] as const;

export type SpotterControl = (typeof SPOTTER_CONTROLS)[number];

/**
 * Global-settings key holding each control's binding (the `setting` of the
 * matching `aiSpotterControls` row in `data/key-bindings.json`; also consumed
 * by `comms-catalog.ts`).
 */
export const SPOTTER_GLOBAL_KEYS: Record<SpotterControl, string> = {
  "damage-report": "spotterDamageReport",
  "weather-report": "spotterWeatherReport",
  "toggle-report-laps": "spotterToggleReportLaps",
  "announce-leader": "spotterAnnounceLeader",
  louder: "spotterLouder",
  quieter: "spotterQuieter",
  silence: "spotterSilence",
};
