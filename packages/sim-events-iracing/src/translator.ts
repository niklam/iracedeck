/**
 * iRacing sim-event translator.
 *
 * Subscribes to `sdkController` ticks, diffs each snapshot against the
 * previous tick, and publishes semantic events through the shared
 * `@iracedeck/event-bus`. This is the only package allowed to import
 * `@iracedeck/iracing-sdk` for telemetry consumption — future sim
 * adapters (`sim-events-ac`, …) sit as parallel siblings and emit the
 * same event catalog.
 *
 * Lifecycle:
 *   - initializeSimEventsIracing(bus, sdkController, logger) subscribes
 *     under id "__sim-events-iracing__"; call once at plugin startup
 *     after initializeEventBus() and initializeSDK().
 *   - On each tick the translator stores the latest telemetry (available
 *     via getLatestTelemetry()) and invokes each diff module.
 *   - On disconnect it resets per-tick state so a later reconnect
 *     doesn't replay stale transitions.
 */
import type {
  IEventBus,
  PitReadbackSnapshot,
  QualifyingInvalidationSnapshot,
  RaceStartConditions,
  SessionStartConditions,
  SimEventMap,
  SimEventName,
} from "@iracedeck/event-bus";
import { TrackWetness } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  classPositionFromOrder,
  crossingTimeAt,
  type GapTrendDirection,
  IRSDK_UNLIMITED_LAPS,
  nearestCarGapMeters,
  type SDKController,
  SessionState,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { type CornerMarker, resolveCornerMarkers } from "@iracedeck/track-data";

import { CORNER_CALLOUT_DEFAULT_LEAD_SECONDS, diffCornerName } from "./diff/corner-name.js";
import { diffDamage } from "./diff/damage.js";
import { diffFlags } from "./diff/flags.js";
import {
  diffFuelLapsLeft,
  FUEL_CALLOUT_DEFAULT_MARGIN_LAPS,
  FUEL_LAPS_LEFT_WINDOW_LAPS,
} from "./diff/fuel-laps-left.js";
import {
  computeFuelStats,
  createFuelLapTracker,
  diffFuelLaps,
  type FuelLapTracker,
  type FuelStats,
} from "./diff/fuel-laps.js";
import { diffGaps, GAP_DEFAULT_ALERT_THRESHOLD_S } from "./diff/gaps.js";
import { diffIncidents } from "./diff/incidents.js";
import { diffLaps } from "./diff/laps.js";
import { diffLifecycle } from "./diff/lifecycle.js";
import { diffLimiter } from "./diff/limiter.js";
import { diffOvertakes } from "./diff/overtakes.js";
import { diffPaceLaps, resolvePaceCarIdx } from "./diff/pace-laps.js";
import { diffPitBoxCountdown } from "./diff/pit-box-countdown.js";
import { diffPitLane } from "./diff/pit-lane.js";
import { buildSnapshot as buildReadbackSnapshot, diffPitReadback } from "./diff/pit-readback.js";
import { diffPitStatus } from "./diff/pit-status.js";
import { diffPitsOpen } from "./diff/pits-open.js";
import { calculateFrozenRacePositions, updatePositionTracking } from "./diff/race-finish.js";
import { diffRadar, resolveRadarState } from "./diff/radar.js";
import { diffRollingStart } from "./diff/rolling-start.js";
import { diffStartCountdown, diffStartLights } from "./diff/start-lights.js";
import { diffToggles } from "./diff/toggles.js";
import { diffTrackWetness } from "./diff/track-wetness.js";
import type { PendingEvent } from "./diff/types.js";
import { resolveStandingStart } from "./start-lights.js";
import { createInitialState, type TranslatorState } from "./state.js";
import { resolveTrackDirection, resolveTrackType, type TrackDirection } from "./track-type.js";

const SUBSCRIPTION_ID = "__sim-events-iracing__";

type TranslatorInstance = {
  bus: IEventBus;
  controller: SDKController;
  logger: ILogger;
  state: TranslatorState;
  latestTelemetry: TelemetryData | null;
  /** Cached pit speed limit (m/s) parsed from session YAML. 0 = not parsed. */
  pitSpeedLimitMps: number;
  pitSpeedLimitKey: string;
  /** Tracks the `IsReplayPlaying` edge so we can reset state on transition. */
  lastTickInReplay: boolean;
  /**
   * `telemetry.SessionNum` tracker for session-change detection (issue #564).
   * Kept on the instance — not in `TranslatorState` — so it survives the
   * replay guard's per-tick state wipes. iRacing's between-session transition
   * commonly passes through `IsReplayPlaying: true` ticks, and if the tracker
   * lived in state the wipe would null it out before the SessionNum delta
   * could be detected. `null` until the first tick observes a value; reset
   * only by `handleDisconnect`.
   */
  lastObservedSessionNum: number | null;
  /**
   * `driver.firstOnTrack` tracking — session-scoped (issue #564), not
   * connection-scoped. Kept on the instance (not `TranslatorState`) so it
   * survives the replay guard's per-tick state wipes; reset by
   * `resetPerSessionState` on a `SessionNum` change and by `handleDisconnect`
   * on a fresh connection. Seeding stays `true` across session resets — if
   * the driver is already on track at the moment of the transition,
   * re-seeding would silently mark fired and swallow the very fire we want.
   * See `diffFirstOnTrack`.
   */
  firstOnTrackSeeded: boolean;
  firstOnTrackFired: boolean;
  /**
   * Fresh-connect `session.changed` latch (issues #568, #668). When the
   * plugin connects directly into a session there's no prior SessionNum to
   * drive a `session.changed` delta, so the callouts keyed off it would never
   * fire. We synthesize one `session.changed { from: -1, to: SessionNum }` on
   * the first tick that satisfies the gating conditions. The SessionState gate
   * depends on the classified session type:
   *   - race (#568): pre-green only (GetInCar/Warmup/ParadeLaps), so we don't
   *     fire the grid brief on a mid-race reconnect.
   *   - practice/qualifying (#668): pre-green OR during green (Racing), since
   *     those sessions sit in `Racing` their whole green period and connecting
   *     mid-session is the normal case (the conditions brief is what the
   *     driver wants on connect).
   * Latched once the decision is made — either we fired, or we observed a
   * state that disqualifies the synthesis (a race at/after green, or any
   * session winding down at Checkered/CoolDown). `SessionState.Invalid` keeps
   * the latch open so telemetry that hasn't settled yet doesn't slam the door.
   * Cleared by `handleDisconnect` so a reconnect re-checks.
   */
  freshConnectFireChecked: boolean;
  /**
   * Once-per-episode marker for the replay-only skip log (issue #908). The
   * #604 replay-only gate deliberately does NOT latch
   * `freshConnectFireChecked`, so while a replay-only session is open the
   * gate re-evaluates — and would otherwise log the skip — on every tick
   * (~60 INFO lines/s). Set when the skip is first logged; reset when a
   * non-replay-only tick is observed (checked ahead of the fresh-connect
   * gate in `handleTick`, so a tick without SessionNum still ends the
   * episode) and by `handleDisconnect`, so a later replay episode logs
   * again. Logging only — no effect on the synthesis/latch behavior.
   */
  freshConnectReplaySkipLogged: boolean;
  /**
   * Validated per-lap fuel consumption history (issue #465). Instance-level
   * — NOT `TranslatorState` — so the replay guard's per-tick state wipes and
   * `resetPerSessionState` don't destroy the accumulated stats: garage visits
   * (replay-mode ticks) keep the data visible for fuel planning, and a
   * session change only arms `pendingSessionWipe`, which `diffFuelLaps`
   * executes on the first live-in-car tick of the new session. Fully reset by
   * `handleDisconnect`. Read via `getFuelStats()`.
   */
  fuelLaps: FuelLapTracker;
  /**
   * Live-read safety margin (laps) for the laps-of-fuel-left callouts
   * (issue #838). Plugins wire it to the `fuelCalloutMarginLaps` global
   * setting (sanitized); defaults to the constant when no closure is given.
   */
  getFuelLapsLeftMarginLaps: () => number;
  /**
   * Live-read announcement lead (seconds) for the corner-name callouts
   * (issue #888). Plugins wire it to the `cornerCalloutLeadSeconds` global
   * setting (sanitized); defaults to the constant when no closure is given.
   */
  getCornerCalloutLeadSeconds: () => number;
  /**
   * Live-read gap alert threshold (seconds) for the gap callouts
   * (issue #933). Plugins wire it to the `gapAlertThresholdSeconds` global
   * setting; defaults to the constant when no closure is given.
   */
  getGapAlertThresholdSeconds: () => number;
};

/**
 * Optional wiring for {@link initializeSimEventsIracing} (issue #838).
 * Settings-backed knobs the diffs read live — injected as closures so this
 * package stays independent of `@iracedeck/deck-core`.
 */
export type SimEventsIracingOptions = {
  /**
   * Live-read margin (laps) subtracted from the raw laps-of-fuel-left
   * estimate before the spoken count is derived. Plugins compose it from
   * the `fuelCalloutMarginLaps` global setting via
   * `sanitizeFuelCalloutMarginLaps`. Default: a constant
   * {@link FUEL_CALLOUT_DEFAULT_MARGIN_LAPS}.
   */
  getFuelLapsLeftMarginLaps?: () => number;
  /**
   * Live-read announcement lead (seconds) for the corner-name callouts
   * (issue #888). Plugins compose it from the `cornerCalloutLeadSeconds`
   * global setting via `sanitizeCornerCalloutLeadSeconds`. Default: a
   * constant {@link CORNER_CALLOUT_DEFAULT_LEAD_SECONDS}.
   */
  getCornerCalloutLeadSeconds?: () => number;
  /**
   * Live-read gap alert threshold (seconds) for the gap callouts
   * (issue #933). Plugins compose it from the `gapAlertThresholdSeconds`
   * global setting. Default: a constant {@link GAP_DEFAULT_ALERT_THRESHOLD_S}.
   */
  getGapAlertThresholdSeconds?: () => number;
};

let instance: TranslatorInstance | null = null;

/**
 * Initialize the iRacing translator singleton. Subscribes to sdkController
 * and starts publishing events to the shared event bus. Throws on double
 * initialization — call once per plugin process.
 */
