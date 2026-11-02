/**
 * When the race leader takes the chequered flag in a timed race (issue
 * #1405): the one crossing model the gap horizon (#1311) and the fuel
 * race-coverage estimate share, so the two cannot disagree about when the
 * race ends.
 *
 * The session clock expiring does not end a timed race. The leader takes the
 * white at their first line crossing at or after expiry, and the chequered at
 * the crossing after that (the #880 model `leader-white.ts` detects live).
 * With `t` seconds on the clock, the leader's lap time `L` and their lap
 * fraction `f`, the leader's k-th crossing from now is at `(k − f) · L`, so the
 * white is crossing `k = ceil(t / L + f)` — {@link leaderWhiteCrossingIndex}.
 *
 * The consumers keep their own fallbacks, because their safe directions are
 * opposite. The gap horizon takes an unknown leader fraction as `0`, the
 * smaller count, since a short horizon only withholds an announcement. The
 * fuel estimate must not count too few laps — that silences a warning the
 * driver needs — so {@link predictLeaderChequeredS} answers `null` instead,
 * and the fuel code falls back to its cautious bound.
 *
 * Pure: the caller supplies the canonical live order
 * (`.claude/rules/race-positions.md`) and the leader's lap time
 * (`resolveLeaderLapTimeS` in `translator.ts`, taken as a parameter so this
 * module imports nothing from the translator).
 *
 * Spec: `docs/superpowers/specs/2026-10-10-issue-1405-fuel-race-end-coverage.md`.
 */
