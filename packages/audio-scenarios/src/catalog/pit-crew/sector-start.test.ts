/**
 * Sector-start callout tests (issues #1573, #1676).
 *
 * Three layers: the contract and vocabulary on their own; the family alone on
 * a real engine with the bundled voice's real script entry, over a fixture
 * manifest that ships the sector-number clips (so nothing here waits for the
 * recorded clips); and the real `registerPitCrew` on the fake audio, where a
 * clip plays until the test ends it, so the order in which a sector call and
 * a corner name due at the same moment are heard, and how late either may
 * start, are measured on the fake clock.
 */
import { PUBLISHED_VOICE_IDS } from "@iracedeck/audio-assets/build";
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
import { buildCornerNameContract, type CornerNameSnapshot, MARKER_CALL_MAX_LAG_MS } from "./corner-name.js";
import { familyReferences } from "./family-references.test-util.js";
import { registerPitCrew } from "./index.js";
import type { LapCompletedSnapshot } from "./lap-time.js";
import { _resetLimiterCueEngine } from "./limiter-cue-engine.js";
import { _resetPitExitCueEngine } from "./pit-exit-cue-engine.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import {
  registerSectorStartVocabulary,
  SCENARIO_ID_TO_SECTOR_START_ID,
  SECTOR_START_CLIP_SOURCES,
  SECTOR_START_CONTRACT,
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
  return { sector: 3, sectorCount: 4, ...overrides };
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

