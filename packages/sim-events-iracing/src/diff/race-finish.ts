/**
 * Self-managed running order (issue #603).
 *
 * iRacing zeroes a car's `CarIdxLapCompleted` / `CarIdxLapDistPct` /
 * `CarIdxTrackSurface` to `-1` the instant the car is `NotInWorld` (proven by
 * dump-file inspection: `car8` went `lc6 dp0.142 ts3` → `lc-1 dp-1 ts-1` in a
 * single tick during a connection blip while running a lap ahead). Re-deriving
 * the running order from raw realtime telemetry on every tick therefore
 * reshuffles the player on every blip / teleport — that's the root of #603,
 * and it shows up in three guises (finishers leaving the world, tows
 * teleporting into the pit, and brief `NotInWorld` blinks of cars ahead).
 *
 * **The model.** A car's position is its last lap + distance; iRacing forgets
 * it when the car blinks out, so we remember it ourselves. We maintain a
 * per-car last-known good score from continuous on-track motion. A car's
 * **effective score** is its live `lc + dp` while it's moving normally on
 * track, and is **frozen at its last-known good value** whenever its telemetry
 * is invalid (`NotInWorld`) or has drifted discontinuously from the last-known
 * point (teleport / tow / post-blink-different-location). The player only
 * passes a frozen car when the player's own score genuinely exceeds the frozen
 * point — "…until we've passed that point". A frozen car becomes unfrozen
 * automatically when its live score returns to within {@link TELEPORT_THRESHOLD}
 * of its anchor (it's racing nearby again).
 *
 * One rule replaces three patches:
 *   - **Blink** (`NotInWorld` for a tick) → frozen at last → the player's rank
 *     doesn't move during the blip; the car unfreezes on its first in-world
 *     tick (live score ≈ anchor).
 *   - **Disconnect** (`NotInWorld` indefinitely) → frozen at last → the player
 *     passes it naturally by racing past its point; no sudden reshuffle.
 *   - **Finished** (crosses S/F, drives to garage, vanishes) → frozen at the
 *     finishing score (last-known just before vanishing) → the player can't
 *     pass it without finishing too. No separate checkered detection needed.
 *   - **Tow** (teleport to pit stall) → live score jumps far from the anchor
 *     → frozen at the pre-tow on-track score → stays where it was. No `-1`
 *     hack, and more accurate than subtracting a whole lap.
 *
 * **Celebration rule** (applied by `diffOvertakes`): when the player's rank
 * improves, the gain is `fromRetirement` (no "Nice pass") iff at least one car
 * that was ahead of the player last tick is now in {@link TranslatorState.positionFrozen}.
 * Celebrations are reserved for genuine on-track passes of active cars.
 */
