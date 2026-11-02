/**
 * Unit tests for the lap-completion diff (issue #555).
 *
 * Pins:
 *   - first-tick seeding (no fire on connect mid-session)
 *   - regular non-best lap completion fires with isBest=false
 *   - new personal best with a prior best fires with isBest=true,
 *     previousBestLapTime set — iRacing's best (`LapBestLap` naming the lap,
 *     issue #1582), set on the same tick as `LapLastLapTime` as it is there
 *   - first valid lap (no prior best) fires with isFirstValid=true and
 *     isBest=true
 *   - a refused lap (`LapLastLapTime` -1) fires in the refused shape (#1582)
 *   - pace laps (LapCompleted=-1) are suppressed
 *   - LapLastLapTime=0 at increment defers emission to the next tick
 *   - sessionType / lapsRemaining / timeRemaining pass through; the
 *     unlimited sentinels and negatives omit their field, 0 is kept (#1220)
 *   - sentinel session-info-absent (undefined sessionType) omits the field
 *   - session reset (LapCompleted decreases) does not synthesize an event
 */
import { Flags, IRSDK_UNLIMITED_LAPS, IRSDK_UNLIMITED_TIME, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { createInitialState } from "../state.js";
import {
  type FastestLapJudge,
  LAP_RESULTS_SYNC_MAX_WAIT_MS,
  LAP_TIME_REFRESH_ALLOWANCE_MS,
  type LapSessionType,
  type PlayerResultsForLap,
  diffLaps as runDiffLaps,
} from "./laps.js";
import type { PendingEvent } from "./types.js";

/** The judge every test runs with unless it hands its own: no lap is ever the fastest of the race (#1571). */
const NEVER_A_RECORD: FastestLapJudge = () => false;

type DiffLapsArgs = Parameters<typeof runDiffLaps>;

/** `diffLaps` with the fastest-lap judge defaulted, so the tests that predate it read as they did. */
function diffLaps(
  state: DiffLapsArgs[0],
  telemetry: DiffLapsArgs[1],
  sessionType: DiffLapsArgs[2],
  isMultiClass: DiffLapsArgs[3],
  playerResults: DiffLapsArgs[4],
  now: DiffLapsArgs[5],
  emit: DiffLapsArgs[6],
  judge: FastestLapJudge = NEVER_A_RECORD,
): void {
  runDiffLaps(state, telemetry, sessionType, isMultiClass, playerResults, now, emit, judge);
}

function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    LapCompleted: 0,
    LapLastLapTime: 0,
    LapBestLapTime: 0,
    ...overrides,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

function lapEvents(events: PendingEvent[]): Array<Extract<PendingEvent, { event: "lap.completed" }>> {
  return events.filter((e): e is Extract<PendingEvent, { event: "lap.completed" }> => e.event === "lap.completed");
}

/**
 * Synthesise a `PlayerResultsForLap` that satisfies the diff's sync gate for
 * any `LapCompleted` value (issue #566). `lapsComplete: 9999` is well above
 * any value the tests use, so the gate (`lapsComplete >= lapCompleted`) is
 * always satisfied and the diff emits immediately. `position` defaults to
 * `0` so the lap-completion tests that don't care about position fields see
 * them omitted from the payload — same as the pre-#566 behavior.
 *
 * Tests that DO care about position pass an explicit `position` /
 * `classPosition1Indexed` (1-indexed, matching the public payload shape).
 * The helper converts to the raw 0-indexed `ResultsPositions` representation
 * the diff consumes.
 */
function synced(position: number = 0, classPosition1Indexed: number = position): PlayerResultsForLap {
  return {
    lapsComplete: 9999,
    position,
    classPosition: classPosition1Indexed > 0 ? classPosition1Indexed - 1 : -1,
  };
}

const NOW = 1_000_000;

describe("diffLaps — seeding", () => {
  it("does not emit on the first tick when connecting cleanly", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", null, synced(), NOW, emit);

    expect(lapEvents(events)).toHaveLength(0);
    expect(state.lapCompletedInitialized).toBe(true);
    expect(state.lastLapCompletedCounter).toBe(0);
    expect(state.lastLapBestLapTime).toBe(0);
  });

  it("does not emit on the first tick when connecting mid-session (existing best)", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(
      state,
      tick({ LapCompleted: 3, LapLastLapTime: 64.2, LapBestLapTime: 63.8 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );

    expect(lapEvents(events)).toHaveLength(0);
    expect(state.lastLapCompletedCounter).toBe(3);
    expect(state.lastLapBestLapTime).toBe(63.8);
  });
});

describe("diffLaps — regular lap (not best)", () => {
  it("emits one event with isBest=false when the lap is slower than the prior best", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    // Seed: lap 1 with PB=63.8.
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.8, LapBestLap: 1, LapBestLapTime: 63.8 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );
    // Lap 2 completed at 64.5 — slower, best stays put.
    diffLaps(
      state,
      tick({ LapCompleted: 2, LapLastLapTime: 64.5, LapBestLapTime: 63.8 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data).toMatchObject({
      lap: 2,
      lapTime: 64.5,
      isBest: false,
      isFirstValid: false,
      bestLapTime: 63.8,
      previousBestLapTime: 63.8,
      sessionType: "race",
    });
  });
});

describe("diffLaps — new personal best", () => {
  it("emits with isBest=true and the previous best when LapBestLapTime strictly improves", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 64.2, LapBestLap: 1, LapBestLapTime: 64.2 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ LapCompleted: 2, LapLastLapTime: 63.4, LapBestLap: 2, LapBestLapTime: 63.4 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data).toMatchObject({
      lap: 2,
      lapTime: 63.4,
      isBest: true,
      isFirstValid: false,
      bestLapTime: 63.4,
      previousBestLapTime: 64.2,
    });
  });

  it("preserves the prior-best baseline across intermediate ticks even when LapBestLapTime updates mid-lap", () => {
    // The baseline is iRacing's best as the emit before left it (issue
    // #1582), never a live reading: should the best ever move a tick or two
    // BEFORE `LapCompleted` increments (the 2026-11-02 captures never show
    // it), `previousBestLapTime` at the completion must still be the best
    // before this lap. This pins the frozen baseline.
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 64.2, LapBestLap: 1, LapBestLapTime: 64.2 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );
    expect(state.lastLapBestLapTime).toBe(64.2);

    // Intermediate ticks: iRacing publishes the new best ahead of the counter
    // bump. The baseline MUST NOT move on these ticks.
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 64.2, LapBestLap: 2, LapBestLapTime: 63.4 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );
    expect(state.lastLapBestLapTime).toBe(64.2);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 64.2, LapBestLap: 2, LapBestLapTime: 63.4 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );
    expect(state.lastLapBestLapTime).toBe(64.2);

    // Counter finally increments; lapLastLapTime now matches the already-
    // committed best.
    diffLaps(
      state,
      tick({ LapCompleted: 2, LapLastLapTime: 63.4, LapBestLap: 2, LapBestLapTime: 63.4 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data).toMatchObject({
      isBest: true,
      isFirstValid: false,
      bestLapTime: 63.4,
      previousBestLapTime: 64.2,
    });
  });
});

describe("diffLaps — first valid lap", () => {
  it("emits with isFirstValid=true and isBest=true when there is no prior best", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    // Seed: no laps completed yet, no best.
    diffLaps(state, tick({ LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }), "race", null, synced(), NOW, emit);
    // Lap 1 — first timed lap of the session.
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data).toMatchObject({
      lap: 1,
      lapTime: 63.4,
      isBest: true,
      isFirstValid: true,
      bestLapTime: 63.4,
    });
    expect(fired[0].data.previousBestLapTime).toBeUndefined();
  });
});

