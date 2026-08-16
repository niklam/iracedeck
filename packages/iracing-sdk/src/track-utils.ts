import { TrkLoc } from "./types.js";
import type { TelemetryData } from "./types.js";

export interface FindNearestCarOptions {
  /** Predicate to skip specific car indices (e.g., pace car, spectators) */
  skipIdx?: (idx: number) => boolean;
}

/**
 * Whether a car currently exists in the sim world — the one in-world test every
 * car-targeting walk shares (issue #968: camera / replay cycling, the
 * track-order primitive below, and the nearest-gap helper).
 *
 * A car counts as present when it has a valid lap distance AND a track surface
 * other than `NotInWorld`. Both halves earn their place: iRacing normally
 * clears a car's `CarIdxLapCompleted` / `CarIdxLapDistPct` /
 * `CarIdxTrackSurface` together as it leaves the world (dump-file inspection
 * recorded in `sim-events-iracing`'s `race-finish.ts`), but a despawned car can
 * be observed holding a stale, still-valid `CarIdxLapDistPct` for a tick — the
 * #885 report — and only the surface rejects that one.
 *
 * The translator keeps its OWN in-world tests (`race-finish.ts`,
 * `hasLiveProgress`) because position scoring genuinely needs the lap count;
 * this predicate is the shared rule for "may the camera be pointed at it".
 *
 * **There is deliberately NO `CarIdxLapCompleted` condition — do not add one.**
 * That field counts COMPLETED laps, so it reads `-1` for every active car until
 * its first start/finish crossing. A lap-count condition therefore marks the
 * entire formation lap as "nobody is here": it was removed from
 * `findNearestCarOnTrack` for that reason in issue #307 (snapshot
 * `20260417-081043`, every car at `laps = -1`), and re-adding it to the camera /
 * replay cycling predicate silently killed those cycles for a whole lap
 * (issue #968). It also earns nothing — the surface check already rejects every
 * despawn it would.
 *
 * This is a per-tick snapshot with deliberately NO freeze/debounce, unlike the
 * translator's position tracking (`sim-events-iracing`'s `race-finish.ts`),
 * which starts from the same signals but remembers a last-known-good score: a
 * one-tick `NotInWorld` blink here at worst makes one detent skip a live car,
 * and the next detent recovers — which doesn't justify carrying per-car history
 * in a camera-targeting predicate.
 *
 * Callers get a per-car closure so the telemetry arrays are resolved once per
 * walk rather than per candidate. With no per-car arrays at all (out of
 * session) every car counts as present: there is nothing to judge absence by,
 * and the consumers' own fallbacks handle that case.
 */
export function carInWorld(telemetry: TelemetryData | null): (carIdx: number) => boolean {
  const lapDistPct = telemetry?.CarIdxLapDistPct as number[] | undefined;

  if (!Array.isArray(lapDistPct)) return () => true;

  const trackSurface = telemetry?.CarIdxTrackSurface as number[] | undefined;

  return (carIdx) => lapDistPct[carIdx] >= 0 && trackSurface?.[carIdx] !== TrkLoc.NotInWorld;
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
  const inWorld = carInWorld(telemetry);
  const skipIdx = options?.skipIdx;

  const currentDist = lapDistPct[referenceCarIdx];
  const hasValidPosition = currentDist !== undefined && currentDist >= 0;

  let bestIdx: number | null = null;
  let bestDist = Infinity;

  for (let idx = 0; idx < lapDistPct.length; idx++) {
    if (idx === referenceCarIdx) continue;

    // Skip disconnected/empty slots and cars that have left the world (an
    // absent or negative lap distance fails `inWorld` on its own). Lap count is
    // deliberately not part of this test — see `carInWorld` (#307, #968).
    if (!inWorld(idx)) continue;

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
  const inWorld = carInWorld(telemetry);
  const me = lapDistPct[referenceCarIdx];

  if (me === undefined || me < 0) return null;

  let best = Infinity;

  for (let idx = 0; idx < lapDistPct.length; idx++) {
    if (idx === referenceCarIdx) continue;

    // Same in-world rule as every other consumer (`carInWorld`, #968) — it
    // already rejects an absent or negative lap distance.
    if (!inWorld(idx)) continue;

    const pct = lapDistPct[idx];

    let frac = Math.abs(pct - me);

    if (frac > 0.5) frac = 1 - frac; // shortest way around the loop

    if (frac < best) best = frac;
  }

  if (!Number.isFinite(best)) return null;

  return best * trackLengthMeters;
}
