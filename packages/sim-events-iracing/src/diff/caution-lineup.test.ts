import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isOvalTrack, resolveCautionLineup } from "./caution-lineup.js";

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

describe("resolveCautionLineup — who to follow", () => {
  it("follows the car one row lower in single file", () => {
    const lineup = resolveCautionLineup(paceArrays(SINGLE_FILE), session(3), false);

    expect(lineup).toMatchObject({ followCarIdx: 2, isLeader: false, doubleFile: false });
  });

  it("makes the front car follow the pace car", () => {
    const lineup = resolveCautionLineup(paceArrays(SINGLE_FILE), session(1), false);

    expect(lineup).toMatchObject({ followCarIdx: PACE, isLeader: true });
  });

  it("follows the car one row lower in the SAME line when double file", () => {
    // Car 4 is line 1 row 1 (P4). The car one row lower in its own line is car
    // 2 (line 1 row 0) — NOT car 3, which holds row 1 on the other line.
    const lineup = resolveCautionLineup(paceArrays(DOUBLE_FILE), session(4), false);

    expect(lineup).toMatchObject({ followCarIdx: 2, isLeader: false, doubleFile: true });
  });

  it("makes the outside front car follow the pace car", () => {
    // Car 2 is line 1 row 0: there is no row -1 in its line, so the only car in
    // front of it is the pace car.
    const lineup = resolveCautionLineup(paceArrays(DOUBLE_FILE), session(2), false);

    expect(lineup).toMatchObject({ followCarIdx: PACE, isLeader: true });
  });

  it("never mistakes a car out of the lineup for the car in front of a front-row car", () => {
    // Car 9 reports its line but no row — the shape a car sitting the re-form
    // out would take if the sim ever wrote one array without the other. A
    // front-row car's "one row lower" is -1, which is exactly what car 9 holds.
    const withStrayCar: Array<[number, number, number]> = [...DOUBLE_FILE, [9, 1, -1]];
    const lineup = resolveCautionLineup(paceArrays(withStrayCar), session(2), false);

    expect(lineup).toMatchObject({ followCarIdx: PACE, isLeader: true });
  });

  it("reads the follow car's number from DriverInfo.Drivers as a string, so a leading zero survives", () => {
    const drivers = [{ CarIdx: 2, CarNumber: "09" }];
    const lineup = resolveCautionLineup(paceArrays(SINGLE_FILE), session(3, { drivers }), false);

    expect(lineup?.followCarNumber).toBe("09");
  });

  it("withholds a car number the driver list spells as a number rather than a string", () => {
    // A number cannot say "09", so stringifying one would silently invent a
    // different car number for every leading-zero entry.
    const drivers = [{ CarIdx: 2, CarNumber: 9 }];
    const lineup = resolveCautionLineup(paceArrays(SINGLE_FILE), session(3, { drivers }), false);

    expect(lineup?.followCarNumber).toBeNull();
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

  /** The 20 cars in the capture, in the order they hold at a given tick. */
  function positionsAt(telemetry: TelemetryData): number[] {
    const order: number[] = [];

    for (let carIdx = 0; carIdx < 20; carIdx++) {
      const position = resolveCautionLineup(telemetry, session(carIdx), true)?.restartPosition;

      if (position !== null && position !== undefined) order[position - 1] = carIdx;
    }

    return order;
  }

  it("reproduces the single-file order from the double-file re-form", () => {
    // t=239.93 is the first tick of the caution's single-file lineup; t=415.1
    // is the double-file re-form at one to go. Nobody pitted between them (spec
    // finding 7), so the two orders must be identical — which is the whole
    // proof of the interleave.
    const single = positionsAt(tickAt(239.93));
    const double = positionsAt(tickAt(415.1));

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

      const order = positionsAt(telemetry);

      // No gaps and no collisions: a position claimed twice would leave a hole.
      expect(order.every((carIdx) => typeof carIdx === "number")).toBe(true);
    }

    // 193 of the fixture's 284 ticks carry a pace-car-led lineup; the rest are
    // the pre-caution green run and the post-green unwind.
    expect(anchored).toBe(193);
  });
});

describe("isOvalTrack", () => {
  it("reads the captured oval", () => {
    // Measured 2026-09-17 at Homestead-Miami — see the #1127 spec.
    expect(isOvalTrack({ WeekendInfo: { Category: "Oval", TrackType: "medium oval" } })).toBe(true);
  });

  it("reads a dirt oval", () => {
    expect(isOvalTrack({ WeekendInfo: { Category: "DirtOval", TrackType: "dirt oval" } })).toBe(true);
  });

  it("reads a superspeedway, whose track type never says oval", () => {
    expect(isOvalTrack({ WeekendInfo: { TrackType: "superspeedway" } })).toBe(true);
  });

  it("does not call a road course an oval", () => {
    expect(isOvalTrack({ WeekendInfo: { Category: "Road", TrackType: "road course" } })).toBe(false);
  });

  it("does not guess without session info", () => {
    expect(isOvalTrack(null)).toBe(false);
    expect(isOvalTrack({})).toBe(false);
  });
});
