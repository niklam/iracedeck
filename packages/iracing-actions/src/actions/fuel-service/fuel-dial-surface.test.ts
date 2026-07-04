import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDialReadout,
  buildRefuelBandText,
  buildTriggerDescription,
  buildValueText,
  clampTargetLtr,
  computeAddLtr,
  computeTotalLtr,
  formatDisplayValue,
  readEffectiveMaxLtr,
  readFuelLevel,
  readPitSvFuel,
  renderFuelBarSvg,
  renderStripCanvasSvg,
  resolveDialDisplayMode,
  resolveFuelFillState,
  roundedBarPath,
  roundToWholeDisplayLtr,
} from "./fuel-dial-surface.js";
import { resolveDisplayUnits } from "./fuel-service-settings.js";
import { FUEL_SERVICE_UUID, FuelService } from "./fuel-service.js";

const {
  mockPitClearFuel,
  mockPitFuel,
  mockGetCommands,
  mockGetSessionInfo,
  mockGetCurrentTelemetry,
  mockTapBinding,
  mockDualPressThreshold,
} = vi.hoisted(() => ({
  mockPitClearFuel: vi.fn(() => true),
  mockPitFuel: vi.fn((_liters: number) => true),
  mockGetCommands: vi.fn(() => ({
    pit: { clearFuel: mockPitClearFuel, fuel: mockPitFuel },
  })),
  mockGetSessionInfo: vi.fn<() => unknown>(() => null),
  mockGetCurrentTelemetry: vi.fn<() => unknown>(() => null),
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  // Mutable "Long-press threshold" global setting value (ms) for tests.
  mockDualPressThreshold: { value: 500 },
}));

// PitSvFlags.FuelFill is bit 4 (value 16 / 0x0010) in the real enum.
const FUEL_FILL = 0x0010;

vi.mock("@iracedeck/iracing-sdk", () => ({
  DisplayUnits: { English: 0, Metric: 1 },
  PitSvFlags: { FuelFill: 0x0010 },
  hasFlag: (value: number | undefined, flag: number) => ((value ?? 0) & flag) === flag,
}));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
    // REAL zod semantics for the extended settings schema (defaults, the `dial`
    // prefault, enum validation) — only the CommonSettings base fields are absent.
    CommonSettings: {
      extend: (shape: never) => z.object(shape).passthrough(),
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
      setActiveBinding = vi.fn();
      tapBinding = mockTapBinding;
      holdBinding = vi.fn().mockResolvedValue(undefined);
      releaseBinding = vi.fn().mockResolvedValue(undefined);
      isBindingMissing = vi.fn(() => false);
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
    // #612 binding-missing overlay — appends a recognizable marker for assertions.
    applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
    fuelToDisplayUnits: vi.fn((liters: number, displayUnits: number | undefined) =>
      displayUnits === 1 ? liters : liters * 0.264172,
    ),
    fuelFromDisplayUnits: vi.fn((amount: number, displayUnits: number | undefined) =>
      displayUnits === 1 ? amount : amount * 3.78541,
    ),
    getFuelUnitSuffix: vi.fn((displayUnits: number | undefined) => (displayUnits === 1 ? "L" : "gal")),
    // "Long-press threshold" global setting reader (drives the dial release classifier).
    getDualPressThresholdMs: () => mockDualPressThreshold.value,
    // Shared dial-gesture convention (release-time classifier + paired-action resolver).
    DIAL_LONG_PRESS_THRESHOLD_MS: 500,
    classifyDialRelease: (args: {
      pressStartMs: number;
      nowMs: number;
      rotatedWhilePressed: boolean;
      thresholdMs?: number;
    }) => {
      if (args.rotatedWhilePressed) return "push-turn";

      return args.nowMs - args.pressStartMs >= (args.thresholdMs ?? 500) ? "long" : "short";
    },
    resolvePairedAction: (pair: { cw: unknown; ccw: unknown } | null | undefined, ticks: number) => {
      if (!pair) return null;

      if (ticks > 0) return pair.cw;

      if (ticks < 0) return pair.ccw;

      return null;
    },
    // Shared fuel telemetry readers (extracted to deck-core); behave like the real impls.
    isFuelFillOn: (t: any) => !!t && t.PitSvFlags !== undefined && (t.PitSvFlags & 0x10) === 0x10,
    isAutofuelActive: (t: any) => !!t && t.dpFuelAutoFillActive !== undefined && t.dpFuelAutoFillActive !== 0,
    isAutofuelEnabled: (t: any) => (!t || t.dpFuelAutoFillEnabled === undefined ? true : t.dpFuelAutoFillEnabled !== 0),
    // Keypad-icon exports used by fuel-service.ts (not exercised by the dial suite).
    assembleIcon: vi.fn(() => "data:image/svg+xml,assembled"),
    resolveGraphicSettings: vi.fn(() => ({ scaleMode: "inherit" as const, scale: 100 })),
    getGlobalGraphicSettings: vi.fn(() => ({})),
    getGlobalSettings: vi.fn(() => ({})),
    generateTitleText: vi.fn(() => ""),
    gallonsToLiters: (gallons: number) => gallons * 3.78541,
  };
});

// fuel-service.ts pulls the keypad icon SVGs; vitest has no .svg loader, so mock them.
vi.mock("../../../icons/fuel-service.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{iconContent}} {{backgroundColor}}</svg>',
}));
vi.mock("@iracedeck/icons/fuel-service/add-fuel.svg", () => ({
  default: "<svg>add-fuel-icon</svg>",
}));
vi.mock("@iracedeck/icons/fuel-service/reduce-fuel.svg", () => ({
  default: "<svg>reduce-fuel-icon</svg>",
}));
vi.mock("@iracedeck/icons/fuel-service/set-fuel-amount.svg", () => ({
  default: "<svg>set-fuel-amount-icon</svg>",
}));
vi.mock("@iracedeck/icons/fuel-service/clear-fuel.svg", () => ({
  default: "<svg>clear-fuel-icon</svg>",
}));
vi.mock("@iracedeck/icons/fuel-service/toggle-autofuel.svg", () => ({
  default: "<svg>toggle-autofuel-icon</svg>",
}));
vi.mock("@iracedeck/icons/fuel-service/lap-margin-increase.svg", () => ({
  default: "<svg>lap-margin-increase-icon</svg>",
}));
vi.mock("@iracedeck/icons/fuel-service/lap-margin-decrease.svg", () => ({
  default: "<svg>lap-margin-decrease-icon</svg>",
}));

/**
 * Translates this suite's FLAT dial settings (the pre-#759 Fuel Dial shape) into
 * the merged Fuel Service shape: dial fields under the `dial` root, `unitMode`
 * mapped onto the shared `unit`. Applied inside the event helpers so the test
 * bodies keep the original literals.
 */
