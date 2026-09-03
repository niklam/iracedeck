/// <reference lib="dom" />
/**
 * Downloadable Race Engineer voice packs — the catalog half of issue #1100.
 *
 * Renders `_voicePackStatus`, `{ catalog, installs }` (see `voice-pack-status.ts`
 * in `@iracedeck/deck-core` for the authoritative shapes; this file re-declares
 * them locally rather than importing, the same call `voice-pack-list.ts` makes
 * for the same reason — see its module comment).
 *
 * ONE ROW PER CATALOG ENTRY, ALWAYS. `catalog.packs` already carries every
 * published pack with a verdict computed by the plugin (`install` / `update` /
 * `installed` / `unsupported`) — this component never filters that array. An
 * `unsupported` pack in particular MUST stay visible with an explanation
 * rather than disappear, so a user on an older build learns their pack exists
 * and why they cannot have it yet, instead of the catalog looking like it
 * forgot about it.
 *
 * UNKNOWN CATALOG STATE IS RENDERED, NOT SILENT. This is a deliberate
 * departure from `ird-update-notice`, the closest sibling component in this
 * package: that one renders nothing at all when its network check fails,
 * because its content is optional decoration on a pane that is already
 * complete without it. This component IS the pane's answer to "what could I
 * download?", so silence here reads as "there is nothing" rather than as "we
 * could not check" — exactly the wrong message when the truth is the latter
 * (see the website's `race-engineer-voices.md`: "iRaceDeck just has nothing
 * new to offer until it can check again" is the honest framing, and it only
 * reads as honest if it is actually SAID).
 *
 * PROGRESS OUTRANKS VERDICT. Whenever `installs[id]` holds a record — in
 * flight or failed — that record decides what the row shows, regardless of
 * what the verdict says. The verdict is a snapshot from the last catalog
 * fetch and does not know an install is running; an in-flight download for a
 * pack whose verdict still reads "install" must not show an Install button a
 * second click would race against.
 *
 * PER-ROW COMMANDS, BUILT DIRECTLY RATHER THAN THROUGH THE SHARED BUTTON
 * FACTORY. `defineSendToPluginButton` (`send-to-plugin-button.ts`) fixes its
 * `sendToPlugin` payload at DEFINITION time — one tag, one payload, built for
 * a page's single static command (`ird-open-settings`, `ird-open-folder`).
 * This component needs N buttons for N catalog entries, each with a
 * different pack id, re-rendered on every `_voicePackStatus` push — turning
 * that into N custom-element TAGS (or a payload-function extension point on
 * the factory that only this one caller would ever use) buys nothing over
 * building the buttons as part of this list, which is exactly how
 * `voice-pack-list.ts` already builds its own per-row Remove button. The
 * factory stays reserved for genuinely static, single-instance buttons.
 *
 * Every untrusted string is rendered with `.textContent`: a pack's `label`,
 * `description` and an install's `error` all originate on iRaceDeck's own
 * server or its own install pipeline, not from this page, but the same
 * discipline `voice-pack-list.ts` applies to a sideloaded pack's manifest
 * fields is cheap enough to apply everywhere and never worth re-litigating
 * per source.
 *
 * Usage:
 * ```html
 * <ird-voice-pack-catalog></ird-voice-pack-catalog>
 * <ird-voice-pack-catalog status="_voicePackStatus"></ird-voice-pack-catalog>
 * ```
 */
import { sendToPlugin } from "./sdpi-client.js";

let styleInjected = false;

const DEFAULT_STATUS_SETTING = "_voicePackStatus";

/** Mirrors `VoicePackOfferVerdict` in deck-core's `voice-pack-status.ts`. */
const KNOWN_VERDICTS = ["install", "update", "installed", "unsupported"] as const;
type VoicePackOfferVerdict = (typeof KNOWN_VERDICTS)[number];

function isVerdict(value: unknown): value is VoicePackOfferVerdict {
  return typeof value === "string" && (KNOWN_VERDICTS as readonly string[]).includes(value);
}

