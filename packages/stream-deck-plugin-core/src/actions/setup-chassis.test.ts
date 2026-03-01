import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSetupChassisSvg, SETUP_CHASSIS_GLOBAL_KEYS, SetupChassis } from "./setup-chassis.js";

const { mockSendKeyCombination, mockParseKeyBinding, mockGetGlobalSettings } = vi.hoisted(() => ({
  mockSendKeyCombination: vi.fn().mockResolvedValue(true),
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

describe("SetupChassis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SETUP_CHASSIS_GLOBAL_KEYS", () => {
    it("should have correct mapping for differential-preload-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-preload-increase"]).toBe(
        "setupChassisDifferentialPreloadIncrease",
      );
    });

    it("should have correct mapping for differential-preload-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-preload-decrease"]).toBe(
        "setupChassisDifferentialPreloadDecrease",
      );
    });

    it("should have correct mapping for differential-entry-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-entry-increase"]).toBe("setupChassisDifferentialEntryIncrease");
    });

    it("should have correct mapping for differential-entry-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-entry-decrease"]).toBe("setupChassisDifferentialEntryDecrease");
    });

    it("should have correct mapping for differential-middle-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-middle-increase"]).toBe("setupChassisDifferentialMiddleIncrease");
    });

    it("should have correct mapping for differential-middle-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-middle-decrease"]).toBe("setupChassisDifferentialMiddleDecrease");
    });

    it("should have correct mapping for differential-exit-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-exit-increase"]).toBe("setupChassisDifferentialExitIncrease");
    });

    it("should have correct mapping for differential-exit-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-exit-decrease"]).toBe("setupChassisDifferentialExitDecrease");
    });

    it("should have correct mapping for front-arb-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["front-arb-increase"]).toBe("setupChassisFrontArbIncrease");
    });

    it("should have correct mapping for front-arb-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["front-arb-decrease"]).toBe("setupChassisFrontArbDecrease");
    });

    it("should have correct mapping for rear-arb-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rear-arb-increase"]).toBe("setupChassisRearArbIncrease");
    });

    it("should have correct mapping for rear-arb-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rear-arb-decrease"]).toBe("setupChassisRearArbDecrease");
    });

    it("should have correct mapping for left-spring-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["left-spring-increase"]).toBe("setupChassisLeftSpringIncrease");
    });

    it("should have correct mapping for left-spring-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["left-spring-decrease"]).toBe("setupChassisLeftSpringDecrease");
    });

    it("should have correct mapping for right-spring-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["right-spring-increase"]).toBe("setupChassisRightSpringIncrease");
    });

    it("should have correct mapping for right-spring-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["right-spring-decrease"]).toBe("setupChassisRightSpringDecrease");
    });

    it("should have correct mapping for lf-shock-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["lf-shock-increase"]).toBe("setupChassisLfShockIncrease");
    });

    it("should have correct mapping for lf-shock-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["lf-shock-decrease"]).toBe("setupChassisLfShockDecrease");
    });

    it("should have correct mapping for rf-shock-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rf-shock-increase"]).toBe("setupChassisRfShockIncrease");
    });

    it("should have correct mapping for rf-shock-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rf-shock-decrease"]).toBe("setupChassisRfShockDecrease");
    });

    it("should have correct mapping for lr-shock-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["lr-shock-increase"]).toBe("setupChassisLrShockIncrease");
    });

    it("should have correct mapping for lr-shock-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["lr-shock-decrease"]).toBe("setupChassisLrShockDecrease");
    });

    it("should have correct mapping for rr-shock-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rr-shock-increase"]).toBe("setupChassisRrShockIncrease");
    });

    it("should have correct mapping for rr-shock-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rr-shock-decrease"]).toBe("setupChassisRrShockDecrease");
    });

    it("should have correct mapping for power-steering-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["power-steering-increase"]).toBe("setupChassisPowerSteeringIncrease");
    });

    it("should have correct mapping for power-steering-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["power-steering-decrease"]).toBe("setupChassisPowerSteeringDecrease");
    });

    it("should have exactly 26 entries", () => {
      expect(Object.keys(SETUP_CHASSIS_GLOBAL_KEYS)).toHaveLength(26);
    });
  });

  describe("generateSetupChassisSvg", () => {
    it("should generate a valid data URI for differential-preload increase", () => {
      const result = generateSetupChassisSvg({ setting: "differential-preload", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for front-arb increase", () => {
      const result = generateSetupChassisSvg({ setting: "front-arb", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for lf-shock decrease", () => {
      const result = generateSetupChassisSvg({ setting: "lf-shock", direction: "decrease" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all setting + direction combinations", () => {
      const settings = [
        "differential-preload",
        "differential-entry",
        "differential-middle",
        "differential-exit",
        "front-arb",
        "rear-arb",
        "left-spring",
        "right-spring",
        "lf-shock",
        "rf-shock",
        "lr-shock",
        "rr-shock",
        "power-steering",
      ] as const;
      const directions = ["increase", "decrease"] as const;

      for (const setting of settings) {
        for (const direction of directions) {
          const result = generateSetupChassisSvg({ setting, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different settings", () => {
      const diffPreload = generateSetupChassisSvg({ setting: "differential-preload", direction: "increase" });
      const lfShock = generateSetupChassisSvg({ setting: "lf-shock", direction: "increase" });

      expect(diffPreload).not.toBe(lfShock);
    });

    it("should produce different icons for increase vs decrease", () => {
      const increase = generateSetupChassisSvg({ setting: "differential-preload", direction: "increase" });
      const decrease = generateSetupChassisSvg({ setting: "differential-preload", direction: "decrease" });

      expect(increase).not.toBe(decrease);
    });

    it("should produce different icons for increase vs decrease on all settings", () => {
      const settings = [
        "differential-preload",
        "differential-entry",
        "differential-middle",
        "differential-exit",
        "front-arb",
        "rear-arb",
        "left-spring",
        "right-spring",
        "lf-shock",
        "rf-shock",
        "lr-shock",
        "rr-shock",
        "power-steering",
      ] as const;

      for (const setting of settings) {
        const increase = generateSetupChassisSvg({ setting, direction: "increase" });
        const decrease = generateSetupChassisSvg({ setting, direction: "decrease" });
        expect(increase).not.toBe(decrease);
      }
    });

    it("should include correct labels for differential-preload increase", () => {
      const result = generateSetupChassisSvg({ setting: "differential-preload", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("DIFF PRELOAD");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for power-steering decrease", () => {
      const result = generateSetupChassisSvg({ setting: "power-steering", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PWR STEER");
      expect(decoded).toContain("DECREASE");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        "differential-preload": {
          increase: { line1: "DIFF PRELOAD", line2: "INCREASE" },
          decrease: { line1: "DIFF PRELOAD", line2: "DECREASE" },
        },
        "differential-entry": {
          increase: { line1: "DIFF ENTRY", line2: "INCREASE" },
          decrease: { line1: "DIFF ENTRY", line2: "DECREASE" },
        },
        "differential-middle": {
          increase: { line1: "DIFF MIDDLE", line2: "INCREASE" },
          decrease: { line1: "DIFF MIDDLE", line2: "DECREASE" },
        },
        "differential-exit": {
          increase: { line1: "DIFF EXIT", line2: "INCREASE" },
          decrease: { line1: "DIFF EXIT", line2: "DECREASE" },
        },
        "front-arb": {
          increase: { line1: "FRONT ARB", line2: "INCREASE" },
          decrease: { line1: "FRONT ARB", line2: "DECREASE" },
        },
        "rear-arb": {
          increase: { line1: "REAR ARB", line2: "INCREASE" },
          decrease: { line1: "REAR ARB", line2: "DECREASE" },
        },
        "left-spring": {
          increase: { line1: "LEFT SPRING", line2: "INCREASE" },
          decrease: { line1: "LEFT SPRING", line2: "DECREASE" },
        },
        "right-spring": {
          increase: { line1: "RIGHT SPRING", line2: "INCREASE" },
          decrease: { line1: "RIGHT SPRING", line2: "DECREASE" },
        },
        "lf-shock": {
          increase: { line1: "LF SHOCK", line2: "INCREASE" },
          decrease: { line1: "LF SHOCK", line2: "DECREASE" },
        },
        "rf-shock": {
          increase: { line1: "RF SHOCK", line2: "INCREASE" },
          decrease: { line1: "RF SHOCK", line2: "DECREASE" },
        },
        "lr-shock": {
          increase: { line1: "LR SHOCK", line2: "INCREASE" },
          decrease: { line1: "LR SHOCK", line2: "DECREASE" },
        },
        "rr-shock": {
          increase: { line1: "RR SHOCK", line2: "INCREASE" },
          decrease: { line1: "RR SHOCK", line2: "DECREASE" },
        },
        "power-steering": {
          increase: { line1: "PWR STEER", line2: "INCREASE" },
          decrease: { line1: "PWR STEER", line2: "DECREASE" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupChassisSvg({
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
    let action: SetupChassis;

    beforeEach(() => {
      action = new SetupChassis();
    });

    it("should call sendKeyCombination on keyDown for differential-preload increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupChassisDifferentialPreloadIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "a", modifiers: ["ctrl"], code: "KeyA" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "differential-preload", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "a",
        modifiers: ["ctrl"],
        code: "KeyA",
      });
    });

    it("should call sendKeyCombination for differential-preload decrease", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupChassisDifferentialPreloadDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "b", modifiers: [], code: "KeyB" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "differential-preload", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "b",
        modifiers: undefined,
        code: "KeyB",
      });
    });

    it("should call sendKeyCombination for front-arb increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupChassisFrontArbIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "up", modifiers: [], code: "ArrowUp" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "front-arb", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "up",
        modifiers: undefined,
        code: "ArrowUp",
      });
    });

    it("should call sendKeyCombination for lf-shock increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupChassisLfShockIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "=", modifiers: [], code: "Equal" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "lf-shock", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should call sendKeyCombination for power-steering decrease", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupChassisPowerSteeringDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "-", modifiers: [], code: "Minus" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "power-steering", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should call sendKeyCombination on dialDown", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupChassisDifferentialPreloadIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "a", modifiers: ["ctrl"], code: "KeyA" });

      await action.onDialDown(fakeEvent("action-1", { setting: "differential-preload", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should handle missing key binding gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { setting: "differential-preload", direction: "increase" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should handle missing global key mapping gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { setting: "lf-shock", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });

  describe("encoder behavior", () => {
    let action: SetupChassis;

    beforeEach(() => {
      action = new SetupChassis();
    });

    it("should send increase key on clockwise rotation", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupChassisDifferentialPreloadIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "=", modifiers: [], code: "Equal" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "differential-preload", direction: "increase" }, 1) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "=",
        modifiers: undefined,
        code: "Equal",
      });
    });

    it("should send decrease key on counter-clockwise rotation", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupChassisDifferentialPreloadDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "-", modifiers: [], code: "Minus" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "differential-preload", direction: "increase" }, -1) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "-",
        modifiers: undefined,
        code: "Minus",
      });
    });

    it("should send correct key for different settings on rotation", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupChassisFrontArbIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "up", modifiers: [], code: "ArrowUp" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "front-arb", direction: "increase" }, 2) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });
  });
});
