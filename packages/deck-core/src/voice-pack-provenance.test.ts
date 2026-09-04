import { describe, expect, it } from "vitest";

import {
  parseVoicePackProvenance,
  serializeVoicePackProvenance,
  type VoicePackProvenance,
} from "./voice-pack-provenance.js";

const SHA = "b".repeat(64);

const record: VoicePackProvenance = {
  schema: 1,
  source: "catalog",
  id: "luca",
  version: "1.2.0",
  sha256: SHA,
  url: "https://example.com/luca-1.2.0.zip",
  installedAt: "2026-09-02T09:14:03.221Z",
};

describe("serializeVoicePackProvenance", () => {
  it("round-trips through the parser", () => {
    expect(parseVoicePackProvenance(serializeVoicePackProvenance(record))).toEqual(record);
  });

  it("sorts keys and ends with a newline", () => {
    const text = serializeVoicePackProvenance(record);

    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "id",
      "installedAt",
      "schema",
      "sha256",
      "source",
      "url",
      "version",
    ]);
  });
});

describe("parseVoicePackProvenance", () => {
  it("reads a bundled seed, which carries no url", () => {
    const seed = { ...record, source: "bundled-seed" as const, url: undefined };
    const parsed = parseVoicePackProvenance(serializeVoicePackProvenance(seed));

    expect(parsed?.source).toBe("bundled-seed");
    expect(parsed?.url).toBeUndefined();
  });

  it("tolerates a leading BOM from a hand-edit on Windows", () => {
    const BOM = String.fromCharCode(0xfeff);

    expect(parseVoicePackProvenance(`${BOM}${serializeVoicePackProvenance(record)}`)).toEqual(record);
  });

  it.each([
    ["text that is not JSON", "{ not json"],
    ["an empty file", ""],
    ["a JSON array", "[]"],
    ["an unknown schema version", JSON.stringify({ ...record, schema: 2 })],
    ["a missing digest", JSON.stringify({ ...record, sha256: undefined })],
    ["an uppercase digest", JSON.stringify({ ...record, sha256: "C".repeat(64) })],
    ["a missing installedAt", JSON.stringify({ ...record, installedAt: undefined })],
  ])("returns undefined for %s", (_label, raw) => {
    expect(parseVoicePackProvenance(raw)).toBeUndefined();
  });

  // A pack must not be able to claim it came from the catalog, and the source
  // enum is where that claim would be spelled. "sideload" is not a value on
  // purpose: absence of the file IS the sideloaded case.
  it("refuses a source it does not define", () => {
    expect(parseVoicePackProvenance(JSON.stringify({ ...record, source: "sideload" }))).toBeUndefined();
  });
});
