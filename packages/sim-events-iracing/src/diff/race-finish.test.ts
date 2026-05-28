/**
 * Unit tests for the self-managed running order (issue #603).
 *
 * One rule replaces the old per-symptom patches (checkered finished-freeze,
 * tow `-isTowed`, blink churn): each car has a last-known on-track score; a
 * car is FROZEN at that score whenever its telemetry is `NotInWorld` or has
 * drifted discontinuously from the anchor; otherwise it tracks live `lc + dp`.
 * The player only passes a frozen car when their own score genuinely exceeds
 * the frozen point — "…until we've passed that point".
 */
import { calculateRacePositions, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { calculateFrozenRacePositions, TELEPORT_THRESHOLD, updatePositionTracking } from "./race-finish.js";

/** Build a telemetry tick from raw per-car arrays. */
function mkTel(lapDistPct: number[], opts: { lapCompleted?: number[]; trackSurface?: number[] } = {}): TelemetryData {
  const n = lapDistPct.length;

  return {
    CarIdxLapCompleted: opts.lapCompleted ?? new Array(n).fill(5),
    CarIdxLapDistPct: lapDistPct,
    CarIdxTrackSurface: opts.trackSurface ?? new Array(n).fill(TrkLoc.OnTrack),
  } as unknown as TelemetryData;
}

describe("updatePositionTracking", () => {
  it("seeds an anchor on a car's first in-world sighting", () => {
    const state = createInitialState();

    updatePositionTracking(state, mkTel([0.5, 0.6, 0.7]));

    expect(state.positionLastKnownScores[0]).toBeCloseTo(5.5, 5);
    expect(state.positionLastKnownScores[1]).toBeCloseTo(5.6, 5);
    expect(state.positionLastKnownScores[2]).toBeCloseTo(5.7, 5);
    expect(state.positionFrozen.size).toBe(0);
  });

  it("rolls the anchor forward on continuous on-track motion", () => {
    const state = createInitialState();

    updatePositionTracking(state, mkTel([0.5]));
    updatePositionTracking(state, mkTel([0.51]));
    updatePositionTracking(state, mkTel([0.52]));

    expect(state.positionLastKnownScores[0]).toBeCloseTo(5.52, 5);
    expect(state.positionFrozen.has(0)).toBe(false);
  });

  it("freezes a car at its anchor when it goes NotInWorld", () => {
    const state = createInitialState();

    updatePositionTracking(state, mkTel([0.5]));
    expect(state.positionLastKnownScores[0]).toBeCloseTo(5.5, 5);

    // iRacing snaps lc/dp/ts to -1 the moment the car is NotInWorld.
    updatePositionTracking(state, mkTel([-1], { lapCompleted: [-1], trackSurface: [TrkLoc.NotInWorld] }));

    expect(state.positionFrozen.has(0)).toBe(true);
    // Anchor is preserved across the blink — the player still ranks behind it.
    expect(state.positionLastKnownScores[0]).toBeCloseTo(5.5, 5);
  });

  it("unfreezes when the car returns close to its anchor (brief blink)", () => {
    const state = createInitialState();

    updatePositionTracking(state, mkTel([0.5]));
    updatePositionTracking(state, mkTel([-1], { lapCompleted: [-1], trackSurface: [TrkLoc.NotInWorld] }));
    expect(state.positionFrozen.has(0)).toBe(true);

    // 1-tick blink — comes back essentially where it was.
    updatePositionTracking(state, mkTel([0.501]));

    expect(state.positionFrozen.has(0)).toBe(false);
    expect(state.positionLastKnownScores[0]).toBeCloseTo(5.501, 5);
  });

  it("stays frozen when the car reappears far from its anchor (tow-during-blink)", () => {
    const state = createInitialState();

    // On track at 50% of the lap.
    updatePositionTracking(state, mkTel([0.5]));
    // Blinks out.
    updatePositionTracking(state, mkTel([-1], { lapCompleted: [-1], trackSurface: [TrkLoc.NotInWorld] }));
    // Returns in the pit stall (dp 0.05) — tow happened during the blink.
    updatePositionTracking(state, mkTel([0.05], { trackSurface: [TrkLoc.InPitStall] }));

    expect(state.positionFrozen.has(0)).toBe(true);
    // Anchor stays at the pre-tow on-track location.
    expect(state.positionLastKnownScores[0]).toBeCloseTo(5.5, 5);
  });

  it("freezes on a same-tick teleport (large in-world score jump)", () => {
    const state = createInitialState();

    updatePositionTracking(state, mkTel([0.5]));
    // Live dp teleports without going NotInWorld first.
    updatePositionTracking(state, mkTel([0.05], { trackSurface: [TrkLoc.InPitStall] }));

    expect(state.positionFrozen.has(0)).toBe(true);
    expect(state.positionLastKnownScores[0]).toBeCloseTo(5.5, 5);
  });

  it("normal S/F crossing is continuous (score delta ≈ 0)", () => {
    const state = createInitialState();

    updatePositionTracking(state, mkTel([0.998]));
    updatePositionTracking(state, mkTel([0.002], { lapCompleted: [6] }));

    expect(state.positionFrozen.has(0)).toBe(false);
    expect(state.positionLastKnownScores[0]).toBeCloseTo(6.002, 5);
  });

  it("a never-seen car that's NotInWorld stays absent from the order (no anchor)", () => {
    const state = createInitialState();

    updatePositionTracking(
      state,
      mkTel([-1, 0.5], { lapCompleted: [-1, 5], trackSurface: [TrkLoc.NotInWorld, TrkLoc.OnTrack] }),
    );

    expect(state.positionLastKnownScores[0]).toBeUndefined();
    expect(state.positionFrozen.has(0)).toBe(false);
  });
});

describe("calculateFrozenRacePositions", () => {
  it("matches the raw order when no anchors have been seeded", () => {
    const state = createInitialState();
    const tel = mkTel([0.5, 0.6, 0.7]);

    expect(calculateFrozenRacePositions(state, tel)).toEqual(calculateRacePositions(tel));
  });

  it("ranks a frozen car at its anchor instead of its live score", () => {
    const state = createInitialState();
    // Seed an anchor for car2 at lap 5, dp 0.7 (score 5.7).
    updatePositionTracking(state, mkTel([0.5, 0.6, 0.7]));
    // car2 now teleports to the pit (live dp 0.05) — frozen at anchor.
    updatePositionTracking(
      state,
      mkTel([0.5, 0.6, 0.05], { trackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.InPitStall] }),
    );

    expect(state.positionFrozen.has(2)).toBe(true);

    // Frozen car2 still ranked ahead by its anchor (5.7); player (idx0, 5.5) P3.
    const frozen = calculateFrozenRacePositions(
      state,
      mkTel([0.5, 0.6, 0.05], { trackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.InPitStall] }),
    );

    expect(frozen[2]).toBe(1);
    expect(frozen[1]).toBe(2);
    expect(frozen[0]).toBe(3);
  });

  it("does not churn the player's rank during a 1-tick NotInWorld blink of a car ahead (car8 case)", () => {
    const state = createInitialState();
    // Seed: car1 ahead of player at lc6 dp0.142 (the car8 case from the log).
    updatePositionTracking(state, mkTel([0.5, 0.142], { lapCompleted: [5, 6] }));
    const playerRankBefore = calculateFrozenRacePositions(state, mkTel([0.5, 0.142], { lapCompleted: [5, 6] }))[0];

    // car1 blinks NotInWorld for one tick.
    updatePositionTracking(
      state,
      mkTel([0.51, -1], { lapCompleted: [5, -1], trackSurface: [TrkLoc.OnTrack, TrkLoc.NotInWorld] }),
    );

    // Player's rank is unchanged — car1 is held at its anchor.
    const playerRankDuringBlink = calculateFrozenRacePositions(
      state,
      mkTel([0.51, -1], { lapCompleted: [5, -1], trackSurface: [TrkLoc.OnTrack, TrkLoc.NotInWorld] }),
    )[0];

    expect(playerRankDuringBlink).toBe(playerRankBefore);
  });

  it("keeps a finished car ahead until the player also finishes (subsumes the checkered freeze)", () => {
    const state = createInitialState();
    // Seed: leader on the lead lap, player a lap down.
    updatePositionTracking(state, mkTel([0.5, 0.95], { lapCompleted: [4, 5] }));

    // Leader crosses the line (lc5, dp~0) and drives to the garage (vanishes).
    updatePositionTracking(state, mkTel([0.51, 0.001], { lapCompleted: [4, 6] })); // crosses S/F
    updatePositionTracking(
      state,
      mkTel([0.52, -1], { lapCompleted: [4, -1], trackSurface: [TrkLoc.OnTrack, TrkLoc.NotInWorld] }),
    ); // vanishes

    expect(state.positionFrozen.has(1)).toBe(true);
    // Anchor sits at the finishing score (6.001). Player at lc4 can't exceed
    // that until they also finish, so the leader stays counted ahead.
    const frozen = calculateFrozenRacePositions(
      state,
      mkTel([0.99, -1], { lapCompleted: [4, -1], trackSurface: [TrkLoc.OnTrack, TrkLoc.NotInWorld] }),
    );

    expect(frozen[1]).toBe(1); // leader still P1
    expect(frozen[0]).toBe(2); // player still behind
  });

  it("a car towed from behind doesn't push the player back (replaces the −isTowed hack)", () => {
    const state = createInitialState();
    // Seed: player (idx0) at lc5 dp0.50, car1 BEHIND at lc5 dp0.20.
    updatePositionTracking(state, mkTel([0.5, 0.2]));
    expect(calculateFrozenRacePositions(state, mkTel([0.5, 0.2]))[0]).toBe(1); // player P1

    // car1 tows: live dp jumps to the pit stall (0.95) — looks ahead by raw score.
    updatePositionTracking(state, mkTel([0.51, 0.95], { trackSurface: [TrkLoc.OnTrack, TrkLoc.InPitStall] }));

    expect(state.positionFrozen.has(1)).toBe(true);
    // car1 is frozen at its pre-tow score (5.20) — still BEHIND the player.
    const frozen = calculateFrozenRacePositions(
      state,
      mkTel([0.51, 0.95], { trackSurface: [TrkLoc.OnTrack, TrkLoc.InPitStall] }),
    );

    expect(frozen[0]).toBe(1);
    expect(frozen[1]).toBe(2);
  });

  it("omits never-seen NotInWorld cars from the order", () => {
    const state = createInitialState();

    const result = calculateFrozenRacePositions(
      state,
      mkTel([-1, 0.5], { lapCompleted: [-1, 5], trackSurface: [TrkLoc.NotInWorld, TrkLoc.OnTrack] }),
    );

    expect(result[0]).toBe(0); // omitted
    expect(result[1]).toBe(1);
  });
});

describe("TELEPORT_THRESHOLD", () => {
  it("is large enough to allow racing motion and a natural S/F crossing", () => {
    // ~0.0003 lap/tick at racing speed; ~0.002 at S/F. Threshold is 0.05 — well
    // above both, well below any plausible tow / teleport (which jumps by
    // tenths of a lap).
    expect(TELEPORT_THRESHOLD).toBeGreaterThan(0.01);
    expect(TELEPORT_THRESHOLD).toBeLessThan(0.5);
  });
});
