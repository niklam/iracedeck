/// <reference lib="dom" />
/**
 * Audio Device Select Web Component for Stream Deck Property Inspector
 *
 * A styled `<select>` bound to a plugin-global setting that stores the
 * selected audio output device by its stable `id` (a hex-encoded
 * `ma_device_id` from the audio-native enumeration). The empty string
 * represents System Default. Options are populated at runtime from a
 * second global setting (a JSON array of
 * `{ index: number, name: string, id: string, isDefault?: boolean }`),
 * which the plugin maintains from its audio-device enumeration.
 *
 * Usage in HTML:
 * ```html
 * <sdpi-item label="Output Device">
 *   <ird-audio-device-select
 *     setting="audioOutputDevice"
 *     devices="_audioDeviceList"
 *     default-label="System Default"
 *   ></ird-audio-device-select>
 * </sdpi-item>
 * ```
 *
 * Attributes:
 * - setting: Plugin-global setting key that stores the selected device
 *   id as a string (default: `audioOutputDevice`). The empty string
 *   means System Default.
 * - devices: Plugin-global setting key that stores the device list as a
 *   JSON array (default: `_audioDeviceList`).
 * - default-label: Label shown for the System Default option
 *   (default: `System Default`).
 *
 * The plugin populates `devices` via `updateGlobalSettings({ [devicesKey]: JSON.stringify(list) })`.
 */
import { skipUnchanged } from "./settings-change-filter.js";

let styleInjected = false;

type DeviceRecord = { index?: number; name: string; id: string; isDefault?: boolean };

const DEFAULT_SETTING = "audioOutputDevice";
const DEFAULT_DEVICE_LIST_SETTING = "_audioDeviceList";
const DEFAULT_LABEL = "System Default";

/** Sentinel value persisted for the System Default selection. */
const SYSTEM_DEFAULT_VALUE = "";

export class AudioDeviceSelect extends HTMLElement {
  private select: HTMLSelectElement | null = null;
  private savedValue = SYSTEM_DEFAULT_VALUE;
  private saveToStreamDeck: ((value: string) => void) | null = null;
  private _initialized = false;
  // Flips true on the first `devices` payload so we can tell "device list
  // not delivered yet" (common race during PI open — setting callback fires
  // before the device list does) from "device list delivered; saved id is
  // genuinely stale". Only the latter should persist the System Default
  // fallback back to the plugin.
  private devicesLoaded = false;

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
      ird-audio-device-select select {
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
      ird-audio-device-select select:focus { box-shadow: inset 0 0 1px #969696; }
      ird-audio-device-select select:disabled { opacity: 0.5; }
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

      // Native `change` on `<select>` bubbles through the host custom
      // element. Without `stopPropagation` the consumer would see two
      // events per user selection — once from the native bubble and
      // once from the host dispatch below.
      ev.stopPropagation();

      this.savedValue = this.select.value;
      this.saveToStreamDeck?.(this.savedValue);
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    const settingKey = this.getAttribute("setting") ?? DEFAULT_SETTING;
    const devicesKey = this.getAttribute("devices") ?? DEFAULT_DEVICE_LIST_SETTING;

    const [, save] = window.SDPIComponents.useGlobalSettings(
      settingKey,
      skipUnchanged((value: string) => {
        // Runtime may deliver non-string types; normalize to string so the
        // option-value comparison in applySavedValue is type-safe. Empty
        // string is the System Default sentinel, not a "missing" marker.
        const v: unknown = value;
        this.savedValue = v == null ? SYSTEM_DEFAULT_VALUE : String(v);
        this.applySavedValue();
      }),
    );
    this.saveToStreamDeck = save;

    window.SDPIComponents.useGlobalSettings(
      devicesKey,
      skipUnchanged((value: string) => {
        if (!value) return;

        try {
          const devices = JSON.parse(value) as DeviceRecord[];

          if (!Array.isArray(devices)) return;

          this.renderOptions(devices);
          this.devicesLoaded = true;
          this.applySavedValue();
        } catch {
          // ignore parse errors; dropdown keeps its prior options
        }
      }),
    );
  }

  private renderOptions(devices: DeviceRecord[]): void {
    if (!this.select) return;

    const defaultLabel = this.getAttribute("default-label") ?? DEFAULT_LABEL;

    this.select.replaceChildren();

    const systemOption = document.createElement("option");
    systemOption.value = SYSTEM_DEFAULT_VALUE;
    systemOption.textContent = defaultLabel;
    this.select.appendChild(systemOption);

    for (const device of devices) {
      // Skip records without a usable stable id. The plugin should always
      // populate id from the audio-native enumeration, but defend against
      // malformed input — and against an empty-string id colliding with
      // the System Default option.
      if (typeof device.id !== "string" || device.id === "") continue;

      const opt = document.createElement("option");
      opt.value = device.id;
      opt.textContent = `${device.name}${device.isDefault ? " (Default)" : ""}`;
      this.select.appendChild(opt);
    }
  }

  private applySavedValue(): void {
    if (!this.select) return;

    // If the persisted device id is no longer in the current option list
    // (e.g. unplugged headset, or a legacy numeric-index value from
    // pre-#427 builds), fall back to System Default so the dropdown
    // reflects what miniaudio will actually use. Native
    // `<select>.value = "<unknown>"` silently clears the selection —
    // surface that as the System Default value explicitly.
    const exists = Array.from(this.select.options).some((opt) => opt.value === this.savedValue);

    if (exists) {
      this.select.value = this.savedValue;

      return;
    }

    this.select.value = SYSTEM_DEFAULT_VALUE;

    // Only persist the fallback once the device list has actually arrived.
    // Otherwise we'd race the init sequence: the setting callback routinely
    // fires before the device-list callback, and overwriting the saved id
    // on that first apply would throw away the user's real selection.
    if (!this.devicesLoaded) return;

    // The DOM now shows System Default, but the global setting still holds
    // the stale id. Persist the fallback so every cold start doesn't retry
    // the missing device and every fresh PI load doesn't see a mismatch
    // between what the dropdown shows and what miniaudio will actually open.
    if (this.savedValue !== SYSTEM_DEFAULT_VALUE) {
      this.savedValue = SYSTEM_DEFAULT_VALUE;
      this.saveToStreamDeck?.(SYSTEM_DEFAULT_VALUE);
    }
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-audio-device-select")) {
    customElements.define("ird-audio-device-select", AudioDeviceSelect);
  }
}
