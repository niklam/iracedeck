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

    // Mirror sdpi-select's full styling stack so the dropdown looks identical
    // to native `<sdpi-select>` siblings. sdpi-components scopes its rules
    // through three layers in shadow DOM that we have to flatten here:
    //   1. Base input reset on `button, input, select, textarea` —
    //      `box-sizing: border-box; outline: 0; border: none; border-radius: 0;`
    //      plus min-width / max-width 100% and the input font / colour.
    //      Without these, the browser's default rounded border draws around
    //      our `<select>` and it looks nothing like Mode.
    //   2. Common input rule: `height: 30px` (--input-height).
    //   3. The leaf select rule: background-color, padding, text-overflow,
    //      focus shadow, disabled opacity.
    // CSS variables from sdpi's `:host` block don't propagate into the light
    // DOM, so the resolved values are inlined.
    const style = document.createElement("style");
    style.textContent = `
      ird-voice-select select {
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
      ird-voice-select select:focus { box-shadow: inset 0 0 1px #969696; }
      ird-voice-select select:disabled { opacity: 0.5; }
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
    if (!window.SDPIComponents) return;

    const settingKey = this.getAttribute("setting") ?? DEFAULT_SETTING;
    const voicesKey = this.getAttribute("voices") ?? DEFAULT_VOICES_SETTING;

    const [, save] = window.SDPIComponents.useGlobalSettings(settingKey, (value: string) => {
      const v: unknown = value;
      this.savedValue = v == null ? "" : String(v);
      this.applySavedValue();
    });
    this.saveToStreamDeck = save;

    window.SDPIComponents.useGlobalSettings(voicesKey, (value: string) => {
      if (!value) return;

      try {
        const list: unknown = JSON.parse(value);

        if (!Array.isArray(list)) return;

        const voices = list.filter((v): v is string => typeof v === "string" && v.length > 0);

        this.renderOptions(voices);
        this.voicesLoaded = true;
        this.applySavedValue();
      } catch {
        // ignore parse errors; dropdown keeps prior options
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

    // Saved value isn't in the list (cold start with no preference, or a voice
    // was removed). Show the fallback either way.
    const fallback = this.resolveFallback();
    this.select.value = fallback;

    if (!this.voicesLoaded) return;

    // But only PERSIST it when there was no choice to lose. Since #1034 this
    // list is a function of what is on disk at scan time, so a saved voice can
    // leave it for reasons the user neither intended nor caused: a pack folder
    // momentarily locked by a sync client or AV scanner is reported as a problem
    // while the scan itself SUCCEEDS, which shrinks the list. Writing the
    // fallback then overwrites their choice permanently — one press of Rescan,
    // and putting the pack back does not bring it back.
    //
    // The plugin already resolves this the read-only way — its
    // `resolveActiveRaceEngineerVoice` applies the same preference order and
    // never writes — so what plays is right regardless. Leaving the setting
    // alone keeps the two in agreement and restores the user's voice for free
    // when the pack returns — and `plugin.ts` states this same policy in as many
    // words for a stale audio device: "We do NOT rewrite the persisted setting".
    if (this.savedValue === "") {
      this.savedValue = fallback;
      this.saveToStreamDeck?.(fallback);
    }
  }

  /**
   * The `default` attribute's voice when the list has it, otherwise the first
   * entry — the same order `resolveActiveRaceEngineerVoice` applies in the
   * plugin, so the dropdown and what actually plays never disagree.
   *
   * The anchor is why an installed pack cannot become somebody's engineer just
   * by sorting first (issue #1034); without it, both halves fell to
   * `options[0]`, which a pack named `aria` wins.
   */
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
  if (!customElements.get("ird-voice-select")) {
    customElements.define("ird-voice-select", VoiceSelect);
  }
}
