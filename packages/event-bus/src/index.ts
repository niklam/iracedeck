/**
 * @iracedeck/event-bus
 *
 * Typed pub/sub with a canonical sim-event catalog. Sim-agnostic: the
 * envelope's telemetry type is generic, so this package has no dependency
 * on any specific simulator SDK.
 */
export type { EventHandler, IEventBus } from "./event-bus.js";
export { _resetEventBus, getEventBus, initializeEventBus, isEventBusInitialized } from "./event-bus.js";
export type {
  EmptySimEventPayload,
  FlagScope,
  IncidentType,
  PitBoxMark,
  PitReadbackSnapshot,
  PitServiceKind,
  QualifyingInvalidationSnapshot,
  RaceStartConditions,
  RaceStartSnapshot,
  SessionStartConditions,
  SessionStartSnapshot,
  SimEvent,
  SimEventMap,
  SimEventName,
  SimEventOf,
  RadarState,
} from "./event-catalog.js";
export { TrackWetness } from "./event-catalog.js";
