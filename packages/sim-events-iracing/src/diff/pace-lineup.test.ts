import { carInWorld, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { calculateCanonicalRacePositions } from "../race-order.js";
import { createInitialState } from "../state.js";
import { MIN_LINE_POPULATION, type PaceLineup, resolveCarAheadInLine, resolvePaceLineup } from "./pace-lineup.js";

const ticks = JSON.parse(
  readFileSync(new URL("./__fixtures__/caution-restart-20260917.json", import.meta.url), "utf-8"),
) as Array<{ t: number; CarIdxPaceLine: number[]; CarIdxPaceRow: number[] }>;

/** The pace car's index in real telemetry (slot 20 in the fixture's trimmed arrays). */
const PACE = 64;

/** A car in no drive-round procedure — what every tick without `CarIdxPaceFlags` reads. */
const NO_PACE_FLAGS = { endOfLine: false, freePass: false, wavedAround: false };

/** Per-car pace arrays at real telemetry width; every slot not named sits out of the lineup. */
function paceArrays(cars: Array<[carIdx: number, line: number, row: number]>): TelemetryData {
  const lines = new Array(72).fill(-1);
  const rows = new Array(72).fill(-1);

  for (const [carIdx, line, row] of cars) {
    lines[carIdx] = line;
    rows[carIdx] = row;
  }

  return { CarIdxPaceLine: lines, CarIdxPaceRow: rows } as unknown as TelemetryData;
}

/** Session info naming the player and (by default) the pace car, plus an optional driver list. */
function session(
  playerCarIdx: number,
  options: { drivers?: Array<Record<string, unknown>>; paceCarIdx?: number | null } = {},
): Record<string, unknown> {
  const driverInfo: Record<string, unknown> = {
    DriverCarIdx: playerCarIdx,
    Drivers: options.drivers ?? [],
  };
  const paceCarIdx = options.paceCarIdx === undefined ? PACE : options.paceCarIdx;

  if (paceCarIdx !== null) driverInfo.PaceCarIdx = paceCarIdx;

  return { DriverInfo: driverInfo };
}

/**
 * The single-file shape: the pace car at line 0 row 0 and the field behind it
 * at rows 1..N, all on line 0.
 */
const SINGLE_FILE: Array<[number, number, number]> = [
  [PACE, 0, 0],
  [1, 0, 1],
  [2, 0, 2],
  [3, 0, 3],
];

/**
 * The double-file shape. Rows are numbered PER LINE and the two lines
 * interleave with line 0 one row ahead, because the pace car consumes line 0's
 * row 0: P1 = line 0 row 1, P2 = line 1 row 0, P3 = line 0 row 2, P4 = line 1
 * row 1. Verified against the committed fixture below.
 */
const DOUBLE_FILE: Array<[number, number, number]> = [
  [PACE, 0, 0],
  [1, 0, 1], // P1
  [2, 1, 0], // P2
  [3, 0, 2], // P3
  [4, 1, 1], // P4
  [5, 0, 3], // P5
  [6, 1, 2], // P6
];

describe("resolvePaceLineup — a car that has left the world (2026-09-18 road capture, 548.33 s)", () => {
  // Car 8 read NotInWorld and still held line 0 row 6 for one tick before its
  // row went to −1 and the rows closed up. In that capture it sat BEHIND the
  // player; here it sits directly ahead, which is where the rule bites.
  function withWorld(telemetry: TelemetryData, gone: number[]): TelemetryData {
    const dist = new Array(72).fill(0.5);
    const surface = new Array(72).fill(3);

    for (const carIdx of gone) {
      dist[carIdx] = -1;
      surface[carIdx] = -1; // TrkLoc.NotInWorld
    }

    return { ...telemetry, CarIdxLapDistPct: dist, CarIdxTrackSurface: surface } as TelemetryData;
  }

  it("names the nearest car still in the world as the one to follow, and does not count the ghost row — single file", () => {
    expect(resolvePaceLineup(withWorld(paceArrays(SINGLE_FILE), [2]), session(3), false)).toMatchObject({
      followCarIdx: 1,
      followsPaceCar: false,
      lineupPosition: 2,
    });
  });

  it("and double file, in the player's own line", () => {
    // Player 5 at line 0 row 3; car 3 (line 0 row 2) gone — so car 1 (line 0
    // row 1) is the one ahead, and the combined order counts cars 1, 2 and 4.
    expect(resolvePaceLineup(withWorld(paceArrays(DOUBLE_FILE), [3]), session(5), true)).toMatchObject({
      followCarIdx: 1,
      followsPaceCar: false,
      lineupPosition: 4,
      line: "inside",
    });
  });

  it("follows the pace car when every car ahead in the line has gone", () => {
    expect(resolvePaceLineup(withWorld(paceArrays(SINGLE_FILE), [1, 2]), session(3), false)).toMatchObject({
      followCarIdx: PACE,
      followsPaceCar: true,
      lineupPosition: 1,
      isLeader: true,
    });
  });

  it("counts every car as present when the telemetry carries no lap progress — fixtures cut without it are unchanged", () => {
    expect(resolvePaceLineup(paceArrays(SINGLE_FILE), session(3), false)).toMatchObject({
      followCarIdx: 2,
      lineupPosition: 3,
    });
  });
});

describe("resolvePaceLineup — who to follow", () => {
  it("follows the car one row lower in single file", () => {
    const lineup = resolvePaceLineup(paceArrays(SINGLE_FILE), session(3), false);

    expect(lineup).toMatchObject({ followCarIdx: 2, followsPaceCar: false, isLeader: false, doubleFile: false });
  });

  it("makes the front car follow the pace car", () => {
    const lineup = resolvePaceLineup(paceArrays(SINGLE_FILE), session(1), false);

    expect(lineup).toMatchObject({ followCarIdx: PACE, followsPaceCar: true, isLeader: true, lineupPosition: 1 });
  });

  it("follows the car one row lower in the SAME line when double file", () => {
    // Car 4 is line 1 row 1 (P4). The car one row lower in its own line is car
    // 2 (line 1 row 0) — NOT car 3, which holds row 1 on the other line.
    const lineup = resolvePaceLineup(paceArrays(DOUBLE_FILE), session(4), false);

    expect(lineup).toMatchObject({ followCarIdx: 2, followsPaceCar: false, isLeader: false, doubleFile: true });
  });

  it("makes the outside front car follow the pace car", () => {
    // Car 2 is line 1 row 0: there is no row -1 in its line, so the only car in
    // front of it is the pace car.
    const lineup = resolvePaceLineup(paceArrays(DOUBLE_FILE), session(2), false);

    // Following the pace car, and NOT leading: car 2 restarts second. The two
    // questions are the same single file and different double file, and each
    // becomes a script condition a pack author can only write or negate.
    expect(lineup).toMatchObject({
      followCarIdx: PACE,
      followsPaceCar: true,
      isLeader: false,
      lineupPosition: 2,
    });
  });

  it("calls the inside front car the leader, and only that car", () => {
    const leader = resolvePaceLineup(paceArrays(DOUBLE_FILE), session(1), false);

    expect(leader).toMatchObject({ followsPaceCar: true, isLeader: true, lineupPosition: 1 });
  });

  it("does not read a single stray car on a second line as a double-file field", () => {
    // One car carrying a line value of its own — a stray, or a mid-transition
    // reading — must not flip the whole field onto the interleave: single file,
    // car 3 restarts THIRD (row 3), and the interleave would call it fifth
    // (2 × 3 − 1) and move `isLeader` off car 1. A column is a population.
    const stray: Array<[number, number, number]> = [...SINGLE_FILE, [7, 1, 6]];

    expect(resolvePaceLineup(paceArrays(stray), session(3), true)).toMatchObject({
      doubleFile: false,
      lineupPosition: 3,
      line: null,
      isLeader: false,
    });
    expect(resolvePaceLineup(paceArrays(stray), session(1), true)).toMatchObject({
      isLeader: true,
      lineupPosition: 1,
    });
  });

  it("withholds every answer when the PLAYER is the stray car — never 'you restart first' on a mid-transition line value", () => {
    // The same [7, 1, 6] reading, with car 7 as the player. `isDoubleFile`
    // protects the FIELD from the stray value, but every "in my line" question
    // is then asked of line 1, which holds nobody else: no car ahead, so the
    // follow call would say it is just him and the pace car; nobody with a
    // lower row, so he would restart FIRST and `isLeader` would be true. What
    // his row means on a line the field is not on cannot be known, so nothing
    // is claimed — the follow call drops to "behind the car ahead", the
    // one-to-go call to its plain wording, and the lineup-changed diff reads
    // the tick as no news.
    const stray: Array<[number, number, number]> = [...SINGLE_FILE, [7, 1, 6]];

    expect(resolvePaceLineup(paceArrays(stray), session(7), true)).toEqual({
      followCarIdx: null,
      followCarNumber: null,
      line: null,
      isLeader: false,
      followsPaceCar: false,
      doubleFile: false,
      lineupPosition: null,
      anchor: null,
      paceFlags: NO_PACE_FLAGS,
    });
  });

  it("reads the same car normally once its line is the field's — the positive control for the stray-player rule", () => {
    const onField: Array<[number, number, number]> = [...SINGLE_FILE, [7, 0, 4]];

    expect(resolvePaceLineup(paceArrays(onField), session(7), true)).toMatchObject({
      followCarIdx: 3,
      followsPaceCar: false,
      isLeader: false,
      lineupPosition: 4,
    });
  });

  it("does not mark a lone driver behind a lone pace car as the stray — every line holding one car names no stray", () => {
    // The smallest field there is: the pace car on line 0, the only driver on
    // line 1. Nothing says which of two singletons is the stray one, so the
    // driver keeps the pace-car answer he had before the rule existed.
    const two: Array<[number, number, number]> = [
      [PACE, 0, 0],
      [1, 1, 0],
    ];

    expect(resolvePaceLineup(paceArrays(two), session(1), false)).toMatchObject({
      followCarIdx: PACE,
      followsPaceCar: true,
    });
  });

  it("reads two cars on the second line as a column — the positive control for the stray-car rule", () => {
    // The bar is a population of MIN_LINE_POPULATION, so the smallest genuine
    // second column flips the field: car 3 is now line 0 row 3 → 2 × 3 − 1 = 5.
    const column: Array<[number, number, number]> = [...SINGLE_FILE, [7, 1, 0], [8, 1, 1]];

    expect(MIN_LINE_POPULATION).toBe(2);
    expect(resolvePaceLineup(paceArrays(column), session(3), true)).toMatchObject({
      doubleFile: true,
      lineupPosition: 5,
      line: "inside",
    });
  });

  it("claims no lead when the restart position cannot be read at all", () => {
    // No pace car to anchor the rows, so there is no position — and a lead is
    // not something to claim on a guess.
    const lineup = resolvePaceLineup(paceArrays(SINGLE_FILE), session(1, { paceCarIdx: null }), false);

    expect(lineup).toMatchObject({ followsPaceCar: false, isLeader: false, lineupPosition: null });
  });

  it("never mistakes a car out of the lineup for the car in front of a front-row car", () => {
    // Car 9 reports its line but no row — the shape a car sitting the re-form
    // out would take if the sim ever wrote one array without the other. A
    // front-row car's "one row lower" is -1, which is exactly what car 9 holds.
    const withStrayCar: Array<[number, number, number]> = [...DOUBLE_FILE, [9, 1, -1]];
    const lineup = resolvePaceLineup(paceArrays(withStrayCar), session(2), false);

    expect(lineup).toMatchObject({ followCarIdx: PACE, followsPaceCar: true });
  });

  it("reads the follow car's number from DriverInfo.Drivers as a string, so a leading zero survives", () => {
    const drivers = [{ CarIdx: 2, CarNumber: "09" }];
    const lineup = resolvePaceLineup(paceArrays(SINGLE_FILE), session(3, { drivers }), false);

    expect(lineup?.followCarNumber).toBe("09");
  });

  it("reads a car number the session YAML left unquoted, which arrives as a number", () => {
    // Issue #869: an unquoted CarNumber reaches us as 42, not "42". Reading
    // strings only would drop every car number in such a session, and every
    // caution line would quietly fall back to its numberless wording.
    const drivers = [{ CarIdx: 2, CarNumber: 42 }];
    const lineup = resolvePaceLineup(paceArrays(SINGLE_FILE), session(3, { drivers }), false);

    expect(lineup?.followCarNumber).toBe("42");
  });

  it("withholds a car number for a follow car the driver list does not carry", () => {
    const lineup = resolvePaceLineup(paceArrays(SINGLE_FILE), session(3), false);

    expect(lineup?.followCarNumber).toBeNull();
  });
});

describe("resolvePaceLineup — the line you are in", () => {
  it("calls pace line 0 the inside on an oval running double file", () => {
    expect(resolvePaceLineup(paceArrays(DOUBLE_FILE), session(3), true)?.line).toBe("inside");
  });

  it("calls pace line 1 the outside on an oval running double file", () => {
    expect(resolvePaceLineup(paceArrays(DOUBLE_FILE), session(4), true)?.line).toBe("outside");
  });

  it("names no line off an oval, whatever the file", () => {
    expect(resolvePaceLineup(paceArrays(DOUBLE_FILE), session(3), false)?.line).toBeNull();
  });

  it("names no line in single file, even on an oval", () => {
    expect(resolvePaceLineup(paceArrays(SINGLE_FILE), session(3), true)?.line).toBeNull();
  });
});

describe("resolvePaceLineup — the restart position", () => {
  it("is the pace row in single file", () => {
    expect(resolvePaceLineup(paceArrays(SINGLE_FILE), session(3), false)?.lineupPosition).toBe(3);
  });

  it("interleaves the two lines when double file", () => {
    const at = (player: number): number | null | undefined =>
      resolvePaceLineup(paceArrays(DOUBLE_FILE), session(player), false)?.lineupPosition;

    expect([at(1), at(2), at(3), at(4), at(5), at(6)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("is withheld once the pace car no longer heads the lineup", () => {
    // The post-green unwind: the pace car has pulled off and line 0 has shifted
    // down a row, so no absolute position can be read off the rows any more.
    const unwound: Array<[number, number, number]> = [
      [1, 0, 0],
      [2, 1, 0],
      [3, 0, 1],
      [4, 1, 1],
    ];

    expect(resolvePaceLineup(paceArrays(unwound), session(3), false)?.lineupPosition).toBeNull();
  });

  it("is withheld when session info names no pace car to anchor the rows on", () => {
    const lineup = resolvePaceLineup(paceArrays(SINGLE_FILE), session(3, { paceCarIdx: null }), false);

    expect(lineup?.lineupPosition).toBeNull();
  });

  it("is withheld for the pace car's own slot rather than reported as position zero", () => {
    const lineup = resolvePaceLineup(paceArrays(SINGLE_FILE), session(PACE), false);

    expect(lineup?.lineupPosition).toBeNull();
  });

  it("is withheld, with no line named, for a third pace line the capture has never shown", () => {
    const threeLines: Array<[number, number, number]> = [...DOUBLE_FILE, [7, 2, 0]];
    const lineup = resolvePaceLineup(paceArrays(threeLines), session(7), true);

    expect(lineup).toMatchObject({ lineupPosition: null, line: null, doubleFile: true });
  });
});

describe("resolvePaceLineup — no lineup to read", () => {
  it("returns null when no car has a pace row", () => {
    expect(resolvePaceLineup(paceArrays([]), session(3), false)).toBeNull();
  });

  it("returns null when the player is not in the lineup the rest of the field is in", () => {
    expect(resolvePaceLineup(paceArrays(SINGLE_FILE), session(9), false)).toBeNull();
  });

  it("returns null without session info to name the player", () => {
    expect(resolvePaceLineup(paceArrays(SINGLE_FILE), null, false)).toBeNull();
  });

  it("returns null when telemetry carries no pace arrays", () => {
    expect(resolvePaceLineup({} as unknown as TelemetryData, session(3), false)).toBeNull();
  });
});

describe("resolvePaceLineup — against the committed capture", () => {
  /** A fixture tick widened back to real telemetry: fixture slot 20 is the pace car. */
  function replayTick(tick: (typeof ticks)[number]): TelemetryData {
    const lines = new Array(72).fill(-1);
    const rows = new Array(72).fill(-1);

    tick.CarIdxPaceLine.forEach((v, i) => (lines[i === 20 ? PACE : i] = v));
    tick.CarIdxPaceRow.forEach((v, i) => (rows[i === 20 ? PACE : i] = v));

    return { CarIdxPaceLine: lines, CarIdxPaceRow: rows } as unknown as TelemetryData;
  }

  function tickAt(t: number): TelemetryData {
    const tick = ticks.find((candidate) => candidate.t === t);

    if (!tick) throw new Error(`no fixture tick at t=${t}`);

    return replayTick(tick);
  }

  /**
   * Every restart position the 20 captured cars resolve to at a given tick, as
   * `position → carIdx`. A Map rather than an array indexed by position: a
   * sparse array's holes are SKIPPED by `every`/`forEach`, so an assertion over
   * one passes however few cars actually placed — which is how the first
   * version of the sweep below covered two ticks while claiming 193.
   */
  function positionsAt(telemetry: TelemetryData): Map<number, number> {
    const order = new Map<number, number>();

    for (let carIdx = 0; carIdx < 20; carIdx++) {
      const position = resolvePaceLineup(telemetry, session(carIdx), true)?.lineupPosition;

      if (typeof position === "number") order.set(position, carIdx);
    }

    return order;
  }

  /** The cars the tick puts in the lineup at all, pace car excluded. */
  function linedUpCount(telemetry: TelemetryData): number {
    const rows = telemetry.CarIdxPaceRow as number[];

    let count = 0;

    for (let carIdx = 0; carIdx < 20; carIdx++) {
      if (rows[carIdx] >= 0) count++;
    }

    return count;
  }

  /** The running order a tick yields, read off by ascending restart position. */
  function orderAt(telemetry: TelemetryData): number[] {
    const positions = positionsAt(telemetry);

    return [...positions.keys()].sort((a, b) => a - b).map((position) => positions.get(position) as number);
  }

  it("reproduces the single-file order from the double-file re-form", () => {
    // t=239.93 is the first tick of the caution's single-file lineup; t=415.1
    // is the double-file re-form at one to go. Nobody pitted between them (spec
    // finding 7), so the two orders must be identical — which is the whole
    // proof of the interleave.
    const single = orderAt(tickAt(239.93));
    const double = orderAt(tickAt(415.1));

    expect(single).toHaveLength(20);
    expect(double).toEqual(single);
  });

  it("gives every car in the capture a contiguous restart position while the pace car leads", () => {
    let anchored = 0;

    for (const tick of ticks) {
      const telemetry = replayTick(tick);
      const rows = telemetry.CarIdxPaceRow as number[];
      const lines = telemetry.CarIdxPaceLine as number[];

      if (rows[PACE] !== 0 || lines[PACE] !== 0) continue;

      anchored++;

      const expected = linedUpCount(telemetry);
      const positions = positionsAt(telemetry);

      // Every lined-up car placed (so nothing was skipped), and no two claimed
      // the same position (which the Map would have collapsed into one entry),
      // and the positions run 1..N with no gap.
      expect({ t: tick.t, placed: positions.size }).toEqual({ t: tick.t, placed: expected });
      expect([...positions.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: expected }, (_, at) => at + 1));
    }

    // 193 of the fixture's 284 ticks carry a pace-car-led lineup; the rest are
    // the pre-caution green run and the post-green unwind.
    expect(anchored).toBe(193);
  });
});

describe("resolvePaceLineup — uneven lanes (the 2026-09-19 snapshot)", () => {
  // The maintainer heard "P21" in a 20-car field. Line 0 held 11 cars (rows
  // 1..11) and line 1 held 9 (rows 0..8): a lapped car and the waved-around
  // player had gone to the tail of one lane, and `line 0, row R → 2R − 1` gave
  // the player, at line 0 row 11, a position no 20-car field can have. The
  // balanced 2026-09-17 fixture above cannot tell the two formulas apart; this
  // one can.
  const [snapshot] = JSON.parse(
    readFileSync(new URL("./__fixtures__/caution-lineup-20260919.json", import.meta.url), "utf-8"),
  ) as Array<{ CarIdxPaceLine: number[]; CarIdxPaceRow: number[] }>;

  /** The fixture tick widened back to real telemetry: slot 20 is the pace car. */
  function snapshotTelemetry(): TelemetryData {
    const lines = new Array(72).fill(-1);
    const rows = new Array(72).fill(-1);

    snapshot.CarIdxPaceLine.forEach((v, i) => (lines[i === 20 ? PACE : i] = v));
    snapshot.CarIdxPaceRow.forEach((v, i) => (rows[i === 20 ? PACE : i] = v));

    return { CarIdxPaceLine: lines, CarIdxPaceRow: rows } as unknown as TelemetryData;
  }

  const PLAYER = 0; // car #64, line 0 row 11
  const LEADER = 19; // car #22, line 0 row 1
  const LAPPED = 7; // car #7, line 0 row 10 — two laps down, ahead of the player in the lineup

  it("gives the player position 20, not 21", () => {
    const lineup = resolvePaceLineup(snapshotTelemetry(), session(PLAYER), true);

    expect(lineup).toMatchObject({ lineupPosition: 20, doubleFile: true, line: "inside", isLeader: false });
    expect(lineup?.followCarIdx).toBe(LAPPED);
  });

  it("still resolves the leader as position 1, and only the leader", () => {
    expect(resolvePaceLineup(snapshotTelemetry(), session(LEADER), true)).toMatchObject({
      lineupPosition: 1,
      isLeader: true,
      followsPaceCar: true,
    });

    for (let carIdx = 0; carIdx < 20; carIdx++) {
      if (carIdx === LEADER) continue;

      expect(resolvePaceLineup(snapshotTelemetry(), session(carIdx), true)?.isLeader, `car ${carIdx}`).toBe(false);
    }
  });

  it("places all 20 cars at 1..20 with no gap and no position claimed twice", () => {
    const positions = new Map<number, number>();

    for (let carIdx = 0; carIdx < 20; carIdx++) {
      const position = resolvePaceLineup(snapshotTelemetry(), session(carIdx), true)?.lineupPosition;

      if (typeof position === "number") positions.set(position, carIdx);
    }

    expect(positions.size).toBe(20);
    expect([...positions.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, at) => at + 1));
    // The lapped car is 19th in the LINEUP — one row ahead of the player — and
    // 20th in the race, which is why the position call does not speak this
    // number (`caution-lineup-20260919.test.ts` has the race order).
    expect(positions.get(19)).toBe(LAPPED);
    expect(positions.get(20)).toBe(PLAYER);
  });

  it("counts a short second lane without leaving holes — the rule in the abstract", () => {
    // Line 0: rows 1..4; line 1: rows 0..1 only. The combined order is
    // (1,0) (1,1) (2,0) (2,1) (3,0) (4,0) → positions 1..6, and the closed
    // formula's `2R − 1` would have skipped 6 and 7 to give the last car 7.
    const uneven: Array<[number, number, number]> = [
      [PACE, 0, 0],
      [1, 0, 1],
      [2, 1, 0],
      [3, 0, 2],
      [4, 1, 1],
      [5, 0, 3],
      [6, 0, 4],
    ];
    const at = (player: number): number | null | undefined =>
      resolvePaceLineup(paceArrays(uneven), session(player), false)?.lineupPosition;

    expect([at(1), at(2), at(3), at(4), at(5), at(6)]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

/** The same pace arrays with the session in a given state — the phase half of the `grid` anchor. */
function inState(telemetry: TelemetryData, state: SessionState): TelemetryData {
  return { ...telemetry, SessionState: state } as TelemetryData;
}

/**
 * {@link session} in a RACE session. The `grid` anchor is read only where the
 * canonical order serves the qualifying grid — a race, before its green — so
 * every formation below needs a session that says it is one.
 */
function raceSession(
  playerCarIdx: number,
  options: { drivers?: Array<Record<string, unknown>>; paceCarIdx?: number | null; sessionType?: string } = {},
): Record<string, unknown> {
  return {
    ...session(playerCarIdx, options),
    SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: options.sessionType ?? "Race" }] },
  };
}

describe("resolvePaceLineup — the anchor, read from the tick (#1167)", () => {
  /**
   * A rolling-start formation, double file: the pace car leads from the road
   * and holds NO row, the pole holds line 0 row 0, and line 1 is level with
   * line 0 — P1 = line 0 row 0, P2 = line 1 row 0, P3 = line 0 row 1.
   */
  const GRID_DOUBLE: Array<[number, number, number]> = [
    [1, 0, 0], // P1, the pole
    [2, 1, 0], // P2
    [3, 0, 1], // P3
    [4, 1, 1], // P4
    [5, 0, 2], // P5
    [6, 1, 2], // P6
  ];

  /** The same formation single file: rows 0..3 on line 0, nobody on line 1. */
  const GRID_SINGLE: Array<[number, number, number]> = [
    [1, 0, 0],
    [2, 0, 1],
    [3, 0, 2],
    [4, 0, 3],
  ];

  const formation = (cars: Array<[number, number, number]>): TelemetryData =>
    inState(paceArrays(cars), SessionState.ParadeLaps);

  function positionsOf(telemetry: TelemetryData, cars: number[]): Array<number | null | undefined> {
    return cars.map((carIdx) => resolvePaceLineup(telemetry, raceSession(carIdx), false)?.lineupPosition);
  }

  describe("`pace-car` — the pace car holds line 0 row 0", () => {
    it("is the caution's frame: line 1 one row behind line 0", () => {
      const telemetry = inState(paceArrays(DOUBLE_FILE), SessionState.Racing);

      expect(resolvePaceLineup(telemetry, raceSession(3), true)?.anchor).toBe("pace-car");
      expect(positionsOf(telemetry, [1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("holds whatever the phase — a rolling start whose pace car took line 0 row 0 gets the caution's arithmetic", () => {
      // The two anchors exclude each other by the pace car's slot, so this one
      // is never overridden by the session being before its green.
      for (const telemetry of [paceArrays(DOUBLE_FILE), formation(DOUBLE_FILE)]) {
        expect(resolvePaceLineup(telemetry, raceSession(2), true)).toMatchObject({
          anchor: "pace-car",
          lineupPosition: 2,
        });
        expect(positionsOf(telemetry, [1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);
      }
    });

    it("does not hold when a racing car reads line 0 row 0 as well — the slot the frame hangs on says two things", () => {
      // One of the two readings is wrong and nothing says which, so no number
      // is handed out to anyone: not to the car in the pace car's slot, and
      // not to the cars counted from it.
      const contradictory: Array<[number, number, number]> = [...DOUBLE_FILE, [9, 0, 0]];

      for (const state of [SessionState.Racing, SessionState.ParadeLaps]) {
        const telemetry = inState(paceArrays(contradictory), state);

        expect(positionsOf(telemetry, [1, 2, 3, 4, 5, 6, 9]), SessionState[state]).toEqual(new Array(7).fill(null));

        for (const carIdx of [1, 2, 3, 4, 5, 6, 9]) {
          expect(resolvePaceLineup(telemetry, raceSession(carIdx), true), `car ${carIdx}`).toMatchObject({
            anchor: null,
            isLeader: false,
          });
        }

        // The car ahead and the lane are still answered.
        expect(resolvePaceLineup(telemetry, raceSession(4), true)).toMatchObject({
          followCarIdx: 2,
          followsPaceCar: false,
          line: "outside",
          doubleFile: true,
        });
      }
    });
  });

  describe("`grid` — before the green, the pace car without a row, a car at line 0 row 0", () => {
    it("numbers the field (row, line): pole L0R0 = 1, L1R0 = 2, L0R1 = 3", () => {
      const telemetry = formation(GRID_DOUBLE);

      expect(positionsOf(telemetry, [1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);

      for (const carIdx of [1, 2, 3, 4, 5, 6]) {
        expect(resolvePaceLineup(telemetry, raceSession(carIdx), true)?.anchor, `car ${carIdx}`).toBe("grid");
      }
    });

    it("is neither frame once the pace car reads line 0 row 0 beside the pole — the same six slots, no numbers", () => {
      // The grid's rows with the pace car put on the pole's slot as well. It
      // is not the caution's frame, whose pace car is alone there, and it is
      // not the grid's, whose pace car holds no row.
      const contradictory = formation([[PACE, 0, 0], ...GRID_DOUBLE]);

      expect(positionsOf(contradictory, [1, 2, 3, 4, 5, 6])).toEqual(new Array(6).fill(null));
      expect(resolvePaceLineup(contradictory, raceSession(2), true)).toMatchObject({ anchor: null, isLeader: false });
    });

    it("needs exactly one car at line 0 row 0 — two poles are no grid", () => {
      const twoPoles = formation([...GRID_DOUBLE, [9, 0, 0]]);

      expect(positionsOf(twoPoles, [1, 2, 3, 4, 5, 6, 9])).toEqual(new Array(7).fill(null));
      expect(resolvePaceLineup(twoPoles, raceSession(1), true)).toMatchObject({ anchor: null, isLeader: false });
      expect(resolvePaceLineup(twoPoles, raceSession(9), true)).toMatchObject({ anchor: null, isLeader: false });
    });

    it("holds through every KNOWN pre-green state", () => {
      for (const state of [SessionState.GetInCar, SessionState.Warmup, SessionState.ParadeLaps]) {
        const lineup = resolvePaceLineup(inState(paceArrays(GRID_DOUBLE), state), raceSession(4), true);

        expect(lineup, SessionState[state]).toMatchObject({ anchor: "grid", lineupPosition: 4 });
      }
    });

    it("makes the pole the leader, following the pace car", () => {
      expect(resolvePaceLineup(formation(GRID_DOUBLE), raceSession(1), true)).toMatchObject({
        anchor: "grid",
        lineupPosition: 1,
        isLeader: true,
        followsPaceCar: true,
        followCarIdx: PACE,
        line: "inside",
      });
    });

    it("has the outside pole follow the pace car without leading", () => {
      expect(resolvePaceLineup(formation(GRID_DOUBLE), raceSession(2), true)).toMatchObject({
        anchor: "grid",
        lineupPosition: 2,
        isLeader: false,
        followsPaceCar: true,
        followCarIdx: PACE,
        line: "outside",
      });
    });

    it("names the car one row lower in the same line, exactly as under a caution", () => {
      expect(resolvePaceLineup(formation(GRID_DOUBLE), raceSession(6), true)).toMatchObject({
        followCarIdx: 4,
        followsPaceCar: false,
        line: "outside",
        lineupPosition: 6,
      });
    });

    it("counts uneven lanes without leaving holes", () => {
      // Line 0: rows 0..3; line 1: rows 0..1 only.
      const uneven: Array<[number, number, number]> = [
        [1, 0, 0],
        [2, 1, 0],
        [3, 0, 1],
        [4, 1, 1],
        [5, 0, 2],
        [6, 0, 3],
      ];

      expect(positionsOf(formation(uneven), [1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("walks past a car that is not in the world, and still counts it — it holds its slot until it arrives", () => {
      // Player 5 at line 0 row 2; car 3 (line 0 row 1) holds its row and is
      // not in the world. The car to form up behind is car 1, who is there;
      // the player is fifth all the same, with cars 1, 2, 3 and 4 ahead.
      const dist = new Array(72).fill(0.5);
      const surface = new Array(72).fill(3);

      dist[3] = -1;
      surface[3] = -1; // TrkLoc.NotInWorld

      const telemetry = {
        ...formation(GRID_DOUBLE),
        CarIdxLapDistPct: dist,
        CarIdxTrackSurface: surface,
      } as TelemetryData;

      expect(resolvePaceLineup(telemetry, raceSession(5), true)).toMatchObject({
        anchor: "grid",
        followCarIdx: 1,
        lineupPosition: 5,
        line: "inside",
      });
    });

    /** {@link GRID_DOUBLE} in ParadeLaps with the named cars holding their rows but not in the world. */
    function withAbsent(absent: number[]): TelemetryData {
      const dist = new Array(72).fill(0.5);
      const surface = new Array(72).fill(3);

      for (const carIdx of absent) {
        dist[carIdx] = -1;
        surface[carIdx] = -1; // TrkLoc.NotInWorld
      }

      return { ...formation(GRID_DOUBLE), CarIdxLapDistPct: dist, CarIdxTrackSurface: surface } as TelemetryData;
    }

    it("leaves the outside pole second behind an absent pole — never told he is on pole", () => {
      // The pole (car 1) holds line 0 row 0 and has not arrived. The canonical
      // order keeps him on his qualifying slot, and so does the lineup.
      const telemetry = withAbsent([1]);

      expect(positionsOf(telemetry, [1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);
      expect(resolvePaceLineup(telemetry, raceSession(2), true)).toMatchObject({
        anchor: "grid",
        lineupPosition: 2,
        isLeader: false,
        followsPaceCar: true,
      });
      // Car 3, behind the empty pole slot, has only the pace car physically
      // ahead in its line — and is third, not second.
      expect(resolvePaceLineup(telemetry, raceSession(3), true)).toMatchObject({
        anchor: "grid",
        lineupPosition: 3,
        isLeader: false,
        followsPaceCar: true,
        followCarIdx: PACE,
      });
    });

    it("leaves line 0 row 1 third with both front-row cars absent", () => {
      const telemetry = withAbsent([1, 2]);

      expect(resolvePaceLineup(telemetry, raceSession(3), true)).toMatchObject({
        anchor: "grid",
        lineupPosition: 3,
        isLeader: false,
        followsPaceCar: true,
      });
      expect(positionsOf(telemetry, [3, 4, 5, 6])).toEqual([3, 4, 5, 6]);
    });

    it("still skips a car that is not in the world behind the pace car — the count changed on the grid only", () => {
      // The same absence in the caution's frame: there it is the one-tick
      // ghost of a car that left, and it is not counted.
      const dist = new Array(72).fill(0.5);
      const surface = new Array(72).fill(3);

      dist[1] = -1;
      surface[1] = -1;

      const telemetry = {
        ...formation(DOUBLE_FILE),
        CarIdxLapDistPct: dist,
        CarIdxTrackSurface: surface,
      } as TelemetryData;

      expect(resolvePaceLineup(telemetry, raceSession(2), true)).toMatchObject({
        anchor: "pace-car",
        lineupPosition: 1,
        isLeader: true,
      });
    });

    it("withholds every answer for a stray player, as under a caution", () => {
      const stray: Array<[number, number, number]> = [...GRID_SINGLE, [7, 1, 5]];

      expect(resolvePaceLineup(formation(stray), raceSession(7), true)).toEqual({
        followCarIdx: null,
        followCarNumber: null,
        line: null,
        isLeader: false,
        followsPaceCar: false,
        doubleFile: false,
        lineupPosition: null,
        anchor: null,
        paceFlags: NO_PACE_FLAGS,
      });
    });
  });

  describe("a grid too thin to say one column from two", () => {
    // A column is a population of two, so these read single file. Behind the
    // pace car the pace car itself sits on line 0 and marks the lone car on
    // line 1 as the stray; on the grid it holds no row, so the count refuses
    // instead of placing two cars first.
    const WITHHELD = {
      followCarIdx: null,
      followCarNumber: null,
      line: null,
      isLeader: false,
      followsPaceCar: false,
      doubleFile: false,
      lineupPosition: null,
      anchor: null,
      paceFlags: NO_PACE_FLAGS,
    };

    it("two cars, one to a line: the pole leads, and the car alongside is not placed", () => {
      const twoCars = formation([
        [1, 0, 0],
        [2, 1, 0],
      ]);

      expect(resolvePaceLineup(twoCars, raceSession(1), true)).toMatchObject({
        anchor: "grid",
        lineupPosition: 1,
        isLeader: true,
        followsPaceCar: true,
        followCarIdx: PACE,
      });
      // Not first on a line of his own — and the rest is still answered.
      expect(resolvePaceLineup(twoCars, raceSession(2), true)).toEqual({
        followCarIdx: PACE,
        followCarNumber: null,
        line: null,
        isLeader: false,
        followsPaceCar: true,
        doubleFile: false,
        lineupPosition: null,
        anchor: null,
        paceFlags: NO_PACE_FLAGS,
      });
    });

    it("three cars: the pole leads, the lone car on line 1 is withheld as a stray, and the third is not called second", () => {
      const threeCars = formation([
        [1, 0, 0],
        [2, 1, 0],
        [3, 0, 1],
      ]);

      expect(resolvePaceLineup(threeCars, raceSession(1), true)).toMatchObject({
        anchor: "grid",
        lineupPosition: 1,
        isLeader: true,
      });
      // One car on line 1 against two on line 0: the stray-player rule.
      expect(resolvePaceLineup(threeCars, raceSession(2), true)).toEqual(WITHHELD);
      // Counted along line 0 alone he would be second; he is third.
      expect(resolvePaceLineup(threeCars, raceSession(3), true)).toMatchObject({
        anchor: null,
        lineupPosition: null,
        isLeader: false,
        followCarIdx: 1,
        followsPaceCar: false,
      });
    });

    it("four on the grid with the third holding no row: nobody on line 1 is called the leader", () => {
      // Line 0 row 0, line 1 row 0, line 1 row 1 — the car that would be at
      // line 0 row 1 has no row.
      const noThird = formation([
        [1, 0, 0],
        [2, 1, 0],
        [4, 1, 1],
      ]);

      // Alone on line 0 against two on line 1, the pole is the shape of a
      // stray reading and gets no answer at all — so nobody is told he leads.
      expect(resolvePaceLineup(noThird, raceSession(1), true)).toEqual(WITHHELD);
      expect(resolvePaceLineup(noThird, raceSession(2), true)).toMatchObject({
        anchor: null,
        lineupPosition: null,
        isLeader: false,
        followsPaceCar: true,
        followCarIdx: PACE,
      });
      expect(resolvePaceLineup(noThird, raceSession(4), true)).toMatchObject({
        anchor: null,
        lineupPosition: null,
        isLeader: false,
        followCarIdx: 2,
        followsPaceCar: false,
      });
    });

    it("a single-file grid with one car on a second line: only the pole keeps its number", () => {
      const withStray = formation([...GRID_SINGLE, [7, 1, 2]]);

      expect(positionsOf(withStray, [1, 2, 3, 4])).toEqual([1, null, null, null]);
      expect(resolvePaceLineup(withStray, raceSession(3), true)).toMatchObject({
        followCarIdx: 2,
        followsPaceCar: false,
        isLeader: false,
      });
      expect(resolvePaceLineup(withStray, raceSession(7), true)).toEqual(WITHHELD);
    });

    it("is a rule of the grid frame only — behind the pace car the same stray is still ignored", () => {
      // The positive control: the caution's single file with a car on a second
      // line keeps its positions, as it did before the grid frame existed.
      const withStray = inState(paceArrays([...SINGLE_FILE, [7, 1, 6]]), SessionState.Racing);

      expect(positionsOf(withStray, [1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("stops applying at two cars to a line — the smallest grid that reads double file is placed in full", () => {
      const fourCars = formation([
        [1, 0, 0],
        [2, 1, 0],
        [3, 0, 1],
        [4, 1, 1],
      ]);

      expect(positionsOf(fourCars, [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    });
  });

  describe("a single-file formation", () => {
    it("needs no special case: the position is the row plus one, counted", () => {
      const telemetry = formation(GRID_SINGLE);

      expect(positionsOf(telemetry, [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
      expect(resolvePaceLineup(telemetry, raceSession(3), true)).toMatchObject({
        anchor: "grid",
        doubleFile: false,
        line: null,
        followCarIdx: 2,
        followsPaceCar: false,
        isLeader: false,
        lineupPosition: 3,
      });
    });

    it("makes the car at row 0 the leader, with only the pace car ahead", () => {
      expect(resolvePaceLineup(formation(GRID_SINGLE), raceSession(1), true)).toMatchObject({
        anchor: "grid",
        followCarIdx: PACE,
        followsPaceCar: true,
        isLeader: true,
        lineupPosition: 1,
      });
    });

    it("gives the same four cars the same four positions behind the pace car, where the position is the row", () => {
      // One counting rule, two frames: the caution's `row` and the formation's
      // `row + 1`. SINGLE_FILE holds three cars behind the pace car; a fourth
      // makes it the same field as GRID_SINGLE, one row further back.
      const behindPaceCar = inState(paceArrays([...SINGLE_FILE, [4, 0, 4]]), SessionState.Racing);

      expect(resolvePaceLineup(behindPaceCar, raceSession(4), true)?.anchor).toBe("pace-car");
      expect(positionsOf(behindPaceCar, [1, 2, 3, 4])).toEqual(positionsOf(formation(GRID_SINGLE), [1, 2, 3, 4]));
    });
  });

  describe("anything else — the position is withheld, the car ahead and the lane are still answered", () => {
    /** What every withheld case below must still answer for car 3 (line 0 row 1, behind car 1). */
    const STILL_ANSWERED = { followCarIdx: 1, followsPaceCar: false, line: "inside", doubleFile: true };

    it("the grid's shape once the session is racing — the unwind is not a grid", () => {
      // Spec finding 3: from 203.87 s the lineup unwinds with the pace car at
      // −1/−1 and the grid's THIRD car at line 0 row 0. Shape alone would
      // call that car the leader.
      for (const state of [SessionState.Racing, SessionState.Checkered, SessionState.CoolDown]) {
        const telemetry = inState(paceArrays(GRID_DOUBLE), state);

        expect(resolvePaceLineup(telemetry, raceSession(3), true), SessionState[state]).toMatchObject({
          ...STILL_ANSWERED,
          anchor: null,
          lineupPosition: null,
          isLeader: false,
        });
        expect(resolvePaceLineup(telemetry, raceSession(1), true), SessionState[state]).toMatchObject({
          anchor: null,
          lineupPosition: null,
          isLeader: false,
        });
      }
    });

    it("the grid's shape in a session state iRacing has not reported yet", () => {
      // `Invalid` is pre-green to the canonical order, which loses nothing by
      // falling back to the grid there. Here it would be a claim about a phase
      // nobody knows — and the pole would be told he leads on it.
      const telemetry = inState(paceArrays(GRID_DOUBLE), SessionState.Invalid);

      expect(resolvePaceLineup(telemetry, raceSession(3), true)).toMatchObject({
        ...STILL_ANSWERED,
        anchor: null,
        lineupPosition: null,
      });
      expect(resolvePaceLineup(telemetry, raceSession(1), true)).toMatchObject({
        anchor: null,
        lineupPosition: null,
        isLeader: false,
      });
    });

    it("the grid's shape with no session state in the telemetry at all", () => {
      expect(resolvePaceLineup(paceArrays(GRID_DOUBLE), raceSession(3), true)).toMatchObject({
        ...STILL_ANSWERED,
        anchor: null,
        lineupPosition: null,
      });
    });

    it("a formation whose session info does not name the pace car", () => {
      const lineup = resolvePaceLineup(formation(GRID_DOUBLE), raceSession(3, { paceCarIdx: null }), true);

      expect(lineup).toMatchObject({ ...STILL_ANSWERED, anchor: null, lineupPosition: null });
    });

    it("a pace car holding a row that is not line 0 row 0", () => {
      for (const paceSlot of [
        [PACE, 0, 5],
        [PACE, 1, 0],
        [PACE, -1, 0],
      ] as Array<[number, number, number]>) {
        const lineup = resolvePaceLineup(formation([...GRID_DOUBLE, paceSlot]), raceSession(3), true);

        expect(lineup, `pace car at ${paceSlot[1]}/${paceSlot[2]}`).toMatchObject({
          ...STILL_ANSWERED,
          anchor: null,
          lineupPosition: null,
        });
      }
    });

    it("a formation in which nobody holds line 0 row 0", () => {
      // Line 0 numbered from 1 with no pace car at its head: neither frame.
      const headless: Array<[number, number, number]> = [
        [1, 0, 1],
        [2, 1, 0],
        [3, 0, 2],
        [4, 1, 1],
      ];

      expect(resolvePaceLineup(formation(headless), raceSession(3), true)).toMatchObject({
        ...STILL_ANSWERED,
        anchor: null,
        lineupPosition: null,
      });
    });

    it("the formation's shape before the green of a session that is not a race", () => {
      // The canonical order serves the qualifying grid in a race only
      // (`race-order.ts`): `SessionState` reads pre-green in practice and
      // qualifying on transient session-boundary ticks. The lineup asks the
      // same question, so it is a grid to neither there.
      for (const sessionType of ["Practice", "Lone Qualify", "Open Qualify", "Warmup", "Offline Testing"]) {
        const lineup = resolvePaceLineup(formation(GRID_DOUBLE), raceSession(3, { sessionType }), true);

        expect(lineup, sessionType).toMatchObject({ ...STILL_ANSWERED, anchor: null, lineupPosition: null });
      }

      // The positive control: the very same tick in a race is a grid.
      expect(resolvePaceLineup(formation(GRID_DOUBLE), raceSession(3), true)).toMatchObject({
        ...STILL_ANSWERED,
        anchor: "grid",
        lineupPosition: 3,
      });
    });

    it("the formation's shape when session info does not say what kind of session this is", () => {
      // `session()` carries no session list at all.
      expect(resolvePaceLineup(formation(GRID_DOUBLE), session(3), true)).toMatchObject({
        ...STILL_ANSWERED,
        anchor: null,
        lineupPosition: null,
      });
    });

    it("reads the session the telemetry is IN — the qualifying of a weekend that also has a race is not one", () => {
      const weekend = {
        ...session(3),
        SessionInfo: {
          Sessions: [
            { SessionNum: 0, SessionType: "Practice" },
            { SessionNum: 1, SessionType: "Lone Qualify" },
            { SessionNum: 2, SessionType: "Race" },
          ],
        },
      };
      const inSession = (sessionNum: number): TelemetryData =>
        ({ ...formation(GRID_DOUBLE), SessionNum: sessionNum }) as TelemetryData;

      expect(resolvePaceLineup(inSession(1), weekend, true)?.anchor).toBeNull();
      expect(resolvePaceLineup(inSession(2), weekend, true)?.anchor).toBe("grid");
    });

    it("a pace car whose slot the arrays do not carry — unknown is not empty", () => {
      const telemetry = formation(GRID_DOUBLE);
      const narrow = {
        ...telemetry,
        CarIdxPaceLine: (telemetry.CarIdxPaceLine as number[]).slice(0, 20),
        CarIdxPaceRow: (telemetry.CarIdxPaceRow as number[]).slice(0, 20),
      } as TelemetryData;

      expect(resolvePaceLineup(narrow, raceSession(3), true)).toMatchObject({
        ...STILL_ANSWERED,
        anchor: null,
        lineupPosition: null,
      });
    });
  });
});

/** A committed fixture tick: per-car arrays trimmed to cars 0–19 plus the pace car as slot 20 (`__fixtures__/README.md`). */
type CapturedTick = {
  t: number;
  SessionState: number;
  CarIdxPaceLine: number[];
  CarIdxPaceRow: number[];
  CarIdxPosition?: number[];
  CarIdxLapDistPct?: number[];
  CarIdxTrackSurface?: number[];
};

type CapturedFormation = { sessionInfo: Record<string, unknown>; ticks: CapturedTick[] };

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")) as T;
}

/** A trimmed per-car array back at real telemetry width — fixture slot 20 is the pace car, raw index 64. */
function widen(values: number[]): number[] {
  const out = new Array(72).fill(-1);

  values.forEach((v, i) => (out[i === 20 ? PACE : i] = v));

  return out;
}

/**
 * What the reader reads of a fixture tick. Lap progress and the surfaces are
 * passed only by a fixture that carries lap progress — the watch recorded
 * none, so its ticks count every car as present, as #1127's do.
 */
function capturedTelemetry(tick: CapturedTick): TelemetryData {
  return {
    SessionState: tick.SessionState,
    CarIdxPaceLine: widen(tick.CarIdxPaceLine),
    CarIdxPaceRow: widen(tick.CarIdxPaceRow),
    ...(tick.CarIdxLapDistPct && tick.CarIdxTrackSurface
      ? { CarIdxLapDistPct: widen(tick.CarIdxLapDistPct), CarIdxTrackSurface: widen(tick.CarIdxTrackSurface) }
      : {}),
  } as unknown as TelemetryData;
}

/**
 * A fixture tick with the world as the live sim reports it: the tick's own
 * committed `CarIdxTrackSurface`, and a lap progress to go with it — valid for
 * every car whose surface puts it in the world, −1 for one whose surface does
 * not. For a capture that recorded the surfaces and no lap progress, which
 * {@link capturedTelemetry} therefore reads with every car present.
 */
function capturedTelemetryWithWorld(tick: CapturedTick): TelemetryData {
  if (!tick.CarIdxTrackSurface) throw new Error(`the tick at t=${tick.t} carries no track surfaces`);

  return {
    ...capturedTelemetry(tick),
    CarIdxTrackSurface: widen(tick.CarIdxTrackSurface),
    CarIdxLapDistPct: widen(tick.CarIdxTrackSurface.map((surface) => (surface === -1 ? -1 : 0.5))),
  } as TelemetryData;
}

/** The same session with another car as the player — how one tick is read for the whole field. */
function seenFrom(sessionInfo: Record<string, unknown>, carIdx: number): Record<string, unknown> {
  return {
    ...sessionInfo,
    DriverInfo: { ...(sessionInfo.DriverInfo as Record<string, unknown>), DriverCarIdx: carIdx },
  };
}

/** The lineup each of the 20 cars reads on one tick, indexed by car. */
function fieldLineups(telemetry: TelemetryData, sessionInfo: Record<string, unknown>): Array<PaceLineup | null> {
  return Array.from({ length: 20 }, (_, carIdx) => resolvePaceLineup(telemetry, seenFrom(sessionInfo, carIdx), true));
}

function fieldPositions(telemetry: TelemetryData, sessionInfo: Record<string, unknown>): Array<number | null> {
  return fieldLineups(telemetry, sessionInfo).map((lineup) => lineup?.lineupPosition ?? null);
}

/** The canonical order's grid for the 20 cars — `QualifyResultsInfo`, through the one reader of it (#974). */
function qualifyingGrid(telemetry: TelemetryData, sessionInfo: Record<string, unknown>): number[] {
  return calculateCanonicalRacePositions(createInitialState(), telemetry, sessionInfo, true).slice(0, 20);
}

/**
 * The caution's keying — line 1 one row behind line 0 — applied to a tick's
 * rows, as position by car. Restated here on purpose: a control must not share
 * code with the reader it controls.
 */
function cautionKeyedPositions(tick: CapturedTick): number[] {
  const key = (carIdx: number): number =>
    tick.CarIdxPaceLine[carIdx] === 0 ? 2 * tick.CarIdxPaceRow[carIdx] : 2 * (tick.CarIdxPaceRow[carIdx] + 1) + 1;
  const order = Array.from({ length: 20 }, (_, carIdx) => carIdx)
    .filter((carIdx) => tick.CarIdxPaceRow[carIdx] >= 0)
    .sort((a, b) => key(a) - key(b));
  const positions = new Array<number>(20).fill(0);

  order.forEach((carIdx, at) => (positions[carIdx] = at + 1));

  return positions;
}

/** The cars a set of positions puts somewhere other than the grid does. */
function misplaced(positions: Array<number | null>, grid: number[]): number[] {
  return grid.flatMap((slot, carIdx) => (positions[carIdx] !== null && positions[carIdx] !== slot ? [carIdx] : []));
}

/** The same tick with the pace car put on line 0 row 0 — the one datum that selects the caution's frame. */
function withPaceCarAtHead(telemetry: TelemetryData): TelemetryData {
  const lines = [...(telemetry.CarIdxPaceLine as number[])];
  const rows = [...(telemetry.CarIdxPaceRow as number[])];

  lines[PACE] = 0;
  rows[PACE] = 0;

  return { ...telemetry, CarIdxPaceLine: lines, CarIdxPaceRow: rows } as TelemetryData;
}

describe("resolvePaceLineup — the 2026-09-17 rolling-start formation (#1167)", () => {
  const formation = readFixture<CapturedFormation>("rolling-start-formation-20260917.json");
  const { sessionInfo } = formation;
  const preGreen = formation.ticks.filter((tick) => tick.SessionState < SessionState.Racing);
  const fromGreen = formation.ticks.filter((tick) => tick.SessionState >= SessionState.Racing);

  const PLAYER = 0; // car "64", line 0 row 5
  const AHEAD = 9; // car "07", line 0 row 4
  const POLE = 17; // car "96", line 0 row 0
  const OUTSIDE_POLE = 16; // car "37", line 1 row 0

  /** Position by car index: the (row, line) order of the formation, verified against the capture. */
  const GRID = [11, 8, 17, 15, 7, 16, 5, 4, 20, 9, 18, 6, 10, 19, 12, 14, 2, 1, 3, 13];

  it("splits into 29 pre-green ticks and 31 from the green on", () => {
    expect(preGreen).toHaveLength(29);
    expect(preGreen.at(-1)?.t).toBe(196.53);
    expect(fromGreen).toHaveLength(31);
    expect(fromGreen[0].t).toBe(201.18);
  });

  it("holds the `grid` anchor for every car on every pre-green tick, read as cut — every car counted as present", () => {
    for (const tick of preGreen) {
      const anchors = fieldLineups(capturedTelemetry(tick), sessionInfo).map((lineup) => lineup?.anchor);

      expect({ t: tick.t, anchors }).toEqual({ t: tick.t, anchors: new Array(20).fill("grid") });
    }
  });

  it("places the whole field on its qualifying slot on every pre-green tick, read as cut — and on the CarIdxPosition iRacing published after the green", () => {
    const published = formation.ticks.find((tick) => tick.t === 203.22)?.CarIdxPosition?.slice(0, 20);

    // The three sources agree with each other before any tick is read...
    expect(published).toEqual(GRID);
    expect(qualifyingGrid(capturedTelemetry(preGreen[0]), sessionInfo)).toEqual(GRID);

    // ...and the lineup agrees with them on all 29 ticks, for all 20 cars.
    for (const tick of preGreen) {
      const telemetry = capturedTelemetry(tick);

      expect({ t: tick.t, positions: fieldPositions(telemetry, sessionInfo) }).toEqual({ t: tick.t, positions: GRID });
      expect(qualifyingGrid(telemetry, sessionInfo)).toEqual(GRID);
    }
  });

  it("places the whole field on its qualifying slot with each tick's own track surfaces — the player absent at 107.38 s included", () => {
    // Read as cut, the fixture cannot show an absent car: the watch recorded
    // no lap progress, so the shared predicate counts everyone present. The
    // live sim does deliver it, so this replay gives each tick its committed
    // surfaces and the lap progress that goes with them.
    const absentAt = preGreen.flatMap((tick) => {
      const inWorld = carInWorld(capturedTelemetryWithWorld(tick));
      const absent = Array.from({ length: 20 }, (_, carIdx) => carIdx).filter((carIdx) => !inWorld(carIdx));

      return absent.length > 0 ? [[tick.t, absent]] : [];
    });

    // The one tick that tests the count: the player holds line 0 row 5 and is
    // not in the world. Nine cars sit behind him in the order.
    expect(absentAt).toEqual([[107.38, [PLAYER]]]);
    expect(GRID.filter((slot) => slot > GRID[PLAYER])).toHaveLength(9);

    for (const tick of preGreen) {
      const lineups = fieldLineups(capturedTelemetryWithWorld(tick), sessionInfo);

      expect({ t: tick.t, anchors: lineups.map((lineup) => lineup?.anchor) }).toEqual({
        t: tick.t,
        anchors: new Array(20).fill("grid"),
      });
      expect({ t: tick.t, positions: lineups.map((lineup) => lineup?.lineupPosition) }).toEqual({
        t: tick.t,
        positions: GRID,
      });
    }
  });

  it("has the car behind the absent player form up behind the car that IS there — the walk keeps its filter", () => {
    const BEHIND = 19; // line 0 row 6, directly behind the player's row 5
    const followedAt = (t: number): number | null | undefined => {
      const tick = preGreen.find((candidate) => candidate.t === t);

      if (!tick) throw new Error(`no fixture tick at t=${t}`);

      return resolvePaceLineup(capturedTelemetryWithWorld(tick), seenFrom(sessionInfo, BEHIND), true)?.followCarIdx;
    };

    expect(followedAt(107.38)).toBe(AHEAD); // past the player's empty slot, to car 07
    expect(followedAt(113.05)).toBe(PLAYER); // the player is in the world
  });

  it("has the player follow car 07 on the inside, eleventh", () => {
    for (const tick of preGreen) {
      expect(resolvePaceLineup(capturedTelemetry(tick), seenFrom(sessionInfo, PLAYER), true), `t=${tick.t}`).toEqual({
        followCarIdx: AHEAD,
        followCarNumber: "07",
        line: "inside",
        isLeader: false,
        followsPaceCar: false,
        doubleFile: true,
        lineupPosition: 11,
        anchor: "grid",
        paceFlags: NO_PACE_FLAGS,
      });
    }
  });

  it("makes car 96 the leader, and only car 96", () => {
    for (const tick of preGreen) {
      const lineups = fieldLineups(capturedTelemetry(tick), sessionInfo);

      expect(lineups[POLE], `t=${tick.t}`).toMatchObject({
        isLeader: true,
        followsPaceCar: true,
        followCarIdx: PACE,
        line: "inside",
        lineupPosition: 1,
      });
      expect(lineups.flatMap((lineup, carIdx) => (lineup?.isLeader ? [carIdx] : []))).toEqual([POLE]);
    }
  });

  it("has car 37 follow the pace car without leading", () => {
    for (const tick of preGreen) {
      const lineup = resolvePaceLineup(capturedTelemetry(tick), seenFrom(sessionInfo, OUTSIDE_POLE), true);

      expect(lineup, `t=${tick.t}`).toMatchObject({
        isLeader: false,
        followsPaceCar: true,
        followCarIdx: PACE,
        line: "outside",
        lineupPosition: 2,
      });
    }
  });

  it("withholds every position from the green tick on — the unwind included", () => {
    for (const tick of fromGreen) {
      const lineups = fieldLineups(capturedTelemetry(tick), sessionInfo);

      expect({ t: tick.t, anchors: lineups.map((lineup) => lineup?.anchor ?? null) }).toEqual({
        t: tick.t,
        anchors: new Array(20).fill(null),
      });
      expect({ t: tick.t, positions: lineups.map((lineup) => lineup?.lineupPosition ?? null) }).toEqual({
        t: tick.t,
        positions: new Array(20).fill(null),
      });
      expect(lineups.some((lineup) => lineup?.isLeader)).toBe(false);
    }
  });

  it("still answers the car ahead and the lane under green while the rows are intact — only the position is withheld", () => {
    // 201.18 → 203.85: the session is racing and the rows have not moved yet.
    const intact = fromGreen.filter((tick) => tick.t < 203.87);

    expect(intact.map((tick) => tick.t)).toEqual([201.18, 201.28, 203.22, 203.7, 203.85]);

    for (const tick of intact) {
      expect(resolvePaceLineup(capturedTelemetry(tick), seenFrom(sessionInfo, PLAYER), true), `t=${tick.t}`).toEqual({
        followCarIdx: AHEAD,
        followCarNumber: "07",
        line: "inside",
        isLeader: false,
        followsPaceCar: false,
        doubleFile: true,
        lineupPosition: null,
        anchor: null,
        paceFlags: NO_PACE_FLAGS,
      });
    }
  });

  it("does not call the grid's third car the leader when it reaches line 0 row 0 in the unwind (203.87 s)", () => {
    const tick = formation.ticks.find((candidate) => candidate.t === 203.87);

    if (!tick) throw new Error("no fixture tick at t=203.87");

    const THIRD = 18;

    // The trap, as data: the formation's shape exactly, one car on.
    expect(GRID[THIRD]).toBe(3);
    expect([tick.CarIdxPaceLine[THIRD], tick.CarIdxPaceRow[THIRD]]).toEqual([0, 0]);
    expect([tick.CarIdxPaceLine[20], tick.CarIdxPaceRow[20]]).toEqual([-1, -1]);

    expect(resolvePaceLineup(capturedTelemetry(tick), seenFrom(sessionInfo, THIRD), true)).toMatchObject({
      anchor: null,
      lineupPosition: null,
      isLeader: false,
    });

    // The positive control for the phase gate: the same tick read as if the
    // session were still before its green DOES make that car the leader.
    const asFormation = { ...capturedTelemetry(tick), SessionState: SessionState.ParadeLaps } as TelemetryData;

    expect(resolvePaceLineup(asFormation, seenFrom(sessionInfo, THIRD), true)).toMatchObject({
      anchor: "grid",
      lineupPosition: 1,
      isLeader: true,
    });
  });

  describe("positive control — the caution's offset on the same rows", () => {
    it("misplaces 18 of the 20 cars when keyed by hand", () => {
      const keyed = cautionKeyedPositions(preGreen[0]);

      expect(misplaced(keyed, GRID)).toHaveLength(18);
      // Only the two ends of the order survive the offset: the pole and the last car.
      expect(GRID.flatMap((slot, carIdx) => (keyed[carIdx] === slot ? [carIdx] : []))).toEqual([8, POLE]);
      expect([GRID[PLAYER], keyed[PLAYER]]).toEqual([11, 10]);
      expect([GRID[OUTSIDE_POLE], keyed[OUTSIDE_POLE]]).toEqual([2, 3]);
    });

    it("cannot be coaxed out of the reader: the same rows with the pace car put on the pole's slot give no numbers at all", () => {
      // No parameter selects the frame, and the one datum that does — the pace
      // car's slot — cannot select the caution's for these rows: a pace car on
      // line 0 row 0 beside the pole is a contradiction, and the reader hands
      // out nothing rather than the 18 wrong numbers above.
      for (const tick of preGreen) {
        const lineups = fieldLineups(withPaceCarAtHead(capturedTelemetry(tick)), sessionInfo);

        expect({ t: tick.t, anchors: lineups.map((lineup) => lineup?.anchor) }).toEqual({
          t: tick.t,
          anchors: new Array(20).fill(null),
        });
        expect(lineups.map((lineup) => lineup?.lineupPosition)).toEqual(new Array(20).fill(null));
      }
    });
  });
});

describe("resolvePaceLineup — three formation snapshots on two grids (#1167)", () => {
  const first = readFixture<CapturedFormation>("rolling-start-lineup-20260917.json");
  const second = readFixture<CapturedFormation>("rolling-start-lineup-20260918.json");
  const snapshots = [
    ...first.ticks.map((tick) => ({ name: "2026-09-17 19:02", tick, sessionInfo: first.sessionInfo })),
    ...second.ticks.map((tick) => ({ name: `2026-09-18 t=${tick.t}`, tick, sessionInfo: second.sessionInfo })),
  ];

  it("covers three snapshots", () => {
    expect(snapshots.map((snapshot) => snapshot.tick.t)).toEqual([177.37, 80.1, 110.92]);
  });

  it("reads every car's pace-row place as its qualifying slot, in the `grid` frame", () => {
    for (const { name, tick, sessionInfo } of snapshots) {
      const telemetry = capturedTelemetry(tick);
      const lineups = fieldLineups(telemetry, sessionInfo);
      const grid = qualifyingGrid(telemetry, sessionInfo);

      // A full grid, so "equal" is 20 comparisons and not 20 zeros.
      expect(
        [...grid].sort((a, b) => a - b),
        name,
      ).toEqual(Array.from({ length: 20 }, (_, at) => at + 1));
      expect(
        lineups.map((lineup) => lineup?.anchor),
        name,
      ).toEqual(new Array(20).fill("grid"));
      expect(
        lineups.map((lineup) => lineup?.lineupPosition),
        name,
      ).toEqual(grid);
    }
  });

  it("carries real lap progress, with every car present", () => {
    // Unlike the watch, a snapshot carries `CarIdxLapDistPct`, so the shared
    // in-world predicate ran on real data above — and found nobody absent.
    for (const { name, tick } of snapshots) {
      expect(
        tick.CarIdxLapDistPct?.every((pct) => pct >= 0),
        name,
      ).toBe(true);
      expect(
        tick.CarIdxTrackSurface?.every((surface) => surface === 3),
        name,
      ).toBe(true);
    }
  });

  it("is two different grids", () => {
    const grids = snapshots.map(({ tick, sessionInfo }) => qualifyingGrid(capturedTelemetry(tick), sessionInfo));

    expect(grids[1]).toEqual(grids[2]);
    expect(grids[0]).not.toEqual(grids[1]);
  });

  it("positive control: the caution's offset misplaces 18 of the 20 cars on both grids", () => {
    for (const { name, tick, sessionInfo } of snapshots) {
      const grid = qualifyingGrid(capturedTelemetry(tick), sessionInfo);

      expect(misplaced(cautionKeyedPositions(tick), grid), name).toHaveLength(18);
    }
  });
});

describe("resolvePaceLineup — the `grid` anchor never holds under a caution (#1127 fixtures)", () => {
  type CautionFixture = { name: string; ticks: CapturedTick[]; sessionInfo: Record<string, unknown> };

  // Neither watch carries session YAML, so the pace car is named synthetically
  // at its real index, as the tests that replay them do.
  const fixtures: CautionFixture[] = [
    "caution-restart-20260917.json",
    "caution-road-20260918.json",
    "caution-lineup-20260919.json",
  ].map((name) => ({ name, ticks: readFixture<CapturedTick[]>(name), sessionInfo: raceSession(0) }));

  /** The ticks on which at least one car reads the `grid` anchor. */
  function gridAnchored(fixture: CautionFixture, state?: SessionState): number {
    return fixture.ticks.filter((tick) => {
      const telemetry = capturedTelemetry(tick);
      const read = state === undefined ? telemetry : inState(telemetry, state);

      return fieldLineups(read, fixture.sessionInfo).some((lineup) => lineup?.anchor === "grid");
    }).length;
  }

  it("on none of their ticks — every one is under Racing", () => {
    expect(fixtures.map((fixture) => fixture.ticks.length)).toEqual([284, 143, 1]);

    for (const fixture of fixtures) {
      expect(
        fixture.ticks.every((tick) => tick.SessionState === SessionState.Racing),
        fixture.name,
      ).toBe(true);
      expect(gridAnchored(fixture), fixture.name).toBe(0);
    }
  });

  it("positive control: it is the phase that keeps it out — read as pre-green, their unwinds have the grid's shape", () => {
    // The post-green unwind of each restart, and of the rolling start the oval
    // capture opens with: the pace car without a row and a car at line 0 row 0.
    expect(fixtures.map((fixture) => gridAnchored(fixture, SessionState.ParadeLaps))).toEqual([60, 39, 0]);
  });
});

describe("resolvePaceLineup — the player's pace flags (#1168)", () => {
  /** {@link SINGLE_FILE} with `CarIdxPaceFlags` set for the named cars. */
  function withPaceFlags(flags: Record<number, number>): TelemetryData {
    const all = new Array(72).fill(0);

    for (const [carIdx, bits] of Object.entries(flags)) all[Number(carIdx)] = bits;

    return { ...paceArrays(SINGLE_FILE), CarIdxPaceFlags: all } as TelemetryData;
  }

  it("decodes each of iRacing's three bits", () => {
    const flagsOf = (bits: number): PaceLineup["paceFlags"] | undefined =>
      resolvePaceLineup(withPaceFlags({ 3: bits }), session(3), false)?.paceFlags;

    expect(flagsOf(0)).toEqual(NO_PACE_FLAGS);
    expect(flagsOf(0x1)).toEqual({ endOfLine: true, freePass: false, wavedAround: false });
    expect(flagsOf(0x2)).toEqual({ endOfLine: false, freePass: true, wavedAround: false });
    expect(flagsOf(0x4)).toEqual({ endOfLine: false, freePass: false, wavedAround: true });
    expect(flagsOf(0x7)).toEqual({ endOfLine: true, freePass: true, wavedAround: true });
  });

  it("reads the PLAYER's slot — another car's flags are not his", () => {
    const telemetry = withPaceFlags({ 2: 0x4 });

    expect(resolvePaceLineup(telemetry, session(3), false)?.paceFlags).toEqual(NO_PACE_FLAGS);
    expect(resolvePaceLineup(telemetry, session(2), false)?.paceFlags.wavedAround).toBe(true);
  });

  it("reads all false from a tick that carries no pace flags, or none for the player's slot", () => {
    expect(resolvePaceLineup(paceArrays(SINGLE_FILE), session(3), false)?.paceFlags).toEqual(NO_PACE_FLAGS);

    const short = { ...paceArrays(SINGLE_FILE), CarIdxPaceFlags: [0, 0] } as TelemetryData;

    expect(resolvePaceLineup(short, session(3), false)?.paceFlags).toEqual(NO_PACE_FLAGS);
  });

  it("still answers them on a tick whose every other answer is withheld — they are the car's, not its line's", () => {
    // Car 7 alone on line 1 while the field is on line 0: the stray-player rule.
    const stray = {
      ...paceArrays([...SINGLE_FILE, [7, 1, 6]]),
      CarIdxPaceFlags: Object.assign(new Array(72).fill(0), { 7: 0x4 }),
    };
    const lineup = resolvePaceLineup(stray as TelemetryData, session(7), true);

    expect(lineup).toMatchObject({ followCarIdx: null, lineupPosition: null, anchor: null });
    expect(lineup?.paceFlags).toEqual({ endOfLine: false, freePass: false, wavedAround: true });
  });

  it("carries WavedAround on the player in the 2026-09-19 snapshot, at the tail at normal spacing", () => {
    const [snapshot] = readFixture<Array<CapturedTick & { CarIdxPaceFlags: number[] }>>("caution-lineup-20260919.json");
    const telemetry = {
      ...capturedTelemetry(snapshot),
      CarIdxPaceFlags: widen(snapshot.CarIdxPaceFlags),
    } as TelemetryData;

    expect(resolvePaceLineup(telemetry, session(0), true)?.paceFlags).toEqual({
      endOfLine: false,
      freePass: false,
      wavedAround: true,
    });
    expect(resolvePaceLineup(telemetry, session(7), true)?.paceFlags).toEqual(NO_PACE_FLAGS);
  });
});

describe("resolveCarAheadInLine — the follow rule, for any car", () => {
  const everyone = (): boolean => true;
  const arrays = (cars: Array<[number, number, number]>): [number[], number[]] => {
    const telemetry = paceArrays(cars);

    return [telemetry.CarIdxPaceLine as number[], telemetry.CarIdxPaceRow as number[]];
  };

  it("names the nearest lower row in the car's OWN line", () => {
    const [lines, rows] = arrays(DOUBLE_FILE);

    expect(resolveCarAheadInLine(lines, rows, 5, everyone)).toBe(3); // line 0 row 3 → row 2
    expect(resolveCarAheadInLine(lines, rows, 6, everyone)).toBe(4); // line 1 row 2 → row 1
    expect(resolveCarAheadInLine(lines, rows, 4, everyone)).toBe(2); // line 1 row 1 → row 0
  });

  it("hands back the pace car itself for the leader, and nobody for the outside front-row car", () => {
    const [lines, rows] = arrays(DOUBLE_FILE);

    expect(resolveCarAheadInLine(lines, rows, 1, everyone)).toBe(PACE);
    expect(resolveCarAheadInLine(lines, rows, 2, everyone)).toBeNull();
    expect(resolveCarAheadInLine(lines, rows, PACE, everyone)).toBeNull();
  });

  it("walks past a car that is not in the world", () => {
    const [lines, rows] = arrays(DOUBLE_FILE);

    expect(resolveCarAheadInLine(lines, rows, 5, (carIdx) => carIdx !== 3)).toBe(1);
    expect(resolveCarAheadInLine(lines, rows, 5, (carIdx) => carIdx !== 3 && carIdx !== 1)).toBe(PACE);
  });

  it("answers nobody for a car that is not lined up, or one the arrays do not carry", () => {
    const [lines, rows] = arrays(DOUBLE_FILE);

    expect(resolveCarAheadInLine(lines, rows, 9, everyone)).toBeNull();
    expect(resolveCarAheadInLine(lines, rows, 500, everyone)).toBeNull();
  });

  it("is the rule the lineup uses for the player — the same car, for every car, on the uneven-lanes snapshot", () => {
    const [snapshot] = readFixture<CapturedTick[]>("caution-lineup-20260919.json");
    const telemetry = capturedTelemetry(snapshot);

    for (let carIdx = 0; carIdx < 20; carIdx++) {
      const ahead = resolveCarAheadInLine(
        telemetry.CarIdxPaceLine as number[],
        telemetry.CarIdxPaceRow as number[],
        carIdx,
        () => true,
      );
      const lineup = resolvePaceLineup(telemetry, session(carIdx), true);

      // The lineup falls back to the pace car where the rule names nobody.
      expect(lineup?.followCarIdx, `car ${carIdx}`).toBe(ahead ?? PACE);
      expect(lineup?.followsPaceCar, `car ${carIdx}`).toBe(ahead === null || ahead === PACE);
    }
  });
});
