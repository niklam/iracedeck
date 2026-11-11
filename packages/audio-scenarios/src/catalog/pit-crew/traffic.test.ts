/**
 * Approaching-traffic tests (issue #1113).
 *
 * Six contracts, one per verdict: four off `traffic.rejoin`, two off
 * `traffic.pitExit`. The rejoin numbers are whole recorded lines drawn
 * through the `traffic.rejoin*Line` vars from the event's own number (the
 * clear verdict's `windowSeconds`, a notice's or hold's `seconds`). The
 * fire-through cases run the family through the real engine against a
 * script fixture shaped like the bundled one (a contract is silent without a
 * script, and these tests are about the contracts and the vocabulary, not the
 * wording), and a hand-built manifest whose clip set decides what is
 * speakable.
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
  TrafficRejoinVerdict,
} from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { NO_FRAME, poolRef, WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import {
  registerTrafficVocabulary,
  rejoinLineBase,
  SCENARIO_ID_TO_TRAFFIC_ID,
  TRAFFIC_CLIP_SOURCES,
  TRAFFIC_CONTRACTS,
  TRAFFIC_MAX_QUEUE_WAIT_MS,
  TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP,
  TRAFFIC_REJOIN_SUPERSEDE_GROUP,
  TRAFFIC_SCENARIO_IDS,
} from "./traffic.js";

const REJOIN_VERDICTS: readonly TrafficRejoinVerdict[] = ["clear", "notice", "hold", "go"];
const PIT_EXIT_VERDICTS: readonly TrafficPitExitVerdict[] = ["traffic", "clear"];

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

/** A heavier line no traffic verdict may cut, for the parked-fire cases. */
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
 * The clips this voice ships: the three fixed lines, and only some of the
 * numbered ones, so a value with no clip is exercised too.
 */
const manifest: AudioAssetsManifest = {
  clips: [
    TICK_OPEN,
    TICK_CLOSE,
    "sfx/IRD-ambient-pit.mp3",
    ...TRAFFIC_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
    `voice/${VOICE}/traffic/rejoin-clear-20-01.mp3`,
    `voice/${VOICE}/traffic/rejoin-notice-12-01.mp3`,
    `voice/${VOICE}/traffic/rejoin-notice-2-01.mp3`,
    `voice/${VOICE}/traffic/rejoin-hold-4-01.mp3`,
    `voice/${VOICE}/traffic/rejoin-hold-1-01.mp3`,
    `voice/${VOICE}/traffic/rejoin-hold-14-01.mp3`,
    CHATTER_CLIP,
    CRITICAL_CLIP,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: TICK_OPEN, close: TICK_CLOSE },
};

const ENTRY = { comment: "fixture", test: "fixture" };

/**
 * A script shaped like the bundled one's traffic entries: each numbered
 * rejoin verdict speaks its own line var, the fixed lines address their pools.
 */