export function initializeSimEventsIracing(
  eventBus: IEventBus,
  sdkController: SDKController,
  logger: ILogger = silentLogger,
  options: SimEventsIracingOptions = {},
): void {
  if (instance) {
    throw new Error("sim-events-iracing already initialized. initializeSimEventsIracing() should only be called once.");
  }

  const self: TranslatorInstance = {
    bus: eventBus,
    controller: sdkController,
    logger,
    state: createInitialState(),
    latestTelemetry: null,
    pitSpeedLimitMps: 0,
    pitSpeedLimitKey: "",
    lastTickInReplay: false,
    lastObservedSessionNum: null,
    firstOnTrackSeeded: false,
    firstOnTrackFired: false,
    freshConnectFireChecked: false,
    freshConnectReplaySkipLogged: false,
    fuelLaps: createFuelLapTracker(),
    getFuelLapsLeftMarginLaps: options.getFuelLapsLeftMarginLaps ?? (() => FUEL_CALLOUT_DEFAULT_MARGIN_LAPS),
    getCornerCalloutLeadSeconds: options.getCornerCalloutLeadSeconds ?? (() => CORNER_CALLOUT_DEFAULT_LEAD_SECONDS),
    getGapAlertThresholdSeconds: options.getGapAlertThresholdSeconds ?? (() => GAP_DEFAULT_ALERT_THRESHOLD_S),
  };

  instance = self;

  sdkController.subscribe(SUBSCRIPTION_ID, (telemetry, isConnected) => {
    if (!isConnected) {
      handleDisconnect(self);

      return;
    }

    if (!telemetry) return;

    self.latestTelemetry = telemetry;
    handleTick(self, telemetry);
  });

  logger.info("sim-events-iracing translator initialized");
}

/** Returns the latest telemetry snapshot, or null if never received / disconnected. */
export function getLatestTelemetry(): TelemetryData | null {
  return instance?.latestTelemetry ?? null;
}

/**
 * Returns the current iRacing session type ("Race", "Practice", "Open Qualify",
 * "Lone Qualify", …) or empty string if session info is unavailable. Resolved
 * from the SDK's session YAML; action consumers use this to gate session-
 * specific behavior without taking a direct dependency on `@iracedeck/iracing-sdk`.
 */
export function getSessionType(): string {
  if (!instance || !instance.latestTelemetry) return "";

  const sessionInfo = instance.controller.getSessionInfo() as Record<string, unknown> | null;

  return resolveSessionType(sessionInfo, instance.latestTelemetry);
}

/**
 * Returns the current track's rotation direction ({@link TrackDirection}) read
 * from the SDK's session YAML (`WeekendInfo.TrackDirection`). Drives the
 * spotter's road (left/right) vs oval (inside/outside) terminology (issue #651).
 * Resolves to `Neutral` when the translator isn't initialized or session info is
 * unavailable. Read from the same session-YAML source as {@link getSessionType}
 * so consumers don't take a direct dependency on `@iracedeck/iracing-sdk`.
 */
export function getTrackDirection(): TrackDirection {
  const sessionInfo = (instance?.controller.getSessionInfo() ?? null) as Record<string, unknown> | null;

  return resolveTrackDirection(sessionInfo);
}

/**
 * Rolling fuel consumption statistics over the validated per-lap fuel history
 * (issue #465): the most recent valid lap's usage, the mean over the last
 * `windowLaps` valid laps, and how many laps actually contributed. Values are
 * liters — callers handle `DisplayUnits` formatting. Returns empty stats
 * (`samples: 0`) when the translator isn't initialized or no valid laps have
 * been recorded yet. Backed by `diffFuelLaps`, which gates out refuel /
 * out-lap / in-lap / towed laps so the average never ingests garbage.
 *
 * The history survives replay/garage visits and stays readable after a
 * session change until the driver is back in the car (deferred wipe) — so the
 * previous session's consumption remains available for garage fuel planning.
 * Only a disconnect (or the diff's Lap-decrease fence) clears it immediately.
 */
export function getFuelStats(windowLaps: number): FuelStats {
  if (!instance) return { lastLap: null, avg: null, avgLapTime: null, samples: 0 };

  return computeFuelStats(instance.fuelLaps.history, windowLaps);
}

/**
 * Whether the current race is a standing start (`WeekendInfo.WeekendOptions.
 * StandingStart === 1`), read from the SDK's session YAML. Resolves to `false`
 * when the translator isn't initialized or session info is unavailable. Lets the
 * audio layer suppress the rolling-only "one pace lap to go" / "green's coming"
 * formation callouts during a standing-start grid (issue #480), where there is
 * no pace lap. Read from the same session-YAML source as {@link getSessionType}.
 */
export function getStandingStart(): boolean {
  const sessionInfo = (instance?.controller.getSessionInfo() ?? null) as Record<string, unknown> | null;

  return resolveStandingStart(sessionInfo);
}

/**
 * Distance (meters) to the nearest car on track, or `null` when unavailable.
 * Computed from `CarIdxLapDistPct` × `WeekendInfo.TrackLength`. Drives the
 * spotter's "clear" confirmation buffer (issue #651) — it holds the "clear" call
 * until this gap has grown, so a car flickering at the lateral detection
 * boundary doesn't stutter "clear".
 */
export function getNearestCarGapMeters(): number | null {
  if (!instance || !instance.latestTelemetry) return null;

  const telemetry = instance.latestTelemetry;
  const sessionInfo = instance.controller.getSessionInfo() as Record<string, unknown> | null;
  const playerCarIdx = resolvePlayerCarIdx(sessionInfo);

  if (playerCarIdx < 0) return null;

  // Reuse the cached track-length parser (#574) — it memoizes per (TrackID,
  // SessionNum) on TranslatorState, so the per-poll clear-buffer path doesn't
  // re-parse the YAML string each tick.
  const trackLengthMeters = resolveTrackLengthMeters(instance.state, sessionInfo, telemetry);

  if (trackLengthMeters === null) return null;

  return nearestCarGapMeters(telemetry, playerCarIdx, trackLengthMeters);
}

/**
 * Returns the loaded car setup's name (`DriverInfo.DriverSetupName`) or
 * `undefined` when session info is unavailable or the field is missing. Used by
 * the setup-mismatch warning (issue #625) to heuristically flag a setup whose
 * name looks wrong for the session type. Read from the SDK's session YAML so
 * consumers don't take a direct dependency on `@iracedeck/iracing-sdk`.
 */
export function getDriverSetupName(): string | undefined {
  if (!instance || !instance.latestTelemetry) return undefined;

  const sessionInfo = instance.controller.getSessionInfo() as Record<string, unknown> | null;

  return resolveDriverSetupName(sessionInfo);
}

export function isSimEventsIracingInitialized(): boolean {
  return instance !== null;
}

/**
 * Whether per-toggle pit-action confirmation scenarios are currently
 * allowed to fire (issue #476). Returns `false` while the cooldown set
 * by `pitLane.exited` (4500 ms) or by entering the pre-start grid window
 * (5000 ms) is still in effect — pit-actions stay silent during those
 * windows so iRacing's phantom flag-cascade emissions and the pending
 * readbacks don't double up. Plugin entry-points pass this as the
 * `getPitActionsAllowed` closure to `registerPitCrew`.
 */
export function isPitActionsAllowed(): boolean {
  if (!instance) return true;

  return Date.now() >= instance.state.pitActionCooldownUntil;
}

/**
 * Whether the race-end latch has fired in the current race session (issue #569).
 * Set inside `diffLaps` the first time `lap.completed` lands with the checkered
 * flag raised in a race session — the diff publishes `race.finished` first into
 * the pending queue and updates the latch synchronously, so by the time the
 * race-status scenario's `where:` runs against the same `lap.completed`, this
 * returns `true` and the periodic status callout is suppressed for the final
 * lap. Clears on session change / disconnect, so a later race session re-arms.
 * Returns `false` when the translator hasn't been initialized yet.
 */
export function isRaceFinished(): boolean {
  if (!instance) return false;

  return instance.state.raceFinishedFired;
}

/**
 * Build a pit-readback snapshot from the latest telemetry tick (issue
 * #481). Returns `null` if no telemetry has arrived yet — callers (the
 * audio scenarios, via the resolver passed into `registerPitCrew`)
 * treat null as "no queued services known", which collapses to the
 * empty-fallback recap rather than speaking a stale or fabricated plan.
 *
 * Read at fire time so a deferred readback (busy-bus low-priority hold
 * or higher-priority preempt that stashed the readback for replay)
 * speaks the user's *current* queue, not the queue from the moment the
 * `pitService.readbackRequested` event was emitted.
 */
export function getReadbackSnapshot(): PitReadbackSnapshot | null {
  if (!instance || !instance.latestTelemetry) return null;

  return buildReadbackSnapshot(instance.latestTelemetry);
}

/**
 * Build the session-start conditions snapshot from the latest telemetry tick +
 * session info (issues #542, #668). Returns `null` when telemetry
 * or session info is unavailable, or when track wetness is still `Unknown` —
 * the session-start scenario treats null as "skip the callout" rather than
 * speaking a nonsense line.
 *
 * Units are resolved here from iRacing's `DisplayUnits` so the engineer
 * matches the sim: pit speed and temperatures are converted into the user's
 * display unit and rounded to integers. Pit speed is rounded exactly (never
 * stepped) — the scenario decides whether it can speak the value.
 *
 * Read at fire time (same deferred-snapshot rationale as
 * {@link getReadbackSnapshot}).
 */
export function getSessionStartConditions(): SessionStartConditions | null {
  if (!instance || !instance.latestTelemetry) return null;

  const telemetry = instance.latestTelemetry;
  const sessionInfo = instance.controller.getSessionInfo() as Record<string, unknown> | null;

  if (!sessionInfo) return null;

  const wetness = telemetry.TrackWetness;

  if (typeof wetness !== "number" || wetness < TrackWetness.Dry || wetness > TrackWetness.ExtremelyWet) {
    return null;
  }

  // iRacing `DisplayUnits`: 0 = English (imperial), 1 = Metric. Undefined
  // (telemetry field absent) defaults to metric.
  const metric = telemetry.DisplayUnits !== 0;
  const pitSpeedLimitMps = resolvePitSpeedLimit(instance, sessionInfo, telemetry);
  const trackTempC = telemetry.TrackTempCrew ?? 0;
  const airTempC = telemetry.AirTemp ?? 0;
  const toDisplayTemp = (celsius: number): number => Math.round(metric ? celsius : celsius * 1.8 + 32);

  return {
    sessionType: classifySessionType(resolveSessionType(sessionInfo, telemetry)),
    pitSpeedLimit: Math.round(pitSpeedLimitMps * (metric ? 3.6 : 2.236936)),
    speedUnit: metric ? "kmh" : "mph",
    trackTemp: toDisplayTemp(trackTempC),
    airTemp: toDisplayTemp(airTempC),
    tempUnit: metric ? "celsius" : "fahrenheit",
    wetness: wetness as TrackWetness,
  };
}

/**
 * Build the race-start conditions snapshot from the latest telemetry tick +
 * session info (issue #568). Returns `null` when telemetry or session info is
 * unavailable, or when track wetness is still `Unknown` — the race-start
 * scenario treats null as "skip the callout" rather than speaking a nonsense
 * line.
 *
 * Differs from {@link getSessionStartConditions} in three ways:
 *   - Pit speed limit is **not** read. Race start doesn't speak the limit.
 *   - `sessionType` is not returned — the scenario's `where:` already gates on
 *     `classifySessionType(getSessionType()) === "race"` so the conditions
 *     contract for this readout is fixed.
 *   - Adds `playerCarPosition` — the **starting grid position**. Sourced from
 *     `sessionInfo.QualifyResultsInfo.Results` (the qualifying results, which
 *     are populated even in race-only events: iRacing seeds them from iRating
 *     in that case). Reported `undefined` if the qualify-results lookup
 *     misses; the scenario then skips the position clause and speaks the
 *     greeting + conditions only. We deliberately do NOT use
 *     `telemetry.PlayerCarPosition` here because that field reads `0` in the
 *     garage / pre-grid window — it's a live-standings reading, not a grid
 *     position.
 *
 * Read at fire time (same deferred-snapshot rationale as
 * {@link getReadbackSnapshot}).
 */
