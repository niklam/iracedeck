import {
  CommonSettings,
  ConnectionStateAwareAction,
  generateBorderParts,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalTitleSettings,
  IconUpdateThrottle,
  type IDeckDidReceiveSettingsEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveBorderSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import {
  absoluteWindBearingDeg,
  compassPoint,
  DisplayUnits,
  estimateIRatingChanges,
  extractQualifyResults,
  type FlagInfo,
  formatWindSpeed,
  type SessionInfo as IRacingSessionInfo,
  type IRatingFieldDriver,
  isCalmWind,
  isLiveOnTrack,
  isPreGreen,
  normalizeDegrees,
  relativeWindAngleDeg,
  resolveActiveFlag,
  resolveIRatingEstimateOrder,
  type TelemetryData,
  TrackWetness,
} from "@iracedeck/iracing-sdk";
import {
  FUEL_LAP_HISTORY_CAP,
  type GapNeighbor,
  getFuelStats,
  getLiveGaps,
  getLivePosition,
  getLiveRacePositions,
  getStartingGridPosition,
  type LiveGaps,
} from "@iracedeck/sim-events-iracing";
import z from "zod";

import sessionInfoTemplate from "../../../icons/session-info.svg";

const BACKGROUND_FLASH = "#e74c3c";

/** Favorable / unfavorable value colors, shared by the irating and gaps modes. */
const GAIN_COLOR = "#2ecc71";
const LOSS_COLOR = "#e74c3c";

/** Value shown by the irating mode when no estimate is possible (#872). */
const IRATING_NO_ESTIMATE = "--";

/**
 * @internal Exported for testing
 *
 * Value color for the irating mode: green for a gain, red for a loss,
 * undefined (theme text color) for zero, blank, or the "--" placeholder.
 */
export function iratingValueColor(value: string): string | undefined {
  if (value === IRATING_NO_ESTIMATE) return undefined;

  if (value.startsWith("+")) return GAIN_COLOR;

  if (value.startsWith("-")) return LOSS_COLOR;

  return undefined;
}

const FLASH_INTERVAL_MS = 250;
const FLASH_STEPS = 12; // on-off x6 (6 red flashes)

const PULSE_INTERVAL_MS = 500;

/** iRacing uses 604800s (7 days) as the sentinel for unlimited session time */
const UNLIMITED_TIME_THRESHOLD = 604800;

/** iRacing uses 32767 as the sentinel for unlimited laps */
const UNLIMITED_LAPS = 32767;

const LITERS_PER_GALLON = 3.78541;

const SessionInfoSettings = CommonSettings.extend({
  mode: z
    .enum([
      "incidents",
      "time-remaining",
      "laps",
      "position",
      "irating",
      "gaps",
      "fuel",
      "flags",
      "track-wetness",
      "laps-to-empty",
      "wind",
    ])
    .default("incidents"),
  fontSize: z.preprocess(
    (val) => (val === "" || val === null || val === undefined ? undefined : val),
    z.coerce.number().min(5).max(36).optional(),
  ),
  positionType: z.enum(["class", "overall"]).default("class"),
  positionShowTotal: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false),
  fuelFormat: z.enum(["amount", "percentage"]).default("amount"),
  // Fuel consumption sub-modes (issue #465): "now" is the pre-existing tank
  // level display; "lastLap" / "avgN" read the translator's validated fuel lap
  // history via getFuelStats(). fuelLapWindow rounds + clamps instead of
  // validating hard — a hand-typed decimal (the PI number box doesn't
  // step-round) or an out-of-range persisted value must not fail the whole
  // settings parse, which would silently reset the action to its defaults.
  fuelSubMode: z.enum(["now", "lastLap", "avgN"]).default("now"),
  fuelLapWindow: z.preprocess(
    (val) => (val === "" || val === null || val === undefined ? undefined : val),
    z.coerce
      .number()
      .transform((val) => Math.min(FUEL_LAP_HISTORY_CAP, Math.max(1, Math.round(val))))
      .catch(5),
  ),
  blankWhenNoFlag: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false),
  // Gaps mode row toggles (issue #933): which of the two class-neighbor gap
  // rows the key shows. Both default on; a single enabled row renders larger.
  gapShowAhead: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(true),
  gapShowBehind: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(true),
  // Wind mode (issue #947). "relative" points the arrow where the wind pushes
  // the car (the useful reading mid-corner); "absolute" points it where the
  // wind travels in world space, north up, and names the compass direction it
  // blows FROM — matching how iRacing itself labels wind.
  windDirectionMode: z.enum(["relative", "absolute"]).default("relative"),
  windSpeedUnit: z.enum(["ms", "kmh", "mph"]).default("kmh"),
});

type SessionInfoSettings = z.infer<typeof SessionInfoSettings>;

/**
 * @internal Exported for testing
 *
 * Formats a time in seconds to a human-readable string.
 * Auto-adapts: H:MM:SS / MM:SS / 0:SS
 */
