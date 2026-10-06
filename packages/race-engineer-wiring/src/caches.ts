import type { CornerNameSnapshot, LapCompletedSnapshot } from "@iracedeck/audio-scenarios/pit-crew";
import type { IEventBus, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";

/**
 * The `race.finished` payload the race-end snapshot composes with the driver
 * name (#569) — the catalog's own type, so the cache cannot drift from it.
 */
export type RaceFinishedPayload = SimEventOf<"race.finished">["data"];

/** The last payloads the Race Engineer's conditions read at fire time. */
export interface RaceEngineerCaches {
  lapCompleted(): LapCompletedSnapshot | null;
  cornerName(): CornerNameSnapshot | null;
  raceFinished(): RaceFinishedPayload | null;
  /** `Date.now()` of the last `incident.scored`, or null before the first this run. */
  lastIncidentAt(): number | null;
}

/**
 * Subscribe the plugin-side bus caches. Call BEFORE `registerPitCrew`: the
 * engine's own subscriptions to the same events must run after these, so a
 * scenario's `where:` clause reads a fresh cache (#555, #569, #888).
 */
export function subscribeRaceEngineerCaches(bus: IEventBus, logger: ILogger): RaceEngineerCaches {
  // Cache the most recent `lap.completed` payload so the lap-time scenario's
  // var resolvers can read frozen lap data at fire time (issue #555).
  // Subscribed BEFORE `registerPitCrew` (which subscribes the scenario engine
  // to the same event via `defineContract`) so this listener runs first and
  // the cache is up-to-date by the time the scenario evaluates its
  // `where:` predicate. The 2 000 ms initial pause in the scenario sequence
  // further guarantees the cache is populated by the time the var resolvers
  // run.
  const lapCompletedLogger = logger.createScope("LapCompleted");
  let lastLapCompleted: LapCompletedSnapshot | null = null;
  bus.subscribe("lap.completed", (ev) => {
    lastLapCompleted = ev.data;
    lapCompletedLogger.info(
      `lap=${ev.data.lap} time=${ev.data.lapTime.toFixed(3)} isBest=${ev.data.isBest} isFirstValid=${ev.data.isFirstValid} ` +
        `sessionType=${ev.data.sessionType ?? "?"} position=${ev.data.position ?? "?"} previousPosition=${ev.data.previousPosition ?? "?"} ` +
        `classPosition=${ev.data.classPosition ?? "?"} previousClassPosition=${ev.data.previousClassPosition ?? "?"} ` +
        `isMultiClass=${ev.data.isMultiClass ?? "?"} lapsSincePositionChange=${ev.data.lapsSincePositionChange ?? "?"}`,
    );
    lapCompletedLogger.debug(`payload: ${JSON.stringify(ev.data)}`);
  });

  // Cache the most recent `cornerName.approaching` payload so the corner-name
  // scenario's clip resolver reads it at fire time (issue #888) — the lap-time
  // subscription pattern. Subscribed BEFORE registerPitCrew so this listener
  // runs first and the cache is fresh when the scenario evaluates.
  let lastCornerName: CornerNameSnapshot | null = null;
  bus.subscribe("cornerName.approaching", (ev) => {
    lastCornerName = ev.data;
  });

  // Cache the most recent `race.finished` payload so the race-end scenario's
  // snapshot resolver can compose it with the PI-picked driver name at fire
  // time (issue #569). Subscribed BEFORE `registerPitCrew` so this listener
  // runs before the scenario engine's subscriber — by the time the scenario
  // evaluates its `where:` predicate the cache holds the just-fired payload.
  const raceFinishedLogger = logger.createScope("RaceFinished");
  let lastRaceFinished: RaceFinishedPayload | null = null;
  bus.subscribe("race.finished", (ev) => {
    lastRaceFinished = ev.data;
    raceFinishedLogger.info(
      `position=${ev.data.position} classPosition=${ev.data.classPosition ?? "?"} isMultiClass=${ev.data.isMultiClass ?? "?"}`,
    );
  });

  // Log overtake events for debugging (issue #574). The reaction scenarios read
  // `isLeader` straight off the event payload, and the position readouts read
  // LIVE telemetry at speak-time via `getLivePosition()` — so no per-event cache
  // is needed here, just observability.
  const overtakeLogger = logger.createScope("Overtake");
  bus.subscribe("overtake.completed", (ev) => {
    overtakeLogger.info(
      `gained position=${ev.data.position} previousPosition=${ev.data.previousPosition} isLeader=${ev.data.isLeader} ` +
        `gapBehindMeters=${ev.data.gapBehindMeters?.toFixed(1) ?? "?"} sustained=${ev.data.sustained}`,
    );
  });
  bus.subscribe("overtake.lost", (ev) => {
    overtakeLogger.info(
      `lost position=${ev.data.position} previousPosition=${ev.data.previousPosition} ` +
        `gapAheadMeters=${ev.data.gapAheadMeters?.toFixed(1) ?? "?"} sustained=${ev.data.sustained}`,
    );
  });

  // Track the most recent incident so the overtake gate can suppress callouts
  // for a swap caused by an incident (issue #574 follow-up). `null` until the
  // first incident this session. Read off the type-blind `incident.scored`
  // (#1122): a counted burst the translator could not type is still a moment.
  let lastIncidentAt: number | null = null;
  bus.subscribe("incident.scored", () => {
    lastIncidentAt = Date.now();
  });

  return {
    lapCompleted: () => lastLapCompleted,
    cornerName: () => lastCornerName,
    raceFinished: () => lastRaceFinished,
    lastIncidentAt: () => lastIncidentAt,
  };
}
