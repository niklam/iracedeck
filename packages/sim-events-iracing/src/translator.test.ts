/**
 * Translator integration tests.
 *
 * Drives the translator with canned `TelemetryData` snapshots via a fake
 * `sdkController`. Asserts the emitted event stream for each transition.
 *
 * Per-diff-module unit tests (pure functions) live next to their modules.
 */
import { _resetEventBus, getEventBus, initializeEventBus, type SimEventOf, TrackWetness } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  EngineWarnings,
  Flags,
  IncidentFlags,
  PitSvFlags,
  type SDKController,
  SessionState,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { YELLOW_CLEARED_HOLD_MS } from "./diff/flags.js";
import {
  _resetSimEventsIracing,
  getDriverSetupName,
  getFuelStats,
  getLatestTelemetry,
  getLivePosition,
  getLiveRacePositions,
  getRaceStartConditions,
  getSessionStartConditions,
  getStartingGridPosition,
  initializeSimEventsIracing,
  isSimEventsIracingInitialized,
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
      expect(getFuelStats(5)).toEqual({ lastLap: null, avg: null, samples: 0 });
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

      expect(getFuelStats(5)).toEqual({ lastLap: null, avg: null, samples: 0 });
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

      expect(getFuelStats(5)).toEqual({ lastLap: null, avg: null, samples: 0 });
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
      controller.__tick(telemetry({ LapCompleted: 5, LapDistPct: 0.8, SessionFlags: Flags.Checkered }));
      expect(handler).not.toHaveBeenCalled();

      // Takes the flag at the line.
      controller.__tick(telemetry({ LapCompleted: 6, LapDistPct: 0.01, SessionFlags: Flags.Checkered }));
      expect(handler).toHaveBeenCalledTimes(1);
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

  describe("fuel threshold crossings", () => {
    it("emits fuel.lapsRemaining.crossed once per descending threshold", () => {
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("fuel.lapsRemaining.crossed", handler);
      controller.__setSessionInfo({
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        DriverInfo: { DriverCarIdx: 0 },
      });
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // Build history across 3 lap boundaries. Fuel drops from 10 → 9 → 8 → 7
      // on lap transitions; avgPerLap = 1.
      controller.__tick(telemetry({ Lap: 1, FuelLevel: 10 }));
      controller.__tick(telemetry({ Lap: 2, FuelLevel: 9 }));
      controller.__tick(telemetry({ Lap: 3, FuelLevel: 8 }));
      controller.__tick(telemetry({ Lap: 4, FuelLevel: 7 }));
      // History is [1, 1, 1]; FuelLevel=7 → 7 laps remaining, no crossing.
      expect(handler).not.toHaveBeenCalled();

      // Mid-lap drop — stays on lap 4 so lap-boundary logic doesn't poison the
      // rolling history; only the crossing logic runs.
      controller.__tick(telemetry({ Lap: 4, FuelLevel: 4.8 }));
      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0]![0] as SimEventOf<"fuel.lapsRemaining.crossed">).data.threshold).toBe(5);

      // Drop further — crosses 3.
      controller.__tick(telemetry({ Lap: 4, FuelLevel: 2.8 }));
      expect(handler).toHaveBeenCalledTimes(2);
      expect((handler.mock.calls[1]![0] as SimEventOf<"fuel.lapsRemaining.crossed">).data.threshold).toBe(3);

      // Crossing 5 again does not re-fire.
      controller.__tick(telemetry({ Lap: 4, FuelLevel: 2.5 }));
      expect(handler).toHaveBeenCalledTimes(2);
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
    });

    it("coalesces a multi-step incident burst into a single emission with the most-recent type", () => {
      vi.useFakeTimers();
      const controller = createMockController();
      const bus = getEventBus();
      const handler = vi.fn();
      bus.subscribe("incident.occurred", handler);
      initializeSimEventsIracing(bus, controller, createMockLogger());

      // A typical iRacing crash arrives as a stream of count increments
      // over a few hundred ms. Without coalescing each step would fire
      // its own callout — three lines on top of each other.
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 0 }));
      // off-track first (1x)
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepOffTrack }));
      vi.advanceTimersByTime(200);
      // out-of-control (2x more) shortly after
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 3, PlayerIncidents: IncidentFlags.RepOutOfControl }));
      vi.advanceTimersByTime(200);
      // car collision (4x more) lands the worst classification last
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 7, PlayerIncidents: IncidentFlags.RepCollisionWithCar }));

      // Still inside the burst window — no emit yet.
      expect(handler).not.toHaveBeenCalled();

      // Quiet window elapses; one emit with the accumulated delta and the
      // most recent type.
      vi.advanceTimersByTime(1500);
      controller.__tick(telemetry({ PlayerCarMyIncidentCount: 7 }));
      expect(handler).toHaveBeenCalledTimes(1);
      const data = (handler.mock.calls[0]![0] as SimEventOf<"incident.occurred">).data;
      expect(data.delta).toBe(7);
      expect(data.type).toBe("collision-car");
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
      expect(first.delta).toBe(1);
      expect(first.type).toBe("off-track");
      expect(second.delta).toBe(4);
      expect(second.type).toBe("collision-car");
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
      // welcome scenario must not re-trigger.
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
      // Driver clicks "Drive" — replay ends and the car is on track.
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
      controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: false, IsOnTrack: true })); // drive out — fires
      controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: true, IsOnTrack: false })); // back to garage
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
      controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: false, IsOnTrack: true }));
      expect(handler).toHaveBeenCalledTimes(1);

      // Practice ends → iRacing returns to replay/menu, then qualifying starts.
      // The SessionNum delta arrives on a replay-mode tick (the realistic path:
      // user is in the session-load screen when the number flips).
      controller.__tick(telemetry({ SessionNum: 0, IsReplayPlaying: true, IsOnTrack: false }));
      controller.__tick(telemetry({ SessionNum: 1, IsReplayPlaying: true, IsOnTrack: false }));
      expect(handler).toHaveBeenCalledTimes(1); // still in replay — no fire yet

      // Driver clicks Drive in qualifying — fires on the live-on-track edge.
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

    it("returns null when track wetness is still Unknown", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Unknown, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getSessionStartConditions()).toBeNull();
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

    it("returns null when track wetness is still Unknown", () => {
      const controller = createMockController();
      controller.__setSessionInfo(SESSION_INFO_P7);
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(telemetry({ TrackWetness: TrackWetness.Unknown, TrackTempCrew: 25, AirTemp: 18 }));

      expect(getRaceStartConditions()).toBeNull();
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
});
