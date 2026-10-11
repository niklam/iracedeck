import { forwardGapMeters, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CATCH_UP_MIN_SPACING_SAMPLES,
  CATCH_UP_PACE_CAR_SPACING_FACTOR,
  type CautionGapMeasurement,
  measureCautionGap,
} from "./caution-gap.js";
import { type PaceLineup, resolveCarAheadInLine, resolvePaceLineup } from "./pace-lineup.js";

/** The pace car's index in real telemetry (slot 20 in the fixtures' trimmed arrays). */
const PACE = 64;

function session(playerCarIdx: number, paceCarIdx: number | null = PACE): Record<string, unknown> {
  return {
    DriverInfo: { DriverCarIdx: playerCarIdx, ...(paceCarIdx === null ? {} : { PaceCarIdx: paceCarIdx }), Drivers: [] },
  };
}

type Car = { idx: number; line: number; row: number; at: number; surface?: number };

/** A 1000 m lap, so a lap fraction × 1000 is metres and the arithmetic below reads off the page. */
const LAP = 1000;

/** Telemetry at real width from a list of cars; `at` is metres round the lap. */
function field(cars: Car[], extra: Record<string, unknown> = {}): TelemetryData {
  const lines = new Array(72).fill(-1);
  const rows = new Array(72).fill(-1);
  const dist = new Array(72).fill(-1);
  const surface = new Array(72).fill(TrkLoc.NotInWorld);

  for (const car of cars) {
    lines[car.idx] = car.line;
    rows[car.idx] = car.row;
    dist[car.idx] = (((car.at % LAP) + LAP) % LAP) / LAP;
    surface[car.idx] = car.surface ?? TrkLoc.OnTrack;
  }

  return {
    CarIdxPaceLine: lines,
    CarIdxPaceRow: rows,
    CarIdxLapDistPct: dist,
    CarIdxTrackSurface: surface,
    ...extra,
  } as unknown as TelemetryData;
}

/**
 * A single-file caution lineup: the pace car at line 0 row 0 at 500 m, and
 * cars 1..n behind it at rows 1..n — the leader 20 m back, the rest 10 m
 * apart. `shift` moves named cars further back, in metres.
 */
function singleFile(n: number, shift: Record<number, number> = {}): Car[] {
  const cars: Car[] = [{ idx: PACE, line: 0, row: 0, at: 500 }];

  for (let car = 1; car <= n; car++) {
    cars.push({ idx: car, line: 0, row: car, at: 500 - 20 - 10 * (car - 1) - (shift[car] ?? 0) });
  }

  return cars;
}

function measure(
  telemetry: TelemetryData,
  playerCarIdx: number,
  trackLength: number | null = LAP,
): CautionGapMeasurement {
  const info = session(playerCarIdx);
  const lineup = resolvePaceLineup(telemetry, info, true);

  if (lineup === null) throw new Error("the player is not lined up");

  return measureCautionGap(telemetry, info, lineup, trackLength);
}

