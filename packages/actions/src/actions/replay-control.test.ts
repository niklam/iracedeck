import { getAllCarNumbers, getCarNumberFromSessionInfo } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  calculateNeedleAngle,
  findAdjacentCarByNumber,
  findAdjacentCarOnTrack,
  formatSetSpeedLabel,
  formatSpeedDisplay,
  generateReplayControlSvg,
  parseSpeedSetting,
} from "./replay-control.js";

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
vi.mock("@iracedeck/icons/replay-control/next-car-number.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-car-number {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-car-number.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-car-number {{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("@iracedeck/iracing-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/iracing-sdk")>();

  return {
    ...actual,
    getCarNumberFromSessionInfo: vi.fn(),
    getCarNumberRawFromSessionInfo: vi.fn(),
    getAllCarNumbers: vi.fn(() => []),
  };
});

vi.mock("@iracedeck/deck-core", () => ({
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
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn(() => null) };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn();
  },
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
      switchNum: vi.fn(() => true),
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
      "next-car-number",
      "prev-car-number",
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

  describe("findAdjacentCarOnTrack", () => {
    function makeTelemetry(camCarIdx: number, cars: Array<{ idx: number; laps: number; dist: number }>) {
      const maxIdx = Math.max(...cars.map((c) => c.idx), camCarIdx, 0);
      const lapCompleted = new Array(maxIdx + 1).fill(-1);
      const lapDistPct = new Array(maxIdx + 1).fill(-1);

      for (const car of cars) {
        lapCompleted[car.idx] = car.laps;
        lapDistPct[car.idx] = car.dist;
      }

      return {
        CamCarIdx: camCarIdx,
        CarIdxLapCompleted: lapCompleted,
        CarIdxLapDistPct: lapDistPct,
      };
    }

    it("should find the physically closest car ahead", () => {
      const telemetry = makeTelemetry(2, [
        { idx: 1, laps: 5, dist: 0.8 },
        { idx: 2, laps: 5, dist: 0.5 },
        { idx: 3, laps: 5, dist: 0.2 },
      ]);

      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(1);
    });

    it("should find the physically closest car behind", () => {
      const telemetry = makeTelemetry(2, [
        { idx: 1, laps: 5, dist: 0.8 },
        { idx: 2, laps: 5, dist: 0.5 },
        { idx: 3, laps: 5, dist: 0.2 },
      ]);

      expect(findAdjacentCarOnTrack(telemetry, "behind")).toBe(3);
    });

    it("should wrap around at start/finish when looking ahead", () => {
      const telemetry = makeTelemetry(1, [
        { idx: 1, laps: 5, dist: 0.95 },
        { idx: 2, laps: 5, dist: 0.5 },
        { idx: 3, laps: 5, dist: 0.05 },
      ]);

      // Car 1 at 0.95; ahead wraps past start/finish to car 3 at 0.05 (gap=0.10)
      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(3);
    });

    it("should wrap around at start/finish when looking behind", () => {
      const telemetry = makeTelemetry(3, [
        { idx: 1, laps: 5, dist: 0.95 },
        { idx: 2, laps: 5, dist: 0.5 },
        { idx: 3, laps: 5, dist: 0.05 },
      ]);

      // Car 3 at 0.05; behind wraps past start/finish to car 1 at 0.95 (gap=0.10)
      expect(findAdjacentCarOnTrack(telemetry, "behind")).toBe(1);
    });

    it("should include cars flagged as on pit road", () => {
      const telemetry = makeTelemetry(3, [
        { idx: 1, laps: 5, dist: 0.8 },
        { idx: 2, laps: 5, dist: 0.3 },
        { idx: 3, laps: 5, dist: 0.2 },
      ]);

      // Even if CarIdxOnPitRoad is set, car 2 at dist=0.3 is closest ahead of car 3 at 0.2
      (telemetry as Record<string, unknown>).CarIdxOnPitRoad = [false, false, true, false];
      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(2);
    });

    it("should skip inactive cars", () => {
      const telemetry = makeTelemetry(3, [
        { idx: 1, laps: 5, dist: 0.8 },
        { idx: 2, laps: -1, dist: 0.5 },
        { idx: 3, laps: 5, dist: 0.2 },
      ]);

      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(1);
    });

    it("should return null when telemetry is null", () => {
      expect(findAdjacentCarOnTrack(null, "ahead")).toBeNull();
    });

    it("should return null when CamCarIdx is missing", () => {
      const telemetry = {
        CarIdxLapCompleted: [5],
        CarIdxLapDistPct: [0.5],
      };

      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBeNull();
    });

    it("should fall back when camera car has no lap data", () => {
      // camCarIdx=99 has no lap data (dist=-1) — falls back to car closest to S/F
      // Car 1 at 0.8 is 0.2 from S/F, car 2 at 0.5 is 0.5 from S/F
      const telemetry = makeTelemetry(99, [
        { idx: 1, laps: 5, dist: 0.8 },
        { idx: 2, laps: 5, dist: 0.5 },
      ]);

      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(1);
      expect(findAdjacentCarOnTrack(telemetry, "behind")).toBe(1);
    });

    it("should use physical proximity regardless of lap count", () => {
      const telemetry = makeTelemetry(2, [
        { idx: 1, laps: 6, dist: 0.2 },
        { idx: 2, laps: 5, dist: 0.9 },
        { idx: 3, laps: 5, dist: 0.1 },
      ]);

      // Physically: car 2 at 0.9, car 1 at 0.2 (fwd gap=0.3), car 3 at 0.1 (fwd gap=0.2)
      // Ahead of car 2: car 3 at 0.1 is closer (gap=0.2) than car 1 at 0.2 (gap=0.3)
      // Behind car 2: car 1 at 0.2 is closer (gap=0.7) than car 3 at 0.1 (gap=0.8)
      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(3);
      expect(findAdjacentCarOnTrack(telemetry, "behind")).toBe(1);
    });

    it("should navigate from camera car that is inactive", () => {
      // Camera car (idx=5) is inactive (laps=-1) but has a valid dist
      const telemetry = makeTelemetry(5, [
        { idx: 1, laps: 5, dist: 0.8 },
        { idx: 2, laps: 5, dist: 0.5 },
        { idx: 5, laps: -1, dist: 0.6 },
      ]);

      // Camera at 0.6; ahead = car 1 at 0.8 (gap=0.2), behind = car 2 at 0.5 (gap=0.1)
      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(1);
      expect(findAdjacentCarOnTrack(telemetry, "behind")).toBe(2);
    });

    it("should return null when no candidates exist", () => {
      // Only the camera car has valid data
      const telemetry = makeTelemetry(1, [
        { idx: 1, laps: 5, dist: 0.5 },
      ]);

      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBeNull();
      expect(findAdjacentCarOnTrack(telemetry, "behind")).toBeNull();
    });

    it("should return the only candidate for both directions", () => {
      const telemetry = makeTelemetry(1, [
        { idx: 1, laps: 5, dist: 0.5 },
        { idx: 2, laps: 5, dist: 0.8 },
      ]);

      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(2);
      expect(findAdjacentCarOnTrack(telemetry, "behind")).toBe(2);
    });

    it("should fall back to car closest to start/finish when camera car has no position", () => {
      // Camera car (idx=5) has dist=-1 (disconnected), no directional reference
      // Car 3 at dist=0.95 is 0.05 from S/F, car 1 at dist=0.1 is 0.1 from S/F
      const telemetry = makeTelemetry(5, [
        { idx: 1, laps: 5, dist: 0.1 },
        { idx: 2, laps: 5, dist: 0.5 },
        { idx: 3, laps: 5, dist: 0.95 },
      ]);

      // Both directions return the same car (closest to S/F line)
      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(3);
      expect(findAdjacentCarOnTrack(telemetry, "behind")).toBe(3);
    });

    // Shared snapshot from telemetry-snapshot-20260328-211129.json (full float64 precision)
    const snapshot211129 = [
      { idx: 2, laps: 11, dist: 0.38954538106918335 },
      { idx: 3, laps: 12, dist: 0.5192081332206726 },
      { idx: 5, laps: 9, dist: 0.48601317405700684 },
      { idx: 6, laps: 12, dist: 0.43214255571365356 },
      { idx: 8, laps: 12, dist: 0.14112484455108643 },
      { idx: 9, laps: 12, dist: 0.5137969255447388 },
      { idx: 11, laps: 12, dist: 0.44958096742630005 },
      { idx: 12, laps: 12, dist: 0.2255899459123611 },
      { idx: 13, laps: 12, dist: 0.2612520456314087 },
      { idx: 14, laps: 12, dist: 0.36889901757240295 },
      { idx: 15, laps: 12, dist: 0.265424907207489 },
      { idx: 16, laps: 4, dist: 0.04441389814019203 },
      { idx: 17, laps: 12, dist: 0.26450181007385254 },
      { idx: 18, laps: 12, dist: 0.45216333866119385 },
      { idx: 19, laps: 12, dist: 0.3390771448612213 },
      { idx: 20, laps: 12, dist: 0.39654332399368286 },
      { idx: 22, laps: 12, dist: 0.25014644861221313 },
      { idx: 23, laps: 5, dist: 0.05720538645982742 },
      { idx: 24, laps: 12, dist: 0.5042067170143127 },
    ];

    it("should match real telemetry — camera on #15 Niklas", () => {
      // #15 (idx=15) camera target
      // #17 (idx=17) — closest behind, #19 (idx=19) — closest ahead
      // #17 and #19 have CarIdxOnPitRoad=true but are on track (TrackSurface=3)
      const telemetry = makeTelemetry(15, snapshot211129);

      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(19);
      expect(findAdjacentCarOnTrack(telemetry, "behind")).toBe(17);
    });

    it("should match real telemetry — camera on #16 near start/finish", () => {
      // #16 (idx=16) near start/finish line
      // Ahead: #23 (idx=23), Behind: #3 (idx=3) wrapping past start/finish
      const telemetry = makeTelemetry(16, snapshot211129);

      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(23);
      expect(findAdjacentCarOnTrack(telemetry, "behind")).toBe(3);
    });

    it("should match real telemetry — camera on disconnected #10, fall back to closest to S/F", () => {
      // From telemetry-snapshot-20260328-213841.json
      // #10 (idx=10) has dist=-1 (disconnected), laps=-1
      // Fallback: #3 (idx=3) at dist=0.995 is closest to S/F (0.005 away)
      const telemetry = makeTelemetry(10, [
        { idx: 3, laps: 2, dist: 0.9950405955314636 },
        { idx: 11, laps: 1, dist: 0.08401884138584137 },
        { idx: 12, laps: 0, dist: 0.9472545981407166 },
        { idx: 14, laps: 2, dist: 0.15486976504325867 },
        { idx: 16, laps: 1, dist: 0.08401890844106674 },
      ]);

      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(3);
      expect(findAdjacentCarOnTrack(telemetry, "behind")).toBe(3);
    });
  });

  describe("findAdjacentCarByNumber", () => {
    beforeEach(() => {
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue(null);
      vi.mocked(getAllCarNumbers).mockReturnValue([]);
    });

    it("should return null when no cars available", () => {
      expect(findAdjacentCarByNumber(null, 0, "next")).toBeNull();
    });

    it("should return next car by number order", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4 },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7 },
        { carIdx: 2, carNumber: "42", carNumberRaw: 42 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("7");

      expect(findAdjacentCarByNumber({}, 1, "next")).toBe(42);
    });

    it("should return previous car by number order", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4 },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7 },
        { carIdx: 2, carNumber: "42", carNumberRaw: 42 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("7");

      expect(findAdjacentCarByNumber({}, 1, "prev")).toBe(4);
    });

    it("should wrap around from last to first", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4 },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7 },
        { carIdx: 2, carNumber: "42", carNumberRaw: 42 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("42");

      expect(findAdjacentCarByNumber({}, 2, "next")).toBe(4);
    });

    it("should wrap around from first to last", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4 },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7 },
        { carIdx: 2, carNumber: "42", carNumberRaw: 42 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("4");

      expect(findAdjacentCarByNumber({}, 0, "prev")).toBe(42);
    });

    it("should return first car when current car not found and direction is next", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4 },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue(null);

      expect(findAdjacentCarByNumber({}, 99, "next")).toBe(4);
    });

    it("should return last car when current car not found and direction is prev", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4 },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue(null);

      expect(findAdjacentCarByNumber({}, 99, "prev")).toBe(7);
    });

    it("should return carNumberRaw for cars with leading zeros", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "7", carNumberRaw: 7 },
        { carIdx: 1, carNumber: "042", carNumberRaw: 3042 },
        { carIdx: 2, carNumber: "99", carNumberRaw: 99 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("7");

      expect(findAdjacentCarByNumber({}, 0, "next")).toBe(3042);
    });
  });
});
