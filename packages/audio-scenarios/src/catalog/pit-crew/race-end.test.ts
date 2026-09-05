/**
 * Race-end final-result tests (issue #569; scripted since #1065).
 *
 * Drives the contract through the real scenario engine with the bundled
 * voice's REAL `callouts.json` narrowed to this family's entry — handed to
 * every test voice — so the greeting's optional clause, the `raceEnd.result`
 * case and the per-voice clip availability (issue #835) all run the
 * production compile + expansion path.
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
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import {
  buildRaceEndContract,
  RACE_END_CLIP_SOURCES,
  RACE_END_RESULT_KEYS,
  RACE_END_SCENARIO_IDS,
  type RaceFinishedSnapshot,
  registerRaceEndVocabulary,
  resolveRaceEndResult,
} from "./race-end.js";

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
        telemetry: null as unknown,
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

function flush(audio: FakeAudio, iterations = 30): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const VOICE = "luca";

// A voice with only the "driver" greeting — exercises the optional greeting
// skip (issue #835).
const BARE_VOICE = "bare";
// A voice with no position-number clips — a required clip is missing for the
// composed P4+ readout, so the whole callout must abort (issue #835).
const PARTIAL_VOICE = "partial";

const GREETING_NAMES = ["niklas", "driver"];

const RACE_END_CLIPS = ["we-won-01", "second-place-01", "podium-third-01", "race-over-result-is-01"];

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...GREETING_NAMES.map((n) => `voice/${VOICE}/race-end-greeting/${n}.mp3`),
    ...RACE_END_CLIPS.map((c) => `voice/${VOICE}/race-end/${c}.mp3`),
    ...Array.from({ length: 64 }, (_, i) => `voice/${VOICE}/position-number/${i + 1}.mp3`),
    `voice/${BARE_VOICE}/race-end-greeting/driver.mp3`,
    ...RACE_END_CLIPS.map((c) => `voice/${BARE_VOICE}/race-end/${c}.mp3`),
    ...Array.from({ length: 64 }, (_, i) => `voice/${BARE_VOICE}/position-number/${i + 1}.mp3`),
    ...GREETING_NAMES.map((n) => `voice/${PARTIAL_VOICE}/race-end-greeting/${n}.mp3`),
    ...RACE_END_CLIPS.map((c) => `voice/${PARTIAL_VOICE}/race-end/${c}.mp3`),
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
 * The bundled script narrowed to this family's own entry — handed to every
 * test voice, so the per-voice clip availability tests below read the same
 * body against three clip sets. `fragments` is narrowed too (to none): the
 * entry includes none, and `collectScriptReferences` walks every fragment it
 * is given, so another family's fragment would otherwise widen the
 * reference set under the assertions below.
 */
