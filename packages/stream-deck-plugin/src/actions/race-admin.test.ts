import {
  buildTemplateContext,
  getAllCarNumbers,
  getCarNumberFromSessionInfo,
  resolveTemplate,
} from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAdminCommand, findAdjacentCarByNumber, resolveDriverTarget } from "./race-admin-commands.js";
import { getModesByOptgroup, RACE_ADMIN_MODE_META, RACE_ADMIN_MODES } from "./race-admin-modes.js";
import { generateRaceAdminSvg } from "./race-admin.js";

// Mock SDK
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

// Mock iracing-sdk
vi.mock("@iracedeck/iracing-sdk", () => ({
  getCarNumberFromSessionInfo: vi.fn(),
  getAllCarNumbers: vi.fn(() => []),
  buildTemplateContext: vi.fn(() => ({})),
  resolveTemplate: vi.fn((template: string) => template),
}));

// Mock all icon imports
// Mock all icon imports — must use inline strings (vi.mock is hoisted, can't reference outer variables)
vi.mock("@iracedeck/icons/race-admin/yellow.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/black-flag.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/dq-driver.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/show-dqs-field.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/show-dqs-driver.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/clear-penalties.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/clear-all.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/wave-around.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/eol.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/pit-close.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/pit-open.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/pace-laps.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/single-file-restart.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/double-file-restart.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/advance-session.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/grid-set.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/grid-start.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/track-state.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/grant-admin.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/revoke-admin.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/remove-driver.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/enable-chat-all.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/enable-chat-driver.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/disable-chat-all.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/disable-chat-driver.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/message-all.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/rc-message.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/next-car-number.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/race-admin/prev-car-number.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));

// Mock shared utilities
vi.mock("../shared/index.js", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
      };

      return schema;
    },
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getCurrentTelemetry: vi.fn(() => null),
      getSessionInfo: vi.fn(() => null),
    };
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
    chat: { sendMessage: vi.fn(() => true) },
    camera: { switchNum: vi.fn(() => true) },
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

