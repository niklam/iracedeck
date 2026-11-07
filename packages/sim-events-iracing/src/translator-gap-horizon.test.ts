/**
 * The gap callouts' closing-announcement horizon (issues #1311, #1380): the
 * pure resolver `resolveGapLapsRemaining`, which turns the race leader's
 * remaining line crossings into the player's distance to their own chequered
 * flag, and the call site in `handleTick` that hands it to `diffGaps` — wired
 * to the tick's canonical order, `diffLeaderWhite`'s post-expiry crossing
 * marker, the player's validated average lap and the finish `diffLaps`
 * records, which only the real tick sequence produces.
 */
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import {
  CarLeftRight,
  Flags,
  IRSDK_UNLIMITED_LAPS,
  IRSDK_UNLIMITED_TIME,
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
  type GapHorizonPlayer,
  initializeSimEventsIracing,
  resolveGapLapsRemaining,
} from "./translator.js";

const { diffGapsSpy } = vi.hoisted(() => ({ diffGapsSpy: vi.fn() }));

vi.mock("./diff/gaps.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diff/gaps.js")>()),
  diffGaps: diffGapsSpy,
}));

/** `diffGaps`' `lapsRemaining` parameter position. */
const LAPS_REMAINING_ARG = 8;

// ─── The resolver ────────────────────────────────────────────────────────────

// car1 leads, car0 is second, car2 third.
const ORDER = [2, 1, 3];

/**
 * A race with the given limits — the sentinels mark an absent one — and car1
 * leading on a 90 s lap, a quarter of the way round. The player (car0) is on
 * the leader's lap at fraction 0, on the line.
 */
function limits(lapsRemain: number, timeRemainS: number, overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    SessionNum: 0,
    SessionState: SessionState.Racing,
    SessionLapsRemainEx: lapsRemain,
    SessionTimeRemain: timeRemainS,
    CarIdxLastLapTime: [91, 90, 92],
    CarIdxLapCompleted: [10, 10, 9],
    CarIdxLapDistPct: [0, 0.25, 0.5],
    ...overrides,
  } as TelemetryData;
}

/** The player (car0) on the leader's pace, not finished. */
function player(overrides: Partial<GapHorizonPlayer> = {}): GapHorizonPlayer {
  return { carIdx: 0, avgLapTimeS: 90, finished: false, ...overrides };
}

/** The player as the race leader (car1). */
const LEADER = player({ carIdx: 1 });

/**
 * A 5-lap race with no clock. The leader (car1) is on lap 11 at 0.3, so
 * their chequered flag is `(5 − 0.3) · 90 = 423` s away; the player (car0)
 * has completed 9 laps and is at 0.6 — a lap down on the counter, 0.7 laps
 * behind on distance.
 */
function lapRace(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return limits(5, IRSDK_UNLIMITED_TIME, {
    CarIdxLapCompleted: [9, 10, 8],
    CarIdxLapDistPct: [0.6, 0.3, 0.5],
    ...overrides,
  });
}

