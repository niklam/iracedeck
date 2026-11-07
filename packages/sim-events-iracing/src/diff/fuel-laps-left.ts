/**
 * Estimated "laps of fuel left" callout crossings (issue #838).
 *
 * Once per lap, at the mid-lap `LapDistPct` 0.5 crossing, computes how many
 * FULL laps the driver can complete after finishing the current lap:
 *
 *   rawLapsLeft = FuelLevel / avg          (validated estimator, issue #465)
 *   effective   = rawLapsLeft − margin     (user margin, default 0.3 laps)
 *   count       = max(0, floor(effective − remaining lap fraction))
 *
 * and emits `fuel.lapsLeft.crossed { count, lapsLeft }` when `count` is a NEW
 * descending crossing for the stint. `count === 0` is the "box this lap for
 * fuel" call. The estimator is the same `getFuelStats()` source Session
 * Info's Laps to Empty display uses (issue #748), over the same default
 * 5-lap window, so the spoken number tracks the displayed one (minus the
 * deliberately conservative margin).
 *
 * Announcement rules:
 *   - Each count fires at most once per stint, and only on a DESCENDING
 *     crossing — fuel saving that raises the estimate never re-announces a
 *     higher count, and a count already spoken stays spoken.
 *   - A drop of several counts between samples emits only the current
 *     (smallest crossed) count — no stale burst (the start-countdown ceiling
 *     precedent, issues #480/#666).
 *   - A refuel re-arms every count for the new stint: any debounced per-tick
 *     `FuelLevel` increase clears the announced floor. A garage refuel lands
 *     as one large delta on the first live tick back (the previous-level
 *     tracker is preserved across the replay wipe — see `TranslatorState`).
 *   - Race-coverage suppression (issue #866, extended by #880 and #1405):
 *     when the tank covers the remaining race distance, on the player's
 *     own final lap (the sticky `playerFinalLapStarted` latch — set with the
 *     #772 white-flag crossing, never re-armed by a mid-final-lap flag
 *     change; a later GREEN re-arms it in `diffFlags`, since a green past
 *     the latched lap means the race was extended or restarted), and
 *     post-race (checkered / cool-down), no warning is emitted. The
 *     remaining distance is the SOONER of two independently-known limits:
 *     the lap counter (`SessionLapsRemainEx − 1` laps after the current
 *     one; leader-relative in races per the 2026-08 capture validation,
 *     which is the correct player-crossings count under equal pace and
 *     overstates it for a slower multiclass player — the conservative
 *     direction; clamped to ≥ 1 while the white flies before the player's
 *     own crossing, when the player still runs their own full white lap)
 *     and the timed estimate (the player's crossings up to their first at
 *     or after the leader's PREDICTED chequered flag, `leader-finish.ts`,
 *     which reads an expired clock only once it has held for about a
 *     second, `CLOCK_EXPIRY_CONFIRM_TICKS`: counted on the lap counters for
 *     a player within a lap of the leader now and at the flag, and by the
 *     player's pace otherwise; when the flag cannot be predicted, a running clock's bound
 *     `SessionTimeRemain + 2 × leaderLap`, and unknown for an expired one).
 *     The verdict is on the TANK, not the post-margin count
 *     ({@link isFuelRaceCovered}, #1405): the raw laps of fuel must
 *     cover the rest of this lap and every lap after it with
 *     `FUEL_COVERAGE_ERROR` to spare. The margin protects a pit decision
 *     against estimate error, but with a lap or two left there is no stop
 *     worth making, so it is not taken off here. Each comparison suppresses
 *     only on a positive "fuel covers the race" determination — an unknown
 *     reading (missing field, the `IRSDK_UNLIMITED_LAPS` /
 *     `IRSDK_UNLIMITED_TIME` sentinels, no validated lap-time average)
 *     keeps announcing — but the final-lap and post-race gates are
 *     UNCONDITIONAL: even a genuinely-short estimate stays silent there, a
 *     deliberate trade-off (#866 review). The same holds when the binding
 *     distance leaves no lap after the current one (`remainingLaps === 0`,
 *     the verdict's own rule): a lapped or slower-class player whose own
 *     final-lap latch has not fired is on their last lap all the same. The
 *     announced floor is NOT advanced by a suppression, so coverage is
 *     re-evaluated every lap and a burn-rate spike that shrinks the
 *     estimate below the race distance still announces on the earlier laps.
 *   - Enough-fuel reassurance (issue #880): when the coverage determination
 *     is positive in the race ENDGAME — 10 or fewer laps to go by the
 *     binding limit — the dedicated `fuel.lapsLeft.raceCovered` event fires
 *     at most once per stint, so the driver hears "we have enough fuel to
 *     finish the race" instead of silence (a huge surplus still gets its
 *     confirmation at 10-to-go; an early-race positive stays quiet). It
 *     requires, on top of the tank verdict, the UNCLAMPED post-margin count
 *     to cover the distance WITH A FULL LAP IN HAND — the stricter of the
 *     two, so a confirmation is never spoken on a tank the verdict calls
 *     short; the truth guard (the count-0 clamp can hide a tank that won't
 *     even finish the current lap) doubles as hysteresis, so boundary
 *     noise never alternates contradictory warn/reassure lines. Emitting it
 *     clears the warning floor (the all-clear retracts the spoken warnings;
 *     a later coverage flip must re-warn at any count). A refuel re-arms it
 *     with the floor, and any later real warning re-arms it too, so a
 *     burn-spike arc speaks warning → reassurance again once coverage
 *     recovers.
 *
 * Race sessions only, live in car, and silent until the tracker has valid
 * samples — no estimate, no callout, never a guess.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import {
  bindingLapsToGo,
  Flags,
  isLiveOnTrack,
  isPostRace,
  resolveLapsRemaining,
  resolveTimeRemainingS,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";

import {
  countClockExpiredTicks,
  fuelFinishToleranceLaps,
  isClockExpiredReading,
  type LeaderFinish,
} from "../leader-finish.js";
import type { TranslatorState } from "../state.js";
import type { FuelStats } from "./fuel-laps.js";
import type { EmitFn } from "./types.js";

/** Largest count that gets announced — deeper fuel states stay silent. */
export const FUEL_LAPS_LEFT_MAX_COUNT = 10;