function toMergedSettings(flat: Record<string, unknown> = {}): Record<string, unknown> {
  const {
    dialMode,
    stepSize,
    pressAction,
    longPressAction,
    pushTurnAction,
    tapAction,
    longTouchAction,
    unitMode,
    ...rest
  } = flat;
  const dial: Record<string, unknown> = {};

  if (dialMode !== undefined) dial.mode = dialMode;

  if (stepSize !== undefined) dial.stepSize = stepSize;

  if (pressAction !== undefined) dial.pressAction = pressAction;

  if (longPressAction !== undefined) dial.longPressAction = longPressAction;

  if (pushTurnAction !== undefined) dial.pushTurnAction = pushTurnAction;

  if (tapAction !== undefined) dial.tapAction = tapAction;

  if (longTouchAction !== undefined) dial.longTouchAction = longTouchAction;

  const merged: Record<string, unknown> = { ...rest, dial };

  if (unitMode !== undefined) {
    merged.unit = unitMode === "liters" ? "l" : unitMode === "gallons" ? "g" : unitMode;
  }

  return merged;
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

function rotateEvent(
  action: ReturnType<typeof dialContext>,
  settings: Record<string, unknown>,
  ticks: number,
  pressed = false,
) {
  return { action, payload: { settings: toMergedSettings(settings), ticks, pressed } };
}

function basicEvent(action: ReturnType<typeof dialContext>, settings: Record<string, unknown> = {}) {
  return { action, payload: { settings: toMergedSettings(settings) } };
}

function touchTapEvent(action: ReturnType<typeof dialContext>, settings: Record<string, unknown>, hold: boolean) {
  return { action, payload: { settings: toMergedSettings(settings), tapPos: [0, 0] as [number, number], hold } };
}

/** Decodes the strip's full-canvas pixmap (the `box` feedback key) to raw SVG. */
function stripCanvas(payload: { box?: string } | undefined): string {
  return decodeURIComponent(String(payload?.box ?? ""));
}

/** Pulls the telemetry callback registered by onWillAppear via the mocked subscribe. */
function getTelemetryCallback(act: FuelService): (telemetry: unknown) => void {
  const subscribe = (act as unknown as { sdkController: { subscribe: ReturnType<typeof vi.fn> } }).sdkController
    .subscribe;

  return subscribe.mock.calls.at(-1)?.[1] as (telemetry: unknown) => void;
}

const SESSION_90L = { DriverInfo: { DriverCarFuelMaxLtr: 90, DriverCarMaxFuelPct: 1 } };
const SESSION_110L = { DriverInfo: { DriverCarFuelMaxLtr: 110, DriverCarMaxFuelPct: 1 } };

describe("fuel-dial-surface pure helpers", () => {
  describe("resolveDisplayUnits", () => {
    it("forces metric for liters", () => {
      expect(resolveDisplayUnits("l", 0)).toBe(1);
    });

    it("forces english for gallons", () => {
      expect(resolveDisplayUnits("g", 1)).toBe(0);
    });

    it("follows telemetry in auto mode", () => {
      expect(resolveDisplayUnits("auto", 0)).toBe(0);
      expect(resolveDisplayUnits("auto", 1)).toBe(1);
    });

    it("defaults to metric in auto mode when telemetry unknown", () => {
      expect(resolveDisplayUnits("auto", undefined)).toBe(1);
    });

    it("treats keypad-only kg like auto (no dial representation)", () => {
      expect(resolveDisplayUnits("k", 0)).toBe(0);
      expect(resolveDisplayUnits("k", 1)).toBe(1);
      expect(resolveDisplayUnits("k", undefined)).toBe(1);
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

    it("fill-to does NOT clamp the add to remaining tank space at the full tank (#681)", () => {
      // target == capacity 90, current 41.9 -> need 48.1 -> ceil 49 (NOT clamped to
      // headroom 48.1/48). The request may exceed the CURRENT remaining space because
      // more fuel burns before the stop; iRacing fills only up to capacity anyway.
      expect(computeAddLtr("fill-to", 90, 41.9, 90, 1)).toBe(49);
      // target 90, current 43.9 -> need 46.1 -> ceil 47 (unclamped).
      expect(computeAddLtr("fill-to", 90, 43.9, 90, 1)).toBe(47);
      // target 90, current 44.0 -> need 46.0 -> already whole -> 46.
      expect(computeAddLtr("fill-to", 90, 44.0, 90, 1)).toBe(46);
      // target 90, current 0 -> need 90 -> 90 (add never exceeds capacity since target ≤ capacity).
      expect(computeAddLtr("fill-to", 90, 0, 90, 1)).toBe(90);
      // a whole-number gap at full tank is not bumped: target 90, current 50 -> 40.
      expect(computeAddLtr("fill-to", 90, 50, 90, 1)).toBe(40);
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
      const svg = renderFuelBarSvg(45, 20, 90, "on", 184, 30, 1);

      expect(svg).toContain("<svg");
      expect(svg).toContain("#2ecc71"); // green add segment
      expect(svg).toContain("#9aa7b4"); // neutral current segment color
    });

    it("renders the add segment gray when fuel off — the top band carries the loud state", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "off", 184, 30, 1);

      expect(svg).toMatch(/<path[^>]*fill="#888888"/);
      expect(svg).not.toContain("#2ecc71");
      expect(svg).not.toContain("#e74c3c");
    });

    it("renders the add segment gray when the fueling state is unknown (n/a)", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "na", 184, 30, 1);

      expect(svg).toMatch(/<path[^>]*fill="#888888"/);
      expect(svg).not.toContain("#2ecc71");
      expect(svg).not.toContain("#e74c3c");
    });

    it("draws no outline around the track (the status band is the indicator)", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "off", 184, 30, 1);

      expect(svg).not.toContain('fill="none"');
      expect(svg).not.toContain("stroke=");
    });

    it("omits the add segment when there is nothing to add", () => {
      const svg = renderFuelBarSvg(45, 0, 90, "on", 184, 30, 1);

      expect(svg).not.toMatch(/<path[^>]*fill="#2ecc71"/);
    });

    it("uses paths for the segments (rounded outer corners, square boundary) — no clipPath", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "on", 184, 30, 1);

      expect(svg).toContain("<path");
      expect(svg).not.toContain("clipPath");
    });

    it("renders on-bar amount labels (current LEFT dark, +add RIGHT white)", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "on", 184, 30, 1);

      expect(svg).toContain('text-anchor="start"');
      expect(svg).toContain('text-anchor="end"');
      expect(svg).toContain(">45<"); // current amount
      expect(svg).toContain(">+20<"); // to-be-added amount
      // The +add label is white (sits over the green/red/gray add segment); the
      // current label is dark (sits over the light current segment).
      expect(svg).toContain('fill="#ffffff"'); // +add label
      expect(svg).toContain('fill="#0d1117"'); // current label
    });

    it("omits a segment label when its segment is too narrow to hold it", () => {
      // Tiny add (1L of a 90L tank) -> add segment far too narrow for "+1".
      const svg = renderFuelBarSvg(45, 1, 90, "on", 184, 30, 1);

      // The current segment is wide enough; its label shows.
      expect(svg).toContain(">45<");
      // The add segment is too narrow; its label is omitted (no over-track text).
      expect(svg).not.toContain(">+1<");
    });

    it("caps the add segment to the track when current + add exceeds capacity (#681)", () => {
      // The sent add may now make current + add > capacity (e.g. 41.9 + 49 = 90.9 in
      // a 90 L tank), since the request is the amount NEEDED to reach the target and
      // more fuel burns before the stop. The bar must still cap the green segment to
      // the track — never overflow past the right edge.
      const widthPx = 184;
      const svg = renderFuelBarSvg(41.9, 49, 90, "on", widthPx, 30, 1);

      // Every path's geometry stays within [0, widthPx]: pull all x-like numeric
      // coordinates from the segment paths and assert none exceeds the track width
      // (allow a hair for rounding).
      const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);

      expect(paths.length).toBeGreaterThan(0);

      for (const d of paths) {
        // Coordinates appear as "<num> <num>" pairs; the first of each pair is x.
        const coords = [...d.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)];

        for (const [, x] of coords) {
          expect(Number(x)).toBeLessThanOrEqual(widthPx + 0.01);
          expect(Number(x)).toBeGreaterThanOrEqual(-0.01);
        }
      }
    });

    it("draws a RED target line ONLY when a target is supplied (fill-to mode)", () => {
      const withTarget = renderFuelBarSvg(45, 20, 90, "on", 184, 30, 1, 65);

      // The target marker is a red rect.
      expect(withTarget).toContain('fill="#e74c3c"');
    });

    it("omits the target line in add-amount mode (no target supplied)", () => {
      const withoutTarget = renderFuelBarSvg(45, 20, 90, "on", 184, 30, 1);

      // No red marker rect when no target is supplied.
      expect(withoutTarget).not.toContain('fill="#e74c3c"');
    });

    it("keeps the target marker RED when fueling is off (the gray add segment gives it contrast)", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "off", 184, 30, 1, 65);

      expect(svg).toMatch(/<rect[^>]*fill="#e74c3c"/);
    });

    it("confines the target line to the full bar height (no overhang, unpadded viewBox)", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "on", 184, 30, 1, 65);

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
    it("rides the dial-button long-press on push as a hold hint; Tap Display → touch", () => {
      const desc = buildTriggerDescription({
        mode: "add-amount",
        pressAction: "toggle-fueling",
        longPressAction: "toggle-autofuel-mode",
        pushTurnAction: "none",
        tapAction: "fill-to-max",
        longTouchAction: "none",
      } as never);

      expect(desc.rotate).toBe("Adjust fuel / autofuel margin");
      // The dial-button long press has no dedicated SDK field — it rides on push.
      expect(desc.push).toBe("Toggle fueling (hold: Toggle autofuel)");
      expect(desc.longTouch).toBeUndefined();
      expect(desc.touch).toBe("Toggle full / no fuel");
    });

    it("uses the fill-to rotate label, plain push when no long-press, and omits none slots", () => {
      const desc = buildTriggerDescription({
        mode: "fill-to",
        pressAction: "fill-to-max",
        longPressAction: "none",
        pushTurnAction: "none",
        tapAction: "none",
        longTouchAction: "none",
      } as never);

      expect(desc.rotate).toBe("Adjust target / autofuel margin");
      expect(desc.push).toBe("Toggle full / no fuel");
      expect(desc.longTouch).toBeUndefined();
      expect(desc.touch).toBeUndefined();
    });

    it("maps the Long Touch slot to longTouch", () => {
      const desc = buildTriggerDescription({
        mode: "add-amount",
        pressAction: "none",
        longPressAction: "none",
        pushTurnAction: "none",
        tapAction: "none",
        longTouchAction: "toggle-autofuel-mode",
      } as never);

      expect(desc.longTouch).toBe("Toggle autofuel");
      expect(desc.push).toBeUndefined();
    });
  });

  describe("buildRefuelBandText", () => {
    it("reads REFUEL: ON / REFUEL: OFF in manual mode", () => {
      expect(buildRefuelBandText("manual", "on")).toBe("REFUEL: ON");
      expect(buildRefuelBandText("manual", "off")).toBe("REFUEL: OFF");
    });

    it("reads REFUEL: N/A when the manual fueling state is unknown", () => {
      expect(buildRefuelBandText("manual", "na")).toBe("REFUEL: N/A");
    });

    it("reads AUTOFUEL: ON / AUTOFUEL: OFF in autofuel mode", () => {
      expect(buildRefuelBandText("autofuel", "on")).toBe("AUTOFUEL: ON");
      expect(buildRefuelBandText("autofuel", "off")).toBe("AUTOFUEL: OFF");
    });

    it("reads AUTOFUEL: N/A when autofuel is engaged but unavailable", () => {
      expect(buildRefuelBandText("autofuel-off", "na")).toBe("AUTOFUEL: N/A");
      expect(buildRefuelBandText("autofuel-off", "on")).toBe("AUTOFUEL: N/A");
    });
  });

  describe("resolveDialDisplayMode", () => {
    it("is manual when autofuel is not active", () => {
      expect(resolveDialDisplayMode({ dpFuelAutoFillActive: 0 } as never)).toBe("manual");
      expect(resolveDialDisplayMode({} as never)).toBe("manual");
      expect(resolveDialDisplayMode(null)).toBe("manual");
    });

    it("is autofuel when active and enabled (enabled defaults true when absent)", () => {
      expect(resolveDialDisplayMode({ dpFuelAutoFillActive: 1, dpFuelAutoFillEnabled: 1 } as never)).toBe("autofuel");
      expect(resolveDialDisplayMode({ dpFuelAutoFillActive: 1 } as never)).toBe("autofuel");
    });

    it("is autofuel-off when active but disabled for the car/series", () => {
      expect(resolveDialDisplayMode({ dpFuelAutoFillActive: 1, dpFuelAutoFillEnabled: 0 } as never)).toBe(
        "autofuel-off",
      );
    });
  });

  describe("resolveFuelFillState", () => {
    it("is on/off from the live fuel-fill checkbox", () => {
      expect(resolveFuelFillState("manual", { PitSvFlags: FUEL_FILL } as never)).toBe("on");
      expect(resolveFuelFillState("manual", { PitSvFlags: 0 } as never)).toBe("off");
      expect(resolveFuelFillState("autofuel", { PitSvFlags: FUEL_FILL } as never)).toBe("on");
      expect(resolveFuelFillState("autofuel", { PitSvFlags: 0 } as never)).toBe("off");
    });

    it("is n/a when there is no telemetry (mirrors Fuel Service)", () => {
      expect(resolveFuelFillState("manual", null)).toBe("na");
    });

    it("is n/a when autofuel is engaged but unavailable, regardless of the checkbox", () => {
      expect(resolveFuelFillState("autofuel-off", { PitSvFlags: FUEL_FILL } as never)).toBe("na");
      expect(resolveFuelFillState("autofuel-off", { PitSvFlags: 0 } as never)).toBe("na");
    });
  });

  describe("buildDialReadout", () => {
    it("autofuel shows the intended add as AUTO → <add> <u>", () => {
      expect(buildDialReadout("autofuel", "add-amount", 48, 90, 90, 1)).toBe("AUTO → 48 L");
    });

    it("autofuel-off shows a dash", () => {
      expect(buildDialReadout("autofuel-off", "add-amount", 0, 45, 45, 1)).toBe("—");
    });

    it("manual delegates to buildValueText", () => {
      expect(buildDialReadout("manual", "add-amount", 20, 65, 65, 1)).toBe("+20 = 65 L");
      expect(buildDialReadout("manual", "fill-to", 20, 65, 65, 1)).toBe("→ 65 L");
    });
  });

  describe("renderStripCanvasSvg", () => {
    it("is a full 200×100 canvas with the status band, readout, and bar", () => {
      const svg = renderStripCanvasSvg("manual", "add-amount", "on", 45, 20, 65, 65, 90, 1);

      expect(svg).toContain('viewBox="0 0 200 100"');
      // Green band with the REFUEL: ON cue.
      expect(svg).toMatch(/<path[^>]*fill="#2ecc71"/);
      expect(svg).toContain("REFUEL: ON");
      // Readout and the two-segment bar.
      expect(svg).toContain(">+20 = 65 L<");
      expect(svg).toContain("#9aa7b4");
    });

    it("draws a red REFUEL: OFF band when fueling is off", () => {
      const svg = renderStripCanvasSvg("manual", "add-amount", "off", 45, 20, 65, 65, 90, 1);

      expect(svg).toMatch(/<path[^>]*fill="#e74c3c"/);
      expect(svg).toContain("REFUEL: OFF");
      expect(svg).not.toContain("#2ecc71");
    });

    it("draws the red target line in manual fill-to mode only", () => {
      const fillTo = renderStripCanvasSvg("manual", "fill-to", "on", 45, 20, 65, 65, 90, 1);
      const addMode = renderStripCanvasSvg("manual", "add-amount", "on", 45, 20, 65, 65, 90, 1);
      const autofuel = renderStripCanvasSvg("autofuel", "add-amount", "on", 45, 20, 65, 65, 90, 1);

      expect(fillTo).toMatch(/<rect[^>]*fill="#e74c3c"/);
      expect(addMode).not.toMatch(/<rect[^>]*fill="#e74c3c"/);
      expect(autofuel).not.toMatch(/<rect[^>]*fill="#e74c3c"/);
    });

    it("shows the AUTOFUEL band and AUTO readout in autofuel mode", () => {
      const svg = renderStripCanvasSvg("autofuel", "add-amount", "on", 45, 30, 75, 75, 90, 1);

      expect(svg).toContain("AUTOFUEL: ON");
      expect(svg).toContain(">AUTO → 30 L<");
    });

    it("shows a gray AUTOFUEL: N/A band and dash readout when autofuel is unavailable", () => {
      const svg = renderStripCanvasSvg("autofuel-off", "add-amount", "na", 45, 0, 45, 45, 90, 1);

      expect(svg).toContain("AUTOFUEL: N/A");
      expect(svg).toMatch(/<path[^>]*fill="#888888"/);
      expect(svg).toContain(">—<");
    });

    it("positions texts by explicit baselines (QT ignores dominant-baseline) — nudged down", () => {
      const svg = renderStripCanvasSvg("manual", "add-amount", "on", 45, 20, 65, 65, 90, 1);

      // The deck app's QT renderer ignores dominant-baseline, so y is the text
      // BASELINE; the values sit texts vertically centered in their areas.
      expect(svg).not.toContain("dominant-baseline");
      expect(svg).toContain('y="21"'); // band text baseline (band 0..30)
      expect(svg).toContain('y="56"'); // readout baseline (band→bar gap 30..66)
    });

    it("dims the content and draws the #612 warning glyph when the autofuel binding is missing", () => {
      const without = renderStripCanvasSvg("manual", "add-amount", "on", 45, 20, 65, 65, 90, 1);
      const withWarn = renderStripCanvasSvg("manual", "add-amount", "on", 45, 20, 65, 65, 90, 1, true);

      expect(without).not.toContain("binding-warning");
      expect(withWarn).toContain("binding-warning");
    });
  });

  it("exposes the action UUID", () => {
    expect(FUEL_SERVICE_UUID).toBe("com.iracedeck.sd.core.fuel-service");
  });
});

