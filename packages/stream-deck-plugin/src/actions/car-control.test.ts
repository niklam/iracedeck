import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAR_CONTROL_GLOBAL_KEYS,
  CarControl,
  generateCarControlSvg,
  getPitSpeedLimit,
  isPitLimiterActive,
  parsePitSpeedLimit,
  pitLimiterActiveIcon,
  pitLimiterInactiveIcon,
} from "./car-control.js";

const {
  mockPressKeyCombination,
  mockReleaseKeyCombination,
  mockSendKeyCombination,
  mockParseKeyBinding,
  mockGetGlobalSettings,
  mockGetSessionInfo,
} = vi.hoisted(() => ({
  mockPressKeyCombination: vi.fn().mockResolvedValue(true),
  mockReleaseKeyCombination: vi.fn().mockResolvedValue(true),
  mockSendKeyCombination: vi.fn().mockResolvedValue(true),
  mockParseKeyBinding: vi.fn(),
  mockGetGlobalSettings: vi.fn(() => ({})),
  mockGetSessionInfo: vi.fn((): Record<string, unknown> | null => null),
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

vi.mock("@iracedeck/iracing-sdk", () => ({
  hasFlag: (value: number, flag: number) => (value & flag) !== 0,
  EngineWarnings: { PitSpeedLimiter: 0x0010 },
}));

vi.mock("../shared/index.js", () => ({
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    updateKeyImage = vi.fn().mockResolvedValue(true);
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
  getSDK: vi.fn(() => ({ sdk: { getSessionInfo: mockGetSessionInfo } })),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: mockSendKeyCombination,
    pressKeyCombination: mockPressKeyCombination,
    releaseKeyCombination: mockReleaseKeyCombination,
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

describe("CarControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("CAR_CONTROL_GLOBAL_KEYS", () => {
    it("should have correct mapping for starter", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["starter"]).toBe("carControlStarter");
    });

    it("should have correct mapping for ignition", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["ignition"]).toBe("carControlIgnition");
    });

    it("should have correct mapping for pit-speed-limiter", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["pit-speed-limiter"]).toBe("carControlPitSpeedLimiter");
    });

    it("should have correct mapping for enter-exit-tow", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["enter-exit-tow"]).toBe("carControlEnterExitTow");
    });

    it("should have correct mapping for pause-sim", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["pause-sim"]).toBe("carControlPauseSim");
    });

    it("should have exactly 5 entries", () => {
      expect(Object.keys(CAR_CONTROL_GLOBAL_KEYS)).toHaveLength(5);
    });
  });

  describe("generateCarControlSvg", () => {
    it("should generate a valid data URI for starter", () => {
      const result = generateCarControlSvg({ control: "starter" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for ignition", () => {
      const result = generateCarControlSvg({ control: "ignition" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all controls", () => {
      const controls = [
        "starter",
        "ignition",
        "pit-speed-limiter",
        "enter-exit-tow",
        "pause-sim",
      ] as const;

      for (const control of controls) {
        const result = generateCarControlSvg({ control });
        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different controls", () => {
      const starter = generateCarControlSvg({ control: "starter" });
      const ignition = generateCarControlSvg({ control: "ignition" });

      expect(starter).not.toBe(ignition);
    });

    it("should include correct labels for all controls", () => {
      const expectedLabels: Record<string, { line1: string; line2: string }> = {
        starter: { line1: "START", line2: "ENGINE" },
        ignition: { line1: "IGNITION", line2: "ON/OFF" },
        "pit-speed-limiter": { line1: "PIT", line2: "LIMITER" },
        "enter-exit-tow": { line1: "ENTER/EXIT", line2: "TOW" },
        "pause-sim": { line1: "PAUSE", line2: "SIM" },
      };

      for (const [control, labels] of Object.entries(expectedLabels)) {
        const result = generateCarControlSvg({ control: control as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);
        expect(decoded).toContain(labels.line2);
      }
    });
  });

  describe("tap behavior (non-starter controls)", () => {
    let action: CarControl;

    function setupKeyBinding(key: string, modifiers: string[] = [], code?: string) {
      mockGetGlobalSettings.mockReturnValue({ carControlIgnition: "bound" });
      mockParseKeyBinding.mockReturnValue({ key, modifiers, code });
    }

    beforeEach(() => {
      action = new CarControl();
    });

    it("should call sendKeyCombination on keyDown for ignition", async () => {
      setupKeyBinding("i", [], "KeyI");

      await action.onKeyDown(fakeEvent("action-1", { control: "ignition" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "i",
        modifiers: undefined,
        code: "KeyI",
      });
      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should call sendKeyCombination on keyDown for pit-speed-limiter", async () => {
      mockGetGlobalSettings.mockReturnValue({ carControlPitSpeedLimiter: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "a", modifiers: [], code: "KeyA" });

      await action.onKeyDown(fakeEvent("action-1", { control: "pit-speed-limiter" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should call sendKeyCombination on keyDown for enter-exit-tow", async () => {
      mockGetGlobalSettings.mockReturnValue({ carControlEnterExitTow: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "r", modifiers: ["shift"], code: "KeyR" });

      await action.onKeyDown(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "r",
        modifiers: ["shift"],
        code: "KeyR",
      });
    });

    it("should call sendKeyCombination on keyDown for pause-sim", async () => {
      mockGetGlobalSettings.mockReturnValue({ carControlPauseSim: "bound" });
      mockParseKeyBinding.mockReturnValue({ key: "p", modifiers: ["shift"], code: "KeyP" });

      await action.onKeyDown(fakeEvent("action-1", { control: "pause-sim" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should call sendKeyCombination on dialDown for non-starter controls", async () => {
      setupKeyBinding("i", [], "KeyI");

      await action.onDialDown(fakeEvent("action-1", { control: "ignition" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should handle missing key binding gracefully for tap controls", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { control: "ignition" }) as any);

      expect(mockSendKeyCombination).not.toHaveBeenCalled();
    });
  });

  describe("isPitLimiterActive", () => {
    it("should return false when telemetry is null", () => {
      expect(isPitLimiterActive(null)).toBe(false);
    });

    it("should return false when EngineWarnings is undefined", () => {
      expect(isPitLimiterActive({} as any)).toBe(false);
    });

    it("should return false when pit speed limiter flag is not set", () => {
      expect(isPitLimiterActive({ EngineWarnings: 0 } as any)).toBe(false);
    });

    it("should return true when pit speed limiter flag is set", () => {
      expect(isPitLimiterActive({ EngineWarnings: 0x0010 } as any)).toBe(true);
    });

    it("should return true when pit speed limiter is set among other flags", () => {
      expect(isPitLimiterActive({ EngineWarnings: 0x0011 } as any)).toBe(true);
    });
  });

  describe("parsePitSpeedLimit", () => {
    it("should parse '80.00 kph' to 80", () => {
      expect(parsePitSpeedLimit("80.00 kph")).toBe(80);
    });

    it("should parse '60.00 mph' to 60", () => {
      expect(parsePitSpeedLimit("60.00 mph")).toBe(60);
    });

    it("should parse '100.50 kph' to 100", () => {
      expect(parsePitSpeedLimit("100.50 kph")).toBe(100);
    });

    it("should return 80 for undefined", () => {
      expect(parsePitSpeedLimit(undefined)).toBe(80);
    });

    it("should return 80 for empty string", () => {
      expect(parsePitSpeedLimit("")).toBe(80);
    });

    it("should return 80 for non-numeric string", () => {
      expect(parsePitSpeedLimit("unknown")).toBe(80);
    });
  });

  describe("getPitSpeedLimit", () => {
    it("should return speed from session info", () => {
      mockGetSessionInfo.mockReturnValue({
        WeekendInfo: { TrackPitSpeedLimit: "80.00 kph" },
      });

      expect(getPitSpeedLimit()).toBe(80);
    });

    it("should return 80 when session info is null", () => {
      mockGetSessionInfo.mockReturnValue(null);

      expect(getPitSpeedLimit()).toBe(80);
    });

    it("should return 80 when WeekendInfo is missing", () => {
      mockGetSessionInfo.mockReturnValue({});

      expect(getPitSpeedLimit()).toBe(80);
    });
  });

  describe("pit limiter icon functions", () => {
    it("should produce distinct active and inactive icons", () => {
      expect(pitLimiterActiveIcon(80)).not.toBe(pitLimiterInactiveIcon(80));
    });

    it("active icon should contain blue color", () => {
      expect(pitLimiterActiveIcon(80)).toContain("#3498db");
    });

    it("inactive icon should contain red border color", () => {
      expect(pitLimiterInactiveIcon(80)).toContain("#e74c3c");
    });

    it("both icons should contain the speed number", () => {
      expect(pitLimiterActiveIcon(80)).toContain("80");
      expect(pitLimiterInactiveIcon(80)).toContain("80");
    });

    it("should use the provided speed value", () => {
      expect(pitLimiterActiveIcon(60)).toContain("60");
      expect(pitLimiterInactiveIcon(100)).toContain("100");
    });
  });

  describe("generateCarControlSvg telemetry variants", () => {
    it("should use active icon when pitLimiterActive is true", () => {
      const result = generateCarControlSvg({ control: "pit-speed-limiter" }, true, 80);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#3498db");
    });

    it("should use inactive icon when pitLimiterActive is false", () => {
      const result = generateCarControlSvg({ control: "pit-speed-limiter" }, false, 80);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#e74c3c");
    });

    it("should use default (inactive) icon when pitLimiterActive is undefined", () => {
      const result = generateCarControlSvg({ control: "pit-speed-limiter" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#e74c3c");
    });

    it("should include speed limit in the icon", () => {
      const result = generateCarControlSvg({ control: "pit-speed-limiter" }, false, 60);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("60");
    });

    it("should use default speed when pitSpeedLimit is undefined", () => {
      const result = generateCarControlSvg({ control: "pit-speed-limiter" }, true);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("80");
    });

    it("should not affect other controls when pitLimiterActive is passed", () => {
      const starter = generateCarControlSvg({ control: "starter" }, true, 80);
      const starterDefault = generateCarControlSvg({ control: "starter" });

      expect(starter).toBe(starterDefault);
    });
  });

  describe("telemetry-aware lifecycle", () => {
    let action: CarControl;

    beforeEach(() => {
      action = new CarControl();
    });

    it("should subscribe with telemetry callback on onWillAppear", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "pit-speed-limiter" }) as any);

      expect(action["sdkController"].subscribe).toHaveBeenCalledWith("action-1", expect.any(Function));
    });

    it("should clean up maps on onWillDisappear", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "pit-speed-limiter" }) as any);
      await action.onWillDisappear(fakeEvent("action-1") as any);

      expect(action["sdkController"].unsubscribe).toHaveBeenCalledWith("action-1");
      expect(action["activeContexts"].has("action-1")).toBe(false);
      expect(action["lastState"].has("action-1")).toBe(false);
    });

    it("should update activeContexts on onDidReceiveSettings", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "starter" }) as any);
      await action.onDidReceiveSettings(fakeEvent("action-1", { control: "pit-speed-limiter" }) as any);

      expect(action["activeContexts"].get("action-1")).toEqual({
        control: "pit-speed-limiter",
      });
    });
  });

  describe("long-press behavior (starter)", () => {
    let action: CarControl;

    function setupKeyBinding(key: string, modifiers: string[] = [], code?: string) {
      mockGetGlobalSettings.mockReturnValue({ carControlStarter: "bound" });
      mockParseKeyBinding.mockReturnValue({ key, modifiers, code });
    }

    beforeEach(() => {
      action = new CarControl();
    });

    it("should press key on keyDown and release on keyUp", async () => {
      setupKeyBinding("s", [], "KeyS");

      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledWith({
        key: "s",
        modifiers: undefined,
        code: "KeyS",
      });
      expect(mockSendKeyCombination).not.toHaveBeenCalled();

      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledWith({
        key: "s",
        modifiers: undefined,
        code: "KeyS",
      });
    });

    it("should press key on dialDown and release on dialUp", async () => {
      setupKeyBinding("s", [], "KeyS");

      await action.onDialDown(fakeEvent("action-1", { control: "starter" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledOnce();

      await action.onDialUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledOnce();
    });

    it("should track concurrent presses on different action contexts independently", async () => {
      mockGetGlobalSettings.mockReturnValue({
        carControlStarter: "bound",
      });
      mockParseKeyBinding.mockImplementation((val: unknown) => {
        if (val === "bound") {
          return { key: "s", modifiers: [], code: "KeyS" };
        }

        return undefined;
      });

      // Press starter on action-1
      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);
      // Press starter on action-2
      await action.onKeyDown(fakeEvent("action-2", { control: "starter" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledTimes(2);

      // Release action-1 — should release action-1's combination only
      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledTimes(1);

      // Release action-2
      await action.onKeyUp(fakeEvent("action-2") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledTimes(2);
    });

    it("should release held key on onWillDisappear", async () => {
      setupKeyBinding("s", [], "KeyS");

      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);
      await action.onWillDisappear(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledOnce();
    });

    it("should not store combination when press fails", async () => {
      setupKeyBinding("s", [], "KeyS");
      mockPressKeyCombination.mockResolvedValueOnce(false);

      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledOnce();

      // Release should be a no-op since press failed
      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
    });

    it("should not call release if no key is held", async () => {
      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
    });

    it("should include modifiers in the combination when present", async () => {
      setupKeyBinding("s", ["ctrl", "shift"], "KeyS");

      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledWith({
        key: "s",
        modifiers: ["ctrl", "shift"],
        code: "KeyS",
      });
    });

    it("should not press key when no binding is configured", async () => {
      mockGetGlobalSettings.mockReturnValue({});
      mockParseKeyBinding.mockReturnValue(undefined);

      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);

      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });
  });
});
