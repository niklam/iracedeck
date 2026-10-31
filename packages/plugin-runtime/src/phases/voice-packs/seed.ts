/**
 * Phase 5, step 2 (#1377): which compiled-in catalog entries the installer may
 * seed. A pure function of its inputs — the entries, the voices this build
 * bundles, the plugin's audio directory and a logger for the entries it skips —
 * so each branch is tested without a scan or an installer.
 */
import defaultVoicePackCatalogEntry from "@iracedeck/audio-assets/catalog/default.json" with { type: "json" };
import type { ILogger } from "@iracedeck/logger";
import { type BundledVoicePack, VoicePackCatalogEntrySchema } from "@iracedeck/voice-packs";

/**
 * The catalog entries compiled into this build, so a pack the plugin still
 * ships can be SEEDED — copied into an empty packs folder with the catalog's
 * own `sha256` as its provenance, which is what makes the first catalog check
 * after a seed answer "installed" rather than re-download what was just
 * copied. Since 3.3.0 no plugin ships a voice, so this is inert: the loop
 * in `seedableBundledPacks` matches nothing and the plugin fetches `default`
 * at launch instead. It stays as the rule for seeding — set `bundled: true` on
 * an entry in `voice-packs.mjs` and that pack is seeded again, here (an offline
 * installer variant is what would want that). Since #1144 nothing hides the
 * bundled copy behind the seeded one, though: the bundle's bare `default` would
 * list beside the pack's `default::default`, so re-bundling needs that settled.
 *
 * Importing an entry does NOT decide that its pack is bundled. That is decided
 * once, in `@iracedeck/audio-assets`'s `voice-packs.mjs`, and reaches this
 * process as the clips the build copied into `assets/audio` and the manifest
 * it compiled in — the `bundledVoices` the phase hands `seedableBundledPacks`,
 * bare ids like a catalog entry's. An entry whose voices that set does not
 * cover is a published pack this build does not carry, and is simply not
 * seeded. That is why the stage 3 flip needed no edit here: the import went
 * stale and inert, nothing more.
 */
export const COMPILED_IN_VOICE_PACK_ENTRIES: readonly unknown[] = [defaultVoicePackCatalogEntry];

/** What `seedableBundledPacks` reads. */
export interface SeedableBundledPacksInput {
  /** Candidate catalog entries, unvalidated (`COMPILED_IN_VOICE_PACK_ENTRIES`). */
  readonly entries: readonly unknown[];
  /** The voices the plugin itself bundles, bare ids, from the compiled-in manifest. */
  readonly bundledVoices: readonly string[];
  /** The plugin's audio directory, where a bundled pack's clips are copied from. */
  readonly audioDir: string;
  readonly logger: ILogger;
}

/** The entries whose every voice this build bundles, each paired with the audio directory to seed it from. */
export function seedableBundledPacks({
  entries,
  bundledVoices,
  audioDir,
  logger,
}: SeedableBundledPacksInput): BundledVoicePack[] {
  const bundledVoicePacks: BundledVoicePack[] = [];

  for (const candidate of entries) {
    // safeParse, never parse: this runs at startup, and a malformed
    // committed entry must cost the seed, not the plugin process.
    const parsed = VoicePackCatalogEntrySchema.safeParse(candidate);

    if (!parsed.success) {
      logger.warn("A compiled-in voice pack catalog entry is invalid; that pack will not be seeded");
      logger.debug(parsed.error.message);
      continue;
    }

    if (!parsed.data.voices.every((voice) => bundledVoices.includes(voice.id))) {
      logger.debug(`Voice pack "${parsed.data.id}" is published, not bundled; not seeded`);
      continue;
    }

    bundledVoicePacks.push({ entry: parsed.data, audioDir });
  }

  return bundledVoicePacks;
}
