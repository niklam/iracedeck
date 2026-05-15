/**
 * Lap-time best-lap callout tests (issue #555).
 *
 * Drives the scenario through the real scenario engine — same harness shape as
 * `session-start.test.ts` — so load-time validation, var resolution, and the
 * conditional minute clause all run the production path.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew } from "./index.js";
import { type LapCompletedSnapshot, lapTimeIsSpeakable, splitLapTime } from "./lap-time.js";
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

const INTRO_NAMES = ["best-lap-yet", "first-good-lap"];
const MINUTE_NAMES = Array.from({ length: 10 }, (_, i) => String(i + 1));
const SECOND_NAMES = Array.from({ length: 60 }, (_, i) => String(i));
const DECIMAL_NAMES = Array.from({ length: 10 }, (_, i) => String(i));

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...INTRO_NAMES.map((n) => `voice/${VOICE}/lap-time-intro/${n}.mp3`),
    ...MINUTE_NAMES.map((n) => `voice/${VOICE}/lap-time-minute/${n}.mp3`),
    ...SECOND_NAMES.map((n) => `voice/${VOICE}/lap-time-second/${n}.mp3`),
    ...DECIMAL_NAMES.map((n) => `voice/${VOICE}/lap-time-decimal/${n}.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

function snap(overrides: Partial<LapCompletedSnapshot> = {}): LapCompletedSnapshot {
  return {
    lap: 5,
    lapTime: 94.8,
    isBest: true,
    isFirstValid: false,
    bestLapTime: 94.8,
    previousBestLapTime: 96.2,
    ...overrides,
  };
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let lastSnapshot: LapCompletedSnapshot | null;
let lapTimeEnabled: boolean;

function fire(data: LapCompletedSnapshot | null): void {
  lastSnapshot = data;

  if (data) {
    bus.publishEvent("lap.completed", data as unknown as Record<string, unknown>);
  }

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
  lapTimeEnabled = true;
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
    () => lapTimeEnabled,
    () => lastSnapshot,
  );
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("splitLapTime", () => {
  it("splits a 1:34.8 lap into minutes=1, seconds=34, tenths=8", () => {
    expect(splitLapTime(94.8)).toEqual({ minutes: 1, seconds: 34, tenths: 8 });
  });

  it("splits a sub-1-min lap (34.8s) into minutes=0", () => {
    expect(splitLapTime(34.8)).toEqual({ minutes: 0, seconds: 34, tenths: 8 });
  });

  it("rounds to the nearest tenth so 34.85 becomes 34.9", () => {
    expect(splitLapTime(34.85)).toEqual({ minutes: 0, seconds: 34, tenths: 9 });
  });

  it("carries over to the next second on round-up (34.95 → 35.0)", () => {
    expect(splitLapTime(34.95)).toEqual({ minutes: 0, seconds: 35, tenths: 0 });
  });

  it("carries minutes on round-up at the boundary (59.95s in a sub-1-min lap → 1:00.0)", () => {
    expect(splitLapTime(59.95)).toEqual({ minutes: 1, seconds: 0, tenths: 0 });
  });

  it("returns zero for negative input", () => {
    expect(splitLapTime(-5)).toEqual({ minutes: 0, seconds: 0, tenths: 0 });
  });

  it("returns zero for NaN", () => {
    expect(splitLapTime(NaN)).toEqual({ minutes: 0, seconds: 0, tenths: 0 });
  });
});

describe("lapTimeIsSpeakable", () => {
  it("accepts laps across the full minute range", () => {
    expect(lapTimeIsSpeakable(63.5)).toBe(true); // 1:03.5
    expect(lapTimeIsSpeakable(83.4)).toBe(true); // 1:23.4 — seconds=23
    expect(lapTimeIsSpeakable(60.4)).toBe(true); // 1:00.4 — seconds=0
    expect(lapTimeIsSpeakable(605.2)).toBe(true); // 10:05.2
    expect(lapTimeIsSpeakable(8.4)).toBe(true); // 0:08.4 (sub-1-min)
    expect(lapTimeIsSpeakable(34.8)).toBe(true); // 0:34.8 (sub-1-min, seconds=34)
  });

  it("rejects laps where the minute component exceeds the max", () => {
    expect(lapTimeIsSpeakable(665.5)).toBe(false); // 11:05.5
    expect(lapTimeIsSpeakable(3600)).toBe(false); // 60:00.0
  });

  it("rejects non-finite or non-positive lap times", () => {
    expect(lapTimeIsSpeakable(0)).toBe(false);
    expect(lapTimeIsSpeakable(-1)).toBe(false);
    expect(lapTimeIsSpeakable(NaN)).toBe(false);
    expect(lapTimeIsSpeakable(Infinity)).toBe(false);
  });
});

describe("lap-time scenario", () => {
  it("plays the full readout for a 1:03.4 new personal best", () => {
    fire(snap({ lapTime: 63.4 }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
    expect(hasClip("/lap-time-minute/1.mp3")).toBe(true);
    expect(hasClip("/lap-time-second/3.mp3")).toBe(true);
    expect(hasClip("/lap-time-decimal/4.mp3")).toBe(true);
  });

  it("skips the minute clip for a sub-1-minute lap", () => {
    fire(snap({ lapTime: 8.7 }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
    expect(voicePaths().some((p) => p.includes("/lap-time-minute/"))).toBe(false);
    expect(hasClip("/lap-time-second/8.mp3")).toBe(true);
    expect(hasClip("/lap-time-decimal/7.mp3")).toBe(true);
  });

  it("uses the first-good-lap intro when there is no prior best", () => {
    fire(snap({ lapTime: 63.4, isFirstValid: true, previousBestLapTime: undefined }));

    expect(hasClip("/lap-time-intro/first-good-lap.mp3")).toBe(true);
    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(false);
  });

  it("uses the best-lap-yet intro when there is a prior best to beat", () => {
    fire(snap({ lapTime: 63.4, previousBestLapTime: 64.1 }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
    expect(hasClip("/lap-time-intro/first-good-lap.mp3")).toBe(false);
  });

  it("does not fire when isBest is false", () => {
    fire(snap({ lapTime: 63.4, isBest: false }));

    expect(voicePaths()).toEqual([]);
  });

  it("does not fire when the lap time exceeds the minute-component max", () => {
    // 11:05.5 — minutes=11 > LAP_TIME_MINUTE_MAX (10)
    fire(snap({ lapTime: 665.5 }));

    expect(voicePaths()).toEqual([]);
  });

  it("plays a full 1:23.4 readout — verifies expanded seconds coverage (0–59)", () => {
    fire(snap({ lapTime: 83.4 }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
    expect(hasClip("/lap-time-minute/1.mp3")).toBe(true);
    expect(hasClip("/lap-time-second/23.mp3")).toBe(true);
    expect(hasClip("/lap-time-decimal/4.mp3")).toBe(true);
  });

  it("plays a sub-1-min lap with seconds-component=34 (was out of scope in v1)", () => {
    fire(snap({ lapTime: 34.8 }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
    expect(voicePaths().some((p) => p.includes("/lap-time-minute/"))).toBe(false);
    expect(hasClip("/lap-time-second/34.mp3")).toBe(true);
    expect(hasClip("/lap-time-decimal/8.mp3")).toBe(true);
  });

  it("is suppressed when the per-callout opt-in is off", () => {
    lapTimeEnabled = false;
    fire(snap({ lapTime: 63.4 }));

    expect(voicePaths()).toEqual([]);
  });

  it("plays the readout immediately on lap.completed (no leading pause)", () => {
    // The 2-second leading pause was dropped when the diff moved from
    // counter-driven to LapLastLapTime-driven emission (issue #555 — the
    // refresh lag in the lap-time field already provides the post-S/F
    // breathing room the pause used to add artificially). This test pins
    // that the scenario doesn't wait before opening the radio.
    lastSnapshot = snap({ lapTime: 63.4 });
    bus.publishEvent("lap.completed", lastSnapshot as unknown as Record<string, unknown>);
    flush(audio);
    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
  });
});
