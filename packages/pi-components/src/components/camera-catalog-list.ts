/// <reference lib="dom" />
/**
 * The settings window's Camera Groups card (issue #1653): every camera group
 * name the plugin remembers, with the tracks whose latest camera list holds it
 * and when it was last seen, and a Remove per name.
 *
 * Renders the run-scoped `_cameraCatalog` global (spec decision 4) and writes
 * nothing to it: the catalog lives in `cameras.json`, and Remove sends a
 * COMMAND, `sendToPlugin {event: "cameraCatalogRemove", name}`, which the
 * settings-window command handler checks against the catalog. The row leaves
 * once the plugin republishes the view — and comes back when a track whose file
 * still has the name is loaded, because it is still in that file (decision 7).
 * Removing never touches a key's settings.
 *
 * Remove is the two-step `ird-voice-pack-list` uses: the first press arms the
 * button ("Remove — are you sure?"), the second sends; the arm lapses after
 * {@link CAMERA_CATALOG_REMOVE_ARM_MS}, when another row is armed, or when the
 * name leaves the list. The stakes are lower than a voice pack's — a removed
 * name returns on its next sighting — but a press on the wrong row of a long
 * list is easy, and the shape is the one users already know from that card.
 *
 * Settings-window only: a Property Inspector's `sendToPlugin` goes to its own
 * action, where nothing handles this command (`partials/camera-groups.ejs`).
 *
 * Every cell is `textContent`: the names come from a camera file a third party
 * wrote.
 */
import { CAMERA_CATALOG_KEY, type CameraCatalogView } from "@iracedeck/app-constants";

import { formatTrackList, parseCameraCatalog, trackNamesOf } from "./camera-groups-view.js";
import { sendToPlugin } from "./sdpi-client.js";
import { skipUnchanged } from "./settings-change-filter.js";

let styleInjected = false;

/** How long a Remove stays armed — the voice-pack list's eight seconds, for the same reasons. */
export const CAMERA_CATALOG_REMOVE_ARM_MS = 8000;

const RESTING_REMOVE_LABEL = "Remove";
const ARMED_REMOVE_LABEL = "Remove — are you sure?";

/** One row of the card. */
export interface CameraCatalogRow {
  name: string;
  /** The tracks whose latest list holds the name, sorted, de-duplicated. */
  tracks: string[];
  /** ISO time the name was last seen, or "" when the view carries none. */
  lastSeen: string;
}

/**
 * The card's rows: every remembered name, alphabetically ignoring case. A row's
 * tracks include the current session's (the card is not about "this track").
 */
