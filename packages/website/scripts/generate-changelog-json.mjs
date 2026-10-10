#!/usr/bin/env node
/**
 * Publishes the machine-readable changelog the plugin's update check reads
 * (issue #1016): packages/website/public/changelog.json, served by Astro as
 * https://iracedeck.com/changelog.json.
 *
 * Deliberately the SAME function the plugin's own artifact is built with
 * (scripts/generate-changelog-data.mjs): changelog.mdx with the fragments of
 * changelog.d/ composed in as the Unreleased release (#1386), so the published
 * file and the compiled-in one cannot drift. Regenerated on every `dev`/`build`
 * and gitignored, like the icon gallery.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { buildComposedChangelogData } from "../../../scripts/lib/changelog-composed.mjs";
import { serializeChangelogData } from "../../../scripts/lib/changelog-data.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const outputFile = path.join(repoRoot, "packages", "website", "public", "changelog.json");

const data = buildComposedChangelogData(repoRoot);

mkdirSync(path.dirname(outputFile), { recursive: true });
writeFileSync(outputFile, serializeChangelogData(data), "utf-8");

console.log(`Generated ${outputFile}`);
console.log(`Releases: ${data.releases.length}`);