/**
 * Rolling estimator window (valid laps). Matches Session Info's
 * `fuelLapWindow` default so the spoken estimate tracks the Laps to Empty
 * display (issue #748).
 */
export const FUEL_LAPS_LEFT_WINDOW_LAPS = 5;

/** `LapDistPct` the mid-lap sample triggers at (rising crossing). */
export const FUEL_LAPS_LEFT_SAMPLE_PCT = 0.5;

/**
 * Default safety margin (laps) subtracted from the raw estimate. Must match
 * the `fuelCalloutMarginLaps` schema default in
 * `@iracedeck/settings` `global-settings.ts`.
 */
export const FUEL_CALLOUT_DEFAULT_MARGIN_LAPS = 0.3;

/** Margin slider bounds (laps) — mirrors the Zod schema in `@iracedeck/settings` `global-settings.ts`. */
export const FUEL_CALLOUT_MARGIN_MIN_LAPS = 0;
export const FUEL_CALLOUT_MARGIN_MAX_LAPS = 3;

/**
 * The allowance {@link isFuelRaceCovered} keeps for the average being off
 * (issue #1405): 5 % of the distance left, so it grows with the laps to
 * cover the way estimate error does — two laps left need a tenth of a lap in
 * hand, ten laps half a lap. A first value; how much per-lap use varies has
 * not been measured, and the spec's manual test is where it is checked.
 */
export const FUEL_COVERAGE_ERROR = 0.05;

/**
 * Minimum positive per-tick `FuelLevel` delta (L) treated as refueling —
 * the same debounce floor the #465 tracker uses for refuel-aware accounting.
 */
const REFUEL_EPSILON_L = 0.01;