export function formatSessionTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";

  const totalSeconds = Math.floor(seconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * @internal Exported for testing
 *
 * Formats a fuel amount for display. Respects the player's DisplayUnits
 * setting. Tank-level readings use the default 1 decimal; the per-lap
 * consumption sub-modes pass 2 — a tenth of a liter (let alone a tenth of a
 * gallon) is too coarse for stint planning.
 */
export function formatFuelAmount(fuelLevel: number, displayUnits: number | undefined, decimals = 1): string {
  if (displayUnits === DisplayUnits.English) {
    const gallons = fuelLevel / LITERS_PER_GALLON;

    return `${gallons.toFixed(decimals)} gal`;
  }

  return `${fuelLevel.toFixed(decimals)} L`;
}

/**
 * @internal Exported for testing
 *
 * Counts the number of active drivers in the session using the DriverInfo.Drivers
 * array from session info. Filters out the pace car and spectators.
 *
 * This is more reliable than counting CarIdxPosition entries from telemetry,
 * which retains stale values for disconnected cars.
 */
export function countActiveDrivers(sessionInfo: IRacingSessionInfo | null): number {
  if (!sessionInfo) return 0;

  const driverInfo = sessionInfo.DriverInfo as { Drivers?: Array<Record<string, unknown>> } | undefined;
  const drivers = driverInfo?.Drivers;

  if (!Array.isArray(drivers)) return 0;

  return drivers.filter((d) => d.CarIsPaceCar !== 1 && d.IsSpectator !== 1).length;
}

/**
 * @internal Exported for testing
 *
 * Counts the active drivers sharing the player's car class — the field size
 * used when "Show Total Cars" is enabled and the action is showing class
 * position. The player's class is resolved from `DriverInfo.Drivers` via
 * `DriverInfo.DriverCarIdx`; the same pace-car / spectator filter as
 * `countActiveDrivers` applies.
 *
 * Returns 0 when the player's class can't be resolved, so the caller drops the
 * `/total` suffix (mirroring the overall-position path's `total > 0` guard).
 */
export function countActiveDriversInPlayerClass(sessionInfo: IRacingSessionInfo | null): number {
  if (!sessionInfo) return 0;

  const driverInfo = sessionInfo.DriverInfo as
    { Drivers?: Array<Record<string, unknown>>; DriverCarIdx?: number } | undefined;
  const drivers = driverInfo?.Drivers;

  if (!Array.isArray(drivers)) return 0;

  const playerCarIdx = driverInfo?.DriverCarIdx;
  const playerClassId = drivers.find((d) => d.CarIdx === playerCarIdx)?.CarClassID;

  if (playerClassId === undefined) return 0;

  return drivers.filter((d) => d.CarClassID === playerClassId && d.CarIsPaceCar !== 1 && d.IsSpectator !== 1).length;
}

/**
 * Lit-segment colors for the track-wetness bar (cyan → deep blue gradient across 6 states).
 * Index 0 is the bottom-most segment (lit at MostlyDry), index 5 is the top (lit at ExtremelyWet).
 * Dry shows zero lit segments. Semantic colors — fixed across platforms (see
 * `.claude/rules/icons.md` "What stays fixed").
 */
const TRACK_WETNESS_SEGMENT_COLORS = [
  "#a8e6f0", // MostlyDry
  "#6dc9e3", // VeryLightlyWet
  "#3b9bc4", // LightlyWet
  "#1f7eb0", // ModeratelyWet
  "#15639a", // VeryWet
  "#0e4c80", // ExtremelyWet
] as const;

const TRACK_WETNESS_UNLIT_COLOR = "#3a3a3a";

/**
 * @internal Exported for testing
 *
 * Maps a TrackWetness enum value to a short upper-case label rendered as the
 * action title at the bottom of the icon. Returns "--" for Unknown / undefined.
 */
export function trackWetnessLabel(state: TrackWetness | undefined): string {
  switch (state) {
    case TrackWetness.Dry:
      return "DRY";
    case TrackWetness.MostlyDry:
      return "MOSTLY DRY";
    case TrackWetness.VeryLightlyWet:
      return "V. LIGHT";
    case TrackWetness.LightlyWet:
      return "LIGHT";
    case TrackWetness.ModeratelyWet:
      return "MODERATE";
    case TrackWetness.VeryWet:
      return "VERY WET";
    case TrackWetness.ExtremelyWet:
      return "EXTREME";
    default:
      return "--";
  }
}

/**
 * @internal Exported for testing
 *
 * Generates an inline SVG fragment showing a centered vertical 6-segment bar that
 * fills cumulatively from the bottom using a cyan→deep-blue gradient. Dry and
 * Unknown render zero lit segments; ExtremelyWet renders all six. The state label
 * is rendered separately as the icon title (see `generateSessionInfoSvg`).
 */
export function generateTrackWetnessGraphic(state: TrackWetness | undefined): string {
  // Dry → 0 lit, MostlyDry → 1, …, ExtremelyWet → 6.
  const lit =
    state !== undefined && state >= TrackWetness.MostlyDry && state <= TrackWetness.ExtremelyWet ? state - 1 : 0;

  // Centered vertical 6-segment bar: 6 × 14 high + 5 × 3 gap = 99.
  // Bottom at y=110, top at y=11; horizontally centered at x=72 with width=80 (x=32..112).
  const segH = 14;
  const gap = 3;
  const barX = 32;
  const barW = 80;
  const barBottom = 110;
  const segments: string[] = [];

  for (let i = 0; i < 6; i++) {
    const y = barBottom - segH - i * (segH + gap);
    const fill = i < lit ? TRACK_WETNESS_SEGMENT_COLORS[i] : TRACK_WETNESS_UNLIT_COLOR;
    segments.push(`<rect x="${barX}" y="${y}" width="${barW}" height="${segH}" rx="2" fill="${fill}"/>`);
  }

  return segments.join("\n    ");
}

/**
 * The icon's value size in SVG units for a given PI font-size setting: the PI
 * value is doubled for the 144-unit canvas, and an unset value falls back to
 * the template default. Single source of truth for every mode that sizes text
 * itself rather than through the template's value slot.
 */
function resolveValueFontSize(fontSize: number | undefined): number {
  return fontSize !== undefined ? fontSize * 2 : 28;
}

/** Placeholder for a missing neighbor / not-yet-computable gap. */
const GAP_PLACEHOLDER = "–";

/**
 * @internal Exported for testing
 *
 * Formats one gap row's value: `–` for a missing neighbor or a gap the
 * traces can't cover yet (cold start / outside races), `NL` when the
 * neighbor is N full laps away, one decimal below 100 s, whole seconds
 * above.
 */
export function formatGapValue(side: GapNeighbor | null): string {
  if (!side) return GAP_PLACEHOLDER;

  if (side.lapDelta >= 1) return `${side.lapDelta}L`;

  if (side.gapSeconds === null) return GAP_PLACEHOLDER;

  if (side.gapSeconds < 99.95) return side.gapSeconds.toFixed(1);

  return String(Math.round(side.gapSeconds));
}

/**
 * Row color from the trend: color encodes whether the gap is moving in the
 * player's favor (ahead shrinking / behind growing = green), never row
 * identity. Steady / unknown renders in the theme text color.
 */
function gapRowColor(side: GapNeighbor | null, isAhead: boolean, textColor: string): string {
  if (!side || side.trend === null || side.trend === "steady") return textColor;

  const favorable = isAhead ? side.trend === "closing" : side.trend === "opening";

  return favorable ? GAIN_COLOR : LOSS_COLOR;
}

/**
 * @internal Exported for testing
 *
 * Generates the gaps-mode graphic: one row per enabled side, each an
 * ahead/behind triangle marker plus the gap value, trend-colored per row.
 * The marker is drawn as an SVG polygon (not a text glyph) so it renders
 * identically regardless of font glyph coverage. Rows center vertically in
 * the same area the single-value modes use; a single enabled row renders at
 * the full configured size.
 */
export function generateGapsGraphic(
  gaps: LiveGaps | null,
  showAhead: boolean,
  showBehind: boolean,
  fontSize: number | undefined,
  textColor: string,
): string {
  const configuredSize = resolveValueFontSize(fontSize);
  const rows: { up: boolean; value: string; fill: string }[] = [];

  if (showAhead) {
    rows.push({
      up: true,
      value: formatGapValue(gaps?.ahead ?? null),
      fill: gapRowColor(gaps?.ahead ?? null, true, textColor),
    });
  }

  if (showBehind) {
    rows.push({
      up: false,
      value: formatGapValue(gaps?.behind ?? null),
      fill: gapRowColor(gaps?.behind ?? null, false, textColor),
    });
  }

  if (rows.length === 0) return "";

  const rowSize = rows.length === 1 ? configuredSize : Math.min(configuredSize, 30);
  // Same vertical anchor math as the template's single value slot /
  // telemetry-display's multi-line generator.
  const baseY = 88 + (rowSize - 44) / 3;
  const lineHeight = rowSize * 1.2;
  const startY = baseY - ((rows.length - 1) * lineHeight) / 2;
  const parts: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const y = startY + i * lineHeight;
    // Marker triangle vertically centered on the row's cap height.
    const cy = y - rowSize * 0.32;
    const h = rowSize * 0.26;
    const markerX = 30;
    const points = row.up
      ? `${markerX - h},${cy + h * 0.8} ${markerX + h},${cy + h * 0.8} ${markerX},${cy - h}`
      : `${markerX - h},${cy - h * 0.8} ${markerX + h},${cy - h * 0.8} ${markerX},${cy + h}`;

    parts.push(`<polygon points="${points}" fill="${row.fill}"/>`);
    parts.push(
      `<text x="82" y="${y}" text-anchor="middle" fill="${row.fill}" font-family="Arial, sans-serif" font-size="${rowSize}" font-weight="bold">${row.value}</text>`,
    );
  }

  return parts.join("\n    ");
}

