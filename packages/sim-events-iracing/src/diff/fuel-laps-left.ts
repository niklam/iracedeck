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
 *   - Race-coverage suppression (issue #866): when the post-margin count
 *     covers the remaining race laps (`count >= SessionLapsRemainEx − 1`,
 *     lap-limited races), on the player's own final lap (the #772 white-flag
 *     crossing latch — timed races too), and post-race (checkered /
 *     cool-down), nothing is emitted. The announced floor is NOT advanced by
 *     a suppression, so coverage is re-evaluated every lap and a burn-rate
 *     spike that shrinks the estimate below the race distance still
 *     announces. Unknown laps remaining (missing field, the 32767 timed
 *     sentinel) keeps announcing — silence only on a positive "fuel covers
 *     the race" determination.
 *
 * Race sessions only, live in car, and silent until the tracker has valid
 * samples — no estimate, no callout, never a guess.
 */
import { isLiveOnTrack, isPostRace, type TelemetryData } from "@iracedeck/iracing-sdk";

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
 * `SessionLapsRemainEx` sentinel in sessions without a lap limit (timed
 * races) — the translator's `UNLIMITED_LAPS`. At or above it the reading is
 * not a lap count, so race-coverage suppression treats it as unknown.
 */
const SESSION_LAPS_UNLIMITED = 32767;

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
 * is the live-read margin closure injected by the plugin (already sanitized).
 */
export function diffFuelLapsLeft(
  state: TranslatorState,
  telemetry: TelemetryData,
  isRaceSession: boolean,
  getStats: () => FuelStats,
  getMarginLaps: () => number,
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
  // live tick back).
  if (state.fuelCalloutLastFuelLevel !== null && fuelLevel - state.fuelCalloutLastFuelLevel > REFUEL_EPSILON_L) {
    state.fuelCalloutLastAnnouncedCount = null;
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
  // precedent) and on the player's own final lap — the #772 white-flag
  // crossing latch, which works in timed races too, where the lap counter
  // below reads the unlimited sentinel.
  if (isPostRace(telemetry) || state.whiteLastLapFired) return;

  const stats = getStats();

  if (stats.avg === null || stats.avg <= 0) return;

  const rawLapsLeft = fuelLevel / stats.avg;
  const effective = rawLapsLeft - getMarginLaps();
  const count = Math.max(0, Math.floor(effective - (1 - distPct)));

  // Race-coverage suppression, part 2 (issue #866): in a lap-limited race,
  // when the post-margin count covers the remaining race distance there is
  // nothing to refuel for. `count` and `SessionLapsRemainEx` share the same
  // "includes the current lap" shape (#776), so the comparison is
  // `count >= raw − 1` (full laps needed after the current one). The dedup
  // floor is deliberately NOT advanced: coverage is re-evaluated every lap,
  // so a burn-rate spike that shrinks the estimate below the race distance
  // still announces. An unknown reading (missing field, negative, the timed
  // sentinel) keeps announcing — silence only on a positive "fuel covers
  // the race" determination.
  const rawLapsRemain = telemetry.SessionLapsRemainEx;

  if (
    typeof rawLapsRemain === "number" &&
    Number.isFinite(rawLapsRemain) &&
    rawLapsRemain >= 0 &&
    rawLapsRemain < SESSION_LAPS_UNLIMITED &&
    count >= Math.max(0, rawLapsRemain - 1)
  ) {
    return;
  }

  if (count > FUEL_LAPS_LEFT_MAX_COUNT) return;

  // Descending crossings only; a count already announced stays announced.
  if (state.fuelCalloutLastAnnouncedCount !== null && count >= state.fuelCalloutLastAnnouncedCount) return;

  state.fuelCalloutLastAnnouncedCount = count;
  emit({ event: "fuel.lapsLeft.crossed", data: { count, lapsLeft: effective } });
}