/**
 * Sanitize a raw `fuelCalloutMarginLaps` global-settings value into a usable
 * margin: non-numeric / non-finite values fall back to the default, and the
 * result is clamped to the slider bounds. Plugins wrap their live-read
 * closure in this so a malformed persisted value can't poison the estimate.
 */
export function sanitizeFuelCalloutMarginLaps(value: unknown): number {
  const n = typeof value === "string" && value !== "" ? Number(value) : value;

  if (typeof n !== "number" || !Number.isFinite(n)) return FUEL_CALLOUT_DEFAULT_MARGIN_LAPS;

  return Math.min(FUEL_CALLOUT_MARGIN_MAX_LAPS, Math.max(FUEL_CALLOUT_MARGIN_MIN_LAPS, n));
}

/**
 * Every step of the laps-of-fuel-left count, as {@link estimateFuelLapsLeft}
 * derives it (issue #1387). `count` is what the callout speaks; the steps
 * behind it are kept so the Telemetry Snapshot can show how it was reached.
 */
export type FuelLapsLeftEstimate = {
  /** `FuelLevel / avg` — laps the tank holds at the validated burn rate. */
  rawLapsLeft: number;
  /** The safety margin (laps) that was subtracted. */
  marginLaps: number;
  /** `rawLapsLeft − marginLaps` — the `lapsLeft` of `fuel.lapsLeft.crossed`. */
  effective: number;
  /** `1 − LapDistPct` — what is left of the current lap. */
  lapFractionRemaining: number;
  /** May be negative: the tank will not finish the current lap. */
  unclampedCount: number;
  /** FULL laps completable after the current one, clamped at 0. */
  count: number;
};

/**
 * The count arithmetic of the module header, as one pure function (issue
 * #1387): the diff calls it at its mid-lap sample, and the Telemetry
 * Snapshot's state reader calls it with the telemetry of the press, so the
 * two can never use different formulas. It validates nothing — the caller
 * hands it a finite `fuelLevel` and `distPct` and a positive `avgFuelPerLap`.
 *
 * @param fuelLevel - `FuelLevel` (L)
 * @param distPct - `LapDistPct` (0–1)
 * @param avgFuelPerLap - the validated estimator's average (L per lap), positive
 * @param marginLaps - the safety margin (laps), already sanitized
 */
export function estimateFuelLapsLeft(
  fuelLevel: number,
  distPct: number,
  avgFuelPerLap: number,
  marginLaps: number,
): FuelLapsLeftEstimate {
  const rawLapsLeft = fuelLevel / avgFuelPerLap;
  const effective = rawLapsLeft - marginLaps;
  const lapFractionRemaining = 1 - distPct;
  // May be negative when the tank won't even finish the current lap — the
  // clamp hides that, so the reassurance's truth guard reads this one.
  const unclampedCount = Math.floor(effective - lapFractionRemaining);
  const count = Math.max(0, unclampedCount);

  return { rawLapsLeft, marginLaps, effective, lapFractionRemaining, unclampedCount, count };
}

/**
 * The remaining race distance the laps-of-fuel-left count is compared with,
 * as {@link resolveFuelRaceCoverage} determines it (issue #1387). Both sides
 * are in the count's own unit: full laps the player still runs AFTER the
 * current one.
 */
export type FuelRaceCoverage = {
  /** By the lap counter, or `null` when it is unknown or unlimited. */
  lapsNeededAfterCurrent: number | null;
  /**
   * By the session clock, or `null` when it is unknown or unlimited, there is
   * no validated lap time to divide it by, or it has expired and the leader's
   * chequered flag cannot be predicted.
   */
  timedLapsAfterCurrent: number | null;
  /** `Infinity` when neither limit is known. */
  remainingLaps: number;
};

