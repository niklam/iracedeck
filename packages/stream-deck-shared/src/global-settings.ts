/**
 * Global Settings Manager
 *
 * Manages plugin-level global settings that apply across all action instances.
 * Uses the Stream Deck SDK's global settings API for persistence.
 *
 * Usage:
 * 1. Call initGlobalSettings() once at plugin startup
 * 2. Use getGlobalSettings() to access current settings
 * 3. Settings are automatically updated when changed in Property Inspector
 *
 * @example
 * // In plugin.ts
 * import { initGlobalSettings } from "@iracedeck/stream-deck-shared";
 * await initGlobalSettings();
 *
 * // In actions
 * import { getGlobalSettings } from "@iracedeck/stream-deck-shared";
 * const settings = getGlobalSettings();
 * if (settings.disableWhenDisconnected) { ... }
 */
import streamDeck from "@elgato/streamdeck";
import { z } from "zod";

/**
 * Schema for global plugin settings.
 * All settings should have sensible defaults.
 */
export const GlobalSettingsSchema = z.object({
  /**
   * When true, buttons show inactive/disabled state when iRacing is not connected.
   * Default: true
   */
  disableWhenDisconnected: z.boolean().default(true),
});

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

/**
 * Current settings cache - updated when settings change
 */
let currentSettings: GlobalSettings = GlobalSettingsSchema.parse({});

/**
 * Listeners that get called when global settings change
 */
type GlobalSettingsListener = (settings: GlobalSettings) => void;
const listeners: Set<GlobalSettingsListener> = new Set();

/**
 * Whether initGlobalSettings has been called
 */
let initialized = false;

/**
 * Initialize global settings manager.
 * Fetches current settings and subscribes to changes.
 * Should be called once at plugin startup, after streamDeck.connect().
 *
 * @returns Promise resolving to current global settings
 */
export async function initGlobalSettings(): Promise<GlobalSettings> {
  if (initialized) {
    return currentSettings;
  }

  // Fetch current settings from Stream Deck
  const raw = await streamDeck.settings.getGlobalSettings();
  currentSettings = GlobalSettingsSchema.parse(raw);

  // Listen for changes from Property Inspector
  streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
    const newSettings = GlobalSettingsSchema.parse(ev.settings);
    currentSettings = newSettings;

    // Notify all listeners
    for (const listener of listeners) {
      listener(newSettings);
    }
  });

  initialized = true;

  return currentSettings;
}

/**
 * Get current global settings.
 * Returns default values if settings haven't been initialized yet.
 *
 * @returns Current global settings
 */
export function getGlobalSettings(): GlobalSettings {
  return currentSettings;
}

/**
 * Subscribe to global settings changes.
 *
 * @param listener - Function called when settings change
 * @returns Unsubscribe function
 */
export function onGlobalSettingsChange(listener: GlobalSettingsListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Check if global settings have been initialized.
 *
 * @returns true if initialized, false otherwise
 */
export function isGlobalSettingsInitialized(): boolean {
  return initialized;
}

/**
 * Reset global settings state (for testing purposes only).
 * @internal
 */
export function _resetGlobalSettings(): void {
  currentSettings = GlobalSettingsSchema.parse({});
  listeners.clear();
  initialized = false;
}
