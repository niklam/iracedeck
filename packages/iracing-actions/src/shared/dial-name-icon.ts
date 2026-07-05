/**
 * Default dial image: just the action name on two lines (#775).
 *
 * A dial placement has no plugin-drawn key icon (the touch strip is the live
 * display), so the image shown for the dial in the deck application would
 * otherwise fall back to keypad iconography (a mode-specific key icon that has
 * nothing to do with the dial's configuration). Dual-surface actions push this
 * plain name icon for dial contexts on willAppear instead. The static
 * `dial.svg` copies of the same design back the Elgato manifest `Encoder.Icon`
 * default.
 */
import { escapeXml, svgToDataUri } from "@iracedeck/deck-core";

/**
 * Renders the 72×72 two-line name icon as an SVG data URI. Matches the
 * per-action `key.svg` canvas conventions (rounded rect in the action's
 * background color, bold white text, explicit baselines — the deck app's QT
 * renderer ignores `dominant-baseline`). Inputs are escaped so a future
 * caller with less controlled strings can't break the markup.
 */
export function renderDialNameIcon(args: { line1: string; line2: string; backgroundColor: string }): string {
  const line1 = escapeXml(args.line1);
  const line2 = escapeXml(args.line2);
  const backgroundColor = escapeXml(args.backgroundColor);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">` +
    `<rect x="0" y="0" width="72" height="72" rx="8" fill="${backgroundColor}"/>` +
    `<text x="36" y="32" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="13" font-weight="bold">${line1}</text>` +
    `<text x="36" y="48" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="13" font-weight="bold">${line2}</text>` +
    `</svg>`;

  return svgToDataUri(svg);
}
