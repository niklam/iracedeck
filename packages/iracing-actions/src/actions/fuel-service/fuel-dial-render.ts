/**
 * Fuel Service — the dial screen's drawing (#1662).
 *
 * The pure renderers of the Fuel Service dial surface (`fuel-dial-surface.ts`,
 * #759): the status band's text and state, the per-mode readout, the
 * two-segment fuel bar, the Stream Deck+ strip and Stream Dock knob drawings
 * (#1013) and the dispatch between them. Amounts are drawn in a sim-neutral
 * {@link UnitSystem}, which the surface resolves from the sim's own display
 * units; nothing here reads telemetry, so this module imports no sim package —
 * the website's icon gallery draws its Fuel Service sample from it without
 * loading the iRacing SDK.
 */
import { applyBindingWarning, type DialCanvasProfile } from "@iracedeck/deck-core";
import { fuelToUnitSystem, fuelUnitSuffixFor, type UnitSystem } from "@iracedeck/deck-core/display-units";

import { borderColorForState, type ToggleState } from "../../icons/status-bar.js";
import { fitValueFontSize } from "../../shared/dial-fit.js";
import { KNOB_BOX_HEIGHT, KNOB_BOX_WIDTH } from "../../shared/dial-knob-box.js";
import { type DialPendingPreview, renderPendingBar } from "../../shared/dial-preview.js";
import type { DialSettings } from "./fuel-service-settings.js";

/**
 * The readout and band text colour. The hold preview of a mode switch, which is
 * not a state, takes it too (`resolveHoldPreview`).
 */
export const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const GRAY = "#888888";
/** Neutral color for the static "current fuel" segment of the two-segment bar. */
const CURRENT_SEGMENT = "#9aa7b4";
/** Dark track behind both bar segments. */
const BAR_TRACK = "#1a1f26";
/** Color of the on-bar "current" amount label (dark, sits over the light current segment). */
const BAR_LABEL = "#0d1117";
/** Color of the on-bar "+add" amount label (white, sits over the green/red/gray add segment). */
const ADD_LABEL = WHITE;
/** Color of the "fill-to" target marker line (red, confined to the bar height). */
const TARGET_LINE = "#e74c3c";

/**
 * Baseline y of the strip's big readout (the value slot the hold preview
 * borrows, #1120). The status band ends at y=30 and the fuel bar starts at y=66.
 */
const READOUT_BASELINE_Y = 56;
/**
 * @internal Exported for testing
 *
 * Top edge of the pending underline: just under the readout's baseline, the
 * same `baseline + 4` the dash-box dials use. Its bottom edge
 * (`PENDING_BAR_TOP_Y + PENDING_BAR_HEIGHT` = 64) stays above the fuel bar at
 * {@link FUEL_BAR_TOP_Y}, so the mark never collides with the bar graphic.
 */
export const PENDING_BAR_TOP_Y = READOUT_BASELINE_Y + 4;
/**
 * @internal Exported for testing
 *
 * Top edge of the fuel bar's `<g translate>` — the y the pending mark must stay above.
 */
export const FUEL_BAR_TOP_Y = 66;

/**
 * @internal Exported for testing
 *
 * Formats a liters amount in the unit system, dropping the decimal for whole
 * numbers (e.g. "74" / "12.5").
 */
