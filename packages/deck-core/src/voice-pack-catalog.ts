/**
 * The published voice-pack catalog (issue #1034, stage 2).
 *
 * The shape of `https://iracedeck.com/voice-catalog.json`, and the pure rules
 * for reading it. No I/O: fetching is `voice-pack-catalog-client.ts`, and the
 * caching and gating around it live a layer above that, exactly as
 * `changelog-feed-client.ts` and `update-check-service.ts` are split.
 *
 * The catalog lists iRaceDeck's own packs and nothing else. That is a scope
 * decision rather than a technical one — listing a pack is an act of selection
 * implying its author's consent — and it is why there is no provenance,
 * signature or trust field here to validate. A third-party pack reaches a user
 * by sideload, and the scanner already tells the two apart by whether the
 * installer left an `.install.json` behind.
 *
 * Identity primitives are imported from `voice-pack-manifest.ts` rather than
 * restated. A catalog entry's `id` and a pack manifest's `id` are the SAME id —
 * the installer compares them after extracting, and refuses a pack that
 * disagrees with the entry that offered it. Two copies of the kebab-case rule
 * could drift, and the failure that drift produces is a pack that downloads,
 * verifies, extracts and is then rejected by the scanner, which is the most
 * expensive place to discover a spelling disagreement.
 */
import { coerce, gt, valid as semverValid } from "semver";
import { z } from "zod";

import { SHA256_HEX_MESSAGE, SHA256_HEX_PATTERN } from "./voice-pack-constants.js";
import { displayLabel, packId, voiceEntry } from "./voice-pack-manifest.js";

const semverString = z.string().refine((value) => semverValid(value) !== null, "must be a valid semver version");

/**
 * The archive's content hash, lowercase hex.
 *
 * Case is pinned rather than normalised because this value is compared against
 * a digest the installer computes itself, and a comparison between two spellings
 * of the same hash is a bug that only shows up as a spurious re-download.
 */
const sha256Hex = z.string().regex(SHA256_HEX_PATTERN, SHA256_HEX_MESSAGE);

/**
 * Where the archive lives.
 *
 * Constrained to `https:` here as well as at the point of use. The plugin never
 * takes a URL from a config or the UI, but it does take one from this document,
 * so the document is the boundary: an `http:` or `file:` URL in a catalog entry
 * is a malformed entry, not a request to be honoured. Parsed with the URL
 * constructor rather than a regex so the scheme is decided by the same parser
 * that will later resolve it.
 */
const archiveUrl = z.string().refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "must be an https URL");

/** One downloadable pack. */
export const VoicePackCatalogEntrySchema = z.object({
  id: packId,
  label: displayLabel,
  version: semverString,
  description: z.string().max(300).optional(),
  voices: z.array(voiceEntry).min(1),
  bytes: z.number().int().positive(),
  sha256: sha256Hex,
  url: archiveUrl,
  minPluginVersion: semverString.optional(),
});

export type VoicePackCatalogEntry = z.infer<typeof VoicePackCatalogEntrySchema>;

/**
 * `schema` stays `1` for the same reason the pack manifest's does: a version
 * distinguishes formats that coexist in the wild, and nothing has published a
 * voice catalog yet.
 */
export const VoicePackCatalogSchema = z.object({
  schema: z.literal(1),
  packs: z.array(z.unknown()),
});

/**
 * Read a fetched catalog body. Returns the entries, or `undefined` when the
 * document itself is unusable.
 *
 * A malformed ENTRY is dropped; a malformed DOCUMENT is refused. That asymmetry
 * is deliberate and is the one place this differs from `parsePublishedChangelog`,
 * which refuses the whole artifact on a bad release. A changelog is read as a
 * whole — a missing release makes the pane wrong. A catalog is read per pack,
 * and rejecting all of it because one entry is bad would take every OTHER pack
 * offline over a defect in one, including the pack a user is trying to install
 * right now.
 *
 * Silently dropping an entry would be a bad way to find out the generator is
 * broken, so the generator is where that is caught: the website build validates
 * with this same schema and fails rather than publishing an entry no plugin can
 * read. This function is the last line, not the only one.
 *
 * Unknown fields are ignored rather than refused, so publishing a new field
 * cannot break plugins already in the field.
 */
export function parseVoicePackCatalog(body: unknown): VoicePackCatalogEntry[] | undefined {
  const document = VoicePackCatalogSchema.safeParse(body);

  if (!document.success) return undefined;

  const entries: VoicePackCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const candidate of document.data.packs) {
    const entry = VoicePackCatalogEntrySchema.safeParse(candidate);

    if (!entry.success) continue;

    // A repeated id would give the UI two rows claiming one pack and the
    // installer two answers to "which archive is `luca`?". First wins, matching
    // how the scanner resolves a manifest that declares a voice twice.
    if (seen.has(entry.data.id)) continue;

    seen.add(entry.data.id);
    entries.push(entry.data);
  }

  return entries;
}

/**
 * Whether this plugin build is new enough to install `entry`.
 *
 * A pack that needs a newer runtime stays LISTED and is not offered — the user
 * is told the pack exists and that their plugin is too old, which is a more
 * useful answer than a catalog that appears to be missing it. So this is a
 * predicate the UI renders from, never a filter applied to the list.
 *
 * An unparseable running version answers `false`: with no way to establish that
 * the requirement is met, the honest answer is that we cannot offer it.
 */
export function isVoicePackOfferable(entry: VoicePackCatalogEntry, pluginVersion: string): boolean {
  if (entry.minPluginVersion === undefined) return true;

  if (semverValid(pluginVersion) === null) return false;

  // The running version is compared with any pre-release suffix STRIPPED, which
  // is deliberately more permissive than semver's own ordering.
  //
  // Semver puts `3.2.0-dev.0` before `3.2.0`, so a pack requiring `3.2.0` would
  // be listed-and-not-offered on every pre-release build of the very release
  // that introduced the requirement — every maintainer build, and every RC a
  // tester runs. That is precisely backwards: those builds are cut FROM that
  // line and carry its capabilities, and they are the ones most likely to be
  // exercising the pack. It is not hypothetical either — the version in this
  // repo today is `3.2.0-dev.0`.
  //
  // The cost of being wrong this way is bounded. `minPluginVersion` gates a
  // runtime CAPABILITY, not the integrity of anything: a build that genuinely
  // lacks what a pack needs fails at validation, having already verified the
  // archive's hash, and leaves the installed pack untouched like any other
  // failed install. Being wrong the other way is silent and unbounded — a pack
  // that never becomes available, with the UI correctly explaining that the
  // plugin is too old.
  const effective = coerce(pluginVersion)?.version ?? pluginVersion;

  return !gt(entry.minPluginVersion, effective);
}
