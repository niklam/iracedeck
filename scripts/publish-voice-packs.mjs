#!/usr/bin/env node
/**
 * Packs, verifies and — when asked — publishes every voice pack in
 * `VOICE_PACKS` as a GitHub release asset (#1116).
 *
 * Usage: node scripts/publish-voice-packs.mjs [--publish] [--out <dir>]
 *
 * Run by the release workflow after the build has warmed the encode cache, and
 * by the dispatch-only `publish-voice-packs.yml`. Without `--publish` it is a
 * dry run: pack, verify, copy the archives to `--out` (default
 * `packed/voice-packs`, which the workflows upload as an artifact), upload
 * nothing. Publishing is decided by the flag alone — never inferred from the
 * environment — so a local run can never reach GitHub by accident.
 *
 * Two passes, and the first must finish for every pack before the second
 * starts for any: with two packs, a repo-state error in the second must not
 * leave the first's release created and the run red. Each pass stops at its
 * first failure.
 *
 * Pass 1, per pack — pack, copy, verify:
 *
 *   1. Pack with `packVoice` into a SCRATCH directory, catalog entry to scratch
 *      too. The committed `packages/audio-assets/catalog/<id>.json` is never
 *      rewritten here — CI has no business committing.
 *   2. Copy the archive to `--out` — BEFORE checking it. The one run whose
 *      archive the maintainer needs to inspect is the red one, where the runner
 *      did not reproduce the committed bytes, and the scratch copy is gone by
 *      the time the process exits.
 *   3. The fresh sha256, byte count and url must equal the committed entry.
 *      Anything else is a repo-state error that needs a commit anyway
 *      (`pack:voice`, a version bump if the clips changed), so it fails before
 *      anything is published — and before the plugin attach step, which keeps
 *      the tag clean. The url is checked because the hash does not cover it: a
 *      committed url that drifted would go live pointing where nothing uploads.
 *
 * A dry run ends there. Pass 2, per pack, with `--publish` only:
 *
 *   4. No `voices-<id>-<version>` release yet → create it, with `--latest=false`,
 *      and attach the archive. Release without the asset → upload. Asset present
 *      → download and hash it: the same bytes is a re-run or a later plugin
 *      release with no pack change, skip; different bytes is a forgotten version
 *      bump, fail. A published version's bytes never change. A DRAFT release is
 *      refused outright: it is what an interrupted create leaves behind, an
 *      upload into it would report "published" while every download 404s.
 *
 * `--latest=false` is load-bearing, not a nicety. The website's plugin
 * download links resolve through `/releases/latest/download/`, and GitHub hands
 * a new release the latest slot by default, so a voice-pack release created
 * the ordinary way would 404 every plugin download. The test pins the flag.
 *
 * Design record: docs/superpowers/specs/2026-08-25-issue-1034-downloadable-voice-packs.md,
 * "Publishing archives — from the release workflow, never by hand".
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import { archiveFileName, CATALOG_DIR, packVoice, releaseTag } from "../packages/audio-assets/scripts/pack-voice.mjs";
import { VOICE_PACKS } from "../packages/audio-assets/src/build/voice-packs.mjs";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/** Where the finished archives land for the workflow's artifact upload, relative to the repo root. */
export const DEFAULT_OUT_DIR = "packed/voice-packs";

/** The committed entries, as the failure messages name them. */
const COMMITTED_ENTRY_DIR = "packages/audio-assets/catalog";

const USAGE = "usage: node scripts/publish-voice-packs.mjs [--publish] [--out <dir>]";

/**
 * @typedef {import("../packages/audio-assets/src/build/voice-packs.mjs").VoicePackDefinition} VoicePackDefinition
 * @typedef {{ bytes: number; sha256: string; url: string }} ArchiveIdentity
 * @typedef {"dry-run" | "published" | "already-published"} Outcome
 * @typedef {{ id: string; version: string; outcome: Outcome; archive: string }} PackResult
 * @typedef {{ pack: VoicePackDefinition; entry: ArchiveIdentity; archivePath: string; archive: string }} VerifiedPack
 *
 * Everything with a side effect, injected so the orchestrator can be driven
 * end to end without a packer, a filesystem or a network on the other side.
 * `gh` is the ONE runner for every gh call — the tests assert on its argv.
 *
 * @typedef {object} PublishDeps
 * @property {(pack: VoicePackDefinition) => Promise<{ entry: ArchiveIdentity; archivePath: string }>} pack
 * @property {(id: string) => ArchiveIdentity | null} readCommittedEntry
 * @property {(dir: string) => void} ensureDir
 * @property {(from: string, to: string) => void} copyArchive
 * @property {(file: string) => string} sha256File
 * @property {(args: string[]) => { ok: boolean; stdout: string; stderr?: string }} gh
 * @property {(message: string) => void} log
 */

