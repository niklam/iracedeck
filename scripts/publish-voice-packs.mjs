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
 * Per pack it stops at the first outcome:
 *
 *   1. Pack with `packVoice` into a SCRATCH directory, catalog entry to scratch
 *      too. The committed `packages/audio-assets/catalog/<id>.json` is never
 *      rewritten here — CI has no business committing.
 *   2. The fresh sha256 and byte count must equal the committed entry. Anything
 *      else is a repo-state error that needs a commit anyway (`pack:voice`, a
 *      version bump if the clips changed), so it fails before anything is
 *      published — and before the plugin attach step, which keeps the tag clean.
 *   3. Copy the archive to `--out`. A dry run ends here.
 *   4. With `--publish`: no `voices-<id>-<version>` release yet → create it,
 *      with `--latest=false`, and attach the archive. Release without the asset
 *      → upload. Asset present → download and hash it: the same bytes is a
 *      re-run or a later plugin release with no pack change, skip; different
 *      bytes is a forgotten version bump, fail. A published version's bytes
 *      never change.
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
 * @typedef {{ bytes: number; sha256: string }} ArchiveIdentity
 * @typedef {"dry-run" | "published" | "already-published"} Outcome
 * @typedef {{ id: string; version: string; outcome: Outcome; archive: string }} PackResult
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
 * @param {VoicePackDefinition} pack
 * @param {ArchiveIdentity} fresh
 * @param {ArchiveIdentity | null} committed
 */
function verifyAgainstCommitted(pack, fresh, committed) {
  const committedFile = `${COMMITTED_ENTRY_DIR}/${pack.id}.json`;
  const fix =
    'Run "pnpm --filter @iracedeck/audio-assets pack:voice", bump the pack version in voice-packs.mjs ' +
    "if its clips changed, and commit the regenerated entry.";

  if (committed === null) {
    throw new Error(`${pack.id}: no committed catalog entry at ${committedFile}. ${fix}`);
  }

  if (committed.sha256 !== fresh.sha256 || committed.bytes !== fresh.bytes) {
    throw new Error(
      `${pack.id}: the archive built here (sha256 ${fresh.sha256}, ${fresh.bytes} bytes) does not match ` +
        `${committedFile} (sha256 ${committed.sha256}, ${committed.bytes} bytes). ${fix}`,
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

  if (!result.ok) {
    const detail = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || "no output";

    throw new Error(`${pack.id}: gh ${args.slice(0, 2).join(" ")} failed — ${detail}`);
  }

  return result;
}

/**
 * The names of the assets on the pack's release, or `null` when there is no
 * release. A non-zero `gh release view` is read as "no release": if that ever
 * hides a transient failure, the `gh release create` that follows refuses an
 * existing tag loudly, so nothing is published over the top of anything.
 *
 * @param {PublishDeps} deps
 * @param {VoicePackDefinition} pack
 * @param {string} tag
 * @returns {string[] | null}
 */
function publishedAssetNames(deps, pack, tag) {
  const result = deps.gh(["release", "view", tag, "--json", "assets"]);

  if (!result.ok) return null;

  let assets;

  try {
    assets = JSON.parse(result.stdout).assets;
  } catch (error) {
    throw new Error(
      `${pack.id}: could not read the assets on ${tag} from gh release view — ${error instanceof Error ? error.message : error}`,
    );
  }

  return Array.isArray(assets) ? assets.map((asset) => asset.name) : [];
}

/**
 * Step 4: put the verified archive on the pack's release, or confirm it is
 * already there byte for byte.
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
  const attachment = `${archivePath}#${assetName}`;
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
      attachment,
    ]);

    return "published";
  }

  if (!assets.includes(assetName)) {
    ghOrThrow(deps, pack, ["release", "upload", tag, attachment]);

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
 * The orchestrator: every pack in order, stopping at the first failure. Pure
 * apart from what `deps` does; rejects with a message naming the pack and the
 * fix, which `main` turns into exit code 1.
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
  /** @type {PackResult[]} */
  const results = [];

  deps.ensureDir(outDir);

  for (const pack of packs) {
    const { entry, archivePath } = await deps.pack(pack);

    verifyAgainstCommitted(pack, entry, deps.readCommittedEntry(pack.id));

    const archive = path.join(outDir, archiveFileName(pack));

    deps.copyArchive(archivePath, archive);

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
