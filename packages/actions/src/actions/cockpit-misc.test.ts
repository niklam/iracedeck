import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  COCKPIT_MISC_GLOBAL_KEYS,
  CockpitMisc,
  generateCockpitMiscSvg,
  generateEnterExitTowSvg,
  getEnterExitTowState,
} from "./cockpit-misc.js";

const { mockTapBinding, mockHoldBinding, mockReleaseBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockHoldBinding: vi.fn().mockResolvedValue(undefined),
  mockReleaseBinding: vi.fn().mockResolvedValue(undefined),
}));

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
vi.mock("@iracedeck/icons/cockpit-misc/enter-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">enter-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/exit-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">exit-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/reset-to-pits.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">reset-to-pits {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/tow.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">tow {{mainLabel}} {{subLabel}}</svg>',
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
    sdkController = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getCurrentTelemetry: vi.fn(),
      getSessionInfo: vi.fn(() => null),
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn().mockResolvedValue(true);
    tapBinding = mockTapBinding;
    holdBinding = mockHoldBinding;
    releaseBinding = mockReleaseBinding;
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

    it("should have exactly 11 entries", () => {
      expect(Object.keys(COCKPIT_MISC_GLOBAL_KEYS)).toHaveLength(11);
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
        "enter-exit-tow",
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
        "enter-exit-tow": {
          increase: { mainLabel: "ENTER", subLabel: "" },
          decrease: { mainLabel: "ENTER", subLabel: "" },
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

    it("should generate a valid data URI for enter-exit-tow", () => {
      const result = generateCockpitMiscSvg({ control: "enter-exit-tow", direction: "increase" });
      expect(result).toContain("data:image/svg+xml");
    });

    it("should include ENTER label for enter-exit-tow", () => {
      const result = generateCockpitMiscSvg({ control: "enter-exit-tow", direction: "increase" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("ENTER");
    });
  });

  describe("getEnterExitTowState", () => {
    it("should return enter-car when telemetry is null", () => {
      expect(getEnterExitTowState(null, null)).toBe("enter-car");
    });

    it("should return enter-car when IsOnTrack is false", () => {
      expect(getEnterExitTowState({ IsOnTrack: false }, null)).toBe("enter-car");
    });

    it("should return enter-car when IsOnTrack is undefined", () => {
      expect(getEnterExitTowState({}, null)).toBe("enter-car");
    });

    it("should return exit-car when on track and in pit stall", () => {
      expect(getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: true }, null)).toBe("exit-car");
    });

    it("should return reset-to-pits when on track, not in pit stall, and session is Practice", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [{ SessionNum: 0, SessionType: "Practice" }],
        },
      };
      expect(getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 }, sessionInfo)).toBe(
        "reset-to-pits",
      );
    });

    it("should return tow when on track, not in pit stall, and session is Race", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [{ SessionNum: 0, SessionType: "Race" }],
        },
      };
      expect(getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 }, sessionInfo)).toBe(
        "tow",
      );
    });

    it("should return reset-to-pits when on track, not in pit stall, and session is Qualifying", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [{ SessionNum: 0, SessionType: "Qualifying" }],
        },
      };
      expect(getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 }, sessionInfo)).toBe(
        "reset-to-pits",
      );
    });

    it("should return reset-to-pits when on track, not in pit stall, and sessionInfo is null", () => {
      expect(getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 }, null)).toBe(
        "reset-to-pits",
      );
    });

    it("should return reset-to-pits when SessionNum doesn't match any session", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [{ SessionNum: 0, SessionType: "Race" }],
        },
      };
      expect(getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 5 }, sessionInfo)).toBe(
        "reset-to-pits",
      );
    });

    it("should select the correct session when there are multiple sessions", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [
            { SessionNum: 0, SessionType: "Practice" },
            { SessionNum: 1, SessionType: "Qualifying" },
            { SessionNum: 2, SessionType: "Race" },
          ],
        },
      };
      expect(getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 2 }, sessionInfo)).toBe(
        "tow",
      );
      expect(getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 }, sessionInfo)).toBe(
        "reset-to-pits",
      );
    });
  });

  describe("generateEnterExitTowSvg", () => {
    it("should produce different icons for all 4 states", () => {
      const enterCar = generateEnterExitTowSvg("enter-car", undefined);
      const exitCar = generateEnterExitTowSvg("exit-car", undefined);
      const resetToPits = generateEnterExitTowSvg("reset-to-pits", undefined);
      const tow = generateEnterExitTowSvg("tow", undefined);

      expect(enterCar).not.toBe(exitCar);
      expect(enterCar).not.toBe(resetToPits);
      expect(enterCar).not.toBe(tow);
      expect(exitCar).not.toBe(resetToPits);
      expect(exitCar).not.toBe(tow);
      expect(resetToPits).not.toBe(tow);
    });

    it("should include ENTER label for enter-car state", () => {
      const result = generateEnterExitTowSvg("enter-car", undefined);
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("ENTER");
    });

    it("should include EXIT label for exit-car state", () => {
      const result = generateEnterExitTowSvg("exit-car", undefined);
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("EXIT");
    });

    it("should include RESET label for reset-to-pits state", () => {
      const result = generateEnterExitTowSvg("reset-to-pits", undefined);
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("RESET");
    });

    it("should include TOW label for tow state", () => {
      const result = generateEnterExitTowSvg("tow", undefined);
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("TOW");
    });

    it("should return a valid data URI", () => {
      const result = generateEnterExitTowSvg("enter-car", undefined);
      expect(result).toContain("data:image/svg+xml");
    });
  });

  describe("tap behavior", () => {
    let action: CockpitMisc;

    beforeEach(() => {
      action = new CockpitMisc();
    });

    it("should call tapGlobalBinding on keyDown for trigger-wipers", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "trigger-wipers" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscTriggerWipers");
    });

    it("should call tapGlobalBinding on keyDown for report-latency", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "report-latency" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscReportLatency");
    });

    it("should call tapGlobalBinding on keyDown for in-lap-mode", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "in-lap-mode" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscInLapMode");
    });

    it("should call tapGlobalBinding for ffb-max-force increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "ffb-max-force", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceIncrease");
    });

    it("should call tapGlobalBinding for ffb-max-force decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "ffb-max-force", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceDecrease");
    });

    it("should call tapGlobalBinding for dash-page-1 increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "dash-page-1", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscDashPage1Increase");
    });

    it("should call tapGlobalBinding for dash-page-2 decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "dash-page-2", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscDashPage2Decrease");
    });

    it("should call tapGlobalBinding on dialDown", async () => {
      await action.onDialDown(fakeEvent("action-1", { control: "trigger-wipers" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscTriggerWipers");
    });

    it("should call tapGlobalBinding on keyDown for toggle-wipers", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "toggle-wipers" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscToggleWipers");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "trigger-wipers" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscTriggerWipers");
    });

    it("should call tapGlobalBinding even for report-latency with no binding", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "report-latency" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscReportLatency");
    });
  });

  describe("enter-exit-tow telemetry subscription", () => {
    let action: CockpitMisc;

    beforeEach(() => {
      action = new CockpitMisc();
    });

    it("should subscribe to telemetry on willAppear for enter-exit-tow", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(action.sdkController.subscribe).toHaveBeenCalledWith("action-1", expect.any(Function));
    });

    it("should not subscribe to telemetry for non-enter-exit-tow controls", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "toggle-wipers" }) as any);

      expect(action.sdkController.subscribe).not.toHaveBeenCalled();
    });

    it("should unsubscribe on willDisappear when subscribed", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);
      await action.onWillDisappear(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(action.sdkController.unsubscribe).toHaveBeenCalledWith("action-1");
    });

    it("should not unsubscribe on willDisappear for non-enter-exit-tow controls", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "toggle-wipers" }) as any);
      await action.onWillDisappear(fakeEvent("action-1", { control: "toggle-wipers" }) as any);

      expect(action.sdkController.unsubscribe).not.toHaveBeenCalled();
    });

    it("should subscribe when switching to enter-exit-tow via settings change", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "toggle-wipers" }) as any);
      await action.onDidReceiveSettings(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(action.sdkController.subscribe).toHaveBeenCalledWith("action-1", expect.any(Function));
    });

    it("should unsubscribe when switching away from enter-exit-tow via settings change", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);
      await action.onDidReceiveSettings(fakeEvent("action-1", { control: "toggle-wipers" }) as any);

      expect(action.sdkController.unsubscribe).toHaveBeenCalledWith("action-1");
    });
  });

  describe("enter-exit-tow hold/release behavior", () => {
    let action: CockpitMisc;

    beforeEach(() => {
      action = new CockpitMisc();
    });

    it("should use holdBinding on keyDown for enter-exit-tow", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "cockpitMiscEnterExitTow");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("should use releaseBinding on keyUp for enter-exit-tow", async () => {
      await action.onKeyUp(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should still use tapBinding on keyDown for non-enter-exit-tow controls", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "toggle-wipers" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscToggleWipers");
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("should release binding on willDisappear for enter-exit-tow", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);
      await action.onWillDisappear(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should ignore dial rotation for enter-exit-tow", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { control: "enter-exit-tow" }, 1) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("should use holdBinding on dialDown for enter-exit-tow", async () => {
      await action.onDialDown(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "cockpitMiscEnterExitTow");
      expect(mockTapBinding).not.toHaveBeenCalled();
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

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceIncrease");
    });

    it("should call tapGlobalBinding for decrease on counter-clockwise rotation for directional controls", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { control: "ffb-max-force", direction: "increase" }, -1) as any,
      );

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscFfbForceDecrease");
    });

    it("should call tapGlobalBinding for dash-page-1 rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { control: "dash-page-1", direction: "increase" }, 2) as any,
      );

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscDashPage1Increase");
    });

    it("should ignore rotation for non-directional controls (toggle-wipers)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { control: "toggle-wipers" }, 1) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("should ignore rotation for non-directional controls (trigger-wipers)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { control: "trigger-wipers" }, 1) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("should ignore rotation for non-directional controls (report-latency)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { control: "report-latency" }, -1) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("should ignore rotation for non-directional controls (in-lap-mode)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { control: "in-lap-mode" }, 1) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });
});
