import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { LapStartListEntry } from "@iracedeck/replay-store";
import { describe, expect, it, vi } from "vitest";

import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { lapMode, recordedLapAt } from "./replay-control-lap-mode.js";
import { fakeStepIo, lapsAt, recordSource, sessionsAt } from "./replay-dial-step-io.test-support.js";
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

describe("recordedLapAt", () => {
  it("is the lap whose landing, a second before the line, is the last at or before the frame", () => {
    const source = recordSource(LAPS, null);

    expect(recordedLapAt(54_000, listRecord("lap", source), 2)).toBe(2);
    // At the landing a lap step jumps to: that lap, not the one a second from finishing.
    expect(recordedLapAt(56_000 - 60, listRecord("lap", source), 2)).toBe(3);
    expect(recordedLapAt(56_000 - 61, listRecord("lap", source), 2)).toBe(2);
    expect(recordedLapAt(80_000, listRecord("lap", source), 2)).toBe(4);
  });

  it("is null when the lap found is another session's, or the session on screen is not known", () => {
    const listing = listRecord("lap", recordSource(QUALIFYING_THEN_RACE, null));

    // The race before the car's first race lap: its last qualifying lap is not its lap here.
    expect(recordedLapAt(45_000, listing, 2)).toBeNull();
    expect(recordedLapAt(45_000, listing, 1)).toBe(2);
    expect(recordedLapAt(51_000, listing, 2)).toBe(1);
    expect(recordedLapAt(54_000, listRecord("lap", recordSource(LAPS, null)), null)).toBeNull();
  });

  it("is null before the first recorded lap, with no store, no car on camera or no car number", () => {
    expect(recordedLapAt(10_000, listRecord("lap", recordSource(LAPS, null)), 2)).toBeNull();
    expect(recordedLapAt(54_000, listRecord("lap", { ...recordSource(LAPS, null), store: null }), 2)).toBeNull();
    expect(
      recordedLapAt(54_000, listRecord("lap", { ...recordSource(LAPS, null), camCarIdx: undefined }), 2),
    ).toBeNull();
    expect(recordedLapAt(54_000, listRecord("lap", recordSource(LAPS, null, 255)), 2)).toBeNull();
    expect(recordedLapAt(54_000, listRecord("lap", recordSource(LAPS, null, 7)), 2)).toBeNull();
    expect(recordedLapAt(54_000, listRecord("lap", recordSource(null, null)), 2)).toBeNull();
  });
});

describe("lapMode view", () => {
  it("shows the viewed car's lap from the record at the cursor", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(LAPS, null));
    io.telemetry.mockReturnValue(onSession(2));
    io.position.mockReturnValue({ frame: 57_000, time: 950, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io)).toMatchObject({ value: "L3", caption: "PAUSED" });
  });

  it("shows the lap at the pending landing while a jump is under way", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(LAPS, SESSIONS));
    io.position.mockReturnValue({ frame: 59_000 - 60, time: undefined, endFrame: undefined, seeking: true });

    expect(lapMode.view(dial, io).value).toBe("L4");
  });

  it("shows the replay time, not an earlier session's lap, before the car's first lap of the session on screen", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(QUALIFYING_THEN_RACE, SESSIONS));
    io.telemetry.mockReturnValue(onSession(2));
    io.position.mockReturnValue({ frame: 45_000, time: 750, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io).value).toBe("12:30");

    // Once it has crossed the line in the race, the race lap.
    io.position.mockReturnValue({ frame: 51_000, time: 850, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io).value).toBe("L1");
  });

  it("judges a pending landing's session from the record, not the qualifying lap before it", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(QUALIFYING_THEN_RACE, SESSIONS));
    io.position.mockReturnValue({ frame: 40_120, time: undefined, endFrame: undefined, seeking: true });

    expect(lapMode.view(dial, io).value).toBe("");
  });

  it("shows the replay time when the replay reads no session", () => {
    const io = fakeStepIo();

    io.recordSource.mockReturnValue(recordSource(LAPS, null));
    io.position.mockReturnValue({ frame: 57_000, time: 950, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io).value).toBe("15:50");
  });

  it("shows the replay time, m:ss, with no recorded lap for the car at the cursor", () => {
    const io = fakeStepIo();

    io.position.mockReturnValue({ frame: 5_000, time: 83.5, endFrame: undefined, seeking: false });

    expect(lapMode.view(dial, io).value).toBe("1:23");
  });

  it("says nothing on a tick read mid-seek, so the box keeps what it showed", () => {
    const io = fakeStepIo();

    io.position.mockReturnValue(null);

    expect(lapMode.view(dial, io).value).toBeNull();
  });

  it("shows the search's count in the caption while it works for laps", () => {
    const io = fakeStepIo();

    io.pendingSearch.mockImplementation((target) => (target === "lap" ? -2 : null));

    expect(lapMode.view(dial, io).caption).toBe("-2");
  });

  it("is labelled LAP and describes its turn", () => {
    expect(lapMode.label).toBe("LAP");
    expect(lapMode.rotateDescription).toBe("Next / previous lap");
  });
});
