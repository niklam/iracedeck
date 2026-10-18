/**
 * The dash box's neighbours (#801): two short dimmed texts flanking the value,
 * as Camera Controls' Car # carousel flanks its car with the cars one detent
 * away — in the label colour at the carousel's 0.45 opacity, smaller than the
 * value and on its baseline. Replay Control's Track Order shows the cars on
 * track behind (left) and ahead (right) of the viewed one.
 *
 * Each side owns the room between the panel's inner edge and the value, less
 * a gap, and is centred in it. Both sides share one size, the largest up to
 * the canvas's cap at which each fits its room, so a pair never looks
 * mismatched; when that size would fall below a legible floor, neither side
 * is drawn. They never overlap the value or the border.
 *
 * One drawing for both canvases; each renderer passes its own geometry.
 */
import { boldTextWidth } from "./dial-text-width.js";

/** What a box flanks its value with: the left text and the right one. An empty side draws nothing. */
export interface DialNeighbours {
  left: string;
  right: string;
}

/** The neighbours' opacity: Camera Controls' Car # carousel's side numbers (#1281). */
const NEIGHBOUR_OPACITY = 0.45;
/** The room kept between a neighbour and the value. */
const VALUE_GAP = 6;
/** Below this size a neighbour is not legible on the dial's screen, so the pair is dropped. */
const MIN_NEIGHBOUR_FONT = 9;

/**
 * Draws the neighbours of a value centred on `centerX` and set at
 * `valueFontSize` on `baselineY`, within `contentLeft`..`contentRight` (the
 * panel's inner edges, padded). Nothing when both sides are empty, when the
 * value leaves no room, or when the size that fits is under the floor.
 */
export function renderValueNeighbours(args: {
  neighbours: DialNeighbours;
  value: string;
  valueFontSize: number;
  centerX: number;
  baselineY: number;
  contentLeft: number;
  contentRight: number;
  cap: number;
  color: string;
}): string {
  const { neighbours, value, valueFontSize, centerX, baselineY, contentLeft, contentRight, cap, color } = args;
  const valueHalf = boldTextWidth(value, valueFontSize) / 2;
  const slots = [
    { side: "left", text: neighbours.left, from: contentLeft, to: centerX - valueHalf - VALUE_GAP },
    { side: "right", text: neighbours.right, from: centerX + valueHalf + VALUE_GAP, to: contentRight },
  ].filter((slot) => slot.text !== "");

  if (slots.length === 0) return "";

  const size = Math.min(
    cap,
    ...slots.map((slot) => Math.floor(Math.max(0, slot.to - slot.from) / boldTextWidth(slot.text, 1))),
  );

  if (size < MIN_NEIGHBOUR_FONT) return "";

  return slots
    .map(
      (slot) =>
        `<text data-neighbour="${slot.side}" x="${Math.round((slot.from + slot.to) / 2)}" y="${baselineY}" text-anchor="middle" fill="${color}" font-family="Arial, sans-serif" font-size="${size}" font-weight="bold" opacity="${NEIGHBOUR_OPACITY}">${slot.text}</text>`,
    )
    .join("");
}
