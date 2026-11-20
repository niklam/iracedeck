import type { SimEventMap } from "@iracedeck/event-bus";
import { TrkLoc } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import type { PitLaneResolvedLandmark } from "@iracedeck/track-data";
import { describe, expect, it, vi } from "vitest";

import {
  createTrafficArrivalState,
  createTrafficPitExitState,
  type TrafficArrivalState,
  type TrafficCurveBin,
} from "../state.js";
import { TRAFFIC_CURVE_BINS, type TrafficClassInfo } from "./traffic-arrival.js";
import {
  diffTrafficPitExit,
  TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS,
  TRAFFIC_PIT_EXIT_FLIP_CONFIRM_EVALUATIONS,
  TRAFFIC_PIT_EXIT_POSITION_GRACE_MS,
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

const CLASSES: TrafficClassInfo = { lapTimeByClass: { [CLS]: 500 }, classByCarIdx: {} };

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
  const episode = createTrafficPitExitState();
  const events: PitExit[] = [];
  /**
   * Each verdict the episode settled on, as it would be spoken: the first, and
   * every flip that held. Silent short of `pitRoadEnd` (amended 2026-11-20),
   * so the verdict model is tested here and the speaking in its own block.
   */
  const settled: PitExit[] = [];
  const debug = vi.fn<(line: string) => void>();
  const logger: ILogger = { ...silentLogger, debug };
  const readLandmarks = vi.fn(() => landmarks);
  const windows = { before: 2, after: 4 };
  let now = 1_000_000;

  const tick = (t: TrafficPitExitTelemetry): void => {
    const before = episode.settledVerdict;

    diffTrafficPitExit(
      episode,
      curves,
      t,
      { playerCarIdx: PLAYER, classes, trackLengthMeters, pitSpeedLimitMps, readLandmarks },
      {
        getBeforeSeconds: () => windows.before,
        getAfterSeconds: () => windows.after,
      },
      now,
      (ev) => events.push(ev.data),
      logger,
    );

    const verdict = episode.settledVerdict;

    if (verdict !== null && verdict !== before) {
      settled.push(episode.settledSeconds === null ? { verdict } : { verdict, seconds: episode.settledSeconds });
    }
  };

  return {
    episode,
    events,
    settled,
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

/**
 * Landmarks with no per-class time, so the ETA reads the curve on both
 * phases (`T(pct) = 500 × pct`): pit road ends at 0.125 (62.5 s), the
 * blend at 0.1875 (93.75 s).
 */
const CURVE_LANDMARKS: TrafficPitExitLandmarks = {
  pitRoadEnd: landmark(0.125, {}),
  blendEnd: landmark(0.1875, {}),
};

/**
 * The player at `pct` with car 5 reaching the blend `relative` s after
 * them. Short of pit road's end on pit road: the distance to 0.125 at the
 * 20 m/s limit (80 s a lap) plus 93.75 − 62.5. At or past it, or off pit
 * road: 93.75 − 500 × pct, the blend lane on the curve.
 */
const at = (pct: number, relative: number, overrides: TickOptions = {}): TrafficPitExitTelemetry => {
  const onPitRoad = overrides.OnPitRoad ?? pct < 0.125;
  const eta = onPitRoad && pct < 0.125 ? (0.125 - pct) * 80 + 31.25 : 93.75 - 500 * pct;

  return tel({
    pct,
    OnPitRoad: onPitRoad,
    cars: [{ idx: 5, pct: 0.05, est: 93.75 - (eta + relative) }],
    ...overrides,
  });
};

const lines = (debug: ReturnType<typeof vi.fn>): string[] => debug.mock.calls.map(([line]) => String(line));

describe("diffTrafficPitExit", () => {
  describe("the episode", () => {
    it("starts on driving out of the stall and settles a verdict on the departure tick, unspoken", () => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, 1)] }));

      expect(h.episode.active).toBe(true);
      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
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

      expect(h.settled).toEqual([]);
    });

    it.each([
      ["out of the car (a tow or leaving)", { IsOnTrack: false }],
      ["not in world (a reset)", { PlayerTrackSurface: TrkLoc.NotInWorld, pct: -1 }],
      ["back in the stall", { PlayerCarInPitStall: true, PlayerTrackSurface: TrkLoc.InPitStall }],
      [
        "back in the stall, the stall flag unread",
        { PlayerCarInPitStall: undefined, PlayerTrackSurface: TrkLoc.InPitStall },
      ],
      ["on the racing surface", { PlayerTrackSurface: TrkLoc.OnTrack }],
      ["beside the racing surface", { PlayerTrackSurface: TrkLoc.OffTrack }],
    ] satisfies Array<[string, TickOptions]>)("ends silently %s", (_, overrides) => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, 1)] }));
      // A car now well clear of the window: a running episode would speak the
      // flip at its second evaluation.
      h.after(100, tel({ cars: [arriving(5, 10)], ...overrides }));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 10)], ...overrides }));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 10)], ...overrides }));

      expect(h.episode.active).toBe(false);
      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });

    describe("the stall surface", () => {
      it("with the stall flag unread, ends the episode before a first verdict is settled", () => {
        const h = harness();

        // No position on the departure tick: the episode runs, no call yet.
        h.depart(tel({ cars: [arriving(5, 1)], CarIdxLapDistPct: undefined }));
        expect(h.episode.active).toBe(true);

        // A reset into the stall on a tick whose stall flag the sim did not send.
        h.after(
          100,
          tel({ cars: [arriving(5, 1)], PlayerCarInPitStall: undefined, PlayerTrackSurface: TrkLoc.InPitStall }),
        );

        expect(h.episode.active).toBe(false);
        expect(h.settled).toEqual([]);
        expect(lines(h.debug).at(-1)).toBe("episode ended (back in the stall)");
      });

      it("with the stall flag unread, keeps the player in the stall: the departure after it starts the episode", () => {
        const h = harness();

        h.tick(IN_STALL);
        // The stall flag not sent for a tick, the surface still in the stall.
        h.after(100, tel({ PlayerCarInPitStall: undefined, PlayerTrackSurface: TrkLoc.InPitStall }));
        h.after(100, tel({ cars: [arriving(5, 1)] }));

        expect(h.episode.active).toBe(true);
        expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
      });

      it("with the stall flag false, is a departure whose surface lags: the verdict settles and the episode runs on", () => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 1)], PlayerTrackSurface: TrkLoc.InPitStall }));
        h.after(100, tel({ cars: [arriving(5, 1)], PlayerTrackSurface: TrkLoc.InPitStall }));

        expect(h.episode.active).toBe(true);
        expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
      });
    });

    describe("a player position the sim did not send", () => {
      it("is held for one second", () => {
        expect(TRAFFIC_PIT_EXIT_POSITION_GRACE_MS).toBe(1_000);
      });

      /** Each way the player's position can be missing from a tick, with a car whose arrival is `relative` s after the player's. */
      const dropouts: Array<[string, (relative: number) => TrafficPitExitTelemetry]> = [
        ["the array missing", (r) => tel({ cars: [arriving(5, r)], CarIdxLapDistPct: undefined })],
        [
          "the array not an array",
          (r) => tel({ cars: [arriving(5, r)], CarIdxLapDistPct: 0.1 as unknown as number[] }),
        ],
        [
          // Indexable, so the player's entry reads, while the arrival model
          // refuses the container: without its own array check the detector
          // would evaluate, find no per-car arrays and reset a held flip.
          "the array an array-like object",
          (r) => {
            const t = tel({ cars: [arriving(5, r)] });

            return { ...t, CarIdxLapDistPct: { ...(t.CarIdxLapDistPct as number[]) } as unknown as number[] };
          },
        ],
        ["the player's entry missing", (r) => tel({ cars: [arriving(5, r)], CarIdxLapDistPct: [] })],
        ["the entry not a number", (r) => tel({ cars: [arriving(5, r)], pct: "0.1" as unknown as number })],
        ["the entry NaN", (r) => tel({ cars: [arriving(5, r)], pct: Number.NaN })],
        ["the entry infinite", (r) => tel({ cars: [arriving(5, r)], pct: Number.POSITIVE_INFINITY })],
        ["the entry clearly past the line", (r) => tel({ cars: [arriving(5, r)], pct: 1.5 })],
      ];

      it.each(dropouts)(
        "a one-tick dropout (%s) mid-exit keeps the episode, and the flip is spoken after it",
        (_, gap) => {
          const h = harness();

          h.depart(tel({ cars: [arriving(5, 3)] }));
          // The first evaluation of a flip to clear.
          h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 5)] }));
          h.after(100, gap(5));
          expect(h.episode.active).toBe(true);

          // The position back, an interval after the last evaluation: the flip's second.
          h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS - 100, tel({ cars: [arriving(5, 5.5)] }));

          expect(h.settled).toEqual([
            { verdict: "traffic", seconds: 3 },
            { verdict: "clear", seconds: 5.5 },
          ]);
          expect(lines(h.debug)).toContain("player position unavailable, episode held");
          expect(lines(h.debug)).toContain("player position back after 900 ms, episode kept");
        },
      );

      it.each(dropouts)(
        "a dropout (%s) on the departure tick holds the episode, and the first call follows",
        (_, gap) => {
          const h = harness();

          h.depart(gap(1));
          expect(h.episode.active).toBe(true);
          expect(h.settled).toEqual([]);

          h.after(TRAFFIC_PIT_EXIT_POSITION_GRACE_MS / 2, tel({ cars: [arriving(5, 1)] }));

          expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
        },
      );

      it("makes no evaluation while it lasts", () => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 3)] }));
        h.readLandmarks.mockClear();
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 10)], CarIdxLapDistPct: undefined }));

        expect(h.readLandmarks).not.toHaveBeenCalled();
        expect(h.episode.lastEvalAt).not.toBeNull();
      });

      it.each(dropouts)("ends the episode silently once it (%s) has lasted the grace", (_, dropout) => {
        const h = harness();
        const gap = dropout(10);

        h.depart(tel({ cars: [arriving(5, 1)] }));
        h.after(100, gap);
        h.after(TRAFFIC_PIT_EXIT_POSITION_GRACE_MS - 1, gap);
        expect(h.episode.active).toBe(true);

        h.after(1, gap);
        expect(h.episode.active).toBe(false);
        expect(lines(h.debug).at(-1)).toBe("episode ended (player position unavailable for 1000 ms)");

        // The position back, with no departure edge: nothing more this exit.
        h.after(100, tel({ cars: [arriving(5, 10)] }));
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 10)] }));
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 10)] }));

        expect(h.episode.active).toBe(false);
        expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
      });

      it("ends it on the position coming back after the grace with no tick in between, keeping the stall baseline", () => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 1)] }));
        h.after(100, tel({ cars: [arriving(5, 10)], CarIdxLapDistPct: undefined }));
        // The sim sent nothing for 1.1 s; the next tick reads the position again.
        h.after(TRAFFIC_PIT_EXIT_POSITION_GRACE_MS + 100, tel({ cars: [arriving(5, 10)] }));

        expect(h.episode.active).toBe(false);
        expect(lines(h.debug).at(-1)).toBe(
          `episode ended (player position unavailable for ${TRAFFIC_PIT_EXIT_POSITION_GRACE_MS + 100} ms)`,
        );
        expect(h.episode.lastInPitStall).toBe(false);

        // Nothing more this exit: a flip to clear is never spoken.
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 10)] }));
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 10)] }));
        expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);

        // The baseline still sees the next stop's departure edge.
        h.depart(tel({ cars: [arriving(5, 10)] }));
        expect(h.episode.active).toBe(true);
        expect(h.settled).toEqual([
          { verdict: "traffic", seconds: 1 },
          { verdict: "clear", seconds: 10 },
        ]);
      });

      it("keeps it on the position coming back just inside the grace with no tick in between", () => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 1)] }));
        h.after(100, tel({ cars: [arriving(5, 1)], CarIdxLapDistPct: undefined }));
        h.after(TRAFFIC_PIT_EXIT_POSITION_GRACE_MS - 1, tel({ cars: [arriving(5, 1)] }));

        expect(h.episode.active).toBe(true);
        expect(lines(h.debug)).toContain(
          `player position back after ${TRAFFIC_PIT_EXIT_POSITION_GRACE_MS - 1} ms, episode kept`,
        );
      });

      it("measures each gap from its own start", () => {
        const h = harness();
        const gap = tel({ cars: [arriving(5, 1)], CarIdxLapDistPct: undefined });

        h.depart(tel({ cars: [arriving(5, 1)] }));
        h.after(100, gap);
        h.after(TRAFFIC_PIT_EXIT_POSITION_GRACE_MS - 100, tel({ cars: [arriving(5, 1)] }));
        h.after(100, gap);
        h.after(TRAFFIC_PIT_EXIT_POSITION_GRACE_MS - 1, gap);

        expect(h.episode.active).toBe(true);
      });

      it("restarts the gap on a wall clock that stepped back, never ending at once", () => {
        const h = harness();
        const gap = tel({ cars: [arriving(5, 1)], CarIdxLapDistPct: undefined });

        h.depart(tel({ cars: [arriving(5, 1)] }));
        h.after(100, gap);
        h.after(-30_000, gap);
        h.after(TRAFFIC_PIT_EXIT_POSITION_GRACE_MS - 1, gap);
        expect(h.episode.active).toBe(true);

        h.after(1, gap);
        expect(h.episode.active).toBe(false);
      });

      it.each([
        ["NotInWorld with a position", { PlayerTrackSurface: TrkLoc.NotInWorld }],
        ["NotInWorld with no position", { PlayerTrackSurface: TrkLoc.NotInWorld, CarIdxLapDistPct: undefined }],
        ["the sim's −1 on pit road", { pct: -1 }],
        ["a negative position", { pct: -0.25 }],
      ] satisfies Array<[string, TickOptions]>)("still ends at once on a not-in-world reading: %s", (_, overrides) => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 1)] }));
        h.after(100, tel({ cars: [arriving(5, 1)], ...overrides }));

        expect(h.episode.active).toBe(false);
        expect(lines(h.debug).at(-1)).toBe("episode ended (not in world)");
      });
    });

    it("ends silently once the player is past blendEnd, whatever the verdict would be", () => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, 10)] }));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 0)], OnPitRoad: false, pct: 0.19 }));

      expect(h.episode.active).toBe(false);
      expect(h.settled).toEqual([{ verdict: "clear", seconds: 10 }]);
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

        expect(h.settled).toEqual([]);
        expect(lines(h.debug).filter((line) => line.includes("landmarks"))).toEqual([
          `silent, landmarks not learned (pitRoadEnd ${pitRoadEnd}, blendEnd ${blendEnd})`,
        ]);
      },
    );

    it.each([
      [
        "pitRoadEnd",
        { ...LANDMARKS, pitRoadEnd: { ...LANDMARKS.pitRoadEnd!, source: "previous" } },
        "previous",
        "current",
      ],
      ["blendEnd", { ...LANDMARKS, blendEnd: { ...LANDMARKS.blendEnd!, source: "previous" } }, "current", "previous"],
    ] satisfies Array<[string, TrafficPitExitLandmarks, string, string]>)(
      "stay silent with a %s kept from before a track rebuild, logging once per episode",
      (_, landmarks, pitRoadEnd, blendEnd) => {
        const h = harness({ landmarks });

        h.depart(tel({ cars: [arriving(5, 1)] }));
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 1)] }));
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 1)] }));

        expect(h.settled).toEqual([]);
        expect(lines(h.debug).filter((line) => line.includes("landmarks"))).toEqual([
          `silent, landmarks relearning after a track rebuild (pitRoadEnd ${pitRoadEnd}, blendEnd ${blendEnd})`,
        ]);
      },
    );

    it("starts a held flip's count again after an evaluation on a landmark of the old geometry", () => {
      const h = harness();
      const relearning: TrafficPitExitLandmarks = {
        ...LANDMARKS,
        blendEnd: { ...LANDMARKS.blendEnd!, source: "previous" },
      };

      h.depart(tel({ cars: [arriving(5, 1)] }));
      // The flip to clear, first of two.
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 10)] }));
      h.readLandmarks.mockReturnValueOnce(relearning);
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 10)] }));
      // Back on current landmarks: first of two again, not spoken.
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 10)] }));
      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);

      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 10)] }));
      expect(h.settled).toEqual([
        { verdict: "traffic", seconds: 1 },
        { verdict: "clear", seconds: 10 },
      ]);
    });

    it("retries a landmark read that threw on the next tick, so the first verdict is not lost", () => {
      const h = harness();

      h.readLandmarks.mockImplementationOnce(() => {
        throw new Error("read failed");
      });
      expect(() => h.depart(tel({ cars: [arriving(5, 1)] }))).toThrow("read failed");
      h.after(100, tel({ cars: [arriving(5, 1)] }));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(h.readLandmarks).toHaveBeenCalledTimes(2);
    });

    it("between evaluations, reads the landmarks to find the call point but evaluates nothing short of it", () => {
      const h = harness();

      h.depart(tel({ pct: 0 }));

      for (let i = 0; i < 5; i++) h.after(100, tel({ pct: 0, cars: [arriving(5, 1)] }));

      // The departure's evaluation, then one read a tick looking for the call point.
      expect(h.readLandmarks).toHaveBeenCalledTimes(6);
      expect(h.settled).toEqual([{ verdict: "clear" }]);
    });

    it("between evaluations, reads no landmarks once the call is made", () => {
      const h = harness();

      // Out of a stall past the learned pitRoadEnd: the call is made at the departure.
      h.depart(tel({ pct: 0.13 }));
      expect(h.events).toHaveLength(1);
      h.readLandmarks.mockClear();

      for (let i = 0; i < 5; i++) h.after(100, tel({ pct: 0.13 }));

      expect(h.readLandmarks).not.toHaveBeenCalled();
    });
  });

  describe("the player's ETA", () => {
    it("on pit road: the distance to pitRoadEnd at the pit limit, plus the reference time on to blendEnd", () => {
      // 100 m at 20 m/s = 5 s, + 60 − 50 = 15 s: a car arriving at 16 s is +1.
      const h = harness();

      h.depart(tel({ cars: [{ idx: 5, pct: 0.05, est: 60 - 16 }] }));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(lines(h.debug).at(-1)).toContain("eta 15.00 s on pitRoad");
    });

    it("on pit road at a slower limit: the same distance takes longer", () => {
      const h = harness({ pitSpeedLimitMps: 25 });

      h.depart(tel({ cars: [{ idx: 5, pct: 0.05, est: 60 - 16 }] }));

      // 100 m at 25 m/s = 4 s, ETA 14: the car is +2.
      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 2 }]);
    });

    it("past pitRoadEnd: the reference time from the player's position to blendEnd", () => {
      // No landmark time for the class, so both ends read the curve: 93.75 −
      // 78.125 (0.15625 of the lap) = 15.625 s.
      const h = harness({
        landmarks: { pitRoadEnd: landmark(0.125, {}), blendEnd: landmark(0.1875, {}) },
      });

      const car: Car = { idx: 5, pct: 0.05, est: 93.75 - 15.625 - 1 };

      // On pit road at 0.1: 40 m at 20 m/s + 93.75 − 62.5 = 33.25 s, and a car
      // arriving with the player then: traffic, spoken at the departure.
      h.windows.after = 0.5;
      h.depart(tel({ pct: 0.1, cars: [{ idx: 5, pct: 0.05, est: 93.75 - 33.25 }] }));
      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 0 }]);

      // Held for a second evaluation, as every flip is.
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ pct: 0.15625, OnPitRoad: false, cars: [car] }));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ pct: 0.15625, OnPitRoad: false, cars: [car] }));

      // +1 s with the after side at 0.5 s: only a 15.625 s ETA flips it to clear at +1.
      expect(h.settled).toEqual([
        { verdict: "traffic", seconds: 0 },
        { verdict: "clear", seconds: 1 },
      ]);
      expect(lines(h.debug).at(-1)).toMatch(/eta 15\.6\d s on blend/);
    });

    describe("a tick that does not send OnPitRoad", () => {
      it("keeps the pit-road formula the departure was on", () => {
        const h = harness();

        // No position on the departure tick, so the first evaluation comes on
        // the next one, which sends no OnPitRoad: still 15 s on pit road.
        h.depart(tel({ cars: [arriving(5, 1)], CarIdxLapDistPct: undefined }));
        h.after(100, tel({ cars: [arriving(5, 1)], OnPitRoad: undefined }));

        expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
        expect(lines(h.debug).at(-1)).toContain("eta 15.00 s on pitRoad");
      });

      it("keeps the blend formula after an explicit false, read on a tick that made no evaluation", () => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 1)], CarIdxLapDistPct: undefined }));
        h.after(100, tel({ cars: [arriving(5, 1)], OnPitRoad: false, CarIdxLapDistPct: undefined }));
        h.after(100, tel({ cars: [arriving(5, 1)], OnPitRoad: undefined }));

        // 60 − 31.25 = 28.75 s from the curve: the car at 16 s is 12.75 s before.
        expect(h.settled).toEqual([{ verdict: "clear", seconds: -12.7 }]);
        expect(lines(h.debug).at(-1)).toContain("eta 28.75 s on blend");
      });

      it("keeps the blend formula after an explicit false read on a tick whose evaluation threw", () => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 1)], CarIdxLapDistPct: undefined }));
        h.readLandmarks.mockImplementationOnce(() => {
          throw new Error("read failed");
        });
        expect(() => h.after(100, tel({ cars: [arriving(5, 1)], OnPitRoad: false }))).toThrow("read failed");
        // The retry, on the next tick, which does not send the bit.
        h.after(100, tel({ cars: [arriving(5, 1)], OnPitRoad: undefined }));

        expect(h.settled).toEqual([{ verdict: "clear", seconds: -12.7 }]);
        expect(lines(h.debug).at(-1)).toContain("eta 28.75 s on blend");
      });
    });

    it("past pitRoadEnd by position with OnPitRoad still true (a landmark learned late): still the blend formula", () => {
      const h = harness({
        landmarks: { pitRoadEnd: landmark(0.125, {}), blendEnd: landmark(0.1875, {}) },
      });

      h.depart(tel({ pct: 0.15625, cars: [{ idx: 5, pct: 0.05, est: 93.75 - 15.625 - 1 }] }));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(lines(h.debug).at(-1)).toContain("on blend");
    });

    it("past pitRoadEnd, the player's own estTime stands in for a curve with no sample there", () => {
      const curves = learnedCurves();

      curves.curves[String(CLS)]!.bins.fill(null, 70, 90);

      const h = harness({ curves });

      // Blend 60 (landmark) − own estTime 45 = 15 s.
      h.depart(tel({ pct: 0.15625, est: 45, cars: [arriving(5, 1)] }));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
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

        expect(h.settled).toEqual([]);
        expect(lines(h.debug).filter((line) => line.includes("no ETA"))).toEqual([
          `silent, no ETA to blendEnd (${reason})`,
        ]);
      },
    );

    it("adds the class's reference lap when the pit exit straddles the start/finish line", () => {
      // Pit road ends at 0.98 (490 s), the blend at 0.02 (10 s): 10 − 490 + 500 = 20 s on.
      const h = harness({
        landmarks: { pitRoadEnd: landmark(0.98, { [CLS]: 490 }), blendEnd: landmark(0.02, { [CLS]: 10 }) },
        trackLengthMeters: 2000,
      });

      // 0.005 of 2,000 m = 10 m at 20 m/s = 0.5 s: ETA 20.5. A car short of the
      // line arrives with the player: 10 − 489.5 + 500 = 20.5 s.
      h.depart(tel({ pct: 0.975, cars: [{ idx: 5, pct: 0.979, est: 489.5 }] }));
      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 0 }]);

      // Past the line with the player: 10 − 4 (0.008 of the lap) = 6 s. Twice,
      // as every flip is held for a second evaluation.
      for (let i = 0; i < 2; i++) {
        h.after(
          TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS,
          tel({ pct: 0.008, OnPitRoad: false, cars: [{ idx: 5, pct: 0.995, est: 497 }] }),
        );
      }

      // The car crosses the line too: 10 − 497 + 500 = 13 s, 7 s after the player.
      expect(h.settled).toEqual([
        { verdict: "traffic", seconds: 0 },
        { verdict: "clear", seconds: 7 },
      ]);
    });

    describe("a pit exit across the start/finish line, read as 1.0000126 on the line", () => {
      /** Pit road ends at 0.98 (490 s), the blend at 0.02 (10 s), on a 2,000 m track. */
      const ACROSS: TrafficPitExitLandmarks = {
        pitRoadEnd: landmark(0.98, { [CLS]: 490 }),
        blendEnd: landmark(0.02, { [CLS]: 10 }),
      };
      /** The player on the line: the sim's reading there, its time already restarted. */
      const ON_LINE = 1.0000126;

      it("runs on through the tick on the line and settles the flip after it", () => {
        const h = harness({ landmarks: ACROSS, trackLengthMeters: 2000 });

        // As above: the ETA 20.5 s, the car arriving with the player.
        h.depart(tel({ pct: 0.975, cars: [{ idx: 5, pct: 0.979, est: 489.5 }] }));
        // On the line: about 10 s to the blend (10 − 0.0063 on the curve); the
        // car 20 s out (10 − 490 + 500) is +10 s, outside the window.
        h.after(
          TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS,
          tel({ pct: ON_LINE, est: 0.0063, OnPitRoad: false, cars: [{ idx: 5, pct: 0.98, est: 490 }] }),
        );

        expect(h.episode.active).toBe(true);
        expect(lines(h.debug).filter((line) => line.includes("ended"))).toEqual([]);

        // Past the line, the flip held for its second evaluation: 13 − 6 = +7 s.
        h.after(
          TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS,
          tel({ pct: 0.008, OnPitRoad: false, cars: [{ idx: 5, pct: 0.995, est: 497 }] }),
        );

        expect(h.episode.active).toBe(true);
        expect(h.settled).toEqual([
          { verdict: "traffic", seconds: 0 },
          { verdict: "clear", seconds: 7 },
        ]);
      });

      it("settles the verdict at a departure from a stall on the line", () => {
        const h = harness({ landmarks: ACROSS, trackLengthMeters: 2000 });

        // Past pitRoadEnd by position: about 10 s to the blend on the curve. A
        // car 0.02 of the lap short of the line arrives in 10 − 490 + 500 = 20 s:
        // about +10 s, clear.
        h.depart(tel({ pct: ON_LINE, est: 0.0063, cars: [{ idx: 5, pct: 0.98, est: 490 }] }));

        expect(h.episode.active).toBe(true);
        expect(h.settled).toEqual([{ verdict: "clear", seconds: 10 }]);
        expect(lines(h.debug).at(-1)).toContain("on blend");
      });
    });

    describe("from a stall more than half a lap before blendEnd (a pit road along both straights)", () => {
      // Pit road ends at 0.75 (375 s), the blend at 0.80 (400 s); the stall at 0.20.
      const FAR: TrafficPitExitLandmarks = {
        pitRoadEnd: landmark(0.75, { [CLS]: 375 }),
        blendEnd: landmark(0.8, { [CLS]: 400 }),
      };

      it("settles the verdict at the departure, on the pit-road formula over the whole pit road", () => {
        const h = harness({ landmarks: FAR });

        // 0.55 of 1,600 m = 880 m at 20 m/s = 44 s, + 400 − 375 = 69 s. A car
        // reaching the blend at 70 s (400 − 330) is +1.
        h.depart(tel({ pct: 0.2, cars: [{ idx: 5, pct: 0.66, est: 330 }] }));

        expect(h.episode.active).toBe(true);
        expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
        expect(lines(h.debug).at(-1)).toContain("eta 69.00 s on pitRoad");
      });

      it("runs on past pitRoadEnd on the blend formula, and ends past blendEnd", () => {
        const h = harness({ landmarks: FAR });

        h.depart(tel({ pct: 0.2, cars: [{ idx: 5, pct: 0.66, est: 330 }] }));
        // Off pit road at 0.78 (390 s on the curve): 10 s to the blend, the car +1.
        h.after(
          TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS,
          tel({ pct: 0.78, OnPitRoad: false, cars: [{ idx: 5, pct: 0.7, est: 389 }] }),
        );

        expect(h.episode.active).toBe(true);
        expect(lines(h.debug).filter((line) => line.includes("ended"))).toEqual([]);

        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ pct: 0.805, OnPitRoad: false }));

        expect(h.episode.active).toBe(false);
        expect(lines(h.debug).at(-1)).toBe("episode ended (past blendEnd)");
        expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
      });
    });

    it("counts a player a few metres past blendEnd, still off the racing surface, as past it, never a lap short", () => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, 10)] }));
      // 8 m past the blend line on the 1,600 m track: the landmark learned a
      // little early, the surface not flipped yet. A lap short, the car at +0
      // would be judged against an ETA a lap away.
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 0)], OnPitRoad: false, pct: 0.1925 }));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 0)], OnPitRoad: false, pct: 0.1925 }));

      expect(h.episode.active).toBe(false);
      expect(lines(h.debug)).toContain("episode ended (past blendEnd)");
      expect(h.settled).toEqual([{ verdict: "clear", seconds: 10 }]);
    });

    describe("a player further past blendEnd than the slack, still off the racing surface", () => {
      it("is past it by the episode's own progress: no first verdict a lap short on landmarks learned meanwhile", () => {
        const h = harness({ landmarks: null });

        h.depart(tel());
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ OnPitRoad: false, pct: 0.15 }));
        // 20 m past the blend line on the 1,600 m track, in a merge lane the
        // surface still reads as the pit approach, as the landmarks arrive.
        // A lap short, the empty track would be called clear 460 s out.
        h.readLandmarks.mockReturnValue(LANDMARKS);
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ OnPitRoad: false, pct: 0.2 }));

        expect(h.settled).toEqual([]);
        expect(h.episode.active).toBe(false);
        expect(lines(h.debug).at(-1)).toBe("episode ended (past blendEnd)");
      });

      it("ends when the departure tick had none and the position read as the landmarks arrive is past it", () => {
        const h = harness({ landmarks: null });

        h.depart(tel({ CarIdxLapDistPct: undefined }));
        h.after(100, tel({ pct: 0.07 }));
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ OnPitRoad: false, pct: 0.15 }));
        h.readLandmarks.mockReturnValue(LANDMARKS);
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ OnPitRoad: false, pct: 0.2 }));

        expect(h.settled).toEqual([]);
        expect(h.episode.active).toBe(false);
      });

      describe("with no position on the departure tick", () => {
        it("takes no start past blendEnd: no verdict a lap short when the first position read is past it", () => {
          const h = harness();

          h.depart(tel({ CarIdxLapDistPct: undefined }));
          // The first position read is 20 m past the blend line, more than the
          // slack: as a start it would read no progress, and the empty track
          // would be called clear a lap out.
          h.after(100, tel({ OnPitRoad: false, pct: 0.2 }));
          h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ OnPitRoad: false, pct: 0.2 }));

          expect(h.settled).toEqual([]);
          expect(h.episode.active).toBe(false);
          expect(lines(h.debug)).toContain("episode ended (past blendEnd, with no departure position)");
        });

        it("takes no start past blendEnd when the landmarks arrive only after the first position", () => {
          const h = harness({ landmarks: null });

          h.depart(tel({ CarIdxLapDistPct: undefined }));
          h.after(100, tel({ OnPitRoad: false, pct: 0.2 }));
          h.readLandmarks.mockReturnValue(LANDMARKS);
          h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ OnPitRoad: false, pct: 0.2 }));

          expect(h.settled).toEqual([]);
          expect(h.episode.active).toBe(false);
        });

        it("starts from the first position read short of blendEnd, and judges the exit from there", () => {
          const h = harness();

          h.depart(tel({ CarIdxLapDistPct: undefined }));
          h.after(100, tel({ cars: [arriving(5, 1)] }));

          expect(h.episode.startPct).toBe(STALL_PCT);
          expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
        });

        it("starts from a position read once the landmarks arrive, short of blendEnd, and runs on", () => {
          const h = harness({ landmarks: null });

          h.depart(tel({ CarIdxLapDistPct: undefined }));
          h.after(100, tel());
          h.readLandmarks.mockReturnValue(LANDMARKS);
          h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ pct: 0.1, cars: [arriving(5, 20)] }));

          expect(h.episode.active).toBe(true);
          expect(h.episode.startPct).toBe(0.1);
          expect(h.settled).toHaveLength(1);
        });
      });

      it("is not a car rolled back behind where the episode started, which runs on", () => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 1)] }));
        // 20 m back from the stall: still 0.1375 of the lap short of the blend.
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 1)], pct: 0.05 }));

        expect(h.episode.active).toBe(true);
        expect(lines(h.debug).filter((line) => line.includes("ended"))).toEqual([]);
        expect(h.episode.lastEvalAt).not.toBeNull();
      });
    });

    it("adds no lap for a pitRoadEnd learned a hair after blendEnd (a pit lane ending straight onto the track)", () => {
      // 0.16 m apart, in the wrong order: the same point, no time between them.
      const h = harness({
        landmarks: { pitRoadEnd: landmark(0.1876, { [CLS]: 60.05 }), blendEnd: landmark(0.1875, { [CLS]: 60 }) },
      });

      // 0.125 of 1,600 m = 200 m at 20 m/s = 10 s; a car reaching the blend at 11 s is +1.
      h.depart(tel({ cars: [{ idx: 5, pct: 0.05, est: 49 }] }));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(lines(h.debug).at(-1)).toContain("eta 10.00 s on pitRoad");
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

      expect(h.settled).toEqual([{ verdict, seconds: rel }]);
    });

    it("is traffic when any car is inside it, and reports the nearest", () => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, -8), arriving(6, 3.5), arriving(7, 12)] }));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 3.5 }]);
    });

    it("reads the windows live, an explicit 0 closing a side", () => {
      const h = harness();

      h.windows.before = 0;
      h.depart(tel({ cars: [arriving(5, -1)] }));

      expect(h.settled).toEqual([{ verdict: "clear", seconds: -1 }]);
    });

    it("says clear with no seconds when nobody is on track", () => {
      const h = harness();

      h.depart(tel());

      expect(h.settled).toEqual([{ verdict: "clear" }]);
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

      return { curves, classes: { lapTimeByClass: {}, classByCarIdx: {} } };
    }

    it("is traffic for a car that crossed 1 s ago with the player 0.5 s out: it is alongside", () => {
      const h = harness({ landmarks: curveLandmarks });

      h.depart(nearBlend([crossed(1)]));

      // Next crossing ≈ 498.5 s after the player; the previous one −1.5 s.
      expect(h.settled).toEqual([{ verdict: "traffic", seconds: -1.5 }]);
    });

    it("is clear for a car that crossed 3 s ago at the default 2 s before", () => {
      const h = harness({ landmarks: curveLandmarks });

      h.depart(nearBlend([crossed(3)]));

      expect(h.settled).toEqual([{ verdict: "clear", seconds: -3.5 }]);
    });

    it("never flips to clear as the car crosses the blend just ahead of the player", () => {
      const h = harness({ landmarks: curveLandmarks });

      // 1.5 s out (92.25 s at 0.1845), the car arrives in 1 s: −0.5 s, traffic.
      h.depart(tel({ pct: 0.1845, cars: [{ idx: 5, pct: 0.1855, est: 92.75 }] }));
      // Then it has crossed, 1 s before the player's 0.5 s: its next crossing
      // is a lap away, and without the look back this would flip to clear.
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, nearBlend([crossed(1)]));
      // A second evaluation after the crossing, the player 0.45 s out and the
      // car's previous crossing −1.65 s, still inside the before window: two
      // wrong clears in a row would be a confirmed flip, so this is the one
      // that proves the look back rather than the flip confirmation.
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ pct: 0.1866, cars: [crossed(1.2)] }));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: -0.5 }]);
      expect(lines(h.debug).filter((line) => line.includes("clear at"))).toEqual([]);
    });

    it.each([1, 3])(
      "skips the past test with the class lap unknown (crossed %s s ago): the car is untimed, so traffic",
      (ago) => {
        const h = harness({ landmarks: curveLandmarks, ...lapUnknown() });

        h.depart(nearBlend([crossed(ago)]));

        expect(h.settled).toEqual([{ verdict: "traffic" }]);
        expect(lines(h.debug).at(-1)).toContain("untimed: car 5 (noClassLap)");
      },
    );

    it("tests only the next crossing of a car short of the blend with the class lap unknown", () => {
      const h = harness({ landmarks: curveLandmarks, ...lapUnknown() });

      // 10 s from the blend: +9.5 s, outside the window; no past crossing to test.
      h.depart(nearBlend([{ idx: 5, pct: 0.1675, est: 83.75 }]));

      expect(h.settled).toEqual([{ verdict: "clear", seconds: 9.5 }]);
    });
  });

  describe("an ETA longer than the car's class lap (every crossing in the window)", () => {
    /** Class 2 laps in 20 s and has no curve, so its class lap is its session lap time. */
    const SHORT_LAP = 2;
    /** Pit road 5 s at the limit plus 75.3 − 50 on to the blend: the player's ETA is 30.3 s. */
    const LONG_ETA: TrafficPitExitLandmarks = {
      pitRoadEnd: landmark(0.125, { [CLS]: 50 }),
      blendEnd: landmark(0.1875, { [CLS]: 75.3, [SHORT_LAP]: 40 }),
    };
    const classes: TrafficClassInfo = { lapTimeByClass: { [CLS]: 500, [SHORT_LAP]: 20 }, classByCarIdx: {} };
    /** A class-2 car whose next crossing of the blend is `next` s away: it crosses again every 20 s. */
    const shortLapCar = (next: number): Car => ({ idx: 5, pct: 0.05, est: 40 - next, cls: SHORT_LAP });

    it("is traffic for a car crossing at 10, 30 and 50 s with the player at 30.3 s: the crossing at −0.3 s", () => {
      const h = harness({ landmarks: LONG_ETA, classes });

      h.depart(tel({ cars: [shortLapCar(10)] }));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: -0.3 }]);
      expect(lines(h.debug).at(-1)).toContain("eta 30.30 s on pitRoad");
    });

    it("is clear when no crossing lands in the window, reporting the nearest of them", () => {
      const h = harness({ landmarks: LONG_ETA, classes });

      // Crossings at 3, 23, 43 s: −7.3 and +12.7 around the player, both outside.
      h.depart(tel({ cars: [shortLapCar(3)] }));

      expect(h.settled).toEqual([{ verdict: "clear", seconds: -7.3 }]);
    });
  });

  describe("a car standing still", () => {
    it("is left out: a car stopped short of the blend is not coming, however close its reference time", () => {
      const curves = learnedCurves();

      // Car 5 measured standing (rate 0) on the SessionTime this tick reads.
      curves.motion[5] = { fromPct: 0.05, fromTime: 100, rate: 0, rateAt: 100 };

      const h = harness({ curves });

      h.depart(tel({ cars: [arriving(5, 1)], SessionTime: 100 }));

      expect(h.settled).toEqual([{ verdict: "clear" }]);
      expect(lines(h.debug).at(-1)).toContain("untimed: none; standing still: car 5)");
    });

    it("counts as traffic until it has been measured: the cautious direction", () => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, 1)], SessionTime: 100 }));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });
  });

  describe("untimed cars", () => {
    it("make it traffic, never a false clear, even with every timed car outside the window", () => {
      const h = harness();
      const unknown: Car = { idx: 9, pct: 0.05, est: 40, cls: -1 };

      h.depart(tel({ cars: [unknown, arriving(5, 10)] }));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 10 }]);
      expect(lines(h.debug).at(-1)).toContain("untimed: car 9 (noClass)");
    });

    it("make it traffic with no seconds when they are the only cars", () => {
      const h = harness();

      h.depart(tel({ cars: [{ idx: 9, pct: 0.05, est: 40, cls: -1 }] }));

      expect(h.settled).toEqual([{ verdict: "traffic" }]);
    });
  });

  describe("missing per-car arrays", () => {
    it.each(["CarIdxEstTime", "CarIdxTrackSurface"] as const)(
      "without %s make no verdict, never a clear, log once, and keep evaluating",
      (field) => {
        const h = harness();
        const missing = tel({ [field]: undefined });

        h.depart(missing);
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, missing);

        expect(h.settled).toEqual([]);
        expect(h.episode.active).toBe(true);
        expect(lines(h.debug).filter((line) => line.includes("per-car arrays are missing"))).toHaveLength(1);

        // The arrays back with nobody on track: the first call, a clear.
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel());

        expect(h.settled).toEqual([{ verdict: "clear" }]);
      },
    );

    it("without CarIdxLapDistPct make no verdict, never a clear, log once, hold the episode and evaluate once it is back", () => {
      const h = harness();
      const missing = tel({ CarIdxLapDistPct: undefined });

      h.depart(missing);
      h.after(TRAFFIC_PIT_EXIT_POSITION_GRACE_MS / 2, missing);

      expect(h.settled).toEqual([]);
      expect(h.episode.active).toBe(true);
      expect(lines(h.debug).filter((line) => line.includes("player position unavailable"))).toHaveLength(1);

      // The array back with nobody on track: the first call, a clear.
      h.after(TRAFFIC_PIT_EXIT_POSITION_GRACE_MS / 4, tel());

      expect(h.settled).toEqual([{ verdict: "clear" }]);
    });

    it("say clear with complete arrays and no car on track", () => {
      const h = harness();

      h.depart(tel());

      expect(h.settled).toEqual([{ verdict: "clear" }]);
    });
  });

  describe("when the verdict settles (spoken past pitRoadEnd: below)", () => {
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

    it("settles once, on the departure tick, then not again while the verdict holds", () => {
      const h = harness();

      h.depart(rolling(0, 1));
      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);

      for (let s = 1; s <= 4; s++) h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, rolling(s, 1));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });

    it("settles the verdict at the departure with the merge 40 s away, and says nothing there (amended 2026-11-20)", () => {
      // 4,800 m: the 0.125 of the lap to pit road's end is 600 m, 30 s at the
      // limit, plus 60 − 50 on to the blend.
      const h = harness({ trackLengthMeters: 4800 });

      h.depart(tel({ pct: 0, cars: [{ idx: 5, pct: 0.05, est: 60 - 41 }] }));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(h.events).toEqual([]);
      expect(lines(h.debug).at(-1)).toContain(
        "traffic settled short of pitRoadEnd, not spoken yet (first verdict; eta 40.00 s on pitRoad",
      );
    });

    it("settles the first verdict at the first evaluation that can time the player, when the departure tick cannot", () => {
      let landmarks: TrafficPitExitLandmarks | null = null;
      const h = harness();

      h.readLandmarks.mockImplementation(() => landmarks);
      h.depart(tel({ cars: [arriving(5, 1)] }));
      expect(h.settled).toEqual([]);

      landmarks = LANDMARKS;
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 1)] }));

      expect(h.settled).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });

    it("evaluates once a second, not on every tick", () => {
      const h = harness();

      h.depart(rolling(0));
      expect(h.settled).toEqual([{ verdict: "clear" }]);

      // Traffic at one evaluation: held.
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, rolling(1, 0));
      expect(h.settled).toEqual([{ verdict: "clear" }]);

      // Not an evaluation, or it would be the second and spoken.
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS - 1, rolling(2, 0));
      expect(h.settled).toEqual([{ verdict: "clear" }]);

      h.after(1, rolling(2, 0));
      expect(h.settled).toEqual([{ verdict: "clear" }, { verdict: "traffic", seconds: 0 }]);
    });

    it("evaluates on the first tick after the wall clock steps back, then once a second from there", () => {
      const h = harness();

      h.depart(rolling(0));

      // 30 s back: an evaluation, the first of a flip to traffic.
      h.after(-30_000, rolling(1, 0));
      expect(lines(h.debug).at(-1)).toContain("traffic at 1 of 2 evaluations");

      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS - 1, rolling(2, 0));
      expect(h.settled).toEqual([{ verdict: "clear" }]);

      h.after(1, rolling(2, 0));
      expect(h.settled).toEqual([{ verdict: "clear" }, { verdict: "traffic", seconds: 0 }]);
    });

    it("settles again on a flip of the verdict that holds, and only then", () => {
      const h = harness();
      const step = (cars: Car[]): void => h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars }));

      h.depart(tel({ cars: [arriving(5, 3)] }));
      step([arriving(5, 3.5)]);
      step([arriving(5, 5)]);
      step([arriving(5, 6)]);
      step([arriving(5, -1)]);
      step([arriving(5, -1.5)]);

      expect(h.settled).toEqual([
        { verdict: "traffic", seconds: 3 },
        { verdict: "clear", seconds: 6 },
        { verdict: "traffic", seconds: -1.5 },
      ]);
    });

    describe("a flip is held until it has held for TRAFFIC_PIT_EXIT_FLIP_CONFIRM_EVALUATIONS evaluations", () => {
      const step = (h: ReturnType<typeof harness>, relative: number): void =>
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, relative)] }));

      it("is two evaluations in a row", () => {
        expect(TRAFFIC_PIT_EXIT_FLIP_CONFIRM_EVALUATIONS).toBe(2);
      });

      it.each([
        ["traffic", [3.9, 4.1, 3.9, 4.1, 3.9, 4.1]],
        ["clear", [4.1, 3.9, 4.1, 3.9, 4.1, 3.9]],
      ] as const)(
        "a car wobbling across the after edge (+4 s) never flips it: the first verdict, %s, stands",
        (first, wobble) => {
          const h = harness();

          h.depart(tel({ cars: [arriving(5, wobble[0])] }));

          for (const relative of wobble.slice(1)) step(h, relative);

          expect(h.settled).toEqual([{ verdict: first, seconds: wobble[0] }]);
        },
      );

      it("a sustained flip settles once, at its second evaluation", () => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 3)] }));
        step(h, 5);
        expect(h.settled).toEqual([{ verdict: "traffic", seconds: 3 }]);

        step(h, 5.5);
        step(h, 6);
        step(h, 7);

        expect(h.settled).toEqual([
          { verdict: "traffic", seconds: 3 },
          { verdict: "clear", seconds: 5.5 },
        ]);
      });

      it.each<[string, { landmarks?: null; telemetry?: Partial<TrafficPitExitTelemetry> }]>([
        ["the landmarks unlearned", { landmarks: null }],
        ["no ETA (no player class)", { telemetry: { CarIdxClass: undefined } }],
        ["the per-car arrays missing", { telemetry: { CarIdxEstTime: undefined } }],
      ])("an evaluation with no verdict (%s) breaks the row, so the flip needs two fresh evaluations", (_, gap) => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 3)] }));
        step(h, 5); // clear, 1 of 2

        if (gap.landmarks === null) h.readLandmarks.mockReturnValueOnce(null);

        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 5.5)], ...gap.telemetry }));
        step(h, 6); // clear, 1 of 2 again
        expect(h.settled).toEqual([{ verdict: "traffic", seconds: 3 }]);

        step(h, 6.5); // clear, 2 of 2: spoken
        expect(h.settled).toEqual([
          { verdict: "traffic", seconds: 3 },
          { verdict: "clear", seconds: 6.5 },
        ]);
      });

      it("a tick without the player's position makes no evaluation and leaves the row as it was", () => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 3)] }));
        step(h, 5); // clear, 1 of 2
        h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, tel({ cars: [arriving(5, 5.5)], CarIdxLapDistPct: undefined }));
        h.after(100, tel({ cars: [arriving(5, 5.5)] })); // clear, 2 of 2: spoken

        expect(h.settled).toEqual([
          { verdict: "traffic", seconds: 3 },
          { verdict: "clear", seconds: 5.5 },
        ]);
      });

      it("logs a held flip at debug, naming the verdict that still stands", () => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 3)] }));
        step(h, 5);

        expect(lines(h.debug).at(-1)).toBe("clear at 1 of 2 evaluations, traffic still stands");
      });

      it("a held flip whose debug line threw is not counted, so the next tick cannot confirm it early", () => {
        const h = harness();
        let thrown = false;

        h.depart(tel({ cars: [arriving(5, 3)] }));
        h.debug.mockImplementation((line) => {
          if (!thrown && line.includes("still stands")) {
            thrown = true;
            throw new Error("debug sink failed");
          }
        });

        // clear, 1 of 2: the hold's line throws, so the step fails.
        expect(() => step(h, 5)).toThrow("debug sink failed");
        // A tick later the evaluation runs again, `lastEvalAt` not having
        // moved: still 1 of 2, never the second.
        h.after(16, tel({ cars: [arriving(5, 5)] }));
        expect(h.settled).toEqual([{ verdict: "traffic", seconds: 3 }]);
        expect(lines(h.debug).at(-1)).toBe("clear at 1 of 2 evaluations, traffic still stands");

        step(h, 5.5); // clear, 2 of 2: spoken
        expect(h.settled).toEqual([
          { verdict: "traffic", seconds: 3 },
          { verdict: "clear", seconds: 5.5 },
        ]);
      });

      it("starts the count afresh in the next episode", () => {
        const h = harness();

        h.depart(tel({ cars: [arriving(5, 3)] }));
        step(h, 5);
        h.after(100, tel({ PlayerTrackSurface: TrkLoc.OnTrack }));
        h.after(100, IN_STALL);
        h.after(100, tel({ cars: [arriving(5, 1)] }));
        step(h, 5);

        expect(h.settled).toEqual([
          { verdict: "traffic", seconds: 3 },
          { verdict: "traffic", seconds: 1 },
        ]);
      });
    });

    it("settles again in the next episode", () => {
      const h = harness();

      h.depart(tel({ cars: [arriving(5, 1)] }));
      h.after(100, tel({ PlayerTrackSurface: TrkLoc.OnTrack }));
      h.after(100, IN_STALL);
      h.after(100, tel({ cars: [arriving(5, 1)] }));

      expect(h.settled).toEqual([
        { verdict: "traffic", seconds: 1 },
        { verdict: "traffic", seconds: 1 },
      ]);
    });
  });

  describe("speaking at the end of pit road (amended 2026-11-20)", () => {
    const step = (h: ReturnType<typeof harness>, t: TrafficPitExitTelemetry): void =>
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, t);

    it("is silent from the stall to pitRoadEnd, even with a verdict settled at every evaluation", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 1));

      for (const pct of [0.075, 0.1, 0.12, 0.124]) step(h, at(pct, 1));

      expect(h.episode.active).toBe(true);
      expect(h.events).toEqual([]);
    });

    it("speaks the verdict on crossing pitRoadEnd into the blend lane", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 1));
      step(h, at(0.1, 1));
      step(h, at(0.13, 1));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(lines(h.debug).at(-1)).toContain("emit traffic (first call; eta 28.75 s on blend");
    });

    it("speaks a clear at the crossing too", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 8));
      step(h, at(0.13, 8));

      expect(h.events).toEqual([{ verdict: "clear", seconds: 8 }]);
    });

    it("speaks at the crossing by position while OnPitRoad still reads true (a landmark learned a little early)", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 1));
      step(h, at(0.13, 1, { OnPitRoad: true }));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });

    it("speaks at the crossing by the road bit while the position still reads short of pitRoadEnd", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 1));
      step(h, at(0.12, 1));
      expect(h.events).toEqual([]);

      // Off pit road 8 m short of the learned line: the blend lane begins here.
      step(h, at(0.12, 1, { OnPitRoad: false }));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(lines(h.debug).at(-1)).toContain("on blend");
    });

    it("re-speaks a flip after the crossing once it holds", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 1));
      step(h, at(0.13, 1));
      step(h, at(0.14, 6));
      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);

      step(h, at(0.15, 6));

      expect(h.events).toEqual([
        { verdict: "traffic", seconds: 1 },
        { verdict: "clear", seconds: 6 },
      ]);
    });

    it("never speaks a flip before the crossing on its own: the crossing says the newer verdict, once", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 1));
      // Clear for two evaluations: the flip holds, unspoken.
      step(h, at(0.08, 6));
      step(h, at(0.1, 6));
      expect(h.events).toEqual([]);

      step(h, at(0.13, 6));

      expect(h.events).toEqual([{ verdict: "clear", seconds: 6 }]);
    });

    it("a flip first seen at the last evaluation before the crossing and holding at it is the verdict spoken", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 1));
      step(h, at(0.1, 1));
      step(h, at(0.12, 6)); // clear, 1 of 2

      step(h, at(0.13, 6)); // clear, 2 of 2, at the crossing

      expect(h.events).toEqual([{ verdict: "clear", seconds: 6 }]);
    });

    it("a flip first seen at the crossing is held like any flip: the settled verdict is spoken, the flip once it holds", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 1));
      step(h, at(0.1, 1.5));
      step(h, at(0.13, 6)); // clear, 1 of 2: traffic still stands

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1.5 }]);

      step(h, at(0.14, 6)); // clear, 2 of 2

      expect(h.events).toEqual([
        { verdict: "traffic", seconds: 1.5 },
        { verdict: "clear", seconds: 6 },
      ]);
    });

    it("a flip first seen at the crossing that does not hold is never heard", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 1));
      step(h, at(0.13, 6)); // clear, 1 of 2
      step(h, at(0.14, 1)); // traffic again

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });

    it("makes the first call at the crossing when the first verdict comes only there", () => {
      let landmarks: TrafficPitExitLandmarks | null = null;
      const h = harness();

      h.readLandmarks.mockImplementation(() => landmarks);
      h.depart(at(STALL_PCT, 1));
      step(h, at(0.1, 1));
      expect(h.events).toEqual([]);

      landmarks = CURVE_LANDMARKS;
      step(h, at(0.13, 1));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });

    it.each([
      ["unlearned", null],
      [
        "with a pitRoadEnd kept from before a track rebuild",
        { ...CURVE_LANDMARKS, pitRoadEnd: { ...CURVE_LANDMARKS.pitRoadEnd!, source: "previous" } },
      ],
      [
        "with a blendEnd kept from before a track rebuild",
        { ...CURVE_LANDMARKS, blendEnd: { ...CURVE_LANDMARKS.blendEnd!, source: "previous" } },
      ],
    ] satisfies Array<[string, TrafficPitExitLandmarks | null]>)(
      "makes no call across pitRoadEnd on a track %s",
      (_, landmarks) => {
        const h = harness({ landmarks });

        h.depart(at(STALL_PCT, 1));

        for (const pct of [0.1, 0.13, 0.15, 0.17]) step(h, at(pct, 1));

        expect(h.episode.active).toBe(true);
        expect(h.events).toEqual([]);
      },
    );

    it.each([
      ["the first call, at the crossing", 3, 1],
      ["a flip after it", 1, 2],
    ] as const)("%s whose emit threw keeps the spoken verdict, so the next tick speaks it", (_, flipAt, expected) => {
      const h = harness({ landmarks: CURVE_LANDMARKS });
      let thrown = false;

      h.depart(at(STALL_PCT, 3));

      if (flipAt === 1) {
        step(h, at(0.13, 3)); // the first call
        step(h, at(0.14, 5)); // clear, 1 of 2
      }

      h.debug.mockImplementation((line) => {
        if (!thrown && line.startsWith("emit")) {
          thrown = true;
          throw new Error("debug sink failed");
        }
      });

      // The emit's line throws, and the tick's step boundary drops the step's
      // event with it, as the splice here stands in for.
      const spokenBefore = h.episode.spokenVerdict;

      expect(() => step(h, flipAt === 1 ? at(0.15, 5.5) : at(0.13, 3))).toThrow("debug sink failed");
      h.events.splice(expected - 1);
      expect(h.episode.spokenVerdict).toBe(spokenBefore);

      // Retried on the next tick: still due, and spoken.
      h.after(16, flipAt === 1 ? at(0.15, 5.5) : at(0.13, 3));

      expect(h.events).toEqual(
        flipAt === 1
          ? [
              { verdict: "traffic", seconds: 3 },
              { verdict: "clear", seconds: 5.5 },
            ]
          : [{ verdict: "traffic", seconds: 3 }],
      );
      expect(h.episode.spokenVerdict).toBe(flipAt === 1 ? "clear" : "traffic");
    });

    it("speaks once through a position wobble at pitRoadEnd", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 1));
      step(h, at(0.126, 1, { OnPitRoad: true }));
      // Back a hair behind the line, then over it again, the road bit with it.
      step(h, at(0.1245, 1, { OnPitRoad: true }));
      step(h, at(0.126, 1, { OnPitRoad: true }));
      step(h, at(0.1255, 1, { OnPitRoad: false }));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });

    it("speaks once for a car rolled back behind pitRoadEnd after the call, and still re-speaks a flip that holds", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 1));
      step(h, at(0.13, 1));
      // Rolled back 16 m onto pit road, then out over the line again.
      step(h, at(0.12, 1, { OnPitRoad: true }));
      step(h, at(0.13, 1));
      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);

      // Behind the line again, where the flip to clear holds: still the blend lane's call.
      step(h, at(0.12, 6, { OnPitRoad: true }));
      step(h, at(0.12, 6, { OnPitRoad: true }));

      expect(h.events).toEqual([
        { verdict: "traffic", seconds: 1 },
        { verdict: "clear", seconds: 6 },
      ]);
    });
  });

  describe("a crossing between two scheduled evaluations", () => {
    /**
     * A blend lane of 0.008 of the 1,600 m lap, about 13 m: pit road ends at
     * 0.125 and the blend at 0.133, both on the curve (`T(pct) = 500 × pct`,
     * 66.5 s at the blend). At 60 km/h the player is through it in 0.8 s,
     * inside one evaluation interval.
     */
    const SHORT_BLEND: TrafficPitExitLandmarks = {
      pitRoadEnd: landmark(0.125, {}),
      blendEnd: landmark(0.133, {}),
    };

    /** The player at `pct` on the short blend lane's track, with car 5 arriving `relative` s after them. */
    const shortAt = (pct: number, relative: number, overrides: TickOptions = {}): TrafficPitExitTelemetry => {
      const onPitRoad = overrides.OnPitRoad ?? pct < 0.125;
      const eta = onPitRoad && pct < 0.125 ? (0.125 - pct) * 80 + 4 : 66.5 - 500 * pct;

      return tel({
        pct,
        OnPitRoad: onPitRoad,
        cars: [{ idx: 5, pct: 0.05, est: 66.5 - (eta + relative) }],
        ...overrides,
      });
    };

    /** Departs, then evaluates on schedule a hair short of pit road's end. */
    const toTheLine = (h: ReturnType<typeof harness>, relative: number): void => {
      h.depart(shortAt(STALL_PCT, relative));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, shortAt(0.1245, relative));
    };

    it("still speaks: the first tick past pitRoadEnd evaluates, whatever the interval", () => {
      const h = harness({ landmarks: SHORT_BLEND });

      toTheLine(h, 1);
      h.after(100, shortAt(0.1248, 1));
      expect(h.events).toEqual([]);

      h.after(100, shortAt(0.1255, 1));
      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);

      // Through the blend lane and onto the racing surface before the next
      // scheduled evaluation: nothing more.
      h.after(300, shortAt(0.13, 1));
      h.after(300, shortAt(0.1334, 1));
      h.after(100, shortAt(0.134, 1, { PlayerTrackSurface: TrkLoc.OnTrack }));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(h.episode.active).toBe(false);
    });

    it("still speaks when the crossing is the road bit alone", () => {
      const h = harness({ landmarks: SHORT_BLEND });

      toTheLine(h, 8);
      h.after(16, shortAt(0.1246, 8, { OnPitRoad: false }));

      expect(h.events).toEqual([{ verdict: "clear", seconds: 8 }]);
    });

    it("keeps the interval for the scheduled evaluations after it", () => {
      const h = harness({ landmarks: SHORT_BLEND });

      toTheLine(h, 1);
      h.after(200, shortAt(0.1255, 1));
      h.readLandmarks.mockClear();

      // The call is made: the ticks up to the next scheduled evaluation read nothing.
      h.after(400, shortAt(0.127, 6));
      h.after(399, shortAt(0.128, 6));
      expect(h.readLandmarks).not.toHaveBeenCalled();

      // Due a second after the last scheduled one, not after the crossing.
      h.after(1, shortAt(0.129, 6)); // clear, 1 of 2
      expect(h.readLandmarks).toHaveBeenCalledTimes(1);
      expect(lines(h.debug).at(-1)).toBe("clear at 1 of 2 evaluations, traffic still stands");
    });

    it("does not count toward a flip's hold: a flip one tick before it still needs a second scheduled evaluation", () => {
      const h = harness({ landmarks: SHORT_BLEND });

      h.depart(shortAt(STALL_PCT, 1));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, shortAt(0.1245, 6)); // clear, 1 of 2
      // The crossing 16 ms later still reads clear: not the second evaluation.
      h.after(16, shortAt(0.1255, 6));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(h.episode.flipVerdict).toBe("clear");
      expect(h.episode.flipEvaluations).toBe(1);

      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS - 16, shortAt(0.127, 6)); // clear, 2 of 2

      expect(h.events).toEqual([
        { verdict: "traffic", seconds: 1 },
        { verdict: "clear", seconds: 6 },
      ]);
    });

    it("neither breaks a flip's row: one back on the settled verdict leaves the flip pending", () => {
      const h = harness({ landmarks: SHORT_BLEND });

      h.depart(shortAt(STALL_PCT, 1));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, shortAt(0.1245, 6)); // clear, 1 of 2
      h.after(16, shortAt(0.1255, 1)); // traffic, off schedule

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(h.episode.flipVerdict).toBe("clear");
      expect(h.episode.flipEvaluations).toBe(1);
    });

    it("nor does one with no verdict, and the next tick that can still speaks", () => {
      const h = harness({ landmarks: SHORT_BLEND });

      h.depart(shortAt(STALL_PCT, 1));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, shortAt(0.1245, 6)); // clear, 1 of 2
      h.after(16, shortAt(0.1255, 6, { CarIdxEstTime: undefined })); // no per-car arrays

      expect(h.events).toEqual([]);
      expect(h.episode.flipVerdict).toBe("clear");
      expect(h.episode.flipEvaluations).toBe(1);

      // Still the settled verdict, the flip still pending.
      h.after(16, shortAt(0.1256, 6));
      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
      expect(h.episode.flipEvaluations).toBe(1);
    });

    it("settles and speaks the first verdict when there is none yet", () => {
      let landmarks: TrafficPitExitLandmarks | null = null;
      const h = harness();

      h.readLandmarks.mockImplementation(() => landmarks);
      toTheLine(h, 1);
      landmarks = SHORT_BLEND;
      h.after(100, shortAt(0.1255, 1));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });

    it("whose emit threw is retried on the next tick, not at the next scheduled evaluation", () => {
      const h = harness({ landmarks: SHORT_BLEND });
      let thrown = false;

      toTheLine(h, 1);
      h.debug.mockImplementation((line) => {
        if (!thrown && line.startsWith("emit")) {
          thrown = true;
          throw new Error("debug sink failed");
        }
      });

      expect(() => h.after(100, shortAt(0.1255, 1))).toThrow("debug sink failed");
      h.events.splice(0);
      h.after(16, shortAt(0.1258, 1));

      expect(h.events).toEqual([{ verdict: "traffic", seconds: 1 }]);
    });

    it("makes no evaluation on a track without both landmarks on its current geometry", () => {
      const h = harness({
        landmarks: { ...SHORT_BLEND, pitRoadEnd: { ...SHORT_BLEND.pitRoadEnd!, source: "previous" } },
      });

      toTheLine(h, 1);
      h.debug.mockClear();
      h.after(100, shortAt(0.1255, 1));
      h.after(100, shortAt(0.13, 1));

      expect(h.events).toEqual([]);
      expect(h.debug).not.toHaveBeenCalled();
    });
  });

  describe("the debug lines", () => {
    it("name the episode's start, the verdict settled short of pitRoadEnd, each emit with the ETA, the nearest car and its source, and the end", () => {
      const h = harness({ landmarks: CURVE_LANDMARKS });

      h.depart(at(STALL_PCT, 1.5));
      h.after(TRAFFIC_PIT_EXIT_EVAL_INTERVAL_MS, at(0.13, 1.5));
      h.after(100, tel({ PlayerTrackSurface: TrkLoc.OnTrack }));

      expect(lines(h.debug)).toEqual([
        "episode started (left the stall at pct=0.0625)",
        "traffic settled short of pitRoadEnd, not spoken yet (first verdict; eta 36.25 s on pitRoad, window -2/+4 s; nearest car 5 at 1.50 s via curve; untimed: none)",
        "emit traffic (first call; eta 28.75 s on blend, window -2/+4 s; nearest car 5 at 1.50 s via curve; untimed: none)",
        "episode ended (on the racing surface)",
      ]);
    });
  });
});
