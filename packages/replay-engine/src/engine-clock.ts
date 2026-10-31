/**
 * The engine clock (#1467): every engine module reads the time through
 * `now()`, the injected `env.now()`, and sleeps through the one `sleep`, on a
 * real `setTimeout` — so a test fakes both together with fake timers.
 */
import { engineEnv } from "./replay-engine-env.js";

/** The engine's time, in milliseconds. */
export function now(): number {
  return engineEnv().now();
}

/** Wait `ms` on the real timer. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a {@link pollUntil} came to. */
export type PollResult<T> = { readonly kind: "done"; readonly value: T } | { readonly kind: "timed-out" };

/** What a {@link pollUntil} check may do besides answering. */
export interface PollControl {
  /**
   * Restart the timeout from now: the wait goes on until `timeoutMs` after
   * this moment, and never past `maxWaitMs` after the start. For a wait that
   * stays patient while iRacing shows a seek under way (#1275).
   */
  extend(): void;
}

/** How a {@link pollUntil} is paced and bounded. */
export interface PollOptions {
  /** The sleep between two checks. */
  readonly intervalMs: number;
  /** How long after the start the wait gives up, unless a check {@link PollControl.extend extends} it. */
  readonly timeoutMs: number;
  /**
   * The engine time the bound counts from, for a caller that read it before
   * something it does between then and the poll (a send, a first reading).
   * The time of the call when left out.
   */
  readonly startedAt?: number;
  /** The overall bound however often a check extends the timeout, from the start. None when left out. */
  readonly maxWaitMs?: number;
  /**
   * Sleep before the first check, for a wait on a command just sent, which a
   * reading taken at once cannot show yet. The bound is still judged before
   * that first sleep, so a wait with no time left checks nothing.
   */
  readonly sleepFirst?: boolean;
}

/**
 * Ask `check` until it returns a value or the deadline passes. It checks
 * first (after one sleep with `sleepFirst`), then judges the deadline by the
 * engine clock read after the check, then sleeps `intervalMs`; the deadline
 * is `timeoutMs` after the start, moved on by {@link PollControl.extend}.
 * Returning `undefined` means "not yet"; any other value ends the wait, so a
 * check reports its own early exits (a claim taken, a replay left) as values.
 *
 * `check` may be async. A synchronous one is not awaited, so a poll whose
 * first check answers resolves as soon as it would have without the helper.
 * A check that throws rejects the poll.
 */
export async function pollUntil<T>(
  check: (poll: PollControl) => T | undefined | Promise<T | undefined>,
  options: PollOptions,
): Promise<PollResult<T>> {
  const startedAt = options.startedAt ?? now();
  const latest = options.maxWaitMs === undefined ? Infinity : startedAt + options.maxWaitMs;
  let deadline = startedAt + options.timeoutMs;
  const poll: PollControl = {
    extend: () => {
      deadline = now() + options.timeoutMs;
    },
  };
  let checking = options.sleepFirst !== true;

  for (;;) {
    if (checking) {
      const answer = check(poll);
      const value = answer instanceof Promise ? await answer : answer;

      if (value !== undefined) return { kind: "done", value };
    }

    checking = true;

    // Written as "not before the deadline" so that a NaN bound gives up at once, as the loops it replaced did.
    if (!(now() < Math.min(deadline, latest))) return { kind: "timed-out" };

    await sleep(options.intervalMs);
  }
}