describe("measureCautionGap — the gap to the car you follow", () => {
  it("is the forward distance to the lineup's follow car", () => {
    // Car 6 has dropped 25 m back from car 5: 10 + 25.
    const m = measure(field(singleFile(8, { 6: 25, 7: 25, 8: 25 })), 6);

    expect(m.followCarIdx).toBe(5);
    expect(m.gapMeters).toBeCloseTo(35);
  });

  it("is measured in the player's own line — never to the car alongside in the other lane", () => {
    // Double file: line 0 holds the pace car and cars 1, 3, 5, 7, 9; line 1
    // holds cars 2, 4, 6, 8, 10 from row 0. The player (car 8, line 1 row 3)
    // is 30 m behind car 6 in his own line, with car 9 two metres up the road
    // in the other lane.
    const cars: Car[] = [{ idx: PACE, line: 0, row: 0, at: 500 }];

    for (let pair = 0; pair < 5; pair++) {
      cars.push({ idx: 2 * pair + 1, line: 0, row: pair + 1, at: 480 - 10 * pair });
      cars.push({ idx: 2 * pair + 2, line: 1, row: pair, at: 480 - 10 * pair });
    }

    const moved = cars.map((car) => (car.idx === 8 ? { ...car, at: 430 } : car.idx === 9 ? { ...car, at: 432 } : car));
    const m = measure(field(moved), 8);

    expect(m.followCarIdx).toBe(6);
    expect(m.gapMeters).toBeCloseTo(30);
    expect(forwardGapMeters(field(moved), 8, 9, LAP)).toBeCloseTo(2);
  });

  it("goes forward across the start/finish line", () => {
    // The whole field moved round so that car 5 is 5 m past the line and car 6
    // is 5 m short of it: 10 m forward, not 990 m behind.
    const cars = singleFile(8).map((car) => ({ ...car, at: car.at + 565 }));
    const telemetry = field(cars);
    const dist = telemetry.CarIdxLapDistPct as number[];

    expect(dist[5]).toBeCloseTo(0.005);
    expect(dist[6]).toBeCloseTo(0.995);
    expect(measure(telemetry, 6).gapMeters).toBeCloseTo(10);
  });

  it("is measured to the car the HANDED lineup names — the measurement resolves no lineup of its own", () => {
    const telemetry = field(singleFile(8));
    const info = session(6);
    const lineup = resolvePaceLineup(telemetry, info, true) as PaceLineup;
    // The rows say car 6 follows car 5; a lineup that says car 3 is believed.
    const m = measureCautionGap(telemetry, info, { ...lineup, followCarIdx: 3 }, LAP);

    expect(m.followCarIdx).toBe(3);
    expect(m.gapMeters).toBeCloseTo(30);
  });

  it("is null when the lineup names no car to follow, though the spacing is still read", () => {
    const telemetry = field(singleFile(8));
    const info = session(6);
    const lineup = resolvePaceLineup(telemetry, info, true) as PaceLineup;
    const m = measureCautionGap(telemetry, info, { ...lineup, followCarIdx: null }, LAP);

    expect(m).toMatchObject({ followCarIdx: null, gapMeters: null, ratio: null, aheadOfSlot: false });
    expect(m.packSpacingMeters).toBeCloseTo(10);
  });

  it("is null when the car ahead is not on a track surface", () => {
    const cars = singleFile(8).map((car) => (car.idx === 5 ? { ...car, surface: TrkLoc.AproachingPits } : car));

    expect(measure(field(cars), 6)).toMatchObject({ followCarIdx: 5, gapMeters: null, ratio: null });
  });

  it("is null without a track length, and so is everything built on it", () => {
    expect(measure(field(singleFile(8)), 6, null)).toMatchObject({
      gapMeters: null,
      packSpacingMeters: null,
      spacingSamples: 0,
      referenceMeters: null,
      ratio: null,
      aheadOfSlot: false,
    });
  });

  it("is null without per-car lap distance", () => {
    const { CarIdxLapDistPct: _dropped, ...rest } = field(singleFile(8)) as unknown as Record<string, unknown>;

    expect(measure(rest as unknown as TelemetryData, 6)).toMatchObject({
      gapMeters: null,
      packSpacingMeters: null,
      spacingSamples: 0,
      ratio: null,
    });
  });
});

