/// <reference lib="dom" />
/**
 * Key Binding Input Web Component for Stream Deck Property Inspector
 *
 * A custom input component that captures keyboard shortcuts.
 * Click to start recording, press a key combination, and it saves automatically.
 *
 * Usage in HTML:
 * ```html
 * <sdpi-item label="Hotkey">
 *   <ird-key-binding setting="myHotkey" default="F1"></ird-key-binding>
 * </sdpi-item>
 * ```
 *
 * The stored value is a JSON string with format:
 * { "key": "f1", "modifiers": ["ctrl", "shift"] }
 */

export interface KeyBindingValue {
  key: string;
  modifiers: string[];
}

// Map browser key codes to our internal key format
const KEY_CODE_MAP: Record<string, string> = {
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

// Display names for keys
const KEY_DISPLAY_NAMES: Record<string, string> = {
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

export function formatKeyBinding(value: KeyBindingValue | null): string {
  if (!value || !value.key) {
    return "Not set";
  }

  const parts: string[] = [];

  if (value.modifiers?.includes("ctrl")) parts.push("Ctrl");
  if (value.modifiers?.includes("shift")) parts.push("Shift");
  if (value.modifiers?.includes("alt")) parts.push("Alt");

  // Format the key for display
  const keyDisplay =
    KEY_DISPLAY_NAMES[value.key] || value.key.toUpperCase();
  parts.push(keyDisplay);

  return parts.join(" + ");
}

export function parseKeyBinding(json: string | null): KeyBindingValue | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as KeyBindingValue;
  } catch {
    return null;
  }
}

// Declare SDPIComponents global type
declare global {
  interface Window {
    SDPIComponents?: {
      useSettings: (
        key: string,
        callback: (value: string) => void,
        debounceMs?: number | null,
      ) => [() => Promise<string>, (value: string) => void];
    };
  }
}

/**
 * KeyBindingInput - Custom element that integrates with sdpi-components
 * via SDPIComponents.useSettings() for proper settings persistence.
 */
class KeyBindingInput extends HTMLElement {
  private displayInput: HTMLInputElement | null = null;
  private isRecording = false;
  private currentValue: KeyBindingValue | null = null;
  private saveToStreamDeck: ((value: string) => void) | null = null;

  constructor() {
    super();

    // Bind event handlers
    this.handleClick = this.handleClick.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
  }

  /**
   * Value getter - returns JSON string for sdpi-components
   */
  get value(): string {
    return this.currentValue ? JSON.stringify(this.currentValue) : "";
  }

  /**
   * Value setter - accepts JSON string from sdpi-components
   */
  set value(val: string) {
    if (val) {
      this.currentValue = parseKeyBinding(val);
    } else {
      this.currentValue = null;
    }
    this.updateDisplay();
  }

  connectedCallback(): void {
    // Create visible input for user interaction
    this.displayInput = document.createElement("input");
    this.displayInput.type = "text";
    this.displayInput.readOnly = true;
    this.displayInput.placeholder = "Click to set...";

    // Apply SDPI-matching styles directly (SDPI uses Shadow DOM so CSS vars aren't inherited)
    Object.assign(this.displayInput.style, {
      backgroundColor: "#3d3d3d",
      color: "#d8d8d8",
      fontFamily: '"Segoe UI", Arial, sans-serif',
      fontSize: "9pt",
      height: "30px",
      padding: "7px 4px",
      border: "none",
      borderRadius: "0",
      boxSizing: "border-box",
      width: "100%",
      cursor: "pointer",
    });

    this.appendChild(this.displayInput);

    // Get setting name and integrate with SDPIComponents
    const settingName = this.getAttribute("setting");
    if (settingName && window.SDPIComponents) {
      // Use SDPIComponents.useSettings to get/save settings
      const [, save] = window.SDPIComponents.useSettings(
        settingName,
        (value: string) => {
          // Called when settings are loaded or changed externally
          this.value = value;
        },
        null, // No debounce
      );
      this.saveToStreamDeck = save;
    }

    // Get default value if specified and no value is set yet
    const defaultValue = this.getAttribute("default");
    if (defaultValue && !this.currentValue) {
      // Parse simple default like "F1" or "Ctrl+Shift+A"
      this.currentValue = this.parseSimpleDefault(defaultValue);
    }

    this.updateDisplay();

    this.displayInput.addEventListener("click", this.handleClick);
    this.displayInput.addEventListener("keydown", this.handleKeyDown);
    this.displayInput.addEventListener("blur", this.handleBlur);
  }

