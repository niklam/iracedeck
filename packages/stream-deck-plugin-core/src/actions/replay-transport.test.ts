import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateReplayTransportSvg } from "./replay-transport.js";

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
  getCommands: vi.fn(() => ({
    replay: {
      play: vi.fn(() => true),
      pause: vi.fn(() => true),
      fastForward: vi.fn(() => true),
      rewind: vi.fn(() => true),
      slowMotion: vi.fn(() => true),
      nextFrame: vi.fn(() => true),
      prevFrame: vi.fn(() => true),
    },
  })),
  LogLevel: { Info: 2 },
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

describe("ReplayTransport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateReplayTransportSvg", () => {
    const ALL_TRANSPORTS = [
      "play",
      "pause",
      "stop",
      "fast-forward",
      "rewind",
      "slow-motion",
      "frame-forward",
      "frame-backward",
    ] as const;

    it.each(ALL_TRANSPORTS)("should generate a valid data URI for %s", (transport) => {
      const result = generateReplayTransportSvg({ transport });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different transport actions", () => {
      const results = ALL_TRANSPORTS.map((transport) => generateReplayTransportSvg({ transport }));

      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(ALL_TRANSPORTS.length);
    });

    it("should include PLAY label for play transport", () => {
      const result = generateReplayTransportSvg({ transport: "play" });

      expect(decodeURIComponent(result)).toContain("PLAY");
    });

    it("should include PAUSE label for pause transport", () => {
      const result = generateReplayTransportSvg({ transport: "pause" });

      expect(decodeURIComponent(result)).toContain("PAUSE");
    });

    it("should include STOP label for stop transport", () => {
      const result = generateReplayTransportSvg({ transport: "stop" });

      expect(decodeURIComponent(result)).toContain("STOP");
    });

    it("should include FWD label for fast-forward transport", () => {
      const result = generateReplayTransportSvg({ transport: "fast-forward" });

      expect(decodeURIComponent(result)).toContain("FWD");
    });

    it("should include REWIND label for rewind transport", () => {
      const result = generateReplayTransportSvg({ transport: "rewind" });

      expect(decodeURIComponent(result)).toContain("REWIND");
    });

    it("should include SLOW MO label for slow-motion transport", () => {
      const result = generateReplayTransportSvg({ transport: "slow-motion" });

      expect(decodeURIComponent(result)).toContain("SLOW MO");
    });

    it("should include REPLAY secondary label for play/pause/stop/fast-forward/rewind/slow-motion", () => {
      const transports = [
        "play",
        "pause",
        "stop",
        "fast-forward",
        "rewind",
        "slow-motion",
      ] as const;

      for (const transport of transports) {
        const result = generateReplayTransportSvg({ transport });
        expect(decodeURIComponent(result)).toContain("REPLAY");
      }
    });

    it("should include FWD secondary label for frame-forward", () => {
      const result = generateReplayTransportSvg({ transport: "frame-forward" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FRAME");
      expect(decoded).toContain("FWD");
    });

    it("should include BACK secondary label for frame-backward", () => {
      const result = generateReplayTransportSvg({ transport: "frame-backward" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FRAME");
      expect(decoded).toContain("BACK");
    });
  });
});
