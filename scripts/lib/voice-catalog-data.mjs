// Builds the published voice-pack catalog artifact
// (https://iracedeck.com/voice-catalog.json, issue #1100 / #1034 stage 2).
//
// Mirrors the changelog artifact's split (changelog-data.mjs): this module owns
// the document's shape and its assembly from committed source files, so the
// generator script (packages/website/scripts/generate-voice-catalog-json.mjs)
// is left with nothing but file I/O.
//
// Unlike the changelog, the catalog has no compiled-in copy inside the plugin —
// the plugin fetches https://iracedeck.com/voice-catalog.json live at runtime
// (deck-core's voice-pack-catalog-client.ts) — so there is exactly one publish
// target and no second generator script at the repository root.
//
// The source of truth is one committed JSON file per published pack, at
// packages/audio-assets/catalog/<pack-id>.json — written by
// packages/audio-assets/scripts/pack-voice.mjs. Each file's content is exactly
// one VoicePackCatalogEntrySchema object (see that script's buildCatalogEntry).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Imported straight from the deck-core TS SOURCE, not a built copy — the same
// choice generate-action-comms.mjs makes for comms-catalog.ts, and for the same
// reason: a second, restated copy of the schema could drift from the one the
// plugin actually parses with, and drift here is exactly the failure this
// validation exists to catch. Because this is a live TypeScript import, every
// consumer of this module (the website generator, this file's own tests) must
// run under `tsx`, not plain `node` — plain node's built-in type stripping
// resolves this file's own syntax fine, but not the `.js`-extensioned relative
// imports voice-pack-catalog.ts makes to its NodeNext-resolved siblings, which
// have no compiled .js on disk in this checkout.
import { VoicePackCatalogEntrySchema } from "../../packages/deck-core/src/voice-pack-catalog.ts";

/** Where committed catalog entries live, relative to the repository root. */
export const VOICE_CATALOG_ENTRIES_DIR = "packages/audio-assets/catalog";

/** The command that regenerates the published artifact. */
export const VOICE_CATALOG_GENERATE_COMMAND = "pnpm --filter @iracedeck/website generate:voice-catalog-json";

/**
 * @typedef {{ schema: 1, packs: object[] }} VoiceCatalogData
 */

/**
 * Read, VALIDATE, and assemble every committed entry file under `entriesDir`
 * into the catalog document.
 *
 * Validation is the point of this function, not a courtesy check. The
 * plugin's own reader (`parseVoicePackCatalog` in voice-pack-catalog.ts)
 * deliberately DROPS a malformed entry and keeps the rest, so that one bad
 * pack can never take every other pack offline for every user. That is the
 * right behaviour for a client reading a document it did not produce — but it
 * means a malformed entry published here would vanish from every user's
 * catalog silently, with nothing anywhere reporting it. So THIS is where it
 * must be caught: build fails, naming the offending file and field, rather
 * than publishing an entry no plugin can read. Validated against the exact
 * same `VoicePackCatalogEntrySchema` the plugin parses with — imported, never
 * restated — so the two cannot drift apart.
 *
 * A missing or empty `entriesDir` is not an error: "no pack has published
 * yet" is a valid state (true of this repository as this module was written),
 * and the result is simply a catalog with an empty `packs` array.
 *
 * @param {string} entriesDir - Absolute path to the entries directory.
 * @returns {VoiceCatalogData}
 */
export function buildVoiceCatalogData(entriesDir) {
  if (!existsSync(entriesDir)) {
    return { schema: 1, packs: [] };
  }

  const files = readdirSync(entriesDir)
    .filter((name) => name.endsWith(".json"))
    .sort();

  const packs = files.map((file) => {
    const relPath = `${VOICE_CATALOG_ENTRIES_DIR}/${file}`;
    const filePath = path.join(entriesDir, file);
    const raw = readFileSync(filePath, "utf-8");

    let json;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${relPath}: not valid JSON: ${message}`);
    }

    const result = VoicePackCatalogEntrySchema.safeParse(json);

    if (!result.success) {
      const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");

      throw new Error(`${relPath}: ${issues}`);
    }

    const entry = result.data;
    // The file name is the id's home in the file system; a mismatch means
    // either the file was renamed without updating its content, or vice
    // versa, and either way the wrong pack would be the one that lands at
    // this id. Caught here rather than left to produce a confusing duplicate
    // or a silently missing pack downstream.
    const expectedId = file.slice(0, -".json".length);

    if (entry.id !== expectedId) {
      throw new Error(`${relPath}: entry id "${entry.id}" does not match the file name — expected "${expectedId}.json"`);
    }

    return entry;
  });

  // Sorted by id explicitly, not merely inherited from the (already
  // id-matching) file order above: the guarantee this function makes is
  // "sorted by pack id", and it should hold on its own terms rather than by
  // coincidence of the file-name check above.
  packs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { schema: 1, packs };
}

/**
 * Serialise the artifact.
 *
 * @param {VoiceCatalogData} data
 * @returns {string}
 */
export function serializeVoiceCatalogData(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}
