/**
 * The sector timer (issue #1572), fed hand-built progress ticks for synthetic
 * cars with a known speed profile, so every expected time is arithmetic.
 */
import { type StandingsNeighbors, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import {
  createInitialState,
  createSectorTimesState,
  resetSectorTimesForReplay,
  type SectorLap,
  type SectorTimesState,
} from "../state.js";
import type { UnitRunner } from "../tick-steps.js";
import type { CarProgressTick } from "./car-progress.js";
import { diffSectorTimes, SECTOR_HISTORY_LAPS, SECTOR_MAX_TICK_SPAN_S } from "./sector-times.js";

/** Three sectors of 25 %, 35 % and 40 % of the lap. */
const STARTS = [0, 0.25, 0.6];
/** The synthetic car's lap time (s): sectors of 20, 28 and 32 s at constant speed. */
const LAP_S = 80;
/** The tick interval the drives use (s): under the timer's span bound. */
const DT = 0.1;

type FeedOptions = {
  /** `previousSessionTime` of the tick; default the time of the tick fed before it. */
  previous?: number | null;
  /** Per-car `traceReset`; default none. */
  reset?: boolean[];
  /** `null` = the track has no sectors. Default the feeder's. */
  starts?: readonly number[] | null;
  /** `CarIdxTrackSurface`; `null` = the array is missing. Default every car `OnTrack`. */
  surface?: number[] | null;
  caution?: boolean;
  neighbours?: StandingsNeighbors | null;
  runUnit?: UnitRunner;
};

type Feeder = {
  /** Feed one tick. */
  (sessionTime: number, progress: (number | null)[], options?: FeedOptions): void;
  /** Feed a tick the progress step read nothing on. */
  none(neighbours?: StandingsNeighbors | null): void;
};

/** A feeder over one slice that chains `previousSessionTime` as `stepCarProgress` does. */
function feeder(slice: SectorTimesState, starts: readonly number[] | null = STARTS): Feeder {
  let last: number | null = null;

  const feed = ((sessionTime, progress, options = {}) => {
    const tick: CarProgressTick = {
      sessionTime,
      previousSessionTime: "previous" in options ? (options.previous ?? null) : last,
      progress,
      traceReset: options.reset ?? progress.map(() => false),
      traces: [],
    };
    const surface = options.surface === null ? undefined : (options.surface ?? progress.map(() => TrkLoc.OnTrack));

    diffSectorTimes(
      slice,
      tick,
      options.starts === undefined ? starts : options.starts,
      surface,
      options.caution ?? false,
      options.neighbours ?? null,
      options.runUnit,
    );
    last = sessionTime;
  }) as Feeder;

  feed.none = (neighbours = null) => {
    diffSectorTimes(slice, null, starts, undefined, false, neighbours);
    last = null;
  };

  return feed;
}

/**
 * Drive car 0 at constant speed from `from` to `to` (progress, laps),
 * starting at `sessionTime`, one tick every {@link DT}. `at(n, progress)` may
 * return the options of tick `n`, or a replacement tick to feed in its place
 * (`skip`). Returns the `SessionTime` of the last tick.
 */
function drive(
  feed: Feeder,
  from: number,
  to: number,
  sessionTime: number,
  at: (n: number, progress: number) => FeedOptions | undefined = () => undefined,
): number {
  const ticks = Math.round(((to - from) * LAP_S) / DT);

  for (let n = 0; n <= ticks; n++) {
    const progress = from + ((to - from) * n) / ticks;

    feed(sessionTime + n * DT, [progress], at(n, progress));
  }

  return sessionTime + ticks * DT;
}

const laps = (slice: SectorTimesState, carIdx = 0): readonly SectorLap[] => slice.completedLaps[carIdx] ?? [];

/** The one tick of a drive nearest `progress`: the hook a mid-lap fault is planted on. */
const near =
  (target: number, options: FeedOptions) =>
  (_n: number, progress: number): FeedOptions | undefined =>
    Math.abs(progress - target) < 0.0001 ? options : undefined;

function expectTimes(lap: SectorLap | undefined, expected: number[]): void {
  expect(lap).toBeDefined();
  expect(lap!.sectorTimes).toHaveLength(expected.length);

  expected.forEach((time, i) => expect(lap!.sectorTimes[i]).toBeCloseTo(time, 6));
}

describe("diffSectorTimes: crossings", () => {
  it("gives a constant-speed lap its exact sector times", () => {
    const slice = createSectorTimesState();

    drive(feeder(slice), 1.99, 3.01, 500);

    expect(laps(slice)).toHaveLength(1);
    expectTimes(laps(slice)[0], [20, 28, 32]);
    expect(laps(slice)[0]).toMatchObject({ lap: 3, clean: true });
  });

  it("interpolates a crossing inside the tick pair that brackets it", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);

    feed(100, [1.9995]);
    // The line (2.0) is a quarter of the way through the step.
    feed(100.1, [2.0015]);

    expect(slice.lapInProgress[0]).toEqual({ lap: 3, crossings: [expect.closeTo(100.025, 9)], clean: true });
  });

  it("counts a boundary the car lands exactly on once, on the tick it lands", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);

    feed(100, [1.9]);
    feed(100.1, [2]);
    feed(100.2, [2.1]);

    expect(slice.lapInProgress[0]).toEqual({ lap: 3, crossings: [expect.closeTo(100.1, 9)], clean: true });
  });

  it("handles a step across two boundaries, each at its own time, in order", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice, [0, 0.5, 0.501]);

    feed(100, [1.999]);
    feed(100.1, [2.001]);
    feed(100.2, [2.4995]);
    // 2.5 is a quarter and 2.501 three quarters of the way through this step.
    feed(100.3, [2.5015]);

    expect(slice.lapInProgress[0]?.crossings).toEqual([
      expect.closeTo(100.05, 9),
      expect.closeTo(100.225, 9),
      expect.closeTo(100.275, 9),
    ]);
  });

  it("handles a step that crosses a sector start and the line", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice, [0, 0.9]);

    feed(100, [1.95]);
    feed(100.1, [2.05]);
    feed(100.2, [2.85]);
    // 2.9 at a quarter, the line (3.0) at three quarters.
    feed(100.3, [3.05]);

    expectTimes(laps(slice)[0], [100.225 - 100.05, 100.275 - 100.225]);
    expect(slice.lapInProgress[0]).toEqual({ lap: 4, crossings: [expect.closeTo(100.275, 9)], clean: true });
  });

  it("closes one lap and opens the next at the same interpolated line crossing", () => {
    const slice = createSectorTimesState();

    drive(feeder(slice), 1.99, 4.01, 500);

    expect(laps(slice).map((lap) => lap.lap)).toEqual([3, 4]);
    expectTimes(laps(slice)[0], [20, 28, 32]);
    expectTimes(laps(slice)[1], [20, 28, 32]);

    // 0.01 lap to the first line, then two whole laps: no time lost or doubled at the line between them.
    const opened = 500 + 0.01 * LAP_S;

    expect(slice.lapInProgress[0]?.crossings[0]).toBeCloseTo(opened + 2 * LAP_S, 6);
  });

  it("times a one-sector track's lap as its single sector", () => {
    const slice = createSectorTimesState();

    drive(feeder(slice, [0]), 1.99, 3.01, 500);

    expectTimes(laps(slice)[0], [80]);
  });

  it("times each car on its own", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);

    // Car 1 runs half a lap behind car 0 at the same speed.
    for (let n = 0; n <= 1700; n++) {
      const progress = 1.99 + n / (LAP_S / DT);

      feed(500 + n * DT, [progress, progress - 0.5]);
    }

    expect(laps(slice, 0).map((lap) => lap.lap)).toEqual([3, 4]);
    expect(laps(slice, 1).map((lap) => lap.lap)).toEqual([3]);
    expectTimes(laps(slice, 1)[0], [20, 28, 32]);
  });
});

