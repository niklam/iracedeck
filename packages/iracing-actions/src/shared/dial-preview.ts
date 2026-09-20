/**
 * The shared "pending" mark every dial's hold preview draws (issue #1120).
 *
 * While the dial button is held past the long-press threshold, a surface whose
 * long-press gesture has a KNOWABLE outcome swaps its value slot for that
 * outcome and underlines it with this bar. The driver's rule from every other
 * gadget — hold until you see the change, then release — needs the strip to
 * change mid-hold; the bar is what says the change is pending rather than done.
 *
 * Gestures whose outcome iRacing never reports back (recenter VR, open a black
 * box, the camera director's picks) show NOTHING and arm no preview: a guess
 * rendered as a promise is worse than a strip that stays still.
 *
 * The geometry lives here rather than in each strip so the mark is identical on
 * the dash-box dials (`renderDialBox`) and on the surfaces that draw their own
 * pixmap (Fuel Service), the way the double chevron is one marker across two
 * actions in `@.claude/rules/icons.md`.
 */

/**
 * Height (px, in the 200×100 strip's own units) of the pending underline.
 * Exported so a caller can keep the mark inside its own frame.
 */
export const PENDING_BAR_HEIGHT = 4;

/** Width of the underline as a fraction of the strip's width. */
const PENDING_BAR_WIDTH_RATIO = 0.22;

/**
 * Renders the pending underline centered at `centerX`, its TOP edge at `y`.
 *
 * Drawn in the same color as the preview text it underlines: the outcome's own
 * color where the surface has one (Fuel Service's green/red fill states), the
 * dash box's accent otherwise. One shape, one place, so a second surface cannot
 * drift into a slightly different mark.
 */
export function renderPendingBar(args: { centerX: number; y: number; width: number; color: string }): string {
  const { centerX, y, width, color } = args;
  const barWidth = Math.round(width * PENDING_BAR_WIDTH_RATIO);
  const x = Math.round(centerX - barWidth / 2);

  return `<rect data-pending-bar="true" x="${x}" y="${y}" width="${barWidth}" height="${PENDING_BAR_HEIGHT}" rx="${PENDING_BAR_HEIGHT / 2}" fill="${color}"/>`;
}

/**
 * A surface's pending long-press outcome: the short text its value slot shows
 * while the hold is past the threshold, and the color both it and the bar take.
 *
 * `null` — the surface's own way of saying "nothing to preview" — is what stops
 * the helper arming at all, so a state-less gesture pushes no frame and needs no
 * revert.
 */
export interface DialPendingPreview {
  /** The outcome, short enough for the big bold value slot (≈10 characters). */
  text: string;
  /** Color for the text and its underline. */
  color: string;
}
