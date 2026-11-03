/**
 * Per-context ordering of deck lifecycle events (#1597).
 *
 * No deck host serialises the events of one action context, and an action's
 * `onWillAppear` is async: a `willDisappear` that arrives while the appear is
 * still awaiting runs inside it, its unsubscribe finds nothing, and the appear
 * then subscribes a context that is gone. `ContextEventOrder` is the one place
 * the rules live; each adapter creates one instance and routes every
 * per-context host event of `registerAction` through {@link ContextEventOrder.enqueue}
 * inside the host callback, before any await of its own, so arrival order is
 * fixed at the enqueue and no adapter can add a hop.
 *
 * The rules (spec decisions 2–4):
 *
 * - **Exclusive kinds** — `willAppear`, `willDisappear`, `didReceiveSettings`
 *   and an adapter `step:<name>` — wait for every earlier event of the context,
 *   and every later event waits for them.
 * - **Input kinds** — `keyDown`, `keyUp`, `dialDown`, `dialUp`, `dialRotate`,
 *   `touchTap` — wait for earlier exclusive events only, never for earlier
 *   input, so two presses still run concurrently.
 * - **An input that waited keeps the spacing it arrived with.** Two inputs
 *   released together by one exclusive event would otherwise run back to
 *   back, and a hold measured between them (`withPressSounds`, the dial
 *   release classifier, dial acceleration's tick intervals) would read as
 *   0 ms. An input does not start sooner after the previous input of its
 *   context started than it arrived after that one arrived; it sleeps the
 *   remainder, pending all the while, so an exclusive event behind it waits
 *   for it. A release keeps its spacing from its press even when only the
 *   press was late; any other input with nothing ahead starts at arrival,
 *   which is where a context's delay ends.
 * - A task with nothing ahead runs **synchronously inside the enqueue call**,
 *   so an event that overlaps nothing reaches the handler at exactly the moment
 *   it does today.
 * - **Liveness** is decided at arrival: a context is live from the arrival of
 *   its `willAppear` to the arrival of its `willDisappear`. Input, a settings
 *   change, a step or a second `willDisappear` for a context that is not live
 *   is dropped at arrival and logged, and so is a `willAppear` for a context
 *   that is already live — a safety net: every adapter checks `isLive` at
 *   arrival first and delivers that appear as a `didReceiveSettings` with the
 *   frame's settings. A re-appear after a disappear stays on the same chain, so
 *   it runs after the teardown it follows.
 * - A task that **throws** settles like any other: the events behind it run,
 *   and the promise returned to the caller rejects with the handler's error.
 * - A wait is bounded by {@link CONTEXT_EVENT_WAIT_LIMIT_MS} per task ahead: a
 *   task that has been **running** that long is abandoned — warned once, never
 *   waited for again, and whoever waits on it is released. The limit is
 *   measured from the moment the task started, not from the waiter's arrival,
 *   so a task that merely queued behind the hung one is not abandoned the
 *   moment it gets to run; two hung handlers in a row cost two limits. Nothing
 *   is cancelled.
 *
 * It imports only the `ILogger` type, so it is host-neutral and sim-neutral.
 * Design record: docs/superpowers/specs/2026-11-02-issue-1597-lifecycle-event-ordering.md.
 */
import type { ILogger } from "@iracedeck/logger";

/**
 * How long a task may run before an event waiting on it runs anyway and
 * abandons it (decision 4). Above the longest legitimate handler found (a chat
 * send, about 7 s), so a correct handler is never overtaken; it bounds a hung
 * context to one stall per hung handler instead of a dead key until restart.
 */
export const CONTEXT_EVENT_WAIT_LIMIT_MS = 10_000;

/** The handler events an adapter dispatches per context, named as the hosts name them. */
export type ContextHandlerEventKind =
  | "willAppear"
  | "willDisappear"
  | "didReceiveSettings"
  | "keyDown"
  | "keyUp"
  | "dialDown"
  | "dialUp"
  | "dialRotate"
  | "touchTap";