/**
 * Everything the wind graphic needs, resolved from telemetry once so the
 * renderer stays free of unit and convention logic.
 */
export type WindDisplay = {
  /**
   * Arrow rotation in degrees clockwise from "pointing up". Up is forward in
   * relative mode and north in absolute mode; the arrow always points where
   * the wind TRAVELS, never where it comes from.
   *
   * `null` when the wind is calm at the chosen unit's display precision — a
   * direction is meaningless once the speed reads zero, so the renderer draws
   * the reading without an arrow rather than asserting a heading.
   */
  arrowDeg: number | null;
  /** Single text line under the arrow, e.g. `"11 km/h"` or `"NE 11 km/h"`. */
  label: string;
};

/**
 * Arrow rotation is quantized to this many degrees. Relative wind direction
 * changes continuously while cornering, so an unquantized angle would rebuild
 * and re-push the key image on essentially every telemetry tick. 5° still
 * gives 72 distinct headings — far finer than the eye resolves on a 72 px key,
 * and far more than the 8 states the feature request asked for.
 */
export const WIND_ARROW_STEP_DEG = 5;

/** Placeholder shown when wind data isn't available. */
const WIND_PLACEHOLDER = "--";

/**
 * Modes whose `graphicContent` draws the entire display, including any text.
 * The template's shared value slot is cleared for these so nothing is drawn
 * twice.
 */
const GRAPHIC_ONLY_MODES: ReadonlySet<SessionInfoSettings["mode"]> = new Set<SessionInfoSettings["mode"]>([
  "track-wetness",
  "gaps",
  "wind",
]);

function quantizeArrowDeg(degrees: number): number {
  return normalizeDegrees(Math.round(degrees / WIND_ARROW_STEP_DEG) * WIND_ARROW_STEP_DEG);
}

/**
 * @internal Exported for testing
 *
 * Resolves the wind display model, or `null` when the key should blank.
 *
 * Relative mode requires the car to be on track: `YawNorth` reads a flat `0`
 * whenever the player isn't in the car (verified across the issue's captures),
 * which would otherwise render a confident arrow computed from a heading of
 * "due north". Absolute mode needs only `WindDir`, so it keeps working in the
 * garage and on the session screen.
 */
export function resolveWindDisplay(settings: SessionInfoSettings, telemetry: TelemetryData | null): WindDisplay | null {
  if (!telemetry) return null;

  const speed = formatWindSpeed(telemetry.WindVel, settings.windSpeedUnit);

  if (speed === null) return null;

  // A calm reading still shows the speed, but with no arrow — pointing one
  // would assert a direction the number says doesn't exist.
  const calm = isCalmWind(telemetry.WindVel, settings.windSpeedUnit);

  if (settings.windDirectionMode === "absolute") {
    const bearing = absoluteWindBearingDeg(telemetry.WindDir);
    const name = compassPoint(bearing);

    if (bearing === null || name === null) return null;

    // The bearing names where the wind comes FROM; the arrow shows where it
    // goes, hence the 180° rotation (the same pairing iRacing's own weather
    // panel uses: a north wind is labelled "N" with the arrow pointing down).
    return {
      arrowDeg: calm ? null : quantizeArrowDeg(bearing + 180),
      label: calm ? speed : `${name} ${speed}`,
    };
  }

  if (!isLiveOnTrack(telemetry)) return null;

  const relative = relativeWindAngleDeg(telemetry.WindDir, telemetry.YawNorth);

  if (relative === null) return null;

  return { arrowDeg: calm ? null : quantizeArrowDeg(relative), label: speed };
}

/**
 * Largest font size, in SVG units, that renders `text` within `maxWidth` for
 * the icon's bold Arial, never below `MIN_LABEL_SIZE`. The 0.62em average
 * advance is measured from the existing value-slot text; auto-fitting is what
 * lets a long compass label ("NNE 11 km/h") share one sizing rule with a short
 * one ("7 mph") instead of hand-tuning a size per mode.
 */
function fitFontSize(text: string, maxWidth: number, maxSize: number): number {
  if (text.length === 0) return maxSize;

  return Math.max(MIN_LABEL_SIZE, Math.min(maxSize, Math.floor(maxWidth / (text.length * 0.62))));
}

/** Smallest label size the wind graphic will shrink to before overflowing. */
const MIN_LABEL_SIZE = 10;

/** Usable label width inside the key, leaving a margin on both sides. */
const LABEL_MAX_WIDTH = 128;

/** Baseline the wind label sits on. */
const WIND_LABEL_BASELINE = 106;

/** Top of the area the arrow may occupy. */
const WIND_GRAPHIC_TOP = 10;

