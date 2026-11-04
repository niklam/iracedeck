import { DEFAULT_MAX_ERROR_KEYS, DEFAULT_MAX_ERROR_KEYS_PER_ID, type ILogger } from "@iracedeck/logger";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  _resetEventBus,
  EVENT_BUS_ERROR_ID_PREFIX,
  EVENT_BUS_REPORTER_MAX_KEYS,
  getEventBus,
  initializeEventBus,
  isEventBusInitialized,
} from "./event-bus.js";
import type { FlagScope, SimEvent, SimEventName, SimEventOf } from "./event-catalog.js";

function createMockLogger(): ILogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: vi.fn(),
    createScope: vi.fn(),
  } as unknown as ILogger;
}

// Helper: build a concrete envelope for a given event name. The helper
// handles the two names the suite uses directly; other tests build their
// own envelopes with typed payloads.
function envelope<T extends "pitLane.entered" | "flag.yellow.raised">(
  event: T,
  data?: T extends "flag.yellow.raised" ? { scope: FlagScope } : Record<string, never>,
): SimEventOf<T> {
  return {
    event,
    timestamp: 0,
    telemetry: undefined,
    data: (data ?? (event === "flag.yellow.raised" ? { scope: "local" } : {})) as SimEventOf<T>["data"],
  } as SimEventOf<T>;
}

