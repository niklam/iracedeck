import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AiSpotterControls,
  AiSpotterControlsSettings,
  generateAiSpotterControlsSvg,
  SPOTTER_GLOBAL_KEYS,
  SPOTTER_ICONS,
  SPOTTER_TITLES,
} from "./ai-spotter-controls.js";

const { mockTapBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@iracedeck/icons/ai-spotter-controls/damage-report.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/ai-spotter-controls/weather-report.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/ai-spotter-controls/toggle-report-laps.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/ai-spotter-controls/announce-leader.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/ai-spotter-controls/louder.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/ai-spotter-controls/quieter.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/ai-spotter-controls/silence.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
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
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn().mockResolvedValue(true);
    tapBinding = mockTapBinding;
    holdBinding = vi.fn().mockResolvedValue(undefined);
    releaseBinding = vi.fn().mockResolvedValue(undefined);
    setActiveBinding = vi.fn();
    isBindingMissing = vi.fn(() => false);
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseBinding: vi.fn(),
  parseKeyBinding: vi.fn(),
  isSimHubBinding: vi.fn(
    (v: unknown) => v !== null && typeof v === "object" && (v as Record<string, unknown>).type === "simhub",
  ),
  isSimHubInitialized: vi.fn(() => false),
  getSimHub: vi.fn(() => ({
    startRole: vi.fn().mockResolvedValue(true),
    stopRole: vi.fn().mockResolvedValue(true),
  })),
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

/** Create a minimal fake event with the given action ID and settings. */
function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings },
  };
}

