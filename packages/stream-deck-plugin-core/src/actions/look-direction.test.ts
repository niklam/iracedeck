import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateLookDirectionSvg, LOOK_DIRECTION_GLOBAL_KEYS } from "./look-direction.js";

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
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
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

describe("LookDirection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("LOOK_DIRECTION_GLOBAL_KEYS", () => {
    it("should have correct mapping for look-left", () => {
      expect(LOOK_DIRECTION_GLOBAL_KEYS["look-left"]).toBe("lookDirectionLeft");
    });

    it("should have correct mapping for look-right", () => {
      expect(LOOK_DIRECTION_GLOBAL_KEYS["look-right"]).toBe("lookDirectionRight");
    });

    it("should have correct mapping for look-up", () => {
      expect(LOOK_DIRECTION_GLOBAL_KEYS["look-up"]).toBe("lookDirectionUp");
    });

    it("should have correct mapping for look-down", () => {
      expect(LOOK_DIRECTION_GLOBAL_KEYS["look-down"]).toBe("lookDirectionDown");
    });

    it("should have exactly 4 entries", () => {
      expect(Object.keys(LOOK_DIRECTION_GLOBAL_KEYS)).toHaveLength(4);
    });
  });

  describe("generateLookDirectionSvg", () => {
    it("should generate a valid data URI for look-left", () => {
      const result = generateLookDirectionSvg({ direction: "look-left" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for look-right", () => {
      const result = generateLookDirectionSvg({ direction: "look-right" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all directions", () => {
      const directions = ["look-left", "look-right", "look-up", "look-down"] as const;

      for (const direction of directions) {
        const result = generateLookDirectionSvg({ direction });
        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different directions", () => {
      const left = generateLookDirectionSvg({ direction: "look-left" });
      const right = generateLookDirectionSvg({ direction: "look-right" });

      expect(left).not.toBe(right);
    });

    it("should include LOOK label for all directions", () => {
      const directions = ["look-left", "look-right", "look-up", "look-down"] as const;

      for (const direction of directions) {
        const result = generateLookDirectionSvg({ direction });
        expect(decodeURIComponent(result)).toContain("LOOK");
      }
    });

    it("should include correct labels for all directions", () => {
      const expectedLabels: Record<string, { line1: string; line2: string }> = {
        "look-left": { line1: "LOOK", line2: "LEFT" },
        "look-right": { line1: "LOOK", line2: "RIGHT" },
        "look-up": { line1: "LOOK", line2: "UP" },
        "look-down": { line1: "LOOK", line2: "DOWN" },
      };

      for (const [direction, labels] of Object.entries(expectedLabels)) {
        const result = generateLookDirectionSvg({ direction: direction as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);
        expect(decoded).toContain(labels.line2);
      }
    });
  });
});
