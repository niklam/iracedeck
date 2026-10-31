/**
 * The last call of the settings phase's store-ready block (#1377): say in the
 * log when the voice-pack catalog override is set.
 */
import { VOICE_PACK_DEV_BASE_URL_KEY } from "@iracedeck/app-constants";
import type { ILogger } from "@iracedeck/logger";
import { getGlobalSettings } from "@iracedeck/settings";
import { resolveVoicePackCatalogUrl, VOICE_PACK_CATALOG_URL } from "@iracedeck/voice-packs";

/**
 * An override must never be silently active (#1100). WARN rather than
 * info, and on every start rather than only when it changes, because the
 * person who needs this line is future-me reading a support log and
 * wondering why the catalog is not what the site serves. It names the
 * EFFECTIVE url, never the raw setting, and it claims the override is
 * ACTIVE only when that url actually differs from the published one: a
 * rejected value resolves back to the published catalog, and calling that
 * "active" would contradict the url printed in the same sentence.
 */
export function warnIfCatalogOverride(logger: ILogger): void {
  const rawDevBase = getGlobalSettings()[VOICE_PACK_DEV_BASE_URL_KEY];

  if (typeof rawDevBase === "string" && rawDevBase.trim() !== "") {
    const effective = resolveVoicePackCatalogUrl({ base: rawDevBase, logger });

    logger.warn(
      effective === VOICE_PACK_CATALOG_URL
        ? "Voice pack catalog override is set but has no effect; using the published catalog"
        : `Voice pack catalog override active: ${effective}`,
    );
  }
}
