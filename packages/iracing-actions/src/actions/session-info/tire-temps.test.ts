import type { LastStopTireTemps, TireCornerTemps } from "@iracedeck/sim-events-iracing";
import { describe, expect, it, vi } from "vitest";

import { SessionInfoSettings } from "./session-info-settings.js";
import {
  formatTireTemp,
  generateTireTempsGraphic,
  resolveTireTempsDisplay,
  summarizeTireTemp,
  TIRE_TEMP_BAND_COLORS,
  TIRE_TEMPS_KEY_CANVAS,
  tireTempBand,
  type TireTempsCanvas,
  type TireTempsDisplay,
  tireTempsStateKey,
  tireTempsTitle,
  tireTempThresholds,
  tireTempZoneOrder,
} from "./tire-temps.js";

// Real zod semantics for the extended schema, so a settings literal parsed
// through it carries the schema's own defaults.
vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
    CommonSettings: { extend: (shape: never) => z.object(shape).passthrough() },
  };
});

// The real conversion, from deck-iracing's source. A plain factory, because
// the real barrel's SimIRacingAction extends a deck-core class this suite does
// not load.
vi.mock("@iracedeck/deck-iracing", async () => {
  const units = await vi.importActual<typeof import("../../../../deck-iracing/src/unit-conversion.js")>(
    "../../../../deck-iracing/src/unit-conversion.js",
  );

  return { celsiusToFahrenheit: units.celsiusToFahrenheit };
});

const METRIC = 1;
const ENGLISH = 0;

const BLUE = "#3498db";
const GREEN = "#2ecc71";
const YELLOW = "#f1c40f";
const RED = "#e74c3c";
const TEXT = "#ffffff";

/** Tire Temperatures settings through the action's own schema. */
function settings(overrides: Record<string, unknown> = {}): SessionInfoSettings {
  return SessionInfoSettings.parse({ mode: "tire-temps", ...overrides });
}

function temps(outside: number, middle: number, inside: number): TireCornerTemps {
  return { outside, middle, inside };
}

/** A reading whose every value is distinct, so a swapped corner or zone shows. */
function reading(): LastStopTireTemps {
  return {
    corners: {
      lf: temps(70, 80, 96),
      rf: temps(91, 93, 97),
      lr: temps(60, 62, 64),
      rr: temps(101, 104, 110),
    },
  };
}

type DrawnText = { x: number; y: number; fill: string; size: number; content: string };

/** The `<text>` elements of a rendered graphic, in document order. */
function drawn(svg: string): DrawnText[] {
  const pattern =
    /<text x="([\d.-]+)" y="([\d.-]+)"[^>]*? fill="([^"]+)"[^>]*? font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/g;

  return [...svg.matchAll(pattern)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    fill: m[3]!,
    size: Number(m[4]),
    content: m[5]!,
  }));
}

function render(
  display: TireTempsDisplay,
  canvas: TireTempsCanvas = TIRE_TEMPS_KEY_CANVAS,
  fontSize = 28,
): DrawnText[] {
  return drawn(generateTireTempsGraphic(display, canvas, { fontSize, textColor: TEXT }));
}

describe("summarizeTireTemp", () => {
  const triple = temps(70, 80, 96);

  it("weighted center counts the middle zone twice", () => {
    expect(summarizeTireTemp(triple, "weighted")).toBe((70 + 2 * 80 + 96) / 4);
    expect(summarizeTireTemp(triple, "weighted")).toBe(81.5);
  });

  it("average is the plain mean of the three zones", () => {
    expect(summarizeTireTemp(triple, "average")).toBe(82);
  });

  it("hottest zone is the maximum, whichever zone holds it", () => {
    expect(summarizeTireTemp(triple, "max")).toBe(96);
    expect(summarizeTireTemp(temps(99, 80, 70), "max")).toBe(99);
    expect(summarizeTireTemp(temps(70, 99, 80), "max")).toBe(99);
  });

  it("middle only ignores both shoulders", () => {
    expect(summarizeTireTemp(triple, "middle")).toBe(80);
  });

  it("works on unrounded values and returns an unrounded figure", () => {
    expect(summarizeTireTemp(temps(70.1, 80.2, 90.4), "weighted")).toBeCloseTo(80.225, 10);
    expect(summarizeTireTemp(temps(70.1, 80.2, 90.4), "average")).toBeCloseTo(80.2333333333, 8);
  });

  it("gives the same figure on either side of the car", () => {
    for (const method of ["weighted", "average", "max", "middle"] as const) {
      expect(summarizeTireTemp(temps(70, 80, 96), method)).toBe(summarizeTireTemp(temps(96, 80, 70), method));
    }
  });
});