describe("resolveGapLapsRemaining — the leader's crossings, unchanged for a player on the leader's lap at fraction 0 (issue #1311)", () => {
  it("takes the clock's crossings when a timed race's lap cap is larger", () => {
    // 100-lap cap, 20 minutes left: the white is the leader's 14th crossing
    // (ceil(1200 / 90 + 0.25)), the chequered the 15th.
    expect(resolveGapLapsRemaining(limits(100, 1200), ORDER, false, player())).toBe(15);
  });

  it("takes the lap cap when it ends a dual-limit race sooner", () => {
    expect(resolveGapLapsRemaining(limits(5, 1200), ORDER, false, player())).toBe(5);
  });

  it("counts the white and chequered laps the clock still runs, so a cap that ends the race first binds", () => {
    // 200 s is 2.2 leader laps, but the leader still takes the white at
    // crossing 3 and the chequered at 4, so the 3-lap cap ends it first.
    expect(resolveGapLapsRemaining(limits(3, 200), ORDER, false, player())).toBe(3);
  });

  it("reads the counter in a lap-only race", () => {
    expect(resolveGapLapsRemaining(limits(12, IRSDK_UNLIMITED_TIME), ORDER, false, player())).toBe(12);
  });

  it("counts the clock's crossings in a time-only race", () => {
    expect(resolveGapLapsRemaining(limits(IRSDK_UNLIMITED_LAPS, 900), ORDER, false, player())).toBe(12);
  });

  it("takes an unknown leader lap fraction as the line, the smaller count", () => {
    const offWorld = limits(IRSDK_UNLIMITED_LAPS, 900, { CarIdxLapDistPct: [0, -1, 0.5] });

    expect(resolveGapLapsRemaining(offWorld, ORDER, false, player())).toBe(11);
  });

  it("leaves the horizon null when neither limit is known", () => {
    const unlimited = limits(IRSDK_UNLIMITED_LAPS, IRSDK_UNLIMITED_TIME);

    expect(resolveGapLapsRemaining(unlimited, ORDER, false, player())).toBeNull();
    expect(resolveGapLapsRemaining(unlimited, ORDER, false, LEADER)).toBeNull();
  });

  it("leaves a running clock unknown without a leader pace", () => {
    // Pre-green there is no racing lap to project by, so a time-only race has no horizon yet.
    const parade = limits(IRSDK_UNLIMITED_LAPS, 900, { SessionState: SessionState.ParadeLaps });

    expect(resolveGapLapsRemaining(parade, ORDER, false, player())).toBeNull();
  });

  it("keeps an expired clock known: two crossings until the leader takes the white, then one", () => {
    expect(resolveGapLapsRemaining(limits(IRSDK_UNLIMITED_LAPS, -5), ORDER, false, player())).toBe(2);
    expect(resolveGapLapsRemaining(limits(IRSDK_UNLIMITED_LAPS, -40), ORDER, true, player())).toBe(1);
    expect(resolveGapLapsRemaining(limits(IRSDK_UNLIMITED_LAPS, 0), ORDER, false, player())).toBe(2);
  });

  it("does not fall back to a larger lap cap once the clock has expired", () => {
    expect(resolveGapLapsRemaining(limits(60, -5), ORDER, false, player())).toBe(2);
    expect(resolveGapLapsRemaining(limits(60, -40), ORDER, true, player())).toBe(1);
  });

  it("reads a negative mid-race blip as an expired clock for that tick, never as no limit", () => {
    expect(resolveGapLapsRemaining(limits(30, -0.1), ORDER, false, player())).toBe(2);
  });

  it("reads a lap counter of 0 as the leader's flag rather than falling through to the clock", () => {
    // Before #1380 this was a horizon of 0; the player still has their own
    // chequered crossing to run (the leader-finished window), and none once
    // they have taken it. Never the clock's 15.
    expect(resolveGapLapsRemaining(limits(0, 1200), ORDER, false, player())).toBe(1);
    expect(resolveGapLapsRemaining(limits(0, 1200), ORDER, false, player({ finished: true }))).toBe(0);
  });

  it("gives the player who leads the leader's crossings, less their lap fraction", () => {
    expect(resolveGapLapsRemaining(limits(100, 1200), ORDER, false, LEADER)).toBeCloseTo(15 - 0.25, 9);
    expect(resolveGapLapsRemaining(limits(5, 1200), ORDER, false, LEADER)).toBeCloseTo(5 - 0.25, 9);
    expect(resolveGapLapsRemaining(limits(IRSDK_UNLIMITED_LAPS, -40), ORDER, true, LEADER)).toBeCloseTo(0.75, 9);
  });
});

