// The pack record (#1667), over a temporary tree: what the inputs cover, what
// they ignore, and the four rules each failing alone with the words the
// failure prints. Nothing here runs ffmpeg — the record is a function of the
// SOURCE tree — so the clips are a few bytes each.
import { CALLOUT_SCRIPT_FILE } from "@iracedeck/callout-script";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PIPELINE_IDENTITY, pipelineIdentityHash } from "./index.mjs";
import { archiveFormatIdentity, buildVoicePackManifest, serializeSortedJson } from "./pack-format.mjs";
import {
  buildPackRecord,
  checkPackRecords,
  computePackInputs,
  computeVoiceInputs,
  formatPackRecordProblems,
  type PackInputs,
  type PackRecord,
  packRecordPath,
  type PackRecordProblem,
  readPackRecord,
  sealPackRecords,
  serializePackRecord,
  writePackRecord,
} from "./pack-record.mjs";
import type { VoicePackDefinition } from "./voice-packs.mjs";

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

const PACK: VoicePackDefinition = Object.freeze({
  id: "testvoice",
  label: "Test Voice",
  version: "1.2.3",
  description: "A record's worth of clips.",
  author: "iRaceDeck",
  voices: Object.freeze(["testvoice"]),
  bundled: false,
});

/** The archive's sha-256 the fixture's entry and record agree on; the archive itself never exists here. */
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SCRIPT_TEXT = '{"schema":1,"scenarios":{},"frames":{},"pools":{}}';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Fixture = {
  root: string;
  roots: { srcRoot: string; configsDir: string; catalogDir: string; recordsDir: string };
  voiceDir: string;
  inputs: PackInputs;
  /** Write (or overwrite) the record, from the fixture's inputs and `SHA_A` unless overridden. */
  writeRecord: (overrides?: Partial<PackRecord>, pack?: VoicePackDefinition) => string;
  /** Write (or overwrite) the catalog entry with `sha256`. */
  writeEntry: (sha256?: string) => string;
  /** The record file's bytes. */
  recordBytes: () => string;
};

/**
 * A one-voice pack tree with two clips and a script, its config, a catalog
 * entry at `SHA_A`, and a fresh record agreeing with all of it: the clean
 * state every rule test mutates one thing of.
 */
function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "ird-pack-record-"));
  tempDirs.push(root);

  const roots = {
    srcRoot: path.join(root, "voice"),
    configsDir: path.join(root, "configs"),
    catalogDir: path.join(root, "catalog"),
    recordsDir: path.join(root, "pack-records"),
  };
  const voiceDir = path.join(roots.srcRoot, "testvoice");

  mkdirSync(path.join(voiceDir, "numbers"), { recursive: true });
  mkdirSync(path.join(voiceDir, "seconds"), { recursive: true });
  writeFileSync(path.join(voiceDir, "numbers", "1.mp3"), "one");
  writeFileSync(path.join(voiceDir, "seconds", "1.mp3"), "one second");
  writeFileSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE), SCRIPT_TEXT);
  mkdirSync(roots.configsDir);
  writeFileSync(
    path.join(roots.configsDir, "testvoice.voice.json"),
    JSON.stringify({ label: "Test Voice", groups: {} }),
  );
  mkdirSync(roots.catalogDir);
  mkdirSync(roots.recordsDir);

  const writeEntry = (sha = SHA_A) => {
    const file = path.join(roots.catalogDir, "testvoice.json");
    writeFileSync(
      file,
      `${JSON.stringify({ id: "testvoice", version: PACK.version, bytes: 3, sha256: sha }, null, 2)}\n`,
    );

    return file;
  };
  const inputs = computePackInputs(PACK, roots);
  // Written at the PACK's path, whatever `overrides` say the id is: a record
  // naming another id under this file is exactly what rule 2 catches.
  const writeRecord = (overrides: Partial<PackRecord> = {}, pack: VoicePackDefinition = PACK) => {
    const file = packRecordPath(pack.id, roots.recordsDir);

    writeFileSync(file, serializePackRecord({ ...buildPackRecord(pack, { sha256: SHA_A, inputs }), ...overrides }));

    return file;
  };

  writeEntry();
  writeRecord();

  return {
    root,
    roots,
    voiceDir,
    inputs,
    writeRecord,
    writeEntry,
    recordBytes: () => readFileSync(packRecordPath("testvoice", roots.recordsDir), "utf-8"),
  };
}

