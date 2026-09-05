import { CALLOUT_SCRIPT_FILE, type CalloutScript, calloutScriptPath } from "@iracedeck/callout-script";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import url from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The REAL contracts, from deck-core's source rather than a copy: the packer's
// output must satisfy the schemas the plugin parses with and lay clips out where
// its scanner walks, so if either format moves these tests break with it.
import { VoicePackCatalogEntrySchema } from "../../deck-core/src/voice-pack-catalog.ts";
import { createVoicePackFileSystem } from "../../deck-core/src/voice-pack-fs.ts";
import { VoicePackManifestSchema } from "../../deck-core/src/voice-pack-manifest.ts";
import { scanVoicePacks } from "../../deck-core/src/voice-pack-scanner.ts";
import {
  archiveUrl,
  buildVoicePackManifest,
  CATALOG_DIR,
  countSourceClips,
  createArchive,
  MANIFEST_FILE,
  packVoice,
  serializeSortedJson,
} from "../scripts/pack-voice.mjs";
import { VOICE_PACKS } from "./build/voice-packs.mjs";

/**
 * One deliberate hole in the real file system: a path whose `lstat` reports
 * ENOENT although the directory listing just named it — the race between
 * `readdirSync` and the stat that the packer must report in its own words.
 * Nothing else is mocked; `null` is the file system as it is.
 */
const fsHook = vi.hoisted(() => ({ vanishOnStat: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // `lstatSync` is a stack of overloads; the wrapper takes the widest shape
  // and is handed back under the original type, since it forwards verbatim.
  type Widest = (file: import("node:fs").PathLike, options?: import("node:fs").StatOptions) => unknown;
  const forward = actual.lstatSync as Widest;
  const lstatSync = ((file, options) => {
    if (fsHook.vanishOnStat !== null && String(file) === fsHook.vanishOnStat) {
      const err = new Error(`ENOENT: no such file or directory, lstat '${String(file)}'`) as NodeJS.ErrnoException;
      err.code = "ENOENT";

      throw err;
    }

    return forward(file, options);
  }) as Widest as typeof actual.lstatSync;

  return { ...actual, lstatSync };
});

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// Derived from the scanner's own port rather than imported from
// `@iracedeck/logger`, which this package does not depend on.
type ScannerLogger = Parameters<typeof createVoicePackFileSystem>[0];

const noopLogger: ScannerLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withLevel: () => noopLogger,
  createScope: () => noopLogger,
};

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

/**
 * Walk a zip's local file headers (signature `PK\x03\x04`) and central directory
 * records (`PK\x01\x02`) and read back the fields a build could leak variation
 * through. Hand-rolled on purpose: fflate's reader does not expose the raw
 * timestamp, OS or attribute bytes, and those bytes are the whole point.
 */
function readZipRecords(archive: Uint8Array) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const local: { name: string; time: number; date: number; extraLength: number }[] = [];
  const central: { name: string; time: number; date: number; extraLength: number; os: number; attrs: number }[] = [];
  let offset = 0;

  while (offset + 4 <= archive.byteLength) {
    const signature = view.getUint32(offset, true);

    if (signature === 0x04034b50) {
      const nameLength = view.getUint16(offset + 26, true);
      const extraLength = view.getUint16(offset + 28, true);
      const compressedSize = view.getUint32(offset + 18, true);
      local.push({
        name: new TextDecoder().decode(archive.subarray(offset + 30, offset + 30 + nameLength)),
        time: view.getUint16(offset + 10, true),
        date: view.getUint16(offset + 12, true),
        extraLength,
      });
      offset += 30 + nameLength + extraLength + compressedSize;
    } else if (signature === 0x02014b50) {
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      central.push({
        name: new TextDecoder().decode(archive.subarray(offset + 46, offset + 46 + nameLength)),
        time: view.getUint16(offset + 12, true),
        date: view.getUint16(offset + 14, true),
        extraLength,
        os: archive[offset + 5]!,
        attrs: view.getUint32(offset + 38, true),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    } else if (signature === 0x06054b50) {
      break;
    } else {
      throw new Error(`unexpected zip signature 0x${signature.toString(16)} at ${offset}`);
    }
  }

  return { local, central };
}

/** Deterministic pseudo-random bytes so the synthetic entries are not trivially compressible. */
function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;

  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }

  return out;
}

