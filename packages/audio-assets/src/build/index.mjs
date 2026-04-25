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
// The voice/ tree holds all radio-engineer voice clips, organised as
// voice/<voice>/<category>/*.mp3. Every .mp3 under it (at any depth) gets
// the radio filter; anything outside voice/ (currently sfx/) is copied
// unchanged so SFX tones, ticks and squelch beeps stay clean.
const VOICE_ROOT = "voice";

function filterHash(chain) {
  return createHash("sha256").update(chain).digest("hex").slice(0, 8);
}

function runFfmpeg(ffmpegPath, inputPath, outputPath, filterChain) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-af",
      filterChain,
      "-codec:a",
      "libmp3lame",
      "-q:a",
      "4",
      outputPath,
    ];
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
  return statSync(cachedPath).mtimeMs >= statSync(sourcePath).mtimeMs;
}

/**
 * Rollup plugin. On generateBundle, copies `packages/audio-assets/` into the
 * plugin's `{sdPlugin}/assets/audio/` directory. Every .mp3 under voice/
 * (at any depth) passes through ffmpeg with RADIO_ENGINEER_FILTER applied;
 * everything outside voice/ (currently sfx/) is copied unchanged.
 *
 * Processed outputs are cached at `packages/audio-assets/.cache/<filter-hash>/`
 * keyed on the filter chain so that a filter-string change invalidates the
 * cache automatically. Per-file invalidation is mtime-based (rebuild if the
 * source MP3 is newer than its cached counterpart).
 */
export function processAndCopyAudioAssetsPlugin({ sdPlugin }) {
  const ffmpegPath = require("ffmpeg-static");
  const hash = filterHash(RADIO_ENGINEER_FILTER);
  const cacheRoot = path.join(CACHE_ROOT, hash);
  const concurrency = Math.min(4, Math.max(1, os.availableParallelism?.() ?? os.cpus().length));

  return {
    name: "process-and-copy-audio-assets",
    async generateBundle() {
      if (!existsSync(audioAssetsPath)) return;

      // Clear destRoot before recreating so renamed/removed top-level
      // folders (e.g. the legacy `pit-crew/` after #441 §1) don't leak
      // into the bundled output across incremental dev builds. The cache
      // under `.cache/` is keyed by filter hash and lives outside
      // destRoot, so this doesn't invalidate it.
      const destRoot = path.join(sdPlugin, "assets", "audio");
      rmSync(destRoot, { recursive: true, force: true });
      mkdirSync(destRoot, { recursive: true });

      const tasks = [];
      let processed = 0;
      let cached = 0;
      let copiedAsIs = 0;

      // Recursively walk a voice subtree, queuing every .mp3 for radio-filter
      // processing. Preserves directory structure under destRoot/cacheRoot.
      const queueVoiceTree = (srcDir, destDir, cacheDir) => {
        mkdirSync(destDir, { recursive: true });
        mkdirSync(cacheDir, { recursive: true });

        for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
          const srcPath = path.join(srcDir, entry.name);

          if (entry.isDirectory()) {
            queueVoiceTree(srcPath, path.join(destDir, entry.name), path.join(cacheDir, entry.name));
            continue;
          }

          if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".mp3")) continue;

          const cachedPath = path.join(cacheDir, entry.name);
          const destPath = path.join(destDir, entry.name);

          if (cacheIsFresh(srcPath, cachedPath)) {
            tasks.push(async () => {
              copyFileSync(cachedPath, destPath);
              cached++;
            });
          } else {
            tasks.push(async () => {
              await runFfmpeg(ffmpegPath, srcPath, cachedPath, RADIO_ENGINEER_FILTER);
              copyFileSync(cachedPath, destPath);
              processed++;
            });
          }
        }
      };

      const copyTreeAsIs = (srcDir, destDir) => {
        cpSync(srcDir, destDir, { recursive: true });
        for (const f of readdirSync(srcDir, { withFileTypes: true })) {
          if (f.isFile()) copiedAsIs++;
        }
      };

      for (const entry of readdirSync(audioAssetsPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || SKIP_FOLDERS.has(entry.name)) continue;

        const srcDir = path.join(audioAssetsPath, entry.name);
        const destDir = path.join(destRoot, entry.name);

        if (entry.name === VOICE_ROOT) {
          queueVoiceTree(srcDir, destDir, path.join(cacheRoot, VOICE_ROOT));
        } else {
          mkdirSync(destDir, { recursive: true });
          copyTreeAsIs(srcDir, destDir);
        }
      }

      await runWithConcurrency(tasks, concurrency);

      this.info?.(
        `Audio assets: ${processed} processed, ${cached} cache-hit, ${copiedAsIs} copied as-is (filter hash ${hash})`,
      );
    },
  };
}
