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
} & Record<TempField | WearField, number>;

const ticks = JSON.parse(
  readFileSync(new URL("./tire-temps-stops-20261011.json", import.meta.url), "utf-8"),
) as FixtureTick[];

const tempsOf = (tick: FixtureTick): string => TEMP_FIELDS.map((f) => tick[f]).join(",");
const wearOf = (tick: FixtureTick): string => WEAR_FIELDS.map((f) => tick[f]).join(",");
const leastTread = (tick: FixtureTick): number => Math.min(...WEAR_FIELDS.map((f) => tick[f]));

/** The ticks on which any of the twelve temperatures changed, after the first. */
const refreshes = ticks.filter((tick, i) => i > 0 && tempsOf(tick) !== tempsOf(ticks[i - 1]!));
const at = (t: number): FixtureTick => ticks.find((tick) => tick.t === t)!;
const before = (t: number): FixtureTick => ticks[ticks.indexOf(at(t)) - 1]!;

describe("the 2026-10-11 tire-temperature capture fixture", () => {
  it("refreshes the temperatures four times and holds them in between: two stops, a reset, the garage", () => {
    expect(refreshes.map((tick) => tick.t)).toEqual([342.25, 539.8, 618, 668.83]);
  });

  it("refreshes wear on exactly the same ticks", () => {
    const wearRefreshes = ticks.filter((tick, i) => i > 0 && wearOf(tick) !== wearOf(ticks[i - 1]!));

    expect(wearRefreshes.map((tick) => tick.t)).toEqual(refreshes.map((tick) => tick.t));
  });

  it("starts in the garage on a cold set and holds it through the Drive placement and the out lap", () => {
    expect(ticks[0]).toMatchObject({ t: 129.97, IsOnTrack: false, IsReplayPlaying: true, LFtempCL: 50.03155517578125 });
    // "Drive": in the car at 134.72, standing in the box one tick later.
    expect(at(134.72)).toMatchObject({ IsOnTrack: true, IsReplayPlaying: false, PlayerCarInPitStall: false });
    expect(at(134.73)).toMatchObject({ OnPitRoad: true, PlayerCarInPitStall: true, PlayerTrackSurface: 1 });

    for (const tick of ticks.filter((tick) => tick.t < 342.25)) {
      expect(tempsOf(tick), String(tick.t)).toBe(tempsOf(ticks[0]!));
    }
  });

  it("refreshes at each stop as the car arrives in its box, before PlayerCarInPitStall", () => {
    // Stop 1: surface InPitStall at 341.42, refresh at 342.25, stall flag at 342.30.
    expect(at(341.42)).toMatchObject({ PlayerTrackSurface: 1, PlayerCarInPitStall: false });
    expect(at(342.25)).toMatchObject({ OnPitRoad: true, PlayerCarInPitStall: false });
    expect(at(342.3)).toMatchObject({ PlayerCarInPitStall: true });
    // Stop 2: surface at 539.58, refresh at 539.80, stall flag at 540.20.
    expect(at(539.58)).toMatchObject({ PlayerTrackSurface: 1, PlayerCarInPitStall: false });
    expect(at(539.8)).toMatchObject({ OnPitRoad: true, PlayerCarInPitStall: false });
    expect(at(540.2)).toMatchObject({ PlayerCarInPitStall: true });
  });

  it("holds stop 1's temperatures through the four-tire change, departure and the whole next stint", () => {
    // Four tires queued on arrival, done by 343.30.
    expect(at(342.25).PitSvFlags).toBe(0x0f);
    expect(at(343.3).PitSvFlags).toBe(0);

    for (const tick of ticks.filter((tick) => tick.t >= 342.25 && tick.t < 539.8)) {
      expect(tempsOf(tick), String(tick.t)).toBe(tempsOf(at(342.25)));
    }

    // Departure (still on pit road), pit exit and the stint are inside that window.
    expect(at(348.88)).toMatchObject({ OnPitRoad: true, PlayerCarInPitStall: false });
    expect(at(352.1)).toMatchObject({ OnPitRoad: false });
    expect(at(357.02)).toMatchObject({ PlayerTrackSurface: 3 });
  });

  it("runs both fronts hottest on the inside — R on the left front, L on the right front", () => {
    for (const t of [342.25, 539.8, 618]) {
      const tick = at(t);

      expect(tick.LFtempCR, String(t)).toBeGreaterThan(tick.LFtempCM);
      expect(tick.LFtempCM, String(t)).toBeGreaterThan(tick.LFtempCL);
      expect(tick.RFtempCL, String(t)).toBeGreaterThan(tick.RFtempCM);
      expect(tick.RFtempCM, String(t)).toBeGreaterThan(tick.RFtempCR);
    }
  });

  it("refreshes at the reset on the tick the car leaves the world, one tick before it stands in its box", () => {
    expect(before(618)).toMatchObject({ IsOnTrack: true, OnPitRoad: false, PlayerTrackSurface: 3 });
    // In the car, live, out of the world.
    expect(at(618)).toMatchObject({
      IsOnTrack: true,
      IsReplayPlaying: false,
      OnPitRoad: false,
      PlayerCarInPitStall: false,
      PlayerTrackSurface: -1,
    });
    expect(at(618.02)).toMatchObject({ OnPitRoad: true, PlayerCarInPitStall: true, PlayerTrackSurface: 1 });
    expect(tempsOf(at(618.02))).toBe(tempsOf(at(618)));
  });

  it("shows at the reset the set that came off: hot, and more worn than at stop 2", () => {
    expect(at(618).LFtempCL).toBeGreaterThan(60);
    expect(leastTread(at(618))).toBeLessThan(leastTread(at(539.8)));
  });

  it("holds the reset's temperatures through 25 s in the box and the drive back onto the circuit", () => {
    for (const tick of ticks.filter((tick) => tick.t >= 618 && tick.t < 668.83)) {
      expect(tempsOf(tick), String(tick.t)).toBe(tempsOf(at(618)));
    }

    expect(at(643.67)).toMatchObject({ PlayerCarInPitStall: false });
    expect(at(651.88)).toMatchObject({ OnPitRoad: false, PlayerTrackSurface: 3 });
  });

  it("refreshes on the tick the driver leaves the car for the garage", () => {
    expect(before(668.83)).toMatchObject({ IsOnTrack: true, IsReplayPlaying: false, PlayerTrackSurface: 3 });
    expect(at(668.83)).toMatchObject({ IsOnTrack: false, IsReplayPlaying: true, PlayerTrackSurface: -1 });
  });

  it("shows in the garage the set the reset fitted, 25 s old: barely warm and barely worn", () => {
    const garage = at(668.83);

    for (const field of TEMP_FIELDS) {
      expect(garage[field], field).toBeGreaterThan(50.5);
      expect(garage[field], field).toBeLessThan(53);
    }

    expect(leastTread(garage)).toBeGreaterThan(0.998);
    expect(leastTread(garage)).toBeLessThan(1);
  });

  it("ends in the garage, with no second Drive placement", () => {
    expect(ticks.at(-1)).toMatchObject({ t: 668.85, IsOnTrack: false, IsReplayPlaying: true });
  });
});