describe("diffSectorTimes: lap numbering", () => {
  it("numbers a lap with the car's completed-lap count once it is done", () => {
    const slice = createSectorTimesState();

    // Progress 6.99 → 8.01: the lap from 7 to 8, after which the car has completed 8.
    drive(feeder(slice), 6.99, 8.01, 500);

    expect(laps(slice).map((lap) => lap.lap)).toEqual([8]);
    expect(slice.lapInProgress[0]?.lap).toBe(9);
  });

  it("opens no lap before a line crossing, so a car first read mid-lap records from the next line on", () => {
    const slice = createSectorTimesState();

    // First read at 2.3: the crossings of 2.6 are discarded, lap 3 is never
    // recorded, and lap 4 (3.0 → 4.0) is.
    drive(feeder(slice), 2.3, 4.01, 500);

    expect(laps(slice).map((lap) => lap.lap)).toEqual([4]);
  });
});

describe("diffSectorTimes: breaks in continuity", () => {
  // Every case drives 1.99 → 4.01 and plants its fault mid-lap 3 (at 2.4):
  // lap 3 is dropped, the rest of it discarded, and lap 4 recorded. The
  // control is the same drive with no fault.
  it("records both laps of the fixture without a fault (the control)", () => {
    const slice = createSectorTimesState();

    drive(feeder(slice), 1.99, 4.01, 500);

    expect(laps(slice).map((lap) => lap.lap)).toEqual([3, 4]);
  });

  it.each<[string, FeedOptions]>([
    ["a trace reset", { reset: [true] }],
    ["a previousSessionTime that is not the tick the timer last consumed", { previous: 123 }],
    ["a tick that names no previous tick", { previous: null }],
  ])("drops the lap on %s, and records the lap after the next line", (_name, fault) => {
    const slice = createSectorTimesState();

    drive(feeder(slice), 1.99, 4.01, 500, near(2.4, fault));

    expect(laps(slice).map((lap) => lap.lap)).toEqual([4]);
    expectTimes(laps(slice)[0], [20, 28, 32]);
  });

  it("drops the lap on a null reading, and records the lap after the next line", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);
    const ticks = Math.round((2.02 * LAP_S) / DT);

    for (let n = 0; n <= ticks; n++) {
      const progress = 1.99 + (2.02 * n) / ticks;

      feed(500 + n * DT, [Math.abs(progress - 2.4) < 0.0001 ? null : progress]);
    }

    expect(laps(slice).map((lap) => lap.lap)).toEqual([4]);
  });

  it("drops the lap on a tick pair further apart than the span bound, and keeps one just inside it", () => {
    const run = (gap: number): readonly SectorLap[] => {
      const slice = createSectorTimesState();
      const feed = feeder(slice);

      // To mid-lap 3, then one wide pair, then on at the same speed.
      const paused = drive(feed, 1.99, 2.4, 500);

      drive(feed, 2.4 + gap / LAP_S, 4.01, paused + gap);

      return laps(slice);
    };

    expect(SECTOR_MAX_TICK_SPAN_S).toBe(0.25);
    expect(run(SECTOR_MAX_TICK_SPAN_S - 0.01).map((lap) => lap.lap)).toEqual([3, 4]);
    expect(run(SECTOR_MAX_TICK_SPAN_S + 0.01).map((lap) => lap.lap)).toEqual([4]);
  });

  it("drops the lap when SessionTime runs backwards between two ticks", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);
    const paused = drive(feed, 1.99, 2.4, 500);

    drive(feed, 2.4, 4.01, paused - 1);

    expect(laps(slice).map((lap) => lap.lap)).toEqual([4]);
  });

  it("drops only the car that broke", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);

    for (let n = 0; n <= 900; n++) {
      const progress = 1.99 + n / (LAP_S / DT);

      feed(500 + n * DT, [progress, progress], { reset: [false, n === 400] });
    }

    expect(laps(slice, 0).map((lap) => lap.lap)).toEqual([3]);
    expect(laps(slice, 1)).toEqual([]);
  });

  it("records nothing on a tick with no progress reading, and bridges nothing across it", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);
    const paused = drive(feed, 1.99, 2.4, 500);

    expect(slice.lapInProgress[0]).not.toBeNull();

    feed.none();

    expect(slice.lapInProgress).toEqual([]);
    expect(slice.lastProgress).toEqual([]);
    expect(slice.lastSessionTime).toBeNull();

    // Even a tick claiming the old one as its predecessor has nothing to bridge from.
    feed(paused + DT, [2.4 + DT / LAP_S], { previous: paused });
    drive(feed, 2.4 + (2 * DT) / LAP_S, 4.01, paused + 2 * DT);

    expect(laps(slice).map((lap) => lap.lap)).toEqual([4]);
  });

  it("records nothing while the track has no sectors, and bridges nothing across such a tick", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);
    const paused = drive(feed, 1.99, 2.4, 500);

    // The tick chain is unbroken; only the sectors are missing for one tick.
    feed(paused + DT, [2.4 + DT / LAP_S], { starts: null });

    expect(slice.lapInProgress).toEqual([]);
    expect(slice.lastSessionTime).toBeNull();

    drive(feed, 2.4 + (2 * DT) / LAP_S, 4.01, paused + 2 * DT);

    expect(laps(slice).map((lap) => lap.lap)).toEqual([4]);
  });

  it("drops the lap of a car that rolls back over a sector start and crosses it again", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);
    let t = drive(feed, 1.99, 2.26, 500);

    feed((t += DT), [2.24]);
    drive(feed, 2.25, 4.01, t + DT);

    expect(laps(slice).map((lap) => lap.lap)).toEqual([4]);
  });

  it("drops the lap of a car that rolls back over the line off track and crosses it again", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);
    let t = drive(feed, 1.99, 2.0002, 500);

    // Back over the line off track, then across it again on track.
    feed((t += DT), [1.9995], { surface: [TrkLoc.OffTrack] });
    drive(feed, 2.0003, 4.01, t + DT);

    // Lap 3 is not reopened clean at the second crossing: it is dropped, and lap 4 is the next one recorded.
    expect(laps(slice).map((lap) => lap.lap)).toEqual([4]);
  });

  it("keeps the lap of a car that rolls back without crossing anything: a slow lap, not a break", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);
    let t = drive(feed, 1.99, 2.4, 500);

    // Two seconds of rolling back and standing, all inside sector 2.
    for (let n = 0; n < 20; n++) feed((t += DT), [2.39]);

    drive(feed, 2.39, 3.01, t + DT);

    expectTimes(laps(slice)[0], [20, 28 + 2.1 + 0.01 * LAP_S, 32]);
    expect(laps(slice)[0]).toMatchObject({ lap: 3, clean: true });
  });

  it("withholds a car's bridge when its unit does not complete, so its lap is dropped on the next tick", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);
    // What the step boundary's runner does with a unit that throws: the unit's work stops, the diff goes on.
    const failing: UnitRunner = () => false;

    drive(feed, 1.99, 4.01, 500, near(2.4, { runUnit: failing }));

    expect(laps(slice).map((lap) => lap.lap)).toEqual([4]);
  });
});

