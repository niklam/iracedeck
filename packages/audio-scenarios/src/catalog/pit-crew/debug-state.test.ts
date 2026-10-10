/**
 * The Race Engineer's section of the Telemetry Snapshot's `pluginState`
 * (issue #1387): the aggregate reader, its headline rows, each family's own
 * reader, and the source guard that keeps a new family from holding state the
 * snapshot cannot see.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContext } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import { _resetBackgroundTest, playBackgroundTest, readBackgroundTestDebugState } from "./background-test.js";
import { buildCautionContracts, readCautionDebugState } from "./caution.js";
import { type RaceEngineerState, raceEngineerStateHeadline, readRaceEngineerState } from "./debug-state.js";
import { _setFurledRaisedSpoken, readFlagAlertsDebugState } from "./flag-alerts.js";
import { _resetGapCalloutCooldown, readGapsDebugState, tryClaimGapCallout } from "./gaps.js";
import { _resetLastIncidentPoints, INCIDENT_CONTRACTS, readIncidentsDebugState } from "./incidents.js";
import { registerPitCrew } from "./index.js";
import { _resetOpponentPitPending, OPPONENT_PIT_CONTRACTS, readOpponentPitDebugState } from "./opponent-pit.js";
import { _resetPitSpeedingEngine, readPitSpeedingDebugState } from "./pit-speeding-engine.js";
import {
  _resetPositionReadoutCooldown,
  commitIntroDecision,
  readPositionReadoutDebugState,
  registerPositionReadoutVocabulary,
  tryClaimPositionAnnouncement,
} from "./position-readout.js";
import {
  buildQualifyingInvalidationContract,
  claimQualifyingLatch,
  type QualifyingInvalidationSnapshot,
  readQualifyingInvalidationDebugState,
  resetQualifyingInvalidationLatch,
} from "./qualifying-invalidation.js";
import { _resetRadarEngine, readRadarDebugState, setRadarEnabled, subscribeRadarVisualState } from "./radar-engine.js";
import { _resetSpotterEngine, readSpotterDebugState } from "./spotter-engine.js";

const fakeAudio = vi.hoisted(() => ({
  playOnChannel: vi.fn(() => true),
  stopChannel: vi.fn(),
  onChannelComplete: vi.fn(),
  seekChannelRandom: vi.fn(),
}));

// The radar, pit-speeding and Background Test code reaches the mixer through
// `getAudio()`; the enums stay the real ones.
vi.mock("@iracedeck/audio-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/audio-service")>()),
  getAudio: () => fakeAudio,
}));

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => "Race",
  getStandingStart: () => false,
  getLatestTelemetry: () => null,
  isDamageRepairNeeded: () => null,
  TrackDirection: { Neutral: "neutral", Left: "left", Right: "right" },
}));

type TestBus = IEventBus & { publishEvent: (name: SimEventName, data?: unknown) => void };

function createBus(): TestBus {
  const handlers = new Map<SimEventName, Set<(e: SimEventOf<SimEventName>) => void>>();

  return {
    subscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      const set = handlers.get(name) ?? new Set();

      handlers.set(name, set);
      set.add(handler as (e: SimEventOf<SimEventName>) => void);

      return () => {
        set.delete(handler as (e: SimEventOf<SimEventName>) => void);
      };
    },
    unsubscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
    },
    publish: (event: SimEventOf<SimEventName>) => {
      for (const handler of Array.from(handlers.get(event.event as SimEventName) ?? [])) handler(event);
    },
    publishEvent(name, data = {}) {
      this.publish({ event: name, timestamp: Date.now(), telemetry: null, data } as SimEventOf<SimEventName>);
    },
  };
}

const manifest: AudioAssetsManifest = {
  clips: ["t/holder.mp3", "t/line.mp3"],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** Every key of `families`, sorted: one per pit-crew file that holds state. */
const FAMILY_KEYS = [
  "backgroundTest",
  "caution",
  "flagAlerts",
  "gaps",
  "incidents",
  "opponentPit",
  "pitSpeeding",
  "positionReadout",
  "qualifyingInvalidation",
  "radar",
  "spotter",
];

