import { OpponentPenaltyFlag } from "@iracedeck/event-bus";
import { Flags } from "@iracedeck/iracing-native";
import { beforeEach, describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffOpponentFlags } from "./opponent-flags.js";
import type { PendingEvent } from "./types.js";

const PLAYER = 0;

type MutableField = {
  CarIdxSessionFlags: number[];
  CarIdxLapCompleted: number[];
  CarIdxLapDistPct: number[];
  CarIdxClass: number[];
  LapDistPct?: number;
  Speed?: number;
  SessionFlags?: number;
};

/** n-car field: player (carIdx 0) is P4 in the default 8-car shape. */
function makeField(n = 8): MutableField {
  return {
    CarIdxSessionFlags: Array<number>(n).fill(0),
    CarIdxLapCompleted: Array<number>(n).fill(10),
    CarIdxLapDistPct: Array<number>(n).fill(0.5),
    CarIdxClass: Array<number>(n).fill(100),
  };
}

/** frozenPositions indexed by carIdx (1-based ranks) — the 8-car field's canonical order. */
const POSITIONS = [4, 1, 2, 3, 5, 6, 7, 8];

function run(
  state: TranslatorState,
  telemetry: MutableField,
  now: number,
  opts: Partial<{
    player: number;
    isRace: boolean;
    replay: boolean;
    preGreen: boolean;
    postRace: boolean;
    multi: boolean;
    pace: number | null;
    positions: number[];
    trackLength: number | null;
  }> = {},
): PendingEvent[] {
  const out: PendingEvent[] = [];

  diffOpponentFlags(
    state,
    telemetry as never,
    opts.player ?? PLAYER,
    opts.pace ?? null,
    opts.isRace ?? true,
    opts.replay ?? false,
    opts.preGreen ?? false,
    opts.postRace ?? false,
    opts.multi ?? false,
    opts.positions ?? POSITIONS,
    opts.trackLength ?? 4000,
    now,
    (ev) => out.push(ev),
  );

  return out;
}