describe("diffSectorTimes: clean laps (decision 4)", () => {
  it("records the fixture's lap clean without an unclean tick (the control)", () => {
    const slice = createSectorTimesState();

    drive(feeder(slice), 1.99, 3.01, 500);

    expect(laps(slice)).toEqual([expect.objectContaining({ lap: 3, clean: true })]);
  });

  it.each<[string, FeedOptions]>([
    ["OffTrack", { surface: [TrkLoc.OffTrack] }],
    ["InPitStall", { surface: [TrkLoc.InPitStall] }],
    ["AproachingPits", { surface: [TrkLoc.AproachingPits] }],
    ["NotInWorld", { surface: [TrkLoc.NotInWorld] }],
    ["an unreadable surface", { surface: null }],
    ["a full-course caution", { caution: true }],
  ])("records a lap with one tick of %s as unclean, with its times", (_name, unclean) => {
    const slice = createSectorTimesState();

    drive(feeder(slice), 1.99, 3.01, 500, near(2.4, unclean));

    expect(laps(slice)).toEqual([expect.objectContaining({ lap: 3, clean: false })]);
    expectTimes(laps(slice)[0], [20, 28, 32]);
  });

  it("marks only the lap the unclean tick was driven on", () => {
    const slice = createSectorTimesState();

    drive(feeder(slice), 1.99, 5.01, 500, near(3.4, { surface: [TrkLoc.OffTrack] }));

    expect(laps(slice).map((lap) => [lap.lap, lap.clean])).toEqual([
      [3, true],
      [4, false],
      [5, true],
    ]);
  });

  it("counts the tick a car crosses the line on against both laps", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);
    // The first tick at or past 3.0: the bracket that closes lap 3 and opens lap 4.
    let marked = false;

    drive(feed, 1.99, 5.01, 500, (_n, progress) => {
      if (marked || progress < 3) return undefined;

      marked = true;

      return { surface: [TrkLoc.OffTrack] };
    });

    expect(laps(slice).map((lap) => [lap.lap, lap.clean])).toEqual([
      [3, false],
      [4, false],
      [5, true],
    ]);
  });

  it("records the race's opening lap as unclean, and the same drive one lap later as clean", () => {
    // Hand-built: a reading just short of progress 0, which the progress step
    // itself never hands on, so the opening lap's own line crossing is seen.
    const opening = createSectorTimesState();

    drive(feeder(opening), -0.01, 1.01, 500);

    expect(laps(opening)).toEqual([expect.objectContaining({ lap: 1, clean: false })]);
    expectTimes(laps(opening)[0], [20, 28, 32]);

    const second = createSectorTimesState();

    drive(feeder(second), 0.99, 2.01, 500);

    expect(laps(second)).toEqual([expect.objectContaining({ lap: 2, clean: true })]);
  });

  it("records a lap with a non-positive sector time as unclean, and the same steps over real time as clean", () => {
    const run = (stepSeconds: number): SectorLap | undefined => {
      const slice = createSectorTimesState();
      const feed = feeder(slice, [0, 0.5, 0.501]);

      feed(100, [1.999]);
      feed(100.1, [2.001]);
      feed(100.2, [2.4995]);
      // Crosses 2.5 and 2.501: with no time between the two ticks, sector 2 takes none.
      feed(100.2 + stepSeconds, [2.5015]);
      feed(100.3 + stepSeconds, [2.999]);
      feed(100.4 + stepSeconds, [3.001]);

      return laps(slice)[0];
    };

    expect(run(0)).toMatchObject({ lap: 3, clean: false });
    expect(run(0)?.sectorTimes[1]).toBe(0);
    expect(run(0.1)).toMatchObject({ lap: 3, clean: true });
  });
});

