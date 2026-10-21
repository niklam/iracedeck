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

/**
 * Ask `check` until it returns a value or the deadline passes. It checks
 * first, then sleeps `intervalMs` between checks; the deadline is
 * `timeoutMs` after the start, by the engine clock.
 */
export async function pollUntil<T>(
  check: () => T | undefined,
  options: { readonly intervalMs: number; readonly timeoutMs: number },
): Promise<PollResult<T>> {
  const deadline = now() + options.timeoutMs;

  for (;;) {
    const value = check();

    if (value !== undefined) return { kind: "done", value };

    if (now() >= deadline) return { kind: "timed-out" };

    await sleep(options.intervalMs);
  }
}