describe("diffLaps — session-change reset", () => {
  it("does not carry a prior session's best into the new session", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    // Practice (SessionNum=0): set a fast PB.
    diffLaps(
      state,
      tick({ SessionNum: 0, LapCompleted: 1, LapLastLapTime: 60.2, LapBestLap: 1, LapBestLapTime: 60.2 }),
      "practice",
      null,
      synced(),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ SessionNum: 0, LapCompleted: 2, LapLastLapTime: 58.9, LapBestLap: 2, LapBestLapTime: 58.9 }),
      "practice",
      null,
      synced(),
      NOW,
      emit,
    );
    // Switch to qualifying (SessionNum=1).
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }),
      "qualifying",
      null,
      synced(),
      NOW,
      emit,
    );
    // First qualifying lap completes — slower than the practice PB but it
    // IS the first valid lap of qualifying.
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 1, LapLastLapTime: 64.5, LapBestLap: 1, LapBestLapTime: 64.5 }),
      "qualifying",
      null,
      synced(),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    // Only the practice PB (lap 2) and the first qualifying lap should fire.
    expect(fired).toHaveLength(2);
    expect(fired[1].data).toMatchObject({
      lap: 1,
      lapTime: 64.5,
      isBest: true,
      isFirstValid: true,
      sessionType: "qualifying",
    });
    expect(fired[1].data.previousBestLapTime).toBeUndefined();
  });

  it("resets the lap counter so the new session starts from 0", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    // Practice: ran 12 laps.
    diffLaps(
      state,
      tick({ SessionNum: 0, LapCompleted: 12, LapLastLapTime: 60.0, LapBestLap: 12, LapBestLapTime: 60.0 }),
      "practice",
      null,
      synced(),
      NOW,
      emit,
    );
    // Switch to qualifying with LapCompleted dropping to 0 — without the
    // reset, the counter baseline would still be 12 and the first qualifying
    // completions would all be "no transition".
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }),
      "qualifying",
      null,
      synced(),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 1, LapLastLapTime: 65.0, LapBestLap: 1, LapBestLapTime: 65.0 }),
      "qualifying",
      null,
      synced(),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.lap).toBe(1);
    expect(fired[0].data.isFirstValid).toBe(true);
  });

  it("does not reset when SessionNum stays the same", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 1, LapLastLapTime: 64.0, LapBestLap: 1, LapBestLapTime: 64.0 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 2, LapLastLapTime: 63.0, LapBestLap: 2, LapBestLapTime: 63.0 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data).toMatchObject({
      isBest: true,
      isFirstValid: false,
      previousBestLapTime: 64.0,
    });
  });
});

describe("diffLaps — sentinel suppression", () => {
  it("does not emit on pace laps (LapCompleted < 0)", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(
      state,
      tick({ LapCompleted: -1, LapLastLapTime: 0, LapBestLapTime: 0 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ LapCompleted: -1, LapLastLapTime: 0, LapBestLapTime: 0 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );

    expect(lapEvents(events)).toHaveLength(0);
  });

  it("defers emission when LapLastLapTime still equals the prior emitted value (iRacing refresh lag)", () => {
    // Regression: iRacing publishes `LapCompleted++` a tick or two BEFORE
    // refreshing `LapLastLapTime` for the new lap. Reading the field on the
    // increment tick gives the prior lap's value. Without the refresh-wait,
    // we publish a duplicate lap.completed with stale `lapTime`, `isBest:
    // false`, and `previousBest === lapTime` — which is exactly the bug
    // the user hit in the live session log.
    const state = createInitialState();
    const { events, emit } = collect();
    // Lap 1: 37.1s. Sets `lastEmittedLapTime`.
    diffLaps(
      state,
      tick({ LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }),
      "practice",
      null,
      synced(),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 37.1, LapBestLap: 1, LapBestLapTime: 37.1 }),
      "practice",
      null,
      synced(),
      NOW,
      emit,
    );
    expect(lapEvents(events)).toHaveLength(1);
    expect(state.lastEmittedLapTime).toBe(37.1);

    // Lap 2 begins. `LapCompleted` increments to 2 but iRacing hasn't yet
    // refreshed `LapLastLapTime` — still shows 37.1. The diff must wait.
    diffLaps(
      state,
      tick({ LapCompleted: 2, LapLastLapTime: 37.1, LapBestLap: 2, LapBestLapTime: 37.1 }),
      "practice",
      null,
      synced(),
      NOW,
      emit,
    );
    expect(lapEvents(events)).toHaveLength(1);

    // A tick later iRacing refreshes the field to lap 2's actual time.
    diffLaps(
      state,
      tick({ LapCompleted: 2, LapLastLapTime: 36.4, LapBestLap: 2, LapBestLapTime: 36.4 }),
      "practice",
      null,
      synced(),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(2);
    expect(fired[1].data).toMatchObject({
      lap: 2,
      lapTime: 36.4,
      isBest: true,
      isFirstValid: false,
      bestLapTime: 36.4,
      previousBestLapTime: 37.1,
    });
  });

  it("defers emission to the next tick when LapLastLapTime is still 0 at the increment", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }), "race", null, synced(), NOW, emit);
    // Counter ticks up but LapLastLapTime hasn't settled — no event yet.
    diffLaps(state, tick({ LapCompleted: 1, LapLastLapTime: 0, LapBestLapTime: 0 }), "race", null, synced(), NOW, emit);

    expect(lapEvents(events)).toHaveLength(0);
    // The next tick settles the lap time and the event fires.
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.lap).toBe(1);
    expect(fired[0].data.lapTime).toBe(63.4);
  });

  it("does not synthesize an event on a session reset (counter decreases)", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(
      state,
      tick({ LapCompleted: 12, LapLastLapTime: 63.4, LapBestLap: 12, LapBestLapTime: 63.4 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );
    // Practice → race flips LapCompleted 12 → 0.
    diffLaps(state, tick({ LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }), "race", null, synced(), NOW, emit);

    expect(lapEvents(events)).toHaveLength(0);
  });
});

describe("diffLaps — payload pass-through", () => {
  it("populates lapsRemaining when SessionLapsRemainEx is set", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ LapCompleted: 0, SessionLapsRemainEx: 10 }), "race", null, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4, SessionLapsRemainEx: 9 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );

    expect(lapEvents(events)[0].data.lapsRemaining).toBe(9);
  });

  it("populates timeRemaining when SessionTimeRemain is set", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ LapCompleted: 0 }), "race", null, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4, SessionTimeRemain: 1234.5 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );

    expect(lapEvents(events)[0].data.timeRemaining).toBe(1234.5);
  });

  // The side a session does not have reads a sentinel, never a missing field
  // (#1220): the catalog promises each field only when that side limits it.
  function completeLap(limits: Partial<TelemetryData>) {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ LapCompleted: 0, ...limits }), "race", null, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4, ...limits }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );

    expect(lapEvents(events)).toHaveLength(1);

    return lapEvents(events)[0].data;
  }

  it("omits timeRemaining in a lap race, where SessionTimeRemain reads IRSDK_UNLIMITED_TIME", () => {
    const data = completeLap({ SessionLapsRemainEx: 9, SessionTimeRemain: IRSDK_UNLIMITED_TIME });

    expect(data.lapsRemaining).toBe(9);
    expect(data).not.toHaveProperty("timeRemaining");
  });

  it("omits lapsRemaining in a timed race, where SessionLapsRemainEx reads IRSDK_UNLIMITED_LAPS", () => {
    const data = completeLap({ SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS, SessionTimeRemain: 1234.5 });

    expect(data).not.toHaveProperty("lapsRemaining");
    expect(data.timeRemaining).toBe(1234.5);
  });

  it("keeps a 0 on either side — a real reading, not an unknown", () => {
    const data = completeLap({ SessionLapsRemainEx: 0, SessionTimeRemain: 0 });

    expect(data.lapsRemaining).toBe(0);
    expect(data.timeRemaining).toBe(0);
  });

  it("omits a negative reading on either side", () => {
    const data = completeLap({ SessionLapsRemainEx: -1, SessionTimeRemain: -2.5 });

    expect(data).not.toHaveProperty("lapsRemaining");
    expect(data).not.toHaveProperty("timeRemaining");
  });

  it("omits a non-finite reading on either side", () => {
    const data = completeLap({ SessionLapsRemainEx: Number.NaN, SessionTimeRemain: Number.POSITIVE_INFINITY });

    expect(data).not.toHaveProperty("lapsRemaining");
    expect(data).not.toHaveProperty("timeRemaining");
  });

  it("omits sessionType when undefined", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ LapCompleted: 0 }), undefined, null, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4 }),
      undefined as LapSessionType | undefined,
      null,
      synced(),
      NOW,
      emit,
    );

    expect(lapEvents(events)[0].data.sessionType).toBeUndefined();
  });
});

