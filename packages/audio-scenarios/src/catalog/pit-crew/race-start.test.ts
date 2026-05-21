/**
 * Race-start greeting + qualifying-position readout tests (issue #568).
 *
 * Drives the scenario through the real scenario engine — same harness shape
 * as `session-start.test.ts` — so load-time validation, var resolution, and
 * the conditional position clause all run the production path. The snapshot
 * is read from a resolver closure (`currentSnapshot`) at fire time.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, RaceStartSnapshot, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { TrackWetness } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew } from "./index.js";
import { isRaceSession, POSITION_MAX, positionIsSpeakable, RACE_START_DELAY_MS } from "./race-start.js";
import { _resetRadarEngine } from "./radar-engine.js";

const mockSessionType = vi.fn<() => string>(() => "Race");

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => mockSessionType(),
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
  "track-temp-intro",
  "air-temp-intro",
  "degrees-celsius",
  "degrees-fahrenheit",
  "wetness-intro",
  ...WETNESS_SUFFIXES.map((s) => `wetness-${s}`),
];

const RACE_START_CLIPS = ["starting-from-pole-01", "qualifying-put-us-to-01"];

const GREETING_NAMES = ["niklas", "driver"];

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...GREETING_NAMES.map((n) => `voice/${VOICE}/race-start-greeting/${n}.mp3`),
    ...RACE_START_CLIPS.map((c) => `voice/${VOICE}/race-start/${c}.mp3`),
    ...SESSION_START_CLIPS.map((c) => `voice/${VOICE}/session-start/${c}.mp3`),
    // The race-start scenario speaks integer temps via the session-start
    // temp-number group (issue #568 reuses the existing clips). Stage the same
    // 0..150 range as the session-start tests.
    ...Array.from({ length: 151 }, (_, i) => `voice/${VOICE}/session-start-temp-numbers/${i}.mp3`),
    // Position numbers — reused from the existing position-number group
    // (issue #566). 1..64 covers the entire speakable range.
    ...Array.from({ length: POSITION_MAX }, (_, i) => `voice/${VOICE}/position-number/${i + 1}.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

const BASE_SNAPSHOT: RaceStartSnapshot = {
  driverName: "niklas",
  trackTemp: 28,
  airTemp: 20,
  tempUnit: "celsius",
  wetness: TrackWetness.MostlyDry,
  playerCarPosition: 7,
};

function snap(overrides: Partial<RaceStartSnapshot> = {}): RaceStartSnapshot {
  return { ...BASE_SNAPSHOT, ...overrides };
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let currentSnapshot: RaceStartSnapshot | null;
let raceStartEnabled: boolean;

function fire(snapshot: RaceStartSnapshot | null): void {
  currentSnapshot = snapshot;
  bus.publishEvent("session.changed", { from: 0, to: 1 });
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
  raceStartEnabled = true;
  mockSessionType.mockReturnValue("Race");
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(
    bus,
    undefined,
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
    () => raceStartEnabled,
    () => currentSnapshot,
  );
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("isRaceSession", () => {
  it("returns true for race-typed sessions", () => {
    expect(isRaceSession("Race")).toBe(true);
    expect(isRaceSession("Warmup")).toBe(true); // warmup falls into the race bucket
  });

  it("returns false for practice / qualifying / testing", () => {
    expect(isRaceSession("Practice")).toBe(false);
    expect(isRaceSession("Lone Practice")).toBe(false);
    expect(isRaceSession("Offline Testing")).toBe(false);
    expect(isRaceSession("Open Qualify")).toBe(false);
    expect(isRaceSession("Lone Qualify")).toBe(false);
  });
});

describe("positionIsSpeakable", () => {
  it("accepts P1..POSITION_MAX", () => {
    expect(positionIsSpeakable(1)).toBe(true);
    expect(positionIsSpeakable(7)).toBe(true);
    expect(positionIsSpeakable(POSITION_MAX)).toBe(true);
  });

  it("rejects out-of-range and undefined values", () => {
    expect(positionIsSpeakable(undefined)).toBe(false);
    expect(positionIsSpeakable(0)).toBe(false);
    expect(positionIsSpeakable(-1)).toBe(false);
    expect(positionIsSpeakable(POSITION_MAX + 1)).toBe(false);
  });
});

describe("race-start scenario", () => {
  it("plays the full readout on session.changed in race sessions", () => {
    fire(snap());

    expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
    expect(hasClip("/race-start/qualifying-put-us-to-01.mp3")).toBe(true);
    expect(hasClip("/position-number/7.mp3")).toBe(true);
    expect(hasClip("/session-start/track-temp-intro.mp3")).toBe(true);
    expect(hasClip("/session-start-temp-numbers/28.mp3")).toBe(true);
    expect(hasClip("/session-start/air-temp-intro.mp3")).toBe(true);
    expect(hasClip("/session-start-temp-numbers/20.mp3")).toBe(true);
    expect(hasClip("/session-start/degrees-celsius.mp3")).toBe(true);
    expect(hasClip("/session-start/wetness-intro.mp3")).toBe(true);
    expect(hasClip("/session-start/wetness-mostly-dry.mp3")).toBe(true);
  });

  it("waits RACE_START_DELAY_MS before any audio plays", () => {
    currentSnapshot = snap();
    bus.publishEvent("session.changed", { from: 0, to: 1 });

    // Nothing plays during the delay window.
    vi.advanceTimersByTime(RACE_START_DELAY_MS - 100);
    expect(voicePaths()).toEqual([]);

    // Once the delay elapses the readout begins.
    flush(audio);
    expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
  });

  // Regression: where: is implemented as `triggerDelay` rather than a leading
  // `{ pause }` step so the where: predicate and var resolvers see telemetry
  // that has had time to settle. iRacing's `session.changed` lands on a tick
  // where `TrackWetness` can briefly read `Unknown`; a leading pause inside
  // the sequence wouldn't help because vars are resolved at expansion time
  // (synchronously when the immediate where: returns true).
  it("re-evaluates where: at the deferred fire time, not at event arrival", () => {
    // Snapshot is null at event arrival — would cause an immediate where: to
    // reject. But triggerDelay defers the check, so we can populate the
    // snapshot during the wait window.
    currentSnapshot = null;
    bus.publishEvent("session.changed", { from: 0, to: 1 });

    // Mid-wait: snapshot becomes valid (simulating telemetry settling).
    vi.advanceTimersByTime(RACE_START_DELAY_MS - 1000);
    currentSnapshot = snap();

    // Complete the delay — where: should re-evaluate and now pass.
    flush(audio);

    expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
  });

  it("does not fire when the snapshot resolver returns null", () => {
    fire(null);

    expect(voicePaths()).toEqual([]);
  });

  it("does not fire in non-race sessions", () => {
    mockSessionType.mockReturnValue("Open Qualify");
    fire(snap());

    expect(voicePaths()).toEqual([]);
  });

  it("does not fire in practice sessions", () => {
    mockSessionType.mockReturnValue("Lone Practice");
    fire(snap());

    expect(voicePaths()).toEqual([]);
  });

  it("is suppressed when the per-callout opt-in is off", () => {
    raceStartEnabled = false;
    fire(snap());

    expect(voicePaths()).toEqual([]);
  });

  describe("position clause", () => {
    it("P1 picks the pole branch (single clip — no composed number)", () => {
      fire(snap({ playerCarPosition: 1 }));

      expect(hasClip("/race-start/starting-from-pole-01.mp3")).toBe(true);
      expect(hasClip("/race-start/qualifying-put-us-to-01.mp3")).toBe(false);
      // No position number for pole.
      expect(voicePaths().some((p) => p.includes("/position-number/"))).toBe(false);
    });

    it("P2 picks the composed branch", () => {
      fire(snap({ playerCarPosition: 2 }));

      expect(hasClip("/race-start/qualifying-put-us-to-01.mp3")).toBe(true);
      expect(hasClip("/position-number/2.mp3")).toBe(true);
      expect(hasClip("/race-start/starting-from-pole-01.mp3")).toBe(false);
    });

    it("POSITION_MAX is speakable (upper boundary)", () => {
      fire(snap({ playerCarPosition: POSITION_MAX }));

      expect(hasClip("/race-start/qualifying-put-us-to-01.mp3")).toBe(true);
      expect(hasClip(`/position-number/${POSITION_MAX}.mp3`)).toBe(true);
    });

    it("skips the position clause entirely when above POSITION_MAX (greeting + conditions still play)", () => {
      fire(snap({ playerCarPosition: POSITION_MAX + 1 }));

      expect(hasClip("/race-start/qualifying-put-us-to-01.mp3")).toBe(false);
      expect(hasClip("/race-start/starting-from-pole-01.mp3")).toBe(false);
      expect(voicePaths().some((p) => p.includes("/position-number/"))).toBe(false);
      // Greeting + conditions still play.
      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
      expect(hasClip("/session-start/track-temp-intro.mp3")).toBe(true);
    });

    it("skips the position clause entirely when position is missing", () => {
      fire(snap({ playerCarPosition: undefined }));

      expect(hasClip("/race-start/qualifying-put-us-to-01.mp3")).toBe(false);
      expect(hasClip("/race-start/starting-from-pole-01.mp3")).toBe(false);
      // Greeting + conditions still play.
      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
      expect(hasClip("/session-start/wetness-intro.mp3")).toBe(true);
    });
  });

  describe("driver name resolution", () => {
    it("falls back to driver when the snapshot name is empty", () => {
      fire(snap({ driverName: "" }));

      expect(hasClip("/race-start-greeting/driver.mp3")).toBe(true);
    });
  });

  describe("conditions readout", () => {
    it.each(WETNESS_SUFFIXES)("speaks wetness-%s", (suffix) => {
      const wetnessByLabel: Record<(typeof WETNESS_SUFFIXES)[number], TrackWetness> = {
        dry: TrackWetness.Dry,
        "mostly-dry": TrackWetness.MostlyDry,
        "very-lightly-wet": TrackWetness.VeryLightlyWet,
        "lightly-wet": TrackWetness.LightlyWet,
        "moderately-wet": TrackWetness.ModeratelyWet,
        "very-wet": TrackWetness.VeryWet,
        "extremely-wet": TrackWetness.ExtremelyWet,
      };

      fire(snap({ wetness: wetnessByLabel[suffix] }));

      expect(hasClip(`/session-start/wetness-${suffix}.mp3`)).toBe(true);
    });

    it("switches to fahrenheit when tempUnit is fahrenheit", () => {
      fire(snap({ tempUnit: "fahrenheit", trackTemp: 82, airTemp: 68 }));

      expect(hasClip("/session-start/degrees-fahrenheit.mp3")).toBe(true);
      expect(hasClip("/session-start-temp-numbers/82.mp3")).toBe(true);
      expect(hasClip("/session-start-temp-numbers/68.mp3")).toBe(true);
    });

    it("clamps out-of-range temps into the clip range", () => {
      fire(snap({ trackTemp: 999, airTemp: -50 }));

      expect(hasClip("/session-start-temp-numbers/150.mp3")).toBe(true);
      expect(hasClip("/session-start-temp-numbers/0.mp3")).toBe(true);
    });
  });
});
