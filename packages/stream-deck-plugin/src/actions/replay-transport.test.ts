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

vi.mock("@iracedeck/icons/replay-transport/play.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/pause.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/stop.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/fast-forward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/rewind.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/slow-motion.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/frame-forward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/frame-backward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
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
      pause: vi.fn(() => true),
      fastForward: vi.fn(() => true),
      rewind: vi.fn(() => true),
      slowMotion: vi.fn(() => true),
      nextFrame: vi.fn(() => true),
      prevFrame: vi.fn(() => true),
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

    it("should include FORWARD and FAST labels for fast-forward transport", () => {
      const decoded = decodeURIComponent(generateReplayTransportSvg({ transport: "fast-forward" }));

      expect(decoded).toContain("FORWARD");
      expect(decoded).toContain("FAST");
    });

    it("should include REWIND label for rewind transport", () => {
      const result = generateReplayTransportSvg({ transport: "rewind" });

      expect(decodeURIComponent(result)).toContain("REWIND");
    });

    it("should include MOTION and SLOW labels for slow-motion transport", () => {
      const decoded = decodeURIComponent(generateReplayTransportSvg({ transport: "slow-motion" }));

      expect(decoded).toContain("MOTION");
      expect(decoded).toContain("SLOW");
    });

    it("should include FRAME FWD label for frame-forward", () => {
      const decoded = decodeURIComponent(generateReplayTransportSvg({ transport: "frame-forward" }));

      expect(decoded).toContain("FRAME FWD");
    });

    it("should include FRAME BACK label for frame-backward", () => {
      const decoded = decodeURIComponent(generateReplayTransportSvg({ transport: "frame-backward" }));

      expect(decoded).toContain("FRAME BACK");
    });
  });
});
