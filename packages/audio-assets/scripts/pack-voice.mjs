#!/usr/bin/env node
/**
 * Packs authored voices into distributable voice packs (#1034, stage 2).
 *
 * For every pack in `VOICE_PACKS` (or just the ids named on the command line):
 *
 *   1. runs each of the pack's voices through the SAME radio-filter + encode
 *      pipeline the plugin build uses (`processVoiceTree`), so a packaged clip
 *      is byte-identical to what the plugin would otherwise have shipped;
 *   2. stages `voice-pack.json` + `voice/<voice-id>/<group>/<name>.mp3` — and
 *      each voice's `voice/<voice-id>/callouts.json` (#1064), copied as-is once
 *      it has passed the grammar the scanner will apply — under
 *      `dist/voice-packs/<id>/` — the exact shape the voice-packs scanner accepts,
 *      kept there so a maintainer can inspect it or sideload it by hand;
 *   3. zips that stage, deterministically, to `dist/voice-packs/<id>-<version>.zip`
 *      — unless `--stage-only` is given (#1214), which stops at step 2;
 *   4. writes `catalog/<id>.json` with the archive's byte size and sha-256, the
 *      entry the website build assembles into `voice-catalog.json`, and beside
 *      it `pack-records/<id>.json` (#1667), the record of what the archive was
 *      built from that `src/pack-record.test.ts` holds the tree to — unless
 *      `--no-catalog` is given (#1143), which stops at step 3.
 *
 * Usage: pnpm --filter @iracedeck/audio-assets pack:voice [<pack-id> ...] [--no-catalog | --stage-only]
 *        node packages/audio-assets/scripts/pack-voice.mjs [<pack-id> ...] [--no-catalog | --stage-only]
 *
 * `--no-catalog` stages and zips without touching `catalog/<id>.json` — for an
 * archive nobody should commit, such as a sideload or an inspection. That
 * entry is the release contract — its `sha256` is what the installer compares
 * against an installed pack — so a run whose only purpose is a staged tree or
 * a throwaway archive must not rewrite it. It is per run, not a mode: the
 * release workflow keeps calling this script without it. (Before #1214 it was
 * the development loop's flag; the build's `stage:dev-voices` task now stages
 * with `--stage-only`, below.)
 *
 * `--stage-only` is stricter still (#1214): it stages the tree, with every
 * check a full run makes before the zip (the callout script's grammar, the
 * staged-vs-source clip count, `USABLE_VOICE_CLIP`, the manifest), and writes no
 * archive and no catalog entry. It is what the build's `stage:dev-voices` task
 * runs, because a development root is scanned as a DIRECTORY — the scanner
 * lists directories only — so the zip would be seconds of deflate nobody
 * reads. An archive left in `dist/voice-packs/` by an earlier full run is left
 * alone: it sits beside the stage, not in it, the scanner never opens it, and
 * deleting a file a maintainer may have built on purpose is not this flag's
 * business.
 *
 * A SEALED VERSION IS FROZEN (#1667). When the record carries `released` at
 * the pack's current version, the archive published under it must not change:
 * a flagless run still packs, so the author has the archive to inspect, but
 * if its sha-256 differs from `released.sha256` the run writes neither the
 * entry nor the record and names the bump. An unchanged archive under a
 * sealed version (an `ffmpeg-static` bump that left the output identical,
 * say) writes the record with the new inputs; no bump is needed. Inputs
 * decide when a re-pack is due, bytes decide when a bump is due. `released`
 * itself is written only by the release hook and `seal:voice-packs`; this
 * script preserves whatever it finds.
 *
 * Only the catalog entry and the record are committed. The archive is a GitHub release asset,
 * attached to the release the entry's `url` names by
 * `scripts/publish-voice-packs.mjs` — from the plugin's tag workflow on every
 * release, or from the manual "Publish voice packs" workflow between releases
 * (#1116). It is never uploaded by hand; this script prints where it will go.
 *
 * BYTE-DETERMINISM IS THE CONTRACT, not a nicety. The catalog's `sha256` is
 * what the installer compares against an installed pack to decide whether a
 * download is due, so a packer that produced different bytes from the same
 * clips would republish a new hash on every build and make every user
 * re-download 12.5 MB for nothing — precisely the problem the catalog design
 * exists to prevent. A zip records an entry order, a per-entry timestamp, an
 * origin OS and attributes, and optional extra fields, and every one of those
 * would vary between builds if left to defaults. This script pins all of them
 * (`ZIP_ENTRY_OPTIONS` and `createArchive` in `src/build/pack-format.mjs`), and `pack-voice.test.ts`
 * proves it by packing twice and comparing hashes rather than by trusting the
 * reasoning here.
 */
