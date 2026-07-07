import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  amountToLiters,
  formatFuelFillAmount,
  FUEL_SERVICE_GLOBAL_KEYS,
  FuelService,
  type FuelServiceTelemetryState,
  generateFuelServiceSvg,
  getFuelAmount,
  getFuelServiceLabels,
  readFuelKgPerLtr,
  resolveKeypadUnit,
} from "./fuel-service.js";

const { mockPitClearFuel, mockPitFuel, mockGetCommands, mockParseKeyBinding, mockGetGlobalSettings, mockTapBinding } =
  vi.hoisted(() => ({
    mockPitClearFuel: vi.fn(() => true),
    mockPitFuel: vi.fn(() => true),
    mockGetCommands: vi.fn(() => ({
      pit: {
        clearFuel: mockPitClearFuel,
        fuel: mockPitFuel,
      },
    })),
    mockParseKeyBinding: vi.fn(),
    mockGetGlobalSettings: vi.fn(() => ({})),
    mockTapBinding: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("@iracedeck/iracing-sdk", () => ({
  DisplayUnits: { English: 0, Metric: 1 },
  PitSvFlags: { FuelFill: 0x0010 },
  hasFlag: (value: number | undefined, flag: number) => value !== undefined && (value & flag) !== 0,
}));

vi.mock("../../../icons/fuel-service.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{iconContent}} {{backgroundColor}}</svg>',
}));

vi.mock("../../icons/status-bar.js", () => ({
  statusBarOn: () => '<rect class="status-on"/>',
  statusBarOff: () => '<rect class="status-off"/>',
  statusBarNA: () => '<rect class="status-na"/>',
  borderColorForState: (state: string) => ({ on: "#2ecc71", off: "#e74c3c", na: "#888888" })[state],
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

vi.mock("@iracedeck/deck-core", async () => {
  // REAL zod drives the settings schema so parse/defaults/migration behave
  // exactly like production (fuel-service-settings.ts builds on CommonSettings.extend).
  const { z } = await import("zod");

  return {
    CommonSettings: {
      extend: (shape: never) => z.object(shape).passthrough(),
    },
    ConnectionStateAwareAction: class MockConnectionStateAwareAction {
      logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      sdkController = {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        getCurrentTelemetry: vi.fn(() => null),
        getSessionInfo: vi.fn(() => null),
      };
      updateConnectionState = vi.fn();
      setKeyImage = vi.fn();
      setRegenerateCallback = vi.fn();
      updateKeyImage = vi.fn().mockResolvedValue(true);
      tapBinding = mockTapBinding;
      holdBinding = vi.fn().mockResolvedValue(undefined);
      releaseBinding = vi.fn().mockResolvedValue(undefined);
      setActiveBinding = vi.fn();
      isActiveBindingMissing = vi.fn(() => false);
      isBindingMissing = vi.fn(() => false);
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
    getCommands: mockGetCommands,
    generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
    getGlobalBorderSettings: vi.fn(() => ({})),
    getGlobalColors: vi.fn(() => ({})),
    getGlobalGraphicSettings: vi.fn(() => ({})),
    getGlobalSettings: mockGetGlobalSettings,
    // Shared fuel telemetry readers (extracted to deck-core); behave like the real impls.
    isFuelFillOn: (t: any) => !!t && t.PitSvFlags !== undefined && (t.PitSvFlags & 0x0010) === 0x0010,
    isAutofuelActive: (t: any) => !!t && t.dpFuelAutoFillActive !== undefined && t.dpFuelAutoFillActive !== 0,
    isAutofuelEnabled: (t: any) => (!t || t.dpFuelAutoFillEnabled === undefined ? true : t.dpFuelAutoFillEnabled !== 0),
    getKeyboard: vi.fn(() => ({
      sendKeyCombination: vi.fn().mockResolvedValue(true),
      pressKeyCombination: vi.fn().mockResolvedValue(true),
      releaseKeyCombination: vi.fn().mockResolvedValue(true),
    })),
    LogLevel: { Info: 2 },
    parseBinding: mockParseKeyBinding,
    parseKeyBinding: mockParseKeyBinding,
    isSimHubBinding: vi.fn(
      (v: unknown) => v !== null && typeof v === "object" && (v as Record<string, unknown>).type === "simhub",
    ),
    isSimHubInitialized: vi.fn(() => false),
    getSimHub: vi.fn(() => ({
      startRole: vi.fn().mockResolvedValue(true),
      stopRole: vi.fn().mockResolvedValue(true),
    })),
    fuelToDisplayUnits: vi.fn((liters: number, displayUnits: number | undefined) => {
      // 0 = English (gallons), 1 = Metric (liters)
      if (displayUnits === 1) return liters;

      return liters * 0.264172;
    }),
    fuelFromDisplayUnits: vi.fn((amount: number, displayUnits: number | undefined) =>
      displayUnits === 1 ? amount : amount * 3.78541,
    ),
    getFuelUnitSuffix: vi.fn((displayUnits: number | undefined) => (displayUnits === 1 ? "L" : "gal")),
    gallonsToLiters: vi.fn((gallons: number) => gallons * 3.78541),
    // "Long-press threshold" global setting reader (drives the dial release classifier).
    getDualPressThresholdMs: () => 500,
    DIAL_LONG_PRESS_THRESHOLD_MS: 500,
    classifyDialRelease: (args: {
      pressStartMs: number;
      nowMs: number;
      rotatedWhilePressed: boolean;
      thresholdMs?: number;
    }) => {
      if (args.rotatedWhilePressed) return "push-turn";

      return args.nowMs - args.pressStartMs >= (args.thresholdMs ?? 500) ? "long" : "short";
    },
    resolvePairedAction: (pair: { cw: unknown; ccw: unknown } | null | undefined, ticks: number) => {
      if (!pair) return null;

      if (ticks > 0) return pair.cw;

      if (ticks < 0) return pair.ccw;

      return null;
    },
    getGlobalTitleSettings: vi.fn(() => ({})),
    resolveBorderSettings: vi.fn((_svg: unknown, _global: unknown, _overrides?: unknown, _stateColor?: string) => ({
      enabled: false,
      borderWidth: 7,
      borderColor: "#00aaff",
      glowEnabled: true,
      glowWidth: 18,
    })),
    resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
    resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle?: string) => ({
      showTitle: true,
      showGraphics: true,
      titleText: defaultTitle ?? "",
      bold: true,
      fontSize: 18,
      position: "bottom" as const,
      customPosition: 0,
    })),
    applyBindingWarning: vi.fn((content: string) => `${content}<warn/>`),
    assembleIcon: vi.fn(
      ({
        graphicSvg,
        title,
        bindingMissing,
      }: {
        graphicSvg: string;
        colors: unknown;
        title: { titleText: string };
        bindingMissing?: boolean;
      }) => {
        const warn = bindingMissing ? "<warn/>" : "";
        const encoded = encodeURIComponent(`<svg>${graphicSvg}${title?.titleText ?? ""}${warn}</svg>`);

        return `data:image/svg+xml,${encoded}`;
      },
    ),
    resolveIconColors: vi.fn((_svg: string, _global: unknown, _overrides: unknown) => ({
      graphic1Color: "#ffffff",
    })),
    generateTitleText: vi.fn((opts: { text: string }) => `<text>${opts.text}</text>`),
    renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
      return `<svg>${data.titleContent || ""}${data.iconContent || ""}${data.mainLabel || ""}${data.subLabel || ""}</svg>`;
    }),
    escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
  };
});

type MockFn = ReturnType<typeof vi.fn>;

/**
 * Typed access to the mocked base-class internals. These members are protected
 * on the real ConnectionStateAwareAction type (which applies at compile time
 * even though vi.mock replaces the runtime), so tests reach them via this cast.
 */
function internals(action: FuelService) {
  return action as unknown as {
    sdkController: {
      subscribe: MockFn;
      unsubscribe: MockFn;
      getCurrentTelemetry: MockFn;
      getSessionInfo: MockFn;
    };
    setActiveBinding: MockFn;
    setKeyImage: MockFn;
    updateKeyImage: MockFn;
    logger: { trace: MockFn; debug: MockFn; info: MockFn; warn: MockFn; error: MockFn };
  };
}

/** Create a minimal fake KEYPAD event with the given action ID and settings. */
function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: {
      id: actionId,
      isKey: () => true,
      isDial: () => false,
      setTitle: vi.fn(),
      setImage: vi.fn(),
      setSettings: vi.fn().mockResolvedValue(undefined),
    },
    payload: { settings },
  };
}

