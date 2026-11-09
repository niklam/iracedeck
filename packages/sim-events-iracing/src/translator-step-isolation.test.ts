/**
 * A tick step's failure costs only that step (#1559): the translator-level tests
 * of the spec's Testing section.
 *
 * Every module the two `handleTick`s call is mocked with its real code wrapped
 * in a spy, as `tick-order.test.ts` does. A spy records each call with its
 * arguments; in probe mode it then emits one marked event through the emitter
 * it was handed, so on one tick every publishing step publishes something; and
 * it throws, after that probe, when the test names it. The steps run under the
 * default `"report"` policy against a logger that records its lines, so what a
 * throw cost is read from the bus and what it reported from the log.
 */
import type { IEventBus } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  ReplayStateTracker,
  type SDKController,
  SessionState,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type LeaderFinish, UNKNOWN_LEADER_FINISH } from "./leader-finish.js";
import { CONTROLLER_TICK_ORDER, REPLAY_RECORDER_ORDER, type TickStage } from "./tick-order.js";
import type { UnitRunner } from "./tick-steps.js";
import {
  _resetSimEventsIracing,
  initializeSimEventsIracing,
  onTranslatorTick,
  type SimEventsIracingOptions,
} from "./translator.js";

const TRANSLATOR_ID = "__sim-events-iracing__";
const RECORDER_ID = "__sim-events-iracing-replay-recorder__";

const harness = vi.hoisted(() => {
  const PROBE_KEY = "__stepProbe";
  const calls: Array<{ stage: string; args: unknown[] }> = [];
  const control = {
    /** Each spied publishing stage emits its probe event after its real call. */
    probe: false,
    probeEvents: new Map<string, string>(),
    /** The stages that throw (after their probe), each in the subscriber turn named. */
    throwing: new Map<string, string>(),
    /** Replaces a stage's real call. */
    overrides: new Map<string, (args: unknown[], original: (...a: unknown[]) => unknown) => unknown>(),
    /** The subscriber whose turn it is, set by the fake controller. */
    turn: "",
  };

  /**
   * Wrap the named exports of a module. `emitIndex` is the emitter's argument
   * index in the subscriber's call, or `null` for a step that emits nothing.
   */
  function spy<M>(mod: M, stages: Record<string, number | null>): M {
    const source = mod as Record<string, unknown>;
    const out: Record<string, unknown> = { ...source };

    for (const [name, emitIndex] of Object.entries(stages)) {
      const original = source[name] as (...a: unknown[]) => unknown;

      if (typeof original !== "function") throw new Error(`step-isolation spy: ${name} is not an exported function`);

      out[name] = (...args: unknown[]): unknown => {
        // Arrays are copied, so `pending` is recorded as the step saw it.
        calls.push({ stage: name, args: args.map((a) => (Array.isArray(a) ? [...(a as unknown[])] : a)) });
        const override = control.overrides.get(name);
        const result = override !== undefined ? override(args, original) : original(...args);

        if (control.probe && emitIndex !== null) {
          const event = control.probeEvents.get(name);

          if (event === undefined) throw new Error(`step-isolation spy: no probe event for ${name}`);

          (args[emitIndex] as (ev: unknown) => void)({ event, data: { [PROBE_KEY]: name } });
        }

        if (control.throwing.get(name) === control.turn) throw new Error(`${name} broke`);

        return result;
      };
    }

    return out as M;
  }

  return { PROBE_KEY, calls, control, spy };
});

