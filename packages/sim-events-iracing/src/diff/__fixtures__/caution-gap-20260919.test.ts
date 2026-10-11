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
  readFileSync(new URL("./caution-gap-20260919.json", import.meta.url), "utf-8"),
) as FixtureTick[];

/** The player (car #64) is index 0 in these sessions; the pace car — raw index 64 — is slot 20. */
const PLAYER = 0;
const PACE = 20;

describe("the 2026-09-19 caution-gap snapshots fixture", () => {
  it("is four single ticks, in capture order, each under a full-course caution while racing", () => {
    expect(ticks.map((tick) => tick.snapshot)).toEqual([
      "20260919-093300",
      "20260919-093306",
      "20260919-094029",
      "20260919-131947",
    ]);
    expect(ticks.map((tick) => tick.t)).toEqual([267.08, 273.17, 678.52, 436.65]);
    expect(ticks.every((tick) => tick.SessionState === 4)).toBe(true); // Racing
  });

  it("carries a static caution single file twice, a waving one, and a static one at one to go double file", () => {
    expect(ticks.map((tick) => [tick.SessionFlags >>> 0, tick.PaceMode])).toEqual([
      [0x10044000, 2], // Caution | Servicible | StartHidden — SingleFileRestart
      [0x10044000, 2],
      [0x10048000, 2], // CautionWaving
      [0x10044200, 3], // Caution | OneLapToGreen — DoubleFileRestart
    ]);
  });

  it("has all 20 cars lined up behind a pace car that holds line 0 row 0, everyone on the track", () => {
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
      expect(tick.OnPitRoad, tick.snapshot).toBe(false);
    }
  });

  it("puts the player at row 12 of the single file, at the tail of the waving field, and at line 1 row 9 double file", () => {
    expect(ticks.map((tick) => [tick.CarIdxPaceLine[PLAYER], tick.CarIdxPaceRow[PLAYER]])).toEqual([
      [0, 12],
      [0, 12],
      [0, 20],
      [1, 9],
    ]);
  });

  it("has the player accelerating to close in the second snapshot — 34.6 m/s against 29.5 six seconds earlier", () => {
    // Spec finding 4: why the gap is not divided by the player's own speed.
    expect(ticks[0].Speed).toBeCloseTo(29.47, 2);
    expect(ticks[1].Speed).toBeCloseTo(34.58, 2);
  });

  it("carries WavedAround on the player in the waving snapshot only", () => {
    expect(ticks.map((tick) => tick.CarIdxPaceFlags[PLAYER])).toEqual([0, 0, 4, 0]);
    expect(ticks.flatMap((tick) => tick.CarIdxPaceFlags.slice(1, 20)).every((flags) => flags === 0)).toBe(true);
  });
});
