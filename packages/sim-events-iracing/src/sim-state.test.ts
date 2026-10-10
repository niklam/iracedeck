/**
 * Tests for the translator's state reader (issue #1387): `readSimState()`,
 * the pure `buildSimState` it shapes its result with, and `simStateHeadline`.
 *
 * The reader tests drive the real translator through a fake `sdkController`,
 * the `translator.test.ts` pattern, because what they pin is the wiring: that
 * the laps-of-fuel-left figure in the snapshot is the callout's own, on the
 * same tick, from the same stats and margin.
 */
import { _resetEventBus, getEventBus, initializeEventBus, type SimEventOf } from "@iracedeck/event-bus";
import {
  Flags,
  IRSDK_UNLIMITED_LAPS,
  IRSDK_UNLIMITED_TIME,
  type SDKController,
  SessionState,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FUEL_LAPS_LEFT_WINDOW_LAPS } from "./diff/fuel-laps-left.js";
import { createFuelLapTracker, type FuelLap } from "./diff/fuel-laps.js";
import { buildSimState, simStateHeadline, type SimStateParts, type SimStateSnapshot } from "./sim-state.js";
import { createInitialState } from "./state.js";
import { TrackDirection } from "./track-type.js";
import {
  _resetSimEventsIracing,
  getCautionEpisode,
  getCautionPhase,
  getFuelStats,
  getLiveGaps,
  getLiveRacePositions,
  initializeSimEventsIracing,
  readSimState,
  type SimEventsIracingOptions,
} from "./translator.js";

type InitializedSimState = Extract<SimStateSnapshot, { initialized: true }>;

function createMockLogger(): ILogger {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: vi.fn(),
    createScope: vi.fn(),
  };

  return logger as unknown as ILogger;
}

type MockController = SDKController & {
  __tick: (telemetry: TelemetryData | null, isConnected?: boolean) => void;
  __setSessionInfo: (info: Record<string, unknown> | null) => void;
};

/** The `translator.test.ts` controller double: `subscribe` replays the offline tick the real one sends. */
function createMockController(): MockController {
  let callback: TelemetryCallback | null = null;
  let sessionInfo: Record<string, unknown> | null = null;

  const controller = {
    subscribe: (_id: string, cb: TelemetryCallback) => {
      callback = cb;
      cb(null, false);
    },
    unsubscribe: (_id: string) => {
      callback = null;
    },
    getSessionInfo: () => sessionInfo,
  } as unknown as MockController;

  controller.__tick = (telemetry, isConnected = true) => {
    callback?.(telemetry, isConnected);
  };
  controller.__setSessionInfo = (info) => {
    sessionInfo = info;
  };

  return controller;
}

function telemetry(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: true,
    PlayerTrackSurface: TrkLoc.OnTrack,
    PlayerTrackSurfaceMaterial: 0,
    PlayerCarMyIncidentCount: 0,
    PlayerIncidents: 0,
    SessionFlags: 0,
    SessionNum: 0,
    PitSvFlags: 0,
    PitSvTireCompound: 0,
    PlayerTireCompound: 0,
    EngineWarnings: 0,
    Speed: 0,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: 0,
    LapDistPct: 0,
    FuelLevel: 10,
    ...overrides,
  } as TelemetryData;
}

const RACE_SESSION = {
  SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
  DriverInfo: { DriverCarIdx: 0 },
};

function start(
  sessionInfo: Record<string, unknown> | null = RACE_SESSION,
  options: SimEventsIracingOptions = {},
): { controller: MockController; logger: ILogger } {
  const controller = createMockController();
  const logger = createMockLogger();

  controller.__setSessionInfo(sessionInfo);
  initializeSimEventsIracing(getEventBus(), controller, logger, options);

  return { controller, logger };
}

function read(): InitializedSimState {
  const state = readSimState();

  if (!state.initialized) throw new Error("expected an initialized sim state");

  return state;
}

/**
 * Two validated laps (1.9 L / 85 s, then 2.0 L / 90 s) through the real #465
 * tracker, ending at the start of lap 4 with the tank still far above the
 * callout's 10-count ceiling. The `translator.test.ts` recipe; `extra` rides
 * on every tick.
 */
