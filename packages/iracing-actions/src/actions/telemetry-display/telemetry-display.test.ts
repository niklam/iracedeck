import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateTelemetryDisplaySvg, generateValueContent, TelemetryDisplay } from "./telemetry-display.js";

vi.mock("../../../icons/telemetry-display.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{backgroundColor}} {{titleContent}} {{valueContent}}</svg>',
}));

vi.mock("@iracedeck/iracing-sdk", () => ({
  resolveTemplate: vi.fn((template: string) => template.replace("{{telemetry.Speed}}", "156.79")),
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
      // Return a mock Zod-like schema
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
    sdkController = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getCurrentTelemetry: vi.fn(() => null),
      getCurrentTemplateContext: vi.fn(() => null),
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn();
    // Prototype methods (not instance fields) so subclass overrides win and
    // super.onWillAppear(...) still resolves.
    async onWillAppear(): Promise<void> {}
    async onDidReceiveSettings(): Promise<void> {}
    async onWillDisappear(): Promise<void> {}
  },
  escapeXml: vi.fn((str: string) => str),
  IconUpdateThrottle: class {
    schedule(_id: string, render: () => unknown): void {
      void render();
    }
    clear(): void {}
    clearAll(): void {}
  },
  resolveTitleTemplate: vi.fn((text: string) => text.replace("{{self.car_number}}", "34")),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
  generateTitleText: vi.fn(({ text, fill }: { text: string; fill: string }) => {
    if (!text) return "";

    return `<text fill="${fill}">${text}</text>`;
  }),
  getGlobalTitleSettings: vi.fn(() => ({})),
  resolveBorderSettings: vi.fn((_svg: unknown, _global: unknown, _overrides?: unknown, _stateColor?: string) => ({
    enabled: false,
    borderWidth: 7,
    borderColor: "#00aaff",
    glowEnabled: true,
    glowWidth: 18,
  })),
  resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
  resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle?: string) => ({
    showTitle: true,
    showGraphics: true,
    titleText: defaultTitle ?? "",
    bold: true,
    fontSize: 18,
    position: "bottom" as const,
    customPosition: 0,
  })),
  resolveIconColors: vi.fn((_svg: string, _global: unknown, overrides: Record<string, string> | undefined) => ({
    backgroundColor: overrides?.backgroundColor || "#2a3444",
    textColor: overrides?.textColor || "#ffffff",
  })),
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    return result;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

describe("TelemetryDisplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateTelemetryDisplaySvg", () => {
    it("should produce a data URI", () => {
      const result = generateTelemetryDisplaySvg("CAR #", "100", {
        template: "{{sessionInfo.DriverInfo.DriverCarIdx}}",
        title: "CAR #",
        fontSize: 18,
      });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should use custom colors via colorOverrides", () => {
      const result = generateTelemetryDisplaySvg("TEST", "42", {
        template: "42",
        title: "TEST",
        fontSize: 24,
        colorOverrides: {
          backgroundColor: "#ff0000",
          textColor: "#00ff00",
        },
      });

      expect(result).toContain(encodeURIComponent("#ff0000"));
      expect(result).toContain(encodeURIComponent("#00ff00"));
    });

    it("should use text color for title", () => {
      const result = generateTelemetryDisplaySvg("SPEED", "150", {
        template: "",
        title: "SPEED",
        fontSize: 18,
        colorOverrides: {
          textColor: "#ff0000",
        },
      });

      const decoded = decodeURIComponent(result);
      // titleColor should match textColor
      expect(decoded).toContain("#ff0000");
    });

    it("should encode title and value", () => {
      const result = generateTelemetryDisplaySvg("SPEED", "150", {
        template: "",
        title: "SPEED",
        fontSize: 18,
      });

      expect(result).toContain(encodeURIComponent("SPEED"));
      expect(result).toContain(encodeURIComponent("150"));
    });
  });

  describe("generateValueContent", () => {
    it("should generate a single text element for single-line value", () => {
      const result = generateValueContent("150", 18, "#ffffff");

      expect(result).toContain("<text");
      expect(result).toContain("150");
      // baseY = 88 + (18 - 44) / 3 = 79.33 (144x144 coordinates)
      expect(result).toMatch(/y="79\.3+/);
      expect(result).toContain('font-size="18"');
      expect(result).toContain('fill="#ffffff"');
      expect(result.match(/<text /g)?.length).toBe(1);
    });

    it("should generate multiple text elements for multiline value", () => {
      const result = generateValueContent("Line1\nLine2", 14, "#00ff00");

      expect(result).toContain("Line1");
      expect(result).toContain("Line2");
      expect(result.match(/<text /g)?.length).toBe(2);
      expect(result).toContain('fill="#00ff00"');
    });

    it("should filter out empty lines", () => {
      const result = generateValueContent("Line1\n\nLine2", 14, "#ffffff");

      expect(result.match(/<text /g)?.length).toBe(2);
    });

    it("should handle empty value", () => {
      const result = generateValueContent("", 18, "#ffffff");

      expect(result).toContain("<text");
      expect(result.match(/<text /g)?.length).toBe(1);
    });
  });

  describe("title template resolution (#899)", () => {
    it("resolves {{…}} placeholders in the title setting when rendering", async () => {
      const action = new TelemetryDisplay();
      const ev = {
        action: {
          id: "ctx-td",
          isKey: () => true,
          setTitle: vi.fn().mockResolvedValue(undefined),
        },
        payload: { settings: { title: "CAR {{self.car_number}}", template: "", fontSize: 15 } },
      } as never;

      await action.onWillAppear(ev);

      const mocked = action as unknown as { setKeyImage: ReturnType<typeof vi.fn> };
      const svgArg = mocked.setKeyImage.mock.calls[0][1] as string;
      expect(decodeURIComponent(svgArg)).toContain("CAR 34");
    });
  });
});
