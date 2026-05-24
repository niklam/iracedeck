/**
 * Overtake gain / loss detection (issue #574).
 *
 * Emits two paired events when the player's race position changes mid-race
 * and the new position holds for the sustainment window:
 *
 *   - `overtake.completed` — gained at least one position
 *   - `overtake.lost`      — dropped at least one position
 *
 * Both events carry the same shape (position / previousPosition / class
 * fields / `isMultiClass` / physical-gap to the relevant neighbour). Same
 * gating in both directions:
 *
 *   1. **Race-only.** Practice / qualifying / replay → no emission, state
 *      reset on entry to those modes so a later race seeds cleanly.
 *   2. **Not on pit road.** Pit entry/exit fires phantom position swings
 *      against cars completing laps at racing speed — gate everything.
 *   3. **Not under caution.** Yellow / caution flags freeze the baseline
 *      silently so the recovery wave doesn't surface a chain of swaps as
 *      the field shuffles into formation.
 *   4. **First-tick seed.** Connecting mid-drive captures the current
 *      position as the baseline and emits nothing — without this, the
 *      diff would synthesize a "you just gained 5 positions" callout the
 *      moment the user connects.
 *   5. **Sustainment.** New position must hold for `OVERTAKE_HOLD_MS`
 *      (3000 ms). Filters wheel-to-wheel oscillation that swaps the lead
 *      every corner.
 *   6. **Sim-glitch filter.** A jump of more than `OVERTAKE_MAX_JUMP`
 *      positions in a single tick is treated as a teleport / tow / DC
 *      and ignored.
 *   7. **Physical-gap gate.** At the emission tick, the gap between the
 *      player and the relevant neighbour (whoever's now immediately
 *      behind for a gain; immediately ahead for a loss) must be at least
 *      `OVERTAKE_MIN_GAP_M` meters. Filters the "3 seconds clean but
 *      still side-by-side" edge case where the sustainment passes but
 *      contact / re-pass is still imminent. When track length isn't
 *      known yet (YAML not parsed), the gap is treated as unknown and
 *      the emission proceeds without the gate (don't punish missing data).
 *
 * Class position is sourced from the LIVE `PlayerCarClassPosition` telemetry
 * field — overtakes fire mid-lap so the standings-first source used by
 * `lap.completed` (`ResultsPositions`) wouldn't help, and the live field is
 * accurate at the second-precision the hold window already gives us.
 * `isMultiClass` is resolved by the translator from session info and passed
 * through; the diff doesn't poke at `DriverInfo.Drivers` itself.
 *
 * **Multi-class detection (issue #588).** In a multi-class race the player's
 * OVERALL position churns as other-class cars pass / pit / complete laps even
 * while the player holds station in their own class, which produced a stream of
 * phantom callouts. So change-detection runs on CLASS position when
 * `isMultiClass`, overall position otherwise — i.e. on whichever position the
 * Race Engineer actually speaks. The emitted payload still carries overall
 * `position` / `previousPosition` and class `classPosition` /
 * `previousClassPosition`; `isLeader` stays overall. The physical-gap gate is
 * skipped in multi-class (the class neighbour can't be found from the overall
 * `positions` array, and a sustained class change is already a real overtake).
 *
 * **Round-trip suppression (issue #597).** `state.lastCalledPosition` tracks the
 * position last *announced* by a callout. A confirmed gain/loss is suppressed
 * when the current position equals it — i.e. a round-trip back to the called
 * position (e.g. P10 → P9 → P10) where the intermediate position never
 * sustained long enough to be announced. Without this, only the down-leg of a
 * brief up-down flicker would be spoken ("you lost a position" right after a
 * gain to the same position). It's updated only when a callout is emitted,
 * seeded on the first eligible tick, rolled silently under caution, and
 * compared in the same effective space the detection uses.
 */
