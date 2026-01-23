/**
 * Key Binding Utilities
 *
 * Shared utility functions for parsing and formatting key bindings
 * from global settings.
 */
import { type KeyBindingValue, KeyBindingValueSchema } from "./global-settings.js";

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

  return [...modifiers, binding.key.toUpperCase()].join("+");
}

/**
 * Parse a key binding from global settings.
 * Handles both JSON strings (from Property Inspector) and already-parsed objects.
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
