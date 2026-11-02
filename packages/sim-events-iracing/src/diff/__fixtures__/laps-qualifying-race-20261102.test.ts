import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../../state.js";
import { diffLaps, type FastestLapJudge, type LapSessionType } from "../laps.js";
import type { PendingEvent } from "../types.js";

type FixtureTick = {
  t: number;
  SessionNum: number;
  LapCompleted: number;
  LapLastLapTime: number;
  LapBestLap: number;
  LapBestLapTime: number;
  LapDeltaToBestLap_OK: boolean;
  LapDeltaToSessionBestLap_OK: boolean;
  LapDeltaToSessionOptimalLap_OK: boolean;
  LapDeltaToSessionLastlLap_OK: boolean;
  CarIdxLastLapTime: number[];
};

const ticks = JSON.parse(
  readFileSync(new URL("./laps-qualifying-race-20261102.json", import.meta.url), "utf-8"),
) as FixtureTick[];

/** The capture's sessions: 1 qualifying, 2 the race. */
const SESSION_TYPES: Record<number, LapSessionType> = { 1: "qualifying", 2: "race" };

/** The replay's tick step (ms): each record is held until the next, as the watch records only changes. */
const STEP_MS = 50;

type Lap = Extract<PendingEvent, { event: "lap.completed" }>;

/**
 * Replay the capture through one `diffLaps` state at {@link STEP_MS}, each
 * record held until the next within its session and for 10 s past the last,
 * with standings always synced and a judge that records what it is asked.
 * `t` is the session's own clock, so it restarts at the session change.
 */
function replay(): { laps: Lap[]; judged: Array<[number, number]> } {
  const state = createInitialState();
  const events: PendingEvent[] = [];
  const judged: Array<[number, number]> = [];
  const judge: FastestLapJudge = (lap, lapTime) => {
    judged.push([lap, lapTime]);

    return false;
  };

  ticks.forEach((tick, i) => {
    const next = ticks[i + 1];
    const until = next !== undefined && next.SessionNum === tick.SessionNum ? next.t * 1000 : tick.t * 1000 + 10_000;

    for (let now = tick.t * 1000; now === tick.t * 1000 || now < until; now += STEP_MS) {
      diffLaps(
        state,
        tick as unknown as TelemetryData,
        SESSION_TYPES[tick.SessionNum],
        false,
        { lapsComplete: 9999, position: 1, classPosition: 0 },
        now,
        (e) => events.push(e),
        judge,
      );
    }
  });

  return { laps: events.filter((e): e is Lap => e.event === "lap.completed"), judged };
}

const verdicts = (laps: Lap[]): unknown[] =>
  laps.map((e) => [e.data.lap, e.data.lapIsValid, e.data.lapTime, e.data.isBest, e.data.isFirstValid]);

describe("the 2026-11-02 qualifying and race lap capture fixture (issue #1582)", () => {
  it("holds sessions 1 and 2, and iRacing writes -1 for both cut laps, the race's with every flag true", () => {
    expect([...new Set(ticks.map((tick) => tick.SessionNum))]).toEqual([1, 2]);

    const refused = ticks.filter(
      (tick, i) => i > 0 && tick.LapLastLapTime === -1 && ticks[i - 1]!.LapLastLapTime !== -1,
    );
    expect(refused.map((tick) => [tick.SessionNum, tick.LapCompleted, tick.CarIdxLastLapTime[0]])).toEqual([
      [1, 1, -1],
      [2, 4, -1],
    ]);
    expect(refused[1]).toMatchObject({
      LapDeltaToBestLap_OK: true,
      LapDeltaToSessionBestLap_OK: true,
      LapDeltaToSessionOptimalLap_OK: true,
      LapDeltaToSessionLastlLap_OK: true,
    });
  });

  it("times the race start lap but takes no best for it", () => {
    const start = ticks.find((tick) => tick.SessionNum === 2 && tick.LapCompleted === 1 && tick.LapLastLapTime > 0)!;

    expect(start).toMatchObject({ LapLastLapTime: 82.2029037475586, LapBestLap: -1, LapBestLapTime: -1 });
  });

  it("replays qualifying as lap 1 refused, then laps 2 and 3 counted bests, lap 2 the first", () => {
    const { laps } = replay();
    const qualifying = laps.filter((e) => e.data.sessionType === "qualifying");

    expect(verdicts(qualifying)).toEqual([
      [1, false, undefined, false, false],
      [2, undefined, 75.46730041503906, true, true],
      [3, undefined, 74.58599853515625, true, false],
    ]);
    expect("lapTime" in qualifying[0]!.data).toBe(false);
    expect(qualifying[0]!.data.bestLapTime).toBeUndefined();
    expect(qualifying[2]!.data.previousBestLapTime).toBe(75.46730041503906);
  });

  it("replays the race as lap 1 counted but no best, lap 2 the first best, lap 3 a best and lap 4 refused", () => {
    const { laps, judged } = replay();
    const race = laps.filter((e) => e.data.sessionType === "race");

    expect(verdicts(race)).toEqual([
      [1, undefined, 82.2029037475586, false, false],
      [2, undefined, 76.19850158691406, true, true],
      [3, undefined, 75.09130096435547, true, false],
      [4, false, undefined, false, false],
    ]);
    expect(race[0]!.data.bestLapTime).toBeUndefined();
    expect(race[3]!.data).toMatchObject({ bestLapTime: 75.09130096435547, previousBestLapTime: 75.09130096435547 });
    // Seven laps in all: the resets to the pits after qualifying's lap 3 and the race's lap 4 emit nothing.
    expect(laps).toHaveLength(7);
    // The judge is asked of the counted bests only: never the race start lap, never a refused lap.
    expect(judged).toEqual([
      [2, 75.46730041503906],
      [3, 74.58599853515625],
      [2, 76.19850158691406],
      [3, 75.09130096435547],
    ]);
  });
});
