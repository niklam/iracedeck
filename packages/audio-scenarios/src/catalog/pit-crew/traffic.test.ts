/**
 * Approaching-traffic tests (issue #1113, amended 2026-11-11).
 *
 * Nine contracts, one per line: six off `traffic.rejoin` (right behind, the
 * close band's first call and its count, more than ten, clear, and the group
 * call of amendment 2026-11-18), two off `traffic.pitExit` and the merge
 * warning off `traffic.pitExitMerge` (amended 2026-11-20). The close band's lines are composed: an intro or update
 * intro, the middle naming the seconds through the `traffic.rejoinSeconds`
 * var, and (on the first call) an outro. The fire-through cases run the
 * family through the real engine against a script fixture shaped like the
 * bundled one (a contract is silent without a script, and these tests are
 * about the contracts and the vocabulary, not the wording), and a hand-built
 * manifest whose clip set decides what is speakable. What the first-party
 * voices script and ship is `traffic-voices.test.ts`.
 *
 * Amended 2026-11-17: the warnings weigh {@link TRAFFIC_WARNING_WEIGHT}, so
 * they cut a caution or flag line and still yield to a CRITICAL line and the
 * spotter; and a count is an update only once the first call about the car
 * took the bus — the family's one module state, reset after every test.
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
import { TrkLoc } from "@iracedeck/iracing-sdk";
import type { TelemetryData } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { DEFAULT_MAX_QUEUE_WAIT_MS, NO_FRAME, poolRef, WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { PIT_READBACK_CONTRACTS } from "./readback.js";
import { TIRE_WEAR_CONTRACTS } from "./tire-wear.js";
import {
  _resetTrafficState,
  buildTrafficContracts,
  readTrafficDebugState,
  registerTrafficApproachTracking,
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
  TRAFFIC_WARNING_WEIGHT,
} from "./traffic.js";

const REJOIN_IDS = [
  "pit-crew.traffic-rejoin-right-behind",
  "pit-crew.traffic-rejoin-near-first",
  "pit-crew.traffic-rejoin-near-update",
  "pit-crew.traffic-rejoin-over-ten",
  "pit-crew.traffic-rejoin-clear",
  "pit-crew.traffic-rejoin-pack",
] as const;
const PIT_EXIT_IDS = ["pit-crew.traffic-pit-exit-traffic", "pit-crew.traffic-pit-exit-clear"] as const;
const PIT_EXIT_VERDICTS: readonly TrafficPitExitVerdict[] = ["traffic", "clear"];
/** The merge warning in the exit lane (amended 2026-11-20). */
const MERGE_ID = "pit-crew.traffic-pit-exit-merge";
/** Every line gated on the player still leaving the pits: both verdicts and the merge warning. */
const PIT_EXIT_GATED_IDS = [...PIT_EXIT_IDS, MERGE_ID] as const;

/** The lines whose words decay while they wait: the close calls, the pack line and the pit-exit warnings. */
const DECAYING_IDS = [
  "pit-crew.traffic-rejoin-right-behind",
  "pit-crew.traffic-rejoin-near-first",
  "pit-crew.traffic-rejoin-near-update",
  "pit-crew.traffic-rejoin-pack",
  "pit-crew.traffic-pit-exit-traffic",
  MERGE_ID,
] as const;

/** The warnings: the lines at TRAFFIC_WARNING_WEIGHT, which cut a caution line. */
const WARNING_IDS = DECAYING_IDS;

/** The reassuring lines, true for as long as they wait. */
const REASSURING_IDS = [
  "pit-crew.traffic-rejoin-over-ten",
  "pit-crew.traffic-rejoin-clear",
  "pit-crew.traffic-pit-exit-clear",
] as const;

