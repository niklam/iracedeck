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
 * Consecutive ticks of an expired clock reading that confirm a real expiry:
 * the two-tick confirmation `leader-white.ts` uses, since iRacing can blip
 * `SessionTimeRemain ≤ 0` for a single tick mid-race (the #666 transient).
 */
export const CLOCK_EXPIRY_CONFIRM_TICKS = 2;

/**
 * Whether `telemetry`'s raw `SessionTimeRemain` reads an expired clock:
 * finite and ≤ 0. A clock at exactly zero is expired — the leader's next
 * crossing is the white.
 */
export function isClockExpiredReading(telemetry: TelemetryData): boolean {
  const raw = telemetry.SessionTimeRemain;

  return typeof raw === "number" && Number.isFinite(raw) && raw <= 0;
}

/**
 * The consecutive-expired-ticks count after `telemetry`: one more than
 * `previous` on an expired reading ({@link isClockExpiredReading}), `0` on
 * any other. The fuel diff keeps it in `state.fuelCalloutClockExpiredTicks`.
 *
 * @param telemetry - the tick's telemetry
 * @param previous - the count after the previous tick
 */
export function countClockExpiredTicks(telemetry: TelemetryData, previous: number): number {
  return isClockExpiredReading(telemetry) ? previous + 1 : 0;
}

/**
 * Whether a count from {@link countClockExpiredTicks} confirms the expiry:
 * at least {@link CLOCK_EXPIRY_CONFIRM_TICKS} ticks in a row.
 */
export function isClockExpiryConfirmed(expiredTicks: number): boolean {
  return expiredTicks >= CLOCK_EXPIRY_CONFIRM_TICKS;
}

/**
 * What {@link predictLeaderChequeredS} is told about an expired clock: whether
 * the expiry is confirmed, and whether the leader has crossed the line since.
 */
export type LeaderClockExpiry = {
  /** {@link isClockExpiryConfirmed} over `state.fuelCalloutClockExpiredTicks`, this tick included. */
  confirmed: boolean;
  /** `state.leaderWhitePostExpiryCrossed` after this tick's `diffLeaderWhite`. */
  leaderCrossed: boolean;
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
 * - **Clock expired** (`SessionTimeRemain ≤ 0` on this tick and the one
 *   before, `expiry.confirmed`): `(1 − f) · L` once the leader has crossed
 *   since expiry — they are on the white lap — otherwise `(2 − f) · L`. The
 *   marker is `state.leaderWhitePostExpiryCrossed`, which `diffLeaderWhite`
 *   has updated earlier in the same tick.
 * - **`null`** for an expired reading that is not confirmed yet: it may be
 *   the one-tick blip iRacing can produce mid-race (the #666 transient),
 *   which read as an expiry would end the race within two leader laps and
 *   could suppress a warning or speak the enough-fuel confirmation on the
 *   sample it lands on. A real expiry is confirmed one tick later, which
 *   costs nothing: it holds for thousands of ticks before the leader's
 *   crossing. The fuel estimate leaves its timed side unknown meanwhile.
 * - **`null`** when the clock is unknown or unlimited, the leader is
 *   unresolved, has no lap time, has no usable lap fraction (missing, `-1`
 *   off-world, or not below 1 — never taken as `0`), or is in the pits by
 *   `CarIdxTrackSurface` (`InPitStall` or `AproachingPits`; never
 *   `CarIdxOnPitRoad`, which `race-finish.ts` documents as unreliable). A
 *   leader in the pits is about to lose time the lap time does not know of.
 *
 * Accepted residual of the expired branch, an under-count that the fuel diff
 * absorbs because a suppression never advances its dedup floor — the next
 * lap's sample judges again: the marker is also set by a lead change while
 * expired (`leader-white.ts` absorbs it, since it cannot see a crossing
 * across the flip), so a genuine mid-lap change of leader before the white
 * reads one leader lap short until the new leader takes the white — at most
 * one leader lap, so at most the one sample that lands inside it.
 *
 * @param telemetry - the tick's telemetry
 * @param positions - the tick's canonical live order (1-based rank by car index)
 * @param leaderLapTimeS - the leader's recent lap time (s) from `resolveLeaderLapTimeS`, or `null`
 * @param expiry - whether an expired reading is confirmed, and whether the leader has crossed since
 */
export function predictLeaderChequeredS(
  telemetry: TelemetryData,
  positions: number[],
  leaderLapTimeS: number | null,
  expiry: LeaderClockExpiry,
): number | null {
  const expired = isClockExpiredReading(telemetry);

  if (expired && !expiry.confirmed) return null;

  const timeRemainS = expired ? 0 : resolveTimeRemainingS(telemetry);

  if (timeRemainS === null) return null;

  if (leaderLapTimeS === null || !Number.isFinite(leaderLapTimeS) || leaderLapTimeS <= 0) return null;

  const leaderIdx = positions.findIndex((position) => position === 1);

  if (leaderIdx < 0) return null;

  const leaderPct = telemetry.CarIdxLapDistPct?.[leaderIdx];

  if (typeof leaderPct !== "number" || !Number.isFinite(leaderPct) || leaderPct < 0 || leaderPct >= 1) return null;

  const surface = telemetry.CarIdxTrackSurface?.[leaderIdx];

  if (surface === TrkLoc.InPitStall || surface === TrkLoc.AproachingPits) return null;

  if (expired) return ((expiry.leaderCrossed ? 1 : 2) - leaderPct) * leaderLapTimeS;

  const white = leaderWhiteCrossingIndex(
    timeRemainS,
    leaderLapTimeS,
    leaderPct,
    fuelFinishToleranceLaps(timeRemainS, leaderLapTimeS),
  );

  return (white + 1 - leaderPct) * leaderLapTimeS;
}
