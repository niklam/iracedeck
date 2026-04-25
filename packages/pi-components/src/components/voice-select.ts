/// <reference lib="dom" />
/**
 * Race Engineer Voice Select Web Component for Stream Deck Property Inspector
 *
 * A styled `<select>` bound to a plugin-global setting that stores the
 * active Race Engineer voice key (e.g. `"luca"`, `"titan"`). Options come
 * from a second global setting (a JSON string array of voice keys) which
 * the plugin maintains by inspecting `voice/<voice>/…` paths in
 * `@iracedeck/audio-assets/manifest.json`.
 *
 * If the persisted voice isn't in the current list (e.g. a TTS regen
 * removed it), the dropdown falls back to the first available voice and
 * persists that choice.
 *
 * Usage:
 * ```html
 * <sdpi-item label="Race Engineer Voice">
 *   <ird-voice-select
 *     setting="raceEngineerVoice"
 *     voices="_raceEngineerVoices"
 *   ></ird-voice-select>
 * </sdpi-item>
 * ```
 *
 * Attributes:
 * - setting: Plugin-global setting key holding the chosen voice
 *   (default: `raceEngineerVoice`).
 * - voices: Plugin-global setting key holding the JSON array of available
 *   voice keys (default: `_raceEngineerVoices`).
 *
 * The plugin populates `voices` via `updateGlobalSettings({ [voicesKey]: JSON.stringify(list) })`.
 */

let styleInjected = false;

const DEFAULT_SETTING = "raceEngineerVoice";
const DEFAULT_VOICES_SETTING = "_raceEngineerVoices";

function titleCase(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export class VoiceSelect extends HTMLElement {
  private select: HTMLSelectElement | null = null;
  private savedValue = "";
  private saveToStreamDeck: ((value: string) => void) | null = null;
  private _initialized = false;
  // Mirror of audio-device-select's `devicesLoaded` guard: the chosen-voice
  // callback routinely fires before the voices-list callback, and
  // overwriting the saved key on that first apply would throw away the
  // user's real selection.
  private voicesLoaded = false;

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
      ird-voice-select select {
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

      // Mirror audio-device-select: stop the bubbled native event so the
      // host's own dispatch isn't seen twice by listeners.
      ev.stopPropagation();

      this.savedValue = this.select.value;
      this.saveToStreamDeck?.(this.savedValue);
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) {
      console.warn("[ird-voice-select] window.SDPIComponents missing at hook time");

      return;
    }

    const settingKey = this.getAttribute("setting") ?? DEFAULT_SETTING;
    const voicesKey = this.getAttribute("voices") ?? DEFAULT_VOICES_SETTING;

    console.log(`[ird-voice-select] hooking setting=${settingKey} voices=${voicesKey}`);

    const [, save] = window.SDPIComponents.useGlobalSettings(settingKey, (value: string) => {
      const v: unknown = value;
      console.log(`[ird-voice-select] ${settingKey} =`, v);
      this.savedValue = v == null ? "" : String(v);
      this.applySavedValue();
    });
    this.saveToStreamDeck = save;

    window.SDPIComponents.useGlobalSettings(voicesKey, (value: string) => {
      console.log(`[ird-voice-select] ${voicesKey} raw =`, value);

      if (!value) return;

      try {
        const list: unknown = JSON.parse(value);

        if (!Array.isArray(list)) {
          console.warn(`[ird-voice-select] ${voicesKey} parsed to non-array:`, list);

          return;
        }

        const voices = list.filter((v): v is string => typeof v === "string" && v.length > 0);
        console.log(`[ird-voice-select] rendering options:`, voices);

        this.renderOptions(voices);
        this.voicesLoaded = true;
        this.applySavedValue();
      } catch (err) {
        console.warn(`[ird-voice-select] failed to parse ${voicesKey}:`, err);
      }
    });
  }

  private renderOptions(voices: string[]): void {
    if (!this.select) return;

    this.select.replaceChildren();

    for (const voice of voices) {
      const opt = document.createElement("option");
      opt.value = voice;
      opt.textContent = titleCase(voice);
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

    // Saved value isn't in the list (cold start with no preference, or a
    // voice was removed). Fall back to the first available voice.
    const fallback = this.select.options[0].value;
    this.select.value = fallback;

    if (!this.voicesLoaded) return;

    if (this.savedValue !== fallback) {
      this.savedValue = fallback;
      this.saveToStreamDeck?.(fallback);
    }
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-voice-select")) {
    customElements.define("ird-voice-select", VoiceSelect);
  }
}
