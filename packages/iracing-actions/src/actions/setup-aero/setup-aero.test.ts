import { getDualPressDirections } from "@iracedeck/deck-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateSetupAeroSvg, parseSetupAeroSettings, SETUP_AERO_GLOBAL_KEYS, SetupAero } from "./setup-aero.js";

// Convenience handle so dual-press tests can switch the live tap direction the same
// way the runtime does (via the @iracedeck/deck-core getDualPressDirections reader).
const mockGetDualPressDirections = getDualPressDirections as unknown as ReturnType<typeof vi.fn>;

const { mockTapBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@iracedeck/icons/setup-aero/front-wing-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">front-wing-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-aero/front-wing-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">front-wing-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-aero/qualifying-tape-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">qualifying-tape-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-aero/qualifying-tape-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">qualifying-tape-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-aero/rear-wing-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rear-wing-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-aero/rear-wing-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rear-wing-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-aero/rf-brake-attached.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rf-brake-attached {{mainLabel}} {{subLabel}}</svg>',
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
    // Dial-surface deck-core exports (#799) — onGlobalSettingsChange runs at
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

describe("SetupAero", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SETUP_AERO_GLOBAL_KEYS", () => {
    it("should have correct mapping for front-wing-increase", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["front-wing-increase"]).toBe("setupAeroFrontWingIncrease");
    });

    it("should have correct mapping for front-wing-decrease", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["front-wing-decrease"]).toBe("setupAeroFrontWingDecrease");
    });

    it("should have correct mapping for rear-wing-increase", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["rear-wing-increase"]).toBe("setupAeroRearWingIncrease");
    });

    it("should have correct mapping for rear-wing-decrease", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["rear-wing-decrease"]).toBe("setupAeroRearWingDecrease");
    });

    it("should have correct mapping for qualifying-tape-increase", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["qualifying-tape-increase"]).toBe("setupAeroQualifyingTapeIncrease");
    });

    it("should have correct mapping for qualifying-tape-decrease", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["qualifying-tape-decrease"]).toBe("setupAeroQualifyingTapeDecrease");
    });

    it("should have correct mapping for rf-brake-attached", () => {
      expect(SETUP_AERO_GLOBAL_KEYS["rf-brake-attached"]).toBe("setupAeroRfBrakeAttached");
    });

    it("should have exactly 7 entries", () => {
      expect(Object.keys(SETUP_AERO_GLOBAL_KEYS)).toHaveLength(7);
    });
  });

  describe("generateSetupAeroSvg", () => {
    it("should generate a valid data URI for rf-brake-attached", () => {
      const result = generateSetupAeroSvg({ setting: "rf-brake-attached", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for front-wing increase", () => {
      const result = generateSetupAeroSvg({ setting: "front-wing", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all setting + direction combinations", () => {
      const settings = ["front-wing", "rear-wing", "qualifying-tape", "rf-brake-attached"] as const;
      const directions = ["increase", "decrease"] as const;

      for (const setting of settings) {
        for (const direction of directions) {
          const result = generateSetupAeroSvg({ setting, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different settings", () => {
      const frontWing = generateSetupAeroSvg({ setting: "front-wing", direction: "increase" });
      const rfBrake = generateSetupAeroSvg({ setting: "rf-brake-attached", direction: "increase" });

      expect(frontWing).not.toBe(rfBrake);
    });

    it("should produce different icons for increase vs decrease on directional controls", () => {
      const increase = generateSetupAeroSvg({ setting: "front-wing", direction: "increase" });
      const decrease = generateSetupAeroSvg({ setting: "front-wing", direction: "decrease" });

      expect(increase).not.toBe(decrease);
    });

    it("should produce same icon for non-directional controls regardless of direction", () => {
      const increase = generateSetupAeroSvg({ setting: "rf-brake-attached", direction: "increase" });
      const decrease = generateSetupAeroSvg({ setting: "rf-brake-attached", direction: "decrease" });

      expect(increase).toBe(decrease);
    });

    it("should include correct labels for rf-brake-attached", () => {
      const result = generateSetupAeroSvg({ setting: "rf-brake-attached", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("RF BRAKE");
      expect(decoded).toContain("TOGGLE");
    });

    it("should include correct labels for front-wing increase", () => {
      const result = generateSetupAeroSvg({ setting: "front-wing", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FRONT WING");
      expect(decoded).not.toContain("INCREASE");
    });

    it("should include correct labels for front-wing decrease", () => {
      const result = generateSetupAeroSvg({ setting: "front-wing", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("FRONT WING");
      expect(decoded).not.toContain("DECREASE");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        "front-wing": {
          increase: { line1: "FRONT WING", line2: "FRONT WING</svg>" },
          decrease: { line1: "FRONT WING", line2: "FRONT WING</svg>" },
        },
        "rear-wing": {
          increase: { line1: "REAR WING", line2: "REAR WING</svg>" },
          decrease: { line1: "REAR WING", line2: "REAR WING</svg>" },
        },
        "qualifying-tape": {
          increase: { line1: "QUAL TAPE", line2: "QUAL TAPE</svg>" },
          decrease: { line1: "QUAL TAPE", line2: "QUAL TAPE</svg>" },
        },
        "rf-brake-attached": {
          increase: { line1: "RF BRAKE", line2: "TOGGLE" },
          decrease: { line1: "RF BRAKE", line2: "TOGGLE" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupAeroSvg({
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
    let action: SetupAero;

    beforeEach(() => {
      action = new SetupAero();
    });

    it("should call tapGlobalBinding on keyDown for rf-brake-attached", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "rf-brake-attached" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroRfBrakeAttached");
    });

    it("should call tapGlobalBinding for front-wing increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "front-wing", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroFrontWingIncrease");
    });

    it("should call tapGlobalBinding for front-wing decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "front-wing", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroFrontWingDecrease");
    });

    it("should call tapGlobalBinding for rear-wing increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "rear-wing", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroRearWingIncrease");
    });

    it("should call tapGlobalBinding for qualifying-tape decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "qualifying-tape", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroQualifyingTapeDecrease");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "rf-brake-attached" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroRfBrakeAttached");
    });

    it("should call tapGlobalBinding even when global key mapping exists", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "front-wing", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroFrontWingIncrease");
    });
  });

  // Dial-surface behavior is exercised by setup-aero-dial-surface.test.ts (#799);
  // the former "encoder behavior" block tested the pre-dial-surface coupling.

  describe("view sub-modes (issue #541)", () => {
    let action: SetupAero;

    beforeEach(() => {
      action = new SetupAero();
      (action.sdkController.getCurrentTelemetry as any).mockReturnValue({ dcFrontWing: 4, dcRearWing: 6 });
    });

    it("renders the formatted telemetry value for View Front Wing", async () => {
      const ev = fakeEvent("action-1", { setting: "view-front-wing" }) as any;
      await action.onWillAppear(ev);
      const calls = (action.setKeyImage as any).mock.calls;
      const svg = decodeURIComponent(calls[0][1] as string);
      expect(svg).toContain("4");
    });

    it("does not fire a binding when a View setting is pressed", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-rear-wing" }) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("dual-press dispatch (issue #540)", () => {
    let action: SetupAero;

    beforeEach(() => {
      action = new SetupAero();
    });

    it("records keyDown on View + dual-press enabled and does not fire on its own", async () => {
      const tracker = (action as any).dualPress as { recordKeyDown: ReturnType<typeof vi.fn> };
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-front-wing", dualPressEnabled: true }) as any);

      expect(tracker.recordKeyDown).toHaveBeenCalledWith("action-1");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("does not record keyDown when dual-press is disabled", async () => {
      const tracker = (action as any).dualPress as { recordKeyDown: ReturnType<typeof vi.fn> };
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-front-wing", dualPressEnabled: false }) as any);

      expect(tracker.recordKeyDown).not.toHaveBeenCalled();
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("fires the increase binding on a short press with tap-increases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue("increase");

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-front-wing", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroFrontWingIncrease");
    });

    it("fires the decrease binding on a long press with tap-increases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue("decrease");

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-front-wing", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroFrontWingDecrease");
    });

    it("inverts directions when the global dualPressDirections is tap-decreases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-decreases");
      // The mock passes the chosen outcome through computeOutcome unchanged, so
      // we set the return based on what the tap direction should be.
      tracker.computeOutcome.mockImplementation((_id: string, tap: string, _long: string) => tap);

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-front-wing", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupAeroFrontWingDecrease");
    });

    it("does not fire when the tracker returns undefined (stray key-up)", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue(undefined);

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-front-wing", dualPressEnabled: true }) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("does not fire when dual-press is disabled on key-up", async () => {
      const tracker = (action as any).dualPress as {
        computeOutcome: ReturnType<typeof vi.fn>;
        clear: ReturnType<typeof vi.fn>;
      };

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-front-wing", dualPressEnabled: false }) as any);

      expect(tracker.computeOutcome).not.toHaveBeenCalled();
      expect(tracker.clear).toHaveBeenCalledWith("action-1");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("clears tracker on key-up for non-View settings (so future View presses start clean)", async () => {
      const tracker = (action as any).dualPress as { clear: ReturnType<typeof vi.fn> };

      await action.onKeyUp(fakeEvent("action-1", { setting: "front-wing", direction: "increase" }) as any);

      expect(tracker.clear).toHaveBeenCalledWith("action-1");
    });

    it("clears tracker on willDisappear", async () => {
      const tracker = (action as any).dualPress as { clear: ReturnType<typeof vi.fn> };

      await action.onWillDisappear({
        action: { id: "action-1" },
        payload: { settings: { setting: "view-front-wing" } },
      } as any);

      expect(tracker.clear).toHaveBeenCalledWith("action-1");
    });
  });

  describe("paired key styles", () => {
    it("parses keyStyle/pairPosition with defaults and catch-degradation", () => {
      const parsed = parseSetupAeroSettings({ setting: "front-wing" });
      expect(parsed.keyStyle).toBe("legacy");
      expect(parsed.pairPosition).toBe("auto");
      const degraded = parseSetupAeroSettings({ setting: "front-wing", keyStyle: "hologram" });
      expect(degraded.keyStyle).toBe("legacy");
      expect(degraded.setting).toBe("front-wing"); // catch keeps the rest of the parse alive
    });
  });

  describe("hold-to-repeat wiring", () => {
    it("arms repeat for a paired-style key and fires repeatedly while held", async () => {
      vi.useFakeTimers();
      const action = new SetupAero();
      const ev = fakeEvent("action-1", { setting: "front-wing", direction: "increase", keyStyle: "split" });

      await action.onKeyDown(ev as any);
      expect(mockTapBinding).toHaveBeenCalledTimes(1); // immediate first step

      await vi.advanceTimersByTimeAsync(500 + 150 * 3 + 20); // hold threshold + 3 intervals
      expect(mockTapBinding.mock.calls.length).toBeGreaterThanOrEqual(3);

      await action.onKeyUp(
        fakeEvent("action-1", { setting: "front-wing", direction: "increase", keyStyle: "split" }) as any,
      );
      const after = mockTapBinding.mock.calls.length;

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockTapBinding.mock.calls.length).toBe(after); // stopped on release

      vi.useRealTimers();
    });

    it("does not arm repeat for a legacy-style key", async () => {
      vi.useFakeTimers();
      const action = new SetupAero();

      await action.onKeyDown(
        fakeEvent("action-1", { setting: "front-wing", direction: "increase", keyStyle: "legacy" }) as any,
      );
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockTapBinding).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });
});
