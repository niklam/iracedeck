/**
 * Opponent-flag tests (issue #936; scripted since #1065).
 *
 * Thirteen contracts fire off the single `opponentFlag.flagged` event and
 * branch on `relation` + `flag`: four penalty subjects (furled/black/
 * meatball/disqualify) × three per-car relations (ahead/behind/track-ahead),
 * plus the `others` aggregate. None carries a `family`: the lines describe
 * DIFFERENT cars, so same-family preemption (which cuts regardless of
 * `interrupt: false`) would truncate a burst of flag events mid-sentence —
 * they queue instead. `trigger` is deliberately ignored by every `where:`.
 * The `ahead` line's spoken number resolves from a module-scope stash
 * written by the firing `ahead` contract's own `where:` (the #922 shape),
 * live-read-preferred with the emit-time payload as fallback. What each line
 * says is the bundled script's, so the fire-through cases run the real
 * `callouts.json` narrowed to this family through the real engine.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, OpponentFlagRelation, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { OpponentPenaltyFlag } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { poolRef, WEIGHT } from "../../dsl.js";
import type { ScenarioContract } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import {
  _resetOpponentFlagPending,
  OPPONENT_FLAG_CALLOUT_SETTING_KEYS,
  OPPONENT_FLAG_CLIP_SOURCES,
  OPPONENT_FLAG_CONTRACTS,
  OPPONENT_FLAG_OTHERS_SCENARIO_ID,
  OPPONENT_FLAG_SCENARIO_IDS,
  OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID,
  type OpponentFlagCalloutId,
  type OpponentFlagPending,
  registerOpponentFlagVocabulary,
  SCENARIO_ID_TO_OPPONENT_FLAG_ID,
} from "./opponent-flags.js";

const SUBJECTS: readonly OpponentFlagCalloutId[] = ["furled", "black", "meatball", "disqualify"];
const RELATIONS: readonly OpponentFlagRelation[] = ["ahead", "behind", "track-ahead"];

const FLAG_OF: Record<OpponentFlagCalloutId, OpponentPenaltyFlag> = {
  furled: OpponentPenaltyFlag.Furled,
  black: OpponentPenaltyFlag.Black,
  meatball: OpponentPenaltyFlag.Repair,
  disqualify: OpponentPenaltyFlag.Disqualify,
};

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
    ...OPPONENT_FLAG_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
    `voice/${VOICE}/position-number/4.mp3`,
    `voice/${VOICE}/position-number/6.mp3`,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

const SCRIPT = defaultScript as CalloutScript;

/** The bundled script narrowed to this family's entries (F7-trap i). */
const OPPONENT_FLAG_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(OPPONENT_FLAG_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;
let livePosition: number | null;
let liveReads: OpponentFlagPending[];

function contract(id: string): ScenarioContract {
  const c = OPPONENT_FLAG_CONTRACTS.find((x) => x.id === id);

  if (!c) throw new Error(`contract not found: ${id}`);

  return c;
}

function flagged(
  relation: OpponentFlagRelation,
  flag: OpponentPenaltyFlag | undefined,
  overrides: Partial<SimEventOf<"opponentFlag.flagged">["data"]> = {},
): SimEventOf<"opponentFlag.flagged"> {
  return {
    event: "opponentFlag.flagged",
    timestamp: 0,
    telemetry: null,
    data:
      relation === "others"
        ? { relation, ...overrides }
        : { relation, carIdx: 7, flag, trigger: "raised", position: 4, ...overrides },
  };
}

function fire(
  relation: OpponentFlagRelation,
  flag: OpponentPenaltyFlag | undefined,
  overrides: Partial<SimEventOf<"opponentFlag.flagged">["data"]> = {},
): void {
  bus.publishEvent("opponentFlag.flagged", flagged(relation, flag, overrides).data);
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
  _resetOpponentFlagPending();
  livePosition = null;
  liveReads = [];
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  // The production order (`registerPitCrew`): vocabulary, contracts, script.
  // The family is registered ALONE, so only its own compile diagnostics appear.
  registerOpponentFlagVocabulary(engine, (pending) => {
    liveReads.push(pending);

    return livePosition;
  });

  for (const c of OPPONENT_FLAG_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map([[VOICE, OPPONENT_FLAG_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
});

describe("OPPONENT_FLAG_CONTRACTS", () => {
  it("exports thirteen contract ids — subject × relation in registration order, then the aggregate", () => {
    expect(OPPONENT_FLAG_SCENARIO_IDS).toEqual([
      ...SUBJECTS.flatMap((subject) => RELATIONS.map((relation) => `pit-crew.opponent-flag-${subject}-${relation}`)),
      "pit-crew.opponent-flag-others",
    ]);
  });

  it("carries no sequence — what each line says is the voice script's", () => {
    for (const c of OPPONENT_FLAG_CONTRACTS) expect("sequence" in c).toBe(false);
  });

  it("carries no family — different cars queue, they never preempt each other", () => {
    for (const c of OPPONENT_FLAG_CONTRACTS) {
      expect(c.family).toBeUndefined();
    }
  });

  it("never interrupts but stays queueable, weighted by relation, and takes the engine's default frame", () => {
    for (const c of OPPONENT_FLAG_CONTRACTS) {
      expect(c.when?.event).toBe("opponentFlag.flagged");
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.interrupt).toBe(false);
      expect(c.queueable).toBe(true);
      expect(c.frame).toBeUndefined();

      if (c.id.endsWith("-track-ahead")) {
        expect(c.weight).toBe(WEIGHT.SAFETY);
      } else {
        expect(c.weight).toBe(WEIGHT.NORMAL);
      }
    }
  });

  it("routes on relation + flag — a subject's line fires only for its own subject and relation", () => {
    for (const relation of RELATIONS) {
      for (const subject of SUBJECTS) {
        const id = `pit-crew.opponent-flag-${subject}-${relation}`;
        const ev = flagged(relation, FLAG_OF[subject]);

        expect(contract(id).when?.where?.(ev)).toBe(true);

        for (const otherSubject of SUBJECTS) {
          if (otherSubject === subject) continue;

          expect(contract(`pit-crew.opponent-flag-${otherSubject}-${relation}`).when?.where?.(ev)).toBe(false);
        }

        for (const otherRelation of RELATIONS) {
          if (otherRelation === relation) continue;

          expect(contract(`pit-crew.opponent-flag-${subject}-${otherRelation}`).when?.where?.(ev)).toBe(false);
        }
      }
    }
  });

  it("the aggregate fires only for the others relation, regardless of subject contracts", () => {
    const where = contract("pit-crew.opponent-flag-others").when?.where;

    expect(where?.(flagged("others", undefined))).toBe(true);

    for (const relation of RELATIONS) {
      expect(where?.(flagged(relation, OpponentPenaltyFlag.Black))).toBe(false);
    }
  });

  it("ignores the trigger field — both raised and entered-range pass", () => {
    for (const trigger of ["raised", "entered-range"] as const) {
      expect(
        contract("pit-crew.opponent-flag-black-behind").when?.where?.(
          flagged("behind", OpponentPenaltyFlag.Black, { trigger }),
        ),
      ).toBe(true);
      expect(
        contract("pit-crew.opponent-flag-black-track-ahead").when?.where?.(
          flagged("track-ahead", OpponentPenaltyFlag.Black, { trigger }),
        ),
      ).toBe(true);
    }
  });

  it("ahead rejects events without a usable car or position", () => {
    const where = contract("pit-crew.opponent-flag-black-ahead").when?.where;

    expect(where?.(flagged("ahead", OpponentPenaltyFlag.Black, { carIdx: undefined }))).toBe(false);
    expect(where?.(flagged("ahead", OpponentPenaltyFlag.Black, { position: undefined }))).toBe(false);
    expect(where?.(flagged("ahead", OpponentPenaltyFlag.Black, { position: 0 }))).toBe(false);
    // Non-integer / negative values would build clip lookups with no clip
    // behind them (`position-number/4.5`) — reject them outright.
    expect(where?.(flagged("ahead", OpponentPenaltyFlag.Black, { carIdx: -1 }))).toBe(false);
    expect(where?.(flagged("ahead", OpponentPenaltyFlag.Black, { carIdx: 6.5 }))).toBe(false);
    expect(where?.(flagged("ahead", OpponentPenaltyFlag.Black, { position: 4.5 }))).toBe(false);
  });
});

describe("the opponent-flag lines through the real script", () => {
  it.each(SUBJECTS)("%s behind plays its single line inside the radio frame", (subject) => {
    fire("behind", FLAG_OF[subject]);

    expect(voicePaths()).toEqual([`voice/${VOICE}/opponent-flags/${subject}-behind-01.mp3`]);
    expect(audio._played.map((p) => p.path)).toContain("sfx/IRD-tick-open.mp3");
  });

  it.each(SUBJECTS)("%s track-ahead plays its single line", (subject) => {
    fire("track-ahead", FLAG_OF[subject]);

    expect(voicePaths()).toEqual([`voice/${VOICE}/opponent-flags/${subject}-track-01.mp3`]);
  });

  it.each(SUBJECTS)(
    "%s ahead composes the opponent-pit car-in lead-in + the number + the subject's tail, the number from the payload when no live read is wired",
    (subject) => {
      fire("ahead", FLAG_OF[subject], { position: 4 });

      expect(voicePaths()).toEqual([
        `voice/${VOICE}/opponent-pit/car-in-01.mp3`,
        `voice/${VOICE}/position-number/4.mp3`,
        `voice/${VOICE}/opponent-flags/${subject}-ahead-tail-01.mp3`,
      ]);
    },
  );

  it("the aggregate plays its single line", () => {
    fire("others", undefined);

    expect(voicePaths()).toEqual([`voice/${VOICE}/opponent-flags/others-01.mp3`]);
  });

  it("ahead speaks the LIVE position when the resolver answers, in the stashed projection", () => {
    livePosition = 6;
    fire("ahead", OpponentPenaltyFlag.Black, { carIdx: 12, position: 4, isMultiClass: true });

    expect(voicePaths()).toContain(`voice/${VOICE}/position-number/6.mp3`);
    expect(voicePaths()).not.toContain(`voice/${VOICE}/position-number/4.mp3`);
    expect(liveReads).toEqual([{ carIdx: 12, position: 4, isMultiClass: true }]);
  });

  it("ahead stays silent as a whole when the number has no clip — never car-in with a gap (issue #835)", () => {
    fire("ahead", OpponentPenaltyFlag.Black, { position: 9 });

    expect(voicePaths()).toEqual([]);
  });
});

describe("registerOpponentFlagVocabulary + the pending stash", () => {
  it("resolves the number from the stash payload when no live read is wired", () => {
    const { engine: stub, vars } = makeVarEngine();

    registerOpponentFlagVocabulary(stub);

    const resolve = vars.get("opponentFlag.number");

    expect(resolve).toBeDefined();
    // No stash yet — an ahead fire hasn't passed its where: → abort (#835).
    expect(resolve!()).toBeNull();

    contract("pit-crew.opponent-flag-black-ahead").when?.where?.(
      flagged("ahead", OpponentPenaltyFlag.Black, { position: 4 }),
    );
    expect(resolve!()).toEqual(poolRef("position-number", "4"));
  });

  it("prefers the live read and hands it the stashed projection context", () => {
    const { engine: stub, vars } = makeVarEngine();
    const seen: OpponentFlagPending[] = [];

    registerOpponentFlagVocabulary(stub, (pending) => {
      seen.push(pending);

      return 6;
    });

    contract("pit-crew.opponent-flag-black-ahead").when?.where?.(
      flagged("ahead", OpponentPenaltyFlag.Black, { carIdx: 12, position: 4, isMultiClass: true }),
    );

    expect(vars.get("opponentFlag.number")!()).toEqual(poolRef("position-number", "6"));
    expect(seen).toEqual([{ carIdx: 12, position: 4, isMultiClass: true }]);
  });

  it("falls back to the payload position when the live read returns null", () => {
    const { engine: stub, vars } = makeVarEngine();

    registerOpponentFlagVocabulary(stub, () => null);

    contract("pit-crew.opponent-flag-black-ahead").when?.where?.(
      flagged("ahead", OpponentPenaltyFlag.Black, { position: 4 }),
    );
    expect(vars.get("opponentFlag.number")!()).toEqual(poolRef("position-number", "4"));
  });

  it("an event that fails its own contract's gates never clobbers the stash (#922 shape)", () => {
    const { engine: stub, vars } = makeVarEngine();

    registerOpponentFlagVocabulary(stub);

    contract("pit-crew.opponent-flag-black-ahead").when?.where?.(
      flagged("ahead", OpponentPenaltyFlag.Black, { carIdx: 12, position: 4 }),
    );

    // An invalid furled-ahead event — its own contract's validity check
    // rejects it (no carIdx) before ever reaching the stash write — must
    // not repoint what the deferred black-ahead line speaks.
    contract("pit-crew.opponent-flag-furled-ahead").when?.where?.(
      flagged("ahead", OpponentPenaltyFlag.Furled, { carIdx: undefined, position: 1 }),
    );
    // Nor does a behind event for the same subject — its where: never
    // touches the ahead stash at all.
    contract("pit-crew.opponent-flag-black-behind").when?.where?.(
      flagged("behind", OpponentPenaltyFlag.Black, { carIdx: 3, position: 9 }),
    );

    expect(vars.get("opponentFlag.number")!()).toEqual(poolRef("position-number", "4"));
  });

  it("publishes the number var with a description naming the position-number group, and nothing else", () => {
    const { vars, conds, cases } = engine.vocabulary();
    const number = vars.find((v) => v.name === "opponentFlag.number");

    expect(number).toBeDefined();
    expect(number?.description).toContain("position-number");
    expect(vars.filter((v) => v.name.startsWith("opponentFlag."))).toHaveLength(1);
    expect(conds.filter((c) => c.name.startsWith("opponentFlag."))).toEqual([]);
    expect(cases.filter((c) => c.name.startsWith("opponentFlag."))).toEqual([]);
  });
});

describe("the bundled script's opponent-flag entries (issue #1065)", () => {
  it("scripts every contract with a comment, an Opponent Flags harness route and a sequence", () => {
    for (const id of OPPONENT_FLAG_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Opponent Flags → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("every ahead entry splices the number var between the opponent-pit car-in lead-in and its subject tail, as a required step", () => {
    for (const subject of SUBJECTS) {
      expect(SCRIPT.scenarios[`pit-crew.opponent-flag-${subject}-ahead`].sequence, subject).toEqual([
        "pool:opponent-pit/car-in",
        "{{opponentFlag.number}}",
        `pool:opponent-flags/${subject}-ahead-tail`,
      ]);
    }
  });

  it("references only the var this family registers, no condition, case, fragment or frame", () => {
    const refs = collectScriptReferences(OPPONENT_FLAG_SCRIPT);

    expect(refs.vars).toEqual(["opponentFlag.number"]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(engine.vocabulary().vars.map((v) => v.name)).toContain("opponentFlag.number");
  });

  it("addresses exactly the published clip sources — the slashed form throughout, the car-in lead-in from opponent-pit — and every one has a clip in the bundled voice", () => {
    const sources = [
      "opponent-flags/black-ahead-tail",
      "opponent-flags/black-behind",
      "opponent-flags/black-track",
      "opponent-flags/disqualify-ahead-tail",
      "opponent-flags/disqualify-behind",
      "opponent-flags/disqualify-track",
      "opponent-flags/furled-ahead-tail",
      "opponent-flags/furled-behind",
      "opponent-flags/furled-track",
      "opponent-flags/meatball-ahead-tail",
      "opponent-flags/meatball-behind",
      "opponent-flags/meatball-track",
      "opponent-flags/others",
      "opponent-pit/car-in",
    ];

    expect([...collectScriptReferences(OPPONENT_FLAG_SCRIPT).pools].sort()).toEqual(sources);
    expect(OPPONENT_FLAG_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);

    for (const { group, base } of OPPONENT_FLAG_CLIP_SOURCES) {
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
  it("maps every subject-relation contract to its subject; the aggregate is deliberately unmapped (master-gated only)", () => {
    for (const subject of SUBJECTS) {
      for (const relation of RELATIONS) {
        expect(SCENARIO_ID_TO_OPPONENT_FLAG_ID[`pit-crew.opponent-flag-${subject}-${relation}`]).toBe(subject);
      }
    }

    // The translator diff enforces the per-flag opt-ins before anything can
    // feed the aggregation, so the aggregate only ever describes enabled
    // flags — mapping it to one subject's toggle (the earlier others →
    // black ride-along) let a disabled Black silence an aggregate built
    // from ENABLED subjects (#936 review).
    expect(SCENARIO_ID_TO_OPPONENT_FLAG_ID[OPPONENT_FLAG_OTHERS_SCENARIO_ID]).toBeUndefined();
  });

  it("maps every contract id except the aggregate (which registers without the per-flag opt-in wrapper)", () => {
    for (const id of OPPONENT_FLAG_SCENARIO_IDS) {
      if (id === OPPONENT_FLAG_OTHERS_SCENARIO_ID) continue;

      expect(SCENARIO_ID_TO_OPPONENT_FLAG_ID[id]).toBeDefined();
    }
  });

  it("maps every bus enum value to its callout id (the translator-side opt-in resolver's table)", () => {
    expect(OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID).toEqual({
      furled: "furled",
      black: "black",
      repair: "meatball",
      disqualify: "disqualify",
    });
  });

  it("exposes the canonical setting keys", () => {
    expect(OPPONENT_FLAG_CALLOUT_SETTING_KEYS).toEqual({
      furled: "calloutEnabledOpponentFlagFurled",
      black: "calloutEnabledOpponentFlagBlack",
      meatball: "calloutEnabledOpponentFlagMeatball",
      disqualify: "calloutEnabledOpponentFlagDisqualify",
    });
  });
});
