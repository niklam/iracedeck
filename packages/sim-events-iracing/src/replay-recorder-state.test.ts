import { describe, expect, it } from "vitest";

import {
  createInitialReplayRecorderState,
  type ReplayRecorderState,
  resetReplayRecorderBaselines,
} from "./replay-recorder-state.js";
import { createInitialState } from "./state.js";

/** A state with every member moved off its initial value. */
function recordedState(): ReplayRecorderState {
  return {
    replayLapsSeeded: true,
    replayLapsSessionNum: 2,
    replayLapsSessionUniqueId: 7,
    replayLapsLastCompleted: [3, 4],
    replayLapsLastLapTime: [91.2, 92.4],
    replayLapsTimeWait: [{ lap: 3, baselineS: 91.2, ticksLeft: 10 }],

    replayGreensSeeded: true,
    replayGreensSessionNum: 2,
    replayGreensSessionUniqueId: 7,
    replayGreensLastSessionState: 4,
    replayGreensLastFlags: 0x4,

    replaySessionsCandidate: { subSessionId: 89660575, sessionNum: 2, sessionUniqueId: 7, start: 1200 },
    replaySessionsPublished: ["89660575:1:6"],
    replaySessionsLatestStart: { 89660575: 600 },

    replayIncidentsSeeded: true,
    replayIncidentsSessionNum: 2,
    replayIncidentsSessionUniqueId: 7,
    replayIncidentsLastPlayerCount: 4,
    replayIncidentsLastCarReadings: [{ count: 2, userId: 1001, carNumberRaw: 12 }],
  };
}

describe("createInitialReplayRecorderState", () => {
  it("starts every record unseeded and the session record empty", () => {
    const state = createInitialReplayRecorderState();

    expect(state.replayLapsSeeded).toBe(false);
    expect(state.replayGreensSeeded).toBe(false);
    expect(state.replayIncidentsSeeded).toBe(false);
    expect(state.replaySessionsCandidate).toBeNull();
    expect(state.replaySessionsPublished).toEqual([]);
    expect(state.replaySessionsLatestStart).toEqual({});
  });

  it("hands out a fresh object each time, so no two recorders share a baseline", () => {
    const a = createInitialReplayRecorderState();
    const b = createInitialReplayRecorderState();

    expect(a).not.toBe(b);
    expect(a.replaySessionsPublished).not.toBe(b.replaySessionsPublished);
    expect(a.replayLapsLastCompleted).not.toBe(b.replayLapsLastCompleted);
  });

  // The recorders' state is the replay recorder's alone (issue #1468): a member
  // left in `TranslatorState` too would be reset by the translator's wipes and
  // read by nobody, or read by a diff that should not see it.
  it("shares no member with the translator's state", () => {
    const recorderKeys = Object.keys(createInitialReplayRecorderState());
    const translatorKeys = new Set(Object.keys(createInitialState()));

    expect(recorderKeys).toHaveLength(19);
    expect(recorderKeys.filter((key) => translatorKeys.has(key))).toEqual([]);
  });
});

describe("resetReplayRecorderBaselines", () => {
  it("returns the lap, green and incident baselines to their initial values", () => {
    const reset = resetReplayRecorderBaselines(recordedState());
    const initial = createInitialReplayRecorderState();

    expect(reset).toEqual({
      ...initial,
      replaySessionsCandidate: reset.replaySessionsCandidate,
      replaySessionsPublished: reset.replaySessionsPublished,
      replaySessionsLatestStart: reset.replaySessionsLatestStart,
    });
  });

  it("keeps the session record, by reference", () => {
    const state = recordedState();
    const reset = resetReplayRecorderBaselines(state);

    expect(reset.replaySessionsCandidate).toBe(state.replaySessionsCandidate);
    expect(reset.replaySessionsPublished).toBe(state.replaySessionsPublished);
    expect(reset.replaySessionsLatestStart).toBe(state.replaySessionsLatestStart);
  });

  it("leaves the state it was given unchanged", () => {
    const state = recordedState();
    const before = structuredClone(state);

    const reset = resetReplayRecorderBaselines(state);

    expect(reset).not.toBe(state);
    expect(state).toEqual(before);
  });
});
