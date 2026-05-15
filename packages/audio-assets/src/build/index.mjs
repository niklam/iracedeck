import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import { RADIO_ENGINEER_FILTER } from "../presets.mjs";

const require = createRequire(import.meta.url);

const packageRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

export const audioAssetsPath = packageRoot;

const CACHE_ROOT = path.join(packageRoot, ".cache");

// Top-level entries under packages/audio-assets/ that must never be copied
// into the plugin's assets/audio/ output (tooling, package plumbing, our own
// cache).
const SKIP_FOLDERS = new Set([".cache", "node_modules", "scripts", "src"]);

// Serializes operations that mutate the shared `.cache/` tree
// (`processAndCopyAudioAssets`, `prebuildAudioAssetCache`, `wipeProcessedCache`).
// The harness exposes Reload and Wipe as separate buttons, and a rapid
// Wipe-then-Reload (or vice versa) would otherwise race: an rmSync can drop
// a file the other call just stat'd or is mid-write into, with ENOENT or
// partial-output as fallout.
//
// Cross-process contention on the shared cache is handled architecturally
// rather than here — `@iracedeck/audio-assets#build` warms the cache via
// `prebuildAudioAssetCache` before the parallel plugin builds run, so each
// plugin's Rollup `processAndCopyAudioAssets` call only reads cache files.
// This in-process lock is the residual guard for the harness UI and for
// single-process watcher rebuilds.
let cacheLock = Promise.resolve();
function withCacheLock(operation) {
  // `.then(fn, fn)` makes the queue continue even if a prior operation
  // rejected, so one failure doesn't strand every subsequent call.
  const next = cacheLock.then(operation, operation);

  cacheLock = next.catch(() => {});

  return next;
}
// The voice/ tree holds all radio-engineer voice clips, organised as
// voice/<voice>/<category>/*.mp3. Every .mp3 under it (at any depth) gets
// the radio filter; anything outside voice/ (currently sfx/) is copied
// unchanged so SFX tones, ticks and squelch beeps stay clean.
const VOICE_ROOT = "voice";

