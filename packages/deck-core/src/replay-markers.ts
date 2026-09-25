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
 * A loaded `markers` section split into what this build can read and what it
 * cannot. `markers` is ordered by frame, each with every field it carried;
 * `unreadable` is every other entry, verbatim and in file order — a newer
 * build's marker shape, most likely — which the store re-emits after the
 * markers on every write so an older build never drops it. Anything that is
 * not an array reads as no markers and nothing to preserve.
 */
export interface PartitionedMarkers {
  markers: ReplayMarker[];
  unreadable: unknown[];
}

export function partitionMarkers(raw: unknown): PartitionedMarkers {
  if (!Array.isArray(raw)) return { markers: [], unreadable: [] };

  const markers: ReplayMarker[] = [];
  const unreadable: unknown[] = [];

  for (const entry of raw) {
    if (isMarker(entry)) {
      markers.push({ ...entry });
    } else {
      unreadable.push(entry);
    }
  }

  markers.sort((a, b) => a.frame - b.frame);

  return { markers, unreadable };
}

/**
 * The readable markers of a loaded `markers` section, ordered by frame, each
 * with every field it carried. Anything that is not an array reads as no
 * markers. The store uses {@link partitionMarkers} so the entries this drops
 * survive its writes.
 */
export function normalizeMarkers(raw: unknown): ReplayMarker[] {
  return partitionMarkers(raw).markers;
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

/**
 * The marker a previous-track press means, or null. The anchor is the last
 * marker at or before `frame`: while its moment is still playing (no more than
 * {@link MARKER_PREVIOUS_MIN_BEHIND_FRAMES} behind) the press goes to the
 * marker before the anchor, otherwise to the anchor itself. Measuring the
 * window from the anchor rather than from `frame` is what keeps two markers
 * set less than two seconds apart both reachable: standing on the later one,
 * the earlier one is the target, not skipped.
 */
export function previousMarker(markers: readonly ReplayMarker[], frame: number): ReplayMarker | null {
  let anchor = -1;

  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];

    if (m !== undefined && m.frame <= frame) {
      anchor = i;
      break;
    }
  }

  if (anchor === -1) return null;

  const onAnchor = frame - (markers[anchor]?.frame ?? frame) <= MARKER_PREVIOUS_MIN_BEHIND_FRAMES;

  return (onAnchor ? markers[anchor - 1] : markers[anchor]) ?? null;
}