vi.mock("./diff/start-lights.js", async (io) => harness.spy(await io(), { diffStartCountdown: 3, diffStartLights: 3 }));
vi.mock("./diff/replay-laps.js", async (io) => harness.spy(await io(), { diffReplayLaps: 4 }));
vi.mock("./diff/replay-greens.js", async (io) => harness.spy(await io(), { diffReplayGreens: 4 }));
vi.mock("./diff/replay-sessions.js", async (io) => harness.spy(await io(), { diffReplaySessions: 5 }));
vi.mock("./diff/replay-incidents.js", async (io) => harness.spy(await io(), { diffReplayIncidents: 4 }));
vi.mock("./diff/lifecycle.js", async (io) => harness.spy(await io(), { diffLifecycle: 2 }));
vi.mock("./diff/flags.js", async (io) => harness.spy(await io(), { diffFlags: 3 }));
vi.mock("./diff/laps.js", async (io) => harness.spy(await io(), { diffLaps: 6 }));
vi.mock("./diff/limiter.js", async (io) => harness.spy(await io(), { diffLimiter: 4 }));
vi.mock("./diff/pit-lane.js", async (io) => harness.spy(await io(), { diffPitLane: 4 }));
vi.mock("./diff/pace-laps.js", async (io) => harness.spy(await io(), { diffPaceLaps: 3, resolvePaceCarIdx: null }));
vi.mock("./diff/rolling-start.js", async (io) => harness.spy(await io(), { diffRollingStart: 3 }));
vi.mock("./diff/pits-open.js", async (io) => harness.spy(await io(), { diffPitsOpen: 3 }));
vi.mock("./diff/toggles.js", async (io) => harness.spy(await io(), { diffToggles: 3 }));
vi.mock("./diff/pit-status.js", async (io) => harness.spy(await io(), { diffPitStatus: 3 }));
vi.mock("./diff/pit-readback.js", async (io) => harness.spy(await io(), { diffPitReadback: 3 }));
vi.mock("./diff/stall-visit.js", async (io) => harness.spy(await io(), { updateStallVisit: null }));
vi.mock("./diff/tire-wear.js", async (io) => harness.spy(await io(), { diffTireWear: 2 }));
vi.mock("./diff/tire-temps.js", async (io) =>
  harness.spy(await io(), { diffTireTemps: null, readTireTempsLeavingCar: null }),
);
vi.mock("./diff/incidents.js", async (io) =>
  harness.spy(await io(), { diffIncidents: 3, resolveCollisionCarValue: null }),
);
vi.mock("./diff/damage.js", async (io) => harness.spy(await io(), { diffDamage: 3 }));
vi.mock("./diff/race-finish.js", async (io) => harness.spy(await io(), { updatePositionTracking: null }));
vi.mock("./race-order.js", async (io) => harness.spy(await io(), { calculateCanonicalRacePositions: null }));
vi.mock("./diff/caution.js", async (io) => harness.spy(await io(), { diffCaution: 4 }));
vi.mock("./diff/opponent-pit.js", async (io) => harness.spy(await io(), { diffOpponentPit: 10 }));
vi.mock("./diff/fastest-lap.js", async (io) => harness.spy(await io(), { diffFastestLap: 8 }));
vi.mock("./diff/opponent-flags.js", async (io) => harness.spy(await io(), { diffOpponentFlags: 12 }));
vi.mock("./diff/leader-white.js", async (io) => harness.spy(await io(), { diffLeaderWhite: 7 }));
vi.mock("./diff/overtakes.js", async (io) => harness.spy(await io(), { diffOvertakes: 7 }));
vi.mock("./diff/gaps.js", async (io) => harness.spy(await io(), { diffGaps: 7 }));
vi.mock("./diff/track-gaps.js", async (io) => harness.spy(await io(), { diffTrackGaps: null }));
vi.mock("./diff/pit-box-countdown.js", async (io) => harness.spy(await io(), { diffPitBoxCountdown: 4 }));
vi.mock("./diff/pit-lane-landmarks.js", async (io) =>
  harness.spy(await io(), {
    diffPitLaneLandmarks: 6,
    loadPitLaneLandmarkLearner: null,
    resolvePitLaneTrackIdentity: null,
  }),
);
vi.mock("./diff/corner-name.js", async (io) => harness.spy(await io(), { diffCornerName: 6 }));
vi.mock("./diff/sector-start.js", async (io) => harness.spy(await io(), { diffSectorStart: 7 }));
vi.mock("./diff/fuel-laps-left.js", async (io) => harness.spy(await io(), { diffFuelLapsLeft: 7 }));
vi.mock("./diff/fuel-laps.js", async (io) => harness.spy(await io(), { diffFuelLaps: null }));
vi.mock("./diff/radar.js", async (io) => harness.spy(await io(), { diffRadar: 2 }));
vi.mock("./diff/pit-speeding.js", async (io) => harness.spy(await io(), { diffPitSpeeding: 4 }));
vi.mock("./diff/track-wetness.js", async (io) => harness.spy(await io(), { diffTrackWetness: 2 }));
vi.mock("./session-type.js", async (io) => harness.spy(await io(), { resolveSessionType: null }));
vi.mock("./track-type.js", async (io) => harness.spy(await io(), { resolveTrackType: null }));