describe("measureCautionGap — the pack spacing", () => {
  it("is the median in-line gap, leaving out the pace car's pair and the player's own", () => {
    // Eight cars: seven pairs behind the leader, of which the player's own is
    // left out. The player (car 6) has dropped 40 m; nobody else moved, so the
    // pair BEHIND him — car 7 to car 6 — is still 10 m and still counted.
    const m = measure(field(singleFile(8, { 6: 40, 7: 40, 8: 40 })), 6);

    expect(m.spacingSamples).toBe(6); // 2→1, 3→2, 4→3, 5→4, 7→6, 8→7
    expect(m.packSpacingMeters).toBeCloseTo(10);
    expect(m.gapMeters).toBeCloseTo(50);
    expect(m.ratio).toBeCloseTo(5);
  });

  it("is not pulled by the player's own gap, however large", () => {
    const near = measure(field(singleFile(8)), 6);
    const far = measure(field(singleFile(8, { 6: 300, 7: 300, 8: 300 })), 6);

    expect(far.packSpacingMeters).toBeCloseTo(near.packSpacingMeters as number);
  });

  it("does not count the leader's 20 m to the pace car as a pack gap", () => {
    // Were it counted, six samples of 10 m and one of 20 m would still give a
    // median of 10 — so count the samples, and move the leader a long way.
    const cars = singleFile(8).map((car) => (car.idx === PACE ? { ...car, at: 700 } : car));
    const m = measure(field(cars), 6);

    expect(m.spacingSamples).toBe(6);
    expect(m.packSpacingMeters).toBeCloseTo(10);
  });

  it("takes the mean of the middle two for an even count, and the middle one for an odd count", () => {
    // Pairs behind the leader, the player's (8→7) aside: 2→1, 3→2, 4→3, 5→4, 6→5, 7→6.
    // Gaps 10, 12, 14, 16, 18, 20 → median 15.
    const even = singleFile(8, { 3: 2, 4: 6, 5: 12, 6: 20, 7: 30, 8: 30 });

    expect(measure(field(even), 8)).toMatchObject({ spacingSamples: 6 });
    expect(measure(field(even), 8).packSpacingMeters).toBeCloseTo(15);

    // One car fewer: 10, 12, 14, 16, 18 → 14.
    const odd = singleFile(7, { 3: 2, 4: 6, 5: 12, 6: 20, 7: 20 });

    expect(measure(field(odd), 7)).toMatchObject({ spacingSamples: 5 });
    expect(measure(field(odd), 7).packSpacingMeters).toBeCloseTo(14);
  });

  it("pools both lines, pairing each car with the car ahead in ITS OWN line", () => {
    // Line 0 at 10 m spacing, line 1 at 14 m: pooled, not averaged per line.
    const cars: Car[] = [{ idx: PACE, line: 0, row: 0, at: 500 }];

    for (let row = 1; row <= 5; row++) cars.push({ idx: row, line: 0, row, at: 490 - 10 * row });

    for (let row = 0; row < 5; row++) cars.push({ idx: 10 + row, line: 1, row, at: 480 - 14 * row });

    // Player = car 5 (line 0 row 5). Line 0 gives 2→1, 3→2, 4→3 (10, 10, 10);
    // line 1 gives 11→10, 12→11, 13→12, 14→13 (14 each). Median of seven: 14.
    const m = measure(field(cars), 5);

    expect(m.spacingSamples).toBe(7);
    expect(m.packSpacingMeters).toBeCloseTo(14);
  });

  it(`needs ${CATCH_UP_MIN_SPACING_SAMPLES} pairs — below that there is no reading, and no ratio`, () => {
    // Six cars: 2→1, 3→2, 4→3, 5→4 with the player last — exactly four pairs.
    expect(measure(field(singleFile(6)), 6)).toMatchObject({ spacingSamples: 4 });
    expect(measure(field(singleFile(6)), 6).ratio).toBeCloseTo(1);

    // Five cars: three pairs.
    expect(measure(field(singleFile(5)), 5)).toMatchObject({
      spacingSamples: 3,
      packSpacingMeters: null,
      referenceMeters: null,
      ratio: null,
    });
    // The gap itself is still measured.
    expect(measure(field(singleFile(5)), 5).gapMeters).toBeCloseTo(10);
    expect(CATCH_UP_MIN_SPACING_SAMPLES).toBe(4);
  });

  it("leaves out a pair with either car off the track surface — by CarIdxTrackSurface, never CarIdxOnPitRoad", () => {
    const base = singleFile(10);
    const all = measure(field(base), 10);

    expect(all.spacingSamples).toBe(8);

    for (const surface of [TrkLoc.InPitStall, TrkLoc.AproachingPits]) {
      // Car 4 off the track takes two pairs with it: 4→3 and 5→4.
      const cars = base.map((car) => (car.idx === 4 ? { ...car, surface } : car));

      expect(measure(field(cars), 10).spacingSamples, TrkLoc[surface]).toBe(6);
    }

    // `CarIdxOnPitRoad` reads true for racing cars on track and for empty
    // slots alike (spec finding 6): it changes nothing.
    const lying = field(base, { CarIdxOnPitRoad: new Array(72).fill(true) });

    expect(measure(lying, 10).spacingSamples).toBe(8);
    expect(measure(lying, 10).packSpacingMeters).toBeCloseTo(all.packSpacingMeters as number);
  });

  it("counts a car on the grass — OffTrack is still on the circuit", () => {
    const cars = singleFile(10).map((car) => (car.idx === 4 ? { ...car, surface: TrkLoc.OffTrack } : car));

    expect(measure(field(cars), 10).spacingSamples).toBe(8);
  });

  it("pairs past a car that has left the world, exactly as the lineup does", () => {
    // Car 4 holds line 0 row 4 and is not in the world. Car 5 is paired with
    // car 3 (20 m), and car 4 pairs with nobody.
    const cars = singleFile(10).map((car) => (car.idx === 4 ? { ...car, surface: TrkLoc.NotInWorld } : car));
    const telemetry = field(cars);
    const m = measure(telemetry, 10);

    expect(m.spacingSamples).toBe(7); // 2→1, 3→2, 5→3, 6→5, 7→6, 8→7, 9→8
    expect(resolvePaceLineup(telemetry, session(5), true)?.followCarIdx).toBe(3);
    expect(measure(telemetry, 5).gapMeters).toBeCloseTo(20);
  });

  it("reads nothing from a tick with no track surfaces — a surface that cannot be read is not a track surface", () => {
    const { CarIdxTrackSurface: _dropped, ...rest } = field(singleFile(8)) as unknown as Record<string, unknown>;

    expect(measure(rest as unknown as TelemetryData, 6)).toMatchObject({
      gapMeters: null,
      spacingSamples: 0,
      packSpacingMeters: null,
      paceCarOnTrack: false,
    });
  });
});

