import { TrkLoc } from "@iracedeck/iracing-sdk";
import { createErrorBoundary, type ILogger, silentLogger } from "@iracedeck/logger";
import {
  createPitLaneLandmarkLearner,
  foldSample,
  loadPitLaneLandmarkLearner,
  PIT_LANE_LOAD_RETRY_MS,
  PIT_LANE_SECTION_UNAVAILABLE,
  PIT_LANE_SECTION_VERSION,
  type PitLaneLandmarkLearner,
  type PitLaneLandmarkRecord,
  type PitLaneSection,
  type PitLaneTrackIdentity,
  pitLaneTrackKey,
  resolvePitLaneLandmarks,
} from "@iracedeck/track-data";
import { describe, expect, it, vi } from "vitest";

import { IRACING_SIM_ID } from "../sim-id.js";
import { createPitLaneLandmarksState, type PitLaneLandmarksState } from "../state.js";
import { TickSteps } from "../tick-steps.js";
import {
  diffPitLaneLandmarks,
  IRACING_SESSION_TICKS_PER_S,
  PIT_LANE_EDGE_SETTLE_S,
  PIT_LANE_LANDMARKS_EVENTS,
  PIT_LANE_MAX_EDGE_SPAN_S,
  PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS,
  resolvePitLaneTrackIdentity,
  seedPitLaneLandmarkLearner,
} from "./pit-lane-landmarks.js";
import type { PendingEvent } from "./types.js";

/** A 4 km track: one lap fraction of 0.001 is 4 m, and the 5 m tolerance is 0.00125. */
const TRACK: PitLaneTrackIdentity = {
  sim: "iracing",
  trackId: 123,
  trackName: "testtrack",
  trackConfigName: "Grand Prix",
  trackLength: "4.00 km",
  trackLengthM: 4000,
  trackVersion: "2026.11.01.01",
};
const SUBSESSION = 777;
const SESSION_NUM = 2;
const WALL_EPOCH = 1_800_000_000_000;
const CARS = 6;

/** One car's readings on one tick; anything left out takes the default below. */
type CarReading = { surface: number; onPit?: boolean; pct: number; est?: number; lap?: number; cls?: number };

/**
 * A tick's telemetry: the cars named, every other slot out of the world.
 * `SessionTick` is the session time at iRacing's 60 Hz unless given.
 */
function telemetry(
  sessionTime: number,
  cars: Record<number, CarReading>,
  sessionTick = Math.round(sessionTime * IRACING_SESSION_TICKS_PER_S),
  size = CARS,
): Record<string, unknown> {
  const t = {
    SessionTime: sessionTime,
    SessionTick: sessionTick,
    SessionNum: SESSION_NUM,
    CarIdxTrackSurface: Array<number>(size).fill(TrkLoc.NotInWorld),
    CarIdxOnPitRoad: Array<boolean>(size).fill(false),
    CarIdxLapDistPct: Array<number>(size).fill(-1),
    CarIdxEstTime: Array<number>(size).fill(-1),
    CarIdxLap: Array<number>(size).fill(-1),
    CarIdxClass: Array<number>(size).fill(10),
  };

  for (const [key, car] of Object.entries(cars)) {
    const i = Number(key);

    t.CarIdxTrackSurface[i] = car.surface;
    t.CarIdxOnPitRoad[i] = car.onPit ?? false;
    t.CarIdxLapDistPct[i] = car.pct;
    t.CarIdxEstTime[i] = car.est ?? car.pct * 90;
    t.CarIdxLap[i] = car.lap ?? 3;
    t.CarIdxClass[i] = car.cls ?? 10;
  }

  return t;
}

function loadedLearner(
  track: PitLaneTrackIdentity = TRACK,
  section: PitLaneSection | null = null,
): PitLaneLandmarkLearner {
  const learner = createPitLaneLandmarkLearner();

  loadPitLaneLandmarkLearner(learner, track, () => section, 0);

  return learner;
}

type Harness = {
  slice: PitLaneLandmarksState;
  learner: PitLaneLandmarkLearner;
  /** Run one tick at `sessionTime` (wall clock = epoch + session time) and return its events. */
  tick(
    sessionTime: number,
    cars: Record<number, CarReading>,
    opts?: {
      pace?: number | null;
      subSession?: number | null;
      sessionTick?: number;
      /** `PlayerCarIdx`; absent when not given. */
      player?: number;
      /** The player's `OnPitRoad`; absent when not given. */
      playerOnPit?: boolean;
    },
  ): PendingEvent[];
};

function harness(learner: PitLaneLandmarkLearner = loadedLearner(), logger?: ILogger): Harness {
  const slice = createPitLaneLandmarksState();

  return {
    slice,
    learner,
    tick(sessionTime, cars, opts = {}) {
      const out: PendingEvent[] = [];
      const t = telemetry(sessionTime, cars, opts.sessionTick);

      if (opts.player !== undefined) t.PlayerCarIdx = opts.player;

      if (opts.playerOnPit !== undefined) t.OnPitRoad = opts.playerOnPit;

      diffPitLaneLandmarks(
        slice,
        learner,
        t as never,
        opts.pace === undefined ? null : opts.pace,
        opts.subSession === undefined ? SUBSESSION : opts.subSession,
        WALL_EPOCH + Math.round(sessionTime * 1000),
        (ev) => out.push(ev),
        undefined,
        logger,
      );

      return out;
    },
  };
}

type Learned = Extract<PendingEvent, { event: "pitLane.landmarkLearned" }>["data"];

function learned(events: PendingEvent[]): Learned[] {
  return events.map((ev) => {
    expect(ev.event).toBe("pitLane.landmarkLearned");

    return ev.data as Learned;
  });
}

const ON = TrkLoc.OnTrack;
const APPROACH = TrkLoc.AproachingPits;
const STALL = TrkLoc.InPitStall;
const OFF = TrkLoc.OffTrack;
const GONE = TrkLoc.NotInWorld;

/** How {@link drivePitVisit} reports the car's pit road. */
type PitRoadFlags = {
  /** What `CarIdxOnPitRoad` reads, given whether the car is really on pit road; the truth when absent. */
  perCar?: (onPitRoad: boolean) => boolean;
  /** The car is the player: `PlayerCarIdx` names it and `OnPitRoad` reads the truth. */
  player?: boolean;
};

/**
 * Car 1 drives a whole pit visit at 0.1 s ticks: track → approach → pit road →
 * stall → pit road → approach → track. Returns every event, in order.
 */
