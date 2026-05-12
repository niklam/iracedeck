import { describe, expect, it } from "vitest";

import {
  EntrySchema,
  isReference,
  resolveRequestIds,
  resolveVoiceSettings,
  validateReferences,
  type VoiceConfig,
  VoiceConfigSchema,
} from "./config.ts";
import type { Manifest } from "./manifest.ts";

function buildVoiceConfig(
  groups: Record<string, Array<Record<string, unknown>>>,
  overrides: Partial<Record<keyof VoiceConfig, unknown>> = {},
): VoiceConfig {
  return VoiceConfigSchema.parse({
    id: "voice-id",
    label: "Test",
    voice_settings: { stability: 1, similarity_boost: 1 },
    groups,
    ...overrides,
  });
}

describe("VoiceConfigSchema", () => {
  it("requires id, label, voice_settings, and groups", () => {
    expect(() =>
      VoiceConfigSchema.parse({
        id: "",
        label: "x",
        voice_settings: { stability: 1, similarity_boost: 1 },
        groups: {},
      }),
    ).toThrow();
    expect(() =>
      VoiceConfigSchema.parse({
        id: "x",
        label: "",
        voice_settings: { stability: 1, similarity_boost: 1 },
        groups: {},
      }),
    ).toThrow();
    expect(() => VoiceConfigSchema.parse({ id: "x", label: "y", groups: {} })).toThrow();
    expect(() =>
      VoiceConfigSchema.parse({ id: "x", label: "y", voice_settings: { stability: 1, similarity_boost: 1 } }),
    ).toThrow();
  });

  it("defaults model_id when omitted", () => {
    const v = VoiceConfigSchema.parse({
      id: "x",
      label: "y",
      voice_settings: { stability: 1, similarity_boost: 1 },
      groups: {},
    });

    expect(v.model_id).toBe("eleven_multilingual_v2");
  });

  it("accepts a model_id override", () => {
    const v = buildVoiceConfig({}, { model_id: "eleven_flash_v2" });

    expect(v.model_id).toBe("eleven_flash_v2");
  });

  it("rejects unknown apply_text_normalization values", () => {
    expect(() => buildVoiceConfig({}, { apply_text_normalization: "sometimes" })).toThrow();
  });
});

describe("EntrySchema per-entry overrides", () => {
  it("accepts model_id, output_format, language flags as optional fields", () => {
    const entry = EntrySchema.parse({
      name: "x",
      text: "hi",
      model_id: "eleven_turbo_v2_5",
      output_format: "mp3_22050_32",
      apply_text_normalization: "on",
      apply_language_text_normalization: true,
      optimize_streaming_latency: 2,
      use_pvc_as_ivc: true,
    });

    expect(entry.model_id).toBe("eleven_turbo_v2_5");
    expect(entry.output_format).toBe("mp3_22050_32");
    expect(entry.apply_text_normalization).toBe("on");
    expect(entry.apply_language_text_normalization).toBe(true);
    expect(entry.optimize_streaming_latency).toBe(2);
    expect(entry.use_pvc_as_ivc).toBe(true);
  });

  it("rejects out-of-range optimize_streaming_latency", () => {
    expect(() => EntrySchema.parse({ name: "x", text: "hi", optimize_streaming_latency: 5 })).toThrow();
  });

  it("preserves voice_settings shallow-override semantics", () => {
    const entry = EntrySchema.parse({ name: "x", text: "hi", voice_settings: { speed: 0.9 } });

    // Note: VoiceSettingsSchema.partial() still applies defaults for fields
    // that have one (`style`, `use_speaker_boost`), so the parsed override
    // object isn't strictly equal to the input. The merge in
    // resolveVoiceSettings still produces the right effective settings
    // because the voice-level base is splatted in first.
    expect(entry.voice_settings?.speed).toBe(0.9);
  });
});

