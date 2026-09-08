import { CALLOUT_SCRIPT_FILE } from "@iracedeck/callout-script";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real `node:child_process.spawn` is kept — every test here runs ffmpeg for
// real, on genuine audio, exactly as before — but wrapped so a test can
// observe (and act on) each invocation's argv. This is the "seam" #1143's
// review comment asks for: with it, the source-swap race is reproduced
// DETERMINISTICALLY (see "hashes and encodes the same snapshot" below) rather
// than by racing a timer against a real ffmpeg process.
const spawnHook = vi.hoisted(() => ({ onSpawn: null as ((args: readonly string[]) => void) | null }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options?: unknown) => {
      spawnHook.onSpawn?.(args);

      return actual.spawn(command, args as string[], options as never);
    },
  };
});

import { audioAssetsPath, BUNDLED_VOICE_IDS, processAndCopyAudioAssets, processVoiceTree } from "./index.mjs";

/** The repository's smallest real clip, so ffmpeg has genuine audio to process. */
const SAMPLE_CLIP = path.join(audioAssetsPath, "voice/default/lap-time-second/1.mp3");

/**
 * A DIFFERENT real clip, for the cache-freshness tests below: replacing a
 * source with this one changes the bytes ffmpeg sees, so a stale cache shows up
 * as audio, not merely as a counter.
 */
const OTHER_SAMPLE_CLIP = path.join(audioAssetsPath, "voice/default/lap-time-second/2.mp3");

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

