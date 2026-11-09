/**
 * The pit-lane landmark learner through the real tick (issue #1112): the
 * track identity resolved from the session info, the store's loader called
 * once per track and session, every car's edges folded into the instance's
 * learner and published, `getPitLaneLandmarks()` reading it, and nothing
 * learned while a replay is on screen.
 */
import { _resetEventBus, getEventBus, initializeEventBus, type SimEventOf } from "@iracedeck/event-bus";
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
import {
  foldSample,
  PIT_LANE_LOAD_RETRY_MS,
  PIT_LANE_SECTION_UNAVAILABLE,
  PIT_LANE_SECTION_VERSION,
  type PitLaneLandmarksLoader,
  type PitLaneSection,
  type PitLaneTrackIdentity,
} from "@iracedeck/track-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetSimEventsIracing, getPitLaneLandmarks, initializeSimEventsIracing } from "./translator.js";

const TRACK: PitLaneTrackIdentity = {
  sim: "iracing",
  trackId: 123,
  trackName: "testtrack",
  trackConfigName: "Grand Prix",
  trackLength: "4.00 km",
  trackLengthM: 4000,
  trackVersion: "2026.11.01.01",
};
const SUBSESSION = 555;

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

function createMockController(): MockController {
  const subscribers = new Map<string, TelemetryCallback>();
  const replayState = new ReplayStateTracker();
  const controller = {
    sessionInfo: {
      SessionInfo: {
        Sessions: [
          { SessionNum: 0, SessionType: "Practice" },
          { SessionNum: 1, SessionType: "Race" },
        ],
      },
      WeekendInfo: {
        TrackID: TRACK.trackId,
        TrackName: TRACK.trackName,
        TrackConfigName: TRACK.trackConfigName,
        TrackLength: TRACK.trackLength,
        TrackVersion: TRACK.trackVersion,
        SubSessionID: SUBSESSION,
        SimMode: "full",
      },
      DriverInfo: { DriverCarIdx: 0, PaceCarIdx: 5, Drivers: [] },
    },
    subscribe: (id: string, cb: TelemetryCallback) => {
      subscribers.set(id, cb);
      cb(null, false);
    },
    unsubscribe: (id: string) => {
      subscribers.delete(id);
    },
    getSessionInfo: () => controller.sessionInfo,
    getReplayState: (nowMs: number = Date.now()) => replayState.read(nowMs),
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

/** Per car: surface, pit road and lap position. Car 0 is the player, parked on track; car 5 the pace car. */
type Cars = Record<number, { surface: number; onPit?: boolean; pct: number }>;

function tick(t: number, cars: Cars, opts: { sessionNum?: number; replay?: boolean } = {}): TelemetryData {
  const size = 6;
  const surfaces = Array<number>(size).fill(TrkLoc.NotInWorld);
  const onPit = Array<boolean>(size).fill(false);
  const pcts = Array<number>(size).fill(-1);

  const withPlayer: Cars = { 0: { surface: TrkLoc.OnTrack, pct: 0.9 }, ...cars };

  for (const [key, car] of Object.entries(withPlayer)) {
    const i = Number(key);

    surfaces[i] = car.surface;
    onPit[i] = car.onPit ?? false;
    pcts[i] = car.pct;
  }

  return {
    SessionTime: t,
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: true,
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
    Speed: 0,
    CarLeftRight: CarLeftRight.Off,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: 4,
    LapCompleted: 3,
    LapDistPct: 0.9,
    FuelLevel: 10,
    CarIdxLapCompleted: pcts.map((p) => (p < 0 ? -1 : 3)),
    CarIdxLap: pcts.map((p) => (p < 0 ? -1 : 4)),
    CarIdxLapDistPct: pcts,
    CarIdxTrackSurface: surfaces,
    CarIdxOnPitRoad: onPit,
    CarIdxEstTime: pcts.map((p) => (p < 0 ? -1 : p * 90)),
    CarIdxClass: Array<number>(size).fill(20),
    CarIdxLastLapTime: Array<number>(size).fill(90),
  } as TelemetryData;
}

/** The ticks of one approach-zone entry by `car` at `pct`, from session time `t`. */
function enterApproach(controller: MockController, t: number, car: number, pct: number, sessionNum = 0): void {
  controller.__tick(tick(t, { [car]: { surface: TrkLoc.OnTrack, pct } }, { sessionNum }));
  controller.__tick(tick(t + 0.1, { [car]: { surface: TrkLoc.AproachingPits, pct: pct + 0.001 } }, { sessionNum }));
}

type Learned = SimEventOf<"pitLane.landmarkLearned">;

describe("pit-lane landmarks through handleTick (issue #1112)", () => {
  let controller: MockController;
  let logger: ILogger;
  let events: Learned[];

  function init(loader?: PitLaneLandmarksLoader): void {
    controller = createMockController();
    logger = createMockLogger();
    initializeSimEventsIracing(getEventBus(), controller, logger, {
      onStepError: "rethrow",
      ...(loader ? { loadPitLaneLandmarks: loader } : {}),
    });
    getEventBus().subscribe("pitLane.landmarkLearned", (ev) => {
      events.push(ev);
    });
  }

  beforeEach(() => {
    initializeEventBus(createMockLogger());
    events = [];
  });

  afterEach(() => {
    _resetSimEventsIracing();
    _resetEventBus();
  });

  it("answers null before the translator is initialised and before a live tick has loaded the track", () => {
    expect(getPitLaneLandmarks()).toBeNull();

    init(() => null);

    expect(getPitLaneLandmarks()).toBeNull();
  });

  it("learns every car's edge, publishes it with the session's track, and answers once two agree", () => {
    init(() => null);

    enterApproach(controller, 10, 1, 0.5);

    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({
      track: TRACK,
      landmark: "approachStart",
      sample: {
        pct: expect.closeTo(0.5005, 9),
        estTime: expect.closeTo(0.501 * 90, 9),
        carClassId: 20,
        key: `${SUBSESSION}:0:1:approachStart:4`,
        at: expect.any(Number),
      },
      summary: expect.objectContaining({ samples: 1, published: false }),
    });
    expect(getPitLaneLandmarks()).toEqual({
      approachStart: null,
      pitRoadStart: null,
      pitRoadEnd: null,
      blendEnd: null,
    });

    enterApproach(controller, 20, 2, 0.5002);

    expect(events).toHaveLength(2);
    expect(getPitLaneLandmarks()!.approachStart).toMatchObject({
      pct: expect.closeTo(0.5006, 9),
      samples: 2,
      published: true,
      source: "current",
      estTimeByClass: { "20": expect.any(Number) },
    });
  });

  it("never learns from the pace car", () => {
    init(() => null);

    enterApproach(controller, 10, 5, 0.5);

    expect(events).toEqual([]);
  });

  it("asks the loader once per track and session, again after a session change and after a disconnect", () => {
    const loader = vi.fn((_track: PitLaneTrackIdentity): PitLaneSection | null => null);

    init(loader);

    for (let t = 0; t < 1; t += 0.1) controller.__tick(tick(t, {}));

    expect(loader).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenLastCalledWith(TRACK);

    controller.__tick(tick(1, {}, { sessionNum: 1 }));
    controller.__tick(tick(1.1, {}, { sessionNum: 1 }));
    expect(loader).toHaveBeenCalledTimes(2);

    controller.__disconnect();
    expect(getPitLaneLandmarks()).toBeNull();

    controller.__tick(tick(2, {}, { sessionNum: 1 }));
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("builds the track identity once per session-info object, and picks up a changed one", () => {
    const loader = vi.fn((_track: PitLaneTrackIdentity): PitLaneSection | null => null);

    init(loader);

    // A fresh session info with `TrackVersion` read through a counter: only the identity reads it.
    const base = controller.sessionInfo;
    let versionReads = 0;
    const withVersion = (version: string): Record<string, unknown> => {
      const weekend = { ...(base.WeekendInfo as Record<string, unknown>) };

      Object.defineProperty(weekend, "TrackVersion", {
        enumerable: true,
        get: () => {
          versionReads++;

          return version;
        },
      });

      return { ...base, WeekendInfo: weekend };
    };

    controller.sessionInfo = withVersion(TRACK.trackVersion!);

    for (let t = 0; t < 1; t += 0.1) controller.__tick(tick(t, {}));

    expect(versionReads).toBe(1);
    expect(loader).toHaveBeenCalledOnce();

    // The YAML re-read with nothing changed: a new object, built once, and the learner keeps its track.
    controller.sessionInfo = withVersion(TRACK.trackVersion!);

    for (let t = 1; t < 2; t += 0.1) controller.__tick(tick(t, {}));

    expect(versionReads).toBe(2);
    expect(loader).toHaveBeenCalledOnce();

    // A changed identity in a new object is loaded.
    controller.sessionInfo = withVersion("2027.01.01.01");
    controller.__tick(tick(2, {}));
    controller.__tick(tick(2.1, {}));

    expect(versionReads).toBe(3);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenLastCalledWith({ ...TRACK, trackVersion: "2027.01.01.01" });

    enterApproach(controller, 10, 1, 0.5);

    expect(events.at(-1)!.data.track).toEqual({ ...TRACK, trackVersion: "2027.01.01.01" });
  });

  it("drops what it learned at a session change and starts from the store's answer", () => {
    const stored: PitLaneSection = { version: PIT_LANE_SECTION_VERSION, trackLength: TRACK.trackLength, landmarks: {} };
    const loader = vi.fn((_track: PitLaneTrackIdentity) => stored);

    init(loader);
    enterApproach(controller, 10, 1, 0.5);
    enterApproach(controller, 20, 2, 0.5002);
    expect(getPitLaneLandmarks()!.approachStart).not.toBeNull();

    controller.__tick(tick(30, {}, { sessionNum: 1 }));

    expect(getPitLaneLandmarks()!.approachStart).toBeNull();
    expect(stored.landmarks).toEqual({});
  });

  it("seeds a rebuilt track with the pre-rebuild values as the fallback", () => {
    const now = Date.now();
    const a = foldSample(undefined, { pct: 0.35, estTime: 31, carClassId: 20, key: "a", at: now - 1000 }, "", 4000);
    const b = foldSample(a.record, { pct: 0.35, estTime: 31, carClassId: 20, key: "b", at: now }, "", 4000);

    init(() => ({ version: PIT_LANE_SECTION_VERSION, trackLength: "3.99 km", landmarks: { pitRoadEnd: b.record! } }));
    controller.__tick(tick(0, {}));

    expect(getPitLaneLandmarks()).toEqual({
      approachStart: null,
      pitRoadStart: null,
      pitRoadEnd: { pct: 0.35, estTimeByClass: { "20": 31 }, samples: 2, published: true, source: "previous" },
      blendEnd: null,
    });
  });

  it("does not re-publish a sample the store already holds", () => {
    const key = `${SUBSESSION}:0:1:approachStart:4`;
    const held = foldSample(undefined, { pct: 0.5005, estTime: 45, carClassId: 20, key, at: Date.now() }, "", 4000);

    init(() => ({
      version: PIT_LANE_SECTION_VERSION,
      trackLength: TRACK.trackLength,
      landmarks: { approachStart: held.record! },
    }));
    enterApproach(controller, 10, 1, 0.5);

    expect(events).toEqual([]);
    expect(getPitLaneLandmarks()!.approachStart).toBeNull();
  });

  it("learns afresh when the loader throws, and the tick carries on", () => {
    init(() => {
      throw new Error("store unavailable");
    });

    enterApproach(controller, 10, 1, 0.5);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("store unavailable"));
    expect(events).toHaveLength(1);
  });

  it("learns while the store cannot read the track, asks again on the tick's clock, and keeps what it learned", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });

    try {
      const stored: PitLaneSection = {
        version: PIT_LANE_SECTION_VERSION,
        trackLength: TRACK.trackLength,
        landmarks: {
          approachStart: foldSample(
            undefined,
            { pct: 0.5009, estTime: 45, carClassId: 20, key: "disk", at: Date.now() - 60_000 },
            "",
            4000,
          ).record!,
        },
      };
      let readable = false;
      const loader = vi.fn((_track: PitLaneTrackIdentity) => (readable ? stored : PIT_LANE_SECTION_UNAVAILABLE));

      init(loader);
      enterApproach(controller, 10, 1, 0.5);

      expect(loader).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("cannot be read yet (attempt 1)"));
      expect(events).toHaveLength(1);
      expect(getPitLaneLandmarks()!.approachStart).toBeNull();

      readable = true;
      vi.advanceTimersByTime(PIT_LANE_LOAD_RETRY_MS - 1);
      controller.__tick(tick(15, {}));

      expect(loader).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(1);
      controller.__tick(tick(15.1, {}));

      expect(loader).toHaveBeenCalledTimes(2);
      // The stored sample and the one learned while waiting agree: published.
      expect(getPitLaneLandmarks()!.approachStart).toMatchObject({ samples: 2, published: true, source: "current" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("learns from nothing without a loader", () => {
    init();

    enterApproach(controller, 10, 1, 0.5);

    expect(events).toHaveLength(1);
  });

  it("learns nothing, and loads nothing, while a replay is on screen", () => {
    const loader = vi.fn((_track: PitLaneTrackIdentity): PitLaneSection | null => null);

    init(loader);

    controller.__tick(tick(10, { 1: { surface: TrkLoc.OnTrack, pct: 0.5 } }, { replay: true }));
    controller.__tick(tick(10.1, { 1: { surface: TrkLoc.AproachingPits, pct: 0.501 } }, { replay: true }));

    expect(events).toEqual([]);
    expect(loader).not.toHaveBeenCalled();
    expect(getPitLaneLandmarks()).toBeNull();
  });

  it("keeps the learned landmarks through a replay visit", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });

    try {
      const loader = vi.fn((_track: PitLaneTrackIdentity): PitLaneSection | null => null);

      init(loader);
      enterApproach(controller, 10, 1, 0.5);
      enterApproach(controller, 20, 2, 0.5002);

      controller.__tick(tick(30, {}, { replay: true }));
      vi.advanceTimersByTime(5_000);
      controller.__tick(tick(35, {}));
      vi.advanceTimersByTime(5_000);
      controller.__tick(tick(40, {}));

      expect(loader).toHaveBeenCalledOnce();
      expect(getPitLaneLandmarks()!.approachStart).toMatchObject({ samples: 2, published: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
