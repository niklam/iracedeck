import { AudioBus, AudioChannel, getAudio } from "@iracedeck/audio-service";
import {
  applyGraphicTransform,
  CommonSettings,
  computeGraphicArea,
  ConnectionStateAwareAction,
  generateBorderParts,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import {
  calculateRacePositions,
  CarLeftRight,
  EngineWarnings,
  Flags,
  hasFlag,
  PitSvFlags,
  type TelemetryData,
  TrkLoc,
  TrkSurf,
} from "@iracedeck/iracing-sdk";
import path from "node:path";
import z from "zod";

import pitEngineerTemplate from "../../../icons/pit-engineer.svg";
import { borderColorForState, statusBarOff, statusBarOn } from "../../icons/status-bar.js";

// ─── Constants ─────────────────────────────────────────────────────────────────

const WHITE = "#ffffff";

/** @internal Exported for testing */
export const PIT_ENGINEER_UUID = "com.iracedeck.sd.core.pit-engineer";

// ─── Audio Channel Volumes ────────────────────────────────────────────────────
//
// Bus layout (sound groups):
//   Voice      — engineer messages, acks, connectors
//   Background — pit ambient loop + walkie ticks (intrinsic mix ratios live in deck-core)
//   Alerts     — directional spotter (independent of engineer volume)
//
// The PI "volume" slider drives the Voice + Background busses together (the
// "engineer" bus pair). The "spotterVolume" slider drives the Alerts bus.
// Per-channel attenuation (Ambient 0.8, SFX 0.7) is baked into the bus's
// channel mix ratios in audio-service.ts.

/** Applies volume-slider values to the audio busses. */
function applyChannelVolumes(): void {
  if (!globalSettings) return;

  const engineerVol = globalSettings.volume / 100;
  const spotterVol = globalSettings.spotterVolume / 100;

  getAudio().setBusVolume(AudioBus.Voice, engineerVol);
  getAudio().setBusVolume(AudioBus.Background, engineerVol);
  getAudio().setBusVolume(AudioBus.Alerts, spotterVol);
}

// ─── Acknowledgment & Connector Pools ─────────────────────────────────────────

const ACKNOWLEDGMENT_POOL = [
  "acknowledgment/IRD-ack-okay.mp3",
  "acknowledgment/IRD-ack-got-it.mp3",
  "acknowledgment/IRD-ack-roger-that.mp3",
  "acknowledgment/IRD-ack-copy-that.mp3",
  "acknowledgment/IRD-ack-we-got-that.mp3",
];

const CONNECTOR_POOL = [
  "connector/IRD-connector-and.mp3",
  "connector/IRD-connector-also.mp3",
  "connector/IRD-connector-plus.mp3",
  "connector/IRD-connector-as-well-as.mp3",
  "connector/IRD-connector-addition.mp3",
];

/** Last acknowledgment index to avoid repeats. */
let lastAckIndex = -1;

/** Pick a random acknowledgment, never the same back-to-back. */
function pickAcknowledgment(): string {
  let idx: number;

  do {
    idx = Math.floor(Math.random() * ACKNOWLEDGMENT_POOL.length);
  } while (idx === lastAckIndex && ACKNOWLEDGMENT_POOL.length > 1);

  lastAckIndex = idx;

  return ACKNOWLEDGMENT_POOL[idx];
}

// ─── Stall Departure Pool ────────────────────────────────────────────────────

const STALL_DEPARTURE_POOL = [
  "pitlane/IRD-pit-stall-departure.mp3",
  "pitlane/IRD-pit-stall-departure-2.mp3",
  "pitlane/IRD-pit-stall-departure-3.mp3",
  "pitlane/IRD-pit-stall-departure-4.mp3",
];

let lastStallDepartureIndex = -1;

function pickStallDeparture(): string {
  let idx: number;

  do {
    idx = Math.floor(Math.random() * STALL_DEPARTURE_POOL.length);
  } while (idx === lastStallDepartureIndex && STALL_DEPARTURE_POOL.length > 1);

  lastStallDepartureIndex = idx;

  return STALL_DEPARTURE_POOL[idx];
}

// ─── Overtake Pool ──────────────────────────────────────────────────────────

const OVERTAKE_POOL = [
  "overtake/IRD-overtake-good-pass.mp3",
];

let lastOvertakeIndex = -1;

function pickOvertake(): string {
  let idx: number;

  do {
    idx = Math.floor(Math.random() * OVERTAKE_POOL.length);
  } while (idx === lastOvertakeIndex && OVERTAKE_POOL.length > 1);

  lastOvertakeIndex = idx;

  return OVERTAKE_POOL[idx];
}

// ─── Auto-Fuel Reminder Pool ────────────────────────────────────────────────

const AUTOFUEL_REMINDER_POOL = [
  "reminder/IRD-pit-reminder-autofuel.mp3",
  "reminder/IRD-pit-reminder-autofuel-2.mp3",
];

/** Last auto-fuel reminder index to avoid repeats. */
let lastAutofuelReminderIndex = -1;

/** Pick a random auto-fuel reminder, never the same back-to-back. */
function pickAutofuelReminder(): string {
  let idx: number;

  do {
    idx = Math.floor(Math.random() * AUTOFUEL_REMINDER_POOL.length);
  } while (idx === lastAutofuelReminderIndex && AUTOFUEL_REMINDER_POOL.length > 1);

  lastAutofuelReminderIndex = idx;

  return AUTOFUEL_REMINDER_POOL[idx];
}

// ─── Pit Approach Pool ───────────────────────────────────────────────────────

const PIT_APPROACH_POOL = [
  "pitlane/IRD-pit-approach.mp3",
  "pitlane/IRD-pit-approach-2.mp3",
];

/** Last pit approach index to avoid repeats. */
let lastPitApproachIndex = -1;

/** Pick a random pit approach message, never the same back-to-back. */
function pickPitApproach(): string {
  let idx: number;

  do {
    idx = Math.floor(Math.random() * PIT_APPROACH_POOL.length);
  } while (idx === lastPitApproachIndex && PIT_APPROACH_POOL.length > 1);

  lastPitApproachIndex = idx;

  return PIT_APPROACH_POOL[idx];
}

// ─── Pit Exit Pool ───────────────────────────────────────────────────────────

const PIT_EXIT_POOL = [
  "pitlane/IRD-pit-exit.mp3",
  "pitlane/IRD-pit-exit-2.mp3",
  "pitlane/IRD-pit-exit-3.mp3",
  "pitlane/IRD-pit-exit-4.mp3",
  "pitlane/IRD-pit-exit-5.mp3",
  "pitlane/IRD-pit-exit-6.mp3",
];

/** Last pit exit index to avoid repeats. */
let lastPitExitIndex = -1;

/** Pick a random pit exit message, never the same back-to-back. */
function pickPitExit(): string {
  let idx: number;

  do {
    idx = Math.floor(Math.random() * PIT_EXIT_POOL.length);
  } while (idx === lastPitExitIndex && PIT_EXIT_POOL.length > 1);

  lastPitExitIndex = idx;

  return PIT_EXIT_POOL[idx];
}

// ─── Greeting Pool ───────────────────────────────────────────────────────────

const GREETING_POOL = [
  "radio-openers/IRD-radio-opener-alright.mp3",
  "radio-openers/IRD-radio-opener-hi.mp3",
  "radio-openers/IRD-radio-opener-right-then.mp3",
  "radio-openers/IRD-radio-opener-so.mp3",
];

/** Last greeting index to avoid repeats. */
let lastGreetingIndex = -1;

/** Pick a random greeting, never the same back-to-back. */
function pickGreeting(): string {
  let idx: number;

  do {
    idx = Math.floor(Math.random() * GREETING_POOL.length);
  } while (idx === lastGreetingIndex && GREETING_POOL.length > 1);

  lastGreetingIndex = idx;

  return GREETING_POOL[idx];
}

// ─── Tip Pool ────────────────────────────────────────────────────────────────

/**
 * @internal Exported for testing
 *
 * Full list of racing tips. Certain tips are restricted to either the
 * start-of-race window or mid-race only (see below). The rest are eligible
 * at any point.
 */
export const TIP_POOL = [
  "tips/IRD-pit-engineer-tip-1.mp3",
  "tips/IRD-pit-engineer-tip-2.mp3",
  "tips/IRD-pit-engineer-tip-3.mp3",
  "tips/IRD-pit-engineer-tip-4.mp3",
  "tips/IRD-pit-engineer-tip-5.mp3",
  "tips/IRD-pit-engineer-tip-6.mp3",
  "tips/IRD-pit-engineer-tip-7.mp3",
  "tips/IRD-pit-engineer-tip-8.mp3",
  "tips/IRD-pit-engineer-tip-9.mp3",
  "tips/IRD-pit-engineer-tip-10.mp3",
  "tips/IRD-pit-engineer-tip-11.mp3",
];

/**
 * @internal Exported for testing
 *
 * Tips that should only be played during the start-of-race window
 * (formation/pace lap through lap 1). Excluded from the mid-race pool.
 */
export const START_ONLY_TIPS: ReadonlySet<string> = new Set([
  "tips/IRD-pit-engineer-tip-6.mp3",
  "tips/IRD-pit-engineer-tip-7.mp3",
]);

/**
 * @internal Exported for testing
 *
 * Tips that should only be played mid-race (after the start window closes).
 * Excluded from the start-of-race pool.
 */
export const MID_RACE_ONLY_TIPS: ReadonlySet<string> = new Set([
  "tips/IRD-pit-engineer-tip-11.mp3",
]);

/** Last tip file played to avoid repeats. */
let lastTipFile: string | null = null;

/**
 * Picks a random LapDistPct trigger point for the next tip.
 * Range: 0.15–0.85 (avoids start/finish zone and pit entry/exit zones).
 */
function pickRandomTriggerPct(): number {
  return 0.15 + Math.random() * 0.7;
}

/**
 * @internal Exported for testing
 *
 * Returns the subset of tips eligible for the given race phase.
 * - Start window: excludes MID_RACE_ONLY_TIPS
 * - Mid-race: excludes START_ONLY_TIPS
 */
export function getEligibleTips(isStartWindow: boolean): string[] {
  const excluded = isStartWindow ? MID_RACE_ONLY_TIPS : START_ONLY_TIPS;

  return TIP_POOL.filter((tip) => !excluded.has(tip));
}

/** Pick a random tip for the given race phase, never the same back-to-back. */
function pickTip(isStartWindow: boolean): string {
  const eligible = getEligibleTips(isStartWindow);
  let choice: string;

  do {
    choice = eligible[Math.floor(Math.random() * eligible.length)];
  } while (choice === lastTipFile && eligible.length > 1);

  lastTipFile = choice;

  return choice;
}

// ─── Fuel Warnings Pools ─────────────────────────────────────────────────────
//
// Pit Engineer fuel warnings. Thresholds are documented in
// project_fuel_warnings_plan.md and tuned "safety first": the voice warns
// a lap earlier than the number it says (e.g. "5 laps" fires at 6 laps
// remaining). See `FUEL_THRESHOLDS` and `resolveFuelWarning` below.

/** @internal Exported for testing */
export const FUEL_STINT_OPEN_POOL = [
  "fuel-warnings/stint-open/IRD-fuel-stint-open-01.mp3",
  "fuel-warnings/stint-open/IRD-fuel-stint-open-02.mp3",
  "fuel-warnings/stint-open/IRD-fuel-stint-open-03.mp3",
];

/** @internal Exported for testing */
export const FUEL_PIT_WINDOW_POOL = [
  "fuel-warnings/pit-window/IRD-fuel-pit-window-01.mp3",
  "fuel-warnings/pit-window/IRD-fuel-pit-window-02.mp3",
  "fuel-warnings/pit-window/IRD-fuel-pit-window-03.mp3",
];

/** @internal Exported for testing */
export const FUEL_MAKE_END_POOL = [
  "fuel-warnings/make-end/IRD-fuel-make-end-01.mp3",
  "fuel-warnings/make-end/IRD-fuel-make-end-02.mp3",
  "fuel-warnings/make-end/IRD-fuel-make-end-03.mp3",
];

/** @internal Exported for testing */
export const FUEL_ON_PLAN_POOL = [
  "fuel-warnings/on-plan/IRD-fuel-on-plan-01.mp3",
  "fuel-warnings/on-plan/IRD-fuel-on-plan-02.mp3",
  "fuel-warnings/on-plan/IRD-fuel-on-plan-03.mp3",
];

/** @internal Exported for testing */
export const FUEL_HIGH_CONSUMPTION_POOL = [
  "fuel-warnings/high-consumption/IRD-fuel-high-consumption-01.mp3",
  "fuel-warnings/high-consumption/IRD-fuel-high-consumption-02.mp3",
  "fuel-warnings/high-consumption/IRD-fuel-high-consumption-03.mp3",
];

/** @internal Exported for testing */
export const FUEL_SAVE_POOL = [
  "fuel-warnings/save/IRD-fuel-save-01.mp3",
  "fuel-warnings/save/IRD-fuel-save-02.mp3",
  "fuel-warnings/save/IRD-fuel-save-03.mp3",
];

/** @internal Exported for testing */
export const FUEL_LOW_5_POOL = [
  "fuel-warnings/low-5laps/IRD-fuel-low-5laps-01.mp3",
  "fuel-warnings/low-5laps/IRD-fuel-low-5laps-02.mp3",
  "fuel-warnings/low-5laps/IRD-fuel-low-5laps-03.mp3",
];

/** @internal Exported for testing */
export const FUEL_LOW_3_POOL = [
  "fuel-warnings/low-3laps/IRD-fuel-low-3laps-01.mp3",
  "fuel-warnings/low-3laps/IRD-fuel-low-3laps-02.mp3",
  "fuel-warnings/low-3laps/IRD-fuel-low-3laps-03.mp3",
];

/** @internal Exported for testing */
export const FUEL_CRITICAL_POOL = [
  "fuel-warnings/critical/IRD-fuel-critical-01.mp3",
  "fuel-warnings/critical/IRD-fuel-critical-02.mp3",
  "fuel-warnings/critical/IRD-fuel-critical-03.mp3",
];

/** @internal Exported for testing */
export const FUEL_EMPTY_POOL = [
  "fuel-warnings/empty/IRD-fuel-empty-01.mp3",
  "fuel-warnings/empty/IRD-fuel-empty-02.mp3",
  "fuel-warnings/empty/IRD-fuel-empty-03.mp3",
];

/** @internal Exported for testing */
export const FUEL_REFUEL_DONE_POOL = [
  "fuel-warnings/refuel-done/IRD-fuel-refuel-done-01.mp3",
  "fuel-warnings/refuel-done/IRD-fuel-refuel-done-02.mp3",
  "fuel-warnings/refuel-done/IRD-fuel-refuel-done-03.mp3",
];

/**
 * Last index tracker for back-to-back exclusion per pool. Keyed by pool
 * reference identity — a pool is allowed to pick any entry except the one
 * just played.
 */
const fuelLastIdx = new WeakMap<readonly string[], number>();

/**
 * @internal Exported for testing
 *
 * Picks a random entry from a pool, never the same back-to-back.
 * Uses an internal WeakMap keyed by the pool reference so each pool
 * tracks its own "last played" index independently.
 */
export function pickFromPool(pool: readonly string[]): string {
  if (pool.length === 0) return "";

  const last = fuelLastIdx.get(pool) ?? -1;
  let idx: number;

  do {
    idx = Math.floor(Math.random() * pool.length);
  } while (idx === last && pool.length > 1);

  fuelLastIdx.set(pool, idx);

  return pool[idx];
}

/**
 * @internal Exported for testing
 *
 * Resets the back-to-back tracker for every fuel pool. Used by tests and
 * by telemetry reset.
 */
export function resetFuelPickers(): void {
  fuelLastIdx.delete(FUEL_STINT_OPEN_POOL);
  fuelLastIdx.delete(FUEL_PIT_WINDOW_POOL);
  fuelLastIdx.delete(FUEL_MAKE_END_POOL);
  fuelLastIdx.delete(FUEL_ON_PLAN_POOL);
  fuelLastIdx.delete(FUEL_HIGH_CONSUMPTION_POOL);
  fuelLastIdx.delete(FUEL_SAVE_POOL);
  fuelLastIdx.delete(FUEL_LOW_5_POOL);
  fuelLastIdx.delete(FUEL_LOW_3_POOL);
  fuelLastIdx.delete(FUEL_CRITICAL_POOL);
  fuelLastIdx.delete(FUEL_EMPTY_POOL);
  fuelLastIdx.delete(FUEL_REFUEL_DONE_POOL);
}

// ─── Fuel Warning Thresholds (safety-first defaults) ─────────────────────────
//
// Voice says "5 laps" but the warning fires at 6 laps remaining — the driver
// hears the callout one lap earlier than the number to give margin. Same for
// 3→4, 1→2, and empty fires with 0.8 laps left (not 0.3). Rationale captured
// in project_fuel_warnings_plan.md.

/** @internal Exported for testing */
export const FUEL_THRESHOLDS = {
  /** "5 laps" audio fires when lapsRemaining drops below this. */
  low5: 6,
  /** "3 laps" audio fires below this (priority). */
  low3: 4,
  /** "1 lap / critical" audio fires below this (priority). */
  critical: 2,
  /** "Empty / on fumes" audio fires below this (priority). */
  empty: 0.8,
  /** Save-fuel coaching fires when lapsRemaining < sessionLapsLeft + this margin. */
  saveMarginLaps: 1.5,
  /** Save-fuel re-arm interval in laps. */
  saveRearmLaps: 5,
  /** Short rolling window (recent-trend) for dual-window estimate. */
  shortWindow: 3,
  /** Per-lap consumption spike over rolling avg that triggers high-consumption (+8%). */
  highConsumptionRatio: 1.08,
  /** Mid-stint on-plan checkpoint interval (laps). */
  midStintLaps: 5,
  /** Minimum valid laps of history before voice uses rolling avg. */
  minHistoryForAvg: 2,
  /** Refuel detection: tank must increase by this much (same units as FuelLevel). */
  refuelDeltaThreshold: 0.05,
  /** Refuel detection: minimum ms between two refuel events (debounce). */
  refuelDebounceMs: 5000,
  /** Bootstrap safety padding on FuelUsePerHour estimate (15%). */
  bootstrapPadding: 1.15,
  /** Bootstrap: minimum lap progress before using live current-lap estimate. */
  liveBootstrapMinProgress: 0.5,
  /** Voice cooldown: minimum ms between non-priority fuel callouts. */
  calloutCooldownMs: 30_000,
  /** Hysteresis: once make-end has fired, save-fuel only if we drop this many laps below session laps left. */
  hysteresisMarginLaps: 1.0,
  /**
   * Silence ALL fuel callouts (including priority thresholds like low5/low3/critical/empty)
   * until we have at least this many valid laps in history. With minHistoryForCallouts=2 and
   * lap 1 always skipped by isLapUsableForAvg, callouts begin at lap 4. Prevents false alarms
   * on short circuits where the bootstrap FuelUsePerHour estimate triggers low-fuel warnings
   * before we have any real per-lap data.
   */
  minHistoryForCallouts: 2,
} as const;

/**
 * @internal Exported for testing
 *
 * Confidence tier from the number of valid lap samples in our rolling history.
 * Drives margin size and which callouts are allowed. Very low = silent on
 * race-math; low = wide margin so short-track decisions hold; medium/high =
 * tighter bands once we trust the data.
 */
export type FuelConfidence = "veryLow" | "low" | "medium" | "high";

export function getFuelConfidence(validLapCount: number): FuelConfidence {
  if (validLapCount < 2) return "veryLow";

  if (validLapCount < 4) return "low";

  if (validLapCount < 8) return "medium";

  return "high";
}

/**
 * @internal Exported for testing
 *
 * Extra laps of safety margin added on top of the session-laps-left target
 * before we're willing to say "you can make the end." Wider at low confidence
 * so a noisy 2-lap history doesn't drive a decision we later contradict.
 */
export function getMakeEndMarginLaps(conf: FuelConfidence): number {
  switch (conf) {
    case "veryLow":
      return 99;
    case "low":
      return 1.5;
    case "medium":
      return 0.5;
    case "high":
      return 0.25;
  }
}

/**
 * @internal Exported for testing
 *
 * Whether race-math callouts (make-end / pit-window / save-fuel / stint-opener
 * / mid-stint) are allowed at this confidence level. veryLow = safety only.
 */
export function raceMathAllowed(conf: FuelConfidence): boolean {
  return conf !== "veryLow";
}

// ─── Fuel Warning Pure Helpers ───────────────────────────────────────────────

/**
 * @internal Exported for testing
 *
 * Whether a sampled lap should contribute to the rolling consumption average.
 * Skip laps that spent any time on pit road (in/out laps), cautions, the
 * first race lap (standing start burns more), and tow laps.
 */
export function isLapUsableForAvg(params: {
  lapTouchedPit: boolean;
  underCaution: boolean;
  lap: number;
  towTime: number;
  fuelUsed: number;
}): boolean {
  if (params.lapTouchedPit) return false;

  if (params.underCaution) return false;

  if (params.lap <= 1) return false;

  if (params.towTime > 0) return false;

  // Negative/zero usage means refuel or bad sample
  if (params.fuelUsed <= 0) return false;

  return true;
}

/**
 * @internal Exported for testing
 *
 * Conservative rolling consumption estimate: max(mean, 90th percentile).
 * Biases toward "slightly thirsty" so warnings fire a touch earlier when
 * consumption is inconsistent. Returns undefined if history is too short.
 */
export function computeConservativeAvg(history: readonly number[]): number | undefined {
  if (history.length < FUEL_THRESHOLDS.minHistoryForAvg) return undefined;

  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const sorted = [...history].sort((a, b) => a - b);
  const pIdx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1);
  const p90 = sorted[Math.max(0, pIdx)];

  return Math.max(mean, p90);
}

