import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSetupHybridSvg, SETUP_HYBRID_GLOBAL_KEYS, SetupHybrid } from "./setup-hybrid.js";

const {
  mockSendKeyCombination,
  mockPressKeyCombination,
  mockReleaseKeyCombination,
  mockParseKeyBinding,
  mockGetGlobalSettings,
} = vi.hoisted(() => ({
  mockSendKeyCombination: vi.fn().mockResolvedValue(true),
  mockPressKeyCombination: vi.fn().mockResolvedValue(true),
  mockReleaseKeyCombination: vi.fn().mockResolvedValue(true),
  mockParseKeyBinding: vi.fn(),
  mockGetGlobalSettings: vi.fn(() => ({})),
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
    async onWillDisappear() {}
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
  getGlobalSettings: mockGetGlobalSettings,
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: mockSendKeyCombination,
    pressKeyCombination: mockPressKeyCombination,
    releaseKeyCombination: mockReleaseKeyCombination,
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: mockParseKeyBinding,
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.iconContent || ""}${data.labelLine1 || ""}${data.labelLine2 || ""}</svg>`;
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
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        "mguk-regen-gain": {
          increase: { line1: "REGEN GAIN", line2: "INCREASE" },
          decrease: { line1: "REGEN GAIN", line2: "DECREASE" },
        },
        "mguk-deploy-mode": {
          increase: { line1: "DEPLOY MODE", line2: "INCREASE" },
          decrease: { line1: "DEPLOY MODE", line2: "DECREASE" },
        },
        "mguk-fixed-deploy": {
          increase: { line1: "FIXED DEPLOY", line2: "INCREASE" },
          decrease: { line1: "FIXED DEPLOY", line2: "DECREASE" },
        },
        "hys-boost": {
          increase: { line1: "HYS", line2: "BOOST" },
          decrease: { line1: "HYS", line2: "BOOST" },
        },
        "hys-regen": {
          increase: { line1: "HYS", line2: "REGEN" },
          decrease: { line1: "HYS", line2: "REGEN" },
        },
        "hys-no-boost": {
          increase: { line1: "HYS", line2: "NO BOOST" },
          decrease: { line1: "HYS", line2: "NO BOOST" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupHybridSvg({
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
    let action: SetupHybrid;

    beforeEach(() => {
      action = new SetupHybrid();
    });

    it("should call sendKeyCombination on keyDown for mguk-regen-gain increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridMgukRegenGainIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "a", modifiers: ["ctrl"], code: "KeyA" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "mguk-regen-gain", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "a",
        modifiers: ["ctrl"],
        code: "KeyA",
      });
    });

    it("should call sendKeyCombination on keyDown for mguk-deploy-mode decrease", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridMgukDeployModeDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "-", modifiers: [], code: "Minus" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "mguk-deploy-mode", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "-",
        modifiers: undefined,
        code: "Minus",
      });
    });

    it("should call sendKeyCombination on keyDown for mguk-fixed-deploy increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridMgukFixedDeployIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "=", modifiers: [], code: "Equal" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "mguk-fixed-deploy", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "=",
        modifiers: undefined,
        code: "Equal",
      });
    });

    it("should call sendKeyCombination on keyDown for hys-no-boost (toggle)", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridHysNoBoost: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "n", modifiers: [], code: "KeyN" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-no-boost" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "n",
        modifiers: undefined,
        code: "KeyN",
      });
    });

    it("should call sendKeyCombination on dialDown for directional controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridMgukRegenGainIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "a", modifiers: ["ctrl"], code: "KeyA" });

      await action.onDialDown(fakeEvent("action-1", { setting: "mguk-regen-gain", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should call sendKeyCombination on dialDown for toggle control", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridHysNoBoost: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "n", modifiers: [], code: "KeyN" });

      await action.onDialDown(fakeEvent("action-1", { setting: "hys-no-boost" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should handle missing key binding gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { setting: "mguk-regen-gain", direction: "increase" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should handle missing global key mapping gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-no-boost" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });

  describe("hold behavior", () => {
    let action: SetupHybrid;

    beforeEach(() => {
      action = new SetupHybrid();
    });

    it("should call pressKeyCombination on keyDown for hys-boost", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridHysBoost: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "b", modifiers: [], code: "KeyB" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledWith({
        key: "b",
        modifiers: undefined,
        code: "KeyB",
      });
      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should call pressKeyCombination on keyDown for hys-regen", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridHysRegen: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "r", modifiers: [], code: "KeyR" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-regen" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledWith({
        key: "r",
        modifiers: undefined,
        code: "KeyR",
      });
      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should call releaseKeyCombination on keyUp after keyDown for hold controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridHysBoost: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "b", modifiers: [], code: "KeyB" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);
      await action.onKeyUp(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledWith({
        key: "b",
        modifiers: undefined,
        code: "KeyB",
      });
    });

    it("should call pressKeyCombination on dialDown for hold controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridHysBoost: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "b", modifiers: [], code: "KeyB" });

      await action.onDialDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledOnce();
    });

    it("should call releaseKeyCombination on dialUp after dialDown for hold controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridHysBoost: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "b", modifiers: [], code: "KeyB" });

      await action.onDialDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);
      await action.onDialUp(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledOnce();
    });

    it("should release held key on onWillDisappear", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridHysBoost: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "b", modifiers: [], code: "KeyB" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);
      await action.onWillDisappear(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledWith({
        key: "b",
        modifiers: undefined,
        code: "KeyB",
      });
    });

    it("should track multiple action contexts independently", async () => {
      mockGetGlobalSettings.mockReturnValue({
        setupHybridHysBoost: "bound",
        setupHybridHysRegen: "bound2",
      });

      // Press hys-boost on action-1
      mockParseKeyBinding.mockReturnValue({ key: "b", modifiers: [], code: "KeyB" });
      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      // Press hys-regen on action-2
      mockParseKeyBinding.mockReturnValue({ key: "r", modifiers: [], code: "KeyR" });
      await action.onKeyDown(fakeEvent("action-2", { setting: "hys-regen" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledTimes(2);

      // Release action-1 only
      await action.onKeyUp(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledTimes(1);
      expect(mockReleaseKeyCombination).toHaveBeenCalledWith({
        key: "b",
        modifiers: undefined,
        code: "KeyB",
      });

      // Release action-2
      await action.onKeyUp(fakeEvent("action-2", { setting: "hys-regen" }) as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledTimes(2);
      expect(mockReleaseKeyCombination).toHaveBeenCalledWith({
        key: "r",
        modifiers: undefined,
        code: "KeyR",
      });
    });

    it("should not call releaseKeyCombination on keyUp when no key is held", async () => {
      await action.onKeyUp(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
    });

    it("should handle missing key binding for hold controls gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { setting: "hys-boost" }) as any);

      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });
  });

  describe("encoder behavior", () => {
    let action: SetupHybrid;

    beforeEach(() => {
      action = new SetupHybrid();
    });

    it("should send increase key on clockwise rotation for directional controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridMgukRegenGainIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "=", modifiers: [], code: "Equal" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "mguk-regen-gain", direction: "increase" }, 1) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "=",
        modifiers: undefined,
        code: "Equal",
      });
    });

    it("should send decrease key on counter-clockwise rotation for directional controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridMgukRegenGainDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "-", modifiers: [], code: "Minus" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "mguk-regen-gain", direction: "increase" }, -1) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "-",
        modifiers: undefined,
        code: "Minus",
      });
    });

    it("should send correct key for mguk-deploy-mode rotation", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupHybridMgukDeployModeIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "up", modifiers: [], code: "ArrowUp" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "mguk-deploy-mode", direction: "increase" }, 2) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should ignore rotation for hold controls (hys-boost)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "hys-boost" }, 1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should ignore rotation for hold controls (hys-regen)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "hys-regen" }, -1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should ignore rotation for toggle control (hys-no-boost)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "hys-no-boost" }, 1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });
});