/**
 * An adapter's own exclusive step for a context, named after the colon so the
 * log lines say what ran: `step:promoteToEncoder` is the Ulanzi promotion
 * (decision 5). It waits for and is waited for like a lifecycle event, and is
 * dropped for a context that is not live like input.
 */
export type ContextStepKind = `step:${string}`;

/** What {@link ContextEventOrder.enqueue} takes as the event's kind. */
export type ContextEventKind = ContextHandlerEventKind | ContextStepKind;

/**
 * What an adapter hands the order for one event: it builds the deck-core event
 * and calls the handler **when it runs**, not when it arrives, so a controller
 * or settings read inside it sees the state after the events ahead of it. One
 * host event that is several handler calls (Mirabox's atomic knob press) is one
 * task that makes them in sequence. May return nothing for a handler the
 * action does not implement.
 */
export type ContextEventTask = () => Promise<void> | void;

const EXCLUSIVE_KINDS: ReadonlySet<string> = new Set<ContextHandlerEventKind>([
  "willAppear",
  "willDisappear",
  "didReceiveSettings",
]);

/** Whether `kind` waits for every earlier event of its context and holds every later one. */
export function isExclusiveContextEventKind(kind: ContextEventKind): boolean {
  return EXCLUSIVE_KINDS.has(kind) || kind.startsWith("step:");
}

/** One enqueued task, from its arrival until it settles or is abandoned. */
interface Entry {
  readonly kind: ContextEventKind;
  readonly exclusive: boolean;
  /** `performance.now()` at the enqueue. */
  readonly arrivedAt: number;
  /** For an input: the input of the context that arrived before it, whose spacing it may have to keep. */
  readonly previousInput: Entry | undefined;
  /** Resolves when the task settles (either way) or is abandoned; never rejects. */
  readonly done: Promise<void>;
  readonly release: () => void;
  /** When the task is scheduled to start; set once nothing is ahead of it. */
  startAt: number | undefined;
  /** `performance.now()` when the task started running; `undefined` while it waits or is delayed. */
  startedAt: number | undefined;
  settled: boolean;
  abandoned: boolean;
}

/** One context's chain: its liveness, the tasks still worth waiting for, and the last input for spacing. */
interface ContextRecord {
  live: boolean;
  readonly pending: Entry[];
  lastInput: Entry | undefined;
}

/** Whether `kind` is the release of a press that `previous` began: the pair whose spacing is a hold. */
function isReleaseOf(kind: ContextEventKind, previous: ContextEventKind): boolean {
  return (kind === "keyUp" && previous === "keyDown") || (kind === "dialUp" && previous === "dialDown");
}

const noop = (): void => undefined;

/**
 * `promise`, with a no-op rejection handler attached so discarding it is never
 * an unhandled rejection; an awaiter still sees the rejection.
 */
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(noop);

  return promise;
}