/**
 * @param {readonly string[]} argv — everything after the script path
 * @returns {{ publish: boolean; outDir: string }}
 */
export function parseArgs(argv) {
  const options = { publish: false, outDir: DEFAULT_OUT_DIR };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--publish") {
      options.publish = true;
    } else if (arg === "--out") {
      const value = argv[i + 1];

      if (value === undefined || value.startsWith("--")) throw new Error(`--out needs a directory — ${USAGE}`);

      options.outDir = value;
      i += 1;
    } else {
      throw new Error(`unknown argument "${arg}" — ${USAGE}`);
    }
  }

  return options;
}

/**
 * The commit the release's tag lands on: the one being released when we are
 * inside a workflow run, nothing (gh's default, the default branch) otherwise.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveTargetSha(env) {
  return env.GITHUB_SHA ? env.GITHUB_SHA : undefined;
}

/** @param {VoicePackDefinition} pack */
export function releaseTitle(pack) {
  return `Voice pack: ${pack.label} ${pack.version}`;
}

/** @param {VoicePackDefinition} pack */
export function releaseNotes(pack) {
  const about = pack.description ? ` ${pack.description}` : "";

  return (
    `Race Engineer voice pack "${pack.label}" ${pack.version} for iRaceDeck.${about} ` +
    "This is not a plugin release: the attached archive is what the plugin downloads when this voice is " +
    "installed from its settings window, and its bytes never change once published."
  );
}

/**
 * gh names an asset after the file it uploads — a `#suffix` on the argument
 * sets only a DISPLAY LABEL — so the archive's basename is the asset name the
 * catalog's url points at. `packVoice` writes it under `archiveFileName(pack)`
 * today; this is what turns that ceasing to be true into a failure here rather
 * than an asset with the wrong name on a release for good.
 *
 * @param {VoicePackDefinition} pack
 * @param {string} archivePath
 */
function assertArchiveName(pack, archivePath) {
  const expected = archiveFileName(pack);
  const actual = path.basename(archivePath);

  if (actual !== expected) {
    throw new Error(
      `${pack.id}: the packer wrote ${actual} but the release asset must be named ${expected} — ` +
        "gh names an asset after the file it uploads, so the archive must already carry that name",
    );
  }
}

/**
 * The fresh entry rides along on every verification failure: on the red dry
 * run it is the only record of what the runner actually built, and the diff
 * against the committed file is what the maintainer needs next.
 *
 * @param {VoicePackDefinition} pack
 * @param {ArchiveIdentity} fresh
 * @param {ArchiveIdentity | null} committed
 */
function verifyAgainstCommitted(pack, fresh, committed) {
  const committedFile = `${COMMITTED_ENTRY_DIR}/${pack.id}.json`;
  const fix =
    'Run "pnpm --filter @iracedeck/audio-assets pack:voice", bump the pack version in voice-packs.mjs ' +
    `if its clips changed, and commit the regenerated entry. The entry built here: ${JSON.stringify(fresh)}`;

  if (committed === null) {
    throw new Error(`${pack.id}: no committed catalog entry at ${committedFile}. ${fix}`);
  }

  if (committed.sha256 !== fresh.sha256 || committed.bytes !== fresh.bytes) {
    throw new Error(
      `${pack.id}: the archive built here (sha256 ${fresh.sha256}, ${fresh.bytes} bytes) does not match ` +
        `${committedFile} (sha256 ${committed.sha256}, ${committed.bytes} bytes). ${fix}`,
    );
  }

  if (committed.url !== fresh.url) {
    throw new Error(
      `${pack.id}: ${committedFile} points at ${committed.url}, but the archive built here would be published ` +
        `at ${fresh.url}. ${fix}`,
    );
  }
}