/** A stage that lives in a module the spies wrap. */
const isModuleStage = (stage: TickStage): boolean => stage.source.startsWith("diff/");

/** Every publishing module stage of a controller tick, in the order the bus sees them. */
const MODULE_STAGES = CONTROLLER_TICK_ORDER.filter(isModuleStage).map((s) => s.stage);

/** The steps that consume the canonical order, skipped on a tick it cannot be resolved (decision 3). */
const ORDER_CONSUMERS = [
  "diffCaution",
  "diffOpponentPit",
  "diffFastestLap",
  "diffOpponentFlags",
  "diffLeaderWhite",
  "diffOvertakes",
  "diffGaps",
];

/** The subscriber a stage runs in. */
const turnOf = (stage: string): string =>
  REPLAY_RECORDER_ORDER.some((s) => s.stage === stage) ? RECORDER_ID : TRANSLATOR_ID;

// --- The fake controller, bus and logger -----------------------------------

type Controller = SDKController & {
  tick: (telemetry: TelemetryData | null, isConnected?: boolean) => void;
  setSessionInfo: (info: Record<string, unknown> | null) => void;
};

function createController(): Controller {
  const subscribers = new Map<string, TelemetryCallback>();
  let sessionInfo: Record<string, unknown> | null = null;
  const replayState = new ReplayStateTracker();
  const controller = {
    subscribe: (id: string, cb: TelemetryCallback) => {
      subscribers.set(id, cb);
      harness.control.turn = id;
      cb(null, false);
    },
    unsubscribe: (id: string) => {
      subscribers.delete(id);
    },
    getSessionInfo: () => sessionInfo,
    getReplayState: (nowMs: number = Date.now()) => replayState.read(nowMs),
    noteReplayLeftForLive: (nowMs: number = Date.now()) => replayState.noteLeftForLive(nowMs),
  } as unknown as Controller;

  controller.tick = (telemetry, isConnected = true) => {
    if (telemetry) replayState.step(telemetry, sessionInfo, Date.now());
    else replayState.reset();

    for (const [id, cb] of [...subscribers]) {
      harness.control.turn = id;
      cb(telemetry, isConnected);
    }

    harness.control.turn = "";
  };
  controller.setSessionInfo = (info) => {
    sessionInfo = info;
  };

  return controller;
}

type Published = { event: string; data: unknown; probeOf?: string };

/** The probe whose publish the bus refuses, so the flush (part of the frame) throws. */
const busFault: { probeOf: string | null } = { probeOf: null };

function createRecordingBus(into: Published[]): IEventBus {
  return {
    publish: (ev: { event: string; data?: unknown }) => {
      const probeOf = (ev.data as Record<string, unknown> | undefined)?.[harness.PROBE_KEY];

      if (probeOf !== undefined && probeOf === busFault.probeOf) throw new Error("bus broke");

      into.push({ event: ev.event, data: ev.data, ...(typeof probeOf === "string" ? { probeOf } : {}) });
    },
    subscribe: () => () => undefined,
    unsubscribe: () => undefined,
  } as unknown as IEventBus;
}

function createLogger(lines: Array<{ level: string; message: string }>): ILogger {
  const write = (level: string) => (message: string) => {
    lines.push({ level, message });
  };
  const logger: ILogger = {
    trace: write("trace"),
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    withLevel: () => logger,
    createScope: () => logger,
  };

  return logger;
}

// --- The session ----------------------------------------------------------

/** A multi-class race: the player (car 0, class 1) and three opponents, one of class 2, and the pace car. */
function raceSessionInfo(drivers?: unknown[]): Record<string, unknown> {
  return {
    WeekendInfo: {
      SimMode: "full",
      TrackID: 1,
      TrackName: "testtrack",
      TrackLength: "4.00 km",
      TrackPitSpeedLimit: "60.00 kph",
    },
    SessionInfo: {
      Sessions: [
        {
          SessionNum: 0,
          SessionType: "Race",
          ResultsPositions: [{ CarIdx: 0, Position: 1, ClassPosition: 0, LapsComplete: 3 }],
        },
      ],
    },
    DriverInfo: {
      DriverCarIdx: 0,
      PaceCarIdx: 9,
      Drivers: drivers ?? [
        { CarIdx: 0, CarClassID: 1, UserID: 100, CarNumberRaw: 7 },
        { CarIdx: 1, CarClassID: 1, UserID: 101, CarNumberRaw: 8 },
        { CarIdx: 2, CarClassID: 2, UserID: 102, CarNumberRaw: 9 },
        { CarIdx: 9, CarClassID: -1, CarIsPaceCar: 1, UserID: -1, CarNumberRaw: 0 },
      ],
    },
  };
}

