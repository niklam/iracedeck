import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

export const ManifestEntrySchema = z.object({
  hash: z.string(),
  voiceId: z.string(),
  model: z.string(),
  textPreview: z.string(),
  generatedAt: z.string(),
  // ElevenLabs' request-id from the response header. Null when the provider
  // didn't return one (shouldn't normally happen). Paste into another entry's
  // previous_request_ids / next_request_ids to chain prosody context.
  requestId: z.string().nullable().optional(),
});

export const ManifestSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), ManifestEntrySchema),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export function loadManifest(manifestPath: string): Manifest {
  if (!existsSync(manifestPath)) return { version: 1, entries: {} };

  const raw = readFileSync(manifestPath, "utf-8");
  const json = JSON.parse(raw);

  return ManifestSchema.parse(json);
}

export function saveManifest(manifestPath: string, manifest: Manifest): void {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}
