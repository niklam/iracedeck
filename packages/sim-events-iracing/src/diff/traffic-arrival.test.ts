import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createTrafficArrivalState, type TrafficArrivalState } from "../state.js";
import {
  arrivalSeconds,
  computeTrafficArrivals,
  crossesLineBefore,
  curveLapEnd,
  curveReferenceSource,
  landmarkReferenceSource,
  referenceTimeAt,
  resolveCarClassId,
  resolveClassLapTime,
  resolveTrafficClassInfo,
  scaledReferenceSource,
  TRAFFIC_CURVE_BINS,
  TRAFFIC_CURVE_MAX_SPAN_PCT,
  TRAFFIC_CURVE_SAMPLE_CAP,
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
  for (const [pct, est] of samples) updateTrafficReferenceCurves(slice, tel([{ idx: 0, pct, est, cls }]), null);
}

function classInfo(lapTimeByClass: Record<string, number>, classByCarIdx: number[] = []): TrafficClassInfo {
  return { lapTimeByClass, classByCarIdx };
}

function byCar(arrivals: TrafficArrival[]): Map<number, TrafficArrival> {
  return new Map(arrivals.map((arrival) => [arrival.carIdx, arrival]));
}

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

    updateTrafficReferenceCurves(slice, tel([{ idx: 0, pct: 0.3, est: 30, ...override }]), null);

    expect(slice.curves).toEqual({});

    // Positive control: the same car on the racing surface is learned.
    updateTrafficReferenceCurves(slice, tel([{ idx: 0, pct: 0.3, est: 30 }]), null);

    expect(Object.keys(slice.curves)).toEqual(["1"]);
  });

  it("learns a car with OnPitRoad true while its surface reads OnTrack (#1112 amendment 11)", () => {
    const slice = createTrafficArrivalState();

    updateTrafficReferenceCurves(slice, tel([{ idx: 0, pct: 0.3, est: 30, onPitRoad: true }]), null);

    expect(referenceTimeAt(slice.curves["1"], 0.3)).toBe(30);
  });

  it("learns the pace car under its DriverInfo class when CarIdxClass reads -1", () => {
    const slice = createTrafficArrivalState();

    updateTrafficReferenceCurves(slice, tel([{ idx: 2, pct: 0.3, est: 30, cls: -1 }]), classInfo({}, [-1, -1, 11]));

    expect(Object.keys(slice.curves)).toEqual(["11"]);
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

    const arrivals = byCar(computeTrafficArrivals(slice, 0.5, sources, telemetry, 0, null));

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

    const arrivals = byCar(computeTrafficArrivals(slice, 0.5, sources, telemetry, 0, null));

    expect(arrivals.get(1)).toEqual({ carIdx: 1, classId: 9, timed: false, reason: "noReference" });
    expect(arrivals.get(2)).toEqual({ carIdx: 2, classId: 1, timed: false, reason: "noClassLap" });
    expect(arrivals.get(3)).toEqual({ carIdx: 3, classId: 1, timed: false, reason: "noEstTime" });
    expect(arrivals.get(4)).toEqual({ carIdx: 4, classId: null, timed: false, reason: "noClass" });

    // Positive control: with the class lap known the car past P is timed, wrapped.
    const wrapped = byCar(computeTrafficArrivals(slice, 0.5, sources, telemetry, 0, classInfo({ "1": 100 })));

    expect(wrapped.get(2)).toEqual({ carIdx: 2, classId: 1, timed: true, seconds: 70, source: "curve" });
  });

  it("leaves out the player, cars not in world and cars in the pits by surface, and keeps the pace car", () => {
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

    const arrivals = computeTrafficArrivals(slice, 0.5, [always("curve", 30)], telemetry, 0, classes);

    expect(arrivals.map((arrival) => arrival.carIdx)).toEqual([5, 6, 7]);
    expect(arrivals.every((arrival) => arrival.timed)).toBe(true);
    expect(arrivals[2]).toMatchObject({ classId: 11, seconds: 20 });
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
      const [arrival] = computeTrafficArrivals(
        createTrafficArrivalState(),
        targetPct,
        [always("curve", referenceAtP)],
        telemetry,
        0,
        classes,
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

  it("reports every candidate untimed for a target position outside [0, 1)", () => {
    const telemetry = tel([
      { idx: 0, pct: 0.5, est: 50 },
      { idx: 1, pct: 0.1, est: 10 },
    ]);

    for (const target of [-0.1, 1, Number.NaN]) {
      expect(
        computeTrafficArrivals(createTrafficArrivalState(), target, [always("curve", 30)], telemetry, 0, null),
      ).toEqual([{ carIdx: 1, classId: 1, timed: false, reason: "noTarget" }]);
    }
  });

  it("answers nothing without the per-car arrays", () => {
    expect(computeTrafficArrivals(createTrafficArrivalState(), 0.5, [], {} as TelemetryData, 0, null)).toEqual([]);
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
    const [arrival] = computeTrafficArrivals(slice, 0.1, [always("scaled", 10)], telemetry, 0, classInfo({ "1": 101 }));

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

      updateTrafficReferenceCurves(slice, roggia, classes);

      const sources = [curveReferenceSource(slice, 0.3778), scaledReferenceSource(40.028, GTD, classes)];
      const [arrival] = computeTrafficArrivals(slice, 0.3778, sources, stopped, player, classes);
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
      const [arrival] = computeTrafficArrivals(slice, 0.3778, sources, stopped, player, classes);

      expect(arrival).toMatchObject({ carIdx: 8, classId: GTP, timed: true, source: "scaled" });
      // 40.028 × 91.6077 / 105.5726 = 34.733 s at P, against the curve's 34.908.
      expect(arrival.timed && arrival.seconds).toBeCloseTo(34.733 - 5.854, 2);
    });
  });
});
