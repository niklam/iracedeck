/**
 * Global Settings Manager
 *
 * Manages plugin-level global settings that apply across all action instances.
 * Platform-agnostic: uses IDeckPlatformAdapter instead of a specific SDK.
 *
 * Usage:
 * 1. Call initGlobalSettings(adapter, logger) once at plugin startup
 * 2. Use getGlobalSettings() to access current settings
 * 3. Settings are automatically updated when changed in Property Inspector
 */
import type { ILogger } from "@iracedeck/logger";
import { z } from "zod";

import type { IDeckPlatformAdapter } from "./types.js";

/**
 * Schema for key binding values stored in global settings.
 * Matches the format used by the ird-key-binding component.
 * Exported for use by plugins defining their own key binding schemas.
 */
export const KeyBindingValueSchema = z.object({
  // default("keyboard") provides backward compat with persisted values that lack the field
  type: z.literal("keyboard").default("keyboard"),
  key: z.string().min(1),
  modifiers: z.array(z.string()).default([]),
  /** KeyboardEvent.code (e.g., "Quote") - identifies the physical key position */
  code: z.string().optional(),
  /** KeyboardEvent.key (e.g., "ä") - locale-correct character for display */
  displayKey: z.string().optional(),
});

export type KeyBindingValue = z.infer<typeof KeyBindingValueSchema>;

/**
 * Schema for SimHub Control Mapper role bindings.
 * Stored by the ird-key-binding component when in SimHub mode.
 */
export const SimHubBindingValueSchema = z.object({
  type: z.literal("simhub"),
  role: z.string().min(1),
});

export type SimHubBindingValue = z.infer<typeof SimHubBindingValueSchema>;

/**
 * Union type for all binding values (keyboard shortcut or SimHub role).
 */
export type BindingValue = KeyBindingValue | SimHubBindingValue;

/**
 * Type guard to check if a binding value is a SimHub role binding.
 */
export function isSimHubBinding(value: BindingValue | null | undefined): value is SimHubBindingValue {
  return value != null && value.type === "simhub";
}

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
    /**
     * When true, focus the iRacing window before sending keyboard inputs.
     * Ensures key presses reach iRacing even when another window is in the foreground.
     * Default: false (opt-in)
     */
    focusIRacingWindow: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    /**
     * Hostname or IP address of the SimHub instance for Control Mapper integration.
     * Default: "127.0.0.1"
     */
    simHubHost: z.preprocess((val) => (val === "" ? undefined : val), z.string().default("127.0.0.1")),
    /**
     * HTTP port for SimHub's REST API (Control Mapper).
     * Default: 8888
     */
    simHubPort: z.preprocess(
      (val) => (val === "" ? undefined : val),
      z.coerce.number().min(1).max(65535).default(8888),
    ),
    /**
     * When true, changing fuel amount (add/reduce/set) automatically enables the fuel fill checkbox.
     * When false, the fuel fill state is preserved (uses #-fuel macro prefix).
     * Default: true (matches iRacing default behavior)
     */
    enableFuelingOnChange: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
    /**
     * On/off for the Race Engineer voice (Pit Crew action, Race Engineer
     * mode). Toggled by pressing the Race Engineer button — when off, the
     * Voice and Background audio buses are zeroed so any in-flight clip
     * silences immediately. Persists across plugin restarts. Default: false
     * — fresh installs stay quiet until the user opts in (issue #378).
     */
    raceEngineerEnabled: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    /**
     * On/off for the directional Radar proximity ticks (Pit Crew action,
     * Radar mode). Toggled by pressing the Radar button — independent from
     * Race Engineer so silencing the voice to talk to teammates on Discord
     * doesn't kill the proximity alerts. Persists across plugin restarts.
     * Default: false — fresh installs stay quiet until the user opts in
     * (issue #378).
     */
    radarEnabled: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(false),
    /**
     * Volume for the directional Radar ticks, 0–100 (mapped to 0.0–1.0 on
     * `AudioBus.Alerts`). Stepped by the Radar Volume Up/Down modes of the
     * Pit Crew action; sliding to 0 mutes the radar without toggling the
     * feature off. Default: 100.
     */
    radarVolume: z.coerce.number().min(0).max(100).default(100),
    /**
     * Active voice used by Race Engineer scenarios — the key under
     * `voice/<voice>/` in `@iracedeck/audio-assets` (e.g., `"luca"`,
     * `"titan"`). Substituted into scenario `base: "voice/{voice}"` at
     * clip-resolution time. Empty string or unset means "no voice
     * selected" — the plugin seeds the first available voice from the
     * audio-assets manifest on startup. Persists across plugin restarts.
     */
    raceEngineerVoice: z.preprocess((val) => (val === undefined || val === null ? "" : val), z.string().default("")),
    /**
     * Volume for the Race Engineer voice, 0–100 (mapped to 0.0–1.0 on
     * `AudioBus.Voice`). Sliding to 0 silences voice scenarios without
     * disabling the feature. Default: 100.
     */
    raceEngineerVolume: z.coerce.number().min(0).max(100).default(100),
    /**
     * Driver name the Race Engineer addresses the user as — the key
     * under `voice/<voice>/names/` (e.g., `"niklas"`, `"oivindl"`).
     * Substituted into welcome / pit-callout flows by referencing
     * `voice/{voice}/names/{driverName}.mp3`. Empty string means "no
     * name picked" — the plugin seeds the first available name on
     * startup.
     */
    driverName: z.preprocess((val) => (val === undefined || val === null ? "" : val), z.string().default("")),
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
 * Stored adapter reference for writing settings back
 */