function drivePitVisit(h: Harness, car = 1, t0 = 100, flags: PitRoadFlags = {}): PendingEvent[] {
  const events: PendingEvent[] = [];
  const at = (dt: number, reading: CarReading) => {
    const onPitRoad = reading.onPit ?? false;
    const perCar = flags.perCar ? flags.perCar(onPitRoad) : onPitRoad;

    events.push(
      ...h.tick(
        t0 + dt,
        { [car]: { ...reading, onPit: perCar } },
        flags.player ? { player: car, playerOnPit: onPitRoad } : {},
      ),
    );
  };

  at(0.0, { surface: ON, pct: 0.3 });
  at(0.1, { surface: ON, pct: 0.301 }); // approach starts between 0.301 and 0.302
  at(0.2, { surface: APPROACH, pct: 0.302 });
  at(2.0, { surface: APPROACH, pct: 0.31 }); // pit road starts between 0.31 and 0.311
  at(2.1, { surface: APPROACH, onPit: true, pct: 0.311 });
  at(10.0, { surface: APPROACH, onPit: true, pct: 0.33 });
  at(10.1, { surface: STALL, onPit: true, pct: 0.331 });
  at(30.0, { surface: STALL, onPit: true, pct: 0.331 });
  at(30.1, { surface: APPROACH, onPit: true, pct: 0.3312 });
  at(40.0, { surface: APPROACH, onPit: true, pct: 0.35 }); // pit road ends between 0.35 and 0.351
  at(40.1, { surface: APPROACH, pct: 0.351 });
  at(45.0, { surface: APPROACH, pct: 0.36 }); // the blend line between 0.36 and 0.361
  at(45.1, { surface: ON, pct: 0.361 });
  at(46.0, { surface: ON, pct: 0.37 });

  return events;
}

