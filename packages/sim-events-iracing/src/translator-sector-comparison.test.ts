/**
 * The sector timer's readers through the real tick (issue #1572):
 * `getSectorComparison()` — the targets `diffGaps` resolved from the canonical
 * order, each car's number, live gap and recorded laps — and
 * `getCarSectorTimes()`, with the lifecycles of the laps behind them.
 */
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  Flags,
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

import {
  _resetSimEventsIracing,
  getCarSectorTimes,
  getLiveRacePositions,
  getSectorComparison,
  initializeSimEventsIracing,
  readSimState,
  type SectorComparisonSnapshot,
} from "./translator.js";

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
  __setSessionInfo: (info: Record<string, unknown> | null) => void;
};

function createMockController(): MockController {
  // Several subscribers, notified in subscription order as `SDKController`
  // does: the translator, then the replay recorder it starts (#1468).
  const subscribers = new Map<string, TelemetryCallback>();
  let sessionInfo: Record<string, unknown> | null = null;
  const replayState = new ReplayStateTracker();

  const controller = {
    subscribe: (id: string, cb: TelemetryCallback) => {
      subscribers.set(id, cb);
      cb(null, false);
    },
    unsubscribe: (id: string) => {
      subscribers.delete(id);
    },
    getSessionInfo: () => sessionInfo,
    getReplayState: (nowMs: number = Date.now()) => replayState.read(nowMs),
    noteReplayLeftForLive: (nowMs: number = Date.now()) => replayState.noteLeftForLive(nowMs),
  } as unknown as MockController;

  controller.__tick = (telemetry) => {
    replayState.step(telemetry, sessionInfo, Date.now());

    for (const cb of [...subscribers.values()]) cb(telemetry, true);
  };
  controller.__setSessionInfo = (info) => {
    sessionInfo = info;
  };

  return controller;
}

const THREE_SECTORS = [
  { SectorNum: 0, SectorStartPct: 0 },
  { SectorNum: 1, SectorStartPct: 0.25 },
  { SectorNum: 2, SectorStartPct: 0.6 },
];

/** The player's car index. */
const PLAYER = 0;
/** The player's class, and the other one on track. */
const GT3 = 10;
const LMP = 20;
/** Each car's class, by carIdx: car 1 is the only one of another class. */
const CLASSES = [GT3, LMP, GT3, GT3, GT3];
/** Each car's number as the session spells it, by carIdx. */
const NUMBERS = ["007", "1", "23", "04", "4"];

type SessionInfoOptions = {
  sessionType?: string;
  /** Default three sectors; an explicit `undefined` leaves `SplitTimeInfo` out of the session info. */
  sectors?: unknown;
  subSessionId?: number;
};

function sessionInfo(options: SessionInfoOptions = {}): Record<string, unknown> {
  const { sessionType = "Race", subSessionId = 1 } = options;
  const sectors = Object.hasOwn(options, "sectors") ? options.sectors : THREE_SECTORS;

  return {
    WeekendInfo: {
      TrackID: 42,
      TrackLength: "4.00 km",
      TrackPitSpeedLimit: "80.00 kph",
      SimMode: "full",
      SubSessionID: subSessionId,
    },
    SessionInfo: { Sessions: [0, 1, 2].map((n) => ({ SessionNum: n, SessionType: sessionType })) },
    DriverInfo: {
      DriverCarIdx: PLAYER,
      Drivers: NUMBERS.map((CarNumber, CarIdx) => ({
        CarIdx,
        CarNumber,
        CarClassID: CLASSES[CarIdx],
        UserName: `Driver ${CarIdx}`,
      })),
    },
    ...(sectors === undefined ? {} : { SplitTimeInfo: { Sectors: sectors } }),
  };
}

/** A live race tick with every car at `progress` (laps), by carIdx. */
function tick(sessionTime: number, progress: number[], overrides: Partial<TelemetryData> = {}): TelemetryData {
  const lapCompleted = progress.map((p) => Math.floor(p));
  const lapDistPct = progress.map((p) => p - Math.floor(p));

  return {
    SessionTime: sessionTime,
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: true,
    IsReplayPlaying: false,
    PlayerTrackSurface: TrkLoc.OnTrack,
    PlayerTrackSurfaceMaterial: 0,
    PlayerCarMyIncidentCount: 0,
    PlayerIncidents: 0,
    PlayerCarIdx: PLAYER,
    SessionFlags: 0,
    SessionNum: 0,
    SessionState: SessionState.Racing,
    SessionLapsRemainEx: 20,
    SessionTimeRemain: 1800,
    PitSvFlags: 0,
    PitSvTireCompound: 0,
    PlayerTireCompound: 0,
    EngineWarnings: 0,
    Speed: 44,
    CarLeftRight: CarLeftRight.Off,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: lapCompleted[PLAYER]! + 1,
    LapCompleted: lapCompleted[PLAYER]!,
    LapDistPct: lapDistPct[PLAYER]!,
    FuelLevel: 10,
    CarIdxLapCompleted: lapCompleted,
    CarIdxLapDistPct: lapDistPct,
    CarIdxLap: lapCompleted.map((laps) => laps + 1),
    CarIdxTrackSurface: progress.map(() => TrkLoc.OnTrack),
    CarIdxOnPitRoad: progress.map(() => false),
    CarIdxClass: CLASSES.slice(0, progress.length),
    CarIdxLastLapTime: progress.map(() => 90),
    ...overrides,
  } as TelemetryData;
}

