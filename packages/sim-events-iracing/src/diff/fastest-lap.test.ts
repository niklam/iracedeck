/**
 * Unit tests for the fastest-lap-of-the-race diff (issue #1571): the record
 * scan over `CarIdxBestLapTime`, the player's judge, the claim's publish, and
 * the seeds — a first seed, and the re-seed after a replay glance.
 */
import { SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { createFastestLapState, type FastestLapState, resetFastestLapBaselines } from "../state.js";
import {
  createFastestLapJudge,
  diffFastestLap,
  FASTEST_LAP_HOLD_MAX_MS,
  isEligibleRecordLap,
  resolvePlayerFastestLap,
} from "./fastest-lap.js";
import { LAP_RESULTS_SYNC_MAX_WAIT_MS, LAP_TIME_REFRESH_ALLOWANCE_MS } from "./laps.js";
import type { PendingEvent } from "./types.js";

const PLAYER = 0;
const PACE = 4;

/** Five cars: the player (0), three rivals (1–3) and the pace car (4). */
type Field = {
  SessionState: number;
  LapCompleted: number;
  CarIdxClass: number[];
  CarIdxLapCompleted: number[];
  CarIdxBestLapTime: number[];
};

function makeField(overrides: Partial<Field> = {}): Field {
  return {
    SessionState: SessionState.Racing,
    LapCompleted: 3,
    CarIdxClass: [100, 100, 100, 100, -1],
    CarIdxLapCompleted: [3, 3, 3, 3, 3],
    CarIdxBestLapTime: [-1, -1, -1, -1, -1],
    ...overrides,
  };
}

/** Ranks by carIdx: the player is P2 behind car 1; car 2 is P3, car 3 P4; the pace car unranked. */
const POSITIONS = [2, 1, 3, 4, 0];

const SESSION_INFO = {
  DriverInfo: {
    DriverCarIdx: PLAYER,
    Drivers: [
      { CarIdx: 0, CarNumber: "1" },
      { CarIdx: 1, CarNumber: "07" },
      { CarIdx: 2, CarNumber: "22" },
      // Car 3 has no row.
      { CarIdx: 4, CarNumber: "0", CarIsPaceCar: 1 },
    ],
  },
};

type RunOptions = Partial<{
  player: number;
  pace: number | null;
  isRace: boolean;
  multi: boolean | null;
  positions: number[];
  sessionInfo: Record<string, unknown> | null;
  /** The tick's clock (ms); only the hold reads it. */
  now: number;
  /** The count `diffLaps` last emitted for, as `handleTick` hands it; `null` (the default) while it is unseeded. */
  lapsJudgedThrough: number | null;
}>;

function run(slice: FastestLapState, field: Field, opts: RunOptions = {}): PendingEvent[] {
  const out: PendingEvent[] = [];

  diffFastestLap(
    slice,
    field as unknown as TelemetryData,
    opts.sessionInfo === undefined ? SESSION_INFO : opts.sessionInfo,
    opts.player ?? PLAYER,
    opts.pace === undefined ? PACE : opts.pace,
    opts.isRace ?? true,
    opts.multi === undefined ? false : opts.multi,
    opts.positions ?? POSITIONS,
    (ev) => out.push(ev),
    opts.now ?? 0,
    opts.lapsJudgedThrough ?? null,
  );

  return out;
}

function fastestLapEvents(events: PendingEvent[]): Array<Extract<PendingEvent, { event: "fastestLap.set" }>["data"]> {
  return events
    .filter((e): e is Extract<PendingEvent, { event: "fastestLap.set" }> => e.event === "fastestLap.set")
    .map((e) => e.data);
}

/** A race in progress: car 1 holds a 90.0, car 2 a 91.0, car 3 nothing yet, the player a 92.0. */
function seededSlice(): { slice: FastestLapState; field: Field } {
  const slice = createFastestLapState();
  const field = makeField({ CarIdxBestLapTime: [92, 90, 91, -1, -1] });

  expect(run(slice, field)).toEqual([]);

  return { slice, field };
}

describe("isEligibleRecordLap", () => {
  const racing = makeField() as unknown as TelemetryData;
  const parade = makeField({ SessionState: SessionState.ParadeLaps }) as unknown as TelemetryData;

  it("admits a positive time on a completed lap in a race past the green", () => {
    expect(isEligibleRecordLap(true, racing, 1, 90)).toBe(true);
  });

  it.each([
    ["a non-race session", false, racing, 1, 90],
    ["a pre-green tick", true, parade, 1, 90],
    ["a lap count of 0", true, racing, 0, 90],
    ["a lap count of -1", true, racing, -1, 90],
    ["a time of 0", true, racing, 1, 0],
    ["a time of -1", true, racing, 1, -1],
    ["a NaN time", true, racing, 1, Number.NaN],
  ])("refuses %s", (_name, isRace, telemetry, laps, time) => {
    expect(isEligibleRecordLap(isRace, telemetry, laps, time)).toBe(false);
  });
});

describe("diffFastestLap — seeding", () => {
  it("seeds silently on the first eligible tick of a mid-race connect, the player's car included, and stays silent on the same values", () => {
    const { slice, field } = seededSlice();

    expect(slice.record).toEqual({ lapTime: 90, carIdx: 1, isPlayer: false, carNumber: "07" });
    expect(slice.baselines).toEqual([92, 90, 91, 0, 0]);
    expect(slice.raceSeeded).toBe(true);
    expect(run(slice, field)).toEqual([]);
  });

  it("the player's own best is the record on the first seed when it is the class minimum", () => {
    const slice = createFastestLapState();

    expect(run(slice, makeField({ CarIdxBestLapTime: [89, 90, 91, -1, -1] }))).toEqual([]);
    expect(slice.record).toEqual({ lapTime: 89, carIdx: PLAYER, isPlayer: true, carNumber: "1" });
  });

  it("seeds with no record when no car has an eligible time, then takes the first eligible best as a record with no previous", () => {
    const slice = createFastestLapState();
    const field = makeField();

    expect(run(slice, field)).toEqual([]);
    expect(slice.record).toBeNull();

    field.CarIdxBestLapTime[2] = 95;
    const events = fastestLapEvents(run(slice, field));

    expect(events).toHaveLength(1);
    expect(events[0]!.previous).toBeUndefined();
    expect(events[0]).toMatchObject({ carIdx: 2, isPlayer: false, lapTime: 95 });
  });

  it("a pre-green tick neither seeds nor emits; the first tick past the green seeds (the positive control)", () => {
    const slice = createFastestLapState();
    const field = makeField({ SessionState: SessionState.ParadeLaps, CarIdxBestLapTime: [-1, 90, -1, -1, -1] });

    expect(run(slice, field)).toEqual([]);
    expect(slice.baselinesSeeded).toBe(false);
    expect(slice.record).toBeNull();

    field.SessionState = SessionState.Racing;

    expect(run(slice, field)).toEqual([]);
    expect(slice.baselinesSeeded).toBe(true);
    expect(slice.record).toMatchObject({ carIdx: 1, lapTime: 90 });
  });

  it("a practice session never seeds or emits, while the same ticks in a race do", () => {
    const practice = createFastestLapState();
    const field = makeField({ CarIdxBestLapTime: [-1, 90, -1, -1, -1] });

    expect(run(practice, field, { isRace: false })).toEqual([]);
    field.CarIdxBestLapTime[2] = 85;
    expect(run(practice, field, { isRace: false })).toEqual([]);
    expect(practice.record).toBeNull();
    expect(practice.baselinesSeeded).toBe(false);

    const race = createFastestLapState();
    const again = makeField({ CarIdxBestLapTime: [-1, 90, -1, -1, -1] });
    expect(run(race, again)).toEqual([]);
    again.CarIdxBestLapTime[2] = 85;
    expect(fastestLapEvents(run(race, again))).toHaveLength(1);
  });

  it("a count below 1 keeps a car's best out of the first seed's record while its baseline absorbs the value", () => {
    const slice = createFastestLapState();
    // Car 1 has a best from a lap the counter says it has not completed (a parade lap carried into lap 0).
    const field = makeField({ CarIdxLapCompleted: [3, 0, 3, 3, 3], CarIdxBestLapTime: [-1, 80, 91, -1, -1] });

    expect(run(slice, field)).toEqual([]);
    expect(slice.record).toMatchObject({ carIdx: 2, lapTime: 91 });
    expect(slice.baselines[1]).toBe(80);
  });

  it("does not scan while the player's carIdx is unresolved", () => {
    const slice = createFastestLapState();
    const field = makeField({ CarIdxBestLapTime: [-1, 90, -1, -1, -1] });

    expect(run(slice, field, { player: -1 })).toEqual([]);
    expect(slice.baselinesSeeded).toBe(false);
  });
});

describe("diffFastestLap — the scan", () => {
  let slice: FastestLapState;
  let field: Field;

  beforeEach(() => {
    ({ slice, field } = seededSlice());
  });

  it("a car's best falling below the record emits one event with the holder, the lap, the beaten record, the car number, the positions and the player's lap count", () => {
    field.CarIdxBestLapTime[2] = 89.5;
    field.CarIdxLapCompleted[2] = 4;
    field.LapCompleted = 3;

    const events = fastestLapEvents(run(slice, field));

    expect(events).toEqual([
      {
        carIdx: 2,
        isPlayer: false,
        lap: 4,
        lapTime: 89.5,
        previous: { carIdx: 1, lapTime: 90, isPlayer: false, carNumber: "07" },
        carNumber: "22",
        position: 3,
        playerPosition: 2,
        playerLapsCompleted: 3,
        isMultiClass: false,
      },
    ]);
    expect(slice.record).toEqual({ lapTime: 89.5, carIdx: 2, isPlayer: false, carNumber: "22" });
    expect(slice.baselines[2]).toBe(89.5);
  });

  it("a car's best falling but staying above the record updates its baseline and emits nothing", () => {
    field.CarIdxBestLapTime[2] = 90.5;

    expect(run(slice, field)).toEqual([]);
    expect(slice.baselines[2]).toBe(90.5);
    expect(slice.record).toMatchObject({ carIdx: 1, lapTime: 90 });
  });

  it("a value of -1 or 0 changes neither a baseline nor the record", () => {
    field.CarIdxBestLapTime[2] = -1;
    field.CarIdxBestLapTime[1] = 0;

    expect(run(slice, field)).toEqual([]);
    expect(slice.baselines).toEqual([92, 90, 91, 0, 0]);
    expect(slice.record).toMatchObject({ carIdx: 1, lapTime: 90 });
  });

  it("a record holder whose value turns -1 keeps the record: a slower car's next best does not take it, a faster one does", () => {
    // Car 1 leaves the world.
    field.CarIdxBestLapTime[1] = -1;
    expect(run(slice, field)).toEqual([]);
    expect(slice.record).toMatchObject({ carIdx: 1, lapTime: 90 });

    // Car 2 improves to 90.5: faster than every remaining car, slower than the record.
    field.CarIdxBestLapTime[2] = 90.5;
    expect(run(slice, field)).toEqual([]);
    expect(slice.record).toMatchObject({ carIdx: 1, lapTime: 90 });

    // The positive control: car 2 beats the departed holder's time.
    field.CarIdxBestLapTime[2] = 89.9;
    const events = fastestLapEvents(run(slice, field));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, lapTime: 89.9, previous: { carIdx: 1, lapTime: 90 } });
  });

  it("a pre-green tick is skipped: the lowered value is neither announced then nor when the green comes, since the baseline absorbs it", () => {
    field.SessionState = SessionState.ParadeLaps;
    field.CarIdxBestLapTime[2] = 85;

    expect(run(slice, field)).toEqual([]);
    expect(slice.record).toMatchObject({ carIdx: 1, lapTime: 90 });
    // Pre-green nothing moves, the baseline included.
    expect(slice.baselines[2]).toBe(91);

    field.SessionState = SessionState.Racing;
    const events = fastestLapEvents(run(slice, field));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, lapTime: 85 });
  });

  it("a car with a count below 1 is skipped, its value absorbed: the same value at count 1 is not news, a new lower value is (the positive control)", () => {
    field.CarIdxLapCompleted[2] = 0;
    field.CarIdxBestLapTime[2] = 85;

    expect(run(slice, field)).toEqual([]);
    expect(slice.baselines[2]).toBe(85);
    expect(slice.record).toMatchObject({ carIdx: 1, lapTime: 90 });

    // The parade lap carried into lap 1: still not a record.
    field.CarIdxLapCompleted[2] = 1;
    expect(run(slice, field)).toEqual([]);

    field.CarIdxBestLapTime[2] = 84;
    const events = fastestLapEvents(run(slice, field));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, lap: 1, lapTime: 84 });
  });

  it("another class's car and the pace car never emit, while a same-class car on the same values does", () => {
    field.CarIdxClass[3] = 200;
    field.CarIdxBestLapTime[3] = 80;
    field.CarIdxBestLapTime[PACE] = 70;
    field.CarIdxClass[PACE] = 100;

    expect(run(slice, field)).toEqual([]);
    expect(slice.record).toMatchObject({ carIdx: 1, lapTime: 90 });

    field.CarIdxBestLapTime[2] = 80;
    const events = fastestLapEvents(run(slice, field));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, lapTime: 80 });
  });

  it("two cars lowering the record on one tick emit one event, for the faster, beating the old record", () => {
    field.CarIdxBestLapTime[2] = 89;
    field.CarIdxBestLapTime[3] = 88;

    const events = fastestLapEvents(run(slice, field));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 3, lapTime: 88, previous: { carIdx: 1, lapTime: 90 } });
    expect(slice.baselines[2]).toBe(89);
    expect(slice.record).toMatchObject({ carIdx: 3, lapTime: 88 });
  });

  it("omits the car number for a car with no session-info row, and the previous holder's when it had none", () => {
    field.CarIdxBestLapTime[3] = 89;
    const first = fastestLapEvents(run(slice, field))[0]!;

    expect(first.carNumber).toBeUndefined();
    expect(first.previous).toEqual({ carIdx: 1, lapTime: 90, isPlayer: false, carNumber: "07" });

    field.CarIdxBestLapTime[2] = 88;
    const second = fastestLapEvents(run(slice, field))[0]!;

    expect(second.carNumber).toBe("22");
    expect(second.previous).toEqual({ carIdx: 3, lapTime: 89, isPlayer: false });
  });

  it("omits a position the canonical order does not rank, and isMultiClass when it is unknown", () => {
    field.CarIdxBestLapTime[2] = 89;

    const events = fastestLapEvents(run(slice, field, { positions: [0, 1, 0, 0, 0], multi: null }));

    expect(events).toHaveLength(1);
    expect(events[0]!.position).toBeUndefined();
    expect(events[0]!.playerPosition).toBeUndefined();
    expect(events[0]!.isMultiClass).toBeUndefined();
  });

  it("reports class positions in a multi-class race", () => {
    // Another class fills P1 and P2 overall: in class, car 1 leads, the player is P2, car 2 P3.
    const positions = [4, 3, 5, 6, 0, 1, 2];
    const multi = makeField({
      CarIdxClass: [100, 100, 100, 100, -1, 200, 200],
      CarIdxLapCompleted: [3, 3, 3, 3, 3, 3, 3],
      CarIdxBestLapTime: [92, 90, 91, -1, -1, 70, 71],
    });
    const fresh = createFastestLapState();

    expect(run(fresh, multi, { positions, multi: true })).toEqual([]);
    // The other class's faster laps never made the record.
    expect(fresh.record).toMatchObject({ carIdx: 1, lapTime: 90 });

    multi.CarIdxBestLapTime[2] = 89;
    const events = fastestLapEvents(run(fresh, multi, { positions, multi: true }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, position: 3, playerPosition: 2, isMultiClass: true });
  });

  it("a later refresh of the player's own best emits nothing: the player is never scanned", () => {
    field.CarIdxBestLapTime[PLAYER] = 80;

    expect(run(slice, field)).toEqual([]);
    expect(slice.record).toMatchObject({ carIdx: 1, lapTime: 90 });
    // The baseline still follows it, so nothing is ever "new" for the player.
    expect(slice.baselines[PLAYER]).toBe(80);
  });
});

