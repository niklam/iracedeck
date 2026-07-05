// Convenience handle so dual-press tests can switch the live tap direction the same
// way the runtime does (via the @iracedeck/deck-core getDualPressDirections reader).
import { getDualPressDirections } from "@iracedeck/deck-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseSetupBrakesSettings } from "./setup-brakes-settings.js";
import { generateSetupBrakesSvg, SETUP_BRAKES_GLOBAL_KEYS } from "./setup-brakes.js";
import { SetupBrakes } from "./setup-brakes.js";

const mockGetDualPressDirections = getDualPressDirections as unknown as ReturnType<typeof vi.fn>;

const { mockTapBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@iracedeck/icons/setup-brakes/abs-toggle.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">abs-toggle {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/abs-adjust-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">abs-adjust-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/abs-adjust-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">abs-adjust-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/brake-bias-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">brake-bias-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/brake-bias-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">brake-bias-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/brake-bias-fine-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">brake-bias-fine-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/brake-bias-fine-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">brake-bias-fine-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/peak-brake-bias-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">peak-brake-bias-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/peak-brake-bias-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">peak-brake-bias-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/brake-misc-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">brake-misc-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/brake-misc-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">brake-misc-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/engine-braking-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">engine-braking-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/setup-brakes/engine-braking-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">engine-braking-decrease {{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
    CommonSettings: {
      // REAL zod semantics for the extended settings schema (defaults, the `dial`
      // prefault, enum validation) — only the CommonSettings base fields are absent.
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
    onGlobalSettingsChange: vi.fn(() => vi.fn()),
    escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    // Shared dial-gesture release classifier (used by the dial surface).
    classifyDialRelease: (args: {
      pressStartMs: number;
      nowMs: number;
      rotatedWhilePressed: boolean;
      thresholdMs?: number;
    }) => {
      if (args.rotatedWhilePressed) return "push-turn";

      return args.nowMs - args.pressStartMs >= (args.thresholdMs ?? 500) ? "long" : "short";
    },
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

/** Full parsed settings for the icon-generation helpers (real-zod defaults applied). */
function svgSettings(raw: Record<string, unknown>) {
  return parseSetupBrakesSettings(raw);
}

/** Create a minimal fake keypad event with the given action ID and settings. */
function fakeEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: { id: actionId, isKey: () => true, isDial: () => false, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings },
  };
}

/** Create a minimal fake dial (encoder) event. */
function fakeDialEvent(actionId: string, settings: Record<string, unknown> = {}) {
  return {
    action: {
      id: actionId,
      isKey: () => false,
      isDial: () => true,
      setTitle: vi.fn(),
      setImage: vi.fn().mockResolvedValue(undefined),
      setFeedback: vi.fn().mockResolvedValue(undefined),
      setTriggerDescription: vi.fn().mockResolvedValue(undefined),
    },
    payload: { settings },
  };
}

/** Create a minimal fake dial rotate event (dial context). */
function fakeDialRotateEvent(actionId: string, settings: Record<string, unknown>, ticks: number) {
  const ev = fakeDialEvent(actionId, settings);

  return { action: ev.action, payload: { settings, ticks, pressed: false } };
}

