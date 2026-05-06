import type { IEventBus } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetRadarEngine,
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
  const publishRadar = (to: string, from = "clear"): void => {
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
    publishRadar,
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

const RADAR_CHANNEL = 3;

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
  _resetRadarEngine();
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
    hoisted.publishRadar("left");

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    expect(getRadarVisualState()).toBe("clear");
  });

  it("starts ticking on the Radar channel when enabled and state goes non-clear", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);

    hoisted.publishRadar("left");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    expect(hoisted.playOnChannel).toHaveBeenCalledWith(RADAR_CHANNEL, expect.stringContaining("IRD-radar-left"));

    vi.advanceTimersByTime(250);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(250);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);
  });

  it("uses the 180 ms cadence for two-cars-same-side states", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishRadar("two-left");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(180);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
  });

  it("uses the 230 ms cadence for both-sides", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishRadar("both");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(230);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
  });

  it("stops the tick loop and silences the channel when state returns to clear", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishRadar("left");
    const beforeClearCalls = hoisted.playOnChannel.mock.calls.length;

    hoisted.publishRadar("clear", "left");

    expect(hoisted.stopChannel).toHaveBeenCalledWith(RADAR_CHANNEL);

    // Advance time — no further ticks should fire.
    vi.advanceTimersByTime(1000);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(beforeClearCalls);
  });

  it("switches interval when state transitions between active states", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishRadar("left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

    hoisted.publishRadar("two-right", "left");
    // New tick fires immediately, then at 180 ms cadence.
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
    expect(hoisted.playOnChannel.mock.calls.at(-1)?.[1]).toContain("IRD-radar-right");

    vi.advanceTimersByTime(180);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);
  });

  it("ignores repeated transitions to the same state", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishRadar("left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

    hoisted.publishRadar("left", "left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
  });
});

describe("pit-road suppression", () => {
  it("forces the visual state to clear and silences the channel while on pit road", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishRadar("left");
    expect(getRadarVisualState()).toBe("left");

    hoisted.getLatestTelemetry.mockReturnValue({ OnPitRoad: true });
    hoisted.publishRadar("both", "left");

    expect(getRadarVisualState()).toBe("clear");
    expect(hoisted.stopChannel).toHaveBeenCalledWith(RADAR_CHANNEL);
  });

  it("is a no-op when telemetry is missing", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.getLatestTelemetry.mockReturnValue(null);

    hoisted.publishRadar("left");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    expect(getRadarVisualState()).toBe("left");
  });
});

