import { TrkLoc } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffOpponentPit, OPPONENT_PIT_AGGREGATE_WINDOW_MS, OPPONENT_PIT_CAR_COOLDOWN_MS } from "./opponent-pit.js";
import type { PendingEvent } from "./types.js";

const PLAYER = 0;

type MutableField = {
  CarIdxTrackSurface: number[];
  CarIdxLapCompleted: number[];
  CarIdxLapDistPct: number[];
  CarIdxClass: number[];
};

/** 8-car field: player (carIdx 0) is P4; ranks by carIdx = [4, 1, 2, 3, 5, 6, 7, 8]. */
function makeField(): MutableField {
  const n = 8;

  return {
    CarIdxTrackSurface: Array<number>(n).fill(TrkLoc.OnTrack),
    CarIdxLapCompleted: Array<number>(n).fill(10),
    CarIdxLapDistPct: [0.4, 0.9, 0.8, 0.6, 0.3, 0.2, 0.1, 0.05],
    CarIdxClass: Array<number>(n).fill(100),
  };
}

/** frozenPositions indexed by carIdx (1-based ranks). */
const POSITIONS = [4, 1, 2, 3, 5, 6, 7, 8];

function run(
  state: TranslatorState,
  telemetry: MutableField,
  now: number,
  opts: Partial<{
    isRace: boolean;
    replay: boolean;
    preGreen: boolean;
    multi: boolean;
    pace: number | null;
    positions: number[];
  }> = {},
): PendingEvent[] {
  const out: PendingEvent[] = [];

  diffOpponentPit(
    state,
    telemetry as never,
    PLAYER,
    opts.pace ?? null,
    opts.isRace ?? true,
    opts.replay ?? false,
    opts.preGreen ?? false,
    opts.multi ?? false,
    opts.positions ?? POSITIONS,
    now,
    (ev) => out.push(ev),
  );

  return out;
}

