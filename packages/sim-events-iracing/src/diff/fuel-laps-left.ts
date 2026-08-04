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
 *   - Race-coverage suppression (issue #866, extended by #880): when the
 *     post-margin count covers the remaining race distance, on the player's
 *     own final lap (the sticky `playerFinalLapStarted` latch — set with the
 *     #772 white-flag crossing, never re-armed by a mid-final-lap flag
 *     change; a later GREEN re-arms it in `diffFlags`, since a green past
 *     the latched lap means the race was extended or restarted), and
 *     post-race (checkered / cool-down), no warning is emitted. The
 *     remaining distance is the SOONER of two independently-known limits:
 *     the lap counter (`count >= SessionLapsRemainEx − 1`; leader-relative
 *     in races per the 2026-08 capture validation, which is the correct
 *     player-crossings count under equal pace and overstates it for a
 *     slower multiclass player — the conservative direction; clamped to
 *     ≥ 1 while the white flies before the player's own crossing, when the
 *     player still runs their own full white lap) and the timed estimate
 *     (the leader's checkered lands at most `SessionTimeRemain +
 *     2 × leaderLap` from now — white at their first crossing AFTER expiry
 *     plus the white lap — or within ONE leader lap once the white is up).
 *     Each comparison suppresses only on a positive "fuel covers the race"
 *     determination — an unknown reading (missing field, the
 *     `IRSDK_UNLIMITED_LAPS` / `IRSDK_UNLIMITED_TIME` sentinels, no
 *     validated lap-time average) keeps announcing — but the final-lap and
 *     post-race gates are UNCONDITIONAL: even a genuinely-short estimate
 *     stays silent there, a deliberate trade-off (#866 review). The
 *     announced floor is NOT advanced by a suppression, so coverage is
 *     re-evaluated every lap and a burn-rate spike that shrinks the
 *     estimate below the race distance still announces on the earlier laps.
 *   - Enough-fuel reassurance (issue #880): when the coverage determination
 *     is positive in the race ENDGAME — 10 or fewer laps to go by the
 *     binding limit — the dedicated `fuel.lapsLeft.raceCovered` event fires
 *     at most once per stint, so the driver hears "we have enough fuel to
 *     finish the race" instead of silence (a huge surplus still gets its
 *     confirmation at 10-to-go; an early-race positive stays quiet). It
 *     requires the UNCLAMPED count to cover the distance WITH A FULL LAP IN
 *     HAND — the truth guard (the count-0 clamp can hide a tank that won't
 *     even finish the current lap) doubling as hysteresis, so boundary
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
import {
  Flags,
  IRSDK_UNLIMITED_LAPS,
  IRSDK_UNLIMITED_TIME,
  isLiveOnTrack,
  isPostRace,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";

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
 * `@iracedeck/deck-core` `global-settings.ts`.
 */
export const FUEL_CALLOUT_DEFAULT_MARGIN_LAPS = 0.3;

/** Margin slider bounds (laps) — mirrors the Zod schema in deck-core. */
export const FUEL_CALLOUT_MARGIN_MIN_LAPS = 0;
export const FUEL_CALLOUT_MARGIN_MAX_LAPS = 3;

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
 * Per-tick laps-of-fuel-left tracking. `getStats` reads the validated fuel
 * estimator (`computeFuelStats` over the instance tracker); `getMarginLaps`
 * is the live-read margin closure injected by the plugin (already
 * sanitized); `getLeaderLapTimeS` reads the race leader's recent pace from
 * the translator (issue #880 — `null` when unknown, falling back to the
 * player's own validated average).
 */
export function diffFuelLapsLeft(
  state: TranslatorState,
  telemetry: TelemetryData,
  isRaceSession: boolean,
  getStats: () => FuelStats,
  getMarginLaps: () => number,
  getLeaderLapTimeS: () => number | null,
  emit: EmitFn,
): void {
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

  const rawLapsLeft = fuelLevel / stats.avg;
  const effective = rawLapsLeft - getMarginLaps();
  const lapFractionRemaining = 1 - distPct;
  // May be negative when the tank won't even finish the current lap — the
  // clamp hides that, so the reassurance's truth guard reads this one.
  const unclampedCount = Math.floor(effective - lapFractionRemaining);
  const count = Math.max(0, unclampedCount);

  // Race-coverage determination, part 2 (issue #866, extended by #880): when
  // the post-margin count covers the remaining race distance there is
  // nothing to refuel for. Two independently-known limits; whichever ends
  // the race sooner binds (a session can carry BOTH a lap and a time limit,
  // #866 limitation 1), and each suppresses only on a positive
  // determination — an unknown reading keeps announcing.
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
  // crossed under it (the sticky latch would have returned above), the
  // leader is on THEIR final lap (raw 1 → 0 needed) but the player still
  // runs the current lap plus their OWN full white lap — clamp to ≥ 1.
  const rawLapsRemain = telemetry.SessionLapsRemainEx;
  let lapsNeededAfterCurrent =
    typeof rawLapsRemain === "number" &&
    Number.isFinite(rawLapsRemain) &&
    rawLapsRemain >= 0 &&
    rawLapsRemain < IRSDK_UNLIMITED_LAPS
      ? Math.max(0, rawLapsRemain - 1)
      : null;

  if (lapsNeededAfterCurrent !== null && whiteUp) {
    lapsNeededAfterCurrent = Math.max(lapsNeededAfterCurrent, 1);
  }

  // Timed estimate (issue #880): the clock expiring does NOT end a timed
  // race — the leader takes the WHITE at their first crossing AFTER expiry
  // (up to one full leader lap later) and the checkered one leader lap
  // after that, so the leader's checkered lands at most
  // `timeRemain + 2 × leaderLap` from now — or within ONE leader lap once
  // the white is already up. The player then finishes the lap they are on.
  // Upper bound on the full laps the player still starts after the current
  // one: ceil((checkeredBound − remaining fraction × avgLap) / avgLap).
  // Leader pace comes from the translator closure (recent → best lap,
  // canonical live order); an unknown leader falls back to the player's own
  // validated average. Overestimating keeps warnings on longer — the safe
  // direction. The averages exclude caution laps (see `FuelLap.wasCaution`),
  // so a long caution can neither deflate the burn rate nor inflate the lap
  // time into a false "enough fuel".
  const timeRemain = telemetry.SessionTimeRemain;
  let timedLapsAfterCurrent: number | null = null;

  if (
    typeof timeRemain === "number" &&
    Number.isFinite(timeRemain) &&
    timeRemain >= 0 &&
    timeRemain < IRSDK_UNLIMITED_TIME &&
    stats.avgLapTime !== null &&
    stats.avgLapTime > 0
  ) {
    const leaderRaw = getLeaderLapTimeS();
    const leaderLap =
      typeof leaderRaw === "number" && Number.isFinite(leaderRaw) && leaderRaw > 0 ? leaderRaw : stats.avgLapTime;
    const leaderChequeredBoundS = whiteUp ? leaderLap : timeRemain + 2 * leaderLap;

    timedLapsAfterCurrent = Math.max(
      0,
      Math.ceil((leaderChequeredBoundS - lapFractionRemaining * stats.avgLapTime) / stats.avgLapTime),
    );
  }

  // The binding remaining distance — the limit that actually ends the race.
  // Infinity when neither limit is known, which keeps every comparison
  // below false (announce on unknown).
  const remainingLaps = Math.min(
    lapsNeededAfterCurrent ?? Number.POSITIVE_INFINITY,
    timedLapsAfterCurrent ?? Number.POSITIVE_INFINITY,
  );

  if (count >= remainingLaps) {
    // Enough-fuel reassurance (issue #880): a positive coverage
    // determination in the race ENDGAME becomes ONE "we have enough fuel to
    // finish the race" per stint — the driver hears the topic closed
    // instead of silence, and a spoken warning gets retracted when coverage
    // turns positive later. Guards: the race must be inside its last
    // FUEL_LAPS_LEFT_MAX_COUNT laps (the same 10-lap horizon the warnings
    // speak over, anchored on the RACE rather than the tank, so even a huge
    // surplus gets its confirmation at 10-to-go while an early-race
    // positive stays quiet); the UNCLAMPED count must cover the distance
    // WITH A FULL LAP IN HAND (the +1 is both the truth guard — the count-0
    // clamp can hide a tank that won't finish even the current lap — and
    // the hysteresis that stops estimate noise at the coverage boundary
    // from alternating contradictory warn/reassure callouts); and the latch
    // must be unset (re-armed by refuels and by later real warnings).
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
