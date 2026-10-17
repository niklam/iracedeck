/**
 * Translator integration tests.
 *
 * Drives the translator with canned `TelemetryData` snapshots via a fake
 * `sdkController`. Asserts the emitted event stream for each transition.
 *
 * Per-diff-module unit tests (pure functions) live next to their modules.
 */
import {
  _resetEventBus,
  getEventBus,
  initializeEventBus,
  OpponentPenaltyFlag,
  type SimEventOf,
  type TireWearReport,
  TrackWetness,
} from "@iracedeck/event-bus";
import {
  CarLeftRight,
  EngineWarnings,
  Flags,
  IncidentFlags,
  IRSDK_UNLIMITED_LAPS,
  IRSDK_UNLIMITED_TIME,
  PaceMode,
  PitSvFlags,
  REPLAY_EXIT_GRACE_MS,
  ReplayStateTracker,
  type SDKController,
  SessionState,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CATCH_UP_DWELL_MS,
  CATCH_UP_PIT_EXIT_GRACE_MS,
  CATCH_UP_REMINDER_MS,
  CATCH_UP_SETTLE_MS,
} from "./diff/caution.js";
import { DAMAGE_DEBOUNCE_MS } from "./diff/damage.js";
import { YELLOW_CLEARED_HOLD_MS } from "./diff/flags.js";
import { INCIDENT_BURST_QUIET_MS } from "./diff/incidents.js";
import type { TranslatorState } from "./state.js";
import {
  _resetSimEventsIracing,
  getCautionEpisode,
  getCautionGap,
  getCautionPhase,
  getDriverSetupName,
  getFuelStats,
  getLastStopTireTemps,
  getLatestTelemetry,
  getLiveCarPosition,
  getLiveOpponentFlags,
  getLivePosition,
  getLiveRacePositions,
  getPaceLineup,
  getQualifyingInvalidationSnapshot,
  getRaceFinishResult,
  getRaceStartConditions,
  getRollingStartFormation,
  getSessionStartConditions,
  getStartingGridPosition,
  initializeSimEventsIracing,
  isDamageRepairNeeded,
  isRaceFinished,
  isRollingStartFormation,
  isSimEventsIracingInitialized,
  isUnderFullCourseCaution,
  readSimState,
  resolveGapLapsRemaining,
  resolveLeaderLapTimeS,
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
  __tick: (telemetry: TelemetryData | null, isConnected?: boolean) => void;
  __setSessionInfo: (info: Record<string, unknown> | null) => void;
};

function createMockController(): MockController {
  let callback: TelemetryCallback | null = null;
  let sessionInfo: Record<string, unknown> | null = null;
  // The debounced replay state the translator reads (#1324), the SDK's own
  // tracker stepped from the mocked telemetry and session info on every tick
  // (the mock's poll), as `SDKController` steps it on every poll — so a tick
  // that leaves a replay stays "in a replay" for `REPLAY_EXIT_GRACE_MS`, as in
  // the sim, and a test that expects live behaviour after a replay lets the
  // grace run out first (`elapseReplayGrace`) rather than relying on a mock
  // that forgets it.
  const replayState = new ReplayStateTracker();

  const controller = {
    // Matches the real `SDKController.subscribe` contract: after storing the
    // callback, invoke it once with the current telemetry / connection state
    // so subscribers see the "nothing happening yet" tick the translator
    // actually gets at plugin startup. The real controller starts offline
    // with no telemetry, so the mock defaults to `(null, false)`.
    subscribe: (_id: string, cb: TelemetryCallback) => {
      callback = cb;
      cb(null, false);
    },
    unsubscribe: (_id: string) => {
      callback = null;
    },
    getSessionInfo: () => sessionInfo,
    getReplayState: (nowMs: number = Date.now()) => replayState.read(nowMs),
    noteReplayLeftForLive: (nowMs: number = Date.now()) => replayState.noteLeftForLive(nowMs),
  } as unknown as MockController;

  controller.__tick = (telemetry, isConnected = true) => {
    // Stepped before the callback, as the real controller does, and reset on
    // a disconnect tick, as the real controller resets it when the connection drops.
    if (telemetry) {
      replayState.step(telemetry, sessionInfo, Date.now());
    } else {
      replayState.reset();
    }

    callback?.(telemetry, isConnected);
  };
  controller.__setSessionInfo = (info) => {
    sessionInfo = info;
  };

  return controller;
}

/**
 * Lets the replay grace (#1324) run out, so the next tick is the first one
 * the translator takes as live. Switches to fake timers when the test has
 * not already; `afterEach` restores them.
 */
function elapseReplayGrace(): void {
  if (!vi.isFakeTimers()) vi.useFakeTimers();

  vi.advanceTimersByTime(REPLAY_EXIT_GRACE_MS);
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
    CarLeftRight: CarLeftRight.Off,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: 0,
    LapDistPct: 0,
    FuelLevel: 10,
    ...overrides,
  } as TelemetryData;
}

