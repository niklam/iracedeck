import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTOMATION_META_SVG,
  AUTOMATION_UUID,
  COMMAND_ICONS,
  COMMAND_TITLES,
  generateAutomationSvg,
  PIT_LIMITER_GRAPHIC,
  resolveEffectiveTrigger,
} from "./automation.js";

vi.mock("@iracedeck/icons/car-control/tear-off-visor.svg", () => ({
  default:
    '<svg xmlns="http://www.w3.org/2000/svg"><desc>{"colors":{"backgroundColor":"#2a3444"}}</desc><circle r="10"/></svg>',
}));
vi.mock("@iracedeck/icons/car-control/headlight-flash.svg", () => ({
  default:
    '<svg xmlns="http://www.w3.org/2000/svg"><desc>{"colors":{"backgroundColor":"#2a3444"}}</desc><rect width="10" height="10"/></svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/trigger-wipers.svg", () => ({
  default:
    '<svg xmlns="http://www.w3.org/2000/svg"><desc>{"colors":{"backgroundColor":"#2a3444"}}</desc><line x1="0" y1="0" x2="10" y2="10"/></svg>',
}));

const mockIsRuleActive = vi.fn(() => false);
const mockIsPaused = vi.fn(() => false);

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
      };

      return schema;
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    updateConnectionState = vi.fn();
    setActiveBinding = vi.fn();
    tapBinding = vi.fn().mockResolvedValue(undefined);
    holdBinding = vi.fn().mockResolvedValue(undefined);
    releaseBinding = vi.fn().mockResolvedValue(undefined);
    setKeyImage = vi.fn();
    updateKeyImage = vi.fn().mockResolvedValue(true);
    setRegenerateCallback = vi.fn();
  },
  extractGraphicContent: vi.fn((svg: string) => {
    return svg
      .replace(/<svg[^>]*>/, "")
      .replace(/<\/svg>/, "")
      .replace(/<desc>.*?<\/desc>/, "");
  }),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  generateTitleText: vi.fn(({ text }: { text: string }) => `<text>${text}</text>`),
  getAutomationEngine: vi.fn(() => ({
    registerRule: vi.fn(),
    updateRule: vi.fn(),
    removeRule: vi.fn(),
    activateRule: vi.fn(),
    deactivateRule: vi.fn(),
    getRuleState: vi.fn(() => ({ active: false, lastFiredAt: null, fireCount: 0 })),
    isRuleActive: mockIsRuleActive,
    isPaused: mockIsPaused,
    onStateChange: vi.fn(() => () => undefined),
  })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalTitleSettings: vi.fn(() => ({})),
  ICON_BASE_TEMPLATE: "<svg>{{backgroundColor}}{{borderContent}}{{graphicContent}}{{titleContent}}</svg>",
  renderIconTemplate: vi.fn((_t: string, data: Record<string, string>) => {
    let result = _t;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(`{{${key}}}`, value ?? "");
    }

    return result;
  }),
  resolveIconColors: vi.fn(() => ({ backgroundColor: "#2a3444", textColor: "#ffffff" })),
  resolveBorderSettings: vi.fn(() => ({
    enabled: false,
    borderWidth: 7,
    borderColor: "#00aaff",
    glowEnabled: true,
    glowWidth: 18,
  })),
  resolveGraphicSettings: vi.fn(() => ({ scale: 100 })),
  resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle?: string) => ({
    showTitle: true,
    showGraphics: true,
    titleText: defaultTitle ?? "",
    bold: true,
    fontSize: 18,
    position: "top" as const,
    customPosition: 0,
  })),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

