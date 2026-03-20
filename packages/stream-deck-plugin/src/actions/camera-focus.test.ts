import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateCameraFocusSvg } from "./camera-focus.js";

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

vi.mock("@iracedeck/icons/camera-focus/focus-your-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/focus-on-leader.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/focus-on-incident.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/focus-on-exiting.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/switch-by-position.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/switch-by-car-number.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-focus/set-camera-state.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("../shared/index.js", () => ({
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
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
  },
  createSDLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
  getCommands: vi.fn(() => ({
    camera: {
      switchPos: vi.fn(() => true),
      switchNum: vi.fn(() => true),
      setState: vi.fn(() => true),
      focusOnLeader: vi.fn(() => true),
      focusOnIncident: vi.fn(() => true),
      focusOnExiting: vi.fn(() => true),
    },
  })),
  getGlobalColors: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
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

describe("CameraFocus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateCameraFocusSvg", () => {
    const ALL_TARGETS = [
      "focus-your-car",
      "focus-on-leader",
      "focus-on-incident",
      "focus-on-exiting",
      "switch-by-position",
      "switch-by-car-number",
      "set-camera-state",
    ] as const;

    it.each(ALL_TARGETS)("should generate a valid data URI for %s", (target) => {
      const result = generateCameraFocusSvg({ target });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for all 7 targets", () => {
      const results = ALL_TARGETS.map((target) => generateCameraFocusSvg({ target }));

      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(ALL_TARGETS.length);
    });

    it("should include YOUR CAR and FOCUS labels for focus-your-car", () => {
      const result = generateCameraFocusSvg({ target: "focus-your-car" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("YOUR CAR");
      expect(decoded).toContain("FOCUS");
    });

    it("should include LEADER and FOCUS labels for focus-on-leader", () => {
      const result = generateCameraFocusSvg({ target: "focus-on-leader" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LEADER");
      expect(decoded).toContain("FOCUS");
    });

    it("should include INCIDENT and FOCUS labels for focus-on-incident", () => {
      const result = generateCameraFocusSvg({ target: "focus-on-incident" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("INCIDENT");
      expect(decoded).toContain("FOCUS");
    });

    it("should include EXITING and FOCUS labels for focus-on-exiting", () => {
      const result = generateCameraFocusSvg({ target: "focus-on-exiting" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("EXITING");
      expect(decoded).toContain("FOCUS");
    });

    it("should include POSITION and SWITCH labels for switch-by-position", () => {
      const result = generateCameraFocusSvg({ target: "switch-by-position" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("POSITION");
      expect(decoded).toContain("SWITCH");
    });

    it("should include CAR # and SWITCH labels for switch-by-car-number", () => {
      const result = generateCameraFocusSvg({ target: "switch-by-car-number" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("CAR #");
      expect(decoded).toContain("SWITCH");
    });

    it("should include CAM STATE and SET labels for set-camera-state", () => {
      const result = generateCameraFocusSvg({ target: "set-camera-state" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("CAM STATE");
      expect(decoded).toContain("SET");
    });
  });
});
