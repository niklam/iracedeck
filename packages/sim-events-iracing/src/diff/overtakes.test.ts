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
import { updatePositionTracking } from "./race-finish.js";
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
  function mkTel(lapDistPct: number[], opts: { lapCompleted?: number[]; classPos?: number } = {}): TelemetryData {
    const n = lapDistPct.length;

    return {
      OnPitRoad: false,
      SessionFlags: 0,
      CarIdxLapCompleted: opts.lapCompleted ?? new Array(n).fill(5),
      CarIdxLapDistPct: lapDistPct,
      PlayerCarClassPosition: opts.classPos ?? 0,
    } as unknown as TelemetryData;
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

  it("flags fromRetirement when a non-finished car ahead leaves the world", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed: player P3. `updatePositionTracking` seeds the per-car anchors so
    // the next tick can detect the freeze (mirrors the translator's order).
    const seedTel = mkTel([0.5, 0.6, 0.7]);

    updatePositionTracking(state, seedTel);
    diffOvertakes(state, seedTel, PLAYER_IDX, true, null, TRACK_LENGTH_M, 0, emit);

    // idx1 (ahead) goes NotInWorld → updatePositionTracking freezes it →
    // diffOvertakes sees a frozen car ahead → fromRetirement.
    const vanishTel = mkTel([0.5, -1, 0.7]);

    updatePositionTracking(state, vanishTel);
    diffOvertakes(state, vanishTel, PLAYER_IDX, true, null, TRACK_LENGTH_M, 100, emit);
    expect(state.pendingOvertakeFromRetirement).toBe(true);

    updatePositionTracking(state, vanishTel);
    diffOvertakes(state, vanishTel, PLAYER_IDX, true, null, TRACK_LENGTH_M, 100 + OVERTAKE_HOLD_MS, emit);

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.event).toBe("overtake.completed");
    expect((fires[0]!.data as { fromRetirement?: boolean }).fromRetirement).toBe(true);
  });

  it("does not flag fromRetirement for a genuine on-track pass", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed: player P3.
    diffOvertakes(state, mkTel([0.5, 0.6, 0.7]), PLAYER_IDX, true, null, TRACK_LENGTH_M, 0, emit);

    // Player passes idx1 on track — idx1 stays active, now behind the player.
    diffOvertakes(state, mkTel([0.65, 0.6, 0.7]), PLAYER_IDX, true, null, TRACK_LENGTH_M, 100, emit);
    expect(state.pendingOvertakeFromRetirement).toBe(false);

    diffOvertakes(state, mkTel([0.65, 0.6, 0.7]), PLAYER_IDX, true, null, TRACK_LENGTH_M, 100 + OVERTAKE_HOLD_MS, emit);

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect((fires[0]!.data as { fromRetirement?: boolean }).fromRetirement).toBeUndefined();
  });

  it("latches fromRetirement for a blended on-track pass then a retirement ahead within the hold window", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed: player P4 (idx1 just ahead, idx2/idx3 further up).
    const seedTel = mkTel([0.5, 0.55, 0.7, 0.8]);

    updatePositionTracking(state, seedTel);
    diffOvertakes(state, seedTel, PLAYER_IDX, true, null, TRACK_LENGTH_M, 0, emit);

    // t1: genuine pass of idx1 → P3 (idx1 still active, now behind). Not retirement.
    const passTel = mkTel([0.6, 0.55, 0.7, 0.8]);

    updatePositionTracking(state, passTel);
    diffOvertakes(state, passTel, PLAYER_IDX, true, null, TRACK_LENGTH_M, 100, emit);
    expect(state.pendingOvertakeFromRetirement).toBe(false);

    // t2 (within hold): idx2 (still ahead) retires → P2. Latches retirement.
    const retireTel = mkTel([0.6, 0.55, -1, 0.8]);

    updatePositionTracking(state, retireTel);
    diffOvertakes(state, retireTel, PLAYER_IDX, true, null, TRACK_LENGTH_M, 200, emit);
    expect(state.pendingOvertakeFromRetirement).toBe(true);

    // t3: hold elapsed → confirm with the latched flag.
    updatePositionTracking(state, retireTel);
    diffOvertakes(state, retireTel, PLAYER_IDX, true, null, TRACK_LENGTH_M, 100 + OVERTAKE_HOLD_MS, emit);

    const fires = overtakeEvents(events);
    expect(fires).toHaveLength(1);
    expect((fires[0]!.data as { fromRetirement?: boolean }).fromRetirement).toBe(true);
  });

  it("emits nothing when a car leaves the world behind the player", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed: player P3 — idx1/idx2 ahead, idx3 behind.
    diffOvertakes(state, mkTel([0.5, 0.6, 0.7, 0.4]), PLAYER_IDX, true, null, TRACK_LENGTH_M, 0, emit);

    // idx3 (behind) leaves — the player's rank is unchanged, no callout.
    diffOvertakes(state, mkTel([0.5, 0.6, 0.7, -1]), PLAYER_IDX, true, null, TRACK_LENGTH_M, 100, emit);
    diffOvertakes(
      state,
      mkTel([0.5, 0.6, 0.7, -1]),
      PLAYER_IDX,
      true,
      null,
      TRACK_LENGTH_M,
      100 + OVERTAKE_HOLD_MS,
      emit,
    );

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
