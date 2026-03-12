import { beforeEach, describe, expect, it, vi } from "vitest";

import { CAMERA_EDITOR_GLOBAL_KEYS, generateCameraEditorAdjustmentsSvg } from "./camera-editor-adjustments.js";

vi.mock("@iracedeck/icons/camera-editor-adjustments/latitude-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">latitude-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/latitude-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">latitude-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/longitude-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">longitude-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/longitude-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">longitude-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/altitude-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">altitude-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/altitude-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">altitude-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/yaw-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">yaw-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/yaw-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">yaw-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/pitch-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">pitch-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/pitch-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">pitch-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/fov-zoom-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fov-zoom-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/fov-zoom-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fov-zoom-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/key-step-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">key-step-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/key-step-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">key-step-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/vanish-x-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">vanish-x-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/vanish-x-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">vanish-x-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/vanish-y-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">vanish-y-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/vanish-y-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">vanish-y-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/blimp-radius-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">blimp-radius-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/blimp-radius-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">blimp-radius-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/blimp-velocity-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">blimp-velocity-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/blimp-velocity-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">blimp-velocity-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/mic-gain-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">mic-gain-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/mic-gain-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">mic-gain-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/auto-set-mic-gain-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">auto-set-mic-gain {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/auto-set-mic-gain-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">auto-set-mic-gain {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/f-number-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">f-number-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/f-number-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">f-number-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/focus-depth-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">focus-depth-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-adjustments/focus-depth-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">focus-depth-decrease {{mainLabel}} {{subLabel}}</svg>',
}));

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
  CommonSettings: {
    extend: (_fields) => {
      // Return a mock Zod-like schema
      const schema = {
        parse: (data) => ({ flagsOverlay: false, ...data }),
        safeParse: (data) => ({ success: true, data: { flagsOverlay: false, ...data } }),
      };

      return schema;
    },
    parse: (data) => ({ flagsOverlay: false, ...data }),
    safeParse: (data) => ({ success: true, data: { flagsOverlay: false, ...data } }),
  },
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
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    return result;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

