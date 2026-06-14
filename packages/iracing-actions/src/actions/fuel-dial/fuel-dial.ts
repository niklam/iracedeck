import {
  CommonSettings,
  ConnectionStateAwareAction,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  fuelFromDisplayUnits,
  fuelToDisplayUnits,
  generateBorderParts,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalTitleSettings,
  type IDeckActionContext,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckTouchTapEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  isMetricUnits,
  renderIconTemplate,
  resolveBorderSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import { DisplayUnits, hasFlag, PitSvFlags, type SessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import fuelDialTemplate from "../../../icons/fuel-dial.svg";

/** Action triggered by a press / dial button / touch tap. */
type PressAction = "toggle-fueling" | "clear-fueling" | "fill-to-max";

/**
 * Trailing-throttle window for coalescing rapid rotations into a single
 * `pit.fuel()` broadcast + touch-strip update. The first change fires
 * promptly (leading edge); subsequent changes within the window are coalesced
 * and the latest value is flushed at the trailing edge.
 */
const THROTTLE_WINDOW_MS = 100;

/**
 * How long (ms) a dial/touch press must be held to count as a long press
 * rather than a short press. Only consulted when `__FEATURE_DIAL_LONG_PRESS__`
 * is enabled (Elgato).
 */
const LONG_PRESS_THRESHOLD_MS = 500;

/**
 * How long (ms) after a user rotation we keep ignoring telemetry re-seeds, so
 * a live update can't fight an in-flight adjustment.
 */
const USER_ACTIVITY_GRACE_MS = 3000;

/**
 * Cadence (ms) for the fill-to top-up recompute. While fuel-fill is ON in
 * fill-to mode the request is periodically recomputed from the current
 * fuel level and re-sent so the requested add stays topped up as fuel burns.
 */
const TARGET_RECOMPUTE_MS = 30000;

/**
 * Cadence (ms) for the periodic display refresh. While the action is appeared,
 * the bar + value are re-rendered on this interval to track live fuel burn
 * without pushing `setFeedback` on every telemetry tick (which would blow past
 * the documented ≤10 setFeedback/sec/dial cap). Event-driven renders (rotate,
 * press, settings, appear) still fire immediately.
 */
const DISPLAY_REFRESH_MS = 5000;

/**
 * Minimum gap (ms) between change-driven feedback pushes. The bar/value re-render
 * the moment the DISPLAYED state changes (fuel-fill flips, or a rounded value
 * moves) rather than waiting for the 5 s heartbeat — but no more than once per
 * this window so a burst of telemetry can't exceed the ≤10 setFeedback/sec/dial
 * cap (issue #681).
 */
const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

/**
 * Dialed value set when toggling Fill to Max off. In add-amount mode this IS the
 * add, so 1 L sends `pit.fuel(1)` (a real 1 L add). In fill-to mode it is the
 * target; with current fuel above 1 L the resolved add is 0, which `sendFuel`
 * maps to `pit.clearFuel()` (the SDK treats `pit.fuel(0)` as "keep existing", so a
 * 0 add must clear instead). Either way Fill to Max "empty" means ~no fuel added
 * (issue #681).
 */
const FILL_TO_MAX_MIN_LTR = 1;

/**
 * Fixed safety buffer (liters) added to a non-zero fill-to add so the stop
 * finishes AT LEAST the target. The fill-to request is recomputed and re-sent
 * on the 30 s top-up cadence, but the car keeps burning fuel between that live
 * recompute and the moment you actually pit — without the buffer the request can
 * leave you ~1 L short on arrival. The buffer is clamped to the remaining tank
 * space, so it's naturally dropped when the target is the full tank (issue #681).
 */
const FUEL_TARGET_BUFFER_LTR = 1;

const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const GRAY = "#888888";
/** Neutral color for the static "current fuel" segment of the two-segment bar. */
const CURRENT_SEGMENT = "#9aa7b4";
/** Dark track behind both bar segments. */
const BAR_TRACK = "#1a1f26";
/** Color of the on-bar "current" amount label (dark, sits over the light current segment). */
const BAR_LABEL = "#0d1117";
/** Color of the on-bar "+add" amount label (white, sits over the green/gray add segment). */
const ADD_LABEL = "#ffffff";
/** Color of the "fill-to" target marker line (red, confined to the bar height). */
const TARGET_LINE = "#e74c3c";

const FuelDialSettings = CommonSettings.extend({
  dialMode: z.enum(["add-amount", "fill-to"]).default("add-amount"),
  stepSize: z.preprocess(
    (val) => (typeof val === "string" ? val.replace(",", ".") : val),
    z.coerce.number().min(0.1).max(50).default(1),
  ),
  pressAction: z.enum(["toggle-fueling", "clear-fueling", "fill-to-max"]).default("toggle-fueling"),
  longPressAction: z.enum(["clear-fueling", "fill-to-max", "toggle-fueling", "none"]).default("clear-fueling"),
  touchAction: z.enum(["toggle-fueling", "clear-fueling", "fill-to-max", "none"]).default("toggle-fueling"),
  unitMode: z.enum(["auto", "liters", "gallons"]).default("auto"),
});

type FuelDialSettings = z.infer<typeof FuelDialSettings>;

/** Pending throttle state for one context. */
interface ThrottleState {
  /** Timer for the trailing flush, or null when idle. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Latest add target (liters) requested during the current window. */
  pendingLtr: number | null;
  /** Last liters value actually broadcast (suppresses no-op repeats). */
  lastSentLtr: number | null;
}

/** Per-context runtime state. */
interface FuelDialContext {
  settings: FuelDialSettings;
  action: IDeckActionContext;
  /**
   * Dialed quantity, always in LITERS. In add-amount mode this is the amount to
   * ADD; in fill-to mode this is the desired TOTAL after the stop.
   */
  dialValueLtr: number;
  /** Timestamp (ms) of the last user rotation; guards telemetry re-seed. */
  lastUserActivity: number;
  /** Long-press timer (Elgato), or null. */
  longPressTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the long-press timer already fired for the current press. */
  longPressFired: boolean;
  /** Timestamp (ms) the current press started (dial down). */
  pressStart: number;
  /** Recurring fill-to top-up timer, or null when inactive. */
  targetTimer: ReturnType<typeof setInterval> | null;
  /** Recurring display-refresh timer (re-renders bar + value), or null. */
  displayTimer: ReturnType<typeof setInterval> | null;
  /**
   * Signature of the DISPLAYED state at the last change-driven feedback push.
   * Compared on every telemetry tick so a render fires the moment the displayed
   * fuel-fill color or a rounded value moves, not just on the 5 s heartbeat.
   */
  lastRenderSig: string | null;
  /** Timestamp (ms) of the last change-driven feedback push (throttle gate). */
  lastChangeRenderAt: number;
  throttle: ThrottleState;
}

/**
 * @internal Exported for testing
 *
 * Resolves the effective iRacing DisplayUnits value for the chosen unit mode.
 * `auto` defers to telemetry; explicit modes force metric/english.
 */
export function resolveDisplayUnits(
  unitMode: FuelDialSettings["unitMode"],
  telemetryUnits: number | undefined,
): number {
  if (unitMode === "liters") return DisplayUnits.Metric;

  if (unitMode === "gallons") return DisplayUnits.English;

  // auto: follow telemetry; default to metric when unknown
  return telemetryUnits === undefined ? DisplayUnits.Metric : telemetryUnits;
}

/**
 * @internal Exported for testing
 *
 * Short unit suffix for the touch-strip / icon readout ("L" or "gal").
 */
export function unitSuffix(displayUnits: number): string {
  return isMetricUnits(displayUnits) ? "L" : "gal";
}

/**
 * @internal Exported for testing
 *
 * Reads the effective fuel tank capacity (liters) from session info:
 * `DriverCarFuelMaxLtr × (DriverCarMaxFuelPct ?? 1)`. Returns undefined when
 * the capacity is unknown so callers can avoid clamping the upper bound.
 */
export function readEffectiveMaxLtr(sessionInfo: SessionInfo | null): number | undefined {
  const driverInfo = (sessionInfo as Record<string, unknown> | null)?.DriverInfo as Record<string, unknown> | undefined;

  if (!driverInfo) return undefined;

  const maxLtr = driverInfo.DriverCarFuelMaxLtr;

  if (typeof maxLtr !== "number" || !Number.isFinite(maxLtr) || maxLtr <= 0) return undefined;

  const pctRaw = driverInfo.DriverCarMaxFuelPct;
  const pct = typeof pctRaw === "number" && Number.isFinite(pctRaw) && pctRaw > 0 ? pctRaw : 1;

  return maxLtr * pct;
}

/**
 * @internal Exported for testing
 *
 * Clamps a value (liters) to [0, maxLtr]. When the max is unknown only the
 * lower bound is enforced.
 */
export function clampTargetLtr(targetLtr: number, maxLtr: number | undefined): number {
  const lower = Math.max(0, targetLtr);

  if (maxLtr === undefined) return lower;

  return Math.min(lower, maxLtr);
}

/**
 * @internal Exported for testing
 *
 * Formats a liters amount in display units, dropping the decimal for whole
 * numbers (e.g. "74" / "12.5").
 */
export function formatDisplayValue(liters: number, displayUnits: number): string {
  const value = fuelToDisplayUnits(liters, displayUnits);
  const rounded = Math.round(value * 10) / 10;

  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * @internal Exported for testing
 *
 * Builds the per-mode value text shown on the touch strip and keypad icon.
 *
 * - add-amount: `"+<add> = <total> <unit>"` (e.g. `"+20 = 65 L"`). The total is
 *   `min(current + add, capacity)` and reflects live fuel burn.
 * - fill-to: `"→ <target> <unit>"` (e.g. `"→ 65 L"`). The target is shown
 *   even when capacity is unknown.
 */
export function buildValueText(
  dialMode: FuelDialSettings["dialMode"],
  addLtr: number,
  totalLtr: number,
  targetLtr: number,
  displayUnits: number,
): string {
  const suffix = unitSuffix(displayUnits);

  if (dialMode === "fill-to") {
    return `→ ${formatDisplayValue(targetLtr, displayUnits)} ${suffix}`;
  }

  return `+${formatDisplayValue(addLtr, displayUnits)} = ${formatDisplayValue(totalLtr, displayUnits)} ${suffix}`;
}

/**
 * @internal Exported for testing
 *
 * The mode-aware title shown on the touch strip and keypad icon:
 * `"Add Fuel"` in add-amount mode, `"Fuel Target"` in fill-to mode.
 */
export function buildTitleText(dialMode: FuelDialSettings["dialMode"]): string {
  return dialMode === "fill-to" ? "Fuel Target" : "Add Fuel";
}

/**
 * @internal Exported for testing
 *
 * Reads `FuelLevel` (current fuel in tank, liters) from telemetry. Unknown
 * values are treated as 0 so the bar/readout never break.
 */
export function readFuelLevel(telemetry: TelemetryData | null): number {
  if (!telemetry) return 0;

  const value = (telemetry as Record<string, unknown>).FuelLevel;

  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * @internal Exported for testing
 *
 * Reads `PitSvFuel` (the requested pit fuel add, liters) from telemetry, or
 * undefined when unavailable.
 */
export function readPitSvFuel(telemetry: TelemetryData | null): number | undefined {
  if (!telemetry) return undefined;

  const value = (telemetry as Record<string, unknown>).PitSvFuel;

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * @internal Exported for testing
 *
 * Whether the iRacing pit fuel-fill checkbox is currently ON, derived from the
 * live `PitSvFlags` bitfield. This is the single source of truth for "fueling
 * on/off" — never a sticky local flag.
 */
export function isFuelFillOn(telemetry: TelemetryData | null): boolean {
  if (!telemetry || (telemetry as Record<string, unknown>).PitSvFlags === undefined) return false;

  return hasFlag((telemetry as Record<string, unknown>).PitSvFlags as number, PitSvFlags.FuelFill);
}

/**
 * @internal Exported for testing
 *
 * Rounds a liters amount so it lands on a whole integer in DISPLAY units, then
 * converts back to liters. Used in fill-to mode so the dialed target is
 * always a whole displayed value (e.g. an integer number of liters/gallons).
 */
export function roundToWholeDisplayLtr(liters: number, displayUnits: number): number {
  const display = Math.round(fuelToDisplayUnits(liters, displayUnits));

  return fuelFromDisplayUnits(display, displayUnits);
}

/**
 * @internal Exported for testing
 *
 * Computes the effective liters to ADD for the next stop from the dialed value,
 * the current fuel level, and the tank capacity.
 *
 * - add-amount: `dialValueLtr` is the requested amount to add. The add is FIXED
 *   — it does not change as fuel burns. iRacing clamps at the pump, so here we
 *   only enforce the lower bound (and the upper tank capacity, since the dial
 *   already spans the full tank range `[0, capacity]`).
 * - fill-to: `dialValueLtr` is the desired TOTAL after the stop (kept a
 *   whole integer display value). The add is `max(0, target − current)`, rounded
 *   UP to the next whole DISPLAY unit so the stop never finishes below the
 *   (integer) target. When that rounded add is non-zero a fixed
 *   `FUEL_TARGET_BUFFER_LTR` is added to cover fuel burned between the live 30 s
 *   recompute and the actual pit stop, so you finish AT LEAST the target. The
 *   result is then clamped to the remaining tank space so it never over-fills
 *   (the buffer is naturally dropped when the target is the full tank). When the
 *   need is ≤ 0 (target at/below current) the add stays 0 — no buffer — so the
 *   "0 → clearFuel" path still fires.
 */
export function computeAddLtr(
  dialMode: FuelDialSettings["dialMode"],
  dialValueLtr: number,
  currentLtr: number,
  maxLtr: number | undefined,
  displayUnits: number,
): number {
  if (dialMode === "fill-to") {
    const headroom = maxLtr === undefined ? undefined : Math.max(0, maxLtr - currentLtr);
    const rawAdd = Math.max(0, dialValueLtr - currentLtr);
    // Round the ADD up to the next whole display unit so current + add is at or
    // just above the integer target — a stop never finishes under target.
    const addDisplay = Math.ceil(fuelToDisplayUnits(rawAdd, displayUnits));
    const roundedAddLtr = fuelFromDisplayUnits(addDisplay, displayUnits);
    // Apply the safety buffer only to a real (non-zero) add so a target at/below
    // current still resolves to 0 (→ clearFuel). The clamp drops the buffer when
    // the target is the full tank.
    const addLtr = roundedAddLtr > 0 ? roundedAddLtr + FUEL_TARGET_BUFFER_LTR : 0;

    return clampTargetLtr(addLtr, headroom);
  }

  // add-amount: the dial spans the FULL tank range; clamp to [0, capacity].
  return clampTargetLtr(dialValueLtr, maxLtr);
}

/**
 * @internal Exported for testing
 *
 * The total fuel (liters) in the tank after the stop completes, capped at the
 * tank capacity when known.
 */
export function computeTotalLtr(currentLtr: number, addLtr: number, maxLtr: number | undefined): number {
  const total = currentLtr + addLtr;

  return maxLtr === undefined ? total : Math.min(total, maxLtr);
}

/**
 * @internal Exported for testing
 *
 * Builds an SVG `<path>` `d` for a horizontal bar segment with INDEPENDENTLY
 * rounded left/right ends. The left end rounds its top-left + bottom-left
 * corners; the right end rounds its top-right + bottom-right corners. A square
 * end is drawn flush. This lets two butted segments share a square boundary
 * while keeping the outer ends rounded — without `clipPath` (unsupported on
 * Mirabox QT5), using only arcs/paths from the safe SVG Tiny 1.2 set.
 */
export function roundedBarPath(
  x: number,
  width: number,
  height: number,
  roundLeft: boolean,
  roundRight: boolean,
  radius: number,
): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const left = x;
  const right = x + width;
  const top = 0;
  const bottom = height;
  const rl = roundLeft ? r : 0;
  const rr = roundRight ? r : 0;

  // Clockwise from the top-left (after its arc).
  return [
    `M ${(left + rl).toFixed(2)} ${top}`,
    `L ${(right - rr).toFixed(2)} ${top}`,
    rr ? `A ${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${right.toFixed(2)} ${(top + rr).toFixed(2)}` : "",
    `L ${right.toFixed(2)} ${(bottom - rr).toFixed(2)}`,
    rr ? `A ${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${(right - rr).toFixed(2)} ${bottom}` : "",
    `L ${(left + rl).toFixed(2)} ${bottom}`,
    rl ? `A ${rl.toFixed(2)} ${rl.toFixed(2)} 0 0 1 ${left.toFixed(2)} ${(bottom - rl).toFixed(2)}` : "",
    `L ${left.toFixed(2)} ${(top + rl).toFixed(2)}`,
    rl ? `A ${rl.toFixed(2)} ${rl.toFixed(2)} 0 0 1 ${(left + rl).toFixed(2)} ${top}` : "",
    "Z",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * @internal Exported for testing
 *
 * Renders ONE continuous two-segment fuel bar as a full SVG string (used as the
 * pixmap data source on the touch strip and inside the keypad icon).
 *
 * - A dark rounded track spans the full width.
 * - The CURRENT segment runs from the left (neutral gray-blue), the ADD segment
 *   is butted directly onto it: GREEN when fuel-fill is ON, GRAY when OFF.
 * - Only the OUTER corners round (left end of current, right end of add); the
 *   shared current↔add boundary is SQUARE. When add is 0 the current segment
 *   alone rounds both ends; when current is 0 the add segment alone rounds both.
 * - On-bar amount labels: current LEFT-aligned in dark over the light current
 *   segment; the to-be-added `+add` RIGHT-aligned at the add segment's right end
 *   in WHITE for contrast over the green/gray add fill. Each label is omitted
 *   when its segment is too narrow to hold it legibly (never drawn over the dark
 *   empty track).
 * - In fill-to mode a thin RED vertical marker line marks the target total
 *   (`targetLtr` set + capacity known); it spans the FULL bar height (y=0 to
 *   y=height) and is confined to the bar — no overhang past the top/bottom. The
 *   SVG viewBox is `0 0 width height` so the track + segments fill the full
 *   pixmap rect. Omitted in add-amount mode.
 */
export function renderFuelBarSvg(
  currentLtr: number,
  addLtr: number,
  maxLtr: number | undefined,
  fuelOn: boolean,
  widthPx: number,
  heightPx: number,
  displayUnits: number,
  targetLtr?: number,
): string {
  const radius = Math.min(heightPx / 2, 8);
  const span = maxLtr !== undefined && maxLtr > 0 ? maxLtr : Math.max(currentLtr + addLtr, 1);
  const currentW = Math.max(0, Math.min(widthPx, (currentLtr / span) * widthPx));
  const addW = Math.max(0, Math.min(widthPx - currentW, (addLtr / span) * widthPx));
  const addColor = fuelOn ? GREEN : GRAY;
  const fontSize = Math.max(8, Math.round(heightPx * 0.5));
  const labelY = heightPx / 2;
  const pad = Math.max(3, Math.round(heightPx * 0.18));

  const parts = [
    `<rect x="0" y="0" width="${widthPx}" height="${heightPx}" rx="${radius}" fill="${BAR_TRACK}"/>`,
  ];

  if (currentW > 0) {
    // Round the left end always; round the right end too only when there's no add.
    parts.push(
      `<path d="${roundedBarPath(0, currentW, heightPx, true, addW <= 0, radius)}" fill="${CURRENT_SEGMENT}"/>`,
    );
  }

  if (addW > 0) {
    // Round the right (leading) end always; round the left end too only when there's no current.
    parts.push(
      `<path d="${roundedBarPath(currentW, addW, heightPx, currentW <= 0, true, radius)}" fill="${addColor}"/>`,
    );
  }

  // Fill-to target marker line: red, ~2-3px wide, spanning the full bar height (confined to the bar).
  if (targetLtr !== undefined && maxLtr !== undefined && maxLtr > 0) {
    const targetX = Math.max(0, Math.min(widthPx, (targetLtr / span) * widthPx));
    const lineW = Math.max(2, Math.min(3, Math.round(heightPx * 0.1)));
    parts.push(
      `<rect x="${(targetX - lineW / 2).toFixed(2)}" y="0" width="${lineW}" height="${heightPx}" fill="${TARGET_LINE}"/>`,
    );
  }

  // Current label: dark, left-aligned, only when the current segment can hold it.
  const currentLabel = formatDisplayValue(currentLtr, displayUnits);
  const currentLabelW = currentLabel.length * fontSize * 0.6 + pad;

  if (currentW >= currentLabelW) {
    parts.push(
      `<text x="${pad}" y="${labelY}" text-anchor="start" dominant-baseline="central" fill="${BAR_LABEL}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${currentLabel}</text>`,
    );
  }

  // +add label: WHITE, right-aligned at the add segment's right end, only when
  // the add segment can hold it (so it never lands on the dark empty track).
  const addLabel = `+${formatDisplayValue(addLtr, displayUnits)}`;
  const addLabelW = addLabel.length * fontSize * 0.6 + pad;

  if (addW >= addLabelW) {
    const addRight = currentW + addW;
    parts.push(
      `<text x="${(addRight - pad).toFixed(2)}" y="${labelY}" text-anchor="end" dominant-baseline="central" fill="${ADD_LABEL}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${addLabel}</text>`,
    );
  }

  // The viewBox spans exactly the bar so the track + segments fill the full
  // pixmap rect; the target line is confined to y in [0, heightPx].
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthPx} ${heightPx}" width="${widthPx}" height="${heightPx}">${parts.join("")}</svg>`;
}

/**
 * @internal Exported for testing
 *
 * Generates the keypad icon (data URI) showing "FUEL", the per-mode value text,
 * and the continuous two-segment fuel bar.
 */
export function generateFuelDialSvg(
  settings: FuelDialSettings,
  currentLtr: number,
  addLtr: number,
  maxLtr: number | undefined,
  displayUnits: number,
  fuelOn: boolean,
  targetLtr: number,
): string {
  const colors = resolveIconColors(fuelDialTemplate, getGlobalColors(), settings.colorOverrides) as Record<
    string,
    string
  >;
  const graphic1 = colors.graphic1Color || WHITE;
  const totalLtr = computeTotalLtr(currentLtr, addLtr, maxLtr);
  const valueText = buildValueText(settings.dialMode, addLtr, totalLtr, targetLtr, displayUnits);
  // The target line is only drawn in fill-to mode.
  const barTarget = settings.dialMode === "fill-to" ? targetLtr : undefined;

  // Continuous two-segment fuel bar (current + add) with on-bar labels.
  const barX = 16;
  const barY = 100;
  const barW = 112;
  const barH = 28;
  // Add-mode text ("+20 = 65 L") is wider than fill-to text ("→ 65 L"); size it
  // down so the longer string fits the 144-wide canvas.
  const valueFontSize = settings.dialMode === "fill-to" ? 30 : 24;
  const barSvg = renderFuelBarSvg(currentLtr, addLtr, maxLtr, fuelOn, barW, barH, displayUnits, barTarget);
  const iconContent = `
    <text x="72" y="72" text-anchor="middle" dominant-baseline="central"
          fill="${graphic1}" font-family="Arial, sans-serif" font-size="${valueFontSize}" font-weight="bold">${valueText}</text>
    <g transform="translate(${barX}, ${barY})">${stripSvgWrapper(barSvg)}</g>`;

  // Mode-aware title ("Add Fuel" / "Fuel Target") replaces the static
  // "FUEL" label. The longer text is sized down so it fits the 144-wide canvas.
  const resolvedTitle = resolveTitleSettings(fuelDialTemplate, getGlobalTitleSettings(), settings.titleOverrides);
  const titleText = buildTitleText(settings.dialMode);
  const titleFontSize = 18;
  const titleContent = resolvedTitle.showTitle
    ? `<text x="72" y="26" text-anchor="middle" dominant-baseline="central" fill="${colors.textColor ?? WHITE}" font-family="Arial, sans-serif" font-size="${titleFontSize}" font-weight="bold">${titleText}</text>`
    : "";

  const border = resolveBorderSettings(fuelDialTemplate, getGlobalBorderSettings(), settings.borderOverrides);
  const borderSvg = generateBorderParts(border);

  const svg = renderIconTemplate(fuelDialTemplate, {
    iconContent: resolvedTitle.showGraphics ? iconContent : "",
    titleContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    ...colors,
  });

  return svgToDataUri(svg);
}

/** Strips the outer `<svg …>…</svg>` wrapper, returning only the inner markup. */
function stripSvgWrapper(svg: string): string {
  const open = svg.indexOf(">");
  const close = svg.lastIndexOf("</svg>");

  if (open === -1 || close === -1 || close <= open) return svg;

  return svg.slice(open + 1, close);
}

/** Human-readable label for a press/touch action (for trigger descriptions). */
function actionLabel(action: PressAction): string {
  switch (action) {
    case "toggle-fueling":
      return "Toggle fueling";
    case "clear-fueling":
      return "Clear fueling";
    case "fill-to-max":
      return "Fill to max";
  }
}

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current settings.
 *
 * The Elgato SDK fields describe specific gestures: `rotate` (dial rotation),
 * `push` (dial button press), `touch` (touchscreen tap), and `longTouch`
 * (touchscreen LONG tap). This action's long press is a hold of the physical
 * DIAL BUTTON, which has no dedicated SDK field — so it is appended to the
 * `push` label as a "(hold: …)" hint rather than mis-assigned to `longTouch`.
 */
export function buildTriggerDescription(settings: FuelDialSettings): DeckTriggerDescription {
  const push =
    settings.longPressAction === "none"
      ? actionLabel(settings.pressAction)
      : `${actionLabel(settings.pressAction)} (hold: ${actionLabel(settings.longPressAction)})`;

  const description: DeckTriggerDescription = {
    rotate: settings.dialMode === "fill-to" ? "Adjust target level" : "Adjust fuel to add",
    push,
  };

  if (settings.touchAction !== "none") {
    description.touch = actionLabel(settings.touchAction);
  }

  return description;
}

/**
 * Fuel Dial Action
 *
 * A dial-first action for Stream Deck+. Rotating sets either the amount to add
 * (add-amount mode) or the desired total after the stop (fill-to mode);
 * pressing/tapping runs a configurable action (toggle/clear/fill); the touch
 * strip shows a live "65 / 90 L" readout with a two-segment fuel bar. On a
 * plain keypad it shows the value and a press runs the configured action. All
 * communication uses the iRacing API (`pit.fuel` / `pit.clearFuel`).
 */
export const FUEL_DIAL_UUID = "com.iracedeck.sd.core.fuel-dial" as const;

export class FuelDial extends ConnectionStateAwareAction<FuelDialSettings> {
  private contextsState = new Map<string, FuelDialContext>();

  override async onWillAppear(ev: IDeckWillAppearEvent<FuelDialSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    // Seed the dialed value from current pit fuel request on appear.
    this.seedFromTelemetry(ctx, true);

    // Resume the fill-to top-up if fuel-fill is already on.
    this.syncTargetTimer(ctx);
    // Start the periodic display refresh so the bar + value track live burn.
    this.startDisplayTimer(ctx);
    await this.applyTriggerDescription(ctx);
    await this.render(ctx);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const current = this.contextsState.get(ev.action.id);

      if (current) {
        this.onTelemetry(current, telemetry);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<FuelDialSettings>): Promise<void> {
    const ctx = this.contextsState.get(ev.action.id);

    if (ctx) {
      this.clearTimers(ctx);
    }

    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.contextsState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<FuelDialSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;

    // A mode switch may start or stop the top-up timer.
    this.syncTargetTimer(ctx);
    await this.applyTriggerDescription(ctx);
    await this.render(ctx);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<FuelDialSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;

    const displayUnits = this.effectiveDisplayUnits(ctx);
    const stepLtr = fuelFromDisplayUnits(settings.stepSize, displayUnits);
    // Per-mode clamp: BOTH modes span the full tank range [0, capacity]. In
    // add-amount the dialed value is the (fixed) amount to add; in fill-to
    // it is the desired total, snapped to a whole integer display value on every
    // rotate. ticks is a SIGNED DELTA (may be >1).
    const upperBound = this.effectiveMaxLtr();
    let nextValue = ctx.dialValueLtr + ev.payload.ticks * stepLtr;

    if (settings.dialMode === "fill-to") {
      nextValue = roundToWholeDisplayLtr(nextValue, displayUnits);
    }

    ctx.dialValueLtr = clampTargetLtr(nextValue, upperBound);
    ctx.lastUserActivity = Date.now();
    this.logger.debug(
      `Dial=${ctx.dialValueLtr.toFixed(2)}L (${settings.dialMode}), ticks=${ev.payload.ticks}, step=${stepLtr.toFixed(2)}L`,
    );

    // Rotating issues pit.fuel (auto-arm). The touch-strip feedback (and the
    // pit.fuel broadcast) are throttled via the send window so a continuous spin
    // can't exceed the ≤10 setFeedback/sec/dial cap. Render only the keypad icon
    // per-event here; flushSend issues the broadcast + feedback at the edges.
    this.scheduleSend(ctx);

    // Keep the fill-to top-up timer running while fuel-fill is on.
    this.syncTargetTimer(ctx);
    await this.render(ctx, { skipFeedback: true });
  }

  override async onDialDown(ev: IDeckDialDownEvent<FuelDialSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;

    if (!__FEATURE_DIAL_LONG_PRESS__) {
      // Mirabox: knobs fire dialUp immediately after dialDown, so do the press here.
      this.logger.info("Fuel dial pressed");
      await this.doPress(settings.pressAction, ctx);

      return;
    }

    // Elgato: defer classification to dialUp; start a long-press timer.
    ctx.pressStart = Date.now();
    ctx.longPressFired = false;
    this.clearLongPressTimer(ctx);

    if (settings.longPressAction !== "none") {
      ctx.longPressTimer = setTimeout(() => {
        ctx.longPressTimer = null;
        ctx.longPressFired = true;
        this.logger.info("Fuel dial long-pressed");
        // doPress already renders at its end — no extra render needed here.
        void this.doPress(settings.longPressAction as PressAction, ctx);
      }, LONG_PRESS_THRESHOLD_MS);
    }
  }

  override async onDialUp(ev: IDeckDialUpEvent<FuelDialSettings>): Promise<void> {
    if (!__FEATURE_DIAL_LONG_PRESS__) return;

    const ctx = this.contextsState.get(ev.action.id);

    if (!ctx) return;

    this.clearLongPressTimer(ctx);

    if (ctx.longPressFired) return;

    const elapsed = Date.now() - ctx.pressStart;

    // When longPressAction is "none" no long-press timer was started, so a hold
    // of any duration must still fire pressAction on release — otherwise a slow
    // press would be silently swallowed.
    if (ctx.settings.longPressAction === "none" || elapsed < LONG_PRESS_THRESHOLD_MS) {
      this.logger.info("Fuel dial pressed");
      await this.doPress(ctx.settings.pressAction, ctx);
    }
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<FuelDialSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;
    this.logger.info("Fuel dial key pressed");
    await this.doPress(settings.pressAction, ctx);
  }

  override async onTouchTap(ev: IDeckTouchTapEvent<FuelDialSettings>): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    const settings = this.parseSettings(ev.payload.settings);

    if (settings.touchAction === "none") return;

    const ctx = this.ensureContext(ev.action, settings);
    ctx.settings = settings;
    this.logger.info("Fuel dial touch tap");
    await this.doPress(settings.touchAction, ctx);
  }

  /**
   * Runs the configured press action against the LIVE pit fuel-fill state and
   * re-renders. Toggle reads the real checkbox each time so it correctly
   * alternates between requesting fuel and clearing it.
   */
  private async doPress(action: PressAction, ctx: FuelDialContext): Promise<void> {
    const pit = getCommands().pit;
    const fuelOn = this.isFuelFillOn();
    // Whether this press cleared fueling. The live fuel-fill flag won't flip to
    // OFF until a later telemetry tick, so syncTargetTimer (which reads it) must
    // be skipped here — otherwise it would immediately re-arm the timer we stop.
    let cleared = false;

    switch (action) {
      case "toggle-fueling":
        if (fuelOn) {
          pit.clearFuel();
          cleared = true;
          this.logger.debug("Toggle: cleared fueling");
        } else {
          const addLtr = this.effectiveAddLtr(ctx);
          this.sendFuel(addLtr);
          // A resolved add of 0 clears instead of arming — keep bookkeeping in sync.
          cleared = addLtr <= 0;
          ctx.throttle.lastSentLtr = cleared ? null : addLtr;
          this.logger.debug(`Toggle: requested ${addLtr.toFixed(2)}L`);
        }

        break;

      case "clear-fueling":
        pit.clearFuel();
        cleared = true;
        this.logger.debug("Cleared fueling");
        break;

      case "fill-to-max": {
        const maxLtr = this.effectiveMaxLtr();

        if (maxLtr === undefined) {
          // No tank capacity to fill to — don't send a stale/zero target or arm.
          this.logger.warn("Fill-to-max: tank capacity unknown, skipping");

          return;
        }

        // Fill to Max is a TOGGLE (issue #681). In BOTH modes the dialed value
        // is set to the FULL tank capacity (add-mode: capacity as the add;
        // fill-to: capacity as the target). A second invocation while already at
        // max drops it to ~empty (FILL_TO_MAX_MIN_LTR). So repeatedly pressing
        // Fill to Max alternates full ↔ ~empty; the resolved-0 add path clears.
        const atMax = ctx.dialValueLtr >= maxLtr - 0.5;
        ctx.dialValueLtr = atMax ? FILL_TO_MAX_MIN_LTR : maxLtr;
        const addLtr = this.effectiveAddLtr(ctx);
        this.sendFuel(addLtr);
        // In fill-to mode "empty" (target ~1 L) resolves to add 0 → clearFuel; treat
        // it like a clear so the top-up timer stops and the armed amount resets.
        cleared = addLtr <= 0;
        ctx.throttle.lastSentLtr = cleared ? null : addLtr;
        this.logger.debug(`Fill to max (${atMax ? "empty" : "full"}): requested ${addLtr.toFixed(2)}L`);
        break;
      }
    }

    if (cleared) {
      // Stop the top-up timer immediately on clear; do not call syncTargetTimer
      // here since it reads the not-yet-updated live fuel-fill flag.
      this.clearTargetTimer(ctx);
    } else {
      // A toggle-on or fill in fill-to mode should keep the request topped up.
      this.syncTargetTimer(ctx);
    }

    await this.render(ctx);
  }

  /**
   * Schedules a trailing-throttle send of the latest add target. The first
   * change fires promptly (leading edge); rapid follow-ups coalesce into one
   * flush per window. No-op repeats of the same liters are suppressed.
   */
  private scheduleSend(ctx: FuelDialContext): void {
    ctx.throttle.pendingLtr = this.effectiveAddLtr(ctx);

    if (ctx.throttle.timer === null) {
      // Leading edge — send immediately, then open the coalescing window.
      this.flushSend(ctx);
      ctx.throttle.timer = setTimeout(() => {
        ctx.throttle.timer = null;
        // Recompute against the latest dialed value before the trailing send.
        ctx.throttle.pendingLtr = this.effectiveAddLtr(ctx);
        this.flushSend(ctx);
      }, THROTTLE_WINDOW_MS);
    }
  }

  /** Broadcasts the pending add target (suppressing no-op repeats) and updates feedback. */
  private flushSend(ctx: FuelDialContext): void {
    const target = ctx.throttle.pendingLtr;
    ctx.throttle.pendingLtr = null;

    if (target === null) return;

    if (ctx.throttle.lastSentLtr === target) {
      // Same value already sent — still refresh feedback, skip the broadcast.
      void this.renderFeedback(ctx);

      return;
    }

    this.sendFuel(target);
    ctx.throttle.lastSentLtr = target;
    this.logger.info("Fuel request sent");
    this.logger.debug(`Sent ${target.toFixed(2)}L`);
    void this.renderFeedback(ctx);
  }

  /**
   * Sends a fuel request through the single SDK entry point, mapping a resolved
   * add of 0 (or less) to `pit.clearFuel()` instead of `pit.fuel(0)`. The iRacing
   * SDK treats `pit.fuel(0)` as "keep the existing amount", NOT "request zero", so
   * a computed add of 0 must clear the request to mean "don't add anything"
   * (issue #681). Any non-zero add (including the 1 L Fill-to-max minimum) goes
   * through `pit.fuel`.
   */
  private sendFuel(addLtr: number): void {
    if (addLtr <= 0) {
      getCommands().pit.clearFuel();
      this.logger.debug("Resolved add is 0 — cleared fueling instead of requesting 0 L");
    } else {
      getCommands().pit.fuel(addLtr);
    }
  }

  private parseSettings(settings: unknown): FuelDialSettings {
    const parsed = FuelDialSettings.safeParse(settings);

    return parsed.success ? parsed.data : FuelDialSettings.parse({});
  }

  private ensureContext(action: IDeckActionContext, settings: FuelDialSettings): FuelDialContext {
    let ctx = this.contextsState.get(action.id);

    if (!ctx) {
      ctx = {
        settings,
        action,
        dialValueLtr: 0,
        lastUserActivity: 0,
        longPressTimer: null,
        longPressFired: false,
        pressStart: 0,
        targetTimer: null,
        displayTimer: null,
        lastRenderSig: null,
        lastChangeRenderAt: 0,
        throttle: { timer: null, pendingLtr: null, lastSentLtr: null },
      };
      this.contextsState.set(action.id, ctx);
    } else {
      ctx.action = action;
      ctx.settings = settings;
    }

    return ctx;
  }

  private effectiveDisplayUnits(ctx: FuelDialContext): number {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const telemetryUnits = telemetry ? (telemetry as Record<string, unknown>).DisplayUnits : undefined;

    return resolveDisplayUnits(ctx.settings.unitMode, typeof telemetryUnits === "number" ? telemetryUnits : undefined);
  }

  private effectiveMaxLtr(): number | undefined {
    return readEffectiveMaxLtr(this.sdkController.getSessionInfo());
  }

  /** Current fuel level (liters) from live telemetry; 0 when unknown. */
  private currentLtr(): number {
    return readFuelLevel(this.sdkController.getCurrentTelemetry());
  }

  /** Live pit fuel-fill checkbox state. */
  private isFuelFillOn(): boolean {
    return isFuelFillOn(this.sdkController.getCurrentTelemetry());
  }

  /** Effective liters to ADD for a context, from its dialed value + live telemetry. */
  private effectiveAddLtr(ctx: FuelDialContext): number {
    return computeAddLtr(
      ctx.settings.dialMode,
      ctx.dialValueLtr,
      this.currentLtr(),
      this.effectiveMaxLtr(),
      this.effectiveDisplayUnits(ctx),
    );
  }

  /**
   * Starts/stops the fill-to top-up timer to match the current state. The
   * timer runs only in fill-to mode while fuel-fill is ON; it recomputes
   * the add against the latest fuel level every TARGET_RECOMPUTE_MS and re-sends
   * it (respecting the user's toggle — it never re-arms when fuel is off).
   */
  private syncTargetTimer(ctx: FuelDialContext): void {
    const shouldRun = ctx.settings.dialMode === "fill-to" && this.isFuelFillOn();

    if (!shouldRun) {
      this.clearTargetTimer(ctx);

      return;
    }

    if (ctx.targetTimer !== null) return;

    ctx.targetTimer = setInterval(() => {
      // Stop quietly if the user has since turned fuel off or left fill-to mode.
      if (ctx.settings.dialMode !== "fill-to" || !this.isFuelFillOn()) {
        this.clearTargetTimer(ctx);

        return;
      }

      const addLtr = this.effectiveAddLtr(ctx);
      this.sendFuel(addLtr);
      ctx.throttle.lastSentLtr = addLtr <= 0 ? null : addLtr;
      this.logger.debug(`Target top-up: requested ${addLtr.toFixed(2)}L`);
      void this.render(ctx);
    }, TARGET_RECOMPUTE_MS);
  }

  /**
   * Re-seeds the dialed value from telemetry. When `force` is false the re-seed
   * is skipped if the user rotated recently (so live telemetry can't fight an
   * in-flight adjustment). add-mode seeds from `PitSvFuel` (the requested add);
   * fill-to mode seeds from `current + PitSvFuel` (the resulting total).
   */
  private seedFromTelemetry(ctx: FuelDialContext, force: boolean): void {
    if (!force && Date.now() - ctx.lastUserActivity < USER_ACTIVITY_GRACE_MS) return;

    const telemetry = this.sdkController.getCurrentTelemetry();
    const pitFuel = readPitSvFuel(telemetry);

    if (pitFuel === undefined) return;

    const maxLtr = this.effectiveMaxLtr();

    if (ctx.settings.dialMode === "fill-to") {
      const current = readFuelLevel(telemetry);
      // Seed the target as a whole integer display value.
      ctx.dialValueLtr = clampTargetLtr(
        roundToWholeDisplayLtr(current + pitFuel, this.effectiveDisplayUnits(ctx)),
        maxLtr,
      );
    } else {
      ctx.dialValueLtr = clampTargetLtr(pitFuel, maxLtr);
    }
  }

  private onTelemetry(ctx: FuelDialContext, telemetry: TelemetryData | null): void {
    // Re-seed the dialed value from telemetry only when the user hasn't rotated
    // recently — and ONLY in add-amount mode. In fill-to mode the dialed
    // value is the user's chosen TOTAL: re-seeding it from `current + PitSvFuel`
    // would silently lower the target as fuel burns (PitSvFuel is the last-sent
    // add, not the live gap). The 30 s target timer + the live add computation
    // already keep the request matched to the burning fuel (issue #681).
    if (ctx.settings.dialMode === "add-amount" && Date.now() - ctx.lastUserActivity >= USER_ACTIVITY_GRACE_MS) {
      const pitFuel = readPitSvFuel(telemetry);

      if (pitFuel !== undefined) {
        ctx.dialValueLtr = clampTargetLtr(pitFuel, this.effectiveMaxLtr());
      }
    }

    // Keep the top-up timer in sync with the live fuel-fill state.
    this.syncTargetTimer(ctx);

    // Render-on-CHANGE (issue #681): the bar's fuel-fill color and the displayed
    // values must track telemetry without the up-to-5s lag of the heartbeat
    // timer. Push feedback immediately when the DISPLAYED signature changes
    // (fuel-fill flips, or a rounded current/add/total moves), throttled to at
    // most once per CHANGE_RENDER_MIN_INTERVAL_MS so a burst of ticks can't blow
    // past the ≤10 setFeedback/sec/dial cap. Unchanged ticks update the keypad
    // icon only (no feedback). The 5s timer remains as a heartbeat.
    const sig = this.displayedSignature(ctx);

    if (sig !== ctx.lastRenderSig && Date.now() - ctx.lastChangeRenderAt >= CHANGE_RENDER_MIN_INTERVAL_MS) {
      ctx.lastRenderSig = sig;
      ctx.lastChangeRenderAt = Date.now();
      void this.render(ctx);

      return;
    }

    // Update the keypad icon, but do NOT push touch-strip feedback on every tick
    // — the ≤10 setFeedback/sec/dial cap is respected by the change-detector + the
    // display-refresh timer + event-driven renders instead (issue #681).
    void this.render(ctx, { skipFeedback: true });
  }

  /**
   * A compact signature of the DISPLAYED state used by the render-on-change path:
   * the live fuel-fill flag plus the rounded current / add / total values. When
   * this string differs from the last rendered one, a feedback push is due.
   *
   * In fill-to mode the displayed target (`dialValueLtr`, shown in the "→ <target>"
   * readout and the red target line) can change while the resolved add stays 0 —
   * dialing the target at/below current fuel leaves add at 0 but moves the marker.
   * The target is therefore appended only in fill-to mode so the readout refreshes
   * promptly instead of waiting for the 5 s heartbeat (issue #681). In add-amount
   * mode the dialed value is already captured via `addLtr`.
   */
  private displayedSignature(ctx: FuelDialContext): string {
    const displayUnits = this.effectiveDisplayUnits(ctx);
    const maxLtr = this.effectiveMaxLtr();
    const currentLtr = this.currentLtr();
    const addLtr = this.effectiveAddLtr(ctx);
    const totalLtr = computeTotalLtr(currentLtr, addLtr, maxLtr);
    const fuelOn = this.isFuelFillOn();

    return [
      fuelOn ? "on" : "off",
      formatDisplayValue(currentLtr, displayUnits),
      formatDisplayValue(addLtr, displayUnits),
      formatDisplayValue(totalLtr, displayUnits),
      ctx.settings.dialMode === "fill-to" ? formatDisplayValue(ctx.dialValueLtr, displayUnits) : "",
    ].join("|");
  }

  /**
   * Starts the periodic display-refresh timer for a context. While appeared it
   * re-renders the bar + value every DISPLAY_REFRESH_MS so the displayed add
   * (target − current in fill-to mode) and the live total track fuel burn without
   * pushing feedback on every telemetry tick. Acts as a heartbeat alongside the
   * render-on-change path in onTelemetry. Idempotent — never stacks.
   */
  private startDisplayTimer(ctx: FuelDialContext): void {
    if (ctx.displayTimer !== null) return;

    ctx.displayTimer = setInterval(() => {
      void this.render(ctx);
    }, DISPLAY_REFRESH_MS);
  }

  private clearDisplayTimer(ctx: FuelDialContext): void {
    if (ctx.displayTimer !== null) {
      clearInterval(ctx.displayTimer);
      ctx.displayTimer = null;
    }
  }

  private clearLongPressTimer(ctx: FuelDialContext): void {
    if (ctx.longPressTimer !== null) {
      clearTimeout(ctx.longPressTimer);
      ctx.longPressTimer = null;
    }
  }

  private clearTargetTimer(ctx: FuelDialContext): void {
    if (ctx.targetTimer !== null) {
      clearInterval(ctx.targetTimer);
      ctx.targetTimer = null;
    }
  }

  private clearTimers(ctx: FuelDialContext): void {
    this.clearLongPressTimer(ctx);
    this.clearTargetTimer(ctx);
    this.clearDisplayTimer(ctx);

    if (ctx.throttle.timer !== null) {
      clearTimeout(ctx.throttle.timer);
      ctx.throttle.timer = null;
    }
  }

  /** Pushes the encoder trigger descriptions for a dial (Elgato only). */
  private async applyTriggerDescription(ctx: FuelDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.settings));
  }

  /**
   * Renders the keypad icon and (for dials) the touch-strip feedback.
   *
   * Pass `skipFeedback: true` for per-rotate renders — the touch-strip feedback
   * is instead pushed by the throttled `flushSend`, so a continuous spin stays
   * within the ≤10 `setFeedback`/sec/dial cap. Press/settings/telemetry-driven
   * renders omit the flag so feedback updates immediately.
   */
  private async render(ctx: FuelDialContext, opts?: { skipFeedback?: boolean }): Promise<void> {
    if (ctx.action.isKey()) {
      const svg = this.generateIcon(ctx);
      await this.updateKeyImageForContext(ctx, svg);
    }

    if (!opts?.skipFeedback) {
      await this.renderFeedback(ctx);
    }
  }

  /** Builds the keypad icon for a context from live telemetry. */
  private generateIcon(ctx: FuelDialContext): string {
    return generateFuelDialSvg(
      ctx.settings,
      this.currentLtr(),
      this.effectiveAddLtr(ctx),
      this.effectiveMaxLtr(),
      this.effectiveDisplayUnits(ctx),
      this.isFuelFillOn(),
      ctx.dialValueLtr,
    );
  }

  /** Stores the icon for a context and pushes it to the device. */
  private async updateKeyImageForContext(ctx: FuelDialContext, svg: string): Promise<void> {
    const updated = await this.updateKeyImage(ctx.action.id, svg);

    if (!updated) {
      // First render for this context — register via setKeyImage so BaseAction tracks it.
      await this.setKeyImage({ action: ctx.action, payload: { settings: ctx.settings } }, svg);
      this.setRegenerateCallback(ctx.action.id, () => this.generateIcon(ctx));
    }
  }

  /** Pushes the touch-strip feedback when this is a dial. */
  private async renderFeedback(ctx: FuelDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const displayUnits = this.effectiveDisplayUnits(ctx);
    const maxLtr = this.effectiveMaxLtr();
    const currentLtr = this.currentLtr();
    const addLtr = this.effectiveAddLtr(ctx);
    const totalLtr = computeTotalLtr(currentLtr, addLtr, maxLtr);
    const fuelOn = this.isFuelFillOn();
    // The target line is only drawn in fill-to mode.
    const barTarget = ctx.settings.dialMode === "fill-to" ? ctx.dialValueLtr : undefined;
    const barSvg = renderFuelBarSvg(currentLtr, addLtr, maxLtr, fuelOn, 184, 30, displayUnits, barTarget);
    const feedback: DeckFeedbackPayload = {
      title: buildTitleText(ctx.settings.dialMode),
      value: buildValueText(ctx.settings.dialMode, addLtr, totalLtr, ctx.dialValueLtr, displayUnits),
      bar: svgToDataUri(barSvg),
    };
    await ctx.action.setFeedback(feedback);

    // Reset the change-detector baseline so a pushed feedback (rotate/press/
    // heartbeat) doesn't immediately re-fire the render-on-change path next tick.
    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
