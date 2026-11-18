import {
  type SimEventMap,
  TRAFFIC_REJOIN_CLEAR_S,
  TRAFFIC_REJOIN_OVER_TEN_S,
  TRAFFIC_REJOIN_RIGHT_BEHIND_S,
} from "@iracedeck/event-bus";
import { SessionState, TrkLoc } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { describe, expect, it, vi } from "vitest";

import {
  createTrafficArrivalState,
  createTrafficRejoinState,
  type TrafficArrivalState,
  type TrafficCurveBin,
} from "../state.js";
import {
  TRAFFIC_CRAWL_MPS,
  TRAFFIC_CURVE_BINS,
  type TrafficClassInfo,
  updateTrafficReferenceCurves,
} from "./traffic-arrival.js";
import {
  diffTrafficRejoin,
  TRAFFIC_REJOIN_COUNT_STEP_S,
  TRAFFIC_REJOIN_END_DWELL_MS,
  TRAFFIC_REJOIN_ENTRY_DWELL_MS,
  TRAFFIC_REJOIN_EVAL_INTERVAL_MS,
  TRAFFIC_REJOIN_GATE_GRACE_MS,
  TRAFFIC_REJOIN_MOVING_MPS,
  TRAFFIC_REJOIN_PACK_GAP_S,
  TRAFFIC_REJOIN_PASSED_RISE_S,
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
const PACK: Rejoin = { verdict: "pack" };
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

/** 25 km: the fast class's 500 s reference lap at 50 m/s, so a car at its reference pace covers 0.002 of the lap a second. */
const TRACK_M = 25_000;

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
  trackLengthMeters = TRACK_M as number | null,
}: { curves?: TrafficArrivalState; classes?: TrafficClassInfo | null; trackLengthMeters?: number | null } = {}) {
  const episode = createTrafficRejoinState();
  const events: Rejoin[] = [];
  const debug = vi.fn<(line: string) => void>();
  const logger: ILogger = { ...silentLogger, debug };
  let now = 1_000_000;

  const tick = (t: TrafficRejoinTelemetry): void =>
    diffTrafficRejoin(
      episode,
      curves,
      t,
      PLAYER,
      classes,
      trackLengthMeters,
      now,
      (ev) => events.push(ev.data),
      logger,
    );

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
    it("are the maintainer's fixed edges, the event-bus contract's, and count step (2026-11-11)", () => {
      expect([TRAFFIC_REJOIN_RIGHT_BEHIND_S, TRAFFIC_REJOIN_OVER_TEN_S, TRAFFIC_REJOIN_CLEAR_S]).toEqual([2, 10, 15]);
      expect(TRAFFIC_REJOIN_COUNT_STEP_S).toBe(3);
    });

    it("the pack gap is the maintainer's 2 s (amended 2026-11-18)", () => {
      expect(TRAFFIC_REJOIN_PACK_GAP_S).toBe(2);
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

    it("starts on the start/finish line read as 1.0000126, timing the cars to the line", () => {
      const h = harness();
      // The player on the line, its time already restarted; a car 0.01 of the
      // lap short of it (495 s) arrives in about 5 s (0.0063 − 495 + 500).
      const base = tel({ pct: 1.0000126, cars: [{ idx: 5, pct: 0.99, est: 495 }] });
      const onLine = {
        ...base,
        CarIdxEstTime: (base.CarIdxEstTime ?? []).map((est, idx) => (idx === PLAYER ? 0.0063 : est)),
      };

      h.stop(onLine);

      expect(h.episode.active).toBe(true);
      expect(h.events).toEqual([near(5, true)]);
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

      h.tick(tel({ Speed: TRAFFIC_CRAWL_MPS - 0.01 }));
      h.after(TRAFFIC_REJOIN_ENTRY_DWELL_MS - 1, tel({ Speed: 1 }));
      expect(h.events).toEqual([]);

      h.after(1, tel({ Speed: 1 }));
      expect(h.events).toEqual([CLEAR]);
      expect(h.episode.active).toBe(true);
    });

    it("restarts the dwell on a tick at the crawl speed or above", () => {
      const h = harness();

      h.tick(tel());
      h.after(1_000, tel({ Speed: TRAFFIC_CRAWL_MPS }));
      h.after(100, tel());
      h.after(TRAFFIC_REJOIN_ENTRY_DWELL_MS - 1, tel());
      expect(h.events).toEqual([]);

      h.after(1, tel());
      expect(h.events).toHaveLength(1);
    });

    it("never starts for a car driving through, however slowly it corners", () => {
      const h = harness();

      h.run(30_000, tel({ Speed: TRAFFIC_CRAWL_MPS + 1 }));

      expect(h.events).toEqual([]);
    });
  });

  describe("a gate failing mid-episode", () => {
    const blips: Array<[string, TickOptions]> = [
      ["a Speed dropout", { Speed: undefined }],
      ["a Speed read as NaN", { Speed: Number.NaN }],
      ["a surface flicker", { PlayerTrackSurface: TrkLoc.NotInWorld }],
      ["a lost lap position", { pct: -1 }],
      ["an OnPitRoad flicker", { OnPitRoad: true }],
      ["an unread SessionState", { SessionState: undefined }],
    ];

    it.each(blips)("keeps the episode through one tick of %s: no new episode, no repeated entry line", (_, blip) => {
      const h = harness();
      const cars = [behind(5, 12.5)];

      h.stop(tel({ cars }));
      h.after(100, tel({ cars, ...blip }));
      h.run(5_000, tel({ cars }));

      expect(h.events).toEqual([OVER_TEN]);
      expect(h.episode.active).toBe(true);
    });

    it("ends it once the failure has held for the grace, silently, and a fresh dwell starts the next", () => {
      const h = harness();
      const cars = [behind(5, 12.5)];
      const failing = tel({ cars, Speed: undefined });

      h.stop(tel({ cars }));
      h.after(100, failing);
      h.after(TRAFFIC_REJOIN_GATE_GRACE_MS - 1, failing);
      expect(h.episode.active).toBe(true);

      h.after(1, failing);
      expect(h.episode.active).toBe(false);
      expect(h.events).toEqual([OVER_TEN]);

      h.stop(tel({ cars }));
      expect(h.events).toEqual([OVER_TEN, OVER_TEN]);
    });

    it("counts the grace from the first failing tick, whichever gate fails after it", () => {
      const h = harness();

      h.stop();
      h.after(100, tel({ Speed: undefined }));
      h.after(TRAFFIC_REJOIN_GATE_GRACE_MS / 2, tel({ OnPitRoad: true }));
      h.after(TRAFFIC_REJOIN_GATE_GRACE_MS / 2, tel({ PlayerTrackSurface: TrkLoc.NotInWorld }));

      expect(h.episode.active).toBe(false);
    });

    it("restarts the grace once every gate holds again", () => {
      const h = harness();

      h.stop();
      h.after(100, tel({ Speed: undefined }));
      h.after(TRAFFIC_REJOIN_GATE_GRACE_MS - 100, tel());
      h.after(100, tel({ Speed: undefined }));
      h.after(TRAFFIC_REJOIN_GATE_GRACE_MS - 1, tel({ Speed: undefined }));

      expect(h.episode.active).toBe(true);
    });

    it.each([
      ["leaving the car", { IsOnTrack: false }],
      ["the garage", { IsInGarage: true }],
    ] satisfies Array<[string, TickOptions]>)("ends it at once on %s, with no grace", (_, gate) => {
      const h = harness();

      h.stop();
      h.after(100, tel(gate));

      expect(h.episode.active).toBe(false);
    });

    it("says nothing while a gate fails, and evaluates on the first tick the gates hold again", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 12.5)] }));
      // The car closes into near while the speed is unread: no evaluation.
      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [behind(5, 6.5)], Speed: undefined }));
      expect(h.events).toEqual([OVER_TEN]);

      h.after(100, tel({ cars: [behind(5, 6.4)] }));
      expect(h.events).toEqual([OVER_TEN, near(6, true)]);
    });
  });

  describe("the end, with hysteresis", () => {
    it("keeps the episode while the car creeps between the two speeds", () => {
      const h = harness();

      h.stop();
      h.run(10_000, tel({ Speed: (TRAFFIC_CRAWL_MPS + TRAFFIC_REJOIN_MOVING_MPS) / 2 }));

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

    it("restarts the end dwell after a gate blip: it needs a fresh full run of moving", () => {
      const h = harness();
      const moving = tel({ Speed: TRAFFIC_REJOIN_MOVING_MPS + 1 });

      h.stop();
      h.after(100, moving);
      // A Speed dropout at 1,500 ms, kept through the grace; moving again from 1,600.
      h.after(1_400, tel({ Speed: undefined }));
      h.after(100, moving);
      // 2,000 ms after the first moving tick, but only 500 ms into the renewed run.
      h.after(500, moving);
      expect(h.episode.active).toBe(true);

      h.after(TRAFFIC_REJOIN_END_DWELL_MS - 501, moving);
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

    it("evaluates on the first tick after the wall clock steps back, then once a second from there", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 12)] }));
      h.after(-30_000, tel({ cars: [behind(5, 8)] }));
      expect(h.events).toEqual([OVER_TEN, near(8, true)]);

      h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS - 1, tel({ cars: [behind(5, 5)] }));
      expect(h.events).toHaveLength(2);

      h.after(1, tel({ cars: [behind(5, 5)] }));
      expect(h.events.at(-1)).toEqual(near(5, false));
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
      // Car 6 comes out ahead of car 5 in arrival, more than the pack gap
      // ahead of it, so the two are not a pack: 7 is a drop of 2, 6 of 3.
      h.step([behind(5, 9.5), behind(6, 7.3)]);
      h.step([behind(5, 9.5), behind(6, 6.3)]);

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
      // Car 6 more than the pack gap behind car 5, so the two are not a pack.
      rightBehindNext.stop(tel({ cars: [behind(5, 1), behind(6, 3.5)] }));
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

  /**
   * A 13 s lap, shorter than the 15 s clear band (a short dirt oval): a car
   * that has gone by re-times as the lap less a second or so, never 15 s, so
   * it is known to have gone by only from its arrival rising.
   */
  describe("a lap shorter than the clear band", () => {
    const LAP_S = 13;
    const shortLap = (): ReturnType<typeof harness> =>
      harness({
        curves: learnedCurves({ [FAST]: LAP_S / TRAFFIC_CURVE_BINS }),
        classes: { lapTimeByClass: { [FAST]: LAP_S }, classByCarIdx: [] },
      });

    /** A car `seconds` from the player at 0.5 (6.5 s into the lap): behind it under 6.5 s, ahead of it round the line from there. */
    const coming = (idx: number, seconds: number): Car => {
      const est = (LAP_S / 2 - seconds + LAP_S) % LAP_S;

      return { idx, pct: est / LAP_S, est };
    };

    it("says the next car's close calls once the close car has gone by", () => {
      const h = shortLap();

      // Car 5 goes by between the fourth and fifth evaluations; car 6, a lap
      // behind it, follows it in and goes by too; car 5 comes round again.
      h.stop(tel({ cars: [coming(5, 3.5), coming(6, 8.2)] }));

      for (let i = 1; i <= 9; i++) {
        h.step([coming(5, (3.5 - i + LAP_S) % LAP_S), coming(6, (8.2 - i + LAP_S) % LAP_S)]);
      }

      expect(h.events).toEqual([
        near(3, true), // car 5 at 3.5
        RIGHT_BEHIND, // car 5 at 1.5
        near(4, true), // car 5 by, at 12.5 now; car 6 at 4.2, a new car coming
        RIGHT_BEHIND, // car 6 at 1.2
        near(7, true), // car 6 by; car 5 round again at 7.5
      ]);
    });

    it("says a lone close car again when it comes round again", () => {
      const h = shortLap();

      h.stop(tel({ cars: [coming(5, 3.5)] }));

      // 2.5 to 0.5, by, then 12.5 down to 1.5 on its next lap.
      for (let s = 2.5; s > 0; s--) h.step([coming(5, s)]);

      for (let s = 12.5; s > 1; s--) h.step([coming(5, s)]);

      expect(h.events).toEqual([
        near(3, true), // 3.5
        RIGHT_BEHIND, // 1.5
        OVER_TEN, // 12.5: by, so its band is said once, as for the next car
        near(9, true), // 9.5: a closer band
        near(6, false), // 6.5
        near(3, false), // 3.5
        RIGHT_BEHIND, // 1.5
      ]);
    });

    it("never says clear while a timed car is on the lap: every car is under 15 s away", () => {
      const h = shortLap();

      h.stop(tel({ cars: [coming(5, 12.5)] }));
      h.step([coming(5, 11.5)]);

      expect(h.events).toEqual([OVER_TEN]);
    });

    it("keeps a close car seen going by gone past a held-back line and missing arrays, until a line is said", () => {
      const h = shortLap();

      // Car 5 announced at 3.5; by at the next evaluation (12.5 now), whose
      // over ten the untimed car holds back.
      h.stop(tel({ cars: [coming(5, 3.5), unknown] }));
      h.step([coming(5, 12.5), unknown]);
      expect(h.events).toEqual([near(3, true)]);
      expect(h.episode.closeCarPassed).toBe(true);

      // No arrival times while car 5 comes round, so nothing is compared.
      for (let s = 11.5; s > 5; s--) {
        h.after(TRAFFIC_REJOIN_EVAL_INTERVAL_MS, tel({ cars: [coming(5, s), unknown], CarIdxEstTime: undefined }));
      }

      expect(h.events).toEqual([near(3, true)]);
      expect(h.episode.closeCarPassed).toBe(true);

      // Back at 4.5, only a second above the 3.5 it was announced at: still the
      // car gone by, so its new approach is a new car coming. Spoken, the
      // latch is consumed, and the count runs as usual from there.
      for (let s = 4.5; s > 1; s--) h.step([coming(5, s), unknown]);

      expect(h.events).toEqual([near(3, true), near(4, true), RIGHT_BEHIND]);
      expect(h.episode.closeCarPassed).toBe(false);
    });
  });

  describe("the close car's arrival rising", () => {
    it.each([
      ["by the margin or less is the same car still coming", TRAFFIC_REJOIN_PASSED_RISE_S, [near(5, true)]],
      ["by more than the margin is a car gone by", TRAFFIC_REJOIN_PASSED_RISE_S + 0.1, [near(5, true), near(7, true)]],
    ] satisfies Array<[string, number, Rejoin[]]>)("%s", (_, rise, expected) => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 5.5)] }));
      h.step([behind(5, 5.5 + rise)]);

      expect(h.events).toEqual(expected);
    });
  });

  /**
   * A pack is one call (amended 2026-11-18): Niklas, stopped at Tsukuba with
   * nine AI cars coming a second apart, heard "Car right behind you" nine
   * times, each car re-arming the after-a-close-car line for the next.
   */
  describe("a pack of cars", () => {
    /** Cars `idx0`, `idx0 + 1`, … `gap` s apart from `first` s away, `t` evaluations on; each by once it reaches the player. */
    const stream = (idx0: number, count: number, first: number, gap: number, t: number): Car[] =>
      Array.from({ length: count }, (_, k) => {
        const seconds = first + k * gap - t;

        return seconds > 0 ? behind(idx0 + k, seconds) : passed(idx0 + k);
      });

    it("is said once for nine cars a second apart, then once after the last of them (Tsukuba)", () => {
      const h = harness();
      const spokenAt: number[] = [];

      h.stop(tel({ cars: stream(1, 9, 9.2, 1, 0) }));

      for (let t = 1; t <= 20; t++) {
        const before = h.events.length;

        h.step(stream(1, 9, 9.2, 1, t));

        if (h.events.length > before) spokenAt.push(t);
      }

      // The ninth car, 17.2 s away on entry, goes by at the eighteenth evaluation.
      expect(h.events).toEqual([PACK, CLEAR]);
      expect(spokenAt).toEqual([18]);
      expect(h.debug.mock.calls.map(([line]) => String(line)).filter((l) => l.includes("emit"))).toEqual([
        "Rejoin: emit pack (9 cars, first at 9.20 s, last at 17.20 s; entry)",
        "Rejoin: emit clear (nearest car 1 at 499.00 s via curve; after a close car)",
      ]);
    });

    it("is two cars within the gap of each other, and not two cars further apart", () => {
      const pack = harness();
      const apart = harness();

      pack.stop(tel({ cars: [behind(5, 5), behind(6, 6.5)] }));
      pack.step([behind(5, 4), behind(6, 5.5)]);
      pack.step([behind(5, 1), behind(6, 2.5)]);
      pack.step([passed(5), behind(6, 1.5)]);
      pack.step([passed(5), passed(6)]);
      apart.stop(tel({ cars: [behind(5, 5), behind(6, 7.5)] }));
      apart.step([behind(5, 1.5), behind(6, 4)]);
      apart.step([passed(5), behind(6, 2.5)]);

      expect(pack.events).toEqual([PACK, CLEAR]);
      // Single-car lines: car 6 is the next car after car 5, a new car coming.
      expect(apart.events).toEqual([near(5, true), RIGHT_BEHIND, near(2, true)]);
    });

    it.each([
      ["at the gap is a pack", TRAFFIC_REJOIN_PACK_GAP_S, [PACK]],
      ["past it is not", TRAFFIC_REJOIN_PACK_GAP_S + 0.1, [near(4, true)]],
    ] satisfies Array<[string, number, Rejoin[]]>)("the second car %s", (_, gap, expected) => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 4.5), behind(6, 4.5 + gap)] }));

      expect(h.events).toEqual(expected);
    });

    it("chains: a car within the gap of the car before it joins, however far it is from the first", () => {
      const h = harness();

      // 3, 4.5, 6, 7.5: each 1.5 s behind the one before, 4.5 s from first to last.
      h.stop(tel({ cars: [behind(5, 3), behind(6, 4.5), behind(7, 6), behind(8, 7.5), behind(9, 12)] }));

      expect(h.events).toEqual([PACK]);
      expect(h.episode.packCars.map((car) => car.carIdx)).toEqual([5, 6, 7, 8]);
    });

    it("says nothing while it goes by: no count, no right behind, nothing for a car outside it", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 9.5), behind(6, 11)] }));
      h.step([behind(5, 6.5), behind(6, 8)]); // a drop of 3: a count for a lone car
      h.step([behind(5, 1.5), behind(6, 3)]); // right behind for a lone car
      // Car 7 out of the pits, closer than the pack, and car 5 by.
      h.step([passed(5), behind(6, 1.9), behind(7, 1)]);

      expect(h.events).toEqual([PACK]);
    });

    it.each([
      ["near", 8, 7, near(8, true)],
      ["right behind", 1.8, 1.5, RIGHT_BEHIND],
    ] satisfies Array<[string, number, number, Rejoin]>)(
      "forming behind a car already said as %s is said once, as a closer band",
      (_, entry, next, first) => {
        const h = harness();

        h.stop(tel({ cars: [behind(5, entry)] }));
        // Car 6 turns up 1.5 s behind car 5: a pack, though car 5's band has not moved.
        h.step([behind(5, next), behind(6, next + 1.5)]);
        h.step([passed(5), behind(6, 1)]);
        h.step([passed(5), passed(6)]);

        expect(h.events).toEqual([first, PACK, CLEAR]);
        expect(h.debug.mock.calls.map(([line]) => String(line)).filter((l) => l.includes("emit pack"))).toEqual([
          expect.stringContaining("; closer band)"),
        ]);
      },
    );

    it("grows while cars keep joining it, so it is not over while it is still streaming by", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 3), behind(6, 4.5)] }));
      // Car 7 turns up 1.5 s behind car 6, the last of the pack.
      h.step([behind(5, 2), behind(6, 3.5), behind(7, 5)]);
      h.step([passed(5), behind(6, 2), behind(7, 3.5)]);
      h.step([passed(5), passed(6), behind(7, 2.5)]); // the pack's first two by, car 7 still coming
      h.step([passed(5), passed(6), behind(7, 1)]);
      h.step([passed(5), passed(6), passed(7)]);

      expect(h.events).toEqual([PACK, CLEAR]);
      expect(h.episode.packCars).toEqual([]);
      expect(h.debug).toHaveBeenCalledWith("Rejoin: pack grows to 3 cars (car 7 at 5.00 s)");
    });

    it("is over when its cars have gone by or left the track, a car of it pitting included", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 3), behind(6, 4.5)] }));
      // Car 6, the last of the pack, turns into the pits; car 5 still coming.
      h.step([behind(5, 2), { ...behind(6, 3.5), surface: TrkLoc.InPitStall }]);
      h.step([passed(5), { ...behind(6, 3.5), surface: TrkLoc.InPitStall }]);

      expect(h.events).toEqual([PACK, CLEAR]);
    });

    it("is followed by the next car's own first call when a lone car comes after a gap", () => {
      const h = harness();

      // Cars 5 and 6 a pack, car 7 5 s behind car 6.
      h.stop(tel({ cars: [behind(5, 3), behind(6, 4), behind(7, 9)] }));

      for (let t = 1; t <= 4; t++) h.step([...stream(5, 2, 3, 1, t), behind(7, 9 - t)]);

      expect(h.events).toEqual([PACK, near(5, true)]);
    });

    it("is followed by a pack line again for the next group", () => {
      const h = harness();

      h.stop(tel({ cars: [...stream(5, 2, 3, 1, 0), ...stream(7, 3, 9, 1, 0)] }));

      for (let t = 1; t <= 4; t++) h.step([...stream(5, 2, 3, 1, t), ...stream(7, 3, 9, 1, t)]);

      expect(h.events).toEqual([PACK, PACK]);
    });

    it("is never made by an untimed car, and is said beside one: it is a warning", () => {
      const lone = harness();
      const withUntimed = harness();

      lone.stop(tel({ cars: [behind(5, 4), unknown] }));
      withUntimed.stop(tel({ cars: [behind(5, 4), behind(6, 5), unknown] }));

      expect(lone.events).toEqual([near(4, true)]);
      expect(withUntimed.events).toEqual([PACK]);
    });

    it("leaves the reassuring line after it to the untimed rule", () => {
      const h = harness();

      h.stop(tel({ cars: [behind(5, 2.5), behind(6, 3.5), unknown] }));
      h.step([passed(5), behind(6, 1), unknown]);
      h.step([passed(5), passed(6), unknown]); // clear, withheld
      h.step([passed(5), passed(6), unknown]);

      expect(h.events).toEqual([PACK]);
      expect(withheldLines(h.debug)).toHaveLength(1);

      h.step([passed(5), passed(6)]); // the untimed car gone

      expect(h.events).toEqual([PACK, CLEAR]);
    });

    /**
     * A 13 s lap (a short dirt oval): the first cars of a five-car pack re-time
     * as the lap less a second once by, and come round again under ten
     * seconds while the last of the pack is still coming.
     */
    it("on a lap shorter than it takes to go by, is not opened or said again by its own cars coming round", () => {
      const LAP_S = 13;
      const h = harness({
        curves: learnedCurves({ [FAST]: LAP_S / TRAFFIC_CURVE_BINS }),
        classes: { lapTimeByClass: { [FAST]: LAP_S }, classByCarIdx: [] },
      });
      /** Car `idx` `seconds` from the player at 0.5, wrapping round the lap once it has gone by. */
      const coming = (idx: number, seconds: number): Car => {
        const est = (LAP_S / 2 - seconds + LAP_S * 2) % LAP_S;

        return { idx, pct: est / LAP_S, est };
      };
      const pack = (t: number): Car[] =>
        Array.from({ length: 5 }, (_, k) => coming(5 + k, (((3.5 + k - t) % LAP_S) + LAP_S) % LAP_S));
      const spokenAt: number[] = [];

      h.stop(tel({ cars: pack(0) }));

      for (let t = 1; t <= 12; t++) {
        const before = h.events.length;

        h.step(pack(t));

        if (h.events.length > before) spokenAt.push(t);
      }

      // Car 5 by at t = 4 and back under ten seconds at t = 7, while car 9,
      // the last, goes by only at t = 8: nothing until then. From t = 8 the
      // five cars are coming round again together, the next group.
      expect(h.events).toEqual([PACK, PACK]);
      expect(spokenAt).toEqual([8]);
    });

    it("on a short lap a stream filling the lap is said once a lap: a car of it gone by never joins it again", () => {
      const LAP_S = 13;
      const h = harness({
        curves: learnedCurves({ [FAST]: LAP_S / TRAFFIC_CURVE_BINS }),
        classes: { lapTimeByClass: { [FAST]: LAP_S }, classByCarIdx: [] },
      });
      const coming = (idx: number, seconds: number): Car => {
        const est = (LAP_S / 2 - seconds + LAP_S * 2) % LAP_S;

        return { idx, pct: est / LAP_S, est };
      };
      // Twelve cars a second apart from 1.5 s: once the first is by, it
      // re-times at 12.5 s, within the gap behind the last, still coming at 10.5.
      const stream = (t: number): Car[] =>
        Array.from({ length: 12 }, (_, k) => coming(1 + k, (((1.5 + k - t) % LAP_S) + LAP_S) % LAP_S));
      const spokenAt: number[] = [];

      h.stop(tel({ cars: stream(0) }));

      for (let t = 1; t <= 14; t++) {
        const before = h.events.length;

        h.step(stream(t));

        if (h.events.length > before) spokenAt.push(t);
      }

      // The twelfth car, 12.5 s away on entry, goes by at t = 13: the pack is
      // over, and the stream coming round is the next group.
      expect(h.events).toEqual([PACK, PACK]);
      expect(spokenAt).toEqual([13]);
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

  describe("missing per-car arrays", () => {
    const missingLines = (debug: ReturnType<typeof vi.fn>): string[] =>
      debug.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("per-car arrays are missing"));

    it.each(["CarIdxEstTime", "CarIdxTrackSurface"] as const)(
      "without %s say nothing, never clear, mark nothing spoken and log once per episode",
      (field) => {
        const h = harness();
        const missing = tel({ [field]: undefined });

        h.stop(missing);
        h.run(3_000, missing);

        expect(h.events).toEqual([]);
        expect(h.episode.active).toBe(true);
        expect(h.episode.spokenBand).toBeNull();
        expect(missingLines(h.debug)).toHaveLength(1);
      },
    );

    it("hold the entry call until the arrays are back, then say it", () => {
      const h = harness();

      h.stop(tel({ CarIdxEstTime: undefined }));
      h.step([behind(5, 12)]);

      expect(h.events).toEqual([OVER_TEN]);
    });

    it("say clear with complete arrays and no car on track", () => {
      const h = harness();

      h.stop(tel());

      expect(h.events).toEqual([CLEAR]);
    });
  });

  /**
   * The cars' progress measured as the translator measures it: every tick
   * runs `updateTrafficReferenceCurves` over the same slice before the
   * detector, on a `SessionTime` that advances with the clock. A tick every
   * 125 ms, an exact binary fraction, so the time spans are exact and a motion
   * window is four ticks. `t` is seconds since the first tick. Every car below
   * is of the fast class and on its curve, so a sample folded in leaves the
   * curve where it was; on the 25 km track one second of its reference time
   * is 50 m.
   */
  describe("a car standing still behind the player", () => {
    const TICK_MS = 125;

    /** A fast-class car whose reference time is `est`: it arrives at the player's 0.5 in `250 − est` s. */
    const at = (idx: number, est: number): Car => ({ idx, pct: est / TRAFFIC_CURVE_BINS, est });

    function measured() {
      const curves = learnedCurves();
      const h = harness({ curves });
      let t = 0;

      return {
        h,
        /** Ticks on from the current time through `until` s, the cars where `carsAt` puts them at each tick. */
        drive(until: number, carsAt: (t: number) => Car[]): void {
          for (; t <= until; t += TICK_MS / 1000) {
            const tick = tel({ cars: carsAt(t), SessionTime: 1000 + t });

            updateTrafficReferenceCurves(curves, tick, CLASSES, TRACK_M);

            if (t === 0) h.tick(tick);
            else h.after(TICK_MS, tick);
          }
        },
      };
    }

    it("is left out, so a real car behind it gets its own call (the multi-car incident)", () => {
      const m = measured();

      // Car 4 stopped 5 m behind the player: 0.1 s away at reference pace, so
      // counted it would be right behind. Car 5 coming at reference pace,
      // 5.75 s away when the stop is recognised.
      m.drive(1.5, (t) => [at(4, 249.9), at(5, 250 - (7.25 - t))]);

      expect(m.h.events).toEqual([near(5, true)]);
      expect(m.h.debug.mock.calls.flat().at(-1)).toBe(
        "Rejoin: emit near 5 s (first) (nearest car 5 at 5.75 s via curve; entry; standing still: car 4)",
      );
    });

    it("is gone once a close car slows to a stop, and a new car coming once it moves again", () => {
      const m = measured();
      // Car 5 at reference pace from 8.25 s away, braking from t = 4 to a stop
      // at t = 6, 3.25 s away; moving again at reference pace from t = 9.
      const est = (t: number): number => {
        if (t <= 4) return 250 - 8.25 + t;

        if (t <= 6) return 245.75 + (t - 4) - (t - 4) ** 2 / 4;

        return t <= 9 ? 246.75 : 246.75 + (t - 9);
      };

      m.drive(11, (t) => [at(5, est(t))]);

      expect(m.h.events).toEqual([
        near(6, true), // 1.5: 6.75 s, the entry
        near(3, false), // 4.5: braking, 3.81 s, down 3
        CLEAR, // 6.5: stopped 3.25 s away, so gone by: the next car's band
        near(2, true), // 9.5: moving again, 2.75 s away, a new car coming
        RIGHT_BEHIND, // 10.5: 1.75 s
      ]);
    });

    it("counts as coming on the first tick it is read, before it has a rate: the cautious direction", () => {
      const m = measured();

      // Nobody until the stop is recognised; then car 4 appears, standing 5 m back.
      m.drive(2.5, (t) => (t < 1.5 ? [] : [at(4, 249.9)]));

      expect(m.h.events).toEqual([
        RIGHT_BEHIND, // 1.5: read once, no rate yet
        CLEAR, // 2.5: measured standing still, so gone by
      ]);
    });

    it("leaves no car out without a track length to judge its speed by", () => {
      const curves = learnedCurves();
      const h = harness({ curves, trackLengthMeters: null });

      for (let t = 0; t <= 1.5; t += TICK_MS / 1000) {
        const tick = tel({ cars: [at(4, 249.9)], SessionTime: 1000 + t });

        updateTrafficReferenceCurves(curves, tick, CLASSES, TRACK_M);

        if (t === 0) h.tick(tick);
        else h.after(TICK_MS, tick);
      }

      expect(h.events).toEqual([RIGHT_BEHIND]);
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

    it("name the failed gate that ended an episode, and a blip the episode was held through", () => {
      const h = harness();

      h.stop();
      h.after(100, tel({ Speed: undefined }));
      h.after(100, tel());
      h.after(100, tel({ OnPitRoad: true }));
      h.after(TRAFFIC_REJOIN_GATE_GRACE_MS, tel({ OnPitRoad: true }));

      expect(h.debug.mock.calls.flat().slice(-4)).toEqual([
        "Rejoin: gate failed (noSpeed), episode held",
        "Rejoin: gates hold again after 100 ms, episode kept",
        "Rejoin: gate failed (pitRoad), episode held",
        "Rejoin: episode ended (pitRoad)",
      ]);
    });
  });
});
