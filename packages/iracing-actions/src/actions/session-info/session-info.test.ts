import { FLAG_DEFINITIONS, resolveActiveFlag, SessionState, TrackWetness } from "@iracedeck/iracing-sdk";
import {
  getFuelStats,
  getLiveGaps,
  getLivePosition,
  getLiveRacePositions,
  getStartingGridPosition,
  type LiveGaps,
} from "@iracedeck/sim-events-iracing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  countActiveDrivers,
  countActiveDriversInPlayerClass,
  formatFuelAmount,
  formatGapValue,
  formatSessionTime,
  generateGapsGraphic,
  generateSessionInfoSvg,
  generateTrackWetnessGraphic,
  generateWindGraphic,
  iratingValueColor,
  resolveWindDisplay,
  SessionInfo,
  trackWetnessLabel,
  WIND_ARROW_STEP_DEG,
} from "./session-info.js";

vi.mock("@iracedeck/iracing-sdk", async () => {
  const actual = await vi.importActual<typeof import("@iracedeck/iracing-sdk")>("@iracedeck/iracing-sdk");

  return actual;
});

// getLivePosition is the translator-singleton class-aware resolver; mock it so the
// position-mode tests control the frozen overall + authoritative class numbers.
// getStartingGridPosition is the qualifying-grid resolver used pre-green (issue #647).
// getFuelStats is the validated fuel lap history accessor (issue #465).
vi.mock("@iracedeck/sim-events-iracing", () => ({
  FUEL_LAP_HISTORY_CAP: 20,
  getFuelStats: vi.fn(() => ({ lastLap: null, avg: null, avgLapTime: null, samples: 0 })),
  getLiveGaps: vi.fn(() => null),
  getLivePosition: vi.fn(() => null),
  getLiveRacePositions: vi.fn(() => null),
  getStartingGridPosition: vi.fn(() => null),
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: () => {
      const defaults = {
        mode: "incidents",
        positionType: "class",
        positionShowTotal: false,
        fuelFormat: "amount",
        fuelSubMode: "now",
        fuelLapWindow: 5,
        blankWhenNoFlag: false,
        gapShowAhead: true,
        gapShowBehind: true,
      };
      const validModes = [
        "incidents",
        "time-remaining",
        "laps",
        "position",
        "irating",
        "gaps",
        "fuel",
        "flags",
        "track-wetness",
        "laps-to-empty",
      ];
      const coerceBool = (v: unknown): boolean => v === true || v === "true";
      const merge = (data: Record<string, unknown>) => {
        const merged: Record<string, unknown> = { ...defaults, ...data };

        if ("positionShowTotal" in merged) merged.positionShowTotal = coerceBool(merged.positionShowTotal);

        if ("blankWhenNoFlag" in merged) merged.blankWhenNoFlag = coerceBool(merged.blankWhenNoFlag);

        if ("gapShowAhead" in merged) merged.gapShowAhead = coerceBool(merged.gapShowAhead);

        if ("gapShowBehind" in merged) merged.gapShowBehind = coerceBool(merged.gapShowBehind);

        if ("fuelLapWindow" in merged) {
          // Mirrors the real schema: round + clamp, never hard-fail.
          const window = Math.round(Number(merged.fuelLapWindow));
          merged.fuelLapWindow = Number.isFinite(window) ? Math.min(20, Math.max(1, window)) : 5;
        }

        return merged;
      };
      const schema = {
        parse: (data: Record<string, unknown>) => merge(data),
        safeParse: (data: Record<string, unknown>) => {
          if (data?.mode && !validModes.includes(data.mode as string)) {
            return { success: false, error: new Error("Invalid mode") };
          }

          return { success: true, data: merge(data) };
        },
      };

      return schema;
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn(), getSessionInfo: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn().mockResolvedValue(true);
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
  generateTitleText: vi.fn(({ text, fill }: { text: string; fill: string }) => {
    if (!text) return "";

    return `<text fill="${fill}">${text}</text>`;
  }),
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
  resolveIconColors: vi.fn((_svg: string, _global: unknown, _overrides: unknown) => ({
    backgroundColor: "#2a3444",
    textColor: "#ffffff",
  })),
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.backgroundColor || ""}|${data.titleContent || ""}|${data.graphicContent || ""}|<text font-size="${data.valueFontSize || ""}" y="${data.valueY || ""}" fill="${data.textColor || ""}">${data.value || ""}</text></svg>`;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

/** Default settings factory for tests */
function defaultSettings(
  overrides: Partial<{
    mode:
      | "incidents"
      | "time-remaining"
      | "laps"
      | "position"
      | "irating"
      | "gaps"
      | "fuel"
      | "flags"
      | "track-wetness"
      | "laps-to-empty"
      | "wind";
    fontSize: number;
    positionType: "class" | "overall";
    positionShowTotal: boolean;
    fuelFormat: "amount" | "percentage";
    fuelSubMode: "now" | "lastLap" | "avgN";
    fuelLapWindow: number;
    blankWhenNoFlag: boolean;
    gapShowAhead: boolean;
    gapShowBehind: boolean;
    windDirectionMode: "relative" | "absolute";
    windSpeedUnit: "ms" | "kmh" | "mph";
  }> = {},
) {
  return {
    addedWithVersion: "0.0.0",
    mode: "incidents" as const,
    positionType: "class" as const,
    positionShowTotal: false,
    fuelFormat: "amount" as const,
    fuelSubMode: "now" as const,
    fuelLapWindow: 5,
    blankWhenNoFlag: false,
    gapShowAhead: true,
    gapShowBehind: true,
    windDirectionMode: "relative" as const,
    windSpeedUnit: "kmh" as const,
    ...overrides,
  };
}

/** Create a minimal fake event with the given action ID and settings. */
function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings },
  };
}

describe("SessionInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("formatSessionTime", () => {
    it("should format hours, minutes, and seconds", () => {
      expect(formatSessionTime(3661)).toBe("1:01:01");
    });

    it("should format exactly one hour", () => {
      expect(formatSessionTime(3600)).toBe("1:00:00");
    });

    it("should format minutes and seconds without hours", () => {
      expect(formatSessionTime(754)).toBe("12:34");
    });

    it("should format seconds under a minute", () => {
      expect(formatSessionTime(45)).toBe("0:45");
    });

    it("should format zero", () => {
      expect(formatSessionTime(0)).toBe("0:00");
    });

    it("should handle fractional seconds by flooring", () => {
      expect(formatSessionTime(90.7)).toBe("1:30");
    });

    it("should handle negative values", () => {
      expect(formatSessionTime(-10)).toBe("0:00");
    });

    it("should handle Infinity", () => {
      expect(formatSessionTime(Infinity)).toBe("0:00");
    });

    it("should handle NaN", () => {
      expect(formatSessionTime(NaN)).toBe("0:00");
    });

    it("should pad seconds correctly", () => {
      expect(formatSessionTime(61)).toBe("1:01");
    });

    it("should pad minutes in hour format", () => {
      expect(formatSessionTime(3605)).toBe("1:00:05");
    });
  });

  describe("formatFuelAmount", () => {
    it("should format metric fuel in liters", () => {
      expect(formatFuelAmount(12.34, 1)).toBe("12.3 L");
    });

    it("should format imperial fuel in gallons", () => {
      expect(formatFuelAmount(3.78541, 0)).toBe("1.0 gal");
    });

    it("should honor a custom decimal count", () => {
      expect(formatFuelAmount(2.845, 1, 2)).toBe("2.85 L");
      expect(formatFuelAmount(7.57082, 0, 2)).toBe("2.00 gal");
    });

    it("should default to liters when DisplayUnits is undefined", () => {
      expect(formatFuelAmount(5.5, undefined)).toBe("5.5 L");
    });

    it("should round to one decimal place", () => {
      expect(formatFuelAmount(10.789, 1)).toBe("10.8 L");
    });
  });

  describe("countActiveDrivers", () => {
    it("should return 0 for null session info", () => {
      expect(countActiveDrivers(null)).toBe(0);
    });

    it("should return 0 when DriverInfo is missing", () => {
      expect(countActiveDrivers({ WeekendInfo: {} })).toBe(0);
    });

    it("should return 0 when Drivers array is missing", () => {
      expect(countActiveDrivers({ DriverInfo: {} })).toBe(0);
    });

    it("should return 0 when Drivers is not an array", () => {
      expect(countActiveDrivers({ DriverInfo: { Drivers: "invalid" } })).toBe(0);
    });

    it("should filter out pace car", () => {
      const sessionInfo = {
        DriverInfo: {
          Drivers: [
            { CarIdx: 0, UserName: "Pace Car", CarIsPaceCar: 1, IsSpectator: 0 },
            { CarIdx: 1, UserName: "Driver 1", CarIsPaceCar: 0, IsSpectator: 0 },
          ],
        },
      };

      expect(countActiveDrivers(sessionInfo)).toBe(1);
    });

    it("should filter out spectators", () => {
      const sessionInfo = {
        DriverInfo: {
          Drivers: [
            { CarIdx: 1, UserName: "Driver 1", CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 2, UserName: "Spectator", CarIsPaceCar: 0, IsSpectator: 1 },
          ],
        },
      };

      expect(countActiveDrivers(sessionInfo)).toBe(1);
    });

    it("should count real drivers correctly", () => {
      const sessionInfo = {
        DriverInfo: {
          Drivers: [
            { CarIdx: 1, UserName: "Driver 1", CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 2, UserName: "Driver 2", CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 3, UserName: "Driver 3", CarIsPaceCar: 0, IsSpectator: 0 },
          ],
        },
      };

      expect(countActiveDrivers(sessionInfo)).toBe(3);
    });

    it("should handle mixed pace car, spectators, and real drivers", () => {
      const sessionInfo = {
        DriverInfo: {
          Drivers: [
            { CarIdx: 0, UserName: "Pace Car", CarIsPaceCar: 1, IsSpectator: 0 },
            { CarIdx: 1, UserName: "Driver 1", CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 2, UserName: "Driver 2", CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 3, UserName: "Spectator", CarIsPaceCar: 0, IsSpectator: 1 },
            { CarIdx: 4, UserName: "Driver 3", CarIsPaceCar: 0, IsSpectator: 0 },
          ],
        },
      };

      expect(countActiveDrivers(sessionInfo)).toBe(3);
    });

    it("should return 0 for empty Drivers array", () => {
      expect(countActiveDrivers({ DriverInfo: { Drivers: [] } })).toBe(0);
    });
  });

  describe("countActiveDriversInPlayerClass", () => {
    it("should return 0 for null session info", () => {
      expect(countActiveDriversInPlayerClass(null)).toBe(0);
    });

    it("should return 0 when DriverInfo is missing", () => {
      expect(countActiveDriversInPlayerClass({ WeekendInfo: {} })).toBe(0);
    });

    it("should return 0 when the player's class cannot be resolved", () => {
      // DriverCarIdx points at a car with no Drivers entry → class unknown.
      const sessionInfo = {
        DriverInfo: {
          DriverCarIdx: 9,
          Drivers: [{ CarIdx: 1, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 }],
        },
      };

      expect(countActiveDriversInPlayerClass(sessionInfo)).toBe(0);
    });

    it("should count only drivers sharing the player's class", () => {
      const sessionInfo = {
        DriverInfo: {
          DriverCarIdx: 1,
          Drivers: [
            { CarIdx: 1, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 }, // player
            { CarIdx: 2, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 3, CarClassID: 20, CarIsPaceCar: 0, IsSpectator: 0 }, // other class
            { CarIdx: 4, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 },
          ],
        },
      };

      // Class 10 has 3 cars (the player + two others).
      expect(countActiveDriversInPlayerClass(sessionInfo)).toBe(3);
    });

    it("should exclude pace car and spectators from the class count", () => {
      const sessionInfo = {
        DriverInfo: {
          DriverCarIdx: 1,
          Drivers: [
            { CarIdx: 0, CarClassID: 10, CarIsPaceCar: 1, IsSpectator: 0 }, // pace car, class 10
            { CarIdx: 1, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 }, // player
            { CarIdx: 2, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 1 }, // spectator, class 10
            { CarIdx: 3, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 },
          ],
        },
      };

      // Only the player and CarIdx 3 are active class-10 cars.
      expect(countActiveDriversInPlayerClass(sessionInfo)).toBe(2);
    });

    it("should return 1 for a lone driver in their class (single-class field)", () => {
      const sessionInfo = {
        DriverInfo: {
          DriverCarIdx: 1,
          Drivers: [{ CarIdx: 1, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 }],
        },
      };

      expect(countActiveDriversInPlayerClass(sessionInfo)).toBe(1);
    });
  });

  describe("resolveActiveFlag", () => {
    it("should return null for undefined flags", () => {
      expect(resolveActiveFlag(undefined)).toBeNull();
    });

    it("should return null for zero flags", () => {
      expect(resolveActiveFlag(0)).toBeNull();
    });

    it("should resolve green flag", () => {
      const result = resolveActiveFlag(0x00000004); // Flags.Green

      expect(result).not.toBeNull();
      expect(result!.label).toBe("GREEN");
      expect(result!.pulse).toBe(false);
    });

    it("should resolve yellow flag", () => {
      const result = resolveActiveFlag(0x00000008); // Flags.Yellow

      expect(result).not.toBeNull();
      expect(result!.label).toBe("YELLOW");
      expect(result!.textColor).toBe("#1a1a1a");
    });

    it("should resolve caution as yellow", () => {
      const result = resolveActiveFlag(0x00004000); // Flags.Caution

      expect(result).not.toBeNull();
      expect(result!.label).toBe("YELLOW");
    });

    it("should resolve caution waving as yellow", () => {
      const result = resolveActiveFlag(0x00008000); // Flags.CautionWaving

      expect(result).not.toBeNull();
      expect(result!.label).toBe("YELLOW");
    });

    it("should resolve red flag", () => {
      const result = resolveActiveFlag(0x00000010); // Flags.Red

      expect(result).not.toBeNull();
      expect(result!.label).toBe("RED");
    });

    it("should resolve blue flag", () => {
      const result = resolveActiveFlag(0x00000020); // Flags.Blue

      expect(result).not.toBeNull();
      expect(result!.label).toBe("BLUE");
    });

    it("should resolve white flag", () => {
      const result = resolveActiveFlag(0x00000002); // Flags.White

      expect(result).not.toBeNull();
      expect(result!.label).toBe("WHITE");
      expect(result!.textColor).toBe("#1a1a1a");
    });

    it("should resolve checkered flag", () => {
      const result = resolveActiveFlag(0x00000001); // Flags.Checkered

      expect(result).not.toBeNull();
      expect(result!.label).toBe("FINISH");
    });

    it("should resolve black flag with pulse", () => {
      const result = resolveActiveFlag(0x00010000); // Flags.Black

      expect(result).not.toBeNull();
      expect(result!.label).toBe("BLACK");
      expect(result!.pulse).toBe(true);
    });

    it("should resolve disqualify as black flag", () => {
      const result = resolveActiveFlag(0x00020000); // Flags.Disqualify

      expect(result).not.toBeNull();
      expect(result!.label).toBe("BLACK");
      expect(result!.pulse).toBe(true);
    });

    it("should resolve meatball (repair) flag with pulse", () => {
      const result = resolveActiveFlag(0x00100000); // Flags.Repair

      expect(result).not.toBeNull();
      expect(result!.label).toBe("REPAIR");
      expect(result!.pulse).toBe(true);
    });

    it("should prioritize red over yellow when both active", () => {
      const result = resolveActiveFlag(0x00000010 | 0x00000008); // Red | Yellow

      expect(result).not.toBeNull();
      expect(result!.label).toBe("RED");
    });

    it("should prioritize black over yellow when both active", () => {
      const result = resolveActiveFlag(0x00010000 | 0x00000008); // Black | Yellow

      expect(result).not.toBeNull();
      expect(result!.label).toBe("BLACK");
    });

    it("should prioritize yellow over blue", () => {
      const result = resolveActiveFlag(0x00000008 | 0x00000020); // Yellow | Blue

      expect(result).not.toBeNull();
      expect(result!.label).toBe("YELLOW");
    });

    it("should prioritize yellow over green", () => {
      const result = resolveActiveFlag(0x00000008 | 0x00000004); // Yellow | Green

      expect(result).not.toBeNull();
      expect(result!.label).toBe("YELLOW");
    });
  });

  describe("FLAG_DEFINITIONS", () => {
    it("should have unique labels", () => {
      const labels = FLAG_DEFINITIONS.map((d) => d.info.label);
      const unique = new Set(labels);

      expect(unique.size).toBe(labels.length);
    });

    it("should have valid color hex codes", () => {
      for (const def of FLAG_DEFINITIONS) {
        expect(def.info.color).toMatch(/^#[0-9a-f]{6}$/);
        expect(def.info.textColor).toMatch(/^#[0-9a-f]{6}$/);
      }
    });
  });

  describe("generateSessionInfoSvg", () => {
    it("should generate a valid data URI for incidents mode", () => {
      const result = generateSessionInfoSvg(defaultSettings(), "3x", false);

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for time-remaining mode", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "time-remaining" }), "12:34", false);

      expect(result).toContain("data:image/svg+xml");
    });

    it("should use INCIDENTS title for incidents mode", () => {
      const result = generateSessionInfoSvg(defaultSettings(), "0x", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("INCIDENTS");
    });

    it("should use TIME LEFT title for time-remaining mode", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "time-remaining" }), "5:00", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("TIME LEFT");
    });

    it("should fall back to value font size 28 (144x144) when fontSize is unset", () => {
      const result = generateSessionInfoSvg(defaultSettings(), "0x", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain('font-size="28"');
    });

    it("should use the same fallback regardless of mode when fontSize is unset", () => {
      const incidents = decodeURIComponent(generateSessionInfoSvg(defaultSettings(), "0x", false));
      const timeRemaining = decodeURIComponent(
        generateSessionInfoSvg(defaultSettings({ mode: "time-remaining" }), "12:34", false),
      );
      const longTime = decodeURIComponent(
        generateSessionInfoSvg(defaultSettings({ mode: "time-remaining" }), "1:23:45", false),
      );

      expect(incidents).toContain('font-size="28"');
      expect(timeRemaining).toContain('font-size="28"');
      expect(longTime).toContain('font-size="28"');
    });

    it("should use custom value font size when configured (PI units doubled to SVG)", () => {
      const result = generateSessionInfoSvg(defaultSettings({ fontSize: 20 }), "0x", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain('font-size="40"');
    });

    it("should use the EJS default 14 PI units (= 28 SVG) when persisted", () => {
      const result = generateSessionInfoSvg(defaultSettings({ fontSize: 14 }), "0x", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain('font-size="28"');
    });

    it("should use default background when not flashing", () => {
      const result = generateSessionInfoSvg(defaultSettings(), "0x", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#2a3444");
    });

    it("should use red background when flashing", () => {
      const result = generateSessionInfoSvg(defaultSettings(), "2x", true);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#e74c3c");
    });

    it("should include the value in the output", () => {
      const result = generateSessionInfoSvg(defaultSettings(), "5x", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("5x");
    });

    it("should produce different outputs for different modes", () => {
      const incidents = generateSessionInfoSvg(defaultSettings(), "0x", false);
      const time = generateSessionInfoSvg(defaultSettings({ mode: "time-remaining" }), "0:00", false);

      expect(incidents).not.toBe(time);
    });

    it("should use LAPS title for laps mode", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "laps" }), "5/20", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LAPS");
    });

    it("should include infinity symbol for unlimited laps", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "laps" }), "5/\u221E", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("\u221E");
    });

    it("should use POSITION title for position mode", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "position" }), "P3", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("POSITION");
    });

    it("should use FUEL title for fuel mode", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "fuel" }), "34%", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FUEL");
    });

    it("should use LAST LAP title for the fuel lastLap sub-mode", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "fuel", fuelSubMode: "lastLap" }), "2.8 L", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LAST LAP");
    });

    it("should include the lap window in the fuel avgN sub-mode title", () => {
      const result = generateSessionInfoSvg(
        defaultSettings({ mode: "fuel", fuelSubMode: "avgN", fuelLapWindow: 10 }),
        "2.8 L",
        false,
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("AVG 10 LAPS");
    });

    it("should use the singular LAP in the avgN title for a 1-lap window", () => {
      const result = generateSessionInfoSvg(
        defaultSettings({ mode: "fuel", fuelSubMode: "avgN", fuelLapWindow: 1 }),
        "2.8 L",
        false,
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("AVG 1 LAP");
      expect(decoded).not.toContain("AVG 1 LAPS");
    });

    it("should use the two-line LAPS TO EMPTY title for laps-to-empty mode", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "laps-to-empty" }), "12.45", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LAPS TO\nEMPTY");
    });

    it("should use FLAGS title for flags mode", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "flags" }), "GREEN", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FLAGS");
    });

    it("should use color override background when provided", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "flags" }), "YELLOW", false, {
        background: "#f1c40f",
        text: "#1a1a1a",
      });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#f1c40f");
    });

    it("should use color override text color when provided", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "flags" }), "YELLOW", false, {
        background: "#f1c40f",
        text: "#1a1a1a",
      });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#1a1a1a");
    });

    it("should use white text color by default when no override", () => {
      const result = generateSessionInfoSvg(defaultSettings(), "0x", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#ffffff");
    });

    it("should ignore isFlashing when color override is provided", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "flags" }), "GREEN", true, {
        background: "#2ecc71",
        text: "#ffffff",
      });
      const decoded = decodeURIComponent(result);

      // Should use override color, not flash red
      expect(decoded).toContain("#2ecc71");
      expect(decoded).not.toContain("#e74c3c");
    });

    it("should use the live state name as the title for track-wetness mode", () => {
      const dry = decodeURIComponent(
        generateSessionInfoSvg(defaultSettings({ mode: "track-wetness" }), "DRY", false, undefined, {
          trackWetness: TrackWetness.Dry,
        }),
      );
      const wet = decodeURIComponent(
        generateSessionInfoSvg(defaultSettings({ mode: "track-wetness" }), "MOSTLY DRY", false, undefined, {
          trackWetness: TrackWetness.MostlyDry,
        }),
      );

      expect(dry).toContain("DRY");
      expect(dry).not.toContain("WETNESS");
      expect(wet).toContain("MOSTLY DRY");
    });

    it("should leave the value text slot empty for track-wetness", () => {
      const result = generateSessionInfoSvg(
        defaultSettings({ mode: "track-wetness" }),
        "MOSTLY DRY",
        false,
        undefined,
        { trackWetness: TrackWetness.MostlyDry },
      );
      const decoded = decodeURIComponent(result);

      // Title (from generateTitleText mock) is the only place the state label appears.
      const matches = decoded.match(/MOSTLY DRY/g) ?? [];

      expect(matches.length).toBe(1);
      // Value-slot <text> exists but is empty between > and </text>.
      expect(decoded).toMatch(/y="\d[\d.]*"[^>]*>(<\/text>|\s*<\/text>)/);
    });

    it("should include bar segments in the graphicContent for track-wetness", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "track-wetness" }), "DRY", false, undefined, {
        trackWetness: TrackWetness.Dry,
      });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("<rect");
    });

    it("should not include any graphicContent for non-track-wetness modes", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "incidents" }), "3x", false);
      const decoded = decodeURIComponent(result);

      // No bar rects in incidents mode (border rects are stripped by the mock)
      expect(decoded).not.toContain("<rect");
    });
  });

  describe("trackWetnessLabel", () => {
    it("returns '--' for Unknown", () => {
      expect(trackWetnessLabel(TrackWetness.Unknown)).toBe("--");
    });

    it("returns '--' for undefined", () => {
      expect(trackWetnessLabel(undefined)).toBe("--");
    });

    it("returns 'DRY' for Dry", () => {
      expect(trackWetnessLabel(TrackWetness.Dry)).toBe("DRY");
    });

    it("returns 'MOSTLY DRY' for MostlyDry", () => {
      expect(trackWetnessLabel(TrackWetness.MostlyDry)).toBe("MOSTLY DRY");
    });

    it("returns 'V. LIGHT' for VeryLightlyWet", () => {
      expect(trackWetnessLabel(TrackWetness.VeryLightlyWet)).toBe("V. LIGHT");
    });

    it("returns 'LIGHT' for LightlyWet", () => {
      expect(trackWetnessLabel(TrackWetness.LightlyWet)).toBe("LIGHT");
    });

    it("returns 'MODERATE' for ModeratelyWet", () => {
      expect(trackWetnessLabel(TrackWetness.ModeratelyWet)).toBe("MODERATE");
    });

    it("returns 'VERY WET' for VeryWet", () => {
      expect(trackWetnessLabel(TrackWetness.VeryWet)).toBe("VERY WET");
    });

    it("returns 'EXTREME' for ExtremelyWet", () => {
      expect(trackWetnessLabel(TrackWetness.ExtremelyWet)).toBe("EXTREME");
    });
  });

  describe("generateTrackWetnessGraphic", () => {
    const LIT_COLORS = ["#a8e6f0", "#6dc9e3", "#3b9bc4", "#1f7eb0", "#15639a", "#0e4c80"];

    function countSegmentRects(svg: string): { lit: number; total: number } {
      const rectMatches = svg.match(/<rect[^/]*\/>/g) ?? [];
      const lit = rectMatches.filter((rect) => LIT_COLORS.some((c) => rect.includes(c))).length;

      return { lit, total: rectMatches.length };
    }

    it("renders 6 segments total regardless of state", () => {
      for (const state of [
        TrackWetness.Unknown,
        TrackWetness.Dry,
        TrackWetness.MostlyDry,
        TrackWetness.VeryLightlyWet,
        TrackWetness.LightlyWet,
        TrackWetness.ModeratelyWet,
        TrackWetness.VeryWet,
        TrackWetness.ExtremelyWet,
      ]) {
        const svg = generateTrackWetnessGraphic(state);
        const counts = countSegmentRects(svg);

        expect(counts.total).toBe(6);
      }
    });

    it("lights 0 segments for Unknown", () => {
      expect(countSegmentRects(generateTrackWetnessGraphic(TrackWetness.Unknown)).lit).toBe(0);
    });

    it("lights 0 segments for undefined", () => {
      expect(countSegmentRects(generateTrackWetnessGraphic(undefined)).lit).toBe(0);
    });

    it("lights 0 segments for Dry", () => {
      expect(countSegmentRects(generateTrackWetnessGraphic(TrackWetness.Dry)).lit).toBe(0);
    });

    it("lights segments according to state (MostlyDry=1 … ExtremelyWet=6)", () => {
      const cases: Array<[TrackWetness, number]> = [
        [TrackWetness.MostlyDry, 1],
        [TrackWetness.VeryLightlyWet, 2],
        [TrackWetness.LightlyWet, 3],
        [TrackWetness.ModeratelyWet, 4],
        [TrackWetness.VeryWet, 5],
        [TrackWetness.ExtremelyWet, 6],
      ];

      for (const [state, expectedLit] of cases) {
        const svg = generateTrackWetnessGraphic(state);

        expect(countSegmentRects(svg).lit).toBe(expectedLit);
      }
    });

    it("uses the unlit color for all segments when state is Unknown or Dry", () => {
      for (const state of [TrackWetness.Unknown, TrackWetness.Dry]) {
        const svg = generateTrackWetnessGraphic(state);

        for (const c of LIT_COLORS) expect(svg).not.toContain(c);

        expect(svg).toContain("#3a3a3a");
      }
    });

    it("does not render any text inside the graphic (the title carries the state name)", () => {
      const svg = generateTrackWetnessGraphic(TrackWetness.MostlyDry);

      expect(svg).not.toContain("<text");
    });
  });

  describe("track-wetness mode display value", () => {
    it("returns 'DRY' label when telemetry reports Dry", () => {
      const action = new SessionInfo();
      const settings = defaultSettings({ mode: "track-wetness" });
      const telemetry = { TrackWetness: TrackWetness.Dry } as any;

      expect(action["extractDisplayValue"](settings as any, telemetry)).toBe("DRY");
    });

    it("returns 'EXTREME' label when telemetry reports ExtremelyWet", () => {
      const action = new SessionInfo();
      const settings = defaultSettings({ mode: "track-wetness" });
      const telemetry = { TrackWetness: TrackWetness.ExtremelyWet } as any;

      expect(action["extractDisplayValue"](settings as any, telemetry)).toBe("EXTREME");
    });

    it("returns '--' label when telemetry is null", () => {
      const action = new SessionInfo();
      const settings = defaultSettings({ mode: "track-wetness" });

      expect(action["extractDisplayValue"](settings as any, null)).toBe("--");
    });

    it("returns '--' label when TrackWetness is missing from telemetry", () => {
      const action = new SessionInfo();
      const settings = defaultSettings({ mode: "track-wetness" });
      const telemetry = {} as any;

      expect(action["extractDisplayValue"](settings as any, telemetry)).toBe("--");
    });
  });

  describe("irating mode display value (issue #268)", () => {
    // Race session with a 3-car single-class field; the player (carIdx 0) has the
    // highest rating. Live order: carIdx 1 leads, player second, carIdx 2 third.
    const IRATING_SESSION_INFO = {
      SessionInfo: { Sessions: [{ SessionType: "Race" }] },
      DriverInfo: {
        DriverCarIdx: 0,
        Drivers: [
          { CarIdx: 0, UserName: "Player", CarNumber: "1", IRating: 3000, CarIsPaceCar: 0, IsSpectator: 0 },
          { CarIdx: 1, UserName: "Leader", CarNumber: "2", IRating: 2500, CarIsPaceCar: 0, IsSpectator: 0 },
          { CarIdx: 2, UserName: "Trailer", CarNumber: "3", IRating: 2000, CarIsPaceCar: 0, IsSpectator: 0 },
        ],
      },
    };

    function makeIratingAction(order: number[] | null, sessionInfo: unknown = IRATING_SESSION_INFO) {
      vi.mocked(getLiveRacePositions).mockReturnValue(order);
      const action = new SessionInfo();
      action["sdkController"].getSessionInfo = vi.fn().mockReturnValue(sessionInfo);

      return action;
    }

    it("shows a minus-signed value when the player runs below expectation", () => {
      // Highest-rated player running P2 of 3 → expected to lose points.
      const action = makeIratingAction([2, 1, 3]);
      const settings = defaultSettings({ mode: "irating" });
      const telemetry = { SessionNum: 0, CarIdxClass: [100, 100, 100] } as any;

      expect(action["extractDisplayValue"](settings as any, telemetry)).toMatch(/^-\d+$/);
    });

    it("shows a plus-signed value when the player runs above expectation", () => {
      // Lowest-rated player leading a 2-car field → expected to gain points.
      const sessionInfo = {
        SessionInfo: { Sessions: [{ SessionType: "Race" }] },
        DriverInfo: {
          DriverCarIdx: 0,
          Drivers: [
            { CarIdx: 0, UserName: "Player", CarNumber: "1", IRating: 2000, CarIsPaceCar: 0, IsSpectator: 0 },
            { CarIdx: 1, UserName: "Rival", CarNumber: "2", IRating: 3000, CarIsPaceCar: 0, IsSpectator: 0 },
          ],
        },
      };
      const action = makeIratingAction([1, 2], sessionInfo);
      const settings = defaultSettings({ mode: "irating" });
      const telemetry = { SessionNum: 0, CarIdxClass: [100, 100] } as any;

      expect(action["extractDisplayValue"](settings as any, telemetry)).toMatch(/^\+\d+$/);
    });

    it("shows the estimate from official positions in a qualifying session (#872)", () => {
      const sessionInfo = { ...IRATING_SESSION_INFO, SessionInfo: { Sessions: [{ SessionType: "Open Qualify" }] } };
      const action = makeIratingAction(null, sessionInfo);
      const settings = defaultSettings({ mode: "irating" });
      // Highest-rated player (3000) sitting P2 of 3 in the qualifying standings → losing points.
      const telemetry = { SessionNum: 0, CarIdxPosition: [2, 1, 3], CarIdxClass: [100, 100, 100] } as any;

      expect(action["extractDisplayValue"](settings as any, telemetry)).toMatch(/^-\d+$/);
    });

    it("shows the estimate from the qualifying grid in a race before any positions exist (#872)", () => {
      const sessionInfo = {
        ...IRATING_SESSION_INFO,
        // Grid: carIdx 1 on pole, player second, carIdx 2 third (Position is 0-indexed).
        QualifyResultsInfo: {
          Results: [
            { CarIdx: 0, Position: 1 },
            { CarIdx: 1, Position: 0 },
            { CarIdx: 2, Position: 2 },
          ],
        },
      };
      const action = makeIratingAction([0, 0, 0], sessionInfo);
      const settings = defaultSettings({ mode: "irating" });
      const telemetry = { SessionNum: 0, CarIdxPosition: [0, 0, 0], CarIdxClass: [100, 100, 100] } as any;

      expect(action["extractDisplayValue"](settings as any, telemetry)).toMatch(/^-\d+$/);
    });

    it("holds the grid estimate through the green-flag run to the line (player not yet classified)", () => {
      const sessionInfo = {
        ...IRATING_SESSION_INFO,
        QualifyResultsInfo: {
          Results: [
            { CarIdx: 0, Position: 1 },
            { CarIdx: 1, Position: 0 },
            { CarIdx: 2, Position: 2 },
          ],
        },
      };
      // The leader (carIdx 1) has crossed S/F; the player (carIdx 0) has not.
      const action = makeIratingAction([0, 1, 0], sessionInfo);
      const settings = defaultSettings({ mode: "irating" });
      const telemetry = { SessionNum: 0, CarIdxPosition: [0, 1, 0], CarIdxClass: [100, 100, 100] } as any;

      expect(action["extractDisplayValue"](settings as any, telemetry)).toMatch(/^-\d+$/);
    });

    it("renders '--' when no order source is usable", () => {
      const action = makeIratingAction(null);
      const settings = defaultSettings({ mode: "irating" });
      const telemetry = { SessionNum: 0 } as any;

      expect(action["extractDisplayValue"](settings as any, telemetry)).toBe("--");
    });

    it("renders '--' in a practice session", () => {
      const sessionInfo = { ...IRATING_SESSION_INFO, SessionInfo: { Sessions: [{ SessionType: "Practice" }] } };
      const action = makeIratingAction([2, 1, 3], sessionInfo);
      const settings = defaultSettings({ mode: "irating" });
      const telemetry = { SessionNum: 0, CarIdxPosition: [2, 1, 3], CarIdxClass: [100, 100, 100] } as any;

      expect(action["extractDisplayValue"](settings as any, telemetry)).toBe("--");
    });

    it("renders '--' when telemetry is null", () => {
      const action = makeIratingAction([2, 1, 3]);
      const settings = defaultSettings({ mode: "irating" });

      expect(action["extractDisplayValue"](settings as any, null)).toBe("--");
    });
  });

  describe("iratingValueColor", () => {
    it("is green for gains, red for losses, undefined at zero/blank", () => {
      expect(iratingValueColor("+31")).toBe("#2ecc71");
      expect(iratingValueColor("-15")).toBe("#e74c3c");
      expect(iratingValueColor("0")).toBeUndefined();
      expect(iratingValueColor("")).toBeUndefined();
    });

    it("does not color the '--' placeholder (#872)", () => {
      expect(iratingValueColor("--")).toBeUndefined();
    });
  });

  describe("telemetry-aware lifecycle", () => {
    let action: SessionInfo;

    beforeEach(() => {
      action = new SessionInfo();
    });

    it("should subscribe with telemetry callback on onWillAppear", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "incidents" }) as any);

      expect(action["sdkController"].subscribe).toHaveBeenCalledWith("action-1", expect.any(Function));
    });

    it("should clean up all maps on onWillDisappear", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "incidents" }) as any);
      await action.onWillDisappear(fakeEvent("action-1") as any);

      expect(action["sdkController"].unsubscribe).toHaveBeenCalledWith("action-1");
      expect(action["activeContexts"].has("action-1")).toBe(false);
      expect(action["lastState"].has("action-1")).toBe(false);
      expect(action["lastIncidentCount"].has("action-1")).toBe(false);
      expect(action["flashStates"].has("action-1")).toBe(false);
      expect(action["lastFlagKey"].has("action-1")).toBe(false);
    });

    it("should update activeContexts on onDidReceiveSettings", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "incidents" }) as any);
      await action.onDidReceiveSettings(fakeEvent("action-1", { mode: "time-remaining" }) as any);

      expect(action["activeContexts"].get("action-1")?.mode).toBe("time-remaining");
    });

    it("should cancel flash on onDidReceiveSettings", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "incidents" }) as any);

      // Simulate a flash state
      action["flashStates"].set("action-1", true);

      await action.onDidReceiveSettings(fakeEvent("action-1", { mode: "time-remaining" }) as any);

      expect(action["flashStates"].get("action-1")).toBe(false);
    });

    it("should use default settings when settings are invalid", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "invalid" }) as any);

      expect(action["activeContexts"].get("action-1")?.mode).toBe("incidents");
    });

    it("should accept new mode values in settings", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "position" }) as any);

      expect(action["activeContexts"].get("action-1")?.mode).toBe("position");
    });

    it("should parse positionShowTotal setting", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "position", positionShowTotal: true }) as any);

      expect(action["activeContexts"].get("action-1")?.positionShowTotal).toBe(true);
    });

    it("should parse fuelFormat setting", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "fuel", fuelFormat: "percentage" }) as any);

      expect(action["activeContexts"].get("action-1")?.fuelFormat).toBe("percentage");
    });

    it("should parse fuelSubMode setting", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "fuel", fuelSubMode: "lastLap" }) as any);

      expect(action["activeContexts"].get("action-1")?.fuelSubMode).toBe("lastLap");
    });

    it("should default fuelSubMode to now", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "fuel" }) as any);

      expect(action["activeContexts"].get("action-1")?.fuelSubMode).toBe("now");
    });

    it("should parse fuelLapWindow setting from the PI's string value", async () => {
      await action.onWillAppear(
        fakeEvent("action-1", { mode: "fuel", fuelSubMode: "avgN", fuelLapWindow: "10" }) as any,
      );

      expect(action["activeContexts"].get("action-1")?.fuelLapWindow).toBe(10);
    });

    it("should default fuelLapWindow to 5", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "fuel", fuelSubMode: "avgN" }) as any);

      expect(action["activeContexts"].get("action-1")?.fuelLapWindow).toBe(5);
    });

    it("should initialize lastFlagKey for flags mode", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "flags" }) as any);

      expect(action["lastFlagKey"].has("action-1")).toBe(true);
    });

    it("should clean up flag pulse timer on onWillDisappear", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "flags" }) as any);

      // Simulate active pulse
      action["flagPulseTimers"].set(
        "action-1",
        setInterval(() => {}, 10000),
      );

      await action.onWillDisappear(fakeEvent("action-1") as any);

      expect(action["flagPulseTimers"].has("action-1")).toBe(false);
    });

    describe("fuel consumption sub-modes (issue #465)", () => {
      const telemetry = { FuelLevel: 42.3, FuelLevelPct: 0.55, DisplayUnits: 1 } as any;

      // vi.clearAllMocks() only clears call history, not implementations — a
      // mockReturnValue set in one test would otherwise leak into the next.
      beforeEach(() => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: null, avg: null, avgLapTime: null, samples: 0 });
      });

      it("keeps showing the current fuel level in the default 'now' sub-mode", () => {
        const settings = defaultSettings({ mode: "fuel", fuelSubMode: "now" });

        expect(action["extractDisplayValue"](settings as any, telemetry)).toBe("42.3 L");
        expect(getFuelStats).not.toHaveBeenCalled();
      });

      it("formats the last valid lap's consumption in liters", () => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: 2.84, avg: 2.9, avgLapTime: null, samples: 5 });
        const settings = defaultSettings({ mode: "fuel", fuelSubMode: "lastLap" });

        expect(action["extractDisplayValue"](settings as any, telemetry)).toBe("2.84 L");
      });

      it("formats the last lap consumption in gallons under imperial DisplayUnits", () => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: 7.57082, avg: 7.6, avgLapTime: null, samples: 5 });
        const settings = defaultSettings({ mode: "fuel", fuelSubMode: "lastLap" });
        const imperial = { ...telemetry, DisplayUnits: 0 };

        expect(action["extractDisplayValue"](settings as any, imperial)).toBe("2.00 gal");
      });

      it("formats the rolling average and passes the configured window to getFuelStats", () => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: 2.8, avg: 2.53, avgLapTime: null, samples: 10 });
        const settings = defaultSettings({ mode: "fuel", fuelSubMode: "avgN", fuelLapWindow: 10 });

        expect(action["extractDisplayValue"](settings as any, telemetry)).toBe("2.53 L");
        expect(getFuelStats).toHaveBeenCalledWith(10);
      });

      it("formats the rolling average in gallons under imperial DisplayUnits", () => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: 7.6, avg: 7.57082, avgLapTime: null, samples: 5 });
        const settings = defaultSettings({ mode: "fuel", fuelSubMode: "avgN" });
        const imperial = { ...telemetry, DisplayUnits: 0 };

        expect(action["extractDisplayValue"](settings as any, imperial)).toBe("2.00 gal");
      });

      it("shows -- while no valid laps have been recorded", () => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: null, avg: null, avgLapTime: null, samples: 0 });

        expect(
          action["extractDisplayValue"](defaultSettings({ mode: "fuel", fuelSubMode: "lastLap" }) as any, telemetry),
        ).toBe("--");
        expect(
          action["extractDisplayValue"](defaultSettings({ mode: "fuel", fuelSubMode: "avgN" }) as any, telemetry),
        ).toBe("--");
      });

      it("shows -- without telemetry in the consumption sub-modes", () => {
        expect(
          action["extractDisplayValue"](defaultSettings({ mode: "fuel", fuelSubMode: "lastLap" }) as any, null),
        ).toBe("--");
        expect(action["extractDisplayValue"](defaultSettings({ mode: "fuel", fuelSubMode: "avgN" }) as any, null)).toBe(
          "--",
        );
      });

      it("ignores the percentage fuelFormat in the consumption sub-modes", () => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: 2.8, avg: 2.5, avgLapTime: null, samples: 5 });
        const settings = defaultSettings({ mode: "fuel", fuelSubMode: "lastLap", fuelFormat: "percentage" });

        expect(action["extractDisplayValue"](settings as any, telemetry)).toBe("2.80 L");
      });
    });

    describe("laps to empty mode (issue #748)", () => {
      const telemetry = { FuelLevel: 42.3, DisplayUnits: 1 } as any;

      // vi.clearAllMocks() only clears call history, not implementations — a
      // mockReturnValue set in one test would otherwise leak into the next.
      beforeEach(() => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: null, avg: null, avgLapTime: null, samples: 0 });
      });

      it("parses the laps-to-empty mode from settings", async () => {
        await action.onWillAppear(fakeEvent("action-1", { mode: "laps-to-empty" }) as any);

        expect(action["activeContexts"].get("action-1")?.mode).toBe("laps-to-empty");
      });

      it("divides the live fuel level by the rolling average and shows two decimals", () => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: 3.4, avg: 3.4, avgLapTime: null, samples: 5 });
        const settings = defaultSettings({ mode: "laps-to-empty" });

        // 42.3 / 3.4 = 12.4411…
        expect(action["extractDisplayValue"](settings as any, telemetry)).toBe("12.44");
      });

      it("rounds the estimate at the second decimal", () => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: 3, avg: 3, avgLapTime: null, samples: 5 });
        const fuel = { ...telemetry, FuelLevel: 37.338 }; // 37.338 / 3 = 12.446

        expect(action["extractDisplayValue"](defaultSettings({ mode: "laps-to-empty" }) as any, fuel)).toBe("12.45");
      });

      it("passes the configured window through to getFuelStats", () => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: 2.8, avg: 2.5, avgLapTime: null, samples: 10 });
        const settings = defaultSettings({ mode: "laps-to-empty", fuelLapWindow: 10 });

        action["extractDisplayValue"](settings as any, telemetry);

        expect(getFuelStats).toHaveBeenCalledWith(10);
      });

      it("is unit-independent — imperial DisplayUnits shows the same lap count", () => {
        // Both FuelLevel and the average are liters, so the ratio is a lap
        // count with no unit conversion — unlike the consumption sub-modes.
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: 3.4, avg: 3.4, avgLapTime: null, samples: 5 });
        const imperial = { ...telemetry, DisplayUnits: 0 };

        expect(action["extractDisplayValue"](defaultSettings({ mode: "laps-to-empty" }) as any, imperial)).toBe(
          "12.44",
        );
      });

      it("shows -- while no valid laps have been recorded", () => {
        expect(action["extractDisplayValue"](defaultSettings({ mode: "laps-to-empty" }) as any, telemetry)).toBe("--");
      });

      it("shows -- when FuelLevel is unavailable", () => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: 3.4, avg: 3.4, avgLapTime: null, samples: 5 });

        expect(
          action["extractDisplayValue"](defaultSettings({ mode: "laps-to-empty" }) as any, { DisplayUnits: 1 } as any),
        ).toBe("--");
      });

      it("shows -- without telemetry", () => {
        expect(action["extractDisplayValue"](defaultSettings({ mode: "laps-to-empty" }) as any, null)).toBe("--");
      });

      it("re-renders as the live fuel level burns down between lap completions", async () => {
        vi.mocked(getFuelStats).mockReturnValue({ lastLap: 3, avg: 3, avgLapTime: null, samples: 5 });
        action["sdkController"].getCurrentTelemetry = vi.fn().mockReturnValue(null);

        await action.onWillAppear(fakeEvent("action-1", { mode: "laps-to-empty" }) as any);

        const telemetryCallback = action["sdkController"].subscribe.mock.calls[0][1];

        await telemetryCallback({ FuelLevel: 42.3, DisplayUnits: 1 });

        const callsAfterFirst = action["updateKeyImage"].mock.calls.length;
        expect(callsAfterFirst).toBeGreaterThan(0);
        expect(decodeURIComponent(action["updateKeyImage"].mock.calls[callsAfterFirst - 1][1] as string)).toContain(
          "14.10",
        );

        // Same average, less fuel — the state key busts on the live tank level alone.
        await telemetryCallback({ FuelLevel: 39.3, DisplayUnits: 1 });

        const calls = action["updateKeyImage"].mock.calls;
        expect(calls.length).toBeGreaterThan(callsAfterFirst);
        expect(decodeURIComponent(calls[calls.length - 1][1] as string)).toContain("13.10");

        // A refuel raises the estimate immediately — the tank level is live
        // even though the refuel lap itself is excluded from the average.
        await telemetryCallback({ FuelLevel: 60, DisplayUnits: 1 });

        const callsAfterRefuel = action["updateKeyImage"].mock.calls;
        expect(decodeURIComponent(callsAfterRefuel[callsAfterRefuel.length - 1][1] as string)).toContain("20.00");
      });
    });

    describe("flags mode display value", () => {
      it("returns '--' when no telemetry and blankWhenNoFlag is false", () => {
        const action = new SessionInfo();
        const settings = defaultSettings({ mode: "flags", blankWhenNoFlag: false });

        const result = action["extractDisplayValue"](settings as any, null);

        expect(result).toBe("--");
      });

      it("returns '' when no telemetry and blankWhenNoFlag is true", () => {
        const action = new SessionInfo();
        const settings = defaultSettings({ mode: "flags", blankWhenNoFlag: true });

        const result = action["extractDisplayValue"](settings as any, null);

        expect(result).toBe("");
      });

      it("returns '--' when telemetry has no active flag and blankWhenNoFlag is false", () => {
        const action = new SessionInfo();
        const settings = defaultSettings({ mode: "flags", blankWhenNoFlag: false });
        const telemetry = { SessionFlags: 0 } as any;

        const result = action["extractDisplayValue"](settings as any, telemetry);

        expect(result).toBe("--");
      });

      it("returns '' when telemetry has no active flag and blankWhenNoFlag is true", () => {
        const action = new SessionInfo();
        const settings = defaultSettings({ mode: "flags", blankWhenNoFlag: true });
        const telemetry = { SessionFlags: 0 } as any;

        const result = action["extractDisplayValue"](settings as any, telemetry);

        expect(result).toBe("");
      });

      it("returns the flag label when a flag is active regardless of blankWhenNoFlag", () => {
        const action = new SessionInfo();
        const telemetry = { SessionFlags: 0x00000004 } as any; // Green

        const blankFalse = action["extractDisplayValue"](
          defaultSettings({ mode: "flags", blankWhenNoFlag: false }) as any,
          telemetry,
        );
        const blankTrue = action["extractDisplayValue"](
          defaultSettings({ mode: "flags", blankWhenNoFlag: true }) as any,
          telemetry,
        );

        expect(blankFalse).toBe("GREEN");
        expect(blankTrue).toBe("GREEN");
      });
    });

    it("should cancel flag pulse on onDidReceiveSettings", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "flags" }) as any);

      // Simulate active pulse
      const timer = setInterval(() => {}, 10000);
      action["flagPulseTimers"].set("action-1", timer);

      await action.onDidReceiveSettings(fakeEvent("action-1", { mode: "incidents" }) as any);

      expect(action["flagPulseTimers"].has("action-1")).toBe(false);
      clearInterval(timer);
    });

    describe("position mode display", () => {
      // Multi-class field: player (CarIdx 0) is in class 10 with one class-mate;
      // class 20 has three cars. Class-10 active = 2, overall active = 5.
      const multiClassDrivers = [
        { CarIdx: 0, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 },
        { CarIdx: 1, CarClassID: 10, CarIsPaceCar: 0, IsSpectator: 0 },
        { CarIdx: 2, CarClassID: 20, CarIsPaceCar: 0, IsSpectator: 0 },
        { CarIdx: 3, CarClassID: 20, CarIsPaceCar: 0, IsSpectator: 0 },
        { CarIdx: 4, CarClassID: 20, CarIsPaceCar: 0, IsSpectator: 0 },
      ];

      function makeRaceSessionInfo(driverCarIdx: number, drivers?: unknown[]) {
        return {
          SessionInfo: { Sessions: [{ SessionType: "Race" }] },
          DriverInfo: { DriverCarIdx: driverCarIdx, ...(drivers ? { Drivers: drivers } : {}) },
        };
      }

      function makePracticeSessionInfo(driverCarIdx: number, drivers?: unknown[]) {
        return {
          SessionInfo: { Sessions: [{ SessionType: "Practice" }] },
          DriverInfo: { DriverCarIdx: driverCarIdx, ...(drivers ? { Drivers: drivers } : {}) },
        };
      }

      /**
       * Helper: start with null telemetry so initial state is "P-", then fire the
       * subscribe callback with real telemetry to trigger a state change and an
       * updateKeyImage call. Returns the decoded SVG of the last update.
       */
      async function triggerPositionUpdate(
        sessionInfo: unknown,
        telemetry: Record<string, unknown>,
        settings: Record<string, unknown> = { mode: "position" },
      ): Promise<string> {
        action["sdkController"].getCurrentTelemetry = vi.fn().mockReturnValue(null);
        action["sdkController"].getSessionInfo = vi.fn().mockReturnValue(sessionInfo);

        await action.onWillAppear(fakeEvent("action-1", settings) as any);

        action["sdkController"].getCurrentTelemetry = vi.fn().mockReturnValue(telemetry);

        const subscribeCall = action["sdkController"].subscribe.mock.calls[0];
        const telemetryCallback = subscribeCall[1];

        await telemetryCallback(telemetry);

        const calls = action["updateKeyImage"].mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        const lastCall = calls[calls.length - 1];

        return decodeURIComponent(lastCall[1] as string);
      }

      it("should default to class position (no positionType setting)", async () => {
        // Live class (2) diverges from official PlayerCarClassPosition (9) so the
        // assertion proves the live value is used, not the telemetry fallback.
        vi.mocked(getLivePosition).mockReturnValue({ position: 5, classPosition: 2, isMultiClass: true });
        const telemetry = { SessionNum: 0, OnPitRoad: false, PlayerCarPosition: 5, PlayerCarClassPosition: 9 };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, { mode: "position" });

        // Class is the default → live class position (2), not overall (5) or official class (9).
        expect(decoded).toContain("P2");
        expect(decoded).not.toContain("P5");
        expect(decoded).not.toContain("P9");
      });

      it("should show class position from getLivePosition when positionType is class (race, on track)", async () => {
        // Live class (2) diverges from official PlayerCarClassPosition (9).
        vi.mocked(getLivePosition).mockReturnValue({ position: 5, classPosition: 2, isMultiClass: true });
        const telemetry = { SessionNum: 0, OnPitRoad: false, PlayerCarPosition: 5, PlayerCarClassPosition: 9 };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "class",
        });

        expect(decoded).toContain("P2");
        expect(decoded).not.toContain("P5");
        expect(decoded).not.toContain("P9");
      });

      it("should show frozen overall position from getLivePosition when positionType is overall (race, on track)", async () => {
        vi.mocked(getLivePosition).mockReturnValue({ position: 5, classPosition: 2, isMultiClass: true });
        const telemetry = { SessionNum: 0, OnPitRoad: false, PlayerCarPosition: 9, PlayerCarClassPosition: 2 };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "overall",
        });

        // Uses getLivePosition().position (5), not the raw PlayerCarPosition (9).
        expect(decoded).toContain("P5");
        expect(decoded).not.toContain("P9");
      });

      // Pre-green tests use three DISTINCT values per axis so each assertion
      // pins exactly one source: live (getLivePosition, 5/2), grid
      // (getStartingGridPosition, 7/4), and official live-standings telemetry
      // (PlayerCarPosition 9). On a real rolling start the official field reads
      // 0 the whole formation lap (issue #647) — the grid resolver is the only
      // usable source pre-green.
      it("should show the qualifying grid slot from the grid resolver for class position before the green flag", async () => {
        vi.mocked(getLivePosition).mockReturnValue({ position: 5, classPosition: 2, isMultiClass: true });
        vi.mocked(getStartingGridPosition).mockReturnValue({ overall: 7, class: 4 });
        const telemetry = {
          SessionNum: 0,
          OnPitRoad: false,
          SessionState: SessionState.ParadeLaps,
          PlayerCarPosition: 9,
          PlayerCarClassPosition: 9,
        };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "class",
        });

        // Grid class slot (4) — not live class (2), not official (9).
        expect(decoded).toContain("P4");
        expect(decoded).not.toContain("P2");
        expect(decoded).not.toContain("P9");
      });

      it("should show the qualifying grid slot from the grid resolver for overall position before the green flag", async () => {
        vi.mocked(getLivePosition).mockReturnValue({ position: 5, classPosition: 2, isMultiClass: true });
        vi.mocked(getStartingGridPosition).mockReturnValue({ overall: 7, class: 4 });
        const telemetry = {
          SessionNum: 0,
          OnPitRoad: false,
          SessionState: SessionState.ParadeLaps,
          PlayerCarPosition: 9,
          PlayerCarClassPosition: 9,
        };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "overall",
        });

        // Grid overall slot (7) — not live overall (5), not official (9).
        expect(decoded).toContain("P7");
        expect(decoded).not.toContain("P5");
        expect(decoded).not.toContain("P9");
      });

      it("should fall back to official telemetry pre-green when the grid slot can't be resolved", async () => {
        // No qualifying results → getStartingGridPosition returns null → use the
        // live-standings PlayerCarPosition rather than a churning live order.
        vi.mocked(getLivePosition).mockReturnValue({ position: 5, classPosition: 2, isMultiClass: true });
        vi.mocked(getStartingGridPosition).mockReturnValue(null);
        const telemetry = {
          SessionNum: 0,
          OnPitRoad: false,
          SessionState: SessionState.ParadeLaps,
          PlayerCarPosition: 9,
          PlayerCarClassPosition: 9,
        };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "overall",
        });

        // Grid unavailable → official telemetry (9), NOT the live order (5).
        expect(decoded).toContain("P9");
        expect(decoded).not.toContain("P5");
      });

      it("should hold the grid slot after green until the player crosses S/F (LapCompleted < 0)", async () => {
        // Green is out (SessionState.Racing) but the player is still on the run
        // to the line (LapCompleted = -1, the out-lap sentinel). The live order
        // churns through the bunched start, so keep showing the grid slot until
        // the player crosses S/F (issue #647).
        vi.mocked(getLivePosition).mockReturnValue({ position: 5, classPosition: 2, isMultiClass: true });
        vi.mocked(getStartingGridPosition).mockReturnValue({ overall: 7, class: 4 });
        const telemetry = {
          SessionNum: 0,
          OnPitRoad: false,
          SessionState: SessionState.Racing,
          LapCompleted: -1,
          PlayerCarPosition: 9,
          PlayerCarClassPosition: 9,
        };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "overall",
        });

        // Still on the formation/out lap → grid slot (7), NOT the churning live
        // order (5) or the live-standings official (9).
        expect(decoded).toContain("P7");
        expect(decoded).not.toContain("P5");
        expect(decoded).not.toContain("P9");
      });

      it("should resume the live calculated order once the player has started racing (LapCompleted >= 0)", async () => {
        // Distinguishing: grid (7) differs from live (5), so a gate that kept
        // showing the grid past the first S/F crossing would show P7 and fail here.
        vi.mocked(getLivePosition).mockReturnValue({ position: 5, classPosition: 2, isMultiClass: true });
        vi.mocked(getStartingGridPosition).mockReturnValue({ overall: 7, class: 4 });
        const telemetry = {
          SessionNum: 0,
          OnPitRoad: false,
          SessionState: SessionState.Racing,
          LapCompleted: 1,
          PlayerCarPosition: 9,
          PlayerCarClassPosition: 9,
        };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "overall",
        });

        // Racing under way → live order (5), NOT the grid slot (7) or official (9).
        expect(decoded).toContain("P5");
        expect(decoded).not.toContain("P7");
        expect(decoded).not.toContain("P9");
      });

      it("should use the live calculated order when SessionState is omitted (back-compat)", async () => {
        // Undefined SessionState must not be treated as pre-green: the existing
        // race-on-track behavior (getLivePosition) is preserved — grid (7) is NOT used.
        vi.mocked(getLivePosition).mockReturnValue({ position: 5, classPosition: 2, isMultiClass: true });
        vi.mocked(getStartingGridPosition).mockReturnValue({ overall: 7, class: 4 });
        const telemetry = { SessionNum: 0, OnPitRoad: false, PlayerCarPosition: 9, PlayerCarClassPosition: 9 };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "overall",
        });

        expect(decoded).toContain("P5");
        expect(decoded).not.toContain("P7");
        expect(decoded).not.toContain("P9");
      });

      it("should append the class field size for class position with Show Total", async () => {
        vi.mocked(getLivePosition).mockReturnValue({ position: 4, classPosition: 1, isMultiClass: true });
        const telemetry = { SessionNum: 0, OnPitRoad: false, PlayerCarPosition: 4, PlayerCarClassPosition: 1 };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0, multiClassDrivers), telemetry, {
          mode: "position",
          positionType: "class",
          positionShowTotal: true,
        });

        // Class 10 has 2 active cars.
        expect(decoded).toContain("P1/2");
      });

      it("should append the overall field size for overall position with Show Total", async () => {
        vi.mocked(getLivePosition).mockReturnValue({ position: 4, classPosition: 1, isMultiClass: true });
        const telemetry = { SessionNum: 0, OnPitRoad: false, PlayerCarPosition: 4, PlayerCarClassPosition: 1 };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0, multiClassDrivers), telemetry, {
          mode: "position",
          positionType: "overall",
          positionShowTotal: true,
        });

        // 5 active cars overall.
        expect(decoded).toContain("P4/5");
      });

      it("should use PlayerCarClassPosition for class position when on pit road (ignores getLivePosition)", async () => {
        // getLivePosition would say class 9, but the pit branch reads official telemetry.
        vi.mocked(getLivePosition).mockReturnValue({ position: 9, classPosition: 9, isMultiClass: true });
        const telemetry = { SessionNum: 0, OnPitRoad: true, PlayerCarPosition: 2, PlayerCarClassPosition: 3 };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "class",
        });

        expect(decoded).toContain("P3");
      });

      it("should use PlayerCarPosition for overall position when on pit road", async () => {
        vi.mocked(getLivePosition).mockReturnValue({ position: 9, classPosition: 9, isMultiClass: true });
        const telemetry = { SessionNum: 0, OnPitRoad: true, PlayerCarPosition: 2, PlayerCarClassPosition: 3 };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "overall",
        });

        expect(decoded).toContain("P2");
      });

      it("should use PlayerCarClassPosition for class position in a non-race session", async () => {
        // getLivePosition is on-track lap order, not standings → not used outside races.
        vi.mocked(getLivePosition).mockReturnValue({ position: 9, classPosition: 9, isMultiClass: true });
        const telemetry = { SessionNum: 0, OnPitRoad: false, PlayerCarPosition: 6, PlayerCarClassPosition: 4 };

        const decoded = await triggerPositionUpdate(makePracticeSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "class",
        });

        expect(decoded).toContain("P4");
      });

      it("should use PlayerCarPosition for overall position in a non-race session", async () => {
        const telemetry = { SessionNum: 0, OnPitRoad: false, PlayerCarPosition: 2, PlayerCarClassPosition: 4 };

        const decoded = await triggerPositionUpdate(makePracticeSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "overall",
        });

        expect(decoded).toContain("P2");
      });

      it("should fall back to official telemetry when getLivePosition returns null (race, on track)", async () => {
        vi.mocked(getLivePosition).mockReturnValue(null);
        const telemetry = { SessionNum: 0, OnPitRoad: false, PlayerCarPosition: 3, PlayerCarClassPosition: 6 };

        const classDecoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "class",
        });

        expect(classDecoded).toContain("P6");
      });

      it("should fall back to PlayerCarClassPosition when getLivePosition class position is 0", async () => {
        vi.mocked(getLivePosition).mockReturnValue({ position: 5, classPosition: 0, isMultiClass: true });
        const telemetry = { SessionNum: 0, OnPitRoad: false, PlayerCarPosition: 5, PlayerCarClassPosition: 7 };

        const decoded = await triggerPositionUpdate(makeRaceSessionInfo(0), telemetry, {
          mode: "position",
          positionType: "class",
        });

        expect(decoded).toContain("P7");
      });

      it("should fall back to PlayerCarPosition for overall when session info is null", async () => {
        // No session info → isRaceSession false → official PlayerCarPosition.
        const telemetry = { SessionNum: 0, PlayerCarPosition: 3, PlayerCarClassPosition: 8 };

        const decoded = await triggerPositionUpdate(null, telemetry, { mode: "position", positionType: "overall" });

        expect(decoded).toContain("P3");
      });

      it("should render P-/- placeholder with Show Total and no telemetry", async () => {
        action["sdkController"].getCurrentTelemetry = vi.fn().mockReturnValue(null);
        action["sdkController"].getSessionInfo = vi.fn().mockReturnValue(null);

        await action.onWillAppear(
          fakeEvent("action-1", { mode: "position", positionType: "class", positionShowTotal: true }) as any,
        );

        const calls = action["setKeyImage"].mock.calls;
        const lastCall = calls[calls.length - 1];
        const decoded = decodeURIComponent(lastCall[1] as string);

        expect(decoded).toContain("P-/-");
      });
    });
  });
});

describe("gaps mode (issue #933)", () => {
  function gaps(
    ahead: { gapSeconds: number | null; lapDelta?: number; trend?: "closing" | "opening" | "steady" | null } | null,
    behind: { gapSeconds: number | null; lapDelta?: number; trend?: "closing" | "opening" | "steady" | null } | null,
  ): LiveGaps {
    return {
      ahead: ahead
        ? { carIdx: 3, gapSeconds: ahead.gapSeconds, lapDelta: ahead.lapDelta ?? 0, trend: ahead.trend ?? null }
        : null,
      behind: behind
        ? { carIdx: 5, gapSeconds: behind.gapSeconds, lapDelta: behind.lapDelta ?? 0, trend: behind.trend ?? null }
        : null,
    };
  }

  describe("formatGapValue", () => {
    it("formats the value table", () => {
      expect(formatGapValue(null)).toBe("–");
      expect(formatGapValue({ carIdx: 3, gapSeconds: null, lapDelta: 0, trend: null })).toBe("–");
      expect(formatGapValue({ carIdx: 3, gapSeconds: 1.23, lapDelta: 0, trend: null })).toBe("1.2");
      expect(formatGapValue({ carIdx: 3, gapSeconds: null, lapDelta: 2, trend: null })).toBe("2L");
      expect(formatGapValue({ carIdx: 3, gapSeconds: 101.7, lapDelta: 0, trend: null })).toBe("102");
    });
  });

  describe("generateGapsGraphic", () => {
    it("renders two trend-colored rows when both sides are on", () => {
      const svg = generateGapsGraphic(
        gaps({ gapSeconds: 1.2, trend: "closing" }, { gapSeconds: 3.5, trend: "closing" }),
        true,
        true,
        undefined,
        "#ffffff",
      );

      // Ahead closing = favorable green; behind closing = unfavorable red.
      expect(svg).toContain(">1.2</text>");
      expect(svg).toContain(">3.5</text>");
      expect(svg).toContain("#2ecc71");
      expect(svg).toContain("#e74c3c");
      expect((svg.match(/<polygon/g) ?? []).length).toBe(2);
    });

    it("renders one full-size row when only one side is on", () => {
      const svg = generateGapsGraphic(gaps({ gapSeconds: 1.2 }, null), true, false, undefined, "#ffffff");

      expect((svg.match(/<text/g) ?? []).length).toBe(1);
      expect(svg).toContain('font-size="28"');
    });

    it("uses the theme text color for steady/unknown trends and placeholders", () => {
      const svg = generateGapsGraphic(
        gaps({ gapSeconds: 1.2, trend: "steady" }, null),
        true,
        true,
        undefined,
        "#ffffff",
      );

      expect(svg).not.toContain("#2ecc71");
      expect(svg).not.toContain("#e74c3c");
      expect(svg).toContain("–");
    });

    it("returns empty when both rows are disabled", () => {
      expect(generateGapsGraphic(null, false, false, undefined, "#ffffff")).toBe("");
    });
  });

  describe("generateSessionInfoSvg gaps routing", () => {
    it("blanks the value slot and carries the display in graphicContent", () => {
      const result = generateSessionInfoSvg(
        defaultSettings({ mode: "gaps" }),
        "1.2:closing|3.5:steady",
        false,
        undefined,
        { gaps: gaps({ gapSeconds: 1.2, trend: "closing" }, { gapSeconds: 3.5, trend: "steady" }) },
      );
      const decoded = decodeURIComponent(result);

      // The state-key string must never render; the rows carry the values.
      expect(decoded).not.toContain("1.2:closing");
      expect(decoded).toContain("polygon");
    });
  });

  describe("resolveWindDisplay", () => {
    /** Telemetry shaped like the issue #947 captures. */
    function windTelemetry(overrides: Record<string, unknown> = {}) {
      return { WindDir: 0, WindVel: 3, YawNorth: 0, IsOnTrack: true, ...overrides } as never;
    }

    it("returns the pushed-toward angle and speed in relative mode", () => {
      // Wind out of the north onto a north-pointing car: a headwind, so the
      // arrow points back down the car (180°), and 3 m/s is 11 km/h.
      const display = resolveWindDisplay(defaultSettings({ mode: "wind" }), windTelemetry());

      expect(display).toEqual({ arrowDeg: 180, label: "11 km/h" });
    });

    it("reads a tailwind as an arrow pointing forward", () => {
      const display = resolveWindDisplay(defaultSettings({ mode: "wind" }), windTelemetry({ WindDir: Math.PI }));

      expect(display?.arrowDeg).toBe(0);
    });

    it("points the arrow left when the wind comes from the right", () => {
      // Wind from the east onto a north-pointing car pushes it west (left).
      const display = resolveWindDisplay(defaultSettings({ mode: "wind" }), windTelemetry({ WindDir: Math.PI / 2 }));

      expect(display?.arrowDeg).toBe(270);
    });

    it("blanks relative mode when the player is not in the car", () => {
      // YawNorth reads a flat 0 out of the car, which would otherwise render a
      // confident arrow computed from a heading of due north.
      expect(resolveWindDisplay(defaultSettings({ mode: "wind" }), windTelemetry({ IsOnTrack: false }))).toBeNull();
    });

    it("names the source direction and points where the wind travels in absolute mode", () => {
      const display = resolveWindDisplay(
        defaultSettings({ mode: "wind", windDirectionMode: "absolute" }),
        windTelemetry({ WindDir: Math.PI / 2 }),
      );

      // An east wind is labelled "E" (where it comes from) with the arrow
      // pointing west (where it goes) — the pairing iRacing's panel uses.
      expect(display).toEqual({ arrowDeg: 270, label: "E 11 km/h" });
    });

    it("keeps working out of the car in absolute mode", () => {
      const display = resolveWindDisplay(
        defaultSettings({ mode: "wind", windDirectionMode: "absolute" }),
        windTelemetry({ IsOnTrack: false, YawNorth: 0 }),
      );

      expect(display?.label).toBe("N 11 km/h");
    });

    it("honors the speed unit", () => {
      const settings = (unit: "ms" | "kmh" | "mph") => defaultSettings({ mode: "wind", windSpeedUnit: unit });

      expect(resolveWindDisplay(settings("ms"), windTelemetry())?.label).toBe("3.0 m/s");
      expect(resolveWindDisplay(settings("kmh"), windTelemetry())?.label).toBe("11 km/h");
      expect(resolveWindDisplay(settings("mph"), windTelemetry())?.label).toBe("7 mph");
    });

    it("quantizes the arrow so a turning car does not re-render every tick", () => {
      const nudge = ((WIND_ARROW_STEP_DEG / 3) * Math.PI) / 180;
      const a = resolveWindDisplay(defaultSettings({ mode: "wind" }), windTelemetry());
      const b = resolveWindDisplay(defaultSettings({ mode: "wind" }), windTelemetry({ YawNorth: nudge }));

      expect(a?.arrowDeg).toBe(b?.arrowDeg);
    });

    it("always reports an arrow angle within [0, 360)", () => {
      for (let deg = 0; deg < 360; deg += 11) {
        const display = resolveWindDisplay(
          defaultSettings({ mode: "wind" }),
          windTelemetry({ WindDir: (deg * Math.PI) / 180 }),
        );

        expect(display!.arrowDeg).toBeGreaterThanOrEqual(0);
        expect(display!.arrowDeg).toBeLessThan(360);
      }
    });

    it.each([
      ["telemetry is null", null],
      ["wind speed is missing", { WindDir: 0, YawNorth: 0, IsOnTrack: true }],
      ["wind direction is missing", { WindVel: 3, YawNorth: 0, IsOnTrack: true }],
      ["yaw is missing", { WindDir: 0, WindVel: 3, IsOnTrack: true }],
    ])("returns null when %s", (_label, telemetry) => {
      expect(resolveWindDisplay(defaultSettings({ mode: "wind" }), telemetry as never)).toBeNull();
    });
  });

  describe("generateWindGraphic", () => {
    it("draws a rotated arrow and the label", () => {
      const svg = generateWindGraphic({ arrowDeg: 135, label: "11 km/h" }, undefined, "#ffffff");

      expect(svg).toContain("<polygon");
      expect(svg).toContain("rotate(135 72 46)");
      expect(svg).toContain(">11 km/h</text>");
    });

    it("rotates to any angle rather than snapping to fixed states", () => {
      const angles = [0, 5, 95, 180, 355];
      const rendered = angles.map((deg) => generateWindGraphic({ arrowDeg: deg, label: "5 m/s" }, undefined, "#fff"));

      expect(new Set(rendered).size).toBe(angles.length);

      for (const deg of angles) {
        expect(generateWindGraphic({ arrowDeg: deg, label: "5 m/s" }, undefined, "#fff")).toContain(`rotate(${deg} `);
      }
    });

    it("shrinks the label so a long absolute-mode reading still fits", () => {
      const short = generateWindGraphic({ arrowDeg: 0, label: "9 mph" }, undefined, "#fff");
      const long = generateWindGraphic({ arrowDeg: 0, label: "NNE 11 km/h" }, undefined, "#fff");
      const sizeOf = (svg: string) => Number(/font-size="(\d+)"/.exec(svg)![1]);

      expect(sizeOf(long)).toBeLessThan(sizeOf(short));
    });

    it("renders a placeholder and no arrow when wind data is unavailable", () => {
      const svg = generateWindGraphic(null, undefined, "#ffffff");

      expect(svg).not.toContain("<polygon");
      expect(svg).toContain(">--</text>");
    });

    it("uses the resolved text color for both the arrow and the label", () => {
      const svg = generateWindGraphic({ arrowDeg: 0, label: "11 km/h" }, undefined, "#ff0000");

      expect((svg.match(/#ff0000/g) ?? []).length).toBe(2);
    });
  });

  describe("generateSessionInfoSvg wind routing", () => {
    it("blanks the value slot and carries the display in graphicContent", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "wind" }), "180|11 km/h", false, undefined, {
        wind: { arrowDeg: 180, label: "11 km/h" },
      });
      const decoded = decodeURIComponent(result);

      // The state-key string must never render; the graphic carries the value.
      expect(decoded).not.toContain("180|11 km/h");
      expect(decoded).toContain("<polygon");
      expect(decoded).toContain(">11 km/h</text>");
    });

    it("titles the key WIND", () => {
      const decoded = decodeURIComponent(
        generateSessionInfoSvg(defaultSettings({ mode: "wind" }), "--", false, undefined, { wind: null }),
      );

      expect(decoded).toContain("WIND");
    });
  });

  describe("live display integration", () => {
    let action: SessionInfo;

    beforeEach(() => {
      action = new SessionInfo();
    });

    it("renders live gap rows from getLiveGaps via the telemetry subscription", async () => {
      // Appear with no gap data (placeholder rows), THEN provide live gaps so
      // the state-key cache sees a change and re-renders.
      vi.mocked(getLiveGaps).mockReturnValue(null);

      action["sdkController"].getCurrentTelemetry = vi.fn().mockReturnValue(null);
      action["sdkController"].getSessionInfo = vi.fn().mockReturnValue(null);

      await action.onWillAppear(fakeEvent("gap-action", { mode: "gaps" }) as never);

      vi.mocked(getLiveGaps).mockReturnValue(
        gaps({ gapSeconds: 1.8, trend: "closing" }, { gapSeconds: 2.4, trend: "opening" }),
      );

      const telemetry = { SessionNum: 0 };
      const subscribeCall = (action["sdkController"].subscribe as ReturnType<typeof vi.fn>).mock.calls[0];
      const telemetryCallback = subscribeCall[1];

      await telemetryCallback(telemetry);

      const calls = (action["updateKeyImage"] as ReturnType<typeof vi.fn>).mock.calls;

      expect(calls.length).toBeGreaterThan(0);
      const decoded = decodeURIComponent(calls[calls.length - 1][1] as string);

      expect(decoded).toContain(">1.8</text>");
      expect(decoded).toContain(">2.4</text>");
      // Both rows favorable (ahead closing / behind opening) render green.
      expect(decoded).toContain("#2ecc71");
      expect(decoded).not.toContain("#e74c3c");
    });
  });
});
