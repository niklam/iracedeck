import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSetupHybridSvg, SETUP_HYBRID_GLOBAL_KEYS, SetupHybrid } from "./setup-hybrid.js";

vi.mock("@iracedeck/icons/setup-hybrid/mguk-regen-gain-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-hybrid/mguk-regen-gain-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-hybrid/mguk-deploy-mode-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-hybrid/mguk-deploy-mode-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-hybrid/mguk-fixed-deploy-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-hybrid/mguk-fixed-deploy-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-hybrid/hys-boost.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-hybrid/hys-regen.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-hybrid/hys-no-boost.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
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
    pressKeyCombination: vi.fn().mockResolvedValue(true),
    releaseKeyCombination: vi.fn().mockResolvedValue(true),
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

describe("SetupHybrid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SETUP_HYBRID_GLOBAL_KEYS", () => {
    it("should have correct mapping for mguk-regen-gain-increase", () => {
      expect(SETUP_HYBRID_GLOBAL_KEYS["mguk-regen-gain-increase"]).toBe("setupHybridMgukRegenGainIncrease");
    });

    it("should have correct mapping for mguk-regen-gain-decrease", () => {
      expect(SETUP_HYBRID_GLOBAL_KEYS["mguk-regen-gain-decrease"]).toBe("setupHybridMgukRegenGainDecrease");
    });

    it("should have correct mapping for mguk-deploy-mode-increase", () => {
      expect(SETUP_HYBRID_GLOBAL_KEYS["mguk-deploy-mode-increase"]).toBe("setupHybridMgukDeployModeIncrease");
    });

    it("should have correct mapping for mguk-deploy-mode-decrease", () => {
      expect(SETUP_HYBRID_GLOBAL_KEYS["mguk-deploy-mode-decrease"]).toBe("setupHybridMgukDeployModeDecrease");
    });

    it("should have correct mapping for mguk-fixed-deploy-increase", () => {
      expect(SETUP_HYBRID_GLOBAL_KEYS["mguk-fixed-deploy-increase"]).toBe("setupHybridMgukFixedDeployIncrease");
    });

    it("should have correct mapping for mguk-fixed-deploy-decrease", () => {
      expect(SETUP_HYBRID_GLOBAL_KEYS["mguk-fixed-deploy-decrease"]).toBe("setupHybridMgukFixedDeployDecrease");
    });

    it("should have correct mapping for hys-boost", () => {
      expect(SETUP_HYBRID_GLOBAL_KEYS["hys-boost"]).toBe("setupHybridHysBoost");
    });

    it("should have correct mapping for hys-regen", () => {
      expect(SETUP_HYBRID_GLOBAL_KEYS["hys-regen"]).toBe("setupHybridHysRegen");
    });

    it("should have correct mapping for hys-no-boost", () => {
      expect(SETUP_HYBRID_GLOBAL_KEYS["hys-no-boost"]).toBe("setupHybridHysNoBoost");
    });

    it("should have exactly 9 entries", () => {
      expect(Object.keys(SETUP_HYBRID_GLOBAL_KEYS)).toHaveLength(9);
    });
  });

  describe("generateSetupHybridSvg", () => {
    it("should generate a valid data URI for mguk-regen-gain", () => {
      const result = generateSetupHybridSvg({ setting: "mguk-regen-gain", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for hys-boost", () => {
      const result = generateSetupHybridSvg({ setting: "hys-boost", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for hys-no-boost", () => {
      const result = generateSetupHybridSvg({ setting: "hys-no-boost", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all setting + direction combinations", () => {
      const settings = [
        "mguk-regen-gain",
        "mguk-deploy-mode",
        "mguk-fixed-deploy",
        "hys-boost",
        "hys-regen",
        "hys-no-boost",
      ] as const;
      const directions = ["increase", "decrease"] as const;

      for (const setting of settings) {
        for (const direction of directions) {
          const result = generateSetupHybridSvg({ setting, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different settings", () => {
      const regenGain = generateSetupHybridSvg({ setting: "mguk-regen-gain", direction: "increase" });
      const hysBoost = generateSetupHybridSvg({ setting: "hys-boost", direction: "increase" });

      expect(regenGain).not.toBe(hysBoost);
    });

    it("should produce different icons for increase vs decrease on directional controls", () => {
      const increase = generateSetupHybridSvg({ setting: "mguk-regen-gain", direction: "increase" });
      const decrease = generateSetupHybridSvg({ setting: "mguk-regen-gain", direction: "decrease" });

      expect(increase).not.toBe(decrease);
    });

    it("should produce same icon for non-directional controls regardless of direction", () => {
      const increase = generateSetupHybridSvg({ setting: "hys-boost", direction: "increase" });
      const decrease = generateSetupHybridSvg({ setting: "hys-boost", direction: "decrease" });

      expect(increase).toBe(decrease);
    });

    it("should produce same icon for toggle control regardless of direction", () => {
      const increase = generateSetupHybridSvg({ setting: "hys-no-boost", direction: "increase" });
      const decrease = generateSetupHybridSvg({ setting: "hys-no-boost", direction: "decrease" });

      expect(increase).toBe(decrease);
    });

    it("should include correct labels for mguk-regen-gain increase", () => {
      const result = generateSetupHybridSvg({ setting: "mguk-regen-gain", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("REGEN GAIN");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for mguk-regen-gain decrease", () => {
      const result = generateSetupHybridSvg({ setting: "mguk-regen-gain", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("REGEN GAIN");
      expect(decoded).toContain("DECREASE");
    });

    it("should include correct labels for hys-boost", () => {
      const result = generateSetupHybridSvg({ setting: "hys-boost", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("HYS");
      expect(decoded).toContain("BOOST");
    });

    it("should include correct labels for hys-no-boost", () => {
      const result = generateSetupHybridSvg({ setting: "hys-no-boost", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("HYS");
      expect(decoded).toContain("NO BOOST");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { mainLabel: string; subLabel: string }>> = {
        "mguk-regen-gain": {
          increase: { mainLabel: "REGEN GAIN", subLabel: "INCREASE" },
          decrease: { mainLabel: "REGEN GAIN", subLabel: "DECREASE" },
        },
        "mguk-deploy-mode": {
          increase: { mainLabel: "DEPLOY MODE", subLabel: "INCREASE" },
          decrease: { mainLabel: "DEPLOY MODE", subLabel: "DECREASE" },
        },
        "mguk-fixed-deploy": {
          increase: { mainLabel: "FIXED DEPLOY", subLabel: "INCREASE" },
          decrease: { mainLabel: "FIXED DEPLOY", subLabel: "DECREASE" },
        },
        "hys-boost": {
          increase: { mainLabel: "HYS", subLabel: "BOOST" },
          decrease: { mainLabel: "HYS", subLabel: "BOOST" },
        },
        "hys-regen": {
          increase: { mainLabel: "HYS", subLabel: "REGEN" },
          decrease: { mainLabel: "HYS", subLabel: "REGEN" },
        },
        "hys-no-boost": {
          increase: { mainLabel: "HYS", subLabel: "NO BOOST" },
          decrease: { mainLabel: "HYS", subLabel: "NO BOOST" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupHybridSvg({
            setting: setting as any,
            direction: direction as any,
          });
          const decoded = decodeURIComponent(result);

          expect(decoded).toContain(labels.mainLabel);
          expect(decoded).toContain(labels.subLabel);
        }
      }
    });
  });

  describe("tap behavior", () => {
    let action: SetupHybrid;

    beforeEach(() => {
      action = new SetupHybrid();
    });

    it("should call tapGlobalBinding on keyDown for mguk-regen-gain increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "mguk-regen-gain", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupHybridMgukRegenGainIncrease");
    });

    it("should call tapGlobalBinding on keyDown for mguk-deploy-mode decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "mguk-deploy-mode", direction: "decrease" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupHybridMgukDeployModeDecrease");
    });

    it("should call tapGlobalBinding on keyDown for mguk-fixed-deploy increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "mguk-fixed-deploy", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupHybridMgukFixedDeployIncrease");
    });

    it("should call tapGlobalBinding on keyDown for hys-no-boost (toggle)", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-no-boost" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupHybridHysNoBoost");
    });

    it("should call tapGlobalBinding on dialDown for directional controls", async () => {
      await action.onDialDown(fakeEvent("action-1", { setting: "mguk-regen-gain", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupHybridMgukRegenGainIncrease");
    });

    it("should call tapGlobalBinding on dialDown for toggle control", async () => {
      await action.onDialDown(fakeEvent("action-1", { setting: "hys-no-boost" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupHybridHysNoBoost");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "mguk-regen-gain", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupHybridMgukRegenGainIncrease");
    });

    it("should call tapGlobalBinding for toggle settings", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-no-boost" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("setupHybridHysNoBoost");
    });
  });

  describe("hold behavior", () => {
    let action: SetupHybrid;

    beforeEach(() => {
      action = new SetupHybrid();
    });

    it("should call holdGlobalBinding on keyDown for hys-boost", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(action.holdBinding).toHaveBeenCalledWith("action-1", "setupHybridHysBoost");
      expect(action.tapBinding).not.toHaveBeenCalled();
    });

    it("should call holdGlobalBinding on keyDown for hys-regen", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-regen" }) as any);

      expect(action.holdBinding).toHaveBeenCalledWith("action-1", "setupHybridHysRegen");
      expect(action.tapBinding).not.toHaveBeenCalled();
    });

    it("should call releaseHeldBinding on keyUp after keyDown for hold controls", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);
      await action.onKeyUp(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(action.releaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should call holdGlobalBinding on dialDown for hold controls", async () => {
      await action.onDialDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(action.holdBinding).toHaveBeenCalledOnce();
    });

    it("should call releaseHeldBinding on dialUp after dialDown for hold controls", async () => {
      await action.onDialDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);
      await action.onDialUp(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(action.releaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should release held key on onWillDisappear", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);
      await action.onWillDisappear(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(action.releaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should track multiple action contexts independently", async () => {
      // Press hys-boost on action-1
      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      // Press hys-regen on action-2
      await action.onKeyDown(fakeEvent("action-2", { setting: "hys-regen" }) as any);

      expect(action.holdBinding).toHaveBeenCalledTimes(2);

      // Release action-1 only
      await action.onKeyUp(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(action.releaseBinding).toHaveBeenCalledTimes(1);
      expect(action.releaseBinding).toHaveBeenCalledWith("action-1");

      // Release action-2
      await action.onKeyUp(fakeEvent("action-2", { setting: "hys-regen" }) as any);

      expect(action.releaseBinding).toHaveBeenCalledTimes(2);
      expect(action.releaseBinding).toHaveBeenCalledWith("action-2");
    });

    it("should call releaseHeldBinding on keyUp even when no key is held", async () => {
      await action.onKeyUp(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(action.releaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should call holdGlobalBinding even when no key binding is configured for hold controls", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(action.holdBinding).toHaveBeenCalledWith("action-1", "setupHybridHysBoost");
    });
  });

  describe("encoder behavior", () => {
    let action: SetupHybrid;

    beforeEach(() => {
      action = new SetupHybrid();
    });

    it("should call tapGlobalBinding for increase on clockwise rotation for directional controls", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "mguk-regen-gain", direction: "increase" }, 1) as any,
      );

      expect(action.tapBinding).toHaveBeenCalledWith("setupHybridMgukRegenGainIncrease");
    });

    it("should call tapGlobalBinding for decrease on counter-clockwise rotation for directional controls", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "mguk-regen-gain", direction: "increase" }, -1) as any,
      );

      expect(action.tapBinding).toHaveBeenCalledWith("setupHybridMgukRegenGainDecrease");
    });

    it("should call tapGlobalBinding for mguk-deploy-mode rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "mguk-deploy-mode", direction: "increase" }, 2) as any,
      );

      expect(action.tapBinding).toHaveBeenCalledWith("setupHybridMgukDeployModeIncrease");
    });

    it("should ignore rotation for hold controls (hys-boost)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "hys-boost" }, 1) as any);

      expect(action.tapBinding).not.toHaveBeenCalled();
      expect(action.holdBinding).not.toHaveBeenCalled();
    });

    it("should ignore rotation for hold controls (hys-regen)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "hys-regen" }, -1) as any);

      expect(action.tapBinding).not.toHaveBeenCalled();
      expect(action.holdBinding).not.toHaveBeenCalled();
    });

    it("should ignore rotation for toggle control (hys-no-boost)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "hys-no-boost" }, 1) as any);

      expect(action.tapBinding).not.toHaveBeenCalled();
    });
  });
});
