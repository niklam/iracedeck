/**
 * Unit tests for the lap-completion diff (issue #555).
 *
 * Pins:
 *   - first-tick seeding (no fire on connect mid-session)
 *   - regular non-best lap completion fires with isBest=false
 *   - new personal best with a prior best fires with isBest=true,
 *     previousBestLapTime set
 *   - first valid lap (no prior best) fires with isFirstValid=true and
 *     isBest=true
 *   - pace laps (LapCompleted=-1) are suppressed
 *   - LapLastLapTime=0 at increment defers emission to the next tick
 *   - sessionType / lapsRemaining / timeRemaining pass through
 *   - sentinel session-info-absent (undefined sessionType) omits the field
 *   - session reset (LapCompleted decreases) does not synthesize an event
 */
import { Flags, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffLaps, LAP_RESULTS_SYNC_MAX_WAIT_MS, type LapSessionType, type PlayerResultsForLap } from "./laps.js";
import type { PendingEvent } from "./types.js";

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
      tick({ LapCompleted: 1, LapLastLapTime: 63.8, LapBestLapTime: 63.8 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 64.2, LapBestLapTime: 64.2 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ LapCompleted: 2, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
    // Regression: iRacing sometimes commits the new `LapBestLapTime` a tick or
    // two BEFORE `LapCompleted` increments. If the no-transition branch
    // tracked the live telemetry value, `previousBest` at completion would
    // already equal the new best and `isBest` would resolve to false — the
    // scenario's `where:` would then suppress the callout. This pins the
    // frozen-baseline behavior that prevents the race.
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 64.2, LapBestLapTime: 64.2 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 64.2, LapBestLapTime: 63.4 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );
    expect(state.lastLapBestLapTime).toBe(64.2);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 64.2, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 2, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ SessionNum: 0, LapCompleted: 1, LapLastLapTime: 60.2, LapBestLapTime: 60.2 }),
      "practice",
      null,
      synced(),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ SessionNum: 0, LapCompleted: 2, LapLastLapTime: 58.9, LapBestLapTime: 58.9 }),
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
      tick({ SessionNum: 1, LapCompleted: 1, LapLastLapTime: 64.5, LapBestLapTime: 64.5 }),
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
      tick({ SessionNum: 0, LapCompleted: 12, LapLastLapTime: 60.0, LapBestLapTime: 60.0 }),
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
      tick({ SessionNum: 1, LapCompleted: 1, LapLastLapTime: 65.0, LapBestLapTime: 65.0 }),
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
      tick({ SessionNum: 1, LapCompleted: 1, LapLastLapTime: 64.0, LapBestLapTime: 64.0 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 2, LapLastLapTime: 63.0, LapBestLapTime: 63.0 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 37.1, LapBestLapTime: 37.1 }),
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
      tick({ LapCompleted: 2, LapLastLapTime: 37.1, LapBestLapTime: 37.1 }),
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
      tick({ LapCompleted: 2, LapLastLapTime: 36.4, LapBestLapTime: 36.4 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 12, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4, SessionLapsRemainEx: 9 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4, SessionTimeRemain: 1234.5 }),
      "race",
      null,
      synced(),
      NOW,
      emit,
    );

    expect(lapEvents(events)[0].data.timeRemaining).toBe(1234.5);
  });

  it("omits sessionType when undefined", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ LapCompleted: 0 }), undefined, null, synced(), NOW, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4, PlayerCarPosition: 0 }),
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
      tick({ SessionNum: 0, LapCompleted: 1, LapLastLapTime: 60.0, LapBestLapTime: 60.0 }),
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
      tick({ SessionNum: 1, LapCompleted: 1, LapLastLapTime: 64.0, LapBestLapTime: 64.0 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4, PlayerCarPosition: 7 }),
      "race",
      false,
      null,
      NOW,
      emit,
    );
    expect(lapEvents(events)).toHaveLength(0);

    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4, PlayerCarPosition: 7 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.0, LapBestLapTime: 63.0 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.0, LapBestLapTime: 63.0 }),
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
      tick({ LapCompleted: 1, LapLastLapTime: 63.0, LapBestLapTime: 63.0 }),
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
      tick({ SessionNum: 0, LapCompleted: 1, LapLastLapTime: 60.0, LapBestLapTime: 60.0 }),
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
});

