/**
 * @iracedeck/sim-events-iracing
 *
 * iRacing telemetry translator. Subscribes to `sdkController` ticks,
 * diffs against the previous state, and publishes semantic events on
 * `@iracedeck/event-bus`. Not the only reader of iRacing telemetry (#1351):
 * actions read the SDK controller through `@iracedeck/deck-iracing`'s
 * `IRacingAction`, and part of the `audio-scenarios` catalog reads raw
 * telemetry through `getLatestTelemetry()` below. The Architecture page's
 * "Seams & where the abstraction leaks" lists them.
 */
export {
  _resetSimEventsIracing,
  getCautionEpisode,
  getCautionLineup,
  getCautionPhase,
  getDriverSetupName,
  getFuelStats,
  getLatestTelemetry,
  getLiveCarPosition,
  getLiveGapBetween,
  getLiveGaps,
  getLiveOpponentFlags,
  getLivePosition,
  getLiveRacePositions,
  getNearestCarGapMeters,
  getOvertakeTelemetryGate,
  getQualifyingInvalidationSnapshot,
  getRaceFinishResult,
  getRaceStartConditions,
  getReadbackSnapshot,
  getSessionStartConditions,
  getSessionType,
  getStandingStart,
  getStartingGridPosition,
  getTrackDirection,
  initializeSimEventsIracing,
  isDamageRepairNeeded,
  isPitActionsAllowed,
  isRaceFinished,
  isSimEventsIracingInitialized,
  isUnderFullCourseCaution,
  resolveLeaderLapTimeS,
  type GapNeighbor,
  type LivePosition,
  type LiveGaps,
  type LiveOpponentFlagCar,
  type LiveOpponentFlags,
  type OvertakeTelemetryGate,
  type SimEventsIracingOptions,
} from "./translator.js";
export {
  GAP_BREAKAWAY_MAX_GAP_S,
  GAP_BREAKAWAY_MIN_RATE_S_PER_LAP,
  GAP_CHECKPOINT_STEP,
  GAP_CLOSING_MIN_RATE_S_PER_LAP,
  GAP_CONTACT_HORIZON_LAPS,
  GAP_DEFAULT_ALERT_THRESHOLD_S,
  sanitizeGapAlertThresholdSeconds,
  sanitizeGapMinChangeSeconds,
  GAP_DEFAULT_MIN_CHANGE_S,
  GAP_DISPLAY_TREND_DEADBAND_S,
  GAP_THRESHOLD_HYSTERESIS_S,
} from "./diff/gaps.js";
export {
  CORNER_CALLOUT_DEFAULT_LEAD_SECONDS,
  CORNER_CALLOUT_LEAD_MAX_SECONDS,
  CORNER_CALLOUT_LEAD_MIN_SECONDS,
  sanitizeCornerCalloutLeadSeconds,
} from "./diff/corner-name.js";
// The lineup shape `getCautionLineup()` returns (issue #1127). Exported from
// the module that defines it rather than re-exported through the translator —
// the `FuelStats` precedent directly below. `resolvePlayerCarIdx` rides with
// it for the scenario harness, whose caution-shortcut precondition asks THIS
// reader whether a session names the player rather than restating its rule.
// `resolveCautionLineup` itself — the pure reader `getCautionLineup()` wraps —
// rides for the audio-scenarios test that derives the 2026-09-19 snapshot's
// lineup from the committed fixture rather than typing its number in.
export { type CautionLineup, resolveCautionLineup, resolvePlayerCarIdx } from "./diff/caution-lineup.js";
// The phase `getCautionPhase()` returns (issue #1127) — the callouts that
// gate on a STAGE of the caution rather than on "is one out" name it — and
// the episode `getCautionEpisode()` returns (issue #1286), which scopes a
// callout's memory to one caution.
export { type CautionEpisode, type CautionPhase, type RaceFinishResult } from "./state.js";
// The damage edge's debounce, the grace a settled edge waits for the crash's
// incident burst (#1211), and the repair bits it watches — for the harness,
// whose damage shortcuts replay the translator's timing and bits rather than
// restating them.
export { DAMAGE_DEBOUNCE_MS, DAMAGE_INCIDENT_GRACE_MS, DAMAGE_REPAIR_MASK } from "./diff/damage.js";
export { YELLOW_CLEARED_HOLD_MS } from "./diff/flags.js";
// The settle window between leaving pit road and the exit readback, which is
// also when the tire wear report is published (#1108). Exported for the
// harness's replayed stop, which must hold past it.
export { PIT_READBACK_EXIT_DELAY_MS } from "./diff/pit-readback.js";
export {
  FUEL_CALLOUT_DEFAULT_MARGIN_LAPS,
  FUEL_CALLOUT_MARGIN_MAX_LAPS,
  FUEL_CALLOUT_MARGIN_MIN_LAPS,
  FUEL_LAPS_LEFT_MAX_COUNT,
  FUEL_LAPS_LEFT_WINDOW_LAPS,
  sanitizeFuelCalloutMarginLaps,
} from "./diff/fuel-laps-left.js";
export { FUEL_LAP_HISTORY_CAP, type FuelLap, type FuelStats } from "./diff/fuel-laps.js";
// The opponent-flag range setting's bounds and sanitizer (issue #1274) — the
// plugins wire `getOpponentFlagRangeSeconds` through it, the
// `sanitizeGapAlertThresholdSeconds` precedent.
export {
  OPPONENT_FLAG_DEFAULT_RANGE_SECONDS,
  OPPONENT_FLAG_RANGE_MAX_SECONDS,
  OPPONENT_FLAG_RANGE_MIN_SECONDS,
  sanitizeOpponentFlagRangeSeconds,
} from "./diff/opponent-flags.js";
export {
  OPPONENT_PIT_AGGREGATE_THRESHOLD,
  OPPONENT_PIT_AGGREGATE_WINDOW_MS,
  OPPONENT_PIT_CAR_COOLDOWN_MS,
} from "./diff/opponent-pit.js";
export { OVERTAKE_HOLD_MS, OVERTAKE_MAX_JUMP } from "./diff/overtakes.js";
export { PIT_APPROACH_COOLDOWN_MS } from "./diff/pit-lane.js";
export {
  PIT_STATUS_EMPTY_STOP_MAX_MS,
  PIT_STATUS_MOVEMENT_SPEED_MPS,
  PIT_STATUS_REPEAT_INTERVAL_MS,
  PIT_STATUS_REST_SETTLE_MS,
} from "./diff/pit-status.js";
export { resolveRadarState } from "./diff/radar.js";
export { resolveIsAiRace, resolveStandingStart } from "./start-lights.js";
export { resolveTrackDirection, resolveTrackType, TrackDirection, TrackType } from "./track-type.js";
