import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type FixtureTick = {
  t: number;
  SessionFlags: number;
  SessionState: number;
  PaceMode: number;
  PitsOpen: boolean;
  OnPitRoad: boolean;
  Lap: number;
  LapCompleted: number;
  CarIdxPaceLine: number[];
  CarIdxPaceRow: number[];
  CarIdxLapCompleted: number[];
  CarIdxTrackSurface: number[];
  CarIdxPosition: number[];
};

type Driver = { CarIdx: number; CarNumber: string; CarIsPaceCar: number; CarIsAI: number };

type Fixture = {
  sessionInfo: {
    WeekendInfo: { Category: string; WeekendOptions: { StartingGrid: string; StandingStart: number } };
    SessionInfo: { Sessions: Array<{ SessionNum: number; SessionType: string }> };
    QualifyResultsInfo: { Results: Array<{ Position: number; CarIdx: number }> };
    DriverInfo: { DriverCarIdx: number; PaceCarIdx: number; Drivers: Driver[] };
  };
  ticks: FixtureTick[];
};

const { sessionInfo, ticks } = JSON.parse(
  readFileSync(new URL("./rolling-start-formation-20260917.json", import.meta.url), "utf-8"),
) as Fixture;

/** The pace car is RAW car index 64, kept as slot 20 (README) — cars 0–19 sit at their own indices. */
const PACE = 20;
const PLAYER = 0;

/** `SessionState.Racing`: every tick below it is before the green. */
const RACING = 4;

const at = (t: number): FixtureTick => {
  const tick = ticks.find((candidate) => candidate.t === t);

  if (!tick) throw new Error(`no fixture tick at t=${t}`);

  return tick;
};

/** Each lined-up car as `carIdx:line/row`, pace car excluded. */
const lineup = (tick: FixtureTick): string[] =>
  tick.CarIdxPaceRow.flatMap((row, carIdx) =>
    carIdx !== PACE && row >= 0 ? [`${carIdx}:${tick.CarIdxPaceLine[carIdx]}/${row}`] : [],
  );

/** Position by car: the order the rows give when sorted by row, then line. */
const rowLineOrder = (tick: FixtureTick): number[] => {
  const order = Array.from({ length: 20 }, (_, carIdx) => carIdx).sort(
    (a, b) => tick.CarIdxPaceRow[a] - tick.CarIdxPaceRow[b] || tick.CarIdxPaceLine[a] - tick.CarIdxPaceLine[b],
  );
  const positions = new Array<number>(20).fill(0);

  order.forEach((carIdx, place) => (positions[carIdx] = place + 1));

  return positions;
};

