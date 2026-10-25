import { assembleIcon } from "@iracedeck/deck-core";
import tearOffVisorIcon from "@iracedeck/icons/car-control/tear-off-visor.svg";
import wipersAndVisorIcon from "@iracedeck/icons/car-control/wipers-and-visor.svg";
import toggleWipersIcon from "@iracedeck/icons/cockpit-misc/toggle-wipers.svg";
import triggerWipersIcon from "@iracedeck/icons/cockpit-misc/trigger-wipers.svg";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { getGlobalSettings } from "@iracedeck/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ignitionTemplate from "../../../icons/car-control-ignition.svg";
import starterTemplate from "../../../icons/car-control-starter.svg";
import {
  CAR_CONTROL_GLOBAL_KEYS,
  CarControl,
  CarControlSettings,
  generateCarControlSvg,
  getEnterExitTowState,
  getPitSpeedLimit,
  getSessionContext,
  hasEngineCaught,
  ignitionArtwork,
  ignitionToggleState,
  isDrsActive,
  isEngineRunning,
  isIgnitionOn,
  isPitLimiterActive,
  isPitLimiterAvailable,
  isPushToPassActive,
  parsePitSpeedLimit,
  pitLimiterSpeedGraphic,
  pitLimiterToggleState,
  STARTER_CHUK_MS,
  STARTER_CRANK_FRAMES_MS,
  starterArtwork,
  starterToggleState,
} from "./car-control.js";

const {
  mockGetSessionInfo,
  mockTapBinding,
  mockHoldBinding,
  mockReleaseBinding,
  mockPressKeyCombination,
  mockReleaseKeyCombination,
} = vi.hoisted(() => ({
  mockGetSessionInfo: vi.fn((): Record<string, unknown> | null => null),
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockHoldBinding: vi.fn().mockResolvedValue(undefined),
  mockReleaseBinding: vi.fn().mockResolvedValue(undefined),
  mockPressKeyCombination: vi.fn().mockResolvedValue(true),
  mockReleaseKeyCombination: vi.fn().mockResolvedValue(true),
}));

