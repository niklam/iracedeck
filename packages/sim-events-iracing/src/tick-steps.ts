/**
 * The step boundary of a translator tick (#1559).
 *
 * `docs/superpowers/specs/2026-10-31-issue-1559-translator-diff-isolation.md` decides
 * that a throw in one step of `handleTick` costs that step and no other: the step's
 * events for the tick are discarded, every later step still runs, and the step is
 * called again on the next tick. This module is that boundary. It owns no try/catch of
 * its own: every guarded call goes through one #1558 {@link ErrorBoundary}, created by
 * the caller and handed in, so the translator and the replay recorder share one
 * reporter table, and the boundary's policy (`"report"` / `"rethrow"`) is the policy.
 *
 * A tick uses five calls, each named by the function it guards and reported as
 * `<prefix><name>` (`translator:diffPitLane`, `replay-recorder:diffReplayLaps`):
 *
 * - {@link TickSteps.live} for a step that pushes into the tick's `pending` list,
 *   truncated back to its mark on a throw (decision 2);
 * - {@link TickSteps.direct} for a step that publishes directly (the pre-guard steps,
 *   the recorder's), whose events reach the sink when it returns and never on a throw;
 * - {@link TickSteps.run} for a step that emits nothing;
 * - {@link TickSteps.runUnit}, a {@link UnitRunner} a step hands to a diff that loops
 *   over independent cars, so one car's throw drops that car's events only and is
 *   reported under the enclosing step's id;
 * - {@link TickSteps.value}, {@link TickSteps.fallbackValue} and
 *   {@link TickSteps.requiredValue} for a value a step hands on, with the fallback
 *   decision 3 gives it.
 *
 * Under `"rethrow"` every step still runs; the runner keeps the first held error and
 * {@link TickSteps.finish}, called once per tick after the flush, throws it. Under
 * `"report"` nothing ever throws out of the runner.
 *
 * It imports nothing from iRacing and is generic over the event and the emit, so it
 * can move to a shared home unchanged once a second translator exists (decision 10).
 * It runs about fifty steps a tick at 60 Hz, so a guarded call allocates nothing of
 * its own: the work is parked in a field and run by a pre-bound invoker, ids are
 * cached per name, and the scratch lists are reused across calls.
 */
import { DEFAULT_MAX_ERROR_KEYS_PER_ID, type ErrorBoundary, type HeldError, throwHeld } from "@iracedeck/logger";

/**
 * Distinct throw sites the reporter tracks per step id: #1558's per-id default. The
 * translator sizes its global cap as its step and value ids times this (decision 7),
 * so the global cap is never what hides one step's first error.
 */
export const TICK_STEP_KEYS_PER_ID = DEFAULT_MAX_ERROR_KEYS_PER_ID;

/**
 * Runs one unit of a step (one car of a per-car loop): the events the unit hands its
 * `emit` are buffered and passed to the outer `emit` in order when the unit returns,
 * and dropped when it throws. Returns whether the unit completed. A diff takes one as
 * a parameter, defaulting to {@link runUnitsDirectly}; an `EmitFn<…>` passes as the
 * outer `emit` and the unit's `emit` has the same type, so no cast is needed.
 */
export type UnitRunner = <Ev>(emit: (event: Ev) => void, unit: (emit: (event: Ev) => void) => void) => boolean;

/**
 * The pass-through {@link UnitRunner}: calls the unit with the outer `emit` itself and
 * catches nothing, so a diff's own unit tests stay loud. A diff's default.
 */
export const runUnitsDirectly: UnitRunner = (emit, unit) => {
  unit(emit);

  return true;
};

/**
 * Where {@link TickSteps.value} keeps each value's last good answer, under the value's
 * name. Caller-owned (decision 3): the translator holds one per instance and clears it
 * on a session change and a disconnect. A name must always be read with the same type.
 */
export type ValueStore = Pick<Map<string, unknown>, "get" | "has" | "set">;

/** A value with no fallback: its answer, or `ok: false` when its resolver threw. */
export type RequiredValue<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

const UNAVAILABLE: RequiredValue<never> = Object.freeze({ ok: false });

export interface TickStepsOptions {
  /** The #1558 boundary every guarded call goes through; its policy is the runner's. */
  boundary: ErrorBoundary;
  /** Prepended to every name to make its reporter id: `translator:` or `replay-recorder:`. */
  prefix: string;
}