describe("the player's judge (decision 2)", () => {
  let slice: FastestLapState;
  let field: Field;

  beforeEach(() => {
    ({ slice, field } = seededSlice());
  });

  function judge(lap: number, lapTime: number, opts: RunOptions = {}): boolean {
    return createFastestLapJudge(
      slice,
      field as unknown as TelemetryData,
      opts.sessionInfo === undefined ? SESSION_INFO : opts.sessionInfo,
      opts.player ?? PLAYER,
      opts.isRace ?? true,
    )(lap, lapTime);
  }

  it("a faster lap takes the record for the player and leaves the claim", () => {
    expect(judge(4, 89.5)).toBe(true);
    expect(slice.record).toEqual({ lapTime: 89.5, carIdx: PLAYER, isPlayer: true, carNumber: "1" });
    expect(slice.claim).toEqual({
      lap: 4,
      record: { lapTime: 89.5, carIdx: PLAYER, isPlayer: true, carNumber: "1" },
      previous: { lapTime: 90, carIdx: 1, isPlayer: false, carNumber: "07" },
    });
  });

  it.each([
    ["a slower lap", 4, 90.5, {}],
    ["an equal lap", 4, 90, {}],
    ["a non-race session", 4, 89.5, { isRace: false }],
    ["an unresolved player", 4, 89.5, { player: -1 }],
  ] as const)("refuses %s, leaving the record and no claim", (_name, lap, lapTime, opts) => {
    expect(judge(lap, lapTime, opts)).toBe(false);
    expect(slice.record).toMatchObject({ carIdx: 1, lapTime: 90 });
    expect(slice.claim).toBeNull();
  });

  it("refuses a pre-green tick", () => {
    field.SessionState = SessionState.ParadeLaps;

    expect(judge(4, 89.5)).toBe(false);
    expect(slice.claim).toBeNull();
  });

  it("refuses the lap-0 parade crossing through the shared predicate, while the same lap as lap 1 claims (the positive control)", () => {
    const empty = createFastestLapState();
    const parade = makeField({ CarIdxBestLapTime: [-1, -1, -1, -1, -1] });
    expect(run(empty, parade)).toEqual([]);
    expect(empty.record).toBeNull();

    const judgeOn = (lap: number): boolean =>
      createFastestLapJudge(empty, parade as unknown as TelemetryData, SESSION_INFO, PLAYER, true)(lap, 200);

    expect(judgeOn(0)).toBe(false);
    expect(empty.record).toBeNull();
    expect(judgeOn(1)).toBe(true);
    expect(empty.record).toMatchObject({ isPlayer: true, lapTime: 200 });
  });

  it("the first timed lap of the class claims with no previous", () => {
    const empty = createFastestLapState();
    const parade = makeField();
    run(empty, parade);

    expect(resolvePlayerFastestLap(empty, parade as unknown as TelemetryData, SESSION_INFO, PLAYER, true, 1, 95)).toBe(
      true,
    );
    expect(empty.claim).toMatchObject({ lap: 1, previous: null });
  });

  it("the claim is published on the same tick, right away, with the player's lap as the lap count, then cleared", () => {
    judge(4, 89.5);

    const events = fastestLapEvents(run(slice, field));

    expect(events).toEqual([
      {
        carIdx: PLAYER,
        isPlayer: true,
        lap: 4,
        lapTime: 89.5,
        previous: { carIdx: 1, lapTime: 90, isPlayer: false, carNumber: "07" },
        carNumber: "1",
        position: 2,
        playerPosition: 2,
        playerLapsCompleted: 4,
        isMultiClass: false,
      },
    ]);
    expect(slice.claim).toBeNull();
    expect(run(slice, field)).toEqual([]);
  });

  it("a claim is published before any gate of the diff: on a non-race or pre-green tick too, and never on the next tick", () => {
    judge(4, 89.5);
    field.SessionState = SessionState.ParadeLaps;

    expect(fastestLapEvents(run(slice, field, { isRace: false }))).toHaveLength(1);
    expect(slice.claim).toBeNull();
    expect(run(slice, field, { isRace: false })).toEqual([]);
    expect(run(slice, field)).toEqual([]);
  });

  it("a remote car beating the player's record names the player as the beaten holder", () => {
    judge(4, 89.5);
    run(slice, field);

    field.CarIdxBestLapTime[2] = 89;
    const events = fastestLapEvents(run(slice, field));

    expect(events).toHaveLength(1);
    expect(events[0]!.previous).toEqual({ carIdx: PLAYER, lapTime: 89.5, isPlayer: true, carNumber: "1" });
  });

  it("the player's best refreshing to the claimed time afterwards emits nothing", () => {
    judge(4, 89.5);
    run(slice, field);
    field.CarIdxBestLapTime[PLAYER] = 89.5;

    expect(run(slice, field)).toEqual([]);
  });
});

