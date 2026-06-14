import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildReadout,
  buildTriggerDescription,
  clampTargetLtr,
  computeAddLtr,
  computeTotalLtr,
  formatDisplayValue,
  FUEL_DIAL_UUID,
  FuelDial,
  generateFuelDialSvg,
  isFuelFillOn,
  readEffectiveMaxLtr,
  readFuelLevel,
  readPitSvFuel,
  renderFuelBarSvg,
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

// PitSvFlags.FuelFill is bit 0 (value 1) in the real enum.
const FUEL_FILL = 1;

vi.mock("@iracedeck/iracing-sdk", () => ({
  DisplayUnits: { English: 0, Metric: 1 },
  PitSvFlags: { FuelFill: 1 },
  hasFlag: (value: number | undefined, flag: number) => ((value ?? 0) & flag) === flag,
}));

vi.mock("../../../icons/fuel-dial.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{titleContent}}{{iconContent}} {{backgroundColor}}</svg>',
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: () => {
      const defaults = {
        dialMode: "add-amount",
        stepSize: 1,
        pressAction: "toggle-fueling",
        longPressAction: "clear-fueling",
        touchAction: "toggle-fueling",
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
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
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
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
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

const SESSION_90L = { DriverInfo: { DriverCarFuelMaxLtr: 90, DriverCarMaxFuelPct: 1 } };
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
    it("shows total / max with suffix", () => {
      expect(buildReadout(65, 90, 1)).toBe("65 / 90 L");
    });

    it("shows -- when max unknown", () => {
      expect(buildReadout(65, undefined, 1)).toBe("65 / -- L");
    });
  });

  describe("readFuelLevel", () => {
    it("reads finite FuelLevel", () => {
      expect(readFuelLevel({ FuelLevel: 45 } as never)).toBe(45);
    });

    it("treats unknown/non-finite as 0", () => {
      expect(readFuelLevel(null)).toBe(0);
      expect(readFuelLevel({} as never)).toBe(0);
      expect(readFuelLevel({ FuelLevel: -3 } as never)).toBe(0);
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

  describe("isFuelFillOn", () => {
    it("returns true when the FuelFill flag is set", () => {
      expect(isFuelFillOn({ PitSvFlags: FUEL_FILL } as never)).toBe(true);
    });

    it("returns false when the flag is clear or telemetry missing", () => {
      expect(isFuelFillOn({ PitSvFlags: 0 } as never)).toBe(false);
      expect(isFuelFillOn({} as never)).toBe(false);
      expect(isFuelFillOn(null)).toBe(false);
    });
  });

  describe("computeAddLtr", () => {
    it("add-amount returns the dialed amount clamped to remaining space", () => {
      // current 45, max 90 -> headroom 45; dialed 20 fits
      expect(computeAddLtr("add-amount", 20, 45, 90, 1)).toBe(20);
      // dialed 60 clamped to headroom 45
      expect(computeAddLtr("add-amount", 60, 45, 90, 1)).toBe(45);
    });

    it("add-amount only enforces lower bound when capacity unknown", () => {
      expect(computeAddLtr("add-amount", 60, 45, undefined, 1)).toBe(60);
      expect(computeAddLtr("add-amount", -5, 45, undefined, 1)).toBe(0);
    });

    it("target-level returns target minus current", () => {
      // target 65, current 45 -> add 20
      expect(computeAddLtr("target-level", 65, 45, 90, 1)).toBe(20);
    });

    it("target-level rounds up so the stop never finishes under target", () => {
      // target 65, current 44.3 -> raw add 20.7 -> rounds up to 21 (metric whole unit)
      expect(computeAddLtr("target-level", 65, 44.3, 90, 1)).toBe(21);
    });

    it("target-level clamps the add to remaining tank space", () => {
      // target 90, current 50, max 90 -> raw add 40 (fits headroom 40)
      expect(computeAddLtr("target-level", 90, 50, 90, 1)).toBe(40);
      // target above capacity is impossible to over-fill: headroom caps it
      expect(computeAddLtr("target-level", 200, 50, 90, 1)).toBe(40);
    });

    it("target-level returns 0 when already at/above target", () => {
      expect(computeAddLtr("target-level", 40, 50, 90, 1)).toBe(0);
    });
  });

  describe("computeTotalLtr", () => {
    it("sums current and add", () => {
      expect(computeTotalLtr(45, 20, 90)).toBe(65);
    });

    it("caps at capacity", () => {
      expect(computeTotalLtr(80, 30, 90)).toBe(90);
    });

    it("does not cap when capacity unknown", () => {
      expect(computeTotalLtr(80, 30, undefined)).toBe(110);
    });
  });

  describe("renderFuelBarSvg", () => {
    it("renders both segments green when fuel on", () => {
      const svg = renderFuelBarSvg(45, 20, 90, true, 184, 30);

      expect(svg).toContain("<svg");
      expect(svg).toContain("#2ecc71"); // green add segment
      expect(svg).toContain("#7f93a8"); // current segment color
    });

    it("renders the add segment gray when fuel off", () => {
      const svg = renderFuelBarSvg(45, 20, 90, false, 184, 30);

      expect(svg).toContain("#888888");
      expect(svg).not.toContain("#2ecc71");
    });

    it("omits the add segment when there is nothing to add", () => {
      const svg = renderFuelBarSvg(45, 0, 90, true, 184, 30);

      expect(svg).not.toContain("#2ecc71");
    });
  });

  describe("buildTriggerDescription", () => {
    it("appends the long-press as a hold hint on push and never sets longTouch", () => {
      const desc = buildTriggerDescription({
        dialMode: "add-amount",
        pressAction: "toggle-fueling",
        longPressAction: "clear-fueling",
        touchAction: "fill-to-max",
      } as never);

      expect(desc.rotate).toBe("Adjust fuel to add");
      // Long-press of the dial button has no dedicated SDK field — it rides on push.
      expect(desc.push).toBe("Toggle fueling (hold: Clear fueling)");
      expect(desc.longTouch).toBeUndefined();
      expect(desc.touch).toBe("Fill to max");
    });

    it("uses target-level rotate label, plain push when no long-press, and omits none actions", () => {
      const desc = buildTriggerDescription({
        dialMode: "target-level",
        pressAction: "clear-fueling",
        longPressAction: "none",
        touchAction: "none",
      } as never);

      expect(desc.rotate).toBe("Adjust target level");
      expect(desc.push).toBe("Clear fueling");
      expect(desc.longTouch).toBeUndefined();
      expect(desc.touch).toBeUndefined();
    });
  });

  describe("generateFuelDialSvg", () => {
    it("produces a data URI containing the total readout value", () => {
      // current 45, add 20, max 90 -> total 65
      const result = generateFuelDialSvg({} as never, 45, 20, 90, 1, true);
      const decoded = decodeURIComponent(result);

      expect(result).toContain("data:image/svg+xml");
      expect(decoded).toContain("65 L");
    });

    it("shows -- semantics via the bar when capacity unknown but renders total", () => {
      const result = generateFuelDialSvg({} as never, 45, 20, undefined, 1, false);
      const decoded = decodeURIComponent(result);

      // total still computed (no cap) = 65
      expect(decoded).toContain("65 L");
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
    // Default telemetry: metric, no current fuel, no pending request, fuel off.
    mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
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

    it("clamps the upper bound to remaining tank space in add mode", async () => {
      const ctx = dialContext("d3");
      // 110L tank, 30L current -> headroom 80; 50 * 3 = 150 clamped to 80
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 30, PitSvFlags: 0 });
      await appear(ctx, { stepSize: 50, unitMode: "liters", dialMode: "add-amount" });
      await action.onDialRotate(
        rotateEvent(ctx, { stepSize: 50, unitMode: "liters", dialMode: "add-amount" }, 3) as never,
      );

      expect(mockPitFuel).toHaveBeenCalledWith(80);
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

  describe("dialMode add vs target", () => {
    it("target-level sends target minus current", async () => {
      const ctx = dialContext("dm1");
      // current 45 -> seed target = 45; rotate +20 -> target 65 -> add 20
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: 0 });
      const settings = { stepSize: 20, unitMode: "liters", dialMode: "target-level" };
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(20);
    });

    it("target-level rounds the add up so it never finishes under target", async () => {
      const ctx = dialContext("dm2");
      // current 44.3 -> seed target = 44.3; rotate +20.7 -> target 65 -> raw add 20.7 -> ceil 21
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 44.3, PitSvFlags: 0 });
      const settings = { stepSize: 20.7, unitMode: "liters", dialMode: "target-level" };
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(21);
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
      await action.onDialRotate(rotateEvent(ctx, { stepSize: 1, unitMode: "liters" }, 1) as never); // -> 2
      await action.onDialRotate(rotateEvent(ctx, { stepSize: 1, unitMode: "liters" }, -1) as never); // -> 1
      vi.advanceTimersByTime(100);

      // Trailing flush target equals lastSent (1) — suppressed
      expect(mockPitFuel).toHaveBeenCalledTimes(1);
    });
  });

  describe("doPress dispatch — live fuel-fill state", () => {
    it("toggle-fueling requests when fuel-fill is OFF then clears when ON", async () => {
      const ctx = dialContext("p1");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      const settings = { pressAction: "toggle-fueling", unitMode: "liters", stepSize: 1 };

      // fuel off -> dial a value first so the request is non-zero
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 10) as never); // dial 10L
      mockPitFuel.mockClear();

      // fuel off -> toggle requests the dialed amount
      await action.onDialDown(basicEvent(ctx, settings) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(10);
      expect(mockPitClearFuel).not.toHaveBeenCalled();

      // Now fuel is ON in telemetry -> toggle clears
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 10, FuelLevel: 0, PitSvFlags: FUEL_FILL });
      mockPitFuel.mockClear();
      await action.onDialDown(basicEvent(ctx, settings) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
      expect(mockPitFuel).not.toHaveBeenCalled();

      // Back OFF -> toggle requests again (alternates with the real state)
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      mockPitClearFuel.mockClear();
      await action.onDialDown(basicEvent(ctx, settings) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(10);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("clear-fueling always clears", async () => {
      const ctx = dialContext("p2");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      await appear(ctx, { pressAction: "clear-fueling" });
      await action.onDialDown(basicEvent(ctx, { pressAction: "clear-fueling" }) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("fill-to-max (add mode) requests remaining tank space", async () => {
      const ctx = dialContext("p3");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      // 110L tank, 40L current -> headroom 70
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 40, PitSvFlags: 0 });
      await appear(ctx, { pressAction: "fill-to-max", dialMode: "add-amount" });
      await action.onDialDown(basicEvent(ctx, { pressAction: "fill-to-max", dialMode: "add-amount" }) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(70);
    });

    it("fill-to-max (target mode) requests enough to reach capacity", async () => {
      const ctx = dialContext("p3b");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      // 110L tank, 40L current -> target 110 -> add 70
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 40, PitSvFlags: 0 });
      await appear(ctx, { pressAction: "fill-to-max", dialMode: "target-level" });
      await action.onDialDown(basicEvent(ctx, { pressAction: "fill-to-max", dialMode: "target-level" }) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(70);
    });

    it("fill-to-max with unknown tank capacity does not send and warns", async () => {
      const ctx = dialContext("p4");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      mockGetSessionInfo.mockReturnValue(null);
      await appear(ctx, { pressAction: "fill-to-max" });

      mockPitFuel.mockClear();
      await action.onDialDown(basicEvent(ctx, { pressAction: "fill-to-max" }) as never);

      expect(mockPitFuel).not.toHaveBeenCalled();

      const logger = (action as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger;

      expect(logger.warn).toHaveBeenCalledWith("Fill-to-max: tank capacity unknown, skipping");
    });
  });

  describe("target-level top-up timer", () => {
    it("recomputes and re-sends every 30s while fuel-fill is on", async () => {
      const ctx = dialContext("tt-timer1");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const settings = { stepSize: 1, unitMode: "liters", dialMode: "target-level", pressAction: "toggle-fueling" };
      // Fuel ON, current 45, requested add 20 -> seed target = current + add = 65; timer arms on appear
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      await appear(ctx, settings);
      mockPitFuel.mockClear();

      // Fuel burned: current now 40 -> add must grow to 25 to still reach 65
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 40, PitSvFlags: FUEL_FILL });
      vi.advanceTimersByTime(30000);

      expect(mockPitFuel).toHaveBeenCalledWith(25);
    });

    it("does not re-send when fuel-fill is off (respects toggle-off)", async () => {
      const ctx = dialContext("tt-timer2");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      const settings = { stepSize: 65, unitMode: "liters", dialMode: "target-level" };
      // Fuel OFF
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: 0 });
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);
      vi.advanceTimersByTime(100);
      mockPitFuel.mockClear();

      // Advance well past the recompute interval — no timer should fire while off
      vi.advanceTimersByTime(60000);

      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("stops the top-up timer immediately when clear-fueling is pressed", async () => {
      const ctx = dialContext("tt-timer-clear");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const settings = { stepSize: 1, unitMode: "liters", dialMode: "target-level", pressAction: "clear-fueling" };
      // Fuel ON, current 45, requested add 20 -> seed target 65; timer arms on appear.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      await appear(ctx, settings);
      mockPitFuel.mockClear();

      // Press clear. Telemetry still reports fuel-fill ON (the flag flips on a
      // later tick), so the timer must be stopped explicitly, not via syncTargetTimer.
      await action.onDialDown(basicEvent(ctx, settings) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);

      // Advance past the recompute interval — the stopped timer must not re-send.
      vi.advanceTimersByTime(30000);

      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("does not run the timer in add-amount mode", async () => {
      const ctx = dialContext("tt-timer3");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      const settings = { stepSize: 20, unitMode: "liters", dialMode: "add-amount" };
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);
      vi.advanceTimersByTime(100);
      mockPitFuel.mockClear();

      vi.advanceTimersByTime(60000);

      expect(mockPitFuel).not.toHaveBeenCalled();
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
      // 110L tank, 0 current -> fill-to-max add 110
      await appear(ctx, { pressAction: "toggle-fueling", longPressAction: "fill-to-max" });

      await action.onDialDown(
        basicEvent(ctx, { pressAction: "toggle-fueling", longPressAction: "fill-to-max" }) as never,
      );
      vi.advanceTimersByTime(500);
      await Promise.resolve();

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
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, { pressAction: "clear-fueling", longPressAction: "none" }) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
    });
  });

  describe("onTouchTap routing", () => {
    it("routes a tap to the configured touch action", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tt1");
      await appear(ctx, { touchAction: "clear-fueling" });

      await action.onTouchTap(touchTapEvent(ctx, { touchAction: "clear-fueling" }, false) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
    });

    it("does nothing when touchAction is none", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tt2");
      await appear(ctx, { touchAction: "none" });

      await action.onTouchTap(touchTapEvent(ctx, { touchAction: "none" }, false) as never);

      expect(mockPitClearFuel).not.toHaveBeenCalled();
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("is ignored when feedback feature flag is off", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("tt4");
      await appear(ctx, { touchAction: "clear-fueling" });

      await action.onTouchTap(touchTapEvent(ctx, { touchAction: "clear-fueling" }, false) as never);

      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("routes a tap to fill-to-max", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tt5");
      await appear(ctx, { touchAction: "fill-to-max" });

      await action.onTouchTap(touchTapEvent(ctx, { touchAction: "fill-to-max" }, false) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(110);
    });
  });

  describe("touch feedback — two-segment bar", () => {
    it("pushes a pixmap bar and the total readout for a dial", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f1");
      // current 45, max 90; dial +20 -> total 65
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 20 };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(ctx.setFeedback).toHaveBeenCalled();
      const payload = ctx.setFeedback.mock.calls.at(-1)?.[0];

      expect(payload.value).toBe("65 / 90 L");
      expect(typeof payload.bar).toBe("string");
      expect(payload.bar).toContain("data:image/svg+xml");
      // Bar is green because fuel-fill is on
      expect(decodeURIComponent(payload.bar)).toContain("#2ecc71");
    });

    it("shows -- in the readout when capacity unknown", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f1b");
      mockGetSessionInfo.mockReturnValue(null);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: 0 });
      const settings = { unitMode: "liters", stepSize: 20 };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      const payload = ctx.setFeedback.mock.calls.at(-1)?.[0];

      expect(payload.value).toBe("65 / -- L");
    });

    it("coalesces setFeedback across rapid rotations within one throttle window", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f3");
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      const settings = { unitMode: "liters", stepSize: 1 };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // leading -> 1 feedback
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // coalesced
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // coalesced

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(100);

      expect(ctx.setFeedback).toHaveBeenCalledTimes(2);
      const payload = ctx.setFeedback.mock.calls.at(-1)?.[0];

      expect(payload.value).toBe("3 / 110 L");
    });
  });

  describe("dynamic trigger descriptions", () => {
    it("sets trigger descriptions on appear for a dial (add mode)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tr1");
      await appear(ctx, {
        dialMode: "add-amount",
        pressAction: "toggle-fueling",
        longPressAction: "none",
        touchAction: "clear-fueling",
      });

      expect(ctx.setTriggerDescription).toHaveBeenCalledWith(
        expect.objectContaining({ rotate: "Adjust fuel to add", push: "Toggle fueling", touch: "Clear fueling" }),
      );
      const desc = ctx.setTriggerDescription.mock.calls.at(-1)?.[0];

      expect(desc.longTouch).toBeUndefined();
    });

    it("appends the long-press hold hint to push and leaves longTouch unset", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tr1b");
      await appear(ctx, {
        dialMode: "add-amount",
        pressAction: "toggle-fueling",
        longPressAction: "clear-fueling",
        touchAction: "none",
      });

      const desc = ctx.setTriggerDescription.mock.calls.at(-1)?.[0];

      expect(desc.push).toBe("Toggle fueling (hold: Clear fueling)");
      expect(desc.longTouch).toBeUndefined();
    });

    it("sets trigger descriptions on settings change (target mode)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tr2");
      await appear(ctx, { dialMode: "add-amount" });
      ctx.setTriggerDescription.mockClear();

      await action.onDidReceiveSettings(
        basicEvent(ctx, {
          dialMode: "target-level",
          pressAction: "fill-to-max",
          longPressAction: "none",
          touchAction: "none",
        }) as never,
      );

      expect(ctx.setTriggerDescription).toHaveBeenCalledWith(
        expect.objectContaining({ rotate: "Adjust target level", push: "Fill to max" }),
      );
      const desc = ctx.setTriggerDescription.mock.calls.at(-1)?.[0];

      expect(desc.touch).toBeUndefined();
      expect(desc.longTouch).toBeUndefined();
    });

    it("does not set trigger descriptions for a keypad context", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = keyContext("tr3");
      await appear(ctx, {});

      expect(ctx.setTriggerDescription).not.toHaveBeenCalled();
    });

    it("does not set trigger descriptions when feedback flag is off", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("tr4");
      await appear(ctx, {});

      expect(ctx.setTriggerDescription).not.toHaveBeenCalled();
    });
  });
});
