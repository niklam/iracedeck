/**
 * The Diagnostics row for the voice-pack catalog development override (#1100).
 *
 * Renders NOTHING unless `_devBaseUrl` is set, which is the whole design. An
 * ordinary installation's Diagnostics tab is unchanged and never grows a field
 * inviting someone to paste a URL into it — and when the override IS set, it
 * says so in the one place a person goes looking when the catalog is not what
 * the website serves.
 *
 * Read-only by construction: it renders text, not an input, and writes no
 * setting. The value is set by hand-editing the plugin's settings file, and a
 * page must never be able to steer where the plugin fetches from — which is the
 * rule the override deliberately does not relax.
 *
 * It shows the RESOLVED url rather than the raw value, so a rejected override
 * reads as the published URL here instead of as whatever was typed. Otherwise
 * a typo would look active on the very screen someone checks to find out
 * whether it is.
 */
import { skipUnchanged } from "./settings-change-filter.js";

/** Mirrors `VOICE_PACK_DEV_BASE_URL_KEY` in deck-core. */
const DEV_BASE_SETTING = "_devBaseUrl";
const CATALOG_FILENAME = "voice-catalog.json";
const DEFAULT_BASE = "https://iracedeck.com";

/** How long a rejected value is shown before it is elided; a hand-edited file can hold anything. */
const MAX_SHOWN_VALUE = 120;

/**
 * What the row says: where the plugin will ACTUALLY fetch, and whether the
 * override got its way.
 *
 * The two travel together on purpose. Showing the resolved URL alone was not
 * enough: a rejected override resolves to the published URL, so prose that
 * unconditionally announced an override contradicted the URL printed directly
 * above it, on the one screen someone checks to find out whether the override
 * is live. The URL was honest and the sentence was not.
 */
interface DisplayState {
  /** True only when the override was accepted and is steering the catalog. */
  readonly accepted: boolean;
  /** The URL the plugin will fetch — resolved, never the raw value. */
  readonly url: string;
}

/** Elide an over-long hand-edited value so one paste cannot blow out the row. */
function truncateValue(value: string): string {
  const trimmed = value.trim();

  return trimmed.length > MAX_SHOWN_VALUE ? `${trimmed.slice(0, MAX_SHOWN_VALUE)}…` : trimmed;
}

/**
 * The browser's copy of deck-core's `resolveVoicePackCatalogUrl`.
 *
 * Deliberately duplicated rather than imported: this bundle runs in a Property
 * Inspector WebView and never imports from deck-core, the same boundary that
 * keeps `abort-after` in two places. Kept to the same rules — https anywhere,
 * http only to loopback, no query or fragment, and only our own filename joined
 * on — so the row cannot claim an override the plugin would refuse.
 */
function resolveDisplayUrl(base: string): DisplayState {
  const fallback: DisplayState = { accepted: false, url: `${DEFAULT_BASE}/${CATALOG_FILENAME}` };

  let url: URL;

  try {
    url = new URL(base);
  } catch {
    return fallback;
  }

  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return fallback;

  if (url.search !== "" || url.hash !== "") return fallback;

  return { accepted: true, url: `${url.origin}${url.pathname.replace(/\/+$/, "")}/${CATALOG_FILENAME}` };
}

export class DevBaseUrl extends HTMLElement {
  private initialized = false;

  connectedCallback(): void {
    if (this.initialized) return;

    this.initialized = true;
    this.render("");
    this.hookSettings();
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    window.SDPIComponents.useGlobalSettings(
      DEV_BASE_SETTING,
      skipUnchanged((value: string) => this.render(value)),
    );
  }

  private render(value: string): void {
    this.textContent = "";

    // Absent is the overwhelmingly common case, and it must leave no trace.
    if (typeof value !== "string" || value.trim() === "") {
      this.hidden = true;

      return;
    }

    this.hidden = false;

    const state = resolveDisplayUrl(value);
    const item = document.createElement("sdpi-item");

    // The label carries the verdict too, because it is the part that gets
    // scanned rather than read.
    item.setAttribute("label", state.accepted ? "Catalog override" : "Catalog override (ignored)");

    const text = document.createElement("div");

    // textContent: the value is a string somebody hand-edited into a file.
    // Always the RESOLVED url, so a rejected override never reads as active.
    text.textContent = state.url;
    item.appendChild(text);
    this.appendChild(item);

    const note = document.createElement("div");

    note.className = "ird-supporting-text";
    note.textContent = state.accepted
      ? "A development override is set, so voice packs are listed from here instead of iracedeck.com. " +
        "Remove _devBaseUrl from the settings file to go back to the published catalog."
      : `The _devBaseUrl override was rejected, so voice packs are listed from the published catalog above. ` +
        `It must be https, or http to localhost or 127.0.0.1, and carry no query or fragment. ` +
        `Rejected value: ${truncateValue(value)}`;
    this.appendChild(note);
  }
}

if (!customElements.get("ird-dev-base-url")) customElements.define("ird-dev-base-url", DevBaseUrl);
