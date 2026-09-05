/**
 * Opponent-pit tests (issue #622; scripted since #1065).
 *
 * Five contracts fire off the single `opponentPit.entered` event and branch on
 * `relation`. None carries a `family`: the lines describe DIFFERENT cars, so
 * same-family preemption (which cuts regardless of `interrupt: false`) would
 * truncate a pit train's lines mid-sentence — they queue instead. The nearby
 * line's spoken number resolves from a module-scope stash written by the
 * nearby contract's own `where:` (the #922 shape), live-read-preferred with
 * the emit-time payload as fallback. What each line says is the bundled
 * script's, so the fire-through cases run the real `callouts.json` narrowed
 * to this family through the real engine.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, OpponentPitRelation, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { poolRef } from "../../dsl.js";
import type { ScenarioContract } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import {
  _resetOpponentPitPending,
  OPPONENT_PIT_CALLOUT_SETTING_KEYS,
  OPPONENT_PIT_CLIP_SOURCES,
  OPPONENT_PIT_CONTRACTS,
  OPPONENT_PIT_SCENARIO_IDS,
  type OpponentPitPending,
  registerOpponentPitVocabulary,
  SCENARIO_ID_TO_OPPONENT_PIT_ID,
} from "./opponent-pit.js";

const ALL_RELATIONS: readonly OpponentPitRelation[] = ["leader", "ahead", "behind", "nearby", "others"];

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
      for (const handler of Array.from(handlers.get(event.event as SimEventName) ?? [])) handler(event);
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

function flush(audio: FakeAudio, iterations = 20): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const VOICE = "luca";

/** One variant per line so pool draws are deterministic, plus two numbers. */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...OPPONENT_PIT_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
    `voice/${VOICE}/position-number/4.mp3`,
    `voice/${VOICE}/position-number/6.mp3`,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

const SCRIPT = defaultScript as CalloutScript;