/** Gap between the bottom of the arrow and the top of the label. */
const WIND_LABEL_GAP = 6;

/**
 * @internal Exported for testing
 *
 * Generates the wind-mode graphic: a bold arrow rotated to the wind direction
 * with the speed (and, in absolute mode, the compass name) on one line below.
 * The arrow is a single filled polygon rotated by an SVG transform — both are
 * in the always-safe SVG feature set, so it renders identically on every
 * platform and at any angle rather than snapping to a sprite set.
 *
 * Both the label and the placeholder are sized by the same `fitFontSize` rule
 * so the text doesn't change size when a reading appears, and the arrow shrinks
 * to whatever room the label leaves — which is what lets the Font Size setting
 * work across its whole documented range instead of saturating at a fixed cap.
 */
export function generateWindGraphic(
  display: WindDisplay | null,
  fontSize: number | undefined,
  textColor: string,
): string {
  const configuredSize = resolveValueFontSize(fontSize);
  const label = display?.label ?? WIND_PLACEHOLDER;
  const labelSize = fitFontSize(label, LABEL_MAX_WIDTH, configuredSize);
  const text = `<text x="72" y="${WIND_LABEL_BASELINE}" text-anchor="middle" fill="${textColor}" font-family="Arial, sans-serif" font-size="${labelSize}" font-weight="bold">${label}</text>`;

  // No arrow when there's no reading, or when the wind is calm enough that its
  // direction is meaningless — the label alone carries the display.
  if (!display || display.arrowDeg === null) return text;

  // The arrow fills the space above the label's cap height, so a large font
  // shrinks it rather than overlapping it.
  const labelTop = WIND_LABEL_BASELINE - labelSize * 0.72;
  const available = labelTop - WIND_LABEL_GAP - WIND_GRAPHIC_TOP;
  const half = Math.min(34, Math.max(12, available / 2));
  const cx = 72;
  const cy = WIND_GRAPHIC_TOP + half;
  const scale = half / 34;
  const headHalf = 22 * scale; // half width across the head's barbs
  const headDepth = 30 * scale; // tip to the barb line
  const shaftHalf = 8 * scale;
  const barbY = cy - half + headDepth;
  const round = (n: number) => Math.round(n * 10) / 10;
  const points = [
    `${cx},${round(cy - half)}`,
    `${round(cx + headHalf)},${round(barbY)}`,
    `${round(cx + shaftHalf)},${round(barbY)}`,
    `${round(cx + shaftHalf)},${round(cy + half)}`,
    `${round(cx - shaftHalf)},${round(cy + half)}`,
    `${round(cx - shaftHalf)},${round(barbY)}`,
    `${round(cx - headHalf)},${round(barbY)}`,
  ].join(" ");

  return [
    `<polygon points="${points}" fill="${textColor}" transform="rotate(${display.arrowDeg} ${cx} ${round(cy)})"/>`,
    text,
  ].join("\n    ");
}

/** Mode-specific state the icon needs beyond the plain value string. */
export type SessionInfoModeState = {
  /** Track-wetness state for the wetness bar. */
  trackWetness?: TrackWetness;
  /** Overrides the value text color (irating gain/loss). */
  valueColor?: string;
  /** Live gaps for the gaps rows. */
  gaps?: LiveGaps | null;
  /** Resolved wind arrow + label. */
  wind?: WindDisplay | null;
};

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI for the session info display.
 */
export function generateSessionInfoSvg(
  settings: SessionInfoSettings,
  value: string,
  isFlashing: boolean,
  colorOverride?: { background: string; text: string },
  modeState: SessionInfoModeState = {},
): string {
  const { trackWetness: trackWetnessState, valueColor, gaps: liveGaps, wind: windDisplay } = modeState;
  const titleLabels: Record<string, string> = {
    incidents: "INCIDENTS",
    "time-remaining": "TIME LEFT",
    laps: "LAPS",
    position: "POSITION",
    irating: "IRATING",
    gaps: "GAPS",
    fuel: "FUEL",
    flags: "FLAGS",
    "laps-to-empty": "LAPS TO\nEMPTY",
    wind: "WIND",
  };
  // Track-wetness uses the live state name as its title so the icon shows the
  // current state in one line. The fuel consumption sub-modes carry their own
  // labels so a glance tells which number the key is showing. All other modes
  // use a fixed category label.
  let actionDefaultTitle: string;

  if (settings.mode === "track-wetness") {
    actionDefaultTitle = trackWetnessLabel(trackWetnessState);
  } else if (settings.mode === "fuel" && settings.fuelSubMode === "lastLap") {
    actionDefaultTitle = "LAST LAP";
  } else if (settings.mode === "fuel" && settings.fuelSubMode === "avgN") {
    actionDefaultTitle = `AVG ${settings.fuelLapWindow} ${settings.fuelLapWindow === 1 ? "LAP" : "LAPS"}`;
  } else {
    actionDefaultTitle = titleLabels[settings.mode] ?? "INCIDENTS";
  }

  const valueFontSizeNum = resolveValueFontSize(settings.fontSize);
  const valueFontSize = String(valueFontSizeNum);
  const valueY = String(88 + (valueFontSizeNum - 44) / 3);

  let backgroundColor: string;
  let textColor: string;

  if (colorOverride) {
    // Flag/flash override takes priority over all color settings
    backgroundColor = colorOverride.background;
    textColor = colorOverride.text;
  } else {
    const colors = resolveIconColors(sessionInfoTemplate, getGlobalColors(), settings.colorOverrides);
    backgroundColor = isFlashing ? BACKGROUND_FLASH : colors.backgroundColor;
    textColor = colors.textColor;
  }

  const resolvedTitle = resolveTitleSettings(
    sessionInfoTemplate,
    getGlobalTitleSettings(),
    settings.titleOverrides,
    actionDefaultTitle,
  );

  const titleContent = resolvedTitle.showTitle
    ? generateTitleText({
        text: resolvedTitle.titleText,
        fontSize: resolvedTitle.fontSize,
        bold: resolvedTitle.bold,
        position: resolvedTitle.position,
        customPosition: resolvedTitle.customPosition,
        fill: textColor,
      })
    : "";

  const border = resolveBorderSettings(sessionInfoTemplate, getGlobalBorderSettings(), settings.borderOverrides);
  const borderSvg = generateBorderParts(border);

  let graphicContent = "";

  if (settings.mode === "track-wetness") {
    graphicContent = generateTrackWetnessGraphic(trackWetnessState);
  } else if (settings.mode === "gaps") {
    graphicContent = generateGapsGraphic(
      liveGaps ?? null,
      settings.gapShowAhead,
      settings.gapShowBehind,
      settings.fontSize,
      textColor,
    );
  } else if (settings.mode === "wind") {
    graphicContent = generateWindGraphic(windDisplay ?? null, settings.fontSize, textColor);
  }

  // The graphic content carries the whole display for these modes, so clear
  // the value text slot to avoid drawing anything twice.
  const valueText = GRAPHIC_ONLY_MODES.has(settings.mode) ? "" : value;

  const svg = renderIconTemplate(sessionInfoTemplate, {
    backgroundColor,
    titleContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    graphicContent,
    value: valueText,
    valueFontSize,
    valueY,
    // The title fill was already resolved into titleContent above, so a
    // value-only color override (irating gain/loss) only affects the value.
    textColor: valueColor ?? textColor,
  });

  return svgToDataUri(svg);
}

