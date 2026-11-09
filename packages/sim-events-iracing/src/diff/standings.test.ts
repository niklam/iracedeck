import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import {
  lapProgress,
  type PlayerStanding,
  resolvePlayerStanding,
  resolveStanding,
  SAME_LAP_SPAN,
  type Standing,
  standingPosition,
} from "./standings.js";

const PLAYER = 0;

type Field = {
  CarIdxClass?: Array<number | undefined>;
  CarIdxLapCompleted?: number[];
  CarIdxLapDistPct?: number[];
};

/**
 * Five cars, the player (carIdx 0) P3 overall. Overall ranks by carIdx are
 * `[3, 1, 2, 4, 5]`. In the multi-class split, class 100 holds the player and
 * carIdx 2 and 3 (class ranks: carIdx 2 → 1, player → 2, carIdx 3 → 3); class
 * 200 holds carIdx 1 and 4.
 */
const POSITIONS = [3, 1, 2, 4, 5];
const MULTI_CLASSES = [100, 200, 100, 100, 200];
const ONE_CLASS = [100, 100, 100, 100, 100];

/** Every car on lap 10, all within one lap of the player's 10.5; `null` classes leave out `CarIdxClass`. */
function makeField(classes: Array<number | undefined> | null = ONE_CLASS): Field {
  return {
    ...(classes !== null ? { CarIdxClass: classes.slice() } : {}),
    CarIdxLapCompleted: [10, 10, 10, 10, 10],
    CarIdxLapDistPct: [0.5, 0.9, 0.7, 0.4, 0.2],
  };
}

function tel(field: Field): TelemetryData {
  return field as unknown as TelemetryData;
}

/** `resolveStanding` the way the callers drive it: the player resolved from the same tick. */
function standing(field: Field, carIdx: number, isMultiClass: boolean, positions: number[] = POSITIONS): Standing {
  const player = resolvePlayerStanding(tel(field), positions, PLAYER, isMultiClass);

  return resolveStanding(tel(field), positions, player, PLAYER, carIdx, isMultiClass);
}

describe("SAME_LAP_SPAN", () => {
  it("is one full lap", () => {
    expect(SAME_LAP_SPAN).toBe(1.0);
  });
});

describe("standingPosition", () => {
  it.each([
    { name: "multi-class reads class space", classes: MULTI_CLASSES, carIdx: 3, multi: true, want: 3 },
    { name: "multi-class: the player's class rank", classes: MULTI_CLASSES, carIdx: PLAYER, multi: true, want: 2 },
    {
      name: "multi-class: an other-class car ranks in its own class",
      classes: MULTI_CLASSES,
      carIdx: 4,
      multi: true,
      want: 2,
    },
    { name: "single-class reads the overall rank", classes: MULTI_CLASSES, carIdx: 3, multi: false, want: 4 },
    { name: "single-class needs no CarIdxClass", classes: undefined, carIdx: 3, multi: false, want: 4 },
    { name: "multi-class without CarIdxClass is unresolved", classes: undefined, carIdx: 3, multi: true, want: 0 },
    { name: "a car outside the order is unresolved", classes: ONE_CLASS, carIdx: 9, multi: false, want: 0 },
  ])("$name", ({ classes, carIdx, multi, want }) => {
    expect(standingPosition(POSITIONS, classes as number[] | undefined, carIdx, multi)).toBe(want);
  });
});

describe("lapProgress", () => {
  it("is CarIdxLapCompleted + CarIdxLapDistPct", () => {
    expect(lapProgress(tel(makeField()), 2)).toBeCloseTo(10.7);
  });

  it("reads a car on its first lap at the line as 0, not as missing", () => {
    expect(lapProgress(tel({ CarIdxLapCompleted: [0], CarIdxLapDistPct: [0] }), 0)).toBe(0);
  });

  it.each([
    { name: "no CarIdxLapCompleted array", field: { CarIdxLapDistPct: [0.5] } },
    { name: "no CarIdxLapDistPct array", field: { CarIdxLapCompleted: [10] } },
    { name: "a missing CarIdxLapCompleted entry", field: { CarIdxLapCompleted: [], CarIdxLapDistPct: [0.5] } },
    { name: "a missing CarIdxLapDistPct entry", field: { CarIdxLapCompleted: [10], CarIdxLapDistPct: [] } },
    { name: "a negative CarIdxLapCompleted", field: { CarIdxLapCompleted: [-1], CarIdxLapDistPct: [0.5] } },
    { name: "a negative CarIdxLapDistPct", field: { CarIdxLapCompleted: [10], CarIdxLapDistPct: [-1] } },
  ])("is null for $name", ({ field }) => {
    expect(lapProgress(tel(field), 0)).toBeNull();
  });
});

