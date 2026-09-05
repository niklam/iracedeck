import { RESERVED_FRAME_NAME_MESSAGE } from "@iracedeck/callout-script";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildEntryLookup,
  buildEntryOptions,
  detectReferenceCycles,
  entryHash,
  EntrySchema,
  isReference,
  loadVoiceConfigs,
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
    model_id: "eleven_test_model",
    voice_settings: { stability: 1, similarity_boost: 1 },
    groups,
    ...overrides,
  });
}

describe("VoiceConfigSchema", () => {
  it("requires id, label, model_id, voice_settings, and groups", () => {
    expect(() =>
      VoiceConfigSchema.parse({
        id: "",
        label: "x",
        model_id: "m",
        voice_settings: { stability: 1, similarity_boost: 1 },
        groups: {},
      }),
    ).toThrow();
    expect(() =>
      VoiceConfigSchema.parse({
        id: "x",
        label: "",
        model_id: "m",
        voice_settings: { stability: 1, similarity_boost: 1 },
        groups: {},
      }),
    ).toThrow();
    expect(() => VoiceConfigSchema.parse({ id: "x", label: "y", model_id: "m", groups: {} })).toThrow();
    expect(() =>
      VoiceConfigSchema.parse({
        id: "x",
        label: "y",
        model_id: "m",
        voice_settings: { stability: 1, similarity_boost: 1 },
      }),
    ).toThrow();
  });

  it("requires model_id (no implicit default)", () => {
    expect(() =>
      VoiceConfigSchema.parse({
        id: "x",
        label: "y",
        voice_settings: { stability: 1, similarity_boost: 1 },
        groups: {},
      }),
    ).toThrow();
  });

  it("accepts an explicit model_id", () => {
    const v = buildVoiceConfig({}, { model_id: "eleven_flash_v2" });

    expect(v.model_id).toBe("eleven_flash_v2");
  });

  it("rejects unknown apply_text_normalization values", () => {
    expect(() => buildVoiceConfig({}, { apply_text_normalization: "sometimes" })).toThrow();
  });
});