// Final encode parameters for the processed voice MP3s. The radio filter
// band-limits the signal to 250-3500 Hz, so encoding at the source's
// 44.1 kHz / VBR-q4 wasted bits on frequencies that no longer exist.
// 16 kHz / mono / 32 kbps gives Nyquist (8 kHz) generous headroom over
// the 3.5 kHz lowpass cutoff and stays in libmp3lame's MPEG-2 LSF profile
// (dropping to 11.025 kHz pushes the encoder into MPEG-2.5, which produces
// an audibly hollow character on vocal formants). 32 kbps gives the
// formants enough bits to stay clear at this sample rate.
const ENCODE_ARGS = ["-ar", "16000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "32k"];

// Cache key embeds both the filter chain and the encode args, so changing
// either invalidates the processed-asset cache without manual wipe.
function pipelineHash(chain, encodeArgs) {
  return createHash("sha256").update(chain).update("\0").update(encodeArgs.join(" ")).digest("hex").slice(0, 8);
}

function runFfmpeg(ffmpegPath, inputPath, outputPath, filterChain) {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath, "-af", filterChain, ...ENCODE_ARGS, outputPath];
    const proc = spawn(ffmpegPath, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.trim() || "no output"}`));
    });
  });
}

async function runWithConcurrency(tasks, limit) {
  const queue = [...tasks];
  let failed = null;
  const workerCount = Math.min(limit, queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length > 0 && !failed) {
      const task = queue.shift();
      try {
        await task();
      } catch (err) {
        failed ??= err;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failed;
}

function cacheIsFresh(sourcePath, cachedPath) {
  if (!existsSync(cachedPath)) return false;

  // Strict `>` rather than `>=`: when generate writes the source MP3 and
  // the build helper runs in the same wall-clock second (or even the same
  // millisecond, on filesystems with finer resolution), an `>=` check
  // accepts a cache file that was actually built from the *previous*
  // source revision. Strict `>` forces the rebuild in that ambiguous
  // case — slightly more ffmpeg work, but never stale audio.
  return statSync(cachedPath).mtimeMs > statSync(sourcePath).mtimeMs;
}

/**
 * Delete every `<filter-hash>/` subdir under the audio-assets ffmpeg cache.
 * The next `processAndCopyAudioAssets` run rebuilds everything from source.
 * Exposed as a separate operation for the harness's "Wipe ffmpeg cache"
 * action — a clean-slate fallback when a stale-cache hunch needs ruling
 * out without manually scrubbing `packages/audio-assets/.cache/`.
 */
export function wipeProcessedCache() {
  return withCacheLock(() => {
    if (!existsSync(CACHE_ROOT)) return;
    rmSync(CACHE_ROOT, { recursive: true, force: true });
  });
}

// Recursively walk a voice subtree, queuing every .mp3 for radio-filter
// processing or cache-hit copying. The caller picks behaviour via callbacks
// so the same walk drives both the prebuild cache-warm pass (which only
// writes to `cacheDir`) and the per-plugin copy pass (which also writes
// to `destDir`).
//
// `onFresh(cachedPath, destDir, fileName)` is invoked when the cache file
// is newer than the source. `onMiss(srcPath, cachedPath, destDir, fileName)`
// is invoked when the cache is stale or missing — the ffmpeg call has not
// been made yet, the callback decides whether to run it and whether to
// follow it with a copy.
function buildVoiceTreeTasks(srcDir, cacheDir, destDir, { onFresh, onMiss }) {
  const tasks = [];

  const walk = (currentSrc, currentCache, currentDest) => {
    mkdirSync(currentCache, { recursive: true });
    if (currentDest) mkdirSync(currentDest, { recursive: true });

    for (const entry of readdirSync(currentSrc, { withFileTypes: true })) {
      const srcPath = path.join(currentSrc, entry.name);

      if (entry.isDirectory()) {
        walk(srcPath, path.join(currentCache, entry.name), currentDest ? path.join(currentDest, entry.name) : null);
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".mp3")) continue;

      const cachedPath = path.join(currentCache, entry.name);

      if (cacheIsFresh(srcPath, cachedPath)) {
        tasks.push(() => onFresh(cachedPath, currentDest, entry.name));
      } else {
        tasks.push(() => onMiss(srcPath, cachedPath, currentDest, entry.name));
      }
    }
  };

  walk(srcDir, cacheDir, destDir);
  return tasks;
}

/**
 * Warm `.cache/<pipeline-hash>/voice/...` by running every source voice clip
 * through ffmpeg, without copying anywhere. Intended to run as its own turbo
 * task (`@iracedeck/audio-assets#build`) before the plugin builds, so the
 * parallel per-plugin `processAndCopyAudioAssets` calls find a fully-warm
 * cache and only ever read from it — no two processes contend over the same
 * `.cache/.../68.mp3` write.
 *
 * Per-file mtime check (`cacheIsFresh`) makes a warm cache a no-op, so this
 * is cheap to run on every build.
 *
 * `logger` is an optional `(msg: string) => void` for build-summary output.
 */
export async function prebuildAudioAssetCache({ logger } = {}) {
  if (!existsSync(audioAssetsPath)) return;
  return withCacheLock(() => runPrebuildCache({ logger }));
}

async function runPrebuildCache({ logger }) {
  const ffmpegPath = require("ffmpeg-static");
  const hash = pipelineHash(RADIO_ENGINEER_FILTER, ENCODE_ARGS);
  const cacheRoot = path.join(CACHE_ROOT, hash);
  const concurrency = Math.min(4, Math.max(1, os.availableParallelism?.() ?? os.cpus().length));

  const voiceSrc = path.join(audioAssetsPath, VOICE_ROOT);
  if (!existsSync(voiceSrc)) {
    logger?.(`Audio assets prebuild: no voice/ tree under ${audioAssetsPath} (pipeline hash ${hash})`);
    return;
  }

  let processed = 0;
  let cached = 0;

  const tasks = buildVoiceTreeTasks(voiceSrc, path.join(cacheRoot, VOICE_ROOT), null, {
    onFresh: () => {
      cached++;
    },
    onMiss: async (srcPath, cachedPath) => {
      await runFfmpeg(ffmpegPath, srcPath, cachedPath, RADIO_ENGINEER_FILTER);
      processed++;
    },
  });

  await runWithConcurrency(tasks, concurrency);

  logger?.(`Audio assets prebuild: ${processed} processed, ${cached} cache-hit (pipeline hash ${hash})`);
}

/**
 * Copies `packages/audio-assets/` into `destRoot`. Every .mp3 under voice/
 * (at any depth) passes through ffmpeg with RADIO_ENGINEER_FILTER applied;
 * everything outside voice/ (currently sfx/, ambient/) is copied unchanged.
 *
 * Processed outputs are cached at `packages/audio-assets/.cache/<pipeline-hash>/`
 * keyed on the filter chain + ffmpeg encode args, so changing either
 * invalidates the cache automatically. Per-file invalidation is mtime-based
 * (rebuild if the source MP3 is newer than its cached counterpart). The
 * Rollup plugin and the scenario harness both call this — the cache is
 * shared across them.
 *
 * `logger` is an optional `(msg: string) => void` for build-summary output.
 *
 * `wipe` (default `true`) controls whether `destRoot` is emptied before the
 * copy. The plugin Rollup build wants `true` so renamed/removed source
 * folders don't leak into the output. The harness's live-refresh path
 * passes `false` so it can update files in place without fighting Windows
 * file locks held by the audio engine on currently-loaded clips.
 */
export async function processAndCopyAudioAssets({ destRoot, logger, wipe = true } = {}) {
  if (!destRoot) throw new Error("processAndCopyAudioAssets: destRoot is required");
  if (!existsSync(audioAssetsPath)) return;

  return withCacheLock(() => runProcessAndCopy({ destRoot, logger, wipe }));
}

async function runProcessAndCopy({ destRoot, logger, wipe }) {
  const ffmpegPath = require("ffmpeg-static");
  const hash = pipelineHash(RADIO_ENGINEER_FILTER, ENCODE_ARGS);
  const cacheRoot = path.join(CACHE_ROOT, hash);
  const concurrency = Math.min(4, Math.max(1, os.availableParallelism?.() ?? os.cpus().length));

  if (wipe) {
    // Clear destRoot before recreating so renamed/removed top-level folders
    // (e.g. the legacy `pit-crew/` after #441 §1) don't leak into the
    // output across incremental builds. The cache under `.cache/` is keyed
    // by filter hash and lives outside destRoot, so this doesn't
    // invalidate it.
    rmSync(destRoot, { recursive: true, force: true });
  }

  mkdirSync(destRoot, { recursive: true });

  const tasks = [];
  let processed = 0;
  let cached = 0;
  let copiedAsIs = 0;

  const copyTreeAsIs = (srcDir, destDir) => {
    cpSync(srcDir, destDir, { recursive: true });
    // cpSync copies recursively, so the counter has to walk recursively
    // too — otherwise nested files (e.g. sfx/radar/*.mp3) get copied but
    // not counted in the build summary.
    const countFiles = (dir) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isFile()) copiedAsIs++;
        else if (f.isDirectory()) countFiles(path.join(dir, f.name));
      }
    };

    countFiles(srcDir);
  };

  for (const entry of readdirSync(audioAssetsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_FOLDERS.has(entry.name)) continue;

    const srcDir = path.join(audioAssetsPath, entry.name);
    const destDir = path.join(destRoot, entry.name);

    if (entry.name === VOICE_ROOT) {
      tasks.push(
        ...buildVoiceTreeTasks(srcDir, path.join(cacheRoot, VOICE_ROOT), destDir, {
          onFresh: async (cachedPath, currentDest, fileName) => {
            copyFileSync(cachedPath, path.join(currentDest, fileName));
            cached++;
          },
          onMiss: async (srcPath, cachedPath, currentDest, fileName) => {
            await runFfmpeg(ffmpegPath, srcPath, cachedPath, RADIO_ENGINEER_FILTER);
            copyFileSync(cachedPath, path.join(currentDest, fileName));
            processed++;
          },
        }),
      );
    } else {
      mkdirSync(destDir, { recursive: true });
      copyTreeAsIs(srcDir, destDir);
    }
  }

  await runWithConcurrency(tasks, concurrency);

  logger?.(
    `Audio assets: ${processed} processed, ${cached} cache-hit, ${copiedAsIs} copied as-is (pipeline hash ${hash})`,
  );
}

/**
 * Rollup plugin. On generateBundle, processes and copies the audio assets
 * into `{sdPlugin}/assets/audio/`. Thin wrapper around
 * `processAndCopyAudioAssets`.
 */
export function processAndCopyAudioAssetsPlugin({ sdPlugin }) {
  return {
    name: "process-and-copy-audio-assets",
    async generateBundle() {
      const destRoot = path.join(sdPlugin, "assets", "audio");
      await processAndCopyAudioAssets({ destRoot, logger: this.info?.bind(this) });
    },
  };
}