describe("resolveVoiceSettings", () => {
  it("returns the voice settings when entry has none", () => {
    const voice = buildVoiceConfig({});

    expect(resolveVoiceSettings(voice)).toMatchObject({ stability: 1, similarity_boost: 1, speed: 1, style: 0 });
  });

  it("shallow-merges entry overrides on top of voice settings", () => {
    const voice = buildVoiceConfig({});
    const entry = EntrySchema.parse({ name: "x", text: "hi", voice_settings: { speed: 0.9, language_code: "fi" } });
    const merged = resolveVoiceSettings(voice, entry);

    expect(merged.speed).toBe(0.9);
    expect(merged.stability).toBe(1);
    expect(merged.language_code).toBe("fi");
  });
});

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
    const voice = buildVoiceConfig({
      acknowledgment: [{ name: "got-it", text: "Got it." }],
      numbers: [{ name: "1", text: "one", previous_request_ids: ["acknowledgment/got-it"] }],
    });

    expect(() => validateReferences("default", voice)).not.toThrow();
  });

  it("accepts raw request-id strings without a slash", () => {
    const voice = buildVoiceConfig({
      numbers: [{ name: "1", text: "one", previous_request_ids: ["a0JzxtNayCcJBgIpywzF"] }],
    });

    expect(() => validateReferences("default", voice)).not.toThrow();
  });

  it("rejects an unknown reference and lists valid candidates", () => {
    const voice = buildVoiceConfig({
      acknowledgment: [{ name: "got-it", text: "Got it." }],
      numbers: [{ name: "1", text: "one", previous_request_ids: ["acknowledgment/typo"] }],
    });

    expect(() => validateReferences("default", voice)).toThrow(
      /Invalid previous_request_ids reference "acknowledgment\/typo"/,
    );
    expect(() => validateReferences("default", voice)).toThrow(/acknowledgment\/got-it/);
    expect(() => validateReferences("default", voice)).toThrow(/numbers\/1/);
  });

  it("validates next_request_ids the same way", () => {
    const voice = buildVoiceConfig({
      numbers: [{ name: "1", text: "one", next_request_ids: ["acknowledgment/got-it"] }],
    });

    expect(() => validateReferences("default", voice)).toThrow(
      /Invalid next_request_ids reference "acknowledgment\/got-it"/,
    );
  });

  it("mentions the offending entry and voice in the error message", () => {
    const voice = buildVoiceConfig({
      numbers: [{ name: "5", text: "five", previous_request_ids: ["nope/missing"] }],
    });

    expect(() => validateReferences("titan", voice)).toThrow(/on entry "numbers\/5"/);
    expect(() => validateReferences("titan", voice)).toThrow(/voice "titan"/);
  });

  it("is a no-op when no chain context is configured", () => {
    const voice = buildVoiceConfig({
      acknowledgment: [{ name: "got-it", text: "Got it." }],
    });

    expect(() => validateReferences("default", voice)).not.toThrow();
  });
});

const manifest: Manifest = {
  version: 1,
  entries: {
    "voice/default/acknowledgment/got-it.mp3": {
      hash: "h1",
      voiceId: "voice-default-id",
      model: "eleven_multilingual_v2",
      textPreview: "Got it.",
      generatedAt: "2026-04-25T00:00:00.000Z",
      requestId: "default-got-it-request-id",
    },
    "voice/titan/acknowledgment/got-it.mp3": {
      hash: "h2",
      voiceId: "voice-titan-id",
      model: "eleven_multilingual_v2",
      textPreview: "Got it.",
      generatedAt: "2026-04-25T00:00:00.000Z",
      requestId: "titan-got-it-request-id",
    },
    "voice/default/openers/null-id.mp3": {
      hash: "h3",
      voiceId: "voice-default-id",
      model: "eleven_multilingual_v2",
      textPreview: "…",
      generatedAt: "2026-04-25T00:00:00.000Z",
      requestId: null,
    },
  },
};

describe("resolveRequestIds", () => {
  it("returns undefined when given undefined", () => {
    expect(resolveRequestIds(undefined, "default", manifest)).toBeUndefined();
  });

  it("resolves a reference to the manifest requestId for the given voice", () => {
    expect(resolveRequestIds(["acknowledgment/got-it"], "default", manifest)).toEqual(["default-got-it-request-id"]);
  });

  it("resolves the same reference to a different ID for a different voice", () => {
    expect(resolveRequestIds(["acknowledgment/got-it"], "titan", manifest)).toEqual(["titan-got-it-request-id"]);
  });

  it("passes raw IDs through unchanged", () => {
    expect(resolveRequestIds(["a0JzxtNayCcJBgIpywzF"], "default", manifest)).toEqual(["a0JzxtNayCcJBgIpywzF"]);
  });

  it("preserves order with mixed references and raw IDs", () => {
    expect(resolveRequestIds(["raw-one", "acknowledgment/got-it", "raw-two"], "default", manifest)).toEqual([
      "raw-one",
      "default-got-it-request-id",
      "raw-two",
    ]);
  });

  it("throws when the manifest has no matching entry", () => {
    expect(() => resolveRequestIds(["acknowledgment/missing"], "default", manifest)).toThrow(
      /Reference "acknowledgment\/missing" for voice "default" has no matching entry/,
    );
  });

  it("includes the lookup path and a suggested scoped command in the missing-entry error", () => {
    expect(() => resolveRequestIds(["acknowledgment/missing"], "default", manifest)).toThrow(
      /voice\/default\/acknowledgment\/missing\.mp3/,
    );
    expect(() => resolveRequestIds(["acknowledgment/missing"], "default", manifest)).toThrow(
      /--voice default --group acknowledgment/,
    );
  });

  it("throws when the manifest entry exists but requestId is null", () => {
    expect(() => resolveRequestIds(["openers/null-id"], "default", manifest)).toThrow(
      /resolved to manifest entry .* but it has no requestId/,
    );
  });
});
