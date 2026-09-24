#!/usr/bin/env node
/**
 * Stages every authored voice pack for the development voice root (#1214).
 *
 * The turbo task behind this package's `stage:dev-voices` script, which every
 * plugin's `#build` depends on. A turbo `dependsOn` cannot be conditional, so
 * the task always runs and decides here whether there is anything to do, with
 * the SAME resolver the plugin builds use for their `devVoicePacksRoot`
 * (`resolveDevVoicePacksRoot` in the repo's `scripts/lib/dev-local.mjs`) — so
 * a build can never stage without pointing the plugin at the stage, or point
 * the plugin at a stage nobody refreshed:
 *
 * - **off** (`dev.local.json` says `voicePacksRoot: false`, or no marker and
 *   `IRACEDECK_DEV_VOICES` is unset or `0`): one line, nothing staged.
 * - **on, at a hand-picked root** (a marker naming some other path): nothing
 *   staged. That root belongs to whoever picked it; the build writing into it
 *   would overwrite whatever they put there.
 * - **on, at the default root** (`packages/audio-assets/dist/voice-packs`):
 *   every pack in `VOICE_PACKS` is staged with the packer's `--stage-only`
 *   (`writeArchive: false`), one after another. Every check a release pack
 *   makes before its zip runs here too; no archive and no catalog entry is
 *   written, so `catalog/` — the release contract — is never touched by a
 *   build. Before staging, any DIRECTORY in the root that is not an authored
 *   pack id is removed: a pack deleted or renamed in `VOICE_PACKS` would
 *   otherwise stay staged and keep playing. Files (the zips `pack:voice`
 *   leaves beside the stage) are left alone.
 *
 * The default root IS the packer's `OUTPUT_DIR`, which is what makes the
 * stage land where the plugin looks. That is asserted at run time (a drift
 * fails the build rather than staging somewhere nobody reads) and by
 * `stage-dev-voices.test.ts`.
 *
 * Sequential rather than parallel: `processVoiceTree` serialises on the
 * processed-clip cache lock anyway, and one pack at a time keeps the log
 * readable.
 *
 * Usage: pnpm stage:voices (from the repo root)
 *        pnpm --filter @iracedeck/audio-assets stage:dev-voices
 *        node packages/audio-assets/scripts/stage-dev-voices.mjs
 */
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import url from "node:url";

import { isSamePath, resolveDevVoicePacksRoot } from "../../../scripts/lib/dev-local.mjs";
import { audioAssetsPath, VOICE_PACKS } from "../src/build/index.mjs";
import { OUTPUT_DIR, packVoice } from "./pack-voice.mjs";

/** The worktree being built: two levels above this package. */
export const REPO_ROOT = path.resolve(audioAssetsPath, "..", "..");

/**
 * @typedef {import("../src/build/voice-packs.mjs").VoicePackDefinition} VoicePackDefinition
 * @typedef {{ voicePacksRoot: string | undefined; source: string | undefined; isDefaultRoot: boolean }} DevVoiceRoot
 * @typedef {"off" | "hand-picked" | "staged"} StageOutcome
 */

/**
 * Stage the development voice packs if, and only if, development mode is on at
 * the default root. Every collaborator is injectable so the tests exercise each
 * branch without the resolver's environment, ffmpeg, or the real voices.
 *
 * Throws on anything the resolver throws on (an invalid `IRACEDECK_DEV_VOICES`
 * or marker) and on any pack that fails to stage; the caller turns that into a
 * non-zero exit so the build fails.
 *
 * @param {object} [options]
 * @param {string} [options.repoRoot]
 * @param {(root: string) => DevVoiceRoot} [options.resolve]
 * @param {(options: { pack: VoicePackDefinition; writeArchive: false; logger?: (message: string) => void }) => Promise<{ clips: number; scripts: number; stageDir: string }>} [options.packVoice]
 * @param {readonly VoicePackDefinition[]} [options.packs]
 * @param {string} [options.outputDir] — where the packer stages; must equal the resolved default root
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.now] — milliseconds, for the wall-time line
 * @param {(dir: string) => string[]} [options.listDirectories] — the directory names directly in `dir`, `[]` when it does not exist
 * @param {(dir: string) => void} [options.removeDirectory]
 * @returns {Promise<{ outcome: StageOutcome; staged: string[] }>}
 */