describe("diffLaps — position fields from ResultsPositions (issue #566)", () => {
  it("seeds the position baselines silently on first tick regardless of standings", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(5, 3), NOW, emit);

    expect(lapEvents(events)).toHaveLength(0);
    // First-tick seed does NOT capture position — the baseline stays at 0 so
    // the first valid lap of the session triggers the "no previous position"
    // branch (mirrors lastLapBestLapTime seeding for isFirstValid).
    expect(state.lastLapPosition).toBe(0);
    expect(state.lastLapClassPosition).toBe(0);
  });

  it("includes position fields on the first valid lap, with no previousPosition", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4 }),
      "race",
      false,
      // Standings: player at P3, class P3 (raw ClassPosition = 2 → emitted as 3).
      synced(3, 3),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.position).toBe(3);
    expect(fired[0].data.classPosition).toBe(3);
    expect(fired[0].data.previousPosition).toBeUndefined();
    expect(fired[0].data.previousClassPosition).toBeUndefined();
    expect(fired[0].data.isMultiClass).toBe(false);
    expect(state.lastLapPosition).toBe(3);
    expect(state.lastLapClassPosition).toBe(3);
  });

  it("carries previousPosition from the prior lap into the new lap.completed", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4 }),
      "race",
      false,
      synced(5, 5),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ LapCompleted: 2, LapLastLapTime: 64.1, LapBestLapTime: 63.4 }),
      "race",
      false,
      synced(3, 3),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(2);
    expect(fired[1].data.position).toBe(3);
    expect(fired[1].data.previousPosition).toBe(5);
    expect(fired[1].data.classPosition).toBe(3);
    expect(fired[1].data.previousClassPosition).toBe(5);
  });

  it("passes isMultiClass through from the translator", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", true, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4 }),
      "race",
      true,
      synced(8, 2),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.isMultiClass).toBe(true);
    expect(fired[0].data.position).toBe(8);
    expect(fired[0].data.classPosition).toBe(2);
  });

  it("omits isMultiClass when the translator can't resolve session info", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", null, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4 }),
      "race",
      null,
      synced(3),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.isMultiClass).toBeUndefined();
  });

  it("omits position fields when both standings AND telemetry have zero position", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);
    diffLaps(
      state,
      // Both sources empty — pre-grid state, no standings computed.
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4, PlayerCarPosition: 0 }),
      "race",
      false,
      { lapsComplete: 9999, position: 0, classPosition: -1 },
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.position).toBeUndefined();
    expect(fired[0].data.classPosition).toBeUndefined();
    expect(fired[0].data.isMultiClass).toBe(false);
  });

  it("wipes the position baseline on session change so a prior session doesn't bleed through", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    // Practice: build a position baseline.
    diffLaps(state, tick({ SessionNum: 0 }), "practice", false, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ SessionNum: 0, LapCompleted: 1, LapLastLapTime: 60.0, LapBestLap: 1, LapBestLapTime: 60.0 }),
      "practice",
      false,
      synced(4),
      NOW,
      emit,
    );
    expect(state.lastLapPosition).toBe(4);

    // Session change to qualifying — baseline must reset.
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }),
      "qualifying",
      false,
      synced(1),
      NOW,
      emit,
    );
    // First qualifying lap completes — should have no previousPosition.
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 1, LapLastLapTime: 64.0, LapBestLap: 1, LapBestLapTime: 64.0 }),
      "qualifying",
      false,
      synced(1),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    // Two emissions: the practice lap, then the first qualifying lap (which
    // counts as `isFirstValid`).
    expect(fired).toHaveLength(2);
    expect(fired[1].data.position).toBe(1);
    expect(fired[1].data.previousPosition).toBeUndefined();
  });
});

describe("diffLaps — ResultsPositions sync gate (issue #566)", () => {
  it("defers the emit while ResultsPositions has not caught up to the lap counter", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);

    // Lap-time refreshes for lap 1 but standings still show lap 0.
    const stale: PlayerResultsForLap = { lapsComplete: 0, position: 4, classPosition: 3 };
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4 }),
      "race",
      false,
      stale,
      NOW,
      emit,
    );
    expect(lapEvents(events)).toHaveLength(0);
    expect(state.lapResultsPendingSince).toBe(NOW);

    // Tick later (within the timeout window) — standings still stale.
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4 }),
      "race",
      false,
      stale,
      NOW + 100,
      emit,
    );
    expect(lapEvents(events)).toHaveLength(0);
  });

  it("fires the deferred lap.completed once ResultsPositions catches up", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);

    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4 }),
      "race",
      false,
      { lapsComplete: 0, position: 4, classPosition: 3 },
      NOW,
      emit,
    );
    expect(lapEvents(events)).toHaveLength(0);

    // Standings catch up — now the diff emits with the synced position.
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4 }),
      "race",
      false,
      { lapsComplete: 1, position: 4, classPosition: 3 },
      NOW + 200,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.position).toBe(4);
    expect(fired[0].data.classPosition).toBe(4); // raw 3 → +1 → 4 (1-indexed)
    expect(state.lapResultsPendingSince).toBe(0);
  });

  it("falls back to telemetry position after the timeout — never silently omits", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);

    const stale: PlayerResultsForLap = { lapsComplete: 0, position: 0, classPosition: -1 };
    // First detection tick — stale standings, telemetry has good position.
    diffLaps(
      state,
      tick({
        LapCompleted: 1,
        LapLastLapTime: 63.4,
        LapBestLapTime: 63.4,
        PlayerCarPosition: 5,
        PlayerCarClassPosition: 5,
      }),
      "race",
      false,
      stale,
      NOW,
      emit,
    );
    expect(lapEvents(events)).toHaveLength(0);

    // Past the timeout — diff sources position from telemetry rather than
    // omitting it (issue #566 fix). Lap-time + standings both land in one
    // event instead of the position-change scenario being silently dropped.
    diffLaps(
      state,
      tick({
        LapCompleted: 1,
        LapLastLapTime: 63.4,
        LapBestLapTime: 63.4,
        PlayerCarPosition: 5,
        PlayerCarClassPosition: 5,
      }),
      "race",
      false,
      stale,
      NOW + LAP_RESULTS_SYNC_MAX_WAIT_MS,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.lap).toBe(1);
    expect(fired[0].data.lapTime).toBe(63.4);
    expect(fired[0].data.position).toBe(5);
    expect(fired[0].data.classPosition).toBe(5);
    expect(state.lapResultsPendingSince).toBe(0);
    expect(state.lastLapPosition).toBe(5);
  });

  it("omits position only when BOTH ResultsPositions and telemetry are empty", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);

    const stale: PlayerResultsForLap = { lapsComplete: 0, position: 0, classPosition: -1 };
    // Both sources empty — pre-grid state where iRacing hasn't established
    // any standings or position yet.
    diffLaps(
      state,
      tick({
        LapCompleted: 1,
        LapLastLapTime: 63.4,
        LapBestLapTime: 63.4,
        PlayerCarPosition: 0,
        PlayerCarClassPosition: 0,
      }),
      "race",
      false,
      stale,
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({
        LapCompleted: 1,
        LapLastLapTime: 63.4,
        LapBestLapTime: 63.4,
        PlayerCarPosition: 0,
        PlayerCarClassPosition: 0,
      }),
      "race",
      false,
      stale,
      NOW + LAP_RESULTS_SYNC_MAX_WAIT_MS,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.position).toBeUndefined();
    expect(fired[0].data.classPosition).toBeUndefined();
  });

  it("treats missing playerResults (null) the same as stale standings — defers, then falls back to telemetry", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);

    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4, PlayerCarPosition: 7 }),
      "race",
      false,
      null,
      NOW,
      emit,
    );
    expect(lapEvents(events)).toHaveLength(0);

    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLap: 1, LapBestLapTime: 63.4, PlayerCarPosition: 7 }),
      "race",
      false,
      null,
      NOW + LAP_RESULTS_SYNC_MAX_WAIT_MS,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.position).toBe(7);
  });
});

