import type { ILogger } from "@iracedeck/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTEXT_EVENT_WAIT_LIMIT_MS,
  type ContextEventKind,
  ContextEventOrder,
  isExclusiveContextEventKind,
} from "./context-event-order.js";

type MockLogger = ILogger & { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

function createLogger(): MockLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as MockLogger;
}

/** A promise the test opens by hand, standing in for a handler's await. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

/**
 * Fake timers that also fake `performance`, which the primitive measures the
 * limit with and which vitest leaves real by default.
 */
function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate", "Date", "performance"] });
}

/** Let every settled promise's continuation run (real timers). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * An order with a call log: each enqueued task records `<kind>` when it starts
 * and `<kind>:done` when it finishes, awaiting `gate` in between when given. A
 * task with neither a gate nor a throw is synchronous and returns nothing, like
 * a handler the action does not implement, so it is settled when the enqueue
 * returns; one with a gate or a throw is an async handler.
 */
function createRecorder() {
  const logger = createLogger();
  const order = new ContextEventOrder(logger);
  const calls: string[] = [];

  const enqueue = (
    context: string,
    kind: ContextEventKind,
    options: { gate?: Promise<void>; throws?: unknown; label?: string } = {},
  ): Promise<void> | undefined => {
    const label = options.label ?? kind;

    if (options.gate === undefined && options.throws === undefined) {
      return order.enqueue(context, kind, () => {
        calls.push(label, `${label}:done`);
      });
    }

    return order.enqueue(context, kind, async () => {
      calls.push(label);

      if (options.gate) await options.gate;

      if (options.throws !== undefined) throw options.throws;

      calls.push(`${label}:done`);
    });
  };

  return { order, logger, calls, enqueue };
}

