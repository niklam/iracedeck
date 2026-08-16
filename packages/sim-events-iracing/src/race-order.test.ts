/**
 * Unit tests for the canonical race order's source selection (issue #974).
 *
 * Fixtures are lifted from real pre-green captures in `local/` (gitignored, so
 * the numbers are inlined here):
 *
 *   - `telemetry-snapshot-20260624-214144-183.json` — a 21-car AI race on a
 *     ROLLING start, mid parade lap (`SessionState = 3`). Two grid leaders
 *     (carIdx 6 = pole, carIdx 5 = P2) have already crossed start/finish to
 *     complete the pace lap, so they alone carry `CarIdxLapCompleted = 0` while
 *     the other 19 cars are still on -1. Crucially their lap distances put them
 *     in the WRONG order relative to the grid, which is what makes this the
 *     decisive fixture.
 *   - `telemetry-snapshot-20260809-183545-140.json` — a 30-car STANDING grid
 *     (`SessionState = 1`), nobody with a lap completed, pole at carIdx 23.
 *
 * Both show `CarIdxPosition` all-zero, so the qualifying grid is the only order
 * that exists before the green.
 */
import { SessionState, TrkLoc } from "@iracedeck/iracing-native";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { calculateCanonicalRacePositions } from "./race-order.js";
import { createInitialState } from "./state.js";

/** Grid entries as `[carIdx, …]` in finishing order — index becomes the 0-indexed `Position`. */
function grid(carIdxByGridSlot: number[]): Record<string, unknown> {
  return {
    QualifyResultsInfo: {
      Results: carIdxByGridSlot.map((CarIdx, Position) => ({ CarIdx, Position })),
    },
  };
}

function mkTel(
  sessionState: SessionState,
  lapCompleted: number[],
  lapDistPct: number[],
  trackSurface?: number[],
): TelemetryData {
  return {
    SessionState: sessionState,
    CarIdxLapCompleted: lapCompleted,
    CarIdxLapDistPct: lapDistPct,
    CarIdxTrackSurface: trackSurface ?? lapDistPct.map((d) => (d < 0 ? TrkLoc.NotInWorld : TrkLoc.OnTrack)),
  } as unknown as TelemetryData;
}

/** The rolling parade-lap capture, trimmed to the first eight cars plus the player at carIdx 0. */
const PARADE_GRID = grid([6, 5, 14, 3, 9, 2, 8, 10, 0]);

/**
 * Mid parade lap: carIdx 6 and 5 have crossed S/F (lc 0), everyone else is still
 * approaching it (lc -1, dp ~0.9). Note carIdx 5 is FURTHER past the line than
 * carIdx 6, so a lap-progress ranking puts the P2 starter ahead of the pole
 * sitter — the double-file offset the issue documents.
 */
function paradeLapTelemetry(): TelemetryData {
  const lc = [-1, -1, -1, -1, -1, 0, 0, -1, -1, -1, -1, -1, -1, -1, -1];
  const dp = [0.91, 0.92, 0.93, 0.94, 0.95, 0.0033, 0.0007, 0.96, 0.97, 0.98, 0.9, 0.89, 0.88, 0.87, 0.86];

  return mkTel(SessionState.ParadeLaps, lc, dp);
}

describe("calculateCanonicalRacePositions", () => {
  it("holds the qualifying grid order through the parade lap", () => {
    const order = calculateCanonicalRacePositions(createInitialState(), paradeLapTelemetry(), PARADE_GRID, true);

    expect(order[6]).toBe(1);
    expect(order[5]).toBe(2);
    expect(order[14]).toBe(3);
    expect(order[3]).toBe(4);
  });

  it("does not let the two cars already past start/finish invert the front row", () => {
    // The lap-progress order would rank carIdx 5 P1 and carIdx 6 P2 — the grid
    // says the opposite, and the grid is right until the green flies.
    const live = calculateCanonicalRacePositions(createInitialState(), paradeLapTelemetry(), null, true);

    expect(live[5]).toBe(1);
    expect(live[6]).toBe(2);

    const gridOrder = calculateCanonicalRacePositions(createInitialState(), paradeLapTelemetry(), PARADE_GRID, true);

    expect(gridOrder[5]).toBe(2);
    expect(gridOrder[6]).toBe(1);
  });

  it("ranks a grid car that is not in the world yet", () => {
    // The player sits in the garage on the grid (dp -1, NotInWorld) but still
    // starts from their qualifying slot — 9th of the trimmed nine-car grid.
    const tel = paradeLapTelemetry();
    (tel.CarIdxLapDistPct as number[])[0] = -1;
    (tel.CarIdxTrackSurface as number[])[0] = TrkLoc.NotInWorld;

    const order = calculateCanonicalRacePositions(createInitialState(), tel, PARADE_GRID, true);

    expect(order[0]).toBe(9);
  });

  it("leaves a car with no grid entry unranked", () => {
    // The pace car never appears in QualifyResultsInfo, so it cannot occupy a
    // slot in the pre-green order the way it does in the live one.
    const order = calculateCanonicalRacePositions(createInitialState(), paradeLapTelemetry(), PARADE_GRID, true);

    expect(order[11]).toBe(0);
    expect(order[12]).toBe(0);
  });

  it("holds the grid order on a standing grid before anyone has moved", () => {
    // 30-car standing start: nobody has a lap, so the live order ranks nobody.
    const lc = new Array<number>(30).fill(-1);
    const dp = new Array<number>(30).fill(-1);
    const standingGrid = grid([23, 21, 11, 18, 2, 25, 6, 7, 16, 26]);
    const order = calculateCanonicalRacePositions(
      createInitialState(),
      mkTel(SessionState.GetInCar, lc, dp),
      standingGrid,
      true,
    );

    expect(order[23]).toBe(1);
    expect(order[21]).toBe(2);
    expect(order[26]).toBe(10);
  });

  it("switches to the live running order once the green flies", () => {
    const racing = mkTel(
      SessionState.Racing,
      [1, 1, 1, 1, 1, 1, 1, 1, 1],
      [0.5, 0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9],
    );
    const order = calculateCanonicalRacePositions(createInitialState(), racing, PARADE_GRID, true);

    expect(order[8]).toBe(1); // furthest round the lap
    expect(order[1]).toBe(9); // least far
  });

  it("keeps the live order in non-race sessions even before the green", () => {
    // A stale grid from an earlier qualifying session must not leak into a
    // practice / qualifying display.
    const order = calculateCanonicalRacePositions(createInitialState(), paradeLapTelemetry(), PARADE_GRID, false);

    expect(order[5]).toBe(1);
    expect(order[6]).toBe(2);
  });

  it("falls back to the live order when the grid cannot be resolved", () => {
    const noGrid = { QualifyResultsInfo: { Results: [] } };
    const order = calculateCanonicalRacePositions(createInitialState(), paradeLapTelemetry(), noGrid, true);

    expect(order[5]).toBe(1);
    expect(order[6]).toBe(2);
  });

  it("falls back to the live order when there is no session info at all", () => {
    const order = calculateCanonicalRacePositions(createInitialState(), paradeLapTelemetry(), null, true);

    expect(order[5]).toBe(1);
  });
});
