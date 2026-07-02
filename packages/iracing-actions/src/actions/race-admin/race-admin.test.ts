import { requestProfileSwitch, updateGlobalSettings } from "@iracedeck/deck-core";
import { buildTemplateContext, resolveTemplate } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAdminCommand, buildAdminCommandPrefix, resolveDriverTarget } from "./race-admin-commands.js";
import { getModesByOptgroup, RACE_ADMIN_MODE_META, RACE_ADMIN_MODES } from "./race-admin-modes.js";
import { computeCarSlotIndex, resolveSelectedCar, resolveSlotCar } from "./race-admin-selector.js";
import { generateRaceAdminSvg, RaceAdmin } from "./race-admin.js";

// Mock SDK
// Mock iracing-sdk
vi.mock("@iracedeck/iracing-sdk", () => ({
  getCarNumberFromSessionInfo: vi.fn(),
  getAllCarNumbers: vi.fn(() => []),
  buildTemplateContext: vi.fn(() => ({ display: {}, raw: {} })),
  resolveTemplate: vi.fn((template: string) => template),
}));

// The car-selector helpers are unit-tested in race-admin-selector.test.ts; here
// we mock them so the action tests exercise only the lifecycle/dispatch logic.
vi.mock("./race-admin-selector.js", () => ({
  SELECTED_CAR_KEY: "_raceAdminSelectedCar",
  DEFAULT_SELECTOR_TARGET_PROFILE: "iRaceDeck Race Admin Per Car",
  availableProfilesForDevice: vi.fn(() => ["iRaceDeck Race Admin Cars", "iRaceDeck Race Admin Per Car"]),
  computeCarSlotIndex: vi.fn(() => 0),
  resolveSlotCar: vi.fn(() => ({ carIdx: 5, carNumber: "24", lastName: "Doe" })),
  resolveSelectedCar: vi.fn(() => null),
  generateSelectorSvg: vi.fn((car: { carNumber: string } | null) => `data:selector,${car?.carNumber ?? ""}`),
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

// Mock shared utilities
const mockSendMessage = vi.fn(async () => true);
const mockBeginChat = vi.fn(() => true);
const mockSetClipboardText = vi.fn(() => true);
const mockSendKeyCombination = vi.fn(async () => true);
// Small default open→paste delay so the real-timer tests below resolve quickly.
// vi.hoisted so the object-returning factory is initialized before the hoisted
// vi.mock("@iracedeck/deck-core") factory references it.
const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({ chatOpenToPasteDelayMs: 10 })),
}));

vi.mock("@iracedeck/deck-core", () => ({
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
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getCurrentTelemetry: vi.fn(() => null),
      getSessionInfo: vi.fn(() => null),
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    updateKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    async onWillAppear(_ev: unknown): Promise<void> {}
    async onWillDisappear(_ev: unknown): Promise<void> {}
    async onDidReceiveSettings(_ev: unknown): Promise<void> {}
  },
  getCommands: vi.fn(() => ({
    chat: { sendMessage: mockSendMessage, beginChat: mockBeginChat },
    camera: { switchNum: vi.fn(() => true) },
  })),
  getClipboard: vi.fn(() => ({ setClipboardText: mockSetClipboardText })),
  getDeviceSpec: vi.fn(() => ({ grid: [8, 4] as const })),
  requestProfileSwitch: vi.fn(async () => {}),
  updateGlobalSettings: vi.fn(),
  getGlobalSettings: mockGetGlobalSettings,
  getKeyboard: vi.fn(() => ({ sendKeyCombination: mockSendKeyCombination })),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
  getGlobalTitleSettings: vi.fn(() => ({})),
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
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
}));

