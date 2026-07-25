/**
 * Snapshot pruning for the refresh script (issue #888). Pure so the logic is
 * unit-testable; `scripts/refresh-corner-data.mjs` feeds it the raw
 * lovely-track-data iRacing JSON files and writes the result to
 * `src/corners.iracing.json`.
 */
import { normalizeCornerName } from "./normalize.js";

/** Raw lovely-track-data track file — only the fields the pruner reads. */
export type RawTrackFile = { trackId?: unknown; turn?: unknown };

export type CornerSnapshotEntry = { start: number; name: string };

/** Pruned snapshot: dataset trackId → named turns sorted by start pct. */
export type CornerSnapshot = Record<string, CornerSnapshotEntry[]>;

/**
 * Prune raw track files down to what the callout needs: named turns with a
 * usable position in [0, 1). Handles the dataset's schema variants — `start`
 * with `marker` (apex) fallback, the one `naem` typo — and normalizes names
 * so "T5"/"Turn 5" merge. Tracks with no surviving turns are omitted.
 */
export function buildCornerSnapshot(files: RawTrackFile[]): CornerSnapshot {
  const snapshot: CornerSnapshot = {};

  for (const file of files) {
    if (typeof file.trackId !== "string" || file.trackId === "" || !Array.isArray(file.turn)) continue;

    const entries: CornerSnapshotEntry[] = [];

    for (const raw of file.turn as Record<string, unknown>[]) {
      const name = typeof raw.name === "string" ? raw.name : typeof raw.naem === "string" ? raw.naem : "";
      const position = typeof raw.start === "number" ? raw.start : typeof raw.marker === "number" ? raw.marker : null;

      if (name.trim() === "" || position === null || position < 0 || position >= 1) continue;

      entries.push({ start: position, name: normalizeCornerName(name) });
    }

    if (entries.length === 0) continue;

    entries.sort((a, b) => a.start - b.start);
    snapshot[file.trackId] = entries;
  }

  return snapshot;
}
