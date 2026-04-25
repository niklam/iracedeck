/// <reference lib="dom" />
/**
 * Driver Name Select Web Component for Stream Deck Property Inspector
 *
 * A `<select>` bound to a plugin-global setting that stores the driver
 * name the engineer addresses the user as (e.g. `"niklas"`, `"oivindl"`).
 * Options come from a second global setting (a JSON string array of name
 * keys) which the plugin maintains by inspecting `voice/<voice>/names/…`
 * paths in `@iracedeck/audio-assets/manifest.json`.
 *
 * Falls back to the first available name when the persisted value is
 * gone (e.g. a TTS regen removed it) and persists the fallback so
 * dropdown and setting stay in sync.
 *
 * Usage:
 * ```html
 * <sdpi-item label="Your Name">
 *   <ird-name-select
 *     setting="driverName"
 *     names="_driverNames"
 *   ></ird-name-select>
 * </sdpi-item>
 * ```
 *
 * Attributes:
 * - setting: Plugin-global setting key holding the chosen name
 *   (default: `driverName`).
 * - names: Plugin-global setting key holding the JSON array of
 *   available name keys (default: `_driverNames`).
 *
 * The plugin populates `names` via
 * `updateGlobalSettings({ [namesKey]: JSON.stringify(list) })`.
 */

let styleInjected = false;

const DEFAULT_SETTING = "driverName";
const DEFAULT_NAMES_SETTING = "_driverNames";

function titleCase(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export class NameSelect extends HTMLElement {
  private select: HTMLSelectElement | null = null;
  private savedValue = "";
  private saveToStreamDeck: ((value: string) => void) | null = null;
  private _initialized = false;
  // Mirror of voice-select / audio-device-select: the chosen-name callback
  // routinely fires before the names-list callback, and overwriting the
  // saved key on that first apply would throw away the user's real
  // selection.
  private namesLoaded = false;

  connectedCallback(): void {
    if (this._initialized) return;

    this._initialized = true;

    this.injectStyle();
    this.buildDOM();
    this.attachListeners();
    this.hookSettings();
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");
    style.textContent = `ird-name-select select { width: 100%; }`;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private buildDOM(): void {
    this.select = document.createElement("select");
    this.renderOptions([]);
    this.appendChild(this.select);
  }

  private attachListeners(): void {
    this.select?.addEventListener("change", (ev: Event) => {
      if (!this.select) return;

      ev.stopPropagation();

      this.savedValue = this.select.value;
      this.saveToStreamDeck?.(this.savedValue);
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    const settingKey = this.getAttribute("setting") ?? DEFAULT_SETTING;
    const namesKey = this.getAttribute("names") ?? DEFAULT_NAMES_SETTING;

    const [, save] = window.SDPIComponents.useGlobalSettings(settingKey, (value: string) => {
      const v: unknown = value;
      this.savedValue = v == null ? "" : String(v);
      this.applySavedValue();
    });
    this.saveToStreamDeck = save;

    window.SDPIComponents.useGlobalSettings(namesKey, (value: string) => {
      if (!value) return;

      try {
        const list: unknown = JSON.parse(value);

        if (!Array.isArray(list)) return;

        const names = list.filter((v): v is string => typeof v === "string" && v.length > 0);

        this.renderOptions(names);
        this.namesLoaded = true;
        this.applySavedValue();
      } catch {
        // ignore parse errors; dropdown keeps prior options
      }
    });
  }

  private renderOptions(names: string[]): void {
    if (!this.select) return;

    this.select.replaceChildren();

    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = titleCase(name);
      this.select.appendChild(opt);
    }
  }

  private applySavedValue(): void {
    if (!this.select || this.select.options.length === 0) return;

    const exists = Array.from(this.select.options).some((opt) => opt.value === this.savedValue);

    if (exists) {
      this.select.value = this.savedValue;

      return;
    }

    const fallback = this.select.options[0].value;
    this.select.value = fallback;

    if (!this.namesLoaded) return;

    if (this.savedValue !== fallback) {
      this.savedValue = fallback;
      this.saveToStreamDeck?.(fallback);
    }
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-name-select")) {
    customElements.define("ird-name-select", NameSelect);
  }
}
