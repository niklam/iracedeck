/**
 * Laps-of-fuel-left contract tests (issue #838 / #880; scripted since #1065).
 *
 * Mirrors `flag-alerts.test.ts`: a fake bus + fake audio service, the twelve
 * contracts registered on a fresh engine, and the bundled voice's REAL
 * `callouts.json` narrowed to this family's entries — so every fire here
 * runs the same compile + expansion path production does, and what the
 * engineer says is the script's. Covers:
 *   - every count fires its own clip and nothing else; the box call answers
 *     count 0; the enough-fuel confirmation answers its own event
 *   - the weight bands (NORMAL 10–4, SAFETY 3–2, CRITICAL + interrupt 1 and
 *     box) and `queueable` on every contract
 *   - family preemption (a fresher count supersedes the stale one in flight)
 *     and the queueable deferral behind a busier bus
 *   - the engine's radio frame around each line
 *   - opt-in gating via the `registerPitCrew` closure, one subject per count
 *   - the bundled script's entries: complete, described, pinned to the
 *     published clip sources, and compiling clean for the test voice
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
import {
  FUEL_LAPS_LEFT_CLIP_SOURCES,
  FUEL_LAPS_LEFT_CONTRACTS,
  FUEL_LAPS_LEFT_SCENARIO_IDS,
} from "./fuel-laps-left.js";
import { type FuelCalloutId, registerPitCrew } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => "Race",
  getStandingStart: () => false,
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

function createMockBus(): IEventBus & {
  publishEvent: <T extends SimEventName>(name: T, data: SimEventMap[T]["data"]) => void;
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
    publishEvent<T extends SimEventName>(name: T, data: SimEventMap[T]["data"]) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry: null,
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

const VOICE = "luca";

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...FUEL_LAPS_LEFT_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to this family's own entries (and to no
 * fragments — none of these entries includes one): an entry for a contract
 * the engine under test does not hold is a `no contract` warn, and a foreign
 * fragment would widen `collectScriptReferences` under the assertions below.
 */
const FUEL_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(FUEL_LAPS_LEFT_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
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

beforeEach(() => {
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);

  // The production order (`registerPitCrew`): contracts, then the scripts.
  // No pools are registered in code for this family any more, and the script
  // names none either: its `pool:fuel/<base>` steps address the clip group
  // directly, resolved against the manifest at fire time.
  for (const c of FUEL_LAPS_LEFT_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map([[VOICE, FUEL_SCRIPT]]));
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

function crossed(count: number): void {
  bus.publishEvent("fuel.lapsLeft.crossed", { count, lapsLeft: count + 0.4 });
  flush(audio);
}

function findContract(id: string) {
  const c = FUEL_LAPS_LEFT_CONTRACTS.find((x) => x.id === id);

  if (!c) throw new Error(`No fuel contract with id "${id}"`);

  return c;
}

const COUNTS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] as const;

describe("FUEL_LAPS_LEFT_CONTRACTS structure", () => {
  it("defines 12 contracts — counts 10 → 1, the box call, and the enough-fuel confirmation", () => {
    expect(FUEL_LAPS_LEFT_CONTRACTS).toHaveLength(12);
    expect(FUEL_LAPS_LEFT_SCENARIO_IDS).toEqual([
      ...COUNTS.map((n) => `pit-crew.fuel-laps-left-${n}`),
      "pit-crew.fuel-laps-left-box",
      "pit-crew.fuel-laps-left-race-covered",
    ]);
    expect(new Set(FUEL_LAPS_LEFT_SCENARIO_IDS).size).toBe(12);
  });

  it("carries no sequence — what a count says is the voice script's, never the code's", () => {
    for (const c of FUEL_LAPS_LEFT_CONTRACTS) expect("sequence" in c).toBe(false);
  });

  it("keeps the shared scheduling fields verbatim: Voice bus, per-voice base, family fuel, queueable, default frame", () => {
    for (const c of FUEL_LAPS_LEFT_CONTRACTS) {
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.family).toBe("fuel");
      expect(c.queueable).toBe(true);
      expect(c.cooldown).toBeUndefined();
      expect(c.triggerDelay).toBeUndefined();
      expect(c.frame).toBeUndefined();
    }
  });

  it("keeps the weight bands: NORMAL for 10–4, SAFETY for 3–2, CRITICAL + interrupt for 1 and the box call", () => {
    for (const n of [10, 9, 8, 7, 6, 5, 4]) {
      const c = findContract(`pit-crew.fuel-laps-left-${n}`);

      expect(c.weight, `count ${n}`).toBe(WEIGHT.NORMAL);
      expect(c.interrupt, `count ${n}`).toBeUndefined();
    }

    for (const n of [3, 2]) {
      const c = findContract(`pit-crew.fuel-laps-left-${n}`);

      expect(c.weight, `count ${n}`).toBe(WEIGHT.SAFETY);
      expect(c.interrupt, `count ${n}`).toBeUndefined();
    }

    for (const id of ["pit-crew.fuel-laps-left-1", "pit-crew.fuel-laps-left-box"]) {
      const c = findContract(id);

      expect(c.weight, id).toBe(WEIGHT.CRITICAL);
      expect(c.interrupt, id).toBe(true);
    }

    const covered = findContract("pit-crew.fuel-laps-left-race-covered");

    expect(covered.weight).toBe(WEIGHT.NORMAL);
    expect(covered.interrupt).toBeUndefined();
  });

  it("the counts ride fuel.lapsLeft.crossed, the confirmation rides fuel.lapsLeft.raceCovered", () => {
    for (const n of [...COUNTS, "box"]) {
      expect(findContract(`pit-crew.fuel-laps-left-${n}`).when?.event).toBe("fuel.lapsLeft.crossed");
    }

    expect(findContract("pit-crew.fuel-laps-left-race-covered").when?.event).toBe("fuel.lapsLeft.raceCovered");
  });
});

