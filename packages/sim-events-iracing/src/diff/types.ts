import type { SimEventMap, SimEventName } from "@iracedeck/event-bus";

/**
 * A pending event produced by a diff module. The translator orchestrator
 * wraps each emission into a full `SimEventOf<T>` envelope (adding
 * timestamp + telemetry) and publishes it to the event bus.
 *
 * `E` narrows the union to the events one module may emit (issue #1499);
 * the default is the whole catalog.
 */
export type PendingEvent<E extends SimEventName = SimEventName> = {
  [K in E]: { event: K; data: SimEventMap[K]["data"] };
}[E];

/**
 * Helper signature diff modules call to queue an event. Deliberately without
 * a default (issue #1499): each module types its emitter with its own
 * `<NAME>_EVENTS` list, so the compiler refuses an emit the list does not
 * name, and `TICK_ORDER` (`src/tick-order.ts`) reads what every stage
 * publishes from those lists.
 */
export type EmitFn<E extends SimEventName> = (event: PendingEvent<E>) => void;