describe("Automation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRuleActive.mockReturnValue(false);
    mockIsPaused.mockReturnValue(false);
  });

  describe("constants", () => {
    it("should have correct UUID", () => {
      expect(AUTOMATION_UUID).toBe("com.iracedeck.sd.core.automation");
    });

    it("should have command icons for all commands", () => {
      expect(COMMAND_ICONS["tear-off-visor"]).toBeDefined();
      expect(COMMAND_ICONS["pit-limiter"]).toBeDefined();
      expect(COMMAND_ICONS["headlight-flash"]).toBeDefined();
      expect(COMMAND_ICONS["trigger-wipers"]).toBeDefined();
    });

    it("should use dedicated pit limiter graphic", () => {
      expect(COMMAND_ICONS["pit-limiter"]).toBe(PIT_LIMITER_GRAPHIC);
      expect(COMMAND_ICONS["pit-limiter"]).not.toBe(COMMAND_ICONS["tear-off-visor"]);
    });

    it("should have single-line titles without AUTO prefix", () => {
      expect(COMMAND_TITLES["tear-off-visor"]).toBe("VISOR");
      expect(COMMAND_TITLES["pit-limiter"]).toBe("LIMITER");
      expect(COMMAND_TITLES["headlight-flash"]).toBe("FLASH");
      expect(COMMAND_TITLES["trigger-wipers"]).toBe("WIPERS");
    });

    it("should have valid meta SVG with locked title settings", () => {
      expect(AUTOMATION_META_SVG).toContain("<desc>");
      expect(AUTOMATION_META_SVG).toContain('"position":"top"');
      expect(AUTOMATION_META_SVG).toContain('"locked"');
    });
  });

  describe("resolveEffectiveTrigger", () => {
    it("should force pit-boundary for pit-limiter", () => {
      expect(resolveEffectiveTrigger("pit-limiter", "lap")).toBe("pit-boundary");
      expect(resolveEffectiveTrigger("pit-limiter", "interval")).toBe("pit-boundary");
    });

    it("should pass through lap and interval for non-pit commands", () => {
      expect(resolveEffectiveTrigger("tear-off-visor", "lap")).toBe("lap");
      expect(resolveEffectiveTrigger("tear-off-visor", "interval")).toBe("interval");
      expect(resolveEffectiveTrigger("headlight-flash", "lap")).toBe("lap");
      expect(resolveEffectiveTrigger("trigger-wipers", "interval")).toBe("interval");
    });

    it("should fallback pit-boundary to lap for non-pit commands", () => {
      expect(resolveEffectiveTrigger("tear-off-visor", "pit-boundary")).toBe("lap");
    });
  });

  describe("generateAutomationSvg", () => {
    it("should show AUTO OFF for off state", () => {
      const result = generateAutomationSvg({ command: "tear-off-visor", trigger: "lap" } as never, "off");

      expect(result).toContain("data:image/svg+xml");
      expect(result).toContain(encodeURIComponent("AUTO OFF"));
    });

    it("should show AUTO ON for on state", () => {
      const result = generateAutomationSvg({ command: "tear-off-visor", trigger: "lap" } as never, "on");

      expect(result).toContain("data:image/svg+xml");
      expect(result).toContain(encodeURIComponent("AUTO ON"));
    });

    it("should show AUTO N/A for paused (na) state", () => {
      const result = generateAutomationSvg({ command: "tear-off-visor", trigger: "lap" } as never, "na");

      expect(result).toContain("data:image/svg+xml");
      expect(result).toContain(encodeURIComponent("AUTO N/A"));
    });

    it("should include single-line title for tear-off-visor", () => {
      const result = generateAutomationSvg({ command: "tear-off-visor", trigger: "lap" } as never, "off");

      expect(result).toContain(encodeURIComponent("VISOR"));
    });

    it("should include single-line title for headlight-flash", () => {
      const result = generateAutomationSvg({ command: "headlight-flash", trigger: "interval" } as never, "on");

      expect(result).toContain(encodeURIComponent("FLASH"));
    });

    it("should include extracted graphic content", () => {
      const result = generateAutomationSvg({ command: "tear-off-visor", trigger: "lap" } as never, "off");

      expect(result).toContain(encodeURIComponent("circle"));
    });
  });
});