export function getRaceStartConditions(): RaceStartConditions | null {
  if (!instance || !instance.latestTelemetry) return null;

  const telemetry = instance.latestTelemetry;
  const sessionInfo = instance.controller.getSessionInfo() as Record<string, unknown> | null;

  if (!sessionInfo) return null;

  const wetness = telemetry.TrackWetness;

  if (typeof wetness !== "number" || wetness < TrackWetness.Dry || wetness > TrackWetness.ExtremelyWet) {
    return null;
  }

  // iRacing `DisplayUnits`: 0 = English (imperial), 1 = Metric. Undefined
  // (telemetry field absent) defaults to metric.
  const metric = telemetry.DisplayUnits !== 0;
  const trackTempC = telemetry.TrackTempCrew ?? 0;
  const airTempC = telemetry.AirTemp ?? 0;
  const toDisplayTemp = (celsius: number): number => Math.round(metric ? celsius : celsius * 1.8 + 32);
  const playerCarPosition = resolveStartingGridPosition(sessionInfo);

  return {
    trackTemp: toDisplayTemp(trackTempC),
    airTemp: toDisplayTemp(airTempC),
    tempUnit: metric ? "celsius" : "fahrenheit",
    wetness: wetness as TrackWetness,
    playerCarPosition,
  };
}

/**
 * Look up the player's **starting grid position** from session info (issue
 * #568, made class-aware in #599). Reads
 * `sessionInfo.QualifyResultsInfo.Results[player].Position`, matched by
 * `CarIdx` against `DriverInfo.DriverCarIdx`. iRacing populates this even for
 * race-only events (seeded from iRating in that case), so it's the right field
 * for the race-start brief — unlike `PlayerCarPosition` / `CarIdxPosition`,
 * which both read `0` in the garage / pre-grid window because they're
 * live-standings fields.
 *
 * Returns the **effective** grid slot: the player's **class** grid slot in a
 * multi-class race, the overall qualifying slot otherwise. In multi-class a
 * driver cares about their position within their own class, not their overall
 * rank among faster/slower classes — consistent with the class-aware overtake
 * detection (#588) and the "we're currently P[n]" readout. Both consumers (the
 * race-start callout and the overtake baseline seed in `diffOvertakes`) read
 * this one function so they stay aligned by construction. See
 * {@link resolveStartingClassPosition} for how the class slot is computed.
 *
 * The raw `Position` value is **0-indexed** (pole sitter reads `0`), matching
 * the `ResultsPositions.ClassPosition` convention elsewhere in iRacing's
 * session YAML. We convert to 1-indexed here so the value is directly usable
 * by the audio scenarios (which speak "P 1" / "P 2" / …) and the
 * {@link RaceStartConditions} contract is 1-indexed.
 *
 * Returns `undefined` when any step misses (no session info, no driver info,
 * no qualify results, no entry for the player) or when `Position` is negative
 * (iRacing's "no result" sentinel) — the scenario then skips the position
 * clause.
 *
 * @internal Exported for testing.
 */
function resolveStartingGridPosition(sessionInfo: Record<string, unknown>): number | undefined {
  const slots = resolveStartingGridSlots(sessionInfo);

  if (!slots) return undefined;

  // Single-class (or undeterminable): the overall qualifying slot IS the grid
  // slot. Multi-class (issue #599): report the CLASS grid slot.
  return resolveIsMultiClass(sessionInfo) !== true ? slots.overall : slots.class;
}

/**
 * Compute BOTH the overall and class starting-grid slots (1-indexed) from the
 * qualifying results, in one lookup. {@link resolveStartingGridPosition} picks
 * the effective one for the race-start callout / overtake baseline; the Session
 * Info position display ({@link getStartingGridPosition}) needs both because
 * the user can show either overall or class. The class slot falls back to the
 * overall slot when the player's class can't be resolved (issue #599).
 *
 * Returns `undefined` when any step misses (no driver info, no qualify results,
 * no entry for the player, or a negative `Position` sentinel).
 *
 * @internal Exported for testing.
 */
function resolveStartingGridSlots(
  sessionInfo: Record<string, unknown>,
): { overall: number; class: number } | undefined {
  const driverInfo = sessionInfo.DriverInfo as Record<string, unknown> | undefined;
  const playerCarIdx = driverInfo?.DriverCarIdx;

  if (typeof playerCarIdx !== "number" || playerCarIdx < 0) return undefined;

  const qualifyInfo = sessionInfo.QualifyResultsInfo as Record<string, unknown> | undefined;
  const results = qualifyInfo?.Results as Array<Record<string, unknown>> | undefined;

  if (!Array.isArray(results)) return undefined;

  const entry = results.find((r) => r.CarIdx === playerCarIdx);

  if (!entry) return undefined;

  const position = entry.Position;

  if (typeof position !== "number" || position < 0) return undefined;

  const overall = position + 1; // 1-indexed
  const klass = resolveStartingClassPosition(sessionInfo, results, playerCarIdx, position) ?? overall;

  return { overall, class: klass };
}

/**
 * Compute the player's **class** starting grid slot from the qualifying results
 * (issue #599). The session YAML has no direct class-grid field, so count the
 * same-class entries that qualified ahead of the player (a lower overall
 * `Position`) and add one. Build a `CarIdx → CarClassID` map from
 * `DriverInfo.Drivers` to classify each qualifying entry (whose own records
 * carry only `CarIdx` + overall `Position`).
 *
 * `playerPosition` is the player's raw (0-indexed) overall qualifying position,
 * already validated by the caller; the returned value is 1-indexed. Returns
 * `undefined` when the player's own class can't be resolved (no
 * `DriverInfo.Drivers` entry for the player) so the caller falls back to the
 * overall slot.
 *
 * @internal
 */
function resolveStartingClassPosition(
  sessionInfo: Record<string, unknown>,
  results: Array<Record<string, unknown>>,
  playerCarIdx: number,
  playerPosition: number,
): number | undefined {
  const driverInfo = sessionInfo.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as Array<Record<string, unknown>> | undefined;

  if (!Array.isArray(drivers)) return undefined;

  const classByCarIdx = new Map<number, number>();

  for (const driver of drivers) {
    if (typeof driver.CarIdx === "number" && typeof driver.CarClassID === "number") {
      classByCarIdx.set(driver.CarIdx, driver.CarClassID);
    }
  }

  const playerClassId = classByCarIdx.get(playerCarIdx);

  if (playerClassId === undefined) return undefined;

  let ahead = 0;

  for (const r of results) {
    if (typeof r.CarIdx !== "number" || typeof r.Position !== "number") continue;

    // Skip the player and anyone behind (positions are unique, so `>=` excludes
    // the player's own entry); negative is iRacing's no-result sentinel.
    if (r.Position < 0 || r.Position >= playerPosition) continue;

    if (classByCarIdx.get(r.CarIdx) === playerClassId) ahead++;
  }

  return ahead + 1;
}

/**
 * Build the qualifying lap-invalidation snapshot from the latest telemetry
 * tick (issue #567). Returns `null` when telemetry isn't available — the
 * scenario's `where:` short-circuits and the callout stays silent.
 *
 * Adjustments applied here (vs raw telemetry):
 *   - `lapsRemaining` = `SessionLapsRemainEx - 1` (clamped to 0). iRacing
 *     counts the lap the driver is currently on as "remaining"; the
 *     snapshot's contract is "attempts remaining AFTER the current
 *     invalidated lap", so we subtract one before handing it off.
 *   - `lapLimited` = `0 < SessionLapsTotal < IRSDK_UNLIMITED_LAPS` —
 *     distinguishes a lap-limited qualifying from a time-limited one
 *     (sentinel 32767).
 *   - `lapStartedFromPits` = the translator-state flag maintained by the
 *     pit-lane diff (set true on `pitLane.exited`) and the lifecycle diff
 *     (cleared on `lap.started`). Covers both the session out-lap and any
 *     mid-session post-pit-exit lap.
 *   - `lapCounted` (issue #776) = whether the current lap is still a counted
 *     attempt. In a lap-limited qualifying the driver commonly keeps
 *     circulating after the counted laps are done; there `SessionLapsRemainEx`
 *     reads 0 — a value the `lapsRemaining` clamp collapses into the same `0`
 *     the final counted lap (raw 1) reports. This flag preserves the
 *     distinction: `false` only when the session is lap-limited AND the raw
 *     reading says not even the current lap remains. Time-limited sessions
 *     and a missing reading report `true` (don't punish missing data).
 *
 * Read at fire time (same deferred-snapshot rationale as
 * {@link getReadbackSnapshot}) so a callout that gets queued behind another
 * scenario still speaks the live snapshot when it eventually fires.
 */
export function getQualifyingInvalidationSnapshot(): QualifyingInvalidationSnapshot | null {
  if (!instance || !instance.latestTelemetry) return null;

  const telemetry = instance.latestTelemetry;
  const sessionInfo = instance.controller.getSessionInfo() as Record<string, unknown> | null;
  const lapsTotal = telemetry.SessionLapsTotal ?? 0;
  const lapLimited = lapsTotal > 0 && lapsTotal < IRSDK_UNLIMITED_LAPS;
  const rawLapsRemaining =
    typeof telemetry.SessionLapsRemainEx === "number" && telemetry.SessionLapsRemainEx >= 0
      ? telemetry.SessionLapsRemainEx
      : undefined;

  return {
    sessionType: classifyLapSessionType(resolveSessionType(sessionInfo, telemetry)),
    sessionNum: typeof telemetry.SessionNum === "number" ? telemetry.SessionNum : undefined,
    lapsRemaining: rawLapsRemaining !== undefined ? Math.max(0, rawLapsRemaining - 1) : undefined,
    lapLimited,
    lapCompleted: typeof telemetry.LapCompleted === "number" ? telemetry.LapCompleted : 0,
    lapStartedFromPits: instance.state.lapStartedFromPits,
    lapCounted: !lapLimited || rawLapsRemaining === undefined || rawLapsRemaining > 0,
  };
}

/**
 * Player's CURRENT race position read from live telemetry (issue #574). Unlike
 * the standings-first {@link PlayerResultsSnapshot} used by `lap.completed`,
 * this is computed from the live `CarIdxLapDistPct` order via
 * `calculateFrozenRacePositions` so it reflects the position at the exact moment
 * the caller asks — not a value frozen at the last S/F crossing. A finished car
 * that has left the world is kept at its finishing rank (issue #603) so the
 * spoken overall position doesn't climb as leaders peel into the garage. Used by
 * the "We're currently P[n]" voice readouts (overtake, race position-change,
 * race-status) so the spoken position is accurate to speak-time even when the
 * scenario plays seconds after the triggering event.
 *
 * Returns `null` when telemetry / session info / player car index isn't
 * resolvable, or the computed overall position is 0 (inactive) — callers treat
 * null as "can't read position right now" and stay silent.
 */
