import { dataUriToSvg } from "@iracedeck/deck-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  adjustStyleSettingsFields,
  getViewIdForAdjustment,
  hasPairedValueSource,
  isPillMiddleStyle,
  isPillStyle,
  isPositionAwareStyle,
  pairedKeyNeedsTelemetry,
  resolvePairPosition,
  seedFreshKeyStyle,
  stripUnit,
  styleShowsValue,
  telemetryMemoValue,
} from "./adjust-styles.js";
import { renderAdjustStyleSvg } from "./adjust-styles.js";

vi.mock("@iracedeck/deck-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/deck-core")>();

  return {
    ...actual,
    getGlobalColors: () => ({}),
    getGlobalTitleSettings: () => ({}),
    getGlobalBorderSettings: () => ({}),
    getGlobalGraphicSettings: () => ({}),
  };
});

const Schema = z.object(adjustStyleSettingsFields);

describe("adjustStyleSettingsFields", () => {
  it("defaults keyStyle to legacy and pairPosition to auto", () => {
    expect(Schema.parse({})).toEqual({ keyStyle: "legacy", pairPosition: "auto" });
  });

  it("degrades unknown values via catch instead of failing the parse", () => {
    expect(Schema.parse({ keyStyle: "from-the-future", pairPosition: "diagonal" })).toEqual({
      keyStyle: "legacy",
      pairPosition: "auto",
    });
  });
});

describe("seedFreshKeyStyle", () => {
  it("stamps split on an empty settings object", () => {
    expect(seedFreshKeyStyle({})).toEqual({ keyStyle: "split" });
    expect(seedFreshKeyStyle(undefined)).toEqual({ keyStyle: "split" });
  });

  it("returns null for configured keys (any persisted field)", () => {
    expect(seedFreshKeyStyle({ setting: "brake-bias" })).toBeNull();
    expect(seedFreshKeyStyle({ keyStyle: "legacy" })).toBeNull();
  });

  it("returns null for non-object garbage", () => {
    expect(seedFreshKeyStyle("nope")).toBeNull();
    expect(seedFreshKeyStyle([1])).toBeNull();
  });
});

describe("stripUnit", () => {
  it("strips a trailing percent and keeps signs", () => {
    expect(stripUnit("54.0%")).toBe("54.0");
    expect(stripUnit("+2%")).toBe("+2");
    expect(stripUnit("7")).toBe("7");
    expect(stripUnit("---")).toBe("---");
  });
});

describe("value-source gating", () => {
  it("inverts VIEW_DEFS adjustmentMode to the view id", () => {
    expect(getViewIdForAdjustment("brake-bias")).toBe("view-brake-bias");
    expect(getViewIdForAdjustment("throttle-shaping")).toBe("view-throttle-shape");
    expect(getViewIdForAdjustment("qualifying-tape")).toBeUndefined();
  });

  it("hasPairedValueSource accepts adjust modes with a view def and view ids themselves", () => {
    expect(hasPairedValueSource("brake-bias")).toBe(true);
    expect(hasPairedValueSource("view-brake-bias")).toBe(true);
    expect(hasPairedValueSource("boost-level")).toBe(false);
  });
});

describe("style predicates", () => {
  it("classifies value-showing styles", () => {
    expect(styleShowsValue("split")).toBe(true);
    expect(styleShowsValue("pill-middle-horizontal")).toBe(true);
    expect(styleShowsValue("big-glyph")).toBe(false);
    expect(styleShowsValue("legacy")).toBe(false);
  });

  it("classifies pill / position-aware / pill-middle styles", () => {
    expect(isPillStyle("joined-pill")).toBe(true);
    expect(isPillStyle("pill-end")).toBe(true);
    expect(isPillStyle("pill-middle-vertical")).toBe(true);
    expect(isPillStyle("ghost")).toBe(false);
    expect(isPositionAwareStyle("edge-chevrons")).toBe(true);
    expect(isPositionAwareStyle("big-chevron")).toBe(true);
    expect(isPositionAwareStyle("split")).toBe(false);
    expect(isPillMiddleStyle("pill-middle-horizontal")).toBe(true);
    expect(isPillMiddleStyle("joined-pill")).toBe(false);
  });

  it("resolves auto position from direction", () => {
    expect(resolvePairPosition("auto", "increase")).toBe("right");
    expect(resolvePairPosition("auto", "decrease")).toBe("left");
    expect(resolvePairPosition("top", "decrease")).toBe("top");
  });
});

