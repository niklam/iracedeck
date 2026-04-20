import { readFileSync } from "node:fs";
import { z } from "zod";

const kebab = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be lowercase kebab-case (a-z, 0-9, dashes)");

export const VoiceSettingsSchema = z.object({
  stability: z.number().min(0).max(1),
  similarity_boost: z.number().min(0).max(1),
  style: z.number().min(0).max(1).default(0),
  use_speaker_boost: z.boolean().default(true),
});

export const VoiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const EntrySchema = z.object({
  name: kebab,
  text: z.string().min(1),
});

export const ConfigSchema = z.object({
  model: z.string().default("eleven_multilingual_v2"),
  voiceSettings: VoiceSettingsSchema,
  voices: z.record(kebab, VoiceSchema),
  groups: z.record(kebab, z.array(EntrySchema)),
});

export type Config = z.infer<typeof ConfigSchema>;
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;
export type Voice = z.infer<typeof VoiceSchema>;
export type Entry = z.infer<typeof EntrySchema>;

export function loadConfig(configPath: string): Config {
  const raw = readFileSync(configPath, "utf-8");
  const json = JSON.parse(raw);

  return ConfigSchema.parse(json);
}
