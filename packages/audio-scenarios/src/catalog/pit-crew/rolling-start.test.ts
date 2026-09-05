/**
 * Rolling-start contract tests (issue #660; scripted since #1065).
 *
 * Mirrors `start-lights.test.ts`: a fake bus + fake audio service, the
 * contract registered on a fresh engine, and the bundled voice's REAL
 * `callouts.json` narrowed to this family's entry — so every fire here runs
 * the same compile + expansion path production does, and what the engineer
 * says is the script's. Covers:
 *   - contract structure (id, family `rolling-start`, weight SAFETY, base,
 *     no sequence, the engine's default frame)
 *   - the trigger fires one clip from the pool inside the engine's radio frame
 *   - opt-in gating via the `registerPitCrew` closure: `pace-car` off
 *     suppresses the callout
 *   - race-only gating: a non-race session suppresses the callout
 *   - the bundled script's entry: described, pinned to the published clip
 *     source, and compiling clean for the test voices
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import {
  _resetAudioScenarios,
  getScenarioEngine,
  initializeAudioScenarios,
  poolMemberPattern,
} from "../../interpreter.js";
import { registerPitCrew, type RollingStartCalloutId } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { ROLLING_START_CLIP_SOURCES, ROLLING_START_CONTRACTS, ROLLING_START_SCENARIO_IDS } from "./rolling-start.js";
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

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

/** The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to this family's own entry — handed to BOTH
 * test voices. It supplies the `radio` frame the engine wraps the callout in
 * (issue #1064) and the pace-car line itself (#1065). `fragments` is narrowed
 * too (to none): the entry includes none, and `collectScriptReferences`
 * walks every fragment it is given, so another family's fragment would
 * otherwise widen the reference set under the assertions below.
 */
