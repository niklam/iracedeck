/**
 * Approaching-traffic tests (issue #1113, amended 2026-11-11).
 *
 * Seven contracts, one per line: five off `traffic.rejoin` (right behind, the
 * close band's first call and its count, more than ten, clear) and two off
 * `traffic.pitExit`. The close band's lines are composed: an intro or update
 * intro, the middle naming the seconds through the `traffic.rejoinSeconds`
 * var, and (on the first call) an outro. The fire-through cases run the
 * family through the real engine against a script fixture shaped like the
 * bundled one (a contract is silent without a script, and these tests are
 * about the contracts and the vocabulary, not the wording), and a hand-built
 * manifest whose clip set decides what is speakable. What the first-party
 * voices script and ship is `traffic-voices.test.ts`.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { createFakeAudio, type FakeAudio } from "@iracedeck/audio-service/testing";
import { type CalloutScript } from "@iracedeck/callout-script";
import type {
  IEventBus,
  SimEventMap,
  SimEventName,
  SimEventOf,
  TrafficPitExitVerdict,
  TrafficRejoin,
} from "@iracedeck/event-bus";
import { TRAFFIC_REJOIN_NEAR_MAX_SECONDS, TRAFFIC_REJOIN_NEAR_MIN_SECONDS } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { NO_FRAME, poolRef, WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { PIT_READBACK_CONTRACTS } from "./readback.js";
import { TIRE_WEAR_CONTRACTS } from "./tire-wear.js";
import {
  registerTrafficVocabulary,
  REJOIN_SECONDS_VAR,
  rejoinMidBase,
  SCENARIO_ID_TO_TRAFFIC_ID,
  TRAFFIC_CLIP_SOURCES,
  TRAFFIC_CONTRACTS,
  TRAFFIC_MAX_QUEUE_WAIT_MS,
  TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP,
  TRAFFIC_REJOIN_SUPERSEDE_GROUP,
  TRAFFIC_SCENARIO_IDS,
} from "./traffic.js";

const REJOIN_IDS = [
  "pit-crew.traffic-rejoin-right-behind",
  "pit-crew.traffic-rejoin-near-first",
  "pit-crew.traffic-rejoin-near-update",
  "pit-crew.traffic-rejoin-over-ten",
  "pit-crew.traffic-rejoin-clear",
] as const;
const PIT_EXIT_IDS = ["pit-crew.traffic-pit-exit-traffic", "pit-crew.traffic-pit-exit-clear"] as const;
const PIT_EXIT_VERDICTS: readonly TrafficPitExitVerdict[] = ["traffic", "clear"];

/** One payload per rejoin line, keyed by the contract that must take it. */
const REJOIN_PAYLOADS: Record<(typeof REJOIN_IDS)[number], TrafficRejoin> = {
  "pit-crew.traffic-rejoin-right-behind": { verdict: "rightBehind" },
  "pit-crew.traffic-rejoin-near-first": { verdict: "near", seconds: 5, first: true },
  "pit-crew.traffic-rejoin-near-update": { verdict: "near", seconds: 5, first: false },
  "pit-crew.traffic-rejoin-over-ten": { verdict: "overTen" },
  "pit-crew.traffic-rejoin-clear": { verdict: "clear" },
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

function flush(audio: FakeAudio, iterations = 20): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const VOICE = "luca";
const TICK_OPEN = "sfx/IRD-tick-open.mp3";
const TICK_CLOSE = "sfx/IRD-tick-close.mp3";
const clip = (base: string, take = "01"): string => `voice/${VOICE}/traffic/${base}-${take}.mp3`;

/** A lower-weight line on the same bus, for the scheduling cases: an ordinary callout mid-sentence. */
const CHATTER_ID = "test.chatter";
const CHATTER_CLIP = `voice/${VOICE}/test/chatter-01.mp3`;
const CHATTER_CONTRACT: ScenarioContract = {
  id: CHATTER_ID,
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.NORMAL,
  queueable: false,
  frame: NO_FRAME,
  when: { event: "pitStall.entered" },
};

/** A heavier line no traffic line may cut, for the parked-fire cases. */
const CRITICAL_ID = "test.critical";
const CRITICAL_CLIP = `voice/${VOICE}/test/critical-01.mp3`;
const CRITICAL_CONTRACT: ScenarioContract = {
  id: CRITICAL_ID,
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.CRITICAL,
  queueable: false,
  frame: NO_FRAME,
  when: { event: "pitStall.departed" },
};

/**
 * The two lines a pit stop's exit publishes that the pit-exit call must
 * trump: the real exit readback and tire-wear contracts — their weight,
 * queueing and `queueBehind` are what is under test — under a fixture body of
 * one clip each.
 */
const READBACK_EXIT = PIT_READBACK_CONTRACTS.find((c) => c.id === "pit-crew.pit-readback-exit")!;
const TIRE_WEAR_REPORT = TIRE_WEAR_CONTRACTS.find((c) => c.id === "pit-crew.tire-wear-report")!;
const READBACK_CLIP = `voice/${VOICE}/test/readback-01.mp3`;
const TIRE_WEAR_CLIP = `voice/${VOICE}/test/tire-wear-01.mp3`;
const TIRE_WEAR_DATA = {
  corners: {
    lf: { inside: 89.2, middle: 90.4, outside: 91.1, tread: 89.2, zone: "inside" },
    rf: { inside: 90.6, middle: 91.3, outside: 92.8, tread: 90.6, zone: "inside" },
    lr: { inside: 87.9, middle: 87.4, outside: 88.6, tread: 87.4, zone: "middle" },
    rr: { inside: 85.3, middle: 86.1, outside: 88.0, tread: 85.3, zone: "inside" },
  },
  heaviest: { corner: "rr", zone: "inside" },
};

/**
 * The clips this voice ships: one take of each fixed pool, two takes of the
 * five-second middle, and the middles at the band's two edges — so a number
 * with no clip is exercised too.
 */
const manifest: AudioAssetsManifest = {
  clips: [
    TICK_OPEN,
    TICK_CLOSE,
    "sfx/IRD-ambient-pit.mp3",
    ...TRAFFIC_CLIP_SOURCES.map(({ base }) => clip(base)),
    clip("rejoin-mid-2"),
    clip("rejoin-mid-5"),
    clip("rejoin-mid-5", "02"),
    clip("rejoin-mid-9"),
    CHATTER_CLIP,
    CRITICAL_CLIP,
    READBACK_CLIP,
    TIRE_WEAR_CLIP,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: TICK_OPEN, close: TICK_CLOSE },
};

const ENTRY = { comment: "fixture", test: "fixture" };

/** A script shaped like the bundled one's traffic entries. */
const SCRIPT: CalloutScript = {
  schema: 1,
  scenarios: {
    "pit-crew.traffic-rejoin-right-behind": { ...ENTRY, sequence: ["pool:traffic/rejoin-right-behind"] },
    "pit-crew.traffic-rejoin-near-first": {
      ...ENTRY,
      sequence: ["pool:traffic/rejoin-intro", `{{${REJOIN_SECONDS_VAR}}}`, "pool:traffic/rejoin-outro"],
    },
    "pit-crew.traffic-rejoin-near-update": {
      ...ENTRY,
      sequence: ["pool:traffic/rejoin-update", `{{${REJOIN_SECONDS_VAR}}}`],
    },
    "pit-crew.traffic-rejoin-over-ten": { ...ENTRY, sequence: ["pool:traffic/rejoin-over-ten"] },
    "pit-crew.traffic-rejoin-clear": { ...ENTRY, sequence: ["pool:traffic/rejoin-clear"] },
    "pit-crew.traffic-pit-exit-traffic": { ...ENTRY, sequence: ["pool:traffic/pit-exit-traffic"] },
    "pit-crew.traffic-pit-exit-clear": { ...ENTRY, sequence: ["pool:traffic/pit-exit-clear"] },
    [CHATTER_ID]: { ...ENTRY, sequence: ["pool:test/chatter"] },
    [CRITICAL_ID]: { ...ENTRY, sequence: ["pool:test/critical"] },
    [READBACK_EXIT.id]: { ...ENTRY, sequence: ["pool:test/readback"] },
    [TIRE_WEAR_REPORT.id]: { ...ENTRY, sequence: ["pool:test/tire-wear"] },
  },
  frames: { radio: { comment: "fixture", open: [{ clip: TICK_OPEN }], close: [{ clip: TICK_CLOSE }] } },
  pools: {},
  fragments: {},
} as CalloutScript;

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;

function contract(id: string): ScenarioContract {
  const c = TRAFFIC_CONTRACTS.find((x) => x.id === id);

  if (!c) throw new Error(`contract not found: ${id}`);

  return c;
}

function near(seconds: number, first: boolean): TrafficRejoin {
  return { verdict: "near", seconds, first };
}

function rejoinEvent(data: TrafficRejoin): SimEventOf<"traffic.rejoin"> {
  return { event: "traffic.rejoin", timestamp: 0, telemetry: null, data };
}

function pitExitEvent(verdict: TrafficPitExitVerdict, seconds?: number): SimEventOf<"traffic.pitExit"> {
  return {
    event: "traffic.pitExit",
    timestamp: 0,
    telemetry: null,
    data: seconds === undefined ? { verdict } : { verdict, seconds },
  };
}

function ctxOf(event: SimEventOf<SimEventName> | null): ScenarioContext {
  return { event, telemetry: event?.telemetry, data: event?.data, now: 0 } as ScenarioContext;
}

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function allPaths(): string[] {
  return audio._played.map((p) => p.path);
}

beforeEach(() => {
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  // The production order (`registerPitCrew`): vocabulary, contracts, script.
  registerTrafficVocabulary(engine);

  for (const c of [...TRAFFIC_CONTRACTS, CHATTER_CONTRACT, CRITICAL_CONTRACT, READBACK_EXIT, TIRE_WEAR_REPORT]) {
    engine.defineContract(c);
  }

  engine.setScripts(new Map([[VOICE, SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("TRAFFIC_CONTRACTS", () => {
  it("exports one contract per line, rejoin first in band order, in registration order", () => {
    expect(TRAFFIC_SCENARIO_IDS).toEqual([...REJOIN_IDS, ...PIT_EXIT_IDS]);
  });

  it("carries no sequence — what each line says is the voice script's", () => {
    for (const c of TRAFFIC_CONTRACTS) expect("sequence" in c).toBe(false);
  });

  it("shares one family, on the voice bus, at SAFETY weight, never queueable, with a short maximum wait", () => {
    for (const c of TRAFFIC_CONTRACTS) {
      expect(c.family, c.id).toBe("traffic");
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.weight, c.id).toBe(WEIGHT.SAFETY);
      expect(c.queueable, c.id).toBe(false);
      expect(c.maxQueueWaitMs, c.id).toBe(TRAFFIC_MAX_QUEUE_WAIT_MS);
      expect(c.maxQueueWaitMs!).toBeLessThan(8000);
    }
  });

  it("the close calls and both pit-exit lines interrupt; more than ten and clear do not", () => {
    const interrupting = TRAFFIC_CONTRACTS.filter((c) => c.interrupt === true).map((c) => c.id);

    expect(interrupting).toEqual([
      "pit-crew.traffic-rejoin-right-behind",
      "pit-crew.traffic-rejoin-near-first",
      "pit-crew.traffic-rejoin-near-update",
      "pit-crew.traffic-pit-exit-traffic",
      "pit-crew.traffic-pit-exit-clear",
    ]);
    expect(contract("pit-crew.traffic-rejoin-over-ten").interrupt).toBe(false);
    expect(contract("pit-crew.traffic-rejoin-clear").interrupt).toBe(false);
  });

  it("the rejoin lines are unframed; the pit-exit lines keep the default radio frame", () => {
    for (const id of REJOIN_IDS) expect(contract(id).frame, id).toBe(NO_FRAME);

    for (const id of PIT_EXIT_IDS) expect(contract(id).frame, id).toBeUndefined();
  });

  it("each trigger's lines share one supersede group, and the two triggers do not", () => {
    for (const id of REJOIN_IDS) expect(contract(id).supersedeGroup, id).toBe(TRAFFIC_REJOIN_SUPERSEDE_GROUP);

    for (const id of PIT_EXIT_IDS) expect(contract(id).supersedeGroup, id).toBe(TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP);

    expect(TRAFFIC_REJOIN_SUPERSEDE_GROUP).not.toBe(TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP);
  });

  it("each rejoin payload is taken by exactly one contract, the one for its line", () => {
    for (const id of REJOIN_IDS) expect(contract(id).when?.event).toBe("traffic.rejoin");

    for (const [owner, data] of Object.entries(REJOIN_PAYLOADS)) {
      const takers = REJOIN_IDS.filter((id) => contract(id).when?.where?.(rejoinEvent(data)) === true);

      expect(takers, owner).toEqual([owner]);
    }
  });

  it("each pit-exit contract fires on its own verdict only", () => {
    for (const [i, id] of PIT_EXIT_IDS.entries()) {
      const when = contract(id).when;

      expect(when?.event).toBe("traffic.pitExit");

      for (const verdict of PIT_EXIT_VERDICTS) {
        expect(when?.where?.(pitExitEvent(verdict, 1)), `${id} on ${verdict}`).toBe(verdict === PIT_EXIT_VERDICTS[i]);
      }
    }
  });

  it("every description is one sentence for a pack author, within the reference's 200 characters", () => {
    for (const c of TRAFFIC_CONTRACTS) {
      expect(c.description, c.id).toBeDefined();
      expect(c.description!.endsWith("."), c.id).toBe(true);
      expect(c.description!.length, c.id).toBeLessThanOrEqual(200);
      expect(c.description!.toLowerCase().startsWith("traffic"), c.id).toBe(false);
    }
  });
});

describe("rejoinMidBase", () => {
  it("names the middle's pool for every whole second of the close band", () => {
    for (let n = TRAFFIC_REJOIN_NEAR_MIN_SECONDS; n <= TRAFFIC_REJOIN_NEAR_MAX_SECONDS; n++) {
      expect(rejoinMidBase(near(n, true))).toBe(`rejoin-mid-${n}`);
      expect(rejoinMidBase(near(n, false))).toBe(`rejoin-mid-${n}`);
    }

    expect([TRAFFIC_REJOIN_NEAR_MIN_SECONDS, TRAFFIC_REJOIN_NEAR_MAX_SECONDS]).toEqual([2, 9]);
  });

  it("is null outside the close band, for a count that is not a whole number, and for any other verdict", () => {
    for (const n of [1, 10, 0, -3, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(rejoinMidBase(near(n, true)), String(n)).toBeNull();
    }

    expect(rejoinMidBase({ verdict: "near", first: true } as unknown as TrafficRejoin)).toBeNull();
    expect(rejoinMidBase({ verdict: "rightBehind" })).toBeNull();
    expect(rejoinMidBase({ verdict: "clear", seconds: 5 } as unknown as TrafficRejoin)).toBeNull();
    expect(rejoinMidBase(null)).toBeNull();
    expect(rejoinMidBase(undefined)).toBeNull();
  });
});

describe("registerTrafficVocabulary", () => {
  /** The resolvers as registered, reached through a stub engine; the real engine's list gives the published names. */
  function stubEngine(): {
    vars: Map<string, (ctx: ScenarioContext) => unknown>;
    conds: Map<string, (ctx: ScenarioContext) => unknown>;
    cases: Map<string, { resolve: (ctx: ScenarioContext) => unknown; keys: Record<string, string> }>;
  } {
    const vars = new Map<string, (ctx: ScenarioContext) => unknown>();
    const conds = new Map<string, (ctx: ScenarioContext) => unknown>();
    const cases = new Map<string, { resolve: (ctx: ScenarioContext) => unknown; keys: Record<string, string> }>();
    const stub = {
      defineVar: vi.fn((name: string, fn: (ctx: ScenarioContext) => unknown) => vars.set(name, fn)),
      defineCond: vi.fn((name: string, fn: (ctx: ScenarioContext) => unknown) => conds.set(name, fn)),
      defineCase: vi.fn(
        (name: string, fn: (ctx: ScenarioContext) => unknown, keys: Record<string, string>) =>
          void cases.set(name, { resolve: fn, keys }),
      ),
    } as unknown as IScenarioEngine;

    registerTrafficVocabulary(stub);

    return { vars, conds, cases };
  }

  it("publishes the seconds var, the first-call condition and four cases, the var naming the traffic group", () => {
    const { vars, conds, cases } = engine.vocabulary();
    const own = <T extends { name: string }>(list: readonly T[]): T[] =>
      list.filter((x) => x.name.startsWith("traffic."));

    expect(own(vars).map((v) => v.name)).toEqual([REJOIN_SECONDS_VAR]);
    expect(own(vars)[0].description).toMatch(/\btraffic group\b/);
    expect(own(conds).map((c) => c.name)).toEqual(["traffic.rejoinFirst"]);
    expect(
      own(cases)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["traffic.pitExitNearestSide", "traffic.pitExitVerdict", "traffic.rejoinBand"]);

    for (const x of [...own(vars), ...own(conds), ...own(cases)]) {
      expect(x.description.endsWith("."), x.name).toBe(true);
    }
  });

  it("the seconds var resolves a close-band count to that number's pool, and nothing otherwise", () => {
    const seconds = stubEngine().vars.get(REJOIN_SECONDS_VAR)!;

    expect(seconds(ctxOf(rejoinEvent(near(5, true))))).toEqual(poolRef("traffic", "rejoin-mid-5"));
    expect(seconds(ctxOf(rejoinEvent(near(2, false))))).toEqual(poolRef("traffic", "rejoin-mid-2"));
    expect(seconds(ctxOf(rejoinEvent(near(10, true))))).toBeNull();
    expect(seconds(ctxOf(rejoinEvent({ verdict: "overTen" })))).toBeNull();
    expect(seconds(ctxOf(pitExitEvent("traffic", 3)))).toBeNull();
    // An imperative fire carries no event.
    expect(seconds(ctxOf(null))).toBeNull();
  });

  it("the first-call condition is true only on a near verdict's first call", () => {
    const first = stubEngine().conds.get("traffic.rejoinFirst")!;

    expect(first(ctxOf(rejoinEvent(near(6, true))))).toBe(true);
    expect(first(ctxOf(rejoinEvent(near(6, false))))).toBe(false);
    expect(first(ctxOf(rejoinEvent({ verdict: "rightBehind" })))).toBe(false);
    expect(first(ctxOf(pitExitEvent("clear")))).toBe(false);
    expect(first(ctxOf(null))).toBe(false);
  });

  it("the band and pit-exit verdict cases declare every verdict and read the fire's own event", () => {
    const { cases } = stubEngine();
    const band = cases.get("traffic.rejoinBand")!;
    const pitExit = cases.get("traffic.pitExitVerdict")!;
    const payloads = Object.values(REJOIN_PAYLOADS);

    expect(Object.keys(band.keys).sort()).toEqual(["clear", "near", "overTen", "rightBehind"]);
    expect(Object.keys(pitExit.keys).sort()).toEqual([...PIT_EXIT_VERDICTS].sort());

    for (const data of payloads) expect(band.resolve(ctxOf(rejoinEvent(data)))).toBe(data.verdict);

    for (const verdict of PIT_EXIT_VERDICTS) expect(pitExit.resolve(ctxOf(pitExitEvent(verdict)))).toBe(verdict);

    expect(band.resolve(ctxOf(pitExitEvent("clear")))).toBeNull();
    expect(pitExit.resolve(ctxOf(rejoinEvent({ verdict: "clear" })))).toBeNull();
    expect(band.resolve(ctxOf(null))).toBeNull();
  });

  it("the nearest-side case reads the sign of the pit-exit seconds, and says nothing when no car was timed", () => {
    const side = stubEngine().cases.get("traffic.pitExitNearestSide")!;

    expect(Object.keys(side.keys).sort()).toEqual(["after", "before"]);
    expect(side.resolve(ctxOf(pitExitEvent("traffic", -1.5)))).toBe("before");
    expect(side.resolve(ctxOf(pitExitEvent("traffic", 0)))).toBe("after");
    expect(side.resolve(ctxOf(pitExitEvent("clear", 6.2)))).toBe("after");
    expect(side.resolve(ctxOf(pitExitEvent("traffic")))).toBeNull();
    expect(side.resolve(ctxOf(rejoinEvent(near(3, true))))).toBeNull();
  });
});

describe("the traffic lines through the engine", () => {
  it("a first call is intro, the seconds and outro, unframed", () => {
    bus.publishEvent("traffic.rejoin", near(9, true));
    flush(audio);

    expect(voicePaths()).toEqual([clip("rejoin-intro"), clip("rejoin-mid-9"), clip("rejoin-outro")]);
    expect(allPaths()).not.toContain(TICK_OPEN);
  });

  it("a count is the update intro and the seconds, unframed", () => {
    bus.publishEvent("traffic.rejoin", near(2, false));
    flush(audio);

    expect(voicePaths()).toEqual([clip("rejoin-update"), clip("rejoin-mid-2")]);
    expect(allPaths()).not.toContain(TICK_OPEN);
  });

  it("the middle draws from its number's takes, the voice's different wordings", () => {
    const heard = new Set<string>();

    for (let i = 0; i < 6; i++) {
      audio._reset();
      bus.publishEvent("traffic.rejoin", near(5, false));
      flush(audio);
      heard.add(voicePaths()[1]);
    }

    // No immediate repeat in a pool of two: the takes alternate.
    expect([...heard].sort()).toEqual([clip("rejoin-mid-5"), clip("rejoin-mid-5", "02")]);
  });

  it.each([
    ["rightBehind", "rejoin-right-behind"],
    ["overTen", "rejoin-over-ten"],
    ["clear", "rejoin-clear"],
  ] as const)("a %s verdict plays its fixed pool, unframed", (verdict, base) => {
    bus.publishEvent("traffic.rejoin", { verdict });
    flush(audio);

    expect(voicePaths()).toEqual([clip(base)]);
    expect(allPaths()).not.toContain(TICK_OPEN);
  });

  it.each([
    ["traffic", "pit-exit-traffic"],
    ["clear", "pit-exit-clear"],
  ] as const)("pit exit %s plays its line inside the radio frame", (verdict, base) => {
    bus.publishEvent("traffic.pitExit", { verdict, seconds: 1.5 });
    flush(audio);

    expect(voicePaths()).toEqual([clip(base)]);
    expect(allPaths()[0]).toBe(TICK_OPEN);
    expect(allPaths()).toContain(TICK_CLOSE);
  });

  it("a count the voice has no middle for skips the line whole (#835), and the next speakable one still plays", () => {
    bus.publishEvent("traffic.rejoin", near(4, true));
    bus.publishEvent("traffic.rejoin", near(7, false));
    flush(audio);

    expect(voicePaths()).toEqual([]);

    bus.publishEvent("traffic.rejoin", near(9, false));
    flush(audio);

    expect(voicePaths()).toEqual([clip("rejoin-update"), clip("rejoin-mid-9")]);
  });

  it("a count outside the close band says nothing, never a figure the band does not hold", () => {
    bus.publishEvent("traffic.rejoin", near(12, true));
    bus.publishEvent("traffic.rejoin", { verdict: "near", first: false } as unknown as TrafficRejoin);
    flush(audio);

    expect(voicePaths()).toEqual([]);
  });
});

describe("scheduling against other lines", () => {
  it.each([
    "pit-crew.traffic-rejoin-right-behind",
    "pit-crew.traffic-rejoin-near-first",
    "pit-crew.traffic-rejoin-near-update",
  ] as const)("%s cuts an ordinary line mid-sentence", (id) => {
    bus.publishEvent("pitStall.entered", {});

    expect(voicePaths()).toEqual([CHATTER_CLIP]);

    bus.publishEvent("traffic.rejoin", REJOIN_PAYLOADS[id]);

    expect(audio._stopped).toContain(AudioChannel.Voice);
    expect(voicePaths()).toHaveLength(2);
    expect(voicePaths()[1]).toMatch(/\/traffic\/rejoin-/);
  });

  it.each(["pit-crew.traffic-rejoin-over-ten", "pit-crew.traffic-rejoin-clear"] as const)(
    "%s lets the ordinary line finish, then plays",
    (id) => {
      bus.publishEvent("pitStall.entered", {});
      bus.publishEvent("traffic.rejoin", REJOIN_PAYLOADS[id]);

      expect(voicePaths()).toEqual([CHATTER_CLIP]);
      expect(audio._stopped).not.toContain(AudioChannel.Voice);

      flush(audio);

      expect(voicePaths()).toHaveLength(2);
      expect(voicePaths()[1]).toMatch(/\/traffic\/rejoin-/);
    },
  );

  it.each(PIT_EXIT_VERDICTS)("pit exit %s cuts an ordinary line", (verdict) => {
    bus.publishEvent("pitStall.entered", {});
    bus.publishEvent("traffic.pitExit", { verdict, seconds: 1 });

    // Cut at once; the line itself follows the frame's open tick.
    expect(audio._stopped).toContain(AudioChannel.Voice);
    expect(allPaths().at(-1)).toBe(TICK_OPEN);

    flush(audio);

    expect(voicePaths()).toEqual([CHATTER_CLIP, clip(`pit-exit-${verdict}`)]);
  });

  describe("the pit-exit call trumps the exit readback and the tire-wear report", () => {
    function exitStop(): void {
      // The readback takes the bus; the report, published on the same settle
      // timer, waits behind it.
      bus.publishEvent("pitService.readbackRequested", { reason: "exit" } as never);
      bus.publishEvent("tireWear.reported", TIRE_WEAR_DATA as never);
    }

    it.each(PIT_EXIT_VERDICTS)("pit exit %s cuts the readback, which resumes, then the report plays", (verdict) => {
      exitStop();

      expect(voicePaths()).toEqual([]);
      audio._triggerChannelEnd(AudioChannel.SFX);
      expect(voicePaths()).toEqual([READBACK_CLIP]);

      bus.publishEvent("traffic.pitExit", { verdict, seconds: 1 });

      expect(audio._stopped).toContain(AudioChannel.Voice);

      flush(audio);

      expect(voicePaths()).toEqual([READBACK_CLIP, clip(`pit-exit-${verdict}`), READBACK_CLIP, TIRE_WEAR_CLIP]);
    });

    it.each(PIT_EXIT_VERDICTS)("pit exit %s cuts the tire-wear report, which then plays again", (verdict) => {
      exitStop();
      audio._triggerChannelEnd(AudioChannel.SFX);
      // The readback finishes (its body, then its close tick); the report takes the bus.
      audio._triggerChannelEnd(AudioChannel.Voice);
      audio._triggerChannelEnd(AudioChannel.SFX);
      audio._triggerChannelEnd(AudioChannel.SFX);

      expect(voicePaths()).toEqual([READBACK_CLIP, TIRE_WEAR_CLIP]);

      bus.publishEvent("traffic.pitExit", { verdict, seconds: 1 });

      expect(audio._stopped).toContain(AudioChannel.Voice);

      flush(audio);

      expect(voicePaths()).toEqual([READBACK_CLIP, TIRE_WEAR_CLIP, clip(`pit-exit-${verdict}`), TIRE_WEAR_CLIP]);
    });
  });

  it("a newer line replaces the one in flight — a count cuts the first call still playing", () => {
    bus.publishEvent("traffic.rejoin", near(9, true));
    bus.publishEvent("traffic.rejoin", near(5, false));

    expect(audio._stopped).toContain(AudioChannel.Voice);
    expect(voicePaths()[0]).toBe(clip("rejoin-intro"));
    expect(voicePaths()[1]).toBe(clip("rejoin-update"));

    flush(audio);

    expect(voicePaths()).not.toContain(clip("rejoin-outro"));
  });

  it("a close call cannot cut a heavier line, and is dropped rather than queued behind it", () => {
    bus.publishEvent("pitStall.departed", {});
    bus.publishEvent("traffic.rejoin", { verdict: "rightBehind" });
    flush(audio);

    expect(voicePaths()).toEqual([CRITICAL_CLIP]);
  });

  it("a newer verdict removes a waiting older one, so the stale band is never heard after it", () => {
    bus.publishEvent("pitStall.entered", {});
    // Both wait for the ordinary line (heavier, no interrupt): "more than
    // ten" first, then the clear that replaced it.
    bus.publishEvent("traffic.rejoin", { verdict: "overTen" });
    bus.publishEvent("traffic.rejoin", { verdict: "clear" });
    flush(audio);

    expect(voicePaths()).toEqual([CHATTER_CLIP, clip("rejoin-clear")]);
  });

  it("a line parked longer than its maximum wait is dropped, not spoken late", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    bus.publishEvent("pitStall.entered", {});
    bus.publishEvent("traffic.rejoin", { verdict: "overTen" });

    vi.setSystemTime(TRAFFIC_MAX_QUEUE_WAIT_MS + 1);
    flush(audio);

    expect(voicePaths()).toEqual([CHATTER_CLIP]);
  });
});

describe("family wiring", () => {
  it("maps every rejoin line to the rejoin opt-in and both pit-exit lines to the pit-exit one", () => {
    expect(Object.keys(SCENARIO_ID_TO_TRAFFIC_ID).sort()).toEqual([...TRAFFIC_SCENARIO_IDS].sort());

    for (const id of REJOIN_IDS) expect(SCENARIO_ID_TO_TRAFFIC_ID[id], id).toBe("rejoin");

    for (const id of PIT_EXIT_IDS) expect(SCENARIO_ID_TO_TRAFFIC_ID[id], id).toBe("pit-exit");
  });

  it("the clip sources are the pools the script addresses directly, the middles left to the var", () => {
    expect(TRAFFIC_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`)).toEqual([
      "traffic/rejoin-intro",
      "traffic/rejoin-outro",
      "traffic/rejoin-update",
      "traffic/rejoin-right-behind",
      "traffic/rejoin-over-ten",
      "traffic/rejoin-clear",
      "traffic/pit-exit-traffic",
      "traffic/pit-exit-clear",
    ]);
  });

  it("the fixture compiles with nothing skipped", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
