import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { buildRaceEndScenario, type RaceFinishedSnapshot, registerRaceEndVars } from "./race-end.js";
import { RADIO_CLOSE, RADIO_OPEN } from "./radio-frame.js";

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
  publishEvent: <T extends SimEventName>(name: T, data: SimEventMap[T]["data"]) => void;
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

      return () => {
        handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
      };
    },
    unsubscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
    },
    publish: (event: SimEventOf<SimEventName>) => {
      const set = handlers.get(event.event as SimEventName);

      if (!set) return;

      for (const handler of Array.from(set)) handler(event);
    },
    publishEvent<T extends SimEventName>(name: T, data: SimEventMap[T]["data"]) {
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
    [AudioChannel.Radar]: null,
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

function flush(audio: FakeAudio, iterations = 30): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const VOICE = "luca";

// A voice with only the "driver" greeting — exercises the optional greeting
// skip (issue #835).
const BARE_VOICE = "bare";
// A voice with no position-number clips — a required clip is missing for the
// composed P4+ readout, so the whole callout must abort (issue #835).
const PARTIAL_VOICE = "partial";

const GREETING_NAMES = ["niklas", "driver"];

const RACE_END_CLIPS = ["we-won-01", "second-place-01", "podium-third-01", "race-over-result-is-01"];

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...GREETING_NAMES.map((n) => `voice/${VOICE}/race-end-greeting/${n}.mp3`),
    ...RACE_END_CLIPS.map((c) => `voice/${VOICE}/race-end/${c}.mp3`),
    ...Array.from({ length: 64 }, (_, i) => `voice/${VOICE}/position-number/${i + 1}.mp3`),
    `voice/${BARE_VOICE}/race-end-greeting/driver.mp3`,
    ...RACE_END_CLIPS.map((c) => `voice/${BARE_VOICE}/race-end/${c}.mp3`),
    ...Array.from({ length: 64 }, (_, i) => `voice/${BARE_VOICE}/position-number/${i + 1}.mp3`),
    ...GREETING_NAMES.map((n) => `voice/${PARTIAL_VOICE}/race-end-greeting/${n}.mp3`),
    ...RACE_END_CLIPS.map((c) => `voice/${PARTIAL_VOICE}/race-end/${c}.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

const BASE_SNAPSHOT: RaceFinishedSnapshot = {
  position: 5,
  classPosition: undefined,
  isMultiClass: false,
  driverName: "niklas",
};

function snap(overrides: Partial<RaceFinishedSnapshot> = {}): RaceFinishedSnapshot {
  return { ...BASE_SNAPSHOT, ...overrides };
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let activeVoice: string;
let currentSnapshot: RaceFinishedSnapshot | null;

function fire(snapshot: RaceFinishedSnapshot | null): void {
  currentSnapshot = snapshot;
  bus.publishEvent("race.finished", { position: snapshot?.position ?? 0 });
  flush(audio);
}

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function hasClip(suffix: string): boolean {
  return voicePaths().some((p) => p.endsWith(suffix));
}

beforeEach(() => {
  currentSnapshot = null;
  activeVoice = VOICE;
  bus = createMockBus();
  audio = createFakeAudio();
  const engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => activeVoice);

  registerRaceEndVars(engine, () => currentSnapshot);
  engine.defineScenario(RADIO_OPEN);
  engine.defineScenario(RADIO_CLOSE);
  engine.defineScenario(buildRaceEndScenario(() => currentSnapshot));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
});

describe("race-end scenario — result branches", () => {
  it("plays greeting + we-won for P1", () => {
    fire(snap({ position: 1 }));

    expect(hasClip("/race-end-greeting/niklas.mp3")).toBe(true);
    expect(hasClip("/race-end/we-won-01.mp3")).toBe(true);
  });

  it("plays second-place for P2 and podium-third for P3", () => {
    fire(snap({ position: 2 }));
    expect(hasClip("/race-end/second-place-01.mp3")).toBe(true);

    audio._played.length = 0;
    fire(snap({ position: 3 }));
    expect(hasClip("/race-end/podium-third-01.mp3")).toBe(true);
  });

  it("plays the composed result + position number for P4+", () => {
    fire(snap({ position: 7 }));

    expect(hasClip("/race-end/race-over-result-is-01.mp3")).toBe(true);
    expect(hasClip("/position-number/7.mp3")).toBe(true);
  });

  it("stays silent when the snapshot resolver returns null", () => {
    fire(null);

    expect(audio._played).toEqual([]);
  });
});

describe("per-voice clip availability (issue #835)", () => {
  it("skips the greeting for a voice lacking the picked name clip, playing the result", () => {
    activeVoice = BARE_VOICE;
    fire(snap({ position: 1, driverName: "niklas" }));

    expect(voicePaths().some((p) => p.includes("race-end-greeting"))).toBe(false);
    expect(hasClip("/race-end/we-won-01.mp3")).toBe(true);
  });

  it("still greets by name when the voice has the clip", () => {
    activeVoice = BARE_VOICE;
    fire(snap({ position: 1, driverName: "driver" }));

    expect(hasClip("/race-end-greeting/driver.mp3")).toBe(true);
  });

  it("skips the WHOLE callout for a voice missing a required clip (position numbers) — never a fragment", () => {
    activeVoice = PARTIAL_VOICE;
    fire(snap({ position: 7 }));

    expect(audio._played).toEqual([]);
  });
});