function driveTwoValidLaps(controller: MockController, extra: Partial<TelemetryData> = {}): void {
  const ticks: Array<Partial<TelemetryData>> = [
    { Lap: 1, LapDistPct: 0.9, SessionTime: 0, FuelLevel: 64 },
    { Lap: 2, LapDistPct: 0.05, SessionTime: 5, FuelLevel: 63.9 },
    { Lap: 2, LapDistPct: 0.55, SessionTime: 45, FuelLevel: 63 },
    { Lap: 2, LapDistPct: 0.9, SessionTime: 80, FuelLevel: 62.2 },
    { Lap: 3, LapDistPct: 0.05, SessionTime: 90, FuelLevel: 62 },
    { Lap: 3, LapDistPct: 0.55, SessionTime: 135, FuelLevel: 61 },
    { Lap: 3, LapDistPct: 0.9, SessionTime: 170, FuelLevel: 60.2 },
    { Lap: 4, LapDistPct: 0.05, SessionTime: 180, FuelLevel: 60 },
  ];

  for (const tick of ticks) controller.__tick(telemetry({ ...tick, ...extra }));
}

/**
 * A local stand-in for the JSON-safe encoder `@iracedeck/diagnostics` runs
 * over a section — this package must not import it. Only what the test needs:
 * a Set becomes an array, a Map an array of pairs.
 */
function toPlain(value: unknown): unknown {
  if (value instanceof Set) return Array.from(value, toPlain);

  if (value instanceof Map) return Array.from(value, ([key, entry]) => [toPlain(key), toPlain(entry)]);

  if (Array.isArray(value)) return Array.from(value, toPlain);

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toPlain(entry)]));
  }

  return value;
}

/** Every function reachable from `value`, by path — a closure, a logger or the controller would show up here. */
function functionPaths(value: unknown, path = "state", seen = new Set<unknown>()): string[] {
  if (typeof value === "function") return [path];

  if (value === null || typeof value !== "object" || seen.has(value)) return [];

  seen.add(value);

  const children: Array<[string, unknown]> =
    value instanceof Set
      ? Array.from(value, (entry, i) => [`${path}{${i}}`, entry])
      : value instanceof Map
        ? Array.from(value, ([key, entry]) => [`${path}<${String(key)}>`, entry])
        : Object.entries(value).map(([key, entry]) => [`${path}.${key}`, entry]);

  return children.flatMap(([childPath, child]) => functionPaths(child, childPath, seen));
}

function validLap(lapNumber: number, fuelUsed: number, lapTime: number): FuelLap {
  return {
    lapNumber,
    fuelUsed,
    lapTime,
    isValidForCalc: true,
    isOutLap: false,
    isInLap: false,
    wasTowed: false,
    wasCaution: false,
  };
}

function parts(overrides: Partial<SimStateParts> = {}): SimStateParts {
  return {
    telemetry: null,
    fuel: {
      windowLaps: FUEL_LAPS_LEFT_WINDOW_LAPS,
      stats: { lastLap: null, avg: null, avgLapTime: null, samples: 0 },
      tracker: createFuelLapTracker(),
      getMarginLaps: () => 0.3,
      getLeaderLapTimeS: () => null,
    },
    order: { positions: null, player: null, startingGrid: null, raceFinish: null },
    gaps: null,
    opponentFlags: null,
    caution: { phase: "none", episode: null, lineup: null },
    session: {
      type: "",
      trackDirection: TrackDirection.Neutral,
      standingStart: false,
      pitActionsAllowed: true,
      damageRepairNeeded: null,
      raceFinished: false,
    },
    state: createInitialState(),
    instance: {
      lastTickInReplay: false,
      lastObservedSessionNum: null,
      firstOnTrackSeeded: false,
      firstOnTrackFired: false,
      freshConnectFireChecked: false,
      freshConnectReplaySkipLogged: false,
      pitSpeedLimitMps: 0,
      pitSpeedLimitKey: "",
    },
    ...overrides,
  };
}

beforeEach(() => {
  initializeEventBus(createMockLogger());
});

afterEach(() => {
  _resetSimEventsIracing();
  _resetEventBus();
  vi.useRealTimers();
});

