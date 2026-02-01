import { beforeEach, describe, expect, it, vi } from "vitest";

import { CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS, generateCameraEditorControlsSvg } from "./camera-editor-controls.js";

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

const ALL_CONTROLS = [
  "open-camera-tool",
  "key-acceleration-toggle",
  "key-10x-toggle",
  "parabolic-mic-toggle",
  "cycle-position-type",
  "cycle-aim-type",
  "acquire-start",
  "acquire-end",
  "temporary-edits-toggle",
  "dampening-toggle",
  "zoom-toggle",
  "beyond-fence-toggle",
  "in-cockpit-toggle",
  "mouse-navigation-toggle",
  "pitch-gyro-toggle",
  "roll-gyro-toggle",
  "limit-shot-range-toggle",
  "show-camera-toggle",
  "shot-selection-toggle",
  "manual-focus-toggle",
  "insert-camera",
  "remove-camera",
  "copy-camera",
  "paste-camera",
  "copy-group",
  "paste-group",
  "save-track-camera",
  "load-track-camera",
  "save-car-camera",
  "load-car-camera",
] as const;

describe("CameraEditorControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS", () => {
    it("should have exactly 30 control types", () => {
      expect(Object.keys(CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS)).toHaveLength(30);
    });

    it("should have correct mapping for open-camera-tool", () => {
      expect(CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS["open-camera-tool"]).toBe("camCtrlOpenCameraTool");
    });

    it("should have correct mapping for key-acceleration-toggle", () => {
      expect(CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS["key-acceleration-toggle"]).toBe("camCtrlKeyAccelerationToggle");
    });

    it("should have correct mapping for insert-camera", () => {
      expect(CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS["insert-camera"]).toBe("camCtrlInsertCamera");
    });

    it("should have correct mapping for save-track-camera", () => {
      expect(CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS["save-track-camera"]).toBe("camCtrlSaveTrackCamera");
    });

    it("should have correct mapping for load-car-camera", () => {
      expect(CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS["load-car-camera"]).toBe("camCtrlLoadCarCamera");
    });

    it("should use camCtrl prefix for all global keys", () => {
      for (const [_control, key] of Object.entries(CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS)) {
        expect(key).toMatch(/^camCtrl/);
      }
    });

    it("should have unique global keys for all controls", () => {
      const values = Object.values(CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS);
      const uniqueValues = new Set(values);

      expect(uniqueValues.size).toBe(values.length);
    });
  });

  describe("generateCameraEditorControlsSvg", () => {
    it("should generate a valid data URI for open-camera-tool", () => {
      const result = generateCameraEditorControlsSvg({ control: "open-camera-tool" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all 30 controls", () => {
      for (const control of ALL_CONTROLS) {
        const result = generateCameraEditorControlsSvg({ control });

        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different controls", () => {
      const openTool = generateCameraEditorControlsSvg({ control: "open-camera-tool" });
      const insertCamera = generateCameraEditorControlsSvg({ control: "insert-camera" });

      expect(openTool).not.toBe(insertCamera);
    });

    it("should include correct labels for open-camera-tool", () => {
      const result = generateCameraEditorControlsSvg({ control: "open-camera-tool" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("OPEN");
      expect(decoded).toContain("CAM TOOL");
    });

    it("should include correct labels for insert-camera", () => {
      const result = generateCameraEditorControlsSvg({ control: "insert-camera" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("INSERT");
      expect(decoded).toContain("CAMERA");
    });

    it("should include correct labels for all controls", () => {
      const expectedLabels: Record<string, { line1: string; line2: string }> = {
        "open-camera-tool": { line1: "OPEN", line2: "CAM TOOL" },
        "key-acceleration-toggle": { line1: "KEY ACCEL", line2: "TOGGLE" },
        "key-10x-toggle": { line1: "KEY 10X", line2: "TOGGLE" },
        "parabolic-mic-toggle": { line1: "PARA MIC", line2: "TOGGLE" },
        "cycle-position-type": { line1: "POS TYPE", line2: "CYCLE" },
        "cycle-aim-type": { line1: "AIM TYPE", line2: "CYCLE" },
        "acquire-start": { line1: "ACQ START", line2: "ACQUIRE" },
        "acquire-end": { line1: "ACQ END", line2: "ACQUIRE" },
        "temporary-edits-toggle": { line1: "TEMP EDIT", line2: "TOGGLE" },
        "dampening-toggle": { line1: "DAMPEN", line2: "TOGGLE" },
        "zoom-toggle": { line1: "ZOOM", line2: "TOGGLE" },
        "beyond-fence-toggle": { line1: "BND FENCE", line2: "TOGGLE" },
        "in-cockpit-toggle": { line1: "IN COCKPIT", line2: "TOGGLE" },
        "mouse-navigation-toggle": { line1: "MOUSE NAV", line2: "TOGGLE" },
        "pitch-gyro-toggle": { line1: "PITCH GYRO", line2: "TOGGLE" },
        "roll-gyro-toggle": { line1: "ROLL GYRO", line2: "TOGGLE" },
        "limit-shot-range-toggle": { line1: "SHOT RNG", line2: "TOGGLE" },
        "show-camera-toggle": { line1: "SHOW CAM", line2: "TOGGLE" },
        "shot-selection-toggle": { line1: "SHOT SEL", line2: "TOGGLE" },
        "manual-focus-toggle": { line1: "MAN FOCUS", line2: "TOGGLE" },
        "insert-camera": { line1: "INSERT", line2: "CAMERA" },
        "remove-camera": { line1: "REMOVE", line2: "CAMERA" },
        "copy-camera": { line1: "COPY", line2: "CAMERA" },
        "paste-camera": { line1: "PASTE", line2: "CAMERA" },
        "copy-group": { line1: "COPY", line2: "GROUP" },
        "paste-group": { line1: "PASTE", line2: "GROUP" },
        "save-track-camera": { line1: "SAVE", line2: "TRACK CAM" },
        "load-track-camera": { line1: "LOAD", line2: "TRACK CAM" },
        "save-car-camera": { line1: "SAVE", line2: "CAR CAM" },
        "load-car-camera": { line1: "LOAD", line2: "CAR CAM" },
      };

      for (const [control, labels] of Object.entries(expectedLabels)) {
        const result = generateCameraEditorControlsSvg({
          control: control as (typeof ALL_CONTROLS)[number],
        });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);
        expect(decoded).toContain(labels.line2);
      }
    });
  });
});