describe("RaceAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Mode Definitions ────────────────────────────────────────

  describe("RACE_ADMIN_MODES", () => {
    it("should have 29 modes", () => {
      expect(RACE_ADMIN_MODES).toHaveLength(29);
    });

    it("should have metadata for every mode", () => {
      for (const mode of RACE_ADMIN_MODES) {
        expect(RACE_ADMIN_MODE_META[mode]).toBeDefined();
        expect(RACE_ADMIN_MODE_META[mode].displayName).toBeTruthy();
        expect(RACE_ADMIN_MODE_META[mode].mainLabel).toBeTruthy();
        expect(RACE_ADMIN_MODE_META[mode].subLabel).toBeTruthy();
        expect(RACE_ADMIN_MODE_META[mode].optgroup).toBeTruthy();
      }
    });

    it("should have 4 optgroups", () => {
      const groups = getModesByOptgroup();
      expect(groups.size).toBe(4);
      expect(groups.has("Race Control")).toBe(true);
      expect(groups.has("Session Management")).toBe(true);
      expect(groups.has("Driver & Chat Management")).toBe(true);
      expect(groups.has("Car Navigation")).toBe(true);
    });

    it("should have correct mode counts per optgroup", () => {
      const groups = getModesByOptgroup();
      expect(groups.get("Race Control")).toHaveLength(14);
      expect(groups.get("Session Management")).toHaveLength(4);
      expect(groups.get("Driver & Chat Management")).toHaveLength(9);
      expect(groups.get("Car Navigation")).toHaveLength(2);
    });
  });

  // ── Driver Targeting ────────────────────────────────────────

  describe("resolveDriverTarget", () => {
    const baseSettings = {
      mode: "black-flag" as const,
      useViewedCar: true,
      carNumber: "",
      message: "",
      penaltyType: "time",
      penaltyValue: "30",
      paceLapsOperation: "+",
      paceLapsValue: "1",
      gridSetMinutes: "5",
      trackStatePercent: "50",
    };

    it("should return viewed car number when useViewedCar is true", () => {
      const meta = RACE_ADMIN_MODE_META["black-flag"];
      const result = resolveDriverTarget({ ...baseSettings, useViewedCar: true }, "42", meta);
      expect(result).toBe("42");
    });

    it("should return null when useViewedCar is true but no viewed car", () => {
      const meta = RACE_ADMIN_MODE_META["black-flag"];
      const result = resolveDriverTarget({ ...baseSettings, useViewedCar: true }, null, meta);
      expect(result).toBeNull();
    });

    it("should return pre-defined car number when useViewedCar is false", () => {
      const meta = RACE_ADMIN_MODE_META["black-flag"];
      const result = resolveDriverTarget({ ...baseSettings, useViewedCar: false, carNumber: "7" }, null, meta);
      expect(result).toBe("7");
    });

    it("should return null when useViewedCar is false and carNumber is empty", () => {
      const meta = RACE_ADMIN_MODE_META["black-flag"];
      const result = resolveDriverTarget({ ...baseSettings, useViewedCar: false, carNumber: "" }, null, meta);
      expect(result).toBeNull();
    });

    it("should return null for modes that do not need a driver", () => {
      const meta = RACE_ADMIN_MODE_META["yellow"];
      const result = resolveDriverTarget(baseSettings, "42", meta);
      expect(result).toBeNull();
    });
  });

  // ── Command Building ────────────────────────────────────────

  describe("buildAdminCommand", () => {
    const mockSdkController = {} as unknown;
    const baseSettings = {
      mode: "yellow" as const,
      useViewedCar: true,
      carNumber: "",
      message: "",
      penaltyType: "time",
      penaltyValue: "30",
      paceLapsOperation: "+",
      paceLapsValue: "1",
      gridSetMinutes: "5",
      trackStatePercent: "50",
    };

    it("should build simple parameterless commands", () => {
      expect(buildAdminCommand("clear-all", baseSettings, null, mockSdkController as never)).toBe("!clearall");
      expect(buildAdminCommand("pit-close", baseSettings, null, mockSdkController as never)).toBe("!pitclose");
      expect(buildAdminCommand("pit-open", baseSettings, null, mockSdkController as never)).toBe("!pitopen");
      expect(buildAdminCommand("grid-start", baseSettings, null, mockSdkController as never)).toBe("!gridstart");
    });

    it("should build commands with message", () => {
      const settings = { ...baseSettings, message: "Caution for incident" };
      const result = buildAdminCommand("yellow", settings, null, mockSdkController as never);
      expect(result).toBe("!yellow Caution for incident");
    });

    it("should build commands with driver target (viewed car)", () => {
      const result = buildAdminCommand("dq-driver", baseSettings, "42", mockSdkController as never);
      expect(result).toBe("!dq #42");
    });

    it("should build commands with driver target (pre-defined)", () => {
      const settings = { ...baseSettings, useViewedCar: false, carNumber: "7" };
      const result = buildAdminCommand("dq-driver", settings, null, mockSdkController as never);
      expect(result).toBe("!dq #7");
    });

    it("should return null when required driver is missing", () => {
      const result = buildAdminCommand("dq-driver", baseSettings, null, mockSdkController as never);
      expect(result).toBeNull();
    });

    it("should build black flag with time penalty", () => {
      const settings = { ...baseSettings, penaltyType: "time", penaltyValue: "30" };
      const result = buildAdminCommand("black-flag", settings, "42", mockSdkController as never);
      expect(result).toBe("!black #42 30");
    });

    it("should build black flag with laps penalty", () => {
      const settings = { ...baseSettings, penaltyType: "laps", penaltyValue: "2" };
      const result = buildAdminCommand("black-flag", settings, "42", mockSdkController as never);
      expect(result).toBe("!black #42 2L");
    });

    it("should build black flag with drive-through penalty", () => {
      const settings = { ...baseSettings, penaltyType: "drivethrough", penaltyValue: "" };
      const result = buildAdminCommand("black-flag", settings, "42", mockSdkController as never);
      expect(result).toBe("!black #42 D");
    });

    it("should build pace laps with add operation", () => {
      const settings = { ...baseSettings, paceLapsOperation: "+", paceLapsValue: "2" };
      const result = buildAdminCommand("pace-laps", settings, null, mockSdkController as never);
      expect(result).toBe("!pacelaps +2");
    });

    it("should build pace laps with subtract operation", () => {
      const settings = { ...baseSettings, paceLapsOperation: "-", paceLapsValue: "1" };
      const result = buildAdminCommand("pace-laps", settings, null, mockSdkController as never);
      expect(result).toBe("!pacelaps -1");
    });

    it("should build pace laps with set operation", () => {
      const settings = { ...baseSettings, paceLapsOperation: "=", paceLapsValue: "3" };
      const result = buildAdminCommand("pace-laps", settings, null, mockSdkController as never);
      expect(result).toBe("!pacelaps 3");
    });

    it("should build grid set with minutes", () => {
      const settings = { ...baseSettings, gridSetMinutes: "5" };
      const result = buildAdminCommand("grid-set", settings, null, mockSdkController as never);
      expect(result).toBe("!gridset 5");
    });

    it("should build track state with percentage", () => {
      const settings = { ...baseSettings, trackStatePercent: "75" };
      const result = buildAdminCommand("track-state", settings, null, mockSdkController as never);
      expect(result).toBe("!trackstate 75");
    });

    it("should build restart commands", () => {
      expect(buildAdminCommand("single-file-restart", baseSettings, null, mockSdkController as never)).toBe(
        "!restart single",
      );
      expect(buildAdminCommand("double-file-restart", baseSettings, null, mockSdkController as never)).toBe(
        "!restart double",
      );
    });

    it("should build driver + message commands", () => {
      const settings = { ...baseSettings, message: "Penalty issued" };
      const result = buildAdminCommand("clear-penalties", settings, "7", mockSdkController as never);
      expect(result).toBe("!clear #7 Penalty issued");
    });

    it("should build required message commands", () => {
      const settings = { ...baseSettings, message: "Race starting soon" };
      expect(buildAdminCommand("message-all", settings, null, mockSdkController as never)).toBe(
        "/all Race starting soon",
      );
      expect(buildAdminCommand("rc-message", settings, null, mockSdkController as never)).toBe(
        "/rc Race starting soon",
      );
    });

    it("should return null for required message commands with empty message", () => {
      expect(buildAdminCommand("message-all", baseSettings, null, mockSdkController as never)).toBeNull();
      expect(buildAdminCommand("rc-message", baseSettings, null, mockSdkController as never)).toBeNull();
    });

    it("should return null for camera modes", () => {
      expect(buildAdminCommand("next-car-number", baseSettings, null, mockSdkController as never)).toBeNull();
      expect(buildAdminCommand("prev-car-number", baseSettings, null, mockSdkController as never)).toBeNull();
    });

    it("should build show-dqs-field without driver", () => {
      const result = buildAdminCommand("show-dqs-field", baseSettings, null, mockSdkController as never);
      expect(result).toBe("!showdqs");
    });

    it("should build show-dqs-driver with viewed car", () => {
      const result = buildAdminCommand("show-dqs-driver", baseSettings, "42", mockSdkController as never);
      expect(result).toBe("!showdqs #42");
    });

    it("should return null for show-dqs-driver without driver", () => {
      const result = buildAdminCommand("show-dqs-driver", baseSettings, null, mockSdkController as never);
      expect(result).toBeNull();
    });

    it("should collapse newlines in messages", () => {
      const settings = { ...baseSettings, message: "Line 1\nLine 2\r\nLine 3" };
      const result = buildAdminCommand("yellow", settings, null, mockSdkController as never);
      expect(result).toBe("!yellow Line 1 Line 2 Line 3");
    });

    it("should resolve template variables in messages", () => {
      vi.mocked(resolveTemplate).mockReturnValueOnce("Driver 42 warned");
      const settings = { ...baseSettings, message: "{{self.name}} warned" };
      const result = buildAdminCommand("yellow", settings, null, mockSdkController as never);
      expect(buildTemplateContext).toHaveBeenCalled();
      expect(resolveTemplate).toHaveBeenCalled();
      expect(result).toBe("!yellow Driver 42 warned");
    });
  });

  // ── Car Navigation ──────────────────────────────────────────

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
        { carIdx: 0, carNumber: 4 },
        { carIdx: 1, carNumber: 7 },
        { carIdx: 2, carNumber: 42 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue(7);

      expect(findAdjacentCarByNumber({}, 1, "next")).toBe(42);
    });

    it("should return previous car by number order", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: 4 },
        { carIdx: 1, carNumber: 7 },
        { carIdx: 2, carNumber: 42 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue(7);

      expect(findAdjacentCarByNumber({}, 1, "prev")).toBe(4);
    });

    it("should wrap around from last to first", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: 4 },
        { carIdx: 1, carNumber: 7 },
        { carIdx: 2, carNumber: 42 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue(42);

      expect(findAdjacentCarByNumber({}, 2, "next")).toBe(4);
    });

    it("should wrap around from first to last", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: 4 },
        { carIdx: 1, carNumber: 7 },
        { carIdx: 2, carNumber: 42 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue(4);

      expect(findAdjacentCarByNumber({}, 0, "prev")).toBe(42);
    });

    it("should return first car when current car not found", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue([
        { carIdx: 0, carNumber: 4 },
        { carIdx: 1, carNumber: 7 },
      ]);
      vi.mocked(getCarNumberFromSessionInfo).mockReturnValue(null);

      expect(findAdjacentCarByNumber({}, 99, "next")).toBe(4);
    });
  });

  // ── Icon Generation ─────────────────────────────────────────

  describe("generateRaceAdminSvg", () => {
    const defaultSettings = {
      mode: "yellow" as const,
      useViewedCar: true,
      carNumber: "",
      message: "",
      penaltyType: "time" as const,
      penaltyValue: "30",
      paceLapsOperation: "+" as const,
      paceLapsValue: "1",
      gridSetMinutes: "5",
      trackStatePercent: "50",
    };

    it("should generate a valid data URI", () => {
      const result = generateRaceAdminSvg("yellow", defaultSettings);
      expect(result).toContain("data:image/svg+xml");
    });

    it("should include correct labels for yellow mode", () => {
      const result = generateRaceAdminSvg("yellow", defaultSettings);
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("YELLOW");
      expect(decoded).toContain("CAUTION");
    });

    it("should show car number when pre-defined car is set", () => {
      const settings = { ...defaultSettings, useViewedCar: false, carNumber: "42" };
      const result = generateRaceAdminSvg("black-flag", settings);
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("#42");
    });

    it("should show default sub label when using viewed car", () => {
      const settings = { ...defaultSettings, useViewedCar: true };
      const result = generateRaceAdminSvg("black-flag", settings);
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("FLAG");
    });

    it("should produce different icons for different modes", () => {
      const yellowSvg = generateRaceAdminSvg("yellow", defaultSettings);
      const pitCloseSvg = generateRaceAdminSvg("pit-close", defaultSettings);
      expect(yellowSvg).not.toBe(pitCloseSvg);
    });
  });
});
