/// <reference lib="dom" />
/**
 * List of the installed Race Engineer voice packs (issue #1034), now also
 * showing where each one came from and offering a way to remove it (#1100).
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
 * It still writes nothing back to the setting it renders — `_voicePacks` is an
 * observation about the run, not a setting, and stays run-scoped in `deck-core`
 * (`RUN_SCOPED_SETTING_KEYS`) so it is never persisted. Only a RESCAN (fired by
 * the sibling `ird-voice-pack-refresh` button) changes what this list shows;
 * this component only ever reflects the next `_voicePacks` push. The one
 * addition since #1034 is that a row's Remove button sends a COMMAND
 * (`voicePackRemove`) rather than writing a setting — the removal itself
 * happens in the plugin, and the row disappears only once the next scan says
 * so, the same as it would for a pack deleted by hand and rescanned.
 *
 * PROVENANCE BADGE. Each row now names where its pack came from: downloaded
 * from iRaceDeck's own catalog, bundled with the plugin, or installed by hand.
 * This is deliberately INFORMATION, not a verdict — see the `provenance` field
 * doc on `InstalledVoicePack` in deck-core's `voice-pack-scanner.ts`: "the
 * badge tells a user that a pack came from someone other than us; it is not a
 * trust decision the plugin acts on." A user's own sideloaded pack is a
 * perfectly ordinary thing to have, so the wording says where a pack came
 * from and stops there — it never calls a sideloaded pack unsigned,
 * unverified, or anything else that reads as a warning about the user's own
 * choice. A missing or unrecognised provenance value renders as "Installed by
 * hand" (the least-trusting label) rather than dropping the row: id / label /
 * version / voices are required for a row to render AT ALL because together
 * they ARE the row, but provenance is one presentational field on top of an
 * otherwise-valid pack, and a scanner hiccup on that one field must not hide a
 * voice the user can actually play.
 *
 * REMOVE. Fires `voicePackRemove` immediately on click, with NO confirmation
 * step. That is a deliberate omission here, not an oversight: whether removal
 * needs a confirmation is an open product decision for whoever specs it, not
 * something this component should invent on its own. If one is wanted later
 * it is layered on top of this click handler.
 *
 * Usage:
 * ```html
 * <ird-voice-pack-list></ird-voice-pack-list>
 * <ird-voice-pack-list packs="_voicePacks"></ird-voice-pack-list>
 * ```
 */
import { sendToPlugin } from "./sdpi-client.js";

let styleInjected = false;

const DEFAULT_PACKS_SETTING = "_voicePacks";

/**
 * Mirrors `VoicePackProvenanceKind` in deck-core's `voice-pack-scanner.ts`.
 * Kept as a local literal union rather than an import — this package's
 * components deliberately re-declare the shapes they render instead of
 * depending on deck-core's Node-oriented package at runtime (see
 * `key-binding-input.ts` and `binding-status.ts` for the same call).
 */
const KNOWN_PROVENANCE = ["catalog", "bundled-seed", "sideload"] as const;
type VoicePackProvenance = (typeof KNOWN_PROVENANCE)[number];

/** Badge text per provenance — matches the wording on the website's voices doc. */
const PROVENANCE_LABELS: Record<VoicePackProvenance, string> = {
  catalog: "Downloaded",
  "bundled-seed": "Built-in",
  sideload: "Installed by hand",
};

/**
 * Anything other than a recognised value falls back to `sideload` — the
 * label that implies the least about a pack's origin — rather than being
 * treated as a reason to drop the whole row. See the module comment.
 */
function normalizeProvenance(value: unknown): VoicePackProvenance {
  return typeof value === "string" && (KNOWN_PROVENANCE as readonly string[]).includes(value)
    ? (value as VoicePackProvenance)
    : "sideload";
}

/** Matches `InstalledVoice` in deck-core: a voice is an id AND a name (#1034). */
type VoicePackVoice = { id: string; label: string };
type VoicePackEntry = {
  id: string;
  label: string;
  version: string;
  voices: VoicePackVoice[];
  provenance: VoicePackProvenance;
};
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
      packs: packs
        .filter((entry): entry is Record<string, unknown> & { voices: unknown[] } => {
          if (!isRecord(entry)) return false;

          return (
            typeof entry.id === "string" &&
            typeof entry.label === "string" &&
            typeof entry.version === "string" &&
            Array.isArray(entry.voices) &&
            // Checked rather than trusted: the payload is the plugin's, but the
            // LABELS inside it come from a third party's manifest, and this array
            // is what a multi-voice pack row will render from.
            entry.voices.every((v) => isRecord(v) && typeof v.id === "string" && typeof v.label === "string")
          );
        })
        // `provenance` is normalized rather than checked in the filter above:
        // a missing/unrecognised value must not drop an otherwise-valid row
        // (see the module comment), so it is defaulted here instead.
        .map((entry): VoicePackEntry => ({
          id: entry.id as string,
          label: entry.label as string,
          version: entry.version as string,
          voices: entry.voices as VoicePackVoice[],
          provenance: normalizeProvenance(entry.provenance),
        })),
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
        align-items: center;
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
      /* Provenance badge (#1100) — informational, not a warning: colours stay
         calm and distinct rather than using red/amber alarm colours anywhere. */
      ird-voice-pack-list .ird-vp-badge {
        flex: none;
        padding: 1px 6px;
        border-radius: 3px;
        font-size: 7.5pt;
        letter-spacing: 0.2px;
        white-space: nowrap;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
      }
      ird-voice-pack-list .ird-vp-badge-catalog { background: #1f3a52; color: #8ec9ff; }
      ird-voice-pack-list .ird-vp-badge-bundled-seed { background: #34343a; color: #c8c8c8; }
      ird-voice-pack-list .ird-vp-badge-sideload { background: #3a331f; color: #e0c07a; }
      ird-voice-pack-list .ird-vp-remove-button {
        flex: none;
        padding: 2px 8px;
        font-size: 8pt;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
        color: #c9c9c9;
        background: transparent;
        border: 1px solid #555;
        border-radius: 3px;
        cursor: pointer;
      }
      ird-voice-pack-list .ird-vp-remove-button:hover {
        color: #ffffff;
        border-color: #e05a5a;
        background: #3a2426;
      }
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
   * file some third party wrote. `provenance` is the one field NOT taken from
   * that file (see `voice-pack-provenance.ts`: a pack cannot declare its own
   * provenance), so its badge text is one of the three fixed labels above —
   * never rendered from pack-supplied text.
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

      const badge = document.createElement("span");
      badge.className = `ird-vp-badge ird-vp-badge-${entry.provenance}`;
      badge.textContent = PROVENANCE_LABELS[entry.provenance];

      const version = document.createElement("span");
      version.className = "ird-vp-version";
      version.textContent = entry.version;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ird-vp-remove-button";
      remove.textContent = "Remove";
      // No confirmation — see the module comment for why that is deliberate.
      remove.addEventListener("click", () => sendToPlugin({ event: "voicePackRemove", id: entry.id }));

      row.appendChild(label);
      row.appendChild(badge);
      row.appendChild(version);
      row.appendChild(remove);
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