describe("SetupBrakes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SETUP_BRAKES_GLOBAL_KEYS", () => {
    it("should have correct mapping for abs-toggle", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["abs-toggle"]).toBe("setupBrakesAbsToggle");
    });

    it("should have correct mapping for abs-adjust-increase", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["abs-adjust-increase"]).toBe("setupBrakesAbsAdjustIncrease");
    });

    it("should have correct mapping for abs-adjust-decrease", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["abs-adjust-decrease"]).toBe("setupBrakesAbsAdjustDecrease");
    });

    it("should have correct mapping for brake-bias-increase", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-bias-increase"]).toBe("setupBrakesBrakeBiasIncrease");
    });

    it("should have correct mapping for brake-bias-decrease", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-bias-decrease"]).toBe("setupBrakesBrakeBiasDecrease");
    });

    it("should have correct mapping for brake-bias-fine-increase", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-bias-fine-increase"]).toBe("setupBrakesBrakeBiasFineIncrease");
    });

    it("should have correct mapping for brake-bias-fine-decrease", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-bias-fine-decrease"]).toBe("setupBrakesBrakeBiasFineDecrease");
    });

    it("should have correct mapping for peak-brake-bias-increase", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["peak-brake-bias-increase"]).toBe("setupBrakesPeakBrakeBiasIncrease");
    });

    it("should have correct mapping for peak-brake-bias-decrease", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["peak-brake-bias-decrease"]).toBe("setupBrakesPeakBrakeBiasDecrease");
    });

    it("should have correct mapping for brake-misc-increase", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-misc-increase"]).toBe("setupBrakesBrakeMiscIncrease");
    });

    it("should have correct mapping for brake-misc-decrease", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["brake-misc-decrease"]).toBe("setupBrakesBrakeMiscDecrease");
    });

    it("should have correct mapping for engine-braking-increase", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["engine-braking-increase"]).toBe("setupBrakesEngineBrakingIncrease");
    });

    it("should have correct mapping for engine-braking-decrease", () => {
      expect(SETUP_BRAKES_GLOBAL_KEYS["engine-braking-decrease"]).toBe("setupBrakesEngineBrakingDecrease");
    });

    it("should have exactly 13 entries", () => {
      expect(Object.keys(SETUP_BRAKES_GLOBAL_KEYS)).toHaveLength(13);
    });
  });

  describe("generateSetupBrakesSvg", () => {
    it("should generate a valid data URI for abs-toggle", () => {
      const result = generateSetupBrakesSvg(svgSettings({ setting: "abs-toggle", direction: "increase" }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for brake-bias", () => {
      const result = generateSetupBrakesSvg(svgSettings({ setting: "brake-bias", direction: "increase" }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate a valid data URI for engine-braking", () => {
      const result = generateSetupBrakesSvg(svgSettings({ setting: "engine-braking", direction: "increase" }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should generate valid data URIs for all setting + direction combinations", () => {
      const settings = [
        "abs-toggle",
        "abs-adjust",
        "brake-bias",
        "brake-bias-fine",
        "peak-brake-bias",
        "brake-misc",
        "engine-braking",
      ] as const;
      const directions = ["increase", "decrease"] as const;

      for (const setting of settings) {
        for (const direction of directions) {
          const result = generateSetupBrakesSvg(svgSettings({ setting, direction }));
          expect(result).toContain("data:image/svg+xml");
        }
      }
    });

    it("should produce different icons for different settings", () => {
      const absToggle = generateSetupBrakesSvg(svgSettings({ setting: "abs-toggle", direction: "increase" }));
      const brakeBias = generateSetupBrakesSvg(svgSettings({ setting: "brake-bias", direction: "increase" }));

      expect(absToggle).not.toBe(brakeBias);
    });

    it("should produce different icons for increase vs decrease on directional controls", () => {
      const increase = generateSetupBrakesSvg(svgSettings({ setting: "brake-bias", direction: "increase" }));
      const decrease = generateSetupBrakesSvg(svgSettings({ setting: "brake-bias", direction: "decrease" }));

      expect(increase).not.toBe(decrease);
    });

    it("should produce same icon for non-directional controls regardless of direction", () => {
      const increase = generateSetupBrakesSvg(svgSettings({ setting: "abs-toggle", direction: "increase" }));
      const decrease = generateSetupBrakesSvg(svgSettings({ setting: "abs-toggle", direction: "decrease" }));

      expect(increase).toBe(decrease);
    });

    it("should include correct labels for abs-toggle", () => {
      const result = generateSetupBrakesSvg(svgSettings({ setting: "abs-toggle", direction: "increase" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("ABS");
      expect(decoded).toContain("TOGGLE");
    });

    it("should include correct labels for brake-bias increase", () => {
      const result = generateSetupBrakesSvg(svgSettings({ setting: "brake-bias", direction: "increase" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("BRAKE BIAS");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for brake-bias decrease", () => {
      const result = generateSetupBrakesSvg(svgSettings({ setting: "brake-bias", direction: "decrease" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("BRAKE BIAS");
      expect(decoded).toContain("DECREASE");
    });

    it("should include correct labels for brake-bias-fine increase", () => {
      const result = generateSetupBrakesSvg(svgSettings({ setting: "brake-bias-fine", direction: "increase" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("BIAS FINE");
      expect(decoded).toContain("INCREASE");
    });

    it("should include correct labels for engine-braking decrease", () => {
      const result = generateSetupBrakesSvg(svgSettings({ setting: "engine-braking", direction: "decrease" }));
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("ENG BRAKE");
      expect(decoded).toContain("DECREASE");
    });

    it("should include correct labels for all combinations", () => {
      const expectedLabels: Record<string, Record<string, { line1: string; line2: string }>> = {
        "abs-toggle": {
          increase: { line1: "ABS", line2: "TOGGLE" },
          decrease: { line1: "ABS", line2: "TOGGLE" },
        },
        "abs-adjust": {
          increase: { line1: "ABS", line2: "INCREASE" },
          decrease: { line1: "ABS", line2: "DECREASE" },
        },
        "brake-bias": {
          increase: { line1: "BRAKE BIAS", line2: "INCREASE" },
          decrease: { line1: "BRAKE BIAS", line2: "DECREASE" },
        },
        "brake-bias-fine": {
          increase: { line1: "BIAS FINE", line2: "INCREASE" },
          decrease: { line1: "BIAS FINE", line2: "DECREASE" },
        },
        "peak-brake-bias": {
          increase: { line1: "PEAK BIAS", line2: "INCREASE" },
          decrease: { line1: "PEAK BIAS", line2: "DECREASE" },
        },
        "brake-misc": {
          increase: { line1: "BRAKE MISC", line2: "INCREASE" },
          decrease: { line1: "BRAKE MISC", line2: "DECREASE" },
        },
        "engine-braking": {
          increase: { line1: "ENG BRAKE", line2: "INCREASE" },
          decrease: { line1: "ENG BRAKE", line2: "DECREASE" },
        },
      };

      for (const [setting, directions] of Object.entries(expectedLabels)) {
        for (const [direction, labels] of Object.entries(directions)) {
          const result = generateSetupBrakesSvg(svgSettings({ setting, direction }));
          const decoded = decodeURIComponent(result);

          expect(decoded).toContain(labels.line1);
          expect(decoded).toContain(labels.line2);
        }
      }
    });
  });

  describe("tap behavior", () => {
    let action: SetupBrakes;

    beforeEach(() => {
      action = new SetupBrakes();
    });

    it("should call tapGlobalBinding on keyDown for abs-toggle", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "abs-toggle" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesAbsToggle");
    });

    it("should call tapGlobalBinding for brake-bias increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "brake-bias", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasIncrease");
    });

    it("should call tapGlobalBinding for brake-bias decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "brake-bias", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasDecrease");
    });

    it("should call tapGlobalBinding for abs-adjust increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "abs-adjust", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesAbsAdjustIncrease");
    });

    it("should call tapGlobalBinding for engine-braking decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "engine-braking", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesEngineBrakingDecrease");
    });

    it("should call tapGlobalBinding for peak-brake-bias increase", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "peak-brake-bias", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesPeakBrakeBiasIncrease");
    });

    it("should call tapGlobalBinding for brake-misc decrease", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "brake-misc", direction: "decrease" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeMiscDecrease");
    });

    it("should call tapGlobalBinding even when no key binding is configured", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "abs-toggle" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesAbsToggle");
    });

    it("should call tapGlobalBinding for directional controls", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "brake-bias", direction: "increase" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasIncrease");
    });
  });

  describe("dial surface routing (#775)", () => {
    let action: SetupBrakes;

    beforeEach(() => {
      action = new SetupBrakes();
    });

    it("routes rotation to dial.setting, not the keypad setting", async () => {
      // The keypad half is bound to engine-braking; the dial half to brake-bias.
      const settings = { setting: "engine-braking", dial: { setting: "brake-bias" } };

      await action.onDialRotate(fakeDialRotateEvent("dial-1", settings, 1) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasIncrease");
    });

    it("taps the decrease binding on a counter-clockwise turn", async () => {
      await action.onDialRotate(fakeDialRotateEvent("dial-1", { dial: { setting: "brake-bias" } }, -1) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasDecrease");
    });

    it("fires nothing on dial down; the press gesture fires on dial up", async () => {
      const settings = { dial: { setting: "brake-bias", pressAction: "toggle-abs" } };
      const ev = fakeDialEvent("dial-1", settings);

      await action.onDialDown(ev as any);

      expect(mockTapBinding).not.toHaveBeenCalled();

      await action.onDialUp(ev as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesAbsToggle");
    });

    it("renders the touch strip but no key image or active binding for a dial instance", async () => {
      const ev = fakeDialEvent("dial-1", { dial: { setting: "brake-bias" } });

      await action.onWillAppear(ev as any);

      expect(ev.action.setFeedback).toHaveBeenCalled();
      expect((action as any).setKeyImage).not.toHaveBeenCalled();
      expect((action as any).setActiveBinding).not.toHaveBeenCalled();
    });

    it("pushes no touch-strip feedback for a keypad instance", async () => {
      const ev = fakeEvent("key-1", { setting: "brake-bias" });

      await action.onWillAppear(ev as any);

      expect((action as any).setKeyImage).toHaveBeenCalled();
      expect((action as any).setActiveBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasIncrease");
    });
  });

  describe("view sub-modes (issue #541)", () => {
    let action: SetupBrakes;

    beforeEach(() => {
      action = new SetupBrakes();
      // iRacing exposes dcBrakeBias in percent units (54, not 0.54).
      (action.sdkController.getCurrentTelemetry as any).mockReturnValue({ dcBrakeBias: 56 });
    });

    it("renders the formatted telemetry value for a View setting on willAppear", async () => {
      const ev = fakeEvent("action-1", { setting: "view-brake-bias" }) as any;
      await action.onWillAppear(ev);

      // The icon SVG carries the formatted value via the {{value}} placeholder.
      const calls = (action.setKeyImage as any).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const svg = decodeURIComponent(calls[0][1] as string);
      expect(svg).toContain("56.0%");
    });

    it("does not call tapBinding when a View setting is pressed on a keypad", async () => {
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-brake-bias" }) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("subscribes to telemetry on willAppear and unsubscribes on willDisappear", async () => {
      const subscribe = action.sdkController.subscribe as any;
      const unsubscribe = action.sdkController.unsubscribe as any;
      await action.onWillAppear(fakeEvent("action-1", { setting: "view-brake-bias" }) as any);

      expect(subscribe).toHaveBeenCalledWith("action-1", expect.any(Function));

      await action.onWillDisappear({ action: { id: "action-1" }, payload: { settings: {} } } as any);
      expect(unsubscribe).toHaveBeenCalledWith("action-1");
    });

    it("clears active binding when switching to a View setting with dual-press off", async () => {
      const setActive = action.setActiveBinding as any;
      await action.onWillAppear(fakeEvent("action-1", { setting: "view-brake-bias", dualPressEnabled: false }) as any);

      expect(setActive).toHaveBeenCalledWith(null);
    });
  });

  describe("dual-press dispatch (issue #540)", () => {
    let action: SetupBrakes;

    beforeEach(() => {
      action = new SetupBrakes();
    });

    it("records keyDown on View + dual-press enabled and does not fire on its own", async () => {
      const tracker = (action as any).dualPress as { recordKeyDown: ReturnType<typeof vi.fn> };
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-brake-bias", dualPressEnabled: true }) as any);

      expect(tracker.recordKeyDown).toHaveBeenCalledWith("action-1");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("does not record keyDown when dual-press is disabled", async () => {
      const tracker = (action as any).dualPress as { recordKeyDown: ReturnType<typeof vi.fn> };
      await action.onKeyDown(fakeEvent("action-1", { setting: "view-brake-bias", dualPressEnabled: false }) as any);

      expect(tracker.recordKeyDown).not.toHaveBeenCalled();
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("fires the increase binding on a short press with tap-increases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue("increase");

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-brake-bias", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasIncrease");
    });

    it("fires the decrease binding on a long press with tap-increases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue("decrease");

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-brake-bias", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasDecrease");
    });

    it("inverts directions when the global dualPressDirections is tap-decreases", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-decreases");
      // The mock passes the chosen outcome through computeOutcome unchanged, so
      // we set the return based on what the tap direction should be.
      tracker.computeOutcome.mockImplementation((_id: string, tap: string, _long: string) => tap);

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-brake-bias", dualPressEnabled: true }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("setupBrakesBrakeBiasDecrease");
    });

    it("does not fire when the tracker returns undefined (stray key-up)", async () => {
      const tracker = (action as any).dualPress as { computeOutcome: ReturnType<typeof vi.fn> };
      mockGetDualPressDirections.mockReturnValue("tap-increases");
      tracker.computeOutcome.mockReturnValue(undefined);

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-brake-bias", dualPressEnabled: true }) as any);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("does not fire when dual-press is disabled on key-up", async () => {
      const tracker = (action as any).dualPress as {
        computeOutcome: ReturnType<typeof vi.fn>;
        clear: ReturnType<typeof vi.fn>;
      };

      await action.onKeyUp(fakeEvent("action-1", { setting: "view-brake-bias", dualPressEnabled: false }) as any);

      expect(tracker.computeOutcome).not.toHaveBeenCalled();
      expect(tracker.clear).toHaveBeenCalledWith("action-1");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("clears tracker on key-up for non-View settings (so future View presses start clean)", async () => {
      const tracker = (action as any).dualPress as { clear: ReturnType<typeof vi.fn> };

      await action.onKeyUp(fakeEvent("action-1", { setting: "brake-bias", direction: "increase" }) as any);

      expect(tracker.clear).toHaveBeenCalledWith("action-1");
    });

    it("clears tracker on willDisappear", async () => {
      const tracker = (action as any).dualPress as { clear: ReturnType<typeof vi.fn> };

      await action.onWillDisappear({
        action: { id: "action-1" },
        payload: { settings: { setting: "view-brake-bias" } },
      } as any);

      expect(tracker.clear).toHaveBeenCalledWith("action-1");
    });
  });
});