/** One payload per rejoin line, keyed by the contract that must take it. */
const REJOIN_PAYLOADS: Record<(typeof REJOIN_IDS)[number], TrafficRejoin> = {
  "pit-crew.traffic-rejoin-right-behind": { verdict: "rightBehind" },
  "pit-crew.traffic-rejoin-near-first": { verdict: "near", seconds: 5, first: true },
  "pit-crew.traffic-rejoin-near-update": { verdict: "near", seconds: 5, first: false },
  "pit-crew.traffic-rejoin-over-ten": { verdict: "overTen" },
  "pit-crew.traffic-rejoin-clear": { verdict: "clear" },
  "pit-crew.traffic-rejoin-pack": { verdict: "pack" },
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

/** A queueable line at NORMAL weight, as the incident lines are: what a spin's entry "Clear to rejoin" arrives behind. */
const INCIDENT_LIKE_ID = "test.incident-like";
const INCIDENT_LIKE_CLIP = `voice/${VOICE}/test/incident-like-01.mp3`;
const INCIDENT_LIKE_CONTRACT: ScenarioContract = {
  id: INCIDENT_LIKE_ID,
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.NORMAL,
  queueable: true,
  frame: NO_FRAME,
  when: { event: "pitLane.exited" },
};

/** An equal-weight line of another family: a SAFETY call no traffic line may cut. */
const SAFETY_ID = "test.safety";
const SAFETY_CLIP = `voice/${VOICE}/test/safety-01.mp3`;
const SAFETY_CONTRACT: ScenarioContract = {
  id: SAFETY_ID,
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.SAFETY,
  queueable: false,
  frame: NO_FRAME,
  when: { event: "pitLane.entered" },
};

/**
 * A caution or flag line as the caution calls are: `WEIGHT.SAFETY`, queueable
 * with their 20 s wait, so a warning that cuts it leaves it to replay after.
 * Triggered off the debris flag, which no traffic contract hears.
 */
const CAUTION_LIKE_ID = "test.caution-like";
const CAUTION_LIKE_CLIP = `voice/${VOICE}/test/caution-like-01.mp3`;
const CAUTION_LIKE_CONTRACT: ScenarioContract = {
  id: CAUTION_LIKE_ID,
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  family: "flag",
  weight: WEIGHT.SAFETY,
  queueable: true,
  maxQueueWaitMs: 20_000,
  frame: NO_FRAME,
  when: { event: "flag.debris.raised" },
};

/**
 * The spotter's transition call as the spotter engine fires it: `PROXIMITY`,
 * `interrupt`, never queued. Triggered off the white flag, which no traffic
 * contract hears.
 */
const PROXIMITY_LIKE_ID = "test.proximity-like";
const PROXIMITY_LIKE_CLIP = `voice/${VOICE}/test/proximity-like-01.mp3`;
const PROXIMITY_LIKE_CONTRACT: ScenarioContract = {
  id: PROXIMITY_LIKE_ID,
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.PROXIMITY,
  interrupt: true,
  queueable: false,
  frame: NO_FRAME,
  when: { event: "flag.white.raised" },
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
    INCIDENT_LIKE_CLIP,
    SAFETY_CLIP,
    CAUTION_LIKE_CLIP,
    PROXIMITY_LIKE_CLIP,
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
    "pit-crew.traffic-rejoin-pack": { ...ENTRY, sequence: ["pool:traffic/rejoin-pack"] },
    "pit-crew.traffic-pit-exit-traffic": { ...ENTRY, sequence: ["pool:traffic/pit-exit-traffic"] },
    "pit-crew.traffic-pit-exit-clear": { ...ENTRY, sequence: ["pool:traffic/pit-exit-clear"] },
    [MERGE_ID]: { ...ENTRY, sequence: ["pool:traffic/pit-exit-merge"] },
    [CHATTER_ID]: { ...ENTRY, sequence: ["pool:test/chatter"] },
    [CRITICAL_ID]: { ...ENTRY, sequence: ["pool:test/critical"] },
    [INCIDENT_LIKE_ID]: { ...ENTRY, sequence: ["pool:test/incident-like"] },
    [SAFETY_ID]: { ...ENTRY, sequence: ["pool:test/safety"] },
    [CAUTION_LIKE_ID]: { ...ENTRY, sequence: ["pool:test/caution-like"] },
    [PROXIMITY_LIKE_ID]: { ...ENTRY, sequence: ["pool:test/proximity-like"] },
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

/** The clips of a first call ("Car coming in", the seconds, "Watch out.") and of an update ("Getting closer,", the seconds). */
const firstCall = (seconds: number): string[] => [
  clip("rejoin-intro"),
  clip(`rejoin-mid-${seconds}`),
  clip("rejoin-outro"),
];
const update = (seconds: number): string[] => [clip("rejoin-update"), clip(`rejoin-mid-${seconds}`)];

/** Play a first call to the end, so the car is introduced, and forget what was played. */
function introduce(seconds = 9): void {
  bus.publishEvent("traffic.rejoin", near(seconds, true));
  flush(audio);
  expect(readTrafficDebugState().introduced).toBe(true);
  audio._reset();
}

/** The first clip each line plays on the voice channel (a near call's lead-in; the rest follow). */
const LINE_CLIP: Record<string, string> = {
  "pit-crew.traffic-rejoin-right-behind": clip("rejoin-right-behind"),
  "pit-crew.traffic-rejoin-near-first": clip("rejoin-intro"),
  "pit-crew.traffic-rejoin-near-update": clip("rejoin-update"),
  "pit-crew.traffic-rejoin-over-ten": clip("rejoin-over-ten"),
  "pit-crew.traffic-rejoin-clear": clip("rejoin-clear"),
  "pit-crew.traffic-rejoin-pack": clip("rejoin-pack"),
  "pit-crew.traffic-pit-exit-traffic": clip("pit-exit-traffic"),
  "pit-crew.traffic-pit-exit-clear": clip("pit-exit-clear"),
  [MERGE_ID]: clip("pit-exit-merge"),
};

/** Publish the event `id`'s line answers (an update speaks only once {@link introduce} has run). */
function publishLine(id: string): void {
  if (id === MERGE_ID) {
    bus.publishEvent("traffic.pitExitMerge", { seconds: 1 });
  } else if (id.startsWith("pit-crew.traffic-pit-exit-")) {
    bus.publishEvent("traffic.pitExit", { verdict: id.endsWith("traffic") ? "traffic" : "clear", seconds: 1 });
  } else {
    bus.publishEvent("traffic.rejoin", REJOIN_PAYLOADS[id as (typeof REJOIN_IDS)[number]]);
  }
}

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function allPaths(): string[] {
  return audio._played.map((p) => p.path);
}

/** A fresh engine with `traffic` as the family's contracts, in the production order. */
function wire(traffic: readonly ScenarioContract[] = TRAFFIC_CONTRACTS): void {
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  // The production order (`registerPitCrew`): vocabulary, approach tracking, contracts, script.
  registerTrafficVocabulary(engine);
  registerTrafficApproachTracking(bus);

  for (const c of [
    ...traffic,
    CHATTER_CONTRACT,
    CRITICAL_CONTRACT,
    INCIDENT_LIKE_CONTRACT,
    SAFETY_CONTRACT,
    CAUTION_LIKE_CONTRACT,
    PROXIMITY_LIKE_CONTRACT,
    READBACK_EXIT,
    TIRE_WEAR_REPORT,
  ]) {
    engine.defineContract(c);
  }

  engine.setScripts(new Map([[VOICE, SCRIPT]]));
}

beforeEach(() => {
  wire();
});

afterEach(() => {
  _resetAudioScenarios();
  _resetTrafficState();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("TRAFFIC_CONTRACTS", () => {
  it("exports one contract per line, rejoin first in band order, in registration order", () => {
    expect(TRAFFIC_SCENARIO_IDS).toEqual([...REJOIN_IDS, ...PIT_EXIT_IDS, MERGE_ID]);
  });

  it("carries no sequence — what each line says is the voice script's", () => {
    for (const c of TRAFFIC_CONTRACTS) expect("sequence" in c).toBe(false);
  });

  it("shares one family, on the voice bus, every line queueable", () => {
    for (const c of TRAFFIC_CONTRACTS) {
      expect(c.family, c.id).toBe("traffic");
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.queueable, c.id).toBe(true);
    }
  });

  it("the warnings weigh TRAFFIC_WARNING_WEIGHT, strictly between SAFETY and CRITICAL; the reassuring lines SAFETY", () => {
    expect(TRAFFIC_WARNING_WEIGHT).toBe(85);
    expect(TRAFFIC_WARNING_WEIGHT).toBeGreaterThan(WEIGHT.SAFETY);
    expect(TRAFFIC_WARNING_WEIGHT).toBeLessThan(WEIGHT.CRITICAL);

    for (const id of WARNING_IDS) expect(contract(id).weight, id).toBe(TRAFFIC_WARNING_WEIGHT);

    for (const id of REASSURING_IDS) expect(contract(id).weight, id).toBe(WEIGHT.SAFETY);
  });

  it("every line carries a speak-time gate: the close calls' timing, the introduction's marking, the merge", () => {
    const gated = TRAFFIC_CONTRACTS.filter((c) => c.speakGate !== undefined).map((c) => c.id);

    expect(gated).toEqual([...TRAFFIC_SCENARIO_IDS]);

    for (const id of gated) {
      const text = contract(id).speakGate!.description;

      expect(text.endsWith("."), id).toBe(true);
      expect(text.length, id).toBeLessThanOrEqual(200);
    }
  });

  it("waits briefly for the bus on the lines whose words decay, and the engine default on the reassuring ones", () => {
    expect([...DECAYING_IDS, ...REASSURING_IDS].sort()).toEqual([...TRAFFIC_SCENARIO_IDS].sort());

    for (const id of DECAYING_IDS) expect(contract(id).maxQueueWaitMs, id).toBe(TRAFFIC_MAX_QUEUE_WAIT_MS);

    for (const id of REASSURING_IDS) expect(contract(id).maxQueueWaitMs, id).toBe(DEFAULT_MAX_QUEUE_WAIT_MS);

    expect(TRAFFIC_MAX_QUEUE_WAIT_MS).toBeLessThan(DEFAULT_MAX_QUEUE_WAIT_MS);
  });

  it("the close calls, the pack line, both pit-exit lines and the merge warning interrupt; more than ten and clear do not", () => {
    const interrupting = TRAFFIC_CONTRACTS.filter((c) => c.interrupt === true).map((c) => c.id);

    expect(interrupting).toEqual([
      "pit-crew.traffic-rejoin-right-behind",
      "pit-crew.traffic-rejoin-near-first",
      "pit-crew.traffic-rejoin-near-update",
      "pit-crew.traffic-rejoin-pack",
      "pit-crew.traffic-pit-exit-traffic",
      "pit-crew.traffic-pit-exit-clear",
      MERGE_ID,
    ]);
    expect(contract("pit-crew.traffic-rejoin-over-ten").interrupt).toBe(false);
    expect(contract("pit-crew.traffic-rejoin-clear").interrupt).toBe(false);
  });

  it("the rejoin lines are unframed; the pit-exit lines and the merge warning keep the default radio frame", () => {
    for (const id of REJOIN_IDS) expect(contract(id).frame, id).toBe(NO_FRAME);

    for (const id of PIT_EXIT_GATED_IDS) expect(contract(id).frame, id).toBeUndefined();
  });

  it("each trigger's lines share one supersede group, and the two triggers do not; the merge warning has none", () => {
    for (const id of REJOIN_IDS) expect(contract(id).supersedeGroup, id).toBe(TRAFFIC_REJOIN_SUPERSEDE_GROUP);

    for (const id of PIT_EXIT_IDS) expect(contract(id).supersedeGroup, id).toBe(TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP);

    expect(TRAFFIC_REJOIN_SUPERSEDE_GROUP).not.toBe(TRAFFIC_PIT_EXIT_SUPERSEDE_GROUP);
    // Said once, on an event of its own: a waiting call is never dropped for it, nor it for a flip.
    expect(contract(MERGE_ID).supersedeGroup).toBeUndefined();
  });

  /** The rejoin contracts whose `where:` takes `data` right now. */
  const takers = (data: TrafficRejoin): string[] =>
    REJOIN_IDS.filter((id) => contract(id).when?.where?.(rejoinEvent(data)) === true);

  it("once the car is introduced, each rejoin payload is taken by exactly one contract, the one for its line", () => {
    for (const id of REJOIN_IDS) expect(contract(id).when?.event).toBe("traffic.rejoin");

    introduce();

    for (const [owner, data] of Object.entries(REJOIN_PAYLOADS)) expect(takers(data), owner).toEqual([owner]);
  });

  it("before the car is introduced, a count is taken by the first call alone, and every other payload by its own line", () => {
    expect(readTrafficDebugState().introduced).toBe(false);

    for (const [owner, data] of Object.entries(REJOIN_PAYLOADS)) {
      const expected = owner === "pit-crew.traffic-rejoin-near-update" ? "pit-crew.traffic-rejoin-near-first" : owner;

      expect(takers(data), owner).toEqual([expected]);
    }
  });

  it("the where: checks are pure: asked twice they answer the same and the state does not move", () => {
    for (const introduced of [false, true]) {
      if (introduced) introduce();

      const before = readTrafficDebugState();

      for (const id of REJOIN_IDS) {
        for (const data of Object.values(REJOIN_PAYLOADS)) {
          const where = contract(id).when!.where!;
          const event = rejoinEvent(data);
          const once = where(event);

          expect(where(event), `${id} on ${JSON.stringify(data)}`).toBe(once);
        }
      }

      expect(readTrafficDebugState()).toEqual(before);
      expect(readTrafficDebugState().introduced).toBe(introduced);
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

  it("the merge warning fires on traffic.pitExitMerge, whatever its seconds, and on no pit-exit verdict", () => {
    const when = contract(MERGE_ID).when;

    expect(when?.event).toBe("traffic.pitExitMerge");
    expect(when?.where).toBeUndefined();

    for (const id of PIT_EXIT_IDS) expect(contract(id).when?.event, id).toBe("traffic.pitExit");
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
    // The middle closes the sentence its lead-in starts; it is not a sentence of its own.
    expect(own(vars)[0].description).toMatch(/closes the near line after its lead-in/);
    expect(own(vars)[0].description).not.toMatch(/whole sentence/);
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

  it("the first-call condition is true on the call that introduces the car, and never on another line", () => {
    const first = stubEngine().conds.get("traffic.rejoinFirst")!;

    for (const introduced of [false, true]) {
      if (introduced) introduce();

      expect(first(ctxOf(rejoinEvent(near(6, true))))).toBe(true);
      expect(first(ctxOf(rejoinEvent({ verdict: "rightBehind" })))).toBe(false);
      expect(first(ctxOf(rejoinEvent({ verdict: "clear" })))).toBe(false);
      expect(first(ctxOf(pitExitEvent("clear")))).toBe(false);
      expect(first(ctxOf(null))).toBe(false);
    }
  });

  it("the first-call condition is true on a count while no first call was heard, and false on one after it", () => {
    const first = stubEngine().conds.get("traffic.rejoinFirst")!;

    expect(first(ctxOf(rejoinEvent(near(6, false))))).toBe(true);

    introduce();

    expect(first(ctxOf(rejoinEvent(near(6, false))))).toBe(false);
    // Pure: asking changed nothing.
    expect(readTrafficDebugState().introduced).toBe(true);
  });

  it("the band and pit-exit verdict cases declare every verdict and read the fire's own event", () => {
    const { cases } = stubEngine();
    const band = cases.get("traffic.rejoinBand")!;
    const pitExit = cases.get("traffic.pitExitVerdict")!;
    const payloads = Object.values(REJOIN_PAYLOADS);

    expect(Object.keys(band.keys).sort()).toEqual(["clear", "near", "overTen", "pack", "rightBehind"]);
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

  it("a count after the first call is the update intro and the seconds, unframed", () => {
    introduce();
    bus.publishEvent("traffic.rejoin", near(2, false));
    flush(audio);

    expect(voicePaths()).toEqual(update(2));
    expect(allPaths()).not.toContain(TICK_OPEN);
  });

  it("the middle draws from its number's takes, the voice's different wordings", () => {
    const heard = new Set<string>();

    introduce();

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

  it("a count the voice has no middle for skips the line whole (#835), and the next speakable one is the first call", () => {
    bus.publishEvent("traffic.rejoin", near(4, true));
    bus.publishEvent("traffic.rejoin", near(7, false));
    flush(audio);

    expect(voicePaths()).toEqual([]);
    // A skipped first call never took the bus, so it introduced nothing.
    expect(readTrafficDebugState().introduced).toBe(false);

    bus.publishEvent("traffic.rejoin", near(9, false));
    flush(audio);

    expect(voicePaths()).toEqual(firstCall(9));
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
    // An update is spoken only about a car the driver has heard of.
    if (id === "pit-crew.traffic-rejoin-near-update") introduce();

    bus.publishEvent("pitStall.entered", {});

    expect(voicePaths()).toEqual([CHATTER_CLIP]);

    bus.publishEvent("traffic.rejoin", REJOIN_PAYLOADS[id]);

    expect(audio._stopped).toContain(AudioChannel.Voice);
    expect(voicePaths()).toEqual([CHATTER_CLIP, LINE_CLIP[id]]);
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

  it.each(PIT_EXIT_VERDICTS)(
    "the merge warning arriving while the pit exit %s call plays cuts it, the newer line of one family",
    (verdict) => {
      bus.publishEvent("traffic.pitExit", { verdict, seconds: 1 });
      // The radio frame's open tick, then the call's words.
      audio._triggerChannelEnd(AudioChannel.SFX);
      expect(voicePaths()).toEqual([clip(`pit-exit-${verdict}`)]);

      bus.publishEvent("traffic.pitExitMerge", { seconds: 1 });

      expect(audio._stopped).toContain(AudioChannel.Voice);

      flush(audio);

      expect(voicePaths()).toEqual([clip(`pit-exit-${verdict}`), clip("pit-exit-merge")]);
    },
  );

  it("a newer line replaces the one in flight — a count cuts the first call still playing", () => {
    bus.publishEvent("traffic.rejoin", near(9, true));
    bus.publishEvent("traffic.rejoin", near(5, false));

    expect(audio._stopped).toContain(AudioChannel.Voice);
    expect(voicePaths()[0]).toBe(clip("rejoin-intro"));
    expect(voicePaths()[1]).toBe(clip("rejoin-update"));

    flush(audio);

    expect(voicePaths()).not.toContain(clip("rejoin-outro"));
  });

  it("a close call cannot cut a heavier line: it waits behind it and plays once it has finished", () => {
    bus.publishEvent("pitStall.departed", {});
    bus.publishEvent("traffic.rejoin", { verdict: "rightBehind" });

    expect(audio._stopped).not.toContain(AudioChannel.Voice);

    flush(audio);

    expect(voicePaths()).toEqual([CRITICAL_CLIP, clip("rejoin-right-behind")]);
  });

  it("the entry clear arriving while a queueable NORMAL line plays waits for it, and is not lost", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    // The incident line after a spin takes the bus; the entry clear, heavier
    // but no interrupt, waits for it.
    bus.publishEvent("pitLane.exited", {});
    bus.publishEvent("traffic.rejoin", { verdict: "clear" });
    expect(voicePaths()).toEqual([INCIDENT_LIKE_CLIP]);

    // The line in flight runs on past the counting lines' short wait.
    vi.setSystemTime(TRAFFIC_MAX_QUEUE_WAIT_MS + 1_000);
    flush(audio);

    expect(voicePaths()).toEqual([INCIDENT_LIKE_CLIP, clip("rejoin-clear")]);
  });

  it.each(REASSURING_IDS)("%s waits for an equal-weight line of another family instead of being dropped", (id) => {
    bus.publishEvent("pitLane.entered", {});
    publishLine(id);

    expect(voicePaths()).toEqual([SAFETY_CLIP]);
    expect(audio._stopped).not.toContain(AudioChannel.Voice);

    flush(audio);

    expect(voicePaths()).toEqual([SAFETY_CLIP, LINE_CLIP[id]]);
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

  describe("a line parked longer than its maximum wait is dropped, not spoken late", () => {
    /** Parks `publish` behind the CRITICAL line, then lets the bus go `waitedMs` later. */
    function parkedFor(waitedMs: number, publish: () => void): string[] {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      bus.publishEvent("pitStall.departed", {});
      publish();
      vi.setSystemTime(waitedMs);
      flush(audio);

      return voicePaths();
    }

    it.each([
      ["a close call", () => bus.publishEvent("traffic.rejoin", near(5, true))],
      ["the pit-exit traffic warning", () => bus.publishEvent("traffic.pitExit", { verdict: "traffic", seconds: 1 })],
    ] as const)("%s, after TRAFFIC_MAX_QUEUE_WAIT_MS", (_, publish) => {
      expect(parkedFor(TRAFFIC_MAX_QUEUE_WAIT_MS + 1, publish)).toEqual([CRITICAL_CLIP]);
    });

    const reassuring = [
      ["more than ten", () => bus.publishEvent("traffic.rejoin", { verdict: "overTen" }), clip("rejoin-over-ten")],
      ["clear to rejoin", () => bus.publishEvent("traffic.rejoin", { verdict: "clear" }), clip("rejoin-clear")],
      [
        "the pit-exit clear",
        () => bus.publishEvent("traffic.pitExit", { verdict: "clear", seconds: 6 }),
        clip("pit-exit-clear"),
      ],
    ] as const;

    it.each(reassuring)("%s still plays past the short wait: it stays true while it waits", (_, publish, line) => {
      expect(parkedFor(TRAFFIC_MAX_QUEUE_WAIT_MS + 1, publish)).toEqual([CRITICAL_CLIP, line]);
    });

    it.each(reassuring)("%s, after the engine default", (_, publish) => {
      expect(parkedFor(DEFAULT_MAX_QUEUE_WAIT_MS + 1, publish)).toEqual([CRITICAL_CLIP]);
    });
  });
});

describe("a line is never heard after the moment it warns about", () => {
  /** The fire's context for `data` published at 0 and reaching the radio `ageMs` later. */
  const aged = (data: TrafficRejoin, ageMs: number): ScenarioContext => ({ ...ctxOf(rejoinEvent(data)), now: ageMs });
  const admit = (id: string, ctx: ScenarioContext): boolean => contract(id).speakGate!.admit(ctx);

  describe("a close call is dropped once it has waited as long as its prediction", () => {
    it.each([
      ["right behind, at two seconds", "pit-crew.traffic-rejoin-right-behind", { verdict: "rightBehind" }, 2_000],
      ["a first call, under its seconds", "pit-crew.traffic-rejoin-near-first", near(5, true), 4_999],
      ["an update, under its seconds", "pit-crew.traffic-rejoin-near-update", near(5, false), 4_999],
    ] satisfies Array<[string, string, TrafficRejoin, number]>)("admits %s", (_, id, data, lastMs) => {
      expect(admit(id, aged(data, 0))).toBe(true);
      expect(admit(id, aged(data, lastMs))).toBe(true);
    });

    it.each([
      ["right behind, past two seconds", "pit-crew.traffic-rejoin-right-behind", { verdict: "rightBehind" }, 2_001],
      ["a first call, at its seconds", "pit-crew.traffic-rejoin-near-first", near(5, true), 5_000],
      ["an update, at its seconds", "pit-crew.traffic-rejoin-near-update", near(5, false), 5_000],
      ["a first call at two seconds, past them", "pit-crew.traffic-rejoin-near-first", near(2, true), 2_500],
    ] satisfies Array<[string, string, TrafficRejoin, number]>)("refuses %s", (_, id, data, ageMs) => {
      expect(admit(id, aged(data, ageMs))).toBe(false);
    });

    it("admits an imperative fire, an event with no usable timestamp and a clock that stepped back", () => {
      for (const id of ["pit-crew.traffic-rejoin-right-behind", "pit-crew.traffic-rejoin-near-update"]) {
        expect(admit(id, { ...ctxOf(null), now: 60_000 }), id).toBe(true);
        expect(
          admit(id, { ...ctxOf({ ...rejoinEvent(near(5, false)), timestamp: Number.NaN }), now: 60_000 }),
          id,
        ).toBe(true);
        expect(admit(id, { ...aged(near(5, false), 0), now: -60_000 }), id).toBe(true);
      }
    });

    it("a first call refused as late introduces nothing: the claim comes after the check", () => {
      expect(admit("pit-crew.traffic-rejoin-near-first", aged(near(5, true), 5_000))).toBe(false);
      expect(readTrafficDebugState().introduced).toBe(false);

      expect(admit("pit-crew.traffic-rejoin-near-first", aged(near(5, true), 0))).toBe(true);
      expect(readTrafficDebugState().introduced).toBe(true);
    });

    /** Parks `data`'s line behind the CRITICAL line at 0, then lets the bus go `waitedMs` later. */
    function parkedFor(waitedMs: number, data: TrafficRejoin): string[] {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      bus.publishEvent("pitStall.departed", {});
      bus.publishEvent("traffic.rejoin", data);
      vi.setSystemTime(waitedMs);
      flush(audio);

      return voicePaths();
    }

    it("right behind waiting behind a CRITICAL line is dropped once the car has arrived, inside its short wait", () => {
      expect(parkedFor(2_500, { verdict: "rightBehind" })).toEqual([CRITICAL_CLIP]);
    });

    it("right behind waiting less than two seconds still plays", () => {
      expect(parkedFor(1_500, { verdict: "rightBehind" })).toEqual([CRITICAL_CLIP, clip("rejoin-right-behind")]);
    });

    it("a first call about a car two seconds away is dropped after waiting 2.5 s, and introduces nothing", () => {
      expect(parkedFor(2_500, near(2, true))).toEqual([CRITICAL_CLIP]);
      expect(readTrafficDebugState().introduced).toBe(false);
    });

    it("a first call about a car nine seconds away still plays after the same wait", () => {
      // Nine: the fixture ships one take of that middle, so the clips are fixed.
      expect(parkedFor(2_500, near(9, true))).toEqual([CRITICAL_CLIP, ...firstCall(9)]);
    });
  });

  describe("a pit-exit line is dropped once the player is back on the racing surface", () => {
    let telemetry: Partial<TelemetryData> | null;
    const live = buildTrafficContracts({ getLatestTelemetry: () => telemetry as TelemetryData | null });
    const liveAdmit = (id: string): boolean =>
      live.find((c) => c.id === id)!.speakGate!.admit({ ...ctxOf(pitExitEvent("traffic", 1)), now: 0 });

    beforeEach(() => {
      telemetry = null;
    });

    it.each(PIT_EXIT_GATED_IDS)("%s: refused on track or beside it, admitted in the exit lane or the stall", (id) => {
      for (const [surface, admitted] of [
        [TrkLoc.OnTrack, false],
        [TrkLoc.OffTrack, false],
        [TrkLoc.AproachingPits, true],
        [TrkLoc.InPitStall, true],
      ] as const) {
        telemetry = { PlayerTrackSurface: surface };
        expect(liveAdmit(id), `${id} on ${surface}`).toBe(admitted);
      }
    });

    it.each(PIT_EXIT_GATED_IDS)("%s: admitted with no telemetry or no surface read (the harness)", (id) => {
      telemetry = null;
      expect(liveAdmit(id)).toBe(true);

      telemetry = {};
      expect(liveAdmit(id)).toBe(true);
    });

    it.each(PIT_EXIT_VERDICTS)("%s waiting behind a CRITICAL line is dropped once the player has merged", (verdict) => {
      _resetAudioScenarios();
      _resetTrafficState();
      wire(live);
      telemetry = { PlayerTrackSurface: TrkLoc.AproachingPits };
      bus.publishEvent("pitStall.departed", {});
      bus.publishEvent("traffic.pitExit", { verdict, seconds: 1 });
      telemetry = { PlayerTrackSurface: TrkLoc.OnTrack };
      flush(audio);

      expect(voicePaths()).toEqual([CRITICAL_CLIP]);
    });

    it.each(PIT_EXIT_VERDICTS)(
      "%s waiting behind a CRITICAL line still plays while the player is in the exit lane",
      (verdict) => {
        _resetAudioScenarios();
        _resetTrafficState();
        wire(live);
        telemetry = { PlayerTrackSurface: TrkLoc.AproachingPits };
        bus.publishEvent("pitStall.departed", {});
        bus.publishEvent("traffic.pitExit", { verdict, seconds: 1 });
        flush(audio);

        expect(voicePaths()).toEqual([CRITICAL_CLIP, clip(`pit-exit-${verdict}`)]);
      },
    );

    it.each([
      ["dropped once the player has merged", TrkLoc.OnTrack, [CRITICAL_CLIP]],
      [
        "still played while the player is in the exit lane",
        TrkLoc.AproachingPits,
        [CRITICAL_CLIP, clip("pit-exit-merge")],
      ],
    ] as const)("the merge warning waiting behind a CRITICAL line is %s", (_, surface, heard) => {
      _resetAudioScenarios();
      _resetTrafficState();
      wire(live);
      telemetry = { PlayerTrackSurface: TrkLoc.AproachingPits };
      bus.publishEvent("pitStall.departed", {});
      bus.publishEvent("traffic.pitExitMerge", { seconds: 1 });
      telemetry = { PlayerTrackSurface: surface };
      flush(audio);

      expect(voicePaths()).toEqual(heard);
    });
  });
});

describe("the warnings outrank a caution or flag line, not a CRITICAL line or the spotter (amended 2026-11-17)", () => {
  /** Publish `id`'s line, introducing the car first when the line is an update. */
  function publishWarning(id: string): void {
    if (id === "pit-crew.traffic-rejoin-near-update") introduce();

    publishLine(id);
  }

  it.each(WARNING_IDS)("%s cuts a caution line, which replays after it", (id) => {
    if (id === "pit-crew.traffic-rejoin-near-update") introduce();

    bus.publishEvent("flag.debris.raised", {});

    expect(voicePaths()).toEqual([CAUTION_LIKE_CLIP]);

    publishLine(id);

    expect(audio._stopped).toContain(AudioChannel.Voice);

    flush(audio);

    const heard = voicePaths();

    expect(heard[0]).toBe(CAUTION_LIKE_CLIP);
    expect(heard[1]).toBe(LINE_CLIP[id]);
    expect(heard.at(-1)).toBe(CAUTION_LIKE_CLIP);

    for (const path of heard.slice(1, -1)) expect(path).toMatch(/\/traffic\//);
  });

  it.each(REASSURING_IDS)("%s does not cut a caution line: it plays after it", (id) => {
    bus.publishEvent("flag.debris.raised", {});
    publishLine(id);

    expect(audio._stopped).not.toContain(AudioChannel.Voice);

    flush(audio);

    expect(voicePaths()).toEqual([CAUTION_LIKE_CLIP, LINE_CLIP[id]]);
  });

  it.each(WARNING_IDS)("%s does not cut a CRITICAL line: it waits behind it and plays once it has finished", (id) => {
    if (id === "pit-crew.traffic-rejoin-near-update") introduce();

    bus.publishEvent("pitStall.departed", {});
    publishLine(id);

    expect(audio._stopped).not.toContain(AudioChannel.Voice);

    flush(audio);

    expect(voicePaths().slice(0, 2)).toEqual([CRITICAL_CLIP, LINE_CLIP[id]]);
  });

  it.each(WARNING_IDS)("%s waiting behind a CRITICAL line past its short wait is dropped", (id) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    if (id === "pit-crew.traffic-rejoin-near-update") introduce();

    bus.publishEvent("pitStall.departed", {});
    publishLine(id);
    vi.setSystemTime(TRAFFIC_MAX_QUEUE_WAIT_MS + 1);
    flush(audio);

    expect(voicePaths()).toEqual([CRITICAL_CLIP]);
  });

  it.each(WARNING_IDS)("a spotter call cuts %s, which replays after it within its short wait", (id) => {
    publishWarning(id);

    // The pit-exit warning opens with the radio frame's tick; let its words start.
    if (id.includes("pit-exit")) audio._triggerChannelEnd(AudioChannel.SFX);

    expect(voicePaths().at(-1)).toBe(LINE_CLIP[id]);

    const stoppedBefore = audio._stopped.length;

    bus.publishEvent("flag.white.raised", {});

    expect(audio._stopped.slice(stoppedBefore)).toContain(AudioChannel.Voice);
    expect(voicePaths().at(-1)).toBe(PROXIMITY_LIKE_CLIP);

    flush(audio);

    const afterSpotter = voicePaths().slice(voicePaths().indexOf(PROXIMITY_LIKE_CLIP) + 1);

    expect(afterSpotter[0]).toBe(LINE_CLIP[id]);
  });
});

describe("a count is an update only once the first call about the car was heard (amended 2026-11-17)", () => {
  it("a first call dropped behind a CRITICAL line introduces nothing, so the next count is spoken as the first call", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    bus.publishEvent("pitStall.departed", {});
    bus.publishEvent("traffic.rejoin", near(5, true));
    vi.setSystemTime(TRAFFIC_MAX_QUEUE_WAIT_MS + 1);
    flush(audio);

    expect(voicePaths()).toEqual([CRITICAL_CLIP]);
    expect(readTrafficDebugState().introduced).toBe(false);

    audio._reset();
    bus.publishEvent("traffic.rejoin", near(2, false));
    flush(audio);

    expect(voicePaths()).toEqual(firstCall(2));
    expect(readTrafficDebugState().introduced).toBe(true);
  });

  it("a first call replaced in the queue by the next count leaves that count to be spoken as the first call", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    bus.publishEvent("pitStall.departed", {});
    bus.publishEvent("traffic.rejoin", near(9, true));
    vi.setSystemTime(2_000);
    bus.publishEvent("traffic.rejoin", near(2, false));
    flush(audio);

    expect(voicePaths()).toEqual([CRITICAL_CLIP, ...firstCall(2)]);
  });

  it("a count that introduces the car on an idle bus is spoken once, as the first call, not again as the update", () => {
    // The first call's admit introduces the car before the update contract's
    // `where:` is asked about the same event.
    bus.publishEvent("traffic.rejoin", near(2, false));
    flush(audio);

    expect(voicePaths()).toEqual(firstCall(2));
    expect(audio._stopped).not.toContain(AudioChannel.Voice);
  });

  it("a count after a first call that was heard is the update", () => {
    bus.publishEvent("traffic.rejoin", near(9, true));
    flush(audio);
    bus.publishEvent("traffic.rejoin", near(5, false));
    flush(audio);
    bus.publishEvent("traffic.rejoin", near(2, false));
    flush(audio);

    expect(voicePaths().slice(0, 3)).toEqual(firstCall(9));
    expect(voicePaths()[3]).toBe(clip("rejoin-update"));
    expect(voicePaths().slice(5)).toEqual(update(2));
  });

  it.each([
    ["more than ten", { verdict: "overTen" }],
    ["clear to rejoin", { verdict: "clear" }],
  ] as const)("%s ends the approach: the next car's count is spoken as a first call", (_, data) => {
    introduce();
    bus.publishEvent("traffic.rejoin", data);
    flush(audio);

    expect(readTrafficDebugState().introduced).toBe(false);

    audio._reset();
    bus.publishEvent("traffic.rejoin", near(2, false));
    flush(audio);

    expect(voicePaths()).toEqual(firstCall(2));
  });

  it("a reassuring line that never took the bus ends nothing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    introduce();
    bus.publishEvent("pitStall.departed", {});
    bus.publishEvent("traffic.rejoin", { verdict: "clear" });
    vi.setSystemTime(DEFAULT_MAX_QUEUE_WAIT_MS + 1);
    flush(audio);

    expect(voicePaths()).toEqual([CRITICAL_CLIP]);
    expect(readTrafficDebugState().introduced).toBe(true);
  });

  describe("the pack line (amended 2026-11-18)", () => {
    it("ends the approach once heard: a count after it names no car the driver was told the seconds of", () => {
      introduce();
      bus.publishEvent("traffic.rejoin", { verdict: "pack" });
      flush(audio);

      expect(voicePaths()).toEqual([clip("rejoin-pack")]);
      expect(readTrafficDebugState().introduced).toBe(false);

      audio._reset();
      bus.publishEvent("traffic.rejoin", near(2, false));
      flush(audio);

      expect(voicePaths()).toEqual(firstCall(2));
    });

    it("leaves a lone car after the group its first call", () => {
      bus.publishEvent("traffic.rejoin", { verdict: "pack" });
      flush(audio);
      audio._reset();
      bus.publishEvent("traffic.rejoin", near(9, true));
      flush(audio);
      bus.publishEvent("traffic.rejoin", near(2, false));
      flush(audio);

      expect(voicePaths()).toEqual([...firstCall(9), ...update(2)]);
    });

    it("ends nothing when it never took the bus", () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      introduce();
      bus.publishEvent("pitStall.departed", {});
      bus.publishEvent("traffic.rejoin", { verdict: "pack" });
      vi.setSystemTime(TRAFFIC_MAX_QUEUE_WAIT_MS + 1);
      flush(audio);

      expect(voicePaths()).toEqual([CRITICAL_CLIP]);
      expect(readTrafficDebugState().introduced).toBe(true);
    });

    it("cuts a first call still playing, as a newer line of the family", () => {
      bus.publishEvent("traffic.rejoin", near(9, true));
      bus.publishEvent("traffic.rejoin", { verdict: "pack" });

      expect(audio._stopped).toContain(AudioChannel.Voice);

      flush(audio);

      expect(voicePaths()).toEqual([clip("rejoin-intro"), clip("rejoin-pack")]);
    });
  });

  it("right behind needs no introduction and leaves the introduction alone", () => {
    bus.publishEvent("traffic.rejoin", { verdict: "rightBehind" });
    flush(audio);

    expect(voicePaths()).toEqual([clip("rejoin-right-behind")]);
    expect(readTrafficDebugState().introduced).toBe(false);

    introduce();
    bus.publishEvent("traffic.rejoin", { verdict: "rightBehind" });
    flush(audio);

    expect(readTrafficDebugState().introduced).toBe(true);
  });

  it("a new approach starts unintroduced: its first call dropped, the next count is a first call", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // The last stop's car was introduced, and the episode ended silently as
    // the driver drove off: no reassuring line.
    introduce();
    bus.publishEvent("pitStall.departed", {});
    bus.publishEvent("traffic.rejoin", near(5, true));

    expect(readTrafficDebugState().introduced).toBe(false);

    vi.setSystemTime(TRAFFIC_MAX_QUEUE_WAIT_MS + 1);
    flush(audio);
    audio._reset();
    bus.publishEvent("traffic.rejoin", near(2, false));
    flush(audio);

    expect(voicePaths()).toEqual(firstCall(2));
  });

  it.each([
    ["the tracking hears the event first", false],
    ["the engine hears the event first", true],
  ] as const)("a first call that takes the bus at once stays introduced when %s", (_, trackAfterContracts) => {
    if (trackAfterContracts) {
      // Subscribe again, behind the contracts' own handlers.
      _resetTrafficState();
      registerTrafficApproachTracking(bus);
    }

    introduce();
    bus.publishEvent("traffic.rejoin", near(9, true));

    expect(readTrafficDebugState().introduced).toBe(true);

    flush(audio);
    audio._reset();
    bus.publishEvent("traffic.rejoin", near(2, false));
    flush(audio);

    expect(voicePaths()).toEqual(update(2));
  });

  it("a session change forgets the introduction", () => {
    introduce();
    bus.publishEvent("session.changed", { from: 0, to: 1 });

    expect(readTrafficDebugState().introduced).toBe(false);

    bus.publishEvent("traffic.rejoin", near(2, false));
    flush(audio);

    expect(voicePaths()).toEqual(firstCall(2));
  });

  it("the snapshot reader reports the tracking and the introduction, and a reset clears both", () => {
    expect(readTrafficDebugState()).toEqual({ registered: true, introduced: false });

    introduce();

    expect(readTrafficDebugState()).toEqual({ registered: true, introduced: true });

    _resetTrafficState();

    expect(readTrafficDebugState()).toEqual({ registered: false, introduced: false });
  });

  it("tracking on another bus starts from no introduction and stops listening on the old one", () => {
    introduce();

    const other = createMockBus();

    registerTrafficApproachTracking(other);

    expect(readTrafficDebugState().introduced).toBe(false);

    // The engine still speaks on the first bus; its session change is no longer heard.
    introduce();
    bus.publishEvent("session.changed", { from: 0, to: 1 });

    expect(readTrafficDebugState().introduced).toBe(true);

    other.publishEvent("session.changed", { from: 0, to: 1 });

    expect(readTrafficDebugState().introduced).toBe(false);
  });
});

describe("family wiring", () => {
  it("maps every rejoin line to the rejoin opt-in, and both pit-exit lines and the merge warning to the pit-exit one", () => {
    expect(Object.keys(SCENARIO_ID_TO_TRAFFIC_ID).sort()).toEqual([...TRAFFIC_SCENARIO_IDS].sort());

    for (const id of REJOIN_IDS) expect(SCENARIO_ID_TO_TRAFFIC_ID[id], id).toBe("rejoin");

    for (const id of PIT_EXIT_GATED_IDS) expect(SCENARIO_ID_TO_TRAFFIC_ID[id], id).toBe("pit-exit");
  });

  it("the clip sources are the pools the script addresses directly, the middles left to the var", () => {
    expect(TRAFFIC_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`)).toEqual([
      "traffic/rejoin-intro",
      "traffic/rejoin-outro",
      "traffic/rejoin-update",
      "traffic/rejoin-right-behind",
      "traffic/rejoin-over-ten",
      "traffic/rejoin-clear",
      "traffic/rejoin-pack",
      "traffic/pit-exit-traffic",
      "traffic/pit-exit-clear",
      "traffic/pit-exit-merge",
    ]);
  });

  it("the fixture compiles with nothing skipped", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