describe("diffSectorTimes: the history and its lifecycles", () => {
  it(`keeps a car's last ${SECTOR_HISTORY_LAPS} laps, newest last`, () => {
    const slice = createSectorTimesState();

    drive(feeder(slice), 1.99, 12.01, 500);

    expect(SECTOR_HISTORY_LAPS).toBe(8);
    expect(laps(slice).map((lap) => lap.lap)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("keeps the completed laps across a replay wipe and drops the lap in progress", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);
    const paused = drive(feed, 1.99, 3.4, 500, () => ({ neighbours: { leaderIdx: 2, aheadIdx: 3, behindIdx: 4 } }));
    const completed = slice.completedLaps;

    expect(slice.lapInProgress[0]?.lap).toBe(4);

    const kept = resetSectorTimesForReplay(slice);

    expect(kept.completedLaps).toBe(completed);
    expect(kept).toEqual({ ...createSectorTimesState(), completedLaps: completed });
    expect(laps(kept).map((lap) => lap.lap)).toEqual([3]);

    // Back live: lap 4 is not recorded (its first half was measured before the
    // glance), lap 5 is, behind lap 3.
    const back = feeder(kept);

    drive(back, 3.5, 5.01, paused + 30);

    expect(laps(kept).map((lap) => lap.lap)).toEqual([3, 5]);
  });

  it("starts empty with the state, which a session change and a disconnect recreate", () => {
    expect(createInitialState().sectorTimes).toEqual(createSectorTimesState());
    expect(createSectorTimesState()).toEqual({
      lastProgress: [],
      lapInProgress: [],
      completedLaps: [],
      lastSessionTime: null,
      sectorCount: null,
      targets: { leaderIdx: -1, aheadIdx: -1, behindIdx: -1 },
    });
  });

  it("drops the bridge of a car the tick no longer reaches", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);

    feed(100, [1.999, 1.999]);
    feed(100.1, [2.001, 2.001]);

    expect(slice.lapInProgress).toHaveLength(2);

    feed(100.2, [2.003]);

    expect(slice.lapInProgress).toHaveLength(1);
    expect(slice.lastProgress).toEqual([2.003]);
  });
});

