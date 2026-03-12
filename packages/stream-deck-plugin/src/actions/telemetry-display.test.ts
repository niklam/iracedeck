import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateTelemetryDisplaySvg, generateValueContent } from "./telemetry-display.js";

vi.mock("@elgato/streamdeck", () => ({
  default: {
    logger: {
      createScope: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
      })),
    },
  },
  action: () => (target: unknown) => target,
}));

vi.mock("../../icons/telemetry-display.svg", () => ({
  default:
    '<svg xmlns="http://www.w3.org/2000/svg">{{backgroundColor}} {{titleColor}} {{titleLabel}} {{valueContent}}</svg>',
}));

vi.mock("@iracedeck/iracing-sdk", () => ({
  resolveTemplate: vi.fn((template: string) => template.replace("{{telemetry.Speed}}", "156.79")),
}));

vi.mock("../shared/index.js", () => ({
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getCurrentTelemetry: vi.fn(() => null),
      getCurrentTemplateContext: vi.fn(() => null),
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    updateKeyImage = vi.fn();
  },
  createSDLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
  escapeXml: vi.fn((str: string) => str),
  LogLevel: { Info: 2 },
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
        backgroundColor: "#2a3444",
        textColor: "#ffffff",
        fontSize: 18,
      });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should use custom colors", () => {
      const result = generateTelemetryDisplaySvg("TEST", "42", {
        template: "42",
        title: "TEST",
        backgroundColor: "#ff0000",
        textColor: "#00ff00",
        fontSize: 24,
      });

      expect(result).toContain(encodeURIComponent("#ff0000"));
      expect(result).toContain(encodeURIComponent("#00ff00"));
    });

    it("should use text color for title", () => {
      const result = generateTelemetryDisplaySvg("SPEED", "150", {
        template: "",
        title: "SPEED",
        backgroundColor: "#2a3444",
        textColor: "#ff0000",
        fontSize: 18,
      });

      const decoded = decodeURIComponent(result);
      // titleColor should match textColor
      expect(decoded).toContain("#ff0000");
    });

    it("should encode title and value", () => {
      const result = generateTelemetryDisplaySvg("SPEED", "150", {
        template: "",
        title: "SPEED",
        backgroundColor: "#2a3444",
        textColor: "#ffffff",
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
      // baseY = 51 + (18 - 22) / 3
      expect(result).toMatch(/y="49\.6+/);
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
});