/** Which top-level parts of two inputs differ — the question every "changes when" case asks. */
function changedParts(before: PackInputs, after: PackInputs): string[] {
  const parts: string[] = [];

  for (const key of ["pipeline", "archiveFormat", "manifest"] as const) if (before[key] !== after[key]) parts.push(key);

  for (const voice of Object.keys(before.voices)) {
    if (before.voices[voice]!.clipsSha256 !== after.voices[voice]?.clipsSha256) parts.push(`voices.${voice}.clips`);

    if (before.voices[voice]!.script !== after.voices[voice]?.script) parts.push(`voices.${voice}.script`);
  }

  return parts;
}

describe("computePackInputs — what an archive is a function of", () => {
  it("digests the pipeline identity, the archive format, the exact manifest bytes, and each voice's clips and script", () => {
    const { inputs, voiceDir } = fixture();
    const manifest = serializeSortedJson(buildVoicePackManifest(PACK, [{ id: "testvoice", label: "Test Voice" }]));
    const line = (rel: string) => `${rel}\0${sha256(readFileSync(path.join(voiceDir, rel)))}\n`;

    expect(inputs).toEqual({
      pipeline: pipelineIdentityHash(PIPELINE_IDENTITY),
      archiveFormat: sha256(serializeSortedJson(archiveFormatIdentity())),
      manifest: sha256(manifest),
      voices: {
        testvoice: {
          clips: 2,
          // One line per clip, sorted by POSIX path by code unit: `<path>\0<sha256>\n`.
          clipsSha256: sha256(line("numbers/1.mp3") + line("seconds/1.mp3")),
          script: sha256(SCRIPT_TEXT),
        },
      },
    });
    // The pipeline digest is the full identity hash, never the eight-digit cache key.
    expect(inputs.pipeline).toMatch(/^[0-9a-f]{64}$/);
  });

  describe("change", () => {
    it("when one clip's bytes change — the clips, and only the clips", () => {
      const { inputs, voiceDir, roots } = fixture();

      writeFileSync(path.join(voiceDir, "numbers", "1.mp3"), "ONE");

      expect(changedParts(inputs, computePackInputs(PACK, roots))).toEqual(["voices.testvoice.clips"]);
    });

    it("when a clip is added, removed or renamed", () => {
      const { inputs, voiceDir, roots } = fixture();

      writeFileSync(path.join(voiceDir, "numbers", "2.mp3"), "two");
      const added = computePackInputs(PACK, roots);

      expect(changedParts(inputs, added)).toEqual(["voices.testvoice.clips"]);
      expect(added.voices.testvoice!.clips).toBe(3);

      rmSync(path.join(voiceDir, "numbers", "2.mp3"));
      rmSync(path.join(voiceDir, "seconds", "1.mp3"));
      const removed = computePackInputs(PACK, roots);

      expect(changedParts(inputs, removed)).toEqual(["voices.testvoice.clips"]);
      expect(removed.voices.testvoice!.clips).toBe(1);

      writeFileSync(path.join(voiceDir, "seconds", "1.mp3"), "one second");
      expect(computePackInputs(PACK, roots)).toEqual(inputs);

      // Same bytes under a new name: the path is part of every line.
      renameSync(path.join(voiceDir, "numbers", "1.mp3"), path.join(voiceDir, "numbers", "01.mp3"));
      const renamed = computePackInputs(PACK, roots);

      expect(changedParts(inputs, renamed)).toEqual(["voices.testvoice.clips"]);
      expect(renamed.voices.testvoice!.clips).toBe(2);
    });

    it("when callouts.json changes alone — named as the script, apart from the clips (#1582's case)", () => {
      const { inputs, voiceDir, roots } = fixture();

      writeFileSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE), `${SCRIPT_TEXT}\n`);

      expect(changedParts(inputs, computePackInputs(PACK, roots))).toEqual(["voices.testvoice.script"]);

      rmSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE));
      const clipsOnly = computePackInputs(PACK, roots);

      expect(changedParts(inputs, clipsOnly)).toEqual(["voices.testvoice.script"]);
      expect(clipsOnly.voices.testvoice!.script).toBeNull();
    });

    it("when a voice's config label changes — through the manifest", () => {
      const { inputs, roots } = fixture();

      writeFileSync(path.join(roots.configsDir, "testvoice.voice.json"), JSON.stringify({ label: "Test Voice 2" }));

      expect(changedParts(inputs, computePackInputs(PACK, roots))).toEqual(["manifest"]);
    });

    it.each([
      ["version", { version: "1.2.4" }],
      ["label", { label: "Test Voice (renamed)" }],
      ["author", { author: "Someone Else" }],
    ])("when the pack's %s changes — through the manifest", (_field, override) => {
      const { inputs, roots } = fixture();

      expect(changedParts(inputs, computePackInputs({ ...PACK, ...override }, roots))).toEqual(["manifest"]);
    });

    it("when the pipeline identity or the archive format changes", () => {
      const { inputs, roots } = fixture();

      expect(
        changedParts(
          inputs,
          computePackInputs(PACK, { ...roots, pipelineIdentity: { ...PIPELINE_IDENTITY, ffmpegStatic: "9.9.9" } }),
        ),
      ).toEqual(["pipeline"]);

      const format = archiveFormatIdentity();

      expect(
        changedParts(inputs, computePackInputs(PACK, { ...roots, archiveFormat: { ...format, fflate: "0.0.1" } })),
      ).toEqual(["archiveFormat"]);
    });
  });

  describe("do not change", () => {
    it("when a clip is replaced by a copy with identical bytes, or touched — content, never mtime (#1143)", () => {
      const { inputs, voiceDir, roots, root } = fixture();
      const clip = path.join(voiceDir, "numbers", "1.mp3");
      const copy = path.join(root, "copy.mp3");

      copyFileSync(clip, copy);
      rmSync(clip);
      copyFileSync(copy, clip);

      const ahead = new Date(Date.now() + 24 * 60 * 60 * 1000);
      utimesSync(clip, ahead, ahead);
      utimesSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE), ahead, ahead);

      expect(computePackInputs(PACK, roots)).toEqual(inputs);
    });

    it("when a non-mp3, non-script file appears — a note, a nested callouts.json, an empty folder", () => {
      const { inputs, voiceDir, roots } = fixture();

      writeFileSync(path.join(voiceDir, "numbers", "notes.txt"), "not a clip");
      writeFileSync(path.join(voiceDir, "numbers", CALLOUT_SCRIPT_FILE), "{}");
      mkdirSync(path.join(voiceDir, "empty"));

      expect(computePackInputs(PACK, roots)).toEqual(inputs);
    });

    it("when a wrong-cased Callouts.json appears — the walk would not stage it, so it is not an input", () => {
      const { inputs, voiceDir, roots } = fixture();

      writeFileSync(path.join(voiceDir, "Callouts.json"), "{}");

      // On a case-insensitive file system this overwrote the real script's
      // bytes under the exact name; the digest then follows those bytes, which
      // is still "what the packer would stage". Either way nothing else moves.
      const now = computePackInputs(PACK, roots);

      expect(changedParts(inputs, now).filter((part) => part !== "voices.testvoice.script")).toEqual([]);
    });
  });

  it("counts an uppercase .MP3 as a clip, as countSourceClips and the pipeline's walk do", () => {
    const { voiceDir } = fixture();

    writeFileSync(path.join(voiceDir, "numbers", "2.MP3"), "two");

    expect(computeVoiceInputs(voiceDir).clips).toBe(3);
  });

  it("refuses a voice with no source tree, naming the pack and the voice", () => {
    const { roots } = fixture();

    writeFileSync(path.join(roots.configsDir, "missing.voice.json"), JSON.stringify({ label: "Missing" }));

    expect(() => computePackInputs({ ...PACK, voices: ["missing"] }, roots)).toThrow(
      /pack "testvoice": voice "missing" has no clips at/,
    );
    // And one with no config, in the config reader's words.
    expect(() => computePackInputs({ ...PACK, voices: ["unconfigured"] }, roots)).toThrow(
      /voice "unconfigured": no .*unconfigured\.voice\.json/,
    );
  });
});

