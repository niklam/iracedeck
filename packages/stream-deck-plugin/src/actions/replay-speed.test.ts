import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateReplaySpeedSvg } from "./replay-speed.js";

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
  getCommands: vi.fn(() => ({
    replay: {
      play: vi.fn(() => true),
      fastForward: vi.fn(() => true),
      rewind: vi.fn(() => true),
    },
  })),
  LogLevel: { Info: 2 },
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`;
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

    it("should include SPEED UP label for increase direction", () => {
      const result = generateReplaySpeedSvg({ direction: "increase" });

      expect(decodeURIComponent(result)).toContain("SPEED UP");
    });

    it("should include SLOW DOWN label for decrease direction", () => {
      const result = generateReplaySpeedSvg({ direction: "decrease" });

      expect(decodeURIComponent(result)).toContain("SLOW DOWN");
    });

    it("should include REPLAY secondary label for both directions", () => {
      for (const direction of ALL_DIRECTIONS) {
        const result = generateReplaySpeedSvg({ direction });
        expect(decodeURIComponent(result)).toContain("REPLAY");
      }
    });
  });
});
