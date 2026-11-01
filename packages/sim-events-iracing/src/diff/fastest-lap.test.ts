/**
 * Unit tests for the fastest-lap-of-the-race diff (issue #1571): the record
 * scan over `CarIdxBestLapTime`, the player's judge, the claim's publish, and
 * the seeds — a first seed, and the re-seed after a replay glance.
 */
import { SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { createFastestLapJudge, diffFastestLap, isEligibleRecordLap, resolvePlayerFastestLap } from "./fastest-lap.js";
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
}>;

function run(state: TranslatorState, field: Field, opts: RunOptions = {}): PendingEvent[] {
  const out: PendingEvent[] = [];

  diffFastestLap(
    state,
    field as unknown as TelemetryData,
    opts.sessionInfo === undefined ? SESSION_INFO : opts.sessionInfo,
    opts.player ?? PLAYER,
    opts.pace === undefined ? PACE : opts.pace,
    opts.isRace ?? true,
    opts.multi === undefined ? false : opts.multi,
    opts.positions ?? POSITIONS,
    (ev) => out.push(ev),
  );

  return out;
}

function fastestLapEvents(events: PendingEvent[]): Array<Extract<PendingEvent, { event: "fastestLap.set" }>["data"]> {
  return events
    .filter((e): e is Extract<PendingEvent, { event: "fastestLap.set" }> => e.event === "fastestLap.set")
    .map((e) => e.data);
}

/** A race in progress: car 1 holds a 90.0, car 2 a 91.0, car 3 nothing yet, the player a 92.0. */
function seededState(): { state: TranslatorState; field: Field } {
  const state = createInitialState();
  const field = makeField({ CarIdxBestLapTime: [92, 90, 91, -1, -1] });

  expect(run(state, field)).toEqual([]);

  return { state, field };
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
    const { state, field } = seededState();

    expect(state.fastestLapRecord).toEqual({ lapTime: 90, carIdx: 1, isPlayer: false, carNumber: "07" });
    expect(state.fastestLapBaselines).toEqual([92, 90, 91, 0, 0]);
    expect(state.fastestLapRaceSeeded).toBe(true);
    expect(run(state, field)).toEqual([]);
  });

  it("the player's own best is the record on the first seed when it is the class minimum", () => {
    const state = createInitialState();

    expect(run(state, makeField({ CarIdxBestLapTime: [89, 90, 91, -1, -1] }))).toEqual([]);
    expect(state.fastestLapRecord).toEqual({ lapTime: 89, carIdx: PLAYER, isPlayer: true, carNumber: "1" });
  });

  it("seeds with no record when no car has an eligible time, then takes the first eligible best as a record with no previous", () => {
    const state = createInitialState();
    const field = makeField();

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapRecord).toBeNull();

    field.CarIdxBestLapTime[2] = 95;
    const events = fastestLapEvents(run(state, field));

    expect(events).toHaveLength(1);
    expect(events[0]!.previous).toBeUndefined();
    expect(events[0]).toMatchObject({ carIdx: 2, isPlayer: false, lapTime: 95 });
  });

  it("a pre-green tick neither seeds nor emits; the first tick past the green seeds (the positive control)", () => {
    const state = createInitialState();
    const field = makeField({ SessionState: SessionState.ParadeLaps, CarIdxBestLapTime: [-1, 90, -1, -1, -1] });

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapBaselinesSeeded).toBe(false);
    expect(state.fastestLapRecord).toBeNull();

    field.SessionState = SessionState.Racing;

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapBaselinesSeeded).toBe(true);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });
  });

  it("a practice session never seeds or emits, while the same ticks in a race do", () => {
    const practice = createInitialState();
    const field = makeField({ CarIdxBestLapTime: [-1, 90, -1, -1, -1] });

    expect(run(practice, field, { isRace: false })).toEqual([]);
    field.CarIdxBestLapTime[2] = 85;
    expect(run(practice, field, { isRace: false })).toEqual([]);
    expect(practice.fastestLapRecord).toBeNull();
    expect(practice.fastestLapBaselinesSeeded).toBe(false);

    const race = createInitialState();
    const again = makeField({ CarIdxBestLapTime: [-1, 90, -1, -1, -1] });
    expect(run(race, again)).toEqual([]);
    again.CarIdxBestLapTime[2] = 85;
    expect(fastestLapEvents(run(race, again))).toHaveLength(1);
  });

  it("a count below 1 keeps a car's best out of the first seed's record while its baseline absorbs the value", () => {
    const state = createInitialState();
    // Car 1 has a best from a lap the counter says it has not completed (a parade lap carried into lap 0).
    const field = makeField({ CarIdxLapCompleted: [3, 0, 3, 3, 3], CarIdxBestLapTime: [-1, 80, 91, -1, -1] });

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 2, lapTime: 91 });
    expect(state.fastestLapBaselines[1]).toBe(80);
  });

  it("does not scan while the player's carIdx is unresolved", () => {
    const state = createInitialState();
    const field = makeField({ CarIdxBestLapTime: [-1, 90, -1, -1, -1] });

    expect(run(state, field, { player: -1 })).toEqual([]);
    expect(state.fastestLapBaselinesSeeded).toBe(false);
  });
});

