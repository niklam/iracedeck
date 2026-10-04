/**
 * The Stream Dock knob rendering of the shared dash box (#1013): the same
 * vocabulary as the strip — an inset rounded panel, a short label, a big live
 * value, the #953 side markers, the #1120 pending mark, the #612 warning, the
 * #1230 caption and dim — but
 * composed for the squarer 176×112 screen above the knob: the label becomes a
 * top line, and the value (capped at 50 px) is centred in the room below it, so
 * a value shrunk to fit sits in the middle rather than on the bottom edge.
 * Deliberately a separate function from `renderStripBox` so the knob can drop
 * or rearrange elements without moving a pixel on the strip.
 */
import { applyBindingWarning } from "@iracedeck/deck-core";

import type { DialBoxArgs } from "./dial-box.js";
import { fitValueFontSize } from "./dial-fit.js";
import { PENDING_BAR_HEIGHT, renderPendingBar } from "./dial-preview.js";
import { renderSideMarkers, resolveSideMarks } from "./dial-side-markers.js";

/**
 * The knob screen's size — deck-core's `STREAM_DOCK_KNOB_CANVAS` (176×112),
 * which a test pins these to. The one source of the knob size for every knob
 * drawing: the self-drawn surfaces (Fuel Service, Audio Controls, Black Box
 * Selector) import these rather than repeating the literals. Literals rather than a module-scope read of that
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

// The optional caption line (#1230): just inside the panel's inner bottom edge.
const CAPTION_FONT = 14;
const CAPTION_Y = PANEL_INNER_BOTTOM - 5; // 99
/** The caption's cap height above its baseline: the line the value and the pending mark must clear. */
const CAPTION_TOP = CAPTION_Y - Math.round(CAPTION_FONT * 0.72); // 89
/** The value's cap with a caption below it, so the two never touch. */
const CAPTIONED_VALUE_CAP = 40;
/** The value's visual centre with a caption: midway between the label's baseline and the caption's top. */
const CAPTIONED_VALUE_CENTER_Y = Math.round((LABEL_Y + CAPTION_TOP) / 2); // 59
/** Opacity of a dimmed box (#1230). */
const DIMMED_OPACITY = 0.35;

export function renderKnobBox(args: DialBoxArgs): string {
  const {
    abbr,
    value,
    colors,
    identityLabelScale = DEFAULT_IDENTITY_LABEL_SCALE,
    bindingMissing = false,
    sideMarker,
    caption = "",
    dimmed = false,
    pending = null,
  } = args;
  const hasCaption = caption !== "";
  const displayValue = pending ? pending.text : value;
  const valueColor = pending ? pending.color : colors.value;
  const identityOnly = displayValue === "";

  const labelFontSize = identityOnly ? Math.round(H * identityLabelScale) : LABEL_FONT;
  // <text> y is the BASELINE (resvg ignores dominant-baseline): a centered
  // identity label adds ~0.36 em; the label-above-value layout uses a fixed top line.
  // A caption moves the centred identity label up into the room above it.
  const identityCenterY = hasCaption ? Math.round((INSET + CAPTION_TOP) / 2) : Math.round(H * 0.5);
  const labelY = identityOnly ? identityCenterY + Math.round(labelFontSize * 0.36) : LABEL_Y;
  const label = `<text x="${W / 2}" y="${labelY}" text-anchor="middle" fill="${colors.label}" ${FONT} font-size="${labelFontSize}">${abbr}</text>`;

  let valueText = "";

  if (!identityOnly) {
    const valueFontSize = fitValueFontSize(
      displayValue,
      W - 2 * (INSET + STROKE + 8),
      hasCaption ? CAPTIONED_VALUE_CAP : VALUE_CAP,
    );
    // Baseline = visual centre + ~0.36 em (bold Arial), as for the identity label.
    const valueY = (hasCaption ? CAPTIONED_VALUE_CENTER_Y : VALUE_CENTER_Y) + Math.round(valueFontSize * 0.36);
    valueText = `<text x="${W / 2}" y="${valueY}" text-anchor="middle" fill="${valueColor}" ${FONT} font-size="${valueFontSize}">${displayValue}</text>`;

    // Just under the value's baseline, clamped inside the panel.
    if (pending) {
      const barFloor = hasCaption ? CAPTION_TOP - 1 : PANEL_INNER_BOTTOM;
      const barTop = Math.min(valueY + 4, barFloor - PENDING_BAR_HEIGHT);
      valueText += renderPendingBar({ centerX: W / 2, y: barTop, width: W, color: pending.color });
    }
  }

  const markers = sideMarker
    ? renderSideMarkers({ width: W, labelY, labelFontSize, color: colors.label, marks: resolveSideMarks(sideMarker) })
    : "";

  const captionText = hasCaption
    ? `<text data-caption="true" x="${W / 2}" y="${CAPTION_Y}" text-anchor="middle" fill="${colors.label}" ${FONT} font-size="${CAPTION_FONT}">${caption}</text>`
    : "";

  const content = label + valueText + markers + captionText;
  const panel = `<rect x="${INSET}" y="${INSET}" width="${W - 2 * INSET}" height="${H - 2 * INSET}" rx="${Math.max(0, RADIUS - INSET)}" fill="${colors.background}" stroke="${colors.border}" stroke-width="${STROKE}"/>`;

  const body = panel + (bindingMissing ? applyBindingWarning(content, { width: W, height: H }) : content);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `${dimmed ? `<g data-dimmed="true" opacity="${DIMMED_OPACITY}">${body}</g>` : body}</svg>`
  );
}