describe("diffFastestLap — across a replay glance (the baselines re-seed, the record survives)", () => {
  /**
   * What `wipeStateForReplay` does to this diff's slice, through
   * `resetFastestLapBaselines` (issue #1588): the baselines and the hold go,
   * the record and its first-seed mark stay. The hold goes because
   * `diffLaps` re-seeds on the way back, so a crossing pending at the flip is
   * never emitted and there is nothing to wait for.
   */
  function glance(slice: FastestLapState): void {
    Object.assign(slice, resetFastestLapBaselines(slice));
  }

  it("re-seeds silently and absorbs a remote car whose best fell below the kept record during the glance, as the holder", () => {
    const { slice, field } = seededSlice();
    glance(slice);
    field.CarIdxBestLapTime[2] = 89;

    expect(run(slice, field)).toEqual([]);
    expect(slice.record).toEqual({ lapTime: 89, carIdx: 2, isPlayer: false, carNumber: "22" });
    expect(slice.baselines).toEqual([92, 90, 89, 0, 0]);
  });

  it("does not read the player's best on a re-seed, while a connect's first seed does (the positive control)", () => {
    const { slice, field } = seededSlice();
    glance(slice);
    field.CarIdxBestLapTime[PLAYER] = 80;

    expect(run(slice, field)).toEqual([]);
    expect(slice.record).toMatchObject({ carIdx: 1, lapTime: 90 });

    const fresh = createFastestLapState();
    expect(run(fresh, field)).toEqual([]);
    expect(fresh.record).toMatchObject({ carIdx: PLAYER, lapTime: 80, isPlayer: true });
  });

  it("a glance before any eligible lap still counts as the first seed, so the way back excludes the player", () => {
    const slice = createFastestLapState();
    const field = makeField();
    expect(run(slice, field)).toEqual([]);
    expect(slice.record).toBeNull();
    expect(slice.raceSeeded).toBe(true);

    glance(slice);
    field.CarIdxBestLapTime[PLAYER] = 80;
    expect(run(slice, field)).toEqual([]);
    expect(slice.record).toBeNull();
  });

  it("a departed holder keeps the record across the glance: a car slower than it but faster than the rest emits nothing, a faster one emits", () => {
    const { slice, field } = seededSlice();
    glance(slice);
    field.CarIdxBestLapTime[1] = -1;

    expect(run(slice, field)).toEqual([]);
    expect(slice.record).toMatchObject({ carIdx: 1, lapTime: 90 });

    field.CarIdxBestLapTime[2] = 90.5;
    expect(run(slice, field)).toEqual([]);

    field.CarIdxBestLapTime[2] = 89.9;
    const events = fastestLapEvents(run(slice, field));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, lapTime: 89.9, previous: { carIdx: 1, lapTime: 90 } });
  });

  it("a hold pending at the glance does not survive it: the lap diff re-seeds on the way back, the baselines re-seed, and the scan runs", () => {
    const { slice, field } = seededSlice();
    let lapsJudgedThrough = 3;
    field.LapCompleted = 4;
    expect(run(slice, field, { now: 1000, lapsJudgedThrough })).toEqual([]);
    expect(slice.hold).toEqual({ lap: 4, since: 1000 });

    glance(slice);
    // `diffLaps` re-seeds on the current count: the pending crossing is never emitted.
    lapsJudgedThrough = 4;
    field.CarIdxBestLapTime[2] = 89;

    // The re-seed, silent, absorbs car 2 as the holder; no hold is left.
    expect(run(slice, field, { now: 60_000, lapsJudgedThrough })).toEqual([]);
    expect(slice.record).toMatchObject({ carIdx: 2, lapTime: 89 });
    expect(slice.hold).toBeNull();

    // The positive control: the scan is live again.
    field.CarIdxBestLapTime[3] = 88;
    expect(fastestLapEvents(run(slice, field, { now: 60_100, lapsJudgedThrough }))).toHaveLength(1);
  });
});

