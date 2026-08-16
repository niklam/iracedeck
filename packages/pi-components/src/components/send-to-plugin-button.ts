/// <reference lib="dom" />
/**
 * Shared base for small "fire a sendToPlugin command" button components in
 * the Property Inspector — `ird-open-settings` (#992) and `ird-open-folder`
 * (#993) are both a single button that asks the plugin to do something
 * outside the settings model. This factory keeps their DOM/CSS/click wiring
 * in exactly one place so the two stay trivially consistent, without either
 * one growing outside its own tiny file.
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

export interface SendToPluginButtonOptions {
  /** Custom element tag name, e.g. `"ird-open-settings"`. Also scopes the injected CSS. */
  tag: string;
  /** Button text shown when no `label` attribute is set. */
  defaultLabel: string;
  /** `sendToPlugin` payload fired on click. */
  payload: Record<string, unknown>;
}

/**
 * Builds and registers a `<tag>` custom element: a single button that fires
 * `sendToPlugin` with `payload` on click. Returns the element class so the
 * caller can re-export it (e.g. for `components/index.ts`).
 */
export function defineSendToPluginButton(options: SendToPluginButtonOptions): CustomElementConstructor {
  const { tag, defaultLabel, payload } = options;
  let styleInjected = false;

  class SendToPluginButton extends HTMLElement {
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
        ${tag} { display: block; }
        ${tag} button {
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
        ${tag} button:hover {
          background: #ce2128;
        }
      `;
      document.head.appendChild(style);
      styleInjected = true;
    }

    private buildDOM(): void {
      this.button = document.createElement("button");
      this.button.type = "button";
      this.button.textContent = this.getAttribute("label") ?? defaultLabel;
      this.appendChild(this.button);
    }

    private attachListeners(): void {
      this.button?.addEventListener("click", () => {
        const client = defaultClient();

        // No client (sdpi-components unavailable): do nothing rather than throw.
        if (!client) return;

        // Fire-and-forget; swallow rejections so a failed send never surfaces as
        // an unhandled promise rejection.
        void Promise.resolve(client.send("sendToPlugin", payload)).catch(() => {});
      });
    }
  }

  if (typeof customElements !== "undefined") {
    if (!customElements.get(tag)) {
      customElements.define(tag, SendToPluginButton);
    }
  }

  return SendToPluginButton;
}
