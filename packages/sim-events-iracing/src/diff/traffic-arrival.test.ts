import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createTrafficArrivalState, type TrafficArrivalState } from "../state.js";
import type { UnitRunner } from "../tick-steps.js";
import {
  arrivalSeconds,
  computeTrafficArrivals,
  crossesLineBefore,
  curveLapEnd,
  curveReferenceSource,
  elapsed,
  isFiniteNumber,
  isLapFraction,
  isTrafficCarStationary,
  landmarkReferenceSource,
  normalizeLapPosition,
  referenceTimeAt,
  resolveCarClassId,
  resolveClassLapTime,
  resolveTrafficClassInfo,
  scaledReferenceSource,
  TRAFFIC_CRAWL_MPS,
  TRAFFIC_CURVE_BINS,
  TRAFFIC_CURVE_MAX_SPAN_PCT,
  TRAFFIC_CURVE_SAMPLE_CAP,
  TRAFFIC_LINE_OVERSHOOT_PCT,
  TRAFFIC_MOTION_MAX_AGE_S,
  TRAFFIC_MOTION_MAX_PLAUSIBLE_MPS,
  TRAFFIC_MOTION_WINDOW_S,
  type TrafficArrival,
  type TrafficClassInfo,
  type TrafficReferenceSource,
  updateTrafficReferenceCurves,
} from "./traffic-arrival.js";

type Car = {
  idx: number;
  pct: number;
  est: number;
  surface?: number;
  /** `CarIdxClass`; defaults to class 1. */
  cls?: number;
  onPitRoad?: boolean;
};

/** Telemetry carrying only the arrays the arrival model reads, for 64 car slots, unused ones not in world. */
function tel(cars: Car[]): TelemetryData {
  const pct = new Array<number>(64).fill(-1);
  const est = new Array<number>(64).fill(0);
  const surface = new Array<number>(64).fill(TrkLoc.NotInWorld);
  const cls = new Array<number>(64).fill(-1);
  const onPitRoad = new Array<boolean>(64).fill(false);

  for (const car of cars) {
    pct[car.idx] = car.pct;
    est[car.idx] = car.est;
    surface[car.idx] = car.surface ?? TrkLoc.OnTrack;
    cls[car.idx] = car.cls ?? 1;
    onPitRoad[car.idx] = car.onPitRoad ?? false;
  }

  return {
    CarIdxLapDistPct: pct,
    CarIdxEstTime: est,
    CarIdxTrackSurface: surface,
    CarIdxClass: cls,
    CarIdxOnPitRoad: onPitRoad,
  } as TelemetryData;
}

/** Feeds each sample as its own tick of car 0, so every sample reaches the curve. */
function learn(slice: TrafficArrivalState, samples: Array<[pct: number, est: number]>, cls = 1): void {
  for (const [pct, est] of samples) updateTrafficReferenceCurves(slice, tel([{ idx: 0, pct, est, cls }]), null, null);
}

function classInfo(lapTimeByClass: Record<string, number>, classByCarIdx: number[] = []): TrafficClassInfo {
  return { lapTimeByClass, classByCarIdx };
}

function byCar(arrivals: TrafficArrival[]): Map<number, TrafficArrival> {
  return new Map(arrivals.map((arrival) => [arrival.carIdx, arrival]));
}