export type LivePosition = {
  /** Live overall race position (1-based) from the calculated order. */
  position: number;
  /**
   * Live class position (1-based) derived from the same frozen overall order as
   * {@link position} — the count of same-class cars (`CarIdxClass`) ranked ahead,
   * +1 (see `classPositionFromOrder`). Falls back to the iRacing-authoritative
   * `PlayerCarClassPosition` when the order-based value can't be derived (no
   * `CarIdxClass`). `0` when unavailable. Updates continuously, not only at S/F.
   */
  classPosition: number;
  /** Whether the session has more than one car class on track. */
  isMultiClass: boolean;
};

export function getLivePosition(): LivePosition | null {
  if (!instance || !instance.latestTelemetry) return null;

  const telemetry = instance.latestTelemetry;
  const sessionInfo = instance.controller.getSessionInfo() as Record<string, unknown> | null;
  const playerCarIdx = resolvePlayerCarIdx(sessionInfo);

  if (playerCarIdx < 0) return null;

  // Frozen positions (issue #603): finished cars that left the world stay
  // counted at their finishing rank, so the spoken overall position is correct
  // and stable while leaders peel into the garage.
  const positions = calculateFrozenRacePositions(instance.state, telemetry);
  const position = positions[playerCarIdx] ?? 0;

  if (position <= 0) return null;

  // Class position is derived from the SAME frozen order (count same-class cars
  // ahead), so it updates continuously like the overall position instead of only
  // at the start/finish line. Falls back to iRacing's official
  // `PlayerCarClassPosition` when `CarIdxClass` isn't available to derive from.
  const derivedClassPosition = classPositionFromOrder(positions, telemetry.CarIdxClass, playerCarIdx);
  const classPosition =
    derivedClassPosition > 0
      ? derivedClassPosition
      : typeof telemetry.PlayerCarClassPosition === "number" && telemetry.PlayerCarClassPosition > 0
        ? telemetry.PlayerCarClassPosition
        : 0;

  return { position, classPosition, isMultiClass: resolveIsMultiClass(sessionInfo) === true };
}

/**
 * The LIVE per-car race order — 1-based overall positions indexed by carIdx
 * (`0` for cars not in the order). This is the same frozen calculation that
 * backs {@link getLivePosition} (towed / finished / left-world cars keep their
 * rank instead of churning the order — issues #574, #603), but exposed for the
 * WHOLE field so callers that need an arbitrary car's live position can index
 * it directly — e.g. the Telemetry Display / Chat / Race Admin template prefixes
 * (`self`, `track_ahead/behind`, `race_ahead/behind`, `focused`), which would
 * otherwise see only iRacing's start/finish-line-frozen `CarIdxPosition`.
 *
 * Returns `null` when telemetry isn't resolvable yet. The array is meaningful
 * for race sessions; callers gate non-race sessions themselves (where the
 * lap-progress order isn't the standings).
 *
 * Note: during replay, `handleTick` returns at the replay guard before
 * `updatePositionTracking` runs, so the frozen-anchor state isn't maintained and
 * this falls back to the plain lap-progress order (no tow/finish freezing). That
 * is by design — a scrubbing/rewinding replay timeline breaks the forward-motion
 * assumption the freezing relies on, so there's no correct order to reconstruct.
 */
export function getLiveRacePositions(): number[] | null {
  if (!instance || !instance.latestTelemetry) return null;

  return calculateFrozenRacePositions(instance.state, instance.latestTelemetry);
}

/** Live gap snapshot for one class-standings neighbor (issue #933). */
export type GapNeighbor = {
  /** The neighbor's car index. */
  carIdx: number;
  /** Crossing-time gap in seconds; null while the traces can't cover the lookup. */
  gapSeconds: number | null;
  /** Whole laps the pair is apart (0 = same racing lap). */
  lapDelta: number;
  /** Continuous display trend ("closing" | "opening" | "steady"), null without data. */
  trend: GapTrendDirection | null;
};

/** Live gaps to the class-standings neighbors (issue #933). */
export type LiveGaps = { ahead: GapNeighbor | null; behind: GapNeighbor | null };

/**
 * Live crossing-time gaps to the cars one class position ahead and behind
 * (issue #933). `null` when unavailable (not initialized, no telemetry, not
 * a race session / pre-green). A side is `null` when there is no such
 * neighbor; a side's `gapSeconds` is `null` while the traces can't cover the
 * lookup (cold start) or the neighbor is a lap or more away (`lapDelta` then
 * carries the count).
 */
export function getLiveGaps(): LiveGaps | null {
  if (!instance || !instance.latestTelemetry) return null;

  if (!instance.state.gapLiveAhead && !instance.state.gapLiveBehind) return null;

  return { ahead: instance.state.gapLiveAhead, behind: instance.state.gapLiveBehind };
}

/**
 * Crossing-time gap in seconds between any two cars (issue #933): how long
 * ago `aheadCarIdx` crossed `behindCarIdx`'s current track position. The
 * reusable primitive behind future consumers ("we're N seconds behind the
 * leader") — resolve the target from the canonical order
 * (`getLiveRacePositions()`), then call this. `null` when the traces don't
 * cover the lookup or either car has no live progress.
 */
export function getLiveGapBetween(aheadCarIdx: number, behindCarIdx: number): number | null {
  if (!instance || !instance.latestTelemetry) return null;

  const telemetry = instance.latestTelemetry;
  const lapCompleted = telemetry.CarIdxLapCompleted as number[] | undefined;
  const lapDistPct = telemetry.CarIdxLapDistPct as number[] | undefined;
  const sessionTime = typeof telemetry.SessionTime === "number" ? telemetry.SessionTime : null;

  if (!Array.isArray(lapCompleted) || !Array.isArray(lapDistPct) || sessionTime === null) return null;

  const behindLc = lapCompleted[behindCarIdx];
  const behindPct = lapDistPct[behindCarIdx];

  if (typeof behindLc !== "number" || behindLc < 0 || typeof behindPct !== "number" || behindPct < 0) return null;

  const trace = instance.state.gapTraces[aheadCarIdx];

  if (!trace) return null;

  const crossed = crossingTimeAt(trace, behindLc + behindPct);

  return crossed === null ? null : Math.max(0, sessionTime - crossed);
}

/**
 * Whether the player currently LEADS the race per the canonical live order
 * (issue #771 — the winner grace on the checkered deferral). Consumes the
 * same frozen calculation as {@link getLivePosition} per
 * `.claude/rules/race-positions.md`; the official `PlayerCarPosition` is the
 * fallback only when the player's slot can't be read from the live order
 * (no car index yet / not classified).
 */
function resolvePlayerIsLeader(self: TranslatorInstance, telemetry: TelemetryData, playerCarIdx: number): boolean {
  if (playerCarIdx >= 0) {
    const positions = calculateFrozenRacePositions(self.state, telemetry);
    const position = positions[playerCarIdx] ?? 0;

    if (position > 0) return position === 1;
  }

  return telemetry.PlayerCarPosition === 1;
}

/**
 * The race leader's recent lap time (s) for the timed-race fuel-coverage
 * estimate (issue #880), or `null` when unknown. The leader comes from the
 * canonical live order (per `.claude/rules/race-positions.md`) — `positions`
 * is the tick's already-computed `calculateFrozenRacePositions` result
 * (threaded from `handleTick` like `diffOvertakes`', so a second call site
 * can't diverge from the canonical per-tick order) — and the OVERALL leader
 * deliberately, since their clock expiry plus final crossing is what ends a
 * timed race for every class. Pace preference: `CarIdxLastLapTime` (tracks a
 * slowing leader — e.g. under caution — better than the session best)
 * falling back to `CarIdxBestLapTime`; a `null` return lets the fuel diff
 * fall back to the player's own validated average.
 */
function resolveLeaderLapTimeS(telemetry: TelemetryData, positions: number[]): number | null {
  const leaderIdx = positions.findIndex((position) => position === 1);

  if (leaderIdx < 0) return null;

  const last = telemetry.CarIdxLastLapTime?.[leaderIdx];

  if (typeof last === "number" && Number.isFinite(last) && last > 0) return last;

  const best = telemetry.CarIdxBestLapTime?.[leaderIdx];

  if (typeof best === "number" && Number.isFinite(best) && best > 0) return best;

  return null;
}

/**
 * Player's STARTING GRID position (overall + class, both 1-based) from the
 * qualifying results — the source the race-start callout already uses
 * ({@link resolveStartingGridPosition}). Exposed for the Session Info position
 * display so it can show the qualifying grid slot before the green flag (issue
 * #647): pre-green, neither the live calculated order nor iRacing's
 * live-standings `PlayerCarPosition` is usable (a rolling-start formation lap
 * reads `0` for the whole field until cars cross start/finish), but
 * `QualifyResultsInfo` is populated the moment the grid is set.
 *
 * Returns `null` when the translator isn't initialized, session info isn't
 * available, or the grid slot can't be resolved (no qualify results / no entry
 * for the player) — the caller then falls back to live-standings telemetry.
 */
export function getStartingGridPosition(): { overall: number; class: number } | null {
  if (!instance) return null;

  const sessionInfo = instance.controller.getSessionInfo() as Record<string, unknown> | null;

  if (!sessionInfo) return null;

  return resolveStartingGridSlots(sessionInfo) ?? null;
}

/**
 * Telemetry-derived gating signals for the overtake callouts (issue #574
 * follow-up). All read from the latest tick so the gate reflects the moment
 * the overtake scenario evaluates its `where:`. The plugin combines this with
 * an incident timestamp (tracked off the bus) to form the full overtake gate.
 *
 * Returns `null` when telemetry isn't available — the scenario treats null as
 * "can't verify it's a clean racing moment" and stays silent.
 */
export type OvertakeTelemetryGate = {
  /** A car is immediately alongside (radar state is not "clear"). */
  carsAlongside: boolean;
  /** The player is genuinely on the racing surface (not off-track / pits / tow). */
  onTrack: boolean;
  /** Current speed in km/h. */
  speedKmh: number;
  /** The player is on pit road. */
  onPitRoad: boolean;
};

export function getOvertakeTelemetryGate(): OvertakeTelemetryGate | null {
  if (!instance || !instance.latestTelemetry) return null;

  const telemetry = instance.latestTelemetry;

  return {
    carsAlongside: resolveRadarState(telemetry.CarLeftRight ?? CarLeftRight.Off) !== "clear",
    onTrack: telemetry.PlayerTrackSurface === TrkLoc.OnTrack,
    speedKmh: (telemetry.Speed ?? 0) * 3.6,
    onPitRoad: telemetry.OnPitRoad === true,
  };
}

/**
 * Reset the translator singleton.
 * @internal Exported for test isolation only.
 */
