import type { SimEventMap, SimEventName } from "@iracedeck/event-bus";

/**
 * A pending event produced by a diff module. The translator orchestrator
 * wraps each emission into a full `SimEventOf<T>` envelope (adding
 * timestamp + telemetry) and publishes it to the event bus.
 */
export type PendingEvent = {
  [K in SimEventName]: { event: K; data: SimEventMap[K]["data"] };
}[SimEventName];

/**
 * Helper signature diff modules call to queue an event.
 */
export type EmitFn = (event: PendingEvent) => void;
