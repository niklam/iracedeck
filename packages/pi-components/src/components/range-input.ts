/// <reference lib="dom" />
/**
 * Range Input Web Component for Stream Deck Property Inspector
 *
 * A custom range slider with a synced number input for precise value entry.
 * Replaces `<sdpi-range>` which only updates on mouse release and lacks
 * a number input for precise values.
 *
 * Usage in HTML:
 * ```html
 * <!-- Per-action setting -->
 * <sdpi-item label="Width">
 *   <ird-range-input setting="borderOverrides.borderWidth" min="1" max="20" step="1" default="7" showlabels></ird-range-input>
 * </sdpi-item>
 *
 * <!-- Global setting -->
 * <sdpi-item label="Font Size">
 *   <ird-range-input setting="titleFontSize" min="5" max="100" default="9" global showlabels></ird-range-input>
 * </sdpi-item>
 * ```
 *
 * Attributes:
 * - setting: The settings key name (supports dot-notation for nested paths)
 * - min: Minimum value
 * - max: Maximum value
 * - step: Increment size (default: 1)
 * - default: Default value when no saved value exists
 * - global: When present, uses plugin-level global settings
 * - showlabels: When present, shows min/max labels beside the slider
 *
 * Stored values:
 * - Has value: numeric string like "7"
 * - Not set: empty string ""
 */
import { SDPI_THEME } from "./key-binding-utils.js";

/** Whether the shared range-input style has been injected into the document */
let styleInjected = false;

/**
 * RangeInput - Custom element that integrates with sdpi-components
 * via SDPIComponents.useSettings() for proper settings persistence.
 *
 * Features:
 * - Range slider with bidirectional number input sync
 * - Live updates during drag (fires on input event)
 * - Number input for precise value entry, clamped to min/max
 * - Custom dark theme styling for Chromium WebView
 */
export class RangeInput extends HTMLElement {
  private container: HTMLDivElement | null = null;
  private rangeInput: HTMLInputElement | null = null;
  private numberInput: HTMLInputElement | null = null;
  private currentValue = "";
  private saveToStreamDeck: ((value: string) => void) | null = null;
  private _initialized = false;

  static get observedAttributes(): string[] {
    return ["value"];
  }

  get value(): string {
    return this.currentValue;
  }

  set value(val: string) {
    this.currentValue = val;
    this.updateDisplay();
  }

  public save(): void {
    this.saveToStreamDeck?.(this.currentValue);
  }