import {
  CALLOUT_SCRIPT_FILE,
  calloutScriptPath,
  dedupeDeclaredVoices,
  isSemverVersion,
  packId,
  parseCalloutScriptText,
  USABLE_VOICE_CLIP,
  validateVoicePackManifest,
} from "@iracedeck/callout-script";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { audioAssetsPath, processVoiceTree, VOICE_PACKS } from "../src/build/index.mjs";
import {
  buildVoicePackManifest,
  CATALOG_DIR,
  CONFIGS_DIR,
  countSourceClips,
  createArchive,
  locateCalloutScript,
  MANIFEST_FILE,
  readVoiceEntries,
  serializeSortedJson,
  VOICE_ROOT,
} from "../src/build/pack-format.mjs";
import {
  buildPackRecord,
  computePackInputs,
  PACK_RECORDS_DIR,
  readPackRecord,
  writePackRecord,
} from "../src/build/pack-record.mjs";

// The pack format moved to `src/build/pack-format.mjs` (#1667) so the pack
// record can compute an archive's inputs without importing the packer. These
// names stay exported from here, unchanged, for the publish script, the
// dev-voices stager and the tests.
export {
  buildVoicePackManifest,
  CATALOG_DIR,
  countSourceClips,
  createArchive,
  MANIFEST_FILE,
  serializeSortedJson,
} from "../src/build/pack-format.mjs";

/**
 * Where staged pack trees and archives land. Gitignored (`.gitignore` beside
 * `package.json`): an archive is a release asset, never a repository file.
 */
