import { beforeEach, describe, expect, it, vi } from "vitest";

import { CAMERA_EDITOR_GLOBAL_KEYS, generateCameraEditorAdjustmentsSvg } from "./camera-editor-adjustments.js";

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

vi.mock("@iracedeck/stream-deck-shared", () => ({
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
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`;
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
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        latitude: {
          increase: { line1: "+", line2: "LATITUDE" },
          decrease: { line1: "-", line2: "LATITUDE" },
        },
        longitude: {
          increase: { line1: "+", line2: "LONGITUDE" },
          decrease: { line1: "-", line2: "LONGITUDE" },
        },
        altitude: {
          increase: { line1: "+", line2: "ALTITUDE" },
          decrease: { line1: "-", line2: "ALTITUDE" },
        },
        yaw: {
          increase: { line1: "+", line2: "YAW" },
          decrease: { line1: "-", line2: "YAW" },
        },
        pitch: {
          increase: { line1: "+", line2: "PITCH" },
          decrease: { line1: "-", line2: "PITCH" },
        },
        "fov-zoom": {
          increase: { line1: "+", line2: "FOV ZOOM" },
          decrease: { line1: "-", line2: "FOV ZOOM" },
        },
        "key-step": {
          increase: { line1: "+", line2: "KEY STEP" },
          decrease: { line1: "-", line2: "KEY STEP" },
        },
        "vanish-x": {
          increase: { line1: "+", line2: "VANISH X" },
          decrease: { line1: "-", line2: "VANISH X" },
        },
        "vanish-y": {
          increase: { line1: "+", line2: "VANISH Y" },
          decrease: { line1: "-", line2: "VANISH Y" },
        },
        "blimp-radius": {
          increase: { line1: "+", line2: "BLIMP RAD" },
          decrease: { line1: "-", line2: "BLIMP RAD" },
        },
        "blimp-velocity": {
          increase: { line1: "+", line2: "BLIMP VEL" },
          decrease: { line1: "-", line2: "BLIMP VEL" },
        },
        "mic-gain": {
          increase: { line1: "+", line2: "MIC GAIN" },
          decrease: { line1: "-", line2: "MIC GAIN" },
        },
        "auto-set-mic-gain": {
          increase: { line1: "AUTO", line2: "MIC GAIN" },
          decrease: { line1: "AUTO", line2: "MIC GAIN" },
        },
        "f-number": {
          increase: { line1: "+", line2: "F-NUMBER" },
          decrease: { line1: "-", line2: "F-NUMBER" },
        },
        "focus-depth": {
          increase: { line1: "+", line2: "FOCUS DEPTH" },
          decrease: { line1: "-", line2: "FOCUS DEPTH" },
        },
      };

      for (const [adjustment, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateCameraEditorAdjustmentsSvg({
            adjustment: adjustment as any,
            direction: direction as any,
          });
          const decoded = decodeURIComponent(result);

          expect(decoded).toContain(labels.line1);
          expect(decoded).toContain(labels.line2);
        }
      }
    });
  });
});
