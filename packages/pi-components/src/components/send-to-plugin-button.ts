/// <reference lib="dom" />
/**
 * Shared base for small "fire a sendToPlugin command" button components in
 * the Property Inspector — `ird-open-settings` (#992) and `ird-open-folder`
 * (#993) are both a single button that asks the plugin to do something
 * outside the settings model. This factory keeps their DOM/CSS/click wiring
 * in exactly one place so the two stay trivially consistent, without either
 * one growing outside its own tiny file.
 *
 * The client lookup and the fire-and-forget send live in `sdpi-client.ts`,
 * shared with every other `ird-*` component that talks to the host (#992).
 */
import { sendToPlugin } from "./sdpi-client.js";

/**
 * How much room the button claims. Everything else about it — colour, border,
 * hover, the icon slot — is identical across sizes, so a size is never a second
 * button design to maintain.
 *
 * - `standard` — the full-width pill for a button that CLOSES a card or a page
 *   and competes with nothing (`ird-open-folder` on the settings window's
 *   Storage card).
 * - `compact` — auto width and smaller type, for a button that sits AMONG the
 *   settings it leads away from. #1024 moved `ird-open-settings` up under each
 *   action's own settings, where a full-width brand-red pill drowned out the
 *   settings the panel is actually about.
 */
export type SendToPluginButtonSize = "standard" | "compact";

export interface SendToPluginButtonOptions {
  /** Custom element tag name, e.g. `"ird-open-settings"`. Also scopes the injected CSS. */
  tag: string;
  /** Button text shown when no `label` attribute is set. */
  defaultLabel: string;
  /** `sendToPlugin` payload fired on click. */
  payload: Record<string, unknown>;
  /**
   * Inline SVG markup rendered before the label and hidden from assistive tech
   * — the label already says what the button does. A bundle-authored constant
   * (see `open-settings.ts`), never user input and never a settings value,
   * which is what makes assigning it as markup safe here.
   */
  icon?: string;
  /** Defaults to `"standard"`. */
  size?: SendToPluginButtonSize;
}

/** Width and type scale per size. */
const SIZE_CSS: Record<SendToPluginButtonSize, string> = {
  standard: "width: 100%; min-width: 200px; padding: 6px 16px; font-size: 11px;",
  compact: "width: auto; padding: 4px 12px; font-size: 10px;",
};

/**
 * Builds and registers a `<tag>` custom element: a single button that fires
 * `sendToPlugin` with `payload` on click. Returns the element class so the
 * caller can re-export it (e.g. for `components/index.ts`).
 */
export function defineSendToPluginButton(options: SendToPluginButtonOptions): CustomElementConstructor {
  const { tag, defaultLabel, payload, icon, size = "standard" } = options;
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
          ${SIZE_CSS[size]}
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          border: 1px solid #ce2128; /* iRaceDeck brand red (website --sl-color-accent) */
          border-radius: 4px;
          cursor: pointer;
          font-weight: 600;
          background: #ce2128;
          color: #ffffff;
          box-sizing: border-box;
        }
        ${tag} button:hover {
          background: #3a2426;
        }
        /* The glyph follows the label's colour and never stretches with the button. */
        ${tag} button svg {
          display: block;
          flex: none;
        }
      `;
      document.head.appendChild(style);
      styleInjected = true;
    }

    private buildDOM(): void {
      this.button = document.createElement("button");
      this.button.type = "button";

      if (icon) {
        const glyph = document.createElement("span");

        glyph.setAttribute("aria-hidden", "true");
        glyph.innerHTML = icon;
        this.button.appendChild(glyph);
      }

      const label = document.createElement("span");

      label.textContent = this.getAttribute("label") ?? defaultLabel;
      this.button.appendChild(label);

      this.appendChild(this.button);
    }

    private attachListeners(): void {
      this.button?.addEventListener("click", () => {
        // Fire-and-forget; no client (sdpi-components unavailable) is a no-op.
        sendToPlugin(payload);
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
