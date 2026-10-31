/**
 * The replay recorders end to end (issues #1203, #1354, #1426, #1468): driven
 * through `initializeSimEventsIracing`, which starts the translator and then
 * the replay recorder (`replay-recorder.ts`) on one controller, so each test
 * is the production wiring — the recorders' gates, the recorder subscriber's
 * resets, and the order the bus sees them in beside the translator's events.
 * The recorder subscriber's own sequencing, with the recorders mocked, is
 * `replay-recorder.test.ts`; the whole stream across every reset point is the
 * equivalence golden (`replay-recorder.equivalence.test.ts`).
 *
 * Moved from `translator.test.ts` with the recorders (#1468); the fake
 * controller, `telemetry()` and `elapseReplayGrace()` are that file's.
 */
import { _resetEventBus, getEventBus, initializeEventBus, type SimEventOf } from "@iracedeck/event-bus";
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
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetSimEventsIracing, initializeSimEventsIracing } from "./translator.js";

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

/**
 * `translator.test.ts`'s controller double: several subscribers, notified in
 * subscription order as `SDKController` does (the translator, then the replay
 * recorder); `subscribe` replays the offline tick the real one sends; the
 * SDK's own replay tracker is stepped before each tick and reset on a
 * disconnect tick.
 */
function createMockController(): MockController {
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

  controller.__tick = (telemetry, isConnected = true) => {
    if (telemetry) {
      replayState.step(telemetry, sessionInfo, Date.now());
    } else {
      replayState.reset();
    }

    for (const cb of [...subscribers.values()]) cb(telemetry, isConnected);
  };
  controller.__setSessionInfo = (info) => {
    sessionInfo = info;
  };

  return controller;
}

/** Lets the replay grace (#1324) run out, so the next tick is the first one taken as live. */
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

describe("the replay recorders, through initializeSimEventsIracing", () => {
  beforeEach(() => {
    initializeEventBus(createMockLogger());
  });

  afterEach(() => {
    _resetSimEventsIracing();
    _resetEventBus();
    vi.useRealTimers();
  });

  // Issue #1203: the replay lap record sees every tick — it must SEE the ticks
  // it cannot record (a replay on screen, a replay-only session) and mark
  // itself unseeded, so the first live tick back re-seeds from the field as it
  // is then rather than fabricating the crossings it missed. Its baselines are
  // reset at both edges of a replay view by design.
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

    it("sees the replay ticks: a crossing seen from the replay view is never fabricated on the way back", () => {
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
      // signature this test pins of a recorder that sees replay ticks and is
      // reset on the way out — the replay-exit reset that follows it re-seeds
      // once more, so a crossing on the second live tick is absorbed too.
      // Putting the recorder behind a replay guard, or dropping that reset,
      // would emit that one.
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

    describe("the 2026-09-17 crossings capture, through initializeSimEventsIracing", () => {
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
  // gate, same subscriber, same resets — so its wiring is pinned the same way:
  // through the real tick loop, by the signature only a recorder that sees
  // replay ticks and is reset at their edges leaves.
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

    it("sees the replay ticks: a green that flew behind the replay view is never fabricated on the way back", () => {
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
      // re-seeds without emitting, and — the signature this test pins — the
      // replay-exit reset that follows it re-seeds once more, so the state
      // entering Racing on the SECOND live tick is absorbed too. Putting the
      // recorder behind a replay guard, or dropping that reset, would emit
      // that one as the start.
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

    it("records a restart on the tick caution.restarted fires, and publishes it after — the recorder's tick follows the translator's", () => {
      // The two are decided by one predicate (`isRestartGreenEdge`) over two
      // latches: the caution diff's phase and the recorder's own. The order
      // is the wiring's (#1468): the translator flushes the caution diff's
      // `pending` list at the end of its tick, and the replay recorder, which
      // `initializeSimEventsIracing` subscribes second, publishes on the same
      // controller tick right after. Inside the translator, before #1468, the
      // recorder published first; replay-store, the one reader of
      // `replay.greenFlag`, does not depend on the order.
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

      expect(stream).toEqual(["caution.restarted", "replay.greenFlag:restart@71904"]);
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
  // car at the live edge), which only a recorder that sees replay ticks and
  // whose record outlives the replay resets can record from — so it is pinned
  // by publishing from the garage and by publishing a pair once across trips
  // to it. The incident record is the lap and green records' sibling and is
  // pinned by their signature.
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

    it("publishes a session first seen from the garage at the live edge, a tick the translator's replay guard swallows", () => {
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

    it("publishes a pair once across trips between the car and the garage: its record outlives the replay resets", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession());
      const seen = recordStarts();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(carTick({ frame: 156_000, time: 600 }));
      controller.__tick(carTick({ frame: 156_001, time: 600 + 1 / 60 }));

      // Into the garage: the recorder's entry reset runs on the first of these.
      for (let i = 0; i < 4; i++) {
        controller.__tick(garageTick({ frame: 160_000 + i, time: (40_000 + i) / 60 }));
      }

      // Back in the car: the exit reset runs on the first live tick.
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
      // The recorder's session-change reset runs ahead of its recorders.
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

    it("sees the replay ticks: a rise behind the replay view is never stamped with the frame of the way back", () => {
      const controller = createMockController();
      controller.__setSessionInfo(liveSession([0, 0]));
      const seen = recordIncidents();
      initializeSimEventsIracing(getEventBus(), controller, createMockLogger());

      controller.__tick(incidentTick({ player: 0 })); // seed
      controller.__tick(incidentTick({ player: 0, replay: true }));
      controller.__tick(incidentTick({ player: 4, replay: true }));
      // Back live, once the exit grace has run (#1324). The first tick
      // re-seeds without emitting, and — the same signature — the replay-exit
      // reset that follows it re-seeds once more, so a rise on the second live
      // tick is absorbed too. Putting the recorder behind a replay guard, or
      // dropping that reset, would emit it.
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
});
