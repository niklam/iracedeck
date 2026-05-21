/**
 * Race Engineer overtake callouts — scenario-engine integration tests (issue
 * #574). Drives the gain / loss scenarios through the real engine + audio
 * harness so load-time validation, var resolution, and the `if:` leader
 * branch all run the production path.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew } from "./index.js";
import { overtakeGainIsAnnounceable, overtakeLossIsAnnounceable } from "./overtake.js";
import { _resetRadarEngine } from "./radar-engine.js";

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

const OVERTAKE_CLIPS = [
  `voice/${VOICE}/position-overtake/nice-pass-01.mp3`,
  `voice/${VOICE}/position-overtake/nice-pass-leader-01.mp3`,
  `voice/${VOICE}/position-overtake/come-on-01.mp3`,
  `voice/${VOICE}/position-overtake/dont-give-up-positions-01.mp3`,
  `voice/${VOICE}/position-intro-better/that-puts-us-to-01.mp3`,
  `voice/${VOICE}/session-start-greeting/niklas.mp3`,
  `voice/${VOICE}/session-start-greeting/driver.mp3`,
  ...Array.from({ length: 64 }, (_, i) => `voice/${VOICE}/position-number/${i + 1}.mp3`),
];

const manifest: AudioAssetsManifest = {
  clips: ["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3", "sfx/IRD-ambient-pit.mp3", ...OVERTAKE_CLIPS],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

type GainedSnap = SimEventOf<"overtake.completed">["data"];
type LostSnap = SimEventOf<"overtake.lost">["data"];

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let currentGainedSnapshot: GainedSnap | null;
let currentLostSnapshot: LostSnap | null;
let currentDriverName: string | null;
let overtakeEnabled: Record<"gained" | "lost", boolean>;

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function fireGained(snapshot: GainedSnap): void {
  currentGainedSnapshot = snapshot;
  bus.publishEvent("overtake.completed", snapshot);
  flush(audio);
}

function fireLost(snapshot: LostSnap): void {
  currentLostSnapshot = snapshot;
  bus.publishEvent("overtake.lost", snapshot);
  flush(audio);
}

beforeEach(() => {
  currentGainedSnapshot = null;
  currentLostSnapshot = null;
  currentDriverName = "niklas";
  overtakeEnabled = { gained: true, lost: true };
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
    undefined, // getLapCompletedSnapshot
    undefined, // getPositionCalloutEnabled
    undefined, // getQualifyingInvalidationCalloutEnabled
    undefined, // getQualifyingInvalidationSnapshot
    undefined, // getRaceStatusCalloutEnabled
    undefined, // getRaceFinishedFired
    undefined, // getRaceEndCalloutEnabled
    undefined, // getRaceFinishedSnapshot
    undefined, // getRaceStartCalloutEnabled (issue #568)
    undefined, // getRaceStartSnapshot (issue #568)
    (id) => overtakeEnabled[id],
    () => currentGainedSnapshot,
    () => currentLostSnapshot,
    () => currentDriverName,
  );
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  vi.clearAllMocks();
});

describe("overtakeGainIsAnnounceable / overtakeLossIsAnnounceable", () => {
  it("accepts an in-range overall position", () => {
    expect(
      overtakeGainIsAnnounceable({
        position: 5,
        previousPosition: 6,
        isLeader: false,
        carIdx: 0,
        sustained: 3000,
      } as GainedSnap),
    ).toBe(true);
    expect(
      overtakeLossIsAnnounceable({ position: 5, previousPosition: 4, carIdx: 0, sustained: 3000 } as LostSnap),
    ).toBe(true);
  });

  it("rejects positions outside the speakable clip range", () => {
    expect(
      overtakeGainIsAnnounceable({
        position: 100,
        previousPosition: 101,
        isLeader: false,
        carIdx: 0,
        sustained: 3000,
      } as GainedSnap),
    ).toBe(false);
    expect(
      overtakeLossIsAnnounceable({ position: 100, previousPosition: 99, carIdx: 0, sustained: 3000 } as LostSnap),
    ).toBe(false);
  });

  it("uses class position when multi-class", () => {
    expect(
      overtakeGainIsAnnounceable({
        position: 50,
        classPosition: 3,
        previousPosition: 51,
        previousClassPosition: 4,
        isMultiClass: true,
        isLeader: false,
        carIdx: 0,
        sustained: 3000,
      } as GainedSnap),
    ).toBe(true);
    expect(
      overtakeGainIsAnnounceable({
        position: 3,
        classPosition: 100,
        previousPosition: 4,
        previousClassPosition: 101,
        isMultiClass: true,
        isLeader: false,
        carIdx: 0,
        sustained: 3000,
      } as GainedSnap),
    ).toBe(false);
  });
});

describe("pit-crew.overtake-gained scenario", () => {
  it("plays the composed sequence for a regular gain", () => {
    fireGained({ position: 5, previousPosition: 6, isLeader: false, carIdx: 0, sustained: 3000 } as GainedSnap);

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-overtake/nice-pass-01.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-intro-better/that-puts-us-to-01.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-number/5.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-overtake/nice-pass-leader-01.mp3`);
  });

  it("plays the standalone leader clip when isLeader=true and skips composition", () => {
    fireGained({ position: 1, previousPosition: 2, isLeader: true, carIdx: 0, sustained: 3000 } as GainedSnap);

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-overtake/nice-pass-leader-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-overtake/nice-pass-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-intro-better/that-puts-us-to-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-number/1.mp3`);
  });

  it("respects multi-class — speaks classPosition not overall", () => {
    fireGained({
      position: 50,
      previousPosition: 51,
      classPosition: 3,
      previousClassPosition: 4,
      isMultiClass: true,
      isLeader: false,
      carIdx: 0,
      sustained: 3000,
    } as GainedSnap);

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-number/3.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-number/50.mp3`);
  });

  it("does not fire when the gained opt-in is off", () => {
    overtakeEnabled.gained = false;
    fireGained({ position: 5, previousPosition: 6, isLeader: false, carIdx: 0, sustained: 3000 } as GainedSnap);

    expect(voicePaths().some((p) => p.includes("nice-pass"))).toBe(false);
  });
});

describe("pit-crew.overtake-lost scenario", () => {
  it("plays the composed loss sequence including the driver name", () => {
    fireLost({ position: 5, previousPosition: 4, carIdx: 0, sustained: 3000 } as LostSnap);

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-overtake/come-on-01.mp3`);
    expect(played).toContain(`voice/${VOICE}/session-start-greeting/niklas.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-overtake/dont-give-up-positions-01.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-number/5.mp3`);
  });

  it("falls back to the 'driver' greeting clip when the resolver returns 'driver'", () => {
    currentDriverName = "driver";
    fireLost({ position: 5, previousPosition: 4, carIdx: 0, sustained: 3000 } as LostSnap);

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/session-start-greeting/driver.mp3`);
  });

  it("does not fire when the lost opt-in is off", () => {
    overtakeEnabled.lost = false;
    fireLost({ position: 5, previousPosition: 4, carIdx: 0, sustained: 3000 } as LostSnap);

    expect(voicePaths().some((p) => p.includes("come-on"))).toBe(false);
  });

  it("can be silenced independently of the gained opt-in", () => {
    overtakeEnabled.lost = false;
    fireLost({ position: 5, previousPosition: 4, carIdx: 0, sustained: 3000 } as LostSnap);
    expect(voicePaths()).toEqual([]);

    fireGained({ position: 4, previousPosition: 5, isLeader: false, carIdx: 0, sustained: 3000 } as GainedSnap);
    expect(voicePaths().some((p) => p.includes("nice-pass"))).toBe(true);
  });
});
