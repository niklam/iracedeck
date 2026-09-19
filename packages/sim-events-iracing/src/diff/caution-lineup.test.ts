import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MIN_LINE_POPULATION, resolveCautionLineup } from "./caution-lineup.js";

const ticks = JSON.parse(
  readFileSync(new URL("./__fixtures__/caution-restart-20260917.json", import.meta.url), "utf-8"),
) as Array<{ t: number; CarIdxPaceLine: number[]; CarIdxPaceRow: number[] }>;

/** The pace car's index in real telemetry (slot 20 in the fixture's trimmed arrays). */
const PACE = 64;

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

describe("resolveCautionLineup — a car that has left the world (2026-09-18 road capture, 548.33 s)", () => {
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
    expect(resolveCautionLineup(withWorld(paceArrays(SINGLE_FILE), [2]), session(3), false)).toMatchObject({
      followCarIdx: 1,
      followsPaceCar: false,
      restartPosition: 2,
    });
  });

  it("and double file, in the player's own line", () => {
    // Player 5 at line 0 row 3; car 3 (line 0 row 2) gone — so car 1 (line 0
    // row 1) is the one ahead, and the combined order counts cars 1, 2 and 4.
    expect(resolveCautionLineup(withWorld(paceArrays(DOUBLE_FILE), [3]), session(5), true)).toMatchObject({
      followCarIdx: 1,
      followsPaceCar: false,
      restartPosition: 4,
      line: "inside",
    });
  });

  it("follows the pace car when every car ahead in the line has gone", () => {
    expect(resolveCautionLineup(withWorld(paceArrays(SINGLE_FILE), [1, 2]), session(3), false)).toMatchObject({
      followCarIdx: PACE,
      followsPaceCar: true,
      restartPosition: 1,
      isLeader: true,
    });
  });

  it("counts every car as present when the telemetry carries no lap progress — fixtures cut without it are unchanged", () => {
    expect(resolveCautionLineup(paceArrays(SINGLE_FILE), session(3), false)).toMatchObject({
      followCarIdx: 2,
      restartPosition: 3,
    });
  });
});