export function _resetSimEventsIracing(): void {
  if (instance) {
    try {
      instance.controller.unsubscribe(SUBSCRIPTION_ID);
    } catch {
      // Ignore — controller may be in a weird state in tests.
    }
  }

  instance = null;
}

// ── Internals ──────────────────────────────────────────────────────────────

function handleDisconnect(self: TranslatorInstance): void {
  // Publish a teardown signal for any active state that would otherwise
  // leave downstream consumers stuck in an active mode. Today that's just
  // radar (its tick loop keeps running until it sees a `radar.changed → clear`
  // transition); other active-state subsystems should plug in here the
  // same way. We publish via the live envelope shape so consumers don't
  // need a separate disconnect code path.
  if (self.state.radarState !== "clear" && self.latestTelemetry !== null) {
    publish(
      self,
      { event: "radar.changed", data: { from: self.state.radarState, to: "clear" } },
      self.latestTelemetry,
      Date.now(),
    );
  }

  // Fresh state so reconnect seeds cleanly.
  self.state = createInitialState();
  self.latestTelemetry = null;
  self.pitSpeedLimitMps = 0;
  self.pitSpeedLimitKey = "";
  self.lastObservedSessionNum = null;
  // `driver.firstOnTrack` seeding is reset only here (not on session change)
  // so a mid-drive reconnect seeds silently and doesn't synthesize a welcome.
  // Session-change resets clear only `firstOnTrackFired` — see
  // `resetPerSessionState`.
  self.firstOnTrackSeeded = false;
  self.firstOnTrackFired = false;
  // Re-arm the fresh-connect session.changed synthesis so a reconnect into a
  // session re-checks the SessionState gate (issues #568, #668). The replay
  // skip log marker re-arms with it — a reconnect is a new episode (#908).
  self.freshConnectFireChecked = false;
  self.freshConnectReplaySkipLogged = false;
  // The fuel lap history survives replays and session changes, but a
  // disconnect means the sim is gone — reset it fully so a later reconnect
  // seeds cleanly (issue #465).
  self.fuelLaps = createFuelLapTracker();
}

/**
 * Wipe per-session state on a `SessionNum` change (issue #564). The Race
 * Engineer's "everything is in session context" model: practice, qualifying,
 * and race each get a fresh slate for callouts that should fire once per
 * session (session-start, fuel thresholds, incident counters, …).
 *
 * Publishes a `radar.changed → clear` teardown before wiping state — mirrors
 * `handleDisconnect`. Without it, a downstream radar audio engine latched on
 * the prior session's "left" / "right" beep would stay latched: the post-
 * wipe `state.radarState` is already `"clear"`, so the replay guard's
 * teardown check would see no edge and skip the emit, leaving the engine
 * mid-loop indefinitely. Any future active-state subsystem with a similar
 * latch contract plugs in here the same way.
 *
 * The lifecycle diff's baselines (`lifecycleInitialized`, `lastSessionNum`,
 * `lastEngineRunning`, `lastLap`) are preserved across the wipe. Without
 * that, the reset would put `lifecycleInitialized = false`, the next
 * `diffLifecycle` call this same tick would silently re-seed
 * `lastEngineRunning` against the still-running engine and synthesize a
 * spurious `engine.startup`. `session.changed` is published directly from
 * `handleTick` (it can't rely on `state` surviving the replay-mode wipe), but
 * we still preserve `lastSessionNum` here so handleTick can use it as a
 * dedup signal on non-replay session-change ticks.
 *
 * `firstOnTrackSeeded` stays `true`; only `firstOnTrackFired` clears. Re-
 * seeding would silently mark fired = true if the driver is already on track
 * at the transition and swallow the very fire we want.
 *
 * Track-level instance fields (`pitSpeedLimitMps` / `pitSpeedLimitKey`) self-
 * invalidate via `resolvePitSpeedLimit`'s `${TrackID}|${SessionNum}` cache key
 * and need no reset here.
 */
/**
 * Wipe `TranslatorState` for a replay-mode transition (both edges — entering
 * and leaving replay), preserving the checkered-deferral cluster (issue
 * #771) and the standing-start countdown cluster (issue #829): a checkered
 * held for the player's S/F crossing must survive a replay glance
 * mid-deferral, or the callout is silently lost — the flag diff's post-wipe
 * re-seed sees the `Checkered` bit already set and never re-emits — and the
 * pre-guard countdown keeps counting through garage/replay views, so a wipe
 * would re-seed its ceiling lower and drop a mark at the flip boundary. The
 * flag seed deliberately leaves these fields alone. A genuine session change
 * still clears them (`resetPerSessionState` wipes without preservation), so
 * neither cluster can leak into the next session.
 */
function wipeStateForReplay(self: TranslatorInstance): void {
  const preservedAcrossReplay = {
    checkeredPendingCross: self.state.checkeredPendingCross,
    flagLastCrossedAt: self.state.flagLastCrossedAt,
    // The white two-stage latch + raise timestamp (issue #772): a replay
    // glance during the last lap must not replay the last-lap line (latch)
    // nor drop the heads-up gap guard (timestamp). The sticky final-lap
    // marker (issue #880) rides along — losing it at a replay flip would
    // re-open the fuel family's final-lap suppression mid-final-lap.
    whiteLastLapFired: self.state.whiteLastLapFired,
    playerFinalLapStarted: self.state.playerFinalLapStarted,
    whiteRaisedAt: self.state.whiteRaisedAt,
    // The standing-start countdown cluster (issue #829): the countdown runs
    // PRE-guard and keeps counting while the user sits in the garage (a
    // replay-mode view), so both replay edges must leave it alone — a
    // re-seed at the flip would lower the ceiling and silently drop a mark
    // right at the boundary. The countdown's own window-exit reset (and
    // `resetPerSessionState`) still clears it at the real end of the window.
    startCountdownCeiling: self.state.startCountdownCeiling,
    startCountdownFired: self.state.startCountdownFired,
    startCountdownObserved: self.state.startCountdownObserved,
    // The laps-of-fuel-left announce state (issue #838): a replay glance
    // mid-race must not re-announce a count already spoken this stint, and
    // the previous-fuel-level tracker must survive the garage visit so the
    // refuel that happened there (replay-mode ticks) lands as one positive
    // delta on the first live tick back and re-arms the stint. The sampling
    // baselines (`fuelCalloutLastDistPct` / `fuelCalloutLastSampledLap`)
    // deliberately re-seed — the position jump made their edges meaningless.
    fuelCalloutLastFuelLevel: self.state.fuelCalloutLastFuelLevel,
    fuelCalloutLastAnnouncedCount: self.state.fuelCalloutLastAnnouncedCount,
    // The enough-fuel reassurance latch (issue #880) is preserved with the
    // floor: a replay glance must not let the reassurance speak twice.
    fuelCalloutRaceCoveredAnnounced: self.state.fuelCalloutRaceCoveredAnnounced,
  };

  self.state = createInitialState();
  Object.assign(self.state, preservedAcrossReplay);
}

function resetPerSessionState(self: TranslatorInstance, telemetry: TelemetryData): void {
  if (self.state.radarState !== "clear") {
    publish(
      self,
      { event: "radar.changed", data: { from: self.state.radarState, to: "clear" } },
      telemetry,
      Date.now(),
    );
  }

  const preservedLifecycle = {
    lifecycleInitialized: self.state.lifecycleInitialized,
    lastSessionNum: self.state.lastSessionNum,
    lastEngineRunning: self.state.lastEngineRunning,
    lastLap: self.state.lastLap,
  };

  self.state = createInitialState();
  Object.assign(self.state, preservedLifecycle);

  self.firstOnTrackFired = false;

  // Fuel lap history (issue #465): don't wipe here — the previous session's
  // consumption stays readable while the driver sits in the garage planning
  // fuel. `diffFuelLaps` executes the wipe on the first live-in-car tick of
  // the new session.
  self.fuelLaps.pendingSessionWipe = true;
}

/**
 * `driver.firstOnTrack` detection — issue #542.
 *
 * Runs on EVERY tick, including replay-mode ticks, BEFORE the replay guard
 * in `handleTick`. "Live on track" is `IsOnTrack && !IsReplayPlaying` — true
 * only when the driver is genuinely in the car, not watching a replay or
 * sitting in the session menu (where iRacing reports `IsReplayPlaying: true`
 * and `IsOnTrack: false`).
 *
 * The first tick after connect seeds `firstOnTrackFired` to the current
 * live-on-track value: a plugin that connects mid-drive seeds `true` and
 * stays silent (not the driver's first on-track moment), while a connect in
 * the garage / replay seeds `false` and fires on the genuine transition.
 * Tracking lives on the instance (not `TranslatorState`) so the replay
 * guard's per-tick resets can't re-run the seed and swallow the event.
 */
function diffFirstOnTrack(self: TranslatorInstance, telemetry: TelemetryData): void {
  const liveOnTrack = (telemetry.IsOnTrack ?? false) && telemetry.IsReplayPlaying !== true;

  if (!self.firstOnTrackSeeded) {
    self.firstOnTrackSeeded = true;
    self.firstOnTrackFired = liveOnTrack;

    return;
  }

  if (!self.firstOnTrackFired && liveOnTrack) {
    self.firstOnTrackFired = true;
    publish(self, { event: "driver.firstOnTrack", data: {} }, telemetry, Date.now());
  }
}

