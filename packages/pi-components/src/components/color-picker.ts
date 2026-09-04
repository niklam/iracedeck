/// <reference lib="dom" />
/**
 * Color Picker Web Component for Stream Deck Property Inspector
 *
 * A custom color picker that supports a "not set" state, inline hex display,
 * and a built-in clear button. Replaces `<sdpi-color>` which always requires
 * a value and used the #000001 sentinel hack for "not set".
 *
 * Usage in HTML:
 * ```html
 * <!-- Per-action color override -->
 * <sdpi-item label="Background">
 *   <ird-color-picker id="my-id" setting="colorOverrides.backgroundColor"></ird-color-picker>
 * </sdpi-item>
 *
 * <!-- Global color setting -->
 * <sdpi-item label="Background">
 *   <ird-color-picker id="my-id" setting="colorBackgroundColor" global></ird-color-picker>
 * </sdpi-item>
 * ```
 *
 * Attributes:
 * - setting: The settings key name (supports dot-notation for nested paths)
 * - default: Default hex color when no saved value exists
 * - global: When present, uses plugin-level global settings
 *
 * Stored values:
 * - Has color: hex string like "#ff0000"
 * - Not set: empty string ""
 */
import { SDPI_THEME } from "./key-binding-utils.js";
import { skipUnchanged } from "./settings-change-filter.js";

/** Inline SVG data URI for the "not set" indicator: white with red diagonal line */
const NOT_SET_BACKGROUND = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<rect width="24" height="24" fill="white"/>' +
    '<line x1="0" y1="24" x2="24" y2="0" stroke="red" stroke-width="2"/>' +
    "</svg>",
)}")`;

