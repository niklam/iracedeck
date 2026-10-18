import { describe, expect, it } from "vitest";

import { formatLapOfLaps, sessionLapCount } from "./replay-lap-count.js";

/** A session info listing `sessions`, each given its `SessionNum` by position. */
function info(...sessions: Array<Record<string, unknown>>): unknown {
  return { SessionInfo: { Sessions: sessions.map((session, i) => ({ SessionNum: i, ...session })) } };
}

describe("sessionLapCount", () => {
  it("is the session's scheduled laps when they are a number, as a number or a string of digits", () => {
    expect(sessionLapCount(info({ SessionLaps: 25 }), 0, 4, null)).toBe(25);
    expect(sessionLapCount(info({ SessionLaps: "25" }), 0, 4, null)).toBe(25);
    // Scheduled laps win over the results and the record.
    expect(
      sessionLapCount(info({ SessionLaps: 25, ResultsPositions: [{ CarIdx: 4, LapsComplete: 30 }] }), 0, 4, 31),
    ).toBe(25);
  });

  it("picks the session by its SessionNum", () => {
    const sessions = info({ SessionLaps: "unlimited" }, { SessionLaps: 12 }, { SessionLaps: 40 });

    expect(sessionLapCount(sessions, 1, 4, null)).toBe(12);
    expect(sessionLapCount(sessions, 2, 4, null)).toBe(40);
  });

  it("is the viewed car's completed laps from the results in an unlimited session", () => {
    const sessions = info({
      SessionLaps: "unlimited",
      ResultsPositions: [
        { CarIdx: 2, LapsComplete: 14 },
        { CarIdx: 4, LapsComplete: 11 },
      ],
    });

    expect(sessionLapCount(sessions, 0, 4, 9)).toBe(11);
    expect(sessionLapCount(sessions, 0, 2, 9)).toBe(14);
  });

  it("is the highest recorded lap when the results have none for the car yet", () => {
    expect(sessionLapCount(info({ SessionLaps: "unlimited", ResultsPositions: null }), 0, 4, 9)).toBe(9);
    expect(
      sessionLapCount(info({ SessionLaps: "unlimited", ResultsPositions: [{ CarIdx: 4, LapsComplete: 0 }] }), 0, 4, 9),
    ).toBe(9);
    expect(
      sessionLapCount(info({ SessionLaps: "unlimited", ResultsPositions: [{ CarIdx: 7, LapsComplete: 5 }] }), 0, 4, 9),
    ).toBe(9);
    // No car on camera reads no results row.
    expect(
      sessionLapCount(
        info({ SessionLaps: "unlimited", ResultsPositions: [{ CarIdx: 4, LapsComplete: 5 }] }),
        0,
        undefined,
        9,
      ),
    ).toBe(9);
  });

  it("is null with none of the three", () => {
    expect(sessionLapCount(info({ SessionLaps: "unlimited" }), 0, 4, null)).toBeNull();
    expect(sessionLapCount(info({ SessionLaps: "unlimited" }), 0, 4, 0)).toBeNull();
    expect(sessionLapCount(info({ SessionLaps: 0 }), 0, 4, null)).toBeNull();
    expect(sessionLapCount(info({ SessionLaps: "25 laps" }), 0, 4, null)).toBeNull();
    // A session the session info does not list, or no session info at all.
    expect(sessionLapCount(info({ SessionLaps: 25 }), 3, 4, null)).toBeNull();
    expect(sessionLapCount(null, 0, 4, null)).toBeNull();
    expect(sessionLapCount(null, 0, 4, 6)).toBe(6);
  });
});

describe("formatLapOfLaps", () => {
  it.each<[number | null, number | null, string]>([
    [12, 25, "12/25"],
    [12, null, "12"],
    [null, 25, "--/25"],
    [null, null, "--"],
  ])("formats lap %s of %s as %j", (lap, laps, expected) => {
    expect(formatLapOfLaps(lap, laps)).toBe(expected);
  });
});