describe("tireTempBand", () => {
  const celsius = tireTempThresholds(settings());
  const fahrenheit = tireTempThresholds(settings({ tireTempThresholdUnit: "f" }));

  it("reads each unit's own default set", () => {
    expect(celsius).toEqual({ unit: "c", coldBelow: 75, hotAbove: 90, criticalAbove: 100 });
    expect(fahrenheit).toEqual({ unit: "f", coldBelow: 165, hotAbove: 195, criticalAbove: 210 });
  });

  it("a threshold itself belongs to the cooler band: exactly 75 and 90 are in the window, exactly 100 is above", () => {
    expect(tireTempBand(75, celsius)).toBe("in");
    expect(tireTempBand(90, celsius)).toBe("in");
    expect(tireTempBand(100, celsius)).toBe("above");
  });

  it("changes band just past each threshold", () => {
    expect(tireTempBand(74.99, celsius)).toBe("below");
    expect(tireTempBand(90.01, celsius)).toBe("above");
    expect(tireTempBand(100.01, celsius)).toBe("well-above");
  });

  it("compares the unrounded figure, so two figures that both show 90 can sit in different bands", () => {
    expect(formatTireTemp(89.6, METRIC)).toBe("90°");
    expect(formatTireTemp(90.4, METRIC)).toBe("90°");
    expect(tireTempBand(89.6, celsius)).toBe("in");
    expect(tireTempBand(90.4, celsius)).toBe("above");
  });

  it("compares in Fahrenheit when the thresholds are typed in Fahrenheit", () => {
    // 165 / 195 / 210 °F against a °C reading: 73.8 °C is 164.84 °F, 74 °C is
    // 165.2 °F, 90.5 °C is 194.9 °F, 90.6 °C is 195.08 °F, 98.8 °C is
    // 209.84 °F and 99 °C is 210.2 °F.
    expect(tireTempBand(73.8, fahrenheit)).toBe("below");
    expect(tireTempBand(74, fahrenheit)).toBe("in");
    expect(tireTempBand(90.5, fahrenheit)).toBe("in");
    expect(tireTempBand(90.6, fahrenheit)).toBe("above");
    expect(tireTempBand(98.8, fahrenheit)).toBe("above");
    expect(tireTempBand(99, fahrenheit)).toBe("well-above");
  });

  it("holds the same edge rule in Fahrenheit: exactly on a threshold is the cooler band", () => {
    // 75 / 90 / 100 °C convert to exactly 167 / 194 / 212 °F.
    const exact = tireTempThresholds(
      settings({
        tireTempThresholdUnit: "f",
        tireTempColdBelowF: 167,
        tireTempHotAboveF: 194,
        tireTempCriticalAboveF: 212,
      }),
    );

    expect(tireTempBand(75, exact)).toBe("in");
    expect(tireTempBand(90, exact)).toBe("in");
    expect(tireTempBand(100, exact)).toBe("above");
    expect(tireTempBand(100.1, exact)).toBe("well-above");
  });

  it("uses only the selected unit's set, and never converts the other", () => {
    // Two sets that deliberately disagree: 50 °C is 122 °F.
    const both = {
      tireTempColdBelow: 75,
      tireTempHotAbove: 90,
      tireTempCriticalAbove: 100,
      tireTempColdBelowF: 100,
      tireTempHotAboveF: 120,
      tireTempCriticalAboveF: 140,
    };

    expect(tireTempBand(50, tireTempThresholds(settings({ ...both, tireTempThresholdUnit: "c" })))).toBe("below");
    expect(tireTempBand(50, tireTempThresholds(settings({ ...both, tireTempThresholdUnit: "f" })))).toBe("above");
  });

  it("evaluates hottest first, so an out-of-order set still colors predictably", () => {
    const reversed = tireTempThresholds(
      settings({ tireTempColdBelow: 110, tireTempHotAbove: 60, tireTempCriticalAbove: 40 }),
    );

    // Above every threshold: well above wins over above and below.
    expect(tireTempBand(70, reversed)).toBe("well-above");
    expect(tireTempBand(50, reversed)).toBe("well-above");
    // Under the two upper thresholds, and under the "below" one too.
    expect(tireTempBand(30, reversed)).toBe("below");

    // Over "above" and under "below" at once: above is the hotter band, so it wins.
    const overlapping = tireTempThresholds(
      settings({ tireTempColdBelow: 110, tireTempHotAbove: 60, tireTempCriticalAbove: 200 }),
    );

    expect(tireTempBand(70, overlapping)).toBe("above");
    expect(tireTempBand(50, overlapping)).toBe("below");

    const upperSwapped = tireTempThresholds(settings({ tireTempHotAbove: 95, tireTempCriticalAbove: 80 }));

    expect(tireTempBand(85, upperSwapped)).toBe("well-above");
    expect(tireTempBand(78, upperSwapped)).toBe("in");
  });
});

