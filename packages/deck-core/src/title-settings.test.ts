import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TitleOverrides } from "./common-settings.js";
import { getGlobalSettings } from "./global-settings.js";
import type { GlobalSettings } from "./global-settings.js";
import {
  assembleIcon,
  BORDER_DEFAULTS,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalTitleSettings,
  resolveBorderSettings,
  resolveTitleSettings,
} from "./title-settings.js";
import type { GlobalBorderSettings, ResolvedBorderSettings } from "./title-settings.js";
import type { GlobalTitleSettings } from "./title-settings.js";

vi.mock("./global-settings.js", () => ({
  getGlobalSettings: vi.fn(() => ({})),
}));

const GRAPHIC_WITH_TITLE = `<svg><desc>{"colors":{},"title":{"text":"TOGGLE\\nLAP TIMING"}}</desc></svg>`;
const GRAPHIC_NO_TITLE = `<svg><desc>{"colors":{}}</desc></svg>`;

const MOCK_GRAPHIC = `<svg><desc>{"colors":{"backgroundColor":"#2a3444","textColor":"#ffffff"},"title":{"text":"TOGGLE\\nLAP TIMING"}}</desc><rect x="22" y="12" width="100" height="80" fill="{{graphic1Color}}"/></svg>`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveTitleSettings", () => {
  it("should return defaults when no overrides", () => {
    const result = resolveTitleSettings(GRAPHIC_WITH_TITLE, {});
    expect(result).toEqual({
      showTitle: true,
      showGraphics: true,
      titleText: "TOGGLE\nLAP TIMING",
      bold: true,
      fontSize: 9,
      position: "bottom",
      customPosition: 0,
    });
  });

  it("should use actionDefaultText over desc metadata", () => {
    const result = resolveTitleSettings(GRAPHIC_WITH_TITLE, {}, undefined, "CUSTOM\nTEXT");
    expect(result.titleText).toBe("CUSTOM\nTEXT");
  });

  it("should use per-action overrides over global", () => {
    const global: GlobalTitleSettings = { fontSize: 24, bold: false };
    const action: TitleOverrides = { fontSizeEnabled: true, fontSize: 30 };
    const result = resolveTitleSettings(GRAPHIC_WITH_TITLE, global, action);
    expect(result.fontSize).toBe(30);
    expect(result.bold).toBe(false);
  });

  it("should use global over defaults", () => {
    const global: GlobalTitleSettings = { fontSize: 24, position: "middle" };
    const result = resolveTitleSettings(GRAPHIC_WITH_TITLE, global);
    expect(result.fontSize).toBe(24);
    expect(result.position).toBe("middle");
  });

  it("should use per-action titleText over actionDefaultText", () => {
    const action: TitleOverrides = { titleText: "USER\nOVERRIDE" };
    const result = resolveTitleSettings(GRAPHIC_WITH_TITLE, {}, action, "CODE\nDEFAULT");
    expect(result.titleText).toBe("USER\nOVERRIDE");
  });

  it("should fall back to empty string when no title source", () => {
    const result = resolveTitleSettings(GRAPHIC_NO_TITLE, {});
    expect(result.titleText).toBe("");
  });

  it("should treat empty string titleText as unset", () => {
    const action: TitleOverrides = { titleText: "" };
    const result = resolveTitleSettings(GRAPHIC_WITH_TITLE, {}, action, "CODE\nDEFAULT");
    expect(result.titleText).toBe("CODE\nDEFAULT");
  });

  it("should treat 'inherit' as unset for boolean fields (falls through to global)", () => {
    const action = { showTitle: undefined, bold: undefined } as TitleOverrides;
    const global: GlobalTitleSettings = { showTitle: false, bold: false };
    const result = resolveTitleSettings(GRAPHIC_WITH_TITLE, global, action);
    expect(result.showTitle).toBe(false);
    expect(result.bold).toBe(false);
  });

  it("should treat 'inherit' as unset for position (falls through to global)", () => {
    const action = { position: undefined } as TitleOverrides;
    const global: GlobalTitleSettings = { position: "top" };
    const result = resolveTitleSettings(GRAPHIC_WITH_TITLE, global, action);
    expect(result.position).toBe("top");
  });

  it("should treat 'inherit' as unset and fall through to hardcoded defaults when no global set", () => {
    const action = {
      showTitle: undefined,
      showGraphics: undefined,
      bold: undefined,
      position: undefined,
    } as TitleOverrides;
    const result = resolveTitleSettings(GRAPHIC_WITH_TITLE, {}, action);
    expect(result.showTitle).toBe(true);
    expect(result.showGraphics).toBe(true);
    expect(result.bold).toBe(true);
    expect(result.position).toBe("bottom");
  });

  it("should treat global 'default' as unset and fall through to icon defaults", () => {
    const graphicWithDefaults = `<svg><desc>{"colors":{},"title":{"text":"TEST","position":"top","fontSize":15,"customPosition":-10}}</desc></svg>`;
    const global: GlobalTitleSettings = {
      position: "default",
      fontSize: "default",
      bold: "default",
      customPosition: "default",
    };
    const result = resolveTitleSettings(graphicWithDefaults, global);
    expect(result.position).toBe("top");
    expect(result.fontSize).toBe(15);
    expect(result.customPosition).toBe(-10);
    expect(result.bold).toBe(true); // no icon default for bold, falls to TITLE_DEFAULTS
  });

  it("should treat global 'default' as unset and fall through to TITLE_DEFAULTS when no icon defaults", () => {
    const global: GlobalTitleSettings = {
      position: "default",
      fontSize: "default",
    };
    const result = resolveTitleSettings(GRAPHIC_WITH_TITLE, global);
    expect(result.position).toBe("bottom"); // TITLE_DEFAULTS
    expect(result.fontSize).toBe(9); // TITLE_DEFAULTS
  });
});