describe("sim-events-iracing translator", () => {
  beforeEach(() => {
    initializeEventBus(createMockLogger());
  });

  afterEach(() => {
    _resetSimEventsIracing();
    _resetEventBus();
    // Safety net — one overtake test uses fake timers with inline restore,
    // so a throw between `useFakeTimers()` and `useRealTimers()` would
    // leak mocked timers into every following test. Cheap unconditional
    // restore here makes that impossible.
    vi.useRealTimers();
  });

  describe("lifecycle", () => {
    it("reports uninitialized state before init", () => {
      expect(isSimEventsIracingInitialized()).toBe(false);
      expect(getLatestTelemetry()).toBeNull();
    });

    it("initializes once and subscribes to the controller", () => {
      const controller = createMockController();
      const subscribeSpy = vi.spyOn(controller, "subscribe");
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
      expect(isSimEventsIracingInitialized()).toBe(true);
      expect(subscribeSpy).toHaveBeenCalledWith("__sim-events-iracing__", expect.any(Function));
    });

    it("throws on double initialization", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
      expect(() => initializeSimEventsIracing(getEventBus(), controller, createMockLogger())).toThrow(
        "already initialized",
      );
    });

    it("stores the latest telemetry snapshot per tick", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
      const t = telemetry({ Lap: 3 });
      controller.__tick(t);
      expect(getLatestTelemetry()).toBe(t);
    });

    it("clears state on disconnect", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
      controller.__tick(telemetry({ OnPitRoad: true }));
      controller.__tick(null, false);
      expect(getLatestTelemetry()).toBeNull();
    });
  });

  describe("getLivePosition", () => {
    // Multi-class field: car0 (cls10, player), car1 (cls20), car2 (cls10), car3 (cls20).
    // Lap scores put the overall order at car1 > car2 > car0 > car3.
    const multiClassSessionInfo = {
      DriverInfo: {
        DriverCarIdx: 0,
        Drivers: [
          { CarIdx: 0, CarClassID: 10 },
          { CarIdx: 1, CarClassID: 20 },
          { CarIdx: 2, CarClassID: 10 },
          { CarIdx: 3, CarClassID: 20 },
        ],
      },
    };

    function multiClassTelemetry(overrides: Partial<TelemetryData> = {}): TelemetryData {
      return telemetry({
        CarIdxLapCompleted: [10, 10, 10, 9],
        CarIdxLapDistPct: [0.0, 0.5, 0.2, 0.5],
        CarIdxClass: [10, 20, 10, 20],
        ...overrides,
      });
    }

    it("derives class position from the live order, not the lagging official field", () => {
      const controller = createMockController();
      controller.__setSessionInfo(multiClassSessionInfo);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      // Official PlayerCarClassPosition is deliberately stale (9) to prove the
      // derived value wins.
      controller.__tick(multiClassTelemetry({ PlayerCarClassPosition: 9 }));

      const live = getLivePosition();

      // Overall: car1 P1, car2 P2, car0 P3, car3 P4 → player (car0) overall P3.
      // Class 10 ahead of the player: only car2 → class P2.
      expect(live).not.toBeNull();
      expect(live?.position).toBe(3);
      expect(live?.classPosition).toBe(2);
      expect(live?.isMultiClass).toBe(true);
    });

    it("falls back to PlayerCarClassPosition when CarIdxClass is unavailable", () => {
      const controller = createMockController();
      controller.__setSessionInfo(multiClassSessionInfo);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(multiClassTelemetry({ CarIdxClass: undefined, PlayerCarClassPosition: 5 }));

      expect(getLivePosition()?.classPosition).toBe(5);
    });
  });

  describe("getLiveCarPosition", () => {
    it("returns an arbitrary car's live position from the canonical order", () => {
      const controller = createMockController();
      controller.__setSessionInfo({
        DriverInfo: {
          DriverCarIdx: 0,
          Drivers: [
            { CarIdx: 0, CarClassID: 10 },
            { CarIdx: 1, CarClassID: 20 },
            { CarIdx: 2, CarClassID: 10 },
            { CarIdx: 3, CarClassID: 20 },
          ],
        },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      // Overall: car1 P1, car2 P2, car0 P3, car3 P4 (multi-class field).
      controller.__tick(
        telemetry({
          CarIdxLapCompleted: [10, 10, 10, 9],
          CarIdxLapDistPct: [0.0, 0.5, 0.2, 0.5],
          CarIdxClass: [10, 20, 10, 20],
        }),
      );

      // car1: overall P1, class-20 leader.
      expect(getLiveCarPosition(1)).toEqual({ position: 1, classPosition: 1, isMultiClass: true });
      // car3: overall P4; class-20 cars ahead of it: car1 → class P2.
      expect(getLiveCarPosition(3)).toEqual({ position: 4, classPosition: 2, isMultiClass: true });
    });

    it("returns null for unranked cars and invalid indices", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ DriverInfo: { DriverCarIdx: 0 } });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(
        telemetry({
          CarIdxLapCompleted: [10, 10],
          CarIdxLapDistPct: [0.0, 0.5],
        }),
      );

      expect(getLiveCarPosition(63)).toBeNull(); // not in the order
      expect(getLiveCarPosition(-1)).toBeNull();
      expect(getLiveCarPosition(1.5)).toBeNull();
    });
  });

  describe("getLiveOpponentFlags (issue #936)", () => {
    it("returns null before the flag store's first tick", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ DriverInfo: { DriverCarIdx: 0 } });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      // A tick with no CarIdxSessionFlags never seeds the store.
      controller.__tick(telemetry({ CarIdxSessionFlags: undefined }));

      expect(getLiveOpponentFlags()).toBeNull();
    });

    it("returns the sparse flagged-car list — penalty bits only, player's own car included, table-decoded", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ DriverInfo: { DriverCarIdx: 0 } });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(
        telemetry({
          CarIdxLapCompleted: [10, 10, 10, 10],
          CarIdxLapDistPct: [0.1, 0.2, 0.3, 0.4],
          // car0 (the player): Black + Servicible (the Step 0 capture value) —
          // Servicible is not a penalty bit and must be masked out, while the
          // player's own car IS included in the whole-field truth snapshot.
          // car1: unflagged. car2: Furled + Repair. car3: Disqualify.
          CarIdxSessionFlags: [0x50000, 0, Flags.Furled | Flags.Repair, Flags.Disqualify],
        }),
      );

      expect(getLiveOpponentFlags()).toEqual({
        cars: [
          { carIdx: 0, flags: [OpponentPenaltyFlag.Black] },
          { carIdx: 2, flags: [OpponentPenaltyFlag.Furled, OpponentPenaltyFlag.Repair] },
          { carIdx: 3, flags: [OpponentPenaltyFlag.Disqualify] },
        ],
      });
    });
  });

  describe("opponent-flag wiring (issues #1274, #1273)", () => {
    const raceSession = (): Record<string, unknown> => ({
      DriverInfo: {
        DriverCarIdx: 0,
        Drivers: [
          { CarIdx: 0, CarNumber: "1" },
          { CarIdx: 1, CarNumber: "07" },
          { CarIdx: 2, CarNumber: "22" },
        ],
      },
      SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
    });

    /** One green-race tick: car1 `gapAheadS` race-seconds ahead of the player, car2 half a second behind. */
    function raceTick(k: number, gapAheadS: number, car1Flags: number): TelemetryData {
      const player = 0.3 + 0.01 * k;

      return telemetry({
        SessionState: SessionState.Racing,
        SessionTime: 100 + k,
        CarIdxLapCompleted: [5, 5, 5],
        CarIdxLapDistPct: [player, player + 0.01 * gapAheadS, player - 0.005],
        CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
        CarIdxClass: [0, 0, 0],
        CarIdxSessionFlags: [0, car1Flags, 0],
      });
    }

    /**
     * Drive a green race where every car laps at 0.01 of a lap per second, so
     * the traces `getLiveGapBetween` reads build up over the ticks; the
     * meatball goes up on car1 on the last tick only.
     */
    function drive(controller: MockController, gapAheadS: number, ticks = 6): void {
      for (let k = 0; k < ticks; k++) {
        controller.__tick(raceTick(k, gapAheadS, k === ticks - 1 ? Flags.Repair : 0));
      }
    }

    it("defaults the range to 3 s when no resolver is passed, naming the car and carrying the race gap", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("opponentFlag.flagged", handler);
      controller.__setSessionInfo(raceSession());
      initializeSimEventsIracing(bus, controller, createMockLogger());

      drive(controller, 2.5);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0].data).toMatchObject({
        relation: "ahead",
        carIdx: 1,
        flag: OpponentPenaltyFlag.Repair,
        trigger: "raised",
        position: 1,
        carNumber: "07",
        gapSeconds: expect.closeTo(2.5, 5),
      });
    });

    it("stays silent for a car further ahead than the default 3 s", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("opponentFlag.flagged", handler);
      controller.__setSessionInfo(raceSession());
      initializeSimEventsIracing(bus, controller, createMockLogger());

      drive(controller, 3.5);

      expect(handler).not.toHaveBeenCalled();
    });

    it("reads getOpponentFlagRangeSeconds live — a widened range announces the still-flagged car as entered-range", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      let range = 2;
      bus.subscribe("opponentFlag.flagged", handler);
      controller.__setSessionInfo(raceSession());
      initializeSimEventsIracing(bus, controller, createMockLogger(), { getOpponentFlagRangeSeconds: () => range });

      drive(controller, 2.5);
      expect(handler).not.toHaveBeenCalled();

      range = 3;
      controller.__tick(raceTick(6, 2.5, Flags.Repair));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0].data).toMatchObject({ carIdx: 1, trigger: "entered-range" });
    });

    it.each([
      { flag: OpponentPenaltyFlag.Black, bit: Flags.Black, holdMs: 3000 },
      { flag: OpponentPenaltyFlag.Furled, bit: Flags.Furled, holdMs: 1000 },
    ])(
      "a $flag already up when a replay glance ends re-seeds silently and announces as entered-range, never raised",
      ({ flag, bit, holdMs }) => {
        vi.useFakeTimers();
        const controller = createMockController();
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("opponentFlag.flagged", handler);
        controller.__setSessionInfo(raceSession());
        initializeSimEventsIracing(bus, controller, createMockLogger());

        // Wall clock in quarter seconds, session clock in whole seconds: the
        // traces the wipe cleared are readable again two ticks after it,
        // well before either hold clears, so the trigger is the hold's alone.
        const start = Date.UTC(2026, 9, 3, 12);
        let k = 0;
        const tickAt = (car1Flags: number, replay = false): void => {
          vi.setSystemTime(start + k * 250);
          controller.__tick({ ...raceTick(k, 1.5, car1Flags), IsReplayPlaying: replay } as TelemetryData);
          k++;
        };

        for (let n = 0; n < 6; n++) tickAt(0);

        // A replay glance; the flag goes up on car1 meanwhile.
        tickAt(bit, true);
        tickAt(bit, true);

        // Back live: the ticks inside the exit grace (#1324) are still the
        // replay's, then the re-seed tick, then the hold and a little more.
        for (let n = 0; n <= (REPLAY_EXIT_GRACE_MS + holdMs) / 250 + 2; n++) tickAt(bit);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]![0].data).toMatchObject({ carIdx: 1, flag, trigger: "entered-range" });
      },
    );

    /**
     * A green race on a 4 km track where car1 crawls at `leaderMps` and sits
     * `aheadM` metres up the road on the last tick, while the player laps at
     * 0.01 of a lap per second (40 m/s); the meatball goes up on car1 on the
     * last tick only.
     */
    function driveCrawler(controller: MockController, leaderMps: number, aheadM: number, ticks = 10): void {
      const trackM = 4000;
      const rate = leaderMps / trackM;
      const last = ticks - 1;
      const carAtEnd = 0.3 + 0.01 * last + aheadM / trackM;

      for (let k = 0; k < ticks; k++) {
        const player = 0.3 + 0.01 * k;

        controller.__tick(
          telemetry({
            SessionState: SessionState.Racing,
            SessionTime: 100 + k,
            CarIdxLapCompleted: [5, 5, 5],
            CarIdxLapDistPct: [player, carAtEnd - rate * (last - k), player - 0.005],
            CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
            CarIdxClass: [0, 0, 0],
            CarIdxSessionFlags: [0, k === last ? Flags.Repair : 0, 0],
          }),
        );
      }
    }

    const raceSessionWithTrack = (): Record<string, unknown> => ({
      ...raceSession(),
      WeekendInfo: { TrackID: 1, TrackLength: "4.00 km" },
    });

    it("reads the gap display's ETA behind a crawling car — a stopped-ish car 30 m ahead is 0.75 s away, inside the default 3 s (#1285 regime)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("opponentFlag.flagged", handler);
      controller.__setSessionInfo(raceSessionWithTrack());
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // 5 m/s: the crossing time to car1 is 6 s, which the 3 s range rejects.
      driveCrawler(controller, 5, 30);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0].data).toMatchObject({
        relation: "ahead",
        carIdx: 1,
        gapSeconds: expect.closeTo(0.75, 5),
      });
    });

    it("keeps the crossing time for a slower car above the crawl bar", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("opponentFlag.flagged", handler);
      controller.__setSessionInfo(raceSessionWithTrack());
      initializeSimEventsIracing(bus, controller, createMockLogger(), { getOpponentFlagRangeSeconds: () => 5 });

      // 15 m/s, 70 m ahead: crossing 70 / 15 s; the ETA would have read 1.75 s.
      driveCrawler(controller, 15, 70);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0].data).toMatchObject({ carIdx: 1, gapSeconds: expect.closeTo(70 / 15, 5) });
    });

    it("never reads the ETA without a track length — the crawling car 30 m ahead stays 6 s away and silent", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("opponentFlag.flagged", handler);
      controller.__setSessionInfo(raceSession());
      initializeSimEventsIracing(bus, controller, createMockLogger());

      driveCrawler(controller, 5, 30);

      expect(handler).not.toHaveBeenCalled();
    });

    it("writes the debug lines through an OpponentFlags scope of the translator's logger", () => {
      const controller = createMockController();
      const scoped = createMockLogger();
      const logger = createMockLogger();
      vi.mocked(logger.createScope).mockReturnValue(scoped);
      controller.__setSessionInfo(raceSession());
      initializeSimEventsIracing(getEventBus(), controller, logger);

      drive(controller, 2.5);

      expect(logger.createScope).toHaveBeenCalledWith("OpponentFlags");
      const lines = vi.mocked(scoped.debug).mock.calls.map((c) => c[0]);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("Opponent flag announced");
      expect(lines[0]).toContain("carNumber=07");
      expect(scoped.info).not.toHaveBeenCalled();
    });
  });

  describe("getLiveRacePositions", () => {
    it("returns the live per-car race order (1-based, indexed by carIdx)", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ DriverInfo: { DriverCarIdx: 0 } });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      // Lap scores: car0=10.0, car1=10.5, car2=10.2, car3=9.5 → P1 car1, P2 car2, P3 car0, P4 car3.
      controller.__tick(
        telemetry({
          CarIdxLapCompleted: [10, 10, 10, 9],
          CarIdxLapDistPct: [0.0, 0.5, 0.2, 0.5],
        }),
      );

      const positions = getLiveRacePositions();

      expect(positions).not.toBeNull();
      expect(positions?.[0]).toBe(3); // player (car0)
      expect(positions?.[1]).toBe(1); // car1 leads
      expect(positions?.[2]).toBe(2);
      expect(positions?.[3]).toBe(4);
    });

    it("returns null before any telemetry has arrived", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      expect(getLiveRacePositions()).toBeNull();
    });
  });

  describe("pre-green grid order (issue #974)", () => {
    /** A race session whose grid puts car2 on pole, then car1, then the player (car0). */
    function raceSessionWithGrid(): Record<string, unknown> {
      return {
        DriverInfo: { DriverCarIdx: 0, Drivers: [{ CarIdx: 0 }, { CarIdx: 1 }, { CarIdx: 2 }] },
        SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
        QualifyResultsInfo: {
          Results: [
            { CarIdx: 2, Position: 0 },
            { CarIdx: 1, Position: 1 },
            { CarIdx: 0, Position: 2 },
          ],
        },
      };
    }

    /** Parade lap: nobody has completed a lap, so the lap-progress order ranks nobody. */
    function paradeLap(): TelemetryData {
      return telemetry({
        SessionState: SessionState.ParadeLaps,
        CarIdxLapCompleted: [-1, -1, -1],
        CarIdxLapDistPct: [0.94, 0.95, 0.96],
        CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
        CarIdxClass: [0, 0, 0],
      });
    }

    it("serves the whole field its grid slot during the parade lap", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSessionWithGrid());
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(paradeLap());

      expect(getLiveRacePositions()).toEqual([3, 2, 1]);
    });

    it("reports the player's grid slot and class slot pre-green", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSessionWithGrid());
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(paradeLap());

      expect(getLivePosition()).toEqual({ position: 3, classPosition: 3, isMultiClass: false });
      expect(getLiveCarPosition(2)).toEqual({ position: 1, classPosition: 1, isMultiClass: false });
    });

    it("keeps the lap-progress order in a non-race session", () => {
      const controller = createMockController();
      const practice = raceSessionWithGrid();
      practice.SessionInfo = { Sessions: [{ SessionNum: 0, SessionType: "Practice" }] };
      controller.__setSessionInfo(practice);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      // Same pre-green state, but a stale qualifying grid must not surface here.
      // The lap distances deliberately rank the field the exact INVERSE of the
      // grid, so a leaked grid order fails the assertion instead of coinciding
      // with it.
      controller.__tick(
        telemetry({
          SessionState: SessionState.ParadeLaps,
          CarIdxLapCompleted: [3, 3, 3],
          CarIdxLapDistPct: [0.9, 0.5, 0.1],
          CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
        }),
      );

      expect(getLiveRacePositions()).toEqual([1, 2, 3]);
    });

    it("rolls to the live running order once the green flies", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSessionWithGrid());
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(paradeLap());
      controller.__tick(
        telemetry({
          SessionState: SessionState.Racing,
          CarIdxLapCompleted: [0, 0, 0],
          CarIdxLapDistPct: [0.3, 0.2, 0.1],
          CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
        }),
      );

      // The player (car0) led lap 1 off the line despite starting third.
      expect(getLiveRacePositions()).toEqual([1, 2, 3]);
    });

    it("does not read the grid-to-live handover at the green as a position change", () => {
      // The grid and the live order legitimately disagree, so the switch at the
      // green must not surface as an overtake. `diffOvertakes` rolls its
      // baselines silently while pre-green and leaves itself uninitialized, so
      // the first racing tick seeds fresh from the green-flag order.
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("overtake.completed", handler);
      controller.__setSessionInfo(raceSessionWithGrid());
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(paradeLap());
      controller.__tick(paradeLap());

      // Green, and the player is suddenly the live leader — a two-place "gain"
      // that exists only because the order SOURCE changed.
      const racing = (): TelemetryData =>
        telemetry({
          SessionState: SessionState.Racing,
          CarIdxLapCompleted: [0, 0, 0],
          CarIdxLapDistPct: [0.3, 0.2, 0.1],
          CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
          CarIdxClass: [0, 0, 0],
        });

      controller.__tick(racing());

      // Hold well past OVERTAKE_HOLD_MS: an unseeded baseline would confirm the
      // pending "gain" here.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 5000);
      controller.__tick(racing());
      vi.useRealTimers();

      expect(handler).not.toHaveBeenCalled();
    });

    it("reports no leader pace pre-green, so a parade lap can't pass as racing pace", () => {
      // The grid order names a leader before the green, where the frozen order
      // named nobody — so `CarIdxLastLapTime` for the pole sitter is now
      // readable, and on a rolling start it holds the PARADE lap (minutes). The
      // timed-race fuel-coverage estimate divides the remaining clock by this,
      // so an inflated lap time UNDER-counts the laps left and suppresses fuel
      // warnings — the opposite of that estimate's documented safe direction.
      const paceTelemetry = (sessionState: SessionState): TelemetryData =>
        telemetry({
          SessionState: sessionState,
          CarIdxLastLapTime: [92.5, 180.4, 92.9],
          CarIdxBestLapTime: [92.1, 91.8, 92.4],
        });

      // car1 leads: the pole sitter pre-green, the race leader after it.
      expect(resolveLeaderLapTimeS(paceTelemetry(SessionState.ParadeLaps), [2, 1, 3])).toBeNull();
      expect(resolveLeaderLapTimeS(paceTelemetry(SessionState.Racing), [2, 1, 3])).toBe(180.4);
    });
  });

  describe("resolveGapLapsRemaining (issue #1311)", () => {
    // car1 leads ([2, 1, 3]) at a 90 s lap, a quarter of the way round; the
    // sentinels mark an absent limit. Both sides count the leader's remaining
    // line crossings, the chequered one included.
    const limits = (lapsRemain: number, timeRemainS: number, overrides: Partial<TelemetryData> = {}): TelemetryData =>
      telemetry({
        SessionState: SessionState.Racing,
        SessionLapsRemainEx: lapsRemain,
        SessionTimeRemain: timeRemainS,
        CarIdxLastLapTime: [91, 90, 92],
        CarIdxLapDistPct: [0.1, 0.25, 0.5],
        ...overrides,
      });
    const order = [2, 1, 3];

    it("takes the clock's crossings when a timed race's lap cap is larger", () => {
      // 100-lap cap, 20 minutes left: the white is the leader's 14th crossing
      // (ceil(1200 / 90 + 0.25)), the chequered the 15th.
      expect(resolveGapLapsRemaining(limits(100, 1200), order, false)).toBe(15);
    });

    it("takes the lap cap when it ends a dual-limit race sooner", () => {
      expect(resolveGapLapsRemaining(limits(5, 1200), order, false)).toBe(5);
    });

    it("counts the white and chequered laps the clock still runs, so a cap that ends the race first binds", () => {
      // 200 s is 2.2 leader laps, but the leader still takes the white at
      // crossing 3 and the chequered at 4, so the 3-lap cap ends it first.
      expect(resolveGapLapsRemaining(limits(3, 200), order, false)).toBe(3);
    });

    it("reads the counter in a lap-only race", () => {
      expect(resolveGapLapsRemaining(limits(12, IRSDK_UNLIMITED_TIME), order, false)).toBe(12);
    });

    it("counts the clock's crossings in a time-only race", () => {
      expect(resolveGapLapsRemaining(limits(IRSDK_UNLIMITED_LAPS, 900), order, false)).toBe(12);
    });

    it("takes an unknown leader lap fraction as the line, the smaller count", () => {
      const offWorld = limits(IRSDK_UNLIMITED_LAPS, 900, { CarIdxLapDistPct: [0.1, -1, 0.5] });

      expect(resolveGapLapsRemaining(offWorld, order, false)).toBe(11);
    });

    it("leaves the horizon null when neither limit is known", () => {
      expect(resolveGapLapsRemaining(limits(IRSDK_UNLIMITED_LAPS, IRSDK_UNLIMITED_TIME), order, false)).toBeNull();
    });

    it("leaves a running clock unknown without a leader pace", () => {
      // Pre-green there is no racing lap to project by, so a time-only race has no horizon yet.
      const parade = limits(IRSDK_UNLIMITED_LAPS, 900, { SessionState: SessionState.ParadeLaps });

      expect(resolveGapLapsRemaining(parade, order, false)).toBeNull();
    });

    it("keeps an expired clock known: two crossings until the leader takes the white, then one", () => {
      expect(resolveGapLapsRemaining(limits(IRSDK_UNLIMITED_LAPS, -5), order, false)).toBe(2);
      expect(resolveGapLapsRemaining(limits(IRSDK_UNLIMITED_LAPS, -40), order, true)).toBe(1);
      expect(resolveGapLapsRemaining(limits(IRSDK_UNLIMITED_LAPS, 0), order, false)).toBe(2);
    });

    it("does not fall back to a larger lap cap once the clock has expired", () => {
      expect(resolveGapLapsRemaining(limits(60, -5), order, false)).toBe(2);
      expect(resolveGapLapsRemaining(limits(60, -40), order, true)).toBe(1);
    });

    it("reads a negative mid-race blip as an expired clock for that tick, never as no limit", () => {
      expect(resolveGapLapsRemaining(limits(30, -0.1), order, false)).toBe(2);
    });

    it("keeps a lap counter of 0 as zero laps rather than falling through to the clock", () => {
      expect(resolveGapLapsRemaining(limits(0, 1200), order, false)).toBe(0);
    });
  });

  describe("getStartingGridPosition (issue #647)", () => {
    it("returns the overall grid slot (1-indexed) in a single-class field", () => {
      const controller = createMockController();
      // QualifyResultsInfo.Position is 0-indexed (pole = 0); no Drivers array so
      // the class slot falls back to the overall slot.
      controller.__setSessionInfo({
        DriverInfo: { DriverCarIdx: 0 },
        QualifyResultsInfo: {
          Results: [
            { CarIdx: 2, Position: 0 },
            { CarIdx: 1, Position: 1 },
            { CarIdx: 0, Position: 2 },
          ],
        },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      expect(getStartingGridPosition()).toEqual({ overall: 3, class: 3 });
    });

    it("returns the class grid slot in a multi-class field", () => {
      const controller = createMockController();
      // car0 (player, cls10), car1 (cls20), car2 (cls10), car3 (cls20).
      // Overall grid: car1 P1, car2 P2, car0 P3, car3 P4. Player class-10 ahead: car2 → class P2.
      controller.__setSessionInfo({
        DriverInfo: {
          DriverCarIdx: 0,
          Drivers: [
            { CarIdx: 0, CarClassID: 10 },
            { CarIdx: 1, CarClassID: 20 },
            { CarIdx: 2, CarClassID: 10 },
            { CarIdx: 3, CarClassID: 20 },
          ],
        },
        QualifyResultsInfo: {
          Results: [
            { CarIdx: 1, Position: 0 },
            { CarIdx: 2, Position: 1 },
            { CarIdx: 0, Position: 2 },
            { CarIdx: 3, Position: 3 },
          ],
        },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      expect(getStartingGridPosition()).toEqual({ overall: 3, class: 2 });
    });

    it("returns null when qualifying results are unavailable", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ DriverInfo: { DriverCarIdx: 0 } });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      expect(getStartingGridPosition()).toBeNull();
    });

    it("returns null when the player has no qualifying entry", () => {
      const controller = createMockController();
      controller.__setSessionInfo({
        DriverInfo: { DriverCarIdx: 7 },
        QualifyResultsInfo: { Results: [{ CarIdx: 0, Position: 0 }] },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      expect(getStartingGridPosition()).toBeNull();
    });

    it("survives an empty YAML list item in the qualifying results", () => {
      // Session YAML emits an empty list item as `null` — reading `.CarIdx` off
      // it would throw inside the per-tick path, and nothing above `handleTick`
      // catches that. Both the player lookup and the class count must skip it.
      const controller = createMockController();
      controller.__setSessionInfo({
        DriverInfo: {
          DriverCarIdx: 0,
          Drivers: [
            { CarIdx: 0, CarClassID: 10 },
            { CarIdx: 2, CarClassID: 10 },
          ],
        },
        QualifyResultsInfo: {
          Results: [null, { CarIdx: 2, Position: 0 }, null, { CarIdx: 0, Position: 1 }],
        },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      expect(getStartingGridPosition()).toEqual({ overall: 2, class: 2 });
    });
  });

  describe("getDriverSetupName", () => {
    it("returns undefined before any telemetry tick", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ DriverInfo: { DriverSetupName: "qualifying.sto" } });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      expect(getDriverSetupName()).toBeUndefined();
    });

    it("returns the setup name from session YAML once connected", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ DriverInfo: { DriverSetupName: "qualifying.sto" } });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry());

      expect(getDriverSetupName()).toBe("qualifying.sto");
    });

    it("returns undefined when the field is missing, empty, or session info is null", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());
      controller.__tick(telemetry());

      controller.__setSessionInfo(null);
      expect(getDriverSetupName()).toBeUndefined();

      controller.__setSessionInfo({ DriverInfo: {} });
      expect(getDriverSetupName()).toBeUndefined();

      controller.__setSessionInfo({ DriverInfo: { DriverSetupName: "" } });
      expect(getDriverSetupName()).toBeUndefined();
    });
  });

  describe("getRaceFinishResult (issue #1278)", () => {
    function raceSessionInfo(
      position: number = 4,
      classPosition: number = 2,
      lapsComplete: number = 5,
    ): Record<string, unknown> {
      return {
        WeekendInfo: { SimMode: "full" },
        DriverInfo: { DriverCarIdx: 0, Drivers: [{ CarIdx: 0, CarClassID: 1 }] },
        SessionInfo: {
          Sessions: [
            {
              SessionNum: 0,
              SessionType: "Race",
              ResultsPositions: [
                { CarIdx: 0, Position: position, ClassPosition: classPosition, LapsComplete: lapsComplete },
              ],
            },
          ],
        },
      };
    }

    /** Lap 4 with the leader already finished, then the player's lap-5 crossing under the flag. */
    function finishRace(controller: MockController): void {
      controller.__tick(telemetry({ LapCompleted: 4, LapLastLapTime: 62, LapBestLapTime: 62 }));
      controller.__tick(
        telemetry({
          LapCompleted: 4,
          LapLastLapTime: 62,
          LapBestLapTime: 62,
          SessionFlags: Flags.Checkered,
          SessionState: SessionState.Checkered,
        }),
      );
      controller.__tick(
        telemetry({
          LapCompleted: 5,
          LapLastLapTime: 63,
          LapBestLapTime: 62,
          SessionFlags: Flags.Checkered,
          SessionState: SessionState.Checkered,
        }),
      );
    }

    it("returns null before the player has taken the checkered flag", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSessionInfo());
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ LapCompleted: 4, LapLastLapTime: 62, LapBestLapTime: 62 }));

      expect(getRaceFinishResult(0)).toBeNull();
    });

    it("returns the player's official result once they have finished", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSessionInfo());
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      finishRace(controller);

      // ResultsPositions' ClassPosition is 0-indexed; the result is 1-indexed.
      expect(getRaceFinishResult(0)).toEqual({ position: 4, classPosition: 3 });
    });

    it("follows the official results row after the finish, not a snapshot", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSessionInfo());
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      finishRace(controller);
      // A steward's decision moves the player down the official results.
      controller.__setSessionInfo(raceSessionInfo(5, 3));

      expect(getRaceFinishResult(0)).toEqual({ position: 5, classPosition: 4 });
    });

    it("reports unknown fields while the results row has not caught up to the finishing lap", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSessionInfo());
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      finishRace(controller);
      controller.__setSessionInfo(raceSessionInfo(9, 8, 4));

      expect(getRaceFinishResult(0)).toEqual({ position: 0, classPosition: 0 });
    });

    // The winner's crossing, the flag's rise and a synced standings row can
    // all land on one tick, and the lap is emitted on it. The flag diff's
    // winner grace has to have recorded the crossing before the lap diff
    // decides it, or the finish is missed and never revisited (PR #1280).
    it("records the winner's finish when the crossing, the flag and the emit share a tick", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSessionInfo(1, 0));
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ LapCompleted: 4, LapLastLapTime: 62, LapBestLapTime: 62, PlayerCarPosition: 1 }));
      controller.__tick(
        telemetry({
          LapCompleted: 5,
          LapLastLapTime: 63,
          LapBestLapTime: 62,
          SessionFlags: Flags.Checkered,
          SessionState: SessionState.Checkered,
          PlayerCarPosition: 1,
        }),
      );

      expect(isRaceFinished()).toBe(true);
      expect(getRaceFinishResult(0)).toEqual({ position: 1, classPosition: 1 });
    });

    it("never answers for another session", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSessionInfo());
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      finishRace(controller);

      expect(getRaceFinishResult(1)).toBeNull();
    });

    it("survives a replay visit after the finish", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSessionInfo());
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      finishRace(controller);

      // Out of the car / watching the replay: replay-mode ticks wipe the state.
      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: false, SessionState: SessionState.CoolDown }));
      // …and back to a live tick in the same session.
      elapseReplayGrace();
      controller.__tick(telemetry({ LapCompleted: 5, SessionState: SessionState.CoolDown }));

      expect(isRaceFinished()).toBe(true);
      expect(getRaceFinishResult(0)).toEqual({ position: 4, classPosition: 3 });
    });
  });

  describe("isDamageRepairNeeded (issue #1288)", () => {
    const DAMAGED = EngineWarnings.MandRepNeeded;

    it("is null before the translator is initialized and before its first live tick", () => {
      expect(isDamageRepairNeeded()).toBeNull();

      initializeSimEventsIracing(getEventBus(), createMockController(), createMockLogger());

      expect(isDamageRepairNeeded()).toBeNull();
    });

    it("answers the SETTLED state: a raw flicker of the repair bits changes nothing either way", () => {
      vi.useFakeTimers();
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry());
      expect(isDamageRepairNeeded()).toBe(false);

      // The bits rise; not settled yet, so still no repair needed.
      controller.__tick(telemetry({ EngineWarnings: DAMAGED }));
      expect(isDamageRepairNeeded()).toBe(false);

      vi.advanceTimersByTime(DAMAGE_DEBOUNCE_MS);
      controller.__tick(telemetry({ EngineWarnings: DAMAGED }));
      expect(isDamageRepairNeeded()).toBe(true);

      // One tick with the bits down — a collision-frame rebound or pit-stall
      // service flicker. The latest raw tick says "repaired"; the settled
      // state does not, so a damage line waiting for the radio is not lost.
      vi.advanceTimersByTime(100);
      controller.__tick(telemetry({ EngineWarnings: 0 }));
      expect(isDamageRepairNeeded()).toBe(true);

      vi.advanceTimersByTime(100);
      controller.__tick(telemetry({ EngineWarnings: DAMAGED }));
      expect(isDamageRepairNeeded()).toBe(true);

      // A repair that holds: false only once the clear has settled.
      controller.__tick(telemetry({ EngineWarnings: 0 }));
      vi.advanceTimersByTime(DAMAGE_DEBOUNCE_MS - 100);
      controller.__tick(telemetry({ EngineWarnings: 0 }));
      expect(isDamageRepairNeeded()).toBe(true);

      vi.advanceTimersByTime(100);
      controller.__tick(telemetry({ EngineWarnings: 0 }));
      expect(isDamageRepairNeeded()).toBe(false);
    });

    it("seeds from the first live tick and returns to null on a disconnect", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      // Connecting mid-damage: known damage, seeded rather than announced.
      controller.__tick(telemetry({ EngineWarnings: DAMAGED }));
      expect(isDamageRepairNeeded()).toBe(true);

      controller.__tick(null, false);
      expect(isDamageRepairNeeded()).toBeNull();
    });
  });

  describe("getFuelStats", () => {
    /**
     * Seed mid-lap (partial segment, discarded at its crossing), then run one
     * full line-to-line lap burning 3 L over 90 s — leaves `getFuelStats`
     * reporting exactly one valid lap.
     */
    function driveOneCleanLap(controller: MockController): void {
      controller.__tick(telemetry({ Lap: 0, LapDistPct: 0.9, SessionTime: 40, FuelLevel: 50, PlayerCarTowTime: 0 }));
      controller.__tick(telemetry({ Lap: 1, LapDistPct: 0.05, SessionTime: 100, FuelLevel: 50, PlayerCarTowTime: 0 }));
      controller.__tick(telemetry({ Lap: 1, LapDistPct: 0.9, SessionTime: 189, FuelLevel: 47.2, PlayerCarTowTime: 0 }));
      controller.__tick(telemetry({ Lap: 2, LapDistPct: 0.05, SessionTime: 190, FuelLevel: 47, PlayerCarTowTime: 0 }));
    }

    it("returns empty stats before initialization", () => {
      expect(getFuelStats(5)).toEqual({ lastLap: null, avg: null, avgLapTime: null, samples: 0 });
    });

    it("tracks per-lap fuel consumption through handleTick", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      driveOneCleanLap(controller);

      const stats = getFuelStats(5);
      expect(stats.samples).toBe(1);
      expect(stats.lastLap).toBeCloseTo(3);
      expect(stats.avg).toBeCloseTo(3);
    });

    it("clears the stats on disconnect", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      driveOneCleanLap(controller);

      expect(getFuelStats(5).samples).toBe(1);

      controller.__tick(null, false);

      expect(getFuelStats(5)).toEqual({ lastLap: null, avg: null, avgLapTime: null, samples: 0 });
    });

    it("preserves the stats across a replay/garage visit", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      driveOneCleanLap(controller);

      expect(getFuelStats(5).samples).toBe(1);

      // Into the garage: iRacing reports replay-mode ticks. The stats stay
      // visible for planning while adjusting the setup.
      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: false, SessionTime: 300 }));

      expect(getFuelStats(5).samples).toBe(1);

      // Back in the car in the same session — the history is still there.
      elapseReplayGrace();
      controller.__tick(telemetry({ Lap: 2, LapDistPct: 0.5, SessionTime: 400, FuelLevel: 46 }));

      expect(getFuelStats(5).samples).toBe(1);
      expect(getFuelStats(5).lastLap).toBeCloseTo(3);
    });

    it("ignores paused replay-only ticks (IsReplayPlaying false while SimMode is replay)", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      driveOneCleanLap(controller);

      expect(getFuelStats(5).samples).toBe(1);

      // Paused / frame-scrubbed replay: IsReplayPlaying reads false but the
      // session YAML says SimMode "replay" (#655 precedent) — the replayed
      // Lap-0 telemetry must not reach the tracker (its rewound Lap + clock
      // would otherwise trip the session-restart fence and wipe the history).
      controller.__setSessionInfo({ WeekendInfo: { SimMode: "replay" } });
      controller.__tick(telemetry({ Lap: 0, LapDistPct: 0.3, SessionTime: 20, FuelLevel: 60, IsOnTrack: false }));

      expect(getFuelStats(5).samples).toBe(1);

      // Back to the live session — history intact.
      controller.__setSessionInfo(null);
      controller.__tick(telemetry({ Lap: 2, LapDistPct: 0.5, SessionTime: 400, FuelLevel: 46 }));

      expect(getFuelStats(5).samples).toBe(1);
      expect(getFuelStats(5).lastLap).toBeCloseTo(3);
    });

    it("defers the session-change wipe until the driver is back in the car", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      driveOneCleanLap(controller);

      expect(getFuelStats(5).samples).toBe(1);

      // Session change lands while the driver is out of the car — the old
      // session's stats keep displaying (garage fuel planning).
      controller.__tick(
        telemetry({ SessionNum: 1, IsOnTrack: false, Lap: 0, LapDistPct: 0.3, SessionTime: 500, FuelLevel: 55 }),
      );

      expect(getFuelStats(5).samples).toBe(1);

      // First tick back in the car → wiped, rebuilding from the new session.
      controller.__tick(
        telemetry({ SessionNum: 1, IsOnTrack: true, Lap: 0, LapDistPct: 0.4, SessionTime: 520, FuelLevel: 55 }),
      );

      expect(getFuelStats(5)).toEqual({ lastLap: null, avg: null, avgLapTime: null, samples: 0 });
    });
  });

  describe("checkered deferral across a replay glance (issue #771)", () => {
    it("keeps a pending checkered through replay-mode ticks and speaks it at the crossing", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("flag.checkered.raised", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Live mid-lap, then the checkered flies — deferred, nothing spoken yet.
      controller.__tick(telemetry({ LapCompleted: 5, LapDistPct: 0.4 }));
      controller.__tick(telemetry({ LapCompleted: 5, LapDistPct: 0.5, SessionFlags: Flags.Checkered }));
      expect(handler).not.toHaveBeenCalled();

      // A replay glance wipes translator state — the pending fire must
      // survive the wipe (issue #771 review follow-up).
      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: false, SessionFlags: Flags.Checkered }));
      elapseReplayGrace();
      controller.__tick(telemetry({ LapCompleted: 5, LapDistPct: 0.8, SessionFlags: Flags.Checkered }));
      expect(handler).not.toHaveBeenCalled();

      // Takes the flag at the line.
      controller.__tick(telemetry({ LapCompleted: 6, LapDistPct: 0.01, SessionFlags: Flags.Checkered }));
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // Issue #1324: for about 300 ms after every replay seek iRacing reports
  // `IsReplayPlaying` false. The guard used to take those ticks for a trip to
  // live — it wiped the diffs, ran them against the replay telemetry and wiped
  // again on the way back — and it now reads the controller's debounced
  // replay state, which holds "in a replay" for `REPLAY_EXIT_GRACE_MS` after
  // the last replay tick and never lets a saved replay read as live.
  describe("the replay guard reads the debounced replay state (issue #1324)", () => {
    const TICK_MS = 16;
    const LIVE_RACE: Record<string, unknown> = {
      WeekendInfo: { TrackID: 42, SimMode: "full" },
      SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
      DriverInfo: { DriverCarIdx: 0, Drivers: [{ CarIdx: 0 }] },
    };
    const SAVED_REPLAY: Record<string, unknown> = {
      ...LIVE_RACE,
      WeekendInfo: { TrackID: 42, SimMode: "replay" },
    };

    /** A green-flag race tick with the car on the circuit and nothing scored. */
    function liveTick(overrides: Partial<TelemetryData> = {}): TelemetryData {
      return telemetry({
        SessionNum: 0,
        SessionState: SessionState.Racing,
        SessionFlags: Flags.Green,
        IsOnTrack: true,
        OnPitRoad: false,
        PlayerTrackSurface: TrkLoc.OnTrack,
        PlayerCarMyIncidentCount: 0,
        Lap: 3,
        LapDistPct: 0.5,
        ReplayFrameNum: 0,
        ReplayFrameNumEnd: 30_000,
        ...overrides,
      });
    }

    /** The same moment seen from the in-session replay, parked a lap back. */
    function replayTick(overrides: Partial<TelemetryData> = {}): TelemetryData {
      return liveTick({ IsReplayPlaying: true, IsOnTrack: false, ReplayFrameNum: 12_000, ...overrides });
    }

    /**
     * Boots the translator at a live race, records every publish from here on
     * (every event in the catalog, not a chosen few, so nothing can slip by
     * unwatched), and returns a ticker that advances the fake clock `TICK_MS`
     * per tick.
     */
    function start(sessionInfo: Record<string, unknown>) {
      vi.useFakeTimers();
      vi.setSystemTime(Date.UTC(2026, 9, 4, 11, 25, 57));
      const controller = createMockController();
      controller.__setSessionInfo(sessionInfo);
      const bus = getEventBus();
      const publish = vi.spyOn(bus, "publish");
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const tick = (t: TelemetryData, times = 1): void => {
        for (let n = 0; n < times; n++) {
          vi.advanceTimersByTime(TICK_MS);
          controller.__tick(t);
        }
      };
      const published = (): string[] => publish.mock.calls.map((c) => c[0].event);

      return { controller, tick, publish, published };
    }

    it("publishes nothing through a seek's ~300 ms IsReplayPlaying blip, though the blip's telemetry moves", () => {
      const { tick, publish, published } = start(LIVE_RACE);

      // Live for a few seconds, then the driver opens the in-session replay.
      tick(liveTick(), 20);
      tick(replayTick(), 20);
      // The replay entry's own teardown is the entry's, not the seek's.
      publish.mockClear();

      // The seek: iRacing reports the flag false for 19 ticks (304 ms) while
      // the snapshot follows the replay cursor — and moves during the blip: a
      // flag bit, pit road and the incident count all differ from the first
      // blip tick, so a guard that took the blip for live would have the diffs
      // seed on the first tick and see edges on the seventh.
      tick(liveTick({ IsReplayPlaying: false, PlayerCarMyIncidentCount: -1, ReplayFrameNum: 12_100 }), 6);
      tick(
        liveTick({
          IsReplayPlaying: false,
          SessionFlags: Flags.Green | Flags.Yellow,
          OnPitRoad: true,
          PlayerTrackSurface: TrkLoc.AproachingPits,
          PlayerCarMyIncidentCount: 1,
          ReplayFrameNum: 12_100,
        }),
        13,
      );
      // The replay plays on from the new position.
      tick(replayTick({ ReplayFrameNum: 12_120 }), 20);

      expect(published()).toEqual([]);
    });

    it("re-seeds the diffs once the grace has run out after a real exit, and publishes the edges after it", () => {
      const { tick, publish, published } = start(LIVE_RACE);
      const incidents = vi.fn();
      getEventBus().subscribe("incident.occurred", incidents);

      tick(liveTick(), 20);
      tick(replayTick(), 20);
      publish.mockClear();

      // Drive: the flag reads false for good. Inside the grace the ticks are
      // still the replay's, so an edge there is absorbed...
      tick(liveTick({ PlayerCarMyIncidentCount: 1 }), 10);
      expect(published()).toEqual([]);

      // ...and past it the first tick re-seeds (no edge is spoken for what
      // happened meanwhile), after which a real increase is scored.
      vi.advanceTimersByTime(REPLAY_EXIT_GRACE_MS);
      tick(liveTick({ PlayerCarMyIncidentCount: 1 }), 5);
      expect(incidents).not.toHaveBeenCalled();

      tick(liveTick({ PlayerIncidents: IncidentFlags.RepOffTrack, PlayerCarMyIncidentCount: 1 }), 5);
      tick(liveTick({ PlayerCarMyIncidentCount: 2 }), 5);
      // Published once the burst has been quiet for its window.
      vi.advanceTimersByTime(INCIDENT_BURST_QUIET_MS);
      tick(liveTick({ PlayerCarMyIncidentCount: 2 }), 2);
      expect(incidents).toHaveBeenCalledTimes(1);
    });

    it("takes a saved replay as a replay whatever IsReplayPlaying reads, so a scrub publishes nothing", () => {
      const { tick, published } = start(SAVED_REPLAY);

      // A paused or frame-scrubbed .rpy reads the flag false the whole way;
      // the timeline jumps through a flag change, pit road and an incident.
      tick(liveTick({ IsReplayPlaying: false }), 20);
      tick(
        liveTick({
          IsReplayPlaying: false,
          SessionFlags: Flags.Green | Flags.Yellow,
          OnPitRoad: true,
          PlayerTrackSurface: TrkLoc.AproachingPits,
          PlayerCarMyIncidentCount: 2,
        }),
        20,
      );
      tick(liveTick({ IsReplayPlaying: false, SessionFlags: Flags.Green }), 20);

      expect(published()).toEqual([]);
    });

    // The opponent diffs used to carry a `replayOnlySession` term of their own
    // for the paused saved replay; the guard covers it now, so the coverage
    // lives here, with a live positive control so the silence is the guard's.
    describe("the opponent diffs behind the guard, in a saved replay", () => {
      const THREE_CARS: Record<string, unknown> = {
        DriverInfo: {
          DriverCarIdx: 0,
          Drivers: [
            { CarIdx: 0, CarNumber: "1" },
            { CarIdx: 1, CarNumber: "07" },
            { CarIdx: 2, CarNumber: "22" },
          ],
        },
        SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
      };

      /** A green race, car1 just ahead of the player and car2 just behind, with the flag reading false. */
      function fieldTick(k: number, o: { car1Flags?: number; car1Surface?: TrkLoc } = {}): TelemetryData {
        const player = 0.3 + 0.01 * k;

        return liveTick({
          IsReplayPlaying: false,
          SessionTime: 100 + k,
          CarIdxLapCompleted: [5, 5, 5],
          CarIdxLapDistPct: [player, player + 0.015, player - 0.005],
          CarIdxTrackSurface: [TrkLoc.OnTrack, o.car1Surface ?? TrkLoc.OnTrack, TrkLoc.OnTrack],
          CarIdxClass: [0, 0, 0],
          CarIdxSessionFlags: [0, o.car1Flags ?? 0, 0],
        });
      }

      /** Six green ticks, then car1 takes the meatball, then turns into the pits with it. */
      function driveThenFlagAndPit(tick: (t: TelemetryData, times?: number) => void): void {
        for (let k = 0; k < 6; k++) tick(fieldTick(k));

        tick(fieldTick(6, { car1Flags: Flags.Repair }));
        tick(fieldTick(7, { car1Flags: Flags.Repair, car1Surface: TrkLoc.AproachingPits }));
      }

      it("publishes nothing for an opponent's flag or pit entry scrubbed through in a saved replay", () => {
        const { tick, published } = start({ ...THREE_CARS, WeekendInfo: { TrackID: 42, SimMode: "replay" } });

        driveThenFlagAndPit(tick);

        expect(published()).toEqual([]);
      });

      it("positive control: live, the same ticks announce the flag and the pit entry", () => {
        const { tick, published } = start({ ...THREE_CARS, WeekendInfo: { TrackID: 42, SimMode: "full" } });

        driveThenFlagAndPit(tick);

        expect(published()).toEqual(expect.arrayContaining(["opponentFlag.flagged", "opponentPit.entered"]));
      });
    });
  });

  describe("pit lane", () => {
    it("emits pitLane.entered on off→on transition", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.entered", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: false }));
      controller.__tick(telemetry({ OnPitRoad: true }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"pitLane.entered">;
      expect(ev.event).toBe("pitLane.entered");
      expect(ev.data).toEqual({});
      expect(ev.timestamp).toBeTypeOf("number");
    });

    it("emits pitLane.exited on on→off transition", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.exited", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: true }));
      controller.__tick(telemetry({ OnPitRoad: false }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits pitStall.departed only when still on pit road", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitStall.departed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: true, PlayerCarInPitStall: true }));
      controller.__tick(telemetry({ OnPitRoad: true, PlayerCarInPitStall: false }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits pitLane.approaching once until car is back on track", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.approaching", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Seed on track.
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.OnTrack }));
      // Enter approach zone.
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.AproachingPits }));
      // Still approaching — should not re-fire.
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.AproachingPits }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does not synthesize pitLane.entered / pitStall.entered when the first tick is already in the stall", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const entered = vi.fn();
      const stallEntered = vi.fn();
      bus.subscribe("pitLane.entered", entered);
      bus.subscribe("pitStall.entered", stallEntered);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Reconnect while serviced in the stall — must not replay the
      // entry transitions.
      controller.__tick(telemetry({ OnPitRoad: true, PlayerCarInPitStall: true }));
      controller.__tick(telemetry({ OnPitRoad: true, PlayerCarInPitStall: true }));

      expect(entered).not.toHaveBeenCalled();
      expect(stallEntered).not.toHaveBeenCalled();
    });

    it("does not synthesize pitLane.approaching when the first tick is already in the approach zone", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.approaching", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Reconnect mid-approach — treated like "exiting" so we wait for a
      // full lap back on track before arming again.
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.AproachingPits }));
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.AproachingPits }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("explicit road-course track type still fires pitLane.approaching on approach-zone entry", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ WeekendInfo: { TrackType: "road course" } });
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.approaching", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.OnTrack }));
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.AproachingPits }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("unknown track type falls back to approach-zone entry behaviour", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ WeekendInfo: { TrackType: "asphalt oval" } });
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.approaching", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.OnTrack }));
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.AproachingPits }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("dirt oval: fires pitLane.approaching when the car drives onto pit road", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ WeekendInfo: { TrackType: "dirt oval" } });
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.approaching", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Seed on track, off pit road. The approach zone is bypassed on dirt ovals.
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.OnTrack }));
      // Drive onto pit road (not towed straight into the stall).
      controller.__tick(
        telemetry({ OnPitRoad: true, PlayerCarInPitStall: false, PlayerTrackSurface: TrkLoc.AproachingPits }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("dirt oval: stays silent when the car is teleported straight into the pit stall", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ WeekendInfo: { TrackType: "dirt oval" } });
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.approaching", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Seed on track.
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.OnTrack }));
      // Tow-to-stall: OnPitRoad + InPitStall flip true together and the surface
      // jumps straight to InPitStall — there was nothing to "approach".
      controller.__tick(
        telemetry({ OnPitRoad: true, PlayerCarInPitStall: true, PlayerTrackSurface: TrkLoc.InPitStall }),
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it("dirt oval: does not re-fire on the pit-road exit transition", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ WeekendInfo: { TrackType: "dirt oval" } });
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.approaching", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Seed on track → drive in (fires once) → drive back out (must not re-fire).
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.OnTrack }));
      controller.__tick(
        telemetry({ OnPitRoad: true, PlayerCarInPitStall: false, PlayerTrackSurface: TrkLoc.AproachingPits }),
      );
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.OnTrack }));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("flags", () => {
    it("emits flag.yellow.raised with scope: local on Yellow bit", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("flag.yellow.raised", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionFlags: 0 }));
      controller.__tick(telemetry({ SessionFlags: Flags.Yellow }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"flag.yellow.raised">;
      expect(ev.data.scope).toBe("local");
    });

    it("emits flag.yellow.raised with scope: full on Caution bit", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("flag.yellow.raised", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionFlags: 0 }));
      controller.__tick(telemetry({ SessionFlags: Flags.Caution }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"flag.yellow.raised">;
      expect(ev.data.scope).toBe("full");
    });

    it("emits flag.yellow.cleared after the all-clear has held for the hold window (issue #671)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("flag.yellow.cleared", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionFlags: Flags.Yellow }));
      controller.__tick(telemetry({ SessionFlags: Flags.Yellow }));
      controller.__tick(telemetry({ SessionFlags: 0 }));

      // The drop tick itself stays silent — cleared is only announced after
      // the all-clear has been sustained for the hold window (issue #671).
      expect(handler).not.toHaveBeenCalled();

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + YELLOW_CLEARED_HOLD_MS);
      controller.__tick(telemetry({ SessionFlags: 0 }));
      vi.useRealTimers();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("suppresses blue when green is also active (race start)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const blueHandler = vi.fn();
      const greenHandler = vi.fn();
      bus.subscribe("flag.blue.raised", blueHandler);
      bus.subscribe("flag.green.raised", greenHandler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionFlags: 0 }));
      controller.__tick(telemetry({ SessionFlags: Flags.Green | Flags.Blue }));

      expect(greenHandler).toHaveBeenCalledTimes(1);
      expect(blueHandler).not.toHaveBeenCalled();
    });
  });

  describe("toggles", () => {
    it("emits pitService.toggled when fuel fill flag flips (after debounce)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitService.toggled", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PitSvFlags: 0 }));
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill }));
      // Pit-service toggles are debounced — flush past the window.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 400);
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill }));
      vi.useRealTimers();

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"pitService.toggled">;
      expect(ev.data).toEqual({ service: "fuel", on: true });
    });

    it("coalesces rapid fuel toggles: on→off→on within debounce emits one final state", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitService.toggled", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PitSvFlags: 0 }));
      // User taps fuel rapidly — three observed flips, all within the debounce window.
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill }));
      controller.__tick(telemetry({ PitSvFlags: 0 }));
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill }));

      expect(handler).not.toHaveBeenCalled();

      // Settle past the window with the final state.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 400);
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill }));
      vi.useRealTimers();

      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0]![0] as SimEventOf<"pitService.toggled">).data).toEqual({
        service: "fuel",
        on: true,
      });
    });

    it("suppresses pit-service emits while in pit stall (crew is working)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitService.toggled", handler);
      bus.subscribe("tireService.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // On track, no pit selections — baseline.
      controller.__tick(telemetry({ PitSvFlags: 0 }));

      // Enter the stall. While stationary, iRacing flips the tire bits one
      // by one as each tire swap completes — these are crew progress, not
      // user intent. None of these ticks should emit anything.
      controller.__tick(telemetry({ PlayerCarInPitStall: true, PitSvFlags: 0 }));
      controller.__tick(telemetry({ PlayerCarInPitStall: true, PitSvFlags: PitSvFlags.LFTireChange }));
      controller.__tick(
        telemetry({ PlayerCarInPitStall: true, PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange }),
      );
      controller.__tick(
        telemetry({
          PlayerCarInPitStall: true,
          PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.FuelFill,
        }),
      );

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 1000);
      controller.__tick(
        telemetry({
          PlayerCarInPitStall: true,
          PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.FuelFill,
        }),
      );
      vi.useRealTimers();

      expect(handler).not.toHaveBeenCalled();

      // Depart the stall. Baseline now reflects the post-service state, so a
      // tick with the same flags emits nothing — no spurious "tires off"
      // cascade.
      controller.__tick(
        telemetry({
          PlayerCarInPitStall: false,
          PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.FuelFill,
        }),
      );

      expect(handler).not.toHaveBeenCalled();
    });

    it("stays silent when a fuel toggle is reverted within the debounce window", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitService.toggled", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Baseline: fuel off. User toggles on then back off, all within window.
      controller.__tick(telemetry({ PitSvFlags: 0 }));
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill }));
      controller.__tick(telemetry({ PitSvFlags: 0 }));

      // Settle.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 400);
      controller.__tick(telemetry({ PitSvFlags: 0 }));
      vi.useRealTimers();

      // Final state matches baseline → no emit.
      expect(handler).not.toHaveBeenCalled();
    });

    it("publishes the captured auto-fuel takeover as one pitService.autoFuelSwitched, and no fuel toggle (issue #474)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const toggled = vi.fn();
      const autoFuel = vi.fn();
      bus.subscribe("pitService.toggled", toggled);
      bus.subscribe("pitService.autoFuelSwitched", autoFuel);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // The driver has asked for fuel with auto-fuel off. At pit approach —
      // still off pit road — the sim arms auto-fuel and clears that request in
      // the same tick.
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill, dpFuelAutoFillActive: 0 }));
      controller.__tick(telemetry({ PitSvFlags: 0, dpFuelAutoFillActive: 1 }));
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 400);
      controller.__tick(telemetry({ PitSvFlags: 0, dpFuelAutoFillActive: 1 }));
      vi.useRealTimers();

      expect(toggled).not.toHaveBeenCalled();
      expect(autoFuel).toHaveBeenCalledTimes(1);
      expect((autoFuel.mock.calls[0]![0] as SimEventOf<"pitService.autoFuelSwitched">).data).toEqual({
        on: true,
        refuel: false,
      });
    });

    it("says nothing at all for a fuel flip made while auto-fuel is armed (issue #474)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const toggled = vi.fn();
      const autoFuel = vi.fn();
      const readback = vi.fn();
      bus.subscribe("pitService.toggled", toggled);
      bus.subscribe("pitService.autoFuelSwitched", autoFuel);
      bus.subscribe("pitService.readbackRequested", readback);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PitSvFlags: 0, dpFuelAutoFillActive: 1 }));
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill, dpFuelAutoFillActive: 1 }));
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 400);
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill, dpFuelAutoFillActive: 1 }));
      vi.useRealTimers();

      expect(toggled).not.toHaveBeenCalled();
      expect(autoFuel).not.toHaveBeenCalled();
      expect(readback).not.toHaveBeenCalled();
    });

    it("holds the auto-fuel line until a fuel press settles, then states the real plan (issue #474)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const toggled = vi.fn();
      const autoFuel = vi.fn();
      bus.subscribe("pitService.toggled", toggled);
      bus.subscribe("pitService.autoFuelSwitched", autoFuel);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      vi.useFakeTimers();
      const t0 = Date.now();
      controller.__tick(telemetry({ PitSvFlags: 0, dpFuelAutoFillActive: 0 }));

      // The driver arms auto-fuel, then asks for fuel 100 ms later.
      vi.setSystemTime(t0 + 100);
      controller.__tick(telemetry({ PitSvFlags: 0, dpFuelAutoFillActive: 1 }));
      vi.setSystemTime(t0 + 200);
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill, dpFuelAutoFillActive: 1 }));

      // The switch settles first, with the request still mid-window: silence.
      vi.setSystemTime(t0 + 400);
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill, dpFuelAutoFillActive: 1 }));
      expect(autoFuel).not.toHaveBeenCalled();

      // The request settles: one line, and it says the plan that now stands.
      vi.setSystemTime(t0 + 500);
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.FuelFill, dpFuelAutoFillActive: 1 }));
      vi.useRealTimers();

      expect(toggled).not.toHaveBeenCalled();
      expect(autoFuel).toHaveBeenCalledTimes(1);
      expect((autoFuel.mock.calls[0]![0] as SimEventOf<"pitService.autoFuelSwitched">).data).toEqual({
        on: true,
        refuel: true,
      });
    });

    it("silences the callout but still refreshes the pit-road recap for that flip (issue #474)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const toggled = vi.fn();
      const autoFuel = vi.fn();
      const readback = vi.fn();
      bus.subscribe("pitService.toggled", toggled);
      bus.subscribe("pitService.autoFuelSwitched", autoFuel);
      bus.subscribe("pitService.readbackRequested", readback);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // On pit road with auto-fuel armed and fuel queued, the driver cancels
      // the fuel. No line — but the recap must stop saying "we're taking fuel".
      controller.__tick(telemetry({ OnPitRoad: true, PitSvFlags: PitSvFlags.FuelFill, dpFuelAutoFillActive: 1 }));
      controller.__tick(telemetry({ OnPitRoad: true, PitSvFlags: 0, dpFuelAutoFillActive: 1 }));
      expect(readback).not.toHaveBeenCalled();

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 400);
      controller.__tick(telemetry({ OnPitRoad: true, PitSvFlags: 0, dpFuelAutoFillActive: 1 }));
      vi.useRealTimers();

      expect(toggled).not.toHaveBeenCalled();
      expect(autoFuel).not.toHaveBeenCalled();
      expect(readback).toHaveBeenCalledTimes(1);
      expect((readback.mock.calls[0]![0] as SimEventOf<"pitService.readbackRequested">).data).toEqual({
        reason: "entry-refire",
      });
    });

    it("emits carControl.drsToggled { on: true } on activation", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("carControl.drsToggled", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ DRS_Status: 0 }));
      controller.__tick(telemetry({ DRS_Status: 2 }));

      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0]![0] as SimEventOf<"carControl.drsToggled">).data.on).toBe(true);
    });

    it("emits tireService.changed with added list and current set", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("tireService.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PitSvFlags: 0 }));
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange }));
      // Tire changes are debounced — advance past TIRE_DEBOUNCE_MS and tick
      // again with the same flags to flush.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 600);
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange }));
      vi.useRealTimers();

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"tireService.changed">;
      expect(ev.data.added.sort()).toEqual(["LF", "RF"]);
      expect(ev.data.removed).toEqual([]);
      expect(ev.data.current.sort()).toEqual(["LF", "RF"]);
    });

    it("coalesces a multi-tick side switch into one event (clear-all → set-target)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("tireService.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const allTires =
        PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

      // Seed with all four set, then iRacing's "Lefts" button: clears, then
      // applies lefts in a separate tick. Both happen well within the
      // debounce window so they should NOT each emit an event.
      controller.__tick(telemetry({ PitSvFlags: allTires }));
      controller.__tick(telemetry({ PitSvFlags: 0 }));
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.LRTireChange }));

      expect(handler).not.toHaveBeenCalled();

      // After the debounce window, a tick with the now-stable selection emits.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 600);
      controller.__tick(telemetry({ PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.LRTireChange }));
      vi.useRealTimers();

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"tireService.changed">;
      expect(ev.data.current.sort()).toEqual(["LF", "LR"]);
      expect(ev.data.added).toEqual([]);
      expect(ev.data.removed.sort()).toEqual(["RF", "RR"]);
    });

    it("emits tireService.compoundChanged when PitSvTireCompound flips dry → wet", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("tireService.compoundChanged", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const allTires =
        PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

      // iRacing always force-sets all four tire bits in the same tick as a
      // user-initiated compound flip; the translator gates the
      // compoundChanged emit on that cascade so an isolated compound bit
      // change (e.g. side-effect of clear-tires, issue #484) does NOT
      // mis-fire.
      controller.__tick(telemetry({ PitSvFlags: 0, PitSvTireCompound: 0 }));
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"tireService.compoundChanged">;
      expect(ev.data).toEqual({ from: 0, to: 1 });
    });

    it("emits tireService.compoundChanged when PitSvTireCompound flips wet → dry", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("tireService.compoundChanged", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const allTires =
        PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 0 }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"tireService.compoundChanged">;
      expect(ev.data).toEqual({ from: 1, to: 0 });
    });

    it("suppresses the cascading tireService.changed when compound flips and forces all four tire bits", () => {
      // iRacing flips compound atomically and force-sets all four tire bits
      // in the same tick. The compound voice line is the canonical
      // confirmation; we should NOT also emit a "tires-on-all" change.
      const controller = createMockController();
      const bus = getEventBus();
      const compoundHandler = vi.fn();
      const tireHandler = vi.fn();
      bus.subscribe("tireService.compoundChanged", compoundHandler);
      bus.subscribe("tireService.changed", tireHandler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const allTires =
        PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

      controller.__tick(telemetry({ PitSvFlags: 0, PitSvTireCompound: 0 }));
      // Compound flip + cascading tire-flag set in the same tick.
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));
      // Past the tire debounce — no stale tire-set event should appear.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 600);
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));
      vi.useRealTimers();

      expect(compoundHandler).toHaveBeenCalledTimes(1);
      expect(tireHandler).not.toHaveBeenCalled();
    });

    it("still emits tireService.changed for genuine post-compound tire toggles", () => {
      // After a compound flip absorbs the cascading "all four" baseline,
      // a subsequent user-driven tire deselection (e.g. dropping the rears)
      // must still produce a normal tireService.changed event.
      const controller = createMockController();
      const bus = getEventBus();
      const tireHandler = vi.fn();
      bus.subscribe("tireService.changed", tireHandler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const allTires =
        PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

      controller.__tick(telemetry({ PitSvFlags: 0, PitSvTireCompound: 0 }));
      // Compound flip (suppressed cascading change).
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));
      // User drops the rears.
      controller.__tick(
        telemetry({ PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange, PitSvTireCompound: 1 }),
      );
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 600);
      controller.__tick(
        telemetry({ PitSvFlags: PitSvFlags.LFTireChange | PitSvFlags.RFTireChange, PitSvTireCompound: 1 }),
      );
      vi.useRealTimers();

      expect(tireHandler).toHaveBeenCalledTimes(1);
      const ev = tireHandler.mock.calls[0]![0] as SimEventOf<"tireService.changed">;
      expect(ev.data.current.sort()).toEqual(["LF", "RF"]);
      expect(ev.data.removed.sort()).toEqual(["LR", "RR"]);
    });

    it("suppresses tireService.compoundChanged while in pit stall (crew is working)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("tireService.compoundChanged", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PitSvTireCompound: 0 }));
      // Enter the stall — every tick re-seeds state including compound.
      controller.__tick(telemetry({ PlayerCarInPitStall: true, PitSvTireCompound: 0 }));
      // iRacing flips the compound mid-service; this is crew progress, not user intent.
      controller.__tick(telemetry({ PlayerCarInPitStall: true, PitSvTireCompound: 1 }));

      expect(handler).not.toHaveBeenCalled();
    });

    // Issue #484 — "clear tires" with a non-default compound queued.
    // iRacing resets the compound bit back to the car default in the same
    // tick that all four tire bits clear. That's a side-effect of the
    // clear, not a user-initiated compound flip: emitting
    // tireService.compoundChanged would mis-fire a "switching to dry"
    // callout and would suppress the legitimate "tires cleared" event.
    // The translator distinguishes the two cases by inspecting the
    // post-tick tire bits — `TIRE_FLAGS_MASK` for a real compound flip,
    // `0` for the clear cascade.
    it("issue #484: clearing tires with a non-default compound suppresses compoundChanged and emits tireService.changed", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const compoundHandler = vi.fn();
      const tireHandler = vi.fn();
      bus.subscribe("tireService.compoundChanged", compoundHandler);
      bus.subscribe("tireService.changed", tireHandler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const allTires =
        PitSvFlags.LFTireChange | PitSvFlags.RFTireChange | PitSvFlags.LRTireChange | PitSvFlags.RRTireChange;

      // Seed: dry, no tires queued.
      controller.__tick(telemetry({ PitSvFlags: 0, PitSvTireCompound: 0 }));
      // User switches to wet — compound flips, all four tires force-set.
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));
      // Past the tire debounce so any cascading tireService.changed would
      // have surfaced by now.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 600);
      controller.__tick(telemetry({ PitSvFlags: allTires, PitSvTireCompound: 1 }));

      // Sanity: the genuine compound flip fired exactly once and was the
      // sole tire-related event.
      expect(compoundHandler).toHaveBeenCalledTimes(1);
      expect(tireHandler).not.toHaveBeenCalled();

      // User presses "clear tires". iRacing clears all four tire bits AND
      // resets compound to the car default (0 / dry) in the same tick.
      controller.__tick(telemetry({ PitSvFlags: 0, PitSvTireCompound: 0 }));
      // Past the debounce so the cleared tires surface.
      vi.setSystemTime(Date.now() + 600);
      controller.__tick(telemetry({ PitSvFlags: 0, PitSvTireCompound: 0 }));
      vi.useRealTimers();

      // The clear must NOT count as a second compound flip — the user
      // didn't switch back to dry, the clear reset it as a side-effect.
      expect(compoundHandler).toHaveBeenCalledTimes(1);

      // The clear must produce a tireService.changed with empty current
      // (the "tires cleared" / "skip tires" callout fires off this).
      expect(tireHandler).toHaveBeenCalledTimes(1);
      const ev = tireHandler.mock.calls[0]![0] as SimEventOf<"tireService.changed">;
      expect(ev.data.current).toEqual([]);
      expect(ev.data.removed.sort()).toEqual(["LF", "LR", "RF", "RR"]);
    });
  });

  describe("limiter", () => {
    it("emits limiter.missing on pit road entry without limiter", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("limiter.missing", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: false, Speed: 50 }));
      controller.__tick(telemetry({ OnPitRoad: true, Speed: 50, EngineWarnings: 0 }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits limiter.dropped when limiter turns off while on pit road", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("limiter.dropped", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: false }));
      controller.__tick(telemetry({ OnPitRoad: true, Speed: 20, EngineWarnings: EngineWarnings.PitSpeedLimiter }));
      controller.__tick(telemetry({ OnPitRoad: true, Speed: 20, EngineWarnings: 0 }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("seeds silently when the first tick is already on pit road (replay mid-session)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("limiter.missing", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Replay begins in pit lane with limiter off — must not fire limiter.missing.
      controller.__tick(telemetry({ OnPitRoad: true, Speed: 20, EngineWarnings: 0 }));
      controller.__tick(telemetry({ OnPitRoad: true, Speed: 20, EngineWarnings: 0 }));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("pit speeding (issue #912)", () => {
    const PIT_LIMIT_SESSION = {
      SessionInfo: { Sessions: [{ SessionType: "Race" }] },
      WeekendInfo: { TrackID: 42, TrackPitSpeedLimit: "80.00 kph" },
    };
    /** 80 kph is 22.2 m/s; comfortably over it. */
    const SPEEDING = 30;

    function speedingController(): MockController {
      const controller = createMockController();
      controller.__setSessionInfo(PIT_LIMIT_SESSION);

      return controller;
    }

    it("starts the cue on the very first tick observed while already speeding", () => {
      const controller = speedingController();
      const bus = getEventBus();
      const started = vi.fn();
      bus.subscribe("pitSpeeding.started", started);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // No seeding tick. Unlike the limiter diff above, this one is
      // level-driven: a driver already over the limit when the plugin starts
      // or the SDK reconnects must hear the cue, not be seeded past it.
      controller.__tick(telemetry({ OnPitRoad: true, Speed: SPEEDING }));

      expect(started).toHaveBeenCalledTimes(1);
    });

    it("publishes pitSpeeding.ended on disconnect so the tick loop cannot outlive the session", () => {
      const controller = speedingController();
      const bus = getEventBus();
      const ended = vi.fn();
      bus.subscribe("pitSpeeding.ended", ended);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: true, Speed: SPEEDING }));
      expect(ended).not.toHaveBeenCalled();

      controller.__tick(null, false);

      expect(ended).toHaveBeenCalledTimes(1);
    });

    it("publishes pitSpeeding.ended when entering replay", () => {
      const controller = speedingController();
      const bus = getEventBus();
      const ended = vi.fn();
      bus.subscribe("pitSpeeding.ended", ended);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: true, Speed: SPEEDING }));
      // The replay guard returns before the diffs run, so without the teardown
      // the state would be wiped with the closing edge never emitted.
      controller.__tick(telemetry({ OnPitRoad: true, Speed: SPEEDING, IsReplayPlaying: true }));

      expect(ended).toHaveBeenCalledTimes(1);
    });

    it("publishes pitSpeeding.ended on a session change, then restarts if still speeding", () => {
      const controller = speedingController();
      const bus = getEventBus();
      const started = vi.fn();
      const ended = vi.fn();
      bus.subscribe("pitSpeeding.started", started);
      bus.subscribe("pitSpeeding.ended", ended);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionNum: 0, OnPitRoad: true, Speed: SPEEDING }));
      expect(started).toHaveBeenCalledTimes(1);

      controller.__tick(telemetry({ SessionNum: 1, OnPitRoad: true, Speed: SPEEDING }));

      // The wipe closes the episode, and the same tick's diff reopens it
      // because the condition still holds — a momentary gap in the tick, not
      // a silent loop and not a permanently lost warning.
      expect(ended).toHaveBeenCalledTimes(1);
      expect(started).toHaveBeenCalledTimes(2);
    });

    it("stays silent when the track's pit speed limit cannot be parsed", () => {
      const controller = createMockController();
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42 },
      });
      const bus = getEventBus();
      const started = vi.fn();
      bus.subscribe("pitSpeeding.started", started);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: true, Speed: 200 }));

      expect(started).not.toHaveBeenCalled();
    });
  });

  describe("pit speed limit is a rounded string (issue #1059)", () => {
    /**
     * `WeekendInfo.TrackPitSpeedLimit` is published to two decimals, and at an
     * imperial-native track that string is a CONVERTED value — so parsing it
     * back lands fractionally BELOW the true limit and a car held exactly at
     * the posted limit fires. Recovering the rounding window is not a
     * tolerance; it is reading the number the publisher rounded.
     */
    function sessionWithLimit(limit: string) {
      return {
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42, TrackPitSpeedLimit: limit },
      };
    }

    /** Charlotte publishes 45.00 mph as "72.42 kph"; the true value is 20.1168 m/s. */
    const MPH_45_EXACT_MPS = 45 * 0.44704;

    it("stays silent at the TRUE limit when the published value was rounded down", () => {
      const controller = createMockController();
      controller.__setSessionInfo(sessionWithLimit("72.42 kph"));
      const bus = getEventBus();
      const started = vi.fn();
      bus.subscribe("pitSpeeding.started", started);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // 20.1168 m/s is exactly 45.00 mph. Parsing "72.42" gives 20.116667,
      // so before the fix this speed was "over the limit" and fired.
      controller.__tick(telemetry({ OnPitRoad: true, Speed: MPH_45_EXACT_MPS, EngineWarnings: 0 }));

      expect(started).not.toHaveBeenCalled();
    });

    it("still fires for a car genuinely past the rounding window", () => {
      const controller = createMockController();
      controller.__setSessionInfo(sessionWithLimit("72.42 kph"));
      const bus = getEventBus();
      const started = vi.fn();
      bus.subscribe("pitSpeeding.started", started);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Just OUTSIDE the top of the window: 72.42 + 0.005 is the corrected
      // threshold, so 0.01 km/h beyond it must still fire. Pinning the near
      // boundary rather than a comfortably-over speed is the point — the
      // window is only 0.005 km/h wide, so a loose value proves little.
      controller.__tick(telemetry({ OnPitRoad: true, Speed: (72.42 + 0.005 + 0.01) / 3.6, EngineWarnings: 0 }));

      expect(started).toHaveBeenCalledTimes(1);
    });

    it("leaves an integer-valued limit uncorrected — no blanket margin", () => {
      const controller = createMockController();
      controller.__setSessionInfo(sessionWithLimit("60 kph"));
      const bus = getEventBus();
      const started = vi.fn();
      bus.subscribe("pitSpeeding.started", started);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // With no published decimals we cannot tell an exact 60 from a rounded
      // one, and half a unit would be 0.5 km/h — a blanket grace margin on
      // every car, which is what this whole change refuses. So: no correction,
      // and a hair over the bare value still fires.
      controller.__tick(telemetry({ OnPitRoad: true, Speed: (60 + 0.05) / 3.6, EngineWarnings: 0 }));

      expect(started).toHaveBeenCalledTimes(1);
    });

    it("keeps a published zero indistinguishable from an unparsed limit", () => {
      const controller = createMockController();
      controller.__setSessionInfo(sessionWithLimit("0.00 kph"));
      const bus = getEventBus();
      const started = vi.fn();
      bus.subscribe("pitSpeeding.started", started);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // `pitSpeedLimitMps > 0` is the "limit unknown, stay disarmed" sentinel.
      // Adding the rounding window to a 0 would arm the cue against a ~0
      // threshold and it would fire at walking pace, permanently.
      controller.__tick(telemetry({ OnPitRoad: true, Speed: 20, EngineWarnings: 0 }));

      expect(started).not.toHaveBeenCalled();
    });

    it("leaves a metric-native limit behaving as before — the control case", () => {
      const controller = createMockController();
      controller.__setSessionInfo(sessionWithLimit("60.00 kph"));
      const bus = getEventBus();
      const started = vi.fn();
      bus.subscribe("pitSpeeding.started", started);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Pinned at the boundary rather than comfortably over: 1 kph above the
      // limit would pass even if the window were far wider than intended.
      // "60.00" carries two decimals, so the window IS applied here — the
      // control this test provides is that it stays 0.005 kph wide and does
      // not grow into a blanket margin.
      controller.__tick(telemetry({ OnPitRoad: true, Speed: (60 + 0.006) / 3.6, EngineWarnings: 0 }));

      expect(started).toHaveBeenCalledTimes(1);
    });

    it("stays silent just INSIDE the window of a two-decimal limit", () => {
      const controller = createMockController();
      controller.__setSessionInfo(sessionWithLimit("60.00 kph"));
      const bus = getEventBus();
      const started = vi.fn();
      bus.subscribe("pitSpeeding.started", started);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // The other side of the same boundary. Together the pair pins the window
      // to its intended 0.005 kph in both directions — neither wider nor
      // absent — which one-sided tests cannot do.
      controller.__tick(telemetry({ OnPitRoad: true, Speed: (60 + 0.004) / 3.6, EngineWarnings: 0 }));

      expect(started).not.toHaveBeenCalled();
    });

    it("stays silent exactly at a metric-native limit", () => {
      const controller = createMockController();
      controller.__setSessionInfo(sessionWithLimit("60.00 kph"));
      const bus = getEventBus();
      const started = vi.fn();
      bus.subscribe("pitSpeeding.started", started);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ OnPitRoad: true, Speed: 60 / 3.6, EngineWarnings: 0 }));

      expect(started).not.toHaveBeenCalled();
    });
  });

  describe("flags — cleared", () => {
    it("emits flag.yellow.cleared only when yellow was previously active", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("flag.yellow.cleared", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionFlags: 0 }));
      controller.__tick(telemetry({ SessionFlags: 0 }));

      // A sustained all-clear with NO prior yellow never fires (issue #671:
      // the hold window must not turn "never yellow" into a phantom clear).
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + YELLOW_CLEARED_HOLD_MS);
      controller.__tick(telemetry({ SessionFlags: 0 }));
      vi.useRealTimers();

      expect(handler).not.toHaveBeenCalled();

      controller.__tick(telemetry({ SessionFlags: Flags.Yellow }));
      controller.__tick(telemetry({ SessionFlags: 0 }));

      expect(handler).not.toHaveBeenCalled();

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + YELLOW_CLEARED_HOLD_MS);
      controller.__tick(telemetry({ SessionFlags: 0 }));
      vi.useRealTimers();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("pit approach — suppression", () => {
    it("suppresses approach while exiting pits through the approach zone", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.approaching", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Sequence: on pit road → enter approach zone (exiting) → back on track.
      controller.__tick(telemetry({ OnPitRoad: true, PlayerTrackSurface: TrkLoc.OffTrack }));
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.AproachingPits }));
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.AproachingPits }));
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.OnTrack }));

      expect(handler).not.toHaveBeenCalled();

      // Now a genuine approach — should fire.
      controller.__tick(telemetry({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.AproachingPits }));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("overtake", () => {
    it("emits overtake.completed only after the hold window elapses", async () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("overtake.completed", handler);
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        DriverInfo: { DriverCarIdx: 0 },
      });
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const mockPositions = {
        CarIdxClassPosition: [0],
        CarIdxLapDistPct: [0.5],
        CarIdxLap: [1],
        CarIdxOnPitRoad: [false],
      };

      // Seed at position 5.
      controller.__tick(telemetry({ ...mockPositions, PlayerCarPosition: 5, CarIdxPosition: [5] }));
      // Position improves to 4 — hold timer starts.
      controller.__tick(telemetry({ ...mockPositions, PlayerCarPosition: 4, CarIdxPosition: [4] }));

      expect(handler).not.toHaveBeenCalled();

      // Fast-forward past OVERTAKE_HOLD_MS (3s) via a sustained position.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 3100);
      controller.__tick(telemetry({ ...mockPositions, PlayerCarPosition: 4, CarIdxPosition: [4] }));
      vi.useRealTimers();

      // calculateRacePositions in practice operates on multiple car arrays —
      // this test exercises the hold-time gate, not position resolution.
      // The handler may or may not fire depending on whether calculateRacePositions
      // returns [5] / [4] from our synthetic payload; the key assertion is that
      // it never fires before the hold window elapses.
      expect(handler.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  describe("laps-of-fuel-left crossings (issue #838)", () => {
    it("emits fuel.lapsLeft.crossed on descending mid-lap crossings, once per stint, re-armed by a refuel", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("fuel.lapsLeft.crossed", handler);
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        DriverInfo: { DriverCarIdx: 0 },
      });
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Build two validated laps (~2 L / ~90 s each) through the real #465
      // tracker: each boundary pairs the LapDistPct wrap with the Lap counter
      // increment. Fuel stays high enough that every mid-lap sample sits above
      // the 10-count ceiling — silent.
      controller.__tick(telemetry({ Lap: 1, LapDistPct: 0.9, SessionTime: 0, FuelLevel: 64 }));
      controller.__tick(telemetry({ Lap: 2, LapDistPct: 0.05, SessionTime: 5, FuelLevel: 63.9 }));
      controller.__tick(telemetry({ Lap: 2, LapDistPct: 0.55, SessionTime: 45, FuelLevel: 63 }));
      controller.__tick(telemetry({ Lap: 2, LapDistPct: 0.9, SessionTime: 80, FuelLevel: 62.2 }));
      controller.__tick(telemetry({ Lap: 3, LapDistPct: 0.05, SessionTime: 90, FuelLevel: 62 }));
      controller.__tick(telemetry({ Lap: 3, LapDistPct: 0.55, SessionTime: 135, FuelLevel: 61 }));
      controller.__tick(telemetry({ Lap: 3, LapDistPct: 0.9, SessionTime: 170, FuelLevel: 60.2 }));
      controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.05, SessionTime: 180, FuelLevel: 60 }));
      expect(handler).not.toHaveBeenCalled();

      // Fuel is suddenly low: the mid-lap sample computes
      // floor(4.9/1.95 − 0.3 − 0.45) = 1 → "1 lap of fuel left".
      controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.45, SessionTime: 200, FuelLevel: 5.0 }));
      controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.55, SessionTime: 210, FuelLevel: 4.9 }));
      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0]![0] as SimEventOf<"fuel.lapsLeft.crossed">).data.count).toBe(1);

      // Rolling back and forth across the mid-lap mark on the SAME lap never
      // re-samples.
      controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.45, SessionTime: 215, FuelLevel: 4.85 }));
      controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.55, SessionTime: 220, FuelLevel: 4.8 }));
      expect(handler).toHaveBeenCalledTimes(1);

      // Next lap the estimate reads below zero laps → the box-this-lap call
      // (count 0) — the only remaining descending crossing.
      controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.9, SessionTime: 255, FuelLevel: 4.6 }));
      controller.__tick(telemetry({ Lap: 5, LapDistPct: 0.05, SessionTime: 265, FuelLevel: 4.5 }));
      controller.__tick(telemetry({ Lap: 5, LapDistPct: 0.55, SessionTime: 310, FuelLevel: 4.4 }));
      expect(handler).toHaveBeenCalledTimes(2);
      expect((handler.mock.calls[1]![0] as SimEventOf<"fuel.lapsLeft.crossed">).data.count).toBe(0);

      // A refuel re-arms the stint: the next mid-lap sample announces again.
      controller.__tick(telemetry({ Lap: 5, LapDistPct: 0.6, SessionTime: 320, FuelLevel: 40 }));
      controller.__tick(telemetry({ Lap: 5, LapDistPct: 0.9, SessionTime: 350, FuelLevel: 39.8 }));
      controller.__tick(telemetry({ Lap: 6, LapDistPct: 0.05, SessionTime: 360, FuelLevel: 39.7 }));
      controller.__tick(telemetry({ Lap: 6, LapDistPct: 0.55, SessionTime: 405, FuelLevel: 38 }));
      expect(handler).toHaveBeenCalledTimes(3);
      expect((handler.mock.calls[2]![0] as SimEventOf<"fuel.lapsLeft.crossed">).data.count).toBe(1);
    });

    // Timed-race coverage (issue #880) end-to-end through the REAL leader
    // resolver: the leader comes from the canonical live order and their
    // CarIdxLastLapTime feeds the estimate. The two cases differ ONLY in the
    // leader's pace, so a resolver that silently fell back to the player's
    // own average would flip one of them.
    function runTimedRaceToSample(leaderLastLapTime: number) {
      const controller = createMockController();
      const bus = getEventBus();
      const crossed = vi.fn();
      const covered = vi.fn();
      bus.subscribe("fuel.lapsLeft.crossed", crossed);
      bus.subscribe("fuel.lapsLeft.raceCovered", covered);
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        DriverInfo: { DriverCarIdx: 0 },
      });
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Leader (carIdx 1) runs two laps ahead of the player (carIdx 0).
      const field = (playerLap: number, playerPct: number): Partial<TelemetryData> => ({
        CarIdxLapCompleted: [playerLap - 1, playerLap + 1],
        CarIdxLapDistPct: [playerPct, playerPct],
        CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack],
        CarIdxLastLapTime: [88, leaderLastLapTime],
        CarIdxBestLapTime: [87, leaderLastLapTime],
      });

      // Two validated ~87.5 s laps through the real #465 tracker.
      controller.__tick(telemetry({ Lap: 1, LapDistPct: 0.9, SessionTime: 0, FuelLevel: 64, ...field(1, 0.9) }));
      controller.__tick(telemetry({ Lap: 2, LapDistPct: 0.05, SessionTime: 5, FuelLevel: 63.9, ...field(2, 0.05) }));
      controller.__tick(telemetry({ Lap: 2, LapDistPct: 0.55, SessionTime: 45, FuelLevel: 63, ...field(2, 0.55) }));
      controller.__tick(telemetry({ Lap: 2, LapDistPct: 0.9, SessionTime: 80, FuelLevel: 62.2, ...field(2, 0.9) }));
      controller.__tick(telemetry({ Lap: 3, LapDistPct: 0.05, SessionTime: 90, FuelLevel: 62, ...field(3, 0.05) }));
      controller.__tick(telemetry({ Lap: 3, LapDistPct: 0.55, SessionTime: 135, FuelLevel: 61, ...field(3, 0.55) }));
      controller.__tick(telemetry({ Lap: 3, LapDistPct: 0.9, SessionTime: 170, FuelLevel: 60.2, ...field(3, 0.9) }));
      controller.__tick(telemetry({ Lap: 4, LapDistPct: 0.05, SessionTime: 180, FuelLevel: 60, ...field(4, 0.05) }));

      // Mid-lap sample: ~5 s on the clock, count 2 in the tank
      // (floor(6.9/1.95 − 0.3 − 0.45) = 2). SessionLapsRemainEx reads the
      // timed sentinel, so only the timed estimate can suppress.
      controller.__tick(
        telemetry({
          Lap: 4,
          LapDistPct: 0.45,
          SessionTime: 200,
          FuelLevel: 7.0,
          SessionTimeRemain: 6,
          SessionLapsRemainEx: 32767,
          ...field(4, 0.45),
        }),
      );
      controller.__tick(
        telemetry({
          Lap: 4,
          LapDistPct: 0.55,
          SessionTime: 210,
          FuelLevel: 6.9,
          SessionTimeRemain: 5,
          SessionLapsRemainEx: 32767,
          ...field(4, 0.55),
        }),
      );

      return { crossed, covered };
    }

    it("suppresses and reassures when the LEADER's pace says the clock ends the race within the tank (issue #880)", () => {
      // Fast leader (60 s): checkered bound 5 + 2×60 = 125 s →
      // ceil((125 − 39.4) / 87.5) = 1 lap to run; count 2 covers it with a
      // lap in hand, so the confirmation fires.
      const { crossed, covered } = runTimedRaceToSample(60);

      expect(crossed).not.toHaveBeenCalled();
      expect(covered).toHaveBeenCalledTimes(1);
    });

    it("keeps warning when the LEADER's slow pace stretches the timed race past the tank (issue #880)", () => {
      // Slow leader (200 s): checkered bound 5 + 2×200 = 405 s →
      // ceil((405 − 39.4) / 87.5) = 5 laps to run; count 2 falls short — the
      // warning must still fire. A resolver that fell back to the player's
      // 87.5 s average would wrongly suppress.
      const { crossed, covered } = runTimedRaceToSample(200);

      expect(crossed).toHaveBeenCalledTimes(1);
      expect(covered).not.toHaveBeenCalled();
    });
  });

  describe("incidents and off-track", () => {
    it("emits offTrack.started and offTrack.ended around an excursion", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const started = vi.fn();
      const ended = vi.fn();
      bus.subscribe("offTrack.started", started);
      bus.subscribe("offTrack.ended", ended);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.OnTrack }));
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.OffTrack }));
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.OnTrack }));

      expect(started).toHaveBeenCalledTimes(1);
      expect(ended).toHaveBeenCalledTimes(1);
    });

    it("emits incident.occurred when PlayerCarMyIncidentCount increments", () => {
      vi.useFakeTimers();
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("incident.occurred", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepOffTrack }));

      // Burst-coalesce window: nothing fires until the quiet window elapses.
      expect(handler).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1500);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1 }));
      expect(handler).toHaveBeenCalledTimes(1);
      const data = (handler.mock.calls[0]![0] as SimEventOf<"incident.occurred">).data;
      expect(data).toEqual({ delta: 1, points: 1, type: "off-track" });
    });

    it("publishes incident.scored before incident.occurred on the same flush, each dispatched to completion (issue #1122)", () => {
      // The end-to-end order the qualifying lap-invalidation callout rests on:
      // its fire, on `incident.scored`, must hold the Voice bus before the
      // incident contracts hear `incident.occurred`. So the first event's
      // handlers must all have RETURNED before the second is published — a
      // subscriber that records the other event's arrival inside its own
      // handler proves it.
      vi.useFakeTimers();
      const controller = createMockController();
      const bus = getEventBus();
      const order: string[] = [];
      let occurredSeenInsideScored = false;
      bus.subscribe("incident.occurred", () => order.push("occurred"));
      bus.subscribe("incident.scored", (ev) => {
        occurredSeenInsideScored = order.includes("occurred");
        order.push(`scored:${(ev as SimEventOf<"incident.scored">).data.delta}`);
      });
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepOffTrack }));
      vi.advanceTimersByTime(1500);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1 }));

      expect(order).toEqual(["scored:1", "occurred"]);
      expect(occurredSeenInsideScored).toBe(false);
    });

    it("publishes a damage edge that settled during the burst after the burst's incident events, on the flush tick (issue #1211)", () => {
      // The incident line plays first, then the damage line: the damage diff
      // runs after the incident diff and holds its settled edge until the
      // open burst flushes.
      vi.useFakeTimers();
      const controller = createMockController();
      const bus = getEventBus();
      const order: string[] = [];
      bus.subscribe("incident.scored", () => order.push("scored"));
      bus.subscribe("incident.occurred", () => order.push("occurred"));
      bus.subscribe("damage.repairNeeded.raised", () => order.push("damage"));
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const damaged = EngineWarnings.MandRepNeeded;
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      controller.__tick(telemetry({ EngineWarnings: damaged }));
      vi.advanceTimersByTime(2_800);
      controller.__tick(
        telemetry({
          EngineWarnings: damaged,
          PlayerCarMyIncidentCount: 4,
          PlayerIncidents: IncidentFlags.RepCollisionWithCar,
        }),
      );
      // Damage settles 200 ms into the burst.
      vi.advanceTimersByTime(200);
      controller.__tick(telemetry({ EngineWarnings: damaged, PlayerCarMyIncidentCount: 4 }));
      expect(order).toEqual([]);

      // Flush: 1500 ms after the increment.
      vi.advanceTimersByTime(1_300);
      controller.__tick(telemetry({ EngineWarnings: damaged, PlayerCarMyIncidentCount: 4 }));

      expect(order).toEqual(["scored", "occurred", "damage"]);
    });

    it("publishes incident.scored alone for a counted burst it could not type (issue #1122)", () => {
      vi.useFakeTimers();
      const controller = createMockController();
      const bus = getEventBus();
      const scored = vi.fn();
      const occurred = vi.fn();
      bus.subscribe("incident.scored", scored);
      bus.subscribe("incident.occurred", occurred);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1, PlayerIncidents: 0 }));
      vi.advanceTimersByTime(1500);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1 }));

      expect(scored).toHaveBeenCalledTimes(1);
      expect((scored.mock.calls[0]![0] as SimEventOf<"incident.scored">).data).toEqual({ delta: 1 });
      expect(occurred).not.toHaveBeenCalled();
    });

    it("coalesces a multi-step incident burst into a single emission with the most-recent type", () => {
      vi.useFakeTimers();
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("incident.occurred", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // A typical iRacing crash arrives as a stream of count increments over
      // a few hundred ms, each the MARGINAL upgrade toward the sequence's
      // worst outcome (#938 capture): off-track +1, out-of-control +1
      // (2 − 1), car collision +2 (4 − 2). Without coalescing each step
      // would fire its own callout — three lines on top of each other.
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      // off-track first (1x)
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepOffTrack }));
      vi.advanceTimersByTime(200);
      // upgraded to out-of-control (2x total) shortly after
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 2, PlayerIncidents: IncidentFlags.RepOutOfControl }));
      vi.advanceTimersByTime(200);
      // upgraded to a car collision (4x total) — the worst classification last
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 4, PlayerIncidents: IncidentFlags.RepCollisionWithCar }));

      // Still inside the burst window — no emit yet.
      expect(handler).not.toHaveBeenCalled();

      // Quiet window elapses; one emit with the most recent type and its
      // Sporting Code value as the spoken points.
      vi.advanceTimersByTime(1500);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 4 }));
      expect(handler).toHaveBeenCalledTimes(1);
      const data = (handler.mock.calls[0]![0] as SimEventOf<"incident.occurred">).data;
      expect(data).toEqual({ delta: 4, points: 4, type: "collision-car" });
    });

    it("treats two incidents separated by more than the quiet window as separate emissions", () => {
      vi.useFakeTimers();
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("incident.occurred", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepOffTrack }));
      // Quiet window elapses → first burst flushes.
      vi.advanceTimersByTime(1600);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1 }));
      expect(handler).toHaveBeenCalledTimes(1);

      // Second incident much later — second burst.
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 5, PlayerIncidents: IncidentFlags.RepCollisionWithCar }));
      vi.advanceTimersByTime(1600);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 5 }));

      expect(handler).toHaveBeenCalledTimes(2);
      const first = (handler.mock.calls[0]![0] as SimEventOf<"incident.occurred">).data;
      const second = (handler.mock.calls[1]![0] as SimEventOf<"incident.occurred">).data;
      expect(first).toEqual({ delta: 1, points: 1, type: "off-track" });
      expect(second).toEqual({ delta: 4, points: 4, type: "collision-car" });
    });

    it("suppresses incident.occurred when PlayerIncidents is zero or unknown", () => {
      vi.useFakeTimers();
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("incident.occurred", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Count bumps but the report byte is RepNoReport — stay silent so a
      // future iRacing-side type addition doesn't get an unclassified callout.
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1, PlayerIncidents: 0 }));
      // Ongoing variant — iRacing's header notes it is never sent, but if it
      // ever does arrive we still suppress it.
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 2, PlayerIncidents: IncidentFlags.RepOffTrackOngoing }));

      // Even after the burst window elapses, nothing fires — no resolved type.
      vi.advanceTimersByTime(1500);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 2 }));
      expect(handler).not.toHaveBeenCalled();
    });

    it("does not synthesize offTrack.started when the first tick starts off-track (mid-excursion reconnect)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const started = vi.fn();
      bus.subscribe("offTrack.started", started);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Reconnect while the car is already off track — no real transition
      // happened, so the translator must seed quietly.
      controller.__tick(telemetry({ IsOnTrack: true, PlayerTrackSurface: TrkLoc.OffTrack }));
      controller.__tick(telemetry({ IsOnTrack: true, PlayerTrackSurface: TrkLoc.OffTrack }));

      expect(started).not.toHaveBeenCalled();
    });

    it("emits offTrack.ended when returning to track after a mid-excursion seed", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const ended = vi.fn();
      bus.subscribe("offTrack.ended", ended);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ IsOnTrack: true, PlayerTrackSurface: TrkLoc.OffTrack }));
      controller.__tick(telemetry({ IsOnTrack: true, PlayerTrackSurface: TrkLoc.OnTrack }));

      expect(ended).toHaveBeenCalledTimes(1);
    });
  });

  describe("radar", () => {
    it("emits radar.changed with from/to states", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("radar.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ CarLeftRight: CarLeftRight.Off }));
      controller.__tick(telemetry({ CarLeftRight: CarLeftRight.CarLeft }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"radar.changed">;
      expect(ev.data).toEqual({ from: "clear", to: "left" });
    });

    it("publishes a radar.changed → clear teardown signal on disconnect when radar was active", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("radar.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Seed → active left.
      controller.__tick(telemetry({ CarLeftRight: CarLeftRight.Off }));
      controller.__tick(telemetry({ CarLeftRight: CarLeftRight.CarLeft }));

      expect(handler).toHaveBeenCalledTimes(1);

      // Disconnect — translator must emit a radar.changed → clear so the
      // radar engine stops its tick loop. Otherwise the last callout keeps
      // looping after iRacing exits.
      controller.__tick(null, false);

      expect(handler).toHaveBeenCalledTimes(2);
      const teardown = handler.mock.calls[1]![0] as SimEventOf<"radar.changed">;
      expect(teardown.data).toEqual({ from: "left", to: "clear" });
    });

    it("does not publish a teardown signal when disconnecting with radar already clear", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("radar.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ CarLeftRight: CarLeftRight.Off }));
      controller.__tick(null, false);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("lifecycle events", () => {
    it("emits driver.firstOnTrack on the first on-track tick", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("driver.firstOnTrack", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ IsOnTrack: false }));
      controller.__tick(telemetry({ IsOnTrack: true }));
      controller.__tick(telemetry({ IsOnTrack: true }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits engine.startup on RPM 0 → >threshold", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("engine.startup", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ RPM: 0 }));
      controller.__tick(telemetry({ RPM: 1200 }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits lap.started when Lap increments", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("lap.started", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ Lap: 1 }));
      controller.__tick(telemetry({ Lap: 2 }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"lap.started">;
      expect(ev.data.lap).toBe(2);
    });

    it("emits session.changed when SessionNum delta occurs", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("session.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionNum: 0 }));
      controller.__tick(telemetry({ SessionNum: 1 }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"session.changed">;
      expect(ev.data).toEqual({ from: 0, to: 1 });
    });

    // Issue #568 follow-up: iRacing's qualifying → race transition typically
    // passes through replay-mode ticks (session-loading screen). The replay
    // guard in `handleTick` wipes `state` on the IsReplayPlaying edge, which
    // used to clear `state.lastSessionNum` and cause `diffLifecycle` to
    // re-seed on the next non-replay tick instead of emitting `session.changed`.
    // The race-start callout depends on this event, so it must survive the
    // replay-mode transition.
    it("emits session.changed even when SessionNum advances on a replay-mode tick", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("session.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Tick 1: qualifying live.
      controller.__tick(telemetry({ SessionNum: 1, IsReplayPlaying: false, IsOnTrack: true }));
      // Tick 2: iRacing flips into the session-loading state (replay mode)
      // AND advances SessionNum on the same tick.
      controller.__tick(telemetry({ SessionNum: 2, IsReplayPlaying: true, IsOnTrack: false }));
      // Tick 3: still in replay while the next session loads.
      controller.__tick(telemetry({ SessionNum: 2, IsReplayPlaying: true, IsOnTrack: false }));
      // Tick 4: race goes live.
      controller.__tick(telemetry({ SessionNum: 2, IsReplayPlaying: false, IsOnTrack: false }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"session.changed">;
      expect(ev.data).toEqual({ from: 1, to: 2 });
    });

    it("does not double-emit session.changed on a non-replay session transition", () => {
      // The handleTick-level emit pre-sets `state.lastSessionNum` to the new
      // value to prevent diffLifecycle from emitting the same delta on the
      // same tick. This test pins that dedup.
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("session.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: false }));
      controller.__tick(telemetry({ SessionNum: 1, IsReplayPlaying: false }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    // Issue #604: while the user is in iRacing's replay UI
    // (`WeekendInfo.SimMode === "replay"`), session.changed must not fire —
    // scrubbing across a saved replay's session boundary would brief a race
    // the driver isn't in. The discriminator is iRacing's own SimMode field
    // rather than `IsReplayPlaying`, which transiently flips true during a
    // live qual → race transition (#568) and would otherwise mis-suppress
    // genuine live transitions.
    describe("replay-only session gate (issue #604)", () => {
      it("does NOT emit session.changed on SessionNum delta in replay-only mode", () => {
        const controller = createMockController();
        controller.__setSessionInfo({
          SessionInfo: { Sessions: [{ SessionType: "Race" }, { SessionType: "Race" }] },
          WeekendInfo: { TrackID: 42, SimMode: "replay" },
        });
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        // Seed the tracker, then scrub the replay across a session boundary.
        controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: true, IsOnTrack: false }));
        controller.__tick(telemetry({ SessionNum: 1, IsReplayPlaying: true, IsOnTrack: false }));

        expect(handler).not.toHaveBeenCalled();
      });

      it("does NOT synthesize session.changed on fresh-connect in replay-only mode", () => {
        // Plugin connects while a saved race replay is open. SessionState is
        // pre-green (in the replay frame) and SessionType is Race — the
        // synthesis would fire without the replay-only gate.
        const controller = createMockController();
        controller.__setSessionInfo({
          SessionInfo: { Sessions: [{ SessionType: "Race" }] },
          WeekendInfo: { TrackID: 42, SimMode: "replay" },
        });
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        controller.__tick(
          telemetry({ SessionNum: 0, SessionState: SessionState.GetInCar, IsReplayPlaying: true, IsOnTrack: false }),
        );

        expect(handler).not.toHaveBeenCalled();
      });

      it("does not latch the fresh-connect check while replay-only — fires later when SimMode flips to full", () => {
        // Scenario: user opens a replay, plugin connects, then user closes
        // the replay and starts a real race session. The fresh-connect
        // synthesis must still fire once SimMode goes back to "full".
        const controller = createMockController();
        controller.__setSessionInfo({
          SessionInfo: { Sessions: [{ SessionType: "Race" }] },
          WeekendInfo: { TrackID: 42, SimMode: "replay" },
        });
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        // Tick 1: replay-only, no synthesis.
        controller.__tick(
          telemetry({ SessionNum: 0, SessionState: SessionState.GetInCar, IsReplayPlaying: true, IsOnTrack: false }),
        );
        expect(handler).not.toHaveBeenCalled();

        // User exits the replay UI; SimMode flips back to "full".
        controller.__setSessionInfo({
          SessionInfo: { Sessions: [{ SessionType: "Race" }] },
          WeekendInfo: { TrackID: 42, SimMode: "full" },
        });
        controller.__tick(
          telemetry({ SessionNum: 0, SessionState: SessionState.GetInCar, IsReplayPlaying: false, IsOnTrack: false }),
        );
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]![0].data).toEqual({ from: -1, to: 0 });
      });

      it("freezes lastObservedSessionNum during replay so exit-to-live emits no phantom session.changed", () => {
        // Driver is live in qualifying (SessionNum=1), opens the replay UI,
        // scrubs back into practice (SessionNum=0), then exits to live (still
        // SessionNum=1). The phantom we're guarding against would be the
        // exit-tick seeing currentSessionNum=1 vs lastObservedSessionNum=0
        // and emitting session.changed { from: 0, to: 1 } — race-start
        // briefing a race the driver still isn't in.
        const controller = createMockController();
        // Start live.
        controller.__setSessionInfo({
          SessionInfo: { Sessions: [{ SessionType: "Practice" }, { SessionType: "Open Qualify" }] },
          WeekendInfo: { TrackID: 42, SimMode: "full" },
        });
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        // Tick 1: live in qualifying. Seeds lastObservedSessionNum=1.
        controller.__tick(telemetry({ SessionNum: 1, IsReplayPlaying: false, IsOnTrack: true }));
        expect(handler).not.toHaveBeenCalled();

        // Tick 2-3: user opens replay UI and scrubs back to practice.
        controller.__setSessionInfo({
          SessionInfo: { Sessions: [{ SessionType: "Practice" }, { SessionType: "Open Qualify" }] },
          WeekendInfo: { TrackID: 42, SimMode: "replay" },
        });
        controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: true, IsOnTrack: false }));
        controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: true, IsOnTrack: false }));

        // Tick 4: user exits replay UI; back to live in qualifying.
        controller.__setSessionInfo({
          SessionInfo: { Sessions: [{ SessionType: "Practice" }, { SessionType: "Open Qualify" }] },
          WeekendInfo: { TrackID: 42, SimMode: "full" },
        });
        controller.__tick(telemetry({ SessionNum: 1, IsReplayPlaying: false, IsOnTrack: true }));

        // No emit — lastObservedSessionNum was frozen at 1 during the scrub,
        // so the exit-tick sees no delta.
        expect(handler).not.toHaveBeenCalled();
      });

      it("still emits session.changed on a real live transition through the IsReplayPlaying flicker (#568 regression guard)", () => {
        // A live qual → race transition briefly reports IsReplayPlaying=true
        // while the next session loads. SimMode stays "full" the whole time,
        // so the gate must not suppress the emit.
        const controller = createMockController();
        controller.__setSessionInfo({
          SessionInfo: { Sessions: [{ SessionType: "Open Qualify" }, { SessionType: "Race" }] },
          WeekendInfo: { TrackID: 42, SimMode: "full" },
        });
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        controller.__tick(telemetry({ SessionNum: 1, IsReplayPlaying: false, IsOnTrack: true }));
        // Transient replay tick during session load.
        controller.__tick(telemetry({ SessionNum: 2, IsReplayPlaying: true, IsOnTrack: false }));
        // Race goes live.
        controller.__tick(telemetry({ SessionNum: 2, IsReplayPlaying: false, IsOnTrack: false }));

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]![0].data).toEqual({ from: 1, to: 2 });
      });

      // Issue #908: while the fresh-connect check stays unlatched in a
      // replay-only session, the deliberate no-latch behavior means the gate
      // re-evaluates on every tick — but the skip must be LOGGED once per
      // replay episode, not per tick (~60 INFO lines/s otherwise). The gate's
      // synthesis/latch behavior is unchanged.
      describe("once-per-episode replay-skip logging (issue #908)", () => {
        const REPLAY_SESSION_INFO = {
          SessionInfo: { Sessions: [{ SessionType: "Race" }] },
          WeekendInfo: { TrackID: 42, SimMode: "replay" },
        };
        const LIVE_SESSION_INFO = {
          SessionInfo: { Sessions: [{ SessionType: "Race" }] },
          WeekendInfo: { TrackID: 42, SimMode: "full" },
        };

        function replayTick(controller: MockController): void {
          controller.__tick(
            telemetry({ SessionNum: 0, SessionState: SessionState.GetInCar, IsReplayPlaying: true, IsOnTrack: false }),
          );
        }

        function replaySkipLogCount(logger: ILogger): number {
          return vi.mocked(logger.info).mock.calls.filter((call) => String(call[0]).includes("replay-only session"))
            .length;
        }

        it("logs the replay-only skip once across many replay-only ticks", () => {
          const controller = createMockController();
          controller.__setSessionInfo(REPLAY_SESSION_INFO);
          const logger = createMockLogger();
          initializeSimEventsIracing(getEventBus(), controller, logger);

          for (let i = 0; i < 5; i++) replayTick(controller);

          expect(replaySkipLogCount(logger)).toBe(1);
        });

        it("re-logs the skip when a new replay episode begins after a non-replay tick", () => {
          const controller = createMockController();
          controller.__setSessionInfo(REPLAY_SESSION_INFO);
          const bus = getEventBus();
          const handler = vi.fn();
          bus.subscribe("session.changed", handler);
          const logger = createMockLogger();
          initializeSimEventsIracing(bus, controller, logger);

          // Episode 1: two replay-only ticks — one log line.
          replayTick(controller);
          replayTick(controller);
          expect(replaySkipLogCount(logger)).toBe(1);

          // Live tick with telemetry still settling — SessionState.Invalid
          // keeps the fresh-connect latch open (no fire), so a later replay
          // episode re-evaluates the gate.
          controller.__setSessionInfo(LIVE_SESSION_INFO);
          controller.__tick(
            telemetry({ SessionNum: 0, SessionState: SessionState.Invalid, IsReplayPlaying: false, IsOnTrack: false }),
          );
          expect(handler).not.toHaveBeenCalled();

          // Episode 2: back into the replay UI — logs again, once.
          controller.__setSessionInfo(REPLAY_SESSION_INFO);
          replayTick(controller);
          replayTick(controller);
          expect(replaySkipLogCount(logger)).toBe(2);
        });

        it("re-logs the skip after a non-replay tick that carries no SessionNum", () => {
          // A live tick whose telemetry lacks SessionNum never enters the
          // fresh-connect gate, but it still ends the replay episode — the
          // marker must reset so the next replay episode logs again.
          const controller = createMockController();
          controller.__setSessionInfo(REPLAY_SESSION_INFO);
          const logger = createMockLogger();
          initializeSimEventsIracing(getEventBus(), controller, logger);

          // Episode 1: two replay-only ticks — one log line.
          replayTick(controller);
          replayTick(controller);
          expect(replaySkipLogCount(logger)).toBe(1);

          // Live tick with no SessionNum — skips the fresh-connect gate.
          controller.__setSessionInfo(LIVE_SESSION_INFO);
          controller.__tick(telemetry({ SessionNum: undefined, IsReplayPlaying: false, IsOnTrack: false }));

          // Episode 2: back into the replay UI — logs again.
          controller.__setSessionInfo(REPLAY_SESSION_INFO);
          replayTick(controller);
          expect(replaySkipLogCount(logger)).toBe(2);
        });

        it("logs again after a disconnect re-arms the fresh-connect check", () => {
          const controller = createMockController();
          controller.__setSessionInfo(REPLAY_SESSION_INFO);
          const logger = createMockLogger();
          initializeSimEventsIracing(getEventBus(), controller, logger);

          // Episode 1: two replay-only ticks — one log line.
          replayTick(controller);
          replayTick(controller);

          // Disconnect resets the fresh-connect check; the reconnect into a
          // still-open replay is a new episode and logs again.
          controller.__tick(null, false);
          replayTick(controller);
          replayTick(controller);

          expect(replaySkipLogCount(logger)).toBe(2);
        });

        // Regression guard for the unchanged no-latch behavior: many
        // replay-only ticks stay silent, and the first live tick still fires
        // the synthesis.
        it("still fires the synthesis on the first live tick after many replay-only ticks", () => {
          const controller = createMockController();
          controller.__setSessionInfo(REPLAY_SESSION_INFO);
          const bus = getEventBus();
          const handler = vi.fn();
          bus.subscribe("session.changed", handler);
          initializeSimEventsIracing(bus, controller, createMockLogger());

          for (let i = 0; i < 5; i++) replayTick(controller);

          expect(handler).not.toHaveBeenCalled();

          controller.__setSessionInfo(LIVE_SESSION_INFO);
          controller.__tick(
            telemetry({ SessionNum: 0, SessionState: SessionState.GetInCar, IsReplayPlaying: false, IsOnTrack: false }),
          );

          expect(handler).toHaveBeenCalledTimes(1);
          expect(handler.mock.calls[0]![0].data).toEqual({ from: -1, to: 0 });
        });
      });
    });

    // Fresh-connect session.changed synthesis (issues #568, #668). When the
    // plugin connects directly into a session there's no prior SessionNum to
    // drive a delta, so the callouts keyed off `session.changed` would never
    // fire. The translator synthesizes `session.changed { from: -1, to: N }`
    // on the first tick that satisfies the gating conditions. Two consumers:
    // race-start (#568, race sessions, pre-green only) and session-start
    // (#668, practice/qualifying, pre-green OR during green — those sessions
    // sit in `Racing` their whole green period and connecting mid-session is
    // the normal case, so the conditions brief is exactly what the driver
    // wants on connect).
    describe("fresh-connect session.changed synthesis", () => {
      const RACE_SESSION_INFO = {
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42 },
      };
      const PRACTICE_SESSION_INFO = {
        SessionInfo: { Sessions: [{ SessionType: "Practice" }] },
        WeekendInfo: { TrackID: 42 },
      };
      const QUALIFY_SESSION_INFO = {
        SessionInfo: { Sessions: [{ SessionType: "Open Qualify" }] },
        WeekendInfo: { TrackID: 42 },
      };

      it.each([
        ["GetInCar", SessionState.GetInCar],
        ["Warmup", SessionState.Warmup],
        ["ParadeLaps", SessionState.ParadeLaps],
      ] as const)("synthesizes session.changed when SessionState=%s on fresh-connect race", (_label, state) => {
        const controller = createMockController();
        controller.__setSessionInfo(RACE_SESSION_INFO);
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        controller.__tick(telemetry({ SessionNum: 0, SessionState: state }));

        expect(handler).toHaveBeenCalledTimes(1);
        const ev = handler.mock.calls[0]![0] as SimEventOf<"session.changed">;
        expect(ev.data).toEqual({ from: -1, to: 0 });
      });

      it.each([
        ["Racing", SessionState.Racing],
        ["Checkered", SessionState.Checkered],
        ["CoolDown", SessionState.CoolDown],
      ] as const)("does NOT synthesize when SessionState=%s (mid-race reconnect)", (_label, state) => {
        const controller = createMockController();
        controller.__setSessionInfo(RACE_SESSION_INFO);
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        controller.__tick(telemetry({ SessionNum: 0, SessionState: state }));

        expect(handler).not.toHaveBeenCalled();
      });

      // #568 regression guard: a race session at/after green is a mid-race
      // reconnect — the synthesis must latch silently (no fire now, no fire on
      // later ticks). This is the boundary the #668 change must NOT cross for
      // race sessions.
      it("does NOT synthesize on fresh-connect to race at Racing, and latches (no later fire)", () => {
        const controller = createMockController();
        controller.__setSessionInfo(RACE_SESSION_INFO);
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.Racing }));
        expect(handler).not.toHaveBeenCalled();

        // Latched: a later pre-green tick (same SessionNum) must not re-open it.
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.GetInCar }));
        expect(handler).not.toHaveBeenCalled();
      });

      it("waits while SessionState=Invalid then fires on the first pre-green tick", () => {
        const controller = createMockController();
        controller.__setSessionInfo(RACE_SESSION_INFO);
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        // Telemetry settling: SessionState=Invalid for a few ticks.
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.Invalid }));
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.Invalid }));
        expect(handler).not.toHaveBeenCalled();

        // SessionState settles to GetInCar — synthesis fires.
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.GetInCar }));
        expect(handler).toHaveBeenCalledTimes(1);
      });

      // #668: connecting into a practice/qualifying session synthesizes the
      // session.changed too, so the session-start conditions brief plays for
      // the first session after connect (e.g. a lone-qualify driver sitting in
      // the garage). These sessions fire pre-green AND during green (Racing) —
      // they sit in `Racing` their whole green period.
      it.each([
        ["GetInCar", SessionState.GetInCar],
        ["Warmup", SessionState.Warmup],
        ["ParadeLaps", SessionState.ParadeLaps],
        ["Racing", SessionState.Racing],
      ] as const)("synthesizes session.changed when SessionState=%s on fresh-connect qualifying", (_label, state) => {
        const controller = createMockController();
        controller.__setSessionInfo(QUALIFY_SESSION_INFO);
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        controller.__tick(telemetry({ SessionNum: 0, SessionState: state }));

        expect(handler).toHaveBeenCalledTimes(1);
        const ev = handler.mock.calls[0]![0] as SimEventOf<"session.changed">;
        expect(ev.data).toEqual({ from: -1, to: 0 });
      });

      it.each([
        ["GetInCar", SessionState.GetInCar],
        ["Warmup", SessionState.Warmup],
        ["ParadeLaps", SessionState.ParadeLaps],
        ["Racing", SessionState.Racing],
      ] as const)("synthesizes session.changed when SessionState=%s on fresh-connect practice", (_label, state) => {
        const controller = createMockController();
        controller.__setSessionInfo(PRACTICE_SESSION_INFO);
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        controller.__tick(telemetry({ SessionNum: 0, SessionState: state }));

        expect(handler).toHaveBeenCalledTimes(1);
        const ev = handler.mock.calls[0]![0] as SimEventOf<"session.changed">;
        expect(ev.data).toEqual({ from: -1, to: 0 });
      });

      it("synthesizes once for a practice session at Racing, then latches (no duplicate on later ticks)", () => {
        const controller = createMockController();
        controller.__setSessionInfo(PRACTICE_SESSION_INFO);
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        // Connect mid-practice (Racing) — fires.
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.Racing }));
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]![0].data).toEqual({ from: -1, to: 0 });

        // Latched: subsequent ticks on the same session don't re-fire.
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.Racing }));
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.Racing }));
        expect(handler).toHaveBeenCalledTimes(1);
      });

      // #668: a practice/qualifying session winding down (Checkered/CoolDown)
      // means the brief is pointless — latch silently, same as a mid-race
      // reconnect.
      it.each([
        ["Checkered", SessionState.Checkered],
        ["CoolDown", SessionState.CoolDown],
      ] as const)("does NOT synthesize on fresh-connect to practice at %s (session winding down)", (_label, state) => {
        const controller = createMockController();
        controller.__setSessionInfo(PRACTICE_SESSION_INFO);
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        controller.__tick(telemetry({ SessionNum: 0, SessionState: state }));
        expect(handler).not.toHaveBeenCalled();

        // Latched: a later pre-green tick (same SessionNum) must not re-open it.
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.GetInCar }));
        expect(handler).not.toHaveBeenCalled();
      });

      it("waits while a practice session reports SessionState=Invalid, then fires once it settles", () => {
        const controller = createMockController();
        controller.__setSessionInfo(PRACTICE_SESSION_INFO);
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        // Telemetry settling: SessionState=Invalid for a few ticks — no latch.
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.Invalid }));
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.Invalid }));
        expect(handler).not.toHaveBeenCalled();

        // Settles to Racing (practice's green state) — synthesis fires.
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.Racing }));
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]![0].data).toEqual({ from: -1, to: 0 });
      });

      // CodeRabbit #579: classifySessionType("") returns "race", so an
      // unresolved session type (no session YAML yet) must NOT be treated as
      // race — otherwise a non-race fresh connect would emit a false synthetic
      // session.changed. The latch must stay open until the raw type is known.
      it("does NOT synthesize when the raw session type is empty (session info not loaded)", () => {
        const controller = createMockController();
        // No __setSessionInfo → resolveSessionType returns "".
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.GetInCar }));

        expect(handler).not.toHaveBeenCalled();
      });

      it("waits while the raw session type is empty, then synthesizes once it resolves to race", () => {
        const controller = createMockController();
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        // First tick: session info not loaded yet (raw type ""). Latch open.
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.GetInCar }));
        expect(handler).not.toHaveBeenCalled();

        // Session YAML loads — now a race session. Synthesis fires.
        controller.__setSessionInfo({
          SessionInfo: { Sessions: [{ SessionType: "Race" }] },
          WeekendInfo: { TrackID: 42 },
        });
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.GetInCar }));
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]![0].data).toEqual({ from: -1, to: 0 });
      });

      it("does not fire twice when synthesis fires and a later SessionNum delta also fires", () => {
        // E.g. a hosted multi-race event where the plugin connects into race 1
        // (synthesis fires) and later the lobby advances to race 2 (real delta
        // fires). Each should produce exactly one event.
        const controller = createMockController();
        controller.__setSessionInfo({
          SessionInfo: { Sessions: [{ SessionType: "Race" }, { SessionType: "Race" }] },
          WeekendInfo: { TrackID: 42 },
        });
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        // Fresh-connect into race 1 — synthesis fires.
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.GetInCar }));
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]![0].data).toEqual({ from: -1, to: 0 });

        // Lobby advances to race 2 — real delta fires.
        controller.__tick(telemetry({ SessionNum: 1, SessionState: SessionState.GetInCar }));
        expect(handler).toHaveBeenCalledTimes(2);
        expect(handler.mock.calls[1]![0].data).toEqual({ from: 0, to: 1 });
      });

      // #668: disconnect → reconnect must re-arm the fresh-connect synthesis so
      // the second connect fires a second synthetic session.changed.
      it("re-arms and fires a second synthetic session.changed after disconnect → reconnect (practice)", () => {
        const controller = createMockController();
        controller.__setSessionInfo(PRACTICE_SESSION_INFO);
        const bus = getEventBus();
        const handler = vi.fn();
        bus.subscribe("session.changed", handler);
        initializeSimEventsIracing(bus, controller, createMockLogger());

        // First connect into practice at Racing — synthesis fires and latches.
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.Racing }));
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]![0].data).toEqual({ from: -1, to: 0 });

        // Disconnect — re-arms freshConnectFireChecked.
        controller.__tick(null, false);

        // Reconnect into the same practice session at Racing — synthesis fires again.
        controller.__tick(telemetry({ SessionNum: 0, SessionState: SessionState.Racing }));
        expect(handler).toHaveBeenCalledTimes(2);
        expect(handler.mock.calls[1]![0].data).toEqual({ from: -1, to: 0 });
      });
    });

    it("does not synthesize engine.startup when the first tick already has RPM > threshold", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("engine.startup", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Reconnecting while the engine is already running is not a startup.
      controller.__tick(telemetry({ RPM: 3500 }));
      controller.__tick(telemetry({ RPM: 3600 }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("does not synthesize driver.firstOnTrack when the first tick is already on-track", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("driver.firstOnTrack", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Reconnect mid-session with the driver already on track — the
      // once-per-session event must not re-fire.
      controller.__tick(telemetry({ IsOnTrack: true }));
      controller.__tick(telemetry({ IsOnTrack: true }));

      expect(handler).not.toHaveBeenCalled();
    });

    // Issue #542 regression: joining a session leaves iRacing in replay
    // (`IsReplayPlaying: true`, `IsOnTrack: false`) until the driver clicks
    // "Drive". The fire must land on the replay → live-on-track transition,
    // not be swallowed by the replay guard's per-tick state reset.
    it("emits driver.firstOnTrack on the replay → live-on-track transition", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("driver.firstOnTrack", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // In the session menu / garage: iRacing is in replay, not on track.
      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: false }));
      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: false }));
      // Driver clicks "Drive" — replay ends and the car is on track. Inside
      // the exit grace (#1324) the tick is still the replay's: a seek's
      // IsReplayPlaying blip must not read as a drive-out.
      controller.__tick(telemetry({ IsReplayPlaying: false, IsOnTrack: true }));
      expect(handler).not.toHaveBeenCalled();

      elapseReplayGrace();
      controller.__tick(telemetry({ IsReplayPlaying: false, IsOnTrack: true }));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does not fire driver.firstOnTrack while still in replay, even if a replay frame is on-track", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("driver.firstOnTrack", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // A replay frame can have IsOnTrack true, but the driver isn't live.
      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: true }));
      controller.__tick(telemetry({ IsReplayPlaying: true, IsOnTrack: true }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("fires driver.firstOnTrack only once across a car → exit → car cycle", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("driver.firstOnTrack", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: true, IsOnTrack: false }));
      elapseReplayGrace();
      controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: false, IsOnTrack: true })); // drive out — fires
      controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: true, IsOnTrack: false })); // back to garage
      elapseReplayGrace();
      controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: false, IsOnTrack: true })); // drive out again

      // Same session throughout — no re-fire across garage cycles.
      expect(handler).toHaveBeenCalledTimes(1);
    });

    // Issue #564: session-start callout must re-fire when SessionNum changes
    // (practice → qualifying → race), even though it stays single-fire within
    // a session. Three scenarios cover the bug end-to-end.

    it("re-fires driver.firstOnTrack when SessionNum changes mid-drive", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("driver.firstOnTrack", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Practice: on track, callout fires.
      controller.__tick(telemetry({ SessionNum: 0, IsOnTrack: false }));
      controller.__tick(telemetry({ SessionNum: 0, IsOnTrack: true }));
      expect(handler).toHaveBeenCalledTimes(1);

      // Qualifying starts while still on track — must re-fire.
      controller.__tick(telemetry({ SessionNum: 1, IsOnTrack: true }));
      expect(handler).toHaveBeenCalledTimes(2);

      // Race starts — must re-fire again.
      controller.__tick(telemetry({ SessionNum: 2, IsOnTrack: true }));
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it("re-fires driver.firstOnTrack on the replay → live-on-track transition that follows a session change", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("driver.firstOnTrack", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Practice: drive out, callout fires.
      controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: true, IsOnTrack: false }));
      elapseReplayGrace();
      controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: false, IsOnTrack: true }));
      expect(handler).toHaveBeenCalledTimes(1);

      // Practice ends → iRacing returns to replay/menu, then qualifying starts.
      // The SessionNum delta arrives on a replay-mode tick (the realistic path:
      // user is in the session-load screen when the number flips).
      controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: true, IsOnTrack: false }));
      controller.__tick(telemetry({ SessionNum: 1, IsReplayPlaying: true, IsOnTrack: false }));
      expect(handler).toHaveBeenCalledTimes(1); // still in replay — no fire yet

      // Driver clicks Drive in qualifying — fires on the live-on-track edge.
      elapseReplayGrace();
      controller.__tick(telemetry({ SessionNum: 1, IsReplayPlaying: false, IsOnTrack: true }));
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("still publishes session.changed on the tick that triggers the session reset", () => {
      // The instance-level session-num tracker drives the state wipe, but the
      // bus event must keep firing through `diffLifecycle` so external
      // subscribers (scenario harness, future consumers) keep working. The
      // reset preserves `state.lastSessionNum` exactly for this reason.
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("session.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ SessionNum: 0 }));
      controller.__tick(telemetry({ SessionNum: 1 }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"session.changed">;
      expect(ev.data).toEqual({ from: 0, to: 1 });
    });

    it("publishes radar.changed → clear when SessionNum changes with radar active", () => {
      // Mirrors the `handleDisconnect` teardown contract: a downstream radar
      // audio engine latched on the prior session's "left"/"right" beep
      // would stay latched if the reset wiped `radarState` without emitting
      // the clear edge first. Covers the replay-mode session-transition path
      // explicitly because that's where the bug bites — the replay guard's
      // own teardown check would see the already-cleared state and skip.
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("radar.changed", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Practice: car appears on the left, radar emits left.
      controller.__tick(telemetry({ SessionNum: 0, CarLeftRight: CarLeftRight.Off }));
      controller.__tick(telemetry({ SessionNum: 0, CarLeftRight: CarLeftRight.CarLeft }));
      expect(handler).toHaveBeenCalledTimes(1);
      const activate = handler.mock.calls[0]![0] as SimEventOf<"radar.changed">;
      expect(activate.data).toEqual({ from: "clear", to: "left" });

      // Session flips to qualifying on a replay-mode tick (the path that
      // would otherwise swallow the teardown). The reset must fire the clear
      // edge before wiping state so the audio engine stops the beep.
      controller.__tick(telemetry({ SessionNum: 1, IsReplayPlaying: true, CarLeftRight: CarLeftRight.CarLeft }));
      expect(handler).toHaveBeenCalledTimes(2);
      const teardown = handler.mock.calls[1]![0] as SimEventOf<"radar.changed">;
      expect(teardown.data).toEqual({ from: "left", to: "clear" });
    });

    it("wipes per-session diff state on SessionNum change so the next tick re-seeds", () => {
      // Sanity check that the reset isn't limited to `firstOnTrackFired` —
      // representative per-session state must clear too. We use the toggles
      // diff: it tracks `lastP2PActive` and emits `carControl.p2pToggled` only
      // on a rising edge. If practice ended with P2P active, the reset must
      // let qualifying re-emit on a fresh rising edge instead of suppressing
      // it as "unchanged".
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("carControl.p2pToggled", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Practice: P2P off → on (rising edge fires once).
      controller.__tick(telemetry({ SessionNum: 0, P2P_Status: false }));
      controller.__tick(telemetry({ SessionNum: 0, P2P_Status: true }));
      expect(handler).toHaveBeenCalledTimes(1);

      // Session changes to qualifying. The toggles diff's `lastP2PActive` was
      // `true` at the moment of the change; the reset wipes it back to `false`
      // (toggleStateInitialized: false), so the first qual tick re-seeds and
      // the next rising edge fires fresh.
      controller.__tick(telemetry({ SessionNum: 1, P2P_Status: false })); // re-seed in qual
      controller.__tick(telemetry({ SessionNum: 1, P2P_Status: true })); // rising edge in qual
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("does not synthesize lap.started when Lap resets to a lower number (session flip)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("lap.started", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // End of practice on lap 12, then race starts at lap 1.
      controller.__tick(telemetry({ Lap: 12 }));
      controller.__tick(telemetry({ Lap: 1 }));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("qualifying-invalidation snapshot (issues #567 / #776)", () => {
    const QUAL_SESSION_INFO = {
      SessionInfo: { Sessions: [{ SessionType: "Lone Qualify" }] },
    };

    function qualController(): MockController {
      const controller = createMockController();
      controller.__setSessionInfo(QUAL_SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      return controller;
    }

    it("returns null before any telemetry tick", () => {
      qualController();

      expect(getQualifyingInvalidationSnapshot()).toBeNull();
    });

    it("reports a counted flying lap with attempts remaining after the current one", () => {
      const controller = qualController();

      // 2-lap qualifying, first flying lap: iRacing counts the current lap
      // as remaining (SessionLapsRemainEx = 2), the snapshot contract is
      // "attempts AFTER the current invalidated lap" → 1.
      controller.__tick(telemetry({ SessionLapsTotal: 2, SessionLapsRemainEx: 2, LapCompleted: 1 }));

      expect(getQualifyingInvalidationSnapshot()).toEqual({
        sessionType: "qualifying",
        sessionNum: 0,
        lapsRemaining: 1,
        lapLimited: true,
        lapCompleted: 1,
        lapStartedFromPits: false,
        lapCounted: true,
      });
    });

    it("keeps the final counted lap counted with lapsRemaining 0", () => {
      const controller = qualController();

      // 2-lap qualifying, second flying lap (SessionLapsRemainEx = 1): a
      // real attempt with nothing left after it — the out-of-laps case.
      controller.__tick(telemetry({ SessionLapsTotal: 2, SessionLapsRemainEx: 1, LapCompleted: 2 }));

      expect(getQualifyingInvalidationSnapshot()).toMatchObject({
        lapsRemaining: 0,
        lapCounted: true,
      });
    });

    it("flags a lap beyond the counted attempts as not counted (issue #776)", () => {
      const controller = qualController();

      // Lap 3 of a 2-lap qualifying: SessionLapsRemainEx hit 0 — not even
      // the current lap is a counted attempt. Before #776 this collapsed
      // into lapsRemaining 0 (indistinguishable from the final counted lap).
      controller.__tick(telemetry({ SessionLapsTotal: 2, SessionLapsRemainEx: 0, LapCompleted: 3 }));

      expect(getQualifyingInvalidationSnapshot()).toMatchObject({
        lapsRemaining: 0,
        lapCounted: false,
      });
    });

    it("treats time-limited qualifying as counted", () => {
      const controller = qualController();

      // 32767 is iRacing's "unlimited" sentinel → time-limited session.
      controller.__tick(telemetry({ SessionLapsTotal: 32767, SessionLapsRemainEx: 32767, LapCompleted: 4 }));

      expect(getQualifyingInvalidationSnapshot()).toMatchObject({
        lapsRemaining: undefined,
        lapLimited: false,
        lapCounted: true,
      });
    });

    it("treats missing SessionLapsRemainEx as counted (don't punish missing data)", () => {
      const controller = qualController();

      controller.__tick(telemetry({ SessionLapsTotal: 2, SessionLapsRemainEx: -1, LapCompleted: 1 }));

      expect(getQualifyingInvalidationSnapshot()).toMatchObject({
        lapsRemaining: undefined,
        lapCounted: true,
      });
    });
  });

  describe("session-start conditions (issue #542)", () => {
    const SESSION_INFO = {
      SessionInfo: { Sessions: [{ SessionType: "Race" }] },
      WeekendInfo: { TrackID: 42, TrackPitSpeedLimit: "80.00 kph" },
    };

    it("returns null before any telemetry tick", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      expect(getSessionStartConditions()).toBeNull();
    });

    it("returns null when session info is unavailable", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getSessionStartConditions()).toBeNull();
    });

    it("reports wetness null (snapshot kept) while track wetness is still Unknown", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Unknown, TrackTempCrew: 25, AirTemp: 18 }));

      const conditions = getSessionStartConditions();

      expect(conditions).not.toBeNull();
      expect(conditions?.wetness).toBeNull();
      expect(conditions?.trackTemp).toBe(25);
      expect(conditions?.airTemp).toBe(18);
    });

    it("reports wetness null when TrackWetness is out of range", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: 99, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getSessionStartConditions()?.wetness).toBeNull();
    });

    it("reports wetness null for a non-integer TrackWetness, which no clip names", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: 2.5, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getSessionStartConditions()?.wetness).toBeNull();
    });

    it("reports trackTemp null when TrackTempCrew is missing, keeping the other fields", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, AirTemp: 18 }));

      const conditions = getSessionStartConditions();

      expect(conditions?.trackTemp).toBeNull();
      expect(conditions?.airTemp).toBe(18);
      expect(conditions?.wetness).toBe(TrackWetness.Dry);
    });

    it("reports airTemp null when AirTemp is not finite, keeping the other fields", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: Number.NaN }));

      const conditions = getSessionStartConditions();

      expect(conditions?.airTemp).toBeNull();
      expect(conditions?.trackTemp).toBe(25);
      expect(conditions?.wetness).toBe(TrackWetness.Dry);
    });

    it("resolves metric conditions (km/h, Celsius) and rounds temps", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(
        telemetry({
          DisplayUnits: 1,
          TrackWetness: TrackWetness.MostlyDry,
          TrackTempCrew: 28.4,
          AirTemp: 19.6,
        }),
      );

      expect(getSessionStartConditions()).toEqual({
        sessionType: "race",
        pitSpeedLimit: 80,
        speedUnit: "kmh",
        trackTemp: 28,
        airTemp: 20,
        tempUnit: "celsius",
        wetness: TrackWetness.MostlyDry,
      });
    });

    it("converts to imperial (mph, Fahrenheit) when DisplayUnits is English", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(
        telemetry({
          DisplayUnits: 0,
          TrackWetness: TrackWetness.Dry,
          TrackTempCrew: 28,
          AirTemp: 20,
        }),
      );

      // 80 km/h ≈ 49.7 mph → 50; 28 °C → 82.4 °F → 82; 20 °C → 68 °F.
      expect(getSessionStartConditions()).toEqual({
        sessionType: "race",
        pitSpeedLimit: 50,
        speedUnit: "mph",
        trackTemp: 82,
        airTemp: 68,
        tempUnit: "fahrenheit",
        wetness: TrackWetness.Dry,
      });
    });

    it("defaults to metric when DisplayUnits is absent", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      const conditions = getSessionStartConditions();
      expect(conditions?.speedUnit).toBe("kmh");
      expect(conditions?.tempUnit).toBe("celsius");
    });

    it.each([
      ["Practice", "practice"],
      ["Lone Practice", "practice"],
      ["Offline Testing", "practice"],
      ["Open Qualify", "qualifying"],
      ["Lone Qualify", "qualifying"],
      ["Race", "race"],
      ["Warmup", "race"],
    ] as const)("classifies %s as %s", (sessionType, expected) => {
      const controller = createMockController();
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: sessionType }] },
        WeekendInfo: { TrackID: 42, TrackPitSpeedLimit: "80.00 kph" },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getSessionStartConditions()?.sessionType).toBe(expected);
    });
  });

  describe("race-start conditions (issue #568)", () => {
    // Helper: build a sessionInfo fixture with the player at the given grid
    // position (1-indexed). The starting grid comes from
    // `QualifyResultsInfo.Results`, where `Position` is 0-indexed in iRacing's
    // session YAML (pole = 0). The translator converts to 1-indexed so the
    // audio scenario can speak "P 1" / "P 2" / … directly.
    function sessionInfoWithGridPosition(humanPosition: number) {
      return {
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42, TrackPitSpeedLimit: "80.00 kph" },
        DriverInfo: { DriverCarIdx: 0 },
        QualifyResultsInfo: { Results: [{ CarIdx: 0, Position: humanPosition - 1 }] },
      };
    }

    const SESSION_INFO_P7 = sessionInfoWithGridPosition(7);

    it("returns null before any telemetry tick", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO_P7);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      expect(getRaceStartConditions()).toBeNull();
    });

    it("returns null when session info is unavailable", () => {
      const controller = createMockController();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getRaceStartConditions()).toBeNull();
    });

    it("reports wetness null (snapshot kept) while track wetness is still Unknown", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO_P7);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Unknown, TrackTempCrew: 25, AirTemp: 18 }));

      const conditions = getRaceStartConditions();

      expect(conditions).not.toBeNull();
      expect(conditions?.wetness).toBeNull();
      expect(conditions?.trackTemp).toBe(25);
      expect(conditions?.airTemp).toBe(18);
    });

    it("reports wetness null when TrackWetness is out of range", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO_P7);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: 99, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getRaceStartConditions()?.wetness).toBeNull();
    });

    it("reports wetness null for a non-integer TrackWetness, which no clip names", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO_P7);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: 2.5, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getRaceStartConditions()?.wetness).toBeNull();
    });

    it("reports trackTemp null when TrackTempCrew is missing, keeping the other fields", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO_P7);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, AirTemp: 18 }));

      const conditions = getRaceStartConditions();

      expect(conditions?.trackTemp).toBeNull();
      expect(conditions?.airTemp).toBe(18);
      expect(conditions?.wetness).toBe(TrackWetness.Dry);
    });

    it("reports airTemp null when AirTemp is not finite, keeping the other fields", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO_P7);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: Number.NaN }));

      const conditions = getRaceStartConditions();

      expect(conditions?.airTemp).toBeNull();
      expect(conditions?.trackTemp).toBe(25);
      expect(conditions?.wetness).toBe(TrackWetness.Dry);
    });

    it("resolves metric conditions (Celsius) and reads grid position from QualifyResultsInfo", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO_P7);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(
        telemetry({
          DisplayUnits: 1,
          TrackWetness: TrackWetness.MostlyDry,
          TrackTempCrew: 28.4,
          AirTemp: 19.6,
        }),
      );

      expect(getRaceStartConditions()).toEqual({
        trackTemp: 28,
        airTemp: 20,
        tempUnit: "celsius",
        wetness: TrackWetness.MostlyDry,
        playerCarPosition: 7,
      });
    });

    it("converts to Fahrenheit when DisplayUnits is English", () => {
      const controller = createMockController();
      controller.__setSessionInfo(sessionInfoWithGridPosition(1));
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(
        telemetry({
          DisplayUnits: 0,
          TrackWetness: TrackWetness.Dry,
          TrackTempCrew: 28,
          AirTemp: 20,
        }),
      );

      // 28 °C → 82.4 °F → 82; 20 °C → 68 °F.
      expect(getRaceStartConditions()).toEqual({
        trackTemp: 82,
        airTemp: 68,
        tempUnit: "fahrenheit",
        wetness: TrackWetness.Dry,
        playerCarPosition: 1,
      });
    });

    it("reports playerCarPosition as undefined when QualifyResultsInfo is absent (still loading)", () => {
      const controller = createMockController();
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42 },
        DriverInfo: { DriverCarIdx: 0 },
        // No QualifyResultsInfo.
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(
        telemetry({
          TrackWetness: TrackWetness.Dry,
          TrackTempCrew: 25,
          AirTemp: 18,
        }),
      );

      expect(getRaceStartConditions()?.playerCarPosition).toBeUndefined();
    });

    it("reports playerCarPosition as undefined when the player's CarIdx is missing from results", () => {
      const controller = createMockController();
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42 },
        DriverInfo: { DriverCarIdx: 99 },
        QualifyResultsInfo: { Results: [{ CarIdx: 0, Position: 1 }] },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getRaceStartConditions()?.playerCarPosition).toBeUndefined();
    });

    it("ignores telemetry.PlayerCarPosition (which reads 0 in the garage / pre-grid)", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO_P7);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      // Real-world pre-grid: telemetry.PlayerCarPosition reads 0, but the
      // grid position from QualifyResultsInfo (P7) is what we want to speak.
      controller.__tick(
        telemetry({
          TrackWetness: TrackWetness.Dry,
          TrackTempCrew: 25,
          AirTemp: 18,
          PlayerCarPosition: 0,
        }),
      );

      expect(getRaceStartConditions()?.playerCarPosition).toBe(7);
    });

    it("converts raw Position=0 (pole, 0-indexed) to P1 (1-indexed)", () => {
      const controller = createMockController();
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42 },
        DriverInfo: { DriverCarIdx: 0 },
        QualifyResultsInfo: { Results: [{ CarIdx: 0, Position: 0 }] },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getRaceStartConditions()?.playerCarPosition).toBe(1);
    });

    it("reports playerCarPosition as undefined when raw Position is negative (no-result sentinel)", () => {
      const controller = createMockController();
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42 },
        DriverInfo: { DriverCarIdx: 0 },
        QualifyResultsInfo: { Results: [{ CarIdx: 0, Position: -1 }] },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getRaceStartConditions()?.playerCarPosition).toBeUndefined();
    });

    it("does not include sessionType in the snapshot (scenario gates on getSessionType separately)", () => {
      const controller = createMockController();
      controller.__setSessionInfo(sessionInfoWithGridPosition(5));
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      const conditions = getRaceStartConditions();
      expect(conditions).not.toBeNull();
      expect(conditions && "sessionType" in conditions).toBe(false);
    });

    it("reports the CLASS grid slot in a multi-class race, not the overall qualifying position (issue #599)", () => {
      const controller = createMockController();
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42 },
        DriverInfo: {
          DriverCarIdx: 0,
          Drivers: [
            { CarIdx: 0, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 }, // player
            { CarIdx: 1, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 2, CarClassID: 20, CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 3, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 4, CarClassID: 20, CarIsPaceCar: 0, IsSpectator: 0 },
          ],
        },
        // Overall qualifying order (0-indexed Position). The player (CarIdx 0)
        // is overall P5, but only two same-class cars (CarIdx 1 @ overall P1,
        // CarIdx 3 @ overall P3) start ahead of them in class → class P3.
        QualifyResultsInfo: {
          Results: [
            { CarIdx: 0, Position: 4 },
            { CarIdx: 1, Position: 0 },
            { CarIdx: 2, Position: 1 },
            { CarIdx: 3, Position: 2 },
            { CarIdx: 4, Position: 3 },
          ],
        },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getRaceStartConditions()?.playerCarPosition).toBe(3);
    });

    it("reports class pole (P1) when the player is first in their class but not overall in multi-class (issue #599)", () => {
      const controller = createMockController();
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42 },
        DriverInfo: {
          DriverCarIdx: 0,
          Drivers: [
            { CarIdx: 0, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 }, // player
            { CarIdx: 1, CarClassID: 20, CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 2, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 },
          ],
        },
        // The player is overall P2 (a faster-class car qualified ahead), but
        // first in their own class → class pole, P1.
        QualifyResultsInfo: {
          Results: [
            { CarIdx: 1, Position: 0 },
            { CarIdx: 0, Position: 1 },
            { CarIdx: 2, Position: 2 },
          ],
        },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getRaceStartConditions()?.playerCarPosition).toBe(1);
    });

    it("falls back to the overall qualifying slot in multi-class when the player has no Drivers entry (issue #599)", () => {
      const controller = createMockController();
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42 },
        DriverInfo: {
          DriverCarIdx: 0,
          // Two classes make this multi-class, but the player's own CarClassID
          // can't be resolved (CarIdx 0 absent from Drivers) → fall back to the
          // overall grid slot rather than guess a class slot.
          Drivers: [
            { CarIdx: 1, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 2, CarClassID: 20, CarIsPaceCar: 0, IsSpectator: 0 },
          ],
        },
        QualifyResultsInfo: {
          Results: [
            { CarIdx: 1, Position: 0 },
            { CarIdx: 0, Position: 1 },
            { CarIdx: 2, Position: 2 },
          ],
        },
      });
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Dry, TrackTempCrew: 25, AirTemp: 18 }));

      // Overall P2 (Position 1 + 1) — class slot unresolvable, so keep overall.
      expect(getRaceStartConditions()?.playerCarPosition).toBe(2);
    });
  });

  describe("envelope shape", () => {
    it("every published event carries event, timestamp, telemetry, data", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("pitLane.entered", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      const t = telemetry({ OnPitRoad: false });
      controller.__tick(t);
      const t2 = telemetry({ OnPitRoad: true, Lap: 5 });
      controller.__tick(t2);

      const ev = handler.mock.calls[0]![0] as SimEventOf<"pitLane.entered">;
      expect(ev.event).toBe("pitLane.entered");
      expect(typeof ev.timestamp).toBe("number");
      expect(ev.telemetry).toBe(t2);
      expect(ev.data).toEqual({});
    });
  });

  describe("lap.completed — multi-class detection + ResultsPositions (issue #566)", () => {
    // ResultsPositions ClassPosition is 0-indexed (the leader's ClassPosition
    // is 0). The translator-side resolver passes it through raw; the diff
    // converts to 1-indexed when populating the payload.
    function singleClassSessionInfo(playerLapsComplete: number, playerPosition: number): Record<string, unknown> {
      return {
        SessionInfo: {
          Sessions: [
            {
              SessionNum: 0,
              SessionType: "Race",
              ResultsPositions: [
                {
                  CarIdx: 0,
                  Position: playerPosition,
                  ClassPosition: playerPosition - 1,
                  LapsComplete: playerLapsComplete,
                },
              ],
            },
          ],
        },
        DriverInfo: {
          DriverCarIdx: 0,
          Drivers: [
            { CarIdx: 0, CarClassID: 0, CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 1, CarClassID: 0, CarIsPaceCar: 0, IsSpectator: 0 },
          ],
        },
      };
    }

    function multiClassSessionInfo(
      playerLapsComplete: number,
      playerPosition: number,
      playerClassPosition: number,
    ): Record<string, unknown> {
      return {
        SessionInfo: {
          Sessions: [
            {
              SessionNum: 0,
              SessionType: "Race",
              ResultsPositions: [
                {
                  CarIdx: 0,
                  Position: playerPosition,
                  ClassPosition: playerClassPosition - 1, // 0-indexed on the wire
                  LapsComplete: playerLapsComplete,
                },
              ],
            },
          ],
        },
        DriverInfo: {
          DriverCarIdx: 0,
          Drivers: [
            { CarIdx: 0, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 1, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 2, CarClassID: 20, CarIsPaceCar: 0, IsSpectator: 0 },
            // Pace car must be filtered — sharing a CarClassID isn't valid signal.
            { CarIdx: 3, CarClassID: -1, CarIsPaceCar: 1, IsSpectator: 0 },
          ],
        },
      };
    }

    it("emits isMultiClass=false with position from ResultsPositions in a single-class field", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("lap.completed", handler);
      // Standings reflect the lap the driver is about to complete.
      controller.__setSessionInfo(singleClassSessionInfo(/* playerLapsComplete */ 1, /* playerPosition */ 5));
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Seed tick.
      controller.__tick(telemetry({ LapCompleted: 0, LapLastLapTime: 0 }));
      // Lap completion — ResultsPositions already has LapsComplete=1 so the
      // sync gate passes immediately and the diff emits without waiting.
      controller.__tick(telemetry({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"lap.completed">;
      expect(ev.data.isMultiClass).toBe(false);
      expect(ev.data.position).toBe(5);
      expect(ev.data.classPosition).toBe(5);
    });

    it("emits isMultiClass=true with class position from ResultsPositions (+1 for 0-indexed convert)", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("lap.completed", handler);
      controller.__setSessionInfo(
        multiClassSessionInfo(/* playerLapsComplete */ 1, /* playerPosition */ 4, /* playerClassPosition */ 1),
      );
      initializeSimEventsIracing(bus, controller, createMockLogger());

      controller.__tick(telemetry({ LapCompleted: 0, LapLastLapTime: 0 }));
      controller.__tick(telemetry({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }));

      expect(handler).toHaveBeenCalledTimes(1);
      const ev = handler.mock.calls[0]![0] as SimEventOf<"lap.completed">;
      expect(ev.data.isMultiClass).toBe(true);
      expect(ev.data.position).toBe(4);
      expect(ev.data.classPosition).toBe(1);
    });
  });

  // Issue #829: the standing-start numeric countdown is the "get in the car"
  // reminder, so it must be emitted while the user is OUT of the car — sitting
  // in the garage / session screen / in-session replay view, where iRacing
  // reports `IsReplayPlaying: true`. The countdown diff therefore runs BEFORE
  // the replay guard, gated on `!isReplayOnlySession` (the #604 discriminator)
  // so a standalone saved replay stays silent, and its state survives the
  // replay-edge wipes so view flips can neither drop nor replay a mark.
  describe("standing-start countdown out of car (issue #829)", () => {
    const STANDING_RACE_SESSION: Record<string, unknown> = {
      SessionInfo: { Sessions: [{ SessionType: "Race" }] },
      WeekendInfo: { TrackID: 42, SimMode: "full", WeekendOptions: { StandingStart: 1 } },
    };

    function countdownSeconds(handler: ReturnType<typeof vi.fn>): number[] {
      return handler.mock.calls.map((c) => (c[0] as SimEventOf<"startLight.countdown.raised">).data.seconds);
    }

    function garageTick(timeRemain: number): TelemetryData {
      return telemetry({
        SessionNum: 0,
        SessionState: SessionState.GetInCar,
        SessionTimeRemain: timeRemain,
        IsReplayPlaying: true,
        IsOnTrack: false,
      });
    }

    function liveTick(timeRemain: number): TelemetryData {
      return telemetry({
        SessionNum: 0,
        SessionState: SessionState.GetInCar,
        SessionTimeRemain: timeRemain,
        IsReplayPlaying: false,
        IsOnTrack: true,
      });
    }

    it("still emits the countdown while live in the car", () => {
      const controller = createMockController();
      controller.__setSessionInfo(STANDING_RACE_SESSION);
      const handler = vi.fn();
      getEventBus().subscribe("startLight.countdown.raised", handler);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(liveTick(95)); // first-tick observation
      controller.__tick(liveTick(94)); // seeds ceiling
      controller.__tick(liveTick(58));

      expect(countdownSeconds(handler)).toEqual([60]);
    });

    it("emits the countdown while the user is out of the car (garage / session screen)", () => {
      const controller = createMockController();
      controller.__setSessionInfo(STANDING_RACE_SESSION);
      const handler = vi.fn();
      getEventBus().subscribe("startLight.countdown.raised", handler);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(garageTick(95)); // first-tick observation (also the replay-entry wipe tick)
      controller.__tick(garageTick(94)); // seeds ceiling on a replay-mode tick
      controller.__tick(garageTick(58));
      controller.__tick(garageTick(28));

      expect(countdownSeconds(handler)).toEqual([60, 30]);
    });

    it("keeps countdown state across a garage flip — a mark at the flip boundary still fires", () => {
      const controller = createMockController();
      controller.__setSessionInfo(STANDING_RACE_SESSION);
      const handler = vi.fn();
      getEventBus().subscribe("startLight.countdown.raised", handler);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(liveTick(95)); // first-tick observation
      controller.__tick(liveTick(94)); // seeds ceiling=94 live
      controller.__tick(liveTick(92));
      // Hop into the garage right before the 90 mark. The replay-edge wipe
      // must preserve the seeded ceiling — a re-seed at 89 would exclude 90.
      controller.__tick(garageTick(91));
      controller.__tick(garageTick(89));

      expect(countdownSeconds(handler)).toEqual([90]);
    });

    it("does not replay a fired mark when the user gets back in the car", () => {
      const controller = createMockController();
      controller.__setSessionInfo(STANDING_RACE_SESSION);
      const handler = vi.fn();
      getEventBus().subscribe("startLight.countdown.raised", handler);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(garageTick(95)); // first-tick observation
      controller.__tick(garageTick(94)); // seeds ceiling
      controller.__tick(garageTick(58)); // fires 60
      // Back in the car — the replay-exit wipe must not clear the fired set.
      controller.__tick(liveTick(55));
      controller.__tick(liveTick(54));
      controller.__tick(liveTick(28)); // fires 30

      expect(countdownSeconds(handler)).toEqual([60, 30]);
    });

    it("stays silent in a replay-only session (SimMode=replay)", () => {
      const controller = createMockController();
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42, SimMode: "replay", WeekendOptions: { StandingStart: 1 } },
      });
      const handler = vi.fn();
      getEventBus().subscribe("startLight.countdown.raised", handler);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(garageTick(95));
      controller.__tick(garageTick(58));
      controller.__tick(garageTick(28));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // Issue #1203: the replay lap record runs BEFORE the replay guard, for the
  // opposite reason from the countdown above — it must SEE the ticks it cannot
  // record (a replay on screen, a replay-only session) and mark itself
  // unseeded, so the first live tick back re-seeds from the field as it is
  // then rather than fabricating the crossings it missed. Its state is in
  // `wipeStateForReplay`'s wiped set by design.
  describe("replay lap record (issue #1203)", () => {
    const SUB_SESSION = 86697546;

    /** Three cars at 0–2 (the player is 0) and the pace car at 3. */
    function liveSession(simMode = "full"): Record<string, unknown> {
      return {
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42, SimMode: simMode, SubSessionID: SUB_SESSION },
        DriverInfo: {
          DriverCarIdx: 0,
          PaceCarIdx: 3,
          Drivers: [
            { CarIdx: 0, CarNumberRaw: 7, UserID: 100 },
            { CarIdx: 1, CarNumberRaw: 42, UserID: 200 },
            { CarIdx: 2, CarNumberRaw: 3042, UserID: 300 },
            { CarIdx: 3, CarNumberRaw: 0, UserID: -1, CarIsPaceCar: 1 },
          ],
        },
      };
    }

    function lapTick(o: {
      completed: number[];
      frame?: number;
      replay?: boolean;
      lastLapTime?: number[];
      uniqueId?: number;
    }): TelemetryData {
      return telemetry({
        SessionNum: 0,
        SessionUniqueID: o.uniqueId ?? 1,
        SessionState: SessionState.Racing,
        IsReplayPlaying: o.replay ?? false,
        IsOnTrack: !(o.replay ?? false),
        CarIdxLapCompleted: o.completed,
        CarIdxLastLapTime: o.lastLapTime ?? [-1, -1, -1, -1],
        ReplayFrameNumEnd: o.frame ?? 30_000,
      });
    }

    type Recorded = { event: string; carIdx: number; lap: number; frame?: number; timeMs?: number };

    /** Records both record events in publish order, reduced to what the assertions read. */
    function recordLaps(): Recorded[] {
      const seen: Recorded[] = [];
      const bus = getEventBus();

      bus.subscribe("replay.lapStarted", (ev) => {
        seen.push({ event: ev.event, carIdx: ev.data.carIdx, lap: ev.data.lap, frame: ev.data.frame });
      });
      bus.subscribe("replay.lapTimed", (ev) => {
        seen.push({ event: ev.event, carIdx: ev.data.carIdx, lap: ev.data.lap, timeMs: ev.data.timeMs });
      });

      return seen;
    }

    it("publishes a crossing and its lap time through the real tick loop, with the session identity", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession());
      const started = vi.fn();
      const timed = vi.fn();
      getEventBus().subscribe("replay.lapStarted", started);
      getEventBus().subscribe("replay.lapTimed", timed);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(lapTick({ completed: [4, 4, 4, -1], lastLapTime: [91.5, 92.5, 93.5, -1] })); // seed
      controller.__tick(lapTick({ completed: [5, 4, 4, -1], lastLapTime: [91.5, 92.5, 93.5, -1], frame: 36_305 }));
      controller.__tick(lapTick({ completed: [5, 4, 4, -1], lastLapTime: [91.5, 92.5, 93.5, -1] }));
      controller.__tick(lapTick({ completed: [5, 4, 4, -1], lastLapTime: [91.433, 92.5, 93.5, -1] }));

      expect(started).toHaveBeenCalledTimes(1);
      expect((started.mock.calls[0]![0] as SimEventOf<"replay.lapStarted">).data).toEqual({
        subSessionId: SUB_SESSION,
        sessionNum: 0,
        sessionUniqueId: 1,
        carIdx: 0,
        carNumberRaw: 7,
        userId: 100,
        lap: 6,
        frame: 36_305,
      });
      expect(timed).toHaveBeenCalledTimes(1);
      expect((timed.mock.calls[0]![0] as SimEventOf<"replay.lapTimed">).data).toEqual({
        subSessionId: SUB_SESSION,
        sessionNum: 0,
        sessionUniqueId: 1,
        carIdx: 0,
        lap: 5,
        timeMs: 91_433,
      });
    });

    it("runs before the replay guard: a crossing seen from the replay view is never fabricated on the way back", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession());
      const seen = recordLaps();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(lapTick({ completed: [4, 4, 4, -1] })); // seed
      controller.__tick(lapTick({ completed: [4, 4, 4, -1] }));
      // Into the in-session replay; the per-car arrays now follow the cursor.
      controller.__tick(lapTick({ completed: [4, 5, 4, -1], replay: true }));
      controller.__tick(lapTick({ completed: [2, 2, 2, -1], replay: true }));
      // Back live, once the exit grace has run (#1324): the field crossed
      // meanwhile. The first tick re-seeds without emitting, and — the
      // pre-guard-and-wiped signature this test pins — the replay-exit wipe
      // that follows it re-seeds once more, so a crossing on the second live
      // tick is absorbed too. Moving the diff behind the guard, or preserving
      // its state in `wipeStateForReplay`, would emit that one.
      elapseReplayGrace();
      controller.__tick(lapTick({ completed: [5, 5, 5, -1] }));
      controller.__tick(lapTick({ completed: [5, 6, 5, -1] }));
      expect(seen).toEqual([]);
      // From the third tick the record is live again.
      controller.__tick(lapTick({ completed: [6, 6, 5, -1], frame: 40_000 }));

      expect(seen).toEqual([{ event: "replay.lapStarted", carIdx: 0, lap: 7, frame: 40_000 }]);
    });

    it("stays silent in a replay-only session (SimMode=replay), even on live-looking ticks", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession("replay"));
      const seen = recordLaps();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(lapTick({ completed: [4, 4, 4, -1] }));
      controller.__tick(lapTick({ completed: [5, 4, 4, -1] }));
      controller.__tick(lapTick({ completed: [5, 5, 4, -1] }));

      expect(seen).toEqual([]);
    });

    it("skips the pace car through the real tick loop", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession());
      const seen = recordLaps();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(lapTick({ completed: [4, 4, 4, -1] }));
      controller.__tick(lapTick({ completed: [4, 4, 4, 0] }));
      controller.__tick(lapTick({ completed: [4, 4, 4, 1] }));

      expect(seen).toEqual([]);
    });

    describe("the 2026-09-17 crossings capture, through the translator", () => {
      type FixtureTick = { t: number; CarIdxLapCompleted: number[] };

      const ticks = JSON.parse(
        readFileSync(new URL("./diff/__fixtures__/replay-laps-crossings-20260917.json", import.meta.url), "utf-8"),
      ) as FixtureTick[];

      /** 20 cars at their indices; the pace car is slot 20 (raw index 64 in the capture). */
      function fixtureSession(): Record<string, unknown> {
        const drivers: Array<Record<string, unknown>> = [];

        for (let carIdx = 0; carIdx < 20; carIdx++) {
          drivers.push({ CarIdx: carIdx, CarNumberRaw: carIdx + 1, UserID: 1000 + carIdx });
        }

        drivers.push({ CarIdx: 20, CarNumberRaw: 0, UserID: -1, CarIsPaceCar: 1 });

        return {
          SessionInfo: { Sessions: [{ SessionType: "Race" }] },
          WeekendInfo: { TrackID: 42, SimMode: "full", SubSessionID: 0 },
          DriverInfo: { DriverCarIdx: 0, PaceCarIdx: 20, Drivers: drivers },
        };
      }

      /** The capture carries no frame counter; the live one advances 60 per second. */
      const frameOf = (t: number): number => Math.round(t * 60);

      // The order the field first took the line, read off the capture (203.70 →
      // 206.55 s): car 17 first, car 13 last, with 0/15 and 3/8 on shared ticks.
      const FIRST_CROSSING_ORDER = [17, 16, 18, 7, 11, 6, 1, 4, 12, 14, 9, 0, 15, 5, 19, 10, 3, 8, 2, 13];
      // Laps 2 and 3 were taken in the same order both times (239.5 → 244.48 s, 278.5 → 291.73 s).
      const RACING_ORDER = [17, 16, 7, 11, 18, 6, 1, 4, 0, 9, 12, 14, 3, 19, 15, 10, 5, 2, 8, 13];

      it("publishes exactly the capture's crossings, in capture order, and nothing for the pace car", () => {
        const controller = createMockController();
        controller.__setSessionInfo(fixtureSession());
        const seen = recordLaps();
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        for (const tick of ticks) {
          controller.__tick(lapTick({ completed: tick.CarIdxLapCompleted, frame: frameOf(tick.t) }));
        }

        expect(seen).toHaveLength(60);
        expect(seen.every((e) => e.event === "replay.lapStarted")).toBe(true); // no times in the capture
        expect(seen.some((e) => e.carIdx === 20)).toBe(false);
        expect(seen.slice(0, 20).map((e) => e.carIdx)).toEqual(FIRST_CROSSING_ORDER);
        expect(seen.slice(0, 20).every((e) => e.lap === 1)).toBe(true);
        expect(seen.slice(20, 40).map((e) => e.carIdx)).toEqual(RACING_ORDER);
        expect(seen.slice(20, 40).every((e) => e.lap === 2)).toBe(true);
        expect(seen.slice(40).map((e) => e.carIdx)).toEqual(RACING_ORDER);
        expect(seen.slice(40).every((e) => e.lap === 3)).toBe(true);
      });

      it("stamps each crossing with the frame of its own tick", () => {
        const controller = createMockController();
        controller.__setSessionInfo(fixtureSession());
        const seen = recordLaps();
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        for (const tick of ticks) {
          controller.__tick(lapTick({ completed: tick.CarIdxLapCompleted, frame: frameOf(tick.t) }));
        }

        expect(seen[0]).toEqual({ event: "replay.lapStarted", carIdx: 17, lap: 1, frame: frameOf(203.7) });
        expect(seen[20]).toEqual({ event: "replay.lapStarted", carIdx: 17, lap: 2, frame: frameOf(239.5) });
        expect(seen[59]).toEqual({ event: "replay.lapStarted", carIdx: 13, lap: 3, frame: frameOf(291.73) });

        for (let i = 1; i < seen.length; i++) {
          expect(seen[i].frame).toBeGreaterThanOrEqual(seen[i - 1].frame!);
        }
      });
    });
  });

  // Issue #1354: the replay green record is the lap record's sibling — same
  // gate, same side of the replay guard, same wiped state — so its wiring is
  // pinned the same way: through the real tick loop, by the signature only a
  // pre-guard, wiped diff leaves.
  describe("replay green record (issue #1354)", () => {
    const SUB_SESSION = 86697546;

    // `SessionFlags` values lifted from the 2026-09-17 capture (see `diff/caution.test.ts`).
    const RACING = 0x10040000; // Servicible | StartHidden — green-flag running
    const WAVING = 0x10048000; // + CautionWaving
    const STATIC = 0x10044000; // + Caution
    const RESTART = 0x80040004 | 0; // Green | Servicible | StartGo — StartGo is the sign bit

    function raceSession(simMode = "full"): Record<string, unknown> {
      return {
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42, SimMode: simMode, SubSessionID: SUB_SESSION },
        DriverInfo: { DriverCarIdx: 0, Drivers: [{ CarIdx: 0, CarNumberRaw: 7, UserID: 100 }] },
      };
    }

    function greenTick(o: {
      state?: SessionState;
      flags?: number;
      frame?: number;
      time?: number;
      replay?: boolean;
    }): TelemetryData {
      return telemetry({
        SessionNum: 0,
        SessionUniqueID: 1,
        SessionState: o.state ?? SessionState.Racing,
        SessionFlags: o.flags ?? RACING,
        SessionTime: o.time ?? 600,
        IsReplayPlaying: o.replay ?? false,
        IsOnTrack: !(o.replay ?? false),
        ReplayFrameNumEnd: o.frame ?? 30_000,
      });
    }

    type RecordedGreen = { kind: string; frame: number };

    function recordGreens(): RecordedGreen[] {
      const seen: RecordedGreen[] = [];

      getEventBus().subscribe("replay.greenFlag", (ev) => {
        seen.push({ kind: ev.data.kind, frame: ev.data.frame });
      });

      return seen;
    }

    it("publishes the race start through the real tick loop, with the session identity, frame and session time", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSession());
      const handler = vi.fn();
      getEventBus().subscribe("replay.greenFlag", handler);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(greenTick({ state: SessionState.ParadeLaps })); // seed
      controller.__tick(greenTick({ state: SessionState.ParadeLaps }));
      const edge = greenTick({ flags: RESTART, frame: 41_007, time: 690.1 });
      controller.__tick(edge);
      controller.__tick(greenTick({ flags: RESTART, frame: 41_008, time: 690.117 }));

      expect(handler).toHaveBeenCalledTimes(1);
      const published = handler.mock.calls[0]![0] as SimEventOf<"replay.greenFlag">;
      expect(published.data).toEqual({
        subSessionId: SUB_SESSION,
        sessionNum: 0,
        sessionUniqueId: 1,
        kind: "start",
        frame: 41_007,
        sessionTimeMs: 690_100,
      });
      // Published directly on the edge tick, with that tick's telemetry.
      expect(published.telemetry).toBe(edge);
    });

    it("logs the edge at debug, with the raw flags and state the manual capture reads", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSession());
      const logger = createMockLogger();
      initializeSimEventsIracing(getEventBus(), controller, logger);

      controller.__tick(greenTick({ state: SessionState.Warmup }));
      controller.__tick(greenTick({ flags: RESTART, frame: 30_215, time: 512.433 }));

      const lines = vi.mocked(logger.debug).mock.calls.map((c) => c[0]);

      expect(lines).toContain(
        "Replay green: kind=start frame=30215 sessionTime=512.433 SessionState=2→4 " +
          "SessionFlags=0x10040000→0x80040004 SessionNum=0 SessionUniqueID=1",
      );
    });

    it("runs before the replay guard: a green that flew behind the replay view is never fabricated on the way back", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSession());
      const seen = recordGreens();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(greenTick({ state: SessionState.ParadeLaps })); // seed
      controller.__tick(greenTick({ state: SessionState.ParadeLaps }));
      // Into the garage / the in-session replay on the formation lap.
      controller.__tick(greenTick({ state: SessionState.ParadeLaps, replay: true }));
      controller.__tick(greenTick({ state: SessionState.ParadeLaps, replay: true }));
      // Back live, once the exit grace has run (#1324). The first tick
      // re-seeds without emitting, and — the pre-guard-and-wiped signature
      // this test pins — the replay-exit wipe that follows it re-seeds once
      // more, so the state entering Racing on the SECOND live tick is absorbed
      // too. Moving the diff behind the guard, or preserving its state in
      // `wipeStateForReplay`, would emit that one as the start.
      elapseReplayGrace();
      controller.__tick(greenTick({ state: SessionState.ParadeLaps, frame: 50_000 }));
      controller.__tick(greenTick({ frame: 50_001 }));
      controller.__tick(greenTick({ frame: 50_002 }));
      expect(seen).toEqual([]);
      // From there the record is live again: a re-grid's green is recorded.
      controller.__tick(greenTick({ state: SessionState.ParadeLaps, frame: 60_000 }));
      controller.__tick(greenTick({ frame: 60_001 }));

      expect(seen).toEqual([{ kind: "start", frame: 60_001 }]);
    });

    it("drops its caution latch behind the replay view: a restart taken there is absent, the next one is recorded", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSession());
      const seen = recordGreens();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(greenTick({})); // seed
      controller.__tick(greenTick({ flags: WAVING }));
      controller.__tick(greenTick({ flags: STATIC }));
      // A glance at the replay under the yellow; the field restarts meanwhile.
      controller.__tick(greenTick({ flags: STATIC, replay: true }));
      elapseReplayGrace();
      controller.__tick(greenTick({ flags: RESTART, frame: 70_000 }));
      controller.__tick(greenTick({ flags: RESTART, frame: 70_001 }));
      controller.__tick(greenTick({ frame: 70_002 }));
      expect(seen).toEqual([]);
      // The next caution is watched from the car, start to finish.
      controller.__tick(greenTick({ flags: WAVING, frame: 80_000 }));
      controller.__tick(greenTick({ flags: STATIC, frame: 80_001 }));
      controller.__tick(greenTick({ flags: RESTART, frame: 80_002 }));

      expect(seen).toEqual([{ kind: "restart", frame: 80_002 }]);
    });

    it("stays silent in a replay-only session (SimMode=replay), even on live-looking ticks", () => {
      const controller = createMockController();
      controller.__setSessionInfo(raceSession("replay"));
      const seen = recordGreens();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(greenTick({ state: SessionState.ParadeLaps }));
      controller.__tick(greenTick({ state: SessionState.ParadeLaps }));
      controller.__tick(greenTick({ flags: RESTART }));
      controller.__tick(greenTick({ flags: STATIC }));
      controller.__tick(greenTick({ flags: RESTART }));

      expect(seen).toEqual([]);
    });

    it("records a restart on the tick caution.restarted fires, and publishes it first — ahead of the post-guard flush", () => {
      // The two are decided by one predicate (`isRestartGreenEdge`) over two
      // latches: the caution diff's phase and the recorder's own. The order
      // is the wiring's: the recorder publishes directly from in front of the
      // guard, the caution diff through the `pending` list flushed at the end
      // of the tick.
      const controller = createMockController();
      controller.__setSessionInfo(raceSession());
      const stream: string[] = [];
      getEventBus().subscribe("replay.greenFlag", (ev) => stream.push(`${ev.event}:${ev.data.kind}@${ev.data.frame}`));
      getEventBus().subscribe("caution.restarted", (ev) => stream.push(ev.event));
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(greenTick({})); // seed
      controller.__tick(greenTick({ flags: WAVING, frame: 71_000 }));
      controller.__tick(greenTick({ flags: STATIC, frame: 71_500 }));
      expect(stream).toEqual([]);
      controller.__tick(greenTick({ flags: RESTART, frame: 71_904 }));

      expect(stream).toEqual(["replay.greenFlag:restart@71904", "caution.restarted"]);
    });

    it("records nothing for a practice session going Racing", () => {
      const controller = createMockController();
      controller.__setSessionInfo({ ...raceSession(), SessionInfo: { Sessions: [{ SessionType: "Practice" }] } });
      const seen = recordGreens();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(greenTick({ state: SessionState.GetInCar }));
      controller.__tick(greenTick({ state: SessionState.GetInCar }));
      controller.__tick(greenTick({ flags: RESTART }));

      expect(seen).toEqual([]);
    });
  });

  // Issue #1426: the session record reads a second class of tick (out of the
  // car at the live edge), which only a pre-guard diff whose state outlives
  // the replay wipes can record from — so it is pinned by publishing from the
  // garage and by publishing a pair once across trips to it. The incident
  // record is the lap and green records' sibling and is pinned by their
  // pre-guard-and-wiped signature.
  describe("replay session record (issue #1426)", () => {
    const SUB_SESSION = 86697546;

    function liveSession(simMode = "full"): Record<string, unknown> {
      return {
        SessionInfo: { Sessions: [{ SessionType: "Practice" }, { SessionType: "Qualify" }, { SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42, SimMode: simMode, SubSessionID: SUB_SESSION },
        DriverInfo: { DriverCarIdx: 0, Drivers: [{ CarIdx: 0, CarNumberRaw: 7, UserID: 100 }] },
      };
    }

    type SessionTickOptions = { frame: number; time: number; sessionNum?: number; uniqueId?: number };

    /** In the car: the live frame is `ReplayFrameNumEnd`. */
    function carTick(o: SessionTickOptions): TelemetryData {
      return telemetry({
        SessionNum: o.sessionNum ?? 1,
        SessionUniqueID: o.uniqueId ?? 2,
        SessionTime: o.time,
        IsReplayPlaying: false,
        IsOnTrack: true,
        ReplayFrameNum: 0,
        ReplayFrameNumEnd: o.frame,
      });
    }

    /** Out of the car at the live edge of the in-session replay: the cursor one frame from the end. */
    function garageTick(o: SessionTickOptions & { toEnd?: number }): TelemetryData {
      const toEnd = o.toEnd ?? 1;

      return telemetry({
        SessionNum: o.sessionNum ?? 1,
        SessionUniqueID: o.uniqueId ?? 2,
        SessionTime: o.time,
        IsReplayPlaying: true,
        IsOnTrack: false,
        ReplayFrameNum: o.frame - toEnd,
        ReplayFrameNumEnd: toEnd,
      });
    }

    type RecordedStart = { sessionNum: number; sessionUniqueId: number; frame: number };

    function recordStarts(): RecordedStart[] {
      const seen: RecordedStart[] = [];

      getEventBus().subscribe("replay.sessionStarted", (ev) => {
        seen.push({ sessionNum: ev.data.sessionNum, sessionUniqueId: ev.data.sessionUniqueId, frame: ev.data.frame });
      });

      return seen;
    }

    it("publishes a session first seen from the garage at the live edge, a tick the replay guard swallows", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession());
      const handler = vi.fn();
      getEventBus().subscribe("replay.sessionStarted", handler);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(garageTick({ frame: 156_000, time: 600 }));
      const second = garageTick({ frame: 156_001, time: 600 + 1 / 60 });
      controller.__tick(second);

      expect(handler).toHaveBeenCalledTimes(1);
      const published = handler.mock.calls[0]![0] as SimEventOf<"replay.sessionStarted">;
      expect(published.data).toEqual({ subSessionId: SUB_SESSION, sessionNum: 1, sessionUniqueId: 2, frame: 120_000 });
      expect(published.telemetry).toBe(second);
    });

    it("publishes a pair once across trips between the car and the garage: its state outlives the replay wipes", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession());
      const seen = recordStarts();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(carTick({ frame: 156_000, time: 600 }));
      controller.__tick(carTick({ frame: 156_001, time: 600 + 1 / 60 }));

      // Into the garage: the guard's entry wipe runs on the first of these.
      for (let i = 0; i < 4; i++) {
        controller.__tick(garageTick({ frame: 160_000 + i, time: (40_000 + i) / 60 }));
      }

      // Back in the car: the exit wipe runs on the first live tick.
      elapseReplayGrace();

      for (let i = 0; i < 4; i++) {
        controller.__tick(carTick({ frame: 170_000 + i, time: (50_000 + i) / 60 }));
      }

      expect(seen).toEqual([{ sessionNum: 1, sessionUniqueId: 2, frame: 120_000 }]);
    });

    it("publishes the next session's start when it begins with the driver in the garage", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession());
      const seen = recordStarts();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(garageTick({ frame: 156_000, time: 600 }));
      controller.__tick(garageTick({ frame: 156_001, time: 600 + 1 / 60 }));
      // Qualifying ends; the race loads while the driver sits in the garage.
      // The translator's session-change reset runs ahead of the recorder.
      controller.__tick(garageTick({ frame: 200_000, time: 0, sessionNum: 2, uniqueId: 3 }));
      controller.__tick(garageTick({ frame: 200_001, time: 1 / 60, sessionNum: 2, uniqueId: 3 }));
      controller.__tick(garageTick({ frame: 200_002, time: 2 / 60, sessionNum: 2, uniqueId: 3 }));

      expect(seen).toEqual([
        { sessionNum: 1, sessionUniqueId: 2, frame: 120_000 },
        { sessionNum: 2, sessionUniqueId: 3, frame: 200_000 },
      ]);
    });

    it("publishes nothing from the garage while the replay is scrubbed back", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession());
      const seen = recordStarts();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(garageTick({ frame: 156_000, time: 600, toEnd: 27_630 }));
      controller.__tick(garageTick({ frame: 156_001, time: 600 + 1 / 60, toEnd: 27_630 }));

      expect(seen).toEqual([]);
    });

    it("stays silent in a replay-only session (SimMode=replay), at its end and on live-looking ticks", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession("replay"));
      const seen = recordStarts();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(garageTick({ frame: 156_000, time: 600 }));
      controller.__tick(garageTick({ frame: 156_001, time: 600 + 1 / 60 }));
      controller.__tick(carTick({ frame: 156_002, time: 600 + 2 / 60 }));
      controller.__tick(carTick({ frame: 156_003, time: 600 + 3 / 60 }));

      expect(seen).toEqual([]);
    });

    it("refuses a stale clock at a session change: the latest start outlives the session-change reset", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession());
      const seen = recordStarts();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(garageTick({ frame: 156_000, time: 600 }));
      controller.__tick(garageTick({ frame: 156_001, time: 600 + 1 / 60 }));

      // The race's number arrives with qualifying's clock still running, for three ticks.
      for (const frame of [200_000, 200_001, 200_002]) {
        controller.__tick(garageTick({ frame, time: (frame - 120_000) / 60, sessionNum: 2, uniqueId: 3 }));
      }

      controller.__tick(garageTick({ frame: 200_003, time: 3 / 60, sessionNum: 2, uniqueId: 3 }));
      controller.__tick(garageTick({ frame: 200_004, time: 4 / 60, sessionNum: 2, uniqueId: 3 }));

      expect(seen).toEqual([
        { sessionNum: 1, sessionUniqueId: 2, frame: 120_000 },
        { sessionNum: 2, sessionUniqueId: 3, frame: 200_000 },
      ]);
    });

    it("stays silent at the end of a saved replay's tape on ticks whose session info reads null", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession("replay"));
      const seen = recordStarts();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      // Scrubbed back: the controller learns it is a saved replay.
      controller.__tick(garageTick({ frame: 156_000, time: 600, toEnd: 27_630 }));
      // An empty or unparsable YAML read: the controller keeps its saved-replay
      // answer, while a per-tick SimMode read has nothing to say no with.
      controller.__setSessionInfo(null);
      controller.__tick(garageTick({ frame: 156_001, time: 600 + 1 / 60 }));
      controller.__tick(garageTick({ frame: 156_002, time: 600 + 2 / 60 }));

      expect(controller.getReplayState().replayOnlySession).toBe(true);
      expect(seen).toEqual([]);
    });

    it("logs the publish at debug", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession());
      const logger = createMockLogger();
      initializeSimEventsIracing(getEventBus(), controller, logger);

      controller.__tick(carTick({ frame: 36_000, time: 0 }));
      controller.__tick(carTick({ frame: 36_001, time: 1 / 60 }));

      expect(vi.mocked(logger.debug).mock.calls.map((c) => c[0])).toContain(
        "Replay session start: frame=36000 (tick frame=36001 sessionTime=0.017 inCar=true) " +
          "SessionNum=1 SessionUniqueID=2",
      );
    });
  });

  describe("replay incident record (issue #1426)", () => {
    const SUB_SESSION = 86697546;

    function liveSession(counts: number[], simMode = "full"): Record<string, unknown> {
      return {
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42, SimMode: simMode, SubSessionID: SUB_SESSION },
        DriverInfo: {
          DriverCarIdx: 0,
          Drivers: [
            { CarIdx: 0, CarNumberRaw: 7, UserID: 100, CurDriverIncidentCount: counts[0] },
            { CarIdx: 1, CarNumberRaw: 42, UserID: 200, CurDriverIncidentCount: counts[1] },
          ],
        },
      };
    }

    function incidentTick(o: { player: number; frame?: number; replay?: boolean }): TelemetryData {
      return telemetry({
        SessionNum: 0,
        SessionUniqueID: 1,
        SessionTime: 600,
        PlayerCarMyIncidentCount: o.player,
        IsReplayPlaying: o.replay ?? false,
        IsOnTrack: !(o.replay ?? false),
        ReplayFrameNumEnd: o.frame ?? 30_000,
      });
    }

    type RecordedIncident = { carIdx: number; delta: number; source: string; frame: number };

    function recordIncidents(): RecordedIncident[] {
      const seen: RecordedIncident[] = [];

      getEventBus().subscribe("replay.incident", (ev) => {
        seen.push({ carIdx: ev.data.carIdx, delta: ev.data.delta, source: ev.data.source, frame: ev.data.frame });
      });

      return seen;
    }

    it("publishes the driver's and another car's rise through the real tick loop, with the session identity", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession([0, 2]));
      const handler = vi.fn();
      getEventBus().subscribe("replay.incident", handler);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(incidentTick({ player: 0 })); // seed
      const rise = incidentTick({ player: 2, frame: 41_007 });
      controller.__setSessionInfo(liveSession([2, 6]));
      controller.__tick(rise);

      expect(handler).toHaveBeenCalledTimes(2);
      const [own, other] = handler.mock.calls.map((c) => c[0] as SimEventOf<"replay.incident">);
      expect(own.data).toEqual({
        subSessionId: SUB_SESSION,
        sessionNum: 0,
        sessionUniqueId: 1,
        carIdx: 0,
        carNumberRaw: 7,
        frame: 41_007,
        sessionTimeMs: 600_000,
        delta: 2,
        source: "telemetry",
      });
      expect(own.telemetry).toBe(rise);
      expect(other.data).toMatchObject({ carIdx: 1, carNumberRaw: 42, delta: 4, source: "sessionInfo" });
    });

    it("runs before the replay guard: a rise behind the replay view is never stamped with the frame of the way back", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession([0, 0]));
      const seen = recordIncidents();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(incidentTick({ player: 0 })); // seed
      controller.__tick(incidentTick({ player: 0, replay: true }));
      controller.__tick(incidentTick({ player: 4, replay: true }));
      // Back live, once the exit grace has run (#1324). The first tick
      // re-seeds without emitting, and — the pre-guard-and-wiped signature —
      // the replay-exit wipe that follows it re-seeds once more, so a rise on
      // the second live tick is absorbed too. Moving the diff behind the
      // guard, or preserving its state in `wipeStateForReplay`, would emit it.
      elapseReplayGrace();
      controller.__tick(incidentTick({ player: 4 }));
      controller.__tick(incidentTick({ player: 5 }));
      expect(seen).toEqual([]);
      controller.__tick(incidentTick({ player: 6, frame: 40_000 }));

      expect(seen).toEqual([{ carIdx: 0, delta: 1, source: "telemetry", frame: 40_000 }]);
    });

    it("stays silent in a replay-only session (SimMode=replay)", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession([0, 0], "replay"));
      const seen = recordIncidents();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(incidentTick({ player: 0 }));
      controller.__tick(incidentTick({ player: 2 }));
      controller.__setSessionInfo(liveSession([2, 4], "replay"));
      controller.__tick(incidentTick({ player: 3 }));

      expect(seen).toEqual([]);
    });
  });

  describe("the replay recorders, on one tick (issues #1203, #1354, #1426)", () => {
    it("publish in their wiring order: laps, greens, sessions, incidents", () => {
      const controller = createMockController();
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        WeekendInfo: { TrackID: 42, SimMode: "full", SubSessionID: 0 },
        DriverInfo: { DriverCarIdx: 0, Drivers: [{ CarIdx: 0, CarNumberRaw: 7, UserID: 100 }] },
      });
      const stream: string[] = [];
      const bus = getEventBus();

      bus.subscribe("replay.lapStarted", (ev) => stream.push(ev.event));
      bus.subscribe("replay.greenFlag", (ev) => stream.push(ev.event));
      bus.subscribe("replay.sessionStarted", (ev) => stream.push(ev.event));
      bus.subscribe("replay.incident", (ev) => stream.push(ev.event));
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      const base = { SessionNum: 0, SessionUniqueID: 1, IsReplayPlaying: false };
      controller.__tick(
        telemetry({
          ...base,
          SessionState: SessionState.ParadeLaps,
          SessionTime: 600,
          ReplayFrameNumEnd: 36_000,
          CarIdxLapCompleted: [0],
          PlayerCarMyIncidentCount: 0,
        }),
      );
      expect(stream).toEqual([]);
      // One tick: the car crosses the line as the green flies, the session's
      // start is read a second time, and the driver picks up an incident.
      controller.__tick(
        telemetry({
          ...base,
          SessionState: SessionState.Racing,
          SessionFlags: 0x80040004 | 0,
          SessionTime: 600 + 1 / 60,
          ReplayFrameNumEnd: 36_001,
          CarIdxLapCompleted: [1],
          PlayerCarMyIncidentCount: 2,
        }),
      );

      expect(stream).toEqual([
        "replay.lapStarted",
        "replay.greenFlag",
        "replay.sessionStarted",
        "replay.incident",
      ]);
    });
  });

  describe("full-course caution wiring (issue #1127)", () => {
    /** car0 is the player, car1 the rival, car2 the pace car, car3 the car behind the rival on the outside line. */
    const PLAYER = 0;
    const RIVAL = 1;
    const PACE = 2;
    const OUTSIDE = 3;

    /** `SessionFlags` values lifted from the 2026-09-17 capture (see `diff/caution.test.ts`). */
    const RACING = 0x10040000; // Servicible | StartHidden — green-flag running
    const WAVING = 0x10048000; // + CautionWaving
    const STATIC = 0x10044000; // + Caution
    const ONE_TO_GO = 0x10044200; // + OneLapToGreen
    const RESTART = 0x80040004 | 0; // Green | Servicible | StartGo — StartGo is the sign bit

    function ovalRace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        WeekendInfo: { Category: "Oval", TrackType: "medium oval" },
        DriverInfo: {
          DriverCarIdx: PLAYER,
          PaceCarIdx: PACE,
          Drivers: [
            { CarIdx: PLAYER, CarNumber: "7" },
            { CarIdx: RIVAL, CarNumber: "11" },
            { CarIdx: PACE, CarNumber: "0", CarIsPaceCar: 1 },
            { CarIdx: OUTSIDE, CarNumber: "4" },
          ],
        },
        SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
        ...overrides,
      };
    }

    type CautionTick = {
      flags: number;
      /** Per-car `[lapCompleted, lapDistPct]`, indexed by carIdx. */
      progress?: Array<[number, number]>;
      /** Per-car `[paceRow, paceLine]`, indexed by carIdx; `[-1, -1]` for a car not lined up. */
      pace?: Array<[number, number]>;
      paceCarSurface?: TrkLoc;
      paceMode?: number;
      replay?: boolean;
    };

    /**
     * The lineup the disagreement tests run on. The pace car heads line 0, the
     * PLAYER holds line 0 row 1, and the RIVAL line 1 row 0 — so the lineup's
     * own front car is the player while the canonical order (below) names the
     * rival as the leader. That is the disagreement the 2026-09-17 capture
     * showed and the reason the canonical order is the authority here. The
     * OUTSIDE car behind the rival is what makes line 1 a COLUMN: the lineup
     * reader counts a line only when it holds two cars, so a lone car on line
     * 1 would read as a stray and the field as single file.
     */
    const FRONT_ROW: Array<[number, number]> = [
      [1, 0],
      [0, 1],
      [0, 0],
      [1, 1],
    ];

    function cautionTick({
      flags,
      progress = [
        [10, 0.5],
        [11, 0.5],
        [5, 0.5],
        [10, 0.5],
      ],
      pace = FRONT_ROW,
      paceCarSurface = TrkLoc.OnTrack,
      paceMode,
      replay,
    }: CautionTick): TelemetryData {
      const surfaces = [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack];
      surfaces[PACE] = paceCarSurface;

      return telemetry({
        SessionState: SessionState.Racing,
        SessionFlags: flags,
        SessionTime: 600,
        CarIdxLapCompleted: progress.map(([lap]) => lap),
        CarIdxLapDistPct: progress.map(([, pct]) => pct),
        CarIdxTrackSurface: surfaces,
        CarIdxClass: [0, 0, 0, 0],
        CarIdxPaceRow: pace.map(([row]) => row),
        CarIdxPaceLine: pace.map(([, line]) => line),
        ...(paceMode === undefined ? {} : { PaceMode: paceMode }),
        ...(replay === undefined ? {} : { IsReplayPlaying: replay }),
      });
    }

    /** Records the caution + gantry stream in publish order, as event names. */
    function recordStream(): string[] {
      const seen: string[] = [];
      const bus = getEventBus();

      for (const name of [
        "paceCar.deployed",
        "paceCar.off",
        "caution.fieldCaught",
        "caution.extraLap",
        "caution.oneLapToGreen",
        "caution.restarted",
        "startLight.start-go.raised",
      ] as const) {
        bus.subscribe(name, () => seen.push(name));
      }

      return seen;
    }

    /**
     * A full caution, thrown → picked up → one to go → restarted. The pace car
     * starts in its stall so the deployment edge is a real transition rather
     * than a seeded value.
     */
    function driveFullCaution(controller: MockController): void {
      controller.__tick(cautionTick({ flags: RACING, paceCarSurface: TrkLoc.InPitStall }));
      controller.__tick(cautionTick({ flags: WAVING, paceCarSurface: TrkLoc.InPitStall }));
      controller.__tick(cautionTick({ flags: WAVING }));
      controller.__tick(cautionTick({ flags: STATIC }));
      controller.__tick(cautionTick({ flags: ONE_TO_GO, paceMode: PaceMode.DoubleFileRestart }));
      // The capture has the pace car heading for the pits about five seconds
      // BEFORE the green, so its departure is its own tick rather than the
      // restart's. Keeping the two apart is what stops this asserting the
      // arbitrary within-tick order of `diffPaceCar` and `diffCautionEpisode`.
      controller.__tick(
        cautionTick({ flags: ONE_TO_GO, paceMode: PaceMode.DoubleFileRestart, paceCarSurface: TrkLoc.AproachingPits }),
      );
      controller.__tick(cautionTick({ flags: RESTART, paceCarSurface: TrkLoc.AproachingPits }));
    }

    it("publishes the caution sequence, in order, through the real tick loop", () => {
      const controller = createMockController();
      controller.__setSessionInfo(ovalRace());
      const seen = recordStream();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      driveFullCaution(controller);

      expect(seen).toEqual([
        "paceCar.deployed",
        "caution.fieldCaught",
        "caution.oneLapToGreen",
        "paceCar.off",
        "caution.restarted",
      ]);
    });

    it("a restart does not also speak the race start — diffCaution runs AFTER diffStartLights", () => {
      // The measured restart tick carries `StartGo`, so the gantry diff would
      // announce a race start unless it reads a caution phase that `diffCaution`
      // clears on the very same tick. Half of the #1127 start-go gate is dead
      // code until this wiring exists, and this is what exercises it.
      const controller = createMockController();
      controller.__setSessionInfo(ovalRace());
      const seen = recordStream();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      driveFullCaution(controller);

      expect(seen).toContain("caution.restarted");
      expect(seen).not.toContain("startLight.start-go.raised");
    });

    it("but a race start still speaks — the suppression is the phase, not the bit", () => {
      // The positive control for the test above: the identical `StartGo` rising
      // edge with no caution episode behind it must still announce.
      const controller = createMockController();
      controller.__setSessionInfo(ovalRace());
      const seen = recordStream();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(cautionTick({ flags: RACING }));
      controller.__tick(cautionTick({ flags: RESTART }));

      expect(seen).toEqual(["startLight.start-go.raised"]);
    });

    it("a restart with NO start bit is announced once — diffFlags stands its green line down for caution.restarted", () => {
      // Unmeasured ordering (the oval restarts all carried `StartGo`), and the
      // one where the two families used to double up: `flag.green.raised` AND
      // `caution.restarted` on one tick, both `family: "flag"`, the CRITICAL
      // restart line cutting the green line mid-word. `diffFlags` reads the
      // caution phase ahead of `diffCaution` clearing it, so this pins the
      // wiring order for that reader as the start-go test does for its own.
      const controller = createMockController();
      controller.__setSessionInfo(ovalRace());
      const seen = recordStream();
      const greens: string[] = [];
      getEventBus().subscribe("flag.green.raised", () => greens.push("flag.green.raised"));
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(cautionTick({ flags: RACING }));
      controller.__tick(cautionTick({ flags: WAVING }));
      controller.__tick(cautionTick({ flags: STATIC }));
      controller.__tick(cautionTick({ flags: RACING | Flags.Green })); // green, no start bit

      expect(seen).toEqual(["caution.fieldCaught", "caution.restarted"]);
      expect(greens).toEqual([]);
    });

    it("but a green with no caution behind it still raises the green line — the positive control", () => {
      const controller = createMockController();
      controller.__setSessionInfo(ovalRace());
      const seen = recordStream();
      const greens: string[] = [];
      getEventBus().subscribe("flag.green.raised", () => greens.push("flag.green.raised"));
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(cautionTick({ flags: RACING }));
      controller.__tick(cautionTick({ flags: RACING | Flags.Green }));

      expect(seen).toEqual([]);
      expect(greens).toEqual(["flag.green.raised"]);
    });

    // The third reader of the phase takes it the other way round (issue
    // #1171): `diffGaps` is handed "a caution is out" as an argument and must
    // see the phase THIS tick settled, so it runs after `diffCaution`.
    describe("the gap diff under a caution (issue #1171)", () => {
      /**
       * One tick of a race in which the rival laps at a steady 0.01 of a lap
       * per second and the player sits `gapAheadS` race-seconds behind it, a
       * tenth of a second after tick `k - 1`. The crossing-time gap is then
       * exactly `gapAheadS` once the rival's trace reaches back that far.
       */
      function gapTick(k: number, gapAheadS: number, flags: number, replay?: boolean): TelemetryData {
        const rival = 0.3 + 0.001 * k;
        const player = rival - 0.01 * gapAheadS;

        return {
          ...cautionTick({
            flags,
            progress: [
              [10, player],
              [10, rival],
              [5, 0.5],
              [10, player - 0.05],
            ],
            replay,
          }),
          SessionTime: 600 + 0.1 * k,
        };
      }

      /** The player's progress at tick `k`, in laps. */
      const playerAt = (k: number, gapAheadS: number): number => 10.3 + 0.001 * k - 0.01 * gapAheadS;

      function recordGapEvents(): string[] {
        const seen: string[] = [];

        for (const name of ["gap.thresholdCrossed", "gap.trendChanged"] as const) {
          getEventBus().subscribe(name, () => seen.push(name));
        }

        return seen;
      }

      /**
       * Fifty ticks 3 s behind the rival — the trace fills, the reading
       * settles and the 1 s threshold arms — then the player closes 0.35 s a
       * tick, to 1.25 s. The next tick at 0.9 s is the crossing: 2.1 s of
       * movement, so no movement gate has a say in it.
       */
      function closeToTheThreshold(controller: MockController): number {
        let k = 0;

        for (; k < 50; k++) controller.__tick(gapTick(k, 3, RACING));

        for (const gap of [2.65, 2.3, 1.95, 1.6, 1.25]) controller.__tick(gapTick(k++, gap, RACING));

        return k;
      }

      function restartMark(): number | null {
        const snapshot = readSimState();

        return snapshot.initialized ? snapshot.raw.state.gapRestartMark : null;
      }

      it("a gap call due on the tick the caution is thrown is not published — diffGaps runs AFTER diffCaution", () => {
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        const seen = recordGapEvents();
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        const k = closeToTheThreshold(controller);

        // The yellow waves on the very tick the gap drops inside the
        // threshold. Handed last tick's phase, the gap diff would still call it.
        controller.__tick(gapTick(k, 0.9, WAVING));

        expect(isUnderFullCourseCaution()).toBe(true);
        expect(seen).toEqual([]);
      });

      it("but the same crossing under green is published — the positive control", () => {
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        const seen = recordGapEvents();
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        const k = closeToTheThreshold(controller);

        controller.__tick(gapTick(k, 0.9, RACING));

        expect(seen).toEqual(["gap.thresholdCrossed"]);
      });

      it("the restart mark moves on the tick the caution is thrown and stops on the green's own tick", () => {
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        controller.__tick(gapTick(0, 2, RACING));
        controller.__tick(gapTick(1, 2, RACING));
        expect(restartMark()).toBeNull();

        controller.__tick(gapTick(2, 2, WAVING));
        expect(restartMark()).toBeCloseTo(playerAt(2, 2) + 1, 9);

        controller.__tick(gapTick(3, 2, STATIC));
        expect(restartMark()).toBeCloseTo(playerAt(3, 2) + 1, 9);

        // The green ends the episode in `diffCaution`, earlier on this tick,
        // so the mark stays one lap past the last caution tick.
        controller.__tick(gapTick(4, 2, RESTART));
        expect(isUnderFullCourseCaution()).toBe(false);
        expect(restartMark()).toBeCloseTo(playerAt(3, 2) + 1, 9);
      });

      it("a replay glance on the restart lap keeps the restart mark, so the lap is still the restart lap", () => {
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        controller.__tick(gapTick(0, 2, RACING));
        controller.__tick(gapTick(1, 2, WAVING));
        controller.__tick(gapTick(2, 2, STATIC));
        controller.__tick(gapTick(3, 2, RESTART));

        const mark = restartMark();

        expect(mark).toBeCloseTo(playerAt(2, 2) + 1, 9);

        // Every other piece of gap state goes with the wipe; the mark is a
        // point in the live race's distance and comes back with the driver.
        controller.__tick(gapTick(4, 2, RACING, true));
        expect(restartMark()).toBe(mark);

        elapseReplayGrace();
        controller.__tick(gapTick(5, 2, RACING));
        expect(restartMark()).toBe(mark);
      });
    });

    it("counts the caution's laps in the CANONICAL leader, not the front of the lineup", () => {
      // The lineup's front car (the player, line 0 row 1) and the canonical
      // leader (the rival, one lap further round) are deliberately different
      // cars — the disagreement the capture showed. Only the rival crosses, so
      // `caution.extraLap` fires if and only if the tick's real canonical order
      // reached the diff. Passing `null` runs it on the lineup fallback, where
      // the player's lap counter never moves and the extra lap is never seen.
      const controller = createMockController();
      controller.__setSessionInfo(ovalRace());
      const seen = recordStream();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      // A caution that is already static when the diff first sees it re-anchors
      // on the leader outright, so ONE later crossing is an extra lap.
      controller.__tick(cautionTick({ flags: RACING }));
      controller.__tick(
        cautionTick({
          flags: STATIC,
          progress: [
            [10, 0.5],
            [11, 0.99],
            [5, 0.5],
            [10, 0.5],
          ],
        }),
      );
      controller.__tick(
        cautionTick({
          flags: STATIC,
          progress: [
            [10, 0.52],
            [12, 0.01],
            [5, 0.52],
            [10, 0.52],
          ],
        }),
      );

      expect(seen).toEqual(["caution.extraLap"]);
    });

    describe("the readers", () => {
      it("report nothing before the translator is initialized", () => {
        expect(isUnderFullCourseCaution()).toBe(false);
        expect(getCautionPhase()).toBe("none");
        expect(getPaceLineup()).toBeNull();
        expect(getCautionEpisode()).toBeNull();
      });

      it("expose the episode only while a caution is out — one id from thrown to restarted, a new one for the next", () => {
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        controller.__tick(cautionTick({ flags: RACING }));
        expect(getCautionEpisode()).toBeNull();

        controller.__tick(cautionTick({ flags: WAVING }));
        const episode = getCautionEpisode();

        // The player holds line 0 row 1, right behind the pace car.
        expect(episode).toEqual({ id: expect.any(Number), firstFollowCarIdx: PACE });

        controller.__tick(cautionTick({ flags: STATIC }));
        expect(getCautionEpisode()).toEqual(episode);

        controller.__tick(cautionTick({ flags: RESTART }));
        expect(getCautionEpisode()).toBeNull();

        controller.__tick(cautionTick({ flags: RACING }));
        controller.__tick(cautionTick({ flags: WAVING }));
        expect(getCautionEpisode()?.id).not.toBe(episode?.id);
      });

      it("expose the phase itself — and the boolean is that phase not being none", () => {
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        controller.__tick(cautionTick({ flags: RACING }));
        expect(getCautionPhase()).toBe("none");

        controller.__tick(cautionTick({ flags: WAVING }));
        expect(getCautionPhase()).toBe("waving");

        controller.__tick(cautionTick({ flags: STATIC }));
        expect(getCautionPhase()).toBe("caught");

        controller.__tick(cautionTick({ flags: STATIC | Flags.OneLapToGreen }));
        expect(getCautionPhase()).toBe("one-to-go");
        expect(isUnderFullCourseCaution()).toBe(true);

        controller.__tick(cautionTick({ flags: RESTART }));
        expect(getCautionPhase()).toBe("none");
        expect(isUnderFullCourseCaution()).toBe(false);
      });

      it("resolve the lineup once per tick — the same object for every reader of that tick, a fresh one for the next", () => {
        // One expansion of a caution callout asks up to five times.
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        controller.__tick(cautionTick({ flags: STATIC }));
        const first = getPaceLineup();

        expect(first).not.toBeNull();
        expect(getPaceLineup()).toBe(first);

        controller.__tick(cautionTick({ flags: STATIC }));
        const second = getPaceLineup();

        expect(second).not.toBe(first);
        expect(second).toEqual(first);
      });

      it("report nothing before the first tick", () => {
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        expect(isUnderFullCourseCaution()).toBe(false);
        expect(getPaceLineup()).toBeNull();
      });

      it("track the episode from thrown to restarted", () => {
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        controller.__tick(cautionTick({ flags: RACING }));
        expect(isUnderFullCourseCaution()).toBe(false);

        controller.__tick(cautionTick({ flags: WAVING }));
        expect(isUnderFullCourseCaution()).toBe(true);

        controller.__tick(cautionTick({ flags: STATIC }));
        expect(isUnderFullCourseCaution()).toBe(true);

        controller.__tick(cautionTick({ flags: RESTART }));
        expect(isUnderFullCourseCaution()).toBe(false);
      });

      it("read the lineup live, off the latest tick", () => {
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        controller.__tick(cautionTick({ flags: STATIC }));

        // Player at line 0 row 1 behind the pace car, rival alongside at line 1
        // row 0 — the double-file front row.
        expect(getPaceLineup()).toEqual({
          followCarIdx: PACE,
          followCarNumber: "0",
          line: "inside",
          isLeader: true,
          followsPaceCar: true,
          doubleFile: true,
          lineupPosition: 1,
          anchor: "pace-car",
          paceFlags: { endOfLine: false, freePass: false, wavedAround: false },
        });
      });

      it("name the lanes only on an oval — the track category reaches the resolver", () => {
        // The discriminator for the `isOval` argument: a hardcoded `false` (or a
        // `true`) shows up here and nowhere else.
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace({ WeekendInfo: { Category: "Road", TrackType: "road course" } }));
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        controller.__tick(cautionTick({ flags: STATIC }));

        expect(getPaceLineup()?.line).toBeNull();
        expect(getPaceLineup()?.doubleFile).toBe(true);
      });

      it("report no lineup at all for a player the re-form has not placed", () => {
        // A car in the pits during the re-form holds no row, so there is no
        // place in the lineup to report. `null` here is what makes a `null`
        // elsewhere mean "the field is not lined up" rather than "we forgot".
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        // The first tick only seeds the diff, so the episode needs a second one
        // to reach a phase at all.
        controller.__tick(cautionTick({ flags: RACING }));
        controller.__tick(
          cautionTick({
            flags: STATIC,
            pace: [
              [-1, -1], // the player, still in the pits
              [1, 0],
              [0, 0],
              [1, 1],
            ],
          }),
        );

        expect(getPaceLineup()).toBeNull();
        // …while the episode itself carries on regardless.
        expect(isUnderFullCourseCaution()).toBe(true);
      });
    });

    // The lap that ENDS a caution is completed AFTER the green (issue #1127,
    // second review R16) — 2.2–5.1 s after each oval restart, the player at
    // 3.3 s and 2.3 s — so its `lap.completed` arrives with the caution gone
    // and the "is a caution out now" gates open. Driven through the committed
    // oval fixture rather than a synthetic lap, with the player's own lap
    // fields synthesised from car 0's scored laps (the capture recorded no
    // `LapLastLapTime`), and the clock following the capture so the lap
    // diff's standings wait times out the way it does with no results.
    describe("the lap that ends a caution", () => {
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

      /** A fixture tick as the player (car 0) would see it, per-car arrays widened to 72 slots. */
      function ovalTick(tick: OvalTick): TelemetryData {
        const widen = (values: number[], fill: number): number[] => {
          const out = new Array(72).fill(fill);

          values.forEach((v, i) => (out[i === FIXTURE_PACE_SLOT ? FIXTURE_PACE : i] = v));

          return out;
        };
        const lap = tick.CarIdxLapCompleted[0] ?? -1;

        return telemetry({
          SessionState: tick.SessionState,
          SessionFlags: tick.SessionFlags,
          SessionTime: tick.t,
          LapCompleted: lap,
          // Changes with every scored lap, which is what the lap diff waits
          // for; the value itself is never asserted on.
          LapLastLapTime: 30 + lap,
          CarIdxLapCompleted: widen(tick.CarIdxLapCompleted, -1),
          CarIdxTrackSurface: widen(tick.CarIdxTrackSurface, TrkLoc.OnTrack),
          CarIdxPaceLine: widen(tick.CarIdxPaceLine, -1),
          CarIdxPaceRow: widen(tick.CarIdxPaceRow, -1),
        });
      }

      it("marks the player's first lap after the green as a caution lap, and the next one — wholly under green — as clean", () => {
        vi.useFakeTimers();

        const controller = createMockController();
        controller.__setSessionInfo({
          WeekendInfo: { Category: "Oval", TrackType: "medium oval" },
          DriverInfo: { DriverCarIdx: 0, PaceCarIdx: FIXTURE_PACE, Drivers: [] },
          SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
        });
        const laps: Array<{ t: number; lap: number; wasCaution: boolean | undefined }> = [];
        const restarts: number[] = [];
        let now = 0;

        getEventBus().subscribe("lap.completed", (ev) =>
          laps.push({ t: now, lap: ev.data.lap, wasCaution: ev.data.wasCaution }),
        );
        getEventBus().subscribe("caution.restarted", () => restarts.push(now));
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        for (const tick of oval) {
          now = tick.t;
          vi.setSystemTime(1_700_000_000_000 + tick.t * 1000);
          controller.__tick(ovalTick(tick));
        }

        expect(restarts).toEqual([492.82, 872.45]);

        // Car 0 scores lap 5 at 496.08 — 3.3 s after the first restart — and
        // lap 6 at 533.30, before the second caution waves at 542.75. Lap 7
        // (574.40) is under that caution again. The events themselves land a
        // few seconds after each crossing, once the standings wait times out.
        const byLap = new Map(laps.map((l) => [l.lap, l]));

        expect(byLap.get(5)?.wasCaution).toBe(true);
        expect(byLap.get(5)?.t).toBeGreaterThan(492.82);
        expect(byLap.get(6)?.wasCaution).toBeUndefined();
        expect(byLap.get(7)?.wasCaution).toBe(true);
        // …and the lap that ends the second caution, scored 2.3 s after its
        // restart, carries it too.
        expect(byLap.get(11)?.wasCaution).toBe(true);
        expect(byLap.get(11)?.t).toBeGreaterThan(872.45);
      });
    });

    // `wipeStateForReplay` preserves `cautionPhase` but not
    // `cautionInitialized`, so the first tick back always re-SEEDS the caution
    // diff. What that seed does with the preserved phase decides both tests
    // below, and they want opposite things of it — hence the pair.
    describe("a replay glance", () => {
      /** Park the translator mid-caution, glance at the replay, and let the exit grace (#1324) run. */
      function glanceAtReplay(controller: MockController): void {
        controller.__tick(cautionTick({ flags: RACING }));
        controller.__tick(cautionTick({ flags: WAVING }));
        controller.__tick(cautionTick({ flags: STATIC }));
        controller.__tick(cautionTick({ flags: STATIC, replay: true }));
        elapseReplayGrace();
      }

      it("does not swallow a start-go edge when the caution ended during the glance", () => {
        // The seed expires a phase the flags contradict, so the phase is gone
        // on the FIRST tick back rather than the second. Without that, the
        // gantry diff reads the stale phase on the very next tick — it runs
        // before `diffCaution` — and suppresses a legitimate race start as if
        // it were a restart, losing the line for good.
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        const seen = recordStream();
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        glanceAtReplay(controller);

        // Back in the car, and the caution is gone — an admin re-grid, say.
        controller.__tick(cautionTick({ flags: RACING }));
        expect(isUnderFullCourseCaution()).toBe(false);

        controller.__tick(cautionTick({ flags: RESTART }));

        expect(seen).toContain("startLight.start-go.raised");
      });

      it("keeps the phase when the caution is still out, so the restart is still a restart", () => {
        // The positive control for the expiry above, and the reason the phase
        // is preserved across the wipe at all: come back to a caution that is
        // STILL running and the episode must survive intact — the restart that
        // ends it is announced as one, and the `StartGo` it carries stays
        // suppressed. An expiry that fired unconditionally would pass the test
        // above and fail this one.
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        const seen = recordStream();
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        glanceAtReplay(controller);

        controller.__tick(cautionTick({ flags: STATIC }));
        expect(isUnderFullCourseCaution()).toBe(true);

        controller.__tick(cautionTick({ flags: RESTART }));

        expect(seen).toContain("caution.restarted");
        expect(seen).not.toContain("startLight.start-go.raised");
        expect(isUnderFullCourseCaution()).toBe(false);
      });

      it("keeps the episode with the phase — the same caution, the same id and first follow car", () => {
        // A consumer keys what it remembers on the episode (issue #1286), so a
        // glance at the replay must not look like a new caution to it.
        const controller = createMockController();
        controller.__setSessionInfo(ovalRace());
        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        controller.__tick(cautionTick({ flags: RACING }));
        controller.__tick(cautionTick({ flags: WAVING }));
        controller.__tick(cautionTick({ flags: STATIC }));
        const before = getCautionEpisode();

        expect(before).toEqual({ id: expect.any(Number), firstFollowCarIdx: PACE });

        controller.__tick(cautionTick({ flags: STATIC, replay: true }));
        expect(getCautionEpisode()).toEqual(before);

        // The first tick back re-seeds the caution diff; the episode survives it.
        elapseReplayGrace();
        controller.__tick(cautionTick({ flags: STATIC }));
        expect(getCautionEpisode()).toEqual(before);

        controller.__tick(cautionTick({ flags: STATIC }));
        expect(getCautionEpisode()).toEqual(before);
      });
    });
  });

  describe("tire wear of a stop (issue #1108)", () => {
    const BASE = 1_700_000_000_000;

    /** The pit stream in publish order, envelope timestamps included. */
    function recordPitStream(): Array<{ name: string; timestamp: number; data: unknown }> {
      const seen: Array<{ name: string; timestamp: number; data: unknown }> = [];

      for (const name of [
        "pitStall.departed",
        "pitLane.exited",
        "pitService.readbackRequested",
        "tireWear.reported",
      ] as const) {
        getEventBus().subscribe(name, (ev) => seen.push({ name, timestamp: ev.timestamp, data: ev.data }));
      }

      return seen;
    }

    const isExit = (e: { name: string; data: unknown }): boolean =>
      e.name === "pitService.readbackRequested" && (e.data as { reason: string }).reason === "exit";

    it("flushes each stop's report right behind its exit readback, on the same tick, through the 2026-09-19 capture", () => {
      vi.useFakeTimers();

      type WearCaptureTick = { t: number } & Partial<TelemetryData>;
      const capture = JSON.parse(
        readFileSync(new URL("./diff/__fixtures__/tire-wear-stops-20260919.json", import.meta.url), "utf-8"),
      ) as WearCaptureTick[];
      const controller = createMockController();
      const seen = recordPitStream();

      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      // The capture records a tick only on a change; the sim keeps ticking in
      // between with the same values, and past its end (stop 2's pit exit) long
      // enough for the settle delay.
      capture.forEach(({ t: at, ...values }, i) => {
        const until = capture[i + 1]?.t ?? at + 6;

        for (let t = at; t < until - 1e-9; t += 0.25) {
          vi.setSystemTime(BASE + t * 1000);
          controller.__tick(telemetry(values));
        }
      });

      const exits = seen.flatMap((e, i) => (isExit(e) ? [i] : []));
      const reports = seen.flatMap((e, i) => (e.name === "tireWear.reported" ? [i] : []));

      expect(exits).toHaveLength(2);
      expect(reports).toEqual(exits.map((i) => i + 1));

      for (const i of reports) {
        expect(seen[i]!.timestamp).toBe(seen[i - 1]!.timestamp);
      }

      const first = seen[reports[0]!]!.data as TireWearReport;

      expect(first.heaviest).toEqual({ corner: "lf", zone: "inside" });
      expect(first.corners.lf.tread).toBeCloseTo(98.338, 3);
    });

    describe("a stored report does not outlive its session or a replay glance", () => {
      /** LF inside (R) the most worn, everything else fresher. */
      const WORN: Partial<TelemetryData> = {
        LFwearL: 0.95,
        LFwearM: 0.93,
        LFwearR: 0.9,
        RFwearL: 0.94,
        RFwearM: 0.95,
        RFwearR: 0.96,
        LRwearL: 0.97,
        LRwearM: 0.96,
        LRwearR: 0.96,
        RRwearL: 0.97,
        RRwearM: 0.97,
        RRwearR: 0.98,
      };

      /**
       * Drive into a stop and out again; `interrupt` runs between 5 and 7 s,
       * after the car left its box and while it is still on pit road.
       */
      function stopAndLeave(interrupt: (tickAt: (s: number, o: Partial<TelemetryData>) => void) => void) {
        vi.useFakeTimers();

        const controller = createMockController();
        const seen = recordPitStream();
        let sessionNum = 0;
        const tickAt = (s: number, overrides: Partial<TelemetryData>): void => {
          if (overrides.SessionNum !== undefined) sessionNum = overrides.SessionNum;

          vi.setSystemTime(BASE + s * 1000);
          controller.__tick(telemetry({ ...WORN, SessionNum: sessionNum, ...overrides }));
        };

        initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

        tickAt(0, {});
        tickAt(1, { PlayerTrackSurface: TrkLoc.AproachingPits });
        tickAt(2, { OnPitRoad: true, PlayerTrackSurface: TrkLoc.AproachingPits });
        tickAt(3, { OnPitRoad: true, PlayerCarInPitStall: true, PlayerTrackSurface: TrkLoc.InPitStall });
        tickAt(4, { OnPitRoad: true, PlayerCarInPitStall: true, PlayerTrackSurface: TrkLoc.InPitStall });
        tickAt(5, { OnPitRoad: true, PlayerTrackSurface: TrkLoc.InPitStall });
        interrupt(tickAt);
        tickAt(7, { PlayerTrackSurface: TrkLoc.AproachingPits });
        tickAt(12, {});

        return seen;
      }

      it("publishes when nothing intervenes (the control)", () => {
        const seen = stopAndLeave(() => {});

        expect(seen.filter(isExit)).toHaveLength(1);
        expect(seen.filter((e) => e.name === "tireWear.reported")).toHaveLength(1);
      });

      it("drops it on a session change between the box and pit exit, though the exit readback still fires", () => {
        const seen = stopAndLeave((tickAt) =>
          tickAt(6, { SessionNum: 1, OnPitRoad: true, PlayerTrackSurface: TrkLoc.AproachingPits }),
        );

        expect(seen.filter(isExit)).toHaveLength(1);
        expect(seen.filter((e) => e.name === "tireWear.reported")).toHaveLength(0);
      });

      it("drops it on a replay glance between the box and pit exit, though the exit readback still fires", () => {
        // The glance is over once the exit grace has run (#1324), so the car
        // is back live on pit road before the exit edge at 7 s.
        const seen = stopAndLeave((tickAt) => {
          tickAt(5.2, { IsReplayPlaying: true, OnPitRoad: true, PlayerTrackSurface: TrkLoc.AproachingPits });
          tickAt(6.5, { OnPitRoad: true, PlayerTrackSurface: TrkLoc.AproachingPits });
        });

        expect(seen.filter(isExit)).toHaveLength(1);
        expect(seen.filter((e) => e.name === "tireWear.reported")).toHaveLength(0);
      });
    });
  });

  describe("tire temperatures of the last stop (issue #254)", () => {
    /** A stint's worth of heat, every zone distinct. */
    const STINT: Partial<TelemetryData> = {
      LFtempCL: 71,
      LFtempCM: 78,
      LFtempCR: 84,
      RFtempCL: 86,
      RFtempCM: 79,
      RFtempCR: 72,
      LRtempCL: 68,
      LRtempCM: 74,
      LRtempCR: 77,
      RRtempCL: 79,
      RRtempCM: 75,
      RRtempCR: 69,
    };
    const STINT_READING = {
      corners: {
        lf: { outside: 71, middle: 78, inside: 84 },
        rf: { inside: 86, middle: 79, outside: 72 },
        lr: { outside: 68, middle: 74, inside: 77 },
        rr: { inside: 79, middle: 75, outside: 69 },
      },
    };

    /** Every zone of every tire at one temperature. */
    function uniform(celsius: number): Partial<TelemetryData> {
      return Object.fromEntries(Object.keys(STINT).map((field) => [field, celsius])) as Partial<TelemetryData>;
    }

    function uniformReading(celsius: number) {
      const zones = { inside: celsius, middle: celsius, outside: celsius };

      return { corners: { lf: zones, rf: zones, lr: zones, rr: zones } };
    }

    /** What iRacing places a car with. */
    const PLACED = uniform(39.9);
    /** What a car carries round the circuit: the values its last refresh left. */
    const CARRIED = uniform(55);

    const ON_PIT_ROAD: Partial<TelemetryData> = { OnPitRoad: true, PlayerTrackSurface: TrkLoc.AproachingPits };
    const IN_STALL: Partial<TelemetryData> = {
      OnPitRoad: true,
      PlayerCarInPitStall: true,
      PlayerTrackSurface: TrkLoc.InPitStall,
    };
    /** The tick the car leaves its box: out of the stall, still on pit road. */
    const LEAVING_STALL: Partial<TelemetryData> = { OnPitRoad: true, PlayerTrackSurface: TrkLoc.InPitStall };
    /** Out of the car: the garage, or the replay screen. */
    const OUT_OF_CAR: Partial<TelemetryData> = {
      IsReplayPlaying: true,
      IsOnTrack: false,
      PlayerTrackSurface: TrkLoc.NotInWorld,
    };

    function start(sessionInfo: Record<string, unknown> | null = null): MockController {
      const controller = createMockController();

      controller.__setSessionInfo(sessionInfo);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      return controller;
    }

    /**
     * A run on the circuit, then into the box, where the sim has refreshed the
     * values to `temps`, and out again; ends on the circuit.
     */
    function stop(controller: MockController, temps: Partial<TelemetryData>, base: Partial<TelemetryData> = {}): void {
      controller.__tick(telemetry({ ...base, ...CARRIED }));
      controller.__tick(telemetry({ ...base, ...ON_PIT_ROAD, ...CARRIED }));
      controller.__tick(telemetry({ ...base, ...IN_STALL, ...temps }));
      controller.__tick(telemetry({ ...base, ...LEAVING_STALL, ...temps }));
      controller.__tick(telemetry({ ...base, ...ON_PIT_ROAD, ...temps }));
      controller.__tick(telemetry({ ...base, ...temps }));
    }

    /** A placed stall visit holding `temps` (the car is already in its box), then out onto the circuit. */
    function sitAndLeave(controller: MockController, temps: Partial<TelemetryData>): void {
      controller.__tick(telemetry({ ...IN_STALL, ...temps }));
      controller.__tick(telemetry({ ...IN_STALL, ...temps }));
      controller.__tick(telemetry({ ...LEAVING_STALL, ...temps }));
      controller.__tick(telemetry({ ...temps }));
    }

    it("has no reading before the translator is initialized, or before the first stop", () => {
      expect(getLastStopTireTemps()).toBeNull();

      const controller = start();

      expect(getLastStopTireTemps()).toBeNull();

      controller.__tick(telemetry(STINT));
      controller.__tick(telemetry({ ...ON_PIT_ROAD, ...STINT }));
      controller.__tick(telemetry(STINT));

      expect(getLastStopTireTemps()).toBeNull();
    });

    it("reads a stop the driver drove into once, as the car stands in its box, and holds it", () => {
      const controller = start();

      controller.__tick(telemetry(PLACED));
      controller.__tick(telemetry({ ...ON_PIT_ROAD, ...PLACED }));
      // The arrival refresh, ahead of the stall flag.
      controller.__tick(telemetry({ ...ON_PIT_ROAD, ...STINT }));
      expect(getLastStopTireTemps()).toBeNull();

      controller.__tick(telemetry({ ...IN_STALL, ...STINT }));
      expect(getLastStopTireTemps()).toEqual(STINT_READING);

      // Nothing the box or the way out holds afterwards is followed.
      controller.__tick(telemetry({ ...IN_STALL, ...uniform(80) }));
      controller.__tick(telemetry({ ...LEAVING_STALL, ...uniform(80) }));
      controller.__tick(telemetry({ ...ON_PIT_ROAD, ...uniform(95) }));
      controller.__tick(telemetry(uniform(95)));
      expect(getLastStopTireTemps()).toEqual(STINT_READING);
    });

    it("takes none from a car that clips its box with nothing refreshed, and reads the stop after it", () => {
      const controller = start();

      controller.__tick(telemetry(PLACED));
      controller.__tick(telemetry({ ...ON_PIT_ROAD, ...PLACED }));
      controller.__tick(telemetry({ ...IN_STALL, ...PLACED }));
      controller.__tick(telemetry({ ...LEAVING_STALL, ...PLACED }));
      expect(getLastStopTireTemps()).toBeNull();

      // Reversed back in, and now the sim refreshes.
      controller.__tick(telemetry({ ...IN_STALL, ...STINT }));
      expect(getLastStopTireTemps()).toEqual(STINT_READING);
    });

    it("does not follow a second entry into the box before the car has been back on the circuit", () => {
      const controller = start();

      controller.__tick(telemetry(PLACED));
      controller.__tick(telemetry({ ...ON_PIT_ROAD, ...PLACED }));
      controller.__tick(telemetry({ ...IN_STALL, ...STINT }));
      // Pulled out onto pit road and backed in again, on the set the stop fitted.
      controller.__tick(telemetry({ ...LEAVING_STALL, ...STINT }));
      controller.__tick(telemetry({ ...ON_PIT_ROAD, ...PLACED }));
      controller.__tick(telemetry({ ...IN_STALL, ...PLACED }));
      controller.__tick(telemetry({ ...IN_STALL, ...uniform(45) }));
      expect(getLastStopTireTemps()).toEqual(STINT_READING);

      // Back on the circuit, the next stop is a reading again.
      controller.__tick(telemetry({ ...LEAVING_STALL, ...uniform(45) }));
      stop(controller, uniform(95));
      expect(getLastStopTireTemps()).toEqual(uniformReading(95));
    });

    it("is replaced by the next stop, and the snapshot's raw state carries it", () => {
      const controller = start();

      stop(controller, STINT);
      stop(controller, uniform(95));

      expect(getLastStopTireTemps()).toEqual(uniformReading(95));

      const snapshot = readSimState();

      expect(snapshot.initialized && snapshot.raw.state.lastStopTireTemps).toEqual(uniformReading(95));
    });

    it("shows nothing after connecting with the car in its box, until the next stop the driver drives into", () => {
      const controller = start();

      sitAndLeave(controller, STINT);
      expect(getLastStopTireTemps()).toBeNull();

      stop(controller, uniform(95));
      expect(getLastStopTireTemps()).toEqual(uniformReading(95));
    });

    it("survives a garage visit, and the Drive placement after it leaves the reading in place", () => {
      const controller = start();

      stop(controller, STINT);

      // Out of the car: replay-mode ticks, the sim still holding the stop's
      // values, then whatever the garage does to them.
      controller.__tick(telemetry({ ...OUT_OF_CAR, ...STINT }));
      controller.__tick(telemetry({ ...OUT_OF_CAR, ...uniform(60) }));
      expect(getLastStopTireTemps()).toEqual(STINT_READING);

      // "Drive": back in the car, placed in its box.
      elapseReplayGrace();
      sitAndLeave(controller, PLACED);
      expect(getLastStopTireTemps()).toEqual(STINT_READING);

      // The stop after it is a drive-in again.
      stop(controller, uniform(95));
      expect(getLastStopTireTemps()).toEqual(uniformReading(95));
    });

    it("takes the reading the sim refreshed as the driver left the car, and the Drive placement after it leaves it in place", () => {
      const controller = start();

      stop(controller, STINT);

      // The refresh lands on the first out-of-car tick; later ones are not read.
      controller.__tick(telemetry({ ...OUT_OF_CAR, ...uniform(60) }));
      expect(getLastStopTireTemps()).toEqual(uniformReading(60));

      controller.__tick(telemetry({ ...OUT_OF_CAR, ...uniform(70) }));
      expect(getLastStopTireTemps()).toEqual(uniformReading(60));

      elapseReplayGrace();
      sitAndLeave(controller, PLACED);
      expect(getLastStopTireTemps()).toEqual(uniformReading(60));
    });

    it("takes none on leaving the car without a run on the circuit", () => {
      const controller = start();

      // A garage start, down pit road and no further.
      controller.__tick(telemetry({ ...IN_STALL, ...PLACED }));
      controller.__tick(telemetry({ ...LEAVING_STALL, ...PLACED }));
      controller.__tick(telemetry({ ...ON_PIT_ROAD, ...PLACED }));
      controller.__tick(telemetry({ ...OUT_OF_CAR, ...uniform(60) }));

      expect(getLastStopTireTemps()).toBeNull();
    });

    it("survives a replay glance mid-session", () => {
      const controller = start();

      stop(controller, STINT);
      controller.__tick(telemetry({ IsReplayPlaying: true, ...STINT }));
      controller.__tick(telemetry({ IsReplayPlaying: true, ...uniform(60) }));
      expect(getLastStopTireTemps()).toEqual(STINT_READING);

      elapseReplayGrace();
      controller.__tick(telemetry(uniform(60)));
      controller.__tick(telemetry(uniform(60)));
      expect(getLastStopTireTemps()).toEqual(STINT_READING);
    });

    it("is taken from a tow into the box, once", () => {
      const controller = start();

      stop(controller, STINT);
      // Towed: the car leaves the world, the values already refreshed, then
      // appears in its box.
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.NotInWorld, ...uniform(95) }));
      expect(getLastStopTireTemps()).toEqual(STINT_READING);

      controller.__tick(telemetry({ ...IN_STALL, ...uniform(95) }));
      expect(getLastStopTireTemps()).toEqual(uniformReading(95));

      // Whatever the box holds afterwards is not followed.
      sitAndLeave(controller, PLACED);
      expect(getLastStopTireTemps()).toEqual(uniformReading(95));
    });

    it("is taken from a reset that puts the car straight from the circuit into its box", () => {
      const controller = start();

      stop(controller, STINT);
      sitAndLeave(controller, uniform(95));

      expect(getLastStopTireTemps()).toEqual(uniformReading(95));
    });

    it("is left in place by a tow whose values are the ones the car carried on the circuit", () => {
      const controller = start();

      stop(controller, STINT);
      controller.__tick(telemetry({ PlayerTrackSurface: TrkLoc.NotInWorld, ...STINT }));
      sitAndLeave(controller, STINT);

      expect(getLastStopTireTemps()).toEqual(STINT_READING);
    });

    type TempsCaptureTick = { t: number } & Partial<TelemetryData>;

    /**
     * Replay one of the 2026-10-11 captures through the translator. They record
     * a tick only on a change; the sim keeps ticking in between with the same
     * values, and past the capture's end. Returns the capture and, for each new
     * reading, the capture time at which it first showed with its LF outside zone.
     */
    function replayCapture(fixture: string): {
      capture: TempsCaptureTick[];
      taken: Array<{ t: number; lfOutside: number }>;
    } {
      vi.useFakeTimers();

      const capture = JSON.parse(
        readFileSync(new URL(`./diff/__fixtures__/${fixture}`, import.meta.url), "utf-8"),
      ) as TempsCaptureTick[];
      const BASE = 1_700_000_000_000;
      const controller = start();
      const taken: Array<{ t: number; lfOutside: number }> = [];

      capture.forEach(({ t: at, ...values }, i) => {
        const until = capture[i + 1]?.t ?? at + 2;

        for (let t = at; t < until - 1e-9; t += 0.25) {
          vi.setSystemTime(BASE + t * 1000);
          controller.__tick(telemetry(values));

          const lfOutside = getLastStopTireTemps()?.corners.lf.outside;

          if (lfOutside !== undefined && lfOutside !== taken.at(-1)?.lfOutside) taken.push({ t: at, lfOutside });
        }
      });

      return { capture, taken };
    }

    it("reads two stops, a reset and a return to the garage through the 2026-10-11 capture", () => {
      const { capture, taken } = replayCapture("tire-temps-stops-20261011.json");
      const valuesAt = (t: number): TempsCaptureTick => capture.find((tick) => tick.t === t)!;

      // Each reading shows on the first tick its rule allows, with the values
      // the sim refreshed just before: stop 1 and stop 2 as the car enters its
      // box (refreshed 0.05 s and 0.4 s earlier), the reset as the car stands
      // in its box (refreshed one tick earlier), the garage on its own tick.
      expect(taken).toEqual([
        { t: 342.3, lfOutside: valuesAt(342.25).LFtempCL },
        { t: 540.2, lfOutside: valuesAt(539.8).LFtempCL },
        { t: 618.02, lfOutside: valuesAt(618).LFtempCL },
        { t: 668.83, lfOutside: valuesAt(668.83).LFtempCL },
      ]);

      expect(getLastStopTireTemps()).toEqual({
        corners: {
          lf: { outside: 51.256500244140625, middle: 51.7762451171875, inside: 52.127410888671875 },
          rf: { inside: 51.64166259765625, middle: 51.31304931640625, outside: 50.7257080078125 },
          lr: { outside: 51.646209716796875, middle: 52.248687744140625, inside: 52.5394287109375 },
          rr: { inside: 52.006866455078125, middle: 51.6771240234375, outside: 50.87353515625 },
        },
      });
    });

    it("reads a stop and a timed tow through the 2026-10-11 tow capture", () => {
      const { capture, taken } = replayCapture("tire-temps-tow-20261011.json");
      const valuesAt = (t: number): TempsCaptureTick => capture.find((tick) => tick.t === t)!;

      // The stop as the car enters its box, and the tow on the first tick the
      // car stands in its box — 73 s before the tow has been served. Nothing
      // else in the 73 s, nor the pit service that follows, takes another.
      expect(taken).toEqual([
        { t: 209.85, lfOutside: valuesAt(209.48).LFtempCL },
        { t: 295.03, lfOutside: valuesAt(295.02).LFtempCL },
      ]);

      // The tow's own values, each zone named from the car's centreline.
      const tow = valuesAt(295.02);

      expect(getLastStopTireTemps()).toEqual({
        corners: {
          lf: { outside: tow.LFtempCL, middle: tow.LFtempCM, inside: tow.LFtempCR },
          rf: { inside: tow.RFtempCL, middle: tow.RFtempCM, outside: tow.RFtempCR },
          lr: { outside: tow.LRtempCL, middle: tow.LRtempCM, inside: tow.LRtempCR },
          rr: { inside: tow.RRtempCL, middle: tow.RRtempCM, outside: tow.RRtempCR },
        },
      });
      expect(tow.LFtempCR).toBeGreaterThan(70);
    });

    it("survives a session change, live or through replay-mode ticks", () => {
      const controller = start();

      stop(controller, STINT);

      controller.__tick(telemetry({ SessionNum: 1, ...uniform(60) }));
      expect(getLastStopTireTemps()).toEqual(STINT_READING);

      // The next session loads behind replay-mode ticks.
      controller.__tick(telemetry({ SessionNum: 1, ...OUT_OF_CAR, ...uniform(60) }));
      controller.__tick(telemetry({ SessionNum: 2, ...OUT_OF_CAR, ...uniform(60) }));
      expect(getLastStopTireTemps()).toEqual(STINT_READING);

      elapseReplayGrace();
      controller.__tick(telemetry({ SessionNum: 2, ...IN_STALL, ...PLACED }));
      controller.__tick(telemetry({ SessionNum: 2, ...LEAVING_STALL, ...PLACED }));
      expect(getLastStopTireTemps()).toEqual(STINT_READING);

      // The new session's first stop replaces it.
      stop(controller, uniform(95), { SessionNum: 2 });
      expect(getLastStopTireTemps()).toEqual(uniformReading(95));
    });

    it("reads the run a session change ends, on the tick it takes the driver out of the car", () => {
      const controller = start();

      stop(controller, STINT);
      controller.__tick(telemetry(STINT));

      // One tick carries the new session, the first replay-mode tick and the
      // sim's leaving-the-car refresh.
      controller.__tick(telemetry({ SessionNum: 1, ...OUT_OF_CAR, ...uniform(60) }));
      expect(getLastStopTireTemps()).toEqual(uniformReading(60));

      // The run is over: the new session's placement takes none.
      elapseReplayGrace();
      controller.__tick(telemetry({ SessionNum: 1, ...IN_STALL, ...PLACED }));
      expect(getLastStopTireTemps()).toEqual(uniformReading(60));
    });

    it("reads a stop the session changed on the way into", () => {
      const controller = start();

      controller.__tick(telemetry(CARRIED));
      controller.__tick(telemetry({ ...ON_PIT_ROAD, ...CARRIED }));
      controller.__tick(telemetry({ SessionNum: 1, ...ON_PIT_ROAD, ...CARRIED }));
      controller.__tick(telemetry({ SessionNum: 1, ...IN_STALL, ...STINT }));

      expect(getLastStopTireTemps()).toEqual(STINT_READING);
    });

    it("is cleared by a disconnect, and a reconnect mid-session shows nothing until the next stop", () => {
      const controller = start();

      stop(controller, STINT);
      expect(getLastStopTireTemps()).toEqual(STINT_READING);

      controller.__tick(null, false);
      expect(getLastStopTireTemps()).toBeNull();

      // Reconnected on the circuit, the sim still holding the stop's values.
      controller.__tick(telemetry(STINT));
      controller.__tick(telemetry(STINT));
      expect(getLastStopTireTemps()).toBeNull();

      stop(controller, uniform(95));
      expect(getLastStopTireTemps()).toEqual(uniformReading(95));
    });

    it("never takes a reading in a saved replay, even from a stop on live-looking ticks", () => {
      const controller = start({ WeekendInfo: { SimMode: "replay" } });

      stop(controller, STINT);
      controller.__tick(telemetry({ IsReplayPlaying: true, ...IN_STALL, ...STINT }));

      expect(getLastStopTireTemps()).toBeNull();
    });

    it("is cleared by a saved replay, and stays cleared after it", () => {
      const controller = start({ WeekendInfo: { SimMode: "full" } });

      stop(controller, STINT);
      expect(getLastStopTireTemps()).toEqual(STINT_READING);

      controller.__setSessionInfo({ WeekendInfo: { SimMode: "replay" } });
      controller.__tick(telemetry(STINT));
      expect(getLastStopTireTemps()).toBeNull();

      controller.__setSessionInfo({ WeekendInfo: { SimMode: "full" } });
      elapseReplayGrace();
      controller.__tick(telemetry(STINT));
      controller.__tick(telemetry(STINT));
      expect(getLastStopTireTemps()).toBeNull();
    });

    it("is cleared by a saved replay loaded while the driver was already out of the car", () => {
      const controller = start({ WeekendInfo: { SimMode: "full" } });

      stop(controller, STINT);
      controller.__tick(telemetry({ ...OUT_OF_CAR, ...STINT }));
      expect(getLastStopTireTemps()).toEqual(STINT_READING);

      // No replay entry edge here: the guard already held.
      controller.__setSessionInfo({ WeekendInfo: { SimMode: "replay" } });
      controller.__tick(telemetry({ ...OUT_OF_CAR, ...STINT }));
      expect(getLastStopTireTemps()).toBeNull();
    });
  });

  describe("the rolling-start formation (issue #1167)", () => {
    const PLAYER = 2;
    const PACE = 3;
    const FORMATION = Flags.OneLapToGreen | Flags.Servicible | Flags.StartReady;
    const GREEN_HELD = FORMATION | Flags.GreenHeld;
    const GO = Flags.Green | Flags.Servicible | Flags.StartGo;

    function rollingRace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        WeekendInfo: { Category: "Oval", TrackType: "medium oval", WeekendOptions: { StandingStart: 0 } },
        DriverInfo: {
          DriverCarIdx: PLAYER,
          PaceCarIdx: PACE,
          Drivers: [
            { CarIdx: 0, CarNumber: "96" },
            { CarIdx: 1, CarNumber: "37" },
            { CarIdx: PLAYER, CarNumber: "64" },
            { CarIdx: PACE, CarNumber: "0", CarIsPaceCar: 1 },
          ],
        },
        SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
        ...overrides,
      };
    }

    /**
     * Per-car `[paceLine, paceRow]`: car 0 on pole, car 1 alongside, the player
     * behind car 0, the pace car unplaced, and car 4 behind car 1 — two cars to
     * a line, the smallest grid the reader places in full.
     */
    const GRID: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, -1],
      [1, 1],
    ];
    /** The same grid with cars 0 and 1 exchanged, so the player is behind car 1. */
    const RESHUFFLED: Array<[number, number]> = [
      [1, 0],
      [0, 0],
      [0, 1],
      [-1, -1],
      [1, 1],
    ];

    type FormationTick = {
      state?: SessionState;
      flags?: number;
      grid?: Array<[number, number]>;
      replay?: boolean;
    };

    function formationTick({
      state = SessionState.ParadeLaps,
      flags = FORMATION,
      grid = GRID,
      replay,
    }: FormationTick = {}): TelemetryData {
      return telemetry({
        SessionState: state,
        SessionFlags: flags,
        SessionTime: 150,
        CarIdxPaceLine: grid.map(([line]) => line),
        CarIdxPaceRow: grid.map(([, row]) => row),
        ...(replay === undefined ? {} : { IsReplayPlaying: replay }),
      });
    }

    const WARMUP = formationTick({ state: SessionState.Warmup });

    /** Records the formation's stream in publish order, as event names. */
    function recordFormation(): string[] {
      const seen: string[] = [];
      const bus = getEventBus();

      for (const name of [
        "rollingStart.pace-car-moving.raised",
        "rollingStart.lineup.changed",
        "paceCar.deployed",
        "paceCar.off",
        "flag.green-held.raised",
        "startLight.start-go.raised",
        "caution.restarted",
        "caution.lineup.changed",
      ] as const) {
        bus.subscribe(name, () => seen.push(name));
      }

      return seen;
    }

    function start(sessionInfo = rollingRace()): { controller: MockController; seen: string[] } {
      const controller = createMockController();

      controller.__setSessionInfo(sessionInfo);

      const seen = recordFormation();

      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      return { controller, seen };
    }

    it("reports no formation before the translator is initialized", () => {
      expect(isRollingStartFormation()).toBe(false);
      expect(getRollingStartFormation()).toBeNull();
    });

    it("opens with the pace car moving, names the car ahead as the first follow car, and ends when the green is held", () => {
      const { controller, seen } = start();

      controller.__tick(WARMUP);
      expect(getRollingStartFormation()).toBeNull();

      controller.__tick(formationTick());

      const formation = getRollingStartFormation();

      expect(seen).toEqual(["rollingStart.pace-car-moving.raised"]);
      expect(formation).toEqual({ id: expect.any(Number), firstFollowCarIdx: 0 });
      expect(isRollingStartFormation()).toBe(true);

      controller.__tick(formationTick());
      expect(getRollingStartFormation()).toEqual(formation);

      controller.__tick(formationTick({ flags: GREEN_HELD }));
      expect(getRollingStartFormation()).toBeNull();
      expect(isRollingStartFormation()).toBe(false);
    });

    it("publishes a change of the car ahead, and keeps the first follow car where it was", () => {
      const { controller, seen } = start();

      controller.__tick(WARMUP);
      controller.__tick(formationTick());

      const formation = getRollingStartFormation();

      controller.__tick(formationTick({ grid: RESHUFFLED }));

      expect(seen).toEqual(["rollingStart.pace-car-moving.raised", "rollingStart.lineup.changed"]);
      expect(getRollingStartFormation()).toEqual(formation);
      // The lineup the callout reads when it speaks is the live one.
      expect(getPaceLineup()).toMatchObject({ followCarIdx: 1, followCarNumber: "37", anchor: "grid" });
    });

    it("answers the readers from inside the handlers of its own events — the formation is open before either is published", () => {
      // A contract's speak gate runs on the first attempt, at publish. Read
      // from a subscriber, the formation that the cue opens must already be
      // there, with the car to name; and at a change, the live lineup must
      // already be the new one.
      const { controller } = start();
      const atPublish: Array<Record<string, unknown>> = [];

      getEventBus().subscribe("rollingStart.pace-car-moving.raised", () =>
        atPublish.push({
          event: "pace-car-moving",
          running: isRollingStartFormation(),
          formation: getRollingStartFormation(),
          follow: getPaceLineup()?.followCarIdx,
        }),
      );
      getEventBus().subscribe("rollingStart.lineup.changed", () =>
        atPublish.push({
          event: "lineup.changed",
          running: isRollingStartFormation(),
          formation: getRollingStartFormation(),
          follow: getPaceLineup()?.followCarIdx,
        }),
      );

      controller.__tick(WARMUP);
      controller.__tick(formationTick());
      controller.__tick(formationTick({ grid: RESHUFFLED }));

      const formation = { id: expect.any(Number), firstFollowCarIdx: 0 };

      expect(atPublish).toEqual([
        { event: "pace-car-moving", running: true, formation, follow: 0 },
        { event: "lineup.changed", running: true, formation, follow: 1 },
      ]);
    });

    it("carries nothing on the change — the callout reads the lineup live", () => {
      const { controller } = start();
      const payloads: unknown[] = [];

      getEventBus().subscribe("rollingStart.lineup.changed", (event) => payloads.push(event.data));

      controller.__tick(WARMUP);
      controller.__tick(formationTick());
      controller.__tick(formationTick({ grid: RESHUFFLED }));

      expect(payloads).toEqual([{}]);
    });

    it("never opens on a standing start", () => {
      const { controller, seen } = start(
        rollingRace({ WeekendInfo: { Category: "Road", WeekendOptions: { StandingStart: 1 } } }),
      );

      controller.__tick(WARMUP);
      controller.__tick(formationTick());
      controller.__tick(formationTick({ grid: RESHUFFLED }));

      expect(seen).toEqual([]);
      expect(getRollingStartFormation()).toBeNull();
    });

    it("holds its last answer through a tick that carries no telemetry", () => {
      const { controller } = start();

      controller.__tick(WARMUP);
      controller.__tick(formationTick());

      const formation = getRollingStartFormation();

      // Connected, and nothing to read: no diff runs, so nothing can end it.
      controller.__tick(null, true);
      controller.__tick(null, true);

      expect(getRollingStartFormation()).toEqual(formation);
      expect(isRollingStartFormation()).toBe(true);
    });

    it("forgets the formation when the sim goes away", () => {
      const { controller } = start();

      controller.__tick(WARMUP);
      controller.__tick(formationTick());
      controller.__tick(null, false);

      expect(getRollingStartFormation()).toBeNull();
    });

    it("adopts a formation already running when the plugin starts mid-parade, silently — and reports a change from there", () => {
      const { controller, seen } = start();

      controller.__tick(formationTick());

      expect(seen).toEqual([]);
      expect(getRollingStartFormation()).toEqual({ id: expect.any(Number), firstFollowCarIdx: 0 });

      controller.__tick(formationTick({ grid: RESHUFFLED }));
      expect(seen).toEqual(["rollingStart.lineup.changed"]);
    });

    it("adopts nothing when the plugin starts with the green already held", () => {
      const { controller, seen } = start();

      controller.__tick(formationTick({ flags: GREEN_HELD }));
      controller.__tick(formationTick({ flags: GREEN_HELD, grid: RESHUFFLED }));

      expect(seen).toEqual([]);
      expect(getRollingStartFormation()).toBeNull();
    });

    describe("across a replay glance", () => {
      it("is the same formation during the glance and after it, and the cue does not fire again", () => {
        const { controller, seen } = start();

        controller.__tick(WARMUP);
        controller.__tick(formationTick());

        const formation = getRollingStartFormation();

        controller.__tick(formationTick({ replay: true }));
        expect(getRollingStartFormation()).toEqual(formation);

        // The first tick back re-seeds the rolling-start diff; the formation survives it.
        elapseReplayGrace();
        controller.__tick(formationTick());
        expect(getRollingStartFormation()).toEqual(formation);

        controller.__tick(formationTick());
        expect(getRollingStartFormation()).toEqual(formation);
        expect(seen).toEqual(["rollingStart.pace-car-moving.raised"]);
      });

      it("does not announce a change that happened during the glance, and does announce the next one", () => {
        const { controller, seen } = start();

        controller.__tick(WARMUP);
        controller.__tick(formationTick());
        controller.__tick(formationTick({ replay: true }));
        elapseReplayGrace();

        // Back in the car behind a different car: the baseline, not a change.
        controller.__tick(formationTick({ grid: RESHUFFLED }));
        controller.__tick(formationTick({ grid: RESHUFFLED }));
        expect(seen).toEqual(["rollingStart.pace-car-moving.raised"]);
        // The formation's first follow car is still the one it opened behind.
        expect(getRollingStartFormation()?.firstFollowCarIdx).toBe(0);

        controller.__tick(formationTick());
        expect(seen).toEqual(["rollingStart.pace-car-moving.raised", "rollingStart.lineup.changed"]);
      });

      it("is over on the first tick back when the green was held during the glance", () => {
        const { controller } = start();

        controller.__tick(WARMUP);
        controller.__tick(formationTick());
        controller.__tick(formationTick({ replay: true }));
        expect(isRollingStartFormation()).toBe(true);

        elapseReplayGrace();
        controller.__tick(formationTick({ flags: GREEN_HELD }));

        expect(getRollingStartFormation()).toBeNull();
      });

      it("is over on the first tick back when the race started during the glance — and the start's go is not replayed", () => {
        const { controller, seen } = start();

        controller.__tick(WARMUP);
        controller.__tick(formationTick());
        controller.__tick(formationTick({ replay: true }));
        elapseReplayGrace();
        controller.__tick(formationTick({ state: SessionState.Racing, flags: GO }));

        expect(getRollingStartFormation()).toBeNull();
        expect(seen).toEqual(["rollingStart.pace-car-moving.raised"]);
      });
    });

    describe("the 2026-09-17 capture, replayed", () => {
      type CapturedTick = {
        t: number;
        SessionFlags: number;
        SessionState: number;
        PaceMode: number;
        PitsOpen: boolean;
        OnPitRoad: boolean;
        Lap: number;
        LapCompleted: number;
        CarIdxPaceLine: number[];
        CarIdxPaceRow: number[];
        CarIdxLapCompleted: number[];
        CarIdxTrackSurface: number[];
        CarIdxPosition: number[];
      };
      const capture = JSON.parse(
        readFileSync(new URL("./diff/__fixtures__/rolling-start-formation-20260917.json", import.meta.url), "utf-8"),
      ) as { sessionInfo: Record<string, unknown>; ticks: CapturedTick[] };

      /** A fixture tick as the player (car 0) sees it: slot 20 is the pace car, raw index 64. */
      function capturedTick(tick: CapturedTick): TelemetryData {
        const widen = (values: number[], fill: number): number[] => {
          const out = new Array(72).fill(fill);

          values.forEach((v, i) => (out[i === 20 ? 64 : i] = v));

          return out;
        };

        return telemetry({
          SessionState: tick.SessionState,
          SessionFlags: tick.SessionFlags,
          SessionTime: tick.t,
          PaceMode: tick.PaceMode,
          PitsOpen: tick.PitsOpen,
          OnPitRoad: tick.OnPitRoad,
          Lap: tick.Lap,
          LapCompleted: tick.LapCompleted,
          CarIdxPaceLine: widen(tick.CarIdxPaceLine, -1),
          CarIdxPaceRow: widen(tick.CarIdxPaceRow, -1),
          CarIdxLapCompleted: widen(tick.CarIdxLapCompleted, -1),
          CarIdxTrackSurface: widen(tick.CarIdxTrackSurface, TrkLoc.NotInWorld),
          CarIdxPosition: widen(tick.CarIdxPosition, 0),
        });
      }

      /** Replays the whole fixture, recording what was published on each tick and the formation after it. */
      function replay(): {
        published: Array<[t: number, event: string]>;
        formations: Array<[t: number, formation: ReturnType<typeof getRollingStartFormation>]>;
      } {
        const { controller, seen } = start(capture.sessionInfo);
        const published: Array<[number, string]> = [];
        const formations: Array<[number, ReturnType<typeof getRollingStartFormation>]> = [];

        for (const tick of capture.ticks) {
          const before = seen.length;

          controller.__tick(capturedTick(tick));

          for (const event of seen.slice(before)) published.push([tick.t, event]);

          // One derivation: the boolean is the identity not being null, on every tick.
          expect(isRollingStartFormation()).toBe(getRollingStartFormation() !== null);
          formations.push([tick.t, getRollingStartFormation()]);
        }

        return { published, formations };
      }

      it("emits the pace car moving, its deployment, green held, its exit and the start's go — and not one lineup change", () => {
        // The formation's lineup never moved (the fixture's own test), so
        // `rollingStart.lineup.changed` has nothing to report; and from 203.87 s
        // the rows renumber on almost every tick, with the formation long over.
        expect(replay().published).toEqual([
          [126.67, "rollingStart.pace-car-moving.raised"],
          [132.35, "paceCar.deployed"],
          [186.28, "flag.green-held.raised"],
          [196.53, "paceCar.off"],
          [201.18, "startLight.start-go.raised"],
        ]);
      });

      it("keeps the start's go clear of the caution restart path — no caution phase, no restart, the go line spoken", () => {
        // A formation carries no caution bit, so the green that ends it finds
        // no caution episode: `caution.restarted` is not announced and
        // `startLight.start-go.raised` is not held down for it.
        const { published } = replay();
        const names = published.map(([, event]) => event);

        expect(names).toContain("startLight.start-go.raised");
        expect(names).not.toContain("caution.restarted");
        expect(getCautionPhase()).toBe("none");
        expect(getCautionEpisode()).toBeNull();
      });

      it("runs one formation from the ParadeLaps entry at 126.67 s until the green is held at 186.28 s, behind car 07", () => {
        const { formations } = replay();
        const running = formations.filter(([, formation]) => formation !== null);

        expect(running[0][0]).toBe(126.67);
        expect(running.at(-1)?.[0]).toBe(142.48); // the last tick before 186.28
        expect(formations.find(([t]) => t === 186.28)?.[1]).toBeNull();
        // No tick outside that stretch has one, on either side.
        expect(formations.filter(([t, formation]) => (formation !== null) !== (t >= 126.67 && t < 186.28))).toEqual([]);

        // One formation, one id, and the player's first follow car is car index 9.
        const [, first] = running[0];

        expect(first).toEqual({ id: expect.any(Number), firstFollowCarIdx: 9 });
        expect(
          running.every(([, formation]) => formation?.id === first?.id && formation?.firstFollowCarIdx === 9),
        ).toBe(true);
      });

      it("shows the formation in the Telemetry Snapshot beside the caution, as its accessor reports it", () => {
        const { controller } = start(capture.sessionInfo);

        for (const tick of capture.ticks) {
          if (tick.t > 142.48) break;

          controller.__tick(capturedTick(tick));
        }

        const state = readSimState();

        if (!state.initialized || !("rollingStart" in state)) throw new Error("the curated half is missing");

        expect(state.rollingStart.formation).not.toBeNull();
        expect(state.rollingStart).toEqual({ formation: getRollingStartFormation() });
        expect(state.caution.lineup).toMatchObject({ followCarNumber: "07", line: "inside", anchor: "grid" });
        expect(state.raw.state.rollingStartFormationId).toBe(state.rollingStart.formation?.id);
      });
    });
  });

  describe("caution catch-up (issue #1168)", () => {
    const PLAYER = 6;
    const PACE = 64;
    const STATIC = Flags.Caution | Flags.Servicible | Flags.StartHidden;
    const WAVING = Flags.CautionWaving | Flags.Servicible | Flags.StartHidden;
    const RACING = Flags.Servicible | Flags.StartHidden;

    /** A 1 km oval, so a lap fraction × 1000 is metres. */
    function ovalRace(): Record<string, unknown> {
      return {
        WeekendInfo: { Category: "Oval", TrackType: "medium oval", TrackLength: "1.00 km" },
        DriverInfo: {
          DriverCarIdx: PLAYER,
          PaceCarIdx: PACE,
          Drivers: [
            { CarIdx: 5, CarNumber: "95" },
            { CarIdx: PLAYER, CarNumber: "64" },
            { CarIdx: PACE, CarNumber: "0", CarIsPaceCar: 1 },
          ],
        },
        SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
      };
    }

    type Field = {
      flags?: number;
      /** How far the player, and the cars behind him, have dropped back — metres. */
      back?: number;
      onPitRoad?: boolean;
      paceFlags?: number;
      replay?: boolean;
      sessionNum?: number;
    };

    /**
     * A single-file caution: the pace car at line 0 row 0, ten cars behind it
     * 10 m apart, the player sixth. His ratio is `(10 + back) / 10`.
     */
    function field({
      flags = STATIC,
      back = 0,
      onPitRoad = false,
      paceFlags = 0,
      replay,
      sessionNum,
    }: Field = {}): TelemetryData {
      const lines = new Array(72).fill(-1);
      const rows = new Array(72).fill(-1);
      const dist = new Array(72).fill(-1);
      const surface = new Array(72).fill(TrkLoc.NotInWorld);
      const pace = new Array(72).fill(0);

      lines[PACE] = 0;
      rows[PACE] = 0;
      dist[PACE] = 0.5;
      surface[PACE] = TrkLoc.OnTrack;

      for (let car = 1; car <= 10; car++) {
        lines[car] = 0;
        rows[car] = car;
        dist[car] = (480 - 10 * (car - 1) - (car >= PLAYER ? back : 0)) / 1000;
        surface[car] = TrkLoc.OnTrack;
      }

      pace[PLAYER] = paceFlags;

      return telemetry({
        SessionState: SessionState.Racing,
        SessionFlags: flags,
        SessionTime: 600,
        OnPitRoad: onPitRoad,
        CarIdxPaceLine: lines,
        CarIdxPaceRow: rows,
        CarIdxPaceFlags: pace,
        CarIdxLapDistPct: dist,
        CarIdxTrackSurface: surface,
        ...(replay === undefined ? {} : { IsReplayPlaying: replay }),
        ...(sessionNum === undefined ? {} : { SessionNum: sessionNum }),
      });
    }

    const OPEN: Field = { back: 30 }; // 4×
    const BAND: Field = { back: 10 }; // 2×
    const CLOSED: Field = { back: 0 }; // 1×

    type Drive = {
      controller: MockController;
      seen: string[];
      /** One tick, `ms` of fake time after the last. */
      tick: (f?: Field, ms?: number) => void;
      /** The same field on every tick for `ms`. */
      hold: (f: Field, ms: number, step?: number) => void;
      /** Seed, wave, pick up, and sit in place through the settle window. */
      caught: (f?: Field) => void;
    };

    function drive(): Drive {
      vi.useFakeTimers();
      vi.setSystemTime(1_800_000_000_000);

      const controller = createMockController();

      controller.__setSessionInfo(ovalRace());

      const seen: string[] = [];

      for (const name of ["caution.gapOpened", "caution.gapStillOpen"] as const) {
        getEventBus().subscribe(name, () => seen.push(name));
      }

      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      const tick: Drive["tick"] = (f = {}, ms = 100) => {
        vi.advanceTimersByTime(ms);
        controller.__tick(field(f));
      };
      const hold: Drive["hold"] = (f, ms, step = 500) => {
        for (let elapsed = step; elapsed <= ms; elapsed += step) tick(f, step);
      };
      const caught: Drive["caught"] = (f = CLOSED) => {
        tick({ ...f, flags: RACING });
        tick({ ...f, flags: WAVING });
        tick({ ...f, flags: STATIC });
        hold(f, CATCH_UP_SETTLE_MS);
      };

      return { controller, seen, tick, hold, caught };
    }

    it("has no answer before the translator is initialized, or without a lineup", () => {
      expect(getCautionGap()).toBeNull();

      const d = drive();

      // Racing with nobody lined up: no lineup, so no car to close up on.
      d.controller.__tick(telemetry({ SessionState: SessionState.Racing, SessionFlags: RACING }));
      expect(getCautionGap()).toBeNull();
    });

    it("emits the first call after the settle window and the dwell, and a reminder one interval later — the track length reaches the diff", () => {
      const d = drive();

      d.caught(OPEN);
      expect(d.seen).toEqual([]);

      d.hold(OPEN, CATCH_UP_DWELL_MS + 500);
      expect(d.seen).toEqual(["caution.gapOpened"]);

      d.hold(OPEN, CATCH_UP_REMINDER_MS);
      expect(d.seen).toEqual(["caution.gapOpened", "caution.gapStillOpen"]);
    });

    it("says nothing for a field in place", () => {
      const d = drive();

      d.caught();
      d.hold(CLOSED, 60_000);

      expect(d.seen).toEqual([]);
      expect(getCautionGap()).toMatchObject({ warranted: false, blockedBy: [] });
    });

    it("already answers warranted from inside the handlers of both events — the gate is asked at publish", () => {
      const d = drive();
      const atPublish: Array<Record<string, unknown>> = [];

      for (const name of ["caution.gapOpened", "caution.gapStillOpen"] as const) {
        getEventBus().subscribe(name, () =>
          atPublish.push({
            event: name,
            warranted: getCautionGap()?.warranted,
            blockedBy: getCautionGap()?.blockedBy,
            car: getPaceLineup()?.followCarNumber,
          }),
        );
      }

      d.caught(OPEN);
      d.hold(OPEN, CATCH_UP_DWELL_MS + CATCH_UP_REMINDER_MS + 1_000);

      expect(atPublish).toEqual([
        { event: "caution.gapOpened", warranted: true, blockedBy: [], car: "95" },
        { event: "caution.gapStillOpen", warranted: true, blockedBy: [], car: "95" },
      ]);
    });

    it("reports the measurement it judged: 40 m to car 5 against a 10 m pack of eight pairs", () => {
      const d = drive();

      d.caught();
      d.tick(OPEN);

      const gap = getCautionGap();

      expect(gap?.measurement).toMatchObject({
        followCarIdx: 5,
        spacingSamples: 8,
        aheadOfSlot: false,
        paceCarOnTrack: true,
      });
      expect(gap?.measurement.gapMeters).toBeCloseTo(40);
      expect(gap?.measurement.packSpacingMeters).toBeCloseTo(10);
      expect(gap?.measurement.ratio).toBeCloseTo(4);
    });

    describe("warranted — the gate asks whether the gap is still open, not whether one would open now", () => {
      it("is true at the raise multiple and in the band below it, and false under the clear multiple", () => {
        const d = drive();
        const warrantedAt = (f: Field): boolean | undefined => {
          d.tick(f);

          return getCautionGap()?.warranted;
        };

        d.caught();

        expect(warrantedAt(OPEN)).toBe(true); // 4×
        // 2×: no gap would OPEN here, and one that is open is still open.
        expect(warrantedAt(BAND)).toBe(true);
        expect(warrantedAt({ back: 7.6 })).toBe(true); // 1.76×
        expect(warrantedAt({ back: 7.4 })).toBe(false); // 1.74×: he has closed up
        expect(warrantedAt(CLOSED)).toBe(false);
      });

      it("refuses a first call that was queued while the gap was open, once he has closed up", () => {
        // The call fires at 4×, and a queued one is spoken later: by then the
        // driver may have closed to the band — still spoken — or right up.
        const d = drive();

        d.caught(OPEN);
        d.hold(OPEN, CATCH_UP_DWELL_MS + 500);
        expect(d.seen).toEqual(["caution.gapOpened"]);
        expect(getCautionGap()?.warranted).toBe(true);

        d.tick(BAND);
        expect(getCautionGap()?.warranted).toBe(true);

        d.tick(CLOSED);
        expect(getCautionGap()?.warranted).toBe(false);
      });

      it("never fires the first call from the band, though the gate would pass there — the event needs the raise multiple and the dwell", () => {
        const d = drive();

        d.caught();
        d.hold(BAND, 60_000);

        expect(getCautionGap()?.warranted).toBe(true);
        expect(d.seen).toEqual([]);
      });
    });

    describe("warranted — false whenever catch-up is not live, with the reason", () => {
      it("in the settle window after the pickup", () => {
        const d = drive();

        d.tick({ ...OPEN, flags: RACING });
        d.tick({ ...OPEN, flags: WAVING });
        d.tick({ ...OPEN, flags: STATIC });
        d.hold(OPEN, CATCH_UP_SETTLE_MS - 1_000);

        expect(getCautionGap()).toMatchObject({ warranted: false, blockedBy: ["settling"] });

        d.hold(OPEN, 1_000);
        expect(getCautionGap()).toMatchObject({ warranted: true, blockedBy: [] });
      });

      it("while the caution waves", () => {
        const d = drive();

        d.tick({ ...OPEN, flags: RACING });
        d.hold({ ...OPEN, flags: WAVING }, 30_000);

        expect(getCautionGap()).toMatchObject({ warranted: false, blockedBy: ["phase"] });
      });

      it("on pit road", () => {
        const d = drive();

        d.caught();
        d.tick({ ...OPEN, onPitRoad: true });

        expect(getCautionGap()).toMatchObject({ warranted: false, blockedBy: ["pit-road"] });
      });

      it("under a green that a caution bit outlived — the reader resolves a lineup there, and still refuses", () => {
        const d = drive();

        d.caught();
        d.tick({ ...OPEN, flags: STATIC | Flags.Green });

        expect(getPaceLineup()).not.toBeNull();
        expect(getCautionPhase()).toBe("caught");
        expect(getCautionGap()).toMatchObject({ warranted: false, blockedBy: ["green"] });
      });

      it("while the green is held, for every car", () => {
        const d = drive();

        d.caught();
        d.tick({ ...OPEN, flags: STATIC | Flags.OneLapToGreen });
        expect(getCautionGap()).toMatchObject({ warranted: true, blockedBy: [] });

        d.tick({ ...OPEN, flags: STATIC | Flags.OneLapToGreen | Flags.GreenHeld });
        expect(getCautionPhase()).toBe("one-to-go");
        expect(getCautionGap()).toMatchObject({ warranted: false, blockedBy: ["green-held"] });
      });

      it("with no caution out at all", () => {
        const d = drive();

        d.tick({ ...OPEN, flags: RACING });
        d.tick({ ...OPEN, flags: RACING });

        expect(getCautionGap()).toMatchObject({ warranted: false, blockedBy: ["phase"] });
      });
    });

    describe("a waved-around car", () => {
      it("is waving around, and not told to catch anyone, until it has taken its slot", () => {
        const d = drive();

        d.caught({ ...OPEN, paceFlags: 0x4 });
        d.hold({ ...OPEN, paceFlags: 0x4 }, 30_000);

        expect(d.seen).toEqual([]);
        expect(getCautionGap()).toMatchObject({ warranted: false, wavingAround: true, blockedBy: ["procedure"] });
        expect(getPaceLineup()?.paceFlags).toEqual({ endOfLine: false, freePass: false, wavedAround: true });
      });

      it("is an ordinary car once it has, the flag still set", () => {
        const d = drive();

        d.caught({ ...OPEN, paceFlags: 0x4 });
        d.tick({ ...CLOSED, paceFlags: 0x4 });

        expect(getCautionGap()).toMatchObject({ warranted: false, wavingAround: false, blockedBy: [] });

        d.hold({ ...OPEN, paceFlags: 0x4 }, CATCH_UP_DWELL_MS + 500);
        expect(d.seen).toEqual(["caution.gapOpened"]);
        expect(getCautionGap()).toMatchObject({ warranted: true, wavingAround: false });
      });

      it("is not waving around without the flag", () => {
        const d = drive();

        d.caught(OPEN);

        expect(getCautionGap()?.wavingAround).toBe(false);
      });
    });

    it("measures once per tick however often it is asked, and afresh on the next", () => {
      const d = drive();

      d.caught(OPEN);

      const first = getCautionGap();

      expect(getCautionGap()?.measurement).toBe(first?.measurement);
      expect(getCautionGap()?.measurement).toBe(first?.measurement);

      d.tick(OPEN);
      expect(getCautionGap()?.measurement).not.toBe(first?.measurement);
      expect(getCautionGap()?.measurement).toEqual(first?.measurement);
    });

    it("reads the latches fresh on a memoised measurement — the settle window ends between two reads of one tick", () => {
      const d = drive();

      d.tick({ ...OPEN, flags: RACING });
      d.tick({ ...OPEN, flags: WAVING });
      d.tick({ ...OPEN, flags: STATIC });
      d.hold(OPEN, CATCH_UP_SETTLE_MS - 500);

      const during = getCautionGap();

      expect(during).toMatchObject({ warranted: false, blockedBy: ["settling"] });

      // No new tick: the clock alone moves past the window.
      vi.advanceTimersByTime(500);

      const after = getCautionGap();

      expect(after).toMatchObject({ warranted: true, blockedBy: [] });
      expect(after?.measurement).toBe(during?.measurement);
    });

    describe("across a replay glance", () => {
      /** The translator's own state, as the Telemetry Snapshot shows it. */
      function rawState(): TranslatorState {
        const state = readSimState();

        if (!state.initialized) throw new Error("the translator is not initialized");

        return state.raw.state;
      }

      it("keeps the drive-round latch and the pickup's time, and re-derives the episode — a fresh first call, with no second settle window", () => {
        const d = drive();

        // A waved-around car that joined, then dropped back and was called and reminded.
        d.caught({ ...CLOSED, paceFlags: 0x4 });
        d.hold({ ...OPEN, paceFlags: 0x4 }, CATCH_UP_DWELL_MS + CATCH_UP_REMINDER_MS + 1_000);
        expect(d.seen).toEqual(["caution.gapOpened", "caution.gapStillOpen"]);

        const before = { ...rawState() };

        expect(before).toMatchObject({
          cautionProcedureJoined: true,
          cautionCatchUpOpen: true,
          cautionCatchUpReminders: 1,
        });
        expect(before.cautionCaughtAt).not.toBeNull();

        d.tick({ ...OPEN, paceFlags: 0x4, replay: true });

        // During the glance: the phase's two fields and the pit-road baseline
        // are there, the ordinary episode is gone.
        expect(rawState()).toMatchObject({
          cautionPhase: "caught",
          cautionProcedureJoined: true,
          cautionCaughtAt: before.cautionCaughtAt,
          cautionCatchUpOpen: false,
          cautionCatchUpReminders: 0,
          cautionCatchUpLastCallAt: null,
          cautionCatchUpRaisedSince: null,
          cautionCatchUpFollowCarIdx: null,
          cautionCatchUpLastOnPitRoad: false,
          cautionCatchUpPitRoadSince: null,
          cautionCatchUpPitExitAt: null,
          cautionCatchUpPitExitCalled: false,
        });

        elapseReplayGrace();
        d.seen.length = 0;

        // Back in the car, the gap as open as it was: one dwell, then a fresh
        // first call. The latch still lets it through; no settle window again.
        d.hold({ ...OPEN, paceFlags: 0x4 }, CATCH_UP_DWELL_MS + 1_000);
        expect(d.seen).toEqual(["caution.gapOpened"]);
        expect(rawState()).toMatchObject({ cautionProcedureJoined: true, cautionCaughtAt: before.cautionCaughtAt });
      });

      describe("a pit stop", () => {
        /** A long way behind the tail: 310 m against a 10 m pack. */
        const REJOINED: Field = { back: 300 };
        const STOPPED: Field = { back: 300, onPitRoad: true };

        it("is still a pit stop after a glance from the stall — out a second later, he gets the grace, one call and no reminder", () => {
          // The wipe used to drop the pit-road baseline: the first reading back
          // then began a "new" stay, the exit came before it was a dwell old,
          // and the driver was met as an ordinary dropped-back car — called
          // three seconds out of the pits, and reminded.
          const d = drive();

          d.caught();
          d.hold(STOPPED, 20_000);
          d.tick({ ...STOPPED, replay: true });
          elapseReplayGrace();
          d.hold(STOPPED, 1_000);
          d.tick(REJOINED);

          // Nothing inside the grace, where the ordinary dwell would have spoken…
          d.hold(REJOINED, CATCH_UP_PIT_EXIT_GRACE_MS - 500);
          expect(d.seen).toEqual([]);
          // …then the one call, and no reminder however long he takes.
          d.hold(REJOINED, 4 * CATCH_UP_REMINDER_MS);
          expect(d.seen).toEqual(["caution.gapOpened"]);
        });

        it("gets no second pit-exit call from a glance after the first — and still no reminder", () => {
          const d = drive();

          d.caught();
          d.hold(STOPPED, 20_000);
          d.hold(REJOINED, CATCH_UP_PIT_EXIT_GRACE_MS + CATCH_UP_DWELL_MS + 1_000);
          expect(d.seen).toEqual(["caution.gapOpened"]);

          d.tick({ ...REJOINED, replay: true });
          elapseReplayGrace();
          d.hold(REJOINED, 4 * CATCH_UP_REMINDER_MS);
          expect(d.seen).toEqual(["caution.gapOpened"]);
        });

        it("carries exactly the pit stop through the wipe: the baseline, the stay's start, the pit-exit episode and its call", () => {
          const d = drive();

          d.caught();
          d.hold(STOPPED, 20_000);
          d.hold(REJOINED, CATCH_UP_PIT_EXIT_GRACE_MS + CATCH_UP_DWELL_MS + 1_000);
          // Back onto pit road, so all four fields hold something to lose.
          d.hold(STOPPED, 1_000);

          const before = { ...rawState() };

          expect(before).toMatchObject({ cautionCatchUpLastOnPitRoad: true, cautionCatchUpPitExitCalled: true });
          expect(before.cautionCatchUpPitRoadSince).not.toBeNull();
          expect(before.cautionCatchUpPitExitAt).not.toBeNull();
          expect(before.cautionCatchUpFollowCarIdx).not.toBeNull();

          d.tick({ ...STOPPED, replay: true });

          expect(rawState()).toMatchObject({
            cautionCatchUpLastOnPitRoad: true,
            cautionCatchUpPitRoadSince: before.cautionCatchUpPitRoadSince,
            cautionCatchUpPitExitAt: before.cautionCatchUpPitExitAt,
            cautionCatchUpPitExitCalled: true,
            // …and nothing of the ordinary episode.
            cautionCatchUpFollowCarIdx: null,
            cautionCatchUpOpen: false,
            cautionCatchUpLastCallAt: null,
          });
        });

        it("does not take a blink on the way back for a stop — the baseline from before the glance is still there", () => {
          // Without the baseline the first reading back would be a first sight,
          // and a first sight on pit road counts as a stop.
          const d = drive();

          d.caught(OPEN);
          d.tick({ ...OPEN, replay: true });
          expect(rawState().cautionCatchUpLastOnPitRoad).toBe(false);

          elapseReplayGrace();
          d.tick(OPEN); // the caution diff's seed
          d.tick({ ...OPEN, onPitRoad: true }); // the first reading back, on the pit lane's edge
          d.tick(OPEN);

          expect(rawState().cautionCatchUpPitExitAt).toBeNull();
        });

        it("is forgotten by a session change during the replay, with everything else the wipe carries", () => {
          const d = drive();

          d.caught();
          d.hold(STOPPED, 20_000);
          d.hold(REJOINED, CATCH_UP_PIT_EXIT_GRACE_MS + CATCH_UP_DWELL_MS + 1_000);
          // Back onto pit road, so all four fields hold something to lose.
          d.hold(STOPPED, 1_000);

          d.tick({ ...STOPPED, replay: true });

          const carried = rawState();

          expect(carried).toMatchObject({
            cautionPhase: "caught",
            cautionCatchUpLastOnPitRoad: true,
            cautionCatchUpPitExitCalled: true,
          });
          expect(carried.cautionCaughtAt).not.toBeNull();
          expect(carried.cautionCatchUpPitRoadSince).not.toBeNull();
          expect(carried.cautionCatchUpPitExitAt).not.toBeNull();

          // The session moves on while he is still in the replay.
          d.tick({ ...STOPPED, replay: true, sessionNum: 1 });

          expect(rawState()).toMatchObject({
            cautionPhase: "none",
            cautionProcedureJoined: false,
            cautionCaughtAt: null,
            cautionCatchUpLastOnPitRoad: null,
            cautionCatchUpPitRoadSince: null,
            cautionCatchUpPitExitAt: null,
            cautionCatchUpPitExitCalled: false,
          });
        });
      });

      it("does not lift a suppression the live car is still under", () => {
        const d = drive();

        d.caught({ ...OPEN, paceFlags: 0x4 });
        d.tick({ ...OPEN, paceFlags: 0x4, replay: true });
        elapseReplayGrace();
        d.hold({ ...OPEN, paceFlags: 0x4 }, 30_000);

        expect(d.seen).toEqual([]);
        expect(rawState().cautionProcedureJoined).toBe(false);
        expect(getCautionGap()).toMatchObject({ warranted: false, wavingAround: true });
      });
    });

    it("shows the reading in the Telemetry Snapshot's caution section, and the episode under raw", () => {
      const d = drive();

      d.caught(OPEN);
      d.hold(OPEN, CATCH_UP_DWELL_MS + 500);

      const state = readSimState();

      if (!state.initialized || !("caution" in state)) throw new Error("the curated half is missing");

      expect(state.caution.gap).toEqual(getCautionGap());
      expect(state.caution.gap).toMatchObject({ warranted: true, blockedBy: [] });
      expect(state.raw.state).toMatchObject({ cautionCatchUpOpen: true, cautionCatchUpFollowCarIdx: 5 });
      expect(() => JSON.stringify(state.caution)).not.toThrow();
    });

    it("forgets everything when the sim goes away", () => {
      const d = drive();

      d.caught(OPEN);
      d.controller.__tick(null, false);

      expect(getCautionGap()).toBeNull();
    });
  });
});
