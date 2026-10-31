/**
 * The triggers (issue #1514): a registered contract's `when` turned into a
 * subscription on `@iracedeck/event-bus`, and the event's arrival turned
 * into a call to the scheduler's `attemptFire` — or not: the contract's
 * `where`, its `triggerDelay` and its `settle` wait (issue #1284) are
 * decided here, and nothing here reads a bus. The module owns the two
 * per-contract fields that carry a trigger's state, `unsubscribe` and
 * `pendingTriggerTimer`; every other module clears a timer through
 * `cancelPending`.
 */
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";

import type { ContractRegistry } from "./contract-registry.js";
import type { ScenarioContext } from "./dsl.js";
import { type CompiledScenario, fireContext } from "./engine-types.js";
import type { Scheduler } from "./scheduler.js";

/** What the triggers read of the other modules — only the members they use. */
export type TriggersDeps = {
  /** The registered contracts: re-read at every arrival and every timer, and walked by `detachAll`. */
  contracts: Pick<ContractRegistry, "get" | "entries">;
  /** Where an event that passed its trigger goes. */
  scheduler: Pick<Scheduler, "attemptFire">;
};

export class Triggers {
  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: ILogger,
    private readonly deps: TriggersDeps,
  ) {}

  /**
   * Subscribe a registered contract's trigger, if it has one: a contract
   * without `when` never auto-fires (`engine.fire(id)` is its only trigger).
   * The last step of a registration that validated.
   */
  attach(entry: CompiledScenario): void {
    const { id, when } = entry.raw;

    if (when) entry.unsubscribe = this.subscribeToEvent(id, when.event, when.where);
  }

  /** Unsubscribe a contract's trigger — a redefinition, or `dispose`. Nothing for a contract that has none. */
  detach(entry: CompiledScenario): void {
    entry.unsubscribe?.();
    entry.unsubscribe = null;
  }

  /**
   * Cancel a contract's pending `triggerDelay` / `settle` timer (see
   * `CompiledScenario.pendingTriggerTimer`). Returns whether one was pending
   * — what an end records as its "pending" outcome (issue #1407).
   */
  cancelPending(entry: CompiledScenario): boolean {
    if (entry.pendingTriggerTimer === null) return false;

    clearTimeout(entry.pendingTriggerTimer);
    entry.pendingTriggerTimer = null;

    return true;
  }

  /** Every contract's trigger unsubscribed and every pending timer cancelled, for `dispose`. */
  detachAll(): void {
    for (const entry of this.deps.contracts.entries.values()) {
      this.detach(entry);
      this.cancelPending(entry);
    }
  }

  private subscribeToEvent(
    id: string,
    eventName: SimEventName,
    where: ((e: SimEventOf<SimEventName>) => boolean) | undefined,
  ): () => void {
    const handler = (ev: SimEventOf<SimEventName>) => {
      const entry = this.deps.contracts.get(id);

      if (!entry || !entry.enabled) return;

      const triggerDelay = entry.raw.triggerDelay ?? 0;
      const settle = entry.raw.settle;

      if (triggerDelay <= 0 && !settle) {
        // Immediate path — where: runs synchronously, attemptFire runs
        // synchronously. Var resolvers will read current state at this
        // moment.
        if (where) {
          try {
            if (!where(ev)) return;
          } catch (err) {
            this.logger.error(`Scenario "${id}" where() threw: ${err instanceof Error ? err.message : String(err)}`);

            return;
          }
        }

        this.deps.scheduler.attemptFire(entry, ev);

        return;
      }

      // Deferred path — wait `triggerDelay` ms before evaluating where: and
      // attempting fire. By the time the timer fires, both the predicate and
      // any var resolvers will read telemetry that has had time to settle
      // (critical for `session.changed` → race-start, where iRacing's
      // TrackWetness can read Unknown at the transition tick).
      //
      // A contract with `settle` (issue #1284) takes this path even with no
      // `triggerDelay`, and after the delay keeps asking `pending` until it
      // reports ready or the wait reaches `maxWaitMs` from the event's
      // arrival. Every hop reuses `pendingTriggerTimer`, so what cancels a
      // deferred fire — a newer event, a disable, a redefinition — cancels a
      // settle in progress too.
      //
      // Cancel any pending timer for this scenario so the most recent event
      // wins. Two rapid SessionNum advances would otherwise queue two fires.
      if (entry.pendingTriggerTimer !== null) {
        clearTimeout(entry.pendingTriggerTimer);
      }

      const arrivedAt = Date.now();
      let asks = 0;

      const onTimer = (): void => {
        entry.pendingTriggerTimer = null;

        // Re-check entry state — scenario may have been redefined or
        // disabled during the wait.
        const current = this.deps.contracts.get(id);

        if (!current || !current.enabled || current !== entry) return;

        if (settle) {
          const missing = this.settlePending(id, settle.pending, ev);
          const waited = Date.now() - arrivedAt;

          asks++;

          if (missing !== null) {
            const remaining = settle.maxWaitMs - waited;

            if (remaining > 0) {
              entry.pendingTriggerTimer = setTimeout(onTimer, Math.min(settle.pollMs, remaining));

              return;
            }

            this.logger.info(`Scenario "${id}" proceeding without ${missing} after ${waited} ms`);
          } else if (asks > 1) {
            this.logger.debug(`Scenario "${id}" settled after ${waited} ms`);
          }
        }

        if (where) {
          try {
            if (!where(ev)) return;
          } catch (err) {
            this.logger.error(
              `Scenario "${id}" where() threw (deferred): ${err instanceof Error ? err.message : String(err)}`,
            );

            return;
          }
        }

        this.deps.scheduler.attemptFire(current, ev);
      };

      entry.pendingTriggerTimer = setTimeout(onTimer, Math.max(triggerDelay, 0));
    };

    return this.eventBus.subscribe(eventName, handler);
  }

  /**
   * One ask of a contract's `settle.pending` (issue #1284), with the context
   * a vocabulary resolver would get for the same event. A throwing check is
   * logged at error and read as ready, so a bug in it cannot silence the
   * callout — the fire goes on to `where:` as if nothing were missing.
   */
  private settlePending(
    id: string,
    pending: (ctx: ScenarioContext) => string | null,
    event: SimEventOf<SimEventName>,
  ): string | null {
    try {
      return pending(fireContext(event));
    } catch (err) {
      this.logger.error(
        `Scenario "${id}" settle.pending() threw; proceeding as ready: ${err instanceof Error ? err.message : String(err)}`,
      );

      return null;
    }
  }
}
