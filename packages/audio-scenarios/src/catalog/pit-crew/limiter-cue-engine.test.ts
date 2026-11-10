/**
 * Unit tests for the limiter-on cue (issue #1272): one tone per
 * `carControl.limiterToggled` off→on edge on the Cue channel, silent on the
 * on→off edge, and gated live by the Race Engineer master and the cue's
 * opt-in. The engine reads no telemetry: the translator owns every other
 * silence, so telemetry on the envelope must not change what plays.
 *
 * The bus is a recording fake that calls the handler directly, rather than the
 * real bus: the real one isolates a throwing subscriber, which would make the
 * "a playback failure never escapes the handler" case pass whatever the engine
 * did.
 */
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventOf } from "@iracedeck/event-bus";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetLimiterCueEngine,
  LIMITER_ON_CLIP,
  type LimiterCueDeps,
  readLimiterCueDebugState,
  registerLimiterCueEngine,
} from "./limiter-cue-engine.js";
import { PIT_EXIT_CLIP } from "./pit-exit-cue-engine.js";

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

type Handler = (event: SimEventOf<"carControl.limiterToggled">) => void;

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

/** The envelope telemetry a press carries when the test names none: the player in the car. */
const IN_CAR: unknown = { IsOnTrack: true };

/**
 * Publish `carControl.limiterToggled` as the translator does, with this
 * envelope telemetry. No default parameter: one would turn an explicit
 * `undefined` into `IN_CAR`, and the envelope rows below test `undefined`.
 */
function toggle(on: boolean, telemetry: unknown): void {
  const event = {
    event: "carControl.limiterToggled",
    timestamp: 0,
    telemetry,
    data: { on },
  } as SimEventOf<"carControl.limiterToggled">;

  for (const handler of Array.from(handlers.get("carControl.limiterToggled") ?? [])) handler(event);
}

/** An off→on press; with no argument it carries `IN_CAR`, with one (even `undefined`) exactly that. */
const engage = (...args: [telemetry?: unknown]): void => toggle(true, args.length === 0 ? IN_CAR : args[0]);
const disengage = (): void => toggle(false, IN_CAR);

let masterEnabled = true;
let cueEnabled = true;

const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };

function deps(overrides: Partial<LimiterCueDeps> = {}): LimiterCueDeps {
  return {
    getMasterEnabled: () => masterEnabled,
    getCueEnabled: () => cueEnabled,
    logger: logger as unknown as LimiterCueDeps["logger"],
    ...overrides,
  };
}

function register(): void {
  registerLimiterCueEngine(bus, deps());
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
  _resetLimiterCueEngine();
});

