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

type Fixture = { sessionInfo: Record<string, unknown>; ticks: SnapshotTick[] };

const read = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf-8")) as Fixture;

const snapshot = read("rolling-start-lineup-20260917.json");
const watch = read("rolling-start-formation-20260917.json");

/** The pace car is RAW car index 64, kept as slot 20 (README). */
const PACE = 20;

describe("the 2026-09-17 formation snapshot fixture", () => {
  const [tick] = snapshot.ticks;

  it("is one tick, mid-formation: ParadeLaps, double-file start, the pace car on the road without a row", () => {
    expect(snapshot.ticks).toHaveLength(1);
    expect(tick.t).toBe(177.37);
    expect(tick.SessionState).toBe(3); // ParadeLaps
    expect(tick.SessionFlags >>> 0).toBe(0x20040200); // OneLapToGreen | Servicible | StartReady
    expect(tick.PaceMode).toBe(1); // DoubleFileStart
    expect([tick.CarIdxPaceLine[PACE], tick.CarIdxPaceRow[PACE]]).toEqual([-1, -1]);
    expect(tick.CarIdxTrackSurface[PACE]).toBe(3); // OnTrack
  });

  it("is the watch's grid, car for car, though taken at an earlier start the same day", () => {
    // Spec finding 1: this is why the watch fixture — a capture with no
    // session YAML of its own — carries this snapshot's session fields.
    expect(tick.CarIdxPaceLine).toEqual(watch.ticks[0].CarIdxPaceLine);
    expect(tick.CarIdxPaceRow).toEqual(watch.ticks[0].CarIdxPaceRow);
    expect(snapshot.sessionInfo).toEqual(watch.sessionInfo);
  });

  it("has every car in the world, and nobody across the line yet", () => {
    expect(tick.CarIdxLapDistPct.every((pct) => pct >= 0)).toBe(true);
    expect(tick.CarIdxTrackSurface.every((surface) => surface === 3)).toBe(true);
    expect(tick.CarIdxLapCompleted.every((lap) => lap === -1)).toBe(true);
  });

  it("cannot have its lanes told apart by lap distance — which car of a row is further round depends on the row", () => {
    // Spec finding 7: the inside car leads its partner on rows 0–4 and trails
    // it on rows 5–9. The lane comes from the pace line, never from geometry.
    const carAt = (line: number, row: number): number =>
      tick.CarIdxPaceRow.findIndex((r, carIdx) => r === row && tick.CarIdxPaceLine[carIdx] === line);
    const insideLeads = Array.from(
      { length: 10 },
      (_, row) => tick.CarIdxLapDistPct[carAt(0, row)] > tick.CarIdxLapDistPct[carAt(1, row)],
    );

    expect(insideLeads).toEqual([true, true, true, true, true, false, false, false, false, false]);
  });
});
