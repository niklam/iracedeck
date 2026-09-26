import { describe, expect, it } from "vitest";

import { fitValueFontSize } from "./dial-fit.js";

describe("fitValueFontSize (shared by the strip and knob dash boxes, #1013)", () => {
  it("returns the cap when the value fits at the cap", () => {
    // 138 / (1 × 0.6) = 230 → capped at 50.
    expect(fitValueFontSize("3", 138, 50)).toBe(50);
  });

  it("shrinks a long value to the width at ~0.6 em per glyph, rounded", () => {
    // 138 / (6 × 0.6) = 38.33 → 38.
    expect(fitValueFontSize("1234.5", 138, 50)).toBe(38);
  });

  it("never divides by zero on an empty value (the divisor floors at 1)", () => {
    expect(fitValueFontSize("", 30, 50)).toBe(30);
  });
});
