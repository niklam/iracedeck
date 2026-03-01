import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateToggleUiElementsSvg, UI_ELEMENT_GLOBAL_KEYS } from "./toggle-ui-elements.js";

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

vi.mock("../shared/index.js", () => ({
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
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
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`;
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
      const expectedLabels: Record<string, { line1: string; line2: string }> = {
        "dash-box": { line1: "DASH BOX", line2: "TOGGLE" },
        "speed-gear-pedals": { line1: "INPUTS", line2: "TOGGLE" },
        "radio-display": { line1: "RADIO", line2: "DISPLAY" },
        "fps-network-display": { line1: "SYSTEM", line2: "METERS" },
        "weather-radar": { line1: "WEATHER", line2: "RADAR" },
        "virtual-mirror": { line1: "VIRTUAL", line2: "MIRROR" },
        "ui-edit-mode": { line1: "UI EDIT", line2: "MODE" },
        "display-ref-car": { line1: "REFERENCE", line2: "CAR" },
        "replay-ui": { line1: "REPLAY UI", line2: "TOGGLE" },
      };

      for (const [element, labels] of Object.entries(expectedLabels)) {
        const result = generateToggleUiElementsSvg({ element: element as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);
        expect(decoded).toContain(labels.line2);
      }
    });
  });
});
