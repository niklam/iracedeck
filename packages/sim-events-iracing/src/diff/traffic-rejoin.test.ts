import type { SimEventMap } from "@iracedeck/event-bus";
import { SessionState, TrkLoc } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { describe, expect, it, vi } from "vitest";

import {
  createTrafficArrivalState,
  createTrafficRejoinState,
  type TrafficArrivalState,
  type TrafficCurveBin,
} from "../state.js";
import { TRAFFIC_CURVE_BINS, type TrafficClassInfo } from "./traffic-arrival.js";
import {
  diffTrafficRejoin,
  TRAFFIC_REJOIN_CLEAR_S,
  TRAFFIC_REJOIN_COUNT_STEP_S,
  TRAFFIC_REJOIN_CRAWL_MPS,
  TRAFFIC_REJOIN_END_DWELL_MS,
  TRAFFIC_REJOIN_ENTRY_DWELL_MS,
  TRAFFIC_REJOIN_EVAL_INTERVAL_MS,
  TRAFFIC_REJOIN_MOVING_MPS,
  TRAFFIC_REJOIN_OVER_TEN_S,
  TRAFFIC_REJOIN_RIGHT_BEHIND_S,
  type TrafficRejoinTelemetry,
} from "./traffic-rejoin.js";

type Rejoin = SimEventMap["traffic.rejoin"]["data"];

const PLAYER = 0;
/** Class 1 (the player's): a 500 s reference lap, so bin `i` (pct `i / 500`) reads exactly `i` seconds. */
const FAST = 1;
/** Class 2: twice as slow, a 1,000 s lap, bin `i` reads `2i` seconds. */
const SLOW = 2;

const CLEAR: Rejoin = { verdict: "clear" };
const OVER_TEN: Rejoin = { verdict: "overTen" };
const RIGHT_BEHIND: Rejoin = { verdict: "rightBehind" };
const near = (seconds: number, first: boolean): Rejoin => ({ verdict: "near", seconds, first });

/** A curve whose every bin holds one sample at the bin's start, `secondsPerBin` per bin: exact arithmetic. */
function curve(secondsPerBin: number): { bins: (TrafficCurveBin | null)[] } {
  return {
    bins: Array.from({ length: TRAFFIC_CURVE_BINS }, (_, i) => ({
      pct: i / TRAFFIC_CURVE_BINS,
      estTime: i * secondsPerBin,
      samples: 1,
    })),
  };
}

function learnedCurves(classes: Record<number, number> = { [FAST]: 1 }): TrafficArrivalState {
  const slice = createTrafficArrivalState();

  for (const [cls, perBin] of Object.entries(classes)) slice.curves[cls] = curve(perBin);

  return slice;
}

const CLASSES: TrafficClassInfo = { lapTimeByClass: { [FAST]: 500, [SLOW]: 1000 }, classByCarIdx: [] };

type Car = { idx: number; pct: number; est: number; cls?: number; surface?: number };

/** A car of class `cls` (default FAST) `seconds` behind the player at 0.5 on its own class's curve. */
function behind(idx: number, seconds: number, cls = FAST): Car {
  const perBin = cls === SLOW ? 2 : 1;
  const est = 250 * perBin - seconds;

  return { idx, pct: est / perBin / TRAFFIC_CURVE_BINS, est, cls };
}

/** Car `idx` gone by: just past the player on the lap, so its next arrival at P is a lap away. */
const passed = (idx: number): Car => ({ idx, pct: 0.502, est: 251 });

/** A car with no class anywhere (no `CarIdxClass`, no session-info row): untimed, `noClass`. */
const unknown: Car = { idx: 9, pct: 0.45, est: 225, cls: -1 };

type TickOptions = Partial<TrafficRejoinTelemetry> & { cars?: Car[]; pct?: number };

