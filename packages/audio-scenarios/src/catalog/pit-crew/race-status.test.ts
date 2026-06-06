/**
 * Race-status periodic position update tests (issue #569), focused on the
 * class-aware "still leading" wording added in issue #599.
 *
 * Drives the scenario through the real scenario engine — same harness shape as
 * `race-start.test.ts` / `overtake.test.ts` — so load-time validation, var
 * resolution, and the leader branch all run the production path. The spoken
 * line reads LIVE position via the `getLivePosition` resolver (issue #574), so
 * the class-vs-race wording is driven by `currentLive.isMultiClass`.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { _resetPositionReadoutCooldown, registerPitCrew } from "./index.js";
import { raceStatusCadenceHits } from "./race-status.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => "Race",
}));

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
      for (const handler of Array.from(handlers.get(event.event as SimEventName) ?? [])) handler(event);
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
  _played: { channel: AudioChannel; path: string }[];
};

function createFakeAudio(): FakeAudio {
  const callbacks: Record<AudioChannel, (() => void) | null> = {
    [AudioChannel.Ambient]: null,
    [AudioChannel.SFX]: null,
    [AudioChannel.Voice]: null,
    [AudioChannel.Radar]: null,
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

function flush(audio: FakeAudio, iterations = 30): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const VOICE = "luca";

const RACE_STATUS_CLIPS = [
  `voice/${VOICE}/race-status/still-leading-01.mp3`,
  `voice/${VOICE}/race-status/still-leading-class-01.mp3`,
  `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
  ...Array.from({ length: 64 }, (_, i) => `voice/${VOICE}/position-number/${i + 1}.mp3`),
];

const manifest: AudioAssetsManifest = {
  clips: ["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3", "sfx/IRD-ambient-pit.mp3", ...RACE_STATUS_CLIPS],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

type LapSnap = SimEventOf<"lap.completed">["data"];
type Live = { position: number; classPosition: number; isMultiClass: boolean };

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let currentSnapshot: LapSnap | null;
let currentLive: Live | null;
let raceFinished: boolean;
let raceStatusEnabled: boolean;

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

/** Fire an every-3-laps cadence hit in a race session (position held). */
function fireStatus(): void {
  const data: Partial<LapSnap> = {
    lap: 6,
    lapTime: 90.5,
    isBest: false,
    sessionType: "race",
    lapsSincePositionChange: 3,
    // Held position keeps the position-change (#566) scenario silent so only
    // the race-status callout speaks.
    position: 1,
    previousPosition: 1,
  };
  currentSnapshot = data as LapSnap;
  bus.publishEvent("lap.completed", data as LapSnap);
  flush(audio);
}

beforeEach(() => {
  currentSnapshot = null;
  currentLive = { position: 1, classPosition: 1, isMultiClass: false };
  raceFinished = false;
  raceStatusEnabled = true;
  _resetPositionReadoutCooldown();
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(
    bus,
    undefined, // getFlagCalloutEnabled
    mockLogger as never,
    undefined, // getPitReadbackEnabled
    undefined, // getPitActionsAllowed
    undefined, // getPitServiceRequestsEnabled
    undefined, // getReadbackSnapshot
    undefined, // getDamageCalloutEnabled
    undefined, // getPitStatusCalloutEnabled
    undefined, // getTrackConditionsCalloutEnabled
    undefined, // getIncidentCalloutEnabled
    undefined, // getSessionStartCalloutEnabled
    undefined, // getSessionStartSnapshot
    undefined, // getLapTimeCalloutEnabled
    () => currentSnapshot, // getLapCompletedSnapshot
    undefined, // getPositionCalloutEnabled
    undefined, // getQualifyingInvalidationCalloutEnabled
    undefined, // getQualifyingInvalidationSnapshot
    () => raceStatusEnabled, // getRaceStatusCalloutEnabled
    () => raceFinished, // getRaceFinishedFired
    undefined, // getRaceEndCalloutEnabled
    undefined, // getRaceFinishedSnapshot
    undefined, // getRaceStartCalloutEnabled
    undefined, // getRaceStartSnapshot
    undefined, // getOvertakeCalloutEnabled
    undefined, // getOvertakeDriverName
    () => currentLive, // getLivePosition
    undefined, // getOvertakeGate
  );
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPositionReadoutCooldown();
  vi.clearAllMocks();
});

describe("raceStatusCadenceHits", () => {
  it("fires on a positive multiple of 3, stays silent otherwise", () => {
    expect(raceStatusCadenceHits({ lapsSincePositionChange: 3 } as LapSnap)).toBe(true);
    expect(raceStatusCadenceHits({ lapsSincePositionChange: 6 } as LapSnap)).toBe(true);
    expect(raceStatusCadenceHits({ lapsSincePositionChange: 2 } as LapSnap)).toBe(false);
    expect(raceStatusCadenceHits({ lapsSincePositionChange: 0 } as LapSnap)).toBe(false);
    expect(raceStatusCadenceHits({} as LapSnap)).toBe(false);
  });
});

describe("race-status still-leading wording (#599)", () => {
  it("single-class leader speaks 'still leading the race'", () => {
    currentLive = { position: 1, classPosition: 1, isMultiClass: false };
    fireStatus();

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/race-status/still-leading-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/race-status/still-leading-class-01.mp3`);
  });

  it("multi-class CLASS leader speaks 'still leading our class'", () => {
    // Class P1 while overall P8 — leading the class, not the race.
    currentLive = { position: 8, classPosition: 1, isMultiClass: true };
    fireStatus();

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/race-status/still-leading-class-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/race-status/still-leading-01.mp3`);
  });

  it("multi-class non-leader speaks the intro + class number, not a leading line", () => {
    currentLive = { position: 8, classPosition: 3, isMultiClass: true };
    fireStatus();

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-number/3.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/race-status/still-leading-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/race-status/still-leading-class-01.mp3`);
  });
});
