import type { SimEventMap } from "@iracedeck/event-bus";
import { TrkLoc } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import type { PitLaneResolvedLandmark } from "@iracedeck/track-data";
import { describe, expect, it, vi } from "vitest";

import {
  createTrafficArrivalState,
  createTrafficPitExitEpisode,
  type TrafficArrivalState,
  type TrafficCurveBin,
} from "../state.js";
import { TRAFFIC_CURVE_BINS, type TrafficClassInfo } from "./traffic-arrival.js";
import {
  diffTrafficPitExit,
  TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS,
  type TrafficPitExitLandmarks,
  type TrafficPitExitTelemetry,
} from "./traffic-pit-exit.js";

type PitExit = SimEventMap["traffic.pitExit"]["data"];

const PLAYER = 0;
const CLS = 1;
/** 1,600 m: one lap fraction of 0.0625 is 100 m, five seconds at the 20 m/s limit. */
const TRACK_M = 1600;
const PIT_LIMIT_MPS = 20;

/**
 * The player's class curve: a 500 s reference lap, bin `i` (pct `i / 500`)
 * reading exactly `i` seconds, so the curve at 0.1875 (`blendEnd`) is 93.75 s.
 */
function learnedCurves(): TrafficArrivalState {
  const slice = createTrafficArrivalState();

  slice.curves[String(CLS)] = {
    bins: Array.from({ length: TRAFFIC_CURVE_BINS }, (_, i): TrafficCurveBin => ({
      pct: i / TRAFFIC_CURVE_BINS,
      estTime: i,
      samples: 1,
    })),
  };

  return slice;
}

function landmark(pct: number, estTimeByClass: Record<string, number>): PitLaneResolvedLandmark {
  return { pct, estTimeByClass, samples: 5, published: true, source: "current" };
}

/**
 * Pit road ends at 0.125 (the class's reference 50 s there), the blend at
 * 0.1875 (60 s): from the stall at 0.0625 the player's ETA is 100 m at 20 m/s
 * plus 60 − 50, exactly 15 s. The landmarks' own times win over the curve.
 */
const LANDMARKS: TrafficPitExitLandmarks = {
  pitRoadEnd: landmark(0.125, { [CLS]: 50 }),
  blendEnd: landmark(0.1875, { [CLS]: 60 }),
};
const STALL_PCT = 0.0625;

const CLASSES: TrafficClassInfo = { lapTimeByClass: { [CLS]: 500 }, classByCarIdx: [] };

type Car = { idx: number; pct: number; est: number; cls?: number; surface?: number };

/** A car whose arrival at the blend (60 s on the landmark) is `relative` s after the player's 15 s ETA. */
function arriving(idx: number, relative: number): Car {
  return { idx, pct: 0.05, est: 60 - (15 + relative) };
}

type TickOptions = Partial<TrafficPitExitTelemetry> & { cars?: Car[]; pct?: number; est?: number };

/** The player on pit road out of the stall at {@link STALL_PCT}, live in the car; 64 slots. */
function tel({ cars = [], pct = STALL_PCT, est = 31.25, ...overrides }: TickOptions = {}): TrafficPitExitTelemetry {
  const pcts = new Array<number>(64).fill(-1);
  const ests = new Array<number>(64).fill(0);
  const surface = new Array<number>(64).fill(TrkLoc.NotInWorld);
  const cls = new Array<number>(64).fill(-1);

  pcts[PLAYER] = pct;
  ests[PLAYER] = est;
  surface[PLAYER] = TrkLoc.AproachingPits;
  cls[PLAYER] = CLS;

  for (const car of cars) {
    pcts[car.idx] = car.pct;
    ests[car.idx] = car.est;
    surface[car.idx] = car.surface ?? TrkLoc.OnTrack;
    cls[car.idx] = car.cls ?? CLS;
  }

  return {
    IsOnTrack: true,
    OnPitRoad: true,
    PlayerCarInPitStall: false,
    PlayerTrackSurface: TrkLoc.AproachingPits,
    CarIdxLapDistPct: pcts,
    CarIdxEstTime: ests,
    CarIdxTrackSurface: surface,
    CarIdxClass: cls,
    ...overrides,
  };
}

const IN_STALL = tel({ PlayerCarInPitStall: true, PlayerTrackSurface: TrkLoc.InPitStall });

