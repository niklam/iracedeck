/**
 * The Stream Deck+ strip rendering of the shared dash box — today's drawing,
 * moved here unchanged when the knob rendering was added (#1013). Byte-for-byte
 * pinned by `dial-strip-box.test.ts` against `__fixtures__/dial-strip-box.json`.
 */
import { applyBindingWarning } from "@iracedeck/deck-core";

import type { DialBoxArgs } from "./dial-box.js";
import { fitValueFontSize } from "./dial-fit.js";
import { PENDING_BAR_HEIGHT, renderPendingBar } from "./dial-preview.js";

/** The default identity-only (valueless) label scale, as a fraction of the box's shorter side. */
const DEFAULT_IDENTITY_LABEL_SCALE = 0.24;

/**
 * Renders the dash-box SVG. The background fills the panel INSIDE the border and
 * the border strokes it. An empty `value` (identity-only setting) draws just the
 * centered label. When the rotation binding is missing the content dims under
 * the centered #612 warning triangle.
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
    pending = null,
  } = args;

  const minSide = Math.min(w, h);
  const radius = Math.round(minSide * 0.16);
  const inset = Math.max(5, Math.round(minSide * 0.045));
  const strokeWidth = Math.max(5, Math.round(minSide * 0.05));
  const displayValue = pending ? pending.text : value;
  const valueColor = pending ? pending.color : colors.value;
  const identityOnly = displayValue === "";

  const labelFontSize = identityOnly ? Math.round(minSide * identityLabelScale) : Math.round(minSide * 0.15);
  // SVG <text> y is the BASELINE and resvg ignores dominant-baseline, so a
  // centered identity-only label must add the baseline offset (~0.36em for bold
  // Arial) — otherwise it renders visibly ABOVE center (#804). The
  // label-above-value layout keeps its historic baseline (0.28h).
  const labelY = identityOnly ? Math.round(h * 0.5) + Math.round(labelFontSize * 0.36) : Math.round(h * 0.28);

  const labelText = `<text x="${w / 2}" y="${labelY}" text-anchor="middle" fill="${colors.label}" font-family="Arial, sans-serif" font-size="${labelFontSize}" font-weight="bold">${abbr}</text>`;

  let valueText = "";

  if (!identityOnly) {
    const valueFontSize = fitValueFontSize(
      displayValue,
      w - 2 * (inset + strokeWidth + Math.round(w * 0.05)),
      Math.round(h * 0.52),
    );
    const valueY = Math.round(h * 0.64) + 13;
    valueText = `<text x="${w / 2}" y="${valueY}" text-anchor="middle" fill="${valueColor}" font-family="Arial, sans-serif" font-size="${valueFontSize}" font-weight="bold">${displayValue}</text>`;

    // The pending underline sits just under the value's baseline, clamped so it
    // stays inside the panel — the border strokes ON the inset rect, so half of
    // it eats inward. Every caller draws at 200×100, where the clamp never
    // binds; it is there so a smaller box can never push the mark off the panel.
    if (pending) {
      const barTop = Math.min(valueY + 4, h - inset - Math.round(strokeWidth / 2) - PENDING_BAR_HEIGHT);
      valueText += renderPendingBar({ centerX: w / 2, y: barTop, width: w, color: pending.color });
    }
  }

  let markerContent = "";

  if (sideMarker) {
    const markerH = Math.round(labelFontSize * 0.9);
    const markerW = Math.round(markerH * 0.7);
    // The label's visual center (its baseline minus the ~0.36em bold-Arial offset).
    const markerCy = labelY - Math.round(labelFontSize * 0.36);
    const offset = Math.round(w * 0.3);
    const leftCx = w / 2 - offset;
    const rightCx = w / 2 + offset;
    const dim = ' opacity="0.22"';
    const leftPoints = `${leftCx - markerW / 2},${markerCy} ${leftCx + markerW / 2},${markerCy - markerH / 2} ${leftCx + markerW / 2},${markerCy + markerH / 2}`;
    const rightPoints = `${rightCx + markerW / 2},${markerCy} ${rightCx - markerW / 2},${markerCy - markerH / 2} ${rightCx - markerW / 2},${markerCy + markerH / 2}`;
    markerContent =
      `<polygon data-side="left" points="${leftPoints}" fill="${colors.label}"${sideMarker === "left" ? "" : dim}/>` +
      `<polygon data-side="right" points="${rightPoints}" fill="${colors.label}"${sideMarker === "right" ? "" : dim}/>`;
  }

  const content = labelText + valueText + markerContent;

  const innerW = w - 2 * inset;
  const innerH = h - 2 * inset;
  const innerRx = Math.max(0, radius - inset);

  // The background fills the panel INSIDE the border; a single filled+stroked
  // inset rect leaves the outer margin transparent (device black).
  const panelRect = `<rect x="${inset}" y="${inset}" width="${innerW}" height="${innerH}" rx="${innerRx}" fill="${colors.background}" stroke="${colors.border}" stroke-width="${strokeWidth}"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    panelRect +
    `${bindingMissing ? applyBindingWarning(content, { width: w, height: h }) : content}</svg>`
  );
}
