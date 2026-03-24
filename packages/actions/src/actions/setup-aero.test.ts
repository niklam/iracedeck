import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSetupAeroSvg, SETUP_AERO_GLOBAL_KEYS, SetupAero } from "./setup-aero.js";

vi.mock("@iracedeck/icons/setup-aero/front-wing-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">front-wing-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-aero/front-wing-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">front-wing-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-aero/qualifying-tape-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">qualifying-tape-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-aero/qualifying-tape-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">qualifying-tape-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-aero/rear-wing-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rear-wing-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-aero/rear-wing-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rear-wing-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-aero/rf-brake-attached.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rf-brake-attached {{mainLabel}} {{subLabel}}</svg>',
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
    updateKeyImage = vi.fn().mockResolvedValue(true);
    tapBinding = vi.fn().mockResolvedValue(undefined);
    holdBinding = vi.fn().mockResolvedValue(undefined);
    releaseBinding = vi.fn().mockResolvedValue(undefined);
    setActiveBinding = vi.fn();
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) => {
    if (b.modifiers?.length) {
      return `${b.modifiers.join("+")}+${b.key}`;
    }

    return b.key;
  }),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
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

/** Create a minimal fake event with the given action ID and settings. */
function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings },
  };
}

/** Create a minimal fake dial rotate event. */
function fakeDialRotateEvent(actionId: string, settings: Record<string, unknown>, ticks: number) {
  return {
    action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings, ticks },
  };
}

