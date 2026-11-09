/**
 * The pack record (#1667): what each published voice pack's archive was built
 * from, committed as `pack-records/<id>.json` beside `catalog/<id>.json`, and
 * the four rules every pack is held to.
 *
 * Why it exists. The committed catalog entry records an archive's `bytes` and
 * `sha256`, and only the publish script re-derives them — in the tag workflow,
 * after encoding every clip. So a pack's clips or script could change on
 * `master` with nothing red until a release was tagged (#1582, #1665). The
 * record stores a digest of every input the archive is a function of, and a
 * test recomputes them from the tree in under a second, offline, with no
 * ffmpeg: a stale entry fails on the author's machine, naming the input that
 * changed and the commands to run.
 *
 * Two mistakes need telling apart, and only a tree that knows what has been
 * RELEASED can: an input that changed with no re-pack (fix: re-run
 * `pack:voice`), and a re-pack under a version whose archive is already
 * published (fix: bump the version first). `released` is that knowledge,
 * written by the release hook and the seal command (`sealPackRecords`) and
 * preserved untouched by the packer.
 *
 * This module OWNS the computation and the rules. The packer, the test, the
 * release hook and the publish script import it; none restates it, and it
 * imports nothing from `scripts/pack-voice.mjs` (the format it needs is
 * `pack-format.mjs`), so there is no cycle. It is pure where it can be: no
 * `process.exit`, no console; problems come back as data, and only
 * `sealPackRecords` writes.
 *
 * Design record: docs/superpowers/specs/2026-11-08-issue-1667-voice-pack-version-guard.md.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import { z } from "zod";

import { audioAssetsPath, PIPELINE_IDENTITY, pipelineIdentityHash } from "./index.mjs";
import {
  archiveFormatIdentity,
  buildVoicePackManifest,
  CATALOG_DIR,
  CONFIGS_DIR,
  listSourceClips,
  locateCalloutScript,
  readVoiceEntries,
  serializeSortedJson,
  VOICE_ROOT,
} from "./pack-format.mjs";
import { VOICE_PACKS } from "./voice-packs.mjs";

/** Where the committed records live: one `<id>.json` per published pack, beside `catalog/`. */
export const PACK_RECORDS_DIR = path.join(audioAssetsPath, "pack-records");

/** The command that re-packs one pack, as every fix names it. */
const PACK_COMMAND = "pnpm --filter @iracedeck/audio-assets pack:voice";

/** The registry, as the messages name it. */
const REGISTRY_FILE = "src/build/voice-packs.mjs";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase 64-hex-digit sha-256");

const VoiceInputsSchema = z.strictObject({
  clips: z.number().int().nonnegative(),
  clipsSha256: sha256Hex,
  script: sha256Hex.nullable(),
});

const PackInputsSchema = z.strictObject({
  pipeline: sha256Hex,
  archiveFormat: sha256Hex,
  manifest: sha256Hex,
  voices: z.record(z.string(), VoiceInputsSchema),
});

const ReleasedSchema = z.strictObject({ version: z.string(), sha256: sha256Hex });

/**
 * The record's shape — strict, so a hand-edited or misspelled key fails the
 * read rather than being ignored into a record that agrees with nothing.
 */
export const PackRecordSchema = z.strictObject({
  id: z.string(),
  version: z.string(),
  sha256: sha256Hex,
  inputs: PackInputsSchema,
  released: ReleasedSchema.optional(),
});

