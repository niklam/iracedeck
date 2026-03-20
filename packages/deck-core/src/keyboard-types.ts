export type KeyboardModifier = "ctrl" | "shift" | "alt";

export type KeyboardKey =
  // Letters a-z
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z"
  // Numbers 0-9
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  // Function keys
  | "f1"
  | "f2"
  | "f3"
  | "f4"
  | "f5"
  | "f6"
  | "f7"
  | "f8"
  | "f9"
  | "f10"
  | "f11"
  | "f12"
  // Special keys
  | "tab"
  | "space"
  | "enter"
  | "escape"
  | "backspace"
  | "delete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "="
  | "-"
  | "["
  | "]"
  | "/"
  | "\\"
  | ";"
  | "'"
  | ","
  | "."
  | "`";

export interface KeyCombination {
  key: KeyboardKey;
  modifiers?: KeyboardModifier[];
  /** KeyboardEvent.code (e.g., "Quote") - identifies the physical key position */
  code?: string;
}

export interface IRacingHotkeyPreset {
  id: string;
  name: string;
  description: string;
  defaultKey: KeyCombination;
  category: "blackbox" | "controls" | "camera" | "misc";
}

/** All valid keyboard keys as array (for Property Inspector dropdowns) */
export const KEYBOARD_KEYS: KeyboardKey[] = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
  "tab",
  "space",
  "enter",
  "escape",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "=",
  "-",
  "[",
  "]",
  "/",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "`",
];
