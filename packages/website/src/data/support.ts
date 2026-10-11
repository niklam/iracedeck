/**
 * Where the site's "support iRaceDeck" links point — the single source of truth
 * for `SupportSection.astro`, which the homepage and the Download page both
 * render (#1299). Do not retype a Buy Me a Coffee URL anywhere else in the
 * site: `scripts/website-support-section.test.mjs` fails on one that is not
 * one of these three.
 */

/** The general page: a one-off and the membership are both one click away. */
export const SUPPORT_URL = "https://buymeacoffee.com/niklaslampen";

/** The iRaceDeck Supporter membership, which carries the Supporter role on Discord. */
export const MEMBERSHIP_URL = "https://buymeacoffee.com/niklaslampen/membership";

/**
 * Buy Me a Coffee's button as an image: a self-contained SVG (253 × 50, font
 * embedded, no script), drawn on each request with the current number of
 * supporters beside the text. The slug is the one in {@link SUPPORT_URL}; the
 * text, emoji, font and colours are the ones the homepage's widget script used.
 */
export const SUPPORT_BUTTON_IMAGE_URL =
  "https://img.buymeacoffee.com/button-api/?text=Support%20iRaceDeck&emoji=%F0%9F%8F%8E%EF%B8%8F&slug=niklaslampen&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff";
