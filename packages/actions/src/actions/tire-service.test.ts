import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  areAllTiresOn,
  areLeftTiresOn,
  areRightTiresOn,
  buildTireToggleMacro,
  doCurrentTiresMatch,
  generateTireIcon,
  generateTireServiceSvg,
  generateToggleTiresIconContent,
  getCompoundColor,
  getCompoundName,
  getDriverTires,
  isTireSelected,
  migrateTireSettings,
  resolveToggleMode,
  TireService,
} from "./tire-service.js";

const {
  mockSendMessage,
  mockPitTireCompound,
  mockPitClearTires,
  mockGetCommands,
  mockGetConnectionStatus,
  mockGetCurrentTelemetry,
  mockGetSessionInfo,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn(() => true),
  mockPitTireCompound: vi.fn(() => true),
  mockPitClearTires: vi.fn(() => true),
  mockGetCommands: vi.fn(() => ({
    chat: {
      sendMessage: mockSendMessage,
    },
    pit: {
      tireCompound: mockPitTireCompound,
      clearTires: mockPitClearTires,
    },
  })),
  mockGetConnectionStatus: vi.fn(() => true),
  mockGetCurrentTelemetry: vi.fn(() => ({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 0 })),
  mockGetSessionInfo: vi.fn((): Record<string, unknown> | null => null),
}));

vi.mock("@iracedeck/icons/tire-service/change-all-tires.svg", () => ({
  default: "<svg>change-all-tires-icon</svg>",
}));

vi.mock("@iracedeck/icons/tire-service/clear-tires.svg", () => ({
  default: "<svg>clear-tires-icon</svg>",
}));

vi.mock("@iracedeck/icons/tire-service/toggle-tires.svg", () => ({
  default:
    '<svg><desc>{"colors":{"backgroundColor":"#3a2a2a","textColor":"#ffffff","graphic1Color":"#888888"},"title":{"text":"TIRES"}}</desc><g>toggle-tires-car</g></svg>',
}));

vi.mock("@iracedeck/iracing-sdk", () => ({
  hasFlag: vi.fn((value: number, flag: number) => (value & flag) !== 0),
  PitSvFlags: {
    LFTireChange: 0x0001,
    RFTireChange: 0x0002,
    LRTireChange: 0x0004,
    RRTireChange: 0x0008,
  },
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: () => {
      const defaults = { action: "change-all-tires", tires: ["lf", "rf", "lr", "rr"], addedWithVersion: "0.0.0" };
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...defaults, ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...defaults, ...data } }),
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
      getConnectionStatus: mockGetConnectionStatus,
      getCurrentTelemetry: mockGetCurrentTelemetry,
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn();
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  getCommands: mockGetCommands,
  applyGraphicTransform: vi.fn((_content: string) => _content),
  computeGraphicArea: vi.fn(() => ({ x: 8, y: 8, width: 128, height: 128 })),
  extractGraphicContent: vi.fn((svg: string) =>
    svg
      .replace(/<\/?svg[^>]*>/g, "")
      .replace(/<desc>[\s\S]*?<\/desc>/, "")
      .trim(),
  ),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  generateTitleText: vi.fn((opts: { text: string; fill: string }) =>
    opts.text ? `<text fill="${opts.fill}">${opts.text}</text>` : "",
  ),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getSDK: vi.fn(() => ({ sdk: { getSessionInfo: mockGetSessionInfo } })),
  ICON_BASE_TEMPLATE: "<svg>{{backgroundColor}}|{{borderContent}}|{{graphicContent}}|{{titleContent}}</svg>",
  LogLevel: { Info: 2 },
  parseIconArtworkBounds: vi.fn(() => undefined),
  generateIconText: vi.fn(
    (opts: { text: string; fontSize: number; fill: string }) => `<text fill="${opts.fill}">${opts.text}</text>`,
  ),
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
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    const knownKeys = ["iconContent", "textElement", "graphicContent", "titleContent", "mainLabel", "subLabel"];
    const parts = knownKeys.map((k) => data[k]).filter(Boolean);

    if (parts.length > 0) {
      return `<svg>${parts.join("|")}</svg>`;
    }

    // For colorization calls (no known keys), return template with mustache vars replaced
    let result = template;

    for (const [key, val] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val);
    }

    return result;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: {
      id: actionId,
      setTitle: vi.fn(),
      setImage: vi.fn(),
      setSettings: vi.fn().mockResolvedValue(undefined),
      isKey: () => true,
    },
    payload: { settings },
  };
}