describe("FuelService dial surface", () => {
  let action: FuelService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockGetSessionInfo.mockReturnValue(SESSION_110L);
    // Default telemetry: metric, no current fuel, no pending request, fuel off.
    mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
    action = new FuelService();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function appear(ctx: ReturnType<typeof dialContext>, settings: Record<string, unknown> = {}) {
    await action.onWillAppear(basicEvent(ctx, settings) as never);
  }

  /**
   * A short dial-button press: down then immediate up (0 elapsed → short press →
   * pressAction). The new model fires nothing on down and classifies at up.
   */
  async function pressDial(ctx: ReturnType<typeof dialContext>, settings: Record<string, unknown> = {}) {
    await action.onDialDown(basicEvent(ctx, settings) as never);
    await action.onDialUp(basicEvent(ctx, settings) as never);
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
      const contexts = (action as unknown as { dialSurface: { contextsState: Map<string, { dialValueLtr: number }> } })
        .dialSurface.contextsState;

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

  describe("clearFuel dedup guard", () => {
    it("never sends clearFuel twice in a row", async () => {
      const ctx = dialContext("dg1");
      // fuel-fill ON so a toggle-fueling press takes the clear path each time.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: FUEL_FILL });
      const settings = { pressAction: "toggle-fueling" };
      await appear(ctx, settings);
      mockPitClearFuel.mockClear();

      // Two clears with no pit.fuel between them -> only one broadcast goes out.
      await pressDial(ctx, settings);
      await pressDial(ctx, settings);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
    });

    it("a pit.fuel between two clears re-enables the next clear", async () => {
      const ctx = dialContext("dg2");
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      const settings = { pressAction: "fill-to-max", dialMode: "add-amount" };
      await appear(ctx, settings);
      mockPitClearFuel.mockClear();

      // full -> No Fuel (clear #1) -> full (pit.fuel resets the guard) -> No Fuel
      // (clear #2 is NOT suppressed, because a pit.fuel happened in between).
      await pressDial(ctx, settings); // full
      await pressDial(ctx, settings); // no fuel -> clear #1
      await pressDial(ctx, settings); // full -> pit.fuel resets the guard
      await pressDial(ctx, settings); // no fuel -> clear #2

      expect(mockPitClearFuel).toHaveBeenCalledTimes(2);
    });

    it("an external re-arm (fuel-fill OFF→ON via telemetry) re-enables the next dial clear", async () => {
      const ctx = dialContext("dg3");
      const settings = { pressAction: "toggle-fueling" };
      // Start with fuel armed so a toggle-fueling press takes the clear path.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: FUEL_FILL });
      await appear(ctx, settings);
      const subscribe = (action as unknown as { sdkController: { subscribe: ReturnType<typeof vi.fn> } }).sdkController
        .subscribe;
      const onTick = subscribe.mock.calls.at(-1)?.[1] as (telemetry: unknown) => void;
      onTick({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: FUEL_FILL }); // observe fuel ON
      mockPitClearFuel.mockClear();

      // Clear via the dial — sets the no-double-clear guard.
      await pressDial(ctx, settings);
      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);

      // Our clear lands (fuel OFF), then something EXTERNAL arms it again (Fuel
      // Service / the in-sim checkbox): the OFF→ON edge must release the guard.
      onTick({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 }); // OFF
      onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 0, PitSvFlags: FUEL_FILL }); // external arm (edge)

      // Fuel is ON again, so a dial clear must go through — not be swallowed.
      await pressDial(ctx, settings);
      expect(mockPitClearFuel).toHaveBeenCalledTimes(2);
    });
  });

  describe("onDialRotate — autofuel-off", () => {
    it("a bare turn broadcasts nothing while autofuel is unavailable (frozen display)", async () => {
      const ctx = dialContext("ao1");
      const settings = { unitMode: "liters", stepSize: 5, dialMode: "add-amount" };
      // Autofuel engaged but unavailable for the car/series (AUTO OFF).
      mockGetCurrentTelemetry.mockReturnValue({
        DisplayUnits: 1,
        PitSvFuel: 0,
        FuelLevel: 45,
        PitSvFlags: 0,
        dpFuelAutoFillActive: 1,
        dpFuelAutoFillEnabled: 0,
      });
      await appear(ctx, settings);
      mockPitFuel.mockClear();
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      // Neither a manual pit.fuel broadcast nor an autofuel lap-margin keytap.
      expect(mockPitFuel).not.toHaveBeenCalled();
      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("doPress dispatch — live fuel-fill state", () => {
    it("toggle-fueling requests when fuel-fill is OFF then clears when ON", async () => {
      const ctx = dialContext("p1");
      const settings = { pressAction: "toggle-fueling", unitMode: "liters", stepSize: 1 };

      // fuel off -> dial a value first so the request is non-zero
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 10) as never); // dial 10L
      mockPitFuel.mockClear();

      // fuel off -> toggle requests the dialed amount
      await pressDial(ctx, settings);

      expect(mockPitFuel).toHaveBeenCalledWith(10);
      expect(mockPitClearFuel).not.toHaveBeenCalled();

      // Now fuel is ON in telemetry -> toggle clears
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 10, FuelLevel: 0, PitSvFlags: FUEL_FILL });
      mockPitFuel.mockClear();
      await pressDial(ctx, settings);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
      expect(mockPitFuel).not.toHaveBeenCalled();

      // Back OFF -> toggle requests again (alternates with the real state)
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      mockPitClearFuel.mockClear();
      await pressDial(ctx, settings);

      expect(mockPitFuel).toHaveBeenCalledWith(10);
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("toggle-fueling clears when fuel-fill is already on", async () => {
      const ctx = dialContext("p2");
      // Fuel-fill ON -> toggle clears.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 10, FuelLevel: 0, PitSvFlags: FUEL_FILL });
      await appear(ctx, { pressAction: "toggle-fueling" });
      await pressDial(ctx, { pressAction: "toggle-fueling" });

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("fill-to-max (add mode) requests the FULL tank capacity as the add (issue #681)", async () => {
      const ctx = dialContext("p3");
      // 110L tank, 40L current -> add the full tank's worth (capacity = 110), NOT headroom 70.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 40, PitSvFlags: 0 });
      await appear(ctx, { pressAction: "fill-to-max", dialMode: "add-amount" });
      await pressDial(ctx, { pressAction: "fill-to-max", dialMode: "add-amount" });

      expect(mockPitFuel).toHaveBeenCalledWith(110);
    });

    it("fill-to-max (fill-to mode) targets capacity (add = enough to reach capacity)", async () => {
      const ctx = dialContext("p3b");
      // 110L tank, 40L current -> target 110 -> add 70
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 40, PitSvFlags: 0 });
      await appear(ctx, { pressAction: "fill-to-max", dialMode: "fill-to" });
      await pressDial(ctx, { pressAction: "fill-to-max", dialMode: "fill-to" });

      expect(mockPitFuel).toHaveBeenCalledWith(70);
    });

    it("Toggle Full / No Fuel toggles full ↔ no fuel; the No Fuel side sets 1 L then clears", async () => {
      const ctx = dialContext("p3c");
      // 110L tank, 0L current -> add-amount mode so the resulting add equals the dialed value.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      const settings = { pressAction: "fill-to-max", dialMode: "add-amount" };
      await appear(ctx, settings);

      // First invocation -> full capacity.
      await pressDial(ctx, settings);

      expect(mockPitFuel).toHaveBeenLastCalledWith(110);

      // Second invocation while at max -> No Fuel: set 1 L then clear (the fuel
      // broadcast is an unsigned int, so a negative wraps; 1 L resets the amount).
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();
      await pressDial(ctx, settings);

      expect(mockPitFuel).toHaveBeenCalledWith(1);
      expect(mockPitClearFuel).toHaveBeenCalled();

      // Third invocation -> back to full capacity (alternates).
      mockPitFuel.mockClear();
      await pressDial(ctx, settings);

      expect(mockPitFuel).toHaveBeenLastCalledWith(110);
    });

    it("fill-to-max with unknown tank capacity does not send and warns", async () => {
      const ctx = dialContext("p4");
      mockGetSessionInfo.mockReturnValue(null);
      await appear(ctx, { pressAction: "fill-to-max" });

      mockPitFuel.mockClear();
      await pressDial(ctx, { pressAction: "fill-to-max" });

      expect(mockPitFuel).not.toHaveBeenCalled();

      const logger = (action as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger;

      expect(logger.warn).toHaveBeenCalledWith("Toggle full/no fuel: tank capacity unknown, skipping");
    });
  });

  describe("resolved-0 add clears instead of pit.fuel(0) (issue #681)", () => {
    it("fill-to: the No Fuel side sets 1 L then clears and never sends pit.fuel(0)", async () => {
      const ctx = dialContext("z1");
      // 110L tank, current 45. fill-to mode so the dialed value is the TARGET.
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: 0 });
      const settings = { pressAction: "fill-to-max", dialMode: "fill-to" };
      await appear(ctx, settings);

      // First invocation -> target = capacity (110) -> add = 110 - 45 = 65.
      await pressDial(ctx, settings);

      expect(mockPitFuel).toHaveBeenLastCalledWith(65);
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();

      // Second invocation while at max -> No Fuel: set 1 L then clear, never pit.fuel(0).
      await pressDial(ctx, settings);

      expect(mockPitFuel).toHaveBeenCalledWith(1);
      expect(mockPitClearFuel).toHaveBeenCalled();
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

    it("Toggle Full / No Fuel: the No Fuel side sets 1 L then clears in add-amount mode too (never pit.fuel(0))", async () => {
      const ctx = dialContext("z3");
      // 110L tank, 0 current, add-amount mode so the resolved add equals the dialed value.
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      const settings = { pressAction: "fill-to-max", dialMode: "add-amount" };
      await appear(ctx, settings);

      // First invocation -> full capacity (non-zero add).
      await pressDial(ctx, settings);

      expect(mockPitFuel).toHaveBeenLastCalledWith(110);

      // Second invocation -> No Fuel: set 1 L then clear, never pit.fuel(0).
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();
      await pressDial(ctx, settings);

      expect(mockPitFuel).toHaveBeenCalledWith(1);
      expect(mockPitClearFuel).toHaveBeenCalled();
      expect(mockPitFuel).not.toHaveBeenCalledWith(0);
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

    it("broadcasts the unclamped rounded-up add (49, not the 48 fractional headroom) at fuel 41.9 target 90 (#681)", async () => {
      // The bug: at/near a full tank the rounded-up add (49) was clamped down to the
      // fractional remaining space (48.1, shown as 48), under-requesting. The fix
      // sends the unclamped ceil (49). Continuous monitor at fuel 41.9, target 90,
      // fuel-fill ON must broadcast 49.
      const ctx = dialContext("cm-unclamped");
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      // 90L tank, target == capacity (90). Fuel ON, current 41.9.
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({
        DisplayUnits: 1,
        PitSvFuel: 48,
        FuelLevel: 41.9,
        PitSvFlags: FUEL_FILL,
      });
      const settings = { stepSize: 1, unitMode: "liters", dialMode: "fill-to", pressAction: "toggle-fueling" };
      await appear(ctx, settings);

      const onTick = telemetryCallback();

      // First tick at 41.9: need = 90 − 41.9 = 48.1 → ceil 49 (NOT clamped to 48.1/48).
      onTick({ DisplayUnits: 1, PitSvFuel: 48, FuelLevel: 41.9, PitSvFlags: FUEL_FILL });

      expect(mockPitFuel).toHaveBeenLastCalledWith(49);
    });

    it("does NOT re-send on the first tick after a fill-to ROTATE (flushSend keeps lastSentWholeAdd in sync)", async () => {
      // Regression (issue #681): flushSend must mirror doPress and update
      // ctx.lastSentWholeAdd, else the first telemetry tick after a rotate sees a
      // stale gate value and emits ONE redundant pit.fuel for the same whole-unit add.
      const ctx = dialContext("cm-rotate");
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
      // With the target AT capacity the add (target − current, rounded UP) is a
      // clean whole display value and is NOT clamped to the fractional headroom
      // (issue #681). As fuel burns within the same whole litre the rounded-up add
      // stays constant, so the whole-unit gate broadcasts at most once per litre —
      // no ~60×/sec spam.
      const ctx = dialContext("cm-full");
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

      // Prime the re-send baseline: first tick at 43.92 computes the add
      // (need = 90 − 43.92 = 46.08 → ceil 47, unclamped) and broadcasts it
      // (lastSentWholeAdd was null after appear).
      onTick({ DisplayUnits: 1, PitSvFuel: 46, FuelLevel: 43.92, PitSvFlags: FUEL_FILL });
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();

      // Several ticks burning WITHIN the same whole litre (43.92 → 43.81). The
      // rounded-up need stays 47 (need 46.x → ceil 47), so NOT a single re-send.
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

      // Drop across the whole-litre boundary (43.81 → 42.95): the need crosses 47
      // (90 − 42.95 = 47.05 → ceil 48), so the whole-unit add moves 47 → 48 →
      // exactly ONE re-send.
      mockGetCurrentTelemetry.mockReturnValue({
        DisplayUnits: 1,
        PitSvFuel: 46,
        FuelLevel: 42.95,
        PitSvFlags: FUEL_FILL,
      });
      onTick({ DisplayUnits: 1, PitSvFuel: 46, FuelLevel: 42.95, PitSvFlags: FUEL_FILL });

      expect(mockPitFuel).toHaveBeenCalledTimes(1);
      expect(mockPitFuel).toHaveBeenLastCalledWith(48);
    });

    it("does NOT re-send on ticks where the whole-unit add is unchanged", async () => {
      const ctx = dialContext("cm2");
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
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      // stepSize is schema-capped at 50 (the old mock let 65 through unvalidated).
      const settings = { stepSize: 50, unitMode: "liters", dialMode: "fill-to" };
      // Fuel OFF.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: 0 });
      await appear(ctx, settings);
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // target 95
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

  describe("toggle-off is not re-armed by the continuous fill-to monitor (telemetry lag)", () => {
    it("a toggle-off press in fill-to mode is NOT undone by a lagging fuel-fill-on tick", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("toff1");
      // Fill-to, fuel ON, current 45, requested add 20 -> seed target = 65.
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 1, dialMode: "fill-to", pressAction: "toggle-fueling" };
      await appear(ctx, settings);

      const onTick = getTelemetryCallback(action);

      // Prime the continuous-monitor baseline (first tick broadcasts add 20).
      onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });

      // The user presses to turn fueling OFF — this clears the request.
      await pressDial(ctx, settings);

      expect(mockPitClearFuel).toHaveBeenCalled();
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();

      // iRacing has not processed the clear yet: PitSvFlags still reports fuel-fill
      // ON for a few ticks. The continuous monitor must NOT re-broadcast pit.fuel
      // during this lag window — doing so silently RE-ARMS the fueling the user just
      // turned off.
      for (const fuel of [45, 44.9, 44.8]) {
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

    it("resumes continuous re-sends once fueling is genuinely re-armed", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("toff2");
      // Fill-to, fuel ON, current 45, requested add 20 -> seed target = 65.
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 1, dialMode: "fill-to", pressAction: "toggle-fueling" };
      await appear(ctx, settings);

      const onTick = getTelemetryCallback(action);
      onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL }); // prime

      // Turn fueling OFF, then let the clear land in telemetry (fuel-fill OFF).
      await pressDial(ctx, settings);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: 0 });
      onTick({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: 0 }); // clear observed (fuel OFF)
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();

      // The user presses again to re-arm (fuel-fill OFF -> request the add).
      await pressDial(ctx, settings);

      expect(mockPitFuel).toHaveBeenCalledWith(20);

      // Now the continuous monitor must work again: fuel burns past a whole-unit
      // boundary and the request is re-sent.
      mockPitFuel.mockClear();
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 44, PitSvFlags: FUEL_FILL });
      onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 44, PitSvFlags: FUEL_FILL }); // need 65-44=21 -> re-send

      expect(mockPitFuel).toHaveBeenCalledWith(21);
    });
  });

  describe("gesture state machine (release-time classification)", () => {
    it("onDialDown fires nothing (no press, no timer)", async () => {
      const ctx = dialContext("g0");
      await appear(ctx, { pressAction: "toggle-fueling" });
      mockPitClearFuel.mockClear();

      await action.onDialDown(basicEvent(ctx, { pressAction: "toggle-fueling" }) as never);

      expect(mockPitClearFuel).not.toHaveBeenCalled();
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("a short press (down then immediate up) fires pressAction", async () => {
      const ctx = dialContext("g1");
      const settings = { pressAction: "toggle-fueling", longPressAction: "fill-to-max" };
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("a long press (held past the 500ms threshold) fires longPressAction at release", async () => {
      const ctx = dialContext("g2");
      // 110L tank, 0 current -> fill-to-max add 110.
      const settings = { pressAction: "toggle-fueling", longPressAction: "fill-to-max" };
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(500);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(110);
    });

    it("honors the global Long-press threshold setting (not a hardcoded 500ms)", async () => {
      const ctx = dialContext("g2b");
      mockDualPressThreshold.value = 800;
      const settings = { pressAction: "toggle-fueling", longPressAction: "fill-to-max" };
      await appear(ctx, settings);

      // A 600ms hold is BELOW the raised 800ms threshold -> still a short press.
      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1); // toggle-fueling with 0 dialed -> clears
      expect(mockPitFuel).not.toHaveBeenCalled();

      mockPitClearFuel.mockClear();

      // A 900ms hold is AT/ABOVE the 800ms threshold -> long press fires.
      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(900);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(110); // longPressAction = fill-to-max
    });

    it("a long hold fires nothing when longPressAction is none (no fallback to pressAction)", async () => {
      const ctx = dialContext("g3");
      const settings = { pressAction: "toggle-fueling", longPressAction: "none" };
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("a quick press fires nothing when pressAction is none", async () => {
      const ctx = dialContext("g3b");
      const settings = { pressAction: "none", longPressAction: "fill-to-max" };
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("a pressed rotation (push+turn) fires nothing and pre-empts the release classifier", async () => {
      const ctx = dialContext("g4");
      // pushTurnAction defaults to "none" so the pressed rotation dispatches nothing,
      // but it sets the guard so dialUp fires neither press nor long-press.
      const settings = { pressAction: "toggle-fueling", longPressAction: "fill-to-max" };
      await appear(ctx, settings);
      mockPitClearFuel.mockClear();
      mockPitFuel.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never); // pressed rotation
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockPitClearFuel).not.toHaveBeenCalled();
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("a pressed rotation does NOT adjust the manual fuel value", async () => {
      const ctx = dialContext("g5");
      const settings = { stepSize: 5, unitMode: "liters", dialMode: "add-amount" };
      await appear(ctx, settings);
      mockPitFuel.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never); // pressed → push+turn (none)
      vi.advanceTimersByTime(100);

      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("Push + Turn full-empty: a clockwise pressed rotation fills the tank", async () => {
      const ctx = dialContext("pt1");
      // 110 L tank, 0 current, add-amount -> fill-full requests the full capacity.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      const settings = { pushTurnAction: "full-empty", dialMode: "add-amount" };
      await appear(ctx, settings);
      mockPitFuel.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never); // pressed CW

      expect(mockPitFuel).toHaveBeenCalledWith(110);
    });

    it("Push + Turn full-empty: a counter-clockwise pressed rotation empties (1 L then clear)", async () => {
      const ctx = dialContext("pt2");
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      const settings = { pushTurnAction: "full-empty", dialMode: "add-amount" };
      await appear(ctx, settings);
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, -1, true) as never); // pressed CCW

      expect(mockPitFuel).toHaveBeenCalledWith(1);
      expect(mockPitClearFuel).toHaveBeenCalled();
    });

    it("Push + Turn full-empty still pre-empts the release classifier (no press on dialUp)", async () => {
      const ctx = dialContext("pt3");
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 0, PitSvFlags: 0 });
      const settings = { pushTurnAction: "full-empty", pressAction: "toggle-autofuel-mode", longPressAction: "none" };
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never); // pressed rotation (push+turn)
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      // The release fired nothing — only the push+turn dispatched (fill-full); pressAction did not.
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("the configured press action toggle-autofuel-mode taps the autofuel key binding", async () => {
      const ctx = dialContext("g6");
      const settings = { pressAction: "toggle-autofuel-mode" };
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await pressDial(ctx, settings);

      expect(mockTapBinding).toHaveBeenCalledWith("fuelServiceToggleAutofuel");
    });

    it("the default long press toggles autofuel (blind-safe VR default)", async () => {
      const ctx = dialContext("g7");
      // Defaults: pressAction toggle-fueling, longPressAction toggle-autofuel-mode.
      await appear(ctx, {});
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, {}) as never);
      vi.advanceTimersByTime(500);
      await action.onDialUp(basicEvent(ctx, {}) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("fuelServiceToggleAutofuel");
    });
  });

  describe("switch-mode action", () => {
    it("flips dialMode add-amount → fill-to and persists via setSettings (no fuel command)", async () => {
      const ctx = dialContext("sm1");
      const settings = { dialMode: "add-amount", pressAction: "switch-mode" };
      await appear(ctx, settings);
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();

      await pressDial(ctx, settings);

      // Persists the flipped mode so it sticks and the PI reflects it.
      expect(ctx.setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ dial: expect.objectContaining({ mode: "fill-to" }) }),
      );
      // Switch Mode talks to nothing — no pit command.
      expect(mockPitFuel).not.toHaveBeenCalled();
      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("flips back fill-to → add-amount", async () => {
      const ctx = dialContext("sm2");
      const settings = { dialMode: "fill-to", pressAction: "switch-mode" };
      await appear(ctx, settings);

      await pressDial(ctx, settings);

      expect(ctx.setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ dial: expect.objectContaining({ mode: "add-amount" }) }),
      );
    });
  });

  describe("onTouchTap routing (Tap Display vs Long Touch)", () => {
    it("routes a tap (hold === false) to tapAction", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tt1");
      await appear(ctx, { tapAction: "toggle-fueling" });

      await action.onTouchTap(touchTapEvent(ctx, { tapAction: "toggle-fueling" }, false) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
    });

    it("routes a long touch (hold === true) to longTouchAction", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tt1b");
      const settings = { tapAction: "none", longTouchAction: "toggle-fueling" };
      await appear(ctx, settings);

      await action.onTouchTap(touchTapEvent(ctx, settings, true) as never);

      expect(mockPitClearFuel).toHaveBeenCalledTimes(1);
    });

    it("a tap does nothing when tapAction is none (VR-safe default)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tt2");
      await appear(ctx, { tapAction: "none" });

      await action.onTouchTap(touchTapEvent(ctx, { tapAction: "none" }, false) as never);

      expect(mockPitClearFuel).not.toHaveBeenCalled();
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("a long touch does nothing when longTouchAction is none", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tt2b");
      await appear(ctx, { longTouchAction: "none" });

      await action.onTouchTap(touchTapEvent(ctx, { longTouchAction: "none" }, true) as never);

      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("is ignored when the feedback feature flag is off", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("tt4");
      await appear(ctx, { tapAction: "toggle-fueling" });

      await action.onTouchTap(touchTapEvent(ctx, { tapAction: "toggle-fueling" }, false) as never);

      expect(mockPitClearFuel).not.toHaveBeenCalled();
    });

    it("routes a tap to fill-to-max", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tt5");
      await appear(ctx, { tapAction: "fill-to-max" });

      await action.onTouchTap(touchTapEvent(ctx, { tapAction: "fill-to-max" }, false) as never);

      expect(mockPitFuel).toHaveBeenCalledWith(110);
    });
  });

  describe("touch feedback — continuous two-segment bar", () => {
    it("pushes a pixmap bar and the +add = total readout (add mode) for a dial", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f1");
      // current 45, max 90; dial +20 -> broadcasts pit.fuel(20).
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 20, dialMode: "add-amount" };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // dial +20

      // iRacing confirms the 20 L request a tick later; the readout follows
      // telemetry (#726), so drive the displayed value from the confirmed PitSvFuel.
      // Settle the leading+trailing throttle flush deterministically (timers AND
      // microtasks) so the confirming tick's change-render is not gated by an
      // ordering race on the throttle window.
      await vi.advanceTimersByTimeAsync(300);
      const onTick = getTelemetryCallback(action);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });

      expect(ctx.setFeedback).toHaveBeenCalled();
      const payload = ctx.setFeedback.mock.calls.at(-1)?.[0];

      expect(typeof payload.box).toBe("string");
      expect(payload.box).toContain("data:image/svg+xml");
      const canvas = stripCanvas(payload);

      expect(canvas).toContain(">+20 = 65 L<");
      // Band + bar are green because fuel-fill is on
      expect(canvas).toContain("#2ecc71");
      // No red target line in add mode (and the ON band is green, not red).
      expect(canvas).not.toContain('fill="#e74c3c"');
    });

    it("mirrors the OFF state on the touch strip: red REFUEL: OFF band + gray add segment (#728)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f1off");
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      // Fuel-fill OFF with a pending 20 L request.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: 0 });
      await appear(ctx, { unitMode: "liters", dialMode: "add-amount" });

      const canvas = stripCanvas(ctx.setFeedback.mock.calls.at(-1)?.[0]);

      // The strip's self-drawn canvas shows the same red band as the keypad icon.
      expect(canvas).toContain("REFUEL: OFF");
      expect(canvas).toMatch(/<path[^>]*fill="#e74c3c"/);
      // The bar stays subtle: gray add segment, no green.
      expect(canvas).toMatch(/<path[^>]*fill="#888888"/);
      expect(canvas).not.toContain("#2ecc71");
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

      const canvas = stripCanvas(ctx.setFeedback.mock.calls.at(-1)?.[0]);

      expect(canvas).toContain(">→ 65 L<");
      // Red target line present in fill-to mode.
      expect(canvas).toMatch(/<rect[^>]*fill="#e74c3c"/);
    });

    it("renders the readout when capacity unknown (add mode, no cap)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("f1b");
      mockGetSessionInfo.mockReturnValue(null);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 20, dialMode: "add-amount" };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // dial +20

      // The readout follows the confirmed PitSvFuel (#726); total = 45 + 20 (no cap).
      // Settle the throttle flush deterministically before the confirming tick.
      await vi.advanceTimersByTimeAsync(300);
      const onTick = getTelemetryCallback(action);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      onTick({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });

      expect(stripCanvas(ctx.setFeedback.mock.calls.at(-1)?.[0])).toContain(">+20 = 65 L<");
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

      // The trailing flush is the second (and only other) push — coalescing
      // setFeedback into one-per-window is the subject here.
      expect(ctx.setFeedback).toHaveBeenCalledTimes(2);

      // The coalesced readout follows TELEMETRY (PitSvFuel 0 -> "+0 = 0 L"), NOT the
      // dialed +3 — proving the displayed value stays telemetry-driven through a
      // coalesced spin (#726). The "last value wins" SEND semantics are covered by
      // the throttle-coalescing send tests.
      expect(stripCanvas(ctx.setFeedback.mock.calls.at(-1)?.[0])).toContain(">+0 = 0 L<");
    });
  });

  describe("display follows telemetry, not the dialed guess (issue #726)", () => {
    it("add-amount: the readout follows the live PitSvFuel, not the optimistic dialed amount", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("disp726");
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      // Fuel ON, current 45, nothing requested yet.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 20, dialMode: "add-amount" };
      await appear(ctx, settings);

      // The user dials +20 (this broadcasts pit.fuel(20)); telemetry has not confirmed it yet.
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      // A tick later iRacing reports the ACTUAL requested add as 18 (e.g. the
      // integer-liter clamp/round the SDK applies). Settle the throttle flush
      // deterministically, then deliver the confirming tick: the DISPLAY must follow
      // telemetry (18), never the optimistically-dialed 20.
      await vi.advanceTimersByTimeAsync(300);
      const onTick = getTelemetryCallback(action);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 18, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      onTick({ DisplayUnits: 1, PitSvFuel: 18, FuelLevel: 45, PitSvFlags: FUEL_FILL });

      expect(stripCanvas(ctx.setFeedback.mock.calls.at(-1)?.[0])).toContain(">+18 = 63 L<");
    });

    it("add-amount: a PitSvFuel above tank capacity is clamped in the readout (never +95 = 90)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("disp726-cap");
      // 90 L tank, current 45, but the live pit request is 95 (e.g. set externally or
      // by a #fuel macro above the dial's max). The displayed add must clamp to the
      // capacity (90), never render an add larger than the capacity-capped total.
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 95, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      await appear(ctx, { unitMode: "liters", stepSize: 1, dialMode: "add-amount" });

      expect(stripCanvas(ctx.setFeedback.mock.calls.at(-1)?.[0])).toContain(">+90 = 90 L<");
    });

    it("add-amount: a null-telemetry frame shows +0 (display follows telemetry, no stale dialed value)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("disp726-null");
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 20, FuelLevel: 45, PitSvFlags: FUEL_FILL });
      await appear(ctx, { unitMode: "liters", stepSize: 1, dialMode: "add-amount" });

      // Telemetry drops to null; the heartbeat repaints. With no pit request to read,
      // the add follows telemetry to +0 rather than holding a stale dialed value.
      mockGetCurrentTelemetry.mockReturnValue(null);
      ctx.setFeedback.mockClear();
      vi.advanceTimersByTime(5000); // display heartbeat

      expect(stripCanvas(ctx.setFeedback.mock.calls.at(-1)?.[0])).toContain(">+0 = 0 L<");
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
      // Band + bar reflect the new ON color (green).
      expect(stripCanvas(ctx.setFeedback.mock.calls.at(-1)?.[0])).toContain("#2ecc71");
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

      // Advance past the change-render throttle so a changing tick can push. The
      // displayed add follows the live PitSvFuel (#726), so each tick also updates
      // the telemetry the action reads back via getCurrentTelemetry.
      vi.advanceTimersByTime(3100);
      ctx.setFeedback.mockClear();

      // First changing tick pushes; an immediate second changing tick is throttled.
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 21, FuelLevel: 45, PitSvFlags: 0 });
      onTick({ DisplayUnits: 1, PitSvFuel: 21, FuelLevel: 45, PitSvFlags: 0 });
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 22, FuelLevel: 45, PitSvFlags: 0 });
      onTick({ DisplayUnits: 1, PitSvFuel: 22, FuelLevel: 45, PitSvFlags: 0 });

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);

      // After the throttle window, another change pushes again.
      vi.advanceTimersByTime(100);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 23, FuelLevel: 45, PitSvFlags: 0 });
      onTick({ DisplayUnits: 1, PitSvFuel: 23, FuelLevel: 45, PitSvFlags: 0 });

      expect(ctx.setFeedback).toHaveBeenCalledTimes(2);
    });

    it("fill-to: a target change at/below current fuel (add stays 0) refreshes the signature", async () => {
      // In fill-to mode the displayed target (dialValueLtr) can move while the
      // resolved add stays 0 (target dialed at/below current fuel). The signature
      // must include the target in fill-to mode so the readout refreshes promptly
      // instead of waiting up to 5 s for the heartbeat (issue #681).
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("dr-target-sig");
      // 110L tank, current 50, fuel ON. Seed target = current + PitSvFuel = 50.
      mockGetSessionInfo.mockReturnValue(SESSION_110L);
      mockGetCurrentTelemetry.mockReturnValue({ DisplayUnits: 1, PitSvFuel: 0, FuelLevel: 50, PitSvFlags: FUEL_FILL });
      const settings = { unitMode: "liters", stepSize: 5, dialMode: "fill-to" };
      await appear(ctx, settings);

      const sig = (ctx2: { dialValueLtr: number }) =>
        (
          action as unknown as { dialSurface: { displayedSignature: (c: unknown) => string } }
        ).dialSurface.displayedSignature(ctx2 as never);

      const contexts = (action as unknown as { dialSurface: { contextsState: Map<string, { dialValueLtr: number }> } })
        .dialSurface.contextsState;
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
      expect(stripCanvas(ctx.setFeedback.mock.calls.at(-1)?.[0])).toContain(">→ 30 L<");
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

  describe("autofuel mode behaviour", () => {
    const AUTOFUEL_ON = {
      DisplayUnits: 1,
      PitSvFuel: 30,
      FuelLevel: 40,
      PitSvFlags: 0,
      dpFuelAutoFillActive: 1,
      dpFuelAutoFillEnabled: 1,
    };

    it("a bare turn clockwise taps the lap-margin increase keybind (coalesced leading edge)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("af1");
      mockGetCurrentTelemetry.mockReturnValue(AUTOFUEL_ON);
      const settings = { unitMode: "liters", stepSize: 1, dialMode: "add-amount" };
      await appear(ctx, settings);
      mockTapBinding.mockClear();
      mockPitFuel.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never); // bare turn CW

      expect(mockTapBinding).toHaveBeenCalledWith("fuelServiceLapMarginIncrease");
      // No pit.fuel in autofuel mode — iRacing's autofuel owns the request.
      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("a bare turn counter-clockwise taps the lap-margin decrease keybind", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("af2");
      mockGetCurrentTelemetry.mockReturnValue(AUTOFUEL_ON);
      const settings = { unitMode: "liters", stepSize: 1, dialMode: "add-amount" };
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never); // bare turn CCW

      expect(mockTapBinding).toHaveBeenCalledWith("fuelServiceLapMarginDecrease");
    });

    it("coalesces a fast spin into a leading + trailing margin tap (not one per detent)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("af3");
      mockGetCurrentTelemetry.mockReturnValue(AUTOFUEL_ON);
      const settings = { unitMode: "liters", stepSize: 1, dialMode: "add-amount" };
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);
      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledTimes(1); // leading edge only so far

      vi.advanceTimersByTime(100); // trailing flush

      expect(mockTapBinding).toHaveBeenCalledTimes(2);
      expect(mockTapBinding.mock.calls.every((c: unknown[]) => c[0] === "fuelServiceLapMarginIncrease")).toBe(true);
    });

    it("does NOT continuously re-send pit.fuel while in autofuel mode (fill-to + fuel-fill on)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("af4");
      const tel = {
        DisplayUnits: 1,
        PitSvFuel: 30,
        FuelLevel: 40,
        PitSvFlags: FUEL_FILL,
        dpFuelAutoFillActive: 1,
        dpFuelAutoFillEnabled: 1,
      };
      mockGetCurrentTelemetry.mockReturnValue(tel);
      const settings = { unitMode: "liters", stepSize: 1, dialMode: "fill-to" };
      await appear(ctx, settings);

      const subscribe = (action as unknown as { sdkController: { subscribe: ReturnType<typeof vi.fn> } }).sdkController
        .subscribe;
      const onTick = subscribe.mock.calls.at(-1)?.[1] as (t: unknown) => void;
      mockPitFuel.mockClear();
      mockPitClearFuel.mockClear();

      for (const fuel of [39, 38, 37]) {
        const t = { ...tel, FuelLevel: fuel };
        mockGetCurrentTelemetry.mockReturnValue(t);
        onTick(t);
      }

      expect(mockPitFuel).not.toHaveBeenCalled();
    });

    it("the autofuel readout reads the add from PitSvFuel (AUTO → readout, AUTOFUEL band title)", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("af5");
      mockGetSessionInfo.mockReturnValue(SESSION_90L);
      mockGetCurrentTelemetry.mockReturnValue({
        DisplayUnits: 1,
        PitSvFuel: 30,
        FuelLevel: 40,
        PitSvFlags: FUEL_FILL,
        dpFuelAutoFillActive: 1,
        dpFuelAutoFillEnabled: 1,
      });
      const settings = { unitMode: "liters", stepSize: 1, dialMode: "add-amount" };
      await appear(ctx, settings);

      ctx.setFeedback.mockClear();
      vi.advanceTimersByTime(5000); // display heartbeat pushes feedback

      const canvas = stripCanvas(ctx.setFeedback.mock.calls.at(-1)?.[0]);

      expect(canvas).toContain("AUTOFUEL: ON");
      expect(canvas).toContain(">AUTO → 30 L<");
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
        tapAction: "toggle-fueling",
        longTouchAction: "none",
      });

      expect(ctx.setTriggerDescription).toHaveBeenCalledWith(
        expect.objectContaining({
          rotate: "Adjust fuel / autofuel margin",
          push: "Toggle fueling",
          touch: "Toggle fueling",
        }),
      );
      const desc = ctx.setTriggerDescription.mock.calls.at(-1)?.[0];

      expect(desc.longTouch).toBeUndefined();
    });

    it("appends the long-press hold hint to push", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tr1b");
      await appear(ctx, {
        dialMode: "add-amount",
        pressAction: "toggle-fueling",
        longPressAction: "toggle-autofuel-mode",
        tapAction: "none",
        longTouchAction: "none",
      });

      const desc = ctx.setTriggerDescription.mock.calls.at(-1)?.[0];

      expect(desc.push).toBe("Toggle fueling (hold: Toggle autofuel)");
      expect(desc.longTouch).toBeUndefined();
    });

    it("maps the Long Touch slot to the SDK longTouch field", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", true);
      const ctx = dialContext("tr-lt");
      await appear(ctx, {
        dialMode: "add-amount",
        pressAction: "none",
        longPressAction: "none",
        tapAction: "none",
        longTouchAction: "toggle-fueling",
      });

      const desc = ctx.setTriggerDescription.mock.calls.at(-1)?.[0];

      expect(desc.longTouch).toBe("Toggle fueling");
      // pressAction + longPressAction both none → push is unset.
      expect(desc.push).toBeUndefined();
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
          tapAction: "none",
          longTouchAction: "none",
        }) as never,
      );

      expect(ctx.setTriggerDescription).toHaveBeenCalledWith(
        expect.objectContaining({ rotate: "Adjust target / autofuel margin", push: "Toggle full / no fuel" }),
      );
      const desc = ctx.setTriggerDescription.mock.calls.at(-1)?.[0];

      expect(desc.touch).toBeUndefined();
      expect(desc.longTouch).toBeUndefined();
    });

    it("does not set trigger descriptions when feedback flag is off", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("tr4");
      await appear(ctx, {});

      expect(ctx.setTriggerDescription).not.toHaveBeenCalled();
    });
  });
});
