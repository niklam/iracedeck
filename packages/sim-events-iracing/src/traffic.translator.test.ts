/**
 * The approaching-traffic detectors through the real tick (issue #1113): a
 * stopped player hears `traffic.rejoin` from the curves the same ticks learn,
 * a player driving out of the stall hears `traffic.pitExit` against the
 * landmarks #1112's learner loaded, once past the end of pit road, the pit-exit window comes from the
 * options, and a replay glance wipes an episode, which the first ticks back
 * start afresh.
 */
import { _resetEventBus, getEventBus, initializeEventBus, type SimEventMap } from "@iracedeck/event-bus";
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
import {
  foldSample,
  PIT_LANE_SECTION_VERSION,
  type PitLaneLandmarkRecord,
  type PitLaneSection,
} from "@iracedeck/track-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS } from "./diff/traffic-pit-exit.js";
import { TRAFFIC_REJOIN_ENTRY_DWELL_MS, TRAFFIC_REJOIN_EVAL_INTERVAL_MS } from "./diff/traffic-rejoin.js";
import {
  _resetSimEventsIracing,
  initializeSimEventsIracing,
  readSimState,
  type SimEventsIracingOptions,
} from "./translator.js";

const CLS = 20;
/** The class's reference lap: 90 s, so a car's estTime is its lap position × 90. */
const LAP_S = 90;

function createMockLogger(): ILogger {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: vi.fn(),
    createScope: vi.fn(),
  } as unknown as ILogger;

  vi.mocked(logger.createScope).mockReturnValue(logger);

  return logger;
}

type MockController = SDKController & { __tick: (telemetry: TelemetryData) => void };

function createMockController(): MockController {
  const subscribers = new Map<string, TelemetryCallback>();
  const replayState = new ReplayStateTracker();
  const sessionInfo = {
    SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
    WeekendInfo: {
      TrackID: 7,
      TrackName: "testtrack",
      TrackConfigName: "Grand Prix",
      TrackLength: "4.00 km",
      TrackVersion: "2026.11.01.01",
      TrackPitSpeedLimit: "72.00 kph",
      SubSessionID: 555,
      SimMode: "full",
    },
    DriverInfo: {
      DriverCarIdx: 0,
      Drivers: [
        { CarIdx: 0, CarClassID: CLS, CarClassEstLapTime: LAP_S },
        { CarIdx: 1, CarClassID: CLS, CarClassEstLapTime: LAP_S },
      ],
    },
  };
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

  return controller;
}

type Player = {
  pct: number;
  speed?: number;
  surface?: number;
  onPitRoad?: boolean;
  inStall?: boolean;
  replay?: boolean;
};

/**
 * One tick: the player (car 0) as given, car 1 on track at `other` (`null`: not
 * in world), and with `more` car 2 on track at `more.car2`. All class
 * {@link CLS}. `SessionTime` stands at 100 unless `more` moves it.
 */
function tick(player: Player, other: number | null, more?: { car2: number; sessionTime: number }): TelemetryData {
  const surface = player.surface ?? TrkLoc.OnTrack;
  const pcts = more === undefined ? [player.pct, other ?? -1] : [player.pct, other ?? -1, more.car2];
  const replay = player.replay ?? false;

  return {
    SessionTime: more?.sessionTime ?? 100,
    OnPitRoad: player.onPitRoad ?? false,
    PlayerCarInPitStall: player.inStall ?? false,
    IsOnTrack: !replay,
    IsReplayPlaying: replay,
    IsInGarage: false,
    PlayerTrackSurface: surface,
    PlayerTrackSurfaceMaterial: 0,
    PlayerCarMyIncidentCount: 0,
    PlayerIncidents: 0,
    SessionFlags: 0,
    SessionNum: 0,
    SessionState: SessionState.Racing,
    SessionLapsRemainEx: 20,
    SessionTimeRemain: 1800,
    PitSvFlags: 0,
    PitSvTireCompound: 0,
    PlayerTireCompound: 0,
    EngineWarnings: 0,
    Speed: player.speed ?? 0,
    CarLeftRight: CarLeftRight.Off,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: 4,
    LapCompleted: 3,
    LapDistPct: player.pct,
    FuelLevel: 10,
    CarIdxLapCompleted: pcts.map((p) => (p < 0 ? -1 : 3)),
    CarIdxLap: pcts.map((p) => (p < 0 ? -1 : 4)),
    CarIdxLapDistPct: pcts,
    CarIdxTrackSurface: [surface, other === null ? TrkLoc.NotInWorld : TrkLoc.OnTrack, TrkLoc.OnTrack].slice(
      0,
      pcts.length,
    ),
    CarIdxOnPitRoad: [player.onPitRoad ?? false, false, false].slice(0, pcts.length),
    CarIdxEstTime: pcts.map((p) => (p < 0 ? -1 : p * LAP_S)),
    CarIdxClass: pcts.map(() => CLS),
    CarIdxLastLapTime: pcts.map(() => LAP_S),
  } as TelemetryData;
}