describe("the shared helpers", () => {
  it("isFiniteNumber: a number that is neither NaN nor infinite", () => {
    expect([0, -3.5, 1e9].map(isFiniteNumber)).toEqual([true, true, true]);
    expect([Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined].map(isFiniteNumber)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("isLapFraction: a number in [0, 1), so not the sim's -1, nor 1, nor NaN", () => {
    expect([0, 0.5, 0.99999].map(isLapFraction)).toEqual([true, true, true]);
    expect([-1, 1, 1.00001, Number.NaN, Number.POSITIVE_INFINITY, "0.5", undefined].map(isLapFraction)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("normalizeLapPosition: [0, 1) as itself, the line read as 1 or a hair past it as that hair past 0", () => {
    expect([0, 0.5, 0.99999].map(normalizeLapPosition)).toEqual([0, 0.5, 0.99999]);
    expect(normalizeLapPosition(1)).toBe(0);
    // The measured line readings (module header), and the overshoot's own edge.
    expect(normalizeLapPosition(1.0000126)).toBeCloseTo(0.0000126, 12);
    expect(normalizeLapPosition(1.00001)).toBeCloseTo(0.00001, 12);
    expect(normalizeLapPosition(1 + TRAFFIC_LINE_OVERSHOOT_PCT)).toBeCloseTo(TRAFFIC_LINE_OVERSHOOT_PCT, 12);
  });

  it("normalizeLapPosition: null for negative, non-finite, clearly past 1 or not a number", () => {
    expect(
      [
        -1,
        -0.0001,
        1 + 2 * TRAFFIC_LINE_OVERSHOOT_PCT,
        1.5,
        2,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        "0.5",
        undefined,
        null,
      ].map(normalizeLapPosition),
    ).toEqual(new Array(11).fill(null));
  });

  it("elapsed: the milliseconds since a time, a clock that stepped back reading as just now", () => {
    expect(elapsed(1_500, 1_000)).toBe(500);
    expect(elapsed(1_000, 1_500)).toBe(0);
  });
});

describe("resolveTrafficClassInfo", () => {
  it("reads each class's CarClassEstLapTime and each car's CarClassID from DriverInfo", () => {
    const info = resolveTrafficClassInfo({
      DriverInfo: {
        Drivers: [
          { CarIdx: 0, CarClassID: 11, CarClassEstLapTime: 110.0344, CarIsPaceCar: 1 },
          { CarIdx: 1, CarClassID: 4029, CarClassEstLapTime: 91.6077 },
          { CarIdx: 3, CarClassID: 4011, CarClassEstLapTime: 105.5726 },
          { CarIdx: 4, CarClassID: 4011, CarClassEstLapTime: 105.5726 },
        ],
      },
    });

    expect(info).toEqual({
      lapTimeByClass: { "11": 110.0344, "4029": 91.6077, "4011": 105.5726 },
      classByCarIdx: [11, 4029, -1, 4011, 4011],
    });
  });

  it("skips malformed entries and answers null without session info or drivers", () => {
    expect(resolveTrafficClassInfo(null)).toBeNull();
    expect(resolveTrafficClassInfo({})).toBeNull();
    expect(resolveTrafficClassInfo({ DriverInfo: { Drivers: "x" } })).toBeNull();

    const info = resolveTrafficClassInfo({
      DriverInfo: {
        Drivers: [
          { CarIdx: 0, CarClassID: 1, CarClassEstLapTime: 0 },
          { CarIdx: 1, CarClassID: 2, CarClassEstLapTime: Number.NaN },
          { CarIdx: -1, CarClassID: 3, CarClassEstLapTime: 90 },
          { CarIdx: 2, CarClassID: -4, CarClassEstLapTime: 90 },
          { CarIdx: 3, CarClassID: 5, CarClassEstLapTime: 95 },
          null,
        ],
      },
    });

    // Class 3's lap time is the class's, whoever carries it; car -1 is no car.
    expect(info).toEqual({ lapTimeByClass: { "3": 90, "5": 95 }, classByCarIdx: [1, 2, -1, 5] });
  });
});

describe("resolveCarClassId", () => {
  it("reads CarIdxClass, and falls back to DriverInfo for a car the telemetry gives no class (the pace car)", () => {
    // Monza 2026-07-28: the pace car, car 64, reads CarIdxClass -1 while
    // DriverInfo names its class 11.
    const telemetry = tel([
      { idx: 1, pct: 0.1, est: 1, cls: 4029 },
      { idx: 2, pct: 0.1, est: 1, cls: -1 },
    ]);
    const classes = classInfo({}, [7, 7, 11]);

    expect(resolveCarClassId(telemetry, classes, 1)).toBe(4029);
    expect(resolveCarClassId(telemetry, classes, 2)).toBe(11);
    expect(resolveCarClassId(telemetry, classes, 5)).toBeNull();
    expect(resolveCarClassId(telemetry, null, 2)).toBeNull();
    expect(resolveCarClassId({} as TelemetryData, classes, 0)).toBe(7);
  });
});

describe("updateTrafficReferenceCurves", () => {
  it("files a racing-surface car's sample under its class, in the bin of its lap position", () => {
    const slice = createTrafficArrivalState();

    updateTrafficReferenceCurves(
      slice,
      tel([
        { idx: 0, pct: 0.25, est: 25, cls: 4011, surface: TrkLoc.OnTrack },
        { idx: 1, pct: 0.5, est: 44, cls: 4029, surface: TrkLoc.OffTrack },
      ]),
      null,
      null,
    );

    expect(Object.keys(slice.curves).sort()).toEqual(["4011", "4029"]);
    expect(slice.curves["4011"].bins).toHaveLength(TRAFFIC_CURVE_BINS);
    expect(slice.curves["4011"].bins[Math.floor(0.25 * TRAFFIC_CURVE_BINS)]).toEqual({
      pct: 0.25,
      estTime: 25,
      samples: 1,
    });
    expect(slice.curves["4029"].bins[Math.floor(0.5 * TRAFFIC_CURVE_BINS)]).toEqual({
      pct: 0.5,
      estTime: 44,
      samples: 1,
    });
    expect(slice.curves["4011"].bins.filter((bin) => bin !== null)).toHaveLength(1);
  });

  it.each([
    ["in its pit stall", { surface: TrkLoc.InPitStall }],
    ["approaching the pits", { surface: TrkLoc.AproachingPits }],
    ["not in world", { surface: TrkLoc.NotInWorld }],
    ["at a negative lap position", { pct: -1 }],
    ["at lap position 1 (read on the line, est already restarted)", { pct: 1.0000126, est: 0.0019 }],
    ["with a negative estTime", { est: -1 }],
    ["with a NaN estTime", { est: Number.NaN }],
    ["with no class", { cls: -1 }],
  ])("learns nothing from a car %s", (_label, override) => {
    const slice = createTrafficArrivalState();

    updateTrafficReferenceCurves(slice, tel([{ idx: 0, pct: 0.3, est: 30, ...override }]), null, null);

    expect(slice.curves).toEqual({});

    // Positive control: the same car on the racing surface is learned.
    updateTrafficReferenceCurves(slice, tel([{ idx: 0, pct: 0.3, est: 30 }]), null, null);

    expect(Object.keys(slice.curves)).toEqual(["1"]);
  });

  it("learns a car with OnPitRoad true while its surface reads OnTrack (#1112 amendment 11)", () => {
    const slice = createTrafficArrivalState();

    updateTrafficReferenceCurves(slice, tel([{ idx: 0, pct: 0.3, est: 30, onPitRoad: true }]), null, null);

    expect(referenceTimeAt(slice.curves["1"], 0.3)).toBe(30);
  });

  it("learns the pace car under its DriverInfo class when CarIdxClass reads -1", () => {
    const slice = createTrafficArrivalState();

    updateTrafficReferenceCurves(
      slice,
      tel([{ idx: 2, pct: 0.3, est: 30, cls: -1 }]),
      classInfo({}, [-1, -1, 11]),
      null,
    );

    expect(Object.keys(slice.curves)).toEqual(["11"]);
  });

  describe("each car is a unit (#1559)", () => {
    /** Telemetry whose car 1 throws when its lap position is read. */
    function withFaultyCar(): TelemetryData {
      const t = tel([
        { idx: 0, pct: 0.2, est: 20 },
        { idx: 1, pct: 0.3, est: 30 },
        { idx: 2, pct: 0.4, est: 40 },
      ]);

      Object.defineProperty(t.CarIdxLapDistPct!, 1, {
        get: () => {
          throw new Error("car 1 broke");
        },
      });

      return t;
    }

    it("runs every car through the runner it is handed, so one car's throw costs that car's sample only", () => {
      const slice = createTrafficArrivalState();
      const failed: number[] = [];
      let unitIdx = 0;
      // The translator's step runner, in miniature: a unit that throws is caught.
      const runUnit: UnitRunner = (emit, unit) => {
        const idx = unitIdx++;

        try {
          unit(emit);

          return true;
        } catch {
          failed.push(idx);

          return false;
        }
      };

      updateTrafficReferenceCurves(slice, withFaultyCar(), null, null, runUnit);

      expect(failed).toEqual([1]);
      expect(referenceTimeAt(slice.curves["1"], 0.2)).toBe(20);
      expect(referenceTimeAt(slice.curves["1"], 0.4)).toBe(40);
      expect(slice.curves["1"].bins.filter((bin) => bin !== null)).toHaveLength(2);
    });

    it("lets the throw out with the default runner, so the diff's own tests stay loud", () => {
      expect(() => updateTrafficReferenceCurves(createTrafficArrivalState(), withFaultyCar(), null, null)).toThrow(
        "car 1 broke",
      );
    });
  });

  it("keeps a running mean per bin, so one car's offset fades as others pass", () => {
    const slice = createTrafficArrivalState();
    const bin = (): unknown => slice.curves["1"].bins[Math.floor(0.3 * TRAFFIC_CURVE_BINS)];

    learn(slice, [
      [0.3, 30],
      [0.3008, 31],
    ]);

    expect(bin()).toEqual({ pct: expect.closeTo(0.3004, 12), estTime: 30.5, samples: 2 });

    // Past the cap, a sample weighs exactly 1 / cap.
    for (let i = 0; i < TRAFFIC_CURVE_SAMPLE_CAP * 2; i++) learn(slice, [[0.3004, 30.5]]);

    learn(slice, [[0.3004, 30.5 + TRAFFIC_CURVE_SAMPLE_CAP]]);

    expect(bin()).toEqual({ pct: expect.closeTo(0.3004, 12), estTime: 31.5, samples: TRAFFIC_CURVE_SAMPLE_CAP });
  });
});

/** 25 km, so 0.002 of the lap a second is 50 m/s and the crawl speed is 0.00012 of the lap a second. */
const TRACK_M = 25_000;

/** One tick of car 1 at `pct` on `SessionTime` `at`, read for its progress on the 25 km track. */
function read(slice: TrafficArrivalState, at: number, pct: number, surface?: number): void {
  updateTrafficReferenceCurves(
    slice,
    { ...tel([{ idx: 1, pct, est: pct * 100, surface }]), SessionTime: at },
    null,
    TRACK_M,
  );
}

describe("the motion measurement", () => {
  it("measures a car's progress over a window of at least TRAFFIC_MOTION_WINDOW_S, in laps a second", () => {
    const slice = createTrafficArrivalState();

    read(slice, 100, 0.2);
    expect(slice.motion[1]).toEqual({ fromPct: 0.2, fromTime: 100, rate: null, rateAt: null });

    read(slice, 100 + TRAFFIC_MOTION_WINDOW_S / 2, 0.2005);
    expect(slice.motion[1]).toEqual({ fromPct: 0.2, fromTime: 100, rate: null, rateAt: null });

    read(slice, 100 + TRAFFIC_MOTION_WINDOW_S, 0.201);
    expect(slice.motion[1]).toEqual({
      fromPct: 0.201,
      fromTime: 100.5,
      rate: expect.closeTo(0.002, 12),
      rateAt: 100.5,
    });
  });

  it("crosses the start/finish line the short way, so the line is no jump", () => {
    const slice = createTrafficArrivalState();

    read(slice, 100, 0.9995);
    read(slice, 100.5, 0.0005);

    expect(slice.motion[1]?.rate).toBeCloseTo(0.002, 12);
  });

  it("reads a car going backwards as a negative rate", () => {
    const slice = createTrafficArrivalState();

    read(slice, 100, 0.2);
    read(slice, 100.5, 0.19995);

    expect(slice.motion[1]?.rate).toBeCloseTo(-0.0001, 12);
  });

  it("starts again with no rate after a jump no car could drive: a tow, a reset", () => {
    const slice = createTrafficArrivalState();

    read(slice, 100, 0.2);
    // 0.004 of 25 km in half a second is 200 m/s, past TRAFFIC_MOTION_MAX_PLAUSIBLE_MPS.
    expect(0.004 * TRACK_M).toBeGreaterThan(TRAFFIC_MOTION_MAX_PLAUSIBLE_MPS * 0.5);
    read(slice, 100.5, 0.204);

    expect(slice.motion[1]).toEqual({ fromPct: 0.204, fromTime: 100.5, rate: null, rateAt: null });

    // Positive control: a move the car could drive is measured.
    read(slice, 101, 0.206);
    expect(slice.motion[1]?.rate).toBeCloseTo(0.004, 12);
  });

  it("starts again with no rate after the car went unread for longer than TRAFFIC_MOTION_MAX_AGE_S", () => {
    const slice = createTrafficArrivalState();

    read(slice, 100, 0.2);
    read(slice, 100.5, 0.2);
    expect(slice.motion[1]?.rate).toBe(0);

    // In the pits for a while: its record is left as it was.
    read(slice, 101, 0.2, TrkLoc.InPitStall);
    expect(slice.motion[1]).toMatchObject({ fromTime: 100.5, rate: 0 });

    read(slice, 100.5 + TRAFFIC_MOTION_MAX_AGE_S + 0.25, 0.3);
    expect(slice.motion[1]).toEqual({ fromPct: 0.3, fromTime: 101.75, rate: null, rateAt: null });
  });

  it("measures nothing on a tick whose SessionTime repeated, and starts again when it went backwards", () => {
    const slice = createTrafficArrivalState();

    read(slice, 100, 0.2);
    read(slice, 100.5, 0.201);
    read(slice, 100.5, 0.2011);
    expect(slice.motion[1]).toMatchObject({ fromPct: 0.201, fromTime: 100.5 });

    read(slice, 99, 0.202);
    expect(slice.motion[1]).toEqual({ fromPct: 0.202, fromTime: 99, rate: null, rateAt: null });
  });

  it("reads no progress without a SessionTime, and measures no rate without a track length", () => {
    const noClock = createTrafficArrivalState();
    const noLength = createTrafficArrivalState();

    updateTrafficReferenceCurves(noClock, tel([{ idx: 1, pct: 0.2, est: 20 }]), null, TRACK_M);
    expect(noClock.motion).toEqual({});

    for (const [at, pct] of [
      [100, 0.2],
      [100.5, 0.201],
    ]) {
      updateTrafficReferenceCurves(noLength, { ...tel([{ idx: 1, pct, est: 20 }]), SessionTime: at }, null, null);
    }

    expect(noLength.motion[1]).toMatchObject({ fromTime: 100.5, rate: null });
  });
});

describe("isTrafficCarStationary", () => {
  /** A slice where car 1's last rate is `lapsPerSecond`, measured at `SessionTime` 100. */
  function measuredAt(lapsPerSecond: number): TrafficArrivalState {
    const slice = createTrafficArrivalState();

    slice.motion[1] = { fromPct: 0.2, fromTime: 100, rate: lapsPerSecond, rateAt: 100 };

    return slice;
  }

  const crawl = TRAFFIC_CRAWL_MPS / TRACK_M;

  it("is true under the crawl speed, standing or going backwards, and false at it or above", () => {
    expect(isTrafficCarStationary(measuredAt(0), 1, 100, TRACK_M)).toBe(true);
    expect(isTrafficCarStationary(measuredAt(crawl * 0.99), 1, 100, TRACK_M)).toBe(true);
    expect(isTrafficCarStationary(measuredAt(-0.001), 1, 100, TRACK_M)).toBe(true);
    expect(isTrafficCarStationary(measuredAt(crawl), 1, 100, TRACK_M)).toBe(false);
    expect(isTrafficCarStationary(measuredAt(0.002), 1, 100, TRACK_M)).toBe(false);
  });

  it("is false whenever the measurement cannot say: the cautious direction", () => {
    const standing = measuredAt(0);

    expect(isTrafficCarStationary(standing, 1, 100 + TRAFFIC_MOTION_MAX_AGE_S, TRACK_M)).toBe(true);
    // A rate older than the maximum age.
    expect(isTrafficCarStationary(standing, 1, 100 + TRAFFIC_MOTION_MAX_AGE_S + 0.01, TRACK_M)).toBe(false);
    // A clock behind the rate.
    expect(isTrafficCarStationary(standing, 1, 99, TRACK_M)).toBe(false);
    expect(isTrafficCarStationary(standing, 1, null, TRACK_M)).toBe(false);
    expect(isTrafficCarStationary(standing, 1, 100, null)).toBe(false);
    expect(isTrafficCarStationary(standing, 1, 100, 0)).toBe(false);
    // No record, and a record with no rate yet.
    expect(isTrafficCarStationary(standing, 2, 100, TRACK_M)).toBe(false);
    standing.motion[1] = { fromPct: 0.2, fromTime: 100, rate: null, rateAt: null };
    expect(isTrafficCarStationary(standing, 1, 100, TRACK_M)).toBe(false);
  });
});

describe("referenceTimeAt", () => {
  it("answers a sample's own time at its position, and interpolates between the two nearest samples", () => {
    const slice = createTrafficArrivalState();

    learn(slice, [
      [0.4, 40],
      [0.404, 41],
    ]);

    expect(referenceTimeAt(slice.curves["1"], 0.4)).toBe(40);
    expect(referenceTimeAt(slice.curves["1"], 0.404)).toBe(41);
    expect(referenceTimeAt(slice.curves["1"], 0.403)).toBeCloseTo(40.75, 10);
  });

  it("answers null across a gap wider than the maximum span, and without a sample on both sides", () => {
    const slice = createTrafficArrivalState();
    const gap = TRAFFIC_CURVE_MAX_SPAN_PCT + 0.002;

    learn(slice, [
      [0.4, 40],
      [0.4 + gap, 42],
    ]);

    expect(referenceTimeAt(slice.curves["1"], 0.4 + gap / 2)).toBeNull();
    // Beyond the last sample: never extrapolated.
    expect(referenceTimeAt(slice.curves["1"], 0.4 + gap + 0.001)).toBeNull();

    // Positive control: a sample that closes the gap to within the span.
    learn(slice, [[0.4 + gap / 2 + 0.001, 41]]);

    expect(referenceTimeAt(slice.curves["1"], 0.4 + gap / 2)).not.toBeNull();
  });

  it("never interpolates across the start/finish line, where estTime restarts at 0", () => {
    const slice = createTrafficArrivalState();

    learn(slice, [
      [0.996, 133.0],
      [0.004, 0.53],
    ]);

    // Between 0.996 and 1.004 (= 0.004 next lap) is within the span, but the
    // curve does not wrap: no reference past the last sample of the lap.
    expect(referenceTimeAt(slice.curves["1"], 0.999)).toBeNull();
    // Just after the line the line itself is the lower sample: estTime 0 at 0.
    expect(referenceTimeAt(slice.curves["1"], 0.002)).toBeCloseTo(0.265, 10);
  });

  it("answers null for no curve and for a position outside [0, 1)", () => {
    const slice = createTrafficArrivalState();

    learn(slice, [[0.5, 50]]);

    expect(referenceTimeAt(undefined, 0.5)).toBeNull();
    expect(referenceTimeAt(slice.curves["1"], -0.1)).toBeNull();
    expect(referenceTimeAt(slice.curves["1"], 1)).toBeNull();
    expect(referenceTimeAt(slice.curves["1"], Number.NaN)).toBeNull();
  });
});

describe("curveLapEnd", () => {
  it("extrapolates the reference lap's length from the last two samples before the line", () => {
    const slice = createTrafficArrivalState();

    // Spa 2026-11-09, the GT3 class: 133.1302 at 0.99750, 133.5473 at 0.99948.
    learn(slice, [
      [0.9975, 133.1302],
      [0.99948, 133.5473],
    ]);

    // CarClassEstLapTime read 132.7726 for the same class: 0.9 s short of where
    // CarIdxEstTime actually restarts.
    expect(curveLapEnd(slice.curves["1"])).toBeCloseTo(133.657, 2);
  });

  it("is null without two samples within the maximum span of the line", () => {
    const slice = createTrafficArrivalState();

    expect(curveLapEnd(undefined)).toBeNull();

    learn(slice, [[0.999, 133]]);

    expect(curveLapEnd(slice.curves["1"])).toBeNull();

    learn(slice, [[0.97, 129]]);

    expect(curveLapEnd(slice.curves["1"])).toBeNull();

    learn(slice, [[0.995, 132.5]]);

    expect(curveLapEnd(slice.curves["1"])).toBeCloseTo(133.125, 10);
  });
});

describe("resolveClassLapTime", () => {
  it("takes the curve's lap end before CarClassEstLapTime, which is no exact reference-lap length", () => {
    const slice = createTrafficArrivalState();
    const classes = classInfo({ "1": 132.7726, "2": 90 });

    learn(slice, [
      [0.996, 132.6],
      [0.998, 133],
    ]);

    expect(resolveClassLapTime(slice, classes, 1)).toBeCloseTo(133.4, 10);
    expect(resolveClassLapTime(slice, classes, 2)).toBe(90);
    expect(resolveClassLapTime(slice, classes, 3)).toBeNull();
    expect(resolveClassLapTime(slice, null, 2)).toBeNull();
  });
});

describe("crossesLineBefore", () => {
  it("is true exactly when the car is ahead of P on the lap", () => {
    expect(crossesLineBefore(0.501, 0.5)).toBe(true);
    expect(crossesLineBefore(0.998, 0.005)).toBe(true);
    expect(crossesLineBefore(0.5, 0.5)).toBe(false);
    expect(crossesLineBefore(0.499, 0.5)).toBe(false);
    expect(crossesLineBefore(0.002, 0.998)).toBe(false);
  });

  it("reads a car on the line at position 1 or just past it as position 0", () => {
    expect(crossesLineBefore(1.0000126, 0.3)).toBe(false);
    expect(crossesLineBefore(1, 0)).toBe(false);
  });

  it("reads a position clearly past 1 as no position, never as a lap position less one", () => {
    expect(crossesLineBefore(1.5, 0.3)).toBe(false);
    expect(crossesLineBefore(Number.POSITIVE_INFINITY, 0.3)).toBe(false);
  });
});

describe("arrivalSeconds", () => {
  it("is the reference at P minus the car's estTime for a car behind P, needing no class lap", () => {
    expect(arrivalSeconds(40, 30, false, 100)).toBe(10);
    expect(arrivalSeconds(40, 30, false, null)).toBe(10);
  });

  it("is 0, never a lap, for a car right behind P whose own offset reads past P's time", () => {
    expect(arrivalSeconds(40, 40.3, false, 100)).toBe(0);
    expect(arrivalSeconds(40, 40.3, false, null)).toBe(0);
  });

  it("adds the class lap for a car that crosses the line first", () => {
    expect(arrivalSeconds(10, 95, true, 100)).toBe(15);
  });

  it("is a lap, never now, for a car just past P whose own offset reads short of P's time", () => {
    expect(arrivalSeconds(40, 39.85, true, 100)).toBeCloseTo(100.15, 10);
  });

  it("is null only on the wrapping side when the class lap is unknown", () => {
    expect(arrivalSeconds(10, 95, true, null)).toBeNull();
    expect(arrivalSeconds(40, 39.85, true, null)).toBeNull();
  });

  it("is 0 for a crossing car whose estTime runs past the lap end, with P right after the line", () => {
    expect(arrivalSeconds(0.05, 100.2, true, 100)).toBe(0);
  });
});

describe("the reference sources", () => {
  it("landmark: the landmark's own reference time for the class, keyed by class id", () => {
    const source = landmarkReferenceSource({ "4029": 7.5, "4011": 8.6 });

    expect(source.name).toBe("landmark");
    expect(source.referenceAt(4029)).toBe(7.5);
    expect(source.referenceAt(11)).toBeNull();
    expect(landmarkReferenceSource({ "1": Number.NaN }).referenceAt(1)).toBeNull();
  });

  it("curve: the class's learned curve at P", () => {
    const slice = createTrafficArrivalState();

    learn(slice, [[0.3, 30]], 4029);

    const source = curveReferenceSource(slice, 0.3);

    expect(source.name).toBe("curve");
    expect(source.referenceAt(4029)).toBe(30);
    expect(source.referenceAt(4011)).toBeNull();
  });

  it("scaled: the player's class reference at P, scaled by the ratio of the class lap times", () => {
    const classes = classInfo({ "4011": 105.5726, "4029": 91.6077 });
    const source = scaledReferenceSource(40.028, 4011, classes);

    expect(source.name).toBe("scaled");
    expect(source.referenceAt(4011)).toBe(40.028);
    expect(source.referenceAt(4029)).toBeCloseTo((40.028 * 91.6077) / 105.5726, 10);
    expect(source.referenceAt(11)).toBeNull();
    // The player's own class needs no lap times.
    expect(scaledReferenceSource(40, 4011, null).referenceAt(4011)).toBe(40);
    expect(scaledReferenceSource(40, 4011, null).referenceAt(4029)).toBeNull();
    expect(scaledReferenceSource(null, 4011, classes).referenceAt(4011)).toBeNull();
    expect(scaledReferenceSource(40, null, classes).referenceAt(4029)).toBeNull();
  });
});

/** `computeTrafficArrivals` on complete per-car arrays, where it never answers `null`. */
function arrivalsAt(...args: Parameters<typeof computeTrafficArrivals>): TrafficArrival[] {
  const arrivals = computeTrafficArrivals(...args);

  if (arrivals === null) throw new Error("computeTrafficArrivals answered null on complete arrays");

  return arrivals;
}

describe("computeTrafficArrivals", () => {
  const always = (name: TrafficReferenceSource["name"], value: number | null): TrafficReferenceSource => ({
    name,
    referenceAt: () => value,
  });

  it("times each car by the first source that answers for its class, in the order given", () => {
    const slice = createTrafficArrivalState();
    const telemetry = tel([
      { idx: 0, pct: 0.5, est: 50 },
      { idx: 1, pct: 0.1, est: 10, cls: 1 },
      { idx: 2, pct: 0.1, est: 10, cls: 2 },
      { idx: 3, pct: 0.1, est: 10, cls: 3 },
    ]);
    const sources: TrafficReferenceSource[] = [
      { name: "landmark", referenceAt: (cls) => (cls === 1 ? 30 : null) },
      { name: "curve", referenceAt: (cls) => (cls <= 2 ? 40 : null) },
      always("scaled", 50),
    ];

    const arrivals = byCar(arrivalsAt(slice, 0.5, sources, telemetry, 0, null, null));

    expect(arrivals.get(1)).toEqual({ carIdx: 1, classId: 1, timed: true, seconds: 20, source: "landmark" });
    expect(arrivals.get(2)).toEqual({ carIdx: 2, classId: 2, timed: true, seconds: 30, source: "curve" });
    expect(arrivals.get(3)).toEqual({ carIdx: 3, classId: 3, timed: true, seconds: 40, source: "scaled" });
  });

  it("reports a car no source can time, and one past P with no class lap, as untimed with the reason", () => {
    const slice = createTrafficArrivalState();
    const telemetry = tel([
      { idx: 0, pct: 0.5, est: 50 },
      { idx: 1, pct: 0.1, est: 10, cls: 9 },
      { idx: 2, pct: 0.8, est: 80, cls: 1 },
      { idx: 3, pct: 0.1, est: Number.NaN, cls: 1 },
      { idx: 4, pct: 0.1, est: 10, cls: -1 },
    ]);
    const sources = [{ name: "curve", referenceAt: (cls: number) => (cls === 1 ? 50 : null) }] as const;

    const arrivals = byCar(arrivalsAt(slice, 0.5, sources, telemetry, 0, null, null));

    expect(arrivals.get(1)).toEqual({ carIdx: 1, classId: 9, timed: false, reason: "noReference" });
    expect(arrivals.get(2)).toEqual({ carIdx: 2, classId: 1, timed: false, reason: "noClassLap" });
    expect(arrivals.get(3)).toEqual({ carIdx: 3, classId: 1, timed: false, reason: "noEstTime" });
    expect(arrivals.get(4)).toEqual({ carIdx: 4, classId: null, timed: false, reason: "noClass" });

    // Positive control: with the class lap known the car past P is timed, wrapped.
    const wrapped = byCar(arrivalsAt(slice, 0.5, sources, telemetry, 0, classInfo({ "1": 100 }), null));

    expect(wrapped.get(2)).toEqual({ carIdx: 2, classId: 1, timed: true, seconds: 70, source: "curve" });
  });

  it("leaves out the player, cars not in world and cars in the pits by surface, and keeps the pace car and a racing-surface car with no position", () => {
    const slice = createTrafficArrivalState();
    const telemetry = tel([
      { idx: 0, pct: 0.5, est: 50 },
      { idx: 1, pct: 0.1, est: 10, surface: TrkLoc.InPitStall },
      { idx: 2, pct: 0.1, est: 10, surface: TrkLoc.AproachingPits },
      { idx: 3, pct: 0.1, est: 10, surface: TrkLoc.NotInWorld },
      { idx: 4, pct: -1, est: 10, surface: TrkLoc.OnTrack },
      { idx: 5, pct: 0.1, est: 10, surface: TrkLoc.OnTrack, onPitRoad: true },
      { idx: 6, pct: 0.1, est: 10, surface: TrkLoc.OffTrack },
      // The pace car: no CarIdxClass, its class from DriverInfo.
      { idx: 7, pct: 0.1, est: 10, cls: -1 },
    ]);
    const classes = classInfo({ "1": 100, "11": 110 }, [1, 1, 1, 1, 1, 1, 1, 11]);

    const arrivals = arrivalsAt(slice, 0.5, [always("curve", 30)], telemetry, 0, classes, null);

    // Car 4 is on the racing surface with no usable position: kept, untimed
    // (below), never left out, so it cannot let a call read clear.
    expect(arrivals.map((arrival) => arrival.carIdx)).toEqual([4, 5, 6, 7]);
    expect(arrivals[0]).toEqual({ carIdx: 4, classId: 1, timed: false, reason: "noPosition" });
    expect(arrivals.slice(1).every((arrival) => arrival.timed)).toBe(true);
    expect(arrivals[3]).toMatchObject({ classId: 11, seconds: 20 });
  });

  describe("decides the wrap by position, not by the sign of the difference", () => {
    /** One car (car 1, class 1) against P, with the reference at P given; the player, car 0, elsewhere. */
    function arrive(
      targetPct: number,
      referenceAtP: number,
      car: { pct: number; est: number },
      lap: number | null,
    ): TrafficArrival {
      const telemetry = tel([
        { idx: 0, pct: 0.7, est: 70 },
        { idx: 1, ...car },
      ]);
      const classes = lap === null ? null : classInfo({ "1": lap });
      const [arrival] = arrivalsAt(
        createTrafficArrivalState(),
        targetPct,
        [always("curve", referenceAtP)],
        telemetry,
        0,
        classes,
        null,
      );

      return arrival;
    }

    it("times a car 0.001 lap behind P whose offset reads 0.3 s past P as arriving now, lap known or not", () => {
      expect(arrive(0.5, 50, { pct: 0.499, est: 50.3 }, 100)).toMatchObject({ timed: true, seconds: 0 });
      expect(arrive(0.5, 50, { pct: 0.499, est: 50.3 }, null)).toMatchObject({ timed: true, seconds: 0 });
    });

    it("times a car 0.001 lap past P whose offset reads 0.15 s short of P as a lap away", () => {
      const arrival = arrive(0.5, 50, { pct: 0.501, est: 49.85 }, 100);

      expect(arrival).toMatchObject({ timed: true });
      expect(arrival.timed && arrival.seconds).toBeCloseTo(100.15, 10);
      // The lap is needed on this side only.
      expect(arrive(0.5, 50, { pct: 0.501, est: 49.85 }, null)).toMatchObject({ timed: false, reason: "noClassLap" });
    });

    it("times a car just before the line with P just after it through the wrap", () => {
      const arrival = arrive(0.005, 0.5, { pct: 0.998, est: 99.8 }, 100);

      expect(arrival.timed && arrival.seconds).toBeCloseTo(0.7, 10);
    });

    it("times a car just after the line with P just before it as most of a lap away, no wrap", () => {
      const arrival = arrive(0.998, 99.8, { pct: 0.002, est: 0.2 }, null);

      expect(arrival.timed && arrival.seconds).toBeCloseTo(99.6, 10);
    });

    it("reads a car on the line at position 1, its time restarted, as behind P", () => {
      const arrival = arrive(0.3, 30, { pct: 1.0000126, est: 0.0019 }, null);

      expect(arrival.timed && arrival.seconds).toBeCloseTo(29.9981, 10);
    });
  });

  it("times a car on the line read as 1.0000126 as at the line, and a position clearly past 1 as untimed", () => {
    const telemetry = tel([
      { idx: 0, pct: 0.5, est: 50 },
      { idx: 1, pct: 1.0000126, est: 0.001 },
      { idx: 2, pct: 1.5, est: 10 },
      { idx: 3, pct: Number.POSITIVE_INFINITY, est: 10 },
    ]);

    const arrivals = byCar(
      arrivalsAt(createTrafficArrivalState(), 0.5, [always("curve", 30)], telemetry, 0, null, null),
    );

    // Behind P without a wrap: no class lap needed.
    expect(arrivals.get(1)).toEqual({ carIdx: 1, classId: 1, timed: true, seconds: 29.999, source: "curve" });
    expect(arrivals.get(2)).toEqual({ carIdx: 2, classId: 1, timed: false, reason: "noPosition" });
    expect(arrivals.get(3)).toEqual({ carIdx: 3, classId: 1, timed: false, reason: "noPosition" });
  });

  it("keeps a racing-surface car with a missing, NaN or negative position as untimed, never leaving it out", () => {
    const telemetry = tel([
      { idx: 0, pct: 0.5, est: 50 },
      { idx: 1, pct: Number.NaN, est: 10 },
      { idx: 2, pct: -1, est: 10 },
    ]);
    // An on-track car whose entry is absent altogether.
    (telemetry.CarIdxLapDistPct as unknown as (number | undefined)[])[3] = undefined;
    (telemetry.CarIdxEstTime as number[])[3] = 10;
    (telemetry.CarIdxTrackSurface as number[])[3] = (telemetry.CarIdxTrackSurface as number[])[0];

    const arrivals = byCar(
      arrivalsAt(createTrafficArrivalState(), 0.5, [always("curve", 30)], telemetry, 0, null, null),
    );

    for (const carIdx of [1, 2, 3]) {
      expect(arrivals.get(carIdx)).toMatchObject({ carIdx, timed: false, reason: "noPosition" });
    }
  });

  it("reports every candidate untimed for a target position outside [0, 1)", () => {
    const telemetry = tel([
      { idx: 0, pct: 0.5, est: 50 },
      { idx: 1, pct: 0.1, est: 10 },
    ]);

    for (const target of [-0.1, 1, Number.NaN]) {
      expect(arrivalsAt(createTrafficArrivalState(), target, [always("curve", 30)], telemetry, 0, null, null)).toEqual([
        { carIdx: 1, classId: 1, timed: false, reason: "noTarget" },
      ]);
    }
  });

  describe("a car standing still", () => {
    /** Car 1 stopped 5 m behind P, car 2 coming 0.01 of the lap behind it at 50 m/s; the player, car 0, at P. */
    function field(): { slice: TrafficArrivalState; at: (sessionTime: number) => TelemetryData } {
      const slice = createTrafficArrivalState();
      const at = (sessionTime: number): TelemetryData => ({
        ...tel([
          { idx: 0, pct: 0.5, est: 50 },
          { idx: 1, pct: 0.5 - 5 / TRACK_M, est: 50 - 0.02 },
          { idx: 2, pct: 0.49 + 0.002 * (sessionTime - 100), est: 49 + 0.2 * (sessionTime - 100) },
        ]),
        SessionTime: sessionTime,
      });

      return { slice, at };
    }

    const curve = [{ name: "curve" as const, referenceAt: () => 50 }];

    it("is left out once it is measured standing, and listed for the log; a car coming is not", () => {
      const { slice, at } = field();

      updateTrafficReferenceCurves(slice, at(100), null, TRACK_M);
      updateTrafficReferenceCurves(slice, at(100.5), null, TRACK_M);

      const stationary: number[] = [];
      const arrivals = arrivalsAt(slice, 0.5, curve, at(100.5), 0, null, TRACK_M, stationary);

      expect(arrivals.map((arrival) => arrival.carIdx)).toEqual([2]);
      expect(stationary).toEqual([1]);
    });

    it("counts as coming before it has a rate, and without a track length to judge it by", () => {
      const { slice, at } = field();

      updateTrafficReferenceCurves(slice, at(100), null, TRACK_M);

      expect(arrivalsAt(slice, 0.5, curve, at(100), 0, null, TRACK_M).map((a) => a.carIdx)).toEqual([
        1,
        2,
      ]);

      updateTrafficReferenceCurves(slice, at(100.5), null, TRACK_M);

      expect(arrivalsAt(slice, 0.5, curve, at(100.5), 0, null, null).map((a) => a.carIdx)).toEqual([
        1,
        2,
      ]);
    });
  });

  it("answers null, not an empty track, without the per-car arrays", () => {
    expect(computeTrafficArrivals(createTrafficArrivalState(), 0.5, [], {} as TelemetryData, 0, null, null)).toBeNull();

    const complete = tel([{ idx: 1, pct: 0.1, est: 10 }]);

    for (const field of ["CarIdxLapDistPct", "CarIdxEstTime", "CarIdxTrackSurface"] as const) {
      for (const value of [undefined, 0, "x"]) {
        const telemetry = { ...complete, [field]: value } as unknown as TelemetryData;

        expect(computeTrafficArrivals(createTrafficArrivalState(), 0.5, [], telemetry, 0, null, null)).toBeNull();
      }
    }
  });

  it("answers an empty list from complete arrays with no car on track", () => {
    expect(computeTrafficArrivals(createTrafficArrivalState(), 0.5, [], tel([]), 0, null, null)).toEqual([]);
  });

  it("wraps with the class curve's lap end when the class has one", () => {
    const slice = createTrafficArrivalState();

    learn(slice, [
      [0.996, 99.6],
      [0.998, 99.8],
    ]);

    const telemetry = tel([
      { idx: 0, pct: 0.1, est: 10 },
      { idx: 1, pct: 0.9, est: 90 },
    ]);
    const [arrival] = arrivalsAt(slice, 0.1, [always("scaled", 10)], telemetry, 0, classInfo({ "1": 101 }), null);

    // The curve ends at 100.0; CarClassEstLapTime would have said 21 s.
    expect(arrival).toMatchObject({ carIdx: 1, timed: true });
    expect(arrival.timed && arrival.seconds).toBeCloseTo(20, 10);
  });

  /**
   * Monza (official, multiclass), the Telemetry Snapshot of 2026-07-28 at
   * SessionTime 1918.5 in the race: GTP (class 4029, CarClassEstLapTime
   * 91.6077) and GTD (class 4011, 105.5726). Cars 6, 5 and 3 are GTP on track
   * through the Roggia chicane; car 31 is GTD there; car 8 is GTP on track at
   * 0.0859, behind them on the lap.
   */
  describe("a two-class field (Monza 2026-07-28)", () => {
    const GTP = 4029;
    const GTD = 4011;
    const classes = classInfo({ [GTP]: 91.6077, [GTD]: 105.5726 });
    const roggia = tel([
      { idx: 6, pct: 0.3756, est: 34.535, cls: GTP },
      { idx: 5, pct: 0.3834, est: 35.857, cls: GTP },
      { idx: 3, pct: 0.3883, est: 36.882, cls: GTP },
      { idx: 15, pct: 0.3733, est: 39.031, cls: GTD },
      { idx: 31, pct: 0.3778, est: 40.028, cls: GTD },
      { idx: 29, pct: 0.3845, est: 41.235, cls: GTD },
    ]);
    // Car 31, GTD, stopped at 0.3778 (a rejoin), with GTP car 8 coming.
    const player = 31;
    const stopped = tel([
      { idx: player, pct: 0.3778, est: 40.028, cls: GTD },
      { idx: 8, pct: 0.0859, est: 5.854, cls: GTP },
    ]);

    it("times the GTP car on the GTP curve, where the player's own estTime is five seconds off", () => {
      const slice = createTrafficArrivalState();

      updateTrafficReferenceCurves(slice, roggia, classes, null);

      const sources = [curveReferenceSource(slice, 0.3778), scaledReferenceSource(40.028, GTD, classes)];
      const [arrival] = arrivalsAt(slice, 0.3778, sources, stopped, player, classes, null);
      // The GTP curve at 0.3778, between cars 6 and 5: 34.908 s.
      const gtpAtP = 34.535 + ((0.3778 - 0.3756) / (0.3834 - 0.3756)) * (35.857 - 34.535);

      expect(arrival).toMatchObject({ carIdx: 8, classId: GTP, timed: true, source: "curve" });
      expect(arrival.timed && arrival.seconds).toBeCloseTo(gtpAtP - 5.854, 6);
      // Against the player's own estTime (GTD's reference) the car would read
      // 34.17 s away instead of 29.05 s: over 5 s late.
      expect(40.028 - 5.854 - (arrival.timed ? arrival.seconds : 0)).toBeGreaterThan(5);
    });

    it("falls back to scaling before the GTP class has driven past P, within a few tenths of the curve", () => {
      const slice = createTrafficArrivalState();
      const sources = [curveReferenceSource(slice, 0.3778), scaledReferenceSource(40.028, GTD, classes)];
      const [arrival] = arrivalsAt(slice, 0.3778, sources, stopped, player, classes, null);

      expect(arrival).toMatchObject({ carIdx: 8, classId: GTP, timed: true, source: "scaled" });
      // 40.028 × 91.6077 / 105.5726 = 34.733 s at P, against the curve's 34.908.
      expect(arrival.timed && arrival.seconds).toBeCloseTo(34.733 - 5.854, 2);
    });
  });
});
