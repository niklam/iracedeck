/// <reference lib="dom" />
/**
 * "Open track data folder" button web component for the settings window's
 * Diagnostics card (issue #1112).
 *
 * On click it asks the plugin to open the folder where iRaceDeck keeps what
 * it learns per track (`%LOCALAPPDATA%\iRaceDeck\Track Data`, shared by every
 * deck host) by sending `sendToPlugin` with `{ event: "openTrackDataFolder" }`.
 * The plugin resolves the path itself — the page never supplies one — the same
 * shape as `ird-open-voice-packs-folder` (#1100) and `ird-open-profiles-folder`
 * (#1338).
 *
 * Built on the shared `defineSendToPluginButton` factory: no per-instance
 * payload, every instance opens the same folder.
 *
 * Usage:
 * ```html
 * <ird-open-track-data-folder></ird-open-track-data-folder>
 * <ird-open-track-data-folder label="Show in Explorer"></ird-open-track-data-folder>
 * ```
 */
import { defineSendToPluginButton } from "./send-to-plugin-button.js";

export const OpenTrackDataFolder = defineSendToPluginButton({
  tag: "ird-open-track-data-folder",
  defaultLabel: "Open track data folder",
  payload: { event: "openTrackDataFolder" },
  defaultSize: "compact",
});
