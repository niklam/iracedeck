#!/usr/bin/env node
/**
 * Publishes the voice-pack catalog the plugin's install flow reads
 * (issue #1100 / #1034 stage 2): packages/website/public/voice-catalog.json,
 * served by Astro as https://iracedeck.com/voice-catalog.json.
 *
 * Deliberately the SAME builder every other consumer of the committed per-pack
 * entry files would use (scripts/lib/voice-catalog-data.mjs), reading from
 * packages/audio-assets/catalog/, so the published file and any other reader
 * of that directory cannot drift. Regenerated on every `dev`/`build` and
 * gitignored, like changelog.json.
 *
 * Run with tsx, not plain node: the builder validates every entry against
 * `VoicePackCatalogEntrySchema`, imported directly from the deck-core TS
 * source (see voice-catalog-data.mjs for why that import needs tsx).
 *   pnpm --filter @iracedeck/website generate:voice-catalog-json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { buildVoiceCatalogData, serializeVoiceCatalogData, VOICE_CATALOG_ENTRIES_DIR } from "../../../scripts/lib/voice-catalog-data.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const entriesDir = path.join(repoRoot, VOICE_CATALOG_ENTRIES_DIR);
const outputFile = path.join(repoRoot, "packages", "website", "public", "voice-catalog.json");

const data = buildVoiceCatalogData(entriesDir);

mkdirSync(path.dirname(outputFile), { recursive: true });
writeFileSync(outputFile, serializeVoiceCatalogData(data), "utf-8");

console.log(`Generated ${outputFile}`);
console.log(`Packs: ${data.packs.length}`);
