/**
 * Position-change callout tests (issue #566).
 *
 * Drives the scenario through the real scenario engine — same harness shape
 * as `lap-time.test.ts` — so load-time validation, var resolution, and the
 * `where:` predicate all run the production path.
 *
 * Coverage:
 *   - Position improved → "better" intro + correct number clip
 *   - Position worsened → "worse" intro + correct number clip
 *   - No previous position (first valid lap) → "better" intro (treated as fix)
 *   - Position unchanged → silent
 *   - Out-of-range position (> POSITION_NUMBER_MAX) → silent
 *   - Multi-class session uses classPosition; single-class uses overall position
 *   - Session-type gating: qualifying only fires; race / practice / test stay silent
 *   - Per-callout opt-in suppresses fires when off
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew } from "./index.js";
import {
  POSITION_NUMBER_MAX,
  POSITION_NUMBER_MIN,
  positionChangeIsAnnounceable,
  positionNumberIsSpeakable,
  selectEffectivePosition,
} from "./position.js";
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

const NUMBER_NAMES = Array.from({ length: POSITION_NUMBER_MAX }, (_, i) => String(i + 1));

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    `voice/${VOICE}/position-intro-better/that-puts-us-to-01.mp3`,
    `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
    `voice/${VOICE}/position-intro-pole/that-puts-us-on-pole-01.mp3`,
    ...NUMBER_NAMES.map((n) => `voice/${VOICE}/position-number/${n}.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

type LapPayload = SimEventOf<"lap.completed">["data"];

function snap(overrides: Partial<LapPayload> = {}): LapPayload {
  return {
    lap: 5,
    lapTime: 94.8,
    isBest: false,
    isFirstValid: false,
    // Default to qualifying: position callouts only fire in qualifying.
    // Tests that want to verify the silent-in-X behavior override.
    sessionType: "qualifying",
    ...overrides,
  };
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let lastSnapshot: LapPayload | null;
let positionEnabled: boolean;

function fire(data: LapPayload | null): void {
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
  positionEnabled = true;
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
    () => false, // disable lap-time so it doesn't compete on the same event
    () => lastSnapshot,
    () => positionEnabled,
  );
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("selectEffectivePosition", () => {
  it("returns overall position in single-class sessions", () => {
    expect(selectEffectivePosition(snap({ position: 5, classPosition: 5, isMultiClass: false }))).toEqual({
      current: 5,
      previous: undefined,
    });
  });

  it("returns class position in multi-class sessions", () => {
    expect(
      selectEffectivePosition(snap({ position: 12, classPosition: 3, previousClassPosition: 5, isMultiClass: true })),
    ).toEqual({ current: 3, previous: 5 });
  });

  it("returns null when the active position is unavailable", () => {
    expect(selectEffectivePosition(snap({ position: undefined }))).toBeNull();
    expect(selectEffectivePosition(snap({ isMultiClass: true, classPosition: undefined }))).toBeNull();
  });
});

describe("positionNumberIsSpeakable", () => {
  it("accepts integers across the supported range", () => {
    expect(positionNumberIsSpeakable(POSITION_NUMBER_MIN)).toBe(true);
    expect(positionNumberIsSpeakable(POSITION_NUMBER_MAX)).toBe(true);
    expect(positionNumberIsSpeakable(33)).toBe(true);
  });

  it("rejects out-of-range positions", () => {
    expect(positionNumberIsSpeakable(0)).toBe(false);
    expect(positionNumberIsSpeakable(POSITION_NUMBER_MAX + 1)).toBe(false);
  });

  it("rejects non-integers", () => {
    expect(positionNumberIsSpeakable(1.5)).toBe(false);
    expect(positionNumberIsSpeakable(NaN)).toBe(false);
  });
});

describe("positionChangeIsAnnounceable", () => {
  it("returns true for an improvement", () => {
    expect(positionChangeIsAnnounceable(snap({ position: 3, previousPosition: 5 }))).toBe(true);
  });

  it("returns true for a worsening", () => {
    expect(positionChangeIsAnnounceable(snap({ position: 5, previousPosition: 3 }))).toBe(true);
  });

  it("returns true on the first fix (no previousPosition)", () => {
    expect(positionChangeIsAnnounceable(snap({ position: 4 }))).toBe(true);
  });

  it("returns true when position is unchanged on a non-PB lap (status update)", () => {
    expect(positionChangeIsAnnounceable(snap({ position: 5, previousPosition: 5, isBest: false }))).toBe(true);
  });

  it("returns false when position is unchanged on a PB lap (lap-time-best already speaks)", () => {
    expect(positionChangeIsAnnounceable(snap({ position: 5, previousPosition: 5, isBest: true }))).toBe(false);
  });

  it("returns false when position is out of range", () => {
    expect(positionChangeIsAnnounceable(snap({ position: POSITION_NUMBER_MAX + 1, previousPosition: 99 }))).toBe(false);
  });
});

describe("position-change scenario", () => {
  it("plays the better intro and number for an improvement", () => {
    fire(snap({ position: 3, previousPosition: 5 }));

    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(true);
    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(false);
    expect(hasClip("/position-number/3.mp3")).toBe(true);
  });

  it("plays the worse intro and number for a worsening", () => {
    fire(snap({ position: 5, previousPosition: 3 }));

    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(false);
    expect(hasClip("/position-number/5.mp3")).toBe(true);
  });

  it("uses the better intro for a first-fix (no previousPosition)", () => {
    // Position 4 chosen so we don't trigger the qualifying pole branch (P1).
    fire(snap({ position: 4, isFirstValid: true }));

    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(true);
    expect(hasClip("/position-number/4.mp3")).toBe(true);
  });

  it("speaks the status update when position is unchanged on a non-PB lap", () => {
    fire(snap({ position: 5, previousPosition: 5, isBest: false }));

    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
    expect(hasClip("/position-number/5.mp3")).toBe(true);
  });

  it("stays silent when position is unchanged on a PB lap (lap-time-best owns the lap)", () => {
    fire(snap({ position: 5, previousPosition: 5, isBest: true }));

    expect(voicePaths()).toEqual([]);
  });

  it("stays silent when position is out of range", () => {
    fire(snap({ position: POSITION_NUMBER_MAX + 1, previousPosition: 99 }));

    expect(voicePaths()).toEqual([]);
  });

  it("uses class position in multi-class sessions", () => {
    fire(snap({ position: 12, previousPosition: 14, classPosition: 2, previousClassPosition: 4, isMultiClass: true }));

    // Class position improved (4 → 2), even though overall also improved.
    // The number clip must be the class position, not the overall.
    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(true);
    expect(hasClip("/position-number/2.mp3")).toBe(true);
    expect(hasClip("/position-number/12.mp3")).toBe(false);
  });

  it("uses overall position in single-class sessions", () => {
    fire(snap({ position: 4, previousPosition: 6, classPosition: 4, previousClassPosition: 6, isMultiClass: false }));

    expect(hasClip("/position-number/4.mp3")).toBe(true);
  });

  it("stays silent in race sessions (qualifying-only family)", () => {
    fire(snap({ position: 3, previousPosition: 5, sessionType: "race" }));

    expect(voicePaths()).toEqual([]);
  });

  it("stays silent in practice sessions", () => {
    fire(snap({ position: 3, previousPosition: 5, sessionType: "practice" }));

    expect(voicePaths()).toEqual([]);
  });

  it("stays silent when sessionType is unresolved", () => {
    fire(snap({ position: 3, previousPosition: 5, sessionType: undefined }));

    expect(voicePaths()).toEqual([]);
  });

  it("fires in qualifying sessions", () => {
    fire(snap({ position: 3, previousPosition: 5, sessionType: "qualifying" }));

    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(true);
  });

  it("is suppressed when the per-callout opt-in is off", () => {
    positionEnabled = false;
    fire(snap({ position: 3, previousPosition: 5 }));

    expect(voicePaths()).toEqual([]);
  });
});

describe("position-change scenario — qualifying pole", () => {
  it("plays the pole clip (no number) when improving to P1 in qualifying", () => {
    fire(snap({ position: 1, previousPosition: 3, sessionType: "qualifying" }));

    expect(hasClip("/position-intro-pole/that-puts-us-on-pole-01.mp3")).toBe(true);
    // Pole is self-contained — neither the standard intro nor the number plays.
    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(false);
    expect(hasClip("/position-number/1.mp3")).toBe(false);
  });

  it("plays the pole clip when first valid lap lands at P1 in qualifying", () => {
    fire(snap({ position: 1, isFirstValid: true, sessionType: "qualifying" }));

    expect(hasClip("/position-intro-pole/that-puts-us-on-pole-01.mp3")).toBe(true);
    expect(hasClip("/position-number/1.mp3")).toBe(false);
  });

  it("plays the standard status line when holding P1 on a slow lap (does not repeat pole)", () => {
    fire(snap({ position: 1, previousPosition: 1, isBest: false, sessionType: "qualifying" }));

    expect(hasClip("/position-intro-pole/that-puts-us-on-pole-01.mp3")).toBe(false);
    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
    expect(hasClip("/position-number/1.mp3")).toBe(true);
  });

  it("stays silent for P1 improvements in race sessions (whole family is qualifying-only)", () => {
    fire(snap({ position: 1, previousPosition: 3, sessionType: "race" }));

    expect(voicePaths()).toEqual([]);
  });

  it("uses pole on class-P1 improvement in multi-class qualifying", () => {
    fire(
      snap({
        position: 12,
        previousPosition: 14,
        classPosition: 1,
        previousClassPosition: 3,
        isMultiClass: true,
        sessionType: "qualifying",
      }),
    );

    expect(hasClip("/position-intro-pole/that-puts-us-on-pole-01.mp3")).toBe(true);
    expect(hasClip("/position-number/1.mp3")).toBe(false);
    expect(hasClip("/position-number/12.mp3")).toBe(false);
  });
});
