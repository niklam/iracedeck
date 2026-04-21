import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetSpotterEngine,
  getSpotterVisualState,
  playSpotterTest,
  registerSpotterEngine,
  setSpotterEnabled,
  subscribeSpotterVisualState,
} from "./spotter-engine.js";

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => {
  const playOnChannel = vi.fn<(...args: unknown[]) => boolean>().mockReturnValue(true);
  const stopChannel = vi.fn();
  const onChannelComplete = vi.fn();
  const audio = { playOnChannel, stopChannel, onChannelComplete };
  const getAudio = vi.fn(() => audio);

  const busHandlers = new Map<string, Set<(ev: unknown) => void>>();
  const subscribe = vi.fn((name: string, handler: (ev: unknown) => void) => {
    let set = busHandlers.get(name);

    if (!set) {
      set = new Set();
      busHandlers.set(name, set);
    }

    set.add(handler);

    return () => {
      set?.delete(handler);
    };
  });
  const bus = { subscribe, unsubscribe: vi.fn(), publish: vi.fn() };
  const publishSpotter = (to: string, from = "clear"): void => {
    const set = busHandlers.get("spotter.changed");

    if (!set) return;

    for (const h of Array.from(set)) h({ event: "spotter.changed", data: { from, to } });
  };

  const getLatestTelemetry = vi.fn<() => { OnPitRoad?: boolean } | null>();
  const getSessionType = vi.fn<() => string>();

  return {
    audio,
    playOnChannel,
    stopChannel,
    onChannelComplete,
    getAudio,
    busHandlers,
    subscribe,
    bus,
    publishSpotter,
    getLatestTelemetry,
    getSessionType,
  };
});

vi.mock("@iracedeck/audio-service", () => ({
  AudioChannel: { Ambient: 0, SFX: 1, Voice: 2, Spotter: 3 },
  getAudio: hoisted.getAudio,
}));

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getLatestTelemetry: hoisted.getLatestTelemetry,
  getSessionType: hoisted.getSessionType,
}));

const SPOTTER_CHANNEL = 3;

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.playOnChannel.mockClear();
  hoisted.stopChannel.mockClear();
  hoisted.onChannelComplete.mockClear();
  hoisted.subscribe.mockClear();
  hoisted.busHandlers.clear();
  hoisted.getLatestTelemetry.mockReset();
  hoisted.getLatestTelemetry.mockReturnValue({ OnPitRoad: false });
  hoisted.getSessionType.mockReset();
  hoisted.getSessionType.mockReturnValue("Race");
});

afterEach(() => {
  _resetSpotterEngine();
  vi.useRealTimers();
});

describe("registerSpotterEngine", () => {
  it("subscribes to spotter.changed exactly once, even if called twice", () => {
    registerSpotterEngine(hoisted.bus as never);
    registerSpotterEngine(hoisted.bus as never);

    expect(hoisted.subscribe).toHaveBeenCalledTimes(1);
    expect(hoisted.subscribe).toHaveBeenCalledWith("spotter.changed", expect.any(Function));
  });

  it("throws when re-registered with a different bus instance", () => {
    registerSpotterEngine(hoisted.bus as never);
    const otherBus = { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() };

    expect(() => registerSpotterEngine(otherBus as never)).toThrow(/different event bus/);
    expect(otherBus.subscribe).not.toHaveBeenCalled();
  });
});

describe("spotter.changed → tick loop", () => {
  it("does nothing when the master gate is disabled", () => {
    registerSpotterEngine(hoisted.bus as never);
    hoisted.publishSpotter("left");

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    expect(getSpotterVisualState()).toBe("clear");
  });

  it("starts ticking on the Spotter channel when enabled and state goes non-clear", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);

    hoisted.publishSpotter("left");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    expect(hoisted.playOnChannel).toHaveBeenCalledWith(SPOTTER_CHANNEL, expect.stringContaining("IRD-spotter-left"));

    vi.advanceTimersByTime(250);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(250);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);
  });

  it("uses the 180 ms cadence for two-cars-same-side states", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);
    hoisted.publishSpotter("two-left");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(180);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
  });

  it("uses the 230 ms cadence for both-sides", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);
    hoisted.publishSpotter("both");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(230);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
  });

  it("stops the tick loop and silences the channel when state returns to clear", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);
    hoisted.publishSpotter("left");
    const beforeClearCalls = hoisted.playOnChannel.mock.calls.length;

    hoisted.publishSpotter("clear", "left");

    expect(hoisted.stopChannel).toHaveBeenCalledWith(SPOTTER_CHANNEL);

    // Advance time — no further ticks should fire.
    vi.advanceTimersByTime(1000);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(beforeClearCalls);
  });

  it("switches interval when state transitions between active states", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);
    hoisted.publishSpotter("left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

    hoisted.publishSpotter("two-right", "left");
    // New tick fires immediately, then at 180 ms cadence.
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
    expect(hoisted.playOnChannel.mock.calls.at(-1)?.[1]).toContain("IRD-spotter-right");

    vi.advanceTimersByTime(180);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);
  });

  it("ignores repeated transitions to the same state", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);
    hoisted.publishSpotter("left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

    hoisted.publishSpotter("left", "left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
  });
});

