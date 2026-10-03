import { OpponentPenaltyFlag } from "@iracedeck/event-bus";
import { Flags } from "@iracedeck/iracing-native";
import { TrkLoc } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import {
  diffOpponentFlags,
  OPPONENT_FLAG_BLACK_HOLD_MS,
  OPPONENT_FLAG_DEFAULT_RANGE_SECONDS,
  OPPONENT_FLAG_FURLED_DEBOUNCE_MS,
  sanitizeOpponentFlagRangeSeconds,
} from "./opponent-flags.js";
import type { PendingEvent } from "./types.js";

const PLAYER = 0;

/** The race gap the default resolver reports for every pair — inside the default 3 s range. */
const DEFAULT_GAP = 1.5;

type MutableField = {
  CarIdxSessionFlags: number[];
  CarIdxLapCompleted: number[];
  CarIdxLapDistPct: number[];
  CarIdxClass: Array<number | undefined>;
  CarIdxTrackSurface?: number[];
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

/** The default session's car number for a carIdx — `"13"` for carIdx 3. */
const num = (carIdx: number): string => String(10 + carIdx);

/** Session info with one `DriverInfo.Drivers` row per car, numbered by {@link num}. */
const SESSION_INFO: Record<string, unknown> = {
  DriverInfo: { Drivers: Array.from({ length: 72 }, (_, i) => ({ CarIdx: i, CarNumber: num(i) })) },
};

type GapResolver = (aheadCarIdx: number, behindCarIdx: number) => number | null;

/** A gap resolver keyed by the non-player car of the pair; unlisted cars read {@link DEFAULT_GAP}. */
function gapsByCar(gaps: Record<number, number | null>): GapResolver {
  return (ahead, behind) => {
    const other = ahead === PLAYER ? behind : ahead;

    return other in gaps ? gaps[other]! : DEFAULT_GAP;
  };
}

type RunOptions = Partial<{
  player: number;
  isRace: boolean;
  replay: boolean;
  preGreen: boolean;
  postRace: boolean;
  multi: boolean;
  pace: number | null;
  positions: number[];
  enabled: (flag: OpponentPenaltyFlag) => boolean;
  gap: GapResolver;
  range: number | (() => number);
  sessionInfo: Record<string, unknown> | null;
  logger: ILogger;
}>;

function run(state: TranslatorState, telemetry: MutableField, now: number, opts: RunOptions = {}): PendingEvent[] {
  const out: PendingEvent[] = [];
  const range = opts.range ?? OPPONENT_FLAG_DEFAULT_RANGE_SECONDS;

  diffOpponentFlags(
    state,
    telemetry as never,
    "sessionInfo" in opts ? (opts.sessionInfo ?? null) : SESSION_INFO,
    opts.player ?? PLAYER,
    opts.pace ?? null,
    opts.isRace ?? true,
    opts.replay ?? false,
    opts.preGreen ?? false,
    opts.postRace ?? false,
    opts.multi ?? false,
    opts.positions ?? POSITIONS,
    {
      getCalloutEnabled: opts.enabled ?? (() => true),
      getRaceGap: opts.gap ?? (() => DEFAULT_GAP),
      getRangeSeconds: typeof range === "function" ? range : () => range,
    },
    now,
    (ev) => out.push(ev),
    opts.logger,
  );

  return out;
}

type Expected = Partial<{
  trigger: "raised" | "entered-range";
  gapSeconds: number;
  carNumber: string;
  isMultiClass: boolean;
}>;

/** The individual event the diff emits, with the default field's car number and gap unless overridden. */
function flagged(
  carIdx: number,
  flag: OpponentPenaltyFlag,
  relation: "ahead" | "behind",
  position: number,
  extra: Expected = {},
): PendingEvent {
  return {
    event: "opponentFlag.flagged",
    data: {
      relation,
      carIdx,
      flag,
      trigger: "raised",
      isMultiClass: false,
      position,
      carNumber: num(carIdx),
      gapSeconds: DEFAULT_GAP,
      ...extra,
    },
  };
}

const OTHERS: PendingEvent = { event: "opponentFlag.flagged", data: { relation: "others" } };

function createMockLogger(): ILogger & { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: vi.fn(() => logger),
    createScope: vi.fn(() => logger),
  };

  return logger as unknown as ILogger & { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
}

describe("diffOpponentFlags", () => {
  let state: TranslatorState;

  beforeEach(() => {
    state = createInitialState();
  });

  describe("the store", () => {
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
      expect(state.opponentFlagHeldSinceAt.black.length).toBe(72);
      expect(state.opponentFlagHeldSinceAt.black[70]).toBe(1000);
    });
  });

  describe("qualification (issue #1274)", () => {
    it("announces a meatball rising on the car directly ahead, naming it and carrying the race gap", () => {
      const t = makeField();
      const gap = vi.fn<GapResolver>(() => 2.25);

      run(state, t, 1000, { gap });
      t.CarIdxSessionFlags[3] = Flags.Repair; // carIdx 3 = P3, directly ahead of P4

      expect(run(state, t, 2000, { gap })).toEqual([
        flagged(3, OpponentPenaltyFlag.Repair, "ahead", 3, { gapSeconds: 2.25 }),
      ]);
      // The ahead car's gap is read with the car as the leader of the pair.
      expect(gap).toHaveBeenCalledWith(3, PLAYER);
    });

    it.each([
      { carIdx: 5, position: 5, delta: 1 },
      { carIdx: 4, position: 4, delta: 2 },
      { carIdx: 3, position: 3, delta: 3 },
    ])("qualifies a car $delta class position(s) ahead", ({ carIdx, position }) => {
      const t = makeField(10);
      const positions = [6, 1, 2, 3, 4, 5, 7, 8, 9, 10]; // player carIdx 0 = P6

      run(state, t, 1000, { positions });
      t.CarIdxSessionFlags[carIdx] = Flags.Repair;

      expect(run(state, t, 2000, { positions })).toEqual([
        flagged(carIdx, OpponentPenaltyFlag.Repair, "ahead", position),
      ]);
    });

    it("does not qualify a car 4 class positions ahead, however close in the race", () => {
      const t = makeField(10);
      const positions = [6, 1, 2, 3, 4, 5, 7, 8, 9, 10]; // carIdx 2 = P2, delta 4

      run(state, t, 1000, { positions });
      t.CarIdxSessionFlags[2] = Flags.Repair;

      expect(run(state, t, 2000, { positions, gap: () => 0.2 })).toEqual([]);
    });

    it("qualifies only the car directly behind (P+1), not P+2, reading the gap with the player leading", () => {
      const t = makeField();
      const gap = vi.fn<GapResolver>(() => DEFAULT_GAP);

      run(state, t, 1000, { gap });
      t.CarIdxSessionFlags[4] = Flags.Repair; // P5, one behind
      t.CarIdxSessionFlags[5] = Flags.Repair; // P6, two behind — does not qualify

      expect(run(state, t, 2000, { gap })).toEqual([flagged(4, OpponentPenaltyFlag.Repair, "behind", 5)]);
      expect(gap).toHaveBeenCalledWith(PLAYER, 4);
      // P+2 fails on positions, before its gap is ever looked up.
      expect(gap).not.toHaveBeenCalledWith(PLAYER, 5);
    });

    it("multi-class: a different-class car never qualifies; a same-class one maps through class positions", () => {
      const t = makeField(10);
      t.CarIdxClass = [100, 100, 100, 100, 100, 200, 200, 200, 200, 200];
      // Overall ranks. Class 100 runs car1 (1), car2 (2), car0 (5), car3 (8),
      // car4 (9) — the player is class-P3. Car 5 (class 200) is overall P3,
      // directly ahead of the player on the overall order.
      const positions = [5, 1, 2, 8, 9, 3, 4, 6, 7, 10];

      run(state, t, 1000, { multi: true, positions });
      t.CarIdxSessionFlags[5] = Flags.Repair;

      expect(run(state, t, 2000, { multi: true, positions, gap: () => 0.3 })).toEqual([]);

      t.CarIdxSessionFlags[2] = Flags.Repair; // class-P2 — one ahead in class
      t.CarIdxSessionFlags[3] = Flags.Repair; // class-P4 — one behind in class

      expect(run(state, t, 3000, { multi: true, positions })).toEqual([
        flagged(2, OpponentPenaltyFlag.Repair, "ahead", 2, { isMultiClass: true }),
        flagged(3, OpponentPenaltyFlag.Repair, "behind", 4, { isMultiClass: true }),
      ]);
    });

    it("multi-class: an unreadable class — the car's or the player's — never qualifies", () => {
      const positions = POSITIONS;
      const carUnreadable = makeField();
      carUnreadable.CarIdxClass[3] = undefined;

      run(state, carUnreadable, 1000, { multi: true, positions });
      carUnreadable.CarIdxSessionFlags[3] = Flags.Repair;
      expect(run(state, carUnreadable, 2000, { multi: true, positions })).toEqual([]);

      const playerState = createInitialState();
      const playerUnreadable = makeField();
      playerUnreadable.CarIdxClass[PLAYER] = undefined;

      run(playerState, playerUnreadable, 1000, { multi: true, positions });
      playerUnreadable.CarIdxSessionFlags[3] = Flags.Repair;
      expect(run(playerState, playerUnreadable, 2000, { multi: true, positions })).toEqual([]);
    });

    it("never qualifies a readable different class, even while the session does not read multi-class (no session info yet)", () => {
      const logger = createMockLogger();
      const t = makeField();
      t.CarIdxClass[3] = 999;

      run(state, t, 1000, { logger });
      t.CarIdxSessionFlags[3] = Flags.Repair;

      expect(run(state, t, 2000, { logger, sessionInfo: null })).toEqual([]);
      expect(logger.debug.mock.calls[0]![0]).toContain("reason=different-class");
    });

    it("single-class sessions do not need CarIdxClass — an unreadable class still qualifies", () => {
      const t = makeField();
      t.CarIdxClass[3] = undefined;

      run(state, t, 1000);
      t.CarIdxSessionFlags[3] = Flags.Repair;

      expect(run(state, t, 2000)).toEqual([flagged(3, OpponentPenaltyFlag.Repair, "ahead", 3)]);
    });

    it("never qualifies a lapped or lapping same-class car, even standings-adjacent and close in the race", () => {
      const t = makeField();
      run(state, t, 1000);
      t.CarIdxSessionFlags[3] = Flags.Repair; // P3 ahead — but a lap down
      t.CarIdxLapCompleted[3] = 9;
      t.CarIdxSessionFlags[4] = Flags.Repair; // P5 behind — but a lap up
      t.CarIdxLapCompleted[4] = 11;

      expect(run(state, t, 2000, { gap: () => 0.5 })).toEqual([]);
    });

    describe("the race-gap range", () => {
      it.each([
        { range: OPPONENT_FLAG_DEFAULT_RANGE_SECONDS, carIdx: 3, relation: "ahead" as const, position: 3 },
        { range: OPPONENT_FLAG_DEFAULT_RANGE_SECONDS, carIdx: 4, relation: "behind" as const, position: 5 },
        { range: 7, carIdx: 3, relation: "ahead" as const, position: 3 },
        { range: 7, carIdx: 4, relation: "behind" as const, position: 5 },
      ])(
        "a $relation gap equal to a $range s range qualifies, just over it does not",
        ({ range, carIdx, relation, position }) => {
          const atBound = makeField();
          run(state, atBound, 1000, { range });
          atBound.CarIdxSessionFlags[carIdx] = Flags.Repair;

          expect(run(state, atBound, 2000, { range, gap: () => range })).toEqual([
            flagged(carIdx, OpponentPenaltyFlag.Repair, relation, position, { gapSeconds: range }),
          ]);

          const overState = createInitialState();
          const over = makeField();
          run(overState, over, 1000, { range });
          over.CarIdxSessionFlags[carIdx] = Flags.Repair;

          expect(run(overState, over, 2000, { range, gap: () => range + 0.01 })).toEqual([]);
        },
      );

      it("reads a range change on the next announce, letting an already-flagged car in range announce as entered-range", () => {
        const t = makeField();
        let range = 2;
        const getRange = vi.fn(() => range);
        const gap = gapsByCar({ 3: 2.5 });

        run(state, t, 1000, { range: getRange, gap });
        t.CarIdxSessionFlags[3] = Flags.Repair;

        expect(run(state, t, 2000, { range: getRange, gap })).toEqual([]); // 2.5 s > 2 s
        expect(run(state, t, 3000, { range: getRange, gap })).toEqual([]);

        range = 3; // the driver widens the range mid-episode

        expect(run(state, t, 4000, { range: getRange, gap })).toEqual([
          flagged(3, OpponentPenaltyFlag.Repair, "ahead", 3, { trigger: "entered-range", gapSeconds: 2.5 }),
        ]);
        // Live: read again on every pass that had something pending, never cached.
        expect(getRange).toHaveBeenCalledTimes(3);
      });

      it("announces a flagged car closing into range as entered-range; no hysteresis, and the episode latch stops a repeat", () => {
        const t = makeField();
        run(state, t, 1000);
        t.CarIdxSessionFlags[3] = Flags.Repair;

        expect(run(state, t, 2000, { gap: gapsByCar({ 3: 4 }) })).toEqual([]);
        expect(run(state, t, 3000, { gap: gapsByCar({ 3: 2.9 }) })).toEqual([
          flagged(3, OpponentPenaltyFlag.Repair, "ahead", 3, { trigger: "entered-range", gapSeconds: 2.9 }),
        ]);
        // Out of range and back in again, same episode — silent.
        expect(run(state, t, 4000, { gap: gapsByCar({ 3: 3.1 }) })).toEqual([]);
        expect(run(state, t, 5000, { gap: gapsByCar({ 3: 2.9 }) })).toEqual([]);
      });

      it("never qualifies on an unreadable (null) race gap", () => {
        const t = makeField();
        run(state, t, 1000);
        t.CarIdxSessionFlags[3] = Flags.Repair;
        t.CarIdxSessionFlags[4] = Flags.Repair;

        expect(run(state, t, 2000, { gap: () => null })).toEqual([]);
        expect(run(state, t, 3000, { gap: () => null })).toEqual([]);
        // Readable again: the still-flagged cars announce then.
        expect(run(state, t, 4000)).toEqual([
          flagged(3, OpponentPenaltyFlag.Repair, "ahead", 3, { trigger: "entered-range" }),
          flagged(4, OpponentPenaltyFlag.Repair, "behind", 5, { trigger: "entered-range" }),
        ]);
      });

      it("sanitizes the resolver's range — a non-finite value falls back to the default rather than qualifying everything", () => {
        const t = makeField();
        run(state, t, 1000);
        t.CarIdxSessionFlags[3] = Flags.Repair;

        expect(run(state, t, 2000, { range: Number.NaN, gap: () => 9 })).toEqual([]);
      });
    });
  });

  describe("the hold", () => {
    it("announces Black only after it has been continuously up for 3 s", () => {
      const t = makeField();
      run(state, t, 1000);
      t.CarIdxSessionFlags[3] = Flags.Black;

      expect(run(state, t, 2000)).toEqual([]); // rises — the hold starts at 2000
      expect(run(state, t, 2000 + OPPONENT_FLAG_BLACK_HOLD_MS - 1)).toEqual([]);
      expect(run(state, t, 2000 + OPPONENT_FLAG_BLACK_HOLD_MS)).toEqual([
        flagged(3, OpponentPenaltyFlag.Black, "ahead", 3),
      ]);
    });

    it("announces nothing for a Black that drops inside its hold, and a re-raise starts the hold over", () => {
      const t = makeField();
      run(state, t, 1000);
      t.CarIdxSessionFlags[3] = Flags.Black;
      run(state, t, 2000);
      t.CarIdxSessionFlags[3] = 0;

      expect(run(state, t, 4000)).toEqual([]);
      expect(run(state, t, 6000)).toEqual([]);

      t.CarIdxSessionFlags[3] = Flags.Black;
      expect(run(state, t, 7000)).toEqual([]);
      expect(run(state, t, 9999)).toEqual([]);
      expect(run(state, t, 10_000)).toEqual([flagged(3, OpponentPenaltyFlag.Black, "ahead", 3)]);
    });

    it("keeps Furled's 1 s debounce, announcing at exactly the boundary", () => {
      const t = makeField();
      run(state, t, 1000);
      t.CarIdxSessionFlags[3] = Flags.Furled;

      expect(run(state, t, 2000)).toEqual([]);
      expect(run(state, t, 2000 + OPPONENT_FLAG_FURLED_DEBOUNCE_MS - 1)).toEqual([]);
      expect(run(state, t, 2000 + OPPONENT_FLAG_FURLED_DEBOUNCE_MS)).toEqual([
        flagged(3, OpponentPenaltyFlag.Furled, "ahead", 3),
      ]);
    });

    it("never announces a Furled flicker that clears before the debounce elapses", () => {
      const t = makeField();
      run(state, t, 1000);
      t.CarIdxSessionFlags[3] = Flags.Furled;
      run(state, t, 2000);
      t.CarIdxSessionFlags[3] = 0;

      expect(run(state, t, 2500)).toEqual([]);
      expect(run(state, t, 3600)).toEqual([]);
    });

    it.each([
      { flag: OpponentPenaltyFlag.Black, bit: Flags.Black, hold: OPPONENT_FLAG_BLACK_HOLD_MS },
      { flag: OpponentPenaltyFlag.Furled, bit: Flags.Furled, hold: OPPONENT_FLAG_FURLED_DEBOUNCE_MS },
    ])(
      "a $flag already up on the seed tick announces as entered-range once its hold clears, never as raised",
      ({ flag, bit, hold }) => {
        const t = makeField();
        t.CarIdxSessionFlags[3] = bit; // up before the plugin ever saw the car

        expect(run(state, t, 1000)).toEqual([]); // the seed tick
        expect(run(state, t, 1000 + hold - 1)).toEqual([]);
        expect(run(state, t, 1000 + hold)).toEqual([flagged(3, flag, "ahead", 3, { trigger: "entered-range" })]);
      },
    );

    it("a held flag that drops and rises again after the seed tick reads raised", () => {
      const t = makeField();
      t.CarIdxSessionFlags[3] = Flags.Black;
      run(state, t, 1000); // seeded up
      t.CarIdxSessionFlags[3] = 0;
      run(state, t, 2000);
      t.CarIdxSessionFlags[3] = Flags.Black;
      run(state, t, 3000);

      expect(run(state, t, 3000 + OPPONENT_FLAG_BLACK_HOLD_MS)).toEqual([
        flagged(3, OpponentPenaltyFlag.Black, "ahead", 3),
      ]);
    });

    it("Repair and Disqualify are immediate", () => {
      const t = makeField();
      run(state, t, 1000);
      t.CarIdxSessionFlags[3] = Flags.Repair;
      t.CarIdxSessionFlags[4] = Flags.Disqualify;

      expect(run(state, t, 1010)).toEqual([
        flagged(3, OpponentPenaltyFlag.Repair, "ahead", 3),
        flagged(4, OpponentPenaltyFlag.Disqualify, "behind", 5),
      ]);
    });

    it("escalation Furled → Black: the swap announces nothing until Black's own hold, then a plain Black", () => {
      const t = makeField();
      run(state, t, 1000);
      t.CarIdxSessionFlags[3] = Flags.Furled;
      run(state, t, 2000);

      expect(run(state, t, 3000)).toEqual([flagged(3, OpponentPenaltyFlag.Furled, "ahead", 3)]);

      // iRacing swaps the bits in one transition.
      t.CarIdxSessionFlags[3] = Flags.Black;

      expect(run(state, t, 4000)).toEqual([]);
      expect(run(state, t, 6999)).toEqual([]);
      expect(run(state, t, 7000)).toEqual([flagged(3, OpponentPenaltyFlag.Black, "ahead", 3)]);
      // The Furled episode ended with its bit; Black stands alone in the latch.
      expect(state.opponentFlagAnnouncedMask[3]).toBe(Flags.Black);

      // Furled rises again later (its episode and cooldown both long reset):
      // a fresh episode, announced after its own debounce.
      t.CarIdxSessionFlags[3] = Flags.Furled;
      expect(run(state, t, 40_000)).toEqual([]);
      expect(run(state, t, 41_000)).toEqual([flagged(3, OpponentPenaltyFlag.Furled, "ahead", 3)]);
    });
  });

  describe("episodes, cooldowns and gates", () => {
    it("stays silent across a qualification exit and re-entry while the same flag episode continues", () => {
      const t = makeField();
      run(state, t, 1000);
      t.CarIdxSessionFlags[3] = Flags.Repair;

      expect(run(state, t, 2000)).toEqual([flagged(3, OpponentPenaltyFlag.Repair, "ahead", 3)]);

      const shifted = [4, 1, 2, 8, 5, 6, 7, 3]; // carIdx 3 now P8 — outside the positions

      expect(run(state, t, 3000, { positions: shifted })).toEqual([]);
      expect(run(state, t, 4000)).toEqual([]); // back in, same episode — silent
    });

    it("announces as entered-range once the car's position shifts into the window (level trigger)", () => {
      const t = makeField(10);
      const initial = [6, 2, 1, 3, 4, 5, 7, 8, 9, 10]; // carIdx 2 = P1, delta 5

      run(state, t, 1000, { positions: initial });
      t.CarIdxSessionFlags[2] = Flags.Repair;

      expect(run(state, t, 2000, { positions: initial })).toEqual([]);

      const shifted = [6, 2, 5, 3, 4, 1, 7, 8, 9, 10]; // carIdx 2 now P5, delta 1

      expect(run(state, t, 3000, { positions: shifted })).toEqual([
        flagged(2, OpponentPenaltyFlag.Repair, "ahead", 5, { trigger: "entered-range" }),
      ]);
    });

    it("does not suppress an escalation via the first flag's cooldown, but does suppress a same-flag re-raise within it", () => {
      const t = makeField();
      run(state, t, 1000);
      t.CarIdxSessionFlags[3] = Flags.Repair;

      expect(run(state, t, 2000)).toEqual([flagged(3, OpponentPenaltyFlag.Repair, "ahead", 3)]);

      // DQ rises on the same car — a different flag, its own cooldown.
      t.CarIdxSessionFlags[3] = Flags.Repair | Flags.Disqualify;
      expect(run(state, t, 5000)).toEqual([flagged(3, OpponentPenaltyFlag.Disqualify, "ahead", 3)]);

      // The meatball clears then re-raises well inside its own 30 s cooldown — suppressed.
      t.CarIdxSessionFlags[3] = Flags.Disqualify;
      run(state, t, 10_000);
      t.CarIdxSessionFlags[3] = Flags.Repair | Flags.Disqualify;
      expect(run(state, t, 15_000)).toEqual([]);
    });

    it("suppresses the whole announce pass under every gate, replaying as entered-range once the gate opens", () => {
      const gateOptions: RunOptions[] = [
        { isRace: false },
        { replay: true },
        { preGreen: true },
        { postRace: true },
        { player: -1 },
      ];

      for (const gateOpt of gateOptions) {
        const s = createInitialState();
        const t = makeField();
        run(s, t, 1000);
        t.CarIdxSessionFlags[3] = Flags.Repair;

        expect(run(s, t, 2000, gateOpt)).toEqual([]); // rise absorbed under the gate
        expect(run(s, t, 3000)).toEqual([
          flagged(3, OpponentPenaltyFlag.Repair, "ahead", 3, { trigger: "entered-range" }),
        ]);
      }
    });

    it("excludes the pace car and the player's own car", () => {
      const t = makeField();
      run(state, t, 1000, { pace: 3 });
      t.CarIdxSessionFlags[3] = Flags.Repair; // the pace car, positioned directly ahead
      t.CarIdxSessionFlags[PLAYER] = Flags.Repair;

      expect(run(state, t, 2000, { pace: 3 })).toEqual([]);
    });

    it("skips a car with negative lap-completed/lap-dist-pct telemetry (not in world)", () => {
      const t = makeField();
      run(state, t, 1000);
      t.CarIdxSessionFlags[3] = Flags.Repair;
      t.CarIdxLapCompleted[3] = -1;
      t.CarIdxLapDistPct[3] = -1;

      expect(run(state, t, 2000)).toEqual([]);
    });
  });

  describe("the payload", () => {
    it("names the car by its session-info number as a string, leading zero kept", () => {
      const t = makeField();
      const sessionInfo = { DriverInfo: { Drivers: [{ CarIdx: 3, CarNumber: "09" }] } };

      run(state, t, 1000, { sessionInfo });
      t.CarIdxSessionFlags[3] = Flags.Repair;

      expect(run(state, t, 2000, { sessionInfo })).toEqual([
        flagged(3, OpponentPenaltyFlag.Repair, "ahead", 3, { carNumber: "09" }),
      ]);
    });

    it("omits carNumber when the session info has no row for the car, keeping the race gap", () => {
      const t = makeField();
      run(state, t, 1000, { sessionInfo: null });
      t.CarIdxSessionFlags[3] = Flags.Repair;

      const events = run(state, t, 2000, { sessionInfo: null, gap: () => 0.8 });

      expect(events).toHaveLength(1);
      expect(events[0]!.data).not.toHaveProperty("carNumber");
      expect(events[0]!.data).toMatchObject({ relation: "ahead", carIdx: 3, gapSeconds: 0.8, position: 3 });
    });
  });

  // Burst aggregation (the #622 `diffOpponentPit` shape): 3+ eligible
  // announces within a rolling 12s window collapse to a single "others" tail.
  describe("burst aggregation (issue #936)", () => {
    it("collapses the 3rd eligible announce within the window to one 'others' aggregate; a 4th stays silent", () => {
      const t = makeField();
      run(state, t, 1000);

      t.CarIdxSessionFlags[3] = Flags.Repair; // P3, ahead delta 1
      expect(run(state, t, 2000)).toEqual([flagged(3, OpponentPenaltyFlag.Repair, "ahead", 3)]);

      t.CarIdxSessionFlags[2] = Flags.Repair; // P2, ahead delta 2
      expect(run(state, t, 3000)).toEqual([flagged(2, OpponentPenaltyFlag.Repair, "ahead", 2)]);

      // Third eligible announce inside the window reaches the threshold —
      // collapses to the aggregate tail instead of carIdx 1's individual line.
      t.CarIdxSessionFlags[1] = Flags.Repair; // P1, ahead delta 3
      expect(run(state, t, 4000)).toEqual([OTHERS]);
      expect(state.opponentFlagAggregateAnnounced).toBe(true);
      // Cooldown/latch are still stamped for the collapsed car even though
      // its individual line never went out.
      expect(state.opponentFlagAnnouncedMask[1]! & Flags.Repair).toBe(Flags.Repair);
      expect(state.opponentFlagCooldownUntil.repair[1]).toBe(4000 + 30_000);

      // A 4th eligible announce (a different car) inside the same episode is silent.
      t.CarIdxSessionFlags[4] = Flags.Repair; // P5, behind delta 1
      expect(run(state, t, 5000)).toEqual([]);
    });

    it("collapses three simultaneous announces in one tick the same way (carIdx ascending)", () => {
      const t = makeField();
      run(state, t, 1000);
      t.CarIdxSessionFlags[3] = Flags.Repair;
      t.CarIdxSessionFlags[2] = Flags.Repair;
      t.CarIdxSessionFlags[1] = Flags.Repair;

      expect(run(state, t, 2000)).toEqual([
        flagged(1, OpponentPenaltyFlag.Repair, "ahead", 1),
        flagged(2, OpponentPenaltyFlag.Repair, "ahead", 2),
        OTHERS,
      ]);
    });

    it("holds the collapse via the episode flag, not the live window count — pruning below threshold mid-episode must not resume enumeration", () => {
      const t = makeField();
      run(state, t, 1000);

      t.CarIdxSessionFlags[3] = Flags.Repair;
      run(state, t, 2000); // individual — window=[2000]
      t.CarIdxSessionFlags[2] = Flags.Repair;
      run(state, t, 3000); // individual — window=[2000,3000]
      t.CarIdxSessionFlags[1] = Flags.Repair;
      expect(run(state, t, 4000)).toEqual([OTHERS]); // window=[2000,3000,4000]

      // 11.5s after the last push: 2000 and 3000 fall outside the 12s window
      // (pruned below the threshold count) but the episode flag stays set.
      t.CarIdxSessionFlags[4] = Flags.Repair; // P5, behind — a fresh eligible car
      expect(run(state, t, 15_500)).toEqual([]);
      expect(state.opponentFlagRecentEntries.length).toBeLessThan(3);
      expect(state.opponentFlagAggregateAnnounced).toBe(true);
    });

    it("resumes individual announces once the window has been quiet for the full 12s", () => {
      const t = makeField();
      run(state, t, 1000);

      t.CarIdxSessionFlags[3] = Flags.Repair;
      run(state, t, 2000);
      t.CarIdxSessionFlags[2] = Flags.Repair;
      run(state, t, 3000);
      t.CarIdxSessionFlags[1] = Flags.Repair;
      expect(run(state, t, 4000)).toEqual([OTHERS]);

      t.CarIdxSessionFlags[4] = Flags.Repair; // P5, behind
      expect(run(state, t, 16_001)).toEqual([flagged(4, OpponentPenaltyFlag.Repair, "behind", 5)]);
      expect(state.opponentFlagAggregateAnnounced).toBe(false);
    });

    it("counts DISTINCT cars, not per-(car, flag) announces — one multi-flagged car never trips the 'several cars' collapse", () => {
      const t = makeField();
      run(state, t, 1000);

      t.CarIdxSessionFlags[3] = Flags.Repair;
      expect(run(state, t, 2000)).toHaveLength(1);
      t.CarIdxSessionFlags[3] = Flags.Repair | Flags.Disqualify;
      expect(run(state, t, 3000)).toEqual([flagged(3, OpponentPenaltyFlag.Disqualify, "ahead", 3)]);
      t.CarIdxSessionFlags[3] = Flags.Repair | Flags.Disqualify | Flags.Black;
      run(state, t, 4000); // Black's hold starts
      expect(run(state, t, 4000 + OPPONENT_FLAG_BLACK_HOLD_MS)).toEqual([
        flagged(3, OpponentPenaltyFlag.Black, "ahead", 3),
      ]);

      expect(state.opponentFlagRecentEntries).toHaveLength(1);
      expect(state.opponentFlagAggregateAnnounced).toBe(false);
    });

    it("lets an escalation through individually even while the burst episode is collapsed (the docs' promise)", () => {
      const t = makeField();
      run(state, t, 1000);

      t.CarIdxSessionFlags[3] = Flags.Repair;
      run(state, t, 2000);
      t.CarIdxSessionFlags[2] = Flags.Repair;
      run(state, t, 3000);
      t.CarIdxSessionFlags[1] = Flags.Repair;
      expect(run(state, t, 4000)).toEqual([OTHERS]);

      // Mid-collapse, the first announced car's meatball escalates to a DQ.
      t.CarIdxSessionFlags[3] = Flags.Repair | Flags.Disqualify;
      expect(run(state, t, 5000)).toEqual([flagged(3, OpponentPenaltyFlag.Disqualify, "ahead", 3)]);
    });

    it("never looks up the race gap for a car whose every pending flag is opted out, logging it as opted-out", () => {
      const logger = createMockLogger();
      const t = makeField();
      const gap = vi.fn<GapResolver>(() => 9); // would be over range, if anyone asked
      const enabled = (flag: OpponentPenaltyFlag) => flag !== OpponentPenaltyFlag.Repair;

      run(state, t, 1000, { enabled, gap, logger });
      t.CarIdxSessionFlags[3] = Flags.Repair;

      expect(run(state, t, 2000, { enabled, gap, logger })).toEqual([]);
      expect(gap).not.toHaveBeenCalled();
      expect(logger.debug.mock.calls[0]![0]).toContain("reason=opted-out");

      // An enabled flag on the same car still costs the lookup.
      t.CarIdxSessionFlags[3] = Flags.Repair | Flags.Disqualify;
      run(state, t, 3000, { enabled, gap, logger });
      expect(gap).toHaveBeenCalledTimes(1);
    });

    it("never lets a disabled subject consume the aggregation budget or stamp state (opt-outs enforced diff-side)", () => {
      const t = makeField();
      const enabled = (flag: OpponentPenaltyFlag) => flag !== OpponentPenaltyFlag.Repair;

      run(state, t, 1000, { enabled });

      t.CarIdxSessionFlags[3] = Flags.Repair;
      t.CarIdxSessionFlags[2] = Flags.Repair;
      expect(run(state, t, 2000, { enabled })).toEqual([]);
      expect(state.opponentFlagRecentEntries).toHaveLength(0);
      expect(state.opponentFlagAnnouncedMask[3]).toBe(0);
      expect(state.opponentFlagCooldownUntil.repair[3] ?? 0).toBe(0);

      // The enabled DQ on a third car is only the FIRST window entry.
      t.CarIdxSessionFlags[4] = Flags.Disqualify;
      expect(run(state, t, 3000, { enabled })).toEqual([flagged(4, OpponentPenaltyFlag.Disqualify, "behind", 5)]);
      expect(state.opponentFlagRecentEntries).toHaveLength(1);
    });
  });

  describe("debug logging (issue #1273)", () => {
    it("writes one debug line per announce carrying every field, and nothing at info", () => {
      const logger = createMockLogger();
      const t = makeField();
      t.CarIdxTrackSurface = Array<number>(8).fill(TrkLoc.OnTrack);
      t.CarIdxTrackSurface[3] = TrkLoc.OffTrack;

      run(state, t, 1000, { logger });
      t.CarIdxSessionFlags[3] = Flags.Repair | 0x40000; // + Servicible, a non-penalty bit

      run(state, t, 2000, { logger, gap: () => 1.234 });

      expect(logger.debug).toHaveBeenCalledTimes(1);
      const line = logger.debug.mock.calls[0]![0] as string;

      expect(line).toContain("Opponent flag announced");
      expect(line).toContain("carIdx=3");
      expect(line).toContain("carNumber=13");
      expect(line).toContain(`flag=${OpponentPenaltyFlag.Repair}`);
      expect(line).toContain("relation=ahead");
      expect(line).toContain("trigger=raised");
      expect(line).toContain(`sessionFlags=0x${(Flags.Repair | 0x40000).toString(16)}`);
      expect(line).toContain("classPos=3");
      expect(line).toContain("playerClassPos=4");
      expect(line).toContain("raceGap=1.23s");
      expect(line).toContain(`surface=${TrkLoc.OffTrack}`);
      expect(logger.info).not.toHaveBeenCalled();
    });

    it("writes the held-back line once per (car, flag) episode, never per tick, and again for a new episode", () => {
      const logger = createMockLogger();
      const t = makeField();
      const far = gapsByCar({ 3: 5 });

      run(state, t, 1000, { logger, gap: far });
      t.CarIdxSessionFlags[3] = Flags.Repair;

      for (let now = 2000; now <= 6000; now += 1000) run(state, t, now, { logger, gap: far });

      expect(logger.debug).toHaveBeenCalledTimes(1);
      const heldBack = logger.debug.mock.calls[0]![0] as string;

      expect(heldBack).toContain("Opponent flag held back");
      expect(heldBack).toContain("reason=gap-over-range");
      expect(heldBack).toContain("carIdx=3");
      expect(heldBack).toContain("carNumber=13");
      expect(heldBack).toContain("raceGap=5.00s");
      expect(heldBack).toContain("range=3s");

      // The first reason is the one logged: a different reason later in the
      // same episode writes nothing more.
      for (let now = 7000; now <= 9000; now += 1000) run(state, t, now, { logger, gap: () => null });

      expect(logger.debug).toHaveBeenCalledTimes(1);

      // The bit drops and rises again: a new episode, a new held-back line.
      t.CarIdxSessionFlags[3] = 0;
      run(state, t, 10_000, { logger, gap: far });
      t.CarIdxSessionFlags[3] = Flags.Repair;
      run(state, t, 11_000, { logger, gap: far });
      run(state, t, 12_000, { logger, gap: far });
      expect(logger.debug).toHaveBeenCalledTimes(2);

      // Closing into range, the held-back car still writes its announce line.
      run(state, t, 13_000, { logger });
      expect(logger.debug).toHaveBeenCalledTimes(3);
      expect(logger.debug.mock.calls[2]![0]).toContain("Opponent flag announced");
      expect(logger.info).not.toHaveBeenCalled();
    });

    it("names the reason for each kind of hold-back", () => {
      const logger = createMockLogger();
      const t = makeField(10);
      t.CarIdxClass = [100, 100, 100, 100, 100, 100, 200, 100, 100, 100];
      const positions = [5, 1, 2, 3, 4, 6, 7, 8, 9, 10]; // overall; player P5
      const enabled = (flag: OpponentPenaltyFlag) => flag !== OpponentPenaltyFlag.Disqualify;

      run(state, t, 1000, { logger, multi: true, positions, enabled });
      t.CarIdxSessionFlags[6] = Flags.Repair; // class 200 — different class
      t.CarIdxSessionFlags[1] = Flags.Repair; // class-P1, four ahead — outside positions
      t.CarIdxSessionFlags[4] = Flags.Disqualify; // class-P4, one ahead — opted out
      t.CarIdxSessionFlags[5] = Flags.Repair; // class-P6, one behind — gap unreadable
      t.CarIdxSessionFlags[9] = Flags.Repair; // not in world
      t.CarIdxLapCompleted[9] = -1;

      run(state, t, 2000, { logger, multi: true, positions, enabled, gap: gapsByCar({ 5: null }) });

      const lines = logger.debug.mock.calls.map((c) => c[0] as string);

      expect(lines).toHaveLength(5);
      expect(lines.find((l) => l.includes("carIdx=6 "))).toContain("reason=different-class");
      expect(lines.find((l) => l.includes("carIdx=1 "))).toContain("reason=outside-positions");
      expect(lines.find((l) => l.includes("carIdx=4 "))).toContain("reason=opted-out");
      expect(lines.find((l) => l.includes("carIdx=5 "))).toContain("reason=gap-unreadable");
      expect(lines.find((l) => l.includes("carIdx=9 "))).toContain("reason=not-in-world");
      expect(logger.info).not.toHaveBeenCalled();
    });

    it("logs an unreadable player lap progress as player-progress-unreadable, not as a different lap", () => {
      const logger = createMockLogger();
      const t = makeField();

      run(state, t, 1000, { logger });
      t.CarIdxSessionFlags[3] = Flags.Repair;
      t.CarIdxLapDistPct[PLAYER] = -1;

      expect(run(state, t, 2000, { logger })).toEqual([]);
      expect(logger.debug.mock.calls[0]![0]).toContain("reason=player-progress-unreadable");

      const lapDown = createInitialState();
      const other = makeField();

      run(lapDown, other, 1000, { logger });
      other.CarIdxSessionFlags[3] = Flags.Repair;
      other.CarIdxLapCompleted[3] = 9;
      run(lapDown, other, 2000, { logger });

      expect(logger.debug.mock.calls[1]![0]).toContain("reason=different-lap");
    });

    it("logs a cooldown and a silenced collapse as held back, and the announce that trips the aggregate as the aggregate", () => {
      const logger = createMockLogger();
      const t = makeField();
      run(state, t, 1000, { logger });

      t.CarIdxSessionFlags[3] = Flags.Repair;
      run(state, t, 2000, { logger });
      t.CarIdxSessionFlags[3] = 0;
      run(state, t, 3000, { logger });
      t.CarIdxSessionFlags[3] = Flags.Repair; // re-raised inside its cooldown
      run(state, t, 4000, { logger });

      t.CarIdxSessionFlags[2] = Flags.Repair;
      t.CarIdxSessionFlags[1] = Flags.Repair; // car1 announces; car2 is the third distinct car — collapses
      run(state, t, 5000, { logger });

      t.CarIdxSessionFlags[4] = Flags.Repair; // a fourth car while the aggregate episode is open — silenced
      run(state, t, 6000, { logger });

      const lines = logger.debug.mock.calls.map((c) => c[0] as string);

      expect(lines.find((l) => l.includes("held back") && l.includes("carIdx=3 "))).toContain("reason=cooldown");
      // The tripping announce produced the aggregate line, so it says so —
      // naming the car — rather than reading as held back.
      expect(lines.some((l) => l.includes("held back") && l.includes("carIdx=2 "))).toBe(false);
      const aggregate = lines.filter((l) => l.includes("aggregate announced"));

      expect(aggregate).toHaveLength(1);
      expect(aggregate[0]).toContain("cars=3");
      expect(aggregate[0]).toContain("carIdx=2 ");
      expect(aggregate[0]).toContain(`flag=${OpponentPenaltyFlag.Repair}`);
      expect(lines.find((l) => l.includes("held back") && l.includes("carIdx=4 "))).toContain("reason=collapsed");
      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});

describe("sanitizeOpponentFlagRangeSeconds (issue #1274)", () => {
  it("passes a value inside the slider range through, coercing a numeric string", () => {
    expect(sanitizeOpponentFlagRangeSeconds(3)).toBe(3);
    expect(sanitizeOpponentFlagRangeSeconds(7)).toBe(7);
    expect(sanitizeOpponentFlagRangeSeconds("5")).toBe(5);
    expect(sanitizeOpponentFlagRangeSeconds(2.5)).toBe(2.5);
  });

  it("clamps to 1–10", () => {
    expect(sanitizeOpponentFlagRangeSeconds(0)).toBe(1);
    expect(sanitizeOpponentFlagRangeSeconds(-4)).toBe(1);
    expect(sanitizeOpponentFlagRangeSeconds(11)).toBe(10);
    expect(sanitizeOpponentFlagRangeSeconds("99")).toBe(10);
  });

  it("falls back to the 3 s default on anything unparseable, a cleared field included", () => {
    expect(OPPONENT_FLAG_DEFAULT_RANGE_SECONDS).toBe(3);
    expect(sanitizeOpponentFlagRangeSeconds(undefined)).toBe(3);
    expect(sanitizeOpponentFlagRangeSeconds(null)).toBe(3);
    expect(sanitizeOpponentFlagRangeSeconds("")).toBe(3);
    expect(sanitizeOpponentFlagRangeSeconds("junk")).toBe(3);
    expect(sanitizeOpponentFlagRangeSeconds(Number.NaN)).toBe(3);
    expect(sanitizeOpponentFlagRangeSeconds(Number.POSITIVE_INFINITY)).toBe(3);
    expect(sanitizeOpponentFlagRangeSeconds({})).toBe(3);
  });
});
