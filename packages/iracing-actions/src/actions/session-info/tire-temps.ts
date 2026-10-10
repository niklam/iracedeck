/**
 * Session Info's Tire Temperatures item (issue #254) — the pure half: the
 * calculation methods, the color bands, the display units, the default titles
 * and the graphic. The action only reads the reading and calls in here.
 *
 * The figures are a PIT-STOP READING, never live temperatures: iRacing
 * refreshes the twelve carcass values only as the car comes in, and after a
 * tire change they still describe the set that came off. Which values are a
 * real reading is the translator's call (`getLastStopTireTemps()` in
 * `@iracedeck/sim-events-iracing`); this module only shows what it is handed.
 */
import { celsiusToFahrenheit } from "@iracedeck/deck-iracing";
import type { TireCorner } from "@iracedeck/event-bus";
import { DisplayUnits } from "@iracedeck/iracing-sdk";
import type { LastStopTireTemps, TireCornerTemps } from "@iracedeck/sim-events-iracing";

import type { SessionInfoSettings } from "./session-info-settings.js";

/** The Session Info settings the Tire Temperatures item reads. */
export type TireTempSettings = Pick<
  SessionInfoSettings,
  | "tireTempCorner"
  | "tireTempMethod"
  | "tireTempColors"
  | "tireTempThresholdUnit"
  | "tireTempColdBelow"
  | "tireTempHotAbove"
  | "tireTempCriticalAbove"
  | "tireTempColdBelowF"
  | "tireTempHotAboveF"
  | "tireTempCriticalAboveF"
>;

/** A tread zone, named from the car's centerline as the translator names it. */
export type TireTempZone = keyof TireCornerTemps;

/**
 * Where a figure sits against the driver's window. Each band describes the
 * carcass as the car arrived in the box — never live grip.
 */
export type TireTempBand = "below" | "in" | "above" | "well-above";

/**
 * The band colors. Semantic, so fixed across themes and platforms, like the
 * gain / loss colors of the iRating and Gaps items.
 */
export const TIRE_TEMP_BAND_COLORS: Readonly<Record<TireTempBand, string>> = {
  below: "#3498db",
  in: "#2ecc71",
  above: "#f1c40f",
  "well-above": "#e74c3c",
};

/** Shown in every slot while there is no reading — never a zero. */
export const TIRE_TEMP_PLACEHOLDER = "--";

/** The three thresholds of one unit's set, with the unit they are typed in. */
export type TireTempThresholds = {
  unit: SessionInfoSettings["tireTempThresholdUnit"];
  coldBelow: number;
  hotAbove: number;
  criticalAbove: number;
};

/**
 * The threshold set of the selected unit. Each unit has its own stored set,
 * so this picks one and never converts the other.
 */
export function tireTempThresholds(settings: TireTempSettings): TireTempThresholds {
  if (settings.tireTempThresholdUnit === "f") {
    return {
      unit: "f",
      coldBelow: settings.tireTempColdBelowF,
      hotAbove: settings.tireTempHotAboveF,
      criticalAbove: settings.tireTempCriticalAboveF,
    };
  }

  return {
    unit: "c",
    coldBelow: settings.tireTempColdBelow,
    hotAbove: settings.tireTempHotAbove,
    criticalAbove: settings.tireTempCriticalAbove,
  };
}

/**
 * One tire's three zones as a single figure, in °C and unrounded. The edges
 * are symmetric in every method, so it never matters which side of the car
 * the tire is on.
 */
export function summarizeTireTemp(temps: TireCornerTemps, method: SessionInfoSettings["tireTempMethod"]): number {
  const { inside, middle, outside } = temps;

  switch (method) {
    case "weighted":
      return (outside + 2 * middle + inside) / 4;
    case "average":
      return (outside + middle + inside) / 3;
    case "max":
      return Math.max(outside, middle, inside);
    case "middle":
      return middle;
  }
}

