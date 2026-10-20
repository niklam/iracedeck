/// <reference lib="dom" />
/**
 * Hides the bundled-profile rows the chosen Stream Deck has no variant of
 * (issue #1457). Settings window only.
 *
 * The settings window's Stream Deck Profiles card names its target deck with
 * `ird-deck-device-select`, and iRaceDeck ships each profile template only for
 * some deck types. A Switch button for a template the chosen deck has no
 * variant of asks the Stream Deck app for a profile the manifest does not
 * carry, and the press does nothing visible — which is how the Stream Deck +
 * gap went unnoticed. This wrapper listens to the picker and:
 *
 * - shows a row (any child carrying `data-device-types="0,2,13"`) only when its
 *   list contains the chosen deck's type;
 * - shows the note (the child carrying `data-no-variants`) in place of the rows
 *   when the chosen deck has no variant of any template.
 *
 * With no deck chosen, or a deck whose type was not published, every row shows
 * and the note stays hidden: today's behaviour, since nothing can be judged.
 * A child with no `data-device-types` attribute is never hidden.
 *
 * Usage (rendered by `global-stream-deck-profiles.ejs`):
 * ```html
 * <ird-deck-device-select select-id="sw-deck"></ird-deck-device-select>
 * <ird-profile-variants device-from="sw-deck">
 *   <sdpi-item label="iRaceDeck Default" data-device-types="0,2,7,13">…</sdpi-item>
 *   <div class="ird-supporting-text" data-no-variants hidden>…</div>
 * </ird-profile-variants>
 * ```
 *
 * Attributes:
 * - `device-from`: the picker's `select-id`, the same value the rows'
 *   `ird-profile-switch device-from` names.
 */
import { DECK_DEVICE_CHANGE_EVENT, type DeckDeviceChangeDetail, type DeckDeviceSelect } from "./deck-device-select.js";

const ROW_SELECTOR = "[data-device-types]";
const NOTE_SELECTOR = "[data-no-variants]";

let styleInjected = false;

/**
 * The device types a row's `data-device-types` lists. Non-numeric entries are
 * dropped, so a malformed list reads as "no variant" rather than throwing.
 *
 * @internal Exported for testing
 */
export function parseDeviceTypes(value: string | null): number[] {
  if (!value) return [];

  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^\d+$/.test(part))
    .map(Number);
}

export class ProfileVariants extends HTMLElement {
  private deviceType: number | undefined = undefined;
  private _initialized = false;

  private readonly onDeviceChange = (event: Event): void => {
    const detail = (event as CustomEvent<DeckDeviceChangeDetail>).detail;

    if (!detail || detail.selectId !== this.getAttribute("device-from")) return;

    this.deviceType = detail.deviceType;
    this.apply();
  };

  private readonly onParsed = (): void => this.apply();

  connectedCallback(): void {
    if (!this._initialized) {
      this._initialized = true;
      this.injectStyle();
    }

    document.addEventListener(DECK_DEVICE_CHANGE_EVENT, this.onDeviceChange);

    // The picker may already hold a choice (it connected and was filled first).
    this.deviceType = this.readPicker();

    // During parsing this element connects before its children exist; apply
    // again once they do.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", this.onParsed, { once: true });
    }

    this.apply();
  }

  disconnectedCallback(): void {
    document.removeEventListener(DECK_DEVICE_CHANGE_EVENT, this.onDeviceChange);
    document.removeEventListener("DOMContentLoaded", this.onParsed);
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");

    style.textContent = `
      ird-profile-variants { display: block; }
      ird-profile-variants [hidden] { display: none !important; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private readPicker(): number | undefined {
    const selectId = this.getAttribute("device-from");

    if (!selectId) return undefined;

    const picker = document.getElementById(selectId)?.closest("ird-deck-device-select") as DeckDeviceSelect | null;

    return picker?.selectedDeviceType;
  }

  private apply(): void {
    const type = this.deviceType;
    let shown = 0;

    for (const row of Array.from(this.querySelectorAll<HTMLElement>(ROW_SELECTOR))) {
      const visible = type === undefined || parseDeviceTypes(row.getAttribute("data-device-types")).includes(type);

      row.hidden = !visible;

      if (visible) shown++;
    }

    const noVariants = type !== undefined && shown === 0;

    for (const note of Array.from(this.querySelectorAll<HTMLElement>(NOTE_SELECTOR))) {
      note.hidden = !noVariants;
    }
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-profile-variants")) {
    customElements.define("ird-profile-variants", ProfileVariants);
  }
}
