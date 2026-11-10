import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import {
  createPitLaneLandmarkLearner,
  loadPitLaneLandmarkLearner,
  type PitLaneLandmarkLearner,
  resolvePitLaneLandmarks,
} from "@iracedeck/track-data";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { createPitLaneLandmarksState } from "../../state.js";
import { diffPitLaneLandmarks, resolvePitLaneTrackIdentity } from "../pit-lane-landmarks.js";
import type { PendingEvent } from "../types.js";

type Fixture = {
  WeekendInfo: Record<string, unknown> & { SubSessionID: number };
  SessionNum: number;
  PlayerCarIdx: number;
  /** The capture's car index of each slot in the per-car arrays below. */
  cars: number[];
  CarIdxClass: number[];
  ticks: Array<{
    t: number;
    tick: number;
    /** Synthesised (fixture README): the capture did not record it. */
    OnPitRoad: boolean;
    CarIdxTrackSurface: number[];
    CarIdxOnPitRoad: boolean[];
    CarIdxLapDistPct: number[];
    CarIdxEstTime: number[];
    CarIdxLap: number[];
  }>;
};

const fixture = JSON.parse(
  readFileSync(new URL("./pit-lane-landmarks-spa-20261109.json", import.meta.url), "utf-8"),
) as Fixture;

/** iRacing's per-car array length. */
const SLOTS = 64;
const WALL_EPOCH = 1_800_000_000_000;
const PLAYER = 24;

/** Each tick as the translator hands it in: the kept cars at their own indices, every other car out of the world. */
function telemetryAt(tick: Fixture["ticks"][number]): TelemetryData {
  const perCar = <T>(values: T[], absent: T): T[] => {
    const row = Array<T>(SLOTS).fill(absent);

    fixture.cars.forEach((carIdx, slot) => {
      row[carIdx] = values[slot]!;
    });

    return row;
  };

  return {
    SessionTime: tick.t,
    SessionTick: tick.tick,
    SessionNum: fixture.SessionNum,
    PlayerCarIdx: fixture.PlayerCarIdx,
    OnPitRoad: tick.OnPitRoad,
    CarIdxTrackSurface: perCar(tick.CarIdxTrackSurface, -1),
    CarIdxOnPitRoad: perCar(tick.CarIdxOnPitRoad, false),
    CarIdxLapDistPct: perCar(tick.CarIdxLapDistPct, -1),
    CarIdxEstTime: perCar(tick.CarIdxEstTime, -1),
    CarIdxLap: perCar(tick.CarIdxLap, -1),
    CarIdxClass: perCar(fixture.CarIdxClass, -1),
  } as unknown as TelemetryData;
}

type Learned = Extract<PendingEvent, { event: "pitLane.landmarkLearned" }>["data"];

/** Replay the whole fixture through `diffPitLaneLandmarks` with a freshly loaded learner. */
function replay(): { learner: PitLaneLandmarkLearner; learned: Learned[]; debug: string[] } {
  const track = resolvePitLaneTrackIdentity({ WeekendInfo: fixture.WeekendInfo });
  const learner = createPitLaneLandmarkLearner();
  const slice = createPitLaneLandmarksState();
  const events: PendingEvent[] = [];
  const debug: string[] = [];
  const logger: ILogger = { ...silentLogger, debug: vi.fn((line: string) => debug.push(line)) };

  loadPitLaneLandmarkLearner(learner, track, () => null, WALL_EPOCH);

  for (const tick of fixture.ticks) {
    diffPitLaneLandmarks(
      slice,
      learner,
      telemetryAt(tick),
      null,
      fixture.WeekendInfo.SubSessionID,
      WALL_EPOCH + Math.round(tick.t * 1000),
      (ev) => events.push(ev),
      undefined,
      logger,
    );
  }

  return { learner, learned: events.map((ev) => ev.data as Learned), debug };
}

