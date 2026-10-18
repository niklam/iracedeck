import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it, vi } from "vitest";

import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { sessionMode, sessionName } from "./replay-control-session-mode.js";
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

const dial = ReplayControlDialSettings.parse({ mode: "session" });

const SESSION_INFO = {
  SessionInfo: {
    Sessions: [
      { SessionNum: 0, SessionType: "Practice" },
      { SessionNum: 1, SessionType: "Open Qualify" },
      { SessionNum: 2, SessionType: "Race" },
    ],
  },
};

const SESSIONS = sessionsAt([0, 60_000, 150_000]);

const RACE = SESSION_INFO.SessionInfo.Sessions[2];

describe("sessionName", () => {
  it("is the session's type, upper-cased", () => {
    expect(sessionName(SESSION_INFO, 0)).toBe("PRACTICE");
    expect(sessionName(SESSION_INFO, 1)).toBe("OPEN QUALIFY");
    expect(sessionName(SESSION_INFO, 2)).toBe("RACE");
  });

  it("is S and the number when the session info does not list the session or gives it no type", () => {
    expect(sessionName(SESSION_INFO, 3)).toBe("S3");
    expect(sessionName(null, 1)).toBe("S1");
    expect(sessionName({ SessionInfo: { Sessions: [{ SessionNum: 1, SessionType: " " }] } }, 1)).toBe("S1");
  });
});

describe("sessionMode view", () => {
  it("shows the cursor's session by ReplaySessionNum", () => {
    const io = fakeStepIo();

    io.sessionInfo.mockReturnValue(SESSION_INFO);
    io.telemetry.mockReturnValue({
      IsReplayPlaying: true,
      ReplayFrameNum: 70_000,
      ReplaySessionNum: 1,
    } as TelemetryData);

    // No record, and no laps in the session info: the lap is unknown and there is no count.
    expect(sessionMode.view(dial, io)).toMatchObject({ value: "OPEN QUALIFY", caption: "--" });
  });

  it("captions the viewed car's lap over the laps in the session, as Lap's value", () => {
    const io = fakeStepIo();

    io.sessionInfo.mockReturnValue({
      SessionInfo: { Sessions: [...SESSION_INFO.SessionInfo.Sessions.slice(0, 2), { ...RACE, SessionLaps: 25 }] },
    });
    // Car 4's laps 1-3 of the race (session 2), the line crossed at 160 000, 163 000 and 166 000.
    io.recordSource.mockReturnValue(recordSource(lapsAt([160_000, 163_000, 166_000]), SESSIONS));
    io.telemetry.mockReturnValue({ IsReplayPlaying: true, ReplaySessionNum: 2, CamCarIdx: 4 } as TelemetryData);
    io.position.mockReturnValue({ frame: 164_000, time: 2_733, endFrame: undefined, seeking: false });

    expect(sessionMode.view(dial, io)).toMatchObject({ value: "RACE", caption: "2/25" });

    // Without the record, scrubbed back in an in-session replay, the lap on screen is not known.
    io.recordSource.mockReturnValue(recordSource(null, SESSIONS));
    expect(sessionMode.view(dial, io).caption).toBe("--/25");
  });

  it("captions telemetry's lap without the record where the per-car arrays are the replay's own", () => {
    const io = fakeStepIo();

    io.sessionInfo.mockReturnValue({
      SessionInfo: { Sessions: [...SESSION_INFO.SessionInfo.Sessions.slice(0, 2), { ...RACE, SessionLaps: 25 }] },
    });
    io.recordSource.mockReturnValue(recordSource(null, null));
    io.position.mockReturnValue({ frame: 164_000, time: 2_733, endFrame: undefined, seeking: false });

    const race = (extra: Partial<TelemetryData>) =>
      ({ IsReplayPlaying: true, ReplaySessionNum: 2, CamCarIdx: 4, ...extra }) as TelemetryData;

    // A saved replay iRaceDeck never recorded: car 4 has completed 13.
    io.isSavedReplay.mockReturnValue(true);
    io.telemetry.mockReturnValue(race({ CarIdxLapCompleted: [0, 0, 0, 0, 13] }));
    expect(sessionMode.view(dial, io)).toMatchObject({ value: "RACE", caption: "14/25" });

    // An in-session replay: at the live edge the same, scrubbed back unknown.
    io.isSavedReplay.mockReturnValue(false);
    io.telemetry.mockReturnValue(race({ CarIdxLapCompleted: [0, 0, 0, 0, 13], ReplayFrameNumEnd: 1 }));
    expect(sessionMode.view(dial, io).caption).toBe("14/25");

    io.telemetry.mockReturnValue(race({ CarIdxLapCompleted: [0, 0, 0, 0, -1], ReplayFrameNumEnd: 40_182 }));
    expect(sessionMode.view(dial, io).caption).toBe("--/25");
  });

  it("shows the search's count in the caption while it works for sessions, and keeps it on a tick read mid-seek", () => {
    const io = fakeStepIo();

    io.pendingSearch.mockImplementation((target) => (target === "session" ? -2 : null));
    expect(sessionMode.view(dial, io).caption).toBe("-2");

    io.pendingSearch.mockReturnValue(null);
    io.position.mockReturnValue(null);
    expect(sessionMode.view(dial, io).caption).toBeNull();
  });

  it("shows the session the record puts the pending landing in while a jump is under way", () => {
    const io = fakeStepIo();

    io.sessionInfo.mockReturnValue(SESSION_INFO);
    io.recordSource.mockReturnValue(recordSource(null, SESSIONS));
    // Mid-seek the reading says session 0; the record says where the jump lands.
    io.telemetry.mockReturnValue({ IsReplayPlaying: false, ReplayFrameNum: 0, ReplaySessionNum: 0 } as TelemetryData);
    io.position.mockReturnValue({ frame: 150_120, time: undefined, endFrame: undefined, seeking: true });

    expect(sessionMode.view(dial, io).value).toBe("RACE");
  });

  it("says nothing while a jump is under way without a record, and on a tick read mid-seek", () => {
    const io = fakeStepIo();

    io.position.mockReturnValue({ frame: 150_120, time: undefined, endFrame: undefined, seeking: true });
    expect(sessionMode.view(dial, io).value).toBeNull();

    io.position.mockReturnValue(null);
    expect(sessionMode.view(dial, io).value).toBeNull();
  });

  it("dims the side with no recorded session that way, and lights both with no record", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(null, SESSIONS));
    io.position.mockReturnValue({ frame: 160_000, time: undefined, endFrame: undefined, seeking: false });
    expect(sessionMode.view(dial, io).sides).toEqual({ left: true, right: false });

    io.recordSource.mockReturnValue(recordSource(null, null));
    expect(sessionMode.view(dial, io).sides).toEqual({ left: true, right: true });
  });

  it("is labelled SESSION and describes its turn", () => {
    expect(sessionMode.label).toBe("SESSION");
    expect(sessionMode.rotateDescription).toBe("Next / previous session");
  });
});
