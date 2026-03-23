/**
 * Key Binding Utilities
 *
 * Shared utility functions for parsing and formatting key bindings
 * from global settings. Supports both keyboard shortcuts and SimHub
 * Control Mapper role bindings.
 */
import {
  type BindingValue,
  type KeyBindingValue,
  KeyBindingValueSchema,
  type SimHubBindingValue,
  SimHubBindingValueSchema,
} from "./global-settings.js";

// Re-export types for convenience
export type { BindingValue, SimHubBindingValue };
export { isSimHubBinding } from "./global-settings.js";

/**
 * Format a key binding for display in logs.
 * Returns a human-readable string like "Ctrl+Shift+F1" or "F3".
 *
 * @param binding - The key binding to format
 * @returns Formatted string, or empty string if binding is invalid
 */
export function formatKeyBinding(binding: KeyBindingValue | undefined): string {
  if (!binding?.key) return "";

  const modifiers = (binding.modifiers || [])
    .filter((m) => ["ctrl", "shift", "alt"].includes(m))
    .map((m) => m.charAt(0).toUpperCase() + m.slice(1));

  // Prefer locale-correct displayKey over US-layout key
  const keyDisplay = binding.displayKey
    ? binding.displayKey.length === 1
      ? binding.displayKey.toUpperCase()
      : binding.displayKey
    : binding.key.toUpperCase();

  return [...modifiers, keyDisplay].join("+");
}

/**
 * Parse a binding value from global settings.
 * Handles both keyboard shortcuts and SimHub role bindings.
 * Accepts JSON strings (from Property Inspector) and already-parsed objects.
 *
 * @param rawValue - The raw value from global settings
 * @returns Parsed BindingValue (keyboard or SimHub), or undefined if parsing fails
 */
export function parseBinding(rawValue: unknown): BindingValue | undefined {
  if (typeof rawValue === "string" && rawValue) {
    try {
      const obj = JSON.parse(rawValue);

      return parseBindingObject(obj);
    } catch {
      return undefined;
    }
  }

  if (rawValue && typeof rawValue === "object") {
    return parseBindingObject(rawValue);
  }

  return undefined;
}

/**
 * Parse a raw object into a BindingValue.
 */
function parseBindingObject(obj: unknown): BindingValue | undefined {
  // Try SimHub binding first (has "type": "simhub")
  const simhub = SimHubBindingValueSchema.safeParse(obj);

  if (simhub.success) {
    return simhub.data;
  }

  // Try keyboard binding
  const keyboard = KeyBindingValueSchema.safeParse(obj);

  if (keyboard.success) {
    return keyboard.data;
  }

  return undefined;
}

/**
 * Parse a key binding from global settings (keyboard shortcuts only).
 * For backward compatibility — use parseBinding() for new code that
 * needs to handle both keyboard and SimHub bindings.
 *
 * @param rawValue - The raw value from global settings
 * @returns Parsed KeyBindingValue, or undefined if parsing fails
 */
export function parseKeyBinding(rawValue: unknown): KeyBindingValue | undefined {
  if (typeof rawValue === "string" && rawValue) {
    try {
      const parsed = KeyBindingValueSchema.safeParse(JSON.parse(rawValue));

      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  if (rawValue && typeof rawValue === "object") {
    const parsed = KeyBindingValueSchema.safeParse(rawValue);

    return parsed.success ? parsed.data : undefined;
  }

  return undefined;
}
