import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { CornerMarker } from "@iracedeck/track-data";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSectorStartState, type SectorStartState } from "../state.js";
import { diffSectorStart, secondsToNextCorner, SECTOR_START_EVENTS } from "./sector-start.js";
import type { EmitFn } from "./types.js";

/** Four sectors, starts on binary fractions so every crossing below is exact. */
const SECTORS = [0, 0.25, 0.5, 0.75];

const MARKERS: CornerMarker[] = [
  { startPct: 0.0625, name: "Turn 1", slug: "turn-1" },
  { startPct: 0.625, name: "Turn 2", slug: "turn-2" },
];

/** 4096 m, so a 40.96 m/s car leads by exactly 0.01 of a lap at 1 s. */
const TRACK_LENGTH = 4096;
const SPEED = 40.96;
const LEAD = () => 1;

function telemetry(overrides: Partial<TelemetryData>): TelemetryData {
  return { IsOnTrack: true, OnPitRoad: false, Speed: SPEED, ...overrides } as TelemetryData;
}

describe("diffSectorStart", () => {
  let slice: SectorStartState;
  let emit: EmitFn<(typeof SECTOR_START_EVENTS)[number]>;

  beforeEach(() => {
    slice = createSectorStartState();
    emit = vi.fn();
  });

  function tick(
    lapDistPct: number,
    overrides: Partial<TelemetryData> = {},
    {
      practice = true,
      sectors = SECTORS as readonly number[] | null,
      markers = MARKERS as readonly CornerMarker[] | null,
      trackLength = TRACK_LENGTH as number | null,
    } = {},
  ): void {
    diffSectorStart(
      slice,
      telemetry({ LapDistPct: lapDistPct, ...overrides }),
      practice,
      sectors,
      markers,
      trackLength,
      LEAD,
      emit,
    );
  }

  /** Drive a lap from `from` to `to` in steps well under the teleport threshold. */
  function drive(from: number, to: number, overrides: Partial<TelemetryData> = {}): void {
    for (let pct = from; pct <= to + 1e-9; pct += 0.01) tick(pct % 1, overrides);
  }

  const sectorsEmitted = (): number[] => vi.mocked(emit).mock.calls.map(([e]) => (e.data as { sector: number }).sector);

  it("seeds silently on the first valid tick", () => {
    tick(0.245);

    expect(emit).not.toHaveBeenCalled();
  });

  it("emits as the lead point crosses a sector start, with the sector counted from 1", () => {
    // Lead 0.01: lead point 0.2375 → 0.2525 crosses 0.25.
    tick(0.2275);
    tick(0.2425);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      event: "sectorStart.approaching",
      // Turn 2 (0.625) is 0.375 lap past sector 2's start: 1536 m at 40.96 m/s.
      data: { sector: 2, sectorCount: 4, nextCornerInS: 37.5 },
    });
  });

  it("emits every sector start once a lap, sector 1 at the line included, and again on the next lap", () => {
    drive(0.9, 1.9);

    expect(sectorsEmitted()).toEqual([1, 2, 3, 4]);

    drive(1.91, 2.9);

    expect(sectorsEmitted()).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it("does not refire a sector on the same lap", () => {
    tick(0.2275);
    tick(0.2425);
    tick(0.2426);
    tick(0.2427);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("never fires while reversing", () => {
    tick(0.26);
    tick(0.235); // lead point back over 0.25
    tick(0.236);

    expect(emit).not.toHaveBeenCalled();
  });

  it("re-anchors without firing on a teleport, and announces normally after it", () => {
    tick(0.6);
    tick(0.2275); // a jump of most of a lap, to just behind sector 2: reset to the pits

    expect(emit).not.toHaveBeenCalled();

    // The fresh pass starts at the new point and crosses sector 2's start.
    tick(0.2425);

    expect(sectorsEmitted()).toEqual([2]);
  });

  it("consumes a crossing on pit road, and stays silent for it after leaving pit road on the same lap", () => {
    tick(0.2275, { OnPitRoad: true });
    tick(0.2425, { OnPitRoad: true });

    expect(emit).not.toHaveBeenCalled();

    tick(0.2426);

    expect(emit).not.toHaveBeenCalled();

    // The next sector off pit road is announced.
    drive(0.25, 0.5);

    expect(sectorsEmitted()).toEqual([3]);
  });

  it("is silent outside a practice-like session, and resets its pass there", () => {
    tick(0.2275, {}, { practice: false });
    tick(0.2425, {}, { practice: false });

    expect(emit).not.toHaveBeenCalled();
    expect(slice).toEqual(createSectorStartState());
  });

  it("is silent without sectors", () => {
    tick(0.2275, {}, { sectors: null });
    tick(0.2425, {}, { sectors: null });
    tick(0.2275, {}, { sectors: [] });
    tick(0.2425, {}, { sectors: [] });

    expect(emit).not.toHaveBeenCalled();
  });

  it("is silent without a track length, off track, or without a lap position", () => {
    tick(0.2275, {}, { trackLength: null });
    tick(0.2425, {}, { trackLength: null });
    tick(0.2275, {}, { trackLength: 0 });
    tick(0.2425, {}, { trackLength: 0 });
    tick(0.2275, { IsOnTrack: false });
    tick(0.2425, { IsOnTrack: false });
    tick(-1);
    tick(0.2425, { LapDistPct: undefined });

    expect(emit).not.toHaveBeenCalled();
  });

  it("resets its pass in place when a gate fails, so the slice object is kept", () => {
    tick(0.2275);
    slice.spoken.add(3);
    const spoken = slice.spoken;

    tick(0.2425, { IsOnTrack: false });

    expect(slice.leadPrevPct).toBeNull();
    expect(slice.spoken).toBe(spoken);
    expect(slice.spoken.size).toBe(0);
  });

  it("still emits on a track with no corner data, with nextCornerInS null", () => {
    tick(0.2275, {}, { markers: null });
    tick(0.2425, {}, { markers: null });
    tick(0.4775, {}, { markers: [] });
    tick(0.4925, {}, { markers: [] });

    expect(vi.mocked(emit).mock.calls.map(([e]) => e.data)).toEqual([
      { sector: 2, sectorCount: 4, nextCornerInS: null },
      { sector: 3, sectorCount: 4, nextCornerInS: null },
    ]);
  });

  it("measures nextCornerInS to the next marker across the line", () => {
    // Sector 4 starts at 0.75; Turn 2 (0.625) is behind it, Turn 1 (0.0625) is
    // 0.3125 lap ahead across the line: 1280 m at 40.96 m/s.
    tick(0.7275);
    tick(0.7425);

    expect(emit).toHaveBeenCalledWith({
      event: "sectorStart.approaching",
      data: { sector: 4, sectorCount: 4, nextCornerInS: 31.25 },
    });
  });
});

describe("secondsToNextCorner", () => {
  it("is the forward distance to the nearest marker past the start, at the current speed", () => {
    // 0.01 lap past the start: 40.96 m at 40.96 m/s.
    const markers: CornerMarker[] = [
      { startPct: 0.26, name: "A", slug: "a" },
      { startPct: 0.6, name: "B", slug: "b" },
    ];

    expect(secondsToNextCorner(0.25, markers, TRACK_LENGTH, SPEED)).toBeCloseTo(1, 9);
  });

  it("wraps the line to the first marker of the lap", () => {
    expect(secondsToNextCorner(0.75, MARKERS, TRACK_LENGTH, SPEED)).toBe(31.25);
  });

  it("is 0 for a marker exactly at the sector start", () => {
    expect(secondsToNextCorner(0.0625, MARKERS, TRACK_LENGTH, SPEED)).toBe(0);
  });

  it("is null without markers", () => {
    expect(secondsToNextCorner(0.25, null, TRACK_LENGTH, SPEED)).toBeNull();
    expect(secondsToNextCorner(0.25, [], TRACK_LENGTH, SPEED)).toBeNull();
  });

  it("is null without a track length", () => {
    expect(secondsToNextCorner(0.25, MARKERS, null, SPEED)).toBeNull();
    expect(secondsToNextCorner(0.25, MARKERS, 0, SPEED)).toBeNull();
  });

  it.each([0, -5, Number.NaN, undefined])("is null at a speed of %s", (speed) => {
    expect(secondsToNextCorner(0.25, MARKERS, TRACK_LENGTH, speed)).toBeNull();
  });
});
