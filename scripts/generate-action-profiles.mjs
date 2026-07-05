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
 * Device-name suffixes used in bundled profile names (issue #753). Mirrors
 * `PROFILE_DEVICE_SUFFIXES` in `packages/deck-core/src/device-profiles.ts` —
 * this script runs under plain node and can't import the TS module, so the
 * freshness test cross-checks the two lists and the stripping behavior.
 */
export const PROFILE_DEVICE_SUFFIXES = ["SD", "Mini", "XL", "Plus", "Neo", "Corsair Galleon", "Plus XL"];

/** Longest-first so `iRaceDeck Default Plus XL` strips `Plus XL`, never `XL`. */
const SUFFIXES_LONGEST_FIRST = [...PROFILE_DEVICE_SUFFIXES].sort((a, b) => b.length - a.length);

/** Display name of a bundled profile: the manifest name minus its trailing device suffix. */
function stripDeviceSuffix(name) {
  for (const suffix of SUFFIXES_LONGEST_FIRST) {
    if (name.endsWith(` ${suffix}`)) return name.slice(0, -(suffix.length + 1));
  }
  return name;
}

/**
 * Extract the `{ name, deviceType, displayName }[]` list the actions and PI
 * templates need from a parsed Elgato manifest's `Profiles` array (order
 * preserved). `displayName` is the user-facing name — the manifest name with
 * its device suffix stripped (issue #753).
 */
export function buildProfilesData(manifest) {
  const profiles = Array.isArray(manifest.Profiles) ? manifest.Profiles : [];
  return profiles.map((p) => ({ name: p.Name, deviceType: p.DeviceType, displayName: stripDeviceSuffix(p.Name) }));
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
