import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEntryLookup, entryHash, type VoiceConfig, VoiceConfigSchema } from "./config.ts";
import type { SynthesizeOptions, SynthesizeResult } from "./elevenlabs.ts";
import type { Manifest } from "./manifest.ts";
import {
  formatRunSummary,
  MANIFEST_SAVE_RETRY,
  ManifestSaver,
  runGeneration,
  type RunLog,
  type RunOptions,
  scopeFlagsFor,
} from "./run.ts";

/**
 * The real `node:fs`, with a seam on the two calls that put a clip down: a
 * hook that returns true for a destination makes the call write a partial
 * file there and then fail as a full disk does.
 */
const fsHook = vi.hoisted(() => ({ failsAt: null as ((destination: string) => boolean) | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const failPartWay = (destination: unknown): void => {
    if (typeof destination === "string" && fsHook.failsAt?.(destination)) {
      actual.writeFileSync(destination, "partial");
      throw Object.assign(new Error(`ENOSPC: no space left on device, write '${destination}'`), { code: "ENOSPC" });
    }
  };
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    failPartWay(file);
    actual.writeFileSync(file, data, options);
  };
  const copyFileSync: typeof actual.copyFileSync = (source, destination, mode) => {
    failPartWay(destination);
    actual.copyFileSync(source, destination, mode);
  };

  return { ...actual, default: { ...actual, writeFileSync, copyFileSync }, writeFileSync, copyFileSync };
});

const NOW = new Date("2026-11-11T12:00:00.000Z");
const UNSCOPED = { voices: null, groups: null, entries: null };

function buildVoice(
  groups: Record<string, Array<Record<string, unknown>>>,
  overrides: Record<string, unknown> = {},
): VoiceConfig {
  return VoiceConfigSchema.parse({
    id: "eleven-voice-id",
    label: "Test",
    model_id: "eleven_v4",
    voice_settings: { stability: 1, similarity_boost: 1 },
    groups,
    ...overrides,
  });
}

function hashOf(voice: VoiceConfig, key: string): string {
  return entryHash(buildEntryLookup(voice).get(key)!.entry, voice);
}

type SynthesizeArgs = Omit<SynthesizeOptions, "apiKey">;

/** A fake ElevenLabs: every call is a fresh take with a fresh request id, as on eleven_v4. */
function fakeSynthesize(failOn: (options: SynthesizeArgs) => boolean = () => false) {
  let n = 0;

  return vi.fn<(options: SynthesizeArgs) => Promise<SynthesizeResult>>(async (options) => {
    if (failOn(options)) throw new Error(`ElevenLabs 500: ${options.text}`);

    n++;

    return { mp3: Buffer.from(`take ${n} of ${options.text}`), requestId: `req-${n}` };
  });
}

function captureLog(): RunLog & { lines: string[] } {
  const lines: string[] = [];

  return {
    lines,
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "generate-run-"));
});