  disconnectedCallback(): void {
    if (this.displayInput) {
      this.displayInput.removeEventListener("click", this.handleClick);
      this.displayInput.removeEventListener("keydown", this.handleKeyDown);
      this.displayInput.removeEventListener("blur", this.handleBlur);
    }
  }

  private parseSimpleDefault(value: string): KeyBindingValue {
    const parts = value.split("+").map((p) => p.trim().toLowerCase());
    const modifiers: string[] = [];
    let key = "";

    for (const part of parts) {
      if (part === "ctrl" || part === "control") {
        modifiers.push("ctrl");
      } else if (part === "shift") {
        modifiers.push("shift");
      } else if (part === "alt") {
        modifiers.push("alt");
      } else {
        key = part;
      }
    }

    return { key, modifiers };
  }

  // Called by external code to set the value
  setValue(value: KeyBindingValue | null): void {
    this.currentValue = value;
    this.updateDisplay();
  }

  // Called by external code to get the value
  getValue(): KeyBindingValue | null {
    return this.currentValue;
  }

  private handleClick(): void {
    if (!this.isRecording) {
      this.startRecording();
    }
  }

  private startRecording(): void {
    if (!this.displayInput) return;
    this.isRecording = true;
    this.displayInput.value = "Press keys...";
    this.displayInput.style.backgroundColor = "rgba(0, 132, 255, 0.2)";
    this.displayInput.style.borderColor = "#0084ff";
    this.displayInput.focus();
  }

  private stopRecording(): void {
    if (!this.displayInput) return;
    this.isRecording = false;
    // Restore SDPI theme colors
    this.displayInput.style.backgroundColor = "#3d3d3d";
    this.displayInput.style.borderColor = "";
    this.displayInput.blur();
    this.updateDisplay();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.isRecording) return;

    e.preventDefault();
    e.stopPropagation();

    // Escape cancels recording
    if (e.code === "Escape") {
      this.stopRecording();
      return;
    }

    // Ignore modifier-only keys
    if (
      e.code === "ControlLeft" ||
      e.code === "ControlRight" ||
      e.code === "ShiftLeft" ||
      e.code === "ShiftRight" ||
      e.code === "AltLeft" ||
      e.code === "AltRight" ||
      e.code === "MetaLeft" ||
      e.code === "MetaRight"
    ) {
      return;
    }

    // Get the key from our map
    const key = KEY_CODE_MAP[e.code];
    if (!key) {
      // Unknown key, ignore
      return;
    }

    // Build modifiers array
    const modifiers: string[] = [];
    if (e.ctrlKey) modifiers.push("ctrl");
    if (e.shiftKey) modifiers.push("shift");
    if (e.altKey) modifiers.push("alt");

    // Set the new value
    this.currentValue = { key, modifiers };

    // Stop recording and update display
    this.stopRecording();

    // Notify Stream Deck of the change
    this.notifyChange();
  }

  private handleBlur(): void {
    if (this.isRecording) {
      this.stopRecording();
    }
  }

  private updateDisplay(): void {
    if (this.displayInput) {
      this.displayInput.value = formatKeyBinding(this.currentValue);
    }
  }

  private notifyChange(): void {
    // Save to Stream Deck via SDPIComponents.useSettings
    if (this.saveToStreamDeck) {
      this.saveToStreamDeck(this.value);
    }
  }

  // Attribute change handling for dynamic updates
  static get observedAttributes(): string[] {
    return ["value", "default"];
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string): void {
    if (name === "value" && newValue) {
      this.currentValue = parseKeyBinding(newValue);
      this.updateDisplay();
    }
  }
}

// Register the custom element
if (typeof customElements !== "undefined") {
  customElements.define("ird-key-binding", KeyBindingInput);
}

export { KeyBindingInput };