/** Regex for validating hex color input (3 or 6 hex digits, with or without #) */
const HEX_REGEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Regex for normalized stored hex (lowercase, 6 digits, with #) */
const NORMALIZED_HEX_REGEX = /^#[0-9a-f]{6}$/;

/**
 * Slot types that share a recent‑color history. `labelColor` / `valueColor`
 * are the Setup dial dash-box text slots (issue #811); the dial's border and
 * background reuse the existing `borderColor` / `backgroundColor` slots.
 */
const KNOWN_SLOTS = [
  "backgroundColor",
  "textColor",
  "graphic1Color",
  "graphic2Color",
  "borderColor",
  "labelColor",
  "valueColor",
] as const;
type SlotType = (typeof KNOWN_SLOTS)[number];

/** Fixed presets always rendered (after the optional icon‑default slot). */
const FIXED_PRESETS: ReadonlyArray<{ hex: string; label: string }> = [
  { hex: "#000000", label: "Black" },
  { hex: "#ffffff", label: "White" },
];

/** Slot index of the "Not set" (clear) swatch. */
const NOT_SET_INDEX = 0;

/** Slot index of the optional icon‑default preset in the small swatch group. */
const ICON_DEFAULT_INDEX = 1;

/** Index at which the fixed presets (Black, White) begin. */
const PRESET_START_INDEX = 2;

/** Index at which the recent‑color history begins. */
const HISTORY_START_INDEX = PRESET_START_INDEX + FIXED_PRESETS.length;

/** Number of recent colors visible at once. */
const HISTORY_VISIBLE = 4;

/** Total small swatch count: not‑set + icon default + 2 fixed presets + 4 recents. */
const SMALL_SWATCH_COUNT = HISTORY_START_INDEX + HISTORY_VISIBLE;

/** Maximum recent colors stored in global settings (allows headroom over what's shown). */
const HISTORY_MAX = 6;

/**
 * Infer the shared slot type from a `setting` attribute value.
 * - `colorOverrides.backgroundColor` → `backgroundColor`
 * - `colorBackgroundColor` → `backgroundColor`
 * - `borderOverrides.borderColor` → `borderColor`
 * - `borderColor` → `borderColor`
 * - anything else → `null`
 */
export function inferSlotType(setting: string | null | undefined): SlotType | null {
  if (!setting) return null;

  const lastSegment = setting.includes(".") ? setting.split(".").pop()! : setting;

  let candidate = lastSegment;

  // Strip a "color" prefix from flat global keys: colorBackgroundColor → backgroundColor
  if (candidate.startsWith("color") && candidate.length > 5 && candidate !== "borderColor") {
    candidate = candidate.charAt(5).toLowerCase() + candidate.slice(6);
  }

  return (KNOWN_SLOTS as readonly string[]).includes(candidate) ? (candidate as SlotType) : null;
}

/**
 * Build the global settings key under which a slot's recent colors are stored.
 * Uses a leading underscore to mark it as internal (matches `_accordionState`).
 */
export function historySettingKey(slot: SlotType): string {
  return `_colorHistory${slot.charAt(0).toUpperCase()}${slot.slice(1)}`;
}

/**
 * Parse the JSON string stored at the history setting key into a list of
 * normalized hex codes. Invalid input → empty array. Truncated to `HISTORY_MAX`.
 */
export function parseColorHistory(raw: string | null | undefined): string[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((v): v is string => typeof v === "string" && NORMALIZED_HEX_REGEX.test(v))
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

/** Whether a hex value is one of the fixed Black/White presets. */
function isFixedPreset(hex: string): boolean {
  return hex === "#000000" || hex === "#ffffff";
}

/**
 * Normalize a hex color string to lowercase 6-digit format with # prefix.
 * Returns empty string for invalid input.
 */
function normalizeHex(input: string): string {
  const trimmed = input.trim();

  if (!HEX_REGEX.test(trimmed)) return "";

  let hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;

  // Expand 3-digit shorthand to 6-digit
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }

  return `#${hex.toLowerCase()}`;
}

/**
 * Check if a value is the legacy #000001 sentinel (meaning "not set").
 */
function isLegacySentinel(value: string): boolean {
  return value === "#000001";
}

/**
 * ColorPicker - Custom element that integrates with sdpi-components
 * via SDPIComponents.useSettings() for proper settings persistence.
 *
 * Features:
 * - "Not set" state with Illustrator-style red diagonal indicator
 * - Inline editable hex code display
 * - Dedicated "Not set" swatch that clears the color on click
 * - Normalizes legacy #000001 sentinel to empty string on load
 */
export class ColorPicker extends HTMLElement {
  private container: HTMLDivElement | null = null;
  private swatch: HTMLDivElement | null = null;
  private nativeInput: HTMLInputElement | null = null;
  private hexInput: HTMLInputElement | null = null;
  private smallSwatchGroup: HTMLDivElement | null = null;
  private smallSwatches: HTMLDivElement[] = [];
  private currentValue = "";
  private saveToStreamDeck: ((value: string) => void) | null = null;
  private _initialized = false;
  private slotType: SlotType | null = null;
  private iconDefault: string | null = null;
  private recentColors: string[] = [];
  private lastSavedHistoryJson = "";
  private saveHistory: ((value: string) => void) | null = null;

  static get observedAttributes(): string[] {
    // Only `value` can change after connection. `setting`, `default`,
    // `global`, and `data-default-color` are set once via EJS templates before
    // the element upgrades and are never mutated at runtime.
    return ["value"];
  }

  get value(): string {
    return this.currentValue;
  }

  set value(val: string) {
    // Normalize legacy sentinel to empty
    if (isLegacySentinel(val)) val = "";

    this.currentValue = val;
    this.updateDisplay();
  }

  public save(): void {
    this.saveToStreamDeck?.(this.currentValue);
  }

  connectedCallback(): void {
    if (this._initialized) return;

    this._initialized = true;

    this.slotType = inferSlotType(this.getAttribute("setting"));
    this.iconDefault = this.resolveIconDefault();
    this.buildDOM();
    this.attachListeners();
    this.hookSettings();
    this.updateSwatchDisplay();
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === "value" && newValue !== null) {
      this.value = newValue;
    }
  }

  private buildDOM(): void {
    // Container
    this.container = document.createElement("div");
    Object.assign(this.container.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
    });

    // Swatch (clickable/keyboard-accessible color preview)
    this.swatch = document.createElement("div");
    this.swatch.setAttribute("tabindex", "0");
    this.swatch.setAttribute("role", "button");
    Object.assign(this.swatch.style, {
      width: "26px",
      height: "26px",
      minWidth: "26px",
      borderRadius: "3px",
      cursor: "pointer",
      border: "1px solid #555",
      boxSizing: "border-box",
      backgroundSize: "cover",
    });

    // Hidden native color input
    this.nativeInput = document.createElement("input");
    this.nativeInput.type = "color";
    Object.assign(this.nativeInput.style, {
      position: "absolute",
      opacity: "0",
      width: "0",
      height: "0",
      pointerEvents: "none",
    });

    // Editable hex text input — fixed width to leave room for preset/recent swatches
    this.hexInput = document.createElement("input");
    this.hexInput.type = "text";
    this.hexInput.placeholder = "Not set";
    this.hexInput.maxLength = 7;
    Object.assign(this.hexInput.style, {
      flex: "0 0 54px",
      width: "54px",
      backgroundColor: SDPI_THEME.background,
      color: SDPI_THEME.text,
      fontFamily: SDPI_THEME.fontFamily,
      fontSize: SDPI_THEME.fontSize,
      border: "none",
      borderBottom: "1px solid #555",
      outline: "none",
      padding: "2px 4px",
      height: "26px",
      boxSizing: "border-box",
    });

    // Preset + recent swatch group (Black, White, then up to HISTORY_VISIBLE recents)
    this.smallSwatchGroup = document.createElement("div");
    Object.assign(this.smallSwatchGroup.style, {
      display: this.slotType ? "flex" : "none",
      alignItems: "center",
      gap: "3px",
      flex: "1",
    });

    for (let i = 0; i < SMALL_SWATCH_COUNT; i++) {
      const sw = document.createElement("div");
      sw.setAttribute("tabindex", "0");
      sw.setAttribute("role", "button");
      sw.setAttribute("data-swatch-index", String(i));
      Object.assign(sw.style, {
        width: "16px",
        height: "16px",
        minWidth: "16px",
        borderRadius: "2px",
        cursor: "pointer",
        border: "1px solid #555",
        boxSizing: "border-box",
        display: "none",
      });
      this.smallSwatches.push(sw);
      this.smallSwatchGroup.appendChild(sw);
    }

    this.container.appendChild(this.swatch);
    this.container.appendChild(this.nativeInput);
    this.container.appendChild(this.hexInput);
    this.container.appendChild(this.smallSwatchGroup);
    this.appendChild(this.container);

    this.updateDisplay();
  }

  private openNativePicker(): void {
    this.nativeInput!.value = this.currentValue || "#000000";
    this.nativeInput!.click();
  }

  private attachListeners(): void {
    // Swatch click/keyboard opens native picker
    this.swatch!.addEventListener("click", () => {
      this.openNativePicker();
    });

    this.swatch!.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.openNativePicker();
      }
    });

    // Native picker live preview
    this.nativeInput!.addEventListener("input", () => {
      if (this.swatch) {
        this.swatch.style.backgroundImage = "none";
        this.swatch.style.backgroundColor = this.nativeInput!.value;
      }
    });

    // Native picker commit
    this.nativeInput!.addEventListener("change", () => {
      this.currentValue = this.nativeInput!.value;
      this.updateDisplay();
      this.notifyChange();
    });

    // Hex input commit on blur
    this.hexInput!.addEventListener("blur", () => {
      this.commitHexInput();
    });

    // Hex input commit on Enter
    this.hexInput!.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.commitHexInput();
        this.hexInput!.blur();
      }
    });

    // Preset + recent swatch clicks
    this.smallSwatches.forEach((sw, idx) => {
      const handleActivate = () => {
        if (idx === NOT_SET_INDEX) {
          if (this.currentValue === "") return;

          this.currentValue = "";
          this.updateDisplay();
          this.notifyChange();

          return;
        }

        const hex = this.swatchHexAt(idx);

        if (!hex || hex === this.currentValue) return;

        this.currentValue = hex;
        this.updateDisplay();
        this.notifyChange();
      };

      sw.addEventListener("click", handleActivate);
      sw.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleActivate();
        }
      });
    });
  }

  /**
   * Resolve the icon default color from `default` or `data-default-color` attributes.
   * Returns `null` if the attribute is missing, invalid, or equal to Black/White
   * (which would duplicate the fixed presets).
   */
  private resolveIconDefault(): string | null {
    const raw = this.getAttribute("default") ?? this.getAttribute("data-default-color") ?? "";

    if (!raw) return null;

    const normalized = normalizeHex(raw);

    if (!normalized) return null;

    if (isFixedPreset(normalized)) return null;

    return normalized;
  }

  /** Resolve the hex value at a given small swatch index, or undefined when empty. */
  private swatchHexAt(idx: number): string | undefined {
    if (idx === ICON_DEFAULT_INDEX) return this.iconDefault ?? undefined;

    if (idx >= PRESET_START_INDEX && idx < HISTORY_START_INDEX) {
      return FIXED_PRESETS[idx - PRESET_START_INDEX].hex;
    }

    return this.recentColors[idx - HISTORY_START_INDEX];
  }

  private hookSettings(): void {
    const settingName = this.getAttribute("setting");
    const defaultValue = this.getAttribute("default") ?? "";
    const useGlobal = this.hasAttribute("global");

    if (settingName && window.SDPIComponents) {
      const useSettingsHook = useGlobal ? window.SDPIComponents.useGlobalSettings : window.SDPIComponents.useSettings;

      const [, save] = useSettingsHook(
        settingName,
        skipUnchanged((value: string) => {
          // Normalize legacy #000001 sentinel to empty string on load
          if (isLegacySentinel(value)) value = "";

          // Apply default for display only — don't persist, so per-action
          // overrides stay empty until the user explicitly sets a value
          if (!value && defaultValue) {
            this.currentValue = normalizeHex(defaultValue) || "";
            this.updateDisplay();

            return;
          }

          this.currentValue = value || "";
          this.updateDisplay();
        }),
        null,
      );

      this.saveToStreamDeck = save;
    }

    if (this.slotType && window.SDPIComponents) {
      const historyKey = historySettingKey(this.slotType);

      const [, saveHist] = window.SDPIComponents.useGlobalSettings(
        historyKey,
        skipUnchanged((value: string) => {
          const incoming = typeof value === "string" ? value : "";

          this.recentColors = parseColorHistory(incoming);
          this.lastSavedHistoryJson = incoming;
          this.updateSwatchDisplay();
        }),
        null,
      );

      this.saveHistory = saveHist;
    }
  }

  private commitHexInput(): void {
    const raw = this.hexInput!.value.trim();

    // Empty input = clear (not set)
    if (raw === "") {
      if (this.currentValue !== "") {
        this.currentValue = "";
        this.updateDisplay();
        this.notifyChange();
      }

      return;
    }

    const normalized = normalizeHex(raw);

    if (normalized && normalized !== this.currentValue) {
      this.currentValue = normalized;
      this.updateDisplay();
      this.notifyChange();
    } else if (!normalized) {
      // Invalid input — revert display
      this.updateDisplay();
    }
  }

  private notifyChange(): void {
    this.saveToStreamDeck?.(this.currentValue);
    this.dispatchEvent(new Event("change", { bubbles: true }));
    this.commitToHistory(this.currentValue);
  }

  /**
   * Push a newly committed color to the front of the recent‑color history.
   * No‑op for unknown slot types, empty values, the fixed presets, and the
   * icon default (all three render as dedicated preset swatches).
   */
  private commitToHistory(hex: string): void {
    if (!this.slotType) return;

    if (!hex) return;

    if (isFixedPreset(hex)) return;

    if (hex === this.iconDefault) return;

    const filtered = this.recentColors.filter((c) => c !== hex);

    filtered.unshift(hex);

    const next = filtered.slice(0, HISTORY_MAX);
    const json = JSON.stringify(next);

    if (json === this.lastSavedHistoryJson) return;

    this.lastSavedHistoryJson = json;
    this.recentColors = next;
    this.updateSwatchDisplay();
    this.saveHistory?.(json);
  }

  /** Render preset + recent swatches based on current slot type and history. */
  private updateSwatchDisplay(): void {
    if (this.smallSwatches.length === 0) return;

    if (!this.slotType) {
      for (const sw of this.smallSwatches) sw.style.display = "none";

      if (this.smallSwatchGroup) this.smallSwatchGroup.style.display = "none";

      return;
    }

    if (this.smallSwatchGroup) this.smallSwatchGroup.style.display = "flex";

    // Slot 0: Not set (always visible)
    const notSetSw = this.smallSwatches[NOT_SET_INDEX];

    notSetSw.style.display = "";
    notSetSw.style.backgroundColor = "transparent";
    notSetSw.style.backgroundImage = NOT_SET_BACKGROUND;
    notSetSw.style.backgroundSize = "cover";
    notSetSw.title = "Not set";

    // Slot 1: optional icon default
    const defaultSw = this.smallSwatches[ICON_DEFAULT_INDEX];

    if (this.iconDefault) {
      defaultSw.style.display = "";
      defaultSw.style.backgroundColor = this.iconDefault;
      defaultSw.style.borderColor = "#555";
      defaultSw.title = `Use icon default (${this.iconDefault})`;
    } else {
      defaultSw.style.display = "none";
      defaultSw.removeAttribute("title");
    }

    // Slots 2-3: fixed Black/White presets
    for (let i = 0; i < FIXED_PRESETS.length; i++) {
      const sw = this.smallSwatches[PRESET_START_INDEX + i];
      const preset = FIXED_PRESETS[i];

      sw.style.display = "";
      sw.style.backgroundColor = preset.hex;
      sw.style.borderColor = preset.hex === "#ffffff" ? "#777" : "#555";
      sw.title = `Use ${preset.label}`;
    }

    // Slots 4-7: recent history
    for (let i = 0; i < HISTORY_VISIBLE; i++) {
      const sw = this.smallSwatches[HISTORY_START_INDEX + i];
      const color = this.recentColors[i];

      if (!color) {
        sw.style.display = "none";
        sw.removeAttribute("title");

        continue;
      }

      sw.style.display = "";
      sw.style.backgroundColor = color;
      sw.style.borderColor = "#555";
      sw.title = `Use ${color}`;
    }
  }

  private updateDisplay(): void {
    if (!this.swatch || !this.hexInput) return;

    const hasValue = this.currentValue.length > 0;

    if (hasValue) {
      this.swatch.style.backgroundImage = "none";
      this.swatch.style.backgroundColor = this.currentValue;
      this.hexInput.value = this.currentValue;
      this.hexInput.style.color = SDPI_THEME.text;
    } else {
      this.swatch.style.backgroundColor = "transparent";
      this.swatch.style.backgroundImage = NOT_SET_BACKGROUND;
      this.hexInput.value = "";
      this.hexInput.style.color = "#808080";
    }
  }
}

// Register the custom element
if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-color-picker")) {
    customElements.define("ird-color-picker", ColorPicker);
  }
}