let controller: MockController;

function start(info: Record<string, unknown>): void {
  controller = createMockController();
  controller.__setSessionInfo(info);
  initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });
}

/** The tick interval of the drives (s), and each car's step per tick (laps): a 5 s lap, inside the trace's step bound. */
const DT = 0.2;
const STEP = 0.04;

/**
 * Drive every car forward together for `ticks` ticks from `from` (progress by
 * carIdx) at `sessionTime`. Returns the next tick's time and progress.
 */
function drive(
  from: number[],
  sessionTime: number,
  ticks: number,
  overrides: Partial<TelemetryData> = {},
): { sessionTime: number; progress: number[] } {
  for (let n = 0; n < ticks; n++) {
    controller.__tick(
      tick(
        sessionTime + n * DT,
        from.map((p) => p + n * STEP),
        overrides,
      ),
    );
  }

  return { sessionTime: sessionTime + ticks * DT, progress: from.map((p) => p + ticks * STEP) };
}

/** The targets as the sector timer recorded them, unfiltered. */
function recordedTargets(): unknown {
  const state = readSimState();

  return state.initialized ? state.raw.state.sectorTimes.targets : null;
}

/** The snapshot, asserted present. */
function comparison(): SectorComparisonSnapshot {
  const snapshot = getSectorComparison();

  if (snapshot === null) throw new Error("no sector comparison");

  return snapshot;
}

/**
 * The overall order and the class order differ: car 1 (the other class)
 * leads overall, car 2 leads the player's class, car 3 is directly ahead of
 * the player and car 4 directly behind.
 */
const MID_FIELD = [5.4, 5.9, 5.8, 5.5, 5.3];

beforeEach(() => {
  _resetEventBus();
  initializeEventBus();
});

afterEach(() => {
  _resetSimEventsIracing();
  vi.useRealTimers();
});

