/// <reference lib="dom" />
/**
 * Read-only list of the installed Race Engineer voice packs (issue #1034).
 *
 * Renders the `_voicePacks` plugin-global — a JSON array of
 * `{ id, label, version, voices }` the plugin republishes after every scan —
 * so the settings window can show what is actually on disk, and a pack that
 * was placed by hand but is not being loaded is visibly absent rather than
 * silently missing.
 *
 * Read-only on purpose: this is an observation about the run, not a setting.
 * It writes nothing back, and the key it reads is run-scoped in `deck-core`
 * (`RUN_SCOPED_SETTING_KEYS`) so it is never persisted.
 *
 * Usage:
 * ```html
 * <ird-voice-pack-list></ird-voice-pack-list>
 * <ird-voice-pack-list packs="_voicePacks"></ird-voice-pack-list>
 * ```
 */

let styleInjected = false;

const DEFAULT_PACKS_SETTING = "_voicePacks";

type VoicePackEntry = { id: string; label: string; version: string; voices: string[] };

/**
 * Accept only entries with the fields we render, and coerce nothing: a
 * malformed entry is dropped rather than displayed as `undefined`.
 */
function parseEntries(raw: string): VoicePackEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed.filter((entry): entry is VoicePackEntry => {
      if (typeof entry !== "object" || entry === null) return false;

      const candidate = entry as Record<string, unknown>;

      return (
        typeof candidate.id === "string" &&
        typeof candidate.label === "string" &&
        typeof candidate.version === "string" &&
        Array.isArray(candidate.voices)
      );
    });
  } catch {
    return [];
  }
}

export class VoicePackList extends HTMLElement {
  private list: HTMLDivElement | null = null;
  private _initialized = false;

  connectedCallback(): void {
    if (this._initialized) return;

    this._initialized = true;

    this.injectStyle();
    this.buildDOM();
    this.hookSettings();
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");
    style.textContent = `
      ird-voice-pack-list { display: block; }
      ird-voice-pack-list .ird-vp-row {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 3px 0;
        color: #d8d8d8;
        font-size: 9pt;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
      }
      ird-voice-pack-list .ird-vp-row + .ird-vp-row { border-top: 1px solid #3d3d3d; }
      ird-voice-pack-list .ird-vp-label { flex: 1; }
      ird-voice-pack-list .ird-vp-version { color: #969696; font-size: 8pt; }
      ird-voice-pack-list .ird-vp-empty { color: #969696; font-size: 9pt; padding: 3px 0; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private buildDOM(): void {
    this.list = document.createElement("div");
    this.appendChild(this.list);
    this.render([]);
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    const packsKey = this.getAttribute("packs") ?? DEFAULT_PACKS_SETTING;

    window.SDPIComponents.useGlobalSettings(packsKey, (value: string) => {
      this.render(value ? parseEntries(value) : []);
    });
  }

  /**
   * Rendered with `textContent` per cell rather than innerHTML: `label` comes
   * from a pack's own `voice-pack.json`, which on the sideload path is a file
   * some third party wrote.
   */
  private render(entries: readonly VoicePackEntry[]): void {
    if (!this.list) return;

    this.list.textContent = "";

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ird-vp-empty";
      empty.textContent = "No voice packs installed.";
      this.list.appendChild(empty);

      return;
    }

    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "ird-vp-row";

      const label = document.createElement("span");
      label.className = "ird-vp-label";
      label.textContent = entry.label;

      const version = document.createElement("span");
      version.className = "ird-vp-version";
      version.textContent = entry.version;

      row.appendChild(label);
      row.appendChild(version);
      this.list.appendChild(row);
    }
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ird-voice-pack-list")) {
  customElements.define("ird-voice-pack-list", VoicePackList);
}
