import { beforeEach, describe, expect, it, vi } from "vitest";

import { CAMERA_EDITOR_CONTROLS_GLOBAL_KEYS, generateCameraEditorControlsSvg } from "./camera-editor-controls.js";

vi.mock("@iracedeck/icons/camera-editor-controls/open-camera-tool.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/key-acceleration-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/key-10x-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/parabolic-mic-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/cycle-position-type.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/cycle-aim-type.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/acquire-start.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/acquire-end.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/temporary-edits-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/dampening-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/zoom-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/beyond-fence-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/in-cockpit-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/mouse-navigation-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/pitch-gyro-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/roll-gyro-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/limit-shot-range-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/show-camera-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/shot-selection-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/manual-focus-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/insert-camera.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/remove-camera.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/copy-camera.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/paste-camera.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/copy-group.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/paste-group.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/save-track-camera.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/load-track-camera.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/save-car-camera.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-editor-controls/load-car-camera.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
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
      const expectedLabels: Record<string, { mainLabel: string; subLabel: string }> = {
        "open-camera-tool": { mainLabel: "OPEN", subLabel: "CAM TOOL" },
        "key-acceleration-toggle": { mainLabel: "KEY ACCEL", subLabel: "TOGGLE" },
        "key-10x-toggle": { mainLabel: "KEY 10X", subLabel: "TOGGLE" },
        "parabolic-mic-toggle": { mainLabel: "PARA MIC", subLabel: "TOGGLE" },
        "cycle-position-type": { mainLabel: "POS TYPE", subLabel: "CYCLE" },
        "cycle-aim-type": { mainLabel: "AIM TYPE", subLabel: "CYCLE" },
        "acquire-start": { mainLabel: "ACQ START", subLabel: "ACQUIRE" },
        "acquire-end": { mainLabel: "ACQ END", subLabel: "ACQUIRE" },
        "temporary-edits-toggle": { mainLabel: "TEMP EDIT", subLabel: "TOGGLE" },
        "dampening-toggle": { mainLabel: "DAMPEN", subLabel: "TOGGLE" },
        "zoom-toggle": { mainLabel: "ZOOM", subLabel: "TOGGLE" },
        "beyond-fence-toggle": { mainLabel: "BND FENCE", subLabel: "TOGGLE" },
        "in-cockpit-toggle": { mainLabel: "IN COCKPIT", subLabel: "TOGGLE" },
        "mouse-navigation-toggle": { mainLabel: "MOUSE NAV", subLabel: "TOGGLE" },
        "pitch-gyro-toggle": { mainLabel: "PITCH GYRO", subLabel: "TOGGLE" },
        "roll-gyro-toggle": { mainLabel: "ROLL GYRO", subLabel: "TOGGLE" },
        "limit-shot-range-toggle": { mainLabel: "SHOT RNG", subLabel: "TOGGLE" },
        "show-camera-toggle": { mainLabel: "SHOW CAM", subLabel: "TOGGLE" },
        "shot-selection-toggle": { mainLabel: "SHOT SEL", subLabel: "TOGGLE" },
        "manual-focus-toggle": { mainLabel: "MAN FOCUS", subLabel: "TOGGLE" },
        "insert-camera": { mainLabel: "INSERT", subLabel: "CAMERA" },
        "remove-camera": { mainLabel: "REMOVE", subLabel: "CAMERA" },
        "copy-camera": { mainLabel: "COPY", subLabel: "CAMERA" },
        "paste-camera": { mainLabel: "PASTE", subLabel: "CAMERA" },
        "copy-group": { mainLabel: "COPY", subLabel: "GROUP" },
        "paste-group": { mainLabel: "PASTE", subLabel: "GROUP" },
        "save-track-camera": { mainLabel: "SAVE", subLabel: "TRACK CAM" },
        "load-track-camera": { mainLabel: "LOAD", subLabel: "TRACK CAM" },
        "save-car-camera": { mainLabel: "SAVE", subLabel: "CAR CAM" },
        "load-car-camera": { mainLabel: "LOAD", subLabel: "CAR CAM" },
      };

      for (const [control, labels] of Object.entries(expectedLabels)) {
        const result = generateCameraEditorControlsSvg({
          control: control as (typeof ALL_CONTROLS)[number],
        });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.mainLabel);
        expect(decoded).toContain(labels.subLabel);
      }
    });
  });
});
