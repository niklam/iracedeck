/**
 * A voice's identity outside its pack folder: `<pack id>::<voice id>` (#1144).
 *
 * Inside a pack a voice is the bare id its `voice-pack.json` declares, and its
 * clips live under `voice/<voice id>/…` — that grammar is the pack author's
 * and does not change. Everywhere else — the voice list a user picks from, the
 * stored `raceEngineerVoice`, the label map, the script map, the logical clip
 * paths the engine resolves — the voice is the composite, so two packs may
 * each ship a `matt` and both play.
 *
 * Two characters, so a single colon stays available should the id grammar ever
 * widen. Both halves are lowercase kebab-case (`^[a-z][a-z0-9-]*$`, the
 * manifest and catalog schemas' rule), which is what makes the join
 * unambiguous: an id that passed that rule can never contain the separator,
 * and the schemas refuse one that does with the separator named.
 *
 * Lives here for the reason the coverage rules do: this is the one leaf every
 * consumer can reach — `deck-core`'s scanner and settings, the audio-service's
 * resolver and `audio-scenarios`' reference voice — without any of them
 * depending on each other.
 */

export const VOICE_ID_SEPARATOR = "::";

/**
 * Why an id holding {@link VOICE_ID_SEPARATOR} is refused: the one sentence
 * `deck-core`'s manifest and catalog schemas and `lint:pack` all report, ahead
 * of the kebab-case rule, so an author who qualified an id by hand is told why
 * rather than merely that the id is malformed. It follows the field it is
 * about — `id: must not contain …` in the scanner's problem row,
 * `voices[1].id "demo::matt" must not contain …` in the linter's.
 */
export const VOICE_ID_SEPARATOR_REASON = `must not contain "${VOICE_ID_SEPARATOR}" — iRaceDeck joins a pack id and a voice id with it`;

const VOICE_CLIP_PREFIX = "voice/";

/** `<packId>::<voiceId>`. Inputs are already-validated kebab-case ids. */
export function qualifiedVoiceId(packId: string, voiceId: string): string {
  return `${packId}${VOICE_ID_SEPARATOR}${voiceId}`;
}

/**
 * `{ packId, voiceId }` for a composite id; `null` for a bare id (no
 * separator) or a malformed one (an empty half, more than one separator).
 */
export function splitVoiceId(id: string): { packId: string; voiceId: string } | null {
  const parts = id.split(VOICE_ID_SEPARATOR);

  if (parts.length !== 2) return null;

  const [packId, voiceId] = parts;

  if (packId.length === 0 || voiceId.length === 0) return null;

  return { packId, voiceId };
}

/**
 * `voice/<voice>/<rest>` → `voice/<packId>::<voice>/<rest>`. A clip not under
 * `voice/<x>/` — an sfx path, or a bare voice folder with nothing after it —
 * is returned unchanged.
 */
export function qualifyClipPath(packId: string, clip: string): string {
  if (!clip.startsWith(VOICE_CLIP_PREFIX)) return clip;

  const afterPrefix = clip.slice(VOICE_CLIP_PREFIX.length);
  const slash = afterPrefix.indexOf("/");

  if (slash <= 0 || slash === afterPrefix.length - 1) return clip;

  const voice = afterPrefix.slice(0, slash);
  const rest = afterPrefix.slice(slash + 1);

  return `${VOICE_CLIP_PREFIX}${qualifiedVoiceId(packId, voice)}/${rest}`;
}

/**
 * A stored voice value → the composite id it means, given the composite ids
 * available now.
 *
 * Empty or already-composite → returned unchanged; a composite is never
 * rewritten, even one whose pack is absent, because the pack may simply not
 * have arrived yet. A bare `v` that is itself in `available` → unchanged too:
 * a bare id in the list is a real voice (the harness's source-tree voice, or
 * one a plugin bundles), not a pre-#1144 value to reinterpret, and qualifying
 * it would make that voice impossible to choose beside a pack's voice of the
 * same id. Otherwise a bare `v` → `<managedPackId>::v` when the managed pack
 * provides it, else the available composite whose voice half is `v` with the
 * alphabetically first pack id (a plain JS string sort on the PACK id, not on
 * the composite — `a` sorts before `a-b` as an id but after it as `a::…`
 * against `a-b::…`), else `v` unchanged so the caller's own fallback decides.
 *
 * Managed first, then alphabetical, is the order that decided which pack
 * claimed a voice id before #1144 for every lowercase pack folder — which is
 * every folder the installer writes — so the voice a user was hearing is the
 * voice they keep. It is not the same order in every case: that scanner sorted
 * FOLDER names case-sensitively, and a pack id is matched to its folder
 * without regard to case, so a hand-made folder with capitals (`Zeta/`) sorted
 * before `alpha/` there and after it here. Accepted: no third-party pack exists
 * yet, and nothing the plugin installs is spelled that way.
 */
export function qualifyVoiceId(stored: string, available: readonly string[], managedPackId: string): string {
  if (stored.length === 0 || stored.includes(VOICE_ID_SEPARATOR) || available.includes(stored)) return stored;

  const providers: string[] = [];

  for (const id of available) {
    const split = splitVoiceId(id);

    if (split !== null && split.voiceId === stored) providers.push(split.packId);
  }

  if (providers.includes(managedPackId)) return qualifiedVoiceId(managedPackId, stored);

  if (providers.length === 0) return stored;

  providers.sort();

  return qualifiedVoiceId(providers[0], stored);
}
