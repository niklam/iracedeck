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
  getLatestTelemetry,
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
  type LivePosition,
  type OvertakeTelemetryGate,
} from "./translator.js";
export { DAMAGE_DEBOUNCE_MS } from "./diff/damage.js";
export { YELLOW_CLEARED_HOLD_MS } from "./diff/flags.js";
export { FUEL_THRESHOLDS } from "./diff/fuel.js";
export { OVERTAKE_HOLD_MS, OVERTAKE_MAX_JUMP } from "./diff/overtakes.js";
export { PIT_APPROACH_COOLDOWN_MS } from "./diff/pit-lane.js";
export { resolveRadarState } from "./diff/radar.js";
export { resolveIsAiRace, resolveStandingStart } from "./start-lights.js";
export { resolveTrackDirection, resolveTrackType, TrackDirection, TrackType } from "./track-type.js";