function telemetry(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: true,
    PlayerTrackSurface: TrkLoc.OnTrack,
    PlayerCarMyIncidentCount: 0,
    SessionFlags: 0,
    SessionNum: 0,
    SessionState: SessionState.Racing,
    PlayerCarPosition: 1,
    PitSvFlags: 0,
    EngineWarnings: 0,
    Speed: 0,
    CarLeftRight: CarLeftRight.Off,
    RPM: 0,
    Lap: 3,
    LapDistPct: 0.5,
    FuelLevel: 10,
    ...overrides,
  } as TelemetryData;
}

// --- The run --------------------------------------------------------------

let controller: Controller;
let published: Published[];
let lines: Array<{ level: string; message: string }>;

function start(options: SimEventsIracingOptions = {}, sessionInfo = raceSessionInfo()): void {
  published = [];
  lines = [];
  controller = createController();
  controller.setSessionInfo(sessionInfo);
  initializeSimEventsIracing(createRecordingBus(published), controller, createLogger(lines), {
    errorClock: () => 0,
    ...options,
  });
}

/** Run one tick and return what it published and the stages it called. */
function runTick(t: TelemetryData = telemetry()): { events: Published[]; probes: string[]; called: string[] } {
  published.length = 0;
  harness.calls.length = 0;
  controller.tick(t);

  return {
    events: [...published],
    probes: published.flatMap((e) => (e.probeOf !== undefined ? [e.probeOf] : [])),
    called: harness.calls.map((c) => c.stage),
  };
}

/** The ids the reporter wrote `error` lines for, in order. */
const reported = (): string[] =>
  lines.filter((l) => l.level === "error").map((l) => /^(\S+) threw/.exec(l.message)?.[1] ?? l.message);

/** The arguments of the last call of `stage` on the last tick. */
const argsOf = (stage: string): unknown[] | undefined => harness.calls.findLast((c) => c.stage === stage)?.args;

beforeEach(() => {
  harness.calls.length = 0;
  harness.control.probe = false;
  harness.control.probeEvents = new Map(
    MODULE_STAGES.map((s) => [s, CONTROLLER_TICK_ORDER.find((r) => r.stage === s)!.events[0]!]),
  );
  harness.control.throwing.clear();
  harness.control.overrides.clear();
  busFault.probeOf = null;
});

afterEach(() => {
  _resetSimEventsIracing();
});

// --- Tests ----------------------------------------------------------------

describe("a tick on which every step runs (the baseline the tests below compare against)", () => {
  it("publishes every module stage's probe in CONTROLLER_TICK_ORDER's order and reports nothing", () => {
    start();
    runTick();
    harness.control.probe = true;

    const { probes } = runTick();

    expect(probes).toEqual(MODULE_STAGES);
    expect(reported()).toEqual([]);
  });
});