describe("RaceAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Mode Definitions ────────────────────────────────────────

  describe("RACE_ADMIN_MODES", () => {
    it("should have 28 modes", () => {
      expect(RACE_ADMIN_MODES).toHaveLength(28);
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
      expect(groups.has("Car Selection")).toBe(true);
    });

    it("should have correct mode counts per optgroup", () => {
      const groups = getModesByOptgroup();
      expect(groups.get("Race Control")).toHaveLength(14);
      expect(groups.get("Session Management")).toHaveLength(4);
      expect(groups.get("Driver & Chat Management")).toHaveLength(9);
      expect(groups.get("Car Selection")).toHaveLength(1);
    });
  });

  // ── Driver Targeting ────────────────────────────────────────

  describe("resolveDriverTarget", () => {
    const baseSettings = {
      mode: "black-flag" as const,
      driverTarget: "viewed-car" as const,
      carNumber: "",
      message: "",
      penaltyType: "time",
      penaltyValue: "30",
      paceLapsOperation: "+",
      paceLapsValue: "1",
      gridSetMinutes: "5",
      trackStatePercent: "50",
    };

    it("should return viewed car number when driverTarget is viewed-car", () => {
      const meta = RACE_ADMIN_MODE_META["black-flag"];
      const result = resolveDriverTarget({ ...baseSettings, driverTarget: "viewed-car" }, "42", meta);
      expect(result).toBe("42");
    });

    it("should return null when driverTarget is viewed-car but no viewed car", () => {
      const meta = RACE_ADMIN_MODE_META["black-flag"];
      const result = resolveDriverTarget({ ...baseSettings, driverTarget: "viewed-car" }, null, meta);
      expect(result).toBeNull();
    });

    it("should return pre-defined car number when driverTarget is specific", () => {
      const meta = RACE_ADMIN_MODE_META["black-flag"];
      const result = resolveDriverTarget({ ...baseSettings, driverTarget: "specific", carNumber: "7" }, null, meta);
      expect(result).toBe("7");
    });

    it("should return null when driverTarget is specific and carNumber is empty", () => {
      const meta = RACE_ADMIN_MODE_META["black-flag"];
      const result = resolveDriverTarget({ ...baseSettings, driverTarget: "specific", carNumber: "" }, null, meta);
      expect(result).toBeNull();
    });

    it("should return null when driverTarget is type-in-chat (handled by executeMode)", () => {
      const meta = RACE_ADMIN_MODE_META["black-flag"];
      const result = resolveDriverTarget({ ...baseSettings, driverTarget: "type-in-chat" }, "42", meta);
      expect(result).toBeNull();
    });

    it("should return the shared selected car number when driverTarget is selected-car", () => {
      const meta = RACE_ADMIN_MODE_META["black-flag"];
      const result = resolveDriverTarget({ ...baseSettings, driverTarget: "selected-car" }, null, meta, "24");
      expect(result).toBe("24");
    });

    it("should return null when driverTarget is selected-car but nothing is selected", () => {
      const meta = RACE_ADMIN_MODE_META["black-flag"];
      const result = resolveDriverTarget({ ...baseSettings, driverTarget: "selected-car" }, null, meta, null);
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
      driverTarget: "viewed-car" as const,
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
      const settings = { ...baseSettings, driverTarget: "specific" as const, carNumber: "7" };
      const result = buildAdminCommand("dq-driver", settings, null, mockSdkController as never);
      expect(result).toBe("!dq #7");
    });

    it("should build commands with driver target (selected car)", () => {
      const settings = { ...baseSettings, driverTarget: "selected-car" as const };
      const result = buildAdminCommand("dq-driver", settings, null, mockSdkController as never, "24");
      expect(result).toBe("!dq #24");
    });

    it("should return null for selected-car when nothing is selected", () => {
      const settings = { ...baseSettings, driverTarget: "selected-car" as const };
      const result = buildAdminCommand("dq-driver", settings, null, mockSdkController as never, null);
      expect(result).toBeNull();
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

  // ── Icon Generation ─────────────────────────────────────────

  describe("generateRaceAdminSvg", () => {
    const defaultSettings = {
      mode: "yellow" as const,
      driverTarget: "viewed-car" as const,
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

    it("should show car number when driverTarget is specific", () => {
      const settings = { ...defaultSettings, driverTarget: "specific" as const, carNumber: "42" };
      const result = generateRaceAdminSvg("black-flag", settings);
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("#42");
    });

    it("should show default sub label when using viewed car", () => {
      const settings = { ...defaultSettings, driverTarget: "viewed-car" as const };
      const result = generateRaceAdminSvg("black-flag", settings);
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("FLAG");
    });

    it("should show default sub label for type-in-chat (no fixed number)", () => {
      const settings = { ...defaultSettings, driverTarget: "type-in-chat" as const, carNumber: "999" };
      const result = generateRaceAdminSvg("black-flag", settings);
      const decoded = decodeURIComponent(result);
      // Falls through to the default subLabel; the carNumber is irrelevant here.
      expect(decoded).toContain("FLAG");
      expect(decoded).not.toContain("#999");
    });

    it("should produce different icons for different modes", () => {
      const yellowSvg = generateRaceAdminSvg("yellow", defaultSettings);
      const pitCloseSvg = generateRaceAdminSvg("pit-close", defaultSettings);
      expect(yellowSvg).not.toBe(pitCloseSvg);
    });

    it("should render the dynamic selector icon for select-car mode", () => {
      const settings = { ...defaultSettings, mode: "select-car" as const };
      expect(generateRaceAdminSvg("select-car", settings, { carNumber: "24", lastName: "Doe" })).toBe(
        "data:selector,24",
      );
    });

    it("should show the resolved car number on the selected-car target", () => {
      const settings = { ...defaultSettings, driverTarget: "selected-car" as const };
      const decoded = decodeURIComponent(generateRaceAdminSvg("black-flag", settings, { carNumber: "24" }));
      expect(decoded).toContain("#24");
    });

    it("should show NO CAR on the selected-car target when nothing is selected", () => {
      const settings = { ...defaultSettings, driverTarget: "selected-car" as const };
      const decoded = decodeURIComponent(generateRaceAdminSvg("black-flag", settings, null));
      expect(decoded).toContain("NO CAR");
    });
  });

  // ── Command Prefix (type-in-chat) ───────────────────────────

  describe("buildAdminCommandPrefix", () => {
    it("returns the meta.command with a trailing space for driver-targeted modes", () => {
      expect(buildAdminCommandPrefix("dq-driver")).toBe("!dq ");
      expect(buildAdminCommandPrefix("clear-penalties")).toBe("!clear ");
      expect(buildAdminCommandPrefix("black-flag")).toBe("!black ");
      expect(buildAdminCommandPrefix("wave-around")).toBe("!waveby ");
      expect(buildAdminCommandPrefix("eol")).toBe("!eol ");
    });

    it("returns the prefix even for non-driver modes (caller filters by needsDriver)", () => {
      expect(buildAdminCommandPrefix("yellow")).toBe("!yellow ");
      expect(buildAdminCommandPrefix("clear-all")).toBe("!clearall ");
    });

    it("never returns a prefix without trailing whitespace", () => {
      for (const mode of RACE_ADMIN_MODES) {
        const prefix = buildAdminCommandPrefix(mode);

        if (prefix !== null) {
          expect(prefix.endsWith(" ")).toBe(true);
        }
      }
    });
  });

  // ── Action Class: type-in-chat fire path ────────────────────

  describe("RaceAdmin.executeMode (via onKeyDown)", () => {
    const baseSettings = {
      mode: "dq-driver" as const,
      driverTarget: "type-in-chat" as const,
      carNumber: "",
      message: "",
      penaltyType: "time",
      penaltyValue: "30",
      paceLapsOperation: "+",
      paceLapsValue: "1",
      gridSetMinutes: "5",
      trackStatePercent: "50",
    };

    function makeKeyDownEvent(settings: Record<string, unknown>) {
      return {
        action: { id: "ctx-1", setSettings: vi.fn(async () => {}) },
        payload: { settings },
      } as never;
    }

    beforeEach(() => {
      mockSetClipboardText.mockClear();
      mockSendKeyCombination.mockClear();
      mockBeginChat.mockClear();
      mockSendMessage.mockClear();
      mockSetClipboardText.mockReturnValue(true);
      mockBeginChat.mockReturnValue(true);
      mockSendKeyCombination.mockResolvedValue(true);
    });

    it("type-in-chat: writes prefix, opens chat, pastes Ctrl+V, never sends Enter", async () => {
      const action = new RaceAdmin();
      const ev = makeKeyDownEvent(baseSettings);

      await action.onKeyDown(ev);
      // Wait past the configurable open→paste delay (mocked to 10ms) so the
      // keyboard call has fired.
      await new Promise((r) => setTimeout(r, 150));

      expect(mockSetClipboardText).toHaveBeenCalledTimes(1);
      expect(mockSetClipboardText).toHaveBeenCalledWith("!dq ");

      expect(mockBeginChat).toHaveBeenCalledTimes(1);

      expect(mockSendKeyCombination).toHaveBeenCalledTimes(1);
      expect(mockSendKeyCombination).toHaveBeenCalledWith({ key: "v", code: "KeyV", modifiers: ["ctrl"] });

      // Crucially: no Enter key sent and no SDK chat.sendMessage call.
      const enterCalls = mockSendKeyCombination.mock.calls.filter((c) => {
        const arg = c[0] as { key?: string };

        return arg?.key === "enter" || arg?.key === "Enter";
      });
      expect(enterCalls).toHaveLength(0);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("type-in-chat: open→paste wait honors the chatOpenToPasteDelayMs setting", async () => {
      mockGetGlobalSettings.mockReturnValueOnce({ chatOpenToPasteDelayMs: 800 });
      vi.useFakeTimers();

      try {
        const action = new RaceAdmin();
        const promise = action.onKeyDown(makeKeyDownEvent(baseSettings));

        // Flush the synchronous pipeline (clipboard write + beginChat) up to the delay.
        await vi.advanceTimersByTimeAsync(0);
        expect(mockSetClipboardText).toHaveBeenCalledTimes(1);
        expect(mockBeginChat).toHaveBeenCalledTimes(1);
        expect(mockSendKeyCombination).not.toHaveBeenCalled();

        // Just before the configured delay elapses, the paste must not have fired.
        await vi.advanceTimersByTimeAsync(799);
        expect(mockSendKeyCombination).not.toHaveBeenCalled();

        // Crossing the 800ms boundary fires the paste.
        await vi.advanceTimersByTimeAsync(1);
        await promise;
        expect(mockSendKeyCombination).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("type-in-chat: clipboard write failure aborts before opening chat", async () => {
      mockSetClipboardText.mockReturnValueOnce(false);
      const action = new RaceAdmin();

      await action.onKeyDown(makeKeyDownEvent(baseSettings));
      await new Promise((r) => setTimeout(r, 150));

      expect(mockSetClipboardText).toHaveBeenCalledTimes(1);
      expect(mockBeginChat).not.toHaveBeenCalled();
      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("type-in-chat: beginChat() failure aborts before sending Ctrl+V", async () => {
      mockBeginChat.mockReturnValueOnce(false);
      const action = new RaceAdmin();

      await action.onKeyDown(makeKeyDownEvent(baseSettings));
      await new Promise((r) => setTimeout(r, 150));

      expect(mockSetClipboardText).toHaveBeenCalledTimes(1);
      expect(mockBeginChat).toHaveBeenCalledTimes(1);
      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("non-driver mode + leftover driverTarget=type-in-chat falls through to chat.sendMessage", async () => {
      const action = new RaceAdmin();
      const ev = makeKeyDownEvent({
        ...baseSettings,
        mode: "yellow", // needsDriver=false
        driverTarget: "type-in-chat",
        message: "Caution!",
      });

      await action.onKeyDown(ev);

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith("!yellow Caution!");
      expect(mockSetClipboardText).not.toHaveBeenCalled();
      expect(mockBeginChat).not.toHaveBeenCalled();
    });

    it("type-in-chat: re-entrant fires while one is in flight are dropped", async () => {
      const action = new RaceAdmin();
      const ev = makeKeyDownEvent(baseSettings);

      // Fire two in rapid succession; the second should bail before clipboard write.
      const first = action.onKeyDown(ev);
      const second = action.onKeyDown(ev);
      await Promise.all([first, second]);
      await new Promise((r) => setTimeout(r, 150));

      expect(mockSetClipboardText).toHaveBeenCalledTimes(1);
      expect(mockBeginChat).toHaveBeenCalledTimes(1);
      expect(mockSendKeyCombination).toHaveBeenCalledTimes(1);
    });

    it("driverTarget=specific dispatches via SDK chat.sendMessage as before", async () => {
      const action = new RaceAdmin();
      await action.onKeyDown(makeKeyDownEvent({ ...baseSettings, driverTarget: "specific", carNumber: "42" }));

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith("!dq #42");
      expect(mockSetClipboardText).not.toHaveBeenCalled();
    });
  });

  // ── Car Selector: select-car mode + selected-car target (#732) ──

  describe("RaceAdmin car selector", () => {
    const selectorSettings = {
      mode: "select-car" as const,
      driverTarget: "type-in-chat" as const,
      carNumber: "",
      message: "",
      penaltyType: "time",
      penaltyValue: "30",
      paceLapsOperation: "+",
      paceLapsValue: "1",
      gridSetMinutes: "5",
      trackStatePercent: "50",
      selectorPage: "0",
      selectorTargetProfile: "iRaceDeck Race Admin Per Car",
    };

    function makeSelectorKeyDown(
      settings: Record<string, unknown>,
      coordinates: { column: number; row: number } = { column: 1, row: 0 },
    ) {
      return {
        action: { id: "ctx-sel", deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}) },
        payload: { settings, coordinates },
      } as never;
    }

    // The selector-helper mocks are re-stubbed here; mockReset in afterEach
    // restores the factory implementations so nothing leaks past this block.
    beforeEach(() => {
      vi.mocked(computeCarSlotIndex).mockReturnValue(0);
      vi.mocked(resolveSlotCar).mockReturnValue({ carIdx: 5, carNumber: "24", lastName: "Doe" });
    });

    afterEach(() => {
      vi.mocked(computeCarSlotIndex).mockReset();
      vi.mocked(resolveSlotCar).mockReset();
      vi.mocked(resolveSelectedCar).mockReset();
    });

    it("stores the selected car (CarIdx + number) and switches to the per-car profile on press", async () => {
      const action = new RaceAdmin();
      await action.onKeyDown(makeSelectorKeyDown(selectorSettings));

      expect(updateGlobalSettings).toHaveBeenCalledWith({
        _raceAdminSelectedCar: { carIdx: 5, carNumber: "24" },
      });
      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-1", "iRaceDeck Race Admin Per Car");
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("does nothing when the pressed slot is empty", async () => {
      vi.mocked(resolveSlotCar).mockReturnValue(null);
      const action = new RaceAdmin();
      await action.onKeyDown(makeSelectorKeyDown(selectorSettings));

      expect(updateGlobalSettings).not.toHaveBeenCalled();
      expect(requestProfileSwitch).not.toHaveBeenCalled();
    });

    it("falls back to the default per-car profile when the target profile is cleared", async () => {
      const action = new RaceAdmin();
      await action.onKeyDown(makeSelectorKeyDown({ ...selectorSettings, selectorTargetProfile: "  " }));

      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-1", "iRaceDeck Race Admin Per Car");
    });

    it("still selects a car when Selector Page holds non-numeric text (settings parse must not reset)", async () => {
      const action = new RaceAdmin();
      await action.onKeyDown(makeSelectorKeyDown({ ...selectorSettings, selectorPage: "p1" }));

      // The press must stay a selection — NOT fall back to the default
      // "yellow" mode and throw a real caution flag.
      expect(updateGlobalSettings).toHaveBeenCalledWith({
        _raceAdminSelectedCar: { carIdx: 5, carNumber: "24" },
      });
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("dispatches a command against the shared selected car for the selected-car target", async () => {
      vi.mocked(resolveSelectedCar).mockReturnValueOnce("24");

      const action = new RaceAdmin();
      await action.onKeyDown(
        makeSelectorKeyDown({ ...selectorSettings, mode: "dq-driver", driverTarget: "selected-car" }),
      );

      expect(mockSendMessage).toHaveBeenCalledWith("!dq #24");
    });

    it("does not dispatch when the stored selection is stale or missing", async () => {
      vi.mocked(resolveSelectedCar).mockReturnValueOnce(null);

      const action = new RaceAdmin();
      await action.onKeyDown(
        makeSelectorKeyDown({ ...selectorSettings, mode: "dq-driver", driverTarget: "selected-car" }),
      );

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("pushes the device profile list for the Target Profile dropdown on appear (select-car only)", async () => {
      const action = new RaceAdmin();
      const ev = {
        action: { id: "ctx-sel", deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}) },
        payload: { settings: { ...selectorSettings }, coordinates: { column: 1, row: 0 } },
      } as never;

      await action.onWillAppear(ev);

      const setSettings = (ev as { action: { setSettings: ReturnType<typeof vi.fn> } }).action.setSettings;
      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          _deviceProfiles: ["iRaceDeck Race Admin Cars", "iRaceDeck Race Admin Per Car"],
        }),
      );

      // Second appear with the list already stored: no redundant write (echo-loop guard).
      setSettings.mockClear();
      const ev2 = {
        action: { id: "ctx-sel", deviceId: "dev-1", deviceType: 2, setSettings },
        payload: {
          settings: {
            ...selectorSettings,
            _deviceProfiles: ["iRaceDeck Race Admin Cars", "iRaceDeck Race Admin Per Car"],
          },
          coordinates: { column: 1, row: 0 },
        },
      } as never;
      await action.onWillAppear(ev2);
      expect(setSettings).not.toHaveBeenCalled();
    });

    it("does not push the profile list for non-selector modes", async () => {
      const action = new RaceAdmin();
      const ev = {
        action: { id: "ctx-cmd", deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}) },
        payload: {
          settings: { ...selectorSettings, mode: "yellow", driverTarget: "viewed-car" },
          coordinates: { column: 1, row: 0 },
        },
      } as never;

      await action.onWillAppear(ev);

      expect((ev as { action: { setSettings: ReturnType<typeof vi.fn> } }).action.setSettings).not.toHaveBeenCalled();
    });
  });

  // ── Action Class: settings migration ────────────────────────

  describe("RaceAdmin settings migration (useViewedCar → driverTarget)", () => {
    function makeWillAppearEvent(settings: Record<string, unknown>) {
      return {
        action: { id: "ctx-1", setSettings: vi.fn(async () => {}) },
        payload: { settings },
      } as never;
    }

    it("persists migrated payload (without useViewedCar) when legacy key present", async () => {
      const action = new RaceAdmin();
      const ev = makeWillAppearEvent({ mode: "dq-driver", useViewedCar: false, carNumber: "7" });

      await action.onWillAppear(ev);

      const setSettings = ev.action.setSettings as unknown as ReturnType<typeof vi.fn>;
      expect(setSettings).toHaveBeenCalledTimes(1);
      const persisted = setSettings.mock.calls[0]![0] as Record<string, unknown>;
      expect(persisted).toMatchObject({ mode: "dq-driver", driverTarget: "specific", carNumber: "7" });
      expect(persisted.useViewedCar).toBeUndefined();
    });

    it("does not call setSettings when settings already use driverTarget", async () => {
      const action = new RaceAdmin();
      const ev = makeWillAppearEvent({ mode: "dq-driver", driverTarget: "viewed-car" });

      await action.onWillAppear(ev);

      const setSettings = ev.action.setSettings as unknown as ReturnType<typeof vi.fn>;
      expect(setSettings).not.toHaveBeenCalled();
    });

    it("maps legacy useViewedCar=true to driverTarget=viewed-car", async () => {
      const action = new RaceAdmin();
      const ev = makeWillAppearEvent({ mode: "dq-driver", useViewedCar: true });

      await action.onWillAppear(ev);

      const setSettings = ev.action.setSettings as unknown as ReturnType<typeof vi.fn>;
      const persisted = setSettings.mock.calls[0]![0] as Record<string, unknown>;
      expect(persisted.driverTarget).toBe("viewed-car");
    });

    it("backfills driverTarget=viewed-car for pre-existing buttons that never wrote useViewedCar", async () => {
      // Regression for CodeRabbit catch on PR #495: v1.15 buttons whose users
      // never toggled the "Use Viewed Car" checkbox have neither useViewedCar
      // nor driverTarget in saved settings. Without backfill they'd silently
      // flip to the new "type-in-chat" default.
      const action = new RaceAdmin();
      const ev = makeWillAppearEvent({ mode: "dq-driver", addedWithVersion: "1.15.0" });

      await action.onWillAppear(ev);

      const setSettings = ev.action.setSettings as unknown as ReturnType<typeof vi.fn>;
      expect(setSettings).toHaveBeenCalledTimes(1);
      const persisted = setSettings.mock.calls[0]![0] as Record<string, unknown>;
      expect(persisted.driverTarget).toBe("viewed-car");
      expect(persisted.useViewedCar).toBeUndefined();
    });

    it("does not persist for a fresh button with no addedWithVersion and no useViewedCar", async () => {
      // Brand-new button — addedWithVersion is missing on first appear, so we
      // fall through to the schema default ("type-in-chat") without writing.
      // (Note: base-action's own onWillAppear may persist addedWithVersion, but
      // race-admin's persistMigratedSettings does not.)
      const action = new RaceAdmin();
      const ev = makeWillAppearEvent({ mode: "yellow" });

      await action.onWillAppear(ev);

      const setSettings = ev.action.setSettings as unknown as ReturnType<typeof vi.fn>;
      expect(setSettings).not.toHaveBeenCalled();
    });
  });
});