describe("resolveCautionLineup — who to follow", () => {
  it("follows the car one row lower in single file", () => {
    const lineup = resolveCautionLineup(paceArrays(SINGLE_FILE), session(3), false);

    expect(lineup).toMatchObject({ followCarIdx: 2, followsPaceCar: false, isLeader: false, doubleFile: false });
  });

  it("makes the front car follow the pace car", () => {
    const lineup = resolveCautionLineup(paceArrays(SINGLE_FILE), session(1), false);

    expect(lineup).toMatchObject({ followCarIdx: PACE, followsPaceCar: true, isLeader: true, restartPosition: 1 });
  });

  it("follows the car one row lower in the SAME line when double file", () => {
    // Car 4 is line 1 row 1 (P4). The car one row lower in its own line is car
    // 2 (line 1 row 0) — NOT car 3, which holds row 1 on the other line.
    const lineup = resolveCautionLineup(paceArrays(DOUBLE_FILE), session(4), false);

    expect(lineup).toMatchObject({ followCarIdx: 2, followsPaceCar: false, isLeader: false, doubleFile: true });
  });

  it("makes the outside front car follow the pace car", () => {
    // Car 2 is line 1 row 0: there is no row -1 in its line, so the only car in
    // front of it is the pace car.
    const lineup = resolveCautionLineup(paceArrays(DOUBLE_FILE), session(2), false);

    // Following the pace car, and NOT leading: car 2 restarts second. The two
    // questions are the same single file and different double file, and each
    // becomes a script condition a pack author can only write or negate.
    expect(lineup).toMatchObject({
      followCarIdx: PACE,
      followsPaceCar: true,
      isLeader: false,
      restartPosition: 2,
    });
  });

  it("calls the inside front car the leader, and only that car", () => {
    const leader = resolveCautionLineup(paceArrays(DOUBLE_FILE), session(1), false);

    expect(leader).toMatchObject({ followsPaceCar: true, isLeader: true, restartPosition: 1 });
  });

  it("does not read a single stray car on a second line as a double-file field", () => {
    // One car carrying a line value of its own — a stray, or a mid-transition
    // reading — must not flip the whole field onto the interleave: single file,
    // car 3 restarts THIRD (row 3), and the interleave would call it fifth
    // (2 × 3 − 1) and move `isLeader` off car 1. A column is a population.
    const stray: Array<[number, number, number]> = [...SINGLE_FILE, [7, 1, 6]];

    expect(resolveCautionLineup(paceArrays(stray), session(3), true)).toMatchObject({
      doubleFile: false,
      restartPosition: 3,
      line: null,
      isLeader: false,
    });
    expect(resolveCautionLineup(paceArrays(stray), session(1), true)).toMatchObject({
      isLeader: true,
      restartPosition: 1,
    });
  });

  it("reads two cars on the second line as a column — the positive control for the stray-car rule", () => {
    // The bar is a population of MIN_LINE_POPULATION, so the smallest genuine
    // second column flips the field: car 3 is now line 0 row 3 → 2 × 3 − 1 = 5.
    const column: Array<[number, number, number]> = [...SINGLE_FILE, [7, 1, 0], [8, 1, 1]];

    expect(MIN_LINE_POPULATION).toBe(2);
    expect(resolveCautionLineup(paceArrays(column), session(3), true)).toMatchObject({
      doubleFile: true,
      restartPosition: 5,
      line: "inside",
    });
  });

  it("claims no lead when the restart position cannot be read at all", () => {
    // No pace car to anchor the rows, so there is no position — and a lead is
    // not something to claim on a guess.
    const lineup = resolveCautionLineup(paceArrays(SINGLE_FILE), session(1, { paceCarIdx: null }), false);

    expect(lineup).toMatchObject({ followsPaceCar: false, isLeader: false, restartPosition: null });
  });

  it("never mistakes a car out of the lineup for the car in front of a front-row car", () => {
    // Car 9 reports its line but no row — the shape a car sitting the re-form
    // out would take if the sim ever wrote one array without the other. A
    // front-row car's "one row lower" is -1, which is exactly what car 9 holds.
    const withStrayCar: Array<[number, number, number]> = [...DOUBLE_FILE, [9, 1, -1]];
    const lineup = resolveCautionLineup(paceArrays(withStrayCar), session(2), false);

    expect(lineup).toMatchObject({ followCarIdx: PACE, followsPaceCar: true });
  });

  it("reads the follow car's number from DriverInfo.Drivers as a string, so a leading zero survives", () => {
    const drivers = [{ CarIdx: 2, CarNumber: "09" }];
    const lineup = resolveCautionLineup(paceArrays(SINGLE_FILE), session(3, { drivers }), false);

    expect(lineup?.followCarNumber).toBe("09");
  });

  it("reads a car number the session YAML left unquoted, which arrives as a number", () => {
    // Issue #869: an unquoted CarNumber reaches us as 42, not "42". Reading
    // strings only would drop every car number in such a session, and every
    // caution line would quietly fall back to its numberless wording.
    const drivers = [{ CarIdx: 2, CarNumber: 42 }];
    const lineup = resolveCautionLineup(paceArrays(SINGLE_FILE), session(3, { drivers }), false);

    expect(lineup?.followCarNumber).toBe("42");
  });

  it("withholds a car number for a follow car the driver list does not carry", () => {
    const lineup = resolveCautionLineup(paceArrays(SINGLE_FILE), session(3), false);

    expect(lineup?.followCarNumber).toBeNull();
  });
});

describe("resolveCautionLineup — the line you are in", () => {
  it("calls pace line 0 the inside on an oval running double file", () => {
    expect(resolveCautionLineup(paceArrays(DOUBLE_FILE), session(3), true)?.line).toBe("inside");
  });

  it("calls pace line 1 the outside on an oval running double file", () => {
    expect(resolveCautionLineup(paceArrays(DOUBLE_FILE), session(4), true)?.line).toBe("outside");
  });

  it("names no line off an oval, whatever the file", () => {
    expect(resolveCautionLineup(paceArrays(DOUBLE_FILE), session(3), false)?.line).toBeNull();
  });

  it("names no line in single file, even on an oval", () => {
    expect(resolveCautionLineup(paceArrays(SINGLE_FILE), session(3), true)?.line).toBeNull();
  });
});