describe("resolveGapLapsRemaining — the player's own crossings (issue #1380)", () => {
  it("counts a slower-class player by their own pace: the issue's multiclass example", () => {
    // A GTP leader on 90 s laps halfway round, a GT4 player on 120 s laps
    // more than two laps behind, 600 s left in a time-only race. The leader
    // takes the white at crossing ceil(600 / 90 + 0.5) = 8 and the chequered
    // at 9, (9 − 0.5) · 90 = 765 s from now. The player's k-th crossing is at
    // (k − 0.4) · 120, so their chequered is crossing ceil(765 / 120 + 0.4) = 7.
    const multiclass = limits(IRSDK_UNLIMITED_LAPS, 600, {
      CarIdxLastLapTime: [120, 90, 120],
      CarIdxLapCompleted: [18, 20, 17],
      CarIdxLapDistPct: [0.4, 0.5, 0.3],
    });

    // The leader's own count is still 9.
    expect(resolveGapLapsRemaining(multiclass, ORDER, false, LEADER)).toBeCloseTo(9 - 0.5, 9);
    expect(resolveGapLapsRemaining(multiclass, ORDER, false, player({ avgLapTimeS: 120 }))).toBeCloseTo(7 - 0.4, 9);
  });

  it("counts a player within a lap of the leader on the lap counters: a lap down is one crossing more", () => {
    // 0.7 laps behind on the leader's pace: still inside a lap at the flag,
    // so the leader's 11 + 5 = 16th lap is the player's chequered too:
    // 16 − 9 = 6 crossings, not the leader's 5.
    expect(resolveGapLapsRemaining(lapRace(), ORDER, false, player())).toBeCloseTo(6 - 0.6, 9);
  });

  it("counts a player on the leader's lap by the counters as the leader's crossings", () => {
    const sameLap = lapRace({ CarIdxLapCompleted: [10, 10, 8], CarIdxLapDistPct: [0.2, 0.3, 0.5] });

    expect(resolveGapLapsRemaining(sameLap, ORDER, false, player())).toBeCloseTo(5 - 0.2, 9);
  });

  it("counts a player predicted to be lapped before the flag by time, not on the counters", () => {
    // 10 s a lap slower: the 0.7-lap gap grows by 423 · (1/90 − 1/100) ≈ 0.47
    // laps before the flag, so the leader laps them. By time: the player's
    // chequered is crossing ceil(423 / 100 + 0.6) = 5, one fewer than the
    // counters would say.
    expect(resolveGapLapsRemaining(lapRace(), ORDER, false, player({ avgLapTimeS: 100 }))).toBeCloseTo(5 - 0.6, 9);
  });

  it("counts a player more than a lap down by time", () => {
    const twoDown = lapRace({ CarIdxLapCompleted: [8, 10, 7] });

    // 1.7 laps behind on the leader's pace: ceil(423 / 90 + 0.6) = 6.
    expect(resolveGapLapsRemaining(twoDown, ORDER, false, player())).toBeCloseTo(6 - 0.6, 9);
  });

  it("subtracts the player's lap fraction, so a catch just after the line is outside the horizon", () => {
    // The last lap, both cars 90 % round: the horizon is the 0.1 laps to the
    // line, not one crossing — a catch 0.95 laps away comes after the flag.
    const lastLap = limits(1, IRSDK_UNLIMITED_TIME, { CarIdxLapDistPct: [0.9, 0.95, 0.5] });

    expect(resolveGapLapsRemaining(lastLap, ORDER, false, player())).toBeCloseTo(0.1, 9);
  });

  it("never counts fewer than one crossing on the counters for a player who has not finished", () => {
    // The player just across the line ahead of the leader on the last lap:
    // 10 + 1 − 11 = 0 on the counters, but their chequered is still to come.
    const across = limits(1, IRSDK_UNLIMITED_TIME, {
      CarIdxLapCompleted: [11, 10, 9],
      CarIdxLapDistPct: [0.05, 0.95, 0.5],
    });

    expect(resolveGapLapsRemaining(across, ORDER, false, player())).toBeCloseTo(1 - 0.05, 9);
  });

  it("caps the time model at one crossing more than the leader's", () => {
    // A faster player (97 s against the leader's 100 s) a lap down on the
    // counter but 0.215 laps behind on distance, so close to the line that
    // the lap counters are not trusted (the line guard). By pace,
    // ceil((8 − 0.2) · 100 / 97 + 0.985) = 10; but a car within a lap of the
    // leader finishes on the leader's lap count, 8 + 1 = 9.
    const nearLine = limits(8, IRSDK_UNLIMITED_TIME, {
      CarIdxLastLapTime: [97, 100, 100],
      CarIdxLapCompleted: [9, 10, 8],
      CarIdxLapDistPct: [0.985, 0.2, 0.5],
    });

    expect(resolveGapLapsRemaining(nearLine, ORDER, false, player({ avgLapTimeS: 97 }))).toBeCloseTo(9 - 0.985, 9);
  });

  it("caps a lapped player's time count when the leader's pace stretches the flag", () => {
    // Three laps down, and the leader's only lap on the board is a 160 s one:
    // T = (6 − 0.5) · 160 = 880 s puts the player's chequered at crossing
    // ceil(880 / 100 + 0.5) = 10, more than any car but the leader can run.
    const stretched = limits(6, IRSDK_UNLIMITED_TIME, {
      CarIdxLastLapTime: [100, 160, 100],
      CarIdxLapCompleted: [7, 10, 6],
      CarIdxLapDistPct: [0.5, 0.5, 0.5],
    });

    expect(resolveGapLapsRemaining(stretched, ORDER, false, player({ avgLapTimeS: 100 }))).toBeCloseTo(7 - 0.5, 9);
  });

  it("converts at the leader's faster known pace, so a slow last lap does not keep a car about to be lapped on the counters", () => {
    // Leader's last lap 160 s (a pit stop), best 100 s; the player 0.7 laps
    // behind on 110 s laps, 6 laps to go. At 100 s the flag is
    // (6 − 0.3) · 100 = 570 s away, the gap grows by 570 · (1/100 − 1/110)
    // ≈ 0.52 laps and the player is lapped: by time, ceil(570 / 110 + 0.6) = 6.
    // At the raw 160 s the gap would shrink and the counters say 10 + 6 − 9 = 7.
    const slowLast = lapRace({ SessionLapsRemainEx: 6, CarIdxLastLapTime: [110, 160, 110] });
    const withBest = { ...slowLast, CarIdxBestLapTime: [108, 100, 108] } as TelemetryData;

    expect(resolveGapLapsRemaining(withBest, ORDER, false, player({ avgLapTimeS: 110 }))).toBeCloseTo(6 - 0.6, 9);
    // Without a best lap, the last one is all there is.
    expect(resolveGapLapsRemaining(slowLast, ORDER, false, player({ avgLapTimeS: 110 }))).toBeCloseTo(7 - 0.6, 9);
    // Without a last lap, the best one.
    const bestOnly = { ...withBest, CarIdxLastLapTime: [110, -1, 110] } as TelemetryData;

    expect(resolveGapLapsRemaining(bestOnly, ORDER, false, player({ avgLapTimeS: 110 }))).toBeCloseTo(6 - 0.6, 9);
  });
});

