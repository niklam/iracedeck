/// <reference lib="dom" />
/**
 * "iRaceDeck Settings" button web component for the Property Inspector
 * (issue #992).
 *
 * On click it asks the plugin to open the dedicated settings window by sending
 * `sendToPlugin` with `{ event: "openSettings" }`. Each adapter routes that to
 * the plugin's settings-window controller, which starts the loopback server
 * at plugin startup and opens the page as a chromeless app window.
 *
 * Built on the shared `defineSendToPluginButton` factory (also used by
 * `ird-open-folder`, #993) so the two stay trivially consistent.
 *
 * #1024 moved it out of the Property Inspector's bottom section up under each
 * action's own settings, and dressed it for that spot: a cog, the shorter
 * label, and the factory's `compact` size. Directly under the settings a user
 * came to change, the full-width pill read as the panel's main action — which
 * it is not. The cog carries the recognition the shorter label gives up.
 *
 * Usage:
 * ```html
 * <ird-open-settings></ird-open-settings>
 * <ird-open-settings label="Settings…"></ird-open-settings>
 * ```
 */
import { defineSendToPluginButton } from "./send-to-plugin-button.js";

/**
 * Cog, 12x12, drawn in `currentColor` so it always matches the label beside it.
 * A ring with a hub and eight teeth — plain strokes only, the same hand-authored
 * style as the `ird-key-binding` mode icons.
 */
const COG_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor">
  <circle cx="8" cy="8" r="4" stroke-width="1.7"/>
  <circle cx="8" cy="8" r="1.3" stroke-width="1.3"/>
  <path d="M12.6 8h1.6M3.4 8H1.8M8 3.4V1.8M8 12.6v1.6M11.25 4.75l1.13-1.13M4.75 11.25l-1.13 1.13M11.25 11.25l1.13 1.13M4.75 4.75L3.62 3.62" stroke-width="1.9" stroke-linecap="round"/>
</svg>`;

export const OpenSettings = defineSendToPluginButton({
  tag: "ird-open-settings",
  defaultLabel: "iRaceDeck Settings",
  payload: { event: "openSettings" },
  icon: COG_ICON_SVG,
  // Quiet by default, because its usual home is among an action's own settings.
  // `settings.ejs` — the page that is nothing but this button — asks for
  // `size="standard"` instead.
  defaultSize: "compact",
});
