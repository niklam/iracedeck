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

/**
 * The browser's copy of deck-core's `resolveVoicePackCatalogUrl`.
 *
 * Deliberately duplicated rather than imported: this bundle runs in a Property
 * Inspector WebView and never imports from deck-core, the same boundary that
 * keeps `abort-after` in two places. Kept to the same rules — https anywhere,
 * http only to loopback, no query or fragment, and only our own filename joined
 * on — so the row cannot claim an override the plugin would refuse.
 */
function resolveDisplayUrl(base: string): string {
  const fallback = `${DEFAULT_BASE}/${CATALOG_FILENAME}`;

  let url: URL;

  try {
    url = new URL(base);
  } catch {
    return fallback;
  }

  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return fallback;

  if (url.search !== "" || url.hash !== "") return fallback;

  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/${CATALOG_FILENAME}`;
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

    const item = document.createElement("sdpi-item");

    item.setAttribute("label", "Catalog override");

    const text = document.createElement("div");

    text.className = "ird-dev-base-url";
    // textContent: the value is a string somebody hand-edited into a file.
    text.textContent = resolveDisplayUrl(value);
    item.appendChild(text);
    this.appendChild(item);

    const note = document.createElement("div");

    note.className = "ird-supporting-text";
    note.textContent =
      "A development override is set, so voice packs are listed from here instead of iracedeck.com. " +
      "Remove _devBaseUrl from the settings file to go back to the published catalog.";
    this.appendChild(note);
  }
}

if (!customElements.get("ird-dev-base-url")) customElements.define("ird-dev-base-url", DevBaseUrl);