function handleTick(self: TranslatorInstance, telemetry: TelemetryData): void {
  // Session-change detection + reset (issues #564, #568). Runs on every tick
  // — including replay ticks — because iRacing's between-session transition
  // commonly passes through replay-mode ticks (waiting for the next session
  // to load). Using the instance-level `lastObservedSessionNum` (not
  // `state.lastSessionNum`) means the tracker survives the replay guard's
  // per-tick state wipes that would otherwise null out the comparison
  // baseline and let the transition slip past. The reset wipes `state` and
  // clears `firstOnTrackFired` so the `driver.firstOnTrack` event (reserved
  // for the not-yet-registered welcome scenario) re-fires on the next
  // live-on-track tick. `session.changed` is published from here
  // directly (not via diffLifecycle's `emit` aggregator) so the event reaches
  // subscribers even when the replay state wipe later this tick destroys
  // `state.lastSessionNum` — the race-start callout (issue #568) depends on
  // this.
  //
  // Issue #604: both pre-guard `session.changed` paths (the fresh-connect
  // synthesis below and the SessionNum-delta block after it) are
  // additionally gated on `!isReplayOnlySession(sessionInfo)`. The
  // discriminator is iRacing's own `WeekendInfo.SimMode` — `"replay"` while
  // the user is in the replay UI, `"full"` while live. It does NOT flip
  // during the brief `IsReplayPlaying` flicker between live sessions, so the
  // #568 path is preserved while replay-only scrubbing / standalone replay
  // viewing stays silent.
  const currentSessionNum = telemetry.SessionNum ?? null;

  // Issue #908: a non-replay-only tick ends the replay episode for the skip
  // log in the fresh-connect gate below, so a later replay episode logs
  // again. Checked ahead of the gate — a tick without SessionNum never
  // enters it but still ends the episode — and only while the marker is
  // set, so the session-info read isn't added to every tick.
  if (
    self.freshConnectReplaySkipLogged &&
    !isReplayOnlySession(self.controller.getSessionInfo() as Record<string, unknown> | null)
  ) {
    self.freshConnectReplaySkipLogged = false;
  }

  // Fresh-connect session.changed synthesis (issues #568, #668). On the first
  // tick after connect (or reconnect) that satisfies the gating conditions,
  // synthesize a `session.changed { from: -1, to: SessionNum }` so the
  // callouts keyed off `session.changed` fire when the plugin lands directly
  // in a session (no prior session to drive a real delta). Two consumers with
  // different SessionState gates by classified session type:
  //   - race (#568): fire pre-green only (GetInCar/Warmup/ParadeLaps). A race
  //     at/after green is a mid-race reconnect — too late to brief the grid,
  //     so we latch silently.
  //   - practice/qualifying (#668): fire pre-green OR during green (Racing).
  //     These sessions sit in `Racing` their entire green period and
  //     connecting mid-session is the normal case (e.g. a lone-qualify driver
  //     in the garage) — the conditions brief is exactly what the driver wants
  //     on connect. A non-race session winding down (Checkered/CoolDown) makes
  //     the brief pointless, so we latch silently there.
  // Resolution latches the check — `SessionState.Invalid` (telemetry still
  // settling) keeps it open. Runs BEFORE the delta check below so the latch is
  // set before a real delta could trigger on a later tick.
  if (!self.freshConnectFireChecked && currentSessionNum !== null) {
    const sessionInfo = self.controller.getSessionInfo() as Record<string, unknown> | null;

    // Issue #604: skip the synthesis (and don't latch) while the user is
    // watching a replay. The session YAML's `SimMode` distinguishes replay
    // viewing from a live session that's transiently in replay mode during
    // a qual → race transition — see `isReplayOnlySession`. Without this,
    // connecting while a saved race replay is open synthesizes a
    // session.changed { from: -1, to: N } and the briefing callout briefs a
    // session the user isn't actually in.
    if (isReplayOnlySession(sessionInfo)) {
      // Don't latch — a later live tick (e.g. user exits the replay UI) re-
      // evaluates and can still fire the synthesis. Log once per replay
      // episode, not per evaluated tick (issue #908) — the held replay state
      // is not an event.
      if (!self.freshConnectReplaySkipLogged) {
        self.freshConnectReplaySkipLogged = true;
        self.logger.info(
          `Fresh-connect session.changed: skipped (replay-only session, SessionNum=${currentSessionNum})`,
        );
      }
    } else {
      // Capture the RAW session type first. `classifySessionType("")` returns
      // "race" (its safe default), so classifying before the session YAML has
      // loaded would misread a not-yet-known session as race and could fire a
      // false synthetic session.changed. Only classify once the raw value is
      // non-empty; an empty raw value keeps the latch open (same as
      // SessionState.Invalid) so we wait for session info to settle.
      const rawSessionType = resolveSessionType(sessionInfo, telemetry);
      const sessionType = rawSessionType ? classifySessionType(rawSessionType) : undefined;
      const rawState = typeof telemetry.SessionState === "number" ? telemetry.SessionState : SessionState.Invalid;
      const isPreGreen =
        rawState === SessionState.GetInCar || rawState === SessionState.Warmup || rawState === SessionState.ParadeLaps;
      const isRacing = rawState === SessionState.Racing;
      const isWindingDown = rawState === SessionState.Checkered || rawState === SessionState.CoolDown;

      // Race sessions fire pre-green only; practice/qualifying also fire during
      // green (Racing) because that's their normal connect-in state.
      const shouldFire = sessionType !== undefined && (isPreGreen || (sessionType !== "race" && isRacing));
      // Disqualifying states that latch the check silently: a race mid-session
      // reconnect (race + Racing), or any session winding down (Checkered/
      // CoolDown) where briefing is pointless regardless of session type.
      const isTooLate = (sessionType === "race" && isRacing) || isWindingDown;

      if (sessionType === undefined) {
        // Raw session type not known yet (session YAML still loading). Keep the
        // latch open — don't classify or fire until we have a real value.
      } else if (shouldFire) {
        self.logger.info(
          `Fresh-connect session.changed: firing synthetic (sessionType="${sessionType}", SessionNum=${currentSessionNum}, SessionState=${rawState})`,
        );
        publish(self, { event: "session.changed", data: { from: -1, to: currentSessionNum } }, telemetry, Date.now());
        self.freshConnectFireChecked = true;
      } else if (isTooLate) {
        // Too late to brief: race mid-session reconnect, or a non-race session
        // winding down. Latch silently.
        self.logger.info(
          `Fresh-connect session.changed: skipped (too late to brief, sessionType="${sessionType}", SessionState=${rawState}, SessionNum=${currentSessionNum})`,
        );
        self.freshConnectFireChecked = true;
      }
      // SessionState.Invalid (or any unknown value): keep waiting. Telemetry
      // may still be settling on the first ticks after connect.
    }
  }

  // Issue #604: any update that touches the SessionNum delta path must check
  // for replay-only first. When the user scrubs across a session boundary in
  // the replay UI, `currentSessionNum` flips to the scrubbed-to value — we
  // must NOT publish session.changed (that would brief a race they're not in)
  // AND we must NOT advance `lastObservedSessionNum` (otherwise exiting back
  // to live would emit a phantom session.changed measured against the
  // scrubbed value rather than the last live SessionNum). The `SimMode` field
  // is unaffected by the brief `IsReplayPlaying` flicker during a live
  // qual → race transition, so the #568 path stays intact.
  const replayOnlySession =
    currentSessionNum !== null
      ? isReplayOnlySession(self.controller.getSessionInfo() as Record<string, unknown> | null)
      : false;

  if (
    !replayOnlySession &&
    currentSessionNum !== null &&
    self.lastObservedSessionNum !== null &&
    currentSessionNum !== self.lastObservedSessionNum
  ) {
    const previousSessionNum = self.lastObservedSessionNum;
    resetPerSessionState(self, telemetry);
    // Publish `session.changed` directly from the instance-level tracker so it
    // survives the replay-mode state wipe below (issue #568 follow-up). When
    // iRacing transitions between sessions through a replay-mode tick, the
    // wipe at `IsReplayPlaying === true` clears `state.lastSessionNum` and the
    // diffLifecycle path swallows the delta on the next non-replay tick (it
    // re-seeds via `lifecycleInitialized = false` instead of comparing). Bug
    // surface: race-start callout never fired through a qualifying → race
    // transition. Pre-setting `state.lastSessionNum` to the new value here
    // prevents `diffLifecycle` from double-emitting on the same tick when the
    // transition does NOT pass through replay mode.
    self.logger.info(
      `session.changed: SessionNum ${previousSessionNum} → ${currentSessionNum} (IsReplayPlaying=${telemetry.IsReplayPlaying ?? false})`,
    );
    publish(
      self,
      { event: "session.changed", data: { from: previousSessionNum, to: currentSessionNum } },
      telemetry,
      Date.now(),
    );
    self.state.lastSessionNum = currentSessionNum;
  }

  if (currentSessionNum !== null && !replayOnlySession) {
    self.lastObservedSessionNum = currentSessionNum;
  }

  // Standing-start numeric countdown (issue #829). Runs on every tick BEFORE
  // the replay guard: the countdown is the "get in the car" reminder, and
  // iRacing reports `IsReplayPlaying: true` while the user sits in the garage
  // / session screen / in-session replay view — exactly where the reminder
  // matters most. Gated on `!replayOnlySession` (the #604 `SimMode`
  // discriminator) so a standalone saved replay stays silent, and its state
  // is preserved by `wipeStateForReplay` so a garage↔car flip can neither
  // drop a boundary mark nor replay a spoken one. The gantry edges stay
  // post-guard (`diffStartLights` below) — out of the car at lights-out means
  // the start was missed, so "go, go, go" would be noise.
  if (!replayOnlySession) {
    diffStartCountdown(
      self.state,
      telemetry,
      self.controller.getSessionInfo() as Record<string, unknown> | null,
      (ev) => publish(self, ev, telemetry, Date.now()),
    );
  }

  // `driver.firstOnTrack` is detected on every tick — including replay ticks
  // — so the genuine garage/replay → live-on-track transition is never
  // missed. Must run before the replay guard's early return below.
  diffFirstOnTrack(self, telemetry);

  // Suppress every semantic event while iRacing is in replay mode. The
  // engineer voice should be quiet whenever the user isn't actively in
  // the car — replay scrubbing fires phantom flag transitions and pit
  // toggles as the timeline jumps, which would queue audio that has no
  // relationship to the live session. Mirrors the existing
  // disconnect-resets-state pattern so when replay ends the diff
  // modules' first-tick / off-track seed branches reseed cleanly.
  if (telemetry.IsReplayPlaying === true) {
    if (!self.lastTickInReplay) {
      // Publish the radar teardown signal before resetting state so the
      // radar engine receives a clear edge — otherwise it stays latched
      // through replay (the tick loop runs until it sees a `clear`).
      // Mirrors `handleDisconnect()`.
      if (self.state.radarState !== "clear") {
        publish(
          self,
          { event: "radar.changed", data: { from: self.state.radarState, to: "clear" } },
          telemetry,
          Date.now(),
        );
      }

      wipeStateForReplay(self);
      self.lastTickInReplay = true;
      // Fuel lap history (issue #465): survives the wipe (it lives on the
      // instance), but telemetry will have jumped by the time live ticks
      // resume — a garage visit moves the car, fuel, and lap counter — so the
      // open segment must re-anchor as partial on the first tick back.
      self.fuelLaps.resumePartial = true;
    }

    return;
  }

  if (self.lastTickInReplay) {
    wipeStateForReplay(self);
    self.lastTickInReplay = false;
  }

  const now = Date.now();
  const pending: PendingEvent[] = [];
  const emit = (ev: PendingEvent): void => {
    pending.push(ev);
  };

  const sessionInfo = self.controller.getSessionInfo() as Record<string, unknown> | null;
  const sessionType = resolveSessionType(sessionInfo, telemetry);
  const isRaceSession = sessionType === "Race";
  const playerCarIdx = resolvePlayerCarIdx(sessionInfo);
  const pitSpeedLimitMps = resolvePitSpeedLimit(self, sessionInfo, telemetry);
  // Track discipline drives the pit-entry emission edge in diffPitLane (dirt
  // ovals fire on pit-road drive-in; everything else on approach-zone entry).
  const trackType = resolveTrackType(sessionInfo);

  // Diff modules — `diffLimiter` reads `state.lastInPitStall` to detect the
  // just-left-stall transition, so it must run BEFORE `diffPitLane` writes
  // the new stall flag. All other modules are independent.
  diffLifecycle(self.state, telemetry, emit);
  // Lap completion (issue #555). Runs alongside diffLifecycle since they
  // share the lap counter; classified session type passed through so the
  // payload's `sessionType` field doesn't require a re-classification pass.
  // `classifyLapSessionType` is stricter than `classifySessionType` —
  // unresolved/unrecognized raw values yield `undefined` so the payload
  // omits `sessionType` rather than defaulting it to "race".
  //
  // Multi-class flag (issue #566) is resolved from session info here and
  // passed through; the diff has no business poking at `DriverInfo.Drivers`
  // itself. `null` is the absent-session-info sentinel — the diff treats it
  // as "unknown" and omits `isMultiClass` from the payload.
  //
  // Position is sourced from `ResultsPositions` (issue #566), not the live
  // `PlayerCarPosition` telemetry field — the latter can momentarily report
  // 0 at the lap-completion tick in qualifying. Resolved here so the diff
  // stays out of session-info parsing; null means "unavailable, can't read
  // standings" and the diff will defer the emit (with a timeout) until the
  // standings catch up.
  const playerResults = resolvePlayerResultsSnapshot(sessionInfo, playerCarIdx, telemetry.SessionNum ?? 0);
  diffLaps(
    self.state,
    telemetry,
    classifyLapSessionType(sessionType),
    resolveIsMultiClass(sessionInfo),
    playerResults,
    now,
    emit,
  );
  diffLimiter(self.state, telemetry, pitSpeedLimitMps, now, emit);
  diffPitLane(self.state, telemetry, trackType, now, emit);
  // Checkered deferral (issue #771): the leader guard on the winner grace
  // consumes the canonical live order (`.claude/rules/race-positions.md`),
  // falling back to the official position only when no live order exists —
  // the same read `getLivePosition()` serves between ticks (the freeze
  // tracking is updated further down this tick, so the anchors are at most
  // one tick stale here, which the leader check tolerates). Leader
  // resolution is gated on race sessions — the winner grace it feeds is
  // race-only, so non-race ticks skip the frozen-order computation.
  // Practice-like sessions (Practice / Testing — the classifyLapSessionType
  // convention) are flagged so the checkered speaks immediately at the
  // raise there.
  diffFlags(
    self.state,
    telemetry,
    now,
    emit,
    isRaceSession,
    isRaceSession && resolvePlayerIsLeader(self, telemetry, playerCarIdx),
    sessionType.includes("Practice") || sessionType.includes("Testing"),
  );
  // Start-light gantry edges (issue #480). Sits beside diffFlags (after the
  // replay guard — the gantry lines are in-car only) and reads the
  // already-resolved `sessionInfo` for the standing-start gate. The numeric
  // pre-start countdown runs PRE-guard instead (`diffStartCountdown` above,
  // issue #829) so it reaches a driver who's still in the garage.
  diffStartLights(self.state, telemetry, sessionInfo, emit);
  // Rolling-start "one pace lap to go" (issue #657) — a start/finish-crossing
  // heuristic, NOT iRacing's `OneLapToGreen` edge. Reads `sessionInfo` for the
  // standing-start guard, beside the other formation diffs.
  diffPaceLaps(self.state, telemetry, sessionInfo, emit);
  // Rolling-start "pace car is moving" (issue #660) — fires at the ParadeLaps
  // ENTRY edge (field released into the formation lap), unlike diffPaceLaps
  // which fires later after a start/finish crossing completes the first pace lap.
  diffRollingStart(self.state, telemetry, sessionInfo, emit);
  // Pit window open/closed (issue #655) — emits `pitsOpen.changed` on a real
  // `PitsOpen` boolean transition. Race-only + replay-only gated here: the diff
  // runs after the main replay guard, but a paused / frame-scrubbed replay can
  // read `IsReplayPlaying === false` while `SimMode === "replay"`, so the
  // explicit `replayOnlySession` gate (computed above for the session.changed
  // paths) still matters. `isRaceSession` keeps it out of practice / qualifying.
  diffPitsOpen(self.state, telemetry, isRaceSession, replayOnlySession, emit);
  diffToggles(self.state, telemetry, now, emit);
  // diffPitStatus emits `pitService.statusChanged` for in-progress / complete
  // / positioning / can't-fix-that transitions (issue #479). Independent of
  // diffToggles' bit-flag world; placed adjacent for cohesion of the
  // pit-service event group.
  diffPitStatus(self.state, telemetry, emit);
  // diffPitReadback runs after diffToggles so it sees the per-tick toggle
  // emissions (`pitService.toggled` / `tireService.changed` /
  // `tireService.compoundChanged`) in `pending` — those signal user intent
  // and trigger an `entry-refire` readback.
  diffPitReadback(self.state, telemetry, now, emit, pending);
  diffIncidents(self.state, telemetry, now, emit);
  diffDamage(self.state, telemetry, now, emit);
  // Overtake gain/loss (issue #574). Track length powers the 10 m physical-gap
  // gate; resolved here so the diff stays out of session-info parsing. `null`
  // when the YAML hasn't been parsed yet — the diff treats it as "no gap data"
  // and lets emissions through without gating on gap. `isMultiClass` is the
  // same value passed to `diffLaps`; the overtake payload mirrors `lap.completed`
  // so multi-class consumers can branch on class vs overall.
  const trackLengthMeters = resolveTrackLengthMeters(self.state, sessionInfo, telemetry);
  // Effective starting grid position (1-indexed) — the same value the
  // race-start callout announces (`resolveStartingGridPosition`, #568). CLASS
  // grid slot in a multi-class race, overall otherwise (#599). The overtake
  // diff seeds its baseline to it at race start so early-race gain/loss is
  // measured from the grid and a round-trip back to it is suppressed (#597
  // follow-up); the diff applies the seed in the matching detection space
  // (class in multi-class, overall otherwise). `null` until session info /
  // qualifying results are parsed.
  const startingGridPosition = sessionInfo ? (resolveStartingGridPosition(sessionInfo) ?? null) : null;
  // Self-managed running order (issue #603). iRacing zeroes a car's
  // lc/dp/ts to -1 the instant it's NotInWorld and teleports dp on a tow, so
  // we maintain a per-car last-known on-track score ourselves and freeze cars
  // whose telemetry is invalid or has drifted discontinuously from that anchor.
  // Subsumes the earlier per-symptom patches (checkered finished-freeze,
  // tow `-isTowed`, NotInWorld-blink churn). Runs every tick before the frozen
  // positions are read.
  updatePositionTracking(self.state, telemetry);
  const frozenPositions = calculateFrozenRacePositions(self.state, telemetry);

  diffOvertakes(
    self.state,
    telemetry,
    playerCarIdx,
    isRaceSession,
    resolveIsMultiClass(sessionInfo),
    trackLengthMeters,
    now,
    emit,
    startingGridPosition,
    frozenPositions,
  );
  // Gap tracking (issue #933): crossing-time traces + class-neighbor live
  // gaps + trend/threshold callout events. Consumes the same canonical
  // frozen order as diffOvertakes; the pace car is excluded explicitly
  // because the canonical order carries no pace-car filter of its own.
  diffGaps(
    self.state,
    telemetry,
    isRaceSession,
    playerCarIdx,
    resolvePaceCarIdx(sessionInfo),
    frozenPositions,
    self.getGapAlertThresholdSeconds,
    emit,
  );
  // Pit-box count-in (issue #600). Reuses the cached `trackLengthMeters` to
  // convert the LapDistPct→box gap into meters; the box itself comes from
  // `DriverInfo.DriverPitTrkPct`. Runs after the track-length resolution above.
  diffPitBoxCountdown(self.state, telemetry, resolvePitBoxTrkPct(sessionInfo), trackLengthMeters, emit);
  // Corner-name callouts (issue #888). Practice/test only — the diff gates on
  // the classified session type (diff-side per #655, so the harness can fire
  // the event directly). Reuses the cached trackLengthMeters for the
  // speed→lap-fraction conversion; markers resolve from the bundled
  // lovely-track-data snapshot keyed by WeekendInfo.TrackName. An empty raw
  // session type means session info hasn't resolved — stay silent.
  diffCornerName(
    self.state,
    telemetry,
    sessionType !== "" && classifySessionType(sessionType) === "practice",
    resolveCornerMarkersCached(self.state, sessionInfo, telemetry),
    trackLengthMeters,
    self.getCornerCalloutLeadSeconds,
    emit,
  );
  // Laps-of-fuel-left callout crossings (issue #838). Reads the SAME
  // validated estimator as Session Info's Laps to Empty (issue #748), over
  // the same default window, so the spoken count tracks the display. Runs
  // after diffFlags so the race-coverage suppression (#866) reads a
  // same-tick-fresh `whiteLastLapFired` final-lap latch.
  diffFuelLapsLeft(
    self.state,
    telemetry,
    isRaceSession,
    () => computeFuelStats(self.fuelLaps.history, FUEL_LAPS_LEFT_WINDOW_LAPS),
    self.getFuelLapsLeftMarginLaps,
    () => resolveLeaderLapTimeS(telemetry, frozenPositions),
    emit,
  );

  // Validated per-lap fuel history (issue #465) — tracker-only, no events.
  // Deliberately NOT race-gated: consumption stats are just as useful on a
  // practice long run. Read via `getFuelStats()`. The `replayOnlySession`
  // gate matters even after the main replay guard (the diffPitsOpen
  // precedent, #655): a paused / frame-scrubbed replay reads
  // `IsReplayPlaying === false` while `SimMode === "replay"`, and feeding
  // that replay-timeline telemetry into the tracker would record bogus laps
  // or trip the session-restart fence on a backward scrub. Treat those ticks
  // as a gap instead, like any other replay visit.
  if (replayOnlySession) {
    self.fuelLaps.resumePartial = true;
  } else {
    diffFuelLaps(self.fuelLaps, telemetry);
  }

  diffRadar(self.state, telemetry, emit);
  diffTrackWetness(self.state, telemetry, emit);

  for (const p of pending) {
    publish(self, p, telemetry, now);
  }
}