  connectedCallback(): void {
    if (this._initialized) return;

    this._initialized = true;

    this.buildDOM();
    this.attachListeners();
    this.hookSettings();
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === "value" && newValue !== null) {
      this.value = newValue;
    }
  }

  private buildDOM(): void {
    const min = this.getAttribute("min") ?? "0";
    const max = this.getAttribute("max") ?? "100";
    const step = this.getAttribute("step") ?? "1";
    const showLabels = this.hasAttribute("showlabels");

    // Inject shared style once for all ird-range-input instances
    if (!styleInjected && typeof document !== "undefined") {
      const style = document.createElement("style");
      style.textContent = `
        ird-range-input input[type="range"] {
          -webkit-appearance: none;
          appearance: none;
          height: 4px;
          background: #555;
          border-radius: 2px;
          outline: none;
        }
        ird-range-input input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #d8d8d8;
          cursor: pointer;
          border: 1px solid #888;
        }
        ird-range-input input[type="range"]::-webkit-slider-thumb:hover {
          background: #ffffff;
        }
      `;
      document.head.appendChild(style);
      styleInjected = true;
    }

    // Container
    this.container = document.createElement("div");
    Object.assign(this.container.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
    });

    // Min label
    if (showLabels) {
      const minLabel = document.createElement("span");
      minLabel.textContent = min;
      Object.assign(minLabel.style, {
        color: SDPI_THEME.text,
        fontFamily: SDPI_THEME.fontFamily,
        fontSize: SDPI_THEME.fontSize,
        flexShrink: "0",
        opacity: "0.7",
      });
      this.container.appendChild(minLabel);
    }

    // Range slider
    this.rangeInput = document.createElement("input");
    this.rangeInput.type = "range";
    this.rangeInput.min = min;
    this.rangeInput.max = max;
    this.rangeInput.step = step;
    Object.assign(this.rangeInput.style, {
      flex: "1",
      minWidth: "0",
    });
    this.container.appendChild(this.rangeInput);

    // Max label
    if (showLabels) {
      const maxLabel = document.createElement("span");
      maxLabel.textContent = max;
      Object.assign(maxLabel.style, {
        color: SDPI_THEME.text,
        fontFamily: SDPI_THEME.fontFamily,
        fontSize: SDPI_THEME.fontSize,
        flexShrink: "0",
        opacity: "0.7",
      });
      this.container.appendChild(maxLabel);
    }

    // Number input
    this.numberInput = document.createElement("input");
    this.numberInput.type = "number";
    this.numberInput.min = min;
    this.numberInput.max = max;
    this.numberInput.step = step;
    Object.assign(this.numberInput.style, {
      width: "50px",
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
      textAlign: "center",
      flexShrink: "0",
    });
    this.container.appendChild(this.numberInput);

    this.appendChild(this.container);

    this.updateDisplay();
  }

  private attachListeners(): void {
    // Range slider: live updates during drag
    this.rangeInput!.addEventListener("input", () => {
      this.currentValue = this.rangeInput!.value;
      this.numberInput!.value = this.currentValue;
      this.notifyChange();
    });

    // Number input: sync to range on input (skip empty to allow typing)
    this.numberInput!.addEventListener("input", () => {
      if (this.numberInput!.value === "") return;

      const clamped = this.clampValue(this.numberInput!.value);

      if (clamped !== null) {
        this.currentValue = clamped;
        this.rangeInput!.value = this.currentValue;
        this.numberInput!.value = this.currentValue;
        this.notifyChange();
      }
    });

    // Number input: clamp and commit on blur
    this.numberInput!.addEventListener("blur", () => {
      this.commitNumberInput();
    });

    // Number input: commit on Enter
    this.numberInput!.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.commitNumberInput();
        this.numberInput!.blur();
      }
    });
  }

  private hookSettings(): void {
    const settingName = this.getAttribute("setting");
    const useGlobal = this.hasAttribute("global");

    if (settingName && window.SDPIComponents) {
      const useSettingsHook = useGlobal ? window.SDPIComponents.useGlobalSettings : window.SDPIComponents.useSettings;

      const [, save] = useSettingsHook(
        settingName,
        (value: string) => {
          // Runtime may deliver number/null/undefined despite the string type
          // annotation. Treat only null/undefined/empty-string as cleared so
          // the numeric value 0 (e.g., radarVolume) doesn't fall through to
          // the default-display branch via JS truthiness.
          const v: unknown = value;
          this.currentValue = v == null || v === "" ? "" : String(v);
          this.updateDisplay();
        },
        null,
      );

      this.saveToStreamDeck = save;
    }
  }

  private clampValue(raw: string): string | null {
    const num = Number(raw);

    if (isNaN(num)) return null;

    const min = Number(this.getAttribute("min") ?? "0");
    const max = Number(this.getAttribute("max") ?? "100");
    const clamped = Math.min(Math.max(num, min), max);

    return String(clamped);
  }

  private commitNumberInput(): void {
    const raw = this.numberInput!.value.trim();

    if (raw === "") {
      // Empty input — restore display to current value
      this.updateDisplay();

      return;
    }

    const clamped = this.clampValue(raw);

    if (clamped !== null && clamped !== this.currentValue) {
      this.currentValue = clamped;
      this.updateDisplay();
      this.notifyChange();
    } else {
      // Revert display (e.g., if out-of-range value was typed but same after clamp)
      this.updateDisplay();
    }
  }

  private notifyChange(): void {
    this.saveToStreamDeck?.(this.currentValue);
    this.dispatchEvent(new Event("change", { bubbles: true }));
  }

  private updateDisplay(): void {
    if (!this.rangeInput || !this.numberInput) return;

    if (this.currentValue !== "") {
      this.rangeInput.value = this.currentValue;
      this.numberInput.value = this.currentValue;
    } else {
      // Empty/cleared state: show default or min for visual display
      const defaultValue = this.getAttribute("default") ?? this.getAttribute("min") ?? "0";
      this.rangeInput.value = defaultValue;
      this.numberInput.value = defaultValue;
    }
  }
}

// Register the custom element
if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-range-input")) {
    customElements.define("ird-range-input", RangeInput);
  }
}
