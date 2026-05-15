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
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffLaps, type LapSessionType } from "./laps.js";
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

describe("diffLaps — seeding", () => {
  it("does not emit on the first tick when connecting cleanly", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick(), "race", emit);

    expect(lapEvents(events)).toHaveLength(0);
    expect(state.lapCompletedInitialized).toBe(true);
    expect(state.lastLapCompletedCounter).toBe(0);
    expect(state.lastLapBestLapTime).toBe(0);
  });

  it("does not emit on the first tick when connecting mid-session (existing best)", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ LapCompleted: 3, LapLastLapTime: 64.2, LapBestLapTime: 63.8 }), "race", emit);

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
    diffLaps(state, tick({ LapCompleted: 1, LapLastLapTime: 63.8, LapBestLapTime: 63.8 }), "race", emit);
    // Lap 2 completed at 64.5 — slower, best stays put.
    diffLaps(state, tick({ LapCompleted: 2, LapLastLapTime: 64.5, LapBestLapTime: 63.8 }), "race", emit);

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
    diffLaps(state, tick({ LapCompleted: 1, LapLastLapTime: 64.2, LapBestLapTime: 64.2 }), "race", emit);
    diffLaps(state, tick({ LapCompleted: 2, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }), "race", emit);

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
    diffLaps(state, tick({ LapCompleted: 1, LapLastLapTime: 64.2, LapBestLapTime: 64.2 }), "race", emit);
    expect(state.lastLapBestLapTime).toBe(64.2);

    // Intermediate ticks: iRacing publishes the new best ahead of the counter
    // bump. The baseline MUST NOT move on these ticks.
    diffLaps(state, tick({ LapCompleted: 1, LapLastLapTime: 64.2, LapBestLapTime: 63.4 }), "race", emit);
    expect(state.lastLapBestLapTime).toBe(64.2);
    diffLaps(state, tick({ LapCompleted: 1, LapLastLapTime: 64.2, LapBestLapTime: 63.4 }), "race", emit);
    expect(state.lastLapBestLapTime).toBe(64.2);

    // Counter finally increments; lapLastLapTime now matches the already-
    // committed best.
    diffLaps(state, tick({ LapCompleted: 2, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }), "race", emit);

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
    diffLaps(state, tick({ LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }), "race", emit);
    // Lap 1 — first timed lap of the session.
    diffLaps(state, tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }), "race", emit);

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
      emit,
    );
    diffLaps(
      state,
      tick({ SessionNum: 0, LapCompleted: 2, LapLastLapTime: 58.9, LapBestLapTime: 58.9 }),
      "practice",
      emit,
    );
    // Switch to qualifying (SessionNum=1).
    diffLaps(state, tick({ SessionNum: 1, LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }), "qualifying", emit);
    // First qualifying lap completes — slower than the practice PB but it
    // IS the first valid lap of qualifying.
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 1, LapLastLapTime: 64.5, LapBestLapTime: 64.5 }),
      "qualifying",
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
      emit,
    );
    // Switch to qualifying with LapCompleted dropping to 0 — without the
    // reset, the counter baseline would still be 12 and the first qualifying
    // completions would all be "no transition".
    diffLaps(state, tick({ SessionNum: 1, LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }), "qualifying", emit);
    diffLaps(
      state,
      tick({ SessionNum: 1, LapCompleted: 1, LapLastLapTime: 65.0, LapBestLapTime: 65.0 }),
      "qualifying",
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
    diffLaps(state, tick({ SessionNum: 1, LapCompleted: 1, LapLastLapTime: 64.0, LapBestLapTime: 64.0 }), "race", emit);
    diffLaps(state, tick({ SessionNum: 1, LapCompleted: 2, LapLastLapTime: 63.0, LapBestLapTime: 63.0 }), "race", emit);

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
    diffLaps(state, tick({ LapCompleted: -1, LapLastLapTime: 0, LapBestLapTime: 0 }), "race", emit);
    diffLaps(state, tick({ LapCompleted: -1, LapLastLapTime: 0, LapBestLapTime: 0 }), "race", emit);

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
    diffLaps(state, tick({ LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }), "practice", emit);
    diffLaps(state, tick({ LapCompleted: 1, LapLastLapTime: 37.1, LapBestLapTime: 37.1 }), "practice", emit);
    expect(lapEvents(events)).toHaveLength(1);
    expect(state.lastEmittedLapTime).toBe(37.1);

    // Lap 2 begins. `LapCompleted` increments to 2 but iRacing hasn't yet
    // refreshed `LapLastLapTime` — still shows 37.1. The diff must wait.
    diffLaps(state, tick({ LapCompleted: 2, LapLastLapTime: 37.1, LapBestLapTime: 37.1 }), "practice", emit);
    expect(lapEvents(events)).toHaveLength(1);

    // A tick later iRacing refreshes the field to lap 2's actual time.
    diffLaps(state, tick({ LapCompleted: 2, LapLastLapTime: 36.4, LapBestLapTime: 36.4 }), "practice", emit);

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
    diffLaps(state, tick({ LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }), "race", emit);
    // Counter ticks up but LapLastLapTime hasn't settled — no event yet.
    diffLaps(state, tick({ LapCompleted: 1, LapLastLapTime: 0, LapBestLapTime: 0 }), "race", emit);

    expect(lapEvents(events)).toHaveLength(0);
    // The next tick settles the lap time and the event fires.
    diffLaps(state, tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }), "race", emit);

    const fired = lapEvents(events);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.lap).toBe(1);
    expect(fired[0].data.lapTime).toBe(63.4);
  });

  it("does not synthesize an event on a session reset (counter decreases)", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ LapCompleted: 12, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }), "race", emit);
    // Practice → race flips LapCompleted 12 → 0.
    diffLaps(state, tick({ LapCompleted: 0, LapLastLapTime: 0, LapBestLapTime: 0 }), "race", emit);

    expect(lapEvents(events)).toHaveLength(0);
  });
});

describe("diffLaps — payload pass-through", () => {
  it("populates lapsRemaining when SessionLapsRemainEx is set", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ LapCompleted: 0, SessionLapsRemainEx: 10 }), "race", emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4, SessionLapsRemainEx: 9 }),
      "race",
      emit,
    );

    expect(lapEvents(events)[0].data.lapsRemaining).toBe(9);
  });

  it("populates timeRemaining when SessionTimeRemain is set", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ LapCompleted: 0 }), "race", emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4, SessionTimeRemain: 1234.5 }),
      "race",
      emit,
    );

    expect(lapEvents(events)[0].data.timeRemaining).toBe(1234.5);
  });

  it("omits sessionType when undefined", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    diffLaps(state, tick({ LapCompleted: 0 }), undefined, emit);
    diffLaps(
      state,
      tick({ LapCompleted: 1, LapLastLapTime: 63.4, LapBestLapTime: 63.4 }),
      undefined as LapSessionType | undefined,
      emit,
    );

    expect(lapEvents(events)[0].data.sessionType).toBeUndefined();
  });
});
