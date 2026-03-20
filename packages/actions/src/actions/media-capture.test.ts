import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateMediaCaptureSvg, MEDIA_CAPTURE_GLOBAL_KEYS } from "./media-capture.js";

vi.mock("@iracedeck/icons/media-capture/start-stop-video.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/media-capture/video-timer.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/media-capture/toggle-video-capture.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/media-capture/take-screenshot.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/media-capture/take-giant-screenshot.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/media-capture/reload-all-textures.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/media-capture/reload-car-textures.svg", () => ({
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
    videoCapture: {
      screenshot: vi.fn(() => true),
      start: vi.fn(() => true),
      stop: vi.fn(() => true),
      toggle: vi.fn(() => true),
      showTimer: vi.fn(() => true),
      hideTimer: vi.fn(() => true),
    },
    texture: {
      reloadAll: vi.fn(() => true),
      reloadCar: vi.fn(() => true),
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

const ALL_ACTIONS = [
  "start-stop-video",
  "video-timer",
  "toggle-video-capture",
  "take-screenshot",
  "take-giant-screenshot",
  "reload-all-textures",
  "reload-car-textures",
] as const;

describe("MediaCapture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("MEDIA_CAPTURE_GLOBAL_KEYS", () => {
    it("should have exactly 1 keyboard-based action", () => {
      expect(Object.keys(MEDIA_CAPTURE_GLOBAL_KEYS)).toHaveLength(1);
    });

    it("should have correct mapping for take-giant-screenshot", () => {
      expect(MEDIA_CAPTURE_GLOBAL_KEYS["take-giant-screenshot"]).toBe("mediaCaptureGiantScreenshot");
    });

    it("should use mediaCapture prefix for all global keys", () => {
      for (const [_action, key] of Object.entries(MEDIA_CAPTURE_GLOBAL_KEYS)) {
        expect(key).toMatch(/^mediaCapture/);
      }
    });

    it("should have unique global keys for all actions", () => {
      const values = Object.values(MEDIA_CAPTURE_GLOBAL_KEYS);
      const uniqueValues = new Set(values);

      expect(uniqueValues.size).toBe(values.length);
    });
  });

  describe("generateMediaCaptureSvg", () => {
    it("should generate a valid data URI for start-stop-video", () => {
      const result = generateMediaCaptureSvg({ action: "start-stop-video" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all 7 actions", () => {
      for (const action of ALL_ACTIONS) {
        const result = generateMediaCaptureSvg({ action });

        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different actions", () => {
      const startStop = generateMediaCaptureSvg({ action: "start-stop-video" });
      const screenshot = generateMediaCaptureSvg({ action: "take-screenshot" });

      expect(startStop).not.toBe(screenshot);
    });

    it("should include correct labels for start-stop-video", () => {
      const result = generateMediaCaptureSvg({ action: "start-stop-video" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("START/STOP");
      expect(decoded).toContain("VIDEO");
    });

    it("should include correct labels for take-screenshot", () => {
      const result = generateMediaCaptureSvg({ action: "take-screenshot" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("SCREENSHOT");
      expect(decoded).toContain("CAPTURE");
    });

    it("should include correct labels for all actions", () => {
      const expectedLabels: Record<string, { mainLabel: string; subLabel: string }> = {
        "start-stop-video": { mainLabel: "START/STOP", subLabel: "VIDEO" },
        "video-timer": { mainLabel: "TIMER", subLabel: "VIDEO" },
        "toggle-video-capture": { mainLabel: "TOGGLE", subLabel: "VIDEO" },
        "take-screenshot": { mainLabel: "SCREENSHOT", subLabel: "CAPTURE" },
        "take-giant-screenshot": { mainLabel: "GIANT", subLabel: "SCREENSHOT" },
        "reload-all-textures": { mainLabel: "RELOAD ALL", subLabel: "TEXTURES" },
        "reload-car-textures": { mainLabel: "RELOAD CAR", subLabel: "TEXTURES" },
      };

      for (const [action, labels] of Object.entries(expectedLabels)) {
        const result = generateMediaCaptureSvg({
          action: action as (typeof ALL_ACTIONS)[number],
        });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.mainLabel);
        expect(decoded).toContain(labels.subLabel);
      }
    });
  });
});