describe("resolveGapLapsRemaining — the end of the race (issue #1380)", () => {
  it("is zero once the player has the chequered flag, whatever the limits read", () => {
    expect(resolveGapLapsRemaining(lapRace(), ORDER, false, player({ finished: true }))).toBe(0);
    expect(resolveGapLapsRemaining(lapRace({ SessionLapsRemainEx: 0 }), ORDER, false, player({ finished: true }))).toBe(
      0,
    );
  });

  it("leaves the player one crossing once the leader has finished a lap race", () => {
    // `SessionLapsRemainEx` reads 0 after the leader's flag; the lapped
    // player still runs their last lap.
    const leaderFinished = lapRace({ SessionLapsRemainEx: 0 });

    expect(resolveGapLapsRemaining(leaderFinished, ORDER, false, player())).toBeCloseTo(1 - 0.6, 9);
  });

  it("reads the leader's flag from the session state in a time-only race, where the counters stay unlimited", () => {
    // The clock expired, the leader crossed since: the clock side reads 1
    // crossing even after the leader's flag. The player is 1.5 laps down.
    const afterFlag = (sessionState: SessionState): TelemetryData =>
      limits(IRSDK_UNLIMITED_LAPS, -40, {
        SessionState: sessionState,
        CarIdxLapCompleted: [8, 10, 7],
        CarIdxLapDistPct: [0.6, 0.1, 0.5],
      });

    expect(resolveGapLapsRemaining(afterFlag(SessionState.Checkered), ORDER, true, player())).toBeCloseTo(0.4, 9);
    expect(resolveGapLapsRemaining(afterFlag(SessionState.CoolDown), ORDER, true, player())).toBeCloseTo(0.4, 9);
    // Still racing, the same readings are a leader on the white lap: the
    // player's chequered is their crossing ceil((1 − 0.1) · 90 / 90 + 0.6) = 2.
    expect(resolveGapLapsRemaining(afterFlag(SessionState.Racing), ORDER, true, player())).toBeCloseTo(1.4, 9);
  });
});

