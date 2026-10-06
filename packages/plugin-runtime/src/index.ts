/**
 * @iracedeck/plugin-runtime
 *
 * The composition root the three deck plugins share (#1349). A plugin's
 * `plugin.ts` builds its adapter (and, on Stream Deck, its extension) and
 * calls `startPlugin`; everything else happens here, in phases whose order
 * `start-plugin.test.ts` pins.
 */
export type { ActionRegistration, PluginExtension, PluginHost } from "./types.js";
export { SHARED_ACTIONS, STREAM_DECK_ACTIONS } from "./actions.js";
export { startPlugin } from "./start-plugin.js";
