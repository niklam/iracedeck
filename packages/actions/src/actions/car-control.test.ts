import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAR_CONTROL_GLOBAL_KEYS,
  CarControl,
  generateCarControlSvg,
  getEnterExitTowState,
  getPitSpeedLimit,
  isPitLimiterActive,
  parsePitSpeedLimit,
  pitLimiterActiveIcon,
  pitLimiterInactiveIcon,
} from "./car-control.js";

const { mockGetSessionInfo, mockTapBinding, mockHoldBinding, mockReleaseBinding } = vi.hoisted(() => ({
  mockGetSessionInfo: vi.fn((): Record<string, unknown> | null => null),
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockHoldBinding: vi.fn().mockResolvedValue(undefined),
  mockReleaseBinding: vi.fn().mockResolvedValue(undefined),
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
vi.mock("@iracedeck/icons/car-control/enter-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">enter-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/car-control/exit-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">exit-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/car-control/reset-to-pits.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">reset-to-pits {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/car-control/tow.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">tow {{mainLabel}} {{subLabel}}</svg>',
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
  getSDK: vi.fn(() => ({ sdk: { getSessionInfo: mockGetSessionInfo } })),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
    pressKeyCombination: vi.fn().mockResolvedValue(true),
    releaseKeyCombination: vi.fn().mockResolvedValue(true),
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
    return `<svg>${template}${data.iconContent || ""}${data.mainLabel || data.labelLine1 || ""}${data.subLabel || data.labelLine2 || ""}</svg>`;
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

    it("should have exactly 9 entries", () => {
      expect(Object.keys(CAR_CONTROL_GLOBAL_KEYS)).toHaveLength(9);
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
        "enter-exit-tow": { line1: "ENTER", line2: "" },
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

    beforeEach(() => {
      action = new CarControl();
    });

    it("should call tapGlobalBinding on keyDown for ignition", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "ignition" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("carControlIgnition");
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("should call tapGlobalBinding on keyDown for pit-speed-limiter", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "pit-speed-limiter" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("carControlPitSpeedLimiter");
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("should call holdBinding on keyDown for enter-exit-tow", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlEnterExitTow");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("should call tapGlobalBinding on keyDown for pause-sim", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "pause-sim" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("carControlPauseSim");
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("should call tapGlobalBinding on dialDown for non-starter controls", async () => {
      await action.onDialDown(fakeEvent("action-1", { control: "ignition" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("carControlIgnition");
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("should call tapGlobalBinding even when no key binding is configured for tap controls", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "ignition" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("carControlIgnition");
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

    it("should use default (inactive) icon when pitLimiterActive is undefined", () => {
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

    it("should not affect other controls when pitLimiterActive is passed", () => {
      const starter = generateCarControlSvg({ control: "starter" }, { pitLimiterActive: true, pitSpeedLimit: 80 });
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

  describe("long-press behavior (starter)", () => {
    let action: CarControl;

    beforeEach(() => {
      action = new CarControl();
    });

    it("should hold key on keyDown and release on keyUp", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlStarter");
      expect(mockTapBinding).not.toHaveBeenCalled();

      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should hold key on dialDown and release on dialUp", async () => {
      await action.onDialDown(fakeEvent("action-1", { control: "starter" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledOnce();

      await action.onDialUp(fakeEvent("action-1") as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should track concurrent presses on different action contexts independently", async () => {
      // Press starter on action-1
      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);
      // Press starter on action-2
      await action.onKeyDown(fakeEvent("action-2", { control: "starter" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledTimes(2);

      // Release action-1 — should release action-1's combination only
      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseBinding).toHaveBeenCalledTimes(1);
      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");

      // Release action-2
      await action.onKeyUp(fakeEvent("action-2") as any);

      expect(mockReleaseBinding).toHaveBeenCalledTimes(2);
      expect(mockReleaseBinding).toHaveBeenCalledWith("action-2");
    });

    it("should release held key on onWillDisappear", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);
      await action.onWillDisappear(fakeEvent("action-1") as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should call holdGlobalBinding on keyDown for starter", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlStarter");
    });

    it("should call releaseHeldBinding on keyUp even when no key is held", async () => {
      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should call holdGlobalBinding with correct setting key", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlStarter");
    });

    it("should call holdGlobalBinding even when no binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "starter" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlStarter");
    });
  });

  describe("getEnterExitTowState", () => {
    it("should return enter-car when telemetry is null", () => {
      expect(getEnterExitTowState(null, null)).toBe("enter-car");
    });

    it("should return enter-car when IsOnTrack is false", () => {
      expect(getEnterExitTowState({ IsOnTrack: false } as any, null)).toBe("enter-car");
    });

    it("should return enter-car when IsOnTrack is undefined", () => {
      expect(getEnterExitTowState({} as any, null)).toBe("enter-car");
    });

    it("should return exit-car when on track and in pit stall", () => {
      expect(getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: true, SessionNum: 0 } as any, null)).toBe(
        "exit-car",
      );
    });

    it("should return reset-to-pits when on track, not in pit stall, non-Race session", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [{ SessionNum: 0, SessionType: "Practice" }],
        },
      };
      expect(
        getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 } as any, sessionInfo),
      ).toBe("reset-to-pits");
    });

    it("should return tow when on track, not in pit stall, Race session", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [{ SessionNum: 0, SessionType: "Race" }],
        },
      };
      expect(
        getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 } as any, sessionInfo),
      ).toBe("tow");
    });

    it("should return reset-to-pits when session info is null", () => {
      expect(getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 } as any, null)).toBe(
        "reset-to-pits",
      );
    });

    it("should return reset-to-pits when session number does not match any session", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [{ SessionNum: 0, SessionType: "Race" }],
        },
      };
      expect(
        getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 5 } as any, sessionInfo),
      ).toBe("reset-to-pits");
    });

    it("should use correct session from multiple sessions based on SessionNum", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [
            { SessionNum: 0, SessionType: "Practice" },
            { SessionNum: 1, SessionType: "Qualifying" },
            { SessionNum: 2, SessionType: "Race" },
          ],
        },
      };
      expect(
        getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 2 } as any, sessionInfo),
      ).toBe("tow");
      expect(
        getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 } as any, sessionInfo),
      ).toBe("reset-to-pits");
    });
  });

  describe("generateCarControlSvg enter-exit-tow states", () => {
    it("should generate state-specific icon for enter-exit-tow with enter-car state", () => {
      const result = generateCarControlSvg({ control: "enter-exit-tow" }, { enterExitTowState: "enter-car" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("enter-car");
      expect(decoded).toContain("ENTER");
    });

    it("should generate state-specific icon for enter-exit-tow with exit-car state", () => {
      const result = generateCarControlSvg({ control: "enter-exit-tow" }, { enterExitTowState: "exit-car" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("exit-car");
      expect(decoded).toContain("EXIT");
    });

    it("should generate state-specific icon for enter-exit-tow with reset-to-pits state", () => {
      const result = generateCarControlSvg({ control: "enter-exit-tow" }, { enterExitTowState: "reset-to-pits" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("reset-to-pits");
      expect(decoded).toContain("RESET");
    });

    it("should generate state-specific icon for enter-exit-tow with tow state", () => {
      const result = generateCarControlSvg({ control: "enter-exit-tow" }, { enterExitTowState: "tow" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("tow");
      expect(decoded).toContain("TOW");
    });

    it("should default to enter-car when no telemetry state for enter-exit-tow", () => {
      const result = generateCarControlSvg({ control: "enter-exit-tow" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("enter-car");
      expect(decoded).toContain("ENTER");
    });

    it("should produce different icons for each enter-exit-tow state", () => {
      const states = ["enter-car", "exit-car", "reset-to-pits", "tow"] as const;
      const results = states.map((s) => generateCarControlSvg({ control: "enter-exit-tow" }, { enterExitTowState: s }));
      const unique = new Set(results);
      expect(unique.size).toBe(4);
    });
  });
});
