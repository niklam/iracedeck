/// <reference lib="dom" />
/**
 * The "N of M on" count in each section summary of the settings window's
 * Race Engineer Callouts card (#1700). The partial renders the initial text
 * from the defaults, so nothing is blank before this loads; the component then
 * keeps it true.
 *
 * It reads the section's own checkboxes rather than the settings stream. The
 * window's server never echoes a write back to the page that made it (see
 * `settings-window-server.ts`), so a subscriber would miss the user's own
 * click; sdpi dispatches a `valuechange` event on the checkbox itself for
 * every change — the user's, a push from the plugin (the Corner Names key
 * writing its opt-in) and the initial load — so listening there covers all
 * three, as `ird-auto-switch-note` does.
 *
 * Usage (rendered by `race-engineer-callouts.ejs`, settings window only):
 * ```html
 * <details data-callout-section="pit-stops">
 *   <summary>… <ird-callout-count>24 of 25 on</ird-callout-count> …</summary>
 *   … <sdpi-checkbox setting="calloutEnabled…" …></sdpi-checkbox> …
 * </details>
 * ```
 * It counts every `sdpi-checkbox[setting^="calloutEnabled"]` inside its
 * closest `[data-callout-section]`, as shown: `value ?? default`. Sliders are
 * not counted. It writes `textContent` only, never markup.
 */
import { isTicked } from "./keep-one-checked.js";

const VALUE_CHANGE_EVENT = "valuechange";

/** The callout opt-ins a section holds; the sliders beside them are not counted. */
const CALLOUT_BOX_SELECTOR = 'sdpi-checkbox[setting^="calloutEnabled"]';

/** The section the count belongs to. */
const SECTION_SELECTOR = "[data-callout-section]";

/**
 * The count's text — the same words the partial renders before this loads.
 *
 * @internal Exported for testing
 */
export function formatCalloutCount(on: number, total: number): string {
  return `${on} of ${total} on`;
}

export class CalloutCount extends HTMLElement {
  private readonly watched = new Set<Element>();
  private readonly onChange = (): void => this.update();
  private readonly onParsed = (): void => this.watch();

  connectedCallback(): void {
    // The checkboxes come after this element (it sits in the section's
    // summary), so during parsing they do not exist yet: watch again once the
    // document is parsed.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", this.onParsed, { once: true });
    }

    this.watch();
  }

  disconnectedCallback(): void {
    document.removeEventListener("DOMContentLoaded", this.onParsed);

    for (const box of this.watched) box.removeEventListener(VALUE_CHANGE_EVENT, this.onChange);

    this.watched.clear();
  }

  private boxes(): Element[] {
    const section = this.closest(SECTION_SELECTOR);

    return section ? Array.from(section.querySelectorAll(CALLOUT_BOX_SELECTOR)) : [];
  }

  private watch(): void {
    for (const box of this.boxes()) {
      if (this.watched.has(box)) continue;

      box.addEventListener(VALUE_CHANGE_EVENT, this.onChange);
      this.watched.add(box);
    }

    this.update();
  }

  private update(): void {
    const boxes = this.boxes();

    // Nothing parsed yet (or nothing to count): keep the text the partial
    // rendered rather than flash "0 of 0 on" until the boxes arrive.
    if (boxes.length === 0) return;

    this.textContent = formatCalloutCount(boxes.filter(isTicked).length, boxes.length);
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-callout-count")) {
    customElements.define("ird-callout-count", CalloutCount);
  }
}
