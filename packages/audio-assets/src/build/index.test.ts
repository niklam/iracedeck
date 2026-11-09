import { CALLOUT_SCRIPT_FILE } from "@iracedeck/callout-script";
import { execFileSync } from "node:child_process";
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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RADIO_ENGINEER_FILTER, VOICE_LOUDNESS_NORMALIZATION } from "../presets.mjs";
import {
  audioAssetsPath,
  BUNDLED_VOICE_IDS,
  formatGainDb,
  loudnessGain,
  measureLoudness,
  parseIntegratedLoudness,
  PIPELINE_IDENTITY,
  pipelineCacheKey,
  pipelineIdentity,
  pipelineIdentityHash,
  processAndCopyAudioAssets,
  processVoiceTree,
} from "./index.mjs";
import { installedPackageVersion } from "./installed-version.mjs";

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

/**
 * Which of a clip's two ffmpeg runs (#1657) an argv is: the loudness
 * measurement writes to the `null` muxer, the encode to `mp3`. Each spawn-hook
 * test below names the run it acts on, so its claim stays about that run.
 */
function spawnKind(args: readonly string[]): "measure" | "encode" | "other" {
  const muxers = args.flatMap((arg, i) => (arg === "-f" ? [args[i + 1]] : []));

  if (muxers.includes("null")) return "measure";

  if (muxers.includes("mp3")) return "encode";

  return "other";
}