describe("createArchive", () => {
  const entries = [
    { path: "voice/testvoice/flags/blue-01.mp3", data: pseudoRandomBytes(3000, 1) },
    { path: "voice/testvoice/flags/blue-02.mp3", data: pseudoRandomBytes(2500, 2) },
    { path: "voice/testvoice/position-number/4.mp3", data: pseudoRandomBytes(1200, 3) },
    { path: MANIFEST_FILE, data: new TextEncoder().encode('{\n  "schema": 1\n}\n') },
  ];

  it("produces identical bytes for the same entries, whatever order they arrive in", () => {
    const first = createArchive(entries);
    const second = createArchive([...entries].reverse());

    expect(sha256(second)).toBe(sha256(first));
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it("writes entries in sorted order with no timestamp, origin OS, attributes or extra field", () => {
    const { local, central } = readZipRecords(createArchive([...entries].reverse()));
    const sortedNames = entries.map((entry) => entry.path).sort();

    expect(local.map((record) => record.name)).toEqual(sortedNames);
    expect(central.map((record) => record.name)).toEqual(sortedNames);

    for (const record of [...local, ...central]) {
      // DOS date 0x0021 = 1980-01-01, time 0 = 00:00:00: the epoch, whatever the
      // building machine's clock or timezone says.
      expect(record.date).toBe(0x0021);
      expect(record.time).toBe(0);
      expect(record.extraLength).toBe(0);
    }

    for (const record of central) {
      expect(record.os).toBe(0);
      expect(record.attrs).toBe(0);
    }
  });

  it("round-trips every entry byte for byte", () => {
    const unpacked = unzipSync(createArchive(entries));

    expect(Object.keys(unpacked).sort()).toEqual(entries.map((entry) => entry.path).sort());

    for (const entry of entries) {
      expect(Buffer.from(unpacked[entry.path]!).equals(Buffer.from(entry.data))).toBe(true);
    }
  });

  it("refuses a path an installer would have to reject", () => {
    expect(() => createArchive([{ path: "../escape.mp3", data: new Uint8Array(1) }])).toThrow(/relative POSIX path/);
    expect(() => createArchive([{ path: "/abs.mp3", data: new Uint8Array(1) }])).toThrow(/relative POSIX path/);
    expect(() => createArchive([{ path: "voice\\x.mp3", data: new Uint8Array(1) }])).toThrow(/relative POSIX path/);
  });
});

/** A script with one real scenario, so the scanner's parse has something to accept. */
const SCRIPT: CalloutScript = {
  schema: 1,
  scenarios: {
    "pit-crew.flag-green": {
      comment: "Green flag.",
      test: "Take the green.",
      sequence: ["pool:flag-green", { if: "!race", then: [{ pause: 200 }] }],
    },
  },
  frames: { radio: { open: ["sfx/IRD-tick-open.mp3"], close: ["sfx/IRD-tick-close.mp3"] } },
  pools: { "flag-green": { group: "flags", base: "green" } },
};

/** Serialized the way the generator does NOT — sorted keys, no trailing newline — so a re-serialized copy would show. */
const SCRIPT_TEXT = JSON.stringify(
  { pools: SCRIPT.pools, frames: SCRIPT.frames, scenarios: SCRIPT.scenarios, schema: SCRIPT.schema },
  null,
  4,
);

/**
 * The end-to-end tests run the REAL pipeline (ffmpeg via ffmpeg-static) on a
 * two-clip synthetic voice rather than on the 12.5 MB bundled one: the pipeline
 * is what has to be byte-stable, not the size of the input, and two clips keep
 * the suite fast enough to run on every commit. The clips are copied from the
 * repository's own smallest source files so the audio is real.
 */
describe("packVoice", () => {
  const pack = {
    id: "testvoice",
    label: "Test Voice",
    version: "1.2.3",
    description: "Two clips, packed twice.",
    author: "iRaceDeck",
    voices: ["testvoice"],
    bundled: false,
  };

  let root: string;
  let srcRoot: string;
  let configsDir: string;
  let first: Awaited<ReturnType<typeof packVoice>>;
  let second: Awaited<ReturnType<typeof packVoice>>;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "ird-pack-voice-"));
    srcRoot = path.join(root, "voice");
    configsDir = path.join(root, "configs");

    const sources: [string, string][] = [
      ["voice/default/session-start-temp-numbers/1.mp3", "testvoice/numbers/1.mp3"],
      ["voice/default/lap-time-second/1.mp3", "testvoice/seconds/1.mp3"],
    ];

    for (const [from, to] of sources) {
      mkdirSync(path.dirname(path.join(srcRoot, to)), { recursive: true });
      copyFileSync(path.join(PACKAGE_ROOT, from), path.join(srcRoot, to));
    }

    // The voice's script, directly under voice/<id>/ where the scanner reads
    // it (#1064) — and a same-named decoy one level down, which is where the
    // walk must treat it as just another non-mp3 file.
    writeFileSync(path.join(srcRoot, "testvoice", CALLOUT_SCRIPT_FILE), SCRIPT_TEXT);
    writeFileSync(path.join(srcRoot, "testvoice", "numbers", CALLOUT_SCRIPT_FILE), SCRIPT_TEXT);

    mkdirSync(configsDir, { recursive: true });
    writeFileSync(path.join(configsDir, "testvoice.voice.json"), JSON.stringify({ label: "Test Voice", groups: {} }));

    // Two full runs with SEPARATE caches, so the second cannot merely copy the
    // first's processed clips: both go through ffmpeg from the source, and the
    // hashes agree only if the encode AND the archive are byte-stable.
    first = await packVoice({
      pack,
      srcRoot,
      configsDir,
      outDir: path.join(root, "out-1"),
      catalogDir: path.join(root, "catalog-1"),
      cacheDir: path.join(root, "cache-1"),
    });
    second = await packVoice({
      pack,
      srcRoot,
      configsDir,
      outDir: path.join(root, "out-2"),
      catalogDir: path.join(root, "catalog-2"),
      cacheDir: path.join(root, "cache-2"),
    });
  }, 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("packs the same clips to the same bytes twice, through the whole pipeline", () => {
    const firstArchive = readFileSync(first.archivePath);
    const secondArchive = readFileSync(second.archivePath);

    expect(sha256(secondArchive)).toBe(sha256(firstArchive));
    expect(second.entry.sha256).toBe(first.entry.sha256);
    expect(second.entry.bytes).toBe(first.entry.bytes);
  });

  it("emits a voice-pack.json the real VoicePackManifestSchema accepts, with sorted keys and LF endings", () => {
    const raw = readFileSync(path.join(first.stageDir, MANIFEST_FILE), "utf-8");
    const parsed = VoicePackManifestSchema.parse(JSON.parse(raw));

    expect(parsed).toEqual({
      schema: 1,
      id: "testvoice",
      label: "Test Voice",
      version: "1.2.3",
      author: "iRaceDeck",
      voices: [{ id: "testvoice", label: "Test Voice" }],
    });
    expect(raw).not.toContain("\r");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toBe(serializeSortedJson(buildVoicePackManifest(pack, parsed.voices)));
    expect(Object.keys(JSON.parse(raw))).toEqual(["author", "id", "label", "schema", "version", "voices"]);
  });

  it("lays the clips out where the real scanner finds them, with nothing to report", () => {
    const result = scanVoicePacks({
      root: path.dirname(first.stageDir),
      fs: createVoicePackFileSystem(noopLogger),
      reservedVoices: [],
    });

    expect(result.problems).toEqual([]);
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]).toMatchObject({
      id: "testvoice",
      label: "Test Voice",
      version: "1.2.3",
      author: "iRaceDeck",
      dir: first.stageDir,
      voices: [{ id: "testvoice", label: "Test Voice", script: SCRIPT }],
      clips: ["voice/testvoice/numbers/1.mp3", "voice/testvoice/seconds/1.mp3"],
    });
  });

  it("ships the voice's callouts.json as-is, in the archive and the stage, never in the cache", () => {
    const entryPath = calloutScriptPath("testvoice");
    const unpacked = unzipSync(readFileSync(first.archivePath));
    const source = readFileSync(path.join(srcRoot, "testvoice", CALLOUT_SCRIPT_FILE));

    expect(Object.keys(unpacked)).toContain(entryPath);
    expect(Buffer.from(unpacked[entryPath]!).equals(source)).toBe(true);
    expect(readFileSync(path.join(first.stageDir, entryPath)).equals(source)).toBe(true);
    expect(listFiles(path.join(root, "cache-1")).some((file) => file.endsWith(CALLOUT_SCRIPT_FILE))).toBe(false);
  });

  it("counts clips, not the script", () => {
    expect(first.clips).toBe(2);
    expect(first.scripts).toBe(1);
  });

  it("archives exactly the staged tree", () => {
    const unpacked = unzipSync(readFileSync(first.archivePath));
    const staged = listFiles(first.stageDir);

    expect(Object.keys(unpacked).sort()).toEqual(staged);
    // The decoy under numbers/ is not here: only the script directly under
    // the voice is the voice's script.
    expect(staged).toEqual([
      MANIFEST_FILE,
      calloutScriptPath("testvoice"),
      "voice/testvoice/numbers/1.mp3",
      "voice/testvoice/seconds/1.mp3",
    ]);

    for (const file of staged) {
      expect(Buffer.from(unpacked[file]!).equals(readFileSync(path.join(first.stageDir, file)))).toBe(true);
    }
  });

  it("ships the pipeline's processed clip, not the dry source", () => {
    const staged = readFileSync(path.join(first.stageDir, "voice/testvoice/numbers/1.mp3"));
    const cached = readFileSync(path.join(root, "cache-1", "testvoice", "numbers", "1.mp3"));
    const source = readFileSync(path.join(srcRoot, "testvoice", "numbers", "1.mp3"));

    expect(staged.equals(cached)).toBe(true);
    expect(staged.equals(source)).toBe(false);
  });

  it("writes a catalog entry the real VoicePackCatalogEntrySchema accepts, matching the archive", () => {
    const raw = readFileSync(first.catalogPath, "utf-8");
    const entry = VoicePackCatalogEntrySchema.parse(JSON.parse(raw));
    const archive = readFileSync(first.archivePath);

    expect(entry).toEqual({
      id: "testvoice",
      label: "Test Voice",
      version: "1.2.3",
      description: "Two clips, packed twice.",
      voices: [{ id: "testvoice", label: "Test Voice" }],
      bytes: statSync(first.archivePath).size,
      sha256: sha256(archive),
      url: "https://github.com/niklam/iracedeck/releases/download/voices-testvoice-1.2.3/testvoice-1.2.3.zip",
    });
    expect(entry.url).toBe(archiveUrl(pack));
    expect(raw).not.toContain("\r");
    expect(raw.endsWith("\n")).toBe(true);
    expect(first.archivePath).toBe(path.join(root, "out-1", "testvoice-1.2.3.zip"));
  });

  it("refuses a clip the scanner would refuse rather than packing a mute voice", async () => {
    const loose = path.join(srcRoot, "testvoice", "loose.mp3");
    copyFileSync(path.join(srcRoot, "testvoice", "numbers", "1.mp3"), loose);

    try {
      await expect(
        packVoice({
          pack,
          srcRoot,
          configsDir,
          outDir: path.join(root, "out-3"),
          catalogDir: path.join(root, "catalog-3"),
          cacheDir: path.join(root, "cache-3"),
        }),
      ).rejects.toThrow(/voice\/testvoice\/loose\.mp3 is not a clip the engine can play/);
    } finally {
      rmSync(loose);
    }

    expect(existsSync(path.join(root, "catalog-3", "testvoice.json"))).toBe(false);
  }, 30_000);

  // A pack must never ship a script the scanner will reject: the scanner
  // drops such a voice, so the pack would install, claim nothing, and be
  // silent — with the only trace a line in Installed Voices on the user's
  // machine. Refused here, naming the file and the first problem, before a
  // single clip is staged.
  /**
   * A one-clip voice under its own root with a script placed by `place`
   * (default: the text at `voice/testvoice/callouts.json`), and a `packVoice`
   * call against it. Shared by the refusal cases and the BOM case.
   */
  function packWithScript(name: string, text: string, place?: (voiceDir: string) => void) {
    const caseRoot = path.join(root, name);
    const voiceDir = path.join(caseRoot, "voice", "testvoice");

    mkdirSync(path.join(voiceDir, "numbers"), { recursive: true });
    copyFileSync(path.join(srcRoot, "testvoice", "numbers", "1.mp3"), path.join(voiceDir, "numbers", "1.mp3"));

    if (place) place(voiceDir);
    else writeFileSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE), text);

    const attempt = () =>
      packVoice({
        pack,
        srcRoot: path.join(caseRoot, "voice"),
        configsDir,
        outDir: path.join(caseRoot, "out"),
        catalogDir: path.join(caseRoot, "catalog"),
        cacheDir: path.join(caseRoot, "cache"),
      });

    return { attempt, badRoot: caseRoot, voiceDir };
  }

  it("ships a script with a UTF-8 BOM byte for byte — the packer is no stricter than the scanner about one", async () => {
    // Windows editors write one; the scanner strips it before parsing, so the
    // packer validates past it too and ships the file AS-IS, BOM included —
    // a re-encoded script would be a second copy of the author's file.
    const bomText = "\ufeff" + SCRIPT_TEXT;
    const { attempt, voiceDir } = packWithScript("bom", bomText);
    const result = await attempt();
    const entryPath = calloutScriptPath("testvoice");
    const unpacked = unzipSync(readFileSync(result.archivePath));
    const source = readFileSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE));

    expect(result.scripts).toBe(1);
    expect(source.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(Buffer.from(unpacked[entryPath]!).equals(source)).toBe(true);
    expect(readFileSync(path.join(result.stageDir, entryPath)).equals(source)).toBe(true);
  }, 60_000);

  describe("refuses a malformed callouts.json rather than packing a voice the scanner will drop", () => {
    it("one that fails the grammar", async () => {
      const { attempt, badRoot } = packWithScript(
        "bad-grammar",
        JSON.stringify({ schema: 1, scenarios: { "pit-crew.flag-green": { sequnce: [] } }, frames: {}, pools: {} }),
      );

      await expect(attempt()).rejects.toThrow(
        /voice\/testvoice\/callouts\.json[\s\S]*scenarios\.pit-crew\.flag-green\.sequnce/,
      );
      expect(existsSync(path.join(badRoot, "catalog"))).toBe(false);
      expect(existsSync(path.join(badRoot, "out", "testvoice-1.2.3.zip"))).toBe(false);
      // Nothing was staged: the script is checked before the pipeline runs.
      expect(existsSync(path.join(badRoot, "out", "testvoice", "voice"))).toBe(false);
    });

    it("one that is not JSON — the grammar's own document problem, through the scanner's text stage", async () => {
      const { attempt, badRoot } = packWithScript("bad-json", "{ not json");

      await expect(attempt()).rejects.toThrow(
        /voice\/testvoice\/callouts\.json is not a script the plugin accepts:\s+\(document\): not valid JSON: /,
      );
      expect(existsSync(path.join(badRoot, "catalog"))).toBe(false);
    });

    it("one that is a directory — refused as not a regular file, not as unreadable or invalid JSON", async () => {
      // The walk stages only what `Dirent.isFile()` says is a file; a folder
      // of the script's name would be skipped by it, so it is refused here in
      // the same words a symlink is — and never reported as a syntax error,
      // which an author would look for and not find.
      const { attempt, badRoot } = packWithScript("directory", "", (voiceDir) => {
        mkdirSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE));
      });

      await expect(attempt()).rejects.toThrow(/voice\/testvoice\/callouts\.json must be a regular file/);
      await expect(attempt()).rejects.not.toThrow(/not valid JSON/);
      expect(existsSync(path.join(badRoot, "catalog"))).toBe(false);
      expect(existsSync(path.join(badRoot, "out", "testvoice", "voice"))).toBe(false);
    });

    it("one that is a symlink to a valid script — the walk would not stage it and the pack would ship silent", async (ctx) => {
      // `readFileSync` follows the link, so without the `lstat` check a link
      // to a perfectly good script validates and is then left out of the
      // stage. Windows needs a privilege (or Developer Mode) to create a file
      // symlink; where it is refused, the case is skipped rather than faked.
      const { attempt, badRoot, voiceDir } = packWithScript("symlink", "", (dir) => {
        const target = path.join(dir, "..", "real-script.json");
        writeFileSync(target, SCRIPT_TEXT);

        try {
          symlinkSync(target, path.join(dir, CALLOUT_SCRIPT_FILE), "file");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EPERM") return;

          throw err;
        }
      });

      if (!existsSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE))) {
        ctx.skip("this platform refused to create a file symlink (EPERM) — no way to exercise the case here");
      }

      await expect(attempt()).rejects.toThrow(/voice\/testvoice\/callouts\.json must be a regular file/);
      expect(existsSync(path.join(badRoot, "catalog"))).toBe(false);
      expect(existsSync(path.join(badRoot, "out", "testvoice", "voice"))).toBe(false);
    });

    it("one that vanishes between the listing and the stat — the packer's own words, not a raw Node error", async () => {
      const { attempt, badRoot, voiceDir } = packWithScript("vanishing", SCRIPT_TEXT);
      fsHook.vanishOnStat = path.join(voiceDir, CALLOUT_SCRIPT_FILE);

      try {
        await expect(attempt()).rejects.toThrow(
          /^pack "testvoice": voice\/testvoice\/callouts\.json could not be read: .*ENOENT/,
        );
        expect(existsSync(path.join(badRoot, "catalog"))).toBe(false);
      } finally {
        fsHook.vanishOnStat = null;
      }
    });

    it("one that cannot be read — reported as a read failure, not as invalid JSON", async (ctx) => {
      // A regular file with no read permission. Only POSIX, and only as a
      // non-root user, can refuse a read that way: Windows has no chmod-based
      // denial, and root reads anything. Elsewhere the branch is left to CI.
      if (process.platform === "win32" || process.getuid?.() === 0) {
        ctx.skip("a read-denied regular file needs a non-root POSIX user");
      }

      const { attempt, badRoot } = packWithScript("unreadable", SCRIPT_TEXT, (dir) => {
        const file = path.join(dir, CALLOUT_SCRIPT_FILE);
        writeFileSync(file, SCRIPT_TEXT);
        chmodSync(file, 0o000);
      });

      try {
        await expect(attempt()).rejects.toThrow(/voice\/testvoice\/callouts\.json could not be read: .*EACCES/);
        await expect(attempt()).rejects.not.toThrow(/not valid JSON/);
        expect(existsSync(path.join(badRoot, "catalog"))).toBe(false);
      } finally {
        chmodSync(path.join(badRoot, "voice", "testvoice", CALLOUT_SCRIPT_FILE), 0o644);
      }
    });

    it("one whose name is not exactly lowercase — the walk would not stage it and the pack would ship silent", async () => {
      // On a case-insensitive file system `existsSync("callouts.json")` finds
      // `Callouts.json`, so the old check validated a file the walk then
      // skipped. The listing carries the on-disk casing on every platform, so
      // this is refused everywhere — and the assertion is the message, which
      // holds whether or not the file system tells the two names apart.
      const { attempt, badRoot } = packWithScript("wrong-case", "", (voiceDir) => {
        writeFileSync(path.join(voiceDir, "Callouts.json"), SCRIPT_TEXT);
      });

      await expect(attempt()).rejects.toThrow(/found "Callouts\.json".*must be named exactly "callouts\.json"/);
      expect(existsSync(path.join(badRoot, "catalog"))).toBe(false);
      expect(existsSync(path.join(badRoot, "out", "testvoice", "voice"))).toBe(false);
    });
  });

  it("refuses a pack whose definition the schemas would refuse", async () => {
    const attempt = (overrides: Record<string, unknown>) =>
      packVoice({
        pack: { ...pack, ...overrides },
        srcRoot,
        configsDir,
        outDir: path.join(root, "out-4"),
        cacheDir: path.join(root, "cache-4"),
      });

    await expect(attempt({ id: "Test Voice" })).rejects.toThrow(/kebab-case/);
    await expect(attempt({ version: "1.2" })).rejects.toThrow(/semver/);
    await expect(attempt({ label: "x".repeat(61) })).rejects.toThrow(/1-60 characters/);
    await expect(attempt({ voices: [] })).rejects.toThrow(/at least one voice/);
  });
});