describe("diffOpponentPit", () => {
  let state: TranslatorState;

  beforeEach(() => {
    state = createInitialState();
  });

  it("seeds silently on the first tick, even with a car already approaching", () => {
    const t = makeField();
    t.CarIdxTrackSurface[3] = TrkLoc.AproachingPits;

    expect(run(state, t, 1000)).toEqual([]);
    expect(state.opponentPitInitialized).toBe(true);

    // Still no emission on the next tick — the car was already approaching at seed.
    expect(run(state, t, 2000)).toEqual([]);
  });

  it("maps effective-position deltas to relations", () => {
    const cases: Array<{ carIdx: number; relation: string; position: number }> = [
      { carIdx: 3, relation: "ahead", position: 3 },
      { carIdx: 4, relation: "behind", position: 5 },
      { carIdx: 2, relation: "nearby", position: 2 },
      { carIdx: 5, relation: "nearby", position: 6 },
      { carIdx: 1, relation: "leader", position: 1 },
    ];

    for (const c of cases) {
      const s = createInitialState();
      run(s, makeField(), 1000);
      const t = makeField();
      t.CarIdxTrackSurface[c.carIdx] = TrkLoc.AproachingPits;

      expect(run(s, t, 2000)).toEqual([
        {
          event: "opponentPit.entered",
          data: { relation: c.relation, carIdx: c.carIdx, position: c.position, isMultiClass: false },
        },
      ]);
    }
  });

  it("ignores cars outside the ±2 window", () => {
    run(state, makeField(), 1000);
    const t = makeField();
    t.CarIdxTrackSurface[6] = TrkLoc.AproachingPits; // P7
    t.CarIdxTrackSurface[7] = TrkLoc.AproachingPits; // P8

    expect(run(state, t, 2000)).toEqual([]);
  });

  it("announces the leader regardless of lap difference", () => {
    const seed = makeField();
    seed.CarIdxLapCompleted[1] = 20;
    run(state, seed, 1000);
    const t = makeField();
    t.CarIdxLapCompleted[1] = 20; // 10 laps ahead of the player
    t.CarIdxTrackSurface[1] = TrkLoc.AproachingPits;

    expect(run(state, t, 2000)).toEqual([
      { event: "opponentPit.entered", data: { relation: "leader", carIdx: 1, position: 1, isMultiClass: false } },
    ]);
  });

  it("suppresses non-leader cars a full lap away, allows sub-lap gaps", () => {
    // carIdx 2 (P2, nearby). Player score 10.4.
    const farSeed = makeField();
    farSeed.CarIdxLapCompleted[2] = 11;
    farSeed.CarIdxLapDistPct[2] = 0.5; // score 11.5 → gap 1.1 ≥ 1.0
    run(state, farSeed, 1000);
    const far = makeField();
    far.CarIdxLapCompleted[2] = 11;
    far.CarIdxLapDistPct[2] = 0.5;
    far.CarIdxTrackSurface[2] = TrkLoc.AproachingPits;

    expect(run(state, far, 2000)).toEqual([]);

    // Same car within a lap: score 11.1 vs 10.4 → gap 0.7 < 1.0 → emits.
    const s2 = createInitialState();
    const nearSeed = makeField();
    nearSeed.CarIdxLapCompleted[2] = 11;
    nearSeed.CarIdxLapDistPct[2] = 0.1;
    run(s2, nearSeed, 1000);
    const near = makeField();
    near.CarIdxLapCompleted[2] = 11;
    near.CarIdxLapDistPct[2] = 0.1;
    near.CarIdxTrackSurface[2] = TrkLoc.AproachingPits;

    expect(run(s2, near, 2000)).toEqual([
      { event: "opponentPit.entered", data: { relation: "nearby", carIdx: 2, position: 2, isMultiClass: false } },
    ]);
  });

  it("multi-class: skips other-class cars, speaks class-space positions", () => {
    // Classes: player (0) + carIdx 2, 3 in class 100; carIdx 1, 4-7 in class 200.
    // Overall ranks [4,1,2,3,5,6,7,8] → class-100 ranks: carIdx2→1, carIdx3→2, player→3.
    const classes = [100, 200, 100, 100, 200, 200, 200, 200];
    const seed = makeField();
    seed.CarIdxClass = classes;
    run(state, seed, 1000, { multi: true });

    // Other-class car directly ahead overall (carIdx 3 is same class here — use carIdx 4, class 200, P5).
    const other = makeField();
    other.CarIdxClass = classes;
    other.CarIdxTrackSurface[4] = TrkLoc.AproachingPits;

    expect(run(state, other, 2000, { multi: true })).toEqual([]);

    // Same-class car: carIdx 2 is the CLASS leader (class rank 1) → leader relation.
    const s2 = createInitialState();
    const seed2 = makeField();
    seed2.CarIdxClass = classes;
    run(s2, seed2, 1000, { multi: true });
    const t2 = makeField();
    t2.CarIdxClass = classes;
    t2.CarIdxTrackSurface[2] = TrkLoc.AproachingPits;

    expect(run(s2, t2, 2000, { multi: true })).toEqual([
      { event: "opponentPit.entered", data: { relation: "leader", carIdx: 2, position: 1, isMultiClass: true } },
    ]);

    // carIdx 3: class rank 2, player class rank 3 → ahead, class-space position 2.
    const s3 = createInitialState();
    const seed3 = makeField();
    seed3.CarIdxClass = classes;
    run(s3, seed3, 1000, { multi: true });
    const t3 = makeField();
    t3.CarIdxClass = classes;
    t3.CarIdxTrackSurface[3] = TrkLoc.AproachingPits;

    expect(run(s3, t3, 2000, { multi: true })).toEqual([
      { event: "opponentPit.entered", data: { relation: "ahead", carIdx: 3, position: 2, isMultiClass: true } },
    ]);
  });

  it("skips the player and the pace car", () => {
    run(state, makeField(), 1000, { pace: 4 });
    const t = makeField();
    t.CarIdxTrackSurface[PLAYER] = TrkLoc.AproachingPits;
    t.CarIdxTrackSurface[4] = TrkLoc.AproachingPits;

    expect(run(state, t, 2000, { pace: 4 })).toEqual([]);
  });

  it("skips cars that are not in world", () => {
    run(state, makeField(), 1000);
    const t = makeField();
    t.CarIdxTrackSurface[3] = TrkLoc.AproachingPits;
    t.CarIdxLapCompleted[3] = -1;

    expect(run(state, t, 2000)).toEqual([]);
  });

  it("applies a per-car re-announce cooldown", () => {
    run(state, makeField(), 1000);
    const enter = makeField();
    enter.CarIdxTrackSurface[3] = TrkLoc.AproachingPits;

    expect(run(state, enter, 2000)).toHaveLength(1);

    // Leaves the approach zone, re-enters 5 s later — still cooling down.
    run(state, makeField(), 4000);
    expect(run(state, enter, 7000)).toEqual([]);

    // Re-enters after the cooldown — announces again.
    run(state, makeField(), 2000 + OPPONENT_PIT_CAR_COOLDOWN_MS, {});
    expect(run(state, enter, 2000 + OPPONENT_PIT_CAR_COOLDOWN_MS + 1000)).toHaveLength(1);
  });

  it("does not re-emit while the car stays in the approach state", () => {
    run(state, makeField(), 1000);
    const t = makeField();
    t.CarIdxTrackSurface[3] = TrkLoc.AproachingPits;

    expect(run(state, t, 2000)).toHaveLength(1);
    expect(run(state, t, 2100)).toEqual([]);
    expect(run(state, t, 2200)).toEqual([]);
  });

  it("collapses the 3rd+ near-simultaneous entries into one aggregate", () => {
    run(state, makeField(), 1000);

    const a = makeField();
    a.CarIdxTrackSurface[3] = TrkLoc.AproachingPits;
    expect(run(state, a, 2000)).toEqual([
      { event: "opponentPit.entered", data: { relation: "ahead", carIdx: 3, position: 3, isMultiClass: false } },
    ]);

    const b = makeField();
    b.CarIdxTrackSurface[3] = TrkLoc.AproachingPits;
    b.CarIdxTrackSurface[4] = TrkLoc.AproachingPits;
    expect(run(state, b, 3000)).toEqual([
      { event: "opponentPit.entered", data: { relation: "behind", carIdx: 4, position: 5, isMultiClass: false } },
    ]);

    const c = makeField();
    c.CarIdxTrackSurface[3] = TrkLoc.AproachingPits;
    c.CarIdxTrackSurface[4] = TrkLoc.AproachingPits;
    c.CarIdxTrackSurface[2] = TrkLoc.AproachingPits;
    expect(run(state, c, 4000)).toEqual([{ event: "opponentPit.entered", data: { relation: "others" } }]);

    // 4th entry inside the window — silent.
    const d = makeField();
    d.CarIdxTrackSurface[3] = TrkLoc.AproachingPits;
    d.CarIdxTrackSurface[4] = TrkLoc.AproachingPits;
    d.CarIdxTrackSurface[2] = TrkLoc.AproachingPits;
    d.CarIdxTrackSurface[5] = TrkLoc.AproachingPits;
    expect(run(state, d, 5000)).toEqual([]);
  });

  it("announces the leader individually even mid-aggregation", () => {
    run(state, makeField(), 1000);

    const t = makeField();
    t.CarIdxTrackSurface[3] = TrkLoc.AproachingPits;
    run(state, t, 2000);
    t.CarIdxTrackSurface[4] = TrkLoc.AproachingPits;
    run(state, t, 3000);
    t.CarIdxTrackSurface[2] = TrkLoc.AproachingPits;
    run(state, t, 4000); // aggregate fired

    t.CarIdxTrackSurface[1] = TrkLoc.AproachingPits;
    expect(run(state, t, 5000)).toEqual([
      { event: "opponentPit.entered", data: { relation: "leader", carIdx: 1, position: 1, isMultiClass: false } },
    ]);
  });

  it("resets the aggregation episode after a quiet window", () => {
    run(state, makeField(), 1000);

    const t = makeField();
    t.CarIdxTrackSurface[3] = TrkLoc.AproachingPits;
    run(state, t, 2000);
    t.CarIdxTrackSurface[4] = TrkLoc.AproachingPits;
    run(state, t, 3000);
    t.CarIdxTrackSurface[2] = TrkLoc.AproachingPits;
    run(state, t, 4000); // aggregate fired

    // Quiet tick past the window — episode ends.
    const quietAt = 4000 + OPPONENT_PIT_AGGREGATE_WINDOW_MS + 1000;
    run(state, makeField(), quietAt);
    expect(state.opponentPitRecentEntries).toEqual([]);
    expect(state.opponentPitAggregateAnnounced).toBe(false);

    // New entry announces individually again (cooldown for carIdx 5 is fresh).
    const e = makeField();
    e.CarIdxTrackSurface[5] = TrkLoc.AproachingPits;
    expect(run(state, e, quietAt + 1000)).toEqual([
      { event: "opponentPit.entered", data: { relation: "nearby", carIdx: 5, position: 6, isMultiClass: false } },
    ]);
  });

  it("stays silent outside live races and absorbs gated transitions", () => {
    run(state, makeField(), 1000);
    const t = makeField();
    t.CarIdxTrackSurface[3] = TrkLoc.AproachingPits;

    expect(run(state, t, 2000, { isRace: false })).toEqual([]);
    // Baseline advanced during the gate — reopening it does not replay.
    expect(run(state, t, 3000)).toEqual([]);

    const s2 = createInitialState();
    run(s2, makeField(), 1000);
    expect(run(s2, t, 2000, { replay: true })).toEqual([]);

    const s3 = createInitialState();
    run(s3, makeField(), 1000);
    expect(run(s3, t, 2000, { preGreen: true })).toEqual([]);
  });

  it("tolerates missing telemetry arrays", () => {
    const bare = {} as MutableField;

    expect(run(state, bare, 1000)).toEqual([]);
    expect(state.opponentPitInitialized).toBe(false);
  });
});
