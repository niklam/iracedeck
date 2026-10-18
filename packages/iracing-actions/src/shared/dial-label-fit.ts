/**
 * Whether a dash-box label fits between the side markers (#801). The markers
 * sit at fixed places either side of the label (`dial-side-markers.ts`), so a
 * long label runs into them: `TRACK ORDER` did on the Stream Dock knob, which
 * is why Replay Control's Track Order box reads `TRK ORD`. The rule is that a
 * label leaves at least the room `INCIDENT` leaves each side on the knob, the
 * tightest label that shipped looking right (about 10 px).
 *
 * Measured with each renderer's own geometry (its canvas width, its label
 * size, the markers' offset and width) and bold Arial's advance widths
 * (`dial-text-width.ts`). Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`
 * ("The display").
 */
import { KNOB_BOX_WIDTH, KNOB_LABEL_FONT } from "./dial-knob-box.js";
import { sideMarkGeometry } from "./dial-side-markers.js";
import { stripLabelFontSize } from "./dial-strip-box.js";
import { boldTextWidth } from "./dial-text-width.js";

/** A dial canvas the box draws on: the Stream Deck+ strip or the Stream Dock knob. */
export type DialLabelCanvas = "strip" | "knob";

/**
 * The Stream Deck+ strip's size, deck-core's `SD_PLUS_STRIP_CANVAS`, which a
 * test pins these to; literals for the reason `dial-knob-box.ts` gives.
 *
 * @internal Exported for testing
 */
export const STRIP_BOX_WIDTH = 200;
/** @internal Exported for testing */
export const STRIP_BOX_HEIGHT = 100;

/** Each canvas's width and the label size its renderer draws a label above a value at. */
const CANVAS_GEOMETRY: Readonly<Record<DialLabelCanvas, { width: number; labelFontSize: number }>> = {
  strip: { width: STRIP_BOX_WIDTH, labelFontSize: stripLabelFontSize(STRIP_BOX_WIDTH, STRIP_BOX_HEIGHT) },
  knob: { width: KNOB_BOX_WIDTH, labelFontSize: KNOB_LABEL_FONT },
};

/**
 * The room in pixels between `label`'s edge and the inner edge of the side
 * marker, each side, on `canvas`: negative when the label runs into them.
 */
export function sideMarkLabelMargin(label: string, canvas: DialLabelCanvas): number {
  const { width, labelFontSize } = CANVAS_GEOMETRY[canvas];
  const { offset, markerW } = sideMarkGeometry(width, labelFontSize);

  return offset - markerW / 2 - boldTextWidth(label, labelFontSize) / 2;
}

/** The least room a label may leave each side: what `INCIDENT` leaves on the knob. */
export const MIN_SIDE_MARK_LABEL_MARGIN = sideMarkLabelMargin("INCIDENT", "knob");

/**
 * Whether `label` leaves at least {@link MIN_SIDE_MARK_LABEL_MARGIN} between
 * itself and each side marker on `canvas`.
 */
export function labelClearsSideMarks(label: string, canvas: DialLabelCanvas): boolean {
  return sideMarkLabelMargin(label, canvas) >= MIN_SIDE_MARK_LABEL_MARGIN;
}