import { calculateRacePositions, Flags, hasFlag, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

export const OVERTAKE_HOLD_MS = 3000;
export const OVERTAKE_MAX_JUMP = 3;
/**
 * Minimum physical gap (meters) between the player and the relevant
 * neighbour for an `overtake.*` event to emit (issue #574). 10 m
 * approximates "the cars are clear of each other" on both road courses and
 * ovals — a gap below this with the position swap held suggests the cars
 * are still side-by-side and the swap could easily reverse.
 */
export const OVERTAKE_MIN_GAP_M = 10;

export function diffOvertakes(
  state: TranslatorState,
  telemetry: TelemetryData,
  playerCarIdx: number,
  isRaceSession: boolean,
  isMultiClass: boolean | null,
  trackLengthMeters: number | null,
  now: number,
  emit: EmitFn,
): void {
  const onPitRoad = telemetry.OnPitRoad ?? false;

  if (!isRaceSession || onPitRoad) {
    if (state.overtakeInitialized) {
      resetOvertakeState(state);
    }

    return;
  }

  const sessionFlags = telemetry.SessionFlags ?? 0;
  const underCaution =
    hasFlag(sessionFlags, Flags.Caution) ||
    hasFlag(sessionFlags, Flags.CautionWaving) ||
    hasFlag(sessionFlags, Flags.Yellow) ||
    hasFlag(sessionFlags, Flags.YellowWaving);

  const positions = calculateRacePositions(telemetry);
  const overallPos = playerCarIdx >= 0 ? positions[playerCarIdx] : -1;

  if (overallPos === undefined || overallPos <= 0) return;

  const rawClassPos =
    typeof telemetry.PlayerCarClassPosition === "number" && telemetry.PlayerCarClassPosition > 0
      ? telemetry.PlayerCarClassPosition
      : 0;

  // In a multi-class race the driver's OVERALL position churns constantly as
  // faster- and slower-class cars pass, pit, and complete laps even while the
  // driver holds station in their own class — which surfaced as a stream of
  // phantom "lost / gained a position" callouts (issue #588). Detect on the
  // position that's actually spoken: CLASS position in multi-class, overall
  // otherwise. `position` / `previousPosition` in the payload stay overall and
  // `classPosition` / `previousClassPosition` carry the class values (the
  // consumer reads class in multi-class); `isLeader` stays overall because
  // "leading the race" must mean overall P1, not class P1. The physical-gap
  // gate is skipped in multi-class — the relevant neighbour is the class
  // neighbour, which the overall `positions` array can't identify, and a class
  // change held for the sustainment window is already a real class overtake.
  const useClass = isMultiClass === true && rawClassPos > 0;
  const currentPos = useClass ? rawClassPos : overallPos;
  const lastEffective = useClass ? state.lastClassPosition : state.lastPosition;

  if (underCaution) {
    state.lastPosition = overallPos;
    state.lastClassPosition = rawClassPos;
    // Roll the called-position baseline silently too, so a position the field
    // shuffles into during the caution doesn't surface as a phantom gain/loss
    // when green flies (issue #597).
    state.lastCalledPosition = currentPos;
    state.pendingOvertakePos = -1;
    state.pendingLossPos = -1;

    return;
  }

  if (!state.overtakeInitialized) {
    state.lastPosition = overallPos;
    state.lastClassPosition = rawClassPos;
    state.lastCalledPosition = currentPos;
    state.overtakeInitialized = true;

    return;
  }

  // ── Confirm pending GAIN ──────────────────────────────────────────────
  if (state.pendingOvertakePos > 0) {
    if (currentPos <= state.pendingOvertakePos) {
      if (now - state.pendingOvertakeTime >= OVERTAKE_HOLD_MS) {
        const carBehindIdx = useClass ? -1 : findCarIdxAtPosition(positions, currentPos + 1);
        const gapBehindMeters = computeGapMeters(telemetry, playerCarIdx, carBehindIdx, trackLengthMeters);

        if (gapBehindMeters === undefined || gapBehindMeters >= OVERTAKE_MIN_GAP_M) {
          // Round-trip suppression (issue #597): when the confirmed position
          // equals the last position we actually announced, the net change
          // since the last callout is zero — e.g. P10 → P9 → P10 where the
          // intermediate P9 never sustained long enough to be announced. Clear
          // the pending without emitting so a round-trip back to the called
          // position speaks neither a gain nor a loss.
          if (currentPos !== state.lastCalledPosition) {
            const data: {
              carIdx: number;
              sustained: number;
              position: number;
              previousPosition: number;
              gapBehindMeters?: number;
              isLeader: boolean;
              classPosition?: number;
              previousClassPosition?: number;
              isMultiClass?: boolean;
            } = {
              carIdx: playerCarIdx,
              sustained: now - state.pendingOvertakeTime,
              position: overallPos,
              previousPosition: state.pendingOvertakePrevPos,
              isLeader: overallPos === 1,
            };

            if (gapBehindMeters !== undefined) data.gapBehindMeters = gapBehindMeters;

            if (rawClassPos > 0) data.classPosition = rawClassPos;

            if (state.pendingOvertakePrevClassPos > 0) data.previousClassPosition = state.pendingOvertakePrevClassPos;

            if (isMultiClass !== null) data.isMultiClass = isMultiClass;

            emit({ event: "overtake.completed", data });

            state.lastCalledPosition = currentPos;
            state.lastConfirmedOvertakeCarIdx = carBehindIdx;
          }

          state.pendingOvertakePos = -1;
          state.pendingOvertakePrevPos = 0;
          state.pendingOvertakePrevClassPos = 0;
        }
        // Gap still too small — hold the pending state, re-check next tick.
      }

      // Re-check pendingOvertakePos > 0 in case the emit above just reset it
      // — `currentPos < -1` is naturally false for any valid position, so this
      // guard is belt-and-braces parallel to the loss side where the inverse
      // comparison would re-establish a phantom pending.
      if (state.pendingOvertakePos > 0 && currentPos < state.pendingOvertakePos) {
        // Player gained further (e.g. 5 → 4 → 3 within the same hold window).
        // Update the pending pos AND the "previous" baseline stays where it
        // was, so the emit's `previousPosition` still reflects pre-pass.
        state.pendingOvertakePos = currentPos;
      }
    } else {
      // Player gave the spot back — drop the pending gain.
      state.pendingOvertakePos = -1;
      state.pendingOvertakePrevPos = 0;
      state.pendingOvertakePrevClassPos = 0;
    }
  }

  // ── Confirm pending LOSS ──────────────────────────────────────────────
  if (state.pendingLossPos > 0) {
    if (currentPos >= state.pendingLossPos) {
      if (now - state.pendingLossTime >= OVERTAKE_HOLD_MS) {
        const carAheadIdx = useClass ? -1 : findCarIdxAtPosition(positions, currentPos - 1);
        const gapAheadMeters = computeGapMeters(telemetry, playerCarIdx, carAheadIdx, trackLengthMeters);

        if (gapAheadMeters === undefined || gapAheadMeters >= OVERTAKE_MIN_GAP_M) {
          // Round-trip suppression (issue #597) — mirror of the gain side: a
          // loss back to the last announced position is a no-op since the last
          // callout, so suppress it.
          if (currentPos !== state.lastCalledPosition) {
            const data: {
              carIdx: number;
              sustained: number;
              position: number;
              previousPosition: number;
              gapAheadMeters?: number;
              classPosition?: number;
              previousClassPosition?: number;
              isMultiClass?: boolean;
            } = {
              carIdx: playerCarIdx,
              sustained: now - state.pendingLossTime,
              position: overallPos,
              previousPosition: state.pendingLossPrevPos,
            };

            if (gapAheadMeters !== undefined) data.gapAheadMeters = gapAheadMeters;

            if (rawClassPos > 0) data.classPosition = rawClassPos;

            if (state.pendingLossPrevClassPos > 0) data.previousClassPosition = state.pendingLossPrevClassPos;

            if (isMultiClass !== null) data.isMultiClass = isMultiClass;

            emit({ event: "overtake.lost", data });

            state.lastCalledPosition = currentPos;
          }

          state.pendingLossPos = -1;
          state.pendingLossPrevPos = 0;
          state.pendingLossPrevClassPos = 0;
        }
        // Gap still too small — hold the pending state, re-check next tick.
      }

      // Re-check pendingLossPos > 0: the emit above resets it to -1, and
      // `currentPos > -1` would otherwise re-establish a phantom pending on
      // the same tick (every valid position is > -1). Without the guard,
      // pendingLossPos rebounds to currentPos and the next tick re-emits.
      if (state.pendingLossPos > 0 && currentPos > state.pendingLossPos) {
        // Player lost further ground within the same hold window.
        state.pendingLossPos = currentPos;
      }
    } else {
      // Player won the spot back — drop the pending loss.
      state.pendingLossPos = -1;
      state.pendingLossPrevPos = 0;
      state.pendingLossPrevClassPos = 0;
    }
  }

  // ── Detect NEW gain ───────────────────────────────────────────────────
  // Compare the EFFECTIVE position (class in multi-class) against its baseline,
  // but record the overall + class "previous" values so the payload stays
  // accurate in both spaces.
  if (lastEffective > 0 && currentPos < lastEffective && state.pendingOvertakePos < 0) {
    const jump = lastEffective - currentPos;

    if (jump <= OVERTAKE_MAX_JUMP) {
      state.pendingOvertakePos = currentPos;
      state.pendingOvertakeTime = now;
      state.pendingOvertakePrevPos = state.lastPosition;
      state.pendingOvertakePrevClassPos = state.lastClassPosition;
    }
  }

  // ── Detect NEW loss ───────────────────────────────────────────────────
  if (lastEffective > 0 && currentPos > lastEffective && state.pendingLossPos < 0) {
    const jump = currentPos - lastEffective;

    if (jump <= OVERTAKE_MAX_JUMP) {
      state.pendingLossPos = currentPos;
      state.pendingLossTime = now;
      state.pendingLossPrevPos = state.lastPosition;
      state.pendingLossPrevClassPos = state.lastClassPosition;
    }
  }

  state.lastPosition = overallPos;
  state.lastClassPosition = rawClassPos;
}

/**
 * Reset all overtake tracking — used when the player leaves an eligible
 * state (race + on track + not in pit). Pulled out so the gain and loss
 * trackers can never drift out of sync on a state-exit transition.
 */
function resetOvertakeState(state: TranslatorState): void {
  state.overtakeInitialized = false;
  state.lastPosition = -1;
  state.lastClassPosition = 0;
  state.lastCalledPosition = -1;
  state.pendingOvertakePos = -1;
  state.pendingOvertakePrevPos = 0;
  state.pendingOvertakePrevClassPos = 0;
  state.pendingLossPos = -1;
  state.pendingLossPrevPos = 0;
  state.pendingLossPrevClassPos = 0;
  state.lastConfirmedOvertakeCarIdx = -1;
}

/**
 * Find the car index whose rank in the calculated race positions array
 * equals `targetRank`. Returns `-1` when no car holds that rank (e.g. the
 * field is smaller than `targetRank`, or the target slot is vacant
 * because the car DCed mid-tick).
 */
function findCarIdxAtPosition(positions: number[], targetRank: number): number {
  for (let i = 0; i < positions.length; i++) {
    if (positions[i] === targetRank) return i;
  }

  return -1;
}

/**
 * Compute the on-track gap in meters between two cars, using
 * `CarIdxLapDistPct` (fractional progress on the current lap) and the
 * parsed track length. Returns `undefined` when any input is unavailable
 * — the caller treats that as "no gap data" and skips the physical-gap
 * gate rather than punishing missing data.
 *
 * The distance wraps around the lap (a player at 0.95 lap pct and a car
 * just behind them at 0.02 lap pct are ~7% of the lap apart, not 93%),
 * so the delta is folded into the shorter direction before scaling.
 */
function computeGapMeters(
  telemetry: TelemetryData,
  idxA: number,
  idxB: number,
  trackLengthMeters: number | null,
): number | undefined {
  if (idxA < 0 || idxB < 0 || trackLengthMeters === null || trackLengthMeters <= 0) return undefined;

  const distPct = telemetry.CarIdxLapDistPct as number[] | undefined;

  if (!Array.isArray(distPct)) return undefined;

  const pctA = distPct[idxA];
  const pctB = distPct[idxB];

  if (typeof pctA !== "number" || typeof pctB !== "number" || pctA < 0 || pctB < 0) return undefined;

  let delta = Math.abs(pctA - pctB);

  if (delta > 0.5) delta = 1 - delta;

  return delta * trackLengthMeters;
}
