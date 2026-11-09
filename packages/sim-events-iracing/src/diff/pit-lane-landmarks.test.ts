import { TrkLoc } from "@iracedeck/iracing-sdk";
import { createErrorBoundary, type ILogger, silentLogger } from "@iracedeck/logger";
import {
  createPitLaneLandmarkLearner,
  foldSample,
  loadPitLaneLandmarkLearner,
  PIT_LANE_SECTION_VERSION,
  type PitLaneLandmarkLearner,
  type PitLaneLandmarkRecord,
  type PitLaneSection,
  type PitLaneTrackIdentity,
  pitLaneTrackKey,
  resolvePitLaneLandmarks,
} from "@iracedeck/track-data";
import { describe, expect, it, vi } from "vitest";

import { createPitLaneLandmarksState, type PitLaneLandmarksState } from "../state.js";
import { TickSteps } from "../tick-steps.js";
import {
  diffPitLaneLandmarks,
  PIT_LANE_EDGE_SETTLE_S,
  PIT_LANE_LANDMARKS_EVENTS,
  PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS,
  resolvePitLaneTrackIdentity,
  seedPitLaneLandmarkLearner,
} from "./pit-lane-landmarks.js";
import type { PendingEvent } from "./types.js";

/** A 4 km track: one lap fraction of 0.001 is 4 m, and the 15 m tolerance is 0.00375. */
const TRACK: PitLaneTrackIdentity = {
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

/** A tick's telemetry: the cars named, every other slot out of the world. */
function telemetry(sessionTime: number, cars: Record<number, CarReading>, size = CARS): Record<string, unknown> {
  const t = {
    SessionTime: sessionTime,
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

  loadPitLaneLandmarkLearner(learner, track, () => section);

  return learner;
}

type Harness = {
  slice: PitLaneLandmarksState;
  learner: PitLaneLandmarkLearner;
  /** Run one tick at `sessionTime` (wall clock = epoch + session time) and return its events. */
  tick(
    sessionTime: number,
    cars: Record<number, CarReading>,
    opts?: { pace?: number | null; subSession?: number | null },
  ): PendingEvent[];
};

function harness(learner: PitLaneLandmarkLearner = loadedLearner()): Harness {
  const slice = createPitLaneLandmarksState();

  return {
    slice,
    learner,
    tick(sessionTime, cars, opts = {}) {
      const out: PendingEvent[] = [];

      diffPitLaneLandmarks(
        slice,
        learner,
        telemetry(sessionTime, cars) as never,
        opts.pace === undefined ? null : opts.pace,
        opts.subSession === undefined ? SUBSESSION : opts.subSession,
        WALL_EPOCH + Math.round(sessionTime * 1000),
        (ev) => out.push(ev),
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
const GONE = TrkLoc.NotInWorld;

/**
 * Car 1 drives a whole pit visit at 0.1 s ticks: track → approach → pit road →
 * stall → pit road → approach → track. Returns every event, in order.
 */
function drivePitVisit(h: Harness, car = 1, t0 = 100): PendingEvent[] {
  const events: PendingEvent[] = [];
  const at = (dt: number, reading: CarReading) => events.push(...h.tick(t0 + dt, { [car]: reading }));

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
      h.slice.cars[1]!.fromPitRoad = true;

      expect(h.tick(10.1, { 1: { surface: APPROACH, onPit: true, pct: 0.501 } }).map((ev) => ev.data)).toEqual([
        expect.objectContaining({ landmark: "pitRoadStart" }),
      ]);
    });

    it("takes no approach edge within the settle time of rejoining the track, and does after it", () => {
      const h = harness();

      h.tick(40, { 1: { surface: APPROACH, onPit: true, pct: 0.35 } });
      h.tick(40.1, { 1: { surface: APPROACH, pct: 0.351 } });
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
      const events = learned(h.tick(40.1, { 1: { surface: APPROACH, pct: 0.351 } }));

      expect(events.map((e) => e.landmark)).toEqual(["pitRoadEnd"]);
    });
  });

  describe("rejections", () => {
    it("only seeds on a car's first tick", () => {
      const h = harness();

      expect(h.tick(10, { 1: { surface: APPROACH, onPit: true, pct: 0.311 } })).toEqual([]);
      expect(h.slice.cars[1]).toMatchObject({ surface: APPROACH, onPitRoad: true, fromPitRoad: false });
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

    it("ignores an edge whose session time did not move forward", () => {
      const h = harness();

      h.tick(10, { 1: { surface: ON, pct: 0.5 } });

      expect(h.tick(10, { 1: { surface: APPROACH, pct: 0.5001 } })).toEqual([]);
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

  it("reads the identity from WeekendInfo, with the length in metres", () => {
    expect(resolvePitLaneTrackIdentity({ WeekendInfo: weekend })).toEqual(TRACK);
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

    seedPitLaneLandmarkLearner(learner, TRACK, () => stored(), logger);

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

    seedPitLaneLandmarkLearner(learner, null, loader, logger);
    seedPitLaneLandmarkLearner(learner, TRACK, loader, logger);
    seedPitLaneLandmarkLearner(learner, { ...TRACK }, loader, logger);

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

    seedPitLaneLandmarkLearner(learner, TRACK, () => ({ nonsense: true }) as unknown as PitLaneSection, logger);

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Pit-lane landmarks: the stored section for track 123 is unreadable; learning afresh",
    );
    expect(learner.section!.landmarks).toEqual({});
  });
});
