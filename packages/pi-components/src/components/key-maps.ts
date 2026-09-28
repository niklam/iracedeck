/**
 * Key code mappings for keyboard input capture.
 *
 * The key map itself — `KEY_CODE_MAP`, the modifiers and their aliases, and
 * the prototype-safe lookups over them (`keyForCode`, …) — lives in deck-core's dependency-free
 * `key-binding-defaults` module and is imported through its subpath, never the
 * deck-core barrel, so this browser bundle stays free of Node code (#1277).
 * One copy is what keeps a default the plugin seeds byte-identical to the one
 * this field saves. What is here is display-only and browser-only.
 */
export { keyForCode, type Modifier, MODIFIERS } from "@iracedeck/deck-core/key-binding-defaults";

/** Maps internal key identifiers to human-readable display names */
export const KEY_DISPLAY_NAMES: Record<string, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "Page Up",
  pagedown: "Page Down",
  space: "Space",
  enter: "Enter",
  escape: "Esc",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  tab: "Tab",
  home: "Home",
  end: "End",
  numpad0: "Num 0",
  numpad1: "Num 1",
  numpad2: "Num 2",
  numpad3: "Num 3",
  numpad4: "Num 4",
  numpad5: "Num 5",
  numpad6: "Num 6",
  numpad7: "Num 7",
  numpad8: "Num 8",
  numpad9: "Num 9",
  numpad_add: "Num +",
  numpad_subtract: "Num -",
  numpad_multiply: "Num *",
  numpad_divide: "Num /",
  numpad_decimal: "Num .",
  numpad_enter: "Num Enter",
};

/**
 * Navigation key names as reported in KeyboardEvent.key.
 * These match the corresponding KeyboardEvent.code values for navigation keys.
 */
const NAVIGATION_KEYS = new Set([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Insert",
  "Delete",
]);

/**
 * Resolve the correct event code for a key press.
 *
 * On Windows, holding Ctrl overrides NumLock for numpad keys, making them
 * act as navigation keys (e.g., Ctrl+Numpad9 behaves as Ctrl+PageUp).
 * The browser reports e.code = "Numpad9" but e.key = "PageUp".
 * Some embedded webviews may also misreport dedicated navigation keys
 * as numpad codes.
 *
 * This function detects these mismatches and returns the navigation code
 * (e.g., "PageUp") instead of the numpad code (e.g., "Numpad9").
 * Navigation key names in e.key match their e.code counterparts exactly.
 *
 * @param code - The KeyboardEvent.code value
 * @param key - The KeyboardEvent.key value
 * @returns The corrected code value
 */
export function resolveEventCode(code: string, key: string): string {
  if (code.startsWith("Numpad") && NAVIGATION_KEYS.has(key)) {
    return key;
  }

  return code;
}
