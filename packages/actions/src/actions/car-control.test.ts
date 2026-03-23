import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAR_CONTROL_GLOBAL_KEYS,
  CarControl,
  generateCarControlSvg,
  getPitSpeedLimit,
  isDrsActive,
  isPitLimiterActive,
  isPushToPassActive,
  parsePitSpeedLimit,
  pitLimiterActiveIcon,
  pitLimiterInactiveIcon,
  statusBarOff,
  statusBarOn,
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

vi.mock("@iracedeck/icons/car-control/starter.svg", () => ({
  default: "<svg>starter-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/ignition.svg", () => ({
  default: "<svg>ignition-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/enter-exit-tow.svg", () => ({
  default: "<svg>enter-exit-tow-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/pause-sim.svg", () => ({
  default: "<svg>pause-sim-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/headlight-flash.svg", () => ({
  default: "<svg>headlight-flash-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/tear-off-visor.svg", () => ({
  default: "<svg>tear-off-visor-icon</svg>",
}));

vi.mock("@iracedeck/iracing-sdk", () => ({
  hasFlag: (value: number, flag: number) => (value & flag) !== 0,
  EngineWarnings: { PitSpeedLimiter: 0x0010 },
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
  getGlobalSettings: mockGetGlobalSettings,
  getSDK: vi.fn(() => ({ sdk: { getSessionInfo: mockGetSessionInfo } })),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: mockSendKeyCombination,
    pressKeyCombination: mockPressKeyCombination,
    releaseKeyCombination: mockReleaseKeyCombination,
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: mockParseKeyBinding,
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
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

describe("CarControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("CAR_CONTROL_GLOBAL_KEYS", () => {
    it("should have correct mapping for all 9 controls", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["starter"]).toBe("carControlStarter");
      expect(CAR_CONTROL_GLOBAL_KEYS["ignition"]).toBe("carControlIgnition");
      expect(CAR_CONTROL_GLOBAL_KEYS["pit-speed-limiter"]).toBe("carControlPitSpeedLimiter");
      expect(CAR_CONTROL_GLOBAL_KEYS["enter-exit-tow"]).toBe("carControlEnterExitTow");
      expect(CAR_CONTROL_GLOBAL_KEYS["pause-sim"]).toBe("carControlPauseSim");
      expect(CAR_CONTROL_GLOBAL_KEYS["headlight-flash"]).toBe("carControlHeadlightFlash");
      expect(CAR_CONTROL_GLOBAL_KEYS["push-to-pass"]).toBe("carControlPushToPass");
      expect(CAR_CONTROL_GLOBAL_KEYS["drs"]).toBe("carControlDrs");
      expect(CAR_CONTROL_GLOBAL_KEYS["tear-off-visor"]).toBe("carControlTearOffVisor");
    });

    it("should have exactly 9 entries", () => {
      expect(Object.keys(CAR_CONTROL_GLOBAL_KEYS)).toHaveLength(9);
    });
  });

  describe("generateCarControlSvg", () => {
    it("should generate valid data URIs for all controls", () => {
      const controls = [
        "starter",
        "ignition",
        "pit-speed-limiter",
        "enter-exit-tow",
        "pause-sim",
        "headlight-flash",
        "push-to-pass",
        "drs",
        "tear-off-visor",
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
      const expectedLabels: Record<string, { line1: string; line2?: string }> = {
        starter: { line1: "START", line2: "ENGINE" },
        ignition: { line1: "IGNITION", line2: "ON/OFF" },
        "pit-speed-limiter": { line1: "PIT", line2: "LIMITER" },
        "enter-exit-tow": { line1: "ENTER/EXIT", line2: "TOW" },
        "pause-sim": { line1: "PAUSE", line2: "SIM" },
        "headlight-flash": { line1: "HEADLIGHT", line2: "FLASH" },
        "push-to-pass": { line1: "PUSH TO", line2: "PASS" },
        drs: { line1: "DRS" },
        "tear-off-visor": { line1: "TEAR OFF", line2: "VISOR" },
      };

      for (const [control, labels] of Object.entries(expectedLabels)) {
        const result = generateCarControlSvg({ control: control as any });
        const decoded = decodeURIComponent(result);

        expect(decoded).toContain(labels.line1);

        if (labels.line2) {
          expect(decoded).toContain(labels.line2);
        }
      }
    });
  });

  describe("tap behavior (non-hold controls)", () => {
    let action: CarControl;

    function setupKeyBinding(settingKey: string, key: string, modifiers: string[] = [], code?: string) {
      mockGetGlobalSettings.mockReturnValue({ [settingKey]: "bound" });
      mockParseKeyBinding.mockReturnValue({ key, modifiers, code });
    }

    beforeEach(() => {
      action = new CarControl();
    });

    it("should call sendKeyCombination on keyDown for ignition", async () => {
      setupKeyBinding("carControlIgnition", "i", [], "KeyI");

      await action.onKeyDown(fakeEvent("action-1", { control: "ignition" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "i",
        modifiers: undefined,
        code: "KeyI",
      });
      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should call sendKeyCombination on keyDown for pit-speed-limiter", async () => {
      setupKeyBinding("carControlPitSpeedLimiter", "a", [], "KeyA");

      await action.onKeyDown(fakeEvent("action-1", { control: "pit-speed-limiter" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should call sendKeyCombination on keyDown for enter-exit-tow", async () => {
      setupKeyBinding("carControlEnterExitTow", "r", ["shift"], "KeyR");

      await action.onKeyDown(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledWith({
        key: "r",
        modifiers: ["shift"],
        code: "KeyR",
      });
    });

    it("should call sendKeyCombination on keyDown for pause-sim", async () => {
      setupKeyBinding("carControlPauseSim", "p", ["shift"], "KeyP");

      await action.onKeyDown(fakeEvent("action-1", { control: "pause-sim" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should call sendKeyCombination on keyDown for push-to-pass", async () => {
      setupKeyBinding("carControlPushToPass", "p", [], "KeyP");

      await action.onKeyDown(fakeEvent("action-1", { control: "push-to-pass" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should call sendKeyCombination on keyDown for drs", async () => {
      setupKeyBinding("carControlDrs", "d", [], "KeyD");

      await action.onKeyDown(fakeEvent("action-1", { control: "drs" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should call sendKeyCombination on keyDown for tear-off-visor", async () => {
      setupKeyBinding("carControlTearOffVisor", "v", [], "KeyV");

      await action.onKeyDown(fakeEvent("action-1", { control: "tear-off-visor" }) as any);

      expect(mockSendKeyCombination).toHaveBeenCalledOnce();
      expect(mockPressKeyCombination).not.toHaveBeenCalled();
    });

    it("should call sendKeyCombination on dialDown for non-hold controls", async () => {
      setupKeyBinding("carControlIgnition", "i", [], "KeyI");

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

  describe("isPushToPassActive", () => {
    it("should return false when telemetry is null", () => {
      expect(isPushToPassActive(null)).toBe(false);
    });

    it("should return false when P2P_Status is undefined", () => {
      expect(isPushToPassActive({} as any)).toBe(false);
    });

    it("should return false when P2P_Status is false", () => {
      expect(isPushToPassActive({ P2P_Status: false } as any)).toBe(false);
    });

    it("should return true when P2P_Status is true", () => {
      expect(isPushToPassActive({ P2P_Status: true } as any)).toBe(true);
    });
  });

  describe("isDrsActive", () => {
    it("should return false when telemetry is null", () => {
      expect(isDrsActive(null)).toBe(false);
    });

    it("should return false when DRS_Status is undefined", () => {
      expect(isDrsActive({} as any)).toBe(false);
    });

    it("should return false when DRS_Status is 0", () => {
      expect(isDrsActive({ DRS_Status: 0 } as any)).toBe(false);
    });

    it("should return true when DRS_Status is > 0", () => {
      expect(isDrsActive({ DRS_Status: 1 } as any)).toBe(true);
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

  describe("status bar icon functions", () => {
    it("should produce distinct ON and OFF icons", () => {
      expect(statusBarOn()).not.toBe(statusBarOff());
    });

    it("ON icon should contain green color", () => {
      expect(statusBarOn()).toContain("#2ecc71");
    });

    it("OFF icon should contain red color", () => {
      expect(statusBarOff()).toContain("#e74c3c");
    });

    it("ON icon should contain 'ON' text", () => {
      expect(statusBarOn()).toContain("ON");
    });

    it("OFF icon should contain 'OFF' text", () => {
      expect(statusBarOff()).toContain("OFF");
    });
  });

  describe("generateCarControlSvg telemetry variants", () => {
    it("should use active icon when pitLimiterActive is true", () => {
      const result = generateCarControlSvg(
        { control: "pit-speed-limiter" },
        { pitLimiterActive: true, pitSpeedLimit: 80 },
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#3498db");
    });

    it("should use inactive icon when pitLimiterActive is false", () => {
      const result = generateCarControlSvg(
        { control: "pit-speed-limiter" },
        { pitLimiterActive: false, pitSpeedLimit: 80 },
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#e74c3c");
    });

    it("should use default (inactive) icon when no telemetry state provided", () => {
      const result = generateCarControlSvg({ control: "pit-speed-limiter" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#e74c3c");
    });

    it("should include speed limit in the icon", () => {
      const result = generateCarControlSvg(
        { control: "pit-speed-limiter" },
        { pitLimiterActive: false, pitSpeedLimit: 60 },
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("60");
    });

    it("should use default speed when pitSpeedLimit is undefined", () => {
      const result = generateCarControlSvg({ control: "pit-speed-limiter" }, { pitLimiterActive: true });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("80");
    });

    it("should show ON status bar when push-to-pass is active", () => {
      const result = generateCarControlSvg({ control: "push-to-pass" }, { pushToPassActive: true });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#2ecc71");
      expect(decoded).toContain("ON");
    });

    it("should show OFF status bar when push-to-pass is inactive", () => {
      const result = generateCarControlSvg({ control: "push-to-pass" }, { pushToPassActive: false });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("OFF");
    });

    it("should show ON status bar when DRS is active", () => {
      const result = generateCarControlSvg({ control: "drs" }, { drsActive: true });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("#2ecc71");
      expect(decoded).toContain("ON");
    });

    it("should show OFF status bar when DRS is inactive", () => {
      const result = generateCarControlSvg({ control: "drs" }, { drsActive: false });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("OFF");
    });

    it("should not affect static controls when telemetry state is passed", () => {
      const starter = generateCarControlSvg({ control: "starter" }, { pitLimiterActive: true });
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

      expect(action["activeContexts"].get("action-1")).toMatchObject({
        control: "pit-speed-limiter",
      });
    });
  });

  describe("long-press behavior (hold controls)", () => {
    let action: CarControl;

    function setupKeyBinding(settingKey: string, key: string, modifiers: string[] = [], code?: string) {
      mockGetGlobalSettings.mockReturnValue({ [settingKey]: "bound" });
      mockParseKeyBinding.mockReturnValue({ key, modifiers, code });
    }

    beforeEach(() => {
      action = new CarControl();
    });

    it("should press key on keyDown and release on keyUp for starter", async () => {
      setupKeyBinding("carControlStarter", "s", [], "KeyS");

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

    it("should use hold pattern for headlight-flash", async () => {
      setupKeyBinding("carControlHeadlightFlash", "h", [], "KeyH");

      await action.onKeyDown(fakeEvent("action-1", { control: "headlight-flash" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledWith({
        key: "h",
        modifiers: undefined,
        code: "KeyH",
      });
      expect(mockSendKeyCombination).not.toHaveBeenCalled();

      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledOnce();
    });

    it("should press key on dialDown and release on dialUp", async () => {
      setupKeyBinding("carControlStarter", "s", [], "KeyS");

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

      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);
      await action.onKeyDown(fakeEvent("action-2", { control: "starter" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledTimes(2);

      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledTimes(1);

      await action.onKeyUp(fakeEvent("action-2") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledTimes(2);
    });

    it("should release held key on onWillDisappear", async () => {
      setupKeyBinding("carControlStarter", "s", [], "KeyS");

      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);
      await action.onWillDisappear(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledOnce();
    });

    it("should not store combination when press fails", async () => {
      setupKeyBinding("carControlStarter", "s", [], "KeyS");
      mockPressKeyCombination.mockResolvedValueOnce(false);

      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledOnce();

      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
    });

    it("should not call release if no key is held", async () => {
      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
    });

    it("should include modifiers in the combination when present", async () => {
      setupKeyBinding("carControlStarter", "s", ["ctrl", "shift"], "KeyS");

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