/**
 * @internal Exported for testing
 *
 * Dual-window fuel estimate for trend-aware laps-remaining math.
 *
 * - `warning` — the **higher** of the 5-lap and 3-lap conservative averages.
 *   Used for threshold warnings (low5/3/critical/empty, save-fuel, high-consumption).
 *   Stays safety-first: if the last 3 laps are thirstier than the 5-lap window,
 *   we warn against the worse number.
 *
 * - `raceMath` — the **lower** of the two. Used for pit-window / make-end math.
 *   Lets the driver benefit from an improving trend (lighter car, cleaner laps)
 *   so the pit window doesn't open prematurely.
 *
 * Returns `undefined` when history is too short for a 5-lap avg. When the 3-lap
 * window itself isn't yet full (<3 laps), both fields fall back to the 5-lap avg.
 */
export function computeDualWindowAvgs(history: readonly number[]): { warning: number; raceMath: number } | undefined {
  const longAvg = computeConservativeAvg(history);

  if (longAvg === undefined) return undefined;

  const shortSlice = history.slice(-FUEL_THRESHOLDS.shortWindow);
  const shortAvg = shortSlice.length >= FUEL_THRESHOLDS.shortWindow ? computeConservativeAvg(shortSlice) : undefined;

  if (shortAvg === undefined) {
    return { warning: longAvg, raceMath: longAvg };
  }

  return {
    warning: Math.max(longAvg, shortAvg),
    raceMath: Math.min(longAvg, shortAvg),
  };
}

/**
 * @internal Exported for testing
 *
 * Decides the priority warning (empty/critical/low3/low5) for a given
 * lapsRemaining estimate, given which thresholds have already been fired
 * during this stint. Returns the highest-urgency unfired warning, or null
 * if nothing to fire. Lower-urgency fired flags are unaffected.
 */
export type FuelFiredFlags = {
  empty: boolean;
  critical: boolean;
  low3: boolean;
  low5: boolean;
};
export type FuelWarningChoice =
  | { level: "empty"; priority: true }
  | { level: "critical"; priority: true }
  | { level: "low3"; priority: true }
  | { level: "low5"; priority: false }
  | null;

export function resolveFuelWarning(lapsRemaining: number, fired: FuelFiredFlags): FuelWarningChoice {
  if (lapsRemaining < FUEL_THRESHOLDS.empty && !fired.empty) {
    return { level: "empty", priority: true };
  }

  if (lapsRemaining < FUEL_THRESHOLDS.critical && !fired.critical) {
    return { level: "critical", priority: true };
  }

  if (lapsRemaining < FUEL_THRESHOLDS.low3 && !fired.low3) {
    // 3-lap warning is priority per "safer" defaults
    return { level: "low3", priority: true };
  }

  if (lapsRemaining < FUEL_THRESHOLDS.low5 && !fired.low5) {
    return { level: "low5", priority: false };
  }

  return null;
}

/**
 * @internal Exported for testing
 *
 * Whether a save-fuel callout should fire this tick. True when our estimated
 * laps-remaining is shorter than the session laps left plus a small margin
 * AND we're at least `saveRearmLaps` past the last save callout (rolling
 * reminder, not fire-once).
 */
export function shouldFireSaveFuel(params: {
  lapsRemaining: number;
  sessionLapsLeft: number;
  currentLap: number;
  lastSaveLap: number;
}): boolean {
  if (params.sessionLapsLeft <= 0) return false;

  const short = params.lapsRemaining < params.sessionLapsLeft + FUEL_THRESHOLDS.saveMarginLaps;
  const canMakeEnd = params.lapsRemaining >= params.sessionLapsLeft;

  if (canMakeEnd) return false;

  if (!short) return false;

  if (params.lastSaveLap < 0) return true;

  return params.currentLap - params.lastSaveLap >= FUEL_THRESHOLDS.saveRearmLaps;
}

// ─── Driver Name ──────────────────────────────────────────────────────────────
//
// The driver name file is selected from the names/ folder.
// Multiple names can be added (e.g., IRD-name-john.mp3, IRD-name-mike.mp3).
//
// To add a new name:
//   1. Place the mp3 file named `IRD-name-<lowercase>.mp3` in all three dirs:
//        - packages/audio-assets/names/
//        - packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/assets/audio/names/
//        - packages/mirabox-plugin/com.iracedeck.sd.core.sdPlugin/assets/audio/names/
//      (Mirabox rollup does not copy from audio-assets/, so the plugin dirs must have it.)
//   2. Add an entry to the NAMES array in
//      packages/stream-deck-plugin/src/pi/pit-engineer.ejs — keep alphabetical.
//        { value: '<lowercase>', label: '<TitleCase>' }
//      (Mirabox reuses the same EJS via piTemplatePlugin — no separate edit needed.)
//   3. Build + pack both plugins:
//        pnpm build
//        cd packages/mirabox-plugin && pnpm pack:plugin
//        cd packages/stream-deck-plugin && npx streamdeck pack com.iracedeck.sd.core.sdPlugin --force --ignore-validation -o ../../local

/** Returns the configured driver name audio file, or null if no name is set. */
function getDriverNameFile(): string | null {
  const name = globalSettings?.driverName;

  if (!name || name === "none") return null;

  return `names/IRD-name-${name}.mp3`;
}

// ─── Radio Flow Orchestrator ──────────────────────────────────────────────────
//
// Four flow types for the walkie-talkie radio experience:
//
// Full flow (toggles, approach, exit, stall departure):
//   [tick-open] → [ack + ambient] → [(name occasionally)] → [messages with connectors]
//   → [ambient stops] → [tick-close]
//
// Reminder flow (service reminders, auto-fuel — NO acknowledgment):
//   [tick-open] → [ambient + reminder messages (with connectors)] → [ambient stops] → [tick-close]
//
// Warning flow (pit limiter):
//   [tick-open] → [ambient + message] → [ambient stops] → [tick-close]
//
// Welcome flow (first time in car):
//   [tick-open] → [(greeting ~60%)] → [(driver name)] → [tip] → [tick-close]

type RadioFlowState = "idle" | "tick-open" | "ack" | "messages" | "tick-close";
let radioFlowState: RadioFlowState = "idle";

/**
 * Plays a radio-style message sequence.
 *
 * @param files - Message audio filenames (relative to audio root)
 * @param includeAck - Whether to play an acknowledgment before messages (default: true)
 */
function playRadioMessage(files: string[], includeAck = true): void {
  if (files.length === 0) return;

  applyChannelVolumes();

  // Cancel any in-progress radio flow
  cancelRadioFlow();

  radioFlowState = "tick-open";

  // Step 1: Play tick-open on SFX (clean — no ambient)
  getAudio().onChannelComplete(AudioChannel.SFX, () => {
    if (radioFlowState !== "tick-open") return;

    // Step 2: Start ambient loop at a random position (different each transmission)
    getAudio().playOnChannel(AudioChannel.Ambient, getAudioPath("sfx/IRD-ambient-pit.mp3"), true);
    getAudio().seekChannelRandom(AudioChannel.Ambient);

    // Optional micro-delay after tick — ambient plays, voice waits
    randomRadioDelay("tick-open", () => {
      if (includeAck) {
        // Step 2a: Play acknowledgment on Voice
        radioFlowState = "ack";
        getAudio().onChannelComplete(AudioChannel.Voice, () => {
          if (radioFlowState !== "ack") return;

          startVoiceMessages(files);
        });
        getAudio().playOnChannel(AudioChannel.Voice, getAudioPath(pickAcknowledgment()));
      } else {
        // Step 2b: Skip ack, go straight to messages
        startVoiceMessages(files);
      }
    });
  });

  getAudio().playOnChannel(AudioChannel.SFX, getAudioPath("sfx/IRD-tick-open.mp3"));
}

/**
 * Adds a random micro-delay before invoking a callback.
 * ~40% chance of a 100–400ms pause — ambient stays audible during the gap,
 * giving the radio transmission a natural, human feel.
 */
function randomRadioDelay(state: RadioFlowState, callback: () => void): void {
  const doDelay = Math.random() < 0.4;
  const delayMs = doDelay ? 100 + Math.floor(Math.random() * 300) : 0;

  if (delayMs > 0) {
    setTimeout(() => {
      // Guard: flow may have been cancelled during the delay
      if (radioFlowState !== state) return;

      callback();
    }, delayMs);
  } else {
    callback();
  }
}

/**
 * Plays the tick-close SFX after a subtle delay (100–400ms).
 * Ambient stays audible during the pause for a natural radio feel.
 */
function playTickClose(): void {
  const delayMs = 100 + Math.floor(Math.random() * 300);
  setTimeout(() => {
    if (radioFlowState !== "tick-close") return;

    getAudio().stopChannel(AudioChannel.Ambient);
    getAudio().onChannelComplete(AudioChannel.SFX, () => {
      radioFlowState = "idle";
      const wasPriority = globalPriorityActive;
      globalPriorityActive = false;

      // If a service-reminder flow was deferred while priority was playing, run it now.
      if (wasPriority && globalPendingReminder) {
        const pending = globalPendingReminder;
        globalPendingReminder = null;
        playReminderFlow(pending);
      }
    });
    getAudio().playOnChannel(AudioChannel.SFX, getAudioPath("sfx/IRD-tick-close.mp3"));
  }, delayMs);
}

/**
 * Starts the voice message sequence and wires up the completion handler
 * to stop ambient and play the closing tick.
 */
function startVoiceMessages(files: string[]): void {
  radioFlowState = "messages";

  // When all messages finish → tick-close (with optional natural delay)
  getAudio().onVoiceSequenceComplete(() => {
    if (radioFlowState !== "messages") return;

    radioFlowState = "tick-close";
    playTickClose();
  });

  // Start voice sequence with connector pool for multi-message chaining
  getAudio().playVoiceSequence(
    files.map(getAudioPath),
    files.length > 1 ? CONNECTOR_POOL.map(getAudioPath) : undefined,
  );
}

/**
 * Cancels any in-progress radio flow and stops all non-spotter channels.
 */
function cancelRadioFlow(): void {
  radioFlowState = "idle";
  globalPriorityActive = false;
  globalPendingReminder = null;

  if (globalReminderTimer) {
    clearTimeout(globalReminderTimer);
    globalReminderTimer = null;
  }

  getAudio().cancelVoiceSequence();
  getAudio().stopChannel(AudioChannel.SFX);
  getAudio().stopChannel(AudioChannel.Voice);
  getAudio().stopChannel(AudioChannel.Ambient);
}

/**
 * Plays a reminder-only radio flow with NO acknowledgment.
 *
 * Flow: [tick-open] → [ambient + reminder messages (with connectors)] → [ambient stops] → [tick-close]
 *
 * This is a dedicated flow separate from playRadioMessage to guarantee
 * no acknowledgment logic can leak in.
 *
 * @param files - Reminder audio filenames (relative to audio root)
 */
function playReminderFlow(files: string[]): void {
  if (files.length === 0) return;

  // Don't interrupt a priority pit-lane message (approach, departure, exit).
  // Queue to play when the priority flow finishes (see playTickClose idle handler).
  if (globalPriorityActive) {
    globalPendingReminder = files;

    return;
  }

  applyChannelVolumes();

  // Cancel any in-progress radio flow
  cancelRadioFlow();

  radioFlowState = "tick-open";

  // Step 1: Play tick-open on SFX (clean — no ambient)
  getAudio().onChannelComplete(AudioChannel.SFX, () => {
    if (radioFlowState !== "tick-open") return;

    // Step 2: Start ambient loop at a random position
    getAudio().playOnChannel(AudioChannel.Ambient, getAudioPath("sfx/IRD-ambient-pit.mp3"), true);
    getAudio().seekChannelRandom(AudioChannel.Ambient);

    // Optional micro-delay after tick — ambient plays, voice waits
    randomRadioDelay("tick-open", () => {
      // Step 3: Play reminder messages directly (no ack)
      radioFlowState = "messages";

      getAudio().onVoiceSequenceComplete(() => {
        if (radioFlowState !== "messages") return;

        radioFlowState = "tick-close";
        playTickClose();
      });

      // Start voice sequence with connectors for multi-message chaining
      getAudio().playVoiceSequence(
        files.map(getAudioPath),
        files.length > 1 ? CONNECTOR_POOL.map(getAudioPath) : undefined,
      );
    });
  });

  getAudio().playOnChannel(AudioChannel.SFX, getAudioPath("sfx/IRD-tick-open.mp3"));
}

// ─── Settings ──────────────────────────────────────────────────────────────────

/** Zod-safe boolean that handles string "true"/"false" from PI checkboxes. */
const zBool = z.union([z.boolean(), z.string()]).transform((val) => val === true || val === "true");

const Settings = CommonSettings.extend({
  spotterEnabled: zBool.default(true),
  pitApproachEnabled: zBool.default(true),
  pitServiceReminderEnabled: zBool.default(true),
  pitDepartureEnabled: zBool.default(true),
  pitExitEnabled: zBool.default(true),
  pitLimiterWarning: zBool.default(true),
  incidentAlert: zBool.default(false),
  toggleAudioEnabled: zBool.default(false),
  overtakeAndTipsEnabled: zBool.default(true),
  flagAlertsEnabled: zBool.default(true),
  // Fuel sub-feature — all off by default while marked Work-In-Progress.
  fuelWarningsEnabled: zBool.default(false),
  fuelStintOpenEnabled: zBool.default(false),
  fuelSaveCoachingEnabled: zBool.default(false),
  fuelMidStintEnabled: zBool.default(false),
  spotterVolume: z.coerce.number().min(5).max(100).default(100),
  volume: z.coerce.number().min(5).max(100).default(45),
  driverName: z.string().default("none"),
});

type PitEngineerSettings = z.infer<typeof Settings>;

// ─── Spotter State ─────────────────────────────────────────────────────────────

/** Visual state of the spotter for icon rendering. */
export type SpotterVisualState = "clear" | "left" | "right" | "both" | "two-left" | "two-right";

/** Audio file names for each directional state. */
const SPOTTER_AUDIO: Record<string, string> = {
  left: "spotter/IRD-spotter-left.mp3",
  right: "spotter/IRD-spotter-right.mp3",
  both: "spotter/IRD-spotter-both.mp3",
  "two-left": "spotter/IRD-spotter-left.mp3",
  "two-right": "spotter/IRD-spotter-right.mp3",
};

/**
 * @internal Exported for testing
 *
 * Maps a CarLeftRight telemetry value to a visual spotter state.
 */
export function resolveSpotterState(carLeftRight: number): SpotterVisualState {
  switch (carLeftRight) {
    case CarLeftRight.CarLeft:
      return "left";
    case CarLeftRight.CarRight:
      return "right";
    case CarLeftRight.CarLeftRight:
      return "both";
    case CarLeftRight.TwoCarsLeft:
      return "two-left";
    case CarLeftRight.TwoCarsRight:
      return "two-right";
    default:
      return "clear";
  }
}

/**
 * @internal Exported for testing
 *
 * Returns the audio file name for a spotter state, or null if no sound should play.
 */
