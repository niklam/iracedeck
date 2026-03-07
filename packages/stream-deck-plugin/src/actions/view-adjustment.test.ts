import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateViewAdjustmentSvg, VIEW_ADJUSTMENT_GLOBAL_KEYS } from "./view-adjustment.js";

vi.mock("@iracedeck/icons/view-adjustment/driver-height-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">driver-height-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/view-adjustment/driver-height-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">driver-height-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/view-adjustment/fov-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fov-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/view-adjustment/fov-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fov-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/view-adjustment/horizon-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">horizon-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/view-adjustment/horizon-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">horizon-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/view-adjustment/recenter-vr.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">recenter-vr {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/view-adjustment/ui-size-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">ui-size-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/view-adjustment/ui-size-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">ui-size-increase {{mainLabel}} {{subLabel}}</svg>',
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

describe("ViewAdjustment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("VIEW_ADJUSTMENT_GLOBAL_KEYS", () => {
    it("should have correct mapping for fov increase", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS.fov.increase).toBe("viewAdjustFovIncrease");
    });

    it("should have correct mapping for fov decrease", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS.fov.decrease).toBe("viewAdjustFovDecrease");
    });

    it("should have correct mapping for horizon up", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS.horizon.increase).toBe("viewAdjustHorizonUp");
    });

    it("should have correct mapping for horizon down", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS.horizon.decrease).toBe("viewAdjustHorizonDown");
    });

    it("should have correct mapping for driver height up", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["driver-height"].increase).toBe("viewAdjustDriverHeightUp");
    });

    it("should have correct mapping for driver height down", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["driver-height"].decrease).toBe("viewAdjustDriverHeightDown");
    });

    it("should have correct mapping for recenter VR", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["recenter-vr"].increase).toBe("viewAdjustRecenterVr");
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["recenter-vr"].decrease).toBe("viewAdjustRecenterVr");
    });

    it("should have correct mapping for UI size increase", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["ui-size"].increase).toBe("viewAdjustUiSizeIncrease");
    });

    it("should have correct mapping for UI size decrease", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["ui-size"].decrease).toBe("viewAdjustUiSizeDecrease");
    });

    it("should have exactly 5 adjustment types", () => {
      expect(Object.keys(VIEW_ADJUSTMENT_GLOBAL_KEYS)).toHaveLength(5);
    });

    it("should have increase and decrease for each adjustment type", () => {
      for (const adjustment of Object.values(VIEW_ADJUSTMENT_GLOBAL_KEYS)) {
        expect(adjustment).toHaveProperty("increase");
        expect(adjustment).toHaveProperty("decrease");
      }
    });
  });

  describe("generateViewAdjustmentSvg", () => {
    it("should generate a valid data URI for fov increase", () => {
      const result = generateViewAdjustmentSvg({ adjustment: "fov", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for recenter-vr", () => {
      const result = generateViewAdjustmentSvg({
        adjustment: "recenter-vr",
        direction: "increase",
      });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all adjustment + direction combinations", () => {
      const adjustments = ["fov", "horizon", "driver-height", "recenter-vr", "ui-size"] as const;
      const directions = ["increase", "decrease"] as const;

      for (const adjustment of adjustments) {
        for (const direction of directions) {
          const result = generateViewAdjustmentSvg({ adjustment, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different adjustments", () => {
      const fov = generateViewAdjustmentSvg({ adjustment: "fov", direction: "increase" });
      const horizon = generateViewAdjustmentSvg({ adjustment: "horizon", direction: "increase" });

      expect(fov).not.toBe(horizon);
    });

    it("should produce different icons for increase vs decrease", () => {
      const increase = generateViewAdjustmentSvg({ adjustment: "fov", direction: "increase" });
      const decrease = generateViewAdjustmentSvg({ adjustment: "fov", direction: "decrease" });

      expect(increase).not.toBe(decrease);
    });

    it("should produce the same icon for recenter-vr regardless of direction", () => {
      const increase = generateViewAdjustmentSvg({
        adjustment: "recenter-vr",
        direction: "increase",
      });
      const decrease = generateViewAdjustmentSvg({
        adjustment: "recenter-vr",
        direction: "decrease",
      });

      expect(increase).toBe(decrease);
    });

    it("should include correct labels for FOV increase", () => {
      const result = generateViewAdjustmentSvg({ adjustment: "fov", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FOV");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for horizon down", () => {
      const result = generateViewAdjustmentSvg({ adjustment: "horizon", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("HORIZON");
      expect(decoded).toContain("DOWN");
    });

    it("should include correct labels for recenter VR", () => {
      const result = generateViewAdjustmentSvg({
        adjustment: "recenter-vr",
        direction: "increase",
      });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("RECENTER");
      expect(decoded).toContain("VR VIEW");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        fov: {
          increase: { line1: "INCREASE", line2: "FOV" },
          decrease: { line1: "DECREASE", line2: "FOV" },
        },
        horizon: {
          increase: { line1: "UP", line2: "HORIZON" },
          decrease: { line1: "DOWN", line2: "HORIZON" },
        },
        "driver-height": {
          increase: { line1: "UP", line2: "DRIVER HEIGHT" },
          decrease: { line1: "DOWN", line2: "DRIVER HEIGHT" },
        },
        "recenter-vr": {
          increase: { line1: "RECENTER", line2: "VR VIEW" },
          decrease: { line1: "RECENTER", line2: "VR VIEW" },
        },
        "ui-size": {
          increase: { line1: "INCREASE", line2: "UI SIZE" },
          decrease: { line1: "DECREASE", line2: "UI SIZE" },
        },
      };

      for (const [adjustment, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateViewAdjustmentSvg({
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
