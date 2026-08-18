/// <reference lib="dom" />
/**
 * "Open folder" button web component for the settings window (issue #993).
 *
 * On click it asks the plugin to reveal the settings file in Windows
 * Explorer by sending `sendToPlugin` with `{ event: "openSettingsFolder" }`.
 * The plugin resolves the path itself, from its own settings store — the
 * page never supplies one (see `openFolderInExplorer` in `@iracedeck/deck-core`).
 *
 * Built on the shared `defineSendToPluginButton` factory (also used by
 * `ird-open-settings`, #992) so the two stay trivially consistent.
 *
 * Usage:
 * ```html
 * <ird-open-folder></ird-open-folder>
 * <ird-open-folder label="Show in Explorer"></ird-open-folder>
 * ```
 */
import { defineSendToPluginButton } from "./send-to-plugin-button.js";

export const OpenFolder = defineSendToPluginButton({
  tag: "ird-open-folder",
  defaultLabel: "Open folder",
  payload: { event: "openSettingsFolder" },
});