type AnyEmit = (event: unknown) => void;
type AnyUnit = (emit: AnyEmit) => void;

/**
 * Hand the events `scratch` holds from `mark` on to `target`, in order, then drop them.
 * A target that appends to `scratch` itself (a unit nested in a unit, whose outer emit
 * is the same buffer) leaves its copies in place of the originals.
 */
function commit(scratch: unknown[], mark: number, target: AnyEmit): void {
  const end = scratch.length;

  for (let i = mark; i < end; i++) target(scratch[i]);

  const added = scratch.length - end;

  if (added > 0) scratch.copyWithin(mark, end);

  scratch.length = mark + added;
}

/**
 * The step runner over one {@link ErrorBoundary}. One per `handleTick` owner (the
 * translator instance, the recorder), long-lived: it holds no per-tick state but the
 * first held error, which {@link finish} clears.
 */
export class TickSteps {
  private readonly boundary: ErrorBoundary;
  private readonly prefix: string;
  private readonly ids = new Map<string, string>();
  private held: HeldError;

  // The guarded call in progress, saved and restored around each one so calls nest. A
  // scratch list is truncated back to its mark by the caller of the guarded call when
  // the call did not complete, so no catch is written here: the boundary is the only one.
  private work: (() => void) | undefined;
  private completed = false;
  private currentId: string | undefined;

  private resolver: (() => unknown) | undefined;
  private resolved: unknown;
  private taken: unknown;

  private readonly directScratch: unknown[] = [];
  private directStep: AnyUnit | undefined;
  private directSink: AnyEmit | undefined;
  private directMark = 0;

  private readonly unitScratch: unknown[] = [];
  private unitWork: AnyUnit | undefined;
  private unitTarget: AnyEmit | undefined;
  private unitMark = 0;

  constructor(options: TickStepsOptions) {
    this.boundary = options.boundary;
    this.prefix = options.prefix;
  }

  /** The reporter id of `name`: `<prefix><name>`, built once per name. */
  stepId(name: string): string {
    let id = this.ids.get(name);

    if (id === undefined) {
      id = `${this.prefix}${name}`;
      this.ids.set(name, id);
    }

    return id;
  }

  /** Run a step that emits nothing. Returns whether it completed. Never throws. */
  run(name: string, step: () => void): boolean {
    return this.guard(this.stepId(name), step);
  }

  /**
   * Run a live step, which pushes its events into the tick's `pending` list. On a
   * throw `pending` is truncated back to its length before the step, so the step
   * commits all of its events or none. Returns whether it completed. Never throws.
   */
  live<Ev>(name: string, pending: Ev[], step: () => void): boolean {
    const mark = pending.length;
    const completed = this.guard(this.stepId(name), step);

    if (!completed) pending.length = mark;

    return completed;
  }

  /**
   * Run a step that publishes directly. Its `emit` buffers; when the step returns the
   * buffered events go to `sink` in order, and on a throw they are dropped and `sink`
   * is never called. A `sink` that throws is reported under the step's id and the
   * events after it are dropped. Returns whether the step and its publishes
   * completed. Never throws.
   */
  direct<Ev>(name: string, sink: (event: Ev) => void, step: (emit: (event: Ev) => void) => void): boolean {
    const outerStep = this.directStep;
    const outerSink = this.directSink;
    const outerMark = this.directMark;
    const mark = this.directScratch.length;

    this.directStep = step as AnyUnit;
    this.directSink = sink as AnyEmit;
    this.directMark = mark;

    const completed = this.guard(this.stepId(name), this.invokeDirect);

    if (!completed) this.directScratch.length = mark;

    this.directStep = outerStep;
    this.directSink = outerSink;
    this.directMark = outerMark;

    return completed;
  }

