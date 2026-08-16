/// <reference lib="dom" />
/**
 * Deck device picker for the settings window (issue #992).
 *
 * A `<select>` populated from the `_deckDevices` plugin-global setting — a
 * JSON array of `{ id, name, type }` the Elgato plugin publishes for the
 * connected Stream Decks (the same pattern as `_audioDeviceList`). The choice
 * is page-local UI state, NOT a persisted setting: it only tells the
 * "Stream Deck Profiles" buttons on the same page which deck to switch.
 * `ird-profile-switch device-from="<select-id>"` reads it at click time.
 *
 * Why it exists at all: in a Property Inspector the adapter resolves the
 * device from the PI's own context, but the settings window has no device, so
 * the page must name one. With exactly one deck connected it auto-selects — the
 * common case needs no click.
 *
 * Usage:
 * ```html
 * <ird-deck-device-select select-id="sw-deck"></ird-deck-device-select>
 * <ird-profile-switch profile="iRaceDeck Default" device-from="sw-deck"></ird-profile-switch>
 * ```
 *
 * Attributes:
 * - `select-id`: id given to the inner `<select>` so switch buttons can find it.
 * - `devices`: global setting key holding the list (default `_deckDevices`).
 * - `placeholder`: text of the empty option (default `Choose a Stream Deck…`).
 */

type DeckDevice = { id: string; name: string; type?: number };

const DEFAULT_DEVICES_SETTING = "_deckDevices";
const DEFAULT_PLACEHOLDER = "Choose a Stream Deck…";

let styleInjected = false;

export class DeckDeviceSelect extends HTMLElement {
  private select: HTMLSelectElement | null = null;
  private _initialized = false;

  connectedCallback(): void {
    if (this._initialized) return;

    this._initialized = true;
    this.injectStyle();
    this.buildDOM();
    this.subscribe();
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");

    style.textContent = `
      ird-deck-device-select { display: block; }
      ird-deck-device-select select {
        width: 100%;
        padding: 5px 8px;
        border: 1px solid #555;
        border-radius: 4px;
        font-size: 11px;
        background: #2a2a2a;
        color: #d8d8d8;
        box-sizing: border-box;
      }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private buildDOM(): void {
    this.select = document.createElement("select");
    this.select.id = this.getAttribute("select-id") ?? "";
    this.renderOptions([]);
    this.appendChild(this.select);
  }

  private subscribe(): void {
    if (!window.SDPIComponents) return;

    const devicesKey = this.getAttribute("devices") ?? DEFAULT_DEVICES_SETTING;

    window.SDPIComponents.useGlobalSettings(devicesKey, (value: string) => {
      if (!value) return;

      try {
        const parsed: unknown = JSON.parse(value);

        if (!Array.isArray(parsed)) return;

        this.renderOptions(
          parsed.filter(
            (d): d is DeckDevice =>
              d !== null && typeof d === "object" && typeof d.id === "string" && typeof d.name === "string",
          ),
        );
      } catch {
        // Malformed list: keep whatever is rendered; the picker just stays empty.
      }
    });
  }

  private renderOptions(devices: DeckDevice[]): void {
    if (!this.select) return;

    const previous = this.select.value;

    this.select.innerHTML = "";

    const placeholder = document.createElement("option");

    placeholder.value = "";
    placeholder.textContent = this.getAttribute("placeholder") ?? DEFAULT_PLACEHOLDER;
    this.select.appendChild(placeholder);

    for (const device of devices) {
      const option = document.createElement("option");

      option.value = device.id;
      option.textContent = device.name;
      this.select.appendChild(option);
    }

    // Keep the user's choice if that deck is still there; with exactly one
    // deck there is nothing to choose, so pick it.
    if (previous && devices.some((d) => d.id === previous)) {
      this.select.value = previous;
    } else if (devices.length === 1) {
      this.select.value = devices[0]?.id ?? "";
    }
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-deck-device-select")) {
    customElements.define("ird-deck-device-select", DeckDeviceSelect);
  }
}
