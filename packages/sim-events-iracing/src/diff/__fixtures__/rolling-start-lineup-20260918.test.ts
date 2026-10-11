import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type SnapshotTick = {
  t: number;
  SessionFlags: number;
  SessionState: number;
  PaceMode: number;
  CarIdxPaceLine: number[];
  CarIdxPaceRow: number[];
  CarIdxLapCompleted: number[];
  CarIdxLapDistPct: number[];
  CarIdxTrackSurface: number[];
};

type Fixture = {
  sessionInfo: { QualifyResultsInfo: { Results: Array<{ Position: number; CarIdx: number }> } };
  ticks: SnapshotTick[];
};

const read = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf-8")) as Fixture;

const { sessionInfo, ticks } = read("rolling-start-lineup-20260918.json");
const otherGrid = read("rolling-start-lineup-20260917.json");

/** The pace car is RAW car index 64, kept as slot 20 (README). */
const PACE = 20;

/** The qualifying order as car indices, pole first. */
const qualifyingOrder = (fixture: Fixture): number[] =>
  [...fixture.sessionInfo.QualifyResultsInfo.Results].sort((a, b) => a.Position - b.Position).map((r) => r.CarIdx);

describe("the 2026-09-18 formation snapshots fixture", () => {
  it("is two moments of one formation, 30.8 s apart, both in ParadeLaps with the pace car on the road without a row", () => {
    expect(ticks.map((tick) => tick.t)).toEqual([80.1, 110.92]);

    for (const tick of ticks) {
      expect(tick.SessionState).toBe(3); // ParadeLaps
      expect(tick.SessionFlags >>> 0).toBe(0x20040200); // OneLapToGreen | Servicible | StartReady
      expect(tick.PaceMode).toBe(1); // DoubleFileStart
      expect([tick.CarIdxPaceLine[PACE], tick.CarIdxPaceRow[PACE]]).toEqual([-1, -1]);
      expect(tick.CarIdxTrackSurface[PACE]).toBe(3); // OnTrack
    }
  });

  it("holds the same lineup at both moments while the field moves 43% of a lap", () => {
    const [early, late] = ticks;

    expect(late.CarIdxPaceLine).toEqual(early.CarIdxPaceLine);
    expect(late.CarIdxPaceRow).toEqual(early.CarIdxPaceRow);
    expect(late.CarIdxLapDistPct[0] - early.CarIdxLapDistPct[0]).toBeCloseTo(0.43, 2);
  });

  it("has every car in the world, and nobody across the line yet", () => {
    for (const tick of ticks) {
      expect(tick.CarIdxLapDistPct.every((pct) => pct >= 0)).toBe(true);
      expect(tick.CarIdxTrackSurface.every((surface) => surface === 3)).toBe(true);
      expect(tick.CarIdxLapCompleted.every((lap) => lap === -1)).toBe(true);
    }
  });

  it("is a second grid: a different pole and a different order from the 2026-09-17 formation", () => {
    expect(qualifyingOrder({ sessionInfo, ticks })).toHaveLength(20);
    expect(qualifyingOrder({ sessionInfo, ticks })[0]).toBe(11);
    expect(qualifyingOrder(otherGrid)[0]).toBe(17);
    expect(qualifyingOrder({ sessionInfo, ticks })).not.toEqual(qualifyingOrder(otherGrid));
  });
});
