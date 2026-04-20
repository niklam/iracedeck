import type { ILogger } from "@iracedeck/logger";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { _resetEventBus, getEventBus, initializeEventBus, isEventBusInitialized } from "./event-bus.js";
import type { EmptySimEventPayload, SimEvent, SimEventName, SimEventOf } from "./event-catalog.js";

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

// Helper: build a concrete envelope of a given name with empty data.
function envelope<T extends "pitLane.entered" | "flag.yellow.raised">(event: T): SimEventOf<T> {
  return {
    event,
    timestamp: 0,
    telemetry: undefined,
    data: {},
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
    it("logs and continues when a handler throws", () => {
      const logger = createMockLogger();
      const bus = initializeEventBus(logger);

      const bad = vi.fn(() => {
        throw new Error("boom");
      });
      const good = vi.fn();

      bus.subscribe("pitLane.entered", bad);
      bus.subscribe("pitLane.entered", good);

      bus.publish(envelope("pitLane.entered"));

      expect(bad).toHaveBeenCalled();
      expect(good).toHaveBeenCalled();
      const logged = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(logged).toContain('Event handler for "pitLane.entered" threw:');
      expect(logged).toContain("boom");
    });

    it("includes the stack trace when available", () => {
      const logger = createMockLogger();
      const bus = initializeEventBus(logger);

      bus.subscribe("pitLane.entered", () => {
        throw new Error("with-stack");
      });

      bus.publish(envelope("pitLane.entered"));

      const logged = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      // V8 error stacks begin with "Error: <message>\n    at ..."; asserting
      // on "at " confirms the stack is present rather than just the message.
      expect(logged).toContain("at ");
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
  });

  // Type-level tests: verify the discriminated union narrows correctly.
  // These assertions fail `tsc` if the typing regresses.
  describe("type-level", () => {
    it("narrows SimEventOf<'flag.yellow.raised'> to a concrete SimEvent variant", () => {
      expectTypeOf<SimEventOf<"flag.yellow.raised">>().toEqualTypeOf<
        SimEvent<"flag.yellow.raised", EmptySimEventPayload, unknown>
      >();
    });

    it("exposes all event names as SimEventName", () => {
      // Assignment is a compile-time assertion that the literal names are
      // members of the SimEventName union. `tsc` fails if any is missing.
      const a: SimEventName = "pitLane.entered";
      const b: SimEventName = "flag.yellow.raised";
      const c: SimEventName = "spotter.changed";
      expect([a, b, c]).toHaveLength(3);
    });

    it("binds the `event` field to the key used with SimEventOf", () => {
      expectTypeOf<SimEventOf<"pitLane.entered">["event"]>().toEqualTypeOf<"pitLane.entered">();
      expectTypeOf<SimEventOf<"flag.yellow.raised">["event"]>().toEqualTypeOf<"flag.yellow.raised">();
    });
  });
});
