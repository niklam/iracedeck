import { beforeEach, describe, expect, it, vi } from "vitest";

import { COCKPIT_MISC_GLOBAL_KEYS, CockpitMisc, generateCockpitMiscSvg } from "./cockpit-misc.js";

vi.mock("@iracedeck/icons/cockpit-misc/toggle-wipers.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">toggle-wipers {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/trigger-wipers.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">trigger-wipers {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/ffb-max-force-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">ffb-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/ffb-max-force-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">ffb-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/report-latency.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">report-latency {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/dash-page-1-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">dash-1-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/dash-page-1-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">dash-1-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/dash-page-2-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">dash-2-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/dash-page-2-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">dash-2-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/in-lap-mode.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">in-lap-mode {{mainLabel}} {{subLabel}}</svg>',
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

describe("CockpitMisc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("COCKPIT_MISC_GLOBAL_KEYS", () => {
    it("should have correct mapping for trigger-wipers", () => {
      expect(COCKPIT_MISC_GLOBAL_KEYS["trigger-wipers"]).toBe("cockpitMiscTriggerWipers");
    });

    it("should have correct mapping for ffb-max-force-increase", () => {
      expect(COCKPIT_MISC_GLOBAL_KEYS["ffb-max-force-increase"]).toBe("cockpitMiscFfbForceIncrease");
    });

    it("should have correct mapping for ffb-max-force-decrease", () => {
      expect(COCKPIT_MISC_GLOBAL_KEYS["ffb-max-force-decrease"]).toBe("cockpitMiscFfbForceDecrease");
    });

    it("should have correct mapping for report-latency", () => {
      expect(COCKPIT_MISC_GLOBAL_KEYS["report-latency"]).toBe("cockpitMiscReportLatency");
    });

    it("should have correct mapping for dash-page-1-increase", () => {
      expect(COCKPIT_MISC_GLOBAL_KEYS["dash-page-1-increase"]).toBe("cockpitMiscDashPage1Increase");
    });

    it("should have correct mapping for dash-page-1-decrease", () => {
      expect(COCKPIT_MISC_GLOBAL_KEYS["dash-page-1-decrease"]).toBe("cockpitMiscDashPage1Decrease");
    });

    it("should have correct mapping for dash-page-2-increase", () => {
      expect(COCKPIT_MISC_GLOBAL_KEYS["dash-page-2-increase"]).toBe("cockpitMiscDashPage2Increase");
    });

    it("should have correct mapping for dash-page-2-decrease", () => {
      expect(COCKPIT_MISC_GLOBAL_KEYS["dash-page-2-decrease"]).toBe("cockpitMiscDashPage2Decrease");
    });

    it("should have correct mapping for in-lap-mode", () => {
      expect(COCKPIT_MISC_GLOBAL_KEYS["in-lap-mode"]).toBe("cockpitMiscInLapMode");
    });

    it("should have correct mapping for toggle-wipers", () => {
      expect(COCKPIT_MISC_GLOBAL_KEYS["toggle-wipers"]).toBe("cockpitMiscToggleWipers");
    });

    it("should have exactly 10 entries", () => {
      expect(Object.keys(COCKPIT_MISC_GLOBAL_KEYS)).toHaveLength(10);
    });
  });

  describe("generateCockpitMiscSvg", () => {
    it("should generate a valid data URI for toggle-wipers", () => {
      const result = generateCockpitMiscSvg({ control: "toggle-wipers", direction: "increase" });
      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce same icon for toggle-wipers regardless of direction", () => {
      const increase = generateCockpitMiscSvg({ control: "toggle-wipers", direction: "increase" });
      const decrease = generateCockpitMiscSvg({ control: "toggle-wipers", direction: "decrease" });
      expect(increase).toBe(decrease);
    });

    it("should include correct labels for toggle-wipers", () => {
      const result = generateCockpitMiscSvg({ control: "toggle-wipers", direction: "increase" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("WIPERS");
      expect(decoded).toContain("TOGGLE");
    });

    it("should produce different icons for toggle-wipers vs trigger-wipers", () => {
      const toggle = generateCockpitMiscSvg({ control: "toggle-wipers", direction: "increase" });
      const trigger = generateCockpitMiscSvg({ control: "trigger-wipers", direction: "increase" });
      expect(toggle).not.toBe(trigger);
    });

    it("should generate a valid data URI for trigger-wipers", () => {
      const result = generateCockpitMiscSvg({ control: "trigger-wipers", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for report-latency", () => {
      const result = generateCockpitMiscSvg({ control: "report-latency", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for in-lap-mode", () => {
      const result = generateCockpitMiscSvg({ control: "in-lap-mode", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all control + direction combinations", () => {
      const controls = [
        "toggle-wipers",
        "trigger-wipers",
        "ffb-max-force",
        "report-latency",
        "dash-page-1",
        "dash-page-2",
        "in-lap-mode",
      ] as const;
      const directions = ["increase", "decrease"] as const;

      for (const control of controls) {
        for (const direction of directions) {
          const result = generateCockpitMiscSvg({ control, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different controls", () => {
      const wipers = generateCockpitMiscSvg({ control: "trigger-wipers", direction: "increase" });
      const latency = generateCockpitMiscSvg({ control: "report-latency", direction: "increase" });

      expect(wipers).not.toBe(latency);
    });

    it("should produce different icons for increase vs decrease on directional controls", () => {
      const increase = generateCockpitMiscSvg({ control: "ffb-max-force", direction: "increase" });
      const decrease = generateCockpitMiscSvg({ control: "ffb-max-force", direction: "decrease" });

      expect(increase).not.toBe(decrease);
    });

    it("should produce same icon for non-directional controls regardless of direction", () => {
      const increase = generateCockpitMiscSvg({ control: "trigger-wipers", direction: "increase" });
      const decrease = generateCockpitMiscSvg({ control: "trigger-wipers", direction: "decrease" });

      expect(increase).toBe(decrease);
    });

    it("should include correct labels for trigger-wipers", () => {
      const result = generateCockpitMiscSvg({ control: "trigger-wipers", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("WIPERS");
      expect(decoded).toContain("TRIGGER");
    });

    it("should include correct labels for ffb-max-force increase", () => {
      const result = generateCockpitMiscSvg({ control: "ffb-max-force", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FFB FORCE");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for ffb-max-force decrease", () => {
      const result = generateCockpitMiscSvg({ control: "ffb-max-force", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FFB FORCE");
      expect(decoded).toContain("DECREASE");
    });

    it("should include correct labels for dash-page-1 increase", () => {
      const result = generateCockpitMiscSvg({ control: "dash-page-1", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("DASH PG 1");
      expect(decoded).toContain("NEXT");
    });

    it("should include correct labels for dash-page-2 decrease", () => {
      const result = generateCockpitMiscSvg({ control: "dash-page-2", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("DASH PG 2");
      expect(decoded).toContain("PREVIOUS");
    });

    it("should include correct labels for in-lap-mode", () => {
      const result = generateCockpitMiscSvg({ control: "in-lap-mode", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("IN LAP");
      expect(decoded).toContain("MODE");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { mainLabel: string; subLabel: string }>> = {
        "toggle-wipers": {
          increase: { mainLabel: "WIPERS", subLabel: "TOGGLE" },
          decrease: { mainLabel: "WIPERS", subLabel: "TOGGLE" },
        },
        "trigger-wipers": {
          increase: { mainLabel: "WIPERS", subLabel: "TRIGGER" },
          decrease: { mainLabel: "WIPERS", subLabel: "TRIGGER" },
        },
        "ffb-max-force": {
          increase: { mainLabel: "FFB FORCE", subLabel: "INCREASE" },
          decrease: { mainLabel: "FFB FORCE", subLabel: "DECREASE" },
        },
        "report-latency": {
          increase: { mainLabel: "LATENCY", subLabel: "REPORT" },
          decrease: { mainLabel: "LATENCY", subLabel: "REPORT" },
        },
        "dash-page-1": {
          increase: { mainLabel: "DASH PG 1", subLabel: "NEXT" },
          decrease: { mainLabel: "DASH PG 1", subLabel: "PREVIOUS" },
        },
        "dash-page-2": {
          increase: { mainLabel: "DASH PG 2", subLabel: "NEXT" },
          decrease: { mainLabel: "DASH PG 2", subLabel: "PREVIOUS" },
        },
        "in-lap-mode": {
          increase: { mainLabel: "IN LAP", subLabel: "MODE" },
          decrease: { mainLabel: "IN LAP", subLabel: "MODE" },
        },
      };

      for (const [control, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateCockpitMiscSvg({
            control: control as any,
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
    let action: CockpitMisc;

    beforeEach(() => {
      action = new CockpitMisc();
    });

    it("should call tapGlobalBinding on keyDown for trigger-wipers", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "trigger-wipers" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscTriggerWipers");
    });

    it("should call tapGlobalBinding on keyDown for report-latency", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "report-latency" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscReportLatency");
    });

    it("should call tapGlobalBinding on keyDown for in-lap-mode", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "in-lap-mode" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscInLapMode");
    });

    it("should call tapGlobalBinding for ffb-max-force increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "ffb-max-force", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceIncrease");
    });

    it("should call tapGlobalBinding for ffb-max-force decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "ffb-max-force", direction: "decrease" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceDecrease");
    });

    it("should call tapGlobalBinding for dash-page-1 increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "dash-page-1", direction: "increase" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscDashPage1Increase");
    });

    it("should call tapGlobalBinding for dash-page-2 decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "dash-page-2", direction: "decrease" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscDashPage2Decrease");
    });

    it("should call tapGlobalBinding on dialDown", async () => {
      await action.onDialDown(fakeEvent("action-1", { control: "trigger-wipers" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscTriggerWipers");
    });

    it("should call tapGlobalBinding on keyDown for toggle-wipers", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "toggle-wipers" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscToggleWipers");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "trigger-wipers" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscTriggerWipers");
    });

    it("should call tapGlobalBinding even for report-latency with no binding", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "report-latency" }) as any);

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscReportLatency");
    });
  });

  describe("encoder behavior", () => {
    let action: CockpitMisc;

    beforeEach(() => {
      action = new CockpitMisc();
    });

    it("should call tapGlobalBinding for increase on clockwise rotation for directional controls", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { control: "ffb-max-force", direction: "increase" }, 1) as any,
      );

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceIncrease");
    });

    it("should call tapGlobalBinding for decrease on counter-clockwise rotation for directional controls", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { control: "ffb-max-force", direction: "increase" }, -1) as any,
      );

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceDecrease");
    });

    it("should call tapGlobalBinding for dash-page-1 rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { control: "dash-page-1", direction: "increase" }, 2) as any,
      );

      expect(action.tapBinding).toHaveBeenCalledWith("cockpitMiscDashPage1Increase");
    });

    it("should ignore rotation for non-directional controls (toggle-wipers)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { control: "toggle-wipers" }, 1) as any);

      expect(action.tapBinding).not.toHaveBeenCalled();
    });

    it("should ignore rotation for non-directional controls (trigger-wipers)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { control: "trigger-wipers" }, 1) as any);

      expect(action.tapBinding).not.toHaveBeenCalled();
    });

    it("should ignore rotation for non-directional controls (report-latency)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { control: "report-latency" }, -1) as any);

      expect(action.tapBinding).not.toHaveBeenCalled();
    });

    it("should ignore rotation for non-directional controls (in-lap-mode)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { control: "in-lap-mode" }, 1) as any);

      expect(action.tapBinding).not.toHaveBeenCalled();
    });
  });
});