describe("every step, made to throw in turn (#1559)", () => {
  it.each(MODULE_STAGES)(
    "%s: publishes every other step's events, in order, none of its own, and reports its id",
    (stage) => {
      start();
      runTick();
      harness.control.probe = true;
      harness.control.throwing.set(stage, turnOf(stage));

      const { probes } = runTick();

      expect(probes).toEqual(MODULE_STAGES.filter((s) => s !== stage));
      expect(reported()).toEqual([`${turnOf(stage) === RECORDER_ID ? "replay-recorder" : "translator"}:${stage}`]);

      // And the step is called again on the next tick, and commits again.
      harness.control.throwing.clear();
      expect(runTick().probes).toEqual(MODULE_STAGES);
    },
  );

  // The steps and values that publish nothing: a throw is reported, and every
  // publishing step still publishes, but for the consumers decision 3 skips.
  it.each<{ throwing: string; ids: string[]; skipped: readonly string[]; firstCallOnly?: boolean }>([
    { throwing: "diffTireTemps", ids: ["diffTireTemps"], skipped: [] },
    { throwing: "diffFuelLaps", ids: ["diffFuelLaps"], skipped: [] },
    { throwing: "diffTrackGaps", ids: ["diffTrackGaps"], skipped: [] },
    { throwing: "resolveSessionType", ids: ["resolveSessionType"], skipped: [] },
    { throwing: "resolveTrackType", ids: ["resolveTrackType"], skipped: [] },
    { throwing: "resolveCollisionCarValue", ids: ["resolveCollisionCarValue"], skipped: [] },
    { throwing: "resolvePitLaneTrackIdentity", ids: ["resolvePitLaneTrackIdentity"], skipped: [] },
    { throwing: "loadPitLaneLandmarkLearner", ids: ["loadPitLaneLandmarkLearner"], skipped: [] },
    // Only the tick's own read: `diffCaution` and the recorder resolve the pace car themselves.
    { throwing: "resolvePaceCarIdx", ids: ["resolvePaceCarIdx"], skipped: [], firstCallOnly: true },
    { throwing: "updateStallVisit", ids: ["updateStallVisit"], skipped: ["diffTireWear"] },
    { throwing: "updatePositionTracking", ids: ["updatePositionTracking"], skipped: ORDER_CONSUMERS },
    // In a race the leader flag reads the order first, then the order itself.
    {
      throwing: "calculateCanonicalRacePositions",
      ids: ["resolvePlayerIsLeader", "resolveCanonicalOrder"],
      skipped: ORDER_CONSUMERS,
    },
  ])("$throwing: reports $ids and skips $skipped", ({ throwing, ids, skipped, firstCallOnly }) => {
    start();
    runTick();
    harness.control.probe = true;

    if (firstCallOnly === true) {
      let calls = 0;

      harness.control.overrides.set(throwing, (args, original) => {
        calls++;

        if (calls === 1) throw new Error(`${throwing} broke`);

        return original(...args);
      });
    } else {
      harness.control.throwing.set(throwing, TRANSLATOR_ID);
    }

    const { probes, called } = runTick();

    expect(probes).toEqual(MODULE_STAGES.filter((s) => !skipped.includes(s)));
    expect(called.filter((s) => skipped.includes(s))).toEqual([]);
    expect(reported()).toEqual(ids.map((id) => `translator:${id}`));

    harness.control.throwing.clear();
    harness.control.overrides.clear();
    expect(runTick().probes).toEqual(MODULE_STAGES);
  });

  it("readTireTempsLeavingCar: a throw on the replay guard's entry tick is reported, and the tick still enters the replay", () => {
    start();
    runTick();
    harness.control.probe = true;
    harness.control.throwing.set("readTireTempsLeavingCar", TRANSLATOR_ID);

    const entry = runTick(telemetry({ IsReplayPlaying: true, IsOnTrack: false }));

    expect(reported()).toEqual(["translator:readTireTempsLeavingCar"]);
    // The pre-guard countdown and the recorder's four still published; no live diff ran.
    expect(entry.probes).toEqual(["diffStartCountdown", ...REPLAY_RECORDER_ORDER.map((s) => s.stage)]);
    expect(entry.called).not.toContain("diffLifecycle");
  });
});

