import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildFuelMacro,
  FUEL_SERVICE_GLOBAL_KEYS,
  FuelService,
  generateFuelServiceSvg,
  getFuelServiceLabels,
} from "./fuel-service.js";

const {
  mockPitClearFuel,
  mockSendMessage,
  mockGetCommands,
  mockSendKeyCombination,
  mockParseKeyBinding,
  mockGetGlobalSettings,
} = vi.hoisted(() => ({
  mockPitClearFuel: vi.fn(() => true),
  mockSendMessage: vi.fn(() => true),
  mockGetCommands: vi.fn(() => ({
    pit: {
      clearFuel: mockPitClearFuel,
    },
    chat: {
      sendMessage: mockSendMessage,
    },
  })),
  mockSendKeyCombination: vi.fn().mockResolvedValue(true),
  mockParseKeyBinding: vi.fn(),
  mockGetGlobalSettings: vi.fn(() => ({})),
}));

vi.mock("@iracedeck/icons/fuel-service/add-fuel.svg", () => ({
  default: "<svg>add-fuel-icon</svg>",
}));
vi.mock("@iracedeck/icons/fuel-service/reduce-fuel.svg", () => ({
  default: "<svg>reduce-fuel-icon</svg>",
}));
vi.mock("@iracedeck/icons/fuel-service/set-fuel-amount.svg", () => ({
  default: "<svg>set-fuel-amount-icon</svg>",
}));
vi.mock("@iracedeck/icons/fuel-service/clear-fuel.svg", () => ({
  default: "<svg>clear-fuel-icon</svg>",
}));
vi.mock("@iracedeck/icons/fuel-service/toggle-autofuel.svg", () => ({
  default: "<svg>toggle-autofuel-icon</svg>",
}));
vi.mock("@iracedeck/icons/fuel-service/lap-margin-increase.svg", () => ({
  default: "<svg>lap-margin-increase-icon</svg>",
}));
vi.mock("@iracedeck/icons/fuel-service/lap-margin-decrease.svg", () => ({
  default: "<svg>lap-margin-decrease-icon</svg>",
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
    extend: () => {
      const defaults = { mode: "add-fuel", amount: 1, unit: "l" };
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...defaults, ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...defaults, ...data } }),
      };

      return schema;
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
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
    return `<svg>${data.iconContent || ""}${data.mainLabel || data.labelLine1 || ""}${data.subLabel || data.labelLine2 || ""}</svg>`;
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

    it("should not contain macro or SDK modes", () => {
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
      const result = generateFuelServiceSvg({ mode, amount: 1, unit: "l" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different modes", () => {
      const icons = allModes.map((mode) => generateFuelServiceSvg({ mode, amount: 1, unit: "l" }));

      for (let i = 0; i < icons.length; i++) {
        for (let j = i + 1; j < icons.length; j++) {
          expect(icons[i]).not.toBe(icons[j]);
        }
      }
    });

    it("should include correct labels for static modes", () => {
      const staticLabels: Record<string, { line1: string; line2: string }> = {
        "clear-fuel": { line1: "CLEAR", line2: "FUEL" },
        "toggle-autofuel": { line1: "TOGGLE", line2: "AUTOFUEL" },
        "lap-margin-increase": { line1: "INCREASE", line2: "LAP MARGIN" },
        "lap-margin-decrease": { line1: "DECREASE", line2: "LAP MARGIN" },
      };

      for (const [mode, labels] of Object.entries(staticLabels)) {
        const result = generateFuelServiceSvg({ mode: mode as any, amount: 1, unit: "l" });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);
        expect(decoded).toContain(labels.line2);
      }
    });

    it("should include dynamic labels for macro modes", () => {
      const addResult = decodeURIComponent(generateFuelServiceSvg({ mode: "add-fuel", amount: 5, unit: "l" }));

      expect(addResult).toContain("ADD FUEL");
      expect(addResult).toContain("+5 L");

      const reduceResult = decodeURIComponent(generateFuelServiceSvg({ mode: "reduce-fuel", amount: 3.5, unit: "g" }));

      expect(reduceResult).toContain("REDUCE FUEL");
      expect(reduceResult).toContain("-3.5 GAL");

      const setResult = decodeURIComponent(generateFuelServiceSvg({ mode: "set-fuel-amount", amount: 50, unit: "k" }));

      expect(setResult).toContain("SET FUEL");
      expect(setResult).toContain("50 KG");
    });

    it("should fall back to add-fuel defaults for unspecified settings", () => {
      const result = generateFuelServiceSvg({} as any);
      const decoded = decodeURIComponent(result);

      expect(result).toContain("data:image/svg+xml");
      expect(decoded).toContain("ADD FUEL");
    });
  });

  describe("getFuelServiceLabels", () => {
    it("should return dynamic labels for add-fuel", () => {
      const labels = getFuelServiceLabels({ mode: "add-fuel", amount: 5, unit: "l" });

      expect(labels).toEqual({ line1: "+5 L", line2: "ADD FUEL" });
    });

    it("should return dynamic labels for reduce-fuel with gallons", () => {
      const labels = getFuelServiceLabels({ mode: "reduce-fuel", amount: 3.5, unit: "g" });

      expect(labels).toEqual({ line1: "-3.5 GAL", line2: "REDUCE FUEL" });
    });

    it("should return dynamic labels for set-fuel-amount with kg", () => {
      const labels = getFuelServiceLabels({ mode: "set-fuel-amount", amount: 50, unit: "k" });

      expect(labels).toEqual({ line1: "50 KG", line2: "SET FUEL" });
    });

    it("should round amount to 1 decimal place", () => {
      const labels = getFuelServiceLabels({ mode: "add-fuel", amount: 1.05000001, unit: "l" });

      expect(labels.line1).toBe("+1.1 L");
    });

    it("should return static labels for non-macro modes", () => {
      expect(getFuelServiceLabels({ mode: "clear-fuel", amount: 1, unit: "l" })).toEqual({
        line1: "CLEAR",
        line2: "FUEL",
      });
      expect(getFuelServiceLabels({ mode: "lap-margin-increase", amount: 1, unit: "l" })).toEqual({
        line1: "INCREASE",
        line2: "LAP MARGIN",
      });
    });
  });

  describe("buildFuelMacro", () => {
    it("should build add-fuel macro with liters", () => {
      expect(buildFuelMacro("add-fuel", 5, "l")).toBe("#fuel +5l$");
    });

    it("should build add-fuel macro with gallons", () => {
      expect(buildFuelMacro("add-fuel", 10.5, "g")).toBe("#fuel +10.5g$");
    });

    it("should build reduce-fuel macro with kilograms", () => {
      expect(buildFuelMacro("reduce-fuel", 3, "k")).toBe("#fuel -3k$");
    });

    it("should build set-fuel-amount macro without sign", () => {
      expect(buildFuelMacro("set-fuel-amount", 50, "l")).toBe("#fuel 50l$");
    });

    it("should round amount to 1 decimal place", () => {
      expect(buildFuelMacro("add-fuel", 1.05000001, "l")).toBe("#fuel +1.1l$");
    });

    it("should handle zero amount", () => {
      expect(buildFuelMacro("add-fuel", 0, "l")).toBe("#fuel +0l$");
    });

    it("should return null for non-macro modes", () => {
      expect(buildFuelMacro("clear-fuel", 5, "l")).toBeNull();
      expect(buildFuelMacro("toggle-autofuel", 5, "l")).toBeNull();
      expect(buildFuelMacro("lap-margin-increase", 5, "l")).toBeNull();
      expect(buildFuelMacro("lap-margin-decrease", 5, "l")).toBeNull();
    });
  });

  describe("key press behavior (macro modes)", () => {
    let action: FuelService;

    beforeEach(() => {
      action = new FuelService();
    });

    it("should send add-fuel macro via chat.sendMessage", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);

      expect(mockSendMessage).toHaveBeenCalledWith("#fuel +5l$");
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should send reduce-fuel macro via chat.sendMessage", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "reduce-fuel", amount: 3, unit: "g" }) as any);

      expect(mockSendMessage).toHaveBeenCalledWith("#fuel -3g$");
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should send set-fuel-amount macro via chat.sendMessage", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "set-fuel-amount", amount: 50, unit: "k" }) as any);

      expect(mockSendMessage).toHaveBeenCalledWith("#fuel 50k$");
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should use default amount and unit when not specified", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel" }) as any);

      expect(mockSendMessage).toHaveBeenCalledWith("#fuel +1l$");
    });

    it("should call pit.clearFuel() on keyDown for clear-fuel", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "clear-fuel" }) as any);

      expect(mockPitClearFuel).toHaveBeenCalledOnce();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("should default to add-fuel when no mode is specified", async () => {
      await action.onKeyDown(fakeEvent("action-1", {}) as any);

      expect(mockSendMessage).toHaveBeenCalledWith("#fuel +1l$");
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

    it("should not call SDK or macro commands for keyboard modes", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "toggle-autofuel" }) as any);

      expect(mockSendMessage).not.toHaveBeenCalled();
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

    it("should send fuel macro on dialDown for macro modes", async () => {
      await action.onDialDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);

      expect(mockSendMessage).toHaveBeenCalledWith("#fuel +5l$");
    });

    it("should trigger same action as keyDown on dialDown for keyboard modes", async () => {
      await action.onDialDown(fakeEvent("action-1", { mode: "toggle-autofuel" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should send add-fuel macro on clockwise rotation for add-fuel", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }, 1) as any);

      expect(mockSendMessage).toHaveBeenCalledWith("#fuel +5l$");
    });

    it("should send reduce-fuel macro on counter-clockwise rotation for add-fuel", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }, -1) as any);

      // Counter-clockwise on add-fuel triggers reduce-fuel
      expect(mockSendMessage).toHaveBeenCalledWith("#fuel -5l$");
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

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockPitClearFuel).not.toHaveBeenCalled();
      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should ignore rotation for set-fuel-amount", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { mode: "set-fuel-amount" }, -1) as any);

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should ignore rotation for toggle-autofuel", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { mode: "toggle-autofuel" }, 1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });
});
