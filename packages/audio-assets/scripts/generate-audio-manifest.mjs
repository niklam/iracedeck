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
import { BUNDLED_VOICE_IDS, SHIPPED_FOLDERS } from "../src/build/index.mjs";

/** The folder whose contents are filtered to the bundled voices. */
const VOICE_ROOT = "voice";

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
  // Only the folders the plugin actually ships. The walk used to start at the
  // package root with a skip-list, which meant any new top-level folder joined
  // the manifest by default — and #1100 added `dist/`, the staged voice pack,
  // whose 1545 copies would have doubled the manifest and pointed the engine at
  // clips no plugin contains.
  //
  // Same allow-list the copy step uses, imported rather than restated: a
  // manifest listing a clip the build does not ship is a callout that resolves
  // to nothing, and the two drifting apart is exactly how that happens.
  const clips = [...SHIPPED_FOLDERS]
    .sort()
    .flatMap((folder) =>
      // `voice/` is filtered to the BUNDLED set, the way the copy step is. The
      // manifest describes what the plugin ITSELF provides, so listing a voice
      // the build no longer ships would be a claim about clips that are not
      // there.
      //
      // A no-op today, and a landmine without it. `bundledVoices` — the ids the
      // scanner reserves so no pack may claim one — is derived from this
      // manifest. At stage 3, when the bundle is dropped, an unfiltered
      // manifest would still name `default`, so the DOWNLOADED `default` pack
      // would be refused as "provided by the plugin's bundled audio" and the
      // engineer would go silent, on the release whose whole job is to make
      // that swap invisible.
      folder === VOICE_ROOT
        ? BUNDLED_VOICE_IDS.flatMap((voiceId) => {
            const dir = path.join(PACKAGE_ROOT, folder, voiceId);

            return fs.existsSync(dir) ? collectClips(dir) : [];
          })
        : collectClips(path.join(PACKAGE_ROOT, folder)),
    );

  clips.sort();

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
