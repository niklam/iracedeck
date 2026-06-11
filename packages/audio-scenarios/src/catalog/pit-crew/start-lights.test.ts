/**
 * Start-light scenario catalog tests (issue #480).
 *
 * Mirrors `flag-alerts.test.ts`: a fake bus + fake audio service, the
 * start-light pools registered from `pools.ts`, and the radio-frame include
 * scenarios. Covers:
 *   - each gantry line + countdown number fires its clip
 *   - start-set / start-go are CRITICAL + interrupt
 *   - family preemption (start-set → start-go: last clip is go)
 *   - the countdown event filters by `seconds` (30 fires only the 30 clip)
 *   - opt-in gating via the `registerPitCrew` closure: `countdown` off
 *     suppresses all three numbers; `lights` off suppresses set/go.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew, type StartLightCalloutId } from "./index.js";
import { POOLS } from "./pools.js";
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
// start-light scenarios gate on `isLiveOnTrack` (issue #480 follow-up), so events
// need in-car telemetry to fire; the out-of-car test passes an override.
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
  "start-set-01",
  "start-go-01",
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

  for (const name of START_LIGHT_POOL_NAMES) engine.definePool(name, [...POOLS[name]]);

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
  it("defines 5 scenarios", () => {
    expect(START_LIGHT_ALERTS).toHaveLength(5);
  });

  it("exposes a stable list of ids", () => {
    expect(START_LIGHT_SCENARIO_IDS).toEqual([
      "pit-crew.start-light-set",
      "pit-crew.start-light-go",
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

  it("start-set and start-go are CRITICAL + interrupt", () => {
    for (const id of ["pit-crew.start-light-set", "pit-crew.start-light-go"]) {
      const s = findScenario(id);
      expect(s.weight).toBe(WEIGHT.CRITICAL);
      expect(s.interrupt).toBe(true);
    }
  });

  it("countdown scenarios are NORMAL weight + queueable:false", () => {
    for (const seconds of [60, 30, 10]) {
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
      label: "start-set",
      event: "startLight.start-set.raised" as const,
      data: {},
      expected: "voice/luca/start-lights/start-set-01.mp3",
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
    bus.publishEvent("startLight.start-set.raised", {});
    flush(audio);

    expect(sfxClipsPlayed()).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
  });
});

describe("START_LIGHT_ALERTS preemption", () => {
  function lastVoiceClip(): string | undefined {
    return voiceClipsPlayed().at(-1);
  }

  it("start-go preempts an in-flight start-set (family share + interrupt)", () => {
    bus.publishEvent("startLight.start-set.raised", {});
    // Don't flush — start-set is still mid-playback.
    bus.publishEvent("startLight.start-go.raised", {});
    flush(audio);

    expect(lastVoiceClip()).toBe("voice/luca/start-lights/start-go-01.mp3");
  });
});

// Opt-in gating wired through `registerPitCrew`'s `getStartLightCalloutEnabled`
// closure (issue #480). `countdown` gates all five numbers; `lights` gates the
// three gantry lines. Each is independent. The manifest here only carries the
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
      undefined, // getRaceEngineerMasterEnabled
      undefined, // getRadarMasterEnabled
    );
  });

  afterEach(() => {
    _resetRadarEngine();
    _resetSpotterEngine();
  });

  it("fires gantry lines and countdown numbers when both opt-ins are on", () => {
    bus.publishEvent("startLight.start-set.raised", {});
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes("/start-lights/start-set-"))).toBe(true);

    bus.publishEvent("startLight.countdown.raised", { seconds: 30 });
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes("/start-lights/countdown-30-"))).toBe(true);
  });

  it("countdown off suppresses all three numbers but keeps the gantry lines", () => {
    startLightEnabled.set("countdown", false);

    for (const seconds of [60, 30, 10] as const) {
      bus.publishEvent("startLight.countdown.raised", { seconds });
    }

    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    bus.publishEvent("startLight.start-go.raised", {});
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes("/start-lights/start-go-"))).toBe(true);
  });

  it("lights off suppresses set/go but keeps the countdown numbers", () => {
    startLightEnabled.set("lights", false);

    bus.publishEvent("startLight.start-set.raised", {});
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

    bus.publishEvent("startLight.start-set.raised", {});
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

  it("suppresses every start-light callout when out of the car (replay / grid spectating)", () => {
    mockSessionType.mockReturnValue("Race");
    const outOfCar = { IsOnTrack: false, IsReplayPlaying: false };

    bus.publishEvent("startLight.start-set.raised", {}, outOfCar);
    bus.publishEvent("startLight.start-go.raised", {}, outOfCar);
    bus.publishEvent("startLight.countdown.raised", { seconds: 30 }, outOfCar);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });
});
