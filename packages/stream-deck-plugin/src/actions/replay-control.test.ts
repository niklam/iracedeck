import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  calculateNeedleAngle,
  formatSetSpeedLabel,
  formatSpeedDisplay,
  generateReplayControlSvg,
  parseSpeedSetting,
} from "./replay-control.js";

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

// Mock all replay-control icon SVGs
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
vi.mock("@iracedeck/icons/replay-control/set-speed.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">set-speed {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/speed-display.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">speed-display {{speedText}} {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/pause.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">pause-icon {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/play-backward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">play-backward {{mainLabel}} {{subLabel}}</svg>',
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
vi.mock("@iracedeck/icons/replay-control/jump-to-my-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">jump-to-my-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/next-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-car {{mainLabel}} {{subLabel}}</svg>',
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
    updateKeyImage = vi.fn();
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
      setPlaySpeed: vi.fn(() => true),
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
    camera: {
      switchPos: vi.fn(() => true),
      cycleCar: vi.fn(() => true),
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

  describe("parseSpeedSetting", () => {
    it("should parse normal speed values", () => {
      expect(parseSpeedSetting("1")).toEqual({ speed: 1, slowMotion: false });
      expect(parseSpeedSetting("8")).toEqual({ speed: 8, slowMotion: false });
      expect(parseSpeedSetting("16")).toEqual({ speed: 16, slowMotion: false });
    });

    it("should parse slow-motion speed values", () => {
      expect(parseSpeedSetting("s2")).toEqual({ speed: 2, slowMotion: true });
      expect(parseSpeedSetting("s8")).toEqual({ speed: 8, slowMotion: true });
      expect(parseSpeedSetting("s16")).toEqual({ speed: 16, slowMotion: true });
    });

    it("should clamp normal speeds to valid range", () => {
      expect(parseSpeedSetting("0")).toEqual({ speed: 1, slowMotion: false });
      expect(parseSpeedSetting("20")).toEqual({ speed: 16, slowMotion: false });
    });

    it("should clamp slow-motion speeds to valid range", () => {
      expect(parseSpeedSetting("s1")).toEqual({ speed: 2, slowMotion: true });
      expect(parseSpeedSetting("s20")).toEqual({ speed: 16, slowMotion: true });
    });

    it("should handle invalid input gracefully", () => {
      expect(parseSpeedSetting("abc")).toEqual({ speed: 1, slowMotion: false });
      expect(parseSpeedSetting("sabc")).toEqual({ speed: 2, slowMotion: true });
    });
  });

  describe("formatSpeedDisplay", () => {
    it("should format paused state", () => {
      expect(formatSpeedDisplay(0, false)).toBe("PAUSED");
    });

    it("should format normal forward speeds", () => {
      expect(formatSpeedDisplay(1, false)).toBe("1x");
      expect(formatSpeedDisplay(4, false)).toBe("4x");
      expect(formatSpeedDisplay(16, false)).toBe("16x");
    });

    it("should format rewind speeds", () => {
      expect(formatSpeedDisplay(-2, false)).toBe("-2x");
      expect(formatSpeedDisplay(-16, false)).toBe("-16x");
    });

    it("should format slow-motion speeds", () => {
      expect(formatSpeedDisplay(2, true)).toBe("1/2x");
      expect(formatSpeedDisplay(4, true)).toBe("1/4x");
      expect(formatSpeedDisplay(16, true)).toBe("1/16x");
    });

    it("should format reverse slow-motion speeds", () => {
      expect(formatSpeedDisplay(-2, true)).toBe("-1/2x");
      expect(formatSpeedDisplay(-4, true)).toBe("-1/4x");
      expect(formatSpeedDisplay(-16, true)).toBe("-1/16x");
    });
  });

  describe("formatSetSpeedLabel", () => {
    it("should format normal speed settings", () => {
      expect(formatSetSpeedLabel("1")).toBe("1x");
      expect(formatSetSpeedLabel("8")).toBe("8x");
    });

    it("should format slow-motion speed settings", () => {
      expect(formatSetSpeedLabel("s2")).toBe("1/2x");
      expect(formatSetSpeedLabel("s16")).toBe("1/16x");
    });
  });

  describe("calculateNeedleAngle", () => {
    it("should return -90 for slowest speed (1/16x)", () => {
      expect(calculateNeedleAngle("s16")).toBe(-90);
    });

    it("should return 0 for normal speed (1x)", () => {
      expect(calculateNeedleAngle("1")).toBe(0);
    });

    it("should return 90 for fastest speed (16x)", () => {
      expect(calculateNeedleAngle("16")).toBe(90);
    });

    it("should return -6 for 1/2x slow-mo", () => {
      expect(calculateNeedleAngle("s2")).toBe(-6);
    });

    it("should return 6 for 2x", () => {
      expect(calculateNeedleAngle("2")).toBe(6);
    });

    it("should return 48 for 9x (midpoint of fast range)", () => {
      expect(calculateNeedleAngle("9")).toBeCloseTo(48, 0);
    });
  });

  describe("generateReplayControlSvg", () => {
    const ALL_MODES = [
      "play-pause",
      "play-backward",
      "stop",
      "fast-forward",
      "rewind",
      "slow-motion",
      "frame-forward",
      "frame-backward",
      "speed-increase",
      "speed-decrease",
      "set-speed",
      "speed-display",
      "next-session",
      "prev-session",
      "next-lap",
      "prev-lap",
      "next-incident",
      "prev-incident",
      "jump-to-beginning",
      "jump-to-live",
      "jump-to-my-car",
      "next-car",
      "prev-car",
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
    });

    it("should include PLAY and BACKWARD labels for play-backward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-backward" }));

      expect(decoded).toContain("PLAY");
      expect(decoded).toContain("BACKWARD");
    });

    it("should show PAUSE label and pause icon for play-backward when isPlaying is true", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-backward" }, true));

      expect(decoded).toContain("PAUSE");
      expect(decoded).toContain("pause-icon");
      expect(decoded).not.toContain("BACKWARD");
    });

    it("should show PLAY label for play-backward when isPlaying is false", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-backward" }, false));

      expect(decoded).toContain("PLAY");
      expect(decoded).toContain("BACKWARD");
      expect(decoded).not.toContain("PAUSE");
    });

    it("should include STOP label for stop mode", () => {
      const result = generateReplayControlSvg({ mode: "stop" });

      expect(decodeURIComponent(result)).toContain("STOP");
    });

    it("should include FORWARD and FAST labels for fast-forward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "fast-forward" }));

      expect(decoded).toContain("FORWARD");
      expect(decoded).toContain("FAST");
    });

    it("should include REWIND label for rewind mode", () => {
      const result = generateReplayControlSvg({ mode: "rewind" });

      expect(decodeURIComponent(result)).toContain("REWIND");
    });

    it("should include MOTION and SLOW labels for slow-motion mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "slow-motion" }));

      expect(decoded).toContain("MOTION");
      expect(decoded).toContain("SLOW");
    });

    it("should include FRAME FWD label for frame-forward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "frame-forward" }));

      expect(decoded).toContain("FRAME FWD");
    });

    it("should include FRAME BACK label for frame-backward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "frame-backward" }));

      expect(decoded).toContain("FRAME BACK");
    });

    // Speed labels
    it("should include FASTER and REPLAY labels for speed-increase mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-increase" }));

      expect(decoded).toContain("FASTER");
      expect(decoded).toContain("REPLAY");
    });

    it("should include SLOWER and REPLAY labels for speed-decrease mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-decrease" }));

      expect(decoded).toContain("SLOWER");
      expect(decoded).toContain("REPLAY");
    });

    // Set speed labels
    it("should show configured speed label for set-speed mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "set-speed", speed: "4" }));

      expect(decoded).toContain("4x");
      expect(decoded).toContain("SET SPEED");
    });

    it("should show slow-motion speed label for set-speed mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "set-speed", speed: "s4" }));

      expect(decoded).toContain("1/4x");
      expect(decoded).toContain("SET SPEED");
    });

    // Speed display labels
    it("should show current speed for speed-display mode when playing", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-display" }, true, 4, false));

      expect(decoded).toContain("4x");
      expect(decoded).toContain("SPEED");
    });

    it("should show PAUSED for speed-display mode when not playing", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-display" }, false, 0, false));

      expect(decoded).toContain("PAUSED");
    });

    it("should show slow-motion speed for speed-display mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-display" }, true, 4, true));

      expect(decoded).toContain("1/4x");
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

    it("should include LAP and NEXT labels for next-lap mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "next-lap" }));

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("LAP");
    });

    it("should include LAP and PREVIOUS labels for prev-lap mode", () => {
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

    it("should include BEGINNING and JUMP TO labels for jump-to-beginning mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "jump-to-beginning" }));

      expect(decoded).toContain("BEGINNING");
      expect(decoded).toContain("JUMP TO");
    });

    it("should include LIVE and JUMP TO labels for jump-to-live mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "jump-to-live" }));

      expect(decoded).toContain("LIVE");
      expect(decoded).toContain("JUMP TO");
    });

    // Camera labels
    it("should include MY CAR and JUMP TO labels for jump-to-my-car mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "jump-to-my-car" }));

      expect(decoded).toContain("MY CAR");
      expect(decoded).toContain("JUMP TO");
    });

    it("should include NEXT and CAR labels for next-car mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "next-car" }));

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("CAR");
    });

    it("should include PREVIOUS and CAR labels for prev-car mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "prev-car" }));

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("CAR");
    });

    // Play/pause telemetry-aware label toggle
    it("should show PLAY label when isPlaying is false", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-pause" }, false));

      expect(decoded).toContain("PLAY");
      expect(decoded).not.toContain("PAUSE");
    });

    it("should show PAUSE label and pause icon when isPlaying is true", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-pause" }, true));

      expect(decoded).toContain("PAUSE");
      expect(decoded).toContain("pause-icon");
      expect(decoded).not.toContain("FORWARD");
    });

    it("should show PLAY label when isPlaying is undefined", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-pause" }));

      expect(decoded).toContain("PLAY");
      expect(decoded).not.toContain("PAUSE");
    });

    it("should not affect non-play-pause mode labels when isPlaying is true", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "stop" }, true));

      expect(decoded).toContain("STOP");
      expect(decoded).not.toContain("PAUSE");
    });
  });
});
