import { getGlobalSettings, requestProfileSwitch, updateGlobalSettings } from "@iracedeck/deck-core";
import {
  buildTemplateContext,
  classifyCarNumberTarget,
  getCarNumberRawFromSessionInfo,
  getPlayerCarNumberFromSessionInfo,
  resolveTemplate,
} from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetSelectIntents, setSelectIntent } from "../../shared/car-select-intent.js";
import { buildAdminCommand, buildAdminCommandPrefix, resolveDriverTarget } from "./race-admin-commands.js";
import { getModesByOptgroup, RACE_ADMIN_MODE_META, RACE_ADMIN_MODES } from "./race-admin-modes.js";
import {
  availableProfilesForDevice,
  generateSelectorSvg,
  resolveSelectedCar,
  resolveSlotCar,
} from "./race-admin-selector.js";
import { generateRaceAdminSvg, RaceAdmin } from "./race-admin.js";

// Mock SDK
// Mock iracing-sdk
vi.mock("@iracedeck/iracing-sdk", () => ({
  getCarNumberFromSessionInfo: vi.fn(),
  getCarNumberRawFromSessionInfo: vi.fn(() => 24),
  getAllCarNumbers: vi.fn(() => []),
  classifyCarNumberTarget: vi.fn(() => "user"),
  getPlayerCarNumberFromSessionInfo: vi.fn(() => null),
  buildTemplateContext: vi.fn(() => ({ display: {}, raw: {} })),
  resolveTemplate: vi.fn((template: string) => template),
}));

// The session-touching selector helpers are mocked (unit-tested in
// race-admin-selector.test.ts); the pure slot-math helpers keep their real
// logic so the lifecycle tests exercise genuine ordinal/paging behavior (#754).
vi.mock("./race-admin-selector.js", () => ({
  SELECTED_CAR_KEY: "_selectedCar",
  LEGACY_SELECTED_CAR_KEY: "_raceAdminSelectedCar",
  DEFAULT_SELECTOR_TARGET_PROFILE: "iRaceDeck Race Admin Per Car",
  availableProfilesForDevice: vi.fn(() => ["iRaceDeck Race Admin Cars XL", "iRaceDeck Race Admin Per Car XL"]),
  deviceProfileEntries: vi.fn(() => [
    { name: "iRaceDeck Race Admin Cars XL", label: "iRaceDeck Race Admin Cars" },
    { name: "iRaceDeck Race Admin Per Car XL", label: "iRaceDeck Race Admin Per Car" },
  ]),
  parseSelectorPage: (raw: string | undefined) => {
    const n = Number(raw);

    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  },
  selectorOrdinal: (self: { column: number; row: number }, keys: readonly { column: number; row: number }[]): number =>
    keys.filter((k) => k.row < self.row || (k.row === self.row && k.column < self.column)).length,
  pageStartSlot: (page: number, counts: ReadonlyMap<number, number>): number | null => {
    let start = 0;

    for (let p = 0; p < page; p++) {
      const count = counts.get(p);

      if (count === undefined || count <= 0) return null;

      start += count;
    }

    return start;
  },
  resolveSlotCar: vi.fn(() => ({ carIdx: 5, carNumber: "24", lastName: "Doe" })),
  resolveSelectedCar: vi.fn(() => null),
  generateSelectorSvg: vi.fn(
    (car: { carNumber: string } | null, _settings: unknown, highlighted?: boolean) =>
      `data:selector,${car?.carNumber ?? ""},${highlighted ? "H" : ""}`,
  ),
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
const mockCameraSwitchNum = vi.fn(() => true);
// Small default open→paste delay so the real-timer tests below resolve quickly.
// vi.hoisted so the object-returning factory is initialized before the hoisted
// vi.mock("@iracedeck/deck-core") factory references it.
const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({ chatOpenToPasteDelayMs: 10 })),
}));

