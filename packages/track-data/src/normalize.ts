/**
 * Name/key normalization for the bundled corner dataset (issue #888).
 *
 * Corner names in lovely-track-data mix "T5" and "Turn 5" spellings for the
 * same concept; normalizing at snapshot-refresh time merges them so one
 * spoken clip covers both. Slugs are the clip base names
 * (`voice/<voice>/corner-names/<slug>-01.mp3`), so the algorithm here is the
 * single source of truth shared by the resolver and the clip tooling.
 */

/** Collapse whitespace and expand bare `T<n>` shorthand to `Turn <n>`. */
export function normalizeCornerName(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  const tShorthand = /^[Tt](\d+)$/.exec(collapsed);

  return tShorthand ? `Turn ${tShorthand[1]}` : collapsed;
}

/**
 * Slug for a corner name — lowercase, diacritics stripped (NFD + combining
 * marks removed), non-alphanumeric runs collapsed to single hyphens. Applied
 * to the NORMALIZED name so "T5" and "Turn 5" share the slug `turn-5`.
 */
export function slugifyCornerName(name: string): string {
  return normalizeCornerName(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Canonical form of a track key for matching iRacing's `WeekendInfo.TrackName`
 * against the dataset's `trackId`. Both sides are normalized, so the dataset's
 * one hyphenated outlier (`cota-gp`) still matches iRacing's space-separated
 * `cota gp`.
 */
export function normalizeTrackKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");
}