describe("diffFastestLap — the scan", () => {
  let state: TranslatorState;
  let field: Field;

  beforeEach(() => {
    ({ state, field } = seededState());
  });

  it("a car's best falling below the record emits one event with the holder, the lap, the beaten record, the car number, the positions and the player's lap count", () => {
    field.CarIdxBestLapTime[2] = 89.5;
    field.CarIdxLapCompleted[2] = 4;
    field.LapCompleted = 3;

    const events = fastestLapEvents(run(state, field));

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
    expect(state.fastestLapRecord).toEqual({ lapTime: 89.5, carIdx: 2, isPlayer: false, carNumber: "22" });
    expect(state.fastestLapBaselines[2]).toBe(89.5);
  });

  it("a car's best falling but staying above the record updates its baseline and emits nothing", () => {
    field.CarIdxBestLapTime[2] = 90.5;

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapBaselines[2]).toBe(90.5);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });
  });

  it("a value of -1 or 0 changes neither a baseline nor the record", () => {
    field.CarIdxBestLapTime[2] = -1;
    field.CarIdxBestLapTime[1] = 0;

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapBaselines).toEqual([92, 90, 91, 0, 0]);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });
  });

  it("a record holder whose value turns -1 keeps the record: a slower car's next best does not take it, a faster one does", () => {
    // Car 1 leaves the world.
    field.CarIdxBestLapTime[1] = -1;
    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });

    // Car 2 improves to 90.5: faster than every remaining car, slower than the record.
    field.CarIdxBestLapTime[2] = 90.5;
    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });

    // The positive control: car 2 beats the departed holder's time.
    field.CarIdxBestLapTime[2] = 89.9;
    const events = fastestLapEvents(run(state, field));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, lapTime: 89.9, previous: { carIdx: 1, lapTime: 90 } });
  });

  it("a pre-green tick is skipped: the lowered value is neither announced then nor when the green comes, since the baseline absorbs it", () => {
    field.SessionState = SessionState.ParadeLaps;
    field.CarIdxBestLapTime[2] = 85;

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });
    // Pre-green nothing moves, the baseline included.
    expect(state.fastestLapBaselines[2]).toBe(91);

    field.SessionState = SessionState.Racing;
    const events = fastestLapEvents(run(state, field));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, lapTime: 85 });
  });

  it("a car with a count below 1 is skipped, its value absorbed: the same value at count 1 is not news, a new lower value is (the positive control)", () => {
    field.CarIdxLapCompleted[2] = 0;
    field.CarIdxBestLapTime[2] = 85;

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapBaselines[2]).toBe(85);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });

    // The parade lap carried into lap 1: still not a record.
    field.CarIdxLapCompleted[2] = 1;
    expect(run(state, field)).toEqual([]);

    field.CarIdxBestLapTime[2] = 84;
    const events = fastestLapEvents(run(state, field));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, lap: 1, lapTime: 84 });
  });

  it("another class's car and the pace car never emit, while a same-class car on the same values does", () => {
    field.CarIdxClass[3] = 200;
    field.CarIdxBestLapTime[3] = 80;
    field.CarIdxBestLapTime[PACE] = 70;
    field.CarIdxClass[PACE] = 100;

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });

    field.CarIdxBestLapTime[2] = 80;
    const events = fastestLapEvents(run(state, field));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, lapTime: 80 });
  });

  it("two cars lowering the record on one tick emit one event, for the faster, beating the old record", () => {
    field.CarIdxBestLapTime[2] = 89;
    field.CarIdxBestLapTime[3] = 88;

    const events = fastestLapEvents(run(state, field));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 3, lapTime: 88, previous: { carIdx: 1, lapTime: 90 } });
    expect(state.fastestLapBaselines[2]).toBe(89);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 3, lapTime: 88 });
  });

  it("omits the car number for a car with no session-info row, and the previous holder's when it had none", () => {
    field.CarIdxBestLapTime[3] = 89;
    const first = fastestLapEvents(run(state, field))[0]!;

    expect(first.carNumber).toBeUndefined();
    expect(first.previous).toEqual({ carIdx: 1, lapTime: 90, isPlayer: false, carNumber: "07" });

    field.CarIdxBestLapTime[2] = 88;
    const second = fastestLapEvents(run(state, field))[0]!;

    expect(second.carNumber).toBe("22");
    expect(second.previous).toEqual({ carIdx: 3, lapTime: 89, isPlayer: false });
  });

  it("omits a position the canonical order does not rank, and isMultiClass when it is unknown", () => {
    field.CarIdxBestLapTime[2] = 89;

    const events = fastestLapEvents(run(state, field, { positions: [0, 1, 0, 0, 0], multi: null }));

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
    const fresh = createInitialState();

    expect(run(fresh, multi, { positions, multi: true })).toEqual([]);
    // The other class's faster laps never made the record.
    expect(fresh.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });

    multi.CarIdxBestLapTime[2] = 89;
    const events = fastestLapEvents(run(fresh, multi, { positions, multi: true }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, position: 3, playerPosition: 2, isMultiClass: true });
  });

  it("a later refresh of the player's own best emits nothing: the player is never scanned", () => {
    field.CarIdxBestLapTime[PLAYER] = 80;

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });
    // The baseline still follows it, so nothing is ever "new" for the player.
    expect(state.fastestLapBaselines[PLAYER]).toBe(80);
  });
});