describe("diffSectorTimes: targets", () => {
  it("records the neighbours it is handed, as they are", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);

    feed(100, [2.1], { neighbours: { leaderIdx: 7, aheadIdx: 3, behindIdx: 9 } });

    expect(slice.targets).toEqual({ leaderIdx: 7, aheadIdx: 3, behindIdx: 9 });

    // The player leading its class, and the leader directly ahead: both kept raw for the reader.
    feed(100.1, [2.2], { neighbours: { leaderIdx: 0, aheadIdx: -1, behindIdx: 9 } });

    expect(slice.targets).toEqual({ leaderIdx: 0, aheadIdx: -1, behindIdx: 9 });

    feed(100.2, [2.3], { neighbours: { leaderIdx: 3, aheadIdx: 3, behindIdx: -1 } });

    expect(slice.targets).toEqual({ leaderIdx: 3, aheadIdx: 3, behindIdx: -1 });
  });

  it("records them on a track with no sectors too", () => {
    const slice = createSectorTimesState();

    feeder(slice, null)(100, [2.1], { neighbours: { leaderIdx: 7, aheadIdx: 3, behindIdx: 9 } });

    expect(slice.targets).toEqual({ leaderIdx: 7, aheadIdx: 3, behindIdx: 9 });
  });

  it("clears them when no neighbours were resolved, and on a tick with no progress reading", () => {
    const none = { leaderIdx: -1, aheadIdx: -1, behindIdx: -1 };
    const some: StandingsNeighbors = { leaderIdx: 7, aheadIdx: 3, behindIdx: 9 };
    const slice = createSectorTimesState();
    const feed = feeder(slice);

    feed(100, [2.1], { neighbours: some });
    feed(100.1, [2.2], { neighbours: null });

    expect(slice.targets).toEqual(none);

    feed(100.2, [2.3], { neighbours: some });
    // A bare mock of `diffGaps` answers undefined.
    diffSectorTimes(
      slice,
      { sessionTime: 100.3, previousSessionTime: 100.2, progress: [2.4], traceReset: [false], traces: [] },
      STARTS,
      [TrkLoc.OnTrack],
      false,
      undefined,
    );

    expect(slice.targets).toEqual(none);

    feed(100.4, [2.5], { neighbours: some });
    // No progress tick: the neighbours handed with it are not a reading of this tick.
    feed.none(some);

    expect(slice.targets).toEqual(none);
  });
});

describe("diffSectorTimes: the sector count it measured with (#1572)", () => {
  it("records the count of the starts it was handed on a tick it consumed", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);

    expect(slice.sectorCount).toBeNull();

    feed(100, [1.5]);
    expect(slice.sectorCount).toBe(3);

    feed(100.1, [1.501], { starts: [0, 0.5] });
    expect(slice.sectorCount).toBe(2);
  });

  it("is null on a tick it recorded nothing: no progress reading, or a track with no sectors", () => {
    const slice = createSectorTimesState();
    const feed = feeder(slice);

    feed(100, [1.5]);
    feed.none();
    expect(slice.sectorCount).toBeNull();

    feed(100.1, [1.501]);
    expect(slice.sectorCount).toBe(3);

    feed(100.2, [1.502], { starts: null });
    expect(slice.sectorCount).toBeNull();
  });

  it("starts fresh at a replay glance, until the next live tick records again", () => {
    const slice = createSectorTimesState();

    feeder(slice)(100, [1.5]);

    expect(resetSectorTimesForReplay(slice).sectorCount).toBeNull();
  });
});
