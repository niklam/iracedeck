/// <reference lib="dom" />
/**
 * Key Binding Input Web Component for Stream Deck Property Inspector
 *
 * A custom input component that captures keyboard shortcuts or SimHub role names.
 * A custom dropdown selector before the main input lets users choose between
 * Keyboard and SimHub modes. The dropdown shows icons when collapsed and
 * icons + labels when expanded.
 *
 * Usage in HTML:
 * ```html
 * <!-- Action-specific setting (different per action instance) -->
 * <sdpi-item label="Hotkey">
 *   <ird-key-binding setting="myHotkey" default="F1"></ird-key-binding>
 * </sdpi-item>
 *
 * <!-- Global setting (shared across all actions in the plugin) -->
 * <sdpi-item label="Lap Timing Key">
 *   <ird-key-binding setting="keys.blackBox.lapTiming" default="F1" global></ird-key-binding>
 * </sdpi-item>
 * ```
 *
 * Attributes:
 * - setting: The settings key name
 * - default: Default key (e.g., "F1", "Ctrl+Shift+A")
 * - global: When present, uses plugin-level global settings (shared across all actions)
 *
 * Stored values:
 * - Keyboard: { "key": "f1", "modifiers": ["ctrl", "shift"] }
 * - SimHub:   { "type": "simhub", "role": "My Role Name" }
 */
import {
  formatKeyBinding,
  type KeyBindingValue,
  parseKeyBinding,
  parseSimpleDefault,
  SDPI_THEME,
  UI_TEXT,
} from "./key-binding-utils.js";
import { KEY_CODE_MAP, type Modifier, resolveEventCode } from "./key-maps.js";

/**
 * SimHub role binding value.
 *
 * SYNC NOTE: This is a browser-side duplicate of SimHubBindingValue in
 * @iracedeck/deck-core/global-settings.ts. The PI runs in a browser context
 * and cannot import from deck-core (Node.js). Keep both definitions in sync
 * when adding new fields or binding types.
 */
export interface SimHubBindingValue {
  type: "simhub";
  role: string;
}

/**
 * Union type for all binding values stored by this component.
 * SYNC NOTE: Mirrors BindingValue in @iracedeck/deck-core/global-settings.ts.
 */
export type BindingValue = KeyBindingValue | SimHubBindingValue;

/**
 * Type guard for SimHub binding values.
 * SYNC NOTE: Mirrors isSimHubBinding in @iracedeck/deck-core/global-settings.ts.
 */
export function isSimHubBinding(value: BindingValue | null): value is SimHubBindingValue {
  return value !== null && "type" in value && value.type === "simhub";
}

/**
 * Parse a stored JSON string into a BindingValue (keyboard or SimHub).
 */
function parseBindingValue(json: string | null): BindingValue | null {
  if (!json) return null;

  try {
    const parsed = JSON.parse(json);

    // SimHub binding
    if (parsed.type === "simhub" && typeof parsed.role === "string") {
      return { type: "simhub", role: parsed.role };
    }

    // Keyboard binding (existing format)
    return parseKeyBinding(json);
  } catch {
    return null;
  }
}

// Inline SVG icons (14x14) for the mode dropdown
const KEYBOARD_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="none">
  <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="#ccc" stroke-width="1.2"/>
  <rect x="3" y="5" width="2" height="1.5" rx="0.3" fill="#ccc"/>
  <rect x="6" y="5" width="2" height="1.5" rx="0.3" fill="#ccc"/>
  <rect x="9" y="5" width="2" height="1.5" rx="0.3" fill="#ccc"/>
  <rect x="12" y="5" width="2" height="1.5" rx="0.3" fill="#ccc"/>
  <rect x="3" y="7.5" width="2" height="1.5" rx="0.3" fill="#ccc"/>
  <rect x="6" y="7.5" width="2" height="1.5" rx="0.3" fill="#ccc"/>
  <rect x="9" y="7.5" width="2" height="1.5" rx="0.3" fill="#ccc"/>
  <rect x="12" y="7.5" width="2" height="1.5" rx="0.3" fill="#ccc"/>
  <rect x="5" y="10" width="6" height="1.5" rx="0.3" fill="#ccc"/>