describe("SetupAero", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SETUP_AERO_GLOBAL_KEYS", () => {
    it("should have correct mapping for front-wing-increase", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["front-wing-increase"]).toBe("setupAeroFrontWingIncrease");
    });

    it("should have correct mapping for front-wing-decrease", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["front-wing-decrease"]).toBe("setupAeroFrontWingDecrease");
    });

    it("should have correct mapping for rear-wing-increase", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["rear-wing-increase"]).toBe("setupAeroRearWingIncrease");
    });

    it("should have correct mapping for rear-wing-decrease", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["rear-wing-decrease"]).toBe("setupAeroRearWingDecrease");
    });

    it("should have correct mapping for qualifying-tape-increase", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["qualifying-tape-increase"]).toBe("setupAeroQualifyingTapeIncrease");
    });

    it("should have correct mapping for qualifying-tape-decrease", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["qualifying-tape-decrease"]).toBe("setupAeroQualifyingTapeDecrease");
    });

    it("should have correct mapping for rf-brake-attached", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["rf-brake-attached"]).toBe("setupAeroRfBrakeAttached");
    });

    it("should have exactly 7 entries", () => {
      expect(Object.keys(SETUP_AERO_GLOBAL_KEYS)).toHaveLength(7);
    });
  });

  describe("generateSetupAeroSvg", () => {
    it("should generate a valid data URI for rf-brake-attached", () => {
      const result = generateSetupAeroSvg({ setting: "rf-brake-attached", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for front-wing increase", () => {
      const result = generateSetupAeroSvg({ setting: "front-wing", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all setting + direction combinations", () => {
      const settings = ["front-wing", "rear-wing", "qualifying-tape", "rf-brake-attached"] as const;
      const directions = ["increase", "decrease"] as const;

      for (const setting of settings) {
        for (const direction of directions) {
          const result = generateSetupAeroSvg({ setting, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different settings", () => {
      const frontWing = generateSetupAeroSvg({ setting: "front-wing", direction: "increase" });
      const rfBrake = generateSetupAeroSvg({ setting: "rf-brake-attached", direction: "increase" });

      expect(frontWing).not.toBe(rfBrake);
    });

    it("should produce different icons for increase vs decrease on directional controls", () => {
      const increase = generateSetupAeroSvg({ setting: "front-wing", direction: "increase" });
      const decrease = generateSetupAeroSvg({ setting: "front-wing", direction: "decrease" });

      expect(increase).not.toBe(decrease);
    });

    it("should produce same icon for non-directional controls regardless of direction", () => {
      const increase = generateSetupAeroSvg({ setting: "rf-brake-attached", direction: "increase" });
      const decrease = generateSetupAeroSvg({ setting: "rf-brake-attached", direction: "decrease" });

      expect(increase).toBe(decrease);
    });

    it("should include correct labels for rf-brake-attached", () => {
      const result = generateSetupAeroSvg({ setting: "rf-brake-attached", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("RF BRAKE");
      expect(decoded).toContain("TOGGLE");
    });

    it("should include correct labels for front-wing increase", () => {
      const result = generateSetupAeroSvg({ setting: "front-wing", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FRONT WING");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for front-wing decrease", () => {
      const result = generateSetupAeroSvg({ setting: "front-wing", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FRONT WING");
      expect(decoded).toContain("DECREASE");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        "front-wing": {
          increase: { line1: "FRONT WING", line2: "INCREASE" },
          decrease: { line1: "FRONT WING", line2: "DECREASE" },
        },
        "rear-wing": {
          increase: { line1: "REAR WING", line2: "INCREASE" },
          decrease: { line1: "REAR WING", line2: "DECREASE" },
        },
        "qualifying-tape": {
          increase: { line1: "QUAL TAPE", line2: "INCREASE" },
          decrease: { line1: "QUAL TAPE", line2: "DECREASE" },
        },
        "rf-brake-attached": {
          increase: { line1: "RF BRAKE", line2: "TOGGLE" },
          decrease: { line1: "RF BRAKE", line2: "TOGGLE" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupAeroSvg({
            setting: setting as any,
            direction: direction as any,
          });
          const decoded = decodeURIComponent(result);

          expect(decoded).toContain(labels.line1);
          expect(decoded).toContain(labels.line2);
        }
      }
    });
  });

  describe("tap behavior", () => {
    let action: SetupAero;

    beforeEach(() => {
      action = new SetupAero();
    });

    it("should call tapGlobalBinding on keyDown for rf-brake-attached", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "rf-brake-attached" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupAeroRfBrakeAttached");
    });

    it("should call tapGlobalBinding for front-wing increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "front-wing", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupAeroFrontWingIncrease");
    });

    it("should call tapGlobalBinding for front-wing decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "front-wing", direction: "decrease" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupAeroFrontWingDecrease");
    });

    it("should call tapGlobalBinding for rear-wing increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "rear-wing", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupAeroRearWingIncrease");
    });

    it("should call tapGlobalBinding for qualifying-tape decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "qualifying-tape", direction: "decrease" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupAeroQualifyingTapeDecrease");
    });

    it("should call tapGlobalBinding on dialDown", async () => {
      await action.onDialDown(fakeEvent("action-1", { setting: "rf-brake-attached" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupAeroRfBrakeAttached");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "rf-brake-attached" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupAeroRfBrakeAttached");
    });

    it("should call tapGlobalBinding even when global key mapping exists", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "front-wing", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupAeroFrontWingIncrease");
    });
  });

  describe("encoder behavior", () => {
    let action: SetupAero;

    beforeEach(() => {
      action = new SetupAero();
    });

    it("should call tapGlobalBinding for increase on clockwise rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "front-wing", direction: "increase" }, 1) as any,
      );

      expect(action.tapBinding).toHaveBeenCalledWith("setupAeroFrontWingIncrease");
    });

    it("should call tapGlobalBinding for decrease on counter-clockwise rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "front-wing", direction: "increase" }, -1) as any,
      );

      expect(action.tapBinding).toHaveBeenCalledWith("setupAeroFrontWingDecrease");
    });

    it("should call tapGlobalBinding for different settings on rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "rear-wing", direction: "increase" }, 2) as any,
      );

      expect(action.tapBinding).toHaveBeenCalledWith("setupAeroRearWingIncrease");
    });

    it("should ignore rotation for non-directional controls (rf-brake-attached)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "rf-brake-attached" }, 1) as any);

      expect(action.tapBinding).not.toHaveBeenCalled();
    });
  });
});
