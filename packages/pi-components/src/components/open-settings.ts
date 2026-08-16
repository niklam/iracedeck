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
        padding: 6px 10px;
        border: 1px solid #4a90d9;
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        background: #2a3a4a;
        color: #ffffff;
        box-sizing: border-box;
      }
      ird-open-settings button:hover {
        background: #34495e;
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
      const client = defaultClient();

      // No client (sdpi-components unavailable): do nothing rather than throw.
      if (!client) return;

      // Fire-and-forget; swallow rejections so a failed send never surfaces as
      // an unhandled promise rejection.
      void Promise.resolve(client.send("sendToPlugin", { event: "openSettings" })).catch(() => {});
    });
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-open-settings")) {
    customElements.define("ird-open-settings", OpenSettings);
  }
}