describe("measureCautionGap — a pair with the pace car", () => {
  it(`is judged against ${CATCH_UP_PACE_CAR_SPACING_FACTOR} × the pack spacing — the leader at his normal 20 m reads 1×, not 2×`, () => {
    const m = measure(field(singleFile(8)), 1);

    expect(m.followCarIdx).toBe(PACE);
    expect(m.gapMeters).toBeCloseTo(20);
    expect(m.packSpacingMeters).toBeCloseTo(10);
    expect(m.referenceMeters).toBeCloseTo(20);
    expect(m.ratio).toBeCloseTo(1);
    expect(CATCH_UP_PACE_CAR_SPACING_FACTOR).toBe(2);
  });

  it("uses the same reference for the outside front-row car, who has nobody ahead in his line", () => {
    const cars: Car[] = [{ idx: PACE, line: 0, row: 0, at: 500 }];

    for (let row = 1; row <= 5; row++) cars.push({ idx: row, line: 0, row, at: 490 - 10 * row });

    for (let row = 0; row < 5; row++) cars.push({ idx: 10 + row, line: 1, row, at: 480 - 10 * row });

    // Car 10 (line 1 row 0) has dropped to 60 m behind the pace car.
    const m = measure(field(cars.map((car) => (car.idx === 10 ? { ...car, at: 440 } : car))), 10);

    expect(m.followCarIdx).toBe(PACE);
    expect(m.gapMeters).toBeCloseTo(60);
    expect(m.referenceMeters).toBeCloseTo(20);
    expect(m.ratio).toBeCloseTo(3);
  });

  it("says whether the pace car is on the road", () => {
    const withPaceCar = (surface: number): TelemetryData =>
      field(singleFile(8).map((car) => (car.idx === PACE ? { ...car, surface } : car)));

    expect(measure(withPaceCar(TrkLoc.OnTrack), 6).paceCarOnTrack).toBe(true);
    expect(measure(withPaceCar(TrkLoc.OffTrack), 6).paceCarOnTrack).toBe(true);
    expect(measure(withPaceCar(TrkLoc.AproachingPits), 6).paceCarOnTrack).toBe(false);
    expect(measure(withPaceCar(TrkLoc.InPitStall), 6).paceCarOnTrack).toBe(false);
  });

  it("does not see a pace car that session info does not name", () => {
    const telemetry = field(singleFile(8));
    const info = session(6, null);
    const lineup = resolvePaceLineup(telemetry, info, true) as PaceLineup;

    expect(measureCautionGap(telemetry, info, lineup, LAP).paceCarOnTrack).toBe(false);
  });
});

