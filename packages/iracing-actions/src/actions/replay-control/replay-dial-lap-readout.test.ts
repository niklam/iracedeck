import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { LapStartListEntry } from "@iracedeck/replay-store";
import { describe, expect, it, vi } from "vitest";

import { lapOfLapsReadout, recordedLapAt, recordedMaxLap, recordedSessionAt } from "./replay-dial-lap-readout.js";
import { fakeStepIo, lapsAt, recordSource, sessionsAt } from "./replay-dial-step-io.test-support.js";
import { listRecord } from "./replay-record-step.js";

vi.mock("@iracedeck/settings", () => ({ getGlobalSettings: vi.fn(() => ({})) }));

vi.mock("@iracedeck/deck-iracing", () => ({
  getCommands: vi.fn(() => {
    throw new Error("a readout sends nothing");
  }),
  getController: vi.fn(() => {
    throw new Error("a readout reads nothing but through its io");
  }),
}));

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

/** Session 2 scheduled for 25 laps. */
const SCHEDULED = { SessionInfo: { Sessions: [{ SessionNum: 2, SessionLaps: 25 }] } };

/** Telemetry on the replay's own reading of session `sessionNum`, the camera on car 4. */
function onCar4(sessionNum: number): TelemetryData {
  return { IsReplayPlaying: true, ReplaySessionNum: sessionNum, CamCarIdx: 4 } as TelemetryData;
}

/** A position the replay reads as its own, at `frame`. */
function at(frame: number, seeking = false) {
  return { frame, time: frame / 60, endFrame: undefined, seeking };
}

describe("recordedSessionAt", () => {
  const STARTS = sessionsAt([0, 60_000, 150_000]);

  it("is the last recorded session start at or before the frame", () => {
    const source = recordSource(null, STARTS);

    expect(recordedSessionAt(0, listRecord("session", source))).toBe(0);
    expect(recordedSessionAt(60_120, listRecord("session", source))).toBe(1);
    expect(recordedSessionAt(59_999, listRecord("session", source))).toBe(0);
    expect(recordedSessionAt(200_000, listRecord("session", source))).toBe(2);
  });

  it("is null with no store or no listing, or handed a lap list", () => {
    expect(recordedSessionAt(1_000, listRecord("session", { ...recordSource(null, STARTS), store: null }))).toBeNull();
    expect(recordedSessionAt(1_000, listRecord("session", recordSource(null, null)))).toBeNull();
    expect(recordedSessionAt(55_000, listRecord("lap", recordSource(LAPS, STARTS)))).toBeNull();
  });
});

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

describe("recordedMaxLap", () => {
  it("is the highest lap the record holds for the car in the session", () => {
    const listing = listRecord("lap", recordSource(QUALIFYING_THEN_RACE, null));

    expect(recordedMaxLap(listing, 1, 1)).toBe(2);
    expect(recordedMaxLap(listing, 2, 1)).toBe(1);
    expect(recordedMaxLap(listing, 0, 1)).toBeNull();
  });

  it("counts nothing when the instance on screen is not known", () => {
    const listing = listRecord("lap", recordSource(QUALIFYING_THEN_RACE, null));

    expect(recordedMaxLap(listing, 1, null)).toBeNull();
  });

  it("counts only the instance of the session it is given, so a restarted event's laps do not mix", () => {
    const listing = listRecord(
      "lap",
      recordSource(
        [
          { frame: 1_000, lap: 1, sessionNum: 2, sessionUniqueId: 1 },
          { frame: 2_000, lap: 2, sessionNum: 2, sessionUniqueId: 1 },
          { frame: 3_000, lap: 3, sessionNum: 2, sessionUniqueId: 1 },
          { frame: 9_000, lap: 1, sessionNum: 2, sessionUniqueId: 5 },
        ],
        null,
      ),
    );

    expect(recordedMaxLap(listing, 2, 5)).toBe(1);
    expect(recordedMaxLap(listing, 2, 1)).toBe(3);
  });

  it("is null when the list could not be read", () => {
    expect(recordedMaxLap(listRecord("lap", recordSource(null, null)), 2, 1)).toBeNull();
    expect(recordedMaxLap(listRecord("session", recordSource(null, SESSIONS)), 2, 1)).toBeNull();
  });
});

