/// <reference lib="dom" />
/**
 * "Rescan voices" button web component for the settings window (issue #1034).
 *
 * On click it asks the plugin to re-scan the Race Engineer voice-packs
 * directory by sending `sendToPlugin` with `{ event: "voicePackRefresh" }`.
 * The plugin owns which directory that is — the page never supplies a path,
 * exactly as with `ird-open-folder`.
 *
 * This is what makes a hand-placed pack a first-class install: drop the folder
 * in, press the button, and the voice appears in the dropdown without
 * restarting the deck software.
 *
 * Built on the shared `defineSendToPluginButton` factory (also used by
 * `ird-open-settings` and `ird-open-folder`) so all three stay consistent.
 *
 * Usage:
 * ```html
 * <ird-voice-pack-refresh></ird-voice-pack-refresh>
 * <ird-voice-pack-refresh label="Look for new voices"></ird-voice-pack-refresh>
 * ```
 */
import { defineSendToPluginButton } from "./send-to-plugin-button.js";

export const VoicePackRefresh = defineSendToPluginButton({
  tag: "ird-voice-pack-refresh",
  defaultLabel: "Rescan voices",
  payload: { event: "voicePackRefresh" },
  defaultSize: "compact",
});
