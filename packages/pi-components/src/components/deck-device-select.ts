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
 *
 * The chosen deck's TYPE (#1457): `selectedDeviceType` reads it, and every
 * change of the effective choice — the user's pick, the one-deck auto-select,
 * or the chosen deck disconnecting — dispatches a bubbling
 * `ird-deck-device-change` event whose detail names this picker's `select-id`
 * and the deck's id and type. `ird-profile-variants` listens for it to hide the
 * profile rows the chosen deck has no variant of.
 */
import { skipUnchanged } from "./settings-change-filter.js";

type DeckDevice = { id: string; name: string; type?: number };

/** Dispatched (bubbling) on the picker whenever the effective choice changes (#1457). */
export const DECK_DEVICE_CHANGE_EVENT = "ird-deck-device-change";

export type DeckDeviceChangeDetail = {
  /** The picker's `select-id`, which `device-from` attributes name. */
  selectId: string;
  /** The chosen deck's id, or `""` with no deck chosen. */
  deviceId: string;
  /** The chosen deck's Stream Deck device type, or `undefined` when none is chosen or the list carries none. */
  deviceType: number | undefined;
};

const DEFAULT_DEVICES_SETTING = "_deckDevices";
const DEFAULT_PLACEHOLDER = "Choose a Stream Deck…";

let styleInjected = false;

export class DeckDeviceSelect extends HTMLElement {
  private select: HTMLSelectElement | null = null;
  private devices: DeckDevice[] = [];
  private announced: { deviceId: string; deviceType: number | undefined } = { deviceId: "", deviceType: undefined };
  private _initialized = false;

  /** The chosen deck's device type; `undefined` with no deck chosen or no type published for it. */
  get selectedDeviceType(): number | undefined {
    const id = this.select?.value ?? "";

    if (!id) return undefined;

    const type = this.devices.find((d) => d.id === id)?.type;

    return typeof type === "number" ? type : undefined;
  }

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
    this.select.addEventListener("change", () => this.announce());
    this.appendChild(this.select);
  }

  private subscribe(): void {
    if (!window.SDPIComponents) return;

    const devicesKey = this.getAttribute("devices") ?? DEFAULT_DEVICES_SETTING;

    window.SDPIComponents.useGlobalSettings(
      devicesKey,
      skipUnchanged((value: string) => {
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
      }),
    );
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

    this.devices = devices;
    this.announce();
  }

  /**
   * Tell listeners the effective choice changed. Only a change is announced: a
   * list refresh that keeps the same deck (and type) is silent.
   */
  private announce(): void {
    const deviceId = this.select?.value ?? "";
    const deviceType = this.selectedDeviceType;

    if (deviceId === this.announced.deviceId && deviceType === this.announced.deviceType) return;

    this.announced = { deviceId, deviceType };

    const detail: DeckDeviceChangeDetail = { selectId: this.select?.id ?? "", deviceId, deviceType };

    this.dispatchEvent(new CustomEvent<DeckDeviceChangeDetail>(DECK_DEVICE_CHANGE_EVENT, { bubbles: true, detail }));
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-deck-device-select")) {
    customElements.define("ird-deck-device-select", DeckDeviceSelect);
  }
}
