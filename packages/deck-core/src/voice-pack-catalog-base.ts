/**
 * Where the voice-pack catalog is fetched from, and the development override
 * that can move it (issue #1100).
 *
 * The plugin ships pointing at iracedeck.com and, with nothing set, resolves to
 * a byte-identical URL to the constant it used before this file existed. That
 * property is the one worth protecting: everything here is an addition on top
 * of behaviour that must not move, and there is a test pinning exactly that.
 *
 * WHY AN OVERRIDE IS ACCEPTABLE HERE, stated because the obvious objection is a
 * good one. A catalog names each pack's `sha256`, so being able to move the
 * catalog is being able to choose both the bytes and the hash they are checked
 * against — which sounds like a privilege escalation and is not one. The value
 * lives in the plugin's own settings FILE, and anyone who can write that file
 * can already write the plugin's JavaScript sitting beside it. No boundary is
 * crossed that was not already open.
 *
 * The rule this does NOT relax is the one that matters, and it is about the UI
 * rather than the filesystem: a PAGE never gets to say where the plugin looks.
 * No value from the settings page or a Property Inspector is routed into this,
 * the settings server strips nothing here because the page has no control to
 * put a URL in — see the Diagnostics row, which is read-only and appears only
 * when the override is already set.
 *
 * Scope is the catalog alone. `changelog-feed-client.ts` shares the host and is
 * deliberately untouched: it has shipped and works, and widening a released
 * path for a testing convenience is a bad trade. Adding a second consumer later
 * is a one-line call to {@link resolveVoicePackCatalogUrl} with a different
 * filename — which is why the filename is a parameter of the join rather than
 * baked into it.
 */
import type { ILogger } from "@iracedeck/logger";

/**
 * Passthrough global holding the base the catalog is fetched from, e.g.
 * `http://127.0.0.1:8080`. Absent on every ordinary installation.
 *
 * A PASSTHROUGH key, never a schema field, and that is deliberate: a schema
 * field that throws takes the whole settings parse down with it, which makes
 * every key binding read as unset (see `global-settings.md`). A malformed value
 * here must cost only this feature, so it is validated at the point of use.
 */
export const VOICE_PACK_DEV_BASE_URL_KEY = "_devBaseUrl";

/** The published origin. */
export const VOICE_PACK_CATALOG_DEFAULT_BASE = "https://iracedeck.com";

/** The one filename this feature ever asks for. */
export const VOICE_PACK_CATALOG_FILENAME = "voice-catalog.json";

/**
 * True for a base we are willing to fetch from.
 *
 * `https` anywhere. `http` ONLY to loopback, so a catalog can be served from a
 * local file server while plaintext to a real host stays refused — the case the
 * override exists for is a developer on their own machine, and that is exactly
 * where plaintext costs nothing.
 */
function isAcceptableBase(url: URL): boolean {
  if (url.protocol === "https:") return true;

  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/**
 * The URL to fetch the catalog from, given the raw override value.
 *
 * Never throws, and never returns anything but a URL under a base that passed
 * {@link isAcceptableBase}. Anything unusable — not a URL, wrong scheme,
 * plaintext to a real host, or carrying a query or fragment — is ignored with a
 * WARN and the published base is used instead. Warn rather than debug because a
 * silently ignored override is a worse debugging experience than no override.
 *
 * Only the known filename is ever joined on. A base may legitimately carry a
 * path (`http://127.0.0.1:8080/fixtures`) and may or may not end in a slash, so
 * the join normalises rather than concatenating; and a base carrying its own
 * query or fragment is refused rather than merged, so the value cannot smuggle
 * a different file or append parameters to the request.
 */
export function resolveVoicePackCatalogUrl(p: { base?: string | undefined; logger?: ILogger } = {}): string {
  const { base, logger } = p;
  const fallback = `${VOICE_PACK_CATALOG_DEFAULT_BASE}/${VOICE_PACK_CATALOG_FILENAME}`;

  if (typeof base !== "string" || base.trim() === "") return fallback;

  let url: URL;

  try {
    url = new URL(base);
  } catch {
    logger?.warn("Voice pack catalog override ignored: not a URL");

    return fallback;
  }

  if (!isAcceptableBase(url)) {
    logger?.warn("Voice pack catalog override ignored: must be https, or http to localhost");

    return fallback;
  }

  if (url.search !== "" || url.hash !== "") {
    logger?.warn("Voice pack catalog override ignored: must not carry a query or fragment");

    return fallback;
  }

  // Built from origin + path only, so nothing from the value survives into the
  // request but the location it names.
  const path = url.pathname.replace(/\/+$/, "");

  return `${url.origin}${path}/${VOICE_PACK_CATALOG_FILENAME}`;
}