describe("EventBus", () => {
  afterEach(() => {
    _resetEventBus();
  });

  describe("singleton lifecycle", () => {
    it("should not be initialized by default", () => {
      expect(isEventBusInitialized()).toBe(false);
    });

    it("should throw when getting before initialization", () => {
      expect(() => getEventBus()).toThrow("Event bus not initialized");
    });

    it("should initialize successfully", () => {
      const logger = createMockLogger();
      initializeEventBus(logger);
      expect(isEventBusInitialized()).toBe(true);
      expect(logger.info).toHaveBeenCalledWith("Event bus initialized");
    });

    it("should throw on double initialization", () => {
      initializeEventBus(createMockLogger());
      expect(() => initializeEventBus(createMockLogger())).toThrow("already initialized");
    });

    it("should reset for test isolation", () => {
      initializeEventBus(createMockLogger());
      expect(isEventBusInitialized()).toBe(true);
      _resetEventBus();
      expect(isEventBusInitialized()).toBe(false);
    });

    it("should default to silent logger when none provided", () => {
      // No throw, no reliance on provided logger.
      expect(() => initializeEventBus()).not.toThrow();
    });

    it("returns the same instance from initializeEventBus and getEventBus", () => {
      const bus = initializeEventBus(createMockLogger());
      expect(getEventBus()).toBe(bus);
    });

    it("does not partially initialize when the logger throws during init", () => {
      // If logger.info throws, callers see the exception; the singleton must
      // not be left assigned, otherwise isEventBusInitialized() lies and a
      // retry would hit the "already initialized" guard spuriously.
      const logger = createMockLogger();
      (logger.info as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("logger blew up");
      });

      expect(() => initializeEventBus(logger)).toThrow("logger blew up");
      expect(isEventBusInitialized()).toBe(false);
      expect(() => getEventBus()).toThrow("Event bus not initialized");
    });
  });

  describe("publish / subscribe", () => {
    it("is a no-op to publish with no subscribers", () => {
      const bus = initializeEventBus(createMockLogger());
      expect(() => bus.publish(envelope("pitLane.entered"))).not.toThrow();
    });

    it("invokes subscribers for matching event names only", () => {
      const bus = initializeEventBus(createMockLogger());
      const enteredHandler = vi.fn();
      const yellowHandler = vi.fn();

      bus.subscribe("pitLane.entered", enteredHandler);
      bus.subscribe("flag.yellow.raised", yellowHandler);

      bus.publish(envelope("pitLane.entered"));

      expect(enteredHandler).toHaveBeenCalledTimes(1);
      expect(yellowHandler).not.toHaveBeenCalled();
    });

    it("passes the full envelope to the handler", () => {
      const bus = initializeEventBus(createMockLogger());
      const handler = vi.fn();
      const event = envelope("pitLane.entered");

      bus.subscribe("pitLane.entered", handler);
      bus.publish(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("invokes every subscriber for an event", () => {
      const bus = initializeEventBus(createMockLogger());
      const a = vi.fn();
      const b = vi.fn();
      const c = vi.fn();

      bus.subscribe("pitLane.entered", a);
      bus.subscribe("pitLane.entered", b);
      bus.subscribe("pitLane.entered", c);

      bus.publish(envelope("pitLane.entered"));

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(c).toHaveBeenCalledTimes(1);
    });
  });

  describe("unsubscribe", () => {
    it("stops invoking the handler after unsubscribe", () => {
      const bus = initializeEventBus(createMockLogger());
      const handler = vi.fn();

      bus.subscribe("pitLane.entered", handler);
      bus.publish(envelope("pitLane.entered"));
      bus.unsubscribe("pitLane.entered", handler);
      bus.publish(envelope("pitLane.entered"));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("is a no-op to unsubscribe a handler that was never registered", () => {
      const bus = initializeEventBus(createMockLogger());
      const handler = vi.fn();
      expect(() => bus.unsubscribe("pitLane.entered", handler)).not.toThrow();
    });

    it("returns an unsubscribe function from subscribe", () => {
      const bus = initializeEventBus(createMockLogger());
      const handler = vi.fn();

      const off = bus.subscribe("pitLane.entered", handler);
      off();
      bus.publish(envelope("pitLane.entered"));

      expect(handler).not.toHaveBeenCalled();
    });

    it("still invokes a sibling handler that was unsubscribed during dispatch", () => {
      // Snapshot semantics: the set of handlers that fire is fixed at publish
      // time. Removing a pending handler mid-dispatch does not cancel it for
      // this tick; it takes effect on the next publish.
      const bus = initializeEventBus(createMockLogger());
      const b = vi.fn();
      const a = vi.fn(() => {
        bus.unsubscribe("pitLane.entered", b);
      });

      bus.subscribe("pitLane.entered", a);
      bus.subscribe("pitLane.entered", b);

      bus.publish(envelope("pitLane.entered"));

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1); // still fired — snapshot contract

      bus.publish(envelope("pitLane.entered"));
      expect(a).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledTimes(1); // unsubscription in effect now
    });

    it("does not invoke a handler subscribed during dispatch until the next publish", () => {
      // Snapshot semantics: a handler added mid-dispatch is invisible to the
      // current publish.
      const bus = initializeEventBus(createMockLogger());
      const c = vi.fn();
      const a = vi.fn(() => {
        bus.subscribe("pitLane.entered", c);
      });

      bus.subscribe("pitLane.entered", a);

      bus.publish(envelope("pitLane.entered"));
      expect(a).toHaveBeenCalledTimes(1);
      expect(c).not.toHaveBeenCalled();

      bus.publish(envelope("pitLane.entered"));
      expect(c).toHaveBeenCalledTimes(1);
    });

    it("invokes handlers in subscription order", () => {
      const bus = initializeEventBus(createMockLogger());
      const calls: string[] = [];

      bus.subscribe("pitLane.entered", () => calls.push("a"));
      bus.subscribe("pitLane.entered", () => calls.push("b"));
      bus.subscribe("pitLane.entered", () => calls.push("c"));

      bus.publish(envelope("pitLane.entered"));

      expect(calls).toEqual(["a", "b", "c"]);
    });

    it("allows a handler to unsubscribe itself during dispatch without affecting siblings", () => {
      const bus = initializeEventBus(createMockLogger());
      const b = vi.fn();
      const selfRemoving = vi.fn(() => {
        bus.unsubscribe("pitLane.entered", selfRemoving);
      });

      bus.subscribe("pitLane.entered", selfRemoving);
      bus.subscribe("pitLane.entered", b);

      bus.publish(envelope("pitLane.entered"));

      expect(selfRemoving).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);

      // Confirm the handler really was removed.
      bus.publish(envelope("pitLane.entered"));
      expect(selfRemoving).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(2);
    });
  });

  describe("error handling", () => {
    const calls = (fn: ILogger["error"]): string[] =>
      (fn as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);

    it("reports and continues when a handler throws", () => {
      const logger = createMockLogger();
      const bus = initializeEventBus(logger);

      // A plain function rather than vi.fn(), whose name ("Mock") the id would carry.
      let badCalls = 0;
      const bad = (): void => {
        badCalls++;
        throw new Error("boom");
      };
      const good = vi.fn();

      bus.subscribe("pitLane.entered", bad);
      bus.subscribe("pitLane.entered", good);

      expect(() => bus.publish(envelope("pitLane.entered"))).not.toThrow();

      expect(badCalls).toBe(1);
      expect(good).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      const logged = calls(logger.error)[0];
      expect(logged.startsWith(EVENT_BUS_ERROR_ID_PREFIX)).toBe(true);
      expect(logged).toMatch(/^event-bus:pitLane\.entered#1 \(bad\) threw: /);
      expect(logged).toContain("boom");
    });

    it("includes the stack trace when available", () => {
      const logger = createMockLogger();
      const bus = initializeEventBus(logger);

      bus.subscribe("pitLane.entered", () => {
        throw new Error("with-stack");
      });

      bus.publish(envelope("pitLane.entered"));

      // V8 error stacks begin with "Error: <message>\n    at ..."; asserting
      // on "at " confirms the stack is present rather than just the message.
      expect(calls(logger.error)[0]).toContain("at ");
    });

    it("names the handler's function in its id when it has one", () => {
      const logger = createMockLogger();
      const bus = initializeEventBus(logger);

      function onPitEntered(): void {
        throw new Error("named");
      }

      bus.subscribe("pitLane.entered", onPitEntered);
      bus.publish(envelope("pitLane.entered"));

      expect(calls(logger.error)[0]).toMatch(/^event-bus:pitLane\.entered#1 \(onPitEntered\) threw: /);
    });

    it("continues dispatching siblings even if the logger itself throws", () => {
      // Handler isolation is the contract — a misbehaving logger must not
      // block sibling handlers any more than a misbehaving handler can.
      const logger = createMockLogger();
      (logger.error as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("logger blew up");
      });
      const bus = initializeEventBus(logger);

      const good = vi.fn();
      bus.subscribe("pitLane.entered", () => {
        throw new Error("handler blew up");
      });
      bus.subscribe("pitLane.entered", good);

      expect(() => bus.publish(envelope("pitLane.entered"))).not.toThrow();
      expect(good).toHaveBeenCalledTimes(1);
    });

    it("handles non-Error throws", () => {
      const logger = createMockLogger();
      const bus = initializeEventBus(logger);

      bus.subscribe("pitLane.entered", () => {
        throw "string error";
      });

      bus.publish(envelope("pitLane.entered"));

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("string error"));
    });

    describe("bounded reporting (#1560)", () => {
      let now = 0;
      const clock = (): number => now;

      afterEach(() => {
        now = 0;
      });

      /** An unnamed handler that always throws (a vi.fn() is named "Mock", which the id would carry). */
      function throwingHandler(): () => void {
        return () => {
          throw new Error("always");
        };
      }

      it("writes one error line for a handler that throws on every event, then a periodic count", () => {
        const logger = createMockLogger();
        const bus = initializeEventBus(logger, { errorClock: clock });

        bus.subscribe("pitLane.entered", throwingHandler());

        // One throw every 100 ms for just under a minute: one error line, no summary yet.
        for (let i = 0; i < 600; i++) {
          now = i * 100;
          bus.publish(envelope("pitLane.entered"));
        }

        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.warn).not.toHaveBeenCalled();

        // The throw a full minute after the first line writes the summary.
        now = 60_000;
        bus.publish(envelope("pitLane.entered"));

        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(calls(logger.warn)).toEqual([
          expect.stringMatching(
            /^event-bus:pitLane\.entered#1 threw 600 more times in the last 60s, latest at .*: Error: always$/,
          ),
        ]);
      });

      it("declares recovery once the handler has been quiet for a minute", () => {
        const logger = createMockLogger();
        const bus = initializeEventBus(logger, { errorClock: clock });
        let failing = true;

        bus.subscribe("pitLane.entered", () => {
          if (failing) throw new Error("for a while");
        });

        bus.publish(envelope("pitLane.entered"));
        now = 1_000;
        bus.publish(envelope("pitLane.entered"));
        failing = false;

        now = 30_000;
        bus.publish(envelope("pitLane.entered"));
        expect(calls(logger.info)).not.toContainEqual(expect.stringContaining("recovered"));

        now = 61_000;
        bus.publish(envelope("pitLane.entered"));

        expect(calls(logger.info)).toContain(
          "event-bus:pitLane.entered#1 recovered: no errors for 60s, after 2 times in all",
        );
        expect(logger.error).toHaveBeenCalledTimes(1);
      });

      it("keys by event name and handler: each handler and each subscription gets its own first line", () => {
        const logger = createMockLogger();
        const bus = initializeEventBus(logger, { errorClock: clock });
        const shared = throwingHandler();

        bus.subscribe("pitLane.entered", shared);
        bus.subscribe("flag.yellow.raised", shared);
        bus.subscribe("pitLane.entered", throwingHandler());

        bus.publish(envelope("pitLane.entered"));
        bus.publish(envelope("flag.yellow.raised"));
        bus.publish(envelope("pitLane.entered"));

        expect(calls(logger.error).map((line) => line.slice(0, line.indexOf(" threw:")))).toEqual([
          "event-bus:pitLane.entered#1",
          "event-bus:pitLane.entered#3",
          "event-bus:flag.yellow.raised#2",
        ]);
      });

      it("keeps a handler's id when it is subscribed twice to the same event", () => {
        const logger = createMockLogger();
        const bus = initializeEventBus(logger, { errorClock: clock });
        let handlerCalls = 0;
        const handler = (): void => {
          handlerCalls++;
          throw new Error("twice subscribed");
        };

        bus.subscribe("pitLane.entered", handler);
        bus.subscribe("pitLane.entered", handler);
        bus.publish(envelope("pitLane.entered"));

        expect(handlerCalls).toBe(1);
        expect(calls(logger.error)[0]).toMatch(/^event-bus:pitLane\.entered#1 \(handler\) threw: /);
      });

      it("flushes a handler's unreported count on unsubscribe, and a re-subscribe starts afresh", () => {
        const logger = createMockLogger();
        const bus = initializeEventBus(logger, { errorClock: clock });
        const handler = throwingHandler();

        const off = bus.subscribe("pitLane.entered", handler);
        bus.publish(envelope("pitLane.entered"));
        bus.publish(envelope("pitLane.entered"));
        bus.publish(envelope("pitLane.entered"));
        off();

        expect(calls(logger.warn)).toEqual([
          "event-bus:pitLane.entered#1 forgotten with 2 times not yet reported (3 times in all)",
        ]);

        bus.subscribe("pitLane.entered", handler);
        bus.publish(envelope("pitLane.entered"));

        expect(calls(logger.error).map((line) => line.slice(0, line.indexOf(" threw:")))).toEqual([
          "event-bus:pitLane.entered#1",
          "event-bus:pitLane.entered#2",
        ]);
      });

      it("keeps no keys for a handler that unsubscribes itself and then throws", () => {
        const logger = createMockLogger();
        const bus = initializeEventBus(logger, { errorClock: clock });

        // Enough of them to fill the whole table, were their keys kept.
        for (let h = 0; h < EVENT_BUS_REPORTER_MAX_KEYS; h++) {
          const leaving = (): void => {
            bus.unsubscribe("pitLane.entered", leaving);
            throw new Error("after leaving");
          };

          bus.subscribe("pitLane.entered", leaving);
        }

        bus.publish(envelope("pitLane.entered"));

        expect(logger.error).toHaveBeenCalledTimes(EVENT_BUS_REPORTER_MAX_KEYS);

        // With their keys gone the table has room: a new handler's first throw is
        // still a full error line, not a "reached the cap" warning.
        bus.subscribe("pitLane.entered", throwingHandler());
        bus.publish(envelope("pitLane.entered"));

        expect(logger.error).toHaveBeenCalledTimes(EVENT_BUS_REPORTER_MAX_KEYS + 1);
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it("has room for every throw site of 64 handlers, past #1558's default global cap", () => {
        const logger = createMockLogger();
        const bus = initializeEventBus(logger, { errorClock: clock });
        const handlers = EVENT_BUS_REPORTER_MAX_KEYS / DEFAULT_MAX_ERROR_KEYS_PER_ID;

        expect(handlers).toBe(64);
        expect(EVENT_BUS_REPORTER_MAX_KEYS).toBeGreaterThan(DEFAULT_MAX_ERROR_KEYS);

        // Four throw sites each, every one a key.
        for (let h = 0; h < handlers; h++) {
          bus.subscribe("pitLane.entered", (ev) => {
            const site = ev.timestamp;

            if (site === 0) throw new Error("a");

            if (site === 1) throw new Error("b");

            if (site === 2) throw new Error("c");

            throw new Error("d");
          });
        }

        for (let site = 0; site < 4; site++) {
          bus.publish({ ...envelope("pitLane.entered"), timestamp: site });
        }

        expect(logger.error).toHaveBeenCalledTimes(EVENT_BUS_REPORTER_MAX_KEYS);
        expect(logger.warn).not.toHaveBeenCalled();
      });
    });

    describe('the "rethrow" policy', () => {
      it("calls every handler, then throws the first error, and reports nothing", () => {
        const logger = createMockLogger();
        const bus = initializeEventBus(logger, { onHandlerError: "rethrow" });
        const first = new Error("first");
        const after = vi.fn();

        bus.subscribe("pitLane.entered", () => {
          throw first;
        });
        bus.subscribe("pitLane.entered", () => {
          throw new Error("second");
        });
        bus.subscribe("pitLane.entered", after);

        expect(() => bus.publish(envelope("pitLane.entered"))).toThrow(first);
        expect(after).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it('treats an unknown policy as "report"', () => {
        const logger = createMockLogger();
        const bus = initializeEventBus(logger, { onHandlerError: "loud" as never });

        bus.subscribe("pitLane.entered", () => {
          throw new Error("reported");
        });

        expect(() => bus.publish(envelope("pitLane.entered"))).not.toThrow();
        expect(logger.error).toHaveBeenCalledTimes(1);
      });
    });
  });

  // Type-level tests: verify the discriminated union narrows correctly.
  // These assertions fail `tsc` if the typing regresses.
  describe("type-level", () => {
    it("narrows SimEventOf<'flag.yellow.raised'> to a concrete SimEvent variant", () => {
      expectTypeOf<SimEventOf<"flag.yellow.raised">>().toEqualTypeOf<
        SimEvent<"flag.yellow.raised", { scope: FlagScope }, unknown>
      >();
    });

    it("exposes all event names as SimEventName", () => {
      // Assignment is a compile-time assertion that the literal names are
      // members of the SimEventName union. `tsc` fails if any is missing.
      const a: SimEventName = "pitLane.entered";
      const b: SimEventName = "flag.yellow.raised";
      const c: SimEventName = "radar.changed";
      expect([a, b, c]).toHaveLength(3);
    });

    it("binds the `event` field to the key used with SimEventOf", () => {
      expectTypeOf<SimEventOf<"pitLane.entered">["event"]>().toEqualTypeOf<"pitLane.entered">();
      expectTypeOf<SimEventOf<"flag.yellow.raised">["event"]>().toEqualTypeOf<"flag.yellow.raised">();
    });
  });
});
