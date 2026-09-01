import type { InstalledVoicePack } from "./voice-pack-scanner.js";

/**
 * What each installed voice should be CALLED in the dropdown (issue #1034).
 *
 * A voice's own label is usually enough. It stops being enough when the same
 * name can mean two things — a pack shipping several voices, or a pack whose
 * name and its voice's name are different things a user might need to tell
 * apart — so those get their pack's name in front: `Duo: Ay`, `iRaceDeck:
 * Default`.
 *
 * **The decision is per PACK, never per voice**, and that is the whole rule.
 * Deciding per voice — prefixing only the ones whose label differs from their
 * pack's — splits a single manifest: a pack `Vixen` shipping `Vixen` and `Vixen
 * Short` would render one sibling prefixed and the other bare, from one file the
 * author wrote in one sitting. Per pack, its voices are named consistently or
 * not at all.
 *
 * **Nothing here depends on what else is installed**, which is the property
 * worth protecting. Prefixing only on a collision would read better and would
 * mean a second pack silently renaming an entry the user had already learned;
 * this rule reads a pack's own manifest and nothing more, so an entry's name is
 * fixed the moment that pack is installed.
 *
 * What it does NOT do: two packs that label BOTH themselves and their only voice
 * identically both land in the bare branch and both render the same string. Pack
 * ids are unique — they are folder names — but pack labels are not. Accepted
 * deliberately (Niklas, 2026-09-01) as rarer than the renaming the alternative
 * would cause.
 *
 * A voice with no pack at all — the bundled one, which has no manifest — is
 * absent from this map and falls back to `titleCase(id)` in the component. Note
 * that is temporary: stages 2–3 of this issue ship the bundled voice AS a pack,
 * at which point the same rule renders it `iRaceDeck: Default` rather than
 * `Default`. A one-time change arriving with a migration, not a surprise.
 */
export function voiceDisplayLabels(packs: readonly InstalledVoicePack[]): Record<string, string> {
  const labels: Record<string, string> = {};

  for (const pack of packs) {
    const prefixed = pack.voices.length > 1 || pack.voices.some((voice) => voice.label !== pack.label);

    for (const voice of pack.voices) {
      labels[voice.id] = prefixed ? `${pack.label}: ${voice.label}` : voice.label;
    }
  }

  return labels;
}
