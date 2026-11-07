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
 * driver needs — so {@link predictLeaderChequered} answers `null` instead,
 * and the fuel code falls back to its cautious bound.
 *
 * For the fuel estimate the prediction comes in two units, from one model:
 * the seconds until the chequered and the leader's line crossings up to and
 * including it. The crossings, with the two cars' lap counters
 * ({@link readLeaderGap}), let a player within a lap of the leader, now and
 * at the flag, be counted by laps rather than by time — see
 * `resolveFuelRaceCoverage`.
 * {@link resolveLeaderFinish} bundles them for the fuel diff. The lap-count
 * test and count themselves ({@link staysWithinLapAtChequered},
 * {@link lapCountCrossings}) are shared with the gap horizon too (#1380),
 * which converts the leader's crossings into the player's.
 *
 * Pure: the caller supplies the canonical live order
 * (`.claude/rules/race-positions.md`), the player's car index and the
 * leader's lap time (`resolveLeaderLapTimeS` in `translator.ts`, taken as a
 * parameter so this module imports nothing from the translator).
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
 * The leader's predicted chequered flag ({@link predictLeaderChequered}), in
 * both units the fuel estimate reads, from one count: `inS` is
 * `(crossings − f) · L`.
 */
export type LeaderChequered = {
  /** Seconds from now until the leader takes the chequered flag. */
  inS: number;
  /** The leader's line crossings from now up to and including the chequered one. */
  crossings: number;
};

/**
 * Where the player is against the race leader on the lap counters
 * ({@link readLeaderGap}).
 */
export type LeaderGap = {
  /** The leader's `CarIdxLapCompleted`. */
  leaderLapsCompleted: number;
  /** The player's `CarIdxLapCompleted`. */
  playerLapsCompleted: number;
  /**
   * The leader's distance less the player's, in laps:
   * `(LC_L + f_L) − (LC_p + f_p)`. Positive while the player is behind; `0`
   * when the player is the leader.
   */
  distanceLaps: number;
};

/**
 * What the fuel race-coverage estimate is handed about the race leader
 * ({@link resolveLeaderFinish}): their recent lap time, the predicted
 * chequered flag in seconds and in crossings, and the player's place against
 * them on the lap counters, each `null` when unknown.
 */
export type LeaderFinish = {
  /** `resolveLeaderLapTimeS` — the leader's recent lap time (s). */
  lapTimeS: number | null;
  /** {@link LeaderChequered.inS} — seconds until the leader's chequered flag. */
  chequeredInS: number | null;
  /** {@link LeaderChequered.crossings} — `null` exactly when `chequeredInS` is. */
  crossingsToChequered: number | null;
  /**
   * The same prediction at the lap-count pace `min(L, P)` — the leader's lap
   * time capped at the player's validated average — with that pace, for the
   * fuel estimate's lap-count path (see {@link resolveLeaderFinish}); `null`
   * without a prediction or a player average.
   */
  lapCountChequered: (LeaderChequered & { lapTimeS: number }) | null;
  /** {@link readLeaderGap}. */
  leaderGap: LeaderGap | null;
};

/** A {@link LeaderFinish} that knows nothing: no leader, or no order to find one in. */
export const UNKNOWN_LEADER_FINISH: LeaderFinish = Object.freeze({
  lapTimeS: null,
  chequeredInS: null,
  crossingsToChequered: null,
  lapCountChequered: null,
  leaderGap: null,
});

/**
 * How close to the line (lap fraction) a car's `CarIdxLapDistPct` may be
 * before {@link readLeaderGap} stops trusting its pairing with
 * `CarIdxLapCompleted`. Around a crossing the two can disagree — the fraction
 * already wrapped with the lap count not yet moved, or the other way round —
 * and either reads a full lap off; a stale leader count reads the player's
 * laps one LOW, the unsafe direction. How long the arrays can disagree has
 * not been measured: the one capture that pairs a lap count with another
 * per-car array shows `CarIdxLastLapTime` arriving up to about a second after
 * `CarIdxLapCompleted` moves. Three percent is three seconds on a 100 s lap
 * and 1.2 s on a 40 s oval, so a lag of that order lands inside it. Inside it
 * the gap is unknown and the fuel estimate counts by time with the near-tie
 * tolerance instead, which errs towards warning.
 */
export const LAP_LINE_GUARD_PCT = 0.03;