/**
 * The band of a figure given in °C. It is compared in the unit the thresholds
 * are typed in, unrounded, and hottest first — well above, then above, then
 * below, else in the window — so a hand-typed set that is out of order still
 * colors predictably. A threshold itself belongs to the cooler band: the
 * bands are "above 90" and "below 75", so exactly 90 and exactly 75 are both
 * in the window.
 */
export function tireTempBand(celsius: number, thresholds: TireTempThresholds): TireTempBand {
  const value = thresholds.unit === "f" ? celsiusToFahrenheit(celsius) : celsius;

  if (value > thresholds.criticalAbove) return "well-above";

  if (value > thresholds.hotAbove) return "above";

  if (value < thresholds.coldBelow) return "below";

  return "in";
}

/**
 * A °C figure as the key shows it: whole degrees in the driver's display
 * units, rounded once and only after the conversion, with a degree sign and no
 * unit letter. `DisplayUnits` unset counts as metric, the rule Track and Air
 * Temperature follow. A value that is not a number shows the placeholder.
 */
export function formatTireTemp(celsius: number, displayUnits: number | undefined): string {
  if (!Number.isFinite(celsius)) return TIRE_TEMP_PLACEHOLDER;

  const shown = displayUnits === DisplayUnits.English ? celsiusToFahrenheit(celsius) : celsius;

  return `${Math.round(shown)}°`;
}

/**
 * The default title. It says "pit" so nobody reads the figures as live, and
 * names the corner when the key shows only one.
 */
export function tireTempsTitle(corner: SessionInfoSettings["tireTempCorner"]): string {
  return corner === "all" ? "PIT TEMPS" : `${corner.toUpperCase()} PIT TEMPS`;
}

/**
 * One tire's zones in the car's left-to-right order, which is how the
 * single-corner view lays them out: the outside shoulder is the left column on
 * a left tire and the right column on a right tire, so four single-corner keys
 * arranged like the car read physically.
 */
export function tireTempZoneOrder(corner: TireCorner): readonly [TireTempZone, TireTempZone, TireTempZone] {
  return corner === "lf" || corner === "lr" ? ["outside", "middle", "inside"] : ["inside", "middle", "outside"];
}

/** The letter drawn under a zone in the single-corner view. */
export const TIRE_TEMP_ZONE_LETTERS: Readonly<Record<TireTempZone, string>> = {
  outside: "O",
  middle: "M",
  inside: "I",
};

/** One figure on the key: its text, and its band when it is colored. */
export type TireTempFigure = {
  /** `85°`, or the placeholder with no reading. */
  text: string;
  /** `null` with colors off or no reading: the figure takes the theme text color. */
  band: TireTempBand | null;
};

/** One column of the single-corner view. */
export type TireTempZoneFigure = TireTempFigure & { zone: TireTempZone };

/**
 * Everything the graphic draws, resolved once from the reading, the settings
 * and the display units, so the renderer holds no unit or band logic and the
 * state key and the image can never disagree.
 */
export type TireTempsDisplay =
  | { view: "all"; corners: Record<TireCorner, TireTempFigure> }
  | {
      view: "corner";
      corner: TireCorner;
      /** The three zones, left to right as seen from above the car. */
      zones: readonly [TireTempZoneFigure, TireTempZoneFigure, TireTempZoneFigure];
    };

/** The four corners in reading order of the grid: front row, then rear row. */
const GRID_CORNERS: readonly TireCorner[] = ["lf", "rf", "lr", "rr"];

/**
 * Resolves what the key shows. `reading` is `getLastStopTireTemps()`'s result
 * — `null` before the first reading, which shows the placeholder in every
 * slot of either view. The calculation method only applies to the all-four
 * view; a single corner colors each zone on its own raw value.
 */
