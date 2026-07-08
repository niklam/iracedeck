import { getDualPressDirections } from "@iracedeck/deck-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateSetupTractionSvg,
  parseSetupTractionSettings,
  SETUP_TRACTION_GLOBAL_KEYS,
  SetupTraction,
} from "./setup-traction.js";

// Convenience handle so dual-press tests can switch the live tap direction the same
// way the runtime does (via the @iracedeck/deck-core getDualPressDirections reader).
const mockGetDualPressDirections = getDualPressDirections as unknown as ReturnType<typeof vi.fn>;

const { mockTapBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@iracedeck/icons/setup-traction/tc-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-traction/tc-slot-1-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-traction/tc-slot-1-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-traction/tc-slot-2-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-traction/tc-slot-2-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-traction/tc-slot-3-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-traction/tc-slot-3-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-traction/tc-slot-4-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-traction/tc-slot-4-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
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

/** Create a minimal fake dial rotate event. */
function fakeDialRotateEvent(actionId: string, settings: Record<string, unknown>, ticks: number) {
  return {
    action: { id: actionId, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings, ticks },
  };
}

describe("SetupTraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SETUP_TRACTION_GLOBAL_KEYS", () => {
    it("should have correct mapping for tc-toggle", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-toggle"]).toBe("setupTractionTcToggle");
    });

    it("should have correct mapping for tc-slot-1-increase", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-1-increase"]).toBe("setupTractionTcSlot1Increase");
    });

    it("should have correct mapping for tc-slot-1-decrease", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-1-decrease"]).toBe("setupTractionTcSlot1Decrease");
    });

    it("should have correct mapping for tc-slot-2-increase", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-2-increase"]).toBe("setupTractionTcSlot2Increase");
    });

    it("should have correct mapping for tc-slot-2-decrease", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-2-decrease"]).toBe("setupTractionTcSlot2Decrease");
    });

    it("should have correct mapping for tc-slot-3-increase", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-3-increase"]).toBe("setupTractionTcSlot3Increase");
    });

    it("should have correct mapping for tc-slot-3-decrease", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-3-decrease"]).toBe("setupTractionTcSlot3Decrease");
    });

    it("should have correct mapping for tc-slot-4-increase", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-4-increase"]).toBe("setupTractionTcSlot4Increase");
    });

    it("should have correct mapping for tc-slot-4-decrease", () => {
      expect(SETUP_TRACTION_GLOBAL_KEYS["tc-slot-4-decrease"]).toBe("setupTractionTcSlot4Decrease");
    });

    it("should have exactly 9 entries", () => {
      expect(Object.keys(SETUP_TRACTION_GLOBAL_KEYS)).toHaveLength(9);
    });
  });

  describe("generateSetupTractionSvg", () => {
    it("should generate a valid data URI for tc-toggle", () => {
      const result = generateSetupTractionSvg({ setting: "tc-toggle", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for tc-slot-1 increase", () => {
      const result = generateSetupTractionSvg({ setting: "tc-slot-1", direction: "increase" });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all setting + direction combinations", () => {
      const settings = ["tc-toggle", "tc-slot-1", "tc-slot-2", "tc-slot-3", "tc-slot-4"] as const;
      const directions = ["increase", "decrease"] as const;

      for (const setting of settings) {
        for (const direction of directions) {
          const result = generateSetupTractionSvg({ setting, direction });
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different settings", () => {
      const tcToggle = generateSetupTractionSvg({ setting: "tc-toggle", direction: "increase" });
      const tcSlot1 = generateSetupTractionSvg({ setting: "tc-slot-1", direction: "increase" });

      expect(tcToggle).not.toBe(tcSlot1);
    });

    it("should produce different icons for increase vs decrease on directional controls", () => {
      const increase = generateSetupTractionSvg({ setting: "tc-slot-1", direction: "increase" });
      const decrease = generateSetupTractionSvg({ setting: "tc-slot-1", direction: "decrease" });

      expect(increase).not.toBe(decrease);
    });

    it("should produce same icon for non-directional controls regardless of direction", () => {
      const increase = generateSetupTractionSvg({ setting: "tc-toggle", direction: "increase" });
      const decrease = generateSetupTractionSvg({ setting: "tc-toggle", direction: "decrease" });

      expect(increase).toBe(decrease);
    });

    it("should include correct labels for tc-toggle", () => {
      const result = generateSetupTractionSvg({ setting: "tc-toggle", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("TC");
      expect(decoded).toContain("TOGGLE");
    });

    it("should include correct labels for tc-slot-1 increase", () => {
      const result = generateSetupTractionSvg({ setting: "tc-slot-1", direction: "increase" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("TC1");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for tc-slot-1 decrease", () => {
      const result = generateSetupTractionSvg({ setting: "tc-slot-1", direction: "decrease" });
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("TC1");
      expect(decoded).toContain("DECREASE");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { mainLabel: string; subLabel: string }>> = {
        "tc-toggle": {
          increase: { mainLabel: "TC", subLabel: "TOGGLE" },
          decrease: { mainLabel: "TC", subLabel: "TOGGLE" },
        },
        "tc-slot-1": {
          increase: { mainLabel: "TC1", subLabel: "INCREASE" },
          decrease: { mainLabel: "TC1", subLabel: "DECREASE" },
        },
        "tc-slot-2": {
          increase: { mainLabel: "TC2", subLabel: "INCREASE" },
          decrease: { mainLabel: "TC2", subLabel: "DECREASE" },
        },
        "tc-slot-3": {
          increase: { mainLabel: "TC3", subLabel: "INCREASE" },
          decrease: { mainLabel: "TC3", subLabel: "DECREASE" },
        },
        "tc-slot-4": {
          increase: { mainLabel: "TC4", subLabel: "INCREASE" },
          decrease: { mainLabel: "TC4", subLabel: "DECREASE" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupTractionSvg({
            setting: setting as any,
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
    let action: SetupTraction;

    beforeEach(() => {
      action = new SetupTraction();
    });

    it("should call tapGlobalBinding on keyDown for tc-toggle", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-toggle" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcToggle");
    });

    it("should call tapGlobalBinding for tc-slot-1 increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-slot-1", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot1Increase");
    });

    it("should call tapGlobalBinding for tc-slot-1 decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-slot-1", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot1Decrease");
    });

    it("should call tapGlobalBinding for tc-slot-2 increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-slot-2", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot2Increase");
    });

    it("should call tapGlobalBinding for tc-slot-3 decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-slot-3", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot3Decrease");
    });

    it("should call tapGlobalBinding on dialDown", async () => {
      await action.onDialDown(fakeEvent("action-1", { setting: "tc-toggle" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcToggle");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-toggle" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcToggle");
    });

    it("should call tapGlobalBinding for directional settings", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "tc-slot-1", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot1Increase");
    });
  });

  describe("encoder behavior", () => {
    let action: SetupTraction;

    beforeEach(() => {
      action = new SetupTraction();
    });

    it("should call tapGlobalBinding for increase on clockwise rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "tc-slot-1", direction: "increase" }, 1) as any,
      );

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot1Increase");
    });

    it("should call tapGlobalBinding for decrease on counter-clockwise rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "tc-slot-1", direction: "increase" }, -1) as any,
      );

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot1Decrease");
    });

    it("should call tapGlobalBinding for different settings on rotation", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { setting: "tc-slot-2", direction: "increase" }, 2) as any,
      );

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot2Increase");
    });

    it("should ignore rotation for non-directional controls (tc-toggle)", async () => {
      await action.onDialRotate(fakeDialRotateEvent("action-1", { setting: "tc-toggle" }, 1) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("view sub-modes (issue #541)", () => {
    let action: SetupTraction;

    beforeEach(() => {
      action = new SetupTraction();
      (action.sdkController.getCurrentTelemetry as any).mockReturnValue({
        dcTractionControl: 3,
        dcTractionControl2: 5,
      });
    });

    it("renders the formatted telemetry value for View TC1", async () => {
      const ev = fakeEvent("action-1", { setting: "view-tc-slot-1" }) as any;
      await action.onWillAppear(ev);
      const calls = (action.setKeyImage as any).mock.calls;
      const svg = decodeURIComponent(calls[0][1] as string);
      expect(svg).toContain("3");
    });

    it("reads the per-slot dc field for View TC2", async () => {
      const ev = fakeEvent("action-1", { setting: "view-tc-slot-2" }) as any;
      await action.onWillAppear(ev);
      const calls = (action.setKeyImage as any).mock.calls;
      const svg = decodeURIComponent(calls[0][1] as string);
      expect(svg).toContain("5");
    });

    it("does not fire a binding when a View setting is pressed", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-tc-slot-1" }) as any);
      await action.onDialDown(fakeEvent("action-1", { setting: "view-tc-slot-1" }) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("dual-press dispatch (issue #540)", () => {
    let action: SetupTraction;

    beforeEach(() => {
      action = new SetupTraction();
    });

    it("records keyDown on View + dual-press enabled and does not fire on its own", async () => {
      const tracker = (action as any).dualPress as { recordKeyDown: ReturnType<typeof vi.fn> };
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-tc-slot-1", dualPressEnabled: true }) as any);

      expect(tracker.recordKeyDown).toHaveBeenCalledWith("action-1");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("does not record keyDown when dual-press is disabled", async () => {
      const tracker = (action as any).dualPress as { recordKeyDown: ReturnType<typeof vi.fn> };
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-tc-slot-1", dualPressEnabled: false }) as any);

      expect(tracker.recordKeyDown).not.toHaveBeenCalled();
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("fires the increase binding on a short press with tap-increases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue("increase");

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-tc-slot-1", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot1Increase");
    });

    it("fires the decrease binding on a long press with tap-increases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue("decrease");

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-tc-slot-1", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot1Decrease");
    });

    it("inverts directions when the global dualPressDirections is tap-decreases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-decreases");
      // The mock passes the chosen outcome through computeOutcome unchanged, so
      // we set the return based on what the tap direction should be.
      tracker.computeOutcome.mockImplementation((_id: string, tap: string, _long: string) => tap);

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-tc-slot-1", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupTractionTcSlot1Decrease");
    });

    it("does not fire when the tracker returns undefined (stray key-up)", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue(undefined);

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-tc-slot-1", dualPressEnabled: true }) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("does not fire when dual-press is disabled on key-up", async () => {
      const tracker = (action as any).dualPress as {
        computeOutcome: ReturnType<typeof vi.fn>;
        clear: ReturnType<typeof vi.fn>;
      };

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-tc-slot-1", dualPressEnabled: false }) as any);

      expect(tracker.computeOutcome).not.toHaveBeenCalled();
      expect(tracker.clear).toHaveBeenCalledWith("action-1");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("clears tracker on key-up for non-View settings (so future View presses start clean)", async () => {
      const tracker = (action as any).dualPress as { clear: ReturnType<typeof vi.fn> };

      await action.onKeyUp(fakeEvent("action-1", { setting: "tc-slot-1", direction: "increase" }) as any);

      expect(tracker.clear).toHaveBeenCalledWith("action-1");
    });

    it("clears tracker on willDisappear", async () => {
      const tracker = (action as any).dualPress as { clear: ReturnType<typeof vi.fn> };

      await action.onWillDisappear({
        action: { id: "action-1" },
        payload: { settings: { setting: "view-tc-slot-1" } },
      } as any);

      expect(tracker.clear).toHaveBeenCalledWith("action-1");
    });
  });

  describe("paired key styles", () => {
    it("parses keyStyle/pairPosition with defaults and catch-degradation", () => {
      const parsed = parseSetupTractionSettings({ setting: "tc-slot-1" });
      expect(parsed.keyStyle).toBe("legacy");
      expect(parsed.pairPosition).toBe("auto");
      const degraded = parseSetupTractionSettings({ setting: "tc-slot-1", keyStyle: "hologram" });
      expect(degraded.keyStyle).toBe("legacy");
      expect(degraded.setting).toBe("tc-slot-1"); // catch keeps the rest of the parse alive
    });
  });

  describe("hold-to-repeat wiring", () => {
    it("arms repeat for a paired-style key and fires repeatedly while held", async () => {
      vi.useFakeTimers();
      const action = new SetupTraction();
      const ev = fakeEvent("action-1", { setting: "tc-slot-1", direction: "increase", keyStyle: "split" });

      await action.onKeyDown(ev as any);
      expect(mockTapBinding).toHaveBeenCalledTimes(1); // immediate first step

      await vi.advanceTimersByTimeAsync(500 + 150 * 3 + 20); // hold threshold + 3 intervals
      expect(mockTapBinding.mock.calls.length).toBeGreaterThanOrEqual(3);

      await action.onKeyUp(
        fakeEvent("action-1", { setting: "tc-slot-1", direction: "increase", keyStyle: "split" }) as any,
      );
      const after = mockTapBinding.mock.calls.length;

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockTapBinding.mock.calls.length).toBe(after); // stopped on release

      vi.useRealTimers();
    });

    it("does not arm repeat for a legacy-style key", async () => {
      vi.useFakeTimers();
      const action = new SetupTraction();

      await action.onKeyDown(
        fakeEvent("action-1", { setting: "tc-slot-1", direction: "increase", keyStyle: "legacy" }) as any,
      );
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockTapBinding).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });
});
