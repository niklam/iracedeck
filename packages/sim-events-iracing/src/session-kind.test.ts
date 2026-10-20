import { describe, expect, it } from "vitest";

import { classifySessionKind, type SessionKind } from "./session-kind.js";

describe("classifySessionKind", () => {
  it.each<[string, SessionKind]>([
    ["Offline Testing", "test"],
    ["Practice", "practice"],
    ["Lone Practice", "practice"],
    ["Warmup", "practice"],
    ["Open Qualify", "qualifying"],
    ["Lone Qualify", "qualifying"],
    ["Race", "race"],
  ])("classifies %j as %j in a live session", (sessionType, kind) => {
    expect(classifySessionKind(sessionType, "full")).toBe(kind);
    expect(classifySessionKind(sessionType, undefined)).toBe(kind);
  });

  it.each(["", "Heat Race", "Qualify", "practice", "Race ", "Time Trial", "constructor"])(
    "returns null for the unknown session type %j",
    (sessionType) => {
      expect(classifySessionKind(sessionType, "full")).toBeNull();
      expect(classifySessionKind(sessionType, undefined)).toBeNull();
    },
  );

  it.each(["Offline Testing", "Practice", "Open Qualify", "Race", "Heat Race", ""])(
    "classifies a saved replay as replay whatever the session type (%j)",
    (sessionType) => {
      expect(classifySessionKind(sessionType, "replay")).toBe("replay");
    },
  );

  it('does not treat a SimMode other than exactly "replay" as a replay', () => {
    expect(classifySessionKind("Race", "Replay")).toBe("race");
    expect(classifySessionKind("Race", "")).toBe("race");
  });
});