vi.mock("@iracedeck/deck-core", () => ({
  IconUpdateThrottle: class {
    schedule(_id: string, render: () => unknown): void {
      try {
        void Promise.resolve(render()).catch(() => {});
      } catch {
        // Swallow sync throws — matches the production render contract.
      }
    }
    clear(): void {}
    clearAll(): void {}
  },
  CommonSettings: {
    extend: (_fields: unknown) => {
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
      };

      return schema;
    },
  },
  // Minimal reimplementation of the #753 profile-name helpers (the real ones
  // are covered by deck-core's own device-profiles tests).
  deviceProfileName: (name: string, deviceType: number | undefined): string => {
    if (name.endsWith(" XL") || name.endsWith(" SD")) return name;

    return deviceType === 2 ? `${name} XL` : name;
  },
  resolveProfileNameForDevice: (
    name: string,
    deviceType: number | undefined,
    availableNames: readonly string[],
  ): string | undefined => {
    if (availableNames.includes(name)) return name;

    const suffixed = deviceType === 2 && !name.endsWith(" XL") ? `${name} XL` : name;

    return availableNames.includes(suffixed) ? suffixed : undefined;
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
    camera: { switchNum: mockCameraSwitchNum },
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
      addedWithVersion: "",
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
      selectorPage: "0",
      selectorTargetProfile: "",
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
        "data:selector,24,",
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

    // Penalty-aware black-flag default title (#792)

    it("should show BLACK 30S for a time penalty", () => {
      const settings = { ...defaultSettings, penaltyType: "time" as const, penaltyValue: "30" };
      const decoded = decodeURIComponent(generateRaceAdminSvg("black-flag", settings));
      expect(decoded).toContain("FLAG\nBLACK 30S");
    });

    it("should show BLACK 3L for a laps penalty", () => {
      const settings = { ...defaultSettings, penaltyType: "laps" as const, penaltyValue: "3" };
      const decoded = decodeURIComponent(generateRaceAdminSvg("black-flag", settings));
      expect(decoded).toContain("FLAG\nBLACK 3L");
    });

    it("should show BLACK DT for a drive-through penalty regardless of value", () => {
      for (const penaltyValue of ["30", "", "garbage"]) {
        const settings = { ...defaultSettings, penaltyType: "drivethrough" as const, penaltyValue };
        const decoded = decodeURIComponent(generateRaceAdminSvg("black-flag", settings));
        expect(decoded).toContain("FLAG\nBLACK DT");
      }
    });

    it("should fall back to plain BLACK when the penalty value is empty", () => {
      const settings = { ...defaultSettings, penaltyType: "time" as const, penaltyValue: "  " };
      const decoded = decodeURIComponent(generateRaceAdminSvg("black-flag", settings));
      expect(decoded).toContain("FLAG\nBLACK</svg>");
    });

    it("should fall back to plain BLACK when the penalty value is not a number", () => {
      const settings = { ...defaultSettings, penaltyType: "laps" as const, penaltyValue: "abc" };
      const decoded = decodeURIComponent(generateRaceAdminSvg("black-flag", settings));
      expect(decoded).toContain("FLAG\nBLACK</svg>");
    });

    it("should keep the selected-car number sub-label on the penalty-aware title", () => {
      const settings = { ...defaultSettings, driverTarget: "selected-car" as const, penaltyValue: "30" };
      const decoded = decodeURIComponent(generateRaceAdminSvg("black-flag", settings, { carNumber: "42" }));
      expect(decoded).toContain("#42\nBLACK 30S");
    });

    it("should keep the NO CAR sub-label on the penalty-aware title when nothing is selected", () => {
      const settings = { ...defaultSettings, driverTarget: "selected-car" as const, penaltyValue: "30" };
      const decoded = decodeURIComponent(generateRaceAdminSvg("black-flag", settings, null));
      expect(decoded).toContain("NO CAR\nBLACK 30S");
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
      vi.mocked(resolveSlotCar).mockReturnValue({ carIdx: 5, carNumber: "24", lastName: "Doe" });
    });

    afterEach(() => {
      vi.mocked(resolveSlotCar).mockReset();
      vi.mocked(resolveSelectedCar).mockReset();
    });

    it("stores the selected car (CarIdx + number) and switches to the per-car profile on press", async () => {
      const action = new RaceAdmin();
      await action.onKeyDown(makeSelectorKeyDown(selectorSettings));

      expect(updateGlobalSettings).toHaveBeenCalledWith({
        _selectedCar: { carIdx: 5, carNumber: "24" },
      });
      // The stored legacy display name resolves to the device's manifest name
      // (#753). Page 0: the target profile always opens on its first page (#754).
      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-1", "iRaceDeck Race Admin Per Car XL", 0);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("passes a stored device-suffixed manifest name through unchanged (#753)", async () => {
      const action = new RaceAdmin();
      await action.onKeyDown(
        makeSelectorKeyDown({ ...selectorSettings, selectorTargetProfile: "iRaceDeck Race Admin Cars XL" }),
      );

      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-1", "iRaceDeck Race Admin Cars XL", 0);
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

      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-1", "iRaceDeck Race Admin Per Car XL", 0);
    });

    it("falls back to the default per-car profile when the stored name has no variant here (#753)", async () => {
      const action = new RaceAdmin();
      await action.onKeyDown(makeSelectorKeyDown({ ...selectorSettings, selectorTargetProfile: "iRaceDeck Gone" }));

      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-1", "iRaceDeck Race Admin Per Car XL", 0);
    });

    it("stores the selection but skips the switch when the device ships no per-car profile", async () => {
      vi.mocked(availableProfilesForDevice).mockReturnValueOnce([]);
      const action = new RaceAdmin();
      await action.onKeyDown(makeSelectorKeyDown(selectorSettings));

      expect(updateGlobalSettings).toHaveBeenCalledWith({
        _selectedCar: { carIdx: 5, carNumber: "24" },
      });
      expect(requestProfileSwitch).not.toHaveBeenCalled();
    });

    function makeSelectorAppear(id: string, column: number, row: number, settings: Record<string, unknown>) {
      return {
        action: { id, deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}) },
        payload: { settings: { ...settings }, coordinates: { column, row } },
      } as never;
    }

    it("assigns slots by row-major ordinal among the visible select-car keys — any placement, corners included (#754)", async () => {
      const action = new RaceAdmin();
      // Two keys: the top-left corner (no longer reserved) and one mid-grid.
      await action.onWillAppear(makeSelectorAppear("ctx-a", 0, 0, selectorSettings));
      await action.onWillAppear(makeSelectorAppear("ctx-b", 4, 2, selectorSettings));
      vi.mocked(resolveSlotCar).mockClear();

      await action.onKeyDown({
        action: { id: "ctx-b", deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}) },
        payload: { settings: { ...selectorSettings }, coordinates: { column: 4, row: 2 } },
      } as never);

      expect(vi.mocked(resolveSlotCar).mock.lastCall?.[1]).toBe(1);
    });

    it("offsets a later page by the learned key counts of the earlier pages — uneven counts included (#754)", async () => {
      const action = new RaceAdmin();
      // Page 0 has two keys; page 1's first key must start at slot 2.
      await action.onWillAppear(makeSelectorAppear("ctx-a", 1, 0, selectorSettings));
      await action.onWillAppear(makeSelectorAppear("ctx-b", 2, 0, selectorSettings));
      await action.onWillAppear(makeSelectorAppear("ctx-p1", 0, 0, { ...selectorSettings, selectorPage: "1" }));
      vi.mocked(resolveSlotCar).mockClear();

      await action.onKeyDown({
        action: { id: "ctx-p1", deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}) },
        payload: { settings: { ...selectorSettings, selectorPage: "1" }, coordinates: { column: 0, row: 0 } },
      } as never);

      expect(vi.mocked(resolveSlotCar).mock.lastCall?.[1]).toBe(2);
    });

    it("re-records the old page when a key's Selector Page setting changes", async () => {
      const action = new RaceAdmin();
      await action.onWillAppear(makeSelectorAppear("ctx-a", 1, 0, selectorSettings));
      await action.onWillAppear(makeSelectorAppear("ctx-b", 2, 0, selectorSettings));
      // PI edit moves ctx-b to page 1: page 0 now holds one key, so ctx-b's
      // page-1 slot must start at 1, not at the stale count of 2.
      await action.onDidReceiveSettings(makeSelectorAppear("ctx-b", 2, 0, { ...selectorSettings, selectorPage: "1" }));
      vi.mocked(resolveSlotCar).mockClear();

      await action.onKeyDown({
        action: { id: "ctx-b", deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}) },
        payload: { settings: { ...selectorSettings, selectorPage: "1" }, coordinates: { column: 2, row: 0 } },
      } as never);

      expect(vi.mocked(resolveSlotCar).mock.lastCall?.[1]).toBe(1);
    });

    it("forgets a page's count when its last key moves away (later pages blank until revisited)", async () => {
      const action = new RaceAdmin();
      await action.onWillAppear(makeSelectorAppear("ctx-a", 1, 0, selectorSettings));
      await action.onWillAppear(makeSelectorAppear("ctx-p1", 0, 0, { ...selectorSettings, selectorPage: "1" }));
      // ctx-a was page 0's only key; moving it to page 2 must forget page 0's
      // count rather than leave the stale 1 behind.
      await action.onDidReceiveSettings(makeSelectorAppear("ctx-a", 1, 0, { ...selectorSettings, selectorPage: "2" }));
      vi.mocked(resolveSlotCar).mockClear();

      await action.onKeyDown({
        action: { id: "ctx-p1", deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}) },
        payload: { settings: { ...selectorSettings, selectorPage: "1" }, coordinates: { column: 0, row: 0 } },
      } as never);

      expect(vi.mocked(resolveSlotCar).mock.lastCall?.[1]).toBeNull();
    });

    it("resolves no car while an earlier page's key count is unknown (#754)", async () => {
      const action = new RaceAdmin();
      // Page 1 key appears without page 0 ever having been visited.
      await action.onWillAppear(makeSelectorAppear("ctx-p1", 0, 0, { ...selectorSettings, selectorPage: "1" }));
      vi.mocked(resolveSlotCar).mockClear();

      await action.onKeyDown({
        action: { id: "ctx-p1", deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}) },
        payload: { settings: { ...selectorSettings, selectorPage: "1" }, coordinates: { column: 0, row: 0 } },
      } as never);

      expect(vi.mocked(resolveSlotCar).mock.lastCall?.[1]).toBeNull();
    });

    it("still selects a car when Selector Page holds non-numeric text (settings parse must not reset)", async () => {
      const action = new RaceAdmin();
      await action.onKeyDown(makeSelectorKeyDown({ ...selectorSettings, selectorPage: "p1" }));

      // The press must stay a selection — NOT fall back to the default
      // "yellow" mode and throw a real caution flag.
      expect(updateGlobalSettings).toHaveBeenCalledWith({
        _selectedCar: { carIdx: 5, carNumber: "24" },
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

    it("reads the legacy _raceAdminSelectedCar key when _selectedCar is absent", async () => {
      const legacyRecord = { carIdx: 7, carNumber: "42" };
      vi.mocked(getGlobalSettings).mockReturnValueOnce({ _raceAdminSelectedCar: legacyRecord } as never);

      const action = new RaceAdmin();
      await action.onKeyDown(
        makeSelectorKeyDown({ ...selectorSettings, mode: "dq-driver", driverTarget: "selected-car" }),
      );

      expect(resolveSelectedCar).toHaveBeenCalledWith(legacyRecord, expect.any(Function));
    });

    it("prefers _selectedCar over the legacy key when both exist", async () => {
      const newRecord = { carIdx: 3, carNumber: "11" };
      vi.mocked(getGlobalSettings).mockReturnValueOnce({
        _selectedCar: newRecord,
        _raceAdminSelectedCar: { carIdx: 7, carNumber: "42" },
      } as never);

      const action = new RaceAdmin();
      await action.onKeyDown(
        makeSelectorKeyDown({ ...selectorSettings, mode: "dq-driver", driverTarget: "selected-car" }),
      );

      expect(resolveSelectedCar).toHaveBeenCalledWith(newRecord, expect.any(Function));
    });

    it("pushes the device profile entries for the Target Profile dropdown on appear (select-car only)", async () => {
      const action = new RaceAdmin();
      const ev = {
        action: { id: "ctx-sel", deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}) },
        payload: { settings: { ...selectorSettings }, coordinates: { column: 1, row: 0 } },
      } as never;

      await action.onWillAppear(ev);

      const setSettings = (ev as { action: { setSettings: ReturnType<typeof vi.fn> } }).action.setSettings;
      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          _deviceProfiles: [
            { name: "iRaceDeck Race Admin Cars XL", label: "iRaceDeck Race Admin Cars" },
            { name: "iRaceDeck Race Admin Per Car XL", label: "iRaceDeck Race Admin Per Car" },
          ],
        }),
      );

      // Second appear with the entries already stored: no redundant write (echo-loop guard).
      setSettings.mockClear();
      const ev2 = {
        action: { id: "ctx-sel", deviceId: "dev-1", deviceType: 2, setSettings },
        payload: {
          settings: {
            ...selectorSettings,
            _deviceProfiles: [
              { name: "iRaceDeck Race Admin Cars XL", label: "iRaceDeck Race Admin Cars" },
              { name: "iRaceDeck Race Admin Per Car XL", label: "iRaceDeck Race Admin Per Car" },
            ],
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

    describe("focus-camera intent (#790)", () => {
      beforeEach(() => {
        _resetSelectIntents();
      });

      afterEach(() => {
        _resetSelectIntents();
      });

      // Mirrors makeSelectorKeyDown (same ctx id / device / grid position) but
      // also wires a showAlert spy so the failure-path tests can assert on it.
      function makeFocusKeyDown(showAlert: ReturnType<typeof vi.fn>) {
        return {
          action: { id: "ctx-sel", deviceId: "dev-1", deviceType: 2, setSettings: vi.fn(async () => {}), showAlert },
          payload: { settings: selectorSettings, coordinates: { column: 1, row: 0 } },
        } as never;
      }

      function makeFocusAction(): RaceAdmin {
        const action = new RaceAdmin();
        // A focus-camera dispatch only proceeds past the sessionInfo guard when
        // session info is present — the default mock's getSessionInfo() is null.
        action.sdkController.getSessionInfo = vi.fn(() => ({}) as never);

        return action;
      }

      it("focuses the camera on the slot car and stays on the grid", async () => {
        setSelectIntent("dev-1", { action: "focus-camera" });
        const action = makeFocusAction();
        const showAlert = vi.fn(async () => {});

        await action.onKeyDown(makeFocusKeyDown(showAlert));

        expect(mockCameraSwitchNum).toHaveBeenCalledWith(24, 0, 0);
        expect(updateGlobalSettings).not.toHaveBeenCalled();
        expect(requestProfileSwitch).not.toHaveBeenCalled();
      });

      it("without an intent the press stores the selection and switches (legacy path)", async () => {
        const action = makeFocusAction();
        const showAlert = vi.fn(async () => {});

        await action.onKeyDown(makeFocusKeyDown(showAlert));

        expect(updateGlobalSettings).toHaveBeenCalledWith({ _selectedCar: { carIdx: 5, carNumber: "24" } });
        expect(requestProfileSwitch).toHaveBeenCalled();
        expect(mockCameraSwitchNum).not.toHaveBeenCalled();
      });

      it("alerts and does nothing when the camera switch fails", async () => {
        setSelectIntent("dev-1", { action: "focus-camera" });
        mockCameraSwitchNum.mockReturnValueOnce(false);
        const action = makeFocusAction();
        const showAlert = vi.fn(async () => {});

        await action.onKeyDown(makeFocusKeyDown(showAlert));

        expect(showAlert).toHaveBeenCalled();
        expect(updateGlobalSettings).not.toHaveBeenCalled();
      });

      it("alerts when the car number cannot be resolved to a raw number", async () => {
        setSelectIntent("dev-1", { action: "focus-camera" });
        vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValueOnce(null);
        const action = makeFocusAction();
        const showAlert = vi.fn(async () => {});

        await action.onKeyDown(makeFocusKeyDown(showAlert));

        expect(mockCameraSwitchNum).not.toHaveBeenCalled();
        expect(showAlert).toHaveBeenCalled();
      });

      it("highlights the key whose car the camera is on while the intent is active", async () => {
        setSelectIntent("dev-1", { action: "focus-camera" });
        const action = new RaceAdmin();

        await action.onWillAppear(makeSelectorAppear("ctx-sel", 1, 0, selectorSettings));

        const telemetryCallback = action["sdkController"].subscribe.mock.calls[0][1];
        await telemetryCallback({ CamCarIdx: 5 });

        expect(generateSelectorSvg).toHaveBeenLastCalledWith(
          expect.objectContaining({ carIdx: 5 }),
          expect.anything(),
          true,
        );
      });
    });
  });

  // ── User-target guard: AI / unknown targets (#747) ──────────

  describe("RaceAdmin user-management target guard", () => {
    const baseSettings = {
      mode: "revoke-admin" as const,
      driverTarget: "specific" as const,
      carNumber: "7",
      message: "",
      penaltyType: "time",
      penaltyValue: "30",
      paceLapsOperation: "+",
      paceLapsValue: "1",
      gridSetMinutes: "5",
      trackStatePercent: "50",
    };

    function makeEvent(settings: Record<string, unknown>) {
      return {
        action: { id: "ctx-guard", showAlert: vi.fn(async () => {}), setSettings: vi.fn(async () => {}) },
        payload: { settings },
      } as never;
    }

    // clearAllMocks keeps implementations, so restore the factory default
    // ("user") after each test to avoid leaking a stubbed classification.
    afterEach(() => {
      vi.mocked(classifyCarNumberTarget).mockReset();
      vi.mocked(getPlayerCarNumberFromSessionInfo).mockReset();
    });

    it("refuses a user-management command aimed at an AI car and flashes the key alert", async () => {
      vi.mocked(classifyCarNumberTarget).mockReturnValue("ai");
      const action = new RaceAdmin();
      const ev = makeEvent(baseSettings);

      await action.onKeyDown(ev);

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect((ev as { action: { showAlert: ReturnType<typeof vi.fn> } }).action.showAlert).toHaveBeenCalledTimes(1);
    });

    it("refuses a user-management command aimed at a number not in the session", async () => {
      vi.mocked(classifyCarNumberTarget).mockReturnValue("unknown");
      const action = new RaceAdmin();

      await action.onKeyDown(makeEvent(baseSettings));

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("dispatches normally when the target is a human user's car", async () => {
      vi.mocked(classifyCarNumberTarget).mockReturnValue("user");
      const action = new RaceAdmin();

      await action.onKeyDown(makeEvent(baseSettings));

      expect(mockSendMessage).toHaveBeenCalledWith("!nadmin #7");
    });

    it("does not guard car-targeted race-control commands (valid against AI cars)", async () => {
      vi.mocked(classifyCarNumberTarget).mockReturnValue("ai");
      const action = new RaceAdmin();

      await action.onKeyDown(makeEvent({ ...baseSettings, mode: "black-flag", penaltyType: "drivethrough" }));

      expect(mockSendMessage).toHaveBeenCalledWith("!black #7 D");
      expect(classifyCarNumberTarget).not.toHaveBeenCalled();
    });

    it("refuses revoke-admin aimed at the sender's own car", async () => {
      vi.mocked(getPlayerCarNumberFromSessionInfo).mockReturnValue("7");
      const action = new RaceAdmin();
      const ev = makeEvent(baseSettings); // revoke-admin, target #7

      await action.onKeyDown(ev);

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect((ev as { action: { showAlert: ReturnType<typeof vi.fn> } }).action.showAlert).toHaveBeenCalledTimes(1);
    });

    it("revoke-admin still dispatches against someone else's car", async () => {
      vi.mocked(getPlayerCarNumberFromSessionInfo).mockReturnValue("42");
      const action = new RaceAdmin();

      await action.onKeyDown(makeEvent(baseSettings)); // target #7, own car #42

      expect(mockSendMessage).toHaveBeenCalledWith("!nadmin #7");
    });

    it("grant-admin on the sender's own car is not blocked (only revoke refuses self)", async () => {
      vi.mocked(getPlayerCarNumberFromSessionInfo).mockReturnValue("7");
      const action = new RaceAdmin();

      await action.onKeyDown(makeEvent({ ...baseSettings, mode: "grant-admin" }));

      expect(mockSendMessage).toHaveBeenCalledWith("!admin #7");
    });

    it("flags exactly revoke-admin as refusesSelfTarget", () => {
      const flagged = RACE_ADMIN_MODES.filter((m) => RACE_ADMIN_MODE_META[m].refusesSelfTarget === true);
      expect(flagged).toEqual(["revoke-admin"]);
    });

    it("flags exactly the five user-management modes as targetsUser", () => {
      const flagged = RACE_ADMIN_MODES.filter((m) => RACE_ADMIN_MODE_META[m].targetsUser === true);
      expect([...flagged].sort()).toEqual(
        ["disable-chat-driver", "enable-chat-driver", "grant-admin", "remove-driver", "revoke-admin"].sort(),
      );
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
