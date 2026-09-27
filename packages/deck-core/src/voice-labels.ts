import { ENSURED_VOICE_PACK_ID } from "./voice-pack-constants.js";
import type { InstalledVoicePack, VoicePackProvenanceKind } from "./voice-pack-scanner.js";

/** The prefix a first-party voice's label carries — {@link isFirstPartyVoicePack}. */
export const FIRST_PARTY_VOICE_LABEL_PREFIX = "iRaceDeck";

/**
 * The provenances that make a pack iRaceDeck's own (issue #999, spec "Labels
 * and order"): installed from our catalog, seeded bundled at first run, or
 * found under the development voice root. `sideload` is deliberately absent —
 * see {@link InstalledVoicePack.provenance} for why that value can never be
 * forged by a pack about itself.
 */
const FIRST_PARTY_PROVENANCE: ReadonlySet<VoicePackProvenanceKind> = new Set([
  "catalog",
  "bundled-seed",
  "development",
]);

/**
 * Whether install PROVENANCE (never the pack's own id or label) makes a pack
 * iRaceDeck's own (#999). This is the one place provenance — elsewhere a
 * displayed badge, never enforced — becomes a decision: it drives both the
 * "iRaceDeck:" label prefix below and the pack's place at the front of
 * {@link orderRaceEngineerVoices}. Accepted limit, same as the provenance
 * badge itself: a hand-written `.install.json` naming this pack's id is
 * indistinguishable from a real install record, so a folder placed by hand
 * that carries one still counts as ours.
 */
export function isFirstPartyVoicePack(pack: Pick<InstalledVoicePack, "provenance">): boolean {
  return FIRST_PARTY_PROVENANCE.has(pack.provenance);
}

/**
 * What each installed voice should be CALLED in the dropdown (issue #1034,
 * extended for #999).
 *
 * A voice's own label is usually enough. It stops being enough when the same
 * name can mean two things — a pack shipping several voices, or a pack whose
 * name and its voice's name are different things a user might need to tell
 * apart — so those get their pack's name in front: `Duo: Ay`, `iRaceDeck:
 * Default`.
 *
 * **First-party packs are a branch of their own, decided by install
 * provenance rather than by the collision rule below** ({@link
 * isFirstPartyVoicePack}). Every voice of a pack iRaceDeck itself shipped —
 * whether that is the managed `default` pack or a second pack like the Terse
 * one — is labelled `iRaceDeck: <pack label>`; the pack's own manifest label
 * ("Default", "Default (Terse)") stays untouched and only the plugin adds the
 * prefix. The accepted limit is the same one the provenance badge already
 * lives with: a hand-written `.install.json` that names this pack's id is
 * indistinguishable from a genuine install record, so a folder placed there by
 * hand is labelled as ours too. See the #999 spec, "Labels and order".
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
 * Keys are the voices' composite ids, `<pack id>::<voice id>` (#1144) — what
 * the dropdown's options carry and `_voiceLabels` is read by. Two packs each
 * shipping a `matt` are therefore two entries. #999 narrows the #1034 rule
 * above to non-first-party packs, now that "iRaceDeck: Default" needs the
 * prefix reserved for our own voices — the rule ITSELF is unchanged for a
 * third-party pack: still prefixed only when it ships several voices or
 * labels one differently from itself. Replacing that with `<pack label>:
 * <voice label>` for every voice of a third-party pack, whatever the manifest
 * declares, remains #1147's to do and is planned, not shipped; until it
 * lands, two third-party packs that label a voice identically still show two
 * identical entries, as the rule already allows for two different voice ids.
 */
export function voiceDisplayLabels(packs: readonly InstalledVoicePack[]): Record<string, string> {
  const labels: Record<string, string> = {};

  for (const pack of packs) {
    if (isFirstPartyVoicePack(pack)) {
      for (const voice of pack.voices) labels[voice.id] = `${FIRST_PARTY_VOICE_LABEL_PREFIX}: ${pack.label}`;

      continue;
    }

    const prefixed = pack.voices.length > 1 || pack.voices.some((voice) => voice.label !== pack.label);

    for (const voice of pack.voices) {
      labels[voice.id] = prefixed ? `${pack.label}: ${voice.label}` : voice.label;
    }
  }

  return labels;
}

/** Case-insensitive, numeric-aware English collation (`en`, `sensitivity: "base"`, `numeric: true`). */
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/**
 * Sort the Race Engineer voice list for publishing (#999, spec "Labels and
 * order"): the managed pack (`ENSURED_VOICE_PACK_ID`) first, then every other
 * first-party voice, then everyone else — each band ordered by its display
 * label. `ird-voice-select` renders options in the order it receives them, so
 * this is the ONE place the order is decided; the PI does no sorting of its
 * own.
 *
 * A voice no installed pack provides (its pack was removed, or the id is
 * simply stale) ranks with the third-party band — it has no provenance to
 * call first-party, so treating it as ours would be a claim this function
 * cannot back up.
 *
 * A sideloaded copy of the managed pack's id does NOT rank first: the band is
 * decided by {@link isFirstPartyVoicePack}'s provenance check, never by
 * matching `ENSURED_VOICE_PACK_ID`, so a folder placed by hand under `default`
 * with no genuine install record sorts with the third-party voices, however
 * its manifest labels itself (accepted limit, same spec).
 *
 * Ties within a band break on the composite id, so the result is stable
 * however the caller happened to order equally-labelled voices. Returns a new
 * array; `voices` is read, never mutated.
 */
export function orderRaceEngineerVoices(
  voices: readonly string[],
  packs: readonly InstalledVoicePack[],
  labels: Readonly<Record<string, string>>,
): string[] {
  const packOf = new Map<string, InstalledVoicePack>();

  for (const pack of packs) for (const voice of pack.voices) packOf.set(voice.id, pack);

  const rank = (id: string): number => {
    const pack = packOf.get(id);

    if (pack === undefined || !isFirstPartyVoicePack(pack)) return 2;

    return pack.id === ENSURED_VOICE_PACK_ID ? 0 : 1;
  };
  const name = (id: string): string => labels[id] ?? id;

  return [...voices].sort(
    (a, b) => rank(a) - rank(b) || collator.compare(name(a), name(b)) || (a < b ? -1 : a > b ? 1 : 0),
  );
}