/**
 * The remaining race distance for the race-coverage determination (issue
 * #866, extended by #880; the timed side a prediction since #1405), as one
 * pure function shared by the diff and the
 * Telemetry Snapshot's state reader (issue #1387). Two independently-known
 * limits; whichever ends the race sooner binds (a session can carry BOTH a
 * lap and a time limit, #866 limitation 1), and each suppresses only on a
 * positive determination — an unknown reading keeps announcing. The sentinel
 * decoding and the whichever-ends-sooner rule are the shared session-limit
 * helper (`@iracedeck/iracing-sdk`, #1109) — one policy for this estimate
 * and Session Info's Time Remaining key; the adjustments that follow are
 * this estimate's own precision and stay here.
 *
 * `getLeaderFinish` is called lazily: only when the timed side is actually
 * computed (a known or expired clock and a validated player lap time), and
 * then once.
 *
 * @param telemetry - the tick's telemetry
 * @param stats - the validated estimator's stats, for the player's lap time
 * @param lapFractionRemaining - `1 − LapDistPct`, from {@link estimateFuelLapsLeft}
 * @param getLeaderFinish - the race leader's recent lap time, predicted chequered flag (seconds and crossings, raw and at the lap-count pace) and the player's lap-counter gap to them, each `null` when unknown; handed the player's validated average lap time
 */
