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
 *   Storage card; `ird-open-settings` on `settings.ejs`, where the button IS
 *   the page).
 * - `compact` — auto width and smaller type, for a button that sits AMONG the
 *   settings it leads away from. #1024 moved `ird-open-settings` up under each
 *   action's own settings, where a full-width brand-red pill drowned out the
 *   settings the panel is actually about.
 *
 * A tag picks its default via `defaultSize`; an individual element overrides it
 * with a `size` attribute, the same way `label` overrides `defaultLabel`. Both
 * sizes are emitted for every tag, so the same component can be loud on the
 * page that is only about it and quiet everywhere else.
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
  /** Size used when an element carries no `size` attribute. Defaults to `"standard"`. */
  defaultSize?: SendToPluginButtonSize;
}

/** Width and type scale per size. */
const SIZE_CSS: Record<SendToPluginButtonSize, string> = {
  standard: "width: 100%; min-width: 200px; padding: 6px 16px; font-size: 11px;",
  compact: "width: auto; min-width: 0; padding: 4px 12px; font-size: 10px;",
};

/**
 * Builds and registers a `<tag>` custom element: a single button that fires
 * `sendToPlugin` with `payload` on click. Returns the element class so the
 * caller can re-export it (e.g. for `components/index.ts`).
 */
export function defineSendToPluginButton(options: SendToPluginButtonOptions): CustomElementConstructor {
  const { tag, defaultLabel, payload, icon, defaultSize = "standard" } = options;
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
          ${SIZE_CSS[defaultSize]}
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
        /* Both sizes, always — an element opts out of the tag's default with a
           size attribute, and the attribute selector outranks the bare tag rule
           above. Without this, a tag defined as compact could never be the
           full-width pill on the one page that is only about it. */
        ${tag}[size="standard"] button {
          ${SIZE_CSS.standard}
        }
        ${tag}[size="compact"] button {
          ${SIZE_CSS.compact}
        }
        ${tag} button:hover {
          background: #3a2426;
        }
        /* The glyph never grows or shrinks with the button. The flex shorthand
           has to sit on the FLEX ITEM (the wrapper span), not on the svg inside
           it, which is not a child of the flex container. */
        ${tag} button > [aria-hidden] {
          display: block;
          flex: none;
        }
        /* Follows the label's colour (currentColor) and keeps its own box. */
        ${tag} button svg {
          display: block;
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
        // Whitespace BETWEEN tags survives as text nodes inside the button and
        // would creep into its accessible name, so it is collapsed here rather
        // than left as an unwritten rule for whoever authors the next icon —
        // every other inline icon in this package is a multi-line literal.
        // Only pure inter-tag runs match, so text inside an element is intact.
        glyph.innerHTML = icon.replace(/>\s+</g, "><");
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
