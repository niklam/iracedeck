import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

// The plugin folder's own manifest, one level down: `<folder>/manifest.json`.
// Deeper `manifest.json` files (a bundled dependency's) are not the plugin's.
const MANIFEST_ENTRY = /^[^/]+\/manifest\.json$/;

/**
 * @param {Record<string, Uint8Array>} entries
 * @returns {string}
 */
function manifestEntryName(entries) {
  const names = Object.keys(entries).filter((name) => MANIFEST_ENTRY.test(name));
  if (names.length !== 1) {
    throw new Error(`Expected exactly one <folder>/manifest.json in the package, found ${names.length}`);
  }
  return names[0];
}

/**
 * The `Version` of the plugin manifest inside a packed plugin archive.
 *
 * @param {Uint8Array} zip
 * @returns {string}
 */
export function readPackedManifestVersion(zip) {
  const entries = unzipSync(zip);
  return JSON.parse(strFromU8(entries[manifestEntryName(entries)])).Version;
}

/**
 * A copy of a packed plugin archive whose manifest `Version` is `version`,
 * every other entry carried over byte for byte (issue #1298: `@elgato/cli pack`
 * pads the version to four parts on its way into the archive, whatever the
 * folder's manifest says).
 *
 * @param {Uint8Array} zip
 * @param {string} version
 * @returns {Uint8Array}
 */
export function setPackedManifestVersion(zip, version) {
  const entries = unzipSync(zip);
  const name = manifestEntryName(entries);
  const manifest = JSON.parse(strFromU8(entries[name]));
  manifest.Version = version;
  entries[name] = strToU8(JSON.stringify(manifest, null, 2) + "\n");
  return zipSync(entries);
}
