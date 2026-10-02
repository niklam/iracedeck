/**
 * The #1108 pit exit replayed through the engine (issues #1108, #1185): the
 * exit readback, the tire-wear report published right behind it, and a flag
 * that lands while the readback plays.
 *
 * Under the engine's one pending slot the report waited alone in that slot
 * while the readback played, and any fire of at least its weight arriving
 * then took the slot: the stint summary the driver pitted to hear was never
 * spoken. `queueBehind` fixed only the ordered pair known at design time.
 * Under the bus's queue (issue #1185) the flag waits beside the report and
 * the heavier plays first, so all three are heard.
 *
 * Every pit-crew contract is registered as a plugin registers them, against
 * the bundled voice's real script and manifest, and the clips end on a timer
 * rather than by hand, so the lines overlap as they would on the radio.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { CalloutScript } from "@iracedeck/callout-script";
import type { IEventBus, SimEventName, SimEventOf, TireWearReport } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

const VOICE = "default";
const SCRIPT = defaultScript as CalloutScript;
const MANIFEST = manifestJson as AudioAssetsManifest;

/** Clip lengths near the bundled voice's (see `crash-caution-sequence.test.ts`). */
const VOICE_CLIP_MS = 2000;
const SFX_CLIP_MS = 290;

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

function createMockBus(): IEventBus {
  const handlers = new Map<SimEventName, Set<(e: SimEventOf<SimEventName>) => void>>();

  return {
    subscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      let set = handlers.get(name);

      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }

      set.add(handler as (e: SimEventOf<SimEventName>) => void);

      return () => {
        handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
      };
    },
    unsubscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
    },
    publish: (e: SimEventOf<SimEventName>) => {
      for (const handler of Array.from(handlers.get(e.event as SimEventName) ?? [])) handler(e);
    },
  } as unknown as IEventBus;
}

/** An audio service whose clips end on the (fake) clock, after their length. */
function createTimedAudio(): IAudioService {
  const callbacks = new Map<AudioChannel, () => void>();
  const timers = new Map<AudioChannel, ReturnType<typeof setTimeout>>();

  const stop = (channel: AudioChannel): void => {
    clearTimeout(timers.get(channel));
    timers.delete(channel);
    callbacks.delete(channel);
  };

  return {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn((channel: AudioChannel, _path: string) => {
      clearTimeout(timers.get(channel));
      timers.set(
        channel,
        setTimeout(
          () => {
            const cb = callbacks.get(channel);

            timers.delete(channel);
            callbacks.delete(channel);
            cb?.();
          },
          channel === AudioChannel.SFX ? SFX_CLIP_MS : VOICE_CLIP_MS,
        ),
      );

      return true;
    }),
    stopChannel: vi.fn(stop),
    stopAllChannels: vi.fn(),
    setChannelVolume: vi.fn(),
    setBusVolume: vi.fn(),
    getBusVolume: vi.fn(() => 1.0),
    isChannelPlaying: vi.fn(() => false),
    onChannelComplete: vi.fn((channel: AudioChannel, cb: () => void) => {
      callbacks.set(channel, cb);
    }),
    playVoiceSequence: vi.fn(),
    cancelVoiceSequence: vi.fn(),
    onVoiceSequenceComplete: vi.fn(),
    seekChannelRandom: vi.fn(),
    getAudioDevices: vi.fn(() => []),
    setAudioDevice: vi.fn(() => true),
  } as unknown as IAudioService;
}

/** A worn set with a speakable tread on every tire — what the report needs to fire. */
const REPORT: TireWearReport = {
  corners: {
    lf: { inside: 89.2, middle: 90.4, outside: 91.1, tread: 89.2, zone: "inside" },
    rf: { inside: 90.6, middle: 91.3, outside: 92.8, tread: 90.6, zone: "inside" },
    lr: { inside: 87.9, middle: 87.4, outside: 88.6, tread: 87.4, zone: "middle" },
    rr: { inside: 85.3, middle: 86.1, outside: 88.0, tread: 85.3, zone: "inside" },
  },
  heaviest: { corner: "rr", zone: "inside" },
};

const READBACK = "pit-crew.pit-readback-exit";
const REPORT_ID = "pit-crew.tire-wear-report";
const BLUE = "pit-crew.flag-blue";

let bus: IEventBus;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  bus = createMockBus();
  initializeAudioScenarios(bus, createTimedAudio(), MANIFEST, mockLogger as never, () => VOICE);
  registerPitCrew(bus, { logger: mockLogger as never });
  getScenarioEngine().setScripts(new Map([[VOICE, SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.useRealTimers();
});

function publish(event: SimEventName, data: unknown): void {
  bus.publish({ event, timestamp: Date.now(), telemetry: null, data } as unknown as SimEventOf<SimEventName>);
}

/** The scenarios that started playing, in order — what the driver heard begin. */
function heard(): string[] {
  return mockLogger.info.mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.startsWith("Playing scenario"))
    .map((message) => message.slice('Playing scenario "'.length, -1));
}

/** Every drop the queue logged — superseded, full, expired, cleared. */
function queueDrops(): string[] {
  return mockLogger.debug.mock.calls
    .map(([message]) => String(message))
    .filter((message) => / dropped — /.test(message));
}

describe("the #1108 pit exit replayed through the engine (issues #1108, #1185)", () => {
  it("a flag landing while the exit readback plays waits beside the report: the readback, the flag and the report are all heard", () => {
    // The translator publishes the two from the same settle timer, readback
    // first: the readback takes the idle bus and the report waits.
    publish("pitService.readbackRequested", { reason: "exit" });
    publish("tireWear.reported", REPORT);

    expect(heard()).toEqual([READBACK]);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      `Scenario "${REPORT_ID}" pending (1 of 1) — waiting for bus (higher weight, no interrupt)`,
    );

    // +1 s, the car rejoining traffic: a blue flag, heavier than the report.
    // It cannot cut the readback (no interrupt), so it waits too — ahead of
    // the report, which used to be the line it replaced.
    vi.advanceTimersByTime(1000);
    publish("flag.blue.raised", {});

    expect(mockLogger.debug).toHaveBeenCalledWith(
      `Scenario "${BLUE}" pending (1 of 2) — waiting for bus (higher weight, no interrupt)`,
    );

    vi.advanceTimersByTime(60_000);

    expect(heard()).toEqual([READBACK, BLUE, REPORT_ID]);
    expect(queueDrops()).toEqual([]);
  });
});
