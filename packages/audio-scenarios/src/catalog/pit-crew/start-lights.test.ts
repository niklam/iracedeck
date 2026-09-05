/**
 * Start-light contract tests (issues #480 / #673; scripted since #1065).
 *
 * Mirrors `flag-alerts.test.ts`: a fake bus + fake audio service, the six
 * contracts registered on a fresh engine, and the bundled voice's REAL
 * `callouts.json` narrowed to this family's entries — so every fire here
 * runs the same compile + expansion path production does, and what the
 * engineer says is the script's. Covers:
 *   - each gantry line + countdown number fires its clip
 *   - start-ready / start-go are CRITICAL + interrupt
 *   - family preemption (start-ready → start-go: last clip is go)
 *   - the countdown event filters by `seconds` (30 fires only the 30 clip)
 *   - opt-in gating via the `registerPitCrew` closure: `countdown` off
 *     suppresses all four numbers; `lights` off suppresses ready/go.
 *   - the bundled script's entries: complete, described, pinned to the
 *     published clip sources, and compiling clean for the test voices
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
import { registerPitCrew, type StartLightCalloutId } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";
import { START_LIGHT_CLIP_SOURCES, START_LIGHT_CONTRACTS, START_LIGHT_SCENARIO_IDS } from "./start-lights.js";

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

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

/** The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to this family's own entries — handed to BOTH
 * test voices. It supplies the `radio` frame the engine wraps each callout
 * in (issue #1064) and the six lines themselves (#1065). `fragments` is
 * narrowed too (to none): no start-light entry includes one, and
 * `collectScriptReferences` walks every fragment it is given, so another
 * family's fragment would otherwise widen the reference set under the
 * assertions below.
 */
