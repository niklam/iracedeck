/**
 * Rolling-start "one pace lap to go" (issue #657).
 *
 * iRacing's `OneLapToGreen` (`0x200`) bit is "formation in progress", NOT "one
 * lap to go": it is asserted from `GetInCar` and held through the entire parade
 * in both 1-lap and 2-lap formations, and it re-rises in cool-down. So the old
 * raw-edge trigger never fired during the actual pace lap (the bit was already
 * set when the flag diff seeded) and mis-fired after the race (the bit re-rose).
 *
 * This diff replaces it with a start/finish-crossing heuristic under the
 * assumption of **at most two pace laps**: announce "one pace lap to go" at the
 * S/F crossing that COMPLETES the first full pace lap (= the start of the final
 * lap on a 2-lap rolling formation), while the green is not yet held.
 *
 * **The PACE CAR's crossing, not the player's (issue #773).** The pace car
 * leads the field, so it crosses S/F — and commits everyone to another lap —
 * noticeably before the player does, especially from the mid/back of a long
 * grid. The crossing tracked is therefore the pace car's
 * (`CarIdxLapDistPct[paceCarIdx]`, resolved from `DriverInfo.PaceCarIdx` /
 * `CarIsPaceCar` at the formation's entry edge), with the player's own
 * `LapDistPct` as the fallback whenever the pace car can't be resolved or its
 * per-car telemetry is invalid — missing data must never silence the cue.
 *
 * **Distinguishing the completion crossing from the grid release.** The grid
 * release also crosses S/F as the field is let go into `ParadeLaps`. Both
 * crossings have the green un-held, so the discriminator is how far the car has
 * driven: the release crossing sits at ~0 lap accrued since entering
 * `ParadeLaps`; the first-pace-lap completion sits at ~1. The `>= 0.5` accrued
 * guard separates them robustly, regardless of where the `Warmup→ParadeLaps`
 * state flip lands relative to the line. The same guard holds for the pace
 * car: iRacing stages it near the S/F straight (pit exit area), so its
 * release crossing also sits well under half a lap accrued.
 *
 * **Rolling-only / 1-lap.** Standing starts never enter `ParadeLaps` and are
 * additionally guarded on `resolveStandingStart`, so the cue is rolling-only. A
 * 1-lap formation has no completion crossing before the green (the green flies
 * at the line / `SessionState` flips to `Racing`), so it stays silent — green
 * held still says "green's coming".
 *
 * First tick after connect seeds without arming, so connecting mid-parade never
 * synthesizes the cue (same caveat as the gantry bits). State resets on any
 * non-`ParadeLaps` tick, so the next session's formation re-arms cleanly.
 */
