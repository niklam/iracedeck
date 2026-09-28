/**
 * The key map and the default-binding parser the Property Inspector and the
 * plugin share (issue #1277) — ONE copy, dependency-free on purpose.
 *
 * A key binding's default is written as a short string (`"V"`, `"Shift+V"`,
 * `"Ctrl+F1"`) — in `key-bindings.json` and on an `ird-key-binding`'s
 * `default` attribute. When that field mounts over a setting that holds
 * nothing it parses the string with {@link parseDefaultKeyBinding} and saves
 * `JSON.stringify` of the result, so a default binding is stored as e.g.
 * `{"type":"keyboard","key":"v","modifiers":["shift"],"code":"KeyV"}`. When
 * the plugin writes a default itself (`seedBindingDefaultsIfAbsent` in
 * `global-settings-migrations.ts`) it stores {@link defaultBindingStoredValue}
 * — the same parser, so the two cannot disagree. The `code` matters: it is
 * what the keyboard service turns into a layout-independent scan code, so a
 * value without it would type a different key on a non-US layout than one the
 * field saved.
 *
 * WHY A SUBPATH. pi-components compiles the `ird-*` components into a browser
 * bundle, which must never pull in the deck-core barrel (it reaches Node
 * built-ins and the native addons). So this module is also published on its
 * own as `@iracedeck/deck-core/key-binding-defaults` (deck-core `package.json`
 * `exports`, pointing at the built `dist/key-binding-defaults.js`), and
 * pi-components imports only that. Keep it free of imports — types included —
 * so the subpath stays a leaf: an import added here is an import added to
 * every Property Inspector.
 */

/**
 * `KeyboardEvent.code` → internal key identifier: every key a binding field
 * can record. Frozen: it is shared, so no consumer may edit it.
 */
export const KEY_CODE_MAP: Readonly<Record<string, string>> = Object.freeze({
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
});

// Every lookup goes through a Map, never an index into a plain object: a
// default string or an event code is outside input, and `obj[name]` answers
// for names inherited from `Object.prototype` (`constructor`, `__proto__`,
// `toString`, …) — a function where a key was expected.

/** `KeyboardEvent.code` → internal key identifier. */
const CODE_TO_KEY: ReadonlyMap<string, string> = new Map(Object.entries(KEY_CODE_MAP));

/** Internal key identifier → `KeyboardEvent.code`. */
const KEY_TO_CODE: ReadonlyMap<string, string> = new Map(
  Object.entries(KEY_CODE_MAP).map(([code, key]) => [key, code]),
);

/** Supported modifier keys, in the order a binding displays them. */
export const MODIFIERS = ["ctrl", "shift", "alt"] as const;

/** A modifier key. */
export type Modifier = (typeof MODIFIERS)[number];

/** Aliases accepted for a modifier name in a default string. */
export const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = Object.freeze({ control: "ctrl" });

const MODIFIER_ALIAS_LOOKUP: ReadonlyMap<string, Modifier> = new Map(Object.entries(MODIFIER_ALIASES));

const MODIFIER_SET: ReadonlySet<string> = new Set(MODIFIERS);

/** A keyboard binding as the field builds it from a default string. */
export interface DefaultKeyBinding {
  type: "keyboard";
  key: string;
  modifiers: Modifier[];
  /** `KeyboardEvent.code` of the key: the physical position. */
  code: string;
}

/** Whether `key` is an internal key identifier a binding field can record. */
export function isValidKey(key: string): boolean {
  return KEY_TO_CODE.has(key);
}

/** The `KeyboardEvent.code` for an internal key identifier, or `undefined` if it is not one. */
export function keyToCode(key: string): string | undefined {
  return KEY_TO_CODE.get(key);
}

/** The internal key identifier for a `KeyboardEvent.code`, or `undefined` if the key is not recordable. */
export function keyForCode(code: string): string | undefined {
  return CODE_TO_KEY.get(code);
}

/**
 * Parse a default string such as `"F1"` or `"Ctrl+Shift+A"` into the binding
 * the field saves for it: parts split on `+`, trimmed and lowercased; a
 * modifier (or an alias of one) is collected in the order written; any other
 * part is the key, the last one winning. The key must be one the field can
 * record.
 *
 * @returns The binding, or `undefined` when the string names no recordable
 *   key (empty, modifiers only, or an unknown key)
 */
export function parseDefaultKeyBinding(text: string): DefaultKeyBinding | undefined {
  const parts = text.split("+").map((part) => part.trim().toLowerCase());
  const modifiers: Modifier[] = [];
  let key = "";

  for (const part of parts) {
    const modifier = MODIFIER_ALIAS_LOOKUP.get(part) ?? part;

    if (MODIFIER_SET.has(modifier)) {
      modifiers.push(modifier as Modifier);
    } else {
      key = part;
    }
  }

  const code = keyToCode(key);

  if (code === undefined) return undefined;

  // Property order is part of the contract: the stored JSON is compared byte for byte.
  return { type: "keyboard", key, modifiers, code };
}

/**
 * The exact global-settings value an `ird-key-binding` stores for a default
 * string: the JSON of {@link parseDefaultKeyBinding}.
 *
 * @returns The value to store, or `undefined` when the default names no
 *   recordable key. (The field, handed such a default, saves `""`;
 *   `seedBindingDefaultsIfAbsent` deliberately stores nothing instead, because
 *   a stored `""` reads as a binding the user cleared and would never be
 *   seeded again.)
 */
export function defaultBindingStoredValue(text: string): string | undefined {
  const binding = parseDefaultKeyBinding(text);

  return binding === undefined ? undefined : JSON.stringify(binding);
}
