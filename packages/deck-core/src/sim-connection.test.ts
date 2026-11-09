import { silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSimConnection } from "./fake-sim-connection.test-support.js";
import {
  _resetSimConnection,
  DEFAULT_SIM_ABSENT_DELAY_MS,
  getSimConnection,
  initializeSimConnection,
  isSimAbsent,
  isSimConnectionInitialized,
  onSimPresenceChange,
  type SimConnection,
} from "./sim-connection.js";

describe("sim-connection singleton", () => {
  afterEach(() => _resetSimConnection());

  it("serves a disconnected pending connection before initialisation", () => {
    const connection = getSimConnection();

    expect(isSimConnectionInitialized()).toBe(false);
    expect(connection.isConnected()).toBe(false);
    expect(connection.activeFlags()).toEqual([]);
    expect(connection.resolveTitleTemplate("Speed {{telemetry.Speed}}")).toBe("Speed {{telemetry.Speed}}");
    expect(() => connection.subscribe("x", vi.fn())).not.toThrow();
    expect(() => connection.unsubscribe("x")).not.toThrow();
  });

  it("serves the initialised connection", () => {
    const fake = createFakeSimConnection();

    initializeSimConnection(fake.connection);

    expect(isSimConnectionInitialized()).toBe(true);
    expect(getSimConnection()).toBe(fake.connection);
  });

  it("refuses a second initialisation", () => {
    initializeSimConnection(createFakeSimConnection().connection);

    expect(() => initializeSimConnection(createFakeSimConnection().connection)).toThrow(/already initialized/);
  });

  it("replays a subscription made before initialisation onto the connection", () => {
    const onTick = vi.fn();
    getSimConnection().subscribe("early", onTick);

    const fake = createFakeSimConnection();
    initializeSimConnection(fake.connection);
    fake.tick();

    expect(onTick).toHaveBeenCalledOnce();
    expect(onTick).toHaveBeenCalledWith(true);
  });

  it("replays queued subscriptions in the order they were made", () => {
    getSimConnection().subscribe("first", vi.fn());
    getSimConnection().subscribe("second", vi.fn());

    const fake = createFakeSimConnection();
    initializeSimConnection(fake.connection);

    expect([...fake.subscribers.keys()]).toEqual(["first", "second"]);
  });

  it("replays every queued subscription when one throws as it registers, then rethrows", () => {
    // A connection that notifies a subscriber as it registers it, as iRacing's does, but lets the
    // subscriber's throw out of subscribe: one that breaks the SimConnection.subscribe contract (#1558).
    const registered: string[] = [];
    const notifying: SimConnection = {
      ...createFakeSimConnection().connection,
      subscribe: (id, onTick) => {
        registered.push(id);
        onTick(true);
      },
    };
    const boom = new Error("boom");

    getSimConnection().subscribe("first", vi.fn());
    getSimConnection().subscribe("throws", () => {
      throw boom;
    });
    getSimConnection().subscribe("last", vi.fn());

    let thrown: unknown;

    try {
      initializeSimConnection(notifying);
    } catch (err) {
      thrown = err;
    }

    expect(registered).toEqual(["first", "throws", "last"]);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe(boom);
    expect(getSimConnection()).toBe(notifying);
  });

  it("does not replay a subscription withdrawn before initialisation", () => {
    getSimConnection().subscribe("early", vi.fn());
    getSimConnection().unsubscribe("early");

    const fake = createFakeSimConnection();
    initializeSimConnection(fake.connection);

    expect(fake.subscribers.size).toBe(0);
  });

  it("delegates to the connection once set, through a pending reference kept from before", () => {
    const kept = getSimConnection();
    const fake = createFakeSimConnection();
    fake.state.flags = [{ label: "YELLOW", color: "#f1c40f", textColor: "#1a1a1a", pulse: false }];
    fake.state.resolve = () => "resolved";
    initializeSimConnection(fake.connection);

    const onTick = vi.fn();
    kept.subscribe("late", onTick);
    fake.tick();

    expect(onTick).toHaveBeenCalledWith(true);
    expect(kept.isConnected()).toBe(true);
    expect(kept.activeFlags()).toEqual(fake.state.flags);
    expect(kept.resolveTitleTemplate("{{x}}")).toBe("resolved");

    kept.unsubscribe("late");
    expect(fake.subscribers.has("late")).toBe(false);
  });

  it("forgets queued subscriptions on reset", () => {
    getSimConnection().subscribe("early", vi.fn());
    _resetSimConnection();

    const fake = createFakeSimConnection();
    initializeSimConnection(fake.connection);

    expect(fake.subscribers.size).toBe(0);
  });

  it("forgets the connection on reset", () => {
    initializeSimConnection(createFakeSimConnection().connection);
    _resetSimConnection();

    expect(isSimConnectionInitialized()).toBe(false);
  });

  it("accepts the longest delay a timer honours", () => {
    expect(() =>
      initializeSimConnection(createFakeSimConnection().connection, { absentDelayMs: 2_147_483_647 }),
    ).not.toThrow();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "refuses an absentDelayMs of %s and installs nothing",
    (delay) => {
      expect(() => initializeSimConnection(createFakeSimConnection().connection, { absentDelayMs: delay })).toThrow(
        RangeError,
      );
      expect(isSimConnectionInitialized()).toBe(false);
    },
  );
});

describe("sim presence (#1599)", () => {
  const DELAY = 5000;

  /**
   * A connection that, like iRacing's SDK controller, calls a new subscriber
   * back at once with the current state, then only on `tick()`.
   */
  function createNotifyingConnection(connected: boolean) {
    const fake = createFakeSimConnection();
    fake.state.connected = connected;
    const connection: SimConnection = {
      ...fake.connection,
      subscribe: (id, onTick) => {
        fake.connection.subscribe(id, onTick);
        onTick(fake.state.connected);
      },
    };

    return { ...fake, connection };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetSimConnection();
    vi.useRealTimers();
  });

  it("reports a subscribe that throws while registering, and still seeds the signal", () => {
    const fake = createFakeSimConnection();
    fake.state.connected = false;
    const warn = vi.fn();
    const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as never;
    const connection: SimConnection = {
      ...fake.connection,
      subscribe: (id, onTick) => {
        fake.connection.subscribe(id, onTick);
        throw new Error("broken contract");
      },
    };
    initializeSimConnection(connection, { absentDelayMs: DELAY, logger });
    const listener = vi.fn();

    expect(() => onSimPresenceChange(listener)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken contract"));

    vi.advanceTimersByTime(DELAY);

    expect(isSimAbsent()).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("is present at start", () => {
    expect(isSimAbsent()).toBe(false);
    onSimPresenceChange(vi.fn());
    expect(isSimAbsent()).toBe(false);
  });

  it("subscribes to the connection once, on the first listener", () => {
    const fake = createFakeSimConnection();
    initializeSimConnection(fake.connection);

    expect(fake.subscribers.size).toBe(0);

    onSimPresenceChange(vi.fn());
    onSimPresenceChange(vi.fn());

    expect(fake.subscribers.size).toBe(1);
  });

  it("turns absent only after the delay, when no tick follows the initial disconnected callback", () => {
    const fake = createNotifyingConnection(false);
    initializeSimConnection(fake.connection, { absentDelayMs: DELAY });
    const listener = vi.fn();
    onSimPresenceChange(listener);

    vi.advanceTimersByTime(DELAY - 1);
    expect(isSimAbsent()).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(isSimAbsent()).toBe(true);
    expect(listener).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not re-arm the delay on every disconnected tick", () => {
    const fake = createNotifyingConnection(false);
    initializeSimConnection(fake.connection, { absentDelayMs: DELAY });
    const listener = vi.fn();
    onSimPresenceChange(listener);

    vi.advanceTimersByTime(DELAY / 2);
    fake.tick();
    vi.advanceTimersByTime(DELAY / 2);

    expect(isSimAbsent()).toBe(true);
    fake.tick();
    vi.advanceTimersByTime(DELAY * 2);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("uses the default delay when the sim passes none", () => {
    initializeSimConnection(createNotifyingConnection(false).connection);
    onSimPresenceChange(vi.fn());

    vi.advanceTimersByTime(DEFAULT_SIM_ABSENT_DELAY_MS - 1);
    expect(isSimAbsent()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isSimAbsent()).toBe(true);
  });

  it("never fires for a reconnect inside the delay", () => {
    const fake = createNotifyingConnection(false);
    initializeSimConnection(fake.connection, { absentDelayMs: DELAY });
    const listener = vi.fn();
    onSimPresenceChange(listener);

    vi.advanceTimersByTime(DELAY - 1);
    fake.state.connected = true;
    fake.tick();
    vi.advanceTimersByTime(DELAY * 3);

    expect(isSimAbsent()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("turns present on the first connected tick", () => {
    const fake = createNotifyingConnection(false);
    initializeSimConnection(fake.connection, { absentDelayMs: DELAY });
    const listener = vi.fn();
    onSimPresenceChange(listener);
    vi.advanceTimersByTime(DELAY);
    listener.mockClear();

    fake.state.connected = true;
    fake.tick();

    expect(isSimAbsent()).toBe(false);
    expect(listener).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("stays present while connected", () => {
    const fake = createNotifyingConnection(true);
    initializeSimConnection(fake.connection, { absentDelayMs: DELAY });
    const listener = vi.fn();
    onSimPresenceChange(listener);

    fake.tick();
    vi.advanceTimersByTime(DELAY * 2);

    expect(isSimAbsent()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps its value when every listener leaves, and keeps tracking for the next one", () => {
    const fake = createNotifyingConnection(false);
    initializeSimConnection(fake.connection, { absentDelayMs: DELAY });
    const unsubscribe = onSimPresenceChange(vi.fn());
    vi.advanceTimersByTime(DELAY);
    unsubscribe();

    expect(isSimAbsent()).toBe(true);
    expect(fake.subscribers.size).toBe(1);

    const next = vi.fn();
    onSimPresenceChange(next);
    expect(isSimAbsent()).toBe(true);
    expect(fake.subscribers.size).toBe(1);

    fake.state.connected = true;
    fake.tick();
    expect(next).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("stops calling a listener once it is removed", () => {
    const fake = createNotifyingConnection(false);
    initializeSimConnection(fake.connection, { absentDelayMs: DELAY });
    const removed = vi.fn();
    const kept = vi.fn();
    onSimPresenceChange(removed)();
    onSimPresenceChange(kept);

    vi.advanceTimersByTime(DELAY);

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledOnce();
  });

  it("replays a listener added before initialisation onto the connection", () => {
    const listener = vi.fn();
    onSimPresenceChange(listener);

    const fake = createNotifyingConnection(false);
    initializeSimConnection(fake.connection, { absentDelayMs: DELAY });
    expect(fake.subscribers.size).toBe(1);

    vi.advanceTimersByTime(DELAY);
    expect(listener).toHaveBeenCalledExactlyOnceWith(true);
  });

  describe("seeded from isConnected() on a connection that does not call back", () => {
    it("turns absent after the delay when the plugin starts with the sim closed, listener added after initialisation", () => {
      const fake = createFakeSimConnection();
      fake.state.connected = false;
      initializeSimConnection(fake.connection, { absentDelayMs: DELAY });
      const listener = vi.fn();
      onSimPresenceChange(listener);

      vi.advanceTimersByTime(DELAY - 1);
      expect(isSimAbsent()).toBe(false);

      vi.advanceTimersByTime(1);
      expect(isSimAbsent()).toBe(true);
      expect(listener).toHaveBeenCalledExactlyOnceWith(true);
    });

    it("turns absent after the delay when the plugin starts with the sim closed, listener added before initialisation", () => {
      const listener = vi.fn();
      onSimPresenceChange(listener);

      const fake = createFakeSimConnection();
      fake.state.connected = false;
      initializeSimConnection(fake.connection, { absentDelayMs: DELAY });

      vi.advanceTimersByTime(DELAY - 1);
      expect(isSimAbsent()).toBe(false);

      vi.advanceTimersByTime(1);
      expect(isSimAbsent()).toBe(true);
      expect(listener).toHaveBeenCalledExactlyOnceWith(true);
    });

    it("never fires when the sim is connected at initialisation", () => {
      const before = vi.fn();
      onSimPresenceChange(before);
      const fake = createFakeSimConnection();
      initializeSimConnection(fake.connection, { absentDelayMs: DELAY });
      const after = vi.fn();
      onSimPresenceChange(after);

      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(DELAY * 2);

      expect(isSimAbsent()).toBe(false);
      expect(before).not.toHaveBeenCalled();
      expect(after).not.toHaveBeenCalled();
    });

    it("does not arm before initialisation, when there is no connection to ask", () => {
      onSimPresenceChange(vi.fn());

      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(DELAY * 2);
      expect(isSimAbsent()).toBe(false);
    });

    it("logs a throw from isConnected() and leaves the signal to the next tick", () => {
      const fake = createFakeSimConnection();
      fake.state.connected = false;
      const connection: SimConnection = {
        ...fake.connection,
        isConnected: () => {
          throw new Error("no state yet");
        },
      };
      const logger = { ...silentLogger, warn: vi.fn() };
      const listener = vi.fn();
      onSimPresenceChange(listener);

      expect(() => initializeSimConnection(connection, { absentDelayMs: DELAY, logger })).not.toThrow();
      expect(() => onSimPresenceChange(vi.fn())).not.toThrow();
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);

      fake.tick();
      vi.advanceTimersByTime(DELAY);
      expect(listener).toHaveBeenCalledExactlyOnceWith(true);
    });
  });

  describe("seeded on a connection that does call back", () => {
    it.each([
      ["after initialisation", false],
      ["before initialisation", true],
    ])("arms one timer, not two, for a listener added %s", (_label, listenerFirst) => {
      const listener = vi.fn();

      if (listenerFirst) onSimPresenceChange(listener);

      const fake = createNotifyingConnection(false);
      initializeSimConnection(fake.connection, { absentDelayMs: DELAY });

      if (!listenerFirst) onSimPresenceChange(listener);

      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(DELAY);
      expect(listener).toHaveBeenCalledExactlyOnceWith(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("never fires when the sim is connected at initialisation", () => {
      const before = vi.fn();
      onSimPresenceChange(before);
      initializeSimConnection(createNotifyingConnection(true).connection, { absentDelayMs: DELAY });
      const after = vi.fn();
      onSimPresenceChange(after);

      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(DELAY * 2);

      expect(isSimAbsent()).toBe(false);
      expect(before).not.toHaveBeenCalled();
      expect(after).not.toHaveBeenCalled();
    });
  });

  it("isolates a listener that throws: the others still run and the tick does not throw", () => {
    const fake = createNotifyingConnection(false);
    const logger = { ...silentLogger, error: vi.fn(), warn: vi.fn() };
    initializeSimConnection(fake.connection, { absentDelayMs: DELAY, logger });
    const after = vi.fn();
    onSimPresenceChange(() => {
      throw new Error("listener broke");
    });
    onSimPresenceChange(after);

    expect(() => vi.advanceTimersByTime(DELAY)).not.toThrow();
    expect(after).toHaveBeenCalledExactlyOnceWith(true);

    fake.state.connected = true;
    expect(() => fake.tick()).not.toThrow();
    expect(after).toHaveBeenLastCalledWith(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it("reset clears the timer, the listeners, the subscription and the value", () => {
    const fake = createNotifyingConnection(false);
    initializeSimConnection(fake.connection, { absentDelayMs: DELAY });
    const listener = vi.fn();
    onSimPresenceChange(listener);
    vi.advanceTimersByTime(DELAY);
    expect(isSimAbsent()).toBe(true);

    // A second arming in flight: reconnect, then drop again.
    fake.state.connected = true;
    fake.tick();
    fake.state.connected = false;
    fake.tick();
    listener.mockClear();
    expect(vi.getTimerCount()).toBe(1);

    _resetSimConnection();

    expect(isSimAbsent()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // A fresh connection gets no presence subscription until a new listener arrives.
    const next = createNotifyingConnection(false);
    initializeSimConnection(next.connection, { absentDelayMs: DELAY });
    vi.advanceTimersByTime(DELAY * 2);

    expect(next.subscribers.size).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(isSimAbsent()).toBe(false);
  });
});