/**
 * @typedef {import("./voice-packs.mjs").VoicePackDefinition} VoicePackDefinition
 * @typedef {z.infer<typeof VoiceInputsSchema>} VoiceInputs
 * @typedef {z.infer<typeof PackInputsSchema>} PackInputs
 * @typedef {z.infer<typeof ReleasedSchema>} ReleasedSeal
 * @typedef {z.infer<typeof PackRecordSchema>} PackRecord
 *
 * @typedef {object} PackRoots — where the tree is; every one defaults to this package's own
 * @property {string} [srcRoot] — holds `<voice-id>/…` source clip trees (`voice/`)
 * @property {string} [configsDir] — holds `<voice-id>.voice.json` (`configs/`)
 * @property {string} [catalogDir] — holds `<pack-id>.json` entries (`catalog/`)
 * @property {string} [recordsDir] — holds `<pack-id>.json` records (`pack-records/`)
 * @property {import("./index.d.ts").PipelineIdentity} [pipelineIdentity] — a test's seam; defaults to `PIPELINE_IDENTITY`
 * @property {ReturnType<typeof archiveFormatIdentity>} [archiveFormat] — a test's seam; defaults to `archiveFormatIdentity()`
 *
 * @typedef {object} PackRecordProblem — one thing wrong with one pack's record
 * @property {string} pack — the pack id (a stray record's file stem)
 * @property {string} part — what is wrong: `record`, `registry`, `id`, `version`, `sha256`, `entry`,
 *   `released`, `inputs.pipeline`, `inputs.archiveFormat`, `inputs.manifest`, `voices.<id>.clips`, `voices.<id>.script`
 * @property {string} message — what differs, naming the pack and the file, for example
 *   `default: the clips under voice/default changed (4,811 now, 4,810 recorded)`
 * @property {string} fix — what to do about it, with the exact commands
 */

/** @param {Uint8Array | string} bytes */
function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {number} n — formatted the way the spec's examples read: `4,810` */
const count = (n) => n.toLocaleString("en-US");

/**
 * `pack-records/<id>.json` under `recordsDir`.
 *
 * @param {string} id
 * @param {string} [recordsDir]
 */
export function packRecordPath(id, recordsDir = PACK_RECORDS_DIR) {
  return path.join(recordsDir, `${id}.json`);
}

/**
 * One voice's inputs: how many source clips it has, one digest over all of
 * them, and the digest of its callout script.
 *
 * `clipsSha256` is the sha-256 of one line per `.mp3` under `srcDir`, sorted
 * by POSIX relative path by code unit — the walk and the case rules of
 * `listSourceClips`, which `countSourceClips` shares — each line
 * `<path>\0<sha-256 of the bytes>\n`. Content only, never mtime: a copy or a
 * touch with identical bytes changes nothing, the rule #1143 settled for the
 * encode cache. Aggregate rather than per clip, so the record is a few lines
 * a parallel clip PR cannot conflict on, and the failure still says which
 * voice's clips moved.
 *
 * `script` is the sha-256 of the `callouts.json` the packer would stage,
 * found by the exact-name rule (`locateCalloutScript`) and only if it is a
 * regular file, since the walk stages nothing else; `null` for a clips-only
 * voice. Kept apart from the clips so a script-only change — #1582's — is
 * named as one.
 *
 * @param {string} srcDir — the voice's source tree, `<srcRoot>/<voice-id>`
 * @returns {VoiceInputs}
 */
export function computeVoiceInputs(srcDir) {
  const clips = listSourceClips(srcDir);
  const digest = createHash("sha256");

  for (const relative of clips) {
    digest
      .update(relative)
      .update("\0")
      .update(sha256Of(readFileSync(path.join(srcDir, relative))))
      .update("\n");
  }

  const { file } = locateCalloutScript(srcDir);
  const script = file !== null && lstatSync(file).isFile() ? sha256Of(readFileSync(file)) : null;

  return { clips: clips.length, clipsSha256: digest.digest("hex"), script };
}

/**
 * Everything `pack`'s archive is a function of, as digests: the pipeline
 * identity (`PIPELINE_IDENTITY`), the archive format (`archiveFormatIdentity`),
 * the exact `voice-pack.json` bytes the packer writes — which cover the
 * version, the pack's label and author and every voice's config label, so a
 * version bump makes the record stale until the pack is re-packed, as it
 * should, since the archive changes with it — and each voice's clips and
 * script (`computeVoiceInputs`), keyed by voice id in the pack's order.
 *
 * Reads the tree (about 175 MB for both packs today, 0.6 s warm) and runs no
 * ffmpeg. Throws, naming the pack and the voice, when a voice has no source
 * tree or no config — the same conditions the packer refuses.
 *
 * @param {VoicePackDefinition} pack
 * @param {PackRoots} [roots]
 * @returns {PackInputs}
 */
