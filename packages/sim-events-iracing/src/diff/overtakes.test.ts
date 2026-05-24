/**
 * Unit tests for the overtake diff (issue #574 — extended payload + loss
 * direction).
 *
 * Pins:
 *   - First-tick seeding (both gain and loss baselines silent)
 *   - Gain held for OVERTAKE_HOLD_MS with sufficient gap → fires once with
 *     position / previousPosition / gapBehindMeters / isLeader / class fields
 *   - Gain held but gap < OVERTAKE_MIN_GAP_M → pending retained, no emit
 *   - Loss held for OVERTAKE_HOLD_MS with sufficient gap → `overtake.lost`
 *   - Loss held but gap < OVERTAKE_MIN_GAP_M → pending retained, no emit
 *   - Caution suppresses both directions, baseline rolled silently
 *   - Pit road resets state, no emissions
 *   - Sim-glitch jump > OVERTAKE_MAX_JUMP suppressed both directions
 *   - Non-race session never emits
 *   - Leader detection (`isLeader: true` when position === 1)
 *   - Multi-class `classPosition` / `previousClassPosition` fields
 *   - Track-length missing → emission proceeds (gap field omitted)
 */
import { Flags, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffOvertakes, OVERTAKE_HOLD_MS, OVERTAKE_MAX_JUMP } from "./overtakes.js";
import type { PendingEvent } from "./types.js";

const TRACK_LENGTH_M = 1000;
const PLAYER_IDX = 0;

/**
 * Build a 10-car telemetry tick. Cars are laid out around the track via
 * `CarIdxLapDistPct`; the player sits at `playerPct` and the surrounding
 * field is dropped onto specific percentages so `calculateRacePositions`
 * returns a known order. `playerPosition = N` means exactly `N - 1` cars are
 * placed ahead of the player (higher lap-distance pct) and the rest behind.
 */
function tick(
  opts: {
    playerPct?: number;
    playerPosition?: number;
    /** Pct of the car immediately behind the player (for gain-side gap). */
    carBehindPct?: number;
    /** Pct of the car immediately ahead of the player (for loss-side gap). */
    carAheadPct?: number;
    onPitRoad?: boolean;
    sessionFlags?: number;
    playerClassPosition?: number;
  } = {},
): TelemetryData {
  const playerPct = opts.playerPct ?? 0.5;
  const playerPosition = opts.playerPosition ?? 5;
  const carCount = 10;
  const lapCompleted: number[] = new Array(carCount).fill(5);
  const lapDistPct: number[] = new Array(carCount).fill(-1);

  lapDistPct[PLAYER_IDX] = playerPct;

  // Cars ahead: higher lap-distance pct than player. Default spacing of
  // 0.05 unless the immediately-behind / immediately-ahead pct overrides
  // the closest neighbour.
  const carsAhead = playerPosition - 1;

  for (let i = 0; i < carsAhead; i++) {
    const idx = i + 1;

    if (i === 0 && opts.carAheadPct !== undefined) {
      lapDistPct[idx] = opts.carAheadPct;
    } else {
      lapDistPct[idx] = playerPct + 0.05 * (i + 1);
    }
  }

  const carsBehind = carCount - 1 - carsAhead;

  for (let i = 0; i < carsBehind; i++) {
    const idx = carsAhead + 1 + i;

    if (i === 0 && opts.carBehindPct !== undefined) {
      lapDistPct[idx] = opts.carBehindPct;
    } else {
      lapDistPct[idx] = playerPct - 0.05 * (i + 1);
    }
  }

  // Clamp to valid pct range [0, 1) — calculateRacePositions treats negative
  // as inactive; the fallback (-0.5) for a small field is already negative
  // and signals inactivity.
  for (let i = 0; i < carCount; i++) {
    if (lapDistPct[i]! >= 1) lapDistPct[i] = lapDistPct[i]! - 1;
  }

  return {
    OnPitRoad: opts.onPitRoad ?? false,
    SessionFlags: opts.sessionFlags ?? 0,
    CarIdxLapCompleted: lapCompleted,
    CarIdxLapDistPct: lapDistPct,
    PlayerCarClassPosition: opts.playerClassPosition ?? 0,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

function overtakeEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "overtake.completed" || e.event === "overtake.lost");
}

