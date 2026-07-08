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
    expect(isPillStyle("split")).toBe(false);
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
  it("split renders label top, value middle, big glyph bottom; decrease shows a minus", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "split", direction: "decrease" }));
    expect(svg).toContain(">54.0</text>");
    expect(svg).toContain(">−</text>");
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

  it("edge-chevrons (horizontal) wraps chevrons and value together in a title-aware translate (Fix 2)", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "edge-chevrons", pairPosition: "right" }));
    const transformIndex = svg.indexOf('<g transform="translate(0, -12)">');
    const closeIndex = svg.indexOf("</g>", transformIndex);
    const pointsIndex = svg.indexOf('points="114,52 130,72 114,92"');
    // Value's own y param (74) is unchanged by Fix 2 — the whole group is translated instead.
    // Rendered baseline = 74 + round(38*0.36) = 88.
    const valueIndex = svg.indexOf('x="56" y="88"');

    expect(transformIndex).toBeGreaterThan(-1);
    expect(pointsIndex).toBeGreaterThan(transformIndex);
    expect(pointsIndex).toBeLessThan(closeIndex);
    expect(valueIndex).toBeGreaterThan(transformIndex);
    expect(valueIndex).toBeLessThan(closeIndex);
  });

  it("edge-chevrons (vertical) keeps chevrons anchored and only re-centers the value (Fix 2)", () => {
    // chevrons-top: y param 80 when title shown (default) / 88 when hidden; baseline = param + round(38*0.36=14).
    const top = decode(renderAdjustStyleSvg({ ...BASE, style: "edge-chevrons", pairPosition: "top" }));
    expect(top).toContain('x="72" y="94"'); // 80 + 14
    const topHidden = decode(
      renderAdjustStyleSvg({
        ...BASE,
        style: "edge-chevrons",
        pairPosition: "top",
        titleOverrides: { showTitle: false },
      }),
    );
    expect(topHidden).toContain('x="72" y="102"'); // 88 + 14

    // chevrons-bottom: unchanged from before Fix 2 (its title defaults to top for that position) — y param 62 -> baseline 76.
    const bottom = decode(renderAdjustStyleSvg({ ...BASE, style: "edge-chevrons", pairPosition: "bottom" }));
    expect(bottom).toContain('x="72" y="76"');
  });

  it("renders the null placeholder and applies the binding warning overlay", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "split", value: null, bindingMissing: true }));
    expect(svg).toContain("---");
    // dimmed content wrapper from applyBindingWarning — BINDING_WARNING_DIM_OPACITY
    // in packages/icon-composer/src/binding-warning.ts is 0.25, not 0.3.
    expect(svg).toContain('opacity="0.25"');
  });

  it("hides the label when titleOverrides.showTitle is false", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "split", titleOverrides: { showTitle: false } }));
    expect(svg).not.toContain("BRAKE BIAS");
  });

  it("bumps the value font size when shortValue is set", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "split", shortValue: true }));
    expect(svg).toContain('font-size="46"');
    expect(svg).not.toContain('font-size="38"');
  });

  it("takes background/text from colorSourceSvg but the accent from the template's own desc", () => {
    const colorSourceSvg = `<svg><desc>{"colors":{"backgroundColor":"#3a2a1a","textColor":"#eeeeee","graphic1Color":"#ffffff"},"locked":["graphic1Color"]}</desc></svg>`;
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "edge-chevrons", colorSourceSvg }));
    expect(svg).toContain('fill="#3a2a1a"'); // background from the action's palette
    expect(svg).toContain('stroke="#f1c40f"'); // chevron accent from the template desc, NOT the locked white
    expect(svg).not.toContain('stroke="#ffffff"'); // the locked white must not leak into the accent
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

  it("joined-pill (horizontal) applies a small optical correction to the glyph only — '+' down, '−' up (#810 rebalance)", () => {
    const inc = decode(
      renderAdjustStyleSvg({ ...BASE, style: "joined-pill", pairPosition: "right", direction: "increase" }),
    );
    // glyph baseline: center 75 -> 75 + round(38*0.36=13.68->14) = 89; value stays at center 72 (unchanged).
    expect(inc).toContain('x="106" y="89"');
    expect(inc).toContain('x="52" y="84"'); // value: 72 + round(34*0.36=12.24->12) = 84

    const dec = decode(
      renderAdjustStyleSvg({ ...BASE, style: "joined-pill", pairPosition: "left", direction: "decrease" }),
    );
    // glyph baseline: center 69 -> 69 + 14 = 83; value unchanged at 72 -> 84.
    expect(dec).toContain('x="38" y="83"');
    expect(dec).toContain('x="92" y="84"');
  });

  it("joined-pill (vertical) rebalances glyph/value per key (#810 rebalance v2): top glyph 58/value 102, bottom value 46/glyph 90", () => {
    const top = decode(renderAdjustStyleSvg({ ...BASE, style: "joined-pill", pairPosition: "top" }));
    expect(top).toContain('x="72" y="72"'); // glyph: 58 + round(38*0.36=14) = 72
    expect(top).toContain('x="72" y="114"'); // value: 102 + round(34*0.36=12) = 114

    const bottom = decode(renderAdjustStyleSvg({ ...BASE, style: "joined-pill", pairPosition: "bottom" }));
    expect(bottom).toContain('x="72" y="58"'); // value: 46 + 12 = 58
    expect(bottom).toContain('x="72" y="104"'); // glyph: 90 + 14 = 104
  });

  it("joined-pill top key defaults its title to the top position, carved into the y=14 stroke with a knockout mirroring the bottom (#810)", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "joined-pill", pairPosition: "top" }));
    const pathIndex = svg.indexOf("<path");
    const titleIndex = svg.indexOf(">BRAKE BIAS<");

    expect(svg.indexOf("<rect", pathIndex)).toBeGreaterThan(pathIndex); // knockout gap on the top stroke
    expect(svg).toContain('<g transform="translate(0, -12)"'); // title shifted up onto the y=14 stroke (14 - 26)
    expect(titleIndex).toBeGreaterThan(pathIndex);
  });

  it("joined-pill top key's default top title position is a locked default — a per-key override still wins", () => {
    const overridden = decode(
      renderAdjustStyleSvg({
        ...BASE,
        style: "joined-pill",
        pairPosition: "top",
        titleOverrides: { position: "bottom" },
      }),
    );
    const pathIndex = overridden.indexOf("<path");

    // Overridden to bottom: no top-shift transform (title isn't at top anymore)...
    expect(overridden.slice(pathIndex).indexOf('<g transform="translate(0, 9)"')).toBe(-1);
    // ...and the TOP key's frame has no bottom stroke to knock out either (open toward the BOTTOM partner).
    expect(overridden.indexOf("<rect", pathIndex)).toBe(-1);
    expect(overridden).toContain(">BRAKE BIAS<");
  });

  it("joined-pill applies no shift (and no knockout) for a top-positioned title when its frame has no top stroke (position: bottom)", () => {
    const svg = decode(
      renderAdjustStyleSvg({
        ...BASE,
        style: "joined-pill",
        pairPosition: "bottom",
        titleOverrides: { position: "top" },
      }),
    );
    const pathIndex = svg.indexOf("<path");

    expect(svg.indexOf("<rect", pathIndex)).toBe(-1);
    expect(svg.slice(pathIndex).indexOf('<g transform="translate(0,')).toBe(-1);
  });

  it("pill-middle-horizontal carves a top-positioned title into its top rail with a knockout (#810)", () => {
    const svg = decode(
      renderAdjustStyleSvg({ ...BASE, style: "pill-middle-horizontal", titleOverrides: { position: "top" } }),
    );
    const pathIndex = svg.indexOf("<path");
    const titleIndex = svg.indexOf(">BRAKE BIAS<");

    expect(svg.indexOf("<rect", pathIndex)).toBeGreaterThan(pathIndex); // knockout gap on the top rail
    expect(svg).toContain('<g transform="translate(0, -12)"'); // title shifted up onto the y=14 rail
    expect(titleIndex).toBeGreaterThan(pathIndex);
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

  it("pill-middle-horizontal value re-centers with the title (#810, Fix 1): shown/bottom -> 60, hidden -> 72, top -> 84", () => {
    // Baseline y = center + round(0.36 * fontSize); fontSize here is 36 (View-native default).
    const shown = decode(renderAdjustStyleSvg({ ...BASE, style: "pill-middle-horizontal" }));
    expect(shown).toContain('x="72" y="73"'); // center 60 -> 60 + round(0.36*36=13) = 73

    const hidden = decode(
      renderAdjustStyleSvg({ ...BASE, style: "pill-middle-horizontal", titleOverrides: { showTitle: false } }),
    );
    expect(hidden).toContain('x="72" y="85"'); // center 72 -> 72 + 13 = 85

    const top = decode(
      renderAdjustStyleSvg({ ...BASE, style: "pill-middle-horizontal", titleOverrides: { position: "top" } }),
    );
    expect(top).toContain('x="72" y="97"'); // center 84 -> 84 + 13 = 97
  });

  it("pill-middle-vertical shares the same title-aware value centering (#810, Fix 3)", () => {
    const hidden = decode(
      renderAdjustStyleSvg({ ...BASE, style: "pill-middle-vertical", titleOverrides: { showTitle: false } }),
    );
    expect(hidden).toContain('x="72" y="85"'); // center 72 -> 72 + 13 = 85
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

  it("big-glyph stays centered (no translate) by default; a shown per-key label re-centers it (Fix 2)", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "big-glyph" }));
    expect(svg).not.toContain('<g transform="translate(0,');

    const withLabel = decode(
      renderAdjustStyleSvg({ ...BASE, style: "big-glyph", titleOverrides: { showTitle: true } }),
    );
    expect(withLabel).toContain('<g transform="translate(0, -12)">'); // title defaults to bottom -> center 60
    expect(withLabel).toContain("BRAKE BIAS");
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
