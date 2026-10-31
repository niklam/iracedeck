import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { now, type PollControl, pollUntil, sleep } from "./engine-clock.js";
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

  describe("what the poll gained for the settle loops (#1502)", () => {
    it("awaits an async check, judging the deadline after it", async () => {
      const answers = [undefined, undefined, "held"];
      const check = vi.fn(async () => {
        await sleep(10);

        return answers.shift();
      });
      const start = Date.now();
      let settledAt: number | null = null;

      const result = pollUntil(check, { intervalMs: 50, timeoutMs: 1000 }).then((value) => {
        settledAt = Date.now();

        return value;
      });

      await vi.advanceTimersByTimeAsync(200);

      expect(await result).toEqual({ kind: "done", value: "held" });
      expect(check).toHaveBeenCalledTimes(3);
      // Three checks of 10 ms, and a sleep of 50 between each two.
      expect(settledAt).toBe(start + 130);
    });

    it("does not await a synchronous check: a first answer resolves in one tick", async () => {
      let outcome: unknown = null;

      void pollUntil(() => 1, { intervalMs: 50, timeoutMs: 100 }).then((value) => {
        outcome = value;
      });

      await Promise.resolve();
      expect(outcome).toEqual({ kind: "done", value: 1 });
    });

    it("gives up at once on a NaN bound, as the loops it replaced did", async () => {
      const check = vi.fn((): undefined => undefined);

      expect(await pollUntil(check, { intervalMs: 50, timeoutMs: Number.NaN })).toEqual({ kind: "timed-out" });
      expect(check).toHaveBeenCalledTimes(1);
      expect(await pollUntil(check, { intervalMs: 50, timeoutMs: 100, maxWaitMs: Number.NaN })).toEqual({
        kind: "timed-out",
      });
      expect(await pollUntil(check, { intervalMs: 50, timeoutMs: Number.NaN, sleepFirst: true })).toEqual({
        kind: "timed-out",
      });
      expect(check).toHaveBeenCalledTimes(2);
    });

    it("gives up after an async check that ran past the deadline, without sleeping again", async () => {
      const check = vi.fn(async () => {
        await sleep(150);

        return undefined;
      });
      let outcome: unknown = null;

      void pollUntil(check, { intervalMs: 50, timeoutMs: 100 }).then((value) => {
        outcome = value;
      });

      await vi.advanceTimersByTimeAsync(149);
      expect(outcome).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toEqual({ kind: "timed-out" });
      expect(check).toHaveBeenCalledTimes(1);
    });

    it("rejects with what the check throws", async () => {
      const failed = pollUntil(
        () => {
          throw new Error("stopped");
        },
        { intervalMs: 50, timeoutMs: 100 },
      );

      await expect(failed).rejects.toThrow("stopped");
    });

    it("counts the bound from startedAt when given", async () => {
      const startedAt = Date.now();

      await vi.advanceTimersByTimeAsync(60);

      const check = vi.fn(() => undefined);
      let outcome: unknown = null;

      void pollUntil(check, { intervalMs: 50, timeoutMs: 100, startedAt }).then((value) => {
        outcome = value;
      });

      // 60 ms had passed at the call, so the check after one sleep of 50 is past the bound: 50 ms after the
      // call, where a bound counted from the call would have run to 100.
      await vi.advanceTimersByTimeAsync(49);
      expect(outcome).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toEqual({ kind: "timed-out" });
      expect(check).toHaveBeenCalledTimes(2);
    });

    it("with sleepFirst, sleeps before the first check", async () => {
      const check = vi.fn(() => (check.mock.calls.length === 2 ? "landed" : undefined));
      const start = Date.now();
      let settledAt: number | null = null;

      const result = pollUntil(check, { intervalMs: 50, timeoutMs: 1000, sleepFirst: true }).then((value) => {
        settledAt = Date.now();

        return value;
      });

      expect(check).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(49);
      expect(check).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(51);

      expect(await result).toEqual({ kind: "done", value: "landed" });
      expect(check).toHaveBeenCalledTimes(2);
      expect(settledAt).toBe(start + 100);
    });

    it("with sleepFirst and no time left, checks nothing", async () => {
      const check = vi.fn(() => "landed");

      expect(await pollUntil(check, { intervalMs: 50, timeoutMs: 0, sleepFirst: true })).toEqual({
        kind: "timed-out",
      });
      expect(check).not.toHaveBeenCalled();
    });

    it("with sleepFirst, checks once more after the sleep that reaches the deadline", async () => {
      const check = vi.fn(() => undefined);
      let outcome: unknown = null;

      void pollUntil(check, { intervalMs: 50, timeoutMs: 100, sleepFirst: true }).then((value) => {
        outcome = value;
      });

      await vi.advanceTimersByTimeAsync(100);

      // Sleeps from 0 and 50, a check after each; the second is at the deadline, and the wait then ends.
      expect(outcome).toEqual({ kind: "timed-out" });
      expect(check).toHaveBeenCalledTimes(2);
    });

    it("an extension restarts the timeout from the check that asked for it", async () => {
      const check = vi.fn((poll: PollControl) => {
        // The checks at 50 and 100 ms extend: the bound moves to 200 ms.
        if (check.mock.calls.length <= 2) poll.extend();

        return undefined;
      });
      let outcome: unknown = null;
      let endedAt: number | null = null;
      const start = Date.now();

      void pollUntil(check, { intervalMs: 50, timeoutMs: 100, sleepFirst: true }).then((value) => {
        outcome = value;
        endedAt = Date.now();
      });

      await vi.advanceTimersByTimeAsync(150);
      expect(outcome).toBeNull();

      await vi.advanceTimersByTimeAsync(50);
      expect(outcome).toEqual({ kind: "timed-out" });
      expect(endedAt).toBe(start + 200);
      expect(check).toHaveBeenCalledTimes(4);
    });

    it("maxWaitMs caps the extensions, from the start", async () => {
      const check = vi.fn((poll: PollControl) => {
        poll.extend();

        return undefined;
      });
      let endedAt: number | null = null;
      const start = Date.now();

      void pollUntil(check, { intervalMs: 50, timeoutMs: 100, maxWaitMs: 250, sleepFirst: true }).then(() => {
        endedAt = Date.now();
      });

      await vi.advanceTimersByTimeAsync(249);
      expect(endedAt).toBeNull();

      // Every check extends, so only the cap ends it: the check at 250 moves the timeout to 350, the cap holds.
      await vi.advanceTimersByTimeAsync(1);
      expect(endedAt).toBe(start + 250);
    });

    it("without an extension, the timeout is the bound however large maxWaitMs is", async () => {
      let endedAt: number | null = null;
      const start = Date.now();

      void pollUntil(() => undefined, { intervalMs: 50, timeoutMs: 100, maxWaitMs: 10_000 }).then(() => {
        endedAt = Date.now();
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(endedAt).toBe(start + 100);
    });
  });
});