describe("ContextEventOrder", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("kinds", () => {
    it("the lifecycle events and an adapter step are exclusive, input is not", () => {
      expect(isExclusiveContextEventKind("willAppear")).toBe(true);
      expect(isExclusiveContextEventKind("willDisappear")).toBe(true);
      expect(isExclusiveContextEventKind("didReceiveSettings")).toBe(true);
      expect(isExclusiveContextEventKind("step:promoteToEncoder")).toBe(true);

      for (const kind of ["keyDown", "keyUp", "dialDown", "dialUp", "dialRotate", "touchTap"] as const) {
        expect(isExclusiveContextEventKind(kind)).toBe(false);
      }
    });
  });

  describe("a task with nothing ahead", () => {
    it("runs before the enqueue call returns", () => {
      const { order } = createRecorder();
      let ran = false;

      const result = order.enqueue("ctx", "willAppear", () => {
        ran = true;
      });

      expect(ran).toBe(true);
      expect(result).toBeInstanceOf(Promise);
    });

    it("returns the task's own promise", async () => {
      const { order } = createRecorder();
      const result = order.enqueue("ctx", "willAppear", () => Promise.resolve());

      await expect(result).resolves.toBeUndefined();
    });

    it("a task that returns nothing is settled when the enqueue returns, so the next event runs synchronously too", () => {
      const { order, logger } = createRecorder();
      const ran: string[] = [];

      order.enqueue("ctx", "willAppear", () => {
        ran.push("appear");
      });
      order.enqueue("ctx", "keyDown", () => {
        ran.push("press");
      });

      expect(ran).toEqual(["appear", "press"]);
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it("a task that returns a promise holds the next event until it settles", async () => {
      const { order } = createRecorder();
      const ran: string[] = [];

      order.enqueue("ctx", "willAppear", async () => {
        ran.push("appear");
      });
      order.enqueue("ctx", "keyDown", () => {
        ran.push("press");
      });

      expect(ran).toEqual(["appear"]);

      await flush();

      expect(ran).toEqual(["appear", "press"]);
    });

    it("logs no wait", () => {
      const { logger, enqueue } = createRecorder();

      enqueue("ctx", "willAppear");
      enqueue("ctx", "keyDown");

      expect(logger.debug).not.toHaveBeenCalled();
    });
  });

  describe("what waits for what", () => {
    it("input waits for an earlier appear", async () => {
      const { calls, enqueue, logger } = createRecorder();
      const appear = gate();

      enqueue("ctx", "willAppear", { gate: appear.promise });
      enqueue("ctx", "keyDown");

      expect(calls).toEqual(["willAppear"]);

      appear.open();
      await flush();

      expect(calls).toEqual(["willAppear", "willAppear:done", "keyDown", "keyDown:done"]);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/^keyDown for ctx waited \d+ ms behind willAppear$/),
      );
    });

    it("input waits for an earlier settings change", async () => {
      const { calls, enqueue } = createRecorder();
      const settings = gate();

      enqueue("ctx", "willAppear");
      enqueue("ctx", "didReceiveSettings", { gate: settings.promise });
      enqueue("ctx", "dialRotate");

      expect(calls).toEqual(["willAppear", "willAppear:done", "didReceiveSettings"]);

      settings.open();
      await flush();

      expect(calls.slice(3)).toEqual(["didReceiveSettings:done", "dialRotate", "dialRotate:done"]);
    });

    it("two inputs both start before either settles", async () => {
      const { calls, enqueue } = createRecorder();
      const press = gate();

      enqueue("ctx", "willAppear");
      enqueue("ctx", "keyDown", { gate: press.promise, label: "press-1" });
      enqueue("ctx", "keyDown", { gate: press.promise, label: "press-2" });

      expect(calls).toEqual(["willAppear", "willAppear:done", "press-1", "press-2"]);

      press.open();
      await flush();

      expect(calls.slice(4)).toEqual(["press-1:done", "press-2:done"]);
    });

    it("an input behind an appear does not wait for the input ahead of it", async () => {
      const { calls, enqueue } = createRecorder();
      const appear = gate();
      const press = gate();

      enqueue("ctx", "willAppear", { gate: appear.promise });
      enqueue("ctx", "keyDown", { gate: press.promise, label: "press-1" });
      enqueue("ctx", "keyDown", { label: "press-2" });

      appear.open();
      await flush();

      // Both ran after the appear; the second did not wait for the first's gate.
      expect(calls).toEqual(["willAppear", "willAppear:done", "press-1", "press-2", "press-2:done"]);

      press.open();
      await flush();

      expect(calls.at(-1)).toBe("press-1:done");
    });

    it("a disappear waits for input in flight", async () => {
      const { calls, enqueue } = createRecorder();
      const press = gate();

      enqueue("ctx", "willAppear");
      enqueue("ctx", "keyDown", { gate: press.promise });
      enqueue("ctx", "willDisappear");

      expect(calls).toEqual(["willAppear", "willAppear:done", "keyDown"]);

      press.open();
      await flush();

      expect(calls.slice(3)).toEqual(["keyDown:done", "willDisappear", "willDisappear:done"]);
    });

    it("a settings change waits for an appear", async () => {
      const { calls, enqueue } = createRecorder();
      const appear = gate();

      enqueue("ctx", "willAppear", { gate: appear.promise });
      enqueue("ctx", "didReceiveSettings");

      expect(calls).toEqual(["willAppear"]);

      appear.open();
      await flush();

      expect(calls).toEqual(["willAppear", "willAppear:done", "didReceiveSettings", "didReceiveSettings:done"]);
    });

    it("an adapter step is exclusive both ways", async () => {
      const { calls, enqueue } = createRecorder();
      const appear = gate();
      const step = gate();

      enqueue("ctx", "willAppear", { gate: appear.promise });
      enqueue("ctx", "step:promoteToEncoder", { gate: step.promise });
      enqueue("ctx", "dialRotate");

      expect(calls).toEqual(["willAppear"]);

      appear.open();
      await flush();

      expect(calls).toEqual(["willAppear", "willAppear:done", "step:promoteToEncoder"]);

      step.open();
      await flush();

      expect(calls.slice(3)).toEqual(["step:promoteToEncoder:done", "dialRotate", "dialRotate:done"]);
    });

    it("no overtaking: an input then a disappear behind an appear run in that order", async () => {
      const { calls, enqueue } = createRecorder();
      const appear = gate();

      enqueue("ctx", "willAppear", { gate: appear.promise });
      enqueue("ctx", "keyDown");
      enqueue("ctx", "willDisappear");

      appear.open();
      await flush();

      expect(calls).toEqual([
        "willAppear",
        "willAppear:done",
        "keyDown",
        "keyDown:done",
        "willDisappear",
        "willDisappear:done",
      ]);
    });

    it("orders contexts independently", () => {
      const { calls, enqueue } = createRecorder();
      const appear = gate();

      enqueue("a", "willAppear", { gate: appear.promise });
      enqueue("b", "willAppear");
      enqueue("b", "keyDown");

      expect(calls).toEqual(["willAppear", "willAppear", "willAppear:done", "keyDown", "keyDown:done"]);
    });
  });

  describe("liveness", () => {
    it("is set at the appear's arrival and cleared at the disappear's, while the tasks still wait", () => {
      const { order, enqueue } = createRecorder();
      const appear = gate();

      expect(order.isLive("ctx")).toBe(false);

      enqueue("ctx", "willAppear", { gate: appear.promise });

      expect(order.isLive("ctx")).toBe(true);

      enqueue("ctx", "willDisappear");

      expect(order.isLive("ctx")).toBe(false);
    });

    it("drops input, a settings change and a second disappear after a disappear, at debug", async () => {
      const { order, logger, calls, enqueue } = createRecorder();

      enqueue("ctx", "willAppear");
      enqueue("ctx", "willDisappear");
      await flush();

      expect(enqueue("ctx", "keyDown")).toBeUndefined();
      expect(enqueue("ctx", "didReceiveSettings")).toBeUndefined();
      expect(enqueue("ctx", "step:promoteToEncoder")).toBeUndefined();
      expect(enqueue("ctx", "willDisappear")).toBeUndefined();
      expect(order.isLive("ctx")).toBe(false);

      expect(calls).toEqual(["willAppear", "willAppear:done", "willDisappear", "willDisappear:done"]);
      expect(logger.debug.mock.calls.map(([line]) => line)).toEqual([
        "Dropped keyDown for ctx: it has disappeared",
        "Dropped didReceiveSettings for ctx: it has disappeared",
        "Dropped step:promoteToEncoder for ctx: it has disappeared",
        "Dropped willDisappear for ctx: it has disappeared",
      ]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("drops input for a context that never appeared: one warn, then debug", () => {
      const { logger, calls, enqueue } = createRecorder();
      const line = "Dropped keyDown for ctx: it never appeared (the host sent no willAppear for it)";

      expect(enqueue("ctx", "keyDown")).toBeUndefined();
      expect(enqueue("ctx", "keyDown")).toBeUndefined();
      expect(enqueue("ctx", "willDisappear")).toBeUndefined();

      expect(calls).toEqual([]);
      expect(logger.warn.mock.calls).toEqual([[line]]);
      expect(logger.debug.mock.calls).toEqual([
        [line],
        ["Dropped willDisappear for ctx: it never appeared (the host sent no willAppear for it)"],
      ]);
    });

    it("a dropped willDisappear for a never-appeared context logs at debug and does not spend the warn", () => {
      const { logger, enqueue } = createRecorder();

      expect(enqueue("ctx", "willDisappear")).toBeUndefined();

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug.mock.calls).toEqual([
        ["Dropped willDisappear for ctx: it never appeared (the host sent no willAppear for it)"],
      ]);

      // The warn is still available for the input that follows.
      enqueue("ctx", "didReceiveSettings");

      expect(logger.warn.mock.calls).toEqual([
        ["Dropped didReceiveSettings for ctx: it never appeared (the host sent no willAppear for it)"],
      ]);
    });

    it("drops a willAppear for a context that is already live, at debug, keeping it live", async () => {
      const { order, logger, calls, enqueue } = createRecorder();
      const appear = gate();

      enqueue("ctx", "willAppear", { gate: appear.promise, label: "appear-1" });

      expect(enqueue("ctx", "willAppear", { label: "appear-2" })).toBeUndefined();
      expect(order.isLive("ctx")).toBe(true);
      expect(logger.debug.mock.calls).toEqual([["Dropped willAppear for ctx: it is already live"]]);
      expect(logger.warn).not.toHaveBeenCalled();

      appear.open();
      await flush();

      // The second appear never ran, and input still queues on the live context.
      expect(calls).toEqual(["appear-1", "appear-1:done"]);
      expect(enqueue("ctx", "keyDown")).toBeInstanceOf(Promise);
    });

    it("warns once per context, not once per order", () => {
      const { logger, enqueue } = createRecorder();

      enqueue("a", "keyDown");
      enqueue("b", "keyDown");
      enqueue("a", "keyDown");

      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("a re-appear after a disappear runs only after the teardown settles, and makes the context live again", async () => {
      const { order, calls, enqueue } = createRecorder();
      const teardown = gate();

      enqueue("ctx", "willAppear", { label: "appear-1" });
      enqueue("ctx", "willDisappear", { gate: teardown.promise });
      enqueue("ctx", "willAppear", { label: "appear-2" });

      expect(order.isLive("ctx")).toBe(true);
      expect(calls).toEqual(["appear-1", "appear-1:done", "willDisappear"]);

      // Input for the re-appeared context is live input: it queues behind the appear.
      expect(enqueue("ctx", "keyDown")).toBeInstanceOf(Promise);

      teardown.open();
      await flush();

      expect(calls.slice(3)).toEqual(["willDisappear:done", "appear-2", "appear-2:done", "keyDown", "keyDown:done"]);
    });

    it("a context that appeared, disappeared and drained is still reported as disappeared, not never-appeared", async () => {
      const { order, logger, enqueue } = createRecorder();

      enqueue("ctx", "willAppear");
      enqueue("ctx", "willDisappear");
      await flush();

      expect(order.size).toBe(0);

      enqueue("ctx", "keyDown");

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith("Dropped keyDown for ctx: it has disappeared");
    });
  });

  describe("a throwing handler", () => {
    it("settles its task so later events run, and the caller's promise rejects with its error", async () => {
      const { calls, enqueue } = createRecorder();
      const error = new Error("appear failed");

      const appear = enqueue("ctx", "willAppear", { throws: error });
      const press = enqueue("ctx", "keyDown");

      await expect(appear).rejects.toBe(error);
      await expect(press).resolves.toBeUndefined();
      expect(calls).toEqual(["willAppear", "keyDown", "keyDown:done"]);
    });

    it("a task that throws synchronously is a rejection, settled synchronously so the next event runs at once", async () => {
      const { order, logger } = createRecorder();
      const error = new Error("sync");

      const result = order.enqueue("ctx", "willAppear", () => {
        throw error;
      });

      let ran = false;

      // Before any microtask: the throw settled the task inside the enqueue call.
      order.enqueue("ctx", "keyDown", () => {
        ran = true;
      });

      expect(ran).toBe(true);
      expect(logger.debug).not.toHaveBeenCalled();
      await expect(result).rejects.toBe(error);
    });

    describe("a discarded result is never an unhandled rejection", () => {
      /**
       * Node reports an unhandled rejection after the microtask queue drains;
       * vitest's own listener would fail the run on one, so the suite's
       * listeners are set aside for the test and restored after it, and the
       * positive control is a real discarded rejection seen by the stand-in.
       */
      async function unhandledRejectionsDuring(act: () => void): Promise<unknown[]> {
        const suiteListeners = process.listeners("unhandledRejection");
        const seen: unknown[] = [];
        const listener = (reason: unknown): void => {
          seen.push(reason);
        };

        process.removeAllListeners("unhandledRejection");
        process.on("unhandledRejection", listener);

        try {
          act();
          await new Promise<void>((resolve) => setImmediate(resolve));
          await new Promise<void>((resolve) => setImmediate(resolve));
        } finally {
          process.removeListener("unhandledRejection", listener);

          for (const restored of suiteListeners) process.on("unhandledRejection", restored);
        }

        return seen;
      }

      it("sees a plain discarded rejection (positive control)", async () => {
        const error = new Error("control");

        await expect(
          unhandledRejectionsDuring(() => {
            void Promise.reject(error);
          }),
        ).resolves.toEqual([error]);
      });

      it("a waiting task that throws, with its result discarded", async () => {
        const { enqueue } = createRecorder();
        const appear = gate();

        enqueue("ctx", "willAppear", { gate: appear.promise });

        await expect(
          unhandledRejectionsDuring(() => {
            void enqueue("ctx", "keyDown", { throws: new Error("press failed") });
            appear.open();
          }),
        ).resolves.toEqual([]);
      });

      it("a task with nothing ahead that throws, with its result discarded", async () => {
        const { order } = createRecorder();

        await expect(
          unhandledRejectionsDuring(() => {
            void order.enqueue("ctx", "willAppear", async () => {
              throw new Error("appear failed");
            });
            void order.enqueue("ctx", "didReceiveSettings", () => {
              throw new Error("settings failed");
            });
          }),
        ).resolves.toEqual([]);
      });
    });

    it("a waiting task's promise rejects with its own handler's error", async () => {
      const { enqueue } = createRecorder();
      const appear = gate();
      const error = new Error("press failed");

      enqueue("ctx", "willAppear", { gate: appear.promise });
      const press = enqueue("ctx", "keyDown", { throws: error });

      appear.open();

      await expect(press).rejects.toBe(error);
    });
  });

  describe("a handler that never settles", () => {
    it("the next event runs at the limit, with one warning for what it stopped waiting for", async () => {
      useFakeClock();
      const { calls, logger, enqueue } = createRecorder();
      const never = gate();

      enqueue("ctx", "willAppear", { gate: never.promise });
      enqueue("ctx", "keyDown");

      await vi.advanceTimersByTimeAsync(CONTEXT_EVENT_WAIT_LIMIT_MS - 1);

      expect(calls).toEqual(["willAppear"]);
      expect(logger.warn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(calls).toEqual(["willAppear", "keyDown", "keyDown:done"]);
      expect(logger.warn.mock.calls).toEqual([
        ["willAppear for ctx has not settled after 10000 ms; later events no longer wait for it"],
      ]);
      expect(logger.debug).toHaveBeenCalledWith("keyDown for ctx waited 10000 ms behind willAppear");
    });

    it("a later lifecycle event does not wait for the abandoned task again", async () => {
      useFakeClock();
      const { calls, logger, enqueue } = createRecorder();
      const never = gate();

      enqueue("ctx", "willAppear", { gate: never.promise });
      enqueue("ctx", "keyDown");
      await vi.advanceTimersByTimeAsync(CONTEXT_EVENT_WAIT_LIMIT_MS);

      enqueue("ctx", "willDisappear");

      // Ran synchronously: nothing left to wait for.
      expect(calls).toEqual(["willAppear", "keyDown", "keyDown:done", "willDisappear", "willDisappear:done"]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a task already waiting on the abandoned one is released with it, in order", async () => {
      useFakeClock();
      const { calls, logger, enqueue } = createRecorder();
      const never = gate();
      const press = gate();

      enqueue("ctx", "willAppear", { gate: never.promise });
      enqueue("ctx", "keyDown", { gate: press.promise });
      // Waits for the appear and the press; the appear's abandonment must not make it wait its own 10 s.
      enqueue("ctx", "willDisappear");

      await vi.advanceTimersByTimeAsync(CONTEXT_EVENT_WAIT_LIMIT_MS);

      expect(calls).toEqual(["willAppear", "keyDown"]);

      press.open();
      await vi.advanceTimersByTimeAsync(0);

      expect(calls.slice(2)).toEqual(["keyDown:done", "willDisappear", "willDisappear:done"]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("measures the limit from the hung task's start, not from the waiter's arrival", async () => {
      useFakeClock();
      const { calls, logger, enqueue } = createRecorder();
      const never = gate();

      enqueue("ctx", "willAppear", { gate: never.promise });
      await vi.advanceTimersByTimeAsync(6_000);
      enqueue("ctx", "keyDown");
      await vi.advanceTimersByTimeAsync(CONTEXT_EVENT_WAIT_LIMIT_MS - 6_000 - 1);

      expect(calls).toEqual(["willAppear"]);

      await vi.advanceTimersByTimeAsync(1);

      expect(calls).toEqual(["willAppear", "keyDown", "keyDown:done"]);
      expect(logger.debug).toHaveBeenCalledWith("keyDown for ctx waited 4000 ms behind willAppear");
    });

    it("two hung handlers in a row cost one limit each, never overtaking a task that only just started", async () => {
      useFakeClock();
      const { calls, logger, enqueue } = createRecorder();
      const never = gate();

      enqueue("ctx", "willAppear", { gate: never.promise });
      enqueue("ctx", "didReceiveSettings", { gate: never.promise });
      enqueue("ctx", "keyDown");

      await vi.advanceTimersByTimeAsync(CONTEXT_EVENT_WAIT_LIMIT_MS);

      // The settings change abandoned the appear and started; the press waits for the settings change afresh.
      expect(calls).toEqual(["willAppear", "didReceiveSettings"]);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(CONTEXT_EVENT_WAIT_LIMIT_MS - 1);

      expect(calls).toEqual(["willAppear", "didReceiveSettings"]);

      await vi.advanceTimersByTimeAsync(1);

      expect(calls).toEqual(["willAppear", "didReceiveSettings", "keyDown", "keyDown:done"]);
      expect(logger.warn.mock.calls).toEqual([
        ["willAppear for ctx has not settled after 10000 ms; later events no longer wait for it"],
        ["didReceiveSettings for ctx has not settled after 10000 ms; later events no longer wait for it"],
      ]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("waiters behind the same hung task are released in arrival order, their deadlines being equal", async () => {
      useFakeClock();
      const { calls, logger, enqueue } = createRecorder();
      const never = gate();

      enqueue("ctx", "willAppear", { gate: never.promise });
      await vi.advanceTimersByTimeAsync(1_000);
      enqueue("ctx", "keyDown");
      await vi.advanceTimersByTimeAsync(1_000);
      enqueue("ctx", "keyUp");
      await vi.advanceTimersByTimeAsync(1_000);
      enqueue("ctx", "willDisappear");

      // Every deadline is the appear's start plus the limit, whenever the waiter arrived.
      await vi.advanceTimersByTimeAsync(CONTEXT_EVENT_WAIT_LIMIT_MS - 3_000 - 1);

      expect(calls).toEqual(["willAppear"]);

      await vi.advanceTimersByTimeAsync(1);

      expect(calls).toEqual([
        "willAppear",
        "keyDown",
        "keyDown:done",
        "keyUp",
        "keyUp:done",
        "willDisappear",
        "willDisappear:done",
      ]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("an abandoned task that settles late is not warned again and leaves nothing behind", async () => {
      useFakeClock();
      const { order, logger, enqueue } = createRecorder();
      const late = gate();

      enqueue("ctx", "willAppear", { gate: late.promise });
      enqueue("ctx", "keyDown");
      await vi.advanceTimersByTimeAsync(CONTEXT_EVENT_WAIT_LIMIT_MS);
      enqueue("ctx", "willDisappear");

      late.open();
      await vi.advanceTimersByTimeAsync(0);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(order.size).toBe(0);
    });

    it("leaves no timer pending after an ordinary overlap", async () => {
      useFakeClock();
      const { enqueue } = createRecorder();
      const appear = gate();

      enqueue("ctx", "willAppear", { gate: appear.promise });
      enqueue("ctx", "keyDown");

      expect(vi.getTimerCount()).toBe(1);

      appear.open();
      await vi.advanceTimersByTimeAsync(0);

      expect(vi.getTimerCount()).toBe(0);
    });

    it("needs no timer while nothing waits", () => {
      useFakeClock();
      const { enqueue } = createRecorder();

      enqueue("ctx", "willAppear");
      enqueue("ctx", "keyDown");

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("pruning", () => {
    it("keeps a record while a context is live or has a task pending", async () => {
      const { order, enqueue } = createRecorder();
      const teardown = gate();

      enqueue("ctx", "willAppear");

      expect(order.size).toBe(1);

      enqueue("ctx", "willDisappear", { gate: teardown.promise });

      expect(order.size).toBe(1);

      teardown.open();
      await flush();

      expect(order.size).toBe(0);
    });

    it("keeps no record for a context that only ever had dropped events", () => {
      const { order, enqueue } = createRecorder();

      enqueue("ctx", "keyDown");

      expect(order.size).toBe(0);
    });

    it("a re-appear during the teardown keeps one record, pruned once it disappears again", async () => {
      const { order, enqueue } = createRecorder();
      const teardown = gate();

      enqueue("ctx", "willAppear");
      enqueue("ctx", "willDisappear", { gate: teardown.promise });
      enqueue("ctx", "willAppear");

      teardown.open();
      await flush();

      expect(order.size).toBe(1);

      enqueue("ctx", "willDisappear");
      await flush();

      expect(order.size).toBe(0);
    });
  });
});
