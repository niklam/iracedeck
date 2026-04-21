import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitEngineer, setDriverNameResolver } from "./index.js";
import { POOLS } from "./pools.js";

// ─── Test utilities (same shape as interpreter.test.ts) ──────────────────────

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

function createMockBus(): IEventBus & { publishEvent: (name: SimEventName, data?: unknown) => void } {
  const handlers = new Map<SimEventName, Set<(e: SimEventOf<SimEventName>) => void>>();

  return {
    subscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      let set = handlers.get(name);

      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }

      set.add(handler as (e: SimEventOf<SimEventName>) => void);

      return () => handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
    },
    unsubscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
    },
    publish: (event: SimEventOf<SimEventName>) => {
      const set = handlers.get(event.event as SimEventName);

      if (!set) return;

      for (const handler of Array.from(set)) handler(event);
    },
    publishEvent(name, data) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry: null as unknown,
        data: data as never,
      } as SimEventOf<SimEventName>);
    },
  };
}

type FakeAudio = IAudioService & {
  _triggerChannelEnd: (channel: AudioChannel) => void;
  _played: { channel: AudioChannel; path: string; loop: boolean }[];
};

function createFakeAudio(): FakeAudio {
  const callbacks: Record<AudioChannel, (() => void) | null> = {
    [AudioChannel.Ambient]: null,
    [AudioChannel.SFX]: null,
    [AudioChannel.Voice]: null,
    [AudioChannel.Spotter]: null,
  };
  const played: { channel: AudioChannel; path: string; loop: boolean }[] = [];

  return {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn((channel: AudioChannel, path: string, loop = false) => {
      played.push({ channel, path, loop });

      return true;
    }),
    stopChannel: vi.fn((channel: AudioChannel) => {
      callbacks[channel] = null;
    }),
    stopAllChannels: vi.fn(),
    setChannelVolume: vi.fn(),
    setBusVolume: vi.fn(),
    getBusVolume: vi.fn(() => 1.0),
    isChannelPlaying: vi.fn(() => false),
    onChannelComplete: vi.fn((channel: AudioChannel, cb: () => void) => {
      callbacks[channel] = cb;
    }),
    playVoiceSequence: vi.fn(),
    cancelVoiceSequence: vi.fn(),
    onVoiceSequenceComplete: vi.fn(),
    seekChannelRandom: vi.fn(),
    getAudioDevices: vi.fn(() => []),
    setAudioDevice: vi.fn(() => true),
    _triggerChannelEnd: (channel: AudioChannel) => {
      const cb = callbacks[channel];
      callbacks[channel] = null;
      cb?.();
    },
    _played: played,
  } as unknown as FakeAudio;
}

/** Build a manifest from the actual pit-engineer pool clip paths so validation is realistic. */
function buildTestManifest(): AudioAssetsManifest {
  const allPoolClips = Object.values(POOLS).flat();
  const clips = [
    ...allPoolClips,
    "pit-engineer/names/IRD-name-niklas.mp3",
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
  ];

  return {
    clips,
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };
}

/** Drain sequential channel-complete callbacks until the sequence is done. */
function flush(audio: FakeAudio, iterations = 30): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;

beforeEach(() => {
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, buildTestManifest(), mockLogger as never);
  registerPitEngineer();
});

afterEach(() => {
  _resetAudioScenarios();
  setDriverNameResolver(() => null);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ─── Welcome scenario ───────────────────────────────────────────────────────

describe("pit-engineer.welcome", () => {
  it("fires the full radio frame when driver.firstOnTrack is published, with name + greeting", () => {
    setDriverNameResolver(() => "pit-engineer/names/IRD-name-niklas.mp3");
    // Force the ~60% greeting branch to run deterministically.
    vi.spyOn(Math, "random").mockReturnValue(0);

    bus.publishEvent("driver.firstOnTrack", {});
    flush(audio);

    const sfx = audio._played.filter((p) => p.channel === AudioChannel.SFX).map((p) => p.path);
    const voice = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    const ambient = audio._played.filter((p) => p.channel === AudioChannel.Ambient);

    // Walkie-talkie opens and closes.
    expect(sfx).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);

    // Voice chain: greeting → driver name → welcome tip. Exact greeting/tip
    // depend on Math.random, but the structure must hold.
    expect(voice.length).toBe(3);
    expect(POOLS.greeting).toContain(voice[0]);
    expect(voice[1]).toBe("pit-engineer/names/IRD-name-niklas.mp3");
    expect(POOLS["welcome-tip"]).toContain(voice[2]);

    // Ambient is started during the frame.
    expect(ambient[0]).toEqual({
      channel: AudioChannel.Ambient,
      path: "sfx/IRD-ambient-pit.mp3",
      loop: true,
    });
    expect(audio.seekChannelRandom).toHaveBeenCalledWith(AudioChannel.Ambient);
    expect(audio.stopChannel).toHaveBeenCalledWith(AudioChannel.Ambient);
  });

  it("omits the driver-name step when the resolver returns null", () => {
    setDriverNameResolver(() => null);
    vi.spyOn(Math, "random").mockReturnValue(0);

    bus.publishEvent("driver.firstOnTrack", {});
    flush(audio);

    const voice = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);

    // With greeting branch forced on: greeting + tip (no name).
    expect(voice.length).toBe(2);
    expect(POOLS.greeting).toContain(voice[0]);
    expect(POOLS["welcome-tip"]).toContain(voice[1]);
  });

  it("omits the greeting when the 60% branch is skipped", () => {
    setDriverNameResolver(() => "pit-engineer/names/IRD-name-niklas.mp3");
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    bus.publishEvent("driver.firstOnTrack", {});
    flush(audio);

    const voice = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);

    // No greeting: name + tip.
    expect(voice.length).toBe(2);
    expect(voice[0]).toBe("pit-engineer/names/IRD-name-niklas.mp3");
    expect(POOLS["welcome-tip"]).toContain(voice[1]);
  });
});
