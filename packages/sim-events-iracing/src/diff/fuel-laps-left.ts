/**
 * Estimated "laps of fuel left" callout crossings (issue #838).
 *
 * Once per lap, at the mid-lap `LapDistPct` 0.5 crossing, computes how many
 * FULL laps the driver can complete after finishing the current lap:
 *
 *   rawLapsLeft = FuelLevel / avg          (validated estimator, issue #465)
 *   effective   = rawLapsLeft − margin     (user margin, default 0 laps, #1679)
 *   count       = max(0, floor(effective − remaining lap fraction))
 *
 * and emits `fuel.lapsLeft.crossed { count, lapsLeft }` when `count` is a NEW
 * descending crossing for the stint. `count === 0` is the "box this lap for
 * fuel" call. The estimator is the same `getFuelStats()` source Session
 * Info's Laps to Empty display uses (issue #748), over the same default
 * 5-lap window, so the spoken number tracks the displayed one (minus the
 * user margin, when one is set).
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
 *     tracker is kept across the replay wipe — see `resetFuelCalloutBaselines`
 *     in `state.ts`).
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
 *     ({@link isFuelCovered}, #1405): the raw laps of fuel must
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
 * Every session kind (issue #1702; race-only before it), live in car, and
 * silent until the tracker has valid samples — no estimate, no callout, never
 * a guess. The sampling, the count, the descending floor, the refuel re-arm,
 * the post-race silence and the final-lap silence run everywhere; what is
 * race-only (the `"race"` {@link FuelSessionBranch}, the exact `"Race"`
 * match, so a heat race or a warmup takes the other branch) is the rest of the
 * list above:
 *   - In a race: the final-lap signal is the sticky latch, the coverage
 *     distance is {@link resolveFuelRaceCoverage}'s (lap counter and timed
 *     side), and the enough-fuel reassurance may speak.
 *   - In any other session: the final-lap signal is the White bit on this
 *     tick, which practice and qualifying show when the player starts their
 *     own last lap (`diff/flags.ts`, the two-stage white; a heat race's or a
 *     warmup's white is unmeasured, #1767, and a field-wide one would
 *     silence the countdown up to a lap early); the coverage distance is the
 *     lap counter alone ({@link resolveFuelLapCounterCoverage}) — a
 *     Lone Qualify fuelled for its laps hears no warning, a session with no
 *     lap limit gets no coverage check — and `fuel.lapsLeft.raceCovered` is
 *     never emitted, its line being about finishing the race.
 *
 * While the session type cannot be read (`"unknown"`, issue #1702 — the
 * session info not yet resolved, or a session-info update that failed to
 * parse, #1461) the diff consumes nothing: no branch can be picked, and
 * whatever it sampled would be refused downstream, where the Race Engineer
 * cannot classify the session either, while the floor it advanced would keep
 * that count from ever being spoken. See {@link diffFuelLapsLeft}.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import {
  bindingLapsToGo,
  Flags,
  hasFlag,
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
  LAP_LINE_GUARD_PCT,
  lapCountCrossings,
  type LeaderFinish,
  staysWithinLapAtChequered,
} from "../leader-finish.js";
import type { FuelCalloutState } from "../state.js";
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
 * Default safety margin (laps) subtracted from the raw estimate: none
 * (#1679), since rounding the count down is already conservative. Must match
 * the `fuelCalloutMarginLaps` schema default in
 * `@iracedeck/settings` `global-settings.ts`.
 */
export const FUEL_CALLOUT_DEFAULT_MARGIN_LAPS = 0;

/** Margin slider bounds (laps) — mirrors the Zod schema in `@iracedeck/settings` `global-settings.ts`. */
export const FUEL_CALLOUT_MARGIN_MIN_LAPS = 0;
export const FUEL_CALLOUT_MARGIN_MAX_LAPS = 3;