describe("diffLaps — position-change + race-status cadence (issue #569)", () => {
  function positionChangedEvents(events: PendingEvent[]): Array<Extract<PendingEvent, { event: "position.changed" }>> {
    return events.filter(
      (e): e is Extract<PendingEvent, { event: "position.changed" }> => e.event === "position.changed",
    );
  }

  it("anchors the lapsSincePositionChange cadence to the first valid lap when no change happens", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);

    // Lap 1 — first valid lap, anchors cadence at 1 since there's no
    // previous baseline to detect a change against. Each subsequent lap uses
    // a slightly different time so the diff's "LapLastLapTime changed"
    // gate doesn't swallow the emission.
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.0, LapBestLap: 1, LapBestLapTime: 63.0 }),
      "race",
      false,
      synced(5, 5),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ LapCompleted: 2, LapLastLapTime: 64.0, LapBestLapTime: 63.0 }),
      "race",
      false,
      synced(5, 5),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ LapCompleted: 3, LapLastLapTime: 64.1, LapBestLapTime: 63.0 }),
      "race",
      false,
      synced(5, 5),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ LapCompleted: 4, LapLastLapTime: 64.2, LapBestLapTime: 63.0 }),
      "race",
      false,
      synced(5, 5),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(4);
    expect(fired[0].data.lapsSincePositionChange).toBe(0);
    expect(fired[1].data.lapsSincePositionChange).toBe(1);
    expect(fired[2].data.lapsSincePositionChange).toBe(2);
    expect(fired[3].data.lapsSincePositionChange).toBe(3);
    // No position changes detected — only the anchor was set.
    expect(positionChangedEvents(events)).toHaveLength(0);
  });

  it("emits position.changed and resets the cadence when position differs from the prior lap", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.0, LapBestLap: 1, LapBestLapTime: 63.0 }),
      "race",
      false,
      synced(5, 5),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ LapCompleted: 2, LapLastLapTime: 64.0, LapBestLapTime: 63.0 }),
      "race",
      false,
      synced(5, 5),
      NOW,
      emit,
    );
    // Position improves on lap 3 — emits position.changed and resets cadence.
    diffLaps(
      state,
      tick({ LapCompleted: 3, LapLastLapTime: 64.1, LapBestLapTime: 63.0 }),
      "race",
      false,
      synced(4, 4),
      NOW,
      emit,
    );
    // Lap 4 — same new position, lapsSincePositionChange counts from the
    // change on lap 3.
    diffLaps(
      state,
      tick({ LapCompleted: 4, LapLastLapTime: 64.2, LapBestLapTime: 63.0 }),
      "race",
      false,
      synced(4, 4),
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(4);
    expect(fired[2].data.lapsSincePositionChange).toBe(0); // reset
    expect(fired[3].data.lapsSincePositionChange).toBe(1);

    const changes = positionChangedEvents(events);
    expect(changes).toHaveLength(1);
    expect(changes[0].data.lap).toBe(3);
    expect(changes[0].data.position).toBe(4);
    expect(changes[0].data.previousPosition).toBe(5);
  });

  it("omits lapsSincePositionChange on the first valid lap when position is unknown (no baseline anchor)", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);
    // First lap has no position resolvable from either source — cadence
    // can't anchor, so the field stays omitted.
    diffLaps(
      state,
      tick({
        LapCompleted: 1,
        LapLastLapTime: 63.0,
        LapBestLapTime: 63.0,
        PlayerCarPosition: 0,
        PlayerCarClassPosition: 0,
      }),
      "race",
      false,
      { lapsComplete: 9999, position: 0, classPosition: -1 },
      NOW,
      emit,
    );

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.lapsSincePositionChange).toBeUndefined();
  });

  it("does not emit position.changed on the first valid lap (no prior baseline to compare)", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.0, LapBestLap: 1, LapBestLapTime: 63.0 }),
      "race",
      false,
      synced(5, 5),
      NOW,
      emit,
    );

    expect(positionChangedEvents(events)).toHaveLength(0);
  });

  it("wipes lastPositionChangeLap on session change", () => {
    const state = createInitialState();
    const { emit } = collect();
    diffLaps(state, tick({ SessionNum: 0 }), "practice", false, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ SessionNum: 0, LapCompleted: 1, LapLastLapTime: 60.0, LapBestLap: 1, LapBestLapTime: 60.0 }),
      "practice",
      false,
      synced(3, 3),
      NOW,
      emit,
    );
    expect(state.lastPositionChangeLap).toBe(1);

    // Session change — anchor should reset to -1, then re-anchor on the new
    // session's first lap.
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }),
      "race",
      false,
      synced(2, 2),
      NOW,
      emit,
    );
    expect(state.lastPositionChangeLap).toBe(-1);
  });

  it("uses effective (class) position for change detection in multi-class", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", true, synced(), NOW, emit);

    // Lap 1 — establish baseline: overall P12, class P3.
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.0, LapBestLap: 1, LapBestLapTime: 63.0 }),
      "race",
      true,
      synced(12, 3),
      NOW,
      emit,
    );
    expect(positionChangedEvents(events)).toHaveLength(0);
    expect(state.lastPositionChangeLap).toBe(1);

    // Lap 2 — class position improves (P3 → P2) but overall stays at P12.
    // Effective position is class in multi-class, so this MUST emit
    // position.changed and reset the cadence anchor.
    diffLaps(
      state,
      tick({ LapCompleted: 2, LapLastLapTime: 63.5, LapBestLapTime: 63.0 }),
      "race",
      true,
      synced(12, 2),
      NOW,
      emit,
    );
    const changes = positionChangedEvents(events);
    expect(changes).toHaveLength(1);
    expect(changes[0].data.classPosition).toBe(2);
    expect(changes[0].data.previousClassPosition).toBe(3);
    expect(state.lastPositionChangeLap).toBe(2);
  });

  it("ignores overall-only churn in multi-class (class position unchanged)", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", true, synced(), NOW, emit);

    // Lap 1 — establish baseline: overall P12, class P3.
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.0, LapBestLap: 1, LapBestLapTime: 63.0 }),
      "race",
      true,
      synced(12, 3),
      NOW,
      emit,
    );

    // Lap 2 — overall moves P12 → P10 (other-class shuffle ahead) but class
    // position holds at P3. Should NOT emit position.changed and should NOT
    // reset the cadence anchor — the driver doesn't race overall in
    // multi-class, only their class matters.
    diffLaps(
      state,
      tick({ LapCompleted: 2, LapLastLapTime: 63.5, LapBestLapTime: 63.0 }),
      "race",
      true,
      synced(10, 3),
      NOW,
      emit,
    );
    expect(positionChangedEvents(events)).toHaveLength(0);
    expect(state.lastPositionChangeLap).toBe(1); // anchor stays put
  });
});