export function resolveSpotterAudioFile(state: SpotterVisualState): string | null {
  return SPOTTER_AUDIO[state] ?? null;
}

/** Stops the current spotter tick loop (if any). Safe to call when idle. */
function stopSpotterTickLoop(): void {
  if (globalSpotterTickTimer !== null) {
    clearTimeout(globalSpotterTickTimer);
    globalSpotterTickTimer = null;
  }
}

/**
 * Starts a self-scheduling spotter tick loop for the given visual state.
 * The interval is looked up from SPOTTER_TICK_INTERVALS. No-op for "clear".
 * Always stops any existing loop before starting.
 */
function startSpotterTickLoop(state: SpotterVisualState): void {
  stopSpotterTickLoop();

  if (state === "clear") return;

  const audioFile = resolveSpotterAudioFile(state);

  if (!audioFile) return;

  const interval = SPOTTER_TICK_INTERVALS[state];

  const fire = (): void => {
    getAudio().playOnChannel(AudioChannel.Spotter, getAudioPath(audioFile));
    globalSpotterTickTimer = setTimeout(fire, interval);
  };

  fire();
}

/**
 * @internal Exported for testing
 *
 * Resolves which pit services are queued from the PitSvFlags bitfield
 * and tire compound state. Only includes services that are actually
 * toggled on (enabled) in iRacing's pit service menu.
 *
 * @param flags - PitSvFlags bitfield from telemetry
 * @param playerCompound - Current tire compound (PlayerTireCompound)
 * @param pitSvCompound - Queued tire compound (PitSvTireCompound)
 */
export function resolveQueuedServices(flags: number, playerCompound = 0, pitSvCompound = 0): string[] {
  const services: string[] = [];
  const hasTires =
    (flags & PitSvFlags.LFTireChange) !== 0 ||
    (flags & PitSvFlags.RFTireChange) !== 0 ||
    (flags & PitSvFlags.LRTireChange) !== 0 ||
    (flags & PitSvFlags.RRTireChange) !== 0;

  // Order: Fast Repair first, then Refueling, then Tires/Compound last.
  if ((flags & PitSvFlags.FastRepair) !== 0) services.push("reminder/IRD-pit-reminder-fast-repair.mp3");

  if ((flags & PitSvFlags.FuelFill) !== 0) services.push("reminder/IRD-pit-reminder-fuel.mp3");

  const hasCompoundChange = hasTires && pitSvCompound !== 0 && pitSvCompound !== playerCompound;

  if (hasCompoundChange) {
    // Compound change implies tire change — skip the generic tire reminder
    services.push("reminder/IRD-pit-reminder-compound.mp3");
  } else if (hasTires) {
    services.push("reminder/IRD-pit-reminder-tires.mp3");
  }

  return services;
}

// ─── Icon Generation ───────────────────────────────────────────────────────────

/** Artwork bounds of the mechanic SVG (source viewBox 0 0 71.457 71.457). */
const MECHANIC_BOUNDS = { x: 0, y: 0, width: 71.457, height: 71.457 };

/**
 * Returns the raw mechanic path SVG content (unscaled, in source coordinate space).
 */
function mechanicPathContent(graphicColor: string): string {
  return `<path fill="${graphicColor}" d="M19.538,23.485c0.02-0.685,0.082-2.768,1.558-3.325c1.46-0.551,2.964,0.948,3.251,1.254c0.377,0.403,0.356,1.036-0.047,1.414c-0.404,0.375-1.036,0.356-1.414-0.047c-0.347-0.367-0.897-0.734-1.106-0.741c0.014,0.028-0.208,0.349-0.243,1.504c-0.11,3.731,2.743,4.773,2.864,4.815c0.31,0.108,0.553,0.364,0.641,0.68l0.046,0.168c0.017,0.06,0.027,0.121,0.033,0.183c0.825,9.836,8.605,13.019,12.244,13.019s11.419-3.182,12.244-13.019c0.005-0.061,0.016-0.121,0.032-0.18l0.046-0.168c0.088-0.322,0.332-0.58,0.649-0.685c0.114-0.04,2.967-1.082,2.857-4.813c-0.038-1.272-0.303-1.533-0.306-1.536c-0.124,0.023-0.689,0.399-1.044,0.774c-0.379,0.4-1.011,0.419-1.413,0.042c-0.401-0.378-0.423-1.008-0.046-1.411c0.287-0.306,1.79-1.805,3.251-1.254c1.476,0.558,1.538,2.641,1.558,3.325c0.109,3.698-2.075,5.741-3.632,6.521c-1.051,9.93-8.88,14.403-14.195,14.403S24.221,39.936,23.17,30.005C21.613,29.226,19.429,27.184,19.538,23.485z M22.099,16.792C22.099,3.017,33.101,0,37.34,0c4.253,0,15.291,3.017,15.291,16.792c0,0.438-0.286,0.826-0.705,0.956l-1.558,0.481l-1.389,1.538c-0.19,0.211-0.46,0.33-0.742,0.33c-0.032,0-0.063-0.001-0.095-0.004c-0.309-0.03-0.585-0.2-0.75-0.461c-0.061-0.087-2.069-2.829-10.027-2.835c-8.044,0.006-10.008,2.809-10.027,2.837c-0.171,0.256-0.458,0.429-0.765,0.452c-0.306,0.028-0.614-0.088-0.821-0.317l-1.389-1.538l-1.558-0.481C22.384,17.619,22.099,17.231,22.099,16.792z M24.111,16.059l1.104,0.341c0.172,0.053,0.326,0.152,0.447,0.285l0.845,0.936c1.322-1.13,4.38-2.819,10.858-2.824c6.478,0.004,9.537,1.694,10.859,2.824l0.844-0.935c0.121-0.134,0.275-0.232,0.447-0.286l1.104-0.341C50.18,2.388,37.471,2,37.34,2C37.21,2,24.548,2.388,24.111,16.059z M26.405,13.627c-0.187-0.52,0.083-1.093,0.602-1.28c1.413-0.509,2.86-0.886,4.321-1.179c-0.227-0.8-0.455-1.6-0.665-2.403c-0.068-0.258-0.029-0.533,0.107-0.762c0.136-0.23,0.358-0.396,0.617-0.46c3.966-0.995,7.988-0.995,11.954,0c0.259,0.065,0.481,0.23,0.617,0.46c0.136,0.229,0.175,0.504,0.107,0.762c-0.21,0.802-0.438,1.602-0.665,2.403c1.461,0.293,2.908,0.67,4.321,1.179c0.52,0.187,0.789,0.76,0.602,1.28c-0.147,0.408-0.531,0.661-0.941,0.662c-0.112,0-0.227-0.02-0.339-0.06c-6.242-2.248-13.117-2.248-19.359,0C27.165,14.415,26.593,14.146,26.405,13.627z M33.31,10.841c2.692-0.359,5.417-0.359,8.109,0c0.151-0.528,0.303-1.055,0.446-1.584c-2.992-0.613-6.011-0.613-9.002,0C33.007,9.786,33.159,10.313,33.31,10.841z M70.32,32.224v5.108c0,0.536-0.286,1.031-0.75,1.299l-3.674,2.121v12.558c0,0.028-0.007,0.053-0.008,0.08c1.211,0.175,2.134,0.577,2.783,1.228c1.194,1.201,1.185,2.886,1.177,4.373l-0.001,6.939c0,3.005-2.445,5.45-5.45,5.45c-3.005,0-5.45-2.445-5.45-5.45l-0.001-6.939c-0.008-1.487-0.017-3.172,1.177-4.373c0.648-0.652,1.572-1.053,2.783-1.228c-0.001-0.027-0.008-0.053-0.008-0.08v-1.539c-1.027-3.481-3.123-6.704-5.941-9.243l-2.758,7.851v21.078H37.365H20.534V50.379l-2.859-8.137c-3.937,3.24-6.539,7.58-7.099,12.155c0.093,0.076,0.205,0.137,0.289,0.221c1.194,1.201,1.185,2.886,1.177,4.373l-0.001,6.94c0,3.005-2.445,5.45-5.45,5.45c-3.005,0-5.45-2.445-5.45-5.45l-0.001-6.939c-0.008-1.487-0.017-3.172,1.177-4.373c0.462-0.465,1.066-0.8,1.81-1.021v-5.294c0-0.552,0.448-1,1-1H5.84v-9.639c0-0.414,0.336-0.75,0.75-0.75s0.75,0.336,0.75,0.75v9.639h0.714c0.552,0,1,0.448,1,1v3.43c1.168-4.387,3.992-8.435,7.921-11.485l-0.296-0.842c-0.183-0.521,0.091-1.092,0.612-1.275c0.522-0.184,1.092,0.091,1.275,0.612l0.101,0.289c1.356-0.885,2.817-1.659,4.369-2.296c0.255-0.105,0.543-0.1,0.794,0.015c0.251,0.114,0.444,0.328,0.533,0.589c1.758,5.181,6.816,8.529,12.886,8.529c6.071,0,11.129-3.348,12.887-8.529c0.088-0.261,0.281-0.475,0.533-0.589c0.251-0.115,0.539-0.12,0.794-0.015c1.612,0.662,3.126,1.51,4.531,2.494l0.171-0.486c0.183-0.521,0.753-0.795,1.275-0.612c0.521,0.183,0.795,0.754,0.612,1.275l-0.385,1.096c2.118,1.782,3.894,3.914,5.229,6.253v-6.004l-3.674-2.121c-0.464-0.268-0.75-0.763-0.75-1.299v-5.108c0-0.829,0.671-1.5,1.5-1.5s1.5,0.671,1.5,1.5v4.242l2.924,1.688l2.924-1.688v-4.242c0-0.829,0.671-1.5,1.5-1.5S70.32,31.395,70.32,32.224z M6.126,52.618h0.928v-3.314H6.126V52.618z M9.735,67.334H7.698c-0.552,0-1-0.448-1-1s0.448-1,1-1h2.341l0-1.688H7.698c-0.552,0-1-0.448-1-1s0.448-1,1-1h2.342l0-1.822H7.698c-0.552,0-1-0.448-1-1s0.448-1,1-1h2.325c-0.041-0.741-0.171-1.387-0.577-1.795c-0.491-0.494-1.452-0.745-2.856-0.745s-2.365,0.25-2.856,0.745c-0.608,0.611-0.602,1.748-0.595,2.952l0.001,6.95c0,1.902,1.548,3.45,3.45,3.45C7.992,69.381,9.196,68.538,9.735,67.334z M23.625,52.599c0-0.352-0.286-0.638-0.638-0.638c-0.352,0-0.638,0.286-0.638,0.638c0,0.352,0.286,0.638,0.638,0.638C23.339,53.237,23.625,52.951,23.625,52.599z M46.393,62.333c0-0.552-0.448-1-1-1H29.337c-0.552,0-1,0.448-1,1s0.448,1,1,1h16.056C45.945,63.333,46.393,62.885,46.393,62.333z M37.365,53.237c0.352,0,0.638-0.286,0.638-0.638c0-0.352-0.286-0.638-0.638-0.638c-0.352,0-0.638,0.286-0.638,0.638C36.727,52.951,37.013,53.237,37.365,53.237z M52.381,52.599c0-0.352-0.286-0.638-0.638-0.638c-0.352,0-0.638,0.286-0.638,0.638c0,0.352,0.286,0.638,0.638,0.638C52.095,53.237,52.381,52.951,52.381,52.599z M55.304,41.191c-1.139-0.841-2.363-1.584-3.664-2.193c-2.32,5.424-7.85,8.871-14.392,8.871c-6.542,0-12.073-3.448-14.393-8.874c-1.242,0.571-2.412,1.241-3.505,1.986l3.223,9.175h14.79h14.79L55.304,41.191z M67.252,56.029c-0.491-0.494-1.453-0.745-2.856-0.745c-1.404,0-2.365,0.25-2.856,0.745c-0.406,0.409-0.536,1.054-0.577,1.795h2.325c0.552,0,1,0.448,1,1s-0.448,1-1,1h-2.343l0,1.822h2.343c0.552,0,1,0.448,1,1s-0.448,1-1,1h-2.342l0,1.688h2.342c0.552,0,1,0.448,1,1s-0.448,1-1,1H61.25c0.539,1.204,1.743,2.047,3.145,2.047c1.902,0,3.45-1.548,3.45-3.45l0.001-6.95C67.853,57.777,67.86,56.641,67.252,56.029z M37.979,24.528v4.953h-2.228c-0.552,0-1,0.448-1,1s0.448,1,1,1h3.228c0.552,0,1-0.448,1-1v-5.953c0-0.552-0.448-1-1-1S37.979,23.976,37.979,24.528z"/>`;
}

/**
 * @internal Exported for testing
 *
 * Generates a complete SVG data URI for the pit engineer icon.
 */
export function generatePitEngineerSvg(
  settings: PitEngineerSettings,
  spotterState: SpotterVisualState,
  enabled: boolean,
): string {
  const colors = resolveIconColors(pitEngineerTemplate, getGlobalColors(), settings.colorOverrides) as Record<
    string,
    string
  >;

  const graphicColor = colors.graphic1Color ?? WHITE;

  // Resolve graphic scale from PI overrides → global defaults → 100%
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);
  const title = resolveTitleSettings(
    pitEngineerTemplate,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    "PIT\nENGINEER",
  );

  // Status bar occupies y=100..144, so constrain graphic area to the upper region
  const STATUS_BAR_TOP = 100;
  const PADDING = 8;
  const fullGraphicArea = computeGraphicArea(title);
  const graphicArea = {
    ...fullGraphicArea,
    height: Math.min(fullGraphicArea.height, STATUS_BAR_TOP - PADDING - fullGraphicArea.y),
  };

  // Apply graphic transform with user scale
  const rawPath = mechanicPathContent(graphicColor);
  const scaledGraphic = title.showGraphics
    ? applyGraphicTransform(rawPath, MECHANIC_BOUNDS, graphicArea, graphic.scale)
    : "";

  // Generate title text
  const titleText = title.showTitle
    ? generateTitleText({
        text: title.titleText ?? "PIT\nENGINEER",
        fontSize: title.fontSize,
        bold: title.bold,
        position: title.position,
        customPosition: title.customPosition,
        fill: colors.textColor ?? WHITE,
      })
    : "";

  const statusBar = enabled ? statusBarOn() : statusBarOff();
  const iconContent = scaledGraphic + titleText + statusBar;

  const border = resolveBorderSettings(
    pitEngineerTemplate,
    getGlobalBorderSettings(),
    settings.borderOverrides,
    borderColorForState(enabled ? "on" : "off"),
  );
  const borderSvg = generateBorderParts(border);

  const svg = renderIconTemplate(pitEngineerTemplate, {
    iconContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    ...colors,
  });

  return svgToDataUri(svg);
}

/**
 * Resolves the absolute path to an audio file in the plugin's assets directory.
 */
function getAudioPath(filename: string): string {
  return path.join(process.cwd(), "assets", "audio", filename);
}

// ─── Global Pit Engineer State ────────────────────────────────────────────────
//
// The pit engineer runs globally — toggling ON keeps the telemetry subscription
// and audio playback alive even when the user navigates to a different page.
// Action instances only manage their icon display.
//
// MULTI-INSTANCE NOTE: When multiple Pit Engineer buttons exist on different
// pages, the last instance to appear or receive a settings update wins — its
// settings become the active `globalSettings`. This is intentional: all
// instances share the same global state and the user is expected to configure
// them identically. If instances have different feature toggles, the behavior
// depends on which was last seen by the runtime.

/** Global enabled flag — shared across all action instances. */
let globalEnabled = true;

/** Whether the welcome message has been played this iRacing session. */
let globalWelcomePlayed = false;

/** Global telemetry subscription ID (stable across page changes). */
const GLOBAL_SUB_ID = "__pit-engineer-global__";

/** Whether the global subscription is active. */
let globalSubscribed = false;

/** Current global settings (merged from last-seen action instance). */
let globalSettings: PitEngineerSettings | null = null;

// ─── Spotter sub-feature state ───────────────────────────────────────────────

/** Current spotter visual state (for icon rendering on reappear). */
let globalSpotterState: SpotterVisualState = "clear";

/** Self-scheduling timer that drives the proximity-modulated spotter tick loop. */
let globalSpotterTickTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Tick intervals per spotter state. Single-car states tick at 250 ms (same as
 * the legacy 4 Hz replay). Two-cars-same-side is faster (180 ms) because being
 * sandwiched on one side is more dangerous. Cars-both-sides is slower than
 * two-same-side (230 ms) — you're locked between cars, holding a straight line.
 */
const SPOTTER_TICK_INTERVALS: Readonly<Record<Exclude<SpotterVisualState, "clear">, number>> = {
  left: 250,
  right: 250,
  "two-left": 180,
  "two-right": 180,
  both: 230,
};

// ─── Pit approach/exit sub-feature state ─────────────────────────────────────

/** Previous OnPitRoad value for transition detection. */
let globalLastOnPitRoad = false;

/** Whether pit approach alert has fired (reset when back on track). */
let globalApproachAlertFired = false;

/** Suppresses approach alert when car is exiting pits through the approach zone. */
let globalApproachExitingSuppressed = false;

/** Previous PlayerCarInPitStall value for stall departure detection. */
let globalLastInPitStall = false;

// ─── Overtake sub-feature state ─────────────────────────────────────────────

/** Previous calculated race position for overtake detection. */
let globalLastPosition = -1;

/** Whether overtake position tracking has been initialized. */
let globalOvertakeInitialized = false;

/** Timestamp of last overtake alert (cooldown to prevent spam). */
let globalLastOvertakeTime = 0;

// ─── Tip sub-feature state ──────────────────────────────────────────────────

/** Last lap number when a tip was played. */
let globalLastTipLap = -1;

/** Random LapDistPct (0.0–1.0) at which the next tip should fire. */
let globalTipTriggerPct = -1;

/** Whether the tip has already fired this lap (prevents re-firing on same lap). */
let globalTipFiredThisLap = false;

/** Pending overtake: position must hold for OVERTAKE_HOLD_MS before triggering. */
let globalPendingOvertakePos = -1;

/** Timestamp when the pending overtake was first detected. */
let globalPendingOvertakeTime = 0;

/** Minimum ms between overtake alerts. */
const OVERTAKE_COOLDOWN_MS = 8000;

/** How long (ms) the improved position must hold before confirming the overtake. */
const OVERTAKE_HOLD_MS = 3000;

