/**
 * The error boundary a dispatcher puts around every callback it calls (#1558).
 *
 * `docs/superpowers/specs/2026-10-31-issue-1558-sdk-subscriber-isolation.md` decides
 * "an error boundary around every subscriber call, built once and used by every
 * dispatcher". This is that boundary. It composes the {@link BoundedErrorReporter},
 * which decides what a caught throw writes to the log, and owns the rest: the
 * per-call try/catch, the `succeeded` / `report` bookkeeping, and the policy.
 *
 * A dispatcher uses three calls:
 *
 * - {@link ErrorBoundary.call} for one callback (a subscriber),
 * - {@link ErrorBoundary.callEach} for a fan-out over many, which calls every one and
 *   keeps the first held error,
 * - {@link ErrorBoundary.run} for the dispatcher's own work (a poll, a connect attempt),
 *   which may itself fan out. A throw from the work is the dispatcher's, reported under
 *   the work's id; a held error the work returns from a fan-out inside it passes
 *   through untouched, so a subscriber's error is never reported a second time under
 *   the dispatcher's id.
 *
 * Each returns a {@link HeldError}, and the entry point the outside world called (a
 * timer callback, `subscribe`) ends with {@link throwHeld}. Under `"report"` every
 * held error is `undefined` and `throwHeld` does nothing.
 */
import {
  type BoundedErrorReporterOptions,
  createBoundedErrorReporter,
  type ErrorPolicy,
} from "./bounded-error-reporter.js";

/**
 * A throw caught under the `"rethrow"` policy and held until the dispatch it happened
 * in has reached every callback; `undefined` when nothing threw, or when the throw went
 * to the reporter. The wrapper object is what lets a callback that throws `undefined`
 * still be held.
 */
export type HeldError = { readonly error: unknown } | undefined;

/** Throws a held error, so an entry point surfaces it once its work is done. */
export function throwHeld(held: HeldError): void {
  if (held !== undefined) throw held.error;
}

export interface ErrorBoundaryOptions extends Omit<BoundedErrorReporterOptions, "now"> {
  /**
   * What a caught throw does. `"report"`, the default, hands it to the reporter under
   * the id it was caught under, and the dispatch carries on: nothing a callback throws
   * leaves the boundary. `"rethrow"` reports nothing and holds the throw instead: a
   * fan-out still reaches every callback, and the entry point then throws the first
   * error with {@link throwHeld}. Production code runs `"report"`; a test that wants
   * loudness chooses `"rethrow"`. The policy is injected, never read from the
   * environment. Anything but `"rethrow"`, `undefined` included, is `"report"`, so a
   * caller that forwards an unchecked option cannot turn reporting off.
   */
  policy?: ErrorPolicy;
  /** The reporter's clock, in milliseconds. Defaults to `Date.now()`, read on every call. */
  now?: () => number;
}

export interface ErrorBoundary {
  /** The normalised policy. */
  readonly policy: ErrorPolicy;
  /**
   * Call one callback registered as `id`. Its return value is ignored. A clean call
   * tells the reporter (which declares recovery after a quiet window); a throw is
   * reported under `id` and `undefined` returned, or under `"rethrow"` returned held.
   * Never throws.
   */
  call(id: string, callback: () => void): HeldError;
  /**
   * {@link call} every entry of `callbacks` in iteration order, each under its own id,
   * and return the first held error. A throw never stops the callbacks after it: under
   * `"rethrow"` every one is still called before the caller throws the first error.
   * Never throws.
   */
  callEach<T>(callbacks: Iterable<readonly [string, T]>, invoke: (callback: T, id: string) => void): HeldError;
  /**
   * Run the dispatcher's own work under `id`. A throw from `work` is handled as
   * {@link call} handles one. A held error `work` returns (from a {@link call} or
   * {@link callEach} inside it) passes through untouched and does not count as a clean
   * run. Never throws.
   */
  run(id: string, work: () => HeldError): HeldError;
  /** Flush `id`'s unreported counts as one `warn` line and drop them. Never throws. */
  forget(id: string): void;
}

/** Create a boundary. The ids are the caller's; a dispatcher prefixes its own work's ids. */
export function createErrorBoundary(options: ErrorBoundaryOptions): ErrorBoundary {
  const { policy: requested, now, ...reporterOptions } = options;
  const policy: ErrorPolicy = requested === "rethrow" ? "rethrow" : "report";
  const reporter = createBoundedErrorReporter({ ...reporterOptions, now: now ?? (() => Date.now()) });

  const caught = (id: string, error: unknown): HeldError => {
    if (policy === "rethrow") return { error };

    reporter.report(id, error);

    return undefined;
  };

  const call = (id: string, callback: () => void): HeldError => {
    try {
      callback();
    } catch (error) {
      return caught(id, error);
    }

    reporter.succeeded(id);

    return undefined;
  };

  return {
    policy,

    call,

    callEach<T>(callbacks: Iterable<readonly [string, T]>, invoke: (callback: T, id: string) => void): HeldError {
      let first: HeldError;

      for (const [id, callback] of callbacks) {
        // Call first, then keep the earliest: `first ??= call(…)` would stop calling
        // callbacks once one had been held.
        const held = call(id, () => invoke(callback, id));

        first ??= held;
      }

      return first;
    },

    run(id: string, work: () => HeldError): HeldError {
      let held: HeldError;

      try {
        held = work();
      } catch (error) {
        return caught(id, error);
      }

      if (held === undefined) reporter.succeeded(id);

      return held;
    },

    forget(id: string): void {
      reporter.forget(id);
    },
  };
}