describe("diffLaps — race.finished (issue #569)", () => {
  function raceFinishedEvents(events: PendingEvent[]): Array<Extract<PendingEvent, { event: "race.finished" }>> {
    return events.filter((e): e is Extract<PendingEvent, { event: "race.finished" }> => e.event === "race.finished");
  }

  /**
   * Seed, then a tick with the checkered already flying before the player
   * reaches the line — the flag has to be up BEFORE the crossing for the
   * crossing to count as taking it (issue #1278, the #771 rule).
   */
  function seedWithFlagFlying(
    state: ReturnType<typeof createInitialState>,
    emit: (e: PendingEvent) => void,
    isMultiClass: boolean = false,
  ): void {
    diffLaps(state, tick({ SessionNum: 0 }), "race", isMultiClass, synced(), NOW, emit);
    diffLaps(state, tick({ SessionNum: 0, SessionFlags: Flags.Checkered }), "race", isMultiClass, synced(), NOW, emit);
  }

  function crossing(lap: number, lapTime: number, flags: number = Flags.Checkered): TelemetryData {
    return tick({
      SessionNum: 0,
      LapCompleted: lap,
      LapLastLapTime: lapTime,
      LapBestLapTime: 63.0,
      SessionFlags: flags,
    });
  }

  it("emits race.finished once when the player crosses the line under the checkered flag", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seedWithFlagFlying(state, emit);

    diffLaps(state, crossing(5, 63.0), "race", false, synced(3, 3), NOW, emit);

    const finished = raceFinishedEvents(events);
    expect(finished).toHaveLength(1);
    expect(finished[0].data.position).toBe(3);
    expect(state.raceFinishedFired).toBe(true);
    // The finish a display holds from here on (issue #1278).
    expect(state.raceFinish).toEqual({ sessionNum: 0, lap: 5 });
  });

  it("does not re-emit race.finished on subsequent laps in the same session", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seedWithFlagFlying(state, emit);
    diffLaps(state, crossing(5, 63.0), "race", false, synced(3, 3), NOW, emit);
    // Another lap completes — checkered still raised, but the latch holds.
    diffLaps(state, crossing(6, 64.0), "race", false, synced(3, 3), NOW, emit);

    expect(raceFinishedEvents(events)).toHaveLength(1);
    // The finish stays the first crossing under the flag.
    expect(state.raceFinish).toEqual({ sessionNum: 0, lap: 5 });
  });

  it("does not emit race.finished in non-race sessions even with checkered flag", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ SessionNum: 0 }), "qualifying", false, synced(), NOW, emit);
    diffLaps(state, tick({ SessionNum: 0, SessionFlags: Flags.Checkered }), "qualifying", false, synced(), NOW, emit);
    diffLaps(state, crossing(5, 63.0), "qualifying", false, synced(3, 3), NOW, emit);

    expect(raceFinishedEvents(events)).toHaveLength(0);
    expect(state.raceFinishedFired).toBe(false);
    expect(state.raceFinish).toBeNull();
  });

  // Issue #1278 (review): a lapped player crosses just ahead of the leader,
  // the emit waits for the standings, and the leader takes the flag inside
  // that wait. The bit is up at the emit tick, but the player crossed before
  // it flew — that crossing starts their last lap, it does not end their race.
  it("does not treat a crossing made before the flag as the finish when the emit lands after it", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ SessionNum: 0, LapCompleted: 4 }), "race", false, synced(), NOW, emit);

    // Crossing, no flag yet; standings not synced (row still on lap 4).
    const unsynced = { lapsComplete: 4, position: 7, classPosition: 6 };
    diffLaps(state, crossing(5, 63.0, 0), "race", false, unsynced, NOW, emit);
    // The leader takes the flag behind the player while the emit waits.
    diffLaps(state, crossing(5, 63.0), "race", false, unsynced, NOW + 1000, emit);
    // Standings catch up; lap.completed goes out with the flag flying.
    diffLaps(state, crossing(5, 63.0), "race", false, synced(7, 7), NOW + 2000, emit);

    expect(events.some((e) => e.event === "lap.completed")).toBe(true);
    expect(raceFinishedEvents(events)).toHaveLength(0);
    expect(state.raceFinish).toBeNull();

    // Their real finish is the next crossing, made under the flag.
    diffLaps(state, crossing(6, 64.0), "race", false, synced(7, 7), NOW + 90_000, emit);

    expect(raceFinishedEvents(events)).toHaveLength(1);
    expect(state.raceFinish).toEqual({ sessionNum: 0, lap: 6 });
  });

  it("does not treat a flag that rises on the crossing tick itself as taken", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ SessionNum: 0 }), "race", false, synced(), NOW, emit);

    diffLaps(state, crossing(5, 63.0), "race", false, synced(3, 3), NOW, emit);

    expect(raceFinishedEvents(events)).toHaveLength(0);
    expect(state.raceFinish).toBeNull();
  });

  it("takes the finish from the flag diff's record when the bit lands after the winner's crossing", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ SessionNum: 0 }), "race", false, synced(), NOW, emit);
    // The flag diff's winner grace resolved the checkered at this crossing.
    state.flagCheckeredTakenLap = 5;

    diffLaps(state, crossing(5, 63.0), "race", false, synced(1, 1), NOW, emit);

    expect(raceFinishedEvents(events)).toHaveLength(1);
    expect(state.raceFinish).toEqual({ sessionNum: 0, lap: 5 });
  });

  it("defers the latch when position is missing so the next lap.completed retries", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seedWithFlagFlying(state, emit);
    // Lap with checkered but no position — latch should NOT flip.
    diffLaps(
      state,
      tick({
        SessionNum: 0,
        LapCompleted: 5,
        LapLastLapTime: 63.0,
        LapBestLapTime: 63.0,
        SessionFlags: Flags.Checkered,
        PlayerCarPosition: 0,
        PlayerCarClassPosition: 0,
      }),
      "race",
      false,
      { lapsComplete: 9999, position: 0, classPosition: -1 },
      NOW,
      emit,
    );
    expect(raceFinishedEvents(events)).toHaveLength(0);
    expect(state.raceFinishedFired).toBe(false);
    // The finish is recorded anyway (issue #1278): a cool-down lap usually
    // ends in the pits, so the retry this latch waits for may never come.
    expect(state.raceFinish).toEqual({ sessionNum: 0, lap: 5 });

    // Next lap arrives with position resolved — emit + latch fire now.
    diffLaps(state, crossing(6, 64.0), "race", false, synced(4, 4), NOW, emit);
    expect(raceFinishedEvents(events)).toHaveLength(1);
    expect(state.raceFinishedFired).toBe(true);
    expect(state.raceFinish).toEqual({ sessionNum: 0, lap: 5 });
  });

  it("re-arms the latch on session change so a later race session can fire again", () => {
    const state = createInitialState();
    const { emit } = collect();
    seedWithFlagFlying(state, emit);
    diffLaps(state, crossing(5, 63.0), "race", false, synced(3, 3), NOW, emit);
    expect(state.raceFinishedFired).toBe(true);
    expect(state.raceFinish).toEqual({ sessionNum: 0, lap: 5 });

    // New session (next race in the schedule).
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }),
      "race",
      false,
      synced(),
      NOW,
      emit,
    );
    expect(state.raceFinishedFired).toBe(false);
    expect(state.raceFinish).toBeNull();
  });

  it("carries classPosition + isMultiClass into the race.finished payload", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seedWithFlagFlying(state, emit, true);
    diffLaps(state, crossing(5, 63.0), "race", true, synced(8, 2), NOW, emit);

    const finished = raceFinishedEvents(events);
    expect(finished).toHaveLength(1);
    expect(finished[0].data.position).toBe(8);
    expect(finished[0].data.classPosition).toBe(2);
    expect(finished[0].data.isMultiClass).toBe(true);
  });
});

describe("diffLaps — the LapDeltaTo*_OK flags are not read (issue #1582)", () => {
  // The flags say whether a delta reference exists and the car is on track,
  // not whether iRacing counted the lap: all four read false on pit road and
  // on an out lap, and all four read true on the race's cut lap in the
  // 2026-11-02 captures. The verdict is iRacing's `LapLastLapTime`.
  const allFlags = (value: boolean): Partial<TelemetryData> => ({
    LapDeltaToBestLap_OK: value,
    LapDeltaToSessionBestLap_OK: value,
    LapDeltaToSessionOptimalLap_OK: value,
    LapDeltaToSessionLastlLap_OK: value,
  });

  it("emits a timed lap as counted with every flag false, carrying no lapIsValid", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "qualifying", false, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 84.2, LapBestLap: 1, LapBestLapTime: 84.2, ...allFlags(false) }),
      "qualifying",
      false,
      synced(3, 3),
      NOW,
      emit,
    );

    const laps = lapEvents(events);
    expect(laps).toHaveLength(1);
    expect(laps[0].data).toMatchObject({ lap: 1, lapTime: 84.2, isBest: true });
    expect("lapIsValid" in laps[0].data).toBe(false);
  });

  it("emits a lap iRacing refused as refused with every flag true", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(
      state,
      tick({ LapCompleted: 3, LapLastLapTime: 75.1, LapBestLap: 3, LapBestLapTime: 75.1 }),
      "race",
      false,
      synced(),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ LapCompleted: 4, LapLastLapTime: 75.1, LapBestLap: 3, LapBestLapTime: 75.1, ...allFlags(true) }),
      "race",
      false,
      synced(),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ LapCompleted: 4, LapLastLapTime: -1, LapBestLap: 3, LapBestLapTime: 75.1, ...allFlags(true) }),
      "race",
      false,
      synced(),
      NOW + 900,
      emit,
    );

    const laps = lapEvents(events);
    expect(laps).toHaveLength(1);
    expect(laps[0].data).toMatchObject({ lap: 4, lapIsValid: false, isBest: false });
  });
});