/** The bundled script narrowed to this family's entries (F7-trap i). */
const OPPONENT_PIT_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(OPPONENT_PIT_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;
let livePosition: number | null;
let liveReads: OpponentPitPending[];

function contract(id: string): ScenarioContract {
  const c = OPPONENT_PIT_CONTRACTS.find((x) => x.id === id);

  if (!c) throw new Error(`contract not found: ${id}`);

  return c;
}

function entered(
  relation: OpponentPitRelation,
  overrides: Partial<SimEventOf<"opponentPit.entered">["data"]> = {},
): SimEventOf<"opponentPit.entered"> {
  return {
    event: "opponentPit.entered",
    timestamp: 0,
    telemetry: null,
    data: relation === "others" ? { relation, ...overrides } : { relation, carIdx: 7, position: 4, ...overrides },
  };
}

function fire(relation: OpponentPitRelation, overrides: Partial<SimEventOf<"opponentPit.entered">["data"]> = {}): void {
  bus.publishEvent("opponentPit.entered", entered(relation, overrides).data);
  flush(audio);
}

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function makeVarEngine(): { engine: IScenarioEngine; vars: Map<string, () => unknown> } {
  const vars = new Map<string, () => unknown>();
  const stub = {
    defineVar: vi.fn((name: string, fn: () => unknown) => vars.set(name, fn)),
  } as unknown as IScenarioEngine;

  return { engine: stub, vars };
}

beforeEach(() => {
  _resetOpponentPitPending();
  livePosition = null;
  liveReads = [];
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  // The production order (`registerPitCrew`): vocabulary, contracts, script.
  // The family is registered ALONE, so only its own compile diagnostics appear.
  registerOpponentPitVocabulary(engine, (pending) => {
    liveReads.push(pending);

    return livePosition;
  });

  for (const c of OPPONENT_PIT_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map([[VOICE, OPPONENT_PIT_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
});

describe("OPPONENT_PIT_CONTRACTS", () => {
  it("exports the five contract ids in registration order", () => {
    expect(OPPONENT_PIT_SCENARIO_IDS).toEqual([
      "pit-crew.opponent-pit-leader",
      "pit-crew.opponent-pit-ahead",
      "pit-crew.opponent-pit-behind",
      "pit-crew.opponent-pit-nearby",
      "pit-crew.opponent-pit-others",
    ]);
  });

  it("carries no sequence — what each line says is the voice script's", () => {
    for (const c of OPPONENT_PIT_CONTRACTS) expect("sequence" in c).toBe(false);
  });

  it("carries no family — different cars queue, they never preempt each other", () => {
    for (const c of OPPONENT_PIT_CONTRACTS) {
      expect(c.family).toBeUndefined();
    }
  });

  it("never interrupts but stays queueable, weighted between normal and flags, and takes the engine's default frame", () => {
    for (const c of OPPONENT_PIT_CONTRACTS) {
      expect(c.when?.event).toBe("opponentPit.entered");
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.interrupt).toBe(false);
      expect(c.queueable).toBe(true);
      expect(c.weight).toBe(65);
      expect(c.frame).toBeUndefined();
    }
  });

  it("each contract fires only on its own relation", () => {
    for (const c of OPPONENT_PIT_CONTRACTS) {
      const own = c.id.replace("pit-crew.opponent-pit-", "") as OpponentPitRelation;

      for (const relation of ALL_RELATIONS) {
        expect(c.when?.where?.(entered(relation))).toBe(relation === own);
      }
    }
  });

  it("nearby rejects events without a usable car or position", () => {
    const where = contract("pit-crew.opponent-pit-nearby").when?.where;

    expect(where?.(entered("nearby", { carIdx: undefined }))).toBe(false);
    expect(where?.(entered("nearby", { position: undefined }))).toBe(false);
    expect(where?.(entered("nearby", { position: 0 }))).toBe(false);
    // Non-integer / negative values would build clip lookups with no clip
    // behind them (`position-number/4.5`) — reject them outright.
    expect(where?.(entered("nearby", { carIdx: -1 }))).toBe(false);
    expect(where?.(entered("nearby", { carIdx: 6.5 }))).toBe(false);
    expect(where?.(entered("nearby", { position: 4.5 }))).toBe(false);
  });
});

describe("the opponent-pit lines through the real script", () => {
  it.each([
    ["leader", "leader"],
    ["ahead", "ahead"],
    ["behind", "behind"],
    ["others", "others"],
  ] as const)("%s plays its single line inside the radio frame", (relation, base) => {
    fire(relation);

    expect(voicePaths()).toEqual([`voice/${VOICE}/opponent-pit/${base}-01.mp3`]);
    expect(audio._played.map((p) => p.path)).toContain("sfx/IRD-tick-open.mp3");
  });

  it("nearby composes car-in + the number + is-pitting, the number from the payload when no live read is wired", () => {
    fire("nearby", { position: 4 });

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/opponent-pit/car-in-01.mp3`,
      `voice/${VOICE}/position-number/4.mp3`,
      `voice/${VOICE}/opponent-pit/is-pitting-01.mp3`,
    ]);
  });

  it("nearby speaks the LIVE position when the resolver answers, in the stashed projection", () => {
    livePosition = 6;
    fire("nearby", { carIdx: 12, position: 4, isMultiClass: true });

    expect(voicePaths()).toContain(`voice/${VOICE}/position-number/6.mp3`);
    expect(voicePaths()).not.toContain(`voice/${VOICE}/position-number/4.mp3`);
    expect(liveReads).toEqual([{ carIdx: 12, position: 4, isMultiClass: true }]);
  });

  it("nearby stays silent as a whole when the number has no clip — never car-in with a gap (issue #835)", () => {
    fire("nearby", { position: 9 });

    expect(voicePaths()).toEqual([]);
  });

  it("a relation's line does not fire for another relation's event", () => {
    fire("leader");

    expect(voicePaths().some((p) => p.includes("/opponent-pit/ahead-"))).toBe(false);
    expect(voicePaths().some((p) => p.includes("/opponent-pit/car-in-"))).toBe(false);
  });
});

describe("registerOpponentPitVocabulary + the pending stash", () => {
  it("resolves the number from the stash payload when no live read is wired", () => {
    const { engine: stub, vars } = makeVarEngine();

    registerOpponentPitVocabulary(stub);

    const resolve = vars.get("opponentPit.number");

    expect(resolve).toBeDefined();
    // No stash yet — a nearby fire hasn't passed its where: → abort (#835).
    expect(resolve!()).toBeNull();

    contract("pit-crew.opponent-pit-nearby").when?.where?.(entered("nearby", { position: 4 }));
    expect(resolve!()).toEqual(poolRef("position-number", "4"));
  });

  it("prefers the live read and hands it the stashed projection context", () => {
    const { engine: stub, vars } = makeVarEngine();
    const seen: OpponentPitPending[] = [];

    registerOpponentPitVocabulary(stub, (pending) => {
      seen.push(pending);

      return 6;
    });

    contract("pit-crew.opponent-pit-nearby").when?.where?.(
      entered("nearby", { carIdx: 12, position: 4, isMultiClass: true }),
    );

    expect(vars.get("opponentPit.number")!()).toEqual(poolRef("position-number", "6"));
    expect(seen).toEqual([{ carIdx: 12, position: 4, isMultiClass: true }]);
  });

  it("falls back to the payload position when the live read returns null", () => {
    const { engine: stub, vars } = makeVarEngine();

    registerOpponentPitVocabulary(stub, () => null);

    contract("pit-crew.opponent-pit-nearby").when?.where?.(entered("nearby", { position: 4 }));
    expect(vars.get("opponentPit.number")!()).toEqual(poolRef("position-number", "4"));
  });

  it("ignores non-nearby events — they never repoint the stash (#922 shape)", () => {
    const { engine: stub, vars } = makeVarEngine();

    registerOpponentPitVocabulary(stub);

    contract("pit-crew.opponent-pit-nearby").when?.where?.(entered("nearby", { carIdx: 12, position: 4 }));
    // A later leader event (its own contract may even be opt-in-suppressed)
    // must not overwrite what the deferred nearby line speaks.
    contract("pit-crew.opponent-pit-leader").when?.where?.(entered("leader", { carIdx: 2, position: 1 }));

    expect(vars.get("opponentPit.number")!()).toEqual(poolRef("position-number", "4"));
  });

  it("publishes the number var with a description naming the position-number group, and nothing else", () => {
    const { vars, conds, cases } = engine.vocabulary();
    const number = vars.find((v) => v.name === "opponentPit.number");

    expect(number).toBeDefined();
    expect(number?.description).toContain("position-number");
    expect(vars.filter((v) => v.name.startsWith("opponentPit."))).toHaveLength(1);
    expect(conds.filter((c) => c.name.startsWith("opponentPit."))).toEqual([]);
    expect(cases.filter((c) => c.name.startsWith("opponentPit."))).toEqual([]);
  });
});

describe("the bundled script's opponent-pit entries (issue #1065)", () => {
  it("scripts every contract with a comment, an Opponent Pit harness route and a sequence", () => {
    for (const id of OPPONENT_PIT_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Opponent Pit → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("the nearby entry splices the number var between car-in and is-pitting as a required step, never optional", () => {
    expect(SCRIPT.scenarios["pit-crew.opponent-pit-nearby"].sequence).toEqual([
      "pool:opponent-pit/car-in",
      "{{opponentPit.number}}",
      "pool:opponent-pit/is-pitting",
    ]);
  });

  it("references only the var this family registers, no condition, case, fragment or frame", () => {
    const refs = collectScriptReferences(OPPONENT_PIT_SCRIPT);

    expect(refs.vars).toEqual(["opponentPit.number"]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(engine.vocabulary().vars.map((v) => v.name)).toContain("opponentPit.number");
  });

  it("addresses exactly the published clip sources — the slashed form throughout — and every one has a clip in the bundled voice", () => {
    const sources = [
      "opponent-pit/ahead",
      "opponent-pit/behind",
      "opponent-pit/car-in",
      "opponent-pit/is-pitting",
      "opponent-pit/leader",
      "opponent-pit/others",
    ];

    expect([...collectScriptReferences(OPPONENT_PIT_SCRIPT).pools].sort()).toEqual(sources);
    expect(OPPONENT_PIT_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);

    for (const { group, base } of OPPONENT_PIT_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `no voice/${BUNDLED_VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
    }
  });

  it("compiles for the test voice with nothing skipped", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe("family wiring", () => {
  it("maps leader to the leader opt-in and everything else to nearby", () => {
    expect(SCENARIO_ID_TO_OPPONENT_PIT_ID["pit-crew.opponent-pit-leader"]).toBe("leader");

    for (const id of OPPONENT_PIT_SCENARIO_IDS.filter((x) => x !== "pit-crew.opponent-pit-leader")) {
      expect(SCENARIO_ID_TO_OPPONENT_PIT_ID[id]).toBe("nearby");
    }
  });

  it("exposes the canonical setting keys", () => {
    expect(OPPONENT_PIT_CALLOUT_SETTING_KEYS).toEqual({
      leader: "calloutEnabledOpponentPitLeader",
      nearby: "calloutEnabledOpponentPitNearby",
    });
  });
});