describe("generateTitleText", () => {
  const defaults = { fill: "#ffffff" };

  it("should generate single-line text at bottom position", () => {
    const result = generateTitleText({
      text: "NEXT",
      fontSize: 20,
      bold: true,
      position: "bottom",
      customPosition: 0,
      ...defaults,
    });
    expect(result).toContain("NEXT");
    // PI fontSize 20 → SVG 40 (doubled)
    expect(result).toContain('font-size="40"');
    expect(result).toContain('font-weight="bold"');
    expect(result).toContain('y="130"');
  });

  it("should generate single-line text at top position", () => {
    const result = generateTitleText({
      text: "NEXT",
      fontSize: 20,
      bold: true,
      position: "top",
      customPosition: 0,
      ...defaults,
    });
    // top startY = doubled(20) + 8 = 48
    expect(result).toContain('y="48"');
  });

  it("should generate single-line text at middle position", () => {
    const result = generateTitleText({
      text: "NEXT",
      fontSize: 20,
      bold: true,
      position: "middle",
      customPosition: 0,
      ...defaults,
    });
    // centerY = 88 + (40 - 44) / 3 ≈ 86.67
    expect(result).toMatch(/y="86\.6/);
  });

  it("should generate multiline text at bottom position", () => {
    const result = generateTitleText({
      text: "CAMERA\nNEXT",
      fontSize: 18,
      bold: true,
      position: "bottom",
      customPosition: 0,
      ...defaults,
    });
    expect(result).toContain("CAMERA");
    expect(result).toContain("NEXT");
    const lines = result.match(/y="(\d+\.?\d*)"/g);
    expect(lines).toHaveLength(2);
  });

  it("should generate multiline text at top position", () => {
    const result = generateTitleText({
      text: "CAMERA\nNEXT",
      fontSize: 18,
      bold: true,
      position: "top",
      customPosition: 0,
      ...defaults,
    });
    const lines = result.match(/y="(\d+\.?\d*)"/g);
    expect(lines).toHaveLength(2);
    const y1 = parseFloat(lines![0].match(/(\d+\.?\d*)/)![1]);
    const y2 = parseFloat(lines![1].match(/(\d+\.?\d*)/)![1]);
    expect(y1).toBeLessThan(y2);
    // top startY = doubled(18) + 8 = 44
    expect(y1).toBe(36 + 8);
  });

  it("should use custom position as offset from middle", () => {
    const result = generateTitleText({
      text: "NEXT",
      fontSize: 20,
      bold: true,
      position: "custom",
      customPosition: -30,
      ...defaults,
    });
    // centerY = 88 + (40 - 44) / 3 + (-30) ≈ 56.67
    expect(result).toMatch(/y="56\.6/);
  });

  it("should render normal weight when bold is false", () => {
    const result = generateTitleText({
      text: "NEXT",
      fontSize: 20,
      bold: false,
      position: "bottom",
      customPosition: 0,
      ...defaults,
    });
    expect(result).toContain('font-weight="normal"');
  });

  it("should return empty string for empty text", () => {
    const result = generateTitleText({
      text: "",
      fontSize: 20,
      bold: true,
      position: "bottom",
      customPosition: 0,
      ...defaults,
    });
    expect(result).toBe("");
  });

  it("should escape XML entities in text", () => {
    const result = generateTitleText({
      text: "A&B",
      fontSize: 20,
      bold: true,
      position: "bottom",
      customPosition: 0,
      ...defaults,
    });
    expect(result).toContain("A&amp;B");
  });

  it("should handle three lines at middle position", () => {
    const result = generateTitleText({
      text: "LINE1\nLINE2\nLINE3",
      fontSize: 16,
      bold: true,
      position: "middle",
      customPosition: 0,
      ...defaults,
    });
    const lines = result.match(/y="(\d+\.?\d*)"/g);
    expect(lines).toHaveLength(3);
    const ys = lines!.map((l) => parseFloat(l.match(/(\d+\.?\d*)/)![1]));
    const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
    // centerY = 88 + (32 - 44) / 3 = 84
    expect(Math.abs(avg - 84)).toBeLessThan(2);
  });
});

function decodeDataUri(dataUri: string): string {
  const base64Match = dataUri.match(/^data:image\/svg\+xml;base64,(.+)$/);

  if (base64Match) {
    return Buffer.from(base64Match[1], "base64").toString("utf-8");
  }

  // URL-encoded fallback
  const plainMatch = dataUri.match(/^data:image\/svg\+xml,(.+)$/);

  if (plainMatch) {
    return decodeURIComponent(plainMatch[1]);
  }

  return dataUri;
}

describe("assembleIcon", () => {
  it("should assemble a complete icon with graphics and title", () => {
    const result = assembleIcon({
      graphicSvg: MOCK_GRAPHIC,
      colors: { backgroundColor: "#2a3444", textColor: "#ffffff", graphic1Color: "#ffffff" },
      title: {
        showTitle: true,
        showGraphics: true,
        titleText: "TOGGLE\nLAP TIMING",
        bold: true,
        fontSize: 18,
        position: "bottom",
        customPosition: 0,
      },
      border: BORDER_DEFAULTS,
    });
    const svg = decodeDataUri(result);
    expect(result).toContain("data:image/svg+xml");
    expect(svg).toContain("TOGGLE");
    expect(svg).toContain("LAP TIMING");
    expect(svg).toContain("#2a3444");
  });

  it("should hide graphics when showGraphics is false", () => {
    const result = assembleIcon({
      graphicSvg: MOCK_GRAPHIC,
      colors: { backgroundColor: "#2a3444", textColor: "#ffffff", graphic1Color: "#ffffff" },
      title: {
        showTitle: true,
        showGraphics: false,
        titleText: "TOGGLE\nLAP TIMING",
        bold: true,
        fontSize: 18,
        position: "bottom",
        customPosition: 0,
      },
      border: BORDER_DEFAULTS,
    });
    const svg = decodeDataUri(result);
    expect(svg).toContain("TOGGLE");
    expect(svg).not.toContain('width="100"');
  });

  it("should hide title when showTitle is false", () => {
    const result = assembleIcon({
      graphicSvg: MOCK_GRAPHIC,
      colors: { backgroundColor: "#2a3444", textColor: "#ffffff", graphic1Color: "#ffffff" },
      title: {
        showTitle: false,
        showGraphics: true,
        titleText: "TOGGLE\nLAP TIMING",
        bold: true,
        fontSize: 18,
        position: "bottom",
        customPosition: 0,
      },
      border: BORDER_DEFAULTS,
    });
    const svg = decodeDataUri(result);
    expect(svg).not.toContain("TOGGLE");
    expect(svg).toContain('width="100"');
  });
});

describe("getGlobalTitleSettings", () => {
  it("should return empty object when no global title settings", () => {
    vi.mocked(getGlobalSettings).mockReturnValue({} as unknown as GlobalSettings);
    const result = getGlobalTitleSettings();
    expect(result).toEqual({});
  });

  it("should extract title settings from global settings", () => {
    vi.mocked(getGlobalSettings).mockReturnValue({
      titleFontSize: 24,
      titleBold: true,
      titlePosition: "middle",
      titleShowTitle: false,
      titleShowGraphics: true,
      titleCustomPosition: -10,
    } as unknown as GlobalSettings);
    const result = getGlobalTitleSettings();
    expect(result).toEqual({
      fontSize: 24,
      bold: true,
      position: "middle",
      showTitle: false,
      showGraphics: true,
      customPosition: -10,
    });
  });

  it("should ignore non-title global settings", () => {
    vi.mocked(getGlobalSettings).mockReturnValue({
      colorBackgroundColor: "#fff",
      titleFontSize: 20,
    } as unknown as GlobalSettings);
    const result = getGlobalTitleSettings();
    expect(result).toEqual({ fontSize: 20 });
  });

  it("should return 'default' for bold when set to 'default'", () => {
    vi.mocked(getGlobalSettings).mockReturnValue({
      titleBold: "default",
    } as unknown as GlobalSettings);
    const result = getGlobalTitleSettings();
    expect(result.bold).toBe("default");
  });

  it("should return 'default' for fontSize when titleFontSizeDefault is true", () => {
    vi.mocked(getGlobalSettings).mockReturnValue({
      titleFontSizeDefault: true,
      titleFontSize: 20,
    } as unknown as GlobalSettings);
    const result = getGlobalTitleSettings();
    expect(result.fontSize).toBe("default");
  });

  it("should return 'default' for position and customPosition when position is 'default'", () => {
    vi.mocked(getGlobalSettings).mockReturnValue({
      titlePosition: "default",
      titleCustomPosition: 10,
    } as unknown as GlobalSettings);
    const result = getGlobalTitleSettings();
    expect(result.position).toBe("default");
    expect(result.customPosition).toBe("default");
  });
});

describe("resolveBorderSettings", () => {
  const GRAPHIC_WITH_BORDER = `<svg><desc>{"colors":{},"border":{"color":"#5a5a5a"}}</desc></svg>`;
  const GRAPHIC_NO_BORDER = `<svg><desc>{"colors":{}}</desc></svg>`;

  it("should return BORDER_DEFAULTS when no overrides or global", () => {
    vi.mocked(getGlobalSettings).mockReturnValue({} as unknown as GlobalSettings);
    const result = resolveBorderSettings(GRAPHIC_NO_BORDER, {});
    expect(result).toEqual(BORDER_DEFAULTS);
  });

  it("should use icon border color default from desc metadata", () => {
    vi.mocked(getGlobalSettings).mockReturnValue({} as unknown as GlobalSettings);
    const result = resolveBorderSettings(GRAPHIC_WITH_BORDER, {});
    expect(result.borderColor).toBe("#5a5a5a");
  });

  it("should use global settings over defaults", () => {
    const global: GlobalBorderSettings = { enabled: true, borderWidth: 20 };
    const result = resolveBorderSettings(GRAPHIC_NO_BORDER, global);
    expect(result.enabled).toBe(true);
    expect(result.borderWidth).toBe(20);
  });

  it("should use per-action overrides over global", () => {
    const global: GlobalBorderSettings = { enabled: true, borderWidth: 20 };
    const overrides = { enabled: false, borderWidth: 8 };
    const result = resolveBorderSettings(GRAPHIC_NO_BORDER, global, overrides);
    expect(result.enabled).toBe(false);
    expect(result.borderWidth).toBe(8);
  });

  it("should use stateColor over all other color sources", () => {
    const global: GlobalBorderSettings = { borderColor: "#ffffff" };
    const overrides = { borderColor: "#00aaff" };
    const result = resolveBorderSettings(GRAPHIC_WITH_BORDER, global, overrides, "#e74c3c");
    expect(result.borderColor).toBe("#e74c3c");
  });

  it("should treat 'default' global as unset and fall through", () => {
    const global: GlobalBorderSettings = { enabled: "default", glowEnabled: "default" };
    const result = resolveBorderSettings(GRAPHIC_NO_BORDER, global);
    expect(result.enabled).toBe(BORDER_DEFAULTS.enabled);
    expect(result.glowEnabled).toBe(BORDER_DEFAULTS.glowEnabled);
  });

  it("should resolve glowEnabled and glowWidth independently", () => {
    const global: GlobalBorderSettings = { glowEnabled: false, glowWidth: 50 };
    const result = resolveBorderSettings(GRAPHIC_NO_BORDER, global);
    expect(result.glowEnabled).toBe(false);
    expect(result.glowWidth).toBe(50);
  });

  describe("__FEATURE_BORDER_GLOW__ gating", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("should force glowEnabled to false when the flag is false", () => {
      vi.stubGlobal("__FEATURE_BORDER_GLOW__", false);
      const global: GlobalBorderSettings = { glowEnabled: true };
      const overrides = { glowEnabled: true };
      const result = resolveBorderSettings(GRAPHIC_NO_BORDER, global, overrides);
      expect(result.glowEnabled).toBe(false);
    });

    it("should respect resolved glowEnabled when the flag is true", () => {
      vi.stubGlobal("__FEATURE_BORDER_GLOW__", true);
      const overrides = { glowEnabled: true };
      const result = resolveBorderSettings(GRAPHIC_NO_BORDER, {}, overrides);
      expect(result.glowEnabled).toBe(true);
    });
  });

  describe("icon border defaults + locked fields (#755)", () => {
    const GRAPHIC_LOCKED_OFF = `<svg><desc>{"colors":{},"border":{"enabled":false,"glowEnabled":false,"locked":["enabled","glowEnabled"]}}</desc></svg>`;
    const GRAPHIC_UNLOCKED_DEFAULTS = `<svg><desc>{"colors":{},"border":{"enabled":false,"glowEnabled":false}}</desc></svg>`;

    it("uses icon enabled/glowEnabled defaults when nothing else is set", () => {
      const result = resolveBorderSettings(GRAPHIC_UNLOCKED_DEFAULTS, {});
      expect(result.enabled).toBe(false);
      expect(result.glowEnabled).toBe(false);
    });

    it("lets global settings beat unlocked icon defaults", () => {
      const global: GlobalBorderSettings = { enabled: true, glowEnabled: true };
      const result = resolveBorderSettings(GRAPHIC_UNLOCKED_DEFAULTS, global);
      expect(result.enabled).toBe(true);
      expect(result.glowEnabled).toBe(true);
    });

    it("skips global settings for locked fields — the icon stays border-less", () => {
      const global: GlobalBorderSettings = { enabled: true, glowEnabled: true, borderWidth: 12 };
      const result = resolveBorderSettings(GRAPHIC_LOCKED_OFF, global);
      expect(result.enabled).toBe(false);
      expect(result.glowEnabled).toBe(false);
      // Unlocked fields still take the global value.
      expect(result.borderWidth).toBe(12);
    });

    it("lets per-action overrides beat a locked field", () => {
      const global: GlobalBorderSettings = { enabled: true };
      const overrides = { enabled: true, glowEnabled: true };
      const result = resolveBorderSettings(GRAPHIC_LOCKED_OFF, global, overrides);
      expect(result.enabled).toBe(true);
      expect(result.glowEnabled).toBe(true);
    });

    it("skips global settings for a locked color field — the icon color default wins", () => {
      const graphic = `<svg><desc>{"colors":{},"border":{"color":"#111111","locked":["color"]}}</desc></svg>`;
      const global: GlobalBorderSettings = { borderColor: "#ffffff" };
      const result = resolveBorderSettings(graphic, global);
      expect(result.borderColor).toBe("#111111");
    });

    it("skips global settings for locked width fields, falling back to BORDER_DEFAULTS", () => {
      const graphic = `<svg><desc>{"colors":{},"border":{"locked":["borderWidth","glowWidth"]}}</desc></svg>`;
      const global: GlobalBorderSettings = { borderWidth: 12, glowWidth: 40 };
      const result = resolveBorderSettings(graphic, global);
      expect(result.borderWidth).toBe(BORDER_DEFAULTS.borderWidth);
      expect(result.glowWidth).toBe(BORDER_DEFAULTS.glowWidth);
    });
  });
});

describe("getGlobalBorderSettings", () => {
  it("should return empty object when no global border settings", () => {
    vi.mocked(getGlobalSettings).mockReturnValue({} as unknown as GlobalSettings);
    const result = getGlobalBorderSettings();
    expect(result).toEqual({});
  });

  it("should extract border settings from global settings", () => {
    vi.mocked(getGlobalSettings).mockReturnValue({
      borderEnabled: true,
      borderWidth: 20,
      borderColor: "#ff0000",
      borderGlowEnabled: false,
      borderGlowWidth: 40,
    } as unknown as GlobalSettings);
    const result = getGlobalBorderSettings();
    expect(result).toEqual({
      enabled: true,
      borderWidth: 20,
      borderColor: "#ff0000",
      glowEnabled: false,
      glowWidth: 40,
    });
  });

  it("should return 'default' for enabled when set to 'default'", () => {
    vi.mocked(getGlobalSettings).mockReturnValue({
      borderEnabled: "default",
    } as unknown as GlobalSettings);
    const result = getGlobalBorderSettings();
    expect(result.enabled).toBe("default");
  });
});

describe("assembleIcon with border", () => {
  const ENABLED_BORDER: ResolvedBorderSettings = {
    enabled: true,
    borderWidth: 8,
    borderColor: "#2ecc71",
    glowEnabled: false,
    glowWidth: 18,
  };

  const DISABLED_BORDER: ResolvedBorderSettings = { ...BORDER_DEFAULTS };

  it("should include border rect when border is enabled", () => {
    const result = assembleIcon({
      graphicSvg: MOCK_GRAPHIC,
      colors: { backgroundColor: "#2a3444", textColor: "#ffffff" },
      title: {
        showTitle: true,
        showGraphics: true,
        titleText: "TEST",
        bold: true,
        fontSize: 9,
        position: "bottom",
        customPosition: 0,
      },
      border: ENABLED_BORDER,
    });
    const svg = decodeDataUri(result);
    expect(svg).toContain('stroke="#2ecc71"');
    expect(svg).toContain('stroke-width="8"');
  });

  it("should not include border rect when border is disabled", () => {
    const result = assembleIcon({
      graphicSvg: MOCK_GRAPHIC,
      colors: { backgroundColor: "#2a3444", textColor: "#ffffff" },
      title: {
        showTitle: true,
        showGraphics: true,
        titleText: "TEST",
        bold: true,
        fontSize: 9,
        position: "bottom",
        customPosition: 0,
      },
      border: DISABLED_BORDER,
    });
    const svg = decodeDataUri(result);
    expect(svg).not.toContain("stroke=");
  });
});
