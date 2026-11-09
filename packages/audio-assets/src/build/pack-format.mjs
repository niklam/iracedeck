/**
 * The voice-pack FORMAT as the packer writes it (#1034, #1667): where the
 * sources live, the manifest it builds, the archive writer and its pinned zip
 * options, and the two walks over a voice's source tree.
 *
 * Split out of `scripts/pack-voice.mjs` so the pack record (`pack-record.mjs`)
 * can compute what an archive is built from without importing the packer,
 * which imports the record module to write one — the cycle the spec forbids.
 * `pack-voice.mjs` re-exports the names it always exported, so its consumers
 * (`scripts/publish-voice-packs.mjs`, `stage-dev-voices.mjs`, the tests) are
 * unchanged.
 */
import { CALLOUT_SCRIPT_FILE, displayLabel, VOICE_PACK_MANIFEST_SCHEMA_VERSION } from "@iracedeck/callout-script";
import { zipSync } from "fflate";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { audioAssetsPath } from "./index.mjs";
import { installedPackageVersion } from "./installed-version.mjs";

export { serializeSortedJson, sortKeysDeep } from "./stable-json.mjs";

/**
 * @typedef {import("./voice-packs.mjs").VoicePackDefinition} VoicePackDefinition
 * @typedef {{ id: string; label: string }} VoiceEntry
 * @typedef {{ path: string; data: Uint8Array }} ArchiveEntry
 */

/** The source clip root's name: `voice/<voice-id>/…`, in the package and in a pack alike. */
export const VOICE_ROOT = "voice";

/** Where the per-voice generator configs live: `<voice-id>.voice.json`, whose `label` the pack declares. */
export const CONFIGS_DIR = path.join(audioAssetsPath, "configs");

/** Where committed catalog entries live: one `<id>.json` per published pack. */
export const CATALOG_DIR = path.join(audioAssetsPath, "catalog");

/** The manifest's file name inside the archive — what the voice-packs scanner opens. */
export const MANIFEST_FILE = "voice-pack.json";

/**
 * The modification time recorded on every archive entry: the DOS epoch, which
 * is also the earliest time a zip can represent.
 *
 * Built from LOCAL date fields on purpose. fflate converts `mtime` to the zip's
 * DOS date/time with `getFullYear()`, `getMonth()`, `getDate()`, `getHours()`
 * and so on — local-time getters — so a fixed INSTANT (the same epoch written
 * as `new Date(315532800000)`) would encode differently on every machine east
 * or west of Greenwich, and on any machine west of it would read as 1979 and be
 * refused outright. Fixed FIELDS encode identically everywhere.
 *
 * `ZIP_ENTRY_MTIME_FIELDS` is the same instant as the `Date` constructor's
 * arguments — what `archiveFormatIdentity` records, since a `Date` has no
 * machine-independent JSON form.
 */
export const ZIP_ENTRY_MTIME_FIELDS = Object.freeze(
  /** @type {readonly [number, number, number, number, number, number]} */ ([1980, 0, 1, 0, 0, 0]),
);
const ZIP_ENTRY_MTIME = new Date(...ZIP_ENTRY_MTIME_FIELDS);

/**
 * Per-entry zip options, every one of them pinned.
 *
 * - `level` fixed, because deflate output depends on it. 9 rather than the
 *   default 6: an archive is built once and downloaded many times, so the
 *   build is the right place to spend the CPU — even though MP3 data is already
 *   entropy-coded and gains little from any level.
 * - `mtime` — see `ZIP_ENTRY_MTIME`. Left unset, fflate stamps `Date.now()`.
 * - `os: 0` (MS-DOS) and `attrs: 0` — no origin platform, no permission bits.
 *   Unset they happen to encode as zero today, but the archive's bytes should
 *   not depend on what fflate does with `undefined`.
 * - no `extra` and no `comment`, so nothing platform-specific rides along.
 */
export const ZIP_ENTRY_OPTIONS = Object.freeze({ level: 9, mtime: ZIP_ENTRY_MTIME, os: 0, attrs: 0 });

/**
 * Everything the archive's bytes depend on besides its entries (#1667): the
 * installed `fflate` release that writes it and the per-entry options above,
 * in a JSON-safe form — the mtime as its date fields, never as a `Date`,
 * whose JSON form (`toISOString`) depends on the machine's time zone. The pack
 * record hashes this as `inputs.archiveFormat`.
 *
 * Changing how the archive is built in a way this does not capture (the entry
 * order, say) is covered by the packer's own determinism test and by the
 * publish step, as it always was.
 */
export function archiveFormatIdentity() {
  const { level, os, attrs } = ZIP_ENTRY_OPTIONS;

  return {
    fflate: installedPackageVersion("fflate", import.meta.url),
    zipEntryOptions: { level, mtime: [...ZIP_ENTRY_MTIME_FIELDS], os, attrs },
  };
}

/**
 * The voice's display name, from its generator config — the per-voice source
 * of truth. Read as JSON rather than through the generator's Zod schema, since
 * the label is the only field the packer needs and pulling the whole
 * generator module in would mean running under tsx for one string.
 *
 * @param {string} configsDir
 * @param {string} voiceId
 * @returns {string}
 */
export function readVoiceLabel(configsDir, voiceId) {
  const file = path.join(configsDir, `${voiceId}.voice.json`);

  if (!existsSync(file)) throw new Error(`voice "${voiceId}": no ${file}`);

  const label = JSON.parse(readFileSync(file, "utf-8")).label;

  // The manifest schema's own `displayLabel` rule, so a label this accepts is
  // one the scanner accepts.
  if (!displayLabel.safeParse(label).success) {
    throw new Error(`voice "${voiceId}": ${file} needs a "label" of 1-60 characters with no control characters`);
  }

  return label;
}