/** The player stopped at 0.5 on the racing surface, past the green, live in the car; 64 slots. */
function tel({ cars = [], pct = 0.5, ...overrides }: TickOptions = {}): TrafficRejoinTelemetry {
  const pcts = new Array<number>(64).fill(-1);
  const est = new Array<number>(64).fill(0);
  const surface = new Array<number>(64).fill(TrkLoc.NotInWorld);
  const cls = new Array<number>(64).fill(-1);

  pcts[PLAYER] = pct;
  est[PLAYER] = pct * 500;
  surface[PLAYER] = TrkLoc.OnTrack;
  cls[PLAYER] = FAST;

  for (const car of cars) {
    pcts[car.idx] = car.pct;
    est[car.idx] = car.est;
    surface[car.idx] = car.surface ?? TrkLoc.OnTrack;
    cls[car.idx] = car.cls ?? FAST;
  }

  return {
    IsOnTrack: true,
    IsInGarage: false,
    OnPitRoad: false,
    PlayerTrackSurface: TrkLoc.OnTrack,
    SessionState: SessionState.Racing,
    Speed: 0,
    CarIdxLapDistPct: pcts,
    CarIdxEstTime: est,
    CarIdxTrackSurface: surface,
    CarIdxClass: cls,
    ...overrides,
  };
}

function harness({
  curves = learnedCurves(),
  classes = CLASSES as TrafficClassInfo | null,
}: { curves?: TrafficArrivalState; classes?: TrafficClassInfo | null } = {}) {
  const episode = createTrafficRejoinState();
  const events: Rejoin[] = [];
  const debug = vi.fn<(line: string) => void>();
  const logger: ILogger = { ...silentLogger, debug };
  let now = 1_000_000;

  const tick = (t: TrafficRejoinTelemetry): void =>
    diffTrafficRejoin(episode, curves, t, PLAYER, classes, now, (ev) => events.push(ev.data), logger);

  return {
    episode,
    events,
    debug,
    tick,
    /** Ticks every 100 ms for `ms` (the first tick at the current time), leaving the clock after the last. */
    run(ms: number, t: TrafficRejoinTelemetry): void {
      const end = now + ms;

      for (; now <= end; now += 100) tick(t);

      now = end;
    },
    /** Advances the clock to exactly `ms` later and ticks once. */
    after(ms: number, t: TrafficRejoinTelemetry): void {
      now += ms;
      tick(t);
    },
    /** The next evaluation, a whole interval later, with `cars` on track. */
    step(cars: Car[]): void {
      now += TRAFFIC_REJOIN_EVAL_INTERVAL_MS;
      tick(tel({ cars }));
    },
    /** Starts an episode: the dwell at a standstill, ending on the tick that starts it. */
    stop(t: TrafficRejoinTelemetry = tel()): void {
      tick(t);
      now += TRAFFIC_REJOIN_ENTRY_DWELL_MS;
      tick(t);
    },
  };
}

const withheldLines = (debug: ReturnType<typeof vi.fn>): string[] =>
  debug.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("withheld"));