describe("the player's judge (decision 2)", () => {
  let state: TranslatorState;
  let field: Field;

  beforeEach(() => {
    ({ state, field } = seededState());
  });

  function judge(lap: number, lapTime: number, lapIsValid: boolean | undefined, opts: RunOptions = {}): boolean {
    return createFastestLapJudge(
      state,
      field as unknown as TelemetryData,
      opts.sessionInfo === undefined ? SESSION_INFO : opts.sessionInfo,
      opts.player ?? PLAYER,
      opts.isRace ?? true,
    )(lap, lapTime, lapIsValid);
  }

  it("a faster valid lap takes the record for the player and leaves the claim", () => {
    expect(judge(4, 89.5, true)).toBe(true);
    expect(state.fastestLapRecord).toEqual({ lapTime: 89.5, carIdx: PLAYER, isPlayer: true, carNumber: "1" });
    expect(state.fastestLapClaim).toEqual({
      lap: 4,
      record: { lapTime: 89.5, carIdx: PLAYER, isPlayer: true, carNumber: "1" },
      previous: { lapTime: 90, carIdx: 1, isPlayer: false, carNumber: "07" },
    });
  });

  it("an unknown validity counts as valid", () => {
    expect(judge(4, 89.5, undefined)).toBe(true);
  });

  it.each([
    ["an invalid lap", 4, 89.5, false, {}],
    ["a slower lap", 4, 90.5, true, {}],
    ["an equal lap", 4, 90, true, {}],
    ["a non-race session", 4, 89.5, true, { isRace: false }],
    ["an unresolved player", 4, 89.5, true, { player: -1 }],
  ] as const)("refuses %s, leaving the record and no claim", (_name, lap, lapTime, lapIsValid, opts) => {
    expect(judge(lap, lapTime, lapIsValid, opts)).toBe(false);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });
    expect(state.fastestLapClaim).toBeNull();
  });

  it("refuses a pre-green tick", () => {
    field.SessionState = SessionState.ParadeLaps;

    expect(judge(4, 89.5, true)).toBe(false);
    expect(state.fastestLapClaim).toBeNull();
  });

  it("refuses the lap-0 parade crossing through the shared predicate, while the same lap as lap 1 claims (the positive control)", () => {
    const empty = createInitialState();
    const parade = makeField({ CarIdxBestLapTime: [-1, -1, -1, -1, -1] });
    expect(run(empty, parade)).toEqual([]);
    expect(empty.fastestLapRecord).toBeNull();

    const judgeOn = (lap: number): boolean =>
      createFastestLapJudge(empty, parade as unknown as TelemetryData, SESSION_INFO, PLAYER, true)(lap, 200, true);

    expect(judgeOn(0)).toBe(false);
    expect(empty.fastestLapRecord).toBeNull();
    expect(judgeOn(1)).toBe(true);
    expect(empty.fastestLapRecord).toMatchObject({ isPlayer: true, lapTime: 200 });
  });

  it("the first timed lap of the class claims with no previous", () => {
    const empty = createInitialState();
    const parade = makeField();
    run(empty, parade);

    expect(
      resolvePlayerFastestLap(empty, parade as unknown as TelemetryData, SESSION_INFO, PLAYER, true, 1, 95, true),
    ).toBe(true);
    expect(empty.fastestLapClaim).toMatchObject({ lap: 1, previous: null });
  });

  it("the claim is published on the same tick, right away, with the player's lap as the lap count, then cleared", () => {
    judge(4, 89.5, true);

    const events = fastestLapEvents(run(state, field));

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
    expect(state.fastestLapClaim).toBeNull();
    expect(run(state, field)).toEqual([]);
  });

  it("a claim is published before any gate of the diff: on a non-race or pre-green tick too, and never on the next tick", () => {
    judge(4, 89.5, true);
    field.SessionState = SessionState.ParadeLaps;

    expect(fastestLapEvents(run(state, field, { isRace: false }))).toHaveLength(1);
    expect(state.fastestLapClaim).toBeNull();
    expect(run(state, field, { isRace: false })).toEqual([]);
    expect(run(state, field)).toEqual([]);
  });

  it("a remote car beating the player's record names the player as the beaten holder", () => {
    judge(4, 89.5, true);
    run(state, field);

    field.CarIdxBestLapTime[2] = 89;
    const events = fastestLapEvents(run(state, field));

    expect(events).toHaveLength(1);
    expect(events[0]!.previous).toEqual({ carIdx: PLAYER, lapTime: 89.5, isPlayer: true, carNumber: "1" });
  });

  it("the player's best refreshing to the claimed time afterwards emits nothing", () => {
    judge(4, 89.5, true);
    run(state, field);
    field.CarIdxBestLapTime[PLAYER] = 89.5;

    expect(run(state, field)).toEqual([]);
  });
});

