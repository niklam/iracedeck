/// <reference lib="dom" />
/**
 * "Open voice packs folder" button web component for the settings window
 * (issue #1100).
 *
 * On click it asks the plugin to reveal the Race Engineer voice-packs
 * directory in Windows Explorer by sending `sendToPlugin` with
 * `{ event: "openVoicePacksFolder" }`. The plugin resolves the path itself —
 * the page never supplies one — exactly the same shape as `ird-open-folder`
 * (issue #993), which does the same thing for the settings FILE rather than
 * the voice-packs directory. Two distinct folders, two distinct commands, one
 * shared factory.
 *
 * Built on the shared `defineSendToPluginButton` factory (also used by
 * `ird-open-settings` and `ird-open-folder`) rather than as a bespoke
 * component: unlike the catalog's Install/Update/Retry buttons and the
 * installed list's Remove button, this one has no per-instance payload at
 * all — every instance on the page opens the SAME folder — which is exactly
 * the shape the factory was built for.
 *
 * Usage:
 * ```html
 * <ird-open-voice-packs-folder></ird-open-voice-packs-folder>
 * <ird-open-voice-packs-folder label="Show in Explorer"></ird-open-voice-packs-folder>
 * ```
 */
import { defineSendToPluginButton } from "./send-to-plugin-button.js";

export const OpenVoicePacksFolder = defineSendToPluginButton({
  tag: "ird-open-voice-packs-folder",
  defaultLabel: "Open voice packs folder",
  payload: { event: "openVoicePacksFolder" },
  defaultSize: "compact",
});
