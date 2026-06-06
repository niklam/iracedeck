import { TrkLoc } from "./types.js";
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
  if (!telemetry?.CarIdxLapDistPct) return null;

  if (referenceCarIdx < 0) return null;

  const lapDistPct = telemetry.CarIdxLapDistPct as number[];
  const trackSurface = telemetry.CarIdxTrackSurface as number[] | undefined;
  const skipIdx = options?.skipIdx;

  const currentDist = lapDistPct[referenceCarIdx];
  const hasValidPosition = currentDist !== undefined && currentDist >= 0;

  let bestIdx: number | null = null;
  let bestDist = Infinity;

  for (let idx = 0; idx < lapDistPct.length; idx++) {
    if (idx === referenceCarIdx) continue;

    if (lapDistPct[idx] === undefined || lapDistPct[idx] < 0) continue;

    // Skip disconnected/empty slots. During a warmup/pace lap CarIdxLapCompleted is
    // still -1 for active cars, so lap count is not a safe "is active" signal — the
    // authoritative signals are CarIdxLapDistPct and CarIdxTrackSurface.
    if (trackSurface?.[idx] === TrkLoc.NotInWorld) continue;

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

/**
 * Parse `WeekendInfo.TrackLength` (iRacing reports it as a string like
 * `"7.004 km"`) to meters. Returns null when the value is missing or
 * unparseable. Recognises `km` (default), `mi`, and bare `m`.
 */
export function parseTrackLengthMeters(raw: unknown): number | null {
  if (typeof raw !== "string") return null;

  const match = /([\d.]+)\s*(km|mi|m)?/i.exec(raw.trim());

  if (!match) return null;

  const value = Number(match[1]);

  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = (match[2] ?? "km").toLowerCase();

  if (unit === "mi") return value * 1609.344;

  if (unit === "m") return value;

  return value * 1000;
}

/**
 * Smallest circular on-track gap (meters) from the reference car to any other
 * in-world car, using `CarIdxLapDistPct` (0.0–1.0) × `trackLengthMeters`.
 * Returns null when the data needed is unavailable. Used by the spotter's
 * "clear" confirmation buffer (issue #651) to confirm a car has actually pulled
 * away before announcing clear.
 */
export function nearestCarGapMeters(
  telemetry: TelemetryData | null,
  referenceCarIdx: number,
  trackLengthMeters: number,
): number | null {
  if (!telemetry?.CarIdxLapDistPct || referenceCarIdx < 0 || !(trackLengthMeters > 0)) return null;

  const lapDistPct = telemetry.CarIdxLapDistPct as number[];
  const trackSurface = telemetry.CarIdxTrackSurface as number[] | undefined;
  const me = lapDistPct[referenceCarIdx];

  if (me === undefined || me < 0) return null;

  let best = Infinity;

  for (let idx = 0; idx < lapDistPct.length; idx++) {
    if (idx === referenceCarIdx) continue;

    const pct = lapDistPct[idx];

    if (pct === undefined || pct < 0) continue;

    if (trackSurface?.[idx] === TrkLoc.NotInWorld) continue;

    let frac = Math.abs(pct - me);

    if (frac > 0.5) frac = 1 - frac; // shortest way around the loop

    if (frac < best) best = frac;
  }

  if (!Number.isFinite(best)) return null;

  return best * trackLengthMeters;
}
