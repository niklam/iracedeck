import { dataUriToSvg } from "@iracedeck/deck-core";
import { describe, expect, it, vi } from "vitest";

import {
  formatInteger,
  formatPercent,
  formatPercentRaw,
  formatSignedPercent,
  formatSpringOffsetMm,
  formatViewValue,
  generateSetupViewSvg,
  getAdjustmentModeForView,
  isViewSetting,
  VIEW_DEFS,
  VIEW_NULL_VALUE,
  type ViewSettingId,
} from "./setup-view.js";

vi.mock("@iracedeck/deck-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/deck-core")>();

  return {
    ...actual,
    getGlobalColors: () => ({}),
    getGlobalTitleSettings: () => ({}),
    getGlobalBorderSettings: () => ({}),
  };
});

describe("setup-view formatters", () => {
  describe("formatPercent", () => {
    it("renders a 0–1 ratio as an integer percent by default", () => {
      expect(formatPercent(0.47)).toBe("47%");
      expect(formatPercent(0.5)).toBe("50%");
      expect(formatPercent(1)).toBe("100%");
    });

    it("rounds to the requested decimals", () => {
      expect(formatPercent(0.563, 1)).toBe("56.3%");
      expect(formatPercent(0.5625, 2)).toBe("56.25%");
    });

    it("returns the null placeholder for non-numeric input", () => {
      expect(formatPercent(undefined)).toBe(VIEW_NULL_VALUE);
      expect(formatPercent(null)).toBe(VIEW_NULL_VALUE);
      expect(formatPercent("0.5")).toBe(VIEW_NULL_VALUE);
      expect(formatPercent(NaN)).toBe(VIEW_NULL_VALUE);
      expect(formatPercent(Infinity)).toBe(VIEW_NULL_VALUE);
    });

    it("handles zero as a real value, not a null", () => {
      expect(formatPercent(0)).toBe("0%");
    });
  });

  describe("formatSignedPercent", () => {
    it("prefixes positive values with +", () => {
      expect(formatSignedPercent(0.05)).toBe("+5%");
      expect(formatSignedPercent(0.25, 1)).toBe("+25.0%");
    });

    it("preserves negative sign without an extra prefix", () => {
      expect(formatSignedPercent(-0.05)).toBe("-5%");
    });

    it("does not prefix zero", () => {
      expect(formatSignedPercent(0)).toBe("0%");
    });

    it("returns the null placeholder for non-numeric input", () => {
      expect(formatSignedPercent(undefined)).toBe(VIEW_NULL_VALUE);
      expect(formatSignedPercent(NaN)).toBe(VIEW_NULL_VALUE);
    });
  });

  describe("formatPercentRaw", () => {
    it("appends % without multiplying the input (default 1 decimal)", () => {
      expect(formatPercentRaw(54)).toBe("54.0%");
    });

    it("preserves the exact value iRacing exposes (already in percent units)", () => {
      expect(formatPercentRaw(54.5, 1)).toBe("54.5%");
      expect(formatPercentRaw(54, 0)).toBe("54%");
      expect(formatPercentRaw(54.567, 2)).toBe("54.57%");
    });

    it("returns the null placeholder for non-numeric input", () => {
      expect(formatPercentRaw(undefined)).toBe(VIEW_NULL_VALUE);
      expect(formatPercentRaw(NaN)).toBe(VIEW_NULL_VALUE);
    });
  });

  describe("formatInteger", () => {
    it("returns the integer value as a bare string", () => {
      expect(formatInteger(0)).toBe("0");
      expect(formatInteger(3)).toBe("3");
      expect(formatInteger(10)).toBe("10");
    });

    it("rounds non-integer values", () => {
      expect(formatInteger(2.4)).toBe("2");
      expect(formatInteger(2.5)).toBe("3");
    });

    it("returns the null placeholder for non-numeric input", () => {
      expect(formatInteger(undefined)).toBe(VIEW_NULL_VALUE);
      expect(formatInteger(NaN)).toBe(VIEW_NULL_VALUE);
      expect(formatInteger("3")).toBe(VIEW_NULL_VALUE);
    });
  });
});

describe("isViewSetting", () => {
  it("returns true for every registered View id", () => {
    for (const id of Object.keys(VIEW_DEFS)) {
      expect(isViewSetting(id)).toBe(true);
    }
  });

  it("returns false for non-view setting ids and unrelated strings", () => {
    expect(isViewSetting("brake-bias")).toBe(false);
    expect(isViewSetting("abs-toggle")).toBe(false);
    expect(isViewSetting("")).toBe(false);
    expect(isViewSetting("view-nonexistent")).toBe(false);
  });
});

describe("formatViewValue", () => {
  it("returns the null placeholder when telemetry is null", () => {
    expect(formatViewValue("view-brake-bias", null)).toBe(VIEW_NULL_VALUE);
    expect(formatViewValue("view-brake-bias", undefined)).toBe(VIEW_NULL_VALUE);
  });

  it("reads the telemetry field named by the View definition", () => {
    // dcBrakeBias is exposed by iRacing in percent units (54, not 0.54); the formatter
    // must NOT multiply by 100.
    expect(formatViewValue("view-brake-bias", { dcBrakeBias: 54 })).toBe("54.0%");
    expect(formatViewValue("view-tc-slot-1", { dcTractionControl: 3 })).toBe("3");
    expect(formatViewValue("view-tc-slot-2", { dcTractionControl2: 5 })).toBe("5");
    expect(formatViewValue("view-weight-jacker-right", { dcWeightJackerRight: 0.04 })).toBe("+4%");
    expect(formatViewValue("view-weight-jacker-left", { dcWeightJackerLeft: -0.03 })).toBe("-3%");
  });

  it("returns the null placeholder when the named field is missing", () => {
    expect(formatViewValue("view-brake-bias", { dcTractionControl: 3 })).toBe(VIEW_NULL_VALUE);
    expect(formatViewValue("view-mguk-deploy-mode", {})).toBe(VIEW_NULL_VALUE);
  });
});