describe("resolveGapLapsRemaining — falling back to the leader's crossings (issue #1380)", () => {
  // Each would be 6 − 0.6 on the counters (see above); without what the
  // conversion needs, it is the leader's 5 less the player's fraction.
  it("without a leader pace", () => {
    const noPace = lapRace({ CarIdxLastLapTime: [90, 0, 92], CarIdxBestLapTime: [90, -1, 92] });

    expect(resolveGapLapsRemaining(noPace, ORDER, false, player())).toBeCloseTo(5 - 0.6, 9);
  });

  it("before the green, whose laps on the board are the parade's", () => {
    const parade = lapRace({ SessionState: SessionState.ParadeLaps });

    expect(resolveGapLapsRemaining(parade, ORDER, false, player())).toBeCloseTo(5 - 0.6, 9);
  });

  it("without a leader lap fraction", () => {
    const noLeaderPct = lapRace({ CarIdxLapDistPct: [0.6, -1, 0.5] });

    expect(resolveGapLapsRemaining(noLeaderPct, ORDER, false, player())).toBeCloseTo(5 - 0.6, 9);
  });

  it("without the player's average lap", () => {
    for (const avgLapTimeS of [null, 0, -90, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveGapLapsRemaining(lapRace(), ORDER, false, player({ avgLapTimeS }))).toBeCloseTo(5 - 0.6, 9);
    }
  });

  it("without the player's lap fraction, which also leaves nothing to subtract", () => {
    const offWorld = lapRace({ CarIdxLapDistPct: [-1, 0.3, 0.5] });

    expect(resolveGapLapsRemaining(offWorld, ORDER, false, player())).toBe(5);
  });

  it("without the player's car index", () => {
    expect(resolveGapLapsRemaining(lapRace(), ORDER, false, player({ carIdx: -1 }))).toBe(5);
  });

  it("without a leader in the order", () => {
    expect(resolveGapLapsRemaining(lapRace(), [2, 3, 4], false, player())).toBeCloseTo(5 - 0.6, 9);
  });
});

// ─── The call site ───────────────────────────────────────────────────────────

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

function createMockController(sessionInfo: Record<string, unknown> = defaultSessionInfo()): MockController {
  // Several subscribers, notified in subscription order as `SDKController`
  // does: the translator, then the replay recorder it starts (#1468).
  const subscribers = new Map<string, TelemetryCallback>();
  // The translator's replay guard reads the controller's debounced replay
  // state (#1324), stepped before each tick as the real controller does.
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
  } as unknown as MockController;

  controller.__tick = (telemetry) => {
    replayState.step(telemetry, sessionInfo, Date.now());

    for (const cb of [...subscribers.values()]) cb(telemetry, true);
  };

  return controller;
}

function defaultSessionInfo(): Record<string, unknown> {
  return {
    SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
    DriverInfo: { DriverCarIdx: 0 },
  };
}

/**
 * A race tick: car1 leads on a 90 s lap; the player (car0) runs third, behind
 * car2, unless the overrides say otherwise.
 */
function raceTick(overrides: Partial<TelemetryData>): TelemetryData {
  return {
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: true,
    PlayerTrackSurface: TrkLoc.OnTrack,
    PlayerTrackSurfaceMaterial: 0,
    PlayerCarMyIncidentCount: 0,
    PlayerIncidents: 0,
    PlayerCarTowTime: 0,
    SessionFlags: 0,
    SessionNum: 0,
    SessionState: SessionState.Racing,
    PitSvFlags: 0,
    PitSvTireCompound: 0,
    PlayerTireCompound: 0,
    EngineWarnings: 0,
    Speed: 0,
    CarLeftRight: CarLeftRight.Off,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    FuelLevel: 10,
    CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
    CarIdxClass: [0, 0, 0],
    CarIdxLastLapTime: [92, 90, 91],
    ...overrides,
  } as TelemetryData;
}

/**
 * A timed race with a 100-lap cap the clock will beat. The player (car0) is
 * on the line, so the horizon is the leader's crossings (#1311).
 */
function timedRace(timeRemainS: number, leaderLap: number, leaderPct: number): TelemetryData {
  return raceTick({
    SessionLapsRemainEx: 100,
    SessionTimeRemain: timeRemainS,
    Lap: 6,
    LapDistPct: 0,
    CarIdxLapCompleted: [5, leaderLap, 5],
    CarIdxLapDistPct: [0, leaderPct, 0.2],
  });
}

/**
 * A 5-lap race tick with the player (car0) on `lap` at `pct` and the leader
 * (car1) a lap counter ahead at 0.3; car2 runs a lap behind the player.
 */
function lapRaceTick(lap: number, pct: number, overrides: Partial<TelemetryData> = {}): TelemetryData {
  return raceTick({
    SessionLapsRemainEx: 5,
    SessionTimeRemain: IRSDK_UNLIMITED_TIME,
    Lap: lap,
    LapDistPct: pct,
    CarIdxLapCompleted: [lap - 1, lap, lap - 2],
    CarIdxLapDistPct: [pct, 0.3, 0.5],
    ...overrides,
  });
}

