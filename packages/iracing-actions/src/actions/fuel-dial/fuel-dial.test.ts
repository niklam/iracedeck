import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTitleText,
  buildTriggerDescription,
  buildValueText,
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
  roundedBarPath,
  roundToWholeDisplayLtr,
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

  describe("buildValueText", () => {
    it("add-amount shows +add = total with suffix", () => {
      // add 20, total 65
      expect(buildValueText("add-amount", 20, 65, 65, 1)).toBe("+20 = 65 L");
    });

    it("add-amount caps the total at capacity in the readout (caller computes total)", () => {
      // total already capped to 90 by computeTotalLtr; add 30
      expect(buildValueText("add-amount", 30, 90, 90, 1)).toBe("+30 = 90 L");
    });

    it("fill-to shows the integer target with an arrow", () => {
      expect(buildValueText("fill-to", 20, 65, 65, 1)).toBe("→ 65 L");
    });

    it("fill-to still shows the target when capacity unknown", () => {
      expect(buildValueText("fill-to", 20, 65, 65, 1)).toBe("→ 65 L");
    });

    it("converts to gallons in english mode", () => {
      // 65L ≈ 17.2 gal target
      expect(buildValueText("fill-to", 0, 65, 65, 0)).toBe("→ 17.2 gal");
    });
  });

  describe("roundToWholeDisplayLtr", () => {
    it("snaps liters to a whole liter in metric", () => {
      expect(roundToWholeDisplayLtr(64.7, 1)).toBe(65);
      expect(roundToWholeDisplayLtr(64.2, 1)).toBe(64);
    });

    it("snaps to a whole gallon in english (rounds in display units)", () => {
      // 100L ≈ 26.42 gal -> rounds to 26 gal -> 26 * 3.78541 ≈ 98.42 L
      expect(roundToWholeDisplayLtr(100, 0)).toBeCloseTo(26 * 3.78541, 4);
    });
  });

  describe("roundedBarPath", () => {
    it("emits arc commands for a fully-rounded segment", () => {
      const d = roundedBarPath(0, 100, 30, true, true, 8);

      expect(d).toContain("A "); // arcs present on both ends
      expect(d.startsWith("M ")).toBe(true);
      expect(d.endsWith("Z")).toBe(true);
    });

    it("omits arcs on a square boundary (right end square)", () => {
      // current segment: left rounded, right square (butted onto add)
      const d = roundedBarPath(0, 50, 30, true, false, 8);
      const arcCount = (d.match(/A /g) ?? []).length;

      // Only the left end (2 corners) carries arcs.
      expect(arcCount).toBe(2);
    });

    it("uses no arcs when both ends are square", () => {
      const d = roundedBarPath(10, 40, 30, false, false, 8);

      expect(d).not.toContain("A ");
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
    it("add-amount returns the dialed amount as the FIXED add (no auto-change)", () => {
      // current 45, max 90; dialed 20 is the requested add — NOT reduced by current
      expect(computeAddLtr("add-amount", 20, 45, 90, 1)).toBe(20);
      // current 80, dialed 20 stays 20 even though headroom is only 10 (iRacing clamps at the pump)
      expect(computeAddLtr("add-amount", 20, 80, 90, 1)).toBe(20);
    });

    it("add-amount spans the full tank range [0, capacity], not remaining space", () => {
      // dialed 90 (= full tank) with 45 current is allowed; clamp is capacity, not headroom
      expect(computeAddLtr("add-amount", 90, 45, 90, 1)).toBe(90);
      // dialed above capacity clamps to capacity
      expect(computeAddLtr("add-amount", 120, 45, 90, 1)).toBe(90);
    });

    it("add-amount only enforces lower bound when capacity unknown", () => {
      expect(computeAddLtr("add-amount", 120, 45, undefined, 1)).toBe(120);
      expect(computeAddLtr("add-amount", -5, 45, undefined, 1)).toBe(0);
    });

    it("add-amount sends the dialed add verbatim (no fill-to round-up touches it)", () => {
      // The fill-to round-up must never touch add-amount mode.
      expect(computeAddLtr("add-amount", 48, 42, 100, 1)).toBe(48);
      expect(computeAddLtr("add-amount", 20, 45, 90, 1)).toBe(20);
    });

    it("fill-to returns target minus current, rounded UP to a whole display unit (no buffer)", () => {
      // target 90, current 43.9 -> need 46.1 -> ceil 47 (issue #681)
      expect(computeAddLtr("fill-to", 90, 43.9, 110, 1)).toBe(47);
      // target 90, current 44.0 -> need 46.0 -> already whole -> 46 (no +1)
      expect(computeAddLtr("fill-to", 90, 44.0, 110, 1)).toBe(46);
      // a whole-number gap is not bumped up: target 65, current 45 -> need 20 -> 20
      expect(computeAddLtr("fill-to", 65, 45, 90, 1)).toBe(20);
    });

    it("fill-to rounds the add UP so current + add never finishes under target", () => {
      // target 65, current 45.3 -> rawAdd 19.7 -> rounds up to 20 (no buffer)
      expect(computeAddLtr("fill-to", 65, 45.3, 110, 1)).toBe(20);
      // current + add = 45.3 + 20 = 65.3 >= 65, so the stop finishes at/above target
      expect(45.3 + computeAddLtr("fill-to", 65, 45.3, 110, 1)).toBeGreaterThanOrEqual(65);
      // a tiny fractional gap rounds up to a full whole unit
      expect(computeAddLtr("fill-to", 65, 64.1, 110, 1)).toBe(1); // ceil(0.9)=1
    });

    it("fill-to rounds the add UP in display units (english/gallons)", () => {
      // displayUnits 0 (gallons): rawAdd in liters is rounded up to a whole gallon.
      // target 100L, current 90L -> rawAdd 10L ≈ 2.64 gal -> ceil 3 gal -> 3*3.78541 ≈ 11.36 L
      expect(computeAddLtr("fill-to", 100, 90, 200, 0)).toBeCloseTo(3 * 3.78541, 4);
    });

    it("fill-to clamps the add to remaining tank space at the full tank", () => {
      // target == capacity 90, current 42 -> need 48, headroom 48 -> 48.
      expect(computeAddLtr("fill-to", 90, 42, 90, 1)).toBe(48);
      // target 90, current 50, max 90 -> need 40, headroom 40 -> 40.
      expect(computeAddLtr("fill-to", 90, 50, 90, 1)).toBe(40);
      // target above capacity is impossible to over-fill: headroom caps it.
      expect(computeAddLtr("fill-to", 200, 50, 90, 1)).toBe(40);
    });

    it("fill-to returns 0 when already at/above target (so the 0 → clearFuel path fires)", () => {
      // need ≤ 0 must resolve to exactly 0 so the 0 → clearFuel path still fires.
      expect(computeAddLtr("fill-to", 40, 50, 90, 1)).toBe(0);
      expect(computeAddLtr("fill-to", 50, 50, 90, 1)).toBe(0);
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
    it("renders the add segment green when fuel on, current segment neutral", () => {
      const svg = renderFuelBarSvg(45, 20, 90, true, 184, 30, 1);

      expect(svg).toContain("<svg");
      expect(svg).toContain("#2ecc71"); // green add segment
      expect(svg).toContain("#9aa7b4"); // neutral current segment color
    });

    it("renders the add segment gray when fuel off", () => {
      const svg = renderFuelBarSvg(45, 20, 90, false, 184, 30, 1);

      expect(svg).toContain("#888888");
      expect(svg).not.toContain("#2ecc71");
    });

    it("omits the add segment when there is nothing to add", () => {
      const svg = renderFuelBarSvg(45, 0, 90, true, 184, 30, 1);

      expect(svg).not.toContain("#2ecc71");
    });

    it("uses paths for the segments (rounded outer corners, square boundary) — no clipPath", () => {
      const svg = renderFuelBarSvg(45, 20, 90, true, 184, 30, 1);

      expect(svg).toContain("<path");
      expect(svg).not.toContain("clipPath");
    });

    it("renders on-bar amount labels (current LEFT dark, +add RIGHT white)", () => {
      const svg = renderFuelBarSvg(45, 20, 90, true, 184, 30, 1);

      expect(svg).toContain('text-anchor="start"');
      expect(svg).toContain('text-anchor="end"');
      expect(svg).toContain(">45<"); // current amount
      expect(svg).toContain(">+20<"); // to-be-added amount
      // The +add label is white (sits over the green/gray add segment); the
      // current label is dark (sits over the light current segment).
      expect(svg).toContain('fill="#ffffff"'); // +add label
      expect(svg).toContain('fill="#0d1117"'); // current label
    });

    it("omits a segment label when its segment is too narrow to hold it", () => {
      // Tiny add (1L of a 90L tank) -> add segment far too narrow for "+1".
      const svg = renderFuelBarSvg(45, 1, 90, true, 184, 30, 1);

      // The current segment is wide enough; its label shows.
      expect(svg).toContain(">45<");
      // The add segment is too narrow; its label is omitted (no over-track text).
      expect(svg).not.toContain(">+1<");
    });

    it("draws a RED target line ONLY when a target is supplied (fill-to mode)", () => {
      const withTarget = renderFuelBarSvg(45, 20, 90, true, 184, 30, 1, 65);

      // The target marker is a red rect.
      expect(withTarget).toContain('fill="#e74c3c"');
    });

    it("omits the target line in add-amount mode (no target supplied)", () => {
      const withoutTarget = renderFuelBarSvg(45, 20, 90, true, 184, 30, 1);

      // No red marker rect when no target is supplied.
      expect(withoutTarget).not.toContain('fill="#e74c3c"');
    });

    it("confines the target line to the full bar height (no overhang, unpadded viewBox)", () => {
      const svg = renderFuelBarSvg(45, 20, 90, true, 184, 30, 1, 65);

      // The viewBox spans exactly the bar (no vertical padding) so the track +
      // segments fill the full pixmap rect.
      const vb = /viewBox="0 (-?\d+(?:\.\d+)?) 184 (\d+(?:\.\d+)?)"/.exec(svg);

      expect(vb).not.toBeNull();
      expect(Number(vb![1])).toBe(0); // y-origin at 0, no top padding
      expect(Number(vb![2])).toBe(30); // exactly the bar height

      // The red marker rect spans the full bar height (y=0, height=bar) — confined.
      const line = /<rect[^>]*fill="#e74c3c"[^>]*\/>/.exec(svg)?.[0] ?? "";
      const lineY = /y="(-?\d+(?:\.\d+)?)"/.exec(line);
      const lineH = /height="(\d+(?:\.\d+)?)"/.exec(line);

      expect(Number(lineY?.[1])).toBe(0);
      expect(Number(lineH?.[1])).toBe(30);
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

    it("uses fill-to rotate label, plain push when no long-press, and omits none actions", () => {
      const desc = buildTriggerDescription({
        dialMode: "fill-to",
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
    it("add-amount: produces a data URI containing the +add = total readout and mode-aware title", () => {
      // current 45, add 20, max 90 -> total 65
      const result = generateFuelDialSvg({ dialMode: "add-amount" } as never, 45, 20, 90, 1, true, 65);
      const decoded = decodeURIComponent(result);

      expect(result).toContain("data:image/svg+xml");
      expect(decoded).toContain("+20 = 65 L");
      // Mode-aware title replaces the static "FUEL".
      expect(decoded).toContain("Add Fuel");
    });

    it("fill-to: shows the integer target with an arrow and the Fuel Target title", () => {
      const result = generateFuelDialSvg({ dialMode: "fill-to" } as never, 45, 20, 90, 1, true, 65);
      const decoded = decodeURIComponent(result);

      expect(decoded).toContain("→ 65 L");
      expect(decoded).toContain("Fuel Target");
    });

    it("renders total even when capacity unknown (add-amount, no cap)", () => {
      const result = generateFuelDialSvg({ dialMode: "add-amount" } as never, 45, 20, undefined, 1, false, 65);
      const decoded = decodeURIComponent(result);

      // total still computed (no cap) = 65
      expect(decoded).toContain("+20 = 65 L");
    });
  });

  describe("buildTitleText", () => {
    it("is mode-aware: Add Fuel vs Fuel Target", () => {
      expect(buildTitleText("add-amount")).toBe("Add Fuel");
      expect(buildTitleText("fill-to")).toBe("Fuel Target");
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

    it("clamps the upper bound to the FULL tank capacity in add mode (not remaining space)", async () => {
      const ctx = dialContext("d3");
      // 110L tank, 30L current; 50 * 3 = 150 clamped to capacity 110 (NOT headroom 80)
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 30, PitSvFlags: 0 });
      await appear(ctx, { stepSize: 50, unitMode: "liters", dialMode: "add-amount" });
      await action.onDialRotate(
        rotateEvent(ctx, { stepSize: 50, unitMode: "liters", dialMode: "add-amount" }, 3) as never,
      );

      expect(mockPitFuel).toHaveBeenCalledWith(110);
    });

    it("clamps the lower bound to 0 and CLEARS instead of sending pit.fuel(0) (issue #681)", async () => {
      const ctx = dialContext("d4");
      await appear(ctx, { stepSize: 5, unitMode: "liters" });
      await action.onDialRotate(rotateEvent(ctx, { stepSize: 5, unitMode: "liters" }, -3) as never);

      // The dialed add clamps to 0; a resolved add of 0 clears fueling rather than
      // sending pit.fuel(0) (which the SDK reads as "keep existing", not "zero").
      expect(mockPitClearFuel).toHaveBeenCalled();
      expect(mockPitFuel).not.toHaveBeenCalledWith(0);
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
    it("fill-to sends target minus current (no buffer)", async () => {
      const ctx = dialContext("dm1");
      // current 45 -> seed target = 45; rotate +20 -> target 65 -> need 20 -> 20
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: 0 });
      const settings = { stepSize: 20, unitMode: "liters", dialMode: "fill-to" };
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(20);
    });

    it("fill-to snaps the target to a whole integer and rounds the add UP on rotate (no buffer)", async () => {
      const ctx = dialContext("dm2");
      // current 44.3 -> seed target snaps to 44; rotate +20.7 -> 64.7 -> snaps to 65.
      // rawAdd = 65 - 44.3 = 20.7 -> rounds UP to a whole liter = 21.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 44.3, PitSvFlags: 0 });
      const settings = { stepSize: 20.7, unitMode: "liters", dialMode: "fill-to" };
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      // The add is rounded up so current + add (44.3 + 21 = 65.3) lands at/above the target.
      expect(mockPitFuel).toHaveBeenCalledWith(21);
    });

    it("fill-to keeps the displayed target an integer as the dial steps (no buffer)", async () => {
      const ctx = dialContext("dm3");
      // current 40 -> seed target snaps to 40; rotate +25.4 -> 65.4 -> snaps to 65 -> need 25 -> 25
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 40, PitSvFlags: 0 });
      const settings = { stepSize: 25.4, unitMode: "liters", dialMode: "fill-to" };
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      // target snaps 65.4 -> 65; need = 65 - 40 = 25 -> 25
      expect(mockPitFuel).toHaveBeenCalledWith(25);
    });
  });

  describe("target-mode telemetry re-seed (issue #681)", () => {
    /** Pulls the telemetry callback registered by onWillAppear via the mocked subscribe. */
    function telemetryCallback(): (telemetry: unknown) => void {
      const subscribe = (action as unknown as { sdkController: { subscribe: ReturnType<typeof vi.fn> } }).sdkController
        .subscribe;
      const call = subscribe.mock.calls.at(-1);

      return call?.[1] as (telemetry: unknown) => void;
    }

    /** Reads the dialed target (liters) off the action's private context map. */
    function dialValue(id: string): number {
      const contexts = (action as unknown as { contextsState: Map<string, { dialValueLtr: number }> }).contextsState;

      return contexts.get(id)?.dialValueLtr ?? Number.NaN;
    }

    it("fill-to does NOT drift the target as fuel burns past the grace window", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("ts1");
      // current 45, fuel ON, stale PitSvFuel 20 -> seed target = 65.
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 1, dialMode: "fill-to" };
      await appear(ctx, settings);

      // Set the target explicitly via rotate so it is the user's chosen value (65).
      await action.onDialRotate(rotateEvent(ctx, settings, 0) as never);

      expect(dialValue("ts1")).toBe(65);

      // Move past the user-activity grace window so re-seeds are eligible.
      vi.advanceTimersByTime(4000);

      const onTick = telemetryCallback();

      // Fuel burns down with a STALE PitSvFuel (still 20). Old code would re-seed
      // target = current + 20, lowering it every tick. The fix must keep it at 65.
      for (const fuel of [44, 42, 40, 38, 36]) {
        onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: fuel, PitSvFlags: FUEL_FILL });
      }

      expect(dialValue("ts1")).toBe(65);
    });

    it("add-amount STILL re-seeds the dialed add from telemetry past the grace window", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("ts2");
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: 0 });
      await appear(ctx, { unitMode: "liters", stepSize: 1, dialMode: "add-amount" });

      // Seed on appear is PitSvFuel = 20.
      expect(dialValue("ts2")).toBe(20);

      vi.advanceTimersByTime(4000);

      const onTick = telemetryCallback();

      // A new requested add arrives via telemetry -> add mode tracks it.
      onTick({ DisplayUnits: 1, PitSvFuel: 35, FuelLevel: 45, PitSvFlags: 0 });

      expect(dialValue("ts2")).toBe(35);
    });
  });

  describe("target-mode round-up on send (issue #681)", () => {
    it("rounds the add UP so current + add reaches at least the integer target (no buffer)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("ru1");
      // capacity 110, current 45.3, target 65 -> rawAdd 19.7 -> rounds up to 20.
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45.3, PitSvFlags: 0 });
      // Seed target = 45 (snap of 45.3), then rotate +20 -> target 65.
      const settings = { unitMode: "liters", stepSize: 20, dialMode: "fill-to" };
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      // rawAdd = 65 - 45.3 = 19.7 -> ceil(19.7) = 20 (45.3 + 20 = 65.3 ≥ 65).
      expect(mockPitFuel).toHaveBeenLastCalledWith(20);
      const sent = mockPitFuel.mock.calls.at(-1)?.[0] as number;

      expect(45.3 + sent).toBeGreaterThanOrEqual(65);
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

    it("fill-to-max (add mode) requests the FULL tank capacity as the add (issue #681)", async () => {
      const ctx = dialContext("p3");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      // 110L tank, 40L current -> add the full tank's worth (capacity = 110), NOT headroom 70.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 40, PitSvFlags: 0 });
      await appear(ctx, { pressAction: "fill-to-max", dialMode: "add-amount" });
      await action.onDialDown(basicEvent(ctx, { pressAction: "fill-to-max", dialMode: "add-amount" }) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(110);
    });

    it("fill-to-max (fill-to mode) targets capacity (add = enough to reach capacity)", async () => {
      const ctx = dialContext("p3b");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      // 110L tank, 40L current -> target 110 -> add 70
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 40, PitSvFlags: 0 });
      await appear(ctx, { pressAction: "fill-to-max", dialMode: "fill-to" });
      await action.onDialDown(basicEvent(ctx, { pressAction: "fill-to-max", dialMode: "fill-to" }) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(70);
    });

    it("fill-to-max TOGGLES: second invocation drops the amount to ~empty (1 L) (issue #681)", async () => {
      const ctx = dialContext("p3c");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      // 110L tank, 0L current -> add-amount mode so the resulting add equals the dialed value.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      const settings = { pressAction: "fill-to-max", dialMode: "add-amount" };
      await appear(ctx, settings);

      // First invocation -> full capacity.
      await action.onDialDown(basicEvent(ctx, settings) as never);

      expect(mockPitFuel).toHaveBeenLastCalledWith(110);

      // Second invocation while at max -> drops to ~empty (1 L).
      await action.onDialDown(basicEvent(ctx, settings) as never);

      expect(mockPitFuel).toHaveBeenLastCalledWith(1);

      // Third invocation -> back to full capacity (alternates).
      await action.onDialDown(basicEvent(ctx, settings) as never);

      expect(mockPitFuel).toHaveBeenLastCalledWith(110);
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

  describe("resolved-0 add clears instead of pit.fuel(0) (issue #681)", () => {
    it("fill-to: Fill-to-max 'empty' (target ~1 L, current > 1) clears and never sends pit.fuel(0)", async () => {
      const ctx = dialContext("z1");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      // 110L tank, current 45. fill-to mode so the dialed value is the TARGET.
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: 0 });
      const settings = { pressAction: "fill-to-max", dialMode: "fill-to" };
      await appear(ctx, settings);

      // First invocation -> target = capacity (110) -> add = 110 - 45 = 65.
      await action.onDialDown(basicEvent(ctx, settings) as never);

      expect(mockPitFuel).toHaveBeenLastCalledWith(65);
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();

      // Second invocation while at max -> target drops to ~1 L. With current 45 the
      // resolved add is 0, which must clear, NOT send pit.fuel(0).
      await action.onDialDown(basicEvent(ctx, settings) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
      expect(mockPitFuel).not.toHaveBeenCalled();
      expect(mockPitFuel).not.toHaveBeenCalledWith(0);
    });

    it("add-amount: dialing the add down to 0 clears and never sends pit.fuel(0)", async () => {
      const ctx = dialContext("z2");
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      const settings = { stepSize: 5, unitMode: "liters", dialMode: "add-amount" };
      await appear(ctx, settings);

      // Dial up to 5, then back down to 0.
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // -> 5, leading send
      vi.advanceTimersByTime(100); // flush trailing window
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never); // -> 0
      vi.advanceTimersByTime(100); // flush trailing window

      // The resolved add is 0 -> clearFuel, never pit.fuel(0).
      expect(mockPitClearFuel).toHaveBeenCalled();
      expect(mockPitFuel).not.toHaveBeenCalledWith(0);
    });

    it("non-zero adds still call pit.fuel(addLtr) (FILL_TO_MAX_MIN_LTR=1 add-amount path sends pit.fuel(1))", async () => {
      const ctx = dialContext("z3");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      // 110L tank, 0 current, add-amount mode so the resolved add equals the dialed value.
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      const settings = { pressAction: "fill-to-max", dialMode: "add-amount" };
      await appear(ctx, settings);

      // First invocation -> full capacity (non-zero add).
      await action.onDialDown(basicEvent(ctx, settings) as never);

      expect(mockPitFuel).toHaveBeenLastCalledWith(110);

      // Second invocation while at max -> add-amount FILL_TO_MAX_MIN_LTR = 1 add.
      // A 1 L add is non-zero, so it sends pit.fuel(1), it does NOT clear.
      mockPitClearFuel.mockClear();
      await action.onDialDown(basicEvent(ctx, settings) as never);

      expect(mockPitFuel).toHaveBeenLastCalledWith(1);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });
  });

  describe("continuous fill-to monitoring (issue #681)", () => {
    /** Pulls the telemetry callback registered by onWillAppear via the mocked subscribe. */
    function telemetryCallback(): (telemetry: unknown) => void {
      const subscribe = (action as unknown as { sdkController: { subscribe: ReturnType<typeof vi.fn> } }).sdkController
        .subscribe;
      const call = subscribe.mock.calls.at(-1);

      return call?.[1] as (telemetry: unknown) => void;
    }

    it("re-sends only when the whole-unit add changes as fuel burns (fuel-fill ON)", async () => {
      const ctx = dialContext("cm1");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const settings = { stepSize: 1, unitMode: "liters", dialMode: "fill-to", pressAction: "toggle-fueling" };
      // Fuel ON, current 44.0, requested add 46 -> seed target = current + add = 90.
      mockGetCurrentTelemetry.mockReturnValue({
        DisplayUnits: 1,
        PitSvFuel: 46,
        FuelLevel: 44.0,
        PitSvFlags: FUEL_FILL,
      });
      await appear(ctx, settings);

      const onTick = telemetryCallback();

      // Prime the re-send baseline: the first tick computes add = 90 - 44.0 = 46 and
      // broadcasts it (lastSentLtr was null after appear).
      onTick({ DisplayUnits: 1, PitSvFuel: 46, FuelLevel: 44.0, PitSvFlags: FUEL_FILL });
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();

      // Tick at 44.0 again: add = 90 - 44.0 = 46 (unchanged) -> NO re-send.
      mockGetCurrentTelemetry.mockReturnValue({
        DisplayUnits: 1,
        PitSvFuel: 46,
        FuelLevel: 44.0,
        PitSvFlags: FUEL_FILL,
      });
      onTick({ DisplayUnits: 1, PitSvFuel: 46, FuelLevel: 44.0, PitSvFlags: FUEL_FILL });

      expect(mockPitFuel).not.toHaveBeenCalled();

      // Fuel burns to 43.9: need 46.1 -> ceil 47 (whole-unit add changed 46 -> 47) -> re-send.
      mockGetCurrentTelemetry.mockReturnValue({
        DisplayUnits: 1,
        PitSvFuel: 46,
        FuelLevel: 43.9,
        PitSvFlags: FUEL_FILL,
      });
      onTick({ DisplayUnits: 1, PitSvFuel: 46, FuelLevel: 43.9, PitSvFlags: FUEL_FILL });

      expect(mockPitFuel).toHaveBeenCalledTimes(1);
      expect(mockPitFuel).toHaveBeenLastCalledWith(47);
    });

    it("does NOT re-send on the first tick after a fill-to ROTATE (flushSend keeps lastSentWholeAdd in sync)", async () => {
      // Regression (issue #681): flushSend must mirror doPress and update
      // ctx.lastSentWholeAdd, else the first telemetry tick after a rotate sees a
      // stale gate value and emits ONE redundant pit.fuel for the same whole-unit add.
      const ctx = dialContext("cm-rotate");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      // Fuel ON, current 44.0, target above current. seed target = 44.0 + 0 = 44.
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({
        DisplayUnits: 1,
        PitSvFuel: 0,
        FuelLevel: 44.0,
        PitSvFlags: FUEL_FILL,
      });
      const settings = { stepSize: 20, unitMode: "liters", dialMode: "fill-to", pressAction: "toggle-fueling" };
      await appear(ctx, settings);

      // Rotate +20 -> target 64; broadcasts add = 64 - 44.0 = 20 (leading edge),
      // then flush the trailing throttle window so flushSend runs.
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);
      vi.advanceTimersByTime(100);

      const callCountBefore = mockPitFuel.mock.calls.length;

      const onTick = telemetryCallback();

      // ONE telemetry tick with the SAME FuelLevel: the whole-unit add is unchanged
      // (still 20), so the continuous monitor must NOT re-broadcast.
      onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 44.0, PitSvFlags: FUEL_FILL });

      expect(mockPitFuel.mock.calls.length).toBe(callCountBefore);
    });

    it("does NOT spam pit.fuel per tick when filling to (near) full, then re-sends once across a whole-unit boundary", async () => {
      // Regression for the headroom-clamp spam (issue #681): with the target AT
      // capacity, computeAddLtr clamps the rounded-up add to the FRACTIONAL
      // headroom (maxLtr − currentLtr), which drifts sub-litre every tick. Gating
      // on the raw add re-broadcast pit.fuel ~60×/sec; gating on the WHOLE-unit
      // add must broadcast at most once per whole litre.
      const ctx = dialContext("cm-full");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      // 90L tank, target == capacity (90). Fuel ON, current 43.92.
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({
        DisplayUnits: 1,
        PitSvFuel: 46,
        FuelLevel: 43.92,
        PitSvFlags: FUEL_FILL,
      });
      const settings = { stepSize: 1, unitMode: "liters", dialMode: "fill-to", pressAction: "toggle-fueling" };
      await appear(ctx, settings);

      const onTick = telemetryCallback();

      // Prime the re-send baseline: first tick at 43.92 computes the clamped add
      // (headroom = 90 − 43.92 = 46.08, rounded-up need 47 → clamped to 46.08) and
      // broadcasts it (lastSentWholeAdd was null after appear).
      onTick({ DisplayUnits: 1, PitSvFuel: 46, FuelLevel: 43.92, PitSvFlags: FUEL_FILL });
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();

      // Several ticks burning WITHIN the same whole litre (43.92 → 43.90 → 43.88).
      // The clamped fractional add drifts every tick, but the whole-unit add stays
      // 46 — so NOT a single re-send across these ticks.
      for (const fuel of [43.9, 43.88, 43.85, 43.81]) {
        mockGetCurrentTelemetry.mockReturnValue({
          DisplayUnits: 1,
          PitSvFuel: 46,
          FuelLevel: fuel,
          PitSvFlags: FUEL_FILL,
        });
        onTick({ DisplayUnits: 1, PitSvFuel: 46, FuelLevel: fuel, PitSvFlags: FUEL_FILL });
      }

      expect(mockPitFuel).not.toHaveBeenCalled();

      // Drop across the whole-litre boundary (43.81 → 42.95): the whole-unit add
      // moves 46 → 47 (round(90 − 42.95) = round(47.05) = 47) → exactly ONE re-send.
      mockGetCurrentTelemetry.mockReturnValue({
        DisplayUnits: 1,
        PitSvFuel: 46,
        FuelLevel: 42.95,
        PitSvFlags: FUEL_FILL,
      });
      onTick({ DisplayUnits: 1, PitSvFuel: 46, FuelLevel: 42.95, PitSvFlags: FUEL_FILL });

      expect(mockPitFuel).toHaveBeenCalledTimes(1);
    });

    it("does NOT re-send on ticks where the whole-unit add is unchanged", async () => {
      const ctx = dialContext("cm2");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const settings = { stepSize: 1, unitMode: "liters", dialMode: "fill-to", pressAction: "toggle-fueling" };
      // Fuel ON, current 44.0, target 90 (seed = 44.0 + 46).
      mockGetCurrentTelemetry.mockReturnValue({
        DisplayUnits: 1,
        PitSvFuel: 46,
        FuelLevel: 44.0,
        PitSvFlags: FUEL_FILL,
      });
      await appear(ctx, settings);

      const onTick = telemetryCallback();

      // Prime the re-send baseline (add 46) so subsequent same-add ticks are no-ops.
      onTick({ DisplayUnits: 1, PitSvFuel: 46, FuelLevel: 44.0, PitSvFlags: FUEL_FILL });
      mockPitFuel.mockClear();

      // Several ticks within the same whole-unit add window (44.0 .. 44.05): add stays 46.
      for (const fuel of [44.0, 44.02, 44.05, 44.0]) {
        mockGetCurrentTelemetry.mockReturnValue({
          DisplayUnits: 1,
          PitSvFuel: 46,
          FuelLevel: fuel,
          PitSvFlags: FUEL_FILL,
        });
        onTick({ DisplayUnits: 1, PitSvFuel: 46, FuelLevel: fuel, PitSvFlags: FUEL_FILL });
      }

      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("clears (not pit.fuel(0)) when the add hits 0 as fuel reaches the target", async () => {
      const ctx = dialContext("cm3");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const settings = { stepSize: 1, unitMode: "liters", dialMode: "fill-to", pressAction: "toggle-fueling" };
      // Fuel ON, current 64, target 65 (seed = 64 + 1).
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 1, FuelLevel: 64, PitSvFlags: FUEL_FILL });
      await appear(ctx, settings);

      const onTick = telemetryCallback();

      // Prime the re-send baseline with the non-zero add (1) at current 64.
      onTick({ DisplayUnits: 1, PitSvFuel: 1, FuelLevel: 64, PitSvFlags: FUEL_FILL });
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();

      // Current rises to the target (65): add = 0 -> clears, never pit.fuel(0).
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 1, FuelLevel: 65, PitSvFlags: FUEL_FILL });
      onTick({ DisplayUnits: 1, PitSvFuel: 1, FuelLevel: 65, PitSvFlags: FUEL_FILL });

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
      expect(mockPitFuel).not.toHaveBeenCalledWith(0);
    });

    it("does NOT re-send when fuel-fill is OFF (respects toggle-off)", async () => {
      const ctx = dialContext("cm4");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const settings = { stepSize: 65, unitMode: "liters", dialMode: "fill-to" };
      // Fuel OFF.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: 0 });
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // target 110
      vi.advanceTimersByTime(100);
      mockPitFuel.mockClear();

      const onTick = telemetryCallback();

      // Fuel burns with fuel-fill OFF — no re-send regardless of how the add moves.
      for (const fuel of [44, 43.9, 42, 41.5]) {
        mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: fuel, PitSvFlags: 0 });
        onTick({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: fuel, PitSvFlags: 0 });
      }

      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("add-amount: the add stays fixed as fuel burns (no continuous re-send)", async () => {
      const ctx = dialContext("cm5");
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const settings = { stepSize: 20, unitMode: "liters", dialMode: "add-amount" };
      // Fuel ON, current 45, add 20.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 0) as never);
      vi.advanceTimersByTime(100);
      mockPitFuel.mockClear();

      const onTick = telemetryCallback();

      // Fuel burns; PitSvFuel stays 20 — add-amount must not re-send as fuel drops.
      for (const fuel of [44, 43.9, 42, 40]) {
        mockGetCurrentTelemetry.mockReturnValue({
          DisplayUnits: 1,
          PitSvFuel: 20,
          FuelLevel: fuel,
          PitSvFlags: FUEL_FILL,
        });
        onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: fuel, PitSvFlags: FUEL_FILL });
      }

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

  describe("touch feedback — continuous two-segment bar", () => {
    it("pushes a pixmap bar and the +add = total readout (add mode) for a dial", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f1");
      // current 45, max 90; dial +20 -> add 20, total 65
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 20, dialMode: "add-amount" };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(ctx.setFeedback).toHaveBeenCalled();
      const payload = ctx.setFeedback.mock.calls.at(-1)?.[0];

      expect(payload.value).toBe("+20 = 65 L");
      expect(typeof payload.bar).toBe("string");
      expect(payload.bar).toContain("data:image/svg+xml");
      // Bar is green because fuel-fill is on
      expect(decodeURIComponent(payload.bar)).toContain("#2ecc71");
      // No red target line in add mode.
      expect(decodeURIComponent(payload.bar)).not.toContain('fill="#e74c3c"');
    });

    it("pushes the target readout and a target line in fill-to mode", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f1t");
      // current 45, max 90; seed target = 45, rotate +20 -> target 65 -> add 20
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 20, dialMode: "fill-to" };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      const payload = ctx.setFeedback.mock.calls.at(-1)?.[0];

      expect(payload.value).toBe("→ 65 L");
      // Red target line present in fill-to mode.
      expect(decodeURIComponent(payload.bar)).toContain('fill="#e74c3c"');
    });

    it("renders the readout when capacity unknown (add mode, no cap)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f1b");
      mockGetSessionInfo.mockReturnValue(null);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: 0 });
      const settings = { unitMode: "liters", stepSize: 20, dialMode: "add-amount" };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      const payload = ctx.setFeedback.mock.calls.at(-1)?.[0];

      expect(payload.value).toBe("+20 = 65 L");
    });

    it("coalesces setFeedback across rapid rotations within one throttle window", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f3");
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      const settings = { unitMode: "liters", stepSize: 1, dialMode: "add-amount" };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // leading -> 1 feedback
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // coalesced
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // coalesced

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(100);

      expect(ctx.setFeedback).toHaveBeenCalledTimes(2);
      const payload = ctx.setFeedback.mock.calls.at(-1)?.[0];

      expect(payload.value).toBe("+3 = 3 L");
    });
  });

  describe("display refresh cadence (issue #681)", () => {
    /** Pulls the telemetry callback registered by onWillAppear via the mocked subscribe. */
    function telemetryCallback(): (telemetry: unknown) => void {
      const subscribe = (action as unknown as { sdkController: { subscribe: ReturnType<typeof vi.fn> } }).sdkController
        .subscribe;
      const call = subscribe.mock.calls.at(-1);

      return call?.[1] as (telemetry: unknown) => void;
    }

    it("re-renders the bar + value on the 5s display timer to track live burn", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("dr1");
      // current 45, max 90; fill-to seed 45, fuel off
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: 0 });
      const settings = { unitMode: "liters", stepSize: 1, dialMode: "fill-to" };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();

      // No event fires; only the 5s timer should push feedback.
      vi.advanceTimersByTime(5000);

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5000);

      expect(ctx.setFeedback).toHaveBeenCalledTimes(2);
    });

    it("does NOT push setFeedback on every telemetry tick", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("dr2");
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: 0 });
      await appear(ctx, { unitMode: "liters", dialMode: "add-amount" });

      const onTick = telemetryCallback();

      ctx.setFeedback.mockClear();

      // Simulate many telemetry ticks (no time advance — no timer should fire).
      for (let i = 0; i < 60; i++) {
        onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45 - i * 0.1, PitSvFlags: 0 });
      }

      expect(ctx.setFeedback).not.toHaveBeenCalled();
    });

    it("pushes feedback on CHANGE when the displayed signature moves (fuel-fill flip)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("dr-change1");
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      // Start fuel OFF.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: 0 });
      await appear(ctx, { unitMode: "liters", dialMode: "add-amount" });

      const onTick = telemetryCallback();

      // Advance past the change-render throttle window so a change can push.
      vi.advanceTimersByTime(200);
      ctx.setFeedback.mockClear();

      // Fuel-fill flips ON — the displayed signature changes -> push immediately.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);
      // Bar reflects the new ON color (green).
      const payload = ctx.setFeedback.mock.calls.at(-1)?.[0];

      expect(decodeURIComponent(payload.bar)).toContain("#2ecc71");
    });

    it("does NOT push feedback on a tick that leaves the displayed signature unchanged", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("dr-change2");
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: 0 });
      await appear(ctx, { unitMode: "liters", dialMode: "add-amount" });

      const onTick = telemetryCallback();

      vi.advanceTimersByTime(200);
      ctx.setFeedback.mockClear();

      // Identical telemetry -> same rounded signature -> no feedback push.
      onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: 0 });
      onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: 0 });

      expect(ctx.setFeedback).not.toHaveBeenCalled();
    });

    it("throttles change-driven pushes to at most once per ~100ms", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("dr-change3");
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: 0 });
      await appear(ctx, { unitMode: "liters", dialMode: "add-amount" });

      const onTick = telemetryCallback();

      // Past the user-activity grace window so add-mode re-seeds the dialed add
      // from PitSvFuel (making the displayed signature track the request).
      vi.advanceTimersByTime(3100);
      ctx.setFeedback.mockClear();

      // First changing tick pushes; an immediate second changing tick is throttled.
      onTick({ DisplayUnits: 1, PitSvFuel: 21, FuelLevel: 45, PitSvFlags: 0 });
      onTick({ DisplayUnits: 1, PitSvFuel: 22, FuelLevel: 45, PitSvFlags: 0 });

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);

      // After the throttle window, another change pushes again.
      vi.advanceTimersByTime(100);
      onTick({ DisplayUnits: 1, PitSvFuel: 23, FuelLevel: 45, PitSvFlags: 0 });

      expect(ctx.setFeedback).toHaveBeenCalledTimes(2);
    });

    it("fill-to: a target change at/below current fuel (add stays 0) refreshes the signature", async () => {
      // In fill-to mode the displayed target (dialValueLtr) can move while the
      // resolved add stays 0 (target dialed at/below current fuel). The signature
      // must include the target in fill-to mode so the readout refreshes promptly
      // instead of waiting up to 5 s for the heartbeat (issue #681).
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      const ctx = dialContext("dr-target-sig");
      // 110L tank, current 50, fuel ON. Seed target = current + PitSvFuel = 50.
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 50, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 5, dialMode: "fill-to" };
      await appear(ctx, settings);

      const sig = (ctx2: { dialValueLtr: number }) =>
        (action as unknown as { displayedSignature: (c: unknown) => string }).displayedSignature(ctx2 as never);

      const contexts = (action as unknown as { contextsState: Map<string, { dialValueLtr: number }> }).contextsState;
      const liveCtx = contexts.get("dr-target-sig")!;

      // Dial the target DOWN below current fuel (50 -> 30). The add stays 0 (target
      // <= current), but the displayed target changed.
      const before = sig(liveCtx);

      await action.onDialRotate(rotateEvent(ctx, settings, -4) as never); // -20 -> target 30

      const after = sig(liveCtx);

      // The resolved add is still 0 in both states, yet the signature differs
      // because the fill-to target component moved.
      expect(after).not.toBe(before);
    });

    it("fill-to: dialing the target below current fuel (add stays 0) pushes the new readout promptly", async () => {
      // Regression for the signature fix (issue #681): when the target is dialed
      // at/below current fuel the resolved add stays 0, but the readout/target line
      // must still refresh promptly rather than waiting up to 5 s. Assert the
      // feedback is pushed with the new target without advancing the 5 s heartbeat.
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      vi.stubGlobal("__FEATURE_DIAL_LONG_PRESS__", false);
      const ctx = dialContext("dr-target-push");
      // 110L tank, current 50, fuel ON. Seed target = 50; add resolves to 0.
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 50, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 5, dialMode: "fill-to" };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();

      // Dial the target DOWN below current fuel (50 -> 30). add stays 0.
      await action.onDialRotate(rotateEvent(ctx, settings, -4) as never); // target -> 30
      vi.advanceTimersByTime(100); // flush the rotate's trailing send window

      // Feedback was pushed without any 5 s heartbeat advance, and shows the new
      // target (proving the displayed target tracks the dial even at add 0).
      expect(ctx.setFeedback).toHaveBeenCalled();
      const payload = ctx.setFeedback.mock.calls.at(-1)?.[0];

      expect(payload.value).toBe("→ 30 L");
    });

    it("clears the display timer on disappear (no leaks, no re-render after)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("dr3");
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 1, dialMode: "fill-to" };
      await appear(ctx, settings);

      await action.onWillDisappear(basicEvent(ctx, settings) as never);

      ctx.setFeedback.mockClear();
      mockPitFuel.mockClear();

      // Past the 5s display refresh — the cleared timer must not re-render.
      vi.advanceTimersByTime(60000);

      expect(ctx.setFeedback).not.toHaveBeenCalled();
      expect(mockPitFuel).not.toHaveBeenCalled();
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
          dialMode: "fill-to",
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