describe("decision 2: a step is all or nothing", () => {
  it("diffIncidents emitting incident.occurred and then throwing publishes neither of its pair, and the lap before it still publishes", () => {
    start();
    runTick();
    harness.control.probe = true;
    harness.control.overrides.set("diffIncidents", (args) => {
      const emit = args[3] as (ev: unknown) => void;

      emit({ event: "incident.occurred", data: {} });
      throw new Error("incident burst broke");
    });

    const { events, probes } = runTick();

    expect(events.filter((e) => e.event.startsWith("incident."))).toEqual([]);
    expect(probes).toContain("diffLaps");
    expect(reported()).toEqual(["translator:diffIncidents"]);
  });

  it("diffPitLane throwing on an approach tick leaves the readback and tire-wear steps a pending list without its edge", () => {
    start();
    runTick();
    harness.control.probe = true;
    harness.control.overrides.set("diffPitLane", (args) => {
      (args[4] as (ev: unknown) => void)({ event: "pitLane.approaching", data: {} });
      throw new Error("pit lane broke");
    });

    const { probes } = runTick();
    const seenBy = (stage: string, index: number): string[] =>
      (argsOf(stage)![index] as Array<{ event: string }>).map((e) => e.event);

    expect(seenBy("diffPitReadback", 4)).not.toContain("pitLane.approaching");
    expect(seenBy("updateStallVisit", 2)).not.toContain("pitLane.approaching");
    expect(seenBy("diffTireWear", 3)).not.toContain("pitLane.approaching");
    // What came before it in the tick (the lap) is still published.
    expect(probes).toContain("diffLaps");
    expect(probes).not.toContain("diffPitLane");
  });

  // The per-car units: each diff that loops over independent cars is handed the
  // step runner's `runUnit`, through which a car's throw drops that car only and
  // is reported under the step's id. What each diff does per car is the diff's
  // own tests'; here the wiring is proven through the real subscribers.
  it.each([
    { stage: "diffReplayLaps", emitIndex: 4, runUnitIndex: 5, id: "replay-recorder:diffReplayLaps" },
    { stage: "diffReplayIncidents", emitIndex: 4, runUnitIndex: 5, id: "replay-recorder:diffReplayIncidents" },
    { stage: "diffOpponentPit", emitIndex: 10, runUnitIndex: 11, id: "translator:diffOpponentPit" },
    { stage: "diffOpponentFlags", emitIndex: 12, runUnitIndex: 14, id: "translator:diffOpponentFlags" },
  ])(
    "$stage runs its cars through the step's units: one car's throw costs that car only",
    ({ stage, emitIndex, runUnitIndex, id }) => {
      start();
      runTick();
      const event = harness.control.probeEvents.get(stage)!;
      harness.control.overrides.set(stage, (args) => {
        const runUnit = args[runUnitIndex] as UnitRunner;
        const emit = args[emitIndex] as (ev: unknown) => void;

        for (const car of [0, 1, 2]) {
          runUnit(emit, (unitEmit) => {
            unitEmit({ event, data: { car } });

            if (car === 1) throw new Error(`car ${car} broke`);
          });
        }
      });

      const { events } = runTick();

      expect(events.filter((e) => e.event === event).map((e) => e.data)).toEqual([{ car: 0 }, { car: 2 }]);
      expect(reported()).toEqual([id]);
    },
  );
});

