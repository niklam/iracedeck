import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateTestGammaSvg, GLOBAL_KEY_NAME } from "./test-gamma.js";

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
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

describe("TestGamma", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("should have correct global key name", () => {
      expect(GLOBAL_KEY_NAME).toBe("testGammaActivate");
    });
  });

  describe("generateTestGammaSvg", () => {
    it("should generate a valid data URI", () => {
      const result = generateTestGammaSvg();

      expect(result).toContain("data:image/svg+xml");
    });

    it("should include TEST label", () => {
      const result = generateTestGammaSvg();

      expect(decodeURIComponent(result)).toContain("TEST");
    });

    it("should include GAMMA label", () => {
      const result = generateTestGammaSvg();

      expect(decodeURIComponent(result)).toContain("GAMMA");
    });
  });
});
