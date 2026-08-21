#!/usr/bin/env node
/**
 * Publishes the machine-readable changelog the plugin's update check reads
 * (issue #1016): packages/website/public/changelog.json, served by Astro as
 * https://iracedeck.com/changelog.json.
 *
 * Deliberately the SAME two functions the plugin's own artifact is built with
 * (scripts/generate-changelog-data.mjs), over the same changelog.mdx, so the
 * published file and the compiled-in one cannot drift. Regenerated on every
 * `dev`/`build` and gitignored, like the icon gallery.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import {
  buildChangelogData,
  CHANGELOG_SOURCE_PATH,
  serializeChangelogData,
} from "../../../scripts/lib/changelog-data.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const outputFile = path.join(repoRoot, "packages", "website", "public", "changelog.json");

const data = buildChangelogData(readFileSync(path.join(repoRoot, CHANGELOG_SOURCE_PATH), "utf-8"));

mkdirSync(path.dirname(outputFile), { recursive: true });
writeFileSync(outputFile, serializeChangelogData(data), "utf-8");

console.log(`Generated ${outputFile}`);
console.log(`Releases: ${data.releases.length}`);