/**
 * Session Info Action
 * Displays live telemetry data: incident points, session time remaining,
 * laps, position, fuel level, or race flags.
 * Incident count increase triggers a red flash effect.
 * Black and meatball flags trigger a continuous pulse effect.
 */
export const SESSION_INFO_UUID = "com.iracedeck.sd.core.session-info" as const;

export class SessionInfo extends ConnectionStateAwareAction<SessionInfoSettings> {
  /** Settings per action context for telemetry-driven updates */
  private activeContexts = new Map<string, SessionInfoSettings>();

  /** State hash cache to prevent re-rendering every telemetry tick */
  private lastState = new Map<string, string>();

  /** Last known incident count per context for flash detection */
  private lastIncidentCount = new Map<string, number>();

  /** Active flash timer IDs per context for cancellation */
  private flashTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Whether a context is currently in flash state */
  private flashStates = new Map<string, boolean>();

  /** Last resolved flag key per context for change detection */
  private lastFlagKey = new Map<string, string>();

  /** Active flag pulse interval IDs per context */
  private flagPulseTimers = new Map<string, ReturnType<typeof setInterval>>();

  /**
   * Coalesces telemetry-driven image pushes to 10 Hz per context. Modes whose
   * value varies continuously (wind direction, gaps) would otherwise re-render
   * and re-rasterize on most sim ticks.
   */
  private readonly iconThrottle = new IconUpdateThrottle();