describe("FUEL_LAPS_LEFT_CONTRACTS triggers", () => {
  it.each(COUNTS)("count %i plays only its own laps-left line", (count) => {
    crossed(count);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/fuel/laps-left-${count}-01.mp3`]);
  });

  it("count 0 plays the box-this-lap call", () => {
    crossed(0);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/fuel/laps-left-box-01.mp3`]);
  });

  it("a count outside the catalog (11) matches no contract — nothing plays", () => {
    crossed(11);

    expect(audio._played).toEqual([]);
  });

  it("the enough-fuel confirmation plays the race-covered line", () => {
    bus.publishEvent("fuel.lapsLeft.raceCovered", {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/fuel/race-covered-01.mp3`]);
  });

  it("is wrapped in the active voice's radio frame by the engine — open tick first, close tick last (issue #1064)", () => {
    crossed(3);

    const played = audio._played.map((p) => p.path);

    expect(played[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(played.at(-1)).toBe("sfx/IRD-tick-close.mp3");
    expect(sfxClipsPlayed()).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
  });

  it("a voice with no script plays no fuel line at all — no line, no frame", () => {
    engine.setScripts(new Map([["titan", FUEL_SCRIPT]]));

    crossed(3);

    expect(audio._played).toEqual([]);
  });
});

describe("FUEL_LAPS_LEFT_CONTRACTS scheduling", () => {
  it("a fresher count supersedes the stale one in flight (family share) — only the newer count plays", () => {
    bus.publishEvent("fuel.lapsLeft.crossed", { count: 3, lapsLeft: 3.4 });
    // Don't flush — the three-lap line is still mid-playback.
    bus.publishEvent("fuel.lapsLeft.crossed", { count: 2, lapsLeft: 2.4 });
    flush(audio);

    expect(voiceClipsPlayed().at(-1)).toBe(`voice/${VOICE}/fuel/laps-left-2-01.mp3`);
    expect(voiceClipsPlayed()).not.toContain(`voice/${VOICE}/fuel/laps-left-3-01.mp3`);
  });

  it("the box call cuts a lower-weight line mid-sentence (CRITICAL + interrupt)", () => {
    engine.defineScenario({
      id: "test.chatter",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.NORMAL,
      sequence: [`voice/${VOICE}/fuel/race-covered-01.mp3`, `voice/${VOICE}/fuel/laps-left-10-01.mp3`],
    });
    engine.fire("test.chatter");
    audio._triggerChannelEnd(AudioChannel.SFX);

    bus.publishEvent("fuel.lapsLeft.crossed", { count: 0, lapsLeft: 0.4 });
    flush(audio);

    const voice = voiceClipsPlayed();

    expect(voice).toContain(`voice/${VOICE}/fuel/laps-left-box-01.mp3`);
    // The chatter's second clip never plays — the box call took the bus.
    expect(voice).not.toContain(`voice/${VOICE}/fuel/laps-left-10-01.mp3`);
  });

  it("an ordinary count defers behind a higher-weight line and replays at idle (queueable)", () => {
    engine.defineScenario({
      id: "test.blocker",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CRITICAL,
      sequence: [`voice/${VOICE}/fuel/race-covered-01.mp3`],
    });
    engine.fire("test.blocker");

    bus.publishEvent("fuel.lapsLeft.crossed", { count: 7, lapsLeft: 7.4 });
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([
      `voice/${VOICE}/fuel/race-covered-01.mp3`,
      `voice/${VOICE}/fuel/laps-left-7-01.mp3`,
    ]);
  });
});

// Opt-in gating wired through `registerPitCrew`'s `getFuelCalloutEnabled`
// closure (issue #838): one subject per count, so switching a count off
// silences that count alone. The manifest here only carries the fuel clips,
// so unrelated families register with disabled scenarios (pool-validation
// errors are logged but harmless) — the fuel events under test still fire.
describe("FUEL_LAPS_LEFT_CONTRACTS opt-in gating (issue #838)", () => {
  let fuelEnabled: Map<FuelCalloutId, boolean>;

  beforeEach(() => {
    _resetAudioScenarios();
    bus = createMockBus();
    audio = createFakeAudio();
    initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);

    fuelEnabled = new Map<FuelCalloutId, boolean>();

    registerPitCrew(bus, {
      logger: mockLogger as never,
      getFuelCalloutEnabled: (id) => fuelEnabled.get(id) ?? true,
    });
    getScenarioEngine().setScripts(new Map([[VOICE, FUEL_SCRIPT]]));
  });

  afterEach(() => {
    _resetRadarEngine();
    _resetSpotterEngine();
    _resetPitSpeedingEngine();
  });

  it("fires a count and the confirmation when their opt-ins are on", () => {
    crossed(5);
    bus.publishEvent("fuel.lapsLeft.raceCovered", {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([
      `voice/${VOICE}/fuel/laps-left-5-01.mp3`,
      `voice/${VOICE}/fuel/race-covered-01.mp3`,
    ]);
  });

  it("switching one count off silences that count and no other", () => {
    fuelEnabled.set("laps-left-5", false);

    crossed(5);
    expect(voiceClipsPlayed()).toEqual([]);

    crossed(4);
    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/fuel/laps-left-4-01.mp3`]);
  });

  it("the box call and the confirmation have their own opt-ins", () => {
    fuelEnabled.set("laps-left-box", false);
    fuelEnabled.set("race-covered", false);

    crossed(0);
    bus.publishEvent("fuel.lapsLeft.raceCovered", {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });
});

