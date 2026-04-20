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
  PitServiceKind,
  SimEvent,
  SimEventMap,
  SimEventName,
  SimEventOf,
  SpotterState,
} from "./event-catalog.js";
