import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CORNERS = ["LF", "RF", "LR", "RR"] as const;
const ZONES = ["L", "M", "R"] as const;

type Corner = (typeof CORNERS)[number];
type Zone = (typeof ZONES)[number];
type TempField = `${Corner}tempC${Zone}`;
type WearField = `${Corner}wear${Zone}`;

const TEMP_FIELDS = CORNERS.flatMap((corner) => ZONES.map((zone): TempField => `${corner}tempC${zone}`));
const WEAR_FIELDS = CORNERS.flatMap((corner) => ZONES.map((zone): WearField => `${corner}wear${zone}`));

type FixtureTick = {
  t: number;
  IsOnTrack: boolean;
  IsReplayPlaying: boolean;
  OnPitRoad: boolean;
  PlayerCarInPitStall: boolean;
  PlayerTrackSurface: number;
  PitSvFlags: number;
  PitstopActive: boolean;
  PlayerCarTowTime: number;
} & Record<TempField | WearField, number>;

const ticks = JSON.parse(
  readFileSync(new URL("./tire-temps-tow-20261011.json", import.meta.url), "utf-8"),
) as FixtureTick[];

const tempsOf = (tick: FixtureTick): string => TEMP_FIELDS.map((f) => tick[f]).join(",");
const leastTread = (tick: FixtureTick): number => Math.min(...WEAR_FIELDS.map((f) => tick[f]));

/** The ticks on which any of the twelve temperatures changed, after the first. */
const refreshes = ticks.filter((tick, i) => i > 0 && tempsOf(tick) !== tempsOf(ticks[i - 1]!));
const at = (t: number): FixtureTick => ticks.find((tick) => tick.t === t)!;
const before = (t: number): FixtureTick => ticks[ticks.indexOf(at(t)) - 1]!;

describe("the 2026-10-11 tire-temperature tow capture fixture", () => {
  it("refreshes the temperatures twice and holds them in between: the stop, then the tow", () => {
    expect(refreshes.map((tick) => tick.t)).toEqual([209.48, 295.02]);
  });

  it("starts on the circuit, never in the stall", () => {
    expect(ticks[0]).toMatchObject({ t: 87.2, IsOnTrack: false, IsReplayPlaying: true });
    expect(at(91.22)).toMatchObject({ IsOnTrack: true, PlayerTrackSurface: -1, OnPitRoad: false });
    expect(at(91.23)).toMatchObject({ PlayerTrackSurface: 3, OnPitRoad: false, PlayerCarInPitStall: false });
  });

  it("refreshes at the stop as the car arrives in its box, before PlayerCarInPitStall", () => {
    // Surface InPitStall at 209.18, refresh at 209.48, stall flag at 209.85.
    expect(at(209.18)).toMatchObject({ PlayerTrackSurface: 1, PlayerCarInPitStall: false });
    expect(at(209.48)).toMatchObject({ OnPitRoad: true, PlayerCarInPitStall: false });
    expect(at(209.85)).toMatchObject({ PlayerCarInPitStall: true });
    // Nothing queued: the stop changes no tire.
    expect(ticks.every((tick) => tick.PitSvFlags === 0)).toBe(true);
  });

  it("refreshes at the tow on the tick the car leaves the world, one tick before it stands in its box", () => {
    expect(before(295.02)).toMatchObject({ IsOnTrack: true, OnPitRoad: false, PlayerTrackSurface: 3 });
    // In the car, live, out of the world; the tow clock has not started.
    expect(at(295.02)).toMatchObject({
      IsOnTrack: true,
      IsReplayPlaying: false,
      OnPitRoad: false,
      PlayerCarInPitStall: false,
      PlayerTrackSurface: -1,
      PlayerCarTowTime: 0,
    });
    // One tick later the car reads as standing in its box, with 73 s of tow to serve.
    expect(at(295.03)).toMatchObject({ OnPitRoad: true, PlayerCarInPitStall: true, PlayerTrackSurface: 1 });
    expect(at(295.03).PlayerCarTowTime).toBeCloseTo(73.07, 2);
    expect(tempsOf(at(295.03))).toBe(tempsOf(at(295.02)));
  });

  it("shows at the tow the set that was on the car: hotter and more worn than at the stop", () => {
    expect(at(295.02).LFtempCR).toBeGreaterThan(at(209.48).LFtempCR);
    expect(leastTread(at(295.02))).toBeLessThan(leastTread(at(209.48)));
  });

  it("keeps the driver in the car and the car in its box for the whole tow, the values unchanged", () => {
    const served = ticks.filter((tick) => tick.t > 295.03);

    // The tow has run out by 368.17, where pit service starts.
    expect(served.map((tick) => tick.t)).toEqual([368.17, 368.18]);
    expect(at(368.17)).toMatchObject({ PitstopActive: true, PlayerCarTowTime: 0 });

    for (const tick of served) {
      expect(tick, String(tick.t)).toMatchObject({
        IsOnTrack: true,
        IsReplayPlaying: false,
        PlayerCarInPitStall: true,
      });
      expect(tempsOf(tick), String(tick.t)).toBe(tempsOf(at(295.02)));
    }
  });
});