describe("telemetry wiring helpers", () => {
  const telemetry = { dcBrakeBias: 54.0 } as never;

  it("pairedKeyNeedsTelemetry is true only for value-showing styles with a source", () => {
    expect(pairedKeyNeedsTelemetry({ setting: "brake-bias", keyStyle: "split" })).toBe(true);
    expect(pairedKeyNeedsTelemetry({ setting: "brake-bias", keyStyle: "big-glyph" })).toBe(false);
    expect(pairedKeyNeedsTelemetry({ setting: "boost-level", keyStyle: "split" })).toBe(false);
    expect(pairedKeyNeedsTelemetry({ setting: "brake-bias", keyStyle: "legacy" })).toBe(false);
  });

  it("telemetryMemoValue returns the formatted value for views and paired adjust keys, null otherwise", () => {
    expect(telemetryMemoValue({ setting: "view-brake-bias", keyStyle: "legacy" }, telemetry)).toBe("54.0%");
    expect(telemetryMemoValue({ setting: "brake-bias", keyStyle: "split" }, telemetry)).toBe("54.0%");
    expect(telemetryMemoValue({ setting: "brake-bias", keyStyle: "legacy" }, telemetry)).toBeNull();
    expect(telemetryMemoValue({ setting: "brake-bias", keyStyle: "big-glyph" }, telemetry)).toBeNull();
  });
});

/**
 * Decode the data URI back to raw SVG for content assertions. `svgToDataUri`
 * (packages/icon-composer/src/svg-utils.ts) actually emits
 * `data:image/svg+xml;base64,...` — not the plain URI-encoded form the brief
 * sketched — so this delegates to the real `dataUriToSvg` counterpart instead
 * of a hand-rolled `decodeURIComponent` that would silently no-op on base64.
 */
function decode(dataUri: string): string {
  return dataUriToSvg(dataUri);
}

const BASE = {
  direction: "increase",
  pairPosition: "auto",
  value: "54.0",
  label: "BRAKE BIAS",
} as const;

describe("renderAdjustStyleSvg — value-showing styles", () => {
  it("corner-badge renders value, label, and an accent badge with the direction glyph", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "corner-badge" }));
    expect(svg).toContain(">54.0</text>");
    expect(svg).toContain("BRAKE BIAS");
    expect(svg).toContain('circle cx="119" cy="25"');
    expect(svg).toContain("#f1c40f");
    expect(svg).toContain(">+</text>");
  });

  it("split renders label top, value middle, big glyph bottom; decrease shows a minus", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "split", direction: "decrease" }));
    expect(svg).toContain(">54.0</text>");
    expect(svg).toContain(">−</text>");
  });

  it("ghost renders a translucent glyph behind a full-size value", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "ghost" }));
    expect(svg).toContain('opacity="0.2"');
    expect(svg).toContain(">54.0</text>");
  });

  it("edge-chevrons places chevrons on the resolved edge, pointing in the direction of change", () => {
    // increase + auto → right edge, pointing right (x grows along the polyline)
    const inc = decode(renderAdjustStyleSvg({ ...BASE, style: "edge-chevrons" }));
    expect(inc).toContain('points="114,52 130,72 114,92"');
    // decrease + auto → left edge, pointing left
    const dec = decode(renderAdjustStyleSvg({ ...BASE, style: "edge-chevrons", direction: "decrease" }));
    expect(dec).toContain('points="30,52 14,72 30,92"');
  });

  it("renders the null placeholder and applies the binding warning overlay", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "split", value: null, bindingMissing: true }));
    expect(svg).toContain("---");
    // dimmed content wrapper from applyBindingWarning — BINDING_WARNING_DIM_OPACITY
    // in packages/icon-composer/src/binding-warning.ts is 0.25, not 0.3.
    expect(svg).toContain('opacity="0.25"');
  });

  it("hides the label when titleOverrides.showTitle is false", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "corner-badge", titleOverrides: { showTitle: false } }));
    expect(svg).not.toContain("BRAKE BIAS");
  });
});