describe("the record file", () => {
  it("is written in the spec's field order as two-space LF JSON with a trailing newline, and reads back equal", () => {
    const { inputs, roots } = fixture();
    const record = buildPackRecord(PACK, {
      sha256: SHA_A,
      inputs,
      released: { version: "1.2.3", sha256: SHA_A },
    });

    expect(Object.keys(record)).toEqual(["id", "version", "sha256", "inputs", "released"]);
    expect(Object.keys(record.inputs)).toEqual(["pipeline", "archiveFormat", "manifest", "voices"]);
    expect(Object.keys(record.inputs.voices.testvoice!)).toEqual(["clips", "clipsSha256", "script"]);

    const file = writePackRecord(record, roots.recordsDir);
    const raw = readFileSync(file, "utf-8");

    expect(file).toBe(path.join(roots.recordsDir, "testvoice.json"));
    expect(raw).toBe(serializePackRecord(record));
    expect(raw).toBe(`${JSON.stringify(record, null, 2)}\n`);
    expect(raw).not.toContain("\r");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(readPackRecord("testvoice", roots.recordsDir)).toEqual(record);
  });

  it("leaves released out when there is none", () => {
    const { inputs } = fixture();

    expect("released" in buildPackRecord(PACK, { sha256: SHA_A, inputs })).toBe(false);
  });

  it("reads a missing record as null, and refuses one that is not JSON or not a record, naming the file", () => {
    const { roots } = fixture();

    expect(readPackRecord("absent", roots.recordsDir)).toBeNull();

    writeFileSync(packRecordPath("testvoice", roots.recordsDir), "{ not json");
    expect(() => readPackRecord("testvoice", roots.recordsDir)).toThrow(/testvoice\.json could not be read as JSON/);

    writeFileSync(packRecordPath("testvoice", roots.recordsDir), JSON.stringify({ id: "testvoice" }));
    expect(() => readPackRecord("testvoice", roots.recordsDir)).toThrow(
      /testvoice\.json is not a pack record:\n {2}version:/,
    );

    // Strict: a misspelled key is refused rather than ignored into a record that agrees with nothing.
    const { inputs } = fixture();
    const loose = { ...buildPackRecord(PACK, { sha256: SHA_A, inputs }), sha265: SHA_A };
    writeFileSync(packRecordPath("testvoice", roots.recordsDir), JSON.stringify(loose));
    expect(() => readPackRecord("testvoice", roots.recordsDir)).toThrow(/sha265/);

    // And a sha-256 that is not one.
    writePackRecord({ ...buildPackRecord(PACK, { sha256: SHA_A, inputs }), sha256: "ABC" }, roots.recordsDir);
    expect(() => readPackRecord("testvoice", roots.recordsDir)).toThrow(
      /sha256: must be a lowercase 64-hex-digit sha-256/,
    );
  });
});

