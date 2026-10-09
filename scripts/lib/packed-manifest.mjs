import {
  configure,
  TextReader,
  TextWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";

// zip.js is the library `@elgato/cli pack` writes these archives with: every
// entry carries a zip64 extra and 0xFFFFFFFF in its 32-bit sizes, with no zip64
// end record. fflate 0.8.3 takes those sizes at face value and allocates 4 GB
// per entry, which failed the first CI run (#1298).
configure({ useWebWorkers: false });

// The plugin folder's own manifest, one level down: `<folder>/manifest.json`.
// Deeper `manifest.json` files (a bundled dependency's) are not the plugin's.
const MANIFEST_ENTRY = /^[^/]+\/manifest\.json$/;

/**
 * @template {{ filename: string }} T
 * @param {T[]} entries
 * @returns {T}
 */
function manifestEntry(entries) {
  const found = entries.filter((entry) => MANIFEST_ENTRY.test(entry.filename));
  if (found.length !== 1) {
    throw new Error(`Expected exactly one <folder>/manifest.json in the package, found ${found.length}`);
  }
  return found[0];
}

/**
 * The `Version` of the plugin manifest inside a packed plugin archive.
 *
 * @param {Uint8Array} zip
 * @returns {Promise<string>}
 */
export async function readPackedManifestVersion(zip) {
  const reader = new ZipReader(new Uint8ArrayReader(zip));
  try {
    const manifest = await manifestEntry(await reader.getEntries()).getData(new TextWriter());
    return JSON.parse(manifest).Version;
  } finally {
    await reader.close();
  }
}

/**
 * A copy of a packed plugin archive whose manifest `Version` is `version`,
 * every other entry's content and modification date carried over (issue #1298:
 * `@elgato/cli pack` pads the version to four parts on its way into the
 * archive, whatever the folder's manifest says).
 *
 * @param {Uint8Array} zip
 * @param {string} version
 * @returns {Promise<Uint8Array>}
 */
export async function setPackedManifestVersion(zip, version) {
  const reader = new ZipReader(new Uint8ArrayReader(zip));
  const writer = new ZipWriter(new Uint8ArrayWriter());
  try {
    const entries = await reader.getEntries();
    const manifestName = manifestEntry(entries).filename;

    for (const entry of entries) {
      const options = { lastModDate: entry.lastModDate };
      if (entry.directory) {
        await writer.add(entry.filename, undefined, { ...options, directory: true });
      } else if (entry.filename === manifestName) {
        const manifest = JSON.parse(await entry.getData(new TextWriter()));
        manifest.Version = version;
        await writer.add(entry.filename, new TextReader(JSON.stringify(manifest, null, 2) + "\n"), options);
      } else {
        await writer.add(entry.filename, new Uint8ArrayReader(await entry.getData(new Uint8ArrayWriter())), options);
      }
    }
    return await writer.close();
  } finally {
    await reader.close();
  }
}
