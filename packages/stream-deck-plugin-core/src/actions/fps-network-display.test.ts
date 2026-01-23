import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ICON_COLOR, generateFpsNetworkDisplaySvg, GLOBAL_KEY_FPS_NETWORK } from "./fps-network-display.js";

// Mock the Stream Deck SDK before importing the module
vi.mock("@elgato/streamdeck", () => ({
  default: {
    logger: {
      createScope: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
        setLogLevel: vi.fn(),
      })),
    },
  },
  action: () => (target: unknown) => target,
}));

// Mock the SVG template import
vi.mock("../../icons/fps-network-display.svg", () => ({
  default: "<svg>{{color}}{{textElement}}</svg>",
}));

// Mock the shared utilities
vi.mock("@iracedeck/stream-deck-shared", () => ({
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
  },
  createSDLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
  formatKeyBinding: vi.fn((binding) => binding?.key?.toUpperCase() || ""),
  generateIconText: vi.fn(() => "<text>FPS/Net</text>"),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  parseKeyBinding: vi.fn((value) => {
    if (typeof value === "string" && value) {
      try {
        return JSON.parse(value);
      } catch {
        return undefined;
      }
    }

    return value;
  }),
  renderIconTemplate: vi.fn((template, vars) => {
    return template.replace("{{color}}", vars.color).replace("{{textElement}}", vars.textElement);
  }),
  svgToDataUri: vi.fn((svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
  LogLevel: { Info: 2 },
}));

describe("FpsNetworkDisplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("should have correct default icon color", () => {
      expect(DEFAULT_ICON_COLOR).toBe("#ffffff");
    });

    it("should have correct global settings key", () => {
      expect(GLOBAL_KEY_FPS_NETWORK).toBe("fpsNetworkDisplay");
    });
  });

  describe("generateFpsNetworkDisplaySvg", () => {
    it("should generate a data URI", () => {
      const result = generateFpsNetworkDisplaySvg();

      expect(result).toContain("data:image/svg+xml");
    });

    it("should include the icon color in the SVG", () => {
      const result = generateFpsNetworkDisplaySvg();

      expect(result).toContain(encodeURIComponent("#ffffff"));
    });

    it("should include the text element in the SVG", () => {
      const result = generateFpsNetworkDisplaySvg();

      expect(result).toContain(encodeURIComponent("<text>FPS/Net</text>"));
    });
  });
});
