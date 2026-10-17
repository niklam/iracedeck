import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it, vi } from "vitest";

import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { recordedSessionAt, sessionMode, sessionName } from "./replay-control-session-mode.js";
import { fakeStepIo, recordSource, sessionsAt } from "./replay-dial-step-io.test-support.js";
import { listRecord } from "./replay-record-step.js";

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

describe("recordedSessionAt", () => {
  it("is the last recorded session start at or before the frame", () => {
    const source = recordSource(null, SESSIONS);

    expect(recordedSessionAt(0, listRecord("session", source))).toBe(0);
    expect(recordedSessionAt(60_120, listRecord("session", source))).toBe(1);
    expect(recordedSessionAt(59_999, listRecord("session", source))).toBe(0);
    expect(recordedSessionAt(200_000, listRecord("session", source))).toBe(2);
  });

  it("is null with no store or no listing", () => {
    expect(
      recordedSessionAt(1_000, listRecord("session", { ...recordSource(null, SESSIONS), store: null })),
    ).toBeNull();
    expect(recordedSessionAt(1_000, listRecord("session", recordSource(null, null)))).toBeNull();
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

    expect(sessionMode.view(dial, io)).toMatchObject({ value: "OPEN QUALIFY", caption: "PAUSED" });
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