function lastHorizon(): unknown {
  const calls = diffGapsSpy.mock.calls;

  return calls[calls.length - 1]?.[LAPS_REMAINING_ARG];
}

describe("gap closing-announcement horizon at the call site (issues #1311, #1380)", () => {
  beforeEach(() => {
    initializeEventBus(createMockLogger());
    diffGapsSpy.mockClear();
  });

  afterEach(() => {
    _resetSimEventsIracing();
    _resetEventBus();
  });

  it("follows the clock through the white and chequered laps of a timed race with a larger lap cap", () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });

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

  it("hands no horizon outside a race", () => {
    const controller = createMockController({
      SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Practice" }] },
      DriverInfo: { DriverCarIdx: 0 },
    });
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });

    controller.__tick(timedRace(1200, 5, 0.25));
    expect(diffGapsSpy).toHaveBeenCalled();
    expect(lastHorizon()).toBeNull();
  });

  it("counts a lapped player's own crossings from their validated average lap", () => {
    const controller = createMockController();
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });

    // Without a lap of the player's own yet, the leader's 5 less the player's fraction.
    controller.__tick(lapRaceTick(9, 0.9, { SessionTime: 40, FuelLevel: 50 }));
    expect(lastHorizon()).toBeCloseTo(5 - 0.9, 9);

    // One clean 90 s lap, line to line.
    controller.__tick(lapRaceTick(10, 0.05, { SessionTime: 100, FuelLevel: 50 }));
    controller.__tick(lapRaceTick(10, 0.9, { SessionTime: 189, FuelLevel: 47.2 }));
    controller.__tick(lapRaceTick(11, 0.05, { SessionTime: 190, FuelLevel: 47 }));

    // 0.7 laps behind the leader on the leader's pace: the leader's flag
    // brings up lap 11 + 5 = 16, the player's chequered too — 6 crossings
    // from lap 10 completed, less the 0.6 already run.
    controller.__tick(lapRaceTick(11, 0.6, { SessionTime: 244, FuelLevel: 46 }));
    expect(lastHorizon()).toBeCloseTo(6 - 0.6, 9);
  });

  it("leaves the player their last lap after the leader's flag, and nothing after their own", () => {
    const controller = createMockController({
      WeekendInfo: { SimMode: "full" },
      DriverInfo: { DriverCarIdx: 0, Drivers: [{ CarIdx: 0, CarClassID: 1 }] },
      SessionInfo: {
        Sessions: [
          {
            SessionNum: 0,
            SessionType: "Race",
            ResultsPositions: [{ CarIdx: 0, Position: 3, ClassPosition: 2, LapsComplete: 5 }],
          },
        ],
      },
    });
    initializeSimEventsIracing(getEventBus(), controller, createMockLogger(), { onStepError: "rethrow" });

    // The leader has taken the flag (the counter reads 0) while the player,
    // a lap down, is 0.6 round their last lap.
    const finishTick = (lapCompleted: number, pct: number, flags: number): TelemetryData =>
      raceTick({
        SessionLapsRemainEx: 0,
        SessionTimeRemain: IRSDK_UNLIMITED_TIME,
        SessionState: flags === 0 ? SessionState.Racing : SessionState.Checkered,
        SessionFlags: flags,
        Lap: lapCompleted + 1,
        LapDistPct: pct,
        LapCompleted: lapCompleted,
        // A fresh lap time at the crossing, so the lap is emitted on it.
        LapLastLapTime: 58 + lapCompleted,
        LapBestLapTime: 62,
        CarIdxLapCompleted: [lapCompleted, 6, lapCompleted - 1],
        CarIdxLapDistPct: [pct, 0.2, 0.5],
      });

    controller.__tick(finishTick(4, 0.6, 0));
    expect(lastHorizon()).toBeCloseTo(1 - 0.6, 9);

    controller.__tick(finishTick(4, 0.7, Flags.Checkered));
    expect(lastHorizon()).toBeCloseTo(1 - 0.7, 9);

    // The player's crossing under the flag: `diffLaps` records the finish
    // earlier in the same tick, so the horizon is already 0.
    controller.__tick(finishTick(5, 0.05, Flags.Checkered));
    expect(lastHorizon()).toBe(0);
  });
});
