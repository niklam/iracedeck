import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSetupFuelSvg, SETUP_FUEL_GLOBAL_KEYS, SetupFuel } from "./setup-fuel.js";

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

vi.mock("@iracedeck/stream-deck-shared", () => ({
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

describe("SetupFuel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SETUP_FUEL_GLOBAL_KEYS", () => {
    it("should have correct mapping for fuel-mixture-increase", () => {
      expect(SETUP_FUEL_GLOBAL_KEYS["fuel-mixture-increase"]).toBe("setupFuelFuelMixtureIncrease");
    });

    it("should have correct mapping for fuel-mixture-decrease", () => {
      expect(SETUP_FUEL_GLOBAL_KEYS["fuel-mixture-decrease"]).toBe("setupFuelFuelMixtureDecrease");
    });

    it("should have correct mapping for fuel-cut-position-increase", () => {
      expect(SETUP_FUEL_GLOBAL_KEYS["fuel-cut-position-increase"]).toBe("setupFuelFuelCutPositionIncrease");
    });

    it("should have correct mapping for fuel-cut-position-decrease", () => {
      expect(SETUP_FUEL_GLOBAL_KEYS["fuel-cut-position-decrease"]).toBe("setupFuelFuelCutPositionDecrease");
    });

    it("should have correct mapping for disable-fuel-cut", () => {
      expect(SETUP_FUEL_GLOBAL_KEYS["disable-fuel-cut"]).toBe("setupFuelDisableFuelCut");
    });

    it("should have correct mapping for low-fuel-accept", () => {
      expect(SETUP_FUEL_GLOBAL_KEYS["low-fuel-accept"]).toBe("setupFuelLowFuelAccept");
    });

    it("should have correct mapping for fcy-mode-toggle", () => {
      expect(SETUP_FUEL_GLOBAL_KEYS["fcy-mode-toggle"]).toBe("setupFuelFcyModeToggle");
    });

    it("should have exactly 7 entries", () => {
      expect(Object.keys(SETUP_FUEL_GLOBAL_KEYS)).toHaveLength(7);
    });
  });

  describe("generateSetupFuelSvg", () => {
    it("should generate a valid data URI for disable-fuel-cut", () => {
      const result = generateSetupFuelSvg({ setting: "disable-fuel-cut", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for low-fuel-accept", () => {
      const result = generateSetupFuelSvg({ setting: "low-fuel-accept", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for fcy-mode-toggle", () => {
      const result = generateSetupFuelSvg({ setting: "fcy-mode-toggle", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for fuel-mixture", () => {
      const result = generateSetupFuelSvg({ setting: "fuel-mixture", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for fuel-cut-position", () => {
      const result = generateSetupFuelSvg({ setting: "fuel-cut-position", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all setting + direction combinations", () => {
      const settings = [
        "fuel-mixture",
        "fuel-cut-position",
        "disable-fuel-cut",
        "low-fuel-accept",
        "fcy-mode-toggle",
      ] as const;
      const directions = ["increase", "decrease"] as const;

      for (const setting of settings) {
        for (const direction of directions) {
          const result = generateSetupFuelSvg({ setting, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different settings", () => {
      const fuelMixture = generateSetupFuelSvg({ setting: "fuel-mixture", direction: "increase" });
      const disableFuelCut = generateSetupFuelSvg({ setting: "disable-fuel-cut", direction: "increase" });

      expect(fuelMixture).not.toBe(disableFuelCut);
    });

    it("should produce different icons for increase vs decrease on directional controls", () => {
      const increase = generateSetupFuelSvg({ setting: "fuel-mixture", direction: "increase" });
      const decrease = generateSetupFuelSvg({ setting: "fuel-mixture", direction: "decrease" });

      expect(increase).not.toBe(decrease);
    });

    it("should produce same icon for non-directional controls regardless of direction", () => {
      const increase = generateSetupFuelSvg({ setting: "disable-fuel-cut", direction: "increase" });
      const decrease = generateSetupFuelSvg({ setting: "disable-fuel-cut", direction: "decrease" });

      expect(increase).toBe(decrease);
    });

    it("should produce same icon for low-fuel-accept regardless of direction", () => {
      const increase = generateSetupFuelSvg({ setting: "low-fuel-accept", direction: "increase" });
      const decrease = generateSetupFuelSvg({ setting: "low-fuel-accept", direction: "decrease" });

      expect(increase).toBe(decrease);
    });

    it("should produce same icon for fcy-mode-toggle regardless of direction", () => {
      const increase = generateSetupFuelSvg({ setting: "fcy-mode-toggle", direction: "increase" });
      const decrease = generateSetupFuelSvg({ setting: "fcy-mode-toggle", direction: "decrease" });

      expect(increase).toBe(decrease);
    });

    it("should include correct labels for fuel-mixture increase", () => {
      const result = generateSetupFuelSvg({ setting: "fuel-mixture", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FUEL MIX");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for fuel-mixture decrease", () => {
      const result = generateSetupFuelSvg({ setting: "fuel-mixture", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FUEL MIX");
      expect(decoded).toContain("DECREASE");
    });

    it("should include correct labels for fuel-cut-position increase", () => {
      const result = generateSetupFuelSvg({ setting: "fuel-cut-position", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FUEL CUT");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for disable-fuel-cut", () => {
      const result = generateSetupFuelSvg({ setting: "disable-fuel-cut", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FUEL CUT");
      expect(decoded).toContain("DISABLE");
    });

    it("should include correct labels for low-fuel-accept", () => {
      const result = generateSetupFuelSvg({ setting: "low-fuel-accept", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("LOW FUEL");
      expect(decoded).toContain("ACCEPT");
    });

    it("should include correct labels for fcy-mode-toggle", () => {
      const result = generateSetupFuelSvg({ setting: "fcy-mode-toggle", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FCY MODE");
      expect(decoded).toContain("TOGGLE");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        "fuel-mixture": {
          increase: { line1: "FUEL MIX", line2: "INCREASE" },
          decrease: { line1: "FUEL MIX", line2: "DECREASE" },
        },
        "fuel-cut-position": {
          increase: { line1: "FUEL CUT", line2: "INCREASE" },
          decrease: { line1: "FUEL CUT", line2: "DECREASE" },
        },
        "disable-fuel-cut": {
          increase: { line1: "FUEL CUT", line2: "DISABLE" },
          decrease: { line1: "FUEL CUT", line2: "DISABLE" },
        },
        "low-fuel-accept": {
          increase: { line1: "LOW FUEL", line2: "ACCEPT" },
          decrease: { line1: "LOW FUEL", line2: "ACCEPT" },
        },
        "fcy-mode-toggle": {
          increase: { line1: "FCY MODE", line2: "TOGGLE" },
          decrease: { line1: "FCY MODE", line2: "TOGGLE" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupFuelSvg({
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
    let action: SetupFuel;

    beforeEach(() => {
      action = new SetupFuel();
    });

    it("should call sendKeyCombination on keyDown for disable-fuel-cut", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupFuelDisableFuelCut: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "a", modifiers: ["ctrl"], code: "KeyA" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "disable-fuel-cut" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "a",
        modifiers: ["ctrl"],
        code: "KeyA",
      });
    });

    it("should call sendKeyCombination on keyDown for low-fuel-accept", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupFuelLowFuelAccept: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "l", modifiers: [], code: "KeyL" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "low-fuel-accept" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "l",
        modifiers: undefined,
        code: "KeyL",
      });
    });

    it("should call sendKeyCombination on keyDown for fcy-mode-toggle", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupFuelFcyModeToggle: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "f", modifiers: ["shift"], code: "KeyF" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "fcy-mode-toggle" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "f",
        modifiers: ["shift"],
        code: "KeyF",
      });
    });

    it("should call sendKeyCombination for fuel-mixture increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupFuelFuelMixtureIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "=", modifiers: [], code: "Equal" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "fuel-mixture", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "=",
        modifiers: undefined,
        code: "Equal",
      });
    });

    it("should call sendKeyCombination for fuel-mixture decrease", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupFuelFuelMixtureDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "-", modifiers: [], code: "Minus" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "fuel-mixture", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "-",
        modifiers: undefined,
        code: "Minus",
      });
    });

    it("should call sendKeyCombination for fuel-cut-position increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupFuelFuelCutPositionIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "up", modifiers: [], code: "ArrowUp" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "fuel-cut-position", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "up",
        modifiers: undefined,
        code: "ArrowUp",
      });
    });

    it("should call sendKeyCombination for fuel-cut-position decrease", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupFuelFuelCutPositionDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "down", modifiers: [], code: "ArrowDown" });

      await action.onKeyDown(fakeEvent("action-1", { setting: "fuel-cut-position", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "down",
        modifiers: undefined,
        code: "ArrowDown",
      });
    });

    it("should call sendKeyCombination on dialDown", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupFuelDisableFuelCut: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "a", modifiers: ["ctrl"], code: "KeyA" });

      await action.onDialDown(fakeEvent("action-1", { setting: "disable-fuel-cut" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should handle missing key binding gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { setting: "disable-fuel-cut" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should handle missing global key mapping gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { setting: "fuel-mixture", direction: "increase" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });

  describe("encoder behavior", () => {
    let action: SetupFuel;

    beforeEach(() => {
      action = new SetupFuel();
    });

    it("should send increase key on clockwise rotation for directional controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupFuelFuelMixtureIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "=", modifiers: [], code: "Equal" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "fuel-mixture", direction: "increase" }, 1) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "=",
        modifiers: undefined,
        code: "Equal",
      });
    });

    it("should send decrease key on counter-clockwise rotation for directional controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupFuelFuelMixtureDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "-", modifiers: [], code: "Minus" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "fuel-mixture", direction: "increase" }, -1) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "-",
        modifiers: undefined,
        code: "Minus",
      });
    });

    it("should send correct key for fuel-cut-position rotation", async () => {
      mockGetGlobalSettings.mockReturnValue({ setupFuelFuelCutPositionIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "up", modifiers: [], code: "ArrowUp" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "fuel-cut-position", direction: "increase" }, 2) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should ignore rotation for non-directional controls (disable-fuel-cut)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "disable-fuel-cut" }, 1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should ignore rotation for non-directional controls (low-fuel-accept)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "low-fuel-accept" }, 1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should ignore rotation for non-directional controls (fcy-mode-toggle)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "fcy-mode-toggle" }, -1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });
});
