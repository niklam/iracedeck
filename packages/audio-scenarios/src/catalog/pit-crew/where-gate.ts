/**
 * The shared `where:` gate (issue #1702) and the four wrappers built on it:
 * the Race Engineer master gate, the pit-action cooldown, the pit-service
 * request opt-in and the fuel countdown's session-kind gate, which
 * `registerPitCrew` (`index.ts`) applies at registration. A module of its own
 * rather than part of `index.ts`, the package's published `./pit-crew` entry,
 * so what `where-gate.test.ts` pins is not public API. `index.ts` keeps the
 * per-callout opt-in (`wrapCalloutScenario`), whose log line names the
 * callout id rather than the scenario's, and borrows {@link Gated} and
 * {@link gatedSettle} from here.
 */
import type { ILogger } from "@iracedeck/logger";

import type { ScenarioContract } from "../../dsl.js";

/**
 * What a gate wrapper needs of its input: an id (for the log line) and an
 * optional trigger whose `where:` it narrows. Both a legacy `Scenario` and a
 * `ScenarioContract` (issue #1064) satisfy it, and each wrapper is generic
 * over it so what goes in comes out with the same type — a contract never
 * grows a sequence by being gated.
 */
export type Gated = { id: string; when?: ScenarioContract["when"]; settle?: ScenarioContract["settle"] };

/**
 * The `settle` of a gated callout, answered as ready while the gate is closed
 * (issue #1284). The settle wait runs before `where:`, so without this a
 * callout switched off would still wait out its window and log `proceeding
 * without …` at info for a fire its gate then refuses — a line that reads as
 * a callout that went ahead. Absent when the scenario declares no settle.
 */
export function gatedSettle<T extends Gated>(s: T, isOpen: () => boolean): Pick<Gated, "settle"> {
  const settle = s.settle;

  if (!settle) return {};

  return { settle: { ...settle, pending: (ctx) => (isOpen() ? settle.pending(ctx) : null) } };
}

/**
 * The one `where:` gate body the master, pit-action cooldown, pit-service
 * request and fuel session-kind wrappers share:
 * consult `isOpen` on every event arrival, before the scenario's own `where:`,
 * and refuse the event while it is closed, logging `<suppressedLabel>: <id>`
 * at debug. Refusing before `attemptFire` means a clip already in flight is
 * never cut, only future events are suppressed. A declared `settle` answers
 * ready while the gate is closed ({@link gatedSettle}). A scenario with no
 * `when:` block is returned unchanged.
 *
 * Exported for the shared-gate tests (`where-gate.test.ts`).
 */
export function wrapWhereGate<T extends Gated>(
  s: T,
  isOpen: () => boolean,
  suppressedLabel: string,
  logger: ILogger | undefined,
): T {
  if (!s.when) return s;

  const baseWhere = s.when.where;

  return {
    ...s,
    ...gatedSettle(s, isOpen),
    when: {
      event: s.when.event,
      where: (ev) => {
        if (!isOpen()) {
          logger?.debug(`${suppressedLabel}: ${s.id}`);

          return false;
        }

        return baseWhere ? baseWhere(ev) : true;
      },
    },
  };
}

/**
 * Wrap a Race Engineer voice scenario with the plugin-wide master gate
 * (issue #515). Plugins compose the closure from
 * `pitCrewRaceEngineerEnabled === true`. Read live on every event
 * arrival and short-circuits before `attemptFire` so a clip already in
 * flight is NOT cut — only future events are suppressed. Applied as the
 * outermost wrapper inside `registerPitCrew` so a `false` master is the
 * cheapest possible early-out, ahead of per-callout opt-ins and
 * pit-action cooldowns.
 *
 * Returns the scenario unchanged when it has no `when:` block — a fragment
 * only ever reached through an `@` include (the radio frame was one until
 * issue #1064 moved it into the engine) runs inside a parent scenario whose
 * master-gate check has already passed.
 */
export function wrapRaceEngineerMasterGate<T extends Gated>(
  s: T,
  getEnabled: () => boolean,
  logger: ILogger | undefined,
): T {
  return wrapWhereGate(s, getEnabled, "race engineer master gate suppressed", logger);
}

/**
 * Wrap a per-toggle pit-action scenario so the cooldown set by
 * `pitLane.exited` / pre-start grid entry suppresses fires during the
 * cooldown window. Same gate-at-event-arrival shape as
 * `wrapCalloutScenario` (`index.ts`), but global rather than per-id.
 */
export function wrapPitActionScenario<T extends Gated>(
  s: T,
  getAllowed: () => boolean,
  logger: ILogger | undefined,
): T {
  return wrapWhereGate(s, getAllowed, "pit-action suppressed (cooldown active)", logger);
}

/**
 * Wrap a per-toggle pit-service-request scenario with the user opt-in
 * gate (`calloutEnabledPitServiceRequests`, issue #468). Read live so a
 * toggle off mid-session takes effect on the next event arrival without
 * cutting an in-flight clip — same gate-at-event-arrival shape as the
 * other wrappers.
 */
export function wrapPitServiceRequestsScenario<T extends Gated>(
  s: T,
  getEnabled: () => boolean,
  logger: ILogger | undefined,
): T {
  return wrapWhereGate(s, getEnabled, "pit service request suppressed", logger);
}

/**
 * Wrap a laps-of-fuel-left scenario with the family-wide session-kind gate
 * (`fuel-countdown-sessions`, issue #1702): whether the countdown is heard in
 * the kind of session being driven. Read live on every event arrival, so a
 * toggle flipped mid-session takes effect on the next count without cutting
 * an in-flight clip — the same gate-at-event-arrival shape as
 * {@link wrapPitServiceRequestsScenario}, through the same {@link wrapWhereGate}.
 */
export function wrapFuelCountdownSessionScenario<T extends Gated>(
  s: T,
  getEnabled: () => boolean,
  logger: ILogger | undefined,
): T {
  return wrapWhereGate(s, getEnabled, "fuel countdown suppressed in this session kind", logger);
}