export function computePackInputs(pack, roots = {}) {
  const {
    srcRoot = path.join(audioAssetsPath, VOICE_ROOT),
    configsDir = CONFIGS_DIR,
    pipelineIdentity = PIPELINE_IDENTITY,
    archiveFormat = archiveFormatIdentity(),
  } = roots;
  const manifest = serializeSortedJson(buildVoicePackManifest(pack, readVoiceEntries(pack, configsDir)));
  /** @type {Record<string, VoiceInputs>} */
  const voices = {};

  for (const voiceId of pack.voices) {
    const srcDir = path.join(srcRoot, voiceId);

    if (!existsSync(srcDir)) throw new Error(`pack "${pack.id}": voice "${voiceId}" has no clips at ${srcDir}`);

    voices[voiceId] = computeVoiceInputs(srcDir);
  }

  return {
    pipeline: pipelineIdentityHash(pipelineIdentity),
    archiveFormat: sha256Of(serializeSortedJson(archiveFormat)),
    manifest: sha256Of(manifest),
    voices,
  };
}

/**
 * The record object in the spec's field order — `id`, `version`, `sha256`,
 * `inputs` (pipeline, archiveFormat, manifest, voices in the pack's order),
 * then `released` when there is one — so the committed file reads the way the
 * spec does and two writers produce the same bytes.
 *
 * @param {VoicePackDefinition} pack
 * @param {{ sha256: string; inputs: PackInputs; released?: ReleasedSeal | undefined }} parts
 * @returns {PackRecord}
 */
export function buildPackRecord(pack, { sha256, inputs, released }) {
  return {
    id: pack.id,
    version: pack.version,
    sha256,
    inputs: {
      pipeline: inputs.pipeline,
      archiveFormat: inputs.archiveFormat,
      manifest: inputs.manifest,
      voices: Object.fromEntries(
        pack.voices.map((voiceId) => {
          const voice = inputs.voices[voiceId];

          if (voice === undefined) throw new Error(`pack "${pack.id}": no inputs for voice "${voiceId}"`);

          return [voiceId, { clips: voice.clips, clipsSha256: voice.clipsSha256, script: voice.script }];
        }),
      ),
    },
    ...(released === undefined ? {} : { released: { version: released.version, sha256: released.sha256 } }),
  };
}

/**
 * The record's bytes: two-space LF JSON with a trailing newline, Prettier-clean
 * like the catalog entries, in `buildPackRecord`'s field order.
 *
 * @param {PackRecord} record
 */
export function serializePackRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Write `record` to `pack-records/<id>.json`, creating the directory. Returns
 * the path written.
 *
 * @param {PackRecord} record
 * @param {string} [recordsDir]
 */
export function writePackRecord(record, recordsDir = PACK_RECORDS_DIR) {
  const file = packRecordPath(record.id, recordsDir);

  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(file, serializePackRecord(record));

  return file;
}

/**
 * The committed record for `id`, or `null` when there is none. Throws, naming
 * the file, when it cannot be read, is not JSON, or does not fit
 * `PackRecordSchema` — a record the rules cannot judge is a failure, not an
 * absence.
 *
 * @param {string} id
 * @param {string} [recordsDir]
 * @returns {PackRecord | null}
 */
export function readPackRecord(id, recordsDir = PACK_RECORDS_DIR) {
  const file = packRecordPath(id, recordsDir);

  if (!existsSync(file)) return null;

  let parsed;

  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(
      `${relativeToPackage(file)} could not be read as JSON: ${err instanceof Error ? err.message : err}`,
    );
  }

  const result = PackRecordSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(record)"}: ${issue.message}`);

    throw new Error(`${relativeToPackage(file)} is not a pack record:\n  ${issues.join("\n  ")}`);
  }

  return result.data;
}

/**
 * The committed catalog entry's `sha256`, or `null` when there is no entry.
 * Throws when the entry cannot be read or has no sha-256 string.
 *
 * @param {string} id
 * @param {string} catalogDir
 * @returns {string | null}
 */
