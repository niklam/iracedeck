/**
 * @iracedeck/event-bus
 *
 * Typed pub/sub with a canonical sim-event catalog. Sim-agnostic: the
 * envelope's telemetry type is generic, so this package has no dependency
 * on any specific simulator SDK.
 */
export type { EventBusOptions, EventHandler, IEventBus } from "./event-bus.js";
export {
  _resetEventBus,
  EVENT_BUS_ERROR_ID_PREFIX,
  EVENT_BUS_REPORTER_MAX_KEYS,
  getEventBus,
  initializeEventBus,
  isEventBusInitialized,
} from "./event-bus.js";
export type {
  CautionLine,
  CountedLapCompleted,
  EmptySimEventPayload,
  FlagScope,
  GapSide,
  IncidentType,
  LapCompletedCommon,
  LapCompletedData,
  OpponentFlagRelation,
  OpponentPitRelation,
  PitBoxMark,
  PitReadbackSnapshot,
  PitServiceKind,
  QualifyingInvalidationSnapshot,
  RaceStartConditions,
  RaceStartSnapshot,
  RefusedLapCompleted,
  SessionStartConditions,
  SessionStartSnapshot,
  SimEvent,
  SimEventMap,
  SimEventName,
  SimEventOf,
  RadarState,
  StartCountdownSeconds,
  TelemetryReadoutKind,
  TelemetryReadoutRequest,
  TelemetryReadoutUnit,
  TireCorner,
  TireCornerWear,
  TireWearReport,
  TireZone,
} from "./event-catalog.js";
export { OpponentPenaltyFlag, TrackWetness } from "./event-catalog.js";
