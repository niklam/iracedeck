import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearWarning, setWarning } from "./pi-warnings.js";
import {
  compileSetupWarningPattern,
  DEFAULT_SETUP_WARNING_QUALIFYING_PATTERN,
  DEFAULT_SETUP_WARNING_RACE_PATTERN,
  evaluateSetupWarning,
  resolveSetupWarningPattern,
  SETUP_WARNING_QUALIFYING_PATTERN_WARNING_ID,
  SETUP_WARNING_RACE_PATTERN_WARNING_ID,
  setupNameMatchesPattern,
  validateSetupWarningPatterns,
} from "./setup-warning.js";

vi.mock("./pi-warnings.js", () => ({
  setWarning: vi.fn(),
  clearWarning: vi.fn(),
}));

describe("compileSetupWarningPattern", () => {
  it("compiles a valid pattern case-insensitively", () => {
    const re = compileSetupWarningPattern("race");
    expect(re).toBeInstanceOf(RegExp);
    expect(re?.flags).toContain("i");
  });

  it("returns null for an invalid pattern instead of throwing", () => {
    expect(compileSetupWarningPattern("(unclosed")).toBeNull();
  });
});

describe("setupNameMatchesPattern", () => {
  it("returns false for a missing setup name", () => {
    expect(setupNameMatchesPattern(undefined, DEFAULT_SETUP_WARNING_RACE_PATTERN)).toBe(false);
    expect(setupNameMatchesPattern(null, DEFAULT_SETUP_WARNING_RACE_PATTERN)).toBe(false);
    expect(setupNameMatchesPattern("", DEFAULT_SETUP_WARNING_RACE_PATTERN)).toBe(false);
  });

  it("returns false for an invalid pattern (never crashes)", () => {
    expect(setupNameMatchesPattern("qualifying.sto", "(unclosed")).toBe(false);
  });

  describe("default race-session pattern (flags a quali-looking name)", () => {
    const p = DEFAULT_SETUP_WARNING_RACE_PATTERN;

    it.each([
      ["qualifying.sto", true],
      ["Q.spa", true],
      ["quali-fast", true], // hyphen boundary (examples-authoritative, issue #625)
      ["VRS_quali_v2", true], // underscore boundary (common iRacing separator)
      ["QUALI.sto", true], // case-insensitive
      ["my quali setup", true], // space boundary
      ["race.sto", false],
      ["baseline", false],
    ])("matches %s -> %s", (name, expected) => {
      expect(setupNameMatchesPattern(name, p)).toBe(expected);
    });
  });

  describe("default qualifying-session pattern (flags a race-looking name)", () => {
    const p = DEFAULT_SETUP_WARNING_QUALIFYING_PATTERN;

    it.each([
      ["race.sto", true],
      ["R.spa", true],
      ["race-trim", true], // hyphen boundary
      ["VRS_race_v2", true], // underscore boundary (common iRacing separator)
      ["my race setup", true],
      ["qualifying.sto", false],
      ["baseline", false],
    ])("matches %s -> %s", (name, expected) => {
      expect(setupNameMatchesPattern(name, p)).toBe(expected);
    });
  });
});

describe("resolveSetupWarningPattern", () => {
  it("uses a non-empty user value", () => {
    expect(resolveSetupWarningPattern("custom", "fallback")).toBe("custom");
  });

  it("falls back for empty, whitespace, or non-string values", () => {
    expect(resolveSetupWarningPattern("", "fallback")).toBe("fallback");
    expect(resolveSetupWarningPattern("   ", "fallback")).toBe("fallback");
    expect(resolveSetupWarningPattern(undefined, "fallback")).toBe("fallback");
    expect(resolveSetupWarningPattern(42, "fallback")).toBe("fallback");
  });
});

describe("evaluateSetupWarning", () => {
  it("is false when the opt-in is disabled", () => {
    expect(evaluateSetupWarning("race", { calloutEnabledSetupWarning: false }, "qualifying.sto")).toBe(false);
  });

  it("is true on a mismatch with the opt-in unset (default on)", () => {
    expect(evaluateSetupWarning("race", {}, "qualifying.sto")).toBe(true);
    expect(evaluateSetupWarning("qualifying", {}, "race.sto")).toBe(true);
  });

  it("is false when the name looks correct for the session", () => {
    expect(evaluateSetupWarning("race", {}, "race.sto")).toBe(false);
    expect(evaluateSetupWarning("qualifying", {}, "qualifying.sto")).toBe(false);
  });

  it("honors a custom user pattern", () => {
    const settings = { setupWarningRacePattern: "(^|[ .-])(endurance)([ .-]|$)" };
    expect(evaluateSetupWarning("race", settings, "endurance.sto")).toBe(true);
    expect(evaluateSetupWarning("race", settings, "qualifying.sto")).toBe(false);
  });

  it("falls back to the default when the custom pattern is empty", () => {
    expect(evaluateSetupWarning("race", { setupWarningRacePattern: "" }, "qualifying.sto")).toBe(true);
  });

  it("is false (never crashes) on an invalid custom pattern", () => {
    expect(evaluateSetupWarning("race", { setupWarningRacePattern: "(unclosed" }, "qualifying.sto")).toBe(false);
  });
});

describe("validateSetupWarningPatterns", () => {
  beforeEach(() => {
    vi.mocked(setWarning).mockClear();
    vi.mocked(clearWarning).mockClear();
  });

  it("clears both banners when patterns are valid (or empty/default)", () => {
    validateSetupWarningPatterns({});
    expect(setWarning).not.toHaveBeenCalled();
    expect(clearWarning).toHaveBeenCalledWith(SETUP_WARNING_QUALIFYING_PATTERN_WARNING_ID);
    expect(clearWarning).toHaveBeenCalledWith(SETUP_WARNING_RACE_PATTERN_WARNING_ID);
  });

  it("banners only the broken field", () => {
    validateSetupWarningPatterns({ setupWarningRacePattern: "(unclosed" });
    expect(setWarning).toHaveBeenCalledTimes(1);
    expect(setWarning).toHaveBeenCalledWith(SETUP_WARNING_RACE_PATTERN_WARNING_ID, "warning", expect.any(String));
    expect(clearWarning).toHaveBeenCalledWith(SETUP_WARNING_QUALIFYING_PATTERN_WARNING_ID);
  });
});