/**
 * Runs one gh command that must succeed, naming the pack and gh's own
 * complaint when it does not.
 *
 * @param {PublishDeps} deps
 * @param {VoicePackDefinition} pack
 * @param {string[]} args
 */
function ghOrThrow(deps, pack, args) {
  const result = deps.gh(args);

  if (!result.ok) throw ghFailure(pack, args, result);

  return result;
}

/**
 * @param {VoicePackDefinition} pack
 * @param {string[]} args
 * @param {{ stdout?: string; stderr?: string }} result
 */
function ghFailure(pack, args, result) {
  const detail = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || "no output";

  return new Error(`${pack.id}: gh ${args.slice(0, 2).join(" ")} failed — ${detail}`);
}

/**
 * gh's exact wording for a tag with no release (gh 2.92). It is the ONLY
 * non-zero exit read as "no release": an auth failure, a rate limit or a 5xx
 * read that way would be misdiagnosed, and the `gh release create` that
 * followed would then fail for a reason the log never named.
 */
const RELEASE_NOT_FOUND = "release not found";

/**
 * The names of the assets on the pack's release, or `null` when there is no
 * release. Throws for any other failure, and for a DRAFT: a draft is what a
 * `gh release create` interrupted mid-upload leaves behind, `gh release upload`
 * would add the asset to it without complaint, and the public download URL
 * would 404 for every user while this script reported "published".
 *
 * @param {PublishDeps} deps
 * @param {VoicePackDefinition} pack
 * @param {string} tag
 * @returns {string[] | null}
 */
function publishedAssetNames(deps, pack, tag) {
  const args = ["release", "view", tag, "--json", "assets,isDraft"];
  const result = deps.gh(args);

  if (!result.ok) {
    if ((result.stderr ?? "").includes(RELEASE_NOT_FOUND)) return null;

    throw ghFailure(pack, args, result);
  }

  let release;

  try {
    release = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${pack.id}: could not read the assets on ${tag} from gh release view — ${error instanceof Error ? error.message : error}`,
    );
  }

  if (release.isDraft === true) {
    throw new Error(
      `${pack.id}: ${tag} is a draft release — a previous publish was interrupted before it finished. ` +
        "Publish or delete the draft on GitHub, then re-run.",
    );
  }

  return Array.isArray(release.assets) ? release.assets.map((asset) => asset.name) : [];
}

/**
 * Pass 2, per pack: put the verified archive on the pack's release, or confirm
 * it is already there byte for byte. The archive is handed to gh by path
 * alone — its basename is the asset name (`assertArchiveName` in pass 1).
 *
 * @param {PublishDeps} deps
 * @param {VoicePackDefinition} pack
 * @param {string} archivePath
 * @param {ArchiveIdentity} fresh
 * @param {{ scratchDir: string; targetSha: string | undefined }} options
 * @returns {Outcome}
 */
function publishArchive(deps, pack, archivePath, fresh, { scratchDir, targetSha }) {
  const tag = releaseTag(pack);
  const assetName = archiveFileName(pack);
  const assets = publishedAssetNames(deps, pack, tag);

  if (assets === null) {
    // `--latest=false` is mandatory — see the header. `--target` pins the tag to
    // the commit being released; without it gh tags the default branch's HEAD.
    ghOrThrow(deps, pack, [
      "release",
      "create",
      tag,
      "--title",
      releaseTitle(pack),
      "--notes",
      releaseNotes(pack),
      "--latest=false",
      ...(targetSha === undefined ? [] : ["--target", targetSha]),
      archivePath,
    ]);

    return "published";
  }

  if (!assets.includes(assetName)) {
    ghOrThrow(deps, pack, ["release", "upload", tag, archivePath]);

    return "published";
  }

  const downloadDir = path.join(scratchDir, "published");
  const downloaded = path.join(downloadDir, assetName);

  deps.ensureDir(downloadDir);
  ghOrThrow(deps, pack, ["release", "download", tag, "--pattern", assetName, "--output", downloaded, "--clobber"]);

  if (deps.sha256File(downloaded) !== fresh.sha256) {
    throw new Error(
      `${assetName} is already published on ${tag} with different bytes. A published version's bytes never change: ` +
        "bump the pack version in voice-packs.mjs, re-run pack:voice, and commit.",
    );
  }

  return "already-published";
}

