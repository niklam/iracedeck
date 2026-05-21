/**
 * Session-start ("car entry") readout scenario tests (issue #542).
 *
 * Drives the scenario through the real scenario engine — same harness shape
 * as `readback.test.ts` — so load-time validation, var resolution, and the
 * conditional pit-speed clause all run the production path. The snapshot is
 * read from a resolver closure (`currentSnapshot`) at fire time.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SessionStartSnapshot, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { TrackWetness } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew } from "./index.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { SESSION_START_DELAY_MS, SESSION_START_SPEED_VALUES } from "./session-start.js";

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

const VOICE = "luca";

const WETNESS_SUFFIXES = [
  "dry",
  "mostly-dry",
  "very-lightly-wet",
  "lightly-wet",
  "moderately-wet",
  "very-wet",
  "extremely-wet",
] as const;

const SESSION_START_CLIPS = [
  "session-practice",
  "session-qualifying",
  "session-race",
  "pit-speed-intro",
  "speed-unit-kmh",
  "speed-unit-mph",
  "track-temp-intro",
  "air-temp-intro",
  "degrees-celsius",
  "degrees-fahrenheit",
  "wetness-intro",
  ...WETNESS_SUFFIXES.map((s) => `wetness-${s}`),
];

const GREETING_NAMES = ["niklas", "driver"];

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...GREETING_NAMES.map((n) => `voice/${VOICE}/session-start-greeting/${n}.mp3`),
    ...SESSION_START_CLIPS.map((c) => `voice/${VOICE}/session-start/${c}.mp3`),
    ...[...SESSION_START_SPEED_VALUES].map((n) => `voice/${VOICE}/session-start-speed-numbers/${n}.mp3`),
    ...Array.from({ length: 151 }, (_, i) => `voice/${VOICE}/session-start-temp-numbers/${i}.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

// Default to a qualifying snapshot — issue #568 moved race entries to the
// dedicated race-start scenario, so session-start's `where:` skips
// `sessionType === "race"` and a race-typed default snapshot would never fire.
const BASE_SNAPSHOT: SessionStartSnapshot = {
  driverName: "niklas",
  sessionType: "qualifying",
  pitSpeedLimit: 80,
  speedUnit: "kmh",
  trackTemp: 28,
  airTemp: 20,
  tempUnit: "celsius",
  wetness: TrackWetness.MostlyDry,
};

function snap(overrides: Partial<SessionStartSnapshot> = {}): SessionStartSnapshot {
  return { ...BASE_SNAPSHOT, ...overrides };
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let currentSnapshot: SessionStartSnapshot | null;
let sessionStartEnabled: boolean;

function fire(snapshot: SessionStartSnapshot | null): void {
  currentSnapshot = snapshot;
  bus.publishEvent("driver.firstOnTrack", {});
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
  currentSnapshot = null;
  sessionStartEnabled = true;
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(
    bus,
    undefined,
    mockLogger as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => sessionStartEnabled,
    () => currentSnapshot,
  );
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("SESSION_START_SPEED_VALUES", () => {
  it("expands every finding by ±1 for telemetry drift", () => {
    // 80 km/h is a finding — 79/80/81 must all be speakable.
    expect(SESSION_START_SPEED_VALUES.has(79)).toBe(true);
    expect(SESSION_START_SPEED_VALUES.has(80)).toBe(true);
    expect(SESSION_START_SPEED_VALUES.has(81)).toBe(true);
  });

  it("excludes values that aren't a known limit or its neighbour", () => {
    expect(SESSION_START_SPEED_VALUES.has(100)).toBe(false);
    expect(SESSION_START_SPEED_VALUES.has(0)).toBe(false);
  });
});

describe("session-start scenario", () => {
  it("plays the full readout on driver.firstOnTrack", () => {
    fire(snap());

    expect(hasClip("/session-start-greeting/niklas.mp3")).toBe(true);
    expect(hasClip("/session-start/session-qualifying.mp3")).toBe(true);
    expect(hasClip("/session-start/pit-speed-intro.mp3")).toBe(true);
    expect(hasClip("/session-start-speed-numbers/80.mp3")).toBe(true);
    expect(hasClip("/session-start/speed-unit-kmh.mp3")).toBe(true);
    expect(hasClip("/session-start/track-temp-intro.mp3")).toBe(true);
    expect(hasClip("/session-start-temp-numbers/28.mp3")).toBe(true);
    expect(hasClip("/session-start/air-temp-intro.mp3")).toBe(true);
    expect(hasClip("/session-start-temp-numbers/20.mp3")).toBe(true);
    expect(hasClip("/session-start/degrees-celsius.mp3")).toBe(true);
    expect(hasClip("/session-start/wetness-intro.mp3")).toBe(true);
    expect(hasClip("/session-start/wetness-mostly-dry.mp3")).toBe(true);
  });

  it("waits SESSION_START_DELAY_MS before any audio plays", () => {
    currentSnapshot = snap();
    bus.publishEvent("driver.firstOnTrack", {});

    // Nothing plays during the delay window.
    vi.advanceTimersByTime(SESSION_START_DELAY_MS - 100);
    expect(voicePaths()).toEqual([]);

    // Once the delay elapses the readout begins.
    flush(audio);
    expect(hasClip("/session-start-greeting/niklas.mp3")).toBe(true);
  });

  it("does not fire when the snapshot resolver returns null", () => {
    fire(null);

    expect(voicePaths()).toEqual([]);
  });

  it("is suppressed when the per-callout opt-in is off", () => {
    sessionStartEnabled = false;
    fire(snap());

    expect(voicePaths()).toEqual([]);
  });

  describe("session line", () => {
    it.each([
      ["practice", "session-practice"],
      ["qualifying", "session-qualifying"],
    ] as const)("%s → %s", (sessionType, clip) => {
      fire(snap({ sessionType }));

      expect(hasClip(`/session-start/${clip}.mp3`)).toBe(true);
    });

    // Issue #568: race entries are spoken exclusively by the race-start
    // scenario, so session-start's `where:` skips `sessionType === "race"` to
    // prevent the double-greeting.
    it("race sessions are skipped entirely (handled by race-start scenario)", () => {
      fire(snap({ sessionType: "race" }));

      expect(voicePaths()).toEqual([]);
    });
  });

  describe("pit-speed clause", () => {
    it("speaks intro + number + unit when the limit is a known value", () => {
      fire(snap({ pitSpeedLimit: 60, speedUnit: "kmh" }));

      expect(hasClip("/session-start/pit-speed-intro.mp3")).toBe(true);
      expect(hasClip("/session-start-speed-numbers/60.mp3")).toBe(true);
      expect(hasClip("/session-start/speed-unit-kmh.mp3")).toBe(true);
    });

    it("skips the whole clause when the limit is not a known value", () => {
      fire(snap({ pitSpeedLimit: 100 }));

      // The rest of the readout still plays — only the pit-speed clause drops.
      expect(hasClip("/session-start/pit-speed-intro.mp3")).toBe(false);
      expect(hasClip("/session-start/speed-unit-kmh.mp3")).toBe(false);
      expect(hasClip("/session-start/track-temp-intro.mp3")).toBe(true);
    });
  });

  describe("units", () => {
    it("uses imperial unit clips when the snapshot says so", () => {
      fire(snap({ pitSpeedLimit: 45, speedUnit: "mph", tempUnit: "fahrenheit", trackTemp: 82, airTemp: 68 }));

      expect(hasClip("/session-start/speed-unit-mph.mp3")).toBe(true);
      expect(hasClip("/session-start/degrees-fahrenheit.mp3")).toBe(true);
      expect(hasClip("/session-start-temp-numbers/82.mp3")).toBe(true);
      expect(hasClip("/session-start/speed-unit-kmh.mp3")).toBe(false);
      expect(hasClip("/session-start/degrees-celsius.mp3")).toBe(false);
    });
  });

  describe("wetness state", () => {
    it.each([
      [TrackWetness.Dry, "dry"],
      [TrackWetness.LightlyWet, "lightly-wet"],
      [TrackWetness.ExtremelyWet, "extremely-wet"],
    ] as const)("%s → wetness-%s", (wetness, suffix) => {
      fire(snap({ wetness }));

      expect(hasClip(`/session-start/wetness-${suffix}.mp3`)).toBe(true);
    });
  });
});