  /**
   * The {@link UnitRunner} for the step in progress: a unit that throws drops its own
   * events, is reported under the enclosing step's id (the reporter's throw-site key
   * keeps it apart from the step's other faults), and the step's other units still
   * run and commit. Called outside any step it runs the unit as
   * {@link runUnitsDirectly} does. Never throws inside a step.
   */
  readonly runUnit: UnitRunner = (emit, unit) => {
    const id = this.currentId;

    if (id === undefined) return runUnitsDirectly(emit, unit);

    const outerWork = this.unitWork;
    const outerTarget = this.unitTarget;
    const outerMark = this.unitMark;
    const mark = this.unitScratch.length;

    this.unitWork = unit as AnyUnit;
    this.unitTarget = emit as AnyEmit;
    this.unitMark = mark;

    const completed = this.guard(id, this.invokeUnit);

    if (!completed) this.unitScratch.length = mark;

    this.unitWork = outerWork;
    this.unitTarget = outerTarget;
    this.unitMark = outerMark;

    return completed;
  };

  /**
   * Resolve a value that falls back to its last value this session (decision 3). A
   * good answer is stored in `store` under `name` and returned; on a throw the stored
   * answer is returned when there is one, else `absent`, the answer the resolver gives
   * for absent session info. Never throws.
   */
  value<T>(name: string, store: ValueStore, absent: T, resolve: () => T): T {
    if (this.tryResolve(name, resolve)) {
      const value = this.take() as T;

      store.set(name, value);

      return value;
    }

    return store.has(name) ? (store.get(name) as T) : absent;
  }

  /**
   * Resolve a value with no last value: on a throw it is always `fallback`, however
   * many good answers came before (`resolvePlayerResultsSnapshot`,
   * `resolvePlayerIsLeader`). Never throws.
   */
  fallbackValue<T>(name: string, fallback: T, resolve: () => T): T {
    return this.tryResolve(name, resolve) ? (this.take() as T) : fallback;
  }

  /**
   * Resolve a value with no fallback (the canonical order, `stallVisit`): its answer,
   * or `ok: false` when the resolver threw, so the caller skips its consumers for the
   * tick. Never throws.
   */
  requiredValue<T>(name: string, resolve: () => T): RequiredValue<T> {
    return this.tryResolve(name, resolve) ? { ok: true, value: this.take() as T } : UNAVAILABLE;
  }

  /**
   * End the tick: under `"rethrow"`, throw the first error held since the last
   * `finish`, and clear it. Call it once per tick after the flush, in the same
   * `finally`, so a held error is never carried into the next tick. Under `"report"`
   * nothing is ever held and this does nothing.
   */
  finish(): void {
    const held = this.held;

    this.held = undefined;
    throwHeld(held);
  }

  /** Run `work` through the boundary under `id`, keep its held error if it is the first. */
  private guard(id: string, work: () => void): boolean {
    const outerWork = this.work;
    const outerCompleted = this.completed;
    const outerId = this.currentId;

    this.work = work;
    this.completed = false;
    this.currentId = id;

    const held = this.boundary.call(id, this.invokeWork);
    const completed = this.completed;

    this.work = outerWork;
    this.completed = outerCompleted;
    this.currentId = outerId;
    this.held ??= held;

    return completed;
  }

  private tryResolve(name: string, resolve: () => unknown): boolean {
    const outerResolver = this.resolver;
    const outerResolved = this.resolved;

    this.resolver = resolve;
    this.resolved = undefined;

    const completed = this.guard(this.stepId(name), this.invokeResolver);

    this.taken = this.resolved;
    this.resolver = outerResolver;
    this.resolved = outerResolved;

    return completed;
  }

  /** The answer {@link tryResolve} left, released so the runner holds no reference to it. */
  private take(): unknown {
    const taken = this.taken;

    this.taken = undefined;

    return taken;
  }

  private readonly invokeWork = (): void => {
    (this.work as () => void)();
    this.completed = true;
  };

  private readonly invokeResolver = (): void => {
    this.resolved = (this.resolver as () => unknown)();
  };

  private readonly pushDirect: AnyEmit = (event) => {
    this.directScratch.push(event);
  };

  private readonly invokeDirect = (): void => {
    (this.directStep as AnyUnit)(this.pushDirect);
    commit(this.directScratch, this.directMark, this.directSink as AnyEmit);
  };

  private readonly pushUnit: AnyEmit = (event) => {
    this.unitScratch.push(event);
  };

  private readonly invokeUnit = (): void => {
    (this.unitWork as AnyUnit)(this.pushUnit);
    commit(this.unitScratch, this.unitMark, this.unitTarget as AnyEmit);
  };
}
