/**
 * The Stream Dock knob rendering of the shared dash box (#1013): the same
 * vocabulary as the strip — an inset rounded panel, a short label, a big live
 * value, the #953 side markers, the #1120 pending mark, the #612 warning — but
 * composed for the squarer 176×112 screen above the knob: the label becomes a
 * top line, and the value (capped at 50 px) is centred in the room below it, so
 * a value shrunk to fit sits in the middle rather than on the bottom edge.
 * Deliberately a separate function from `renderStripBox` so the knob can drop
 * or rearrange elements without moving a pixel on the strip.
 */
import { applyBindingWarning } from "@iracedeck/deck-core";

import type { DialBoxArgs } from "./dial-box.js";
import { PENDING_BAR_HEIGHT, renderPendingBar } from "./dial-preview.js";

/**
 * The knob screen's size — deck-core's `STREAM_DOCK_KNOB_CANVAS` (176×112),
 * which a test pins these to. Literals rather than a module-scope read of that
 * export: every surface test mocks `@iracedeck/deck-core` with only what it
 * uses, and `dial-box.ts` imports this module, so a module-scope read would
 * throw on import in all of them. The layout constants below are tuned for
 * exactly this size anyway.
 *
 * @internal Exported for testing
 */
export const KNOB_BOX_WIDTH = 176;
/** @internal Exported for testing */
export const KNOB_BOX_HEIGHT = 112;

const W = KNOB_BOX_WIDTH;
const H = KNOB_BOX_HEIGHT;

// Panel frame — the strip's proportions of the shorter side (112): 16 % radius, 4.5 % inset, 5 % stroke.
const RADIUS = Math.round(H * 0.16); // 18
const INSET = Math.max(5, Math.round(H * 0.045)); // 5
const STROKE = Math.max(5, Math.round(H * 0.05)); // 6

const LABEL_FONT = 16;
const LABEL_Y = 28;
// Capped so a wide short value ("3 mm") clears the border stroke with a visible
// margin — the 0.6 em fit underestimates wide glyphs such as "m" (design gate).
const VALUE_CAP = 50;
/** The panel's inner bottom edge: the border strokes ON the inset rect, so half of it eats inward. */
const PANEL_INNER_BOTTOM = H - INSET - Math.round(STROKE / 2); // 104
/** The value's visual centre: midway between the label's baseline and the inner bottom edge. */
const VALUE_CENTER_Y = Math.round((LABEL_Y + PANEL_INNER_BOTTOM) / 2); // 66
const DEFAULT_IDENTITY_LABEL_SCALE = 0.24;
const FONT = 'font-family="Arial, sans-serif" font-weight="bold"';

/** Bold Arial averages ~0.6 em per glyph; shrink the value to fit, capped. */
function fitValueFontSize(text: string, maxWidth: number, cap: number): number {
  return Math.round(Math.min(cap, maxWidth / Math.max(1, text.length * 0.6)));
}

export function renderKnobBox(args: DialBoxArgs): string {
  const {
    abbr,
    value,
    colors,
    identityLabelScale = DEFAULT_IDENTITY_LABEL_SCALE,
    bindingMissing = false,
    sideMarker,
    pending = null,
  } = args;
  const displayValue = pending ? pending.text : value;
  const valueColor = pending ? pending.color : colors.value;
  const identityOnly = displayValue === "";

  const labelFontSize = identityOnly ? Math.round(H * identityLabelScale) : LABEL_FONT;
  // <text> y is the BASELINE (resvg ignores dominant-baseline): a centered
  // identity label adds ~0.36 em; the label-above-value layout uses a fixed top line.
  const labelY = identityOnly ? Math.round(H * 0.5) + Math.round(labelFontSize * 0.36) : LABEL_Y;
  const label = `<text x="${W / 2}" y="${labelY}" text-anchor="middle" fill="${colors.label}" ${FONT} font-size="${labelFontSize}">${abbr}</text>`;

  let valueText = "";

  if (!identityOnly) {
    const valueFontSize = fitValueFontSize(displayValue, W - 2 * (INSET + STROKE + 8), VALUE_CAP);
    // Baseline = visual centre + ~0.36 em (bold Arial), as for the identity label.
    const valueY = VALUE_CENTER_Y + Math.round(valueFontSize * 0.36);
    valueText = `<text x="${W / 2}" y="${valueY}" text-anchor="middle" fill="${valueColor}" ${FONT} font-size="${valueFontSize}">${displayValue}</text>`;

    // Just under the value's baseline, clamped inside the panel.
    if (pending) {
      const barTop = Math.min(valueY + 4, PANEL_INNER_BOTTOM - PENDING_BAR_HEIGHT);
      valueText += renderPendingBar({ centerX: W / 2, y: barTop, width: W, color: pending.color });
    }
  }

  let markers = "";

  if (sideMarker) {
    const markerH = Math.round(labelFontSize * 0.9);
    const markerW = Math.round(markerH * 0.7);
    const cy = labelY - Math.round(labelFontSize * 0.36);
    const offset = Math.round(W * 0.3);
    const leftCx = W / 2 - offset;
    const rightCx = W / 2 + offset;
    const dim = ' opacity="0.22"';
    markers =
      `<polygon data-side="left" points="${leftCx - markerW / 2},${cy} ${leftCx + markerW / 2},${cy - markerH / 2} ${leftCx + markerW / 2},${cy + markerH / 2}" fill="${colors.label}"${sideMarker === "left" ? "" : dim}/>` +
      `<polygon data-side="right" points="${rightCx + markerW / 2},${cy} ${rightCx - markerW / 2},${cy - markerH / 2} ${rightCx - markerW / 2},${cy + markerH / 2}" fill="${colors.label}"${sideMarker === "right" ? "" : dim}/>`;
  }

  const content = label + valueText + markers;
  const panel = `<rect x="${INSET}" y="${INSET}" width="${W - 2 * INSET}" height="${H - 2 * INSET}" rx="${Math.max(0, RADIUS - INSET)}" fill="${colors.background}" stroke="${colors.border}" stroke-width="${STROKE}"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    panel +
    `${bindingMissing ? applyBindingWarning(content, { width: W, height: H }) : content}</svg>`
  );
}
