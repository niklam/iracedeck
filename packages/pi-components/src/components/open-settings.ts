/// <reference lib="dom" />
/**
 * "Open iRaceDeck Settings" button web component for the Property Inspector
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
 * Usage:
 * ```html
 * <ird-open-settings></ird-open-settings>
 * <ird-open-settings label="Settings…"></ird-open-settings>
 * ```
 */
import { defineSendToPluginButton } from "./send-to-plugin-button.js";

export const OpenSettings = defineSendToPluginButton({
  tag: "ird-open-settings",
  defaultLabel: "Open iRaceDeck Settings",
  payload: { event: "openSettings" },
});