const START_LIGHT_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(START_LIGHT_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
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

  // The production order (`registerPitCrew`): contracts, then the scripts.
  // No pools are registered in code for this family any more, and the script
  // names none either: its `pool:start-lights/<base>` steps address the clip
  // group directly, resolved against the manifest at fire time.
  for (const c of START_LIGHT_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map(VOICE_KEYS.map((v) => [v, START_LIGHT_SCRIPT])));
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

function findContract(id: string): (typeof START_LIGHT_CONTRACTS)[number] {
  const c = START_LIGHT_CONTRACTS.find((x) => x.id === id);

  if (!c) throw new Error(`No start-light contract with id "${id}"`);

  return c;
}

describe("START_LIGHT_CONTRACTS structure", () => {
  it("defines 6 contracts", () => {
    expect(START_LIGHT_CONTRACTS).toHaveLength(6);
  });

  it("carries no sequence — what a line says is the voice script's, never the code's (issue #1065)", () => {
    for (const c of START_LIGHT_CONTRACTS) expect("sequence" in c).toBe(false);
  });

  it("names no frame — every line takes the engine default (the voice's `radio`)", () => {
    for (const c of START_LIGHT_CONTRACTS) expect(c.frame).toBeUndefined();
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

  it("all contracts share family 'start-light' on the Voice bus", () => {
    for (const c of START_LIGHT_CONTRACTS) {
      expect(c.family).toBe("start-light");
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.cooldown).toBeUndefined();
      expect(c.triggerDelay).toBeUndefined();
    }
  });

  it("start-ready and start-go are CRITICAL + interrupt + queueable", () => {
    for (const id of ["pit-crew.start-light-ready", "pit-crew.start-light-go"]) {
      const c = findContract(id);
      expect(c.weight).toBe(WEIGHT.CRITICAL);
      expect(c.interrupt).toBe(true);
      // Issue #867: a spotter proximity call (PROXIMITY > CRITICAL) outranks
      // the gantry lines exactly when cars are side by side at a start;
      // queueable defers them for replay instead of losing the one-shot call.
      expect(c.queueable).toBe(true);
    }
  });

  it("countdown contracts are NORMAL weight + queueable:false", () => {
    for (const seconds of [90, 60, 30, 10]) {
      const c = findContract(`pit-crew.start-light-countdown-${seconds}`);
      expect(c.weight).toBe(WEIGHT.NORMAL);
      expect(c.queueable).toBe(false);
      expect(c.interrupt).toBeUndefined();
    }
  });

  it("every contract uses the per-voice base path", () => {
    for (const c of START_LIGHT_CONTRACTS) {
      expect(c.base).toBe("voice/{voice}");
    }
  });
});

describe("START_LIGHT_CONTRACTS triggers", () => {
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

  it("is wrapped in the active voice's radio frame by the engine — open tick first, close tick last (issue #1064)", () => {
    bus.publishEvent("startLight.start-ready.raised", {});
    flush(audio);

    const played = audio._played.map((p) => p.path);

    expect(played[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(played.at(-1)).toBe("sfx/IRD-tick-close.mp3");
    expect(sfxClipsPlayed()).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
  });

  it("a voice with no script plays no start-light line at all — no line, no frame (issue #1065)", () => {
    engine.setScripts(new Map([["titan", START_LIGHT_SCRIPT]]));

    bus.publishEvent("startLight.start-go.raised", {});
    bus.publishEvent("startLight.countdown.raised", { seconds: 30 });
    flush(audio);

    expect(audio._played).toEqual([]);
  });
});

describe("START_LIGHT_CONTRACTS preemption", () => {
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
describe("START_LIGHT_CONTRACTS opt-in gating (issue #480)", () => {
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

    registerPitCrew(bus, {
      logger: mockLogger as never,
      getStartLightCalloutEnabled: (id) => startLightEnabled.get(id) ?? true,
    });
    // A contract is silent without a script (issue #1065): the gates are what
    // is under test here, so the lines must be there to be gated.
    getScenarioEngine().setScripts(new Map([["luca", START_LIGHT_SCRIPT]]));
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
describe("START_LIGHT_CONTRACTS race-only gating", () => {
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

describe("the bundled script's start-light entries (issue #1065)", () => {
  it("scripts every contract, each with a comment, a Start harness route and a sequence", () => {
    for (const id of START_LIGHT_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Scenario Shortcuts → Start → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("names no vocabulary, no frame, no fragment and no pool alias — every line is one direct pool step", () => {
    const refs = collectScriptReferences(START_LIGHT_SCRIPT);

    expect(refs.vars).toEqual([]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(Object.keys(START_LIGHT_SCRIPT.pools ?? {})).toEqual([]);

    expect(SCRIPT.scenarios["pit-crew.start-light-ready"].sequence).toEqual(["pool:start-lights/start-ready"]);
    expect(SCRIPT.scenarios["pit-crew.start-light-go"].sequence).toEqual(["pool:start-lights/start-go"]);

    for (const seconds of [90, 60, 30, 10]) {
      expect(SCRIPT.scenarios[`pit-crew.start-light-countdown-${seconds}`].sequence).toEqual([
        `pool:start-lights/countdown-${seconds}`,
      ]);
    }
  });

  it("addresses exactly the published clip sources — the slashed form throughout — and every one has a clip in the bundled voice", () => {
    const sources = [
      "start-lights/countdown-10",
      "start-lights/countdown-30",
      "start-lights/countdown-60",
      "start-lights/countdown-90",
      "start-lights/start-go",
      "start-lights/start-ready",
    ];

    expect([...collectScriptReferences(START_LIGHT_SCRIPT).pools].sort()).toEqual(sources);
    expect(START_LIGHT_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);

    for (const { group, base } of START_LIGHT_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `no voice/${BUNDLED_VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
    }
  });

  it("the fixture manifest carries every source for both test voices — the fires above are not vacuous", () => {
    for (const voice of VOICE_KEYS) {
      for (const { group, base } of START_LIGHT_CLIP_SOURCES) {
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
