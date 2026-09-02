#!/usr/bin/env node
/**
 * Packs authored voices into distributable voice packs (#1034, stage 2).
 *
 * For every pack in `VOICE_PACKS` (or just the ids named on the command line):
 *
 *   1. runs each of the pack's voices through the SAME radio-filter + encode
 *      pipeline the plugin build uses (`processVoiceTree`), so a packaged clip
 *      is byte-identical to what the plugin would otherwise have shipped;
 *   2. stages `voice-pack.json` + `voice/<voice-id>/<group>/<name>.mp3` under
 *      `dist/voice-packs/<id>/` — the exact shape deck-core's scanner accepts,
 *      kept there so a maintainer can inspect it or sideload it by hand;
 *   3. zips that stage, deterministically, to `dist/voice-packs/<id>-<version>.zip`;
 *   4. writes `catalog/<id>.json` with the archive's byte size and sha-256, the
 *      entry the website build assembles into `voice-catalog.json`.
 *
 * Usage: pnpm --filter @iracedeck/audio-assets pack:voice [<pack-id> ...]
 *        node packages/audio-assets/scripts/pack-voice.mjs [<pack-id> ...]
 *
 * Only the catalog entry is committed. The archive is a GitHub release asset,
 * uploaded to the release the entry's `url` names — the script prints both.
 *
 * BYTE-DETERMINISM IS THE CONTRACT, not a nicety. The catalog's `sha256` is
 * what the installer compares against an installed pack to decide whether a
 * download is due, so a packer that produced different bytes from the same
 * clips would republish a new hash on every build and make every user
 * re-download 12.5 MB for nothing — precisely the problem the catalog design
 * exists to prevent. A zip records an entry order, a per-entry timestamp, an
 * origin OS and attributes, and optional extra fields, and every one of those
 * would vary between builds if left to defaults. This script pins all of them
 * (see `ZIP_ENTRY_OPTIONS` and `createArchive`), and `pack-voice.test.ts`
 * proves it by packing twice and comparing hashes rather than by trusting the
 * reasoning here.
 */
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { audioAssetsPath, processVoiceTree, VOICE_PACKS } from "../src/build/index.mjs";

const VOICE_ROOT = "voice";
const CONFIGS_DIR = path.join(audioAssetsPath, "configs");

/** Where committed catalog entries live: one `<id>.json` per published pack. */
export const CATALOG_DIR = path.join(audioAssetsPath, "catalog");

/**
 * Where staged pack trees and archives land. Gitignored (`.gitignore` beside
 * `package.json`): an archive is a release asset, never a repository file.
 */
export const OUTPUT_DIR = path.join(audioAssetsPath, "dist", "voice-packs");

/** The manifest's file name inside the archive — what deck-core's scanner opens. */
export const MANIFEST_FILE = "voice-pack.json";

/**
 * Where archives are hosted. GitHub Releases rather than the website's
 * `public/`, because a 12.5 MB archive per pack version would bloat every site
 * deploy and the git history for good. One release per pack version, tagged
 * `voices-<id>-<version>`, holding one asset `<id>-<version>.zip` — the two
 * helpers below are the only place that convention is spelled out.
 */
export const RELEASE_DOWNLOAD_BASE = "https://github.com/niklam/iracedeck/releases/download";

/**
 * @typedef {import("../src/build/voice-packs.mjs").VoicePackDefinition} VoicePackDefinition
 * @typedef {{ id: string; version: string }} PackIdentity
 * @typedef {{ id: string; label: string }} VoiceEntry
 * @typedef {{ path: string; data: Uint8Array }} ArchiveEntry
 */

/** @param {PackIdentity} pack */
export function releaseTag({ id, version }) {
  return `voices-${id}-${version}`;
}

/** @param {PackIdentity} pack */
export function archiveFileName({ id, version }) {
  return `${id}-${version}.zip`;
}

/** @param {PackIdentity} pack */
export function archiveUrl(pack) {
  return `${RELEASE_DOWNLOAD_BASE}/${releaseTag(pack)}/${archiveFileName(pack)}`;
}

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
 */
const ZIP_ENTRY_MTIME = new Date(1980, 0, 1, 0, 0, 0);

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
const ZIP_ENTRY_OPTIONS = Object.freeze({ level: 9, mtime: ZIP_ENTRY_MTIME, os: 0, attrs: 0 });

/**
 * The scanner's own grammar for a clip the engine can reach — `USABLE_CLIP` in
 * deck-core's `voice-pack-scanner.ts`, restated because that module is
 * TypeScript and this script runs under plain node. Exactly four segments:
 * `voice/<voice-id>/<group>/<name>.mp3`, lowercase extension. The test keeps
 * the two in agreement by running the REAL scanner over a staged pack rather
 * than trusting this copy.
 *
 * A clip this refuses is a build FAILURE, never a warning. A pack carrying it
 * would install cleanly, claim its voice, and then be silent for that clip —
 * with the only trace at debug level on the user's machine.
 */