export function resolveTireTempsDisplay(
  settings: TireTempSettings,
  reading: LastStopTireTemps | null,
  displayUnits: number | undefined,
): TireTempsDisplay {
  const thresholds = tireTempThresholds(settings);
  const figure = (celsius: number | undefined): TireTempFigure => {
    if (celsius === undefined || !Number.isFinite(celsius)) return { text: TIRE_TEMP_PLACEHOLDER, band: null };

    return {
      text: formatTireTemp(celsius, displayUnits),
      band: settings.tireTempColors ? tireTempBand(celsius, thresholds) : null,
    };
  };

  if (settings.tireTempCorner === "all") {
    const summary = (corner: TireCorner): TireTempFigure => {
      const temps = reading?.corners[corner];

      return figure(temps ? summarizeTireTemp(temps, settings.tireTempMethod) : undefined);
    };

    return { view: "all", corners: { lf: summary("lf"), rf: summary("rf"), lr: summary("lr"), rr: summary("rr") } };
  }

  const corner = settings.tireTempCorner;
  const temps = reading?.corners[corner];
  const zone = (name: TireTempZone): TireTempZoneFigure => ({ zone: name, ...figure(temps?.[name]) });
  const [left, center, right] = tireTempZoneOrder(corner);

  return { view: "corner", corner, zones: [zone(left), zone(center), zone(right)] };
}

/**
 * A string that changes exactly when the picture does: every figure's text
 * and band. Built from the resolved values, never from the reading object —
 * the translator hands out a new one on every tick of a stop.
 */
export function tireTempsStateKey(display: TireTempsDisplay): string {
  const part = (figure: TireTempFigure): string => `${figure.text}:${figure.band ?? "-"}`;

  if (display.view === "all") return `all|${GRID_CORNERS.map((corner) => part(display.corners[corner])).join("|")}`;

  return `${display.corner}|${display.zones.map((zone) => `${zone.zone}=${part(zone)}`).join("|")}`;
}

/** The rectangle the graphic draws into, in the units of the SVG it lands in. */
export type TireTempsCanvas = { x: number; y: number; width: number; height: number };

/** What the surface decides: the largest figure size, and the theme text color. */
export type TireTempsStyle = {
  /** Upper bound for the figures, in SVG units. They shrink to fit their cell. */
  fontSize: number;
  /** Fill for a figure with no band, and for the zone letters. */
  textColor: string;
};

/**
 * The area of a 144-unit key the graphic draws into: above the bottom title,
 * with a margin that clears the rounded corners and an enabled border.
 */
export const TIRE_TEMPS_KEY_CANVAS: TireTempsCanvas = { x: 5, y: 10, width: 134, height: 98 };

/** Smallest figure size the graphic shrinks to before overflowing its cell. */
const MIN_FIGURE_SIZE = 10;

/** Cap height of the icon's bold Arial (Arimo Bold in the rasterizer), in em. */
const CAP_HEIGHT_EM = 0.716;

/**
 * Horizontal room kept free between two neighboring figures, in em of the
 * figure. The three zones of one tire sit closer than the four tires of the
 * grid: three figures share the width there, and the degree signs already
 * part them.
 */
const GRID_GAP_EM = 0.35;
const ZONE_GAP_EM = 0.15;

/** Zone letter size and the gap above it, relative to the figure. */
const LETTER_SIZE_RATIO = 0.55;
const LETTER_GAP_RATIO = 0.3;

/**
 * Smallest zone letter, relative to the canvas height. The letters name the
 * columns, so they stay readable when three wide figures shrink.
 */
const MIN_LETTER_HEIGHT_RATIO = 0.14;

/**
 * Advance width of a figure in em. Measured per glyph rather than averaged:
 * the figures are digits, a degree sign and at most a minus, all narrower than
 * the 0.62em average the wind label is fitted by, and the difference is a
 * visibly larger figure on a key that carries four of them.
 */
function figureWidthEm(text: string): number {
  let width = 0;

  for (const char of text) {
    if (char >= "0" && char <= "9") width += 0.556;
    else if (char === "°") width += 0.4;
    else if (char === "-") width += 0.333;
    else width += 0.62;
  }

  return width;
}

/**
 * The largest size at which the widest of `texts` fits `cellWidth` and one
 * line fits `maxHeight`, capped at the surface's own size. One size for the
 * whole view, so the figures line up.
 */