describe("VoiceConfigSchema callout script keys (#1064)", () => {
  const scripted = {
    scenarios: {
      "pit-crew.flag-green": {
        comment: "Green flag — the race is on.",
        test: "Start a race session and take the green.",
        sequence: ["pool:flag-green", { if: "!race", then: [{ pause: 200 }, "pool:go-go-go"] }],
      },
      "pit-crew.flag-checkered": { skip: true },
    },
    frames: {
      radio: { open: ["sfx/IRD-tick-open.mp3", { ambient: "start" }], close: [{ ambient: "stop" }] },
    },
    pools: {
      "flag-green": { group: "flags", base: "green", comment: "the green-flag takes" },
    },
  };

  it("accepts a config that authors none of them — the keys are absent from the parse", () => {
    const v = buildVoiceConfig({});

    expect("scenarios" in v).toBe(false);
    expect("frames" in v).toBe(false);
    expect("pools" in v).toBe(false);
  });

  it("accepts scenarios, frames and pools authored beside the groups", () => {
    const v = buildVoiceConfig({}, scripted);

    expect(v.scenarios).toEqual(scripted.scenarios);
    expect(v.frames).toEqual(scripted.frames);
    expect(v.pools).toEqual(scripted.pools);
  });

  it("keeps the author's scenario order — it is the reading order of the published reference", () => {
    const v = buildVoiceConfig({}, scripted);

    expect(Object.keys(v.scenarios ?? {})).toEqual(["pit-crew.flag-green", "pit-crew.flag-checkered"]);
  });

  it("rejects an unknown key inside a scenario entry, naming its path", () => {
    const result = VoiceConfigSchema.safeParse({
      id: "voice-id",
      label: "Test",
      model_id: "m",
      voice_settings: { stability: 1, similarity_boost: 1 },
      groups: {},
      scenarios: { "pit-crew.flag-green": { sequnce: ["pool:flag-green"] } },
    });

    expect(result.success).toBe(false);

    const issues = result.success ? [] : result.error.issues;

    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "unrecognized_keys",
        keys: ["sequnce"],
        path: ["scenarios", "pit-crew.flag-green"],
      }),
    );
  });

  // A misspelled top-level map — `fragements` — used to be stripped by the
  // parse and extracted as `{}`: every fragment the author wrote vanished
  // from the artifact, and the first sign was an `unknown fragment` skip in
  // the plugin log, reported against a name they could see right there in
  // the file. The config object is strict for the same reason the artifact's
  // is: the mistake is named where it was made.
  it("rejects an unknown top-level key, naming it — a misspelled `fragements` is refused, not dropped", () => {
    const result = VoiceConfigSchema.safeParse({
      id: "voice-id",
      label: "Test",
      model_id: "m",
      voice_settings: { stability: 1, similarity_boost: 1 },
      groups: {},
      fragements: { "readback-body": { sequence: ["pool:flags/green"] } },
    });

    expect(result.success).toBe(false);

    const issues = result.success ? [] : result.error.issues;

    expect(issues).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", keys: ["fragements"], path: [] }),
    );
  });

  // The nested objects are strict for the same reason: a `previous_txt` on an
  // entry or a `similarity_bost` in the voice settings used to parse clean,
  // and the author's value never reached the request.
  it("rejects an unknown key inside an entry and inside the voice settings, naming each", () => {
    const entry = VoiceConfigSchema.safeParse({
      id: "voice-id",
      label: "Test",
      model_id: "m",
      voice_settings: { stability: 1, similarity_boost: 1 },
      groups: { flags: [{ name: "green-01", text: "Green flag.", previous_txt: "…" }] },
    });

    expect(entry.success).toBe(false);
    expect(entry.success ? [] : entry.error.issues).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", keys: ["previous_txt"], path: ["groups", "flags", 0] }),
    );

    const settings = VoiceConfigSchema.safeParse({
      id: "voice-id",
      label: "Test",
      model_id: "m",
      voice_settings: { stability: 1, similarity_bost: 1 },
      groups: {},
    });

    expect(settings.success).toBe(false);
    expect(settings.success ? [] : settings.error.issues).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", keys: ["similarity_bost"], path: ["voice_settings"] }),
    );
  });

  it("rejects a scenario entry with no sequence unless it is skipped", () => {
    expect(() => buildVoiceConfig({}, { scenarios: { "pit-crew.flag-green": { comment: "no body" } } })).toThrow();
    expect(() => buildVoiceConfig({}, { scenarios: { "pit-crew.flag-green": { skip: true } } })).not.toThrow();
  });

  it("rejects a scenario id with whitespace", () => {
    expect(() => buildVoiceConfig({}, { scenarios: { "flag green": { sequence: [] } } })).toThrow();
  });

  it("rejects a defined pool whose name carries a slash — a slash always means group/base", () => {
    expect(() => buildVoiceConfig({}, { pools: { "flags/green": { group: "flags", base: "green" } } })).toThrow();
  });

  it('rejects a frame named "none" — the reserved unframed marker', () => {
    expect(() => buildVoiceConfig({}, { frames: { none: { open: [], close: [] } } })).toThrow();
  });

  it("rejects a frame name that is not kebab-case", () => {
    expect(() => buildVoiceConfig({}, { frames: { Radio: { open: [], close: [] } } })).toThrow();
  });
});