describe("lapOfLapsReadout in a restarted event", () => {
  /** An offline event restarted at 50 000: session 0 again, a new instance. */
  const RESTARTED = [
    { sessionNum: 0, sessionUniqueId: 1, frame: 0 },
    { sessionNum: 0, sessionUniqueId: 2, frame: 50_000 },
  ];
  /** Car 4's laps 1-3 of the first instance, then lap 1 of the second at 60 000. */
  const LAPS_BOTH: LapStartListEntry[] = [
    { frame: 10_000, lap: 1, sessionNum: 0, sessionUniqueId: 1 },
    { frame: 20_000, lap: 2, sessionNum: 0, sessionUniqueId: 1 },
    { frame: 30_000, lap: 3, sessionNum: 0, sessionUniqueId: 1 },
    { frame: 60_000, lap: 1, sessionNum: 0, sessionUniqueId: 2 },
  ];
  const UNLIMITED = { SessionInfo: { Sessions: [{ SessionNum: 0, SessionLaps: "unlimited" }] } };

  function readout(
    frame: number,
    sessions: typeof RESTARTED | null = RESTARTED,
    laps: LapStartListEntry[] = LAPS_BOTH,
  ): string | null {
    const io = fakeStepIo();
    const source = recordSource(laps, sessions);

    io.recordSource.mockReturnValue(source);
    io.sessionInfo.mockReturnValue(UNLIMITED);
    io.telemetry.mockReturnValue(onCar4(0));

    return lapOfLapsReadout(io, at(frame), listRecord("lap", source));
  }

  it("reads -- with no denominator before the car's first crossing of the second instance", () => {
    // Live, before that crossing is recorded: the first instance's three laps are not counted.
    expect(readout(55_000, RESTARTED, LAPS_BOTH.slice(0, 3))).toBe("--");
    // Its crossing recorded later, the lap on screen is still unknown there.
    expect(readout(55_000)).toBe("--/1");
  });

  it("counts the second instance's laps alone once the car has crossed the line in it", () => {
    expect(readout(61_000)).toBe("1/1");
    // The first instance's own reading is its own.
    expect(readout(25_000)).toBe("2/3");
  });

  it("with no session record counts no recorded laps, and takes the lap by its session alone", () => {
    expect(readout(25_000, null)).toBe("2");
  });
});