export function cameraCatalogRows(catalog: CameraCatalogView | null): CameraCatalogRow[] {
  if (catalog === null) return [];

  // trackNamesOf leaves the current track out, which is the picker's need; the
  // card lists every track, so it reads them through a view without a session.
  const sessionless: CameraCatalogView = { ...catalog, current: null };

  return catalog.groups
    .map((group) => ({ name: group.name, tracks: trackNamesOf(sessionless, group), lastSeen: group.lastSeen }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (a.name < b.name ? -1 : 1));
}

/** `2026-11-08`, in the viewer's own time zone; "" for a missing or unreadable time. */
export function formatLastSeen(iso: string): string {
  if (iso.length === 0) return "";

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return "";

  const pad = (n: number): string => String(n).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class CameraCatalogList extends HTMLElement {
  private list: HTMLDivElement | null = null;
  private _initialized = false;
  /** The armed name, or null — one name, so arming another row disarms the first. */
  private armed: string | null = null;
  private armedTimer: number | null = null;
  private armedButton: HTMLButtonElement | null = null;

  connectedCallback(): void {
    if (this._initialized) return;

    this._initialized = true;

    this.injectStyle();
    this.list = document.createElement("div");
    this.appendChild(this.list);
    this.render(null);
    this.hookSettings();
  }

  disconnectedCallback(): void {
    this.clearArmedState();
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");
    style.textContent = `
      ird-camera-catalog-list { display: block; }
      ird-camera-catalog-list .ird-cc-count { color: #969696; font-size: 8pt; padding: 0 0 4px; }
      ird-camera-catalog-list .ird-cc-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 0;
        color: #d8d8d8;
        font-size: 9pt;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif;
      }
      ird-camera-catalog-list .ird-cc-row + .ird-cc-row { border-top: 1px solid #3d3d3d; }
      ird-camera-catalog-list .ird-cc-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      ird-camera-catalog-list .ird-cc-name { color: #ffffff; overflow-wrap: anywhere; }
      ird-camera-catalog-list .ird-cc-meta { color: #b4b4b4; font-size: 8pt; overflow-wrap: anywhere; }
      ird-camera-catalog-list .ird-cc-empty { color: #969696; font-size: 9pt; padding: 3px 0; }
      ird-camera-catalog-list .ird-cc-remove {
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
      ird-camera-catalog-list .ird-cc-remove:hover { color: #ffffff; border-color: #e05a5a; background: #3a2426; }
      ird-camera-catalog-list .ird-cc-remove-armed,
      ird-camera-catalog-list .ird-cc-remove-armed:hover { color: #ffffff; border-color: #e05a5a; background: #6d2a2e; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    const key = this.getAttribute("catalog") ?? CAMERA_CATALOG_KEY;

    const onCatalog = skipUnchanged((value: unknown) => this.render(parseCameraCatalog(value)));
    const [readCatalog] = window.SDPIComponents.useGlobalSettings(key, onCatalog);

    // sdpi hands a subscription only the pushes after it: one that came before
    // this element connected is not replayed (#1653 review). The hook's getter
    // returns the value sdpi already holds — a local read that sends nothing,
    // resolving once global settings first arrive — and skipUnchanged drops it
    // when a push delivered it first.
    void readCatalog().then(onCatalog);
  }

  /**
   * The button's look and accessible name for its state. The name always
   * carries the group, and the armed one the confirmation the text shows,
   * since an aria-label overrides the text (#1653 review).
   */
  private static dressButton(button: HTMLButtonElement, armed: boolean): void {
    const name = button.dataset.group ?? "";

    button.textContent = armed ? ARMED_REMOVE_LABEL : RESTING_REMOVE_LABEL;
    button.setAttribute("aria-label", armed ? `Remove ${name} — press again to confirm` : `Remove ${name}`);
    button.classList.toggle("ird-cc-remove-armed", armed);
    button.setAttribute("aria-pressed", armed ? "true" : "false");
  }

  private arm(name: string, button: HTMLButtonElement): void {
    this.clearArmedState();
    this.armed = name;
    this.armedButton = button;
    CameraCatalogList.dressButton(button, true);
    this.armedTimer = window.setTimeout(() => {
      this.armedTimer = null;
      this.clearArmedState();
    }, CAMERA_CATALOG_REMOVE_ARM_MS);
  }

  private clearArmedState(): void {
    if (this.armedTimer !== null) window.clearTimeout(this.armedTimer);

    this.armedTimer = null;
    this.armed = null;

    const button = this.armedButton;

    this.armedButton = null;

    if (button !== null) CameraCatalogList.dressButton(button, false);
  }

  private removeButton(name: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ird-cc-remove";
    // By dataset, not attribute markup: a group may be named anything.
    button.dataset.group = name;
    CameraCatalogList.dressButton(button, false);

    // A push that rebuilt the list mid-confirmation: the armed name's new button
    // is the one to dress and adopt.
    if (this.armed === name) {
      this.armedButton = button;
      CameraCatalogList.dressButton(button, true);
    }

    button.addEventListener("click", () => {
      if (this.armed === name) {
        this.clearArmedState();
        sendToPlugin({ event: "cameraCatalogRemove", name });

        return;
      }

      this.arm(name, button);
    });

    // A held Enter repeats its keydown, and each repeat clicks the button: the
    // first would arm it and a repeat confirm the removal before the key is
    // released (#1653 review). Repeats are cancelled, so confirming takes a
    // second, separate press; a pointer click is untouched.
    button.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && event.repeat) event.preventDefault();
    });

    return button;
  }

  private render(catalog: CameraCatalogView | null): void {
    if (!this.list) return;

    const rows = cameraCatalogRows(catalog);

    if (this.armed !== null && !rows.some((row) => row.name === this.armed)) this.clearArmedState();

    // A push rebuilds every row, focused Remove button included: the same
    // group's new button takes the focus back, so a keyboard user mid-confirm
    // can still press Enter (#1653 review). A group that left the list takes
    // the focus with it.
    const focusedName = this.focusedRowName();

    this.armedButton = null;
    this.list.textContent = "";

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ird-cc-empty";
      empty.textContent = "No camera groups remembered yet. They are recorded from each session iRacing reports.";
      this.list.appendChild(empty);

      return;
    }

    const count = document.createElement("div");
    count.className = "ird-cc-count";
    count.textContent = `${rows.length} remembered ${rows.length === 1 ? "group" : "groups"}`;
    this.list.appendChild(count);

    let refocus: HTMLButtonElement | null = null;

    for (const row of rows) {
      const element = document.createElement("div");
      element.className = "ird-cc-row";
      element.dataset.name = row.name;

      const text = document.createElement("div");
      text.className = "ird-cc-text";

      const name = document.createElement("span");
      name.className = "ird-cc-name";
      name.textContent = row.name;

      const meta = document.createElement("span");
      meta.className = "ird-cc-meta";

      const where = row.tracks.length > 0 ? `On ${formatTrackList(row.tracks)}` : "On no track's current camera file";
      const when = formatLastSeen(row.lastSeen);

      meta.textContent = when.length > 0 ? `${where} · last seen ${when}` : where;

      if (row.tracks.length > 3) meta.title = row.tracks.join(", ");

      text.append(name, meta);

      const remove = this.removeButton(row.name);

      if (row.name === focusedName) refocus = remove;

      element.append(text, remove);
      this.list.appendChild(element);
    }

    refocus?.focus();
  }

  /** The group whose Remove button has the focus, or null. */
  private focusedRowName(): string | null {
    const active = document.activeElement;

    if (!(active instanceof HTMLButtonElement) || !this.list?.contains(active)) return null;

    return active.closest<HTMLElement>(".ird-cc-row")?.dataset.name ?? null;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ird-camera-catalog-list")) {
  customElements.define("ird-camera-catalog-list", CameraCatalogList);
}
