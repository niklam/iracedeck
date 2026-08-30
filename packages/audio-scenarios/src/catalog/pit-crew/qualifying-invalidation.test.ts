/**
 * Qualifying lap-invalidation callout tests (issue #567).
 *
 * Drives the scenario through the real scenario engine so load-time validation
 * of every pool reference, the nested conditional branches, and the per-lap
 * latch all run the production path.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import {
  checkAndUpdateQualifyingLatch,
  QUALIFYING_LAP_COUNT_MAX,
  QUALIFYING_LAP_COUNT_MIN,
  type QualifyingInvalidationSnapshot,
  resetQualifyingInvalidationLatch,
} from "./qualifying-invalidation.js";
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

function createMockBus(): IEventBus & { publishEvent: (name: SimEventName, data: Record<string, unknown>) => void } {
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
    publishEvent(name: SimEventName, data: Record<string, unknown>) {
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

function flush(audio: FakeAudio, iterations = 60): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
    vi.advanceTimersByTime(1000);
  }
}

const VOICE = "default";

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    `voice/${VOICE}/qualifying-invalidation/invalidated-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/out-of-laps-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/plenty-of-laps-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/1-lap-left-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/2-laps-left-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/3-laps-left-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/4-laps-left-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/5-laps-left-01.mp3`,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

function snap(overrides: Partial<QualifyingInvalidationSnapshot> = {}): QualifyingInvalidationSnapshot {
  return {
    sessionType: "qualifying",
    sessionNum: 1,
    lapsRemaining: 3,
    lapLimited: true,
    // Default to a flying lap (lapCompleted=1) so most tests exercise the
    // normal callout path; out-lap suppression is opted into explicitly via
    // overrides where it matters.
    lapCompleted: 1,
    lapStartedFromPits: false,
    lapCounted: true,
    ...overrides,
  };
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let lastSnapshot: QualifyingInvalidationSnapshot | null;
let qualifyingEnabled: boolean;

function fire(data: QualifyingInvalidationSnapshot | null): void {
  lastSnapshot = data;
  bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: "off-track" });
  flush(audio);
}

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function hasClip(suffix: string): boolean {
  return voicePaths().some((p) => p.endsWith(suffix));
}

beforeEach(() => {
  vi.useFakeTimers();
  lastSnapshot = null;
  qualifyingEnabled = true;
  resetQualifyingInvalidationLatch();
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
    undefined, // getIncidentCalloutEnabled — defaults to true so incident.occurred reaches our scenario
    undefined, // getSessionStartCalloutEnabled
    undefined, // getSessionStartSnapshot
    undefined, // getLapTimeCalloutEnabled
    undefined, // getLapCompletedSnapshot
    undefined, // getPositionCalloutEnabled
    () => qualifyingEnabled,
    () => lastSnapshot,
  );
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("checkAndUpdateQualifyingLatch (unit)", () => {
  beforeEach(() => resetQualifyingInvalidationLatch());

  it("returns false when sessionType is not qualifying", () => {
    expect(checkAndUpdateQualifyingLatch(snap({ sessionType: "race" }))).toBe(false);
    expect(checkAndUpdateQualifyingLatch(snap({ sessionType: "practice" }))).toBe(false);
    expect(checkAndUpdateQualifyingLatch(snap({ sessionType: undefined }))).toBe(false);
  });

  it("returns true on the first qualifying incident and false on the second for the same lap", () => {
    expect(checkAndUpdateQualifyingLatch(snap({ lapCompleted: 2 }))).toBe(true);
    expect(checkAndUpdateQualifyingLatch(snap({ lapCompleted: 2 }))).toBe(false);
  });

  it("re-arms on a new LapCompleted within the same session", () => {
    expect(checkAndUpdateQualifyingLatch(snap({ sessionNum: 2, lapCompleted: 2 }))).toBe(true);
    expect(checkAndUpdateQualifyingLatch(snap({ sessionNum: 2, lapCompleted: 3 }))).toBe(true);
  });

  it("re-arms across a session change even if LapCompleted matches", () => {
    expect(checkAndUpdateQualifyingLatch(snap({ sessionNum: 1, lapCompleted: 5 }))).toBe(true);
    expect(checkAndUpdateQualifyingLatch(snap({ sessionNum: 2, lapCompleted: 5 }))).toBe(true);
  });

  it("returns false when lapStartedFromPits and does not arm the latch", () => {
    expect(checkAndUpdateQualifyingLatch(snap({ lapCompleted: 4, lapStartedFromPits: true }))).toBe(false);
    // Same lap with the flag cleared (driver finished the post-pit lap and
    // started a fresh flying lap with the same LapCompleted value) still
    // fires. Confirms the pit-exit path doesn't pollute the latch — the
    // same lap with the flag flipped to false counts as a fresh fire.
    expect(checkAndUpdateQualifyingLatch(snap({ lapCompleted: 4, lapStartedFromPits: false }))).toBe(true);
  });

  it("returns false on a lap beyond the counted attempts and does not arm the latch", () => {
    expect(checkAndUpdateQualifyingLatch(snap({ lapCompleted: 3, lapCounted: false }))).toBe(false);
    // The suppression path must not pollute the latch — the same composite
    // key with the flag flipped counts as a fresh fire (mirrors the
    // pit-exit-lap invariant above).
    expect(checkAndUpdateQualifyingLatch(snap({ lapCompleted: 3, lapCounted: true }))).toBe(true);
  });
});

describe("qualifying-invalidation scenario — tail branches", () => {
  it("always plays the core invalidated line", () => {
    fire(snap({ lapsRemaining: 3 }));

    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
  });

  it("plays out-of-laps when lapsRemaining is 0", () => {
    fire(snap({ lapsRemaining: 0 }));

    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
    expect(hasClip("/qualifying-invalidation/out-of-laps-01.mp3")).toBe(true);
    expect(voicePaths().some((p) => p.match(/\/qualifying-invalidation\/\d-laps?-left/))).toBe(false);
    expect(hasClip("/qualifying-invalidation/plenty-of-laps-01.mp3")).toBe(false);
  });

  it("plays the per-N clip for lapsRemaining 1..5", () => {
    const expectedNames: Record<number, string> = {
      1: "1-lap-left-01",
      2: "2-laps-left-01",
      3: "3-laps-left-01",
      4: "4-laps-left-01",
      5: "5-laps-left-01",
    };

    for (const n of [1, 2, 3, 4, 5] as const) {
      resetQualifyingInvalidationLatch();
      audio._played.length = 0;
      fire(snap({ lapsRemaining: n }));

      expect(hasClip(`/qualifying-invalidation/${expectedNames[n]}.mp3`)).toBe(true);
      expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
      // No other tail clip should play
      expect(hasClip("/qualifying-invalidation/out-of-laps-01.mp3")).toBe(false);
      expect(hasClip("/qualifying-invalidation/plenty-of-laps-01.mp3")).toBe(false);
    }
  });

  it("falls back to plenty-of-laps when lapsRemaining exceeds the counted max", () => {
    fire(snap({ lapsRemaining: QUALIFYING_LAP_COUNT_MAX + 1 }));

    expect(hasClip("/qualifying-invalidation/plenty-of-laps-01.mp3")).toBe(true);
    expect(voicePaths().some((p) => p.match(/\/qualifying-invalidation\/\d-laps?-left/))).toBe(false);
  });

  it("speaks only the core line in time-limited qualifying", () => {
    fire(snap({ lapLimited: false, lapsRemaining: undefined }));

    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
    expect(hasClip("/qualifying-invalidation/out-of-laps-01.mp3")).toBe(false);
    expect(hasClip("/qualifying-invalidation/plenty-of-laps-01.mp3")).toBe(false);
    expect(voicePaths().some((p) => p.match(/\/qualifying-invalidation\/\d-laps?-left/))).toBe(false);
  });

  it("speaks only the core line when lapsRemaining is missing", () => {
    fire(snap({ lapLimited: true, lapsRemaining: undefined }));

    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
    expect(voicePaths().some((p) => p.match(/\/qualifying-invalidation\/\d-laps?-left/))).toBe(false);
  });
});

describe("qualifying-invalidation scenario — pit-exit lap suppression", () => {
  it("stays silent on a lap started from pits (covers both the session out-lap and mid-session post-pit-exit laps)", () => {
    fire(snap({ lapCompleted: 3, lapsRemaining: 2, lapStartedFromPits: true }));

    expect(voicePaths()).toEqual([]);
  });

  it("fires normally on the next flying lap after a pit-out lap", () => {
    // The plugin clears the flag at the next lap.started event. The scenario
    // then sees a fresh lap with the flag cleared and the latch unarmed.
    fire(snap({ lapCompleted: 3, lapStartedFromPits: true })); // suppressed
    expect(voicePaths()).toEqual([]);

    fire(snap({ lapCompleted: 4, lapStartedFromPits: false, lapsRemaining: 1 }));
    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
    expect(hasClip("/qualifying-invalidation/1-lap-left-01.mp3")).toBe(true);
  });
});

describe("qualifying-invalidation scenario — beyond-counted-laps suppression (issue #776)", () => {
  it("stays fully silent on an extra lap after the counted attempts are done", () => {
    // Lap 3 of a 2-lap qualifying: the raw SessionLapsRemainEx hit 0, so the
    // translator reports lapsRemaining 0 AND lapCounted false. The lap was
    // never a timed attempt — nothing is invalidated, nothing is spoken.
    fire(snap({ lapCompleted: 3, lapsRemaining: 0, lapCounted: false }));

    expect(voicePaths()).toEqual([]);
  });

  it("keeps the out-of-laps tail on the final counted lap", () => {
    // Lap 2 of 2 (raw SessionLapsRemainEx = 1): still a counted attempt, and
    // after this invalidated lap nothing remains — the out-of-laps tail is
    // exactly right here and must survive the #776 suppression.
    fire(snap({ lapCompleted: 2, lapsRemaining: 0, lapCounted: true }));

    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
    expect(hasClip("/qualifying-invalidation/out-of-laps-01.mp3")).toBe(true);
  });

  it("suppresses every extra lap, not just the first", () => {
    // The user's exact report: out-of-laps speaks once on the final counted
    // lap, then the driver keeps circulating — each extra lap re-arms the
    // per-lap latch, so without the lapCounted gate every extra lap's first
    // incident would replay the callout.
    fire(snap({ lapCompleted: 2, lapsRemaining: 0, lapCounted: true }));
    expect(hasClip("/qualifying-invalidation/out-of-laps-01.mp3")).toBe(true);
    audio._played.length = 0;

    fire(snap({ lapCompleted: 3, lapsRemaining: 0, lapCounted: false }));
    fire(snap({ lapCompleted: 4, lapsRemaining: 0, lapCounted: false }));

    expect(voicePaths()).toEqual([]);
  });
});

describe("qualifying-invalidation scenario — session gating", () => {
  it.each(["practice", "race", undefined] as const)("stays silent when sessionType is %s", (sessionType) => {
    fire(snap({ sessionType, lapsRemaining: 3 }));

    expect(voicePaths()).toEqual([]);
  });

  it("stays silent when the snapshot resolver returns null", () => {
    fire(null);

    expect(voicePaths()).toEqual([]);
  });
});

describe("qualifying-invalidation scenario — per-lap latch", () => {
  it("collapses two incidents on the same lap into one callout", () => {
    fire(snap({ lapCompleted: 4, lapsRemaining: 2 }));
    const firstFireCount = voicePaths().length;

    fire(snap({ lapCompleted: 4, lapsRemaining: 2 }));

    expect(voicePaths().length).toBe(firstFireCount);
  });

  it("re-fires on a new LapCompleted within the same session", () => {
    fire(snap({ lapCompleted: 4, lapsRemaining: 2 }));
    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
    audio._played.length = 0;

    fire(snap({ lapCompleted: 5, lapsRemaining: 1 }));
    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
  });

  it("re-fires on a session change even if LapCompleted is identical", () => {
    fire(snap({ sessionNum: 1, lapCompleted: 2, lapsRemaining: 2 }));
    audio._played.length = 0;

    fire(snap({ sessionNum: 2, lapCompleted: 2, lapsRemaining: 2 }));
    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
  });
});

describe("qualifying-invalidation scenario — opt-in gate", () => {
  it("stays silent when the per-callout opt-in is false", () => {
    qualifyingEnabled = false;

    fire(snap({ lapsRemaining: 3 }));

    expect(voicePaths()).toEqual([]);
  });
});

describe("constants", () => {
  it("exposes the counted-clip range as 1..5", () => {
    expect(QUALIFYING_LAP_COUNT_MIN).toBe(1);
    expect(QUALIFYING_LAP_COUNT_MAX).toBe(5);
  });
});
