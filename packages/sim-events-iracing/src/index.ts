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
  getLatestTelemetry,
  initializeSimEventsIracing,
  isSimEventsIracingInitialized,
} from "./translator.js";
export { FUEL_THRESHOLDS } from "./diff/fuel.js";
export { OVERTAKE_HOLD_MS, OVERTAKE_MAX_JUMP } from "./diff/overtakes.js";
export { resolveSpotterState } from "./diff/spotter.js";