describe("diffOpponentFlags", () => {
  let state: TranslatorState;

  beforeEach(() => {
    state = createInitialState();
  });

  it("seeds the store silently on the first tick, flags included", () => {
    const t = makeField();
    t.CarIdxSessionFlags[3] = 0x50000; // Black + Servicible (the Step 0 capture value)

    expect(run(state, t, 1000)).toEqual([]);
    expect(state.opponentFlagsInitialized).toBe(true);
    expect(state.opponentFlagBits[3]).toBe(Flags.Black);
  });

  it("keeps the store truthful even when the callout gates are closed", () => {
    const t = makeField();
    run(state, t, 1000);
    t.CarIdxSessionFlags[3] = Flags.Repair;

    expect(run(state, t, 2000, { isRace: false })).toEqual([]);
    expect(state.opponentFlagBits[3]).toBe(Flags.Repair);
  });

  it("sizes per-car state from the live array length (72 cars, pace car at 64)", () => {
    const t = makeField(72);
    t.CarIdxSessionFlags[70] = Flags.Black;
    run(state, t, 1000);

    expect(state.opponentFlagBits.length).toBe(72);
    expect(state.opponentFlagBits[70]).toBe(Flags.Black);
  });

  it("announces a black flag rising on the car directly ahead (raised trigger)", () => {
    const t = makeField();
    run(state, t, 1000);
    t.CarIdxSessionFlags[3] = 0x50000; // carIdx 3 = P3, directly ahead of P4

    expect(run(state, t, 2000)).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "ahead",
          carIdx: 3,
          flag: OpponentPenaltyFlag.Black,
          trigger: "raised",
          position: 3,
          isMultiClass: false,
        },
      },
    ]);
  });

  it("announces every car within the 1-3 class-position ahead window", () => {
    const t = makeField();
    run(state, t, 1000);
    t.CarIdxSessionFlags[3] = Flags.Black; // P3, delta 1
    t.CarIdxSessionFlags[2] = Flags.Black; // P2, delta 2
    t.CarIdxSessionFlags[1] = Flags.Black; // P1, delta 3

    expect(run(state, t, 2000)).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "ahead",
          carIdx: 1,
          flag: OpponentPenaltyFlag.Black,
          trigger: "raised",
          position: 1,
          isMultiClass: false,
        },
      },
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "ahead",
          carIdx: 2,
          flag: OpponentPenaltyFlag.Black,
          trigger: "raised",
          position: 2,
          isMultiClass: false,
        },
      },
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "ahead",
          carIdx: 3,
          flag: OpponentPenaltyFlag.Black,
          trigger: "raised",
          position: 3,
          isMultiClass: false,
        },
      },
    ]);
  });

  it("does not announce a car 4 class positions ahead (outside the standings window, no track-ahead fallback)", () => {
    const t = makeField(10);
    const positions = [6, 1, 2, 3, 4, 5, 7, 8, 9, 10]; // player carIdx 0 = P6; carIdx 2 = P2, delta 4

    run(state, t, 1000, { positions });
    t.CarIdxSessionFlags[2] = Flags.Black;

    expect(run(state, t, 2000, { positions })).toEqual([]);
  });

  it("announces only the car directly behind (P+1), not P+2", () => {
    const t = makeField();
    run(state, t, 1000);
    t.CarIdxSessionFlags[4] = Flags.Black; // P5, one behind
    t.CarIdxSessionFlags[5] = Flags.Black; // P6, two behind — does not qualify

    expect(run(state, t, 2000)).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "behind",
          carIdx: 4,
          flag: OpponentPenaltyFlag.Black,
          trigger: "raised",
          position: 5,
          isMultiClass: false,
        },
      },
    ]);
  });

  it("multi-class: an other-class car ahead in standings needs track-ahead, not standings; position maps through classPositionFromOrder", () => {
    const t = makeField(10);
    t.CarIdxClass = [100, 100, 100, 100, 100, 200, 200, 200, 200, 200];
    const positions = [5, 1, 2, 8, 9, 3, 4, 6, 7, 10]; // overall ranks; player (carIdx 0, class 100) is class-pos 3
    t.LapDistPct = 0.5;
    t.Speed = 50;

    run(state, t, 1000, { multi: true, positions });
    t.CarIdxSessionFlags[5] = Flags.Black; // class 200, overall pos 3 — standings-ahead of the player but different class
    t.CarIdxLapDistPct[5] = 0.6; // 8s forward gap at Speed 50, trackLength 4000

    expect(run(state, t, 2000, { multi: true, positions })).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "track-ahead",
          carIdx: 5,
          flag: OpponentPenaltyFlag.Black,
          trigger: "raised",
          position: 1, // carIdx 5's class-200 position, via classPositionFromOrder
          gapSeconds: expect.closeTo(8, 5),
          isMultiClass: true,
        },
      },
    ]);
  });

  it("same-lap gate: a standings-adjacent car a full lap off fails standings qualification (and has no track-ahead telemetry)", () => {
    const t = makeField();
    run(state, t, 1000);
    t.CarIdxSessionFlags[3] = Flags.Black; // P3, would otherwise be "ahead" at delta 1
    t.CarIdxLapCompleted[3] = 9; // one lap down, and the progress-score gap is >= 1.0

    expect(run(state, t, 2000)).toEqual([]);
  });

  it("debounces Furled: no emission until it's been continuously up for the debounce window, then announces as raised", () => {
    const t = makeField();
    run(state, t, 1000);
    t.CarIdxSessionFlags[3] = Flags.Furled;

    expect(run(state, t, 2000)).toEqual([]); // just rose — debounce not met

    expect(run(state, t, 3100)).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "ahead",
          carIdx: 3,
          flag: OpponentPenaltyFlag.Furled,
          trigger: "raised",
          position: 3,
          isMultiClass: false,
        },
      },
    ]);
  });

  it("never announces a Furled flicker that clears before the debounce window elapses", () => {
    const t = makeField();
    run(state, t, 1000);
    t.CarIdxSessionFlags[3] = Flags.Furled;
    run(state, t, 2000);
    t.CarIdxSessionFlags[3] = 0;

    expect(run(state, t, 2500)).toEqual([]);
    expect(run(state, t, 3600)).toEqual([]);
  });

  it("handles the furled-clears + black-sets escalation in one tick with exactly one emission (#846)", () => {
    const t = makeField();
    run(state, t, 1000);
    t.CarIdxSessionFlags[3] = Flags.Furled;
    run(state, t, 2000);

    expect(run(state, t, 3100)).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "ahead",
          carIdx: 3,
          flag: OpponentPenaltyFlag.Furled,
          trigger: "raised",
          position: 3,
          isMultiClass: false,
        },
      },
    ]);

    // Escalation: Furled clears + Black sets in the same tick.
    t.CarIdxSessionFlags[3] = Flags.Black;

    expect(run(state, t, 4000)).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "ahead",
          carIdx: 3,
          flag: OpponentPenaltyFlag.Black,
          trigger: "raised",
          position: 3,
          isMultiClass: false,
        },
      },
    ]);

    // Furled rises again later (its own episode + cooldown have both fully
    // reset) — a fresh episode, so it announces again.
    t.CarIdxSessionFlags[3] = Flags.Furled;
    expect(run(state, t, 40000)).toEqual([]); // debounce not yet met

    expect(run(state, t, 41200)).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "ahead",
          carIdx: 3,
          flag: OpponentPenaltyFlag.Furled,
          trigger: "raised",
          position: 3,
          isMultiClass: false,
        },
      },
    ]);
  });

  it("announces meatball as entered-range once the car's position shifts into the window (level trigger)", () => {
    const t = makeField(10);
    const initial = [6, 2, 1, 3, 4, 5, 7, 8, 9, 10]; // player carIdx 0 = P6; carIdx 2 = P1, delta 5

    run(state, t, 1000, { positions: initial });
    t.CarIdxSessionFlags[2] = Flags.Repair;

    expect(run(state, t, 2000, { positions: initial })).toEqual([]);

    const shifted = [6, 2, 5, 3, 4, 1, 7, 8, 9, 10]; // carIdx 2 now P5, delta 1 — ahead

    expect(run(state, t, 3000, { positions: shifted })).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "ahead",
          carIdx: 2,
          flag: OpponentPenaltyFlag.Repair,
          trigger: "entered-range",
          position: 5,
          isMultiClass: false,
        },
      },
    ]);
  });

  it("classifies a flagged car purely by track proximity when standings can't place it (position omitted when unclassified)", () => {
    const t = makeField();
    const positions = [4, 1, 2, 3, 5, 0, 7, 8]; // carIdx 5 unclassified — no standings path
    t.LapDistPct = 0.5;
    t.Speed = 50;

    run(state, t, 1000, { positions, trackLength: 5000 });
    t.CarIdxSessionFlags[5] = Flags.Black;
    t.CarIdxLapDistPct[5] = 0.58; // 8s forward gap at Speed 50, trackLength 5000
    t.CarIdxLapCompleted[5] = 8; // a different lap than the player's

    expect(run(state, t, 2000, { positions, trackLength: 5000 })).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "track-ahead",
          carIdx: 5,
          flag: OpponentPenaltyFlag.Black,
          trigger: "raised",
          gapSeconds: expect.closeTo(8, 5),
          isMultiClass: false,
        },
      },
    ]);
  });

  it("applies enter/exit hysteresis to the track-ahead window without re-announcing across a small gap wobble", () => {
    const t = makeField();
    const positions = [4, 1, 2, 3, 5, 0, 7, 8]; // carIdx 5 unclassified — track-ahead only
    t.LapDistPct = 0.5;
    t.Speed = 40;

    run(state, t, 1000, { positions, trackLength: 4000 });
    t.CarIdxSessionFlags[5] = Flags.Black;
    t.CarIdxLapDistPct[5] = 0.59; // 9s — inside the 10s enter bound

    expect(run(state, t, 2000, { positions, trackLength: 4000 })).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "track-ahead",
          carIdx: 5,
          flag: OpponentPenaltyFlag.Black,
          trigger: "raised",
          gapSeconds: expect.closeTo(9, 5),
          isMultiClass: false,
        },
      },
    ]);

    // Hovers at 10.5s — inside the 12s exit bound, hysteresis keeps it in
    // the window. Already announced this episode — silent either way.
    t.CarIdxLapDistPct[5] = 0.605;
    expect(run(state, t, 10000, { positions, trackLength: 4000 })).toEqual([]);

    // Leaves to 13s — past the exit bound, the window closes.
    t.CarIdxLapDistPct[5] = 0.63;
    expect(run(state, t, 20000, { positions, trackLength: 4000 })).toEqual([]);

    // Flag clears (episode + cooldown both long since spent) then re-raises,
    // re-entering at 9s — inside the enter bound — announces again.
    t.CarIdxSessionFlags[5] = 0;
    run(state, t, 32000, { positions, trackLength: 4000 });

    t.CarIdxSessionFlags[5] = Flags.Black;
    t.CarIdxLapDistPct[5] = 0.59;
    expect(run(state, t, 40000, { positions, trackLength: 4000 })).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "track-ahead",
          carIdx: 5,
          flag: OpponentPenaltyFlag.Black,
          trigger: "raised",
          gapSeconds: expect.closeTo(9, 5),
          isMultiClass: false,
        },
      },
    ]);
  });

  it("stays silent across a window exit/re-entry while the same flag episode continues (episode latch across triggers)", () => {
    const t = makeField();
    run(state, t, 1000);
    t.CarIdxSessionFlags[3] = Flags.Black;

    expect(run(state, t, 2000)).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "ahead",
          carIdx: 3,
          flag: OpponentPenaltyFlag.Black,
          trigger: "raised",
          position: 3,
          isMultiClass: false,
        },
      },
    ]);

    const shifted = [4, 1, 2, 8, 5, 6, 7, 3]; // carIdx 3 now P8 — well outside the window

    expect(run(state, t, 3000, { positions: shifted })).toEqual([]); // left the window

    expect(run(state, t, 4000)).toEqual([]); // back in the window, same episode — silent
  });

  it("does not suppress an escalation via the first flag's cooldown, but does suppress a same-flag re-raise within the cooldown", () => {
    const t = makeField();
    run(state, t, 1000);
    t.CarIdxSessionFlags[3] = Flags.Black;

    expect(run(state, t, 2000)).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "ahead",
          carIdx: 3,
          flag: OpponentPenaltyFlag.Black,
          trigger: "raised",
          position: 3,
          isMultiClass: false,
        },
      },
    ]);

    // DQ rises on the same car — a different flag, own cooldown, announces
    // immediately (the black cooldown never suppresses it).
    t.CarIdxSessionFlags[3] = Flags.Black | Flags.Disqualify;

    expect(run(state, t, 5000)).toEqual([
      {
        event: "opponentFlag.flagged",
        data: {
          relation: "ahead",
          carIdx: 3,
          flag: OpponentPenaltyFlag.Disqualify,
          trigger: "raised",
          position: 3,
          isMultiClass: false,
        },
      },
    ]);

    // Black clears then re-raises well inside its own 30s cooldown — suppressed.
    t.CarIdxSessionFlags[3] = Flags.Disqualify;
    run(state, t, 10000);
    t.CarIdxSessionFlags[3] = Flags.Black | Flags.Disqualify;

    expect(run(state, t, 15000)).toEqual([]);
  });

  it("suppresses the whole announce pass under every gate, replaying as entered-range (not a raise) once the gate opens", () => {
    const gateOptions: Array<
      Partial<{ isRace: boolean; replay: boolean; preGreen: boolean; postRace: boolean; player: number }>
    > = [
      { isRace: false },
      { replay: true },
      { preGreen: true },
      { postRace: true },
      { player: -1 },
    ];

    for (const gateOpt of gateOptions) {
      const s = createInitialState();
      const t = makeField();
      run(s, t, 1000); // seed — carIdx 3 (P3) established as directly-ahead
      t.CarIdxSessionFlags[3] = Flags.Black;

      expect(run(s, t, 2000, gateOpt)).toEqual([]); // rise absorbed under the gate

      expect(run(s, t, 3000)).toEqual([
        {
          event: "opponentFlag.flagged",
          data: {
            relation: "ahead",
            carIdx: 3,
            flag: OpponentPenaltyFlag.Black,
            trigger: "entered-range",
            position: 3,
            isMultiClass: false,
          },
        },
      ]);
    }
  });

  it("excludes the pace car and the player's own car from announcements", () => {
    const t = makeField();
    run(state, t, 1000, { pace: 6 });
    t.CarIdxSessionFlags[6] = Flags.Black; // pace car
    t.CarIdxSessionFlags[0] = Flags.Black; // player's own car

    expect(run(state, t, 2000, { pace: 6 })).toEqual([]);
  });

  it("skips a car with negative lap-completed/lap-dist-pct telemetry (not in world)", () => {
    const t = makeField();
    run(state, t, 1000);
    t.CarIdxSessionFlags[3] = Flags.Black;
    t.CarIdxLapCompleted[3] = -1;
    t.CarIdxLapDistPct[3] = -1;

    expect(run(state, t, 2000)).toEqual([]);
  });
});