describe("formatTireTemp", () => {
  it("shows whole degrees Celsius with a degree sign and no unit letter", () => {
    expect(formatTireTemp(84.4, METRIC)).toBe("84°");
    expect(formatTireTemp(84.5, METRIC)).toBe("85°");
  });

  it("shows Fahrenheit on English display units", () => {
    expect(formatTireTemp(100, ENGLISH)).toBe("212°");
  });

  it("rounds once, after the conversion", () => {
    // 84.4 °C is 183.92 °F. Rounding the Celsius first would show 183.
    expect(formatTireTemp(84.4, ENGLISH)).toBe("184°");
  });

  it("an unset DisplayUnits counts as metric", () => {
    expect(formatTireTemp(84.4, undefined)).toBe("84°");
  });

  it("shows the placeholder for a value that is not a number, never a zero", () => {
    expect(formatTireTemp(Number.NaN, METRIC)).toBe("--");
    expect(formatTireTemp(Number.POSITIVE_INFINITY, ENGLISH)).toBe("--");
  });
});

describe("tireTempsTitle", () => {
  it("says it is a pit reading", () => {
    expect(tireTempsTitle("all")).toBe("PIT TEMPS");
  });

  it("names the corner when the key shows one", () => {
    expect(tireTempsTitle("lf")).toBe("LF PIT TEMPS");
    expect(tireTempsTitle("rf")).toBe("RF PIT TEMPS");
    expect(tireTempsTitle("lr")).toBe("LR PIT TEMPS");
    expect(tireTempsTitle("rr")).toBe("RR PIT TEMPS");
  });
});

describe("tireTempZoneOrder", () => {
  it("puts the outside shoulder on the left for a left tire", () => {
    expect(tireTempZoneOrder("lf")).toEqual(["outside", "middle", "inside"]);
    expect(tireTempZoneOrder("lr")).toEqual(["outside", "middle", "inside"]);
  });

  it("puts the outside shoulder on the right for a right tire", () => {
    expect(tireTempZoneOrder("rf")).toEqual(["inside", "middle", "outside"]);
    expect(tireTempZoneOrder("rr")).toEqual(["inside", "middle", "outside"]);
  });
});

describe("resolveTireTempsDisplay — all four", () => {
  it("summarizes each tire by the weighted center by default and colors it by band", () => {
    expect(resolveTireTempsDisplay(settings(), reading(), METRIC)).toEqual({
      view: "all",
      corners: {
        lf: { text: "82°", band: "in" }, // 81.5
        rf: { text: "94°", band: "above" }, // 93.5
        lr: { text: "62°", band: "below" },
        rr: { text: "105°", band: "well-above" }, // 104.75
      },
    });
  });

  it.each([
    ["average", "82°"],
    ["max", "96°"],
    ["middle", "80°"],
  ] as const)("applies the %s method", (tireTempMethod, lf) => {
    const display = resolveTireTempsDisplay(settings({ tireTempMethod }), reading(), METRIC);

    expect(display.view === "all" && display.corners.lf.text).toBe(lf);
  });

  it("converts the figure for display without changing its band", () => {
    const metric = resolveTireTempsDisplay(settings(), reading(), METRIC);
    const english = resolveTireTempsDisplay(settings(), reading(), ENGLISH);

    expect(english).toEqual({
      view: "all",
      corners: {
        lf: { text: "179°", band: "in" }, // 81.5 °C = 178.7 °F
        rf: { text: "200°", band: "above" }, // 93.5 °C = 200.3 °F
        lr: { text: "144°", band: "below" }, // 62 °C = 143.6 °F
        rr: { text: "221°", band: "well-above" }, // 104.75 °C = 220.55 °F
      },
    });
    expect(metric.view === "all" && english.view === "all" && metric.corners.rr.band).toBe("well-above");
  });

  it("colors by the Fahrenheit set when that unit is selected, whatever the display units", () => {
    // 81.5 °C is 178.7 °F: in the default °C window, above a 170 °F ceiling.
    const display = resolveTireTempsDisplay(
      settings({ tireTempThresholdUnit: "f", tireTempHotAboveF: 170 }),
      reading(),
      METRIC,
    );

    expect(display.view === "all" && display.corners.lf).toEqual({ text: "82°", band: "above" });
  });

  it("takes the theme text color with colors off: no figure carries a band", () => {
    const display = resolveTireTempsDisplay(settings({ tireTempColors: false }), reading(), METRIC);

    expect(display).toEqual({
      view: "all",
      corners: {
        lf: { text: "82°", band: null },
        rf: { text: "94°", band: null },
        lr: { text: "62°", band: null },
        rr: { text: "105°", band: null },
      },
    });
  });

  it("shows the placeholder in every slot with no reading, never a zero", () => {
    const blank = { text: "--", band: null };

    expect(resolveTireTempsDisplay(settings(), null, METRIC)).toEqual({
      view: "all",
      corners: { lf: blank, rf: blank, lr: blank, rr: blank },
    });
  });
});