function publish(self: TranslatorInstance, pending: PendingEvent, telemetry: TelemetryData, timestamp: number): void {
  const envelope = {
    event: pending.event,
    timestamp,
    telemetry,
    data: pending.data,
  } as SimEventMap[SimEventName];
  self.bus.publish(envelope);
}

function resolveSessionType(sessionInfo: Record<string, unknown> | null, telemetry: TelemetryData): string {
  if (!sessionInfo) return "";

  const sessions = (sessionInfo.SessionInfo as Record<string, unknown> | undefined)?.Sessions as
    Array<Record<string, unknown>> | undefined;
  const sessionNum = telemetry.SessionNum ?? 0;
  const current = sessions?.[sessionNum as number];

  return (current?.SessionType as string) ?? "";
}

/**
 * Collapse iRacing's raw `SessionType` string ("Practice", "Lone Practice",
 * "Offline Testing", "Open Qualify", "Lone Qualify", "Race", "Warmup", …)
 * into the three buckets the session-start callout records a line for.
 * "Offline Testing" maps to "practice" — a test session is practice-like and
 * "it's time to race" would be wrong there. Anything that isn't practice,
 * testing, or qualifying (warmup, heat, race) reads as "race".
 */
function classifySessionType(raw: string): "practice" | "qualifying" | "race" {
  if (raw.includes("Practice") || raw.includes("Testing")) return "practice";

  if (raw.includes("Qualify")) return "qualifying";

  return "race";
}