describe("SECTOR_START_CONTRACT", () => {
  it("is a terse, unframed chatter line in its own family that waits but never cuts — the words are the voice script's", () => {
    const c = SECTOR_START_CONTRACT;

    expect(c.id).toBe(SECTOR_START_ID);
    expect(c.when?.event).toBe("sectorStart.approaching");
    expect(c.channel).toBe(AudioChannel.Voice);
    expect(c.bus).toBe(AudioBus.Voice);
    expect(c.base).toBe("voice/{voice}");
    expect(c.family).toBe("sector-start");
    expect(c.weight).toBe(WEIGHT.CHATTER);
    expect(c.interrupt).toBe(false);
    expect(c.queueable).toBe(true);
    expect(c.frame).toBe(NO_FRAME);
    expect("sequence" in c).toBe(false);
  });

  it("pins the bounds (#1676): both marker calls give up 1.5 s late, the sector call queues and the corner name does not", () => {
    const corner = buildCornerNameContract(() => null);

    expect(MARKER_CALL_MAX_LAG_MS).toBe(1500);
    expect(SECTOR_START_CONTRACT.maxQueueWaitMs).toBe(MARKER_CALL_MAX_LAG_MS);
    expect(corner.maxQueueWaitMs).toBe(MARKER_CALL_MAX_LAG_MS);
    expect(SECTOR_START_CONTRACT.queueable).toBe(true);
    expect(corner.queueable).toBe(false);
    expect(corner.family).not.toBe(SECTOR_START_CONTRACT.family);
    expect(corner.interrupt ?? false).toBe(false);
  });

  it("where: refuses sector one at the line, and passes the same event for sector two", () => {
    const where = SECTOR_START_CONTRACT.when!.where!;

    expect(where(sectorEvent(sectorData({ sector: 1 })))).toBe(false);
    expect(where(sectorEvent(sectorData({ sector: 2 })))).toBe(true);
  });

  it("where: refuses a sector that is not a whole number from one up", () => {
    const where = SECTOR_START_CONTRACT.when!.where!;

    for (const sector of [0, -2, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(where(sectorEvent(sectorData({ sector }))), String(sector)).toBe(false);
    }

    expect(where(sectorEvent(sectorData({ sector: 7, sectorCount: 7 })))).toBe(true);
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

  beforeEach(() => {
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
    registerSectorStartVocabulary(engine);
    engine.defineContract(SECTOR_START_CONTRACT);
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
  const SECTOR_THREE = "voice/default/sector-number/3-01.mp3";
  const LAP_TIME_BEST_ID = "pit-crew.lap-time-best";
  const LAP_TIME_LAST_ID = "pit-crew.lap-time-last";

  let bus: ReturnType<typeof createMockBus>;
  let audio: FakeAudio;
  let corner: CornerNameSnapshot | null;
  let lap: LapCompletedSnapshot | null;
  let isCalloutEnabled: (key: CalloutSettingKey) => boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    corner = null;
    lap = null;
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
      getLapCompletedSnapshot: () => lap,
    });
    getScenarioEngine().setScripts(new Map([[VOICE, SCRIPT]]));
  });

  afterEach(() => {
    _resetAudioScenarios();
    _resetRadarEngine();
    _resetSpotterEngine();
    _resetPitSpeedingEngine();
    _resetPitExitCueEngine();
    _resetLimiterCueEngine();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function played(): string[] {
    return audio._played.map((p) => p.path);
  }

  function sectorCalls(): string[] {
    return played().filter((p) => SECTOR_CLIP.test(p));
  }

  function cornerCalls(): string[] {
    return played().filter((p) => CORNER_CLIP.test(p));
  }

  /** Every scenario that took the bus, in order, from the engine's own log line. */
  function started(): string[] {
    return mockLogger.info.mock.calls
      .map(([m]) => /^Playing scenario "([^"]+)"$/.exec(String(m))?.[1])
      .filter((id): id is string => id !== undefined);
  }

  /** Whether the engine logged dropping `id` from the queue for waiting too long. */
  function droppedStale(id: string): boolean {
    return mockLogger.debug.mock.calls.some(([m]) => String(m).startsWith(`Scenario "${id}" dropped — waited `));
  }

  function cross(data: Partial<SectorStartData>): string[] {
    audio._played.length = 0;
    bus.publishEvent("sectorStart.approaching", sectorData(data));
    flush(audio);

    return sectorCalls();
  }

  function approachSectorThree(): void {
    bus.publishEvent("sectorStart.approaching", sectorData({ sector: 3, sectorCount: 4 }));
  }

  function approachEauRouge(): void {
    corner = { name: "Eau Rouge", slug: "eau-rouge" };
    bus.publishEvent("cornerName.approaching", corner);
  }

  /** The clip on the voice channel finishes. */
  function endVoiceClip(): void {
    audio._triggerChannelEnd(AudioChannel.Voice);
  }

  it("the bundled manifest ships the corner the overlap cases play — their positive control", () => {
    expect(BUNDLED.clips.some((clip) => CORNER_CLIP.test(clip))).toBe(true);
  });

  describe("no overlap: each call on an idle bus starts at once", () => {
    it("the sector call", () => {
      approachSectorThree();

      expect(played()).toEqual([SECTOR_THREE]);
    });

    it("the corner name", () => {
      approachEauRouge();

      expect(played()).toHaveLength(1);
      expect(played()[0]).toMatch(CORNER_CLIP);
    });
  });

  describe("sector first: the corner name waits for it (#1676)", () => {
    /** "Sector three." at 0, Eau Rouge 0.3 s into it; the sector clip ends `endAfterCornerMs` after the corner arrived. */
    function sectorThenCorner(endAfterCornerMs: number): void {
      approachSectorThree();
      vi.advanceTimersByTime(300);
      approachEauRouge();
      vi.advanceTimersByTime(endAfterCornerMs);
      endVoiceClip();
    }

    it("plays the corner name the moment the sector clip ends, and never cuts the sector clip", () => {
      approachSectorThree();
      vi.advanceTimersByTime(300);
      approachEauRouge();

      // Heavier but not an interrupt: it waits rather than cutting.
      expect(played()).toEqual([SECTOR_THREE]);

      vi.advanceTimersByTime(500);
      endVoiceClip();

      expect(played()).toHaveLength(2);
      expect(played()[0]).toBe(SECTOR_THREE);
      expect(played()[1]).toMatch(CORNER_CLIP);
      expect(audio._stopped).not.toContain(AudioChannel.Voice);
    });

    it("still plays the corner name when the sector clip ends 1.4 s after the corner was due — the control for the drop below", () => {
      sectorThenCorner(1400);

      expect(cornerCalls()).toHaveLength(1);
      expect(droppedStale(CORNER_NAME_ID)).toBe(false);
    });

    it("drops the corner name as stale when the sector clip ends 1.6 s after it was due", () => {
      sectorThenCorner(1600);
      flush(audio);

      expect(played()).toEqual([SECTOR_THREE]);
      expect(droppedStale(CORNER_NAME_ID)).toBe(true);
    });
  });

  describe("corner first: the sector call waits for it (#1676)", () => {
    /** Eau Rouge at 0, "Sector three." 0.3 s into it; the corner clip ends `endAfterSectorMs` after the sector call arrived. */
    function cornerThenSector(endAfterSectorMs: number): void {
      approachEauRouge();
      vi.advanceTimersByTime(300);
      approachSectorThree();
      vi.advanceTimersByTime(endAfterSectorMs);
      endVoiceClip();
    }

    it("plays the sector call the moment the corner name ends, and never cuts the corner name", () => {
      approachEauRouge();
      vi.advanceTimersByTime(300);
      approachSectorThree();

      // Lighter: it waits in the queue instead of being dropped.
      expect(cornerCalls()).toHaveLength(1);
      expect(sectorCalls()).toEqual([]);

      vi.advanceTimersByTime(500);
      endVoiceClip();

      expect(played()).toHaveLength(2);
      expect(played()[0]).toMatch(CORNER_CLIP);
      expect(played()[1]).toBe(SECTOR_THREE);
      expect(audio._stopped).not.toContain(AudioChannel.Voice);
    });

    it("still plays the sector call when the corner name ends 1.4 s after it was due — the control for the drop below", () => {
      cornerThenSector(1400);

      expect(sectorCalls()).toEqual([SECTOR_THREE]);
      expect(droppedStale(SECTOR_START_ID)).toBe(false);
    });

    it("drops the sector call as stale when the corner name ends 1.6 s after it was due", () => {
      cornerThenSector(1600);
      flush(audio);

      expect(sectorCalls()).toEqual([]);
      expect(cornerCalls()).toHaveLength(1);
      expect(droppedStale(SECTOR_START_ID)).toBe(true);
    });
  });

  describe("behind other lines", () => {
    /** A 1:23.4 session-best lap in practice: the NORMAL-weight best-lap readout. */
    const BEST_LAP: LapCompletedSnapshot = {
      lap: 4,
      lapTime: 83.4,
      isBest: true,
      isFirstValid: false,
      sessionType: "practice",
    };

    /** The best-lap readout starts; the sector call arrives 0.2 s in; the readout ends `endAfterSectorMs` after it. */
    function lapTimeThenSector(endAfterSectorMs: number): void {
      lap = BEST_LAP;
      bus.publishEvent("lap.completed", BEST_LAP);

      expect(started()).toEqual([LAP_TIME_BEST_ID]);

      vi.advanceTimersByTime(200);
      approachSectorThree();

      expect(sectorCalls()).toEqual([]);

      vi.advanceTimersByTime(endAfterSectorMs);
      flush(audio, 40);
    }

    it("a sector call arriving during a lap-time readout is heard after it when the readout ends within 1.5 s", () => {
      lapTimeThenSector(1400);

      expect(started()).toEqual([LAP_TIME_BEST_ID, SECTOR_START_ID]);
      expect(sectorCalls()).toEqual([SECTOR_THREE]);
    });

    it("and dropped as stale when the readout ends later", () => {
      lapTimeThenSector(1600);

      expect(started()).toEqual([LAP_TIME_BEST_ID]);
      expect(sectorCalls()).toEqual([]);
      expect(droppedStale(SECTOR_START_ID)).toBe(true);
    });

    it("a CHATTER line arriving while the sector call waits plays after it — equal weight goes by age", () => {
      approachEauRouge();
      vi.advanceTimersByTime(200);
      approachSectorThree();
      vi.advanceTimersByTime(200);

      // A lap that is not a best: the every-lap readout, CHATTER and queueable.
      lap = { ...BEST_LAP, isBest: false };
      bus.publishEvent("lap.completed", lap);

      expect(started()).toEqual([CORNER_NAME_ID]);

      vi.advanceTimersByTime(200);
      flush(audio, 40);

      expect(started()).toEqual([CORNER_NAME_ID, SECTOR_START_ID, LAP_TIME_LAST_ID]);
    });

    it("a sector call cut by an interrupt line replays whole once that line ends, within 1.5 s of being due", () => {
      // A test-local stand-in for the spotter's transition call: the real one
      // speaks only a clip its engine stashed from radar ticks, and holds a
      // SAFETY focus floor while a car is alongside.
      const CUT_ID = "test.proximity-interrupt";

      getScenarioEngine().defineContract({
        id: CUT_ID,
        channel: AudioChannel.Voice,
        bus: AudioBus.Voice,
        base: "voice/{voice}",
        weight: WEIGHT.PROXIMITY,
        interrupt: true,
        queueable: false,
        frame: NO_FRAME,
        description: "A proximity line that cuts anything in flight.",
      });
      getScenarioEngine().setScripts(
        new Map([
          [
            VOICE,
            {
              ...SCRIPT,
              scenarios: {
                ...SCRIPT.scenarios,
                [CUT_ID]: { comment: "Test.", test: "Test.", sequence: ["pool:corner-names/eau-rouge"] },
              },
            },
          ],
        ]),
      );

      approachSectorThree();
      vi.advanceTimersByTime(300);
      getScenarioEngine().fire(CUT_ID);

      expect(audio._stopped).toContain(AudioChannel.Voice);
      expect(started()).toEqual([SECTOR_START_ID, CUT_ID]);

      vi.advanceTimersByTime(500);
      endVoiceClip();

      expect(started()).toEqual([SECTOR_START_ID, CUT_ID, SECTOR_START_ID]);
      expect(sectorCalls()).toEqual([SECTOR_THREE, SECTOR_THREE]);
      expect(droppedStale(SECTOR_START_ID)).toBe(false);
    });
  });

  describe("no suppression left (#1676)", () => {
    for (const cornerNamesOn of [true, false]) {
      it(`speaks a sector start with a corner due right after it while the corner names are ${cornerNamesOn ? "on" : "off"}`, () => {
        if (!cornerNamesOn) isCalloutEnabled = familyGate(CORNER_NAME_CALLOUTS, () => false);

        approachSectorThree();
        vi.advanceTimersByTime(300);
        approachEauRouge();
        vi.advanceTimersByTime(300);
        flush(audio);

        expect(sectorCalls()).toEqual([SECTOR_THREE]);
        expect(cornerCalls()).toHaveLength(cornerNamesOn ? 1 : 0);
        expect(played()[0]).toBe(SECTOR_THREE);
      });
    }

    it("speaks a sector start with a corner due right after it when the voice does not script the corner names", () => {
      const scenarios = Object.fromEntries(Object.entries(SCRIPT.scenarios).filter(([id]) => id !== CORNER_NAME_ID));

      getScenarioEngine().setScripts(new Map([[VOICE, { ...SCRIPT, scenarios }]]));

      expect(getScenarioEngine().isScripted(CORNER_NAME_ID)).toBe(false);

      approachSectorThree();
      vi.advanceTimersByTime(300);
      approachEauRouge();
      flush(audio);

      expect(played()).toEqual([SECTOR_THREE]);
    });
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

  it("maps its one scenario id to the sector-starts opt-in", () => {
    expect(SECTOR_START_SCENARIO_IDS).toEqual([SECTOR_START_ID]);
    expect(SCENARIO_ID_TO_SECTOR_START_ID[SECTOR_START_ID]).toBe("sector-starts");
  });
});

describe("the shipped sector-number clips", () => {
  // The family tests above supply their own sector-number clips, so this is
  // the one check that every first-party voice the plugin publishes really
  // ships them: without a clip the callout is skipped whole (#835), silently.
  const clips = new Set(manifestJson.clips);

  it.each([...PUBLISHED_VOICE_IDS])("voice %s ships a sector-number clip for sectors 1 to 10", (voice) => {
    const missing = Array.from({ length: 10 }, (_, i) => `voice/${voice}/sector-number/${i + 1}-01.mp3`).filter(
      (clip) => !clips.has(clip),
    );

    expect(missing).toEqual([]);
  });
});
