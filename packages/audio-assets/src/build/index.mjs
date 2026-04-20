import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import { RADIO_ENGINEER_FILTER, VOICE_CATEGORIES } from "../presets.mjs";

const require = createRequire(import.meta.url);

const packageRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

export const audioAssetsPath = packageRoot;

const CACHE_ROOT = path.join(packageRoot, ".cache");

// Folders under packages/audio-assets/ that must never be copied into the
// plugin's assets/audio/ output (tooling, package plumbing, our own cache).
const SKIP_FOLDERS = new Set([".cache", "node_modules", "src"]);

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
 * plugin's `{sdPlugin}/assets/audio/` directory. MP3s in VOICE_CATEGORIES
 * pass through ffmpeg with RADIO_ENGINEER_FILTER applied; everything else is
 * copied unchanged.
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

      const destRoot = path.join(sdPlugin, "assets", "audio");
      mkdirSync(destRoot, { recursive: true });

      const tasks = [];
      let processed = 0;
      let cached = 0;
      let copiedAsIs = 0;

      for (const entry of readdirSync(audioAssetsPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || SKIP_FOLDERS.has(entry.name)) continue;

        const srcCategoryDir = path.join(audioAssetsPath, entry.name);
        const destCategoryDir = path.join(destRoot, entry.name);
        mkdirSync(destCategoryDir, { recursive: true });

        if (!VOICE_CATEGORIES.has(entry.name)) {
          cpSync(srcCategoryDir, destCategoryDir, { recursive: true });
          for (const f of readdirSync(srcCategoryDir, { withFileTypes: true })) {
            if (f.isFile()) copiedAsIs++;
          }
          continue;
        }

        const cacheCategoryDir = path.join(cacheRoot, entry.name);
        mkdirSync(cacheCategoryDir, { recursive: true });

        for (const fileEntry of readdirSync(srcCategoryDir, { withFileTypes: true })) {
          if (!fileEntry.isFile()) continue;
          if (!fileEntry.name.toLowerCase().endsWith(".mp3")) continue;

          const srcPath = path.join(srcCategoryDir, fileEntry.name);
          const cachedPath = path.join(cacheCategoryDir, fileEntry.name);
          const destPath = path.join(destCategoryDir, fileEntry.name);

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
      }

      await runWithConcurrency(tasks, concurrency);

      this.info?.(
        `Audio assets: ${processed} processed, ${cached} cache-hit, ${copiedAsIs} copied as-is (filter hash ${hash})`,
      );
    },
  };
}
