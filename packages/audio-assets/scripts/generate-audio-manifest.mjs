#!/usr/bin/env node

/**
 * Generates manifest.json for @iracedeck/audio-assets.
 *
 * Walks the package directory and emits a sorted list of every .mp3 relative
 * to the package root, plus well-known asset paths consumed by the audio
 * scenarios DSL (walkie-talkie ticks, ambient loop).
 *
 * The manifest lets `@iracedeck/audio-scenarios` validate every clip
 * reference at catalog-load time (design doc §9 — broken scenarios log and
 * skip, the rest keep working).
 *
 * Usage: node packages/audio-assets/scripts/generate-audio-manifest.mjs
 *
 * Run this after adding, removing, or moving clips. A freshness test
 * (manifest.test.ts) fails CI if the committed manifest drifts from the
 * actual file tree.
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const OUTPUT_FILE = path.join(PACKAGE_ROOT, "manifest.json");

const IGNORED_DIRS = new Set(["node_modules", "scripts"]);

/**
 * Collect every .mp3 under `dir` (recursive) as a list of package-root-relative
 * POSIX paths. Sorted so the output is deterministic across platforms.
 */
function collectClips(dir) {
  const clips = [];

  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;

      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp3")) {
        const rel = path.relative(PACKAGE_ROOT, full).split(path.sep).join("/");
        clips.push(rel);
      }
    }
  }

  walk(dir);
  clips.sort();

  return clips;
}

export function buildManifest() {
  const clips = collectClips(PACKAGE_ROOT);

  return {
    clips,
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: {
      open: "sfx/IRD-tick-open.mp3",
      close: "sfx/IRD-tick-close.mp3",
    },
  };
}

function main() {
  const manifest = buildManifest();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`Generated ${OUTPUT_FILE}`);
  console.log(`Clips: ${manifest.clips.length}`);
}

// Direct-exec guard: only run main() when this file was executed as the entry
// script. Tolerate missing argv[1] (e.g., when imported by a test runner) so
// importing buildManifest() doesn't throw at module-eval time.
const invokedPath = process.argv[1];
if (
  invokedPath &&
  (import.meta.url === url.pathToFileURL(invokedPath).href ||
    invokedPath === url.fileURLToPath(import.meta.url))
) {
  main();
}