import { Flags, hasFlag, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";

import { resolveStandingStart } from "../start-lights.js";
import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/**
 * A backward jump in `LapDistPct` of more than half a lap is an S/F crossing
 * (the fraction wrapped from near 1 to near 0). Using a half-lap delta rather
 * than fixed `>0.9 / <0.1` bands tolerates an occasional dropped tick.
 *
 * @internal Exported for testing.
 */
export const PACE_LAP_SF_WRAP_THRESHOLD = 0.5;

/**
 * Minimum forward distance (laps) accrued since entering `ParadeLaps` for an S/F
 * crossing to count as the first-pace-lap COMPLETION rather than the grid
 * release (which sits at ~0 accrued). The completion crossing sits at ~1.
 *
 * @internal Exported for testing.
 */
export const PACE_LAP_MIN_ACCRUED = 0.5;

/** A usable lap-distance fraction: finite and non-negative (`-1` = invalid). */
function isValidDist(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Resolve the pace car's `CarIdx` from session YAML (issue #773). Prefers the
 * direct `DriverInfo.PaceCarIdx` field, falls back to scanning
 * `DriverInfo.Drivers` for `CarIsPaceCar === 1`, and returns `null` when
 * neither resolves — the caller then tracks the player instead.
 *
 * @internal Exported for testing.
 */
export function resolvePaceCarIdx(sessionInfo: Record<string, unknown> | null): number | null {
  const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;

  const direct = driverInfo?.PaceCarIdx;

  if (typeof direct === "number" && Number.isInteger(direct) && direct >= 0) return direct;

  const drivers = driverInfo?.Drivers;

  if (Array.isArray(drivers)) {
    for (const driver of drivers as Array<Record<string, unknown> | null>) {
      if (driver?.CarIsPaceCar === 1 && typeof driver.CarIdx === "number" && driver.CarIdx >= 0) {
        return driver.CarIdx;
      }
    }
  }

  return null;
}

/** The tracked car's lap-distance fraction for this tick — pace car or player. */
function readTrackedDist(state: TranslatorState, telemetry: TelemetryData): unknown {
  if (state.paceLapSourceCarIdx !== null) {
    const perCar = telemetry.CarIdxLapDistPct;

    return Array.isArray(perCar) ? perCar[state.paceLapSourceCarIdx] : undefined;
  }

  return telemetry.LapDistPct;
}

export function diffPaceLaps(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  emit: EmitFn,
): void {
  const sessionState = typeof telemetry.SessionState === "number" ? telemetry.SessionState : SessionState.Invalid;
  const inParade = sessionState === SessionState.ParadeLaps;

  // First tick — seed the baseline without arming.
  if (!state.paceLapInitialized) {
    state.paceLapInitialized = true;
    state.lastTickInParadeLaps = inParade;

    return;
  }

  // Outside the formation — reset so the next formation re-arms cleanly. A
  // mid-race caution restart stays in `Racing` (never re-enters `ParadeLaps`),
  // so clearing the latch here can't let the cue re-fire in the same race.
  if (!inParade) {
    state.paceLapArmed = false;
    state.paceLapAccrued = 0;
    state.onePaceLapToGoFired = false;
    state.lastTickInParadeLaps = false;
    state.paceLapSourceCarIdx = null;

    return;
  }

  // On the (potential) entry tick, pick the crossing source for this formation
  // (issue #773): the pace car when it resolves AND reports a valid distance
  // this tick, the player otherwise. Decided once at the entry edge so the
  // accrual never mixes two cars' positions.
  if (!state.lastTickInParadeLaps) {
    const paceCarIdx = resolvePaceCarIdx(sessionInfo);
    const perCar = telemetry.CarIdxLapDistPct;

    state.paceLapSourceCarIdx =
      paceCarIdx !== null && Array.isArray(perCar) && isValidDist(perCar[paceCarIdx]) ? paceCarIdx : null;
  }

  let lapDistPct = readTrackedDist(state, telemetry);

  // Mid-parade loss of the pace car's telemetry — switch to the player and
  // re-anchor the baseline at the player's position, WITHOUT folding a delta
  // across the source jump (which could read as a phantom S/F wrap). Accrued
  // distance carries over: both cars measure distance driven since the
  // formation started, and the 0.5-lap guard tolerates the small offset.
  if (state.paceLapSourceCarIdx !== null && state.lastTickInParadeLaps && !isValidDist(lapDistPct)) {
    const playerDist = telemetry.LapDistPct;

    if (isValidDist(playerDist)) {
      state.paceLapSourceCarIdx = null;
      state.paceLapLastDistPct = playerDist;
    }

    return;
  }

  // Need a valid, finite, non-negative lap distance to track crossings. `NaN`
  // passes `typeof === "number"` (and `NaN < 0` is false), so check
  // `Number.isFinite` explicitly — otherwise a NaN tick poisons the accrual and
  // defeats both the wrap and completion guards. Do NOT advance
  // `lastTickInParadeLaps` here: on the entry tick that would consume the entry
  // edge and the diff would never arm — leave it so the next valid tick is still
  // seen as the `*→ParadeLaps` entry.
  if (!isValidDist(lapDistPct)) {
    return;
  }

  // Entry edge — arm on a genuine `*→ParadeLaps` transition and anchor the
  // distance baseline. The grid-release crossing then accrues from ~0.
  if (!state.lastTickInParadeLaps) {
    state.paceLapArmed = true;
    state.paceLapAccrued = 0;
    state.paceLapLastDistPct = lapDistPct;
    state.lastTickInParadeLaps = true;

    return;
  }

  if (!state.paceLapArmed) return;

  // Forward distance since the last tick. A small backward `LapDistPct` jitter
  // (the packed grid concertinas the longitudinal position back a touch) must
  // count as ZERO forward — without the clamp the naive mod-1 fold turns a
  // -0.001 nudge into +0.999, so a single jitter tick inflates the accrual past
  // the completion guard and false-fires on the grid-release crossing. A large
  // backward delta is the genuine S/F wrap and folds forward.
  const last = state.paceLapLastDistPct;
  const delta = lapDistPct - last;
  const crossedSF = delta <= -PACE_LAP_SF_WRAP_THRESHOLD;
  let forward = 0;

  if (delta >= 0) forward = delta;
  else if (crossedSF) forward = delta + 1;

  const accruedBefore = state.paceLapAccrued;
  state.paceLapAccrued = accruedBefore + forward;
  state.paceLapLastDistPct = lapDistPct;

  // Only act on the tick the car crosses start/finish.
  if (!crossedSF) return;

  if (state.onePaceLapToGoFired) return;

  // Only the first-pace-lap completion (≈1 lap driven), not the grid release.
  if (accruedBefore < PACE_LAP_MIN_ACCRUED) return;

  // Rolling start only — never on a standing grid.
  if (resolveStandingStart(sessionInfo)) return;

  const sessionFlags = telemetry.SessionFlags ?? 0;

  // Formation must still be in progress (the "pre-green" signal) and the green
  // not imminent/started — that moment belongs to green-held / start-go, and a
  // 1-lap formation crosses S/F only as the green flies.
  if (!hasFlag(sessionFlags, Flags.OneLapToGreen)) return;

  if (
    hasFlag(sessionFlags, Flags.GreenHeld) ||
    hasFlag(sessionFlags, Flags.StartGo) ||
    hasFlag(sessionFlags, Flags.Green)
  ) {
    return;
  }

  state.onePaceLapToGoFired = true;
  emit({ event: "flag.one-pace-lap-to-go.raised", data: {} });
}
