/**
 * @iracedeck/sim-events-iracing
 *
 * iRacing telemetry translator. Subscribes to `sdkController` ticks,
 * diffs against the previous state, and publishes semantic events on
 * `@iracedeck/event-bus`. The only package that imports
 * `@iracedeck/iracing-sdk` for telemetry consumption.
 */
export {
  _resetSimEventsIracing,
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
  getRaceStartConditions,
  getReadbackSnapshot,
  getSessionStartConditions,
  getSessionType,
  getStandingStart,
  getStartingGridPosition,
  getTrackDirection,
  initializeSimEventsIracing,
  isPitActionsAllowed,
  isRaceFinished,
  isSimEventsIracingInitialized,
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
export { DAMAGE_DEBOUNCE_MS } from "./diff/damage.js";
export { YELLOW_CLEARED_HOLD_MS } from "./diff/flags.js";
export {
  FUEL_CALLOUT_DEFAULT_MARGIN_LAPS,
  FUEL_CALLOUT_MARGIN_MAX_LAPS,
  FUEL_CALLOUT_MARGIN_MIN_LAPS,
  FUEL_LAPS_LEFT_MAX_COUNT,
  FUEL_LAPS_LEFT_WINDOW_LAPS,
  sanitizeFuelCalloutMarginLaps,
} from "./diff/fuel-laps-left.js";
export { FUEL_LAP_HISTORY_CAP, type FuelLap, type FuelStats } from "./diff/fuel-laps.js";
export {
  OPPONENT_PIT_AGGREGATE_THRESHOLD,
  OPPONENT_PIT_AGGREGATE_WINDOW_MS,
  OPPONENT_PIT_CAR_COOLDOWN_MS,
} from "./diff/opponent-pit.js";
export { OVERTAKE_HOLD_MS, OVERTAKE_MAX_JUMP } from "./diff/overtakes.js";
export { PIT_APPROACH_COOLDOWN_MS } from "./diff/pit-lane.js";
export {
  PIT_STATUS_MOVEMENT_SPEED_MPS,
  PIT_STATUS_REPEAT_INTERVAL_MS,
  PIT_STATUS_REST_SETTLE_MS,
} from "./diff/pit-status.js";
export { resolveRadarState } from "./diff/radar.js";
export { resolveIsAiRace, resolveStandingStart } from "./start-lights.js";
export { resolveTrackDirection, resolveTrackType, TrackDirection, TrackType } from "./track-type.js";
