/**
 * Unit tests for the pit-road speeding cue engine (issue #912).
 *
 * The behaviour that matters most is that the loop always stops. The engine is
 * the third of three independent layers guarding that (the diff and the
 * translator teardowns are the other two), so these tests cover its own stop
 * paths rather than assuming an `ended` will always arrive.
 */
import type { IEventBus } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetPitSpeedingEngine,
  PIT_SPEEDING_CLIP,
  PIT_SPEEDING_TICK_INTERVAL_MS,
  registerPitSpeedingEngine,
} from "./pit-speeding-engine.js";

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => {
  const playOnChannel = vi.fn<(...args: unknown[]) => boolean>().mockReturnValue(true);
  const stopChannel = vi.fn();
  const audio = { playOnChannel, stopChannel, onChannelComplete: vi.fn() };
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
  const bus = { subscribe, unsubscribe: vi.fn(), publish: vi.fn() } as unknown as IEventBus;
  const emit = (name: string): void => {
    const set = busHandlers.get(name);

    if (!set) return;

    for (const h of Array.from(set)) h({ event: name, data: {} });
  };

  const getLatestTelemetry = vi.fn<() => { OnPitRoad?: boolean; SessionTick?: number } | null>();

  return { audio, playOnChannel, stopChannel, getAudio, busHandlers, subscribe, bus, emit, getLatestTelemetry };
});

vi.mock("@iracedeck/audio-service", () => ({
  AudioChannel: { Ambient: 0, SFX: 1, Voice: 2, Radar: 3 },
  getAudio: hoisted.getAudio,
}));

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getLatestTelemetry: hoisted.getLatestTelemetry,
}));

const RADAR_CHANNEL = 3;

let masterEnabled = true;
let cueEnabled = true;