import { calculateRacePositions, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";

/**
 * Maximum allowed change in a car's score (`lc + dp`) since its last-known
 * anchor before we treat it as discontinuous and freeze. A car at racing speed
 * covers ~0.0003 lap per 60 Hz tick (≈ 5 m at 300 km/h on a 5 km track), so
 * 0.05 lap is ~150× max continuous motion — well below any plausible teleport
 * (a tow to the pit stall typically jumps the dp by several tenths). Also
 * comfortably above the score-jump on a natural S/F crossing (`(N+1) + 0.001`
 * vs `N + 0.999` → delta ≈ 0.002).
 */
export const TELEPORT_THRESHOLD = 0.05;

/**
 * Update the self-managed running order from this tick's telemetry. Call once
 * per tick, before `calculateFrozenRacePositions` and `diffOvertakes`.
 *
 * For each car:
 *   - `NotInWorld` (live `lc`/`dp`/`ts` snapped to `-1`) → freeze at the
 *     last-known score (preserved across the blip).
 *   - In world but live `lc + dp` differs from the anchor by more than
 *     {@link TELEPORT_THRESHOLD} → freeze (teleport / drifted-away post-blink);
 *     keep the anchor pinned to where the car was last seen racing.
 *   - In world and the live score is close to the anchor → continuous on-track
 *     motion → unfreeze and roll the anchor forward to the live score.
 *
 * Cars that have never been seen in-world (no anchor yet) are seeded on their
 * first in-world tick and stay unfrozen from there.
 */
export function updatePositionTracking(state: TranslatorState, telemetry: TelemetryData): void {
  const lc = telemetry.CarIdxLapCompleted;
  const dp = telemetry.CarIdxLapDistPct;

  if (!Array.isArray(lc) || !Array.isArray(dp)) return;

  const ts = telemetry.CarIdxTrackSurface as number[] | undefined;
  const length = Math.min(lc.length, dp.length);

  for (let i = 0; i < length; i++) {
    const inWorld = lc[i] >= 0 && dp[i] >= 0 && ts?.[i] !== TrkLoc.NotInWorld;

    if (!inWorld) {
      // Telemetry has snapped to the NotInWorld sentinels — keep the anchor,
      // mark frozen if we'd ever seen the car (so it can be ranked). A car we
      // haven't seen yet has no anchor and stays absent from the order.
      if (state.positionLastKnownScores[i] !== undefined) state.positionFrozen.add(i);

      continue;
    }

    const score = lc[i] + dp[i];
    const anchor = state.positionLastKnownScores[i];

    if (anchor === undefined) {
      // First sighting — seed the anchor, unfrozen.
      state.positionLastKnownScores[i] = score;
      state.positionFrozen.delete(i);
    } else if (Math.abs(score - anchor) > TELEPORT_THRESHOLD) {
      // Live score has drifted far from the anchor: teleport (tow) or just
      // returned in a different spot after a blink. Freeze — keep the anchor.
      state.positionFrozen.add(i);
    } else {
      // Continuous on-track motion close to the anchor — roll it forward.
      state.positionFrozen.delete(i);
      state.positionLastKnownScores[i] = score;
    }
  }
}

/**
 * Race positions with the self-managed corrections applied (issue #603). For
 * each car, rank by its effective score:
 *   - frozen → `positionLastKnownScores[i]` (last on-track point),
 *   - active → live `lc + dp`,
 *   - never seen (no anchor and currently `NotInWorld`) → omitted.
 *
 * Returns the same shape as `calculateRacePositions` (1-based rank indexed by
 * carIdx; `0` for omitted cars), sorted with the same comparator so the only
 * difference is the per-car effective score.
 */
export function calculateFrozenRacePositions(state: TranslatorState, telemetry: TelemetryData): number[] {
  // Fast path: nothing frozen and no anchors out of sync — the raw and managed
  // orders are identical. (Cheap check; the only way we'd be in sync is if
  // every active car's score equals its anchor, which is true on every tick
  // where no blip / teleport happened.)
  if (state.positionFrozen.size === 0 && state.positionLastKnownScores.length === 0) {
    return calculateRacePositions(telemetry);
  }

  const lc = telemetry.CarIdxLapCompleted;
  const dp = telemetry.CarIdxLapDistPct;

  if (!Array.isArray(lc) || !Array.isArray(dp)) return calculateRacePositions(telemetry);

  const ts = telemetry.CarIdxTrackSurface as number[] | undefined;
  const length = Math.min(lc.length, dp.length);
  const ranked: { idx: number; score: number }[] = [];

  for (let i = 0; i < length; i++) {
    if (state.positionFrozen.has(i)) {
      const anchor = state.positionLastKnownScores[i];

      // Anchor must exist (the updater only adds to the set when it does), but
      // guard defensively.
      if (anchor !== undefined) ranked.push({ idx: i, score: anchor });

      continue;
    }

    // Not frozen — use live, but only if the car is actually in the world. A
    // car not in the world that's also not frozen (i.e. we've never seen it)
    // is omitted.
    if (lc[i] >= 0 && dp[i] >= 0 && ts?.[i] !== TrkLoc.NotInWorld) {
      ranked.push({ idx: i, score: lc[i] + dp[i] });
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const result = new Array<number>(length).fill(0);

  for (let rank = 0; rank < ranked.length; rank++) {
    result[ranked[rank].idx] = rank + 1;
  }

  return result;
}