describe("limiter cue engine", () => {
  describe("playing", () => {
    it("plays the limiter-on tone once per engagement, on the Cue channel", () => {
      register();
      engage();

      expect(hoisted.audio._played).toEqual([{ channel: AudioChannel.Cue, path: LIMITER_ON_CLIP, loop: false }]);

      engage();

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledTimes(2);
      expect(hoisted.audio.playOnChannel).toHaveBeenLastCalledWith(AudioChannel.Cue, LIMITER_ON_CLIP);
    });

    it("beeps twice for on→off→on, with no debounce: it engaged twice", () => {
      register();
      engage();
      disengage();
      engage();

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledTimes(2);
    });

    it("never touches the Radar channel, whose ticks would cut the beep", () => {
      register();
      engage();

      expect(hoisted.audio._played.map((p) => p.channel)).not.toContain(AudioChannel.Radar);
      expect(hoisted.audio.stopChannel).not.toHaveBeenCalled();
    });

    it("plays its own tone, not the pit exit beep's", () => {
      expect(LIMITER_ON_CLIP).not.toBe(PIT_EXIT_CLIP);
    });

    it("logs the play at info, with no parameters", () => {
      register();
      engage();

      expect(logger.info).toHaveBeenCalledWith("Limiter cue played");
      expect(readLimiterCueDebugState()).toEqual({ registered: true, lastEdge: "on", lastOutcome: "played" });
    });
  });

  describe("the off edge", () => {
    it("stays silent when the limiter switches off", () => {
      register();
      disengage();

      expect(hoisted.audio.playOnChannel).not.toHaveBeenCalled();
      expect(hoisted.getAudio).not.toHaveBeenCalled();
      expect(readLimiterCueDebugState()).toMatchObject({ lastEdge: "off", lastOutcome: null });
    });

    it("reports the off edge even with the gates off: it is no engagement whatever they say", () => {
      register();
      masterEnabled = false;
      cueEnabled = false;
      disengage();

      expect(readLimiterCueDebugState()).toMatchObject({ lastEdge: "off", lastOutcome: null });
    });

    it("leaves the last engagement's outcome standing, so a snapshot after it still says why that one was silent", () => {
      register();
      cueEnabled = false;
      engage();

      expect(readLimiterCueDebugState()).toMatchObject({ lastEdge: "on", lastOutcome: "cue-off" });

      disengage();

      expect(readLimiterCueDebugState()).toMatchObject({ lastEdge: "off", lastOutcome: "cue-off" });
    });
  });

  describe("gates, read live at the event", () => {
    it("stays silent while the Race Engineer master is off, and plays once it is back on", () => {
      register();

      masterEnabled = false;
      engage();

      expect(hoisted.audio.playOnChannel).not.toHaveBeenCalled();
      expect(readLimiterCueDebugState().lastOutcome).toBe("master-off");
      expect(logger.debug).toHaveBeenCalledWith("Limiter cue skipped: the Race Engineer is off");

      masterEnabled = true;
      engage();

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledTimes(1);
    });

    it("stays silent while the Limiter on beep is off, and plays once it is back on", () => {
      register();

      cueEnabled = false;
      engage();

      expect(hoisted.audio.playOnChannel).not.toHaveBeenCalled();
      expect(readLimiterCueDebugState().lastOutcome).toBe("cue-off");
      expect(logger.debug).toHaveBeenCalledWith("Limiter cue skipped: the Limiter on beep is off");

      cueEnabled = true;
      engage();

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledTimes(1);
    });

    it("goes silent when a gate turns off between two engagements", () => {
      register();
      engage();

      cueEnabled = false;
      engage();

      masterEnabled = false;
      cueEnabled = true;
      engage();

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledTimes(1);
    });

    it("does not read the audio service at all while gated", () => {
      register();

      masterEnabled = false;
      engage();
      masterEnabled = true;
      cueEnabled = false;
      engage();

      expect(hoisted.getAudio).not.toHaveBeenCalled();
    });
  });

  describe("telemetry: the engine trusts the event", () => {
    it.each([
      ["no telemetry at all", null],
      ["an undefined envelope telemetry", undefined],
      ["the player out of the car", { IsOnTrack: false }],
      ["the car out of the world", { IsOnTrack: true, PlayerTrackSurface: -1 }],
      ["a replay playing", { IsOnTrack: true, IsReplayPlaying: true }],
      ["pit service active", { IsOnTrack: true, PitstopActive: true, PlayerCarInPitStall: true }],
      ["a car with no limiter control", { IsOnTrack: true, dcPitSpeedLimiterToggle: undefined }],
      ["a non-object telemetry value", 42],
    ])("plays with %s: every silence is the translator's", (_label, telemetry) => {
      register();
      engage(telemetry);

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledExactlyOnceWith(AudioChannel.Cue, LIMITER_ON_CLIP);
    });
  });

  describe("playback failure", () => {
    it("does not throw out of the handler when the audio service is not available", () => {
      register();
      hoisted.getAudio.mockImplementation(() => {
        throw new Error("Audio service not initialized");
      });

      expect(() => engage()).not.toThrow();
      expect(readLimiterCueDebugState().lastOutcome).toBe("playback-failed");
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("Limiter cue playback failed"));
      expect(logger.info).not.toHaveBeenCalled();
    });

    it("does not throw when the play itself throws, and plays on the next engagement", () => {
      register();
      hoisted.audio.playOnChannel.mockImplementationOnce(() => {
        throw new Error("audio device went away");
      });

      expect(() => engage()).not.toThrow();
      expect(readLimiterCueDebugState().lastOutcome).toBe("playback-failed");

      engage();

      expect(hoisted.audio.playOnChannel).toHaveBeenCalledTimes(2);
      expect(readLimiterCueDebugState().lastOutcome).toBe("played");
    });

    it("reports a refused play rather than claiming it played", () => {
      register();
      hoisted.audio.playOnChannel.mockReturnValueOnce(false);

      engage();

      expect(readLimiterCueDebugState().lastOutcome).toBe("playback-refused");
      expect(logger.debug).toHaveBeenCalledWith(`Limiter cue playback refused for ${LIMITER_ON_CLIP}`);
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe("registration", () => {
    it("subscribes to carControl.limiterToggled only", () => {
      register();

      expect([...handlers.keys()]).toEqual(["carControl.limiterToggled"]);
    });

    it("is silent before registration: nothing subscribes", () => {
      engage();

      expect(hoisted.audio.playOnChannel).not.toHaveBeenCalled();
    });

    it("throws when re-registered with a different bus", () => {
      register();

      expect(() => registerLimiterCueEngine(makeBus(), deps())).toThrow(/different event bus/);
    });

    it("swaps the gates when re-registered with the same bus, without subscribing twice", () => {
      register();
      registerLimiterCueEngine(bus, deps({ getCueEnabled: () => false }));

      engage();

      expect(hoisted.audio.playOnChannel).not.toHaveBeenCalled();
      expect(readLimiterCueDebugState().lastOutcome).toBe("cue-off");
      expect(handlers.get("carControl.limiterToggled")?.size).toBe(1);
    });

    it("reads as unregistered with no outcome before registration and after a reset", () => {
      expect(readLimiterCueDebugState()).toEqual({ registered: false, lastEdge: null, lastOutcome: null });

      register();
      engage();
      _resetLimiterCueEngine();

      expect(readLimiterCueDebugState()).toEqual({ registered: false, lastEdge: null, lastOutcome: null });
    });
  });
});

/**
 * The tone the engine names is a real file in `@iracedeck/audio-assets`, whose
 * `sfx/` is copied into the plugins unchanged: a missing or misnamed clip would
 * leave every engagement silent with only a debug line. Resolved through the
 * package's `./sfx/*` export, never by a relative path into its directory
 * (#1375). The format pinned is the one its JSDoc renders: a plain mono 48 kHz
 * 16-bit PCM WAV with only `fmt ` and `data`, 170 ms long.
 */
describe("the limiter-on clip", () => {
  const wav = readFileSync(createRequire(import.meta.url).resolve(`@iracedeck/audio-assets/${LIMITER_ON_CLIP}`));

  it("is a mono 48 kHz 16-bit PCM WAV with no metadata chunks", () => {
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
  });

  it("lasts 170 ms, inside the spec's 250 ms", () => {
    const samples = wav.readUInt32LE(40) / 2;

    expect(samples / 48).toBe(170);
  });

  it("is a different recording from the pit exit beep, not a copy of it", () => {
    const exit = readFileSync(createRequire(import.meta.url).resolve(`@iracedeck/audio-assets/${PIT_EXIT_CLIP}`));

    expect(wav.equals(exit)).toBe(false);
  });
});
