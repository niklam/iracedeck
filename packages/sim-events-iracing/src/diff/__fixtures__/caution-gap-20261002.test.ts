import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type FixtureTick = {
  snapshot: string;
  t: number;
  SessionFlags: number;
  SessionState: number;
  PaceMode: number;
  Speed: number;
  OnPitRoad: boolean;
  CarDistAhead: number;
  CarIdxPaceLine: number[];
  CarIdxPaceRow: number[];
  CarIdxPaceFlags: number[];
  CarIdxLapCompleted: number[];
  CarIdxLapDistPct: number[];
  CarIdxTrackSurface: number[];
};

const ticks = JSON.parse(
  readFileSync(new URL("./caution-gap-20261002.json", import.meta.url), "utf-8"),
) as FixtureTick[];

/** The player is index 0 in this session; the pace car — raw index 64 — is slot 20. */
const PLAYER = 0;
const PACE = 20;

describe("the 2026-10-02 caution-gap snapshots fixture", () => {
  it("is four ticks of ONE caution, 27.5 s from first to last", () => {
    expect(ticks.map((tick) => tick.snapshot)).toEqual([
      "20261002-214148",
      "20261002-214154",
      "20261002-214207",
      "20261002-214216",
    ]);
    expect(ticks.map((tick) => tick.t)).toEqual([273.68, 279.58, 292.65, 301.2]);
    expect(ticks.every((tick) => tick.SessionState === 4)).toBe(true); // Racing
  });

  it("runs static single file, then one to go double file", () => {
    expect(ticks.map((tick) => [tick.SessionFlags >>> 0, tick.PaceMode])).toEqual([
      [0x10044000, 2], // Caution | Servicible | StartHidden — SingleFileRestart
      [0x10044000, 2],
      [0x10044200, 3], // + OneLapToGreen — DoubleFileRestart
      [0x10044200, 3],
    ]);
  });

  it("has all 20 cars lined up behind a pace car that holds line 0 row 0, everyone on the track, no pace flag set", () => {
    for (const tick of ticks) {
      expect([tick.CarIdxPaceLine[PACE], tick.CarIdxPaceRow[PACE]], tick.snapshot).toEqual([0, 0]);
      expect(
        tick.CarIdxPaceRow.slice(0, 20).every((row) => row >= 0),
        tick.snapshot,
      ).toBe(true);
      expect(
        tick.CarIdxTrackSurface.every((surface) => surface === 3),
        tick.snapshot,
      ).toBe(true); // OnTrack
      expect(
        tick.CarIdxLapDistPct.every((pct) => pct >= 0),
        tick.snapshot,
      ).toBe(true);
      expect(
        tick.CarIdxPaceFlags.every((flags) => flags <= 0),
        tick.snapshot,
      ).toBe(true);
      expect(tick.OnPitRoad, tick.snapshot).toBe(false);
    }
  });

  it("has the player last in the single file, then at line 1 row 9 — the re-form moved him across", () => {
    expect(ticks.map((tick) => [tick.CarIdxPaceLine[PLAYER], tick.CarIdxPaceRow[PLAYER]])).toEqual([
      [0, 20],
      [0, 20],
      [1, 9],
      [1, 9],
    ]);
  });
});
