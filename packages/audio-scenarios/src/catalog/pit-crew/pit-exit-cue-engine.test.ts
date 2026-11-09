/**
 * Unit tests for the pit exit cue (issue #1161): one tone per `pitLane.exited`
 * on the Cue channel, gated live by the Race Engineer master and the cue's
 * opt-in, silent on a positive "not in the car" or "replay" read and audible
 * when the telemetry says nothing.
 *
 * The bus is a recording fake that calls the handler directly, rather than the
 * real bus: the real one isolates a throwing subscriber, which would make the
 * "a playback failure never escapes the handler" case pass whatever the engine
 * did.
 */
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetPitExitCueEngine,
  PIT_EXIT_CLIP,
  type PitExitCueDeps,
  readPitExitCueDebugState,
  registerPitExitCueEngine,
} from "./pit-exit-cue-engine.js";

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const hoisted = await vi.hoisted(async () => {
  const { createFakeAudio } = await import("@iracedeck/audio-service/testing");
  const audio = createFakeAudio();
  const getAudio = vi.fn(() => audio);

  return { audio, getAudio };
});

// Only `getAudio` is replaced; the enums stay the real ones, so the channel
// asserted below is the production `AudioChannel.Cue`.
vi.mock("@iracedeck/audio-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/audio-service")>()),
  getAudio: hoisted.getAudio,
}));

type Handler = (event: SimEventOf<"pitLane.exited">) => void;

const handlers = new Map<string, Set<Handler>>();

function makeBus(): IEventBus {
  const subscribe = vi.fn((name: string, handler: Handler) => {
    let set = handlers.get(name);

    if (!set) {
      set = new Set();
      handlers.set(name, set);
    }

    set.add(handler);

    return () => set?.delete(handler);
  });

  return { subscribe, unsubscribe: vi.fn(), publish: vi.fn() } as unknown as IEventBus;
}

let bus: IEventBus;

/** Publish `pitLane.exited` with the tick's telemetry, as the translator's envelope carries it. */
function exitPitRoad(telemetry: unknown = { IsOnTrack: true, IsReplayPlaying: false }): void {
  const event = { event: "pitLane.exited", timestamp: 0, telemetry, data: {} } as SimEventOf<"pitLane.exited">;

  for (const handler of Array.from(handlers.get("pitLane.exited") ?? [])) handler(event);
}

let masterEnabled = true;
let cueEnabled = true;

const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };

function deps(overrides: Partial<PitExitCueDeps> = {}): PitExitCueDeps {
  return {
    getMasterEnabled: () => masterEnabled,
    getCueEnabled: () => cueEnabled,
    logger: logger as unknown as PitExitCueDeps["logger"],
    ...overrides,
  };
}

function register(): void {
  registerPitExitCueEngine(bus, deps());
}

beforeEach(() => {
  handlers.clear();
  bus = makeBus();
  masterEnabled = true;
  cueEnabled = true;
  hoisted.audio.playOnChannel.mockClear();
  hoisted.audio._reset();
  hoisted.getAudio.mockClear();
  hoisted.getAudio.mockImplementation(() => hoisted.audio);
  vi.clearAllMocks();
});

afterEach(() => {
  _resetPitExitCueEngine();
});

