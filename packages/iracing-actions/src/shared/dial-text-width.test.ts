import { describe, expect, it } from "vitest";

import { boldTextWidth } from "./dial-text-width.js";

describe("boldTextWidth (#801)", () => {
  it("sums bold Arial's advance widths at the font size", () => {
    // I 278 + N 722 + C 722 + I 278 + D 722 + E 667 + N 722 + T 611 = 4722 thousandths.
    expect(boldTextWidth("INCIDENT", 16)).toBeCloseTo(75.552, 6);
    // # 556 + 1 556 + 2 556.
    expect(boldTextWidth("#12", 40)).toBeCloseTo(66.72, 6);
    expect(boldTextWidth("TRK ORD", 16)).toBeCloseTo(72.88, 6);
  });

  it("scales linearly and measures nothing as zero", () => {
    expect(boldTextWidth("SPEED", 30)).toBeCloseTo(boldTextWidth("SPEED", 15) * 2, 6);
    expect(boldTextWidth("", 16)).toBe(0);
  });

  it("counts a character it has no width for as a full em, so a check overestimates rather than overlaps", () => {
    expect(boldTextWidth("►", 10)).toBe(10);
    expect(boldTextWidth("►", 10)).toBeGreaterThan(boldTextWidth("W", 10));
  });
});
