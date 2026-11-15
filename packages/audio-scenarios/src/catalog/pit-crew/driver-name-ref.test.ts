/**
 * Driver-name aliases at the greeting vars (issue #1580). A spelling the
 * user picked (`geoff`) is spoken with the clip set the ACTIVE voice records
 * for it: its own when the voice records the spelling, its canonical's
 * (`jeff`) when the voice records only that. The `names` group decides, for
 * every line.
 */
import { createFakeAudio } from "@iracedeck/audio-service/testing";
import { DRIVER_NAME_GROUPS, type DriverNameGroup } from "@iracedeck/callout-script";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { classifySession } from "@iracedeck/sim-events-iracing";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContext, VocabularyResolver } from "../../dsl.js";
import {
  _resetAudioScenarios,
  type AudioAssetsManifest,
  initializeAudioScenarios,
  type IScenarioEngine,
} from "../../interpreter.js";
import { descriptionNamesGroup } from "../../reference/pack-reference.js";
import { driverNameRef } from "./driver-name-ref.js";
import { registerPitCrew } from "./index.js";
import { registerOvertakeVocabulary } from "./overtake.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { registerRaceEndVocabulary } from "./race-end.js";
import { registerRaceStartVocabulary } from "./race-start.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { registerSessionStartVocabulary } from "./session-start.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

const CTX: ScenarioContext = { event: null, telemetry: null, data: null, now: 0, vars: {} };

/** A stub engine whose active voice records `names` under `names/`, capturing every var it is given. */
function stubEngine(names: readonly string[]): {
  engine: Pick<IScenarioEngine, "defineVar" | "defineCond" | "defineCase" | "recordedBases">;
  vars: Map<string, VocabularyResolver<string | null>>;
  recordedBases: ReturnType<typeof vi.fn<(group: string) => ReadonlySet<string>>>;
} {
  const vars = new Map<string, VocabularyResolver<string | null>>();
  const recordedBases = vi.fn<(group: string) => ReadonlySet<string>>((group) =>
    group === "names" ? new Set(names) : new Set(),
  );

  return {
    engine: {
      defineVar: (name, resolver) => {
        vars.set(name, resolver);
      },
      defineCond: () => undefined,
      defineCase: () => undefined,
      recordedBases,
    },
    vars,
    recordedBases,
  };
}

describe("driverNameRef (#1580)", () => {
  it("plays the canonical's pool for an alias in a voice that records only the canonical", () => {
    const { engine } = stubEngine(["jeff"]);

    expect(driverNameRef(engine, "race-start-greeting", "geoff")).toBe("pool:race-start-greeting/jeff");
  });

  it("plays the voice's own pool for the alias spelling when the voice records it", () => {
    const { engine } = stubEngine(["geoff", "jeff"]);

    expect(driverNameRef(engine, "race-start-greeting", "geoff")).toBe("pool:race-start-greeting/geoff");
  });

  it("plays the spelling unchanged when the voice records neither", () => {
    const { engine } = stubEngine(["adam"]);

    expect(driverNameRef(engine, "race-end-greeting", "geoff")).toBe("pool:race-end-greeting/geoff");
  });

  it("asks the engine it is handed for the names group, whatever group it speaks from", () => {
    const { engine, recordedBases } = stubEngine(["jeff"]);

    driverNameRef(engine, "position-overtake-come-on", "geoff");

    expect(recordedBases.mock.calls).toEqual([["names"]]);
  });
});

