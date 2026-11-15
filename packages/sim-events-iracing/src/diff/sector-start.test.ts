import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSectorStartState, type SectorStartState } from "../state.js";
import { diffSectorStart, SECTOR_START_EVENTS } from "./sector-start.js";
import type { EmitFn } from "./types.js";

/** Four sectors, starts on binary fractions so every crossing below is exact. */
const SECTORS = [0, 0.25, 0.5, 0.75];

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
      trackLength = TRACK_LENGTH as number | null,
    } = {},
  ): number | null {
    return diffSectorStart(
      slice,
      telemetry({ LapDistPct: lapDistPct, ...overrides }),
      practice,
      sectors,
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
      data: { sector: 2, sectorCount: 4 },
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

  // #1676: the translator orders this call against a corner name swept on the
  // same tick by how far behind the lead point each crossed start sits.
  describe("returns how far behind the lead point the start it published sits", () => {
    it("for a crossing it publishes", () => {
      // Lead point 0.2375 → 0.2525, across sector 2's start at 0.25.
      expect(tick(0.2275)).toBeNull();
      expect(tick(0.2425)).toBeCloseTo(0.0025, 12);
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it("across the start/finish line, for sector 1", () => {
      // Lead point 0.99 → 0.005, across sector 1's start at 0.
      tick(0.98);

      expect(tick(0.995)).toBeCloseTo(0.005, 12);
      expect(sectorsEmitted()).toEqual([1]);
    });

    it("as null when nothing is crossed, and for a crossing consumed on pit road", () => {
      tick(0.2);

      expect(tick(0.21)).toBeNull();
      expect(tick(0.2425, { OnPitRoad: true })).toBeNull();
      expect(emit).not.toHaveBeenCalled();
    });

    it("as null when a gate fails", () => {
      tick(0.2275);

      expect(tick(0.2425, {}, { practice: false })).toBeNull();
      expect(tick(0.2425, { IsOnTrack: false })).toBeNull();
    });
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
});
