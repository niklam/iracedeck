import { readFileSync } from "node:fs";
import { z } from "zod";

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
  // Each generation's request ID is captured in the manifest so you can paste
  // it into another entry's `previous_request_ids`.
  previous_request_ids: z.array(z.string()).max(3).optional(),
  next_request_ids: z.array(z.string()).max(3).optional(),
});

export const ConfigSchema = z.object({
  model_id: z.string().default("eleven_multilingual_v2"),
  // Required base. Per-voice `voice_settings` are partial and merge on top.
  voice_settings: VoiceSettingsSchema,
  // All of the below are optional. When omitted we don't send the field and
  // ElevenLabs uses its own default.
  output_format: z.string().optional(),
  language_code: z.string().optional(),
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

  return ConfigSchema.parse(json);
}

/**
 * Resolve the effective voice_settings for a voice — the top-level defaults
 * with any voice-level override shallow-merged on top. `VoiceSettings` is
 * flat, so shallow merge is sufficient.
 */
export function resolveVoiceSettings(config: Config, voice: Voice): VoiceSettings {
  return { ...config.voice_settings, ...(voice.voice_settings ?? {}) };
}
