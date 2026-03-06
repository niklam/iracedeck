import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSetupTractionSvg, SETUP_TRACTION_GLOBAL_KEYS, SetupTraction } from "./setup-traction.js";

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

describe("SetupTraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SETUP_TRACTION_GLOBAL_KEYS", () => {
    it("should have correct mapping for tc-toggle", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-toggle"]).toBe("setupTractionTcToggle");
    });

    it("should have correct mapping for tc-slot-1-increase", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-1-increase"]).toBe("setupTractionTcSlot1Increase");
    });

    it("should have correct mapping for tc-slot-1-decrease", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-1-decrease"]).toBe("setupTractionTcSlot1Decrease");
    });

    it("should have correct mapping for tc-slot-2-increase", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-2-increase"]).toBe("setupTractionTcSlot2Increase");
    });

    it("should have correct mapping for tc-slot-2-decrease", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-2-decrease"]).toBe("setupTractionTcSlot2Decrease");
    });

    it("should have correct mapping for tc-slot-3-increase", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-3-increase"]).toBe("setupTractionTcSlot3Increase");
    });

    it("should have correct mapping for tc-slot-3-decrease", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-3-decrease"]).toBe("setupTractionTcSlot3Decrease");
    });

    it("should have correct mapping for tc-slot-4-increase", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-4-increase"]).toBe("setupTractionTcSlot4Increase");
    });

    it("should have correct mapping for tc-slot-4-decrease", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-4-decrease"]).toBe("setupTractionTcSlot4Decrease");
    });

    it("should have exactly 9 entries", () => {
      expect(Object.keys(SETUP_TRACTION_GLOBAL_KEYS)).toHaveLength(9);
    });
  });

  describe("generateSetupTractionSvg", () => {
    it("should generate a valid data URI for tc-toggle", () => {
      const result = generateSetupTractionSvg({ setting: "tc-toggle", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for tc-slot-1 increase", () => {
      const result = generateSetupTractionSvg({ setting: "tc-slot-1", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all setting + direction combinations", () => {
      const settings = ["tc-toggle", "tc-slot-1", "tc-slot-2", "tc-slot-3", "tc-slot-4"] as const;
      const directions = ["increase", "decrease"] as const;

      for (const setting of settings) {
        for (const direction of directions) {
          const result = generateSetupTractionSvg({ setting, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different settings", () => {
      const tcToggle = generateSetupTractionSvg({ setting: "tc-toggle", direction: "increase" });
      const tcSlot1 = generateSetupTractionSvg({ setting: "tc-slot-1", direction: "increase" });

      expect(tcToggle).not.toBe(tcSlot1);
    });

    it("should produce different icons for increase vs decrease on directional controls", () => {
      const increase = generateSetupTractionSvg({ setting: "tc-slot-1", direction: "increase" });
      const decrease = generateSetupTractionSvg({ setting: "tc-slot-1", direction: "decrease" });

      expect(increase).not.toBe(decrease);
    });

    it("should produce same icon for non-directional controls regardless of direction", () => {
      const increase = generateSetupTractionSvg({ setting: "tc-toggle", direction: "increase" });
      const decrease = generateSetupTractionSvg({ setting: "tc-toggle", direction: "decrease" });

      expect(increase).toBe(decrease);
    });

    it("should include correct labels for tc-toggle", () => {
      const result = generateSetupTractionSvg({ setting: "tc-toggle", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("TC");
      expect(decoded).toContain("TOGGLE");
    });

    it("should include correct labels for tc-slot-1 increase", () => {
      const result = generateSetupTractionSvg({ setting: "tc-slot-1", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("TC SLOT 1");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for tc-slot-1 decrease", () => {
      const result = generateSetupTractionSvg({ setting: "tc-slot-1", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("TC SLOT 1");
      expect(decoded).toContain("DECREASE");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        "tc-toggle": {
          increase: { line1: "TC", line2: "TOGGLE" },
          decrease: { line1: "TC", line2: "TOGGLE" },
        },
        "tc-slot-1": {
          increase: { line1: "TC SLOT 1", line2: "INCREASE" },
          decrease: { line1: "TC SLOT 1", line2: "DECREASE" },
        },
        "tc-slot-2": {
          increase: { line1: "TC SLOT 2", line2: "INCREASE" },
          decrease: { line1: "TC SLOT 2", line2: "DECREASE" },
        },
        "tc-slot-3": {
          increase: { line1: "TC SLOT 3", line2: "INCREASE" },
          decrease: { line1: "TC SLOT 3", line2: "DECREASE" },
        },
        "tc-slot-4": {
          increase: { line1: "TC SLOT 4", line2: "INCREASE" },
          decrease: { line1: "TC SLOT 4", line2: "DECREASE" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupTractionSvg({
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
    let action: SetupTraction;

    beforeEach(() => {
      action = new SetupTraction();
    });

    it("should call sendKeyCombination on keyDown for tc-toggle", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupTractionTcToggle: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "a", modifiers: ["ctrl"], code: "KeyA" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-toggle" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "a",
        modifiers: ["ctrl"],
        code: "KeyA",
      });
    });

    it("should call sendKeyCombination for tc-slot-1 increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupTractionTcSlot1Increase: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "=", modifiers: [], code: "Equal" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-slot-1", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "=",
        modifiers: undefined,
        code: "Equal",
      });
    });

    it("should call sendKeyCombination for tc-slot-1 decrease", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupTractionTcSlot1Decrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "-", modifiers: [], code: "Minus" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-slot-1", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "-",
        modifiers: undefined,
        code: "Minus",
      });
    });

    it("should call sendKeyCombination for tc-slot-2 increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupTractionTcSlot2Increase: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "up", modifiers: [], code: "ArrowUp" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-slot-2", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "up",
        modifiers: undefined,
        code: "ArrowUp",
      });
    });

    it("should call sendKeyCombination for tc-slot-3 decrease", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupTractionTcSlot3Decrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "down", modifiers: [], code: "ArrowDown" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-slot-3", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "down",
        modifiers: undefined,
        code: "ArrowDown",
      });
    });

    it("should call sendKeyCombination on dialDown", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupTractionTcToggle: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "a", modifiers: ["ctrl"], code: "KeyA" });

      await action.onDialDown(fakeEvent("action-1", { setting: "tc-toggle" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should handle missing key binding gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-toggle" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should handle missing global key mapping gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-slot-1", direction: "increase" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });

  describe("encoder behavior", () => {
    let action: SetupTraction;

    beforeEach(() => {
      action = new SetupTraction();
    });

    it("should send increase key on clockwise rotation for directional controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupTractionTcSlot1Increase: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "=", modifiers: [], code: "Equal" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "tc-slot-1", direction: "increase" }, 1) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "=",
        modifiers: undefined,
        code: "Equal",
      });
    });

    it("should send decrease key on counter-clockwise rotation for directional controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupTractionTcSlot1Decrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "-", modifiers: [], code: "Minus" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "tc-slot-1", direction: "increase" }, -1) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "-",
        modifiers: undefined,
        code: "Minus",
      });
    });

    it("should send correct key for different settings on rotation", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupTractionTcSlot2Increase: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "up", modifiers: [], code: "ArrowUp" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "tc-slot-2", direction: "increase" }, 2) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should ignore rotation for non-directional controls (tc-toggle)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "tc-toggle" }, 1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });
});
