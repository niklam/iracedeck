/**
 * Where the site's "support iRaceDeck" links point — the single source of truth
 * for `SupportSection.astro`, which the homepage and the Download page both
 * render (#1299). Do not retype a Buy Me a Coffee URL anywhere else in the
 * site: `scripts/website-support-section.test.mjs` fails on one that is not
 * one of these three. The one copy it allows is the plain Markdown link on the
 * developer docs page (`src/content/docs/docs/development/index.md`), which it holds to
 * {@link SUPPORT_URL}.
 *
 * The plugin's Settings window shows the same button and links on its Support
 * iRaceDeck tab (#1303) and cannot import this module, so
 * `packages/pi-components/partials/settings-window-support.ejs` holds its own
 * copy. `scripts/support-link-parity.test.mjs` fails when the two differ: a
 * change here is a change there.
 */

/** The general page: a one-off and the membership are both one click away. */
export const SUPPORT_URL = "https://buymeacoffee.com/niklaslampen";

/** The iRaceDeck Supporter membership, which carries the Supporter role on Discord. */
export const MEMBERSHIP_URL = "https://buymeacoffee.com/niklaslampen/membership";

/**
 * Buy Me a Coffee's button as an image: a self-contained SVG (font embedded,
 * no script) with the page's number of supporters beside the text. The slug is
 * the one in {@link SUPPORT_URL}; the text, emoji, font and colours are the
 * ones the homepage's widget script used.
 *
 * The number is the one Buy Me a Coffee had when it drew the image, not a live
 * one: the response is served from a cache and may be kept for a year
 * (`Cache-Control: max-age=31536000`), so a returning visitor can see an old
 * count.
 */
export const SUPPORT_BUTTON_IMAGE_URL =
  "https://img.buymeacoffee.com/button-api/?text=Support%20iRaceDeck&emoji=%F0%9F%8F%8E%EF%B8%8F&slug=niklaslampen&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff";

/**
 * The size Buy Me a Coffee draws that image at. The width follows the `text`
 * parameter above (a longer text is a wider image), so a change to the text
 * changes this number with it; the height is always 50. The page reserves this
 * box, so it does not shift when the image loads.
 */
export const SUPPORT_BUTTON_IMAGE_WIDTH = 253;
export const SUPPORT_BUTTON_IMAGE_HEIGHT = 50;
