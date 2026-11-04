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
import {
  createErrorBoundary,
  DEFAULT_MAX_ERROR_KEYS_PER_ID,
  type ErrorBoundary,
  type ErrorPolicy,
  type ILogger,
  silentLogger,
  throwHeld,
} from "@iracedeck/logger";

import type { SimEventName, SimEventOf } from "./event-catalog.js";

/** Subscriber callback for a specific event name. */
export type EventHandler<T extends SimEventName> = (event: SimEventOf<T>) => void;

export interface IEventBus {
  /**
   * Publish an event. Every currently-registered handler for `event.event`
   * is invoked synchronously with the event, in subscription order. A handler
   * that throws never stops the others: under the default `"report"` policy
   * the throw goes to the bounded reporter (#1560) and `publish` returns
   * normally; under `"rethrow"` every handler still runs and the first error
   * is then thrown out of `publish`.
   */
  publish<T extends SimEventName>(event: SimEventOf<T>): void;

  /**
   * Subscribe to an event name. Returns an unsubscribe function — the
   * same shape as `onGlobalSettingsChange` in `@iracedeck/settings`.
   */
  subscribe<T extends SimEventName>(name: T, handler: EventHandler<T>): () => void;

  /** Remove a previously registered handler. No-op if it wasn't registered. */
  unsubscribe<T extends SimEventName>(name: T, handler: EventHandler<T>): void;
}

/** Options for {@link initializeEventBus}. Every plugin build leaves them at their defaults. */
export interface EventBusOptions {
  /**
   * What a handler's throw does (#1560), #1558's policy type. `"report"`, the
   * default and what every plugin build runs, hands it to the bounded reporter:
   * one `error` line with the stack per new throw site of a handler, repeats
   * counted and summarised once a minute, one recovery line after a quiet
   * minute. `"rethrow"` reports nothing: every handler still runs, then
   * `publish` throws the first error. A test that wants loudness chooses it.
   */
  onHandlerError?: ErrorPolicy;
  /** The reporter's clock, in milliseconds. Default: `Date.now()`, read on every call. A test passes a fake. */
  errorClock?: () => number;
}

/**
 * The prefix of every handler id the bus reports under:
 * `event-bus:<event name>#<registration number>`, plus the handler's function
 * name in parentheses when it has one.
 */
export const EVENT_BUS_ERROR_ID_PREFIX = "event-bus:";

/**
 * The global cap of the bus's reporter table (#1560): four throw sites (#1558's
 * per-id cap) for each of 64 handlers. #1558's default of 32 was sized for the
 * SDK controller's handful of subscribers; the bus carries every Race Engineer
 * trigger, cache and engine, and a cap that low would let a few failing handlers
 * hide another's first error. The table cannot grow with handlers that come and
 * go, since `unsubscribe` forgets a handler's keys; the cap stays as the backstop
 * against a subscription leak.
 */
export const EVENT_BUS_REPORTER_MAX_KEYS = 64 * DEFAULT_MAX_ERROR_KEYS_PER_ID;

// Internal handler type used in the Map. External-facing generics are preserved
// on the public methods; internally we erase the parameter so one Map can hold
// handlers for every event name.
type AnyHandler = (event: SimEventOf<SimEventName>) => void;

/** A handler's function name, or `""` when it has none (an inline arrow) or it cannot be read. */
function functionName(handler: AnyHandler): string {
  try {
    const name: unknown = handler.name;

    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

class EventBus implements IEventBus {
  /**
   * Each event name's handlers, in subscription order, with the id each is
   * reported under. The id is fixed when the handler is subscribed and never
   * reused: a handler unsubscribed and subscribed again gets a new number, so
   * its first throw after that is a first occurrence, logged in full.
   */
  private readonly handlers = new Map<SimEventName, Map<AnyHandler, string>>();
  /** Every id with a live subscription, for the boundary's `isRegistered`. */
  private readonly liveIds = new Set<string>();
  /** The last registration number handed out. */
  private registrations = 0;
  /** The boundary around every handler call (#1560). */
  private readonly boundary: ErrorBoundary;

  constructor(logger: ILogger, options: EventBusOptions) {
    // A handler that unsubscribes itself and then throws leaves no error keys
    // behind: its `unsubscribe` ran before the throw was reported.
    this.boundary = createErrorBoundary({
      logger,
      policy: options.onHandlerError,
      now: options.errorClock,
      maxKeys: EVENT_BUS_REPORTER_MAX_KEYS,
      isRegistered: (id) => this.liveIds.has(id),
    });
  }

  publish<T extends SimEventName>(event: SimEventOf<T>): void {
    const name = event.event as SimEventName;
    const registered = this.handlers.get(name);

    if (!registered || registered.size === 0) return;

    // Snapshot so handlers that unsubscribe (their own or others') during
    // dispatch don't mutate the map we're iterating, and a handler subscribed
    // during dispatch is first called on the next publish.
    const snapshot = Array.from(registered, ([handler, id]) => [id, handler] as const);

    throwHeld(this.boundary.callEach(snapshot, (handler) => handler(event as SimEventOf<SimEventName>)));
  }

  subscribe<T extends SimEventName>(name: T, handler: EventHandler<T>): () => void {
    let registered = this.handlers.get(name);

    if (!registered) {
      registered = new Map();
      this.handlers.set(name, registered);
    }

    const anyHandler = handler as AnyHandler;

    // Subscribing a handler that is already subscribed to this name is a
    // no-op: it keeps its place and its id.
    if (!registered.has(anyHandler)) {
      this.registrations++;

      const fn = functionName(anyHandler);
      const id = `${EVENT_BUS_ERROR_ID_PREFIX}${name}#${this.registrations}${fn === "" ? "" : ` (${fn})`}`;

      registered.set(anyHandler, id);
      this.liveIds.add(id);
    }

    return () => this.unsubscribe(name, handler);
  }

  unsubscribe<T extends SimEventName>(name: T, handler: EventHandler<T>): void {
    const registered = this.handlers.get(name);

    if (!registered) return;

    const id = registered.get(handler as AnyHandler);

    if (id === undefined) return;

    registered.delete(handler as AnyHandler);
    this.liveIds.delete(id);
    // Flushes the handler's unreported counts as one `warn` line and drops its
    // keys, so handlers that come and go do not fill the reporter's table.
    this.boundary.forget(id);

    if (registered.size === 0) {
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
export function initializeEventBus(logger: ILogger = silentLogger, options: EventBusOptions = {}): IEventBus {
  if (eventBus) {
    throw new Error("Event bus already initialized. initializeEventBus() should only be called once.");
  }

  // Construct and log before publishing the singleton so a throwing logger
  // cannot leave the module in a half-initialized state where
  // isEventBusInitialized() returns true but the caller saw an exception.
  const bus = new EventBus(logger, options);
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