export async function stageDevVoices({
  repoRoot = REPO_ROOT,
  resolve = resolveDevVoicePacksRoot,
  packVoice: stage = packVoice,
  packs = VOICE_PACKS,
  outputDir = OUTPUT_DIR,
  log = (message) => console.log(message),
  now = () => performance.now(),
  listDirectories = listDirectoriesIn,
  removeDirectory = (dir) => rmSync(dir, { recursive: true, force: true }),
} = {}) {
  const { voicePacksRoot, source, isDefaultRoot } = resolve(repoRoot);

  if (voicePacksRoot === undefined) {
    log(`Development voices: off${source === undefined ? "" : ` (${source})`} — nothing staged`);

    return { outcome: "off", staged: [] };
  }

  if (!isDefaultRoot) {
    log(
      `Development voices: on at ${voicePacksRoot} (${source}) — a hand-picked root belongs to whoever ` +
        `picked it, so nothing staged`,
    );

    return { outcome: "hand-picked", staged: [] };
  }

  // The default root and the packer's output directory are one directory by
  // construction; if they ever drift, staging would fill a directory the
  // plugin never scans and the developer would hear the previous clips.
  // Compared as the resolver compares, so a marker spelling the default root in
  // another case on Windows is not mistaken for a drift.
  if (!isSamePath(voicePacksRoot, outputDir)) {
    throw new Error(
      `development voice root ${voicePacksRoot} is not the packer's output directory ${outputDir} — ` +
        `DEFAULT_DEV_VOICE_PACKS_ROOT and pack-voice.mjs's OUTPUT_DIR have drifted apart`,
    );
  }

  log(`Development voices: on (${source}) — staging ${packs.length} pack(s) into ${voicePacksRoot}`);

  pruneStalePacks({ outputDir, packs, listDirectories, removeDirectory, log });

  const started = now();
  /** @type {string[]} */
  const staged = [];

  for (const pack of packs) {
    const result = await stage({ pack, writeArchive: false, logger: log });

    log(
      `  staged ${pack.id}@${pack.version}: ${result.clips} clips, ${result.scripts} callout ` +
        `${result.scripts === 1 ? "script" : "scripts"}`,
    );
    staged.push(pack.id);
  }

  const seconds = ((now() - started) / 1000).toFixed(1);

  log(`Development voices: staged ${staged.length} pack(s) in ${seconds} s — press Rescan voices, or restart the plugin`);

  return { outcome: "staged", staged };
}

/**
 * Removes every directory in the default root that is not an authored pack id.
 *
 * Only reached at the default root, which the build owns: a pack dropped from
 * `VOICE_PACKS`, or renamed there, would otherwise stay staged from an earlier
 * build and the plugin would keep scanning it. Directories only — the scanner
 * lists nothing else, and the files here are the zips `pack:voice` writes,
 * which are someone's release artifacts rather than stale stages.
 *
 * @param {{ outputDir: string; packs: readonly VoicePackDefinition[]; listDirectories: (dir: string) => string[]; removeDirectory: (dir: string) => void; log: (message: string) => void }} options
 * @returns {string[]} the names removed
 */
function pruneStalePacks({ outputDir, packs, listDirectories, removeDirectory, log }) {
  const authored = new Set(packs.map((pack) => pack.id));
  const stale = listDirectories(outputDir).filter((name) => !authored.has(name));

  for (const name of stale) {
    removeDirectory(path.join(outputDir, name));
    log(`  removed ${name}/ — not an authored pack, so a stale stage`);
  }

  return stale;
}

/** @param {string} dir */
function listDirectoriesIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    // Absent is the first build of a fresh worktree; anything else is real.
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return [];
    throw err;
  }
}

// Direct-exec guard, as in pack-voice.mjs: importing this module (the tests do)
// must not stage anything at module-eval time.
const invokedPath = process.argv[1];
if (
  invokedPath &&
  (import.meta.url === url.pathToFileURL(invokedPath).href || invokedPath === url.fileURLToPath(import.meta.url))
) {
  stageDevVoices().catch((err) => {
    console.error(`stage:dev-voices: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}
