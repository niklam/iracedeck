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
import { Flags, SessionState, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffOvertakes, OVERTAKE_HOLD_MS, OVERTAKE_MAX_JUMP } from "./overtakes.js";
import { calculateFrozenRacePositions, updatePositionTracking } from "./race-finish.js";
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
    sessionState?: number;
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

  const t = {
    OnPitRoad: opts.onPitRoad ?? false,
    SessionFlags: opts.sessionFlags ?? 0,
    CarIdxLapCompleted: lapCompleted,
    CarIdxLapDistPct: lapDistPct,
    PlayerCarClassPosition: opts.playerClassPosition ?? 0,
  } as unknown as TelemetryData;

  // Only set SessionState when explicitly provided so the existing call sites
  // (which never set it) keep `preGreen` defaulting to false (issue #647).
  if (opts.sessionState !== undefined) t.SessionState = opts.sessionState;

  return t;
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

describe("diffOvertakes — pre-green gate (#647)", () => {
  it("suppresses a would-be gain during the parade lap and rolls the baseline silently", () => {
    const { state } = seedAt(5);
    const { events, emit } = collect();

    // Parade lap: position improves to P4 with a clean 50 m gap behind, held
    // well past the hold window. Without the gate this would emit a "Nice pass"
    // before the green flag.
    diffOvertakes(
      state,
      tick({ playerPosition: 4, sessionState: SessionState.ParadeLaps }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100,
      emit,
    );
    expect(state.lastPosition).toBe(4); // baseline rolled forward silently
    expect(state.pendingOvertakePos).toBe(-1);

    diffOvertakes(
      state,
      tick({ playerPosition: 4, carBehindPct: 0.4, sessionState: SessionState.ParadeLaps }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );
    expect(overtakeEvents(events)).toHaveLength(0);
  });

  it("suppresses a would-be loss during the parade lap and rolls the baseline silently", () => {
    const { state } = seedAt(4);
    const { events, emit } = collect();

    diffOvertakes(
      state,
      tick({ playerPosition: 5, sessionState: SessionState.ParadeLaps }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100,
      emit,
    );
    expect(state.lastPosition).toBe(5); // baseline rolled forward silently
    expect(state.pendingLossPos).toBe(-1);

    diffOvertakes(
      state,
      tick({ playerPosition: 5, carAheadPct: 0.55, sessionState: SessionState.ParadeLaps }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );
    expect(overtakeEvents(events)).toHaveLength(0);
  });

  it("seeds from the green-flag order at the transition, then announces a genuine post-green gain", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Pre-green ticks: the player is shuffling around the grid. All suppressed,
    // baseline rolled silently to the latest pre-green order.
    diffOvertakes(
      state,
      tick({ playerPosition: 6, sessionState: SessionState.ParadeLaps }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      0,
      emit,
    );
    diffOvertakes(
      state,
      tick({ playerPosition: 5, sessionState: SessionState.ParadeLaps }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100,
      emit,
    );
    expect(state.overtakeInitialized).toBe(false); // never seeded while pre-green
    expect(overtakeEvents(events)).toHaveLength(0);

    // Green flies: first racing tick reads P5 — this seeds the baseline (no
    // phantom emit from the pre-green shuffle) and stays silent.
    diffOvertakes(
      state,
      tick({ playerPosition: 5, sessionState: SessionState.Racing }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      200,
      emit,
    );
    expect(state.overtakeInitialized).toBe(true);
    expect(state.lastPosition).toBe(5);
    expect(overtakeEvents(events)).toHaveLength(0);

    // A NEW sustained gain AFTER green (P5 → P4) is measured from the
    // green-flag order and DOES emit.
    diffOvertakes(
      state,
      tick({ playerPosition: 4, sessionState: SessionState.Racing }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      300,
      emit,
    );
    diffOvertakes(
      state,
      tick({ playerPosition: 4, carBehindPct: 0.4, sessionState: SessionState.Racing }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      300 + OVERTAKE_HOLD_MS,
      emit,
    );
    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.event).toBe("overtake.completed");
    expect(fires[0]!.data).toMatchObject({ position: 4, previousPosition: 5 });
  });

  it("leaves behaviour unchanged when SessionState is omitted (back-compat default)", () => {
    const { state } = seedAt(5);
    const { events, emit } = collect();

    // No sessionState → preGreen is false → a sustained gain still emits.
    diffOvertakes(state, tick({ playerPosition: 4 }), PLAYER_IDX, true, null, TRACK_LENGTH_M, 100, emit);
    diffOvertakes(
      state,
      tick({ playerPosition: 4, carBehindPct: 0.4 }),
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

describe("diffOvertakes — round-trip suppression (#597)", () => {
  it("suppresses a loss that merely reverses an unannounced gain (P5 → P4 → P5)", () => {
    const { state } = seedAt(5); // lastCalledPosition seeds to P5
    const { events, emit } = collect();

    // Brief, unsustained dip to P4 — opens a pending gain but never confirms.
    diffOvertakes(state, tick({ playerPosition: 4 }), PLAYER_IDX, true, null, null, 100, emit);
    // Back to P5 within the hold window — gain given back, opens a pending loss.
    diffOvertakes(state, tick({ playerPosition: 5 }), PLAYER_IDX, true, null, null, 300, emit);
    // Hold elapses at P5 — would emit "lost P5 (prev 4)", but P5 is the last
    // announced position, so the round-trip stays silent.
    diffOvertakes(state, tick({ playerPosition: 5 }), PLAYER_IDX, true, null, null, 300 + OVERTAKE_HOLD_MS, emit);

    expect(overtakeEvents(events)).toHaveLength(0);
  });

  it("suppresses a gain that merely reverses an unannounced loss (P5 → P6 → P5)", () => {
    const { state } = seedAt(5);
    const { events, emit } = collect();

    diffOvertakes(state, tick({ playerPosition: 6 }), PLAYER_IDX, true, null, null, 100, emit);
    diffOvertakes(state, tick({ playerPosition: 5 }), PLAYER_IDX, true, null, null, 300, emit);
    diffOvertakes(state, tick({ playerPosition: 5 }), PLAYER_IDX, true, null, null, 300 + OVERTAKE_HOLD_MS, emit);

    expect(overtakeEvents(events)).toHaveLength(0);
  });

  it("still fires a sustained announced gain and a later real loss back to the start", () => {
    const { state } = seedAt(5);
    const { events, emit } = collect();

    // Gain to P4, sustained → announced (lastCalledPosition becomes 4).
    diffOvertakes(state, tick({ playerPosition: 4 }), PLAYER_IDX, true, null, null, 100, emit);
    diffOvertakes(state, tick({ playerPosition: 4 }), PLAYER_IDX, true, null, null, 100 + OVERTAKE_HOLD_MS, emit);
    let fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.event).toBe("overtake.completed");
    expect(fires[0]!.data).toMatchObject({ position: 4, previousPosition: 5 });

    // Real loss back to P5 — different from the last announced P4, so it fires.
    diffOvertakes(state, tick({ playerPosition: 5 }), PLAYER_IDX, true, null, null, 100 + OVERTAKE_HOLD_MS + 100, emit);
    diffOvertakes(
      state,
      tick({ playerPosition: 5 }),
      PLAYER_IDX,
      true,
      null,
      null,
      100 + 2 * OVERTAKE_HOLD_MS + 100,
      emit,
    );
    fires = overtakeEvents(events);
    expect(fires).toHaveLength(2);
    expect(fires[1]!.event).toBe("overtake.lost");
    expect(fires[1]!.data).toMatchObject({ position: 5, previousPosition: 4 });
  });

  it("suppresses a multi-class round-trip on CLASS position (class P3 → P2 → P3)", () => {
    // Seed multi-class directly so `lastCalledPosition` is seeded in class
    // space (the `seedAt` helper seeds single-class). Overall position holds
    // at P5 throughout; only the class position flickers.
    const state = createInitialState();
    const { events, emit } = collect();
    diffOvertakes(
      state,
      tick({ playerPosition: 5, playerClassPosition: 3 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      0,
      emit,
    );

    // Class improves to P2, then reverts to P3 before it can sustain — net no
    // class change since the seed, so neither a gain nor a loss should fire.
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
      tick({ playerPosition: 5, playerClassPosition: 3 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      300,
      emit,
    );
    diffOvertakes(
      state,
      tick({ playerPosition: 5, playerClassPosition: 3 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      300 + OVERTAKE_HOLD_MS,
      emit,
    );

    expect(overtakeEvents(events)).toHaveLength(0);
  });
});

describe("diffOvertakes — race-start grid seeding (#597 / #568)", () => {
  it("anchors the baseline to the starting grid position, not the live first tick (single-class)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // First eligible race tick: the live computed position is already P8 (start
    // shuffle), but the announced grid slot is P10. The seed must anchor to P10.
    diffOvertakes(state, tick({ playerPosition: 8 }), PLAYER_IDX, true, null, TRACK_LENGTH_M, 0, emit, 10);
    expect(state.lastPosition).toBe(10);
    expect(state.lastCalledPosition).toBe(10);
    expect(overtakeEvents(events)).toHaveLength(0);

    // Holding P8 is a real two-position gain off the grid → announced as P8 (prev 10).
    diffOvertakes(
      state,
      tick({ playerPosition: 8, carBehindPct: 0.4 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100,
      emit,
      10,
    );
    diffOvertakes(
      state,
      tick({ playerPosition: 8, carBehindPct: 0.4 }),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
      10,
    );
    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.event).toBe("overtake.completed");
    expect(fires[0]!.data).toMatchObject({ position: 8, previousPosition: 10 });
  });

  it("suppresses an early round-trip back to the starting grid position", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed at the grid slot P10 (gap left unknown via null track length so the
    // gate passes and the round-trip suppression is what's exercised).
    diffOvertakes(state, tick({ playerPosition: 10 }), PLAYER_IDX, true, null, null, 0, emit, 10);
    // P10 → P9 (unannounced) → back to P10, held → round-trip to the grid stays silent.
    diffOvertakes(state, tick({ playerPosition: 9 }), PLAYER_IDX, true, null, null, 100, emit, 10);
    diffOvertakes(state, tick({ playerPosition: 10 }), PLAYER_IDX, true, null, null, 300, emit, 10);
    diffOvertakes(state, tick({ playerPosition: 10 }), PLAYER_IDX, true, null, null, 300 + OVERTAKE_HOLD_MS, emit, 10);

    expect(overtakeEvents(events)).toHaveLength(0);
  });

  it("anchors the class baseline to the class grid slot, not the live first tick, in multi-class (#599)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Multi-class race start: the live class position reads P3 on the first
    // eligible tick (opening-lap shuffle), but the announced CLASS grid slot is
    // P5. The translator now passes the class slot in multi-class (#599), so the
    // seed anchors the CLASS baseline to it; the overall baseline keeps tracking
    // the live overall position.
    diffOvertakes(
      state,
      tick({ playerPosition: 8, playerClassPosition: 3 }),
      PLAYER_IDX,
      true,
      true, // multi-class
      TRACK_LENGTH_M,
      0,
      emit,
      5, // class grid slot
    );
    expect(state.lastClassPosition).toBe(5);
    expect(state.lastCalledPosition).toBe(5);
    expect(state.lastPosition).toBe(8);
    expect(overtakeEvents(events)).toHaveLength(0);

    // Holding class P3 is a real two-spot class gain off the grid → announced
    // as class P3 (previously class P5).
    diffOvertakes(
      state,
      tick({ playerPosition: 8, playerClassPosition: 3 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100,
      emit,
      5,
    );
    diffOvertakes(
      state,
      tick({ playerPosition: 8, playerClassPosition: 3 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
      5,
    );
    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.event).toBe("overtake.completed");
    expect(fires[0]!.data).toMatchObject({ classPosition: 3, previousClassPosition: 5, isMultiClass: true });
  });

  it("does not announce settling from the unreliable live first tick to the class grid slot in multi-class (#599)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // The first eligible tick reads class P3 (start-line shuffle), but the
    // authoritative class grid slot is P5. The baseline anchors to the grid
    // slot, so the driver running at their actual class grid slot P5 is NOT
    // announced as having "lost" two spots from the noisy first reading —
    // mirrors the single-class anchor behaviour above.
    diffOvertakes(
      state,
      tick({ playerPosition: 8, playerClassPosition: 3 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      0,
      emit,
      5,
    );
    diffOvertakes(
      state,
      tick({ playerPosition: 8, playerClassPosition: 5 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100,
      emit,
      5,
    );
    diffOvertakes(
      state,
      tick({ playerPosition: 8, playerClassPosition: 5 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
      5,
    );

    expect(overtakeEvents(events)).toHaveLength(0);
  });
});

describe("diffOvertakes — finished / retired cars (#603)", () => {
  // Direct per-car telemetry so specific cars can be made inactive (left the
  // world). Player is PLAYER_IDX (0); positions derive from CarIdxLapDistPct.
  function mkTel(
    lapDistPct: number[],
    opts: { lapCompleted?: number[]; trackSurface?: number[]; classPos?: number } = {},
  ): TelemetryData {
    const n = lapDistPct.length;

    return {
      OnPitRoad: false,
      SessionFlags: 0,
      CarIdxLapCompleted: opts.lapCompleted ?? new Array(n).fill(5),
      CarIdxLapDistPct: lapDistPct,
      CarIdxTrackSurface: opts.trackSurface ?? new Array(n).fill(TrkLoc.OnTrack),
      PlayerCarClassPosition: opts.classPos ?? 0,
    } as unknown as TelemetryData;
  }

  /**
   * Mirror the translator's per-tick wiring: update the self-managed running
   * order, compute the frozen rank vector, and pass it to {@link diffOvertakes}.
   * Exercises the production path (CodeRabbit #605 comment 3) instead of the
   * fallback `frozenPositions ?? calculateRacePositions(...)` branch.
   */
  function tickAt(state: TranslatorState, tel: TelemetryData, now: number, emit: (event: PendingEvent) => void): void {
    updatePositionTracking(state, tel);
    const frozen = calculateFrozenRacePositions(state, tel);

    diffOvertakes(state, tel, PLAYER_IDX, true, null, TRACK_LENGTH_M, now, emit, null, frozen);
  }

  /**
   * Realistic `NotInWorld` snapshot: iRacing snaps `lc`/`dp`/`ts` for that car
   * to `-1` / `NotInWorld` on the same tick — proven from the dump-file
   * analysis on issue #603. The freeze logic keys on all three so the test
   * tick has to set them in sync.
   */
  function vanishCar(lc: number[], dp: number[], ts: number[], idx: number): void {
    lc[idx] = -1;
    dp[idx] = -1;
    ts[idx] = TrkLoc.NotInWorld;
  }

  it("does not phantom-gain when a finished car ahead leaves the world (frozen positions injected)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed: player P3 (idx1, idx2 ahead).
    diffOvertakes(state, mkTel([0.5, 0.6, 0.7]), PLAYER_IDX, true, null, TRACK_LENGTH_M, 0, emit);

    // idx2 finishes and leaves. RAW positions would promote the player, but the
    // translator passes FROZEN positions that keep idx2 counted at rank 1, so
    // the player stays P3 — no gain opens.
    const frozen = [3, 2, 1];
    diffOvertakes(state, mkTel([0.5, 0.6, -1]), PLAYER_IDX, true, null, TRACK_LENGTH_M, 100, emit, null, frozen);
    diffOvertakes(
      state,
      mkTel([0.5, 0.6, -1]),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
      null,
      frozen,
    );

    expect(overtakeEvents(events)).toHaveLength(0);
    expect(state.pendingOvertakePos).toBe(-1);
  });

  // Per-tick deltas are kept well below `TELEPORT_THRESHOLD = 0.05` so the
  // self-managed running order never flags a car (least of all the PLAYER) as
  // teleported. Real telemetry runs at 60 Hz with ~0.0003 lap/tick at racing
  // speed; the values here are still tiny by comparison while staying readable.

  it("flags fromRetirement when the player crosses a vanished car's frozen anchor (production path)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed: player P3, idx1 ahead at 0.510, idx2 ahead at 0.520.
    tickAt(state, mkTel([0.5, 0.51, 0.52]), 0, emit);

    // idx1 vanishes — telemetry snaps lc/dp/ts to the NotInWorld sentinels in
    // a single tick (dump-file precedent). Player edges forward 0.002 lap so
    // its own anchor stays continuous. With idx1 frozen at score 5.51, the
    // frozen rank still has idx1 ahead — player stays P3, no pending opens.
    const lc1 = [5, 5, 5];
    const dp1 = [0.502, 0.51, 0.521];
    const ts1 = [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack];

    vanishCar(lc1, dp1, ts1, 1);
    tickAt(state, mkTel(dp1, { lapCompleted: lc1, trackSurface: ts1 }), 100, emit);
    expect(state.pendingOvertakePos).toBe(-1);
    expect(state.positionFrozen.has(1)).toBe(true);

    // Player advances PAST idx1's frozen anchor (live score 5.515 > anchor
    // 5.51) → P3 → P2. Pending opens with fromRetirement=true (idx1 ranked
    // ahead in the previous tick's frozen ordering and is currently frozen).
    const lc2 = [5, 5, 5];
    const dp2 = [0.515, 0.51, 0.522];
    const ts2 = [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack];

    vanishCar(lc2, dp2, ts2, 1);
    tickAt(state, mkTel(dp2, { lapCompleted: lc2, trackSurface: ts2 }), 200, emit);
    expect(state.pendingOvertakePos).toBe(2);
    expect(state.pendingOvertakeFromRetirement).toBe(true);

    // Hold elapsed → emit with fromRetirement=true.
    tickAt(state, mkTel(dp2, { lapCompleted: lc2, trackSurface: ts2 }), 200 + OVERTAKE_HOLD_MS, emit);

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.event).toBe("overtake.completed");
    expect((fires[0]!.data as { fromRetirement?: boolean }).fromRetirement).toBe(true);
  });

  it("flags fromRetirement when a towed rival is released and drops back (#697)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed: idx2 leads (P1, 5.80), rival idx1 ahead of the player (P2, 5.60),
    // player P3 (5.50).
    tickAt(state, mkTel([0.5, 0.6, 0.8]), 0, emit);

    // Rival idx1 is towed to the pit stall — its score jumps discontinuously, so
    // it freezes at the pre-tow anchor (5.60) and stays ranked ahead. Player P3.
    tickAt(
      state,
      mkTel([0.502, 0.05, 0.802], { trackSurface: [TrkLoc.OnTrack, TrkLoc.InPitStall, TrkLoc.OnTrack] }),
      100,
      emit,
    );
    expect(state.positionFrozen.has(1)).toBe(true);
    expect(state.pendingOvertakePos).toBe(-1);

    // Rival drives back out of the pit onto the track → released this tick (moving
    // AND off pit road), drops to its live back-of-field score, and the player
    // inherits P2. The gain must read fromRetirement (the rival fell back; the
    // player didn't pass it on track), NOT a real pass.
    tickAt(
      state,
      mkTel([0.51, 0.06, 0.81], { trackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack] }),
      200,
      emit,
    );
    expect(state.positionFrozen.has(1)).toBe(false);
    expect(state.positionJustReleased.has(1)).toBe(true);
    expect(state.pendingOvertakePos).toBe(2);
    expect(state.pendingOvertakeFromRetirement).toBe(true);

    // Hold elapsed → emits with fromRetirement=true (no "Nice pass").
    tickAt(
      state,
      mkTel([0.512, 0.06, 0.812], { trackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack] }),
      200 + OVERTAKE_HOLD_MS,
      emit,
    );

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.event).toBe("overtake.completed");
    expect((fires[0]!.data as { fromRetirement?: boolean }).fromRetirement).toBe(true);
  });

  it("does not flag fromRetirement when a released car stays ahead and the player passes a different car (#698)", () => {
    const state = createInitialState();
    const { emit } = collect();

    // Seed: idx1 leads (P1, 5.90), idx2 just ahead of the player (P2, 5.501),
    // player P3 (5.50).
    tickAt(state, mkTel([0.5, 0.9, 0.501]), 0, emit);

    // idx1 blinks out of the world for a tick → frozen at 5.90, still ranked P1.
    const lc1 = [5, 5, 5];
    const dp1 = [0.502, 0.9, 0.503];
    const ts1 = [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack];

    vanishCar(lc1, dp1, ts1, 1);
    tickAt(state, mkTel(dp1, { lapCompleted: lc1, trackSurface: ts1 }), 100, emit);
    expect(state.positionFrozen.has(1)).toBe(true);
    expect(state.pendingOvertakePos).toBe(-1);

    // idx1 returns near its anchor → released this tick but STILL ahead (P1).
    // Meanwhile the player makes a genuine on-track pass of idx2 (P3 → P2). The
    // gain came from idx2, not the released idx1, so it must NOT read
    // fromRetirement — the just-released idx1 is still ahead in the current order.
    tickAt(state, mkTel([0.508, 0.905, 0.506]), 200, emit);
    expect(state.positionJustReleased.has(1)).toBe(true);
    expect(state.pendingOvertakePos).toBe(2);
    expect(state.pendingOvertakeFromRetirement).toBe(false);
  });

  it("does not flag fromRetirement for a genuine on-track pass", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed: player P3, idx1 just ahead at 0.501, idx2 further up at 0.515.
    tickAt(state, mkTel([0.5, 0.501, 0.515]), 0, emit);

    // Player edges forward and idx1 drifts back so the post-pass gap clears
    // OVERTAKE_MIN_GAP_M (10 m on TRACK_LENGTH_M=1000). Both deltas stay
    // well below TELEPORT_THRESHOLD = 0.05 so nothing freezes.
    tickAt(state, mkTel([0.51, 0.499, 0.515]), 100, emit);
    expect(state.pendingOvertakePos).toBe(2);
    expect(state.pendingOvertakeFromRetirement).toBe(false);

    tickAt(state, mkTel([0.51, 0.499, 0.515]), 100 + OVERTAKE_HOLD_MS, emit);

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect((fires[0]!.data as { fromRetirement?: boolean }).fromRetirement).toBeUndefined();
  });

  it("latches fromRetirement for a blended on-track pass then a retirement ahead within the hold window", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed: player P4 (idx1 just ahead at 0.501, idx2/idx3 further up).
    tickAt(state, mkTel([0.5, 0.501, 0.515, 0.525]), 0, emit);

    // t1: genuine on-track pass of idx1 — player ticks forward to 0.510 while
    // idx1 drops back to 0.499, opening a >10 m gap so the confirm gate
    // passes. Player score 5.510 < idx2 5.515, so player lands at P3.
    tickAt(state, mkTel([0.51, 0.499, 0.515, 0.525]), 100, emit);
    expect(state.pendingOvertakePos).toBe(3);
    expect(state.pendingOvertakeFromRetirement).toBe(false);

    // t2 (within hold): idx2 (still ranked ahead at frozen 5.515) vanishes.
    // The player's rank doesn't move, but the latch re-evaluates each held
    // tick: idx2 ranked ahead in the PREVIOUS tick's frozen positions and is
    // now in `positionFrozen` → fromRetirement latches true.
    const lc2 = [5, 5, 5, 5];
    const dp2 = [0.511, 0.499, 0.515, 0.526];
    const ts2 = [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack];

    vanishCar(lc2, dp2, ts2, 2);
    tickAt(state, mkTel(dp2, { lapCompleted: lc2, trackSurface: ts2 }), 200, emit);
    expect(state.pendingOvertakeFromRetirement).toBe(true);

    // t3: hold elapsed → confirm with the latched flag. Gap behind to idx1 is
    // (0.511 - 0.499) × 1000 = 12 m → passes the physical-gap gate.
    tickAt(state, mkTel(dp2, { lapCompleted: lc2, trackSurface: ts2 }), 100 + OVERTAKE_HOLD_MS, emit);

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect((fires[0]!.data as { fromRetirement?: boolean }).fromRetirement).toBe(true);
  });

  it("emits nothing when a car leaves the world behind the player", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed: player P3 — idx1/idx2 ahead, idx3 behind.
    tickAt(state, mkTel([0.5, 0.51, 0.52, 0.49]), 0, emit);

    // idx3 (behind) vanishes — frozen keeps it ranked behind the player → no
    // rank change, no pending, no callout. The retirement classifier also
    // never triggers because idx3 wasn't ahead of the player last tick.
    const lc = [5, 5, 5, 5];
    const dp = [0.5, 0.51, 0.52, 0.49];
    const ts = [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack];

    vanishCar(lc, dp, ts, 3);
    tickAt(state, mkTel(dp, { lapCompleted: lc, trackSurface: ts }), 100, emit);
    tickAt(state, mkTel(dp, { lapCompleted: lc, trackSurface: ts }), 100 + OVERTAKE_HOLD_MS, emit);

    expect(overtakeEvents(events)).toHaveLength(0);
  });

  it("does not flag fromRetirement in multi-class (detection runs on class position)", () => {
    const { state } = seedAt(12, 3);
    const { events, emit } = collect();

    // Class gain P3 → P2 (overall unchanged) in a multi-class race.
    diffOvertakes(
      state,
      tick({ playerPosition: 12, playerClassPosition: 3 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      100,
      emit,
    );
    diffOvertakes(
      state,
      tick({ playerPosition: 12, playerClassPosition: 2 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      200,
      emit,
    );
    diffOvertakes(
      state,
      tick({ playerPosition: 12, playerClassPosition: 2 }),
      PLAYER_IDX,
      true,
      true,
      TRACK_LENGTH_M,
      200 + OVERTAKE_HOLD_MS,
      emit,
    );

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect((fires[0]!.data as { fromRetirement?: boolean }).fromRetirement).toBeUndefined();
  });
});
