/**
 * @iracedeck/deck-adapter-ulanzi
 *
 * Ulanzi Deck adapter for the deck-core platform abstraction.
 */

export { UlanziPlatformAdapter } from "./adapter.js";
export {
  decodeContext,
  encodeContext,
  normalizeFrame,
  parseConnectionParams,
  UlanziClient,
  type UlanziConnectionParams,
  type UlanziEvent,
  type UlanziEventHandler,
} from "./ulanzi-client.js";
export { toUlanziActionUuid, ULANZI_PLUGIN_UUID } from "./action-uuid.js";