describe("pit-road suppression", () => {
  it("forces the visual state to clear and silences the channel while on pit road", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);
    hoisted.publishSpotter("left");
    expect(getSpotterVisualState()).toBe("left");

    hoisted.getLatestTelemetry.mockReturnValue({ OnPitRoad: true });
    hoisted.publishSpotter("both", "left");

    expect(getSpotterVisualState()).toBe("clear");
    expect(hoisted.stopChannel).toHaveBeenCalledWith(SPOTTER_CHANNEL);
  });

  it("is a no-op when telemetry is missing", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);
    hoisted.getLatestTelemetry.mockReturnValue(null);

    hoisted.publishSpotter("left");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    expect(getSpotterVisualState()).toBe("left");
  });
});

describe("Lone Qualify suppression", () => {
  it("ignores events during Lone Qualify", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);
    hoisted.getSessionType.mockReturnValue("Lone Qualify");

    hoisted.publishSpotter("left");

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    expect(getSpotterVisualState()).toBe("clear");
  });
});

describe("setSpotterEnabled", () => {
  it("clears visual state, stops the channel, and notifies listeners on disable", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);
    hoisted.publishSpotter("left");
    expect(getSpotterVisualState()).toBe("left");

    const listener = vi.fn();
    subscribeSpotterVisualState(listener);

    setSpotterEnabled(false);

    expect(hoisted.stopChannel).toHaveBeenCalledWith(SPOTTER_CHANNEL);
    expect(getSpotterVisualState()).toBe("clear");
    expect(listener).toHaveBeenCalledWith("clear");
  });

  it("is idempotent when re-enabled — waits for next event before playing", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);
    setSpotterEnabled(true);

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();

    hoisted.publishSpotter("left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
  });
});

describe("playSpotterTest", () => {
  it("plays left → right → both in order with a 250 ms gap between clips", () => {
    registerSpotterEngine(hoisted.bus as never);
    playSpotterTest();

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    expect(hoisted.playOnChannel.mock.calls[0][1]).toContain("IRD-spotter-left");

    // Simulate the first clip finishing.
    const firstCallback = hoisted.onChannelComplete.mock.calls.at(-1)?.[1] as () => void;
    firstCallback();
    vi.advanceTimersByTime(250);

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
    expect(hoisted.playOnChannel.mock.calls[1][1]).toContain("IRD-spotter-right");

    const secondCallback = hoisted.onChannelComplete.mock.calls.at(-1)?.[1] as () => void;
    secondCallback();
    vi.advanceTimersByTime(250);

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);
    expect(hoisted.playOnChannel.mock.calls[2][1]).toContain("IRD-spotter-both");

    const thirdCallback = hoisted.onChannelComplete.mock.calls.at(-1)?.[1] as () => void;
    thirdCallback();
    vi.advanceTimersByTime(250);

    // No fourth clip.
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);
  });

  it("works regardless of the master gate", () => {
    registerSpotterEngine(hoisted.bus as never);
    // enabled=false — test button still plays.
    playSpotterTest();

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
  });

  it("is a no-op if called while a sequence is already in flight", () => {
    registerSpotterEngine(hoisted.bus as never);
    playSpotterTest();
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

    // Second press before the first sequence completes → ignored.
    playSpotterTest();
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeSpotterVisualState", () => {
  it("notifies on transitions and stops after unsubscribe", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);

    const listener = vi.fn();
    const unsubscribe = subscribeSpotterVisualState(listener);

    hoisted.publishSpotter("left");
    expect(listener).toHaveBeenCalledWith("left");

    unsubscribe();

    hoisted.publishSpotter("both", "left");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not fire when transitioning between identical states", () => {
    registerSpotterEngine(hoisted.bus as never);
    setSpotterEnabled(true);

    const listener = vi.fn();
    subscribeSpotterVisualState(listener);

    hoisted.publishSpotter("left");
    hoisted.publishSpotter("left", "left");

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