describe("lapOfLapsReadout", () => {
  it("is the viewed car's recorded lap over the session's laps, on the replay's own reading", () => {
    const io = fakeStepIo();
    const source = recordSource(LAPS, SESSIONS);

    io.recordSource.mockReturnValue(source);
    io.sessionInfo.mockReturnValue(SCHEDULED);
    io.telemetry.mockReturnValue(onCar4(2));

    expect(lapOfLapsReadout(io, at(57_000), listRecord("lap", source))).toBe("3/25");
  });

  it("is null on a tick read mid-seek, so the box keeps what it showed", () => {
    const io = fakeStepIo();

    expect(lapOfLapsReadout(io, null, listRecord("lap", recordSource(LAPS, SESSIONS)))).toBeNull();
  });

  it("reads -- when the replay reads no session", () => {
    const io = fakeStepIo();

    io.sessionInfo.mockReturnValue(SCHEDULED);
    io.telemetry.mockReturnValue({ IsReplayPlaying: true, CamCarIdx: 4 } as TelemetryData);

    expect(lapOfLapsReadout(io, at(57_000), listRecord("lap", recordSource(LAPS, SESSIONS)))).toBe("--");
  });

  it("while a jump is under way reads the session from the record, by a session list it is handed", () => {
    const io = fakeStepIo();
    const lapListing = listRecord("lap", recordSource(LAPS, null));
    const sessionListing = listRecord("session", recordSource(null, SESSIONS));

    // The io's own source has no session list: only the one handed in can place the landing.
    io.recordSource.mockReturnValue(recordSource(LAPS, null));
    io.sessionInfo.mockReturnValue(SCHEDULED);
    // Mid-seek the reading says nothing of the session.
    io.telemetry.mockReturnValue({ IsReplayPlaying: false, ReplayFrameNum: 0, CamCarIdx: 4 } as TelemetryData);

    expect(lapOfLapsReadout(io, at(59_000 - 60, true), lapListing, sessionListing)).toBe("4/25");
    // Not handed one, it reads the io's, which places nothing.
    expect(lapOfLapsReadout(io, at(59_000 - 60, true), lapListing)).toBe("--");
  });

  it("while a jump is under way reads the io's session list when not handed one", () => {
    const io = fakeStepIo();
    const source = recordSource(LAPS, SESSIONS);

    io.recordSource.mockReturnValue(source);
    io.sessionInfo.mockReturnValue(SCHEDULED);
    io.telemetry.mockReturnValue({ IsReplayPlaying: false, ReplayFrameNum: 0, CamCarIdx: 4 } as TelemetryData);

    expect(lapOfLapsReadout(io, at(59_000 - 60, true), listRecord("lap", source))).toBe("4/25");
  });
});

describe("lapOfLapsReadout: the numerator and the denominator count the same laps", () => {
  /** Car 4's lap starts 1 … `count` of session 0 (instance 1), a lap every 3 000 frames from 3 000. */
  const lapStarts = (count: number): LapStartListEntry[] =>
    Array.from({ length: count }, (_, i) => ({
      frame: 3_000 * (i + 1),
      lap: i + 1,
      sessionNum: 0,
      sessionUniqueId: 1,
    }));
  const ONE_SESSION = sessionsAt([0]);

  function readout(laps: LapStartListEntry[], session: Record<string, unknown>, frame: number): string | null {
    const io = fakeStepIo();
    const source = recordSource(laps, ONE_SESSION);

    io.recordSource.mockReturnValue(source);
    io.sessionInfo.mockReturnValue({ SessionInfo: { Sessions: [{ SessionNum: 0, ...session }] } });
    io.telemetry.mockReturnValue(onCar4(0));

    return lapOfLapsReadout(io, at(frame), listRecord("lap", source));
  }

  it("a 25-lap race's finisher on the cool-down lap reads 25/25, not the recorder's 26", () => {
    // The finish crossing at 78 000 is recorded as lap 26's start.
    expect(readout(lapStarts(26), { SessionLaps: 25 }, 79_000)).toBe("25/25");
    expect(readout(lapStarts(26), { SessionLaps: 25 }, 76_000)).toBe("25/25");
    expect(readout(lapStarts(26), { SessionLaps: 25 }, 73_000)).toBe("24/25");
  });

  it("live in a timed session, on lap 13 with 12 complete, reads 13/13 with a results row or without one", () => {
    const live = { SessionLaps: "unlimited", ResultsOfficial: 0 };

    expect(readout(lapStarts(13), { ...live, ResultsPositions: [{ CarIdx: 4, LapsComplete: 12 }] }, 39_500)).toBe(
      "13/13",
    );
    expect(readout(lapStarts(13), live, 39_500)).toBe("13/13");
  });

  it("after a timed race's flag, with 16 complete, reads 16/16 on the cool-down lap and k/16 before it", () => {
    const over = { SessionLaps: "unlimited", ResultsOfficial: 1, ResultsPositions: [{ CarIdx: 4, LapsComplete: 16 }] };

    // The crossing that completed lap 16 is recorded as lap 17's start, at 51 000.
    expect(readout(lapStarts(17), over, 52_000)).toBe("16/16");
    expect(readout(lapStarts(17), over, 16_000)).toBe("5/16");
  });
});
