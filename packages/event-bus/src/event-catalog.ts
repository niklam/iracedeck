/**
 * Canonical sim-event catalog.
 *
 * The event catalog is the single source of truth for the names and shapes
 * of events that flow through `@iracedeck/event-bus`. Publishers and
 * subscribers both index into `SimEventMap` by event name and receive a
 * fully typed envelope.
 *
 * See `docs/plans/2026-04-19-audio-architecture-design.md` §6 for the
 * rationale behind the event names and the transition/value-change split.
 */

/**
 * Event envelope. Every published sim event carries the name, timestamp,
 * the current-tick telemetry snapshot, and an event-specific payload.
 *
 * `TTelemetry` defaults to `unknown` so this package stays sim-agnostic:
 * the canonical `SimEventMap` below binds every entry at the default. Sim
 * translators that want typed telemetry on subscribers' envelopes declare
 * their own bound envelope (e.g. `SimEvent<TEvent, TData, TelemetryData>`)
 * and expose it via a parallel typed map; the bus itself dispatches on
 * event name and does not need to know the telemetry type.
 */
export type SimEvent<TEvent extends string, TData, TTelemetry = unknown> = {
  event: TEvent;
  timestamp: number;
  telemetry: TTelemetry;
  data: TData;
};

/**
 * Payload type for events that carry no event-specific data beyond the
 * envelope. Pure transition events (e.g. `pitLane.entered`, `engine.startup`)
 * use this permanently; events that need a payload bind a concrete shape
 * in their catalog entry.
 */
export type EmptySimEventPayload = Record<string, never>;

/**
 * Discriminated union of every event the bus knows about, keyed by event
 * name. Each entry binds an event name to its payload type — adding an
 * event means adding an entry here.
 */
export type SimEventMap = {
  // ── Transition events (§6.1) — fire once on change ────────────────────────
  "pitLane.approaching": SimEvent<"pitLane.approaching", EmptySimEventPayload>;
  "pitLane.entered": SimEvent<"pitLane.entered", EmptySimEventPayload>;
  "pitLane.exited": SimEvent<"pitLane.exited", EmptySimEventPayload>;
  "pitStall.entered": SimEvent<"pitStall.entered", EmptySimEventPayload>;
  "pitStall.departed": SimEvent<"pitStall.departed", EmptySimEventPayload>;

  "flag.yellow.raised": SimEvent<"flag.yellow.raised", EmptySimEventPayload>;
  "flag.yellow.cleared": SimEvent<"flag.yellow.cleared", EmptySimEventPayload>;
  "flag.blue.raised": SimEvent<"flag.blue.raised", EmptySimEventPayload>;
  "flag.green.raised": SimEvent<"flag.green.raised", EmptySimEventPayload>;
  "flag.checkered.raised": SimEvent<"flag.checkered.raised", EmptySimEventPayload>;
  "flag.black.raised": SimEvent<"flag.black.raised", EmptySimEventPayload>;
  "flag.white.raised": SimEvent<"flag.white.raised", EmptySimEventPayload>;
  "flag.red.raised": SimEvent<"flag.red.raised", EmptySimEventPayload>;

  "tireService.changed": SimEvent<"tireService.changed", EmptySimEventPayload>;
  "pitService.toggled": SimEvent<"pitService.toggled", EmptySimEventPayload>;
  "carControl.drsToggled": SimEvent<"carControl.drsToggled", EmptySimEventPayload>;
  "carControl.p2pToggled": SimEvent<"carControl.p2pToggled", EmptySimEventPayload>;
  "carControl.limiterToggled": SimEvent<"carControl.limiterToggled", EmptySimEventPayload>;
  "limiter.dropped": SimEvent<"limiter.dropped", EmptySimEventPayload>;
  "limiter.missing": SimEvent<"limiter.missing", EmptySimEventPayload>;
  "limiter.speeding": SimEvent<"limiter.speeding", EmptySimEventPayload>;

  "incident.occurred": SimEvent<"incident.occurred", EmptySimEventPayload>;
  "offTrack.started": SimEvent<"offTrack.started", EmptySimEventPayload>;
  "offTrack.ended": SimEvent<"offTrack.ended", EmptySimEventPayload>;

  "overtake.completed": SimEvent<"overtake.completed", EmptySimEventPayload>;

  "driver.firstOnTrack": SimEvent<"driver.firstOnTrack", EmptySimEventPayload>;
  "session.changed": SimEvent<"session.changed", EmptySimEventPayload>;
  "engine.startup": SimEvent<"engine.startup", EmptySimEventPayload>;

  // ── Value-change events (§6.2) — emit new state when derived value changes
  "spotter.changed": SimEvent<"spotter.changed", EmptySimEventPayload>;
  "fuel.lapsRemaining.crossed": SimEvent<"fuel.lapsRemaining.crossed", EmptySimEventPayload>;
};

/** All event names the catalog supports. */
export type SimEventName = keyof SimEventMap;

/** The full envelope type for a given event name. */
export type SimEventOf<T extends SimEventName> = SimEventMap[T];