describe("diffPitLaneLandmarks", () => {
  it("declares the one event it emits", () => {
    expect(PIT_LANE_LANDMARKS_EVENTS).toEqual(["pitLane.landmarkLearned"]);
  });

  describe("the four edges", () => {
    it("learns all four, in driving order, from one pit visit and nothing else", () => {
      const h = harness();
      const events = learned(drivePitVisit(h));

      expect(events.map((e) => e.landmark)).toEqual(["approachStart", "pitRoadStart", "pitRoadEnd", "blendEnd"]);
      expect(events.map((e) => e.sample.pct)).toEqual([
        expect.closeTo(0.3015, 9),
        expect.closeTo(0.3105, 9),
        expect.closeTo(0.3505, 9),
        expect.closeTo(0.3605, 9),
      ]);
    });

    it("builds the sample from the edge: midpoint, the later tick's estTime and lap, class, key and wall clock", () => {
      const h = harness();

      h.tick(10, { 2: { surface: ON, pct: 0.5, est: 45, lap: 7, cls: 31 } });
      const [event] = learned(h.tick(10.1, { 2: { surface: APPROACH, pct: 0.501, est: 45.1, lap: 7, cls: 31 } }));

      expect(event).toEqual({
        track: TRACK,
        landmark: "approachStart",
        sample: {
          pct: expect.closeTo(0.5005, 9),
          estTime: 45.1,
          carClassId: 31,
          key: `${SUBSESSION}:${SESSION_NUM}:2:approachStart:7`,
          at: WALL_EPOCH + 10_100,
        },
        summary: { pct: expect.closeTo(0.5005, 9), estTimeByClass: { "31": 45.1 }, samples: 1, published: false },
      });
    });

    it("folds each accepted sample into the learner, replacing the section rather than mutating it", () => {
      const loaded: PitLaneSection = {
        version: PIT_LANE_SECTION_VERSION,
        trackLength: TRACK.trackLength,
        landmarks: {},
      };
      const h = harness(loadedLearner(TRACK, loaded));
      const before = h.learner.section;

      drivePitVisit(h);

      expect(h.learner.section).not.toBe(before);
      expect(before?.landmarks).toEqual({});
      expect(loaded.landmarks).toEqual({});
      expect(Object.keys(h.learner.section!.landmarks).sort()).toEqual(
        ["approachStart", "blendEnd", "pitRoadEnd", "pitRoadStart"].sort(),
      );
      expect(h.learner.section!.landmarks.pitRoadEnd!.window).toHaveLength(1);
      expect(h.learner.section!.landmarks.pitRoadEnd!.updatedAt).toBe(new Date(WALL_EPOCH + 140_100).toISOString());
    });

    it("publishes a landmark once two cars agree on it", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.5 }, 2: { surface: ON, pct: 0.4995 } });
      const first = learned(h.tick(10.1, { 1: { surface: APPROACH, pct: 0.501 }, 2: { surface: ON, pct: 0.5005 } }));

      expect(first[0]!.summary.published).toBe(false);
      expect(resolvePitLaneLandmarks(h.learner)!.approachStart).toBeNull();

      const second = learned(
        h.tick(10.2, { 1: { surface: APPROACH, pct: 0.502 }, 2: { surface: APPROACH, pct: 0.5011 } }),
      );

      expect(second[0]!.summary).toMatchObject({ samples: 2, published: true });
      expect(resolvePitLaneLandmarks(h.learner)!.approachStart).toMatchObject({
        pct: expect.closeTo(0.50065, 9),
        samples: 2,
        source: "current",
      });
    });

    it("emits one event per accepted edge when two edges share a tick", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.5 } });
      const events = learned(h.tick(10.1, { 1: { surface: APPROACH, onPit: true, pct: 0.501 } }));

      expect(events.map((e) => e.landmark)).toEqual(["approachStart", "pitRoadStart"]);
    });
  });

  describe("whether CarIdxOnPitRoad is sound or not", () => {
    const landmarks = (events: PendingEvent[]) => learned(events).map((e) => e.landmark);

    it("a remote car whose flag is sound teaches all four", () => {
      expect(landmarks(drivePitVisit(harness(), 1, 100))).toEqual([
        "approachStart",
        "pitRoadStart",
        "pitRoadEnd",
        "blendEnd",
      ]);
    });

    it("a remote car whose flag reads true throughout teaches the approach, and the blend from its stall exit", () => {
      expect(landmarks(drivePitVisit(harness(), 1, 100, { perCar: () => true }))).toEqual([
        "approachStart",
        "blendEnd",
      ]);
    });

    it("a remote car whose flag reads false throughout teaches the approach, and the blend from its stall exit", () => {
      expect(landmarks(drivePitVisit(harness(), 1, 100, { perCar: () => false }))).toEqual([
        "approachStart",
        "blendEnd",
      ]);
    });

    it("the player teaches all four from OnPitRoad, whatever its CarIdxOnPitRoad reads", () => {
      for (const perCar of [() => true, () => false, (onPitRoad: boolean) => onPitRoad]) {
        expect(landmarks(drivePitVisit(harness(), 1, 100, { player: true, perCar }))).toEqual([
          "approachStart",
          "pitRoadStart",
          "pitRoadEnd",
          "blendEnd",
        ]);
      }
    });

    it("reads OnPitRoad for the player's car only", () => {
      const h = harness();

      // Car 2 is the player, car 1 is not: OnPitRoad true says nothing about car 1.
      h.tick(10, { 1: { surface: APPROACH, pct: 0.31 }, 2: { surface: APPROACH, pct: 0.61 } }, { player: 2 });
      const events = learned(
        h.tick(
          10.1,
          { 1: { surface: APPROACH, pct: 0.311 }, 2: { surface: APPROACH, pct: 0.611 } },
          { player: 2, playerOnPit: true },
        ),
      );

      expect(events.map((e) => e.sample.key)).toEqual([`${SUBSESSION}:${SESSION_NUM}:2:pitRoadStart:3`]);
      expect(h.slice.cars[1]).toMatchObject({ onPitRoad: false });
    });

    it("reads CarIdxOnPitRoad for the player when PlayerCarIdx or OnPitRoad is missing", () => {
      const noScalar = harness();

      noScalar.tick(10, { 2: { surface: APPROACH, pct: 0.31 } }, { player: 2 });
      expect(
        learned(noScalar.tick(10.1, { 2: { surface: APPROACH, onPit: true, pct: 0.311 } }, { player: 2 })).map(
          (e) => e.landmark,
        ),
      ).toEqual(["pitRoadStart"]);

      const noPlayer = harness();

      noPlayer.tick(10, { 2: { surface: APPROACH, pct: 0.31 } }, { playerOnPit: false });
      expect(
        learned(noPlayer.tick(10.1, { 2: { surface: APPROACH, onPit: true, pct: 0.311 } }, { playerOnPit: false })).map(
          (e) => e.landmark,
        ),
      ).toEqual(["pitRoadStart"]);
    });
  });

  describe("the way out of the stall", () => {
    it("marks the car as leaving the pit lane, whatever its pit-road flag reads", () => {
      const h = harness();

      h.tick(30, { 1: { surface: STALL, pct: 0.331 }, 2: { surface: STALL, onPit: true, pct: 0.341 } });
      h.tick(30.1, { 1: { surface: APPROACH, pct: 0.3312 }, 2: { surface: APPROACH, onPit: true, pct: 0.3412 } });

      expect(h.slice.cars[1]).toMatchObject({ fromPitLane: true });
      expect(h.slice.cars[2]).toMatchObject({ fromPitLane: true });
    });

    it("does not mark a tow or a reset into the stall, nor a reset out of it", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.7 } });
      h.tick(10.1, { 1: { surface: STALL, pct: 0.331 } });
      expect(h.slice.cars[1]).toMatchObject({ fromPitLane: false });
      h.tick(10.2, { 1: { surface: ON, pct: 0.7 } });
      expect(h.slice.cars[1]).toMatchObject({ fromPitLane: false });
    });

    it("clears the mark on any tick read OnTrack, even with the pit-road flag on", () => {
      const h = harness();

      h.tick(30, { 1: { surface: STALL, onPit: true, pct: 0.331 } });
      h.tick(30.1, { 1: { surface: APPROACH, onPit: true, pct: 0.3312 } });
      // Out of the world across the blend line: no edge, but the visit is over.
      h.tick(35, { 1: { surface: GONE, onPit: true, pct: -1 } });
      h.tick(40, { 1: { surface: ON, onPit: true, pct: 0.4 } });

      expect(h.slice.cars[1]).toMatchObject({ fromPitLane: false, rejoinedAt: 40 });

      // So its next pit entry is one, though its flag still reads true.
      h.tick(100, { 1: { surface: ON, onPit: true, pct: 0.3, lap: 4 } });
      expect(
        learned(h.tick(100.1, { 1: { surface: APPROACH, onPit: true, pct: 0.301, lap: 4 } })).map((e) => e.landmark),
      ).toEqual(["approachStart"]);
    });

    it("takes no blend line from a car that entered the approach from the track and left it without a stall or pit road", () => {
      const h = harness();

      // Spa's car 14: OnTrack → AproachingPits at 0.076 and back at 0.149, no stall.
      h.tick(10, { 1: { surface: ON, pct: 0.076 } });
      expect(learned(h.tick(10.1, { 1: { surface: APPROACH, pct: 0.0761 } })).map((e) => e.landmark)).toEqual([
        "approachStart",
      ]);
      h.tick(19, { 1: { surface: APPROACH, pct: 0.1487 } });

      expect(h.tick(19.1, { 1: { surface: ON, pct: 0.1488 } })).toEqual([]);
    });
  });

  describe("blendEnd needs pit road first", () => {
    it("does not take an approach-to-track edge from a car that was never on pit road", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.5 } });
      h.tick(10.1, { 1: { surface: APPROACH, pct: 0.501 } }); // approachStart
      h.tick(12, { 1: { surface: APPROACH, pct: 0.51 } });

      // An aborted entry: back onto the track without pit road.
      expect(h.tick(12.1, { 1: { surface: ON, pct: 0.511 } })).toEqual([]);
    });

    it("does not take one from a car first seen in the approach zone", () => {
      const h = harness();

      h.tick(10, { 1: { surface: APPROACH, pct: 0.36 } });

      expect(h.tick(10.1, { 1: { surface: ON, pct: 0.361 } })).toEqual([]);
    });

    it("learns the blend line once per pit exit", () => {
      const h = harness();

      h.tick(40, { 1: { surface: APPROACH, onPit: true, pct: 0.35 } });
      h.tick(40.1, { 1: { surface: APPROACH, pct: 0.351 } });
      h.tick(45, { 1: { surface: APPROACH, pct: 0.36 } });
      expect(learned(h.tick(45.1, { 1: { surface: ON, pct: 0.361 } })).map((e) => e.landmark)).toEqual(["blendEnd"]);
      h.tick(45.2, { 1: { surface: APPROACH, pct: 0.3615 } });
      // A second approach-to-track edge after the blend is not another blend.
      expect(h.tick(45.3, { 1: { surface: ON, pct: 0.362 } })).toEqual([]);
    });

    it("takes both pitRoadEnd and blendEnd where pit road ends straight onto the track, then forgets pit road", () => {
      const h = harness();

      h.tick(40, { 1: { surface: APPROACH, onPit: true, pct: 0.35 } });
      // Pit road straight onto the track: both edges on one tick, and the flag is cleared.
      expect(learned(h.tick(40.1, { 1: { surface: ON, pct: 0.351 } })).map((e) => e.landmark)).toEqual([
        "pitRoadEnd",
        "blendEnd",
      ]);
      h.tick(60, { 1: { surface: APPROACH, pct: 0.6 } });

      expect(h.tick(60.1, { 1: { surface: ON, pct: 0.601 } })).toEqual([]);
    });
  });

  describe("approachStart is the way in only", () => {
    it("takes no approach edge while the car is still marked as coming from pit road", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.5 } });
      // No drive leaves the mark on a car read OnTrack (the blend or the
      // OnTrack-off-pit-road tick clears it), so plant it: the rule is a guard.
      h.slice.cars[1]!.fromPitLane = true;

      expect(h.tick(10.1, { 1: { surface: APPROACH, onPit: true, pct: 0.501 } }).map((ev) => ev.data)).toEqual([
        expect.objectContaining({ landmark: "pitRoadStart" }),
      ]);
    });

    it("takes no approach edge within the settle time of rejoining the track, and does after it", () => {
      const h = harness();

      h.tick(40, { 1: { surface: APPROACH, onPit: true, pct: 0.35 } });
      h.tick(40.1, { 1: { surface: APPROACH, pct: 0.351 } });
      h.tick(45, { 1: { surface: APPROACH, pct: 0.36 } });
      expect(learned(h.tick(45.1, { 1: { surface: ON, pct: 0.361 } }))).toHaveLength(1); // blendEnd
      // A flicker at the blend line.
      expect(h.tick(45.1 + PIT_LANE_EDGE_SETTLE_S - 0.2, { 1: { surface: APPROACH, pct: 0.3611 } })).toEqual([]);
      h.tick(45.1 + PIT_LANE_EDGE_SETTLE_S - 0.1, { 1: { surface: ON, pct: 0.3612 } });
      h.tick(100, { 1: { surface: ON, pct: 0.3, lap: 4 } });

      expect(learned(h.tick(100.1, { 1: { surface: APPROACH, pct: 0.301, lap: 4 } })).map((e) => e.landmark)).toEqual([
        "approachStart",
      ]);
    });

    it("never takes the way out of the stall as an approach", () => {
      const h = harness();

      h.tick(30, { 1: { surface: STALL, onPit: true, pct: 0.331 } });
      h.tick(30.1, { 1: { surface: APPROACH, onPit: true, pct: 0.3312 } });
      h.tick(40, { 1: { surface: APPROACH, onPit: true, pct: 0.35 } });
      const events = learned(h.tick(40.1, { 1: { surface: APPROACH, pct: 0.351 } }));

      expect(events.map((e) => e.landmark)).toEqual(["pitRoadEnd"]);
    });
  });

  describe("rejections", () => {
    it("only seeds on a car's first tick", () => {
      const h = harness();

      expect(h.tick(10, { 1: { surface: APPROACH, onPit: true, pct: 0.311 } })).toEqual([]);
      expect(h.slice.cars[1]).toMatchObject({ surface: APPROACH, onPitRoad: true, fromPitLane: false });
    });

    it("ignores a tow into the stall: no pit-road edge out of the world", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.7 } });
      expect(h.tick(10.1, { 1: { surface: GONE, onPit: true, pct: -1 } })).toEqual([]);
      expect(h.tick(10.2, { 1: { surface: STALL, onPit: true, pct: 0.331 } })).toEqual([]);
      expect(h.slice.cars[1]).toMatchObject({ surface: STALL, onPitRoad: true });
    });

    it("ignores a reset straight into the stall from the track", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.33 } });

      expect(h.tick(10.1, { 1: { surface: STALL, onPit: true, pct: 0.3301 } })).toEqual([]);
    });

    it("ignores a teleport: an edge across a distance no car drives in one tick", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.2 } });

      expect(h.tick(10.1, { 1: { surface: APPROACH, pct: 0.301 } })).toEqual([]);
    });

    it("draws the plausibility line at the speed ceiling, wrap-aware", () => {
      const h = harness();
      const dt = 0.1;
      const ceilingPct = (PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS * dt) / TRACK.trackLengthM!;

      h.tick(10, { 1: { surface: ON, pct: 0.5 }, 2: { surface: ON, pct: 0.99995 } });
      const events = learned(
        h.tick(10 + dt, {
          1: { surface: APPROACH, pct: 0.5 + ceilingPct * 1.01 },
          2: { surface: APPROACH, pct: 0.99995 + ceilingPct * 0.99 - 1, lap: 4 },
        }),
      );

      expect(events.map((e) => e.sample.key)).toEqual([`${SUBSESSION}:${SESSION_NUM}:2:approachStart:4`]);
    });

    it("ignores an edge on a tick where neither SessionTime nor SessionTick moved forward", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.5 } }, { sessionTick: 600 });

      expect(h.tick(10, { 1: { surface: APPROACH, pct: 0.5001 } }, { sessionTick: 600 })).toEqual([]);
      expect(h.slice.cars[1]).toMatchObject({ surface: APPROACH, sessionTime: 10, sessionTick: 600 });
    });

    it("never learns from the pace car", () => {
      const h = harness();

      h.tick(10, { 4: { surface: ON, pct: 0.5 } }, { pace: 4 });

      expect(h.tick(10.1, { 4: { surface: APPROACH, pct: 0.501 } }, { pace: 4 })).toEqual([]);
      expect(h.slice.cars[4]).toBeUndefined();
    });

    it("updates the baseline on a NotInWorld tick and accepts no edge from or into it", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.5 } });
      expect(h.tick(10.1, { 1: { surface: GONE, pct: -1 } })).toEqual([]);
      expect(h.slice.cars[1]).toMatchObject({ surface: GONE, pct: -1 });
      expect(h.tick(10.2, { 1: { surface: APPROACH, pct: 0.5002 } })).toEqual([]);
    });

    it("accepts no edge on a tick with no position", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.5 } });
      expect(h.tick(10.1, { 1: { surface: APPROACH, pct: -1 } })).toEqual([]);
      expect(h.slice.cars[1]).toMatchObject({ surface: APPROACH, pct: -1 });
    });

    it("takes no pit-road edge from CarIdxOnPitRoad flipping on a car read OnTrack", () => {
      const h = harness();

      // The rolling-start and caution captures read pit road true for cars on the racing surface.
      h.tick(10, { 1: { surface: ON, pct: 0.99 } });
      expect(h.tick(10.1, { 1: { surface: ON, onPit: true, pct: 0.991 } })).toEqual([]);
      expect(h.tick(70, { 1: { surface: ON, onPit: true, pct: 0.5 } })).toEqual([]);
      expect(h.tick(70.1, { 1: { surface: ON, pct: 0.501 } })).toEqual([]);
    });

    it("takes no pit-road edge out of the world", () => {
      const h = harness();

      h.tick(10, { 1: { surface: GONE, onPit: true, pct: -1 } });

      expect(h.tick(10.1, { 1: { surface: APPROACH, onPit: true, pct: 0.311 } })).toEqual([]);
    });

    it("takes no pitRoadEnd into the stall", () => {
      const h = harness();

      h.tick(10, { 1: { surface: APPROACH, onPit: true, pct: 0.33 } });

      expect(h.tick(10.1, { 1: { surface: STALL, pct: 0.331 } })).toEqual([]);
    });

    it("takes no reverse pit-road edge within the settle time of the last one", () => {
      const h = harness();

      h.tick(40, { 1: { surface: APPROACH, onPit: true, pct: 0.35 } });
      expect(learned(h.tick(40.1, { 1: { surface: APPROACH, pct: 0.351 } })).map((e) => e.landmark)).toEqual([
        "pitRoadEnd",
      ]);
      // A flicker of the pit-road signal at the exit.
      expect(h.tick(40.2, { 1: { surface: APPROACH, onPit: true, pct: 0.3512 } })).toEqual([]);
      // Its off edge falls within the settle time of that on edge. Another lap,
      // so its key is new and only the settle guard can refuse it.
      expect(h.tick(40.3, { 1: { surface: APPROACH, pct: 0.3514, lap: 4 } })).toEqual([]);
      expect(h.learner.section!.landmarks.pitRoadEnd!.samples).toBe(1);
    });

    it("does not re-publish a duplicate: the same car's edge again on the same lap", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.5 } });
      expect(learned(h.tick(10.1, { 1: { surface: APPROACH, pct: 0.501 } }))).toHaveLength(1);
      h.tick(10.2, { 1: { surface: ON, pct: 0.5005 } });

      expect(h.tick(10.3, { 1: { surface: APPROACH, pct: 0.5012 } })).toEqual([]);
    });

    it("skips a sample whose estTime is unreadable", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.5 } });

      expect(h.tick(10.1, { 1: { surface: APPROACH, pct: 0.501, est: -1 } })).toEqual([]);
    });
  });

  describe("a tick whose SessionTime repeated while SessionTick advanced", () => {
    it("times the move by SessionTick and takes the edge", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.5 } }, { sessionTick: 600 });
      const events = learned(h.tick(10, { 1: { surface: APPROACH, pct: 0.5001 } }, { sessionTick: 601 }));

      expect(events.map((e) => e.landmark)).toEqual(["approachStart"]);
      expect(h.slice.cars[1]).toMatchObject({ sessionTime: 10, sessionTick: 601 });
    });

    it("still ignores a teleport: one tick is 1/60 s at the speed ceiling", () => {
      const h = harness();
      const oneTickPct = PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS / IRACING_SESSION_TICKS_PER_S / TRACK.trackLengthM!;

      h.tick(10, { 1: { surface: ON, pct: 0.5 }, 2: { surface: ON, pct: 0.6 } }, { sessionTick: 600 });
      const events = learned(
        h.tick(
          10,
          {
            1: { surface: APPROACH, pct: 0.5 + oneTickPct * 1.01 },
            2: { surface: APPROACH, pct: 0.6 + oneTickPct * 0.99 },
          },
          { sessionTick: 601 },
        ),
      );

      expect(events.map((e) => e.sample.key)).toEqual([`${SUBSESSION}:${SESSION_NUM}:2:approachStart:3`]);
    });

    it("keeps the stop's blendEnd when the blend tick is the stalled one", () => {
      const h = harness();
      const at = (t: number, reading: CarReading, sessionTick?: number) =>
        learned(h.tick(t, { 1: reading }, sessionTick === undefined ? {} : { sessionTick }));

      at(40.0, { surface: APPROACH, onPit: true, pct: 0.35 });
      at(40.1, { surface: APPROACH, pct: 0.351 });
      at(45.0, { surface: APPROACH, pct: 0.36 }, 2700);
      const blend = at(45.0, { surface: ON, pct: 0.3601 }, 2701);

      expect(blend.map((e) => e.landmark)).toEqual(["blendEnd"]);
      expect(h.slice.cars[1]).toMatchObject({ fromPitLane: false, rejoinedAt: 45 });
    });
  });

  describe("learns nothing it cannot key or measure, but keeps the baselines", () => {
    function edge(h: Harness, opts?: { subSession?: number | null }): PendingEvent[] {
      h.tick(10, { 1: { surface: ON, pct: 0.5 } }, opts);

      return h.tick(10.1, { 1: { surface: APPROACH, pct: 0.501 } }, opts);
    }

    it("with no learner loaded", () => {
      const h = harness(createPitLaneLandmarkLearner());

      expect(edge(h)).toEqual([]);
      expect(h.slice.cars[1]).toMatchObject({ surface: APPROACH, pct: 0.501 });
    });

    it("with no track length", () => {
      const h = harness(loadedLearner({ ...TRACK, trackLength: "long", trackLengthM: null }));

      expect(edge(h)).toEqual([]);
      expect(h.learner.section!.landmarks).toEqual({});
    });

    it("with no readable subsession", () => {
      expect(edge(harness(), { subSession: null })).toEqual([]);
    });

    it("without the per-car arrays", () => {
      const h = harness();
      const out: PendingEvent[] = [];

      diffPitLaneLandmarks(h.slice, h.learner, {} as never, null, SUBSESSION, WALL_EPOCH, (ev) => out.push(ev));

      expect(out).toEqual([]);
      expect(h.slice.cars).toEqual([]);
    });
  });

  describe("the start/finish line", () => {
    it("takes a midpoint past the line, with the later tick's estTime and lap", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.9998, est: 89.98, lap: 5 } });
      const [event] = learned(h.tick(10.1, { 1: { surface: APPROACH, pct: 0.0004, est: 0.04, lap: 6 } }));

      expect(event!.sample).toMatchObject({
        pct: expect.closeTo(0.0001, 9),
        estTime: 0.04,
        key: `${SUBSESSION}:${SESSION_NUM}:1:approachStart:6`,
      });
    });

    it("takes a midpoint before the line, with the earlier tick's estTime and lap", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.9994, est: 89.94, lap: 5 } });
      const [event] = learned(h.tick(10.1, { 1: { surface: APPROACH, pct: 0.0002, est: 0.02, lap: 6 } }));

      expect(event!.sample).toMatchObject({
        pct: expect.closeTo(0.9998, 9),
        estTime: 89.94,
        key: `${SUBSESSION}:${SESSION_NUM}:1:approachStart:5`,
      });
    });

    it("puts a midpoint exactly on the line on the new lap", () => {
      const h = harness();

      // Binary fractions, so the midpoint is exactly 1 before it wraps to 0.
      h.tick(10, { 1: { surface: ON, pct: 1 - 1 / 1024, est: 89.95, lap: 5 } });
      const [event] = learned(h.tick(10.1, { 1: { surface: APPROACH, pct: 1 / 1024, est: 0.05, lap: 6 } }));

      expect(event!.sample.pct).toBe(0);
      expect(event!.sample).toMatchObject({ estTime: 0.05, key: `${SUBSESSION}:${SESSION_NUM}:1:approachStart:6` });
    });

    it("judges a move across the line as the short way round", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.9999 } });

      expect(learned(h.tick(10.1, { 1: { surface: APPROACH, pct: 0.0001 } }))).toHaveLength(1);
    });
  });

  describe("one car's throw costs that car only (#1559)", () => {
    it("drops the failing car's sample and baseline, and still learns the others'", () => {
      const errors: string[] = [];
      const logger: ILogger = {
        ...silentLogger,
        error: (message) => {
          errors.push(message);
        },
      };
      const steps = new TickSteps({ boundary: createErrorBoundary({ logger, now: () => 0 }), prefix: "translator:" });
      const slice = createPitLaneLandmarksState();
      const learner = loadedLearner();
      const fault = { on: true };
      const run = (sessionTime: number, cars: Record<number, CarReading>): PendingEvent[] => {
        const t = telemetry(sessionTime, cars) as { CarIdxClass: number[] };
        const classes = t.CarIdxClass.slice();

        Object.defineProperty(t.CarIdxClass, 2, {
          get: () => {
            if (fault.on) throw new Error("odd class row");

            return classes[2];
          },
        });

        const pending: PendingEvent[] = [];

        steps.live("diffPitLaneLandmarks", pending, () =>
          diffPitLaneLandmarks(
            slice,
            learner,
            t as never,
            null,
            SUBSESSION,
            WALL_EPOCH,
            (ev) => pending.push(ev),
            steps.runUnit,
          ),
        );

        return pending;
      };

      run(10, { 1: { surface: ON, pct: 0.5 }, 2: { surface: ON, pct: 0.5 } });
      const events = learned(
        run(10.1, { 1: { surface: APPROACH, pct: 0.501 }, 2: { surface: APPROACH, pct: 0.5012 } }),
      );

      expect(events.map((e) => e.sample.key)).toEqual([`${SUBSESSION}:${SESSION_NUM}:1:approachStart:3`]);
      expect(errors).toHaveLength(1);
      expect(learner.section!.landmarks.approachStart!.samples).toBe(1);
      // Car 2's baseline was not written, so the edge is read again next tick.
      expect(slice.cars[2]).toMatchObject({ surface: ON, pct: 0.5 });

      fault.on = false;
      const retried = learned(
        run(10.2, { 1: { surface: APPROACH, pct: 0.502 }, 2: { surface: APPROACH, pct: 0.5014 } }),
      );

      expect(retried.map((e) => e.sample.key)).toEqual([`${SUBSESSION}:${SESSION_NUM}:2:approachStart:3`]);
      expect(retried[0]!.summary).toMatchObject({ samples: 2, published: true });
    });

    it("learns no edge across a car's failed run once it recovers, and learns its next one-tick edge", () => {
      const steps = new TickSteps({
        boundary: createErrorBoundary({ logger: silentLogger, now: () => 0 }),
        prefix: "translator:",
      });
      const slice = createPitLaneLandmarksState();
      const learner = loadedLearner();
      const fault = { on: false };
      const run = (sessionTime: number, cars: Record<number, CarReading>): PendingEvent[] => {
        // A row read on every tick, so the unit throws whether or not it sees an edge.
        const t = telemetry(sessionTime, cars) as { CarIdxTrackSurface: number[] };
        const surfaces = t.CarIdxTrackSurface.slice();

        Object.defineProperty(t.CarIdxTrackSurface, 2, {
          get: () => {
            if (fault.on) throw new Error("odd surface row");

            return surfaces[2];
          },
        });

        const pending: PendingEvent[] = [];

        steps.live("diffPitLaneLandmarks", pending, () =>
          diffPitLaneLandmarks(
            slice,
            learner,
            t as never,
            null,
            SUBSESSION,
            WALL_EPOCH + Math.round(sessionTime * 1000),
            (ev) => pending.push(ev),
            steps.runUnit,
          ),
        );

        return pending;
      };

      run(10, { 2: { surface: ON, pct: 0.5 } });

      // Into the approach at 50 m/s, and the unit throws on every tick for 3 s:
      // the baseline stays at 10 s, on the racing surface.
      fault.on = true;

      for (let step = 1; step < 30; step++) {
        expect(run(10 + step / 10, { 2: { surface: APPROACH, pct: 0.5 + step * 0.00125 } })).toEqual([]);
      }

      expect(slice.cars[2]).toMatchObject({ surface: ON, sessionTime: 10 });

      // Recovered: 150 m in 3 s passes the speed check, but the two ticks are
      // too far apart to sample the edge between them.
      fault.on = false;

      expect(run(13, { 2: { surface: APPROACH, pct: 0.5375 } })).toEqual([]);
      expect(slice.cars[2]).toMatchObject({ surface: APPROACH, sessionTime: 13, pct: 0.5375 });
      expect(learner.section!.landmarks.approachStart).toBeUndefined();

      // The next edge is one tick long, and is learned.
      expect(
        learned(run(13.1, { 2: { surface: APPROACH, onPit: true, pct: 0.53875 } })).map((e) => e.landmark),
      ).toEqual(["pitRoadStart"]);
    });
  });

  describe("the edge diagnostics", () => {
    function logged(): { logger: ILogger; debug: ReturnType<typeof vi.fn> } {
      const debug = vi.fn();

      return { logger: { ...silentLogger, debug }, debug };
    }

    /** The reason each debug line gives, in order. */
    function reasons(debug: ReturnType<typeof vi.fn>): string[] {
      return debug.mock.calls.map(([line]) => String(line).replace(/^.* taught no landmark: /, ""));
    }

    it("names the car, the player, the direction, both surfaces and both positions, and calls on-track flips noise", () => {
      const { logger, debug } = logged();
      const h = harness(loadedLearner(), logger);

      h.tick(10, { 1: { surface: ON, pct: 0.99 }, 2: { surface: ON, onPit: true, pct: 0.5 } }, { player: 2 });
      h.tick(10.1, { 1: { surface: ON, onPit: true, pct: 0.991 }, 2: { surface: ON, pct: 0.501 } }, { player: 2 });

      expect(debug.mock.calls).toEqual([
        [
          "Pit-lane landmarks: car 1 pit road on OnTrack -> OnTrack at pct 0.99000 -> 0.99100 taught no landmark: on-track noise (OnTrack both ticks)",
        ],
        [
          "Pit-lane landmarks: car 2 (player) pit road off OnTrack -> OnTrack at pct 0.50000 -> 0.50100 taught no landmark: on-track noise (OnTrack both ticks)",
        ],
      ]);
    });

    it("logs nothing for a flip that taught its landmark, nor for a tick with no flip", () => {
      const { logger, debug } = logged();
      const h = harness(loadedLearner(), logger);

      expect(learned(drivePitVisit(h)).map((e) => e.landmark)).toEqual([
        "approachStart",
        "pitRoadStart",
        "pitRoadEnd",
        "blendEnd",
      ]);
      expect(debug).not.toHaveBeenCalled();
    });

    it("logs nothing for a flip into or out of the world", () => {
      const { logger, debug } = logged();
      const h = harness(loadedLearner(), logger);

      h.tick(10, { 1: { surface: ON, pct: 0.7 } });
      h.tick(10.1, { 1: { surface: GONE, onPit: true, pct: -1 } });
      h.tick(10.2, { 1: { surface: APPROACH, pct: 0.33 } });

      expect(debug).not.toHaveBeenCalled();
    });

    it("names the surface that refused it", () => {
      const { logger, debug } = logged();
      const h = harness(loadedLearner(), logger);

      h.tick(10, { 1: { surface: APPROACH, onPit: true, pct: 0.33 }, 2: { surface: STALL, pct: 0.331 } });
      h.tick(10.1, { 1: { surface: STALL, pct: 0.331 }, 2: { surface: APPROACH, onPit: true, pct: 0.3312 } });
      h.tick(20, { 3: { surface: ON, pct: 0.4 } });
      h.tick(20.1, { 3: { surface: OFF, onPit: true, pct: 0.401 } });
      h.tick(30, { 4: { surface: STALL, onPit: true, pct: 0.331 } });
      h.tick(30.1, { 4: { surface: ON, pct: 0.3312 } });

      expect(reasons(debug)).toEqual([
        "went to InPitStall, not AproachingPits or OnTrack",
        "came from InPitStall, not OnTrack or AproachingPits",
        "went to OffTrack, not AproachingPits",
        "came from InPitStall, not AproachingPits",
      ]);
    });

    it("names a tick that cannot learn", () => {
      const { logger, debug } = logged();
      const unloaded = harness(createPitLaneLandmarkLearner(), logger);

      unloaded.tick(10, { 1: { surface: APPROACH, pct: 0.31 } });
      unloaded.tick(10.1, { 1: { surface: APPROACH, onPit: true, pct: 0.311 } });

      const noLength = harness(loadedLearner({ ...TRACK, trackLength: "long", trackLengthM: null }), logger);

      noLength.tick(10, { 1: { surface: APPROACH, pct: 0.31 } });
      noLength.tick(10.1, { 1: { surface: APPROACH, onPit: true, pct: 0.311 } });

      const noSubSession = harness(loadedLearner(), logger);

      noSubSession.tick(10, { 1: { surface: APPROACH, pct: 0.31 } });
      noSubSession.tick(10.1, { 1: { surface: APPROACH, onPit: true, pct: 0.311 } }, { subSession: null });

      expect(reasons(debug)).toEqual([
        "not learning: no track loaded",
        "not learning: no track length",
        "not learning: no subsession",
      ]);
    });

    it("names the clock, the span and the distance", () => {
      const { logger, debug } = logged();
      const h = harness(loadedLearner(), logger);

      h.tick(10, { 1: { surface: APPROACH, pct: 0.31 } }, { sessionTick: 600 });
      h.tick(10, { 1: { surface: APPROACH, onPit: true, pct: 0.3101 } }, { sessionTick: 600 });
      h.tick(20, { 2: { surface: APPROACH, pct: 0.31 } });
      h.tick(21.5, { 2: { surface: APPROACH, onPit: true, pct: 0.311 } });
      h.tick(30, { 3: { surface: APPROACH, onPit: true, pct: 0.2 } });
      h.tick(30.1, { 3: { surface: APPROACH, pct: 0.3 } });

      expect(reasons(debug)).toEqual([
        "neither SessionTime nor SessionTick moved forward",
        `ticks 1.50 s apart, over ${PIT_LANE_MAX_EDGE_SPAN_S} s`,
        `moved 400 m in 0.100 s, faster than ${PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS} m/s`,
      ]);
    });

    it("names the settle time, an unreadable sample and the learner's refusal", () => {
      const { logger, debug } = logged();
      const h = harness(loadedLearner(), logger);

      h.tick(40, { 1: { surface: APPROACH, onPit: true, pct: 0.35 } });
      h.tick(40.1, { 1: { surface: APPROACH, pct: 0.351 } }); // pitRoadEnd, learned
      h.tick(40.2, { 1: { surface: APPROACH, onPit: true, pct: 0.3512 } }); // within the settle time
      h.tick(50, { 2: { surface: APPROACH, pct: 0.31 } });
      h.tick(50.1, { 2: { surface: APPROACH, onPit: true, pct: 0.311, est: -1 } });
      h.tick(60, { 3: { surface: APPROACH, pct: 0.31 } });
      h.tick(60.1, { 3: { surface: APPROACH, onPit: true, pct: 0.311 } }); // pitRoadStart, learned
      h.tick(69.9, { 3: { surface: APPROACH, onPit: true, pct: 0.35 } });
      h.tick(70, { 3: { surface: APPROACH, pct: 0.351 } }); // pitRoadEnd, learned
      h.tick(73.4, { 3: { surface: APPROACH, pct: 0.31 } });
      // The same car, lap and landmark again, past the settle time: a duplicate.
      h.tick(73.5, { 3: { surface: APPROACH, onPit: true, pct: 0.311 } });

      expect(reasons(debug)).toEqual([
        `within ${PIT_LANE_EDGE_SETTLE_S} s of the car's last pit-road off edge`,
        "unreadable estTime",
        "the learner rejected it (duplicate)",
      ]);
    });

    it("never lets a throwing logger cost the car its tick", () => {
      const logger: ILogger = {
        ...silentLogger,
        debug: () => {
          throw new Error("log sink gone");
        },
      };
      const h = harness(loadedLearner(), logger);

      h.tick(10, { 1: { surface: ON, pct: 0.99 }, 2: { surface: ON, pct: 0.5 } });
      const events = learned(
        h.tick(10.1, { 1: { surface: ON, onPit: true, pct: 0.991 }, 2: { surface: APPROACH, pct: 0.501 } }),
      );

      expect(events.map((e) => e.sample.key)).toEqual([`${SUBSESSION}:${SESSION_NUM}:2:approachStart:3`]);
      expect(h.slice.cars[1]).toMatchObject({ surface: ON, onPitRoad: true, pct: 0.991, sessionTime: 10.1 });
    });
  });

  describe("the span of an edge", () => {
    it("is at most PIT_LANE_MAX_EDGE_SPAN_S: an edge over a longer span is not learned, though the move is plausible", () => {
      const h = harness();
      const late = 10 + PIT_LANE_MAX_EDGE_SPAN_S + 0.05;

      // 4 m in 1.05 s: well under the speed ceiling.
      h.tick(10, { 1: { surface: ON, pct: 0.5 } });

      expect(h.tick(late, { 1: { surface: APPROACH, pct: 0.501 } })).toEqual([]);
      // The car not read for longer is re-seeded by the tick...
      expect(h.slice.cars[1]).toMatchObject({ surface: APPROACH, pct: 0.501, sessionTime: late });
      // ...and its next one-tick edge is learned.
      expect(
        learned(h.tick(late + 0.1, { 1: { surface: APPROACH, onPit: true, pct: 0.5012 } })).map((e) => e.landmark),
      ).toEqual(["pitRoadStart"]);
    });

    it("includes the span itself", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.5 } });

      expect(
        learned(h.tick(10 + PIT_LANE_MAX_EDGE_SPAN_S, { 1: { surface: APPROACH, pct: 0.501 } })).map((e) => e.landmark),
      ).toEqual(["approachStart"]);
    });
  });
});