describe("resolveTireTempsDisplay — one corner", () => {
  it("lays a left tire out outside, middle, inside", () => {
    expect(resolveTireTempsDisplay(settings({ tireTempCorner: "lf" }), reading(), METRIC)).toEqual({
      view: "corner",
      corner: "lf",
      zones: [
        { zone: "outside", text: "70°", band: "below" },
        { zone: "middle", text: "80°", band: "in" },
        { zone: "inside", text: "96°", band: "above" },
      ],
    });
  });

  it("lays a right tire out inside, middle, outside", () => {
    expect(resolveTireTempsDisplay(settings({ tireTempCorner: "rf" }), reading(), METRIC)).toEqual({
      view: "corner",
      corner: "rf",
      zones: [
        { zone: "inside", text: "97°", band: "above" },
        { zone: "middle", text: "93°", band: "above" },
        { zone: "outside", text: "91°", band: "above" },
      ],
    });
  });

  it("mirrors the rear tires the same way", () => {
    const zonesOf = (tireTempCorner: string) => {
      const display = resolveTireTempsDisplay(settings({ tireTempCorner }), reading(), METRIC);

      return display.view === "corner" ? display.zones.map((zone) => `${zone.zone}:${zone.text}`) : [];
    };

    expect(zonesOf("lr")).toEqual(["outside:60°", "middle:62°", "inside:64°"]);
    expect(zonesOf("rr")).toEqual(["inside:110°", "middle:104°", "outside:101°"]);
  });

  it("colors each zone on its own raw value: the calculation method does not apply", () => {
    const perMethod = (["weighted", "average", "max", "middle"] as const).map((tireTempMethod) =>
      resolveTireTempsDisplay(settings({ tireTempCorner: "lf", tireTempMethod }), reading(), METRIC),
    );

    for (const display of perMethod) expect(display).toEqual(perMethod[0]);
  });

  it("shows the three zones in the driver's display units", () => {
    const display = resolveTireTempsDisplay(settings({ tireTempCorner: "lf" }), reading(), ENGLISH);

    expect(display.view === "corner" && display.zones.map((zone) => zone.text)).toEqual(["158°", "176°", "205°"]);
  });

  it("shows the placeholder in all three slots with no reading", () => {
    for (const tireTempCorner of ["lf", "rf", "lr", "rr"]) {
      const display = resolveTireTempsDisplay(settings({ tireTempCorner }), null, METRIC);

      expect(display.view === "corner" && display.zones.map((zone) => [zone.text, zone.band])).toEqual([
        ["--", null],
        ["--", null],
        ["--", null],
      ]);
    }
  });
});