function readCatalogSha256(id, catalogDir) {
  const file = path.join(catalogDir, `${id}.json`);

  if (!existsSync(file)) return null;

  let sha256;

  try {
    sha256 = JSON.parse(readFileSync(file, "utf-8")).sha256;
  } catch (err) {
    throw new Error(
      `${relativeToPackage(file)} could not be read as JSON: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (typeof sha256 !== "string") throw new Error(`${relativeToPackage(file)} has no "sha256"`);

  return sha256;
}

/** A path as the messages name it: relative to the package when it is inside, else as given. */
function relativeToPackage(file) {
  const relative = path.relative(audioAssetsPath, file);

  return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative.split(path.sep).join("/");
}

/**
 * The fix for a stale record, worded by rule 4: a released version needs a
 * bump before the re-pack, one not released yet needs only the re-pack.
 *
 * @param {VoicePackDefinition} pack
 * @param {boolean} released — whether `pack.version` is the record's `released.version`
 */
function freshnessFix(pack, released) {
  const rest = `run \`${PACK_COMMAND} ${pack.id}\`, and commit catalog/${pack.id}.json and pack-records/${pack.id}.json`;

  return released
    ? `version ${pack.version} is released: bump \`version\` in ${REGISTRY_FILE}, ${rest}`
    : `version ${pack.version} is not released yet: ${rest}`;
}

/**
 * Rule 3's comparison: every part of `recorded` that differs from `now`, each
 * as the message the failure prints.
 *
 * @param {VoicePackDefinition} pack
 * @param {PackInputs} recorded
 * @param {PackInputs} now
 * @returns {{ part: string; message: string }[]}
 */
function diffInputs(pack, recorded, now) {
  const since = `since catalog/${pack.id}.json was packed`;
  /** @type {{ part: string; message: string }[]} */
  const diffs = [];

  if (recorded.pipeline !== now.pipeline) {
    diffs.push({
      part: "inputs.pipeline",
      message: `${pack.id}: the encode pipeline (filter chain, encode args or ffmpeg-static version) changed ${since}`,
    });
  }

  if (recorded.archiveFormat !== now.archiveFormat) {
    diffs.push({
      part: "inputs.archiveFormat",
      message: `${pack.id}: the archive format (fflate version or zip entry options) changed ${since}`,
    });
  }

  if (recorded.manifest !== now.manifest) {
    diffs.push({
      part: "inputs.manifest",
      message: `${pack.id}: voice-pack.json (the pack's version, label or author, or a voice's label) changed ${since}`,
    });
  }

  for (const voiceId of new Set([...Object.keys(recorded.voices), ...Object.keys(now.voices)])) {
    const was = recorded.voices[voiceId];
    const is = now.voices[voiceId];
    const tree = `${VOICE_ROOT}/${voiceId}`;

    if (was === undefined) {
      diffs.push({
        part: `voices.${voiceId}`,
        message: `${pack.id}: voice "${voiceId}" is in the pack but not in the record`,
      });
      continue;
    }

    if (is === undefined) {
      diffs.push({
        part: `voices.${voiceId}`,
        message: `${pack.id}: voice "${voiceId}" is in the record but not in the pack`,
      });
      continue;
    }

    if (was.clips !== is.clips || was.clipsSha256 !== is.clipsSha256) {
      const detail =
        was.clips === is.clips
          ? `${count(is.clips)} clips as recorded, with different bytes or paths`
          : `${count(is.clips)} now, ${count(was.clips)} recorded`;

      diffs.push({
        part: `voices.${voiceId}.clips`,
        message: `${pack.id}: the clips under ${tree} changed (${detail})`,
      });
    }

    if (was.script !== is.script) {
      const what = was.script === null ? "was added" : is.script === null ? "was removed" : "changed";

      diffs.push({ part: `voices.${voiceId}.script`, message: `${pack.id}: ${tree}/callouts.json ${what} ${since}` });
    }
  }

  return diffs;
}

/**
 * Hold every pack in `packs` to the four rules, and the records directory to
 * rule 1. Pure over the tree: reads, never writes. Returns every problem found,
 * in pack order then stray records, each naming the pack, the part and the
 * fix; an empty list is a clean tree.
 *
 * 1. Coverage — every pack has a record; no record for a pack the registry
 *    does not publish.
 * 2. Consistency — the record's `id` and `version` equal the definition's and
 *    its `sha256` equals the catalog entry's. One run writes both files, so a
 *    disagreement means one was edited by hand or left out of the commit.
 * 3. Freshness — the recomputed inputs deep-equal the record's. Each part that
 *    differs is one problem, and the fix is worded by rule 4: a released
 *    version is bumped before the re-pack, one not released yet is re-packed.
 * 4. A released version is frozen — with `released`, the definition's version
 *    is at or above `released.version` (semver precedence, #1613's deploy
 *    rule: a published version is bumped, never rolled back), and when equal,
 *    the record's `sha256` — so the entry's — equals `released.sha256`.
 *
 * @param {{ packs?: readonly VoicePackDefinition[] } & PackRoots} [options] — `packs` defaults to `VOICE_PACKS`
 * @returns {PackRecordProblem[]}
 */
export function checkPackRecords(options = {}) {
  const { packs = VOICE_PACKS, catalogDir = CATALOG_DIR, recordsDir = PACK_RECORDS_DIR, ...inputRoots } = options;
  /** @type {PackRecordProblem[]} */
  const problems = [];

  for (const pack of packs) {
    const recordFile = `pack-records/${pack.id}.json`;
    const entryFile = `catalog/${pack.id}.json`;
    const repack = `run \`${PACK_COMMAND} ${pack.id}\` and commit ${entryFile} and ${recordFile}`;
    /** @param {string} part @param {string} message @param {string} fix */
    const problem = (part, message, fix) => problems.push({ pack: pack.id, part, message, fix });
    let record;

    try {
      record = readPackRecord(pack.id, recordsDir);
    } catch (err) {
      problem(
        "record",
        `${pack.id}: ${err instanceof Error ? err.message : err}`,
        `restore ${recordFile} from git, or ${repack}`,
      );
      continue;
    }

    // Rule 1.
    if (record === null) {
      problem("record", `${pack.id}: no ${recordFile}`, repack);
      continue;
    }

    // Rule 2.
    const bothFiles = `one run writes both files, so one of them was edited by hand or left out of the commit; ${repack}`;

    if (record.id !== pack.id) {
      problem("id", `${pack.id}: ${recordFile} names id "${record.id}"`, bothFiles);
    }

    if (record.version !== pack.version) {
      problem(
        "version",
        `${pack.id}: ${recordFile} records version ${record.version}, but ${REGISTRY_FILE} says ${pack.version}`,
        bothFiles,
      );
    }

    let entrySha256;

    try {
      entrySha256 = readCatalogSha256(pack.id, catalogDir);
    } catch (err) {
      problem("entry", `${pack.id}: ${err instanceof Error ? err.message : err}`, bothFiles);
      entrySha256 = undefined;
    }

    if (entrySha256 === null) {
      problem("entry", `${pack.id}: no ${entryFile}`, repack);
    } else if (entrySha256 !== undefined && entrySha256 !== record.sha256) {
      problem(
        "sha256",
        `${pack.id}: ${recordFile} records sha256 ${record.sha256}, but ${entryFile} has ${entrySha256}`,
        bothFiles,
      );
    }

    // Rule 4.
    const released = record.released;
    let isReleased = false;

    if (released !== undefined) {
      if (semver.valid(released.version) === null) {
        problem(
          "released",
          `${pack.id}: ${recordFile} names a released version "${released.version}" that is not a semver version`,
          `restore ${recordFile} from git; \`released\` is written only by the release hook and the seal command`,
        );
      } else {
        const order = semver.compare(pack.version, released.version);

        if (order < 0) {
          problem(
            "released",
            `${pack.id}: version ${pack.version} is below the released ${released.version} (${recordFile})`,
            `a published version is bumped, never rolled back: set \`version\` in ${REGISTRY_FILE} to ${released.version} or above`,
          );
        } else if (order === 0) {
          isReleased = true;

          if (record.sha256 !== released.sha256) {
            problem(
              "released",
              `${pack.id}: version ${pack.version} is released with sha256 ${released.sha256}, but ${recordFile} now carries ${record.sha256}`,
              `a published archive never changes under its version: bump \`version\` in ${REGISTRY_FILE}, ${repack}`,
            );
          }
        }
      }
    }

    // Rule 3.
    let inputs;

    try {
      inputs = computePackInputs(pack, inputRoots);
    } catch (err) {
      problem("inputs", `${pack.id}: ${err instanceof Error ? err.message : err}`, freshnessFix(pack, isReleased));
      continue;
    }

    for (const { part, message } of diffInputs(pack, record.inputs, inputs)) {
      problem(part, message, freshnessFix(pack, isReleased));
    }
  }

  // Rule 1, the other half: nothing in the records directory but a record per published pack.
  if (existsSync(recordsDir)) {
    const known = new Set(packs.map((pack) => pack.id));

    for (const name of readdirSync(recordsDir).sort()) {
      const stem = name.endsWith(".json") ? name.slice(0, -".json".length) : null;

      if (stem !== null && known.has(stem)) continue;

      problems.push({
        pack: stem ?? name,
        part: "registry",
        message:
          stem === null
            ? `pack-records/${name} is not a pack record`
            : `${stem}: pack-records/${name} has no entry in ${REGISTRY_FILE}`,
        fix:
          stem === null
            ? `pack-records/ holds one <id>.json per published pack and nothing else: remove it`
            : `register the pack in ${REGISTRY_FILE}, or remove the record`,
      });
    }
  }

  return problems;
}

/**
 * `problems` as the lines a hook, a script or a test prints: every message,
 * then each distinct fix once per pack, so a pack with three changed inputs
 * is told what to run once.
 *
 * @param {readonly PackRecordProblem[]} problems
 * @returns {string}
 */
export function formatPackRecordProblems(problems) {
  /** @type {Map<string, PackRecordProblem[]>} */
  const byPack = new Map();

  for (const problem of problems) {
    const list = byPack.get(problem.pack) ?? [];

    list.push(problem);
    byPack.set(problem.pack, list);
  }

  /** @type {string[]} */
  const lines = [];

  for (const list of byPack.values()) {
    for (const problem of list) lines.push(`  ${problem.message}`);

    for (const fix of new Set(list.map((problem) => problem.fix))) lines.push(`  fix: ${fix}`);
  }

  return lines.join("\n");
}

/**
 * Mark the current version of each chosen pack as released: run
 * `checkPackRecords` over every pack first and throw on any problem (the
 * error's `problems` holds them, its message `formatPackRecordProblems`),
 * then set `released: { version, sha256 }` from the record's own fields on
 * every record whose `released.version` differs from the pack's — a record
 * already sealed at this version is left alone, bytes untouched.
 *
 * The release hook calls this for a stable or `-rc` version; the seal command
 * before a between-releases publish. Both are the only writers of `released`.
 *
 * @param {{ packs?: readonly VoicePackDefinition[]; ids?: readonly string[]; dryRun?: boolean } & PackRoots} [options]
 *   — `packs` defaults to `VOICE_PACKS` and is what the checks run over; `ids` restricts the SEAL to those packs
 *   (default: every pack); `dryRun` reports what it would seal and writes nothing
 * @returns {{ sealed: { id: string; version: string; sha256: string; path: string }[]; written: string[] }}
 *   — `sealed` is every record this call sealed (or, dry, would seal); `written` the files it wrote
 */
export function sealPackRecords(options = {}) {
  const { packs = VOICE_PACKS, ids, dryRun = false, ...roots } = options;
  const recordsDir = roots.recordsDir ?? PACK_RECORDS_DIR;
  const problems = checkPackRecords({ packs, ...roots });

  if (problems.length > 0) {
    const error = Object.assign(
      new Error(`voice-pack records are not clean, so nothing was sealed:\n${formatPackRecordProblems(problems)}`),
      { problems },
    );

    throw error;
  }

  const chosen =
    ids === undefined
      ? packs
      : ids.map((id) => {
          const pack = packs.find((candidate) => candidate.id === id);

          if (pack === undefined) {
            throw new Error(`unknown pack "${id}" — known packs: ${packs.map((candidate) => candidate.id).join(", ")}`);
          }

          return pack;
        });
  /** @type {{ id: string; version: string; sha256: string; path: string }[]} */
  const sealed = [];
  /** @type {string[]} */
  const written = [];

  for (const pack of chosen) {
    const record = readPackRecord(pack.id, recordsDir);

    // The checks passed, so the record exists, carries the pack's version, and
    // — when sealed at it already — carries this very sha256.
    if (record === null || record.released?.version === pack.version) continue;

    const file = packRecordPath(pack.id, recordsDir);
    const next = buildPackRecord(pack, {
      sha256: record.sha256,
      inputs: record.inputs,
      released: { version: record.version, sha256: record.sha256 },
    });

    sealed.push({ id: pack.id, version: record.version, sha256: record.sha256, path: file });

    if (!dryRun) written.push(writePackRecord(next, recordsDir));
  }

  return { sealed, written };
}