describe("resolvePlayerStanding", () => {
  it("multi-class: the player's class position and lap progress", () => {
    expect(resolvePlayerStanding(tel(makeField(MULTI_CLASSES)), POSITIONS, PLAYER, true)).toEqual({
      pos: 2,
      progress: 10.5,
    });
  });

  it("single-class: the player's overall position", () => {
    expect(resolvePlayerStanding(tel(makeField(MULTI_CLASSES)), POSITIONS, PLAYER, false)).toEqual({
      pos: 3,
      progress: 10.5,
    });
  });

  it("an unresolved position reads 0", () => {
    expect(resolvePlayerStanding(tel(makeField(null)), POSITIONS, PLAYER, true).pos).toBe(0);
    expect(resolvePlayerStanding(tel(makeField()), [0, 1, 2, 3, 4], PLAYER, false).pos).toBe(0);
  });

  it("an unreadable lap progress reads null, never 0", () => {
    const field = makeField();
    field.CarIdxLapDistPct = [];

    expect(resolvePlayerStanding(tel(field), POSITIONS, PLAYER, false)).toEqual({ pos: 3, progress: null });
  });
});

describe("resolveStanding", () => {
  type Case = {
    name: string;
    field: Field;
    carIdx: number;
    multi: boolean;
    positions?: number[];
    want: Standing;
  };

  /** A field edited in place, for the one-off reading a case needs. */
  function edit(field: Field, change: (f: Field) => void): Field {
    change(field);

    return field;
  }

  const cases: Case[] = [
    // 1. Class.
    {
      name: "multi-class: the car's unreadable class misses at the class step, before any position",
      field: edit(makeField(MULTI_CLASSES), (f) => (f.CarIdxClass![3] = undefined)),
      carIdx: 3,
      multi: true,
      want: { reason: "class-unreadable", carPos: 0, playerPos: 0 },
    },
    {
      name: "multi-class: the player's unreadable class misses",
      field: edit(makeField(MULTI_CLASSES), (f) => (f.CarIdxClass![PLAYER] = undefined)),
      carIdx: 3,
      multi: true,
      want: { reason: "class-unreadable", carPos: 0, playerPos: 0 },
    },
    {
      name: "multi-class: no CarIdxClass at all misses as unreadable",
      field: makeField(null),
      carIdx: 3,
      multi: true,
      want: { reason: "class-unreadable", carPos: 0, playerPos: 0 },
    },
    {
      name: "multi-class: a readable different class misses",
      field: makeField(MULTI_CLASSES),
      carIdx: 4,
      multi: true,
      want: { reason: "different-class", carPos: 0, playerPos: 0 },
    },
    {
      name: "a readable different class misses while the session does not read multi-class",
      field: makeField(MULTI_CLASSES),
      carIdx: 1,
      multi: false,
      want: { reason: "different-class", carPos: 0, playerPos: 0 },
    },
    {
      name: "single-class with no CarIdxClass qualifies",
      field: makeField(null),
      carIdx: 3,
      multi: false,
      want: { reason: null, carPos: 4, playerPos: 3, placesAhead: -1 },
    },
    {
      name: "single-class with one unreadable class qualifies",
      field: edit(makeField(), (f) => (f.CarIdxClass![3] = undefined)),
      carIdx: 3,
      multi: false,
      want: { reason: null, carPos: 4, playerPos: 3, placesAhead: -1 },
    },
    // 2. Positions.
    {
      name: "an unresolved car position misses, carrying the player's",
      field: makeField(),
      carIdx: 3,
      multi: false,
      positions: [3, 1, 2, 0, 5],
      want: { reason: "position-unresolved", carPos: 0, playerPos: 3 },
    },
    {
      name: "an unresolved player position misses, carrying the car's",
      field: makeField(),
      carIdx: 3,
      multi: false,
      positions: [0, 1, 2, 4, 5],
      want: { reason: "position-unresolved", carPos: 4, playerPos: 0 },
    },
    {
      name: "an unresolved position misses before an unreadable player progress",
      field: edit(makeField(), (f) => (f.CarIdxLapDistPct![PLAYER] = -1)),
      carIdx: 3,
      multi: false,
      positions: [3, 1, 2, 0, 5],
      want: { reason: "position-unresolved", carPos: 0, playerPos: 3 },
    },
    // 3. Player progress.
    {
      name: "a missing player distance misses as player-progress-unreadable, never read as 0",
      field: edit(makeField(), (f) => {
        f.CarIdxLapDistPct = [];
        f.CarIdxLapDistPct[3] = 0.4;
      }),
      carIdx: 3,
      multi: false,
      want: { reason: "player-progress-unreadable", carPos: 4, playerPos: 3 },
    },
    {
      name: "a negative player lap count misses as player-progress-unreadable",
      field: edit(makeField(), (f) => (f.CarIdxLapCompleted![PLAYER] = -1)),
      carIdx: 3,
      multi: false,
      want: { reason: "player-progress-unreadable", carPos: 4, playerPos: 3 },
    },
    // 4. Car progress.
    {
      name: "an unreadable car progress misses as car-progress-unreadable",
      field: edit(makeField(), (f) => (f.CarIdxLapDistPct![3] = -1)),
      carIdx: 3,
      multi: false,
      want: { reason: "car-progress-unreadable", carPos: 4, playerPos: 3 },
    },
    {
      name: "a missing car lap count misses as car-progress-unreadable, never read as 0",
      field: edit(makeField(), (f) => (f.CarIdxLapCompleted = [10, 10, 10])),
      carIdx: 3,
      multi: false,
      want: { reason: "car-progress-unreadable", carPos: 4, playerPos: 3 },
    },
    // 5. Same lap.
    {
      name: "a lapped car misses as different-lap",
      field: edit(makeField(), (f) => (f.CarIdxLapCompleted![3] = 9)),
      carIdx: 3,
      multi: false,
      want: { reason: "different-lap", carPos: 4, playerPos: 3 },
    },
    {
      name: "a gap of 0.999 laps is the same lap",
      field: { CarIdxLapCompleted: [10, 10, 10, 10, 10], CarIdxLapDistPct: [0, 0.9, 0.7, 0.999, 0.2] },
      carIdx: 3,
      multi: false,
      want: { reason: null, carPos: 4, playerPos: 3, placesAhead: -1 },
    },
    {
      name: "a gap of exactly 1.0 lap is a different lap",
      field: { CarIdxLapCompleted: [10, 10, 10, 11, 10], CarIdxLapDistPct: [0, 0.9, 0.7, 0, 0.2] },
      carIdx: 3,
      multi: false,
      want: { reason: "different-lap", carPos: 4, playerPos: 3 },
    },
    {
      name: "a pair straddling the S/F line is the same lap",
      field: { CarIdxLapCompleted: [5, 10, 10, 4, 10], CarIdxLapDistPct: [0.01, 0.9, 0.7, 0.98, 0.2] },
      carIdx: 3,
      multi: false,
      want: { reason: null, carPos: 4, playerPos: 3, placesAhead: -1 },
    },
    // Placed: the sign and the projection.
    {
      name: "a car ahead reads a positive placesAhead",
      field: makeField(),
      carIdx: 1,
      multi: false,
      want: { reason: null, carPos: 1, playerPos: 3, placesAhead: 2 },
    },
    {
      name: "a car behind reads a negative placesAhead",
      field: makeField(),
      carIdx: 4,
      multi: false,
      want: { reason: null, carPos: 5, playerPos: 3, placesAhead: -2 },
    },
    {
      name: "multi-class ranks in class space",
      field: makeField(MULTI_CLASSES),
      carIdx: 2,
      multi: true,
      want: { reason: null, carPos: 1, playerPos: 2, placesAhead: 1 },
    },
    {
      name: "single-class ranks in overall space",
      field: makeField(),
      carIdx: 2,
      multi: false,
      want: { reason: null, carPos: 2, playerPos: 3, placesAhead: 1 },
    },
  ];

  it.each(cases)("$name", ({ field, carIdx, multi, positions, want }) => {
    expect(standing(field, carIdx, multi, positions)).toEqual(want);
  });

  it("reads the player only through the standing it is handed", () => {
    const player: PlayerStanding = { pos: 5, progress: 10.4 };

    expect(resolveStanding(tel(makeField()), POSITIONS, player, PLAYER, 3, false)).toEqual({
      reason: null,
      carPos: 4,
      playerPos: 5,
      placesAhead: 1,
    });
  });
});