describe("measureCautionGap — ahead of your slot", () => {
  it("is true when the car to follow is nearer behind than ahead — over half a lap forward", () => {
    // Car 6 has driven on round: car 5 is now 760 m forward, 240 m behind.
    const cars = singleFile(8).map((car) => (car.idx === 6 ? { ...car, at: car.at + 250 } : car));
    const m = measure(field(cars), 6);

    expect(m.gapMeters).toBeCloseTo(760);
    expect(m.aheadOfSlot).toBe(true);
  });

  it("is false up to and including half a lap", () => {
    const at = (back: number): CautionGapMeasurement => measure(field(singleFile(8, { 6: back, 7: back, 8: back })), 6);

    expect(at(40).aheadOfSlot).toBe(false);
    expect(at(490).gapMeters).toBeCloseTo(500);
    expect(at(490).aheadOfSlot).toBe(false);
    expect(at(491).aheadOfSlot).toBe(true);
  });
});

describe("measureCautionGap — the pace flags", () => {
  it("are the lineup's, passed through", () => {
    const telemetry = field(singleFile(8), {
      CarIdxPaceFlags: Object.assign(new Array(72).fill(0), { 6: 4 }),
    });

    expect(measure(telemetry, 6).paceFlags).toEqual({ endOfLine: false, freePass: false, wavedAround: true });
    expect(measure(telemetry, 5).paceFlags).toEqual({ endOfLine: false, freePass: false, wavedAround: false });
  });
});

// ── The captures ───────────────────────────────────────────────────────────

type SnapshotTick = {
  snapshot?: string;
  t: number;
  SessionFlags: number;
  CarDistAhead?: number;
  CarIdxPaceLine: number[];
  CarIdxPaceRow: number[];
  CarIdxPaceFlags: number[];
  CarIdxLapDistPct: number[];
  CarIdxTrackSurface: number[];
};

function readTicks(name: string): SnapshotTick[] {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")) as SnapshotTick[];
}

/** A fixture tick widened back to real telemetry: slot 20 is the pace car, raw index 64. */
function widened(tick: SnapshotTick): TelemetryData {
  const widen = (values: number[]): number[] => {
    const out = new Array(72).fill(-1);

    values.forEach((v, i) => (out[i === 20 ? PACE : i] = v));

    return out;
  };

  return {
    SessionFlags: tick.SessionFlags,
    CarIdxPaceLine: widen(tick.CarIdxPaceLine),
    CarIdxPaceRow: widen(tick.CarIdxPaceRow),
    CarIdxPaceFlags: widen(tick.CarIdxPaceFlags).map((flags) => Math.max(flags, 0)),
    CarIdxLapDistPct: widen(tick.CarIdxLapDistPct),
    CarIdxTrackSurface: widen(tick.CarIdxTrackSurface),
  } as unknown as TelemetryData;
}

/** The player is car index 0 in every snapshot. */
const PLAYER = 0;

function measureSnapshot(tick: SnapshotTick, trackLength: number): CautionGapMeasurement {
  const telemetry = widened(tick);
  const info = session(PLAYER);
  const lineup = resolvePaceLineup(telemetry, info, true);

  if (lineup === null) throw new Error(`the player is not lined up in ${tick.snapshot ?? tick.t}`);

  return measureCautionGap(telemetry, info, lineup, trackLength);
}

/** The numbers of a measurement, rounded the way the spec's table prints them. */
function table(m: CautionGapMeasurement): {
  follow: number | null;
  gap: number;
  pack: number;
  n: number;
  ratio: number;
} {
  return {
    follow: m.followCarIdx,
    gap: Math.round((m.gapMeters as number) * 10) / 10,
    pack: Math.round((m.packSpacingMeters as number) * 10) / 10,
    n: m.spacingSamples,
    ratio: Math.round((m.ratio as number) * 10) / 10,
  };
}