describe("readSimState — before the translator has anything to say", () => {
  it("answers { initialized: false } and nothing else when the translator was never initialized", () => {
    expect(readSimState()).toStrictEqual({ initialized: false });
  });

  it("answers an initialized, empty state after init and before any tick", () => {
    start(null);

    const state = read();

    expect(state.sessionTick).toBeNull();
    expect(state.inReplay).toBe(false);
    expect(state.fuel.lapsLeft.now).toBeNull();
    expect(state.fuel.history).toEqual([]);
    expect(state.order).toEqual({ positions: null, player: null, startingGrid: null, raceFinish: null });
    expect(state.gaps).toBeNull();
    expect(state.opponentFlags).toBeNull();
    expect(state.caution).toEqual({ phase: "none", episode: null, lineup: null });
    expect(Object.keys(state)).toEqual([
      "initialized",
      "sessionTick",
      "inReplay",
      "fuel",
      "order",
      "gaps",
      "opponentFlags",
      "caution",
      "session",
      "raw",
    ]);
    expect(() => simStateHeadline(state)).not.toThrow();
  });

  it("does not read the margin while there is no estimate to subtract it from", () => {
    // The plugin's margin closure reads the global settings, which may not be
    // loaded yet at an early press — the diff reads it only past its own
    // stats check, and so does the reader.
    const getFuelLapsLeftMarginLaps = vi.fn((): number => {
      throw new Error("settings not loaded");
    });
    const { controller } = start(RACE_SESSION, { getFuelLapsLeftMarginLaps });

    expect(() => readSimState()).not.toThrow();

    controller.__tick(telemetry({ Lap: 1, LapDistPct: 0.3, FuelLevel: 40 }));

    expect(read().fuel.lapsLeft.now).toBeNull();
    expect(getFuelLapsLeftMarginLaps).not.toHaveBeenCalled();
  });

  it("returns to an empty state on a disconnect", () => {
    const { controller } = start();

    driveTwoValidLaps(controller, { SessionTick: 100 });
    expect(read().fuel.history).toHaveLength(2);

    controller.__tick(null, false);

    const state = read();

    expect(state.sessionTick).toBeNull();
    expect(state.fuel.history).toEqual([]);
    expect(state.fuel.lapsLeft.now).toBeNull();
  });
});

