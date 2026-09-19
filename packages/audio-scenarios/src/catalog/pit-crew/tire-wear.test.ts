/**
 * Tire-wear family tests (issue #1108).
 *
 * One contract fired by `tireWear.reported`; what it SAYS is the bundled
 * voice's `callouts.json`, so the fire-through cases hand the real artifact to
 * the engine and read what played. The vocabulary reads the fire's own event
 * payload, which the resolver cases below pin directly, and the scheduling
 * case registers the exit readback beside it to show the report queuing
 * behind the line the translator publishes just before it.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type {
  IEventBus,
  SimEventMap,
  SimEventName,
  SimEventOf,
  TireCorner,
  TireWearReport,
  TireZone,
} from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContext } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import { descriptionNamesGroup } from "../../reference/pack-reference.js";
import { PIT_READBACK_CONTRACTS, registerReadbackVocabulary } from "./readback.js";
import {
  hasSpeakableTreads,
  registerTireWearVocabulary,
  resolveCornerTread,
  resolveHasWear,
  resolveHeaviestSpot,
  resolveHeaviestTread,
  TIRE_WEAR_CLIP_SOURCES,
  TIRE_WEAR_CONTRACTS,
  TIRE_WEAR_CORNER_KEYS,
  TIRE_WEAR_SCENARIO_IDS,
  TIRE_WEAR_SPOT_KEYS,
  TIRE_WEAR_ZONE_KEYS,
} from "./tire-wear.js";

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

function flush(audio: FakeAudio, iterations = 60): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const VOICE = "luca";

/** The number clips the tread vars draw — the bundled voice records 0–150; the fixture stops at 100 so a reading past it can be shown to abort. */
const NUMBER_CLIPS = Array.from({ length: 101 }, (_, n) => `voice/${VOICE}/session-start-temp-numbers/${n}.mp3`);

/** The exit readback's two lines, for the scheduling case (a null snapshot reads back as the empty fallback). */
const READBACK_CLIPS = [
  `voice/${VOICE}/pit-readback/opener-exit-01.mp3`,
  `voice/${VOICE}/pit-readback/empty-fallback-01.mp3`,
];

/** One clip per source for the test voice, so a pool draw is deterministic and a played path names its pool. */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...TIRE_WEAR_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
    ...NUMBER_CLIPS,
    ...READBACK_CLIPS,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled voice's script, verbatim. The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to the entries this file's engine holds — the
 * report and the exit readback beside it for the scheduling case — and to the
 * one fragment the readback includes. An entry for a contract the engine does
 * not hold would be a `no contract` warn.
 */
const TIRE_WEAR_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(
    [...TIRE_WEAR_SCENARIO_IDS, "pit-crew.pit-readback-exit"].map((id) => [id, SCRIPT.scenarios[id]]),
  ),
  fragments: { "readback-body": SCRIPT.fragments?.["readback-body"] ?? { sequence: [] } },
};

