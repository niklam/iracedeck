/**
 * Default key bindings as the Property Inspector stores them (issue #1277).
 *
 * A key binding's default is written as a short string (`"V"`, `"Shift+V"`,
 * `"Ctrl+F1"`) — in `key-bindings.json` and on an `ird-key-binding`'s
 * `default` attribute. When a binding field mounts over a setting that holds
 * nothing it parses that string with its `parseSimpleDefault` and saves
 * `JSON.stringify` of the result, so a default binding is stored as e.g.
 * `{"type":"keyboard","key":"v","modifiers":["shift"],"code":"KeyV"}`.
 *
 * {@link defaultBindingStoredValue} is the Node-side twin of that save, for
 * the plugin writing a default itself (`seedBindingDefaultsIfAbsent` in
 * `global-settings-migrations.ts`). The `code` matters: it is what the
 * keyboard service turns into a layout-independent scan code, so a value
 * without it would type a different key on a non-US layout than one the field
 * saved.
 *
 * SYNC NOTE: {@link BINDING_KEY_CODE_MAP} and {@link parseDefaultKeyBinding}
 * duplicate `KEY_CODE_MAP` (pi-components `key-maps.ts`) and
 * `parseSimpleDefault` (pi-components `key-binding-utils.ts`). The PI runs in
 * a browser bundle that must not pull deck-core in, and deck-core cannot
 * depend on pi-components, so the pair is pinned by
 * `pi-components/src/components/key-binding-default-parity.test.ts` — the map
 * must be equal, and both parsers must give the same value for every key and
 * modifier form. Change both sides together.
 */
import type { KeyBindingValue } from "./global-settings.js";

/**
 * KeyboardEvent.code → internal key identifier; a copy of pi-components'
 * `KEY_CODE_MAP` (see the SYNC NOTE above).
 *
 * @internal Exported for the parity test
 */
export const BINDING_KEY_CODE_MAP: Readonly<Record<string, string>> = {
  // Letters
  KeyA: "a",
  KeyB: "b",
  KeyC: "c",
  KeyD: "d",
  KeyE: "e",
  KeyF: "f",
  KeyG: "g",
  KeyH: "h",
  KeyI: "i",
  KeyJ: "j",
  KeyK: "k",
  KeyL: "l",
  KeyM: "m",
  KeyN: "n",
  KeyO: "o",
  KeyP: "p",
  KeyQ: "q",
  KeyR: "r",
  KeyS: "s",
  KeyT: "t",
  KeyU: "u",
  KeyV: "v",
  KeyW: "w",
  KeyX: "x",
  KeyY: "y",
  KeyZ: "z",
  // Numbers
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  // Numpad
  Numpad0: "numpad0",
  Numpad1: "numpad1",
  Numpad2: "numpad2",
  Numpad3: "numpad3",
  Numpad4: "numpad4",
  Numpad5: "numpad5",
  Numpad6: "numpad6",
  Numpad7: "numpad7",
  Numpad8: "numpad8",
  Numpad9: "numpad9",
  NumpadAdd: "numpad_add",
  NumpadSubtract: "numpad_subtract",
  NumpadMultiply: "numpad_multiply",
  NumpadDivide: "numpad_divide",
  NumpadDecimal: "numpad_decimal",
  NumpadEnter: "numpad_enter",
  // Function keys
  F1: "f1",
  F2: "f2",
  F3: "f3",
  F4: "f4",
  F5: "f5",
  F6: "f6",
  F7: "f7",
  F8: "f8",
  F9: "f9",
  F10: "f10",
  F11: "f11",
  F12: "f12",
  // Navigation
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  // Special keys
  Tab: "tab",
  Space: "space",
  Enter: "enter",
  Escape: "escape",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  // Symbols
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** Internal key identifier → KeyboardEvent.code. */
const KEY_TO_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(BINDING_KEY_CODE_MAP).map(([code, key]) => [key, code]),
);

const MODIFIERS = ["ctrl", "shift", "alt"] as const;

/** Aliases accepted for a modifier name in a default string. */
const MODIFIER_ALIASES: Readonly<Record<string, string>> = { control: "ctrl" };

/**
 * Parse a default string such as `"F1"` or `"Ctrl+Shift+A"` into the binding
 * the PI field would save — `parseSimpleDefault`'s rules exactly: parts split
 * on `+`, trimmed and lowercased; a modifier (or alias) is collected in the
 * order written; any other part is the key, the last one winning. The key must
 * be one the field can record.
 *
 * @returns The binding, or `undefined` for an empty or unrecognised key (where
 *   the field saves nothing)
 */
export function parseDefaultKeyBinding(text: string): KeyBindingValue | undefined {
  const parts = text.split("+").map((part) => part.trim().toLowerCase());
  const modifiers: string[] = [];
  let key = "";

  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part] ?? part;

    if ((MODIFIERS as readonly string[]).includes(modifier)) {
      modifiers.push(modifier);
    } else {
      key = part;
    }
  }

  const code = KEY_TO_CODE[key];

  if (code === undefined) return undefined;

  // Property order as the field builds it, so the stored JSON is byte-identical.
  return { type: "keyboard", key, modifiers, code };
}

/**
 * The exact global-settings value an `ird-key-binding` stores for a default
 * string: the JSON of {@link parseDefaultKeyBinding}.
 *
 * @returns The value to store, or `undefined` when the default names no key
 */
export function defaultBindingStoredValue(text: string): string | undefined {
  const binding = parseDefaultKeyBinding(text);

  return binding === undefined ? undefined : JSON.stringify(binding);
}
