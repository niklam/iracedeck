import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildReadout,
  clampTargetLtr,
  fillPercent,
  formatDisplayValue,
  FUEL_DIAL_UUID,
  FuelDial,
  generateFuelDialSvg,
  readEffectiveMaxLtr,
  readPitSvFuel,
  resolveDisplayUnits,
  unitSuffix,
} from "./fuel-dial.js";

const { mockPitClearFuel, mockPitFuel, mockGetCommands, mockGetSessionInfo, mockGetCurrentTelemetry } = vi.hoisted(
  () => ({
    mockPitClearFuel: vi.fn(() => true),
    mockPitFuel: vi.fn(() => true),
    mockGetCommands: vi.fn(() => ({
      pit: { clearFuel: mockPitClearFuel, fuel: mockPitFuel },
    })),
    mockGetSessionInfo: vi.fn<() => unknown>(() => null),
    mockGetCurrentTelemetry: vi.fn<() => unknown>(() => null),
  }),
);

vi.mock("@iracedeck/iracing-sdk", () => ({
  DisplayUnits: { English: 0, Metric: 1 },
}));

vi.mock("../../../icons/fuel-dial.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{titleContent}}{{iconContent}} {{backgroundColor}}</svg>',
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: () => {
      const defaults = {
        stepSize: 1,
        pressAction: "toggle-fueling",
        longPressAction: "clear-fueling",
        touchScreenEnabled: true,
        unitMode: "auto",
      };
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...defaults, ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...defaults, ...data } }),
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
      getCurrentTelemetry: mockGetCurrentTelemetry,
      getSessionInfo: mockGetSessionInfo,
    };
    setKeyImage = vi.fn().mockResolvedValue(undefined);
    setRegenerateCallback = vi.fn();
    updateKeyImage = vi.fn().mockResolvedValue(false);
    async onWillAppear() {}
    async onDidReceiveSettings() {}
    async onWillDisappear() {}
  },
  getCommands: mockGetCommands,
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalTitleSettings: vi.fn(() => ({})),
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  resolveBorderSettings: vi.fn(() => ({
    enabled: false,
    borderWidth: 7,
    borderColor: "#00aaff",
    glowEnabled: true,
    glowWidth: 18,
  })),
  resolveIconColors: vi.fn(() => ({ graphic1Color: "#ffffff", textColor: "#ffffff", backgroundColor: "#2a3340" })),
  resolveTitleSettings: vi.fn(() => ({
    showTitle: true,
    showGraphics: true,
    titleText: "FUEL",
    bold: true,
    fontSize: 18,
    position: "top" as const,
    customPosition: 0,
  })),
  renderIconTemplate: vi.fn(
    (_template: string, data: Record<string, string>) =>
      `<svg>${data.titleContent || ""}${data.iconContent || ""}</svg>`,
  ),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
  fuelToDisplayUnits: vi.fn((liters: number, displayUnits: number | undefined) =>
    displayUnits === 1 ? liters : liters * 0.264172,
  ),
  fuelFromDisplayUnits: vi.fn((amount: number, displayUnits: number | undefined) =>
    displayUnits === 1 ? amount : amount * 3.78541,
  ),
  isMetricUnits: vi.fn((displayUnits: number | undefined) => displayUnits === 1),
}));

/** Fake key (keypad) action context. */
function keyContext(id: string) {
  return {
    id,
    isKey: () => true,
    isDial: () => false,
    setImage: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setFeedbackLayout: vi.fn().mockResolvedValue(undefined),
  };
}

/** Fake dial (encoder) action context. */
function dialContext(id: string) {
  return {
    id,
    isKey: () => false,
    isDial: () => true,
    setImage: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setFeedbackLayout: vi.fn().mockResolvedValue(undefined),
  };
}

function rotateEvent(action: ReturnType<typeof dialContext>, settings: Record<string, unknown>, ticks: number) {
  return { action, payload: { settings, ticks } };
}

function basicEvent(
  action: ReturnType<typeof dialContext> | ReturnType<typeof keyContext>,
  settings: Record<string, unknown> = {},
) {
  return { action, payload: { settings } };
}

