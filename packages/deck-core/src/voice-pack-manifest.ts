import { valid as semverValid } from "semver";
import { z } from "zod";

/**
 * Pack and voice ids share the audio-assets kebab-case rule, so a voice id in a
 * pack is spelled exactly as it is in `configs/<voice-id>.voice.json` and in the
 * `voice/<id>/…` clip paths it produces.
 */
const packId = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be lowercase kebab-case (a-z, 0-9, dashes)");

/**
 * A voice the pack provides: what it IS, and what it is CALLED.
 *
 * `id` is identity — it matches the `voice/<id>/…` clip path, it is what
 * `raceEngineerVoice` stores, what the default anchor compares, and what a
 * collision is decided on. `label` is presentation and nothing else: no code
 * resolves, compares or persists it.
 *
 * The pair exists because the pack already had one and its voices did not, so a
 * pack author could name their pack but not their voices — the dropdown fell
 * back to `titleCase(id)` and rendered a hyphenated id as `Aaa-testvoice`.
 */
const voiceEntry = z.object({ id: packId, label: z.string().min(1) });

export const VoicePackManifestSchema = z.object({
  // A literal, not a minimum: an unknown schema means a pack built by a newer
  // toolchain, and guessing at its shape is worse than declining to load it.
  //
  // Still `1` after `voices` changed shape, deliberately: a version tells apart
  // formats that coexist in the wild, and there is no version 1 in the wild —
  // no released plugin reads this file at all. Bumping would imply a
  // predecessor nobody can find, and would answer a hand-made test pack with
  // "expected 2" where staying at 1 fails on `voices.0` and names the field
  // that actually moved.
  schema: z.literal(1),
  id: packId,
  label: z.string().min(1),
  version: z.string().refine((v) => semverValid(v) !== null, "must be a valid semver version"),
  author: z.string().min(1).optional(),
  voices: z.array(voiceEntry).min(1),
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