/**
 * The per-context event order one adapter instance owns. Context ids are unique
 * per host and a context belongs to one action UUID, so one instance per
 * adapter orders every action's contexts.
 *
 * Usage in an adapter's `registerAction`, inside the host callback and before
 * any await of its own:
 *
 * ```ts
 * // A plain handler event. The task builds the event when it runs.
 * await this.order.enqueue(context, "keyDown", () => handler.onKeyDown?.(wrapEvent(data)));
 *
 * // A broadcast fires at arrival, for a live context only (decision 3) — gated
 * // on this order's liveness, never on the host's own store.
 * if (this.order.isLive(context)) for (const cb of this.keyDownCallbacks) cb();
 *
 * // One host event, two handler calls: one task keeps them atomic.
 * await this.order.enqueue(context, "dialDown", async () => {
 *   await handler.onDialDown?.(wrapEvent(data));
 *   await handler.onDialUp?.(wrapEvent(data));
 * });
 *
 * // An exclusive step enqueued ahead of the event that needs it. Its result is
 * // discarded on purpose: safe (never an unhandled rejection), but silent.
 * void this.order.enqueue(context, "step:promoteToEncoder", () => promote(context));
 * await this.order.enqueue(context, "dialRotate", () => handler.onDialRotate?.(wrapRotate(data)));
 *
 * // A host willAppear for a context that is already live is a settings change,
 * // not a second appear: every adapter converts it at arrival, so the order's
 * // own drop of a live willAppear is a safety net no adapter should reach.
 * if (this.order.isLive(context)) {
 *   return this.order.enqueue(context, "didReceiveSettings", () => handler.onDidReceiveSettings?.(wrapEvent(data)));
 * }
 * await this.order.enqueue(context, "willAppear", () => handler.onWillAppear?.(wrapEvent(data)));
 * ```
 *
 * Input, a settings change or a step for a context the host never appeared is
 * dropped on every host, with the once-per-context warn line: an adapter never
 * synthesises an appear for it, since no host hands it the context's settings
 * with the input, and an appear with empty settings would let the action's
 * first-appearance write wipe the key's stored settings.
 *
 * `enqueue` returns the task's own promise, so a host's dispatch logging sees
 * the handler's error as before; it returns `undefined` when the event was
 * dropped at arrival. **Await or catch the result; a discarded one is safe but
 * silent**: the promise already carries a no-op rejection handler, so dropping
 * it can never become an unhandled rejection, which would kill the plugin
 * process — the error then goes nowhere, which is why the handler events
 * themselves are awaited by the host dispatch that logs them.
 *
 * The synchronous fast path — a task with nothing ahead runs inside the
 * `enqueue` call — holds for the task lambda itself: `() => handler.onX?.(…)`
 * calls the handler synchronously, while an `async () => …` lambda is itself
 * a promise and starts the handler at once but settles no earlier than the
 * handler's promise.
 *
 * Memory: a record lives while its context is live or a task of it is pending,
 * and is pruned when neither holds. A task is pending until it settles or is
 * abandoned, whichever comes first, so a record whose last task hangs is pruned
 * when a waiter abandons that task, or when it settles if nothing ever waited.
 * `everAppeared` grows with distinct context ids, which a host reuses across
 * page switches.
 */
export class ContextEventOrder {
  private readonly records = new Map<string, ContextRecord>();
  /**
   * Every context whose `willAppear` has ever arrived, so a drop for a context
   * whose record was pruned after its disappear still logs "it has
   * disappeared" rather than the never-appeared warning. Grows with distinct
   * context ids, which a host reuses across page switches.
   */
  private readonly everAppeared = new Set<string>();
  /** Contexts whose never-appeared drop has been warned once; cleared when one appears after all. */
  private readonly warnedNeverAppeared = new Set<string>();

  constructor(private readonly logger: ILogger) {}

  /**
   * Whether `context` is on the device as far as arrivals go: its `willAppear`
   * has arrived and no `willDisappear` has since. The broadcasts an adapter
   * fires at arrival (`onKeyDown` / `onDialDown` / `onDialRotate`) fire only
   * when this is true, and an adapter step is only enqueued for a live context.
   */
  isLive(context: string): boolean {
    return this.records.get(context)?.live ?? false;
  }

