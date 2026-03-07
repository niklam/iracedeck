import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSplitsDeltaCycleSvg, GLOBAL_KEY_NAMES } from "./splits-delta-cycle.js";

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

vi.mock("@iracedeck/icons/splits-delta-cycle/next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/splits-delta-cycle/previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("../shared/index.js", () => ({
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
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    return result;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

describe("SplitsDeltaCycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("should have correct global key name for next", () => {
      expect(GLOBAL_KEY_NAMES.NEXT).toBe("splitsDeltaNext");
    });

    it("should have correct global key name for previous", () => {
      expect(GLOBAL_KEY_NAMES.PREVIOUS).toBe("splitsDeltaPrevious");
    });
  });

  describe("generateSplitsDeltaCycleSvg", () => {
    it("should generate a valid data URI for next direction", () => {
      const result = generateSplitsDeltaCycleSvg({ direction: "next" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for previous direction", () => {
      const result = generateSplitsDeltaCycleSvg({ direction: "previous" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for next and previous", () => {
      const next = generateSplitsDeltaCycleSvg({ direction: "next" });
      const previous = generateSplitsDeltaCycleSvg({ direction: "previous" });

      expect(next).not.toBe(previous);
    });

    it("should include NEXT label for next direction", () => {
      const result = generateSplitsDeltaCycleSvg({ direction: "next" });

      expect(decodeURIComponent(result)).toContain("NEXT");
    });

    it("should include PREVIOUS label for previous direction", () => {
      const result = generateSplitsDeltaCycleSvg({ direction: "previous" });

      expect(decodeURIComponent(result)).toContain("PREVIOUS");
    });

    it("should include SPLITS DELTA label for both directions", () => {
      const next = generateSplitsDeltaCycleSvg({ direction: "next" });
      const previous = generateSplitsDeltaCycleSvg({ direction: "previous" });

      expect(decodeURIComponent(next)).toContain("SPLITS DELTA");
      expect(decodeURIComponent(previous)).toContain("SPLITS DELTA");
    });
  });
});
