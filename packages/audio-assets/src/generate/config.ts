import { readFileSync } from "node:fs";
import { z } from "zod";

import type { Manifest } from "./manifest.ts";

// Voice and group keys must start with a letter — they're category labels and
// never purely numeric in practice.
const kebab = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be lowercase kebab-case (a-z, 0-9, dashes)");

// Entry file names may start with a digit (e.g. "0", "42-laps-to-go"). Also
// accepts a JSON number and coerces it to its String() form so `"name": 0`
// becomes `"0"`.
const entryName = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase alphanumeric/dashes"));

// Accept either a string or a number in text-ish fields; numbers are coerced
// to their String() representation so a bare `0` in JSON still generates a
// valid TTS input ("zero"). Refuses booleans, null, arrays, objects.
const textual = z.union([z.string(), z.number()]).transform((v) => String(v));

export const VoiceSettingsSchema = z.object({
  stability: z.number().min(0).max(1),
  similarity_boost: z.number().min(0).max(1),
  style: z.number().min(0).max(1).default(0),
  speed: z.number().min(0.7).max(1.2).default(1.0),
  use_speaker_boost: z.boolean().default(true),
  // ElevenLabs accepts language_code as a top-level body field, but we group
  // it here so it rides along with stability/speed/etc. and can be set at any
  // level (config, voice, entry) — useful for per-entry overrides like
  // `"language_code": "fi"` on a Finnish-name entry. It's extracted at
  // request time and sent as a top-level body field per the API contract.
  language_code: z.string().optional(),
});

export const PronunciationDictionaryLocatorSchema = z.object({
  pronunciation_dictionary_id: z.string().min(1),
  version_id: z.string().min(1),
});

export const ApplyTextNormalizationSchema = z.enum(["auto", "on", "off"]);

export const VoiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  // Optional per-voice override. Any subset of VoiceSettings is valid;
  // declared fields shallow-merge on top of the top-level `voice_settings`.
  voice_settings: VoiceSettingsSchema.partial().optional(),
  // Only meaningful for voices that have both a Professional Voice Clone (PVC)
  // and an Instant Voice Clone (IVC). Forces the IVC model when true.
  use_pvc_as_ivc: z.boolean().optional(),
});

export const EntrySchema = z.object({
  name: entryName,
  text: textual.pipe(z.string().min(1)),
  // Deterministic seed for the ElevenLabs request. Same seed + same voice +
  // same text + same settings = byte-identical audio. Defaults to 1 if omitted.
  seed: z.number().int().min(0).max(4_294_967_295).default(1),
  // Context to improve prosody on line boundaries. ElevenLabs uses these as
  // "what came before / after this clip" hints without speaking them.
  previous_text: textual.optional(),
  next_text: textual.optional(),
  // Request IDs of previously-generated clips to improve cross-line continuity.
  // Each element is either a `<group>/<entry-name>` reference (resolved at
  // generate-time against `generate.manifest.json` for the current voice) or a
  // raw ElevenLabs request-id string. The `/` is the disambiguator: any string
  // containing it is treated as a reference, anything else passes through to
  // ElevenLabs verbatim. References are resolved per-voice so the same chain
  // block produces a per-voice link without duplication. See
  // `validateReferences` and `resolveRequestIds`.
  previous_request_ids: z.array(z.string()).max(3).optional(),
  next_request_ids: z.array(z.string()).max(3).optional(),
  // Optional per-entry override. Shallow-merges on top of (config + voice)
  // settings; useful for one-off pronunciation tweaks such as setting
  // `language_code` for a single foreign-language name.
  voice_settings: VoiceSettingsSchema.partial().optional(),
});

export const ConfigSchema = z.object({
  model_id: z.string().default("eleven_multilingual_v2"),
  // Required base. Per-voice `voice_settings` are partial and merge on top.
  voice_settings: VoiceSettingsSchema,
  // All of the below are optional. When omitted we don't send the field and
  // ElevenLabs uses its own default.
  output_format: z.string().optional(),
  apply_text_normalization: ApplyTextNormalizationSchema.optional(),
  apply_language_text_normalization: z.boolean().optional(),
  enable_logging: z.boolean().optional(),
  optimize_streaming_latency: z.number().int().min(0).max(4).optional(),
  pronunciation_dictionary_locators: z.array(PronunciationDictionaryLocatorSchema).max(3).optional(),
  voices: z.record(kebab, VoiceSchema),
  groups: z.record(kebab, z.array(EntrySchema)),
});

