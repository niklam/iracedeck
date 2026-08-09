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
});
