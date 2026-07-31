import { describe, expect, it } from "vitest";

import { parseIconTitleDefaults, parseSvgViewBox } from "./icon-template.js";
import {
  assembleIcon,
  BORDER_DEFAULTS,
  computeGraphicArea,
  GRAPHIC_DEFAULTS,
  resolveGraphicSettings,
  resolveTitleSettings,
  TITLE_DEFAULTS,
} from "./title-settings.js";

// ---------------------------------------------------------------------------
// parseSvgViewBox
// ---------------------------------------------------------------------------

describe("parseSvgViewBox", () => {
  it("should parse a simple viewBox", () => {
    const svg = `<svg viewBox="0 0 88 48"><desc>{}</desc></svg>`;
    expect(parseSvgViewBox(svg)).toEqual({ x: 0, y: 0, width: 88, height: 48 });
  });

  it("should parse a viewBox with non-zero origin", () => {
    const svg = `<svg viewBox="36 24 88 48"></svg>`;
    expect(parseSvgViewBox(svg)).toEqual({ x: 36, y: 24, width: 88, height: 48 });
  });

  it("should accept comma-separated values", () => {
    const svg = `<svg viewBox="0,0,100,100"></svg>`;
    expect(parseSvgViewBox(svg)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it("should return undefined when viewBox attribute is absent", () => {
    expect(parseSvgViewBox(`<svg><rect/></svg>`)).toBeUndefined();
  });

  it("should return undefined when viewBox has too few values", () => {
    expect(parseSvgViewBox(`<svg viewBox="0 0 100"></svg>`)).toBeUndefined();
  });

  it("should return undefined when width is zero", () => {
    expect(parseSvgViewBox(`<svg viewBox="0 0 0 48"></svg>`)).toBeUndefined();
  });

  it("should return undefined when height is negative", () => {
    expect(parseSvgViewBox(`<svg viewBox="0 0 48 -10"></svg>`)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeGraphicArea
// ---------------------------------------------------------------------------

describe("computeGraphicArea", () => {
  const baseTitle = {
    showTitle: true,
    showGraphics: true,
    titleText: "CAMERA\nNEXT",
    bold: true,
    fontSize: 9,
    position: "bottom" as const,
    customPosition: 0,
  };

  it("should return full canvas when title is hidden", () => {
    const area = computeGraphicArea({ ...baseTitle, showTitle: false });
    expect(area).toEqual({ x: 8, y: 8, width: 128, height: 128 });
  });

  it("should return full canvas when title text is empty", () => {
    const area = computeGraphicArea({ ...baseTitle, titleText: "" });
    expect(area).toEqual({ x: 8, y: 8, width: 128, height: 128 });
  });

  it("should size the area from layoutText when present, keeping templated-title layout stable (#899)", () => {
    // A templated title that currently resolves empty must still reserve the
    // space its raw template occupies, so the graphic doesn't jump size when
    // the value appears.
    const area = computeGraphicArea({ ...baseTitle, titleText: "", layoutText: "CAMERA\nNEXT" });
    expect(area).toEqual(computeGraphicArea(baseTitle));
  });

  it("should reduce height when title is at bottom (default case)", () => {
    const area = computeGraphicArea(baseTitle);
    // With fontSize 9 (doubled to 18), 2 lines at bottom:
    // lineHeight = 18 * 1.2 = 21.6, endY = 130, first line y = 108.4
    // titleTop = 108.4 - 9 = 99.4
    // height = 99.4 - 8 - 8 = 83.4
    expect(area.x).toBe(8);
    expect(area.y).toBe(8);
    expect(area.width).toBe(128);
    expect(area.height).toBeGreaterThan(75);
    expect(area.height).toBeLessThan(100);
  });

  it("should mirror bottom position when title is at top", () => {
    const bottomArea = computeGraphicArea(baseTitle);
    const topArea = computeGraphicArea({ ...baseTitle, position: "top" });
    // Same size, symmetric position (mirrored around canvas center)
    expect(topArea.height).toBe(bottomArea.height);
    expect(topArea.y).toBeGreaterThan(bottomArea.y);
    // Symmetric: bottomArea.y + topArea.y + height ≈ 144
    expect(topArea.y + topArea.height + bottomArea.y).toBe(144);
  });

  it("should return full canvas when title is at middle", () => {
    const area = computeGraphicArea({ ...baseTitle, position: "middle" });
    expect(area).toEqual({ x: 8, y: 8, width: 128, height: 128 });
  });

  it("should return full canvas when title is at custom position", () => {
    const area = computeGraphicArea({ ...baseTitle, position: "custom", customPosition: -20 });
    expect(area).toEqual({ x: 8, y: 8, width: 128, height: 128 });
  });

  it("should handle single-line title at bottom", () => {
    const area = computeGraphicArea({ ...baseTitle, titleText: "NEXT" });
    // Single line takes less space, so height should be larger
    const twoLineArea = computeGraphicArea(baseTitle);
    expect(area.height).toBeGreaterThan(twoLineArea.height);
  });

  it("should handle large font size", () => {
    const area = computeGraphicArea({ ...baseTitle, fontSize: 30 });
    // Larger font → title takes more space → less room for graphic
    const defaultArea = computeGraphicArea(baseTitle);
    expect(area.height).toBeLessThan(defaultArea.height);
  });
});

// ---------------------------------------------------------------------------
// resolveGraphicSettings
// ---------------------------------------------------------------------------

describe("resolveGraphicSettings", () => {
  it("should return defaults when no overrides", () => {
    const result = resolveGraphicSettings({});
    expect(result).toEqual(GRAPHIC_DEFAULTS);
    expect(result.scale).toBe(100);
  });

  it("should use global scale", () => {
    const result = resolveGraphicSettings({ scale: 80 });
    expect(result.scale).toBe(80);
  });

  it("should ignore global 'default' value", () => {
    const result = resolveGraphicSettings({ scale: "default" });
    expect(result.scale).toBe(100);
  });

  it("should use 100% when scaleMode is 'default' (ignoring global)", () => {
    const result = resolveGraphicSettings({ scale: 80 }, { scaleMode: "default" });
    expect(result.scale).toBe(100);
  });

  it("should use action scale when scaleMode is 'override'", () => {
    const result = resolveGraphicSettings({ scale: 80 }, { scaleMode: "override", scale: 120 });
    expect(result.scale).toBe(120);
  });

  it("should fall back to 100 when scaleMode is 'override' but no scale set", () => {
    const result = resolveGraphicSettings({ scale: 80 }, { scaleMode: "override" });
    expect(result.scale).toBe(100);
  });

  it("should inherit from global when scaleMode is undefined", () => {
    const result = resolveGraphicSettings({ scale: 75 }, {});
    expect(result.scale).toBe(75);
  });

  it("should inherit from global when no action overrides", () => {
    const result = resolveGraphicSettings({ scale: 60 }, undefined);
    expect(result.scale).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// assembleIcon with graphic scaling
// ---------------------------------------------------------------------------

function decodeDataUri(dataUri: string): string {
  const base64Match = dataUri.match(/^data:image\/svg\+xml;base64,(.+)$/);

  if (base64Match) {
    return Buffer.from(base64Match[1], "base64").toString("utf-8");
  }

  return dataUri;
}

const MOCK_GRAPHIC_NO_VIEWBOX = `<svg><desc>{"colors":{"backgroundColor":"#2a3444","textColor":"#ffffff"},"title":{"text":"TEST"}}</desc><rect x="22" y="12" width="100" height="80" fill="{{graphic1Color}}"/></svg>`;

const MOCK_GRAPHIC_TRIMMED = `<svg viewBox="0 0 100 80"><desc>{"colors":{"backgroundColor":"#2a3444","textColor":"#ffffff"},"title":{"text":"TEST"}}</desc><rect x="0" y="0" width="100" height="80" fill="{{graphic1Color}}"/></svg>`;

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

describe("assembleIcon with graphic scaling", () => {
  it("should NOT apply transform when graphic param is omitted", () => {
    const result = assembleIcon({
      graphicSvg: MOCK_GRAPHIC_TRIMMED,
      colors: COLORS,
      title: DEFAULT_TITLE,
      border: BORDER_DEFAULTS,
    });
    const svg = decodeDataUri(result);
    expect(svg).not.toContain("<g transform=");
  });

  it("should throw when graphic param is set but viewBox is missing", () => {
    expect(() =>
      assembleIcon({
        graphicSvg: MOCK_GRAPHIC_NO_VIEWBOX,
        colors: COLORS,
        title: DEFAULT_TITLE,
        border: BORDER_DEFAULTS,
        graphic: { scale: 100 },
      }),
    ).toThrow(/no parseable viewBox/);
  });

  it("should apply transform when graphic param set and viewBox present", () => {
    const result = assembleIcon({
      graphicSvg: MOCK_GRAPHIC_TRIMMED,
      colors: COLORS,
      title: DEFAULT_TITLE,
      border: BORDER_DEFAULTS,
      graphic: { scale: 100 },
    });
    const svg = decodeDataUri(result);
    expect(svg).toContain("<g transform=");
    expect(svg).toContain("translate(");
    expect(svg).toContain("scale(");
  });

  it("should scale up when title is hidden", () => {
    // Tall/narrow artwork where height becomes the constraining dimension
    const tallGraphic = `<svg viewBox="0 0 64 120"><desc>{"colors":{"backgroundColor":"#2a3444","textColor":"#ffffff"},"title":{"text":"LINE1\\nLINE2"}}</desc><rect x="0" y="0" width="64" height="120" fill="{{graphic1Color}}"/></svg>`;
    const titleWithTwoLines = { ...DEFAULT_TITLE, titleText: "LINE1\nLINE2", fontSize: 12 };
    const noTitle = { ...titleWithTwoLines, showTitle: false };

    const withTitle = assembleIcon({
      graphicSvg: tallGraphic,
      colors: COLORS,
      title: titleWithTwoLines,
      border: BORDER_DEFAULTS,
      graphic: { scale: 100 },
    });

    const withoutTitle = assembleIcon({
      graphicSvg: tallGraphic,
      colors: COLORS,
      title: noTitle,
      border: BORDER_DEFAULTS,
      graphic: { scale: 100 },
    });

    const withTitleScale = parseFloat(decodeDataUri(withTitle).match(/scale\(([^)]+)\)/)?.[1] ?? "0");
    const withoutTitleScale = parseFloat(decodeDataUri(withoutTitle).match(/scale\(([^)]+)\)/)?.[1] ?? "0");

    // Without title, more space → larger scale
    expect(withoutTitleScale).toBeGreaterThan(withTitleScale);
  });

  it("should still contain graphic content inside the transform group", () => {
    const result = assembleIcon({
      graphicSvg: MOCK_GRAPHIC_TRIMMED,
      colors: COLORS,
      title: DEFAULT_TITLE,
      border: BORDER_DEFAULTS,
      graphic: { scale: 100 },
    });
    const svg = decodeDataUri(result);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain("</g>");
  });

  it("should not apply transform when showGraphics is false", () => {
    const result = assembleIcon({
      graphicSvg: MOCK_GRAPHIC_TRIMMED,
      colors: COLORS,
      title: { ...DEFAULT_TITLE, showGraphics: false },
      border: BORDER_DEFAULTS,
      graphic: { scale: 100 },
    });
    const svg = decodeDataUri(result);
    expect(svg).not.toContain("<g transform=");
  });
});

// ---------------------------------------------------------------------------
// parseIconTitleDefaults
// ---------------------------------------------------------------------------

describe("parseIconTitleDefaults", () => {
  it("should parse showTitle from desc metadata", () => {
    const svg = `<svg><desc>{"title":{"text":"DRS","showTitle":true}}</desc></svg>`;
    const result = parseIconTitleDefaults(svg);
    expect(result.showTitle).toBe(true);
  });

  it("should parse locked array from desc metadata", () => {
    const svg = `<svg><desc>{"title":{"text":"DRS","locked":["showTitle","fontSize"]}}</desc></svg>`;
    const result = parseIconTitleDefaults(svg);
    expect(result.locked).toEqual(["showTitle", "fontSize"]);
  });

  it("should return undefined for showTitle when not present", () => {
    const svg = `<svg><desc>{"title":{"text":"TEST"}}</desc></svg>`;
    const result = parseIconTitleDefaults(svg);
    expect(result.showTitle).toBeUndefined();
  });

  it("should return undefined for locked when not present", () => {
    const svg = `<svg><desc>{"title":{"text":"TEST"}}</desc></svg>`;
    const result = parseIconTitleDefaults(svg);
    expect(result.locked).toBeUndefined();
  });

  it("should ignore non-boolean showTitle", () => {
    const svg = `<svg><desc>{"title":{"text":"TEST","showTitle":"yes"}}</desc></svg>`;
    const result = parseIconTitleDefaults(svg);
    expect(result.showTitle).toBeUndefined();
  });

  it("should ignore non-array locked", () => {
    const svg = `<svg><desc>{"title":{"text":"TEST","locked":"showTitle"}}</desc></svg>`;
    const result = parseIconTitleDefaults(svg);
    expect(result.locked).toBeUndefined();
  });

  it("should filter non-string entries from locked array", () => {
    const svg = `<svg><desc>{"title":{"text":"TEST","locked":["showTitle",42,true,"fontSize"]}}</desc></svg>`;
    const result = parseIconTitleDefaults(svg);
    expect(result.locked).toEqual(["showTitle", "fontSize"]);
  });

  it("should return undefined for locked when all entries are non-string", () => {
    const svg = `<svg><desc>{"title":{"text":"TEST","locked":[1,2,3]}}</desc></svg>`;
    const result = parseIconTitleDefaults(svg);
    expect(result.locked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveTitleSettings (basic — existing tests in deck-core cover more)
// ---------------------------------------------------------------------------

describe("resolveTitleSettings", () => {
  const GRAPHIC = `<svg><desc>{"colors":{},"title":{"text":"TOGGLE\\nLAP TIMING"}}</desc></svg>`;

  it("should return defaults when no overrides", () => {
    const result = resolveTitleSettings(GRAPHIC, {});
    expect(result.showTitle).toBe(TITLE_DEFAULTS.showTitle);
    expect(result.position).toBe(TITLE_DEFAULTS.position);
    expect(result.titleText).toBe("TOGGLE\nLAP TIMING");
  });

  it("should use global settings over defaults", () => {
    const result = resolveTitleSettings(GRAPHIC, { fontSize: 20, position: "top" });
    expect(result.fontSize).toBe(20);
    expect(result.position).toBe("top");
  });

  it("should use action overrides over global", () => {
    const result = resolveTitleSettings(GRAPHIC, { fontSize: 20 }, { fontSizeEnabled: true, fontSize: 30 });
    expect(result.fontSize).toBe(30);
  });

  it("should ignore action fontSize when fontSizeEnabled is false", () => {
    const result = resolveTitleSettings(GRAPHIC, { fontSize: 20 }, { fontSizeEnabled: false, fontSize: 30 });
    expect(result.fontSize).toBe(20);
  });

  it("should ignore action fontSize when fontSizeEnabled is undefined", () => {
    const result = resolveTitleSettings(GRAPHIC, { fontSize: 20 }, { fontSize: 30 });
    expect(result.fontSize).toBe(20);
  });

  it("should use icon default showTitle when present", () => {
    const svg = `<svg><desc>{"colors":{},"title":{"text":"DRS","showTitle":true}}</desc></svg>`;
    const result = resolveTitleSettings(svg, {});
    expect(result.showTitle).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveTitleSettings — locked title fields
// ---------------------------------------------------------------------------

describe("resolveTitleSettings locked fields", () => {
  const LOCKED_GRAPHIC = `<svg><desc>{"colors":{},"title":{"text":"DRS","fontSize":30,"showTitle":true,"locked":["showTitle","fontSize"]}}</desc></svg>`;

  it("should skip global showTitle when locked", () => {
    const result = resolveTitleSettings(LOCKED_GRAPHIC, { showTitle: false });
    expect(result.showTitle).toBe(true);
  });

  it("should skip global fontSize when locked", () => {
    const result = resolveTitleSettings(LOCKED_GRAPHIC, { fontSize: 9 });
    expect(result.fontSize).toBe(30);
  });

  it("should still allow per-action override on locked showTitle", () => {
    const result = resolveTitleSettings(LOCKED_GRAPHIC, { showTitle: false }, { showTitle: false });
    expect(result.showTitle).toBe(false);
  });

  it("should still allow per-action override on locked fontSize", () => {
    const result = resolveTitleSettings(LOCKED_GRAPHIC, { fontSize: 9 }, { fontSizeEnabled: true, fontSize: 12 });
    expect(result.fontSize).toBe(12);
  });

  it("should not lock fields that are not in the locked array", () => {
    const result = resolveTitleSettings(LOCKED_GRAPHIC, { position: "top" });
    expect(result.position).toBe("top");
  });

  it("should behave normally when no locked array is present", () => {
    const svg = `<svg><desc>{"colors":{},"title":{"text":"TEST","fontSize":20}}</desc></svg>`;
    const result = resolveTitleSettings(svg, { fontSize: 9 });
    expect(result.fontSize).toBe(9);
  });

  it("should behave normally when locked array is empty", () => {
    const svg = `<svg><desc>{"colors":{},"title":{"text":"TEST","fontSize":20,"locked":[]}}</desc></svg>`;
    const result = resolveTitleSettings(svg, { fontSize: 9 });
    expect(result.fontSize).toBe(9);
  });

  it("should fall to TITLE_DEFAULTS when locked field has no icon default", () => {
    const svg = `<svg><desc>{"colors":{},"title":{"text":"DRS","locked":["bold"]}}</desc></svg>`;
    const result = resolveTitleSettings(svg, { bold: false });
    expect(result.bold).toBe(TITLE_DEFAULTS.bold);
  });
});
