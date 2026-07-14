/**
 * Session-start readout scenario tests (issues #542, #668).
 *
 * Drives the scenario through the real scenario engine — same harness shape
 * as `race-start.test.ts` — so load-time validation, var resolution, and the
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
import { SESSION_START_DELAY_MS } from "./session-start.js";
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

// The speed-number clips this fixture stages. Includes 100 — a value outside
// the historical hardcoded findings set — because speakability now derives
// from the clips that exist, not a code constant (issue #836).
const SPEED_CLIP_VALUES = [45, 60, 79, 80, 81, 100];

// A voice with no speed-number clips, no setup-warning clips, and only the
// "driver" greeting — exercises the optional-clause skips (issue #835).
const BARE_VOICE = "bare";
// A voice with no wetness-state clips — a required clip is missing, so the
// whole brief must abort (issue #835). (Temp clips are also absent, but the
// temp clauses are optional since #836 and would merely skip.)
const PARTIAL_VOICE = "partial";

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...GREETING_NAMES.map((n) => `voice/${VOICE}/session-start-greeting/${n}.mp3`),
    ...SESSION_START_CLIPS.map((c) => `voice/${VOICE}/session-start/${c}.mp3`),
    ...SPEED_CLIP_VALUES.map((n) => `voice/${VOICE}/session-start-speed-numbers/${n}.mp3`),
    ...Array.from({ length: 151 }, (_, i) => `voice/${VOICE}/session-start-temp-numbers/${i}.mp3`),
    `voice/${VOICE}/setup-warning/qualifying-01.mp3`,
    `voice/${VOICE}/setup-warning/race-01.mp3`,
    `voice/${BARE_VOICE}/session-start-greeting/driver.mp3`,
    ...SESSION_START_CLIPS.map((c) => `voice/${BARE_VOICE}/session-start/${c}.mp3`),
    ...Array.from({ length: 151 }, (_, i) => `voice/${BARE_VOICE}/session-start-temp-numbers/${i}.mp3`),
    ...GREETING_NAMES.map((n) => `voice/${PARTIAL_VOICE}/session-start-greeting/${n}.mp3`),
    ...SESSION_START_CLIPS.filter((c) => !/^wetness-./.test(c)).map(
      (c) => `voice/${PARTIAL_VOICE}/session-start/${c}.mp3`,
    ),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

// Default to a qualifying snapshot — race sessions are spoken exclusively by
// the race-start scenario, so session-start's `where:` skips
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
let setupWarningMismatch: (kind: "qualifying" | "race") => boolean;

function fire(snapshot: SessionStartSnapshot | null): void {
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

let activeVoice: string;

beforeEach(() => {
  vi.useFakeTimers();
  currentSnapshot = null;
  sessionStartEnabled = true;
  setupWarningMismatch = () => false;
  activeVoice = VOICE;
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => activeVoice);
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
    undefined, // getLapTimeCalloutEnabled
    undefined, // getLapCompletedSnapshot
    undefined, // getPositionCalloutEnabled
    undefined, // getQualifyingInvalidationCalloutEnabled
    undefined, // getQualifyingInvalidationSnapshot
    undefined, // getRaceStatusCalloutEnabled
    undefined, // getRaceFinishedFired
    undefined, // getRaceEndCalloutEnabled
    undefined, // getRaceFinishedSnapshot
    undefined, // getRaceStartCalloutEnabled
    undefined, // getRaceStartSnapshot
    undefined, // getOvertakeCalloutEnabled
    undefined, // getOvertakeDriverName
    undefined, // getLivePosition
    undefined, // getOvertakeGate
    undefined, // getPitBoxCalloutEnabled
    (kind) => setupWarningMismatch(kind), // getSetupWarningMismatch (issue #625)
  );
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("value clips derive speakability from the manifest (issue #836)", () => {
  it("speaks a pit-speed value outside the historical findings set when its clip exists", () => {
    fire(snap({ pitSpeedLimit: 100, speedUnit: "kmh" }));

    expect(hasClip("/session-start/pit-speed-intro.mp3")).toBe(true);
    expect(hasClip("/session-start-speed-numbers/100.mp3")).toBe(true);
    expect(hasClip("/session-start/speed-unit-kmh.mp3")).toBe(true);
  });

  it("skips the temp clause when the temperature has no clip (no clamping), playing the rest", () => {
    fire(snap({ trackTemp: 200 }));

    expect(voicePaths().some((p) => p.includes("session-start-temp-numbers/200"))).toBe(false);
    expect(voicePaths().some((p) => p.includes("session-start-temp-numbers/150"))).toBe(false);
    expect(hasClip("/session-start/track-temp-intro.mp3")).toBe(false);
    // The air-temp clause and the rest of the brief still play.
    expect(hasClip("/session-start/air-temp-intro.mp3")).toBe(true);
    expect(hasClip("/session-start-temp-numbers/20.mp3")).toBe(true);
    expect(hasClip("/session-start/wetness-intro.mp3")).toBe(true);
  });
});

describe("per-voice clip availability (issue #835)", () => {
  it("skips the pit-speed clause for a voice with no speed-number clips, playing the rest", () => {
    activeVoice = BARE_VOICE;
    fire(snap({ driverName: "driver", pitSpeedLimit: 80 }));

    expect(hasClip("/session-start/pit-speed-intro.mp3")).toBe(false);
    expect(voicePaths().some((p) => p.includes("session-start-speed-numbers"))).toBe(false);
    expect(hasClip("/session-start/speed-unit-kmh.mp3")).toBe(false);
    // The rest of the brief still plays.
    expect(hasClip("/session-start/session-qualifying.mp3")).toBe(true);
    expect(hasClip("/session-start/track-temp-intro.mp3")).toBe(true);
  });

  it("skips the setup-warning nudge for a voice with no setup-warning clips, playing the rest", () => {
    activeVoice = BARE_VOICE;
    setupWarningMismatch = (kind) => kind === "qualifying";
    fire(snap({ driverName: "driver" }));

    expect(voicePaths().some((p) => p.includes("setup-warning"))).toBe(false);
    expect(hasClip("/session-start/session-qualifying.mp3")).toBe(true);
  });

  it("skips the greeting for a voice lacking the picked name clip, playing the rest", () => {
    activeVoice = BARE_VOICE;
    fire(snap({ driverName: "niklas" }));

    expect(voicePaths().some((p) => p.includes("session-start-greeting"))).toBe(false);
    expect(hasClip("/session-start/session-qualifying.mp3")).toBe(true);
  });

  it("skips the WHOLE brief for a voice missing a required clip (wetness state) — never a fragment", () => {
    activeVoice = PARTIAL_VOICE;
    fire(snap());

    expect(audio._played).toEqual([]);
  });
});

describe("session-start scenario", () => {
  it("plays the full readout on session.changed", () => {
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
    bus.publishEvent("session.changed", { from: 0, to: 1 });

    // Nothing plays during the delay window.
    vi.advanceTimersByTime(SESSION_START_DELAY_MS - 100);
    expect(voicePaths()).toEqual([]);

    // Once the delay elapses the readout begins.
    flush(audio);
    expect(hasClip("/session-start-greeting/niklas.mp3")).toBe(true);
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
    vi.advanceTimersByTime(SESSION_START_DELAY_MS - 1000);
    currentSnapshot = snap();

    // Complete the delay — where: should re-evaluate and now pass.
    flush(audio);

    expect(hasClip("/session-start-greeting/niklas.mp3")).toBe(true);
  });

  it("does not fire when the snapshot resolver returns null", () => {
    fire(null);

    expect(voicePaths()).toEqual([]);
  });

  // Regression: trigger was moved from `driver.firstOnTrack` to
  // `session.changed` (issue #668). Publishing the old event must play nothing.
  it("does not fire on driver.firstOnTrack (old trigger)", () => {
    currentSnapshot = snap();
    bus.publishEvent("driver.firstOnTrack", {});
    flush(audio);

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

    it("skips the whole clause when the limit has no clip", () => {
      fire(snap({ pitSpeedLimit: 99 }));

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

  describe("setup-warning clause (issue #625)", () => {
    it("appends the qualifying warning when the resolver reports a mismatch", () => {
      setupWarningMismatch = (kind) => kind === "qualifying";
      fire(snap({ sessionType: "qualifying" }));

      expect(hasClip("/setup-warning/qualifying-01.mp3")).toBe(true);
      // The rest of the readout still plays — the clause is appended, not a replacement.
      expect(hasClip("/session-start/wetness-mostly-dry.mp3")).toBe(true);
    });

    it("is silent when the resolver reports no mismatch", () => {
      setupWarningMismatch = () => false;
      fire(snap({ sessionType: "qualifying" }));

      expect(hasClip("/setup-warning/qualifying-01.mp3")).toBe(false);
    });

    it("never warns in practice, even on a mismatch", () => {
      setupWarningMismatch = () => true;
      fire(snap({ sessionType: "practice" }));

      expect(hasClip("/setup-warning/qualifying-01.mp3")).toBe(false);
      // Practice readout otherwise plays in full.
      expect(hasClip("/session-start/session-practice.mp3")).toBe(true);
    });
  });
});