const USABLE_CLIP = /^voice\/[^/]+\/[^/]+\/[^/]+\.mp3$/;

/**
 * Light, plain-node versions of the rules deck-core's `VoicePackManifestSchema`
 * and `VoicePackCatalogEntrySchema` enforce. Those schemas are the authority
 * (the test parses this script's output with them); these exist so a typo in
 * `voice-packs.mjs` fails HERE, naming the field, instead of surfacing as a
 * pack the scanner refuses after it has been uploaded.
 */
const PACK_ID = /^[a-z][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function assertPackDefinition(pack) {
  const where = `pack "${pack?.id ?? "?"}"`;

  if (!PACK_ID.test(pack?.id ?? "")) throw new Error(`${where}: id must be lowercase kebab-case`);
  if (
    typeof pack.label !== "string" ||
    pack.label.length === 0 ||
    pack.label.length > 60 ||
    CONTROL_CHARS.test(pack.label)
  ) {
    throw new Error(`${where}: label must be 1-60 characters with no control characters`);
  }
  if (!SEMVER.test(pack.version ?? "")) throw new Error(`${where}: version must be semver`);
  if (pack.description !== undefined && (typeof pack.description !== "string" || pack.description.length > 300)) {
    throw new Error(`${where}: description must be 300 characters or fewer`);
  }
  if (pack.minPluginVersion !== undefined && !SEMVER.test(pack.minPluginVersion)) {
    throw new Error(`${where}: minPluginVersion must be semver`);
  }
  if (!Array.isArray(pack.voices) || pack.voices.length === 0)
    throw new Error(`${where}: voices must name at least one voice`);
  for (const voice of pack.voices) {
    if (!PACK_ID.test(voice)) throw new Error(`${where}: voice id "${voice}" must be lowercase kebab-case`);
  }
}

/**
 * The voice's display name, from its generator config — the per-voice source
 * of truth. Read as JSON rather than through the generator's Zod schema, since
 * the label is the only field this script needs and pulling the whole
 * generator module in would mean running under tsx for one string.
 */
function readVoiceLabel(configsDir, voiceId) {
  const file = path.join(configsDir, `${voiceId}.voice.json`);

  if (!existsSync(file)) throw new Error(`voice "${voiceId}": no ${file}`);

  const label = JSON.parse(readFileSync(file, "utf-8")).label;

  if (typeof label !== "string" || label.length === 0 || label.length > 60 || CONTROL_CHARS.test(label)) {
    throw new Error(`voice "${voiceId}": ${file} needs a "label" of 1-60 characters with no control characters`);
  }

  return label;
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
    schema: 1,
    id: pack.id,
    label: pack.label,
    version: pack.version,
    ...(pack.author === undefined ? {} : { author: pack.author }),
    voices: voices.map(({ id, label }) => ({ id, label })),
  };
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }

  return value;
}

/**
 * JSON with keys sorted at every depth, two-space indent, LF line endings and
 * a trailing newline. The archived manifest goes through this: `JSON.stringify`
 * writes keys in insertion order, so two code paths building the same object
 * in different orders would produce two different archives.
 *
 * @param {unknown} value
 */
