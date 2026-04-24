/**
 * Event Bus Singleton — typed pub/sub.
 *
 * One singleton per plugin instance. No retention; subscribers only receive
 * events published after they subscribe. Consumers that need a "last value"
 * query a separate state cache (not part of this package).
 *
 * Usage:
 *   initializeEventBus(logger);          // once, at plugin startup
 *   const bus = getEventBus();
 *   bus.subscribe("pitLane.entered", (ev) => { ... });
 *   bus.publish({ event: "pitLane.entered", timestamp: Date.now(), telemetry, data: {} });
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

import type { SimEventName, SimEventOf } from "./event-catalog.js";

/** Subscriber callback for a specific event name. */
export type EventHandler<T extends SimEventName> = (event: SimEventOf<T>) => void;

export interface IEventBus {
  /**
   * Publish an event. Every currently-registered handler for `event.event`
   * is invoked synchronously with the event. Handlers that throw are logged
   * and skipped — one bad handler never prevents others from running.
   */
  publish<T extends SimEventName>(event: SimEventOf<T>): void;

  /**
   * Subscribe to an event name. Returns an unsubscribe function — the
   * same shape as `onGlobalSettingsChange` in deck-core.
   */
  subscribe<T extends SimEventName>(name: T, handler: EventHandler<T>): () => void;

  /** Remove a previously registered handler. No-op if it wasn't registered. */
  unsubscribe<T extends SimEventName>(name: T, handler: EventHandler<T>): void;
}

// Internal handler type used in the Map. External-facing generics are preserved
// on the public methods; internally we erase the parameter so one Map can hold
// handlers for every event name.
type AnyHandler = (event: SimEventOf<SimEventName>) => void;

class EventBus implements IEventBus {
  private readonly logger: ILogger;
  private readonly handlers = new Map<SimEventName, Set<AnyHandler>>();

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  publish<T extends SimEventName>(event: SimEventOf<T>): void {
    const name = event.event as SimEventName;
    const set = this.handlers.get(name);

    if (!set || set.size === 0) return;

    // Snapshot so handlers that unsubscribe (their own or others') during
    // dispatch don't mutate the set we're iterating.
    const snapshot = Array.from(set);

    for (const handler of snapshot) {
      try {
        handler(event as SimEventOf<SimEventName>);
      } catch (err) {
        // Include the stack when available — losing it turns these logs into
        // "Cannot read properties of undefined" with no file/line, which
        // is the worst case for a bus that deliberately isolates handler
        // failures (design doc §9: audio failures are non-fatal).
        const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);

        try {
          this.logger.error(`Event handler for "${name}" threw: ${detail}`);
        } catch {
          // A throwing logger must not break handler isolation either.
          // Swallow — the throwing handler's error is already lost to us.
        }
      }
    }
  }

  subscribe<T extends SimEventName>(name: T, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(name);

    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }

    set.add(handler as AnyHandler);

    return () => this.unsubscribe(name, handler);
  }

  unsubscribe<T extends SimEventName>(name: T, handler: EventHandler<T>): void {
    const set = this.handlers.get(name);

    if (!set) return;

    set.delete(handler as AnyHandler);

    if (set.size === 0) {
      this.handlers.delete(name);
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let eventBus: EventBus | null = null;

/**
 * Initialize the event bus singleton. Call once at plugin startup — throws
 * on double init.
 */
export function initializeEventBus(logger: ILogger = silentLogger): IEventBus {
  if (eventBus) {
    throw new Error("Event bus already initialized. initializeEventBus() should only be called once.");
  }

  // Construct and log before publishing the singleton so a throwing logger
  // cannot leave the module in a half-initialized state where
  // isEventBusInitialized() returns true but the caller saw an exception.
  const bus = new EventBus(logger);
  logger.info("Event bus initialized");
  eventBus = bus;

  return bus;
}

/** Get the initialized event bus. Throws if not initialized. */
export function getEventBus(): IEventBus {
  if (!eventBus) {
    throw new Error("Event bus not initialized. Call initializeEventBus() first in your plugin entry point.");
  }

  return eventBus;
}

/** Check whether the event bus has been initialized. */
export function isEventBusInitialized(): boolean {
  return eventBus !== null;
}

/**
 * Reset the event bus singleton.
 * @internal Exported for test isolation only.
 */
export function _resetEventBus(): void {
  eventBus = null;
}
