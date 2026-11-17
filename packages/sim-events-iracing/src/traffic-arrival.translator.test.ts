/**
 * The approaching-traffic reference curves through the real tick (issue
 * #1113): every live tick feeds the `trafficArrival` slice from the cars on
 * the racing surface, the class info is read once per session-info object, a
 * replay glance keeps the curves whole and feeds them nothing, and a session
 * change or a disconnect starts them afresh.
 */
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  REPLAY_EXIT_GRACE_MS,
  ReplayStateTracker,
  type SDKController,
  SessionState,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTrafficClassInfo, TRAFFIC_CURVE_BINS } from "./diff/traffic-arrival.js";
import type { TrafficArrivalState } from "./state.js";
import { _resetSimEventsIracing, initializeSimEventsIracing, readSimState } from "./translator.js";

// The real class-info reader behind a spy, so a test can count how often the
// translator's memo runs it.
vi.mock("./diff/traffic-arrival.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./diff/traffic-arrival.js")>();

  return { ...actual, resolveTrafficClassInfo: vi.fn(actual.resolveTrafficClassInfo) };
});

const GTP = 4029;
const GTD = 4011;
const PACE_CAR_CLASS = 11;

function createMockLogger(): ILogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: vi.fn(),
    createScope: vi.fn(),
  } as unknown as ILogger;
}

type MockController = SDKController & {
  __tick: (telemetry: TelemetryData) => void;
  __disconnect: () => void;
  sessionInfo: Record<string, unknown>;
};

/** A multiclass session: car 0 (the player) and car 1 GTD, car 2 GTP, car 3 the pace car. */
function sessionInfo(): Record<string, unknown> {
  return {
    SessionInfo: {
      Sessions: [
        { SessionNum: 0, SessionType: "Practice" },
        { SessionNum: 1, SessionType: "Race" },
      ],
    },
    WeekendInfo: { TrackID: 7, TrackLength: "5.79 km", SimMode: "full" },
    DriverInfo: {
      DriverCarIdx: 0,
      PaceCarIdx: 3,
      Drivers: [
        { CarIdx: 0, CarClassID: GTD, CarClassEstLapTime: 105.5726 },
        { CarIdx: 1, CarClassID: GTD, CarClassEstLapTime: 105.5726 },
        { CarIdx: 2, CarClassID: GTP, CarClassEstLapTime: 91.6077 },
        { CarIdx: 3, CarClassID: PACE_CAR_CLASS, CarClassEstLapTime: 110.0344, CarIsPaceCar: 1 },
      ],
    },
  };
}

function createMockController(): MockController {
  const subscribers = new Map<string, TelemetryCallback>();
  const replayState = new ReplayStateTracker();
  const controller = {
    sessionInfo: sessionInfo(),
    subscribe: (id: string, cb: TelemetryCallback) => {
      subscribers.set(id, cb);
      cb(null, false);
    },
    unsubscribe: (id: string) => {
      subscribers.delete(id);
    },
    getSessionInfo: () => controller.sessionInfo,
    getReplayState: (nowMs: number = Date.now()) => replayState.read(nowMs),
    noteReplayLeftForLive: (nowMs: number = Date.now()) => replayState.noteLeftForLive(nowMs),
  } as unknown as MockController;

  controller.__tick = (telemetry) => {
    replayState.step(telemetry, controller.sessionInfo, Date.now());

    for (const cb of [...subscribers.values()]) cb(telemetry, true);
  };
  controller.__disconnect = () => {
    for (const cb of [...subscribers.values()]) cb(null, false);
  };

  return controller;
}

type CarReading = { pct: number; est: number; surface?: number };

/**
 * A live tick with the player (car 0) on track at 0.5 and the given cars;
 * every other slot not in world. Classes as the telemetry reports them: the
 * pace car (car 3) reads -1.
 */
function tick(cars: Record<number, CarReading>, opts: { sessionNum?: number; replay?: boolean } = {}): TelemetryData {
  const size = 4;
  const pcts = Array<number>(size).fill(-1);
  const ests = Array<number>(size).fill(-1);
  const surfaces = Array<number>(size).fill(TrkLoc.NotInWorld);
  const all: Record<number, CarReading> = { 0: { pct: 0.5, est: 52.8 }, ...cars };

  for (const [key, car] of Object.entries(all)) {
    const i = Number(key);

    pcts[i] = car.pct;
    ests[i] = car.est;
    surfaces[i] = car.surface ?? TrkLoc.OnTrack;
  }

  return {
    SessionTime: 100,
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: !(opts.replay ?? false),
    IsReplayPlaying: opts.replay ?? false,
    PlayerTrackSurface: TrkLoc.OnTrack,
    PlayerTrackSurfaceMaterial: 0,
    PlayerCarMyIncidentCount: 0,
    PlayerIncidents: 0,
    SessionFlags: 0,
    SessionNum: opts.sessionNum ?? 0,
    SessionState: SessionState.Racing,
    SessionLapsRemainEx: 20,
    SessionTimeRemain: 1800,
    PitSvFlags: 0,
    PitSvTireCompound: 0,
    PlayerTireCompound: 0,
    EngineWarnings: 0,
    Speed: 40,
    CarLeftRight: CarLeftRight.Off,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: 4,
    LapCompleted: 3,
    LapDistPct: 0.5,
    FuelLevel: 10,
    CarIdxLapCompleted: pcts.map((p) => (p < 0 ? -1 : 3)),
    CarIdxLap: pcts.map((p) => (p < 0 ? -1 : 4)),
    CarIdxLapDistPct: pcts,
    CarIdxTrackSurface: surfaces,
    CarIdxOnPitRoad: Array<boolean>(size).fill(false),
    CarIdxEstTime: ests,
    CarIdxClass: [GTD, GTD, GTP, -1],
    CarIdxLastLapTime: Array<number>(size).fill(100),
  } as TelemetryData;
}

