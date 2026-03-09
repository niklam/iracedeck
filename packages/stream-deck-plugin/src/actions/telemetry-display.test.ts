import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateTelemetryDisplaySvg } from "./telemetry-display.js";

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

vi.mock("../../icons/session-info.svg", () => ({
  default:
    '<svg xmlns="http://www.w3.org/2000/svg">{{backgroundColor}} {{titleLabel}} {{value}} {{valueFontSize}} {{textColor}}</svg>',
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
      const result = generateTelemetryDisplaySvg("TELEMETRY", "100", {
        template: "{{telemetry.Speed}}",
        title: "TELEMETRY",
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
      expect(result).toContain(encodeURIComponent("24"));
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
});