/**
 * The orchestrator: two passes, each over every pack in order and each
 * stopping at its first failure — see the header for why the first must
 * finish for every pack before the second touches any release. Pure apart from
 * what `deps` does; rejects with a message naming the pack and the fix, which
 * `main` turns into exit code 1.
 *
 * @param {object} options
 * @param {readonly VoicePackDefinition[]} options.packs
 * @param {boolean} options.publish
 * @param {string} options.outDir — where the archives are copied for the artifact upload
 * @param {string} options.scratchDir — where a published asset is downloaded for comparison
 * @param {string} [options.targetSha] — the commit a new release's tag lands on
 * @param {PublishDeps} options.deps
 * @returns {Promise<PackResult[]>}
 */
export async function publishVoicePacks({ packs, publish, outDir, scratchDir, targetSha, deps }) {
  deps.ensureDir(outDir);

  /** @type {VerifiedPack[]} */
  const verified = [];

  for (const pack of packs) {
    const { entry, archivePath } = await deps.pack(pack);

    assertArchiveName(pack, archivePath);

    const archive = path.join(outDir, archiveFileName(pack));

    deps.copyArchive(archivePath, archive);
    verifyAgainstCommitted(pack, entry, deps.readCommittedEntry(pack.id));
    deps.log(`${pack.id}@${pack.version}: packed, matches the committed entry (${archive})`);
    verified.push({ pack, entry, archivePath, archive });
  }

  /** @type {PackResult[]} */
  const results = [];

  for (const { pack, entry, archivePath, archive } of verified) {
    const outcome = publish ? publishArchive(deps, pack, archivePath, entry, { scratchDir, targetSha }) : "dry-run";

    results.push({ id: pack.id, version: pack.version, outcome, archive });
    deps.log(summarize(pack, outcome, archive));
  }

  return results;
}

/**
 * @param {VoicePackDefinition} pack
 * @param {Outcome} outcome
 * @param {string} archive
 */
function summarize(pack, outcome, archive) {
  const who = `${pack.id}@${pack.version}`;

  switch (outcome) {
    case "dry-run":
      return `${who}: packed and verified, dry run — not published (${archive})`;
    case "published":
      return `${who}: published ${archiveFileName(pack)} on ${releaseTag(pack)} (${archive})`;
    case "already-published":
      return `${who}: already published on ${releaseTag(pack)} with identical bytes — skipped (${archive})`;
    default:
      throw new Error(`unknown outcome ${outcome}`);
  }
}

/**
 * @param {string[]} args
 * @returns {{ ok: boolean; stdout: string; stderr: string }}
 */
function gh(args) {
  const result = spawnSync("gh", args, { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

  // `error` is set when gh could not be started at all (not installed, not on
  // PATH) — a different failure from gh running and saying no, and one no
  // release state can explain, so it is not folded into `ok: false`.
  if (result.error) throw result.error;

  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function main() {
  const { publish, outDir } = parseArgs(process.argv.slice(2));
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), "ird-publish-voice-packs-"));
  const log = (message) => console.log(message);

  try {
    await publishVoicePacks({
      packs: VOICE_PACKS,
      publish,
      outDir: path.resolve(repoRoot, outDir),
      scratchDir,
      targetSha: resolveTargetSha(process.env),
      deps: {
        // Stage, archive and catalog entry all land in scratch; `cacheDir` is
        // left unset so the packer reads the build's shared clip cache — the
        // very bytes the plugins ship.
        pack: (pack) =>
          packVoice({
            pack,
            outDir: path.join(scratchDir, "pack"),
            catalogDir: path.join(scratchDir, "catalog"),
            logger: log,
          }),
        readCommittedEntry: (id) => {
          const file = path.join(CATALOG_DIR, `${id}.json`);

          return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null;
        },
        ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
        copyArchive: (from, to) => copyFileSync(from, to),
        sha256File: (file) => createHash("sha256").update(readFileSync(file)).digest("hex"),
        gh,
        log,
      },
    });
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

// Direct-exec guard, as in pack-voice.mjs: only run main() when this file was
// executed as the entry script, so importing the orchestrator (the tests do)
// packs and publishes nothing at module-eval time.
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
