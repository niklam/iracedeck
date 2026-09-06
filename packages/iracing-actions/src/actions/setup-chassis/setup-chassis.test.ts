import { getDualPressDirections } from "@iracedeck/deck-core";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  blackBoxForSetting,
  generateSetupChassisSvg,
  migrateLegacySpringIds,
  parseSetupChassisSettings,
  SETUP_CHASSIS_GLOBAL_KEYS,
  SetupChassis,
} from "./setup-chassis.js";

// Convenience handle so dual-press tests can switch the live tap direction the same
// way the runtime does (via the @iracedeck/deck-core getDualPressDirections reader).
const mockGetDualPressDirections = getDualPressDirections as unknown as ReturnType<typeof vi.fn>;

const { mockTapBinding, mockTapBindingSequence } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockTapBindingSequence: vi.fn().mockResolvedValue(true),
}));

vi.mock("@iracedeck/icons/setup-chassis/differential-entry-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">differential-entry-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/differential-entry-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">differential-entry-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/differential-exit-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">differential-exit-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/differential-exit-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">differential-exit-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/differential-middle-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">differential-middle-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/differential-middle-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">differential-middle-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/differential-preload-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">differential-preload-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/differential-preload-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">differential-preload-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/front-arb-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">front-arb-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/front-arb-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">front-arb-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/lr-spring-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">lr-spring-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/lr-spring-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">lr-spring-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/lf-shock-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">lf-shock-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/lf-shock-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">lf-shock-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/lr-shock-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">lr-shock-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/lr-shock-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">lr-shock-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/power-steering-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">power-steering-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/power-steering-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">power-steering-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/rear-arb-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rear-arb-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/rear-arb-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rear-arb-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/rf-shock-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rf-shock-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/rf-shock-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rf-shock-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/rr-spring-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rr-spring-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/rr-spring-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rr-spring-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/rr-shock-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rr-shock-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-chassis/rr-shock-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rr-shock-increase {{mainLabel}} {{subLabel}}</svg>',
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
      tapBindingSequence = mockTapBindingSequence;
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
    // Dial-surface deck-core exports (#800) — onGlobalSettingsChange runs at
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

function mockTelemetry(action: SetupChassis, telemetry: Partial<TelemetryData>): void {
  vi.mocked(action["sdkController"].getCurrentTelemetry).mockReturnValue(telemetry as TelemetryData);
}

describe("SetupChassis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SETUP_CHASSIS_GLOBAL_KEYS", () => {
    it("should have correct mapping for differential-preload-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-preload-increase"]).toBe(
        "setupChassisDifferentialPreloadIncrease",
      );
    });

    it("should have correct mapping for differential-preload-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-preload-decrease"]).toBe(
        "setupChassisDifferentialPreloadDecrease",
      );
    });

    it("should have correct mapping for differential-entry-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-entry-increase"]).toBe("setupChassisDifferentialEntryIncrease");
    });

    it("should have correct mapping for differential-entry-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-entry-decrease"]).toBe("setupChassisDifferentialEntryDecrease");
    });

    it("should have correct mapping for differential-middle-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-middle-increase"]).toBe("setupChassisDifferentialMiddleIncrease");
    });

    it("should have correct mapping for differential-middle-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-middle-decrease"]).toBe("setupChassisDifferentialMiddleDecrease");
    });

    it("should have correct mapping for differential-exit-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-exit-increase"]).toBe("setupChassisDifferentialExitIncrease");
    });

    it("should have correct mapping for differential-exit-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["differential-exit-decrease"]).toBe("setupChassisDifferentialExitDecrease");
    });

    it("should have correct mapping for front-arb-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["front-arb-increase"]).toBe("setupChassisFrontArbIncrease");
    });

    it("should have correct mapping for front-arb-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["front-arb-decrease"]).toBe("setupChassisFrontArbDecrease");
    });

    it("should have correct mapping for rear-arb-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rear-arb-increase"]).toBe("setupChassisRearArbIncrease");
    });

    it("should have correct mapping for rear-arb-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rear-arb-decrease"]).toBe("setupChassisRearArbDecrease");
    });

    it("should have correct mapping for lr-spring-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["lr-spring-increase"]).toBe("setupChassisLrSpringIncrease");
    });

    it("should have correct mapping for lr-spring-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["lr-spring-decrease"]).toBe("setupChassisLrSpringDecrease");
    });

    it("should have correct mapping for rr-spring-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rr-spring-increase"]).toBe("setupChassisRrSpringIncrease");
    });

    it("should have correct mapping for rr-spring-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rr-spring-decrease"]).toBe("setupChassisRrSpringDecrease");
    });

    it("should have correct mapping for lf-shock-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["lf-shock-increase"]).toBe("setupChassisLfShockIncrease");
    });

    it("should have correct mapping for lf-shock-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["lf-shock-decrease"]).toBe("setupChassisLfShockDecrease");
    });

    it("should have correct mapping for rf-shock-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rf-shock-increase"]).toBe("setupChassisRfShockIncrease");
    });

    it("should have correct mapping for rf-shock-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rf-shock-decrease"]).toBe("setupChassisRfShockDecrease");
    });

    it("should have correct mapping for lr-shock-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["lr-shock-increase"]).toBe("setupChassisLrShockIncrease");
    });

    it("should have correct mapping for lr-shock-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["lr-shock-decrease"]).toBe("setupChassisLrShockDecrease");
    });

    it("should have correct mapping for rr-shock-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rr-shock-increase"]).toBe("setupChassisRrShockIncrease");
    });

    it("should have correct mapping for rr-shock-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["rr-shock-decrease"]).toBe("setupChassisRrShockDecrease");
    });

    it("should have correct mapping for power-steering-increase", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["power-steering-increase"]).toBe("setupChassisPowerSteeringIncrease");
    });

    it("should have correct mapping for power-steering-decrease", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["power-steering-decrease"]).toBe("setupChassisPowerSteeringDecrease");
    });

    it("should have correct mappings for weight-jacker dual-press targets (issue #540)", () => {
      expect(SETUP_CHASSIS_GLOBAL_KEYS["weight-jacker-left-increase"]).toBe("setupChassisWeightJackerLeftIncrease");
      expect(SETUP_CHASSIS_GLOBAL_KEYS["weight-jacker-left-decrease"]).toBe("setupChassisWeightJackerLeftDecrease");
      expect(SETUP_CHASSIS_GLOBAL_KEYS["weight-jacker-right-increase"]).toBe("setupChassisWeightJackerRightIncrease");
      expect(SETUP_CHASSIS_GLOBAL_KEYS["weight-jacker-right-decrease"]).toBe("setupChassisWeightJackerRightDecrease");
    });

    it("should have exactly 30 entries (26 chassis adjust + 4 weight-jacker dual-press targets)", () => {
      expect(Object.keys(SETUP_CHASSIS_GLOBAL_KEYS)).toHaveLength(30);
    });
  });

  describe("generateSetupChassisSvg", () => {
    it("should generate a valid data URI for differential-preload increase", () => {
      const result = generateSetupChassisSvg(
        parseSetupChassisSettings({ setting: "differential-preload", direction: "increase" }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for front-arb increase", () => {
      const result = generateSetupChassisSvg(
        parseSetupChassisSettings({ setting: "front-arb", direction: "increase" }),
      );

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for lf-shock decrease", () => {
      const result = generateSetupChassisSvg(parseSetupChassisSettings({ setting: "lf-shock", direction: "decrease" }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all setting + direction combinations", () => {
      const settings = [
        "differential-preload",
        "differential-entry",
        "differential-middle",
        "differential-exit",
        "front-arb",
        "rear-arb",
        "lr-spring",
        "rr-spring",
        "lf-shock",
        "rf-shock",
        "lr-shock",
        "rr-shock",
        "power-steering",
      ] as const;
      const directions = ["increase", "decrease"] as const;

      for (const setting of settings) {
        for (const direction of directions) {
          const result = generateSetupChassisSvg(parseSetupChassisSettings({ setting, direction }));
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different settings", () => {
      const diffPreload = generateSetupChassisSvg(
        parseSetupChassisSettings({ setting: "differential-preload", direction: "increase" }),
      );
      const lfShock = generateSetupChassisSvg(
        parseSetupChassisSettings({ setting: "lf-shock", direction: "increase" }),
      );

      expect(diffPreload).not.toBe(lfShock);
    });

    it("should produce different icons for increase vs decrease", () => {
      const increase = generateSetupChassisSvg(
        parseSetupChassisSettings({ setting: "differential-preload", direction: "increase" }),
      );
      const decrease = generateSetupChassisSvg(
        parseSetupChassisSettings({ setting: "differential-preload", direction: "decrease" }),
      );

      expect(increase).not.toBe(decrease);
    });

    it("should produce different icons for increase vs decrease on all settings", () => {
      const settings = [
        "differential-preload",
        "differential-entry",
        "differential-middle",
        "differential-exit",
        "front-arb",
        "rear-arb",
        "lr-spring",
        "rr-spring",
        "lf-shock",
        "rf-shock",
        "lr-shock",
        "rr-shock",
        "power-steering",
      ] as const;

      for (const setting of settings) {
        const increase = generateSetupChassisSvg(parseSetupChassisSettings({ setting, direction: "increase" }));
        const decrease = generateSetupChassisSvg(parseSetupChassisSettings({ setting, direction: "decrease" }));
        expect(increase).not.toBe(decrease);
      }
    });

    it("should include correct labels for differential-preload increase", () => {
      const result = generateSetupChassisSvg(
        parseSetupChassisSettings({ setting: "differential-preload", direction: "increase" }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("DIFF PRELOAD");
      expect(decoded).not.toContain("INCREASE");
    });

    it("should include correct labels for power-steering decrease", () => {
      const result = generateSetupChassisSvg(
        parseSetupChassisSettings({ setting: "power-steering", direction: "decrease" }),
      );
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("PWR STEER");
      expect(decoded).not.toContain("DECREASE");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        "differential-preload": {
          increase: { line1: "DIFF PRELOAD", line2: "DIFF PRELOAD</svg>" },
          decrease: { line1: "DIFF PRELOAD", line2: "DIFF PRELOAD</svg>" },
        },
        "differential-entry": {
          increase: { line1: "DIFF ENTRY", line2: "DIFF ENTRY</svg>" },
          decrease: { line1: "DIFF ENTRY", line2: "DIFF ENTRY</svg>" },
        },
        "differential-middle": {
          increase: { line1: "DIFF MIDDLE", line2: "DIFF MIDDLE</svg>" },
          decrease: { line1: "DIFF MIDDLE", line2: "DIFF MIDDLE</svg>" },
        },
        "differential-exit": {
          increase: { line1: "DIFF EXIT", line2: "DIFF EXIT</svg>" },
          decrease: { line1: "DIFF EXIT", line2: "DIFF EXIT</svg>" },
        },
        "front-arb": {
          increase: { line1: "FRONT ARB", line2: "FRONT ARB</svg>" },
          decrease: { line1: "FRONT ARB", line2: "FRONT ARB</svg>" },
        },
        "rear-arb": {
          increase: { line1: "REAR ARB", line2: "REAR ARB</svg>" },
          decrease: { line1: "REAR ARB", line2: "REAR ARB</svg>" },
        },
        "lr-spring": {
          increase: { line1: "LR SPRING", line2: "LR SPRING</svg>" },
          decrease: { line1: "LR SPRING", line2: "LR SPRING</svg>" },
        },
        "rr-spring": {
          increase: { line1: "RR SPRING", line2: "RR SPRING</svg>" },
          decrease: { line1: "RR SPRING", line2: "RR SPRING</svg>" },
        },
        "lf-shock": {
          increase: { line1: "LF SHOCK", line2: "LF SHOCK</svg>" },
          decrease: { line1: "LF SHOCK", line2: "LF SHOCK</svg>" },
        },
        "rf-shock": {
          increase: { line1: "RF SHOCK", line2: "RF SHOCK</svg>" },
          decrease: { line1: "RF SHOCK", line2: "RF SHOCK</svg>" },
        },
        "lr-shock": {
          increase: { line1: "LR SHOCK", line2: "LR SHOCK</svg>" },
          decrease: { line1: "LR SHOCK", line2: "LR SHOCK</svg>" },
        },
        "rr-shock": {
          increase: { line1: "RR SHOCK", line2: "RR SHOCK</svg>" },
          decrease: { line1: "RR SHOCK", line2: "RR SHOCK</svg>" },
        },
        "power-steering": {
          increase: { line1: "PWR STEER", line2: "PWR STEER</svg>" },
          decrease: { line1: "PWR STEER", line2: "PWR STEER</svg>" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupChassisSvg(
            parseSetupChassisSettings({
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
    let action: SetupChassis;

    beforeEach(() => {
      action = new SetupChassis();
    });

    it("should call tapGlobalBinding on keyDown for differential-preload increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "differential-preload", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisDifferentialPreloadIncrease");
    });

    it("should call tapGlobalBinding for differential-preload decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "differential-preload", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisDifferentialPreloadDecrease");
    });

    it("should call tapGlobalBinding for front-arb increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "front-arb", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisFrontArbIncrease");
    });

    it("should call tapGlobalBinding for lf-shock increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "lf-shock", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisLfShockIncrease");
    });

    it("should call tapGlobalBinding for power-steering decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "power-steering", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisPowerSteeringDecrease");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "differential-preload", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisDifferentialPreloadIncrease");
    });

    it("should call tapGlobalBinding for all directional settings", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "lf-shock", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisLfShockDecrease");
    });
  });

  // Dial-surface behavior is exercised by setup-chassis-dial-surface.test.ts (#800);
  // the former "encoder behavior" block tested the pre-dial-surface coupling.

  describe("view sub-modes (issue #541)", () => {
    let action: SetupChassis;

    beforeEach(() => {
      action = new SetupChassis();
      mockTelemetry(action, { dcDiffEntry: 4, dcWeightJackerRight: 0.06 });
    });

    it("renders the formatted telemetry value for a View setting", async () => {
      const ev = fakeEvent("action-1", { setting: "view-diff-entry" }) as any;
      await action.onWillAppear(ev);
      const [[, image]] = vi.mocked(action["setKeyImage"]).mock.calls;
      const svg = decodeURIComponent(image as string);
      expect(svg).toContain("4");
    });

    it("renders the signed-percent formatter for weight-jacker-right", async () => {
      const ev = fakeEvent("action-1", { setting: "view-weight-jacker-right" }) as any;
      await action.onWillAppear(ev);
      const [[, image]] = vi.mocked(action["setKeyImage"]).mock.calls;
      const svg = decodeURIComponent(image as string);
      expect(svg).toContain("+6%");
    });

    it("does not fire a binding when a View setting is pressed", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-power-steering" }) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("dual-press dispatch (issue #540)", () => {
    let action: SetupChassis;

    beforeEach(() => {
      action = new SetupChassis();
    });

    it("records keyDown on View + dual-press enabled and does not fire on its own", async () => {
      const tracker = (action as any).dualPress as { recordKeyDown: ReturnType<typeof vi.fn> };
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-diff-preload", dualPressEnabled: true }) as any);

      expect(tracker.recordKeyDown).toHaveBeenCalledWith("action-1");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("does not record keyDown when dual-press is disabled", async () => {
      const tracker = (action as any).dualPress as { recordKeyDown: ReturnType<typeof vi.fn> };
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-diff-preload", dualPressEnabled: false }) as any);

      expect(tracker.recordKeyDown).not.toHaveBeenCalled();
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("fires the increase binding on a short press with tap-increases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue("increase");

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-diff-preload", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisDifferentialPreloadIncrease");
    });

    it("fires the decrease binding on a long press with tap-increases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue("decrease");

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-diff-preload", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisDifferentialPreloadDecrease");
    });

    it("inverts directions when the global dualPressDirections is tap-decreases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-decreases");
      // The mock passes the chosen outcome through computeOutcome unchanged, so
      // we set the return based on what the tap direction should be.
      tracker.computeOutcome.mockImplementation((_id: string, tap: string, _long: string) => tap);

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-diff-preload", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisDifferentialPreloadDecrease");
    });

    it("does not fire when the tracker returns undefined (stray key-up)", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue(undefined);

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-diff-preload", dualPressEnabled: true }) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("does not fire when dual-press is disabled on key-up", async () => {
      const tracker = (action as any).dualPress as {
        computeOutcome: ReturnType<typeof vi.fn>;
        clear: ReturnType<typeof vi.fn>;
      };

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-diff-preload", dualPressEnabled: false }) as any);

      expect(tracker.computeOutcome).not.toHaveBeenCalled();
      expect(tracker.clear).toHaveBeenCalledWith("action-1");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("clears tracker on key-up for non-View settings (so future View presses start clean)", async () => {
      const tracker = (action as any).dualPress as { clear: ReturnType<typeof vi.fn> };

      await action.onKeyUp(fakeEvent("action-1", { setting: "differential-preload", direction: "increase" }) as any);

      expect(tracker.clear).toHaveBeenCalledWith("action-1");
    });

    it("clears tracker on willDisappear", async () => {
      const tracker = (action as any).dualPress as { clear: ReturnType<typeof vi.fn> };

      await action.onWillDisappear({
        action: { id: "action-1" },
        payload: { settings: { setting: "view-diff-preload" } },
      } as any);

      expect(tracker.clear).toHaveBeenCalledWith("action-1");
    });
  });

  describe("paired key styles", () => {
    it("parses keyStyle/pairPosition with defaults and catch-degradation", () => {
      const parsed = parseSetupChassisSettings({ setting: "differential-preload" });
      expect(parsed.keyStyle).toBe("legacy");
      expect(parsed.pairPosition).toBe("auto");
      const degraded = parseSetupChassisSettings({ setting: "differential-preload", keyStyle: "hologram" });
      expect(degraded.keyStyle).toBe("legacy");
      expect(degraded.setting).toBe("differential-preload"); // catch keeps the rest of the parse alive
    });
  });

  describe("legacy spring id migration (#953)", () => {
    it("maps persisted left-spring to lr-spring at parse time", () => {
      const parsed = parseSetupChassisSettings({ setting: "left-spring", direction: "decrease" });

      expect(parsed.setting).toBe("lr-spring");
      expect(parsed.direction).toBe("decrease");
    });

    it("maps persisted right-spring to rr-spring at parse time", () => {
      expect(parseSetupChassisSettings({ setting: "right-spring" }).setting).toBe("rr-spring");
    });

    it("maps a persisted legacy dial.setting", () => {
      expect(parseSetupChassisSettings({ dial: { setting: "right-spring" } }).dial.setting).toBe("rr-spring");
    });

    it("returns a migrated object preserving other fields, and null when nothing is legacy", () => {
      expect(migrateLegacySpringIds({ setting: "left-spring", direction: "increase", keyStyle: "split" })).toEqual({
        setting: "lr-spring",
        direction: "increase",
        keyStyle: "split",
      });
      expect(migrateLegacySpringIds({ dial: { setting: "right-spring", pressAction: "none" } })).toEqual({
        dial: { setting: "rr-spring", pressAction: "none" },
      });
      expect(migrateLegacySpringIds({ setting: "lr-spring" })).toBeNull();
      expect(migrateLegacySpringIds({ setting: "differential-preload" })).toBeNull();
      expect(migrateLegacySpringIds(undefined)).toBeNull();
    });

    it("persists the migrated keypad setting on willAppear", async () => {
      const action = new SetupChassis();
      const ev = fakeEvent("action-1", { setting: "left-spring", direction: "increase", keyStyle: "legacy" });
      (ev.action as Record<string, unknown>).setSettings = vi.fn();

      await action.onWillAppear(ev as any);

      expect((ev.action as unknown as { setSettings: ReturnType<typeof vi.fn> }).setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ setting: "lr-spring", direction: "increase" }),
      );
    });
  });

  describe("spring offset View sub-modes (#953)", () => {
    let action: SetupChassis;

    beforeEach(() => {
      action = new SetupChassis();
    });

    it("accepts the new View ids in the settings enum", () => {
      expect(parseSetupChassisSettings({ setting: "view-lr-spring-offset" }).setting).toBe("view-lr-spring-offset");
      expect(parseSetupChassisSettings({ setting: "view-rr-spring-offset" }).setting).toBe("view-rr-spring-offset");
    });

    it("renders the pending pit-stop offset for the LR spring View", async () => {
      mockTelemetry(action, { dpWeightJackerLeft: 2.54, DisplayUnits: 1 });

      await action.onWillAppear(fakeEvent("action-1", { setting: "view-lr-spring-offset" }) as any);

      const [[, image]] = vi.mocked(action["setKeyImage"]).mock.calls;
      const svg = decodeURIComponent(image as string);
      expect(svg).toContain("3 mm");
    });

    it("dispatches dual-press to the renamed spring bindings", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue("increase");

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-rr-spring-offset", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisRrSpringIncrease");
    });
  });

  describe("show black box on value change (#953)", () => {
    it("maps each mode to the box its value lives in", () => {
      expect(blackBoxForSetting("lr-spring")).toBe("pit-stop");
      expect(blackBoxForSetting("rr-spring")).toBe("pit-stop");
      expect(blackBoxForSetting("rr-shock")).toBe("pit-stop");
      expect(blackBoxForSetting("view-rr-spring-offset")).toBe("pit-stop");
      expect(blackBoxForSetting("differential-preload")).toBe("in-car");
      expect(blackBoxForSetting("view-diff-entry")).toBe("in-car");
      expect(blackBoxForSetting("view-weight-jacker-left")).toBe("in-car");
      expect(blackBoxForSetting("power-steering")).toBe("in-car");
    });

    it("shows the Pit Stop box once on key down when enabled", async () => {
      const action = new SetupChassis();

      await action.onKeyDown(
        fakeEvent("action-1", { setting: "lr-spring", direction: "increase", showBlackBox: true }) as any,
      );

      expect(mockTapBindingSequence).toHaveBeenCalledWith(["blackBoxLapTiming", "blackBoxPitStop"], 0);
      expect(mockTapBindingSequence).toHaveBeenCalledTimes(1);
      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisLrSpringIncrease");
    });

    it("shows the In-Car box for an in-car adjustment mode", async () => {
      const action = new SetupChassis();

      await action.onKeyDown(
        fakeEvent("action-1", { setting: "front-arb", direction: "decrease", showBlackBox: true }) as any,
      );

      expect(mockTapBindingSequence).toHaveBeenCalledWith(["blackBoxLapTiming", "blackBoxInCar"], 0);
    });

    it("does nothing when the checkbox is off", async () => {
      const action = new SetupChassis();

      await action.onKeyDown(fakeEvent("action-1", { setting: "lr-spring", direction: "increase" }) as any);

      expect(mockTapBindingSequence).not.toHaveBeenCalled();
    });

    it("shows the box on a dual-press dispatch from a View key", async () => {
      const action = new SetupChassis();
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue("increase");

      await action.onKeyUp(
        fakeEvent("action-1", {
          setting: "view-rr-spring-offset",
          dualPressEnabled: true,
          showBlackBox: true,
        }) as any,
      );

      expect(mockTapBindingSequence).toHaveBeenCalledWith(["blackBoxLapTiming", "blackBoxPitStop"], 0);
      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisRrSpringIncrease");
    });

    it("does not re-show on hold-to-repeat iterations", async () => {
      vi.useFakeTimers();
      const action = new SetupChassis();
      const ev = fakeEvent("action-1", {
        setting: "lr-spring",
        direction: "increase",
        keyStyle: "split",
        showBlackBox: true,
      });

      await action.onKeyDown(ev as any);
      await vi.advanceTimersByTimeAsync(500 + 150 * 3 + 20);
      expect(mockTapBinding.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(mockTapBindingSequence).toHaveBeenCalledTimes(1);

      await action.onKeyUp(ev as any);
      vi.useRealTimers();
    });
  });

  describe("units preference (#953)", () => {
    it("parses the keypad units setting with an auto default and degradation", () => {
      expect(parseSetupChassisSettings({}).units).toBe("auto");
      expect(parseSetupChassisSettings({ units: "imperial" }).units).toBe("imperial");
      const degraded = parseSetupChassisSettings({ setting: "lr-spring", units: "furlongs" });
      expect(degraded.units).toBe("auto");
      expect(degraded.setting).toBe("lr-spring");
    });

    it("forces the spring View to imperial on a metric-display sim", async () => {
      const action = new SetupChassis();
      mockTelemetry(action, { dpWeightJackerLeft: 3.175, DisplayUnits: 1 });

      await action.onWillAppear(fakeEvent("action-1", { setting: "view-lr-spring-offset", units: "imperial" }) as any);

      const [[, image]] = vi.mocked(action["setKeyImage"]).mock.calls;
      const svg = decodeURIComponent(image as string);
      expect(svg).toContain('0.125"');
    });

    it("keeps following the sim's display units on auto", async () => {
      const action = new SetupChassis();
      mockTelemetry(action, { dpWeightJackerLeft: 3.175, DisplayUnits: 1 });

      await action.onWillAppear(fakeEvent("action-1", { setting: "view-lr-spring-offset" }) as any);

      const [[, image]] = vi.mocked(action["setKeyImage"]).mock.calls;
      const svg = decodeURIComponent(image as string);
      expect(svg).toContain("3 mm");
    });
  });

  describe("hold-to-repeat wiring", () => {
    it("arms repeat for a paired-style key and fires repeatedly while held", async () => {
      vi.useFakeTimers();
      const action = new SetupChassis();
      const ev = fakeEvent("action-1", { setting: "differential-preload", direction: "increase", keyStyle: "split" });

      await action.onKeyDown(ev as any);
      expect(mockTapBinding).toHaveBeenCalledTimes(1); // immediate first step

      await vi.advanceTimersByTimeAsync(500 + 150 * 3 + 20); // hold threshold + 3 intervals
      expect(mockTapBinding.mock.calls.length).toBeGreaterThanOrEqual(3);

      await action.onKeyUp(
        fakeEvent("action-1", { setting: "differential-preload", direction: "increase", keyStyle: "split" }) as any,
      );
      const after = mockTapBinding.mock.calls.length;

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockTapBinding.mock.calls.length).toBe(after); // stopped on release

      vi.useRealTimers();
    });

    it("does not arm repeat for a legacy-style key", async () => {
      vi.useFakeTimers();
      const action = new SetupChassis();

      await action.onKeyDown(
        fakeEvent("action-1", { setting: "differential-preload", direction: "increase", keyStyle: "legacy" }) as any,
      );
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockTapBinding).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });
});
