import { describe, expect, it } from "vitest";

import { type Config, ConfigSchema, isReference, resolveRequestIds, validateReferences } from "./config.ts";
import type { Manifest } from "./manifest.ts";

function buildConfig(groups: Record<string, Array<Record<string, unknown>>>): Config {
  return ConfigSchema.parse({
    voice_settings: { stability: 1, similarity_boost: 1 },
    voices: { luca: { id: "voice-luca-id", label: "Luca" }, titan: { id: "voice-titan-id", label: "Titan" } },
    groups,
  });
}

describe("isReference", () => {
  it("treats strings containing a forward slash as references", () => {
    expect(isReference("acknowledgment/got-it")).toBe(true);
  });

  it("treats raw alphanumeric IDs as non-references", () => {
    expect(isReference("a0JzxtNayCcJBgIpywzF")).toBe(false);
  });

  it("treats empty strings as non-references", () => {
    expect(isReference("")).toBe(false);
  });
});

describe("validateReferences", () => {
  it("accepts a valid <group>/<entry-name> reference", () => {
    const config = buildConfig({
      acknowledgment: [{ name: "got-it", text: "Got it." }],
      numbers: [{ name: "1", text: "one", previous_request_ids: ["acknowledgment/got-it"] }],
    });

    expect(() => validateReferences(config)).not.toThrow();
  });

  it("accepts raw request-id strings without a slash", () => {
    const config = buildConfig({
      numbers: [{ name: "1", text: "one", previous_request_ids: ["a0JzxtNayCcJBgIpywzF"] }],
    });

    expect(() => validateReferences(config)).not.toThrow();
  });

  it("rejects an unknown reference and lists valid candidates", () => {
    const config = buildConfig({
      acknowledgment: [{ name: "got-it", text: "Got it." }],
      numbers: [{ name: "1", text: "one", previous_request_ids: ["acknowledgment/typo"] }],
    });

    expect(() => validateReferences(config)).toThrow(/Invalid previous_request_ids reference "acknowledgment\/typo"/);
    expect(() => validateReferences(config)).toThrow(/acknowledgment\/got-it/);
    expect(() => validateReferences(config)).toThrow(/numbers\/1/);
  });

  it("validates next_request_ids the same way", () => {
    const config = buildConfig({
      numbers: [{ name: "1", text: "one", next_request_ids: ["acknowledgment/got-it"] }],
    });

    expect(() => validateReferences(config)).toThrow(/Invalid next_request_ids reference "acknowledgment\/got-it"/);
  });

  it("mentions the offending entry in the error message", () => {
    const config = buildConfig({
      numbers: [{ name: "5", text: "five", previous_request_ids: ["nope/missing"] }],
    });

    expect(() => validateReferences(config)).toThrow(/on entry "numbers\/5"/);
  });

  it("is a no-op when no chain context is configured", () => {
    const config = buildConfig({
      acknowledgment: [{ name: "got-it", text: "Got it." }],
    });

    expect(() => validateReferences(config)).not.toThrow();
  });
});

const manifest: Manifest = {
  version: 1,
  entries: {
    "voice/luca/acknowledgment/got-it.mp3": {
      hash: "h1",
      voiceId: "voice-luca-id",
      model: "eleven_multilingual_v2",
      textPreview: "Got it.",
      generatedAt: "2026-04-25T00:00:00.000Z",
      requestId: "luca-got-it-request-id",
    },
    "voice/titan/acknowledgment/got-it.mp3": {
      hash: "h2",
      voiceId: "voice-titan-id",
      model: "eleven_multilingual_v2",
      textPreview: "Got it.",
      generatedAt: "2026-04-25T00:00:00.000Z",
      requestId: "titan-got-it-request-id",
    },
    "voice/luca/openers/null-id.mp3": {
      hash: "h3",
      voiceId: "voice-luca-id",
      model: "eleven_multilingual_v2",
      textPreview: "…",
      generatedAt: "2026-04-25T00:00:00.000Z",
      requestId: null,
    },
  },
};

describe("resolveRequestIds", () => {
  it("returns undefined when given undefined", () => {
    expect(resolveRequestIds(undefined, "luca", manifest)).toBeUndefined();
  });

  it("resolves a reference to the manifest requestId for the given voice", () => {
    expect(resolveRequestIds(["acknowledgment/got-it"], "luca", manifest)).toEqual(["luca-got-it-request-id"]);
  });

  it("resolves the same reference to a different ID for a different voice", () => {
    expect(resolveRequestIds(["acknowledgment/got-it"], "titan", manifest)).toEqual(["titan-got-it-request-id"]);
  });

  it("passes raw IDs through unchanged", () => {
    expect(resolveRequestIds(["a0JzxtNayCcJBgIpywzF"], "luca", manifest)).toEqual(["a0JzxtNayCcJBgIpywzF"]);
  });

  it("preserves order with mixed references and raw IDs", () => {
    expect(resolveRequestIds(["raw-one", "acknowledgment/got-it", "raw-two"], "luca", manifest)).toEqual([
      "raw-one",
      "luca-got-it-request-id",
      "raw-two",
    ]);
  });

  it("throws when the manifest has no matching entry", () => {
    expect(() => resolveRequestIds(["acknowledgment/missing"], "luca", manifest)).toThrow(
      /Reference "acknowledgment\/missing" for voice "luca" has no matching entry/,
    );
  });

  it("includes the lookup path and a suggested scoped command in the missing-entry error", () => {
    expect(() => resolveRequestIds(["acknowledgment/missing"], "luca", manifest)).toThrow(
      /voice\/luca\/acknowledgment\/missing\.mp3/,
    );
    expect(() => resolveRequestIds(["acknowledgment/missing"], "luca", manifest)).toThrow(
      /--voice luca --group acknowledgment/,
    );
  });

  it("throws when the manifest entry exists but requestId is null", () => {
    expect(() => resolveRequestIds(["openers/null-id"], "luca", manifest)).toThrow(
      /resolved to manifest entry .* but it has no requestId/,
    );
  });
});
