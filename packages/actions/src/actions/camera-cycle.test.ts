import { beforeEach, describe, expect, it, vi } from "vitest";

import { CAMERA_CYCLE_ICONS, CAMERA_CYCLE_LABELS, generateCameraCycleSvg } from "./camera-cycle.js";

vi.mock("@iracedeck/icons/camera-cycle/camera-next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">camera-next {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/camera-previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">camera-previous {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/sub-camera-next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">sub-camera-next {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/sub-camera-previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">sub-camera-previous {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/car-next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">car-next {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/car-previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">car-previous {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/driving-next.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">driving-next {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/camera-cycle/driving-previous.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">driving-previous {{mainLabel}} {{subLabel}}</svg>',
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
  getCommands: vi.fn(() => ({
    camera: {
      cycleCamera: vi.fn(() => true),
      cycleSubCamera: vi.fn(() => true),
      cycleCar: vi.fn(() => true),
      cycleDrivingCamera: vi.fn(() => true),
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

describe("CameraCycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("CAMERA_CYCLE_LABELS", () => {
    it("should have labels for all camera types and directions", () => {
      const cameraTypes = ["camera", "sub-camera", "car", "driving"] as const;
      const directions = ["next", "previous"] as const;

      for (const type of cameraTypes) {
        for (const dir of directions) {
          expect(CAMERA_CYCLE_LABELS[type][dir]).toBeDefined();
          expect(CAMERA_CYCLE_LABELS[type][dir].mainLabel).toBeTruthy();
          expect(CAMERA_CYCLE_LABELS[type][dir].subLabel).toBeTruthy();
        }
      }
    });

    it("should use NEXT/PREV as mainLabel", () => {
      expect(CAMERA_CYCLE_LABELS.camera.next.mainLabel).toBe("NEXT");
      expect(CAMERA_CYCLE_LABELS.camera.previous.mainLabel).toBe("PREV");
    });

    it("should use camera type as subLabel", () => {
      expect(CAMERA_CYCLE_LABELS.camera.next.subLabel).toBe("CAMERA");
      expect(CAMERA_CYCLE_LABELS["sub-camera"].next.subLabel).toBe("SUB CAM");
      expect(CAMERA_CYCLE_LABELS.car.next.subLabel).toBe("CAR");
      expect(CAMERA_CYCLE_LABELS.driving.next.subLabel).toBe("DRIVING");
    });
  });

  describe("CAMERA_CYCLE_ICONS", () => {
    it("should have icons for all camera types and directions", () => {
      const cameraTypes = ["camera", "sub-camera", "car", "driving"] as const;
      const directions = ["next", "previous"] as const;

      for (const type of cameraTypes) {
        for (const dir of directions) {
          expect(CAMERA_CYCLE_ICONS[type][dir]).toBeDefined();
          expect(CAMERA_CYCLE_ICONS[type][dir]).toContain("svg");
        }
      }
    });
  });

  describe("generateCameraCycleSvg", () => {
    const ALL_CAMERA_TYPES = ["camera", "sub-camera", "car", "driving"] as const;
    const ALL_DIRECTIONS = ["next", "previous"] as const;

    const ALL_COMBINATIONS = ALL_CAMERA_TYPES.flatMap((cameraType) =>
      ALL_DIRECTIONS.map((direction) => ({ cameraType, direction })),
    );

    it.each(ALL_COMBINATIONS)(
      "should generate a valid data URI for $cameraType / $direction",
      ({ cameraType, direction }) => {
        const result = generateCameraCycleSvg({ cameraType, direction });

        expect(result).toContain("data:image/svg+xml");
      },
    );

    it("should produce different icons for all 8 combinations", () => {
      const results = ALL_COMBINATIONS.map(({ cameraType, direction }) =>
        generateCameraCycleSvg({ cameraType, direction }),
      );

      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(ALL_COMBINATIONS.length);
    });

    it("should include NEXT label for camera/next", () => {
      const result = generateCameraCycleSvg({ cameraType: "camera", direction: "next" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("CAMERA");
    });

    it("should include PREV label for camera/previous", () => {
      const result = generateCameraCycleSvg({ cameraType: "camera", direction: "previous" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PREV");
      expect(decoded).toContain("CAMERA");
    });

    it("should include correct icon template for each combination", () => {
      const result = generateCameraCycleSvg({ cameraType: "driving", direction: "previous" });

      expect(decodeURIComponent(result)).toContain("driving-previous");
    });
  });
});
