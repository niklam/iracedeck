#!/usr/bin/env node
/**
 * Generates packages/iracing-actions/src/actions/data/getting-started.json from
 * the Getting Started page
 * (packages/website/src/content/docs/docs/getting-started/first-steps.md), so
 * the plugin's Settings window renders the same page the website does, offline
 * and with no fetch (issue #1061).
 *
 * Run after editing the page:
 *   pnpm generate:getting-started-data
 *
 * A freshness test (generate-getting-started-data.test.mjs) fails if the
 * committed JSON drifts from the source, and the parser throws on anything the
 * pane could not render.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import {
  buildGettingStartedData,
  GETTING_STARTED_DATA_PATH,
  GETTING_STARTED_SOURCE_PATH,
  serializeGettingStartedData,
} from "./lib/getting-started-data.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const sourceFile = path.join(repoRoot, GETTING_STARTED_SOURCE_PATH);
const outputFile = path.join(repoRoot, GETTING_STARTED_DATA_PATH);

const data = buildGettingStartedData(readFileSync(sourceFile, "utf-8"));
writeFileSync(outputFile, serializeGettingStartedData(data), "utf-8");

const blocks = data.sections.reduce((total, section) => total + section.blocks.length, 0);
const actions = data.sections.reduce(
  (total, section) => total + section.blocks.filter((block) => block.type === "action").length,
  0,
);

console.log(`Generated ${outputFile}`);
console.log(`Sections: ${data.sections.length}, blocks: ${blocks}, controls: ${actions}`);