/** A published landmark at `pct` for {@link CLS}: two agreeing samples. */
function landmark(pct: number): PitLaneLandmarkRecord {
  const now = Date.now();
  const sample = { pct, estTime: pct * LAP_S, carClassId: CLS, at: now - 1000 };
  const a = foldSample(undefined, { ...sample, key: "a" }, "", 4000);

  return foldSample(a.record, { ...sample, key: "b", at: now }, "", 4000).record!;
}

describe("the approaching-traffic detectors through handleTick (issue #1113)", () => {
  let controller: MockController;
  let rejoin: SimEventMap["traffic.rejoin"]["data"][];
  let pitExit: SimEventMap["traffic.pitExit"]["data"][];
  let order: string[];

  function init(options: SimEventsIracingOptions = {}): void {
    controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow", ...options });
    getEventBus().subscribe("traffic.rejoin", (ev) => {
      rejoin.push(ev.data);
      order.push(ev.event);
    });
    getEventBus().subscribe("traffic.pitExit", (ev) => {
      pitExit.push(ev.data);
      order.push(ev.event);
    });
    getEventBus().subscribe("pitStall.departed", (ev) => {
      order.push(ev.event);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    initializeEventBus(createMockLogger());
    rejoin = [];
    pitExit = [];
    order = [];
  });

  afterEach(() => {
    _resetSimEventsIracing();
    _resetEventBus();
    vi.useRealTimers();
  });

  describe("traffic.rejoin", () => {
    it("says a car the curve times 4.5 s away is near, and clear once it is by", () => {
      init();

      // The player's own sample at 0.5 is the class curve there (45 s); car 1
      // at 0.45 reads 40.5 s, 4.5 s away.
      controller.__tick(tick({ pct: 0.5 }, 0.45));
      vi.advanceTimersByTime(TRAFFIC_REJOIN_ENTRY_DWELL_MS);
      controller.__tick(tick({ pct: 0.5 }, 0.45));

      expect(rejoin).toEqual([{ verdict: "near", seconds: 4, first: true }]);

      vi.advanceTimersByTime(TRAFFIC_REJOIN_EVAL_INTERVAL_MS);
      controller.__tick(tick({ pct: 0.5 }, 0.52));

      expect(rejoin).toEqual([{ verdict: "near", seconds: 4, first: true }, { verdict: "clear" }]);
    });

    it("leaves out a car standing still right behind, so the car really coming gets its call (the multi-car incident)", () => {
      init();

      // A tick every 125 ms on a SessionTime that runs with the clock. Car 2
      // stopped 5 m behind the player on the 4 km track (0.11 s away at
      // reference pace); car 1 coming at reference pace, 5.75 s away when the
      // stop is recognised at t = 1.5.
      const stoppedBehind = 0.5 - 5 / 4000;

      for (let t = 0; t <= TRAFFIC_REJOIN_ENTRY_DWELL_MS / 1000; t += 0.125) {
        if (t > 0) vi.advanceTimersByTime(125);

        controller.__tick(tick({ pct: 0.5 }, (45 - (7.25 - t)) / LAP_S, { car2: stoppedBehind, sessionTime: 100 + t }));
      }

      expect(rejoin).toEqual([{ verdict: "near", seconds: 5, first: true }]);
    });

    it("says nothing for a car driving past at speed", () => {
      init();

      for (let i = 0; i < 40; i++) {
        controller.__tick(tick({ pct: 0.5, speed: 50 }, 0.45));
        vi.advanceTimersByTime(100);
      }

      expect(rejoin).toEqual([]);
    });

    it("loses its episode to a replay glance, and the first stopped ticks back start a fresh one", () => {
      init();

      controller.__tick(tick({ pct: 0.5 }, 0.2));
      vi.advanceTimersByTime(TRAFFIC_REJOIN_ENTRY_DWELL_MS);
      controller.__tick(tick({ pct: 0.5 }, 0.2));
      expect(rejoin).toEqual([{ verdict: "clear" }]);

      // Car 1 at 0.2 reads 18 s: 27 s away, clear.
      controller.__tick(tick({ pct: 0.5, replay: true }, 0.2));

      // Back to live, past the replay state's exit grace (#1324).
      vi.advanceTimersByTime(REPLAY_EXIT_GRACE_MS + 1);
      controller.__tick(tick({ pct: 0.5 }, 0.2));

      const back = readSimState();

      if (!back.initialized) throw new Error("translator not initialised");

      expect(back.raw.state.trafficRejoin.active).toBe(false);

      vi.advanceTimersByTime(TRAFFIC_REJOIN_ENTRY_DWELL_MS);
      controller.__tick(tick({ pct: 0.5 }, 0.2));

      expect(rejoin).toEqual([{ verdict: "clear" }, { verdict: "clear" }]);
    });
  });

  describe("traffic.pitExit", () => {
    const section = (): PitLaneSection => ({
      version: PIT_LANE_SECTION_VERSION,
      trackLength: "4.00 km",
      landmarks: { pitRoadEnd: landmark(0.1), blendEnd: landmark(0.12) },
    });
    const inStall: Player = { pct: 0.08, surface: TrkLoc.InPitStall, onPitRoad: true, inStall: true };
    const leaving: Player = { pct: 0.0805, surface: TrkLoc.AproachingPits, onPitRoad: true };
    const onPitRoad: Player = { pct: 0.09, surface: TrkLoc.AproachingPits, onPitRoad: true };
    const blendLane: Player = { pct: 0.11, surface: TrkLoc.AproachingPits, onPitRoad: false };

    /**
     * Out of the stall, down pit road and over its end into the blend lane, an
     * evaluation apart. Leaving: 78 m to pit road's end at 20 m/s (3.9 s) plus
     * 10.8 − 9 = 5.7 s, car 1 at 0.05 reaching the blend at 10.8 − 4.5 = 6.3 s,
     * 0.6 s after the player. In the blend lane at 0.11: 10.8 − 9.9 = 0.9 s,
     * car 1 at 0.10 at 1.8 s, 0.9 s after.
     */
    function driveOut(): void {
      controller.__tick(tick(inStall, 0.05));
      controller.__tick(tick(leaving, 0.05));
      vi.advanceTimersByTime(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS);
      controller.__tick(tick(onPitRoad, 0.07));
      expect(pitExit).toEqual([]);
      vi.advanceTimersByTime(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS);
      controller.__tick(tick(blendLane, 0.1));
    }

    it("calls traffic for a car reaching the blend just after the player, at the end of pit road", () => {
      init({ loadPitLaneLandmarks: section });

      driveOut();

      expect(pitExit).toEqual([{ verdict: "traffic", seconds: 0.9 }]);
      expect(order).toEqual(["pitStall.departed", "traffic.pitExit"]);
    });

    it("calls clear for a car well behind, with the window from the options", () => {
      init({ loadPitLaneLandmarks: section, getTrafficPitExitAfterSeconds: () => 0.5 });

      driveOut();

      expect(pitExit).toEqual([{ verdict: "clear", seconds: 0.9 }]);
    });

    it("says nothing on leaving the stall: the verdict waits for the end of pit road", () => {
      init({ loadPitLaneLandmarks: section });

      controller.__tick(tick(inStall, 0.05));
      controller.__tick(tick(leaving, 0.05));

      expect(order).toEqual(["pitStall.departed"]);
    });

    it("stays silent on a track whose landmarks are not learned", () => {
      init({ loadPitLaneLandmarks: () => null });

      driveOut();

      expect(order).toEqual(["pitStall.departed"]);
    });
  });
});