describe("resetFastestLapBaselines (issue #1588)", () => {
  it("carries the record by reference and the first-seed mark, and returns the other four fields fresh from the factory", () => {
    const record = { lapTime: 89.5, carIdx: PLAYER, isPlayer: true, carNumber: "1" };
    const slice: FastestLapState = {
      record,
      raceSeeded: true,
      baselines: [92, 90, 91, 0, 0],
      baselinesSeeded: true,
      claim: { lap: 4, record, previous: null },
      hold: { lap: 5, since: 1000 },
    };

    const kept = resetFastestLapBaselines(slice);
    const fresh = createFastestLapState();

    expect(kept.record).toBe(record);
    expect(kept.raceSeeded).toBe(true);
    expect({ ...kept, record: fresh.record, raceSeeded: fresh.raceSeeded }).toEqual(fresh);
    // A new object: the slice handed in is left as it was, and the kept baselines are not its array.
    expect(kept).not.toBe(slice);
    expect(kept.baselines).not.toBe(slice.baselines);
    expect(slice.baselines).toEqual([92, 90, 91, 0, 0]);
  });
});

describe("diffFastestLap — the hold while the player's lap awaits judgement", () => {
  const CROSS_AT = 10_000;
  let slice: FastestLapState;
  let field: Field;
  /** What `handleTick` hands the diff: the count `diffLaps` last emitted for, `null` while it is unseeded. */
  let lapsJudgedThrough: number | null;

  /** `diffLaps` emits the player's lap: the judge runs on its payload and the count it last emitted for catches up. */
  function lapEmitted(lap: number, lapTime: number): boolean {
    const passed = createFastestLapJudge(
      slice,
      field as unknown as TelemetryData,
      SESSION_INFO,
      PLAYER,
      true,
    )(lap, lapTime);
    lapsJudgedThrough = lap;

    return passed;
  }

  /** The player crosses the line: the counter moves while `diffLaps` waits for the time refresh and the standings. */
  function playerCrosses(lap: number): void {
    field.LapCompleted = lap;
  }

  beforeEach(() => {
    ({ slice, field } = seededSlice());
    // `diffLaps` is seeded and has emitted the player's lap 3: an 89.9 that took the record from car 1.
    expect(lapEmitted(3, 89.9)).toBe(true);
    expect(fastestLapEvents(run(slice, field, { lapsJudgedThrough, now: CROSS_AT - 5000 }))).toHaveLength(1);
    expect(slice.record).toMatchObject({ isPlayer: true, lapTime: 89.9 });
    expect(slice.hold).toBeNull();
  });

  it("the trigger: a rival's best inside the wait, slower than the player's unjudged lap, is announced neither during the hold nor after the player's lap is judged", () => {
    playerCrosses(4);
    expect(run(slice, field, { lapsJudgedThrough, now: CROSS_AT })).toEqual([]);
    expect(slice.hold).toEqual({ lap: 4, since: CROSS_AT });

    // 0.8 s later car 2 crosses with an 89.7: below the 89.9 record, above the player's unjudged 89.6.
    field.CarIdxBestLapTime[2] = 89.7;
    field.CarIdxLapCompleted[2] = 5;
    expect(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + 800 })).toEqual([]);
    // Nothing moved: not the baseline, not the record.
    expect(slice.baselines[2]).toBe(91);
    expect(slice.record).toMatchObject({ isPlayer: true, lapTime: 89.9 });

    // `lap.completed` lands: the player's 89.6 is judged, then the scan resumes on the same tick.
    expect(lapEmitted(4, 89.6)).toBe(true);
    const events = fastestLapEvents(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + 1000 }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: PLAYER, isPlayer: true, lap: 4, lapTime: 89.6 });
    // Car 2's 89.7 was read against the 89.6: absorbed, no record.
    expect(slice.baselines[2]).toBe(89.7);
    expect(slice.record).toMatchObject({ isPlayer: true, lapTime: 89.6 });
    expect(slice.hold).toBeNull();
    expect(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + 1100 })).toEqual([]);

    // The positive control: with no crossing pending, a rival below the record is announced on its own tick.
    field.CarIdxBestLapTime[3] = 89.5;
    const control = fastestLapEvents(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + 1200 }));

    expect(control).toHaveLength(1);
    expect(control[0]).toMatchObject({
      carIdx: 3,
      lapTime: 89.5,
      previous: { carIdx: PLAYER, lapTime: 89.6, isPlayer: true },
    });
  });

  it("a rival faster than the player's unjudged lap is announced after the player's event, on the same tick's scan, as taking the record from the player", () => {
    playerCrosses(4);
    expect(run(slice, field, { lapsJudgedThrough, now: CROSS_AT })).toEqual([]);

    field.CarIdxBestLapTime[2] = 89.5;
    field.CarIdxLapCompleted[2] = 5;
    expect(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + 800 })).toEqual([]);

    expect(lapEmitted(4, 89.6)).toBe(true);
    const events = fastestLapEvents(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + 1000 }));

    expect(events.map((e) => [e.carIdx, e.lapTime])).toEqual([
      [PLAYER, 89.6],
      [2, 89.5],
    ]);
    expect(events[1]).toMatchObject({
      lap: 5,
      previous: { carIdx: PLAYER, lapTime: 89.6, isPlayer: true, carNumber: "1" },
    });
    expect(slice.record).toMatchObject({ carIdx: 2, lapTime: 89.5, isPlayer: false });
  });

  it("a crossing that never emits releases the scan at the bound, and the rival's lower best is announced then", () => {
    playerCrosses(4);
    expect(run(slice, field, { lapsJudgedThrough, now: CROSS_AT })).toEqual([]);

    field.CarIdxBestLapTime[2] = 89.7;
    expect(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + 800 })).toEqual([]);
    // Still held one millisecond short of the bound.
    expect(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + FASTEST_LAP_HOLD_MAX_MS - 1 })).toEqual([]);
    expect(slice.baselines[2]).toBe(91);

    const events = fastestLapEvents(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + FASTEST_LAP_HOLD_MAX_MS }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      carIdx: 2,
      lapTime: 89.7,
      previous: { carIdx: PLAYER, lapTime: 89.9, isPlayer: true },
    });

    // The scan stays released for the same unjudged crossing: a later lowering is announced at once.
    field.CarIdxBestLapTime[3] = 89.4;
    expect(
      fastestLapEvents(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + FASTEST_LAP_HOLD_MAX_MS + 10_000 })),
    ).toHaveLength(1);
  });

  it("the bound is the time-refresh allowance plus the standings wait: past the longest a lap.completed can trail the crossing", () => {
    expect(FASTEST_LAP_HOLD_MAX_MS).toBe(LAP_TIME_REFRESH_ALLOWANCE_MS + LAP_RESULTS_SYNC_MAX_WAIT_MS);
    expect(FASTEST_LAP_HOLD_MAX_MS).toBeGreaterThan(LAP_RESULTS_SYNC_MAX_WAIT_MS);
  });

  it("the control: a rival's record while the player is not mid-crossing is announced on its own tick", () => {
    field.CarIdxBestLapTime[2] = 89.7;
    const events = fastestLapEvents(run(slice, field, { lapsJudgedThrough, now: CROSS_AT }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, lapTime: 89.7, previous: { isPlayer: true, lapTime: 89.9 } });
    expect(slice.hold).toBeNull();
  });

  it("the next crossing starts a new hold after a released one, and a judged slower lap releases it without a claim", () => {
    playerCrosses(4);
    run(slice, field, { lapsJudgedThrough, now: CROSS_AT });
    const released = CROSS_AT + FASTEST_LAP_HOLD_MAX_MS;

    // Released: a value above the record advances its baseline, proving the scan ran.
    field.CarIdxBestLapTime[2] = 90.5;
    expect(run(slice, field, { lapsJudgedThrough, now: released })).toEqual([]);
    expect(slice.baselines[2]).toBe(90.5);

    playerCrosses(5);
    field.CarIdxBestLapTime[2] = 89.7;
    expect(run(slice, field, { lapsJudgedThrough, now: released + 100 })).toEqual([]);
    expect(slice.hold).toEqual({ lap: 5, since: released + 100 });
    expect(slice.baselines[2]).toBe(90.5);

    expect(lapEmitted(5, 95)).toBe(false);
    const events = fastestLapEvents(run(slice, field, { lapsJudgedThrough, now: released + 200 }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, lapTime: 89.7, previous: { isPlayer: true, lapTime: 89.9 } });
  });

  it("never holds for a lap-0 crossing, which the judge refuses whatever its time, nor while the lap diff is not seeded", () => {
    // Lap 0: the count ran ahead of a pace lap's -1, but no lap-0 time can enter the record.
    lapsJudgedThrough = -1;
    playerCrosses(0);
    field.CarIdxBestLapTime[2] = 89.7;
    expect(fastestLapEvents(run(slice, field, { lapsJudgedThrough, now: CROSS_AT }))).toHaveLength(1);
    expect(slice.hold).toBeNull();

    // The lap diff not seeded: it seeds on the current count and never emits for this crossing.
    lapsJudgedThrough = null;
    playerCrosses(4);
    field.CarIdxBestLapTime[3] = 89.5;
    expect(fastestLapEvents(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + 100 }))).toHaveLength(1);
    expect(slice.hold).toBeNull();

    // The positive control: seeded, the same crossing holds.
    lapsJudgedThrough = 3;
    field.CarIdxBestLapTime[1] = 89;
    expect(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + 200 })).toEqual([]);
    expect(slice.hold).toEqual({ lap: 4, since: CROSS_AT + 200 });
    expect(slice.baselines[1]).toBe(90);
  });

  it("a pre-green tick keeps its behaviour under a pending crossing: nothing moves, and the hold starts on the first green tick", () => {
    playerCrosses(4);
    field.SessionState = SessionState.ParadeLaps;
    field.CarIdxBestLapTime[2] = 89.7;
    expect(run(slice, field, { lapsJudgedThrough, now: CROSS_AT })).toEqual([]);
    expect(slice.hold).toBeNull();
    expect(slice.baselines[2]).toBe(91);

    field.SessionState = SessionState.Racing;
    expect(run(slice, field, { lapsJudgedThrough, now: CROSS_AT + 100 })).toEqual([]);
    expect(slice.hold).toEqual({ lap: 4, since: CROSS_AT + 100 });
  });
});
