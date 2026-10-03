import { describe, expect, it } from "vitest";

import { coerceSettingNumber } from "./setting-number.js";

describe("coerceSettingNumber", () => {
  it("passes a finite number through unchanged, zero and fractions included", () => {
    expect(coerceSettingNumber(0)).toBe(0);
    expect(coerceSettingNumber(2.5)).toBe(2.5);
    expect(coerceSettingNumber(-4)).toBe(-4);
  });

  it("parses a numeric string", () => {
    expect(coerceSettingNumber("5")).toBe(5);
    expect(coerceSettingNumber("0")).toBe(0);
    expect(coerceSettingNumber("1.25")).toBe(1.25);
  });

  it("reads a cleared field or null as missing, never as zero", () => {
    expect(coerceSettingNumber("")).toBeNull();
    expect(coerceSettingNumber(null)).toBeNull();
    expect(coerceSettingNumber(undefined)).toBeNull();
  });

  it("reads anything unparseable or non-finite as missing", () => {
    expect(coerceSettingNumber("junk")).toBeNull();
    expect(coerceSettingNumber(Number.NaN)).toBeNull();
    expect(coerceSettingNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(coerceSettingNumber({})).toBeNull();
    expect(coerceSettingNumber(true)).toBeNull();
  });
});