describe("diffFastestLap — across a replay glance (the baselines re-seed, the record survives)", () => {
  /** What `wipeStateForReplay` does to this diff's state: the baselines go, the record and its first-seed mark stay. */
  function glance(state: TranslatorState): void {
    state.fastestLapBaselines = [];
    state.fastestLapBaselinesSeeded = false;
  }

  it("re-seeds silently and absorbs a remote car whose best fell below the kept record during the glance, as the holder", () => {
    const { state, field } = seededState();
    glance(state);
    field.CarIdxBestLapTime[2] = 89;

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapRecord).toEqual({ lapTime: 89, carIdx: 2, isPlayer: false, carNumber: "22" });
    expect(state.fastestLapBaselines).toEqual([92, 90, 89, 0, 0]);
  });

  it("does not read the player's best on a re-seed, while a connect's first seed does (the positive control)", () => {
    const { state, field } = seededState();
    glance(state);
    field.CarIdxBestLapTime[PLAYER] = 80;

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });

    const fresh = createInitialState();
    expect(run(fresh, field)).toEqual([]);
    expect(fresh.fastestLapRecord).toMatchObject({ carIdx: PLAYER, lapTime: 80, isPlayer: true });
  });

  it("a glance before any eligible lap still counts as the first seed, so the way back excludes the player", () => {
    const state = createInitialState();
    const field = makeField();
    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapRecord).toBeNull();
    expect(state.fastestLapRaceSeeded).toBe(true);

    glance(state);
    field.CarIdxBestLapTime[PLAYER] = 80;
    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapRecord).toBeNull();
  });

  it("a departed holder keeps the record across the glance: a car slower than it but faster than the rest emits nothing, a faster one emits", () => {
    const { state, field } = seededState();
    glance(state);
    field.CarIdxBestLapTime[1] = -1;

    expect(run(state, field)).toEqual([]);
    expect(state.fastestLapRecord).toMatchObject({ carIdx: 1, lapTime: 90 });

    field.CarIdxBestLapTime[2] = 90.5;
    expect(run(state, field)).toEqual([]);

    field.CarIdxBestLapTime[2] = 89.9;
    const events = fastestLapEvents(run(state, field));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ carIdx: 2, lapTime: 89.9, previous: { carIdx: 1, lapTime: 90 } });
  });
});