/**
 * The committed entries are produced by packing the real voices, which needs a
 * warm ffmpeg cache or minutes of encoding — so their `bytes` and `sha256` are
 * NOT re-derived here (that is a release step, run by hand). What IS checked is
 * everything cheap: every published pack has an entry, every entry parses under
 * the schema the plugin will parse it with, and the fields the registry owns
 * have not drifted from it.
 */
describe("committed catalog entries", () => {
  it("has one entry per published pack, each matching its VOICE_PACKS definition", () => {
    for (const pack of VOICE_PACKS) {
      const file = path.join(CATALOG_DIR, `${pack.id}.json`);

      expect(existsSync(file), `missing ${file} — run pack:voice ${pack.id}`).toBe(true);

      const entry = VoicePackCatalogEntrySchema.parse(JSON.parse(readFileSync(file, "utf-8")));
      const voices = pack.voices.map((id) => ({
        id,
        label: JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "configs", `${id}.voice.json`), "utf-8")).label,
      }));

      expect(entry).toMatchObject({
        id: pack.id,
        label: pack.label,
        version: pack.version,
        voices,
        url: archiveUrl(pack),
      });
      expect(entry.description).toBe(pack.description);
      expect(entry.minPluginVersion).toBe(pack.minPluginVersion);
    }
  });

  it("has no entry for a pack the registry does not publish", () => {
    const known = new Set(VOICE_PACKS.map((pack) => `${pack.id}.json`));

    for (const file of readdirSync(CATALOG_DIR)) {
      expect(known.has(file), `${file} has no VOICE_PACKS entry`).toBe(true);
    }
  });
});

describe("countSourceClips", () => {
  // The counter the completeness assertion trusts. It is deliberately a SECOND,
  // independent walk of the source rather than a number the pipeline reports
  // about itself — a count derived from the thing being checked would agree
  // with it by construction and prove nothing.
  it("counts clips recursively and ignores everything that is not an mp3", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ird-count-"));

    try {
      mkdirSync(path.join(root, "flags"), { recursive: true });
      mkdirSync(path.join(root, "units", "nested"), { recursive: true });
      writeFileSync(path.join(root, "flags", "blue-01.mp3"), "a");
      writeFileSync(path.join(root, "flags", "blue-02.MP3"), "b");
      writeFileSync(path.join(root, "flags", "notes.txt"), "c");
      writeFileSync(path.join(root, "units", "litres.mp3"), "d");
      writeFileSync(path.join(root, "units", "nested", "deep.mp3"), "e");

      // Three lowercase, one uppercase — the pipeline matches the extension
      // case-insensitively too, so the two walks must agree on that or the
      // assertion would fire on a pack that is actually complete.
      expect(countSourceClips(root)).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts an empty tree as zero rather than throwing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ird-count-empty-"));

    try {
      expect(countSourceClips(root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