describe("readSimState — the laps-of-fuel-left figure", () => {
  it("matches the callout's own count and estimate on the tick the callout fired", () => {
    // A margin that is NOT the default, so a reader that used its own would
    // disagree with the event below.
    const { controller } = start(RACE_SESSION, { getFuelLapsLeftMarginLaps: () => 0.5 });
    const crossed: Array<SimEventOf<"fuel.lapsLeft.crossed">> = [];

    getEventBus().subscribe("fuel.lapsLeft.crossed", (ev) => crossed.push(ev));
    driveTwoValidLaps(controller);
    expect(crossed).toEqual([]);

    // avg 1.95 L over the two laps; 4.2 L at 55 % of the lap:
    // floor(4.2 / 1.95 − 0.5 − 0.45) = floor(1.20) = 1. With the whole lap
    // still to run instead of 45 % of it, the count would be 0.
    controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.45, SessionTime: 200, FuelLevel: 4.3 }));
    controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.55, SessionTime: 210, FuelLevel: 4.2 }));

    expect(crossed).toHaveLength(1);

    const event = crossed[0]!.data;
    const { now, announced } = read().fuel.lapsLeft;

    expect(event.count).toBe(1);
    expect(now).not.toBeNull();
    expect(now!.count).toBe(event.count);
    expect(now!.effective).toBe(event.lapsLeft);
    expect(now!.marginLaps).toBe(0.5);
    expect(now!.rawLapsLeft).toBeCloseTo(4.2 / 1.95, 10);
    expect(now!.lapFractionRemaining).toBeCloseTo(0.45, 10);
    expect(now!.unclampedCount).toBe(1);
    // No limit in this telemetry, so nothing is known to be covered.
    expect(now!.remainingLaps).toBe(Number.POSITIVE_INFINITY);
    expect(now!.covered).toBe(false);
    expect(announced).toEqual({ lastAnnouncedCount: event.count, lastSampledLap: 4, raceCoveredAnnounced: false });
  });

  it("reports the stats, the history and the tracker the estimate was made from", () => {
    const { controller } = start();

    driveTwoValidLaps(controller);

    const { fuel } = read();

    expect(fuel.windowLaps).toBe(FUEL_LAPS_LEFT_WINDOW_LAPS);
    expect(fuel.stats).toEqual(getFuelStats(FUEL_LAPS_LEFT_WINDOW_LAPS));
    expect(fuel.stats.samples).toBe(2);
    expect(fuel.history.map((lap) => lap.lapNumber)).toEqual([2, 3]);
    expect(fuel.tracker).not.toHaveProperty("history");
    expect(fuel.tracker.lapStartLap).toBe(4);
    expect(fuel.tracker.lapStartFuel).toBe(60);
  });

  it("is covered when the lap counter says the tank outlasts the race", () => {
    const { controller } = start();
    const limits = { SessionLapsRemainEx: 3, SessionTimeRemain: IRSDK_UNLIMITED_TIME };

    driveTwoValidLaps(controller, limits);
    controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.55, SessionTime: 210, FuelLevel: 20, ...limits }));

    const { now } = read().fuel.lapsLeft;

    // floor(20 / 1.95 − 0.3 − 0.45) = 9 full laps against 2 still to run.
    expect(now).toMatchObject({
      count: 9,
      lapsNeededAfterCurrent: 2,
      timedLapsAfterCurrent: null,
      remainingLaps: 2,
      covered: true,
    });
  });

  it("takes the timed side from the race leader's pace, as the callout does", () => {
    const { controller } = start();
    // The leader (car 1) laps in 60 s against the player's own 87.5 s average.
    const field: Partial<TelemetryData> = {
      SessionState: SessionState.Racing,
      SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS,
      SessionTimeRemain: 400,
      CarIdxLapCompleted: [3, 5],
      CarIdxLapDistPct: [0.55, 0.55],
      CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack],
      CarIdxLastLapTime: [88, 60],
      CarIdxBestLapTime: [87, 60],
    };

    driveTwoValidLaps(controller, field);
    controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.55, SessionTime: 210, FuelLevel: 20, ...field }));

    const { now } = read().fuel.lapsLeft;

    // ceil((400 + 2 × 60 − 0.45 × 87.5) / 87.5) = 6; the player's own pace
    // in the leader's place would give ceil((400 + 175 − 39.375) / 87.5) = 7.
    expect(now!.timedLapsAfterCurrent).toBe(6);
    expect(now!.remainingLaps).toBe(6);
  });

  it("has no figure without a validated average, or with an unusable fuel level or lap position", () => {
    const { controller } = start();

    controller.__tick(telemetry({ Lap: 1, LapDistPct: 0.3, FuelLevel: 40 }));
    expect(read().fuel.lapsLeft.now).toBeNull();

    driveTwoValidLaps(controller);
    expect(read().fuel.lapsLeft.now).not.toBeNull();

    controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.3, SessionTime: 190, FuelLevel: Number.NaN }));
    expect(read().fuel.lapsLeft.now).toBeNull();

    controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.3, SessionTime: 191, FuelLevel: -1 }));
    expect(read().fuel.lapsLeft.now).toBeNull();

    controller.__tick(telemetry({ Lap: 4, LapDistPct: undefined, SessionTime: 192, FuelLevel: 50 }));
    expect(read().fuel.lapsLeft.now).toBeNull();
  });
});

describe("readSimState — the tick it describes", () => {
  it("reports the SessionTick of the last telemetry handed to the translator", () => {
    const { controller } = start();

    controller.__tick(telemetry({ SessionTick: 4711 }));
    expect(read().sessionTick).toBe(4711);

    controller.__tick(telemetry({ SessionTick: 4712 }));
    expect(read().sessionTick).toBe(4712);

    controller.__tick(telemetry({ SessionTick: undefined }));
    expect(read().sessionTick).toBeNull();
  });

  it("reads the same twice and changes nothing by reading", () => {
    vi.useFakeTimers();

    const { controller, logger } = start();

    driveTwoValidLaps(controller, {
      CarIdxLapCompleted: [3, 5],
      CarIdxLapDistPct: [0.55, 0.55],
      CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack],
    });

    const logged = (): number =>
      [logger.trace, logger.debug, logger.info, logger.warn, logger.error].reduce(
        (sum, method) => sum + vi.mocked(method).mock.calls.length,
        0,
      );
    const loggedBefore = logged();
    const first = read();
    const stateBefore = structuredClone(first.raw.state);
    const historyBefore = structuredClone(first.fuel.history);
    const second = read();

    expect(second).toEqual(first);
    expect(second.raw.state).toEqual(stateBefore);
    expect(second.fuel.history).toEqual(historyBefore);
    expect(logged()).toBe(loggedBefore);
  });
});