describe("diffTrafficRejoin", () => {
  describe("the band constants", () => {
    it("are the maintainer's fixed edges and count step (2026-11-11)", () => {
      expect([TRAFFIC_REJOIN_RIGHT_BEHIND_S, TRAFFIC_REJOIN_OVER_TEN_S, TRAFFIC_REJOIN_CLEAR_S]).toEqual([2, 10, 15]);
      expect(TRAFFIC_REJOIN_COUNT_STEP_S).toBe(3);
    });
  });

  describe("the entry gates", () => {
    const refused: Array<[string, TickOptions]> = [
      ["out of the car", { IsOnTrack: false }],
      ["IsOnTrack unread", { IsOnTrack: undefined }],
      ["in the garage", { IsInGarage: true }],
      ["in the pit stall", { PlayerTrackSurface: TrkLoc.InPitStall }],
      ["on the pit lane", { PlayerTrackSurface: TrkLoc.AproachingPits }],
      ["not in world", { PlayerTrackSurface: TrkLoc.NotInWorld }],
      ["surface unread", { PlayerTrackSurface: undefined }],
      ["on pit road", { OnPitRoad: true }],
      ["on the grid (GetInCar)", { SessionState: SessionState.GetInCar }],
      ["on the grid (Warmup)", { SessionState: SessionState.Warmup }],
      ["on the formation lap", { SessionState: SessionState.ParadeLaps }],
      ["session state invalid", { SessionState: SessionState.Invalid }],
      ["session state unread", { SessionState: undefined }],
      ["speed unread", { Speed: undefined }],
      ["speed not finite", { Speed: Number.NaN }],
      ["player not on the lap", { pct: -1 }],
    ];

    it.each(refused)("stays silent %s, however long the car stands", (_, overrides) => {
      const h = harness();

      h.run(10_000, tel({ cars: [behind(5, 4)], ...overrides }));

      expect(h.events).toEqual([]);
      expect(h.episode.active).toBe(false);
    });

    it("starts beside the track (OffTrack) as on it, and with OnPitRoad unread", () => {
      const off = harness();
      const unread = harness();

      off.stop(tel({ PlayerTrackSurface: TrkLoc.OffTrack }));
      unread.stop(tel({ OnPitRoad: undefined }));

      expect(off.events).toEqual([CLEAR]);
      expect(unread.events).toEqual([CLEAR]);
    });

    it("starts after the green in a session winding down too (Checkered, CoolDown)", () => {
      for (const state of [SessionState.Checkered, SessionState.CoolDown]) {
        const h = harness();

        h.stop(tel({ SessionState: state }));

        expect(h.events, String(state)).toEqual([CLEAR]);
      }
    });

    it("ends the episode silently the moment a gate fails, and needs a fresh dwell after", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 12)] }));
      h.after(500, tel({ cars: [behind(5, 4)], IsOnTrack: false }));

      expect(h.episode.active).toBe(false);
      expect(h.events).toEqual([OVER_TEN]);

      h.after(500, tel({ cars: [behind(5, 4)] }));
      h.after(TRAFFIC_REJOIN_ENTRY_DWELL_MS - 1, tel({ cars: [behind(5, 4)] }));
      expect(h.events).toHaveLength(1);

      h.after(1, tel({ cars: [behind(5, 4)] }));
      expect(h.events.at(-1)).toEqual(near(4, true));
    });
  });

  describe("the entry dwell", () => {
    it("starts only once the car has crawled for the whole dwell, and speaks on the start", () => {
      const h = harness();

      h.tick(tel({ Speed: TRAFFIC_REJOIN_CRAWL_MPS - 0.01 }));
      h.after(TRAFFIC_REJOIN_ENTRY_DWELL_MS - 1, tel({ Speed: 1 }));
      expect(h.events).toEqual([]);

      h.after(1, tel({ Speed: 1 }));
      expect(h.events).toEqual([CLEAR]);
      expect(h.episode.active).toBe(true);
    });

    it("restarts the dwell on a tick at the crawl speed or above", () => {
      const h = harness();

      h.tick(tel());
      h.after(1_000, tel({ Speed: TRAFFIC_REJOIN_CRAWL_MPS }));
      h.after(100, tel());
      h.after(TRAFFIC_REJOIN_ENTRY_DWELL_MS - 1, tel());
      expect(h.events).toEqual([]);

      h.after(1, tel());
      expect(h.events).toHaveLength(1);
    });

    it("never starts for a car driving through, however slowly it corners", () => {
      const h = harness();

      h.run(30_000, tel({ Speed: TRAFFIC_REJOIN_CRAWL_MPS + 1 }));

      expect(h.events).toEqual([]);
    });
  });

  describe("the end, with hysteresis", () => {
    it("keeps the episode while the car creeps between the two speeds", () => {
      const h = harness();

      h.stop();
      h.run(10_000, tel({ Speed: (TRAFFIC_REJOIN_CRAWL_MPS + TRAFFIC_REJOIN_MOVING_MPS) / 2 }));

      expect(h.episode.active).toBe(true);
    });

    it("ends once the car has been above the moving speed for the end dwell", () => {
      const h = harness();
      const moving = tel({ Speed: TRAFFIC_REJOIN_MOVING_MPS + 0.1 });

      h.stop();
      h.after(100, moving);
      h.after(TRAFFIC_REJOIN_END_DWELL_MS - 1, moving);
      expect(h.episode.active).toBe(true);

      h.after(1, moving);
      expect(h.episode.active).toBe(false);
    });

    it("restarts the end dwell when the car drops back to the moving speed or below", () => {
      const h = harness();
      const moving = tel({ Speed: TRAFFIC_REJOIN_MOVING_MPS + 1 });

      h.stop();
      h.after(100, moving);
      h.after(1_500, moving);
      h.after(100, tel({ Speed: TRAFFIC_REJOIN_MOVING_MPS }));
      h.after(100, moving);
      h.after(TRAFFIC_REJOIN_END_DWELL_MS - 1, moving);
      expect(h.episode.active).toBe(true);

      h.after(1, moving);
      expect(h.episode.active).toBe(false);
    });

    it("speaks again on the next stop, after a fresh dwell", () => {
      const h = harness();
      const moving = tel({ Speed: 30 });

      h.stop();
      h.after(100, moving);
      h.after(TRAFFIC_REJOIN_END_DWELL_MS, moving);
      h.stop();

      expect(h.events).toEqual([CLEAR, CLEAR]);
    });
  });

  describe("the bands, spoken on entry", () => {
    const cases: Array<[seconds: number, verdict: Rejoin]> = [
      [0, RIGHT_BEHIND],
      [0.4, RIGHT_BEHIND],
      [1.99, RIGHT_BEHIND],
      [2, near(2, true)],
      [4.9, near(4, true)],
      [6.5, near(6, true)],
      [9.99, near(9, true)],
      [10, OVER_TEN],
      [14.99, OVER_TEN],
      [15, CLEAR],
      [45, CLEAR],
    ];

    it.each(cases)("a car %s s away is %j (each band includes its lower edge)", (seconds, expected) => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, seconds)] }));

      expect(h.events).toEqual([expected]);
    });

    it("says clear when nobody is on track: silence never means clear", () => {
      const h = harness();

      h.stop(tel({ cars: [] }));

      expect(h.events).toEqual([CLEAR]);
    });

    it("goes by the nearest car, whatever the order", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(9, 18), behind(3, 25), behind(5, 4.5)] }));

      expect(h.events).toEqual([near(4, true)]);
    });

    it("never counts a car in the pits or ahead of the player on the lap as close", () => {
      const h = harness();
      const inPits: Car = { ...behind(5, 3), surface: TrkLoc.InPitStall };
      const ahead: Car = { idx: 6, pct: 0.51, est: 255 };

      h.stop(tel({ cars: [inPits, ahead] }));

      expect(h.events).toEqual([CLEAR]);
    });

    it("evaluates once a second, not on every tick", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 12)] }));
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS - 1, tel({ cars: [behind(5, 8)] }));
      expect(h.events).toEqual([OVER_TEN]);

      h.after(1, tel({ cars: [behind(5, 8)] }));
      expect(h.events).toEqual([OVER_TEN, near(8, true)]);
    });
  });

  describe("a car closing in", () => {
    it("is said on every closer band, and counted down in near by drops of 3", () => {
      const h = harness();

      // One second closer per evaluation, from 16.5 s to 0.5 s.
      h.stop(tel({ cars: [behind(5, 16.5)] }));

      for (let s = 15.5; s >= 0.5; s--) h.step([behind(5, s)]);

      expect(h.events).toEqual([
        CLEAR, // 16.5, entry
        OVER_TEN, // 14.5
        near(9, true), // 9.5: into near
        near(6, false), // 6.5: down 3 from 9; nothing at 8 or 7
        near(3, false), // 3.5: down 3 from 6
        RIGHT_BEHIND, // 1.5: a closer band; 2.5 was a drop of 1
      ]);
    });

    it("counts from the last spoken number, not the last evaluated one", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 9.9)] }));
      h.step([behind(5, 7.9)]);
      h.step([behind(5, 6.9)]);
      h.step([behind(5, 6.1)]);

      expect(h.events).toEqual([near(9, true), near(6, false)]);
    });

    it("says right behind from any farther band, and only once while it stays there", () => {
      const fromClear = harness();
      const fromNear = harness();

      fromClear.stop(tel({ cars: [behind(5, 30)] }));
      fromClear.step([behind(5, 1.5)]);
      fromClear.step([behind(5, 0.5)]);
      fromNear.stop(tel({ cars: [behind(5, 8)] }));
      fromNear.step([behind(5, 1.9)]);

      expect(fromClear.events).toEqual([CLEAR, RIGHT_BEHIND]);
      expect(fromNear.events).toEqual([near(8, true), RIGHT_BEHIND]);
    });

    it("says near as a first call when it comes from over ten or clear", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 20)] }));
      h.step([behind(5, 5)]);

      expect(h.events).toEqual([CLEAR, near(5, true)]);
    });
  });

  describe("a closer car taking over while near", () => {
    it("is counted by the same drop-by-3 rule", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 9.5)] }));
      // Car 6 comes out ahead of car 5 in arrival: 7 is a drop of 2, 6 of 3.
      h.step([behind(5, 8.5), behind(6, 7.5)]);
      h.step([behind(5, 7.5), behind(6, 6.5)]);

      expect(h.events).toEqual([near(9, true), near(6, false)]);
    });

    it("gets a count at once when it is 3 or more closer", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 9.5)] }));
      h.step([behind(5, 8.5), behind(6, 5.5)]);

      expect(h.events).toEqual([near(9, true), near(5, false)]);
    });

    it("hands the count back to the first car once the closer one has gone by, as a new car coming", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 9.5)] }));
      h.step([behind(5, 8.5), behind(6, 5.5)]);
      h.step([behind(5, 7.5), passed(6)]);

      expect(h.events).toEqual([near(9, true), near(5, false), near(7, true)]);
    });
  });

  describe("after a close car", () => {
    it("says clear once the near car is by, then nothing while it stays clear", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 3)] }));
      h.step([behind(5, 1)]);
      h.step([passed(5)]);
      h.step([passed(5)]);
      h.step([]);

      expect(h.events).toEqual([near(3, true), RIGHT_BEHIND, CLEAR]);
    });

    it("says over ten once for the next car, then nothing until it closes into near", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 4), behind(6, 14)] }));
      h.step([passed(5), behind(6, 13)]);
      h.step([passed(5), behind(6, 12)]);
      h.step([passed(5), behind(6, 10)]);
      h.step([passed(5), behind(6, 9)]);

      expect(h.events).toEqual([near(4, true), OVER_TEN, near(9, true)]);
    });

    it("says it once after right behind too", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 1)] }));
      h.step([passed(5), behind(6, 11)]);
      h.step([passed(5), behind(6, 10.5)]);

      expect(h.events).toEqual([RIGHT_BEHIND, OVER_TEN]);
    });

    it("says the next car's own close call when it is close too: a new car coming", () => {
      const nearNext = harness();
      const rightBehindNext = harness();

      nearNext.stop(tel({ cars: [behind(5, 3), behind(6, 8)] }));
      nearNext.step([passed(5), behind(6, 7)]);
      rightBehindNext.stop(tel({ cars: [behind(5, 1), behind(6, 2.5)] }));
      rightBehindNext.step([passed(5), behind(6, 1.5)]);

      expect(nearNext.events).toEqual([near(3, true), near(7, true)]);
      expect(rightBehindNext.events).toEqual([RIGHT_BEHIND, RIGHT_BEHIND]);
    });

    it("counts a close car that leaves the track as gone by", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 6)] }));
      h.step([{ ...behind(5, 5), surface: TrkLoc.InPitStall }]);

      expect(h.events).toEqual([near(6, true), CLEAR]);
    });
  });

  describe("a band moving away", () => {
    it("is not re-announced while the same close car is still coming", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 9.5)] }));
      // The arrival drifts out of near and back: the same car, not gone by.
      h.step([behind(5, 10.5)]);
      h.step([behind(5, 11)]);
      h.step([behind(5, 9.6)]);

      expect(h.events).toEqual([near(9, true)]);
    });

    it("is not re-announced when no close call came before it", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 12)] }));
      h.step([{ ...behind(5, 11), surface: TrkLoc.InPitStall }]);
      h.step([behind(6, 40)]);
      h.step([]);

      expect(h.events).toEqual([OVER_TEN]);
    });
  });

  describe("a two-class field", () => {
    it("times a slower class's car by its own class's curve, not the player's reference", () => {
      const h = harness({ curves: learnedCurves({ [FAST]: 1, [SLOW]: 2 }) });

      // 8 s behind on the slow class's curve; on the player's own reference
      // (250 s at P against its 492 s) it would read as already here.
      h.stop(tel({ cars: [behind(7, 8, SLOW)] }));

      expect(h.events).toEqual([near(8, true)]);
    });

    it("falls back to the player's reference scaled by the class lap ratio before the class has a curve", () => {
      const h = harness({ curves: learnedCurves({ [FAST]: 1 }) });

      // Scaled: 250 s × 1,000 / 500 = 500 s at P for the slow class.
      h.stop(tel({ cars: [behind(7, 12, SLOW)] }));

      expect(h.events).toEqual([OVER_TEN]);
      expect(h.debug.mock.calls.flat().join("\n")).toContain("nearest car 7 at 12.00 s via scaled");
    });

    it("goes by the nearest arrival across classes, not the nearest position", () => {
      const h = harness({ curves: learnedCurves({ [FAST]: 1, [SLOW]: 2 }) });

      // The slow car sits closer on the lap (0.490 against 0.488) but arrives
      // in 10 s at its own pace; the fast car, farther back, in 6 s.
      h.stop(tel({ cars: [behind(7, 10, SLOW), behind(5, 6)] }));

      expect(h.events).toEqual([near(6, true)]);
    });
  });

  describe("untimed cars", () => {
    it("emit nothing when they are the only cars, logging once per episode with each reason", () => {
      const h = harness();

      h.stop(tel({ cars: [unknown] }));
      h.step([unknown]);
      h.step([unknown]);

      expect(h.events).toEqual([]);
      expect(withheldLines(h.debug)).toEqual([
        "Rejoin: clear withheld by untimed cars: car 9 (noClass) (no timed car; entry)",
      ]);
    });

    it.each([
      ["over ten", 12],
      ["clear", 40],
    ])("withhold %s for the timed cars", (_, seconds) => {
      const h = harness();

      h.stop(tel({ cars: [unknown, behind(5, seconds)] }));

      expect(h.events).toEqual([]);
    });

    it("leave near and right behind of timed cars alone", () => {
      const nearCar = harness();
      const rightBehind = harness();

      nearCar.stop(tel({ cars: [unknown, behind(5, 7)] }));
      rightBehind.stop(tel({ cars: [unknown, behind(5, 1)] }));

      expect(nearCar.events).toEqual([near(7, true)]);
      expect(rightBehind.events).toEqual([RIGHT_BEHIND]);
    });

    it("hold back the line after a close car until they are timed or gone", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 2)] }));
      h.step([passed(5), unknown]);
      h.step([passed(5), unknown]);
      expect(h.events).toEqual([near(2, true)]);

      h.step([passed(5)]);
      expect(h.events).toEqual([near(2, true), CLEAR]);
    });

    it("hold back the entry call until it can be said, and a timed car's near is said as the entry", () => {
      const h = harness();

      h.stop(tel({ cars: [unknown] }));
      h.step([unknown, behind(5, 12)]);
      h.step([unknown, behind(5, 8)]);

      expect(h.events).toEqual([near(8, true)]);
    });

    it("log again in the next episode", () => {
      const h = harness();

      h.stop(tel({ cars: [unknown] }));
      h.after(100, tel({ cars: [unknown], IsOnTrack: false }));
      h.stop(tel({ cars: [unknown] }));

      expect(withheldLines(h.debug)).toHaveLength(2);
    });
  });

  describe("the debug lines", () => {
    it("name the episode's start and end and every emit's band, nearest car, seconds, source and reason", () => {
      const h = harness();
      const moving = tel({ cars: [passed(5)], Speed: 20 });

      h.stop(tel({ cars: [behind(5, 4.25)] }));
      h.step([behind(5, 0.5)]);
      h.step([passed(5)]);
      h.after(100, moving);
      h.after(TRAFFIC_REJOIN_END_DWELL_MS, moving);

      expect(h.debug.mock.calls.flat()).toEqual([
        "Rejoin: episode started (pct=0.5000, speed=0.0 m/s)",
        "Rejoin: emit near 4 s (first) (nearest car 5 at 4.25 s via curve; entry)",
        "Rejoin: emit rightBehind (nearest car 5 at 0.50 s via curve; closer band)",
        "Rejoin: emit clear (nearest car 5 at 499.00 s via curve; after a close car)",
        "Rejoin: episode ended (moving at 20.0 m/s)",
      ]);
    });

    it("name a count as such", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 9)] }));
      h.step([behind(5, 6)]);

      expect(h.debug.mock.calls.flat().at(-1)).toBe(
        "Rejoin: emit near 6 s (count) (nearest car 5 at 6.00 s via curve; count)",
      );
    });

    it("name the failed gate that ended an episode", () => {
      const h = harness();

      h.stop();
      h.after(100, tel({ OnPitRoad: true }));

      expect(h.debug.mock.calls.flat().at(-1)).toBe("Rejoin: episode ended (pitRoad)");
    });
  });
});