function fitFigureSize(
  texts: readonly string[],
  cellWidth: number,
  gapEm: number,
  maxHeight: number,
  maxSize: number,
): number {
  const widest = Math.max(...texts.map(figureWidthEm));
  const byWidth = cellWidth / (widest + gapEm);

  return Math.max(MIN_FIGURE_SIZE, Math.floor(Math.min(maxSize, byWidth, maxHeight)));
}

const round = (n: number): number => Math.round(n * 10) / 10;

function textElement(x: number, baseline: number, size: number, fill: string, content: string): string {
  return `<text x="${round(x)}" y="${round(baseline)}" text-anchor="middle" fill="${fill}" font-family="Arial, sans-serif" font-size="${size}" font-weight="bold">${content}</text>`;
}

/**
 * Generates the Tire Temperatures graphic as an SVG fragment: a pure function
 * of the resolved display, the canvas it draws into and the surface's style,
 * so a strip or a knob screen can draw the same item at its own size.
 *
 * All four tires are a 2×2 grid laid out as the car seen from above — LF top
 * left, RF top right, LR bottom left, RR bottom right. A single corner is its
 * three zones side by side in the car's left-to-right order, each with its
 * zone letter beneath. Only text, so it renders the same on every platform;
 * each baseline is computed, since no engine here honors `dominant-baseline`.
 */
export function generateTireTempsGraphic(
  display: TireTempsDisplay,
  canvas: TireTempsCanvas,
  style: TireTempsStyle,
): string {
  const fillOf = (figure: TireTempFigure): string =>
    figure.band ? TIRE_TEMP_BAND_COLORS[figure.band] : style.textColor;

  if (display.view === "all") {
    const cellWidth = canvas.width / 2;
    const cellHeight = canvas.height / 2;
    const size = fitFigureSize(
      GRID_CORNERS.map((corner) => display.corners[corner].text),
      cellWidth,
      GRID_GAP_EM,
      // A line of digits is its cap height tall; the rest of the cell is the
      // gap between the two rows.
      cellHeight * 0.8,
      style.fontSize,
    );

    return GRID_CORNERS.map((corner, i) => {
      const figure = display.corners[corner];
      const centerX = canvas.x + cellWidth * ((i % 2) + 0.5);
      const centerY = canvas.y + cellHeight * (Math.floor(i / 2) + 0.5);

      return textElement(centerX, centerY + (size * CAP_HEIGHT_EM) / 2, size, fillOf(figure), figure.text);
    }).join("\n    ");
  }

  const cellWidth = canvas.width / 3;
  // Figure, gap and letter stack to this many figure-sizes, which bounds the
  // figure by the canvas height.
  const stackEm = CAP_HEIGHT_EM + LETTER_GAP_RATIO + LETTER_SIZE_RATIO * CAP_HEIGHT_EM;
  const size = fitFigureSize(
    display.zones.map((zone) => zone.text),
    cellWidth,
    ZONE_GAP_EM,
    canvas.height / stackEm,
    style.fontSize,
  );
  const letterSize = Math.min(
    size,
    Math.max(Math.round(canvas.height * MIN_LETTER_HEIGHT_RATIO), Math.round(size * LETTER_SIZE_RATIO)),
  );
  const figureHeight = size * CAP_HEIGHT_EM;
  const stackHeight = figureHeight + size * LETTER_GAP_RATIO + letterSize * CAP_HEIGHT_EM;
  const top = canvas.y + (canvas.height - stackHeight) / 2;
  const parts: string[] = [];

  display.zones.forEach((zone, i) => {
    const centerX = canvas.x + cellWidth * (i + 0.5);

    parts.push(textElement(centerX, top + figureHeight, size, fillOf(zone), zone.text));
    parts.push(textElement(centerX, top + stackHeight, letterSize, style.textColor, TIRE_TEMP_ZONE_LETTERS[zone.zone]));
  });

  return parts.join("\n    ");
}