/**
 * Seed the diff by running the first tick (always silent) and the second
 * tick at the same position so the diff is "warmed up" but no pending state
 * exists. Returns the state for the caller to keep mutating.
 */
function seedAt(playerPosition: number, classPosition = 0): { state: TranslatorState; baseTime: number } {
  const state = createInitialState();
  const { emit } = collect();
  diffOvertakes(
    state,
    tick({ playerPosition, playerClassPosition: classPosition }),
    PLAYER_IDX,
    true,
    null,
    TRACK_LENGTH_M,
    0,
    emit,
  );

  return { state, baseTime: 0 };
}

describe("diffOvertakes — first-tick seeding", () => {
  it("seeds silently for both gain and loss tracking", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffOvertakes(state, tick({ playerPosition: 5 }), PLAYER_IDX, true, null, TRACK_LENGTH_M, 0, emit);

    expect(overtakeEvents(events)).toHaveLength(0);
    expect(state.overtakeInitialized).toBe(true);
    expect(state.lastPosition).toBe(5);
    expect(state.pendingOvertakePos).toBe(-1);
    expect(state.pendingLossPos).toBe(-1);
  });
});

describe("diffOvertakes — gain direction", () => {
  it("emits overtake.completed with full payload after the hold window with sufficient gap", () => {
    const { state } = seedAt(5);
    const { events, emit } = collect();

    // Tick 2: position improves to P4. Pending opens.
    diffOvertakes(state, tick({ playerPosition: 4 }), PLAYER_IDX, true, null, TRACK_LENGTH_M, 100, emit);
    expect(overtakeEvents(events)).toHaveLength(0);
    expect(state.pendingOvertakePos).toBe(4);

    // Tick 3: hold satisfied + 50m gap to car behind (>10m gate).
    // Player at 0.5, car behind at 0.45 → 0.05 * 1000 = 50m.
    diffOvertakes(
      state,
      tick({ playerPosition: 4, carBehindPct: 0.45 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.event).toBe("overtake.completed");
    expect(fires[0]!.data).toMatchObject({
      carIdx: PLAYER_IDX,
      position: 4,
      previousPosition: 5,
      isLeader: false,
      gapBehindMeters: expect.closeTo(50, 1),
    });
    expect(state.pendingOvertakePos).toBe(-1);
  });

  it("postpones emission when the gap is below the physical-gap gate", () => {
    const { state } = seedAt(5);
    const { events, emit } = collect();

    diffOvertakes(state, tick({ playerPosition: 4 }), PLAYER_IDX, true, null, TRACK_LENGTH_M, 100, emit);
    // Tick at hold time but only 5m gap — too tight.
    diffOvertakes(
      state,
      tick({ playerPosition: 4, carBehindPct: 0.495 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );
    expect(overtakeEvents(events)).toHaveLength(0);
    expect(state.pendingOvertakePos).toBe(4);

    // Gap opens up next tick → fires.
    diffOvertakes(
      state,
      tick({ playerPosition: 4, carBehindPct: 0.4 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS + 500,
      emit,
    );
    expect(overtakeEvents(events)).toHaveLength(1);
    expect(overtakeEvents(events)[0]!.data).toMatchObject({
      gapBehindMeters: expect.closeTo(100, 1),
    });
  });

  it("emits without gap field when track length isn't known", () => {
    const { state } = seedAt(5);
    const { events, emit } = collect();

    diffOvertakes(state, tick({ playerPosition: 4 }), PLAYER_IDX, true, null, null, 100, emit);
    diffOvertakes(
      state,
      tick({ playerPosition: 4, carBehindPct: 0.495 }),
      PLAYER_IDX,
      true,
      null,
      null, // track length missing — gap is unknown, gate doesn't suppress
      100 + OVERTAKE_HOLD_MS,
      emit,
    );

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.data).not.toHaveProperty("gapBehindMeters");
  });

  it("sets isLeader: true when the gain takes the player to P1", () => {
    const { state } = seedAt(2);
    const { events, emit } = collect();

    diffOvertakes(state, tick({ playerPosition: 1 }), PLAYER_IDX, true, null, TRACK_LENGTH_M, 100, emit);
    diffOvertakes(
      state,
      tick({ playerPosition: 1, carBehindPct: 0.4 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.data).toMatchObject({ position: 1, previousPosition: 2, isLeader: true });
  });

  it("ignores sim-glitch jumps larger than OVERTAKE_MAX_JUMP", () => {
    const { state } = seedAt(10);
    const { events, emit } = collect();

    // Jump from P10 → P1 (9 positions) — teleport / tow.
    diffOvertakes(
      state,
      tick({ playerPosition: 10 - OVERTAKE_MAX_JUMP - 1 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100,
      emit,
    );
    expect(state.pendingOvertakePos).toBe(-1);

    diffOvertakes(
      state,
      tick({ playerPosition: 10 - OVERTAKE_MAX_JUMP - 1 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );
    expect(overtakeEvents(events)).toHaveLength(0);
  });

  it("carries class position fields when multi-class", () => {
    const { state } = seedAt(5, 3);
    const { events, emit } = collect();

    diffOvertakes(
      state,
      tick({ playerPosition: 4, playerClassPosition: 2 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100,
      emit,
    );
    diffOvertakes(
      state,
      tick({ playerPosition: 4, playerClassPosition: 2, carBehindPct: 0.4 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.data).toMatchObject({
      position: 4,
      previousPosition: 5,
      classPosition: 2,
      previousClassPosition: 3,
      isMultiClass: true,
    });
  });
});

describe("diffOvertakes — loss direction", () => {
  it("emits overtake.lost with full payload after hold + sufficient gap", () => {
    const { state } = seedAt(4);
    const { events, emit } = collect();

    diffOvertakes(state, tick({ playerPosition: 5 }), PLAYER_IDX, true, null, TRACK_LENGTH_M, 100, emit);
    expect(state.pendingLossPos).toBe(5);
    expect(state.pendingLossPrevPos).toBe(4);

    // 50 m gap to car ahead.
    diffOvertakes(
      state,
      tick({ playerPosition: 5, carAheadPct: 0.55 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.event).toBe("overtake.lost");
    expect(fires[0]!.data).toMatchObject({
      carIdx: PLAYER_IDX,
      position: 5,
      previousPosition: 4,
      gapAheadMeters: expect.closeTo(50, 1),
    });
    expect(state.pendingLossPos).toBe(-1);
  });

  it("postpones emission when the gap ahead is below the gate", () => {
    const { state } = seedAt(4);
    const { events, emit } = collect();

    diffOvertakes(state, tick({ playerPosition: 5 }), PLAYER_IDX, true, null, TRACK_LENGTH_M, 100, emit);
    // 5 m gap to car ahead — too close.
    diffOvertakes(
      state,
      tick({ playerPosition: 5, carAheadPct: 0.505 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );
    expect(overtakeEvents(events)).toHaveLength(0);
    expect(state.pendingLossPos).toBe(5);

    diffOvertakes(
      state,
      tick({ playerPosition: 5, carAheadPct: 0.6 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS + 500,
      emit,
    );
    expect(overtakeEvents(events)).toHaveLength(1);
  });

  it("drops pending loss when player wins the position back", () => {
    const { state } = seedAt(4);
    const { events, emit } = collect();

    diffOvertakes(state, tick({ playerPosition: 5 }), PLAYER_IDX, true, null, TRACK_LENGTH_M, 100, emit);
    diffOvertakes(state, tick({ playerPosition: 4 }), PLAYER_IDX, true, null, TRACK_LENGTH_M, 1500, emit);
    expect(state.pendingLossPos).toBe(-1);

    diffOvertakes(
      state,
      tick({ playerPosition: 4 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS + 1000,
      emit,
    );
    expect(overtakeEvents(events)).toHaveLength(0);
  });

  it("ignores sim-glitch loss jumps larger than OVERTAKE_MAX_JUMP", () => {
    const { state } = seedAt(2);
    const { events, emit } = collect();

    diffOvertakes(
      state,
      tick({ playerPosition: 2 + OVERTAKE_MAX_JUMP + 1 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100,
      emit,
    );
    expect(state.pendingLossPos).toBe(-1);

    diffOvertakes(
      state,
      tick({ playerPosition: 2 + OVERTAKE_MAX_JUMP + 1 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );
    expect(overtakeEvents(events)).toHaveLength(0);
  });
});

describe("diffOvertakes — suppression rules", () => {
  it("never emits outside race sessions", () => {
    const { state } = seedAt(5);
    const { events, emit } = collect();

    diffOvertakes(state, tick({ playerPosition: 4 }), PLAYER_IDX, false, null, TRACK_LENGTH_M, 100, emit);
    diffOvertakes(
      state,
      tick({ playerPosition: 4, carBehindPct: 0.4 }),
      PLAYER_IDX,
      false,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );
    expect(overtakeEvents(events)).toHaveLength(0);
    // State should have reset
    expect(state.overtakeInitialized).toBe(false);
  });

  it("resets state on pit road and never emits while in pit", () => {
    const { state } = seedAt(5);
    const { events, emit } = collect();

    diffOvertakes(
      state,
      tick({ playerPosition: 4, onPitRoad: true }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100,
      emit,
    );
    expect(state.overtakeInitialized).toBe(false);
    expect(overtakeEvents(events)).toHaveLength(0);
  });

  it("suppresses both directions under caution and rolls the baseline silently", () => {
    const { state } = seedAt(5);
    const { events, emit } = collect();

    diffOvertakes(
      state,
      tick({ playerPosition: 4, sessionFlags: Flags.Yellow }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100,
      emit,
    );
    expect(state.lastPosition).toBe(4); // baseline rolled forward
    expect(state.pendingOvertakePos).toBe(-1);
    expect(state.pendingLossPos).toBe(-1);

    diffOvertakes(
      state,
      tick({ playerPosition: 4 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );
    expect(overtakeEvents(events)).toHaveLength(0);
  });
});

describe("diffOvertakes — multi-class detection (#588)", () => {
  it("stays silent when overall position churns but class position holds", () => {
    // Class-leader (P1) whose OVERALL rank shuffles as other-class cars pass /
    // pit / lap — the exact scenario that spammed "we're currently P1".
    const { state } = seedAt(5, 1);
    const { events, emit } = collect();

    let t = 100;

    for (const overall of [4, 6, 5, 7, 5, 4]) {
      diffOvertakes(
        state,
        tick({ playerPosition: overall, playerClassPosition: 1 }),
        PLAYER_IDX,
        true,
        true, // multi-class
        TRACK_LENGTH_M,
        t,
        emit,
      );
      t += OVERTAKE_HOLD_MS; // give any (incorrectly) opened pending time to fire
    }

    expect(overtakeEvents(events)).toHaveLength(0);
  });

  it("fires overtake.lost on a class-position drop even when overall is unchanged", () => {
    const { state } = seedAt(5, 2); // overall P5, class P2
    const { events, emit } = collect();

    // Class slips P2 → P3; overall holds P5.
    diffOvertakes(
      state,
      tick({ playerPosition: 5, playerClassPosition: 3 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100,
      emit,
    );
    expect(overtakeEvents(events)).toHaveLength(0);
    expect(state.pendingLossPos).toBe(3);

    diffOvertakes(
      state,
      tick({ playerPosition: 5, playerClassPosition: 3 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.event).toBe("overtake.lost");
    expect(fires[0]!.data).toMatchObject({
      position: 5, // overall, unchanged
      classPosition: 3,
      previousClassPosition: 2,
      isMultiClass: true,
    });
    // The physical-gap gate is skipped in multi-class.
    expect(fires[0]!.data).not.toHaveProperty("gapAheadMeters");
  });

  it("fires overtake.completed on a class-position gain even when overall is unchanged", () => {
    const { state } = seedAt(5, 3); // overall P5, class P3
    const { events, emit } = collect();

    diffOvertakes(
      state,
      tick({ playerPosition: 5, playerClassPosition: 2 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100,
      emit,
    );
    diffOvertakes(
      state,
      tick({ playerPosition: 5, playerClassPosition: 2 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.event).toBe("overtake.completed");
    expect(fires[0]!.data).toMatchObject({
      position: 5,
      classPosition: 2,
      previousClassPosition: 3,
      isLeader: false,
      isMultiClass: true,
    });
  });

  it("keeps isLeader on OVERALL position — class P1 while overall P5 is not the race leader", () => {
    const { state } = seedAt(5, 2);
    const { events, emit } = collect();

    diffOvertakes(
      state,
      tick({ playerPosition: 5, playerClassPosition: 1 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100,
      emit,
    );
    diffOvertakes(
      state,
      tick({ playerPosition: 5, playerClassPosition: 1 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.data).toMatchObject({ classPosition: 1, isLeader: false });
  });
});