  override async onWillAppear(ev: IDeckWillAppearEvent<SessionInfoSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings) {
        this.updateDisplayFromTelemetry(ev.action.id, telemetry, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<SessionInfoSettings>): Promise<void> {
    this.cancelFlash(ev.action.id);
    this.cancelFlagPulse(ev.action.id);
    // Drop any coalesced push still pending so it can't fire for a context
    // that no longer exists.
    this.iconThrottle.clear(ev.action.id);
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
    this.lastIncidentCount.delete(ev.action.id);
    this.flashStates.delete(ev.action.id);
    this.lastFlagKey.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<SessionInfoSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.cancelFlash(ev.action.id);
    this.cancelFlagPulse(ev.action.id);
    this.lastIncidentCount.delete(ev.action.id);
    this.lastFlagKey.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
    await this.updateDisplay(ev, settings);
  }

  private parseSettings(settings: unknown): SessionInfoSettings {
    const parsed = SessionInfoSettings.safeParse(settings);

    return parsed.success ? parsed.data : SessionInfoSettings.parse({});
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<SessionInfoSettings> | IDeckDidReceiveSettingsEvent<SessionInfoSettings>,
    settings: SessionInfoSettings,
  ): Promise<void> {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const wind = this.resolveWind(settings, telemetry);
    const value = this.extractDisplayValue(settings, telemetry, wind);
    const isFlashing = this.flashStates.get(ev.action.id) ?? false;

    // Resolve flag colors for flags mode
    const colorOverride = this.resolveFlagColorOverride(settings, telemetry);

    const svgDataUri = generateSessionInfoSvg(
      settings,
      value,
      isFlashing,
      colorOverride,
      this.resolveModeState(settings, telemetry, value, wind),
    );
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    // Re-render against CURRENT settings and telemetry when the global icon
    // colors / title / border defaults change, rather than closing over the
    // SVG generated above (@.claude/rules/stream-deck-actions.md).
    this.setRegenerateCallback(ev.action.id, () => {
      const current = this.activeContexts.get(ev.action.id) ?? settings;

      return this.renderIcon(ev.action.id, current, this.sdkController.getCurrentTelemetry());
    });

    const stateKey = this.buildStateKey(settings, value, isFlashing, colorOverride?.background);
    this.lastState.set(ev.action.id, stateKey);

    // Initialize incident count baseline
    if (settings.mode === "incidents" && telemetry?.PlayerCarMyIncidentCount !== undefined) {
      this.lastIncidentCount.set(ev.action.id, telemetry.PlayerCarMyIncidentCount);
    }

    // Initialize flag baseline
    if (settings.mode === "flags") {
      const flagInfo = resolveActiveFlag(telemetry?.SessionFlags);
      this.lastFlagKey.set(ev.action.id, flagInfo?.label ?? "none");
    }
  }

  private extractDisplayValue(
    settings: SessionInfoSettings,
    telemetry: TelemetryData | null,
    wind?: WindDisplay | null,
  ): string {
    // Track wetness renders its label inside the graphic content. The label is still
    // returned here so the state-key cache busts on state transitions; generateSessionInfoSvg
    // clears the value text slot for this mode to avoid drawing it twice.
    if (settings.mode === "track-wetness") {
      return trackWetnessLabel(telemetry?.TrackWetness as TrackWetness | undefined);
    }

    // Estimated iRating change (#268, #872): "+31" / "-15" / "0" in race,
    // qualifying, and race pre-green; "--" whenever no estimate is possible
    // (practice/testing, no positions yet, player not in a scored field).
    if (settings.mode === "irating") {
      return this.extractIRatingValue(telemetry);
    }

    // Gaps mode (issue #933): the graphic carries the whole display; this
    // string only busts the state-key cache on a visible change (value or
    // trend per row). getLiveGaps() is null outside race sessions / before
    // green, so both rows fall back to the placeholder everywhere else.
    if (settings.mode === "gaps") {
      const gaps = getLiveGaps();
      const ahead = settings.gapShowAhead
        ? `${formatGapValue(gaps?.ahead ?? null)}:${gaps?.ahead?.trend ?? "-"}`
        : "off";
      const behind = settings.gapShowBehind
        ? `${formatGapValue(gaps?.behind ?? null)}:${gaps?.behind?.trend ?? "-"}`
        : "off";

      return `${ahead}|${behind}`;
    }

    // Wind mode (issue #947): the graphic carries the whole display, so this
    // string exists purely to bust the state-key cache. The model is resolved
    // once by the caller and passed in, so the key and the rendered arrow can
    // never disagree. The arrow angle is already quantized, which is what
    // keeps a car turning through a corner from busting the key every tick.
    if (settings.mode === "wind") {
      return wind ? `${wind.arrowDeg ?? "calm"}|${wind.label}` : WIND_PLACEHOLDER;
    }

    if (!telemetry) {
      if (settings.mode === "incidents") return "--";

      if (settings.mode === "laps") return "-/-";

      if (settings.mode === "position") return settings.positionShowTotal ? "P-/-" : "P-";

      if (settings.mode === "fuel") {
        if (settings.fuelSubMode !== "now") return "--";

        return settings.fuelFormat === "percentage" ? "--%" : "-- L";
      }

      if (settings.mode === "laps-to-empty") return "--";

      if (settings.mode === "flags") return settings.blankWhenNoFlag ? "" : "--";

      return "--:--";
    }

    if (settings.mode === "incidents") {
      const count = telemetry.PlayerCarMyIncidentCount;

      return count !== undefined ? `${count}x` : "--";
    }

    if (settings.mode === "laps") {
      const lap = telemetry.Lap;
      const total = telemetry.SessionLapsTotal;

      if (lap === undefined || total === undefined) return "-/-";

      if (total >= UNLIMITED_LAPS) return `${lap}/\u221E`;

      return `${lap}/${total}`;
    }

    if (settings.mode === "position") {
      const isClass = settings.positionType === "class";

      // Class position is always iRacing's authoritative `PlayerCarClassPosition`
      // (the source the Race Engineer trusts — iRacing recomputes it correctly when
      // cars retire). Overall position uses the class-aware live resolver
      // `getLivePosition()` while racing on track (its `.position` is the frozen
      // calculated order), and official telemetry in pits / non-race where the
      // calculated lap-order isn't the standings.
      let overall: number | undefined;
      let klass: number | undefined;

      // Until the player is actually racing, show the qualifying GRID slot
      // (issue #647). This spans pre-green (`isPreGreen`) AND the green-flag run
      // to the line: from the green until the player crosses start/finish to
      // begin lap 1, the live calculated order churns (the field is bunched and
      // cars cross S/F one-by-one, so the `lapCompleted >= 0` ranking is
      // computed over an incomplete, shuffling subset) and iRacing's
      // live-standings `PlayerCarPosition` reads 0 on a rolling start. The
      // player has begun racing once `LapCompleted` flips from the -1 out-lap
      // sentinel to >= 0. A missing `LapCompleted` (undefined) is treated as
      // "already racing" so non-start callers keep the live order (back-compat).
      const beforeRacingLap = typeof telemetry.LapCompleted === "number" && telemetry.LapCompleted < 0;

      if (this.isRaceSession(telemetry)) {
        if (isPreGreen(telemetry) || beforeRacingLap) {
          // Qualifying grid slot from the session/qualifying results — populated
          // the moment the grid is set, for both standing and rolling starts.
          // Fall back to live-standings telemetry only when it can't be resolved
          // (e.g. no qualifying results).
          const grid = getStartingGridPosition();

          if (grid) {
            overall = grid.overall;
            klass = grid.class;
          } else {
            overall = telemetry.PlayerCarPosition;
            klass = telemetry.PlayerCarClassPosition;
          }
        } else if (telemetry.OnPitRoad) {
          overall = telemetry.PlayerCarPosition;
          klass = telemetry.PlayerCarClassPosition;
        } else {
          const live = getLivePosition();

          overall = live && live.position > 0 ? live.position : telemetry.PlayerCarPosition;
          klass = live && live.classPosition > 0 ? live.classPosition : telemetry.PlayerCarClassPosition;
        }
      } else {
        overall = telemetry.PlayerCarPosition;
        klass = telemetry.PlayerCarClassPosition;
      }

      const pos = isClass ? klass : overall;

      if (pos === undefined) return settings.positionShowTotal ? "P-/-" : "P-";

      if (settings.positionShowTotal) {
        const totalCars = isClass ? this.countCarsInPlayerClass() : this.countActiveCars();

        return totalCars > 0 ? `P${pos}/${totalCars}` : `P${pos}`;
      }

      return `P${pos}`;
    }

    if (settings.mode === "fuel") {
      // Consumption sub-modes (issue #465) read the translator's validated
      // fuel lap history. Only VALID laps ever surface here, so an invalid
      // latest lap (pit stop, tow) keeps showing the last valid value instead
      // of flickering to "--" mid-stint. The percentage format only applies to
      // the tank-level "now" display — consumption is always an amount.
      if (settings.fuelSubMode === "lastLap" || settings.fuelSubMode === "avgN") {
        const stats = getFuelStats(settings.fuelLapWindow);
        const value = settings.fuelSubMode === "lastLap" ? stats.lastLap : stats.avg;

        if (value === null) return "--";

        return formatFuelAmount(value, telemetry.DisplayUnits, 2);
      }

      if (settings.fuelFormat === "percentage") {
        const pct = telemetry.FuelLevelPct;

        if (pct === undefined) return "--%";

        return `${Math.round(pct * 100)}%`;
      }

      const level = telemetry.FuelLevel;

      if (level === undefined) return "-- L";

      return formatFuelAmount(level, telemetry.DisplayUnits);
    }

    // Laps to empty (issue #748): live tank level ÷ the same validated mean
    // the avgN sub-mode displays, so the two keys always agree. Deliberately
    // NOT the conservative max-of-recent-laps the fuel warning thresholds use
    // — a pessimistic variant would be a setting, never a silent difference.
    // Both operands are liters, so the ratio needs no DisplayUnits handling.
    if (settings.mode === "laps-to-empty") {
      const stats = getFuelStats(settings.fuelLapWindow);
      const level = telemetry.FuelLevel;

      if (stats.avg === null || level === undefined) return "--";

      return (level / stats.avg).toFixed(2);
    }

    if (settings.mode === "flags") {
      const flagInfo = resolveActiveFlag(telemetry.SessionFlags);

      if (flagInfo) return flagInfo.label;

      return settings.blankWhenNoFlag ? "" : "--";
    }

    // time-remaining (default)
    const remain = telemetry.SessionTimeRemain;

    if (remain === undefined) return "--:--";

    if (remain >= UNLIMITED_TIME_THRESHOLD) return "UNLIM";

    return formatSessionTime(remain);
  }

  private extractIRatingValue(telemetry: TelemetryData | null): string {
    if (!telemetry) return IRATING_NO_ESTIMATE;

    const sessionInfo = this.sdkController.getSessionInfo();
    const driverInfo = sessionInfo?.DriverInfo as { Drivers?: IRatingFieldDriver[]; DriverCarIdx?: number } | undefined;
    const drivers = driverInfo?.Drivers;
    const playerCarIdx = driverInfo?.DriverCarIdx;

    if (!Array.isArray(drivers) || playerCarIdx === undefined) return IRATING_NO_ESTIMATE;

    // As-if-finishing order (#872): the canonical live order in a running race
    // (race-positions rule — the same source the template context's
    // irating_change consumes, so key and placeholders always agree), the
    // official standings in qualifying / race pre-green, and the session-YAML
    // qualifying grid before those populate — anchored on the player so the
    // pre-green source holds through the green-flag run to the line.
    // Practice/testing yield no order.
    const order = resolveIRatingEstimateOrder({
      sessionType: this.getSessionType(telemetry, sessionInfo),
      liveOrder: getLiveRacePositions(),
      officialPositions: telemetry.CarIdxPosition as number[] | undefined,
      qualifyResults: extractQualifyResults(sessionInfo),
      playerCarIdx,
    });

    if (!order) return IRATING_NO_ESTIMATE;

    const estimates = estimateIRatingChanges({
      drivers,
      order,
      carIdxClass: telemetry.CarIdxClass as number[] | undefined,
    });
    const change = estimates.changes[playerCarIdx];

    if (change == null) return IRATING_NO_ESTIMATE;

    const rounded = Math.round(change);

    return rounded > 0 ? `+${rounded}` : String(rounded);
  }

  private countActiveCars(): number {
    return countActiveDrivers(this.sdkController.getSessionInfo());
  }

  private countCarsInPlayerClass(): number {
    return countActiveDriversInPlayerClass(this.sdkController.getSessionInfo());
  }

  private getSessionType(
    telemetry: TelemetryData | null,
    sessionInfo: IRacingSessionInfo | null = this.sdkController.getSessionInfo(),
  ): string | undefined {
    if (!sessionInfo) return undefined;

    const sessions = (sessionInfo as Record<string, unknown>).SessionInfo as Record<string, unknown> | undefined;
    const sessionList = sessions?.Sessions as Array<Record<string, unknown>> | undefined;
    const sessionNum = telemetry?.SessionNum ?? 0;
    const currentSession = sessionList?.[sessionNum as number];

    return currentSession?.SessionType as string | undefined;
  }

  private isRaceSession(telemetry: TelemetryData | null): boolean {
    return this.getSessionType(telemetry) === "Race";
  }

  private resolveFlagColorOverride(
    settings: SessionInfoSettings,
    telemetry: TelemetryData | null,
  ): { background: string; text: string } | undefined {
    if (settings.mode !== "flags") return undefined;

    const flagInfo = resolveActiveFlag(telemetry?.SessionFlags);

    if (!flagInfo) return undefined;

    return { background: flagInfo.color, text: flagInfo.textColor };
  }

  private buildStateKey(
    settings: SessionInfoSettings,
    value: string,
    isFlashing: boolean,
    bgOverride?: string,
  ): string {
    const bo = settings.borderOverrides;
    const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;

    return `${settings.mode}|${value}|${isFlashing}|${bgOverride || ""}|${borderKey}`;
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: SessionInfoSettings,
  ): Promise<void> {
    // Check for incident increase to trigger flash
    if (settings.mode === "incidents" && telemetry?.PlayerCarMyIncidentCount !== undefined) {
      const prevCount = this.lastIncidentCount.get(contextId);
      const currentCount = telemetry.PlayerCarMyIncidentCount;

      if (prevCount !== undefined && currentCount > prevCount) {
        this.logger.info("Incident count increased");
        this.logger.debug(`Incidents: ${prevCount} -> ${currentCount}`);
        this.startFlash(contextId, settings, telemetry);
      }

      this.lastIncidentCount.set(contextId, currentCount);
    }

    // Check for flag changes
    if (settings.mode === "flags") {
      const flagInfo = resolveActiveFlag(telemetry?.SessionFlags);
      const flagKey = flagInfo?.label ?? "none";
      const lastKey = this.lastFlagKey.get(contextId);

      if (flagKey !== lastKey) {
        this.logger.info("Flag changed");
        this.logger.debug(
          `Flag: ${lastKey} -> ${flagKey}, SessionFlags=0x${telemetry?.SessionFlags?.toString(16) ?? "undefined"}`,
        );
        this.lastFlagKey.set(contextId, flagKey);
        this.cancelFlagPulse(contextId);
        this.cancelFlash(contextId);

        if (flagInfo?.pulse) {
          this.startFlagPulse(contextId, settings, flagInfo);

          return;
        } else if (lastKey !== undefined && flagInfo) {
          this.startFlagColorFlash(contextId, settings, flagInfo);

          return;
        }
      }

      // If pulse or flash is active, let the timer handle rendering
      if (this.flagPulseTimers.has(contextId) || this.flashTimers.has(contextId)) return;
    }

    const wind = this.resolveWind(settings, telemetry);
    const value = this.extractDisplayValue(settings, telemetry, wind);
    const isFlashing = this.flashStates.get(contextId) ?? false;
    const colorOverride = this.resolveFlagColorOverride(settings, telemetry);
    const stateKey = this.buildStateKey(settings, value, isFlashing, colorOverride?.background);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generateSessionInfoSvg(
        settings,
        value,
        isFlashing,
        colorOverride,
        this.resolveModeState(settings, telemetry, value, wind),
      );

      // Telemetry arrives at the sim's tick rate, and a continuously-varying
      // display (the wind arrow through a corner, a moving gap) can change on
      // most of those ticks. Rasterizing and pushing an image that often is
      // wasted work that also churns the shared rasterizer cache, so coalesce
      // to the same 10 Hz ceiling the rest of the plugin renders at. Leading
      // edge fires immediately, so a one-off change is never delayed.
      this.iconThrottle.schedule(contextId, async () => {
        await this.updateKeyImage(contextId, svgDataUri);
      });
    }
  }

