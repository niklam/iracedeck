import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AiSpotterControls,
  generateAiSpotterControlsSvg,
  SPOTTER_GLOBAL_KEYS,
  SPOTTER_ICONS,
  SPOTTER_LABELS,
} from "./ai-spotter-controls.js";

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
    tapBinding = vi.fn().mockResolvedValue(undefined);
    holdBinding = vi.fn().mockResolvedValue(undefined);
    releaseBinding = vi.fn().mockResolvedValue(undefined);
    setActiveBinding = vi.fn();
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
  getGlobalColors: vi.fn(() => ({})),
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

  describe("SPOTTER_LABELS", () => {
    it("should have SPOTTER as subLabel for all controls", () => {
      for (const labels of Object.values(SPOTTER_LABELS)) {
        expect(labels.subLabel).toBe("SPOTTER");
      }
    });

    it("should have correct mainLabels", () => {
      expect(SPOTTER_LABELS["damage-report"].mainLabel).toBe("DAMAGE");
      expect(SPOTTER_LABELS["weather-report"].mainLabel).toBe("WEATHER");
      expect(SPOTTER_LABELS["toggle-report-laps"].mainLabel).toBe("RPT LAPS");
      expect(SPOTTER_LABELS["announce-leader"].mainLabel).toBe("LEADER");
      expect(SPOTTER_LABELS["louder"].mainLabel).toBe("LOUDER");
      expect(SPOTTER_LABELS["quieter"].mainLabel).toBe("QUIETER");
      expect(SPOTTER_LABELS["silence"].mainLabel).toBe("SILENCE");
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
        const result = generateAiSpotterControlsSvg({ control });
        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different controls", () => {
      const damageReport = generateAiSpotterControlsSvg({ control: "damage-report" });
      const louder = generateAiSpotterControlsSvg({ control: "louder" });
      const silence = generateAiSpotterControlsSvg({ control: "silence" });

      expect(damageReport).not.toBe(louder);
      expect(damageReport).not.toBe(silence);
      expect(louder).not.toBe(silence);
    });

    it("should include correct labels for damage-report", () => {
      const result = generateAiSpotterControlsSvg({ control: "damage-report" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("SPOTTER");
      expect(decoded).toContain("DAMAGE");
    });

    it("should include correct labels for louder", () => {
      const result = generateAiSpotterControlsSvg({ control: "louder" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("SPOTTER");
      expect(decoded).toContain("LOUDER");
    });

    it("should include correct labels for silence", () => {
      const result = generateAiSpotterControlsSvg({ control: "silence" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("SPOTTER");
      expect(decoded).toContain("SILENCE");
    });

    it("should include correct labels for all controls", () => {
      for (const [control, labels] of Object.entries(SPOTTER_LABELS)) {
        const result = generateAiSpotterControlsSvg({ control: control as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.mainLabel);
        expect(decoded).toContain(labels.subLabel);
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

      expect(action.tapBinding).toHaveBeenCalledWith("spotterDamageReport");
    });

    it("should call tapGlobalBinding on keyDown for louder", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "louder" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("spotterLouder");
    });

    it("should call tapGlobalBinding on keyDown for silence", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "silence" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("spotterSilence");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "damage-report" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("spotterDamageReport");
    });

    it("should call tapGlobalBinding for all controls", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "silence" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("spotterSilence");
    });
  });
});
