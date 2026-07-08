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
import { renderAdjustStyleSvg, renderPairedIconOrNull } from "./adjust-styles.js";

vi.mock("@iracedeck/deck-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/deck-core")>();

  return {
    ...actual,
    getGlobalColors: () => ({}),
    getGlobalTitleSettings: () => ({}),
    getGlobalBorderSettings: () => ({}),
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

  it("edge-chevrons honors an explicit position that diverges from direction (horizontal)", () => {
    // left edge + increase → chevrons on the LEFT, pointing RIGHT
    const svg = decode(
      renderAdjustStyleSvg({ ...BASE, style: "edge-chevrons", direction: "increase", pairPosition: "left" }),
    );
    expect(svg).toContain('points="14,52 30,72 14,92"');
  });

  it("edge-chevrons honors an explicit position that diverges from direction (vertical)", () => {
    // top edge + decrease → chevrons at the TOP, pointing DOWN
    const svg = decode(
      renderAdjustStyleSvg({ ...BASE, style: "edge-chevrons", direction: "decrease", pairPosition: "top" }),
    );
    expect(svg).toContain('points="52,14 72,30 92,14"');
    // bottom edge + increase → chevrons at the BOTTOM, pointing UP
    const svg2 = decode(
      renderAdjustStyleSvg({ ...BASE, style: "edge-chevrons", direction: "increase", pairPosition: "bottom" }),
    );
    expect(svg2).toContain('points="52,130 72,114 92,130"');
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

  it("bumps the value font size when shortValue is set", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "split", shortValue: true }));
    expect(svg).toContain('font-size="46"');
    expect(svg).not.toContain('font-size="38"');
  });

  it("takes background/text from colorSourceSvg but the accent from the template's own desc", () => {
    const colorSourceSvg = `<svg><desc>{"colors":{"backgroundColor":"#3a2a1a","textColor":"#eeeeee","graphic1Color":"#ffffff"},"locked":["graphic1Color"]}</desc></svg>`;
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "corner-badge", colorSourceSvg }));
    expect(svg).toContain('fill="#3a2a1a"'); // background from the action's palette
    expect(svg).toContain('r="15" fill="#f1c40f"'); // badge accent from the template desc, NOT the locked white
  });
});