export function formatDisplayValue(liters: number, unitSystem: UnitSystem): string {
  const value = fuelToUnitSystem(liters, unitSystem);
  const rounded = Math.round(value * 10) / 10;

  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * @internal Exported for testing
 *
 * Builds the per-mode value text shown on the touch strip.
 *
 * - add-amount: `"+<add> = <total> <unit>"` (e.g. `"+20 = 65 L"`). The total is
 *   `min(current + add, capacity)` and reflects live fuel burn.
 * - fill-to: `"→ <target> <unit>"` (e.g. `"→ 65 L"`). The target is shown
 *   even when capacity is unknown.
 */
export function buildValueText(
  dialMode: DialSettings["mode"],
  addLtr: number,
  totalLtr: number,
  targetLtr: number,
  unitSystem: UnitSystem,
): string {
  const suffix = fuelUnitSuffixFor(unitSystem);

  if (dialMode === "fill-to") {
    return `→ ${formatDisplayValue(targetLtr, unitSystem)} ${suffix}`;
  }

  return `+${formatDisplayValue(addLtr, unitSystem)} = ${formatDisplayValue(totalLtr, unitSystem)} ${suffix}`;
}

/** Manual / autofuel / autofuel-unavailable, derived from live autofuel telemetry. */
export type DialDisplayMode = "manual" | "autofuel" | "autofuel-off";

/**
 * Tri-state fueling indication (#728): green ON / red OFF / gray N-A — the
 * shared {@link ToggleState} language of the toggle buttons' status bars and
 * state borders. It colours the bar's add segment in every mode, but drives the
 * status band only in manual mode — see {@link resolveBandState} (#1226).
 */
export type FuelFillState = ToggleState;

/**
 * @internal Exported for testing
 *
 * The state the status band shows (text and colour). In manual mode that is the
 * fueling state — whether the next stop takes fuel. In autofuel mode the band
 * states the autofuel switch itself, which is on by definition of the mode: the
 * fuel-fill checkbox there only says whether autofuel's plan adds fuel, and a
 * 0 L plan clears it, so reading it would show `AUTOFUEL: OFF` while autofuel
 * is on (#1226). What the stop adds stays visible in the `AUTO → <add>` readout
 * and the bar's add segment, which follow the fueling state through
 * `resolveAutofuelAddLtr` (`fuel-dial-surface.ts`). The switch is read from telemetry, so the band
 * is ON here even when the fueling state is unknown.
 */
export function resolveBandState(mode: DialDisplayMode, fillState: FuelFillState): FuelFillState {
  if (mode === "autofuel") return "on";

  return fillState;
}

/**
 * @internal Exported for testing
 *
 * The touch-strip status-band text (#728): the fuel subsystem a bare turn
 * controls (`REFUEL` in manual mode, `AUTOFUEL` when iRacing's autofuel is
 * engaged) plus the band's tri-state from {@link resolveBandState} — `ON` /
 * `OFF` / `N/A`. It takes the raw fueling state and resolves the band state
 * itself, so no caller can print the checkbox as the autofuel switch (#1226).
 * Text, never colour alone, so VR drivers catching a peripheral look can read
 * the state.
 */
export function buildRefuelBandText(mode: DialDisplayMode, fillState: FuelFillState): string {
  const subject = mode === "manual" ? "REFUEL" : "AUTOFUEL";
  const bandState = resolveBandState(mode, fillState);

  if (mode === "autofuel-off" || bandState === "na") return `${subject}: N/A`;

  return `${subject}: ${bandState === "on" ? "ON" : "OFF"}`;
}

/**
 * @internal Exported for testing
 *
 * The amount readout. Autofuel shows the telemetry-derived intended add
 * (`PitSvFuel`) as `AUTO → <add> <u>` — open-loop, since the lap-margin value is
 * not in telemetry, so it is never a fabricated counter. Manual delegates to
 * {@link buildValueText}; autofuel-unavailable shows a dash.
 */
export function buildDialReadout(
  mode: DialDisplayMode,
  dialMode: DialSettings["mode"],
  addLtr: number,
  totalLtr: number,
  targetLtr: number,
  unitSystem: UnitSystem,
): string {
  if (mode === "autofuel-off") return "—";

  if (mode === "autofuel") {
    return `AUTO → ${formatDisplayValue(addLtr, unitSystem)} ${fuelUnitSuffixFor(unitSystem)}`;
  }

  return buildValueText(dialMode, addLtr, totalLtr, targetLtr, unitSystem);
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
 * Renders ONE continuous two-segment fuel bar as a full SVG string (composed
 * into the touch strip's full-canvas pixmap).
 *
 * - A dark rounded track spans the full width.
 * - The CURRENT segment runs from the left (neutral gray-blue), the ADD segment
 *   is butted directly onto it: GREEN when fueling is ON, GRAY otherwise (off
 *   or state unknown). The bar stays deliberately subtle — the LOUD tri-state
 *   indicator is the status band at the top of the key (#728).
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
  fillState: FuelFillState,
  widthPx: number,
  heightPx: number,
  unitSystem: UnitSystem,
  targetLtr?: number,
): string {
  const radius = Math.min(heightPx / 2, 8);
  const span = maxLtr !== undefined && maxLtr > 0 ? maxLtr : Math.max(currentLtr + addLtr, 1);
  const currentW = Math.max(0, Math.min(widthPx, (currentLtr / span) * widthPx));
  const addW = Math.max(0, Math.min(widthPx - currentW, (addLtr / span) * widthPx));
  const addColor = fillState === "on" ? GREEN : GRAY;
  const fontSize = Math.max(8, Math.round(heightPx * 0.5));
  // Label y is a BASELINE (the deck app's QT renderer ignores dominant-baseline):
  // vertical center plus ~0.35 × font size centers the glyphs on the bar.
  const labelY = Math.round(heightPx / 2 + fontSize * 0.35);
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
  const currentLabel = formatDisplayValue(currentLtr, unitSystem);
  const currentLabelW = currentLabel.length * fontSize * 0.6 + pad;

  if (currentW >= currentLabelW) {
    parts.push(
      `<text x="${pad}" y="${labelY}" text-anchor="start" fill="${BAR_LABEL}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${currentLabel}</text>`,
    );
  }

  // +add label: WHITE, right-aligned at the add segment's right end, only when
  // the add segment can hold it (so it never lands on the dark empty track).
  const addLabel = `+${formatDisplayValue(addLtr, unitSystem)}`;
  const addLabelW = addLabel.length * fontSize * 0.6 + pad;

  if (addW >= addLabelW) {
    const addRight = currentW + addW;
    parts.push(
      `<text x="${(addRight - pad).toFixed(2)}" y="${labelY}" text-anchor="end" fill="${ADD_LABEL}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${addLabel}</text>`,
    );
  }

  // The viewBox spans exactly the bar so the track + segments fill the full
  // pixmap rect; the target line is confined to y in [0, heightPx].
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthPx} ${heightPx}" width="${widthPx}" height="${heightPx}">${parts.join("")}</svg>`;
}

/**
 * @internal Exported for testing
 *
 * Renders the ENTIRE 200×100 touch-strip slot as one SVG — the encoder layout
 * (`layouts/fuel-service.json`) is a single full-canvas pixmap, drawn ourselves
 * because the built-in layout text items cannot have a colored background
 * (#728): the status band across the top (green `REFUEL: ON` / red
 * `REFUEL: OFF` / green `AUTOFUEL: ON` / gray N-A), the per-mode readout, and
 * the two-segment fuel bar (with the red target line in manual fill-to mode).
 *
 * While a hold preview is `pending` (#1120) the readout slot shows the pending
 * outcome in its own colour, underlined by the shared pending bar; the band and
 * the fuel bar are left exactly as they are, so the driver still sees the fuel
 * picture the release will act on.
 */
export function renderStripCanvasSvg(
  mode: DialDisplayMode,
  dialMode: DialSettings["mode"],
  fillState: FuelFillState,
  currentLtr: number,
  addLtr: number,
  totalLtr: number,
  targetLtr: number,
  maxLtr: number | undefined,
  unitSystem: UnitSystem,
  bindingMissing = false,
  pending: DialPendingPreview | null = null,
): string {
  const bandState = resolveBandState(mode, fillState);
  const bandText = buildRefuelBandText(mode, fillState);
  const readout = buildDialReadout(mode, dialMode, addLtr, totalLtr, targetLtr, unitSystem);
  const valueText = pending ? pending.text : readout;
  const valueColor = pending ? pending.color : WHITE;
  // The red target line is drawn only in MANUAL fill-to mode; suppressed in autofuel.
  const barTarget = mode === "manual" && dialMode === "fill-to" ? targetLtr : undefined;
  const barSvg = renderFuelBarSvg(currentLtr, addLtr, maxLtr, fillState, 184, 28, unitSystem, barTarget);
  const bandHeight = 30;

  // Text y values are BASELINES — the deck app's QT SVG renderer ignores
  // dominant-baseline, so each text is centered by an explicit baseline offset
  // (~0.35 × font size below the intended visual center).
  const content = [
    // Status band with rounded top corners (the strip slot itself is square,
    // the small radius just softens the band edge).
    `<path d="M 0 ${bandHeight} L 0 8 A 8 8 0 0 1 8 0 L 192 0 A 8 8 0 0 1 200 8 L 200 ${bandHeight} Z" fill="${borderColorForState(bandState)}"/>`,
    `<text x="100" y="21" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="17" font-weight="bold">${bandText}</text>`,
    `<text x="100" y="${READOUT_BASELINE_Y}" text-anchor="middle" fill="${valueColor}" font-family="Arial, sans-serif" font-size="24" font-weight="bold">${valueText}</text>`,
    pending ? renderPendingBar({ centerX: 100, y: PENDING_BAR_TOP_Y, width: 200, color: pending.color }) : "",
    `<g transform="translate(8, ${FUEL_BAR_TOP_Y})">${stripSvgWrapper(barSvg)}</g>`,
  ].join("");

  // When a gesture slot needs the autofuel key binding but it's unset, dim the
  // slot and draw the centered #612 warning triangle over it (same convention
  // as Setup Brakes' strip box). The 200×100 canvas recenters + rescales the
  // 144-authored glyph (#775).
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">${
    bindingMissing ? applyBindingWarning(content, { width: 200, height: 100 }) : content
  }</svg>`;
}

/**
 * The Stream Dock knob rendering of the strip canvas (#1013), drawn for the
 * 176×112 LCD segment above the knob rather than scaled from the strip: the
 * same band / readout / two-segment bar vocabulary, with the squarer canvas
 * spent on a larger readout (up to 30 px) and a taller full-width bar. Approved
 * on the device by the maintainer; change the geometry only with a new preview.
 */
export function renderKnobCanvasSvg(
  mode: DialDisplayMode,
  dialMode: DialSettings["mode"],
  fillState: FuelFillState,
  currentLtr: number,
  addLtr: number,
  totalLtr: number,
  targetLtr: number,
  maxLtr: number | undefined,
  unitSystem: UnitSystem,
  bindingMissing = false,
  pending: DialPendingPreview | null = null,
): string {
  const w = KNOB_BOX_WIDTH;
  const h = KNOB_BOX_HEIGHT;
  const bandHeight = 30;
  const margin = 6;
  const barHeight = 30;
  const barTop = h - margin - barHeight;
  const readoutBaseline = 63;
  const bandState = resolveBandState(mode, fillState);
  const bandText = buildRefuelBandText(mode, fillState);
  const readout = buildDialReadout(mode, dialMode, addLtr, totalLtr, targetLtr, unitSystem);
  const valueText = pending ? pending.text : readout;
  const valueColor = pending ? pending.color : WHITE;
  // Shrink the readout to fit the width inside the margins, capped at 30 — the
  // same fitting every dash-box renderer uses.
  const readoutFontSize = fitValueFontSize(valueText, w - 2 * margin, 30);
  const barTarget = mode === "manual" && dialMode === "fill-to" ? targetLtr : undefined;
  const barSvg = renderFuelBarSvg(
    currentLtr,
    addLtr,
    maxLtr,
    fillState,
    w - 2 * margin,
    barHeight,
    unitSystem,
    barTarget,
  );

  const content = [
    `<path d="M 0 ${bandHeight} L 0 8 A 8 8 0 0 1 8 0 L ${w - 8} 0 A 8 8 0 0 1 ${w} 8 L ${w} ${bandHeight} Z" fill="${borderColorForState(bandState)}"/>`,
    `<text x="${w / 2}" y="21" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="17" font-weight="bold">${bandText}</text>`,
    `<text x="${w / 2}" y="${readoutBaseline}" text-anchor="middle" fill="${valueColor}" font-family="Arial, sans-serif" font-size="${readoutFontSize}" font-weight="bold">${valueText}</text>`,
    pending ? renderPendingBar({ centerX: w / 2, y: readoutBaseline + 4, width: w, color: pending.color }) : "",
    `<g transform="translate(${margin}, ${barTop})">${stripSvgWrapper(barSvg)}</g>`,
  ].join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${
    bindingMissing ? applyBindingWarning(content, { width: w, height: h }) : content
  }</svg>`;
}

/** Picks the drawing for the dial's own screen by its profile (#1013). */
export function renderFuelCanvasFor(
  canvas: DialCanvasProfile,
  args: Readonly<Parameters<typeof renderStripCanvasSvg>>,
): string {
  switch (canvas.id) {
    case "sd-plus-strip":
      return renderStripCanvasSvg(...args);
    case "stream-dock-knob":
      return renderKnobCanvasSvg(...args);
    default: {
      // A new DialCanvasId must get its own drawing here: this line stops compiling until it does.
      const unhandled: never = canvas.id;

      throw new Error(`Fuel Service: no drawing for dial canvas "${String(unhandled)}"`);
    }
  }
}

/** Strips the outer `<svg …>…</svg>` wrapper, returning only the inner markup. */
function stripSvgWrapper(svg: string): string {
  const open = svg.indexOf(">");
  const close = svg.lastIndexOf("</svg>");

  if (open === -1 || close === -1 || close <= open) return svg;

  return svg.slice(open + 1, close);
}
