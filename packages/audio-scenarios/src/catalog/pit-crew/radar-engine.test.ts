import type { IEventBus } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetSpotterEngine,
  getRadarVisualState,
  playRadarTest,
  registerRadarEngine,
  setRadarEnabled,
  subscribeRadarVisualState,
} from "./radar-engine.js";

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
  // Typed once so every `registerRadarEngine(hoisted.bus)` callsite
  // stays type-safe without a per-call `as never` escape hatch.
  const bus = { subscribe, unsubscribe: vi.fn(), publish: vi.fn() } as unknown as IEventBus;
  const publishSpotter = (to: string, from = "clear"): void => {
    const set = busHandlers.get("radar.changed");

    if (!set) return;

    for (const h of Array.from(set)) h({ event: "radar.changed", data: { from, to } });
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
  AudioChannel: { Ambient: 0, SFX: 1, Voice: 2, Radar: 3 },
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

describe("registerRadarEngine", () => {
  it("subscribes to radar.changed exactly once, even if called twice", () => {
    registerRadarEngine(hoisted.bus);
    registerRadarEngine(hoisted.bus);

    expect(hoisted.subscribe).toHaveBeenCalledTimes(1);
    expect(hoisted.subscribe).toHaveBeenCalledWith("radar.changed", expect.any(Function));
  });

  it("throws when re-registered with a different bus instance", () => {
    registerRadarEngine(hoisted.bus);
    const otherBus = { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() } as unknown as IEventBus;

    expect(() => registerRadarEngine(otherBus)).toThrow(/different event bus/);
    expect(otherBus.subscribe).not.toHaveBeenCalled();
  });
});

describe("radar.changed → tick loop", () => {
  it("does nothing when the master gate is disabled", () => {
    registerRadarEngine(hoisted.bus);
    hoisted.publishSpotter("left");

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    expect(getRadarVisualState()).toBe("clear");
  });

  it("starts ticking on the Radar channel when enabled and state goes non-clear", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);

    hoisted.publishSpotter("left");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    expect(hoisted.playOnChannel).toHaveBeenCalledWith(SPOTTER_CHANNEL, expect.stringContaining("IRD-radar-left"));

    vi.advanceTimersByTime(250);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(250);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);
  });

  it("uses the 180 ms cadence for two-cars-same-side states", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishSpotter("two-left");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(180);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
  });

  it("uses the 230 ms cadence for both-sides", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishSpotter("both");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(230);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
  });

  it("stops the tick loop and silences the channel when state returns to clear", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishSpotter("left");
    const beforeClearCalls = hoisted.playOnChannel.mock.calls.length;

    hoisted.publishSpotter("clear", "left");

    expect(hoisted.stopChannel).toHaveBeenCalledWith(SPOTTER_CHANNEL);

    // Advance time — no further ticks should fire.
    vi.advanceTimersByTime(1000);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(beforeClearCalls);
  });

  it("switches interval when state transitions between active states", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishSpotter("left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

    hoisted.publishSpotter("two-right", "left");
    // New tick fires immediately, then at 180 ms cadence.
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
    expect(hoisted.playOnChannel.mock.calls.at(-1)?.[1]).toContain("IRD-radar-right");

    vi.advanceTimersByTime(180);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);
  });

  it("ignores repeated transitions to the same state", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishSpotter("left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

    hoisted.publishSpotter("left", "left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
  });
});

describe("pit-road suppression", () => {
  it("forces the visual state to clear and silences the channel while on pit road", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishSpotter("left");
    expect(getRadarVisualState()).toBe("left");

    hoisted.getLatestTelemetry.mockReturnValue({ OnPitRoad: true });
    hoisted.publishSpotter("both", "left");

    expect(getRadarVisualState()).toBe("clear");
    expect(hoisted.stopChannel).toHaveBeenCalledWith(SPOTTER_CHANNEL);
  });

  it("is a no-op when telemetry is missing", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.getLatestTelemetry.mockReturnValue(null);

    hoisted.publishSpotter("left");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    expect(getRadarVisualState()).toBe("left");
  });
});

describe("Lone Qualify suppression", () => {
  it("ignores events during Lone Qualify", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.getSessionType.mockReturnValue("Lone Qualify");

    hoisted.publishSpotter("left");

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    expect(getRadarVisualState()).toBe("clear");
  });

  it("tears down an already-running loop when the session flips to Lone Qualify", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishSpotter("left");
    expect(getRadarVisualState()).toBe("left");

    hoisted.getSessionType.mockReturnValue("Lone Qualify");
    hoisted.publishSpotter("both", "left");

    expect(getRadarVisualState()).toBe("clear");
    expect(hoisted.stopChannel).toHaveBeenCalledWith(SPOTTER_CHANNEL);
  });
});

