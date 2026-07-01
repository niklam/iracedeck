#!/usr/bin/env node
/**
 * Generates packages/iracing-actions/src/actions/data/profiles.json from the
 * Elgato plugin manifest's `Profiles` array (issue #736). The Switch Profile
 * action consumes it to populate a device-filtered profile dropdown.
 *
 * Run: pnpm generate:action-profiles
 * A freshness test (generate-action-profiles.test.mjs) fails if the committed
 * JSON drifts from the manifest.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

export const MANIFEST_FILE = path.resolve(
  __dirname,
  "../packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json",
);
export const OUTPUT_FILE = path.resolve(__dirname, "../packages/iracing-actions/src/actions/data/profiles.json");

/**
 * Extract the `{ name, deviceType }[]` list the action needs from a parsed
 * Elgato manifest's `Profiles` array (order preserved).
 */
export function buildProfilesData(manifest) {
  const profiles = Array.isArray(manifest.Profiles) ? manifest.Profiles : [];
  return profiles.map((p) => ({ name: p.Name, deviceType: p.DeviceType }));
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf-8"));
  const data = buildProfilesData(manifest);
  writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log(`Generated ${OUTPUT_FILE}`);
  console.log(`Profiles: ${data.length}`);
}

// Run only when invoked directly (not when imported by the freshness test).
if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