describe("CameraEditorAdjustments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("CAMERA_EDITOR_GLOBAL_KEYS", () => {
    it("should have exactly 15 adjustment types", () => {
      expect(Object.keys(CAMERA_EDITOR_GLOBAL_KEYS)).toHaveLength(15);
    });

    it("should have increase and decrease for each adjustment type", () => {
      for (const adjustment of Object.values(CAMERA_EDITOR_GLOBAL_KEYS)) {
        expect(adjustment).toHaveProperty("increase");
        expect(adjustment).toHaveProperty("decrease");
      }
    });

    it("should have correct mapping for latitude", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS.latitude.increase).toBe("camEditLatitudeIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS.latitude.decrease).toBe("camEditLatitudeDecrease");
    });

    it("should have correct mapping for longitude", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS.longitude.increase).toBe("camEditLongitudeIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS.longitude.decrease).toBe("camEditLongitudeDecrease");
    });

    it("should have correct mapping for altitude", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS.altitude.increase).toBe("camEditAltitudeIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS.altitude.decrease).toBe("camEditAltitudeDecrease");
    });

    it("should have correct mapping for yaw", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS.yaw.increase).toBe("camEditYawIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS.yaw.decrease).toBe("camEditYawDecrease");
    });

    it("should have correct mapping for pitch", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS.pitch.increase).toBe("camEditPitchIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS.pitch.decrease).toBe("camEditPitchDecrease");
    });

    it("should have correct mapping for fov-zoom", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS["fov-zoom"].increase).toBe("camEditFovZoomIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS["fov-zoom"].decrease).toBe("camEditFovZoomDecrease");
    });

    it("should have correct mapping for key-step", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS["key-step"].increase).toBe("camEditKeyStepIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS["key-step"].decrease).toBe("camEditKeyStepDecrease");
    });

    it("should have correct mapping for vanish-x", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS["vanish-x"].increase).toBe("camEditVanishXIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS["vanish-x"].decrease).toBe("camEditVanishXDecrease");
    });

    it("should have correct mapping for vanish-y", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS["vanish-y"].increase).toBe("camEditVanishYIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS["vanish-y"].decrease).toBe("camEditVanishYDecrease");
    });

    it("should have correct mapping for blimp-radius", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS["blimp-radius"].increase).toBe("camEditBlimpRadiusIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS["blimp-radius"].decrease).toBe("camEditBlimpRadiusDecrease");
    });

    it("should have correct mapping for blimp-velocity", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS["blimp-velocity"].increase).toBe("camEditBlimpVelocityIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS["blimp-velocity"].decrease).toBe("camEditBlimpVelocityDecrease");
    });

    it("should have correct mapping for mic-gain", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS["mic-gain"].increase).toBe("camEditMicGainIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS["mic-gain"].decrease).toBe("camEditMicGainDecrease");
    });

    it("should map both directions to the same key for auto-set-mic-gain", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS["auto-set-mic-gain"].increase).toBe("camEditAutoSetMicGain");
      expect(CAMERA_EDITOR_GLOBAL_KEYS["auto-set-mic-gain"].decrease).toBe("camEditAutoSetMicGain");
    });

    it("should have correct mapping for f-number", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS["f-number"].increase).toBe("camEditFNumberIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS["f-number"].decrease).toBe("camEditFNumberDecrease");
    });

    it("should have correct mapping for focus-depth", () => {
      expect(CAMERA_EDITOR_GLOBAL_KEYS["focus-depth"].increase).toBe("camEditFocusDepthIncrease");
      expect(CAMERA_EDITOR_GLOBAL_KEYS["focus-depth"].decrease).toBe("camEditFocusDepthDecrease");
    });
  });

  describe("generateCameraEditorAdjustmentsSvg", () => {
    it("should generate a valid data URI for latitude increase", () => {
      const result = generateCameraEditorAdjustmentsSvg({ adjustment: "latitude", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for auto-set-mic-gain", () => {
      const result = generateCameraEditorAdjustmentsSvg({
        adjustment: "auto-set-mic-gain",
        direction: "increase",
      });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all adjustment + direction combinations", () => {
      const adjustments = [
        "latitude",
        "longitude",
        "altitude",
        "yaw",
        "pitch",
        "fov-zoom",
        "key-step",
        "vanish-x",
        "vanish-y",
        "blimp-radius",
        "blimp-velocity",
        "mic-gain",
        "auto-set-mic-gain",
        "f-number",
        "focus-depth",
      ] as const;
      const directions = ["increase", "decrease"] as const;

      for (const adjustment of adjustments) {
        for (const direction of directions) {
          const result = generateCameraEditorAdjustmentsSvg({ adjustment, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different adjustments", () => {
      const latitude = generateCameraEditorAdjustmentsSvg({ adjustment: "latitude", direction: "increase" });
      const yaw = generateCameraEditorAdjustmentsSvg({ adjustment: "yaw", direction: "increase" });

      expect(latitude).not.toBe(yaw);
    });

    it("should produce different icons for increase vs decrease", () => {
      const increase = generateCameraEditorAdjustmentsSvg({ adjustment: "latitude", direction: "increase" });
      const decrease = generateCameraEditorAdjustmentsSvg({ adjustment: "latitude", direction: "decrease" });

      expect(increase).not.toBe(decrease);
    });

    it("should produce the same icon for auto-set-mic-gain regardless of direction", () => {
      const increase = generateCameraEditorAdjustmentsSvg({
        adjustment: "auto-set-mic-gain",
        direction: "increase",
      });
      const decrease = generateCameraEditorAdjustmentsSvg({
        adjustment: "auto-set-mic-gain",
        direction: "decrease",
      });

      expect(increase).toBe(decrease);
    });

    it("should include correct labels for latitude increase", () => {
      const result = generateCameraEditorAdjustmentsSvg({ adjustment: "latitude", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LATITUDE");
      expect(decoded).toContain("+");
    });

    it("should include correct labels for fov-zoom decrease", () => {
      const result = generateCameraEditorAdjustmentsSvg({ adjustment: "fov-zoom", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FOV ZOOM");
      expect(decoded).toContain("-");
    });

    it("should include correct labels for auto-set-mic-gain", () => {
      const result = generateCameraEditorAdjustmentsSvg({
        adjustment: "auto-set-mic-gain",
        direction: "increase",
      });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("AUTO");
      expect(decoded).toContain("MIC GAIN");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { mainLabel: string; subLabel: string }>> = {
        latitude: {
          increase: { mainLabel: "+", subLabel: "LATITUDE" },
          decrease: { mainLabel: "-", subLabel: "LATITUDE" },
        },
        longitude: {
          increase: { mainLabel: "+", subLabel: "LONGITUDE" },
          decrease: { mainLabel: "-", subLabel: "LONGITUDE" },
        },
        altitude: {
          increase: { mainLabel: "+", subLabel: "ALTITUDE" },
          decrease: { mainLabel: "-", subLabel: "ALTITUDE" },
        },
        yaw: {
          increase: { mainLabel: "+", subLabel: "YAW" },
          decrease: { mainLabel: "-", subLabel: "YAW" },
        },
        pitch: {
          increase: { mainLabel: "+", subLabel: "PITCH" },
          decrease: { mainLabel: "-", subLabel: "PITCH" },
        },
        "fov-zoom": {
          increase: { mainLabel: "+", subLabel: "FOV ZOOM" },
          decrease: { mainLabel: "-", subLabel: "FOV ZOOM" },
        },
        "key-step": {
          increase: { mainLabel: "+", subLabel: "KEY STEP" },
          decrease: { mainLabel: "-", subLabel: "KEY STEP" },
        },
        "vanish-x": {
          increase: { mainLabel: "+", subLabel: "VANISH X" },
          decrease: { mainLabel: "-", subLabel: "VANISH X" },
        },
        "vanish-y": {
          increase: { mainLabel: "+", subLabel: "VANISH Y" },
          decrease: { mainLabel: "-", subLabel: "VANISH Y" },
        },
        "blimp-radius": {
          increase: { mainLabel: "+", subLabel: "BLIMP RAD" },
          decrease: { mainLabel: "-", subLabel: "BLIMP RAD" },
        },
        "blimp-velocity": {
          increase: { mainLabel: "+", subLabel: "BLIMP VEL" },
          decrease: { mainLabel: "-", subLabel: "BLIMP VEL" },
        },
        "mic-gain": {
          increase: { mainLabel: "+", subLabel: "MIC GAIN" },
          decrease: { mainLabel: "-", subLabel: "MIC GAIN" },
        },
        "auto-set-mic-gain": {
          increase: { mainLabel: "AUTO", subLabel: "MIC GAIN" },
          decrease: { mainLabel: "AUTO", subLabel: "MIC GAIN" },
        },
        "f-number": {
          increase: { mainLabel: "+", subLabel: "F-NUMBER" },
          decrease: { mainLabel: "-", subLabel: "F-NUMBER" },
        },
        "focus-depth": {
          increase: { mainLabel: "+", subLabel: "FOCUS DEPTH" },
          decrease: { mainLabel: "-", subLabel: "FOCUS DEPTH" },
        },
      };

      for (const [adjustment, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateCameraEditorAdjustmentsSvg({
            adjustment: adjustment as any,
            direction: direction as any,
          });
          const decoded = decodeURIComponent(result);

          expect(decoded).toContain(labels.mainLabel);
          expect(decoded).toContain(labels.subLabel);
        }
      }
    });
  });
});
