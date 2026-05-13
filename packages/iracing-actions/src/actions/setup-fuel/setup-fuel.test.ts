import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSetupFuelSvg, SETUP_FUEL_GLOBAL_KEYS, SetupFuel } from "./setup-fuel.js";

const { mockTapBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@iracedeck/icons/setup-fuel/disable-fuel-cut.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">disable-fuel-cut {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-fuel/fcy-mode-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fcy-mode-toggle {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-fuel/fuel-cut-position-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fuel-cut-position-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-fuel/fuel-cut-position-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fuel-cut-position-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-fuel/fuel-mixture-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fuel-mixture-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-fuel/fuel-mixture-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fuel-mixture-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-fuel/low-fuel-accept.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">low-fuel-accept {{mainLabel}} {{subLabel}}</svg>',
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
    tapBinding = mockTapBinding;
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
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  generateTitleText: vi.fn(({ text, fill }: { text: string; fill: string }) => {
    if (!text) return "";

    return `<text fill="${fill}">${text}</text>`;
  }),
  renderIconTemplate: vi.fn((_template: string, data: Record<string, string>) => {
    return `<svg>${data.value ?? ""} ${data.titleContent ?? ""}</svg>`;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
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
  getGlobalTitleSettings: vi.fn(() => ({})),
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
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
  assembleIcon: vi.fn(
    ({ graphicSvg, title }: { graphicSvg: string; colors: unknown; title: { titleText: string } }) => {
      const encoded = encodeURIComponent(`<svg>${graphicSvg}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
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

    it("should call tapGlobalBinding on keyDown for disable-fuel-cut", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "disable-fuel-cut" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelDisableFuelCut");
    });

    it("should call tapGlobalBinding on keyDown for low-fuel-accept", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "low-fuel-accept" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelLowFuelAccept");
    });

    it("should call tapGlobalBinding on keyDown for fcy-mode-toggle", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "fcy-mode-toggle" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFcyModeToggle");
    });

    it("should call tapGlobalBinding for fuel-mixture increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "fuel-mixture", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelMixtureIncrease");
    });

    it("should call tapGlobalBinding for fuel-mixture decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "fuel-mixture", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelMixtureDecrease");
    });

    it("should call tapGlobalBinding for fuel-cut-position increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "fuel-cut-position", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelCutPositionIncrease");
    });

    it("should call tapGlobalBinding for fuel-cut-position decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "fuel-cut-position", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelCutPositionDecrease");
    });

    it("should call tapGlobalBinding on dialDown", async () => {
      await action.onDialDown(fakeEvent("action-1", { setting: "disable-fuel-cut" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelDisableFuelCut");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "disable-fuel-cut" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelDisableFuelCut");
    });

    it("should call tapGlobalBinding for directional settings", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "fuel-mixture", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelMixtureIncrease");
    });
  });

  describe("encoder behavior", () => {
    let action: SetupFuel;

    beforeEach(() => {
      action = new SetupFuel();
    });

    it("should call tapGlobalBinding for increase on clockwise rotation for directional controls", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "fuel-mixture", direction: "increase" }, 1) as any,
      );

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelMixtureIncrease");
    });

    it("should call tapGlobalBinding for decrease on counter-clockwise rotation for directional controls", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "fuel-mixture", direction: "increase" }, -1) as any,
      );

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelMixtureDecrease");
    });

    it("should call tapGlobalBinding for fuel-cut-position rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "fuel-cut-position", direction: "increase" }, 2) as any,
      );

      expect(mockTapBinding).toHaveBeenCalledWith("setupFuelFuelCutPositionIncrease");
    });

    it("should ignore rotation for non-directional controls (disable-fuel-cut)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "disable-fuel-cut" }, 1) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("should ignore rotation for non-directional controls (low-fuel-accept)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "low-fuel-accept" }, 1) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("should ignore rotation for non-directional controls (fcy-mode-toggle)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "fcy-mode-toggle" }, -1) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("view sub-modes (issue #541)", () => {
    let action: SetupFuel;

    beforeEach(() => {
      action = new SetupFuel();
      (action.sdkController.getCurrentTelemetry as any).mockReturnValue({ dcFuelMixture: 5 });
    });

    it("renders the formatted telemetry value for a View setting", async () => {
      const ev = fakeEvent("action-1", { setting: "view-fuel-mixture" }) as any;
      await action.onWillAppear(ev);
      const calls = (action.setKeyImage as any).mock.calls;
      const svg = decodeURIComponent(calls[0][1] as string);
      expect(svg).toContain("5");
    });

    it("does not fire a binding when a View setting is pressed", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-fuel-cut-position" }) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });
});