describe("decision 3: a value that throws takes its last value this session", () => {
  /** A driver list with a `null` entry, which `resolveIsMultiClass` reads without `?.`. */
  const faultyDrivers = (): unknown[] => [...(raceSessionInfo().DriverInfo as { Drivers: unknown[] }).Drivers, null];
  const multiClassSeen = (): unknown[] => [
    argsOf("diffLaps")?.[3],
    argsOf("diffOvertakes")?.[4],
    argsOf("diffOpponentPit")?.[7],
    argsOf("diffOpponentFlags")?.[8],
    argsOf("diffFastestLap")?.[6],
  ];

  it("hands the consumers the session's last isMultiClass when a null Drivers entry makes it throw mid-session, and the radar still publishes", () => {
    start();
    runTick();
    expect(multiClassSeen()).toEqual([true, true, true, true, true]);

    controller.setSessionInfo(raceSessionInfo(faultyDrivers()));
    harness.control.probe = true;
    const { probes } = runTick();

    expect(reported()).toContain("translator:resolveIsMultiClass");
    expect(multiClassSeen()).toEqual([true, true, true, true, true]);
    expect(probes).toContain("diffRadar");
  });

  it("hands them null when the fault is there from the session's first update", () => {
    start({}, raceSessionInfo(faultyDrivers()));
    runTick();

    expect(reported()).toContain("translator:resolveIsMultiClass");
    // The opponent diffs take `isMultiClass === true`.
    expect(multiClassSeen()).toEqual([null, null, false, false, null]);
  });

  it("forgets the last value on a session change and on a disconnect, and keeps it across a replay glance", () => {
    start();
    runTick();

    // A replay glance: in, and back out to the same session.
    runTick(telemetry({ IsReplayPlaying: true, IsOnTrack: false }));
    controller.setSessionInfo(raceSessionInfo(faultyDrivers()));
    // Past the replay exit grace, so the tick is live.
    const live = (): void => {
      runTick(telemetry());
    };

    vi.useFakeTimers({ now: Date.now() + 10_000 });

    try {
      live();
      live();
      expect(argsOf("diffOvertakes")?.[4]).toBe(true);

      // A session change.
      controller.setSessionInfo(raceSessionInfo());
      runTick(telemetry({ SessionNum: 0 }));
      controller.setSessionInfo({
        ...raceSessionInfo(faultyDrivers()),
        SessionInfo: { Sessions: [{ SessionNum: 1, SessionType: "Race" }] },
      });
      runTick(telemetry({ SessionNum: 1 }));
      expect(argsOf("diffOvertakes")?.[4]).toBeNull();

      // A disconnect, after a good tick of the new session.
      controller.setSessionInfo({
        ...raceSessionInfo(),
        SessionInfo: { Sessions: [{ SessionNum: 1, SessionType: "Race" }] },
      });
      runTick(telemetry({ SessionNum: 1 }));
      expect(argsOf("diffOvertakes")?.[4]).toBe(true);
      controller.tick(null, false);
      controller.setSessionInfo({
        ...raceSessionInfo(faultyDrivers()),
        SessionInfo: { Sessions: [{ SessionNum: 1, SessionType: "Race" }] },
      });
      runTick(telemetry({ SessionNum: 1 }));
      expect(argsOf("diffOvertakes")?.[4]).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps isRaceSession true when resolveSessionType throws mid-race, so a PitsOpen transition on that tick is announced", () => {
    start();
    runTick(telemetry({ PitsOpen: false }));
    runTick(telemetry({ PitsOpen: false }));
    harness.control.throwing.set("resolveSessionType", TRANSLATOR_ID);

    const { events } = runTick(telemetry({ PitsOpen: true }));

    expect(reported()).toEqual(["translator:resolveSessionType"]);
    expect(argsOf("diffPitsOpen")?.[2]).toBe(true);
    expect(events.filter((e) => e.event === "pitsOpen.changed").map((e) => e.data)).toEqual([
      { from: false, to: true },
    ]);
  });

  it("hands diffLaps null when resolvePlayerResultsSnapshot throws, even after good snapshots", () => {
    start();
    runTick();
    expect(argsOf("diffLaps")?.[4]).toEqual({ lapsComplete: 3, position: 1, classPosition: 0 });

    const info = raceSessionInfo();
    const session = (info.SessionInfo as { Sessions: Array<Record<string, unknown>> }).Sessions[0]!;
    session.ResultsPositions = [null, { CarIdx: 0, Position: 1, ClassPosition: 0, LapsComplete: 3 }];
    controller.setSessionInfo(info);
    runTick();

    expect(reported()).toContain("translator:resolvePlayerResultsSnapshot");
    expect(argsOf("diffLaps")?.[4]).toBeNull();
  });

  it("hands diffFlags false when resolvePlayerIsLeader throws", () => {
    start();
    runTick();
    expect(argsOf("diffFlags")?.[5]).toBe(true);

    // The leader flag is the tick's first read of the order in a race.
    let reads = 0;
    harness.control.overrides.set("calculateCanonicalRacePositions", (args, original) => {
      reads++;

      if (reads === 1) throw new Error("order broke");

      return original(...args);
    });
    runTick();

    expect(reported()).toEqual(["translator:resolvePlayerIsLeader"]);
    expect(argsOf("diffFlags")?.[5]).toBe(false);
    // The order itself resolved, so its consumers ran.
    expect(harness.calls.map((c) => c.stage)).toEqual(expect.arrayContaining(ORDER_CONSUMERS));
  });

  it.each(["updatePositionTracking", "calculateCanonicalRacePositions"])(
    "a failed order (%s) skips its six consumers, runs diffFuelLapsLeft with a leader closure that knows nothing, and calls all of them next tick",
    (throwing) => {
      start();
      runTick();
      harness.control.throwing.set(throwing, TRANSLATOR_ID);

      const { called } = runTick();

      expect(called.filter((s) => ORDER_CONSUMERS.includes(s))).toEqual([]);
      // The leader closure (#1405): no lap time, no chequered prediction and
      // no lap-counter gap.
      const leaderFinish = argsOf("diffFuelLapsLeft")?.[6] as () => LeaderFinish;
      expect(leaderFinish()).toEqual(UNKNOWN_LEADER_FINISH);

      harness.control.throwing.clear();
      expect(runTick().called.filter((s) => ORDER_CONSUMERS.includes(s))).toEqual(ORDER_CONSUMERS);
    },
  );
});

describe("decision 4: a step reading another step's state still runs", () => {
  it("diffFlags throwing still runs diffLaps and diffFuelLapsLeft", () => {
    start();
    runTick();
    harness.control.probe = true;
    harness.control.throwing.set("diffFlags", TRANSLATOR_ID);

    const { probes } = runTick();

    expect(probes).toEqual(expect.arrayContaining(["diffLaps", "diffFuelLapsLeft"]));
  });

  it("diffToggles throwing after a tick on which the fuel plan changed hands diffPitReadback false", () => {
    start();
    runTick();
    harness.control.overrides.set("diffToggles", () => true);
    runTick();
    expect(argsOf("diffPitReadback")?.[5]).toBe(true);

    harness.control.overrides.set("diffToggles", () => {
      throw new Error("toggles broke");
    });
    runTick();

    expect(reported()).toEqual(["translator:diffToggles"]);
    expect(argsOf("diffPitReadback")?.[5]).toBe(false);
  });
});

describe('decision 5 and 8: under "rethrow"', () => {
  it("every step runs and the first error is thrown only after the earlier steps' events are on the bus", () => {
    start({ onStepError: "rethrow" });
    runTick();
    harness.control.probe = true;
    harness.control.throwing.set("diffLaps", TRANSLATOR_ID);
    harness.control.throwing.set("diffRadar", TRANSLATOR_ID);
    published.length = 0;

    expect(() => controller.tick(telemetry())).toThrow("diffLaps broke");

    const probes = published.flatMap((e) => (e.probeOf !== undefined ? [e.probeOf] : []));
    // Every translator step but the two that threw published, in order, flush included.
    const translatorStages = MODULE_STAGES.filter((s) => turnOf(s) === TRANSLATOR_ID);
    expect(probes.filter((s) => turnOf(s) === TRANSLATOR_ID)).toEqual(
      translatorStages.filter((s) => s !== "diffLaps" && s !== "diffRadar"),
    );
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("lets a frame throw after a step's throw surface itself, runs the listeners, and carries the step's error into no later tick", () => {
    start({ onStepError: "rethrow" });
    runTick();
    let listened = 0;
    onTranslatorTick(() => {
      listened++;
    });
    harness.control.probe = true;
    // A step throws (held), then the flush, which is the frame, throws on a later step's event.
    harness.control.throwing.set("diffLaps", TRANSLATOR_ID);
    busFault.probeOf = "diffRadar";

    expect(() => controller.tick(telemetry())).toThrow("bus broke");
    expect(listened).toBe(1);

    harness.control.throwing.clear();
    busFault.probeOf = null;
    expect(() => controller.tick(telemetry())).not.toThrow();
    expect(listened).toBe(2);
  });
});

describe("decision 7: the reporter", () => {
  it("is made per initializeSimEventsIracing call: two inits after a reset share no counts", () => {
    start();
    runTick();
    harness.control.throwing.set("diffRadar", TRANSLATOR_ID);
    runTick();
    runTick();
    expect(reported()).toEqual(["translator:diffRadar"]);

    _resetSimEventsIracing();
    start();
    runTick();

    // A first occurrence again, not a repeat counted against the first init.
    expect(reported()).toEqual(["translator:diffRadar"]);
  });

  it("reads the injected clock: a step that keeps throwing is summarised a window later", () => {
    let clock = 0;
    start({ errorClock: () => clock });
    runTick();
    harness.control.throwing.set("diffRadar", TRANSLATOR_ID);

    for (const at of [0, 20_000, 40_000, 60_000]) {
      clock = at;
      runTick();
    }

    expect(reported()).toEqual(["translator:diffRadar"]);
    expect(lines.filter((l) => l.level === "warn").map((l) => l.message)).toEqual([
      expect.stringMatching(/^translator:diffRadar threw 3 more times in the last 60s/),
    ]);
  });
});

describe("decision 1: the frame is not split", () => {
  it("a throw in the frame leaves the translator's callback unreported, for the controller's subscriber boundary", () => {
    start();
    runTick();
    harness.control.probe = true;
    const unreadable = telemetry();
    Object.defineProperty(unreadable, "SessionNum", {
      get: () => {
        throw new Error("unreadable tick");
      },
    });

    // The fake controller has no subscriber boundary: the throw reaches it, as it reaches #1558's.
    expect(() => controller.tick(unreadable)).toThrow("unreadable tick");
    expect(reported()).toEqual([]);
  });
});
