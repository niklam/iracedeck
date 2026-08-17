/// <reference lib="dom" />
/**
 * "Open iRaceDeck Settings" button web component for the Property Inspector
 * (issue #992).
 *
 * On click it asks the plugin to open the dedicated settings window by sending
 * `sendToPlugin` with `{ event: "openSettings" }`. Each adapter routes that to
 * the plugin's settings-window controller, which starts the loopback server
 * on demand and opens the page as a chromeless app window.
 *
 * Mirrors `ird-profile-switch` exactly — same client lookup, same
 * fire-and-forget send — so the two stay trivially consistent.
 *
 * Usage:
 * ```html
 * <ird-open-settings></ird-open-settings>
 * <ird-open-settings label="Settings…"></ird-open-settings>
 * ```
 */
import { sendToPlugin } from "./sdpi-client.js";

const DEFAULT_LABEL = "Open iRaceDeck Settings";

let styleInjected = false;

export class OpenSettings extends HTMLElement {
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
      ird-open-settings { display: block; }
      ird-open-settings button {
        width: 100%;
        min-width: 200px;
        padding: 6px 16px;
        border: 1px solid #ce2128; /* iRaceDeck brand red (website --sl-color-accent) */
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        background: #3a2426;
        color: #ffffff;
        box-sizing: border-box;
      }
      ird-open-settings button:hover {
        background: #ce2128;
      }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private buildDOM(): void {
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.textContent = this.getAttribute("label") ?? DEFAULT_LABEL;
    this.appendChild(this.button);
  }

  private attachListeners(): void {
    this.button?.addEventListener("click", () => {
      // Fire-and-forget; no client (sdpi-components unavailable) is a no-op.
      sendToPlugin({ event: "openSettings" });
    });
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-open-settings")) {
    customElements.define("ird-open-settings", OpenSettings);
  }
}