/**
 * The pack's voices as the manifest and the catalog entry list them: each
 * voice id with the label its config declares.
 *
 * @param {VoicePackDefinition} pack
 * @param {string} configsDir
 * @returns {VoiceEntry[]}
 */
export function readVoiceEntries(pack, configsDir) {
  return pack.voices.map((voiceId) => ({ id: voiceId, label: readVoiceLabel(configsDir, voiceId) }));
}

/**
 * The `voice-pack.json` object: exactly `VoicePackManifestSchema`'s shape,
 * nothing more. Unknown fields would be ignored by the scanner, but they would
 * also change the archive's bytes for no reader's benefit.
 *
 * @param {VoicePackDefinition} pack
 * @param {readonly VoiceEntry[]} voices
 */
export function buildVoicePackManifest(pack, voices) {
  return {
    schema: VOICE_PACK_MANIFEST_SCHEMA_VERSION,
    id: pack.id,
    label: pack.label,
    version: pack.version,
    ...(pack.author === undefined ? {} : { author: pack.author }),
    voices: voices.map(({ id, label }) => ({ id, label })),
  };
}

/**
 * The archive bytes for `{ path, data }` entries. Pure and synchronous — the
 * entries are its only input, so the same clips always give the same bytes,
 * which is what the determinism test calls twice and compares.
 *
 * Entries are sorted by path BEFORE being handed to fflate: it writes them in
 * object-insertion order, and both the local headers and the central directory
 * record that order, so the same files added in a different order are a
 * different archive. Sorted by UTF-16 code unit, never `localeCompare`, so the
 * order cannot depend on the building machine's locale.
 *
 * Paths are FLAT keys (`voice/default/flags/blue-01.mp3`), never nested
 * objects: fflate turns a nested object into an explicit directory entry of
 * zero bytes, and an installer walking entries would then have `voice/` and
 * `voice/default/` to reject or special-case. Flat keys also sidestep V8's
 * integer-key ordering — a key such as `"4"` would be hoisted ahead of the
 * sort — though no path here can be one, since every path contains a slash.
 *
 * @param {readonly ArchiveEntry[]} entries
 */
export function createArchive(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  /** @type {Record<string, [Uint8Array, typeof ZIP_ENTRY_OPTIONS]>} */
  const zippable = {};

  for (const { path: entryPath, data } of sorted) {
    if (entryPath.startsWith("/") || entryPath.includes("\\") || entryPath.split("/").includes("..")) {
      throw new Error(`archive entry must be a relative POSIX path: ${entryPath}`);
    }

    if (entryPath in zippable) throw new Error(`duplicate archive entry: ${entryPath}`);

    zippable[entryPath] = [data, ZIP_ENTRY_OPTIONS];
  }

  return zipSync(zippable);
}

/**
 * Every `.mp3` under `dir`, recursively, as POSIX paths relative to `dir`,
 * sorted by UTF-16 code unit. Regular files only (`Dirent.isFile()`), with the
 * extension matched case-insensitively — the same two rules the pipeline's
 * walk (`buildVoiceTreeTasks`) stages by, so the two agree on what a clip is.
 *
 * Deliberately a second, independent walk rather than a list the pipeline
 * reports about itself: it exists to check that pipeline, and a list derived
 * from the thing being checked would agree with it by construction. The
 * pack record's per-voice clip digest is taken over this list, so the record
 * and the packer's completeness check count the same files.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function listSourceClips(dir) {
  /** @type {string[]} */
  const found = [];

  const walk = (/** @type {string} */ current, /** @type {string} */ relative) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;

      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp3")) found.push(rel);
    }
  };

  walk(dir, "");

  return found.sort();
}

/**
 * How many `.mp3` files `dir` holds, recursively — `listSourceClips`' length,
 * so a count and a digest of the same tree can never disagree about which
 * files are clips.
 *
 * @param {string} dir
 * @returns {number}
 */
export function countSourceClips(dir) {
  return listSourceClips(dir).length;
}

/**
 * The exact-name rule for a voice's callout script (#1064): the file named
 * exactly `callouts.json` DIRECTLY under the voice's source tree, found in a
 * directory listing the way the walk (`buildVoiceTreeTasks`) decides what to
 * stage — never with `existsSync`, which is case-insensitive on Windows. A
 * `Callouts.json` would otherwise validate, be skipped by the walk, and ship a
 * pack that is silent for no reason anyone can see.
 *
 * Returns the script's path, or `null` for a clips-only voice, and the
 * wrong-cased name when the listing has one so the packer can refuse it by
 * name. Whether the path is a REGULAR file — the walk stages only what
 * `Dirent.isFile()` admits — is the caller's `lstat` to make, since the packer
 * and the record report that differently.
 *
 * @param {string} srcDir — the voice's source tree, `<srcRoot>/<voice-id>`
 * @returns {{ file: string | null; wrongCase: string | undefined }}
 */
export function locateCalloutScript(srcDir) {
  const names = readdirSync(srcDir);
  const wrongCase = names.find((name) => name !== CALLOUT_SCRIPT_FILE && name.toLowerCase() === CALLOUT_SCRIPT_FILE);
  const file = names.includes(CALLOUT_SCRIPT_FILE) ? path.join(srcDir, CALLOUT_SCRIPT_FILE) : null;

  return { file, wrongCase };
}