function touchTapEvent(action: ReturnType<typeof dialContext>, settings: Record<string, unknown>, hold: boolean) {
  return { action, payload: { settings, tapPos: [0, 0] as [number, number], hold } };
}

const SESSION_110L = { DriverInfo: { DriverCarFuelMaxLtr: 110, DriverCarMaxFuelPct: 1 } };

describe("fuel-dial pure helpers", () => {
  describe("resolveDisplayUnits", () => {
    it("forces metric for liters mode", () => {
      expect(resolveDisplayUnits("liters", 0)).toBe(1);
    });

    it("forces english for gallons mode", () => {
      expect(resolveDisplayUnits("gallons", 1)).toBe(0);
    });

    it("follows telemetry in auto mode", () => {
      expect(resolveDisplayUnits("auto", 0)).toBe(0);
      expect(resolveDisplayUnits("auto", 1)).toBe(1);
    });

    it("defaults to metric in auto mode when telemetry unknown", () => {
      expect(resolveDisplayUnits("auto", undefined)).toBe(1);
    });
  });

  describe("unitSuffix", () => {
    it("returns L for metric and gal for english", () => {
      expect(unitSuffix(1)).toBe("L");
      expect(unitSuffix(0)).toBe("gal");
    });
  });

  describe("readEffectiveMaxLtr", () => {
    it("returns capacity × pct", () => {
      expect(readEffectiveMaxLtr({ DriverInfo: { DriverCarFuelMaxLtr: 100, DriverCarMaxFuelPct: 0.9 } } as never)).toBe(
        90,
      );
    });

    it("defaults pct to 1 when missing", () => {
      expect(readEffectiveMaxLtr({ DriverInfo: { DriverCarFuelMaxLtr: 110 } } as never)).toBe(110);
    });

    it("returns undefined when capacity unknown", () => {
      expect(readEffectiveMaxLtr(null)).toBeUndefined();
      expect(readEffectiveMaxLtr({ DriverInfo: {} } as never)).toBeUndefined();
      expect(readEffectiveMaxLtr({ DriverInfo: { DriverCarFuelMaxLtr: 0 } } as never)).toBeUndefined();
    });
  });

  describe("clampTargetLtr", () => {
    it("clamps to [0, max]", () => {
      expect(clampTargetLtr(50, 100)).toBe(50);
      expect(clampTargetLtr(150, 100)).toBe(100);
      expect(clampTargetLtr(-5, 100)).toBe(0);
    });

    it("only enforces lower bound when max unknown", () => {
      expect(clampTargetLtr(150, undefined)).toBe(150);
      expect(clampTargetLtr(-5, undefined)).toBe(0);
    });
  });

  describe("formatDisplayValue", () => {
    it("drops decimals for whole numbers", () => {
      expect(formatDisplayValue(74, 1)).toBe("74");
    });

    it("keeps one decimal for fractional values", () => {
      expect(formatDisplayValue(12.5, 1)).toBe("12.5");
    });

    it("converts to gallons in english mode", () => {
      // 100L ≈ 26.4 gal
      expect(formatDisplayValue(100, 0)).toBe("26.4");
    });
  });

  describe("buildReadout", () => {
    it("shows target / max with suffix", () => {
      expect(buildReadout(74, 100, 1)).toBe("74 / 100 L");
    });

    it("shows -- when max unknown", () => {
      expect(buildReadout(74, undefined, 1)).toBe("74 / -- L");
    });
  });

  describe("fillPercent", () => {
    it("computes percentage", () => {
      expect(fillPercent(50, 100)).toBe(50);
    });

    it("returns 0 when max unknown", () => {
      expect(fillPercent(50, undefined)).toBe(0);
    });

    it("clamps to 0-100", () => {
      expect(fillPercent(150, 100)).toBe(100);
      expect(fillPercent(-5, 100)).toBe(0);
    });
  });

  describe("readPitSvFuel", () => {
    it("reads finite PitSvFuel", () => {
      expect(readPitSvFuel({ PitSvFuel: 42 } as never)).toBe(42);
    });

    it("returns undefined for missing/non-finite", () => {
      expect(readPitSvFuel(null)).toBeUndefined();
      expect(readPitSvFuel({} as never)).toBeUndefined();
    });
  });

  describe("generateFuelDialSvg", () => {
    it("produces a data URI containing the readout value", () => {
      const result = generateFuelDialSvg({ stepSize: 1 } as never, 74, 100, 1, true);
      const decoded = decodeURIComponent(result);

      expect(result).toContain("data:image/svg+xml");
      expect(decoded).toContain("74 L");
    });
  });

  it("exposes the action UUID", () => {
    expect(FUEL_DIAL_UUID).toBe("com.iracedeck.sd.core.fuel-dial");
  });
});

