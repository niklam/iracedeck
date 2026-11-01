/**
 * The line ends (issue #1407, split out in #1514): a contract's `endsOn`
 * event ending its fires wherever they are — a pending trigger timer, a
 * waiting fire, the playing fire. It is the one feature that crosses every
 * boundary, and it crosses each through its interface: a timer through
 * `triggers.cancelPending`, a queue through `scheduler.dropWaiting` and
 * `scheduler.drain`, the playing fire through playback. It sees every bus's
 * transport half read-only and no bus's schedule (`BusTransportTableView`).
 * The three predicates that read a playing fire's position are exported for
 * their own tests.
 */
import type { IEventBus, SimEventName } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";

import type { ContractRegistry } from "./contract-registry.js";
import type { ActiveFireView, BusTransportTableView, CompiledScenario } from "./engine-types.js";
import type { Playback } from "./playback.js";
import type { Scheduler } from "./scheduler.js";
import type { Triggers } from "./triggers.js";

/** What the line ends reach of the other modules — only the members they use. */
export type LineEndsDeps = {
  /** The registered contracts, read at each arrival for the ones the event ends. */
  contracts: Pick<ContractRegistry, "entries">;
  /** The waiting fires, removed and logged; and the drain after a silent stop. */
  scheduler: Pick<Scheduler, "dropWaiting" | "drain">;
  /** A pending `triggerDelay` / `settle` timer. */
  triggers: Pick<Triggers, "cancelPending">;
  /** The playing fire: its cut tail, or a silent stop. */
  playback: Pick<Playback, "playCutTail" | "cancelActiveFire">;
};

export class LineEnds {
  /**
   * One bus subscription per distinct `endsOn` event (issue #1407), made when
   * the first contract naming that event registers and kept for the engine's
   * life: `endFires` reads the registered contracts at each arrival, so a
   * redefinition needs no new subscription. Unsubscribed by `dispose`.
   */
  private readonly endSubscriptions = new Map<SimEventName, () => void>();

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: ILogger,
    private readonly buses: BusTransportTableView,
    private readonly deps: LineEndsDeps,
  ) {}

  /** Watch a registered contract's `endsOn` event, if it has one. The last step of a registration that validated. */
  watch(entry: CompiledScenario): void {
    if (entry.raw.endsOn) this.subscribeToEnd(entry.raw.endsOn.event);
  }

  /** Every `endsOn` subscription released, for `dispose`. */
  dispose(): void {
    for (const unsubscribe of this.endSubscriptions.values()) unsubscribe();

    this.endSubscriptions.clear();
  }

  /**
   * Subscribe `endFires` to an `endsOn` event (issue #1407), once per distinct
   * event however many contracts name it. A contract is never ended by its
   * own trigger (validation refuses it), but the end can still race ANOTHER
   * contract that the same event triggers, because the bus dispatches in
   * subscription order: one triggered immediately (no `triggerDelay` /
   * `settle`), not `queueable`, on the same bus as a line this end stops
   * silently, plays only if `endFires` ran first — otherwise it meets the
   * busy bus and is dropped. That order is registration order, and not
   * stable: a redefined contract subscribes again at the end, while this
   * subscription keeps its place. Nothing hits it today — `pitLane.exited`
   * triggers only `limiter-on-track`, whose `triggerDelay` makes it a timer
   * that runs after every handler — but a new contract of that shape must
   * not rely on the order.
   */
  private subscribeToEnd(event: SimEventName): void {
    if (this.endSubscriptions.has(event)) return;

    this.endSubscriptions.set(
      event,
      this.eventBus.subscribe(event, () => this.endFires(event)),
    );
  }

  /**
   * End every fire of every contract whose `endsOn` names `event` (issue
   * #1407), wherever it is: a pending `triggerDelay` / `settle` timer is
   * cleared, a waiting fire (an interrupt's stash included) is removed and
   * logged as dropped with the reason `ended`, and the playing fire either
   * plays its cut tail (`playCutTail`) — once words have been heard and the
   * tail is not empty — or is stopped silently and the bus drained, as a
   * disable does. A fire whose line has been heard in full (`lineFinished`:
   * no body clip left from the op in flight on — it is in its close ops, or
   * in a trailing pause after its last clip) is left to finish, so the
   * driver never hears "never mind" after a complete line. A fire that is
   * already a cut tail (`ended`) is left alone too, so a second end — a tow
   * or a reset can publish the exit twice — is a no-op. One debug line per
   * contract that had anything to end.
   *
   * Two passes: every timer and waiting fire goes first, so a silent stop's
   * drain can never start a fire of another contract this same event is
   * about to end.
   */
  private endFires(event: SimEventName): void {
    const ending = [...this.deps.contracts.entries.values()].filter((entry) => entry.raw.endsOn?.event === event);
    const outcomes = new Map<string, string[]>();
    const note = (id: string, outcome: string): void => {
      outcomes.set(id, [...(outcomes.get(id) ?? []), outcome]);
    };

    for (const entry of ending) {
      const id = entry.raw.id;

      if (this.deps.triggers.cancelPending(entry)) note(id, "pending");

      for (const [bus] of this.buses.entries()) {
        if (!this.deps.scheduler.dropWaiting(bus, id, { kind: "ended" })) continue;

        note(id, "waiting");
      }
    }

    for (const entry of ending) {
      const id = entry.raw.id;

      for (const [bus, state] of this.buses.entries()) {
        const fire = state.transport.active;

        if (fire === null || fire.id !== id || fire.ended) continue;

        if (lineFinished(fire)) {
          note(id, "playing → closing");
        } else if (fire.cutTail.length > 0 && wordsHeard(fire)) {
          this.deps.playback.playCutTail(bus);
          note(id, "playing → tail");
        } else {
          this.deps.playback.cancelActiveFire(bus);
          this.deps.scheduler.drain(bus);
          note(id, "playing → silent");
        }
      }
    }

    for (const [id, outcome] of outcomes) {
      this.logger.debug(`Scenario "${id}" ended by ${event} (${outcome.join(", ")})`);
    }
  }
}

