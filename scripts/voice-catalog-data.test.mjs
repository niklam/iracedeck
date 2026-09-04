import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import url from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildVoiceCatalogData, serializeVoiceCatalogData, VOICE_CATALOG_ENTRIES_DIR } from "./lib/voice-catalog-data.mjs";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ird-voice-catalog-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A complete, schema-valid catalog entry — override individual fields per test. */
function validEntry(overrides = {}) {
  return {
    id: "luca",
    label: "Luca",
    version: "1.2.0",
    description: "Calm, understated. Fewer words.",
    voices: [{ id: "luca", label: "Luca" }],
    bytes: 13107200,
    sha256: "a".repeat(64),
    url: "https://github.com/niklam/iracedeck/releases/download/voices-luca-1.2.0/luca-1.2.0.zip",
    minPluginVersion: "3.2.0",
    ...overrides,
  };
}

function writeEntry(id, entry) {
  writeFileSync(path.join(root, `${id}.json`), `${JSON.stringify(entry, null, 2)}\n`, "utf-8");
}

describe("buildVoiceCatalogData", () => {
  it("throws naming the file and the field for a malformed entry", () => {
    // "bytes" must be a positive integer — write a negative one.
    writeEntry("broken-pack", validEntry({ id: "broken-pack", bytes: -1 }));

    expect(() => buildVoiceCatalogData(root)).toThrow(/broken-pack\.json/);
    expect(() => buildVoiceCatalogData(root)).toThrow(/bytes/);
  });

  it("throws naming the file for an entry that is not valid JSON", () => {
    writeFileSync(path.join(root, "not-json.json"), "{ this is not json", "utf-8");

    expect(() => buildVoiceCatalogData(root)).toThrow(/not-json\.json/);
  });

  it("throws when an entry's id does not match its file name", () => {
    writeEntry("luca", validEntry({ id: "not-luca" }));

    expect(() => buildVoiceCatalogData(root)).toThrow(/luca\.json/);
    expect(() => buildVoiceCatalogData(root)).toThrow(/not-luca/);
  });

  it("assembles a valid document from valid entries, sorted by pack id", () => {
    writeEntry("zed", validEntry({ id: "zed", label: "Zed", voices: [{ id: "zed", label: "Zed" }] }));
    writeEntry("ana", validEntry({ id: "ana", label: "Ana", voices: [{ id: "ana", label: "Ana" }] }));

    const data = buildVoiceCatalogData(root);

    expect(data.schema).toBe(1);
    expect(data.packs.map((p) => p.id)).toEqual(["ana", "zed"]);
  });

  it("is not a filter — an entry the parser would accept passes through unchanged", () => {
    const entry = validEntry();
    writeEntry("luca", entry);

    const data = buildVoiceCatalogData(root);

    expect(data.packs).toEqual([entry]);
  });

  it("drops the optional fields cleanly when an entry omits them", () => {
    const entry = validEntry();
    delete entry.description;
    delete entry.minPluginVersion;
    writeEntry("luca", entry);

    const data = buildVoiceCatalogData(root);

    expect(data.packs[0]).not.toHaveProperty("description");
    expect(data.packs[0]).not.toHaveProperty("minPluginVersion");
  });

  it("returns an empty catalog when the entries directory does not exist", () => {
    const missing = path.join(root, "does-not-exist");

    expect(existsSync(missing)).toBe(false);
    expect(buildVoiceCatalogData(missing)).toEqual({ schema: 1, packs: [] });
  });

  it("returns an empty catalog when the entries directory is empty", () => {
    expect(buildVoiceCatalogData(root)).toEqual({ schema: 1, packs: [] });
  });

  it("ignores non-JSON files in the entries directory", () => {
    writeEntry("luca", validEntry());
    writeFileSync(path.join(root, "README.md"), "not a catalog entry\n", "utf-8");

    const data = buildVoiceCatalogData(root);

    expect(data.packs).toHaveLength(1);
  });

  it("round-trips: building the same directory twice produces byte-identical output", () => {
    writeEntry("zed", validEntry({ id: "zed", label: "Zed", voices: [{ id: "zed", label: "Zed" }] }));
    writeEntry("ana", validEntry({ id: "ana", label: "Ana", voices: [{ id: "ana", label: "Ana" }] }));

    const first = serializeVoiceCatalogData(buildVoiceCatalogData(root));
    const second = serializeVoiceCatalogData(buildVoiceCatalogData(root));

    expect(first).toBe(second);
  });

  // The "freshness" check for a directory nobody controls in this test file:
  // whatever is actually committed at packages/audio-assets/catalog must build
  // cleanly right now. This deliberately does NOT assert anything about WHICH
  // packs exist — issue #1100's other agents are adding the directory and its
  // first entry in parallel, and this suite must pass whether that has
  // happened yet or not.
  it("builds the real committed catalog directory without throwing, whatever it currently holds", () => {
    const realEntriesDir = path.join(repoRoot, VOICE_CATALOG_ENTRIES_DIR);

    if (!existsSync(realEntriesDir)) {
      // No pack has published yet — a valid state, nothing further to assert.
      return;
    }

    const data = buildVoiceCatalogData(realEntriesDir);
    const committedFiles = readdirSync(realEntriesDir).filter((name) => name.endsWith(".json"));

    expect(data.schema).toBe(1);
    expect(data.packs).toHaveLength(committedFiles.length);
  });
});

describe("serializeVoiceCatalogData", () => {
  it("ends with a trailing newline", () => {
    expect(serializeVoiceCatalogData({ schema: 1, packs: [] })).toMatch(/\n$/);
  });
});