/** The `-i` argument of a spawned ffmpeg argv. */
function spawnInput(args: readonly string[]): string {
  return args[args.indexOf("-i") + 1]!;
}

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
 * The pipeline identity (#1667): one object naming everything a processed
 * clip's bytes depend on, hashed once for the cache key and once for the pack
 * record. An `ffmpeg-static` bump used to be invisible to the cache key, so a
 * warm cache went on serving the previous binary's output.
 */
describe("PIPELINE_IDENTITY — the cache key and the record's pipeline digest", () => {
  it("names the filter chain, the loudness normalization, the encode args and the installed ffmpeg-static version, frozen", () => {
    expect(PIPELINE_IDENTITY).toEqual({
      filter: RADIO_ENGINEER_FILTER,
      loudness: {
        targetLufs: -22,
        maxGainDb: 12,
        gainStepDb: 0.1,
        silenceFloorLufs: -50,
        measurement: { loops: 8, filter: "ebur128=framelog=quiet" },
      },
      encodeArgs: ["-ar", "16000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "32k"],
      ffmpegStatic: installedPackageVersion("ffmpeg-static", import.meta.url),
    });
    // The very descriptor the pipeline runs with, not a copy that could drift.
    expect(PIPELINE_IDENTITY.loudness).toBe(VOICE_LOUDNESS_NORMALIZATION);
    expect(Object.isFrozen(PIPELINE_IDENTITY)).toBe(true);
    expect(Object.isFrozen(PIPELINE_IDENTITY.encodeArgs)).toBe(true);
    expect(Object.isFrozen(PIPELINE_IDENTITY.loudness)).toBe(true);
    expect(Object.isFrozen(PIPELINE_IDENTITY.loudness.measurement)).toBe(true);
  });

  // ffmpeg-static exports the path in its FFMPEG_BIN variable instead of its
  // own binary when the variable is set, so the package version alone no longer
  // names the binary that ran. The override is a field only while set: unset,
  // the identity is byte-for-byte the one the committed records were sealed
  // with, so neither record goes stale from this field existing.
  it("is the committed records' pipeline digest with no ffmpeg-static override, and another one with it", () => {
    const sealed = JSON.parse(readFileSync(path.join(audioAssetsPath, "pack-records", "default.json"), "utf-8"));
    const unset = pipelineIdentity({});

    expect(unset).toEqual(PIPELINE_IDENTITY);
    expect(unset).not.toHaveProperty("ffmpegBinaryOverride");
    expect(pipelineIdentityHash(unset)).toBe(sealed.inputs.pipeline);
    expect(pipelineIdentityHash(pipelineIdentity({ FFMPEG_BIN: "" }))).toBe(sealed.inputs.pipeline);

    const overridden = pipelineIdentity({ FFMPEG_BIN: "/opt/ffmpeg/bin/ffmpeg" });

    expect(overridden).toEqual({ ...unset, ffmpegBinaryOverride: "/opt/ffmpeg/bin/ffmpeg" });
    expect(pipelineCacheKey(overridden)).not.toBe(pipelineCacheKey(unset));
    expect(pipelineCacheKey(pipelineIdentity({ FFMPEG_BIN: "/usr/bin/ffmpeg" }))).not.toBe(
      pipelineCacheKey(overridden),
    );
  });

  it("hashes the identity as sorted-key JSON, so field order cannot move it", () => {
    const reordered = {
      ffmpegStatic: PIPELINE_IDENTITY.ffmpegStatic,
      encodeArgs: PIPELINE_IDENTITY.encodeArgs,
      loudness: {
        measurement: { ...PIPELINE_IDENTITY.loudness.measurement },
        silenceFloorLufs: PIPELINE_IDENTITY.loudness.silenceFloorLufs,
        gainStepDb: PIPELINE_IDENTITY.loudness.gainStepDb,
        maxGainDb: PIPELINE_IDENTITY.loudness.maxGainDb,
        targetLufs: PIPELINE_IDENTITY.loudness.targetLufs,
      },
      filter: PIPELINE_IDENTITY.filter,
    };

    expect(pipelineIdentityHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(pipelineIdentityHash(reordered)).toBe(pipelineIdentityHash());
  });

  it("changes the cache key with the ffmpeg-static version, as with the filter and the encode args", () => {
    const current = pipelineCacheKey();

    expect(current).toBe(pipelineIdentityHash().slice(0, 8));
    expect(pipelineCacheKey({ ...PIPELINE_IDENTITY, ffmpegStatic: "0.0.0-other" })).not.toBe(current);
    expect(pipelineCacheKey({ ...PIPELINE_IDENTITY, filter: `${PIPELINE_IDENTITY.filter},volume=0dB` })).not.toBe(
      current,
    );
    expect(pipelineCacheKey({ ...PIPELINE_IDENTITY, encodeArgs: [...PIPELINE_IDENTITY.encodeArgs, "-q"] })).not.toBe(
      current,
    );
  });

  // #1657: the normalization is a pipeline input like the filter, so a new
  // target (or clamp, step, floor or measurement method) re-encodes every
  // cached clip once and marks every committed pack stale.
  it("changes the cache key and the pipeline digest with any part of the loudness normalization", () => {
    const current = pipelineIdentityHash();
    const loudness = PIPELINE_IDENTITY.loudness;
    const variants = [
      { ...loudness, targetLufs: loudness.targetLufs - 1 },
      { ...loudness, maxGainDb: loudness.maxGainDb + 1 },
      { ...loudness, gainStepDb: 0.5 },
      { ...loudness, silenceFloorLufs: loudness.silenceFloorLufs - 10 },
      { ...loudness, measurement: { ...loudness.measurement, loops: loudness.measurement.loops + 1 } },
      { ...loudness, measurement: { ...loudness.measurement, filter: "ebur128" } },
    ];

    for (const variant of variants) {
      const identity = { ...PIPELINE_IDENTITY, loudness: variant };

      expect(pipelineIdentityHash(identity)).not.toBe(current);
      expect(pipelineCacheKey(identity)).not.toBe(pipelineCacheKey());
    }
  });

  it("is the key processVoiceTree runs under", async () => {
    const root = tempDir("ird-pipeline-key-");
    const srcDir = path.join(root, "src");

    mkdirSync(path.join(srcDir, "flags"), { recursive: true });
    copyFileSync(SAMPLE_CLIP, path.join(srcDir, "flags", "blue-01.mp3"));

    const result = await processVoiceTree({
      srcDir,
      destDir: path.join(root, "dest"),
      cacheDir: path.join(root, "cache"),
    });

    expect(result.pipelineHash).toBe(pipelineCacheKey());
  }, 30_000);
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
    const spawned: { kind: string; input: string }[] = [];

    spawnHook.onSpawn = (args) => {
      const kind = spawnKind(args);

      if (kind === "other") return;

      spawned.push({ kind, input: spawnInput(args) });

      // The swap: happens once the FIRST ffmpeg run — the loudness
      // measurement (#1657) — has already been launched, so both runs (the
      // measurement and the encode after it) see a replaced source if either
      // were pointed at it.
      if (spawned.length === 1) copyFileSync(OTHER_SAMPLE_CLIP, clip);
    };

    const result = await processVoiceTree({ srcDir, destDir, cacheDir });

    expect(result.processed).toBe(1);
    expect(spawned.map(({ kind }) => kind)).toEqual(["measure", "encode"]);
    // Both runs read ONE snapshot: the gain baked in is the gain of the bytes
    // that were encoded, and those are the bytes the sidecar names.
    expect(spawned[1]!.input).toBe(spawned[0]!.input);
    // The bug this replaces handed ffmpeg `sourcePath` itself, so a swap
    // landing here would change what got encoded. Assert the fix never does.
    expect(spawned[0]!.input).not.toBe(clip);

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
      await processVoiceTree({
        srcDir: refSrcDir,
        destDir: path.join(root, "dest"),
        cacheDir: path.join(root, "cache"),
      });

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

  /**
   * The publish-order fix (#1143 review): the old sidecar must not be removed
   * until ffmpeg has actually SUCCEEDED. Proved by observing the sidecar the
   * instant ffmpeg is launched — strictly before it can have finished — which
   * is the earliest a process could be killed and still find something on
   * disk. If invalidation ran up front (the shape the old bug's fix must not
   * reintroduce), the sidecar would already be gone at that moment.
   */
  it("does not remove the old sidecar before ffmpeg has produced a new output (#1143)", async () => {
    const { srcDir, destDir, cacheDir, clip } = oneClipTree("ird-cache-invalidate-order-");

    await processVoiceTree({ srcDir, destDir, cacheDir });

    const cachedClip = path.join(cacheDir, "flags/blue-01.mp3");
    const sidecarPath = `${cachedClip}.src.sha256`;
    const originalSidecar = readFileSync(sidecarPath, "utf-8");

    // A source swap so the second run is a cache MISS and actually re-enters
    // processClipIntoCache (a fresh cache hit would never spawn ffmpeg at all).
    copyFileSync(OTHER_SAMPLE_CLIP, clip);

    const sidecarAtSpawn: Record<string, string | false> = {};

    // Observed at both launches (#1657): the measurement, and the encode — the
    // later of the two, so the last moment before ffmpeg can have produced
    // anything to publish.
    spawnHook.onSpawn = (args) => {
      const kind = spawnKind(args);

      if (kind === "other") return;

      sidecarAtSpawn[kind] = existsSync(sidecarPath) ? readFileSync(sidecarPath, "utf-8") : false;
    };

    await processVoiceTree({ srcDir, destDir, cacheDir });

    expect(sidecarAtSpawn).toEqual({ measure: originalSidecar, encode: originalSidecar });
  }, 60_000);

  /**
   * The other half of the publish-order fix: a run that FAILS after the
   * snapshot was taken must leave the previously-published pair — cached
   * audio and its sidecar — exactly as they were. Corrupting the throwaway
   * ffmpeg-input snapshot (never `sourcePath`, never `cachedPath`) the moment
   * ffmpeg is launched is a deterministic way to fail the encode without
   * touching anything the fix is supposed to protect.
   */
  it("leaves the old cached file and sidecar untouched when a later run's ffmpeg fails (#1143)", async () => {
    const { srcDir, destDir, cacheDir, clip } = oneClipTree("ird-cache-ffmpeg-failure-");

    await processVoiceTree({ srcDir, destDir, cacheDir });

    const cachedClip = path.join(cacheDir, "flags/blue-01.mp3");
    const sidecarPath = `${cachedClip}.src.sha256`;
    const originalCached = readFileSync(cachedClip);
    const originalSidecar = readFileSync(sidecarPath, "utf-8");

    // A source swap so the second run is a cache MISS.
    copyFileSync(OTHER_SAMPLE_CLIP, clip);

    const kinds: string[] = [];

    spawnHook.onSpawn = (args) => {
      const kind = spawnKind(args);

      kinds.push(kind);

      // Corrupt the snapshot the ENCODE is about to decode — after the
      // measurement (#1657) has read it — so the encode itself fails.
      if (kind === "encode") writeFileSync(spawnInput(args), "not an mp3");
    };

    await expect(processVoiceTree({ srcDir, destDir, cacheDir })).rejects.toThrow(/^ffmpeg exit /);
    expect(kinds).toEqual(["measure", "encode"]);

    // Nothing published: the old audio and its sidecar are exactly what they
    // were, still paired, and no temp file survives the failure.
    expect(readFileSync(cachedClip).equals(originalCached)).toBe(true);
    expect(readFileSync(sidecarPath, "utf-8")).toBe(originalSidecar);
    expect(listFiles(cacheDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 60_000);

  /**
   * The same guarantee one run earlier (#1657): a loudness measurement that
   * fails is the clip failing, never a guessed gain. The encode is not even
   * started, and the published pair stays exactly as it was.
   */
  it("fails the clip, encoding nothing, when the loudness measurement fails (#1657)", async () => {
    const { srcDir, destDir, cacheDir, clip } = oneClipTree("ird-cache-measure-failure-");

    await processVoiceTree({ srcDir, destDir, cacheDir });

    const cachedClip = path.join(cacheDir, "flags/blue-01.mp3");
    const sidecarPath = `${cachedClip}.src.sha256`;
    const originalCached = readFileSync(cachedClip);
    const originalSidecar = readFileSync(sidecarPath, "utf-8");

    copyFileSync(OTHER_SAMPLE_CLIP, clip);

    const kinds: string[] = [];

    spawnHook.onSpawn = (args) => {
      const kind = spawnKind(args);

      kinds.push(kind);

      if (kind === "measure") writeFileSync(spawnInput(args), "not an mp3");
    };

    await expect(processVoiceTree({ srcDir, destDir, cacheDir })).rejects.toThrow(/^ffmpeg loudness measurement exit /);
    expect(kinds).toEqual(["measure"]);
    expect(readFileSync(cachedClip).equals(originalCached)).toBe(true);
    expect(readFileSync(sidecarPath, "utf-8")).toBe(originalSidecar);
    expect(listFiles(cacheDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 60_000);
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

/**
 * The static gain each voice clip gets ahead of the radio filter (#1657),
 * tested without ffmpeg: the boundaries are the function's, not the meter's.
 */
describe("loudnessGain — the gain that moves a clip to the target (#1657)", () => {
  const N = VOICE_LOUDNESS_NORMALIZATION;

  it("is the target minus the reading, rounded to the 0.1 dB step without float noise", () => {
    expect(loudnessGain(-22)).toEqual({ gainDb: 0, warning: null });
    // -22 - -28.7 is 6.699999999999999 in floating point.
    expect(loudnessGain(-28.7)).toEqual({ gainDb: 6.7, warning: null });
    expect(formatGainDb(loudnessGain(-28.7).gainDb)).toBe("6.7");
    expect(loudnessGain(-17.3)).toEqual({ gainDb: -4.7, warning: null });
    expect(formatGainDb(-4.7)).toBe("-4.7");
    expect(loudnessGain(-28.74).gainDb).toBe(6.7);
    expect(loudnessGain(-28.76).gainDb).toBe(6.8);
  });

  it("never produces a negative zero, in the number or in the filter string", () => {
    // -21.96 needs -0.04 dB: rounds to the zero step from below.
    const nearZero = loudnessGain(-21.96).gainDb;

    expect(Object.is(nearZero, 0)).toBe(true);
    expect(formatGainDb(nearZero)).toBe("0.0");
    expect(formatGainDb(-0)).toBe("0.0");
    expect(formatGainDb(-0.04)).toBe("0.0");
  });

  it("rounds a half step away from zero, the same both ways", () => {
    const halfSteps = { ...N, gainStepDb: 0.5 };

    expect(loudnessGain(-22.25, halfSteps).gainDb).toBe(0.5);
    expect(loudnessGain(-21.75, halfSteps).gainDb).toBe(-0.5);
    expect(formatGainDb(0.5, halfSteps)).toBe("0.5");
    expect(formatGainDb(7, { ...N, gainStepDb: 1 })).toBe("7");
    expect(formatGainDb(6.25, { ...N, gainStepDb: 0.25 })).toBe("6.25");
  });

  it("passes exactly the clamp either way, without a warning", () => {
    expect(loudnessGain(-34)).toEqual({ gainDb: 12, warning: null });
    expect(loudnessGain(-10)).toEqual({ gainDb: -12, warning: null });
    // 12.04 dB rounds to 12.0, which is the clamp, not past it.
    expect(loudnessGain(-34.04)).toEqual({ gainDb: 12, warning: null });
  });

  it("clamps a gain that rounds past the clamp, and says so with the reading", () => {
    const boost = loudnessGain(-34.1);

    expect(boost.gainDb).toBe(12);
    expect(boost.warning).toBe(
      "measured -34.1 LUFS, which needs +12.1 dB to reach -22 LUFS — clamped to +12.0 dB; fix the clip",
    );

    const cut = loudnessGain(-9.9);

    expect(cut.gainDb).toBe(-12);
    expect(cut.warning).toBe(
      "measured -9.9 LUFS, which needs -12.1 dB to reach -22 LUFS — clamped to -12.0 dB; fix the clip",
    );
  });

  it("takes a reading below the silence floor, or -inf, as silence: 0 dB and a warning", () => {
    for (const reading of [-50.1, -70, Number.NEGATIVE_INFINITY]) {
      const { gainDb, warning } = loudnessGain(reading);

      expect(Object.is(gainDb, 0)).toBe(true);
      expect(warning).toMatch(/below the -50 LUFS silence floor — taken as silence and left at 0 dB; fix the clip$/);
    }

    expect(loudnessGain(-70).warning).toMatch(/^measured -70\.0 LUFS, /);
    expect(loudnessGain(Number.NEGATIVE_INFINITY).warning).toMatch(/^measured -inf LUFS, /);
    // The floor itself is a reading, not silence — and one the clamp then catches.
    expect(loudnessGain(-50)).toMatchObject({ gainDb: 12, warning: expect.stringContaining("clamped") });
  });

  it("refuses something that is not a reading", () => {
    expect(() => loudnessGain(Number.NaN)).toThrow(/not a loudness reading/);
    expect(() => loudnessGain(Number.POSITIVE_INFINITY)).toThrow(/not a loudness reading/);
  });
});

describe("parseIntegratedLoudness — reading the ebur128 summary (#1657)", () => {
  // ffmpeg 6's summary, as `measureLoudness` receives it on stderr.
  const summary = (value: string): string =>
    "size=N/A time=00:00:02.76 bitrate=N/A speed= 175x    \r\n" +
    "[Parsed_ebur128_0 @ 000001bac78e2f00] Summary:\r\n\r\n" +
    "  Integrated loudness:\r\n" +
    `    I:         ${value} LUFS\r\n` +
    "    Threshold: -38.6 LUFS\r\n\r\n" +
    "  Loudness range:\r\n" +
    "    LRA:         0.0 LU\r\n";

  it("reads the integrated value, and -inf as -Infinity", () => {
    expect(parseIntegratedLoudness(summary("-28.7"))).toBe(-28.7);
    expect(parseIntegratedLoudness(summary("-70.0"))).toBe(-70);
    expect(parseIntegratedLoudness(summary("-inf"))).toBe(Number.NEGATIVE_INFINITY);
  });

  it("reads the last summary when there is more than one", () => {
    expect(parseIntegratedLoudness(summary("-30.0") + summary("-21.2"))).toBe(-21.2);
  });

  it("throws, quoting the output, when there is no summary — never a guess", () => {
    expect(() => parseIntegratedLoudness("Error opening input file\n")).toThrow(
      /no ebur128 integrated loudness in ffmpeg's output:\nError opening input file/,
    );
    expect(() => parseIntegratedLoudness(summary("nan"))).toThrow(/no ebur128 integrated loudness/);
  });
});

/**
 * The normalization end to end (#1657), on clips this test synthesizes with
 * ffmpeg's `lavfi` sources — a 1 kHz tone (inside the radio filter's band) at a
 * chosen level, or digital silence — so no fixture is committed and the levels
 * are exactly what each test needs. A 1 kHz `sine` at its default amplitude
 * measures about -21.5 LUFS; `volume` moves it from there. Each test measures
 * its sources first, so a level that drifted would fail loudly rather than
 * leave the test proving nothing.
 */
describe("loudness normalization — on synthesized clips (#1657)", () => {
  const FFMPEG = createRequire(import.meta.url)("ffmpeg-static") as string;
  const SINE_LUFS = -21.5;

  /** Encode a 1 kHz tone at about `lufs` (or silence) for `seconds` to `file`. */
  function synthesize(file: string, { seconds, lufs }: { seconds: number; lufs: number | "silence" }): string {
    mkdirSync(path.dirname(file), { recursive: true });

    const source =
      lufs === "silence"
        ? ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono"]
        : ["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100", "-af", `volume=${lufs - SINE_LUFS}dB`];

    execFileSync(FFMPEG, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...source,
      "-t",
      String(seconds),
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      file,
    ]);

    return file;
  }

  /** A voice tree `voice/alpha/` under a fresh temp root, so clips are named `alpha/<group>/<clip>`. */
  function alphaTree(prefix: string): { srcDir: string; destDir: string; cacheDir: string } {
    const root = tempDir(prefix);

    return {
      srcDir: path.join(root, "voice", "alpha"),
      destDir: path.join(root, "dest"),
      cacheDir: path.join(root, "cache"),
    };
  }

  /** Records the `-af` chain each clip's ENCODE was given, by clip file name. */
  function recordEncodeFilters(): Map<string, string> {
    const filters = new Map<string, string>();

    spawnHook.onSpawn = (args) => {
      if (spawnKind(args) !== "encode") return;

      // The snapshot is `<cachedPath>.<pid>.<n>.src.tmp`.
      const clip = path.basename(spawnInput(args)).replace(/\.\d+\.\d+\.src\.tmp$/, "");

      filters.set(clip, args[args.indexOf("-af") + 1]!);
    };

    return filters;
  }

  const chainFor = (gainDb: number): string => `volume=${formatGainDb(gainDb)}dB,${RADIO_ENGINEER_FILTER}`;

  it("brings two clips 18 LU apart to within 0.5 LU of each other", async () => {
    const { srcDir, destDir, cacheDir } = alphaTree("ird-loudness-pair-");
    const quiet = synthesize(path.join(srcDir, "flags", "quiet.mp3"), { seconds: 1.5, lufs: -32 });
    const loud = synthesize(path.join(srcDir, "flags", "loud.mp3"), { seconds: 1.5, lufs: -14 });

    // The positive control: the sources really are 18 LU apart.
    const quietIn = await measureLoudness(FFMPEG, quiet);
    const loudIn = await measureLoudness(FFMPEG, loud);

    expect(Math.abs(quietIn - -32)).toBeLessThanOrEqual(1);
    expect(Math.abs(loudIn - -14)).toBeLessThanOrEqual(1);

    const filters = recordEncodeFilters();
    const warnings: string[] = [];
    const result = await processVoiceTree({ srcDir, destDir, cacheDir, warn: (m) => warnings.push(m) });

    expect(result.processed).toBe(2);
    expect(warnings).toEqual([]);
    // Each encode got the gain its own source asked for, ahead of the filter.
    expect(filters.get("quiet.mp3")).toBe(chainFor(loudnessGain(quietIn).gainDb));
    expect(filters.get("loud.mp3")).toBe(chainFor(loudnessGain(loudIn).gainDb));

    // Measured on the processed mp3s, with the pipeline's own measurement.
    const quietOut = await measureLoudness(FFMPEG, path.join(destDir, "flags", "quiet.mp3"));
    const loudOut = await measureLoudness(FFMPEG, path.join(destDir, "flags", "loud.mp3"));

    expect(Math.abs(quietOut - loudOut)).toBeLessThanOrEqual(0.5);
  }, 60_000);

  /**
   * A clip shorter than one 400 ms gating block. The spec asks for it to come
   * out "within 1 LU of the target"; the processed clip is not AT the target,
   * because the radio filter after the gain (8 dB pre-gain, soft clip, limiter)
   * moves every clip's level the same way. So what this proves is the part that
   * matters: (1) the loop makes the short clip measurable at all — read once it
   * is silence to the meter, read looped it is its true level; (2) its gain is
   * exactly the target minus that reading; and (3) processed, it lands within
   * 1 LU of a long clip of the same tone recorded 12 LU louder, i.e. its gain
   * was as right as a long clip's. (Without the gain the two come out about 12
   * LU apart, so the last check cannot pass by the clips merely matching.)
   */
  it("measures a burst shorter than one gating block by looping it, and normalizes it like a long clip", async () => {
    const { srcDir, destDir, cacheDir } = alphaTree("ird-loudness-short-");
    const short = synthesize(path.join(srcDir, "flags", "short.mp3"), { seconds: 0.25, lufs: -28 });
    const long = synthesize(path.join(srcDir, "flags", "long.mp3"), { seconds: 1.5, lufs: -16 });

    const unlooped = await measureLoudness(FFMPEG, short, {
      ...VOICE_LOUDNESS_NORMALIZATION,
      measurement: { ...VOICE_LOUDNESS_NORMALIZATION.measurement, loops: 1 },
    });
    const shortIn = await measureLoudness(FFMPEG, short);
    const longIn = await measureLoudness(FFMPEG, long);

    expect(unlooped).toBeLessThan(VOICE_LOUDNESS_NORMALIZATION.silenceFloorLufs);
    expect(Number.isFinite(shortIn)).toBe(true);
    // Read looped, the burst is at the level it was synthesized at.
    expect(Math.abs(shortIn - -28)).toBeLessThanOrEqual(1);
    expect(longIn - shortIn).toBeGreaterThan(10);

    const filters = recordEncodeFilters();
    const warnings: string[] = [];

    await processVoiceTree({ srcDir, destDir, cacheDir, warn: (m) => warnings.push(m) });

    expect(warnings).toEqual([]);
    expect(filters.get("short.mp3")).toBe(chainFor(loudnessGain(shortIn).gainDb));
    expect(filters.get("long.mp3")).toBe(chainFor(loudnessGain(longIn).gainDb));

    const shortOut = await measureLoudness(FFMPEG, path.join(destDir, "flags", "short.mp3"));
    const longOut = await measureLoudness(FFMPEG, path.join(destDir, "flags", "long.mp3"));

    expect(Math.abs(shortOut - longOut)).toBeLessThanOrEqual(1);
  }, 60_000);

  it("leaves digital silence at 0 dB and warns, naming the clip and its reading", async () => {
    const { srcDir, destDir, cacheDir } = alphaTree("ird-loudness-silence-");

    synthesize(path.join(srcDir, "flags", "silence.mp3"), { seconds: 1, lufs: "silence" });

    const filters = recordEncodeFilters();
    const warnings: string[] = [];

    await processVoiceTree({ srcDir, destDir, cacheDir, warn: (m) => warnings.push(m) });

    expect(filters.get("silence.mp3")).toBe(chainFor(0));
    expect(warnings).toEqual([
      "Voice clip alpha/flags/silence.mp3: measured -70.0 LUFS, below the -50 LUFS silence floor — taken as " +
        "silence and left at 0 dB; fix the clip",
    ]);
  }, 60_000);

  it("gives a clip that needs more than 12 dB exactly 12 dB, and warns", async () => {
    const { srcDir, destDir, cacheDir } = alphaTree("ird-loudness-clamp-");
    const faint = synthesize(path.join(srcDir, "flags", "faint.mp3"), { seconds: 1.5, lufs: -40 });
    const faintIn = await measureLoudness(FFMPEG, faint);

    // The control: this clip really is past the clamp, and above the floor.
    expect(VOICE_LOUDNESS_NORMALIZATION.targetLufs - faintIn).toBeGreaterThan(VOICE_LOUDNESS_NORMALIZATION.maxGainDb);
    expect(faintIn).toBeGreaterThan(VOICE_LOUDNESS_NORMALIZATION.silenceFloorLufs);

    const filters = recordEncodeFilters();
    const warnings: string[] = [];

    await processVoiceTree({ srcDir, destDir, cacheDir, warn: (m) => warnings.push(m) });

    expect(filters.get("faint.mp3")).toBe(chainFor(12));
    expect(filters.get("faint.mp3")).toMatch(/^volume=12\.0dB,/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      new RegExp(
        `^Voice clip alpha/flags/faint\\.mp3: measured ${faintIn.toFixed(1)} LUFS, .* clamped to \\+12\\.0 dB`,
      ),
    );
  }, 60_000);

  /**
   * The copy step names a clip the same way, and a caller that gave no `warn`
   * still sees the warning, through its logger. A warning comes from a re-encode
   * only: the second run is a cache hit and repeats nothing.
   */
  it("reports through the logger without a warn, names the clip by voice, and stays quiet on a cache hit", async () => {
    const root = tempDir("ird-loudness-copy-");
    const srcRoot = path.join(root, "package");
    const destRoot = path.join(root, "assets", "audio");
    const cacheDir = path.join(root, "cache");

    synthesize(path.join(srcRoot, "voice", "alpha", "flags", "silence.mp3"), { seconds: 1, lufs: "silence" });

    const log: string[] = [];

    await processAndCopyAudioAssets({ destRoot, srcRoot, cacheDir, voices: "all", logger: (m) => log.push(m) });

    expect(log.filter((line) => line.includes("Voice clip"))).toEqual([
      expect.stringMatching(/^WARNING: Voice clip alpha\/flags\/silence\.mp3: measured -70\.0 LUFS, /),
    ]);

    const warnings: string[] = [];
    const secondLog: string[] = [];

    await processAndCopyAudioAssets({
      destRoot,
      srcRoot,
      cacheDir,
      voices: "all",
      logger: (m) => secondLog.push(m),
      warn: (m) => warnings.push(m),
    });

    expect(secondLog.some((line) => line.includes("0 processed, 1 cache-hit"))).toBe(true);
    expect(warnings).toEqual([]);
  }, 60_000);
});