describe("loadVoiceConfigs", () => {
  const tempDirs: string[] = [];

  function configsDir(files: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ird-voice-configs-"));
    tempDirs.push(dir);

    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content), "utf-8");
    }

    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const valid = {
    id: "eleven-voice-id",
    label: "Test",
    model_id: "m",
    voice_settings: { stability: 1, similarity_boost: 1 },
    groups: {},
  };

  it("loads every <voice-id>.voice.json, keyed by the filename stem, in id order", () => {
    const dir = configsDir({ "zeta.voice.json": valid, "alpha.voice.json": valid, "notes.json": "{}" });

    expect([...loadVoiceConfigs(dir).keys()]).toEqual(["alpha", "zeta"]);
  });

  it("names the file when a config fails the schema, with the path of the problem", () => {
    const dir = configsDir({
      "alpha.voice.json": { ...valid, scenarios: { "pit-crew.flag-green": { sequnce: ["pool:flag-green"] } } },
    });

    expect(() => loadVoiceConfigs(dir)).toThrow(/alpha\.voice\.json[\s\S]*sequnce/);
  });

  it("says why a map key was refused, not only where — in the grammar's own words", () => {
    const dir = configsDir({
      "alpha.voice.json": { ...valid, frames: { none: { open: [], close: [] } } },
    });

    // The message is the grammar package's, verbatim: the config and the
    // artifact refuse the same mistake the same way.
    expect(() => loadVoiceConfigs(dir)).toThrow(`frames.none: ${RESERVED_FRAME_NAME_MESSAGE}`);
    expect(RESERVED_FRAME_NAME_MESSAGE).toMatch(/^"none" is reserved/);
  });

  it("names the file when a config is not JSON", () => {
    const dir = configsDir({ "alpha.voice.json": "{ not json" });

    expect(() => loadVoiceConfigs(dir)).toThrow(/Failed to parse alpha\.voice\.json/);
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

  it("preserves voice_settings shallow-override semantics (incl. fields with Zod defaults)", () => {
    // Per CodeRabbit feedback on #546: a per-entry override of just `speed`
    // must NOT clobber the voice's `style` (or other Zod-defaulted fields).
    // VoiceSettingsOverrideSchema avoids `.partial()` of the full schema so
    // unstated keys don't get filled with defaults that would overwrite the
    // voice-level base during merge.
    const voice = buildVoiceConfig({}, { voice_settings: { stability: 1, similarity_boost: 1, style: 0.65 } });
    const entry = EntrySchema.parse({ name: "x", text: "hi", voice_settings: { speed: 0.9 } });
    const merged = resolveVoiceSettings(voice, entry);

    expect(merged.speed).toBe(0.9);
    expect(merged.style).toBe(0.65);
    expect(merged.stability).toBe(1);
    expect(merged.similarity_boost).toBe(1);
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

describe("detectReferenceCycles", () => {
  it("accepts an acyclic reference graph", () => {
    const voice = buildVoiceConfig({
      intro: [{ name: "x", text: "intro" }],
      numbers: [
        { name: "1", text: "one", previous_request_ids: ["intro/x"] },
        { name: "2", text: "two", previous_request_ids: ["intro/x"], next_request_ids: ["numbers/1"] },
      ],
    });

    expect(() => detectReferenceCycles("default", voice)).not.toThrow();
  });

  it("rejects a direct two-node cycle and names the path", () => {
    const voice = buildVoiceConfig({
      a: [{ name: "1", text: "a", previous_request_ids: ["b/1"] }],
      b: [{ name: "1", text: "b", next_request_ids: ["a/1"] }],
    });

    expect(() => detectReferenceCycles("default", voice)).toThrow(/Reference cycle detected in voice "default"/);
    expect(() => detectReferenceCycles("default", voice)).toThrow(/a\/1 → b\/1 → a\/1/);
  });

  it("rejects a longer cycle", () => {
    const voice = buildVoiceConfig({
      a: [{ name: "1", text: "a", previous_request_ids: ["b/1"] }],
      b: [{ name: "1", text: "b", previous_request_ids: ["c/1"] }],
      c: [{ name: "1", text: "c", previous_request_ids: ["a/1"] }],
    });

    expect(() => detectReferenceCycles("default", voice)).toThrow(/Reference cycle detected/);
  });

  it("ignores raw passthrough IDs — they are not graph edges", () => {
    const voice = buildVoiceConfig({
      numbers: [{ name: "1", text: "one", previous_request_ids: ["a-raw-provider-id"] }],
    });

    expect(() => detectReferenceCycles("default", voice)).not.toThrow();
  });
});

describe("buildEntryOptions", () => {
  it("keeps request_ids as their raw reference strings (not resolved)", () => {
    const voice = buildVoiceConfig({
      intro: [{ name: "x", text: "intro" }],
      numbers: [{ name: "1", text: "one", previous_request_ids: ["intro/x"], next_request_ids: ["raw-id"] }],
    });
    const entry = buildEntryLookup(voice).get("numbers/1")!.entry;

    const options = buildEntryOptions(entry, voice);

    expect(options.previous_request_ids).toEqual(["intro/x"]);
    expect(options.next_request_ids).toEqual(["raw-id"]);
  });
});

describe("entryHash", () => {
  function hashOf(voice: VoiceConfig, ref: string): string {
    const lookup = buildEntryLookup(voice);
    const dep = lookup.get(ref);

    if (!dep) throw new Error(`test setup: no entry "${ref}"`);

    return entryHash(dep.entry, dep.groupName, voice, lookup);
  }

  it("is stable for the same config", () => {
    const voice = buildVoiceConfig({ numbers: [{ name: "1", text: "one" }] });

    expect(hashOf(voice, "numbers/1")).toBe(hashOf(voice, "numbers/1"));
  });

  it("changes when the entry's own text changes", () => {
    const a = buildVoiceConfig({ numbers: [{ name: "1", text: "one" }] });
    const b = buildVoiceConfig({ numbers: [{ name: "1", text: "uno" }] });

    expect(hashOf(a, "numbers/1")).not.toBe(hashOf(b, "numbers/1"));
  });

  it("cascades a dependency's content change into dependents, transitively", () => {
    const make = (introText: string): VoiceConfig =>
      buildVoiceConfig({
        intro: [{ name: "x", text: introText }],
        mid: [{ name: "x", text: "mid", previous_request_ids: ["intro/x"] }],
        leaf: [{ name: "x", text: "leaf", previous_request_ids: ["mid/x"] }],
      });
    const a = make("the pit speed limit is");
    const b = make("the pit lane limit is");

    // Direct dependent and the transitive (grandparent-removed) dependent
    // both shift when the root entry's config changes.
    expect(hashOf(a, "mid/x")).not.toBe(hashOf(b, "mid/x"));
    expect(hashOf(a, "leaf/x")).not.toBe(hashOf(b, "leaf/x"));
  });

  it("leaves an entry that doesn't reference the changed one untouched", () => {
    const make = (introText: string): VoiceConfig =>
      buildVoiceConfig({
        intro: [{ name: "x", text: introText }],
        numbers: [
          { name: "1", text: "one", previous_request_ids: ["intro/x"] },
          { name: "2", text: "two" },
        ],
      });
    const a = make("intro a");
    const b = make("intro b");

    expect(hashOf(a, "numbers/1")).not.toBe(hashOf(b, "numbers/1")); // references intro/x
    expect(hashOf(a, "numbers/2")).toBe(hashOf(b, "numbers/2")); // independent
  });

  it("guards against a reference cycle instead of recursing forever", () => {
    // `detectReferenceCycles` is the real gate, but `entryHash` must also
    // fail loudly rather than overflow the stack if ever handed a cycle.
    const voice = buildVoiceConfig({
      units: [{ name: "kmh", text: "kilometers per hour", previous_request_ids: ["numbers/80"] }],
      numbers: [{ name: "80", text: "eighty", next_request_ids: ["units/kmh"] }],
    });

    expect(() => hashOf(voice, "units/kmh")).toThrow(/Reference cycle reached/);
  });
});
