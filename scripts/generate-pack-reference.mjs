#!/usr/bin/env node
/**
 * Generates packages/website/src/data/pack-reference.json — the pack-author
 * reference the website renders as the callout, vocabulary and recording-script
 * pages (issue #1066) — from the Race Engineer catalog's contracts and
 * vocabulary (read off the registered engine), the bundled voice's script
 * (packages/audio-assets/voice/default/callouts.json), its authored config
 * (configs/default.voice.json) and the runtime manifest.
 *
 * Needs the BUILT `@iracedeck/audio-scenarios` dist — run `pnpm build` (or
 * `pnpm exec turbo run build --filter=@iracedeck/audio-scenarios`) first; the
 * root scripts are plain Node and cannot import TypeScript sources.
 *
 * Run after changing a contract, its description, the vocabulary, the bundled
 * script or the bundled voice's clips:
 *   pnpm generate:pack-reference
 *
 * A freshness test (generate-pack-reference.test.mjs) fails if the committed
 * JSON drifts from what these sources build.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import {
  buildPackReferenceData,
  PACK_REFERENCE_PATH,
  serializePackReferenceData,
  summarizePackReference,
} from "./lib/pack-reference-data.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outputFile = path.join(repoRoot, PACK_REFERENCE_PATH);

const reference = await buildPackReferenceData();
writeFileSync(outputFile, await serializePackReferenceData(reference), "utf-8");

const summary = summarizePackReference(reference);
/** Up to a handful of names; past that, the count already said what matters. */
const SHOWN = 8;
const list = (items) =>
  items.length === 0
    ? "none"
    : items.length <= SHOWN
      ? items.join(", ")
      : `${items.slice(0, SHOWN).join(", ")}, … (${items.length - SHOWN} more)`;

console.log(`Generated ${outputFile}`);
console.log(`Catalog version: ${reference.generatedFrom.catalogVersion}`);
console.log(`Callouts: ${summary.callouts} (skipped in the bundled voice: ${list(summary.skipped)})`);
console.log(`Vocabulary: ${summary.vars} vars, ${summary.conds} conditions, ${summary.cases} cases`);
console.log(`Recording script: ${summary.groups} groups, ${summary.lines} lines, ${summary.takes} takes`);
console.log(`Lines with no config text: ${summary.linesWithoutText.length} (${list(summary.linesWithoutText)})`);
console.log(`Groups no callout or var draws from: ${list(summary.groupsWithoutConsumer)}`);
console.log(
  `Lines no callout or var draws from, in groups something else does: ${summary.linesWithoutConsumer.length} (${list(summary.linesWithoutConsumer)})`,
);
console.log(`Vocabulary no callout uses: ${list(summary.unusedVocabulary)}`);