/** The report entry alone — what the reference/coverage checks below read. */
const REPORT_ONLY_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(TIRE_WEAR_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

/** Stop 1 of the 2026-09-19 capture, in percent: iRacing's fractions × 100, zones in the car's inside/middle/outside. */
const REPORT: TireWearReport = {
  corners: {
    lf: { inside: 98.3, middle: 98.4, outside: 99.1, tread: 98.3, zone: "inside" },
    rf: { inside: 98.6, middle: 98.8, outside: 99.6, tread: 98.6, zone: "inside" },
    lr: { inside: 98.6, middle: 98.6, outside: 99.0, tread: 98.6, zone: "inside" },
    rr: { inside: 98.9, middle: 98.9, outside: 99.7, tread: 98.9, zone: "inside" },
  },
  heaviest: { corner: "lf", zone: "inside" },
};

/** An untouched set: every zone reads 100, so `heaviest` is only the tie-break's first pick. */
const UNWORN: TireWearReport = {
  corners: {
    lf: { inside: 100, middle: 100, outside: 100, tread: 100, zone: "inside" },
    rf: { inside: 100, middle: 100, outside: 100, tread: 100, zone: "inside" },
    lr: { inside: 100, middle: 100, outside: 100, tread: 100, zone: "inside" },
    rr: { inside: 100, middle: 100, outside: 100, tread: 100, zone: "inside" },
  },
  heaviest: { corner: "lf", zone: "inside" },
};

/** A report whose numbers are all distinct, so a played number names its tire. */
const DISTINCT: TireWearReport = {
  corners: {
    lf: { inside: 89.2, middle: 90.4, outside: 91.1, tread: 89.2, zone: "inside" },
    rf: { inside: 90.6, middle: 91.3, outside: 92.8, tread: 90.6, zone: "inside" },
    lr: { inside: 87.9, middle: 87.4, outside: 88.6, tread: 87.4, zone: "middle" },
    rr: { inside: 85.3, middle: 86.1, outside: 88.0, tread: 85.3, zone: "inside" },
  },
  heaviest: { corner: "rr", zone: "inside" },
};

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;

beforeEach(() => {
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);

  registerTireWearVocabulary(engine);
  registerReadbackVocabulary(engine, () => null);

  for (const c of TIRE_WEAR_CONTRACTS) engine.defineContract(c);

  for (const c of PIT_READBACK_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map([[VOICE, TIRE_WEAR_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
});

/** A fire context carrying `data` as a `tireWear.reported` event — or no event at all. */
function ctxOf(data: unknown, event: SimEventName | null = "tireWear.reported"): ScenarioContext {
  return {
    event: event === null ? null : ({ event, timestamp: 0, telemetry: null, data } as SimEventOf<SimEventName>),
    telemetry: null,
    data: event === null ? null : data,
    now: 0,
    vars: {},
  };
}

function voiceClipsPlayed(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

const tw = (base: string): string => `voice/${VOICE}/tire-wear/${base}-01.mp3`;
const num = (n: number): string => `voice/${VOICE}/session-start-temp-numbers/${n}.mp3`;

describe("TIRE_WEAR_CONTRACTS structure", () => {
  it("exports the one report contract", () => {
    expect(TIRE_WEAR_SCENARIO_IDS).toEqual(["pit-crew.tire-wear-report"]);
    expect(TIRE_WEAR_CONTRACTS.map((c) => c.id)).toEqual(TIRE_WEAR_SCENARIO_IDS);
  });

  it("fires on tireWear.reported on the voice channel, in its own family, queueable at the default weight and frame, carrying no sequence", () => {
    const [c] = TIRE_WEAR_CONTRACTS;

    expect(c.when?.event).toBe("tireWear.reported");
    expect(c.channel).toBe(AudioChannel.Voice);
    expect(c.bus).toBe(AudioBus.Voice);
    expect(c.base).toBe("voice/{voice}");
    expect(c.family).toBe("tire-wear");
    expect(c.queueable).toBe(true);
    // Default weight and never an interrupt: the report waits behind the exit
    // readback rather than cutting it (see the scheduling case below).
    expect(c.weight).toBeUndefined();
    expect(c.interrupt).toBeUndefined();
    expect(c.frame).toBeUndefined();
    expect(c.speakGate).toBeUndefined();
    expect("sequence" in c).toBe(false);
  });

  it("describes when it fires in one sentence for a pack author", () => {
    const description = TIRE_WEAR_CONTRACTS[0].description ?? "";

    expect(description.endsWith(".")).toBe(true);
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(200);
    expect(description.startsWith("pit-crew.tire-wear-report")).toBe(false);
  });
});

describe("the report's where: — a shape check, never a range (issue #1108)", () => {
  const where = (data: unknown): boolean | undefined =>
    TIRE_WEAR_CONTRACTS[0].when?.where?.({ event: "tireWear.reported", timestamp: 0, telemetry: null, data } as never);

  it("admits a report carrying a finite tread for all four tires", () => {
    expect(where(REPORT)).toBe(true);
    expect(where(DISTINCT)).toBe(true);
  });

  it("admits a report whose heaviest spot is missing — the script speaks it in an optional clause", () => {
    expect(where({ corners: REPORT.corners })).toBe(true);
  });

  it("admits any finite number, however implausible — which numbers are speakable is the voice's clip set's business", () => {
    const corners = { ...REPORT.corners, rr: { ...REPORT.corners.rr, tread: 250 } };

    expect(where({ ...REPORT, corners })).toBe(true);
  });

  it.each([
    ["no payload", null],
    ["a non-object payload", 42],
    ["no corners", { heaviest: REPORT.heaviest }],
    ["a missing tire", { corners: { lf: REPORT.corners.lf, rf: REPORT.corners.rf, lr: REPORT.corners.lr } }],
    ["a null tire", { corners: { ...REPORT.corners, lr: null } }],
    ["a tread that is not a number", { corners: { ...REPORT.corners, rf: { ...REPORT.corners.rf, tread: "98" } } }],
    ["a NaN tread", { corners: { ...REPORT.corners, lf: { ...REPORT.corners.lf, tread: Number.NaN } } }],
  ])("refuses %s", (_label, data) => {
    expect(where(data)).toBe(false);
    expect(hasSpeakableTreads(data)).toBe(false);
  });
});

describe("the tire-wear resolvers read the fire's own event", () => {
  it("rounds each tire's tread to a whole percent", () => {
    expect(resolveCornerTread(ctxOf(DISTINCT), "lf")).toBe(89);
    expect(resolveCornerTread(ctxOf(DISTINCT), "rf")).toBe(91);
    expect(resolveCornerTread(ctxOf(DISTINCT), "lr")).toBe(87);
    expect(resolveCornerTread(ctxOf(DISTINCT), "rr")).toBe(85);
    expect(resolveCornerTread(ctxOf(REPORT), "rr")).toBe(99);
  });

  it("names the heaviest spot as <corner>-<zone>, and reads its tread", () => {
    expect(resolveHeaviestSpot(ctxOf(DISTINCT))).toBe("rr-inside");
    expect(resolveHeaviestTread(ctxOf(DISTINCT))).toBe(85);
    expect(resolveHeaviestSpot(ctxOf({ ...DISTINCT, heaviest: { corner: "lr", zone: "middle" } }))).toBe("lr-middle");
  });

  it("says there is wear only when a tire reads below 100 as the whole percent spoken", () => {
    expect(resolveHasWear(ctxOf(DISTINCT))).toBe(true);
    expect(resolveHasWear(ctxOf(REPORT))).toBe(true);
    expect(resolveHasWear(ctxOf(UNWORN))).toBe(false);
    // 99.6 is spoken as "one hundred", so it is no wear to name either.
    const nearlyUnworn = {
      corners: Object.fromEntries(
        Object.entries(UNWORN.corners).map(([corner, wear]) => [corner, { ...wear, tread: 99.6 }]),
      ),
      heaviest: UNWORN.heaviest,
    };

    expect(resolveHasWear(ctxOf(nearlyUnworn))).toBe(false);
    // Read off the tires' own treads, so a report naming no heaviest spot still answers.
    expect(resolveHasWear(ctxOf({ corners: DISTINCT.corners }))).toBe(true);
    expect(resolveHasWear(ctxOf(DISTINCT, null))).toBe(false);
    expect(resolveHasWear(ctxOf(DISTINCT, "pitService.readbackRequested"))).toBe(false);
  });

  it("answers nothing for an imperative fire, a fire of another event, or a heaviest spot naming no known tire and zone", () => {
    expect(resolveCornerTread(ctxOf(DISTINCT, null), "lf")).toBeNull();
    expect(resolveHeaviestSpot(ctxOf(DISTINCT, null))).toBeNull();
    expect(resolveCornerTread(ctxOf(DISTINCT, "pitService.readbackRequested"), "lf")).toBeNull();
    expect(resolveHeaviestSpot(ctxOf(DISTINCT, "pitService.readbackRequested"))).toBeNull();
    expect(resolveHeaviestSpot(ctxOf({ ...DISTINCT, heaviest: { corner: "xx", zone: "inside" } }))).toBeNull();
    expect(resolveHeaviestSpot(ctxOf({ ...DISTINCT, heaviest: { corner: "lf", zone: "left" } }))).toBeNull();
    expect(resolveHeaviestTread(ctxOf({ corners: DISTINCT.corners }))).toBeNull();
    expect(resolveCornerTread(ctxOf({ corners: { ...DISTINCT.corners, lf: {} } }), "lf")).toBeNull();
  });
});

describe("registerTireWearVocabulary (issue #1108)", () => {
  it("publishes the five tread vars, the wear condition and the three heaviest-wear cases, each with a description for a pack author", () => {
    const { vars, conds, cases } = engine.vocabulary();
    const ours = (name: string) => name.startsWith("tireWear.");

    expect(vars.filter((v) => ours(v.name)).map((v) => v.name)).toEqual([
      "tireWear.heaviestTread",
      "tireWear.leftFrontTread",
      "tireWear.leftRearTread",
      "tireWear.rightFrontTread",
      "tireWear.rightRearTread",
    ]);
    expect(cases.filter((c) => ours(c.name)).map((c) => c.name)).toEqual([
      "tireWear.heaviestCorner",
      "tireWear.heaviestSpot",
      "tireWear.heaviestZone",
    ]);
    expect(conds.filter((c) => ours(c.name)).map((c) => c.name)).toEqual(["tireWear.hasWear"]);

    for (const entry of [
      ...vars.filter((v) => ours(v.name)),
      ...conds.filter((c) => ours(c.name)),
      ...cases.filter((c) => ours(c.name)),
    ]) {
      expect(entry.description.trim().endsWith("."), entry.name).toBe(true);
    }

    for (const c of cases.filter((x) => ours(x.name))) {
      for (const [key, description] of Object.entries(c.keys)) {
        expect(description.trim().endsWith("."), `${c.name} key ${key}`).toBe(true);
      }
    }
  });

  it("names the clip group every tread var draws from, so the recording script attributes the numbers to it (#1066)", () => {
    for (const v of engine.vocabulary().vars.filter((x) => x.name.startsWith("tireWear."))) {
      expect(descriptionNamesGroup(v.description, "session-start-temp-numbers"), v.name).toBe(true);
      // The report lines are the script's, addressed directly — no var claims them.
      expect(descriptionNamesGroup(v.description, "tire-wear"), v.name).toBe(false);
    }
  });

  it("declares exactly the keys the resolvers can return — every tire crossed with every zone", () => {
    const corners: readonly TireCorner[] = ["lf", "rf", "lr", "rr"];
    const zones: readonly TireZone[] = ["inside", "middle", "outside"];
    const declared = (name: string) => engine.vocabulary().cases.find((c) => c.name === name)?.keys ?? {};
    const reachable = corners.flatMap((corner) =>
      zones.map((zone) => resolveHeaviestSpot(ctxOf({ ...DISTINCT, heaviest: { corner, zone } }))),
    );

    expect([...reachable].sort()).toEqual(Object.keys(declared("tireWear.heaviestSpot")).sort());
    expect(Object.keys(TIRE_WEAR_SPOT_KEYS)).toHaveLength(12);
    expect(Object.keys(declared("tireWear.heaviestCorner")).sort()).toEqual([...corners].sort());
    expect(Object.keys(TIRE_WEAR_CORNER_KEYS).sort()).toEqual([...corners].sort());
    expect(Object.keys(declared("tireWear.heaviestZone")).sort()).toEqual([...zones].sort());
    expect(Object.keys(TIRE_WEAR_ZONE_KEYS).sort()).toEqual([...zones].sort());
  });
});

describe("the tire wear report fires through the bundled script (issue #1108)", () => {
  it("reads the four tires front to rear, the percent after the first, then the heaviest spot, inside the radio frame", () => {
    bus.publishEvent("tireWear.reported", DISTINCT);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([
      tw("left-front"),
      num(89),
      tw("percent"),
      tw("right-front"),
      num(91),
      tw("left-rear"),
      num(87),
      tw("right-rear"),
      num(85),
      tw("heaviest-rr-inside"),
    ]);

    const all = audio._played.map((p) => p.path);

    expect(all[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(all.at(-1)).toBe("sfx/IRD-tick-close.mp3");
  });

  it("speaks the captured stop's numbers, rounding each tread to a whole percent", () => {
    bus.publishEvent("tireWear.reported", REPORT);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([
      tw("left-front"),
      num(98),
      tw("percent"),
      tw("right-front"),
      num(99),
      tw("left-rear"),
      num(99),
      tw("right-rear"),
      num(99),
      tw("heaviest-lf-inside"),
    ]);
  });

  it("reads an untouched set's four numbers and names no heaviest spot — the tie-break's pick is no wear", () => {
    bus.publishEvent("tireWear.reported", UNWORN);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([
      tw("left-front"),
      num(100),
      tw("percent"),
      tw("right-front"),
      num(100),
      tw("left-rear"),
      num(100),
      tw("right-rear"),
      num(100),
    ]);
  });

  it("drops only the closing clause when the report names no heaviest spot", () => {
    bus.publishEvent("tireWear.reported", { corners: DISTINCT.corners } as TireWearReport);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([
      tw("left-front"),
      num(89),
      tw("percent"),
      tw("right-front"),
      num(91),
      tw("left-rear"),
      num(87),
      tw("right-rear"),
      num(85),
    ]);
  });

  it("stays silent, rather than speak three tires, when a tread has no number clip in the voice — no clamping (issue #836)", () => {
    const corners = { ...DISTINCT.corners, lr: { ...DISTINCT.corners.lr, tread: 101 } };

    bus.publishEvent("tireWear.reported", { ...DISTINCT, corners });
    flush(audio);

    expect(audio._played).toEqual([]);
  });

  it("a voice with no script is silent — the contract alone says nothing", () => {
    engine.setScripts(new Map());

    bus.publishEvent("tireWear.reported", DISTINCT);
    flush(audio);

    expect(audio._played).toEqual([]);
  });

  it("queues behind the exit readback published just before it, and plays once the readback is done", () => {
    // The translator publishes the two from the same settle timer, readback
    // first (`tireWear.reported` in the event catalog).
    bus.publishEvent("pitService.readbackRequested", { reason: "exit" });
    bus.publishEvent("tireWear.reported", DISTINCT);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([
      `voice/${VOICE}/pit-readback/opener-exit-01.mp3`,
      `voice/${VOICE}/pit-readback/empty-fallback-01.mp3`,
      tw("left-front"),
      num(89),
      tw("percent"),
      tw("right-front"),
      num(91),
      tw("left-rear"),
      num(87),
      tw("right-rear"),
      num(85),
      tw("heaviest-rr-inside"),
    ]);
  });
});

describe("the bundled script's tire-wear entry (issue #1108)", () => {
  const entry = SCRIPT.scenarios["pit-crew.tire-wear-report"];

  it("scripts the contract with a comment, a Tire Wear harness route and a sequence", () => {
    expect(entry, "no script entry for pit-crew.tire-wear-report").toBeDefined();
    expect(entry.comment?.length ?? 0).toBeGreaterThan(0);
    expect(entry.test).toMatch(/^Harness → Tire Wear → Report after a stop\./);
    expect(entry.skip).toBeUndefined();
    expect(entry.frame).toBeUndefined();
    expect(entry.sequence?.length ?? 0).toBeGreaterThan(0);
  });

  it("references only the tire-wear vocabulary, with the declared case keys, and no frame, fragment or named pool", () => {
    const refs = collectScriptReferences(REPORT_ONLY_SCRIPT);
    const vocabulary = engine.vocabulary();

    expect([...refs.vars].sort()).toEqual([
      "tireWear.leftFrontTread",
      "tireWear.leftRearTread",
      "tireWear.rightFrontTread",
      "tireWear.rightRearTread",
    ]);
    expect(refs.conds).toEqual(["tireWear.hasWear"]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);

    for (const c of refs.cases) {
      const declared = vocabulary.cases.find((v) => v.name === c.name);

      expect(declared, c.name).toBeDefined();
      expect([...c.keys].sort()).toEqual(Object.keys(declared?.keys ?? {}).sort());
    }

    expect(refs.cases.map((c) => c.name)).toEqual(["tireWear.heaviestSpot"]);
  });

  it("addresses exactly the published clip sources — the slashed form throughout", () => {
    const sources = TIRE_WEAR_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort();

    expect([...collectScriptReferences(REPORT_ONLY_SCRIPT).pools].sort()).toEqual(sources);
    expect(sources).toHaveLength(17);

    for (const { group, base } of TIRE_WEAR_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        manifest.clips.some((clip) => pattern.exec(clip)?.[1] === VOICE),
        `fixture: ${group}/${base}`,
      ).toBe(true);
    }
  });

  it("every clip source has a clip in the bundled voice", () => {
    const missing = TIRE_WEAR_CLIP_SOURCES.filter(({ group, base }) => {
      const pattern = poolMemberPattern(group, base);

      return !MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE);
    }).map(({ group, base }) => `${group}/${base}`);

    expect(missing, `no voice/${BUNDLED_VOICE}/<group>/<base>(-NN).mp3 in manifest.json`).toEqual([]);
  });

  it("the bundled voice records every whole percent a tread can read, 0 to 100", () => {
    const clips = new Set(MANIFEST.clips);
    const missing = Array.from({ length: 101 }, (_, n) => n).filter(
      (n) => !clips.has(`voice/${BUNDLED_VOICE}/session-start-temp-numbers/${n}.mp3`),
    );

    expect(missing).toEqual([]);
  });

  it("compiles for the test voice with nothing skipped — no unknown pool, var, condition, case key or fragment", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