describe("VIEW_DEFS registry", () => {
  it("has a definition for every ViewSettingId", () => {
    const ids: ViewSettingId[] = [
      "view-brake-bias",
      "view-brake-bias-fine",
      "view-peak-brake-bias",
      "view-brake-misc",
      "view-engine-braking",
      "view-abs-adjust",
      "view-tc-slot-1",
      "view-tc-slot-2",
      "view-tc-slot-3",
      "view-tc-slot-4",
      "view-fuel-mixture",
      "view-fuel-cut-position",
      "view-engine-power",
      "view-throttle-shape",
      "view-launch-rpm",
      "view-front-wing",
      "view-rear-wing",
      "view-diff-preload",
      "view-diff-entry",
      "view-diff-middle",
      "view-diff-exit",
      "view-anti-roll-front",
      "view-anti-roll-rear",
      "view-power-steering",
      "view-weight-jacker-left",
      "view-weight-jacker-right",
      "view-mguk-deploy-mode",
      "view-mguk-regen-gain",
      "view-mguk-deploy-fixed",
    ];

    for (const id of ids) {
      expect(VIEW_DEFS[id]).toBeDefined();
      expect(VIEW_DEFS[id].telemetryField).toMatch(/^dc/);
      expect(VIEW_DEFS[id].label.length).toBeGreaterThan(0);
    }
  });
});

describe("generateSetupViewSvg — title-aware value centering (#810)", () => {
  const telemetry = { dcBrakeBias: 54.0 } as never;

  it("value re-centers with the resolved title: shown/bottom -> 60, hidden -> 72, top -> 84", () => {
    // Baseline y = center + round(0.36 * fontSize); "view-brake-bias" has no
    // valueFontSize override, so it falls back to the View-native default (36).
    const shown = dataUriToSvg(generateSetupViewSvg({ viewId: "view-brake-bias", telemetry }));
    expect(shown).toContain('y="73"'); // center 60 -> 60 + round(0.36*36=13) = 73

    const hidden = dataUriToSvg(
      generateSetupViewSvg({ viewId: "view-brake-bias", telemetry, titleOverrides: { showTitle: false } }),
    );
    expect(hidden).toContain('y="85"'); // center 72 -> 72 + 13 = 85

    const top = dataUriToSvg(
      generateSetupViewSvg({ viewId: "view-brake-bias", telemetry, titleOverrides: { position: "top" } }),
    );
    expect(top).toContain('y="97"'); // center 84 -> 84 + 13 = 97
  });

  it("matches the pill-middle styles' centering exactly (same viewValueCenterY helper)", () => {
    // Sanity check that the shown/bottom (established View look) case is
    // unchanged from before #810 — same baseline math as the hidden/top cases above.
    const shown = dataUriToSvg(generateSetupViewSvg({ viewId: "view-brake-bias", telemetry }));
    expect(shown).toContain('x="72" y="73"');
  });
});

describe("formatSpringOffsetMm (#953)", () => {
  it("renders whole millimeters in metric display units, matching iRacing's F7 rounding", () => {
    expect(formatSpringOffsetMm(2.54, { DisplayUnits: 1 })).toBe("3 mm");
    expect(formatSpringOffsetMm(-3.175, { DisplayUnits: 1 })).toBe("-3 mm");
    expect(formatSpringOffsetMm(0, { DisplayUnits: 1 })).toBe("0 mm");
  });

  it("renders three-decimal inches in english display units", () => {
    expect(formatSpringOffsetMm(3.175, { DisplayUnits: 0 })).toBe('0.125"');
    expect(formatSpringOffsetMm(-4.445, { DisplayUnits: 0 })).toBe('-0.175"');
  });

  it("defaults to metric when DisplayUnits is unavailable", () => {
    expect(formatSpringOffsetMm(156.675, undefined)).toBe("157 mm");
  });

  it("returns the null placeholder for non-numeric values", () => {
    expect(formatSpringOffsetMm(undefined, { DisplayUnits: 1 })).toBe(VIEW_NULL_VALUE);
    expect(formatSpringOffsetMm(NaN, { DisplayUnits: 1 })).toBe(VIEW_NULL_VALUE);
  });
});

describe("spring offset views (#953)", () => {
  it("formats the pending pit-stop value per the sim's display units", () => {
    expect(formatViewValue("view-lr-spring-offset", { dpWeightJackerLeft: 2.54, DisplayUnits: 1 })).toBe("3 mm");
    expect(formatViewValue("view-rr-spring-offset", { dpWeightJackerRight: 3.175, DisplayUnits: 0 })).toBe('0.125"');
  });

  it("degrades to the null placeholder when the car omits the field (one-sided SRX case)", () => {
    expect(formatViewValue("view-lr-spring-offset", { dpWeightJackerRight: 157, DisplayUnits: 1 })).toBe(
      VIEW_NULL_VALUE,
    );
  });

  it("maps to the renamed adjustment modes for dual-press dispatch", () => {
    expect(getAdjustmentModeForView("view-lr-spring-offset")).toBe("lr-spring");
    expect(getAdjustmentModeForView("view-rr-spring-offset")).toBe("rr-spring");
  });
});
