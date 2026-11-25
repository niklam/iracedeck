/**
 * The on marker a Camera Controls dial draws on its own screen while it owns
 * the running Auto Group automation (#1656, decision 9): a small "A" badge in
 * the screen's top-right corner, in the dial's own colours. It is the keypad's
 * "A" badge for automatic modes (`icons.md`) in the strip's Camera Controls
 * style, so a dial that turns the automation on reads like the key that does.
 *
 * The badge is drawn identically on the Stream Deck+ strip (200×100) and the
 * Mirabox knob screen (176×112); only where it sits differs, because the two
 * screens lay their title out differently. A leaf: it imports nothing at
 * runtime, so the dial surface and its tests can draw it without the deck.
 */
import type { DialBoxColors } from "../../shared/dial-box.js";

/** The badge's side, in canvas pixels — the same on every canvas. */
export const AUTO_GROUP_MARKER_SIZE = 16;

/** The badge's corner radius and its letter, kept beside the size they were drawn for. */
const MARKER_RADIUS = 5;
const MARKER_FONT_SIZE = 11.5;

/**
 * Bold Arial / Arimo capitals are 0.72 em tall, so a baseline 0.36 em below a
 * line centres them on it. Computed because resvg ignores `dominant-baseline`
 * (`svg-platform-compatibility.md`).
 */
const BASELINE_OFFSET_EM = 0.36;

/**
 * A canvas at least this many times as wide as it is tall is strip-shaped (the
 * Stream Deck+ strip is 2:1); a squarer one is knob-shaped (the Mirabox knob
 * screen is about 1.57:1).
 */
const STRIP_MIN_ASPECT = 1.75;

/**
 * Where the badge's top-left corner sits on a canvas.
 *
 * - **Strip-shaped:** the top-right corner, level with the title. The strip's
 *   title is 13 px and its longest ("TRACK ORDER") ends at x ≈ 148, so the
 *   corner from x 168 is free; the right side slot starts at y ≈ 37 (a 26 px
 *   glyph centred on the middle line), below the badge's bottom at 26.
 * - **Knob-shaped:** at the right, just under the title line. The knob's title
 *   is 16 px with its baseline at 28 and runs nearly the full width (its
 *   longest ends at x ≈ 147), so the badge starts below it rather than beside
 *   it, which also keeps it out of the panel's rounder inner corner. Its
 *   bottom (44) stays above the centre value's top (≈ 46 at the 44 px cap) and
 *   it is clear of the centre glyph, which is no wider than x 68–108.
 *
 * Neither reaches the pending bar, which both screens draw under the centre.
 */
function markerOrigin(canvas: { width: number; height: number }): { x: number; y: number } {
  if (canvas.width >= canvas.height * STRIP_MIN_ASPECT) {
    return { x: canvas.width - 2 * AUTO_GROUP_MARKER_SIZE, y: 10 };
  }

  return { x: canvas.width - AUTO_GROUP_MARKER_SIZE - 10, y: 28 };
}

/**
 * The Auto Group on marker for a dial screen: an SVG fragment to append to the
 * screen's drawing while the dial is the automation's active owner, wrapped in
 * `<g data-auto-group-marker="on">`. The badge is filled with the screen's
 * value colour, its "A" cut out in the panel background, so a recoloured dial
 * recolours the badge with it.
 */
export function renderAutoGroupMarker(canvas: { width: number; height: number }, colors: DialBoxColors): string {
  const { x, y } = markerOrigin(canvas);
  const half = AUTO_GROUP_MARKER_SIZE / 2;
  const baseline = half + Math.round(MARKER_FONT_SIZE * BASELINE_OFFSET_EM * 10) / 10;
  const badge =
    `<rect x="0" y="0" width="${AUTO_GROUP_MARKER_SIZE}" height="${AUTO_GROUP_MARKER_SIZE}" rx="${MARKER_RADIUS}" fill="${colors.value}"/>` +
    `<text x="${half}" y="${baseline}" text-anchor="middle" fill="${colors.background}" font-family="Arial, sans-serif" font-size="${MARKER_FONT_SIZE}" font-weight="bold">A</text>`;

  return `<g data-auto-group-marker="on" transform="translate(${x} ${y})">${badge}</g>`;
}