describe("readSimState — a caution, from the committed oval capture", () => {
  type OvalTick = {
    t: number;
    SessionFlags: number;
    SessionState: number;
    CarIdxLapCompleted: number[];
    CarIdxTrackSurface: number[];
    CarIdxPaceLine: number[];
    CarIdxPaceRow: number[];
  };
  const oval = JSON.parse(
    readFileSync(new URL("./diff/__fixtures__/caution-restart-20260917.json", import.meta.url), "utf-8"),
  ) as OvalTick[];
  const FIXTURE_PACE_SLOT = 20;
  const FIXTURE_PACE = 64;

  /** A fixture tick as the player (car 0) would see it — the `translator.test.ts` widening. */
  function ovalTick(tick: OvalTick, sessionTick: number): TelemetryData {
    const widen = (values: number[], fill: number): number[] => {
      const out = new Array<number>(72).fill(fill);

      values.forEach((v, i) => (out[i === FIXTURE_PACE_SLOT ? FIXTURE_PACE : i] = v));

      return out;
    };

    return telemetry({
      SessionTick: sessionTick,
      SessionState: tick.SessionState,
      SessionFlags: tick.SessionFlags,
      SessionTime: tick.t,
      LapCompleted: tick.CarIdxLapCompleted[0] ?? -1,
      CarIdxLapCompleted: widen(tick.CarIdxLapCompleted, -1),
      CarIdxTrackSurface: widen(tick.CarIdxTrackSurface, TrkLoc.OnTrack),
      CarIdxPaceLine: widen(tick.CarIdxPaceLine, -1),
      CarIdxPaceRow: widen(tick.CarIdxPaceRow, -1),
    });
  }

  it("reports the caution's phase and episode mid-caution, as data a JSON file can hold", () => {
    vi.useFakeTimers();

    const { controller } = start({
      WeekendInfo: { Category: "Oval", TrackType: "medium oval" },
      DriverInfo: { DriverCarIdx: 0, PaceCarIdx: FIXTURE_PACE, Drivers: [] },
      SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
    });

    // The capture's second caution is out from 542.75 s until its restart at
    // 872.45 s (`translator.test.ts`, "the lap that ends a caution").
    const midCaution = oval.filter((tick) => tick.t <= 700);

    expect(midCaution.length).toBeGreaterThan(0);
    expect(midCaution.length).toBeLessThan(oval.length);

    midCaution.forEach((tick, i) => {
      vi.setSystemTime(1_700_000_000_000 + tick.t * 1000);
      controller.__tick(ovalTick(tick, i));
    });

    const state = read();

    expect(state.sessionTick).toBe(midCaution.length - 1);
    expect(state.caution.phase).not.toBe("none");
    expect(state.caution.phase).toBe(getCautionPhase());
    expect(state.caution.episode).not.toBeNull();
    expect(state.caution.episode).toEqual(getCautionEpisode());
    expect(state.raw.state.cautionPhase).toBe(state.caution.phase);
    expect(state.order.positions).toEqual(getLiveRacePositions());

    // Nothing but data: no closure, logger, bus or controller rides along.
    expect(functionPaths(state)).toEqual([]);

    const json = JSON.stringify(toPlain(state));
    const parsed = JSON.parse(json) as { raw: { state: { cautionPhase: string; positionFrozen: number[] } } };

    expect(parsed.raw.state.cautionPhase).toBe(state.caution.phase);
    expect(Array.isArray(parsed.raw.state.positionFrozen)).toBe(true);
  });
});

