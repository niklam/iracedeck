import { describe, expect, it } from "vitest";

import {
  applyBindingWarning,
  BINDING_WARNING_DIM_OPACITY,
  BINDING_WARNING_GLYPH,
  bindingWarningSvg,
  dimForBindingWarning,
} from "./binding-warning.js";
import { assembleIcon, BORDER_DEFAULTS } from "./title-settings.js";

function decodeDataUri(dataUri: string): string {
  const base64Match = dataUri.match(/^data:image\/svg\+xml;base64,(.+)$/);

  if (base64Match) {
    return Buffer.from(base64Match[1], "base64").toString("utf-8");
  }

  return dataUri;
}

const MOCK_GRAPHIC = `<svg viewBox="0 0 100 80"><desc>{"colors":{"backgroundColor":"#2a3444","textColor":"#ffffff"},"title":{"text":"TEST"}}</desc><rect x="0" y="0" width="100" height="80" fill="{{graphic1Color}}"/></svg>`;

const DEFAULT_TITLE = {
  showTitle: true,
  showGraphics: true,
  titleText: "TEST",
  bold: true,
  fontSize: 9,
  position: "bottom" as const,
  customPosition: 0,
};

const COLORS = { backgroundColor: "#2a3444", textColor: "#ffffff", graphic1Color: "#ffffff" };

// SVG features that QT5 (Mirabox) silently drops — the warning glyph must use none of them.
const FORBIDDEN_SVG_TOKENS = ["<filter", "feGaussianBlur", "<mask", "clipPath", "<style", ' class="ird', "url("];

describe("binding-warning glyph", () => {
  it("draws a triangle and exclamation using cross-platform-safe primitives only", () => {
    expect(BINDING_WARNING_GLYPH).toContain("<polygon");
    expect(BINDING_WARNING_GLYPH).toContain("<rect");
    expect(BINDING_WARNING_GLYPH).toContain("<circle");

    // No QT5-incompatible features.
    for (const token of ["<filter", "feGaussianBlur", "<mask", "clipPath", "<style", "url("]) {
      expect(BINDING_WARNING_GLYPH).not.toContain(token);
    }
  });

  it("bindingWarningSvg() returns the glyph constant", () => {
    expect(bindingWarningSvg()).toBe(BINDING_WARNING_GLYPH);
  });

  it("centers the triangle around the 144x144 canvas center", () => {
    // Apex at x=72 (horizontal center) keeps the glyph centered.
    expect(BINDING_WARNING_GLYPH).toContain("72,42");
  });

  it("returns the bare glyph for an explicit 144x144 canvas", () => {
    expect(bindingWarningSvg({ width: 144, height: 144 })).toBe(BINDING_WARNING_GLYPH);
  });

  it("recenters and rescales the glyph for the 200x100 dial touch strip (#775)", () => {
    const out = bindingWarningSvg({ width: 200, height: 100 });

    // Scaled by the smaller side (100/144) and centered: tx = (200 - 100) / 2.
    expect(out).toContain('transform="translate(50, 0) scale(0.6944)"');
    expect(out).toContain(BINDING_WARNING_GLYPH);
  });
});

describe("dimForBindingWarning", () => {
  it("wraps content in a dim group at the documented opacity", () => {
    const out = dimForBindingWarning("<rect/>");
    expect(out).toBe(`<g opacity="${BINDING_WARNING_DIM_OPACITY}"><rect/></g>`);
    expect(BINDING_WARNING_DIM_OPACITY).toBeLessThan(1);
  });

  it("returns empty string for empty content (no stray dim group)", () => {
    expect(dimForBindingWarning("")).toBe("");
  });
});

describe("applyBindingWarning", () => {
  it("dims the existing content and appends the warning glyph", () => {
    const out = applyBindingWarning("<rect id='art'/>");
    expect(out).toContain(`<g opacity="${BINDING_WARNING_DIM_OPACITY}"><rect id='art'/></g>`);
    expect(out).toContain(BINDING_WARNING_GLYPH);
    // Glyph comes after the dimmed art so it renders on top.
    expect(out.indexOf(BINDING_WARNING_GLYPH)).toBeGreaterThan(out.indexOf("opacity="));
  });

  it("still draws the warning when there is no artwork", () => {
    expect(applyBindingWarning("")).toBe(BINDING_WARNING_GLYPH);
  });

  it("forwards the canvas so non-square targets get a centered glyph", () => {
    const out = applyBindingWarning("<rect/>", { width: 200, height: 100 });

    expect(out).toContain("translate(50, 0)");
  });
});

describe("assembleIcon bindingMissing overlay", () => {
  it("adds the warning triangle and dims artwork when bindingMissing is true", () => {
    const svg = decodeDataUri(
      assembleIcon({
        graphicSvg: MOCK_GRAPHIC,
        colors: COLORS,
        title: DEFAULT_TITLE,
        border: BORDER_DEFAULTS,
        bindingMissing: true,
      }),
    );
    expect(svg).toContain("<polygon");
    expect(svg).toContain(`opacity="${BINDING_WARNING_DIM_OPACITY}"`);
  });

  it("does NOT add the warning when bindingMissing is false/omitted", () => {
    const svg = decodeDataUri(
      assembleIcon({ graphicSvg: MOCK_GRAPHIC, colors: COLORS, title: DEFAULT_TITLE, border: BORDER_DEFAULTS }),
    );
    expect(svg).not.toContain("<polygon");
    expect(svg).not.toContain(`opacity="${BINDING_WARNING_DIM_OPACITY}"`);
  });

  it("shows the warning even when graphics are hidden (config error must be visible)", () => {
    const svg = decodeDataUri(
      assembleIcon({
        graphicSvg: MOCK_GRAPHIC,
        colors: COLORS,
        title: { ...DEFAULT_TITLE, showGraphics: false },
        border: BORDER_DEFAULTS,
        bindingMissing: true,
      }),
    );
    expect(svg).toContain("<polygon");
  });

  it("keeps the title visible alongside the warning", () => {
    const svg = decodeDataUri(
      assembleIcon({
        graphicSvg: MOCK_GRAPHIC,
        colors: COLORS,
        title: DEFAULT_TITLE,
        border: BORDER_DEFAULTS,
        bindingMissing: true,
      }),
    );
    expect(svg).toContain("TEST");
  });

  it("emits no QT5-incompatible SVG features in the overlay", () => {
    const svg = decodeDataUri(
      assembleIcon({
        graphicSvg: MOCK_GRAPHIC,
        colors: COLORS,
        title: DEFAULT_TITLE,
        border: BORDER_DEFAULTS,
        bindingMissing: true,
      }),
    );

    for (const token of FORBIDDEN_SVG_TOKENS) {
      expect(svg).not.toContain(token);
    }
  });
});