describe("TireService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConnectionStatus.mockReturnValue(true);
    mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 0 });
  });

  describe("getDriverTires", () => {
    it("should return tires from session info", () => {
      mockGetSessionInfo.mockReturnValue({
        DriverInfo: {
          DriverTires: [
            { TireIndex: 0, TireCompoundType: "Hard" },
            { TireIndex: 1, TireCompoundType: "Wet" },
          ],
        },
      });

      expect(getDriverTires()).toEqual([
        { TireIndex: 0, TireCompoundType: "Hard" },
        { TireIndex: 1, TireCompoundType: "Wet" },
      ]);
    });

    it("should return fallback when session info is null", () => {
      mockGetSessionInfo.mockReturnValue(null);

      expect(getDriverTires()).toEqual([{ TireIndex: 0, TireCompoundType: "Dry" }]);
    });

    it("should return fallback when DriverTires is missing", () => {
      mockGetSessionInfo.mockReturnValue({ DriverInfo: {} });

      expect(getDriverTires()).toEqual([{ TireIndex: 0, TireCompoundType: "Dry" }]);
    });

    it("should return fallback when DriverTires is empty", () => {
      mockGetSessionInfo.mockReturnValue({
        DriverInfo: { DriverTires: [] },
      });

      expect(getDriverTires()).toEqual([{ TireIndex: 0, TireCompoundType: "Dry" }]);
    });
  });

  describe("getCompoundColor", () => {
    it("should return white for Hard", () => {
      expect(getCompoundColor("Hard")).toBe("#ffffff");
    });

    it("should return yellow for Medium", () => {
      expect(getCompoundColor("Medium")).toBe("#f1c40f");
    });

    it("should return red for Soft", () => {
      expect(getCompoundColor("Soft")).toBe("#e74c3c");
    });

    it("should return green for Intermediate", () => {
      expect(getCompoundColor("Intermediate")).toBe("#2ecc71");
    });

    it("should return blue for Wet", () => {
      expect(getCompoundColor("Wet")).toBe("#3498db");
    });

    it("should be case-insensitive", () => {
      expect(getCompoundColor("HARD")).toBe("#ffffff");
      expect(getCompoundColor("wet")).toBe("#3498db");
    });

    it("should return gray for unknown types", () => {
      expect(getCompoundColor("Unknown")).toBe("#888888");
    });
  });

  describe("getCompoundName", () => {
    it("should return DRY/WET for 2 compounds when one is Wet", () => {
      mockGetSessionInfo.mockReturnValue({
        DriverInfo: {
          DriverTires: [
            { TireIndex: 0, TireCompoundType: "Hard" },
            { TireIndex: 1, TireCompoundType: "Wet" },
          ],
        },
      });

      expect(getCompoundName(0)).toBe("DRY");
      expect(getCompoundName(1)).toBe("WET");
    });

    it("should uppercase single compound name", () => {
      mockGetSessionInfo.mockReturnValue({
        DriverInfo: {
          DriverTires: [{ TireIndex: 0, TireCompoundType: "Soft" }],
        },
      });

      expect(getCompoundName(0)).toBe("SOFT");
    });

    it("should use actual names for 3+ compounds", () => {
      mockGetSessionInfo.mockReturnValue({
        DriverInfo: {
          DriverTires: [
            { TireIndex: 0, TireCompoundType: "Soft" },
            { TireIndex: 1, TireCompoundType: "Medium" },
            { TireIndex: 2, TireCompoundType: "Hard" },
          ],
        },
      });

      expect(getCompoundName(0)).toBe("Soft");
      expect(getCompoundName(1)).toBe("Medium");
      expect(getCompoundName(2)).toBe("Hard");
    });

    it("should return DRY when session info unavailable (single fallback)", () => {
      mockGetSessionInfo.mockReturnValue(null);

      expect(getCompoundName(0)).toBe("DRY");
    });
  });

  describe("generateTireIcon", () => {
    it("should include compound color in SVG", () => {
      const icon = generateTireIcon("Hard");
      expect(icon).toContain("#ffffff");
    });

    it("should use blue for Wet compound", () => {
      const icon = generateTireIcon("Wet");
      expect(icon).toContain("#3498db");
    });

    it("should use gray for unknown compound", () => {
      const icon = generateTireIcon("Unknown");
      expect(icon).toContain("#888888");
    });
  });

  describe("areAllTiresOn", () => {
    it("should return true when all four tires are selected", () => {
      expect(areAllTiresOn({ tires: ["lf", "rf", "lr", "rr"] })).toBe(true);
    });

    it("should return false when any tire is missing", () => {
      expect(areAllTiresOn({ tires: ["lf", "rf", "lr"] })).toBe(false);
      expect(areAllTiresOn({ tires: ["rf", "lr", "rr"] })).toBe(false);
    });

    it("should return false when no tires are selected", () => {
      expect(areAllTiresOn({ tires: [] })).toBe(false);
    });

    it("should return false for duplicate entries that reach length 4", () => {
      expect(areAllTiresOn({ tires: ["lf", "lf", "lf", "lf"] as any })).toBe(false);
    });
  });

  describe("areLeftTiresOn", () => {
    it("should return true when exactly LF and LR are selected", () => {
      expect(areLeftTiresOn({ tires: ["lf", "lr"] })).toBe(true);
    });

    it("should return false when right-side tires are also selected", () => {
      expect(areLeftTiresOn({ tires: ["lf", "rf", "lr"] })).toBe(false);
      expect(areLeftTiresOn({ tires: ["lf", "lr", "rr"] })).toBe(false);
    });

    it("should return false when all tires are selected", () => {
      expect(areLeftTiresOn({ tires: ["lf", "rf", "lr", "rr"] })).toBe(false);
    });

    it("should return false when only one left tire is selected", () => {
      expect(areLeftTiresOn({ tires: ["lf"] })).toBe(false);
      expect(areLeftTiresOn({ tires: ["lr"] })).toBe(false);
    });

    it("should return false for duplicate entries", () => {
      expect(areLeftTiresOn({ tires: ["lf", "lf"] as any })).toBe(false);
      expect(areLeftTiresOn({ tires: ["lr", "lr"] as any })).toBe(false);
    });
  });

  describe("areRightTiresOn", () => {
    it("should return true when exactly RF and RR are selected", () => {
      expect(areRightTiresOn({ tires: ["rf", "rr"] })).toBe(true);
    });

    it("should return false when left-side tires are also selected", () => {
      expect(areRightTiresOn({ tires: ["lf", "rf", "rr"] })).toBe(false);
      expect(areRightTiresOn({ tires: ["rf", "lr", "rr"] })).toBe(false);
    });

    it("should return false when all tires are selected", () => {
      expect(areRightTiresOn({ tires: ["lf", "rf", "lr", "rr"] })).toBe(false);
    });

    it("should return false when only one right tire is selected", () => {
      expect(areRightTiresOn({ tires: ["rf"] })).toBe(false);
      expect(areRightTiresOn({ tires: ["rr"] })).toBe(false);
    });

    it("should return false for duplicate entries", () => {
      expect(areRightTiresOn({ tires: ["rf", "rf"] as any })).toBe(false);
      expect(areRightTiresOn({ tires: ["rr", "rr"] as any })).toBe(false);
    });
  });

  describe("buildTireToggleMacro", () => {
    it("should use shorthand #!t for all tires", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", tires: ["lf", "rf", "lr", "rr"] } as any)).toBe("#!t");
    });

    it("should use shorthand #!l for left side only", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", tires: ["lf", "lr"] } as any)).toBe("#!l");
    });

    it("should use shorthand #!r for right side only", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", tires: ["rf", "rr"] } as any)).toBe("#!r");
    });

    it("should use per-tire macro for front tires only", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", tires: ["lf", "rf"] } as any)).toBe("#!lf !rf");
    });

    it("should use per-tire macro for rear tires only", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", tires: ["lr", "rr"] } as any)).toBe("#!lr !rr");
    });

    it("should use per-tire macro for diagonal tires", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", tires: ["lf", "rr"] } as any)).toBe("#!lf !rr");
    });

    it("should build macro for single tire", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", tires: ["rr"] } as any)).toBe("#!rr");
    });

    it("should return null when no tires configured", () => {
      expect(buildTireToggleMacro({ action: "toggle-tires", tires: [] } as any)).toBeNull();
    });
  });

  describe("doCurrentTiresMatch", () => {
    it("should return true when all tires configured and all on", () => {
      expect(doCurrentTiresMatch({ tires: ["lf", "rf", "lr", "rr"] }, { lf: true, rf: true, lr: true, rr: true })).toBe(
        true,
      );
    });

    it("should return true when right side configured and right side on", () => {
      expect(doCurrentTiresMatch({ tires: ["rf", "rr"] }, { lf: false, rf: true, lr: false, rr: true })).toBe(true);
    });

    it("should return true when left side configured and left side on", () => {
      expect(doCurrentTiresMatch({ tires: ["lf", "lr"] }, { lf: true, rf: false, lr: true, rr: false })).toBe(true);
    });

    it("should return false when all tires on but only right side configured", () => {
      expect(doCurrentTiresMatch({ tires: ["rf", "rr"] }, { lf: true, rf: true, lr: true, rr: true })).toBe(false);
    });

    it("should return false when no tires on but tires configured", () => {
      expect(
        doCurrentTiresMatch({ tires: ["lf", "rf", "lr", "rr"] }, { lf: false, rf: false, lr: false, rr: false }),
      ).toBe(false);
    });

    it("should return true when no tires configured and no tires on", () => {
      expect(doCurrentTiresMatch({ tires: [] }, { lf: false, rf: false, lr: false, rr: false })).toBe(true);
    });

    it("should return false when left side on but right side configured", () => {
      expect(doCurrentTiresMatch({ tires: ["rf", "rr"] }, { lf: true, rf: false, lr: true, rr: false })).toBe(false);
    });
  });

  describe("resolveToggleMode", () => {
    it("should return explicit toggleMode when set to select", () => {
      expect(resolveToggleMode({ toggleMode: "select", addedWithVersion: "0.0.0" } as any)).toBe("select");
    });

    it("should return explicit toggleMode when set to toggle", () => {
      expect(resolveToggleMode({ toggleMode: "toggle", addedWithVersion: "1.13.0" } as any)).toBe("toggle");
    });

    it("should default to toggle for pre-existing instances (0.0.0)", () => {
      expect(resolveToggleMode({ addedWithVersion: "0.0.0" } as any)).toBe("toggle");
    });

    it("should default to toggle for instances added before 1.13.0", () => {
      expect(resolveToggleMode({ addedWithVersion: "1.12.0" } as any)).toBe("toggle");
    });

    it("should default to select for instances added at 1.13.0", () => {
      expect(resolveToggleMode({ addedWithVersion: "1.13.0" } as any)).toBe("select");
    });

    it("should default to select for instances added after 1.13.0", () => {
      expect(resolveToggleMode({ addedWithVersion: "2.0.0" } as any)).toBe("select");
    });
  });

  describe("generateToggleTiresIconContent", () => {
    it("should return SVG with 4 tire indicator rects", () => {
      const result = generateToggleTiresIconContent(
        { action: "toggle-tires", tires: ["lf", "rf", "lr", "rr"] },
        { lf: false, rf: false, lr: false, rr: false },
      );
      const rects = result.match(/<rect[^>]+>/g) ?? [];
      expect(rects).toHaveLength(4);
    });

    it("should use correct colors per tire position", () => {
      const result = generateToggleTiresIconContent(
        { action: "toggle-tires", tires: ["lf", "lr"] },
        { lf: true, rf: false, lr: false, rr: false },
      );
      // LF: configured + on = green
      // RF: not configured = black
      // LR: configured + off = red
      // RR: not configured = black

      const rects = result.match(/<rect[^>]+>/g) ?? [];
      expect(rects).toHaveLength(4);

      // LF tire (first rect): green
      expect(rects[0]).toContain('fill="#44FF44"');
      // RF tire (second rect): black
      expect(rects[1]).toContain('fill="#000000ff"');
      // LR tire (third rect): red
      expect(rects[2]).toContain('fill="#FF4444"');
      // RR tire (fourth rect): black
      expect(rects[3]).toContain('fill="#000000ff"');
    });

    it("should show all green when all configured and active", () => {
      const result = generateToggleTiresIconContent(
        { action: "toggle-tires", tires: ["lf", "rf", "lr", "rr"] },
        { lf: true, rf: true, lr: true, rr: true },
      );
      const rects = result.match(/<rect[^>]+>/g) ?? [];
      expect(rects).toHaveLength(4);

      for (const rect of rects) {
        expect(rect).toContain('fill="#44FF44"');
      }
    });

    it("should show all red when all configured but inactive", () => {
      const result = generateToggleTiresIconContent(
        { action: "toggle-tires", tires: ["lf", "rf", "lr", "rr"] },
        { lf: false, rf: false, lr: false, rr: false },
      );
      const rects = result.match(/<rect[^>]+>/g) ?? [];
      expect(rects).toHaveLength(4);

      for (const rect of rects) {
        expect(rect).toContain('fill="#FF4444"');
      }
    });
  });

  describe("generateTireServiceSvg", () => {
    const noTires = { lf: false, rf: false, lr: false, rr: false };
    const allTires = { lf: true, rf: true, lr: true, rr: true };

    describe("change-all-tires mode", () => {
      it("should generate a valid data URI", () => {
        const result = generateTireServiceSvg({ action: "change-all-tires", tires: ["lf", "rf", "lr", "rr"] }, noTires);
        expect(result).toContain("data:image/svg+xml");
      });

      it("should include CHANGE and ALL TIRES labels", () => {
        const result = generateTireServiceSvg({ action: "change-all-tires", tires: ["lf", "rf", "lr", "rr"] }, noTires);
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("CHANGE");
        expect(decoded).toContain("ALL TIRES");
      });
    });

    describe("toggle-tires mode", () => {
      it("should generate a valid data URI", () => {
        const result = generateTireServiceSvg({ action: "toggle-tires", tires: ["lf", "rf", "lr", "rr"] }, noTires);
        expect(result).toContain("data:image/svg+xml");
      });

      it("should show red for configured but inactive tires", () => {
        const result = generateTireServiceSvg({ action: "toggle-tires", tires: ["lf", "rf", "lr", "rr"] }, noTires);
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("#FF4444");
      });

      it("should show green for configured and active tires", () => {
        const result = generateTireServiceSvg({ action: "toggle-tires", tires: ["lf", "rf", "lr", "rr"] }, allTires);
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("#44FF44");
      });

      it("should show black for unconfigured tires", () => {
        const result = generateTireServiceSvg({ action: "toggle-tires", tires: [] }, allTires);
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("#000000ff");
      });

      it("should include car content in output", () => {
        const result = generateTireServiceSvg({ action: "toggle-tires", tires: ["lf", "rf", "lr", "rr"] }, noTires);
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("toggle-tires-car");
      });

      it("should include title text", () => {
        const result = generateTireServiceSvg({ action: "toggle-tires", tires: ["lf", "rf", "lr", "rr"] }, noTires);
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("TIRES");
      });
    });

    describe("change-compound mode", () => {
      const compoundSettings = { action: "change-compound" as const, tires: ["lf", "rf", "lr", "rr"] };

      beforeEach(() => {
        mockGetSessionInfo.mockReturnValue({
          DriverInfo: {
            DriverTires: [
              { TireIndex: 0, TireCompoundType: "Hard" },
              { TireIndex: 1, TireCompoundType: "Wet" },
            ],
          },
        });
      });

      it("should generate a valid data URI", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires, { player: 0, pitSv: 0 });
        expect(result).toContain("data:image/svg+xml");
      });

      it("should show Stay on DRY when player and pit service are both dry", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires, { player: 0, pitSv: 0 });
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("Stay on");
        expect(decoded).toContain("DRY");
      });

      it("should show Change to WET when player is dry but pit service is wet", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires, { player: 0, pitSv: 1 });
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("Change to");
        expect(decoded).toContain("WET");
      });

      it("should show Stay on WET when player and pit service are both wet", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires, { player: 1, pitSv: 1 });
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("Stay on");
        expect(decoded).toContain("WET");
      });

      it("should show Change to DRY when player is wet but pit service is dry", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires, { player: 1, pitSv: 0 });
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("Change to");
        expect(decoded).toContain("DRY");
      });

      it("should default to Stay on DRY when compound is not provided", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires);
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("Stay on");
        expect(decoded).toContain("DRY");
      });

      it("should use compound color in tire icon", () => {
        const result = generateTireServiceSvg(compoundSettings, noTires, { player: 0, pitSv: 1 });
        const decoded = decodeURIComponent(result);
        // Wet compound uses blue
        expect(decoded).toContain("#3498db");
      });
    });

    describe("clear-tires mode", () => {
      it("should generate a valid data URI", () => {
        const result = generateTireServiceSvg({ action: "clear-tires", tires: ["lf", "rf", "lr", "rr"] }, noTires);
        expect(result).toContain("data:image/svg+xml");
      });

      it("should include CLEAR and TIRES labels", () => {
        const result = generateTireServiceSvg({ action: "clear-tires", tires: ["lf", "rf", "lr", "rr"] }, noTires);
        const decoded = decodeURIComponent(result);
        expect(decoded).toContain("CLEAR");
        expect(decoded).toContain("TIRES");
      });
    });
  });

  describe("onWillAppear setSettings", () => {
    let action: TireService;

    beforeEach(() => {
      action = new TireService();
    });

    it("should default new instance to select mode (empty raw settings)", async () => {
      const ev = fakeEvent("a1", {});
      await action.onWillAppear(ev as any);

      expect(ev.action.setSettings).toHaveBeenCalledOnce();
      expect(ev.action.setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ tires: expect.anything(), toggleMode: "select" }),
      );
    });

    it("should not call setSettings when tires and toggleMode already exist", async () => {
      const ev = fakeEvent("a1", { action: "toggle-tires", tires: ["lf", "rf"], toggleMode: "select" });
      await action.onWillAppear(ev as any);

      expect(ev.action.setSettings).not.toHaveBeenCalled();
    });

    it("should default pre-existing instance to toggle mode (has settings but no addedWithVersion)", async () => {
      const ev = fakeEvent("a1", { action: "toggle-tires", tires: ["lf", "rf"] });
      await action.onWillAppear(ev as any);

      expect(ev.action.setSettings).toHaveBeenCalledOnce();
      expect(ev.action.setSettings).toHaveBeenCalledWith(expect.objectContaining({ toggleMode: "toggle" }));
    });

    it("should default to select when addedWithVersion already exists", async () => {
      const ev = fakeEvent("a1", { action: "toggle-tires", tires: ["lf", "rf"], addedWithVersion: "1.13.0" });
      await action.onWillAppear(ev as any);

      expect(ev.action.setSettings).toHaveBeenCalledOnce();
      expect(ev.action.setSettings).toHaveBeenCalledWith(expect.objectContaining({ toggleMode: "select" }));
    });

    it("should call setSettings for legacy boolean settings", async () => {
      const ev = fakeEvent("a1", { action: "toggle-tires", lf: true, rf: true, lr: false, rr: false });
      await action.onWillAppear(ev as any);

      expect(ev.action.setSettings).toHaveBeenCalledOnce();
      expect(ev.action.setSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          lf: true,
          rf: true,
          lr: false,
          rr: false,
          tires: expect.any(Array),
        }),
      );
    });

    it("should not overwrite unrelated settings keys", async () => {
      const ev = fakeEvent("a1", { action: "toggle-tires", customKey: "userValue" });
      await action.onWillAppear(ev as any);

      expect(ev.action.setSettings).toHaveBeenCalledOnce();
      const calledWith = (ev.action.setSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledWith).toHaveProperty("customKey", "userValue");
    });

    it("should continue rendering if setSettings throws", async () => {
      const ev = fakeEvent("a1", {});
      (ev.action.setSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("fail"));
      await action.onWillAppear(ev as any);

      // Should not throw — rendering continues (setKeyImage is on the base class mock)
      expect(action.setKeyImage).toHaveBeenCalled();
    });
  });

  describe("key press behavior", () => {
    let action: TireService;

    beforeEach(() => {
      action = new TireService();
    });

    describe("change-all-tires mode", () => {
      it("should send #t macro", async () => {
        await action.onKeyDown(fakeEvent("a1", { action: "change-all-tires" }) as any);

        expect(mockSendMessage).toHaveBeenCalledOnce();
        expect(mockSendMessage).toHaveBeenCalledWith("#t");
      });
    });

    describe("toggle-tires mode", () => {
      describe("select mode (clear-first)", () => {
        it("should clear first when current tires do not match configured", async () => {
          mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x000f, PlayerTireCompound: 0, PitSvTireCompound: 0 });

          await action.onKeyDown(
            fakeEvent("a1", { action: "toggle-tires", toggleMode: "select", tires: ["rf", "rr"] }) as any,
          );

          expect(mockPitClearTires).toHaveBeenCalledOnce();
          expect(mockSendMessage).toHaveBeenCalledWith("#!r");
        });

        it("should not clear when current tires match configured (toggles off)", async () => {
          mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x000a, PlayerTireCompound: 0, PitSvTireCompound: 0 });

          await action.onKeyDown(
            fakeEvent("a1", { action: "toggle-tires", toggleMode: "select", tires: ["rf", "rr"] }) as any,
          );

          expect(mockPitClearTires).not.toHaveBeenCalled();
          expect(mockSendMessage).toHaveBeenCalledWith("#!r");
        });

        it("should clear first when all configured but only some tires on", async () => {
          mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x0003, PlayerTireCompound: 0, PitSvTireCompound: 0 });

          await action.onKeyDown(
            fakeEvent("a1", {
              action: "toggle-tires",
              toggleMode: "select",
              tires: ["lf", "rf", "lr", "rr"],
            }) as any,
          );

          expect(mockPitClearTires).toHaveBeenCalledOnce();
          expect(mockSendMessage).toHaveBeenCalledWith("#!t");
        });

        it("should not clear when all configured and all tires on (toggles off)", async () => {
          mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x000f, PlayerTireCompound: 0, PitSvTireCompound: 0 });

          await action.onKeyDown(
            fakeEvent("a1", {
              action: "toggle-tires",
              toggleMode: "select",
              tires: ["lf", "rf", "lr", "rr"],
            }) as any,
          );

          expect(mockPitClearTires).not.toHaveBeenCalled();
          expect(mockSendMessage).toHaveBeenCalledWith("#!t");
        });
      });

      describe("toggle mode (legacy)", () => {
        it("should never clear tires regardless of state", async () => {
          mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x000f, PlayerTireCompound: 0, PitSvTireCompound: 0 });

          await action.onKeyDown(
            fakeEvent("a1", { action: "toggle-tires", toggleMode: "toggle", tires: ["rf", "rr"] }) as any,
          );

          expect(mockPitClearTires).not.toHaveBeenCalled();
          expect(mockSendMessage).toHaveBeenCalledWith("#!r");
        });

        it("should default to toggle mode for pre-existing instances", async () => {
          // addedWithVersion defaults to "0.0.0" → resolves to "toggle"
          mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x000f, PlayerTireCompound: 0, PitSvTireCompound: 0 });

          await action.onKeyDown(fakeEvent("a1", { action: "toggle-tires", tires: ["rf", "rr"] }) as any);

          expect(mockPitClearTires).not.toHaveBeenCalled();
          expect(mockSendMessage).toHaveBeenCalledWith("#!r");
        });
      });

      it("should not clear or send message when no tires configured", async () => {
        await action.onKeyDown(fakeEvent("a1", { action: "toggle-tires", tires: [] }) as any);

        expect(mockPitClearTires).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
      });

      it("should default to change-all-tires when settings are empty", async () => {
        await action.onKeyDown(fakeEvent("a1", {}) as any);

        expect(mockSendMessage).toHaveBeenCalledOnce();
        expect(mockSendMessage).toHaveBeenCalledWith("#t");
      });
    });

    describe("change-compound mode", () => {
      it("should cycle from 0 to 1 with 2 compounds", async () => {
        mockGetSessionInfo.mockReturnValue({
          DriverInfo: {
            DriverTires: [
              { TireIndex: 0, TireCompoundType: "Hard" },
              { TireIndex: 1, TireCompoundType: "Wet" },
            ],
          },
        });
        mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 0 });

        await action.onKeyDown(fakeEvent("a1", { action: "change-compound" }) as any);

        expect(mockPitTireCompound).toHaveBeenCalledOnce();
        expect(mockPitTireCompound).toHaveBeenCalledWith(1);
        expect(mockSendMessage).not.toHaveBeenCalled();
      });

      it("should wrap from 1 to 0 with 2 compounds", async () => {
        mockGetSessionInfo.mockReturnValue({
          DriverInfo: {
            DriverTires: [
              { TireIndex: 0, TireCompoundType: "Hard" },
              { TireIndex: 1, TireCompoundType: "Wet" },
            ],
          },
        });
        mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 1 });

        await action.onKeyDown(fakeEvent("a1", { action: "change-compound" }) as any);

        expect(mockPitTireCompound).toHaveBeenCalledOnce();
        expect(mockPitTireCompound).toHaveBeenCalledWith(0);
      });

      it("should cycle through 3+ compounds", async () => {
        mockGetSessionInfo.mockReturnValue({
          DriverInfo: {
            DriverTires: [
              { TireIndex: 0, TireCompoundType: "Soft" },
              { TireIndex: 1, TireCompoundType: "Medium" },
              { TireIndex: 2, TireCompoundType: "Hard" },
            ],
          },
        });
        mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 1 });

        await action.onKeyDown(fakeEvent("a1", { action: "change-compound" }) as any);

        expect(mockPitTireCompound).toHaveBeenCalledOnce();
        expect(mockPitTireCompound).toHaveBeenCalledWith(2);
      });

      it("should wrap around with 3+ compounds", async () => {
        mockGetSessionInfo.mockReturnValue({
          DriverInfo: {
            DriverTires: [
              { TireIndex: 0, TireCompoundType: "Soft" },
              { TireIndex: 1, TireCompoundType: "Medium" },
              { TireIndex: 2, TireCompoundType: "Hard" },
            ],
          },
        });
        mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 2 });

        await action.onKeyDown(fakeEvent("a1", { action: "change-compound" }) as any);

        expect(mockPitTireCompound).toHaveBeenCalledOnce();
        expect(mockPitTireCompound).toHaveBeenCalledWith(0);
      });

      it("should default to cycling with fallback when session info unavailable", async () => {
        mockGetSessionInfo.mockReturnValue(null);
        mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 } as any);

        await action.onKeyDown(fakeEvent("a1", { action: "change-compound" }) as any);

        expect(mockPitTireCompound).toHaveBeenCalledOnce();
        // Fallback has 1 compound (TireIndex 0), (0+1) % 1 = 0
        expect(mockPitTireCompound).toHaveBeenCalledWith(0);
      });
    });

    describe("clear-tires mode", () => {
      it("should call pit.clearTires", async () => {
        await action.onKeyDown(fakeEvent("a1", { action: "clear-tires" }) as any);

        expect(mockPitClearTires).toHaveBeenCalledOnce();
        expect(mockSendMessage).not.toHaveBeenCalled();
      });
    });

    it("should not execute change-all-tires when not connected", async () => {
      mockGetConnectionStatus.mockReturnValue(false);

      await action.onKeyDown(fakeEvent("a1", { action: "change-all-tires" }) as any);

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockPitTireCompound).not.toHaveBeenCalled();
      expect(mockPitClearTires).not.toHaveBeenCalled();
    });

    it("should not execute toggle-tires when not connected", async () => {
      mockGetConnectionStatus.mockReturnValue(false);

      await action.onKeyDown(fakeEvent("a1", { action: "toggle-tires", tires: ["lf", "rf", "lr", "rr"] }) as any);

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockPitTireCompound).not.toHaveBeenCalled();
      expect(mockPitClearTires).not.toHaveBeenCalled();
    });
  });

  describe("encoder behavior", () => {
    let action: TireService;

    beforeEach(() => {
      action = new TireService();
    });

    it("should send #t macro on dial down for change-all-tires", async () => {
      await action.onDialDown(fakeEvent("a1", { action: "change-all-tires" }) as any);

      expect(mockSendMessage).toHaveBeenCalledOnce();
      expect(mockSendMessage).toHaveBeenCalledWith("#t");
    });

    it("should clear first on dial down in select mode when tires don't match", async () => {
      mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 0 });

      await action.onDialDown(
        fakeEvent("a1", { action: "toggle-tires", toggleMode: "select", tires: ["lf", "rf", "lr", "rr"] }) as any,
      );

      expect(mockPitClearTires).toHaveBeenCalledOnce();
      expect(mockSendMessage).toHaveBeenCalledOnce();
      expect(mockSendMessage).toHaveBeenCalledWith("#!t");
    });

    it("should not clear on dial down in select mode when tires match", async () => {
      mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x000f, PlayerTireCompound: 0, PitSvTireCompound: 0 });

      await action.onDialDown(
        fakeEvent("a1", { action: "toggle-tires", toggleMode: "select", tires: ["lf", "rf", "lr", "rr"] }) as any,
      );

      expect(mockPitClearTires).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledOnce();
      expect(mockSendMessage).toHaveBeenCalledWith("#!t");
    });

    it("should never clear on dial down in toggle mode", async () => {
      mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x000f, PlayerTireCompound: 0, PitSvTireCompound: 0 });

      await action.onDialDown(
        fakeEvent("a1", { action: "toggle-tires", toggleMode: "toggle", tires: ["rf", "rr"] }) as any,
      );

      expect(mockPitClearTires).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith("#!r");
    });

    it("should cycle compound on dial down for change-compound", async () => {
      mockGetSessionInfo.mockReturnValue({
        DriverInfo: {
          DriverTires: [
            { TireIndex: 0, TireCompoundType: "Hard" },
            { TireIndex: 1, TireCompoundType: "Wet" },
          ],
        },
      });
      mockGetCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, PlayerTireCompound: 0, PitSvTireCompound: 0 });

      await action.onDialDown(fakeEvent("a1", { action: "change-compound" }) as any);

      expect(mockPitTireCompound).toHaveBeenCalledOnce();
      expect(mockPitTireCompound).toHaveBeenCalledWith(1);
    });

    it("should call pit.clearTires on dial down for clear-tires", async () => {
      await action.onDialDown(fakeEvent("a1", { action: "clear-tires" }) as any);

      expect(mockPitClearTires).toHaveBeenCalledOnce();
    });
  });

  describe("isTireSelected", () => {
    it("should return true when tire is in the array", () => {
      expect(isTireSelected({ tires: ["lf", "rf"] } as any, "lf")).toBe(true);
    });

    it("should return false when tire is not in the array", () => {
      expect(isTireSelected({ tires: ["lf", "rf"] } as any, "lr")).toBe(false);
    });

    it("should return false for empty tires array", () => {
      expect(isTireSelected({ tires: [] } as any, "lf")).toBe(false);
    });
  });

  describe("migrateTireSettings", () => {
    it("should pass through when tires key is present", () => {
      const result = migrateTireSettings({ action: "toggle-tires", tires: ["lf", "rr"] });
      expect(result.tires).toEqual(["lf", "rr"]);
    });

    it("should migrate legacy booleans to tires array", () => {
      const result = migrateTireSettings({ action: "toggle-tires", lf: true, rf: false, lr: true, rr: false });
      expect(result.tires).toEqual(["lf", "lr"]);
    });

    it("should migrate all true legacy booleans", () => {
      const result = migrateTireSettings({ action: "toggle-tires", lf: true, rf: true, lr: true, rr: true });
      expect(result.tires).toEqual(["lf", "rf", "lr", "rr"]);
    });

    it("should migrate all false legacy booleans to empty array", () => {
      const result = migrateTireSettings({ action: "toggle-tires", lf: false, rf: false, lr: false, rr: false });
      expect(result.tires).toEqual([]);
    });

    it("should return defaults for empty settings", () => {
      const result = migrateTireSettings({});
      expect(result.tires).toEqual(["lf", "rf", "lr", "rr"]);
    });

    it("should not migrate when tires key exists even with legacy booleans", () => {
      const result = migrateTireSettings({ tires: ["rr"], lf: true, rf: true, lr: true, rr: true });
      expect(result.tires).toEqual(["rr"]);
    });
  });
});
