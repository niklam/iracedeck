/**
 * Constants the voice-pack modules share without depending on one another
 * (issue #1034). A leaf module with no imports.
 *
 * The voice-pack setting keys and `ENSURED_VOICE_PACK_ID` moved to
 * `@iracedeck/app-constants` (spec #1351), so the settings schema and the
 * run-scoped-key enrolment name them without reaching into this stack.
 */

/**
 * A lowercase hex sha-256 digest — the archive hash the catalog publishes, the
 * installer computes, and `.install.json` records.
 *
 * One pattern rather than four copies, because those four are the same value
 * being handed between modules: the catalog states it, the downloader compares
 * what it computed against it, the storage layer names a staging directory
 * after it, and the provenance record keeps it for the next update check. A
 * copy that drifted would not fail loudly — it would make one module refuse a
 * digest another had just accepted, which reads as a corrupt download.
 *
 * Case is pinned rather than normalised on purpose: two spellings of one digest
 * compare unequal, and the bug that produces is a silent re-download of a pack
 * that was already installed.
 *
 * A plain RegExp, not a Zod schema, so this module keeps its no-imports
 * property and a module that only needs the pattern acquires no
 * validation-library edge for it.
 */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** The message every schema built on {@link SHA256_HEX_PATTERN} reports. */
export const SHA256_HEX_MESSAGE = "must be a lowercase hex sha-256 digest";

/**
 * The installer's provenance record, written into a pack directory.
 *
 * Named here rather than in `voice-pack-provenance.ts` so the scanner and the
 * storage layer can agree on the filename without either depending on the
 * other, and without the leaf that names it pulling in a parser.
 */
export const VOICE_PACK_PROVENANCE_FILE = ".install.json";
