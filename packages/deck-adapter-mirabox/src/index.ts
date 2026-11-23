/**
 * @iracedeck/deck-adapter-mirabox
 *
 * Mirabox adapter for the deck-core platform abstraction.
 */

export { VSDPlatformAdapter } from "./adapter.js";
export {
  VSDClient,
  parseConnectionParams,
  parseHostVersion,
  type VSDConnectionParams,
  type VSDEvent,
  type VSDEventHandler,
} from "./vsd-client.js";
