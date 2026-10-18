import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { LapStartListEntry } from "@iracedeck/replay-store";
import { describe, expect, it, vi } from "vitest";

import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { lapMode } from "./replay-control-lap-mode.js";
import { fakeStepIo, lapsAt, recordSource, sessionsAt } from "./replay-dial-step-io.test-support.js";

vi.mock("@iracedeck/settings", () => ({ getGlobalSettings: vi.fn(() => ({})) }));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: vi.fn(() => {
    throw new Error("a mode sends nothing but through its io");
  }),
  getController: vi.fn(() => {
    throw new Error("a mode reads nothing but through its io");
  }),
}));

const dial = ReplayControlDialSettings.parse({ mode: "lap" });

/** Laps 1-4 of car 4 in session 2, the line crossed at 50 000, 53 000, 56 000 and 59 000. */
const LAPS = lapsAt([50_000, 53_000, 56_000, 59_000]);

/** Sessions 0, 1 and 2 starting at 0, 10 000 and 40 000. */
const SESSIONS = sessionsAt([0, 10_000, 40_000]);

/**
 * Car 4's laps 1-2 of qualifying (session 1) at 20 000 and 23 000, then the
 * race (session 2, from 40 000) with its first race lap crossing at 50 000.
 */
const QUALIFYING_THEN_RACE: LapStartListEntry[] = [
  { frame: 20_000, lap: 1, sessionNum: 1, sessionUniqueId: 1 },
  { frame: 23_000, lap: 2, sessionNum: 1, sessionUniqueId: 1 },
  { frame: 50_000, lap: 1, sessionNum: 2, sessionUniqueId: 1 },
];

/** Telemetry on the replay's own reading of session `sessionNum`. */
function onSession(sessionNum: number): TelemetryData {
  return { IsReplayPlaying: true, ReplaySessionNum: sessionNum } as TelemetryData;
}

