import { describe, expect, it } from "vitest";

import { DEFAULT_FOCUS_IRACING_MODE, FOCUS_IRACING_MODES, parseFocusIRacingMode } from "./focus-iracing-mode.js";

describe("parseFocusIRacingMode (issue #977)", () => {
  it("passes the three mode strings through", () => {
    for (const mode of FOCUS_IRACING_MODES) {
      expect(parseFocusIRacingMode(mode)).toBe(mode);
    }
  });

  it("reads the legacy boolean and its string form", () => {
    expect(parseFocusIRacingMode(true)).toBe("always");
    expect(parseFocusIRacingMode("true")).toBe("always");
    expect(parseFocusIRacingMode(false)).toBe("never");
    expect(parseFocusIRacingMode("false")).toBe("never");
  });

  it("falls back to the default for anything else", () => {
    expect(DEFAULT_FOCUS_IRACING_MODE).toBe("always");
    expect(parseFocusIRacingMode(undefined)).toBe("always");
    expect(parseFocusIRacingMode(null)).toBe("always");
    expect(parseFocusIRacingMode("sometimes")).toBe("always");
    expect(parseFocusIRacingMode("NEVER")).toBe("always"); // exact match only — a wrong case must not read as an opt-out
    expect(parseFocusIRacingMode(0)).toBe("always");
    expect(parseFocusIRacingMode(42)).toBe("always");
  });
});
