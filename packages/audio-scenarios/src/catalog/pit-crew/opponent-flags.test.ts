/**
 * Opponent-flag tests (issue #936; scripted since #1065; reworked for #1274).
 *
 * Nine contracts fire off the single `opponentFlag.flagged` event and branch
 * on `relation` + `flag`: four penalty subjects (furled/black/meatball/
 * disqualify) × two per-car relations (ahead/behind), plus the `others`
 * aggregate — the #936 `track-ahead` contracts are gone. None carries a
 * `family`: the lines describe DIFFERENT cars, so same-family preemption
 * (which cuts regardless of `interrupt: false`) would truncate a burst of
 * flag events mid-sentence — they queue instead. Every line is normal
 * weight, and `trigger` is deliberately ignored by every `where:`.
 *
 * The lines name the car with the `opponentFlag.carNumber` var, read from the
 * fire's own event; a car with no number, or a number the voice has no clip
 * for, skips the whole line. The 3.3.0 position var `opponentFlag.number`
 * stays defined for packs scripted against it. What each line says is the
 * bundled script's, so the fire-through cases run the real `callouts.json`
 * narrowed to this family through the real engine.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, OpponentFlagRelation, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { OpponentPenaltyFlag } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { poolRef, WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import {
  OPPONENT_FLAG_CLIP_SOURCES,
  OPPONENT_FLAG_CONTRACTS,
  OPPONENT_FLAG_OTHERS_SCENARIO_ID,
  OPPONENT_FLAG_SCENARIO_IDS,
  OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID,
  type OpponentFlagCalloutId,
  type OpponentFlagPending,
  registerOpponentFlagVocabulary,
  resolveOpponentFlagCarNumber,
  SCENARIO_ID_TO_OPPONENT_FLAG_ID,
} from "./opponent-flags.js";

const SUBJECTS: readonly OpponentFlagCalloutId[] = ["furled", "black", "meatball", "disqualify"];
const RELATIONS = ["ahead", "behind"] as const satisfies readonly OpponentFlagRelation[];

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

/**
 * One variant per line so pool draws are deterministic, a few car numbers
 * (`09` but deliberately no `9`, so the two spellings are told apart), two
 * positions, and the opponent-pit `car-in` lead-in a 3.3.0 pack's ahead lines
 * borrowed.
 */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...OPPONENT_FLAG_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
    `voice/${VOICE}/car-number/42.mp3`,
    `voice/${VOICE}/car-number/09.mp3`,
    `voice/${VOICE}/position-number/4.mp3`,
    `voice/${VOICE}/position-number/6.mp3`,
    `voice/${VOICE}/opponent-pit/car-in-01.mp3`,
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

type FlaggedData = SimEventOf<"opponentFlag.flagged">["data"];

function flagged(
  relation: OpponentFlagRelation,
  flag: OpponentPenaltyFlag | undefined,
  overrides: Partial<FlaggedData> = {},
): SimEventOf<"opponentFlag.flagged"> {
  return {
    event: "opponentFlag.flagged",
    timestamp: 0,
    telemetry: null,
    data:
      relation === "others"
        ? { relation, ...overrides }
        : { relation, carIdx: 7, flag, trigger: "raised", position: 4, carNumber: "42", gapSeconds: 1.5, ...overrides },
  };
}

function fire(
  relation: OpponentFlagRelation,
  flag: OpponentPenaltyFlag | undefined,
  overrides: Partial<FlaggedData> = {},
): void {
  bus.publishEvent("opponentFlag.flagged", flagged(relation, flag, overrides).data);
  flush(audio);
}