export const OUTPUT_DIR = path.join(audioAssetsPath, "dist", "voice-packs");

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
 * @typedef {import("../src/build/pack-format.mjs").VoiceEntry} VoiceEntry
 * @typedef {import("../src/build/pack-format.mjs").ArchiveEntry} ArchiveEntry
 * @typedef {ReturnType<typeof buildCatalogEntry>} CatalogEntry
 *
 * @typedef {object} PackVoiceOptions
 * @property {VoicePackDefinition} pack
 * @property {string} [srcRoot] — holds `<voice-id>/…` source clip trees
 * @property {string} [configsDir] — holds `<voice-id>.voice.json`
 * @property {string} [outDir] — stage directory and archive land here
 * @property {string} [catalogDir] — `<pack-id>.json` lands here
 * @property {string} [recordsDir] — the pack record `<pack-id>.json` lands here, beside the entry (#1667)
 * @property {string} [cacheDir] — processed-clip cache root; see `packVoice`
 * @property {boolean} [writeCatalog] — false leaves `catalogDir` and `recordsDir` untouched
 * @property {boolean} [writeArchive] — false writes no archive, no catalog entry and no record (`--stage-only`)
 * @property {(message: string) => void} [logger]
 *
 * @typedef {object} PackedPack — a full run: stage, archive, and (unless withheld) the catalog entry and the record
 * @property {string} archivePath
 * @property {string} stageDir
 * @property {string | undefined} catalogPath — `undefined` when `writeCatalog` was false
 * @property {string | undefined} recordPath — `undefined` when `writeCatalog` was false
 * @property {CatalogEntry} entry
 * @property {number} clips
 * @property {number} scripts
 *
 * @typedef {object} StagedPack — a `--stage-only` run: the stage and nothing else
 * @property {undefined} archivePath
 * @property {string} stageDir
 * @property {undefined} catalogPath
 * @property {undefined} recordPath
 * @property {undefined} entry
 * @property {number} clips
 * @property {number} scripts
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
 * Is `value` a version this script may write verbatim?
 *
 * Stricter than the scanner, on purpose. `isSemverVersion` is exactly what the
 * plugin ACCEPTS — `semver.valid`, which trims and allows one leading `v` — but
 * the packer does not only hand a version to the plugin: it writes it verbatim
 * into the release tag (`voices-<id>-<version>`), the archive's file name, the
 * catalog entry's `url` and the manifest. `" 1.1.2"` or `"v1.1.2"` would be a
 * version the plugin reads fine and a tag, a file name and a download url
 * nobody meant. So the definition must hold the CANONICAL spelling: a string
 * the plugin accepts, with no surrounding whitespace and no leading `v`.
 *
 * @param {unknown} value
 */
function isCanonicalVersion(value) {
  return typeof value === "string" && isSemverVersion(value) && value === value.trim() && !value.startsWith("v");
}

/** @param {import("zod").ZodType} schema @param {unknown} value */
function firstProblem(schema, value) {
  const parsed = schema.safeParse(value);

  return parsed.success ? undefined : (parsed.error.issues[0]?.message ?? "invalid");
}

/**
 * The checks a pack DEFINITION needs before anything is read from disk — the
 * ones the manifest cannot make for it. Everything the manifest carries is
 * judged afterwards by the plugin's own schema, on the very object this script
 * will write (`assertPackManifest`), so the packer holds no copy of those rules.
 *
 * What stays here, and why each:
 *
 * - `id` and every voice id, through the schema's own `packId` — because they
 *   become PATHS (the stage directory, `configs/<voice-id>.voice.json`, the
 *   voice's source tree) before there is a manifest to validate, and an id the
 *   plugin would refuse must never reach the filesystem.
 * - `version` and `minPluginVersion` in their canonical spelling
 *   ({@link isCanonicalVersion}) — a rule the plugin does not have, because only
 *   the packer writes a version into a tag, a file name and a url. Each is
 *   checked for being a string first, so a number fails naming the field.
 * - `description`'s 300-character bound — `VoicePackCatalogEntrySchema`'s
 *   (voice-packs), which this plain-node script cannot import, for a field the
 *   manifest does not carry; the test parses the catalog entry with it.
 * - `voices` being a non-empty list, since everything after iterates it.
 *
 * Each message names the pack.
 */
function assertPackDefinition(pack) {
  const where = `pack "${pack?.id ?? "?"}"`;
  const idProblem = firstProblem(packId, pack?.id);

  if (idProblem !== undefined) throw new Error(`${where}: id ${idProblem}`);
  if (!isCanonicalVersion(pack.version)) {
    throw new Error(
      `${where}: version must be a canonical semver version such as 1.2.3 — a string, no leading "v", ` +
        `no surrounding whitespace — since it names the release tag, the archive and the catalog url`,
    );
  }
  if (pack.description !== undefined && (typeof pack.description !== "string" || pack.description.length > 300)) {
    throw new Error(`${where}: description must be 300 characters or fewer`);
  }
  if (pack.minPluginVersion !== undefined && !isCanonicalVersion(pack.minPluginVersion)) {
    throw new Error(
      `${where}: minPluginVersion must be a canonical semver version such as 1.2.3 — a string, no leading "v", ` +
        `no surrounding whitespace`,
    );
  }
  if (!Array.isArray(pack.voices) || pack.voices.length === 0) {
    throw new Error(`${where}: voices must name at least one voice`);
  }
  for (const voice of pack.voices) {
    const voiceProblem = firstProblem(packId, voice);

    if (voiceProblem !== undefined) throw new Error(`${where}: voice id "${voice}" ${voiceProblem}`);
  }
}

/**
 * Refuse to build a `voice-pack.json` the plugin would refuse, or one that
 * repeats a voice — judged on the very object this script is about to write,
 * by the plugin's own rules from `@iracedeck/callout-script` (#1134).
 *
 * `validateVoicePackManifest` is the schema the scanner admits a pack by, so a
 * field the packer does not check itself — an empty `author`, a pack label
 * over 60 characters or holding a control character — fails here, naming the
 * field in the plugin's words, instead of surfacing as a pack the scanner
 * refuses after it has been uploaded. A repeated voice is a build FAILURE,
 * where the scanner only keeps the first and says so: a definition that lists
 * a voice twice is a typo, and nobody should ship one.
 *
 * Run before anything is staged, so a refused pack leaves no stage behind.
 *
 * @param {VoicePackDefinition} pack
 * @param {ReturnType<typeof buildVoicePackManifest>} manifest
 */
function assertPackManifest(pack, manifest) {
  const where = `pack "${pack.id}"`;
  const validated = validateVoicePackManifest(manifest);

  if (!validated.ok) {
    throw new Error(
      `${where}: the ${MANIFEST_FILE} it would write is one the plugin refuses:\n  ${validated.problems.join("\n  ")}`,
    );
  }

  const { repeated } = dedupeDeclaredVoices(manifest.voices);

  if (repeated.length > 0) {
    throw new Error(`${where}: voice "${repeated[0]}" is listed more than once in voices`);
  }
}

/**
 * Refuse to pack a callout script the scanner would refuse (#1064).
 *
 * The scanner drops a voice whose `callouts.json` fails to read, to parse or
 * to validate — so a pack carrying one would install cleanly, provide nothing,
 * and be silent, with the only trace a line in Installed Voices on the user's
 * machine. Checked HERE, before a single clip of the voice is staged, with the
 * grammar's own text stage (`parseCalloutScriptText`): the very function the
 * scanner runs over the same bytes — BOM strip, JSON, grammar — so the two
 * cannot disagree about what is acceptable. A voice with no script at all is
 * a clips-only voice, which is valid.
 *
 * The file is found by its EXACT name in a directory listing
 * (`locateCalloutScript`, the rule the pack record shares), the way the walk
 * (`buildVoiceTreeTasks`) decides what to stage — not with `existsSync`, which
 * is case-insensitive on Windows. A `Callouts.json` would otherwise validate
 * here, be skipped by the walk, and ship a pack that is silent for no reason
 * anyone can see; so a wrong-cased name is refused outright, naming the one
 * the walk and the scanner look for.
 *
 * It must also be a REGULAR FILE, by `lstat` — the walk stages only what
 * `Dirent.isFile()` says is one, and a symlink, a junction or a directory of
 * that name is not. `readFileSync` follows a symlink, so without this check a
 * link to a valid script would validate here and then not be staged: the
 * same silent pack as the wrong-cased name, by another route.
 *
 * @param {VoicePackDefinition} pack
 * @param {string} voiceId
 * @param {string} srcDir — the voice's source tree, `<srcRoot>/<voice-id>`
 */
function assertCalloutScript(pack, voiceId, srcDir) {
  const where = `pack "${pack.id}": ${calloutScriptPath(voiceId)}`;
  const { file, wrongCase } = locateCalloutScript(srcDir);

  if (wrongCase !== undefined) {
    throw new Error(
      `${where} found "${wrongCase}" — a callout script must be named exactly "${CALLOUT_SCRIPT_FILE}" ` +
        `(lowercase); the packer stages, and the plugin reads, only that name`,
    );
  }

  if (file === null) return;

  // The stat and the read are reported apart from the grammar's verdict, as
  // the scanner reports them: an EACCES — or a file that vanished between the
  // listing and here — is not "invalid JSON", and the author fixing it should
  // not be sent to look for a syntax error, nor be handed a raw Node error.
  const unreadable = (err) =>
    new Error(`${where} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  let stat;
  let text;

  try {
    stat = lstatSync(file);
  } catch (err) {
    throw unreadable(err);
  }

  if (!stat.isFile()) {
    throw new Error(`${where} must be a regular file — a symlink, junction or directory of that name is not staged`);
  }

  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    throw unreadable(err);
  }

  // One text stage, the scanner's: a JSON failure is the grammar's first
  // problem (`(document): not valid JSON: …`), listed like any other.
  const parsed = parseCalloutScriptText(text);

  if (!parsed.ok) {
    throw new Error(`${where} is not a script the plugin accepts:\n  ${parsed.problems.join("\n  ")}`);
  }
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
 * files the pipeline just wrote — the clips, and the voice's `callouts.json`
 * when it has one — never from a directory walk, so a stale file could not
 * reach the archive anyway — but the on-disk stage should be the pack and
 * nothing else, since it is what a maintainer inspects or sideloads.
 *
 * Resolves to the archive, stage, catalog and record paths, the catalog entry,
 * and two counts: `clips` (mp3s, across every voice) and `scripts` (voices
 * that ship a callout script). The script is never counted as a clip. With
 * `writeCatalog` false the entry is still computed and returned — only the
 * FILES are withheld, and `catalogPath` and `recordPath` are then `undefined`.
 *
 * With `writeArchive` false (`--stage-only`, #1214) the run stops once the
 * stage and its manifest are written: no archive, so no entry to compute and
 * no catalog or record to write, whatever `writeCatalog` says. `archivePath`,
 * `entry`, `catalogPath` and `recordPath` are then all `undefined`; every
 * check above still runs, since each is about the stage rather than the zip.
 *
 * The record (#1667) is written with the entry and only with it: the same
 * run, so the two cannot disagree. An existing record's `released` is carried
 * over untouched, and when it names the pack's current version a changed
 * archive is refused before either file is written (see the header).
 *
 * Typed as three overloads so a caller gets the result shape its
 * `writeArchive` implies: a literal `false` resolves to a `StagedPack`, `true`
 * or nothing to a `PackedPack`, and a `boolean` known only at run time to
 * either, to be told apart by `entry`.
 *
 * @overload
 * @param {PackVoiceOptions & { writeArchive: false }} options
 * @returns {Promise<StagedPack>}
 */
/**
 * @overload
 * @param {PackVoiceOptions & { writeArchive?: true }} options
 * @returns {Promise<PackedPack>}
 */
/**
 * @overload
 * @param {PackVoiceOptions} options
 * @returns {Promise<StagedPack | PackedPack>}
 */
/**
 * @param {PackVoiceOptions} options
 * @returns {Promise<StagedPack | PackedPack>}
 */
export async function packVoice({
  pack,
  srcRoot = path.join(audioAssetsPath, VOICE_ROOT),
  configsDir = CONFIGS_DIR,
  outDir = OUTPUT_DIR,
  catalogDir = CATALOG_DIR,
  recordsDir = PACK_RECORDS_DIR,
  cacheDir,
  writeCatalog = true,
  writeArchive = true,
  logger,
} = {}) {
  if (!pack) throw new Error("packVoice: pack is required");
  assertPackDefinition(pack);

  const voices = readVoiceEntries(pack, configsDir);
  const manifest = buildVoicePackManifest(pack, voices);

  assertPackManifest(pack, manifest);

  const stageDir = path.join(outDir, pack.id);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  /** @type {ArchiveEntry[]} */
  const entries = [];
  let clips = 0;
  let scripts = 0;

  for (const voiceId of pack.voices) {
    const srcDir = path.join(srcRoot, voiceId);

    if (!existsSync(srcDir)) throw new Error(`pack "${pack.id}": voice "${voiceId}" has no clips at ${srcDir}`);

    assertCalloutScript(pack, voiceId, srcDir);

    const destDir = path.join(stageDir, VOICE_ROOT, voiceId);
    const { files, script } = await processVoiceTree({
      srcDir,
      destDir,
      cacheDir: cacheDir === undefined ? undefined : path.join(cacheDir, voiceId),
      logger,
    });

    // The scanner refuses a voice with no usable clip and reports it; the packer
    // refuses to BUILD one. The same check per clip, below, is what turns a clip
    // the scanner would skip into a failure at the only point it is cheap.
    if (files.length === 0) throw new Error(`pack "${pack.id}": voice "${voiceId}" has no .mp3 clips under ${srcDir}`);

    // And refuses to build a SHORT one. Emptiness is the easy failure; the
    // dangerous one is a pack that is merely incomplete, because every check
    // downstream passes it: the archive hashes fine, `voice-pack.json` parses,
    // a `voice/<id>/` directory exists, and the scanner loads it and reports no
    // problem. The engineer would simply be silent for whatever was missing,
    // which is indistinguishable from a callout nobody wrote.
    //
    // Nothing else in the pipeline can notice, so it is asserted here: the
    // number of clips staged must equal the number the source holds. Found the
    // hard way — a reviewer questioned the archive's size and the only way to
    // answer was to count both trees by hand.
    const sourceClips = countSourceClips(srcDir);

    if (files.length !== sourceClips) {
      throw new Error(
        `pack "${pack.id}": voice "${voiceId}" staged ${files.length} of ${sourceClips} source clips — ` +
          `the pipeline dropped ${sourceClips - files.length}`,
      );
    }

    for (const file of files) {
      const entryPath = `${VOICE_ROOT}/${voiceId}/${file}`;

      // The scanner's grammar for a clip the engine can reach, imported from
      // `@iracedeck/callout-script`. A clip it refuses is a build FAILURE, never
      // a warning: a pack carrying it would install cleanly, list its voice,
      // and then be silent for that clip — with the only trace at debug level
      // on the user's machine.
      if (!USABLE_VOICE_CLIP.test(entryPath)) {
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

    clips += files.length;

    // The script rides beside the clips, at the path the scanner opens. Read
    // back from the stage like the clips are, so the archive holds exactly
    // what a maintainer would sideload — `processVoiceTree` copied it byte
    // for byte, and the test proves that against the source.
    if (script !== null) {
      entries.push({
        path: `${VOICE_ROOT}/${voiceId}/${script}`,
        data: new Uint8Array(readFileSync(path.join(destDir, script))),
      });
      scripts++;
    }
  }

  const manifestBytes = new TextEncoder().encode(serializeSortedJson(manifest));
  writeFileSync(path.join(stageDir, MANIFEST_FILE), manifestBytes);
  entries.push({ path: MANIFEST_FILE, data: manifestBytes });

  // `--stage-only`: the stage is the product. Nothing under `outDir` beside
  // the stage and nothing under `catalogDir` or `recordsDir` is created,
  // opened or removed.
  if (!writeArchive) {
    return {
      archivePath: undefined,
      stageDir,
      catalogPath: undefined,
      recordPath: undefined,
      entry: undefined,
      clips,
      scripts,
    };
  }

  const archive = createArchive(entries);
  const archivePath = path.join(outDir, archiveFileName(pack));
  writeFileSync(archivePath, archive);

  const sha256 = createHash("sha256").update(archive).digest("hex");
  const entry = buildCatalogEntry(pack, voices, { bytes: archive.byteLength, sha256 });

  // The entry is built either way — a caller that wants it can have it without
  // a second pack — but with `writeCatalog` false nothing under `catalogDir`
  // or `recordsDir` is created, opened or removed, not even the directories
  // themselves. The paths are the flag's witnesses: `undefined` is what a
  // caller reads, and what the summary lines print as "not written".
  if (!writeCatalog) {
    return { archivePath, stageDir, catalogPath: undefined, recordPath: undefined, entry, clips, scripts };
  }

  // The seal check (#1667), before either file is written. The archive stays
  // in `outDir` for inspection; a record that cannot be read is a failure too,
  // since without it nobody can tell whether this version is sealed.
  const previous = readPackRecord(pack.id, recordsDir);
  const released = previous?.released;

  if (released !== undefined && released.version === pack.version && released.sha256 !== sha256) {
    throw new Error(
      `pack "${pack.id}": version ${pack.version} is released with sha256 ${released.sha256}, and the archive just ` +
        `packed has sha256 ${sha256} — a published archive never changes under its version. Bump \`version\` in ` +
        `src/build/voice-packs.mjs and re-run pack:voice ${pack.id}; neither catalog/${pack.id}.json nor ` +
        `pack-records/${pack.id}.json was written (the archive is at ${archivePath} for inspection)`,
    );
  }

  // The inputs are recomputed from the source tree the archive was just built
  // from — the same walk, the same exact-name rule — so the record describes
  // this archive and nothing else.
  const inputs = computePackInputs(pack, { srcRoot, configsDir });
  const catalogPath = path.join(catalogDir, `${pack.id}.json`);

  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(catalogPath, `${JSON.stringify(entry, null, 2)}\n`);

  const recordPath = writePackRecord(buildPackRecord(pack, { sha256, inputs, released }), recordsDir);

  return { archivePath, stageDir, catalogPath, recordPath, entry, clips, scripts };
}

