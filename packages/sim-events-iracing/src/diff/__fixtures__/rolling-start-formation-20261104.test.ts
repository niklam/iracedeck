/**
 * The 2026-11-04 road-course formation (issue #1550): iRacing's on-screen
 * instruction named a car further up the line ("Catch up 69") and then the car
 * ahead again ("11"), and the engineer said nothing. Replayed through the real
 * diff, this file shows why that silence is right: iRacing's published lineup
 * never changed the player's car ahead — not when two cars behind him left,
 * and not when an AI car passed another on track while the slots stayed put.
 */
import { Flags, hasFlag, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../../state.js";
import { resolvePaceLineup } from "../pace-lineup.js";
import { diffRollingStart } from "../rolling-start.js";
import type { PendingEvent } from "../types.js";

type FixtureTick = {
  t: number;
  SessionFlags: number;
  SessionState: number;
  PaceMode: number;
  CarIdxPaceLine: number[];
  CarIdxPaceRow: number[];
  CarIdxLapDistPct: number[];
};

/** As committed: each per-car array split into rows of 11 slots, so prettier keeps it compact (README). */
type CommittedTick = Omit<FixtureTick, "CarIdxPaceLine" | "CarIdxPaceRow" | "CarIdxLapDistPct"> & {
  CarIdxPaceLine: number[][];
  CarIdxPaceRow: number[][];
  CarIdxLapDistPct: number[][];
};

type Driver = { CarIdx: number; CarNumber: string; CarIsPaceCar: number; CarIsAI: number };

type Fixture = {
  sessionInfo: {
    WeekendInfo: {
      Category: string;
      TrackType: string;
      TrackLength: string;
      WeekendOptions: { StandingStart: number };
    };
    SessionInfo: { Sessions: Array<{ SessionNum: number; SessionType: string }> };
    DriverInfo: { DriverCarIdx: number; PaceCarIdx: number; Drivers: Driver[] };
  };
  ticks: CommittedTick[];
};

const fixture = JSON.parse(
  readFileSync(new URL("./rolling-start-formation-20261104.json", import.meta.url), "utf-8"),
) as Fixture;
const { sessionInfo } = fixture;

/** The ticks with their per-car arrays joined back into one slot per car. */
const ticks: FixtureTick[] = fixture.ticks.map((tick) => ({
  ...tick,
  CarIdxPaceLine: tick.CarIdxPaceLine.flat(),
  CarIdxPaceRow: tick.CarIdxPaceRow.flat(),
  CarIdxLapDistPct: tick.CarIdxLapDistPct.flat(),
}));

/** The pace car is RAW car index 64, kept as slot 31 (README) — cars 0–30 sit at their own indices. */
const PACE_SLOT = 31;
const PACE_CAR_IDX = 64;
const PLAYER = 0; // car "64", line 1 row 12
const AHEAD = 30; // car "11", line 1 row 11
const CAR_69 = 6; // line 1 row 8: the car the on-screen prompt named at 127.68 s
const ROW_10 = 11; // car "86", line 1 row 10: the positive control's swap partner

/** The track length in metres, from the session's own `TrackLength` ("5.4135 km"). */
const TRACK_M = Number.parseFloat(sessionInfo.WeekendInfo.TrackLength) * 1000;

const at = (t: number): FixtureTick => {
  const tick = ticks.find((candidate) => candidate.t === t);

  if (!tick) throw new Error(`no fixture tick at t=${t}`);

  return tick;
};

/** A trimmed per-car array back at real telemetry width — fixture slot 31 is the pace car, raw index 64. */
function widen(values: number[]): number[] {
  const out = new Array<number>(72).fill(-1);

  values.forEach((value, slot) => (out[slot === PACE_SLOT ? PACE_CAR_IDX : slot] = value));

  return out;
}

/**
 * What the diff and the lineup reader read of a fixture tick. No track
 * surfaces: in this capture a car's surface reads `NotInWorld` on exactly the
 * ticks its lap progress reads −1 (README), so the in-world predicate gives
 * the same answer from the lap progress alone.
 */
function telemetryOf(tick: FixtureTick): TelemetryData {
  return {
    SessionFlags: tick.SessionFlags,
    SessionState: tick.SessionState,
    PaceMode: tick.PaceMode,
    CarIdxPaceLine: widen(tick.CarIdxPaceLine),
    CarIdxPaceRow: widen(tick.CarIdxPaceRow),
    CarIdxLapDistPct: widen(tick.CarIdxLapDistPct),
  } as unknown as TelemetryData;
}

type Replayed = { t: number; events: PendingEvent[]; formationOpen: boolean; followCarIdx: number | null };

/** Every tick through `diffRollingStart` with one fresh translator state, as the translator runs it. */
function replay(source: FixtureTick[]): Replayed[] {
  const state = createInitialState();
  const info = sessionInfo as unknown as Record<string, unknown>;

  return source.map((tick) => {
    const events: PendingEvent[] = [];

    diffRollingStart(state, telemetryOf(tick), info, (event) => events.push(event));

    return {
      t: tick.t,
      events,
      formationOpen: state.rollingStartFormationId !== null,
      followCarIdx: state.rollingStartFollowCarIdx,
    };
  });
}

const lineupAt = (tick: FixtureTick) =>
  resolvePaceLineup(telemetryOf(tick), sessionInfo as unknown as Record<string, unknown>, false);

/** How far `carIdx` runs ahead of `behindIdx` on the lap, in metres (negative when it is behind). */
function metresAhead(tick: FixtureTick, carIdx: number, behindIdx: number): number {
  const delta = tick.CarIdxLapDistPct[carIdx] - tick.CarIdxLapDistPct[behindIdx];

  return ((((delta % 1) + 1.5) % 1) - 0.5) * TRACK_M;
}

const slotOf = (tick: FixtureTick, carIdx: number): string =>
  `${tick.CarIdxPaceLine[carIdx]}/${tick.CarIdxPaceRow[carIdx]}`;

const parade = ticks.filter((tick) => tick.SessionState === SessionState.ParadeLaps);
const formation = parade.filter((tick) => !hasFlag(tick.SessionFlags, Flags.GreenHeld));

describe("the 2026-11-04 road-course formation fixture (#1550)", () => {
  it("is a rolling double-file start on a road course, the player car 64 and the pace car raw index 64", () => {
    expect(sessionInfo.WeekendInfo.Category).toBe("SportsCar");
    expect(sessionInfo.WeekendInfo.TrackType).toBe("road course");
    expect(sessionInfo.WeekendInfo.WeekendOptions.StandingStart).toBe(0);
    expect(sessionInfo.SessionInfo.Sessions).toEqual([{ SessionNum: 0, SessionType: "Race" }]);
    expect([...new Set(ticks.map((tick) => tick.PaceMode))]).toEqual([1]); // DoubleFileStart
    expect(sessionInfo.DriverInfo.DriverCarIdx).toBe(PLAYER);
    expect(sessionInfo.DriverInfo.PaceCarIdx).toBe(PACE_CAR_IDX);

    const number = (carIdx: number): string | undefined =>
      sessionInfo.DriverInfo.Drivers.find((driver) => driver.CarIdx === carIdx)?.CarNumber;

    expect([number(PLAYER), number(AHEAD), number(CAR_69), number(ROW_10)]).toEqual(["64", "11", "69", "86"]);
    expect(ticks.every((tick) => tick.CarIdxPaceRow[PACE_SLOT] === -1)).toBe(true);
  });

  it("runs from Warmup through the formation to the green and six seconds of the unwind", () => {
    expect(ticks).toHaveLength(160);
    expect(ticks[0]).toMatchObject({ t: 74.77, SessionState: SessionState.Warmup });
    expect(parade[0].t).toBe(83.88);
    expect(parade.at(-1)?.t).toBe(216.22);
    expect(parade).toHaveLength(148);
    expect(formation.at(-1)?.t).toBe(192.33);
    expect(hasFlag(at(192.35).SessionFlags, Flags.GreenHeld)).toBe(true);
    expect(at(216.23).SessionState).toBe(SessionState.Racing);
    expect(ticks.at(-1)?.t).toBe(222);
  });

  it("opens the formation on the ParadeLaps entry and closes it at the GreenHeld edge", () => {
    const replayed = replay(ticks);
    const edges = replayed.flatMap((tick, i) =>
      i === 0 || tick.formationOpen !== replayed[i - 1].formationOpen ? [[tick.t, tick.formationOpen]] : [],
    );

    expect(edges).toEqual([
      [74.77, false],
      [83.88, true],
      [192.35, false],
    ]);
    // The cue fires once, on the entry tick, and nothing else fires anywhere.
    expect(replayed.flatMap((tick) => tick.events.map((event) => [tick.t, event.event]))).toEqual([
      [83.88, "rollingStart.pace-car-moving.raised"],
    ]);
  });

  it("names car 11 (idx 30) as the car to follow on every ParadeLaps tick — both snapshot moments included", () => {
    for (const tick of parade) {
      const lineup = lineupAt(tick);

      expect({ t: tick.t, follow: lineup?.followCarIdx, number: lineup?.followCarNumber }).toEqual({
        t: tick.t,
        follow: AHEAD,
        number: "11",
      });
    }

    // 127.68 s: iRacing's UI said "Catch up 69". 135.55 s: it said "11" again.
    for (const t of [127.68, 135.55]) {
      expect(lineupAt(at(t))?.followCarIdx).toBe(AHEAD);
      expect([slotOf(at(t), PLAYER), slotOf(at(t), AHEAD), slotOf(at(t), CAR_69)]).toEqual(["1/12", "1/11", "1/8"]);
    }

    // The diff holds the same car for the whole formation.
    const held = replay(ticks).filter((tick) => tick.formationOpen);

    expect(held).toHaveLength(formation.length);
    expect(held.every((tick) => tick.followCarIdx === AHEAD)).toBe(true);
  });

  it("never emits rollingStart.lineup.changed across the whole fixture", () => {
    const changed = replay(ticks).filter((tick) =>
      tick.events.some((event) => event.event === "rollingStart.lineup.changed"),
    );

    expect(changed.map((tick) => tick.t)).toEqual([]);
  });

  it("has exactly two slot changes in ParadeLaps, both cars leaving from behind the player", () => {
    const changes = parade.slice(1).flatMap((tick, i) => {
      const before = parade[i];

      return Array.from({ length: PACE_SLOT + 1 }, (_, carIdx) => carIdx)
        .filter((carIdx) => slotOf(before, carIdx) !== slotOf(tick, carIdx))
        .map((carIdx) => [tick.t, carIdx, slotOf(before, carIdx), slotOf(tick, carIdx)]);
    });

    expect(changes).toEqual([
      [119.02, 12, "1/14", "-1/-1"], // two rows behind the player, in his own line
      [119.3, 13, "0/15", "-1/-1"], // the other line, three rows back
    ]);
    // Car 13 leaves the world a tick before its row clears — the ghost row the
    // reader's in-world filter exists for — and car 12 after.
    expect(at(119.25).CarIdxLapDistPct[13]).toBe(-1);
    expect(at(119.25).CarIdxPaceRow[13]).toBe(15);
    expect(at(119.02).CarIdxLapDistPct[12]).toBeGreaterThan(0);
    expect(at(119.08).CarIdxLapDistPct[12]).toBe(-1);

    // The player's follow car either side of both.
    for (const t of [119, 119.02, 119.25, 119.28, 119.3]) expect(lineupAt(at(t))?.followCarIdx).toBe(AHEAD);
  });

  it("carries an AI pass the slots never reflect: line 1 row 6 ahead of row 5 by up to 61 m", () => {
    // Line 1 row 5 is idx 26, row 6 is idx 4, on every ParadeLaps tick.
    expect(parade.every((tick) => slotOf(tick, 26) === "1/5" && slotOf(tick, 4) === "1/6")).toBe(true);

    const inverted = parade.filter((tick) => metresAhead(tick, 4, 26) > 0);
    const widest = Math.max(...inverted.map((tick) => metresAhead(tick, 4, 26)));

    expect(inverted[0].t).toBe(116.4);
    expect(inverted.at(-1)?.t).toBe(152.48);
    expect(metresAhead(at(116), 4, 26)).toBeLessThan(0);
    expect(widest).toBeGreaterThan(60);
    expect(widest).toBeLessThan(62);
    // Both snapshot moments fall inside it.
    expect(metresAhead(at(127.68), 4, 26)).toBeGreaterThan(30);
    expect(metresAhead(at(135.55), 4, 26)).toBeGreaterThan(20);
  });
});

describe("the positive control: a changed slot IS reported", () => {
  /** Idx 30 and the car at line 1 row 10 trade rows from 150 s on — the car ahead becomes car 86. */
  const swapped = ticks.map((tick) => {
    if (tick.t < 150 || tick.SessionState !== SessionState.ParadeLaps) return tick;

    const rows = [...tick.CarIdxPaceRow];

    [rows[AHEAD], rows[ROW_10]] = [rows[ROW_10], rows[AHEAD]];

    return { ...tick, CarIdxPaceRow: rows };
  });

  it("emits rollingStart.lineup.changed once, on the tick the slots change", () => {
    expect([at(150).CarIdxPaceRow[AHEAD], at(150).CarIdxPaceRow[ROW_10]]).toEqual([11, 10]);

    const replayed = replay(swapped);
    const changed = replayed.filter((tick) =>
      tick.events.some((event) => event.event === "rollingStart.lineup.changed"),
    );

    expect(changed.map((tick) => tick.t)).toEqual([150]);
    expect(replayed.find((tick) => tick.t === 150)?.followCarIdx).toBe(ROW_10);
    expect(lineupAt(swapped.find((tick) => tick.t === 150)!)?.followCarNumber).toBe("86");
  });
});
