/// <reference lib="dom" />
/**
 * Profile-switch button web component for the Property Inspector.
 *
 * Renders a button that, on click, asks the plugin to switch the Stream Deck to a
 * bundled profile by sending `sendToPlugin` with `{ event: "switchToProfile",
 * profile }`. The Elgato adapter routes that to
 * `streamDeck.profiles.switchToProfile(device, profile)`, which prompts the user
 * to install the profile when it isn't installed yet — the mechanism that
 * installs and updates iRaceDeck's bundled profiles.
 *
 * Used by the "Stream Deck Profiles" global-settings accordion
 * (`global-stream-deck-profiles.ejs`). See `.claude/rules/profiles-and-devices.md`.
 *
 * Usage:
 * ```html
 * <ird-profile-switch profile="iRaceDeck Default" label="iRaceDeck Default"></ird-profile-switch>
 * ```
 *
 * Attributes:
 * - `profile`: bundled profile template's display name (no device suffix); the
 *   Elgato adapter resolves the pressing device's manifest name by appending
 *   its suffix (#753). An exact manifest name also works (passed through).
 * - `label`: button text (defaults to the profile name).
 * - `device-from` (settings window only, #992): id of a `<select>` whose value
 *   is the target device id. In a PI the adapter resolves the device from the
 *   PI's own context; the settings window has no device, so the page names one
 *   and the plugin's command handler requires it. No selection → no send.
 */

/** Minimal shape of the sdpi-components client this component depends on. */
interface StreamDeckClientLike {
  send(event: string, payload?: Record<string, unknown>): unknown;
}

interface SDPIComponentsGlobal {
  SDPIComponents?: { streamDeckClient?: StreamDeckClientLike };
}

/** Read the sdpi-components client off the global scope, if it has loaded. */
function defaultClient(): StreamDeckClientLike | undefined {
  return (globalThis as SDPIComponentsGlobal).SDPIComponents?.streamDeckClient;
}

let styleInjected = false;

export class ProfileSwitch extends HTMLElement {
  private button: HTMLButtonElement | null = null;
  private _initialized = false;

  connectedCallback(): void {
    if (this._initialized) return;

    this._initialized = true;

    this.injectStyle();
    this.buildDOM();
    this.attachListeners();
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");
    style.textContent = `
      ird-profile-switch { display: block; }
      ird-profile-switch button {
        width: 100%;
        padding: 4px 10px;
        border: 1px solid #555;
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        background: #2a2a2a;
        color: #d8d8d8;
        box-sizing: border-box;
      }
      ird-profile-switch button:hover {
        border-color: #777;
        background: #333;
      }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private buildDOM(): void {
    const profile = this.getAttribute("profile") ?? "";
    const label = this.getAttribute("label") ?? profile;
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.textContent = label;
    this.appendChild(this.button);
  }

  private attachListeners(): void {
    this.button?.addEventListener("click", () => {
      const profile = this.getAttribute("profile");

      if (!profile) return;

      const client = defaultClient();

      // No client (sdpi-components unavailable): do nothing rather than throw.
      if (!client) return;

      const payload: Record<string, unknown> = { event: "switchToProfile", profile };
      const deviceFrom = this.getAttribute("device-from");

      if (deviceFrom) {
        const select = document.getElementById(deviceFrom) as HTMLSelectElement | null;
        const deviceId = select?.value ?? "";

        // Explicit-device mode: a missing choice must not fall through to
        // "no device" — the plugin would (rightly) drop it, so don't send.
        if (!deviceId) return;

        payload.deviceId = deviceId;
      }

      // Fire-and-forget; swallow rejections (e.g. the PI socket isn't ready yet)
      // so a failed send never surfaces as an unhandled promise rejection.
      void Promise.resolve(client.send("sendToPlugin", payload)).catch(() => {});
    });
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-profile-switch")) {
    customElements.define("ird-profile-switch", ProfileSwitch);
  }
}