/** The translator's `trafficArrival` slice as the Telemetry Snapshot carries it. */
function slice(): TrafficArrivalState {
  const state = readSimState();

  if (!state.initialized) throw new Error("translator not initialised");

  return state.raw.state.trafficArrival;
}

function bin(cls: number, pct: number): unknown {
  return slice().curves[String(cls)]?.bins[Math.floor(pct * TRAFFIC_CURVE_BINS)] ?? null;
}

describe("the traffic reference curves through handleTick (issue #1113)", () => {
  let controller: MockController;

  beforeEach(() => {
    initializeEventBus(createMockLogger());
    controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });
    vi.mocked(resolveTrafficClassInfo).mockClear();
  });

  afterEach(() => {
    _resetSimEventsIracing();
    _resetEventBus();
    vi.useRealTimers();
  });

  it("learns every class from the cars on the racing surface, the player and the pace car included", () => {
    expect(slice().curves).toEqual({});

    controller.__tick(
      tick({
        1: { pct: 0.3778, est: 40.028, surface: TrkLoc.OffTrack },
        2: { pct: 0.3756, est: 34.535 },
        3: { pct: 0.2, est: 22 },
      }),
    );

    expect(Object.keys(slice().curves).sort()).toEqual([String(PACE_CAR_CLASS), String(GTD), String(GTP)].sort());
    expect(bin(GTD, 0.5)).toEqual({ pct: 0.5, estTime: 52.8, samples: 1 });
    expect(bin(GTD, 0.3778)).toEqual({ pct: 0.3778, estTime: 40.028, samples: 1 });
    expect(bin(GTP, 0.3756)).toEqual({ pct: 0.3756, estTime: 34.535, samples: 1 });
    // The pace car reads CarIdxClass -1; its class comes from DriverInfo.
    expect(bin(PACE_CAR_CLASS, 0.2)).toEqual({ pct: 0.2, estTime: 22, samples: 1 });
  });

  it("learns nothing from a car in its stall or approaching the pits", () => {
    controller.__tick(
      tick({
        1: { pct: 0.05, est: 5, surface: TrkLoc.InPitStall },
        2: { pct: 0.97, est: 89, surface: TrkLoc.AproachingPits },
      }),
    );

    // Only the player's sample.
    expect(Object.keys(slice().curves)).toEqual([String(GTD)]);
    expect(slice().curves[String(GTD)].bins.filter((b) => b !== null)).toHaveLength(1);
  });

  it("keeps the slice JSON-serialisable for the Telemetry Snapshot", () => {
    controller.__tick(tick({ 2: { pct: 0.3756, est: 34.535 } }));

    expect(JSON.parse(JSON.stringify(slice()))).toEqual(slice());
  });

  it("reads the class info once per session-info object, and again when it changes", () => {
    const resolve = vi.mocked(resolveTrafficClassInfo);

    controller.__tick(tick({}));
    controller.__tick(tick({}));

    expect(resolve).toHaveBeenCalledOnce();

    controller.sessionInfo = sessionInfo();
    controller.__tick(tick({}));

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("keeps the curves whole through a replay glance, and learns nothing from the replay's ticks", () => {
    vi.useFakeTimers();
    controller.__tick(tick({ 2: { pct: 0.3756, est: 34.535 } }));

    const learned = structuredClone(slice());

    // The first live tick read every car's progress.
    expect(learned.motion[2]).toEqual({ fromPct: 0.3756, fromTime: 100, rate: null, rateAt: null });

    controller.__tick(tick({ 2: { pct: 0.6, est: 60 } }, { replay: true }));

    expect(slice().curves).toEqual(learned.curves);
    // Each car's progress is a run of live readings the glance broke: measured afresh.
    expect(slice().motion).toEqual({});

    // Back to live, past the replay state's exit grace (#1324): learning resumes.
    vi.advanceTimersByTime(REPLAY_EXIT_GRACE_MS + 1);
    controller.__tick(tick({ 2: { pct: 0.6, est: 60 } }));

    expect(bin(GTP, 0.3756)).toEqual({ pct: 0.3756, estTime: 34.535, samples: 1 });
    expect(bin(GTP, 0.6)).toEqual({ pct: 0.6, estTime: 60, samples: 1 });
  });

  it("starts the curves afresh at a session change and after a disconnect", () => {
    controller.__tick(tick({ 2: { pct: 0.3756, est: 34.535 } }));

    expect(bin(GTP, 0.3756)).not.toBeNull();

    controller.__tick(tick({}, { sessionNum: 1 }));

    // The new session's first tick learns only what it reads: the player.
    expect(Object.keys(slice().curves)).toEqual([String(GTD)]);
    expect(bin(GTP, 0.3756)).toBeNull();

    controller.__tick(tick({ 2: { pct: 0.3756, est: 34.535 } }, { sessionNum: 1 }));

    expect(bin(GTP, 0.3756)).not.toBeNull();

    controller.__disconnect();

    expect(slice().curves).toEqual({});
  });
});
