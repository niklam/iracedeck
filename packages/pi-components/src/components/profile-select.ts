/// <reference lib="dom" />
/**
 * Profile Select dropdown for the Switch Profile action's Property Inspector.
 *
 * A `<select>` bound to a per-action setting holding the chosen profile's
 * manifest name. The options are the bundled profiles available for THIS
 * action's device, which the action computes (data/profiles.json filtered by
 * the action's device type) and pushes into a second per-action setting as
 * `{ name, label }` entries — the device-suffixed manifest name plus the clean
 * display label, so the dropdown never shows device suffixes (#753). Legacy
 * pre-#753 pushes were plain string arrays; those still render (name as
 * label). An empty selection means "no profile chosen yet".
 *
 * Usage:
 * ```html
 * <sdpi-item label="Profile">
 *   <ird-profile-select setting="profile" profiles="_deviceProfiles"></ird-profile-select>
 * </sdpi-item>
 * ```
 *
 * Attributes:
 * - setting: per-action setting storing the selected profile's manifest name
 *   (default: `profile`).
 * - profiles: per-action setting holding the available profile entries as JSON
 *   (default: `_deviceProfiles`).
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
 *
 * Saved values and the `default` attribute are matched against option VALUES
 * first and option LABELS second — so a legacy persisted display name (or a
 * display-name `default` like `iRaceDeck Default`) selects its device-suffixed
 * option without being re-persisted; the action's press-time resolution keeps
 * the behavior in sync (#753).
 */

let styleInjected = false;

const DEFAULT_SETTING = "profile";
const DEFAULT_PROFILES_SETTING = "_deviceProfiles";
const DEFAULT_PLACEHOLDER = "Select a profile…";
const EMPTY_VALUE = "";
const PREVIOUS_VALUE = "__previous";

/** A dropdown option: the profile's manifest name plus its display label (#753). */
export interface ProfileEntry {
  name: string;
  label: string;
}

/**
 * Normalize a `profiles` setting value (JSON string, or already an array) to
 * `{ name, label }` entries. Accepts the #753 entry objects and the legacy
 * plain-string shape (name doubles as the label); anything else is dropped.
 */
export function parseProfileEntries(value: unknown): ProfileEntry[] {
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

  const entries: ProfileEntry[] = [];

  for (const item of arr) {
    if (typeof item === "string") {
      if (item) entries.push({ name: item, label: item });
    } else if (typeof item === "object" && item !== null) {
      const { name, label } = item as Record<string, unknown>;

      if (typeof name === "string" && name) {
        entries.push({ name, label: typeof label === "string" && label ? label : name });
      }
    }
  }

  return entries;
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
      this.renderOptions(parseProfileEntries(value));
      this.applySavedValue();
    });
  }

  private renderOptions(entries: ProfileEntry[]): void {
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

    for (const entry of entries) {
      const opt = document.createElement("option");
      opt.value = entry.name;
      opt.textContent = entry.label;
      this.select.appendChild(opt);
    }
  }

  /**
   * The option value matching `name` — by value first, then by display label
   * (a legacy persisted display name, or a display-name `default`, selects its
   * device-suffixed option, #753). The empty placeholder option never matches.
   */
  private optionValueFor(name: string): string | undefined {
    const options = Array.from(this.select?.options ?? []);
    const byValue = options.find((opt) => opt.value !== EMPTY_VALUE && opt.value === name);

    return (byValue ?? options.find((opt) => opt.value !== EMPTY_VALUE && opt.textContent === name))?.value;
  }

  private applySavedValue(): void {
    if (!this.select) return;

    if (this.savedValue !== EMPTY_VALUE) {
      const match = this.optionValueFor(this.savedValue);

      if (match !== undefined) {
        this.select.value = match;

        return;
      }
    }

    // An empty setting — or a saved profile not among this device's options
    // (e.g. moved to a different device) — displays the `default` profile when
    // available (#755). Display-only, never persisted: the stored value stays
    // as-is (a stray name may become valid again once the profiles list for
    // this device arrives), and the action's own fallback keeps the press
    // behavior in sync. Without a default, fall back to the placeholder.
    const fallback = this.getAttribute("default");
    this.select.value = (fallback ? this.optionValueFor(fallback) : undefined) ?? EMPTY_VALUE;
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-profile-select")) {
    customElements.define("ird-profile-select", ProfileSelect);
  }
}