</svg>`;

// SimHub logo: blue hexagon with white gamepad
const SIMHUB_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14">
  <polygon points="8,1 14.5,4.5 14.5,11.5 8,15 1.5,11.5 1.5,4.5" fill="#2980d9"/>
  <rect x="4.5" y="5.5" width="7" height="5" rx="1.2" fill="white"/>
  <circle cx="6" cy="8" r="0.9" fill="#2980d9"/>
  <circle cx="10" cy="7" r="0.6" fill="#2980d9"/>
  <circle cx="10" cy="9" r="0.6" fill="#2980d9"/>
</svg>`;

/**
 * Minimal type for the Keyboard Layout Map API.
 */
interface KeyboardLayoutMapLike {
  get(code: string): string | undefined;
}

// Re-export for backwards compatibility and public API
export { formatKeyBinding, parseKeyBinding, parseSimpleDefault, type KeyBindingValue };

type SettingsHook = [() => Promise<string>, (value: string) => void];

declare global {
  interface Window {
    SDPIComponents?: {
      useSettings: (key: string, callback: (value: string) => void, debounceMs?: number | null) => SettingsHook;
      useGlobalSettings: (key: string, callback: (value: string) => void, debounceMs?: number | null) => SettingsHook;
    };
  }
}

/**
 * Mode option configuration for the custom dropdown.
 */
interface ModeOption {
  value: string;
  label: string;
  icon: string;
}

/**
 * Global SimHub state cached for the PI page lifetime.
 * Host/port read from global settings, roles fetched via HTTP on first access.
 */
let simHubHost = "127.0.0.1";
let simHubPort = 8888;
let simHubRoles: string[] = [];
let simHubReachable = false;
let simHubFetchDone = false;
let simHubFetchPromise: Promise<void> | null = null;
let simHubSettingsSubscribed = false;

/**
 * Subscribe to SimHub host/port global settings (once).
 * Must be called after SDPIComponents is available.
 */
function subscribeToSimHubSettings(): void {
  if (simHubSettingsSubscribed || !window.SDPIComponents) return;

  simHubSettingsSubscribed = true;

  window.SDPIComponents.useGlobalSettings(
    "simHubHost",
    (v: string) => {
      if (v) simHubHost = v;
    },
    null,
  );

  window.SDPIComponents.useGlobalSettings(
    "simHubPort",
    (v: string) => {
      if (v) simHubPort = parseInt(v, 10) || 8888;
    },
    null,
  );
}

/**
 * Ensure SimHub roles have been fetched. Caches the result for the page lifetime.
 * Retries on next call if the previous fetch failed (SimHub may have started).
 */
async function ensureSimHubRolesFetched(): Promise<void> {
  if (simHubFetchDone && simHubReachable) return;

  if (simHubFetchPromise) {
    await simHubFetchPromise;

    return;
  }

  simHubFetchPromise = (async () => {
    try {
      const url = `http://${simHubHost}:${simHubPort}/api/ControlMapper/GetRoles/`;
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });

      if (response.ok) {
        simHubRoles = (await response.json()) as string[];
        simHubReachable = true;
      } else {
        simHubRoles = [];
        simHubReachable = false;
      }
    } catch {
      simHubRoles = [];
      simHubReachable = false;
    } finally {
      simHubFetchDone = true;
      simHubFetchPromise = null;
    }
  })();

  await simHubFetchPromise;
}

const MODE_OPTIONS: ModeOption[] = [
  { value: "keyboard", label: "Keyboard", icon: KEYBOARD_ICON_SVG },
  { value: "simhub", label: "SimHub", icon: SIMHUB_ICON_SVG },
];

/**
 * KeyBindingInput - Custom element that integrates with sdpi-components
 * via SDPIComponents.useSettings() for proper settings persistence.
 *
 * Supports two modes via a custom dropdown:
 * - Keyboard: captures keyboard shortcuts (click to record)
 * - SimHub: text input for SimHub Control Mapper role names
 */