describe("diffLaps — refused laps (issue #1582)", () => {
  const BEST = 80;

  type Ctx = { state: ReturnType<typeof createInitialState>; events: PendingEvent[]; emit: (e: PendingEvent) => void };

  /** A tick of the player's lap fields; the best stands at {@link BEST}, set on lap 1, unless overridden. */
  function lapTick(lap: number, lapTime: number, overrides: Partial<TelemetryData> = {}): TelemetryData {
    return tick({ LapCompleted: lap, LapLastLapTime: lapTime, LapBestLap: 1, LapBestLapTime: BEST, ...overrides });
  }

  /** Seeded on lap 1, its counted 80 s the standing best. */
  function seeded(): Ctx {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, lapTick(1, BEST), "qualifying", false, synced(), NOW, emit);

    return { state, events, emit };
  }

  /** Feed one qualifying tick `ms` past {@link NOW}. */
  function at(
    ctx: Ctx,
    ms: number,
    telemetry: TelemetryData,
    playerResults: PlayerResultsForLap | null = synced(),
  ): void {
    diffLaps(ctx.state, telemetry, "qualifying", false, playerResults, NOW + ms, ctx.emit);
  }

  /** Lap 2 refused: crossed at 1000 ms reading lap 1's time, `-1` at 1500 ms. */
  function refuseLap2(ctx: Ctx): void {
    at(ctx, 1000, lapTick(2, BEST));
    at(ctx, 1500, lapTick(2, -1));
  }

  it("emits a refused lap.completed once the time changes to -1 after the crossing, with no lapTime", () => {
    const ctx = seeded();
    at(ctx, 1000, lapTick(2, BEST));
    expect(lapEvents(ctx.events)).toHaveLength(0);
    at(ctx, 1500, lapTick(2, -1));

    const laps = lapEvents(ctx.events);
    expect(laps).toHaveLength(1);
    expect(laps[0].data).toEqual({
      lap: 2,
      isBest: false,
      isFirstValid: false,
      lapIsValid: false,
      bestLapTime: BEST,
      previousBestLapTime: BEST,
      sessionType: "qualifying",
      isMultiClass: false,
    });
    expect("lapTime" in laps[0].data).toBe(false);
    expect(ctx.state.lastEmittedLapTime).toBe(-1);
    expect(ctx.state.lastLapCompletedCounter).toBe(2);

    // Nothing more for the same count, however long the field reads -1.
    at(ctx, 6000, lapTick(2, -1));
    expect(lapEvents(ctx.events)).toHaveLength(1);
  });

  it("positive control: the same ticks with a time emit counted", () => {
    const ctx = seeded();
    at(ctx, 1000, lapTick(2, BEST));
    at(ctx, 1500, lapTick(2, 81));

    const laps = lapEvents(ctx.events);
    expect(laps).toHaveLength(1);
    expect(laps[0].data).toMatchObject({ lap: 2, lapTime: 81, isBest: false, isFirstValid: false });
    expect("lapIsValid" in laps[0].data).toBe(false);
  });

  it("refuses a lap whose time changes to -1 on the crossing tick itself once the allowance has run", () => {
    const ctx = seeded();
    at(ctx, 1000, lapTick(2, -1));
    at(ctx, 1000 + LAP_TIME_REFRESH_ALLOWANCE_MS - 1, lapTick(2, -1));
    expect(lapEvents(ctx.events)).toHaveLength(0);
    at(ctx, 1000 + LAP_TIME_REFRESH_ALLOWANCE_MS, lapTick(2, -1));
    expect(lapEvents(ctx.events).map((e) => e.data)).toMatchObject([{ lap: 2, lapIsValid: false }]);
  });

  it("emits two refused events for two refused laps in a row", () => {
    const ctx = seeded();
    refuseLap2(ctx);
    // Lap 3 crosses while the field still reads lap 2's -1: refused only
    // once it still reads -1 the allowance after the crossing.
    at(ctx, 80_000, lapTick(3, -1));
    at(ctx, 80_000 + LAP_TIME_REFRESH_ALLOWANCE_MS - 1, lapTick(3, -1));
    expect(lapEvents(ctx.events)).toHaveLength(1);
    at(ctx, 80_000 + LAP_TIME_REFRESH_ALLOWANCE_MS, lapTick(3, -1));

    expect(lapEvents(ctx.events).map((e) => [e.data.lap, e.data.lapIsValid])).toEqual([
      [2, false],
      [3, false],
    ]);
  });

  it("emits a counted lap after a refused one, its time landing 0.9 s after the crossing, as counted and not refused", () => {
    const ctx = seeded();
    refuseLap2(ctx);
    at(ctx, 80_000, lapTick(3, -1));
    at(ctx, 80_500, lapTick(3, -1));
    at(ctx, 80_900, lapTick(3, 79, { LapBestLap: 3, LapBestLapTime: 79 }));
    at(ctx, 85_000, lapTick(3, 79, { LapBestLap: 3, LapBestLapTime: 79 }));

    const laps = lapEvents(ctx.events);
    expect(laps).toHaveLength(2);
    expect(laps[1].data).toMatchObject({
      lap: 3,
      lapTime: 79,
      isBest: true,
      isFirstValid: false,
      bestLapTime: 79,
      previousBestLapTime: BEST,
    });
    expect(laps[1].data.lapIsValid).toBeUndefined();
  });

  it("emits refused when the time still reads -1 2 s after the crossing, and counted when it lands at 1.9 s", () => {
    const late = seeded();
    refuseLap2(late);
    at(late, 80_000, lapTick(3, -1));
    at(late, 82_000, lapTick(3, -1));
    expect(lapEvents(late.events).map((e) => e.data.lapIsValid)).toEqual([false, false]);

    const inTime = seeded();
    refuseLap2(inTime);
    at(inTime, 80_000, lapTick(3, -1));
    at(inTime, 81_900, lapTick(3, 81));
    at(inTime, 82_000, lapTick(3, 81));
    const laps = lapEvents(inTime.events);
    expect(laps).toHaveLength(2);
    expect(laps[1].data).toMatchObject({ lap: 3, lapTime: 81 });
  });

  it("drops a time landing at 2.1 s after the refused emit at 2 s: one lap.completed per counter value", () => {
    const ctx = seeded();
    refuseLap2(ctx);
    at(ctx, 80_000, lapTick(3, -1));
    at(ctx, 82_000, lapTick(3, -1));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const late = (ms: number): void =>
      runDiffLaps(
        ctx.state,
        lapTick(3, 81),
        "qualifying",
        false,
        synced(),
        NOW + ms,
        ctx.emit,
        NEVER_A_RECORD,
        logger as unknown as ILogger,
      );
    late(82_100);
    late(82_200);

    expect(lapEvents(ctx.events).map((e) => [e.data.lap, e.data.lapIsValid])).toEqual([
      [2, false],
      [3, false],
    ]);
    // Logged once: the late time is taken as the stale value.
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(String(logger.debug.mock.calls[0]![0])).toContain("lap=3");
    expect(ctx.state.lastEmittedLapTime).toBe(81);

    // The next lap still counts, from the late time it starts on.
    at(ctx, 155_000, lapTick(4, 81));
    expect(lapEvents(ctx.events)).toHaveLength(2);
    at(ctx, 155_300, lapTick(4, 78, { LapBestLap: 4, LapBestLapTime: 78 }));
    expect(lapEvents(ctx.events)[2]!.data).toMatchObject({ lap: 4, lapTime: 78, isBest: true });
  });

  it("emits nothing for a 0 after a lap-0 crossing, nor for a -1 there", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ LapCompleted: -1, LapLastLapTime: 0 }), "race", false, synced(), NOW, emit);
    diffLaps(state, tick({ LapCompleted: 0, LapLastLapTime: 0 }), "race", false, synced(), NOW + 1000, emit);
    diffLaps(state, tick({ LapCompleted: 0, LapLastLapTime: 0 }), "race", false, synced(), NOW + 10_000, emit);
    diffLaps(state, tick({ LapCompleted: 0, LapLastLapTime: -1 }), "race", false, synced(), NOW + 10_500, emit);
    diffLaps(state, tick({ LapCompleted: 0, LapLastLapTime: -1 }), "race", false, synced(), NOW + 20_000, emit);

    expect(lapEvents(events)).toHaveLength(0);
  });

  it("emits nothing for a reset to the pits: the counter dropping to 0 for one tick, then back", () => {
    const ctx = seeded();
    refuseLap2(ctx);
    at(ctx, 5000, lapTick(0, -1));
    at(ctx, 5016, lapTick(2, -1));
    at(ctx, 12_000, lapTick(2, -1));
    expect(lapEvents(ctx.events)).toHaveLength(1);

    // And after a counted lap, its time back on the same count.
    const counted = seeded();
    at(counted, 1000, lapTick(2, BEST));
    at(counted, 1300, lapTick(2, 82));
    at(counted, 5000, lapTick(0, 82));
    at(counted, 5016, lapTick(2, 82));
    at(counted, 12_000, lapTick(2, 82));
    expect(lapEvents(counted.events)).toHaveLength(1);
  });

  it("emits nothing for a seed on -1", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, lapTick(4, -1), "race", false, synced(), NOW, emit);
    diffLaps(state, lapTick(4, -1), "race", false, synced(), NOW + 5000, emit);
    diffLaps(state, lapTick(4, -1), "race", false, synced(), NOW + 60_000, emit);

    expect(lapEvents(events)).toHaveLength(0);
  });

  it("after a seed on -1, emits a counted lap whose time lands 0.9 s after its crossing as counted", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const best = { LapBestLap: 5, LapBestLapTime: 78.5 };
    diffLaps(state, lapTick(4, -1), "race", false, synced(), NOW, emit);
    diffLaps(state, lapTick(5, -1), "race", false, synced(), NOW + 10_000, emit);
    diffLaps(state, lapTick(5, -1), "race", false, synced(), NOW + 10_500, emit);
    diffLaps(state, lapTick(5, 78.5, best), "race", false, synced(), NOW + 10_900, emit);

    const laps = lapEvents(events);
    expect(laps).toHaveLength(1);
    expect(laps[0].data).toMatchObject({ lap: 5, lapTime: 78.5, isBest: true, previousBestLapTime: BEST });
  });

  it("clears the pending crossing on a session change inside the 2 s window", () => {
    const ctx = seeded();
    refuseLap2(ctx);
    at(ctx, 80_000, lapTick(3, -1));
    // The next session starts 1 s into the window.
    at(ctx, 81_000, tick({ SessionNum: 1, LapCompleted: 0, LapLastLapTime: 0 }));
    expect(ctx.state.lapCrossing).toMatchObject({ lap: 0, since: NOW + 81_000, lapTimeAtCrossing: 0 });
    at(ctx, 82_000, tick({ SessionNum: 1, LapCompleted: 0, LapLastLapTime: 0 }));
    at(ctx, 90_000, tick({ SessionNum: 1, LapCompleted: 0, LapLastLapTime: 0 }));

    expect(lapEvents(ctx.events)).toHaveLength(1);
  });

  it("goes through the standings wait like a counted lap", () => {
    const ctx = seeded();
    const stale: PlayerResultsForLap = { lapsComplete: 1, position: 4, classPosition: 3 };
    at(ctx, 1000, lapTick(2, BEST), stale);
    at(ctx, 1500, lapTick(2, -1), stale);
    at(ctx, 1600, lapTick(2, -1), stale);
    expect(lapEvents(ctx.events)).toHaveLength(0);
    at(ctx, 1700, lapTick(2, -1), { lapsComplete: 2, position: 4, classPosition: 3 });

    const laps = lapEvents(ctx.events);
    expect(laps).toHaveLength(1);
    expect(laps[0].data).toMatchObject({ lap: 2, lapIsValid: false, position: 4, classPosition: 4 });
  });

  it("carries positions and the cadence, emits position.changed, and ends the race", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    const race = (telemetry: TelemetryData, results: PlayerResultsForLap, ms: number): void =>
      diffLaps(state, telemetry, "race", false, results, NOW + ms, emit);
    const flying = { SessionNum: 0, SessionFlags: Flags.Checkered };

    race(lapTick(1, BEST, { SessionNum: 0 }), synced(), 0);
    // Lap 2 counted at P5: anchors the cadence.
    race(lapTick(2, BEST, { SessionNum: 0 }), synced(5), 1000);
    race(lapTick(2, 82, { SessionNum: 0 }), synced(5), 1300);
    // Lap 3 refused at P4, crossed with the checkered already flying.
    race(lapTick(2, 82, flying), synced(5), 80_000);
    race(lapTick(3, 82, flying), synced(4), 81_000);
    race(lapTick(3, -1, flying), synced(4), 81_500);

    const laps = lapEvents(events);
    expect(laps).toHaveLength(2);
    expect(laps[1].data).toMatchObject({
      lap: 3,
      lapIsValid: false,
      position: 4,
      previousPosition: 5,
      lapsSincePositionChange: 0,
    });
    expect(events.filter((e) => e.event === "position.changed").map((e) => e.data)).toMatchObject([
      { lap: 3, position: 4, previousPosition: 5 },
    ]);
    expect(events.filter((e) => e.event === "race.finished").map((e) => e.data)).toMatchObject([{ position: 4 }]);
    expect(state.raceFinish).toEqual({ sessionNum: 0, lap: 3 });
  });
});