vi.mock("@iracedeck/icons/car-control/starter.svg", () => ({
  default: "<svg>starter-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/ignition.svg", () => ({
  default: "<svg>ignition-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/escape.svg", () => ({
  default: "<svg>escape-icon</svg>",
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
vi.mock("@iracedeck/icons/car-control/session-qualify.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">session-qualify</svg>',
}));
vi.mock("@iracedeck/icons/car-control/session-grid.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">session-grid</svg>',
}));
vi.mock("@iracedeck/icons/car-control/session-race.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">session-race</svg>',
}));
vi.mock("@iracedeck/icons/car-control/handbrake.svg", () => ({
  default: "<svg>handbrake-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/second-clutch.svg", () => ({
  default: "<svg>second-clutch-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/second-up-shift.svg", () => ({
  default: "<svg>second-up-shift-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/second-down-shift.svg", () => ({
  default: "<svg>second-down-shift-icon</svg>",
}));

vi.mock("@iracedeck/iracing-sdk", () => ({
  hasFlag: (value: number, flag: number) => (value & flag) !== 0,
  hasPitLimiter: (t: { dcPitSpeedLimiterToggle?: unknown } | null) => t?.dcPitSpeedLimiterToggle !== undefined,
  hasVisor: (t: { dcTearOffVisor?: unknown } | null) => t?.dcTearOffVisor !== undefined,
  hasWipers: (t: { dcToggleWindshieldWipers?: unknown; dcTriggerWindshieldWipers?: unknown } | null) =>
    t?.dcToggleWindshieldWipers !== undefined || t?.dcTriggerWindshieldWipers !== undefined,
  isLiveOnTrack: (t: { IsOnTrack?: unknown; IsReplayPlaying?: unknown } | null | undefined) =>
    t?.IsOnTrack === true && t?.IsReplayPlaying !== true,
  EngineWarnings: { PitSpeedLimiter: 0x0010, EngineStalled: 0x0008 },
  SessionState: { Invalid: 0, GetInCar: 1, Warmup: 2, ParadeLaps: 3, Racing: 4, Checkered: 5, CoolDown: 6 },
}));

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getSDK: vi.fn(() => ({ sdk: { getSessionInfo: mockGetSessionInfo } })),
}));

vi.mock("@iracedeck/deck-core", async () => ({
  // The real tap/long-press tracker, so Wipers and Visor's press classification runs against
  // the live `dualPressThresholdMs` read from the mocked global settings (#1463).
  DualPressTracker: (await import("../../../../deck-core/src/dual-press.js")).DualPressTracker,
  hexToGrayscale: vi.fn((hex: string) => `grey(${hex})`),
  IconUpdateThrottle: class {
    schedule(_id: string, render: () => unknown): void {
      try {
        void Promise.resolve(render()).catch(() => {});
      } catch {
        // Swallow sync throws — matches the production render contract.
      }
    }
    clear(): void {}
    clearAll(): void {}
  },
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
  applyBindingWarning: vi.fn((content: string) => content),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
    pressKeyCombination: mockPressKeyCombination,
    releaseKeyCombination: mockReleaseKeyCombination,
  })),
  LogLevel: { Info: 2 },
  parseBinding: vi.fn(),
  parseKeyBinding: vi.fn(),
  isSimHubInitialized: vi.fn(() => false),
  getSimHub: vi.fn(() => ({
    startRole: vi.fn().mockResolvedValue(true),
    stopRole: vi.fn().mockResolvedValue(true),
  })),
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
  assembleIcon: vi.fn(
    ({
      graphicSvg,
      colors,
      title,
    }: {
      graphicSvg: string;
      colors: Record<string, string>;
      title: { titleText: string };
    }) => {
      const bg = colors?.backgroundColor ? ` bg="${colors.backgroundColor}"` : "";
      const encoded = encodeURIComponent(`<svg${bg}>${graphicSvg}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
  generateTitleText: vi.fn((opts: { text: string }) => `<text>${opts.text}</text>`),
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    return `<svg>${template}${data.iconContent || ""}${data.titleContent || ""}${data.mainLabel || ""}${data.subLabel || ""}</svg>`;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

vi.mock("@iracedeck/settings", () => ({
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  isSimHubBinding: vi.fn(
    (v: unknown) => v !== null && typeof v === "object" && (v as Record<string, unknown>).type === "simhub",
  ),
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

    it("should have empty string mapping for escape (no global binding)", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["escape"]).toBe("");
    });

    it("should have correct mapping for headlight-flash", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["headlight-flash"]).toBe("carControlHeadlightFlash");
    });

    it("should have correct mapping for push-to-pass", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["push-to-pass"]).toBe("carControlPushToPass");
    });

    it("should have correct mapping for drs", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["drs"]).toBe("carControlDrs");
    });

    it("should have correct mapping for tear-off-visor", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["tear-off-visor"]).toBe("carControlTearOffVisor");
    });

    it("should have correct mapping for handbrake", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["handbrake"]).toBe("carControlHandbrake");
    });

    it("should have correct mapping for second-clutch", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["second-clutch"]).toBe("carControlSecondClutch");
    });

    it("should have correct mapping for second-up-shift", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["second-up-shift"]).toBe("carControlSecondUpShift");
    });

    it("should have correct mapping for second-down-shift", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["second-down-shift"]).toBe("carControlSecondDownShift");
    });

    it("should have an empty mapping for wipers-and-visor (resolved per car, #1463)", () => {
      expect(CAR_CONTROL_GLOBAL_KEYS["wipers-and-visor"]).toBe("");
    });

    it("should have exactly 15 entries", () => {
      expect(Object.keys(CAR_CONTROL_GLOBAL_KEYS)).toHaveLength(15);
    });
  });

  describe("generateCarControlSvg", () => {
    it("should generate a valid data URI for starter", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "starter" }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for ignition", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "ignition" }));

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
        const result = generateCarControlSvg(CarControlSettings.parse({ control }));
        expect(result).toContain("data:image/svg+xml");
      }
    });

    it("should produce different icons for different controls", () => {
      const starter = generateCarControlSvg(CarControlSettings.parse({ control: "starter" }));
      const ignition = generateCarControlSvg(CarControlSettings.parse({ control: "ignition" }));

      expect(starter).not.toBe(ignition);
    });

    it("should include correct labels for all controls", () => {
      const expectedLabels: Record<string, { line1: string; line2: string }> = {
        starter: { line1: "START", line2: "ENGINE" },
        // Single line since #561 — the status bar reads ON / OFF, so the label no longer does.
        ignition: { line1: "IGNITION", line2: "" },
        "pit-speed-limiter": { line1: "PIT", line2: "LIMITER" },
        "enter-exit-tow": { line1: "DRIVE", line2: "" },
        "pause-sim": { line1: "PAUSE", line2: "SIM" },
      };

      for (const [control, labels] of Object.entries(expectedLabels)) {
        const result = generateCarControlSvg(CarControlSettings.parse({ control: control }));
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

  describe("wipers and visor (issue #1463)", () => {
    const VISOR_FRAME = { IsOnTrack: true, IsReplayPlaying: false, dcTearOffVisor: false } as TelemetryData;
    const WIPER_FRAME = {
      IsOnTrack: true,
      IsReplayPlaying: false,
      dcTriggerWindshieldWipers: false,
      dcToggleWindshieldWipers: false,
    } as TelemetryData;
    const TRIGGER_ONLY_FRAME = {
      IsOnTrack: true,
      IsReplayPlaying: false,
      dcTriggerWindshieldWipers: false,
    } as TelemetryData;
    const TOGGLE_ONLY_FRAME = {
      IsOnTrack: true,
      IsReplayPlaying: false,
      dcToggleWindshieldWipers: true,
    } as TelemetryData;
    const NEITHER_FRAME = { IsOnTrack: true, IsReplayPlaying: false } as TelemetryData;
    const REPLAY_FRAME = { ...WIPER_FRAME, IsReplayPlaying: true } as TelemetryData;

    const TRIGGER = "cockpitMiscTriggerWipers";
    const TOGGLE = "cockpitMiscToggleWipers";
    const VISOR = "carControlTearOffVisor";

    let action: CarControl;

    beforeEach(() => {
      // Fake timers BEFORE the action is built: the tracker captures Date.now at construction.
      vi.useFakeTimers();
      vi.mocked(getGlobalSettings).mockReturnValue({});
      action = new CarControl();
    });

    afterEach(() => {
      vi.mocked(getGlobalSettings).mockReturnValue({});
      vi.useRealTimers();
    });

    function setTelemetry(frame: TelemetryData | null): void {
      vi.mocked(action["sdkController"].getCurrentTelemetry).mockReturnValue(frame);
    }

    /** Press, hold for `holdMs`, release. */
    async function press(settings: Record<string, unknown>, holdMs: number): Promise<void> {
      await action.onKeyDown(fakeEvent("action-1", { control: "wipers-and-visor", ...settings }) as any);
      vi.advanceTimersByTime(holdMs);
      await action.onKeyUp(fakeEvent("action-1", { control: "wipers-and-visor", ...settings }) as any);
    }

    function lastAssembleArgs(): { graphicSvg: string; title: { titleText: string }; [k: string]: unknown } {
      const calls = vi.mocked(assembleIcon).mock.calls;

      return calls[calls.length - 1][0] as never;
    }

    describe("visor car", () => {
      it("taps the visor binding on key-down, at once", async () => {
        setTelemetry(VISOR_FRAME);
        await action.onKeyDown(fakeEvent("action-1", { control: "wipers-and-visor" }) as any);

        expect(mockTapBinding).toHaveBeenCalledTimes(1);
        expect(mockTapBinding).toHaveBeenCalledWith(VISOR);
      });

      it("sends nothing on key-up, however long the key was held", async () => {
        setTelemetry(VISOR_FRAME);
        await press({}, 100);
        await press({}, 5000);

        expect(mockTapBinding).toHaveBeenCalledTimes(2);
        expect(mockTapBinding.mock.calls.every(([key]) => key === VISOR)).toBe(true);
        expect(mockHoldBinding).not.toHaveBeenCalled();
      });

      it("tears off whatever Wipers on tap says", async () => {
        setTelemetry(VISOR_FRAME);
        await press({ wipersOnTap: "toggle" }, 100);

        expect(mockTapBinding).toHaveBeenCalledWith(VISOR);
      });
    });

    describe("wiper car", () => {
      it("sends nothing on key-down", async () => {
        setTelemetry(WIPER_FRAME);
        await action.onKeyDown(fakeEvent("action-1", { control: "wipers-and-visor" }) as any);

        expect(mockTapBinding).not.toHaveBeenCalled();
      });

      it("triggers on a release under the threshold, by default", async () => {
        setTelemetry(WIPER_FRAME);
        await press({}, 499);

        expect(mockTapBinding).toHaveBeenCalledTimes(1);
        expect(mockTapBinding).toHaveBeenCalledWith(TRIGGER);
      });

      it("toggles on a release at or over the threshold, by default", async () => {
        setTelemetry(WIPER_FRAME);
        await press({}, 500);
        await press({}, 2000);

        expect(mockTapBinding.mock.calls).toEqual([[TOGGLE], [TOGGLE]]);
      });

      it("swaps the two when Wipers on tap is Toggle", async () => {
        setTelemetry(WIPER_FRAME);
        await press({ wipersOnTap: "toggle" }, 100);
        await press({ wipersOnTap: "toggle" }, 800);

        expect(mockTapBinding.mock.calls).toEqual([[TOGGLE], [TRIGGER]]);
      });

      it("reads a key stored without Wipers on tap as Trigger", async () => {
        setTelemetry(WIPER_FRAME);
        await press({}, 100);

        expect(mockTapBinding).toHaveBeenCalledWith(TRIGGER);
      });

      it("reads the threshold live from global settings on each press", async () => {
        setTelemetry(WIPER_FRAME);
        vi.mocked(getGlobalSettings).mockReturnValue({ dualPressThresholdMs: 1000 });
        await press({}, 600);
        vi.mocked(getGlobalSettings).mockReturnValue({ dualPressThresholdMs: 300 });
        await press({}, 400);

        expect(mockTapBinding.mock.calls).toEqual([[TRIGGER], [TOGGLE]]);
      });

      it("sends the one wiper binding for both presses on a car with only one wiper variable", async () => {
        setTelemetry(TRIGGER_ONLY_FRAME);
        await press({}, 100);
        await press({}, 800);
        setTelemetry(TOGGLE_ONLY_FRAME);
        await press({ wipersOnTap: "toggle" }, 100);
        await press({ wipersOnTap: "toggle" }, 800);

        expect(mockTapBinding.mock.calls).toEqual([[TRIGGER], [TRIGGER], [TOGGLE], [TOGGLE]]);
      });

      it("sends nothing on a stray release with no key-down", async () => {
        setTelemetry(WIPER_FRAME);
        await action.onKeyUp(fakeEvent("action-1", { control: "wipers-and-visor" }) as any);

        expect(mockTapBinding).not.toHaveBeenCalled();
      });

      it("drops a press still held when the key disappears", async () => {
        setTelemetry(WIPER_FRAME);
        await action.onKeyDown(fakeEvent("action-1", { control: "wipers-and-visor" }) as any);
        await action.onWillDisappear(fakeEvent("action-1", { control: "wipers-and-visor" }) as any);
        await action.onKeyUp(fakeEvent("action-1", { control: "wipers-and-visor" }) as any);

        expect(mockTapBinding).not.toHaveBeenCalled();
      });
    });

    describe("unknown car or neither", () => {
      it.each([
        ["no telemetry", null],
        ["a replay frame (the watched car)", REPLAY_FRAME],
        ["off track", { ...VISOR_FRAME, IsOnTrack: false } as TelemetryData],
        ["a car with neither", NEITHER_FRAME],
      ])("sends nothing on press or release with %s", async (_label, frame) => {
        setTelemetry(frame);
        await press({}, 100);
        await press({}, 2000);

        expect(mockTapBinding).not.toHaveBeenCalled();
        expect(mockHoldBinding).not.toHaveBeenCalled();
        expect(action["logger"].debug).toHaveBeenCalledWith(expect.stringContaining("press ignored"));
      });
    });

    describe("icon and title", () => {
      const settings = (wipersOnTap?: "trigger" | "toggle") =>
        ({ control: "wipers-and-visor", ...(wipersOnTap ? { wipersOnTap } : {}) }) as unknown as CarControlSettings;

      it("shows the Tear Off Visor art on a visor car", () => {
        generateCarControlSvg(settings(), { wipersAndVisorCar: { kind: "visor" } });

        expect(lastAssembleArgs().graphicSvg).toBe(tearOffVisorIcon);
        expect(lastAssembleArgs().title.titleText).toBe("VISOR\nTEAR OFF");
        expect(lastAssembleArgs().dimmed).toBeUndefined();
      });

      it("shows the Trigger Wipers art on a wiper car, and Toggle Wipers when swapped", () => {
        const car = { kind: "wipers" as const, trigger: true, toggle: true };
        generateCarControlSvg(settings(), { wipersAndVisorCar: car });
        expect(lastAssembleArgs().graphicSvg).toBe(triggerWipersIcon);
        expect(lastAssembleArgs().title.titleText).toBe("TRIGGER\nWIPERS");

        generateCarControlSvg(settings("toggle"), { wipersAndVisorCar: car });
        expect(lastAssembleArgs().graphicSvg).toBe(toggleWipersIcon);
        expect(lastAssembleArgs().title.titleText).toBe("TOGGLE\nWIPERS");
      });

      it("shows the combined icon, not greyed, for an unknown car", () => {
        generateCarControlSvg(settings(), { wipersAndVisorCar: { kind: "unknown" } });
        expect(lastAssembleArgs().graphicSvg).toBe(wipersAndVisorIcon);
        expect(lastAssembleArgs().title.titleText).toBe("WIPERS\nVISOR");
        expect(lastAssembleArgs().dimmed).toBeUndefined();

        generateCarControlSvg(settings(), {});
        expect(lastAssembleArgs().graphicSvg).toBe(wipersAndVisorIcon);
      });

      it("shows the combined icon in the unavailable look for a car with neither", () => {
        generateCarControlSvg(settings(), { wipersAndVisorCar: { kind: "neither" } });
        const args = lastAssembleArgs();

        expect(args.graphicSvg).toBe(wipersAndVisorIcon);
        expect(args.title.titleText).toBe("WIPERS\nVISOR");
        expect(args.dimmed).toBe(true);
        expect((args.border as { borderColor: string }).borderColor).toBe("grey(#00aaff)");
      });

      it("passes the binding-missing flag through", () => {
        generateCarControlSvg(settings(), { wipersAndVisorCar: { kind: "visor" } }, true);

        expect(lastAssembleArgs().bindingMissing).toBe(true);
      });
    });

    describe("re-render on telemetry", () => {
      async function appearAndGetTick(settingsExtra: Record<string, unknown> = {}) {
        setTelemetry(null);
        await action.onWillAppear(fakeEvent("action-1", { control: "wipers-and-visor", ...settingsExtra }) as any);
        const tick = vi.mocked(action["sdkController"].subscribe).mock.calls[0][1] as (t: TelemetryData | null) => void;

        return async (frame: TelemetryData | null) => {
          setTelemetry(frame);
          tick(frame);
          await vi.runAllTimersAsync();
        };
      }

      it("redraws when the car kind changes, and not when it stays the same", async () => {
        const tick = await appearAndGetTick();
        const updates = () => vi.mocked(action["updateKeyImage"]).mock.calls.length;

        await tick(null);
        expect(updates()).toBe(0);

        await tick(VISOR_FRAME);
        expect(updates()).toBe(1);

        await tick({ ...VISOR_FRAME, Speed: 42 } as TelemetryData);
        expect(updates()).toBe(1);

        await tick(WIPER_FRAME);
        expect(updates()).toBe(2);

        await tick({ ...WIPER_FRAME, dcToggleWindshieldWipers: true } as TelemetryData);
        expect(updates()).toBe(2);

        await tick(REPLAY_FRAME);
        expect(updates()).toBe(3);
        expect(lastAssembleArgs().graphicSvg).toBe(wipersAndVisorIcon);
      });

      it("keys the render on the swap as well as the kind", () => {
        const car = { kind: "wipers" as const, trigger: true, toggle: true };
        const trigger = action["buildStateKey"]({ control: "wipers-and-visor" } as any, { wipersAndVisorCar: car });
        const toggle = action["buildStateKey"]({ control: "wipers-and-visor", wipersOnTap: "toggle" } as any, {
          wipersAndVisorCar: car,
        });
        const visorKey = action["buildStateKey"]({ control: "wipers-and-visor" } as any, {
          wipersAndVisorCar: { kind: "visor" },
        });

        expect(new Set([trigger, toggle, visorKey]).size).toBe(3);
      });
    });

    describe("missing-binding warning", () => {
      beforeEach(() => {
        // A visor-only user: the visor is bound, neither wiper binding is.
        vi.mocked(action["isBindingMissing"]).mockImplementation(
          (key: string | readonly string[] | null | undefined) => key === TRIGGER || key === TOGGLE,
        );
      });

      it("shows none on a visor car when only the wiper bindings are unbound", async () => {
        setTelemetry(VISOR_FRAME);
        await action.onWillAppear(fakeEvent("action-1", { control: "wipers-and-visor" }) as any);

        expect(lastAssembleArgs().bindingMissing).toBe(false);
        expect(action["setActiveBinding"]).toHaveBeenCalledWith(VISOR);
      });

      it("shows it on a wiper car whose tap binding is unbound", async () => {
        setTelemetry(WIPER_FRAME);
        await action.onWillAppear(fakeEvent("action-1", { control: "wipers-and-visor" }) as any);

        expect(lastAssembleArgs().bindingMissing).toBe(true);
        expect(action["setActiveBinding"]).toHaveBeenCalledWith(TRIGGER);
      });

      it("checks the binding the tap sends when Wipers on tap is Toggle", async () => {
        vi.mocked(action["isBindingMissing"]).mockImplementation(
          (key: string | readonly string[] | null | undefined) => key === TRIGGER,
        );
        setTelemetry(WIPER_FRAME);
        await action.onWillAppear(fakeEvent("action-1", { control: "wipers-and-visor", wipersOnTap: "toggle" }) as any);

        expect(lastAssembleArgs().bindingMissing).toBe(false);
        expect(action["setActiveBinding"]).toHaveBeenCalledWith(TOGGLE);
      });

      it("shows none, and tracks no binding, for an unknown car or one with neither", async () => {
        vi.mocked(action["isBindingMissing"]).mockImplementation(
          (key: string | readonly string[] | null | undefined) => typeof key === "string" && key.length > 0,
        );

        for (const frame of [null, NEITHER_FRAME]) {
          setTelemetry(frame);
          await action.onWillAppear(fakeEvent("action-1", { control: "wipers-and-visor" }) as any);
          expect(lastAssembleArgs().bindingMissing).toBe(false);
        }

        expect(action["setActiveBinding"]).not.toHaveBeenCalled();
      });
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

  describe("isPitLimiterAvailable (issue #638)", () => {
    it("should default to available when telemetry is null (no premature grey-out)", () => {
      expect(isPitLimiterAvailable(null)).toBe(true);
    });

    it("should return false when the car has no pit limiter (dcPitSpeedLimiterToggle absent)", () => {
      expect(isPitLimiterAvailable({} as any)).toBe(false);
    });

    it("should return true when the car has a pit limiter (dcPitSpeedLimiterToggle present)", () => {
      expect(isPitLimiterAvailable({ dcPitSpeedLimiterToggle: false } as any)).toBe(true);
      expect(isPitLimiterAvailable({ dcPitSpeedLimiterToggle: true } as any)).toBe(true);
    });
  });

  describe("pitLimiterToggleState (issue #638)", () => {
    it("should return na when unavailable, regardless of the active flag", () => {
      expect(pitLimiterToggleState(false, false)).toBe("na");
      expect(pitLimiterToggleState(false, true)).toBe("na");
    });

    it("should return on/off by the active flag when available", () => {
      expect(pitLimiterToggleState(true, true)).toBe("on");
      expect(pitLimiterToggleState(true, false)).toBe("off");
    });
  });

  describe("isIgnitionOn (issue #561)", () => {
    it("should return undefined when telemetry is null", () => {
      expect(isIgnitionOn(null)).toBeUndefined();
    });

    it("should return undefined when Voltage is absent, rather than reporting off", () => {
      expect(isIgnitionOn({} as any)).toBeUndefined();
    });

    it("should return undefined for a non-finite Voltage", () => {
      expect(isIgnitionOn({ Voltage: Number.NaN } as any)).toBeUndefined();
    });

    it("should report off near zero volts and on at a live bus voltage", () => {
      expect(isIgnitionOn({ Voltage: 0 } as any)).toBe(false);
      expect(isIgnitionOn({ Voltage: 0.4 } as any)).toBe(false);
      // 13.4 V is the live-ignition reading the detection rule is built on.
      expect(isIgnitionOn({ Voltage: 13.4 } as any)).toBe(true);
      // Every captured snapshot sat in 12-14.8 V; all of them must read "on".
      expect(isIgnitionOn({ Voltage: 12 } as any)).toBe(true);
      expect(isIgnitionOn({ Voltage: 14.8 } as any)).toBe(true);
    });
  });

  describe("isEngineRunning (issue #561)", () => {
    it("should return undefined when telemetry is null", () => {
      expect(isEngineRunning(null)).toBeUndefined();
    });

    it("should return undefined when neither EngineWarnings nor RPM is available", () => {
      expect(isEngineRunning({} as any)).toBeUndefined();
    });

    it("should read the EngineStalled bit when EngineWarnings is present", () => {
      expect(isEngineRunning({ EngineWarnings: 0x0008 } as any)).toBe(false);
      expect(isEngineRunning({ EngineWarnings: 0 } as any)).toBe(true);
    });

    it("should ignore unrelated EngineWarnings bits", () => {
      // 0x0100 is OptRepNeeded — a damage flag, nothing to do with the engine turning.
      expect(isEngineRunning({ EngineWarnings: 0x0100 } as any)).toBe(true);
    });

    it("should let the EngineStalled bit win over RPM when both are present", () => {
      // The bit is authoritative; a stale or odd RPM must not override it.
      expect(isEngineRunning({ EngineWarnings: 0x0008, RPM: 6000 } as any)).toBe(false);
      expect(isEngineRunning({ EngineWarnings: 0, RPM: 0 } as any)).toBe(true);
    });

    it("should fall back to the RPM floor only when EngineWarnings is absent", () => {
      // Captured telemetry puts a stopped engine at 300 RPM and idle near 900.
      expect(isEngineRunning({ RPM: 300 } as any)).toBe(false);
      expect(isEngineRunning({ RPM: 900 } as any)).toBe(true);
    });
  });

  describe("ignitionToggleState / starterToggleState (issue #561)", () => {
    /** A driver genuinely sitting in their own car on track. */
    const live = (extra: Record<string, unknown>) => ({ IsOnTrack: true, ...extra }) as any;

    it("should resolve na when there is no telemetry at all, never off", () => {
      expect(ignitionToggleState(null)).toBe("na");
      expect(starterToggleState(null)).toBe("na");
    });

    it("should resolve na when the driver is not live in the car", () => {
      // Out of the car: the fields may still be present but they describe nothing the
      // user is sitting in.
      expect(ignitionToggleState({ IsOnTrack: false, Voltage: 13.4 } as any)).toBe("na");
      expect(starterToggleState({ IsOnTrack: false, EngineWarnings: 0 } as any)).toBe("na");
    });

    it("should resolve na during a replay even though the frame looks complete", () => {
      // Captured replay frames report RPM 300 with the stalled bit CLEAR, which would
      // otherwise read as a confident "engine running".
      const replay = { IsOnTrack: true, IsReplayPlaying: true, EngineWarnings: 0, RPM: 300, Voltage: 13.4 };

      expect(starterToggleState(replay as any)).toBe("na");
      expect(ignitionToggleState(replay as any)).toBe("na");
    });

    it("should map ignition on and off from the bus voltage", () => {
      expect(ignitionToggleState(live({ Voltage: 13.4 }))).toBe("on");
      expect(ignitionToggleState(live({ Voltage: 0 }))).toBe("off");
    });

    it("should resolve na when live in the car but the field is missing", () => {
      expect(ignitionToggleState(live({}))).toBe("na");
      expect(starterToggleState(live({}))).toBe("na");
    });

    it("should map the starter key to engine-running state", () => {
      expect(starterToggleState(live({ EngineWarnings: 0 }))).toBe("on");
      expect(starterToggleState(live({ EngineWarnings: 0x0008 }))).toBe("off");
    });
  });

  describe("ignition and starter tri-state icons (issue #561)", () => {
    it("should render a different icon for each of the three states", () => {
      for (const control of ["ignition", "starter"] as const) {
        const key = control === "ignition" ? "ignitionState" : "starterState";
        const on = generateCarControlSvg(CarControlSettings.parse({ control }), { [key]: "on" });
        const off = generateCarControlSvg(CarControlSettings.parse({ control }), { [key]: "off" });
        const na = generateCarControlSvg(CarControlSettings.parse({ control }), { [key]: "na" });

        expect(new Set([on, off, na]).size).toBe(3);
      }
    });

    it("should fall back to the na icon when no telemetry state was resolved", () => {
      const bare = generateCarControlSvg(CarControlSettings.parse({ control: "ignition" }));
      const na = generateCarControlSvg(CarControlSettings.parse({ control: "ignition" }), {
        ignitionState: "na",
      });

      expect(bare).toBe(na);
    });
  });

  describe("ignition and starter artwork (issue #561)", () => {
    /** The shared status palette: green on, red off, grey N/A. */
    const STATE_COLORS = { on: "#2ecc71", off: "#e74c3c", na: "#888888" } as const;

    it("should colour the ignition glyph by state, so the state reads from the artwork", () => {
      for (const [state, color] of Object.entries(STATE_COLORS)) {
        expect(ignitionArtwork(state as any, true)).toContain(color);
      }
    });

    it("should give the ignition glyph a different colour in every state", () => {
      const rendered = (["on", "off", "na"] as const).map((s) => ignitionArtwork(s, true));

      expect(new Set(rendered).size).toBe(3);
    });

    it("should grow the ignition glyph into the band a hidden title frees up", () => {
      // Regression (found on hardware): the glyph had ONE fixed size, so hiding the title
      // left it small under an empty strip while the Starter badge beside it resized
      // correctly. Assert the rendered geometry differs, not merely that the argument is
      // accepted — passing showTitle and ignoring it would satisfy the weaker check.
      const withTitle = ignitionArtwork("on", true);
      const without = ignitionArtwork("on", false);

      expect(withTitle).toContain("A25,25,");
      expect(without).toContain("A33,33,");
      expect(without).not.toBe(withTitle);
    });

    it("should dim the starter badge whenever the engine is not confirmed running", () => {
      // N/A dims like off: with no telemetry we cannot claim the engine is running.
      expect(starterArtwork("off", false)).toContain('opacity="0.45"');
      expect(starterArtwork("na", false)).toContain('opacity="0.45"');
      expect(starterArtwork("on", false)).not.toContain("opacity=");
    });

    it("should keep the starter badge red in every state rather than recolouring it", () => {
      // The red is the button's identity, carried over from the shipped icon — the bar
      // and the border carry the state instead.
      for (const state of ["on", "off", "na"] as const) {
        expect(starterArtwork(state, false)).toContain("#e74c3c");
      }
    });

    it("should draw the badge lit or dimmed from the lit input, independent of the state (issue #1438)", () => {
      expect(starterArtwork("off", false, true)).not.toContain("opacity=");
      expect(starterArtwork("on", false, false)).toContain('opacity="0.45"');
    });

    it("should keep the two-argument output exactly as before (issue #1438)", () => {
      for (const state of ["on", "off", "na"] as const) {
        for (const showTitle of [true, false]) {
          expect(starterArtwork(state, showTitle)).toBe(starterArtwork(state, showTitle, state === "on"));
        }
      }

      expect(starterArtwork("off", false)).toContain('<g opacity="0.45">');
      expect(starterArtwork("on", false)).toContain("<g>");
    });

    it("should shrink the starter badge when a title is opted back in", () => {
      const withTitle = starterArtwork("on", true);
      const without = starterArtwork("on", false);

      expect(without).toContain('r="39"');
      expect(withTitle).toContain('r="32"');
      expect(withTitle).not.toBe(without);
    });

    it("should keep every glyph variant clear of the status bar", () => {
      // The bar occupies y >= 100 and no variant of either glyph may reach it. The arc's
      // lowest point is its centre plus the radius plus half the stroke, so it is computed
      // from the rendered path rather than read off a coordinate.
      const arcBottom = (svg: string) => {
        const m = svg.match(/M([\d.]+),([\d.]+) A([\d.]+),[\d.]+,0,1,0,([\d.]+),/)!;
        const left = Number(m[1]);
        const endY = Number(m[2]);
        const r = Number(m[3]);
        const right = Number(m[4]);
        const stroke = Number(svg.match(/stroke-width="([\d.]+)"/)![1]);
        const halfChord = (right - left) / 2;

        return endY + Math.sqrt(r * r - halfChord * halfChord) + r + stroke / 2;
      };

      expect(arcBottom(ignitionArtwork("on", true))).toBeLessThan(100);
      expect(arcBottom(ignitionArtwork("on", false))).toBeLessThan(100);
      expect(53 + 39).toBeLessThan(100); // untitled starter badge, cy + r
      expect(62 + 32).toBeLessThan(100); // titled starter badge
    });
  });

  describe("ignition and starter title contract (issue #561)", () => {
    const desc = (svg: string) => JSON.parse(svg.match(/<desc>([\s\S]*?)<\/desc>/)![1]!);

    it("should label the ignition key with a single line, not the old ON/OFF pair", () => {
      // The status bar already reads ON / OFF, so the old two-line label repeated it.
      expect(desc(ignitionTemplate).title.text).toBe("IGNITION");
    });

    it("should ship the starter key with no title, since its artwork reads START", () => {
      expect(desc(starterTemplate).title.showTitle).toBe(false);
    });

    it("should keep a starter title available for a user who opts one back in", () => {
      expect(desc(starterTemplate).title.text).toBe("ENGINE\nSTART");
    });

    it("should lock the title geometry on both templates", () => {
      // Unlocked, a global Title Default of Position: Bottom or a larger font size drags
      // the label onto the status bar or the artwork. Every comparable template locks it.
      for (const template of [ignitionTemplate, starterTemplate]) {
        expect(desc(template).title.locked).toEqual(
          expect.arrayContaining(["showTitle", "fontSize", "position", "customPosition"]),
        );
      }
    });
  });

  describe("Show Graphics on the tri-state keys (issue #561)", () => {
    it("should drop the artwork but keep the status bar when graphics are hidden", async () => {
      const { resolveTitleSettings } = await import("@iracedeck/deck-core");
      vi.mocked(resolveTitleSettings).mockReturnValueOnce({
        showTitle: false,
        showGraphics: false,
        titleText: "",
        bold: true,
        fontSize: 9,
        position: "top",
        customPosition: 0,
      } as any);

      const hidden = decodeURIComponent(generateCarControlSvg(CarControlSettings.parse({ control: "starter" })));

      expect(hidden).not.toContain("START</text>");
      expect(hidden).toContain("N/A");
    });
  });

  describe("isDrsActive", () => {
    it("should return false when telemetry is null", () => {
      expect(isDrsActive(null)).toBe(false);
    });

    it("should return false when DRS_Status is undefined (connected car without DRS)", () => {
      expect(isDrsActive({} as any)).toBe(false);
    });

    it("should return false when DRS_Status is 0", () => {
      expect(isDrsActive({ DRS_Status: 0 } as any)).toBe(false);
    });

    it("should return true when DRS_Status is greater than 0", () => {
      expect(isDrsActive({ DRS_Status: 1 } as any)).toBe(true);
    });
  });

  describe("isPushToPassActive", () => {
    it("should return false when telemetry is null", () => {
      expect(isPushToPassActive(null)).toBe(false);
    });

    it("should return false when P2P_Status is undefined (connected car without P2P)", () => {
      expect(isPushToPassActive({} as any)).toBe(false);
    });

    it("should return false when P2P_Status is false", () => {
      expect(isPushToPassActive({ P2P_Status: false } as any)).toBe(false);
    });

    it("should return true when P2P_Status is true", () => {
      expect(isPushToPassActive({ P2P_Status: true } as any)).toBe(true);
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

  describe("pit limiter speed graphic (issue #638)", () => {
    it("should contain the speed number in both sizes", () => {
      expect(pitLimiterSpeedGraphic(80)).toContain("80");
      expect(pitLimiterSpeedGraphic(60)).toContain("60");
      expect(pitLimiterSpeedGraphic(100)).toContain("100");
      expect(pitLimiterSpeedGraphic(80, true)).toContain("80");
    });

    it("should be the circle artwork, not the generic N/A bar", () => {
      const graphic = pitLimiterSpeedGraphic(80);

      expect(graphic).toContain("<circle");
      // The status bar (not this graphic) carries the N/A text.
      expect(graphic).not.toContain("N/A");
    });

    it("should be state-neutral — state lives in the status bar, so no on/off blue or red", () => {
      const graphic = pitLimiterSpeedGraphic(80);

      expect(graphic).not.toContain("#3498db");
      expect(graphic).not.toContain("#e74c3c");
    });

    it("should grow when the title is hidden and shrink when it is shown", () => {
      const large = pitLimiterSpeedGraphic(80, false); // title hidden (default)
      const compact = pitLimiterSpeedGraphic(80, true); // title shown

      // Larger radius and font when there is no title competing for space.
      expect(large).toContain('r="33"');
      expect(compact).toContain('r="24"');
      expect(large).not.toBe(compact);
    });
  });

  describe("generateCarControlSvg telemetry variants", () => {
    it("should render the green ON status bar when the limiter is active", () => {
      const decoded = decodeURIComponent(
        generateCarControlSvg(CarControlSettings.parse({ control: "pit-speed-limiter" }), {
          pitLimiterAvailable: true,
          pitLimiterActive: true,
          pitSpeedLimit: 80,
        }),
      );

      expect(decoded).toContain(">ON<");
      expect(decoded).toContain("#2ecc71");
      // The speed circle is kept alongside the status bar.
      expect(decoded).toContain("80");
      expect(decoded).toContain("<circle");
    });

    it("should render the red OFF status bar when the limiter is inactive", () => {
      const decoded = decodeURIComponent(
        generateCarControlSvg(CarControlSettings.parse({ control: "pit-speed-limiter" }), {
          pitLimiterAvailable: true,
          pitLimiterActive: false,
          pitSpeedLimit: 80,
        }),
      );

      expect(decoded).toContain(">OFF<");
      expect(decoded).toContain("#e74c3c");
    });

    it("should default to the OFF status bar when no telemetry state is provided", () => {
      const decoded = decodeURIComponent(
        generateCarControlSvg(CarControlSettings.parse({ control: "pit-speed-limiter" })),
      );

      expect(decoded).toContain(">OFF<");
    });

    it("should use the larger circle when the title is hidden (default)", async () => {
      const { resolveTitleSettings } = await import("@iracedeck/deck-core");
      vi.mocked(resolveTitleSettings).mockReturnValueOnce({
        showTitle: false,
        showGraphics: true,
        titleText: "",
        bold: true,
        fontSize: 18,
        position: "top",
        customPosition: 0,
      });

      const decoded = decodeURIComponent(
        generateCarControlSvg(CarControlSettings.parse({ control: "pit-speed-limiter" }), {
          pitLimiterActive: false,
          pitSpeedLimit: 80,
        }),
      );

      expect(decoded).toContain('r="33"');
    });

    it("should use the compact circle when the title is shown", async () => {
      const { resolveTitleSettings } = await import("@iracedeck/deck-core");
      vi.mocked(resolveTitleSettings).mockReturnValueOnce({
        showTitle: true,
        showGraphics: true,
        titleText: "PIT LIMITER",
        bold: true,
        fontSize: 18,
        position: "top",
        customPosition: 0,
      });

      const decoded = decodeURIComponent(
        generateCarControlSvg(CarControlSettings.parse({ control: "pit-speed-limiter" }), {
          pitLimiterActive: false,
          pitSpeedLimit: 80,
        }),
      );

      expect(decoded).toContain('r="24"');
    });

    it("should include the speed limit in the icon", () => {
      const decoded = decodeURIComponent(
        generateCarControlSvg(CarControlSettings.parse({ control: "pit-speed-limiter" }), {
          pitLimiterActive: false,
          pitSpeedLimit: 60,
        }),
      );

      expect(decoded).toContain("60");
    });

    it("should use the default speed when pitSpeedLimit is undefined", () => {
      const decoded = decodeURIComponent(
        generateCarControlSvg(CarControlSettings.parse({ control: "pit-speed-limiter" }), { pitLimiterActive: true }),
      );

      expect(decoded).toContain("80");
    });

    it("should render the grey N/A status bar (not on/off) when the limiter is unavailable (issue #638)", () => {
      const decoded = decodeURIComponent(
        generateCarControlSvg(CarControlSettings.parse({ control: "pit-speed-limiter" }), {
          pitLimiterAvailable: false,
          pitLimiterActive: false,
          pitSpeedLimit: 80,
        }),
      );

      // Grey N/A status bar — not the on/off bars.
      expect(decoded).toContain(">N/A<");
      expect(decoded).not.toContain(">ON<");
      expect(decoded).not.toContain(">OFF<");
      expect(decoded).not.toContain("#2ecc71");
      expect(decoded).not.toContain("#e74c3c");
      // The speed circle is retained — the N/A state keeps the graphic, unlike the other
      // tri-state buttons whose N/A is a bare bar.
      expect(decoded).toContain("80");
      expect(decoded).toContain("<circle");
    });

    it("should show the unavailable state even when reported active (availability wins)", () => {
      const decoded = decodeURIComponent(
        generateCarControlSvg(CarControlSettings.parse({ control: "pit-speed-limiter" }), {
          pitLimiterAvailable: false,
          pitLimiterActive: true,
          pitSpeedLimit: 80,
        }),
      );

      expect(decoded).toContain(">N/A<");
      expect(decoded).not.toContain(">ON<");
    });

    it("should not affect other controls when pitLimiterActive is passed", () => {
      const starter = generateCarControlSvg(CarControlSettings.parse({ control: "starter" }), {
        pitLimiterActive: true,
        pitSpeedLimit: 80,
      });
      const starterDefault = generateCarControlSvg(CarControlSettings.parse({ control: "starter" }));

      expect(starter).toBe(starterDefault);
    });

    it("should render DRS ON status bar when drsActive is true", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "drs" }), { drsActive: true });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain(">ON<");
    });

    it("should render DRS OFF status bar when drsActive is false", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "drs" }), { drsActive: false });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain(">OFF<");
    });

    it("should render DRS N/A status bar when drsActive is undefined (no telemetry)", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "drs" }), {});
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain(">N/A<");
      expect(decoded).not.toContain(">OFF<");
    });

    it("should render DRS N/A status bar when telemetryState is not provided", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "drs" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain(">N/A<");
    });

    it("should render Push-to-Pass ON status bar when pushToPassActive is true", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "push-to-pass" }), {
        pushToPassActive: true,
      });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain(">ON<");
    });

    it("should render Push-to-Pass OFF status bar when pushToPassActive is false", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "push-to-pass" }), {
        pushToPassActive: false,
      });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain(">OFF<");
    });

    it("should render Push-to-Pass N/A status bar when pushToPassActive is undefined (no telemetry)", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "push-to-pass" }), {});
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain(">N/A<");
      expect(decoded).not.toContain(">OFF<");
    });

    it("should render Push-to-Pass N/A status bar when telemetryState is not provided", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "push-to-pass" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain(">N/A<");
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
      await action.onWillDisappear(fakeEvent("action-1", { control: "starter" }) as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
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

  describe("hasEngineCaught (issue #1438)", () => {
    const live = (extra: Record<string, unknown>) => ({ IsOnTrack: true, ...extra }) as any;

    it("should not count a cranking engine, whose stall bit is already clear, as caught", () => {
      expect(hasEngineCaught(live({ EngineWarnings: 0, RPM: 250 }))).toBe(false);
    });

    it("should count an engine at idle as caught", () => {
      expect(hasEngineCaught(live({ EngineWarnings: 0, RPM: 900 }))).toBe(true);
    });

    it("should never count a stalled engine as caught, whatever the RPM", () => {
      expect(hasEngineCaught(live({ EngineWarnings: 0x0008, RPM: 900 }))).toBe(false);
    });

    it("should fall back on the stall bit when there is no RPM", () => {
      expect(hasEngineCaught(live({ EngineWarnings: 0 }))).toBe(true);
    });

    it("should not count N/A as caught", () => {
      expect(hasEngineCaught(null)).toBe(false);
      expect(hasEngineCaught({ IsOnTrack: false, EngineWarnings: 0, RPM: 900 } as any)).toBe(false);
    });
  });

  describe("starter flash while starting (issue #1438)", () => {
    const ENGINE_OFF = { IsOnTrack: true, EngineWarnings: 0x0008, RPM: 0 };
    /** The starter turning the engine over: iRacing already clears the stall bit. */
    const CRANKING = { IsOnTrack: true, EngineWarnings: 0, RPM: 250 };
    const CAUGHT = { IsOnTrack: true, EngineWarnings: 0, RPM: 900 };
    const STARTER = { control: "starter" };

    let action: CarControl;
    let telemetry: Record<string, unknown> | null;

    /** The frames drawn so far, decoded; flash frames and telemetry renders alike. */
    const frames = () => vi.mocked(action["updateKeyImage"]).mock.calls.map(([, uri]) => decodeURIComponent(uri));
    const isLit = (frame: string) => !frame.includes('<g opacity="0.45">');
    const flashing = () => action["starterFlashes"].has("action-1");
    const tick = () => {
      const onTelemetry = vi.mocked(action["sdkController"].subscribe).mock.calls[0][1];
      onTelemetry(telemetry as any, true);
    };
    const artworkFor = (starterState: "on" | "off") =>
      decodeURIComponent(generateCarControlSvg(CarControlSettings.parse(STARTER), { starterState }));
    /** A Starter key-down, then the macrotask the first frame waits for. */
    const press = async () => {
      await action.onKeyDown(fakeEvent("action-1", STARTER) as any);
      await vi.advanceTimersByTimeAsync(0);
    };
    const release = () => action.onKeyUp(fakeEvent("action-1", STARTER) as any);

    beforeEach(async () => {
      vi.useFakeTimers();
      telemetry = { ...ENGINE_OFF };
      action = new CarControl();
      vi.mocked(action["sdkController"].getCurrentTelemetry).mockImplementation(() => telemetry as any);
      await action.onWillAppear(fakeEvent("action-1", STARTER) as any);
      vi.mocked(action["updateKeyImage"]).mockClear();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should flash on every Starter key, with no setting to turn it on", async () => {
      await press();

      expect(flashing()).toBe(true);
    });

    it("should crank slow first, then faster, each frame shorter than the last", () => {
      for (let i = 1; i < STARTER_CRANK_FRAMES_MS.length; i++) {
        expect(STARTER_CRANK_FRAMES_MS[i]).toBeLessThan(STARTER_CRANK_FRAMES_MS[i - 1]);
      }

      // The fastest frame stays under the 10 Hz cap the key's other updates keep.
      expect(STARTER_CRANK_FRAMES_MS.at(-1)).toBeGreaterThanOrEqual(100);
    });

    it("should hold each frame for its ramp length, then repeat the fastest while held", async () => {
      await press();

      expect(frames()).toHaveLength(1);

      for (const [i, length] of STARTER_CRANK_FRAMES_MS.entries()) {
        await vi.advanceTimersByTimeAsync(length - 1);

        expect(frames()).toHaveLength(i + 1);

        await vi.advanceTimersByTimeAsync(1);

        expect(frames()).toHaveLength(i + 2);
      }

      const fastest = STARTER_CRANK_FRAMES_MS.at(-1)!;
      await vi.advanceTimersByTimeAsync(fastest * 5);

      expect(frames()).toHaveLength(STARTER_CRANK_FRAMES_MS.length + 6);
      expect(flashing()).toBe(true);
    });

    it("should alternate lit and dimmed, beginning lit, over the real OFF status bar", async () => {
      await press();
      await vi.advanceTimersByTimeAsync(STARTER_CRANK_FRAMES_MS.slice(0, 4).reduce((a, b) => a + b, 0));

      expect(frames().map(isLit)).toEqual([true, false, true, false, true]);

      for (const frame of frames()) {
        expect(frame).toContain("OFF");
      }

      expect(frames()[0]).not.toBe(artworkFor("on"));
      expect(frames()[0]).not.toBe(artworkFor("off"));
    });

    it("should keep flashing while the engine cranks, though its stall bit reads running", async () => {
      // Regression (found on hardware): iRacing clears EngineStalled as soon as the starter
      // turns the engine over, so a stop on the stall bit ended the flash ~45 ms into a hold.
      await press();
      telemetry = { ...CRANKING };
      tick();
      await vi.advanceTimersByTimeAsync(3000);

      expect(flashing()).toBe(true);
    });

    it("should end at once on release when the engine has not caught, without a tail", async () => {
      await press();
      await vi.advanceTimersByTimeAsync(1000);
      await release();

      expect(flashing()).toBe(false);
      expect(frames().at(-1)).toBe(artworkFor("off"));

      const drawn = frames().length;
      await vi.advanceTimersByTimeAsync(3000);

      expect(frames()).toHaveLength(drawn);
    });

    it("should end at once and go green when the engine catches during the hold", async () => {
      await press();
      telemetry = { ...CRANKING };
      await vi.advanceTimersByTimeAsync(1000);
      const drawn = frames().length;

      telemetry = { ...CAUGHT };
      tick();

      expect(flashing()).toBe(false);
      expect(frames()).toHaveLength(drawn + 1);
      expect(frames().at(-1)).toBe(artworkFor("on"));

      await release();
      await vi.advanceTimersByTimeAsync(3000);

      expect(frames()).toHaveLength(drawn + 1);
    });

    it("should end from the frame step when the engine catches before a tick", async () => {
      await press();
      telemetry = { ...CAUGHT };
      await vi.advanceTimersByTimeAsync(STARTER_CRANK_FRAMES_MS[0]);

      expect(flashing()).toBe(false);
      expect(frames()).toHaveLength(2);
      expect(frames().at(-1)).toBe(artworkFor("on"));
    });

    it("should give a running engine one dimmed chuk, then the ON look, however long it is held", async () => {
      telemetry = { ...CAUGHT };
      await press();

      expect(frames()).toHaveLength(1);
      expect(isLit(frames()[0])).toBe(false);
      expect(frames()[0]).toContain("ON");

      await vi.advanceTimersByTimeAsync(STARTER_CHUK_MS - 1);

      expect(frames()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);

      expect(flashing()).toBe(false);
      expect(frames()).toHaveLength(2);
      expect(frames().at(-1)).toBe(artworkFor("on"));

      await vi.advanceTimersByTimeAsync(3000);
      await release();

      expect(frames()).toHaveLength(2);
    });

    it("should finish the chuk even when the key is released at once", async () => {
      telemetry = { ...CAUGHT };
      await press();
      await release();

      expect(flashing()).toBe(true);

      await vi.advanceTimersByTimeAsync(STARTER_CHUK_MS);

      expect(flashing()).toBe(false);
    });

    it("should flash while the hold is still being sent, not only once it resolves", async () => {
      // Regression (found on hardware): a SimHub-role hold is an HTTP round trip, and the
      // flash used to start only after it resolved.
      let resolveHold!: () => void;
      mockHoldBinding.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveHold = resolve)));
      const keyDown = action.onKeyDown(fakeEvent("action-1", STARTER) as any);
      await vi.advanceTimersByTimeAsync(STARTER_CRANK_FRAMES_MS[0] + STARTER_CRANK_FRAMES_MS[1]);

      expect(frames().map(isLit)).toEqual([true, false, true]);

      resolveHold();
      await keyDown;
    });

    it("should leave the hold's request to go out before the first frame is drawn", async () => {
      await action.onKeyDown(fakeEvent("action-1", STARTER) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlStarter");
      expect(frames()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(0);

      expect(frames()).toHaveLength(1);
    });

    it("should have the regenerate callback draw the current frame, not the bare state", async () => {
      await press();
      const regenerate = vi.mocked(action["setRegenerateCallback"]).mock.calls.at(-1)![1];

      expect(isLit(decodeURIComponent(regenerate()))).toBe(true);

      await vi.advanceTimersByTimeAsync(STARTER_CRANK_FRAMES_MS[0]);

      expect(decodeURIComponent(regenerate())).toBe(frames().at(-1));
      expect(isLit(frames().at(-1)!)).toBe(false);
    });

    it("should leave the image to the flash on a telemetry tick", async () => {
      await press();
      // A tick that would otherwise re-render (the state key was cleared by a change).
      action["lastState"].delete("action-1");
      telemetry = { ...CRANKING };
      tick();

      expect(frames()).toHaveLength(1);
    });

    it("should restart the ramp on a second press", async () => {
      await press();
      await vi.advanceTimersByTimeAsync(3000);
      await release();
      await press();
      const drawn = frames().length;
      await vi.advanceTimersByTimeAsync(STARTER_CRANK_FRAMES_MS[0] - 1);

      expect(frames()).toHaveLength(drawn);

      await vi.advanceTimersByTimeAsync(1);

      expect(frames()).toHaveLength(drawn + 1);
    });

    it("should not flash when the Starter binding is missing", async () => {
      vi.mocked(action["isBindingMissing"]).mockReturnValue(true);
      await press();

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlStarter");
      expect(flashing()).toBe(false);
    });

    it("should stop the flash when the Mode changes away from Starter during the hold", async () => {
      mockHoldBinding.mockImplementationOnce(async () => {
        await action.onDidReceiveSettings(fakeEvent("action-1", { control: "ignition" }) as any);
      });
      await press();
      vi.mocked(action["updateKeyImage"]).mockClear();
      await vi.advanceTimersByTimeAsync(3000);

      expect(flashing()).toBe(false);
      expect(frames()).toHaveLength(0);
    });

    it("should not flash a press that sent another control when Mode changes to Starter mid-send", async () => {
      await action.onDidReceiveSettings(fakeEvent("action-1", { control: "ignition" }) as any);
      mockTapBinding.mockImplementationOnce(async () => {
        await action.onDidReceiveSettings(fakeEvent("action-1", STARTER) as any);
      });
      await action.onKeyDown(fakeEvent("action-1", { control: "ignition" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("carControlIgnition");
      expect(flashing()).toBe(false);
    });

    it("should clear the flash on onWillDisappear and draw nothing after it", async () => {
      await press();

      expect(flashing()).toBe(true);

      await action.onWillDisappear(fakeEvent("action-1", STARTER) as any);
      const drawn = frames().length;
      await vi.advanceTimersByTimeAsync(3000);

      expect(flashing()).toBe(false);
      expect(frames()).toHaveLength(drawn);
    });

    it("should clear the flash on a settings change and draw no further frame", async () => {
      await press();

      expect(flashing()).toBe(true);

      await action.onDidReceiveSettings(fakeEvent("action-1", STARTER) as any);
      const drawn = frames().length;
      await vi.advanceTimersByTimeAsync(3000);

      expect(flashing()).toBe(false);
      expect(frames()).toHaveLength(drawn);
    });

    it("should send the same hold and release whether it cranks or chuks", async () => {
      await press();
      await release();
      const cranked = [mockHoldBinding.mock.calls, mockReleaseBinding.mock.calls, mockTapBinding.mock.calls];

      vi.clearAllMocks();
      telemetry = { ...CAUGHT };
      await press();
      await release();

      expect([mockHoldBinding.mock.calls, mockReleaseBinding.mock.calls, mockTapBinding.mock.calls]).toEqual(cranked);
    });

    it("should flash from a dial press and end on dial up", async () => {
      await action.onDialDown(fakeEvent("action-1", STARTER) as any);
      await vi.advanceTimersByTimeAsync(4000);

      expect(flashing()).toBe(true);

      await action.onDialUp(fakeEvent("action-1", STARTER) as any);

      expect(flashing()).toBe(false);
    });
  });

  describe("backup driver inputs (issue #183)", () => {
    let action: CarControl;

    beforeEach(() => {
      action = new CarControl();
    });

    it("should generate valid data URIs with the default titles for all four modes", () => {
      const expected: Record<string, string[]> = {
        handbrake: ["HANDBRAKE"],
        "second-clutch": ["CLUTCH"],
        "second-up-shift": ["SHIFT UP"],
        "second-down-shift": ["SHIFT DOWN"],
      };

      for (const [control, labels] of Object.entries(expected)) {
        const result = generateCarControlSvg(CarControlSettings.parse({ control: control }));

        expect(result).toContain("data:image/svg+xml");
        const decoded = decodeURIComponent(result);

        for (const label of labels) {
          expect(decoded).toContain(label);
        }
      }
    });

    it("should produce a distinct icon per mode", () => {
      const controls = ["handbrake", "second-clutch", "second-up-shift", "second-down-shift"] as const;
      const unique = new Set(controls.map((control) => generateCarControlSvg(CarControlSettings.parse({ control }))));

      expect(unique.size).toBe(controls.length);
    });

    it("should hold the handbrake binding on keyDown and release on keyUp", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "handbrake" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlHandbrake");
      expect(mockTapBinding).not.toHaveBeenCalled();

      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should hold the second-clutch binding on keyDown and release on keyUp", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "second-clutch" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlSecondClutch");
      expect(mockTapBinding).not.toHaveBeenCalled();

      await action.onKeyUp(fakeEvent("action-1") as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should hold on dialDown and release on dialUp for handbrake", async () => {
      await action.onDialDown(fakeEvent("action-1", { control: "handbrake" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlHandbrake");

      await action.onDialUp(fakeEvent("action-1") as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should tap the second-up-shift binding on keyDown", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "second-up-shift" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("carControlSecondUpShift");
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("should tap the second-down-shift binding on keyDown", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "second-down-shift" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("carControlSecondDownShift");
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("should release a held handbrake on onWillDisappear", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "handbrake" }) as any);
      await action.onWillDisappear(fakeEvent("action-1", { control: "handbrake" }) as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
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

  describe("getSessionContext", () => {
    /** Build a minimal session-info object containing a single session of the given type. */
    function sessionInfoWith(sessionType: string, sessionNum = 0) {
      return {
        SessionInfo: {
          Sessions: [{ SessionNum: sessionNum, SessionType: sessionType }],
        },
      };
    }

    it("should return unknown when telemetry and session info are null", () => {
      expect(getSessionContext(null, null)).toBe("unknown");
    });

    it("should return unknown when telemetry is null even if session info is available", () => {
      expect(getSessionContext(null, sessionInfoWith("Race"))).toBe("unknown");
    });

    it("should return unknown when session info has no matching session", () => {
      expect(getSessionContext({ SessionNum: 5 } as any, sessionInfoWith("Race", 0))).toBe("unknown");
    });

    it("should return test for Offline Testing session", () => {
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfoWith("Offline Testing"))).toBe("test");
    });

    it("should return practice for Practice session", () => {
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfoWith("Practice"))).toBe("practice");
    });

    it("should return practice for Lone Practice session", () => {
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfoWith("Lone Practice"))).toBe("practice");
    });

    it("should return qualify for Lone Qualify session", () => {
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfoWith("Lone Qualify"))).toBe("qualify");
    });

    it("should return qualify for Open Qualify session", () => {
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfoWith("Open Qualify"))).toBe("qualify");
    });

    it("should return grid for Race session before start (GetInCar)", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 1 } as any, sessionInfoWith("Race"))).toBe("grid");
    });

    it("should return grid for Race session during warmup", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 2 } as any, sessionInfoWith("Race"))).toBe("grid");
    });

    it("should return grid for Race session during parade laps", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 3 } as any, sessionInfoWith("Race"))).toBe("grid");
    });

    it("should return race for Race session when racing", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 4 } as any, sessionInfoWith("Race"))).toBe("race");
    });

    it("should return race for Race session after checkered", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 5 } as any, sessionInfoWith("Race"))).toBe("race");
    });

    it("should return race for Race session during cooldown", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 6 } as any, sessionInfoWith("Race"))).toBe("race");
    });

    it("should return grid for Race session when SessionState is missing", () => {
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfoWith("Race"))).toBe("grid");
    });

    it("should treat Warmup session type as a race-like session", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 4 } as any, sessionInfoWith("Warmup"))).toBe("race");
    });

    it("should treat Heat Racing session type as a race-like session", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 4 } as any, sessionInfoWith("Heat Racing"))).toBe("race");
    });

    it("should pick the session matching SessionNum from multiple sessions", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [
            { SessionNum: 0, SessionType: "Practice" },
            { SessionNum: 1, SessionType: "Lone Qualify" },
            { SessionNum: 2, SessionType: "Race" },
          ],
        },
      };
      expect(getSessionContext({ SessionNum: 1 } as any, sessionInfo)).toBe("qualify");
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfo)).toBe("practice");
    });
  });

  describe("generateCarControlSvg escape", () => {
    it("should generate a valid data URI for escape", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "escape" }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should include ESCAPE label", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "escape" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("ESCAPE");
    });
  });

  describe("generateCarControlSvg enter-exit-tow states", () => {
    it("should generate state-specific icon for enter-exit-tow with enter-car state", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "enter-car",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("enter-car");
      expect(decoded).toContain("DRIVE");
    });

    it("should generate state-specific icon for enter-exit-tow with exit-car state", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "exit-car",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("exit-car");
      expect(decoded).toContain("EXIT");
    });

    it("should generate state-specific icon for enter-exit-tow with reset-to-pits state", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "reset-to-pits",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("reset-to-pits");
      expect(decoded).toContain("RESET");
    });

    it("should generate state-specific icon for enter-exit-tow with tow state", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "tow",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("tow");
      expect(decoded).toContain("TOW");
    });

    it("should default to enter-car when no telemetry state for enter-exit-tow", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }));
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("enter-car");
      expect(decoded).toContain("DRIVE");
    });

    it("should produce different icons for each enter-exit-tow state", () => {
      const states = ["enter-car", "exit-car", "reset-to-pits", "tow"] as const;
      const results = states.map((s) =>
        generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), { enterExitTowState: s }),
      );
      const unique = new Set(results);
      expect(unique.size).toBe(4);
    });
  });

  describe("generateCarControlSvg session-context appearance (issue #632)", () => {
    it("should render green background, steering wheel, and TEST label for test context", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "enter-car",
        sessionContext: "test",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#0fa30f"');
      expect(decoded).toContain("enter-car");
      expect(decoded).toContain("TEST");
    });

    it("should render blue background, steering wheel, and PRACTICE label for practice context", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "enter-car",
        sessionContext: "practice",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#1f5fd6"');
      expect(decoded).toContain("enter-car");
      expect(decoded).toContain("PRACTICE");
    });

    it("should render purple background, lightning icon, and QUALIFY label for qualify context", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "enter-car",
        sessionContext: "qualify",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#9013f5"');
      expect(decoded).toContain("session-qualify");
      expect(decoded).toContain("QUALIFY");
    });

    it("should render green background, car icon, and GRID label for grid context", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "enter-car",
        sessionContext: "grid",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#0fa30f"');
      expect(decoded).toContain("session-grid");
      expect(decoded).toContain("GRID");
    });

    it("should render green background, flag icon, and RACE label for race context", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "enter-car",
        sessionContext: "race",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#0fa30f"');
      expect(decoded).toContain("session-race");
      expect(decoded).toContain("RACE");
    });

    it("should keep the legacy DRIVE appearance for unknown context", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "enter-car",
        sessionContext: "unknown",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).not.toContain("bg=");
      expect(decoded).toContain("enter-car");
      expect(decoded).toContain("DRIVE");
    });

    it("should keep the legacy DRIVE appearance when sessionContext is not provided", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "enter-car",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).not.toContain("bg=");
      expect(decoded).toContain("DRIVE");
    });

    it("should render red background for exit-car state", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "exit-car",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#ff0000"');
      expect(decoded).toContain("exit-car");
      expect(decoded).toContain("EXIT");
    });

    it("should render red background for reset-to-pits state", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "reset-to-pits",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#ff0000"');
      expect(decoded).toContain("reset-to-pits");
      expect(decoded).toContain("RESET");
    });

    it("should render red background for tow state", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "tow",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#ff0000"');
      expect(decoded).toContain("tow");
      expect(decoded).toContain("TOW");
    });

    it("should ignore session context for in-car states (red background wins)", () => {
      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "tow",
        sessionContext: "race",
      });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#ff0000"');
      expect(decoded).toContain("TOW");
    });

    it("should produce different icons for different session contexts", () => {
      const contexts = ["test", "practice", "qualify", "grid", "race"] as const;
      const results = contexts.map((sessionContext) =>
        generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
          enterExitTowState: "enter-car",
          sessionContext,
        }),
      );
      const unique = new Set(results);
      expect(unique.size).toBe(contexts.length);
    });

    it("should override user color overrides with the semantic background", async () => {
      // Simulate a user-configured background color coming out of the color resolution chain;
      // the state-driven background must still win (issue #632 acceptance criterion).
      const { resolveIconColors } = await import("@iracedeck/deck-core");
      vi.mocked(resolveIconColors).mockReturnValueOnce({ backgroundColor: "#123456" });

      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "enter-car",
        sessionContext: "race",
      });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain('bg="#0fa30f"');
      expect(decoded).not.toContain("#123456");
    });

    it("should override user color overrides with the red in-car background", async () => {
      const { resolveIconColors } = await import("@iracedeck/deck-core");
      vi.mocked(resolveIconColors).mockReturnValueOnce({ backgroundColor: "#123456" });

      const result = generateCarControlSvg(CarControlSettings.parse({ control: "enter-exit-tow" }), {
        enterExitTowState: "tow",
      });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain('bg="#ff0000"');
      expect(decoded).not.toContain("#123456");
    });
  });

  describe("session context state key (issue #632)", () => {
    it("should include session context in the state key so context changes re-render", () => {
      const action = new CarControl();
      const settings = { control: "enter-exit-tow" } as any;
      const gridKey = action["buildStateKey"](settings, { enterExitTowState: "enter-car", sessionContext: "grid" });
      const raceKey = action["buildStateKey"](settings, { enterExitTowState: "enter-car", sessionContext: "race" });

      expect(gridKey).not.toBe(raceKey);
    });

    it("should compute sessionContext in getTelemetryState for enter-exit-tow", () => {
      const action = new CarControl();
      (action as any).sdkController.getSessionInfo = vi.fn(() => ({
        SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
      }));
      const state = action["getTelemetryState"](
        { IsOnTrack: false, SessionNum: 0, SessionState: 4 } as any,
        "enter-exit-tow",
      );

      expect(state.enterExitTowState).toBe("enter-car");
      expect(state.sessionContext).toBe("race");
    });
  });

  describe("pit limiter availability state (issue #638)", () => {
    it("should include availability in the state key so a car swap re-renders", () => {
      const action = new CarControl();
      const settings = { control: "pit-speed-limiter" } as any;
      const availableKey = action["buildStateKey"](settings, {
        pitLimiterAvailable: true,
        pitLimiterActive: false,
        pitSpeedLimit: 80,
      });
      const unavailableKey = action["buildStateKey"](settings, {
        pitLimiterAvailable: false,
        pitLimiterActive: false,
        pitSpeedLimit: 80,
      });

      expect(availableKey).not.toBe(unavailableKey);
    });

    it("should produce the same state key for a no-limiter car regardless of the (irrelevant) active flag", () => {
      const action = new CarControl();
      const settings = { control: "pit-speed-limiter" } as any;
      const keyActiveFalse = action["buildStateKey"](settings, {
        pitLimiterAvailable: false,
        pitLimiterActive: false,
        pitSpeedLimit: 80,
      });
      const keyActiveTrue = action["buildStateKey"](settings, {
        pitLimiterAvailable: false,
        pitLimiterActive: true,
        pitSpeedLimit: 80,
      });

      // Both render the identical N/A icon, so the dedupe key must match (no needless re-render).
      expect(keyActiveFalse).toBe(keyActiveTrue);
    });

    it("should compute pitLimiterAvailable=false for a car without a limiter", () => {
      const action = new CarControl();
      const state = action["getTelemetryState"]({ EngineWarnings: 0 } as any, "pit-speed-limiter");

      expect(state.pitLimiterAvailable).toBe(false);
    });

    it("should compute pitLimiterAvailable=true for a car with a limiter", () => {
      const action = new CarControl();
      const state = action["getTelemetryState"](
        { EngineWarnings: 0, dcPitSpeedLimiterToggle: false } as any,
        "pit-speed-limiter",
      );

      expect(state.pitLimiterAvailable).toBe(true);
    });

    it("should still attempt the binding when pressed on a no-limiter car (consistent with sibling tri-state buttons)", async () => {
      const action = new CarControl();
      (action as any).sdkController.getCurrentTelemetry = vi.fn(() => ({ EngineWarnings: 0 }));
      await action.onKeyDown(fakeEvent("action-1", { control: "pit-speed-limiter" }) as any);

      // The N/A state is informational only on the icon; the press is not blocked —
      // it dispatches the configured binding just like DRS / Push To Pass N/A states.
      expect(mockTapBinding).toHaveBeenCalledWith("carControlPitSpeedLimiter");
    });
  });

  describe("escape manual hold (auto-hold OFF)", () => {
    let action: CarControl;

    beforeEach(() => {
      action = new CarControl();
    });

    it("should press ESC via direct keyboard on keyDown", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: false }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledWith({ key: "escape", code: "Escape" });
      expect(mockTapBinding).not.toHaveBeenCalled();
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("should release ESC via direct keyboard on keyUp", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: false }) as any);
      await action.onKeyUp(fakeEvent("action-1", { control: "escape", autoHold: false }) as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledWith({ key: "escape", code: "Escape" });
      expect(mockReleaseBinding).not.toHaveBeenCalled();
    });

    it("should press ESC on dialDown and release on dialUp", async () => {
      await action.onDialDown(fakeEvent("action-1", { control: "escape", autoHold: false }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledWith({ key: "escape", code: "Escape" });

      await action.onDialUp(fakeEvent("action-1", { control: "escape", autoHold: false }) as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledWith({ key: "escape", code: "Escape" });
    });

    it("should release ESC on onWillDisappear", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: false }) as any);
      await action.onWillDisappear(fakeEvent("action-1", { control: "escape", autoHold: false }) as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledWith({ key: "escape", code: "Escape" });
    });
  });

  describe("escape auto-hold ON", () => {
    let action: CarControl;

    beforeEach(() => {
      vi.useFakeTimers();
      action = new CarControl();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should press ESC and start auto-hold timer on keyDown", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledWith({ key: "escape", code: "Escape" });
      expect(mockTapBinding).not.toHaveBeenCalled();
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("should not release ESC on keyUp (timer handles release)", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);
      await action.onKeyUp(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);

      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
    });

    it("should auto-release ESC after 1.5 seconds", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);

      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);

      expect(mockReleaseKeyCombination).toHaveBeenCalledWith({ key: "escape", code: "Escape" });
    });

    it("should not release ESC before 1.5 seconds", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
    });

    it("should cancel auto-hold and release ESC on second press", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledTimes(1);

      // Second press while timer running
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledWith({ key: "escape", code: "Escape" });
      // Should not have pressed again
      expect(mockPressKeyCombination).toHaveBeenCalledTimes(1);
    });

    it("should not release again after timer expires when cancelled by second press", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);
      // Cancel with second press
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);

      mockReleaseKeyCombination.mockClear();

      // Advance past timer — should not fire since it was cancelled
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
    });

    it("should handle independent auto-hold timers for different contexts", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);
      await action.onKeyDown(fakeEvent("action-2", { control: "escape", autoHold: true }) as any);

      expect(mockPressKeyCombination).toHaveBeenCalledTimes(2);

      // Cancel action-1 with second press
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledTimes(1);

      // action-2's timer should still fire
      await vi.advanceTimersByTimeAsync(1500);

      expect(mockReleaseKeyCombination).toHaveBeenCalledTimes(2);
    });
  });

  describe("escape cleanup on disappear", () => {
    let action: CarControl;

    beforeEach(() => {
      vi.useFakeTimers();
      action = new CarControl();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should clear auto-hold timer and release ESC on disappear", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);
      await action.onWillDisappear(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);

      expect(mockReleaseKeyCombination).toHaveBeenCalledWith({ key: "escape", code: "Escape" });

      mockReleaseKeyCombination.mockClear();

      // Timer should not fire after cleanup
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
    });

    it("should clean up autoHoldTimers map on disappear", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);

      expect(action["autoHoldTimers"].has("action-1")).toBe(true);

      await action.onWillDisappear(fakeEvent("action-1", { control: "escape", autoHold: true }) as any);

      expect(action["autoHoldTimers"].has("action-1")).toBe(false);
    });
  });

  describe("enter-exit-tow auto-hold", () => {
    type State = "enter-car" | "exit-car" | "reset-to-pits" | "tow";

    function telemetryFor(state: State): Record<string, unknown> | null {
      switch (state) {
        case "enter-car":
          return null;
        case "exit-car":
          return { IsOnTrack: true, PlayerCarInPitStall: true, SessionNum: 0 };
        case "reset-to-pits":
        case "tow":
          return { IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 };
      }
    }

    function sessionInfoFor(state: State): Record<string, unknown> | null {
      if (state !== "tow" && state !== "reset-to-pits") return null;

      const sessionType = state === "tow" ? "Race" : "Practice";

      return { SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: sessionType }] } };
    }

    function primeTelemetry(action: CarControl, state: State): void {
      (action as any).sdkController.getCurrentTelemetry = vi.fn(() => telemetryFor(state));
      (action as any).sdkController.getSessionInfo = vi.fn(() => sessionInfoFor(state));
    }

    describe("manual hold (autoHoldStates empty)", () => {
      let action: CarControl;

      beforeEach(() => {
        action = new CarControl();
      });

      it.each(["enter-car", "exit-car", "reset-to-pits", "tow"] as const)(
        "should hold on keyDown and release on keyUp when state is not in autoHoldStates (state=%s)",
        async (state) => {
          primeTelemetry(action, state);
          const settings = { control: "enter-exit-tow", autoHoldStates: [] as string[] };

          await action.onKeyDown(fakeEvent("action-1", settings) as any);

          expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlEnterExitTow");

          await action.onKeyUp(fakeEvent("action-1", settings) as any);

          expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
        },
      );

      it("should release via releaseBinding on onWillDisappear", async () => {
        primeTelemetry(action, "exit-car");
        const settings = { control: "enter-exit-tow" };

        await action.onKeyDown(fakeEvent("action-1", settings) as any);
        await action.onWillDisappear(fakeEvent("action-1", settings) as any);

        expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
        expect(mockReleaseKeyCombination).not.toHaveBeenCalled();
      });
    });

    describe("auto-hold ON per state", () => {
      let action: CarControl;

      beforeEach(() => {
        vi.useFakeTimers();
        action = new CarControl();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      const cases: Array<{ state: State }> = [{ state: "exit-car" }, { state: "reset-to-pits" }, { state: "tow" }];

      it.each(cases)("should hold and start auto-release timer on keyDown (state=$state)", async ({ state }) => {
        primeTelemetry(action, state);

        await action.onKeyDown(fakeEvent("action-1", { control: "enter-exit-tow", autoHoldStates: [state] }) as any);

        expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlEnterExitTow");
        expect(mockReleaseBinding).not.toHaveBeenCalled();
      });

      it.each(cases)("should not release on keyUp when timer is running (state=$state)", async ({ state }) => {
        primeTelemetry(action, state);
        const settings = { control: "enter-exit-tow", autoHoldStates: [state] };

        await action.onKeyDown(fakeEvent("action-1", settings) as any);
        await action.onKeyUp(fakeEvent("action-1", settings) as any);

        expect(mockReleaseBinding).not.toHaveBeenCalled();
      });

      it.each(cases)("should auto-release after 1.5 seconds (state=$state)", async ({ state }) => {
        primeTelemetry(action, state);

        await action.onKeyDown(fakeEvent("action-1", { control: "enter-exit-tow", autoHoldStates: [state] }) as any);

        expect(mockReleaseBinding).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1500);

        expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
      });

      it.each(cases)("should not release before 1.5 seconds (state=$state)", async ({ state }) => {
        primeTelemetry(action, state);

        await action.onKeyDown(fakeEvent("action-1", { control: "enter-exit-tow", autoHoldStates: [state] }) as any);

        await vi.advanceTimersByTimeAsync(1000);

        expect(mockReleaseBinding).not.toHaveBeenCalled();
      });

      it.each(cases)("should cancel timer and release on second press (state=$state)", async ({ state }) => {
        primeTelemetry(action, state);
        const settings = { control: "enter-exit-tow", autoHoldStates: [state] };

        await action.onKeyDown(fakeEvent("action-1", settings) as any);

        expect(mockHoldBinding).toHaveBeenCalledTimes(1);

        await action.onKeyDown(fakeEvent("action-1", settings) as any);

        expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
        expect(mockHoldBinding).toHaveBeenCalledTimes(1);
      });

      it.each(cases)("should not double-release after cancel+timer expiration (state=$state)", async ({ state }) => {
        primeTelemetry(action, state);
        const settings = { control: "enter-exit-tow", autoHoldStates: [state] };

        await action.onKeyDown(fakeEvent("action-1", settings) as any);
        await action.onKeyDown(fakeEvent("action-1", settings) as any);

        mockReleaseBinding.mockClear();

        await vi.advanceTimersByTimeAsync(2000);

        expect(mockReleaseBinding).not.toHaveBeenCalled();
      });

      it("should work via dialDown/dialUp as well", async () => {
        primeTelemetry(action, "tow");
        const settings = { control: "enter-exit-tow", autoHoldStates: ["tow"] };

        await action.onDialDown(fakeEvent("action-1", settings) as any);

        expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlEnterExitTow");

        await action.onDialUp(fakeEvent("action-1", settings) as any);

        expect(mockReleaseBinding).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1500);

        expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
      });

      it("should handle independent timers across action contexts", async () => {
        primeTelemetry(action, "tow");
        const settings = { control: "enter-exit-tow", autoHoldStates: ["tow"] };

        await action.onKeyDown(fakeEvent("action-1", settings) as any);
        await action.onKeyDown(fakeEvent("action-2", settings) as any);

        expect(mockHoldBinding).toHaveBeenCalledTimes(2);

        await action.onKeyDown(fakeEvent("action-1", settings) as any);

        expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
        expect(mockReleaseBinding).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1500);

        expect(mockReleaseBinding).toHaveBeenCalledWith("action-2");
        expect(mockReleaseBinding).toHaveBeenCalledTimes(2);
      });

      it("should ignore auto-hold when state is enter-car (instant action)", async () => {
        primeTelemetry(action, "enter-car");
        const settings = {
          control: "enter-exit-tow",
          autoHoldStates: ["exit-car", "reset-to-pits", "tow"],
        };

        await action.onKeyDown(fakeEvent("action-1", settings) as any);

        expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlEnterExitTow");
        expect(action["autoHoldTimers"].has("action-1")).toBe(false);

        await action.onKeyUp(fakeEvent("action-1", settings) as any);

        expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
      });

      it("should ignore auto-hold when current state is not in autoHoldStates", async () => {
        primeTelemetry(action, "exit-car");
        // Only tow is selected; active state is exit-car
        const settings = { control: "enter-exit-tow", autoHoldStates: ["tow"] };

        await action.onKeyDown(fakeEvent("action-1", settings) as any);

        expect(action["autoHoldTimers"].has("action-1")).toBe(false);

        await action.onKeyUp(fakeEvent("action-1", settings) as any);

        expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
      });
    });

    describe("cleanup on disappear", () => {
      let action: CarControl;

      beforeEach(() => {
        vi.useFakeTimers();
        action = new CarControl();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("should clear timer and release binding on disappear", async () => {
        primeTelemetry(action, "tow");
        const settings = { control: "enter-exit-tow", autoHoldStates: ["tow"] };

        await action.onKeyDown(fakeEvent("action-1", settings) as any);

        expect(action["autoHoldTimers"].has("action-1")).toBe(true);

        await action.onWillDisappear(fakeEvent("action-1", settings) as any);

        expect(action["autoHoldTimers"].has("action-1")).toBe(false);
        expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");

        mockReleaseBinding.mockClear();

        await vi.advanceTimersByTimeAsync(2000);

        expect(mockReleaseBinding).not.toHaveBeenCalled();
      });
    });
  });
});
