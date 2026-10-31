/**
 * The two gap accessors through the real tick (issue #1515): outside a race
 * `getTrackGaps()` answers and `getLiveGaps()` stays null; in a race the
 * reverse. This pins the Race Engineer's source — `getLiveGaps()`, the only
 * one `SimRuntime` reads — as race-only, and the track-order gaps as
 * practice-only, at the call site `handleTick` wires them through.
 */
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
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

import { _resetSimEventsIracing, getLiveGaps, getTrackGaps, initializeSimEventsIracing } from "./translator.js";

/** A 90 s lap. */
const V = 1 / 90;

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

type MockController = SDKController & { __tick: (telemetry: TelemetryData) => void };

function createMockController(sessionType: string): MockController {
  let callback: TelemetryCallback | null = null;
  const sessionInfo = {
    SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: sessionType }] },
    WeekendInfo: { TrackLength: "4.00 km" },
    DriverInfo: { DriverCarIdx: 0, Drivers: [] },
  };
  // The translator's replay guard reads the controller's debounced replay
  // state (#1324), stepped before each tick as the real controller does.
  const replayState = new ReplayStateTracker();

  const controller = {
    subscribe: (_id: string, cb: TelemetryCallback) => {
      callback = cb;
      cb(null, false);
    },
    unsubscribe: (_id: string) => {
      callback = null;
    },
    getSessionInfo: () => sessionInfo,
    getReplayState: (nowMs: number = Date.now()) => replayState.read(nowMs),
  } as unknown as MockController;

  controller.__tick = (telemetry) => {
    replayState.step(telemetry, sessionInfo, Date.now());
    callback?.(telemetry, true);
  };

  return controller;
}

/**
 * One tick at session time `t`: the player (car 0) on lap 5, car 1 0.05 lap
 * ahead and car 2 0.08 lap behind, all on one class at the same pace.
 */
function tick(t: number): TelemetryData {
  const pos = [0.3 + V * t, 0.35 + V * t, 0.22 + V * t];

  return {
    SessionTime: t,
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: true,
    PlayerTrackSurface: TrkLoc.OnTrack,
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
    Speed: 44,
    CarLeftRight: CarLeftRight.Off,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: 6,
    LapCompleted: 5,
    LapDistPct: pos[0]! % 1,
    FuelLevel: 10,
    CarIdxLapCompleted: pos.map((p) => 5 + Math.floor(p)),
    CarIdxLapDistPct: pos.map((p) => p % 1),
    CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
    CarIdxClass: [0, 0, 0],
    CarIdxLastLapTime: [90, 90, 90],
  } as TelemetryData;
}

function drive(sessionType: string, untilS: number): void {
  const controller = createMockController(sessionType);

  initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

  for (let t = 0; t <= untilS; t += 0.25) controller.__tick(tick(t));
}

describe("getTrackGaps and getLiveGaps through handleTick (issue #1515)", () => {
  beforeEach(() => {
    initializeEventBus(createMockLogger());
  });

  afterEach(() => {
    _resetSimEventsIracing();
    _resetEventBus();
  });

  it("answers the track-order gaps in practice and leaves the race gaps null", () => {
    drive("Practice", 20);

    expect(getLiveGaps()).toBeNull();
    expect(getTrackGaps()).toEqual({
      ahead: expect.objectContaining({ carIdx: 1, gapSeconds: expect.closeTo(4.5, 6), lapDelta: 0 }),
      behind: expect.objectContaining({ carIdx: 2, gapSeconds: expect.closeTo(7.2, 6), lapDelta: 0 }),
    });
  });

  it("answers the race gaps in a race and leaves the track-order gaps null", () => {
    drive("Race", 20);

    expect(getTrackGaps()).toBeNull();
    expect(getLiveGaps()).toEqual({
      ahead: expect.objectContaining({ carIdx: 1, gapSeconds: expect.closeTo(4.5, 6), lapDelta: 0 }),
      behind: expect.objectContaining({ carIdx: 2, gapSeconds: expect.closeTo(7.2, 6), lapDelta: 0 }),
    });
  });

  it("answers neither in a Lone Qualify", () => {
    drive("Lone Qualify", 20);

    expect(getTrackGaps()).toBeNull();
    expect(getLiveGaps()).toBeNull();
  });
});
