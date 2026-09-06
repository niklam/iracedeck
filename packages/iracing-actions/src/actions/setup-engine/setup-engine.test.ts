import { getDualPressDirections } from "@iracedeck/deck-core";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSetupEngineSvg, parseSetupEngineSettings, SETUP_ENGINE_GLOBAL_KEYS } from "./setup-engine.js";
import { SetupEngine } from "./setup-engine.js";

// Convenience handle so dual-press tests can switch the live tap direction the same
// way the runtime does (via the @iracedeck/deck-core getDualPressDirections reader).
const mockGetDualPressDirections = getDualPressDirections as unknown as ReturnType<typeof vi.fn>;

const { mockTapBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@iracedeck/icons/setup-engine/engine-power-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">engine-power-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/engine-power-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">engine-power-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/throttle-shaping-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">throttle-shaping-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/throttle-shaping-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">throttle-shaping-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/boost-level-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">boost-level-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/boost-level-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">boost-level-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/launch-rpm-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">launch-rpm-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-engine/launch-rpm-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">launch-rpm-decrease {{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
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
      // REAL zod semantics for the extended settings schema (defaults, enum
      // validation, keyStyle/pairPosition catch-degradation) — only the
      // CommonSettings base fields are absent.
      extend: (shape: never) => z.object(shape).passthrough(),
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
      isActiveBindingMissing = vi.fn(() => false);
      isBindingMissing = vi.fn(() => false);
      async onWillAppear() {}
      async onDidReceiveSettings() {}
      async onWillDisappear() {}
    },
    DualPressTracker: class MockDualPressTracker {
      recordKeyDown = vi.fn();
      computeOutcome = vi.fn(() => undefined);
      clear = vi.fn();
      hasPending = vi.fn(() => false);
    },
    getDualPressThresholdMs: vi.fn(() => 500),
    getDualPressDirections: vi.fn(() => "tap-increases"),
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
    applyBindingWarning: vi.fn((content: string) => `${content}<warn/>`),
    // Dial-surface deck-core exports (#798) — onGlobalSettingsChange runs at
    // construction; the rest only on dial flows (keypad tests never hit them).
    onGlobalSettingsChange: vi.fn(() => vi.fn()),
    classifyDialRelease: (args: {
      pressStartMs: number;
      nowMs: number;
      rotatedWhilePressed: boolean;
      thresholdMs?: number;
    }) => {
      if (args.rotatedWhilePressed) return "push-turn";

      return args.nowMs - args.pressStartMs >= (args.thresholdMs ?? 500) ? "long" : "short";
    },
    escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
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
  };
});

/** Create a minimal fake event with the given action ID and settings. */
function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: { id: actionId, isKey: () => true, isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings },
  };
}