/** `listFiles`, but a directory the run never had reason to create is no files. */
function listFilesIfAny(dir: string): string[] {
  return existsSync(dir) ? listFiles(dir) : [];
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
  spawnHook.onSpawn = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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
    // The cache holds clips and the sidecar digest of the source each was built
    // from (#1143) — no script, and nothing else.
    expect(listFiles(cacheDir)).toEqual(["flags/blue-01.mp3", "flags/blue-01.mp3.src.sha256"]);
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
 * What makes a cached, ffmpeg-processed clip current (#1143). It is the SOURCE
 * BYTES, not the source's mtime: on Windows a copy carries the mtime of the file
 * it was copied FROM, so replacing a clip via an Explorer paste (or `cp -p`)
 * routinely leaves the new source looking OLDER than the output built from the
 * old one — which is how a stale clip shipped in a voice pack.
 */
describe("processVoiceTree — cache freshness", () => {
  /** A voice tree of exactly one clip, plus the paths the tests assert on. */
  function oneClipTree(prefix: string): { srcDir: string; destDir: string; cacheDir: string; clip: string } {
    const root = tempDir(prefix);
    const srcDir = path.join(root, "src");

    mkdirSync(path.join(srcDir, "flags"), { recursive: true });

    const clip = path.join(srcDir, "flags", "blue-01.mp3");

    copyFileSync(SAMPLE_CLIP, clip);

    return { srcDir, destDir: path.join(root, "dest"), cacheDir: path.join(root, "cache"), clip };
  }

  it("rebuilds a clip whose bytes changed but whose mtime went BACKWARDS — the Windows copy case (#1143)", async () => {
    const { srcDir, destDir, cacheDir, clip } = oneClipTree("ird-cache-older-source-");

    const first = await processVoiceTree({ srcDir, destDir, cacheDir });

    expect(first.processed).toBe(1);

    const firstOutput = readFileSync(path.join(destDir, "flags/blue-01.mp3"));

    // Exactly what a paste over an existing clip produces: different audio,
    // carrying the mtime of the file it came from — here forced a day behind
    // the cached output, so no mtime comparison can call the cache stale.
    copyFileSync(OTHER_SAMPLE_CLIP, clip);

    const behind = new Date(statSync(path.join(cacheDir, "flags/blue-01.mp3")).mtimeMs - 24 * 60 * 60 * 1000);

    utimesSync(clip, behind, behind);
    expect(statSync(clip).mtimeMs).toBeLessThan(statSync(path.join(cacheDir, "flags/blue-01.mp3")).mtimeMs);

    const second = await processVoiceTree({ srcDir, destDir, cacheDir });

    expect(second).toMatchObject({ processed: 1, cached: 0 });
    // The claim that matters is the audio, not the counter: what was copied out
    // is built from the clip that is on disk now.
    expect(readFileSync(path.join(destDir, "flags/blue-01.mp3")).equals(firstOutput)).toBe(false);
  }, 60_000);

  it("re-runs nothing for a source that was merely re-touched — same bytes, newer mtime", async () => {
    const { srcDir, destDir, cacheDir, clip } = oneClipTree("ird-cache-touched-source-");

    const first = await processVoiceTree({ srcDir, destDir, cacheDir });

    expect(first.processed).toBe(1);

    const cachedOutput = readFileSync(path.join(cacheDir, "flags/blue-01.mp3"));
    const ahead = new Date(Date.now() + 24 * 60 * 60 * 1000);

    utimesSync(clip, ahead, ahead);

    const second = await processVoiceTree({ srcDir, destDir, cacheDir });

    // The content check is not merely safer than the mtime one — it also spares
    // the ffmpeg run a checkout or a `touch` used to spend.
    expect(second).toMatchObject({ processed: 0, cached: 1 });
    expect(readFileSync(path.join(cacheDir, "flags/blue-01.mp3")).equals(cachedOutput)).toBe(true);
  }, 60_000);

  it("leaves no temporary snapshot or output file behind after processing (#1143)", async () => {
    const { srcDir, destDir, cacheDir } = oneClipTree("ird-cache-no-tmp-leftovers-");

    await processVoiceTree({ srcDir, destDir, cacheDir });

    expect(listFiles(cacheDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 30_000);

  /**
   * The race the fix closes: a source replaced WHILE ffmpeg is still running on
   * it. This is reproduced deterministically rather than by racing a timer
   * against a real ffmpeg process, using the `node:child_process` spawn hook
   * declared at the top of this file — the injectable seam this test needed
   * and the suite didn't have before. The hook fires synchronously the instant
   * ffmpeg is launched, i.e. strictly AFTER `processClipIntoCache` has already
   * read, hashed and snapshotted the source, and it overwrites the live source
   * file at that exact moment — the earliest point a real mid-build replace
   * (an Explorer paste, say) could land. The fixed code must be unaffected:
   * ffmpeg was handed a snapshot, never `sourcePath` itself, so nothing that
   * happens to `sourcePath` after the snapshot was taken can reach the output.
   */
  it("hashes and encodes the same snapshot of a clip, even when the source is replaced while ffmpeg runs on it (#1143)", async () => {
    const { srcDir, destDir, cacheDir, clip } = oneClipTree("ird-cache-source-swap-race-");

    const originalBytes = readFileSync(clip);
    const originalDigest = sha256(originalBytes);
    const spawnedInputs: string[] = [];

    spawnHook.onSpawn = (args) => {
      const iIndex = args.indexOf("-i");

      if (iIndex === -1) return;

      spawnedInputs.push(args[iIndex + 1]!);
      // The swap: happens once ffmpeg has already been launched against
      // whatever `runFfmpeg` was given as its input path.
      copyFileSync(OTHER_SAMPLE_CLIP, clip);
    };

    const result = await processVoiceTree({ srcDir, destDir, cacheDir });

    expect(result.processed).toBe(1);
    expect(spawnedInputs).toHaveLength(1);
    // The bug this replaces handed ffmpeg `sourcePath` itself, so a swap
    // landing here would change what got encoded. Assert the fix never does.
    expect(spawnedInputs[0]).not.toBe(clip);

    // The sidecar must still name the ORIGINAL bytes — the ones read before
    // the swap — never the replacement the source holds now.
    const sidecarDigest = readFileSync(`${path.join(cacheDir, "flags/blue-01.mp3")}.src.sha256`, "utf-8").trim();

    expect(sidecarDigest).toBe(originalDigest);

    // And the output must actually BE encoded from those original bytes, not
    // the replacement. Proved two ways: it matches an uninterrupted encode of
    // the original bytes (ffmpeg's output is deterministic for a given binary
    // + args — the same assumption `processVoiceTree`'s own docs and the
    // voice-pack packer rely on), and it does NOT match an uninterrupted
    // encode of the replacement bytes.
    const referenceOf = async (bytes: Buffer, prefix: string): Promise<Buffer> => {
      const root = tempDir(prefix);
      const refSrcDir = path.join(root, "src");

      writeFile(path.join(refSrcDir, "flags", "blue-01.mp3"), bytes);
      await processVoiceTree({ srcDir: refSrcDir, destDir: path.join(root, "dest"), cacheDir: path.join(root, "cache") });

      return readFileSync(path.join(root, "dest", "flags/blue-01.mp3"));
    };

    const originalEncoded = await referenceOf(originalBytes, "ird-cache-source-swap-original-");
    const replacementEncoded = await referenceOf(readFileSync(OTHER_SAMPLE_CLIP), "ird-cache-source-swap-replacement-");
    const raceOutput = readFileSync(path.join(destDir, "flags/blue-01.mp3"));

    expect(raceOutput.equals(originalEncoded)).toBe(true);
    expect(raceOutput.equals(replacementEncoded)).toBe(false);

    // No snapshot or output temp file left behind, race or not.
    expect(listFiles(cacheDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 120_000);
});

/**
 * The plugin build's copy step, run against a temporary package tree so the
 * test does not encode 1500 clips: the same allow-list, bundled-voice filter
 * and per-voice walk as the real thing, on a tree of two clips.
 */
describe("processAndCopyAudioAssets — what reaches the plugin's assets/audio", () => {
  /**
   * The two voices the fixture authors. Which of them is BUNDLED is deliberately
   * not fixed here — the test below derives that from `BUNDLED_VOICE_IDS`, which
   * since #1034 stage 3 is empty, so today neither is copied.
   */
  const FIXTURE_VOICES = ["default", "other"] as const;

  /**
   * A package tree with both published voices, plus the sfx tone and the
   * `configs/` folder the allow-list has to leave behind. Both tests below run
   * the copy step over it.
   */
  function buildTwoVoiceFixture(): { srcRoot: string; destRoot: string; cacheDir: string } {
    const root = tempDir("ird-audio-copy-");
    const srcRoot = path.join(root, "package");

    for (const voice of FIXTURE_VOICES) {
      mkdirSync(path.join(srcRoot, "voice", voice, "flags"), { recursive: true });
      copyFileSync(SAMPLE_CLIP, path.join(srcRoot, "voice", voice, "flags", "blue-01.mp3"));
      writeFile(path.join(srcRoot, "voice", voice, CALLOUT_SCRIPT_FILE), SCRIPT_BYTES);
    }

    mkdirSync(path.join(srcRoot, "sfx"), { recursive: true });
    copyFileSync(SAMPLE_CLIP, path.join(srcRoot, "sfx", "tick.mp3"));
    writeFile(path.join(srcRoot, "configs", "default.voice.json"), "{}");

    return {
      srcRoot,
      destRoot: path.join(root, "assets", "audio"),
      cacheDir: path.join(root, "cache"),
    };
  }

  it("lands each bundled voice's callouts.json byte-identical, and nothing from a voice that is not bundled", async () => {
    const { srcRoot, destRoot, cacheDir } = buildTwoVoiceFixture();

    // Derived, not spelled out: with #1034 stage 3 `BUNDLED_VOICE_IDS` is empty,
    // so the expectation below is "no voice reaches the plugin, and the log says
    // so for both" — and re-bundling a voice moves it back without an edit here.
    // It cannot go vacuous: the sibling `voices: "all"` test copies both voices
    // unconditionally, so the walk this one filters is exercised either way.
    const bundled = FIXTURE_VOICES.filter((voice) => BUNDLED_VOICE_IDS.includes(voice));
    const skipped = FIXTURE_VOICES.filter((voice) => !BUNDLED_VOICE_IDS.includes(voice));

    const log: string[] = [];

    await processAndCopyAudioAssets({ destRoot, srcRoot, cacheDir, logger: (line) => log.push(line) });

    expect(listFiles(destRoot)).toEqual(
      [
        "sfx/tick.mp3",
        ...bundled.flatMap((voice) => [`voice/${voice}/${CALLOUT_SCRIPT_FILE}`, `voice/${voice}/flags/blue-01.mp3`]),
      ].sort(),
    );
    // The sfx tone is copied as-is — the one thing that ships whatever is bundled.
    expect(readFileSync(path.join(destRoot, "sfx", "tick.mp3")).equals(readFileSync(SAMPLE_CLIP))).toBe(true);

    for (const voice of bundled) {
      expect(readFileSync(path.join(destRoot, "voice", voice, CALLOUT_SCRIPT_FILE)).equals(SCRIPT_BYTES)).toBe(true);
      // The clip is the processed one, not the source.
      expect(
        readFileSync(path.join(destRoot, `voice/${voice}/flags/blue-01.mp3`)).equals(readFileSync(SAMPLE_CLIP)),
      ).toBe(false);
    }

    for (const voice of skipped) {
      expect(existsSync(path.join(destRoot, "voice", voice))).toBe(false);
      expect(log.some((line) => line.includes(`voice "${voice}" is published, not bundled`))).toBe(true);
    }

    // Nothing bundled means no `voice/` at all — not an empty directory the
    // scanner would then find and report on.
    if (bundled.length === 0) expect(existsSync(path.join(destRoot, "voice"))).toBe(false);

    // The radio cache holds processed clips (each with its source-digest
    // sidecar, #1143) and nothing else, and only for what was actually walked.
    expect(listFilesIfAny(cacheDir)).toEqual(
      bundled
        .flatMap((voice) => [`voice/${voice}/flags/blue-01.mp3`, `voice/${voice}/flags/blue-01.mp3.src.sha256`])
        .sort(),
    );
  }, 30_000);

  it('copies every authored voice when asked for voices: "all" — the harness auditions what is authored, not what ships', async () => {
    const { srcRoot, destRoot, cacheDir } = buildTwoVoiceFixture();
    const log: string[] = [];

    await processAndCopyAudioAssets({ destRoot, srcRoot, cacheDir, voices: "all", logger: (line) => log.push(line) });

    expect(existsSync(path.join(destRoot, "voice", "other"))).toBe(true);
    expect(existsSync(path.join(destRoot, "voice", "default"))).toBe(true);
    // Not merely a directory each: the published-only voice arrives whole,
    // clips processed and script beside them, exactly like the bundled one.
    expect(listFiles(destRoot)).toEqual([
      "sfx/tick.mp3",
      `voice/default/${CALLOUT_SCRIPT_FILE}`,
      "voice/default/flags/blue-01.mp3",
      `voice/other/${CALLOUT_SCRIPT_FILE}`,
      "voice/other/flags/blue-01.mp3",
    ]);
    // Byte-identical scripts, asserted on THIS path because since #1034 stage 3
    // it is the only one that copies a voice at all — the bundled filter above
    // has nothing to prove it on.
    for (const voice of FIXTURE_VOICES) {
      expect(readFileSync(path.join(destRoot, "voice", voice, CALLOUT_SCRIPT_FILE)).equals(SCRIPT_BYTES)).toBe(true);
    }
    expect(log.some((line) => line.includes("is published, not bundled"))).toBe(false);
  }, 30_000);

  it("refuses a source root outside the package unless told where its cache goes", async () => {
    const root = tempDir("ird-audio-copy-foreign-");

    mkdirSync(path.join(root, "package"), { recursive: true });

    await expect(
      processAndCopyAudioAssets({ destRoot: path.join(root, "dest"), srcRoot: path.join(root, "package") }),
    ).rejects.toThrow(/cacheDir is required/);
  });
});