/**
 * The command line: bare words are pack ids; the options are `--no-catalog`
 * (stage and zip, no catalog entry) and `--stage-only` (stage, no archive and
 * no catalog entry). Given both, `--stage-only` wins, being the stricter.
 *
 * An unknown option is refused rather than taken for a pack id, because both
 * ways of being lenient are worse than a message. Treating `--nocatalog` as an
 * id would fail with "unknown pack" — a message about the wrong thing —
 * and ignoring it would write the very committed entry the author typed the
 * flag to spare, silently.
 *
 * @param {readonly string[]} argv — `process.argv.slice(2)`
 * @returns {{ ids: string[]; writeCatalog: boolean; writeArchive: boolean }}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const ids = [];
  let writeCatalog = true;
  let writeArchive = true;

  for (const arg of argv) {
    if (arg === "--no-catalog") writeCatalog = false;
    else if (arg === "--stage-only") {
      writeArchive = false;
      writeCatalog = false;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option "${arg}" — the options are --no-catalog and --stage-only`);
    } else ids.push(arg);
  }

  return { ids, writeCatalog, writeArchive };
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
  const { ids, writeCatalog, writeArchive } = parseArgs(process.argv.slice(2));

  for (const pack of selectPacks(ids)) {
    const result = await packVoice({ pack, writeCatalog, writeArchive, logger: (message) => console.log(message) });

    if (result.entry === undefined) {
      console.log(
        `Staged ${pack.id}@${pack.version}: ${result.clips} clips, ${result.scripts} callout ` +
          `${result.scripts === 1 ? "script" : "scripts"}`,
      );
      console.log(`  stage    ${result.stageDir}`);
      console.log(`  archive  not written (--stage-only)`);
      console.log(`  catalog  not written (--stage-only)`);
      console.log(`  record   not written (--stage-only)`);
      continue;
    }

    console.log(
      `Packed ${pack.id}@${pack.version}: ${result.clips} clips, ${result.scripts} callout ` +
        `${result.scripts === 1 ? "script" : "scripts"}, ${result.entry.bytes} bytes`,
    );
    console.log(`  sha256   ${result.entry.sha256}`);
    console.log(`  archive  ${result.archivePath}`);
    console.log(`  catalog  ${result.catalogPath ?? "not written (--no-catalog)"}`);
    console.log(`  record   ${result.recordPath ?? "not written (--no-catalog)"}`);
    console.log(
      `  release  ${releaseTag(pack)} (asset ${archiveFileName(pack)}, published by scripts/publish-voice-packs.mjs)`,
    );
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