describe("SetupEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SETUP_ENGINE_GLOBAL_KEYS", () => {
    it("should have correct mapping for engine-power-increase", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["engine-power-increase"]).toBe("setupEngineEnginePowerIncrease");
    });

    it("should have correct mapping for engine-power-decrease", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["engine-power-decrease"]).toBe("setupEngineEnginePowerDecrease");
    });

    it("should have correct mapping for throttle-shaping-increase", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["throttle-shaping-increase"]).toBe("setupEngineThrottleShapingIncrease");
    });

    it("should have correct mapping for throttle-shaping-decrease", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["throttle-shaping-decrease"]).toBe("setupEngineThrottleShapingDecrease");
    });

    it("should have correct mapping for boost-level-increase", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["boost-level-increase"]).toBe("setupEngineBoostLevelIncrease");
    });

    it("should have correct mapping for boost-level-decrease", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["boost-level-decrease"]).toBe("setupEngineBoostLevelDecrease");
    });

    it("should have correct mapping for launch-rpm-increase", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["launch-rpm-increase"]).toBe("setupEngineLaunchRpmIncrease");
    });

    it("should have correct mapping for launch-rpm-decrease", () => {
      expect(SETUP_ENGINE_GLOBAL_KEYS["launch-rpm-decrease"]).toBe("setupEngineLaunchRpmDecrease");
    });

    it("should have exactly 8 entries", () => {
      expect(Object.keys(SETUP_ENGINE_GLOBAL_KEYS)).toHaveLength(8);
    });
  });

  describe("generateSetupEngineSvg", () => {
    it("should generate a valid data URI for engine-power increase", () => {
      const result = generateSetupEngineSvg(
        parseSetupEngineSettings({ setting: "engine-power", direction: "increase" }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for throttle-shaping increase", () => {
      const result = generateSetupEngineSvg(
        parseSetupEngineSettings({ setting: "throttle-shaping", direction: "increase" }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for boost-level decrease", () => {
      const result = generateSetupEngineSvg(
        parseSetupEngineSettings({ setting: "boost-level", direction: "decrease" }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all setting + direction combinations", () => {
      const settings = ["engine-power", "throttle-shaping", "boost-level", "launch-rpm"] as const;
      const directions = ["increase", "decrease"] as const;

      for (const setting of settings) {
        for (const direction of directions) {
          const result = generateSetupEngineSvg(parseSetupEngineSettings({ setting, direction }));
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different settings", () => {
      const enginePower = generateSetupEngineSvg(
        parseSetupEngineSettings({ setting: "engine-power", direction: "increase" }),
      );
      const boostLevel = generateSetupEngineSvg(
        parseSetupEngineSettings({ setting: "boost-level", direction: "increase" }),
      );

      expect(enginePower).not.toBe(boostLevel);
    });

    it("should produce different icons for increase vs decrease", () => {
      const increase = generateSetupEngineSvg(
        parseSetupEngineSettings({ setting: "engine-power", direction: "increase" }),
      );
      const decrease = generateSetupEngineSvg(
        parseSetupEngineSettings({ setting: "engine-power", direction: "decrease" }),
      );

      expect(increase).not.toBe(decrease);
    });

    it("should produce different icons for increase vs decrease on all settings", () => {
      const settings = ["engine-power", "throttle-shaping", "boost-level", "launch-rpm"] as const;

      for (const setting of settings) {
        const increase = generateSetupEngineSvg(parseSetupEngineSettings({ setting, direction: "increase" }));
        const decrease = generateSetupEngineSvg(parseSetupEngineSettings({ setting, direction: "decrease" }));
        expect(increase).not.toBe(decrease);
      }
    });

    it("should include correct labels for engine-power increase", () => {
      const result = generateSetupEngineSvg(
        parseSetupEngineSettings({ setting: "engine-power", direction: "increase" }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("ENG POWER");
      expect(decoded).not.toContain("INCREASE");
    });

    it("should include correct labels for throttle-shaping decrease", () => {
      const result = generateSetupEngineSvg(
        parseSetupEngineSettings({ setting: "throttle-shaping", direction: "decrease" }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("THROTTLE");
      expect(decoded).not.toContain("DECREASE");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        "engine-power": {
          increase: { line1: "ENG POWER", line2: "ENG POWER</svg>" },
          decrease: { line1: "ENG POWER", line2: "ENG POWER</svg>" },
        },
        "throttle-shaping": {
          increase: { line1: "THROTTLE", line2: "THROTTLE</svg>" },
          decrease: { line1: "THROTTLE", line2: "THROTTLE</svg>" },
        },
        "boost-level": {
          increase: { line1: "BOOST", line2: "BOOST</svg>" },
          decrease: { line1: "BOOST", line2: "BOOST</svg>" },
        },
        "launch-rpm": {
          increase: { line1: "LAUNCH RPM", line2: "LAUNCH RPM</svg>" },
          decrease: { line1: "LAUNCH RPM", line2: "LAUNCH RPM</svg>" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupEngineSvg(
            parseSetupEngineSettings({
              setting: setting as any,
              direction: direction as any,
            }),
          );
          const decoded = decodeURIComponent(result);

          expect(decoded).toContain(labels.line1);
          expect(decoded).toContain(labels.line2);
        }
      }
    });
  });

  describe("tap behavior", () => {
    let action: SetupEngine;

    beforeEach(() => {
      action = new SetupEngine();
    });

    it("should call tapGlobalBinding on keyDown for engine-power increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "engine-power", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupEngineEnginePowerIncrease");
    });

    it("should call tapGlobalBinding for engine-power decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "engine-power", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupEngineEnginePowerDecrease");
    });

    it("should call tapGlobalBinding for throttle-shaping increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "throttle-shaping", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupEngineThrottleShapingIncrease");
    });

    it("should call tapGlobalBinding for boost-level increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "boost-level", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupEngineBoostLevelIncrease");
    });

    it("should call tapGlobalBinding for launch-rpm decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "launch-rpm", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupEngineLaunchRpmDecrease");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "engine-power", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupEngineEnginePowerIncrease");
    });

    it("should call tapGlobalBinding for all directional settings", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "boost-level", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupEngineBoostLevelDecrease");
    });
  });

  // Dial-surface behavior is exercised by setup-engine-dial-surface.test.ts (#798);
  // the former "encoder behavior" block tested the pre-dial-surface coupling.

  describe("view sub-modes (issue #541)", () => {
    let action: SetupEngine;

    beforeEach(() => {
      action = new SetupEngine();
      vi.mocked(action["sdkController"].getCurrentTelemetry).mockReturnValue({ dcEnginePower: 7 } as TelemetryData);
    });

    it("renders the formatted telemetry value for a View setting", async () => {
      const ev = fakeEvent("action-1", { setting: "view-engine-power" }) as any;
      await action.onWillAppear(ev);
      const [[, image]] = vi.mocked(action["setKeyImage"]).mock.calls;
      const svg = decodeURIComponent(image as string);
      expect(svg).toContain("7");
    });

    it("does not fire a binding when a View setting is pressed", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-throttle-shape" }) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("dual-press dispatch (issue #540)", () => {
    let action: SetupEngine;

    beforeEach(() => {
      action = new SetupEngine();
    });

    it("records keyDown on View + dual-press enabled and does not fire on its own", async () => {
      const tracker = (action as any).dualPress as { recordKeyDown: ReturnType<typeof vi.fn> };
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-engine-power", dualPressEnabled: true }) as any);

      expect(tracker.recordKeyDown).toHaveBeenCalledWith("action-1");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("does not record keyDown when dual-press is disabled", async () => {
      const tracker = (action as any).dualPress as { recordKeyDown: ReturnType<typeof vi.fn> };
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-engine-power", dualPressEnabled: false }) as any);

      expect(tracker.recordKeyDown).not.toHaveBeenCalled();
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("fires the increase binding on a short press with tap-increases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue("increase");

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-engine-power", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupEngineEnginePowerIncrease");
    });

    it("fires the decrease binding on a long press with tap-increases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue("decrease");

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-engine-power", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupEngineEnginePowerDecrease");
    });

    it("inverts directions when the global dualPressDirections is tap-decreases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-decreases");
      // The mock passes the chosen outcome through computeOutcome unchanged, so
      // we set the return based on what the tap direction should be.
      tracker.computeOutcome.mockImplementation((_id: string, tap: string, _long: string) => tap);

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-engine-power", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupEngineEnginePowerDecrease");
    });

    it("does not fire when the tracker returns undefined (stray key-up)", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue(undefined);

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-engine-power", dualPressEnabled: true }) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("does not fire when dual-press is disabled on key-up", async () => {
      const tracker = (action as any).dualPress as {
        computeOutcome: ReturnType<typeof vi.fn>;
        clear: ReturnType<typeof vi.fn>;
      };

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-engine-power", dualPressEnabled: false }) as any);

      expect(tracker.computeOutcome).not.toHaveBeenCalled();
      expect(tracker.clear).toHaveBeenCalledWith("action-1");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("clears tracker on key-up for non-View settings (so future View presses start clean)", async () => {
      const tracker = (action as any).dualPress as { clear: ReturnType<typeof vi.fn> };

      await action.onKeyUp(fakeEvent("action-1", { setting: "engine-power", direction: "increase" }) as any);

      expect(tracker.clear).toHaveBeenCalledWith("action-1");
    });

    it("clears tracker on willDisappear", async () => {
      const tracker = (action as any).dualPress as { clear: ReturnType<typeof vi.fn> };

      await action.onWillDisappear({
        action: { id: "action-1" },
        payload: { settings: { setting: "view-engine-power" } },
      } as any);

      expect(tracker.clear).toHaveBeenCalledWith("action-1");
    });
  });

  describe("paired key styles", () => {
    it("parses keyStyle/pairPosition with defaults and catch-degradation", () => {
      const parsed = parseSetupEngineSettings({ setting: "engine-power" });
      expect(parsed.keyStyle).toBe("legacy");
      expect(parsed.pairPosition).toBe("auto");
      const degraded = parseSetupEngineSettings({ setting: "engine-power", keyStyle: "hologram" });
      expect(degraded.keyStyle).toBe("legacy");
      expect(degraded.setting).toBe("engine-power"); // catch keeps the rest of the parse alive
    });
  });

  describe("hold-to-repeat wiring", () => {
    it("arms repeat for a paired-style key and fires repeatedly while held", async () => {
      vi.useFakeTimers();
      const action = new SetupEngine();
      const ev = fakeEvent("action-1", { setting: "engine-power", direction: "increase", keyStyle: "split" });

      await action.onKeyDown(ev as any);
      expect(mockTapBinding).toHaveBeenCalledTimes(1); // immediate first step

      await vi.advanceTimersByTimeAsync(500 + 150 * 3 + 20); // hold threshold + 3 intervals
      expect(mockTapBinding.mock.calls.length).toBeGreaterThanOrEqual(3);

      await action.onKeyUp(
        fakeEvent("action-1", { setting: "engine-power", direction: "increase", keyStyle: "split" }) as any,
      );
      const after = mockTapBinding.mock.calls.length;

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockTapBinding.mock.calls.length).toBe(after); // stopped on release

      vi.useRealTimers();
    });

    it("does not arm repeat for a legacy-style key", async () => {
      vi.useFakeTimers();
      const action = new SetupEngine();

      await action.onKeyDown(
        fakeEvent("action-1", { setting: "engine-power", direction: "increase", keyStyle: "legacy" }) as any,
      );
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockTapBinding).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });
});
