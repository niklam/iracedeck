/// <reference lib="dom" />
/**
 * Audio Device Select Web Component for Stream Deck Property Inspector
 *
 * A styled `<select>` bound to a plugin-global setting that stores the
 * selected audio output device index as a string (e.g. `"-1"` for
 * System Default, or the string form of a miniaudio device index).
 * Options are populated at runtime from a second global setting
 * (a JSON array of `{ index: number, name: string, isDefault?: boolean }`),
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
 *   index as a string (default: `audioOutputDevice`).
 * - devices: Plugin-global setting key that stores the device list as a
 *   JSON array (default: `_audioDeviceList`).
 * - default-label: Label shown for the `-1` (System Default) option
 *   (default: `System Default`).
 *
 * The plugin populates `devices` via `updateGlobalSettings({ [devicesKey]: JSON.stringify(list) })`.
 */

let styleInjected = false;

type DeviceRecord = { index: number; name: string; isDefault?: boolean };

const DEFAULT_SETTING = "audioOutputDevice";
const DEFAULT_DEVICE_LIST_SETTING = "_audioDeviceList";
const DEFAULT_LABEL = "System Default";

export class AudioDeviceSelect extends HTMLElement {
  private select: HTMLSelectElement | null = null;
  private savedValue = "-1";
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

    const style = document.createElement("style");
    style.textContent = `
      ird-audio-device-select select {
        width: 100%;
        padding: 4px;
        background: #2a2a2a;
        color: #c8c8c8;
        border: 1px solid #555;
        border-radius: 4px;
      }
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

    const [, save] = window.SDPIComponents.useGlobalSettings(settingKey, (value: string) => {
      this.savedValue = value !== null && value !== undefined && value !== "" ? String(value) : "-1";
      this.applySavedValue();
    });
    this.saveToStreamDeck = save;

    window.SDPIComponents.useGlobalSettings(devicesKey, (value: string) => {
      if (!value) return;

      try {
        const devices = JSON.parse(value) as DeviceRecord[];

        if (!Array.isArray(devices)) return;

        this.renderOptions(devices);
        this.applySavedValue();
      } catch {
        // ignore parse errors; dropdown keeps its prior options
      }
    });
  }

  private renderOptions(devices: DeviceRecord[]): void {
    if (!this.select) return;

    const defaultLabel = this.getAttribute("default-label") ?? DEFAULT_LABEL;

    this.select.innerHTML = "";

    const systemOption = document.createElement("option");
    systemOption.value = "-1";
    systemOption.textContent = defaultLabel;
    this.select.appendChild(systemOption);

    for (const device of devices) {
      const opt = document.createElement("option");
      opt.value = String(device.index);
      opt.textContent = `${device.name}${device.isDefault ? " (Default)" : ""}`;
      this.select.appendChild(opt);
    }
  }

  private applySavedValue(): void {
    if (!this.select) return;

    // If the persisted device index is no longer in the current option
    // list (e.g. the selected device was unplugged), fall back to
    // System Default so the dropdown reflects what miniaudio will
    // actually use. Native `<select>.value = "<unknown>"` silently
    // clears the selection — surface that as "-1" explicitly.
    const exists = Array.from(this.select.options).some((opt) => opt.value === this.savedValue);
    this.select.value = exists ? this.savedValue : "-1";
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-audio-device-select")) {
    customElements.define("ird-audio-device-select", AudioDeviceSelect);
  }
}