describe("pit exit cue engine", () => {
  describe("playing", () => {
    it("plays the pit exit tone once per pit exit, on the Cue channel", () => {
      register();
      exitPitRoad();

      expect(hoisted.audio._played).toEqual([{ channel: AudioChannel.Cue, path: PIT_EXIT_CLIP, loop: false }]);

      exitPitRoad();

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledTimes(2);
      expect(hoisted.audio.playOnChannel).toHaveBeenLastCalledWith(AudioChannel.Cue, PIT_EXIT_CLIP);
    });

    it("never touches the Radar channel, whose ticks would cut the beep", () => {
      register();
      exitPitRoad();

      expect(hoisted.audio._played.map((p) => p.channel)).not.toContain(AudioChannel.Radar);
      expect(hoisted.audio.stopChannel).not.toHaveBeenCalled();
    });

    it("logs the play at info, with no parameters", () => {
      register();
      exitPitRoad();

      expect(logger.info).toHaveBeenCalledWith("Pit exit cue played");
      expect(readPitExitCueDebugState()).toEqual({ registered: true, lastOutcome: "played" });
    });
  });

  describe("gates, read live at the event", () => {
    it("stays silent while the Race Engineer master is off, and plays once it is back on", () => {
      register();

      masterEnabled = false;
      exitPitRoad();

      expect(hoisted.audio.playOnChannel).not.toHaveBeenCalled();
      expect(readPitExitCueDebugState().lastOutcome).toBe("master-off");
      expect(logger.debug).toHaveBeenCalledWith("Pit exit cue skipped: the Race Engineer is off");

      masterEnabled = true;
      exitPitRoad();

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledTimes(1);
    });

    it("stays silent while the Pit exit beep is off, and plays once it is back on", () => {
      register();

      cueEnabled = false;
      exitPitRoad();

      expect(hoisted.audio.playOnChannel).not.toHaveBeenCalled();
      expect(readPitExitCueDebugState().lastOutcome).toBe("cue-off");

      cueEnabled = true;
      exitPitRoad();

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledTimes(1);
    });

    it("goes silent when a gate turns off between two pit exits", () => {
      register();
      exitPitRoad();

      cueEnabled = false;
      exitPitRoad();

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledTimes(1);
    });

    it("does not read the audio service at all while gated", () => {
      register();

      masterEnabled = false;
      exitPitRoad();

      expect(hoisted.getAudio).not.toHaveBeenCalled();
    });
  });

  describe("telemetry, read from the edge's own tick", () => {
    it("stays silent when the player is positively not in the car (a tow or reset)", () => {
      register();
      exitPitRoad({ IsOnTrack: false, IsReplayPlaying: false });

      expect(hoisted.audio.playOnChannel).not.toHaveBeenCalled();
      expect(readPitExitCueDebugState().lastOutcome).toBe("not-in-car");
      expect(logger.debug).toHaveBeenCalledWith("Pit exit cue skipped: telemetry reports the player is not in the car");
    });

    it("stays silent in a replay", () => {
      register();
      exitPitRoad({ IsOnTrack: true, IsReplayPlaying: true });

      expect(hoisted.audio.playOnChannel).not.toHaveBeenCalled();
      expect(readPitExitCueDebugState().lastOutcome).toBe("replay");
    });

    it.each([
      ["no telemetry at all", null],
      ["an undefined envelope telemetry", undefined],
      ["a snapshot without either field", {}],
      ["a snapshot with only IsOnTrack true", { IsOnTrack: true }],
      ["a snapshot with only IsReplayPlaying false", { IsReplayPlaying: false }],
      ["a non-object telemetry value", 42],
    ])("plays with %s — unknown data never silences the cue (#912)", (_label, telemetry) => {
      register();
      exitPitRoad(telemetry);

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledExactlyOnceWith(AudioChannel.Cue, PIT_EXIT_CLIP);
    });
  });

  describe("playback failure", () => {
    it("does not throw out of the handler when the audio service is not available", () => {
      register();
      hoisted.getAudio.mockImplementation(() => {
        throw new Error("Audio service not initialized");
      });

      expect(() => exitPitRoad()).not.toThrow();
      expect(readPitExitCueDebugState().lastOutcome).toBe("playback-failed");
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("Pit exit cue playback failed"));
      expect(logger.info).not.toHaveBeenCalled();
    });

    it("does not throw when the play itself throws, and plays on the next pit exit", () => {
      register();
      hoisted.audio.playOnChannel.mockImplementationOnce(() => {
        throw new Error("audio device went away");
      });

      expect(() => exitPitRoad()).not.toThrow();

      exitPitRoad();

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledTimes(2);
      expect(readPitExitCueDebugState().lastOutcome).toBe("played");
    });

    it("reports a refused play rather than claiming it played", () => {
      register();
      hoisted.audio.playOnChannel.mockReturnValueOnce(false);

      exitPitRoad();

      expect(readPitExitCueDebugState().lastOutcome).toBe("playback-refused");
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe("registration", () => {
    it("subscribes to pitLane.exited only", () => {
      register();

      expect([...handlers.keys()]).toEqual(["pitLane.exited"]);
    });

    it("throws when re-registered with a different bus", () => {
      register();

      expect(() => registerPitExitCueEngine(makeBus(), deps())).toThrow(/different event bus/);
    });

    it("swaps the gates when re-registered with the same bus, without subscribing twice", () => {
      register();
      registerPitExitCueEngine(bus, deps({ getCueEnabled: () => false }));

      exitPitRoad();

      expect(hoisted.audio.playOnChannel).not.toHaveBeenCalled();
      expect(handlers.get("pitLane.exited")?.size).toBe(1);
    });

    it("reads as unregistered with no outcome before registration and after a reset", () => {
      expect(readPitExitCueDebugState()).toEqual({ registered: false, lastOutcome: null });

      register();
      exitPitRoad();
      _resetPitExitCueEngine();

      expect(readPitExitCueDebugState()).toEqual({ registered: false, lastOutcome: null });
    });
  });
});