/** Maximum position jump to count as a real overtake (filter pit cycles). */
const OVERTAKE_MAX_JUMP = 3;

/** Number of confirmed overtakes before playing the audio. */
const OVERTAKE_PLAY_EVERY = 5;

/** Counter of confirmed overtakes since last audio play. */
let globalOvertakeCount = 0;

// ─── Toggle audio sub-feature state ─────────────────────────────────────────

/** Whether toggle state has been initialized (skip audio on first tick). */
let globalToggleStateInitialized = false;

/** Previous PitSvFlags value for toggle transition detection. */
let globalLastPitSvFlags = 0;

/** Previous pit speed limiter state. */
let globalLastPitLimiterActive = false;

/** Pit limiter warning sub-feature state. */
let globalLastOnPitRoadForLimiter = false;
let globalLastLimiterOnPitRoad = false;
let globalSpeedingWarnedAt = 0;
let globalTrackPitSpeedLimitMps = 0; // 0 = unknown / not yet parsed
let globalPitSpeedLimitSessionKey = ""; // re-parse when session changes

/** Incident alert tuning. */
const MATERIAL_WINDOW_MS = 2000;
const SUSTAINED_OFF_TRACK_MS = 2000;
const INCIDENT_COOLDOWN_MS = 4000;

/** Incident alert state. */
let globalLastIncidentCount = -1; // -1 = not yet seeded
let globalIncidentAlertedAt = 0;

/** Sustained off-track excursion tracking. */
let globalOffTrackStartedAt = 0; // 0 = currently on track
let globalOffTrackWarnedThisExcursion = false;

/**
 * True while a previously-fired incident alert is still playing its radio
 * flow. Used to defer the cooldown clock so the 4s gap between sustained
 * warnings counts from the END of the previous clip, not the start.
 */
let globalIncidentFlowActive = false;

/** Ring buffer of recent off-track material samples (for incident classification). */
interface MaterialSample {
  t: number;
  material: number;
}
let globalMaterialHistory: MaterialSample[] = [];

/** Previous Push-to-Pass state. */
let globalLastP2PActive = false;

/** Previous DRS state. */
let globalLastDrsActive = false;

/** Previous PitSvTireCompound value for compound change detection. */
let globalLastPitSvCompound = 0;

// ─── Flag alert sub-feature state ──────────────────────────────────────────

/**
 * Audio file mapping for each flag type.
 * Uses Warning Flow (simple, no ack) — urgent informational callouts.
 */
const FLAG_AUDIO: Record<string, string> = {
  green: "flags/IRD-flag-green-flag.mp3",
  yellow: "flags/IRD-flag-yellow-flag.mp3",
  blue: "flags/IRD-flag-blue-flag.mp3",
  black: "flags/IRD-flag-black-flag.mp3",
  red: "flags/IRD-flag-red-flag.mp3",
  white: "flags/IRD-flag-white-flag.mp3",
  checkered: "flags/IRD-flag-checkered-flag.mp3",
  meatball: "flags/IRD-flag-meatball-flag.mp3",
  debris: "flags/IRD-flag-debris.mp3",
};

/**
 * Set of flag keys currently active — used to detect transitions.
 * A flag alert fires once when the flag appears (off→on), not every tick.
 */
let globalActiveFlags = new Set<string>();

/** Whether flag tracking has been initialized (skip audio on first tick). */
let globalFlagStateInitialized = false;

// ─── Fuel warning sub-feature state ──────────────────────────────────────────
//
// Stint = the span of laps since the last refuel. All "fire once" flags are
// reset when a refuel is detected (FuelLevel jumps up) so the next stint
// starts fresh.

/** Last lap number observed (for lap-boundary detection). */
let globalFuelLastLap = -1;

/** Fuel level at the start of the current lap, used to compute per-lap usage. */
let globalFuelAtLapStart: number | null = null;

/** Whether any part of the current lap was spent on pit road (in/out lap). */
let globalFuelLapTouchedPit = false;

/** Rolling history of valid per-lap consumption (most recent 5). */
let globalFuelHistory: number[] = [];

/** Previous FuelLevel reading for refuel-jump detection (every tick). */
let globalFuelLastLevel: number | null = null;

/** Whether fuel tracking has been seeded from the first valid tick. */
let globalFuelInitialized = false;

/** Fire-once flags per stint. Reset on refuel. */
let globalFuelStintOpenFired = false;
let globalFuelPitWindowFired = false;
let globalFuelMakeEndFired = false;
let globalFuelLow5Fired = false;
let globalFuelLow3Fired = false;
let globalFuelCriticalFired = false;
let globalFuelEmptyFired = false;

/** Last lap the save-fuel callout fired (for re-arm interval). */
let globalFuelLastSaveLap = -1;

/** Last lap the mid-stint on-plan / high-consumption checkpoint fired. */
let globalFuelLastMidStintLap = -1;

/** Consecutive laps with consumption >= highConsumptionRatio × rolling avg. */
let globalFuelHighConsumptionStreak = 0;

/** Last time (Date.now()) any fuel callout fired — drives voice cooldown for non-priority callouts. */
let globalFuelLastCalloutTime = 0;

/** True if any non-green flag appeared during the current lap — invalidates lap for rolling avg. */
let globalFuelLapSawNonGreen = false;

/** Last time (Date.now()) a refuel jump was accepted — debounces noisy telemetry. */
let globalFuelLastRefuelTime = 0;

/** Captured lapsRemaining estimate the moment "make the end" fired. Used to hysteresis-gate save-fuel. */
let _globalFuelMakeEndEstimate: number | null = null;

/**
 * @internal Exported for testing
 *
 * Pit service toggle audio file mapping.
 */
export const PIT_SERVICE_TOGGLE_AUDIO: Record<string, { on: string; off: string }> = {
  fuel: { on: "toggle/IRD-toggle-fuel-on.mp3", off: "toggle/IRD-toggle-fuel-off.mp3" },
  windshield: { on: "toggle/IRD-toggle-windshield-on.mp3", off: "toggle/IRD-toggle-windshield-off.mp3" },
  fastRepair: { on: "toggle/IRD-toggle-fast-repair-on.mp3", off: "toggle/IRD-toggle-fast-repair-off.mp3" },
};

/**
 * @internal Exported for testing
 *
 * Tire toggle audio file mapping — pattern-aware.
 */
export const TIRE_TOGGLE_AUDIO: Record<string, { on: string; off: string }> = {
  all: { on: "toggle/IRD-toggle-tires-all-on.mp3", off: "toggle/IRD-toggle-tires-all-off.mp3" },
  front: { on: "toggle/IRD-toggle-tires-front-on.mp3", off: "toggle/IRD-toggle-tires-front-off.mp3" },
  rear: { on: "toggle/IRD-toggle-tires-rear-on.mp3", off: "toggle/IRD-toggle-tires-rear-off.mp3" },
  left: { on: "toggle/IRD-toggle-tires-left-on.mp3", off: "toggle/IRD-toggle-tires-left-off.mp3" },
  right: { on: "toggle/IRD-toggle-tires-right-on.mp3", off: "toggle/IRD-toggle-tires-right-off.mp3" },
  crossLfRr: { on: "toggle/IRD-toggle-tires-lf-rr-on.mp3", off: "toggle/IRD-toggle-tires-lf-rr-off.mp3" },
  crossRfLr: { on: "toggle/IRD-toggle-tires-rf-lr-on.mp3", off: "toggle/IRD-toggle-tires-rf-lr-off.mp3" },
  stayDry: { on: "toggle/IRD-toggle-compound-stay-dry.mp3", off: "toggle/IRD-toggle-compound-stay-dry.mp3" },
  stayWet: { on: "toggle/IRD-toggle-compound-stay-wet.mp3", off: "toggle/IRD-toggle-compound-stay-wet.mp3" },
  changeToDry: { on: "toggle/IRD-toggle-compound-change-dry.mp3", off: "toggle/IRD-toggle-compound-change-dry.mp3" },
  changeToWet: { on: "toggle/IRD-toggle-compound-change-wet.mp3", off: "toggle/IRD-toggle-compound-change-wet.mp3" },
  lf: { on: "toggle/IRD-toggle-tires-lf-on.mp3", off: "toggle/IRD-toggle-tires-lf-off.mp3" },
  rf: { on: "toggle/IRD-toggle-tires-rf-on.mp3", off: "toggle/IRD-toggle-tires-rf-off.mp3" },
  lr: { on: "toggle/IRD-toggle-tires-lr-on.mp3", off: "toggle/IRD-toggle-tires-lr-off.mp3" },
  rr: { on: "toggle/IRD-toggle-tires-rr-on.mp3", off: "toggle/IRD-toggle-tires-rr-off.mp3" },
};

/**
 * @internal Exported for testing
 *
 * Short tire name clips (no "change" prefix) for 3-tire combo announcements.
 */
export const TIRE_SHORT: Record<string, string> = {
  lf: "toggle/IRD-toggle-tires-lf-short.mp3",
  rf: "toggle/IRD-toggle-tires-rf-short.mp3",
  lr: "toggle/IRD-toggle-tires-lr-short.mp3",
  rr: "toggle/IRD-toggle-tires-rr-short.mp3",
};

/**
 * @internal Exported for testing
 *
 * Car control toggle audio file mapping.
 */
export const CAR_CONTROL_TOGGLE_AUDIO: Record<string, { on: string; off: string }> = {
  pushToPass: { on: "toggle/IRD-toggle-p2p-on.mp3", off: "toggle/IRD-toggle-p2p-off.mp3" },
  drs: { on: "toggle/IRD-toggle-drs-on.mp3", off: "toggle/IRD-toggle-drs-off.mp3" },
};

/** Pit limiter warning files — cycled each time limiter activates on track. */
const PIT_LIMITER_WARNINGS = [
  "toggle/IRD-toggle-limiter-on-warning-1.mp3",
  "toggle/IRD-toggle-limiter-on-warning-2.mp3",
  "toggle/IRD-toggle-limiter-on-warning-3.mp3",
];

/** Current index into the pit limiter warning rotation. */
let pitLimiterWarningIndex = 0;

/** Entered pit lane without limiter engaged. */
const PIT_NO_LIMITER_WARNINGS = [
  "pitlane/IRD-pit-no-limiter-01.mp3",
  "pitlane/IRD-pit-no-limiter-02.mp3",
  "pitlane/IRD-pit-no-limiter-03.mp3",
];

/** Limiter disengaged while still between pit cones. */
const PIT_LIMITER_DROPPED_WARNINGS = [
  "pitlane/IRD-pit-limiter-dropped-01.mp3",
  "pitlane/IRD-pit-limiter-dropped-02.mp3",
  "pitlane/IRD-pit-limiter-dropped-03.mp3",
];

/** Over the pit speed limit. */
const PIT_SPEEDING_WARNINGS = [
  "pitlane/IRD-pit-speeding-01.mp3",
  "pitlane/IRD-pit-speeding-02.mp3",
  "pitlane/IRD-pit-speeding-03.mp3",
];

let pitNoLimiterIndex = 0;
let pitLimiterDroppedIndex = 0;
let pitSpeedingIndex = 0;

/** Incident-driven off-track warnings — one pool per surface material family. */
const OFF_TRACK_GRASS_WARNINGS = [
  "incidents/IRD-incident-grass-01.mp3",
  "incidents/IRD-incident-grass-02.mp3",
  "incidents/IRD-incident-grass-03.mp3",
  "incidents/IRD-incident-grass-04.mp3",
];

const OFF_TRACK_GRAVEL_WARNINGS = [
  "incidents/IRD-incident-gravel-01.mp3",
  "incidents/IRD-incident-gravel-02.mp3",
  "incidents/IRD-incident-gravel-03.mp3",
  "incidents/IRD-incident-gravel-04.mp3",
];

const OFF_TRACK_GENERIC_WARNINGS = [
  "incidents/IRD-incident-generic-01.mp3",
  "incidents/IRD-incident-generic-02.mp3",
  "incidents/IRD-incident-generic-03.mp3",
  "incidents/IRD-incident-generic-04.mp3",
  "incidents/IRD-incident-generic-05.mp3",
  "incidents/IRD-incident-generic-06.mp3",
];

let offTrackGrassIndex = 0;
let offTrackGravelIndex = 0;
let offTrackGenericIndex = 0;

/**
 * Track-limits warnings — fire on brief off-track incidents (counter +1 without
 * a sustained excursion). Add recorded clips here once available.
 */
const OFF_TRACK_LIMITS_WARNINGS: readonly string[] = [
  "incidents/IRD-incident-limits-01.mp3",
  "incidents/IRD-incident-limits-02.mp3",
  "incidents/IRD-incident-limits-03.mp3",
  "incidents/IRD-incident-limits-04.mp3",
  "incidents/IRD-incident-limits-05.mp3",
  "incidents/IRD-incident-limits-06.mp3",
];
let offTrackLimitsIndex = 0;

/**
 * Picks the next track-limits audio file, or null if the pool is empty.
 *
 * @internal Exported for testing
 */
export function pickTrackLimitsFile(): string | null {
  if (OFF_TRACK_LIMITS_WARNINGS.length === 0) return null;

  const f = OFF_TRACK_LIMITS_WARNINGS[offTrackLimitsIndex]!;
  offTrackLimitsIndex = (offTrackLimitsIndex + 1) % OFF_TRACK_LIMITS_WARNINGS.length;

  return f;
}

/** Probability of playing a generic clip when we have a surface-specific pool available. */
const GENERIC_INCIDENT_MIX = 0.4;

/**
 * Picks an incident audio file, allowing generic clips to mix in with
 * grass/gravel pools (but surface-specific clips stay exclusive to their
 * matching surface).
 *
 * - grass event → 60% grass clip, 40% generic clip
 * - gravel event → 60% gravel clip, 40% generic clip
 * - generic event → 100% generic clip
 *
 * Each pool keeps its own sequential index so individual clips don't repeat
 * back-to-back within the same pool.
 *
 * @internal Exported for testing
 */
export function pickIncidentFile(category: "grass" | "gravel" | "generic"): string {
  const useGeneric = category === "generic" || Math.random() < GENERIC_INCIDENT_MIX;

  if (useGeneric) {
    const f = OFF_TRACK_GENERIC_WARNINGS[offTrackGenericIndex]!;
    offTrackGenericIndex = (offTrackGenericIndex + 1) % OFF_TRACK_GENERIC_WARNINGS.length;

    return f;
  }

  if (category === "grass") {
    const f = OFF_TRACK_GRASS_WARNINGS[offTrackGrassIndex]!;
    offTrackGrassIndex = (offTrackGrassIndex + 1) % OFF_TRACK_GRASS_WARNINGS.length;

    return f;
  }

  // gravel
  const f = OFF_TRACK_GRAVEL_WARNINGS[offTrackGravelIndex]!;
  offTrackGravelIndex = (offTrackGravelIndex + 1) % OFF_TRACK_GRAVEL_WARNINGS.length;

  return f;
}

/**
 * Classifies a `TrkSurf` material value into an off-track pool.
 * Returns null for on-track surfaces (asphalt, concrete, paint, rumbles).
 *
 * @internal Exported for testing
 */
export function classifyOffTrackMaterial(material: number): "grass" | "gravel" | "generic" | null {
  // Grass 1-4
  if (material >= TrkSurf.Grass1 && material <= TrkSurf.Grass4) return "grass";

  // Gravel traps: Sand, Gravel1, Gravel2, Grasscrete
  if (material >= TrkSurf.Sand && material <= TrkSurf.Grasscrete) return "gravel";

  // Dirt / racing dirt / astroturf / anything else off-track → generic
  if (
    material === TrkSurf.RacingDirt1 ||
    material === TrkSurf.RacingDirt2 ||
    (material >= TrkSurf.Dirt1 && material <= TrkSurf.Dirt4) ||
    material === TrkSurf.Astroturf ||
    material === TrkSurf.Undefined
  ) {
    return "generic";
  }

  // Asphalt / concrete / paint / rumbles — not off-track
  return null;
}

/**
 * Picks the most severe off-track category seen in recent material samples.
 *
 * Severity order: gravel (stop-you) > grass (recoverable) > generic (dirt/other).
 * Returns null when no off-track samples are present — caller treats that as
 * a track-limits / on-track incident.
 *
 * @internal Exported for testing
 */
export function pickPeakOffTrackCategory(samples: { material: number }[]): "grass" | "gravel" | "generic" | null {
  let sawGrass = false;
  let sawGravel = false;
  let sawGeneric = false;

  for (const s of samples) {
    const c = classifyOffTrackMaterial(s.material);

    if (c === "gravel") sawGravel = true;
    else if (c === "grass") sawGrass = true;
    else if (c === "generic") sawGeneric = true;
  }

  if (sawGravel) return "gravel";

  if (sawGrass) return "grass";

  if (sawGeneric) return "generic";

  return null;
}

/**
 * @internal Exported for testing
 *
 * Detects PitSvFlags bit transitions and compound changes, returns audio files to play.
 *
 * @param prevFlags - Previous PitSvFlags value
 * @param currFlags - Current PitSvFlags value
 * @param playerCompound - Current tire compound on the car (0 = dry)
 * @param prevPitSvCompound - Previous queued pit compound
 * @param currPitSvCompound - Current queued pit compound
 */