  /**
   * Collects the mode-specific extras the icon needs beyond the value string.
   * Centralizing this keeps the two render paths (settings-driven and
   * telemetry-driven) from drifting apart as modes are added.
   */
  private resolveModeState(
    settings: SessionInfoSettings,
    telemetry: TelemetryData | null,
    value: string,
    wind: WindDisplay | null | undefined,
  ): SessionInfoModeState {
    return {
      trackWetness: telemetry?.TrackWetness as TrackWetness | undefined,
      valueColor: settings.mode === "irating" ? iratingValueColor(value) : undefined,
      gaps: settings.mode === "gaps" ? getLiveGaps() : undefined,
      wind,
    };
  }

  /**
   * Resolves the wind model once per render pass. Both the state key and the
   * rendered graphic derive from this single value, so a change to the
   * quantization or unit handling can't make the cache and the icon disagree.
   */
  private resolveWind(settings: SessionInfoSettings, telemetry: TelemetryData | null): WindDisplay | null | undefined {
    return settings.mode === "wind" ? resolveWindDisplay(settings, telemetry) : undefined;
  }

  /**
   * Renders the icon for the given settings/telemetry, resolving the value,
   * flag colors and mode state the same way on every path.
   */
  private renderIcon(contextId: string, settings: SessionInfoSettings, telemetry: TelemetryData | null): string {
    const wind = this.resolveWind(settings, telemetry);
    const value = this.extractDisplayValue(settings, telemetry, wind);

    return generateSessionInfoSvg(
      settings,
      value,
      this.flashStates.get(contextId) ?? false,
      this.resolveFlagColorOverride(settings, telemetry),
      this.resolveModeState(settings, telemetry, value, wind),
    );
  }

