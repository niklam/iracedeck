import { beforeEach, describe, expect, it, vi } from "vitest";

import { FUEL_SERVICE_GLOBAL_KEYS, FuelService, generateFuelServiceSvg } from "./fuel-service.js";

const {
  mockPitFuel,
  mockPitClearFuel,
  mockGetCommands,
  mockSendKeyCombination,
  mockParseKeyBinding,
  mockGetGlobalSettings,
} = vi.hoisted(() => ({
  mockPitFuel: vi.fn(() => true),
  mockPitClearFuel: vi.fn(() => true),
  mockGetCommands: vi.fn(() => ({
    pit: {
      fuel: mockPitFuel,
      clearFuel: mockPitClearFuel,
    },
  })),
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
  getCommands: mockGetCommands,
  getGlobalSettings: mockGetGlobalSettings,
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: mockSendKeyCombination,
    pressKeyCombination: vi.fn().mockResolvedValue(true),
    releaseKeyCombination: vi.fn().mockResolvedValue(true),
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

function fakeDialRotateEvent(actionId: string, settings: Record<string, unknown>, ticks: number) {
  return {
    action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings, ticks },
  };
}

describe("FuelService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("should map keyboard modes to correct global settings keys", () => {
      expect(FUEL_SERVICE_GLOBAL_KEYS["toggle-autofuel"]).toBe("fuelServiceToggleAutofuel");
      expect(FUEL_SERVICE_GLOBAL_KEYS["lap-margin-increase"]).toBe("fuelServiceLapMarginIncrease");
      expect(FUEL_SERVICE_GLOBAL_KEYS["lap-margin-decrease"]).toBe("fuelServiceLapMarginDecrease");
    });

    it("should not contain SDK-based modes", () => {
      expect(FUEL_SERVICE_GLOBAL_KEYS["add-fuel"]).toBeUndefined();
      expect(FUEL_SERVICE_GLOBAL_KEYS["reduce-fuel"]).toBeUndefined();
      expect(FUEL_SERVICE_GLOBAL_KEYS["set-fuel-amount"]).toBeUndefined();
      expect(FUEL_SERVICE_GLOBAL_KEYS["clear-fuel"]).toBeUndefined();
    });
  });

  describe("generateFuelServiceSvg", () => {
    const allModes = [
      "add-fuel",
      "reduce-fuel",
      "set-fuel-amount",
      "clear-fuel",
      "toggle-autofuel",
      "lap-margin-increase",
      "lap-margin-decrease",
    ] as const;

    it.each(allModes)("should generate a valid data URI for %s", (mode) => {
      const result = generateFuelServiceSvg({ mode });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different modes", () => {
      const icons = allModes.map((mode) => generateFuelServiceSvg({ mode }));

      for (let i = 0; i < icons.length; i++) {
        for (let j = i + 1; j < icons.length; j++) {
          expect(icons[i]).not.toBe(icons[j]);
        }
      }
    });

    it("should include correct labels for all modes", () => {
      const expectedLabels: Record<string, { line1: string; line2: string }> = {
        "add-fuel": { line1: "ADD FUEL", line2: "PIT" },
        "reduce-fuel": { line1: "REDUCE", line2: "FUEL" },
        "set-fuel-amount": { line1: "SET FUEL", line2: "AMOUNT" },
        "clear-fuel": { line1: "CLEAR", line2: "FUEL" },
        "toggle-autofuel": { line1: "AUTOFUEL", line2: "TOGGLE" },
        "lap-margin-increase": { line1: "LAP MARGIN", line2: "INCREASE" },
        "lap-margin-decrease": { line1: "LAP MARGIN", line2: "DECREASE" },
      };

      for (const [mode, labels] of Object.entries(expectedLabels)) {
        const result = generateFuelServiceSvg({ mode: mode as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);
        expect(decoded).toContain(labels.line2);
      }
    });

    it("should fall back to add-fuel defaults for unspecified settings", () => {
      const result = generateFuelServiceSvg({} as any);
      const decoded = decodeURIComponent(result);

      expect(result).toContain("data:image/svg+xml");
      expect(decoded).toContain("ADD FUEL");
    });
  });

  describe("key press behavior (SDK modes)", () => {
    let action: FuelService;

    beforeEach(() => {
      action = new FuelService();
    });

    it("should call pit.fuel(0) on keyDown for add-fuel", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(0);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should call pit.fuel(0) on keyDown for reduce-fuel", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "reduce-fuel" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(0);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should call pit.fuel(0) on keyDown for set-fuel-amount", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "set-fuel-amount" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(0);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should call pit.clearFuel() on keyDown for clear-fuel", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "clear-fuel" }) as any);

      expect(mockPitClearFuel).toHaveBeenCalledOnce();
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("should default to add-fuel when no mode is specified", async () => {
      await action.onKeyDown(fakeEvent("action-1", {}) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(0);
    });
  });

  describe("key press behavior (keyboard modes)", () => {
    let action: FuelService;

    beforeEach(() => {
      action = new FuelService();
      mockParseKeyBinding.mockReturnValue({ key: "a", modifiers: ["Shift", "Ctrl"], code: 30 });
      mockGetGlobalSettings.mockReturnValue({
        fuelServiceToggleAutofuel: '{"key":"a","modifiers":["Shift","Ctrl"],"code":30}',
        fuelServiceLapMarginIncrease: '{"key":"x","modifiers":["Shift","Alt"],"code":45}',
        fuelServiceLapMarginDecrease: '{"key":"s","modifiers":["Shift","Alt"],"code":31}',
      });
    });

    it("should call sendKeyCombination for toggle-autofuel", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "toggle-autofuel" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should call sendKeyCombination for lap-margin-increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "lap-margin-increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should call sendKeyCombination for lap-margin-decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "lap-margin-decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should warn when no key binding is configured", async () => {
      mockParseKeyBinding.mockReturnValue(null);

      await action.onKeyDown(fakeEvent("action-1", { mode: "toggle-autofuel" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should not call SDK commands for keyboard modes", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "toggle-autofuel" }) as any);

      expect(mockPitFuel).not.toHaveBeenCalled();
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });
  });

  describe("encoder behavior", () => {
    let action: FuelService;

    beforeEach(() => {
      action = new FuelService();
      mockParseKeyBinding.mockReturnValue({ key: "x", modifiers: ["Shift", "Alt"], code: 45 });
      mockGetGlobalSettings.mockReturnValue({
        fuelServiceLapMarginIncrease: '{"key":"x","modifiers":["Shift","Alt"],"code":45}',
        fuelServiceLapMarginDecrease: '{"key":"s","modifiers":["Shift","Alt"],"code":31}',
      });
    });

    it("should trigger same action as keyDown on dialDown for SDK modes", async () => {
      await action.onDialDown(fakeEvent("action-1", { mode: "add-fuel" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(0);
    });

    it("should trigger same action as keyDown on dialDown for keyboard modes", async () => {
      await action.onDialDown(fakeEvent("action-1", { mode: "toggle-autofuel" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should call pit.fuel(0) on clockwise rotation for add-fuel", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { mode: "add-fuel" }, 1) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(0);
    });

    it("should call pit.clearFuel() is not called on counter-clockwise rotation for add-fuel", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { mode: "add-fuel" }, -1) as any);

      // Counter-clockwise on add-fuel triggers reduce-fuel, which calls pit.fuel(0)
      expect(mockPitFuel).toHaveBeenCalledWith(0);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should trigger lap-margin-increase on clockwise rotation for lap-margin-increase mode", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { mode: "lap-margin-increase" }, 1) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should trigger lap-margin-decrease on counter-clockwise rotation for lap-margin-increase mode", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { mode: "lap-margin-increase" }, -1) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should ignore rotation for non-rotatable modes", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { mode: "clear-fuel" }, 1) as any);

      expect(mockPitFuel).not.toHaveBeenCalled();
      expect(mockPitClearFuel).not.toHaveBeenCalled();
      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should ignore rotation for set-fuel-amount", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { mode: "set-fuel-amount" }, -1) as any);

      expect(mockPitFuel).not.toHaveBeenCalled();
      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should ignore rotation for toggle-autofuel", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { mode: "toggle-autofuel" }, 1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });
});
