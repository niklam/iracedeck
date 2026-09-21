import { VOICE_ID_SEPARATOR } from "@iracedeck/callout-script";
import { valid as semverValid } from "semver";
import { z } from "zod";

/**
 * Pack and voice ids share the audio-assets kebab-case rule, so a voice id in a
 * pack is spelled exactly as it is in `configs/<voice-id>.voice.json` and in the
 * `voice/<id>/…` clip paths it produces.
 *
 * The separator check comes FIRST, and is not a new rejection: kebab-case
 * already excludes `::`. It is a better reason. iRaceDeck names a voice outside
 * its pack as `<pack id>::<voice id>` (#1144), and an author who tried to
 * qualify an id by hand should be told that is why, rather than merely that
 * the id is malformed.
 */
export const packId = z
  .string()
  .refine(
    (id) => !id.includes(VOICE_ID_SEPARATOR),
    `must not contain "${VOICE_ID_SEPARATOR}" — iRaceDeck joins a pack id and a voice id with it`,
  )
  .regex(/^[a-z][a-z0-9-]*$/, "must be lowercase kebab-case (a-z, 0-9, dashes)");

/**
 * A name a user reads: the pack's, or one of its voices'.
 *
 * Bounded because it is a third party's string rendered straight into a
 * `<option>` and into the Installed Voices row. 60 characters is far more than
 * any engineer's name needs and far less than enough to break the window
 * layout; control characters are refused outright, since a newline inside a
 * dropdown entry has no meaning and one inside a list row costs a line.
 *
 * Set NOW rather than later: a bound added after packs ship rejects packs that
 * already installed, which is a migration. Loosening one never is.
 */
export const displayLabel = z
  .string()
  .min(1)
  .max(60, "must be 60 characters or fewer")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f\x7f]+$/, "must not contain control characters");

/**
 * A voice the pack provides: what it IS, and what it is CALLED.
 *
 * `id` is identity — it matches the `voice/<id>/…` clip path inside the pack,
 * and joined to the pack's id as `<pack id>::<id>` (#1144) it is what
 * `raceEngineerVoice` stores and what the default anchor compares. Unique
 * within the pack only: two packs may each declare a `matt`. `label` is
 * presentation and nothing else: no code resolves, compares or persists it.
 *
 * The pair exists because the pack already had one and its voices did not, so a
 * pack author could name their pack but not their voices — the dropdown fell
 * back to `titleCase(id)` and rendered a hyphenated id as `Aaa-testvoice`.
 */
export const voiceEntry = z.object({ id: packId, label: displayLabel });

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
  label: displayLabel,
  version: z.string().refine((v) => semverValid(v) !== null, "must be a valid semver version"),
  author: z.string().min(1).optional(),
  voices: z.array(voiceEntry).min(1),
  // No `skipped` here, deliberately. It was reserved for #1033's per-entry skip
  // when a pack meant one voice — but #1064's design has since moved skipping to
  // a `"skip": true` inside each voice's own script file, so a pack-level flat
  // list reserves a slot a newer design already fills, in a format where
  // per-voice data now has no home at this level. Nothing ever read it: the
  // scanner never put it on `InstalledVoicePack`, so removing it costs nothing.
  //
  // The asymmetry is the reason to remove it NOW rather than keep it: adding a
  // field back to an unshipped format is the same free edit as taking one out,
  // while keeping this one means carrying it forever.
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
    // A leading UTF-8 BOM is stripped before parsing: `JSON.parse` throws on it,
    // and several Windows editors write one. Hand-editing `voice-pack.json` on
    // Windows is the ADVERTISED install path for this feature, so a BOM would
    // reject a pack that is correct in every way a user can see, with "not valid
    // JSON" as the only clue. `settings-store.ts` strips one for the same reason
    // — "a BOM must not make a user's backup corrupt" — and the pack format
    // should not be stricter than the settings file about the same accident.
    json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = VoicePackManifestSchema.safeParse(json);

  if (!parsed.success) {
    const first = parsed.error.issues[0];

    // The schema literal earns its keep here or nowhere. Refusing a pack built
    // by a newer toolchain is the entire reason it is a literal rather than a
    // minimum — so the refusal has to SAY that, in a sentence a user can act on.
    // Left as Zod's own text it reads "schema: Invalid literal value, expected
    // 1", which tells somebody with a perfectly good pack nothing about needing
    // a newer iRaceDeck.
    if (first?.path.length === 1 && first.path[0] === "schema") {
      return { ok: false, reason: "built for a newer version of iRaceDeck — update the plugin to use this pack" };
    }

    return {
      ok: false,
      reason: first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "invalid shape",
    };
  }

  return { ok: true, manifest: parsed.data };
}
