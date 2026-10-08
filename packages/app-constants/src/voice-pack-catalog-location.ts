/**
 * Where the voice-pack catalog is fetched from, and the setting key of the
 * development override that can move it (issue #1100). The resolver that
 * applies the override, `resolveVoicePackCatalogUrl`, stays in voice-packs'
 * `voice-pack-catalog-base.ts`; the names are here so the Property Inspector
 * and the plugin share one source (spec #1351).
 */

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