  private startFlash(contextId: string, settings: SessionInfoSettings, telemetry: TelemetryData | null): void {
    this.cancelFlash(contextId);

    let step = 0;

    const doStep = () => {
      if (!this.activeContexts.has(contextId)) return;

      const isRed = step % 2 === 0;
      this.flashStates.set(contextId, isRed);

      const value = this.extractDisplayValue(settings, telemetry);
      const stateKey = this.buildStateKey(settings, value, isRed);
      this.lastState.set(contextId, stateKey);

      const svgDataUri = generateSessionInfoSvg(settings, value, isRed);
      this.updateKeyImage(contextId, svgDataUri);

      step++;

      if (step < FLASH_STEPS) {
        this.flashTimers.set(contextId, setTimeout(doStep, FLASH_INTERVAL_MS));
      } else {
        // Flash sequence complete — reset to normal
        this.flashStates.set(contextId, false);
        this.flashTimers.delete(contextId);

        const finalValue = this.extractDisplayValue(settings, telemetry);
        const finalStateKey = this.buildStateKey(settings, finalValue, false);
        this.lastState.set(contextId, finalStateKey);

        const finalSvg = generateSessionInfoSvg(settings, finalValue, false);
        this.updateKeyImage(contextId, finalSvg);
      }
    };

    doStep();
  }

  private startFlagColorFlash(contextId: string, settings: SessionInfoSettings, flagInfo: FlagInfo): void {
    this.cancelFlash(contextId);

    let step = 0;

    const doStep = () => {
      if (!this.activeContexts.has(contextId)) return;

      const showFlagColor = step % 2 === 0;
      this.flashStates.set(contextId, showFlagColor);

      const telemetry = this.sdkController.getCurrentTelemetry();
      const value = this.extractDisplayValue(settings, telemetry);
      const colorOverride = showFlagColor ? { background: flagInfo.color, text: flagInfo.textColor } : undefined;
      const stateKey = this.buildStateKey(settings, value, showFlagColor, colorOverride?.background);
      this.lastState.set(contextId, stateKey);

      const svgDataUri = generateSessionInfoSvg(settings, value, showFlagColor, colorOverride);
      this.updateKeyImage(contextId, svgDataUri);

      step++;

      if (step < FLASH_STEPS) {
        this.flashTimers.set(contextId, setTimeout(doStep, FLASH_INTERVAL_MS));
      } else {
        // Flash complete — settle on flag color
        this.flashStates.set(contextId, false);
        this.flashTimers.delete(contextId);

        const finalTelemetry = this.sdkController.getCurrentTelemetry();
        const finalValue = this.extractDisplayValue(settings, finalTelemetry);
        const finalOverride = { background: flagInfo.color, text: flagInfo.textColor };
        const finalStateKey = this.buildStateKey(settings, finalValue, false, finalOverride.background);
        this.lastState.set(contextId, finalStateKey);

        const finalSvg = generateSessionInfoSvg(settings, finalValue, false, finalOverride);
        this.updateKeyImage(contextId, finalSvg);
      }
    };

    doStep();
  }

  private startFlagPulse(contextId: string, settings: SessionInfoSettings, flagInfo: FlagInfo): void {
    this.cancelFlagPulse(contextId);

    // Show flag color immediately
    const telemetry = this.sdkController.getCurrentTelemetry();
    const value = this.extractDisplayValue(settings, telemetry);
    const colorOverride = { background: flagInfo.color, text: flagInfo.textColor };
    const stateKey = this.buildStateKey(settings, value, true, colorOverride.background);
    this.lastState.set(contextId, stateKey);
    const svgDataUri = generateSessionInfoSvg(settings, value, false, colorOverride);
    this.updateKeyImage(contextId, svgDataUri);

    let pulseOn = true;

    const timer = setInterval(() => {
      if (!this.activeContexts.has(contextId)) {
        this.cancelFlagPulse(contextId);

        return;
      }

      pulseOn = !pulseOn;

      const currentTelemetry = this.sdkController.getCurrentTelemetry();
      const currentValue = this.extractDisplayValue(settings, currentTelemetry);
      const override = pulseOn ? { background: flagInfo.color, text: flagInfo.textColor } : undefined;
      const key = this.buildStateKey(settings, currentValue, pulseOn, override?.background);
      this.lastState.set(contextId, key);

      const svg = generateSessionInfoSvg(settings, currentValue, pulseOn, override);
      this.updateKeyImage(contextId, svg);
    }, PULSE_INTERVAL_MS);

    this.flagPulseTimers.set(contextId, timer);
  }

  private cancelFlash(contextId: string): void {
    const timer = this.flashTimers.get(contextId);

    if (timer) {
      clearTimeout(timer);
      this.flashTimers.delete(contextId);
    }

    this.flashStates.set(contextId, false);
  }

  private cancelFlagPulse(contextId: string): void {
    const timer = this.flagPulseTimers.get(contextId);

    if (timer) {
      clearInterval(timer);
      this.flagPulseTimers.delete(contextId);
    }
  }
}
