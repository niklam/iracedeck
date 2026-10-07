/**
 * Settings-window names the plugin, the build and the Property Inspector share
 * (issues #992, #1005): the compiled page's file name and the ids of the two
 * warning records a failed settings window raises. In the `app-constants` leaf
 * so browser code can name them without the deck-core barrel (spec #1351).
 */

/**
 * File name of the compiled settings-window page inside each plugin's `ui/`
 * folder (built from `settings-window.ejs` by the shared PI template plugin,
 * with `settings-window-bridge.js` injected before `sdpi-components.js`).
 * The build side declares the same string in `@iracedeck/pi-components/build`;
 * a shared test guards that they never drift.
 */
export const SETTINGS_WINDOW_HTML = "settings-window.html";

/**
 * Page-wide: the settings service never bound. Rendered in the PI's top strip.
 * Raised by deck-core's `evaluateSettingsWindowWarnings`.
 */
export const SETTINGS_WINDOW_SERVER_WARNING_ID = "settings-window-server";

/**
 * Button-scoped: the service is fine, nothing would open the page. Rendered
 * above the settings button. Raised by deck-core's `evaluateSettingsWindowWarnings`.
 */
export const SETTINGS_WINDOW_OPEN_WARNING_ID = "settings-window-open";