export function resolvePitServiceToggleAudio(
  prevFlags: number,
  currFlags: number,
  playerCompound = 0,
  prevPitSvCompound = 0,
  currPitSvCompound = 0,
): string[] {
  const files: string[] = [];

  // Fuel fill
  const wasFuel = (prevFlags & PitSvFlags.FuelFill) !== 0;
  const isFuel = (currFlags & PitSvFlags.FuelFill) !== 0;

  if (wasFuel !== isFuel) {
    files.push(isFuel ? PIT_SERVICE_TOGGLE_AUDIO.fuel.on : PIT_SERVICE_TOGGLE_AUDIO.fuel.off);
  }

  // Tires — result-pattern-aware: check what changed, then announce the resulting state.
  // Example: RF already on, user toggles LF on → result is front pair → "front tires on"
  const anyTireChanged =
    ((prevFlags ^ currFlags) &
      (PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange)) !==
    0;

  // Tire compound change (0 = dry, >0 = wet)
  // Checked BEFORE tire flags so we can suppress redundant "all tires" when compound changes
  const compoundChanged = prevPitSvCompound !== currPitSvCompound;

  if (compoundChanged) {
    const isDry = currPitSvCompound === 0 || currPitSvCompound === playerCompound;
    const isStaying = currPitSvCompound === playerCompound;

    if (isStaying && playerCompound === 0) {
      files.push(TIRE_TOGGLE_AUDIO.stayDry.on);
    } else if (isStaying) {
      files.push(TIRE_TOGGLE_AUDIO.stayWet.on);
    } else if (isDry) {
      files.push(TIRE_TOGGLE_AUDIO.changeToDry.on);
    } else {
      files.push(TIRE_TOGGLE_AUDIO.changeToWet.on);
    }
  }

  if (anyTireChanged) {
    // Current state of each tire after the change
    const lf = (currFlags & PitSvFlags.LFTireChange) !== 0;
    const rf = (currFlags & PitSvFlags.RFTireChange) !== 0;
    const lr = (currFlags & PitSvFlags.LRTireChange) !== 0;
    const rr = (currFlags & PitSvFlags.RRTireChange) !== 0;
    const tireCount = (lf ? 1 : 0) + (rf ? 1 : 0) + (lr ? 1 : 0) + (rr ? 1 : 0);

    // Skip "all tires on" when compound just changed — compound announcement is sufficient
    if (lf && rf && lr && rr && compoundChanged) {
      // Compound change already announced — don't also say "change all tires"
    } else if (lf && rf && lr && rr) {
      files.push(TIRE_TOGGLE_AUDIO.all.on);
    } else if (!lf && !rf && !lr && !rr) {
      files.push(TIRE_TOGGLE_AUDIO.all.off);
    } else if (lf && rf && !lr && !rr) {
      files.push(TIRE_TOGGLE_AUDIO.front.on);
    } else if (!lf && !rf && lr && rr) {
      files.push(TIRE_TOGGLE_AUDIO.rear.on);
    } else if (lf && !rf && lr && !rr) {
      files.push(TIRE_TOGGLE_AUDIO.left.on);
    } else if (!lf && rf && !lr && rr) {
      files.push(TIRE_TOGGLE_AUDIO.right.on);
    } else if (lf && !rf && !lr && rr) {
      files.push(TIRE_TOGGLE_AUDIO.crossLfRr.on);
    } else if (!lf && rf && lr && !rr) {
      files.push(TIRE_TOGGLE_AUDIO.crossRfLr.on);
    } else if (tireCount === 3) {
      // 3 tires on: announce the established pair + the odd tire (short name only).
      // "Established pair" = the pair that was already complete in prevFlags. This lets the
      // user's selection order drive the announcement:
      //   RR → LR  = rear pair → then +RF  → "rear tires" + "right front"
      //   RF → RR  = right pair → then +LR → "right side tires" + "left rear"
      // When prev wasn't a complete pair (jump from 0/1, or diagonal), fall back to
      // side-pair preference so we still get a natural "side + odd" announcement.
      const prevLf = (prevFlags & PitSvFlags.LFTireChange) !== 0;
      const prevRf = (prevFlags & PitSvFlags.RFTireChange) !== 0;
      const prevLr = (prevFlags & PitSvFlags.LRTireChange) !== 0;
      const prevRr = (prevFlags & PitSvFlags.RRTireChange) !== 0;
      const prevCount = (prevLf ? 1 : 0) + (prevRf ? 1 : 0) + (prevLr ? 1 : 0) + (prevRr ? 1 : 0);
      const prevWasFront = prevCount === 2 && prevLf && prevRf;
      const prevWasRear = prevCount === 2 && prevLr && prevRr;
      const prevWasLeft = prevCount === 2 && prevLf && prevLr;
      const prevWasRight = prevCount === 2 && prevRf && prevRr;

      if (prevWasFront) {
        files.push(TIRE_TOGGLE_AUDIO.front.on);
        files.push(lr ? TIRE_SHORT.lr : TIRE_SHORT.rr);
      } else if (prevWasRear) {
        files.push(TIRE_TOGGLE_AUDIO.rear.on);
        files.push(lf ? TIRE_SHORT.lf : TIRE_SHORT.rf);
      } else if (prevWasLeft) {
        files.push(TIRE_TOGGLE_AUDIO.left.on);
        files.push(rf ? TIRE_SHORT.rf : TIRE_SHORT.rr);
      } else if (prevWasRight) {
        files.push(TIRE_TOGGLE_AUDIO.right.on);
        files.push(lf ? TIRE_SHORT.lf : TIRE_SHORT.lr);
      } else if (rf && rr) {
        files.push(TIRE_TOGGLE_AUDIO.right.on);
        files.push(lf ? TIRE_SHORT.lf : TIRE_SHORT.lr);
      } else if (lf && lr) {
        files.push(TIRE_TOGGLE_AUDIO.left.on);
        files.push(rf ? TIRE_SHORT.rf : TIRE_SHORT.rr);
      } else if (lf && rf) {
        files.push(TIRE_TOGGLE_AUDIO.front.on);
        files.push(lr ? TIRE_SHORT.lr : TIRE_SHORT.rr);
      } else if (lr && rr) {
        files.push(TIRE_TOGGLE_AUDIO.rear.on);
        files.push(lf ? TIRE_SHORT.lf : TIRE_SHORT.rf);
      }
    } else if (tireCount === 1) {
      // 1 tire on — announce the single tire that's on
      if (lf) files.push(TIRE_TOGGLE_AUDIO.lf.on);

      if (rf) files.push(TIRE_TOGGLE_AUDIO.rf.on);

      if (lr) files.push(TIRE_TOGGLE_AUDIO.lr.on);

      if (rr) files.push(TIRE_TOGGLE_AUDIO.rr.on);
    }
  }

  // Windshield tearoff
  const wasWindshield = (prevFlags & PitSvFlags.WindshieldTearoff) !== 0;
  const isWindshield = (currFlags & PitSvFlags.WindshieldTearoff) !== 0;

  if (wasWindshield !== isWindshield) {
    files.push(isWindshield ? PIT_SERVICE_TOGGLE_AUDIO.windshield.on : PIT_SERVICE_TOGGLE_AUDIO.windshield.off);
  }

  // Fast repair
  const wasFastRepair = (prevFlags & PitSvFlags.FastRepair) !== 0;
  const isFastRepair = (currFlags & PitSvFlags.FastRepair) !== 0;

  if (wasFastRepair !== isFastRepair) {
    files.push(isFastRepair ? PIT_SERVICE_TOGGLE_AUDIO.fastRepair.on : PIT_SERVICE_TOGGLE_AUDIO.fastRepair.off);
  }

  return files;
}

/**
 * @internal Exported for testing
 *
 * Detects car control toggle transitions and returns the audio files to play.
 */
export function resolveCarControlToggleAudio(
  prev: { limiter: boolean; p2p: boolean; drs: boolean },
  curr: { limiter: boolean; p2p: boolean; drs: boolean },
  onPitRoad = false,
): string[] {
  const files: string[] = [];

  // Pit limiter only warns when activated on track — toggling on pit road is normal behavior
  if (prev.limiter !== curr.limiter && !onPitRoad && curr.limiter) {
    files.push(PIT_LIMITER_WARNINGS[pitLimiterWarningIndex]);
    pitLimiterWarningIndex = (pitLimiterWarningIndex + 1) % PIT_LIMITER_WARNINGS.length;
  }

  if (prev.p2p !== curr.p2p) {
    files.push(curr.p2p ? CAR_CONTROL_TOGGLE_AUDIO.pushToPass.on : CAR_CONTROL_TOGGLE_AUDIO.pushToPass.off);
  }

  if (prev.drs !== curr.drs) {
    files.push(curr.drs ? CAR_CONTROL_TOGGLE_AUDIO.drs.on : CAR_CONTROL_TOGGLE_AUDIO.drs.off);
  }

  return files;
}

/**
 * True while a priority pit-lane message (approach, stall departure, exit) is
 * being played — i.e. tick-open, voice, tick-close are still in flight.
 * Cleared when the radio flow returns to idle at the end of tick-close.
 */
let globalPriorityActive = false;

/** Reminder files deferred until an in-flight priority flow completes. */
let globalPendingReminder: string[] | null = null;

/** Pending service reminder timer — cancelled if the action disappears or flow changes. */
let globalReminderTimer: ReturnType<typeof setTimeout> | null = null;

/** Delay (ms) between pit entry and the service reminder flow so the approach message finishes first. */
const SERVICE_REMINDER_DELAY_MS = 1500;

/**
 * Plays a priority pit-lane message (approach, stall departure, exit).
 * Marks the priority flow active so other audio defers until it ends.
 * Skipped if another priority message is still in flight so priority
 * messages can't cut each other off.
 */
function playPriorityMessage(filename: string): void {
  if (globalPriorityActive) return;

  globalPriorityActive = true;
  playRadioMessage([filename], false);
}

/**
 * Plays a one-shot engineer message with simplified radio flow (no ack).
 * tick-open → ambient → message → ambient off → tick-close.
 * Skipped if a priority pit-lane message is still in flight.
 *
 * @returns true if the radio flow was started, false if skipped (priority active).
 */
function playEngineerSoundSimple(filename: string): boolean {
  if (globalPriorityActive) return false;

  playRadioMessage([filename], false);

  return true;
}

/**
 * Plays the welcome flow: tick → greeting → name → welcome message → tick.
 * Ambient plays in the background during all voice parts.
 *
 * Flow: [tick-open] → [ambient + (greeting ~60%) + (driver name) + tip]
 *       → [ambient stops] → [tick-close]
 */
function playWelcomeMessage(): void {
  applyChannelVolumes();
  cancelRadioFlow();

  radioFlowState = "tick-open";

  // Step 1: Play tick-open on SFX (clean — no ambient)
  getAudio().onChannelComplete(AudioChannel.SFX, () => {
    if (radioFlowState !== "tick-open") return;

    // Step 2: Start ambient loop at random position
    getAudio().playOnChannel(AudioChannel.Ambient, getAudioPath("sfx/IRD-ambient-pit.mp3"), true);
    getAudio().seekChannelRandom(AudioChannel.Ambient);

    // Decide greeting up front so we know the delay
    const includeGreeting = Math.random() < 0.6;

    const startWelcomeVoice = (): void => {
      if (radioFlowState !== "tick-open") return;

      radioFlowState = "messages";

      // Chain: (greeting if included) → (driver name if set) → tip
      const nameFile = getDriverNameFile();
      const voiceFiles = [
        ...(includeGreeting ? [pickGreeting()] : []),
        ...(nameFile ? [nameFile] : []),
        pickTip(true), // welcome flow fires at session start — use START_ONLY tip bucket
      ];

      getAudio().onVoiceSequenceComplete(() => {
        if (radioFlowState !== "messages") return;

        radioFlowState = "tick-close";
        playTickClose();
      });

      // Play voice sequence without connectors (greeting → name → welcome flows naturally)
      getAudio().playVoiceSequence(voiceFiles.map(getAudioPath));
    };

    if (includeGreeting) {
      // Normal random micro-delay before greeting
      randomRadioDelay("tick-open", startWelcomeVoice);
    } else {
      // No greeting — hold ambient for 250ms then start voice
      setTimeout(startWelcomeVoice, 250);
    }
  });

  getAudio().playOnChannel(AudioChannel.SFX, getAudioPath("sfx/IRD-tick-open.mp3"));
}

/**
 * Resets all audio state — stops all channels and cancels radio flow.
 */
function resetAllAudioState(): void {
  cancelRadioFlow();
  stopSpotterTickLoop();
  getAudio().stopChannel(AudioChannel.Spotter);
}

/**
 * Resets all telemetry-tracking state to initial values.
 */
function resetTelemetryState(): void {
  stopSpotterTickLoop();
  globalSpotterState = "clear";
  globalLastOnPitRoad = false;
  globalApproachAlertFired = false;
  globalApproachExitingSuppressed = false;
  globalLastInPitStall = false;
  globalToggleStateInitialized = false;
  globalLastPitSvFlags = 0;
  globalLastPitLimiterActive = false;
  globalLastP2PActive = false;
  globalLastDrsActive = false;
  globalLastPitSvCompound = 0;
  pitLimiterWarningIndex = 0;
  globalLastOnPitRoadForLimiter = false;
  globalLastLimiterOnPitRoad = false;
  globalSpeedingWarnedAt = 0;
  globalTrackPitSpeedLimitMps = 0;
  globalPitSpeedLimitSessionKey = "";
  pitNoLimiterIndex = 0;
  pitLimiterDroppedIndex = 0;
  pitSpeedingIndex = 0;
  offTrackGrassIndex = 0;
  offTrackGravelIndex = 0;
  offTrackGenericIndex = 0;
  offTrackLimitsIndex = 0;
  globalLastIncidentCount = -1;
  globalIncidentAlertedAt = 0;
  globalMaterialHistory = [];
  globalOffTrackStartedAt = 0;
  globalOffTrackWarnedThisExcursion = false;
  globalIncidentFlowActive = false;
  globalLastPosition = -1;
  globalOvertakeInitialized = false;
  globalLastOvertakeTime = 0;
  globalPendingOvertakePos = -1;
  globalPendingOvertakeTime = 0;
  globalLastTipLap = -1;
  globalTipTriggerPct = -1;
  globalTipFiredThisLap = false;
  lastTipFile = null;
  globalActiveFlags = new Set<string>();
  globalFlagStateInitialized = false;
  resetFuelState();
}

/**
 * Resets fuel-warning stint state. Called on disconnect, pit engineer toggle,
 * and whenever a refuel is detected (tank jumped up).
 */
function resetFuelState(): void {
  globalFuelLastLap = -1;
  globalFuelAtLapStart = null;
  globalFuelLapTouchedPit = false;
  globalFuelHistory = [];
  globalFuelLastLevel = null;
  globalFuelInitialized = false;
  globalFuelStintOpenFired = false;
  globalFuelPitWindowFired = false;
  globalFuelMakeEndFired = false;
  globalFuelLow5Fired = false;
  globalFuelLow3Fired = false;
  globalFuelCriticalFired = false;
  globalFuelEmptyFired = false;
  globalFuelLastSaveLap = -1;
  globalFuelLastMidStintLap = -1;
  globalFuelHighConsumptionStreak = 0;
  globalFuelLastCalloutTime = 0;
  globalFuelLapSawNonGreen = false;
  globalFuelLastRefuelTime = 0;
  _globalFuelMakeEndEstimate = null;
  resetFuelPickers();
}

// ─── Action ────────────────────────────────────────────────────────────────────

export class PitEngineer extends ConnectionStateAwareAction<PitEngineerSettings> {
  /** Per-context settings cache (for visible instances only). Named settingsCache to avoid shadowing BaseAction.contexts. */
  private readonly settingsCache = new Map<string, PitEngineerSettings>();

  /** Per-context last rendered state key for icon dedup. */
  private readonly lastStateKey = new Map<string, string>();

  /** Set of currently visible context IDs. */
  private readonly visibleContexts = new Set<string>();

  /** Last engineer test volume timestamp to avoid replaying on every settings update. */
  private lastTestTimestamp = 0;

  /** Last spotter test volume timestamp. */
  private lastSpotterTestTimestamp = 0;

  /** Cycles through spotter test files: left → right → both. */
  private spotterTestIndex = 0;

  /** Spotter test file rotation order. */
  private static readonly SPOTTER_TEST_FILES = [
    "spotter/IRD-spotter-left.mp3",
    "spotter/IRD-spotter-right.mp3",
    "spotter/IRD-spotter-both.mp3",
  ];

