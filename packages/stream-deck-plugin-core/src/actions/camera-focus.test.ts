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
      switchPos: vi.fn(() => true),
      switchNum: vi.fn(() => true),
      setState: vi.fn(() => true),
      focusOnLeader: vi.fn(() => true),
      focusOnIncident: vi.fn(() => true),
      focusOnExiting: vi.fn(() => true),
    },
  })),
  LogLevel: { Info: 2 },
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`;
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

    it("should include FOCUS YOUR CAR labels for focus-your-car", () => {
      const result = generateCameraFocusSvg({ target: "focus-your-car" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FOCUS");
      expect(decoded).toContain("YOUR CAR");
    });

    it("should include FOCUS LEADER labels for focus-on-leader", () => {
      const result = generateCameraFocusSvg({ target: "focus-on-leader" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FOCUS");
      expect(decoded).toContain("LEADER");
    });

    it("should include FOCUS INCIDENT labels for focus-on-incident", () => {
      const result = generateCameraFocusSvg({ target: "focus-on-incident" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FOCUS");
      expect(decoded).toContain("INCIDENT");
    });

    it("should include FOCUS EXITING labels for focus-on-exiting", () => {
      const result = generateCameraFocusSvg({ target: "focus-on-exiting" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FOCUS");
      expect(decoded).toContain("EXITING");
    });

    it("should include SWITCH POSITION labels for switch-by-position", () => {
      const result = generateCameraFocusSvg({ target: "switch-by-position" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("SWITCH");
      expect(decoded).toContain("POSITION");
    });

    it("should include SWITCH CAR # labels for switch-by-car-number", () => {
      const result = generateCameraFocusSvg({ target: "switch-by-car-number" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("SWITCH");
      expect(decoded).toContain("CAR #");
    });

    it("should include SET CAM STATE labels for set-camera-state", () => {
      const result = generateCameraFocusSvg({ target: "set-camera-state" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("SET");
      expect(decoded).toContain("CAM STATE");
    });
  });
});