describe("AiSpotterControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SPOTTER_GLOBAL_KEYS", () => {
    it("should have correct mapping for damage-report", () => {
      expect(SPOTTER_GLOBAL_KEYS["damage-report"]).toBe("spotterDamageReport");
    });

    it("should have correct mapping for weather-report", () => {
      expect(SPOTTER_GLOBAL_KEYS["weather-report"]).toBe("spotterWeatherReport");
    });

    it("should have correct mapping for toggle-report-laps", () => {
      expect(SPOTTER_GLOBAL_KEYS["toggle-report-laps"]).toBe("spotterToggleReportLaps");
    });

    it("should have correct mapping for announce-leader", () => {
      expect(SPOTTER_GLOBAL_KEYS["announce-leader"]).toBe("spotterAnnounceLeader");
    });

    it("should have correct mapping for louder", () => {
      expect(SPOTTER_GLOBAL_KEYS["louder"]).toBe("spotterLouder");
    });

    it("should have correct mapping for quieter", () => {
      expect(SPOTTER_GLOBAL_KEYS["quieter"]).toBe("spotterQuieter");
    });

    it("should have correct mapping for silence", () => {
      expect(SPOTTER_GLOBAL_KEYS["silence"]).toBe("spotterSilence");
    });

    it("should have exactly 7 entries", () => {
      expect(Object.keys(SPOTTER_GLOBAL_KEYS)).toHaveLength(7);
    });
  });

  describe("SPOTTER_ICONS", () => {
    it("should have an icon for every control", () => {
      const controls = [
        "damage-report",
        "weather-report",
        "toggle-report-laps",
        "announce-leader",
        "louder",
        "quieter",
        "silence",
      ];

      for (const control of controls) {
        expect(SPOTTER_ICONS[control as keyof typeof SPOTTER_ICONS]).toBeDefined();
      }
    });

    it("should have exactly 7 entries", () => {
      expect(Object.keys(SPOTTER_ICONS)).toHaveLength(7);
    });
  });

  describe("SPOTTER_TITLES", () => {
    it("should have correct first-line labels (subLabel) for all controls", () => {
      expect(SPOTTER_TITLES["damage-report"].split("\n")[0]).toBe("REPORT");
      expect(SPOTTER_TITLES["weather-report"].split("\n")[0]).toBe("REPORT");
      expect(SPOTTER_TITLES["toggle-report-laps"].split("\n")[0]).toBe("REPORT");
      expect(SPOTTER_TITLES["announce-leader"].split("\n")[0]).toBe("SPOTTER");
      expect(SPOTTER_TITLES["louder"].split("\n")[0]).toBe("VOL UP");
      expect(SPOTTER_TITLES["quieter"].split("\n")[0]).toBe("VOL DOWN");
      expect(SPOTTER_TITLES["silence"].split("\n")[0]).toBe("MUTE");
    });

    it("should have correct second-line labels (mainLabel) for all controls", () => {
      expect(SPOTTER_TITLES["damage-report"].split("\n")[1]).toBe("DAMAGE");
      expect(SPOTTER_TITLES["weather-report"].split("\n")[1]).toBe("WEATHER");
      expect(SPOTTER_TITLES["toggle-report-laps"].split("\n")[1]).toBe("LAPS");
      expect(SPOTTER_TITLES["announce-leader"].split("\n")[1]).toBe("LEADER");
      expect(SPOTTER_TITLES["louder"].split("\n")[1]).toBe("SPOTTER");
      expect(SPOTTER_TITLES["quieter"].split("\n")[1]).toBe("SPOTTER");
      expect(SPOTTER_TITLES["silence"].split("\n")[1]).toBe("SPOTTER");
    });
  });

  describe("generateAiSpotterControlsSvg", () => {
    it("should generate a valid data URI for each control", () => {
      const controls = [
        "damage-report",
        "weather-report",
        "toggle-report-laps",
        "announce-leader",
        "louder",
        "quieter",
        "silence",
      ] as const;

      for (const control of controls) {
        const result = generateAiSpotterControlsSvg(AiSpotterControlsSettings.parse({ control }));
        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different controls", () => {
      const damageReport = generateAiSpotterControlsSvg(AiSpotterControlsSettings.parse({ control: "damage-report" }));
      const louder = generateAiSpotterControlsSvg(AiSpotterControlsSettings.parse({ control: "louder" }));
      const silence = generateAiSpotterControlsSvg(AiSpotterControlsSettings.parse({ control: "silence" }));

      expect(damageReport).not.toBe(louder);
      expect(damageReport).not.toBe(silence);
      expect(louder).not.toBe(silence);
    });

    it("should include correct labels for damage-report", () => {
      const result = generateAiSpotterControlsSvg(AiSpotterControlsSettings.parse({ control: "damage-report" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("REPORT");
      expect(decoded).toContain("DAMAGE");
    });

    it("should include correct labels for louder", () => {
      const result = generateAiSpotterControlsSvg(AiSpotterControlsSettings.parse({ control: "louder" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("VOL UP");
      expect(decoded).toContain("SPOTTER");
    });

    it("should include correct labels for silence", () => {
      const result = generateAiSpotterControlsSvg(AiSpotterControlsSettings.parse({ control: "silence" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("MUTE");
      expect(decoded).toContain("SPOTTER");
    });

    it("should include correct labels for all controls", () => {
      for (const [control, titleText] of Object.entries(SPOTTER_TITLES)) {
        const result = generateAiSpotterControlsSvg(AiSpotterControlsSettings.parse({ control: control as any }));
        const decoded = decodeURIComponent(result);
        const lines = titleText.split("\n");

        for (const line of lines) {
          expect(decoded).toContain(line);
        }
      }
    });
  });

  describe("tap behavior", () => {
    let action: AiSpotterControls;

    beforeEach(() => {
      action = new AiSpotterControls();
    });

    it("should call tapGlobalBinding on keyDown for damage-report", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "damage-report" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("spotterDamageReport");
    });

    it("should call tapGlobalBinding on keyDown for louder", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "louder" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("spotterLouder");
    });

    it("should call tapGlobalBinding on keyDown for silence", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "silence" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("spotterSilence");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "damage-report" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("spotterDamageReport");
    });

    it("should call tapGlobalBinding for all controls", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "silence" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("spotterSilence");
    });
  });
});
