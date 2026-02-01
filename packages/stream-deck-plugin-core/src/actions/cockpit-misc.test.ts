import { beforeEach, describe, expect, it, vi } from "vitest";

import { COCKPIT_MISC_GLOBAL_KEYS, CockpitMisc, generateCockpitMiscSvg } from "./cockpit-misc.js";

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

    it("should have exactly 9 entries", () => {
      expect(Object.keys(COCKPIT_MISC_GLOBAL_KEYS)).toHaveLength(9);
    });
  });

  describe("generateCockpitMiscSvg", () => {
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
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        "trigger-wipers": {
          increase: { line1: "WIPERS", line2: "TRIGGER" },
          decrease: { line1: "WIPERS", line2: "TRIGGER" },
        },
        "ffb-max-force": {
          increase: { line1: "FFB FORCE", line2: "INCREASE" },
          decrease: { line1: "FFB FORCE", line2: "DECREASE" },
        },
        "report-latency": {
          increase: { line1: "LATENCY", line2: "REPORT" },
          decrease: { line1: "LATENCY", line2: "REPORT" },
        },
        "dash-page-1": {
          increase: { line1: "DASH PG 1", line2: "NEXT" },
          decrease: { line1: "DASH PG 1", line2: "PREVIOUS" },
        },
        "dash-page-2": {
          increase: { line1: "DASH PG 2", line2: "NEXT" },
          decrease: { line1: "DASH PG 2", line2: "PREVIOUS" },
        },
        "in-lap-mode": {
          increase: { line1: "IN LAP", line2: "MODE" },
          decrease: { line1: "IN LAP", line2: "MODE" },
        },
      };

      for (const [control, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateCockpitMiscSvg({
            control: control as any,
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
    let action: CockpitMisc;

    beforeEach(() => {
      action = new CockpitMisc();
    });

    it("should call sendKeyCombination on keyDown for trigger-wipers", async () => {
      mockGetGlobalSettings.mockReturnValue({ cockpitMiscTriggerWipers: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "w", modifiers: ["ctrl", "alt"], code: "KeyW" });

      await action.onKeyDown(fakeEvent("action-1", { control: "trigger-wipers" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "w",
        modifiers: ["ctrl", "alt"],
        code: "KeyW",
      });
    });

    it("should call sendKeyCombination on keyDown for report-latency", async () => {
      mockGetGlobalSettings.mockReturnValue({ cockpitMiscReportLatency: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "l", modifiers: [], code: "KeyL" });

      await action.onKeyDown(fakeEvent("action-1", { control: "report-latency" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "l",
        modifiers: undefined,
        code: "KeyL",
      });
    });

    it("should call sendKeyCombination on keyDown for in-lap-mode", async () => {
      mockGetGlobalSettings.mockReturnValue({ cockpitMiscInLapMode: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "l", modifiers: ["shift", "alt"], code: "KeyL" });

      await action.onKeyDown(fakeEvent("action-1", { control: "in-lap-mode" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "l",
        modifiers: ["shift", "alt"],
        code: "KeyL",
      });
    });

    it("should call sendKeyCombination for ffb-max-force increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ cockpitMiscFfbForceIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "up", modifiers: [], code: "ArrowUp" });

      await action.onKeyDown(fakeEvent("action-1", { control: "ffb-max-force", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "up",
        modifiers: undefined,
        code: "ArrowUp",
      });
    });

    it("should call sendKeyCombination for ffb-max-force decrease", async () => {
      mockGetGlobalSettings.mockReturnValue({ cockpitMiscFfbForceDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "down", modifiers: [], code: "ArrowDown" });

      await action.onKeyDown(fakeEvent("action-1", { control: "ffb-max-force", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "down",
        modifiers: undefined,
        code: "ArrowDown",
      });
    });

    it("should call sendKeyCombination for dash-page-1 increase", async () => {
      mockGetGlobalSettings.mockReturnValue({ cockpitMiscDashPage1Increase: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "pageup", modifiers: [], code: "PageUp" });

      await action.onKeyDown(fakeEvent("action-1", { control: "dash-page-1", direction: "increase" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should call sendKeyCombination for dash-page-2 decrease", async () => {
      mockGetGlobalSettings.mockReturnValue({ cockpitMiscDashPage2Decrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "pagedown", modifiers: [], code: "PageDown" });

      await action.onKeyDown(fakeEvent("action-1", { control: "dash-page-2", direction: "decrease" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should call sendKeyCombination on dialDown", async () => {
      mockGetGlobalSettings.mockReturnValue({ cockpitMiscTriggerWipers: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "w", modifiers: ["ctrl", "alt"], code: "KeyW" });

      await action.onDialDown(fakeEvent("action-1", { control: "trigger-wipers" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should handle missing key binding gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { control: "trigger-wipers" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should handle missing global key mapping gracefully", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { control: "report-latency" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });

  describe("encoder behavior", () => {
    let action: CockpitMisc;

    beforeEach(() => {
      action = new CockpitMisc();
    });

    it("should send increase key on clockwise rotation for directional controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ cockpitMiscFfbForceIncrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "up", modifiers: [], code: "ArrowUp" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { control: "ffb-max-force", direction: "increase" }, 1) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "up",
        modifiers: undefined,
        code: "ArrowUp",
      });
    });

    it("should send decrease key on counter-clockwise rotation for directional controls", async () => {
      mockGetGlobalSettings.mockReturnValue({ cockpitMiscFfbForceDecrease: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "down", modifiers: [], code: "ArrowDown" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { control: "ffb-max-force", direction: "increase" }, -1) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "down",
        modifiers: undefined,
        code: "ArrowDown",
      });
    });

    it("should send correct key for dash-page-1 rotation", async () => {
      mockGetGlobalSettings.mockReturnValue({ cockpitMiscDashPage1Increase: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "pageup", modifiers: [], code: "PageUp" });

      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { control: "dash-page-1", direction: "increase" }, 2) as any,
      );

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
    });

    it("should ignore rotation for non-directional controls (trigger-wipers)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { control: "trigger-wipers" }, 1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should ignore rotation for non-directional controls (report-latency)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { control: "report-latency" }, -1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });

    it("should ignore rotation for non-directional controls (in-lap-mode)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { control: "in-lap-mode" }, 1) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });
});