const SCRIPT: CalloutScript = {
  schema: 1,
  scenarios: {
    "pit-crew.traffic-rejoin-clear": { ...ENTRY, sequence: ["{{traffic.rejoinClearLine}}"] },
    "pit-crew.traffic-rejoin-notice": { ...ENTRY, sequence: ["{{traffic.rejoinNoticeLine}}"] },
    "pit-crew.traffic-rejoin-hold": { ...ENTRY, sequence: ["{{traffic.rejoinHoldLine}}"] },
    "pit-crew.traffic-rejoin-go": { ...ENTRY, sequence: ["pool:traffic/rejoin-go"] },
    "pit-crew.traffic-pit-exit-traffic": { ...ENTRY, sequence: ["pool:traffic/pit-exit-traffic"] },
    "pit-crew.traffic-pit-exit-clear": { ...ENTRY, sequence: ["pool:traffic/pit-exit-clear"] },
    [CHATTER_ID]: { ...ENTRY, sequence: ["pool:test/chatter"] },
    [CRITICAL_ID]: { ...ENTRY, sequence: ["pool:test/critical"] },
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

/**
 * The payload of a rejoin verdict with its number in the field that verdict
 * carries: `windowSeconds` for clear, `seconds` for notice and hold, none for
 * go. A numbered verdict given no number is malformed on purpose — what a
 * broken publisher would send — and is cast past the union.
 */
function rejoinData(verdict: TrafficRejoinVerdict, n?: number): TrafficRejoin {
  if (verdict === "go") return { verdict };

  if (n === undefined) return { verdict } as unknown as TrafficRejoin;

  return verdict === "clear" ? { verdict, windowSeconds: n } : { verdict, seconds: n };
}

function rejoinEvent(verdict: TrafficRejoinVerdict, n?: number): SimEventOf<"traffic.rejoin"> {
  return {
    event: "traffic.rejoin",
    timestamp: 0,
    telemetry: null,
    data: rejoinData(verdict, n),
  };
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

  for (const c of [...TRAFFIC_CONTRACTS, CHATTER_CONTRACT, CRITICAL_CONTRACT]) engine.defineContract(c);

  engine.setScripts(new Map([[VOICE, SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("TRAFFIC_CONTRACTS", () => {
  it("exports one contract per verdict, rejoin first, in registration order", () => {
    expect(TRAFFIC_SCENARIO_IDS).toEqual([
      "pit-crew.traffic-rejoin-clear",
      "pit-crew.traffic-rejoin-notice",
      "pit-crew.traffic-rejoin-hold",
      "pit-crew.traffic-rejoin-go",
      "pit-crew.traffic-pit-exit-traffic",
      "pit-crew.traffic-pit-exit-clear",
    ]);
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

  it("only a hold and pit-exit traffic interrupt", () => {
    const interrupting = TRAFFIC_CONTRACTS.filter((c) => c.interrupt === true).map((c) => c.id);

    expect(interrupting).toEqual(["pit-crew.traffic-rejoin-hold", "pit-crew.traffic-pit-exit-traffic"]);

    for (const c of TRAFFIC_CONTRACTS.filter((x) => !interrupting.includes(x.id))) {
      expect(c.interrupt, c.id).toBe(false);
    }
  });

  it("the rejoin lines are unframed; the pit-exit lines keep the default radio frame", () => {
    for (const verdict of REJOIN_VERDICTS) {
      expect(contract(`pit-crew.traffic-rejoin-${verdict}`).frame).toBe(NO_FRAME);
    }

    for (const verdict of PIT_EXIT_VERDICTS) {
      expect(contract(`pit-crew.traffic-pit-exit-${verdict}`).frame).toBeUndefined();
    }
  });

  it("each trigger's verdicts share one supersede group, and the two triggers do not", () => {
    for (const verdict of REJOIN_VERDICTS) {
      expect(contract(`pit-crew.traffic-rejoin-${verdict}`).supersedeGroup).toBe(TRAFFIC_REJOIN_SUPERSEDE_GROUP);
    }

    for (const verdict of PIT_EXIT_VERDICTS) {
      expect(contract(`pit-crew.traffic-pit-exit-${verdict}`).supersedeGroup).toBe(TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP);
    }

    expect(TRAFFIC_REJOIN_SUPERSEDE_GROUP).not.toBe(TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP);
  });

  it("each rejoin contract fires on its own verdict only", () => {
    for (const own of REJOIN_VERDICTS) {
      const where = contract(`pit-crew.traffic-rejoin-${own}`).when;

      expect(where?.event).toBe("traffic.rejoin");

      for (const verdict of REJOIN_VERDICTS) {
        expect(where?.where?.(rejoinEvent(verdict, 4)), `${own} on ${verdict}`).toBe(verdict === own);
      }
    }
  });

  it("each pit-exit contract fires on its own verdict only", () => {
    for (const own of PIT_EXIT_VERDICTS) {
      const where = contract(`pit-crew.traffic-pit-exit-${own}`).when;

      expect(where?.event).toBe("traffic.pitExit");

      for (const verdict of PIT_EXIT_VERDICTS) {
        expect(where?.where?.(pitExitEvent(verdict, 1)), `${own} on ${verdict}`).toBe(verdict === own);
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

describe("rejoinLineBase", () => {
  it("names the value's clip base for its own verdict", () => {
    expect(rejoinLineBase("clear", { verdict: "clear", windowSeconds: 20 })).toBe("rejoin-clear-20");
    expect(rejoinLineBase("notice", { verdict: "notice", seconds: 12 })).toBe("rejoin-notice-12");
    expect(rejoinLineBase("hold", { verdict: "hold", seconds: 1 })).toBe("rejoin-hold-1");
  });

  it("is null for another verdict, a missing payload, or a count that is not a positive whole number", () => {
    expect(rejoinLineBase("hold", { verdict: "notice", seconds: 4 })).toBeNull();
    expect(rejoinLineBase("hold", null)).toBeNull();
    expect(rejoinLineBase("hold", rejoinData("hold"))).toBeNull();
    expect(rejoinLineBase("hold", { verdict: "hold", seconds: 0 })).toBeNull();
    expect(rejoinLineBase("hold", { verdict: "hold", seconds: -3 })).toBeNull();
    expect(rejoinLineBase("hold", { verdict: "hold", seconds: 3.5 })).toBeNull();
    expect(rejoinLineBase("hold", { verdict: "hold", seconds: Number.NaN })).toBeNull();
  });

  it("reads each verdict's own field: a clear's window, never a stray seconds", () => {
    expect(rejoinLineBase("clear", { verdict: "clear", seconds: 20 } as unknown as TrafficRejoin)).toBeNull();
    expect(rejoinLineBase("hold", { verdict: "hold", windowSeconds: 3 } as unknown as TrafficRejoin)).toBeNull();
  });

  it("applies no range — a large count still names a base, and the clips decide whether it is speakable", () => {
    expect(rejoinLineBase("clear", { verdict: "clear", windowSeconds: 90 })).toBe("rejoin-clear-90");
  });
});

describe("registerTrafficVocabulary", () => {
  /** The resolvers as registered, reached through a stub engine; the real engine's list gives the published names. */
  function stubEngine(): {
    vars: Map<string, (ctx: ScenarioContext) => unknown>;
    cases: Map<string, { resolve: (ctx: ScenarioContext) => unknown; keys: Record<string, string> }>;
    engine: IScenarioEngine;
  } {
    const vars = new Map<string, (ctx: ScenarioContext) => unknown>();
    const cases = new Map<string, { resolve: (ctx: ScenarioContext) => unknown; keys: Record<string, string> }>();
    const stub = {
      defineVar: vi.fn((name: string, fn: (ctx: ScenarioContext) => unknown) => vars.set(name, fn)),
      defineCase: vi.fn(
        (name: string, fn: (ctx: ScenarioContext) => unknown, keys: Record<string, string>) =>
          void cases.set(name, { resolve: fn, keys }),
      ),
    } as unknown as IScenarioEngine;

    registerTrafficVocabulary(stub);

    return { vars, cases, engine: stub };
  }

  it("publishes the three line vars and three cases, every description naming the traffic group where it draws clips", () => {
    const { vars, conds, cases } = engine.vocabulary();
    const own = vars.filter((v) => v.name.startsWith("traffic."));

    expect(own.map((v) => v.name).sort()).toEqual([
      "traffic.rejoinClearLine",
      "traffic.rejoinHoldLine",
      "traffic.rejoinNoticeLine",
    ]);

    for (const v of own) {
      expect(v.description, v.name).toMatch(/\btraffic group\b/);
      expect(v.description.endsWith("."), v.name).toBe(true);
    }

    expect(conds.filter((c) => c.name.startsWith("traffic."))).toEqual([]);
    expect(
      cases
        .filter((c) => c.name.startsWith("traffic."))
        .map((c) => c.name)
        .sort(),
    ).toEqual(["traffic.pitExitNearestSide", "traffic.pitExitVerdict", "traffic.rejoinVerdict"]);
  });

  it("each line var resolves its own verdict's value to that value's size-one pool, and nothing otherwise", () => {
    const { vars } = stubEngine();
    const clear = vars.get("traffic.rejoinClearLine")!;
    const notice = vars.get("traffic.rejoinNoticeLine")!;
    const hold = vars.get("traffic.rejoinHoldLine")!;

    expect(clear(ctxOf(rejoinEvent("clear", 20)))).toEqual(poolRef("traffic", "rejoin-clear-20"));
    expect(notice(ctxOf(rejoinEvent("notice", 12)))).toEqual(poolRef("traffic", "rejoin-notice-12"));
    expect(hold(ctxOf(rejoinEvent("hold", 3)))).toEqual(poolRef("traffic", "rejoin-hold-3"));

    expect(hold(ctxOf(rejoinEvent("notice", 3)))).toBeNull();
    expect(clear(ctxOf(rejoinEvent("go")))).toBeNull();
    expect(hold(ctxOf(rejoinEvent("hold")))).toBeNull();
    expect(hold(ctxOf(pitExitEvent("traffic", 3)))).toBeNull();
    // An imperative fire carries no event.
    expect(hold(ctxOf(null))).toBeNull();
  });

  it("the verdict cases declare every verdict and read the fire's own event", () => {
    const { cases } = stubEngine();
    const rejoin = cases.get("traffic.rejoinVerdict")!;
    const pitExit = cases.get("traffic.pitExitVerdict")!;

    expect(Object.keys(rejoin.keys).sort()).toEqual([...REJOIN_VERDICTS].sort());
    expect(Object.keys(pitExit.keys).sort()).toEqual([...PIT_EXIT_VERDICTS].sort());

    for (const verdict of REJOIN_VERDICTS) expect(rejoin.resolve(ctxOf(rejoinEvent(verdict, 5)))).toBe(verdict);

    for (const verdict of PIT_EXIT_VERDICTS) expect(pitExit.resolve(ctxOf(pitExitEvent(verdict)))).toBe(verdict);

    expect(rejoin.resolve(ctxOf(pitExitEvent("clear")))).toBeNull();
    expect(pitExit.resolve(ctxOf(rejoinEvent("clear", 20)))).toBeNull();
    expect(rejoin.resolve(ctxOf(null))).toBeNull();
  });

  it("the nearest-side case reads the sign of the pit-exit seconds, and says nothing when no car was timed", () => {
    const { cases } = stubEngine();
    const side = cases.get("traffic.pitExitNearestSide")!;

    expect(Object.keys(side.keys).sort()).toEqual(["after", "before"]);
    expect(side.resolve(ctxOf(pitExitEvent("traffic", -1.5)))).toBe("before");
    expect(side.resolve(ctxOf(pitExitEvent("traffic", 0)))).toBe("after");
    expect(side.resolve(ctxOf(pitExitEvent("clear", 6.2)))).toBe("after");
    expect(side.resolve(ctxOf(pitExitEvent("traffic")))).toBeNull();
    expect(side.resolve(ctxOf(rejoinEvent("hold", 3)))).toBeNull();
  });
});

describe("the traffic lines through the engine", () => {
  it.each([
    ["clear", 20, "traffic/rejoin-clear-20-01.mp3"],
    ["notice", 12, "traffic/rejoin-notice-12-01.mp3"],
    ["notice", 2, "traffic/rejoin-notice-2-01.mp3"],
    ["hold", 4, "traffic/rejoin-hold-4-01.mp3"],
    ["hold", 1, "traffic/rejoin-hold-1-01.mp3"],
    ["hold", 14, "traffic/rejoin-hold-14-01.mp3"],
  ] as const)("a %s verdict at %i s plays that value's whole line, unframed", (verdict, seconds, clip) => {
    bus.publishEvent("traffic.rejoin", rejoinData(verdict, seconds));
    flush(audio);

    expect(voicePaths()).toEqual([`voice/${VOICE}/${clip}`]);
    expect(allPaths()).not.toContain(TICK_OPEN);
  });

  it("go plays its fixed line, unframed", () => {
    bus.publishEvent("traffic.rejoin", { verdict: "go" });
    flush(audio);

    expect(voicePaths()).toEqual([`voice/${VOICE}/traffic/rejoin-go-01.mp3`]);
    expect(allPaths()).not.toContain(TICK_OPEN);
  });

  it("a hold at 1 s is not taken for a take of the 14 s line, nor the reverse — each value is its own pool", () => {
    bus.publishEvent("traffic.rejoin", rejoinData("hold", 1));
    flush(audio);
    bus.publishEvent("traffic.rejoin", rejoinData("hold", 14));
    flush(audio);

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/traffic/rejoin-hold-1-01.mp3`,
      `voice/${VOICE}/traffic/rejoin-hold-14-01.mp3`,
    ]);
  });

  it.each([
    ["traffic", "traffic/pit-exit-traffic-01.mp3"],
    ["clear", "traffic/pit-exit-clear-01.mp3"],
  ] as const)("pit exit %s plays its line inside the radio frame", (verdict, clip) => {
    bus.publishEvent("traffic.pitExit", { verdict, seconds: 1.5 });
    flush(audio);

    expect(voicePaths()).toEqual([`voice/${VOICE}/${clip}`]);
    expect(allPaths()[0]).toBe(TICK_OPEN);
    expect(allPaths()).toContain(TICK_CLOSE);
  });

  it("a count the voice has no clip for skips the line whole (#835), and the next speakable verdict still plays", () => {
    bus.publishEvent("traffic.rejoin", rejoinData("hold", 9));
    bus.publishEvent("traffic.rejoin", rejoinData("notice", 33));
    bus.publishEvent("traffic.rejoin", rejoinData("clear", 45));
    flush(audio);

    expect(voicePaths()).toEqual([]);

    bus.publishEvent("traffic.rejoin", rejoinData("hold", 4));
    flush(audio);

    expect(voicePaths()).toEqual([`voice/${VOICE}/traffic/rejoin-hold-4-01.mp3`]);
  });

  it("a numbered verdict with no number says nothing", () => {
    bus.publishEvent("traffic.rejoin", rejoinData("hold"));
    flush(audio);

    expect(voicePaths()).toEqual([]);
  });
});

describe("scheduling against other lines", () => {
  it("a hold cuts an ordinary line mid-sentence", () => {
    bus.publishEvent("pitStall.entered", {});

    expect(voicePaths()).toEqual([CHATTER_CLIP]);

    bus.publishEvent("traffic.rejoin", rejoinData("hold", 4));

    expect(audio._stopped).toContain(AudioChannel.Voice);
    expect(voicePaths()).toEqual([CHATTER_CLIP, `voice/${VOICE}/traffic/rejoin-hold-4-01.mp3`]);
  });

  it("a notice lets the ordinary line finish, then plays", () => {
    bus.publishEvent("pitStall.entered", {});
    bus.publishEvent("traffic.rejoin", rejoinData("notice", 12));

    expect(voicePaths()).toEqual([CHATTER_CLIP]);
    expect(audio._stopped).not.toContain(AudioChannel.Voice);

    flush(audio);

    expect(voicePaths()).toEqual([CHATTER_CLIP, `voice/${VOICE}/traffic/rejoin-notice-12-01.mp3`]);
  });

  it("pit-exit traffic cuts an ordinary line; a clear pit exit waits for it", () => {
    bus.publishEvent("pitStall.entered", {});
    bus.publishEvent("traffic.pitExit", { verdict: "traffic", seconds: 1 });

    // Cut at once; the line itself follows the frame's open tick.
    expect(audio._stopped).toContain(AudioChannel.Voice);
    expect(allPaths().at(-1)).toBe(TICK_OPEN);

    flush(audio);

    expect(voicePaths()).toEqual([CHATTER_CLIP, `voice/${VOICE}/traffic/pit-exit-traffic-01.mp3`]);

    audio._reset();

    bus.publishEvent("pitStall.entered", {});
    bus.publishEvent("traffic.pitExit", { verdict: "clear", seconds: 7 });

    expect(audio._stopped).not.toContain(AudioChannel.Voice);

    flush(audio);

    expect(voicePaths()).toEqual([CHATTER_CLIP, `voice/${VOICE}/traffic/pit-exit-clear-01.mp3`]);
  });

  it("a newer verdict replaces the one in flight — go cuts a hold still playing", () => {
    bus.publishEvent("traffic.rejoin", rejoinData("hold", 4));
    bus.publishEvent("traffic.rejoin", { verdict: "go" });

    expect(audio._stopped).toContain(AudioChannel.Voice);
    expect(voicePaths()).toEqual([
      `voice/${VOICE}/traffic/rejoin-hold-4-01.mp3`,
      `voice/${VOICE}/traffic/rejoin-go-01.mp3`,
    ]);
  });

  it("a hold cannot cut a heavier line, and is dropped rather than queued behind it", () => {
    bus.publishEvent("pitStall.departed", {});
    bus.publishEvent("traffic.rejoin", rejoinData("hold", 4));
    flush(audio);

    expect(voicePaths()).toEqual([CRITICAL_CLIP]);
  });

  it("a newer verdict removes a waiting older one, so the stale number is never heard after it", () => {
    bus.publishEvent("pitStall.entered", {});
    // Both wait for the ordinary line (heavier, no interrupt): the notice
    // first, then the clear that replaced it.
    bus.publishEvent("traffic.rejoin", rejoinData("notice", 12));
    bus.publishEvent("traffic.rejoin", rejoinData("clear", 20));
    flush(audio);

    expect(voicePaths()).toEqual([CHATTER_CLIP, `voice/${VOICE}/traffic/rejoin-clear-20-01.mp3`]);
  });

  it("a verdict parked longer than its maximum wait is dropped, not spoken late", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    bus.publishEvent("pitStall.entered", {});
    bus.publishEvent("traffic.rejoin", rejoinData("notice", 12));

    vi.setSystemTime(TRAFFIC_MAX_QUEUE_WAIT_MS + 1);
    flush(audio);

    expect(voicePaths()).toEqual([CHATTER_CLIP]);
  });
});

describe("family wiring", () => {
  it("maps every rejoin verdict to the rejoin opt-in and both pit-exit verdicts to the pit-exit one", () => {
    expect(Object.keys(SCENARIO_ID_TO_TRAFFIC_ID).sort()).toEqual([...TRAFFIC_SCENARIO_IDS].sort());

    for (const verdict of REJOIN_VERDICTS) {
      expect(SCENARIO_ID_TO_TRAFFIC_ID[`pit-crew.traffic-rejoin-${verdict}`]).toBe("rejoin");
    }

    for (const verdict of PIT_EXIT_VERDICTS) {
      expect(SCENARIO_ID_TO_TRAFFIC_ID[`pit-crew.traffic-pit-exit-${verdict}`]).toBe("pit-exit");
    }
  });

  it("the clip sources are the three fixed lines the script addresses directly", () => {
    expect(TRAFFIC_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`)).toEqual([
      "traffic/rejoin-go",
      "traffic/pit-exit-traffic",
      "traffic/pit-exit-clear",
    ]);
  });

  it("the fixture compiles with nothing skipped", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