describe("pit-lane landmarks from the Spa online practice capture (2026-11-09)", () => {
  it("is the capture it says: Spa 2024 GP, the player car 24, four cars kept", () => {
    expect(resolvePitLaneTrackIdentity({ WeekendInfo: fixture.WeekendInfo })).toMatchObject({
      trackId: 523,
      trackLengthM: expect.closeTo(6929.3, 6),
    });
    expect(fixture.PlayerCarIdx).toBe(PLAYER);
    expect(fixture.cars).toEqual([24, 37, 14, 6]);
    // The player's per-car flag reads true on every kept tick, the track included.
    expect(fixture.ticks.every((t) => t.CarIdxOnPitRoad[0] === true)).toBe(true);
    // Car 37's reads false on every kept tick, its two drive-outs included.
    expect(fixture.ticks.every((t) => t.CarIdxOnPitRoad[1] === false)).toBe(true);
  });

  it("learns each edge where the capture puts it, in driving order", () => {
    const { learned } = replay();

    expect(
      learned.map((e) => [e.landmark, Number(e.sample.key.split(":")[2]), e.sample.key.split(":")[4], e.sample.pct]),
    ).toEqual([
      // The player's drive-out: pit road ends where the fixture puts OnPitRoad false, then the blend line.
      ["pitRoadEnd", PLAYER, "2", expect.closeTo(0.04103, 4)],
      ["blendEnd", PLAYER, "2", expect.closeTo(0.06285, 5)],
      // The player's entry: the approach start, then pit road where the fixture puts OnPitRoad true.
      ["approachStart", PLAYER, "2", expect.closeTo(0.97486, 5)],
      ["pitRoadStart", PLAYER, "2", expect.closeTo(0.98652, 4)],
      // Car 14's on-track excursion into the approach zone: an approach start, nothing else.
      ["approachStart", 14, "5", expect.closeTo(0.07607, 5)],
      // Car 37 drives out of its stall with CarIdxOnPitRoad false throughout.
      ["blendEnd", 37, "1", expect.closeTo(0.0626, 4)],
    ]);
  });

  it("takes car 37's second drive-out on the same lap as a duplicate of its first", () => {
    const { learner } = replay();

    // Both drive-outs read lap 1, 17 s apart: one key within the duplicate window.
    expect(learner.section!.landmarks.blendEnd!.window.map((w) => w.key)).toEqual([
      "89998671:0:24:blendEnd:2",
      "89998671:0:37:blendEnd:1",
    ]);
  });

  it("publishes the blend line, the one landmark two cars taught, within a couple of metres", () => {
    const { learner } = replay();
    const resolved = resolvePitLaneLandmarks(learner)!;
    const [player, car37] = learner.section!.landmarks.blendEnd!.window.map((w) => w.pct);

    expect(resolved.blendEnd).toMatchObject({ pct: expect.closeTo(0.0627, 4), samples: 2, source: "current" });
    // The player's and car 37's samples, a drive-out each, lie under 2 m apart.
    expect(Math.abs(player! - car37!) * learner.track!.trackLengthM!).toBeLessThan(2);
    // One sample each, or two that disagree (car 14's 0.076 against the player's 0.975): unpublished.
    expect(resolved.approachStart).toBeNull();
    expect(resolved.pitRoadStart).toBeNull();
    expect(resolved.pitRoadEnd).toBeNull();
  });

  it("logs every flip that taught nothing, and they are all car 6's on the racing surface", () => {
    const { debug } = replay();

    expect(debug).toEqual([
      expect.stringMatching(
        /^Pit-lane landmarks: car 6 pit road off OnTrack -> OnTrack at pct 0\.4334\d -> 0\.4335\d taught no landmark: on-track noise \(OnTrack both ticks\)$/,
      ),
      expect.stringMatching(
        /^Pit-lane landmarks: car 6 pit road on OnTrack -> OnTrack at pct 0\.3992\d -> 0\.3993\d taught no landmark: on-track noise \(OnTrack both ticks\)$/,
      ),
    ]);
  });
});