/** What every family reads as before anything has happened — and before anything was registered. */
const UNTOUCHED_FAMILIES = {
  backgroundTest: { testInFlight: false, builtInFramePlaying: false },
  caution: { lastNamed: null },
  flagAlerts: { furledRaisedSpoken: false },
  gaps: { lastGapCalloutAt: null },
  incidents: { lastIncidentPoints: null },
  opponentPit: { pendingNearby: null },
  pitSpeeding: { registered: false, ticking: false, episodeActive: false, lastSessionTick: null },
  positionReadout: { lastPositionAnnouncedAt: 0, lastIntroAt: 0, lastSpokenPosition: 0, pendingIntro: null },
  qualifyingInvalidation: { lastAnnounced: null, approvedBurstTimestamp: null },
  radar: {
    registered: false,
    enabled: false,
    visualState: "clear",
    ticking: false,
    testSequenceInFlight: false,
    testSequenceGeneration: 0,
    listenerCount: 0,
  },
  spotter: {
    registered: false,
    state: "clear",
    looping: false,
    clearPolling: false,
    pendingClear: null,
    pendingSpotterClip: "",
    clearPick: { lastIndex: -1 },
    stillTherePick: { lastIndex: -1 },
  },
};

let bus: TestBus;
let activeVoice: string | null;

function startEngine(): IScenarioEngine {
  return initializeAudioScenarios(bus, fakeAudio as unknown as IAudioService, manifest, undefined, () => activeVoice);
}

