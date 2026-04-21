import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { PitSvFlags } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitEngineer } from "./index.js";
import { POOLS } from "./pools.js";

// ─── Test utilities ─────────────────────────────────────────────────────────

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

function createMockBus(): IEventBus & {
  publishPitEntry: (telemetry: Record<string, unknown>) => void;
} {
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
    publishPitEntry(telemetry) {
      this.publish({
        event: "pitLane.entered",
        timestamp: Date.now(),
        telemetry: telemetry as never,
        data: {} as never,
      } as SimEventOf<"pitLane.entered">);
    },
  };
}

type FakeAudio = IAudioService & {
  _triggerChannelEnd: (channel: AudioChannel) => void;
  _played: { channel: AudioChannel; path: string }[];
};

function createFakeAudio(): FakeAudio {
  const callbacks: Record<AudioChannel, (() => void) | null> = {
    [AudioChannel.Ambient]: null,
    [AudioChannel.SFX]: null,
    [AudioChannel.Voice]: null,
    [AudioChannel.Spotter]: null,
  };
  const played: { channel: AudioChannel; path: string }[] = [];

  return {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn((channel: AudioChannel, path: string) => {
      played.push({ channel, path });

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

function buildTestManifest(): AudioAssetsManifest {
  const allPoolClips = Object.values(POOLS).flat();
  const reminderClips = [
    "pit-engineer/reminder/IRD-pit-reminder-fast-repair.mp3",
    "pit-engineer/reminder/IRD-pit-reminder-fuel.mp3",
    "pit-engineer/reminder/IRD-pit-reminder-compound.mp3",
    "pit-engineer/reminder/IRD-pit-reminder-tires.mp3",
  ];

  return {
    clips: [
      ...allPoolClips,
      ...reminderClips,
      "sfx/IRD-tick-open.mp3",
      "sfx/IRD-tick-close.mp3",
      "sfx/IRD-ambient-pit.mp3",
    ],
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };
}

function flush(audio: FakeAudio, iterations = 40): void {
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
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ─── Service-reminder scenario ─────────────────────────────────────────────

describe("pit-engineer.service-reminder", () => {
  it("plays generic fuel + tires when FuelFill and tires are queued (no auto-fuel)", () => {
    bus.publishPitEntry({
      PitSvFlags: PitSvFlags.FuelFill | PitSvFlags.LFTireChange | PitSvFlags.RFTireChange,
      PlayerTireCompound: 0,
      PitSvTireCompound: 0,
      dpFuelAutoFillActive: 0,
    });
    flush(audio);

    const voice = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(voice).toEqual([
      "pit-engineer/reminder/IRD-pit-reminder-fuel.mp3",
      "pit-engineer/reminder/IRD-pit-reminder-tires.mp3",
    ]);
  });

  it("plays autofuel reminder instead of generic fuel when auto-fuel is active", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    bus.publishPitEntry({
      PitSvFlags: PitSvFlags.FuelFill,
      PlayerTireCompound: 0,
      PitSvTireCompound: 0,
      dpFuelAutoFillActive: 1,
    });
    flush(audio);

    const voice = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(voice.length).toBe(1);
    expect(POOLS["autofuel-reminder"]).toContain(voice[0]);
  });

  it("plays compound reminder when the queued compound differs from the current one", () => {
    bus.publishPitEntry({
      PitSvFlags: PitSvFlags.LFTireChange,
      PlayerTireCompound: 0,
      PitSvTireCompound: 1,
      dpFuelAutoFillActive: 0,
    });
    flush(audio);

    const voice = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(voice).toEqual(["pit-engineer/reminder/IRD-pit-reminder-compound.mp3"]);
  });

  it("plays nothing beyond the radio frame when no services are queued", () => {
    bus.publishPitEntry({
      PitSvFlags: 0,
      PlayerTireCompound: 0,
      PitSvTireCompound: 0,
      dpFuelAutoFillActive: 0,
    });
    flush(audio);

    const voice = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(voice).toEqual([]);
    // Radio open/close still fire.
    const sfx = audio._played.filter((p) => p.channel === AudioChannel.SFX).map((p) => p.path);
    expect(sfx).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
  });

  it("plays fast-repair first, then fuel, then tires", () => {
    bus.publishPitEntry({
      PitSvFlags: PitSvFlags.FastRepair | PitSvFlags.FuelFill | PitSvFlags.LFTireChange,
      PlayerTireCompound: 0,
      PitSvTireCompound: 0,
      dpFuelAutoFillActive: 0,
    });
    flush(audio);

    const voice = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(voice).toEqual([
      "pit-engineer/reminder/IRD-pit-reminder-fast-repair.mp3",
      "pit-engineer/reminder/IRD-pit-reminder-fuel.mp3",
      "pit-engineer/reminder/IRD-pit-reminder-tires.mp3",
    ]);
  });
});