/**
 * How many ops of a playing fire's FULL expansion (`sourceOps`) the driver has
 * started to hear (issue #1407) — the op in flight included, since `index`
 * points one past it. Judged against the source expansion rather than `ops`
 * so that a resumed fire is read by where its line actually is, not by its
 * re-key preroll: the ops before `sourceStart` were heard before the
 * interrupt, and the op at `sourceStart` was in flight when the interrupt cut
 * it, so a resumed fire has started at least `sourceStart + 1` source ops
 * even while its preroll (the first `prerollCount` ops of `ops`, a replay of
 * the open) is still playing. A fresh fire has `sourceOps === ops` and no
 * preroll, which makes this `index`.
 */
export function startedSourceOps(fire: ActiveFireView): number {
  const played = Math.max(0, fire.index - fire.prerollCount);

  return fire.sourceStart > 0 ? fire.sourceStart + Math.max(1, played) : played;
}

/**
 * Whether the driver has heard words of a playing fire (issue #1407), which
 * decides whether an end plays the cut tail or stops it silently: an op with
 * no frame tag — a body op — is among the source ops started
 * (`startedSourceOps`), so a body clip that has just started counts (words
 * started are words heard). A resumed fire is read by its source position:
 * one cut mid-body has been heard even while its re-key preroll plays, and
 * one cut inside a two-beep open has not, so it stops silently.
 *
 * Any untagged op counts, not only a clip: a body that began with a `pause`
 * or an `ambient` step would count as heard once that op is consumed, before
 * any clip has started. No script has such a body today; one that does
 * would get the tail a beat early, which errs towards closing the radio.
 */
export function wordsHeard(fire: ActiveFireView): boolean {
  return fire.sourceOps.slice(0, startedSourceOps(fire)).some((op) => op.frame === undefined);
}

/**
 * Whether a playing fire's line has been heard in full (issue #1407): it has
 * started, and no body clip (an untagged `play`) remains from the op in
 * flight on — it is in its close ops, or in a trailing pause or ambience op
 * after its last clip. An end then leaves it to finish rather than say
 * "never mind" after a complete line. While the last body clip is itself in
 * flight the line is still being spoken, so it does not count. Read against
 * the source expansion like `wordsHeard`, so a fire resumed into its close
 * counts as finished during its re-key preroll.
 */
export function lineFinished(fire: ActiveFireView): boolean {
  const started = startedSourceOps(fire);

  if (started === 0) return false;

  return !fire.sourceOps.slice(started - 1).some((op) => op.kind === "play" && op.frame === undefined);
}