/** Create a fake DIAL event (the action context reports isDial() === true). */
function fakeDialEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: {
      id: actionId,
      isKey: () => false,
      isDial: () => true,
      setTitle: vi.fn(),
      setImage: vi.fn().mockResolvedValue(undefined),
      setSettings: vi.fn().mockResolvedValue(undefined),
      setFeedback: vi.fn().mockResolvedValue(undefined),
      setFeedbackLayout: vi.fn().mockResolvedValue(undefined),
      setTriggerDescription: vi.fn().mockResolvedValue(undefined),
    },
    payload: { settings },
  };
}

/** Telemetry with fueling OFF, a 10 L banked pit request, and metric display units. */
const METRIC_TELEMETRY = { PitSvFlags: 0, PitSvFuel: 10, DisplayUnits: 1 };

describe("FuelService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGlobalSettings.mockReturnValue({});
  });

  describe("constants", () => {
    it("should map keyboard modes to correct global settings keys", () => {
      expect(FUEL_SERVICE_GLOBAL_KEYS["toggle-autofuel"]).toBe("fuelServiceToggleAutofuel");
      expect(FUEL_SERVICE_GLOBAL_KEYS["lap-margin-increase"]).toBe("fuelServiceLapMarginIncrease");
      expect(FUEL_SERVICE_GLOBAL_KEYS["lap-margin-decrease"]).toBe("fuelServiceLapMarginDecrease");
    });

    it("should not contain amount or SDK modes", () => {
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
      const result = generateFuelServiceSvg({ mode, amount: 1, unit: "l" } as any);

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different modes", () => {
      const icons = allModes.map((mode) => generateFuelServiceSvg({ mode, amount: 1, unit: "l" } as any));

      for (let i = 0; i < icons.length; i++) {
        for (let j = i + 1; j < icons.length; j++) {
          expect(icons[i]).not.toBe(icons[j]);
        }
      }
    });

    it("should include correct labels for static modes", () => {
      const staticLabels: Record<string, { line1: string; line2: string }> = {
        "clear-fuel": { line1: "CLEAR", line2: "FUEL" },
        "lap-margin-increase": { line1: "INCREASE", line2: "LAP MARGIN" },
        "lap-margin-decrease": { line1: "DECREASE", line2: "LAP MARGIN" },
      };

      for (const [mode, labels] of Object.entries(staticLabels)) {
        const result = generateFuelServiceSvg({ mode: mode as any, amount: 1, unit: "l" } as any);
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);
        expect(decoded).toContain(labels.line2);
      }
    });

    it("should include dynamic labels for amount modes", () => {
      const addResult = decodeURIComponent(generateFuelServiceSvg({ mode: "add-fuel", amount: 5, unit: "l" } as any));

      expect(addResult).toContain("ADD FUEL");
      expect(addResult).toContain("+5 L");

      const reduceResult = decodeURIComponent(
        generateFuelServiceSvg({ mode: "reduce-fuel", amount: 3.5, unit: "g" } as any),
      );

      expect(reduceResult).toContain("REDUCE FUEL");
      expect(reduceResult).toContain("-3.5 GAL");

      const setResult = decodeURIComponent(
        generateFuelServiceSvg({ mode: "set-fuel-amount", amount: 50, unit: "k" } as any),
      );

      expect(setResult).toContain("SET FUEL");
      expect(setResult).toContain("50 KG");
    });

    it("should resolve the auto unit label from the telemetry display units (#759)", () => {
      const imperial = decodeURIComponent(
        generateFuelServiceSvg({ mode: "add-fuel", amount: 5, unit: "auto" } as any, { displayUnits: 0 }),
      );

      expect(imperial).toContain("+5 GAL");

      const metric = decodeURIComponent(
        generateFuelServiceSvg({ mode: "add-fuel", amount: 5, unit: "auto" } as any, { displayUnits: 1 }),
      );

      expect(metric).toContain("+5 L");

      // No telemetry at all: auto falls back to liters.
      const unknown = decodeURIComponent(generateFuelServiceSvg({ mode: "add-fuel", amount: 5, unit: "auto" } as any));

      expect(unknown).toContain("+5 L");
    });

    it("should fall back to toggle-fuel-fill for unspecified settings", () => {
      const result = generateFuelServiceSvg({} as any);

      expect(result).toContain("data:image/svg+xml");
    });
  });

  describe("getFuelServiceLabels", () => {
    it("should return dynamic labels for add-fuel", () => {
      const labels = getFuelServiceLabels({ mode: "add-fuel", amount: 5, unit: "l" } as any);

      expect(labels).toEqual({ line1: "+5 L", line2: "ADD FUEL" });
    });

    it("should return dynamic labels for reduce-fuel with gallons", () => {
      const labels = getFuelServiceLabels({ mode: "reduce-fuel", amount: 3.5, unit: "g" } as any);

      expect(labels).toEqual({ line1: "-3.5 GAL", line2: "REDUCE FUEL" });
    });

    it("should return dynamic labels for set-fuel-amount with kg", () => {
      const labels = getFuelServiceLabels({ mode: "set-fuel-amount", amount: 50, unit: "k" } as any);

      expect(labels).toEqual({ line1: "50 KG", line2: "SET FUEL" });
    });

    it("should resolve auto to GAL for imperial display units", () => {
      const labels = getFuelServiceLabels({ mode: "add-fuel", amount: 5, unit: "auto" } as any, 0);

      expect(labels).toEqual({ line1: "+5 GAL", line2: "ADD FUEL" });
    });

    it("should resolve auto to L for metric or unknown display units", () => {
      expect(getFuelServiceLabels({ mode: "add-fuel", amount: 5, unit: "auto" } as any, 1).line1).toBe("+5 L");
      expect(getFuelServiceLabels({ mode: "add-fuel", amount: 5, unit: "auto" } as any).line1).toBe("+5 L");
    });

    it("should round amount to 1 decimal place", () => {
      const labels = getFuelServiceLabels({ mode: "add-fuel", amount: 1.05000001, unit: "l" } as any);

      expect(labels.line1).toBe("+1.1 L");
    });

    it("should return static labels for non-amount modes", () => {
      expect(getFuelServiceLabels({ mode: "clear-fuel", amount: 1, unit: "l" } as any)).toEqual({
        line1: "CLEAR",
        line2: "FUEL",
      });
      expect(getFuelServiceLabels({ mode: "lap-margin-increase", amount: 1, unit: "l" } as any)).toEqual({
        line1: "INCREASE",
        line2: "LAP MARGIN",
      });
    });
  });

  describe("resolveKeypadUnit", () => {
    it("resolves auto to gallons for English display units", () => {
      expect(resolveKeypadUnit("auto", 0)).toBe("g");
    });

    it("resolves auto to liters for metric display units", () => {
      expect(resolveKeypadUnit("auto", 1)).toBe("l");
    });

    it("resolves auto to liters when display units are unknown", () => {
      expect(resolveKeypadUnit("auto", undefined)).toBe("l");
    });

    it("passes explicit units through unchanged", () => {
      expect(resolveKeypadUnit("l", 0)).toBe("l");
      expect(resolveKeypadUnit("g", 1)).toBe("g");
      expect(resolveKeypadUnit("k", 0)).toBe("k");
    });
  });

  describe("amountToLiters", () => {
    it("passes liters through unchanged", () => {
      expect(amountToLiters(5, "l", undefined)).toBe(5);
    });

    it("converts gallons via the shared factor", () => {
      expect(amountToLiters(2, "g", undefined)).toBeCloseTo(7.57082, 4);
    });

    it("converts kilograms via the car fuel weight", () => {
      expect(amountToLiters(30, "k", 0.75)).toBeCloseTo(40, 5);
    });

    it("returns null for kilograms when the fuel weight is unavailable", () => {
      expect(amountToLiters(30, "k", undefined)).toBeNull();
    });
  });

  describe("readFuelKgPerLtr", () => {
    it("reads DriverCarFuelKgPerLtr from session info", () => {
      expect(readFuelKgPerLtr({ DriverInfo: { DriverCarFuelKgPerLtr: 0.75 } } as any)).toBe(0.75);
    });

    it("returns undefined when session info is null", () => {
      expect(readFuelKgPerLtr(null)).toBeUndefined();
    });

    it("returns undefined when DriverInfo is missing", () => {
      expect(readFuelKgPerLtr({} as any)).toBeUndefined();
    });

    it("returns undefined for invalid or non-positive values", () => {
      expect(readFuelKgPerLtr({ DriverInfo: { DriverCarFuelKgPerLtr: "x" } } as any)).toBeUndefined();
      expect(readFuelKgPerLtr({ DriverInfo: { DriverCarFuelKgPerLtr: 0 } } as any)).toBeUndefined();
      expect(readFuelKgPerLtr({ DriverInfo: { DriverCarFuelKgPerLtr: -1 } } as any)).toBeUndefined();
      expect(readFuelKgPerLtr({ DriverInfo: { DriverCarFuelKgPerLtr: Number.NaN } } as any)).toBeUndefined();
    });
  });

  describe("enableFuelingOnChange behavior", () => {
    let action: FuelService;

    beforeEach(() => {
      action = new FuelService();
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue(METRIC_TELEMETRY);
    });

    it("should send the fuel amount without a follow-up clear when enableFuelingOnChange is true (default)", async () => {
      mockGetGlobalSettings.mockReturnValue({ enableFuelingOnChange: true });

      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(15);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should clear fuel fill AFTER sending when enableFuelingOnChange is false and fuel fill is off", async () => {
      mockGetGlobalSettings.mockReturnValue({ enableFuelingOnChange: false });

      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(15);
      expect(mockPitClearFuel).toHaveBeenCalledOnce();
      // The clear restores the off state, so it must land AFTER the fuel send.
      expect(mockPitFuel.mock.invocationCallOrder[0]).toBeLessThan(mockPitClearFuel.mock.invocationCallOrder[0]!);
    });

    it("should not clear when enableFuelingOnChange is false but fuel fill is already on", async () => {
      mockGetGlobalSettings.mockReturnValue({ enableFuelingOnChange: false });
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue({ ...METRIC_TELEMETRY, PitSvFlags: 0x0010 });

      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(15);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should handle string 'false' from sdpi-checkbox (PI stores booleans as strings)", async () => {
      mockGetGlobalSettings.mockReturnValue({ enableFuelingOnChange: "false" });

      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(15);
      expect(mockPitClearFuel).toHaveBeenCalledOnce();
    });

    it("should handle string 'true' from sdpi-checkbox as enabled", async () => {
      mockGetGlobalSettings.mockReturnValue({ enableFuelingOnChange: "true" });

      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(15);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should clear fuel fill after lap-margin-increase when preserving state", async () => {
      mockGetGlobalSettings.mockReturnValue({
        enableFuelingOnChange: false,
        fuelServiceLapMarginIncrease: '{"key":"x","modifiers":[],"code":45}',
      });
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 });

      await action.onKeyDown(fakeEvent("action-1", { mode: "lap-margin-increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("fuelServiceLapMarginIncrease");
      expect(mockPitClearFuel).toHaveBeenCalledOnce();
    });

    it("should keep clearing on repeated lap-margin presses (the black box re-arms each tap)", async () => {
      mockGetGlobalSettings.mockReturnValue({
        enableFuelingOnChange: false,
        fuelServiceLapMarginIncrease: '{"key":"x","modifiers":[],"code":45}',
      });
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 });

      await action.onKeyDown(fakeEvent("action-1", { mode: "lap-margin-increase" }) as any);
      await action.onKeyDown(fakeEvent("action-1", { mode: "lap-margin-increase" }) as any);

      // The arming happens OUTSIDE the pipeline (black box tap), so the
      // no-double-clear guard must not swallow the second clear.
      expect(mockPitClearFuel).toHaveBeenCalledTimes(2);
    });

    it("should not clear fuel fill after lap-margin when enableFuelingOnChange is true", async () => {
      mockGetGlobalSettings.mockReturnValue({
        enableFuelingOnChange: true,
        fuelServiceLapMarginIncrease: '{"key":"x","modifiers":[],"code":45}',
      });
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 });

      await action.onKeyDown(fakeEvent("action-1", { mode: "lap-margin-increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("fuelServiceLapMarginIncrease");
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should not clear fuel fill after toggle-autofuel even when preserving state", async () => {
      mockGetGlobalSettings.mockReturnValue({
        enableFuelingOnChange: false,
        fuelServiceToggleAutofuel: '{"key":"a","modifiers":[],"code":30}',
      });
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 });

      await action.onKeyDown(fakeEvent("action-1", { mode: "toggle-autofuel" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("fuelServiceToggleAutofuel");
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });
  });

  describe("key press behavior (amount modes, SDK #759)", () => {
    let action: FuelService;

    beforeEach(() => {
      action = new FuelService();
      mockGetGlobalSettings.mockReturnValue({ enableFuelingOnChange: true });
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue(METRIC_TELEMETRY);
    });

    it("should add against the live PitSvFuel baseline", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(15);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should reduce against the live PitSvFuel baseline", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "reduce-fuel", amount: 3, unit: "l" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(7);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("should set an absolute amount ignoring the baseline", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "set-fuel-amount", amount: 50, unit: "l" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(50);
    });

    it("should convert gallons to rounded whole liters", async () => {
      // 10 L baseline + 3 gal (11.35623 L) = 21.36 → 21
      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 3, unit: "g" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(21);
    });

    it("should convert kilograms via DriverCarFuelKgPerLtr", async () => {
      internals(action).sdkController.getSessionInfo.mockReturnValue({ DriverInfo: { DriverCarFuelKgPerLtr: 0.75 } });

      // 50 kg / 0.75 kg/L = 66.67 L → 67
      await action.onKeyDown(fakeEvent("action-1", { mode: "set-fuel-amount", amount: 50, unit: "k" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(67);
    });

    it("should warn and send nothing for kilograms without session info", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "set-fuel-amount", amount: 50, unit: "k" }) as any);

      expect(mockPitFuel).not.toHaveBeenCalled();
      expect(mockPitClearFuel).not.toHaveBeenCalled();
      expect(internals(action).logger.warn).toHaveBeenCalledWith(expect.stringContaining("kg"));
    });

    it("should resolve the auto unit from live DisplayUnits", async () => {
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue({
        PitSvFlags: 0,
        PitSvFuel: 10,
        DisplayUnits: 0,
      });

      // Imperial: 1 gal (3.78541 L) + 10 L baseline = 13.79 → 14
      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 1, unit: "auto" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(14);
    });

    it("should empty the request via the no-fuel dance when the target reaches zero", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "reduce-fuel", amount: 20, unit: "l" }) as any);

      // pit.fuel(0) means "keep existing", so emptying is 1 L then clear.
      expect(mockPitFuel).toHaveBeenCalledWith(1);
      expect(mockPitClearFuel).toHaveBeenCalledOnce();
      expect(mockPitFuel.mock.invocationCallOrder[0]).toBeLessThan(mockPitClearFuel.mock.invocationCallOrder[0]!);
    });

    it("should empty the request for set-fuel-amount 0", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "set-fuel-amount", amount: 0, unit: "l" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(1);
      expect(mockPitClearFuel).toHaveBeenCalledOnce();
    });

    it("should warn and send nothing without telemetry", async () => {
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue(null);

      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);

      expect(mockPitFuel).not.toHaveBeenCalled();
      expect(mockPitClearFuel).not.toHaveBeenCalled();
      expect(internals(action).logger.warn).toHaveBeenCalledWith(expect.stringContaining("telemetry"));
    });

    it("should treat a missing PitSvFuel as a zero baseline", async () => {
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0, DisplayUnits: 1 });

      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(5);
    });

    it("should use default amount and the legacy liters unit when not specified", async () => {
      // `{ mode: "add-fuel" }` with no persisted unit is a LEGACY instance —
      // the migration coerces it to liters, never auto.
      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel" }) as any);

      expect(mockPitFuel).toHaveBeenCalledWith(11);
    });

    it("should call pit.clearFuel() on keyDown for clear-fuel", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "clear-fuel" }) as any);

      expect(mockPitClearFuel).toHaveBeenCalledOnce();
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("should keep sending clear-fuel on repeated presses (forced past the dedup guard)", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "clear-fuel" }) as any);
      await action.onKeyDown(fakeEvent("action-1", { mode: "clear-fuel" }) as any);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(2);
    });

    it("should default to toggle-fuel-fill when no mode is specified", async () => {
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 });
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

    it("should call tapGlobalBinding for toggle-autofuel", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "toggle-autofuel" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("fuelServiceToggleAutofuel");
    });

    it("should call tapGlobalBinding for lap-margin-increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "lap-margin-increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("fuelServiceLapMarginIncrease");
    });

    it("should call tapGlobalBinding for lap-margin-decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "lap-margin-decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("fuelServiceLapMarginDecrease");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      mockParseKeyBinding.mockReturnValue(null);

      await action.onKeyDown(fakeEvent("action-1", { mode: "toggle-autofuel" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("fuelServiceToggleAutofuel");
    });

    it("should not call SDK commands for keyboard modes", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "toggle-autofuel" }) as any);

      expect(mockPitFuel).not.toHaveBeenCalled();
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });
  });

  describe("dial routing (#759)", () => {
    let action: FuelService;

    beforeEach(() => {
      action = new FuelService();
    });

    it("should route dial instances to the dial surface on onWillAppear (no keypad icon, no active binding)", async () => {
      const ev = fakeDialEvent("dial-1", {});

      await action.onWillAppear(ev as any);

      // Dial path: feedback rendered, trigger description set, telemetry subscribed…
      expect(ev.action.setFeedback).toHaveBeenCalled();
      expect(ev.action.setTriggerDescription).toHaveBeenCalled();
      expect(internals(action).sdkController.subscribe).toHaveBeenCalledWith("dial-1", expect.any(Function));
      // …and NONE of the keypad bookkeeping.
      expect(internals(action).setActiveBinding).not.toHaveBeenCalled();
      expect(internals(action).setKeyImage).not.toHaveBeenCalled();
    });

    it("should route dial instances on onDidReceiveSettings without keypad bookkeeping", async () => {
      const ev = fakeDialEvent("dial-1", { dial: { mode: "fill-to" } });

      await action.onDidReceiveSettings(ev as any);

      expect(ev.action.setFeedback).toHaveBeenCalled();
      expect(internals(action).setActiveBinding).not.toHaveBeenCalled();
    });

    it("should not execute keypad modes from dial press events", async () => {
      const ev = fakeDialEvent("dial-1", { mode: "add-fuel", amount: 5, unit: "l" });
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue(METRIC_TELEMETRY);

      await action.onDialDown(ev as any);

      // dialDown only records press state; nothing fires until dialUp classifies.
      expect(mockPitFuel).not.toHaveBeenCalled();
      expect(mockPitClearFuel).not.toHaveBeenCalled();
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("should keep keypad instances on the keypad path", async () => {
      const ev = fakeEvent("key-1", { mode: "toggle-autofuel" });

      await action.onWillAppear(ev as any);

      expect(internals(action).setActiveBinding).toHaveBeenCalledWith("fuelServiceToggleAutofuel");
      expect(internals(action).setKeyImage).toHaveBeenCalled();
    });
  });

  describe("unit persist-back on first appear (#759)", () => {
    let action: FuelService;

    beforeEach(() => {
      action = new FuelService();
    });

    it("should persist unit 'l' for a legacy instance (mode set, unit absent)", async () => {
      const ev = fakeEvent("action-1", { mode: "add-fuel", amount: 5 });

      await action.onWillAppear(ev as any);

      expect(ev.action.setSettings).toHaveBeenCalledWith({ mode: "add-fuel", amount: 5, unit: "l" });
    });

    it("should persist unit 'auto' for a fresh instance (no mode persisted)", async () => {
      // Banking `auto` before the PI can ever persist a mode closes the
      // ambiguous "mode set, unit absent" shape: a post-#759 instance whose
      // user picks a mode but never touches the Unit dropdown must not later
      // be mistaken for a legacy instance and coerced to liters.
      const ev = fakeEvent("action-1", {});

      await action.onWillAppear(ev as any);

      expect(ev.action.setSettings).toHaveBeenCalledWith({ unit: "auto" });
    });

    it("should persist unit 'auto' when other keys exist but mode was never set", async () => {
      const ev = fakeEvent("action-1", { flagsOverlay: true });

      await action.onWillAppear(ev as any);

      expect(ev.action.setSettings).toHaveBeenCalledWith({ flagsOverlay: true, unit: "auto" });
    });

    it("should not touch settings when unit is already persisted", async () => {
      const ev = fakeEvent("action-1", { mode: "add-fuel", unit: "g" });

      await action.onWillAppear(ev as any);

      expect(ev.action.setSettings).not.toHaveBeenCalled();
    });

    it("should not touch settings when only unit is persisted", async () => {
      const ev = fakeEvent("action-1", { unit: "auto" });

      await action.onWillAppear(ev as any);

      expect(ev.action.setSettings).not.toHaveBeenCalled();
    });
  });

  describe("getFuelAmount", () => {
    it("returns fuel amount from telemetry", () => {
      expect(getFuelAmount({ PitSvFuel: 50.0 } as any)).toBe(50.0);
    });

    it("returns 0 when PitSvFuel is 0", () => {
      expect(getFuelAmount({ PitSvFuel: 0 } as any)).toBe(0);
    });

    it("returns undefined when telemetry is null", () => {
      expect(getFuelAmount(null)).toBeUndefined();
    });

    it("returns undefined when PitSvFuel is undefined", () => {
      expect(getFuelAmount({} as any)).toBeUndefined();
    });
  });

  describe("formatFuelFillAmount", () => {
    it("formats metric amount with L suffix", () => {
      expect(formatFuelFillAmount(50, 1)).toBe("+50 L");
    });

    it("formats imperial amount with gal suffix", () => {
      const result = formatFuelFillAmount(50, 0);

      expect(result).toContain("g");
      expect(result).toContain("+");
    });

    it("formats zero", () => {
      expect(formatFuelFillAmount(0, 1)).toBe("+0 L");
    });
  });

  describe("toggle-fuel-fill mode", () => {
    describe("generateFuelServiceSvg", () => {
      it("should generate valid data URI for toggle-fuel-fill", () => {
        const result = generateFuelServiceSvg({ mode: "toggle-fuel-fill", amount: 1, unit: "l" } as any);

        expect(result).toContain("data:image/svg+xml");
      });

      it("should show ON status bar and fuel amount in metric", () => {
        const telemetryState: FuelServiceTelemetryState = { fuelFillOn: true, fuelAmount: 50.0, displayUnits: 1 };
        const result = generateFuelServiceSvg(
          { mode: "toggle-fuel-fill", amount: 1, unit: "l" } as any,
          telemetryState,
        );
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain("status-on");
        expect(decoded).toContain("+50 L");
      });

      it("should show OFF status bar and 0 fuel when fuel fill is off", () => {
        const telemetryState: FuelServiceTelemetryState = { fuelFillOn: false, fuelAmount: 0, displayUnits: 1 };
        const result = generateFuelServiceSvg(
          { mode: "toggle-fuel-fill", amount: 1, unit: "l" } as any,
          telemetryState,
        );
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain("status-off");
        expect(decoded).toContain("+0 L");
      });

      it("should show '--' placeholder and N/A status bar when no telemetry is available", () => {
        const telemetryState: FuelServiceTelemetryState = {};
        const result = generateFuelServiceSvg(
          { mode: "toggle-fuel-fill", amount: 1, unit: "l" } as any,
          telemetryState,
        );
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain("--");
        expect(decoded).not.toContain("+0");
        expect(decoded).toContain("status-na");
      });

      it("should show N/A status bar when telemetryState is undefined", () => {
        const result = generateFuelServiceSvg({ mode: "toggle-fuel-fill", amount: 1, unit: "l" } as any);
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain("status-na");
      });

      it("should show '--' placeholder when fuelAmount is undefined but fuelFillOn is set", () => {
        const telemetryState: FuelServiceTelemetryState = { fuelFillOn: false };
        const result = generateFuelServiceSvg(
          { mode: "toggle-fuel-fill", amount: 1, unit: "l" } as any,
          telemetryState,
        );
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain("--");
      });

      it("should show fuel amount in gallons for imperial units", () => {
        const telemetryState: FuelServiceTelemetryState = { fuelFillOn: true, fuelAmount: 50.0, displayUnits: 0 };
        const result = generateFuelServiceSvg(
          { mode: "toggle-fuel-fill", amount: 1, unit: "l" } as any,
          telemetryState,
        );
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain("g");
        expect(decoded).toContain("+");
      });

      it("should use static icon for non-telemetry modes regardless of state", () => {
        const telemetryState: FuelServiceTelemetryState = { fuelFillOn: true };
        const result = generateFuelServiceSvg({ mode: "clear-fuel", amount: 1, unit: "l" } as any, telemetryState);
        const decoded = decodeURIComponent(result);

        expect(decoded).not.toContain("status-on");
        expect(decoded).not.toContain("status-off");
      });
    });

    describe("key press behavior", () => {
      let action: FuelService;

      beforeEach(() => {
        action = new FuelService();
      });

      it("should call pit.fuel(0) on keyDown when fuel fill is not set", async () => {
        internals(action).sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0 });
        await action.onKeyDown(fakeEvent("action-1", { mode: "toggle-fuel-fill" }) as any);

        expect(mockPitFuel).toHaveBeenCalledWith(0);
        expect(mockPitClearFuel).not.toHaveBeenCalled();
      });

      it("should call pit.clearFuel() on keyDown when fuel fill is already set", async () => {
        internals(action).sdkController.getCurrentTelemetry.mockReturnValue({ PitSvFlags: 0x0010 });
        await action.onKeyDown(fakeEvent("action-1", { mode: "toggle-fuel-fill" }) as any);

        expect(mockPitClearFuel).toHaveBeenCalledOnce();
        expect(mockPitFuel).not.toHaveBeenCalled();
      });

      it("should not call any pit command when telemetry is null", async () => {
        internals(action).sdkController.getCurrentTelemetry.mockReturnValue(null);
        await action.onKeyDown(fakeEvent("action-1", { mode: "toggle-fuel-fill" }) as any);

        expect(mockPitFuel).not.toHaveBeenCalled();
        expect(mockPitClearFuel).not.toHaveBeenCalled();
      });
    });

    describe("telemetry subscription lifecycle", () => {
      let action: FuelService;

      beforeEach(() => {
        action = new FuelService();
      });

      it("should subscribe to telemetry on onWillAppear", async () => {
        await action.onWillAppear(fakeEvent("action-1", { mode: "toggle-fuel-fill" }) as any);

        expect(internals(action).sdkController.subscribe).toHaveBeenCalledWith("action-1", expect.any(Function));
      });

      it("should unsubscribe from telemetry on onWillDisappear", async () => {
        await action.onWillAppear(fakeEvent("action-1", { mode: "toggle-fuel-fill" }) as any);
        await action.onWillDisappear(fakeEvent("action-1") as any);

        expect(internals(action).sdkController.unsubscribe).toHaveBeenCalledWith("action-1");
      });
    });
  });

  describe("toggle-autofuel mode", () => {
    describe("generateFuelServiceSvg", () => {
      it("should generate valid data URI for toggle-autofuel", () => {
        const result = generateFuelServiceSvg({ mode: "toggle-autofuel", amount: 1, unit: "l" } as any);

        expect(result).toContain("data:image/svg+xml");
      });

      it("should show ON status bar when autofuel is active", () => {
        const telemetryState: FuelServiceTelemetryState = { autofuelActive: true };
        const result = generateFuelServiceSvg({ mode: "toggle-autofuel", amount: 1, unit: "l" } as any, telemetryState);
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain("status-on");
        expect(decoded).not.toContain("status-off");
      });

      it("should show OFF status bar when autofuel is inactive", () => {
        const telemetryState: FuelServiceTelemetryState = { autofuelActive: false };
        const result = generateFuelServiceSvg({ mode: "toggle-autofuel", amount: 1, unit: "l" } as any, telemetryState);
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain("status-off");
        expect(decoded).not.toContain("status-on");
      });

      it("should show N/A status bar when no telemetry state is provided", () => {
        const result = generateFuelServiceSvg({ mode: "toggle-autofuel", amount: 1, unit: "l" } as any);
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain("status-na");
      });

      it("should show N/A status bar when autofuel system is not available", () => {
        const telemetryState: FuelServiceTelemetryState = {
          autofuelEnabled: false,
          autofuelActive: false,
          fuelAmount: 50.0,
          displayUnits: 1,
        };
        const result = generateFuelServiceSvg({ mode: "toggle-autofuel", amount: 1, unit: "l" } as any, telemetryState);
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain("status-na");
        expect(decoded).not.toContain("status-on");
        expect(decoded).not.toContain("status-off");
      });

      it("should not include fuel amount graphic content", () => {
        const telemetryState: FuelServiceTelemetryState = {
          autofuelActive: true,
          fuelAmount: 50.0,
          displayUnits: 1,
        };
        const result = generateFuelServiceSvg({ mode: "toggle-autofuel", amount: 1, unit: "l" } as any, telemetryState);
        const decoded = decodeURIComponent(result);

        expect(decoded).not.toContain("+50 L");
        expect(decoded).not.toContain("--");
      });

      it("should include title content from metadata SVG", () => {
        const telemetryState: FuelServiceTelemetryState = { autofuelActive: true };
        const result = generateFuelServiceSvg({ mode: "toggle-autofuel", amount: 1, unit: "l" } as any, telemetryState);
        const decoded = decodeURIComponent(result);

        // The mock generateTitleText returns <text>{text}</text>
        // resolveTitleSettings returns titleText from SVG desc metadata
        expect(decoded).toContain("<text>");
      });
    });
  });

  describe("long-press repeat", () => {
    let action: FuelService;

    beforeEach(async () => {
      action = new FuelService();
      mockGetGlobalSettings.mockReturnValue({ enableFuelingOnChange: true });
      // Amount modes need live telemetry for the PitSvFuel baseline.
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue(METRIC_TELEMETRY);
      // Appear so activeContexts is populated
      await action.onWillAppear(fakeEvent("action-1", { mode: "add-fuel" }) as any);
    });

    it("should start repeat interval for add-fuel on key down", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel" }) as any);

      expect((action as any).repeatIntervals.has("action-1")).toBe(true);
    });

    it("should start repeat interval for reduce-fuel on key down", async () => {
      await action.onWillAppear(fakeEvent("action-2", { mode: "reduce-fuel" }) as any);
      await action.onKeyDown(fakeEvent("action-2", { mode: "reduce-fuel" }) as any);

      expect((action as any).repeatIntervals.has("action-2")).toBe(true);
    });

    it("should stop repeat interval on key up", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel" }) as any);
      expect((action as any).repeatIntervals.has("action-1")).toBe(true);

      await action.onKeyUp(fakeEvent("action-1") as any);
      expect((action as any).repeatIntervals.has("action-1")).toBe(false);
    });

    it("should clear repeat interval on onWillDisappear", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel" }) as any);
      expect((action as any).repeatIntervals.has("action-1")).toBe(true);

      await action.onWillDisappear(fakeEvent("action-1") as any);
      expect((action as any).repeatIntervals.has("action-1")).toBe(false);
    });

    it("should not start repeat interval for non-repeatable modes", async () => {
      const nonRepeatableModes = [
        "set-fuel-amount",
        "clear-fuel",
        "toggle-fuel-fill",
        "toggle-autofuel",
        "lap-margin-increase",
        "lap-margin-decrease",
      ];

      for (const mode of nonRepeatableModes) {
        await action.onWillAppear(fakeEvent(`ctx-${mode}`, { mode }) as any);
        await action.onKeyDown(fakeEvent(`ctx-${mode}`, { mode }) as any);
      }

      expect((action as any).repeatIntervals.size).toBe(0);
    });

    it("should track multiple contexts independently", async () => {
      await action.onWillAppear(fakeEvent("action-2", { mode: "reduce-fuel" }) as any);

      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel" }) as any);
      await action.onKeyDown(fakeEvent("action-2", { mode: "reduce-fuel" }) as any);
      expect((action as any).repeatIntervals.size).toBe(2);

      await action.onKeyUp(fakeEvent("action-1") as any);
      expect((action as any).repeatIntervals.has("action-1")).toBe(false);
      expect((action as any).repeatIntervals.has("action-2")).toBe(true);

      await action.onKeyUp(fakeEvent("action-2") as any);
      expect((action as any).repeatIntervals.size).toBe(0);
    });

    it("should not start repeat interval on dial press", async () => {
      await action.onDialDown(fakeDialEvent("action-1", { mode: "add-fuel" }) as any);

      expect((action as any).repeatIntervals.size).toBe(0);
    });

    it("should repeat command while held using a self-awaiting loop", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);
        expect(mockPitFuel).toHaveBeenCalledTimes(1);

        // Hold threshold (400ms) must elapse before the loop starts.
        await vi.advanceTimersByTimeAsync(399);
        expect(mockPitFuel).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        // Hold threshold crossed; loop is now scheduled — next fire is REPEAT_GAP_MS (250ms) later.
        expect(mockPitFuel).toHaveBeenCalledTimes(1);

        // With the synchronously-resolving test mock, each tick fires and immediately
        // schedules the next one REPEAT_GAP_MS later, so ticks happen every 250ms.
        await vi.advanceTimersByTimeAsync(250);
        expect(mockPitFuel).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(250);
        expect(mockPitFuel).toHaveBeenCalledTimes(3);

        await action.onKeyUp(fakeEvent("action-1") as any);

        // After release, no further fires — loop stops immediately.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(mockPitFuel).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should auto-stop repeat after safety timeout", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 1, unit: "l" }) as any);
        expect((action as any).repeatIntervals.has("action-1")).toBe(true);

        await vi.advanceTimersByTimeAsync(15_000);

        expect((action as any).repeatIntervals.has("action-1")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should log a warning when safety timeout triggers", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 1, unit: "l" }) as any);

        await vi.advanceTimersByTimeAsync(15_000);

        expect(internals(action).logger.warn).toHaveBeenCalledWith(expect.stringContaining("safety timeout"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("should clear safety timeout when keyUp arrives normally", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 1, unit: "l" }) as any);
        expect((action as any).repeatIntervals.has("action-1")).toBe(true);

        await vi.advanceTimersByTimeAsync(500);
        await action.onKeyUp(fakeEvent("action-1") as any);
        expect((action as any).repeatIntervals.has("action-1")).toBe(false);

        // Advance past safety timeout — no error, nothing happens
        await vi.advanceTimersByTimeAsync(15_000);
        expect((action as any).repeatIntervals.has("action-1")).toBe(false);
        expect(internals(action).logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("safety timeout"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("should fire exactly once for a quick tap shorter than the hold threshold", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);
        expect(mockPitFuel).toHaveBeenCalledTimes(1);

        // Tap released well before the 400ms hold threshold.
        await vi.advanceTimersByTimeAsync(100);
        await action.onKeyUp(fakeEvent("action-1") as any);

        // Advance way past any repeat window — must not fire again.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mockPitFuel).toHaveBeenCalledTimes(1);
        expect((action as any).repeatIntervals.has("action-1")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should fire exactly N times for N rapid taps with no stale timers", async () => {
      vi.useFakeTimers();

      try {
        for (let i = 0; i < 5; i++) {
          await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);
          await vi.advanceTimersByTimeAsync(50);
          await action.onKeyUp(fakeEvent("action-1") as any);
          await vi.advanceTimersByTimeAsync(30);
        }

        expect(mockPitFuel).toHaveBeenCalledTimes(5);
        expect((action as any).repeatIntervals.has("action-1")).toBe(false);

        // Advance past any safety window — still no extra fires.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(mockPitFuel).toHaveBeenCalledTimes(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should cancel a pending hold if keyDown fires again on the same button", async () => {
      vi.useFakeTimers();

      try {
        // First tap starts the hold-detection timer.
        await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);
        expect(mockPitFuel).toHaveBeenCalledTimes(1);

        // A second keyDown (e.g. if a keyUp was lost) must reset the hold timer,
        // not leave two pending timers or jump straight into repeat mode.
        await vi.advanceTimersByTimeAsync(200);
        await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);
        expect(mockPitFuel).toHaveBeenCalledTimes(2);

        await action.onKeyUp(fakeEvent("action-1") as any);

        // No repeats should ever fire for either press.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mockPitFuel).toHaveBeenCalledTimes(2);
        expect((action as any).repeatIntervals.has("action-1")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should cancel pending repeat when onDidReceiveSettings fires mid-hold", async () => {
      vi.useFakeTimers();

      try {
        await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);
        expect((action as any).repeatIntervals.has("action-1")).toBe(true);

        // Settings update arrives before the hold threshold completes.
        await vi.advanceTimersByTimeAsync(200);
        await action.onDidReceiveSettings(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);
        expect((action as any).repeatIntervals.has("action-1")).toBe(false);

        await vi.advanceTimersByTimeAsync(20_000);
        expect(mockPitFuel).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("startRepeat should be a no-op when the button is no longer held", () => {
      // Direct guard test: mirrors the production race where keyUp lands while
      // onKeyDown is still awaiting, so startRepeat runs against a heldButtons
      // set that no longer contains the id. The guard must prevent any timers
      // from being installed — otherwise they'd run orphaned until the 15s
      // safety fires.
      (action as any).heldButtons.add("action-1");
      (action as any).heldButtons.delete("action-1");

      (action as any).startRepeat("action-1");

      expect((action as any).repeatIntervals.has("action-1")).toBe(false);
    });

    it("should not leave stuck timers when keyUp arrives before onKeyDown settles", async () => {
      // The SDK send is synchronous now, but onKeyDown is still async — keyUp can
      // land before its promise settles. The synchronous repeat arming plus the
      // heldButtons guard must guarantee no orphaned timers survive the release.
      vi.useFakeTimers();

      try {
        const keyDownPromise = action.onKeyDown(
          fakeEvent("action-1", { mode: "add-fuel", amount: 1, unit: "l" }) as any,
        );

        // keyUp arrives while onKeyDown is still in flight.
        await action.onKeyUp(fakeEvent("action-1") as any);
        await keyDownPromise;

        expect((action as any).heldButtons.has("action-1")).toBe(false);
        expect((action as any).repeatIntervals.has("action-1")).toBe(false);

        // Advance well past the hold threshold, interval, and safety window.
        await vi.advanceTimersByTimeAsync(20_000);

        // Only the single intended send. No stuck repeat, no safety warning.
        expect(mockPitFuel).toHaveBeenCalledTimes(1);
        expect(internals(action).logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("safety timeout"));
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
