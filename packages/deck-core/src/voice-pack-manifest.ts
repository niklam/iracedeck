import { valid as semverValid } from "semver";
import { z } from "zod";

/**
 * Pack and voice ids share the audio-assets kebab-case rule, so a voice id in a
 * pack is spelled exactly as it is in `configs/<voice-id>.voice.json` and in the
 * `voice/<id>/…` clip paths it produces.
 */
const packId = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be lowercase kebab-case (a-z, 0-9, dashes)");

export const VoicePackManifestSchema = z.object({
  // A literal, not a minimum: an unknown schema means a pack built by a newer
  // toolchain, and guessing at its shape is worse than declining to load it.
  schema: z.literal(1),
  id: packId,
  label: z.string().min(1),
  version: z.string().refine((v) => semverValid(v) !== null, "must be a valid semver version"),
  author: z.string().min(1).optional(),
  voices: z.array(packId).min(1),
  // Reserved for #1033 (per-entry skip). Parsed and carried so the published
  // pack format is stable before any pack ships; nothing consumes it yet.
  skipped: z.array(z.string()).optional(),
});

export type VoicePackManifest = z.infer<typeof VoicePackManifestSchema>;

export type ParseVoicePackManifestResult = { ok: true; manifest: VoicePackManifest } | { ok: false; reason: string };

/**
 * Parse a pack's `voice-pack.json`.
 *
 * Never throws. This directory is user-writable by design — a hand-placed pack
 * is a first-class install path — so a malformed manifest is a reportable
 * problem with that one pack, never a plugin-startup failure. The reason names
 * the offending field so a sideloader can fix it without guessing.
 */
export function parseVoicePackManifest(raw: string): ParseVoicePackManifestResult {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = VoicePackManifestSchema.safeParse(json);

  if (!parsed.success) {
    const first = parsed.error.issues[0];

    return {
      ok: false,
      reason: first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "invalid shape",
    };
  }

  return { ok: true, manifest: parsed.data };
}
