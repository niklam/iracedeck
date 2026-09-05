import { CALLOUT_SCRIPT_FILE } from "@iracedeck/callout-script";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { audioAssetsPath, processAndCopyAudioAssets, processVoiceTree } from "./index.mjs";

/** The repository's smallest real clip, so ffmpeg has genuine audio to process. */
const SAMPLE_CLIP = path.join(audioAssetsPath, "voice/default/lap-time-second/1.mp3");

/**
 * A script whose bytes are NOT what any serializer here would emit — CRLF
 * endings, a tab, no trailing newline — so a copy that re-serialized the file
 * (sorted keys, LF, two-space indent) would be caught, not merely one that
 * dropped it.
 */
const SCRIPT_BYTES = Buffer.from(
  '{\r\n\t"schema": 1,\r\n\t"scenarios": { "pit-crew.flag-green": { "sequence": ["pool:flag-green"] } },\r\n' +
    '\t"frames": {},\r\n\t"pools": { "flag-green": { "group": "flags", "base": "green" } }\r\n}',
  "utf-8",
);

/** Every file under `dir`, as sorted POSIX paths relative to it. */
function listFiles(dir: string, relative = ""): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;

    if (entry.isDirectory()) found.push(...listFiles(path.join(dir, entry.name), rel));
    else found.push(rel);
  }

  return found.sort();
}

