import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateToggleUiElementsSvg, UI_ELEMENT_GLOBAL_KEYS } from "./toggle-ui-elements.js";

vi.mock("@iracedeck/icons/toggle-ui-elements/dash-box.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/speed-gear-pedals.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/radio-display.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/fps-network-display.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/weather-radar.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/virtual-mirror.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/ui-edit-mode.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/display-ref-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/toggle-ui-elements/replay-ui.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
      // Return a mock Zod-like schema
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
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  getCommands: vi.fn(() => ({
    camera: {
      hideUI: vi.fn(),
      showUI: vi.fn(),
    },
  })),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
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

vi.mock("@iracedeck/iracing-sdk", () => ({
  CameraState: { UIHidden: 0x0008 },
  hasFlag: vi.fn((value: number | undefined, flag: number) => {
    if (value === undefined || value === null) return false;

    return (value & flag) !== 0;
  }),
}));

describe("ToggleUiElements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("UI_ELEMENT_GLOBAL_KEYS", () => {
    it("should have correct mapping for dash-box", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["dash-box"]).toBe("toggleUiDashBox");
    });

    it("should have correct mapping for speed-gear-pedals", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["speed-gear-pedals"]).toBe("toggleUiSpeedGearPedals");
    });

    it("should have correct mapping for radio-display", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["radio-display"]).toBe("toggleUiRadioDisplay");
    });

    it("should have correct mapping for fps-network-display", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["fps-network-display"]).toBe("toggleUiFpsNetworkDisplay");
    });

    it("should have correct mapping for weather-radar", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["weather-radar"]).toBe("toggleUiWeatherRadar");
    });

    it("should have correct mapping for virtual-mirror", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["virtual-mirror"]).toBe("toggleUiVirtualMirror");
    });

    it("should have correct mapping for ui-edit-mode", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["ui-edit-mode"]).toBe("toggleUiEditMode");
    });

    it("should have correct mapping for display-ref-car", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["display-ref-car"]).toBe("toggleUiDisplayRefCar");
    });

    it("should not have a mapping for replay-ui", () => {
      expect(UI_ELEMENT_GLOBAL_KEYS["replay-ui"]).toBeUndefined();
    });

    it("should have exactly 8 entries", () => {
      expect(Object.keys(UI_ELEMENT_GLOBAL_KEYS)).toHaveLength(8);
    });
  });

  describe("generateToggleUiElementsSvg", () => {
    it("should generate a valid data URI for dash-box", () => {
      const result = generateToggleUiElementsSvg({ element: "dash-box" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for replay-ui", () => {
      const result = generateToggleUiElementsSvg({ element: "replay-ui" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all elements", () => {
      const elements = [
        "dash-box",
        "speed-gear-pedals",
        "radio-display",
        "fps-network-display",
        "weather-radar",
        "virtual-mirror",
        "ui-edit-mode",
        "display-ref-car",
        "replay-ui",
      ] as const;

      for (const element of elements) {
        const result = generateToggleUiElementsSvg({ element });
        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different elements", () => {
      const dashBox = generateToggleUiElementsSvg({ element: "dash-box" });
      const replayUi = generateToggleUiElementsSvg({ element: "replay-ui" });

      expect(dashBox).not.toBe(replayUi);
    });

    it("should include DASH BOX label for dash-box element", () => {
      const result = generateToggleUiElementsSvg({ element: "dash-box" });

      expect(decodeURIComponent(result)).toContain("DASH BOX");
    });

    it("should include REPLAY UI label for replay-ui element", () => {
      const result = generateToggleUiElementsSvg({ element: "replay-ui" });

      expect(decodeURIComponent(result)).toContain("REPLAY UI");
    });

    it("should include TOGGLE label for dash-box element", () => {
      const result = generateToggleUiElementsSvg({ element: "dash-box" });

      expect(decodeURIComponent(result)).toContain("TOGGLE");
    });

    it("should include correct labels for all elements", () => {
      const expectedLabels: Record<string, { mainLabel: string; subLabel: string }> = {
        "dash-box": { mainLabel: "DASH BOX", subLabel: "TOGGLE" },
        "speed-gear-pedals": { mainLabel: "INPUTS", subLabel: "TOGGLE" },
        "radio-display": { mainLabel: "RADIO", subLabel: "DISPLAY" },
        "fps-network-display": { mainLabel: "SYSTEM", subLabel: "METERS" },
        "weather-radar": { mainLabel: "WEATHER", subLabel: "RADAR" },
        "virtual-mirror": { mainLabel: "VIRTUAL", subLabel: "MIRROR" },
        "ui-edit-mode": { mainLabel: "UI EDIT", subLabel: "MODE" },
        "display-ref-car": { mainLabel: "REFERENCE", subLabel: "CAR" },
        "replay-ui": { mainLabel: "REPLAY UI", subLabel: "TOGGLE" },
      };

      for (const [element, labels] of Object.entries(expectedLabels)) {
        const result = generateToggleUiElementsSvg({ element: element as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.mainLabel);
        expect(decoded).toContain(labels.subLabel);
      }
    });
  });
});