describe("resolveCautionLineup — the restart position", () => {
  it("is the pace row in single file", () => {
    expect(resolveCautionLineup(paceArrays(SINGLE_FILE), session(3), false)?.restartPosition).toBe(3);
  });

  it("interleaves the two lines when double file", () => {
    const at = (player: number): number | null | undefined =>
      resolveCautionLineup(paceArrays(DOUBLE_FILE), session(player), false)?.restartPosition;

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

    expect(resolveCautionLineup(paceArrays(unwound), session(3), false)?.restartPosition).toBeNull();
  });

  it("is withheld when session info names no pace car to anchor the rows on", () => {
    const lineup = resolveCautionLineup(paceArrays(SINGLE_FILE), session(3, { paceCarIdx: null }), false);

    expect(lineup?.restartPosition).toBeNull();
  });

  it("is withheld for the pace car's own slot rather than reported as position zero", () => {
    const lineup = resolveCautionLineup(paceArrays(SINGLE_FILE), session(PACE), false);

    expect(lineup?.restartPosition).toBeNull();
  });

  it("is withheld, with no line named, for a third pace line the capture has never shown", () => {
    const threeLines: Array<[number, number, number]> = [...DOUBLE_FILE, [7, 2, 0]];
    const lineup = resolveCautionLineup(paceArrays(threeLines), session(7), true);

    expect(lineup).toMatchObject({ restartPosition: null, line: null, doubleFile: true });
  });
});

describe("resolveCautionLineup — no lineup to read", () => {
  it("returns null when no car has a pace row", () => {
    expect(resolveCautionLineup(paceArrays([]), session(3), false)).toBeNull();
  });

  it("returns null when the player is not in the lineup the rest of the field is in", () => {
    expect(resolveCautionLineup(paceArrays(SINGLE_FILE), session(9), false)).toBeNull();
  });

  it("returns null without session info to name the player", () => {
    expect(resolveCautionLineup(paceArrays(SINGLE_FILE), null, false)).toBeNull();
  });

  it("returns null when telemetry carries no pace arrays", () => {
    expect(resolveCautionLineup({} as unknown as TelemetryData, session(3), false)).toBeNull();
  });
});

describe("resolveCautionLineup — against the committed capture", () => {
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
      const position = resolveCautionLineup(telemetry, session(carIdx), true)?.restartPosition;

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

describe("resolveCautionLineup — uneven lanes (the 2026-09-19 snapshot)", () => {
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
    const lineup = resolveCautionLineup(snapshotTelemetry(), session(PLAYER), true);

    expect(lineup).toMatchObject({ restartPosition: 20, doubleFile: true, line: "inside", isLeader: false });
    expect(lineup?.followCarIdx).toBe(LAPPED);
  });

  it("still resolves the leader as position 1, and only the leader", () => {
    expect(resolveCautionLineup(snapshotTelemetry(), session(LEADER), true)).toMatchObject({
      restartPosition: 1,
      isLeader: true,
      followsPaceCar: true,
    });

    for (let carIdx = 0; carIdx < 20; carIdx++) {
      if (carIdx === LEADER) continue;

      expect(resolveCautionLineup(snapshotTelemetry(), session(carIdx), true)?.isLeader, `car ${carIdx}`).toBe(false);
    }
  });

  it("places all 20 cars at 1..20 with no gap and no position claimed twice", () => {
    const positions = new Map<number, number>();

    for (let carIdx = 0; carIdx < 20; carIdx++) {
      const position = resolveCautionLineup(snapshotTelemetry(), session(carIdx), true)?.restartPosition;

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
      resolveCautionLineup(paceArrays(uneven), session(player), false)?.restartPosition;

    expect([at(1), at(2), at(3), at(4), at(5), at(6)]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