/**
 * Consecutive ticks of an expired clock reading that confirm a real expiry:
 * about one second at iRacing's ~60 Hz (the SDK controller dedupes ticks by
 * `SessionTick`). iRacing can blip `SessionTimeRemain ≤ 0` for a tick or two
 * mid-race (the #666 transient), so the two-tick rule `leader-white.ts` keeps
 * for its own edge is too short here: a two-tick blip whose second tick lands
 * on the mid-lap sample would end the race at the blip and could speak a
 * false mid-race "enough fuel to finish", which latches and clears the
 * warning floor. A real expiry holds for minutes; during its first second the
 * fuel estimate's timed side is unknown, which keeps announcing — the
 * cautious direction.
 */
export const CLOCK_EXPIRY_CONFIRM_TICKS = 60;

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
 * any other. The fuel diff keeps it in `state.fuelCallout.clockExpiredTicks`.
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
 * What {@link predictLeaderChequered} is told about an expired clock: whether
 * the expiry is confirmed, and whether the leader has crossed the line since.
 */
export type LeaderClockExpiry = {
  /** {@link isClockExpiryConfirmed} over `state.fuelCallout.clockExpiredTicks`, this tick included. */
  confirmed: boolean;
  /**
   * `state.leaderWhitePostExpiryCrossed` after this tick's `diffLeaderWhite`;
   * trusted only when the leader's lap position agrees with the clock (see
   * {@link predictLeaderChequered}).
   */
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
 * When the race leader takes the chequered flag in a timed race — in
 * crossings from now, the chequered included, and in seconds,
 * `(crossings − f) · L` — or `null` when that cannot be predicted.
 *
 * - **Clock running** (`SessionTimeRemain > 0`): the white is crossing
 *   `k = ceil(t / L + f + ε)` ({@link leaderWhiteCrossingIndex}, with `ε` from
 *   {@link fuelFinishToleranceLaps}) and the chequered the one after it:
 *   `k + 1` crossings.
 * - **Clock expired** (`SessionTimeRemain ≤ 0` for
 *   {@link CLOCK_EXPIRY_CONFIRM_TICKS} ticks in a row, `expiry.confirmed`):
 *   one crossing once the leader has crossed since expiry — they are on the
 *   white lap — otherwise two. See below for when a crossing is trusted.
 * - **`null`** for an expired reading that is not confirmed yet: it may be
 *   the blip of a tick or two iRacing can produce mid-race (the #666
 *   transient), which read as an expiry would end the race within two leader
 *   laps and could suppress a warning or speak the enough-fuel confirmation
 *   on the sample it lands on. A real expiry is confirmed about a second
 *   later and holds for minutes; the fuel estimate leaves its timed side
 *   unknown meanwhile.
 * - **`null`** when the clock is unknown or unlimited, the leader is
 *   unresolved, has no lap time, has no usable lap fraction (missing, `-1`
 *   off-world, or not below 1 — never taken as `0`), or is in the pits by
 *   `CarIdxTrackSurface` (`InPitStall` or `AproachingPits`; never
 *   `CarIdxOnPitRoad`, which `race-finish.ts` documents as unreliable). A
 *   leader in the pits is about to lose time the lap time does not know of.
 *
 * **The `-1` clock before the start.** Real captures read
 * `SessionTimeRemain = -1` before the race clock starts — through
 * `ParadeLaps`, and in `Racing` until the leader's first crossing — which this
 * reads as an expired clock, confirmed after a second. Nothing here guards
 * against it; two things elsewhere make it harmless. In `ParadeLaps` the
 * leader has no lap time (`resolveLeaderLapTimeS` answers `null` pre-green,
 * since the board holds the parade lap), so there is no prediction, and with
 * an expired clock no bound either: the fuel estimate's timed side is
 * unknown and its callout keeps announcing. In `Racing` before the first
 * crossing the leader's lap time is that parade lap, but the fuel tracker's
 * deferred session wipe lands on the first `Racing` tick (`fuel-laps.ts`,
 * held through `isPreGreen`), so the fuel diff has no average and returns
 * before it asks for a prediction. A change to either needs a guard here.
 *
 * **When the leader has crossed since expiry.** The marker
 * (`state.leaderWhitePostExpiryCrossed`, which `diffLeaderWhite` has updated
 * earlier in the same tick) is set by an observed crossing, but ALSO by a
 * lead change while expired: `leader-white.ts` absorbs one, since it cannot
 * see a crossing across the flip. Trusting it then reads the race one leader
 * lap short, and in the endgame that loses a warning for good — the player's
 * next sample falls on their own final lap, which the diff silences. So the
 * crossing is trusted only when it is also plausible from the clock: once
 * expired, the raw `SessionTimeRemain` reads minus the seconds since expiry,
 * and a leader at lap fraction `f` crossed the line about `f · L` seconds
 * ago, so the crossing counts only when `f · L` is less than the seconds
 * since expiry by more than `FUEL_FINISH_TOLERANCE_LAPS · L` — the same
 * allowance for pace drift the near-tie tolerance makes, since `f · L`
 * assumes the leader's recent lap time held on this lap. In every other case
 * the answer is `(2 − f) · L`, the over-count, which is the cautious
 * direction for fuel. What remains: a leader who really did cross since
 * expiry, but whose `f · L` sits within that allowance of the expiry, reads
 * one lap long until they are further round — cautious, and over within a
 * few seconds.
 *
 * @param telemetry - the tick's telemetry
 * @param positions - the tick's canonical live order (1-based rank by car index)
 * @param leaderLapTimeS - the leader's recent lap time (s) from `resolveLeaderLapTimeS`, or `null`
 * @param expiry - whether an expired reading is confirmed, and whether the leader has crossed since
 * @param crossingCheckLapS - the lap time the post-expiry crossing is checked against the clock with;
 *   the prediction's own `leaderLapTimeS` unless a caller runs it at another pace. The slower of two
 *   paces is the cautious one here, since it trusts the crossing less.
 */
export function predictLeaderChequered(
  telemetry: TelemetryData,
  positions: number[],
  leaderLapTimeS: number | null,
  expiry: LeaderClockExpiry,
  crossingCheckLapS: number | null = leaderLapTimeS,
): LeaderChequered | null {
  const expired = isClockExpiredReading(telemetry);

  if (expired && !expiry.confirmed) return null;

  const timeRemainS = expired ? 0 : resolveTimeRemainingS(telemetry);

  if (timeRemainS === null) return null;

  if (leaderLapTimeS === null || !Number.isFinite(leaderLapTimeS) || leaderLapTimeS <= 0) return null;

  const leaderIdx = positions.findIndex((position) => position === 1);

  if (leaderIdx < 0) return null;

  const leaderPct = readLapFraction(telemetry, leaderIdx);

  if (leaderPct === null) return null;

  const surface = telemetry.CarIdxTrackSurface?.[leaderIdx];

  if (surface === TrkLoc.InPitStall || surface === TrkLoc.AproachingPits) return null;

  let crossings: number;

  if (expired) {
    const checkLapS =
      typeof crossingCheckLapS === "number" && Number.isFinite(crossingCheckLapS) && crossingCheckLapS > 0
        ? Math.max(crossingCheckLapS, leaderLapTimeS)
        : leaderLapTimeS;

    crossings = expiry.leaderCrossed && leaderCrossedSinceExpiry(telemetry, leaderPct, checkLapS) ? 1 : 2;
  } else {
    const white = leaderWhiteCrossingIndex(
      timeRemainS,
      leaderLapTimeS,
      leaderPct,
      fuelFinishToleranceLaps(timeRemainS, leaderLapTimeS),
    );

    crossings = white + 1;
  }

  return { inS: (crossings - leaderPct) * leaderLapTimeS, crossings };
}

/**
 * Whether the leader's position on the lap is consistent with a crossing
 * since the clock expired: `f · L` seconds into their lap, clearly fewer than
 * the seconds since expiry (the raw `SessionTimeRemain`, negated) — by more
 * than `FUEL_FINISH_TOLERANCE_LAPS · L`. See {@link predictLeaderChequered}.
 */
function leaderCrossedSinceExpiry(telemetry: TelemetryData, leaderPct: number, leaderLapTimeS: number): boolean {
  const sinceExpiryS = -(telemetry.SessionTimeRemain ?? 0);

  return leaderPct * leaderLapTimeS < sinceExpiryS - FUEL_FINISH_TOLERANCE_LAPS * leaderLapTimeS;
}

/**
 * A car's `CarIdxLapDistPct` when it is a position on the lap — finite and
 * `0 ≤ f < 1` — otherwise `null`: a car index that is not a whole number of 0
 * or more, the array or the entry missing, or `-1` off world. The one reading
 * of a lap fraction the chequered prediction, the lap counters and the gap
 * horizon share; each consumer decides what an unknown one means for it.
 *
 * @param telemetry - the tick's telemetry
 * @param carIdx - the car index, `-1` when unknown
 */
export function readLapFraction(telemetry: TelemetryData, carIdx: number): number | null {
  if (!Number.isInteger(carIdx) || carIdx < 0) return null;

  const pct = telemetry.CarIdxLapDistPct?.[carIdx];

  return typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct < 1 ? pct : null;
}

/**
 * A car's place on the lap counter, or `null` when it cannot be trusted: a
 * car index out of range, a `CarIdxLapCompleted` that is missing or not a
 * whole lap count of 0 or more (it reads -1 before a car's first crossing),
 * a `CarIdxLapDistPct` that is not a position on the lap (missing, -1 off
 * world), or one within {@link LAP_LINE_GUARD_PCT} of the line, where the two
 * fields can disagree for a tick.
 */
function readCarLapPosition(telemetry: TelemetryData, carIdx: number): { lapsCompleted: number; pct: number } | null {
  if (!Number.isInteger(carIdx) || carIdx < 0) return null;

  const lapsCompleted = telemetry.CarIdxLapCompleted?.[carIdx];
  const pct = readLapFraction(telemetry, carIdx);

  if (typeof lapsCompleted !== "number" || !Number.isInteger(lapsCompleted) || lapsCompleted < 0) return null;

  if (pct === null || pct < LAP_LINE_GUARD_PCT || pct >= 1 - LAP_LINE_GUARD_PCT) return null;

  return { lapsCompleted, pct };
}

/**
 * The player's place against the race leader on the lap counters, or `null`
 * when either car's reading cannot be trusted (see `readCarLapPosition`): the
 * fuel estimate then counts by time, never by a lap count that may be a lap
 * off. The leader is position 1 of the canonical order; when that is the
 * player, the gap is `0`.
 *
 * @param telemetry - the tick's telemetry
 * @param positions - the tick's canonical live order (1-based rank by car index)
 * @param playerCarIdx - the player's car index (`DriverInfo.DriverCarIdx`), `-1` when unknown
 */
export function readLeaderGap(telemetry: TelemetryData, positions: number[], playerCarIdx: number): LeaderGap | null {
  return readLeaderGapAt(
    telemetry,
    positions.findIndex((position) => position === 1),
    playerCarIdx,
  );
}

/**
 * {@link readLeaderGap} for a caller that has already found the leader in the
 * canonical order — the gap horizon, which resolves the leader once per tick.
 *
 * @param telemetry - the tick's telemetry
 * @param leaderIdx - the leader's car index (position 1 of the canonical order), `-1` when there is none
 * @param playerCarIdx - the player's car index, `-1` when unknown
 */
export function readLeaderGapAt(telemetry: TelemetryData, leaderIdx: number, playerCarIdx: number): LeaderGap | null {
  if (leaderIdx < 0) return null;

  const leader = readCarLapPosition(telemetry, leaderIdx);
  const player = readCarLapPosition(telemetry, playerCarIdx);

  if (leader === null || player === null) return null;

  return {
    leaderLapsCompleted: leader.lapsCompleted,
    playerLapsCompleted: player.lapsCompleted,
    distanceLaps: leader.lapsCompleted + leader.pct - (player.lapsCompleted + player.pct),
  };
}

/**
 * Whether the player is within a lap of the race leader on distance now and
 * is projected to stay so when the leader takes the chequered flag:
 * `|g| < 1` and `g + T · (1/L − 1/P) < 1`, the gap `g` ({@link readLeaderGap})
 * carried forward `T` seconds at the two paces. Every car still inside a lap
 * of the leader at the flag finishes on the lap count the leader's chequered
 * brings up, so such a player is counted by {@link lapCountCrossings} rather
 * than by time.
 *
 * A slower car within a lap now but lapped before the flag finishes one count
 * lower, which is why the gap is projected rather than read. A faster player
 * (`P < L`) projects a shrinking gap and stays on the lap count.
 *
 * Shared by the fuel race coverage (#1405), which passes the lap-count
 * prediction and its capped pace `min(L, P)`, and the gap callouts' horizon
 * (#1380), which passes the leader's faster known pace, the smaller of their
 * last and best laps: each consumer picks the pace that errs in its own safe
 * direction.
 *
 * @param gap - the player's place against the leader ({@link readLeaderGap})
 * @param chequeredInS - seconds until the leader's chequered flag, `T`
 * @param leaderLapS - the leader's lap time (s) the prediction was made at, `L`, positive
 * @param playerLapS - the player's validated average lap time (s), `P`, positive
 */
export function staysWithinLapAtChequered(
  gap: LeaderGap,
  chequeredInS: number,
  leaderLapS: number,
  playerLapS: number,
): boolean {
  return Math.abs(gap.distanceLaps) < 1 && gap.distanceLaps + chequeredInS * (1 / leaderLapS - 1 / playerLapS) < 1;
}

/**
 * The player's line crossings from now up to and including their chequered
 * flag, by the lap counters: `LC_L + C_L − LC_p`. The leader's chequered is
 * their `LC_L + C_L`-th completed lap, and a car within a lap of them at the
 * flag ({@link staysWithinLapAtChequered}) takes its own chequered on that
 * same lap count. No pace and no tolerance: a close follower crosses after the
 * leader whatever the gap, so there is no near-tie to allow for. Same lap:
 * `C_L`; a lap down but within a lap on distance: `C_L + 1`.
 *
 * The fuel estimate counts the laps after the current one, one fewer.
 *
 * @param gap - the player's place against the leader ({@link readLeaderGap})
 * @param leaderCrossings - the leader's line crossings from now, the chequered included, `C_L`
 */
export function lapCountCrossings(gap: LeaderGap, leaderCrossings: number): number {
  return gap.leaderLapsCompleted + leaderCrossings - gap.playerLapsCompleted;
}

/**
 * The race leader as the fuel race coverage reads them: their lap time, the
 * chequered prediction ({@link predictLeaderChequered}) in seconds and in
 * crossings, the same prediction at the lap-count pace, and the player's
 * place against them ({@link readLeaderGap}).
 *
 * **Two paces, one model.** The leader's lap time is their raw
 * `CarIdxLastLapTime`, which can be a caution lap, an in- or out-lap or a
 * spin. Where the fuel estimate counts by time, a lap time too slow puts the
 * chequered later, and that only adds laps: cautious, so `chequeredInS` keeps
 * it. Where it counts on the lap counters it is the other way round: a slower
 * pace means fewer crossings before the clock runs out, so an inflated lap
 * reads the race short. `lapCountChequered` therefore runs the same
 * prediction at `min(L, P)`, the leader's lap time capped at the player's
 * validated average `P`, which leaves out caution and pit laps. The lap
 * counters are read only for a player within a lap of the leader and
 * projected to stay so, whose race pace is comparable, and of two paces the
 * faster gives the more crossings — the cautious count. A leader genuinely
 * faster than the player keeps their own lap time. It also covers a faster
 * player who passes before the clock runs out: the race then ends on their
 * crossings, and the leader's position run at the player's pace brings up a
 * count at least as high.
 *
 * @param telemetry - the tick's telemetry
 * @param positions - the tick's canonical live order (1-based rank by car index)
 * @param playerCarIdx - the player's car index, `-1` when unknown
 * @param leaderLapTimeS - the leader's recent lap time (s) from `resolveLeaderLapTimeS`, or `null`
 * @param expiry - whether an expired reading is confirmed, and whether the leader has crossed since
 * @param playerLapS - the player's validated average lap time (s), or `null`
 */
export function resolveLeaderFinish(
  telemetry: TelemetryData,
  positions: number[],
  playerCarIdx: number,
  leaderLapTimeS: number | null,
  expiry: LeaderClockExpiry,
  playerLapS: number | null,
): LeaderFinish {
  const chequered = predictLeaderChequered(telemetry, positions, leaderLapTimeS, expiry);
  const lapCountPaceS =
    chequered !== null &&
    leaderLapTimeS !== null &&
    typeof playerLapS === "number" &&
    Number.isFinite(playerLapS) &&
    playerLapS > 0
      ? Math.min(leaderLapTimeS, playerLapS)
      : null;
  const atLapCountPace =
    lapCountPaceS === null
      ? null
      : lapCountPaceS === leaderLapTimeS
        ? chequered
        : // The post-expiry crossing is still checked at the raw, slower pace: a
          // faster pace would trust a lead-change marker the raw pace rejects
          // and read the race a lap short.
          predictLeaderChequered(telemetry, positions, lapCountPaceS, expiry, leaderLapTimeS);

  return {
    lapTimeS: leaderLapTimeS,
    chequeredInS: chequered?.inS ?? null,
    crossingsToChequered: chequered?.crossings ?? null,
    lapCountChequered:
      lapCountPaceS === null || atLapCountPace === null ? null : { ...atLapCountPace, lapTimeS: lapCountPaceS },
    leaderGap: readLeaderGap(telemetry, positions, playerCarIdx),
  };
}
