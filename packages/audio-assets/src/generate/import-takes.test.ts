import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEntryLookup, entryHash, type VoiceConfig, VoiceConfigSchema } from "./config.ts";
import { type ImportOptions, importTakes, parseImportArg } from "./import-takes.ts";
import type { Manifest } from "./manifest.ts";
import type { RunLog } from "./run.ts";

/**
 * The real `node:fs`, with a seam on `copyFileSync`: a hook that returns true
 * for a destination makes the copy write a partial file there and then fail
 * as a full disk does.
 */
const fsHook = vi.hoisted(() => ({ failsAt: null as ((destination: string) => boolean) | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const copyFileSync: typeof actual.copyFileSync = (source, destination, mode) => {
    if (typeof destination === "string" && fsHook.failsAt?.(destination)) {
      actual.writeFileSync(destination, "partial");
      throw Object.assign(new Error(`ENOSPC: no space left on device, copyfile '${destination}'`), { code: "ENOSPC" });
    }

    actual.copyFileSync(source, destination, mode);
  };

  return { ...actual, default: { ...actual, copyFileSync }, copyFileSync };
});

const NOW = new Date("2026-11-11T12:00:00.000Z");

function buildVoice(groups: Record<string, Array<Record<string, unknown>>>, overrides: Record<string, unknown> = {}) {
  return VoiceConfigSchema.parse({
    id: "eleven-voice-id",
    label: "Test",
    model_id: "eleven_v4",
    voice_settings: { stability: 1, similarity_boost: 1 },
    groups,
    ...overrides,
  });
}

const defaultVoice = buildVoice({
  "lap-time-intro": [{ name: "first-good-lap", text: "That lap was." }],
  "lap-time-decimal": [{ name: "5", text: "point five", previous_request_ids: ["lap-time-intro/first-good-lap"] }],
});
const shawnVoice = buildVoice({ "lap-time-intro": [{ name: "first-good-lap", text: "That lap was." }] });

function hashOf(voice: VoiceConfig, key: string): string {
  return entryHash(buildEntryLookup(voice).get(key)!.entry, voice);
}

let trialDir: string;
let root: string;

beforeEach(() => {
  trialDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-trial-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "import-root-"));
});

