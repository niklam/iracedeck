/**
 * Corner-marker resolver over the committed lovely-track-data snapshot
 * (issue #888). Synchronous and dependency-free: the snapshot is imported
 * at build time, and the lookup table is built lazily on first use.
 */
import { CORNER_SNAPSHOT } from "./corners.iracing.js";
import { normalizeTrackKey, slugifyCornerName } from "./normalize.js";

/** One named corner: track-length fraction of the turn entry + spoken name. */
export type CornerMarker = {
  /** Turn-start position as a 0–1 fraction of the lap (maps onto `LapDistPct`). */
  startPct: number;
  /** Normalized display name ("Hell Corner", "Turn 5"). */
  name: string;
  /** Clip base slug (`voice/<voice>/corner-names/<slug>-01.mp3`). */
  slug: string;
};

const snapshot = CORNER_SNAPSHOT;

let lookupCache: Map<string, CornerMarker[]> | null = null;

function lookup(): Map<string, CornerMarker[]> {
  if (lookupCache) return lookupCache;

  lookupCache = new Map();

  for (const [trackId, entries] of Object.entries(snapshot)) {
    lookupCache.set(
      normalizeTrackKey(trackId),
      entries.map((e) => ({ startPct: e.start, name: e.name, slug: slugifyCornerName(e.name) })),
    );
  }

  return lookupCache;
}

/**
 * Resolve the corner markers for an iRacing track, keyed by the sim's
 * internal `WeekendInfo.TrackName`. Matching is case- and separator-
 * insensitive (the dataset has one hyphenated trackId outlier). Returns
 * `null` when the track isn't in the dataset — the caller stays silent.
 */
export function resolveCornerMarkers(trackName: string): CornerMarker[] | null {
  if (trackName.trim() === "") return null;

  return lookup().get(normalizeTrackKey(trackName)) ?? null;
}

/**
 * Every unique corner name across the snapshot with its slug — the input to
 * the voice-config authoring step (one clip per entry).
 */
export function listCornerNames(): { name: string; slug: string }[] {
  const bySlug = new Map<string, string>();

  for (const entries of Object.values(snapshot)) {
    for (const e of entries) {
      const slug = slugifyCornerName(e.name);

      if (!bySlug.has(slug)) bySlug.set(slug, e.name);
    }
  }

  return [...bySlug.entries()].map(([slug, name]) => ({ name, slug })).sort((a, b) => a.slug.localeCompare(b.slug));
}