describe("resolvePitLaneTrackIdentity", () => {
  const weekend = {
    TrackID: 123,
    TrackName: "testtrack",
    TrackConfigName: "Grand Prix",
    TrackLength: "4.00 km",
    TrackVersion: "2026.11.01.01",
  };

  it("reads the identity from WeekendInfo, with the length in metres, as iRacing's", () => {
    expect(resolvePitLaneTrackIdentity({ WeekendInfo: weekend })).toEqual(TRACK);
    expect(resolvePitLaneTrackIdentity({ WeekendInfo: weekend })!.sim).toBe(IRACING_SIM_ID);
    expect(IRACING_SIM_ID).toBe("iracing");
  });

  it("reads a missing config as empty and a numeric version as a string", () => {
    expect(
      resolvePitLaneTrackIdentity({ WeekendInfo: { ...weekend, TrackConfigName: undefined, TrackVersion: 7 } }),
    ).toMatchObject({ trackConfigName: "", trackVersion: "7" });
    expect(resolvePitLaneTrackIdentity({ WeekendInfo: { ...weekend, TrackVersion: undefined } })).toMatchObject({
      trackVersion: null,
    });
  });

  it("keeps an unparsable length with no metres", () => {
    expect(resolvePitLaneTrackIdentity({ WeekendInfo: { ...weekend, TrackLength: "?" } })).toMatchObject({
      trackLength: "?",
      trackLengthM: null,
    });
  });

  it("is null until the session info names the track", () => {
    expect(resolvePitLaneTrackIdentity(null)).toBeNull();
    expect(resolvePitLaneTrackIdentity({})).toBeNull();
    expect(resolvePitLaneTrackIdentity({ WeekendInfo: { ...weekend, TrackID: undefined } })).toBeNull();
    expect(resolvePitLaneTrackIdentity({ WeekendInfo: { ...weekend, TrackID: -1 } })).toBeNull();
    expect(resolvePitLaneTrackIdentity({ WeekendInfo: { ...weekend, TrackName: "" } })).toBeNull();
    expect(resolvePitLaneTrackIdentity({ WeekendInfo: { ...weekend, TrackLength: 4 } })).toBeNull();
  });
});

