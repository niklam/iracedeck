#!/usr/bin/env node
/**
 * Generates packages/iracing-actions/src/actions/data/changelog.json from the
 * public changelog (packages/website/src/content/docs/changelog.mdx) and the
 * in-development fragments in changelog.d/, so the plugin's Settings window can
 * render its own What's New pane instead of embedding the website (issue #1011).
 *
 * The fragments are composed in as the `_Unreleased_` release through
 * scripts/lib/changelog-composed.mjs, the same path the website's published copy
 * takes (#1386). The output is a gitignored build artifact: turbo's
 * `//#generate:changelog-data` task runs this before every plugin build, and the
 * post-edit hook runs it after a changelog or fragment edit. By hand:
 *   pnpm generate:changelog-data
 *
 * Every rule of the fragment format and of `.claude/rules/changelog.md` is
 * checked on the way, so a malformed source fails here, naming the file and line.
 *
 * `--out <file>` writes somewhere else instead; the website bytes-equal test uses
 * it so it never rewrites the tree's artifact under a running build.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { parseArgs } from "node:util";

import { buildComposedChangelogData } from "./lib/changelog-composed.mjs";
import { CHANGELOG_DATA_PATH, serializeChangelogData } from "./lib/changelog-data.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const { values } = parseArgs({ options: { out: { type: "string" } } });
const outputFile = values.out ? path.resolve(values.out) : path.join(repoRoot, CHANGELOG_DATA_PATH);

const data = buildComposedChangelogData(repoRoot);
writeFileSync(outputFile, serializeChangelogData(data), "utf-8");

const bullets = data.releases.reduce(
  (total, release) => total + release.categories.reduce((sum, category) => sum + category.items.length, 0),
  0,
);

console.log(`Generated ${outputFile}`);
console.log(`Releases: ${data.releases.length}, bullets: ${bullets}`);
