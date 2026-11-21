import { type ILogger, LogLevel } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepeatController } from "./repeat-controller.js";

function createSpyLogger(): ILogger & {
  trace: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: (_level: LogLevel): ILogger => logger,
    createScope: (_scope: string): ILogger => logger,
  };

  return logger;
}

const DEFAULTS = {
  holdMs: 400,
  intervalMs: 100,
  safetyMs: 15_000,
};

describe("RepeatController", () => {
  let logger: ReturnType<typeof createSpyLogger>;
  let controller: RepeatController;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createSpyLogger();
    controller = new RepeatController(logger);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("quick tap (shorter than holdMs)", () => {
    it("never invokes execute when released before the hold threshold", async () => {
      const execute = vi.fn().mockResolvedValue(true);

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      await vi.advanceTimersByTimeAsync(399);
      controller.onKeyUp("btn");
      await vi.advanceTimersByTimeAsync(5_000);

      expect(execute).not.toHaveBeenCalled();
    });

    it("never invokes execute when released exactly at the hold threshold - 1 ms", async () => {
      const execute = vi.fn().mockResolvedValue(true);

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      await vi.advanceTimersByTimeAsync(399);
      controller.onKeyUp("btn");

      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("sustained hold", () => {
    it("fires execute once per intervalMs after holdMs", async () => {
      const execute = vi.fn().mockResolvedValue(true);

      controller.onKeyDown("btn", { ...DEFAULTS, execute });

      // Before hold threshold: nothing
      await vi.advanceTimersByTimeAsync(399);
      expect(execute).not.toHaveBeenCalled();

      // Cross the hold threshold — first repeat tick schedules
      await vi.advanceTimersByTimeAsync(1);
      // At this point the hold timer has fired and scheduled the first `next` timer.
      // The next tick itself has not yet run.
      expect(execute).not.toHaveBeenCalled();

      // First repeat tick fires after intervalMs
      await vi.advanceTimersByTimeAsync(100);
      expect(execute).toHaveBeenCalledTimes(1);

      // Second
      await vi.advanceTimersByTimeAsync(100);
      expect(execute).toHaveBeenCalledTimes(2);

      // Third
      await vi.advanceTimersByTimeAsync(100);
      expect(execute).toHaveBeenCalledTimes(3);

      controller.onKeyUp("btn");
    });
  });

  describe("execute returns false", () => {
    it("stops the loop when execute returns false", async () => {
      const execute = vi.fn().mockResolvedValueOnce(false);

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      await vi.advanceTimersByTimeAsync(500); // hold + first interval
      expect(execute).toHaveBeenCalledTimes(1);

      // No further calls even if button is still held
      await vi.advanceTimersByTimeAsync(5_000);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("stops the loop when a synchronous execute returns false", async () => {
      const execute = vi.fn(() => false);

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      await vi.advanceTimersByTimeAsync(500);
      expect(execute).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("onKeyUp during an in-flight async execute", () => {
    it("does not fire a further execute after the in-flight promise resolves", async () => {
      let resolveFirst!: (value: boolean) => void;
      const firstPromise = new Promise<boolean>((resolve) => {
        resolveFirst = resolve;
      });
      const execute = vi.fn<() => Promise<boolean>>().mockReturnValueOnce(firstPromise).mockResolvedValue(true);

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      await vi.advanceTimersByTimeAsync(500); // hold + first interval → in-flight
      expect(execute).toHaveBeenCalledTimes(1);

      // keyUp arrives while the first execute is still pending
      controller.onKeyUp("btn");

      // Now the first execute finally resolves
      resolveFirst(true);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("onKeyUp between ticks", () => {
    it("stops the loop immediately and never fires another execute", async () => {
      const execute = vi.fn().mockResolvedValue(true);

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      await vi.advanceTimersByTimeAsync(600); // hold + first + part of second
      expect(execute).toHaveBeenCalledTimes(2);

      controller.onKeyUp("btn");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  describe("clear", () => {
    it("behaves identically to onKeyUp", async () => {
      const execute = vi.fn().mockResolvedValue(true);

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      await vi.advanceTimersByTimeAsync(500);
      expect(execute).toHaveBeenCalledTimes(1);

      controller.clear("btn");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(controller.isHeld("btn")).toBe(false);
    });
  });

  describe("clearAll", () => {
    it("clears every held button", async () => {
      const exec1 = vi.fn().mockResolvedValue(true);
      const exec2 = vi.fn().mockResolvedValue(true);

      controller.onKeyDown("btn1", { ...DEFAULTS, execute: exec1 });
      controller.onKeyDown("btn2", { ...DEFAULTS, execute: exec2 });
      await vi.advanceTimersByTimeAsync(500);
      expect(exec1).toHaveBeenCalledTimes(1);
      expect(exec2).toHaveBeenCalledTimes(1);

      controller.clearAll();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(exec1).toHaveBeenCalledTimes(1);
      expect(exec2).toHaveBeenCalledTimes(1);
      expect(controller.isHeld("btn1")).toBe(false);
      expect(controller.isHeld("btn2")).toBe(false);
    });
  });

  describe("safety timeout", () => {
    it("auto-stops after safetyMs when keyUp is lost, logs a warning, and releases held state", async () => {
      const execute = vi.fn().mockResolvedValue(true);

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      // Let it repeat for a while
      await vi.advanceTimersByTimeAsync(14_999);
      expect(controller.isHeld("btn")).toBe(true);
      const callsBefore = execute.mock.calls.length;
      expect(callsBefore).toBeGreaterThan(0);

      // Cross the safety deadline
      await vi.advanceTimersByTimeAsync(2);

      expect(controller.isHeld("btn")).toBe(false);
      expect(logger.warn).toHaveBeenCalled();

      // No further calls after safety fires
      await vi.advanceTimersByTimeAsync(5_000);
      expect(execute.mock.calls.length).toBeLessThanOrEqual(callsBefore + 1);

      const finalCalls = execute.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(execute).toHaveBeenCalledTimes(finalCalls);
    });
  });

  describe("re-keyDown on an already-held button", () => {
    it("resets timers so a single stream of repeats happens, not two concurrent loops", async () => {
      const execute = vi.fn().mockResolvedValue(true);

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      await vi.advanceTimersByTimeAsync(500);
      expect(execute).toHaveBeenCalledTimes(1);

      // Second keyDown without a keyUp — should reset, not stack
      controller.onKeyDown("btn", { ...DEFAULTS, execute });

      // No extra calls just from the re-down
      expect(execute).toHaveBeenCalledTimes(1);

      // Drive one more full interval; only one call should be added, not two
      await vi.advanceTimersByTimeAsync(500);
      expect(execute).toHaveBeenCalledTimes(2);

      controller.onKeyUp("btn");
    });

    it("does not install a duplicate loop when a new onKeyDown replaces the entry during an in-flight async execute", async () => {
      // Race: the stale tick callback resumes from its await AFTER a new onKeyDown
      // has replaced the entry. Without ownership checking it would call
      // scheduleRepeatTick on the new entry, installing an orphan `next` timer
      // alongside the new entry's hold-timer-driven loop — two overlapping loops.
      let resolveFirst!: (value: boolean) => void;
      const firstPromise = new Promise<boolean>((resolve) => {
        resolveFirst = resolve;
      });
      const execute = vi.fn<() => Promise<boolean>>().mockReturnValueOnce(firstPromise).mockResolvedValue(true);

      // t=0: first press
      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      // t=500: hold (400) + first interval (100) fire → first execute awaited
      await vi.advanceTimersByTimeAsync(500);
      expect(execute).toHaveBeenCalledTimes(1);

      // t=500: overlapping onKeyDown replaces the entry while the first execute is mid-await.
      // The new entry's hold timer is armed at t=500, firing at t=900.
      controller.onKeyDown("btn", { ...DEFAULTS, execute });

      // Resolve the first execute and let its continuation run on the microtask queue.
      resolveFirst(true);
      await vi.advanceTimersByTimeAsync(0);

      // Advance to t=899 — still inside the new entry's hold phase (hold fires at t=900),
      // so a clean implementation must not have called execute again.
      await vi.advanceTimersByTimeAsync(399);
      expect(execute).toHaveBeenCalledTimes(1);

      controller.onKeyUp("btn");
    });
  });

  describe("multiple concurrent buttons", () => {
    it("repeats each button independently", async () => {
      const exec1 = vi.fn().mockResolvedValue(true);
      const exec2 = vi.fn().mockResolvedValue(true);

      controller.onKeyDown("btn1", { ...DEFAULTS, execute: exec1 });
      await vi.advanceTimersByTimeAsync(500);
      expect(exec1).toHaveBeenCalledTimes(1);

      controller.onKeyDown("btn2", { ...DEFAULTS, execute: exec2 });
      await vi.advanceTimersByTimeAsync(500);
      expect(exec1).toHaveBeenCalledTimes(6); // 5 more 100ms ticks
      expect(exec2).toHaveBeenCalledTimes(1);

      // Release btn1, btn2 keeps repeating
      controller.onKeyUp("btn1");
      await vi.advanceTimersByTimeAsync(300);
      expect(exec1).toHaveBeenCalledTimes(6);
      expect(exec2).toHaveBeenCalledTimes(4);

      controller.onKeyUp("btn2");
    });
  });

  describe("isHeld", () => {
    it("reflects current held state", () => {
      const execute = vi.fn().mockResolvedValue(true);

      expect(controller.isHeld("btn")).toBe(false);

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      expect(controller.isHeld("btn")).toBe(true);

      controller.onKeyUp("btn");
      expect(controller.isHeld("btn")).toBe(false);
    });
  });

  // #1693: the first repeat never overlaps the press the hold started with.
  describe("runFirstPress", () => {
    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
      let resolve!: (value: T) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });

      return { promise, resolve, reject };
    }

    it("starts the press synchronously and returns its result", async () => {
      const press = vi.fn(() => Promise.resolve("sent"));

      controller.onKeyDown("btn", { ...DEFAULTS, execute: vi.fn().mockResolvedValue(true) });
      const result = controller.runFirstPress("btn", press);

      expect(press).toHaveBeenCalledTimes(1);
      await expect(result).resolves.toBe("sent");
      controller.onKeyUp("btn");
    });

    it("keeps the first repeat at holdMs + intervalMs when the first press settles early", async () => {
      const execute = vi.fn().mockResolvedValue(true);

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      await controller.runFirstPress("btn", async () => true);

      await vi.advanceTimersByTimeAsync(499);
      expect(execute).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(execute).toHaveBeenCalledTimes(1);
      controller.onKeyUp("btn");
    });

    it("holds the first repeat until a stalled first press settles, then follows it by intervalMs", async () => {
      const execute = vi.fn().mockResolvedValue(true);
      const first = deferred<boolean>();

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      const result = controller.runFirstPress("btn", () => first.promise);

      // Well past holdMs + intervalMs: the stalled first press is still in flight.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(execute).not.toHaveBeenCalled();

      first.resolve(true);
      await expect(result).resolves.toBe(true);

      await vi.advanceTimersByTimeAsync(99);
      expect(execute).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(execute).toHaveBeenCalledTimes(1);

      // The loop runs on its own spacing from there.
      await vi.advanceTimersByTimeAsync(100);
      expect(execute).toHaveBeenCalledTimes(2);
      controller.onKeyUp("btn");
    });

    it("never runs a repeat while the first press is in flight", async () => {
      let inFlight = 0;
      let overlapped = false;
      const first = deferred<void>();
      const execute = vi.fn(async () => {
        if (inFlight > 0) overlapped = true;

        return true;
      });

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      void controller.runFirstPress("btn", async () => {
        inFlight += 1;
        await first.promise;
        inFlight -= 1;
      });

      await vi.advanceTimersByTimeAsync(2_000);
      first.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(execute).toHaveBeenCalled();
      expect(overlapped).toBe(false);
      controller.onKeyUp("btn");
    });

    it("still repeats after a first press that threw, and hands the caller the error", async () => {
      const execute = vi.fn().mockResolvedValue(true);
      const first = deferred<boolean>();

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      const result = controller.runFirstPress("btn", () => first.promise);
      const caught = result.catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(1_000);
      first.reject(new Error("tap failed"));
      expect(await caught).toEqual(new Error("tap failed"));

      await vi.advanceTimersByTimeAsync(100);
      expect(execute).toHaveBeenCalledTimes(1);
      controller.onKeyUp("btn");
    });

    it("starts no repeat when the key is released while the first press is in flight", async () => {
      const execute = vi.fn().mockResolvedValue(true);
      const first = deferred<boolean>();

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      void controller.runFirstPress("btn", () => first.promise);

      await vi.advanceTimersByTimeAsync(1_000);
      controller.onKeyUp("btn");
      first.resolve(true);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(execute).not.toHaveBeenCalled();
      expect(controller.timers.size).toBe(0);
    });

    it("leaves the loop to a newer press when the key is pressed again while the first press is in flight", async () => {
      const oldExecute = vi.fn().mockResolvedValue(true);
      const newExecute = vi.fn().mockResolvedValue(true);
      const first = deferred<boolean>();

      controller.onKeyDown("btn", { ...DEFAULTS, execute: oldExecute });
      void controller.runFirstPress("btn", () => first.promise);
      await vi.advanceTimersByTimeAsync(1_000);

      controller.onKeyDown("btn", { ...DEFAULTS, execute: newExecute });
      await controller.runFirstPress("btn", async () => true);
      first.resolve(true);

      await vi.advanceTimersByTimeAsync(500);
      expect(oldExecute).not.toHaveBeenCalled();
      expect(newExecute).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(newExecute).toHaveBeenCalledTimes(2);
      controller.onKeyUp("btn");
    });

    it("waits for every first press of the hold", async () => {
      const execute = vi.fn().mockResolvedValue(true);
      const quick = deferred<void>();
      const slow = deferred<void>();

      controller.onKeyDown("btn", { ...DEFAULTS, execute });
      void controller.runFirstPress("btn", () => slow.promise);
      void controller.runFirstPress("btn", () => quick.promise);

      quick.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(execute).not.toHaveBeenCalled();

      slow.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(execute).toHaveBeenCalledTimes(1);
      controller.onKeyUp("btn");
    });

    it("only runs the press when no hold is armed for the button", async () => {
      await expect(controller.runFirstPress("btn", () => 42)).resolves.toBe(42);
      expect(controller.timers.size).toBe(0);
    });
  });
});