afterEach(() => {
  fsHook.failsAt = null;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every file under `root`, as POSIX paths relative to it. */
function filesUnderRoot(): string[] {
  return (fs.readdirSync(root, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

function writeClip(relPath: string, bytes: string): void {
  const abs = path.join(root, relPath);

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

function readClip(relPath: string): string {
  return fs.readFileSync(path.join(root, relPath), "utf-8");
}

/** A manifest row plus its clip, as an earlier run would have left them. */
function seed(manifest: Manifest, relPath: string, hash: string, requestId: string, bytes = `old ${relPath}`): void {
  writeClip(relPath, bytes);
  manifest.entries[relPath] = {
    hash,
    voiceId: "eleven-voice-id",
    model: "eleven_flash_v2_5",
    textPreview: relPath,
    generatedAt: "2026-01-01T00:00:00.000Z",
    requestId,
  };
}

function run(overrides: Partial<RunOptions> & Pick<RunOptions, "voiceConfigs" | "manifest">) {
  const log = captureLog();
  const synthesize = overrides.synthesize ?? fakeSynthesize();
  const persistManifest = overrides.persistManifest ?? vi.fn<(manifest: Manifest) => void>();
  const promise = runGeneration({
    scope: UNSCOPED,
    dryRun: false,
    root,
    persistManifest,
    now: () => NOW,
    log,
    ...overrides,
    synthesize,
  });

  return {
    promise,
    log,
    synthesize: synthesize as ReturnType<typeof fakeSynthesize>,
    persistManifest: persistManifest as ReturnType<typeof vi.fn<(manifest: Manifest) => void>>,
  };
}

const emptyManifest = (): Manifest => ({ version: 1, entries: {} });

describe("runGeneration — driver-name aliases (#1580)", () => {
  it("refuses an alias spelling in a name group before any call, dry run alike", async () => {
    const voice = buildVoice({
      names: [
        { name: "geoff", text: "Geoff" },
        { name: "jeff", text: "Jeff" },
      ],
    });

    for (const dryRun of [false, true]) {
      const manifest = emptyManifest();
      const { promise, log, synthesize } = run({ voiceConfigs: new Map([["default", voice]]), manifest, dryRun });
      const result = await promise;

      expect(result.totals.refused).toBe(1);
      expect(synthesize.mock.calls.map(([options]) => options.text)).toEqual(dryRun ? [] : ["Jeff"]);
      expect(log.lines.some((line) => line.includes("voice/default/names/geoff.mp3") && line.includes("REFUSED"))).toBe(
        true,
      );
      expect(manifest.entries["voice/default/names/geoff.mp3"]).toBeUndefined();
    }
  });
});

describe("runGeneration — order", () => {
  it("cuts a dependency listed after its dependent first, and the dependent gets its new request id", async () => {
    const voice = buildVoice({
      tail: [{ name: "x", text: "point four", previous_request_ids: ["intro/x"] }],
      intro: [{ name: "x", text: "Last lap was." }],
    });
    const manifest = emptyManifest();
    // The manifest still holds the dependency's previous take; the run must
    // condition the dependent on the NEW one, never this.
    seed(manifest, "voice/default/intro/x.mp3", "old-hash", "req-flash-take");

    const { promise, synthesize } = run({ voiceConfigs: new Map([["default", voice]]), manifest });
    const result = await promise;

    expect(synthesize.mock.calls.map(([options]) => options.text)).toEqual(["Last lap was.", "point four"]);
    expect(synthesize.mock.calls[1]![0].previous_request_ids).toEqual(["req-1"]);
    expect(result.totals).toEqual({ generated: 2, copied: 0, skipped: 0, failed: 0, refused: 0 });
    expect(readClip("voice/default/intro/x.mp3")).toBe("take 1 of Last lap was.");
    expect(manifest.entries["voice/default/tail/x.mp3"]).toEqual({
      hash: hashOf(voice, "tail/x"),
      voiceId: "eleven-voice-id",
      model: "eleven_v4",
      textPreview: "point four",
      generatedAt: NOW.toISOString(),
      requestId: "req-2",
      conditionedOn: { previous: ["req-1"] },
    });
  });

  it("runs default before the other voices whatever the configs map's order", async () => {
    const voice = buildVoice({ g: [{ name: "x", text: "hello" }] });
    const other = buildVoice({ g: [{ name: "x", text: "hi" }] });
    const manifest = emptyManifest();

    const { promise, synthesize } = run({
      voiceConfigs: new Map([
        ["zeta", other],
        ["alpha", other],
        ["default", voice],
      ]),
      manifest,
    });
    const result = await promise;

    expect([...result.perVoice.keys()]).toEqual(["default", "alpha", "zeta"]);
    expect(synthesize.mock.calls[0]![0].text).toBe("hello");
    // zeta's identical request finds alpha's take, cut earlier in the run.
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(result.perVoice.get("zeta")!.copied).toBe(1);
  });

  it("persists the manifest after every clip it writes and drops the processed copies", async () => {
    const voice = buildVoice({ g: [{ name: "x", text: "hello" }] });
    const processed = path.join(root, ".cache", "filter-abc", "voice", "default", "g", "x.mp3");

    fs.mkdirSync(path.dirname(processed), { recursive: true });
    fs.writeFileSync(processed, "stale processed");

    const { promise, persistManifest } = run({
      voiceConfigs: new Map([["default", voice]]),
      manifest: emptyManifest(),
    });

    await promise;

    expect(persistManifest).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(processed)).toBe(false);
  });
});

describe("runGeneration — a failed manifest save (#1643)", () => {
  const chain = {
    intro: [{ name: "x", text: "Last lap was." }],
    tail: [{ name: "x", text: "point four", previous_request_ids: ["intro/x"] }],
  };
  // What Windows gave on the real run, while something held the file briefly.
  const locked = () => new Error("UNKNOWN: unknown error, open 'generate.manifest.json'");

  /** A persistManifest that throws on the calls `failOn` picks (1-based), and the sleeps between attempts. */
  function flakySave(failOn: (call: number) => boolean) {
    let call = 0;
    const persistManifest = vi.fn<(manifest: Manifest) => void>(() => {
      call++;

      if (failOn(call)) throw locked();
    });
    const sleeps: number[] = [];

    return {
      persistManifest,
      retry: { attempts: 3, delayMs: 40, sleep: (ms: number) => void sleeps.push(ms) },
      sleeps,
    };
  }

  it("retries a save that throws once, and the clip and its dependents are cut", async () => {
    const manifest = emptyManifest();
    const { persistManifest, retry, sleeps } = flakySave((call) => call === 1);
    const { promise, synthesize, log } = run({
      voiceConfigs: new Map([["default", buildVoice(chain)]]),
      manifest,
      persistManifest,
      manifestSaveRetry: retry,
    });
    const result = await promise;

    expect(result.totals).toEqual({ generated: 2, copied: 0, skipped: 0, failed: 0, refused: 0 });
    expect(result.unsavedRows).toEqual([]);
    expect(synthesize.mock.calls[1]![0].previous_request_ids).toEqual(["req-1"]);
    // intro: a failed attempt and the retry; tail: one save.
    expect(persistManifest).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([40]);
    expect(log.lines.some((line) => line.includes("FAILED") || line.includes("manifest save failed"))).toBe(false);
  });

  it("keeps a clip cut when every save fails, cuts its dependents and copies, and reports the unsaved rows", async () => {
    const manifest = emptyManifest();
    const { persistManifest, retry } = flakySave(() => true);
    const { promise, synthesize, log } = run({
      voiceConfigs: new Map([
        ["default", buildVoice(chain)],
        ["shawn", buildVoice(chain)],
      ]),
      manifest,
      persistManifest,
      manifestSaveRetry: retry,
    });
    const result = await promise;
    const clips = [
      "voice/default/intro/x.mp3",
      "voice/default/tail/x.mp3",
      "voice/shawn/intro/x.mp3",
      "voice/shawn/tail/x.mp3",
    ];

    expect(result.perVoice.get("default")).toEqual({ generated: 2, copied: 0, skipped: 0, failed: 0, refused: 0 });
    expect(result.perVoice.get("shawn")).toEqual({ generated: 0, copied: 2, skipped: 0, failed: 0, refused: 0 });
    // The dependent was conditioned on the take the row holds in memory.
    expect(synthesize.mock.calls[1]![0].previous_request_ids).toEqual(["req-1"]);
    expect(Object.keys(manifest.entries).sort()).toEqual(clips);

    for (const clip of clips) expect(fs.existsSync(path.join(root, clip))).toBe(true);

    // Four clips' saves and the final one, three attempts each.
    expect(persistManifest).toHaveBeenCalledTimes(15);
    expect(result.unsavedRows).toEqual(clips);
    expect(log.lines.filter((line) => line.includes("manifest save failed after 3 attempt(s)"))).toHaveLength(4);
    expect(log.lines.at(-1)).toBe(
      "[generate] FAILED to save the manifest: UNKNOWN: unknown error, open 'generate.manifest.json'. " +
        `These clips are on disk without their rows, and the next run would cut them again: ${clips.join(", ")}`,
    );
  });

  it("saves the held rows on the final attempt when the file is free again", async () => {
    const manifest = emptyManifest();
    // The clip's own three attempts fail; the final save's second lands.
    const { persistManifest, retry } = flakySave((call) => call <= 4);
    const { promise, log } = run({
      voiceConfigs: new Map([["default", buildVoice({ g: [{ name: "x", text: "hello" }] })]]),
      manifest,
      persistManifest,
      manifestSaveRetry: retry,
    });
    const result = await promise;

    expect(result.totals.generated).toBe(1);
    expect(result.unsavedRows).toEqual([]);
    expect(persistManifest).toHaveBeenCalledTimes(5);
    expect(persistManifest.mock.calls.at(-1)![0].entries["voice/default/g/x.mp3"]!.requestId).toBe("req-1");
    expect(log.lines.at(-1)).toBe(
      "[generate] manifest saved on the final attempt, with the rows of voice/default/g/x.mp3",
    );
  });

  it("waits between attempts with the default synchronous sleep", () => {
    let calls = 0;
    const saver = new ManifestSaver(
      emptyManifest(),
      () => {
        if (++calls === 1) throw locked();
      },
      captureLog(),
      "generate",
      { attempts: 3, delayMs: 30 },
    );
    const started = performance.now();

    saver.save("voice/default/g/x.mp3");

    expect(calls).toBe(2);
    // Timer granularity on Windows: allow a few ms under the nominal delay.
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    expect(saver.flush()).toEqual([]);
    expect(MANIFEST_SAVE_RETRY).toEqual({ attempts: 3, delayMs: 250 });
  });

  it("makes no final save when every save landed, and none in a dry run", async () => {
    for (const dryRun of [false, true]) {
      const { promise, persistManifest } = run({
        voiceConfigs: new Map([["default", buildVoice(chain)]]),
        manifest: emptyManifest(),
        dryRun,
      });
      const result = await promise;

      expect(result.unsavedRows).toEqual([]);
      expect(persistManifest).toHaveBeenCalledTimes(dryRun ? 0 : 2);
    }
  });
});

describe("runGeneration — cache", () => {
  it("skips an entry whose row matches its hash and whose clip exists, even when its dependency is stale", async () => {
    const voice = buildVoice({
      intro: [{ name: "x", text: "Last lap was.", seed: 2 }],
      tail: [{ name: "x", text: "point four", previous_request_ids: ["intro/x"] }],
    });
    const manifest = emptyManifest();

    seed(manifest, "voice/default/intro/x.mp3", "superseded", "req-old-intro");
    seed(manifest, "voice/default/tail/x.mp3", hashOf(voice, "tail/x"), "req-tail");

    const { promise, synthesize } = run({ voiceConfigs: new Map([["default", voice]]), manifest });
    const result = await promise;

    // The intro's seed bump re-cuts the intro alone: the approved tail take stays.
    expect(synthesize.mock.calls.map(([options]) => options.text)).toEqual(["Last lap was."]);
    expect(result.totals).toEqual({ generated: 1, copied: 0, skipped: 1, failed: 0, refused: 0 });
    expect(readClip("voice/default/tail/x.mp3")).toBe("old voice/default/tail/x.mp3");
  });

  it("re-cuts an entry whose row matches but whose clip is missing", async () => {
    const voice = buildVoice({ g: [{ name: "x", text: "hello" }] });
    const manifest = emptyManifest();

    manifest.entries["voice/default/g/x.mp3"] = {
      hash: hashOf(voice, "g/x"),
      voiceId: "eleven-voice-id",
      model: "eleven_v4",
      textPreview: "hello",
      generatedAt: "2026-01-01T00:00:00.000Z",
      requestId: "req-old",
    };

    const { promise } = run({ voiceConfigs: new Map([["default", voice]]), manifest });

    expect((await promise).totals.generated).toBe(1);
  });
});

describe("runGeneration — stale dependencies", () => {
  const voice = buildVoice({
    intro: [{ name: "x", text: "Last lap was." }],
    tail: [{ name: "x", text: "point four", previous_request_ids: ["intro/x"] }],
  });

  it("refuses an entry whose out-of-scope dependency is stale, naming it and the scope that cuts it", async () => {
    const manifest = emptyManifest();

    seed(manifest, "voice/default/intro/x.mp3", "flash-era-hash", "req-flash");

    const { promise, synthesize, log } = run({
      voiceConfigs: new Map([["default", voice]]),
      manifest,
      scope: { voices: null, groups: ["tail"], entries: null },
    });
    const result = await promise;

    expect(synthesize).not.toHaveBeenCalled();
    expect(result.totals).toEqual({ generated: 0, copied: 0, skipped: 0, failed: 0, refused: 1 });
    expect(manifest.entries["voice/default/tail/x.mp3"]).toBeUndefined();
    expect(log.lines.join("\n")).toContain(
      'voice/default/tail/x.mp3  —  REFUSED: dependency "intro/x" is out of date (its manifest row was cut from a different config) and is not cut in this run; cut it first with --voice default --group intro --entry x',
    );
  });

  it("refuses the same in a dry run", async () => {
    const manifest = emptyManifest();

    seed(manifest, "voice/default/intro/x.mp3", "flash-era-hash", "req-flash");

    const { promise, log } = run({
      voiceConfigs: new Map([["default", voice]]),
      manifest,
      scope: { voices: null, groups: ["tail"], entries: null },
      dryRun: true,
    });

    expect((await promise).totals).toEqual({ generated: 0, copied: 0, skipped: 0, failed: 0, refused: 1 });
    expect(log.lines.join("\n")).toContain('REFUSED: dependency "intro/x" is out of date');
  });

  it("refuses when the dependency has no row, or its clip is missing", async () => {
    const noRow = run({
      voiceConfigs: new Map([["default", voice]]),
      manifest: emptyManifest(),
      scope: { voices: null, groups: ["tail"], entries: null },
    });

    expect((await noRow.promise).totals.refused).toBe(1);
    expect(noRow.log.lines.join("\n")).toContain("(it has no manifest row)");

    const manifest = emptyManifest();

    seed(manifest, "voice/default/intro/x.mp3", hashOf(voice, "intro/x"), "req-intro");
    fs.rmSync(path.join(root, "voice/default/intro/x.mp3"));

    const missing = run({
      voiceConfigs: new Map([["default", voice]]),
      manifest,
      scope: { voices: null, groups: ["tail"], entries: null },
    });

    expect((await missing.promise).totals.refused).toBe(1);
    expect(missing.log.lines.join("\n")).toContain("(its clip is missing)");
  });

  it("cuts against a current out-of-scope dependency", async () => {
    const manifest = emptyManifest();

    seed(manifest, "voice/default/intro/x.mp3", hashOf(voice, "intro/x"), "req-current-intro");

    const { promise, synthesize } = run({
      voiceConfigs: new Map([["default", voice]]),
      manifest,
      scope: { voices: null, groups: ["tail"], entries: null },
    });

    expect((await promise).totals.generated).toBe(1);
    expect(synthesize.mock.calls[0]![0].previous_request_ids).toEqual(["req-current-intro"]);
  });

  it("lets the dependent through when the stale dependency is in scope and cut first", async () => {
    const manifest = emptyManifest();

    seed(manifest, "voice/default/intro/x.mp3", "flash-era-hash", "req-flash");

    const { promise, synthesize } = run({
      voiceConfigs: new Map([["default", voice]]),
      manifest,
      scope: { voices: null, groups: null, entries: ["x"] },
    });

    expect((await promise).totals).toEqual({ generated: 2, copied: 0, skipped: 0, failed: 0, refused: 0 });
    expect(synthesize.mock.calls[1]![0].previous_request_ids).toEqual(["req-1"]);
  });

  it("counts an in-scope stale dependency as would-be-cut in a dry run, so its dependent is not refused", async () => {
    const manifest = emptyManifest();

    seed(manifest, "voice/default/intro/x.mp3", "flash-era-hash", "req-flash");

    const { promise, synthesize } = run({ voiceConfigs: new Map([["default", voice]]), manifest, dryRun: true });

    expect((await promise).totals).toEqual({ generated: 2, copied: 0, skipped: 0, failed: 0, refused: 0 });
    expect(synthesize).not.toHaveBeenCalled();
    expect(manifest.entries["voice/default/intro/x.mp3"]!.hash).toBe("flash-era-hash");
    expect(fs.existsSync(path.join(root, "voice/default/tail/x.mp3"))).toBe(false);
  });

  it("fails every dependent of a dependency that failed in this run, never using its old request id", async () => {
    const chain = buildVoice({
      intro: [{ name: "x", text: "Last lap was." }],
      tail: [{ name: "x", text: "point four", previous_request_ids: ["intro/x"] }],
      tip: [{ name: "x", text: "and change", previous_request_ids: ["tail/x"] }],
    });
    const manifest = emptyManifest();

    seed(manifest, "voice/default/intro/x.mp3", "flash-era-hash", "req-flash");

    const { promise, synthesize, log } = run({
      voiceConfigs: new Map([["default", chain]]),
      manifest,
      synthesize: fakeSynthesize((options) => options.text === "Last lap was."),
    });
    const result = await promise;

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(result.totals).toEqual({ generated: 0, copied: 0, skipped: 0, failed: 3, refused: 0 });
    expect(log.lines.join("\n")).toContain(
      'voice/default/tail/x.mp3  —  FAILED: dependency "intro/x" failed in this run',
    );
    expect(log.lines.join("\n")).toContain(
      'voice/default/tip/x.mp3  —  FAILED: dependency "tail/x" failed in this run',
    );
  });

  it("fails the dependent of a dependency refused in this run", async () => {
    const marked = buildVoice({
      intro: [{ name: "x", text: "Last lap: was" }],
      tail: [{ name: "x", text: "point four", previous_request_ids: ["intro/x"] }],
    });

    const { promise, synthesize, log } = run({
      voiceConfigs: new Map([["default", marked]]),
      manifest: emptyManifest(),
    });
    const result = await promise;

    expect(synthesize).not.toHaveBeenCalled();
    expect(result.totals).toEqual({ generated: 0, copied: 0, skipped: 0, failed: 1, refused: 1 });
    expect(log.lines.join("\n")).toContain('FAILED: dependency "intro/x" was refused in this run');
  });
});

describe("runGeneration — copies between voices", () => {
  const groups = {
    intro: [{ name: "x", text: "Last lap was." }],
    tail: [{ name: "x", text: "point four", previous_request_ids: ["intro/x"] }],
  };

  it("copies an identical entry under a second voice instead of requesting it", async () => {
    const manifest = emptyManifest();
    const shawn = buildVoice(groups, { label: "Short callouts" });

    const { promise, synthesize, persistManifest } = run({
      voiceConfigs: new Map([
        ["shawn", shawn],
        ["default", buildVoice(groups)],
      ]),
      manifest,
    });
    const result = await promise;

    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(result.perVoice.get("default")).toEqual({ generated: 2, copied: 0, skipped: 0, failed: 0, refused: 0 });
    expect(result.perVoice.get("shawn")).toEqual({ generated: 0, copied: 2, skipped: 0, failed: 0, refused: 0 });
    expect(persistManifest).toHaveBeenCalledTimes(4);

    for (const key of ["intro/x", "tail/x"]) {
      const source = manifest.entries[`voice/default/${key}.mp3`]!;

      expect(readClip(`voice/shawn/${key}.mp3`)).toBe(readClip(`voice/default/${key}.mp3`));
      expect(manifest.entries[`voice/shawn/${key}.mp3`]).toEqual({
        hash: hashOf(shawn, key),
        voiceId: "eleven-voice-id",
        model: source.model,
        textPreview: source.textPreview,
        generatedAt: NOW.toISOString(),
        requestId: source.requestId,
        conditionedOn: source.conditionedOn,
      });
    }
  });

  it("copies byte for byte from a take already on disk, under another group and name", async () => {
    const manifest = emptyManifest();
    const shawn = buildVoice({ g: [{ name: "y", text: "Box this lap" }] });
    const defaultVoice = buildVoice({ pit: [{ name: "box", text: "Box this lap" }] });
    const bytes = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x0a, 0x0d, 0x1a]);

    fs.mkdirSync(path.join(root, "voice/default/pit"), { recursive: true });
    fs.writeFileSync(path.join(root, "voice/default/pit/box.mp3"), bytes);
    manifest.entries["voice/default/pit/box.mp3"] = {
      hash: hashOf(defaultVoice, "pit/box"),
      voiceId: "eleven-voice-id",
      model: "eleven_v4",
      textPreview: "Box this lap",
      generatedAt: "2026-11-01T00:00:00.000Z",
      requestId: "req-paid-once",
    };

    const processed = path.join(root, ".cache", "filter-abc", "voice", "shawn", "g", "y.mp3");

    fs.mkdirSync(path.dirname(processed), { recursive: true });
    fs.writeFileSync(processed, "stale processed");

    const { promise, synthesize, log } = run({
      voiceConfigs: new Map([
        ["default", defaultVoice],
        ["shawn", shawn],
      ]),
      manifest,
      scope: { voices: ["shawn"], groups: null, entries: null },
    });
    const result = await promise;

    expect(synthesize).not.toHaveBeenCalled();
    expect(result.totals.copied).toBe(1);
    expect(fs.readFileSync(path.join(root, "voice/shawn/g/y.mp3")).equals(bytes)).toBe(true);
    expect(manifest.entries["voice/shawn/g/y.mp3"]!.requestId).toBe("req-paid-once");
    expect(fs.existsSync(processed)).toBe(false);
    expect(log.lines).toContain("[copy] voice/shawn/g/y.mp3 from voice/default/pit/box.mp3");
  });

  it("reports WOULD COPY in a dry run, against a take the same dry run would cut, and writes nothing", async () => {
    const manifest = emptyManifest();

    const { promise, synthesize, log } = run({
      voiceConfigs: new Map([
        ["default", buildVoice(groups)],
        ["shawn", buildVoice(groups)],
      ]),
      manifest,
      dryRun: true,
    });
    const result = await promise;

    expect(synthesize).not.toHaveBeenCalled();
    expect(result.totals).toEqual({ generated: 2, copied: 2, skipped: 0, failed: 0, refused: 0 });
    expect(log.lines).toContain("[dry-run] WOULD COPY voice/shawn/intro/x.mp3 from voice/default/intro/x.mp3");
    expect(log.lines).toContain("[dry-run] WOULD COPY voice/shawn/tail/x.mp3 from voice/default/tail/x.mp3");
    expect(manifest.entries).toEqual({});
    expect(fs.existsSync(path.join(root, "voice"))).toBe(false);
  });

  it("requests rather than copies when the other voice's clip is missing, or its row is stale", async () => {
    const defaultVoice = buildVoice({ g: [{ name: "x", text: "hello" }] });
    const shawn = buildVoice({ g: [{ name: "x", text: "hello" }] });
    const manifest = emptyManifest();

    manifest.entries["voice/default/g/x.mp3"] = {
      hash: hashOf(defaultVoice, "g/x"),
      voiceId: "eleven-voice-id",
      model: "eleven_v4",
      textPreview: "hello",
      generatedAt: "2026-11-01T00:00:00.000Z",
      requestId: "req-gone",
    };

    const missing = run({
      voiceConfigs: new Map([
        ["default", defaultVoice],
        ["shawn", shawn],
      ]),
      manifest,
      scope: { voices: ["shawn"], groups: null, entries: null },
      dryRun: true,
    });

    expect((await missing.promise).totals).toEqual({ generated: 1, copied: 0, skipped: 0, failed: 0, refused: 0 });

    const stale = emptyManifest();

    seed(stale, "voice/default/g/x.mp3", "flash-era-hash", "req-flash");

    const staleRun = run({
      voiceConfigs: new Map([
        ["default", defaultVoice],
        ["shawn", shawn],
      ]),
      manifest: stale,
      scope: { voices: ["shawn"], groups: null, entries: null },
      dryRun: true,
    });

    expect((await staleRun.promise).totals).toEqual({ generated: 1, copied: 0, skipped: 0, failed: 0, refused: 0 });
  });

  it("never copies across a different ElevenLabs voice id, model or text", async () => {
    const base = { g: [{ name: "x", text: "hello" }] };

    for (const other of [
      buildVoice(base, { id: "another-eleven-voice" }),
      buildVoice(base, { model_id: "eleven_flash_v2_5" }),
      buildVoice({ g: [{ name: "x", text: "hello there" }] }),
    ]) {
      const { promise, synthesize } = run({
        voiceConfigs: new Map([
          ["default", buildVoice(base)],
          ["shawn", other],
        ]),
        manifest: emptyManifest(),
      });

      expect((await promise).totals.copied).toBe(0);
      expect(synthesize).toHaveBeenCalledTimes(2);
    }
  });

  it("copies each pool variant from its own counterpart, never one take into two clips", async () => {
    const pool = {
      flags: [
        { name: "blue-01", text: "Blue flag" },
        { name: "blue-02", text: "Blue flag" },
      ],
    };
    const manifest = emptyManifest();

    const { promise, synthesize } = run({
      voiceConfigs: new Map([
        ["default", buildVoice(pool)],
        ["shawn", buildVoice(pool)],
      ]),
      manifest,
    });
    const result = await promise;

    // Default's two variants share a hash but are two requests: two takes.
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(result.perVoice.get("shawn")!.copied).toBe(2);
    expect(readClip("voice/shawn/flags/blue-01.mp3")).toBe(readClip("voice/default/flags/blue-01.mp3"));
    expect(readClip("voice/shawn/flags/blue-02.mp3")).toBe(readClip("voice/default/flags/blue-02.mp3"));
    expect(readClip("voice/shawn/flags/blue-01.mp3")).not.toBe(readClip("voice/shawn/flags/blue-02.mp3"));
  });

  it("requests a variant whose only same-hash take another of its clips already holds", async () => {
    const manifest = emptyManifest();
    const defaultVoice = buildVoice({ flags: [{ name: "blue", text: "Blue flag" }] });
    const shawn = buildVoice({
      flags: [
        { name: "blue-01", text: "Blue flag" },
        { name: "blue-02", text: "Blue flag" },
      ],
    });

    const { promise, synthesize } = run({
      voiceConfigs: new Map([
        ["default", defaultVoice],
        ["shawn", shawn],
      ]),
      manifest,
    });
    const result = await promise;

    expect(result.perVoice.get("shawn")).toEqual({ generated: 1, copied: 1, skipped: 0, failed: 0, refused: 0 });
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(manifest.entries["voice/shawn/flags/blue-01.mp3"]!.requestId).not.toBe(
      manifest.entries["voice/shawn/flags/blue-02.mp3"]!.requestId,
    );
  });

  it("still refuses a copy whose dependency in its own voice is stale and out of scope", async () => {
    const manifest = emptyManifest();
    const defaultVoice = buildVoice(groups);
    const shawn = buildVoice(groups);

    seed(manifest, "voice/default/intro/x.mp3", hashOf(defaultVoice, "intro/x"), "req-intro");
    seed(manifest, "voice/default/tail/x.mp3", hashOf(defaultVoice, "tail/x"), "req-tail");
    seed(manifest, "voice/shawn/intro/x.mp3", "flash-era-hash", "req-flash");

    const { promise, synthesize } = run({
      voiceConfigs: new Map([
        ["default", defaultVoice],
        ["shawn", shawn],
      ]),
      manifest,
      scope: { voices: ["shawn"], groups: ["tail"], entries: null },
    });

    expect((await promise).totals).toEqual({ generated: 0, copied: 0, skipped: 0, failed: 0, refused: 1 });
    expect(synthesize).not.toHaveBeenCalled();
  });
});

describe("runGeneration — a clip is put down whole or not at all (#1643)", () => {
  // Any write of a clip, straight or through a temp file beside it.
  const clipWrite = (destination: string) => /\.mp3(\.\d+\.\d+\.tmp)?$/.test(destination);

  it("leaves no partial take at the clip's path, and no temp file, when the write fails part-way", async () => {
    const manifest = emptyManifest();

    fsHook.failsAt = clipWrite;

    const { promise, log, persistManifest } = run({
      voiceConfigs: new Map([["default", buildVoice({ g: [{ name: "x", text: "hello" }] })]]),
      manifest,
    });
    const result = await promise;

    expect(result.totals).toEqual({ generated: 0, copied: 0, skipped: 0, failed: 1, refused: 0 });
    expect(filesUnderRoot()).toEqual([]);
    expect(manifest.entries).toEqual({});
    expect(persistManifest).not.toHaveBeenCalled();
    expect(log.lines.join("\n")).toContain("voice/default/g/x.mp3  —  FAILED: ENOSPC");
  });

  it("keeps the previous clip untouched when a re-cut's write fails", async () => {
    const voice = buildVoice({ g: [{ name: "x", text: "hello" }] });
    const manifest = emptyManifest();

    seed(manifest, "voice/default/g/x.mp3", "old-hash", "req-old", "the old take");
    fsHook.failsAt = clipWrite;

    const result = await run({ voiceConfigs: new Map([["default", voice]]), manifest }).promise;

    expect(result.totals.failed).toBe(1);
    expect(filesUnderRoot()).toEqual(["voice/default/g/x.mp3"]);
    expect(readClip("voice/default/g/x.mp3")).toBe("the old take");
    // The row still names the old config, so the next run cuts it again.
    expect(manifest.entries["voice/default/g/x.mp3"]!.hash).toBe("old-hash");
  });

  it("leaves no partial copy at the clip's path, and no temp file, when a copy fails part-way", async () => {
    const hello = buildVoice({ g: [{ name: "x", text: "hello" }] });
    const manifest = emptyManifest();

    seed(manifest, "voice/default/g/x.mp3", hashOf(hello, "g/x"), "req-hello");
    fsHook.failsAt = clipWrite;

    const { promise, synthesize } = run({
      voiceConfigs: new Map([
        ["default", hello],
        ["shawn", hello],
      ]),
      manifest,
      scope: { voices: ["shawn"], groups: null, entries: null },
    });
    const result = await promise;

    expect(result.totals).toEqual({ generated: 0, copied: 0, skipped: 0, failed: 1, refused: 0 });
    expect(synthesize).not.toHaveBeenCalled();
    expect(filesUnderRoot()).toEqual(["voice/default/g/x.mp3"]);
    expect(manifest.entries["voice/shawn/g/x.mp3"]).toBeUndefined();
  });

  it("writes through a temp file and leaves only the clip behind", async () => {
    const written: string[] = [];

    fsHook.failsAt = (destination) => {
      written.push(path.relative(root, destination).split(path.sep).join("/"));

      return false;
    };

    await run({
      voiceConfigs: new Map([["default", buildVoice({ g: [{ name: "x", text: "hello" }] })]]),
      manifest: emptyManifest(),
    }).promise;

    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^voice\/default\/g\/x\.mp3\.\d+\.\d+\.tmp$/);
    expect(filesUnderRoot()).toEqual(["voice/default/g/x.mp3"]);
    expect(readClip("voice/default/g/x.mp3")).toBe("take 1 of hello");
  });
});

describe("runGeneration — a dependency with no request id (#1643)", () => {
  it("fails the entry and its dependents alike in a live run and a dry run", async () => {
    const chain = buildVoice({
      intro: [{ name: "x", text: "Last lap was." }],
      tail: [{ name: "x", text: "point four", previous_request_ids: ["intro/x"] }],
      tip: [{ name: "x", text: "and change", previous_request_ids: ["tail/x"] }],
    });
    const outcomes: Record<string, { totals: unknown; failures: string[] }> = {};

    for (const dryRun of [false, true]) {
      const manifest = emptyManifest();

      // Current, with its clip, but no request id to condition on.
      seed(manifest, "voice/default/intro/x.mp3", hashOf(chain, "intro/x"), "unused");
      manifest.entries["voice/default/intro/x.mp3"]!.requestId = null;

      const { promise, synthesize, log } = run({ voiceConfigs: new Map([["default", chain]]), manifest, dryRun });
      const result = await promise;

      expect(synthesize).not.toHaveBeenCalled();
      outcomes[dryRun ? "dry" : "live"] = {
        totals: result.totals,
        failures: log.lines.filter((line) => line.includes("FAILED")),
      };
    }

    expect(outcomes.live!.totals).toEqual({ generated: 0, copied: 0, skipped: 1, failed: 2, refused: 0 });
    expect(outcomes.dry).toEqual(outcomes.live);
    expect(outcomes.live!.failures).toEqual([
      expect.stringMatching(
        /^\[generate\] voice\/default\/tail\/x\.mp3 {2}— {2}FAILED: Reference "intro\/x" for voice "default" resolved to manifest entry "voice\/default\/intro\/x\.mp3" but it has no requestId/,
      ),
      '[generate] voice/default/tip/x.mp3  —  FAILED: dependency "tail/x" failed in this run',
    ]);
  });

  it("still plans a dependent of a would-be cut, through the planned id", async () => {
    const chain = buildVoice({
      intro: [{ name: "x", text: "Last lap was." }],
      tail: [{ name: "x", text: "point four", previous_request_ids: ["intro/x"] }],
    });
    const result = await run({ voiceConfigs: new Map([["default", chain]]), manifest: emptyManifest(), dryRun: true })
      .promise;

    expect(result.totals).toEqual({ generated: 2, copied: 0, skipped: 0, failed: 0, refused: 0 });
  });
});

describe("runGeneration — a copy source must be provably the same request (#1643)", () => {
  const hello = buildVoice({ g: [{ name: "x", text: "hello" }] });

  for (const dryRun of [false, true]) {
    const mode = dryRun ? "dry run" : "live";

    it(`never copies a row that is stale in its own voice: new bytes under an old hash (${mode})`, async () => {
      // shawn's g/x was re-cut from "goodbye" but its row never reached disk:
      // the row still carries the hash of "hello", the clip holds new words.
      const manifest = emptyManifest();

      seed(manifest, "voice/shawn/g/x.mp3", hashOf(hello, "g/x"), "req-goodbye", "take of goodbye");

      const { promise, synthesize } = run({
        voiceConfigs: new Map([
          ["default", hello],
          ["shawn", buildVoice({ g: [{ name: "x", text: "goodbye" }] })],
        ]),
        manifest,
        dryRun,
        scope: { voices: ["default"], groups: null, entries: null },
      });
      const result = await promise;

      expect(result.totals).toEqual({ generated: 1, copied: 0, skipped: 0, failed: 0, refused: 0 });
      expect(synthesize.mock.calls.map(([options]) => options.text)).toEqual(dryRun ? [] : ["hello"]);

      if (!dryRun) expect(readClip("voice/default/g/x.mp3")).toBe("take 1 of hello");
    });

    it(`never copies a row whose entry is gone from its voice's config (${mode})`, async () => {
      const manifest = emptyManifest();

      seed(manifest, "voice/shawn/g/x.mp3", hashOf(hello, "g/x"), "req-hello");

      const { promise } = run({
        voiceConfigs: new Map([
          ["default", hello],
          ["shawn", buildVoice({ g: [{ name: "y", text: "hello" }] })],
        ]),
        manifest,
        dryRun,
        scope: { voices: ["default"], groups: null, entries: null },
      });

      expect((await promise).totals).toEqual({ generated: 1, copied: 0, skipped: 0, failed: 0, refused: 0 });
    });

    it(`never copies a take with no request id (${mode})`, async () => {
      const manifest = emptyManifest();

      seed(manifest, "voice/shawn/g/x.mp3", hashOf(hello, "g/x"), "unused");
      manifest.entries["voice/shawn/g/x.mp3"]!.requestId = null;

      const { promise, log } = run({
        voiceConfigs: new Map([
          ["default", hello],
          ["shawn", hello],
        ]),
        manifest,
        dryRun,
        scope: { voices: ["default"], groups: null, entries: null },
      });

      expect((await promise).totals).toEqual({ generated: 1, copied: 0, skipped: 0, failed: 0, refused: 0 });
      expect(log.lines.some((line) => line.includes("COPY") || line.startsWith("[copy]"))).toBe(false);
    });
  }

  it("still copies the same row once it is current in its own voice", async () => {
    const manifest = emptyManifest();

    seed(manifest, "voice/shawn/g/x.mp3", hashOf(hello, "g/x"), "req-hello");

    const { promise, synthesize } = run({
      voiceConfigs: new Map([
        ["default", hello],
        ["shawn", hello],
      ]),
      manifest,
      scope: { voices: ["default"], groups: null, entries: null },
    });

    expect((await promise).totals).toEqual({ generated: 0, copied: 1, skipped: 0, failed: 0, refused: 0 });
    expect(synthesize).not.toHaveBeenCalled();
  });
});

describe("runGeneration — a copy needs the take's own conditioning (#1643)", () => {
  const groups = {
    d: [{ name: "x", text: "Last lap was." }],
    e: [{ name: "x", text: "point four", previous_request_ids: ["d/x"] }],
  };
  const voice = buildVoice(groups);

  /**
   * Default's E was cut conditioned on D's take r1; then a seed bump re-cut
   * D to r2 while E stayed cached (no cascade). Shawn's D is a copy of r2.
   */
  function reCutDependency(conditionedOn: Manifest["entries"][string]["conditionedOn"]): Manifest {
    const manifest = emptyManifest();

    seed(manifest, "voice/default/d/x.mp3", hashOf(voice, "d/x"), "r2");
    seed(manifest, "voice/default/e/x.mp3", hashOf(voice, "e/x"), "rE");
    seed(manifest, "voice/shawn/d/x.mp3", hashOf(voice, "d/x"), "r2");

    if (conditionedOn) manifest.entries["voice/default/e/x.mp3"]!.conditionedOn = conditionedOn;

    return manifest;
  }

  for (const dryRun of [false, true]) {
    const mode = dryRun ? "dry run" : "live";

    it(`cuts, not copies, a take conditioned on a dependency take since re-cut (${mode})`, async () => {
      const manifest = reCutDependency({ previous: ["r1"] });
      const { promise, synthesize } = run({
        voiceConfigs: new Map([
          ["default", voice],
          ["shawn", voice],
        ]),
        manifest,
        dryRun,
      });
      const result = await promise;

      expect(result.perVoice.get("shawn")).toEqual({ generated: 1, copied: 0, skipped: 1, failed: 0, refused: 0 });

      if (!dryRun) {
        expect(synthesize.mock.calls.map(([options]) => options.previous_request_ids)).toEqual([["r2"]]);
        expect(manifest.entries["voice/shawn/e/x.mp3"]!.conditionedOn).toEqual({ previous: ["r2"] });
      }
    });

    it(`cuts, not copies, a referenced legacy row with no conditionedOn, even when today's ids agree (${mode})`, async () => {
      // Default's D and shawn's D both hold r2 today, but nothing records
      // what Default's E was cut against: it may predate both.
      const manifest = reCutDependency(undefined);
      const { promise, synthesize } = run({
        voiceConfigs: new Map([
          ["default", voice],
          ["shawn", voice],
        ]),
        manifest,
        dryRun,
      });
      const result = await promise;

      expect(result.perVoice.get("shawn")).toEqual({ generated: 1, copied: 0, skipped: 1, failed: 0, refused: 0 });

      if (!dryRun) {
        expect(synthesize.mock.calls.map(([options]) => options.previous_request_ids)).toEqual([["r2"]]);
        expect(manifest.entries["voice/shawn/e/x.mp3"]!.conditionedOn).toEqual({ previous: ["r2"] });
      }
    });

    it(`still copies a legacy row with no conditionedOn into an entry that references nothing (${mode})`, async () => {
      // Shawn lacks D; Default's legacy D references nothing, so its request
      // is the whole of the proof.
      const manifest = reCutDependency(undefined);

      delete manifest.entries["voice/shawn/d/x.mp3"];
      fs.rmSync(path.join(root, "voice/shawn/d/x.mp3"));

      const { promise, synthesize } = run({
        voiceConfigs: new Map([
          ["default", voice],
          ["shawn", voice],
        ]),
        manifest,
        dryRun,
        scope: { voices: ["shawn"], groups: ["d"], entries: null },
      });
      const result = await promise;

      expect(result.totals).toEqual({ generated: 0, copied: 1, skipped: 0, failed: 0, refused: 0 });
      expect(synthesize).not.toHaveBeenCalled();

      if (!dryRun) {
        expect(manifest.entries["voice/shawn/d/x.mp3"]!.requestId).toBe("r2");
        expect(manifest.entries["voice/shawn/d/x.mp3"]).not.toHaveProperty("conditionedOn");
      }
    });
  }

  it("copies a take whose recorded conditioning is what this voice would send, and carries it", async () => {
    const manifest = reCutDependency({ previous: ["r2"] });
    const { promise, synthesize } = run({
      voiceConfigs: new Map([
        ["default", voice],
        ["shawn", voice],
      ]),
      manifest,
    });

    expect((await promise).perVoice.get("shawn")!.copied).toBe(1);
    expect(synthesize).not.toHaveBeenCalled();
    expect(manifest.entries["voice/shawn/e/x.mp3"]!.conditionedOn).toEqual({ previous: ["r2"] });
  });

  it("records no conditionedOn on a cut whose request sends no request ids", async () => {
    const manifest = emptyManifest();
    const { promise } = run({ voiceConfigs: new Map([["default", voice]]), manifest });

    await promise;

    expect(manifest.entries["voice/default/d/x.mp3"]).not.toHaveProperty("conditionedOn");
    expect(manifest.entries["voice/default/e/x.mp3"]!.conditionedOn).toEqual({ previous: ["req-1"] });
  });
});

describe("runGeneration — a copy needs the same resolved references", () => {
  const dependent = { name: "x", text: "point four", previous_request_ids: ["intro/x"] };

  for (const dryRun of [false, true]) {
    const mode = dryRun ? "dry run" : "live run";

    it(`cuts, not copies, a dependent whose dependency is a different take in each voice (${mode})`, async () => {
      const groups = { intro: [{ name: "x", text: "Last lap was." }], tail: [dependent] };
      const defaultVoice = buildVoice(groups);
      const shawn = buildVoice(groups);
      const manifest = emptyManifest();

      // Same config, same hash — but each voice's intro was cut separately.
      seed(manifest, "voice/default/intro/x.mp3", hashOf(defaultVoice, "intro/x"), "req-default-intro");
      seed(manifest, "voice/shawn/intro/x.mp3", hashOf(shawn, "intro/x"), "req-shawn-intro");

      const { promise, synthesize, log } = run({
        voiceConfigs: new Map([
          ["default", defaultVoice],
          ["shawn", shawn],
        ]),
        manifest,
        dryRun,
      });
      const result = await promise;

      expect(result.perVoice.get("shawn")).toEqual({ generated: 1, copied: 0, skipped: 1, failed: 0, refused: 0 });
      expect(log.lines.some((line) => line.includes("COPY"))).toBe(false);

      if (!dryRun) {
        expect(synthesize).toHaveBeenCalledTimes(2);
        expect(synthesize.mock.calls[1]![0].previous_request_ids).toEqual(["req-shawn-intro"]);
        expect(manifest.entries["voice/shawn/tail/x.mp3"]!.requestId).not.toBe(
          manifest.entries["voice/default/tail/x.mp3"]!.requestId,
        );
      }
    });

    it(`copies a dependent whose dependency is itself a copy, so both resolve to one id (${mode})`, async () => {
      const groups = { intro: [{ name: "x", text: "Last lap was." }], tail: [dependent] };
      const defaultVoice = buildVoice(groups);
      const shawn = buildVoice(groups);
      const manifest = emptyManifest();

      // The intro is cut fresh in Default and copied into Short callouts in this run.
      seed(manifest, "voice/default/intro/x.mp3", "flash-era-hash", "req-flash-default");
      seed(manifest, "voice/shawn/intro/x.mp3", "flash-era-hash", "req-flash-shawn");

      const { promise, synthesize, log } = run({
        voiceConfigs: new Map([
          ["default", defaultVoice],
          ["shawn", shawn],
        ]),
        manifest,
        dryRun,
      });
      const result = await promise;

      expect(result.perVoice.get("default")).toEqual({ generated: 2, copied: 0, skipped: 0, failed: 0, refused: 0 });
      expect(result.perVoice.get("shawn")).toEqual({ generated: 0, copied: 2, skipped: 0, failed: 0, refused: 0 });

      if (dryRun) {
        expect(log.lines).toContain("[dry-run] WOULD COPY voice/shawn/tail/x.mp3 from voice/default/tail/x.mp3");
      } else {
        expect(synthesize).toHaveBeenCalledTimes(2);
        expect(manifest.entries["voice/shawn/tail/x.mp3"]!.requestId).toBe(
          manifest.entries["voice/default/tail/x.mp3"]!.requestId,
        );
      }
    });

    it(`cuts a dependent whose dependency each voice cuts fresh in the same run (${mode})`, async () => {
      const defaultVoice = buildVoice({ intro: [{ name: "x", text: "Last lap was." }], tail: [dependent] });
      const shawn = buildVoice({ intro: [{ name: "x", text: "Lap." }], tail: [dependent] });
      const manifest = emptyManifest();

      expect(hashOf(shawn, "tail/x")).toBe(hashOf(defaultVoice, "tail/x"));

      const { promise, synthesize } = run({
        voiceConfigs: new Map([
          ["default", defaultVoice],
          ["shawn", shawn],
        ]),
        manifest,
        dryRun,
      });
      const result = await promise;

      expect(result.perVoice.get("shawn")).toEqual({ generated: 2, copied: 0, skipped: 0, failed: 0, refused: 0 });

      if (!dryRun) {
        expect(synthesize).toHaveBeenCalledTimes(4);
        // Short callouts' tail is conditioned on its own new intro, req-3.
        expect(synthesize.mock.calls[3]![0].previous_request_ids).toEqual(["req-3"]);
      }
    });
  }

  it("copies an entry with no references whatever its dependencies elsewhere", async () => {
    const groups = { g: [{ name: "x", text: "Box this lap" }] };
    const { promise } = run({
      voiceConfigs: new Map([
        ["default", buildVoice(groups)],
        ["shawn", buildVoice(groups)],
      ]),
      manifest: emptyManifest(),
      dryRun: true,
    });

    expect((await promise).perVoice.get("shawn")!.copied).toBe(1);
  });
});

describe("scopeFlagsFor", () => {
  it("names the voice, the group and the entry", () => {
    expect(scopeFlagsFor("shawn", "lap-time-intro/best-lap-yet")).toBe(
      "--voice shawn --group lap-time-intro --entry best-lap-yet",
    );
  });
});

describe("formatRunSummary", () => {
  it("prints the totals, and a line per voice when more than one ran", () => {
    const counts = { generated: 1, copied: 4, skipped: 2, failed: 0, refused: 3 };
    const lines = formatRunSummary(
      {
        totals: counts,
        perVoice: new Map([
          ["default", counts],
          ["shawn", { generated: 0, copied: 0, skipped: 0, failed: 0, refused: 0 }],
        ]),
        unsavedRows: [],
      },
      true,
    );

    expect(lines[0]).toBe(
      "Done. 1 would be generated, 4 would be copied, 2 skipped (cache hit), 0 failed, 3 refused (pause marks, driver-name aliases or a stale dependency)",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^ {2}default: 1 would be generated/);
  });

  it("names the clips whose manifest rows could not be saved", () => {
    const counts = { generated: 2, copied: 0, skipped: 0, failed: 0, refused: 0 };
    const lines = formatRunSummary(
      {
        totals: counts,
        perVoice: new Map([["default", counts]]),
        unsavedRows: ["voice/default/g/a.mp3", "voice/default/g/b.mp3"],
      },
      false,
    );

    expect(lines).toEqual([
      "Done. 2 generated, 0 copied, 0 skipped (cache hit), 0 failed, 0 refused (pause marks, driver-name aliases or a stale dependency)",
      "Manifest NOT saved: 2 clip(s) on disk have no row in generate.manifest.json, and the next run would cut them again: voice/default/g/a.mp3, voice/default/g/b.mp3",
    ]);
  });
});