describe("renderAdjustStyleSvg — pill family and no-value styles", () => {
  it("joined-pill draws a full-height frame open toward the partner and no normal border", () => {
    const left = decode(renderAdjustStyleSvg({ ...BASE, style: "joined-pill", direction: "decrease" }));
    // decrease + auto → left key → frame open on the RIGHT edge, equal-margin frame y 14..130
    // (no more label-driven shortening to y 14..108).
    expect(left).toContain('d="M144 14 H34 Q14 14 14 34 V110 Q14 130 34 130 H144"');
    expect(left).toContain(">54.0</text>");
    expect(left).toContain(">−</text>");
  });

  it("joined-pill carves a background-fill knockout in the bottom stroke under a visible bottom label", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "joined-pill", direction: "decrease" }));
    const pathIndex = svg.indexOf("<path");
    const rectIndex = svg.indexOf("<rect", pathIndex);
    const titleIndex = svg.indexOf(">BRAKE BIAS<");

    expect(pathIndex).toBeGreaterThan(-1);
    expect(rectIndex).toBeGreaterThan(pathIndex); // knockout emitted after the pill frame path
    expect(titleIndex).toBeGreaterThan(rectIndex); // ...and before the title text draws on top of it
  });

  it("joined-pill omits the knockout for the top position, whose bottom edge is already open", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "joined-pill", pairPosition: "top" }));
    const pathIndex = svg.indexOf("<path");

    expect(svg.indexOf("<rect", pathIndex)).toBe(-1);
  });

  it("pill-end uses equal margins and a centered glyph, no value, no label", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "pill-end", value: null }));
    expect(svg).toContain('d="M0 14 H110'); // increase + auto → right end → open LEFT
    expect(svg).toContain(">+</text>");
    expect(svg).not.toContain("---");
    expect(svg).not.toContain("BRAKE BIAS");
  });

  it("pill-end applies the same bottom-edge knockout when a per-key title override enables a label", () => {
    const svg = decode(
      renderAdjustStyleSvg({ ...BASE, style: "pill-end", titleOverrides: { showTitle: true, titleText: "STOP" } }),
    );
    const pathIndex = svg.indexOf("<path");
    const rectIndex = svg.indexOf("<rect", pathIndex);
    const titleIndex = svg.indexOf(">STOP<");

    expect(rectIndex).toBeGreaterThan(pathIndex);
    expect(titleIndex).toBeGreaterThan(rectIndex);
  });

  it("pill-middle-horizontal draws both rails and centers value (View-native size) + the standard bottom title", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "pill-middle-horizontal" }));
    expect(svg).toContain('d="M0 14 H144 M0 130 H144"');
    expect(svg).toContain(">54.0</text>");
    // No valueFontSize passed (not routed through renderPairedIconOrNull) → falls back
    // to the View-native default of 36, not the old style-specific 42px bump.
    expect(svg).toContain('font-size="36"');
    expect(svg).toContain("BRAKE BIAS");
  });

  it("pill-middle-horizontal carves a knockout for its always-present bottom rail under the standard title", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "pill-middle-horizontal" }));
    const pathIndex = svg.indexOf("<path");
    const rectIndex = svg.indexOf("<rect", pathIndex);
    const titleIndex = svg.indexOf(">BRAKE BIAS<");

    expect(rectIndex).toBeGreaterThan(pathIndex);
    expect(titleIndex).toBeGreaterThan(rectIndex);
  });

  it("pill-middle-vertical needs no knockout (side rails only, no bottom rail)", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "pill-middle-vertical" }));
    const pathIndex = svg.indexOf("<path");

    expect(svg.indexOf("<rect", pathIndex)).toBe(-1);
  });

  it("escapes user-supplied title text flowing through the standard bottom title", () => {
    const svg = decode(
      renderAdjustStyleSvg({
        ...BASE,
        style: "pill-middle-horizontal",
        titleOverrides: { titleText: "FUEL & MIX" },
      }),
    );
    expect(svg).toContain("FUEL &amp; MIX");
    expect(svg).not.toContain("FUEL & MIX<");
  });

  it("big-glyph is a huge accent glyph with hidden label by default", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "big-glyph" }));
    expect(svg).toContain(">+</text>");
    expect(svg).not.toContain("BRAKE BIAS");
  });

  it("big-chevron points in the true direction of change", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "big-chevron", pairPosition: "top" }));
    expect(svg).toContain('points="36,76 72,40 108,76"'); // vertical, increase → up
  });
});

describe("renderPairedIconOrNull", () => {
  const common = {
    direction: "increase",
    pairPosition: "auto",
    telemetry: { dcBrakeBias: 54.0 } as never,
    colorSourceSvg: `<svg><desc>{"colors":{"backgroundColor":"#3a2a1a","textColor":"#ffffff"}}</desc></svg>`,
  } as const;

  it("returns null for legacy style, valueless modes, and non-pill view styles", () => {
    expect(renderPairedIconOrNull({ ...common, setting: "brake-bias", keyStyle: "legacy" })).toBeNull();
    expect(renderPairedIconOrNull({ ...common, setting: "boost-level", keyStyle: "split" })).toBeNull();
    expect(renderPairedIconOrNull({ ...common, setting: "view-brake-bias", keyStyle: "split" })).toBeNull();
  });

  it("renders a paired adjust key with the unit-stripped live value", () => {
    const svg = decode(renderPairedIconOrNull({ ...common, setting: "brake-bias", keyStyle: "split" }) ?? "");
    expect(svg).toContain(">54.0</text>");
    expect(svg).not.toContain("54.0%");
  });

  it("renders a View key in pill-middle style", () => {
    const svg = decode(
      renderPairedIconOrNull({ ...common, setting: "view-brake-bias", keyStyle: "pill-middle-vertical" }) ?? "",
    );
    expect(svg).toContain('d="M14 0 V144 M130 0 V144"');
  });

  it("returns null for a pill-middle style requested on an adjust mode", () => {
    expect(renderPairedIconOrNull({ ...common, setting: "brake-bias", keyStyle: "pill-middle-horizontal" })).toBeNull();
  });
});