export function serializeSortedJson(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
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
 * The catalog entry, in the field order the design spec's example uses so the
 * committed file reads the way the spec does. Order is fixed by construction
 * — that is all determinism needs from a file that is never hashed.
 *
 * @param {VoicePackDefinition} pack
 * @param {readonly VoiceEntry[]} voices
 * @param {{ bytes: number; sha256: string }} archive
 */
export function buildCatalogEntry(pack, voices, { bytes, sha256 }) {
  return {
    id: pack.id,
    label: pack.label,
    version: pack.version,
    ...(pack.description === undefined ? {} : { description: pack.description }),
    voices: voices.map(({ id, label }) => ({ id, label })),
    bytes,
    sha256,
    url: archiveUrl(pack),
    ...(pack.minPluginVersion === undefined ? {} : { minPluginVersion: pack.minPluginVersion }),
  };
}

/**
 * Pack one voice pack. Every location is injectable so the tests can run the
 * whole thing — pipeline included — against a temporary tree, a temporary
 * cache and a temporary output, without touching the repository's own.
 *
 * `cacheDir`, when given, is the processed-clip cache ROOT for this pack; each
 * voice gets `<cacheDir>/<voice-id>`. Left out, `processVoiceTree` uses the
 * build's shared `.cache/<pipeline-hash>/voice/<voice-id>` — the very files
 * the plugin build copies into the distributable, which is what makes a
 * packed clip identical to a shipped one by construction.
 *
 * The stage directory is wiped first. The archive is built from the list of
 * clips the pipeline just wrote, never from a directory walk, so a stale file
 * could not reach the archive anyway — but the on-disk stage should be the
 * pack and nothing else, since it is what a maintainer inspects or sideloads.
 *
 * @param {object} options
 * @param {VoicePackDefinition} options.pack
 * @param {string} [options.srcRoot] — holds `<voice-id>/…` source clip trees
 * @param {string} [options.configsDir] — holds `<voice-id>.voice.json`
 * @param {string} [options.outDir] — stage directory and archive land here
 * @param {string} [options.catalogDir] — `<pack-id>.json` lands here
 * @param {string} [options.cacheDir] — processed-clip cache root; see above
 * @param {(message: string) => void} [options.logger]
 */
export async function packVoice({
  pack,
  srcRoot = path.join(audioAssetsPath, VOICE_ROOT),
  configsDir = CONFIGS_DIR,
  outDir = OUTPUT_DIR,
  catalogDir = CATALOG_DIR,
  cacheDir,
  logger,
} = {}) {
  if (!pack) throw new Error("packVoice: pack is required");
  assertPackDefinition(pack);

  const stageDir = path.join(outDir, pack.id);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  /** @type {ArchiveEntry[]} */
  const entries = [];
  /** @type {VoiceEntry[]} */
  const voices = [];

  for (const voiceId of pack.voices) {
    voices.push({ id: voiceId, label: readVoiceLabel(configsDir, voiceId) });

    const srcDir = path.join(srcRoot, voiceId);

    if (!existsSync(srcDir)) throw new Error(`pack "${pack.id}": voice "${voiceId}" has no clips at ${srcDir}`);

    const destDir = path.join(stageDir, VOICE_ROOT, voiceId);
    const { files } = await processVoiceTree({
      srcDir,
      destDir,
      cacheDir: cacheDir === undefined ? undefined : path.join(cacheDir, voiceId),
      logger,
    });

    // The scanner refuses a voice with no usable clip and reports it; the packer
    // refuses to BUILD one. The same check per clip, below, is what turns a clip
    // the scanner would skip into a failure at the only point it is cheap.
    if (files.length === 0) throw new Error(`pack "${pack.id}": voice "${voiceId}" has no .mp3 clips under ${srcDir}`);

    for (const file of files) {
      const entryPath = `${VOICE_ROOT}/${voiceId}/${file}`;

      if (!USABLE_CLIP.test(entryPath)) {
        throw new Error(
          `pack "${pack.id}": ${entryPath} is not a clip the engine can play — ` +
            `clips must be voice/<voice-id>/<group>/<name>.mp3, with a lowercase .mp3 extension`,
        );
      }

      // Copied out of the Buffer: a small `readFileSync` result can be a view
      // into Node's shared pool, and while fflate honours a view's offset, the
      // archive should not be built on that being true of every code path.
      entries.push({ path: entryPath, data: new Uint8Array(readFileSync(path.join(destDir, file))) });
    }
  }

  const manifestBytes = new TextEncoder().encode(serializeSortedJson(buildVoicePackManifest(pack, voices)));
  writeFileSync(path.join(stageDir, MANIFEST_FILE), manifestBytes);
  entries.push({ path: MANIFEST_FILE, data: manifestBytes });

  const archive = createArchive(entries);
  const archivePath = path.join(outDir, archiveFileName(pack));
  writeFileSync(archivePath, archive);

  const entry = buildCatalogEntry(pack, voices, {
    bytes: archive.byteLength,
    sha256: createHash("sha256").update(archive).digest("hex"),
  });
  const catalogPath = path.join(catalogDir, `${pack.id}.json`);
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(catalogPath, `${JSON.stringify(entry, null, 2)}\n`);

  return { archivePath, stageDir, catalogPath, entry, clips: entries.length - 1 };
}

function selectPacks(requestedIds) {
  if (requestedIds.length === 0) return VOICE_PACKS;

  return requestedIds.map((id) => {
    const pack = VOICE_PACKS.find((candidate) => candidate.id === id);

    if (!pack) throw new Error(`unknown pack "${id}" — known packs: ${VOICE_PACKS.map((p) => p.id).join(", ")}`);

    return pack;
  });
}

async function main() {
  for (const pack of selectPacks(process.argv.slice(2))) {
    const result = await packVoice({ pack, logger: (message) => console.log(message) });

    console.log(`Packed ${pack.id}@${pack.version}: ${result.clips} clips, ${result.entry.bytes} bytes`);
    console.log(`  sha256   ${result.entry.sha256}`);
    console.log(`  archive  ${result.archivePath}`);
    console.log(`  catalog  ${result.catalogPath}`);
    console.log(`  upload the archive as ${archiveFileName(pack)} to release ${releaseTag(pack)}`);
  }
}

// Direct-exec guard: only run main() when this file was executed as the entry
// script. Tolerate missing argv[1] (e.g., when imported by a test runner) so
// importing the helpers doesn't pack anything at module-eval time.
const invokedPath = process.argv[1];
if (
  invokedPath &&
  (import.meta.url === url.pathToFileURL(invokedPath).href || invokedPath === url.fileURLToPath(import.meta.url))
) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