  /**
   * Take one event of `context` at its arrival. Decides liveness and dropping
   * now; runs `task` synchronously when nothing it must wait for is pending,
   * otherwise once those tasks have settled (or {@link CONTEXT_EVENT_WAIT_LIMIT_MS}
   * has passed). Returns the task's promise — it rejects with whatever the
   * handler threw, and is safe to discard (see the class doc) — or `undefined`
   * when the event was dropped. Call it inside the host callback before any
   * await, so arrival order is the order here.
   */
  enqueue(context: string, kind: ContextEventKind, task: ContextEventTask): Promise<void> | undefined {
    const record = this.arrive(context, kind);

    if (record === undefined) return undefined;

    const exclusive = isExclusiveContextEventKind(kind);
    const ahead = record.pending.filter((entry) => exclusive || entry.exclusive);

    let release: () => void = noop;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry: Entry = {
      kind,
      exclusive,
      arrivedAt: performance.now(),
      previousInput: exclusive ? undefined : record.lastInput,
      done,
      release,
      startAt: undefined,
      startedAt: undefined,
      settled: false,
      abandoned: false,
    };

    record.pending.push(entry);

    if (!exclusive) record.lastInput = entry;

    const settle = (): void => {
      entry.settled = true;
      entry.release();
      this.forget(context, record, entry);
    };

    const run = (): Promise<void> => {
      entry.startedAt = performance.now();

      let value: Promise<void> | void;

      try {
        value = task();
      } catch (error) {
        // A synchronous throw is settled now, like a void return: nothing
        // waits behind it for a microtask.
        settle();

        return handled(Promise.reject<void>(error));
      }

      // A handler the action does not implement returns nothing: settled now,
      // so it never holds the chain, not even for a microtask.
      if (value === undefined) {
        settle();

        return Promise.resolve();
      }

      const result = Promise.resolve(value);

      result.then(settle, settle);

      return result;
    };

    // Nothing is ahead any more: run now, or — for an input that must keep the
    // spacing it arrived with — after the remainder of that spacing.
    const start = (): Promise<void> => {
      const now = performance.now();
      const startAt = this.spacedStart(entry, ahead.length > 0, now);

      entry.startAt = startAt;

      // A remainder under a millisecond is run now: no timer is finer, and two
      // inputs of one synchronous tick must not take a macrotask hop apart.
      if (startAt - now < 1) return run();

      return handled(
        new Promise<void>((resolve) => {
          setTimeout(() => resolve(run()), startAt - now);
        }),
      );
    };

    if (ahead.length === 0) return start();

    // The chained promise is a new one: it adopts the task's rejection, and a
    // caller that discards it must not make that an unhandled rejection.
    return handled(this.waitBehind(context, entry, ahead).then(start));
  }

  /**
   * When an input may start, `now` or later: not sooner after the previous
   * input of its context starts than it arrived after that input arrived
   * (`startAt >= previous.startAt + (arrivedAt - previous.arrivedAt)`), so two
   * inputs released together by one exclusive event keep the interval the user
   * put between them. The rule applies to an input that waited, to one whose
   * previous input has not started yet (it is delayed by this rule itself) and
   * to a release following its press (`keyUp` after `keyDown`, `dialUp` after
   * `dialDown`), whose spacing is the hold even when the press alone was late.
   * Any other input with nothing ahead starts at arrival: that is where a
   * context's delay ends, so a slow appear costs the presses that overlapped
   * it and not every press after it.
   */
  private spacedStart(entry: Entry, waited: boolean, now: number): number {
    const previous = entry.previousInput;

    if (previous?.startAt === undefined) return now;

    const keepsSpacing = waited || previous.startedAt === undefined || isReleaseOf(entry.kind, previous.kind);

    return keepsSpacing ? Math.max(now, previous.startAt + (entry.arrivedAt - previous.arrivedAt)) : now;
  }

  /**
   * The number of contexts with a record: live, or with a task still pending.
   * A context that disappeared and drained has none.
   *
   * @internal
   */
  get size(): number {
    return this.records.size;
  }