/** The problems' parts, the one-line answer to "which rule failed, and did anything else?". */
const parts = (problems: PackRecordProblem[]) => problems.map((problem) => problem.part);

const REPACK = "run `pnpm --filter @iracedeck/audio-assets pack:voice testvoice`";
const COMMIT_BOTH = "commit catalog/testvoice.json and pack-records/testvoice.json";

describe("checkPackRecords", () => {
  it("passes a clean tree", () => {
    const { roots } = fixture();

    expect(checkPackRecords({ packs: [PACK], ...roots })).toEqual([]);
  });

  describe("rule 1 — coverage", () => {
    it("fails a pack with no record, naming the file and the command", () => {
      const { roots } = fixture();

      rmSync(packRecordPath("testvoice", roots.recordsDir));

      const problems = checkPackRecords({ packs: [PACK], ...roots });

      expect(parts(problems)).toEqual(["record"]);
      expect(problems[0]).toMatchObject({ pack: "testvoice", message: "testvoice: no pack-records/testvoice.json" });
      expect(problems[0]!.fix).toBe(`${REPACK} and ${COMMIT_BOTH}`);
    });

    it("fails a record for a pack the registry does not publish, and a file that is not a record", () => {
      const { roots, inputs } = fixture();

      writePackRecord(buildPackRecord({ ...PACK, id: "retired" }, { sha256: SHA_A, inputs }), roots.recordsDir);
      writeFileSync(path.join(roots.recordsDir, "notes.txt"), "");

      const problems = checkPackRecords({ packs: [PACK], ...roots });

      expect(problems).toEqual([
        {
          pack: "notes.txt",
          part: "registry",
          message: "pack-records/notes.txt is not a pack record",
          fix: "pack-records/ holds one <id>.json per published pack and nothing else: remove it",
        },
        {
          pack: "retired",
          part: "registry",
          message: "retired: pack-records/retired.json has no entry in src/build/voice-packs.mjs",
          fix: "register the pack in src/build/voice-packs.mjs, or remove the record",
        },
      ]);
    });

    it("passes with no records directory at all when there is no pack to record", () => {
      const { roots } = fixture();

      rmSync(roots.recordsDir, { recursive: true });

      expect(checkPackRecords({ packs: [], ...roots })).toEqual([]);
    });

    it("fails a record it cannot read, rather than treating it as absent", () => {
      const { roots } = fixture();

      writeFileSync(packRecordPath("testvoice", roots.recordsDir), "{ not json");

      const problems = checkPackRecords({ packs: [PACK], ...roots });

      expect(parts(problems)).toEqual(["record"]);
      expect(problems[0]!.message).toMatch(/could not be read as JSON/);
      expect(problems[0]!.fix).toMatch(/restore pack-records\/testvoice\.json from git/);
    });
  });

  describe("rule 2 — consistency", () => {
    it("fails a record whose id is not the pack's", () => {
      const { roots, writeRecord } = fixture();

      writeRecord({ id: "othervoice" });

      const problems = checkPackRecords({ packs: [PACK], ...roots });

      expect(parts(problems)).toEqual(["id"]);
      expect(problems[0]!.message).toBe('testvoice: pack-records/testvoice.json names id "othervoice"');
      expect(problems[0]!.fix).toMatch(/edited by hand or left out of the commit/);
    });

    it("fails a record whose version is not the definition's", () => {
      const { roots, writeRecord } = fixture();

      // Only the record's field moves: the inputs were computed at 1.2.3, so
      // rule 3 stays quiet and this is the one failure.
      writeRecord({ version: "1.2.2" });

      const problems = checkPackRecords({ packs: [PACK], ...roots });

      expect(parts(problems)).toEqual(["version"]);
      expect(problems[0]!.message).toBe(
        "testvoice: pack-records/testvoice.json records version 1.2.2, but src/build/voice-packs.mjs says 1.2.3",
      );
    });

    it("fails a record whose sha256 is not the catalog entry's, and an entry that is missing", () => {
      const { roots, writeEntry } = fixture();

      writeEntry(SHA_B);

      const problems = checkPackRecords({ packs: [PACK], ...roots });

      expect(parts(problems)).toEqual(["sha256"]);
      expect(problems[0]!.message).toBe(
        `testvoice: pack-records/testvoice.json records sha256 ${SHA_A}, but catalog/testvoice.json has ${SHA_B}`,
      );

      rmSync(path.join(roots.catalogDir, "testvoice.json"));

      const missing = checkPackRecords({ packs: [PACK], ...roots });

      expect(parts(missing)).toEqual(["entry"]);
      expect(missing[0]!.message).toBe("testvoice: no catalog/testvoice.json");
    });
  });

  describe("rule 3 — freshness", () => {
    it("fails a changed clip, naming the voice's clips with both counts, and asks for a re-pack without a bump when the version is not released", () => {
      const { roots, voiceDir } = fixture();

      writeFileSync(path.join(voiceDir, "numbers", "2.mp3"), "two");

      const problems = checkPackRecords({ packs: [PACK], ...roots });

      expect(problems).toEqual([
        {
          pack: "testvoice",
          part: "voices.testvoice.clips",
          message: "testvoice: the clips under voice/testvoice changed (3 now, 2 recorded)",
          fix: `version 1.2.3 is not released yet: ${REPACK}, and ${COMMIT_BOTH}`,
        },
      ]);
    });

    it("says so when the count is unchanged but the bytes are not", () => {
      const { roots, voiceDir } = fixture();

      writeFileSync(path.join(voiceDir, "numbers", "1.mp3"), "ONE");

      expect(checkPackRecords({ packs: [PACK], ...roots })[0]!.message).toBe(
        "testvoice: the clips under voice/testvoice changed (2 clips as recorded, with different bytes or paths)",
      );
    });

    it("fails a changed callouts.json alone, naming the file — #1582's case — and asks for a bump when the version is released", () => {
      const { roots, voiceDir, writeRecord } = fixture();

      writeRecord({ released: { version: "1.2.3", sha256: SHA_A } });
      writeFileSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE), `${SCRIPT_TEXT}\n`);

      const problems = checkPackRecords({ packs: [PACK], ...roots });

      expect(problems).toEqual([
        {
          pack: "testvoice",
          part: "voices.testvoice.script",
          message: "testvoice: voice/testvoice/callouts.json changed since catalog/testvoice.json was packed",
          fix: `version 1.2.3 is released: bump \`version\` in src/build/voice-packs.mjs, ${REPACK}, and ${COMMIT_BOTH}`,
        },
      ]);
    });

    it("names a script that was added or removed", () => {
      const { roots, voiceDir } = fixture();

      rmSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE));
      expect(checkPackRecords({ packs: [PACK], ...roots })[0]!.message).toBe(
        "testvoice: voice/testvoice/callouts.json was removed since catalog/testvoice.json was packed",
      );

      const clipsOnly = computePackInputs(PACK, roots);
      writePackRecord(buildPackRecord(PACK, { sha256: SHA_A, inputs: clipsOnly }), roots.recordsDir);
      writeFileSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE), SCRIPT_TEXT);
      expect(checkPackRecords({ packs: [PACK], ...roots })[0]!.message).toBe(
        "testvoice: voice/testvoice/callouts.json was added since catalog/testvoice.json was packed",
      );
    });

    it("names the manifest, the pipeline and the archive format each as its own part", () => {
      const { roots } = fixture();

      writeFileSync(path.join(roots.configsDir, "testvoice.voice.json"), JSON.stringify({ label: "Renamed" }));

      const problems = checkPackRecords({
        packs: [PACK],
        ...roots,
        pipelineIdentity: { ...PIPELINE_IDENTITY, ffmpegStatic: "9.9.9" },
        archiveFormat: { ...archiveFormatIdentity(), fflate: "0.0.1" },
      });

      expect(parts(problems)).toEqual(["inputs.pipeline", "inputs.archiveFormat", "inputs.manifest"]);
      expect(problems.map((problem) => problem.message)).toEqual([
        "testvoice: the encode pipeline (filter chain, encode args or ffmpeg-static version) changed since catalog/testvoice.json was packed",
        "testvoice: the archive format (fflate version or zip entry options) changed since catalog/testvoice.json was packed",
        "testvoice: voice-pack.json (the pack's version, label or author, or a voice's label) changed since catalog/testvoice.json was packed",
      ]);
      // One fix, three times — `formatPackRecordProblems` prints it once.
      expect(new Set(problems.map((problem) => problem.fix)).size).toBe(1);
    });

    it("names a voice that joined or left the pack", () => {
      const { roots, inputs } = fixture();

      mkdirSync(path.join(roots.srcRoot, "second", "flags"), { recursive: true });
      writeFileSync(path.join(roots.srcRoot, "second", "flags", "blue.mp3"), "blue");
      writeFileSync(path.join(roots.configsDir, "second.voice.json"), JSON.stringify({ label: "Second" }));

      const twoVoices = { ...PACK, voices: ["testvoice", "second"] };
      const joined = checkPackRecords({ packs: [twoVoices], ...roots });

      expect(parts(joined)).toEqual(["inputs.manifest", "voices.second"]);
      expect(joined[1]!.message).toBe('testvoice: voice "second" is in the pack but not in the record');

      const both = computePackInputs(twoVoices, roots);
      writePackRecord(buildPackRecord(twoVoices, { sha256: SHA_A, inputs: both }), roots.recordsDir);
      const left = checkPackRecords({ packs: [PACK], ...roots });

      expect(parts(left)).toEqual(["inputs.manifest", "voices.second"]);
      expect(left[1]!.message).toBe('testvoice: voice "second" is in the record but not in the pack');
      expect(inputs.voices.second).toBeUndefined();
    });

    it("fails a voice whose source tree is gone, with the fix, rather than throwing", () => {
      const { roots } = fixture();

      rmSync(roots.srcRoot, { recursive: true });

      const problems = checkPackRecords({ packs: [PACK], ...roots });

      expect(parts(problems)).toEqual(["inputs"]);
      expect(problems[0]!.message).toMatch(/voice "testvoice" has no clips at/);
    });
  });

  describe("rule 4 — a released version is frozen", () => {
    it("passes a record sealed at the current version with the current sha256", () => {
      const { roots, writeRecord } = fixture();

      writeRecord({ released: { version: "1.2.3", sha256: SHA_A } });

      expect(checkPackRecords({ packs: [PACK], ...roots })).toEqual([]);
    });

    it("passes a version above the released one — the next pack, not yet released", () => {
      const { roots, writeRecord } = fixture();

      writeRecord({ released: { version: "1.2.2", sha256: SHA_B } });

      expect(checkPackRecords({ packs: [PACK], ...roots })).toEqual([]);
    });

    it("fails a version below the released one, by semver precedence", () => {
      const { roots, writeRecord } = fixture();

      // 1.10.0 is above 1.2.3 under semver, below it as a string.
      writeRecord({ released: { version: "1.10.0", sha256: SHA_B } });

      const problems = checkPackRecords({ packs: [PACK], ...roots });

      expect(parts(problems)).toEqual(["released"]);
      expect(problems[0]!.message).toBe(
        "testvoice: version 1.2.3 is below the released 1.10.0 (pack-records/testvoice.json)",
      );
      expect(problems[0]!.fix).toBe(
        "a published version is bumped, never rolled back: set `version` in src/build/voice-packs.mjs to 1.10.0 or above",
      );
    });

    it("fails a changed sha256 under the released version — entry and record agreeing with each other is not enough", () => {
      const { roots, writeRecord, writeEntry } = fixture();

      writeRecord({ sha256: SHA_B, released: { version: "1.2.3", sha256: SHA_A } });
      writeEntry(SHA_B);

      const problems = checkPackRecords({ packs: [PACK], ...roots });

      expect(parts(problems)).toEqual(["released"]);
      expect(problems[0]!.message).toBe(
        `testvoice: version 1.2.3 is released with sha256 ${SHA_A}, but pack-records/testvoice.json now carries ${SHA_B}`,
      );
      expect(problems[0]!.fix).toBe(
        `a published archive never changes under its version: bump \`version\` in src/build/voice-packs.mjs, ${REPACK} and ${COMMIT_BOTH}`,
      );
    });

    it("fails a released version that is not a semver version", () => {
      const { roots, writeRecord } = fixture();

      writeRecord({ released: { version: "latest", sha256: SHA_A } });

      const problems = checkPackRecords({ packs: [PACK], ...roots });

      expect(parts(problems)).toEqual(["released"]);
      expect(problems[0]!.message).toMatch(/released version "latest" that is not a semver version/);
    });
  });

  it("reports every pack, in order, with stray records last", () => {
    const { roots, inputs } = fixture();
    const other = { ...PACK, id: "othervoice" };

    writePackRecord(buildPackRecord({ ...PACK, id: "stray" }, { sha256: SHA_A, inputs }), roots.recordsDir);

    const problems = checkPackRecords({ packs: [PACK, other], ...roots });

    expect(problems.map((problem) => [problem.pack, problem.part])).toEqual([
      ["othervoice", "record"],
      ["stray", "registry"],
    ]);
  });
});

