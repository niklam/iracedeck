import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { now, pollUntil, sleep } from "./engine-clock.js";
import { _configureReplayEngine, _resetReplayEngineEnv } from "./replay-engine-env.js";

describe("engine clock (#1467)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _configureReplayEngine({ now: () => Date.now() });
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetReplayEngineEnv();
  });

  it("reads the time through the engine env", () => {
    _configureReplayEngine({ now: () => 1234 });

    expect(now()).toBe(1234);
  });

  it("sleeps on the real timer", async () => {
    let woke = false;
    void sleep(100).then(() => {
      woke = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(woke).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(woke).toBe(true);
  });

  it("returns the first value the check gives", async () => {
    const answers = [undefined, undefined, 7];
    const check = vi.fn(() => answers.shift());
    const start = Date.now();
    let settledAt: number | null = null;

    const result = pollUntil(check, { intervalMs: 50, timeoutMs: 1000 }).then((value) => {
      settledAt = Date.now();

      return value;
    });

    // The first check runs before any sleep.
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);

    expect(await result).toEqual({ kind: "done", value: 7 });
    expect(check).toHaveBeenCalledTimes(3);
    expect(settledAt).toBe(start + 100);
  });

  it("times out by the engine clock", async () => {
    const check = vi.fn(() => undefined);
    let outcome: unknown = null;

    void pollUntil(check, { intervalMs: 50, timeoutMs: 100 }).then((value) => {
      outcome = value;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(outcome).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual({ kind: "timed-out" });
  });

  it("measures the deadline with the engine clock, not the wall clock", async () => {
    // An engine clock that runs ahead of the timers: the deadline has passed
    // by the second reading, before any timer has fired.
    let t = 0;
    _configureReplayEngine({
      now: () => {
        const reading = t;
        t += 1000;

        return reading;
      },
    });
    const check = vi.fn(() => undefined);

    expect(await pollUntil(check, { intervalMs: 50, timeoutMs: 100 })).toEqual({ kind: "timed-out" });
    expect(check).toHaveBeenCalledTimes(1);
  });
});