export type Config = z.infer<typeof ConfigSchema>;
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;
export type Voice = z.infer<typeof VoiceSchema>;
export type Entry = z.infer<typeof EntrySchema>;
export type PronunciationDictionaryLocator = z.infer<typeof PronunciationDictionaryLocatorSchema>;
export type ApplyTextNormalization = z.infer<typeof ApplyTextNormalizationSchema>;

export function loadConfig(configPath: string): Config {
  const raw = readFileSync(configPath, "utf-8");
  const json = JSON.parse(raw);
  const config = ConfigSchema.parse(json);

  validateReferences(config);

  return config;
}

/**
 * Resolve the effective voice_settings stack — config defaults, then per-voice
 * override, then per-entry override. `VoiceSettings` is flat so a shallow
 * merge at each level is sufficient.
 */
export function resolveVoiceSettings(config: Config, voice: Voice, entry?: Entry): VoiceSettings {
  return {
    ...config.voice_settings,
    ...(voice.voice_settings ?? {}),
    ...(entry?.voice_settings ?? {}),
  };
}

/**
 * Reference-syntax test: any element of `previous_request_ids` /
 * `next_request_ids` containing a forward slash is a `<group>/<entry-name>`
 * reference; anything else is a raw ElevenLabs request-id (which never
 * contains `/`).
 */
export function isReference(idOrRef: string): boolean {
  return idOrRef.includes("/");
}

/**
 * Cross-entry validation: reject any `<group>/<entry-name>` reference that
 * doesn't point to a known entry in the same config (typo guard). Raw IDs
 * (no `/`) are passed through untouched. Errors list valid candidates so a
 * typo is easy to fix without grepping the file.
 *
 * Runs once per `loadConfig`, before any manifest lookup or API call, so
 * config-shape errors surface immediately and aren't hidden behind a long
 * generation run.
 */
export function validateReferences(config: Config): void {
  const candidates = new Set<string>();

  for (const [groupName, entries] of Object.entries(config.groups)) {
    for (const entry of entries) {
      candidates.add(`${groupName}/${entry.name}`);
    }
  }

  for (const [groupName, entries] of Object.entries(config.groups)) {
    for (const entry of entries) {
      for (const field of ["previous_request_ids", "next_request_ids"] as const) {
        const ids = entry[field];

        if (!ids) continue;

        for (const id of ids) {
          if (!isReference(id)) continue;

          if (!candidates.has(id)) {
            const valid = [...candidates].sort().join("\n  ");

            throw new Error(
              `Invalid ${field} reference "${id}" on entry "${groupName}/${entry.name}". ` +
                `No such entry. Valid <group>/<entry-name> candidates:\n  ${valid}`,
            );
          }
        }
      }
    }
  }
}

/**
 * Resolve `<group>/<entry-name>` references in a request-id list to the
 * matching `requestId` from `generate.manifest.json` for the given voice.
 * Raw IDs (no `/`) pass through unchanged.
 *
 * Resolution is per-voice: the same reference produces `luca`'s requestId
 * for voice `luca`, `titan`'s requestId for voice `titan`. The dependency
 * must already exist in the manifest (run `--voice <v> --group <dep-group>`
 * first, or order dependencies before dependents in the config so a single
 * full run completes them in the right order).
 *
 * Returns `undefined` when given `undefined` so callers can still drop the
 * field from the request body when no chain context is configured.
 */
export function resolveRequestIds(
  ids: string[] | undefined,
  voiceName: string,
  manifest: Manifest,
): string[] | undefined {
  if (!ids) return undefined;

  return ids.map((id) => {
    if (!isReference(id)) return id;

    const key = `voice/${voiceName}/${id}.mp3`;
    const target = manifest.entries[key];

    if (!target) {
      throw new Error(
        `Reference "${id}" for voice "${voiceName}" has no matching entry in generate.manifest.json ` +
          `(looked up "${key}"). Generate the dependency first, e.g. ` +
          `\`pnpm --filter @iracedeck/audio-assets generate --voice ${voiceName} --group ${id.split("/")[0]}\`.`,
      );
    }

    if (!target.requestId) {
      throw new Error(
        `Reference "${id}" for voice "${voiceName}" resolved to manifest entry "${key}" but it has no ` +
          `requestId (likely generated before request-id capture, or the provider didn't return one). ` +
          `Re-cut the dependency with \`--voice ${voiceName} --group ${id.split("/")[0]}\` to refresh it.`,
      );
    }

    return target.requestId;
  });
}
