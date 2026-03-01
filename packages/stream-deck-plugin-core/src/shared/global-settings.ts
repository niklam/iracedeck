/**
 * Global Settings Manager
 *
 * Manages plugin-level global settings that apply across all action instances.
 * Uses the Stream Deck SDK's global settings API for persistence.
 *
 * Usage:
 * 1. Call initGlobalSettings(streamDeck, logger) once at plugin startup
 * 2. Use getGlobalSettings() to access current settings
 * 3. Settings are automatically updated when changed in Property Inspector
 *
 * @example
 * // In plugin.ts
 * import streamDeck from "@elgato/streamdeck";
 * import { createSDLogger, initGlobalSettings } from "./shared/index.js";
 * initGlobalSettings(streamDeck, createSDLogger(streamDeck.logger.createScope("GlobalSettings")));
 *
 * // In actions
 * import { getGlobalSettings } from "./shared/index.js";
 * const settings = getGlobalSettings();
 * if (settings.disableWhenDisconnected) { ... }
 */
import type StreamDeck from "@elgato/streamdeck";
import type { ILogger } from "@iracedeck/logger";
import { z } from "zod";

/**
 * Schema for key binding values stored in global settings.
 * Matches the format used by the ird-key-binding component.
 * Exported for use by plugins defining their own key binding schemas.
 */
export const KeyBindingValueSchema = z.object({
  key: z.string(),
  modifiers: z.array(z.string()).default([]),
  /** KeyboardEvent.code (e.g., "Quote") - identifies the physical key position */
  code: z.string().optional(),
  /** KeyboardEvent.key (e.g., "ä") - locale-correct character for display */
  displayKey: z.string().optional(),
});

export type KeyBindingValue = z.infer<typeof KeyBindingValueSchema>;

/**
 * Schema for global plugin settings.
 * Uses passthrough to allow dynamic key binding properties (e.g., blackBoxLapTiming, blackBoxFuel).
 */
export const GlobalSettingsSchema = z
  .object({
    /**
     * When true, buttons show inactive/disabled state when iRacing is not connected.
     * Default: true
     */
    disableWhenDisconnected: z.boolean().default(true),
  })
  .passthrough();

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
 * Logger instance for this module
 */
let logger: ILogger | null = null;

/**
 * Initialize global settings manager.
 * Sets up the listener for global settings changes.
 * The SDK will send current settings via the onDidReceiveGlobalSettings event.
 * Should be called once at plugin startup, before streamDeck.connect().
 *
 * @param sd - The Stream Deck SDK instance from the plugin
 * @param log - Logger instance for this module
 * @returns Current global settings (may be defaults until SDK sends actual values)
 */
export function initGlobalSettings(sd: typeof StreamDeck, log: ILogger): GlobalSettings {
  logger = log;
  logger.info("Initializing");

  if (initialized) {
    logger.debug("Already initialized, returning cached");

    return currentSettings;
  }

  // Listen for changes from Property Inspector
  sd.settings.onDidReceiveGlobalSettings((ev: { settings: unknown }) => {
    logger?.info("Settings received");
    logger?.debug(`Settings data: ${JSON.stringify(ev.settings)}`);
    const newSettings = GlobalSettingsSchema.parse(ev.settings);
    currentSettings = newSettings;

    // Notify all listeners
    for (const listener of listeners) {
      listener(newSettings);
    }
  });

  initialized = true;

  // Request current global settings - this triggers the onDidReceiveGlobalSettings callback
  sd.settings.getGlobalSettings();
  logger.info("Initialized");

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
