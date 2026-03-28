import type { TelemetryData } from "./types.js";

export interface FindNearestCarOptions {
  /** Predicate to skip specific car indices (e.g., pace car, spectators) */
  skipIdx?: (idx: number) => boolean;
}

/**
 * Find the physically closest car on track ahead or behind a reference car.
 * Uses circular track distance based on CarIdxLapDistPct (0.0–1.0), regardless of lap count.
 *
 * When the reference car has no valid track position (e.g., disconnected), falls back to
 * the car closest to the start/finish line for both directions.
 *
 * @param telemetry - Current telemetry data
 * @param referenceCarIdx - The car index to measure from (e.g., CamCarIdx or PlayerCarIdx)
 * @param direction - "ahead" or "behind" on the physical track
 * @param options - Optional filters (e.g., skip pace car)
 * @returns The carIdx of the nearest car, or null if no candidates
 */
export function findNearestCarOnTrack(
  telemetry: TelemetryData | null,
  referenceCarIdx: number,
  direction: "ahead" | "behind",
  options?: FindNearestCarOptions,
): number | null {
  if (!telemetry?.CarIdxLapCompleted || !telemetry?.CarIdxLapDistPct) return null;

  if (referenceCarIdx < 0) return null;

  const lapCompleted = telemetry.CarIdxLapCompleted as number[];
  const lapDistPct = telemetry.CarIdxLapDistPct as number[];
  const skipIdx = options?.skipIdx;

  const currentDist = lapDistPct[referenceCarIdx];
  const hasValidPosition = currentDist !== undefined && currentDist >= 0;

  let bestIdx: number | null = null;
  let bestDist = Infinity;

  for (let idx = 0; idx < lapCompleted.length; idx++) {
    if (idx === referenceCarIdx) continue;

    if (lapCompleted[idx] === undefined || lapCompleted[idx] < 0) continue;

    if (lapDistPct[idx] === undefined || lapDistPct[idx] < 0) continue;

    if (skipIdx?.(idx)) continue;

    if (hasValidPosition) {
      const dist =
        direction === "ahead"
          ? (lapDistPct[idx] - currentDist + 1.0) % 1.0
          : (currentDist - lapDistPct[idx] + 1.0) % 1.0;

      if (dist > 0 && dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    } else {
      // No reference position — fall back to car closest to start/finish line
      const distToSF = Math.min(lapDistPct[idx], 1.0 - lapDistPct[idx]);

      if (distToSF < bestDist) {
        bestDist = distToSF;
        bestIdx = idx;
      }
    }
  }

  return bestIdx;
}