/**
 * Stricter variant of {@link classifySessionType} for the `lap.completed`
 * payload (issue #555): unresolved or unrecognized raw values return
 * `undefined` so the bus event omits `sessionType` rather than reporting a
 * false-positive "race" classification. Used only by `diffLaps` — callers
 * outside `lap.completed` retain the looser {@link classifySessionType}
 * because its "race" default is the right safe choice when the session info
 * isn't yet available.
 */
function classifyLapSessionType(raw: string): "practice" | "qualifying" | "race" | undefined {
  if (!raw) return undefined;

  if (raw.includes("Practice") || raw.includes("Testing")) return "practice";

  if (raw.includes("Qualify")) return "qualifying";

  if (raw.includes("Race")) return "race";

  return undefined;
}

function resolvePlayerCarIdx(sessionInfo: Record<string, unknown> | null): number {
  if (!sessionInfo) return -1;

  const driverInfo = sessionInfo.DriverInfo as Record<string, unknown> | undefined;

  return (driverInfo?.DriverCarIdx as number) ?? -1;
}

/**
 * Reads `DriverInfo.DriverSetupName` from session YAML, returning `undefined`
 * when missing or not a non-empty string (issue #625).
 */
function resolveDriverSetupName(sessionInfo: Record<string, unknown> | null): string | undefined {
  if (!sessionInfo) return undefined;

  const driverInfo = sessionInfo.DriverInfo as Record<string, unknown> | undefined;
  const name = driverInfo?.DriverSetupName;

  return typeof name === "string" && name !== "" ? name : undefined;
}

/**
 * Is the user passively watching a replay rather than in a live session
 * (issue #604)? Reads `WeekendInfo.SimMode` — iRacing's self-reported sim
 * mode. Known values: `"full"` for live driving, `"replay"` for the replay
 * UI. Critically, this does NOT flip during the brief replay-mode tick
 * window in a live qualifying → race transition (that's a transient
 * `IsReplayPlaying` flicker; `SimMode` stays `"full"`), so gating on it
 * preserves the #568 pre-guard `session.changed` emit for live transitions
 * while suppressing it when the user is only watching a replay.
 *
 * Defaults to `false` (not replay-only) when session info or the field is
 * missing — same behavior as before this gate existed.
 */
function isReplayOnlySession(sessionInfo: Record<string, unknown> | null): boolean {
  if (!sessionInfo) return false;

  const weekendInfo = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;

  return weekendInfo?.SimMode === "replay";
}

/**
 * Player's pit-box position as a 0–1 fraction of the lap, from
 * `SessionInfo.DriverInfo.DriverPitTrkPct` (issue #600). iRacing reports the
 * box up front, so the pit-box count-in works on the very first stop without
 * having to learn the location. Returns `null` when session info is missing or
 * the value is out of the open (0, 1) range (iRacing uses 0 / out-of-range as
 * the "no assigned box" sentinel) — the count-in diff then stays silent.
 *
 * @internal Exported for testing.
 */
export function resolvePitBoxTrkPct(sessionInfo: Record<string, unknown> | null): number | null {
  if (!sessionInfo) return null;

  const driverInfo = sessionInfo.DriverInfo as Record<string, unknown> | undefined;
  const pct = driverInfo?.DriverPitTrkPct;

  if (typeof pct !== "number" || pct <= 0 || pct >= 1) return null;

  return pct;
}

/**
 * Player's standings snapshot pulled from
 * `SessionInfo.Sessions[current].ResultsPositions[player]` (issue #566). The
 * authoritative leaderboard source, used in preference to the live
 * `PlayerCarPosition` / `PlayerCarClassPosition` telemetry fields — the latter
 * can transiently read 0 at the lap-completion tick in qualifying while the
 * sim recomputes order.
 *
 * `lapsComplete` is paired with the position fields so the lap diff can verify
 * ResultsPositions has caught up to the lap counter before emitting the
 * `lap.completed` event (the standings table updates a tick or two after the
 * lap counter increments).
 *
 * `classPosition` is the **raw 0-indexed value** from `ResultsPositions`. The
 * diff converts to 1-indexed (`+1`) when populating the event payload so it
 * matches the `PlayerCarClassPosition` telemetry convention.
 *
 * Returns `null` when session info / current session / player entry isn't
 * resolvable — the diff treats null as "ResultsPositions unavailable for this
 * tick" and waits (up to a timeout) before emitting.
 */
export type PlayerResultsSnapshot = {
  lapsComplete: number;
  /** 1-indexed overall position. */
  position: number;
  /** Raw 0-indexed class position straight from `ResultsPositions`. */
  classPosition: number;
};

/**
 * Look up the player's `ResultsPositions` entry for the **current** session
 * (matched by `SessionNum`, not array index — the Sessions array order isn't
 * a contract). Returns `null` when any step misses.
 */
function resolvePlayerResultsSnapshot(
  sessionInfo: Record<string, unknown> | null,
  playerCarIdx: number,
  currentSessionNum: number,
): PlayerResultsSnapshot | null {
  if (!sessionInfo || playerCarIdx < 0) return null;

  const info = sessionInfo.SessionInfo as Record<string, unknown> | undefined;
  const sessions = info?.Sessions as Array<Record<string, unknown>> | undefined;

  if (!Array.isArray(sessions)) return null;

  const currentSession = sessions.find((s) => s.SessionNum === currentSessionNum);

  if (!currentSession) return null;

  const results = currentSession.ResultsPositions as Array<Record<string, unknown>> | undefined;

  if (!Array.isArray(results)) return null;

  const entry = results.find((r) => r.CarIdx === playerCarIdx);

  if (!entry) return null;

  const lapsComplete = typeof entry.LapsComplete === "number" ? entry.LapsComplete : -1;
  const position = typeof entry.Position === "number" ? entry.Position : 0;
  const classPosition = typeof entry.ClassPosition === "number" ? entry.ClassPosition : -1;

  return { lapsComplete, position, classPosition };
}

/**
 * Whether the current session has more than one distinct car class on track
 * (issue #566). Returns `null` when session info isn't available so the
 * lap-completed diff can omit `isMultiClass` from the payload rather than
 * fabricate a default. Filters out the pace car and spectators — those
 * entries share `CarClassID: -1` (pace car) or aren't competing for
 * position. A single class with a pace car is still single-class.
 */
function resolveIsMultiClass(sessionInfo: Record<string, unknown> | null): boolean | null {
  if (!sessionInfo) return null;

  const driverInfo = sessionInfo.DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as Array<Record<string, unknown>> | undefined;

  if (!Array.isArray(drivers)) return null;

  const classIds = new Set<number>();

  for (const driver of drivers) {
    if (driver.CarIsPaceCar === 1) continue;

    if (driver.IsSpectator === 1) continue;

    const id = driver.CarClassID;

    if (typeof id === "number" && id >= 0) classIds.add(id);
  }

  return classIds.size > 1;
}

/**
 * Parse `SessionInfo.WeekendInfo.TrackLength` ("X.XXX km" or "X.XXX miles") into
 * meters and cache the result on `TranslatorState` keyed by `(TrackID, SessionNum)`
 * (issue #574). Returns `null` when the YAML hasn't been seen yet, the field is
 * absent, or the format doesn't parse — the overtake diff treats null as "no
 * gap data" and lets emissions through without the physical-gap gate. Re-parses
 * automatically on track or session change since the cache key invalidates.
 */
function resolveTrackLengthMeters(
  state: TranslatorState,
  sessionInfo: Record<string, unknown> | null,
  telemetry: TelemetryData,
): number | null {
  if (!sessionInfo) return state.trackLengthMeters;

  const weekend = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;
  const trackId = `${String(weekend?.TrackID ?? "")}|${String(telemetry.SessionNum ?? "")}`;

  if (trackId !== state.trackLengthKey) {
    state.trackLengthKey = trackId;
    state.trackLengthMeters = null;
  } else if (state.trackLengthMeters !== null) {
    return state.trackLengthMeters;
  }

  const raw = weekend?.TrackLength;

  if (typeof raw === "string") {
    const match = /([\d.]+)\s*(km|mi(?:les?)?)/i.exec(raw);

    if (match) {
      const value = parseFloat(match[1]!);
      const unit = match[2]!.toLowerCase();

      if (Number.isFinite(value) && value > 0) {
        state.trackLengthMeters = unit.startsWith("mi") ? value * 1609.344 : value * 1000;
      }
    }
  }

  return state.trackLengthMeters;
}

/**
 * Resolve (and cache) the bundled corner markers for the current track
 * (issue #888). Keyed by `(TrackID, SessionNum)` like the track-length cache;
 * re-resolves when the key changes and retries while null in case the first
 * YAML tick lacked `TrackName`. Returns `null` for tracks not in the dataset.
 */
function resolveCornerMarkersCached(
  state: TranslatorState,
  sessionInfo: Record<string, unknown> | null,
  telemetry: TelemetryData,
): CornerMarker[] | null {
  if (!sessionInfo) return state.cornerMarkers;

  const weekend = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;
  const key = `${String(weekend?.TrackID ?? "")}|${String(telemetry.SessionNum ?? "")}`;

  if (key !== state.cornerMarkersKey) {
    state.cornerMarkersKey = key;
    state.cornerMarkers = null;
  } else if (state.cornerMarkers !== null) {
    return state.cornerMarkers;
  }

  const trackName = typeof weekend?.TrackName === "string" ? weekend.TrackName : "";

  if (trackName !== "") state.cornerMarkers = resolveCornerMarkers(trackName);

  return state.cornerMarkers;
}

function resolvePitSpeedLimit(
  self: TranslatorInstance,
  sessionInfo: Record<string, unknown> | null,
  telemetry: TelemetryData,
): number {
  if (!sessionInfo) return self.pitSpeedLimitMps;

  const weekend = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;
  const trackId = `${String(weekend?.TrackID ?? "")}|${String(telemetry.SessionNum ?? "")}`;

  // Track or session changed — invalidate the cache. We re-parse below; if
  // the new session YAML is missing or malformed, the cached limit resets
  // to 0 so `diffLimiter` won't fire `limiter.speeding` against a stale
  // threshold from the previous track.
  if (trackId !== self.pitSpeedLimitKey) {
    self.pitSpeedLimitKey = trackId;
    self.pitSpeedLimitMps = 0;
  } else if (self.pitSpeedLimitMps > 0) {
    return self.pitSpeedLimitMps;
  }

  const raw = weekend?.TrackPitSpeedLimit;

  if (typeof raw === "string") {
    const match = /([\d.]+)\s*(kph|mph|kmh|km\/h)/i.exec(raw);

    if (match) {
      const value = parseFloat(match[1]!);
      const unit = match[2]!.toLowerCase();
      self.pitSpeedLimitMps = unit === "mph" ? value * 0.44704 : value / 3.6;
    }
  }

  return self.pitSpeedLimitMps;
}
