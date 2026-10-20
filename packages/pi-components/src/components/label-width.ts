/// <reference lib="dom" />
/**
 * Widens the label column of every `sdpi-item` inside it. Settings window only.
 *
 * `sdpi-item` lays itself out as a fixed `95px` label column beside a `241px`
 * control column, in its own shadow DOM, with no custom property or part to
 * change it from outside — so a long label ("Race Admin Per Car") wraps onto
 * two lines. This wrapper appends one `<style>` to the shadow root of each
 * `sdpi-item` it holds, widening the label column, and moves the
 * `.ird-supporting-text` indent (which aligns help text under the controls) to
 * match. Items outside it keep the vendored layout.
 *
 * Usage (the settings window's Profiles pane):
 * ```html
 * <ird-label-width width="140">
 *   <sdpi-item label="Race Admin Per Car">…</sdpi-item>
 * </ird-label-width>
 * ```
 *
 * Attributes:
 * - `width`: the label column in pixels (default 140; a value below the
 *   vendored 95 or above 400 falls back to the default).
 */

const DEFAULT_WIDTH = 140;
const MIN_WIDTH = 95;
const MAX_WIDTH = 400;
/** The control column `sdpi-item` draws; unchanged, so controls keep their size. */
const CONTROL_WIDTH = 241;
const STYLE_MARKER = "data-ird-label-width";

let styleInjected = false;

/**
 * The label column width a `width` attribute asks for, in pixels.
 *
 * @internal Exported for testing
 */
export function parseLabelWidth(value: string | null): number {
  if (value === null || !/^\d+$/.test(value.trim())) return DEFAULT_WIDTH;

  const width = Number(value.trim());

  return width >= MIN_WIDTH && width <= MAX_WIDTH ? width : DEFAULT_WIDTH;
}

export class LabelWidth extends HTMLElement {
  private readonly onParsed = (): void => this.apply();

  connectedCallback(): void {
    this.injectStyle();
    this.style.setProperty("--ird-label-width", `${this.width}px`);

    // The items are upgraded once sdpi-components defines them; during parsing
    // this element connects before its children exist, so apply again after.
    void customElements.whenDefined("sdpi-item").then(() => this.apply());

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", this.onParsed, { once: true });
    }

    this.apply();
  }

  disconnectedCallback(): void {
    document.removeEventListener("DOMContentLoaded", this.onParsed);
  }

  private get width(): number {
    return parseLabelWidth(this.getAttribute("width"));
  }

  /**
   * Give every held `sdpi-item` that has rendered its shadow root the wider
   * column, once. The selector is `.container.grid`, not `.grid`: Lit applies
   * the vendored styles as adopted stylesheets, which come after a shadow
   * root's own `<style>` in the cascade, so an equally specific rule here loses.
   */
  private apply(): void {
    const css = `.container.grid{grid-template-columns:${this.width}px ${CONTROL_WIDTH}px}`;

    for (const item of Array.from(this.querySelectorAll("sdpi-item"))) {
      const root = item.shadowRoot;

      if (!root) continue;

      const existing = root.querySelector<HTMLStyleElement>(`style[${STYLE_MARKER}]`);

      if (existing) {
        existing.textContent = css;
        continue;
      }

      const style = document.createElement("style");

      style.setAttribute(STYLE_MARKER, "");
      style.textContent = css;
      root.appendChild(style);
    }
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");

    style.textContent = `
      ird-label-width { display: block; }
      ird-label-width .ird-supporting-text:not(.ird-supporting-text-full) { padding-left: var(--ird-label-width); }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-label-width")) {
    customElements.define("ird-label-width", LabelWidth);
  }
}