describe("the 2026-09-17 rolling-start formation fixture", () => {
  it("runs from the first GetInCar record to the end of the unwind", () => {
    expect(ticks).toHaveLength(60);
    expect(ticks[0].t).toBe(107.38);
    expect(ticks.at(-1)?.t).toBe(206.8);
    expect(ticks.filter((tick) => tick.SessionState < RACING)).toHaveLength(29);
  });

  it("carries the formation's phases and flags, in order", () => {
    const phases: Array<[t: number, state: number, flags: number]> = [];

    for (const tick of ticks) {
      const last = phases.at(-1);
      const flags = tick.SessionFlags >>> 0;

      if (!last || last[1] !== tick.SessionState || last[2] !== flags) phases.push([tick.t, tick.SessionState, flags]);
    }

    expect(phases).toEqual([
      [107.38, 1, 0x10000200], // GetInCar — OneLapToGreen | StartHidden, from the first record
      [114.22, 1, 0x10040200], // + Servicible
      [116.08, 2, 0x20040200], // Warmup — StartReady
      [126.67, 3, 0x20040200], // ParadeLaps — the pace car moves
      [186.28, 3, 0x20040600], // + GreenHeld, 14.9 s before the green
      [201.18, 4, 0x80040604], // Racing — Green | StartGo
      [201.28, 4, 0x80040004], // OneLapToGreen and GreenHeld drop one tick later
      [206.18, 4, 0x10040004], // StartHidden
    ]);
  });

  it("is a double-file rolling start by its pace mode, whatever the weekend options say", () => {
    // Spec finding 6: `StartingGrid` read "single file" while the formation
    // ran two lines, so no start setting says what shape it is.
    expect([...new Set(ticks.map((tick) => tick.PaceMode))]).toEqual([1]); // DoubleFileStart
    expect(sessionInfo.WeekendInfo.WeekendOptions.StartingGrid).toBe("single file");
    expect(sessionInfo.WeekendInfo.WeekendOptions.StandingStart).toBe(0);
    expect(sessionInfo.WeekendInfo.Category).toBe("Oval");
    expect(sessionInfo.SessionInfo.Sessions).toEqual([{ SessionNum: 0, SessionType: "Race" }]);
  });

  it("holds one lineup from the first record until 2.7 s after the green — 20 cars, rows 0–9 on lines 0 and 1", () => {
    const first = lineup(ticks[0]);
    const unchanged = ticks.filter((tick) => JSON.stringify(lineup(tick)) === JSON.stringify(first));
    const rowsOn = (line: number): number[] =>
      ticks[0].CarIdxPaceRow.filter((_, carIdx) => carIdx !== PACE && ticks[0].CarIdxPaceLine[carIdx] === line).sort(
        (a, b) => a - b,
      );

    expect(first).toHaveLength(20);
    expect(rowsOn(0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rowsOn(1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Every tick up to and including 203.85 — the 29 before the green and five after it.
    expect(unchanged).toHaveLength(34);
    expect(unchanged.at(-1)?.t).toBe(203.85);
    expect(ticks[unchanged.length].t).toBe(203.87);
  });

  it("never gives the pace car a row, and keeps its trip onto the road and back", () => {
    const surfaces: Array<[t: number, surface: number]> = [];

    for (const tick of ticks) {
      if (surfaces.at(-1)?.[1] !== tick.CarIdxTrackSurface[PACE])
        surfaces.push([tick.t, tick.CarIdxTrackSurface[PACE]]);
    }

    expect(ticks.every((tick) => tick.CarIdxPaceLine[PACE] === -1 && tick.CarIdxPaceRow[PACE] === -1)).toBe(true);
    expect(surfaces).toEqual([
      [107.38, 2], // AproachingPits, where the field was gridded
      [132.35, 3], // OnTrack
      [196.53, 2], // back, 4.65 s before the green
    ]);
    // One pace lap, never completed: the pace car crossed no line.
    expect(ticks.every((tick) => tick.CarIdxLapCompleted[PACE] === -1)).toBe(true);
  });

  it("names the cars the reader's tests name: the player behind 07, with 96 on pole and 37 alongside", () => {
    const number = (carIdx: number): string | undefined =>
      sessionInfo.DriverInfo.Drivers.find((driver) => driver.CarIdx === carIdx)?.CarNumber;
    const slot = (carIdx: number): number[] => [ticks[0].CarIdxPaceLine[carIdx], ticks[0].CarIdxPaceRow[carIdx]];

    expect(sessionInfo.DriverInfo.DriverCarIdx).toBe(PLAYER);
    expect(sessionInfo.DriverInfo.PaceCarIdx).toBe(64);
    expect(sessionInfo.DriverInfo.Drivers.filter((driver) => driver.CarIsPaceCar === 1).map((d) => d.CarIdx)).toEqual([
      64,
    ]);
    expect([number(PLAYER), slot(PLAYER)]).toEqual(["64", [0, 5]]);
    expect([number(9), slot(9)]).toEqual(["07", [0, 4]]);
    expect([number(17), slot(17)]).toEqual(["96", [0, 0]]);
    expect([number(16), slot(16)]).toEqual(["37", [1, 0]]);
    expect([number(18), slot(18)]).toEqual(["18", [0, 1]]);
  });

  it("has the player holding a row before he is in the world", () => {
    // Spec finding 8: at 107.38 the player's surface is NotInWorld (−1) and
    // his row is already line 0 row 5. He rolls onto the track at 138.87.
    expect(ticks[0].CarIdxTrackSurface[PLAYER]).toBe(-1);
    expect(at(113.05).CarIdxTrackSurface[PLAYER]).toBe(2);
    expect(at(138.87).CarIdxTrackSurface[PLAYER]).toBe(3);
  });

  it("publishes no official position until 203.22 s, and then the (row, line) order — which is the qualifying grid", () => {
    const published = ticks.filter((tick) => tick.CarIdxPosition.slice(0, 20).some((position) => position !== 0));
    const qualifying = new Array<number>(20).fill(0);

    for (const result of sessionInfo.QualifyResultsInfo.Results) qualifying[result.CarIdx] = result.Position + 1;

    expect(published[0].t).toBe(203.22);
    expect(published[0].CarIdxPosition.slice(0, 20)).toEqual(rowLineOrder(ticks[0]));
    expect(qualifying).toEqual(rowLineOrder(ticks[0]));
    expect(rowLineOrder(ticks[0])[PLAYER]).toBe(11);
  });

  it("unwinds under green with the formation's own shape — the grid's third car at line 0 row 0", () => {
    // Spec finding 3: the pace car unplaced and the rows starting at 0 is not
    // a formation. Car 17 has gone; car 18, third on the grid, heads line 0.
    const unwind = at(203.87);

    expect(unwind.SessionState).toBe(RACING);
    expect(lineup(unwind)).toHaveLength(19);
    expect(unwind.CarIdxPaceRow[17]).toBe(-1);
    expect([unwind.CarIdxPaceLine[18], unwind.CarIdxPaceRow[18]]).toEqual([0, 0]);
    expect([unwind.CarIdxPaceLine[16], unwind.CarIdxPaceRow[16]]).toEqual([1, 0]);
    expect(rowLineOrder(ticks[0])[18]).toBe(3);
    // It runs down to nobody: the last tick has no lineup at all.
    expect(lineup(at(206.8))).toEqual([]);
  });

  it("carries no per-car lap progress — the watch recorded none", () => {
    // What the reader's in-world filter relies on here, as #1127's fixtures
    // do: with no `CarIdxLapDistPct` every car counts as present. It is also
    // why this fixture cannot exercise the pace-lap diff.
    expect(ticks.every((tick) => !("CarIdxLapDistPct" in tick))).toBe(true);
  });
});
