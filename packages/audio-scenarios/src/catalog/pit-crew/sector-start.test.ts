/**
 * Sector-start callout tests (issue #1573).
 *
 * Three layers: the contract and vocabulary on their own; the family alone on
 * a real engine with the bundled voice's real script entry, over a fixture
 * manifest that ships the sector-number clips (so nothing here waits for the
 * recorded clips); and the real `registerPitCrew`, where the corner-name
 * opt-in, the active voice's script and a corner name holding the bus decide
 * whether a sector start is spoken.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import shawnScript from "@iracedeck/audio-assets/voice/shawn/callouts.json" with { type: "json" };
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { createFakeAudio, type FakeAudio } from "@iracedeck/audio-service/testing";
import { type CalloutScript } from "@iracedeck/callout-script";
import { type CalloutSettingKey, CORNER_NAME_CALLOUTS, SECTOR_START_CALLOUTS } from "@iracedeck/callout-settings";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContext } from "../../dsl.js";
import { NO_FRAME, poolRef, WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import { descriptionNamesGroup } from "../../reference/pack-reference.js";
import { familyGate } from "./callout-gate.test-util.js";
import type { CornerNameSnapshot } from "./corner-name.js";
import { familyReferences } from "./family-references.test-util.js";
import { registerPitCrew } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import {
  buildSectorStartContract,
  registerSectorStartVocabulary,
  SCENARIO_ID_TO_SECTOR_START_ID,
  SECTOR_START_CLIP_SOURCES,
  SECTOR_START_CORNER_CLEARANCE_S,
  SECTOR_START_SCENARIO_IDS,
  type SectorStartData,
} from "./sector-start.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

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

function flush(audio: FakeAudio, iterations = 10): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
    audio._triggerChannelEnd(AudioChannel.Ambient);
  }
}

function sectorData(overrides: Partial<SectorStartData> = {}): SectorStartData {
  return { sector: 3, sectorCount: 4, nextCornerInS: null, ...overrides };
}

function sectorEvent(data: SectorStartData): SimEventOf<"sectorStart.approaching"> {
  return {
    event: "sectorStart.approaching",
    timestamp: 0,
    telemetry: null,
    data,
  } as SimEventOf<"sectorStart.approaching">;
}

function ctxOf(event: SimEventOf<SimEventName> | null): ScenarioContext {
  return { event, telemetry: null, data: event?.data ?? null, now: 0, vars: {} };
}

/** The sector-number clips the fixture voices ship: one to three, one take each. Eleven has none. */
function sectorClips(voice: string): string[] {
  return ["1", "2", "3"].map((n) => `voice/${voice}/sector-number/${n}-01.mp3`);
}

const SCRIPT = defaultScript as CalloutScript;
const SECTOR_START_ID = "pit-crew.sector-start-approaching";
const CORNER_NAME_ID = "pit-crew.corner-name-approaching";