function writeFile(file: string, data: Buffer | string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("has the sample clip to build its fixtures from", () => {
  expect(existsSync(SAMPLE_CLIP)).toBe(true);
});

/**
 * `processVoiceTree` is the walk the voice-pack packer runs over one voice; the
 * plugin build runs the same walk per bundled voice. The clips go through
 * ffmpeg (a real run here, on one small clip); the voice's `callouts.json` must
 * ride along UNCHANGED — never through ffmpeg, never into the radio cache.
 */
describe("processVoiceTree — the voice's callouts.json", () => {
  it("copies the script directly under the voice as-is, beside the processed clips, and never into the cache", async () => {
    const root = tempDir("ird-voice-tree-");
    const srcDir = path.join(root, "src");
    const destDir = path.join(root, "dest");
    const cacheDir = path.join(root, "cache");

    mkdirSync(path.join(srcDir, "flags"), { recursive: true });
    copyFileSync(SAMPLE_CLIP, path.join(srcDir, "flags", "blue-01.mp3"));
    writeFile(path.join(srcDir, CALLOUT_SCRIPT_FILE), SCRIPT_BYTES);

    const result = await processVoiceTree({ srcDir, destDir, cacheDir });

    // The script is reported on its own, never as a clip: the packer counts
    // `files` against the source's mp3s and checks each against the clip
    // grammar, and a json in that list would fail both.
    expect(result.files).toEqual(["flags/blue-01.mp3"]);
    expect(result.script).toBe(CALLOUT_SCRIPT_FILE);

    expect(listFiles(destDir)).toEqual([CALLOUT_SCRIPT_FILE, "flags/blue-01.mp3"]);
    expect(readFileSync(path.join(destDir, CALLOUT_SCRIPT_FILE)).equals(SCRIPT_BYTES)).toBe(true);

    // The clip went through the pipeline — the copy is the cached, processed
    // one — while the cache holds clips only.
    expect(readFileSync(path.join(destDir, "flags/blue-01.mp3")).equals(readFileSync(SAMPLE_CLIP))).toBe(false);
    expect(listFiles(cacheDir)).toEqual(["flags/blue-01.mp3"]);
  }, 30_000);

  it("ignores a callouts.json deeper in the tree, like any other non-mp3 file", async () => {
    const root = tempDir("ird-voice-tree-nested-");
    const srcDir = path.join(root, "src");
    const destDir = path.join(root, "dest");

    mkdirSync(path.join(srcDir, "flags"), { recursive: true });
    copyFileSync(SAMPLE_CLIP, path.join(srcDir, "flags", "blue-01.mp3"));
    writeFile(path.join(srcDir, "flags", CALLOUT_SCRIPT_FILE), SCRIPT_BYTES);
    writeFile(path.join(srcDir, "flags", "notes.txt"), "not a clip");

    const result = await processVoiceTree({ srcDir, destDir, cacheDir: path.join(root, "cache") });

    expect(result.files).toEqual(["flags/blue-01.mp3"]);
    expect(result.script).toBeNull();
    expect(listFiles(destDir)).toEqual(["flags/blue-01.mp3"]);
  }, 30_000);

  it("reports a clips-only voice as having no script", async () => {
    const root = tempDir("ird-voice-tree-clips-only-");
    const srcDir = path.join(root, "src");
    const destDir = path.join(root, "dest");

    mkdirSync(path.join(srcDir, "flags"), { recursive: true });
    copyFileSync(SAMPLE_CLIP, path.join(srcDir, "flags", "blue-01.mp3"));

    const result = await processVoiceTree({ srcDir, destDir, cacheDir: path.join(root, "cache") });

    expect(result.script).toBeNull();
    expect(listFiles(destDir)).toEqual(["flags/blue-01.mp3"]);
  }, 30_000);
});

/**
 * The plugin build's copy step, run against a temporary package tree so the
 * test does not encode 1500 clips: the same allow-list, bundled-voice filter
 * and per-voice walk as the real thing, on a tree of two clips.
 */
describe("processAndCopyAudioAssets — what reaches the plugin's assets/audio", () => {
  it("lands the bundled voice's callouts.json byte-identical, and nothing from a voice that is not bundled", async () => {
    const root = tempDir("ird-audio-copy-");
    const srcRoot = path.join(root, "package");
    const destRoot = path.join(root, "assets", "audio");
    const cacheDir = path.join(root, "cache");

    // `default` is the one bundled voice (BUNDLED_VOICE_IDS); `other` is what
    // a published-only voice looks like to the copy step.
    for (const voice of ["default", "other"]) {
      mkdirSync(path.join(srcRoot, "voice", voice, "flags"), { recursive: true });
      copyFileSync(SAMPLE_CLIP, path.join(srcRoot, "voice", voice, "flags", "blue-01.mp3"));
      writeFile(path.join(srcRoot, "voice", voice, CALLOUT_SCRIPT_FILE), SCRIPT_BYTES);
    }

    mkdirSync(path.join(srcRoot, "sfx"), { recursive: true });
    copyFileSync(SAMPLE_CLIP, path.join(srcRoot, "sfx", "tick.mp3"));
    writeFile(path.join(srcRoot, "configs", "default.voice.json"), "{}");

    const log: string[] = [];

    await processAndCopyAudioAssets({ destRoot, srcRoot, cacheDir, logger: (line) => log.push(line) });

    expect(listFiles(destRoot)).toEqual([
      "sfx/tick.mp3",
      `voice/default/${CALLOUT_SCRIPT_FILE}`,
      "voice/default/flags/blue-01.mp3",
    ]);
    expect(readFileSync(path.join(destRoot, "voice", "default", CALLOUT_SCRIPT_FILE)).equals(SCRIPT_BYTES)).toBe(true);
    // The sfx tone is copied as-is; the voice clip is the processed one.
    expect(readFileSync(path.join(destRoot, "sfx", "tick.mp3")).equals(readFileSync(SAMPLE_CLIP))).toBe(true);
    expect(readFileSync(path.join(destRoot, "voice/default/flags/blue-01.mp3")).equals(readFileSync(SAMPLE_CLIP))).toBe(
      false,
    );
    // The radio cache holds processed clips and nothing else.
    expect(listFiles(cacheDir)).toEqual(["voice/default/flags/blue-01.mp3"]);
    expect(log.some((line) => line.includes('voice "other" is published, not bundled'))).toBe(true);
  }, 30_000);

  it("refuses a source root outside the package unless told where its cache goes", async () => {
    const root = tempDir("ird-audio-copy-foreign-");

    mkdirSync(path.join(root, "package"), { recursive: true });

    await expect(
      processAndCopyAudioAssets({ destRoot: path.join(root, "dest"), srcRoot: path.join(root, "package") }),
    ).rejects.toThrow(/cacheDir is required/);
  });
});
