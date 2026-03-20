import { FLAG_DEFINITIONS, resolveActiveFlag } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  countActiveDrivers,
  formatFuelAmount,
  formatSessionTime,
  generateSessionInfoSvg,
  SessionInfo,
} from "./session-info.js";

vi.mock("@iracedeck/iracing-sdk", async () => {
  const actual = await vi.importActual<typeof import("@iracedeck/iracing-sdk")>("@iracedeck/iracing-sdk");

  return actual;
});

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: () => {
      const defaults = { mode: "incidents", positionShowTotal: false, fuelFormat: "amount" };
      const validModes = ["incidents", "time-remaining", "laps", "position", "fuel", "flags"];
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...defaults, ...data }),
        safeParse: (data: Record<string, unknown>) => {
          if (data?.mode && !validModes.includes(data.mode as string)) {
            return { success: false, error: new Error("Invalid mode") };
          }

          return { success: true, data: { ...defaults, ...data } };
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
  getGlobalColors: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.backgroundColor || ""}|${data.titleLabel || ""}|${data.value || ""}|${data.valueFontSize || ""}|${data.valueY || ""}|${data.textColor || ""}</svg>`;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

/** Default settings factory for tests */
function defaultSettings(
  overrides: Partial<{
    mode: "incidents" | "time-remaining" | "laps" | "position" | "fuel" | "flags";
    positionShowTotal: boolean;
    fuelFormat: "amount" | "percentage";
  }> = {},
) {
  return { mode: "incidents" as const, positionShowTotal: false, fuelFormat: "amount" as const, ...overrides };
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

    it("should use font size 48 for incidents mode (144x144)", () => {
      const result = generateSessionInfoSvg(defaultSettings(), "0x", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("48");
    });

    it("should use font size 36 for short time values (144x144)", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "time-remaining" }), "12:34", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("36");
    });

    it("should use font size 28 for long time values (144x144)", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "time-remaining" }), "1:23:45", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("28");
    });

    it("should use font size 36 for UNLIM (144x144)", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "time-remaining" }), "UNLIM", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("36");
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

    it("should use font size 36 for short lap values (144x144)", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "laps" }), "5/20", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("36");
    });

    it("should use font size 28 for long lap values (144x144)", () => {
      const result = generateSessionInfoSvg(defaultSettings({ mode: "laps" }), "100/200", false);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("28");
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

    it("should cancel flag pulse on onDidReceiveSettings", async () => {
      await action.onWillAppear(fakeEvent("action-1", { mode: "flags" }) as any);

      // Simulate active pulse
      const timer = setInterval(() => {}, 10000);
      action["flagPulseTimers"].set("action-1", timer);

      await action.onDidReceiveSettings(fakeEvent("action-1", { mode: "incidents" }) as any);

      expect(action["flagPulseTimers"].has("action-1")).toBe(false);
      clearInterval(timer);
    });
  });
});
