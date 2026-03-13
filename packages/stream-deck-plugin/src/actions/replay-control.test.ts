import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateReplayControlSvg } from "./replay-control.js";

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

// Mock all 17 replay-control icon SVGs
vi.mock("@iracedeck/icons/replay-control/play-pause.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">play-pause {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/stop.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">stop {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/fast-forward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fast-forward {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/rewind.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rewind {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/slow-motion.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">slow-motion {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/frame-forward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">frame-forward {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/frame-backward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">frame-backward {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/speed-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">speed-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/speed-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">speed-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/next-session.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-session {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-session.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-session {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/next-lap.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-lap {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-lap.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-lap {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/next-incident.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-incident {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-incident.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-incident {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/jump-to-beginning.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">jump-to-beginning {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/jump-to-live.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">jump-to-live {{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("../shared/index.js", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
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
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn(() => null) };
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
      nextSession: vi.fn(() => true),
      prevSession: vi.fn(() => true),
      nextLap: vi.fn(() => true),
      prevLap: vi.fn(() => true),
      nextIncident: vi.fn(() => true),
      prevIncident: vi.fn(() => true),
      goToStart: vi.fn(() => true),
      goToEnd: vi.fn(() => true),
    },
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

describe("ReplayControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateReplayControlSvg", () => {
    const ALL_MODES = [
      "play-pause",
      "stop",
      "fast-forward",
      "rewind",
      "slow-motion",
      "frame-forward",
      "frame-backward",
      "speed-increase",
      "speed-decrease",
      "next-session",
      "prev-session",
      "next-lap",
      "prev-lap",
      "next-incident",
      "prev-incident",
      "jump-to-beginning",
      "jump-to-live",
    ] as const;

    it.each(ALL_MODES)("should generate a valid data URI for %s", (mode) => {
      const result = generateReplayControlSvg({ mode });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different modes", () => {
      const results = ALL_MODES.map((mode) => generateReplayControlSvg({ mode }));

      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(ALL_MODES.length);
    });

    // Transport labels
    it("should include PLAY label for play-pause mode", () => {
      const result = generateReplayControlSvg({ mode: "play-pause" });

      expect(decodeURIComponent(result)).toContain("PLAY");
      expect(decodeURIComponent(result)).toContain("REPLAY");
    });

    it("should include STOP label for stop mode", () => {
      const result = generateReplayControlSvg({ mode: "stop" });

      expect(decodeURIComponent(result)).toContain("STOP");
      expect(decodeURIComponent(result)).toContain("REPLAY");
    });

    it("should include FWD label for fast-forward mode", () => {
      const result = generateReplayControlSvg({ mode: "fast-forward" });

      expect(decodeURIComponent(result)).toContain("FWD");
      expect(decodeURIComponent(result)).toContain("REPLAY");
    });

    it("should include REWIND label for rewind mode", () => {
      const result = generateReplayControlSvg({ mode: "rewind" });

      expect(decodeURIComponent(result)).toContain("REWIND");
      expect(decodeURIComponent(result)).toContain("REPLAY");
    });

    it("should include SLOW MO label for slow-motion mode", () => {
      const result = generateReplayControlSvg({ mode: "slow-motion" });

      expect(decodeURIComponent(result)).toContain("SLOW MO");
      expect(decodeURIComponent(result)).toContain("REPLAY");
    });

    it("should include FRAME FWD labels for frame-forward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "frame-forward" }));

      expect(decoded).toContain("FRAME FWD");
      expect(decoded).toContain("REPLAY");
    });

    it("should include FRAME BACK labels for frame-backward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "frame-backward" }));

      expect(decoded).toContain("FRAME BACK");
      expect(decoded).toContain("REPLAY");
    });

    // Speed labels
    it("should include SPEED UP label for speed-increase mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-increase" }));

      expect(decoded).toContain("SPEED UP");
      expect(decoded).toContain("REPLAY");
    });

    it("should include SLOW DOWN label for speed-decrease mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-decrease" }));

      expect(decoded).toContain("SLOW DOWN");
      expect(decoded).toContain("REPLAY");
    });

    // Navigation labels
    it("should include NEXT and SESSION labels for next-session mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "next-session" }));

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("SESSION");
    });

    it("should include PREVIOUS and SESSION labels for prev-session mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "prev-session" }));

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("SESSION");
    });

    it("should include NEXT and LAP labels for next-lap mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "next-lap" }));

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("LAP");
    });

    it("should include PREVIOUS and LAP labels for prev-lap mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "prev-lap" }));

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("LAP");
    });

    it("should include NEXT and INCIDENT labels for next-incident mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "next-incident" }));

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("INCIDENT");
    });

    it("should include PREVIOUS and INCIDENT labels for prev-incident mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "prev-incident" }));

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("INCIDENT");
    });

    it("should include BEGINNING and REPLAY labels for jump-to-beginning mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "jump-to-beginning" }));

      expect(decoded).toContain("BEGINNING");
      expect(decoded).toContain("REPLAY");
    });

    it("should include LIVE and REPLAY labels for jump-to-live mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "jump-to-live" }));

      expect(decoded).toContain("LIVE");
      expect(decoded).toContain("REPLAY");
    });
  });
});