import { resolveTimeRemainingS, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

/**
 * The fixed part of the fuel estimate's near-tie tolerance (laps): about 3 s
 * on a 100 s lap. A leader predicted to cross just after expiry may cross
 * just before it, so a near-tie counts the later crossing — one lap more,
 * which errs towards warning (the direction #880 chose). A first value, to be
 * checked against the spec's manual test.
 */
export const FUEL_FINISH_TOLERANCE_LAPS = 0.03;

/**
 * The part of the tolerance that grows with the distance to expiry: 1 % of
 * the laps until the clock runs out, since pace drifts more over a longer
 * stretch. A first value, like {@link FUEL_FINISH_TOLERANCE_LAPS}.
 */
export const FUEL_FINISH_PACE_DRIFT = 0.01;

/**
 * What the fuel race-coverage estimate is handed about the race leader: their
 * recent lap time and the predicted seconds until they take the chequered
 * flag, each `null` when unknown.
 */
export type LeaderFinish = {
  /** `resolveLeaderLapTimeS` — the leader's recent lap time (s). */
  lapTimeS: number | null;
  /** {@link predictLeaderChequeredS} — seconds until the leader's chequered flag. */
  chequeredInS: number | null;
};

/**
 * Which of the leader's line crossings from now is the white flag: the first
 * at or after the clock expires, `ceil(t / L + f + toleranceLaps)`. The
 * crossing at `(k − f) · L` is at or after `t` exactly when `k ≥ t / L + f`;
 * the tolerance moves a near-tie to the later crossing.
 *
 * @param timeRemainS - seconds on the clock (`t ≥ 0`)
 * @param leaderLapS - the leader's lap time (s), positive
 * @param leaderPct - the leader's lap fraction (0 ≤ f < 1)
 * @param toleranceLaps - laps added before the ceiling; `0` for the exact model
 */
export function leaderWhiteCrossingIndex(
  timeRemainS: number,
  leaderLapS: number,
  leaderPct: number,
  toleranceLaps: number,
): number {
  return Math.ceil(timeRemainS / leaderLapS + leaderPct + toleranceLaps);
}

/**
 * The fuel estimate's near-tie tolerance (laps) for a clock with
 * `timeRemainS` seconds left, measured in laps of `lapTimeS`:
 * `FUEL_FINISH_TOLERANCE_LAPS + FUEL_FINISH_PACE_DRIFT × (t / L)`. Pass `0`
 * once the clock has expired, where only the fixed part remains.
 *
 * @param timeRemainS - seconds on the clock, `0` once expired
 * @param lapTimeS - the lap time the distance to expiry is measured in, positive
 */
export function fuelFinishToleranceLaps(timeRemainS: number, lapTimeS: number): number {
  return FUEL_FINISH_TOLERANCE_LAPS + FUEL_FINISH_PACE_DRIFT * (timeRemainS / lapTimeS);
}

/**
 * Seconds until the race leader takes the chequered flag in a timed race, or
 * `null` when that cannot be predicted.
 *
 * - **Clock running** (`SessionTimeRemain > 0`): the white is crossing
 *   `k = ceil(t / L + f + ε)` ({@link leaderWhiteCrossingIndex}, with `ε` from
 *   {@link fuelFinishToleranceLaps}) and the chequered the one after it, at
 *   `(k + 1 − f) · L`.
 * - **Clock expired** (`SessionTimeRemain ≤ 0`): `(1 − f) · L` once the
 *   leader has crossed since expiry — they are on the white lap — otherwise
 *   `(2 − f) · L`. The marker is `state.leaderWhitePostExpiryCrossed`, which
 *   `diffLeaderWhite` has updated earlier in the same tick.
 * - **`null`** when the clock is unknown or unlimited, the leader is
 *   unresolved, has no lap time, has no usable lap fraction (missing, `-1`
 *   off-world, or not below 1 — never taken as `0`), or is in the pits by
 *   `CarIdxTrackSurface` (`InPitStall` or `AproachingPits`; never
 *   `CarIdxOnPitRoad`, which `race-finish.ts` documents as unreliable). A
 *   leader in the pits is about to lose time the lap time does not know of.
 *
 * Accepted residuals of the expired branch, both under-counts that the fuel
 * diff absorbs because a suppression never advances its dedup floor — the
 * next lap's sample judges again:
 *
 * - The marker is also set by a lead change while expired (`leader-white.ts`
 *   absorbs it, since it cannot see a crossing across the flip), so a
 *   genuine mid-lap change of leader before the white reads one leader lap
 *   short until the new leader takes the white — at most one leader lap, so
 *   at most the one sample that lands inside it.
 * - iRacing can blip `SessionTimeRemain ≤ 0` for a tick mid-race (the #666
 *   transient). A blip on the very tick of the mid-lap sample reads the race
 *   as ending within two leader laps, which can under-count it by more than a
 *   lap for that one sample — enough to suppress a warning, or to speak the
 *   enough-fuel confirmation early. `leader-white.ts` confirms expiry over
 *   two ticks; this answer has no state of its own to do so, and the window
 *   is one tick in a lap's worth.
 *
 * @param telemetry - the tick's telemetry
 * @param positions - the tick's canonical live order (1-based rank by car index)
 * @param leaderLapTimeS - the leader's recent lap time (s) from `resolveLeaderLapTimeS`, or `null`
 * @param leaderCrossedSinceExpiry - `state.leaderWhitePostExpiryCrossed` after this tick's `diffLeaderWhite`
 */
export function predictLeaderChequeredS(
  telemetry: TelemetryData,
  positions: number[],
  leaderLapTimeS: number | null,
  leaderCrossedSinceExpiry: boolean,
): number | null {
  const raw = telemetry.SessionTimeRemain;
  const expired = typeof raw === "number" && Number.isFinite(raw) && raw <= 0;
  const timeRemainS = expired ? 0 : resolveTimeRemainingS(telemetry);

  if (timeRemainS === null) return null;

  if (leaderLapTimeS === null || !Number.isFinite(leaderLapTimeS) || leaderLapTimeS <= 0) return null;

  const leaderIdx = positions.findIndex((position) => position === 1);

  if (leaderIdx < 0) return null;

  const leaderPct = telemetry.CarIdxLapDistPct?.[leaderIdx];

  if (typeof leaderPct !== "number" || !Number.isFinite(leaderPct) || leaderPct < 0 || leaderPct >= 1) return null;

  const surface = telemetry.CarIdxTrackSurface?.[leaderIdx];

  if (surface === TrkLoc.InPitStall || surface === TrkLoc.AproachingPits) return null;

  if (expired) return ((leaderCrossedSinceExpiry ? 1 : 2) - leaderPct) * leaderLapTimeS;

  const white = leaderWhiteCrossingIndex(
    timeRemainS,
    leaderLapTimeS,
    leaderPct,
    fuelFinishToleranceLaps(timeRemainS, leaderLapTimeS),
  );

  return (white + 1 - leaderPct) * leaderLapTimeS;
}