describe("getSectorComparison (#1572)", () => {
  it("is null before the translator is initialised and before its first tick", () => {
    expect(getSectorComparison()).toBeNull();

    start(sessionInfo());

    expect(getSectorComparison()).toBeNull();
  });

  it("names the class leader and the class neighbours from the canonical order, not the overall one", () => {
    start(sessionInfo());
    drive(MID_FIELD, 100, 3);

    // The fixture's premise: the overall leader is a car of another class.
    expect(getLiveRacePositions()?.[1]).toBe(1);

    const snapshot = comparison();

    expect(snapshot.sectorCount).toBe(3);
    expect(snapshot.player.carIdx).toBe(PLAYER);
    expect(snapshot.leader?.carIdx).toBe(2);
    expect(snapshot.ahead?.carIdx).toBe(3);
    expect(snapshot.behind?.carIdx).toBe(4);
  });

  it("spells each car's number as the session does", () => {
    start(sessionInfo());
    drive(MID_FIELD, 100, 3);

    const snapshot = comparison();

    expect(snapshot.player.carNumber).toBe("007");
    expect(snapshot.leader?.carNumber).toBe("23");
    // "04" and "4" are two cars.
    expect(snapshot.ahead?.carNumber).toBe("04");
    expect(snapshot.behind?.carNumber).toBe("4");
  });

  it("answers a null number for a car the session info does not name", () => {
    const info = sessionInfo();

    (info.DriverInfo as { Drivers: unknown[] }).Drivers.splice(3, 1);
    start(info);
    drive(MID_FIELD, 100, 3);

    expect(comparison().ahead).toMatchObject({ carIdx: 3, carNumber: null });
  });

  it("reads each target's live gap to the player, and none for the player", () => {
    start(sessionInfo());
    // Long enough for every trace to cover the car behind it: the leader is 0.4 lap up the road.
    drive(MID_FIELD, 100, 20);

    const snapshot = comparison();

    // 0.04 lap per 0.2 s: a tenth of a lap is half a second.
    expect(snapshot.player.gapSeconds).toBeNull();
    expect(snapshot.ahead?.gapSeconds).toBeCloseTo(0.5, 6);
    expect(snapshot.behind?.gapSeconds).toBeCloseTo(0.5, 6);
    expect(snapshot.leader?.gapSeconds).toBeCloseTo(2, 6);
  });

  it("has no leader when the player leads the class, and no car ahead", () => {
    start(sessionInfo());
    // The player ahead of every car of its class; car 1 still leads overall.
    drive([5.85, 5.9, 5.8, 5.5, 5.3], 100, 3);

    const snapshot = comparison();

    expect(recordedTargets()).toEqual({
      leaderIdx: PLAYER,
      aheadIdx: -1,
      behindIdx: 2,
    });
    expect(snapshot.leader).toBeNull();
    expect(snapshot.ahead).toBeNull();
    expect(snapshot.behind?.carIdx).toBe(2);
  });

  it("names the class leader even when it is the car directly ahead: who a call names is the catalog's", () => {
    start(sessionInfo());
    // Car 3 drops behind the player: car 2 is both the class leader and the car ahead.
    drive([5.4, 5.9, 5.8, 5.2, 5.3], 100, 3);

    const snapshot = comparison();

    expect(recordedTargets()).toEqual({
      leaderIdx: 2,
      aheadIdx: 2,
      behindIdx: 4,
    });
    expect(snapshot.leader?.carIdx).toBe(2);
    expect(snapshot.leader).toEqual(snapshot.ahead);
    expect(snapshot.ahead?.carIdx).toBe(2);
    expect(snapshot.behind?.carIdx).toBe(4);
  });

  it("has no car behind for the last car of the class", () => {
    start(sessionInfo());
    drive([5.1, 5.9, 5.8, 5.5, 5.3], 100, 3);

    const snapshot = comparison();

    expect(snapshot.behind).toBeNull();
    expect(snapshot.ahead?.carIdx).toBe(4);
    expect(snapshot.leader?.carIdx).toBe(2);
  });

  it.each(["Practice", "Open Qualify", "Lone Qualify", "Warmup", "Offline Testing"])(
    "is null in a %s session",
    (sessionType) => {
      start(sessionInfo({ sessionType }));
      drive(MID_FIELD, 100, 3);

      expect(getSectorComparison()).toBeNull();
    },
  );

  it("reports each car's completed laps as the sim counts them, and none for a car out of the world", () => {
    start(sessionInfo());
    drive(MID_FIELD, 100, 3);

    const snapshot = comparison();

    expect(snapshot.player.lapsCompleted).toBe(5);
    expect(snapshot.leader?.lapsCompleted).toBe(5);

    // Car 2 (the class leader) retires to the garage: iRacing reads -1 for it.
    const next = drive(MID_FIELD, 100.6, 1);

    controller.__tick(
      tick(next.sessionTime, next.progress, {
        CarIdxLapCompleted: next.progress.map((p, i) => (i === 2 ? -1 : Math.floor(p))),
      }),
    );

    // It is still the class leader the order names; whether to compare with it is the catalog's call.
    expect(getSectorComparison()?.leader).toMatchObject({ carIdx: 2, lapsCompleted: null });
    expect(getSectorComparison()?.ahead?.lapsCompleted).toBe(5);
  });

  it("reads the sector count the timer measured with, and is null on a tick the timer recorded nothing", () => {
    start(sessionInfo());

    const next = drive(MID_FIELD, 100, 3);
    const state = () => {
      const s = readSimState();

      if (!s.initialized) throw new Error("not initialised");

      return s.raw.state;
    };

    expect(state().sectorTimes.sectorCount).toBe(3);
    expect(comparison().sectorCount).toBe(3);

    // The player not racing: the progress step refuses the tick, so the timer
    // records nothing, though the track's sectors are still resolved.
    controller.__tick(tick(next.sessionTime, next.progress, { LapCompleted: -1 }));

    expect(state().trackSectors.starts).not.toBeNull();
    expect(state().sectorTimes.sectorCount).toBeNull();
    expect(getSectorComparison()).toBeNull();
  });

  it("is null at a track with no sectors, and with sectors that cannot be counted from the line", () => {
    start(sessionInfo({ sectors: undefined }));
    drive(MID_FIELD, 100, 3);

    expect(getSectorComparison()).toBeNull();

    _resetSimEventsIracing();
    start(
      sessionInfo({
        sectors: [
          { SectorNum: 0, SectorStartPct: 0.1 },
          { SectorNum: 1, SectorStartPct: 0.5 },
        ],
      }),
    );
    drive(MID_FIELD, 100, 3);

    expect(getSectorComparison()).toBeNull();
  });
});