describe("formatPackRecordProblems", () => {
  it("prints every message and each pack's fix once", () => {
    const { roots, voiceDir } = fixture();

    writeFileSync(path.join(voiceDir, "numbers", "1.mp3"), "ONE");
    writeFileSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE), "{}");

    const problems = checkPackRecords({ packs: [PACK], ...roots });

    expect(problems).toHaveLength(2);
    expect(formatPackRecordProblems(problems)).toBe(
      [
        "  testvoice: the clips under voice/testvoice changed (2 clips as recorded, with different bytes or paths)",
        "  testvoice: voice/testvoice/callouts.json changed since catalog/testvoice.json was packed",
        `  fix: version 1.2.3 is not released yet: ${REPACK}, and ${COMMIT_BOTH}`,
      ].join("\n"),
    );
    expect(formatPackRecordProblems([])).toBe("");
  });
});

describe("sealPackRecords", () => {
  it("seals a clean, unsealed record at its version and sha256, released last in the file", () => {
    const { roots, inputs, recordBytes } = fixture();

    const result = sealPackRecords({ packs: [PACK], ...roots });
    const file = packRecordPath("testvoice", roots.recordsDir);

    expect(result).toEqual({
      sealed: [{ id: "testvoice", version: "1.2.3", sha256: SHA_A, path: file }],
      written: [file],
    });
    expect(recordBytes()).toBe(
      serializePackRecord(
        buildPackRecord(PACK, { sha256: SHA_A, inputs, released: { version: "1.2.3", sha256: SHA_A } }),
      ),
    );
    expect(checkPackRecords({ packs: [PACK], ...roots })).toEqual([]);
  });

  it("leaves a record already sealed at this version byte-untouched", () => {
    const { roots, writeRecord, recordBytes } = fixture();

    writeRecord({ released: { version: "1.2.3", sha256: SHA_A } });

    const before = recordBytes();

    expect(sealPackRecords({ packs: [PACK], ...roots })).toEqual({ sealed: [], written: [] });
    expect(recordBytes()).toBe(before);
  });

  it("re-seals a record sealed at an earlier version", () => {
    const { roots, writeRecord } = fixture();

    writeRecord({ released: { version: "1.2.2", sha256: SHA_B } });

    const result = sealPackRecords({ packs: [PACK], ...roots });

    expect(result.sealed.map((seal) => seal.version)).toEqual(["1.2.3"]);
    expect(readPackRecord("testvoice", roots.recordsDir)!.released).toEqual({ version: "1.2.3", sha256: SHA_A });
  });

  it("reports what it would seal and writes nothing on a dry run", () => {
    const { roots, recordBytes } = fixture();
    const before = recordBytes();

    const result = sealPackRecords({ packs: [PACK], ...roots, dryRun: true });

    expect(result.sealed).toEqual([
      { id: "testvoice", version: "1.2.3", sha256: SHA_A, path: packRecordPath("testvoice", roots.recordsDir) },
    ]);
    expect(result.written).toEqual([]);
    expect(recordBytes()).toBe(before);
  });

  it("refuses to seal while any rule fails, naming the problems and writing nothing", () => {
    const { roots, voiceDir, recordBytes } = fixture();
    const before = recordBytes();

    writeFileSync(path.join(voiceDir, CALLOUT_SCRIPT_FILE), "{}");

    let caught: unknown;

    try {
      sealPackRecords({ packs: [PACK], ...roots });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /^voice-pack records are not clean, so nothing was sealed:\n {2}testvoice: voice\/testvoice\/callouts\.json changed/,
    );
    expect((caught as Error & { problems: PackRecordProblem[] }).problems.map((problem) => problem.part)).toEqual([
      "voices.testvoice.script",
    ]);
    expect(recordBytes()).toBe(before);
  });

  it("seals only the ids asked for, checks every pack regardless, and refuses an unknown id", () => {
    const { roots } = fixture();
    const other = { ...PACK, id: "othervoice" };

    writePackRecord(
      buildPackRecord(other, { sha256: SHA_A, inputs: computePackInputs(other, roots) }),
      roots.recordsDir,
    );
    writeFileSync(
      path.join(roots.catalogDir, "othervoice.json"),
      `${JSON.stringify({ id: "othervoice", version: "1.2.3", sha256: SHA_A })}\n`,
    );

    const result = sealPackRecords({ packs: [PACK, other], ids: ["othervoice"], ...roots });

    expect(result.sealed.map((seal) => seal.id)).toEqual(["othervoice"]);
    expect(readPackRecord("testvoice", roots.recordsDir)!.released).toBeUndefined();
    expect(() => sealPackRecords({ packs: [PACK, other], ids: ["nope"], ...roots })).toThrow(
      /unknown pack "nope" — known packs: testvoice, othervoice/,
    );

    // The checks cover every pack: a stale one not in `ids` still refuses the seal.
    writeFileSync(path.join(roots.srcRoot, "testvoice", "numbers", "1.mp3"), "ONE");
    expect(() => sealPackRecords({ packs: [PACK, other], ids: ["othervoice"], ...roots })).toThrow(
      /testvoice: the clips under voice\/testvoice changed/,
    );
    expect(existsSync(packRecordPath("othervoice", roots.recordsDir))).toBe(true);
  });
});