describe("measureCautionGap — the five Homestead snapshots (2026-09-19, 2,381.5 m)", () => {
  const HOMESTEAD = 2381.5;
  const ticks = readTicks("caution-gap-20260919.json");
  const bySnapshot = (name: string): SnapshotTick => {
    const tick = ticks.find((candidate) => candidate.snapshot === name);

    if (!tick) throw new Error(`no snapshot ${name}`);

    return tick;
  };
  /** `094304` already lives in the uneven-lanes fixture; the file above adds the other four. */
  const [oneToGo] = readTicks("caution-lineup-20260919.json");

  it("reads 093300 open, at 4.7× — 50.4 m to car index 2 against a 10.6 m pack of 18 pairs", () => {
    const m = measureSnapshot(bySnapshot("20260919-093300"), HOMESTEAD);

    expect(table(m)).toEqual({ follow: 2, gap: 50.4, pack: 10.6, n: 18, ratio: 4.7 });
    expect(m.ratio).toBeCloseTo(4.74, 2);
    expect(m).toMatchObject({ aheadOfSlot: false, paceCarOnTrack: true });
    expect(m.paceFlags).toEqual({ endOfLine: false, freePass: false, wavedAround: false });
  });

  it("reads 093306 open, at 3.4× — six seconds on, 36.5 m and closing", () => {
    const m = measureSnapshot(bySnapshot("20260919-093306"), HOMESTEAD);

    expect(table(m)).toEqual({ follow: 2, gap: 36.5, pack: 10.6, n: 18, ratio: 3.4 });
    expect(m.ratio).toBeCloseTo(3.44, 2);
  });

  it("reads 094304 closed, at 1.3× — at the tail at normal spacing, still carrying WavedAround", () => {
    const m = measureSnapshot(oneToGo, HOMESTEAD);

    expect(table(m)).toEqual({ follow: 7, gap: 13.1, pack: 10.0, n: 17, ratio: 1.3 });
    expect(m.ratio).toBeCloseTo(1.31, 2);
    expect(m.paceFlags.wavedAround).toBe(true);
    expect(m.aheadOfSlot).toBe(false);
  });

  it("reads 131947 closed, at 1.2×", () => {
    const m = measureSnapshot(bySnapshot("20260919-131947"), HOMESTEAD);

    expect(table(m)).toEqual({ follow: 15, gap: 11.9, pack: 10.0, n: 17, ratio: 1.2 });
    expect(m.ratio).toBeCloseTo(1.18, 2);
  });

  it("pins that CarDistAhead in 131947 names the car alongside in the OTHER lane, 2.2 m up, not the car to follow", () => {
    // So a later "simplification" onto `CarDistAhead` fails here rather than
    // in a driver's ear. The player is on line 1; car 6 is on line 0.
    const tick = bySnapshot("20260919-131947");
    const telemetry = widened(tick);
    const m = measureSnapshot(tick, HOMESTEAD);

    expect(tick.CarDistAhead).toBeCloseTo(2.17, 2);
    expect(forwardGapMeters(telemetry, PLAYER, 6, HOMESTEAD)).toBeCloseTo(tick.CarDistAhead as number, 1);
    expect([tick.CarIdxPaceLine[PLAYER], tick.CarIdxPaceLine[6]]).toEqual([1, 0]);
    expect(m.followCarIdx).toBe(15);
    expect(tick.CarIdxPaceLine[15]).toBe(1);
    expect(m.gapMeters).toBeCloseTo(11.89, 2);
    expect(m.gapMeters as number).toBeGreaterThan(5 * (tick.CarDistAhead as number));
  });

  it("agrees with CarDistAhead single file, where the nearest car ahead IS the car to follow", () => {
    for (const name of ["20260919-093300", "20260919-093306"]) {
      const tick = bySnapshot(name);

      expect(measureSnapshot(tick, HOMESTEAD).gapMeters, name).toBeCloseTo(tick.CarDistAhead as number, 1);
    }
  });

  describe("094029 — a waved-around car on its way to the tail", () => {
    const tick = bySnapshot("20260919-094029");

    it("measures 1,819.7 m to the tail car, 0.76 of a lap forward: the player is ahead of his slot", () => {
      const m = measureSnapshot(tick, HOMESTEAD);

      expect(m.followCarIdx).toBe(13);
      expect(m.gapMeters).toBeCloseTo(1819.7, 1);
      expect((m.gapMeters as number) / HOMESTEAD).toBeCloseTo(0.764, 3);
      expect(m.aheadOfSlot).toBe(true);
    });

    it("carries WavedAround on the player, and on nobody else", () => {
      expect(measureSnapshot(tick, HOMESTEAD).paceFlags).toEqual({
        endOfLine: false,
        freePass: false,
        wavedAround: true,
      });
      expect(tick.CarIdxPaceFlags.filter((flags) => flags > 0)).toEqual([4]);
    });

    it("is a WAVING field, which is not a pack — gaps from 4.8 m to 284 m, median 24.9 m", () => {
      const telemetry = widened(tick);
      const m = measureSnapshot(tick, HOMESTEAD);
      const gaps: number[] = [];

      for (let carIdx = 1; carIdx < 20; carIdx++) {
        const ahead = resolveCarAheadInLine(
          telemetry.CarIdxPaceLine as number[],
          telemetry.CarIdxPaceRow as number[],
          carIdx,
          () => true,
        );

        if (ahead !== null && ahead !== PACE)
          gaps.push(forwardGapMeters(telemetry, carIdx, ahead, HOMESTEAD) as number);
      }

      expect((tick.SessionFlags >>> 0) & 0x8000).toBe(0x8000); // CautionWaving
      expect((tick.SessionFlags >>> 0) & 0x4000).toBe(0); // not yet static
      expect(table(m)).toMatchObject({ pack: 24.9, n: 18 });
      expect(Math.min(...gaps)).toBeCloseTo(4.8, 1);
      expect(Math.max(...gaps)).toBeCloseTo(284.1, 1);
    });

    it("has CarDistAhead reading 0.5 m to a car being passed", () => {
      expect(tick.CarDistAhead).toBeCloseTo(0.51, 2);
    });
  });

  it("finds the pace car 19.5–20.1 m ahead of its first car in every snapshot and both lanes — about twice the pack", () => {
    const paceGaps: number[] = [];

    for (const tick of [...ticks, oneToGo]) {
      const telemetry = widened(tick);

      for (let carIdx = 0; carIdx < 20; carIdx++) {
        if (tick.CarIdxPaceRow[carIdx] < 0) continue;

        const ahead = resolveCarAheadInLine(
          telemetry.CarIdxPaceLine as number[],
          telemetry.CarIdxPaceRow as number[],
          carIdx,
          () => true,
        );

        if (ahead === null || ahead === PACE)
          paceGaps.push(forwardGapMeters(telemetry, carIdx, PACE, HOMESTEAD) as number);
      }
    }

    // One per single-file snapshot, two per double-file one.
    expect(paceGaps).toHaveLength(7);
    expect(Math.min(...paceGaps)).toBeGreaterThan(19.4);
    expect(Math.max(...paceGaps)).toBeLessThan(20.2);
  });
});

