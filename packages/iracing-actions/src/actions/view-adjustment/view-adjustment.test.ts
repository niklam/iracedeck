import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateViewAdjustmentSvg,
  VIEW_ADJUSTMENT_GLOBAL_KEYS,
  ViewAdjustment,
  ViewAdjustmentSettings,
} from "./view-adjustment.js";

const { mockTapBinding, mockBringPointerToSim } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockBringPointerToSim: vi.fn(),
}));

vi.mock("../../shared/mouse-to-sim.js", () => ({
  bringPointerToSim: mockBringPointerToSim,
}));

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
vi.mock("@iracedeck/icons/view-adjustment/mouse-to-sim.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">mouse-to-sim {{mainLabel}} {{subLabel}}</svg>',
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
    setActiveBinding = vi.fn();
    isBindingMissing = vi.fn(() => false);
    tapBinding = mockTapBinding;
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  onGlobalSettingsChange: vi.fn(() => vi.fn()),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseBinding: vi.fn(),
  parseKeyBinding: vi.fn(),
  isSimHubBinding: vi.fn(
    (v: unknown) => v !== null && typeof v === "object" && (v as Record<string, unknown>).type === "simhub",
  ),
  isSimHubInitialized: vi.fn(() => false),
  getSimHub: vi.fn(() => ({
    startRole: vi.fn().mockResolvedValue(true),
    stopRole: vi.fn().mockResolvedValue(true),
  })),
  getGlobalTitleSettings: vi.fn(() => ({})),
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
  resolveBorderSettings: vi.fn((_svg: unknown, _global: unknown, _overrides?: unknown, _stateColor?: string) => ({
    enabled: false,
    borderWidth: 7,
    borderColor: "#00aaff",
    glowEnabled: true,
    glowWidth: 18,
  })),
  resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
  resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle?: string) => ({
    showTitle: true,
    showGraphics: true,
    titleText: defaultTitle ?? "",
    bold: true,
    fontSize: 18,
    position: "bottom" as const,
    customPosition: 0,
  })),
  assembleIcon: vi.fn(
    ({ graphicSvg, title }: { graphicSvg: string; colors: unknown; title: { titleText: string } }) => {
      const encoded = encodeURIComponent(`<svg>${graphicSvg}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
}));

describe("ViewAdjustment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("VIEW_ADJUSTMENT_GLOBAL_KEYS", () => {
    it("should have correct mapping for fov increase", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS.fov?.increase).toBe("viewAdjustFovIncrease");
    });

    it("should have correct mapping for fov decrease", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS.fov?.decrease).toBe("viewAdjustFovDecrease");
    });

    it("should have correct mapping for horizon up", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS.horizon?.increase).toBe("viewAdjustHorizonUp");
    });

    it("should have correct mapping for horizon down", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS.horizon?.decrease).toBe("viewAdjustHorizonDown");
    });

    it("should have correct mapping for driver height up", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["driver-height"]?.increase).toBe("viewAdjustDriverHeightUp");
    });

    it("should have correct mapping for driver height down", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["driver-height"]?.decrease).toBe("viewAdjustDriverHeightDown");
    });

    it("should have correct mapping for recenter VR", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["recenter-vr"]?.increase).toBe("viewAdjustRecenterVr");
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["recenter-vr"]?.decrease).toBe("viewAdjustRecenterVr");
    });

    it("should have correct mapping for UI size increase", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["ui-size"]?.increase).toBe("viewAdjustUiSizeIncrease");
    });

    it("should have correct mapping for UI size decrease", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["ui-size"]?.decrease).toBe("viewAdjustUiSizeDecrease");
    });

    it("should map exactly the 5 binding-backed adjustment types", () => {
      // Six modes exist; mouse-to-sim is deliberately absent because it is a
      // native window/pointer call with no iRacing command and no key binding (#926).
      expect(Object.keys(VIEW_ADJUSTMENT_GLOBAL_KEYS)).toHaveLength(5);
    });

    it("should have no mapping for mouse-to-sim", () => {
      expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["mouse-to-sim"]).toBeUndefined();
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
      const result = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({ adjustment: "fov", direction: "increase" }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for recenter-vr", () => {
      const result = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({
          adjustment: "recenter-vr",
          direction: "increase",
        }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all adjustment + direction combinations", () => {
      const adjustments = ["fov", "horizon", "driver-height", "recenter-vr", "ui-size", "mouse-to-sim"] as const;
      const directions = ["increase", "decrease"] as const;

      for (const adjustment of adjustments) {
        for (const direction of directions) {
          const result = generateViewAdjustmentSvg(ViewAdjustmentSettings.parse({ adjustment, direction }));
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should generate a valid data URI for mouse-to-sim", () => {
      const result = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({
          adjustment: "mouse-to-sim",
          direction: "increase",
        }),
      );

      expect(result).toContain("data:image/svg+xml");
      expect(decodeURIComponent(result)).toContain("mouse-to-sim");
    });

    it("should use the same mouse-to-sim icon for both directions", () => {
      const increase = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({ adjustment: "mouse-to-sim", direction: "increase" }),
      );
      const decrease = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({ adjustment: "mouse-to-sim", direction: "decrease" }),
      );

      expect(increase).toBe(decrease);
    });

    it("should produce different icons for different adjustments", () => {
      const fov = generateViewAdjustmentSvg(ViewAdjustmentSettings.parse({ adjustment: "fov", direction: "increase" }));
      const horizon = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({ adjustment: "horizon", direction: "increase" }),
      );

      expect(fov).not.toBe(horizon);
    });

    it("should produce different icons for increase vs decrease", () => {
      const increase = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({ adjustment: "fov", direction: "increase" }),
      );
      const decrease = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({ adjustment: "fov", direction: "decrease" }),
      );

      expect(increase).not.toBe(decrease);
    });

    it("should produce the same icon for recenter-vr regardless of direction", () => {
      const increase = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({
          adjustment: "recenter-vr",
          direction: "increase",
        }),
      );
      const decrease = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({
          adjustment: "recenter-vr",
          direction: "decrease",
        }),
      );

      expect(increase).toBe(decrease);
    });

    it("should include correct labels for FOV increase", () => {
      const result = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({ adjustment: "fov", direction: "increase" }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FOV");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for horizon down", () => {
      const result = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({ adjustment: "horizon", direction: "decrease" }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("HORIZON");
      expect(decoded).toContain("DOWN");
    });

    it("should include correct labels for recenter VR", () => {
      const result = generateViewAdjustmentSvg(
        ViewAdjustmentSettings.parse({
          adjustment: "recenter-vr",
          direction: "increase",
        }),
      );
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
        "mouse-to-sim": {
          increase: { line1: "TO SIM", line2: "MOUSE" },
          decrease: { line1: "TO SIM", line2: "MOUSE" },
        },
      };

      for (const [adjustment, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateViewAdjustmentSvg(
            ViewAdjustmentSettings.parse({
              adjustment: adjustment,
              direction: direction,
            }),
          );
          const decoded = decodeURIComponent(result);

          expect(decoded).toContain(labels.line1);
          expect(decoded).toContain(labels.line2);
        }
      }
    });
  });

  describe("keypad dispatch", () => {
    function keyEvent(settings: Record<string, unknown>) {
      return { action: { id: "k1", isKey: () => true, isDial: () => false }, payload: { settings } } as never;
    }

    it("taps the mapped binding for a directional mode", async () => {
      const action = new ViewAdjustment({} as never);

      await action.onKeyDown(keyEvent({ adjustment: "fov", direction: "increase" }));

      expect(mockTapBinding).toHaveBeenCalledWith("viewAdjustFovIncrease");
      expect(mockBringPointerToSim).not.toHaveBeenCalled();
    });

    it("brings the pointer to the sim for mouse-to-sim and taps no binding (#926)", async () => {
      const action = new ViewAdjustment({} as never);

      await action.onKeyDown(keyEvent({ adjustment: "mouse-to-sim", direction: "increase" }));

      expect(mockBringPointerToSim).toHaveBeenCalledTimes(1);
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("ignores the stored direction for mouse-to-sim (it is non-directional)", async () => {
      const action = new ViewAdjustment({} as never);

      await action.onKeyDown(keyEvent({ adjustment: "mouse-to-sim", direction: "decrease" }));

      expect(mockBringPointerToSim).toHaveBeenCalledTimes(1);
      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });
});