function register(): void {
  registerPitSpeedingEngine(hoisted.bus, {
    getMasterEnabled: () => masterEnabled,
    getCueEnabled: () => cueEnabled,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  masterEnabled = true;
  cueEnabled = true;
  hoisted.playOnChannel.mockClear();
  hoisted.playOnChannel.mockReturnValue(true);
  hoisted.playOnChannel.mockImplementation(() => true);
  hoisted.stopChannel.mockClear();
  hoisted.subscribe.mockClear();
  hoisted.busHandlers.clear();
  hoisted.getLatestTelemetry.mockReset();
  // On pit road with a LIVE sim: iRacing advances SessionTick at ~60 Hz, so a
  // 1 Hz cue tick sees it jump by roughly 60 each time. Tests that need a
  // frozen sim override this with a constant.
  let sessionTick = 0;
  hoisted.getLatestTelemetry.mockImplementation(() => ({ OnPitRoad: true, SessionTick: (sessionTick += 60) }));
});

afterEach(() => {
  _resetPitSpeedingEngine();
  vi.useRealTimers();
});

describe("pit-speeding cue engine", () => {
  describe("the loop", () => {
    it("plays immediately on started — a warning that waits out its interval arrives late", () => {
      register();
      hoisted.emit("pitSpeeding.started");

      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(RADAR_CHANNEL, PIT_SPEEDING_CLIP);
    });

    it("repeats at the tick interval while the episode runs", () => {
      register();
      hoisted.emit("pitSpeeding.started");

      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 3);

      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(4);
    });

    it("stops on ended and never plays again", () => {
      register();
      hoisted.emit("pitSpeeding.started");
      hoisted.emit("pitSpeeding.ended");

      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 10);

      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    });

    it("does not stack timers when started arrives twice", () => {
      register();
      hoisted.emit("pitSpeeding.started");
      hoisted.emit("pitSpeeding.started");

      // Two leading-edge plays, then a single loop — not two interleaved ones.
      hoisted.playOnChannel.mockClear();
      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS);

      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    });

    it("never stops the shared Radar channel — the in-flight tick finishes naturally", () => {
      register();
      hoisted.emit("pitSpeeding.started");
      hoisted.emit("pitSpeeding.ended");

      expect(hoisted.stopChannel).not.toHaveBeenCalled();
    });
  });

  describe("gating", () => {
    it("plays nothing when the Race Engineer master is off", () => {
      masterEnabled = false;
      register();
      hoisted.emit("pitSpeeding.started");

      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 3);

      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("plays nothing when the cue opt-in is off", () => {
      cueEnabled = false;
      register();
      hoisted.emit("pitSpeeding.started");

      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 3);

      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it.each([
      ["master", () => (masterEnabled = false)],
      ["cue opt-in", () => (cueEnabled = false)],
    ])("goes silent within one interval when the %s is switched off mid-episode", (_label, disable) => {
      register();
      hoisted.emit("pitSpeeding.started");
      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

      disable();
      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 5);

      // The gates are read live inside the tick, so no push path is needed.
      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["master", () => (masterEnabled = false), () => (masterEnabled = true)],
      ["cue opt-in", () => (cueEnabled = false), () => (cueEnabled = true)],
    ])("resumes mid-episode when the %s is switched back on", (_label, disable, enable) => {
      register();
      hoisted.emit("pitSpeeding.started");
      disable();
      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 3);
      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

      // The loop is kept alive while gated rather than stopped, so a driver who
      // re-enables the engineer part-way through an episode is warned for the
      // rest of it. Stopping would leave them silently unwarned, since the
      // translator holds the episode and will not re-emit `started`.
      enable();
      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 2);

      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);
    });

    it("starts the loop even when gated, so a mid-episode enable is heard", () => {
      masterEnabled = false;
      register();
      hoisted.emit("pitSpeeding.started");
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();

      masterEnabled = true;
      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS);

      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    });
  });

  describe("frozen sim (the hole a positive OnPitRoad false cannot close)", () => {
    it("falls silent when SessionTick stops advancing", () => {
      register();
      hoisted.emit("pitSpeeding.started");
      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

      // A paused or hung sim notifies no subscribers, so the diff can never
      // publish `ended`, no disconnect fires, and the frozen snapshot still
      // says the driver is speeding on pit road. Without this guard the cue
      // beeps over a paused game forever.
      hoisted.getLatestTelemetry.mockReturnValue({ OnPitRoad: true, SessionTick: 4242 });
      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 5);

      // One more tick lands before the repeat is recognised as frozen.
      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(2);
    });

    it("resumes when the sim unpauses, because the driver is still speeding", () => {
      register();
      hoisted.emit("pitSpeeding.started");
      hoisted.getLatestTelemetry.mockReturnValue({ OnPitRoad: true, SessionTick: 4242 });
      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 3);
      const whileFrozen = hoisted.playOnChannel.mock.calls.length;

      let tick = 4242;
      hoisted.getLatestTelemetry.mockImplementation(() => ({ OnPitRoad: true, SessionTick: (tick += 60) }));
      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 2);

      // Going silent rather than stopping is what makes this possible: the
      // episode is still live and the loop is still scheduled.
      expect(hoisted.playOnChannel.mock.calls.length).toBeGreaterThan(whileFrozen);
    });

    it("does not engage on a build whose telemetry has no SessionTick", () => {
      // `SDKController` only dedupes when the field is defined, so without it
      // every poll is delivered and the diff keeps running normally — the
      // guard would be suppressing a cue that has a working stop path.
      hoisted.getLatestTelemetry.mockReturnValue({ OnPitRoad: true });
      register();
      hoisted.emit("pitSpeeding.started");

      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 3);

      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(4);
    });
  });

  describe("the level backstop (layer 3)", () => {
    it("stops the loop when telemetry positively reports leaving pit road, even with no ended", () => {
      register();
      hoisted.emit("pitSpeeding.started");

      hoisted.getLatestTelemetry.mockReturnValue({ OnPitRoad: false });
      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 5);

      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["null telemetry", null],
      ["telemetry with no OnPitRoad field", {}],
    ])("keeps playing on %s — unknown data must not silence a warning", (_label, telemetry) => {
      register();
      hoisted.emit("pitSpeeding.started");

      hoisted.getLatestTelemetry.mockReturnValue(telemetry);
      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 2);

      // Also what keeps the cue auditionable from the scenario harness, where
      // nothing real sits behind the shortcut buttons.
      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);
    });
  });

  describe("playback failure", () => {
    it("keeps the loop alive so a late-starting audio device still gets the warning", () => {
      // Diverges from radar-engine, which drops the timer and relies on the
      // next `radar.changed` to re-drive it. This cue has no such retry, so
      // dropping it would lose the whole episode.
      hoisted.playOnChannel.mockReturnValue(false);
      register();
      hoisted.emit("pitSpeeding.started");

      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 2);
      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(3);

      hoisted.playOnChannel.mockReturnValue(true);
      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS);

      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(4);
    });

    it("survives a throw from the audio layer instead of killing the plugin", () => {
      // Every tick after the leading edge runs from a bare setTimeout, outside
      // the event bus's handler try/catch. An unhandled throw there is an
      // uncaught exception in a Node timer, which ends the plugin process —
      // `getAudio()` throws when the audio service is not initialised, and the
      // on-demand playback device (#849) can be torn down mid-episode.
      register();
      hoisted.emit("pitSpeeding.started");

      hoisted.playOnChannel.mockImplementation(() => {
        throw new Error("audio device went away");
      });

      expect(() => vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS * 2)).not.toThrow();

      hoisted.playOnChannel.mockImplementation(() => true);
      vi.advanceTimersByTime(PIT_SPEEDING_TICK_INTERVAL_MS);

      // And the loop is still alive, so the warning resumes.
      expect(hoisted.playOnChannel.mock.calls.length).toBeGreaterThan(3);
    });
  });

  describe("registration", () => {
    it("subscribes to both episode edges", () => {
      register();

      expect(hoisted.busHandlers.has("pitSpeeding.started")).toBe(true);
      expect(hoisted.busHandlers.has("pitSpeeding.ended")).toBe(true);
    });

    it("throws when re-registered with a different bus", () => {
      register();
      const otherBus = { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() } as unknown as IEventBus;

      expect(() =>
        registerPitSpeedingEngine(otherBus, { getMasterEnabled: () => true, getCueEnabled: () => true }),
      ).toThrow(/different event bus/);
    });

    it("refreshes the gates when re-registered with the same bus", () => {
      register();
      registerPitSpeedingEngine(hoisted.bus, { getMasterEnabled: () => false, getCueEnabled: () => true });

      hoisted.emit("pitSpeeding.started");

      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });
  });
});