/** Mirrors `VoicePackInstallPhase` in deck-core's `voice-pack-status.ts`. */
const KNOWN_PHASES = ["downloading", "verifying", "extracting", "swapping", "failed"] as const;
type VoicePackInstallPhase = (typeof KNOWN_PHASES)[number];

function isPhase(value: unknown): value is VoicePackInstallPhase {
  return typeof value === "string" && (KNOWN_PHASES as readonly string[]).includes(value);
}

type VoicePackOffer = {
  id: string;
  label: string;
  version: string;
  description?: string;
  bytes: number;
  verdict: VoicePackOfferVerdict;
  minPluginVersion?: string;
};

type VoicePackInstallState = {
  phase: VoicePackInstallPhase;
  receivedBytes?: number;
  totalBytes?: number;
  error?: string;
};

type VoicePackCatalogState = { state: "unknown" } | { state: "ok"; packs: VoicePackOffer[] };

type VoicePackStatus = {
  catalog: VoicePackCatalogState;
  installs: Record<string, VoicePackInstallState>;
};

const EMPTY_STATUS: VoicePackStatus = { catalog: { state: "unknown" }, installs: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A malformed catalog entry is dropped rather than rendered with `undefined` fields. */
function parseOffer(value: unknown): VoicePackOffer | undefined {
  if (!isRecord(value)) return undefined;

  if (
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    typeof value.version !== "string" ||
    typeof value.bytes !== "number" ||
    !isVerdict(value.verdict)
  ) {
    return undefined;
  }

  const offer: VoicePackOffer = {
    id: value.id,
    label: value.label,
    version: value.version,
    bytes: value.bytes,
    verdict: value.verdict,
  };

  if (typeof value.description === "string") offer.description = value.description;

  if (typeof value.minPluginVersion === "string") offer.minPluginVersion = value.minPluginVersion;

  return offer;
}

/**
 * A malformed install record is dropped — not defaulted — because there is no
 * safe fallback phase the way `sideload` is a safe fallback provenance: any
 * phase this component invents would claim a specific stage of an install
 * that may not be happening at all.
 */
function parseInstall(value: unknown): VoicePackInstallState | undefined {
  if (!isRecord(value) || !isPhase(value.phase)) return undefined;

  const install: VoicePackInstallState = { phase: value.phase };

  if (typeof value.receivedBytes === "number") install.receivedBytes = value.receivedBytes;

  if (typeof value.totalBytes === "number") install.totalBytes = value.totalBytes;

  if (typeof value.error === "string") install.error = value.error;

  return install;
}

function parseStatus(raw: string): VoicePackStatus {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (!isRecord(parsed)) return EMPTY_STATUS;

    let catalog: VoicePackCatalogState = { state: "unknown" };
    const catalogRaw = parsed.catalog;

    if (isRecord(catalogRaw) && catalogRaw.state === "ok" && Array.isArray(catalogRaw.packs)) {
      const packs = catalogRaw.packs.map(parseOffer).filter((offer): offer is VoicePackOffer => offer !== undefined);

      catalog = { state: "ok", packs };
    }

    const installs: Record<string, VoicePackInstallState> = {};
    const installsRaw = parsed.installs;

    if (isRecord(installsRaw)) {
      for (const [id, value] of Object.entries(installsRaw)) {
        const install = parseInstall(value);

        if (install) installs[id] = install;
      }
    }

    return { catalog, installs };
  } catch {
    return EMPTY_STATUS;
  }
}

/**
 * A single value, e.g. "12.5 MB" — used for an offer's size before install
 * starts.
 *
 * DECIMAL megabytes, not mebibytes. Dividing by 1024 and writing "MB" is the
 * commoner habit, but this number is a download size, and every other place a
 * user meets it — the browser that would fetch it, the release page hosting it,
 * and iRaceDeck's own release notes — quotes downloads in decimal. Being
 * internally consistent matters more here than matching the habit: the same
 * archive reading "7.5 MB" here and "about 8 MB" in the changelog is a
 * discrepancy a reader has no way to resolve.
 */
function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000;

  if (mb >= 1) return `${mb.toFixed(1)} MB`;

  const kb = Math.max(1, Math.round(bytes / 1000));

  return `${kb} KB`;
}

