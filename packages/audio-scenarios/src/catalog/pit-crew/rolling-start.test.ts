/**
 * Rolling-start scenario catalog tests (issue #660).
 *
 * Mirrors `start-lights.test.ts`: a fake bus + fake audio service, the
 * rolling-start pool registered from `pools.ts`, and the radio-frame include
 * scenarios. Covers:
 *   - scenario structure (id, family `rolling-start`, weight SAFETY, base)
 *   - the trigger fires one clip from the pool through the radio frame
 *   - opt-in gating via the `registerPitCrew` closure: `pace-car` off
 *     suppresses the callout
 *   - race-only gating: a non-race session suppresses the callout
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew, type RollingStartCalloutId } from "./index.js";
import { POOL_REGISTRY } from "./pools.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { RADIO_CLOSE, RADIO_OPEN } from "./radio-frame.js";
import { ROLLING_START_ALERTS, ROLLING_START_POOL_NAMES, ROLLING_START_SCENARIO_IDS } from "./rolling-start.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

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
// rolling-start scenario gates on `isLiveOnTrack`, so events need in-car
// telemetry to fire; the out-of-car test passes an override.
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

const ROLLING_START_CLIP_NAMES = [
  "pace-car-moving-01",
  "pace-car-moving-02",
  "pace-car-moving-03",
  "pace-car-moving-04",
  "pace-car-moving-05",
] as const;

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...VOICE_KEYS.flatMap((v) => ROLLING_START_CLIP_NAMES.map((name) => `voice/${v}/rolling-start/${name}.mp3`)),
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

  for (const name of ROLLING_START_POOL_NAMES) {
    const { group, base } = POOL_REGISTRY[name];
    engine.definePoolFromManifest(name, group, base);
  }

  engine.defineScenario(RADIO_OPEN);
  engine.defineScenario(RADIO_CLOSE);

  for (const s of ROLLING_START_ALERTS) engine.defineScenario(s);
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

function findScenario(id: string): (typeof ROLLING_START_ALERTS)[number] {
  const s = ROLLING_START_ALERTS.find((x) => x.id === id);

  if (!s) throw new Error(`No rolling-start scenario with id "${id}"`);

  return s;
}

describe("ROLLING_START_ALERTS structure", () => {
  it("defines 1 scenario", () => {
    expect(ROLLING_START_ALERTS).toHaveLength(1);
  });

  it("exposes a stable list of ids", () => {
    expect(ROLLING_START_SCENARIO_IDS).toEqual(["pit-crew.rolling-start-pace-car"]);
  });

  it("ids are unique", () => {
    expect(new Set(ROLLING_START_SCENARIO_IDS).size).toBe(ROLLING_START_SCENARIO_IDS.length);
  });

  it("all scenarios share family 'rolling-start'", () => {
    for (const s of ROLLING_START_ALERTS) {
      expect(s.family).toBe("rolling-start");
    }
  });

  it("pace-car is SAFETY weight, not interrupt", () => {
    const s = findScenario("pit-crew.rolling-start-pace-car");
    expect(s.weight).toBe(WEIGHT.SAFETY);
    expect(s.interrupt).not.toBe(true);
  });

  it("every scenario uses the per-voice base path", () => {
    for (const s of ROLLING_START_ALERTS) {
      expect(s.base).toBe("voice/{voice}");
    }
  });
});

describe("ROLLING_START_ALERTS triggers", () => {
  it("fires a clip from the pool", () => {
    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);
    flush(audio);

    const played = voiceClipsPlayed();
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/^voice\/luca\/rolling-start\/pace-car-moving-0[12345]\.mp3$/);
  });

  it("substitutes the active voice — switching voice changes resolved path", () => {
    activeVoice = "titan";
    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);
    flush(audio);

    const played = voiceClipsPlayed();
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/^voice\/titan\/rolling-start\/pace-car-moving-0[12345]\.mp3$/);
  });

  it("wraps the callout in the radio frame (open + close ticks on the SFX channel)", () => {
    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);
    flush(audio);

    expect(sfxClipsPlayed()).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
  });
});

// Opt-in gating wired through `registerPitCrew`'s `getRollingStartCalloutEnabled`
// closure (issue #660). Single subject (`pace-car`). The manifest here only
// carries the rolling-start clips, so unrelated families register with disabled
// scenarios (pool-validation errors are logged but harmless) — the rolling-start
// event under test still fires normally.
describe("ROLLING_START_ALERTS opt-in gating (issue #660)", () => {
  let rollingStartEnabled: Map<RollingStartCalloutId, boolean>;

  beforeEach(() => {
    // Re-init a fresh engine and register via `registerPitCrew` (the structural
    // describe above wires scenarios directly; this block exercises the gate).
    _resetAudioScenarios();
    bus = createMockBus();
    audio = createFakeAudio();
    initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => "luca");

    rollingStartEnabled = new Map<RollingStartCalloutId, boolean>([["pace-car", true]]);

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
      (id) => rollingStartEnabled.get(id) ?? true, // getRollingStartCalloutEnabled
      undefined, // getStartLightCalloutEnabled
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
      undefined, // getRaceEngineerMasterEnabled
      undefined, // getRadarMasterEnabled
    );
  });

  afterEach(() => {
    _resetRadarEngine();
    _resetSpotterEngine();
  });

  it("fires the pace-car line when the opt-in is on", () => {
    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/rolling-start/pace-car-moving-"))).toBe(true);
  });

  it("pace-car off suppresses the callout", () => {
    rollingStartEnabled.set("pace-car", false);

    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("logs a debug line on suppression", () => {
    rollingStartEnabled.set("pace-car", false);
    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);

    expect(mockLogger.debug).toHaveBeenCalledWith("rolling-start callout suppressed: pace-car");
  });
});

// Issue #660: rolling-start is race-only. iRacing can raise pace-car movement
// bits while forming the race grid at the END of a qualifying session, so the
// scenario gates on the race session (mirrors the start-light family).
describe("ROLLING_START_ALERTS race-only gating", () => {
  it("suppresses the rolling-start callout in qualifying", () => {
    mockSessionType.mockReturnValue("Qualify");

    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("fires the rolling-start callout in a race", () => {
    mockSessionType.mockReturnValue("Race");

    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/rolling-start/pace-car-moving-"))).toBe(true);
  });

  it("suppresses the rolling-start callout when out of the car (replay / grid spectating)", () => {
    mockSessionType.mockReturnValue("Race");
    const outOfCar = { IsOnTrack: false, IsReplayPlaying: false };

    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never, outOfCar);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });
});
