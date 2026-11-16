import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * The provider request ids a take was really conditioned on: the resolved
 * `previous_request_ids` / `next_request_ids` its request sent, in order
 * (#1643). Not the same as what its references resolve to today: a seed bump
 * re-cuts a dependency while its dependents stay cached, still conditioned on
 * the superseded take.
 */
export const ConditioningSchema = z.object({
  previous: z.array(z.string()).optional(),
  next: z.array(z.string()).optional(),
});

export type Conditioning = z.infer<typeof ConditioningSchema>;

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
  // Written on every cut whose request carried request ids, carried on a
  // copy; absent on every row written before #1643's second read and on an
  // `--import`ed one, which a copy decision then reads the old way.
  conditionedOn: ConditioningSchema.optional(),
});

export const ManifestSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), ManifestEntrySchema),
});

export type Manifest = z.infer<typeof ManifestSchema>;

/** `voice/<voice-id>/<group>/<name>.mp3`: where the generator writes a clip, and its key in the manifest. */
export function clipRelPath(voiceId: string, groupName: string, entryName: string): string {
  return path.posix.join("voice", voiceId, groupName, `${entryName}.mp3`);
}

export function loadManifest(manifestPath: string): Manifest {
  if (!existsSync(manifestPath)) return { version: 1, entries: {} };

  const raw = readFileSync(manifestPath, "utf-8");
  const json = JSON.parse(raw);

  return ManifestSchema.parse(json);
}

let saveCounter = 0;

/**
 * Write the manifest whole or not at all (#1643): the JSON goes to a temp file
 * beside it, which is renamed over the manifest only once fully written. A
 * write that fails part-way (ENOSPC) leaves the previous manifest intact,
 * never truncated, so the next run can still load it, and the temp file is
 * removed. Writing the live path directly would truncate it on open, and a
 * retry would truncate it again.
 */
export function saveManifest(manifestPath: string, manifest: Manifest): void {
  const tempPath = `${manifestPath}.${process.pid}.${saveCounter++}.tmp`;

  try {
    writeFileSync(tempPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    renameSync(tempPath, manifestPath);
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}
