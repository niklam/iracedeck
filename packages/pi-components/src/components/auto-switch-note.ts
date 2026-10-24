/// <reference lib="dom" />
/**
 * The orange note on the settings window's *Automatically switch to profile*
 * card (#1111): shown while the master toggle is off and at least one session
 * kind names a profile, because then the picked profiles silently do nothing.
 * Hidden as soon as the toggle is on or every row is back to "Do not change
 * the profile".
 *
 * It reads the card's own controls rather than the settings stream. The
 * window's server never echoes a write back to the page that made it (see
 * `settings-window-server.ts`), so a subscriber would miss the user's own
 * click; sdpi dispatches a `valuechange` event on the control itself for every
 * change — the user's, a push from the plugin, and the initial load — so
 * listening there covers all three.
 *
 * Usage (rendered by `global-profile-auto-switch.ejs`):
 * ```html
 * <ird-auto-switch-note hidden>…note text…</ird-auto-switch-note>
 * ```
 * The controls are found by their `setting` attribute, using the key names in
 * `@iracedeck/app-constants`.
 */
import { PROFILE_AUTO_SWITCH_ENABLED_KEY, PROFILE_FOR_SESSION_KIND_KEYS } from "@iracedeck/app-constants";

const VALUE_CHANGE_EVENT = "valuechange";

let styleInjected = false;

/** A control sdpi renders: its current value is a property on the element. */
type ValuedElement = Element & { value?: unknown };

/**
 * Whether the note shows: the toggle is off and some row names a profile.
 *
 * @internal Exported for testing
 */
export function shouldShowAutoSwitchNote(enabled: unknown, rows: readonly unknown[]): boolean {
  const on = enabled === true || enabled === "true";

  return !on && rows.some((row) => typeof row === "string" && row !== "");
}

export class AutoSwitchNote extends HTMLElement {
  private readonly watched = new Set<Element>();
  private readonly onChange = (): void => this.update();
  private readonly onParsed = (): void => this.watch();

  connectedCallback(): void {
    this.injectStyle();

    // The selects come after this element in the card, so during parsing they
    // do not exist yet: watch again once the document is parsed.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", this.onParsed, { once: true });
    }

    this.watch();
  }

  disconnectedCallback(): void {
    document.removeEventListener("DOMContentLoaded", this.onParsed);

    for (const control of this.watched) control.removeEventListener(VALUE_CHANGE_EVENT, this.onChange);

    this.watched.clear();
  }

  private control(setting: string): ValuedElement | null {
    return document.querySelector(`[setting="${setting}"]`);
  }

  private watch(): void {
    const keys = [PROFILE_AUTO_SWITCH_ENABLED_KEY, ...Object.values(PROFILE_FOR_SESSION_KIND_KEYS)];

    for (const key of keys) {
      const control = this.control(key);

      if (!control || this.watched.has(control)) continue;

      control.addEventListener(VALUE_CHANGE_EVENT, this.onChange);
      this.watched.add(control);
    }

    this.update();
  }

  private update(): void {
    const enabled = this.control(PROFILE_AUTO_SWITCH_ENABLED_KEY)?.value;
    const rows = Object.values(PROFILE_FOR_SESSION_KIND_KEYS).map((key) => this.control(key)?.value);

    this.hidden = !shouldShowAutoSwitchNote(enabled, rows);
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");

    // The warning banner's amber (`ird-warnings .ird-warning-warning`): a
    // caution, not an error.
    style.textContent = `
      ird-auto-switch-note { display: block; margin: 0 20px 10px var(--ird-label-width, 95px); padding: 6px 10px;
        border-radius: 4px; background: #4a3a1e; border: 1px solid #b8860b; color: #ffe9b8;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif; font-size: 9pt; }
      ird-auto-switch-note[hidden] { display: none; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-auto-switch-note")) {
    customElements.define("ird-auto-switch-note", AutoSwitchNote);
  }
}