/** The initialised arm of the reader's result, or a failed test. */
function initialized(state: RaceEngineerState): Extract<RaceEngineerState, { initialized: true }> {
  if (!state.initialized) throw new Error("the Race Engineer reads as not initialized");

  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  bus = createBus();
  activeVoice = "luca";
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  _resetBackgroundTest();
  _setFurledRaisedSpoken(false);
  _resetGapCalloutCooldown();
  _resetLastIncidentPoints();
  _resetOpponentPitPending();
  _resetPositionReadoutCooldown();
  resetQualifyingInvalidationLatch();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("readRaceEngineerState", () => {
  it("returns exactly { initialized: false } before the engine exists, without throwing (Review Focus 2)", () => {
    expect(readRaceEngineerState()).toStrictEqual({ initialized: false });
  });

  it("reads every family's untouched state in a process that never registered the catalog", async () => {
    // Fresh module instances: no other test's registration, build or seam has
    // touched this copy of the family files.
    vi.resetModules();

    const fresh = await import("./debug-state.js");
    const interpreter = await import("../../interpreter.js");

    expect(fresh.readRaceEngineerState()).toStrictEqual({ initialized: false });

    interpreter.initializeAudioScenarios(bus, fakeAudio as unknown as IAudioService, manifest);

    try {
      const state = fresh.readRaceEngineerState();

      expect(state).toMatchObject({ initialized: true, engine: { activeVoice: null, contracts: [] } });
      expect(state).toHaveProperty("families", UNTOUCHED_FAMILIES);
    } finally {
      interpreter._resetAudioScenarios();
    }
  });

  it("has one key per state-holding family once the catalog is registered, and nothing JSON cannot carry", () => {
    startEngine();
    registerPitCrew(bus);

    const state = initialized(readRaceEngineerState());

    expect(Object.keys(state.families).sort()).toEqual(FAMILY_KEYS);
    expect(state.families).toEqual({
      ...UNTOUCHED_FAMILIES,
      pitSpeeding: { ...UNTOUCHED_FAMILIES.pitSpeeding, registered: true },
      radar: { ...UNTOUCHED_FAMILIES.radar, registered: true },
      spotter: { ...UNTOUCHED_FAMILIES.spotter, registered: true },
    });
    expect(state.engine.activeVoice).toBe("luca");
    expect(state.engine.contracts.length).toBeGreaterThan(50);
    // No timer handle, no cycle, no function, no Map: the value is its own JSON.
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("stays JSON-safe with every engine mid-episode: timers read as booleans", () => {
    startEngine();
    registerPitCrew(bus);
    setRadarEnabled(true);
    subscribeRadarVisualState(() => {});

    bus.publishEvent("radar.changed", { from: "clear", to: "left" });
    bus.publishEvent("pitSpeeding.started");

    const state = initialized(readRaceEngineerState());

    expect(state.families.radar).toMatchObject({ enabled: true, visualState: "left", ticking: true, listenerCount: 1 });
    expect(state.families.spotter).toMatchObject({
      state: "left",
      looping: true,
      pendingSpotterClip: "voice/{voice}/spotter/car-left.mp3",
    });
    expect(state.families.pitSpeeding).toMatchObject({ episodeActive: true, ticking: true });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);

    // The same read once the episodes are over: the booleans follow the timers.
    setRadarEnabled(false);
    bus.publishEvent("pitSpeeding.ended");

    const after = initialized(readRaceEngineerState());

    expect(after.families.radar).toMatchObject({ enabled: false, visualState: "clear", ticking: false });
    expect(after.families.pitSpeeding).toMatchObject({ episodeActive: false, ticking: false });
  });

  it("reports the furled marker a test seam sets", () => {
    startEngine();
    registerPitCrew(bus);
    _setFurledRaisedSpoken(true);

    expect(initialized(readRaceEngineerState()).families.flagAlerts.furledRaisedSpoken).toBe(true);
  });

  it("lists a fire deferred behind a held bus in the waiting list, with its group and wait", () => {
    const engine = startEngine();

    engine.defineScenario({
      id: "t.holder",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CRITICAL,
      sequence: ["t/holder.mp3"],
    });
    engine.defineScenario({
      id: "t.line",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.NORMAL,
      queueable: true,
      supersedeGroup: "lines",
      maxQueueWaitMs: 12_000,
      sequence: ["t/line.mp3"],
    });

    engine.fire("t.holder");
    vi.advanceTimersByTime(400);
    engine.fire("t.line");

    const voice = initialized(readRaceEngineerState()).engine.buses[0];

    expect(voice).toMatchObject({ bus: "Voice", playingId: "t.holder", active: { id: "t.holder" } });
    expect(voice.waiting).toEqual([
      { id: "t.line", weight: WEIGHT.NORMAL, group: "lines", queuedAt: 1_000_400, maxWaitMs: 12_000, after: null },
    ]);
  });

  it("is a pure read: two reads agree and the engine is asked for nothing but its state", () => {
    const engine = startEngine();

    registerPitCrew(bus);

    const fire = vi.spyOn(engine, "fire");
    const acquire = vi.spyOn(engine, "acquireFocus");
    const before = readRaceEngineerState();

    expect(readRaceEngineerState()).toEqual(before);
    expect(fire).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("raceEngineerStateHeadline", () => {
  it("is one row for an engine that is not initialized", () => {
    expect(raceEngineerStateHeadline({ initialized: false })).toEqual([["Race Engineer", "not initialized"]]);
  });

  it("names the voice, an idle Voice bus and no waiting callouts", () => {
    startEngine();

    expect(raceEngineerStateHeadline(readRaceEngineerState())).toEqual([
      ["Race Engineer voice", "luca"],
      ["Voice bus", "idle"],
      ["Waiting callouts", "0"],
    ]);
  });

  it("says none for no selected voice, and names what is playing and how many wait", () => {
    activeVoice = null;

    const engine = startEngine();

    engine.defineScenario({
      id: "t.holder",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CRITICAL,
      sequence: ["t/holder.mp3"],
    });
    engine.defineScenario({
      id: "t.line",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      queueable: true,
      sequence: ["t/line.mp3"],
    });
    engine.fire("t.holder");
    engine.fire("t.line");

    expect(raceEngineerStateHeadline(readRaceEngineerState())).toEqual([
      ["Race Engineer voice", "none"],
      ["Voice bus", "t.holder"],
      ["Waiting callouts", "1"],
    ]);
  });
});

describe("the family readers", () => {
  it("flag alerts: the furled line's spoken marker", () => {
    expect(readFlagAlertsDebugState()).toEqual({ furledRaisedSpoken: false });

    _setFurledRaisedSpoken(true);

    expect(readFlagAlertsDebugState()).toEqual({ furledRaisedSpoken: true });
  });

  it("gaps: the shared cooldown's last claim", () => {
    expect(tryClaimGapCallout(5000, 1000)).toBe(true);

    expect(readGapsDebugState()).toEqual({ lastGapCalloutAt: 5000 });
  });

  it("incidents: the points the admitted event stashed", () => {
    const contract = INCIDENT_CONTRACTS.find((c) => c.id === "pit-crew.incident-off-track");

    expect(contract?.when?.where?.({ timestamp: 1, data: { type: "off-track", points: 2 } } as never)).toBe(true);

    expect(readIncidentsDebugState()).toEqual({ lastIncidentPoints: 2 });
  });

  it("opponent pit: the car the nearby line is about to name", () => {
    const contract = OPPONENT_PIT_CONTRACTS.find((c) => c.id === "pit-crew.opponent-pit-nearby");
    const data = { relation: "nearby", carIdx: 12, position: 4, isMultiClass: false };

    expect(contract?.when?.where?.({ data } as never)).toBe(true);

    expect(readOpponentPitDebugState()).toEqual({ pendingNearby: { carIdx: 12, position: 4, isMultiClass: false } });
  });

  it("position readout: the cooldown stamps, and a pending intro decision without the fire's context", () => {
    tryClaimPositionAnnouncement(7000);
    commitIntroDecision({ spokeIntro: true, position: 5, at: 6500 });

    const vars = new Map<string, (ctx: ScenarioContext) => string | null>();

    registerPositionReadoutVocabulary({ defineVar: (name, resolver) => void vars.set(name, resolver) }, () => ({
      position: 3,
      classPosition: 3,
      isMultiClass: false,
    }));
    vars.get("positionReadout.intro")?.({ event: null, now: 9000 } as ScenarioContext);

    const state = readPositionReadoutDebugState();

    expect(state).toEqual({
      lastPositionAnnouncedAt: 7000,
      lastIntroAt: 6500,
      lastSpokenPosition: 5,
      pendingIntro: { spokeIntro: true, position: 3, at: 9000 },
    });
    expect(state.pendingIntro).not.toHaveProperty("ctx");
  });

  it("qualifying invalidation: the lap latch and the approved burst, the per-fire stash left out", () => {
    const snapshot = { sessionType: "qualifying", sessionNum: 2, lapCompleted: 5 } as QualifyingInvalidationSnapshot;
    const contract = buildQualifyingInvalidationContract(() => snapshot);

    expect(contract.when?.where?.({ timestamp: 4321, data: {} } as never)).toBe(true);
    claimQualifyingLatch(snapshot);

    expect(readQualifyingInvalidationDebugState()).toEqual({
      lastAnnounced: { sessionNum: 2, lap: 5 },
      approvedBurstTimestamp: 4321,
    });
  });

  it("caution: the car the newest build last named, by caution", () => {
    const build = (followCarIdx: number): void => {
      const contracts = buildCautionContracts({
        getCautionPhase: () => "waving",
        getCautionLineup: () => ({ followCarIdx }) as never,
        getCautionEpisode: () => ({ id: 3, firstFollowCarIdx: followCarIdx }),
        isCautionCalloutEnabled: () => true,
      });

      expect(readCautionDebugState()).toEqual({ lastNamed: null });

      const follow = contracts.find((c) => c.id === "pit-crew.caution-follow");

      expect(follow?.speakGate?.admit({ event: null, now: 0 } as ScenarioContext)).toBe(true);
    };

    build(7);
    expect(readCautionDebugState()).toEqual({ lastNamed: { episodeId: 3, followCarIdx: 7 } });

    // A later build starts clean and is the one the reader follows.
    build(9);
    expect(readCautionDebugState()).toEqual({ lastNamed: { episodeId: 3, followCarIdx: 9 } });
  });

  it("background test: in flight, and whether the built-in frame's timer is running", () => {
    // No engine: the preview falls back to the plugin's own three clips.
    expect(playBackgroundTest()).toBe("built-in");
    expect(readBackgroundTestDebugState()).toEqual({ testInFlight: true, builtInFramePlaying: true });

    vi.runOnlyPendingTimers();

    expect(readBackgroundTestDebugState()).toEqual({ testInFlight: false, builtInFramePlaying: false });
  });

  it("the three engines: registration, the episode and the timers as booleans", () => {
    startEngine();
    registerPitCrew(bus);

    expect(readRadarDebugState().registered).toBe(true);
    expect(readSpotterDebugState().registered).toBe(true);
    expect(readPitSpeedingDebugState().registered).toBe(true);

    bus.publishEvent("radar.changed", { from: "clear", to: "two-right" });
    bus.publishEvent("radar.changed", { from: "two-right", to: "clear" });

    // The spotter buffers the clear: with no gap data it confirms at once.
    expect(readSpotterDebugState()).toMatchObject({ state: "clear", looping: false, clearPolling: false });
    expect(getScenarioEngine().describeState().buses[0].focus).toBeNull();
  });
});

// ─── The per-file guard ──────────────────────────────────────────────────────

/**
 * Module-level mutable state, as far as a line pattern can see it: a `let` /
 * `var` at column 0, or a `const` bound to an EMPTY collection — which is
 * only of use if something fills it later. A collection built with contents
 * (`new Set(["a", "b"])`) is a constant and does not match.
 *
 * What no line pattern sees: state closed over inside a function (an indented
 * `let` is nearly always a plain local), and a `const` object mutated in
 * place. A file that keeps either gives the snapshot a module-level hook and
 * a reader by hand — `caution.ts` is the one that does.
 */
const MODULE_STATE = [
  /^(?:export )?(?:let|var) \w+/m,
  /^(?:export )?const \w+\b.*?= new (?:Map|Set|WeakMap|WeakSet)(?:<.*>)?\(\);?\s*$/m,
];
const READER = /^export function (read\w+DebugState)\(/m;

const holdsModuleState = (source: string): boolean => MODULE_STATE.some((pattern) => pattern.test(source));

describe("every pit-crew file that holds module state exports a state reader", () => {
  const DIR = new URL(".", import.meta.url);
  const sources = readdirSync(DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".test-util.ts"))
    .map((name) => ({ name, source: readFileSync(new URL(name, DIR), "utf-8") }));
  const stateful = sources.filter(({ source }) => holdsModuleState(source));

  it("the patterns see module state and nothing else", () => {
    for (const line of [
      "let lastAt = 0;",
      "export let enabled = false;",
      "var legacy;",
      "const listeners = new Set<Listener>();",
      "const byCar: Map<number, () => void> = new Map();",
      "export const seen = new WeakSet<object>()",
    ]) {
      expect(holdsModuleState(`import x from "y";\n${line}\n`), line).toBe(true);
    }

    for (const line of [
      "  let idx = 0;",
      "const FLAGS = new Set([1, 2]);",
      "const LIMIT = 4;",
      "export const SOURCES: readonly string[] = [];",
      "// let me explain",
      "function build() {\n  const seen = new Set<number>();\n}",
    ]) {
      expect(holdsModuleState(`import x from "y";\n${line}\n`), line).toBe(false);
    }
  });

  it("finds the state-holding files — a walk that found none would pass everything below", () => {
    expect(sources.length).toBeGreaterThanOrEqual(35);
    expect(stateful.length).toBeGreaterThanOrEqual(FAMILY_KEYS.length);
  });

  it.each(stateful.map(({ name, source }) => [name, source] as const))(
    "%s exports a read…DebugState()",
    (_name, source) => {
      expect(READER.test(source)).toBe(true);
    },
  );

  it("every exported reader is one the aggregate calls", () => {
    const aggregate = sources.find(({ name }) => name === "debug-state.ts")?.source ?? "";
    const readers = sources.flatMap(({ source }) => READER.exec(source)?.[1] ?? []);

    expect(readers.length).toBeGreaterThanOrEqual(FAMILY_KEYS.length);

    for (const reader of readers) expect(aggregate, reader).toContain(`${reader}()`);
  });
});