/** A resolver context for a fire of `event` — what the engine hands a var at expansion. */
function ctxOf(event: SimEventOf<SimEventName> | null): ScenarioContext {
  return { event, telemetry: null, data: event?.data ?? null, now: 0, vars: {} };
}

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function makeVarEngine(): { engine: IScenarioEngine; vars: Map<string, (ctx: ScenarioContext) => string | null> } {
  const vars = new Map<string, (ctx: ScenarioContext) => string | null>();
  const stub = {
    defineVar: vi.fn((name: string, fn: (ctx: ScenarioContext) => string | null) => vars.set(name, fn)),
  } as unknown as IScenarioEngine;

  return { engine: stub, vars };
}

/** The bundled script with this family's entries replaced — a third-party pack's shape. */
function packScript(scenarios: CalloutScript["scenarios"]): CalloutScript {
  return { ...SCRIPT, scenarios, fragments: {} };
}

beforeEach(() => {
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
  it("exports nine contract ids — subject × ahead/behind in registration order, then the aggregate", () => {
    expect(OPPONENT_FLAG_SCENARIO_IDS).toEqual([
      ...SUBJECTS.flatMap((subject) => RELATIONS.map((relation) => `pit-crew.opponent-flag-${subject}-${relation}`)),
      "pit-crew.opponent-flag-others",
    ]);
  });

  it("has no track-ahead contract left (#1274)", () => {
    expect(OPPONENT_FLAG_SCENARIO_IDS.filter((id) => id.includes("track-ahead"))).toEqual([]);
    expect(Object.keys(SCENARIO_ID_TO_OPPONENT_FLAG_ID).filter((id) => id.includes("track-ahead"))).toEqual([]);
  });

  it("carries no sequence — what each line says is the voice script's", () => {
    for (const c of OPPONENT_FLAG_CONTRACTS) expect("sequence" in c).toBe(false);
  });

  it("carries no family — different cars queue, they never preempt each other", () => {
    for (const c of OPPONENT_FLAG_CONTRACTS) {
      expect(c.family).toBeUndefined();
    }
  });

  it("never interrupts but stays queueable, every line at normal weight, and takes the engine's default frame", () => {
    for (const c of OPPONENT_FLAG_CONTRACTS) {
      expect(c.when?.event).toBe("opponentFlag.flagged");
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.interrupt).toBe(false);
      expect(c.queueable).toBe(true);
      expect(c.frame).toBeUndefined();
      expect(c.weight, c.id).toBe(WEIGHT.NORMAL);
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

  it("an event still carrying the retired track-ahead relation matches no contract", () => {
    const ev = flagged("track-ahead" as never, OpponentPenaltyFlag.Black);

    for (const c of OPPONENT_FLAG_CONTRACTS) expect(c.when?.where?.(ev), c.id).toBe(false);
  });

  it("ignores the trigger field — both raised and entered-range pass", () => {
    for (const relation of RELATIONS) {
      for (const trigger of ["raised", "entered-range"] as const) {
        expect(
          contract(`pit-crew.opponent-flag-black-${relation}`).when?.where?.(
            flagged(relation, OpponentPenaltyFlag.Black, { trigger }),
          ),
        ).toBe(true);
      }
    }
  });

  it("still fires for a car with no number or no usable position — the line's vars decide what it can say", () => {
    for (const relation of RELATIONS) {
      const where = contract(`pit-crew.opponent-flag-black-${relation}`).when?.where;

      expect(where?.(flagged(relation, OpponentPenaltyFlag.Black, { carNumber: undefined }))).toBe(true);
      expect(where?.(flagged(relation, OpponentPenaltyFlag.Black, { position: undefined }))).toBe(true);
      expect(where?.(flagged(relation, OpponentPenaltyFlag.Black, { carIdx: undefined }))).toBe(true);
    }
  });
});

describe("the opponent-flag lines through the real script", () => {
  it.each(SUBJECTS.flatMap((subject) => RELATIONS.map((relation) => [subject, relation] as const)))(
    "%s %s names the car by number, then the relation's tail, inside the radio frame",
    (subject, relation) => {
      fire(relation, FLAG_OF[subject], { carNumber: "42" });

      expect(voicePaths()).toEqual([
        `voice/${VOICE}/car-number/42.mp3`,
        `voice/${VOICE}/opponent-flags/${subject}-${relation}-tail-01.mp3`,
      ]);
      expect(audio._played.map((p) => p.path)).toContain("sfx/IRD-tick-open.mp3");
    },
  );

  it("speaks the number exactly as the session spells it — 09 is not 9", () => {
    fire("ahead", OpponentPenaltyFlag.Black, { carNumber: "09" });

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/car-number/09.mp3`,
      `voice/${VOICE}/opponent-flags/black-ahead-tail-01.mp3`,
    ]);
  });

  it.each(RELATIONS)(
    "%s stays silent as a whole when the car has no number — never the tail with a gap (issue #835)",
    (relation) => {
      fire(relation, OpponentPenaltyFlag.Black, { carNumber: undefined });

      expect(audio._played).toEqual([]);
    },
  );

  it.each([
    ["9", "a spelling the voice has no clip for"],
    ["07a", "a number the voice cannot say"],
  ])("stays silent as a whole for car %s — %s", (carNumber) => {
    for (const relation of RELATIONS) {
      // The contract does fire — the line dies at expansion, not at `where:`.
      expect(
        contract(`pit-crew.opponent-flag-meatball-${relation}`).when?.where?.(
          flagged(relation, OpponentPenaltyFlag.Repair, { carNumber }),
        ),
      ).toBe(true);

      fire(relation, OpponentPenaltyFlag.Repair, { carNumber });
    }

    expect(audio._played).toEqual([]);

    // Control: the same fire with a number the voice can say is spoken.
    fire("ahead", OpponentPenaltyFlag.Repair, { carNumber: "42" });

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/car-number/42.mp3`,
      `voice/${VOICE}/opponent-flags/meatball-ahead-tail-01.mp3`,
    ]);
  });

  it("the aggregate plays its single line", () => {
    fire("others", undefined);

    expect(voicePaths()).toEqual([`voice/${VOICE}/opponent-flags/others-01.mp3`]);
  });

  it("a deferred line speaks its OWN car, whatever fired after it", () => {
    // Car 42's line takes the bus; car 09's waits in the pending slot.
    bus.publishEvent("opponentFlag.flagged", flagged("ahead", OpponentPenaltyFlag.Black, { carNumber: "42" }).data);
    bus.publishEvent("opponentFlag.flagged", flagged("behind", OpponentPenaltyFlag.Furled, { carNumber: "09" }).data);
    flush(audio);

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/car-number/42.mp3`,
      `voice/${VOICE}/opponent-flags/black-ahead-tail-01.mp3`,
      `voice/${VOICE}/car-number/09.mp3`,
      `voice/${VOICE}/opponent-flags/furled-behind-tail-01.mp3`,
    ]);
  });
});

describe("opponentFlag.carNumber", () => {
  it("resolves to the car-number reference for an ahead and a behind fire", () => {
    for (const relation of RELATIONS) {
      expect(resolveOpponentFlagCarNumber(ctxOf(flagged(relation, OpponentPenaltyFlag.Black)))).toBe(
        poolRef("car-number", "42"),
      );
    }
  });

  it("keeps the session's spelling — leading zeros are part of the number", () => {
    expect(
      resolveOpponentFlagCarNumber(ctxOf(flagged("behind", OpponentPenaltyFlag.Black, { carNumber: "009" }))),
    ).toBe(poolRef("car-number", "009"));
  });

  it("is null when the event carries no number, an empty one, or is the aggregate", () => {
    expect(
      resolveOpponentFlagCarNumber(ctxOf(flagged("ahead", OpponentPenaltyFlag.Black, { carNumber: undefined }))),
    ).toBeNull();
    expect(
      resolveOpponentFlagCarNumber(ctxOf(flagged("ahead", OpponentPenaltyFlag.Black, { carNumber: "" }))),
    ).toBeNull();
    expect(resolveOpponentFlagCarNumber(ctxOf(flagged("others", undefined)))).toBeNull();
  });

  it("is null for an imperative fire and for any other event", () => {
    expect(resolveOpponentFlagCarNumber(ctxOf(null))).toBeNull();
    expect(
      resolveOpponentFlagCarNumber(
        ctxOf({
          event: "opponentPit.entered",
          timestamp: 0,
          telemetry: null,
          data: { relation: "ahead", carIdx: 7, position: 4 },
        } as SimEventOf<SimEventName>),
      ),
    ).toBeNull();
  });
});

describe("opponentFlag.number (the 3.3.0 position var, kept for third-party packs)", () => {
  it("resolves the payload position when no live read is wired", () => {
    const { engine: stub, vars } = makeVarEngine();

    registerOpponentFlagVocabulary(stub);

    const resolve = vars.get("opponentFlag.number");

    expect(resolve).toBeDefined();
    expect(resolve!(ctxOf(flagged("ahead", OpponentPenaltyFlag.Black, { position: 4 })))).toEqual(
      poolRef("position-number", "4"),
    );
  });

  it("prefers the live read and hands it the event's projection context", () => {
    const { engine: stub, vars } = makeVarEngine();
    const seen: OpponentFlagPending[] = [];

    registerOpponentFlagVocabulary(stub, (pending) => {
      seen.push(pending);

      return 6;
    });

    expect(
      vars.get("opponentFlag.number")!(
        ctxOf(flagged("ahead", OpponentPenaltyFlag.Black, { carIdx: 12, position: 4, isMultiClass: true })),
      ),
    ).toEqual(poolRef("position-number", "6"));
    expect(seen).toEqual([{ carIdx: 12, position: 4, isMultiClass: true }]);
  });

  it("falls back to the payload position when the live read returns null", () => {
    const { engine: stub, vars } = makeVarEngine();

    registerOpponentFlagVocabulary(stub, () => null);

    expect(
      vars.get("opponentFlag.number")!(ctxOf(flagged("behind", OpponentPenaltyFlag.Black, { position: 5 }))),
    ).toEqual(poolRef("position-number", "5"));
  });

  it("is null without a usable car or position, or outside an opponent-flag fire", () => {
    const { engine: stub, vars } = makeVarEngine();

    registerOpponentFlagVocabulary(stub);

    const resolve = vars.get("opponentFlag.number")!;

    for (const overrides of [
      { carIdx: undefined },
      { position: undefined },
      { position: 0 },
      // Non-integer / negative values would build clip lookups with no clip
      // behind them (`position-number/4.5`).
      { carIdx: -1 },
      { carIdx: 6.5 },
      { position: 4.5 },
    ]) {
      expect(
        resolve(ctxOf(flagged("ahead", OpponentPenaltyFlag.Black, overrides))),
        JSON.stringify(overrides),
      ).toBeNull();
    }

    expect(resolve(ctxOf(flagged("others", undefined)))).toBeNull();
    expect(resolve(ctxOf(null))).toBeNull();
  });

  it("a pack scripted against 3.3.0 still compiles and speaks its position lines; its track-ahead entries are skipped as no contract", () => {
    const legacy = packScript({
      "pit-crew.opponent-flag-black-ahead": {
        sequence: ["pool:opponent-pit/car-in", "{{opponentFlag.number}}", "pool:opponent-flags/black-ahead-tail"],
      },
      "pit-crew.opponent-flag-black-track-ahead": { sequence: ["pool:opponent-flags/others"] },
    });

    // The contracts this pack leaves unscripted are deliberate `no script`
    // skips; the retired id is the one entry with no contract behind it.
    expect(engine.compileScript(legacy).skipped.filter((s) => s.reason !== "no script")).toEqual([
      { id: "pit-crew.opponent-flag-black-track-ahead", reason: "no contract", deliberate: false },
    ]);

    engine.setScripts(new Map([[VOICE, legacy]]));
    livePosition = 6;
    fire("ahead", OpponentPenaltyFlag.Black, { carIdx: 12, position: 4, isMultiClass: true });

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/opponent-pit/car-in-01.mp3`,
      `voice/${VOICE}/position-number/6.mp3`,
      `voice/${VOICE}/opponent-flags/black-ahead-tail-01.mp3`,
    ]);
    expect(liveReads).toEqual([{ carIdx: 12, position: 4, isMultiClass: true }]);
  });

  it("a pack's numberless behind line still plays for a car the session cannot number", () => {
    engine.setScripts(
      new Map([
        [VOICE, packScript({ "pit-crew.opponent-flag-black-behind": { sequence: ["pool:opponent-flags/others"] } })],
      ]),
    );
    fire("behind", OpponentPenaltyFlag.Black, { carNumber: undefined });

    expect(voicePaths()).toEqual([`voice/${VOICE}/opponent-flags/others-01.mp3`]);
  });
});