function harness({
  landmarks = LANDMARKS as TrafficPitExitLandmarks | null,
  trackLengthMeters = TRACK_M as number | null,
  pitSpeedLimitMps = PIT_LIMIT_MPS,
  curves = learnedCurves(),
  classes = CLASSES as TrafficClassInfo | null,
}: {
  landmarks?: TrafficPitExitLandmarks | null;
  trackLengthMeters?: number | null;
  pitSpeedLimitMps?: number;
  curves?: TrafficArrivalState;
  classes?: TrafficClassInfo | null;
} = {}) {
  const episode = createTrafficPitExitEpisode();
  const events: PitExit[] = [];
  const debug = vi.fn<(line: string) => void>();
  const logger: ILogger = { ...silentLogger, debug };
  const readLandmarks = vi.fn(() => landmarks);
  const windows = { notice: 20, before: 2, after: 4 };
  let now = 1_000_000;

  const tick = (t: TrafficPitExitTelemetry): void =>
    diffTrafficPitExit(
      episode,
      curves,
      t,
      { playerCarIdx: PLAYER, classes, trackLengthMeters, pitSpeedLimitMps, readLandmarks },
      {
        getNoticeSeconds: () => windows.notice,
        getBeforeSeconds: () => windows.before,
        getAfterSeconds: () => windows.after,
      },
      now,
      (ev) => events.push(ev.data),
      logger,
    );

  return {
    episode,
    events,
    debug,
    readLandmarks,
    windows,
    tick,
    /** Advances the clock `ms` and ticks once. */
    after(ms: number, t: TrafficPitExitTelemetry): void {
      now += ms;
      tick(t);
    },
    /** In the stall, then out of it on the next tick: the departure edge, with `t` the first tick out. */
    depart(t: TrafficPitExitTelemetry = tel()): void {
      tick(IN_STALL);
      now += 100;
      tick(t);
    },
  };
}

const lines = (debug: ReturnType<typeof vi.fn>): string[] => debug.mock.calls.map(([line]) => String(line));

