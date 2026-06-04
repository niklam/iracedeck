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
  getOvertakeTelemetryGate,
  getQualifyingInvalidationSnapshot,
  getRaceStartConditions,
  getReadbackSnapshot,
  getSessionStartConditions,
  getSessionType,
  initializeSimEventsIracing,
  isPitActionsAllowed,
  isRaceFinished,
  isSimEventsIracingInitialized,
  type LivePosition,
  type OvertakeTelemetryGate,
} from "./translator.js";
export { DAMAGE_DEBOUNCE_MS } from "./diff/damage.js";
export { FUEL_THRESHOLDS } from "./diff/fuel.js";
export { OVERTAKE_HOLD_MS, OVERTAKE_MAX_JUMP } from "./diff/overtakes.js";
export { resolveRadarState } from "./diff/radar.js";
export { resolveTrackType, TrackType } from "./track-type.js";
