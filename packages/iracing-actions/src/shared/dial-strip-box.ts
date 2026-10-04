/**
 * The Stream Deck+ strip rendering of the shared dash box — today's drawing,
 * moved here unchanged when the knob rendering was added (#1013). Byte-for-byte
 * pinned by `dial-strip-box.test.ts` against `__fixtures__/dial-strip-box.json`.
 */
import { applyBindingWarning } from "@iracedeck/deck-core";

import type { DialBoxArgs } from "./dial-box.js";
import { fitValueFontSize } from "./dial-fit.js";
import { PENDING_BAR_HEIGHT, renderPendingBar } from "./dial-preview.js";
import { renderSideMarkers, resolveSideMarks } from "./dial-side-markers.js";

/** The default identity-only (valueless) label scale, as a fraction of the box's shorter side. */
const DEFAULT_IDENTITY_LABEL_SCALE = 0.24;
/** Opacity of a dimmed box (#1230). */
const DIMMED_OPACITY = 0.35;

/**
 * Renders the dash-box SVG. The background fills the panel INSIDE the border and
 * the border strokes it. An empty `value` (identity-only setting) draws just the
 * centered label. When the rotation binding is missing the content dims under
 * the centered #612 warning triangle.
 *
 * A `caption` (#1230) takes a small bottom line: the value is then capped
 * lower and centred between the label and the caption (an identity-only label
 * is centred above it). Without one, the drawing is the pinned pre-#1013 one.
 */
export function renderStripBox(args: DialBoxArgs & { width: number; height: number }): string {
  const {
    width: w,
    height: h,
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

  const minSide = Math.min(w, h);
  const radius = Math.round(minSide * 0.16);
  const inset = Math.max(5, Math.round(minSide * 0.045));
  const strokeWidth = Math.max(5, Math.round(minSide * 0.05));
  const displayValue = pending ? pending.text : value;
  const valueColor = pending ? pending.color : colors.value;
  const identityOnly = displayValue === "";
  const hasCaption = caption !== "";

  // The caption sits just inside the panel's bottom edge; `captionTop` is its
  // cap height above the baseline, the line everything above must clear.
  const captionFontSize = Math.round(minSide * 0.13);
  const captionY = h - inset - strokeWidth - 2;
  const captionTop = captionY - Math.round(captionFontSize * 0.72);

  const labelFontSize = identityOnly ? Math.round(minSide * identityLabelScale) : Math.round(minSide * 0.15);
  // SVG <text> y is the BASELINE and resvg ignores dominant-baseline, so a
  // centered identity-only label must add the baseline offset (~0.36em for bold
  // Arial) — otherwise it renders visibly ABOVE center (#804). The
  // label-above-value layout keeps its historic baseline (0.28h).
  const identityCenterY = hasCaption ? Math.round((inset + captionTop) / 2) : Math.round(h * 0.5);
  const labelY = identityOnly ? identityCenterY + Math.round(labelFontSize * 0.36) : Math.round(h * 0.28);

  const labelText = `<text x="${w / 2}" y="${labelY}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="${labelFontSize}" font-weight="bold">${abbr}</text>`;

  let valueText = "";

  if (!identityOnly) {
    const valueFontSize = fitValueFontSize(
      displayValue,
      w - 2 * (inset + strokeWidth + Math.round(w * 0.05)),
      Math.round(h * (hasCaption ? 0.4 : 0.52)),
    );
    // With a caption the value's visual centre is midway between the label's
    // baseline and the caption's top; without one, its historic baseline.
    const valueY = hasCaption
      ? Math.round((labelY + captionTop) / 2) + Math.round(valueFontSize * 0.36)
      : Math.round(h * 0.64) + 13;
    valueText = `<text x="${w / 2}" y="${valueY}" text-anchor="middle" fill="${valueColor}" font-family="Arial, sans-serif" font-size="${valueFontSize}" font-weight="bold">${displayValue}</text>`;

    // The pending underline sits just under the value's baseline, clamped so it
    // stays inside the panel — the border strokes ON the inset rect, so half of
    // it eats inward. Every caller draws at 200×100, where the clamp never
    // binds; it is there so a smaller box can never push the mark off the panel.
    if (pending) {
      const barFloor = hasCaption ? captionTop - 1 : h - inset - Math.round(strokeWidth / 2);
      const barTop = Math.min(valueY + 4, barFloor - PENDING_BAR_HEIGHT);
      valueText += renderPendingBar({ centerX: w / 2, y: barTop, width: w, color: pending.color });
    }
  }

  const markerContent = sideMarker
    ? renderSideMarkers({
        width: w,
        labelY,
        labelFontSize,
        color: colors.label,
        marks: resolveSideMarks(sideMarker),
      })
    : "";

  const captionText = hasCaption
    ? `<text data-caption="true" x="${w / 2}" y="${captionY}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="${captionFontSize}" font-weight="bold">${caption}</text>`
    : "";

  const content = labelText + valueText + markerContent + captionText;

  const innerW = w - 2 * inset;
  const innerH = h - 2 * inset;
  const innerRx = Math.max(0, radius - inset);

  // The background fills the panel INSIDE the border; a single filled+stroked
  // inset rect leaves the outer margin transparent (device black).
  const panelRect = `<rect x="${inset}" y="${inset}" width="${innerW}" height="${innerH}" rx="${innerRx}" fill="${colors.background}" stroke="${colors.border}" stroke-width="${strokeWidth}"/>`;

  const body = panelRect + (bindingMissing ? applyBindingWarning(content, { width: w, height: h }) : content);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `${dimmed ? `<g data-dimmed="true" opacity="${DIMMED_OPACITY}">${body}</g>` : body}</svg>`
  );
}
