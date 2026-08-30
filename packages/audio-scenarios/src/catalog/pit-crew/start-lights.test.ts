/**
 * Start-light scenario catalog tests (issues #480 / #673).
 *
 * Mirrors `flag-alerts.test.ts`: a fake bus + fake audio service, the
 * start-light pools registered from `pools.ts`, and the radio-frame include
 * scenarios. Covers:
 *   - each gantry line + countdown number fires its clip
 *   - start-ready / start-go are CRITICAL + interrupt
 *   - family preemption (start-ready → start-go: last clip is go)
 *   - the countdown event filters by `seconds` (30 fires only the 30 clip)
 *   - opt-in gating via the `registerPitCrew` closure: `countdown` off
 *     suppresses all four numbers; `lights` off suppresses ready/go.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew, type StartLightCalloutId } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { POOL_REGISTRY } from "./pools.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { RADIO_CLOSE, RADIO_OPEN } from "./radio-frame.js";
import { _resetSpotterEngine } from "./spotter-engine.js";
import { START_LIGHT_ALERTS, START_LIGHT_POOL_NAMES, START_LIGHT_SCENARIO_IDS } from "./start-lights.js";

const mockSessionType = vi.fn(() => "Race");

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => mockSessionType(),
  getLatestTelemetry: () => null,
  TrackDirection: { Neutral: "neutral", Left: "left", Right: "right" },
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

// Default telemetry attached to published events: driver live in the car. The
// gantry scenarios gate on `isLiveOnTrack` (issue #480 follow-up), so their
// events need in-car telemetry to fire; the countdown scenarios deliberately
// do NOT (issue #829 — the countdown is the "get in the car" reminder). The
// out-of-car tests pass overrides.
const IN_CAR = { IsOnTrack: true, IsReplayPlaying: false };

function createMockBus(): IEventBus & {
  publishEvent: <T extends SimEventName>(name: T, data: SimEventMap[T]["data"], telemetry?: unknown) => void;
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
    publishEvent<T extends SimEventName>(name: T, data: SimEventMap[T]["data"], telemetry: unknown = IN_CAR) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry,
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

const VOICE_KEYS = ["luca", "titan"] as const;

const START_LIGHT_CLIP_NAMES = [
  "start-ready-01",
  "start-go-01",
  "countdown-90-01",
  "countdown-60-01",
  "countdown-30-01",
  "countdown-10-01",
] as const;

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...VOICE_KEYS.flatMap((v) => START_LIGHT_CLIP_NAMES.map((name) => `voice/${v}/start-lights/${name}.mp3`)),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

function flush(audio: FakeAudio, iterations = 30): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;
let activeVoice: string;

beforeEach(() => {
  activeVoice = "luca";
  mockSessionType.mockReturnValue("Race");
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => activeVoice);

  for (const name of START_LIGHT_POOL_NAMES) {
    const { group, base } = POOL_REGISTRY[name];
    engine.definePoolFromManifest(name, group, base);
  }

  engine.defineScenario(RADIO_OPEN);
  engine.defineScenario(RADIO_CLOSE);

  for (const s of START_LIGHT_ALERTS) engine.defineScenario(s);
});

afterEach(() => {
  _resetAudioScenarios();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function voiceClipsPlayed(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function sfxClipsPlayed(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.SFX).map((p) => p.path);
}

function findScenario(id: string): (typeof START_LIGHT_ALERTS)[number] {
  const s = START_LIGHT_ALERTS.find((x) => x.id === id);

  if (!s) throw new Error(`No start-light scenario with id "${id}"`);

  return s;
}

describe("START_LIGHT_ALERTS structure", () => {
  it("defines 6 scenarios", () => {
    expect(START_LIGHT_ALERTS).toHaveLength(6);
  });

  it("exposes a stable list of ids", () => {
    expect(START_LIGHT_SCENARIO_IDS).toEqual([
      "pit-crew.start-light-ready",
      "pit-crew.start-light-go",
      "pit-crew.start-light-countdown-90",
      "pit-crew.start-light-countdown-60",
      "pit-crew.start-light-countdown-30",
      "pit-crew.start-light-countdown-10",
    ]);
  });

  it("ids are unique", () => {
    expect(new Set(START_LIGHT_SCENARIO_IDS).size).toBe(START_LIGHT_SCENARIO_IDS.length);
  });

  it("all scenarios share family 'start-light'", () => {
    for (const s of START_LIGHT_ALERTS) {
      expect(s.family).toBe("start-light");
    }
  });

  it("start-ready and start-go are CRITICAL + interrupt + queueable", () => {
    for (const id of ["pit-crew.start-light-ready", "pit-crew.start-light-go"]) {
      const s = findScenario(id);
      expect(s.weight).toBe(WEIGHT.CRITICAL);
      expect(s.interrupt).toBe(true);
      // Issue #867: a spotter proximity call (PROXIMITY > CRITICAL) outranks
      // the gantry lines exactly when cars are side by side at a start;
      // queueable defers them for replay instead of losing the one-shot call.
      expect(s.queueable).toBe(true);
    }
  });

  it("countdown scenarios are NORMAL weight + queueable:false", () => {
    for (const seconds of [90, 60, 30, 10]) {
      const s = findScenario(`pit-crew.start-light-countdown-${seconds}`);
      expect(s.weight).toBe(WEIGHT.NORMAL);
      expect(s.queueable).toBe(false);
    }
  });

  it("every scenario uses the per-voice base path", () => {
    for (const s of START_LIGHT_ALERTS) {
      expect(s.base).toBe("voice/{voice}");
    }
  });
});

describe("START_LIGHT_ALERTS triggers", () => {
  it.each([
    {
      label: "start-ready",
      event: "startLight.start-ready.raised" as const,
      data: {},
      expected: "voice/luca/start-lights/start-ready-01.mp3",
    },
    {
      label: "start-go",
      event: "startLight.start-go.raised" as const,
      data: {},
      expected: "voice/luca/start-lights/start-go-01.mp3",
    },
  ])("$label fires the matching clip", ({ event, data, expected }) => {
    bus.publishEvent(event, data as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([expected]);
  });

  it.each([
    { seconds: 90 as const, expected: "voice/luca/start-lights/countdown-90-01.mp3" },
    { seconds: 60 as const, expected: "voice/luca/start-lights/countdown-60-01.mp3" },
    { seconds: 30 as const, expected: "voice/luca/start-lights/countdown-30-01.mp3" },
    { seconds: 10 as const, expected: "voice/luca/start-lights/countdown-10-01.mp3" },
  ])("countdown $seconds fires only its own clip", ({ seconds, expected }) => {
    bus.publishEvent("startLight.countdown.raised", { seconds });
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([expected]);
  });

  it("countdown with seconds=30 does NOT fire any other number", () => {
    bus.publishEvent("startLight.countdown.raised", { seconds: 30 });
    flush(audio);

    const played = voiceClipsPlayed();
    expect(played).toEqual(["voice/luca/start-lights/countdown-30-01.mp3"]);
  });

  it("substitutes the active voice — switching voice changes resolved path", () => {
    activeVoice = "titan";
    bus.publishEvent("startLight.start-go.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual(["voice/titan/start-lights/start-go-01.mp3"]);
  });

  it("wraps the callout in the radio frame (open + close ticks on the SFX channel)", () => {
    bus.publishEvent("startLight.start-ready.raised", {});
    flush(audio);

    expect(sfxClipsPlayed()).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
  });
});

describe("START_LIGHT_ALERTS preemption", () => {
  function lastVoiceClip(): string | undefined {
    return voiceClipsPlayed().at(-1);
  }

  it("start-go preempts an in-flight start-ready (family share + interrupt)", () => {
    bus.publishEvent("startLight.start-ready.raised", {});
    // Don't flush — start-ready is still mid-playback.
    bus.publishEvent("startLight.start-go.raised", {});
    flush(audio);

    expect(lastVoiceClip()).toBe("voice/luca/start-lights/start-go-01.mp3");
  });

  // The two runtime supersession guards for the #867 queueable change: the DSL
  // replays queueable fires unconditionally, so these prove a stale
  // "lights are up" can never replay after "go" has superseded it.

  it("start-go supersedes a start-ready queued behind a busy bus — ready never replays (#867)", () => {
    engine.defineScenario({
      id: "test.blocker",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.PROXIMITY,
      sequence: ["voice/luca/start-lights/countdown-90-01.mp3"],
    });
    engine.fire("test.blocker");

    // Both gantry lines defer behind the higher-weight line (queueable: true);
    // the single pending slot's newest-wins tie-break keeps only go.
    bus.publishEvent("startLight.start-ready.raised", {});
    bus.publishEvent("startLight.start-go.raised", {});
    flush(audio);

    const voice = voiceClipsPlayed();
    expect(voice).toContain("voice/luca/start-lights/start-go-01.mp3");
    expect(voice).not.toContain("voice/luca/start-lights/start-ready-01.mp3");
  });

  it("a start-ready cut mid-playback by start-go is not stashed — no replay at idle (#867)", () => {
    bus.publishEvent("startLight.start-ready.raised", {});
    // Mid-playback (no flush): go supersedes via the shared family, and a
    // same-family replacement is never stashed for replay.
    bus.publishEvent("startLight.start-go.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).not.toContain("voice/luca/start-lights/start-ready-01.mp3");
    expect(lastVoiceClip()).toBe("voice/luca/start-lights/start-go-01.mp3");
  });
});

// Opt-in gating wired through `registerPitCrew`'s `getStartLightCalloutEnabled`
// closure (issue #480). `countdown` gates all four numbers; `lights` gates the
// two gantry lines. Each is independent. The manifest here only carries the
// start-light clips, so unrelated families register with disabled scenarios
// (pool-validation errors are logged but harmless) — the start-light events
// under test still fire normally.
describe("START_LIGHT_ALERTS opt-in gating (issue #480)", () => {
  let startLightEnabled: Map<StartLightCalloutId, boolean>;

  beforeEach(() => {
    // Re-init a fresh engine and register via `registerPitCrew` (the structural
    // describe above wires scenarios directly; this block exercises the gate).
    _resetAudioScenarios();
    bus = createMockBus();
    audio = createFakeAudio();
    initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => "luca");

    startLightEnabled = new Map<StartLightCalloutId, boolean>([
      ["lights", true],
      ["countdown", true],
    ]);

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
      undefined, // getRaceStartCalloutEnabled
      undefined, // getRaceStartSnapshot
      undefined, // getOvertakeCalloutEnabled
      undefined, // getOvertakeDriverName
      undefined, // getLivePosition
      undefined, // getOvertakeGate
      undefined, // getPitBoxCalloutEnabled
      undefined, // getSetupWarningMismatch
      undefined, // getSpotterCalloutEnabled
      undefined, // getSpotterTrackDirection
      undefined, // getSpotterStillThereIntervalMs
      undefined, // getSpotterNearestCarGapMeters
      undefined, // getPitWindowCalloutEnabled (issue #655)
      undefined, // getRollingStartCalloutEnabled
      (id) => startLightEnabled.get(id) ?? true, // getStartLightCalloutEnabled
      undefined, // getFuelCalloutEnabled (issue #838)
      undefined, // getCornerNameCalloutEnabled (issue #888)
      undefined, // getCornerNameSnapshot (issue #888)
      undefined, // getOpponentPitCalloutEnabled (issue #622)
      undefined, // getOpponentPitLivePosition (issue #622)
      undefined, // getGapCalloutEnabled (issue #933)
      undefined, // getGapCooldownMs (issue #933)
      undefined, // getLiveGaps (issue #933)
      undefined, // getOpponentFlagCalloutEnabled (issue #936)
      undefined, // getOpponentFlagLivePosition (issue #936)
      undefined, // getPitSpeedingCalloutEnabled (issue #912)
      undefined, // getPitLimiterCalloutEnabled (issue #1051)
      undefined, // getNoLimiterCalloutEnabled (issue #1051)
      undefined, // getRaceEngineerMasterEnabled
      undefined, // getRadarMasterEnabled
    );
  });

  afterEach(() => {
    _resetRadarEngine();
    _resetSpotterEngine();
    _resetPitSpeedingEngine();
  });

  it("fires gantry lines and countdown numbers when both opt-ins are on", () => {
    bus.publishEvent("startLight.start-ready.raised", {});
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes("/start-lights/start-ready-"))).toBe(true);

    bus.publishEvent("startLight.countdown.raised", { seconds: 30 });
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes("/start-lights/countdown-30-"))).toBe(true);
  });

  it("countdown off suppresses all four numbers but keeps the gantry lines", () => {
    startLightEnabled.set("countdown", false);

    for (const seconds of [90, 60, 30, 10] as const) {
      bus.publishEvent("startLight.countdown.raised", { seconds });
    }

    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    bus.publishEvent("startLight.start-go.raised", {});
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes("/start-lights/start-go-"))).toBe(true);
  });

  it("lights off suppresses ready/go but keeps the countdown numbers", () => {
    startLightEnabled.set("lights", false);

    bus.publishEvent("startLight.start-ready.raised", {});
    bus.publishEvent("startLight.start-go.raised", {});
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    bus.publishEvent("startLight.countdown.raised", { seconds: 10 });
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes("/start-lights/countdown-10-"))).toBe(true);
  });
});

// Issue #480 follow-up: start lights are race-only. iRacing can raise the grid
// bits while forming the race grid at the END of a qualifying session, so the
// scenarios gate on the race session (mirrors the race-progression flags).
describe("START_LIGHT_ALERTS race-only gating", () => {
  it("suppresses every start-light callout in qualifying", () => {
    mockSessionType.mockReturnValue("Qualify");

    bus.publishEvent("startLight.start-ready.raised", {});
    bus.publishEvent("startLight.start-go.raised", {});
    bus.publishEvent("startLight.countdown.raised", { seconds: 30 });
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("fires the gantry + countdown in a race", () => {
    mockSessionType.mockReturnValue("Race");

    bus.publishEvent("startLight.start-go.raised", {});
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes("/start-lights/start-go-"))).toBe(true);

    bus.publishEvent("startLight.countdown.raised", { seconds: 30 });
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes("/start-lights/countdown-30-"))).toBe(true);
  });

  it("suppresses the gantry lines when out of the car (missed the start — no 'go, go, go')", () => {
    mockSessionType.mockReturnValue("Race");
    const outOfCar = { IsOnTrack: false, IsReplayPlaying: false };

    bus.publishEvent("startLight.start-ready.raised", {}, outOfCar);
    bus.publishEvent("startLight.start-go.raised", {}, outOfCar);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  // Issue #829: the countdown is the "get in the car" reminder — it must play
  // while the driver sits in the garage / session screen / in-session replay
  // view. The replay-only (saved replay) case is gated translator-side via
  // SimMode, not here.
  it("fires the countdown when out of the car (garage / session screen / replay view)", () => {
    mockSessionType.mockReturnValue("Race");
    const outOfCar = { IsOnTrack: false, IsReplayPlaying: true };

    bus.publishEvent("startLight.countdown.raised", { seconds: 30 }, outOfCar);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/start-lights/countdown-30-"))).toBe(true);
  });

  it("fires the countdown with no telemetry attached (scenario-harness path)", () => {
    mockSessionType.mockReturnValue("Race");

    bus.publishEvent("startLight.countdown.raised", { seconds: 10 }, null);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/start-lights/countdown-10-"))).toBe(true);
  });
});
