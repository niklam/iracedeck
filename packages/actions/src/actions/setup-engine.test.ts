import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSetupEngineSvg, SETUP_ENGINE_GLOBAL_KEYS } from "./setup-engine.js";
import { SetupEngine } from "./setup-engine.js";

vi.mock("@iracedeck/icons/setup-engine/engine-power-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">engine-power-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/engine-power-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">engine-power-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/throttle-shaping-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">throttle-shaping-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/throttle-shaping-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">throttle-shaping-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/boost-level-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">boost-level-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/boost-level-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">boost-level-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/launch-rpm-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">launch-rpm-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/launch-rpm-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">launch-rpm-decrease {{mainLabel}} {{subLabel}}</svg>',
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

describe("SetupEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SETUP_ENGINE_GLOBAL_KEYS", () => {
    it("should have correct mapping for engine-power-increase", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["engine-power-increase"]).toBe("setupEngineEnginePowerIncrease");
    });

    it("should have correct mapping for engine-power-decrease", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["engine-power-decrease"]).toBe("setupEngineEnginePowerDecrease");
    });

    it("should have correct mapping for throttle-shaping-increase", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["throttle-shaping-increase"]).toBe("setupEngineThrottleShapingIncrease");
    });

    it("should have correct mapping for throttle-shaping-decrease", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["throttle-shaping-decrease"]).toBe("setupEngineThrottleShapingDecrease");
    });

    it("should have correct mapping for boost-level-increase", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["boost-level-increase"]).toBe("setupEngineBoostLevelIncrease");
    });

    it("should have correct mapping for boost-level-decrease", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["boost-level-decrease"]).toBe("setupEngineBoostLevelDecrease");
    });

    it("should have correct mapping for launch-rpm-increase", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["launch-rpm-increase"]).toBe("setupEngineLaunchRpmIncrease");
    });

    it("should have correct mapping for launch-rpm-decrease", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["launch-rpm-decrease"]).toBe("setupEngineLaunchRpmDecrease");
    });

    it("should have exactly 8 entries", () => {
      expect(Object.keys(SETUP_ENGINE_GLOBAL_KEYS)).toHaveLength(8);
    });
  });

  describe("generateSetupEngineSvg", () => {
    it("should generate a valid data URI for engine-power increase", () => {
      const result = generateSetupEngineSvg({ setting: "engine-power", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for throttle-shaping increase", () => {
      const result = generateSetupEngineSvg({ setting: "throttle-shaping", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for boost-level decrease", () => {
      const result = generateSetupEngineSvg({ setting: "boost-level", direction: "decrease" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all setting + direction combinations", () => {
      const settings = ["engine-power", "throttle-shaping", "boost-level", "launch-rpm"] as const;
      const directions = ["increase", "decrease"] as const;

      for (const setting of settings) {
        for (const direction of directions) {
          const result = generateSetupEngineSvg({ setting, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different settings", () => {
      const enginePower = generateSetupEngineSvg({ setting: "engine-power", direction: "increase" });
      const boostLevel = generateSetupEngineSvg({ setting: "boost-level", direction: "increase" });

      expect(enginePower).not.toBe(boostLevel);
    });

    it("should produce different icons for increase vs decrease", () => {
      const increase = generateSetupEngineSvg({ setting: "engine-power", direction: "increase" });
      const decrease = generateSetupEngineSvg({ setting: "engine-power", direction: "decrease" });

      expect(increase).not.toBe(decrease);
    });

    it("should produce different icons for increase vs decrease on all settings", () => {
      const settings = ["engine-power", "throttle-shaping", "boost-level", "launch-rpm"] as const;

      for (const setting of settings) {
        const increase = generateSetupEngineSvg({ setting, direction: "increase" });
        const decrease = generateSetupEngineSvg({ setting, direction: "decrease" });
        expect(increase).not.toBe(decrease);
      }
    });

    it("should include correct labels for engine-power increase", () => {
      const result = generateSetupEngineSvg({ setting: "engine-power", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("ENG POWER");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for throttle-shaping decrease", () => {
      const result = generateSetupEngineSvg({ setting: "throttle-shaping", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("THROTTLE");
      expect(decoded).toContain("DECREASE");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        "engine-power": {
          increase: { line1: "ENG POWER", line2: "INCREASE" },
          decrease: { line1: "ENG POWER", line2: "DECREASE" },
        },
        "throttle-shaping": {
          increase: { line1: "THROTTLE", line2: "INCREASE" },
          decrease: { line1: "THROTTLE", line2: "DECREASE" },
        },
        "boost-level": {
          increase: { line1: "BOOST", line2: "INCREASE" },
          decrease: { line1: "BOOST", line2: "DECREASE" },
        },
        "launch-rpm": {
          increase: { line1: "LAUNCH RPM", line2: "INCREASE" },
          decrease: { line1: "LAUNCH RPM", line2: "DECREASE" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupEngineSvg({
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
    let action: SetupEngine;

    beforeEach(() => {
      action = new SetupEngine();
    });

    it("should call tapGlobalBinding on keyDown for engine-power increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "engine-power", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupEngineEnginePowerIncrease");
    });

    it("should call tapGlobalBinding for engine-power decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "engine-power", direction: "decrease" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupEngineEnginePowerDecrease");
    });

    it("should call tapGlobalBinding for throttle-shaping increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "throttle-shaping", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupEngineThrottleShapingIncrease");
    });

    it("should call tapGlobalBinding for boost-level increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "boost-level", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupEngineBoostLevelIncrease");
    });

    it("should call tapGlobalBinding for launch-rpm decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "launch-rpm", direction: "decrease" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupEngineLaunchRpmDecrease");
    });

    it("should call tapGlobalBinding on dialDown", async () => {
      await action.onDialDown(fakeEvent("action-1", { setting: "engine-power", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupEngineEnginePowerIncrease");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "engine-power", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupEngineEnginePowerIncrease");
    });

    it("should call tapGlobalBinding for all directional settings", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "boost-level", direction: "decrease" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupEngineBoostLevelDecrease");
    });
  });

  describe("encoder behavior", () => {
    let action: SetupEngine;

    beforeEach(() => {
      action = new SetupEngine();
    });

    it("should call tapGlobalBinding for increase on clockwise rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "engine-power", direction: "increase" }, 1) as any,
      );

      expect(action.tapBinding).toHaveBeenCalledWith("setupEngineEnginePowerIncrease");
    });

    it("should call tapGlobalBinding for decrease on counter-clockwise rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "engine-power", direction: "increase" }, -1) as any,
      );

      expect(action.tapBinding).toHaveBeenCalledWith("setupEngineEnginePowerDecrease");
    });

    it("should call tapGlobalBinding for different settings on rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "throttle-shaping", direction: "increase" }, 2) as any,
      );

      expect(action.tapBinding).toHaveBeenCalledWith("setupEngineThrottleShapingIncrease");
    });
  });
});
