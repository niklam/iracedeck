#!/usr/bin/env node
/**
 * Generates packages/iracing-actions/src/actions/data/changelog.json from the
 * public changelog (packages/website/src/content/docs/changelog.mdx), so the
 * plugin's Settings window can render its own What's New pane instead of
 * embedding the website (issue #1011).
 *
 * Run after editing the changelog:
 *   pnpm generate:changelog-data
 *
 * A freshness test (generate-changelog-data.test.mjs) fails if the committed
 * JSON drifts from the source, and the parser throws on an entry that does not
 * follow the format in `.claude/rules/changelog.md`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import {
  buildChangelogData,
  CHANGELOG_DATA_PATH,
  CHANGELOG_SOURCE_PATH,
  serializeChangelogData,
} from "./lib/changelog-data.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const sourceFile = path.join(repoRoot, CHANGELOG_SOURCE_PATH);
const outputFile = path.join(repoRoot, CHANGELOG_DATA_PATH);

const data = buildChangelogData(readFileSync(sourceFile, "utf-8"));
writeFileSync(outputFile, serializeChangelogData(data), "utf-8");

const bullets = data.releases.reduce(
  (total, release) => total + release.categories.reduce((sum, category) => sum + category.items.length, 0),
  0,
);

console.log(`Generated ${outputFile}`);
console.log(`Releases: ${data.releases.length}, bullets: ${bullets}`);