const RACE_END_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(RACE_END_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

const BASE_SNAPSHOT: RaceFinishedSnapshot = {
  position: 5,
  classPosition: undefined,
  isMultiClass: false,
  driverName: "niklas",
};

function snap(overrides: Partial<RaceFinishedSnapshot> = {}): RaceFinishedSnapshot {
  return { ...BASE_SNAPSHOT, ...overrides };
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;
let activeVoice: string;
let currentSnapshot: RaceFinishedSnapshot | null;

function fire(snapshot: RaceFinishedSnapshot | null): void {
  currentSnapshot = snapshot;
  bus.publishEvent("race.finished", { position: snapshot?.position ?? 0 });
  flush(audio);
}

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function hasClip(suffix: string): boolean {
  return voicePaths().some((p) => p.endsWith(suffix));
}

beforeEach(() => {
  currentSnapshot = null;
  activeVoice = VOICE;
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => activeVoice);

  // The production order (`registerPitCrew`): vocabulary, contract, scripts.
  registerRaceEndVocabulary(engine, () => currentSnapshot);
  engine.defineContract(buildRaceEndContract(() => currentSnapshot));
  engine.setScripts(new Map([VOICE, BARE_VOICE, PARTIAL_VOICE].map((v) => [v, RACE_END_SCRIPT])));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
});

describe("race-end scenario — result branches", () => {
  it("plays greeting + we-won for P1", () => {
    fire(snap({ position: 1 }));

    expect(hasClip("/race-end-greeting/niklas.mp3")).toBe(true);
    expect(hasClip("/race-end/we-won-01.mp3")).toBe(true);
  });

  it("plays second-place for P2 and podium-third for P3", () => {
    fire(snap({ position: 2 }));
    expect(hasClip("/race-end/second-place-01.mp3")).toBe(true);

    audio._played.length = 0;
    fire(snap({ position: 3 }));
    expect(hasClip("/race-end/podium-third-01.mp3")).toBe(true);
  });

  it("plays the composed result + position number for P4+", () => {
    fire(snap({ position: 7 }));

    expect(hasClip("/race-end/race-over-result-is-01.mp3")).toBe(true);
    expect(hasClip("/position-number/7.mp3")).toBe(true);
  });

  it("stays silent when the snapshot resolver returns null", () => {
    fire(null);

    expect(audio._played).toEqual([]);
  });
});

describe("per-voice clip availability (issue #835)", () => {
  it("skips the greeting for a voice lacking the picked name clip, playing the result", () => {
    activeVoice = BARE_VOICE;
    fire(snap({ position: 1, driverName: "niklas" }));

    expect(voicePaths().some((p) => p.includes("race-end-greeting"))).toBe(false);
    expect(hasClip("/race-end/we-won-01.mp3")).toBe(true);
  });

  it("still greets by name when the voice has the clip", () => {
    activeVoice = BARE_VOICE;
    fire(snap({ position: 1, driverName: "driver" }));

    expect(hasClip("/race-end-greeting/driver.mp3")).toBe(true);
  });

  it("skips the WHOLE callout for a voice missing a required clip (position numbers) — never a fragment", () => {
    activeVoice = PARTIAL_VOICE;
    fire(snap({ position: 7 }));

    expect(audio._played).toEqual([]);
  });
});

describe("race-end scripted delivery (issue #1065)", () => {
  it("reads the greeting then the result, in the script's order, inside the engine's radio frame", () => {
    fire(snap({ position: 7 }));

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/race-end-greeting/niklas.mp3`,
      `voice/${VOICE}/race-end/race-over-result-is-01.mp3`,
      `voice/${VOICE}/position-number/7.mp3`,
    ]);
    expect(audio._played[0]?.path).toBe("sfx/IRD-tick-open.mp3");
    expect(audio._played.at(-1)?.path).toBe("sfx/IRD-tick-close.mp3");
  });

  it("a multi-class class win takes the won branch on the class position (the #566 rule)", () => {
    fire(snap({ position: 15, classPosition: 1, isMultiClass: true }));

    expect(hasClip("/race-end/we-won-01.mp3")).toBe(true);
    expect(voicePaths().some((p) => p.includes("/position-number/"))).toBe(false);
  });

  it("a voice with no script plays no result at all — no line, no frame", () => {
    engine.setScripts(new Map([["titan", RACE_END_SCRIPT]]));
    fire(snap({ position: 1 }));

    expect(audio._played).toEqual([]);
  });
});

describe("buildRaceEndContract (issue #1065)", () => {
  it("carries no sequence and keeps every scheduling field verbatim, taking the engine's default frame", () => {
    const c = buildRaceEndContract(() => null);

    expect("sequence" in c).toBe(false);
    expect(c.id).toBe("pit-crew.race-end");
    expect([...RACE_END_SCENARIO_IDS]).toEqual([c.id]);
    expect(c.when?.event).toBe("race.finished");
    expect(c.channel).toBe(AudioChannel.Voice);
    expect(c.bus).toBe(AudioBus.Voice);
    expect(c.base).toBe("voice/{voice}");
    expect(c.weight).toBe(WEIGHT.CHATTER);
    expect(c.queueable).toBe(true);
    expect(c.family).toBe("race-end");
    expect(c.interrupt).toBeUndefined();
    expect(c.cooldown).toBeUndefined();
    expect(c.triggerDelay).toBeUndefined();
    expect(c.frame).toBeUndefined();
  });

  it("refuses to fire without a speakable effective position", () => {
    const answers = (snapshot: RaceFinishedSnapshot | null): boolean | undefined =>
      buildRaceEndContract(() => snapshot).when?.where?.({ event: "race.finished", data: {} } as never);

    expect(answers(null)).toBe(false);
    expect(answers(snap({ position: 0 }))).toBe(false);
    expect(answers(snap({ position: 3, classPosition: undefined, isMultiClass: true }))).toBe(false);
    expect(answers(snap({ position: 3 }))).toBe(true);
  });
});

describe("registerRaceEndVocabulary (issue #1065)", () => {
  it("publishes the six vars and the result case, each with a description for a pack author", () => {
    const { vars, cases } = engine.vocabulary();
    const ours = (name: string) => name.startsWith("raceEnd.");

    expect(vars.filter((v) => ours(v.name)).map((v) => v.name)).toEqual([
      "raceEnd.greeting",
      "raceEnd.podiumThird",
      "raceEnd.position",
      "raceEnd.raceOverResultIs",
      "raceEnd.secondPlace",
      "raceEnd.weWon",
    ]);
    expect(cases.filter((c) => ours(c.name)).map((c) => c.name)).toEqual(["raceEnd.result"]);

    for (const entry of [...vars, ...cases].filter((e) => ours(e.name))) {
      expect(entry.description.length, entry.name).toBeGreaterThan(0);
    }

    for (const [key, description] of Object.entries(cases.find((c) => c.name === "raceEnd.result")?.keys ?? {})) {
      expect(description.length, `raceEnd.result key ${key}`).toBeGreaterThan(0);
    }
  });

  it("declares exactly the keys the result resolver can return — enumerated over every position", () => {
    const declared = engine.vocabulary().cases.find((c) => c.name === "raceEnd.result")?.keys ?? {};
    const reachable = new Set<string>();

    for (let position = 1; position <= 64; position++) {
      for (const isMultiClass of [false, true]) {
        const key = resolveRaceEndResult(snap({ position, classPosition: position, isMultiClass }));

        expect(key).not.toBeNull();
        reachable.add(key ?? "");
      }
    }

    expect([...reachable].sort()).toEqual(Object.keys(declared).sort());
    expect(Object.keys(declared).sort()).toEqual(Object.keys(RACE_END_RESULT_KEYS).sort());
    expect(resolveRaceEndResult(snap({ position: 1 }))).toBe("won");
    expect(resolveRaceEndResult(snap({ position: 2 }))).toBe("second");
    expect(resolveRaceEndResult(snap({ position: 3 }))).toBe("third");
    expect(resolveRaceEndResult(snap({ position: 4 }))).toBe("other");
  });

  it("no snapshot, or no usable position, resolves to no key — the case's default branch, silence", () => {
    expect(resolveRaceEndResult(null)).toBeNull();
    expect(resolveRaceEndResult(snap({ position: 0 }))).toBeNull();
  });
});

describe("the bundled script's race-end entry (issue #1065)", () => {
  it("scripts the contract with a comment, a Race harness route and a sequence", () => {
    for (const id of RACE_END_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Scenario Shortcuts → Race → Race over — P1 \(we won!\)/);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("keeps the greeting optional (a whole clause) and the result a case over the declared keys, the number required", () => {
    expect(SCRIPT.scenarios["pit-crew.race-end"].sequence).toEqual([
      { optional: ["{{raceEnd.greeting}}"] },
      {
        case: "raceEnd.result",
        of: {
          won: ["{{raceEnd.weWon}}"],
          second: ["{{raceEnd.secondPlace}}"],
          third: ["{{raceEnd.podiumThird}}"],
          other: ["{{raceEnd.raceOverResultIs}}", "{{raceEnd.position}}"],
        },
      },
    ]);
  });

  it("references only vocabulary the race-end family registers, with the declared case keys, and no pool, frame, fragment or alias", () => {
    const refs = collectScriptReferences(RACE_END_SCRIPT);
    const vocabulary = engine.vocabulary();

    expect(refs.vars).toEqual([
      "raceEnd.greeting",
      "raceEnd.podiumThird",
      "raceEnd.position",
      "raceEnd.raceOverResultIs",
      "raceEnd.secondPlace",
      "raceEnd.weWon",
    ]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([{ name: "raceEnd.result", keys: Object.keys(RACE_END_RESULT_KEYS).sort() }]);
    expect(refs.pools).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(Object.keys(RACE_END_SCRIPT.pools ?? {})).toEqual([]);

    for (const v of refs.vars) expect(vocabulary.vars.map((x) => x.name)).toContain(v);

    for (const c of refs.cases) {
      const declared = vocabulary.cases.find((v) => v.name === c.name);

      expect(declared).toBeDefined();
      expect(Object.keys(declared?.keys ?? {}).sort()).toEqual([...c.keys].sort());
    }
  });

  it("publishes no direct clip source — every clip is a var's, and the bundled voice ships the groups the vars draw from", () => {
    expect(RACE_END_CLIP_SOURCES).toEqual([]);

    for (const clip of [
      "race-end-greeting/driver.mp3",
      "race-end/we-won-01.mp3",
      "race-end/second-place-01.mp3",
      "race-end/podium-third-01.mp3",
      "race-end/race-over-result-is-01.mp3",
      "position-number/4.mp3",
    ]) {
      expect(MANIFEST.clips, `no voice/${BUNDLED_VOICE}/${clip} in manifest.json`).toContain(
        `voice/${BUNDLED_VOICE}/${clip}`,
      );
    }
  });

  it("compiles for every test voice with nothing skipped — no unknown var, case key or fragment", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