describe("the bundled script's fuel entries (issue #1065)", () => {
  it("scripts every contract, each with a comment, a Fuel harness route and a sequence", () => {
    for (const id of FUEL_LAPS_LEFT_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Scenario Shortcuts → Fuel → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("names no vocabulary, no frame, no fragment and no pool alias — every line is one direct pool step", () => {
    const refs = collectScriptReferences(FUEL_SCRIPT);

    expect(refs.vars).toEqual([]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(Object.keys(FUEL_SCRIPT.pools ?? {})).toEqual([]);

    for (const n of [...COUNTS, "box"]) {
      expect(SCRIPT.scenarios[`pit-crew.fuel-laps-left-${n}`].sequence).toEqual([`pool:fuel/laps-left-${n}`]);
    }

    expect(SCRIPT.scenarios["pit-crew.fuel-laps-left-race-covered"].sequence).toEqual(["pool:fuel/race-covered"]);
  });

  it("addresses exactly the published clip sources — the slashed form throughout — and every one has a clip in the bundled voice", () => {
    // The literal is the published surface: a `(group, base)` a script
    // addresses is a rename in every pack's script and clip folder.
    const sources = [
      "fuel/laps-left-1",
      "fuel/laps-left-10",
      "fuel/laps-left-2",
      "fuel/laps-left-3",
      "fuel/laps-left-4",
      "fuel/laps-left-5",
      "fuel/laps-left-6",
      "fuel/laps-left-7",
      "fuel/laps-left-8",
      "fuel/laps-left-9",
      "fuel/laps-left-box",
      "fuel/race-covered",
    ];

    expect([...collectScriptReferences(FUEL_SCRIPT).pools].sort()).toEqual(sources);
    expect(FUEL_LAPS_LEFT_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);

    for (const { group, base } of FUEL_LAPS_LEFT_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `no voice/${BUNDLED_VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
    }
  });

  it("the fixture manifest carries every source for the test voice — the fires above are not vacuous", () => {
    for (const { group, base } of FUEL_LAPS_LEFT_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        manifest.clips.some((clip) => pattern.exec(clip)?.[1] === VOICE),
        `${group}/${base}`,
      ).toBe(true);
    }
  });

  it("compiles for the test voice with nothing skipped — no unknown pool, condition, case key or fragment", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