describe("readSimState — a replay-wiped translator", () => {
  it("reads as wiped gaps and anchors with the fuel history intact, not as an error", () => {
    const { controller } = start();
    // Three cars on one lap: car 1 leads, the player (car 0) second, car 2 third.
    const field = (playerPct: number): Partial<TelemetryData> => ({
      SessionState: SessionState.Racing,
      CarIdxLapCompleted: [3, 3, 3],
      CarIdxLapDistPct: [playerPct, playerPct + 0.02, playerPct - 0.02],
      CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
      CarIdxClass: [1, 1, 1],
    });

    driveTwoValidLaps(controller);
    controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.3, SessionTime: 190, FuelLevel: 59, ...field(0.3) }));
    controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.31, SessionTime: 191, FuelLevel: 59, ...field(0.31) }));

    const live = read();

    expect(live.inReplay).toBe(false);
    expect(live.gaps).not.toBeNull();
    expect(live.gaps).toEqual(getLiveGaps());
    expect(live.raw.state.gapTraces.length).toBeGreaterThan(0);
    expect(live.order.player?.position).toBe(2);
    expect(live.fuel.history).toHaveLength(2);

    controller.__tick(
      telemetry({
        Lap: 4,
        LapDistPct: 0.32,
        SessionTime: 192,
        FuelLevel: 59,
        IsReplayPlaying: true,
        ...field(0.32),
      }),
    );

    const wiped = read();

    expect(wiped.inReplay).toBe(true);
    expect(wiped.raw.instance.lastTickInReplay).toBe(true);
    expect(wiped.gaps).toBeNull();
    expect(wiped.raw.state.gapTraces).toEqual([]);
    expect(wiped.raw.state.positionFrozen.size).toBe(0);
    expect(wiped.raw.state.positionLastKnownScores).toEqual([]);
    // The order is whatever `getLiveRacePositions()` answers during a replay —
    // the plain lap-progress order of the replay tick, with no frozen anchors.
    expect(wiped.order.positions).toEqual(getLiveRacePositions());
    // The history lives on the instance and survives the wipe; only the open
    // segment is marked for re-anchoring.
    expect(wiped.fuel.history).toHaveLength(2);
    expect(wiped.fuel.stats.samples).toBe(2);
    expect(wiped.fuel.tracker.resumePartial).toBe(true);
    expect(() => JSON.stringify(toPlain(wiped))).not.toThrow();
  });
});

describe("buildSimState", () => {
  it("shapes the parts without calling the leader-lap resolver when the clock is unlimited", () => {
    const getLeaderLapTimeS = vi.fn(() => 60);
    const history = [validLap(1, 2, 90), validLap(2, 2, 90)];
    const state = buildSimState(
      parts({
        telemetry: telemetry({
          SessionTick: 9,
          FuelLevel: 10,
          LapDistPct: 0.5,
          SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS,
          SessionTimeRemain: IRSDK_UNLIMITED_TIME,
        }),
        fuel: {
          windowLaps: FUEL_LAPS_LEFT_WINDOW_LAPS,
          stats: { lastLap: 2, avg: 2, avgLapTime: 90, samples: 2 },
          tracker: { ...createFuelLapTracker(), history },
          getMarginLaps: () => 0.3,
          getLeaderLapTimeS,
        },
      }),
    );

    if (!state.initialized) throw new Error("expected an initialized sim state");

    expect(state.sessionTick).toBe(9);
    expect(state.fuel.history).toBe(history);
    expect(state.fuel.lapsLeft.now).toMatchObject({ rawLapsLeft: 5, count: 4, unclampedCount: 4, covered: false });
    expect(getLeaderLapTimeS).not.toHaveBeenCalled();
  });

  it("reads the announce latches from the translator state", () => {
    const translatorState = createInitialState();

    translatorState.fuelCalloutLastAnnouncedCount = 3;
    translatorState.fuelCalloutLastSampledLap = 12;
    translatorState.fuelCalloutRaceCoveredAnnounced = true;

    const state = buildSimState(parts({ state: translatorState }));

    if (!state.initialized) throw new Error("expected an initialized sim state");

    expect(state.fuel.lapsLeft.announced).toEqual({
      lastAnnouncedCount: 3,
      lastSampledLap: 12,
      raceCoveredAnnounced: true,
    });
    expect(state.raw.state).toBe(translatorState);
  });

  it("reads a white flag off the telemetry it was handed for the coverage", () => {
    const state = buildSimState(
      parts({
        telemetry: telemetry({
          FuelLevel: 10,
          LapDistPct: 0.5,
          SessionFlags: Flags.White,
          SessionLapsRemainEx: 1,
          SessionTimeRemain: IRSDK_UNLIMITED_TIME,
        }),
        fuel: {
          windowLaps: FUEL_LAPS_LEFT_WINDOW_LAPS,
          stats: { lastLap: 2, avg: 2, avgLapTime: null, samples: 2 },
          tracker: createFuelLapTracker(),
          getMarginLaps: () => 0.3,
          getLeaderLapTimeS: () => null,
        },
      }),
    );

    if (!state.initialized) throw new Error("expected an initialized sim state");

    expect(state.fuel.lapsLeft.now).toMatchObject({ lapsNeededAfterCurrent: 1, remainingLaps: 1, covered: true });
  });
});

