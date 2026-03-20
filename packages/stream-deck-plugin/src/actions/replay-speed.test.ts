import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateReplaySpeedSvg } from "./replay-speed.js";

vi.mock("@iracedeck/icons/replay-speed/increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-speed/decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));

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

vi.mock("../shared/index.js", () => ({
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
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
  },
  createSDLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
  getCommands: vi.fn(() => ({
    replay: {
      play: vi.fn(() => true),
      fastForward: vi.fn(() => true),
      rewind: vi.fn(() => true),
    },
  })),
  getGlobalColors: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    return result;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

describe("ReplaySpeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateReplaySpeedSvg", () => {
    const ALL_DIRECTIONS = ["increase", "decrease"] as const;

    it.each(ALL_DIRECTIONS)("should generate a valid data URI for %s", (direction) => {
      const result = generateReplaySpeedSvg({ direction });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for increase vs decrease", () => {
      const results = ALL_DIRECTIONS.map((direction) => generateReplaySpeedSvg({ direction }));

      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(ALL_DIRECTIONS.length);
    });

    it("should include FASTER label for increase direction", () => {
      const result = generateReplaySpeedSvg({ direction: "increase" });

      expect(decodeURIComponent(result)).toContain("FASTER");
    });

    it("should include SLOWER label for decrease direction", () => {
      const result = generateReplaySpeedSvg({ direction: "decrease" });

      expect(decodeURIComponent(result)).toContain("SLOWER");
    });

    it("should include REPLAY secondary label for both directions", () => {
      for (const direction of ALL_DIRECTIONS) {
        const result = generateReplaySpeedSvg({ direction });
        expect(decodeURIComponent(result)).toContain("REPLAY");
      }
    });
  });
});