describe("the recorded laps through the tick (#1572)", () => {
  it("records every car's laps, read by getCarSectorTimes and carried by the comparison", () => {
    start(sessionInfo());
    // 2.6 laps: every car crosses the line at least twice.
    drive(MID_FIELD, 100, 65);

    // A lap is 25 ticks of 0.2 s: sectors of 25 %, 35 % and 40 % of 5 s.
    const playerLaps = getCarSectorTimes(PLAYER)?.recentLaps ?? [];

    expect(playerLaps.map((lap) => lap.lap)).toEqual([7]);
    expect(playerLaps[0]?.clean).toBe(true);
    expect(playerLaps[0]?.sectorTimes[0]).toBeCloseTo(1.25, 6);
    expect(playerLaps[0]?.sectorTimes[1]).toBeCloseTo(1.75, 6);
    expect(playerLaps[0]?.sectorTimes[2]).toBeCloseTo(2, 6);

    const snapshot = comparison();

    expect(snapshot.player.recentLaps).toEqual(playerLaps);
    expect(snapshot.leader?.recentLaps).toEqual(getCarSectorTimes(2)?.recentLaps);
    expect(snapshot.leader?.recentLaps.map((lap) => lap.lap)).toEqual([7, 8]);
    expect(snapshot.ahead?.recentLaps.map((lap) => lap.lap)).toEqual([7, 8]);
    expect(snapshot.behind?.recentLaps.map((lap) => lap.lap)).toEqual([7]);
  });

  it("answers null for no car index and an empty list for a car with no lap yet", () => {
    expect(getCarSectorTimes(0)).toBeNull();

    start(sessionInfo());
    drive(MID_FIELD, 100, 3);

    expect(getCarSectorTimes(-1)).toBeNull();
    expect(getCarSectorTimes(1.5)).toBeNull();
    expect(getCarSectorTimes(0)).toEqual({ recentLaps: [] });
    expect(getCarSectorTimes(63)).toEqual({ recentLaps: [] });
  });

  it("hands out a copy, so a caller never holds the list the timer appends to", () => {
    start(sessionInfo());

    const next = drive(MID_FIELD, 100, 65);
    const before = getCarSectorTimes(2)?.recentLaps ?? [];

    expect(before).toHaveLength(2);

    drive(next.progress, next.sessionTime, 25);

    expect(before).toHaveLength(2);
    expect(getCarSectorTimes(2)?.recentLaps).toHaveLength(3);
  });

  it("records a lap driven under a full-course caution as unclean", () => {
    start(sessionInfo());

    const next = drive(MID_FIELD, 100, 40);

    // The player's lap 7 is under way; a caution is thrown for one tick of it.
    drive(next.progress, next.sessionTime, 1, { SessionFlags: Flags.Caution });

    const state = readSimState();

    expect(state.initialized && state.raw.state.cautionPhase).not.toBe("none");

    drive(
      next.progress.map((p) => p + STEP),
      next.sessionTime + DT,
      24,
    );

    expect(getCarSectorTimes(PLAYER)?.recentLaps).toEqual([expect.objectContaining({ lap: 7, clean: false })]);
  });

  it("keeps the completed laps through a replay glance and drops the lap in progress", () => {
    vi.useFakeTimers();
    start(sessionInfo());

    const next = drive(MID_FIELD, 100, 65);

    expect(getCarSectorTimes(2)?.recentLaps.map((lap) => lap.lap)).toEqual([7, 8]);

    // A glance at the replay: the wipe keeps the laps, and nothing else of the timer.
    controller.__tick(tick(next.sessionTime, next.progress, { IsReplayPlaying: true, IsOnTrack: false }));

    const state = readSimState();

    expect(state.initialized && state.raw.state.sectorTimes).toMatchObject({
      lastProgress: [],
      lapInProgress: [],
      lastSessionTime: null,
      sectorCount: null,
      targets: { leaderIdx: -1, aheadIdx: -1, behindIdx: -1 },
    });
    expect(getCarSectorTimes(2)?.recentLaps.map((lap) => lap.lap)).toEqual([7, 8]);

    // Back live past the exit grace: car 2 is mid-lap 9, which is not
    // recorded; lap 10 is, behind the two kept.
    vi.advanceTimersByTime(REPLAY_EXIT_GRACE_MS + 1);
    drive(next.progress, next.sessionTime + 10, 50);

    expect(getCarSectorTimes(2)?.recentLaps.map((lap) => lap.lap)).toEqual([7, 8, 10]);
  });

  it("clears every lap at a session change", () => {
    start(sessionInfo());

    const next = drive(MID_FIELD, 100, 65);

    expect(getCarSectorTimes(2)?.recentLaps).toHaveLength(2);

    controller.__tick(tick(next.sessionTime, next.progress, { SessionNum: 1 }));

    expect(getCarSectorTimes(2)).toEqual({ recentLaps: [] });
  });
});
