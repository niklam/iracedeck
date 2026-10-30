import { describe, expect, it } from "vitest";

import { addFlag, hasAnyFlag, hasFlag, removeFlag } from "./utils.js";

// Test enum (mimics iRacing flag enums)
enum TestFlags {
  None = 0,
  Flag1 = 1,
  Flag2 = 2,
  Flag4 = 4,
  Flag8 = 8,
}

describe("hasFlag", () => {
  it("should return true when flag is set", () => {
    expect(hasFlag(TestFlags.Flag1, TestFlags.Flag1)).toBe(true);
    expect(hasFlag(TestFlags.Flag1 | TestFlags.Flag2, TestFlags.Flag1)).toBe(true);
    expect(hasFlag(TestFlags.Flag1 | TestFlags.Flag2, TestFlags.Flag2)).toBe(true);
  });

  it("should return false when flag is not set", () => {
    expect(hasFlag(TestFlags.Flag1, TestFlags.Flag2)).toBe(false);
    expect(hasFlag(TestFlags.None, TestFlags.Flag1)).toBe(false);
  });

  it("should return false for undefined value", () => {
    expect(hasFlag(undefined, TestFlags.Flag1)).toBe(false);
  });

  it("should handle combined flags", () => {
    const combined = TestFlags.Flag1 | TestFlags.Flag4 | TestFlags.Flag8;
    expect(hasFlag(combined, TestFlags.Flag1)).toBe(true);
    expect(hasFlag(combined, TestFlags.Flag4)).toBe(true);
    expect(hasFlag(combined, TestFlags.Flag8)).toBe(true);
    expect(hasFlag(combined, TestFlags.Flag2)).toBe(false);
  });
});

describe("hasAnyFlag", () => {
  it("should return true when any flag is set", () => {
    expect(hasAnyFlag(TestFlags.Flag1, [TestFlags.Flag1, TestFlags.Flag2])).toBe(true);
    expect(hasAnyFlag(TestFlags.Flag2, [TestFlags.Flag1, TestFlags.Flag2])).toBe(true);
  });

  it("should return false when no flags are set", () => {
    expect(hasAnyFlag(TestFlags.Flag4, [TestFlags.Flag1, TestFlags.Flag2])).toBe(false);
  });

  it("should return false for undefined value", () => {
    expect(hasAnyFlag(undefined, [TestFlags.Flag1])).toBe(false);
  });

  it("should return false for empty flags array", () => {
    expect(hasAnyFlag(TestFlags.Flag1, [])).toBe(false);
  });
});

describe("addFlag", () => {
  it("should add flag to value", () => {
    expect(addFlag(0, TestFlags.Flag1)).toBe(TestFlags.Flag1);
    expect(addFlag(TestFlags.Flag1, TestFlags.Flag2)).toBe(TestFlags.Flag1 | TestFlags.Flag2);
  });

  it("should not duplicate already set flag", () => {
    expect(addFlag(TestFlags.Flag1, TestFlags.Flag1)).toBe(TestFlags.Flag1);
  });

  it("should handle undefined value", () => {
    expect(addFlag(undefined, TestFlags.Flag1)).toBe(TestFlags.Flag1);
  });
});

describe("removeFlag", () => {
  it("should remove flag from value", () => {
    const value = TestFlags.Flag1 | TestFlags.Flag2;
    expect(removeFlag(value, TestFlags.Flag1)).toBe(TestFlags.Flag2);
  });

  it("should not affect other flags", () => {
    const value = TestFlags.Flag1 | TestFlags.Flag2 | TestFlags.Flag4;
    expect(removeFlag(value, TestFlags.Flag2)).toBe(TestFlags.Flag1 | TestFlags.Flag4);
  });

  it("should handle flag not present", () => {
    expect(removeFlag(TestFlags.Flag1, TestFlags.Flag2)).toBe(TestFlags.Flag1);
  });

  it("should handle undefined value", () => {
    expect(removeFlag(undefined, TestFlags.Flag1)).toBe(0);
  });
});