describe("FuelDial action", () => {
  let action: FuelDial;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetSessionInfo.mockReturnValue(SESSION_110L);
    mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0 });
    action = new FuelDial();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function appear(
    ctx: ReturnType<typeof dialContext> | ReturnType<typeof keyContext>,
    settings: Record<string, unknown> = {},
  ) {
    await action.onWillAppear(basicEvent(ctx, settings) as never);
  }

  describe("onDialRotate — step scaling & clamping", () => {
    it("scales a single positive tick by step size (metric)", async () => {
      const ctx = dialContext("d1");
      await appear(ctx, { stepSize: 5, unitMode: "liters" });
      await action.onDialRotate(rotateEvent(ctx, { stepSize: 5, unitMode: "liters" }, 1) as never);

      // leading-edge send fires immediately
      expect(mockPitFuel).toHaveBeenCalledWith(5);
    });

    it("treats ticks as a signed delta (|ticks| > 1)", async () => {
      const ctx = dialContext("d2");
      await appear(ctx, { stepSize: 2, unitMode: "liters" });
      await action.onDialRotate(rotateEvent(ctx, { stepSize: 2, unitMode: "liters" }, 3) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(6);
    });

    it("clamps the upper bound to the tank max", async () => {
      const ctx = dialContext("d3");
      await appear(ctx, { stepSize: 50, unitMode: "liters" });
      // 50 * 3 = 150, clamped to 110
      await action.onDialRotate(rotateEvent(ctx, { stepSize: 50, unitMode: "liters" }, 3) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(110);
    });

    it("clamps the lower bound to 0", async () => {
      const ctx = dialContext("d4");
      await appear(ctx, { stepSize: 5, unitMode: "liters" });
      await action.onDialRotate(rotateEvent(ctx, { stepSize: 5, unitMode: "liters" }, -3) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(0);
    });

    it("converts gallons step to liters internally", async () => {
      const ctx = dialContext("d5");
      await appear(ctx, { stepSize: 1, unitMode: "gallons" });
      await action.onDialRotate(rotateEvent(ctx, { stepSize: 1, unitMode: "gallons" }, 1) as never);

      // 1 gal -> 3.78541 L
      expect(mockPitFuel).toHaveBeenCalledWith(expect.closeTo(3.78541, 4));
    });
  });

  describe("throttle coalescing", () => {
    it("sends the leading change immediately and coalesces the tail into one flush", async () => {
      const ctx = dialContext("t1");
      await appear(ctx, { stepSize: 1, unitMode: "liters" });

      await action.onDialRotate(rotateEvent(ctx, { stepSize: 1, unitMode: "liters" }, 1) as never); // -> 1, leading send
      await action.onDialRotate(rotateEvent(ctx, { stepSize: 1, unitMode: "liters" }, 1) as never); // -> 2, coalesced
      await action.onDialRotate(rotateEvent(ctx, { stepSize: 1, unitMode: "liters" }, 1) as never); // -> 3, coalesced

      expect(mockPitFuel).toHaveBeenCalledTimes(1);
      expect(mockPitFuel).toHaveBeenLastCalledWith(1);

      // Flush the trailing window — last value wins
      vi.advanceTimersByTime(100);

      expect(mockPitFuel).toHaveBeenCalledTimes(2);
      expect(mockPitFuel).toHaveBeenLastCalledWith(3);
    });

    it("suppresses no-op repeats of the same liters", async () => {
      const ctx = dialContext("t2");
      await appear(ctx, { stepSize: 1, unitMode: "liters" });

      await action.onDialRotate(rotateEvent(ctx, { stepSize: 1, unitMode: "liters" }, 1) as never); // -> 1 leading
      // Rotate up then back down within the window: pending ends at 1 (already sent)
      await action.onDialRotate(rotateEvent(ctx, { stepSize: 1, unitMode: "liters" }, 1) as never); // -> 2
      await action.onDialRotate(rotateEvent(ctx, { stepSize: 1, unitMode: "liters" }, -1) as never); // -> 1
      vi.advanceTimersByTime(100);

      // Trailing flush target equals lastSent (1) — suppressed
      expect(mockPitFuel).toHaveBeenCalledTimes(1);
    });
  });

  describe("doPress dispatch", () => {
    it("toggle-fueling requests when disarmed then clears when armed", async () => {
      const ctx = dialContext("p1");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      await appear(ctx, { pressAction: "toggle-fueling", unitMode: "liters", stepSize: 1 });

      // disarmed -> request
      await action.onDialDown(
        basicEvent(ctx, { pressAction: "toggle-fueling", unitMode: "liters", stepSize: 1 }) as never,
      );

      expect(mockPitFuel).toHaveBeenCalledWith(0);

      // armed -> clear
      await action.onDialDown(
        basicEvent(ctx, { pressAction: "toggle-fueling", unitMode: "liters", stepSize: 1 }) as never,
      );

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
    });

    it("clear-fueling always clears", async () => {
      const ctx = dialContext("p2");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      await appear(ctx, { pressAction: "clear-fueling" });
      await action.onDialDown(basicEvent(ctx, { pressAction: "clear-fueling" }) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("fill-to-max sets target to tank max and requests it", async () => {
      const ctx = dialContext("p3");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      await appear(ctx, { pressAction: "fill-to-max" });
      await action.onDialDown(basicEvent(ctx, { pressAction: "fill-to-max" }) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(110);
    });

    it("fill-to-max with unknown tank capacity does not send, warns, and stays disarmed", async () => {
      const ctx = dialContext("p4");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      // No session info -> effectiveMaxLtr() is undefined.
      mockGetSessionInfo.mockReturnValue(null);
      await appear(ctx, { pressAction: "fill-to-max" });

      mockPitFuel.mockClear();
      await action.onDialDown(basicEvent(ctx, { pressAction: "fill-to-max" }) as never);

      expect(mockPitFuel).not.toHaveBeenCalled();

      const logger = (action as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger;

      expect(logger.warn).toHaveBeenCalledWith("Fill-to-max: tank capacity unknown, skipping");
      // Not armed: a subsequent toggle requests rather than clears.
      await action.onDialDown(basicEvent(ctx, { pressAction: "toggle-fueling" }) as never);

      expect(mockPitFuel).toHaveBeenCalledTimes(1);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });
  });

  describe("onKeyDown (keypad fallback)", () => {
    it("fires the press action without rotation", async () => {
      const ctx = keyContext("k1");
      await appear(ctx, { pressAction: "clear-fueling" });
      await action.onKeyDown(basicEvent(ctx, { pressAction: "clear-fueling" }) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
    });
  });

  describe("long-press classification", () => {
    it("fires longPressAction after the hold threshold when long-press enabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", true);
      const ctx = dialContext("l1");
      await appear(ctx, { pressAction: "toggle-fueling", longPressAction: "fill-to-max" });

      await action.onDialDown(
        basicEvent(ctx, { pressAction: "toggle-fueling", longPressAction: "fill-to-max" }) as never,
      );
      vi.advanceTimersByTime(500);
      await Promise.resolve();

      // long press -> fill-to-max -> pit.fuel(110)
      expect(mockPitFuel).toHaveBeenCalledWith(110);
    });

    it("fires pressAction on a short release (below threshold)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", true);
      const ctx = dialContext("l2");
      await appear(ctx, { pressAction: "clear-fueling", longPressAction: "fill-to-max" });

      await action.onDialDown(
        basicEvent(ctx, { pressAction: "clear-fueling", longPressAction: "fill-to-max" }) as never,
      );
      vi.advanceTimersByTime(100);
      await action.onDialUp(basicEvent(ctx, { pressAction: "clear-fueling", longPressAction: "fill-to-max" }) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("fires immediately on down when long-press disabled (Mirabox)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      const ctx = dialContext("l3");
      await appear(ctx, { pressAction: "clear-fueling" });

      await action.onDialDown(basicEvent(ctx, { pressAction: "clear-fueling" }) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
    });

    it("fires pressAction once on release of a slow press when longPressAction is none", async () => {
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", true);
      const ctx = dialContext("l4");
      await appear(ctx, { pressAction: "clear-fueling", longPressAction: "none" });

      await action.onDialDown(basicEvent(ctx, { pressAction: "clear-fueling", longPressAction: "none" }) as never);
      // Hold well beyond the long-press threshold — no long-press timer was armed.
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, { pressAction: "clear-fueling", longPressAction: "none" }) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
    });
  });

  describe("onTouchTap routing", () => {
    it("routes a tap to the press action", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", true);
      const ctx = dialContext("tt1");
      await appear(ctx, { pressAction: "clear-fueling", touchScreenEnabled: true });

      await action.onTouchTap(
        touchTapEvent(ctx, { pressAction: "clear-fueling", touchScreenEnabled: true }, false) as never,
      );

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
    });

    it("routes a hold to the long-press action", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", true);
      const ctx = dialContext("tt2");
      await appear(ctx, { pressAction: "toggle-fueling", longPressAction: "fill-to-max", touchScreenEnabled: true });

      await action.onTouchTap(
        touchTapEvent(
          ctx,
          { pressAction: "toggle-fueling", longPressAction: "fill-to-max", touchScreenEnabled: true },
          true,
        ) as never,
      );

      expect(mockPitFuel).toHaveBeenCalledWith(110);
    });

    it("is ignored when touchScreenEnabled is false", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tt3");
      await appear(ctx, { pressAction: "clear-fueling", touchScreenEnabled: false });

      await action.onTouchTap(
        touchTapEvent(ctx, { pressAction: "clear-fueling", touchScreenEnabled: false }, false) as never,
      );

      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("is ignored when feedback feature flag is off", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("tt4");
      await appear(ctx, { pressAction: "clear-fueling", touchScreenEnabled: true });

      await action.onTouchTap(
        touchTapEvent(ctx, { pressAction: "clear-fueling", touchScreenEnabled: true }, false) as never,
      );

      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });
  });

  describe("touch feedback", () => {
    it("pushes feedback for a dial when enabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f1");
      await appear(ctx, { unitMode: "liters", touchScreenEnabled: true, stepSize: 1 });

      ctx.setFeedback.mockClear();
      await action.onDialRotate(
        rotateEvent(ctx, { unitMode: "liters", touchScreenEnabled: true, stepSize: 1 }, 1) as never,
      );

      expect(ctx.setFeedback).toHaveBeenCalled();
      const payload = ctx.setFeedback.mock.calls.at(-1)?.[0];

      expect(payload.value).toBe("1 / 110 L");
      expect(payload.indicator.bar_fill_c).toBe("#2ecc71");
    });

    it("does not push feedback when touchScreenEnabled is false", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f2");
      await appear(ctx, { unitMode: "liters", touchScreenEnabled: false, stepSize: 1 });

      ctx.setFeedback.mockClear();
      await action.onDialRotate(
        rotateEvent(ctx, { unitMode: "liters", touchScreenEnabled: false, stepSize: 1 }, 1) as never,
      );

      expect(ctx.setFeedback).not.toHaveBeenCalled();
    });

    it("coalesces setFeedback across rapid rotations within one throttle window", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f3");
      const settings = { unitMode: "liters", touchScreenEnabled: true, stepSize: 1 };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();

      // Several rapid rotates within a single ~100ms throttle window.
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // leading -> 1 feedback
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // coalesced -> no feedback
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // coalesced -> no feedback

      // During the window the touch strip is updated at most once (leading edge),
      // NOT once per rotate — keeps within the ≤10 setFeedback/sec/dial cap.
      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);

      // Trailing flush coalesces the tail into a single additional feedback.
      vi.advanceTimersByTime(100);

      expect(ctx.setFeedback).toHaveBeenCalledTimes(2);
      const payload = ctx.setFeedback.mock.calls.at(-1)?.[0];

      expect(payload.value).toBe("3 / 110 L");
    });
  });
});
