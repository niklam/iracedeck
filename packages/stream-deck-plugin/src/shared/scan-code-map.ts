/**
 * KeyboardEvent.code to PS/2 Scan Code mapping.
 *
 * Maps physical key identifiers (event.code) to PS/2 Set 1 scan codes.
 * These scan codes are layout-independent — the same physical key always
 * produces the same scan code regardless of keyboard layout.
 *
 * Extended keys (arrows, navigation, numpad divide/enter) use bit 0x100
 * to signal the KEYEVENTF_EXTENDEDKEY flag for SendInput.
 *
 * Used by keyboard-service to send key presses via SendInput(KEYEVENTF_SCANCODE),
 * bypassing VK code resolution which is broken for non-US layouts in Chromium.
 */

/** Maps KeyboardEvent.code values to PS/2 Set 1 scan codes */
const CODE_TO_SCAN: Record<string, number> = {
  // Letters
  KeyA: 0x1e,
  KeyB: 0x30,
  KeyC: 0x2e,
  KeyD: 0x20,
  KeyE: 0x12,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyI: 0x17,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  KeyM: 0x32,
  KeyN: 0x31,
  KeyO: 0x18,
  KeyP: 0x19,
  KeyQ: 0x10,
  KeyR: 0x13,
  KeyS: 0x1f,
  KeyT: 0x14,
  KeyU: 0x16,
  KeyV: 0x2f,
  KeyW: 0x11,
  KeyX: 0x2d,
  KeyY: 0x15,
  KeyZ: 0x2c,
  // Digits
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0a,
  Digit0: 0x0b,
  // Function keys
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  F11: 0x57,
  F12: 0x58,
  // OEM/symbol keys (layout-dependent in VK codes, but scan codes are universal)
  Minus: 0x0c,
  Equal: 0x0d,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Backslash: 0x2b,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  // Special keys
  Tab: 0x0f,
  Space: 0x39,
  Enter: 0x1c,
  Escape: 0x01,
  Backspace: 0x0e,
  // Extended keys (bit 0x100 = KEYEVENTF_EXTENDEDKEY)
  Delete: 0x153,
  Insert: 0x152,
  ArrowUp: 0x148,
  ArrowDown: 0x150,
  ArrowLeft: 0x14b,
  ArrowRight: 0x14d,
  Home: 0x147,
  End: 0x14f,
  PageUp: 0x149,
  PageDown: 0x151,
  // Numpad
  Numpad0: 0x52,
  Numpad1: 0x4f,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad4: 0x4b,
  Numpad5: 0x4c,
  Numpad6: 0x4d,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  NumpadAdd: 0x4e,
  NumpadSubtract: 0x4a,
  NumpadMultiply: 0x37,
  NumpadDivide: 0x135, // extended
  NumpadDecimal: 0x53,
  NumpadEnter: 0x11c, // extended
};

/** Maps modifier names to their scan codes (left-side variants) */
const MODIFIER_SCAN: Record<string, number> = {
  ctrl: 0x1d,
  shift: 0x2a,
  alt: 0x38,
};

/**
 * Get the PS/2 scan code for a KeyboardEvent.code value.
 * @returns Scan code, or undefined if the code isn't mapped
 */
export function getScanCode(code: string): number | undefined {
  return CODE_TO_SCAN[code];
}

/**
 * Get the PS/2 scan code for a modifier name.
 * @returns Scan code, or undefined if the modifier isn't recognized
 */
export function getModifierScanCode(modifier: string): number | undefined {
  return MODIFIER_SCAN[modifier];
}
