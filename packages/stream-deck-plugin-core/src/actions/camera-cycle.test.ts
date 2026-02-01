import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateCameraCycleSvg } from "./camera-cycle.js";

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
  getCommands: vi.fn(() => ({
    camera: {
      cycleCamera: vi.fn(() => true),
      cycleSubCamera: vi.fn(() => true),
      cycleCar: vi.fn(() => true),
      cycleDrivingCamera: vi.fn(() => true),
    },
  })),
  LogLevel: { Info: 2 },
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

describe("CameraCycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    it("should include NEXT label for sub-camera/next", () => {
      const result = generateCameraCycleSvg({ cameraType: "sub-camera", direction: "next" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("SUB CAM");
    });

    it("should include PREV label for sub-camera/previous", () => {
      const result = generateCameraCycleSvg({ cameraType: "sub-camera", direction: "previous" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PREV");
      expect(decoded).toContain("SUB CAM");
    });

    it("should include NEXT label for car/next", () => {
      const result = generateCameraCycleSvg({ cameraType: "car", direction: "next" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("CAR");
    });

    it("should include PREV label for car/previous", () => {
      const result = generateCameraCycleSvg({ cameraType: "car", direction: "previous" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PREV");
      expect(decoded).toContain("CAR");
    });

    it("should include NEXT label for driving/next", () => {
      const result = generateCameraCycleSvg({ cameraType: "driving", direction: "next" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("DRIVING");
    });

    it("should include PREV label for driving/previous", () => {
      const result = generateCameraCycleSvg({ cameraType: "driving", direction: "previous" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PREV");
      expect(decoded).toContain("DRIVING");
    });
  });
});
