/**
 * The gap callouts' closing-announcement horizon as `handleTick` hands it to
 * `diffGaps` (issue #1311): the resolver's unit tests live in
 * `translator.test.ts`; this file proves the call site wires it to the
 * tick's canonical order and to `diffLeaderWhite`'s post-expiry crossing
 * marker, which only the real tick sequence produces.
 */
import { getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  type SDKController,
  SessionState,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetSimEventsIracing, initializeSimEventsIracing } from "./translator.js";

const { diffGapsSpy } = vi.hoisted(() => ({ diffGapsSpy: vi.fn() }));

vi.mock("./diff/gaps.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diff/gaps.js")>()),
  diffGaps: diffGapsSpy,
}));

/** `diffGaps`' `lapsRemaining` parameter position. */
const LAPS_REMAINING_ARG = 8;

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

function createMockController(): MockController {
  let callback: TelemetryCallback | null = null;
  const sessionInfo = {
    SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
    DriverInfo: { DriverCarIdx: 0 },
  };

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

  controller.__tick = (telemetry) => {
    callback?.(telemetry, true);
  };

  return controller;
}

/**
 * A timed race with a 100-lap cap the clock will beat. car1 leads on a 90 s
 * lap; the player (car0) runs third.
 */
function timedRace(timeRemainS: number, leaderLap: number, leaderPct: number): TelemetryData {
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
    SessionState: SessionState.Racing,
    SessionLapsRemainEx: 100,
    SessionTimeRemain: timeRemainS,
    PitSvFlags: 0,
    PitSvTireCompound: 0,
    PlayerTireCompound: 0,
    EngineWarnings: 0,
    Speed: 0,
    CarLeftRight: CarLeftRight.Off,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: 6,
    LapDistPct: 0.1,
    FuelLevel: 10,
    CarIdxLapCompleted: [5, leaderLap, 5],
    CarIdxLapDistPct: [0.1, leaderPct, 0.2],
    CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
    CarIdxClass: [0, 0, 0],
    CarIdxLastLapTime: [92, 90, 91],
  } as TelemetryData;
}

function lastHorizon(): unknown {
  const calls = diffGapsSpy.mock.calls;

  return calls[calls.length - 1]?.[LAPS_REMAINING_ARG];
}

describe("gap closing-announcement horizon at the call site (issue #1311)", () => {
  beforeEach(() => {
    initializeEventBus(createMockLogger());
    diffGapsSpy.mockClear();
  });

  afterEach(() => {
    _resetSimEventsIracing();
  });

  it("follows the clock through the white and chequered laps of a timed race with a larger lap cap", () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

    // 20 minutes left, leader a quarter of the way round: white at the
    // leader's 14th crossing (ceil(1200 / 90 + 0.25)), chequered at the 15th.
    controller.__tick(timedRace(1200, 5, 0.25));
    expect(lastHorizon()).toBe(15);

    // The clock expires; the leader has yet to cross, so the white and the
    // chequered remain — not the 100-lap cap.
    controller.__tick(timedRace(-1, 5, 0.9));
    controller.__tick(timedRace(-2, 5, 0.95));
    expect(lastHorizon()).toBe(2);

    // The leader crosses after expiry: that was the white, one crossing left.
    controller.__tick(timedRace(-10, 6, 0.02));
    expect(lastHorizon()).toBe(1);
  });
});
