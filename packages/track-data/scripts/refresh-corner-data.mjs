/**
 * Refresh the committed corner snapshot from lovely-track-data (issue #888).
 *
 * Usage:
 *   pnpm --filter @iracedeck/track-data build
 *   node packages/track-data/scripts/refresh-corner-data.mjs
 *
 * Data: https://github.com/Lovely-Sim-Racing/lovely-track-data
 * License: CC BY-NC-SA 4.0 — used in iRaceDeck with permission (issue #888).
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCornerSnapshot } from "../dist/refresh.js";

const RAW_BASE = "https://raw.githubusercontent.com/Lovely-Sim-Racing/lovely-track-data/main/data";
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "corners.iracing.json");

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

const manifest = await fetchJson(`${RAW_BASE}/manifest.json`);
const iracingTracks = manifest.tracks?.iracing ?? [];
if (iracingTracks.length === 0) throw new Error("manifest.json has no iracing tracks — dataset layout changed?");

const files = [];
for (const track of iracingTracks) {
  files.push(await fetchJson(`${RAW_BASE}/${track.path}`));
}

const snapshot = buildCornerSnapshot(files);
const sorted = Object.fromEntries(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(OUT_PATH, `${JSON.stringify(sorted, null, "\t")}\n`);
console.log(`Wrote ${Object.keys(sorted).length} tracks to ${OUT_PATH}`);