  /** Liveness and dropping at arrival; the record to enqueue on, or `undefined` for a drop. */
  private arrive(context: string, kind: ContextEventKind): ContextRecord | undefined {
    const existing = this.records.get(context);

    if (kind === "willAppear") {
      if (existing?.live) {
        this.logger.debug(`Dropped willAppear for ${context}: it is already live`);

        return undefined;
      }

      this.everAppeared.add(context);
      this.warnedNeverAppeared.delete(context);

      if (existing !== undefined) {
        existing.live = true;

        return existing;
      }

      const record: ContextRecord = { live: true, pending: [], lastInput: undefined };

      this.records.set(context, record);

      return record;
    }

    if (existing?.live) {
      if (kind === "willDisappear") existing.live = false;

      return existing;
    }

    this.drop(context, kind);

    return undefined;
  }

  private drop(context: string, kind: ContextEventKind): void {
    if (this.everAppeared.has(context)) {
      this.logger.debug(`Dropped ${kind} for ${context}: it has disappeared`);

      return;
    }

    const line = `Dropped ${kind} for ${context}: it never appeared (the host sent no willAppear for it)`;

    // The once-per-context warn is for input, a settings change or a step: the
    // visible failure of the appear-before-input assumption. A stray disappear
    // for a context never seen is not that, and must not spend the warn.
    if (kind === "willDisappear" || this.warnedNeverAppeared.has(context)) {
      this.logger.debug(line);

      return;
    }

    this.warnedNeverAppeared.add(context);
    this.logger.warn(line);
  }

  /**
   * Wait for `ahead` to settle, abandoning any of them that has run for
   * {@link CONTEXT_EVENT_WAIT_LIMIT_MS}. One timer, armed for the earliest
   * deadline among the tasks ahead (a task not yet running gets the full limit
   * as a fallback and is re-timed from its real start when the timer fires),
   * existing only for the wait and cleared when it ends.
   */
  private waitBehind(context: string, entry: Entry, ahead: readonly Entry[]): Promise<void> {
    const arrivedAt = performance.now();
    const behind = ahead.map((other) => other.kind).join(", ");

    return new Promise<void>((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (): void => {
        if (finished) return;

        finished = true;
        clearTimeout(timer);
        this.logger.debug(
          `${entry.kind} for ${context} waited ${Math.round(performance.now() - arrivedAt)} ms behind ${behind}`,
        );
        resolve();
      };

      const arm = (): void => {
        if (finished) return;

        const now = performance.now();

        for (const other of ahead) {
          if (other.startedAt !== undefined && now - other.startedAt >= CONTEXT_EVENT_WAIT_LIMIT_MS) {
            this.abandon(context, other);
          }
        }

        const pending = ahead.filter((other) => !other.settled && !other.abandoned);

        // Nothing left to time: an abandoned task's `done` is released, so the
        // `Promise.all` below finishes this wait. Never finish here directly:
        // every waiter behind the same task must resume through that same chain,
        // in arrival order, whichever waiter's timer happened to fire first.
        if (pending.length === 0) return;

        const deadline = Math.min(...pending.map((other) => (other.startedAt ?? now) + CONTEXT_EVENT_WAIT_LIMIT_MS));

        timer = setTimeout(arm, Math.max(0, deadline - now));
      };

      arm();
      void Promise.all(ahead.map((other) => other.done)).then(finish);
    });
  }

  /** Stop waiting for `entry`, once: later events no longer see it, and whoever waits on it is released. */
  private abandon(context: string, entry: Entry): void {
    if (entry.settled || entry.abandoned) return;

    entry.abandoned = true;
    this.logger.warn(
      `${entry.kind} for ${context} has not settled after ${CONTEXT_EVENT_WAIT_LIMIT_MS} ms; later events no longer wait for it`,
    );

    const record = this.records.get(context);

    if (record !== undefined) this.forget(context, record, entry);

    entry.release();
  }

  /** Remove `entry` from the chain, and the record once it is neither live nor waited on. */
  private forget(context: string, record: ContextRecord, entry: Entry): void {
    const index = record.pending.indexOf(entry);

    if (index !== -1) record.pending.splice(index, 1);

    if (!record.live && record.pending.length === 0 && this.records.get(context) === record) {
      this.records.delete(context);
    }
  }
}