describe("buildSectorStartContract", () => {
  it("is a terse, unframed chatter line in its own family that never waits and never cuts — the words are the voice script's", () => {
    const c = buildSectorStartContract(() => true);

    expect(c.id).toBe(SECTOR_START_ID);
    expect(c.when?.event).toBe("sectorStart.approaching");
    expect(c.channel).toBe(AudioChannel.Voice);
    expect(c.bus).toBe(AudioBus.Voice);
    expect(c.base).toBe("voice/{voice}");
    expect(c.family).toBe("sector-start");
    expect(c.weight).toBe(WEIGHT.CHATTER);
    expect(c.interrupt).toBe(false);
    expect(c.queueable).toBe(false);
    expect(c.frame).toBe(NO_FRAME);
    expect("sequence" in c).toBe(false);
  });

  it("where: refuses sector one at the line, and passes the same event for sector two", () => {
    const where = buildSectorStartContract(() => false).when!.where!;

    expect(where(sectorEvent(sectorData({ sector: 1 })))).toBe(false);
    expect(where(sectorEvent(sectorData({ sector: 2 })))).toBe(true);
  });

  it("where: refuses a sector that is not a whole number from one up", () => {
    const where = buildSectorStartContract(() => false).when!.where!;

    for (const sector of [0, -2, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(where(sectorEvent(sectorData({ sector }))), String(sector)).toBe(false);
    }

    expect(where(sectorEvent(sectorData({ sector: 7, sectorCount: 7 })))).toBe(true);
  });

  it("where: yields to a spoken corner due within the clearance, inclusive, and to nothing past it", () => {
    let wouldSpeak = true;
    const where = buildSectorStartContract(() => wouldSpeak).when!.where!;

    expect(SECTOR_START_CORNER_CLEARANCE_S).toBe(1.5);
    expect(where(sectorEvent(sectorData({ nextCornerInS: 0 })))).toBe(false);
    expect(where(sectorEvent(sectorData({ nextCornerInS: 1.5 })))).toBe(false);
    expect(where(sectorEvent(sectorData({ nextCornerInS: 1.6 })))).toBe(true);
    expect(where(sectorEvent(sectorData({ nextCornerInS: null })))).toBe(true);

    wouldSpeak = false;
    expect(where(sectorEvent(sectorData({ nextCornerInS: 0.5 })))).toBe(true);
  });

  it("where: asks whether the corner call would speak only when a corner is due", () => {
    const wouldSpeak = vi.fn(() => true);
    const where = buildSectorStartContract(wouldSpeak).when!.where!;

    where(sectorEvent(sectorData({ nextCornerInS: 30 })));
    where(sectorEvent(sectorData({ nextCornerInS: null })));
    where(sectorEvent(sectorData({ sector: 1, nextCornerInS: 0.5 })));
    expect(wouldSpeak).not.toHaveBeenCalled();

    where(sectorEvent(sectorData({ nextCornerInS: 0.5 })));
    expect(wouldSpeak).toHaveBeenCalledTimes(1);
  });
});

describe("registerSectorStartVocabulary", () => {
  const vars = new Map<string, (ctx: ScenarioContext) => unknown>();
  const conds = new Map<string, (ctx: ScenarioContext) => boolean>();
  const descriptions = new Map<string, string>();

  beforeEach(() => {
    vars.clear();
    conds.clear();
    descriptions.clear();
    registerSectorStartVocabulary({
      defineVar: vi.fn((name: string, fn: (ctx: ScenarioContext) => unknown, description?: string) => {
        vars.set(name, fn);
        descriptions.set(name, description ?? "");
      }),
      defineCond: vi.fn((name: string, fn: (ctx: ScenarioContext) => boolean, description?: string) => {
        conds.set(name, fn);
        descriptions.set(name, description ?? "");
      }),
    } as unknown as IScenarioEngine);
  });

  it("registers exactly the number var and the final-sector condition", () => {
    expect([...vars.keys()]).toEqual(["sectorStart.number"]);
    expect([...conds.keys()]).toEqual(["sectorStart.isFinal"]);
  });

  it("sectorStart.number resolves the sector-number pool of the fire's own sector", () => {
    const number = vars.get("sectorStart.number")!;

    expect(number(ctxOf(sectorEvent(sectorData({ sector: 3 }))))).toEqual(poolRef("sector-number", "3"));
    expect(number(ctxOf(sectorEvent(sectorData({ sector: 11, sectorCount: 11 }))))).toEqual(
      poolRef("sector-number", "11"),
    );
  });

  it("sectorStart.number is null for an imperative fire, another event, or a sector that is not a whole number from one up", () => {
    const number = vars.get("sectorStart.number")!;

    expect(number(ctxOf(null))).toBeNull();
    expect(
      number(
        ctxOf({
          event: "cornerName.approaching",
          timestamp: 0,
          telemetry: null,
          data: { name: "x", slug: "x" },
        } as never),
      ),
    ).toBeNull();

    for (const sector of [0, -1, 1.5]) {
      expect(number(ctxOf(sectorEvent(sectorData({ sector })))), String(sector)).toBeNull();
    }
  });

  it("sectorStart.isFinal is true only for the track's last sector", () => {
    const isFinal = conds.get("sectorStart.isFinal")!;

    expect(isFinal(ctxOf(sectorEvent(sectorData({ sector: 4, sectorCount: 4 }))))).toBe(true);
    expect(isFinal(ctxOf(sectorEvent(sectorData({ sector: 3, sectorCount: 4 }))))).toBe(false);
    expect(isFinal(ctxOf(null))).toBe(false);
  });

  it("describes each name in one sentence for a pack author, the var naming its clip group", () => {
    for (const [name, description] of descriptions) {
      expect(description.length, name).toBeGreaterThan(0);
      expect(description.endsWith("."), name).toBe(true);
    }

    expect(descriptionNamesGroup(descriptions.get("sectorStart.number")!, "sector-number")).toBe(true);
    expect(descriptions.get("sectorStart.number")).toContain('sector-number/3 is "Sector three."');
  });
});

describe("the sector-start callout alone, through the real script entry", () => {
  const VOICE = "luca";
  const manifest: AudioAssetsManifest = {
    clips: ["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3", "sfx/IRD-ambient-pit.mp3", ...sectorClips(VOICE)],
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };
  /** The bundled script narrowed to this family's entry, as corner-name.test.ts does. */
  const FAMILY_SCRIPT: CalloutScript = {
    ...SCRIPT,
    scenarios: Object.fromEntries(SECTOR_START_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
    fragments: {},
  };

  let bus: ReturnType<typeof createMockBus>;
  let audio: FakeAudio;
  let engine: IScenarioEngine;
  let cornerWouldSpeak: boolean;

  beforeEach(() => {
    cornerWouldSpeak = true;
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
    registerSectorStartVocabulary(engine);
    engine.defineContract(buildSectorStartContract(() => cornerWouldSpeak));
    engine.setScripts(new Map([[VOICE, FAMILY_SCRIPT]]));
  });

  afterEach(() => {
    _resetAudioScenarios();
    vi.clearAllMocks();
  });

  function cross(data: Partial<SectorStartData>): string[] {
    audio._played.length = 0;
    bus.publishEvent("sectorStart.approaching", sectorData(data));
    flush(audio);

    return audio._played.map((p) => p.path);
  }

  it("speaks the sector-number clip alone — no frame ticks around a terse call", () => {
    expect(cross({ sector: 3 })).toEqual([`voice/${VOICE}/sector-number/3-01.mp3`]);
  });

  it("is silent for sector one at the line though the voice has its clip, and speaks sector two", () => {
    expect(cross({ sector: 1 })).toEqual([]);
    expect(cross({ sector: 2 })).toEqual([`voice/${VOICE}/sector-number/2-01.mp3`]);
  });

  it("skips a sector the voice has no clip for whole (issue #835)", () => {
    expect(cross({ sector: 11, sectorCount: 11 })).toEqual([]);
  });

  it("yields to a corner due at 1.5 s that would be spoken, and speaks at 1.6 s", () => {
    expect(cross({ nextCornerInS: 1.5 })).toEqual([]);
    expect(cross({ nextCornerInS: 1.6 })).toEqual([`voice/${VOICE}/sector-number/3-01.mp3`]);
  });

  it("speaks with a corner due at 0.5 s when the corner call would not be spoken", () => {
    cornerWouldSpeak = false;

    expect(cross({ nextCornerInS: 0.5 })).toEqual([`voice/${VOICE}/sector-number/3-01.mp3`]);
  });

  it("compiles for the test voice with nothing skipped", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe("the bundled scripts' sector-start entries", () => {
  for (const [voice, script] of [
    ["default", defaultScript as CalloutScript],
    ["shawn", shawnScript as CalloutScript],
  ] as const) {
    it(`${voice}: scripts the contract with a comment, a Corner Names harness route and the one var`, () => {
      const entry = script.scenarios[SECTOR_START_ID];

      expect(entry, `no script entry in ${voice}`).toBeDefined();
      expect(entry.comment?.length ?? 0).toBeGreaterThan(0);
      expect(entry.test).toMatch(/^Harness → Corner Names → Sector three\. /);
      expect(entry.skip).toBeUndefined();
      expect(entry.frame).toBeUndefined();

      const refs = familyReferences({ ...script, scenarios: { [SECTOR_START_ID]: entry }, fragments: {} });

      expect(refs.vars).toEqual(["sectorStart.number"]);
      expect(refs.pools).toEqual([]);
      expect(refs.conds).toEqual([]);
      expect(refs.cases).toEqual([]);
      expect(refs.includes).toEqual([]);
      expect(refs.frames).toEqual([]);
    });
  }

  it("addresses no pool of its own: the sector-number group is the var's", () => {
    expect(SECTOR_START_CLIP_SOURCES).toEqual([]);
  });
});

describe("the sector-start callout in the real registerPitCrew", () => {
  const VOICE = "default";
  const BUNDLED = manifestJson as AudioAssetsManifest;
  const CORNER_CLIP = /^voice\/default\/corner-names\/eau-rouge(?:-\d+)?\.mp3$/;
  const SECTOR_CLIP = /^voice\/default\/sector-number\//;

  let bus: ReturnType<typeof createMockBus>;
  let audio: FakeAudio;
  let corner: CornerNameSnapshot | null;
  let isCalloutEnabled: (key: CalloutSettingKey) => boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    corner = null;
    isCalloutEnabled = () => true;
    bus = createMockBus();
    audio = createFakeAudio();
    initializeAudioScenarios(
      bus,
      audio,
      { ...BUNDLED, clips: [...new Set([...BUNDLED.clips, ...sectorClips(VOICE)])] },
      mockLogger as never,
      () => VOICE,
    );
    registerPitCrew(bus, {
      logger: mockLogger as never,
      isCalloutEnabled: (key) => isCalloutEnabled(key),
      getCornerNameSnapshot: () => corner,
    });
    getScenarioEngine().setScripts(new Map([[VOICE, SCRIPT]]));
  });

  afterEach(() => {
    _resetAudioScenarios();
    _resetRadarEngine();
    _resetSpotterEngine();
    _resetPitSpeedingEngine();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function played(): string[] {
    return audio._played.map((p) => p.path);
  }

  function sectorCalls(): string[] {
    return played().filter((p) => SECTOR_CLIP.test(p));
  }

  function cross(data: Partial<SectorStartData>): string[] {
    audio._played.length = 0;
    bus.publishEvent("sectorStart.approaching", sectorData(data));
    flush(audio);

    return sectorCalls();
  }

  function approachEauRouge(): void {
    corner = { name: "Eau Rouge", slug: "eau-rouge" };
    bus.publishEvent("cornerName.approaching", corner);
  }

  it("the bundled manifest ships the corner the held-bus cases play — their positive control", () => {
    expect(BUNDLED.clips.some((clip) => CORNER_CLIP.test(clip))).toBe(true);
  });

  it("is silent with a scripted corner due at 1.5 s while the corner names are on, and speaks at 1.6 s", () => {
    expect(cross({ nextCornerInS: 1.5 })).toEqual([]);
    expect(cross({ nextCornerInS: 1.6 })).toEqual(["voice/default/sector-number/3-01.mp3"]);
  });

  it("speaks with a corner due at 0.5 s once the corner names are switched off", () => {
    expect(cross({ nextCornerInS: 0.5 })).toEqual([]);

    isCalloutEnabled = familyGate(CORNER_NAME_CALLOUTS, () => false);

    expect(cross({ nextCornerInS: 0.5 })).toEqual(["voice/default/sector-number/3-01.mp3"]);
  });

  it("speaks with a corner due at 0.5 s when the voice does not script the corner names", () => {
    const scenarios = Object.fromEntries(Object.entries(SCRIPT.scenarios).filter(([id]) => id !== CORNER_NAME_ID));

    getScenarioEngine().setScripts(new Map([[VOICE, { ...SCRIPT, scenarios }]]));

    expect(getScenarioEngine().isScripted(CORNER_NAME_ID)).toBe(false);
    expect(cross({ nextCornerInS: 0.5 })).toEqual(["voice/default/sector-number/3-01.mp3"]);
  });

  it("is silenced by its own opt-in alone", () => {
    isCalloutEnabled = familyGate(SECTOR_START_CALLOUTS, () => false);
    expect(cross({ sector: 2 })).toEqual([]);

    isCalloutEnabled = () => true;
    expect(cross({ sector: 2 })).toEqual(["voice/default/sector-number/2-01.mp3"]);
  });

  it("is silent for sector one at the line and skips sector eleven whole", () => {
    expect(cross({ sector: 1 })).toEqual([]);
    expect(cross({ sector: 11, sectorCount: 11 })).toEqual([]);
    expect(cross({ sector: 2 })).toEqual(["voice/default/sector-number/2-01.mp3"]);
  });

  it("is dropped, never queued, when a corner name holds the bus", () => {
    approachEauRouge();
    expect(played().filter((p) => CORNER_CLIP.test(p))).toHaveLength(1);

    bus.publishEvent("sectorStart.approaching", sectorData({ nextCornerInS: null }));
    flush(audio, 40);
    vi.advanceTimersByTime(30_000);
    flush(audio, 40);

    expect(sectorCalls()).toEqual([]);
  });

  it("never cuts or delays a corner name playing on the bus", () => {
    approachEauRouge();

    const before = played().length;

    bus.publishEvent("sectorStart.approaching", sectorData({ nextCornerInS: null }));

    expect(audio._stopped).not.toContain(AudioChannel.Voice);
    expect(played()).toHaveLength(before);
    expect(played().filter((p) => CORNER_CLIP.test(p))).toHaveLength(1);
  });

  it("maps its one scenario id to the sector-starts opt-in", () => {
    expect(SECTOR_START_SCENARIO_IDS).toEqual([SECTOR_START_ID]);
    expect(SCENARIO_ID_TO_SECTOR_START_ID[SECTOR_START_ID]).toBe("sector-starts");
  });
});