/**
 * The allowance {@link isFuelCovered} keeps for the average being off
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
 * The remaining distance the laps-of-fuel-left count is compared with: in a
 * race the race distance {@link resolveFuelRaceCoverage} determines (issue
 * #1387), in any other session {@link resolveFuelLapCounterCoverage}'s
 * lap-counter distance, with no timed side (issue #1702). Both sides are in
 * the count's own unit: full laps the player still runs AFTER the current
 * one.
 */
export type FuelCoverage = {
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
): FuelCoverage {
  const whiteUp = typeof telemetry.SessionFlags === "number" && (telemetry.SessionFlags & Flags.White) !== 0;

  // Lap counter, by the step both branches share
  // (`resolveFuelLapCounterLapsAfterCurrent`: the −1 that bridges a counter
  // INCLUDING the current lap to full laps AFTER it, clamped at 0 so a raw 0
  // in the leader-finished tick window does not go vacuously negative). In
  // races the counter reads LEADER-relative
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
  let lapsNeededAfterCurrent = resolveFuelLapCounterLapsAfterCurrent(telemetry);

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
      // Within a lap now, and the gap projected to the leader's chequered
      // flag at the same pace still inside one.
      staysWithinLapAtChequered(gap, lapCount.inS, lapCount.lapTimeS, playerLap)
    ) {
      timedLapsAfterCurrent = Math.max(0, lapCountCrossings(gap, lapCount.crossings) - 1);
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
 * The coverage verdict (issue #1405), as one pure function shared by the diff
 * and the Telemetry Snapshot's state reader, in both of the diff's branches
 * (issue #1702): the tank covers the distance left — the race's, or outside a
 * race the session's lap counter — when
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
 * diff's unconditional final-lap silence. In a race that silence keys on the
 * player's own `playerFinalLapStarted` latch, which a lapped or slower-class
 * player may not have set when the race distance already ends with this lap;
 * this rule covers them, and being part of the verdict, it holds for the
 * Telemetry Snapshot's `covered` too. The enough-fuel confirmation keeps its
 * own guard (a full lap in hand by the unclamped count), so a short tank
 * still gets no confirmation here.
 *
 * @param estimate - the tick's {@link estimateFuelLapsLeft} result
 * @param remainingLaps - {@link FuelCoverage}'s binding distance, full laps after the current one
 */
export function isFuelCovered(
  estimate: Pick<FuelLapsLeftEstimate, "rawLapsLeft" | "lapFractionRemaining">,
  remainingLaps: number,
): boolean {
  if (!Number.isFinite(remainingLaps)) return false;

  if (remainingLaps === 0) return true;

  return estimate.rawLapsLeft >= (estimate.lapFractionRemaining + remainingLaps) * (1 + FUEL_COVERAGE_ERROR);
}

/**
 * Which of {@link diffFuelLapsLeft}'s branches a session takes (issue #1702):
 * `"race"` for the race branch, `"non-race"` for every other readable session
 * (a heat race and a warmup included), `"unknown"` while the session type
 * cannot be read, when the diff consumes nothing.
 */
export type FuelSessionBranch = "race" | "non-race" | "unknown";

/**
 * The {@link FuelSessionBranch} for `handleTick`'s resolved session type —
 * one definition for the translator and the Telemetry Snapshot's state
 * reader. The race branch is the exact `"Race"` match (the race-coverage
 * model was validated against `"Race"` captures); an empty type is the
 * resolver's "unreadable" answer.
 *
 * @param sessionType - `resolveSessionType`'s answer, `""` when unreadable
 */
export function resolveFuelSessionBranch(sessionType: string): FuelSessionBranch {
  if (sessionType === "") return "unknown";

  return sessionType === "Race" ? "race" : "non-race";
}

/** The events {@link diffFuelLapsLeft} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const FUEL_LAPS_LEFT_EVENTS = [
  "fuel.lapsLeft.crossed",
  "fuel.lapsLeft.raceCovered",
] as const satisfies readonly SimEventName[];

/**
 * Per-tick laps-of-fuel-left tracking over the `fuelCallout` slice.
 * `getStats` reads the validated fuel estimator (`computeFuelStats` over the
 * instance tracker); `getMarginLaps` is the live-read margin closure injected
 * by the plugin (already sanitized); `getLeaderFinish` reads the race
 * leader's recent pace and predicted chequered flag from the translator
 * (issues #880, #1405 — each `null` when unknown, see
 * {@link resolveFuelRaceCoverage} for the fallbacks). It reads this slice's
 * `clockExpiredTicks` after this call has advanced it. It runs in every
 * session kind (issue #1702); `getLeaderFinish` is called in a race only.
 *
 * @param session - `handleTick`'s {@link resolveFuelSessionBranch}: the race
 *   branch (the race-distance coverage and the reassurance), the other one
 *   (the lap-counter coverage alone, never a reassurance), or `"unknown"`,
 *   which returns right after the expired-clock count and writes nothing else
 *   — no sample, no floor and no baseline, so the first tick with a readable
 *   session continues from where the last one left off
 * @param finalLapStarted - whether the player has started their own final
 *   lap, as `handleTick` computes it per session kind (issue #1702). In a
 *   race, the flags' STICKY marker (`TranslatorState.playerFinalLapStarted`,
 *   issue #880) as `diffFlags` left it earlier in the same tick: set with the
 *   #772 white-flag crossing, never re-armed by a mid-final-lap flag change,
 *   and cleared by a later green. In any other session, whether the White
 *   bit is shown on this tick, which practice and qualifying show when the
 *   player starts their own last lap (unmeasured for a heat race or a
 *   warmup, #1767). The diff never reads flags for this itself.
 */
export function diffFuelLapsLeft(
  slice: FuelCalloutState,
  telemetry: TelemetryData,
  session: FuelSessionBranch,
  finalLapStarted: boolean,
  getStats: () => FuelStats,
  getMarginLaps: () => number,
  getLeaderFinish: (playerLapS: number) => LeaderFinish,
  emit: EmitFn<(typeof FUEL_LAPS_LEFT_EVENTS)[number]>,
): void {
  // The expired-clock confirmation (issue #1405), counted on EVERY tick this
  // diff sees, in every session kind and before any early return, so the
  // count is consecutive ticks — invalid input or the sampling gates never
  // freeze it. The leader's chequered prediction (`getLeaderFinish`) reads it
  // later in this same call; the Telemetry Snapshot reads it after the tick.
  slice.clockExpiredTicks = countClockExpiredTicks(telemetry, slice.clockExpiredTicks);

  // An unreadable session type (issue #1702): no branch to pick, and a sample
  // here would advance the floor for a count the Race Engineer refuses in a
  // session it cannot classify, so the count would never be spoken. Nothing
  // is consumed, the baselines included, so the first readable tick carries
  // on from the last one: `lastSampledLap` still stops a lap sampled before
  // the gap from being sampled twice, `lastFuelLevel` lands a refuel made
  // during the gap as one delta (the replay glance's rule), and the saved
  // position, with its lap, lets that tick sample a lap whose crossing fell
  // in the gap (below).
  if (session === "unknown") return;

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

  // Refuel re-arm — runs on every validated tick (a pit-stall fill is a
  // live-in-car state, a garage fill lands as one big delta on the first
  // live tick back). A new stint re-arms both the announce floor and the
  // enough-fuel reassurance (issue #880).
  if (slice.lastFuelLevel !== null && fuelLevel - slice.lastFuelLevel > REFUEL_EPSILON_L) {
    slice.lastAnnouncedCount = null;
    slice.raceCoveredAnnounced = false;
  }

  slice.lastFuelLevel = fuelLevel;

  const lastDistPct = slice.lastDistPct;
  const lastDistLap = slice.lastDistLap;

  // The tick's position becomes the next crossing's baseline on every path
  // below but one: a sample attempt whose fallible
  // work throws — `getStats`, `getMarginLaps` and `getLeaderFinish` are
  // closures over the plugin and the translator — commits nothing of the
  // attempt (issue #1702), so the next tick finds the same crossing and tries
  // again, where a committed attempt would have lost that lap's warning to the
  // step boundary (#1559). Every write of the attempt runs after the last of
  // those calls has returned.
  const commitPosition = (): void => {
    slice.lastDistPct = distPct;
    slice.lastDistLap = lap;
  };
  // The attempt itself: at most one per lap once committed.
  const commitAttempt = (): void => {
    commitPosition();
    slice.lastSampledLap = lap;
  };

  // Seed silently on the first valid tick — no crossing to compare with yet —
  // and re-seed on a lap counter behind the saved position (a rewind or a
  // reset): no lap the countdown has missed, so it waits for a real edge.
  if (lastDistPct === null || lastDistLap === null || lap < lastDistLap) {
    commitPosition();

    return;
  }

  // Whether this lap's mid-lap mark was crossed since the saved position: a
  // rising edge on the same lap, or, from an earlier lap, being at or past
  // the mark now — a real position, where the count is as valid as at the
  // mark (issue #1702). An ordinary tick never takes the second in one step,
  // since it starts a new lap at the line; a tick after a gap the diff did
  // not see does, such as an unreadable session whose span held the
  // crossing. The line guard keeps it from the moment `Lap` and `LapDistPct`
  // can disagree around the line (`LAP_LINE_GUARD_PCT`): a new lap read with
  // the old lap's fraction would look past the mark and be sampled with a
  // count one lap high.
  const crossed =
    lap === lastDistLap
      ? lastDistPct < FUEL_LAPS_LEFT_SAMPLE_PCT && distPct >= FUEL_LAPS_LEFT_SAMPLE_PCT
      : distPct >= FUEL_LAPS_LEFT_SAMPLE_PCT && distPct < 1 - LAP_LINE_GUARD_PCT;

  // At most one sample attempt per lap.
  if (!crossed || lap === slice.lastSampledLap) {
    commitPosition();

    return;
  }

  if (!isLiveOnTrack(telemetry)) {
    commitAttempt();

    return;
  }

  // Race-coverage suppression, part 1 (issue #866): a pit suggestion that
  // can't be acted on usefully is noise. Silent from the leader's checkered
  // onward (a cool-down "box this lap" would be equally wrong, the #657
  // precedent) and on the player's own final lap — in a race the STICKY
  // `playerFinalLapStarted` latch (issue #880), set with the #772 white-flag
  // crossing but never re-armed by a mid-final-lap flag change, so a caution
  // replacing the white can't resurrect the box call. Works in timed races
  // too, where the lap counter below reads the unlimited sentinel.
  // DELIBERATE TRADE-OFF: this silence is unconditional — even an estimate
  // saying the tank won't last to the line stays quiet on the final lap,
  // because at the estimator's ±margin precision a final-lap shortage call
  // is more often noise than a real splash-and-dash opportunity (decided in
  // the #866 review). The reassurance below never fires here either.
  //
  // Outside a race (issue #1702) both gates hold as they are: a practice or
  // qualifying chequered flag ends the running as surely as a race's, and
  // `finalLapStarted` is then the White bit on this tick, which practice and
  // qualifying show when the player starts their own last lap.
  if (isPlayerFinalLapReached(telemetry, finalLapStarted)) {
    commitAttempt();

    return;
  }

  const stats = getStats();

  if (stats.avg === null || stats.avg <= 0) {
    commitAttempt();

    return;
  }

  const estimate = estimateFuelLapsLeft(fuelLevel, distPct, stats.avg, getMarginLaps());
  const { effective, count } = estimate;

  if (session === "race") {
    // The race distance: `resolveFuelRaceCoverage` calls `getLeaderFinish`,
    // the last fallible call, so the attempt is committed once it returns.
    const { remainingLaps } = resolveFuelRaceCoverage(telemetry, stats, estimate.lapFractionRemaining, getLeaderFinish);

    commitAttempt();

    if (coverRace(slice, estimate, remainingLaps, emit)) return;
  } else {
    // Lap-counter coverage outside a race (issue #1702): a lap-limited
    // session (Lone Qualify always is) counts the player's own laps, so a
    // tank that covers them speaks no warning — the same verdict as a race,
    // the floor likewise NOT advanced. No timed side, no leader and no
    // reassurance: there is no race to finish behind anyone, and an unknown
    // or unlimited counter leaves the tank alone to speak.
    const coverage = resolveFuelLapCounterCoverage(telemetry);

    commitAttempt();

    if (coverage !== null && isFuelCovered(estimate, coverage.remainingLaps)) return;
  }

  if (count > FUEL_LAPS_LEFT_MAX_COUNT) return;

  // Descending crossings only; a count already announced stays announced.
  if (slice.lastAnnouncedCount !== null && count >= slice.lastAnnouncedCount) return;

  slice.lastAnnouncedCount = count;
  // A real warning re-arms the reassurance — if coverage recovers (fuel
  // save, the race got shorter), the driver must hear the retraction.
  slice.raceCoveredAnnounced = false;
  emit({ event: "fuel.lapsLeft.crossed", data: { count, lapsLeft: effective } });
}

/**
 * The race branch of {@link diffFuelLapsLeft}'s coverage: the verdict over
 * {@link resolveFuelRaceCoverage}'s distance, which the diff resolves before
 * committing its sample attempt, and the enough-fuel reassurance. Returns
 * whether the tank covers the race, in which case no warning is spoken.
 * Calls nothing that can throw.
 */
function coverRace(
  slice: FuelCalloutState,
  estimate: FuelLapsLeftEstimate,
  remainingLaps: number,
  emit: EmitFn<(typeof FUEL_LAPS_LEFT_EVENTS)[number]>,
): boolean {
  const { unclampedCount } = estimate;

  // Race-coverage determination, part 2 (issue #866, extended by #880 and
  // #1405): when the tank covers the remaining race distance there is
  // nothing to refuel for. The distance is `resolveFuelRaceCoverage`'s — the
  // two limits and which of them binds are worked out there — and the
  // verdict is `isFuelCovered`'s, on the raw tank with no lap margin,
  // and silent whatever the tank when no lap is left after this one (the
  // #866 trade-off, for a player whose own final-lap latch has not fired).
  if (isFuelCovered(estimate, remainingLaps)) {
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
      !slice.raceCoveredAnnounced
    ) {
      slice.raceCoveredAnnounced = true;
      // The all-clear retracts every warning spoken so far: clear the dedup
      // floor so a later coverage flip re-warns at ANY count — a kept floor
      // would leave "enough fuel" as the driver's last word while the tank
      // runs short (after a box-call → reassurance arc, no count could ever
      // fall below a floor of 0 again).
      slice.lastAnnouncedCount = null;
      emit({ event: "fuel.lapsLeft.raceCovered", data: {} });
    }

    // The dedup floor is otherwise deliberately NOT advanced: coverage is
    // re-evaluated every lap, so a burn-rate spike that shrinks the
    // estimate below the race distance still announces on the earlier laps.
    return true;
  }

  return false;
}

/**
 * The full laps the lap counter leaves after the current one: the step both
 * of the diff's branches start from (issue #1702). `SessionLapsRemainEx`
 * includes the current lap, while the count means full laps AFTER it, hence
 * the −1, clamped at 0. `null` when the counter is missing, invalid or reads
 * the `IRSDK_UNLIMITED_LAPS` sentinel: no lap limit.
 *
 * Whose laps it counts depends on the session: the leader's in a race (the
 * 2026-08 capture validation), the player's own in qualifying (#776). The
 * race's adjustments — its white-flag clamp, the timed side — are
 * {@link resolveFuelRaceCoverage}'s, applied on top of this; outside a race
 * {@link resolveFuelLapCounterCoverage} takes it as it is, since the white
 * there flies when the player starts their own last lap, which the diff's
 * final-lap silence already covers.
 *
 * @param telemetry - the tick's telemetry
 */
export function resolveFuelLapCounterLapsAfterCurrent(telemetry: TelemetryData): number | null {
  const rawLapsRemain = resolveLapsRemaining(telemetry);

  return rawLapsRemain === null ? null : Math.max(0, rawLapsRemain - 1);
}

/**
 * The distance by the lap counter alone, in the {@link FuelCoverage} shape
 * (issue #1702): {@link resolveFuelLapCounterLapsAfterCurrent} as both the
 * lap-counter side and the binding distance, with no timed side — what the
 * diff compares the tank with outside a race. `null` with no lap limit, where
 * nothing is compared. One definition for the diff and the Telemetry
 * Snapshot's state reader, so the snapshot explains a suppressed warning by
 * the same distance the diff suppressed it on.
 *
 * @param telemetry - the tick's telemetry
 */
export function resolveFuelLapCounterCoverage(telemetry: TelemetryData): FuelCoverage | null {
  const lapsAfterCurrent = resolveFuelLapCounterLapsAfterCurrent(telemetry);

  if (lapsAfterCurrent === null) return null;

  return { lapsNeededAfterCurrent: lapsAfterCurrent, timedLapsAfterCurrent: null, remainingLaps: lapsAfterCurrent };
}

/**
 * Whether the player has started their own final lap, as `handleTick` hands
 * it to {@link diffFuelLapsLeft} (`finalLapStarted`) and the Telemetry
 * Snapshot's state reader reads it (issue #1702). In a race: the flags'
 * STICKY marker (`TranslatorState.playerFinalLapStarted`, issue #880) as
 * `diffFlags` left it — set at the player's crossing under the white, so the
 * leader's white a lap earlier does not silence the countdown, and kept
 * through a caution replacing the white. That marker is set in races only; in
 * any other session the bit on the tick is the signal, because practice and
 * qualifying show the White when the player starts their own last lap
 * (`diff/flags.ts`, the two-stage white). For a heat race or a warmup that is
 * unmeasured (#1767): a white shown field-wide there would read as the player's last
 * lap and silence the countdown up to a lap early. A pure rule over values
 * its callers read: the diff itself is handed the answer and reads no flag
 * state of its own.
 *
 * @param isRaceSession - the exact `"Race"` match `handleTick` makes
 * @param playerFinalLapStarted - the flags' sticky final-lap marker
 * @param telemetry - the tick's telemetry, for its `SessionFlags`
 */
export function resolveFuelFinalLapStarted(
  isRaceSession: boolean,
  playerFinalLapStarted: boolean,
  telemetry: TelemetryData,
): boolean {
  return isRaceSession ? playerFinalLapStarted : hasFlag(telemetry.SessionFlags, Flags.White);
}

/**
 * The fuel countdown's final-lap silence (issue #1702): the session's
 * chequered flag is out ({@link isPostRace}), or the player has started their
 * own last lap ({@link resolveFuelFinalLapStarted}'s answer). One definition
 * for the emit-time check in {@link diffFuelLapsLeft} and the translator's
 * `isPlayerFinalLapStarted` reader, which the Race Engineer's fuel contracts
 * ask again when a queued count reaches the radio, so speak time applies
 * exactly the rule the count was emitted under.
 *
 * @param telemetry - the tick's telemetry, for its `SessionState`
 * @param finalLapStarted - {@link resolveFuelFinalLapStarted}'s answer for the same tick
 */
export function isPlayerFinalLapReached(telemetry: TelemetryData, finalLapStarted: boolean): boolean {
  return isPostRace(telemetry) || finalLapStarted;
}

/**
 * The narrow re-arm `diffFlags` is handed (issue #880 review, a closure since
 * #1405 moved the fuel state into its slice): closed over the `fuelCallout`
 * slice, so `flags.ts` re-opens the enough-fuel reassurance through
 * `() => void` and never reaches the slice itself. Called when a GREEN rising
 * edge clears the sticky final-lap marker: the race was extended or
 * restarted, so the pre-extension coverage determination no longer holds. The
 * one writer of the slice outside {@link diffFuelLapsLeft}; it writes
 * `raceCoveredAnnounced` only.
 */
export function createFuelReassuranceRearm(slice: FuelCalloutState): () => void {
  return () => {
    slice.raceCoveredAnnounced = false;
  };
}
