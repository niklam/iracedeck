#!/usr/bin/env node
/**
 * Generates packages/iracing-actions/src/actions/data/action-comms.json from
 * the authoritative TS catalog (comms-catalog.ts), for the PI templates and
 * docs to consume (issue #612).
 *
 * Run with tsx so the TypeScript catalog imports resolve:
 *   pnpm generate:action-comms
 * A freshness test (comms-catalog.test.ts) fails if the committed JSON drifts
 * from the catalog.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { COMMS_CATALOG } from "../packages/iracing-actions/src/actions/comms-catalog.ts";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.resolve(__dirname, "../packages/iracing-actions/src/actions/data/action-comms.json");

writeFileSync(OUTPUT_FILE, JSON.stringify(COMMS_CATALOG, null, 2) + "\n", "utf-8");

console.log(`Generated ${OUTPUT_FILE}`);
console.log(`Actions: ${Object.keys(COMMS_CATALOG).length}`);
