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
 * Accepts any object with key/modifiers/displayKey — does not require the `type` discriminant.
 *
 * @param binding - The key binding to format
 * @returns Formatted string, or empty string if binding is invalid
 */
export function formatKeyBinding(
  binding: Pick<KeyBindingValue, "key" | "modifiers" | "displayKey"> | undefined,
): string {
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
 * Parse a raw object into a BindingValue using the `type` discriminant.
 * Both KeyBindingValue ("keyboard") and SimHubBindingValue ("simhub") have
 * a `type` field. KeyBindingValueSchema defaults `type` to "keyboard" for
 * backward compatibility with persisted values that lack the field.
 */
function parseBindingObject(obj: unknown): BindingValue | undefined {
  if (!obj || typeof obj !== "object") return undefined;

  const record = obj as Record<string, unknown>;

  if (record.type === "simhub") {
    const result = SimHubBindingValueSchema.safeParse(obj);

    return result.success ? result.data : undefined;
  }

  // Keyboard binding (type: "keyboard" or missing — the schema defaults it)
  const result = KeyBindingValueSchema.safeParse(obj);

  return result.success ? result.data : undefined;
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
