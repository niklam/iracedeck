/**
 * Loads the voice-pack record module for the release hook and the seal
 * command, turning "the tree is not built" into a sentence (#1667).
 *
 * `packages/audio-assets/src/build/pack-record.mjs` imports `index.mjs` and
 * `pack-format.mjs`, which import `@iracedeck/callout-script` — a workspace
 * package resolved through its `dist/`, which only `pnpm build` writes. On a
 * fresh clone or after `pnpm clean`, a static import of the record module from
 * a root script dies at module evaluation with a raw `ERR_MODULE_NOT_FOUND`
 * naming an internal path, before the script has printed a word. Both entry
 * points therefore import it here, dynamically, and a missing module becomes an
 * error that names the command to run. Any other failure is rethrown as it is.
 *
 * `importer` is injectable so the two shapes are tested without a broken tree.
 */

/** The record module and the format module (`selectPacks`), by URL, relative to this file. */
const PACK_RECORD_URL = new URL("../../packages/audio-assets/src/build/pack-record.mjs", import.meta.url).href;
const PACK_FORMAT_URL = new URL("../../packages/audio-assets/src/build/pack-format.mjs", import.meta.url).href;

/**
 * Node's two spellings of "that module is not there": ESM resolution, and a
 * CommonJS `require` inside something the module loads.
 *
 * @param {unknown} err
 */
export function isModuleNotFound(err) {
  const code = /** @type {{ code?: unknown }} */ (err)?.code;

  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/**
 * @typedef {typeof import("../../packages/audio-assets/src/build/pack-record.mjs") & {
 *   selectPacks: typeof import("../../packages/audio-assets/src/build/pack-format.mjs").selectPacks;
 * }} PackRecordModule
 */

/**
 * The record module's exports plus `selectPacks`, or an Error whose message
 * names `pnpm build` when either module (or anything they import) cannot be
 * found. Nothing is written on either path.
 *
 * @param {(url: string) => Promise<Record<string, unknown>>} [importer] — a test's seam; `import()` by default
 * @returns {Promise<PackRecordModule>}
 */
export async function loadPackRecordModule(importer = (url) => import(url)) {
  try {
    const [record, format] = await Promise.all([importer(PACK_RECORD_URL), importer(PACK_FORMAT_URL)]);

    return /** @type {PackRecordModule} */ ({ ...record, selectPacks: format.selectPacks });
  } catch (err) {
    if (!isModuleNotFound(err)) throw err;

    throw new Error(
      `The voice-pack record module could not be loaded: ${err instanceof Error ? err.message : err}\n` +
        "The tree is not built — the record module imports @iracedeck/callout-script, whose dist/ only the build " +
        "writes. Run `pnpm build`, then run this again. Nothing was written.",
      { cause: err },
    );
  }
}