/**
 * A received/total pair sharing ONE unit, e.g. "4.2 / 12.5 MB" — chosen from
 * the TOTAL so the two numbers in the pair are never in different units (a
 * "4200 KB / 12.5 MB" pairing would be technically correct and unreadable).
 */
function formatProgress(receivedBytes: number, totalBytes: number): string {
  const useMb = totalBytes >= 1_000_000;
  const divisor = useMb ? 1_000_000 : 1000;
  const format = (n: number) => (useMb ? (n / divisor).toFixed(1) : String(Math.round(n / divisor)));

  return `${format(receivedBytes)} / ${format(totalBytes)} ${useMb ? "MB" : "KB"}`;
}

/** User-facing phase words — the plugin's enum values are implementation vocabulary. */
const PHASE_LABELS: Record<Exclude<VoicePackInstallPhase, "failed">, string> = {
  downloading: "Downloading…",
  verifying: "Verifying…",
  extracting: "Extracting…",
  swapping: "Installing…",
};

export class VoicePackCatalog extends HTMLElement {
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
      ird-voice-pack-catalog { display: block; }
      ird-voice-pack-catalog .ird-vpc-message {
        color: #969696;
        font-size: 9pt;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
        padding: 3px 0;
      }
      ird-voice-pack-catalog .ird-vpc-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px 10px;
        padding: 5px 0;
        color: #d8d8d8;
        font-size: 9pt;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
      }
      ird-voice-pack-catalog .ird-vpc-row + .ird-vpc-row { border-top: 1px solid #3d3d3d; }
      ird-voice-pack-catalog .ird-vpc-info { display: flex; align-items: baseline; gap: 8px; flex: 1; min-width: 140px; }
      ird-voice-pack-catalog .ird-vpc-label { font-weight: 600; }
      ird-voice-pack-catalog .ird-vpc-version { color: #969696; font-size: 8pt; }
      ird-voice-pack-catalog .ird-vpc-description {
        flex-basis: 100%;
        color: #a8a8a8;
        font-size: 8pt;
        padding-right: 8px;
      }
      ird-voice-pack-catalog .ird-vpc-action {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: none;
        margin-left: auto;
      }
      ird-voice-pack-catalog .ird-vpc-size { color: #969696; font-size: 8pt; white-space: nowrap; }
      ird-voice-pack-catalog .ird-vpc-installed { color: #7cc47f; font-size: 8pt; white-space: nowrap; }
      ird-voice-pack-catalog .ird-vpc-unsupported {
        color: #e0c07a;
        font-size: 8pt;
        white-space: nowrap;
        max-width: 220px;
        text-align: right;
      }
      ird-voice-pack-catalog .ird-vpc-phase { color: #8ec9ff; font-size: 8pt; white-space: nowrap; }
      ird-voice-pack-catalog .ird-vpc-progress { color: #969696; font-size: 8pt; white-space: nowrap; }
      ird-voice-pack-catalog .ird-vpc-error {
        color: #ff9b9b;
        font-size: 8pt;
        max-width: 220px;
        text-align: right;
      }
      ird-voice-pack-catalog .ird-vpc-button {
        flex: none;
        padding: 3px 10px;
        font-size: 8pt;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
        font-weight: 600;
        color: #ffffff;
        background: #ce2128;
        border: 1px solid #ce2128;
        border-radius: 3px;
        cursor: pointer;
        white-space: nowrap;
      }
      ird-voice-pack-catalog .ird-vpc-button:hover { background: #3a2426; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private buildDOM(): void {
    this.list = document.createElement("div");
    this.appendChild(this.list);
    this.render(EMPTY_STATUS);
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    const statusKey = this.getAttribute("status") ?? DEFAULT_STATUS_SETTING;

    window.SDPIComponents.useGlobalSettings(statusKey, (value: string) => {
      this.render(value ? parseStatus(value) : EMPTY_STATUS);
    });
  }

  private render(status: VoicePackStatus): void {
    if (!this.list) return;

    this.list.textContent = "";

    if (status.catalog.state === "unknown") {
      const message = document.createElement("div");

      message.className = "ird-vpc-message";
      // Says we could not check, rather than showing an empty list that would
      // read as "iRaceDeck has nothing to offer" — see the module comment.
      message.textContent = "Couldn't check for downloadable voice packs. Installed voices are unaffected.";
      this.list.appendChild(message);

      return;
    }

    if (status.catalog.packs.length === 0) {
      const message = document.createElement("div");

      message.className = "ird-vpc-message";
      message.textContent = "No downloadable voice packs right now.";
      this.list.appendChild(message);

      return;
    }

    for (const offer of status.catalog.packs) {
      this.list.appendChild(this.renderRow(offer, status.installs[offer.id]));
    }
  }

  private renderRow(offer: VoicePackOffer, install: VoicePackInstallState | undefined): HTMLElement {
    const row = document.createElement("div");
    row.className = "ird-vpc-row";

    const info = document.createElement("div");
    info.className = "ird-vpc-info";

    const label = document.createElement("span");
    label.className = "ird-vpc-label";
    label.textContent = offer.label;
    info.appendChild(label);

    const version = document.createElement("span");
    version.className = "ird-vpc-version";
    version.textContent = offer.version;
    info.appendChild(version);

    row.appendChild(info);

    if (offer.description) {
      const description = document.createElement("div");

      description.className = "ird-vpc-description";
      description.textContent = offer.description;
      row.appendChild(description);
    }

    row.appendChild(this.renderAction(offer, install));

    return row;
  }

  /**
   * The right-hand side of a row: either the live install/failure state, or —
   * with nothing in flight — whatever the verdict says pressing a button
   * would do. See the module comment for why progress always wins the choice
   * between the two.
   */
  private renderAction(offer: VoicePackOffer, install: VoicePackInstallState | undefined): HTMLElement {
    const action = document.createElement("div");
    action.className = "ird-vpc-action";

    if (install) {
      if (install.phase === "failed") {
        const error = document.createElement("span");

        error.className = "ird-vpc-error";
        error.textContent = install.error && install.error.length > 0 ? install.error : "Install failed.";
        action.appendChild(error);
        action.appendChild(this.renderButton("Retry", offer.id));

        return action;
      }

      const phase = document.createElement("span");

      phase.className = "ird-vpc-phase";
      phase.textContent = PHASE_LABELS[install.phase];
      action.appendChild(phase);

      if (typeof install.receivedBytes === "number" && typeof install.totalBytes === "number") {
        const progress = document.createElement("span");

        progress.className = "ird-vpc-progress";
        progress.textContent = formatProgress(install.receivedBytes, install.totalBytes);
        action.appendChild(progress);
      }

      return action;
    }

    switch (offer.verdict) {
      case "install":
      case "update": {
        const size = document.createElement("span");

        size.className = "ird-vpc-size";
        size.textContent = formatBytes(offer.bytes);
        action.appendChild(size);
        action.appendChild(this.renderButton(offer.verdict === "install" ? "Install" : "Update", offer.id));

        return action;
      }

      case "installed": {
        const installed = document.createElement("span");

        installed.className = "ird-vpc-installed";
        installed.textContent = "Installed";
        action.appendChild(installed);

        return action;
      }

      case "unsupported": {
        const unsupported = document.createElement("span");

        unsupported.className = "ird-vpc-unsupported";
        unsupported.textContent = offer.minPluginVersion
          ? `Needs iRaceDeck ${offer.minPluginVersion} or newer.`
          : "Needs a newer version of iRaceDeck.";
        action.appendChild(unsupported);

        return action;
      }
    }
  }

  /** Install / Update / Retry all fire the same command — see `voice-pack-catalog-service.ts`: an update is just an install onto a pack that is already there. */
  private renderButton(text: string, id: string): HTMLButtonElement {
    const button = document.createElement("button");

    button.type = "button";
    button.className = "ird-vpc-button";
    button.textContent = text;
    button.addEventListener("click", () => sendToPlugin({ event: "voicePackInstall", id }));

    return button;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ird-voice-pack-catalog")) {
  customElements.define("ird-voice-pack-catalog", VoicePackCatalog);
}
