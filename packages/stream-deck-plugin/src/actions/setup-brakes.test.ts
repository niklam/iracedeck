import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSetupBrakesSvg, SETUP_BRAKES_GLOBAL_KEYS } from "./setup-brakes.js";
import { SetupBrakes } from "./setup-brakes.js";

vi.mock("@iracedeck/icons/setup-brakes/abs-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">abs-toggle {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/abs-adjust-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">abs-adjust-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/abs-adjust-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">abs-adjust-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/brake-bias-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">brake-bias-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/brake-bias-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">brake-bias-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/brake-bias-fine-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">brake-bias-fine-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/brake-bias-fine-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">brake-bias-fine-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/peak-brake-bias-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">peak-brake-bias-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/peak-brake-bias-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">peak-brake-bias-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/brake-misc-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">brake-misc-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/brake-misc-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">brake-misc-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/engine-braking-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">engine-braking-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/engine-braking-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">engine-braking-decrease {{mainLabel}} {{subLabel}}</svg>',
}));

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
  CommonSettings: {
    extend: (_fields) => {
      // Return a mock Zod-like schema
      const schema = {
        parse: (data) => ({ flagsOverlay: false, ...data }),
        safeParse: (data) => ({ success: true, data: { flagsOverlay: false, ...data } }),
      };

      return schema;
    },
    parse: (data) => ({ flagsOverlay: false, ...data }),
    safeParse: (data) => ({ success: true, data: { flagsOverlay: false, ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    async onWillAppear() {}
    async onDidReceiveSettings() {}
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

describe("SetupBrakes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SETUP_BRAKES_GLOBAL_KEYS", () => {
    it("should have correct mapping for abs-toggle", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["abs-toggle"]).toBe("setupBrakesAbsToggle");
    });

    it("should have correct mapping for abs-adjust-increase", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["abs-adjust-increase"]).toBe("setupBrakesAbsAdjustIncrease");
    });

    it("should have correct mapping for abs-adjust-decrease", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["abs-adjust-decrease"]).toBe("setupBrakesAbsAdjustDecrease");
    });

    it("should have correct mapping for brake-bias-increase", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-bias-increase"]).toBe("setupBrakesBrakeBiasIncrease");
    });

    it("should have correct mapping for brake-bias-decrease", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-bias-decrease"]).toBe("setupBrakesBrakeBiasDecrease");
    });

    it("should have correct mapping for brake-bias-fine-increase", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-bias-fine-increase"]).toBe("setupBrakesBrakeBiasFineIncrease");
    });

    it("should have correct mapping for brake-bias-fine-decrease", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-bias-fine-decrease"]).toBe("setupBrakesBrakeBiasFineDecrease");
    });

    it("should have correct mapping for peak-brake-bias-increase", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["peak-brake-bias-increase"]).toBe("setupBrakesPeakBrakeBiasIncrease");
    });

    it("should have correct mapping for peak-brake-bias-decrease", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["peak-brake-bias-decrease"]).toBe("setupBrakesPeakBrakeBiasDecrease");
    });

    it("should have correct mapping for brake-misc-increase", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-misc-increase"]).toBe("setupBrakesBrakeMiscIncrease");
    });

    it("should have correct mapping for brake-misc-decrease", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-misc-decrease"]).toBe("setupBrakesBrakeMiscDecrease");
    });

    it("should have correct mapping for engine-braking-increase", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["engine-braking-increase"]).toBe("setupBrakesEngineBrakingIncrease");
    });

    it("should have correct mapping for engine-braking-decrease", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["engine-braking-decrease"]).toBe("setupBrakesEngineBrakingDecrease");
    });

    it("should have exactly 13 entries", () => {
      expect(Object.keys(SETUP_BRAKES_GLOBAL_KEYS)).toHaveLength(13);
    });
  });

  describe("generateSetupBrakesSvg", () => {
    it("should generate a valid data URI for abs-toggle", () => {
      const result = generateSetupBrakesSvg({ setting: "abs-toggle", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for brake-bias", () => {
      const result = generateSetupBrakesSvg({ setting: "brake-bias", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for engine-braking", () => {
      const result = generateSetupBrakesSvg({ setting: "engine-braking", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all setting + direction combinations", () => {
      const settings = [
        "abs-toggle",
        "abs-adjust",
        "brake-bias",
        "brake-bias-fine",
        "peak-brake-bias",
        "brake-misc",
        "engine-braking",
      ] as const;
      const directions = ["increase", "decrease"] as const;

      for (const setting of settings) {
        for (const direction of directions) {
          const result = generateSetupBrakesSvg({ setting, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different settings", () => {
      const absToggle = generateSetupBrakesSvg({ setting: "abs-toggle", direction: "increase" });
      const brakeBias = generateSetupBrakesSvg({ setting: "brake-bias", direction: "increase" });

      expect(absToggle).not.toBe(brakeBias);
    });

    it("should produce different icons for increase vs decrease on directional controls", () => {
      const increase = generateSetupBrakesSvg({ setting: "brake-bias", direction: "increase" });
      const decrease = generateSetupBrakesSvg({ setting: "brake-bias", direction: "decrease" });

      expect(increase).not.toBe(decrease);
    });

    it("should produce same icon for non-directional controls regardless of direction", () => {
      const increase = generateSetupBrakesSvg({ setting: "abs-toggle", direction: "increase" });
      const decrease = generateSetupBrakesSvg({ setting: "abs-toggle", direction: "decrease" });

      expect(increase).toBe(decrease);
    });

    it("should include correct labels for abs-toggle", () => {
      const result = generateSetupBrakesSvg({ setting: "abs-toggle", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("ABS");
      expect(decoded).toContain("TOGGLE");
    });

    it("should include correct labels for brake-bias increase", () => {
      const result = generateSetupBrakesSvg({ setting: "brake-bias", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("BRAKE BIAS");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for brake-bias decrease", () => {
      const result = generateSetupBrakesSvg({ setting: "brake-bias", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("BRAKE BIAS");
      expect(decoded).toContain("DECREASE");
    });

    it("should include correct labels for brake-bias-fine increase", () => {
      const result = generateSetupBrakesSvg({ setting: "brake-bias-fine", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("BIAS FINE");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for engine-braking decrease", () => {
      const result = generateSetupBrakesSvg({ setting: "engine-braking", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("ENG BRAKE");
      expect(decoded).toContain("DECREASE");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        "abs-toggle": {
          increase: { line1: "ABS", line2: "TOGGLE" },
          decrease: { line1: "ABS", line2: "TOGGLE" },
        },
        "abs-adjust": {
          increase: { line1: "ABS", line2: "INCREASE" },
          decrease: { line1: "ABS", line2: "DECREASE" },
        },
        "brake-bias": {
          increase: { line1: "BRAKE BIAS", line2: "INCREASE" },
          decrease: { line1: "BRAKE BIAS", line2: "DECREASE" },
        },
        "brake-bias-fine": {
          increase: { line1: "BIAS FINE", line2: "INCREASE" },
          decrease: { line1: "BIAS FINE", line2: "DECREASE" },
        },
        "peak-brake-bias": {
          increase: { line1: "PEAK BIAS", line2: "INCREASE" },
          decrease: { line1: "PEAK BIAS", line2: "DECREASE" },
        },
        "brake-misc": {
          increase: { line1: "BRAKE MISC", line2: "INCREASE" },
          decrease: { line1: "BRAKE MISC", line2: "DECREASE" },
        },
        "engine-braking": {
          increase: { line1: "ENG BRAKE", line2: "INCREASE" },
          decrease: { line1: "ENG BRAKE", line2: "DECREASE" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupBrakesSvg({
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
    let action: SetupBrakes;

    beforeEach(() => {
      action = new SetupBrakes();
    });

    it("should call sendKeyCombination on keyDown for abs-toggle", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupBrakesAbsToggle: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "a", modifiers: ["ctrl"], code: "KeyA" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "abs-toggle" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "a",
        modifiers: ["ctrl"],
        code: "KeyA",
      });
    });

    it("should call sendKeyCombination for brake-bias increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupBrakesBrakeBiasIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "=", modifiers: [], code: "Equal" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "brake-bias", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "=",
        modifiers: undefined,
        code: "Equal",
      });
    });

    it("should call sendKeyCombination for brake-bias decrease", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupBrakesBrakeBiasDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "-", modifiers: [], code: "Minus" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "brake-bias", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "-",
        modifiers: undefined,
        code: "Minus",
      });
    });

    it("should call sendKeyCombination for abs-adjust increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupBrakesAbsAdjustIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "up", modifiers: [], code: "ArrowUp" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "abs-adjust", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "up",
        modifiers: undefined,
        code: "ArrowUp",
      });
    });

    it("should call sendKeyCombination for engine-braking decrease", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupBrakesEngineBrakingDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "down", modifiers: [], code: "ArrowDown" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "engine-braking", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "down",
        modifiers: undefined,
        code: "ArrowDown",
      });
    });

    it("should call sendKeyCombination for peak-brake-bias increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupBrakesPeakBrakeBiasIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "p", modifiers: ["shift"], code: "KeyP" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "peak-brake-bias", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should call sendKeyCombination for brake-misc decrease", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupBrakesBrakeMiscDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "m", modifiers: [], code: "KeyM" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "brake-misc", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should call sendKeyCombination on dialDown", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupBrakesAbsToggle: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "a", modifiers: ["ctrl"], code: "KeyA" });

      await action.onDialDown(fakeEvent("action-1", { setting: "abs-toggle" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should handle missing key binding gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { setting: "abs-toggle" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should handle missing global key mapping gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { setting: "brake-bias", direction: "increase" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });

  describe("encoder behavior", () => {
    let action: SetupBrakes;

    beforeEach(() => {
      action = new SetupBrakes();
    });

    it("should send increase key on clockwise rotation for directional controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupBrakesBrakeBiasIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "=", modifiers: [], code: "Equal" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "brake-bias", direction: "increase" }, 1) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "=",
        modifiers: undefined,
        code: "Equal",
      });
    });

    it("should send decrease key on counter-clockwise rotation for directional controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupBrakesBrakeBiasDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "-", modifiers: [], code: "Minus" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "brake-bias", direction: "increase" }, -1) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "-",
        modifiers: undefined,
        code: "Minus",
      });
    });

    it("should send correct key for engine-braking rotation", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupBrakesEngineBrakingIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "up", modifiers: [], code: "ArrowUp" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "engine-braking", direction: "increase" }, 2) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should ignore rotation for non-directional controls (abs-toggle)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "abs-toggle" }, 1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });
});