describe("diffLaps — race.finished (issue #569)", () => {
  function raceFinishedEvents(events: PendingEvent[]): Array<Extract<PendingEvent, { event: "race.finished" }>> {
    return events.filter((e): e is Extract<PendingEvent, { event: "race.finished" }> => e.event === "race.finished");
  }

  it("emits race.finished once when checkered + lap.completed land in a race session", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);

    diffLaps(
      state,
      tick({
        LapCompleted: 5,
        LapLastLapTime: 63.0,
        LapBestLapTime: 63.0,
        SessionFlags: Flags.Checkered,
      }),
      "race",
      false,
      synced(3, 3),
      NOW,
      emit,
    );

    const finished = raceFinishedEvents(events);
    expect(finished).toHaveLength(1);
    expect(finished[0].data.position).toBe(3);
    expect(state.raceFinishedFired).toBe(true);
  });

  it("does not re-emit race.finished on subsequent laps in the same session", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);
    diffLaps(
      state,
      tick({
        LapCompleted: 5,
        LapLastLapTime: 63.0,
        LapBestLapTime: 63.0,
        SessionFlags: Flags.Checkered,
      }),
      "race",
      false,
      synced(3, 3),
      NOW,
      emit,
    );
    // Another lap completes — checkered still raised, but the latch holds.
    diffLaps(
      state,
      tick({
        LapCompleted: 6,
        LapLastLapTime: 64.0,
        LapBestLapTime: 63.0,
        SessionFlags: Flags.Checkered,
      }),
      "race",
      false,
      synced(3, 3),
      NOW,
      emit,
    );

    expect(raceFinishedEvents(events)).toHaveLength(1);
  });

  it("does not emit race.finished in non-race sessions even with checkered flag", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "qualifying", false, synced(), NOW, emit);
    diffLaps(
      state,
      tick({
        LapCompleted: 5,
        LapLastLapTime: 63.0,
        LapBestLapTime: 63.0,
        SessionFlags: Flags.Checkered,
      }),
      "qualifying",
      false,
      synced(3, 3),
      NOW,
      emit,
    );

    expect(raceFinishedEvents(events)).toHaveLength(0);
    expect(state.raceFinishedFired).toBe(false);
  });

  it("defers the latch when position is missing so the next lap.completed retries", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", false, synced(), NOW, emit);
    // Lap with checkered but no position — latch should NOT flip.
    diffLaps(
      state,
      tick({
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

    // Next lap arrives with position resolved — emit + latch fire now.
    diffLaps(
      state,
      tick({
        LapCompleted: 6,
        LapLastLapTime: 64.0,
        LapBestLapTime: 63.0,
        SessionFlags: Flags.Checkered,
      }),
      "race",
      false,
      synced(4, 4),
      NOW,
      emit,
    );
    expect(raceFinishedEvents(events)).toHaveLength(1);
    expect(state.raceFinishedFired).toBe(true);
  });

  it("re-arms the latch on session change so a later race session can fire again", () => {
    const state = createInitialState();
    const { emit } = collect();
    diffLaps(state, tick({ SessionNum: 0 }), "race", false, synced(), NOW, emit);
    diffLaps(
      state,
      tick({
        SessionNum: 0,
        LapCompleted: 5,
        LapLastLapTime: 63.0,
        LapBestLapTime: 63.0,
        SessionFlags: Flags.Checkered,
      }),
      "race",
      false,
      synced(3, 3),
      NOW,
      emit,
    );
    expect(state.raceFinishedFired).toBe(true);

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
  });

  it("carries classPosition + isMultiClass into the race.finished payload", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", true, synced(), NOW, emit);
    diffLaps(
      state,
      tick({
        LapCompleted: 5,
        LapLastLapTime: 63.0,
        LapBestLapTime: 63.0,
        SessionFlags: Flags.Checkered,
      }),
      "race",
      true,
      synced(8, 2),
      NOW,
      emit,
    );

    const finished = raceFinishedEvents(events);
    expect(finished).toHaveLength(1);
    expect(finished[0].data.position).toBe(8);
    expect(finished[0].data.classPosition).toBe(2);
    expect(finished[0].data.isMultiClass).toBe(true);
  });
});