export function resolveFuelRaceCoverage(
  telemetry: TelemetryData,
  stats: FuelStats,
  lapFractionRemaining: number,
  getLeaderFinish: (playerLapS: number) => LeaderFinish,
): FuelRaceCoverage {
  const whiteUp = typeof telemetry.SessionFlags === "number" && (telemetry.SessionFlags & Flags.White) !== 0;

  // Lap counter: `count` means full laps completable AFTER the current one,
  // while the raw counter INCLUDES the current lap — so the −1 bridges them
  // (clamped at 0: a raw 0 in the leader-finished tick window must not go
  // vacuously negative). In races the counter reads LEADER-relative
  // (validated from lapped-race captures, 2026-08; qualifying is
  // player-relative, #776), which IS the player's remaining crossings under
  // equal pace — the race ends at the leader's final crossing, not after
  // the player's full lap count — and overstates them for a slower
  // multiclass player (conservative: warnings stay on longer). One boundary
  // correction: while the WHITE flag flies and the player has not yet
  // crossed under it (in the diff the sticky `playerFinalLapStarted` latch
  // has returned before this is reached), the leader is on THEIR final lap
  // (raw 1 → 0 needed) but the player still runs the current lap plus their
  // OWN full white lap — clamp to ≥ 1.
  const rawLapsRemain = resolveLapsRemaining(telemetry);
  let lapsNeededAfterCurrent = rawLapsRemain !== null ? Math.max(0, rawLapsRemain - 1) : null;

  if (lapsNeededAfterCurrent !== null && whiteUp) {
    lapsNeededAfterCurrent = Math.max(lapsNeededAfterCurrent, 1);
  }

  // Timed estimate (issue #880, made a prediction by #1405): the clock
  // expiring does NOT end a timed race — the leader takes the WHITE at their
  // first crossing at or after expiry and the chequered one leader lap after
  // that. The translator predicts that chequered flag from the leader's lap
  // fraction, lap time and the post-expiry crossing marker
  // (`predictLeaderChequered` in `leader-finish.ts`, the crossing model the
  // gap horizon shares), both as `T` seconds from now and as `N_L`, the
  // leader's crossings up to and including it. When it cannot be predicted
  // (unknown leader fraction or lap time, the leader in the pits) a running
  // clock falls back to the bound `timeRemain + 2 × leaderLap` — white at
  // most one leader lap after expiry, plus the white lap — with the player's
  // own validated average standing in for an unknown leader lap. A clock
  // reading at or below zero with no prediction leaves the side unknown:
  // whether it is a real expiry the prediction has not confirmed yet or a
  // blip of a tick or two mid-race (the #666 transient), it is no duration
  // to bound by, and bounding a blip by two leader laps would end the race
  // there. Ignorance keeps the cautious answer: counting too few laps would
  // silence a warning.
  //
  // The player takes the chequered at their first crossing at or after the
  // leader's. Two ways to count the full laps they still start after the
  // current one:
  //
  // - **By lap count**, when there is a prediction and the player is within
  //   a lap of the leader on distance now (`leaderGap`, `−1 < g < 1` with
  //   `g = (LC_L + f_L) − (LC_p + f_p)`; the player being the leader gives
  //   `g = 0`) AND still at the chequered: `g + T · (1/L − 1/P) < 1`, with
  //   the player's average `P`. On this path the leader's crossings `N_L`,
  //   the chequered time `T` and the pace `L` in the projection are all the
  //   prediction at the lap-count pace `L = min(L_leader, P)`
  //   (`lapCountChequered`, see `resolveLeaderFinish`): an inflated raw
  //   leader lap — a caution, pit or spin lap — would count too few
  //   crossings, and the projection would pick this path exactly then. Every
  //   car within a lap of the leader at the flag finishes on the lap count
  //   the leader's chequered brings up, `LC_L + N_L`: a car behind crosses it
  //   after the leader, and one that passes becomes the leader at the same
  //   count. So the player's crossings are `LC_L + N_L − LC_p` and the laps
  //   after the current one `LC_L + N_L − LC_p − 1`, with no tolerance — a
  //   close follower crosses after the leader whatever the gap, so there is
  //   no near-tie to allow for. (Same lap: `N_L`; a lap down but within a
  //   lap on distance, either side of the line: `N_L + 1`; the player across
  //   the line just ahead of the leader: `N_L − 1`.) A slower car within a
  //   lap now but lapped before the flag finishes one count lower, which is
  //   why the gap is projected to the flag. A faster player keeps this path:
  //   at the capped pace their projected gap does not grow, and a pass even
  //   before expiry, which ends the race on the new leader's crossings,
  //   brings up no higher count than the leader's position run at the
  //   player's pace. At
  //   the boundary both errors are cautious: projected just inside a lap but
  //   really lapped, this counts one lap more; projected just outside but
  //   not really lapped, the time model's tolerance counts the later
  //   crossing.
  // - **By time** otherwise — a lapped or slower-class player a lap or more
  //   away now or at the flag, a lap count or fraction missing or too close
  //   to the line to trust for either car (`readLeaderGap`), an unknown
  //   leader lap time, or no prediction. With the
  //   player's average lap `P` and lap fraction `f_p`, their k-th crossing
  //   is at `(k − f_p) · P`, so the laps after the current one are
  //   `ceil(T / P + f_p + ε) − 1`, where `ε` (`fuelFinishToleranceLaps`)
  //   moves a near-tie to the later crossing — one lap more, the safe
  //   direction. Missing data therefore lands here or on unknown, never on
  //   a smaller count.
  //
  // The White bit is deliberately not read here: it is per car, so a lapped
  // or slower-class player never sees the leader's. Leader pace comes from
  // the translator closure (recent → best lap, canonical live order), raw:
  // a caution, pit or spin lap inflates it, which on the time path only
  // moves the chequered later (more laps, cautious) and on the lap-count
  // path is capped at the player's average. The player's averages exclude
  // caution laps (see `FuelLap.wasCaution`) and pit laps, so a long caution
  // can neither deflate the burn rate nor inflate either lap time into a
  // false "enough fuel".
  const clockExpired = isClockExpiredReading(telemetry);
  const timeRemain = resolveTimeRemainingS(telemetry);
  const playerLap = stats.avgLapTime;
  let timedLapsAfterCurrent: number | null = null;

  if ((timeRemain !== null || clockExpired) && playerLap !== null && playerLap > 0) {
    const leader = getLeaderFinish(playerLap);
    const leaderLap = isPositiveFinite(leader.lapTimeS) ? leader.lapTimeS : playerLap;
    const predicted = leader.chequeredInS;
    const fromPrediction = typeof predicted === "number" && Number.isFinite(predicted) && predicted >= 0;
    const leaderChequeredS = fromPrediction
      ? predicted
      : !clockExpired && timeRemain !== null
        ? timeRemain + 2 * leaderLap
        : null;

    // The lap-count path reads the prediction at the lap-count pace,
    // `min(L, P)` (`resolveLeaderFinish`): a raw leader lap inflated by a
    // caution, pit or spin lap would count too few crossings there.
    const lapCount = leader.lapCountChequered;
    const gap = leader.leaderGap;

    if (
      fromPrediction &&
      lapCount !== null &&
      isPositiveFinite(lapCount.lapTimeS) &&
      Number.isInteger(lapCount.crossings) &&
      lapCount.crossings >= 1 &&
      gap !== null &&
      Math.abs(gap.distanceLaps) < 1 &&
      // The gap projected to the leader's chequered flag at the same pace:
      // still inside a lap.
      gap.distanceLaps + lapCount.inS * (1 / lapCount.lapTimeS - 1 / playerLap) < 1
    ) {
      timedLapsAfterCurrent = Math.max(0, gap.leaderLapsCompleted + lapCount.crossings - gap.playerLapsCompleted - 1);
    } else if (leaderChequeredS !== null) {
      // `t` is 0 once the clock has expired, leaving only the fixed part of
      // the tolerance.
      const tolerance = fuelFinishToleranceLaps(clockExpired ? 0 : (timeRemain ?? 0), leaderLap);
      const playerPct = 1 - lapFractionRemaining;

      timedLapsAfterCurrent = Math.max(0, Math.ceil(leaderChequeredS / playerLap + playerPct + tolerance) - 1);
    }
  }

  // The binding remaining distance — the limit that actually ends the race,
  // by the shared whichever-ends-sooner rule (a tie goes to the lap counter,
  // which is value-identical here). Infinity when neither limit is known —
  // the helper's "none" verdict — which keeps every comparison the diff
  // makes against it false (announce on unknown: a `null` is ignorance,
  // never a short race).
  const remainingLaps = bindingLapsToGo(lapsNeededAfterCurrent, timedLapsAfterCurrent) ?? Number.POSITIVE_INFINITY;

  return { lapsNeededAfterCurrent, timedLapsAfterCurrent, remainingLaps };
}