describe("tireTempsStateKey", () => {
  it("is the same for two readings that are equal but not the same object", () => {
    const a = tireTempsStateKey(resolveTireTempsDisplay(settings(), reading(), METRIC));
    const b = tireTempsStateKey(resolveTireTempsDisplay(settings(), reading(), METRIC));

    expect(a).toBe(b);
  });

  it("does not change while a moving value still shows the same figure in the same band", () => {
    const at = (middle: number) =>
      tireTempsStateKey(
        resolveTireTempsDisplay(settings(), { corners: { ...reading().corners, lf: temps(80, middle, 80) } }, METRIC),
      );

    expect(at(80.1)).toBe(at(80.3));
  });

  it("changes when a figure does", () => {
    const changed: LastStopTireTemps = { corners: { ...reading().corners, lr: temps(66, 66, 66) } };

    expect(tireTempsStateKey(resolveTireTempsDisplay(settings(), changed, METRIC))).not.toBe(
      tireTempsStateKey(resolveTireTempsDisplay(settings(), reading(), METRIC)),
    );
  });

  it("changes when only the band does, the figure still reading the same", () => {
    const at = (value: number) =>
      tireTempsStateKey(
        resolveTireTempsDisplay(
          settings({ tireTempMethod: "middle" }),
          { corners: { ...reading().corners, lf: temps(value, value, value) } },
          METRIC,
        ),
      );

    // Both show 90°, on either side of the 90 threshold.
    expect(at(89.6)).not.toBe(at(90.4));
  });

  it("changes with the display units, the view and the first reading", () => {
    const keys = [
      tireTempsStateKey(resolveTireTempsDisplay(settings(), null, METRIC)),
      tireTempsStateKey(resolveTireTempsDisplay(settings(), reading(), METRIC)),
      tireTempsStateKey(resolveTireTempsDisplay(settings(), reading(), ENGLISH)),
      tireTempsStateKey(resolveTireTempsDisplay(settings({ tireTempCorner: "lf" }), reading(), METRIC)),
      tireTempsStateKey(resolveTireTempsDisplay(settings({ tireTempCorner: "rf" }), reading(), METRIC)),
      tireTempsStateKey(resolveTireTempsDisplay(settings({ tireTempCorner: "lf" }), null, METRIC)),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("generateTireTempsGraphic — all four", () => {
  const display = resolveTireTempsDisplay(settings(), reading(), METRIC);

  it("draws the four figures as the car seen from above", () => {
    const [lf, rf, lr, rr] = render(display);

    expect([lf!.content, rf!.content, lr!.content, rr!.content]).toEqual(["82°", "94°", "62°", "105°"]);
    // Left column / right column.
    expect(lf!.x).toBe(lr!.x);
    expect(rf!.x).toBe(rr!.x);
    expect(lf!.x).toBeLessThan(rf!.x);
    // Front row above the rear row.
    expect(lf!.y).toBe(rf!.y);
    expect(lr!.y).toBe(rr!.y);
    expect(lf!.y).toBeLessThan(lr!.y);
  });

  it("colors each figure by its band", () => {
    expect(render(display).map((text) => text.fill)).toEqual([GREEN, YELLOW, BLUE, RED]);
    expect(TIRE_TEMP_BAND_COLORS).toEqual({ below: BLUE, in: GREEN, above: YELLOW, "well-above": RED });
  });

  it("draws every figure in the theme text color with colors off", () => {
    const plain = resolveTireTempsDisplay(settings({ tireTempColors: false }), reading(), METRIC);

    expect(render(plain).map((text) => text.fill)).toEqual([TEXT, TEXT, TEXT, TEXT]);
  });

  it("draws the placeholder four times with no reading, in the theme text color", () => {
    const texts = render(resolveTireTempsDisplay(settings(), null, METRIC));

    expect(texts.map((text) => text.content)).toEqual(["--", "--", "--", "--"]);
    expect(texts.map((text) => text.fill)).toEqual([TEXT, TEXT, TEXT, TEXT]);
  });

  it("uses one size for the four figures, never above the surface's own", () => {
    const sizes = render(display, TIRE_TEMPS_KEY_CANVAS, 28).map((text) => text.size);

    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeLessThanOrEqual(28);
  });

  it("shrinks the figures to their cell rather than letting them overflow it", () => {
    const wide = render(display, TIRE_TEMPS_KEY_CANVAS, 72)[0]!.size;
    const narrow = render(display, { x: 0, y: 0, width: 80, height: 98 }, 72)[0]!.size;

    expect(wide).toBeLessThan(72);
    expect(narrow).toBeLessThan(wide);
  });

  it("centers each figure in its quarter of whatever canvas it is given", () => {
    const [lf, rf, lr, rr] = render(display, { x: 0, y: 0, width: 200, height: 100 });

    expect([lf!.x, rf!.x, lr!.x, rr!.x]).toEqual([50, 150, 50, 150]);
    // The baseline sits half a cap height under the cell's center line.
    expect(lf!.y).toBeCloseTo(25 + (lf!.size * 0.716) / 2, 1);
    expect(lr!.y).toBeCloseTo(75 + (lr!.size * 0.716) / 2, 1);
  });

  it("follows the canvas origin", () => {
    const at = (x: number, y: number) => render(display, { x, y, width: 200, height: 100 })[0]!;

    expect(at(10, 20).x).toBe(at(0, 0).x + 10);
    expect(at(10, 20).y).toBeCloseTo(at(0, 0).y + 20, 5);
  });
});

describe("generateTireTempsGraphic — one corner", () => {
  /** Figures and letters apart, each left to right. */
  function columns(tireTempCorner: string, units = METRIC) {
    const texts = render(resolveTireTempsDisplay(settings({ tireTempCorner }), reading(), units));
    const letters = texts.filter((text) => /^[OMI]$/.test(text.content));
    const figures = texts.filter((text) => !/^[OMI]$/.test(text.content));
    const byX = (a: DrawnText, b: DrawnText) => a.x - b.x;

    return { figures: figures.sort(byX), letters: letters.sort(byX) };
  }

  it("draws a left tire's zones outside to inside, left to right, with their letters", () => {
    const { figures, letters } = columns("lf");

    expect(figures.map((text) => text.content)).toEqual(["70°", "80°", "96°"]);
    expect(letters.map((text) => text.content)).toEqual(["O", "M", "I"]);
  });

  it("draws a right tire's zones inside to outside, left to right, with their letters", () => {
    const { figures, letters } = columns("rf");

    expect(figures.map((text) => text.content)).toEqual(["97°", "93°", "91°"]);
    expect(letters.map((text) => text.content)).toEqual(["I", "M", "O"]);
  });

  it("keeps the outside shoulder on the outside of the car on all four corners", () => {
    expect(columns("lf").letters[0]!.content).toBe("O");
    expect(columns("lr").letters[0]!.content).toBe("O");
    expect(columns("rf").letters[2]!.content).toBe("O");
    expect(columns("rr").letters[2]!.content).toBe("O");
  });

  it("puts each letter under its own figure, smaller than it", () => {
    const { figures, letters } = columns("rr");

    for (let i = 0; i < 3; i++) {
      expect(letters[i]!.x).toBe(figures[i]!.x);
      expect(letters[i]!.y).toBeGreaterThan(figures[i]!.y);
      expect(letters[i]!.size).toBeLessThan(figures[i]!.size);
    }
  });

  it("colors each zone by its own band and leaves the letters in the theme text color", () => {
    const { figures, letters } = columns("lf");

    expect(figures.map((text) => text.fill)).toEqual([BLUE, GREEN, YELLOW]);
    expect(letters.map((text) => text.fill)).toEqual([TEXT, TEXT, TEXT]);
  });

  it("draws the placeholder three times with no reading, and still names the zones", () => {
    const texts = render(resolveTireTempsDisplay(settings({ tireTempCorner: "rf" }), null, METRIC));

    expect(texts.filter((text) => text.content === "--")).toHaveLength(3);
    expect(texts.filter((text) => text.content === "--").map((text) => text.fill)).toEqual([TEXT, TEXT, TEXT]);
    expect(texts.filter((text) => /^[OMI]$/.test(text.content)).map((text) => text.content)).toEqual(["I", "M", "O"]);
  });

  it("shrinks three-digit figures to their third of the key", () => {
    // 101 / 104 / 110 against 60 / 62 / 64.
    expect(columns("rr").figures[0]!.size).toBeLessThan(columns("lr").figures[0]!.size);
    // Fahrenheit is three digits on every tire.
    expect(columns("lr", ENGLISH).figures[0]!.size).toBeLessThan(columns("lr").figures[0]!.size);
  });

  it("keeps the whole stack inside the canvas", () => {
    const canvas = TIRE_TEMPS_KEY_CANVAS;

    for (const fontSize of [10, 28, 72]) {
      const texts = render(
        resolveTireTempsDisplay(settings({ tireTempCorner: "rr" }), reading(), ENGLISH),
        canvas,
        fontSize,
      );

      for (const text of texts) {
        expect(text.y).toBeLessThanOrEqual(canvas.y + canvas.height);
        expect(text.y - text.size * 0.716).toBeGreaterThanOrEqual(canvas.y);
        expect(text.x).toBeGreaterThan(canvas.x);
        expect(text.x).toBeLessThan(canvas.x + canvas.width);
      }
    }
  });
});