// Issue #515: a plugin-supplied `getMasterEnabled` closure provides
// defense-in-depth alongside the imperative `enabled` flag. The engine
// reads it live on every `radar.changed` arrival AND on every scheduled
// tick, so the radar can't audibly fire when the plugin-wide master
// toggle is off — even if `setRadarEnabled(true)` was called.
describe("Race Engineer master gate (issue #515)", () => {
  it("does not fire ticks on radar.changed when the master gate is off", () => {
    let masterOn = false;
    registerRadarEngine(hoisted.bus, () => masterOn);
    setRadarEnabled(true);

    hoisted.publishRadar("left");

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();
  });

  it("fires normally when both `enabled` and the master gate are on", () => {
    let masterOn = true;
    registerRadarEngine(hoisted.bus, () => masterOn);
    setRadarEnabled(true);

    hoisted.publishRadar("left");

    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
  });

  it("stops scheduled ticks mid-loop when the master gate flips off", () => {
    let masterOn = true;
    registerRadarEngine(hoisted.bus, () => masterOn);
    setRadarEnabled(true);
    hoisted.publishRadar("left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

    // Master gate flips off (e.g. user un-checks the global setting via PI).
    masterOn = false;

    // The next scheduled tick lands but the master-gate check inside
    // `fire()` aborts before `playOnChannel` is invoked.
    vi.advanceTimersByTime(250);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
  });

  it("re-firing radar.changed while master is off still suppresses the engine", () => {
    let masterOn = false;
    registerRadarEngine(hoisted.bus, () => masterOn);
    setRadarEnabled(true);

    hoisted.publishRadar("left");
    hoisted.publishRadar("right", "left");
    hoisted.publishRadar("both", "right");

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();
  });

  it("flipping the master gate back on lets the next radar.changed fire ticks", () => {
    let masterOn = false;
    registerRadarEngine(hoisted.bus, () => masterOn);
    setRadarEnabled(true);

    hoisted.publishRadar("left");
    expect(hoisted.playOnChannel).not.toHaveBeenCalled();

    masterOn = true;
    hoisted.publishRadar("right", "left");
    expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    expect(hoisted.playOnChannel.mock.calls.at(-1)?.[1]).toContain("IRD-radar-right");
  });

  // Defense-in-depth: when the master gate aborts the tick, the icon
  // shouldn't stay "occupied" indefinitely. Without this, a failed
  // `setRadarEnabled(false)` (the failure mode this gate exists for)
  // would leave subscribers latched on the last non-clear state.
  it("clears latched visualState when the master gate aborts a scheduled tick", () => {
    let masterOn = true;
    registerRadarEngine(hoisted.bus, () => masterOn);
    setRadarEnabled(true);
    hoisted.publishRadar("left");
    expect(getRadarVisualState()).toBe("left");

    masterOn = false;
    vi.advanceTimersByTime(250);

    expect(getRadarVisualState()).toBe("clear");
  });

  it("clears latched visualState when the master gate suppresses a radar.changed event", () => {
    let masterOn = true;
    registerRadarEngine(hoisted.bus, () => masterOn);
    setRadarEnabled(true);
    hoisted.publishRadar("left");
    expect(getRadarVisualState()).toBe("left");

    // Master flips off, then a fresh transition arrives. The handler
    // aborts at the master-gate check before processing `to`, but
    // clears the stale latched state so subscribers don't keep
    // showing the previous "occupied" icon.
    masterOn = false;
    hoisted.publishRadar("right", "left");

    expect(getRadarVisualState()).toBe("clear");
  });
});

describe("Lone Qualify suppression", () => {
  it("ignores events during Lone Qualify", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.getSessionType.mockReturnValue("Lone Qualify");

    hoisted.publishRadar("left");

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    expect(getRadarVisualState()).toBe("clear");
  });

  it("tears down an already-running loop when the session flips to Lone Qualify", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishRadar("left");
    expect(getRadarVisualState()).toBe("left");

    hoisted.getSessionType.mockReturnValue("Lone Qualify");
    hoisted.publishRadar("both", "left");

    expect(getRadarVisualState()).toBe("clear");
    expect(hoisted.stopChannel).toHaveBeenCalledWith(RADAR_CHANNEL);
  });
});

describe("setRadarEnabled", () => {
  it("clears visual state, stops the channel, and notifies listeners on disable", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishRadar("left");
    expect(getRadarVisualState()).toBe("left");

    const listener = vi.fn();
    subscribeRadarVisualState(listener);

    setRadarEnabled(false);

    expect(hoisted.stopChannel).toHaveBeenCalledWith(RADAR_CHANNEL);
    expect(getRadarVisualState()).toBe("clear");
    expect(listener).toHaveBeenCalledWith("clear");
  });

  it("is idempotent when re-enabled — waits for next event before playing", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    setRadarEnabled(true);

    expect(hoisted.playOnChannel).not.toHaveBeenCalled();

    hoisted.publishRadar("left");
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
    hoisted.publishRadar("left");
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
    hoisted.publishRadar("left");
    const callsBeforeTest = hoisted.playOnChannel.mock.calls.length;

    playRadarTest();

    // Live transition during preview — visual flips, but no extra live playback.
    hoisted.publishRadar("both", "left");
    expect(getRadarVisualState()).toBe("both");
    // playRadarTest has fired 1 clip; live event added no playback on top.
    expect(hoisted.playOnChannel.mock.calls.length - callsBeforeTest).toBe(1);
  });

  it("resumes the live tick loop at the current state after the preview completes", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);
    hoisted.publishRadar("left");
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

    hoisted.publishRadar("left");
    expect(listener).toHaveBeenCalledWith("left");

    unsubscribe();

    hoisted.publishRadar("both", "left");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not fire when transitioning between identical states", () => {
    registerRadarEngine(hoisted.bus);
    setRadarEnabled(true);

    const listener = vi.fn();
    subscribeRadarVisualState(listener);

    hoisted.publishRadar("left");
    hoisted.publishRadar("left", "left");

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