describe("measureCautionGap — four snapshots at a second oval (2026-10-02, 1,570.7 m)", () => {
  // The spec's check C2: a different, shorter track, the same car count. The
  // issue's own comment gives a figure for each snapshot; three of the four
  // pack spacings below differ from it in the first decimal, for one reason,
  // which the last test of this block reproduces.
  const SECOND_OVAL = 1570.7;
  const ticks = readTicks("caution-gap-20261002.json");
  const bySnapshot = (name: string): SnapshotTick => {
    const tick = ticks.find((candidate) => candidate.snapshot === name);

    if (!tick) throw new Error(`no snapshot ${name}`);

    return tick;
  };

  it("reads 214148 in place, at 1.1× — 11.0 m against a 10.2 m pack", () => {
    const m = measureSnapshot(bySnapshot("20261002-214148"), SECOND_OVAL);

    expect(table(m)).toEqual({ follow: 8, gap: 11.0, pack: 10.2, n: 18, ratio: 1.1 });
    expect(m.ratio).toBeCloseTo(1.08, 2);
  });

  it("reads 214154 open, at 4.9× — 49.3 m against a 10.1 m pack, six seconds later", () => {
    const m = measureSnapshot(bySnapshot("20261002-214154"), SECOND_OVAL);

    expect(table(m)).toEqual({ follow: 8, gap: 49.3, pack: 10.1, n: 18, ratio: 4.9 });
    expect(m.ratio).toBeCloseTo(4.88, 2);
  });

  it("reads 214207 at 7.4× — the double-file re-form at one to go, the transient the dwell exists to swallow", () => {
    // The pack itself is mid re-form: 10.2–15.7 m between cars, median 12.7.
    const m = measureSnapshot(bySnapshot("20261002-214207"), SECOND_OVAL);

    expect(table(m)).toEqual({ follow: 12, gap: 93.6, pack: 12.7, n: 17, ratio: 7.4 });
    expect(m.ratio).toBeCloseTo(7.37, 2);
  });

  it("reads 214216 at 1.9× — between the clear and the raise multiple, 8.6 s after the re-form", () => {
    const m = measureSnapshot(bySnapshot("20261002-214216"), SECOND_OVAL);

    expect(table(m)).toEqual({ follow: 12, gap: 20.3, pack: 10.7, n: 17, ratio: 1.9 });
    expect(m.ratio).toBeCloseTo(1.91, 2);
  });

  it("pins that CarDistAhead in 214216 names the other-lane car, 13.0 m up, not the car to follow at 20.3 m", () => {
    const tick = bySnapshot("20261002-214216");
    const telemetry = widened(tick);
    const m = measureSnapshot(tick, SECOND_OVAL);

    expect(tick.CarDistAhead).toBeCloseTo(13.02, 2);
    expect(forwardGapMeters(telemetry, PLAYER, 8, SECOND_OVAL)).toBeCloseTo(tick.CarDistAhead as number, 1);
    expect([tick.CarIdxPaceLine[PLAYER], tick.CarIdxPaceLine[8]]).toEqual([1, 0]);
    expect(m.followCarIdx).toBe(12);
    expect(m.gapMeters).toBeCloseTo(20.35, 2);
  });

  it("separates the cases at the same multiples as Homestead — nothing normal above 1.3×, nothing lagging below 3.4×", () => {
    const ratios = ticks.map((tick) => measureSnapshot(tick, SECOND_OVAL).ratio as number);

    expect(ratios.filter((ratio) => ratio < 1.3)).toHaveLength(1); // 214148
    expect(ratios.filter((ratio) => ratio > 3.4)).toHaveLength(2); // 214154, 214207
    expect(ratios.filter((ratio) => ratio >= 1.3 && ratio <= 3.4)).toHaveLength(1); // 214216, closing up
  });

  it("differs from the issue comment's pack spacings by exactly the player's own pair, which that computation left in", () => {
    // The comment gives 10.3, 10.1, 12.8 and 10.7 m. The measurement leaves
    // the player's own pair out of the pool — it is the thing being judged —
    // and reads 10.2, 10.1, 12.7 and 10.7. Putting that one pair back
    // reproduces the comment's four figures, so the data agree and the rule
    // is the whole difference. Only 214207's ratio moves a decimal: 7.4× here
    // against 7.3× there.
    const withPlayersPair = ticks.map((tick) => {
      const telemetry = widened(tick);
      const gaps: number[] = [];

      for (let carIdx = 0; carIdx < 20; carIdx++) {
        const ahead = resolveCarAheadInLine(
          telemetry.CarIdxPaceLine as number[],
          telemetry.CarIdxPaceRow as number[],
          carIdx,
          () => true,
        );

        if (ahead !== null && ahead !== PACE)
          gaps.push(forwardGapMeters(telemetry, carIdx, ahead, SECOND_OVAL) as number);
      }

      gaps.sort((a, b) => a - b);

      const mid = gaps.length >> 1;

      return gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
    });

    expect(withPlayersPair.map((spacing) => Math.round(spacing * 10) / 10)).toEqual([10.3, 10.1, 12.8, 10.7]);
    expect(ticks.map((tick) => table(measureSnapshot(tick, SECOND_OVAL)).pack)).toEqual([10.2, 10.1, 12.7, 10.7]);
  });
});
