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
  TRAFFIC_REJOIN_CRAWL_MPS,
  TRAFFIC_REJOIN_END_DWELL_MS,
  TRAFFIC_REJOIN_ENTRY_DWELL_MS,
  TRAFFIC_REJOIN_EVAL_INTERVAL_MS,
  TRAFFIC_REJOIN_MOVING_MPS,
  TRAFFIC_REJOIN_REANNOUNCE_DELTA_S,
  type TrafficRejoinTelemetry,
} from "./traffic-rejoin.js";

type Rejoin = SimEventMap["traffic.rejoin"]["data"];

const PLAYER = 0;
/** Class 1 (the player's): a 500 s reference lap, so bin `i` (pct `i / 500`) reads exactly `i` seconds. */
const FAST = 1;
/** Class 2: twice as slow, a 1,000 s lap, bin `i` reads `2i` seconds. */
const SLOW = 2;

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
  notice = 20,
  hold = 6,
  curves = learnedCurves(),
  classes = CLASSES as TrafficClassInfo | null,
}: { notice?: number; hold?: number; curves?: TrafficArrivalState; classes?: TrafficClassInfo | null } = {}) {
  const episode = createTrafficRejoinState();
  const events: Rejoin[] = [];
  const debug = vi.fn<(line: string) => void>();
  const logger: ILogger = { ...silentLogger, debug };
  const windows = { notice, hold };
  let now = 1_000_000;

  const tick = (t: TrafficRejoinTelemetry): void =>
    diffTrafficRejoin(
      episode,
      curves,
      t,
      PLAYER,
      classes,
      { getNoticeSeconds: () => windows.notice, getHoldSeconds: () => windows.hold },
      now,
      (ev) => events.push(ev.data),
      logger,
    );

  return {
    episode,
    events,
    debug,
    windows,
    get now() {
      return now;
    },
    tick,
    /** Ticks every 100 ms for `ms` (the first tick at the current time), leaving the clock after the last. */
    run(ms: number, t: TrafficRejoinTelemetry | ((at: number) => TrafficRejoinTelemetry)): void {
      const end = now + ms;

      for (; now <= end; now += 100) tick(typeof t === "function" ? t(now) : t);

      now = end;
    },
    /** Advances the clock to exactly `ms` later and ticks once. */
    after(ms: number, t: TrafficRejoinTelemetry): void {
      now += ms;
      tick(t);
    },
    /** Starts an episode: the dwell at a standstill, ending on the tick that starts it. */
    stop(t: TrafficRejoinTelemetry = tel()): void {
      tick(t);
      now += TRAFFIC_REJOIN_ENTRY_DWELL_MS;
      tick(t);
    },
  };
}