describe("simStateHeadline", () => {
  it("answers one row for a translator that is not initialized", () => {
    expect(simStateHeadline({ initialized: false })).toEqual([["Sim state", "not initialized"]]);
  });

  it("names every row even when nothing is known yet", () => {
    expect(simStateHeadline(buildSimState(parts()))).toEqual([
      ["Fuel per lap", "no valid laps"],
      ["Laps of fuel left", "no estimate (last announced: none)"],
      ["Live position", "unknown"],
      ["Gap ahead", "none"],
      ["Gap behind", "none"],
      ["Caution phase", "none"],
    ]);
  });

  it("reports fuel per lap with its sample count, laps left with the last announced count, position, gaps and caution phase", () => {
    const translatorState = createInitialState();

    translatorState.fuelCalloutLastAnnouncedCount = 2;

    const state = buildSimState(
      parts({
        telemetry: telemetry({ FuelLevel: 4.9, LapDistPct: 0.55 }),
        fuel: {
          windowLaps: FUEL_LAPS_LEFT_WINDOW_LAPS,
          stats: { lastLap: 2, avg: 1.95, avgLapTime: 87.5, samples: 2 },
          tracker: createFuelLapTracker(),
          getMarginLaps: () => 0.3,
          getLeaderLapTimeS: () => null,
        },
        order: {
          positions: [3, 1, 2],
          player: { position: 3, classPosition: 2, isMultiClass: true },
          startingGrid: null,
          raceFinish: null,
        },
        gaps: {
          ahead: { carIdx: 7, gapSeconds: 1.234, lapDelta: 0, trend: "closing" },
          behind: { carIdx: 9, gapSeconds: null, lapDelta: 1, trend: null },
        },
        caution: { phase: "caught", episode: { id: 4, firstFollowCarIdx: 7 }, lineup: null },
        state: translatorState,
      }),
    );

    expect(simStateHeadline(state)).toEqual([
      ["Fuel per lap", "1.95 L (2 valid laps)"],
      ["Laps of fuel left", "1 (last announced: 2)"],
      ["Live position", "P3 (P2 in class)"],
      ["Gap ahead", "1.2 s (car 7)"],
      ["Gap behind", "1 lap apart (car 9)"],
      ["Caution phase", "caught"],
    ]);
  });

  it("reports a single-class position alone, a one-lap sample in the singular and a gap with no reading", () => {
    const state = buildSimState(
      parts({
        fuel: {
          windowLaps: FUEL_LAPS_LEFT_WINDOW_LAPS,
          stats: { lastLap: 2, avg: 2, avgLapTime: 90, samples: 1 },
          tracker: createFuelLapTracker(),
          getMarginLaps: () => 0.3,
          getLeaderLapTimeS: () => null,
        },
        order: {
          positions: [1],
          player: { position: 1, classPosition: 1, isMultiClass: false },
          startingGrid: null,
          raceFinish: null,
        },
        gaps: { ahead: null, behind: { carIdx: 4, gapSeconds: null, lapDelta: 0, trend: null } },
      }),
    );
    const rows = new Map(simStateHeadline(state));

    expect(rows.get("Fuel per lap")).toBe("2.00 L (1 valid lap)");
    expect(rows.get("Live position")).toBe("P1");
    expect(rows.get("Gap ahead")).toBe("none");
    expect(rows.get("Gap behind")).toBe("no reading (car 4)");
  });
});
