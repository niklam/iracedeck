import {
  carInWorld,
  getAllCarNumbers,
  getCarNumberFromSessionInfo,
  getCarNumberRawFromSessionInfo,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _getFastestLapSessionCache,
  _resetFastestLapSessionCache,
  calculateNeedleAngle,
  findAdjacentCarByNumber,
  findAdjacentCarOnTrack,
  findFastestLapForCar,
  formatSetSpeedLabel,
  formatSpeedDisplay,
  generateReplayControlSvg,
  parseSpeedSetting,
  ReplayControl,
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
vi.mock("@iracedeck/icons/replay-control/slow-motion-rewind.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">slow-motion-rewind {{mainLabel}} {{subLabel}}</svg>',
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
vi.mock("@iracedeck/icons/replay-control/jump-to-fastest-lap.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">jump-to-fastest-lap {{mainLabel}} {{subLabel}}</svg>',
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
    sdkController = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getCurrentTelemetry: vi.fn(() => null),
      getSessionInfo: vi.fn(() => null),
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn();
    setActiveBinding = vi.fn();
    isBindingMissing = vi.fn(() => false);
    tapBinding = vi.fn().mockResolvedValue(undefined);
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
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
      setPlayPosition: vi.fn(() => true),
      searchSessionTime: vi.fn(() => true),
    },
    camera: {
      switchNum: vi.fn(() => true),
    },
  })),
  applyGraphicTransform: vi.fn((_content: string) => _content),
  computeGraphicArea: vi.fn(() => ({ x: 8, y: 8, width: 128, height: 128 })),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({ fastestLapSearchDelayMs: 400 })),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
  parseSvgViewBox: vi.fn(() => undefined),
  getGlobalTitleSettings: vi.fn(() => ({})),
  resolveBorderSettings: vi.fn((_svg: unknown, _global: unknown, _overrides?: unknown, _stateColor?: string) => ({
    enabled: false,
    borderWidth: 7,
    borderColor: "#00aaff",
    glowEnabled: true,
    glowWidth: 18,
  })),
  resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
  resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle?: string) => ({
    showTitle: true,
    showGraphics: true,
    titleText: defaultTitle ?? "",
    bold: true,
    fontSize: 18,
    position: "bottom" as const,
    customPosition: 0,
  })),
  assembleIcon: vi.fn(
    ({ graphicSvg, title }: { graphicSvg: string; colors: unknown; title: { titleText: string } }) => {
      const encoded = encodeURIComponent(`<svg>${graphicSvg}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
  extractGraphicContent: vi.fn((svg: string) =>
    svg
      .replace(/<svg[^>]*>/, "")
      .replace(/<\/svg>\s*$/, "")
      .replace(/<desc>[\s\S]*?<\/desc>/, "")
      .trim(),
  ),
  generateTitleText: vi.fn(() => ""),
  ICON_BASE_TEMPLATE: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>{{graphicContent}}{{titleContent}}</svg>`,
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
      "slow-motion-rewind",
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
      "jump-to-fastest-lap",
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
    it("should include PLAY / PAUSE label for play-pause mode", () => {
      const result = generateReplayControlSvg({ mode: "play-pause" });

      expect(decodeURIComponent(result)).toContain("PLAY / PAUSE");
    });

    it("should include PLAY BACKW label for play-backward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-backward" }));

      expect(decoded).toContain("PLAY BACKW");
    });

    it("should show PLAY BACKW label and pause icon for play-backward when isPlaying is true", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-backward" }, true));

      expect(decoded).toContain("PLAY BACKW");
      expect(decoded).toContain("pause-icon");
    });

    it("should show PLAY BACKW label for play-backward when isPlaying is false", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-backward" }, false));

      expect(decoded).toContain("PLAY BACKW");
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

    it("should include REWIND and SLOW labels for slow-motion-rewind mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "slow-motion-rewind" }));

      expect(decoded).toContain("REWIND");
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
      expect(decoded).not.toContain("SET SPEED");
    });

    it("should show slow-motion speed label for set-speed mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "set-speed", speed: "s4" }));

      expect(decoded).toContain("1/4x");
      expect(decoded).not.toContain("SET SPEED");
    });

    it("should use dynamic title matching speed for set-speed mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "set-speed", speed: "1" }));

      expect(decoded).toContain("1x");
      expect(decoded).not.toContain("SET SPEED");
    });

    // Speed display labels
    it("should show current speed for speed-display mode when playing", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-display" }, true, 4, false));

      expect(decoded).toContain("4x");
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

    it("should include FASTEST and LAP labels for jump-to-fastest-lap mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "jump-to-fastest-lap" }));

      expect(decoded).toContain("FASTEST");
      expect(decoded).toContain("LAP");
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
    it("should show PLAY / PAUSE label and play icon when not playing", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-pause" }, false));

      expect(decoded).toContain("PLAY / PAUSE");
      expect(decoded).toContain("play-pause");
    });

    it("should show PLAY / PAUSE label and pause icon when playing", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-pause" }, true));

      expect(decoded).toContain("PLAY / PAUSE");
      expect(decoded).toContain("pause-icon");
    });

    it("should show PLAY / PAUSE label when isPlaying is undefined", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "play-pause" }));

      expect(decoded).toContain("PLAY / PAUSE");
    });

    it("should not affect non-play-pause mode labels when isPlaying is true", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "stop" }, true));

      expect(decoded).toContain("STOP");
      expect(decoded).not.toContain("PAUSE");
    });
  });

  describe("findAdjacentCarOnTrack", () => {
    function makeTelemetry(
      camCarIdx: number,
      cars: Array<{ idx: number; laps: number; dist: number; trackSurface?: TrkLoc }>,
    ) {
      const maxIdx = Math.max(...cars.map((c) => c.idx), camCarIdx, 0);
      const lapCompleted = new Array(maxIdx + 1).fill(-1);
      const lapDistPct = new Array(maxIdx + 1).fill(-1);
      const trackSurface = new Array(maxIdx + 1).fill(TrkLoc.NotInWorld);

      for (const car of cars) {
        lapCompleted[car.idx] = car.laps;
        lapDistPct[car.idx] = car.dist;
        trackSurface[car.idx] = car.trackSurface ?? TrkLoc.OnTrack;
      }

      return {
        CamCarIdx: camCarIdx,
        CarIdxLapCompleted: lapCompleted,
        CarIdxLapDistPct: lapDistPct,
        CarIdxTrackSurface: trackSurface,
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

    it("should skip disconnected cars (NotInWorld)", () => {
      const telemetry = makeTelemetry(3, [
        { idx: 1, laps: 5, dist: 0.8 },
        { idx: 2, laps: 5, dist: 0.5, trackSurface: TrkLoc.NotInWorld },
        { idx: 3, laps: 5, dist: 0.2 },
      ]);

      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(1);
    });

    it("should include cars during a warmup/pace lap (CarIdxLapCompleted still -1)", () => {
      // Regression: snapshot 20260417-081043 had everyone at laps=-1 during the formation lap,
      // which previously caused findNearestCarOnTrack to reject every candidate.
      const telemetry = makeTelemetry(14, [
        { idx: 1, laps: -1, dist: 0.8173747 },
        { idx: 11, laps: -1, dist: 0.8009607 },
        { idx: 14, laps: -1, dist: 0.8019581 },
        { idx: 17, laps: -1, dist: 0.8063871 },
      ]);

      expect(findAdjacentCarOnTrack(telemetry, "ahead")).toBe(17);
      expect(findAdjacentCarOnTrack(telemetry, "behind")).toBe(11);
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

    it("skips cars that left the world when a presence predicate is given (#885)", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4 },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7 },
        { carIdx: 2, carNumber: "42", carNumberRaw: 42 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("4");

      // #7 (carIdx 1) despawned post-race — next from #4 walks past it to #42.
      expect(findAdjacentCarByNumber({}, 0, "next", (carIdx) => carIdx !== 1)).toBe(42);
    });

    it("steps through the field on the formation lap, where no car has completed a lap (#968)", () => {
      // The regressed path: Next / Previous Car (Number Order) went dead for the
      // whole pace lap because the presence predicate demanded a completed lap.
      // Snapshot 20260417-081043 — four cars on track, every CarIdxLapCompleted -1.
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 1, carNumber: "1", carNumberRaw: 1 },
        { carIdx: 11, carNumber: "11", carNumberRaw: 11 },
        { carIdx: 14, carNumber: "14", carNumberRaw: 14 },
        { carIdx: 17, carNumber: "17", carNumberRaw: 17 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("14");

      const size = 18;
      const dist: Record<number, number> = { 1: 0.8173747, 11: 0.8009607, 14: 0.8019581, 17: 0.8063871 };
      const telemetry = {
        CarIdxLapCompleted: new Array<number>(size).fill(-1),
        CarIdxLapDistPct: Array.from({ length: size }, (_, i) => dist[i] ?? -1),
        CarIdxTrackSurface: Array.from({ length: size }, (_, i) =>
          dist[i] === undefined ? TrkLoc.NotInWorld : TrkLoc.OnTrack,
        ),
      };

      expect(findAdjacentCarByNumber({}, 14, "next", carInWorld(telemetry as never))).toBe(17);
      expect(findAdjacentCarByNumber({}, 14, "prev", carInWorld(telemetry as never))).toBe(11);
    });

    it("returns null when no other car is present in the world (#885)", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4 },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue("4");

      expect(findAdjacentCarByNumber({}, 0, "next", (carIdx) => carIdx === 0)).toBeNull();
    });
  });

  describe("findFastestLapForCar", () => {
    function sessionInfoWith(
      sessions: Array<{ SessionNum: number; ResultsPositions?: Array<{ CarIdx: number; FastestLap: number }> }>,
    ) {
      return { SessionInfo: { Sessions: sessions } };
    }

    it("prefers ResultsPositions over telemetry CarIdxBestLapNum", () => {
      const sessionInfo = sessionInfoWith([
        {
          SessionNum: 2,
          ResultsPositions: [
            { CarIdx: 5, FastestLap: 12 },
            { CarIdx: 7, FastestLap: 9 },
          ],
        },
      ]);
      const telemetry = { SessionNum: 2, CarIdxBestLapNum: [0, 0, 0, 0, 0, 99, 0, 99] } as any;

      expect(findFastestLapForCar(sessionInfo, telemetry, 5)).toBe(12);
      expect(findFastestLapForCar(sessionInfo, telemetry, 7)).toBe(9);
    });

    it("matches the right session by SessionNum field, not array index", () => {
      // Sessions are sometimes listed out of order — never trust the index.
      const sessionInfo = sessionInfoWith([
        { SessionNum: 0, ResultsPositions: [{ CarIdx: 3, FastestLap: 7 }] },
        { SessionNum: 2, ResultsPositions: [{ CarIdx: 3, FastestLap: 15 }] },
        { SessionNum: 1, ResultsPositions: [{ CarIdx: 3, FastestLap: 11 }] },
      ]);
      const telemetry = { SessionNum: 1, CarIdxBestLapNum: [] } as any;

      expect(findFastestLapForCar(sessionInfo, telemetry, 3)).toBe(11);
    });

    it("returns null when ResultsPositions has no entry for the target car", () => {
      const sessionInfo = sessionInfoWith([{ SessionNum: 0, ResultsPositions: [{ CarIdx: 1, FastestLap: 5 }] }]);
      const telemetry = { SessionNum: 0 } as any;

      expect(findFastestLapForCar(sessionInfo, telemetry, 99)).toBeNull();
    });

    it("falls back to telemetry when ResultsPositions is empty (live session)", () => {
      const sessionInfo = sessionInfoWith([{ SessionNum: 0, ResultsPositions: [] }]);
      const telemetry = { SessionNum: 0, CarIdxBestLapNum: [0, 0, 8] } as any;

      expect(findFastestLapForCar(sessionInfo, telemetry, 2)).toBe(8);
    });

    it("falls back to telemetry when ResultsPositions has the car but FastestLap is 0", () => {
      // Practice session, driver completed an out-lap but no flying lap yet —
      // ResultsPositions exists with FastestLap=0; only live telemetry has the recorded lap.
      const sessionInfo = sessionInfoWith([{ SessionNum: 0, ResultsPositions: [{ CarIdx: 2, FastestLap: 0 }] }]);
      const telemetry = { SessionNum: 0, CarIdxBestLapNum: [0, 0, 6] } as any;

      expect(findFastestLapForCar(sessionInfo, telemetry, 2)).toBe(6);
    });

    it("falls back to telemetry when sessionInfo lacks the current session", () => {
      const sessionInfo = sessionInfoWith([{ SessionNum: 1, ResultsPositions: [{ CarIdx: 2, FastestLap: 5 }] }]);
      const telemetry = { SessionNum: 0, CarIdxBestLapNum: [0, 0, 4] } as any;

      expect(findFastestLapForCar(sessionInfo, telemetry, 2)).toBe(4);
    });

    it("returns null when neither source has data", () => {
      const sessionInfo = sessionInfoWith([{ SessionNum: 0, ResultsPositions: [] }]);
      const telemetry = { SessionNum: 0, CarIdxBestLapNum: [] } as any;

      expect(findFastestLapForCar(sessionInfo, telemetry, 2)).toBeNull();
    });

    it("returns null when telemetry is null and sessionInfo is empty", () => {
      expect(findFastestLapForCar(null, null, 0)).toBeNull();
    });

    it("handles missing SessionNum on telemetry by falling back to telemetry-only path", () => {
      const sessionInfo = sessionInfoWith([{ SessionNum: 0, ResultsPositions: [{ CarIdx: 2, FastestLap: 5 }] }]);
      const telemetry = { CarIdxBestLapNum: [0, 0, 3] } as any;

      // No SessionNum → skips ResultsPositions matching → falls back to telemetry.
      expect(findFastestLapForCar(sessionInfo, telemetry, 2)).toBe(3);
    });
  });

  describe("play/pause behavior", () => {
    function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
      return {
        action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    const mockReplay = {
      play: vi.fn(() => true),
      pause: vi.fn(() => true),
      setPlaySpeed: vi.fn(() => true),
    };

    let action: ReplayControl;

    beforeEach(async () => {
      vi.clearAllMocks();
      const { getCommands } = await import("@iracedeck/deck-core");
      vi.mocked(getCommands).mockReturnValue({ replay: mockReplay, camera: { switchNum: vi.fn() } } as any);
      action = new ReplayControl();
    });

    describe("play-pause toggle", () => {
      beforeEach(async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "play-pause" }) as any);
      });

      it("should pause when playing forward", async () => {
        (action as any).replaySpeed.set("ctx-1", 1);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-pause" }) as any);

        expect(mockReplay.pause).toHaveBeenCalled();
        expect((action as any).replaySpeed.get("ctx-1")).toBe(0);
      });

      it("should play at 1x when paused", async () => {
        (action as any).replaySpeed.set("ctx-1", 0);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-pause" }) as any);

        expect(mockReplay.play).toHaveBeenCalled();
        expect((action as any).replaySpeed.get("ctx-1")).toBe(1);
      });

      it("should pause when playing backward (not mirror)", async () => {
        (action as any).replaySpeed.set("ctx-1", -4);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-pause" }) as any);

        expect(mockReplay.pause).toHaveBeenCalled();
        expect(mockReplay.play).not.toHaveBeenCalled();
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        expect((action as any).replaySpeed.get("ctx-1")).toBe(0);
      });

      it("should pause when in slow-motion (not mirror)", async () => {
        (action as any).replaySpeed.set("ctx-1", 2);
        (action as any).replaySlowMotion.set("ctx-1", true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-pause" }) as any);

        expect(mockReplay.pause).toHaveBeenCalled();
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        expect((action as any).replaySpeed.get("ctx-1")).toBe(0);
      });

      it("should always play at 1x, never restore previous speed", async () => {
        // Play at 8x, pause, then play again — should be 1x, not 8x
        (action as any).replaySpeed.set("ctx-1", 8);
        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-pause" }) as any);
        expect(mockReplay.pause).toHaveBeenCalled();

        vi.clearAllMocks();
        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-pause" }) as any);
        expect(mockReplay.play).toHaveBeenCalled();
        expect((action as any).replaySpeed.get("ctx-1")).toBe(1);
      });
    });

    describe("play-backward toggle", () => {
      beforeEach(async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "play-backward" }) as any);
      });

      it("should pause when playing backward", async () => {
        (action as any).replaySpeed.set("ctx-1", -1);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-backward" }) as any);

        expect(mockReplay.pause).toHaveBeenCalled();
        expect((action as any).replaySpeed.get("ctx-1")).toBe(0);
      });

      it("should play backward at -1x when paused", async () => {
        (action as any).replaySpeed.set("ctx-1", 0);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-backward" }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-1);
        expect((action as any).replaySpeed.get("ctx-1")).toBe(-1);
      });

      it("should pause when playing forward (not switch to backward)", async () => {
        (action as any).replaySpeed.set("ctx-1", 4);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "play-backward" }) as any);

        expect(mockReplay.pause).toHaveBeenCalled();
        expect(mockReplay.setPlaySpeed).not.toHaveBeenCalled();
        expect((action as any).replaySpeed.get("ctx-1")).toBe(0);
      });
    });

    describe("cross-button display sync", () => {
      it("should update play-pause display when play-backward is pressed", async () => {
        // Both buttons visible on the same action instance
        await action.onWillAppear(fakeEvent("pp-ctx", { mode: "play-pause" }) as any);
        await action.onWillAppear(fakeEvent("pb-ctx", { mode: "play-backward" }) as any);

        // Playing forward — both should show pause state
        (action as any).replaySpeed.set("pp-ctx", 1);
        (action as any).replaySpeed.set("pb-ctx", 1);

        // Press play-backward → pauses
        await action.onKeyDown(fakeEvent("pb-ctx", { mode: "play-backward" }) as any);

        // Both contexts should have speed 0 (paused)
        expect((action as any).replaySpeed.get("pp-ctx")).toBe(0);
        expect((action as any).replaySpeed.get("pb-ctx")).toBe(0);

        // Both displays should have been re-rendered
        expect(action.updateKeyImage).toHaveBeenCalled();
      });
    });

    describe("fast-forward / rewind step rate", () => {
      beforeEach(async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "fast-forward", stepRate: 2 }) as any);
      });

      it("should step fast-forward by stepRate (default 1) when starting from 1x", async () => {
        (action as any).replaySpeed.set("ctx-1", 1);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "fast-forward", stepRate: 1 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(2);
      });

      it("should step fast-forward by stepRate=2 to 4x from 2x", async () => {
        (action as any).replaySpeed.set("ctx-1", 2);
        (action as any).replaySlowMotion.set("ctx-1", false);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "fast-forward", stepRate: 2 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(4);
      });

      it("should always start fast-forward at 2x from paused, regardless of stepRate", async () => {
        (action as any).replaySpeed.set("ctx-1", 0);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "fast-forward", stepRate: 3 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(2);
      });

      it("should clamp fast-forward to 16x when stepRate would exceed it", async () => {
        (action as any).replaySpeed.set("ctx-1", 14);
        (action as any).replaySlowMotion.set("ctx-1", false);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "fast-forward", stepRate: 5 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(16);
      });

      it("should step rewind by stepRate=2 to -4x from -2x", async () => {
        (action as any).replaySpeed.set("ctx-1", -2);
        (action as any).replaySlowMotion.set("ctx-1", false);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "rewind", stepRate: 2 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-4);
      });

      it("should clamp rewind to -16x when stepRate would exceed it", async () => {
        (action as any).replaySpeed.set("ctx-1", -14);
        (action as any).replaySlowMotion.set("ctx-1", false);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "rewind", stepRate: 5 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-16);
      });

      it("should reset to -2x when entering rewind from forward play, regardless of stepRate", async () => {
        (action as any).replaySpeed.set("ctx-1", 4);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "rewind", stepRate: 3 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-2);
      });
    });

    describe("slow-motion / slow-motion-rewind step rate", () => {
      beforeEach(async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 1 }) as any);
      });

      it("should jump to 1/2x on first slow-motion press from forward play", async () => {
        (action as any).replaySpeed.set("ctx-1", 1);
        (action as any).replaySlowMotion.set("ctx-1", false);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 3 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(2, true);
        expect((action as any).replaySpeed.get("ctx-1")).toBe(2);
        expect((action as any).replaySlowMotion.get("ctx-1")).toBe(true);
      });

      it("should jump to 1/2x on first slow-motion press from paused", async () => {
        (action as any).replaySpeed.set("ctx-1", 0);
        (action as any).replaySlowMotion.set("ctx-1", false);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 5 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(2, true);
      });

      it("should jump to 1/2x on first slow-motion press from fast-forward", async () => {
        (action as any).replaySpeed.set("ctx-1", 8);
        (action as any).replaySlowMotion.set("ctx-1", false);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 2 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(2, true);
      });

      it("should step slow-motion by stepRate=1 from 1/2x to 1/3x", async () => {
        (action as any).replaySpeed.set("ctx-1", 2);
        (action as any).replaySlowMotion.set("ctx-1", true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 1 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(3, true);
      });

      it("should step slow-motion by stepRate=2 from 1/2x to 1/4x", async () => {
        (action as any).replaySpeed.set("ctx-1", 2);
        (action as any).replaySlowMotion.set("ctx-1", true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 2 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(4, true);
      });

      it("should clamp slow-motion to 1/16x when stepRate would exceed it", async () => {
        (action as any).replaySpeed.set("ctx-1", 14);
        (action as any).replaySlowMotion.set("ctx-1", true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 5 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(16, true);
      });

      it("should reset to 1/2x when slow-motion pressed while in slow-motion-rewind", async () => {
        (action as any).replaySpeed.set("ctx-1", -4);
        (action as any).replaySlowMotion.set("ctx-1", true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion", stepRate: 3 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(2, true);
      });

      it("should jump to -1/2x on first slow-motion-rewind press from paused", async () => {
        (action as any).replaySpeed.set("ctx-1", 0);
        (action as any).replaySlowMotion.set("ctx-1", false);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion-rewind", stepRate: 1 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-2, true);
        expect((action as any).replaySpeed.get("ctx-1")).toBe(-2);
        expect((action as any).replaySlowMotion.get("ctx-1")).toBe(true);
      });

      it("should jump to -1/2x on first slow-motion-rewind press from rewind", async () => {
        (action as any).replaySpeed.set("ctx-1", -8);
        (action as any).replaySlowMotion.set("ctx-1", false);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion-rewind", stepRate: 2 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-2, true);
      });

      it("should step slow-motion-rewind by stepRate=2 from -1/2x to -1/4x", async () => {
        (action as any).replaySpeed.set("ctx-1", -2);
        (action as any).replaySlowMotion.set("ctx-1", true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion-rewind", stepRate: 2 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-4, true);
      });

      it("should clamp slow-motion-rewind to -1/16x when stepRate would exceed it", async () => {
        (action as any).replaySpeed.set("ctx-1", -14);
        (action as any).replaySlowMotion.set("ctx-1", true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion-rewind", stepRate: 5 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-16, true);
      });

      it("should reset to -1/2x when slow-motion-rewind pressed while in slow-motion forward", async () => {
        (action as any).replaySpeed.set("ctx-1", 4);
        (action as any).replaySlowMotion.set("ctx-1", true);

        await action.onKeyDown(fakeEvent("ctx-1", { mode: "slow-motion-rewind", stepRate: 3 }) as any);

        expect(mockReplay.setPlaySpeed).toHaveBeenCalledWith(-2, true);
      });
    });

    describe("disconnect handling", () => {
      it("should reset speed to 0 when telemetry becomes null", async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "play-pause" }) as any);

        (action as any).replaySpeed.set("ctx-1", 4);
        (action as any).replaySlowMotion.set("ctx-1", false);

        (action as any).updateTelemetryState("ctx-1", null);

        expect((action as any).replaySpeed.get("ctx-1")).toBe(0);
        expect((action as any).replaySlowMotion.get("ctx-1")).toBe(false);
      });

      it("should reset slow-motion flag on disconnect", async () => {
        await action.onWillAppear(fakeEvent("ctx-1", { mode: "play-pause" }) as any);

        (action as any).replaySpeed.set("ctx-1", 2);
        (action as any).replaySlowMotion.set("ctx-1", true);

        (action as any).updateTelemetryState("ctx-1", null);

        expect((action as any).replaySpeed.get("ctx-1")).toBe(0);
        expect((action as any).replaySlowMotion.get("ctx-1")).toBe(false);
      });
    });
  });

  describe("car cycling (keystroke dispatch)", () => {
    function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
      return {
        action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    let action: ReplayControl;

    beforeEach(async () => {
      vi.clearAllMocks();
      action = new ReplayControl();
    });

    it("next-car onKeyDown taps the replayControlNextCar global binding", async () => {
      await action.onWillAppear(fakeEvent("ctx-1", { mode: "next-car" }) as any);
      await action.onKeyDown(fakeEvent("ctx-1", { mode: "next-car" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("replayControlNextCar");
    });

    it("prev-car onKeyDown taps the replayControlPrevCar global binding", async () => {
      await action.onWillAppear(fakeEvent("ctx-1", { mode: "prev-car" }) as any);
      await action.onKeyDown(fakeEvent("ctx-1", { mode: "prev-car" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("replayControlPrevCar");
    });

    it("next-car does NOT consult telemetry for car selection", async () => {
      // Arrange: telemetry that would normally be inspected by the legacy path
      action.sdkController.getCurrentTelemetry = vi.fn(() => ({
        CamCarIdx: 0,
        CarIdxLapDistPct: [0.1, 0.2],
        CarIdxOnPitRoad: [false, false],
        CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack],
      }));

      await action.onWillAppear(fakeEvent("ctx-1", { mode: "next-car" }) as any);
      await action.onKeyDown(fakeEvent("ctx-1", { mode: "next-car" }) as any);

      // No camera.switchNum call — keystroke is the only dispatch.
      const { getCommands } = await import("@iracedeck/deck-core");
      const cameraMock = vi.mocked(getCommands)().camera as unknown as { switchNum: ReturnType<typeof vi.fn> };
      expect(cameraMock.switchNum).not.toHaveBeenCalled();
    });

    it("dial rotation on next-car routes through the keystroke path", async () => {
      await action.onWillAppear(fakeEvent("ctx-1", { mode: "next-car" }) as any);

      await action.onDialRotate({
        action: { id: "ctx-1", setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings: { mode: "next-car" }, ticks: 1 },
      } as any);

      expect(action.tapBinding).toHaveBeenCalledWith("replayControlNextCar");
    });

    it("dial counter-rotation on next-car taps the prev-car binding", async () => {
      await action.onWillAppear(fakeEvent("ctx-1", { mode: "next-car" }) as any);

      await action.onDialRotate({
        action: { id: "ctx-1", setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings: { mode: "next-car" }, ticks: -1 },
      } as any);

      expect(action.tapBinding).toHaveBeenCalledWith("replayControlPrevCar");
    });

    it("declares the active binding so readiness tracking matches the configured key", async () => {
      await action.onWillAppear(fakeEvent("ctx-1", { mode: "next-car" }) as any);

      expect(action.setActiveBinding).toHaveBeenCalledWith("replayControlNextCar");
    });

    it("clears the active binding when switched to a non-keystroke mode", async () => {
      await action.onWillAppear(fakeEvent("ctx-1", { mode: "next-car" }) as any);
      vi.mocked(action.setActiveBinding).mockClear();

      await action.onDidReceiveSettings(fakeEvent("ctx-1", { mode: "next-session" }) as any);

      expect(action.setActiveBinding).toHaveBeenCalledWith(null);
    });
  });

  describe("car number cycling (dial rotation)", () => {
    function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
      return {
        action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    function rotate(mode: string, ticks: number) {
      return action.onDialRotate({
        action: { id: "ctx-1", setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings: { mode }, ticks },
      } as never);
    }

    // Cars by number: #4 (carIdx 0), #7 (carIdx 1, focused), #42 (carIdx 2).
    const TELEMETRY = {
      CamCarIdx: 1,
      CarIdxLapCompleted: [-1, -1, -1],
      CarIdxLapDistPct: [0.1, 0.2, 0.3],
      CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack, TrkLoc.OnTrack],
    };

    let action: ReplayControl;
    let mockCamera: { switchNum: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      vi.clearAllMocks();
      mockCamera = { switchNum: vi.fn(() => true) };

      const { getCommands } = await import("@iracedeck/deck-core");

      vi.mocked(getCommands).mockReturnValue({
        replay: { play: vi.fn(() => true) },
        camera: mockCamera,
      } as never);

      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: "4", carNumberRaw: 4, userName: "a" },
        { carIdx: 1, carNumber: "7", carNumberRaw: 7, userName: "b" },
        { carIdx: 2, carNumber: "42", carNumberRaw: 42, userName: "c" },
      ]);

      action = new ReplayControl();
      action.sdkController.getCurrentTelemetry = vi.fn(() => TELEMETRY);
      action.sdkController.getSessionInfo = vi.fn(() => ({}));
      await action.onWillAppear(fakeEvent("ctx-1", { mode: "next-car-number" }) as never);
    });

    it("lowers the car number on a clockwise detent (#973)", async () => {
      await rotate("next-car-number", 1);

      expect(mockCamera.switchNum).toHaveBeenCalledWith(4, 0, 0); // focused #7 → #4
    });

    it("raises the car number on a counter-clockwise detent (#973)", async () => {
      await rotate("next-car-number", -1);

      expect(mockCamera.switchNum).toHaveBeenCalledWith(42, 0, 0); // focused #7 → #42
    });

    it("maps both detents the same way whichever car-number mode the key sits on (#973)", async () => {
      // The pair is one bidirectional control: rotation direction decides the
      // target, so a `prev-car-number` key on a dial must behave identically.
      await rotate("prev-car-number", 1);

      expect(mockCamera.switchNum).toHaveBeenCalledWith(4, 0, 0);

      await rotate("prev-car-number", -1);

      expect(mockCamera.switchNum).toHaveBeenLastCalledWith(42, 0, 0);
    });
  });

  describe("jump-to-fastest-lap", () => {
    function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
      return {
        action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    const mockReplay = {
      play: vi.fn(() => true),
      pause: vi.fn(() => true),
      setPlaySpeed: vi.fn(() => true),
      nextLap: vi.fn(() => true),
      prevLap: vi.fn(() => true),
      nextSession: vi.fn(() => true),
      prevSession: vi.fn(() => true),
      goToStart: vi.fn(() => true),
      goToEnd: vi.fn(() => true),
      setPlayPosition: vi.fn(() => true),
      searchSessionTime: vi.fn(() => true),
    };

    const mockCamera = {
      switchNum: vi.fn(() => true),
    };

    /** Shared helper — used by the dispatch + encoder describes below. */
    function telemetryWithBest(carIdx: number, bestLapNum: number, currentLap: number) {
      const bestLapNums: number[] = [];
      const currentLaps: number[] = [];

      bestLapNums[carIdx] = bestLapNum;
      currentLaps[carIdx] = currentLap;

      return {
        CamCarIdx: carIdx,
        CarIdxBestLapNum: bestLapNums,
        CarIdxLap: currentLaps,
        SessionNum: 0,
      };
    }

    let action: ReplayControl;

    beforeEach(async () => {
      vi.clearAllMocks();
      // The walker's session-map + per-car frame cache lives at module scope
      // so it survives between tests by default — reset it so each test
      // starts with a clean cache.
      _resetFastestLapSessionCache();
      const { getCommands } = await import("@iracedeck/deck-core");
      // getCarNumberRawFromSessionInfo is mocked in the shared @iracedeck/iracing-sdk block;
      // default it to returning the carIdx as the raw number so individual tests don't have
      // to wire fake session info.
      vi.mocked(getCarNumberRawFromSessionInfo).mockImplementation((_si: unknown, idx: number) => idx);
      vi.mocked(getCommands).mockReturnValue({ replay: mockReplay, camera: mockCamera } as any);
      action = new ReplayControl();
    });

    describe("resolveFastestLapCarIdx", () => {
      it("returns CamCarIdx when target is viewed-car", () => {
        const carIdx = action.resolveFastestLapCarIdx("viewed-car", { CamCarIdx: 7 } as any);

        expect(carIdx).toBe(7);
      });

      it("returns -1 when target is viewed-car and telemetry is null", () => {
        expect(action.resolveFastestLapCarIdx("viewed-car", null)).toBe(-1);
      });

      it("returns DriverCarIdx from session info when target is always-my-car", () => {
        action.sdkController.getSessionInfo = vi.fn(() => ({ DriverInfo: { DriverCarIdx: 3 } }) as any);

        expect(action.resolveFastestLapCarIdx("always-my-car", { CamCarIdx: 99 } as any)).toBe(3);
      });

      it("returns -1 when target is always-my-car and session info is missing", () => {
        action.sdkController.getSessionInfo = vi.fn(() => null);

        expect(action.resolveFastestLapCarIdx("always-my-car", { CamCarIdx: 99 } as any)).toBe(-1);
      });
    });

    describe("dispatch", () => {
      it("logs a warning and does nothing when no target car is available (viewed-car)", async () => {
        action.sdkController.getCurrentTelemetry = vi.fn(() => ({ CamCarIdx: -1 }) as any);

        await action.onWillAppear(
          fakeEvent("ctx-1", { mode: "jump-to-fastest-lap", fastestLapTarget: "viewed-car" }) as any,
        );
        await action.onKeyDown(
          fakeEvent("ctx-1", { mode: "jump-to-fastest-lap", fastestLapTarget: "viewed-car" }) as any,
        );

        expect(mockReplay.nextLap).not.toHaveBeenCalled();
        expect(mockReplay.prevLap).not.toHaveBeenCalled();
        expect(mockCamera.switchNum).not.toHaveBeenCalled();
        expect(action.logger.warn).toHaveBeenCalledWith(expect.stringContaining("No target car"));
      });

      it("rejects CarIdx 255 (no-driver/pace-car placeholder) before resolving the fastest lap", async () => {
        // CamCarIdx=255 happens mid-camera-transition and on the pace car —
        // never a real target. Should short-circuit before any walk starts.
        action.sdkController.getCurrentTelemetry = vi.fn(() => ({ CamCarIdx: 255 }) as any);

        await action.onWillAppear(
          fakeEvent("ctx-1", { mode: "jump-to-fastest-lap", fastestLapTarget: "viewed-car" }) as any,
        );
        await action.onKeyDown(
          fakeEvent("ctx-1", { mode: "jump-to-fastest-lap", fastestLapTarget: "viewed-car" }) as any,
        );

        expect(mockReplay.nextLap).not.toHaveBeenCalled();
        expect(mockReplay.prevLap).not.toHaveBeenCalled();
        expect(mockCamera.switchNum).not.toHaveBeenCalled();
        expect(action.logger.warn).toHaveBeenCalledWith(expect.stringContaining("No target car"));
      });

      it("aborts the walk and warns when camera.switchNum fails", async () => {
        // Camera switch returns false (SDK refused) — walker must not start.
        mockCamera.switchNum.mockReturnValueOnce(false);
        action.sdkController.getCurrentTelemetry = vi.fn(() => telemetryWithBest(2, 5, 0) as any);

        await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
        await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);

        expect(mockCamera.switchNum).toHaveBeenCalledWith(2, 0, 0);
        expect(mockReplay.pause).not.toHaveBeenCalled();
        expect(mockReplay.setPlayPosition).not.toHaveBeenCalled();
        expect(action.logger.warn).toHaveBeenCalledWith(expect.stringContaining("camera switch failed"));
      });

      it("logs info and skips when the target car has no best lap yet", async () => {
        action.sdkController.getCurrentTelemetry = vi.fn(() => telemetryWithBest(2, 0, 0) as any);

        await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
        await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);

        expect(mockReplay.pause).not.toHaveBeenCalled();
        expect(mockReplay.setPlayPosition).not.toHaveBeenCalled();
        expect(mockCamera.switchNum).not.toHaveBeenCalled();
        expect(action.logger.info).toHaveBeenCalledWith(expect.stringContaining("no best lap"));
      });

      /**
       * Synthetic multi-session replay buffer. Each `SessionLayout` occupies
       * `[startFrame, endFrame]` (inclusive); within a session, lap N spans
       * frames `[startFrame + N * framesPerLap, startFrame + (N+1) * framesPerLap)`
       * with `dist = (frame % framesPerLap) / framesPerLap`. The mock wires:
       *
       *   - `goToStart` → cursor to first session's startFrame.
       *   - `goToEnd` → cursor to bufferEnd (last session's endFrame).
       *   - `nextSession` → cursor to next session's startFrame, or no-op
       *     when already in the last session.
       *   - `setPlayPosition(Begin, frame)` → cursor clamped to buffer.
       *   - `nextLap` → cursor to start of next lap (lap+1, dist=0).
       *   - `prevLap` → cursor to end of previous lap (lap-1, dist≈0.999).
       *
       * `getCurrentTelemetry()` returns SessionUniqueID + SessionNum + the
       * lap/dist for `carIdx`. `getSessionInfo()` wires `ResultsPositions`
       * so `findFastestLapForCar` resolves to each session's `fastestLap`.
       */
      type SessionLayout = {
        sessionNum: number;
        sessionUniqueId: number;
        startFrame: number;
        endFrame: number;
        framesPerLap: number;
        fastestLap: number;
      };

      function multiSessionBuffer(
        carIdx: number,
        sessions: SessionLayout[],
        opts: { driverCarIdx?: number; initialCursor?: number } = {},
      ) {
        const cursor = { frame: opts.initialCursor ?? sessions[0].startFrame };
        const bufferEnd = sessions[sessions.length - 1].endFrame;

        const findSession = (frame: number): SessionLayout | null =>
          sessions.find((s) => frame >= s.startFrame && frame <= s.endFrame) ?? null;

        mockReplay.goToStart.mockImplementation(() => {
          cursor.frame = sessions[0].startFrame;

          return true;
        });
        mockReplay.goToEnd.mockImplementation(() => {
          cursor.frame = bufferEnd;

          return true;
        });
        mockReplay.nextSession.mockImplementation(() => {
          const current = findSession(cursor.frame);

          if (!current) return false;

          const idx = sessions.indexOf(current);

          if (idx + 1 < sessions.length) {
            cursor.frame = sessions[idx + 1].startFrame;
          }

          return true;
        });
        mockReplay.setPlayPosition.mockImplementation((_mode: unknown, frame: number) => {
          cursor.frame = Math.max(0, Math.min(bufferEnd, frame));

          return true;
        });
        mockReplay.nextLap.mockImplementation(() => {
          const session = findSession(cursor.frame);

          if (!session) return false;

          const relFrame = cursor.frame - session.startFrame;
          const lap = Math.floor(relFrame / session.framesPerLap);

          cursor.frame = Math.min(bufferEnd, session.startFrame + (lap + 1) * session.framesPerLap);

          return true;
        });
        mockReplay.prevLap.mockImplementation(() => {
          const session = findSession(cursor.frame);

          if (!session) return false;

          const relFrame = cursor.frame - session.startFrame;
          const lap = Math.floor(relFrame / session.framesPerLap);
          // Last frame of the PREVIOUS lap (lap-1, dist ≈ 0.999).
          const prevLapEnd = session.startFrame + lap * session.framesPerLap - 1;

          cursor.frame = Math.max(session.startFrame, prevLapEnd);

          return true;
        });

        action.sdkController.getCurrentTelemetry = vi.fn(() => {
          const session = findSession(cursor.frame);

          if (!session) {
            return {
              CamCarIdx: carIdx,
              ReplayFrameNum: cursor.frame,
              SessionNum: -1,
              SessionUniqueID: 0,
              CarIdxLap: [],
              CarIdxLapDistPct: [],
              CarIdxBestLapNum: [],
            } as any;
          }

          const relFrame = cursor.frame - session.startFrame;
          const lap = Math.floor(relFrame / session.framesPerLap);
          const dist = (relFrame % session.framesPerLap) / session.framesPerLap;
          const lapArr: number[] = [];
          const distArr: number[] = [];

          lapArr[carIdx] = lap;
          distArr[carIdx] = dist;

          return {
            CamCarIdx: carIdx,
            ReplayFrameNum: cursor.frame,
            SessionNum: session.sessionNum,
            SessionUniqueID: session.sessionUniqueId,
            CarIdxLap: lapArr,
            CarIdxLapDistPct: distArr,
            CarIdxBestLapNum: [],
          } as any;
        });

        action.sdkController.getSessionInfo = vi.fn(
          () =>
            ({
              DriverInfo: { DriverCarIdx: opts.driverCarIdx ?? carIdx },
              SessionInfo: {
                Sessions: sessions.map((s) => ({
                  SessionNum: s.sessionNum,
                  ResultsPositions: [{ CarIdx: carIdx, FastestLap: s.fastestLap }],
                })),
              },
            }) as any,
        );

        return { cursor, sessions, bufferEnd, findSession };
      }

      /**
       * Single-session buffer with a default layout: SessionNum=2,
       * SessionUniqueID=3, frame range [0, 9999], 1000 frames per lap.
       * `initialCursor` starts at a frame inside that session so the
       * dispatch's first telemetry read sees `SessionNum=2`.
       */
      function singleSessionBuffer(carIdx: number, fastestLap: number, opts: { initialCursor?: number } = {}) {
        return multiSessionBuffer(
          carIdx,
          [
            {
              sessionNum: 2,
              sessionUniqueId: 3,
              startFrame: 0,
              endFrame: 9999,
              framesPerLap: 1000,
              fastestLap,
            },
          ],
          { initialCursor: opts.initialCursor ?? 5000 },
        );
      }

      describe("session map building", () => {
        it("builds a map via goToStart + nextSession × N + goToEnd on first press", async () => {
          vi.useFakeTimers();

          try {
            multiSessionBuffer(
              4,
              [
                { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999, framesPerLap: 100, fastestLap: -1 },
                {
                  sessionNum: 1,
                  sessionUniqueId: 2,
                  startFrame: 1000,
                  endFrame: 4999,
                  framesPerLap: 1000,
                  fastestLap: 2,
                },
                {
                  sessionNum: 2,
                  sessionUniqueId: 3,
                  startFrame: 5000,
                  endFrame: 14_999,
                  framesPerLap: 1000,
                  fastestLap: 4,
                },
              ],
              { initialCursor: 8000 },
            );

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            expect(mockReplay.goToStart).toHaveBeenCalled();
            // 3 sessions → 3 nextSession calls (last one is the no-op detector).
            expect(mockReplay.nextSession.mock.calls.length).toBeGreaterThanOrEqual(2);
            expect(mockReplay.goToEnd).toHaveBeenCalled();

            const cache = _getFastestLapSessionCache();

            expect(cache).not.toBeNull();
            expect([...(cache?.sessionUniqueIds ?? [])].sort()).toEqual([1, 2, 3]);
            expect(cache?.sessions.map((s) => s.sessionNum)).toEqual([0, 1, 2]);
          } finally {
            vi.useRealTimers();
          }
        });

        it("computes each session's endFrame as the next session's startFrame - 1", async () => {
          vi.useFakeTimers();

          try {
            multiSessionBuffer(
              4,
              [
                { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999, framesPerLap: 100, fastestLap: -1 },
                {
                  sessionNum: 2,
                  sessionUniqueId: 3,
                  startFrame: 1000,
                  endFrame: 10_999,
                  framesPerLap: 1000,
                  fastestLap: 4,
                },
              ],
              { initialCursor: 5000 },
            );

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            const cache = _getFastestLapSessionCache();

            expect(cache?.sessions[0].endFrame).toBe(999); // session 2's startFrame - 1
            expect(cache?.sessions[1].endFrame).toBe(10_999); // bufferEnd
          } finally {
            vi.useRealTimers();
          }
        });
      });

      describe("session map cache (Set-of-uniqueIds)", () => {
        it("reuses the cached map when current SessionUniqueID is in the Set", async () => {
          vi.useFakeTimers();

          try {
            multiSessionBuffer(
              4,
              [
                { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999, framesPerLap: 100, fastestLap: -1 },
                {
                  sessionNum: 2,
                  sessionUniqueId: 3,
                  startFrame: 1000,
                  endFrame: 10_999,
                  framesPerLap: 1000,
                  fastestLap: 4,
                },
              ],
              { initialCursor: 5000 },
            );

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            mockReplay.goToStart.mockClear();
            mockReplay.nextSession.mockClear();
            mockReplay.goToEnd.mockClear();

            // Second press: should reuse the map (no new goToStart / nextSession / goToEnd).
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            expect(mockReplay.goToStart).not.toHaveBeenCalled();
            expect(mockReplay.nextSession).not.toHaveBeenCalled();
            expect(mockReplay.goToEnd).not.toHaveBeenCalled();
          } finally {
            vi.useRealTimers();
          }
        });

        it("rebuilds when current SessionUniqueID is not in the cached Set (new race weekend)", async () => {
          vi.useFakeTimers();

          try {
            // First press: a race weekend with uniqueIds {1, 3}
            const firstWeekend = multiSessionBuffer(
              4,
              [
                { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999, framesPerLap: 100, fastestLap: -1 },
                {
                  sessionNum: 2,
                  sessionUniqueId: 3,
                  startFrame: 1000,
                  endFrame: 10_999,
                  framesPerLap: 1000,
                  fastestLap: 4,
                },
              ],
              { initialCursor: 5000 },
            );

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            expect(firstWeekend.cursor).toBeTruthy();
            expect([...(_getFastestLapSessionCache()?.sessionUniqueIds ?? [])].sort()).toEqual([1, 3]);

            // Second press: new race weekend with all-different uniqueIds.
            multiSessionBuffer(
              4,
              [
                {
                  sessionNum: 0,
                  sessionUniqueId: 10,
                  startFrame: 0,
                  endFrame: 999,
                  framesPerLap: 100,
                  fastestLap: -1,
                },
                {
                  sessionNum: 2,
                  sessionUniqueId: 11,
                  startFrame: 1000,
                  endFrame: 10_999,
                  framesPerLap: 1000,
                  fastestLap: 4,
                },
              ],
              { initialCursor: 5000 },
            );

            mockReplay.goToStart.mockClear();
            mockReplay.nextSession.mockClear();
            mockReplay.goToEnd.mockClear();

            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            // Cache miss → rebuild → new goToStart / nextSession / goToEnd.
            expect(mockReplay.goToStart).toHaveBeenCalled();
            expect(mockReplay.nextSession).toHaveBeenCalled();
            expect(mockReplay.goToEnd).toHaveBeenCalled();
            // New cache contains the new uniqueIds.
            expect([...(_getFastestLapSessionCache()?.sessionUniqueIds ?? [])].sort()).toEqual([10, 11]);
          } finally {
            vi.useRealTimers();
          }
        });
      });

      describe("per-car frame cache", () => {
        it("stores the landed frame after a successful walk", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            const cache = _getFastestLapSessionCache();

            expect(cache?.fastestLapFrames.has("4|4|2")).toBe(true);
            expect(typeof cache?.fastestLapFrames.get("4|4|2")).toBe("number");
          } finally {
            vi.useRealTimers();
          }
        });

        it("uses the cached frame on the next press (single setPlayPosition, no walk)", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            const cachedFrame = _getFastestLapSessionCache()?.fastestLapFrames.get("4|4|2");

            expect(cachedFrame).toBeDefined();

            mockReplay.setPlayPosition.mockClear();
            mockReplay.nextLap.mockClear();
            mockReplay.prevLap.mockClear();

            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            // Exactly one setPlayPosition (the cache-jump). No lap-step.
            expect(mockReplay.setPlayPosition).toHaveBeenCalledTimes(1);
            expect(mockReplay.setPlayPosition).toHaveBeenCalledWith(expect.anything(), cachedFrame);
            expect(mockReplay.nextLap).not.toHaveBeenCalled();
            expect(mockReplay.prevLap).not.toHaveBeenCalled();
          } finally {
            vi.useRealTimers();
          }
        });

        it("misses when targetLap changes (player set a new fastest lap)", async () => {
          vi.useFakeTimers();

          try {
            // First press: fastestLap = 4
            const buffer = singleSessionBuffer(4, 4);

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            // Switch to a buffer where the same car set a new fastest lap = 6.
            // Reuses the same session unique-id so the session map cache hits.
            multiSessionBuffer(
              4,
              [
                {
                  sessionNum: 2,
                  sessionUniqueId: 3,
                  startFrame: 0,
                  endFrame: 9999,
                  framesPerLap: 1000,
                  fastestLap: 6,
                },
              ],
              { initialCursor: buffer.cursor.frame },
            );

            mockReplay.setPlayPosition.mockClear();

            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            // Different key (4|6|2) → cache miss → full walk.
            expect(mockReplay.setPlayPosition.mock.calls.length).toBeGreaterThan(1);
            // After the walk both keys are in the cache.
            const cache = _getFastestLapSessionCache();

            expect(cache?.fastestLapFrames.has("4|4|2")).toBe(true);
            expect(cache?.fastestLapFrames.has("4|6|2")).toBe(true);
          } finally {
            vi.useRealTimers();
          }
        });
      });

      describe("walk phases (end-to-end on a single-session buffer)", () => {
        it("lands at lap === targetLap - 1 with dist ≥ 0.999 (= end of lap before fastest)", async () => {
          vi.useFakeTimers();

          try {
            // Fastest lap = 4 → target = lap 3. In the single-session buffer
            // (1000 frames per lap), end of lap 3 = frame 3 * 1000 + 999 = 3999.
            const buffer = singleSessionBuffer(4, 4);

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            // After bisection + lap-step + nudge + 2-tick back-step, the cursor
            // should be at end-of-lap-3 minus 2 ticks (~3997).
            expect(buffer.cursor.frame).toBeGreaterThanOrEqual(3990);
            expect(buffer.cursor.frame).toBeLessThanOrEqual(3999);
          } finally {
            vi.useRealTimers();
          }
        });

        it("calls nextSession to skip past sessions before the target session", async () => {
          vi.useFakeTimers();

          try {
            multiSessionBuffer(
              4,
              [
                { sessionNum: 0, sessionUniqueId: 1, startFrame: 0, endFrame: 999, framesPerLap: 100, fastestLap: -1 },
                {
                  sessionNum: 1,
                  sessionUniqueId: 2,
                  startFrame: 1000,
                  endFrame: 4999,
                  framesPerLap: 1000,
                  fastestLap: 2,
                },
                {
                  sessionNum: 2,
                  sessionUniqueId: 3,
                  startFrame: 5000,
                  endFrame: 14_999,
                  framesPerLap: 1000,
                  fastestLap: 4,
                },
              ],
              { initialCursor: 8000 },
            );

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            expect(mockReplay.nextSession.mock.calls.length).toBeGreaterThanOrEqual(2);
          } finally {
            vi.useRealTimers();
          }
        });

        it("bisects within the target session bounds, not the whole buffer", async () => {
          vi.useFakeTimers();

          try {
            // Two sessions: session 0 has 100 fast laps (frame 0-9999) we should
            // NEVER probe in bisection; session 2 holds the target. Watch every
            // setPlayPosition frame stays in session 2.
            multiSessionBuffer(
              4,
              [
                {
                  sessionNum: 0,
                  sessionUniqueId: 1,
                  startFrame: 0,
                  endFrame: 9999,
                  framesPerLap: 100,
                  fastestLap: -1,
                },
                {
                  sessionNum: 2,
                  sessionUniqueId: 3,
                  startFrame: 10_000,
                  endFrame: 19_999,
                  framesPerLap: 1000,
                  fastestLap: 4,
                },
              ],
              { initialCursor: 12_000 },
            );

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            // Bisection-driven setPlayPosition calls (skip the trailing back-step).
            const bisectionFrames = mockReplay.setPlayPosition.mock.calls.slice(0, -1).map((call) => call[1] as number);

            // Guard against a vacuously-passing loop if the walker never
            // actually bisected — without this the test would silently miss
            // a regression where phase 3 was skipped entirely.
            expect(bisectionFrames.length).toBeGreaterThan(0);

            for (const frame of bisectionFrames) {
              expect(frame).toBeGreaterThanOrEqual(10_000);
              expect(frame).toBeLessThanOrEqual(19_999);
            }
          } finally {
            vi.useRealTimers();
          }
        });

        it("calls nextLap / prevLap during the lap-step phase", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4, { initialCursor: 5000 });

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            // Either nextLap or prevLap fires at least once during the lap-step
            // and nudge phases — whichever direction reaches lap=3.
            const totalLapStepCalls = mockReplay.nextLap.mock.calls.length + mockReplay.prevLap.mock.calls.length;

            expect(totalLapStepCalls).toBeGreaterThan(0);
          } finally {
            vi.useRealTimers();
          }
        });

        it("does a single setPlayPosition(Begin, frame - 2) for the back-step", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            // The LAST setPlayPosition is the 2-tick back-step. Frame just
            // before it (= the pre-back-step cursor position) should be 2
            // frames higher than the LAST setPlayPosition's target.
            const calls = mockReplay.setPlayPosition.mock.calls;
            const lastTargetFrame = calls[calls.length - 1][1] as number;
            const secondLastTargetFrame = calls[calls.length - 2]?.[1] as number | undefined;

            // The very last call IS the back-step. It targets a frame 2 less
            // than the frame the cursor sat on right before it.
            expect(typeof secondLastTargetFrame).toBe("number");
            // Cursor frame just before back-step is at end-of-lap-3 ≈ 3999.
            // Back-step target is 3999 - 2 = 3997.
            expect(lastTargetFrame).toBeLessThanOrEqual(3997);
            expect(lastTargetFrame).toBeGreaterThanOrEqual(3995);
          } finally {
            vi.useRealTimers();
          }
        });
      });

      describe("guards", () => {
        it("ignores a second press while a walk is already in flight on the same context", async () => {
          vi.useFakeTimers();

          try {
            singleSessionBuffer(4, 4);

            await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            // Second press while the first is still in-flight (timers not drained).
            await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
            await vi.runAllTimersAsync();

            // pause was called only once (by the first walk; the second was a no-op).
            expect(mockReplay.pause).toHaveBeenCalledTimes(1);
          } finally {
            vi.useRealTimers();
          }
        });

        it("uses DriverCarIdx (not CamCarIdx) when target is always-my-car", async () => {
          vi.useFakeTimers();

          try {
            multiSessionBuffer(
              3,
              [
                {
                  sessionNum: 2,
                  sessionUniqueId: 3,
                  startFrame: 0,
                  endFrame: 9999,
                  framesPerLap: 1000,
                  fastestLap: 4,
                },
              ],
              { driverCarIdx: 3 },
            );
            // CamCarIdx is 3 by default in multiSessionBuffer — override telemetry
            // so the camera is on a DIFFERENT car (99).
            const originalGetTelemetry = action.sdkController.getCurrentTelemetry;

            action.sdkController.getCurrentTelemetry = vi.fn(() => {
              const tel = (originalGetTelemetry as any)() as any;

              return { ...tel, CamCarIdx: 99 };
            });

            await action.onWillAppear(
              fakeEvent("ctx-1", { mode: "jump-to-fastest-lap", fastestLapTarget: "always-my-car" }) as any,
            );
            await action.onKeyDown(
              fakeEvent("ctx-1", { mode: "jump-to-fastest-lap", fastestLapTarget: "always-my-car" }) as any,
            );
            await vi.runAllTimersAsync();

            // Camera switched to the driver's car (idx 3), NOT the viewed car (99).
            expect(mockCamera.switchNum).toHaveBeenCalledWith(3, 0, 0);
            // Cache key uses driverCarIdx=3.
            const cache = _getFastestLapSessionCache();

            expect(cache?.fastestLapFrames.has("3|4|2")).toBe(true);
          } finally {
            vi.useRealTimers();
          }
        });

        it("warns when the target car has no resolvable car number", async () => {
          vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValue(null);
          action.sdkController.getCurrentTelemetry = vi.fn(() => telemetryWithBest(2, 5, 3) as any);

          await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
          await action.onKeyDown(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);

          expect(mockCamera.switchNum).not.toHaveBeenCalled();
          expect(mockReplay.pause).not.toHaveBeenCalled();
          expect(action.logger.warn).toHaveBeenCalledWith(expect.stringContaining("car number"));
        });
      });
    });

    describe("encoder is a no-op for this mode", () => {
      it("onDialDown does nothing", async () => {
        action.sdkController.getCurrentTelemetry = vi.fn(() => telemetryWithBest(2, 10, 5) as any);

        await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
        await action.onDialDown({
          action: { id: "ctx-1", setTitle: vi.fn(), setImage: vi.fn() },
          payload: { settings: { mode: "jump-to-fastest-lap", fastestLapTarget: "viewed-car" } },
        } as any);

        expect(mockReplay.nextLap).not.toHaveBeenCalled();
        expect(mockReplay.prevLap).not.toHaveBeenCalled();
        expect(mockReplay.play).not.toHaveBeenCalled();
        expect(mockCamera.switchNum).not.toHaveBeenCalled();
      });

      it("onDialRotate does nothing in either direction", async () => {
        action.sdkController.getCurrentTelemetry = vi.fn(() => telemetryWithBest(2, 10, 5) as any);

        await action.onWillAppear(fakeEvent("ctx-1", { mode: "jump-to-fastest-lap" }) as any);
        await action.onDialRotate({
          action: { id: "ctx-1", setTitle: vi.fn(), setImage: vi.fn() },
          payload: { settings: { mode: "jump-to-fastest-lap", fastestLapTarget: "viewed-car" }, ticks: 1 },
        } as any);
        await action.onDialRotate({
          action: { id: "ctx-1", setTitle: vi.fn(), setImage: vi.fn() },
          payload: { settings: { mode: "jump-to-fastest-lap", fastestLapTarget: "viewed-car" }, ticks: -1 },
        } as any);

        expect(mockReplay.nextLap).not.toHaveBeenCalled();
        expect(mockReplay.prevLap).not.toHaveBeenCalled();
        expect(mockReplay.play).not.toHaveBeenCalled();
        expect(mockCamera.switchNum).not.toHaveBeenCalled();
      });
    });
  });

  describe("long-press repeat", () => {
    /** Create a minimal fake event with the given action ID and settings. */
    function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
      return {
        action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
        payload: { settings },
      };
    }

    const mockReplay = {
      play: vi.fn(() => true),
      pause: vi.fn(() => true),
      setPlaySpeed: vi.fn(() => true),
    };

    let action: ReplayControl;

    beforeEach(async () => {
      vi.clearAllMocks();
      const { getCommands } = await import("@iracedeck/deck-core");
      vi.mocked(getCommands).mockReturnValue({ replay: mockReplay, camera: { switchNum: vi.fn() } } as any);
      action = new ReplayControl();
      await action.onWillAppear(fakeEvent("action-1", { mode: "fast-forward" }) as any);
    });

    it("should auto-stop repeat after safety timeout", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "fast-forward" }) as any);
        expect((action as any).repeatTimers.has("action-1")).toBe(true);

        await vi.advanceTimersByTimeAsync(15_000);

        expect((action as any).repeatTimers.has("action-1")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should log a warning when safety timeout triggers", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "fast-forward" }) as any);

        await vi.advanceTimersByTimeAsync(15_000);

        expect(action.logger.warn).toHaveBeenCalledWith(expect.stringContaining("safety timeout"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("should clear safety timeout when keyUp arrives normally", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "fast-forward" }) as any);
        expect((action as any).repeatTimers.has("action-1")).toBe(true);

        await vi.advanceTimersByTimeAsync(500);
        await action.onKeyUp(fakeEvent("action-1") as any);
        expect((action as any).repeatTimers.has("action-1")).toBe(false);

        // Advance past safety timeout — no error, nothing happens
        await vi.advanceTimersByTimeAsync(15_000);
        expect((action as any).repeatTimers.has("action-1")).toBe(false);
        expect(action.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("safety timeout"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("should fire exactly once for a quick tap shorter than the hold threshold", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "fast-forward" }) as any);
        // Initial keyDown fires executeMode once.
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(1);

        // Release well before the 500ms initial delay.
        await vi.advanceTimersByTimeAsync(100);
        await action.onKeyUp(fakeEvent("action-1") as any);

        // No further repeats even after a long wait.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(1);
        expect((action as any).repeatTimers.has("action-1")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should repeat while held using a self-awaiting loop", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "fast-forward" }) as any);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(1);

        // Initial hold delay must elapse before the loop starts.
        await vi.advanceTimersByTimeAsync(499);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        // Hold threshold crossed; loop is scheduled, first tick fires
        // LONG_PRESS_REPEAT_GAP_MS (250ms) later.
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(250);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(250);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(3);

        await action.onKeyUp(fakeEvent("action-1") as any);

        // After release, no further fires.
        await vi.advanceTimersByTimeAsync(500);
        expect(mockReplay.setPlaySpeed).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("startRepeat should be a no-op when the button is no longer held", () => {
      // Direct guard test: same class of race as the fuel-service stuck bug.
      // Even though replay-control's executeMode is currently sync (SDK broadcast),
      // the guard keeps us safe if executeMode ever gains an async path.
      (action as any).heldButtons.add("action-1");
      (action as any).heldButtons.delete("action-1");

      (action as any).startRepeat("action-1", {
        mode: "fast-forward",
        speed: "1",
        flagsOverlay: false,
        addedWithVersion: "0.0.0",
      });

      expect((action as any).repeatTimers.has("action-1")).toBe(false);
    });

    it("should stop the repeat loop immediately when onDidReceiveSettings fires mid-hold", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "fast-forward" }) as any);
        expect((action as any).repeatTimers.has("action-1")).toBe(true);

        // Settings update mid-hold should clear both heldButtons and timers.
        await vi.advanceTimersByTimeAsync(200);
        await action.onDidReceiveSettings(fakeEvent("action-1", { mode: "fast-forward" }) as any);

        expect((action as any).heldButtons.has("action-1")).toBe(false);
        expect((action as any).repeatTimers.has("action-1")).toBe(false);

        // No further fires after the mid-hold settings update.
        const callsBefore = mockReplay.setPlaySpeed.mock.calls.length;
        await vi.advanceTimersByTimeAsync(20_000);
        expect(mockReplay.setPlaySpeed.mock.calls.length).toBe(callsBefore);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
