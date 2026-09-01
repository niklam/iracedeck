/// <reference lib="dom" />
/**
 * Read-only list of the installed Race Engineer voice packs (issue #1034).
 *
 * Renders the `_voicePacks` plugin-global — `{ packs, problems }`, the whole
 * result of the last scan, republished by the plugin after every one — so the
 * settings window shows what is actually loaded AND why anything else was
 * ignored. A hand-placed pack that does nothing used to be merely absent here,
 * with the reason only in the plugin log; it now says what is wrong with it.
 *
 * A pack can appear in both halves: one that loads but declares a voice with no
 * clips under it is installed and still reports a problem.
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
type VoicePackProblemEntry = { pack: string; reason: string };
type VoicePackScan = { packs: VoicePackEntry[]; problems: VoicePackProblemEntry[] };

const EMPTY_SCAN: VoicePackScan = { packs: [], problems: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Accept only entries with the fields we render, and coerce nothing: a
 * malformed entry is dropped rather than displayed as `undefined`.
 */
function parseScan(raw: string): VoicePackScan {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (!isRecord(parsed)) return EMPTY_SCAN;

    const packs = Array.isArray(parsed.packs) ? parsed.packs : [];
    const problems = Array.isArray(parsed.problems) ? parsed.problems : [];

    return {
      packs: packs.filter((entry): entry is VoicePackEntry => {
        if (!isRecord(entry)) return false;

        return (
          typeof entry.id === "string" &&
          typeof entry.label === "string" &&
          typeof entry.version === "string" &&
          Array.isArray(entry.voices)
        );
      }),
      problems: problems.filter((entry): entry is VoicePackProblemEntry => {
        if (!isRecord(entry)) return false;

        return typeof entry.pack === "string" && typeof entry.reason === "string";
      }),
    };
  } catch {
    return EMPTY_SCAN;
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
      ird-voice-pack-list .ird-vp-problem {
        display: block;
        padding: 3px 0;
        color: #ffe9b8;
        font-size: 8pt;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
      }
      ird-voice-pack-list .ird-vp-row + .ird-vp-problem,
      ird-voice-pack-list .ird-vp-problem + .ird-vp-problem { border-top: 1px solid #3d3d3d; }
      ird-voice-pack-list .ird-vp-problem-pack { color: #ffffff; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private buildDOM(): void {
    this.list = document.createElement("div");
    this.appendChild(this.list);
    this.render(EMPTY_SCAN);
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    const packsKey = this.getAttribute("packs") ?? DEFAULT_PACKS_SETTING;

    window.SDPIComponents.useGlobalSettings(packsKey, (value: string) => {
      this.render(value ? parseScan(value) : EMPTY_SCAN);
    });
  }

  /**
   * Rendered with `textContent` per cell rather than innerHTML: `label` comes
   * from a pack's own `voice-pack.json`, and a problem row is built from a
   * folder name and a manifest field — on the sideload path, all of it is a
   * file some third party wrote.
   */
  private render(scan: VoicePackScan): void {
    if (!this.list) return;

    this.list.textContent = "";

    // Only when the scan found nothing at all. A directory holding one
    // unloadable pack is not empty, and calling it empty would hide the very
    // row that explains the silence.
    if (scan.packs.length === 0 && scan.problems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ird-vp-empty";
      empty.textContent = "No voice packs installed.";
      this.list.appendChild(empty);

      return;
    }

    for (const entry of scan.packs) {
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

    for (const problem of scan.problems) {
      const row = document.createElement("div");
      row.className = "ird-vp-problem";

      const pack = document.createElement("span");
      pack.className = "ird-vp-problem-pack";
      pack.textContent = problem.pack;

      row.appendChild(pack);
      row.appendChild(document.createTextNode(` — ignored: ${problem.reason}`));
      this.list.appendChild(row);
    }
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ird-voice-pack-list")) {
  customElements.define("ird-voice-pack-list", VoicePackList);
}