  override async onWillAppear(ev: IDeckWillAppearEvent<PitEngineerSettings>): Promise<void> {
    await super.onWillAppear(ev);

    const raw = ev.payload.settings as Record<string, unknown>;
    const settings = Settings.parse(raw);
    const contextId = ev.action.id;

    this.settingsCache.set(contextId, settings);
    this.visibleContexts.add(contextId);
    globalSettings = settings;

    // Seed test timestamps so the first onDidReceiveSettings doesn't
    // falsely trigger playback for both test buttons
    this.lastTestTimestamp = (raw._testVolume as number) ?? 0;
    this.lastSpotterTestTimestamp = (raw._testSpotterVolume as number) ?? 0;

    // Show current global state
    await this.setKeyImage(ev, generatePitEngineerSvg(settings, globalSpotterState, globalEnabled));

    // Ensure global telemetry subscription is running if enabled
    if (globalEnabled && !globalSubscribed) {
      this.startGlobalSubscription();
    }

    // Provide regeneration callback for icon refresh (global color changes, etc.)
    this.setRegenerateCallback(contextId, () => {
      const s = this.settingsCache.get(contextId);

      if (!s) return "";

      return generatePitEngineerSvg(s, globalSpotterState, globalEnabled);
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<PitEngineerSettings>): Promise<void> {
    const contextId = ev.action.id;

    // Only clean up icon-related state — do NOT stop audio or unsubscribe
    this.settingsCache.delete(contextId);
    this.lastStateKey.delete(contextId);
    this.visibleContexts.delete(contextId);

    await super.onWillDisappear(ev);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<PitEngineerSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);

    const raw = ev.payload.settings as Record<string, unknown>;
    const settings = Settings.parse(raw);
    const contextId = ev.action.id;
    this.settingsCache.set(contextId, settings);
    globalSettings = settings;

    // Apply channel volumes whenever settings change
    applyChannelVolumes();

    // Handle engineer test volume button from PI
    const testTimestamp = raw._testVolume as number | undefined;

    if (testTimestamp && testTimestamp !== this.lastTestTimestamp) {
      this.logger.info("Playing welcome message (engineer test)");
      playWelcomeMessage();
    }

    this.lastTestTimestamp = testTimestamp ?? 0;

    // Handle spotter test volume button from PI — plays all 3: left → right → both
    const spotterTestTimestamp = raw._testSpotterVolume as number | undefined;

    if (spotterTestTimestamp && spotterTestTimestamp !== this.lastSpotterTestTimestamp) {
      this.logger.info("Playing spotter test: left → right → both");
      applyChannelVolumes();
      let idx = 0;
      const playNext = (): void => {
        if (idx >= PitEngineer.SPOTTER_TEST_FILES.length) return;

        const file = PitEngineer.SPOTTER_TEST_FILES[idx];
        idx++;
        getAudio().onChannelComplete(AudioChannel.Spotter, () => {
          setTimeout(() => playNext(), 250);
        });
        getAudio().playOnChannel(AudioChannel.Spotter, getAudioPath(file));
      };
      playNext();
    }

    this.lastSpotterTestTimestamp = spotterTestTimestamp ?? 0;

    // Force re-render
    this.lastStateKey.delete(contextId);
    await this.setKeyImage(ev, generatePitEngineerSvg(settings, globalSpotterState, globalEnabled));

    // Update regenerate callback with fresh settings
    this.setRegenerateCallback(contextId, () => {
      const s = this.settingsCache.get(contextId);

      if (!s) return "";

      return generatePitEngineerSvg(s, globalSpotterState, globalEnabled);
    });
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<PitEngineerSettings>): Promise<void> {
    globalEnabled = !globalEnabled;
    this.logger.info(`Pit Engineer ${globalEnabled ? "enabled" : "disabled"}`);

    if (globalEnabled) {
      // Update settings from this context
      const settings = Settings.parse(ev.payload.settings);
      globalSettings = settings;
      this.startGlobalSubscription();
    } else {
      this.stopGlobalSubscription();
      resetAllAudioState();
      resetTelemetryState();
    }

    // Update icon on all visible instances
    this.updateAllVisibleIcons();
  }

  // ─── Global Subscription ──────────────────────────────────────────────────

  private startGlobalSubscription(): void {
    if (globalSubscribed) return;

    globalSubscribed = true;

    this.sdkController.subscribe(GLOBAL_SUB_ID, (telemetry, isConnected) => {
      if (!isConnected) {
        this.handleDisconnect();

        return;
      }

      this.handleTelemetry(telemetry);
    });

    this.logger.debug("Global telemetry subscription started");
  }

  private stopGlobalSubscription(): void {
    if (!globalSubscribed) return;

    globalSubscribed = false;

    this.sdkController.unsubscribe(GLOBAL_SUB_ID);
    this.logger.debug("Global telemetry subscription stopped");
  }

  // ─── Disconnect Handler ──────────────────────────────────────────────────

  private handleDisconnect(): void {
    resetAllAudioState();
    resetTelemetryState();
    globalWelcomePlayed = false;
    this.updateAllVisibleIcons();
  }

  // ─── Telemetry Handler ────────────────────────────────────────────────────

  private handleTelemetry(telemetry: TelemetryData | null): void {
    if (!globalEnabled || !globalSettings) return;

    const onPitRoad = telemetry?.OnPitRoad ?? false;
    const trackSurface = telemetry?.PlayerTrackSurface ?? TrkLoc.NotInWorld;
    const inPitStall = telemetry?.PlayerCarInPitStall ?? false;
    const isOnTrack = telemetry?.IsOnTrack ?? false;

    // ── Welcome message (once per iRacing session, first time in car) ──
    if (!globalWelcomePlayed && isOnTrack) {
      globalWelcomePlayed = true;
      this.logger.info("First time in car — playing welcome message");
      playWelcomeMessage();

      // Seed state so the first real tick doesn't trigger false transitions
      // (e.g., pit road entry reminder when starting in the stall)
      this.updateToggleState(telemetry);
      globalLastOnPitRoad = onPitRoad;
      globalLastInPitStall = inPitStall;

      return;
    }

    // Not on track (exiting car, in garage, spectating) — update state silently
    // to prevent false triggers when telemetry values drop to defaults
    if (!isOnTrack) {
      this.updateToggleState(telemetry);
      globalLastOnPitRoad = onPitRoad;
      globalLastInPitStall = inPitStall;

      return;
    }

    // Engineer voice plays on AudioChannel.Voice, spotter on AudioChannel.Spotter.
    // Voice channel: one-shots pre-empt sequences; spotter is fully independent.

    // ── Pit lane alerts (individually gated) ──────────────────────────
    if (globalSettings.pitExitEnabled) {
      this.handlePitExit(onPitRoad);
    }

    if (globalSettings.pitDepartureEnabled) {
      this.handleStallDeparture(inPitStall, onPitRoad);
    }

    if (globalSettings.pitApproachEnabled) {
      this.handlePitApproach(trackSurface, onPitRoad);
    }

    if (globalSettings.pitServiceReminderEnabled) {
      this.handleServiceReminder(onPitRoad, telemetry);
    }

    // ── Toggle confirmations (pit service + car control) ──────────────
    if (globalSettings.toggleAudioEnabled) {
      this.handleToggleAudio(telemetry);
    } else {
      // Still track state so enabling mid-session doesn't trigger false transitions
      this.updateToggleState(telemetry);
    }

    // ── Overtake & tips (overtake detection + racing tips) ────────────
    if (globalSettings.overtakeAndTipsEnabled) {
      this.handleOvertake(telemetry, onPitRoad);

      if (!onPitRoad) {
        this.handleRacingTip(telemetry);
      }
    }

    // ── Flag alerts (yellow, blue, green, black, red, etc.) ──────────
    if (globalSettings.flagAlertsEnabled) {
      this.handleFlags(telemetry);
    }

    // ── Pit limiter warnings (no-limiter / dropped / speeding) ───────
    if (globalSettings.pitLimiterWarning) {
      this.handlePitLimiterWarning(telemetry);
    }

    // ── Incident alerts (off-track, spin, contact via incident counter) ─
    if (globalSettings.incidentAlert) {
      this.handleIncidentAlert(telemetry, onPitRoad);
    } else {
      // Keep state clean so enabling mid-session doesn't instantly fire
      globalLastIncidentCount = -1;
      globalMaterialHistory = [];
      globalOffTrackStartedAt = 0;
      globalOffTrackWarnedThisExcursion = false;
      globalIncidentFlowActive = false;
    }

    // ── Fuel warnings (threshold-based with safety margins) ──────────
    // Runs every tick — tracks fuel per-lap even when warnings disabled so
    // enabling mid-stint doesn't start from zero history. The
    // `fuelWarningsEnabled` gate inside only suppresses audio output.
    this.handleFuelWarnings(telemetry);

    // ── Directional spotter (independent Spotter channel) ──────────────
    // Suppress spotter while on pit road or during Lone Qualify (solo hotlap,
    // no traffic — callouts are just noise). Open Qualify has real traffic so
    // the spotter stays on.
    const suppressSpotter = onPitRoad || this.isLoneQualifySession(telemetry);

    if (globalSettings.spotterEnabled && !suppressSpotter) {
      this.handleSpotter(telemetry);
    } else if (suppressSpotter && globalSpotterState !== "clear") {
      stopSpotterTickLoop();
      getAudio().stopChannel(AudioChannel.Spotter);
      globalSpotterState = "clear";
      this.updateAllVisibleIcons();
    }

    // Track previous state for next tick
    globalLastOnPitRoad = onPitRoad;
    globalLastInPitStall = inPitStall;
  }

  // ─── Sub-feature: Pit Approach ────────────────────────────────────────────

  private handlePitApproach(trackSurface: number, onPitRoad: boolean): void {
    const isApproaching = trackSurface === TrkLoc.AproachingPits && !onPitRoad;
    const isOnTrack = trackSurface === TrkLoc.OnTrack;

    // Only fire approach alert when driving INTO pits, not exiting.
    // globalLastOnPitRoad is still the previous tick's value here.
    const isExitingPits = globalLastOnPitRoad || globalApproachExitingSuppressed;

    if (isApproaching && isExitingPits) {
      // Car is in the approach zone but coming FROM pit road — suppress
      globalApproachExitingSuppressed = true;
    } else if (!isApproaching && !onPitRoad) {
      // Left the approach zone and not on pit road — clear exit suppression
      globalApproachExitingSuppressed = false;
    }

    if (isApproaching && !globalApproachAlertFired && !isExitingPits) {
      globalApproachAlertFired = true;
      this.logger.info("Pit approach detected");
      playPriorityMessage(pickPitApproach());
    } else if (isOnTrack && globalApproachAlertFired) {
      // Reset only when fully back on track — not in approach zone, not on pit road.
      globalApproachAlertFired = false;
    }
  }

  // ─── Sub-feature: Stall Departure (Disable Pit Limiter) ────────────────────

  private handleStallDeparture(inPitStall: boolean, onPitRoad: boolean): void {
    // Transition from in pit stall → out of pit stall while still on pit road
    // = car just drove out of the stall, remind to disable pit limiter before the cone.
    // NOTE: iRacing auto-enables pit limiter in the stall; this assumes the driver
    // uses manual pit limiter control and needs a reminder to disable it on departure.
    if (globalLastInPitStall && !inPitStall && onPitRoad) {
      this.logger.info("Stall departure detected — disable pit limiter reminder");
      playPriorityMessage(pickStallDeparture());
    }
  }

  // ─── Sub-feature: Pit Exit ────────────────────────────────────────────────

  private handlePitExit(onPitRoad: boolean): void {
    // Transition from on pit road → off pit road
    if (globalLastOnPitRoad && !onPitRoad) {
      this.logger.info("Pit exit detected");
      playPriorityMessage(pickPitExit());
    }
  }

  // ─── Sub-feature: Service Reminder ────────────────────────────────────────

  private handleServiceReminder(onPitRoad: boolean, telemetry: TelemetryData | null): void {
    // Transition from off pit road → on pit road
    if (!globalLastOnPitRoad && onPitRoad) {
      const pitSvFlags = telemetry?.PitSvFlags ?? 0;
      const playerCompound = telemetry?.PlayerTireCompound ?? 0;
      const pitSvCompound = telemetry?.PitSvTireCompound ?? 0;
      const services = resolveQueuedServices(pitSvFlags, playerCompound, pitSvCompound);

      // When iRacing's auto-fuel is active for the NEXT stop, replace the generic
      // fuel reminder with the auto-fuel heads-up instead.
      // dpFuelAutoFillActive = next-stop flag (will auto-fill happen on next pit)
      // dpFuelAutoFillEnabled = system capability (car supports auto-fill) — NOT what we want
      const autoFuelActive = telemetry?.dpFuelAutoFillActive ?? false;

      if (autoFuelActive) {
        const fuelIdx = services.indexOf("reminder/IRD-pit-reminder-fuel.mp3");

        if (fuelIdx !== -1) {
          services.splice(fuelIdx, 1);
        }

        services.unshift(pickAutofuelReminder());
      }

      if (services.length === 0) {
        this.logger.debug("Pit entry detected — no services queued, skipping reminders");

        return;
      }

      this.logger.info("Pit entry detected — queuing service reminders");
      this.logger.debug(`Services: ${services.join(", ")}`);

      if (globalReminderTimer) clearTimeout(globalReminderTimer);

      globalReminderTimer = setTimeout(() => {
        globalReminderTimer = null;
        playReminderFlow(services);
      }, SERVICE_REMINDER_DELAY_MS);
    }
  }

  // ─── Sub-feature: Auto-Fuel Only (when service reminders are off) ──────────

  /**
   * Plays auto-fuel reminder on pit entry when serviceReminderEnabled is off
   * but autoFuelAlertEnabled is on.
   */
  private handleAutoFuelOnly(onPitRoad: boolean, telemetry: TelemetryData | null): void {
    if (!globalLastOnPitRoad && onPitRoad) {
      const autoFuelActive = telemetry?.dpFuelAutoFillActive ?? false;

      if (autoFuelActive && ((telemetry?.PitSvFlags ?? 0) & PitSvFlags.FuelFill) !== 0) {
        this.logger.info("Pit entry detected — auto-fuel alert (standalone)");

        if (globalReminderTimer) clearTimeout(globalReminderTimer);

        globalReminderTimer = setTimeout(() => {
          globalReminderTimer = null;
          playReminderFlow([pickAutofuelReminder()]);
        }, SERVICE_REMINDER_DELAY_MS);
      }
    }
  }

  // ─── Sub-feature: Directional Spotter ─────────────────────────────────────

  private handleSpotter(telemetry: TelemetryData | null): void {
    const carLeftRight = telemetry?.CarLeftRight ?? CarLeftRight.Off;

    const state = resolveSpotterState(carLeftRight);

    // Only reconfigure the tick loop when the state actually changes. Each
    // state has its own interval (single=250ms, two-same-side=180ms, both
    // sides=230ms). Tick loop is self-scheduling — it runs independently of
    // the 4 Hz telemetry cadence.
    if (state !== globalSpotterState) {
      this.logger.debug(`Spotter state: ${globalSpotterState} → ${state}`);

      if (state === "clear") {
        stopSpotterTickLoop();
        getAudio().stopChannel(AudioChannel.Spotter);
      } else {
        applyChannelVolumes();
        startSpotterTickLoop(state);
      }

      globalSpotterState = state;
      this.updateAllVisibleIcons();
    }
  }

  // ─── Sub-feature: Racing Tips ───────────────────────────────────────────────

  private handleRacingTip(telemetry: TelemetryData | null): void {
    if (!this.isRaceSession(telemetry)) return;

    const currentLap = telemetry?.Lap ?? -1;
    const lapDistPct = telemetry?.LapDistPct ?? -1;

    if (currentLap <= 0 || lapDistPct < 0) return;

    // Seed on first tick
    if (globalLastTipLap < 0) {
      globalLastTipLap = currentLap;
      globalTipTriggerPct = pickRandomTriggerPct();

      return;
    }

    // New lap — reset fired flag and pick a new random trigger point
    if (currentLap !== globalLastTipLap) {
      globalLastTipLap = currentLap;
      globalTipFiredThisLap = false;
      globalTipTriggerPct = pickRandomTriggerPct();
    }

    // Already fired this lap — wait for next
    if (globalTipFiredThisLap) return;

    // Check if we've passed the random trigger point
    if (lapDistPct >= globalTipTriggerPct) {
      globalTipFiredThisLap = true;

      // Don't interrupt an active radio flow
      if (radioFlowState !== "idle") return;

      const isStartWindow = currentLap <= 1;
      this.logger.info(
        `Racing tip on lap ${currentLap} at ${Math.round(lapDistPct * 100)}% (${isStartWindow ? "start" : "mid-race"} pool)`,
      );
      playEngineerSoundSimple(pickTip(isStartWindow));
    }
  }

  // ─── Sub-feature: Flag Alerts ─────────────────────────────────────────────

  /**
   * Detects flag transitions and plays audio alerts.
   *
   * Checks which flags are currently active in the SessionFlags bitfield,
   * compares to previously active flags, and fires a Warning Flow callout
   * for each newly-appeared flag. Flags that were already active don't
   * re-trigger until they go away and come back.
   *
   * Blue flag is suppressed when Green is also active (race start has both bits set).
   */
  private handleFlags(telemetry: TelemetryData | null): void {
    const sessionFlags = telemetry?.SessionFlags ?? 0;

    // Resolve which flag keys are currently active
    const currentFlags = new Set<string>();

    if (hasFlag(sessionFlags, Flags.Green)) currentFlags.add("green");

    if (
      hasFlag(sessionFlags, Flags.Yellow) ||
      hasFlag(sessionFlags, Flags.YellowWaving) ||
      hasFlag(sessionFlags, Flags.Caution) ||
      hasFlag(sessionFlags, Flags.CautionWaving)
    )
      currentFlags.add("yellow");

    if (hasFlag(sessionFlags, Flags.Blue)) currentFlags.add("blue");

    if (hasFlag(sessionFlags, Flags.Black) || hasFlag(sessionFlags, Flags.Disqualify)) currentFlags.add("black");

    if (hasFlag(sessionFlags, Flags.Red)) currentFlags.add("red");

    if (hasFlag(sessionFlags, Flags.White)) currentFlags.add("white");

    if (hasFlag(sessionFlags, Flags.Checkered)) currentFlags.add("checkered");

    if (hasFlag(sessionFlags, Flags.Repair)) currentFlags.add("meatball");

    if (hasFlag(sessionFlags, Flags.Debris)) currentFlags.add("debris");

    // Suppress blue when green is active (race start sets both bits)
    if (currentFlags.has("green") && currentFlags.has("blue")) {
      currentFlags.delete("blue");
    }

    // First tick — seed state, don't fire audio
    if (!globalFlagStateInitialized) {
      globalFlagStateInitialized = true;
      globalActiveFlags = currentFlags;

      return;
    }

    // Detect newly-appeared flags (off → on transitions)
    for (const flag of currentFlags) {
      if (!globalActiveFlags.has(flag)) {
        const audioFile = FLAG_AUDIO[flag];

        if (audioFile) {
          this.logger.info(`Flag alert: ${flag}`);
          playEngineerSoundSimple(audioFile);
          // Only announce one flag per tick — highest priority wins
          // (flags are checked in priority order above)
          break;
        }
      }
    }

    globalActiveFlags = currentFlags;
  }

  // ─── Sub-feature: Fuel Warnings ───────────────────────────────────────────

  /**
   * Fuel warning state machine. Runs each tick when fuelWarningsEnabled.
   *
   * Responsibilities:
   *   1. Detect lap boundaries and sample per-lap fuel consumption
   *   2. Detect refuels (tank jumped up) and reset stint state
   *   3. Decide which threshold / informational warning to fire this tick
   *   4. Dispatch via priority or normal radio flow
   *
   * Thresholds are intentionally conservative — see FUEL_THRESHOLDS.
   */
  private handleFuelWarnings(telemetry: TelemetryData | null): void {
    if (!telemetry) return;

    if (!this.isRaceSession(telemetry)) return;

    const fuelLevel = telemetry.FuelLevel;

    if (typeof fuelLevel !== "number" || fuelLevel < 0) return;

    const currentLap = typeof telemetry.Lap === "number" ? telemetry.Lap : -1;
    const onPitRoad = telemetry.OnPitRoad === true;
    const towTime = typeof telemetry.PlayerCarTowTime === "number" ? telemetry.PlayerCarTowTime : 0;
    const underCaution = this.isUnderCaution(telemetry);
    const now = Date.now();

    // ── Refuel detection — fires BEFORE lap sampling so we don't treat
    // the jump as a "negative" per-lap usage. Debounced to avoid noisy
    // telemetry (occasional +0.1 ticks) resetting the stint mid-race.
    // State is always reset (so re-enabling warnings mid-race starts
    // from a clean stint); only the audio callout is gated.
    const refuelJump =
      globalFuelLastLevel !== null && fuelLevel > globalFuelLastLevel + FUEL_THRESHOLDS.refuelDeltaThreshold;
    const refuelCooledDown = now - globalFuelLastRefuelTime >= FUEL_THRESHOLDS.refuelDebounceMs;

    if (refuelJump && refuelCooledDown) {
      this.logger.info("Refuel detected — resetting stint state");
      // Reset state BEFORE playing so subsequent ticks see a clean stint.
      resetFuelState();
      // Restart tracking at the new level so we don't re-trigger on the next tick.
      globalFuelLastLevel = fuelLevel;
      globalFuelAtLapStart = fuelLevel;
      globalFuelLastLap = currentLap;
      globalFuelInitialized = true;
      globalFuelLastRefuelTime = now;
      globalFuelLastCalloutTime = now;

      if (globalSettings?.fuelWarningsEnabled) {
        const refuelFile = pickFromPool(FUEL_REFUEL_DONE_POOL);
        playEngineerSoundSimple(refuelFile);
      }

      return;
    }

    globalFuelLastLevel = fuelLevel;

    // ── Track whether the current lap touched pit road (in/out laps skipped)
    if (onPitRoad) globalFuelLapTouchedPit = true;

    // ── Track whether any non-green condition appeared during the whole lap.
    // Instant-sampling underCaution at the lap boundary misses laps where the
    // yellow dropped before the line, so we accumulate and reset on lap change.
    if (underCaution) globalFuelLapSawNonGreen = true;

    // ── Seed on first valid tick
    if (!globalFuelInitialized) {
      globalFuelInitialized = true;
      globalFuelAtLapStart = fuelLevel;
      globalFuelLastLap = currentLap;
      globalFuelLapTouchedPit = onPitRoad;
      globalFuelLapSawNonGreen = underCaution;

      return;
    }

    // ── Lap boundary detection
    if (currentLap !== globalFuelLastLap && currentLap > 0) {
      const start = globalFuelAtLapStart;
      const completedLap = globalFuelLastLap;
      const fuelUsed = start !== null ? start - fuelLevel : 0;
      const lapTouchedPit = globalFuelLapTouchedPit;
      const usable = isLapUsableForAvg({
        lapTouchedPit,
        underCaution: globalFuelLapSawNonGreen,
        lap: completedLap,
        towTime,
        fuelUsed,
      });

      if (usable) {
        globalFuelHistory.push(fuelUsed);

        if (globalFuelHistory.length > 5) globalFuelHistory.shift();

        const avg = computeConservativeAvg(globalFuelHistory);

        if (avg !== undefined && fuelUsed >= avg * FUEL_THRESHOLDS.highConsumptionRatio) {
          globalFuelHighConsumptionStreak++;
        } else {
          globalFuelHighConsumptionStreak = 0;
        }
      }

      // Start next lap
      globalFuelAtLapStart = fuelLevel;
      globalFuelLastLap = currentLap;
      globalFuelLapTouchedPit = onPitRoad;
      globalFuelLapSawNonGreen = underCaution;
    }

    if (!globalSettings?.fuelWarningsEnabled) return;

    // Don't stack callouts on top of pit-lane priority, service reminders,
    // or any radio flow already in flight.
    if (radioFlowState !== "idle") return;

    // Hard history gate: silence ALL fuel callouts (including priority
    // thresholds) until we've banked at least minHistoryForCallouts valid
    // laps. The bootstrap FuelUsePerHour estimate fires false alarms on
    // short circuits before real per-lap data exists; we'd rather stay
    // silent for the first few laps than cry wolf.
    if (globalFuelHistory.length < FUEL_THRESHOLDS.minHistoryForCallouts) return;

    // Confidence gate: additional layer on top of the hard history gate for
    // race-math callouts (stint-opener / pit-window / make-end / save-fuel /
    // mid-stint), which require tighter confidence than priority thresholds.
    const confidence = getFuelConfidence(globalFuelHistory.length);

    // Dual-window estimate: `warning` is pessimistic (for threshold callouts),
    // `raceMath` is optimistic (for pit-window / make-end, so an improving
    // trend doesn't trigger a premature pit window).
    const dual = computeDualWindowAvgs(globalFuelHistory);
    const warningAvg = dual?.warning;
    const raceMathAvg = dual?.raceMath;
    const warningLapsRemaining = this.estimateLapsRemaining(telemetry, fuelLevel, warningAvg);
    const raceMathLapsRemaining =
      raceMathAvg !== undefined ? this.estimateLapsRemaining(telemetry, fuelLevel, raceMathAvg) : warningLapsRemaining;

    if (warningLapsRemaining === null) return;

    const lapsRemaining = warningLapsRemaining;
    const avgPerLap = warningAvg;

    // Non-priority callouts respect a cooldown so stint-opener / pit-window /
    // make-end / mid-stint / save-fuel can't fire back-to-back on consecutive
    // ticks. Priority thresholds bypass the gate but still reset the timer.
    const cooldownOk = now - globalFuelLastCalloutTime >= FUEL_THRESHOLDS.calloutCooldownMs;

    // ── Priority thresholds (empty / critical / 3-lap / 5-lap) ──
    const fired: FuelFiredFlags = {
      empty: globalFuelEmptyFired,
      critical: globalFuelCriticalFired,
      low3: globalFuelLow3Fired,
      low5: globalFuelLow5Fired,
    };
    const warning = resolveFuelWarning(lapsRemaining, fired);

    if (warning) {
      const file = this.fuelWarningFile(warning.level);
      this.logger.info(
        `Fuel warning: ${warning.level} (${lapsRemaining.toFixed(2)} laps remaining, priority=${warning.priority})`,
      );

      if (warning.level === "empty") globalFuelEmptyFired = true;
      else if (warning.level === "critical") globalFuelCriticalFired = true;
      else if (warning.level === "low3") globalFuelLow3Fired = true;
      else if (warning.level === "low5") globalFuelLow5Fired = true;

      if (warning.priority) playPriorityMessage(file);
      else playEngineerSoundSimple(file);

      globalFuelLastCalloutTime = now;

      return;
    }

    if (!cooldownOk) return;

    // ── Race-end math (one-shot per stint): pit window vs make-end ──
    // Gated by confidence so a 2-lap noisy history doesn't drive a decision
    // we later contradict.
    if (raceMathAllowed(confidence) && raceMathAvg !== undefined && raceMathLapsRemaining !== null) {
      const sessionLapsLeft = typeof telemetry.SessionLapsRemainEx === "number" ? telemetry.SessionLapsRemainEx : -1;
      const makeEndMargin = getMakeEndMarginLaps(confidence);

      if (sessionLapsLeft > 0 && !globalFuelMakeEndFired && !globalFuelPitWindowFired) {
        if (raceMathLapsRemaining >= sessionLapsLeft + makeEndMargin) {
          globalFuelMakeEndFired = true;
          _globalFuelMakeEndEstimate = raceMathLapsRemaining;
          this.logger.info(
            `Fuel: can make the end (${raceMathLapsRemaining.toFixed(1)} vs ${sessionLapsLeft} + ${makeEndMargin} laps left, confidence=${confidence})`,
          );
          playEngineerSoundSimple(pickFromPool(FUEL_MAKE_END_POOL));
          globalFuelLastCalloutTime = now;

          return;
        }

        if (raceMathLapsRemaining < sessionLapsLeft) {
          globalFuelPitWindowFired = true;
          this.logger.info(
            `Fuel: pit window open (${raceMathLapsRemaining.toFixed(1)} vs ${sessionLapsLeft} laps left, confidence=${confidence})`,
          );
          playEngineerSoundSimple(pickFromPool(FUEL_PIT_WINDOW_POOL));
          globalFuelLastCalloutTime = now;

          return;
        }
      }

      // ── Save fuel — pessimistic estimate, hysteresis-gated ──
      // If we already told the driver they'd make the end, don't flip to
      // save-fuel on a minor trend wobble — require a meaningful deficit.
      const hysteresisOk =
        !globalFuelMakeEndFired || lapsRemaining < sessionLapsLeft - FUEL_THRESHOLDS.hysteresisMarginLaps;

      if (
        globalSettings?.fuelSaveCoachingEnabled &&
        sessionLapsLeft > 0 &&
        hysteresisOk &&
        shouldFireSaveFuel({
          lapsRemaining,
          sessionLapsLeft,
          currentLap,
          lastSaveLap: globalFuelLastSaveLap,
        })
      ) {
        globalFuelLastSaveLap = currentLap;
        this.logger.info(
          `Fuel: save coaching (${lapsRemaining.toFixed(1)} vs ${sessionLapsLeft}, confidence=${confidence})`,
        );
        playEngineerSoundSimple(pickFromPool(FUEL_SAVE_POOL));
        globalFuelLastCalloutTime = now;

        return;
      }
    }

    // ── Stint opener: fires once after ≥2 valid laps of history ──
    if (
      globalSettings?.fuelStintOpenEnabled &&
      !globalFuelStintOpenFired &&
      raceMathAllowed(confidence) &&
      globalFuelHistory.length >= FUEL_THRESHOLDS.minHistoryForAvg
    ) {
      globalFuelStintOpenFired = true;
      this.logger.info("Fuel: stint opener");
      playEngineerSoundSimple(pickFromPool(FUEL_STINT_OPEN_POOL));
      globalFuelLastCalloutTime = now;

      return;
    }

    // ── Mid-stint checkpoints (on-plan or high-consumption) ──
    if (
      globalSettings?.fuelMidStintEnabled &&
      raceMathAllowed(confidence) &&
      avgPerLap !== undefined &&
      currentLap > 0 &&
      currentLap !== globalFuelLastMidStintLap &&
      currentLap - globalFuelLastMidStintLap >= FUEL_THRESHOLDS.midStintLaps
    ) {
      globalFuelLastMidStintLap = currentLap;
      const highConsumption = globalFuelHighConsumptionStreak >= 2;
      const pool = highConsumption ? FUEL_HIGH_CONSUMPTION_POOL : FUEL_ON_PLAN_POOL;

      this.logger.info(`Fuel: mid-stint checkpoint (${highConsumption ? "high consumption" : "on plan"})`);
      playEngineerSoundSimple(pickFromPool(pool));
      globalFuelLastCalloutTime = now;
    }
  }

  /** Resolves the audio file for a fuel warning level. */
  private fuelWarningFile(level: "empty" | "critical" | "low3" | "low5"): string {
    switch (level) {
      case "empty":
        return pickFromPool(FUEL_EMPTY_POOL);
      case "critical":
        return pickFromPool(FUEL_CRITICAL_POOL);
      case "low3":
        return pickFromPool(FUEL_LOW_3_POOL);
      case "low5":
        return pickFromPool(FUEL_LOW_5_POOL);
    }
  }

  /**
   * Conservative laps-remaining estimate.
   *
   * - With ≥2 laps of valid history: FuelLevel / rolling conservative avg
   * - Otherwise (bootstrap), try in order:
   *   1. Live mid-lap estimate once we're past 50% of a lap:
   *      (fuel used so far) / lapDistPct projects the full-lap usage from
   *      the partial we've actually driven — better than guessing from
   *      FuelUsePerHour on a short circuit.
   *   2. Pessimistic FuelUsePerHour × last lap time × padding.
   *
   * Returns null when no estimate is possible (e.g. lap time unknown).
   */
  private estimateLapsRemaining(
    telemetry: TelemetryData,
    fuelLevel: number,
    avgPerLap: number | undefined,
  ): number | null {
    if (avgPerLap !== undefined && avgPerLap > 0) {
      return fuelLevel / avgPerLap;
    }

    // Live bootstrap — if we're far enough into the current lap, project
    // per-lap usage from fuel burned so far.
    const lapDistPct = typeof telemetry.LapDistPct === "number" ? telemetry.LapDistPct : -1;

    if (globalFuelAtLapStart !== null && lapDistPct >= FUEL_THRESHOLDS.liveBootstrapMinProgress && lapDistPct <= 1) {
      const usedSoFar = globalFuelAtLapStart - fuelLevel;

      if (usedSoFar > 0) {
        const projectedPerLap = usedSoFar / lapDistPct;

        if (projectedPerLap > 0) {
          return fuelLevel / projectedPerLap;
        }
      }
    }

    const perHour = typeof telemetry.FuelUsePerHour === "number" ? telemetry.FuelUsePerHour : 0;
    const lastLap = typeof telemetry.LapLastLapTime === "number" ? telemetry.LapLastLapTime : 0;

    if (perHour <= 0 || lastLap <= 0) return null;

    const perLap = (perHour * lastLap) / 3600;
    const padded = perLap * FUEL_THRESHOLDS.bootstrapPadding;

    return padded > 0 ? fuelLevel / padded : null;
  }

  /** True when any flavor of yellow is waving. */
  private isUnderCaution(telemetry: TelemetryData | null): boolean {
    const sessionFlags = typeof telemetry?.SessionFlags === "number" ? telemetry.SessionFlags : 0;

    return (
      hasFlag(sessionFlags, Flags.Yellow) ||
      hasFlag(sessionFlags, Flags.YellowWaving) ||
      hasFlag(sessionFlags, Flags.Caution) ||
      hasFlag(sessionFlags, Flags.CautionWaving)
    );
  }

  // ─── Sub-feature: Overtake Detection ────────────────────────────────────────

  /**
   * Cast the SDK's session-info bag once. Returns undefined if no session info
   * is available yet (e.g. pre-connect or garage/warmup transition).
   */
  private getSessionData(): Record<string, unknown> | undefined {
    const sessionInfo = this.sdkController.getSessionInfo();

    return sessionInfo ? (sessionInfo as Record<string, unknown>) : undefined;
  }

  /** Returns the SessionType string for the current session, or empty string. */
  private getCurrentSessionType(telemetry: TelemetryData | null): string {
    const data = this.getSessionData();

    if (!data) return "";

    const sessions = data.SessionInfo as Record<string, unknown> | undefined;
    const sessionList = sessions?.Sessions as Array<Record<string, unknown>> | undefined;
    const sessionNum = telemetry?.SessionNum ?? 0;
    const currentSession = sessionList?.[sessionNum as number];

    return (currentSession?.SessionType as string) ?? "";
  }

  private getPlayerCarIdx(): number {
    const data = this.getSessionData();

    if (!data) return -1;

    const driverInfo = data.DriverInfo as Record<string, unknown> | undefined;

    return (driverInfo?.DriverCarIdx as number) ?? -1;
  }

  private isRaceSession(telemetry: TelemetryData | null): boolean {
    return this.getCurrentSessionType(telemetry) === "Race";
  }

  /**
   * True when the current session is a Lone Qualify (solo hotlap, track is
   * empty). Open Qualify has real traffic so it is NOT included.
   * Used to suppress features that only matter when there's traffic around.
   * Exact match — iRacing SessionType is canonical-cased.
   */
  private isLoneQualifySession(telemetry: TelemetryData | null): boolean {
    return this.getCurrentSessionType(telemetry) === "Lone Qualify";
  }

  private handleOvertake(telemetry: TelemetryData | null, onPitRoad: boolean): void {
    // Only detect overtakes during race sessions, on track, not in pits
    if (!this.isRaceSession(telemetry) || onPitRoad) {
      if (globalOvertakeInitialized) {
        globalOvertakeInitialized = false;
        globalLastPosition = -1;
        globalPendingOvertakePos = -1;
        globalOvertakeCount = 0;
      }

      return;
    }

    // Skip during caution/yellow flags — update position silently
    const sessionFlags = telemetry?.SessionFlags ?? 0;
    const underCaution =
      hasFlag(sessionFlags, Flags.Caution) ||
      hasFlag(sessionFlags, Flags.CautionWaving) ||
      hasFlag(sessionFlags, Flags.Yellow) ||
      hasFlag(sessionFlags, Flags.YellowWaving);

    const positions = calculateRacePositions(telemetry);
    const playerCarIdx = this.getPlayerCarIdx();
    const currentPos = playerCarIdx >= 0 ? positions[playerCarIdx] : -1;

    if (currentPos <= 0) return;

    if (underCaution) {
      globalLastPosition = currentPos;
      globalPendingOvertakePos = -1;

      return;
    }

    if (!globalOvertakeInitialized) {
      globalLastPosition = currentPos;
      globalOvertakeInitialized = true;

      return;
    }

    const now = Date.now();

    // Check if we have a pending overtake waiting to be confirmed
    if (globalPendingOvertakePos > 0) {
      if (currentPos <= globalPendingOvertakePos) {
        // Position held (or improved further) — check if hold time elapsed
        if (now - globalPendingOvertakeTime >= OVERTAKE_HOLD_MS) {
          // Confirmed! Position held for 3 seconds
          globalOvertakeCount++;
          this.logger.info("Overtake confirmed");
          this.logger.debug(
            `Overtake: P${globalLastPosition} → P${currentPos} (held ${OVERTAKE_HOLD_MS}ms, count ${globalOvertakeCount}/${OVERTAKE_PLAY_EVERY})`,
          );

          if (globalOvertakeCount >= OVERTAKE_PLAY_EVERY && now - globalLastOvertakeTime >= OVERTAKE_COOLDOWN_MS) {
            globalLastOvertakeTime = now;
            globalOvertakeCount = 0;
            this.logger.info("Playing overtake audio");
            playEngineerSoundSimple(pickOvertake());
          }

          globalPendingOvertakePos = -1;
        }

        // Update if position improved further during hold
        if (currentPos < globalPendingOvertakePos) {
          globalPendingOvertakePos = currentPos;
        }
      } else {
        // Position dropped back — cancel pending overtake
        globalPendingOvertakePos = -1;
      }
    }

    // Detect new position improvement
    if (globalLastPosition > 0 && currentPos < globalLastPosition && globalPendingOvertakePos < 0) {
      const jump = globalLastPosition - currentPos;

      if (jump <= OVERTAKE_MAX_JUMP) {
        // Start hold timer
        globalPendingOvertakePos = currentPos;
        globalPendingOvertakeTime = now;
      }
    }

    globalLastPosition = currentPos;
  }

  // ─── Sub-feature: Pit Limiter Warning ──────────────────────────────────────

  /**
   * Parses the track's pit speed limit from session YAML.
   * Returns value in m/s, or 0 if unavailable.
   *
   * Session YAML exposes `WeekendInfo.TrackPitSpeedLimit` as a string like
   * "80.00 kph" or "45.00 mph".
   */
  private getPitSpeedLimitMps(telemetry: TelemetryData | null): number {
    const data = this.getSessionData();

    if (!data) return 0;

    const weekend = data.WeekendInfo as Record<string, unknown> | undefined;
    const trackId = String(weekend?.TrackID ?? "") + "|" + String(telemetry?.SessionNum ?? "");

    // Re-parse if session changed or we haven't parsed yet
    if (trackId !== globalPitSpeedLimitSessionKey || globalTrackPitSpeedLimitMps === 0) {
      const raw = weekend?.TrackPitSpeedLimit;

      if (typeof raw === "string") {
        const match = /([\d.]+)\s*(kph|mph|kmh|km\/h)/i.exec(raw);

        if (match) {
          const value = parseFloat(match[1]!);
          const unit = match[2]!.toLowerCase();
          // kph/kmh/km/h → m/s: value / 3.6
          // mph → m/s: value * 0.44704
          globalTrackPitSpeedLimitMps = unit === "mph" ? value * 0.44704 : value / 3.6;
          globalPitSpeedLimitSessionKey = trackId;
        }
      }
    }

    return globalTrackPitSpeedLimitMps;
  }

  /**
   * Pit limiter warnings — four sub-cases, all gated by the single
   * `pitLimiterWarning` setting:
   *
   * 1. Entered pit lane without the limiter engaged
   * 2. Left the pit stall with the limiter still off (covers joining a
   *    practice session in the stall and pulling out without engaging it)
   * 3. Limiter disengaged while still between the pit cones
   * 4. Over the pit speed limit (most urgent)
   *
   * Suppressed while in pit stall (service cycles limiter state) except for
   * detecting the stall-exit transition itself.
   */
  private handlePitLimiterWarning(telemetry: TelemetryData | null): void {
    const onPitRoad = telemetry?.OnPitRoad ?? false;
    const inPitStall = telemetry?.PlayerCarInPitStall ?? false;
    const isOnTrack = telemetry?.IsOnTrack ?? false;
    const limiter = ((telemetry?.EngineWarnings ?? 0) & EngineWarnings.PitSpeedLimiter) !== 0;
    const speed = telemetry?.Speed ?? 0;

    // Seed state and bail when not on track
    if (!isOnTrack) {
      globalLastOnPitRoadForLimiter = onPitRoad;
      globalLastLimiterOnPitRoad = limiter;

      return;
    }

    // Not in pit lane → nothing to warn about. Keep state in sync for entry detection.
    if (!onPitRoad) {
      globalLastOnPitRoadForLimiter = onPitRoad;
      globalLastLimiterOnPitRoad = limiter;

      return;
    }

    // ── 2. Left pit stall with limiter off ──────────────────────────────
    // Checked BEFORE the "in pit stall" bail so we catch the exit transition.
    // Also catches joining a session in the stall with limiter off.
    // `globalLastInPitStall` is updated at end of tick so reflects previous value here.
    const justLeftStall = globalLastInPitStall && !inPitStall;

    if (justLeftStall && !limiter) {
      const file = PIT_NO_LIMITER_WARNINGS[pitNoLimiterIndex]!;
      pitNoLimiterIndex = (pitNoLimiterIndex + 1) % PIT_NO_LIMITER_WARNINGS.length;
      this.logger.info("Left pit stall without limiter — warning");
      this.logger.debug(`No-limiter audio: ${file}`);
      playEngineerSoundSimple(file);
      globalLastOnPitRoadForLimiter = onPitRoad;
      globalLastLimiterOnPitRoad = limiter;

      return;
    }

    // In pit stall (being serviced) — limiter state is noisy, suppress.
    if (inPitStall) {
      globalLastOnPitRoadForLimiter = onPitRoad;
      globalLastLimiterOnPitRoad = limiter;

      return;
    }

    // Near-stationary — driver is creeping into or out of the box, suppress.
    // 5 m/s ≈ 18 km/h — well below any pit speed limit.
    const isCreeping = speed < 5;

    // ── 1. Entered pit lane without limiter ─────────────────────────────
    const justEnteredPitRoad = !globalLastOnPitRoadForLimiter && onPitRoad;

    if (justEnteredPitRoad && !limiter && !isCreeping) {
      const file = PIT_NO_LIMITER_WARNINGS[pitNoLimiterIndex]!;
      pitNoLimiterIndex = (pitNoLimiterIndex + 1) % PIT_NO_LIMITER_WARNINGS.length;
      this.logger.info("Entered pit lane without limiter — warning");
      this.logger.debug(`No-limiter audio: ${file}`);
      playEngineerSoundSimple(file);
      globalLastOnPitRoadForLimiter = onPitRoad;
      globalLastLimiterOnPitRoad = limiter;

      return;
    }

    // ── 2. Limiter disengaged while in pit lane ─────────────────────────
    const limiterJustDropped = globalLastLimiterOnPitRoad && !limiter;

    if (limiterJustDropped && !isCreeping) {
      const file = PIT_LIMITER_DROPPED_WARNINGS[pitLimiterDroppedIndex]!;
      pitLimiterDroppedIndex = (pitLimiterDroppedIndex + 1) % PIT_LIMITER_DROPPED_WARNINGS.length;
      this.logger.info("Limiter disengaged in pit lane — warning");
      this.logger.debug(`Limiter-dropped audio: ${file}`);
      playEngineerSoundSimple(file);
      globalLastOnPitRoadForLimiter = onPitRoad;
      globalLastLimiterOnPitRoad = limiter;

      return;
    }

    // ── 3. Speeding (Speed > pit limit + margin) ────────────────────────
    // 5-second cooldown so it doesn't stutter while the driver slows down.
    const SPEEDING_COOLDOWN_MS = 5000;
    const SPEEDING_MARGIN_MPS = 1.0; // ~3.6 km/h tolerance above posted limit
    const pitLimitMps = this.getPitSpeedLimitMps(telemetry);
    const now = Date.now();

    if (
      pitLimitMps > 0 &&
      speed > pitLimitMps + SPEEDING_MARGIN_MPS &&
      now - globalSpeedingWarnedAt > SPEEDING_COOLDOWN_MS
    ) {
      const file = PIT_SPEEDING_WARNINGS[pitSpeedingIndex]!;
      pitSpeedingIndex = (pitSpeedingIndex + 1) % PIT_SPEEDING_WARNINGS.length;
      globalSpeedingWarnedAt = now;
      this.logger.info(`Pit lane speeding (${speed.toFixed(1)} m/s > ${pitLimitMps.toFixed(1)} m/s) — warning`);
      this.logger.debug(`Speeding audio: ${file}`);
      playEngineerSoundSimple(file);
    }

    globalLastOnPitRoadForLimiter = onPitRoad;
    globalLastLimiterOnPitRoad = limiter;
  }

  // ─── Sub-feature: Incident Alert ───────────────────────────────────────────

  /**
   * Reacts to iRacing's own incident counter (`PlayerCarMyIncidentCount`).
   *
   * Phase 1 — Off-track excursions only:
   *   When the counter increments by 1x or 2x and we've been on an off-track
   *   material (grass / gravel / dirt) within the last ~2 seconds, play the
   *   appropriate material-specific pool.
   *
   * Future phases (currently log-only):
   *   - 1x on-track → track-limits pool
   *   - 4x (major) → spin vs hard-contact discrimination
   *   - Derived light contact (no incident) → light-contact pool
   *   - Running-total milestones (4 / 8 / 12 / 16)
   *
   * A ring buffer of recent off-track material samples lets us classify the
   * event even when iRacing ticks the counter after the driver is already
   * back on track.
   *
   * Suppressed in pit lane entirely.
   */
  private handleIncidentAlert(telemetry: TelemetryData | null, onPitRoad: boolean): void {
    const isOnTrack = telemetry?.IsOnTrack ?? false;
    const surface = telemetry?.PlayerTrackSurface ?? TrkLoc.NotInWorld;
    const material = telemetry?.PlayerTrackSurfaceMaterial ?? 0;
    const incidentCount = telemetry?.PlayerCarMyIncidentCount ?? 0;

    // Not in session / in pits — reset and bail
    if (!isOnTrack || onPitRoad || surface === TrkLoc.InPitStall) {
      globalLastIncidentCount = incidentCount;
      globalMaterialHistory = [];
      globalOffTrackStartedAt = 0;
      globalOffTrackWarnedThisExcursion = false;
      globalIncidentFlowActive = false;

      return;
    }

    const now = Date.now();

    // Defer the cooldown while the previous clip is still playing. This makes
    // the 4s gap count from when the clip FINISHES, not when it started.
    if (globalIncidentFlowActive) {
      if (radioFlowState !== "idle") {
        globalIncidentAlertedAt = now; // keep pushing the clock forward
      } else {
        globalIncidentFlowActive = false;
        globalIncidentAlertedAt = now; // start 4s countdown from end-of-clip
      }
    }

    // Track excursion state + sample material into ring buffer
    if (surface === TrkLoc.OffTrack) {
      if (globalOffTrackStartedAt === 0) {
        // New excursion — clear the "already warned" flag so the sustained
        // path can fire (and so track-limits can fire if excursion stays brief)
        globalOffTrackStartedAt = now;
        globalOffTrackWarnedThisExcursion = false;
      }

      globalMaterialHistory.push({ t: now, material });
    } else {
      // Back on track — clear excursion timer but KEEP the "already warned"
      // flag set until the next excursion starts. This suppresses any trailing
      // incident-counter tick that lands right after returning (iRacing often
      // ticks the counter a beat late, which would otherwise trigger a
      // track-limits callout stacked on top of the sustained warning).
      globalOffTrackStartedAt = 0;
    }

    globalMaterialHistory = globalMaterialHistory.filter((s) => now - s.t <= MATERIAL_WINDOW_MS);

    // First tick — seed incident counter without firing
    if (globalLastIncidentCount < 0) {
      globalLastIncidentCount = incidentCount;

      return;
    }

    const delta = incidentCount - globalLastIncidentCount;
    globalLastIncidentCount = incidentCount;

    // ── 1) Sustained off-track (2s+) → material-specific pool ──
    const offTrackDuration = globalOffTrackStartedAt > 0 ? now - globalOffTrackStartedAt : 0;

    // Repeats every INCIDENT_COOLDOWN_MS (4s) while the driver stays off-track —
    // the cooldown is the pacing mechanism. globalOffTrackWarnedThisExcursion
    // still gets flipped so the brief-incident branch below knows a sustained
    // warning already covered this excursion.
    if (
      surface === TrkLoc.OffTrack &&
      offTrackDuration >= SUSTAINED_OFF_TRACK_MS &&
      now - globalIncidentAlertedAt >= INCIDENT_COOLDOWN_MS
    ) {
      // Fall back to "generic" if the ring buffer didn't classify any material
      // (can happen with rare TrkSurf values not covered by classifyOffTrackMaterial).
      // We're definitely off-track — still want to warn, and we must flag this
      // excursion as warned so a trailing incident counter tick doesn't double-fire.
      const category = pickPeakOffTrackCategory(globalMaterialHistory) ?? "generic";
      const file = pickIncidentFile(category);

      this.logger.info(`Sustained off-track ${Math.round(offTrackDuration)}ms (${category}) — warning`);
      this.logger.debug(`Sustained off-track audio: ${file}`);

      const started = playEngineerSoundSimple(file);

      // Only pin the cooldown and flow flag if audio actually started. If a
      // priority message dropped the play, the radio flow stays idle and the
      // cooldown-from-clip-end block would otherwise short-circuit to 0.
      if (started) {
        globalIncidentAlertedAt = now;
        globalIncidentFlowActive = true;
      } else {
        this.logger.debug(`Sustained off-track: audio dropped (priority active)`);
      }

      // Flag the excursion as warned regardless — we tried; don't stack track-limits on top.
      globalOffTrackWarnedThisExcursion = true;

      return;
    }

    // ── 2) Incident counter ticked — brief off-track or on-track limit violation ──
    if (delta <= 0) return;

    if (now - globalIncidentAlertedAt < INCIDENT_COOLDOWN_MS) {
      this.logger.debug(`Incident +${delta} skipped (cooldown)`);

      return;
    }

    // Phase 2 — 4x events: spin / hard contact (not implemented yet)
    if (delta >= 4) {
      this.logger.info(`Incident +${delta} (major event — Phase 2 not implemented yet)`);

      return;
    }

    // Sustained warning already covered this excursion — don't double-fire
    if (globalOffTrackWarnedThisExcursion) {
      this.logger.debug(`Incident +${delta} skipped (sustained warning already fired)`);

      return;
    }

    // Brief off-track / track-limits pool
    const file = pickTrackLimitsFile();

    if (file === null) {
      this.logger.info(`Incident +${delta} (track limits — no audio pool yet)`);

      return;
    }

    this.logger.info(`Incident +${delta} (track limits) — warning`);
    this.logger.debug(`Track limits audio: ${file}`);

    const started = playEngineerSoundSimple(file);

    if (started) {
      globalIncidentAlertedAt = now;
      globalIncidentFlowActive = true;
    } else {
      this.logger.debug(`Track limits: audio dropped (priority active)`);
    }
  }

  // ─── Sub-feature: Toggle Audio Confirmations ───────────────────────────────

  /**
   * Reads current toggle states from telemetry without playing audio.
   * Used to keep previous-state variables in sync when toggle audio is disabled.
   */
  private updateToggleState(telemetry: TelemetryData | null): void {
    const pitSvFlags = telemetry?.PitSvFlags ?? 0;
    const limiter = ((telemetry?.EngineWarnings ?? 0) & EngineWarnings.PitSpeedLimiter) !== 0;
    const p2p = telemetry?.P2P_Status === true;
    const drs = (telemetry?.DRS_Status ?? 0) > 0;

    globalToggleStateInitialized = true;
    globalLastPitSvFlags = pitSvFlags;
    globalLastPitLimiterActive = limiter;
    globalLastP2PActive = p2p;
    globalLastDrsActive = drs;
    globalLastPitSvCompound = telemetry?.PitSvTireCompound ?? 0;
  }

  /**
   * Detects toggle state transitions and queues audio confirmations.
   */
  private handleToggleAudio(telemetry: TelemetryData | null): void {
    const pitSvFlags = telemetry?.PitSvFlags ?? 0;
    const limiter = ((telemetry?.EngineWarnings ?? 0) & EngineWarnings.PitSpeedLimiter) !== 0;
    const p2p = telemetry?.P2P_Status === true;
    const drs = (telemetry?.DRS_Status ?? 0) > 0;
    const inPitStall = telemetry?.PlayerCarInPitStall ?? false;
    const onPitRoad = telemetry?.OnPitRoad ?? false;
    const isOnTrack = telemetry?.IsOnTrack ?? false;

    const pitSvCompound = telemetry?.PitSvTireCompound ?? 0;

    // First tick or not on track — capture state without playing audio
    if (!globalToggleStateInitialized || !isOnTrack) {
      globalToggleStateInitialized = true;
      globalLastPitSvFlags = pitSvFlags;
      globalLastPitLimiterActive = limiter;
      globalLastP2PActive = p2p;
      globalLastDrsActive = drs;
      globalLastPitSvCompound = pitSvCompound;

      return;
    }

    // Suppress pit service toggle audio while in pit stall, on the first tick
    // after leaving the stall (services change during servicing), AND on the
    // pit entry tick (iRacing auto-sets flags which would collide with reminders).
    const justLeftPitStall = globalLastInPitStall && !inPitStall;
    const justEnteredPitRoad = !globalLastOnPitRoad && onPitRoad;
    const suppressPitServiceToggles = inPitStall || justLeftPitStall || justEnteredPitRoad;

    if (justLeftPitStall || justEnteredPitRoad) {
      // Re-seed previous state so the flag difference is invisible
      globalLastPitSvFlags = pitSvFlags;
      globalLastPitSvCompound = pitSvCompound;
    }

    // Collect all toggle audio cues for this tick
    const files: string[] = [];

    // Suppress pit service toggle audio in pit stall, stall exit, and pit entry
    if (!suppressPitServiceToggles) {
      const playerCompound = telemetry?.PlayerTireCompound ?? 0;
      const pitSvCompound = telemetry?.PitSvTireCompound ?? 0;
      files.push(
        ...resolvePitServiceToggleAudio(
          globalLastPitSvFlags,
          pitSvFlags,
          playerCompound,
          globalLastPitSvCompound,
          pitSvCompound,
        ),
      );
    }

    // Pit limiter uses simple radio flow (no ack) — separate from other toggles
    let limiterFile: string | null = null;

    {
      const onPitRoad = telemetry?.OnPitRoad ?? false;
      const trackSurface = telemetry?.PlayerTrackSurface ?? TrkLoc.NotInWorld;
      const isApproaching = trackSurface === TrkLoc.AproachingPits;

      // Check limiter separately — it gets simple radio flow
      // Suppress during pit approach (limiter naturally activates when entering pit lane)
      if (globalLastPitLimiterActive !== limiter && !onPitRoad && !isApproaching && limiter) {
        limiterFile = PIT_LIMITER_WARNINGS[pitLimiterWarningIndex];
        pitLimiterWarningIndex = (pitLimiterWarningIndex + 1) % PIT_LIMITER_WARNINGS.length;
      }

      // Other car control toggles (P2P, DRS)
      const prevNoLimiter = { limiter: false, p2p: globalLastP2PActive, drs: globalLastDrsActive };
      const currNoLimiter = { limiter: false, p2p, drs };
      files.push(...resolveCarControlToggleAudio(prevNoLimiter, currNoLimiter, onPitRoad));
    }

    // Update previous state
    globalLastPitSvFlags = pitSvFlags;
    globalLastPitLimiterActive = limiter;
    globalLastP2PActive = p2p;
    globalLastDrsActive = drs;
    globalLastPitSvCompound = pitSvCompound;

    // Pit limiter: simple radio flow (tick → message → tick, no ack)
    if (limiterFile) {
      this.logger.info("Pit limiter activated on track — warning");
      this.logger.debug(`Limiter audio: ${limiterFile}`);
      playEngineerSoundSimple(limiterFile);

      return; // Limiter takes priority over other toggles this tick
    }

    if (files.length === 0) return;

    this.logger.info("Toggle state change detected");
    this.logger.debug(`Toggle audio: ${files.join(", ")}`);

    // Other toggles: full radio flow (tick → ack → messages → tick)
    playRadioMessage(files);
  }

  // ─── Icon Updates ─────────────────────────────────────────────────────────

  private updateAllVisibleIcons(): void {
    for (const contextId of this.visibleContexts) {
      const settings = this.settingsCache.get(contextId);

      if (!settings) continue;

      const stateKey = `${globalEnabled}|${globalSpotterState}|${JSON.stringify(settings.colorOverrides)}|${JSON.stringify(settings.borderOverrides)}|${JSON.stringify(settings.titleOverrides)}|${JSON.stringify(settings.graphicOverrides)}`;

      if (this.lastStateKey.get(contextId) === stateKey) continue;

      this.lastStateKey.set(contextId, stateKey);
      const svg = generatePitEngineerSvg(settings, globalSpotterState, globalEnabled);
      void this.updateKeyImage(contextId, svg);
    }
  }
}