describe("diffTrafficPitExit", () => {
  describe("the episode", () => {
    it("starts on driving out of the stall and speaks once the ETA is under the notice window", () => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, 1)] }));

      expect(h.episode.active).toBe(true);
      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });

    it("needs the stall edge on pit road: a first tick out of the stall seeds, a teleport out starts nothing", () => {
      const seeded = harness();
      const teleport = harness();

      seeded.tick(tel({ cars: [arriving(5, 1)] }));
      teleport.depart(tel({ cars: [arriving(5, 1)], OnPitRoad: false }));

      expect(seeded.events).toEqual([]);
      expect(teleport.events).toEqual([]);
      expect(teleport.episode.active).toBe(false);
    });

    it("never starts from an unread stall flag", () => {
      const h = harness();

      h.tick(tel({ PlayerCarInPitStall: undefined }));
      h.after(100, tel({ cars: [arriving(5, 1)] }));

      expect(h.events).toEqual([]);
    });

    it.each([
      ["out of the car (a tow or leaving)", { IsOnTrack: false }],
      ["not in world (a reset)", { PlayerTrackSurface: TrkLoc.NotInWorld, pct: -1 }],
      ["back in the stall", { PlayerCarInPitStall: true, PlayerTrackSurface: TrkLoc.InPitStall }],
      ["on the racing surface", { PlayerTrackSurface: TrkLoc.OnTrack }],
      ["beside the racing surface", { PlayerTrackSurface: TrkLoc.OffTrack }],
    ] satisfies Array<[string, TickOptions]>)("ends silently %s", (_, overrides) => {
      const h = harness();
      const far = tel({ cars: [arriving(5, 1)], pct: 0 }); // ETA 20: not yet under the window

      h.depart(far);
      h.after(100, tel({ cars: [arriving(5, 1)], ...overrides }));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 1)], ...overrides }));

      expect(h.episode.active).toBe(false);
      expect(h.events).toEqual([]);
    });

    it("ends silently once the player is past blendEnd, whatever the verdict would be", () => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, 10)] }));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 0)], OnPitRoad: false, pct: 0.19 }));

      expect(h.episode.active).toBe(false);
      expect(h.events).toEqual([{ verdict: "clear", seconds: 10 }]);
    });
  });

  describe("the landmarks", () => {
    it.each([
      ["none loaded", null, "missing", "missing"],
      ["no pitRoadEnd", { ...LANDMARKS, pitRoadEnd: null }, "missing", "learned"],
      ["no blendEnd", { ...LANDMARKS, blendEnd: null }, "learned", "missing"],
    ] satisfies Array<[string, TrafficPitExitLandmarks | null, string, string]>)(
      "stay silent with %s, logging once per episode",
      (_, landmarks, pitRoadEnd, blendEnd) => {
        const h = harness({ landmarks });

        h.depart(tel({ cars: [arriving(5, 1)] }));
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 1)] }));
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 1)] }));

        expect(h.events).toEqual([]);
        expect(lines(h.debug).filter((line) => line.includes("landmarks"))).toEqual([
          `PitExit: silent, landmarks not learned (pitRoadEnd ${pitRoadEnd}, blendEnd ${blendEnd})`,
        ]);
      },
    );

    it("reads the landmarks only at an evaluation, not on every tick", () => {
      const h = harness();

      h.depart(tel({ pct: 0 }));

      for (let i = 0; i < 5; i++) h.after(100, tel({ pct: 0 }));

      expect(h.readLandmarks).toHaveBeenCalledTimes(1);
    });
  });

  describe("the player's ETA", () => {
    it("on pit road: the distance to pitRoadEnd at the pit limit, plus the reference time on to blendEnd", () => {
      // 100 m at 20 m/s = 5 s, + 60 − 50 = 15 s: a car arriving at 16 s is +1.
      const h = harness();

      h.depart(tel({ cars: [{ idx: 5, pct: 0.05, est: 60 - 16 }] }));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(lines(h.debug).at(-1)).toContain("eta 15.00 s on pitRoad");
    });

    it("on pit road at a slower limit: the same distance takes longer", () => {
      const h = harness({ pitSpeedLimitMps: 25 });

      h.depart(tel({ cars: [{ idx: 5, pct: 0.05, est: 60 - 16 }] }));

      // 100 m at 25 m/s = 4 s, ETA 14: the car is +2.
      expect(h.events).toEqual([{ verdict: "traffic", seconds: 2 }]);
    });

    it("past pitRoadEnd: the reference time from the player's position to blendEnd", () => {
      // No landmark time for the class, so both ends read the curve: 93.75 −
      // 78.125 (0.15625 of the lap) = 15.625 s.
      const h = harness({
        landmarks: { pitRoadEnd: landmark(0.125, {}), blendEnd: landmark(0.1875, {}) },
      });

      const car: Car = { idx: 5, pct: 0.05, est: 93.75 - 15.625 - 1 };

      // On pit road at 0.1: 40 m at 20 m/s + 93.75 − 62.5 = 33.25 s, not yet under the window.
      h.windows.after = 0.5;
      h.depart(tel({ pct: 0.1, cars: [car] }));
      expect(h.events).toEqual([]);

      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ pct: 0.15625, OnPitRoad: false, cars: [car] }));

      // +1 s with the after side at 0.5 s: only a 15.625 s ETA makes it clear at +1.
      expect(h.events).toEqual([{ verdict: "clear", seconds: 1 }]);
      expect(lines(h.debug).at(-1)).toMatch(/eta 15\.6\d s on blend/);
    });

    it("past pitRoadEnd by position with OnPitRoad still true (a landmark learned late): still the blend formula", () => {
      const h = harness({
        landmarks: { pitRoadEnd: landmark(0.125, {}), blendEnd: landmark(0.1875, {}) },
      });

      h.depart(tel({ pct: 0.15625, cars: [{ idx: 5, pct: 0.05, est: 93.75 - 15.625 - 1 }] }));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(lines(h.debug).at(-1)).toContain("on blend");
    });

    it("past pitRoadEnd, the player's own estTime stands in for a curve with no sample there", () => {
      const curves = learnedCurves();

      curves.curves[String(CLS)]!.bins.fill(null, 70, 90);

      const h = harness({ curves });

      // Blend 60 (landmark) − own estTime 45 = 15 s.
      h.depart(tel({ pct: 0.15625, est: 45, cars: [arriving(5, 1)] }));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });

    it.each([
      ["no track length", { trackLengthMeters: null }, "noTrackLength"],
      ["no pit speed limit", { pitSpeedLimitMps: 0 }, "noPitSpeedLimit"],
      [
        "no player-class reference",
        {
          landmarks: { pitRoadEnd: landmark(0.125, {}), blendEnd: landmark(0.1875, {}) },
          curves: createTrafficArrivalState(),
        },
        "noReference",
      ],
    ] satisfies Array<[string, Parameters<typeof harness>[0], string]>)(
      "is unknown with %s: no callout, one debug line per episode",
      (_, options, reason) => {
        const h = harness(options);

        h.depart(tel({ cars: [arriving(5, 1)] }));
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 1)] }));

        expect(h.events).toEqual([]);
        expect(lines(h.debug).filter((line) => line.includes("no ETA"))).toEqual([
          `PitExit: silent, no ETA to blendEnd (${reason})`,
        ]);
      },
    );

    it("adds the class's reference lap when the pit exit straddles the start/finish line", () => {
      // Pit road ends at 0.98 (490 s), the blend at 0.02 (10 s): 10 − 490 + 500 = 20 s on.
      const h = harness({
        landmarks: { pitRoadEnd: landmark(0.98, { [CLS]: 490 }), blendEnd: landmark(0.02, { [CLS]: 10 }) },
        trackLengthMeters: 2000,
      });

      // 0.005 of 2,000 m = 10 m at 20 m/s = 0.5 s: ETA 20.5, not yet under the notice window.
      h.depart(tel({ pct: 0.975 }));
      expect(h.events).toEqual([]);

      // Past the line with the player: 10 − 4 (0.008 of the lap) = 6 s.
      h.after(
        TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS,
        tel({ pct: 0.008, OnPitRoad: false, cars: [{ idx: 5, pct: 0.995, est: 497 }] }),
      );

      // The car crosses the line too: 10 − 497 + 500 = 13 s, 7 s after the player.
      expect(h.events).toEqual([{ verdict: "clear", seconds: 7 }]);
    });
  });

  describe("the window, at the defaults (2 s before, 4 s after)", () => {
    it.each([
      [-3, "clear"],
      [-2.5, "clear"],
      [-2, "traffic"],
      [-1, "traffic"],
      [0, "traffic"],
      [3, "traffic"],
      [4, "traffic"],
      [4.5, "clear"],
      [5, "clear"],
    ] satisfies Array<[number, PitExit["verdict"]]>)("a car arriving %s s from the player is %s", (rel, verdict) => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, rel)] }));

      expect(h.events).toEqual([{ verdict, seconds: rel }]);
    });

    it("is traffic when any car is inside it, and reports the nearest", () => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, -8), arriving(6, 3.5), arriving(7, 12)] }));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 3.5 }]);
    });

    it("reads the windows live, an explicit 0 closing a side", () => {
      const h = harness();

      h.windows.before = 0;
      h.depart(tel({ cars: [arriving(5, -1)] }));

      expect(h.events).toEqual([{ verdict: "clear", seconds: -1 }]);
    });

    it("says clear with no seconds when nobody is on track", () => {
      const h = harness();

      h.depart(tel());

      expect(h.events).toEqual([{ verdict: "clear" }]);
    });
  });

  describe("a car that has just crossed the blend (the before side looks back)", () => {
    /** Landmarks with no per-class time: both read the curve, 93.75 s at the blend. */
    const curveLandmarks: TrafficPitExitLandmarks = { pitRoadEnd: landmark(0.125, {}), blendEnd: landmark(0.1875, {}) };
    /** The player 0.5 s from the blend: 93.25 s on the curve at 0.1865. */
    const nearBlend = (cars: Car[]): TrafficPitExitTelemetry => tel({ pct: 0.1865, cars });
    /** A car that crossed the blend `ago` s ago: just past it on the lap, its next crossing about a lap away. */
    const crossed = (ago: number): Car => ({ idx: 5, pct: (93.75 + ago) / 500, est: 93.75 + ago });

    /** The curve with no sample near the line and no session lap time: the class lap is unknown. */
    function lapUnknown(): { curves: TrafficArrivalState; classes: TrafficClassInfo } {
      const curves = learnedCurves();

      curves.curves[String(CLS)]!.bins.fill(null, 480);

      return { curves, classes: { lapTimeByClass: {}, classByCarIdx: [] } };
    }

    it("is traffic for a car that crossed 1 s ago with the player 0.5 s out: it is alongside", () => {
      const h = harness({ landmarks: curveLandmarks });

      h.depart(nearBlend([crossed(1)]));

      // Next crossing ≈ 498.5 s after the player; the previous one −1.5 s.
      expect(h.events).toEqual([{ verdict: "traffic", seconds: -1.5 }]);
    });

    it("is clear for a car that crossed 3 s ago at the default 2 s before", () => {
      const h = harness({ landmarks: curveLandmarks });

      h.depart(nearBlend([crossed(3)]));

      expect(h.events).toEqual([{ verdict: "clear", seconds: -3.5 }]);
    });

    it("never flips to clear as the car crosses the blend just ahead of the player", () => {
      const h = harness({ landmarks: curveLandmarks });

      // 1.5 s out (92.25 s at 0.1845), the car arrives in 1 s: −0.5 s, traffic.
      h.depart(tel({ pct: 0.1845, cars: [{ idx: 5, pct: 0.1855, est: 92.75 }] }));
      // Then it has crossed, 1 s before the player's 0.5 s: its next crossing
      // is a lap away, and without the look back this would flip to clear.
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, nearBlend([crossed(1)]));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: -0.5 }]);
    });

    it.each([1, 3])(
      "skips the past test with the class lap unknown (crossed %s s ago): the car is untimed, so traffic",
      (ago) => {
        const h = harness({ landmarks: curveLandmarks, ...lapUnknown() });

        h.depart(nearBlend([crossed(ago)]));

        expect(h.events).toEqual([{ verdict: "traffic" }]);
        expect(lines(h.debug).at(-1)).toContain("untimed: car 5 (noClassLap)");
      },
    );

    it("tests only the next crossing of a car short of the blend with the class lap unknown", () => {
      const h = harness({ landmarks: curveLandmarks, ...lapUnknown() });

      // 10 s from the blend: +9.5 s, outside the window; no past crossing to test.
      h.depart(nearBlend([{ idx: 5, pct: 0.1675, est: 83.75 }]));

      expect(h.events).toEqual([{ verdict: "clear", seconds: 9.5 }]);
    });
  });

  describe("untimed cars", () => {
    it("make it traffic, never a false clear, even with every timed car outside the window", () => {
      const h = harness();
      const unknown: Car = { idx: 9, pct: 0.05, est: 40, cls: -1 };

      h.depart(tel({ cars: [unknown, arriving(5, 10)] }));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 10 }]);
      expect(lines(h.debug).at(-1)).toContain("untimed: car 9 (noClass)");
    });

    it("make it traffic with no seconds when they are the only cars", () => {
      const h = harness();

      h.depart(tel({ cars: [{ idx: 9, pct: 0.05, est: 40, cls: -1 }] }));

      expect(h.events).toEqual([{ verdict: "traffic" }]);
    });
  });

  describe("when it speaks", () => {
    /**
     * The player rolling down pit road at the limit from pct 0, where the ETA
     * is 20 s, covering 0.0125 of the lap a second; with them a car arriving
     * `relative` s after them, its own arrival falling a second a second too.
     */
    const rolling = (second: number, relative?: number): TrafficPitExitTelemetry =>
      tel({
        pct: second * 0.0125,
        cars: relative === undefined ? [] : [{ idx: 5, pct: 0.05, est: 60 - (20 - second + relative) }],
      });

    it("speaks once, at the first evaluation with the ETA under the notice window", () => {
      const h = harness();

      h.depart(rolling(0, 1));
      expect(h.events).toEqual([]);

      for (let s = 1; s <= 4; s++) h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, rolling(s, 1));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });

    it("evaluates once a second, not on every tick", () => {
      const h = harness();

      h.depart(rolling(0));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS - 1, rolling(1));
      expect(h.events).toEqual([]);

      h.after(1, rolling(1));
      expect(h.events).toEqual([{ verdict: "clear" }]);
    });

    it("speaks again on a flip of the verdict, and only then", () => {
      const h = harness();
      const step = (cars: Car[]): void => h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars }));

      h.depart(tel({ cars: [arriving(5, 3)] }));
      step([arriving(5, 3.5)]);
      step([arriving(5, 5)]);
      step([arriving(5, 6)]);
      step([arriving(5, -1)]);

      expect(h.events).toEqual([
        { verdict: "traffic", seconds: 3 },
        { verdict: "clear", seconds: 5 },
        { verdict: "traffic", seconds: -1 },
      ]);
    });

    it("speaks again in the next episode", () => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, 1)] }));
      h.after(100, tel({ PlayerTrackSurface: TrkLoc.OnTrack }));
      h.after(100, IN_STALL);
      h.after(100, tel({ cars: [arriving(5, 1)] }));

      expect(h.events).toEqual([
        { verdict: "traffic", seconds: 1 },
        { verdict: "traffic", seconds: 1 },
      ]);
    });
  });

  describe("the debug lines", () => {
    it("name the episode's start, each emit with the ETA, the nearest car and its source, and the end", () => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, 1.25)] }));
      h.after(100, tel({ PlayerTrackSurface: TrkLoc.OnTrack }));

      expect(lines(h.debug)).toEqual([
        "PitExit: episode started (left the stall at pct=0.0625)",
        "PitExit: emit traffic (first call; eta 15.00 s on pitRoad, window -2/+4 s; nearest car 5 at 1.25 s via landmark; untimed: none)",
        "PitExit: episode ended (on the racing surface)",
      ]);
    });
  });
});