class KeyBindingInput extends HTMLElement {
  private container: HTMLDivElement | null = null;
  private dropdownTrigger: HTMLDivElement | null = null;
  private dropdownPanel: HTMLDivElement | null = null;
  private dropdownIcon: HTMLSpanElement | null = null;
  private displayInput: HTMLInputElement | null = null;
  private simhubAutocomplete: import("./autocomplete-input.js").AutocompleteInput | null = null;
  private isRecording = false;
  private isDropdownOpen = false;
  private currentValue: BindingValue | null = null;
  private isSimHubMode = false;
  private saveToStreamDeck: ((value: string) => void) | null = null;
  private layoutMap: KeyboardLayoutMapLike | null = null;
  private boundCloseDropdown: ((e: MouseEvent) => void) | null = null;

  constructor() {
    super();

    this.handleClick = this.handleClick.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
  }

  get value(): string {
    return this.currentValue ? JSON.stringify(this.currentValue) : "";
  }

  set value(val: string) {
    if (val) {
      this.currentValue = parseBindingValue(val);
      this.isSimHubMode = isSimHubBinding(this.currentValue);
    } else {
      this.currentValue = null;
    }

    this.updateDisplay();
  }

  connectedCallback(): void {
    // Outer container
    this.container = document.createElement("div");
    Object.assign(this.container.style, {
      display: "flex",
      alignItems: "center",
      width: "100%",
      backgroundColor: SDPI_THEME.background,
      position: "relative",
    });

    // Custom dropdown trigger (shows current mode icon)
    this.dropdownTrigger = document.createElement("div");
    Object.assign(this.dropdownTrigger.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: "28px",
      height: SDPI_THEME.height,
      backgroundColor: "#333",
      borderRight: "1px solid #555",
      cursor: "pointer",
      flexShrink: "0",
    });

    this.dropdownIcon = document.createElement("span");
    this.dropdownIcon.innerHTML = KEYBOARD_ICON_SVG;
    Object.assign(this.dropdownIcon.style, {
      display: "flex",
      alignItems: "center",
    });
    this.dropdownTrigger.appendChild(this.dropdownIcon);

    // Dropdown panel (hidden by default)
    this.dropdownPanel = document.createElement("div");
    Object.assign(this.dropdownPanel.style, {
      display: "none",
      position: "absolute",
      top: "100%",
      left: "0",
      zIndex: "1000",
      backgroundColor: "#2a2a2a",
      border: "1px solid #555",
      borderRadius: "4px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
      minWidth: "130px",
      marginTop: "2px",
    });