describe("setRadarEnabled", () => {
  it("clears visual state, stops the channel, and notifies listeners on disable", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishSpotter("left");
    expect(getRadarVisualState()).toBe("left");

    const listener = vi.fn();
    subscribeRadarVisualState(listener);

    setRadarEnabled(false);

    expect(hoisted.stopChannel).toHaveBeenCalledWith(SPOTTER_CHANNEL);
    expect(getRadarVisualState()).toBe("clear");
    expect(listener).toHaveBeenCalledWith("clear");
  });

  it("is idempotent when re-enabled — waits for next event before playing", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    setRadarEnabled(true);

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();

    hoisted.publishSpotter("left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
  });
});

describe("playRadarTest", () => {
  it("plays left → right → both in order with a 250 ms gap between clips", () => {
    registerRadarEngine(hoisted.bus);
    playRadarTest();

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    expect(hoisted.playOnChannel.mock.calls[0][1]).toContain("IRD-radar-left");

    // Simulate the first clip finishing.
    const firstCallback = hoisted.onChannelComplete.mock.calls.at(-1)?.[1] as () => void;
    firstCallback();
    vi.advanceTimersByTime(250);

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
    expect(hoisted.playOnChannel.mock.calls[1][1]).toContain("IRD-radar-right");

    const secondCallback = hoisted.onChannelComplete.mock.calls.at(-1)?.[1] as () => void;
    secondCallback();
    vi.advanceTimersByTime(250);

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);
    expect(hoisted.playOnChannel.mock.calls[2][1]).toContain("IRD-radar-both");

    const thirdCallback = hoisted.onChannelComplete.mock.calls.at(-1)?.[1] as () => void;
    thirdCallback();
    vi.advanceTimersByTime(250);

    // No fourth clip.
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);
  });

  it("works regardless of the master gate", () => {
    registerRadarEngine(hoisted.bus);
    // enabled=false — test button still plays.
    playRadarTest();

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
  });

  it("is a no-op if called while a sequence is already in flight", () => {
    registerRadarEngine(hoisted.bus);
    playRadarTest();
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

    // Second press before the first sequence completes → ignored.
    playRadarTest();
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
  });

  it("clears the in-flight guard when the audio engine refuses playback", () => {
    registerRadarEngine(hoisted.bus);
    hoisted.playOnChannel.mockReturnValueOnce(false);

    playRadarTest();
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

    // Guard cleared synchronously so a later press can retry.
    hoisted.playOnChannel.mockReturnValue(true);
    playRadarTest();
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
  });

  it("suspends the live tick loop while the preview is playing", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishSpotter("left");
    const liveCalls = hoisted.playOnChannel.mock.calls.length;

    playRadarTest();
    // First test clip plays; no tick fires while test is in flight.
    vi.advanceTimersByTime(10_000);
    const callsDuringTest = hoisted.playOnChannel.mock.calls.length;

    // Only the 1 test-clip call (live loop's outstanding timer cleared).
    expect(callsDuringTest - liveCalls).toBe(1);
    expect(hoisted.playOnChannel.mock.calls[liveCalls][1]).toContain("IRD-radar-left");
  });

  it("ignores live radar events mid-preview but still updates visual state", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishSpotter("left");
    const callsBeforeTest = hoisted.playOnChannel.mock.calls.length;

    playRadarTest();

    // Live transition during preview — visual flips, but no extra live playback.
    hoisted.publishSpotter("both", "left");
    expect(getRadarVisualState()).toBe("both");
    // playRadarTest has fired 1 clip; live event added no playback on top.
    expect(hoisted.playOnChannel.mock.calls.length - callsBeforeTest).toBe(1);
  });

  it("resumes the live tick loop at the current state after the preview completes", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishSpotter("left");
    playRadarTest();

    // Drive the 3-clip sequence to completion via the registered channel-complete callbacks.
    for (let i = 0; i < 3; i++) {
      const cb = hoisted.onChannelComplete.mock.calls.at(-1)?.[1] as () => void;
      cb();
      vi.advanceTimersByTime(250);
    }

    // After the preview, the live loop resumes using the current visual state.
    const lastCall = hoisted.playOnChannel.mock.calls.at(-1);
    expect(lastCall?.[1]).toContain("IRD-radar-left");
  });

  it("clears the in-flight guard when the master is disabled mid-preview", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    playRadarTest();
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

    // Master off during preview → guard cleared so the button works after re-enable.
    setRadarEnabled(false);
    setRadarEnabled(true);

    playRadarTest();
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
  });
});

describe("subscribeRadarVisualState", () => {
  it("notifies on transitions and stops after unsubscribe", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);

    const listener = vi.fn();
    const unsubscribe = subscribeRadarVisualState(listener);

    hoisted.publishSpotter("left");
    expect(listener).toHaveBeenCalledWith("left");

    unsubscribe();

    hoisted.publishSpotter("both", "left");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not fire when transitioning between identical states", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);

    const listener = vi.fn();
    subscribeRadarVisualState(listener);

    hoisted.publishSpotter("left");
    hoisted.publishSpotter("left", "left");

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