describe("diffTrafficRejoin", () => {
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

      expect(off.events).toEqual([{ verdict: "clear", windowSeconds: 20 }]);
      expect(unread.events).toEqual([{ verdict: "clear", windowSeconds: 20 }]);
    });

    it("starts after the green in a session winding down too (Checkered, CoolDown)", () => {
      for (const state of [SessionState.Checkered, SessionState.CoolDown]) {
        const h = harness();

        h.stop(tel({ SessionState: state }));

        expect(h.events, String(state)).toEqual([{ verdict: "clear", windowSeconds: 20 }]);
      }
    });

    it("ends the episode silently the moment a gate fails, and needs a fresh dwell after", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 15)] }));
      h.after(500, tel({ cars: [behind(5, 4)], IsOnTrack: false }));

      expect(h.episode.active).toBe(false);
      expect(h.events).toEqual([{ verdict: "notice", seconds: 15 }]);

      h.after(500, tel({ cars: [behind(5, 4)] }));
      h.after(TRAFFIC_REJOIN_ENTRY_DWELL_MS - 1, tel({ cars: [behind(5, 4)] }));
      expect(h.events).toHaveLength(1);

      h.after(1, tel({ cars: [behind(5, 4)] }));
      expect(h.events.at(-1)).toEqual({ verdict: "hold", seconds: 4 });
    });
  });

  describe("the entry dwell", () => {
    it("starts only once the car has crawled for the whole dwell, and speaks on the start", () => {
      const h = harness();

      h.tick(tel({ Speed: TRAFFIC_REJOIN_CRAWL_MPS - 0.01 }));
      h.after(TRAFFIC_REJOIN_ENTRY_DWELL_MS - 1, tel({ Speed: 1 }));
      expect(h.events).toEqual([]);

      h.after(1, tel({ Speed: 1 }));
      expect(h.events).toEqual([{ verdict: "clear", windowSeconds: 20 }]);
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

      expect(h.events).toEqual([
        { verdict: "clear", windowSeconds: 20 },
        { verdict: "clear", windowSeconds: 20 },
      ]);
    });
  });

  describe("the verdict table", () => {
    const cases: Array<[seconds: number, verdict: Rejoin]> = [
      [0, { verdict: "hold", seconds: 1 }],
      [6, { verdict: "hold", seconds: 6 }],
      [6.5, { verdict: "notice", seconds: 6 }],
      [7, { verdict: "notice", seconds: 7 }],
      [20, { verdict: "notice", seconds: 20 }],
      [20.5, { verdict: "clear", windowSeconds: 20 }],
      [45, { verdict: "clear", windowSeconds: 20 }],
    ];

    it.each(cases)("a car %s s away is %j (both window ends inclusive)", (seconds, expected) => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, seconds)] }));

      expect(h.events).toEqual([expected]);
    });

    it("says clear with the notice window when nobody is on track", () => {
      const h = harness({ notice: 35 });

      h.stop(tel({ cars: [] }));

      expect(h.events).toEqual([{ verdict: "clear", windowSeconds: 35 }]);
    });

    it("goes by the nearest car, whatever the order", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(9, 18), behind(3, 25), behind(5, 4.5)] }));

      expect(h.events).toEqual([{ verdict: "hold", seconds: 4 }]);
    });

    it("never counts a car in the pits or ahead of the player on the lap as close", () => {
      const h = harness();
      const inPits: Car = { ...behind(5, 3), surface: TrkLoc.InPitStall };
      const ahead: Car = { idx: 6, pct: 0.51, est: 255 };

      h.stop(tel({ cars: [inPits, ahead] }));

      expect(h.events).toEqual([{ verdict: "clear", windowSeconds: 20 }]);
    });

    it("clamps the hold window to the notice window", () => {
      const h = harness({ notice: 10, hold: 15 });

      h.stop(tel({ cars: [behind(5, 12)] }));

      // Unclamped, 12 s would be inside the 15 s hold window.
      expect(h.events).toEqual([{ verdict: "clear", windowSeconds: 10 }]);
    });

    it("reads the windows live at each evaluation", () => {
      const h = harness();
      const t = tel({ cars: [behind(5, 25)] });

      h.stop(t);
      h.windows.notice = 30;
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, t);

      expect(h.events).toEqual([
        { verdict: "clear", windowSeconds: 20 },
        { verdict: "notice", seconds: 25 },
      ]);
    });
  });

  describe("a two-class field", () => {
    it("times a slower class's car by its own class's curve, not the player's reference", () => {
      const h = harness({ curves: learnedCurves({ [FAST]: 1, [SLOW]: 2 }) });

      // 10 s behind on the slow class's curve; on the player's own reference
      // (250 s at P against its 490 s) it would read as already here.
      h.stop(tel({ cars: [behind(7, 10, SLOW)] }));

      expect(h.events).toEqual([{ verdict: "notice", seconds: 10 }]);
    });

    it("falls back to the player's reference scaled by the class lap ratio before the class has a curve", () => {
      const h = harness({ curves: learnedCurves({ [FAST]: 1 }) });

      // Scaled: 250 s × 1,000 / 500 = 500 s at P for the slow class.
      h.stop(tel({ cars: [behind(7, 10, SLOW)] }));

      expect(h.events).toEqual([{ verdict: "notice", seconds: 10 }]);
      expect(h.debug.mock.calls.flat().join("\n")).toContain("nearest car 7 at 10.00 s via scaled");
    });
  });

  describe("the rounding", () => {
    it.each([
      [4.9, { verdict: "hold", seconds: 4 }],
      [0.4, { verdict: "hold", seconds: 1 }],
      [6.9, { verdict: "notice", seconds: 6 }],
      [19.99, { verdict: "notice", seconds: 19 }],
    ] satisfies Array<[number, Rejoin]>)("a car %s s away speaks %j: down, never under the clip range", (s, e) => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, s)] }));

      expect(h.events).toEqual([e]);
    });

    it("never speaks a notice under 2 s, the clip range's bottom, even with the hold window at its smallest", () => {
      const h = harness({ hold: 1 });

      h.stop(tel({ cars: [behind(5, 1.5)] }));

      expect(h.events).toEqual([{ verdict: "notice", seconds: 2 }]);
    });

    it("speaks a fractional notice window rounded down in the clear line", () => {
      const h = harness({ notice: 20.7 });

      h.stop(tel());

      expect(h.events).toEqual([{ verdict: "clear", windowSeconds: 20 }]);
    });
  });

  describe("the re-announce rules", () => {
    it("evaluates once a second, not on every tick", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 25)] }));
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS - 1, tel({ cars: [behind(5, 15)] }));
      expect(h.events).toHaveLength(1);

      h.after(1, tel({ cars: [behind(5, 15)] }));
      expect(h.events.at(-1)).toEqual({ verdict: "notice", seconds: 15 });
    });

    it("says an unchanged verdict again only once the arrival has moved by the delta", () => {
      const h = harness();
      const step = (seconds: number): void =>
        h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [behind(5, seconds)] }));

      h.stop(tel({ cars: [behind(5, 18)] }));
      step(17);
      step(16);
      step(18 - TRAFFIC_REJOIN_REANNOUNCE_DELTA_S + 0.01);
      expect(h.events).toEqual([{ verdict: "notice", seconds: 18 }]);

      step(18 - TRAFFIC_REJOIN_REANNOUNCE_DELTA_S);
      step(14);
      step(13);
      step(12);
      expect(h.events).toEqual([
        { verdict: "notice", seconds: 18 },
        { verdict: "notice", seconds: 15 },
        { verdict: "notice", seconds: 12 },
      ]);
    });

    it("counts a growing arrival as a move too", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 5)] }));
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [behind(5, 2)] }));
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [behind(5, 5.5)] }));

      expect(h.events).toEqual([
        { verdict: "hold", seconds: 5 },
        { verdict: "hold", seconds: 2 },
        { verdict: "hold", seconds: 5 },
      ]);
    });

    it("never repeats a clear, however the traffic beyond the window moves", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 50)] }));
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [behind(5, 30)] }));
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [] }));

      expect(h.events).toEqual([{ verdict: "clear", windowSeconds: 20 }]);
    });

    it("speaks every verdict change", () => {
      const h = harness();
      const step = (cars: Car[]): void => h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars }));

      h.stop(tel({ cars: [behind(5, 25)] }));
      step([behind(5, 19)]);
      step([behind(5, 6)]);

      expect(h.events).toEqual([
        { verdict: "clear", windowSeconds: 20 },
        { verdict: "notice", seconds: 19 },
        { verdict: "hold", seconds: 6 },
      ]);
    });
  });

  describe("go after a hold", () => {
    /** The hold car has gone by: just past the player on the lap, a lap away from P again. */
    const passed: Car = { idx: 5, pct: 0.502, est: 251 };

    it("says go once the held car is by, then nothing while the table stays clear", () => {
      const h = harness();
      const step = (cars: Car[]): void => h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars }));

      h.stop(tel({ cars: [behind(5, 3)] }));
      step([behind(5, 1)]);
      step([passed]);
      step([passed]);
      step([]);

      expect(h.events).toEqual([{ verdict: "hold", seconds: 3 }, { verdict: "go" }]);
    });

    it("says go rather than the notice for a car still outside the hold window, then rejoins the table", () => {
      const h = harness();
      const step = (cars: Car[]): void => h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars }));

      h.stop(tel({ cars: [behind(5, 3), behind(6, 14)] }));
      step([passed, behind(6, 13)]);
      step([passed, behind(6, 12)]);
      step([passed, behind(6, 10.01)]);
      step([passed, behind(6, 10)]);

      expect(h.events).toEqual([
        { verdict: "hold", seconds: 3 },
        { verdict: "go" },
        // The baseline at go was the notice at 13 s: 10.01 s is no move yet, 10 s is.
        { verdict: "notice", seconds: 10 },
      ]);
    });

    it("speaks a later change of verdict after the go", () => {
      const h = harness();
      const step = (cars: Car[]): void => h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars }));

      h.stop(tel({ cars: [behind(5, 3)] }));
      step([passed]);
      step([passed, behind(6, 15)]);

      expect(h.events).toEqual([
        { verdict: "hold", seconds: 3 },
        { verdict: "go" },
        { verdict: "notice", seconds: 15 },
      ]);
    });

    it("says the next car inside the hold window when its arrival is a move, and goes after it", () => {
      const h = harness();
      const step = (cars: Car[]): void => h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars }));

      h.stop(tel({ cars: [behind(5, 1), behind(6, 5)] }));
      step([passed, behind(6, 4)]);
      step([passed, { idx: 6, pct: 0.502, est: 251 }]);

      expect(h.events).toEqual([{ verdict: "hold", seconds: 1 }, { verdict: "hold", seconds: 4 }, { verdict: "go" }]);
    });

    it("never says go without a hold before it", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 10)] }));
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [passed] }));

      expect(h.events).toEqual([
        { verdict: "notice", seconds: 10 },
        { verdict: "clear", windowSeconds: 20 },
      ]);
    });
  });

  describe("untimed cars", () => {
    /** A car with no class anywhere (no `CarIdxClass`, no session-info row): `noClass`. */
    const unknown: Car = { idx: 9, pct: 0.45, est: 225, cls: -1 };

    it("emit nothing when they are the only cars, logging once per episode with each reason", () => {
      const h = harness();

      h.stop(tel({ cars: [unknown] }));
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [unknown] }));
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [unknown] }));

      expect(h.events).toEqual([]);

      const withheld = h.debug.mock.calls.flat().filter((line) => line.includes("withheld"));

      expect(withheld).toEqual([
        "Rejoin: clear withheld by untimed cars: car 9 (noClass) (no timed car, notice 20 s)",
      ]);
    });

    it("withhold the clear when the timed cars are all beyond the notice window", () => {
      const h = harness();

      h.stop(tel({ cars: [unknown, behind(5, 40)] }));

      expect(h.events).toEqual([]);
    });

    it("leave the notice and the hold of timed cars alone", () => {
      const notice = harness();
      const hold = harness();

      notice.stop(tel({ cars: [unknown, behind(5, 12)] }));
      hold.stop(tel({ cars: [unknown, behind(5, 3)] }));

      expect(notice.events).toEqual([{ verdict: "notice", seconds: 12 }]);
      expect(hold.events).toEqual([{ verdict: "hold", seconds: 3 }]);
    });

    it("hold back the go, which says clear too, until they are timed or gone", () => {
      const h = harness();
      const passed: Car = { idx: 5, pct: 0.502, est: 251 };

      h.stop(tel({ cars: [behind(5, 2)] }));
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [passed, unknown] }));
      expect(h.events).toEqual([{ verdict: "hold", seconds: 2 }]);

      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [passed] }));
      expect(h.events).toEqual([{ verdict: "hold", seconds: 2 }, { verdict: "go" }]);
    });

    it("log again in the next episode", () => {
      const h = harness();

      h.stop(tel({ cars: [unknown] }));
      h.after(100, tel({ cars: [unknown], IsOnTrack: false }));
      h.stop(tel({ cars: [unknown] }));

      expect(h.debug.mock.calls.flat().filter((line) => line.includes("withheld"))).toHaveLength(2);
    });
  });

  describe("the debug lines", () => {
    it("name the episode's start and end and every emit's nearest car, seconds and source", () => {
      const h = harness();
      const moving = tel({ cars: [behind(5, 12)], Speed: 20 });

      h.stop(tel({ cars: [behind(5, 4.25)] }));
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [behind(5, 12)] }));
      h.after(100, moving);
      h.after(TRAFFIC_REJOIN_END_DWELL_MS, moving);

      expect(h.debug.mock.calls.flat()).toEqual([
        "Rejoin: episode started (pct=0.5000, speed=0.0 m/s)",
        "Rejoin: emit hold 4 s (nearest car 5 at 4.25 s via curve; verdict changed)",
        "Rejoin: emit go (nearest car 5 at 12.00 s via curve; table says notice)",
        "Rejoin: episode ended (moving at 20.0 m/s)",
      ]);
    });

    it("name the failed gate that ended an episode", () => {
      const h = harness();

      h.stop();
      h.after(100, tel({ OnPitRoad: true }));

      expect(h.debug.mock.calls.flat().at(-1)).toBe("Rejoin: episode ended (pitRoad)");
    });
  });
});