afterEach(() => {
  fsHook.failsAt = null;
  fs.rmSync(trialDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every file under `root`, as POSIX paths relative to it. */
function filesUnderRoot(): string[] {
  return (fs.readdirSync(root, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

/** A trial take on disk, under the trial's `voice/<voice>/<group>/<name>.mp3`. */
function writeTake(key: string, bytes: Buffer): void {
  const abs = path.join(trialDir, `${key}.mp3`);

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

/** The speaker and settings the test configs resolve to, as #1643's trials record them. */
const RECORDED = { voiceId: "eleven-voice-id", settings: { stability: 1, similarity_boost: 1 } };

/** `trial-manifest.json`; `top` defaults to `RECORDED`. */
function writeTrial(records: unknown[], model = "eleven_v4", top: Record<string, unknown> = RECORDED): void {
  fs.writeFileSync(path.join(trialDir, "trial-manifest.json"), JSON.stringify({ model, ...top, records }, null, 2));
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

function runImport(manifest: Manifest, overrides: Partial<ImportOptions> = {}) {
  const log = captureLog();
  const persistManifest = vi.fn<(manifest: Manifest) => void>();
  const result = importTakes({
    dir: trialDir,
    voiceConfigs: new Map([
      ["default", defaultVoice],
      ["shawn", shawnVoice],
    ]),
    manifest,
    root,
    dryRun: false,
    persistManifest,
    now: () => NOW,
    log,
    ...overrides,
  });

  return { result, log, persistManifest };
}

const INTRO = "voice/default/lap-time-intro/first-good-lap";
const DECIMAL = "voice/default/lap-time-decimal/5";
// Bytes no text round-trip would survive: CR, LF, NUL, a lone high byte.
const INTRO_BYTES = Buffer.from([0xff, 0xf3, 0x0d, 0x0a, 0x00, 0x80, 0x1a]);
const DECIMAL_BYTES = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0xfe]);

describe("importTakes", () => {
  it("copies each ok take byte for byte and writes a row with the current hash and the trial's request id", () => {
    writeTake(INTRO, INTRO_BYTES);
    writeTake(DECIMAL, DECIMAL_BYTES);
    writeTrial([
      { key: INTRO, text: "That lap was.", status: "ok", requestId: "req-intro", inTrialRefs: [] },
      { key: DECIMAL, status: "ok", requestId: "req-decimal", crossModelRefs: ["lap-time-intro/first-good-lap"] },
      { key: "voice/default/lap-time-decimal/6", status: "error", error: "ElevenLabs 500" },
    ]);

    const manifest: Manifest = {
      version: 1,
      entries: {
        [`${INTRO}.mp3`]: {
          hash: "flash-era-hash",
          voiceId: "eleven-voice-id",
          model: "eleven_flash_v2_5",
          textPreview: "That lap was",
          generatedAt: "2026-01-01T00:00:00.000Z",
          requestId: "req-flash",
        },
      },
    };
    const processed = path.join(root, ".cache", "filter-abc", `${INTRO}.mp3`);

    fs.mkdirSync(path.dirname(processed), { recursive: true });
    fs.writeFileSync(processed, "stale processed");

    const { result, log, persistManifest } = runImport(manifest);

    expect(result).toEqual({ imported: 2, skipped: 1, problems: [] });
    expect(fs.readFileSync(path.join(root, `${INTRO}.mp3`)).equals(INTRO_BYTES)).toBe(true);
    expect(fs.readFileSync(path.join(root, `${DECIMAL}.mp3`)).equals(DECIMAL_BYTES)).toBe(true);
    expect(manifest.entries[`${INTRO}.mp3`]).toEqual({
      hash: hashOf(defaultVoice, "lap-time-intro/first-good-lap"),
      voiceId: "eleven-voice-id",
      model: "eleven_v4",
      textPreview: "That lap was.",
      generatedAt: NOW.toISOString(),
      requestId: "req-intro",
    });
    expect(manifest.entries[`${DECIMAL}.mp3`]!.hash).toBe(hashOf(defaultVoice, "lap-time-decimal/5"));
    expect(manifest.entries[`${DECIMAL}.mp3`]!.requestId).toBe("req-decimal");
    // Once per take, as each lands: the first save already holds the first row.
    expect(persistManifest).toHaveBeenCalledTimes(2);
    expect(Object.keys(persistManifest.mock.calls[0]![0].entries)).toContain(`${INTRO}.mp3`);
    expect(fs.existsSync(processed)).toBe(false);
    expect(log.lines).toContain("[import] voice/default/lap-time-decimal/6 (status error)  —  skipped");
  });

  it("keeps the saved rows of the takes before a copy that fails midway, and stops there", () => {
    writeTake(INTRO, INTRO_BYTES);
    writeTake(DECIMAL, DECIMAL_BYTES);
    writeTrial([
      { key: INTRO, status: "ok", requestId: "req-intro" },
      { key: DECIMAL, status: "ok", requestId: "req-decimal" },
    ]);
    // A directory where the second take's file goes: its copy fails.
    fs.mkdirSync(path.join(root, `${DECIMAL}.mp3`), { recursive: true });

    const manifest: Manifest = { version: 1, entries: {} };
    const { result, log, persistManifest } = runImport(manifest);

    expect(result.imported).toBe(1);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(new RegExp(`^${DECIMAL}\\.mp3: copy failed: `));
    expect(Object.keys(manifest.entries)).toEqual([`${INTRO}.mp3`]);
    expect(persistManifest).toHaveBeenCalledTimes(1);
    expect(persistManifest.mock.calls[0]![0].entries[`${INTRO}.mp3`]!.requestId).toBe("req-intro");
    expect(log.lines.some((line) => line.startsWith(`[import] FAILED: ${DECIMAL}.mp3: copy failed: `))).toBe(true);
    // The temp file the failed rename left was removed.
    expect(filesUnderRoot()).toEqual([`${INTRO}.mp3`]);
  });

  it("leaves no partial take, and no temp file, when a copy fails part-way", () => {
    writeTake(INTRO, INTRO_BYTES);
    writeTake(DECIMAL, DECIMAL_BYTES);
    writeTrial([
      { key: INTRO, status: "ok", requestId: "req-intro" },
      { key: DECIMAL, status: "ok", requestId: "req-decimal" },
    ]);
    // Any copy of the second take into the voice tree, straight or through a temp file.
    fsHook.failsAt = (destination) => destination.startsWith(path.join(root, `${DECIMAL}.mp3`));

    const manifest: Manifest = { version: 1, entries: {} };
    const { result } = runImport(manifest);

    expect(result.imported).toBe(1);
    expect(result.problems[0]).toMatch(new RegExp(`^${DECIMAL}\\.mp3: copy failed: ENOSPC`));
    expect(filesUnderRoot()).toEqual([`${INTRO}.mp3`]);
    expect(Object.keys(manifest.entries)).toEqual([`${INTRO}.mp3`]);
  });

  it("reports takes whose rows no save could write, keeping them in memory", () => {
    writeTake(INTRO, INTRO_BYTES);
    writeTake(DECIMAL, DECIMAL_BYTES);
    writeTrial([
      { key: INTRO, status: "ok", requestId: "req-intro" },
      { key: DECIMAL, status: "ok", requestId: "req-decimal" },
    ]);

    const manifest: Manifest = { version: 1, entries: {} };
    const persistManifest = vi.fn<(manifest: Manifest) => void>(() => {
      throw new Error("UNKNOWN: unknown error, open 'generate.manifest.json'");
    });
    const { result, log } = runImport(manifest, {
      persistManifest,
      manifestSaveRetry: { attempts: 2, delayMs: 0, sleep: () => {} },
    });

    expect(result.imported).toBe(2);
    expect(result.problems).toEqual([
      `the manifest could not be saved; these takes are on disk without their rows: ${INTRO}.mp3, ${DECIMAL}.mp3`,
    ]);
    expect(Object.keys(manifest.entries)).toEqual([`${INTRO}.mp3`, `${DECIMAL}.mp3`]);
    // Two takes' saves and the final one, two attempts each.
    expect(persistManifest).toHaveBeenCalledTimes(6);
    expect(log.lines.filter((line) => line.includes("manifest save failed after 2 attempt(s)"))).toHaveLength(2);
  });

  it("reports and writes nothing in a dry run", () => {
    writeTake(INTRO, INTRO_BYTES);
    writeTrial([{ key: INTRO, status: "ok", requestId: "req-intro" }]);

    const manifest: Manifest = { version: 1, entries: {} };
    const { result, log, persistManifest } = runImport(manifest, { dryRun: true });

    expect(result).toEqual({ imported: 1, skipped: 0, problems: [] });
    expect(log.lines[0]).toMatch(/^\[dry-run\] WOULD IMPORT voice\/default\/lap-time-intro\/first-good-lap\.mp3 from /);
    expect(manifest.entries).toEqual({});
    expect(persistManifest).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "voice"))).toBe(false);
  });

  it("refuses the whole import, naming every problem, and writes nothing", () => {
    writeTake(INTRO, INTRO_BYTES);
    writeTake("voice/default/lap-time-intro/no-such-entry", INTRO_BYTES);
    writeTake("voice/titan/lap-time-intro/first-good-lap", INTRO_BYTES);
    writeTake("voice/default/no-such-group/x", INTRO_BYTES);
    writeTrial([
      { key: INTRO, status: "ok", requestId: "req-intro" },
      { key: "voice/default/lap-time-intro/no-such-entry", status: "ok", requestId: "a" },
      { key: "voice/titan/lap-time-intro/first-good-lap", status: "ok", requestId: "b" },
      { key: "voice/default/no-such-group/x", status: "ok", requestId: "c" },
      { key: DECIMAL, status: "ok", requestId: "req-decimal" },
    ]);

    const manifest: Manifest = { version: 1, entries: {} };
    const { result, log, persistManifest } = runImport(manifest);

    expect(result.imported).toBe(0);
    expect(result.problems).toEqual([
      "voice/default/lap-time-intro/no-such-entry: unknown entry (no entry in configs/)",
      'voice/titan/lap-time-intro/first-good-lap: unknown entry (no voice "titan" in configs/)',
      'voice/default/no-such-group/x: unknown entry (no group "no-such-group" in configs/)',
      `${DECIMAL}: ${path.join(trialDir, `${DECIMAL}.mp3`)} does not exist`,
    ]);
    expect(manifest.entries).toEqual({});
    expect(persistManifest).not.toHaveBeenCalled();
    // The valid record before the bad ones was not copied either.
    expect(fs.existsSync(path.join(root, "voice"))).toBe(false);
    expect(log.lines.filter((line) => line.startsWith("[import] REFUSED: "))).toHaveLength(4);
  });

  it("refuses a model the config does not resolve the entry to", () => {
    writeTake(INTRO, INTRO_BYTES);
    writeTrial([{ key: INTRO, status: "ok", requestId: "req-intro" }], "eleven_flash_v2_5");

    const manifest: Manifest = { version: 1, entries: {} };
    const { result } = runImport(manifest);

    expect(result.problems).toEqual([
      `${INTRO}: cut with model "eleven_flash_v2_5", but the config resolves it to "eleven_v4"`,
    ]);
    expect(manifest.entries).toEqual({});
    expect(fs.existsSync(path.join(root, "voice"))).toBe(false);
  });

  it("checks the model against a per-entry model_id override", () => {
    const overridden = buildVoice({
      "lap-time-intro": [{ name: "first-good-lap", text: "That lap was.", model_id: "eleven_multilingual_v2" }],
    });

    writeTake(INTRO, INTRO_BYTES);
    writeTrial([{ key: INTRO, status: "ok", requestId: "req-intro" }]);

    const { result } = runImport({ version: 1, entries: {} }, { voiceConfigs: new Map([["default", overridden]]) });

    expect(result.problems).toEqual([
      `${INTRO}: cut with model "eleven_v4", but the config resolves it to "eleven_multilingual_v2"`,
    ]);
  });

  it("refuses a take cut from text the config no longer says, a missing request id and a repeated key", () => {
    writeTake(INTRO, INTRO_BYTES);
    writeTake("voice/shawn/lap-time-intro/first-good-lap", INTRO_BYTES);
    writeTrial([
      { key: INTRO, text: "That lap was", status: "ok", requestId: "req-intro" },
      { key: "voice/shawn/lap-time-intro/first-good-lap", status: "ok", requestId: null },
      { key: INTRO, status: "ok", requestId: "req-again" },
    ]);

    const { result } = runImport({ version: 1, entries: {} });

    expect(result.problems).toEqual([
      `${INTRO}: cut from text "That lap was", but the config says "That lap was."`,
      "voice/shawn/lap-time-intro/first-good-lap: the record has no requestId",
      `${INTRO}: imported twice`,
    ]);
    expect(fs.existsSync(path.join(root, "voice"))).toBe(false);
  });

  describe("the speaker", () => {
    it("refuses a trial whose voiceId is not the voice config's id, naming both, and writes nothing", () => {
      writeTake(INTRO, INTRO_BYTES);
      writeTrial([{ key: INTRO, status: "ok", requestId: "req-intro" }], "eleven_v4", {
        voiceId: "TABZn6CDfjMNGrsnGzzD",
        settings: RECORDED.settings,
      });

      const manifest: Manifest = { version: 1, entries: {} };
      const { result, persistManifest } = runImport(manifest);

      expect(result.problems).toEqual([
        `${INTRO}: spoken by ElevenLabs voice "TABZn6CDfjMNGrsnGzzD" (the trial), but voice "default" has id "eleven-voice-id"`,
      ]);
      expect(manifest.entries).toEqual({});
      expect(persistManifest).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(root, "voice"))).toBe(false);
    });

    it("refuses a record whose own voiceId differs, even when the trial's matches", () => {
      writeTake(INTRO, INTRO_BYTES);
      writeTrial([{ key: INTRO, status: "ok", requestId: "req-intro", voiceId: "other-voice" }]);

      const { result } = runImport({ version: 1, entries: {} });

      expect(result.problems).toEqual([
        `${INTRO}: spoken by ElevenLabs voice "other-voice" (the record), but voice "default" has id "eleven-voice-id"`,
      ]);
      expect(fs.existsSync(path.join(root, "voice"))).toBe(false);
    });

    it("imports a matching speaker, at the top or on the record, without a warning", () => {
      writeTake(INTRO, INTRO_BYTES);
      writeTake(DECIMAL, DECIMAL_BYTES);
      writeTrial(
        [
          { key: INTRO, status: "ok", requestId: "req-intro" },
          { key: DECIMAL, status: "ok", requestId: "req-decimal", voiceId: "eleven-voice-id" },
        ],
        "eleven_v4",
        { voiceId: "eleven-voice-id" },
      );

      const { result, log } = runImport({ version: 1, entries: {} });

      expect(result).toEqual({ imported: 2, skipped: 0, problems: [] });
      expect(log.lines.some((line) => line.includes("voiceId"))).toBe(false);
    });

    it("imports a trial that records no speaker, warning once per voice", () => {
      writeTake(INTRO, INTRO_BYTES);
      writeTake(DECIMAL, DECIMAL_BYTES);
      writeTake("voice/shawn/lap-time-intro/first-good-lap", INTRO_BYTES);
      writeTrial(
        [
          { key: INTRO, status: "ok", requestId: "req-intro" },
          { key: DECIMAL, status: "ok", requestId: "req-decimal" },
          { key: "voice/shawn/lap-time-intro/first-good-lap", status: "ok", requestId: "req-shawn" },
        ],
        "eleven_v4",
        {},
      );

      const manifest: Manifest = { version: 1, entries: {} };
      const { result, log } = runImport(manifest);

      expect(result).toEqual({ imported: 3, skipped: 0, problems: [] });
      expect(Object.keys(manifest.entries)).toHaveLength(3);
      expect(log.lines.filter((line) => line.includes("records no voiceId"))).toEqual([
        '[import] voice "default": the trial records no voiceId for 2 take(s), so their speaker was not checked against "eleven-voice-id"',
        '[import] voice "shawn": the trial records no voiceId for 1 take(s), so their speaker was not checked against "eleven-voice-id"',
      ]);
    });
  });

  describe("the voice settings and the seed", () => {
    it("refuses settings that are not the entry's resolved voice_settings, naming both", () => {
      writeTake(INTRO, INTRO_BYTES);
      writeTrial([{ key: INTRO, status: "ok", requestId: "req-intro" }], "eleven_v4", {
        voiceId: "eleven-voice-id",
        settings: { stability: 1, similarity_boost: 1, clone_strength: 0 },
      });

      const manifest: Manifest = { version: 1, entries: {} };
      const { result, persistManifest } = runImport(manifest);

      expect(result.problems).toEqual([
        `${INTRO}: cut with settings {"clone_strength":0,"similarity_boost":1,"stability":1}, but the config resolves them to {"similarity_boost":1,"stability":1}`,
      ]);
      expect(manifest.entries).toEqual({});
      expect(persistManifest).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(root, "voice"))).toBe(false);
    });

    it("compares with the entry's own overrides, leaving language_code out as the request body does", () => {
      const overridden = buildVoice({
        "lap-time-intro": [
          {
            name: "first-good-lap",
            text: "That lap was.",
            voice_settings: { stability: 0.5, language_code: "fi" },
          },
        ],
      });

      writeTake(INTRO, INTRO_BYTES);
      writeTrial([{ key: INTRO, status: "ok", requestId: "req-intro" }], "eleven_v4", {
        voiceId: "eleven-voice-id",
        settings: { similarity_boost: 1, stability: 0.5 },
      });

      const { result, log } = runImport(
        { version: 1, entries: {} },
        { voiceConfigs: new Map([["default", overridden]]) },
      );

      expect(result).toEqual({ imported: 1, skipped: 0, problems: [] });
      expect(log.lines.some((line) => line.includes("not checked"))).toBe(false);
    });

    it("refuses a record seed that is not the entry's, and imports a matching one", () => {
      const seeded = buildVoice({
        "lap-time-intro": [{ name: "first-good-lap", text: "That lap was.", seed: 3 }],
        "lap-time-decimal": [{ name: "5", text: "point five" }],
      });

      writeTake(INTRO, INTRO_BYTES);
      writeTake(DECIMAL, DECIMAL_BYTES);
      writeTrial([
        { key: INTRO, status: "ok", requestId: "req-intro", seed: 1 },
        { key: DECIMAL, status: "ok", requestId: "req-decimal", seed: 1 },
      ]);

      const refused = runImport({ version: 1, entries: {} }, { voiceConfigs: new Map([["default", seeded]]) });

      expect(refused.result.problems).toEqual([`${INTRO}: cut with seed 1, but the config says 3`]);
      expect(fs.existsSync(path.join(root, "voice"))).toBe(false);

      writeTrial([
        { key: INTRO, status: "ok", requestId: "req-intro", seed: 3 },
        { key: DECIMAL, status: "ok", requestId: "req-decimal", seed: 1 },
      ]);

      const accepted = runImport({ version: 1, entries: {} }, { voiceConfigs: new Map([["default", seeded]]) });

      expect(accepted.result).toEqual({ imported: 2, skipped: 0, problems: [] });
    });

    it("imports a trial that records no settings, warning once per voice", () => {
      writeTake(INTRO, INTRO_BYTES);
      writeTrial([{ key: INTRO, status: "ok", requestId: "req-intro" }], "eleven_v4", { voiceId: "eleven-voice-id" });

      const { result, log } = runImport({ version: 1, entries: {} });

      expect(result).toEqual({ imported: 1, skipped: 0, problems: [] });
      expect(log.lines.filter((line) => line.includes("not checked"))).toEqual([
        `[import] voice "default": the trial records no settings for 1 take(s), so their voice settings were not checked against the config's`,
      ]);
    });
  });

  describe("what a run would refuse", () => {
    it("refuses a driver-name alias, as a run does (#1580)", () => {
      const names = buildVoice({
        names: [
          { name: "geoff", text: "Geoff" },
          { name: "jeff", text: "Jeff" },
        ],
      });

      writeTake("voice/default/names/geoff", INTRO_BYTES);
      writeTake("voice/default/names/jeff", INTRO_BYTES);
      writeTrial([
        { key: "voice/default/names/geoff", status: "ok", requestId: "a" },
        { key: "voice/default/names/jeff", status: "ok", requestId: "b" },
      ]);

      const manifest: Manifest = { version: 1, entries: {} };
      const { result } = runImport(manifest, { voiceConfigs: new Map([["default", names]]) });

      expect(result.problems).toEqual([
        'voice/default/names/geoff: "geoff" is a driver-name alias of "jeff" and plays its clips — record "jeff" instead and remove this entry',
      ]);
      expect(manifest.entries).toEqual({});
      expect(fs.existsSync(path.join(root, "voice"))).toBe(false);
    });

    it("refuses pause marks the grandfathered list does not cover (#1518)", () => {
      const marked = buildVoice({ "lap-time-intro": [{ name: "first-good-lap", text: "That lap: was." }] });

      writeTake(INTRO, INTRO_BYTES);
      writeTrial([{ key: INTRO, status: "ok", requestId: "req-intro" }]);

      const manifest: Manifest = { version: 1, entries: {} };
      const { result } = runImport(manifest, {
        voiceConfigs: new Map([["default", marked]]),
        // Listed under another text: an edit, not the frozen line.
        grandfathered: { default: { "lap-time-intro/first-good-lap": "That lap: was" } },
      });

      expect(result.problems).toEqual([
        `${INTRO}: text carries pause marks ":": ElevenLabs reads them as a pause and may fill it with a hesitation sound. Write a period where a pause is needed (#1518).`,
      ]);
      expect(manifest.entries).toEqual({});
      expect(fs.existsSync(path.join(root, "voice"))).toBe(false);
    });

    it("imports a grandfathered entry whose text is the frozen one, saying so", () => {
      const marked = buildVoice({ "lap-time-intro": [{ name: "first-good-lap", text: "That lap: was." }] });

      writeTake(INTRO, INTRO_BYTES);
      writeTrial([{ key: INTRO, status: "ok", requestId: "req-intro" }]);

      const manifest: Manifest = { version: 1, entries: {} };
      const { result, log } = runImport(manifest, {
        voiceConfigs: new Map([["default", marked]]),
        grandfathered: { default: { "lap-time-intro/first-good-lap": "That lap: was." } },
      });

      expect(result).toEqual({ imported: 1, skipped: 0, problems: [] });
      expect(manifest.entries[`${INTRO}.mp3`]!.requestId).toBe("req-intro");
      expect(log.lines).toContain(
        `[import] ${INTRO}  —  grandfathered text: text carries pause marks ":": ElevenLabs reads them as a pause and may fill it with a hesitation sound. Write a period where a pause is needed (#1518).`,
      );
    });

    it("imports an approved entry whose text is the approved one, without the grandfathered warning (#1643)", () => {
      const marked = buildVoice({ "lap-time-intro": [{ name: "first-good-lap", text: "That lap... was." }] });

      writeTake(INTRO, INTRO_BYTES);
      writeTrial([{ key: INTRO, status: "ok", requestId: "req-intro" }]);

      const manifest: Manifest = { version: 1, entries: {} };
      const { result, log } = runImport(manifest, {
        voiceConfigs: new Map([["default", marked]]),
        approved: { default: { "lap-time-intro/first-good-lap": "That lap... was." } },
      });

      expect(result).toEqual({ imported: 1, skipped: 0, problems: [] });
      expect(manifest.entries[`${INTRO}.mp3`]!.requestId).toBe("req-intro");
      expect(log.lines.filter((line) => line.includes("pause mark"))).toEqual([]);
    });

    it("refuses an entry whose approved text was edited, though it keeps the approved mark (#1643)", () => {
      const marked = buildVoice({ "lap-time-intro": [{ name: "first-good-lap", text: "That lap... was it." }] });

      writeTake(INTRO, INTRO_BYTES);
      writeTrial([{ key: INTRO, status: "ok", requestId: "req-intro" }]);

      const manifest: Manifest = { version: 1, entries: {} };
      const { result } = runImport(manifest, {
        voiceConfigs: new Map([["default", marked]]),
        approved: { default: { "lap-time-intro/first-good-lap": "That lap... was." } },
      });

      expect(result.problems).toEqual([
        `${INTRO}: text carries pause marks "...": ElevenLabs reads them as a pause and may fill it with a hesitation sound. Write a period where a pause is needed (#1518).`,
      ]);
      expect(manifest.entries).toEqual({});
      expect(fs.existsSync(path.join(root, "voice"))).toBe(false);
    });
  });

  it("refuses a missing or malformed trial manifest", () => {
    expect(runImport({ version: 1, entries: {} }).result.problems[0]).toMatch(/trial-manifest\.json does not exist$/);

    writeTrial([{ key: INTRO, status: "maybe", requestId: "x" }]);

    expect(runImport({ version: 1, entries: {} }).result.problems[0]).toMatch(
      /^trial-manifest\.json records\[0\]\.status: /,
    );

    fs.writeFileSync(path.join(trialDir, "trial-manifest.json"), "{ not json");

    expect(runImport({ version: 1, entries: {} }).result.problems[0]).toMatch(/^trial-manifest\.json is not JSON: /);
  });

  it("lists a group named like an Object.prototype key as unknown rather than throwing", () => {
    writeTrial([
      { key: "voice/default/constructor/x", status: "ok", requestId: "a" },
      { key: "voice/default/__proto__/x", status: "ok", requestId: "b" },
      { key: "voice/default/hasOwnProperty/x", status: "ok", requestId: "c" },
    ]);

    const { result } = runImport({ version: 1, entries: {} });

    expect(result.problems).toEqual([
      'voice/default/constructor/x: unknown entry (no group "constructor" in configs/)',
      'voice/default/__proto__/x: unknown entry (no group "__proto__" in configs/)',
      'voice/default/hasOwnProperty/x: unknown entry (no group "hasOwnProperty" in configs/)',
    ]);
  });

  it("refuses a key that is not voice/<voice>/<group>/<name>", () => {
    writeTrial([
      { key: `${INTRO}.mp3`, status: "ok", requestId: "a" },
      { key: "lap-time-intro/first-good-lap", status: "ok", requestId: "b" },
    ]);

    const { result } = runImport({ version: 1, entries: {} });

    expect(result.problems).toEqual([
      `${INTRO}.mp3: unknown entry (no entry in configs/)`,
      "lap-time-intro/first-good-lap: not a voice/<voice>/<group>/<name> key",
    ]);
  });
});

describe("parseImportArg", () => {
  it("takes the directory in both forms and leaves the rest", () => {
    expect(parseImportArg(["--dry-run", "--import", "C:/trial dir"])).toEqual({
      importDir: "C:/trial dir",
      rest: ["--dry-run"],
    });
    expect(parseImportArg(["--import=../trial", "--dry-run"])).toEqual({ importDir: "../trial", rest: ["--dry-run"] });
  });

  it("returns null without --import", () => {
    expect(parseImportArg(["--voice", "default"])).toEqual({ importDir: null, rest: ["--voice", "default"] });
  });

  it("refuses a missing, empty or flag-like value, and a second --import", () => {
    expect(() => parseImportArg(["--import"])).toThrow(/expected a directory \(got nothing\)/);
    expect(() => parseImportArg(["--import="])).toThrow(/expected a directory/);
    expect(() => parseImportArg(["--import", "--dry-run"])).toThrow(/got "--dry-run"/);
    expect(() => parseImportArg(["--import", "a", "--import", "b"])).toThrow(/give one directory/);
  });
});
