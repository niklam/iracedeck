import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WEAR_FIELDS = [
  "LFwearL",
  "LFwearM",
  "LFwearR",
  "RFwearL",
  "RFwearM",
  "RFwearR",
  "LRwearL",
  "LRwearM",
  "LRwearR",
  "RRwearL",
  "RRwearM",
  "RRwearR",
] as const;

type FixtureTick = {
  t: number;
  IsOnTrack: boolean;
  OnPitRoad: boolean;
  PlayerCarInPitStall: boolean;
  PlayerTrackSurface: number;
  PitSvFlags: number;
} & Record<(typeof WEAR_FIELDS)[number], number>;

const ticks = JSON.parse(
  readFileSync(new URL("./tire-wear-stops-20260919.json", import.meta.url), "utf-8"),
) as FixtureTick[];

const wearOf = (tick: FixtureTick): string => WEAR_FIELDS.map((f) => tick[f]).join(",");

/** The ticks on which any of the twelve readings changed, after the first. */
const refreshes = ticks.filter((tick, i) => i > 0 && wearOf(tick) !== wearOf(ticks[i - 1]!));
const at = (t: number): FixtureTick => ticks.find((tick) => tick.t === t)!;

describe("the 2026-09-19 tire-wear capture fixture", () => {
  it("refreshes the readings exactly once per stop, on arrival in the box, between the surface and the stall flag", () => {
    expect(refreshes.map((tick) => tick.t)).toEqual([447.25, 597.75]);

    // Stop 1: surface InPitStall at 446.77, refresh at 447.25, PlayerCarInPitStall at 447.47.
    expect(at(446.77)).toMatchObject({ PlayerTrackSurface: 1, PlayerCarInPitStall: false });
    expect(at(447.25)).toMatchObject({ PlayerCarInPitStall: false });
    expect(at(447.47)).toMatchObject({ PlayerCarInPitStall: true });
    // Stop 2: surface at 597.55, refresh at 597.75, stall flag at 598.00.
    expect(at(597.55)).toMatchObject({ PlayerTrackSurface: 1, PlayerCarInPitStall: false });
    expect(at(598)).toMatchObject({ PlayerCarInPitStall: true });
  });

  it("holds stop 1's readings through the four-tire change, departure and pit exit", () => {
    const refreshed = wearOf(at(447.25));

    // Four tires (and fast repair) queued on arrival: 0x4F.
    expect(at(447.25).PitSvFlags).toBe(0x4f);

    for (const tick of ticks.filter((tick) => tick.t >= 447.25 && tick.t < 597.75)) {
      expect(wearOf(tick), String(tick.t)).toBe(refreshed);
    }

    // Departure (still on pit road) and pit exit are both inside that window.
    expect(at(469.13)).toMatchObject({ OnPitRoad: true, PlayerCarInPitStall: false });
    expect(at(475.55)).toMatchObject({ OnPitRoad: false });
  });

  it("wears both fronts lowest on the inside — L on the right front, R on the left front", () => {
    const stop1 = at(447.25);

    expect(stop1.LFwearR).toBeLessThan(stop1.LFwearL);
    expect(stop1.LFwearR).toBeLessThan(stop1.LFwearM);
    expect(stop1.RFwearL).toBeLessThan(stop1.RFwearM);
    expect(stop1.RFwearL).toBeLessThan(stop1.RFwearR);
  });

  it("makes stop 2 with nothing queued, so it reports the set still on the car", () => {
    expect(ticks.filter((tick) => tick.t >= 572.7).every((tick) => tick.PitSvFlags === 0)).toBe(true);
    expect(at(597.75).LFwearR).toBeCloseTo(0.99265, 5);
  });

  it("starts the session on the circuit, never in the stall", () => {
    const firstOnTrack = ticks.find((tick) => tick.IsOnTrack)!;

    expect(firstOnTrack).toMatchObject({ t: 139.68, PlayerTrackSurface: -1, OnPitRoad: false });
    expect(ticks[ticks.indexOf(firstOnTrack) + 1]).toMatchObject({ PlayerTrackSurface: 3 });
  });
});