/**
 * The load itself (once per identity, the rebuild, the outcomes) is
 * track-data's and tested there (`pit-lane-learner.test.ts`); this is the
 * translator's wrapper, which logs what it did.
 */
describe("seedPitLaneLandmarkLearner", () => {
  /** A record of two agreeing samples: published under the 4 km geometry. */
  function publishedRecord(pct: number): PitLaneLandmarkRecord {
    const a = foldSample(
      undefined,
      { pct, estTime: 20, carClassId: 10, key: "a", at: 1 },
      "2026-11-01T00:00:00.000Z",
      4000,
    );
    const b = foldSample(
      a.record,
      { pct, estTime: 20, carClassId: 10, key: "b", at: 2 },
      "2026-11-01T00:00:00.000Z",
      4000,
    );

    return b.record!;
  }

  function stored(): PitLaneSection {
    return {
      version: PIT_LANE_SECTION_VERSION,
      trackLength: TRACK.trackLength,
      landmarks: { pitRoadEnd: publishedRecord(0.35) },
    };
  }

  function recordingLogger() {
    const warn = vi.fn();
    const debug = vi.fn();

    return { logger: { ...silentLogger, warn, debug }, warn, debug };
  }

  it("loads through track-data's learner and logs the record count at debug", () => {
    const { logger, warn, debug } = recordingLogger();
    const learner = createPitLaneLandmarkLearner();

    seedPitLaneLandmarkLearner(learner, TRACK, () => stored(), 0, logger);

    expect(learner.key).toBe(pitLaneTrackKey(TRACK));
    expect(resolvePitLaneLandmarks(learner)!.pitRoadEnd).toMatchObject({ pct: 0.35, source: "current" });
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledExactlyOnceWith(
      'Pit-lane landmarks: track 123 "testtrack" "Grand Prix" loaded with 1 landmark records',
    );
  });

  it("logs nothing when it keeps what it has, or has no identity", () => {
    const { logger, warn, debug } = recordingLogger();
    const learner = createPitLaneLandmarkLearner();
    const loader = vi.fn((_track: PitLaneTrackIdentity) => null);

    seedPitLaneLandmarkLearner(learner, null, loader, 0, logger);
    seedPitLaneLandmarkLearner(learner, TRACK, loader, 0, logger);
    seedPitLaneLandmarkLearner(learner, { ...TRACK }, loader, 0, logger);

    expect(loader).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("loaded with 0 landmark records"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the loader throws, and learns afresh", () => {
    const { logger, warn } = recordingLogger();
    const learner = createPitLaneLandmarkLearner();

    seedPitLaneLandmarkLearner(
      learner,
      TRACK,
      () => {
        throw new Error("disk on fire");
      },
      0,
      logger,
    );

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Pit-lane landmarks: loading track 123 failed (disk on fire); learning afresh",
    );
    expect(learner.section!.landmarks).toEqual({});
  });

  it("warns on an unreadable section, and learns afresh", () => {
    const { logger, warn } = recordingLogger();
    const learner = createPitLaneLandmarkLearner();

    seedPitLaneLandmarkLearner(learner, TRACK, () => ({ nonsense: true }) as unknown as PitLaneSection, 0, logger);

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Pit-lane landmarks: the stored section for track 123 is unreadable; learning afresh",
    );
    expect(learner.section!.landmarks).toEqual({});
  });

  it("warns once when the store cannot read the track yet, retries at debug, and loads when it can", () => {
    const { logger, warn, debug } = recordingLogger();
    const learner = createPitLaneLandmarkLearner();
    let readable = false;
    const loader = vi.fn((_track: PitLaneTrackIdentity) => (readable ? stored() : PIT_LANE_SECTION_UNAVAILABLE));

    seedPitLaneLandmarkLearner(learner, TRACK, loader, WALL_EPOCH, logger);

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Pit-lane landmarks: the stored landmarks for track 123 cannot be read yet (attempt 1); learning meanwhile, retrying in 5 s",
    );
    expect(learner.section!.landmarks).toEqual({});

    // Every tick before the back-off asks nothing.
    seedPitLaneLandmarkLearner(learner, TRACK, loader, WALL_EPOCH + PIT_LANE_LOAD_RETRY_MS - 1, logger);
    expect(loader).toHaveBeenCalledOnce();

    seedPitLaneLandmarkLearner(learner, TRACK, loader, WALL_EPOCH + PIT_LANE_LOAD_RETRY_MS, logger);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledExactlyOnceWith(
      "Pit-lane landmarks: the stored landmarks for track 123 cannot be read yet (attempt 2); learning meanwhile, retrying in 10 s",
    );

    readable = true;
    seedPitLaneLandmarkLearner(learner, TRACK, loader, WALL_EPOCH + 3 * PIT_LANE_LOAD_RETRY_MS, logger);

    expect(loader).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenLastCalledWith(
      'Pit-lane landmarks: track 123 "testtrack" "Grand Prix" loaded with 1 landmark records',
    );
    expect(resolvePitLaneLandmarks(learner)!.pitRoadEnd).toMatchObject({ pct: 0.35, source: "current" });
  });
});
