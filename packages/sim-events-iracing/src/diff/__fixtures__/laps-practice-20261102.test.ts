import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../../state.js";
import { diffLaps, type FastestLapJudge } from "../laps.js";
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
  OnPitRoad: boolean;
};

const ticks = JSON.parse(
  readFileSync(new URL("./laps-practice-20261102.json", import.meta.url), "utf-8"),
) as FixtureTick[];

/** The replay's tick step (ms): each record is held until the next, as the watch records only changes. */
const STEP_MS = 50;

/**
 * Replay the capture through `diffLaps` at {@link STEP_MS}, each record held
 * until the next and for 10 s past the last, with standings always synced and
 * a judge that records what it is asked.
 */
function replay(): { laps: Array<Extract<PendingEvent, { event: "lap.completed" }>>; judged: number[] } {
  const state = createInitialState();
  const events: PendingEvent[] = [];
  const judged: number[] = [];
  const judge: FastestLapJudge = (lap) => {
    judged.push(lap);

    return false;
  };

  ticks.forEach((tick, i) => {
    const until = i + 1 < ticks.length ? ticks[i + 1]!.t * 1000 : tick.t * 1000 + 10_000;

    for (let now = tick.t * 1000; now === tick.t * 1000 || now < until; now += STEP_MS) {
      diffLaps(
        state,
        tick as unknown as TelemetryData,
        "practice",
        false,
        { lapsComplete: 9999, position: 1, classPosition: 0 },
        now,
        (e) => events.push(e),
        judge,
      );
    }
  });

  return {
    laps: events.filter((e): e is Extract<PendingEvent, { event: "lap.completed" }> => e.event === "lap.completed"),
    judged,
  };
}

describe("the 2026-11-02 practice lap capture fixture (issue #1582)", () => {
  it("is one session, the player at slot 0, iRacing's best moving on the tick the lap time refreshes", () => {
    expect(new Set(ticks.map((tick) => tick.SessionNum))).toEqual(new Set([0]));

    // Every tick the lap time changed to a positive value carries the best that lap left.
    const refreshes = ticks.filter((tick, i) => i > 0 && tick.LapLastLapTime !== ticks[i - 1]!.LapLastLapTime);
    expect(refreshes.map((tick) => [tick.LapCompleted, tick.LapBestLap])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 4],
      [6, 4],
      [7, 7],
    ]);
  });

  it("reads every LapDeltaTo*_OK flag false on the lap 5 crossing, made on pit road", () => {
    const crossing = ticks.find((tick) => tick.LapCompleted === 5)!;

    expect(crossing).toMatchObject({
      OnPitRoad: true,
      LapDeltaToBestLap_OK: false,
      LapDeltaToSessionBestLap_OK: false,
      LapDeltaToSessionOptimalLap_OK: false,
      LapDeltaToSessionLastlLap_OK: false,
    });
  });

  it("replays through diffLaps as seven counted laps, isBest exactly on laps 1, 2, 3, 4 and 7", () => {
    const { laps, judged } = replay();

    expect(laps.map((e) => [e.data.lap, e.data.lapIsValid, e.data.isBest, e.data.isFirstValid])).toEqual([
      [1, undefined, true, true],
      [2, undefined, true, false],
      [3, undefined, true, false],
      [4, undefined, true, false],
      [5, undefined, false, false],
      [6, undefined, false, false],
      [7, undefined, true, false],
    ]);
    expect(laps.map((e) => e.data.lapTime)).toEqual([
      83.2968978881836,
      81.7843017578125,
      77.29340362548828,
      75.63140106201172,
      91.21399688720703,
      106.4489974975586,
      74.7771987915039,
    ]);
    // The lap crossed on pit road counts: it is the in lap, and the next the out lap.
    expect(laps[4]!.data).toMatchObject({ isInLap: true, bestLapTime: 75.63140106201172 });
    expect(laps[5]!.data).toMatchObject({ isOutLap: true });
    // The judge is asked of the bests only, and the reset to the pits after lap 7 emits nothing.
    expect(judged).toEqual([1, 2, 3, 4, 7]);
  });
});
