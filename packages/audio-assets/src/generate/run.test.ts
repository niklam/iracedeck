import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEntryLookup, entryHash, type VoiceConfig, VoiceConfigSchema } from "./config.ts";
import type { SynthesizeOptions, SynthesizeResult } from "./elevenlabs.ts";
import type { Manifest } from "./manifest.ts";
import { formatRunSummary, runGeneration, type RunLog, type RunOptions, scopeFlagsFor } from "./run.ts";

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
  fs.rmSync(root, { recursive: true, force: true });
});

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
  const persistManifest = vi.fn<(manifest: Manifest) => void>();
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

  return { promise, log, synthesize: synthesize as ReturnType<typeof fakeSynthesize>, persistManifest };
}

const emptyManifest = (): Manifest => ({ version: 1, entries: {} });

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
    expect(result.totals).toEqual({ generated: 2, skipped: 0, failed: 0, refused: 0 });
    expect(readClip("voice/default/intro/x.mp3")).toBe("take 1 of Last lap was.");
    expect(manifest.entries["voice/default/tail/x.mp3"]).toEqual({
      hash: hashOf(voice, "tail/x"),
      voiceId: "eleven-voice-id",
      model: "eleven_v4",
      textPreview: "point four",
      generatedAt: NOW.toISOString(),
      requestId: "req-2",
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
    expect(result.totals).toEqual({ generated: 1, skipped: 1, failed: 0, refused: 0 });
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
    expect(result.totals).toEqual({ generated: 0, skipped: 0, failed: 0, refused: 1 });
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

    expect((await promise).totals).toEqual({ generated: 0, skipped: 0, failed: 0, refused: 1 });
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

    expect((await promise).totals).toEqual({ generated: 2, skipped: 0, failed: 0, refused: 0 });
    expect(synthesize.mock.calls[1]![0].previous_request_ids).toEqual(["req-1"]);
  });

  it("counts an in-scope stale dependency as would-be-cut in a dry run, so its dependent is not refused", async () => {
    const manifest = emptyManifest();

    seed(manifest, "voice/default/intro/x.mp3", "flash-era-hash", "req-flash");

    const { promise, synthesize } = run({ voiceConfigs: new Map([["default", voice]]), manifest, dryRun: true });

    expect((await promise).totals).toEqual({ generated: 2, skipped: 0, failed: 0, refused: 0 });
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
    expect(result.totals).toEqual({ generated: 0, skipped: 0, failed: 3, refused: 0 });
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
    expect(result.totals).toEqual({ generated: 0, skipped: 0, failed: 1, refused: 1 });
    expect(log.lines.join("\n")).toContain('FAILED: dependency "intro/x" was refused in this run');
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
    const counts = { generated: 1, skipped: 2, failed: 0, refused: 3 };
    const lines = formatRunSummary(
      {
        totals: counts,
        perVoice: new Map([
          ["default", counts],
          ["shawn", { generated: 0, skipped: 0, failed: 0, refused: 0 }],
        ]),
      },
      true,
    );

    expect(lines[0]).toBe(
      "Done. 1 would be generated, 2 skipped (cache hit), 0 failed, 3 refused (pause marks or a stale dependency)",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^ {2}default: 1 would be generated/);
  });
});