const ROLLING_START_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(ROLLING_START_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
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

  // The production order (`registerPitCrew`): the contract, then the scripts.
  // No pool is registered in code for this family any more, and the script
  // names none either: its `pool:rolling-start/pace-car-moving` step
  // addresses the clip group directly, resolved against the manifest at fire
  // time.
  for (const c of ROLLING_START_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map(VOICE_KEYS.map((v) => [v, ROLLING_START_SCRIPT])));
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

function findContract(id: string): (typeof ROLLING_START_CONTRACTS)[number] {
  const c = ROLLING_START_CONTRACTS.find((x) => x.id === id);

  if (!c) throw new Error(`No rolling-start contract with id "${id}"`);

  return c;
}

describe("ROLLING_START_CONTRACTS structure", () => {
  it("defines 1 contract", () => {
    expect(ROLLING_START_CONTRACTS).toHaveLength(1);
  });

  it("exposes a stable list of ids", () => {
    expect(ROLLING_START_SCENARIO_IDS).toEqual(["pit-crew.rolling-start-pace-car"]);
  });

  it("ids are unique", () => {
    expect(new Set(ROLLING_START_SCENARIO_IDS).size).toBe(ROLLING_START_SCENARIO_IDS.length);
  });

  it("carries no sequence — what the line says is the voice script's, never the code's (issue #1065)", () => {
    for (const c of ROLLING_START_CONTRACTS) expect("sequence" in c).toBe(false);
  });

  it("all contracts share family 'rolling-start'", () => {
    for (const c of ROLLING_START_CONTRACTS) {
      expect(c.family).toBe("rolling-start");
    }
  });

  it("pace-car is SAFETY weight, not interrupt, not queueable, and takes the engine's default frame", () => {
    const c = findContract("pit-crew.rolling-start-pace-car");
    expect(c.when?.event).toBe("rollingStart.pace-car-moving.raised");
    expect(c.channel).toBe(AudioChannel.Voice);
    expect(c.bus).toBe(AudioBus.Voice);
    expect(c.weight).toBe(WEIGHT.SAFETY);
    expect(c.interrupt).not.toBe(true);
    expect(c.queueable).toBeUndefined();
    expect(c.cooldown).toBeUndefined();
    expect(c.triggerDelay).toBeUndefined();
    expect(c.frame).toBeUndefined();
  });

  it("every contract uses the per-voice base path", () => {
    for (const c of ROLLING_START_CONTRACTS) {
      expect(c.base).toBe("voice/{voice}");
    }
  });
});

describe("ROLLING_START_CONTRACTS triggers", () => {
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

  it("is wrapped in the active voice's radio frame by the engine — open tick first, close tick last (issue #1064)", () => {
    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);
    flush(audio);

    const played = audio._played.map((p) => p.path);

    expect(played[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(played.at(-1)).toBe("sfx/IRD-tick-close.mp3");
    expect(sfxClipsPlayed()).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
  });

  it("a voice with no script plays no rolling-start line at all — no line, no frame (issue #1065)", () => {
    engine.setScripts(new Map([["titan", ROLLING_START_SCRIPT]]));

    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);
    flush(audio);

    expect(audio._played).toEqual([]);
  });
});

// Opt-in gating wired through `registerPitCrew`'s `getRollingStartCalloutEnabled`
// closure (issue #660). Single subject (`pace-car`). The manifest here only
// carries the rolling-start clips, so unrelated families register with disabled
// scenarios (pool-validation errors are logged but harmless) — the rolling-start
// event under test still fires normally.
describe("ROLLING_START_CONTRACTS opt-in gating (issue #660)", () => {
  let rollingStartEnabled: Map<RollingStartCalloutId, boolean>;

  beforeEach(() => {
    // Re-init a fresh engine and register via `registerPitCrew` (the structural
    // describe above wires scenarios directly; this block exercises the gate).
    _resetAudioScenarios();
    bus = createMockBus();
    audio = createFakeAudio();
    initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => "luca");

    rollingStartEnabled = new Map<RollingStartCalloutId, boolean>([["pace-car", true]]);

    registerPitCrew(bus, {
      logger: mockLogger as never,
      getRollingStartCalloutEnabled: (id) => rollingStartEnabled.get(id) ?? true,
    });
    // A contract is silent without a script (issue #1065): the gate is what is
    // under test here, so the line must be there to be gated.
    getScenarioEngine().setScripts(new Map([["luca", ROLLING_START_SCRIPT]]));
  });

  afterEach(() => {
    _resetRadarEngine();
    _resetSpotterEngine();
    _resetPitSpeedingEngine();
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
describe("ROLLING_START_CONTRACTS race-only gating", () => {
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

describe("the bundled script's rolling-start entry (issue #1065)", () => {
  it("scripts the contract with a comment, a Rolling Start harness route and a sequence", () => {
    for (const id of ROLLING_START_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Scenario Shortcuts → Rolling Start → Pace car moving/);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence).toEqual(["pool:rolling-start/pace-car-moving"]);
    }
  });

  it("names no vocabulary, no frame, no fragment and no pool alias — the line is one direct pool step", () => {
    const refs = collectScriptReferences(ROLLING_START_SCRIPT);

    expect(refs.vars).toEqual([]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(Object.keys(ROLLING_START_SCRIPT.pools ?? {})).toEqual([]);
  });

  it("addresses exactly the published clip source — the slashed form — and it has clips in the bundled voice", () => {
    const sources = ["rolling-start/pace-car-moving"];

    expect([...collectScriptReferences(ROLLING_START_SCRIPT).pools].sort()).toEqual(sources);
    expect(ROLLING_START_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);

    for (const { group, base } of ROLLING_START_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `no voice/${BUNDLED_VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
    }
  });

  it("the fixture manifest carries the source for both test voices — the fires above are not vacuous", () => {
    for (const voice of VOICE_KEYS) {
      for (const { group, base } of ROLLING_START_CLIP_SOURCES) {
        const pattern = poolMemberPattern(group, base);

        expect(
          manifest.clips.some((clip) => pattern.exec(clip)?.[1] === voice),
          `${voice}: ${group}/${base}`,
        ).toBe(true);
      }
    }
  });

  it("compiles for both test voices with nothing skipped — no unknown pool, condition, case key or fragment", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
