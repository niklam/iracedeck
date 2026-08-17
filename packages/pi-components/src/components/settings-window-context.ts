/// <reference lib="dom" />
/**
 * "Am I inside the dedicated settings window?" (issue #992).
 *
 * The settings-window bridge (`src/settings-window-bridge/index.ts`, a separate
 * browser bundle) sets `window.__irdSettingsWindow = true` before
 * sdpi-components loads. Shared PI code that must behave differently there —
 * the SimHub probe (cross-origin from that page, so it asks the plugin's proxy)
 * and the audio Test buttons (no action context, so they ask the plugin
 * directly) — reads it through this ONE helper. The bridge cannot import this
 * module (its tsconfig `rootDir` is its own folder), so it carries its own copy
 * of the flag name; `build/settings-window-constants.test.ts` pins the two equal.
 */

/** Window property the settings-window bridge sets to `true`. */
export const SETTINGS_WINDOW_FLAG = "__irdSettingsWindow";

/** True inside the dedicated settings window (flag set by its bridge). */
export function inSettingsWindow(): boolean {
  return typeof window !== "undefined" && (window as unknown as Record<string, unknown>)[SETTINGS_WINDOW_FLAG] === true;
}
