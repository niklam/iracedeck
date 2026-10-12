import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import {
  GREEN_APPROACH_FRAMES,
  greenApproachFrame,
  resolveGreenFlagTarget,
  resolvePoleCarIdx,
} from "./green-flag-target.js";

function sessionInfoWith(sessionTypes: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SessionInfo: { Sessions: sessionTypes.map((SessionType, SessionNum) => ({ SessionNum, SessionType })) },
    ...extra,
  };
}

function cursorIn(sessionNum: number, sessionUniqueId?: number): TelemetryData {
  return { SessionNum: sessionNum, SessionUniqueID: sessionUniqueId } as TelemetryData;
}

describe("greenApproachFrame", () => {
  it("lands five seconds of frames before the green", () => {
    expect(GREEN_APPROACH_FRAMES).toBe(300);
    expect(greenApproachFrame(30215)).toBe(29915);
  });

  it("clamps at the start of the recording", () => {
    expect(greenApproachFrame(120)).toBe(0);
    expect(greenApproachFrame(300)).toBe(0);
  });
});

describe("resolveGreenFlagTarget", () => {
  const weekend = sessionInfoWith(["Practice", "Lone Qualify", "Race"]);

  it("targets the cursor's session when it is a race, with the replay's unique id", () => {
    expect(resolveGreenFlagTarget(weekend, cursorIn(2, 4))).toEqual({
      sessionNum: 2,
      sessionUniqueId: 4,
      from: "cursor",
    });
  });

  it("carries no unique id when the cursor's telemetry offers none", () => {
    expect(resolveGreenFlagTarget(weekend, cursorIn(2))).toEqual({
      sessionNum: 2,
      sessionUniqueId: null,
      from: "cursor",
    });
  });

  it.each([
    ["practice", 0],
    ["qualifying", 1],
  ])("targets the last race session from %s, by sessionNum only", (_name, sessionNum) => {
    // The cursor's unique id is the practice / qualifying session's, not the race's.
    expect(resolveGreenFlagTarget(weekend, cursorIn(sessionNum, 9))).toEqual({
      sessionNum: 2,
      sessionUniqueId: null,
      from: "last-race",
    });
  });

  it("treats a warmup as a non-race and goes to the race after it", () => {
    const withWarmup = sessionInfoWith(["Practice", "Open Qualify", "Warmup", "Race"]);

    expect(resolveGreenFlagTarget(withWarmup, cursorIn(2, 3))).toEqual({
      sessionNum: 3,
      sessionUniqueId: null,
      from: "last-race",
    });
  });

  it("stays in the heat the cursor is in, and picks the last race from outside one", () => {
    const heats = sessionInfoWith(["Practice", "Lone Qualify", "Race", "Race", "Race"]);

    expect(resolveGreenFlagTarget(heats, cursorIn(2, 5))).toEqual({
      sessionNum: 2,
      sessionUniqueId: 5,
      from: "cursor",
    });
    expect(resolveGreenFlagTarget(heats, cursorIn(0, 1))).toEqual({
      sessionNum: 4,
      sessionUniqueId: null,
      from: "last-race",
    });
  });

  it("keeps the target across the post-seek transient (SessionNum -1)", () => {
    expect(resolveGreenFlagTarget(weekend, cursorIn(-1, 4))).toEqual({
      sessionNum: 2,
      sessionUniqueId: null,
      from: "last-race",
    });
  });

  it("resolves the last race session with no telemetry at all", () => {
    expect(resolveGreenFlagTarget(weekend, null)).toEqual({ sessionNum: 2, sessionUniqueId: null, from: "last-race" });
  });

  it("matches sessions by their SessionNum field, not by array position", () => {
    const shuffled = {
      SessionInfo: {
        Sessions: [
          { SessionNum: 1, SessionType: "Race" },
          { SessionNum: 0, SessionType: "Practice" },
        ],
      },
    };

    expect(resolveGreenFlagTarget(shuffled, cursorIn(1, 2))).toEqual({
      sessionNum: 1,
      sessionUniqueId: 2,
      from: "cursor",
    });
    // Array position 0 holds the race; the cursor is in SessionNum 0, the practice.
    expect(resolveGreenFlagTarget(shuffled, cursorIn(0, 1))).toEqual({
      sessionNum: 1,
      sessionUniqueId: null,
      from: "last-race",
    });
  });

  it.each([
    ["a practice-only replay", sessionInfoWith(["Practice"])],
    ["a test drive", sessionInfoWith(["Offline Testing"])],
    ["an empty session list", sessionInfoWith([])],
    ["session info without a session list", {}],
    ["no session info", null],
    ["a session list holding an empty item", { SessionInfo: { Sessions: [null, undefined] } }],
  ])("has no target in %s", (_name, sessionInfo) => {
    expect(resolveGreenFlagTarget(sessionInfo, cursorIn(0, 1))).toBeNull();
  });
});

describe("resolvePoleCarIdx", () => {
  it("reads the pole sitter off the qualifying grid", () => {
    const sessionInfo = {
      QualifyResultsInfo: {
        Results: [
          { CarIdx: 7, Position: 1 },
          { CarIdx: 12, Position: 0 },
          { CarIdx: 3, Position: 2 },
        ],
      },
    };

    expect(resolvePoleCarIdx(sessionInfo)).toBe(12);
  });

  it("reads carIdx 0 on pole as a car, not as a miss", () => {
    expect(resolvePoleCarIdx({ QualifyResultsInfo: { Results: [{ CarIdx: 0, Position: 0 }] } })).toBe(0);
  });

  it.each([
    ["no grid published", {}],
    ["an empty grid", { QualifyResultsInfo: { Results: [] } }],
    ["a grid with no pole entry", { QualifyResultsInfo: { Results: [{ CarIdx: 4, Position: 1 }] } }],
    ["a grid of empty items", { QualifyResultsInfo: { Results: [null] } }],
    ["no session info", null],
  ])("is null with %s", (_name, sessionInfo) => {
    expect(resolvePoleCarIdx(sessionInfo)).toBeNull();
  });
});
