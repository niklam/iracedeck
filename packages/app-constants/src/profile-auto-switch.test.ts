import { describe, expect, it } from "vitest";

import {
  PROFILE_AUTO_SWITCH_ENABLED_KEY,
  PROFILE_FOR_SESSION_KIND_KEYS,
  PROFILE_SWITCH_SESSION_KIND_LABELS,
  PROFILE_SWITCH_SESSION_KINDS,
} from "./profile-auto-switch.js";

describe("profile auto-switch constants (issue #1111)", () => {
  it("lists the five session kinds in the settings window's order", () => {
    expect(PROFILE_SWITCH_SESSION_KINDS).toEqual(["test", "practice", "qualifying", "race", "replay"]);
  });

  it("keeps the toggle's setting key", () => {
    expect(PROFILE_AUTO_SWITCH_ENABLED_KEY).toBe("profileAutoSwitchEnabled");
  });

  it("keeps each session kind's setting key", () => {
    expect(PROFILE_FOR_SESSION_KIND_KEYS).toEqual({
      test: "profileForSessionKindTest",
      practice: "profileForSessionKindPractice",
      qualifying: "profileForSessionKindQualifying",
      race: "profileForSessionKindRace",
      replay: "profileForSessionKindReplay",
    });
  });

  it("gives every kind a distinct key that is not the toggle's", () => {
    const keys = PROFILE_SWITCH_SESSION_KINDS.map((kind) => PROFILE_FOR_SESSION_KIND_KEYS[kind]);

    expect(new Set(keys).size).toBe(PROFILE_SWITCH_SESSION_KINDS.length);
    expect(keys).not.toContain(PROFILE_AUTO_SWITCH_ENABLED_KEY);
    expect(Object.keys(PROFILE_FOR_SESSION_KIND_KEYS).sort()).toEqual([...PROFILE_SWITCH_SESSION_KINDS].sort());
  });

  it("labels every kind for the settings window", () => {
    expect(PROFILE_SWITCH_SESSION_KIND_LABELS).toEqual({
      test: "Test",
      practice: "Practice",
      qualifying: "Qualifying",
      race: "Race",
      replay: "Replay",
    });
  });
});
