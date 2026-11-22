import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { classifySession, resolveSessionType } from "./session-type.js";

const WEEKEND = {
  SessionInfo: {
    Sessions: [
      { SessionNum: 0, SessionType: "Practice" },
      { SessionNum: 1, SessionType: "Lone Qualify" },
      { SessionNum: 2, SessionType: "Race" },
    ],
  },
};

const inSession = (sessionNum?: number): TelemetryData =>
  (sessionNum === undefined ? {} : { SessionNum: sessionNum }) as TelemetryData;

describe("resolveSessionType", () => {
  it("reads the type of the session the telemetry is in", () => {
    expect(resolveSessionType(WEEKEND, inSession(0))).toBe("Practice");
    expect(resolveSessionType(WEEKEND, inSession(1))).toBe("Lone Qualify");
    expect(resolveSessionType(WEEKEND, inSession(2))).toBe("Race");
  });

  it("takes a telemetry read without a session number as session 0", () => {
    expect(resolveSessionType(WEEKEND, inSession())).toBe("Practice");
  });

  it("answers the empty string when it cannot say", () => {
    expect(resolveSessionType(null, inSession(2))).toBe("");
    expect(resolveSessionType({}, inSession(2))).toBe("");
    expect(resolveSessionType({ SessionInfo: {} }, inSession(2))).toBe("");
    expect(resolveSessionType(WEEKEND, inSession(7))).toBe("");
    expect(resolveSessionType({ SessionInfo: { Sessions: [{ SessionNum: 0 }] } }, inSession(0))).toBe("");
  });
});

describe("classifySession", () => {
  // Every SessionType the translator meets (the profile switch's table in
  // `session-kind.ts`, plus the ones it leaves unmapped), pinned to the bucket
  // the translator and the Race Engineer catalog read today (#1587).
  it.each([
    ["Practice", "practice", false, false],
    ["Lone Practice", "practice", false, false],
    ["Offline Testing", "practice", false, true],
    ["Open Qualify", "qualifying", false, false],
    ["Lone Qualify", "qualifying", true, false],
    ["Race", "race", false, false],
    ["Heat Race", "race", false, false],
    ["Warmup", "race", false, false],
    ["Some Future Session", "race", false, false],
  ] as const)(
    "classifies %s as %s (solo qualifying: %s, testing: %s)",
    (sessionType, category, soloQualifying, testing) => {
      expect(classifySession(sessionType)).toEqual({ category, soloQualifying, testing });
    },
  );

  it("marks only a testing session as testing, and keeps it practice by category (#1702)", () => {
    expect(classifySession("Offline Testing")).toEqual({ category: "practice", soloQualifying: false, testing: true });
    expect(classifySession("Offline Testing")).not.toBe(classifySession("Practice"));
  });

  it("answers null for a session type nobody could read", () => {
    expect(classifySession("")).toBeNull();
  });

  it("hands back the same frozen value on every call", () => {
    expect(classifySession("Race")).toBe(classifySession("Heat Race"));
    expect(Object.isFrozen(classifySession("Practice"))).toBe(true);
  });
});
