#!/usr/bin/env node

/**
 * Generates the two manifests for @iracedeck/audio-assets.
 *
 * Walks the package directory and emits a sorted list of every .mp3 relative
 * to the package root, plus well-known asset paths consumed by the audio
 * scenarios DSL (walkie-talkie ticks, ambient loop).
 *
 * `manifest.json` covers every AUTHORED voice; `manifest.bundled.json` covers
 * only the voices a plugin distributable carries (`BUNDLED_VOICE_IDS`). They
 * differ by whatever is published-but-not-bundled, which since #1034 stage 3
 * is every voice: the bundled slice is the sfx tree and nothing else.
 *
 * The manifest lets `@iracedeck/audio-scenarios` validate every clip
 * reference at catalog-load time (design doc §9 — broken scenarios log and
 * skip, the rest keep working).
 *
 * Usage: node packages/audio-assets/scripts/generate-audio-manifest.mjs
 *
 * Run this after adding, removing, or moving clips, and commit both files. A
 * freshness test (manifest.test.ts) fails CI if either committed manifest
 * drifts from the actual file tree.
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { BUNDLED_VOICE_IDS, SHIPPED_FOLDERS } from "../src/build/index.mjs";

/** The folder whose contents the `voices` option filters. */
const VOICE_ROOT = "voice";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const OUTPUT_FILE = path.join(PACKAGE_ROOT, "manifest.json");
const BUNDLED_OUTPUT_FILE = path.join(PACKAGE_ROOT, "manifest.bundled.json");

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

/**
 * The manifest for one voice slice. `voices: "all"` names every authored voice
 * — the manifest the harness, the generators and this package's own tests read
 * as "what is authored". `voices: "bundled"` names only the slice a plugin
 * distributable carries — the manifest a plugin compiles in (#1034 stage 3).
 */
export function buildManifest({ voices } = {}) {
  // No default and no tolerance: a caller that means one slice and is handed
  // the other writes a manifest describing clips that are not there, which
  // surfaces only as a callout resolving to nothing at runtime.
  if (voices !== "all" && voices !== "bundled") {
    throw new Error(`buildManifest: voices must be "all" or "bundled", got ${JSON.stringify(voices)}`);
  }

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
      // `voice/` is the one folder the two slices disagree about. The BUNDLED
      // manifest is the one a plugin compiles in: it describes what the
      // distributable ITSELF provides, so it names no voice the build does not
      // ship. That is what stage 3 turned on — a plugin reserves voice ids off
      // the manifest it carries, so no downloaded pack may claim one the plugin
      // already has, and now that `default` has left this slice the DOWNLOADED
      // `default` pack loads instead of being refused as "provided by the
      // plugin's bundled audio".
      //
      // The AUTHORED manifest names every voice on disk: the set the harness
      // auditions and this package's own generators and tests read as "the
      // authored voice", which an empty bundle would otherwise leave without.
      folder === VOICE_ROOT
        ? authoredVoiceIds()
            .filter((voiceId) => voices === "all" || BUNDLED_VOICE_IDS.includes(voiceId))
            .flatMap((voiceId) => collectClips(path.join(PACKAGE_ROOT, folder, voiceId)))
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

/** Every `voice/<id>/` directory in the package — the authored set. */
function authoredVoiceIds() {
  const dir = path.join(PACKAGE_ROOT, VOICE_ROOT);

  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function main() {
  for (const [file, voices] of [
    [OUTPUT_FILE, "all"],
    [BUNDLED_OUTPUT_FILE, "bundled"],
  ]) {
    const manifest = buildManifest({ voices });
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    console.log(`Generated ${file}`);
    console.log(`Clips: ${manifest.clips.length}`);
  }
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
