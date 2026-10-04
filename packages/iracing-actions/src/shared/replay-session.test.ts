import { describe, expect, it } from "vitest";

import { isReplayOnlySession } from "./replay-session.js";

describe("isReplayOnlySession", () => {
  it("is true for a saved replay: WeekendInfo.SimMode is replay", () => {
    expect(isReplayOnlySession({ WeekendInfo: { SimMode: "replay" } })).toBe(true);
  });

  it("is false for a live session", () => {
    expect(isReplayOnlySession({ WeekendInfo: { SimMode: "full" } })).toBe(false);
  });

  it("is false when the session info or the field is missing", () => {
    expect(isReplayOnlySession(null)).toBe(false);
    expect(isReplayOnlySession(undefined)).toBe(false);
    expect(isReplayOnlySession({})).toBe(false);
    expect(isReplayOnlySession({ WeekendInfo: {} })).toBe(false);
  });
});
