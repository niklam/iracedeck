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
 * - default: Preferred fallback name when the persisted value is empty
 *   or missing from the available list. Used in place of the
 *   alphabetically-first option when present in the list. Optional.
 *
 * The plugin populates `names` via
 * `updateGlobalSettings({ [namesKey]: JSON.stringify(list) })`.
 */
import { skipUnchanged } from "./settings-change-filter.js";

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

    // Mirror sdpi-select's full styling stack — see voice-select.ts for the
    // explanation of why we flatten the three layers and inline the
    // resolved CSS-variable values.
    const style = document.createElement("style");
    style.textContent = `
      ird-name-select select {
        box-sizing: border-box;
        outline: 0;
        border: none;
        border-radius: 0;
        min-width: 100%;
        max-width: 100%;
        color: #d8d8d8;
        font-size: 9pt;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif,
                     "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
        height: 30px;
        background-color: #3d3d3d;
        padding: 6px 0;
        text-overflow: ellipsis;
        width: 100%;
      }
      ird-name-select select:focus { box-shadow: inset 0 0 1px #969696; }
      ird-name-select select:disabled { opacity: 0.5; }
    `;
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

    const [, save] = window.SDPIComponents.useGlobalSettings(
      settingKey,
      skipUnchanged((value: string) => {
        const v: unknown = value;
        this.savedValue = v == null ? "" : String(v);
        this.applySavedValue();
      }),
    );
    this.saveToStreamDeck = save;

    window.SDPIComponents.useGlobalSettings(
      namesKey,
      skipUnchanged((value: string) => {
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
      }),
    );
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

    const fallback = this.resolveFallback();
    this.select.value = fallback;

    if (!this.namesLoaded) return;

    // Persist the fallback only when there was no choice to lose — see the same
    // rule, and the reasoning behind it, in `voice-select.ts`. Since #1034 this
    // list is derived from the installed voice packs too, so a name can leave it
    // because a pack folder was briefly unreadable, and writing over the user's
    // choice at that moment would be permanent.
    if (this.savedValue === "") {
      this.savedValue = fallback;
      this.saveToStreamDeck?.(fallback);
    }
  }

  private resolveFallback(): string {
    if (!this.select) return "";

    const preferred = this.getAttribute("default") ?? "";

    if (preferred.length > 0) {
      const match = Array.from(this.select.options).find((opt) => opt.value === preferred);

      if (match) return match.value;
    }

    return this.select.options[0].value;
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-name-select")) {
    customElements.define("ird-name-select", NameSelect);
  }
}