describe("lapMode view", () => {
  /** Session 2 scheduled for 25 laps; sessions 0 and 1 unlimited, with car 4's results in session 1. */
  const SESSION_INFO = {
    SessionInfo: {
      Sessions: [
        { SessionNum: 0, SessionLaps: "unlimited", ResultsPositions: null },
        { SessionNum: 1, SessionLaps: "unlimited", ResultsPositions: [{ CarIdx: 4, LapsComplete: 9 }] },
        { SessionNum: 2, SessionLaps: 25 },
      ],
    },
  };

  /** Telemetry on the replay's own reading of session `sessionNum`, the camera on car 4. */
  function onCar4(sessionNum: number): TelemetryData {
    return { ...onSession(sessionNum), CamCarIdx: 4 } as TelemetryData;
  }

  it("shows the viewed car's lap from the record over the session's laps, and the replay time beneath", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(LAPS, null));
    io.sessionInfo.mockReturnValue(SESSION_INFO);
    io.telemetry.mockReturnValue(onCar4(2));
    io.position.mockReturnValue({ frame: 57_000, time: 950, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io)).toMatchObject({ value: "3/25", caption: "15:50" });
  });

  it("counts an unlimited session's laps from the car's results, else from the record, else not at all", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(LAPS, SESSIONS));
    io.telemetry.mockReturnValue(onCar4(2));
    io.position.mockReturnValue({ frame: 57_000, time: 950, endFrame: undefined, seeking: false });

    // Session 2 unlimited, with car 4 in its results: the laps it completed.
    io.sessionInfo.mockReturnValue({
      SessionInfo: {
        Sessions: [{ SessionNum: 2, SessionLaps: "unlimited", ResultsPositions: [{ CarIdx: 4, LapsComplete: 7 }] }],
      },
    });
    expect(lapMode.view(dial, io).value).toBe("3/7");

    // No results yet: the highest lap the record holds for the car in it.
    io.sessionInfo.mockReturnValue({ SessionInfo: { Sessions: [{ SessionNum: 2, SessionLaps: "unlimited" }] } });
    expect(lapMode.view(dial, io).value).toBe("3/4");

    // No record either: no denominator, and the lap is unknown.
    io.recordSource.mockReturnValue(recordSource(null, null));
    expect(lapMode.view(dial, io).value).toBe("--");
  });

  it("reads --/25 without the record, scrubbed back in an in-session replay, the lap on screen being unknown", () => {
    const io = fakeStepIo();

    io.sessionInfo.mockReturnValue(SESSION_INFO);
    io.telemetry.mockReturnValue({ ...onCar4(2), CarIdxLapCompleted: [0, 0, 0, 0, -1], ReplayFrameNumEnd: 40_182 });
    io.position.mockReturnValue({ frame: 57_000, time: 950, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io)).toMatchObject({ value: "--/25", caption: "15:50" });
  });

  it("reads the lap from telemetry without the record in a saved replay, CarIdxLapCompleted + 1", () => {
    const io = fakeStepIo();

    io.isSavedReplay.mockReturnValue(true);
    io.sessionInfo.mockReturnValue(SESSION_INFO);
    io.telemetry.mockReturnValue({ ...onCar4(2), CarIdxLapCompleted: [0, 0, 0, 0, 13] });
    io.position.mockReturnValue({ frame: 57_000, time: 950, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io)).toMatchObject({ value: "14/25", caption: "15:50" });
  });

  it("shows the lap at the pending landing while a jump is under way, and the target's time beneath", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(LAPS, SESSIONS));
    io.sessionInfo.mockReturnValue(SESSION_INFO);
    io.telemetry.mockReturnValue({ IsReplayPlaying: false, ReplayFrameNum: 0, CamCarIdx: 4 } as TelemetryData);
    io.position.mockReturnValue({ frame: 59_000 - 60, time: 982, endFrame: undefined, seeking: true });

    expect(lapMode.view(dial, io)).toMatchObject({ value: "4/25", caption: "16:22" });
  });

  it("does not show an earlier session's lap before the car's first lap of the session on screen", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(QUALIFYING_THEN_RACE, SESSIONS));
    io.sessionInfo.mockReturnValue(SESSION_INFO);
    io.telemetry.mockReturnValue(onCar4(2));
    io.position.mockReturnValue({ frame: 45_000, time: 750, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io)).toMatchObject({ value: "--/25", caption: "12:30" });

    // Once it has crossed the line in the race, the race lap.
    io.position.mockReturnValue({ frame: 51_000, time: 850, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io).value).toBe("1/25");
  });

  it("counts the record's laps of the session on screen only, not an earlier session's", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(QUALIFYING_THEN_RACE, SESSIONS));
    io.telemetry.mockReturnValue(onCar4(1));
    io.sessionInfo.mockReturnValue({ SessionInfo: { Sessions: [{ SessionNum: 1, SessionLaps: "unlimited" }] } });
    io.position.mockReturnValue({ frame: 21_000, time: 350, endFrame: undefined, seeking: false });

    // Qualifying lap 1 of the two the record holds there; the race lap is another session's.
    expect(lapMode.view(dial, io).value).toBe("1/2");
  });

  it("judges a pending landing's session from the record, not the qualifying lap before it", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(QUALIFYING_THEN_RACE, SESSIONS));
    io.sessionInfo.mockReturnValue(SESSION_INFO);
    io.position.mockReturnValue({ frame: 40_120, time: undefined, endFrame: undefined, seeking: true });

    expect(lapMode.view(dial, io).value).toBe("--/25");
  });

  it("reads -- when the replay reads no session, and no caption, its line kept, with no time to show", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(LAPS, null));
    io.position.mockReturnValue({ frame: 57_000, time: undefined, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io)).toMatchObject({ value: "--", caption: "", reserveCaption: true });
  });

  it("says nothing on a tick read mid-seek, value or caption, so the box keeps what it showed", () => {
    const io = fakeStepIo();

    io.position.mockReturnValue(null);

    expect(lapMode.view(dial, io)).toMatchObject({ value: null, caption: null });
  });

  it("shows the search's count in the caption while it works for laps, in place of the time", () => {
    const io = fakeStepIo();

    io.pendingSearch.mockImplementation((target) => (target === "lap" ? -2 : null));

    expect(lapMode.view(dial, io).caption).toBe("-2");

    io.pendingSearch.mockImplementation((target) => (target === "session" ? -2 : null));

    expect(lapMode.view(dial, io).caption).toBe("1:23");
  });

  it("is labelled LAP and describes its turn", () => {
    expect(lapMode.label).toBe("LAP");
    expect(lapMode.rotateDescription).toBe("Next / previous lap");
  });
});
