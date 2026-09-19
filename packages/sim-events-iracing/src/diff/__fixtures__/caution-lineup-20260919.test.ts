import { calculateRacePositions, type TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../../state.js";
import { calculateFrozenRacePositions } from "../race-finish.js";

type FixtureTick = {
  t: number;
  SessionFlags: number;
  SessionState: number;
  PaceMode: number;
  PitsOpen: boolean;
  LapDistPct: number;
  PlayerCarPosition: number;
  CarIdxPaceLine: number[];
  CarIdxPaceRow: number[];
  CarIdxPaceFlags: number[];
  CarIdxLapCompleted: number[];
  CarIdxLapDistPct: number[];
  CarIdxTrackSurface: number[];
  CarIdxPosition: number[];
};

const ticks = JSON.parse(
  readFileSync(new URL("./caution-lineup-20260919.json", import.meta.url), "utf-8"),
) as FixtureTick[];

/** The player (car #64) is index 0 in this session; the pace car is slot 20. */
const PLAYER = 0;
const PACE = 20;

describe("the 2026-09-19 uneven-lanes snapshot fixture", () => {
  const [tick] = ticks;

  it("is one tick, at one to green under a double-file restart, with the pace car anchored at line 0 row 0", () => {
    expect(ticks).toHaveLength(1);
    expect(tick.t).toBe(832.95);
    expect(tick.SessionFlags >>> 0).toBe(0x10044200); // Caution|OneLapToGreen|Servicible|StartHidden
    expect(tick.SessionState).toBe(4); // Racing
    expect(tick.PaceMode).toBe(3); // DoubleFileRestart
    expect(tick.CarIdxPaceLine[PACE]).toBe(0);
    expect(tick.CarIdxPaceRow[PACE]).toBe(0);
  });

  it("lines the field up UNEVENLY — 11 cars on line 0 (rows 1..11), 9 on line 1 (rows 0..8)", () => {
    // The shape the closed formulas never met: a lapped car (#7, index 7) and
    // the waved-around player had gone to the tail of one lane.
    const rowsOn = (line: number): number[] =>
      tick.CarIdxPaceRow.filter((_, i) => i !== PACE && tick.CarIdxPaceLine[i] === line).sort((a, b) => a - b);

    expect(rowsOn(0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(rowsOn(1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tick.CarIdxPaceLine[PLAYER]).toBe(0);
    expect(tick.CarIdxPaceRow[PLAYER]).toBe(11);
  });

  it("is the first capture in which CarIdxPaceFlags is set — the player carries WavedAround", () => {
    expect(tick.CarIdxPaceFlags[PLAYER]).toBe(4); // irsdk_PaceFlagsWavedAround
    expect(tick.CarIdxPaceFlags.filter((f) => f !== 0)).toHaveLength(1);
  });

  it("has car #7 two laps down and lined up AHEAD of the player, one row lower on the same line", () => {
    const LAPPED = 7;

    expect(tick.CarIdxLapCompleted[LAPPED]).toBe(tick.CarIdxLapCompleted[PLAYER] - 2);
    expect(tick.CarIdxPaceLine[LAPPED]).toBe(0);
    expect(tick.CarIdxPaceRow[LAPPED]).toBe(10);
  });

  it("puts the player 19th in the race — the canonical order and iRacing's official position agree", () => {
    const telemetry = tick as unknown as TelemetryData;

    // The 20-car field spans slots 0..19, the pace car (lap −1) is excluded by
    // the calculator's own active-car rule, so the order runs 1..20.
    const canonical = calculateFrozenRacePositions(createInitialState(), telemetry);

    expect(canonical).toEqual(calculateRacePositions(telemetry));
    expect(canonical[PLAYER]).toBe(19);
    expect(canonical[7]).toBe(20); // the lapped car, ahead in the lineup, last in the race
    expect(canonical[PACE]).toBe(0);
    expect(tick.PlayerCarPosition).toBe(19);
    expect(tick.CarIdxPosition[PLAYER]).toBe(19);
  });
});
