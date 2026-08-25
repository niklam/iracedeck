import { describe, expect, it } from "vitest";

import { parseVoicePackManifest } from "./voice-pack-manifest.js";

const valid = JSON.stringify({
  schema: 1,
  id: "luca",
  label: "Luca",
  version: "1.2.0",
  author: "iRaceDeck",
  voices: ["luca"],
});

describe("parseVoicePackManifest", () => {
  it("accepts a well-formed manifest", () => {
    const result = parseVoicePackManifest(valid);

    expect(result).toEqual({
      ok: true,
      manifest: { schema: 1, id: "luca", label: "Luca", version: "1.2.0", author: "iRaceDeck", voices: ["luca"] },
    });
  });

  it("accepts a pack declaring several voices", () => {
    const raw = JSON.stringify({ schema: 1, id: "duo", label: "Duo", version: "1.0.0", voices: ["a", "b"] });
    const result = parseVoicePackManifest(raw);

    expect(result.ok && result.manifest.voices).toEqual(["a", "b"]);
  });

  it("keeps a skipped list without interpreting it", () => {
    const raw = JSON.stringify({
      schema: 1,
      id: "luca",
      label: "Luca",
      version: "1.0.0",
      voices: ["luca"],
      skipped: ["voice/luca/openers/hi.mp3"],
    });
    const result = parseVoicePackManifest(raw);

    expect(result.ok && result.manifest.skipped).toEqual(["voice/luca/openers/hi.mp3"]);
  });

  it("accepts a prerelease version", () => {
    const raw = JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0-rc.1", voices: ["a"] });

    expect(parseVoicePackManifest(raw).ok).toBe(true);
  });

  it.each([
    ["not json at all", "{nope"],
    ["a future schema version", JSON.stringify({ schema: 2, id: "a", label: "A", version: "1.0.0", voices: ["a"] })],
    ["a missing schema", JSON.stringify({ id: "a", label: "A", version: "1.0.0", voices: ["a"] })],
    ["a non-semver version", JSON.stringify({ schema: 1, id: "a", label: "A", version: "one", voices: ["a"] })],
    [
      "an id that is not kebab-case",
      JSON.stringify({ schema: 1, id: "Luca!", label: "A", version: "1.0.0", voices: ["a"] }),
    ],
    ["an empty label", JSON.stringify({ schema: 1, id: "a", label: "", version: "1.0.0", voices: ["a"] })],
    ["an empty voices list", JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0", voices: [] })],
    [
      "a voice id that is not kebab-case",
      JSON.stringify({ schema: 1, id: "a", label: "A", version: "1.0.0", voices: ["Nope"] }),
    ],
  ])("rejects %s", (_label, raw) => {
    const result = parseVoicePackManifest(raw);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason.length).toBeGreaterThan(0);
  });

  it("names the offending field in the reason", () => {
    const raw = JSON.stringify({ schema: 1, id: "a", label: "A", version: "one", voices: ["a"] });
    const result = parseVoicePackManifest(raw);

    expect(result.ok === false && result.reason).toContain("version");
  });
});