describe("the published vocabulary", () => {
  it("publishes the car-number and position vars with descriptions naming their groups, and nothing else", () => {
    const { vars, conds, cases } = engine.vocabulary();
    const carNumber = vars.find((v) => v.name === "opponentFlag.carNumber");
    const number = vars.find((v) => v.name === "opponentFlag.number");

    expect(carNumber?.description).toContain("car-number");
    expect(number?.description).toContain("position-number");
    expect(number?.description).toContain("opponentFlag.carNumber");
    expect(
      vars
        .filter((v) => v.name.startsWith("opponentFlag."))
        .map((v) => v.name)
        .sort(),
    ).toEqual(["opponentFlag.carNumber", "opponentFlag.number"]);
    expect(conds.filter((c) => c.name.startsWith("opponentFlag."))).toEqual([]);
    expect(cases.filter((c) => c.name.startsWith("opponentFlag."))).toEqual([]);
  });
});

describe("the bundled script's opponent-flag entries (issue #1065; car numbers since #1274)", () => {
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

  it("every per-car entry is the car-number var then its relation's subject tail, as required steps", () => {
    for (const subject of SUBJECTS) {
      for (const relation of RELATIONS) {
        expect(
          SCRIPT.scenarios[`pit-crew.opponent-flag-${subject}-${relation}`].sequence,
          `${subject}-${relation}`,
        ).toEqual([
          "{{opponentFlag.carNumber}}",
          `pool:opponent-flags/${subject}-${relation}-tail`,
        ]);
      }
    }
  });

  it("references only the car-number var, no condition, case, fragment or frame", () => {
    const refs = collectScriptReferences(OPPONENT_FLAG_SCRIPT);

    expect(refs.vars).toEqual(["opponentFlag.carNumber"]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);
  });

  it("addresses exactly the published clip sources, in the slashed form, and every one has a clip in the bundled voice", () => {
    const sources = [
      "opponent-flags/black-ahead-tail",
      "opponent-flags/black-behind-tail",
      "opponent-flags/disqualify-ahead-tail",
      "opponent-flags/disqualify-behind-tail",
      "opponent-flags/furled-ahead-tail",
      "opponent-flags/furled-behind-tail",
      "opponent-flags/meatball-ahead-tail",
      "opponent-flags/meatball-behind-tail",
      "opponent-flags/others",
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

  it("maps exactly the contract ids except the aggregate (which registers without the per-flag opt-in wrapper)", () => {
    expect(Object.keys(SCENARIO_ID_TO_OPPONENT_FLAG_ID).sort()).toEqual(
      OPPONENT_FLAG_SCENARIO_IDS.filter((id) => id !== OPPONENT_FLAG_OTHERS_SCENARIO_ID).sort(),
    );
  });

  it("maps every bus enum value to its callout id (the translator-side opt-in resolver's table)", () => {
    expect(OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID).toEqual({
      furled: "furled",
      black: "black",
      repair: "meatball",
      disqualify: "disqualify",
    });
  });
});