describe("the fastest-lap judge seam (issue #1571, as #1582 amends it)", () => {
  it("calls the judge once for each emitted lap that is a new best, with (lap, lapTime), and sets the field exactly when it answers true", () => {
    const state = createInitialState();
    const calls: Array<[number, number]> = [];
    let answer = false;
    const judge: FastestLapJudge = (lap, lapTime) => {
      calls.push([lap, lapTime]);

      return answer;
    };

    // The seed tick never asks.
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", null, synced(), NOW, emit, judge);
    expect(calls).toEqual([]);

    // A best the judge refuses: asked once, no field.
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 90, LapBestLap: 1, LapBestLapTime: 90 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
      judge,
    );
    expect(calls).toEqual([[1, 90]]);
    expect(lapEvents(events)).toHaveLength(1);
    expect(lapEvents(events)[0]!.data.isClassFastestLapOfRace).toBeUndefined();

    // A best the judge accepts: asked once, the field is `true` (the positive control).
    answer = true;
    diffLaps(
      state,
      tick({ LapCompleted: 2, LapLastLapTime: 89, LapBestLap: 2, LapBestLapTime: 89 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
      judge,
    );
    expect(calls).toEqual([
      [1, 90],
      [2, 89],
    ]);
    expect(lapEvents(events)).toHaveLength(2);
    expect(lapEvents(events)[1]!.data.isClassFastestLapOfRace).toBe(true);
  });

  it("never asks the judge of a lap that is not a new best: the race start lap, a slower lap, a refused lap", () => {
    const state = createInitialState();
    const judge = vi.fn<FastestLapJudge>(() => true);
    const { events, emit } = collect();
    const race = (telemetry: Partial<TelemetryData>, ms: number = 0): void =>
      diffLaps(state, tick(telemetry), "race", null, synced(), NOW + ms, emit, judge);

    race({});
    // The race start lap: iRacing times it but takes no best (`LapBestLapTime` -1).
    race({ LapCompleted: 1, LapLastLapTime: 82.2, LapBestLap: -1, LapBestLapTime: -1 });
    // Lap 2 sets the best the judge is asked about; lap 3 is slower.
    race({ LapCompleted: 2, LapLastLapTime: 76.2, LapBestLap: 2, LapBestLapTime: 76.2 });
    race({ LapCompleted: 3, LapLastLapTime: 77.0, LapBestLap: 2, LapBestLapTime: 76.2 });
    // Lap 4 refused.
    race({ LapCompleted: 4, LapLastLapTime: 77.0, LapBestLap: 2, LapBestLapTime: 76.2 }, 1000);
    race({ LapCompleted: 4, LapLastLapTime: -1, LapBestLap: 2, LapBestLapTime: 76.2 }, 1500);

    expect(lapEvents(events).map((e) => [e.data.lap, e.data.isBest, e.data.isClassFastestLapOfRace])).toEqual([
      [1, false, undefined],
      [2, true, true],
      [3, false, undefined],
      [4, false, undefined],
    ]);
    expect(judge.mock.calls).toEqual([[2, 76.2]]);
  });

  it("does not ask the judge on a tick that waits for the standings or for the lap time", () => {
    const state = createInitialState();
    const judge = vi.fn<FastestLapJudge>(() => true);
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", null, synced(), NOW, emit, judge);

    // The counter moved but the time has not refreshed yet.
    diffLaps(state, tick({ LapCompleted: 1, LapLastLapTime: 0 }), "race", null, synced(), NOW, emit, judge);
    // The time refreshed but the standings have not caught up.
    const stale: PlayerResultsForLap = { lapsComplete: 0, position: 3, classPosition: 2 };
    const best = { LapCompleted: 1, LapLastLapTime: 90, LapBestLap: 1, LapBestLapTime: 90 };
    diffLaps(state, tick(best), "race", null, stale, NOW, emit, judge);
    expect(judge).not.toHaveBeenCalled();
    expect(lapEvents(events)).toHaveLength(0);

    // The standings land: one emit, one call.
    diffLaps(state, tick(best), "race", null, synced(), NOW + 10, emit, judge);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(lapEvents(events)).toHaveLength(1);
    expect(lapEvents(events)[0]!.data.isClassFastestLapOfRace).toBe(true);
  });

  it("laps.ts imports nothing from fastest-lap.ts: the judge is the whole seam", () => {
    const source = readFileSync(new URL("./laps.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);

    // The matcher sees this module's imports (so an empty match could not pass vacuously).
    expect(specifiers).toContain("./pit-lap.js");
    expect(specifiers).toContain("../state.js");
    expect(specifiers.filter((s) => s.includes("fastest-lap"))).toEqual([]);
  });
});

describe("lap.completed pit laps (issue #1163)", () => {
  /** Drive one tick; `onPitRoad` is the player's `OnPitRoad`. */
  function drive(
    state: ReturnType<typeof createInitialState>,
    emit: (e: PendingEvent) => void,
    lapCompleted: number,
    lapLastLapTime: number,
    onPitRoad: boolean,
    playerResults: PlayerResultsForLap = synced(),
    now: number = NOW,
  ): void {
    diffLaps(
      state,
      tick({ LapCompleted: lapCompleted, LapLastLapTime: lapLastLapTime, OnPitRoad: onPitRoad }),
      "race",
      null,
      playerResults,
      now,
      emit,
    );
  }

  it("a lap run wholly off pit road carries neither field", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    drive(state, emit, 0, 0, false);
    drive(state, emit, 1, 95, false);

    const laps = lapEvents(events);
    expect(laps).toHaveLength(1);
    expect(laps[0]!.data.isOutLap).toBeUndefined();
    expect(laps[0]!.data.isInLap).toBeUndefined();
  });

  it("a lap that enters pit road is an in lap; the crossing made on pit road ends it and opens an out lap", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    drive(state, emit, 0, 0, false);
    drive(state, emit, 1, 95, false);
    // Lap 2 in progress: the car dives into the pits.
    drive(state, emit, 1, 95, true);
    // The crossing on pit road closes lap 2 and opens lap 3 on pit road.
    drive(state, emit, 2, 130, true);
    // Lap 3: the car drives out and completes it.
    drive(state, emit, 2, 130, false);
    drive(state, emit, 3, 96, false);

    const laps = lapEvents(events).map((e) => e.data);
    expect(laps).toHaveLength(3);
    expect(laps[1]).toMatchObject({ lap: 2, isInLap: true });
    expect(laps[1]!.isOutLap).toBeUndefined();
    expect(laps[2]).toMatchObject({ lap: 3, isOutLap: true });
    expect(laps[2]!.isInLap).toBeUndefined();
  });

  it("a lap that enters pit road, drives out and completes off it is still an in lap", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    drive(state, emit, 0, 0, false);
    drive(state, emit, 1, 95, false);
    drive(state, emit, 1, 95, true);
    drive(state, emit, 1, 95, false);
    drive(state, emit, 2, 130, false);

    const laps = lapEvents(events).map((e) => e.data);
    expect(laps[1]).toMatchObject({ lap: 2, isInLap: true });
    expect(laps[1]!.isOutLap).toBeUndefined();
  });

  it("a pit entry between the crossing and the lap-time refresh belongs to the next lap, not the one reported", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    drive(state, emit, 0, 0, false);
    drive(state, emit, 1, 95, false);
    // The counter moves to 2 while the time is still lap 1's.
    drive(state, emit, 2, 95, false);
    // Pit entry on the next tick, still before the refresh.
    drive(state, emit, 2, 95, true);
    // The refresh lands: lap 2 is reported, and was run wholly off pit road.
    drive(state, emit, 2, 96, true);
    // Lap 3 is the in lap.
    drive(state, emit, 3, 130, true);

    const laps = lapEvents(events).map((e) => e.data);
    expect(laps).toHaveLength(3);
    expect(laps[1]).toMatchObject({ lap: 2, lapTime: 96 });
    expect(laps[1]!.isInLap).toBeUndefined();
    expect(laps[1]!.isOutLap).toBeUndefined();
    expect(laps[2]).toMatchObject({ lap: 3, isInLap: true });
  });

  it("a pit entry during the standings wait belongs to the next lap too", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    drive(state, emit, 0, 0, false);
    drive(state, emit, 1, 95, false);
    const stale: PlayerResultsForLap = { lapsComplete: 1, position: 3, classPosition: 2 };
    // Lap 2's time refreshed, standings behind: the emit waits.
    drive(state, emit, 2, 96, false, stale, NOW);
    drive(state, emit, 2, 96, true, stale, NOW + 100);
    // The standings catch up with the car on pit road.
    drive(state, emit, 2, 96, true, synced(), NOW + 200);

    const laps = lapEvents(events).map((e) => e.data);
    expect(laps).toHaveLength(2);
    expect(laps[1]).toMatchObject({ lap: 2 });
    expect(laps[1]!.isInLap).toBeUndefined();

    drive(state, emit, 3, 130, true);
    expect(lapEvents(events)[2]!.data).toMatchObject({ lap: 3, isInLap: true });
  });

  it("a connect in the pit stall opens the first lap as an out lap", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    drive(state, emit, 0, 0, true);
    drive(state, emit, 0, 0, false);
    drive(state, emit, 1, 95, false);

    const laps = lapEvents(events).map((e) => e.data);
    expect(laps[0]).toMatchObject({ lap: 1, isOutLap: true });
    expect(laps[0]!.isInLap).toBeUndefined();
  });

  it("a session change drops the latch of the old session's lap", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    // Every tick carries its session, so the reset branch (a SessionNum that
    // differs from the last one seen) is what runs, not a counter that moves.
    const step = (session: number, completed: number, last: number, onPitRoad: boolean): void =>
      diffLaps(
        state,
        tick({ SessionNum: session, LapCompleted: completed, LapLastLapTime: last, OnPitRoad: onPitRoad }),
        "race",
        null,
        synced(),
        NOW,
        emit,
      );
    step(0, 0, 0, false);
    step(0, 1, 95, false);
    // Lap 2 in progress enters the pits...
    step(0, 1, 95, true);
    // ...then the session changes with the counter unchanged, the car off pit
    // road on the first tick.
    step(1, 1, 0, false);
    step(1, 2, 97, false);

    const laps = lapEvents(events).map((e) => e.data);
    expect(laps).toHaveLength(2);
    expect(laps[1]).toMatchObject({ lap: 2, lapTime: 97 });
    expect(laps[1]!.isInLap).toBeUndefined();
    expect(laps[1]!.isOutLap).toBeUndefined();
  });
});
