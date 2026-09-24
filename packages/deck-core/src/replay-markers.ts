/**
 * The `markers` section of the per-session replay file (issue #1162): pure
 * functions over a frame-ordered marker list. The store (`replay-session-store.ts`)
 * owns the list and calls these; the Replay Markers action calls the store.
 *
 * A marker is a replay frame (60 per second, absolute over the whole recording).
 * `sessionNum` and `sessionTimeMs` are descriptive only — shown to a person,
 * never used to jump. The windows below are the spec's, in frames.
 */

/** A marker within this many frames (1 s) of an existing one is not added twice. */
export const MARKER_DEDUPE_FRAMES = 60;

/** Delete reaches the nearest marker within this many frames (10 s); beyond it, nothing. */
export const MARKER_DELETE_WINDOW_FRAMES = 600;

/** Next skips markers up to this many frames (1 s) ahead, so a second press moves on. */
export const MARKER_NEXT_MIN_AHEAD_FRAMES = 60;

/**
 * Previous skips markers up to this many frames (2 s) behind, so pressing it
 * while a marker's moment is still playing goes to the one before — a media
 * player's previous-track.
 */
export const MARKER_PREVIOUS_MIN_BEHIND_FRAMES = 120;

export interface ReplayMarker {
  /** Forward compatibility: a field a newer build put on a marker survives this build's writes. */
  [key: string]: unknown;
  /** Absolute replay frame. */
  frame: number;
  /** `SessionNum` when the marker was set; descriptive only. */
  sessionNum: number;
  /** `SessionTime` when the marker was set, in ms; descriptive only. */
  sessionTimeMs: number;
}

function isMarker(value: unknown): value is ReplayMarker {
  if (value === null || typeof value !== "object") return false;

  const m = value as Record<string, unknown>;

  return (
    typeof m.frame === "number" &&
    Number.isFinite(m.frame) &&
    typeof m.sessionNum === "number" &&
    typeof m.sessionTimeMs === "number"
  );
}

/**
 * Read a loaded `markers` section: entries that are not markers are dropped,
 * the rest come back ordered by frame, each with every field it carried.
 * Anything that is not an array reads as no markers.
 */
export function normalizeMarkers(raw: unknown): ReplayMarker[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(isMarker)
    .map((m) => ({ ...m }))
    .sort((a, b) => a.frame - b.frame);
}

/**
 * Insert a marker in frame order. Returns false — and adds nothing — when an
 * existing marker is within {@link MARKER_DEDUPE_FRAMES} of it.
 */
export function addMarker(markers: ReplayMarker[], marker: ReplayMarker): boolean {
  if (markers.some((m) => Math.abs(m.frame - marker.frame) <= MARKER_DEDUPE_FRAMES)) return false;

  const at = markers.findIndex((m) => m.frame > marker.frame);

  markers.splice(at === -1 ? markers.length : at, 0, { ...marker });

  return true;
}

/**
 * Remove and return the marker nearest `frame` when it is within
 * {@link MARKER_DELETE_WINDOW_FRAMES}; null (and nothing removed) otherwise.
 * On a tie the earlier marker goes.
 */
export function deleteNearestMarker(markers: ReplayMarker[], frame: number): ReplayMarker | null {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  markers.forEach((m, index) => {
    const distance = Math.abs(m.frame - frame);

    if (distance <= MARKER_DELETE_WINDOW_FRAMES && distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  });

  if (bestIndex === -1) return null;

  return markers.splice(bestIndex, 1)[0] ?? null;
}

/** The first marker more than {@link MARKER_NEXT_MIN_AHEAD_FRAMES} ahead of `frame`, or null. */
export function nextMarker(markers: readonly ReplayMarker[], frame: number): ReplayMarker | null {
  return markers.find((m) => m.frame - frame > MARKER_NEXT_MIN_AHEAD_FRAMES) ?? null;
}

/** The last marker more than {@link MARKER_PREVIOUS_MIN_BEHIND_FRAMES} behind `frame`, or null. */
export function previousMarker(markers: readonly ReplayMarker[], frame: number): ReplayMarker | null {
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];

    if (m !== undefined && frame - m.frame > MARKER_PREVIOUS_MIN_BEHIND_FRAMES) return m;
  }

  return null;
}