    for (const option of MODE_OPTIONS) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "6px 10px",
        cursor: "pointer",
        fontSize: "11px",
        color: SDPI_THEME.text,
        whiteSpace: "nowrap",
      });
      row.innerHTML = `<span style="display:flex;align-items:center;">${option.icon}</span><span>${option.label}</span>`;
      row.addEventListener("mouseenter", () => {
        row.style.backgroundColor = "#444";
      });
      row.addEventListener("mouseleave", () => {
        row.style.backgroundColor = "transparent";
      });
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectMode(option.value);
      });
      this.dropdownPanel.appendChild(row);
    }

    // Keyboard mode input
    this.displayInput = document.createElement("input");
    this.displayInput.type = "text";
    this.displayInput.readOnly = true;
    this.displayInput.placeholder = UI_TEXT.PLACEHOLDER;
    Object.assign(this.displayInput.style, {
      backgroundColor: "transparent",
      color: SDPI_THEME.text,
      fontFamily: SDPI_THEME.fontFamily,
      fontSize: SDPI_THEME.fontSize,
      height: SDPI_THEME.height,
      padding: SDPI_THEME.padding,
      border: "none",
      boxSizing: "border-box",
      flex: "1",
      minWidth: "0",
      cursor: "pointer",
    });

    // SimHub mode: autocomplete input for role selection
    this.simhubAutocomplete = document.createElement(
      "ird-autocomplete",
    ) as import("./autocomplete-input.js").AutocompleteInput;
    this.simhubAutocomplete.placeholder = UI_TEXT.SIMHUB_PLACEHOLDER;
    this.simhubAutocomplete.style.display = "none";

    this.container.appendChild(this.dropdownTrigger);
    this.container.appendChild(this.displayInput);
    this.container.appendChild(this.simhubAutocomplete);
    this.container.appendChild(this.dropdownPanel);
    this.appendChild(this.container);

    // Subscribe to SimHub host/port settings (once, shared across instances)
    subscribeToSimHubSettings();

    // Settings integration
    const settingName = this.getAttribute("setting");
    const defaultValue = this.getAttribute("default");
    const useGlobal = this.hasAttribute("global");

    if (settingName && window.SDPIComponents) {
      const useSettingsHook = useGlobal ? window.SDPIComponents.useGlobalSettings : window.SDPIComponents.useSettings;

      const [, save] = useSettingsHook(
        settingName,
        (value: string) => {
          if (value) {
            this.value = value;
          } else if (defaultValue) {
            this.currentValue = parseSimpleDefault(defaultValue);
            this.isSimHubMode = false;
            this.updateDisplay();
            save(this.value);
          }
        },
        null,
      );
      this.saveToStreamDeck = save;
    }

    if (!window.SDPIComponents && defaultValue && !this.currentValue) {
      this.currentValue = parseSimpleDefault(defaultValue);
    }

    this.updateDisplay();
    this.initLayoutMap();

    // Event listeners
    this.dropdownTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });
    this.displayInput.addEventListener("click", this.handleClick);
    this.displayInput.addEventListener("keydown", this.handleKeyDown);
    this.displayInput.addEventListener("blur", this.handleBlur);
    this.simhubAutocomplete.addEventListener("change", () => {
      const role = this.simhubAutocomplete!.value.trim();
      this.currentValue = role ? { type: "simhub", role } : null;
      this.notifyChange();
    });

    // Close dropdown on outside click
    this.boundCloseDropdown = (e: MouseEvent) => {
      if (this.isDropdownOpen && !this.container?.contains(e.target as Node)) {
        this.closeDropdown();
      }
    };
    document.addEventListener("click", this.boundCloseDropdown);
  }

  private async initLayoutMap(): Promise<void> {
    try {
      const kbd = (navigator as unknown as Record<string, unknown>).keyboard as
        | { getLayoutMap?: () => Promise<KeyboardLayoutMapLike> }
        | undefined;

      if (kbd?.getLayoutMap) {
        this.layoutMap = await kbd.getLayoutMap();
      }
    } catch {
      // Keyboard Layout Map API not available
    }
  }

  disconnectedCallback(): void {
    this.displayInput?.removeEventListener("click", this.handleClick);
    this.displayInput?.removeEventListener("keydown", this.handleKeyDown);
    this.displayInput?.removeEventListener("blur", this.handleBlur);

    if (this.boundCloseDropdown) {
      document.removeEventListener("click", this.boundCloseDropdown);
    }
  }

  setValue(value: KeyBindingValue | null, saveToSettings = true): void {
    this.currentValue = value;
    this.isSimHubMode = isSimHubBinding(value);
    this.updateDisplay();

    if (saveToSettings) {
      this.notifyChange();
    }
  }

  getValue(): BindingValue | null {
    return this.currentValue;
  }

  // --- Dropdown ---

  private toggleDropdown(): void {
    if (this.isDropdownOpen) {
      this.closeDropdown();
    } else {
      this.openDropdown();
    }
  }

  private openDropdown(): void {
    if (!this.dropdownPanel) return;

    this.isDropdownOpen = true;
    this.dropdownPanel.style.display = "block";
  }

  private closeDropdown(): void {
    if (!this.dropdownPanel) return;

    this.isDropdownOpen = false;
    this.dropdownPanel.style.display = "none";
  }

  private selectMode(mode: string): void {
    this.closeDropdown();

    if (mode === "simhub") {
      this.isSimHubMode = true;

      if (this.isRecording) {
        this.stopRecording();
      }

      if (this.currentValue && !isSimHubBinding(this.currentValue)) {
        this.currentValue = null;
      }

      // Fetch roles from SimHub (async, cached after first successful fetch)
      void ensureSimHubRolesFetched().then(() => this.updateSimHubAutocomplete());
    } else {
      this.isSimHubMode = false;

      // Reset to default keyboard binding
      const defaultValue = this.getAttribute("default");

      if (defaultValue) {
        this.currentValue = parseSimpleDefault(defaultValue);
      } else {
        this.currentValue = null;
      }

      this.notifyChange();
    }

    this.updateDisplay();

    if (this.isSimHubMode && this.simhubAutocomplete) {
      this.simhubAutocomplete.focusInput();
    }
  }

  // --- Keyboard recording ---

  private handleClick(): void {
    if (!this.isRecording && !this.isSimHubMode) {
      this.startRecording();
    }
  }

  private startRecording(): void {
    if (!this.displayInput) return;

    this.isRecording = true;
    this.displayInput.value = UI_TEXT.RECORDING;
    this.displayInput.style.backgroundColor = SDPI_THEME.recordingBackground;

    if (this.container) {
      this.container.style.backgroundColor = SDPI_THEME.recordingBackground;
    }

    this.displayInput.focus();
  }

  private stopRecording(): void {
    if (!this.displayInput) return;

    this.isRecording = false;
    this.displayInput.style.backgroundColor = "transparent";

    if (this.container) {
      this.container.style.backgroundColor = SDPI_THEME.background;
    }

    this.displayInput.blur();
    this.updateDisplay();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.isRecording) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.code === "Escape") {
      this.stopRecording();

      return;
    }

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

    const code = resolveEventCode(e.code, e.key);
    const key = KEY_CODE_MAP[code];

    if (!key) return;

    const modifiers: Modifier[] = [];

    if (e.ctrlKey) modifiers.push("ctrl");

    if (e.shiftKey) modifiers.push("shift");

    if (e.altKey) modifiers.push("alt");

    const hasModifiers = e.ctrlKey || e.shiftKey || e.altKey;
    const displayKey = hasModifiers ? (this.layoutMap?.get(code) ?? e.key) : e.key;

    this.currentValue = { key, modifiers, code, displayKey };
    this.isSimHubMode = false;

    this.stopRecording();
    this.notifyChange();
  }

  private handleBlur(): void {
    if (this.isRecording) {
      this.stopRecording();
    }
  }

  // --- SimHub input ---

  /**
   * Update the SimHub autocomplete component with current roles and reachability.
   */
  private updateSimHubAutocomplete(): void {
    if (!this.simhubAutocomplete) return;

    if (!simHubReachable) {
      this.simhubAutocomplete.setStatus(UI_TEXT.SIMHUB_NOT_REACHABLE);
    } else if (simHubRoles.length === 0) {
      this.simhubAutocomplete.setStatus(UI_TEXT.SIMHUB_NO_ROLES);
    } else {
      this.simhubAutocomplete.setSuggestions(simHubRoles);
    }
  }

  // --- Display ---

  private updateDisplay(): void {
    if (!this.displayInput || !this.simhubAutocomplete || !this.dropdownIcon) return;

    // Update dropdown icon to reflect current mode
    const currentOption = MODE_OPTIONS.find((o) => o.value === (this.isSimHubMode ? "simhub" : "keyboard"));

    if (currentOption) {
      this.dropdownIcon.innerHTML = currentOption.icon;
    }

    if (this.isSimHubMode) {
      this.displayInput.style.display = "none";
      this.simhubAutocomplete.style.display = "flex";
      this.simhubAutocomplete.value = isSimHubBinding(this.currentValue) ? this.currentValue.role : "";
      void ensureSimHubRolesFetched().then(() => this.updateSimHubAutocomplete());
    } else {
      this.displayInput.style.display = "block";
      this.simhubAutocomplete.style.display = "none";
      this.displayInput.value = formatKeyBinding(this.currentValue as KeyBindingValue | null);
    }
  }

  private notifyChange(): void {
    if (this.saveToStreamDeck) {
      this.saveToStreamDeck(this.value);
    }
  }

  static get observedAttributes(): string[] {
    return ["value", "default", "global"];
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string): void {
    if (name === "value" && newValue) {
      this.currentValue = parseBindingValue(newValue);
      this.isSimHubMode = isSimHubBinding(this.currentValue);
      this.updateDisplay();
    } else if (name === "default" && newValue && newValue !== oldValue) {
      this.currentValue = parseSimpleDefault(newValue);
      this.isSimHubMode = false;
      this.updateDisplay();
      this.notifyChange();
    }
  }
}

// Register the custom element
if (typeof customElements !== "undefined") {
  customElements.define("ird-key-binding", KeyBindingInput);
}

export { KeyBindingInput };