let adapterRef: IDeckPlatformAdapter | null = null;

/**
 * Initialize global settings manager.
 * Sets up the listener for global settings changes.
 * The platform adapter will send current settings via the onDidReceiveGlobalSettings callback.
 * Should be called once at plugin startup, before adapter.connect().
 *
 * @param adapter - The platform adapter instance
 * @param log - Logger instance for this module
 * @returns Current global settings (may be defaults until adapter sends actual values)
 */
export function initGlobalSettings(adapter: IDeckPlatformAdapter, log: ILogger): GlobalSettings {
  logger = log;
  adapterRef = adapter;
  logger.info("Initializing");

  if (initialized) {
    logger.debug("Already initialized, returning cached");

    return currentSettings;
  }

  // Listen for changes from Property Inspector
  adapter.onDidReceiveGlobalSettings((settings: unknown) => {
    logger?.info("Settings received");
    logger?.debug(`Raw settings: ${JSON.stringify(settings)}`);
    const newSettings = GlobalSettingsSchema.parse(settings);
    logger?.debug(`Parsed focusIRacingWindow: ${newSettings.focusIRacingWindow}`);
    applyParsedSettings(newSettings);
  });

  initialized = true;

  // Request current global settings - this triggers the onDidReceiveGlobalSettings callback
  adapter.getGlobalSettings();
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
 * Update global settings by merging partial values into current settings.
 * Writes the merged result back to the platform adapter **and** updates the
 * in-memory cache synchronously so subsequent reads in the same task see the
 * new value. The host's `onDidReceiveGlobalSettings` echo is not guaranteed to
 * fire promptly — in observed Stream Deck sessions the echo has arrived
 * minutes after the write — and without the synchronous cache update every
 * read-modify-write toggle (Pit Crew Radar, Race Engineer) gets stuck because
 * subsequent presses re-read the stale value and compute the same "next"
 * again. See #419.
 *
 * @param partial - Partial settings to merge into current settings
 */
export function updateGlobalSettings(partial: Record<string, unknown>): void {
  if (!adapterRef) {
    logger?.warn("Cannot update global settings: adapter not initialized");

    return;
  }

  const merged = { ...currentSettings, ...partial };
  logger?.info("Updating global settings");
  logger?.debug(`Partial update: ${JSON.stringify(partial)}`);

  // Parse + apply synchronously so the cache and listeners reflect the
  // new value immediately. The later `onDidReceiveGlobalSettings` echo
  // re-parses the same payload and reconciles as a no-op.
  applyParsedSettings(GlobalSettingsSchema.parse(merged));

  // Send the LIVE cache, not the snapshot captured above. A listener
  // fired by `applyParsedSettings` may itself call `updateGlobalSettings`,
  // layering more partials on top — sending the snapshot would clobber
  // those nested updates back to the snapshot's stale view (#441 bug:
  // `_raceEngineerVoices` push from inside the audio-device push listener
  // was being overwritten by the outer audio-device-only payload).
  adapterRef.setGlobalSettings(currentSettings);
}

/**
 * Apply a parsed settings object: update the cache and notify listeners.
 * Shared between the host-echo path (`onDidReceiveGlobalSettings`) and the
 * local-write path (`updateGlobalSettings`) so both stay in sync.
 */
function applyParsedSettings(parsed: GlobalSettings): GlobalSettings {
  currentSettings = parsed;

  for (const listener of listeners) {
    listener(parsed);
  }

  return parsed;
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
 * Get current global color preferences.
 * Reads flat color keys (colorBackgroundColor, colorTextColor, etc.)
 * from global settings and returns them as a ColorSlots object.
 *
 * @returns Color preferences, with undefined for unset slots
 */
export function getGlobalColors(): {
  backgroundColor?: string;
  textColor?: string;
  graphic1Color?: string;
  graphic2Color?: string;
} {
  const settings = currentSettings as Record<string, unknown>;

  const color = (key: string): string | undefined => {
    const val = settings[key];

    // Ignore empty strings (current "not set" value from <ird-color-picker>)
    // and #000001 (legacy sentinel from <sdpi-color> era — kept for backward compat)
    if (typeof val !== "string" || val.length === 0 || val === "#000001") {
      return undefined;
    }

    return val;
  };

  return {
    backgroundColor: color("colorBackgroundColor"),
    textColor: color("colorTextColor"),
    graphic1Color: color("colorGraphic1Color"),
    graphic2Color: color("colorGraphic2Color"),
  };
}

/**
 * Resolve the active Race Engineer voice key, falling back to the first
 * entry in `availableVoices` if the persisted value is empty or missing
 * from the available list (e.g. user picked "titan" earlier, the package
 * was rebuilt without that voice).
 *
 * Returns `null` only if no voices are available at all — callers should
 * suppress voice scenarios in that case.
 */
export function resolveActiveRaceEngineerVoice(availableVoices: readonly string[]): string | null {
  if (availableVoices.length === 0) return null;

  const chosen = currentSettings.raceEngineerVoice ?? "";

  if (chosen.length > 0 && availableVoices.includes(chosen)) {
    return chosen;
  }

  return availableVoices[0];
}

/**
 * Resolve the active driver-name key (the name the engineer addresses
 * the user as). Returns the persisted value when present in the list,
 * otherwise `defaultName` if supplied and present in the list, otherwise
 * the first list entry, or `null` when no names exist (caller should
 * skip name-dependent playback). `defaultName` mirrors the `default`
 * attribute on `<ird-name-select>` so the UI dropdown and runtime
 * playback agree on the fallback even before the user opens the PI.
 */
export function resolveActiveDriverName(availableNames: readonly string[], defaultName?: string): string | null {
  if (availableNames.length === 0) return null;

  const chosen = currentSettings.driverName ?? "";

  if (chosen.length > 0 && availableNames.includes(chosen)) {
    return chosen;
  }

  if (defaultName !== undefined && defaultName.length > 0 && availableNames.includes(defaultName)) {
    return defaultName;
  }

  return availableNames[0];
}

/**
 * Reset global settings state (for testing purposes only).
 * @internal
 */
export function _resetGlobalSettings(): void {
  currentSettings = GlobalSettingsSchema.parse({});
  listeners.clear();
  initialized = false;
  adapterRef = null;
}
