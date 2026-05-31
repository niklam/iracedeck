import type { TelemetryData } from "./types.js";

/**
 * Calculates race positions from lap completion data.
 *
 * Scores each active car as `CarIdxLapCompleted + CarIdxLapDistPct` and sorts
 * descending to derive 1-based race positions. A car is active when both
 * `lapCompleted >= 0` AND `lapDistPct >= 0`.
 *
 * @returns Array indexed by carIdx — value is 1-based position, 0 for inactive cars.
 */
export function calculateRacePositions(telemetry: TelemetryData | null): number[] {
  if (!telemetry?.CarIdxLapCompleted || !telemetry?.CarIdxLapDistPct) return [];

  const lapCompleted = telemetry.CarIdxLapCompleted as number[];
  const lapDistPct = telemetry.CarIdxLapDistPct as number[];
  const length = Math.min(lapCompleted.length, lapDistPct.length);

  const active: { idx: number; score: number }[] = [];

  for (let i = 0; i < length; i++) {
    if (lapCompleted[i] >= 0 && lapDistPct[i] >= 0) {
      active.push({ idx: i, score: lapCompleted[i] + lapDistPct[i] });
    }
  }

  active.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const result = new Array<number>(length).fill(0);

  for (let rank = 0; rank < active.length; rank++) {
    result[active[rank].idx] = rank + 1;
  }

  return result;
}

/**
 * Derives a car's class position from an already-computed overall race order.
 *
 * This does NOT compute positions — it reuses an existing 1-based overall-rank
 * array (e.g. from {@link calculateRacePositions} or the frozen
 * `calculateFrozenRacePositions`) and counts how many same-class cars rank ahead
 * of `carIdx`, +1. Same counting as the qualifying-grid `resolveStartingClassPosition`
 * (issue #599), applied to the live order instead of the grid. Cars omitted from
 * the order (rank `0`) are ignored, so retired / not-in-world cars don't inflate
 * the count.
 *
 * @param positions   1-based overall ranks indexed by carIdx (`0` = omitted).
 * @param carIdxClass `CarIdxClass` telemetry (class id per carIdx); may be undefined.
 * @param carIdx      The player's car index.
 * @returns 1-based class position, or `0` when it can't be derived (player omitted,
 *          missing class data, or out-of-range carIdx).
 */
export function classPositionFromOrder(positions: number[], carIdxClass: number[] | undefined, carIdx: number): number {
  if (carIdx < 0 || carIdx >= positions.length) return 0;

  if (!Array.isArray(carIdxClass)) return 0;

  const myRank = positions[carIdx];

  if (myRank === undefined || myRank <= 0) return 0;

  const myClass = carIdxClass[carIdx];

  if (myClass === undefined) return 0;

  let ahead = 0;

  for (let i = 0; i < positions.length; i++) {
    if (i === carIdx) continue;

    const rank = positions[i];

    if (rank > 0 && rank < myRank && carIdxClass[i] === myClass) ahead++;
  }

  return ahead + 1;
}
