import { describe, expect, it } from "vitest";

import { FFB_STRENGTH_K, ffbStrengthFromNm, formatFfbReadout } from "./ffb-readout.js";

/** The max force iRacing reports for a stored Strength: `K / Strength`, as the float32 telemetry carries it. */
function telemetryNm(strength: number): number {
  return Math.fround(FFB_STRENGTH_K / strength);
}

describe("ffb-readout", () => {
  it("uses 340 Nm as the Strength constant (#1451 live reading)", () => {
    expect(FFB_STRENGTH_K).toBe(340);
  });

  describe("ffbStrengthFromNm", () => {
    it("recovers the stored Strength from the live full-precision reading", () => {
      // Read from a running sim on 2026-10-18, iRacing showing Strength 10.5.
      expect(ffbStrengthFromNm(32.25806427001953)).toBe(10.54);
    });

    it("lands on the 0.01 grid across the slider despite float32 noise", () => {
      for (const strength of [0.5, 4.7, 10.5, 10.55, 33.5, 60, 99.99]) {
        expect(ffbStrengthFromNm(telemetryNm(strength))).toBe(strength);
      }
    });

    it("gives a Strength that rounds to 0.0 for a very large max force", () => {
      expect(ffbStrengthFromNm(8500)).toBe(0.04);
    });

    it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null])(
      "returns null for an unusable max force (%s)",
      (nm) => {
        expect(ffbStrengthFromNm(nm)).toBeNull();
      },
    );

    it("returns null when the division overflows", () => {
      expect(ffbStrengthFromNm(Number.MIN_VALUE)).toBeNull();
    });
  });

  describe("formatFfbReadout", () => {
    it("formats max force as one-decimal Nm", () => {
      expect(formatFfbReadout(11.5, "max-force")).toBe("11.5 Nm");
      expect(formatFfbReadout(12.34, "max-force")).toBe("12.3 Nm");
      expect(formatFfbReadout(8500, "max-force")).toBe("8500.0 Nm");
    });

    it("formats Strength as one decimal with no unit", () => {
      expect(formatFfbReadout(32.25806427001953, "strength")).toBe("10.5");
      expect(formatFfbReadout(telemetryNm(60), "strength")).toBe("60.0");
    });

    it("shows iRacing's Strength where 340 / the displayed Nm would miss it", () => {
      // Stored 33.50 → 10.149 Nm, shown as 10.1 Nm; 340 / 10.1 would give 33.7.
      const nm = telemetryNm(33.5);

      expect(formatFfbReadout(nm, "max-force")).toBe("10.1 Nm");
      expect(formatFfbReadout(nm, "strength")).toBe("33.5");
    });

    it("rounds a stored Strength ending in 5 up, whatever side of the half its double lies", () => {
      expect(formatFfbReadout(telemetryNm(10.55), "strength")).toBe("10.6");
      // The doubles 1.15 and 4.35 sit just below their halves: `toFixed(1)` gives 1.1 and 4.3.
      expect(formatFfbReadout(telemetryNm(1.15), "strength")).toBe("1.2");
      expect(formatFfbReadout(telemetryNm(4.35), "strength")).toBe("4.4");
    });

    it("shows 0.0 for a very large max force and an unclamped large Strength for a tiny one", () => {
      expect(formatFfbReadout(8500, "strength")).toBe("0.0");
      expect(formatFfbReadout(1, "strength")).toBe("340.0");
    });

    it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined, null])(
      "shows --- in both readouts for an unusable max force (%s)",
      (nm) => {
        expect(formatFfbReadout(nm, "max-force")).toBe("---");
        expect(formatFfbReadout(nm, "strength")).toBe("---");
      },
    );

    it("shows --- for Strength when the division overflows", () => {
      expect(formatFfbReadout(Number.MIN_VALUE, "strength")).toBe("---");
    });
  });
});