describe("the four greeting vars speak an alias with its canonical's clips (#1580)", () => {
  /** Each greeting var, registered with the picked spelling, by the group it speaks from. */
  const VARS: readonly {
    name: string;
    group: DriverNameGroup;
    register: (engine: ReturnType<typeof stubEngine>["engine"], spelling: string) => void;
  }[] = [
    {
      name: "sessionStart.greeting",
      group: "session-start-greeting",
      register: (engine, spelling) => registerSessionStartVocabulary(engine, () => ({ driverName: spelling }) as never),
    },
    {
      name: "raceStart.greeting",
      group: "race-start-greeting",
      register: (engine, spelling) => registerRaceStartVocabulary(engine, () => ({ driverName: spelling }) as never),
    },
    {
      name: "raceEnd.greeting",
      group: "race-end-greeting",
      register: (engine, spelling) => registerRaceEndVocabulary(engine, () => ({ driverName: spelling }) as never),
    },
    {
      name: "overtake.lost.comeOn",
      group: "position-overtake-come-on",
      register: (engine, spelling) => registerOvertakeVocabulary(engine, () => spelling),
    },
  ];

  it.each(VARS)("$name plays jeff's clips for geoff in a voice that records only jeff", ({ name, group, register }) => {
    const { engine, vars } = stubEngine(["jeff"]);

    register(engine, "geoff");

    expect(vars.get(name)!(CTX)).toBe(`pool:${group}/jeff`);
  });

  it.each(VARS)(
    "$name plays the voice's own geoff clips in a voice that records geoff",
    ({ name, group, register }) => {
      const { engine, vars } = stubEngine(["geoff", "jeff"]);

      register(engine, "geoff");

      expect(vars.get(name)!(CTX)).toBe(`pool:${group}/geoff`);
    },
  );

  it.each(VARS)("$name keeps a name that is no alias as it is", ({ name, group, register }) => {
    const { engine, vars } = stubEngine(["jeff", "niklas"]);

    register(engine, "niklas");

    expect(vars.get(name)!(CTX)).toBe(`pool:${group}/niklas`);
  });

  it.each(VARS)(
    "$name resolves at fire time, so a voice change applies to the next line",
    ({ name, group, register }) => {
      let recorded = new Set(["jeff"]);
      const { engine, vars } = stubEngine([]);

      engine.recordedBases = (asked) => (asked === "names" ? recorded : new Set());
      register(engine, "geoff");

      expect(vars.get(name)!(CTX)).toBe(`pool:${group}/jeff`);

      recorded = new Set(["geoff"]);

      expect(vars.get(name)!(CTX)).toBe(`pool:${group}/geoff`);
    },
  );
});

/** The minimal bus the real registration subscribes to. */
function createBus(): IEventBus {
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
  };
}

describe("every var that speaks a driver-name group resolves an alias (#1580)", () => {
  afterEach(() => {
    _resetAudioScenarios();
    _resetRadarEngine();
    _resetSpotterEngine();
    _resetPitSpeedingEngine();
    vi.restoreAllMocks();
  });

  /**
   * The real registration, against a voice that records only `jeff`, with
   * every name the deps can hand a var set to `geoff`. A var whose description
   * names a driver-name group is a name var (`descriptionNamesGroup` is the
   * pack reference's own link between a var and its clips), and must draw
   * `jeff`'s pool — so a new name var written with a bare `poolRef` fails
   * here. One fed its name by a dep this test does not set fails too, which
   * is the prompt to add the dep below.
   */
  function registerCatalog(): Map<string, { resolver: VocabularyResolver<string | null>; description: string }> {
    const manifest: AudioAssetsManifest = {
      clips: ["voice/v/names/jeff.mp3"],
      ambientLoop: "sfx/IRD-ambient-pit.mp3",
      ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
    };
    const bus = createBus();
    const engine = initializeAudioScenarios(bus, createFakeAudio(), manifest, undefined, () => "v");
    const defineVar = vi.spyOn(engine, "defineVar");
    const named = { driverName: "geoff" } as never;

    registerPitCrew(bus, {
      getSessionClass: () => classifySession("Race"),
      getStandingStart: () => false,
      getLatestTelemetry: () => null,
      getSessionStartSnapshot: () => named,
      getRaceStartSnapshot: () => named,
      getRaceFinishedSnapshot: () => named,
      getOvertakeDriverName: () => "geoff",
    });

    return new Map(
      defineVar.mock.calls.map(([name, resolver, description]) => [name, { resolver, description: description ?? "" }]),
    );
  }

  it("draws jeff's pool for geoff from every var whose description names a driver-name group", () => {
    const vars = registerCatalog();
    const nameVars = [...vars].flatMap(([name, { resolver, description }]) =>
      DRIVER_NAME_GROUPS.filter((group) => descriptionNamesGroup(description, group)).map((group) => ({
        name,
        group,
        resolver,
      })),
    );

    // The floor: the four greeting vars. A heuristic that stopped matching
    // them would leave this test checking nothing.
    expect(nameVars.map((v) => v.name).sort()).toEqual(
      expect.arrayContaining([
        "overtake.lost.comeOn",
        "raceEnd.greeting",
        "raceStart.greeting",
        "sessionStart.greeting",
      ]),
    );

    for (const { name, group, resolver } of nameVars) {
      expect(resolver(CTX), `${name} speaks ${group}`).toBe(`pool:${group}/jeff`);
    }
  });
});
