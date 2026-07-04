/// <reference lib="dom" />
/**
 * Profile Select dropdown for the Switch Profile action's Property Inspector.
 *
 * A `<select>` bound to a per-action setting holding the chosen profile name. The
 * options are the bundled profiles available for THIS action's device, which the
 * action computes (data/profiles.json filtered by the action's device type) and
 * pushes into a second per-action setting as a JSON string array of names. An
 * empty selection means "no profile chosen yet".
 *
 * Usage:
 * ```html
 * <sdpi-item label="Profile">
 *   <ird-profile-select setting="profile" profiles="_deviceProfiles"></ird-profile-select>
 * </sdpi-item>
 * ```
 *
 * Attributes:
 * - setting: per-action setting storing the selected profile name (default: `profile`).
 * - profiles: per-action setting holding the available profile names as a JSON
 *   string array (default: `_deviceProfiles`).
 * - placeholder: label for the empty option (default: `Select a profile…`).
 * - previous-label: when present, renders an extra "back to previous profile"
 *   option with this label, stored as the `__previous` sentinel (must match
 *   `PREVIOUS_PROFILE_VALUE` in the Switch Profile action).
 * - default: profile name displayed as selected while the setting is empty or
 *   holds a name not available on this device (issue #755). With a default
 *   there is no "nothing selected" state, so the empty placeholder option is
 *   not rendered at all — every choice does something. The default is
 *   display-only (never persisted); the action's own fallback keeps the press
 *   behavior in sync.
 */

let styleInjected = false;

const DEFAULT_SETTING = "profile";
const DEFAULT_PROFILES_SETTING = "_deviceProfiles";
const DEFAULT_PLACEHOLDER = "Select a profile…";
const EMPTY_VALUE = "";
const PREVIOUS_VALUE = "__previous";

/** Normalize a `profiles` setting value (JSON string array, or already an array) to string names. */
export function parseProfileNames(value: unknown): string[] {
  let arr: unknown = value;

  if (typeof value === "string") {
    if (!value) return [];

    try {
      arr = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(arr)) return [];

  return arr.filter((n): n is string => typeof n === "string" && n !== "");
}

export class ProfileSelect extends HTMLElement {
  private select: HTMLSelectElement | null = null;
  private savedValue = EMPTY_VALUE;
  private saveToStreamDeck: ((value: string) => void) | null = null;
  private _initialized = false;

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

    // Mirror sdpi-select's styling (same flattened stack as ird-audio-device-select).
    const style = document.createElement("style");
    style.textContent = `
      ird-profile-select select {
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
      ird-profile-select select:focus { box-shadow: inset 0 0 1px #969696; }
      ird-profile-select select:disabled { opacity: 0.5; }
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

      // Stop the native <select> change from bubbling twice through the host.
      ev.stopPropagation();

      this.savedValue = this.select.value;
      this.saveToStreamDeck?.(this.savedValue);
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    const settingKey = this.getAttribute("setting") ?? DEFAULT_SETTING;
    const profilesKey = this.getAttribute("profiles") ?? DEFAULT_PROFILES_SETTING;

    const [, save] = window.SDPIComponents.useSettings(settingKey, (value: string) => {
      const v: unknown = value;
      this.savedValue = v == null ? EMPTY_VALUE : String(v);
      this.applySavedValue();
    });
    this.saveToStreamDeck = save;

    window.SDPIComponents.useSettings(profilesKey, (value: string) => {
      this.renderOptions(parseProfileNames(value));
      this.applySavedValue();
    });
  }

  private renderOptions(names: string[]): void {
    if (!this.select) return;

    this.select.replaceChildren();

    // A dropdown with a real `default` has no "nothing selected" state, so the
    // empty placeholder option is omitted — every choice does something (#755).
    if (!this.getAttribute("default")) {
      const emptyOption = document.createElement("option");
      emptyOption.value = EMPTY_VALUE;
      emptyOption.textContent = this.getAttribute("placeholder") ?? DEFAULT_PLACEHOLDER;
      this.select.appendChild(emptyOption);
    }

    const previousLabel = this.getAttribute("previous-label");

    if (previousLabel) {
      const prevOption = document.createElement("option");
      prevOption.value = PREVIOUS_VALUE;
      prevOption.textContent = previousLabel;
      this.select.appendChild(prevOption);
    }

    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      this.select.appendChild(opt);
    }
  }

  private applySavedValue(): void {
    if (!this.select) return;

    const has = (value: string) => Array.from(this.select!.options).some((opt) => opt.value === value);

    if (has(this.savedValue) && this.savedValue !== EMPTY_VALUE) {
      this.select.value = this.savedValue;

      return;
    }

    // An empty setting — or a saved profile not among this device's options
    // (e.g. moved to a different device) — displays the `default` profile when
    // available (#755). Display-only, never persisted: the stored value stays
    // as-is (a stray name may become valid again once the profiles list for
    // this device arrives), and the action's own fallback keeps the press
    // behavior in sync. Without a default, fall back to the placeholder.
    const fallback = this.getAttribute("default");
    this.select.value = fallback && has(fallback) ? fallback : EMPTY_VALUE;
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-profile-select")) {
    customElements.define("ird-profile-select", ProfileSelect);
  }
}
