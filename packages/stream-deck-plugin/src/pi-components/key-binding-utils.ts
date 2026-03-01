/**
 * Key Binding Utilities
 *
 * Pure utility functions for formatting and parsing key bindings.
 * These are extracted from the web component to allow for unit testing
 * in a Node.js environment (without DOM dependencies).
 */
import { isValidKey, KEY_DISPLAY_NAMES, keyToCode, type Modifier, MODIFIER_ALIASES, MODIFIERS } from "./key-maps.js";

/** UI text constants */
export const UI_TEXT = {
  NOT_SET: "Not set",
  PLACEHOLDER: "Click to set...",
  RECORDING: "Press keys...",
} as const;

/** SDPI theme colors and styles */
export const SDPI_THEME = {
  background: "#3d3d3d",
  text: "#d8d8d8",
  fontFamily: '"Segoe UI", Arial, sans-serif',
  fontSize: "9pt",
  height: "30px",
  padding: "7px 4px",
  recordingBackground: "rgba(0, 132, 255, 0.2)",
  recordingBorder: "#0084ff",
} as const;

export interface KeyBindingValue {
  key: string;
  modifiers: Modifier[];
  /** KeyboardEvent.code (e.g., "Quote") - identifies the physical key position */
  code?: string;
  /** KeyboardEvent.key (e.g., "ä") - locale-correct character for display */
  displayKey?: string;
}

/**
 * Format a key binding value for display.
 * Returns a human-readable string like "Ctrl + Shift + A".
 */
export function formatKeyBinding(value: KeyBindingValue | null): string {
  if (!value || !value.key) {
    return UI_TEXT.NOT_SET;
  }

  const parts: string[] = [];

  for (const modifier of MODIFIERS) {
    if (value.modifiers?.includes(modifier)) {
      parts.push(modifier.charAt(0).toUpperCase() + modifier.slice(1));
    }
  }

  // Format the key for display, preferring locale-correct displayKey
  const keyDisplay = value.displayKey
    ? value.displayKey.length === 1
      ? value.displayKey.toUpperCase()
      : value.displayKey
    : KEY_DISPLAY_NAMES[value.key] || value.key.toUpperCase();
  parts.push(keyDisplay);

  return parts.join(" + ");
}

/**
 * Parse a JSON string into a KeyBindingValue.
 * Returns null if the JSON is invalid or doesn't match the expected structure.
 */
export function parseKeyBinding(json: string | null): KeyBindingValue | null {
  if (!json) return null;

  try {
    const parsed = JSON.parse(json) as KeyBindingValue;

    // Basic structure validation
    if (typeof parsed.key !== "string" || !Array.isArray(parsed.modifiers)) {
      console.warn("[ird-key-binding] Invalid key binding structure:", json);

      return null;
    }

    // Sanitize optional extended fields
    if (parsed.code !== undefined && typeof parsed.code !== "string") {
      parsed.code = undefined;
    }

    if (parsed.displayKey !== undefined && typeof parsed.displayKey !== "string") {
      parsed.displayKey = undefined;
    }

    return parsed;
  } catch (error) {
    console.warn("[ird-key-binding] Failed to parse key binding:", error);

    return null;
  }
}

/**
 * Parse a simple default string like "F1" or "Ctrl+Shift+A" into a KeyBindingValue.
 * Supports modifier aliases (e.g., "Control" → "ctrl").
 */
export function parseSimpleDefault(value: string): KeyBindingValue | null {
  const parts = value.split("+").map((p) => p.trim().toLowerCase());
  const modifiers: Modifier[] = [];
  let key = "";

  for (const part of parts) {
    // Check if it's a modifier or an alias for one
    const resolvedModifier = MODIFIER_ALIASES[part] ?? part;

    if (MODIFIERS.includes(resolvedModifier as Modifier)) {
      modifiers.push(resolvedModifier as Modifier);
    } else {
      key = part;
    }
  }

  // Validate that the key is recognized
  if (!isValidKey(key)) {
    console.warn(`[ird-key-binding] Invalid default key "${key}" in "${value}"`);

    return null;
  }

  const code = keyToCode(key);

  return code ? { key, modifiers, code } : { key, modifiers };
}
