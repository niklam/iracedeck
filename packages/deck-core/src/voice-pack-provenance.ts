/**
 * `.install.json` — where an installed pack came from (issue #1034, stage 2).
 *
 * Written by the installer into the pack directory, and deliberately NOT part
 * of the archive: a pack must not be able to declare its own provenance. That
 * is the whole mechanism by which a sideloaded pack is identified — it has no
 * `.install.json` at all, because nothing but our installer ever writes one.
 * A pack that shipped one inside its zip would be claiming to have been
 * installed from the catalog, which is exactly the claim the file exists to
 * make unforgeable, so the extractor drops it along with every other dotfile
 * rather than trusting what it says.
 *
 * The file is also the update test. `sha256` is the digest of the ARCHIVE this
 * directory was extracted from, so "is there anything new?" is a comparison
 * against the catalog entry's hash and never a re-download. A content hash
 * cannot be forgotten the way a version bump can, which is why the comparison
 * is on the hash and the version is carried for humans.
 */
import { z } from "zod";

import { packId } from "./voice-pack-manifest.js";

/**
 * How the pack got here.
 *
 * `catalog` is a verified download. `bundled-seed` is a copy of a pack the
 * plugin shipped in its own distributable, laid down on first run so that the
 * release which STOPS shipping it needs no network — the seed is what makes
 * that upgrade offline-safe for the entire install base.
 *
 * A sideloaded pack is neither: it has no record at all. Absence is the third
 * value, and it is not spelled here on purpose — a `source: "sideload"` would
 * be a claim a third party could write into their own folder.
 */
export const VOICE_PACK_SOURCES = ["catalog", "bundled-seed"] as const;

export type VoicePackSource = (typeof VOICE_PACK_SOURCES)[number];

export const VoicePackProvenanceSchema = z.object({
  schema: z.literal(1),
  source: z.enum(VOICE_PACK_SOURCES),
  id: packId,
  version: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha-256 digest"),
  /** Absent for a bundled seed, which was copied rather than fetched. */
  url: z.string().optional(),
  installedAt: z.string().min(1),
});

export type VoicePackProvenance = z.infer<typeof VoicePackProvenanceSchema>;

/**
 * Read an `.install.json`. Returns `undefined` for anything unreadable.
 *
 * Every failure collapses to the same answer for the same reason the catalog
 * fetch does: the caller treats "no record" and "a record I cannot understand"
 * identically. Both mean the installed hash is unknown, and an unknown hash
 * means the pack is offered as installable rather than up to date. The cost of
 * being wrong is one re-download; the cost of trusting a half-parsed record is
 * skipping an install the user asked for.
 */
export function parseVoicePackProvenance(raw: string): VoicePackProvenance | undefined {
  let body: unknown;

  try {
    // A BOM survives a hand-edit on Windows and `JSON.parse` throws on it.
    // Same test as `parseVoicePackManifest` uses, deliberately: the two files
    // sit in one directory and a user who opens one opens the other.
    body = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return undefined;
  }

  const parsed = VoicePackProvenanceSchema.safeParse(body);

  return parsed.success ? parsed.data : undefined;
}

/**
 * Serialize an `.install.json`.
 *
 * Sorted keys and a trailing newline, matching every other JSON artifact this
 * repo writes, so the file diffs cleanly when a maintainer looks at one.
 */
export function serializeVoicePackProvenance(provenance: VoicePackProvenance): string {
  const ordered = Object.fromEntries(Object.entries(provenance).sort(([a], [b]) => a.localeCompare(b)));

  return `${JSON.stringify(ordered, null, 2)}\n`;
}