function isPositiveFinite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The race-coverage verdict (issue #1405), as one pure function shared by the
 * diff and the Telemetry Snapshot's state reader: the tank covers the race
 * when
 *
 *   rawLapsLeft ≥ (lapFractionRemaining + remainingLaps) × (1 + FUEL_COVERAGE_ERROR)
 *
 * — the fuel for the rest of this lap and every lap after it, plus
 * {@link FUEL_COVERAGE_ERROR} for the average being off, with NO lap margin.
 * The margin protects a pit decision against estimate error, but with a lap
 * or two left there is no stop worth making, and taking it off here turned
 * covered finishes into warnings. An unknown distance (`Infinity`) is never
 * covered.
 *
 * **No lap after the current one (`remainingLaps === 0`) is always
 * "covered"**, whatever the tank says: the player is on their last lap, and
 * at the estimator's precision a shortage call there is more often noise
 * than a real splash-and-dash opportunity — the #866 trade-off behind the
 * diff's unconditional final-lap silence. That silence keys on the player's
 * own `playerFinalLapStarted` latch, which a lapped or slower-class player
 * may not have set when the race distance already ends with this lap; this
 * rule covers them, and being part of the verdict, it holds for the
 * Telemetry Snapshot's `covered` too. The enough-fuel confirmation keeps its
 * own guard (a full lap in hand by the unclamped count), so a short tank
 * still gets no confirmation here.
 *
 * @param estimate - the tick's {@link estimateFuelLapsLeft} result
 * @param remainingLaps - {@link FuelRaceCoverage}'s binding distance, full laps after the current one
 */
export function isFuelRaceCovered(
  estimate: Pick<FuelLapsLeftEstimate, "rawLapsLeft" | "lapFractionRemaining">,
  remainingLaps: number,
): boolean {
  if (!Number.isFinite(remainingLaps)) return false;

  if (remainingLaps === 0) return true;

  return estimate.rawLapsLeft >= (estimate.lapFractionRemaining + remainingLaps) * (1 + FUEL_COVERAGE_ERROR);
}

/** The events {@link diffFuelLapsLeft} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const FUEL_LAPS_LEFT_EVENTS = [
  "fuel.lapsLeft.crossed",
  "fuel.lapsLeft.raceCovered",
] as const satisfies readonly SimEventName[];

/**
 * Per-tick laps-of-fuel-left tracking. `getStats` reads the validated fuel
 * estimator (`computeFuelStats` over the instance tracker); `getMarginLaps`
 * is the live-read margin closure injected by the plugin (already
 * sanitized); `getLeaderFinish` reads the race leader's recent pace and
 * predicted chequered flag from the translator (issues #880, #1405 — each
 * `null` when unknown, see {@link resolveFuelRaceCoverage} for the
 * fallbacks).
 */
export function diffFuelLapsLeft(
  state: TranslatorState,
  telemetry: TelemetryData,
  isRaceSession: boolean,
  getStats: () => FuelStats,
  getMarginLaps: () => number,
  getLeaderFinish: (playerLapS: number) => LeaderFinish,
  emit: EmitFn<(typeof FUEL_LAPS_LEFT_EVENTS)[number]>,
): void {
  // The expired-clock confirmation (issue #1405), counted on EVERY tick this
  // diff sees, before any early return, so the count is consecutive ticks —
  // a session type, invalid input or the sampling gates never freeze it. The
  // leader's chequered prediction (`getLeaderFinish`) reads it later in this
  // same call; the Telemetry Snapshot reads it after the tick.
  state.fuelCalloutClockExpiredTicks = countClockExpiredTicks(telemetry, state.fuelCalloutClockExpiredTicks);

  if (!isRaceSession) return;

  const fuelLevel = telemetry.FuelLevel;
  const distPct = telemetry.LapDistPct;
  const lap = telemetry.Lap;

  if (
    typeof fuelLevel !== "number" ||
    !Number.isFinite(fuelLevel) ||
    fuelLevel < 0 ||
    typeof distPct !== "number" ||
    !Number.isFinite(distPct) ||
    typeof lap !== "number" ||
    !Number.isFinite(lap) ||
    lap < 0
  ) {
    return;
  }

  // Refuel re-arm — runs on every validated race tick (a pit-stall fill is a
  // live-in-car state, a garage fill lands as one big delta on the first
  // live tick back). A new stint re-arms both the announce floor and the
  // enough-fuel reassurance (issue #880).
  if (state.fuelCalloutLastFuelLevel !== null && fuelLevel - state.fuelCalloutLastFuelLevel > REFUEL_EPSILON_L) {
    state.fuelCalloutLastAnnouncedCount = null;
    state.fuelCalloutRaceCoveredAnnounced = false;
  }

  state.fuelCalloutLastFuelLevel = fuelLevel;

  const lastDistPct = state.fuelCalloutLastDistPct;
  state.fuelCalloutLastDistPct = distPct;

  // Seed silently on the first valid tick — no edge to compare yet.
  if (lastDistPct === null) return;

  // Rising mid-lap crossing, at most one sample attempt per lap.
  if (!(lastDistPct < FUEL_LAPS_LEFT_SAMPLE_PCT && distPct >= FUEL_LAPS_LEFT_SAMPLE_PCT)) return;

  if (lap === state.fuelCalloutLastSampledLap) return;

  state.fuelCalloutLastSampledLap = lap;

  if (!isLiveOnTrack(telemetry)) return;

  // Race-coverage suppression, part 1 (issue #866): a pit suggestion that
  // can't be acted on usefully is noise. Silent from the leader's checkered
  // onward (a cool-down "box this lap" would be equally wrong, the #657
  // precedent) and on the player's own final lap — the STICKY
  // `playerFinalLapStarted` latch (issue #880), set with the #772 white-flag
  // crossing but never re-armed by a mid-final-lap flag change, so a caution
  // replacing the white can't resurrect the box call. Works in timed races
  // too, where the lap counter below reads the unlimited sentinel.
  // DELIBERATE TRADE-OFF: this silence is unconditional — even an estimate
  // saying the tank won't last to the line stays quiet on the final lap,
  // because at the estimator's ±margin precision a final-lap shortage call
  // is more often noise than a real splash-and-dash opportunity (decided in
  // the #866 review). The reassurance below never fires here either.
  if (isPostRace(telemetry) || state.playerFinalLapStarted) return;

  const stats = getStats();

  if (stats.avg === null || stats.avg <= 0) return;

  const estimate = estimateFuelLapsLeft(fuelLevel, distPct, stats.avg, getMarginLaps());
  const { effective, unclampedCount, count } = estimate;

  // Race-coverage determination, part 2 (issue #866, extended by #880 and
  // #1405): when the tank covers the remaining race distance there is
  // nothing to refuel for. The distance is `resolveFuelRaceCoverage`'s — the
  // two limits and which of them binds are worked out there — and the
  // verdict is `isFuelRaceCovered`'s, on the raw tank with no lap margin,
  // and silent whatever the tank when no lap is left after this one (the
  // #866 trade-off, for a player whose own final-lap latch has not fired).
  const { remainingLaps } = resolveFuelRaceCoverage(telemetry, stats, estimate.lapFractionRemaining, getLeaderFinish);

  if (isFuelRaceCovered(estimate, remainingLaps)) {
    // Enough-fuel reassurance (issue #880): a positive coverage
    // determination in the race ENDGAME becomes ONE "we have enough fuel to
    // finish the race" per stint — the driver hears the topic closed
    // instead of silence, and a spoken warning gets retracted when coverage
    // turns positive later. Guards: the race must be inside its last
    // FUEL_LAPS_LEFT_MAX_COUNT laps (the same 10-lap horizon the warnings
    // speak over, anchored on the RACE rather than the tank, so even a huge
    // surplus gets its confirmation at 10-to-go while an early-race
    // positive stays quiet); the UNCLAMPED post-margin count must cover the
    // distance WITH A FULL LAP IN HAND (the +1 is both the truth guard — the
    // count-0 clamp can hide a tank that won't finish even the current lap —
    // and the hysteresis that stops estimate noise at the coverage boundary
    // from alternating contradictory warn/reassure callouts; inside the
    // 10-lap horizon it is stricter than the tank verdict, so a confirmation
    // is never spoken on a tank the verdict calls short); and the latch must
    // be unset (re-armed by refuels and by later real warnings).
    if (
      remainingLaps <= FUEL_LAPS_LEFT_MAX_COUNT &&
      unclampedCount >= remainingLaps + 1 &&
      !state.fuelCalloutRaceCoveredAnnounced
    ) {
      state.fuelCalloutRaceCoveredAnnounced = true;
      // The all-clear retracts every warning spoken so far: clear the dedup
      // floor so a later coverage flip re-warns at ANY count — a kept floor
      // would leave "enough fuel" as the driver's last word while the tank
      // runs short (after a box-call → reassurance arc, no count could ever
      // fall below a floor of 0 again).
      state.fuelCalloutLastAnnouncedCount = null;
      emit({ event: "fuel.lapsLeft.raceCovered", data: {} });
    }

    // The dedup floor is otherwise deliberately NOT advanced: coverage is
    // re-evaluated every lap, so a burn-rate spike that shrinks the
    // estimate below the race distance still announces on the earlier laps.
    return;
  }

  if (count > FUEL_LAPS_LEFT_MAX_COUNT) return;

  // Descending crossings only; a count already announced stays announced.
  if (state.fuelCalloutLastAnnouncedCount !== null && count >= state.fuelCalloutLastAnnouncedCount) return;

  state.fuelCalloutLastAnnouncedCount = count;
  // A real warning re-arms the reassurance — if coverage recovers (fuel
  // save, the race got shorter), the driver must hear the retraction.
  state.fuelCalloutRaceCoveredAnnounced = false;
  emit({ event: "fuel.lapsLeft.crossed", data: { count, lapsLeft: effective } });
}
